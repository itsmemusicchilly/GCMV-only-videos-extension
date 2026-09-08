/**
 * Gacha MV Player - Lightweight NAS Database Server
 * Zero dependencies! Runs on Node.js 14+ on Synology, TrueNAS, unRAID, QNAP, or Docker.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";
const AUTH_TOKEN = (process.env.NAS_AUTH_TOKEN || "").trim();
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean)
);
const MAX_BODY_BYTES = 1024 * 1024;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "database.json");

if (!AUTH_TOKEN) {
  console.error("[NAS Server] NAS_AUTH_TOKEN is required. Refusing to start without authentication.");
  process.exit(1);
}

// Ensure data directory and database file exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({}, null, 2), "utf8");
}

function readDb() {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!isValidDatabase(parsed)) throw new Error("database.json has an invalid structure");
    return parsed;
  } catch (err) {
    console.error("[NAS Server] Error reading database.json, resetting to {}", err);
    return {};
  }
}

function writeDb(data) {
  try {
    const tempFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempFile, DB_FILE);
    return true;
  } catch (err) {
    console.error("[NAS Server] Error writing database.json", err);
    return false;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidVideoId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isValidSegment(segment) {
  if (!isPlainObject(segment)) return false;
  const start = Number(segment.start);
  const end = Number(segment.end);
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
}

function isValidDatabase(data) {
  if (!isPlainObject(data)) return false;
  return Object.entries(data).every(
    ([videoId, segments]) => isValidVideoId(videoId) && Array.isArray(segments) && segments.every(isValidSegment)
  );
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return /^(chrome|moz)-extension:\/\/[A-Za-z0-9_-]+$/.test(origin) || ALLOWED_ORIGINS.has(origin);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  return true;
}

function isAuthorized(req) {
  const header = req.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expectedBuffer = Buffer.from(AUTH_TOKEN);
  const suppliedBuffer = Buffer.from(supplied);
  return suppliedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function readBody(req, res, callback) {
  let body = "";
  let size = 0;
  let rejected = false;
  req.on("data", (chunk) => {
    if (rejected) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      rejected = true;
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request body exceeds 1 MiB limit" }));
      return;
    }
    body += chunk;
  });
  req.on("end", () => {
    if (!rejected) callback(body);
  });
}

const server = http.createServer((req, res) => {
  setCorsHeaders(req, res);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (req.method === "OPTIONS") {
    res.writeHead(isAllowedOrigin(req.headers.origin) ? 204 : 403);
    res.end();
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  // 1. Health & Status Check
  if (pathname === "/" || pathname === "/health" || pathname === "/api/status") {
    const db = readDb();
    const videoCount = Object.keys(db).length;
    let totalSegments = 0;
    Object.values(db).forEach((arr) => {
      if (Array.isArray(arr)) totalSegments += arr.length;
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "online",
        service: "Gacha MV Player NAS Database Server",
        version: "1.0.1",
        videoCount: videoCount,
        totalSegments: totalSegments,
        timestamp: new Date().toISOString()
      })
    );
    return;
  }

  // 2. Fetch Segments for a specific Video (SponsorBlock-compatible endpoint)
  // GET /api/skipSegments?videoID=...
  if (req.method === "GET" && (pathname === "/api/skipSegments" || pathname === "/skipSegments")) {
    const videoId = query.videoID || query.videoId || query.v;
    if (!isValidVideoId(videoId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing videoID query parameter" }));
      return;
    }

    const db = readDb();
    const videoSegments = db[videoId] || [];

    // Map to SponsorBlock-compatible format
    const sbFormatted = videoSegments.map((s, idx) => ({
      UUID: s.id || `nas_${videoId}_${idx}`,
      segment: [s.start, s.end],
      category: s.category || "custom",
      label: s.label || s.category || "Custom Skip",
      actionType: "skip",
      source: "nas"
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(sbFormatted));
    return;
  }

  // 3. Add or Update a Segment
  // POST /api/skipSegments
  if (req.method === "POST" && (pathname === "/api/skipSegments" || pathname === "/api/add")) {
    readBody(req, res, (body) => {
      try {
        const data = JSON.parse(body);
        const videoId = data.videoId || data.videoID;
        const start = parseFloat(data.start);
        const end = parseFloat(data.end);
        const category = String(data.category || "custom").slice(0, 64);
        const label = String(data.label || "").slice(0, 256);

        if (!isValidVideoId(videoId) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid videoId, start, or end timestamp" }));
          return;
        }

        const db = readDb();
        if (!db[videoId]) db[videoId] = [];

        const id = String(data.id || `nas_${Date.now()}_${Math.floor(Math.random() * 1000)}`).slice(0, 200);

        const segment = {
          id: id,
          start: parseFloat(start.toFixed(1)),
          end: parseFloat(end.toFixed(1)),
          category: category,
          label: label
        };

        const existingIndex = db[videoId].findIndex((s) => (s.id || s.UUID) === id);
        if (existingIndex >= 0) {
          db[videoId][existingIndex] = segment;
        } else {
          db[videoId].push(segment);
        }

        if (!writeDb(db)) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Could not save database" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          id: id,
          segment: segment,
          message: existingIndex >= 0 ? "Segment updated on NAS server" : "Segment saved on NAS server"
        }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
      }
    });
    return;
  }

  // 4. Delete a Segment
  // DELETE /api/skipSegments?videoID=...&id=...
  if (req.method === "DELETE" && pathname === "/api/skipSegments") {
    const videoId = query.videoID || query.videoId;
    const segmentId = query.id || query.UUID;

    if (!isValidVideoId(videoId) || typeof segmentId !== "string" || segmentId.length > 200) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing videoId or segment id" }));
      return;
    }

    const db = readDb();
    if (db[videoId]) {
      db[videoId] = db[videoId].filter((s) => s.id !== segmentId && s.UUID !== segmentId);
      if (db[videoId].length === 0) delete db[videoId];
      if (!writeDb(db)) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Could not save database" }));
        return;
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: "Segment deleted from NAS" }));
    return;
  }

  // 5. Entire Database Import & Export
  // GET /api/database
  if (req.method === "GET" && pathname === "/api/database") {
    const db = readDb();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(db, null, 2));
    return;
  }

  // POST /api/database (Full Import / Overwrite / Merge)
  if (req.method === "POST" && pathname === "/api/database") {
    readBody(req, res, (body) => {
      try {
        const importedData = JSON.parse(body);
        if (!isValidDatabase(importedData)) {
          throw new Error("Payload must be a valid database object");
        }

        const isMerge = query.merge === "true";
        let finalDb = importedData;

        if (isMerge) {
          const current = readDb();
          finalDb = { ...current };
          for (const [vId, segs] of Object.entries(importedData)) {
            if (!finalDb[vId]) finalDb[vId] = [];
            if (Array.isArray(segs)) {
              finalDb[vId].push(...segs);
            }
          }
        }

        if (!isValidDatabase(finalDb) || !writeDb(finalDb)) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Could not save database" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, message: "Database updated on NAS", videoCount: Object.keys(finalDb).length }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON database payload" }));
      }
    });
    return;
  }

  // 404 Handler
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Endpoint not found" }));
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`🌸 Gacha MV NAS Database Server running on http://${BIND_HOST}:${PORT}`);
  console.log(`📁 Storing database at: ${DB_FILE}`);
});
