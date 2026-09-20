/**
 * Gacha MV Player - Lightweight NAS Database & Local Wi-Fi Remote Server
 * Zero dependencies! Runs on Node.js 14+ on Synology, TrueNAS, unRAID, QNAP, Windows, Mac, Linux, or Docker.
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");
const os = require("os");

const PORT = parseInt(process.env.PORT || "3000", 10);
const BIND_HOST = process.env.BIND_HOST || "0.0.0.0";
const AUTH_TOKEN = (process.env.NAS_AUTH_TOKEN || "").trim();
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean)
);
const MAX_BODY_BYTES = 1024 * 1024;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "database.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({}, null, 2), "utf8");
}

// Remote Server Config & State
let serverConfig = {
  pinRequired: Boolean(process.env.REMOTE_PIN),
  remotePin: process.env.REMOTE_PIN || ""
};

if (fs.existsSync(CONFIG_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    if (loaded && typeof loaded === "object") {
      serverConfig = { ...serverConfig, ...loaded };
    }
  } catch (e) {}
}

function saveConfig(cfg) {
  try {
    serverConfig = { ...serverConfig, ...cfg };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(serverConfig, null, 2), "utf8");
  } catch (e) {
    console.error("[Server] Error saving config:", e);
  }
}

// In-Memory Queue & Playback State
let queue = [];
let pendingControls = [];
let currentPlayback = {
  videoId: "",
  title: "No video playing",
  isPlaying: false,
  volume: 100
};

let qrcodeLib = null;
try {
  qrcodeLib = require("./qrcode.min.js");
} catch (e) {
  try {
    qrcodeLib = require("../lib/qrcode.min.js");
  } catch (e2) {}
}

function getLocalIp() {
  try {
    const interfaces = os.networkInterfaces();
    const isVirtual = (name) => {
      const lower = name.toLowerCase();
      return (
        lower.includes("docker") ||
        lower.includes("vbox") ||
        lower.includes("vmnet") ||
        lower.includes("virbr") ||
        lower.includes("veth") ||
        lower.includes("tailscale") ||
        lower.includes("tun") ||
        lower.includes("tap") ||
        lower.includes("dummy")
      );
    };

    // Pass 1: Physical Wi-Fi or Ethernet adapters (wlan, eth, en, wi-fi)
    for (const name of Object.keys(interfaces)) {
      if (isVirtual(name)) continue;
      const lower = name.toLowerCase();
      if (lower.startsWith("wlan") || lower.startsWith("eth") || lower.startsWith("en") || lower.includes("wi-fi")) {
        for (const net of interfaces[name]) {
          const isV4 = net.family === "IPv4" || net.family === 4;
          if (isV4 && !net.internal && net.address !== "127.0.0.1") {
            return net.address;
          }
        }
      }
    }

    // Pass 2: Any non-virtual adapter with site-local address (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
    for (const name of Object.keys(interfaces)) {
      if (isVirtual(name)) continue;
      for (const net of interfaces[name]) {
        const isV4 = net.family === "IPv4" || net.family === 4;
        if (isV4 && !net.internal && net.address !== "127.0.0.1") {
          return net.address;
        }
      }
    }

    // Pass 3: Any non-internal IPv4
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name]) {
        const isV4 = net.family === "IPv4" || net.family === 4;
        if (isV4 && !net.internal && net.address !== "127.0.0.1") {
          return net.address;
        }
      }
    }
  } catch (e) {}
  return "127.0.0.1";
}

function getAvailableIps() {
  const list = [];
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      const lower = name.toLowerCase();
      for (const net of interfaces[name]) {
        const isV4 = net.family === "IPv4" || net.family === 4;
        if (isV4 && !net.internal && net.address !== "127.0.0.1") {
          let type = "other";
          let label = name;
          if (lower.includes("tailscale") || lower.startsWith("ts") || net.address.startsWith("100.")) {
            type = "tailscale";
            label = "Tailscale";
          } else if (lower.startsWith("wlan") || lower.startsWith("wl") || lower.includes("wi-fi") || lower.includes("wifi")) {
            type = "wifi";
            label = "Wi-Fi";
          } else if (lower.startsWith("eth") || lower.startsWith("en")) {
            type = "ethernet";
            label = "Ethernet";
          } else if (lower.startsWith("ap") || lower.includes("hotspot")) {
            type = "hotspot";
            label = "Hotspot";
          }
          list.push({ name: label, ip: net.address, type: type });
        }
      }
    }
  } catch (e) {}
  return list;
}

function searchYouTube(query, callback) {
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const options = {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"
    }
  };
  https.get(searchUrl, options, (resp) => {
    let html = "";
    resp.on("data", (chunk) => { html += chunk; });
    resp.on("end", () => {
      try {
        const results = parseYouTubeSearchResults(html);
        callback(null, results);
      } catch (e) {
        callback(e, []);
      }
    });
  }).on("error", (e) => {
    callback(e, []);
  });
}

function parseYouTubeSearchResults(html) {
  const marker = "var ytInitialData = ";
  let idx = html.indexOf(marker);
  if (idx === -1) {
    const marker2 = "window[\"ytInitialData\"] = ";
    idx = html.indexOf(marker2);
    if (idx === -1) return [];
    idx += marker2.length;
  } else {
    idx += marker.length;
  }

  let endIdx = html.indexOf(";</script>", idx);
  if (endIdx === -1) endIdx = html.indexOf(";\n", idx);
  if (endIdx === -1) return [];

  const jsonStr = html.substring(idx, endIdx).trim();
  const root = JSON.parse(jsonStr);
  const results = [];

  const contents =
    root.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
  if (!Array.isArray(contents)) return results;

  for (const section of contents) {
    const items = section.itemSectionRenderer?.contents;
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      const vr = item.videoRenderer;
      if (!vr || !vr.videoId) continue;

      const videoId = vr.videoId;
      let title = "";
      if (vr.title?.runs && vr.title.runs.length > 0) {
        title = vr.title.runs.map(r => r.text).join("");
      } else if (vr.title?.simpleText) {
        title = vr.title.simpleText;
      }

      let channel = "";
      if (vr.ownerText?.runs && vr.ownerText.runs.length > 0) {
        channel = vr.ownerText.runs.map(r => r.text).join("");
      }

      let thumbnail = "";
      if (vr.thumbnail?.thumbnails && vr.thumbnail.thumbnails.length > 0) {
        const thumbs = vr.thumbnail.thumbnails;
        thumbnail = thumbs[thumbs.length - 1].url;
      } else {
        thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      }

      results.push({
        id: videoId,
        title: title || `YouTube Video (${videoId})`,
        channel: channel,
        thumbnail: thumbnail
      });

      if (results.length >= 20) break;
    }
    if (results.length >= 20) break;
  }
  return results;
}

function extractYouTubeVideoId(input) {
  if (!input || typeof input !== "string") return null;
  const str = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) return str;
  const match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([a-zA-Z0-9_-]{11})/);
  if (match && match[1]) return match[1];
  return null;
}

function fetchVideoTitleAsync(item) {
  const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${item.videoId}&format=json`;
  https.get(oembedUrl, (res) => {
    if (res.statusCode !== 200) return;
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => {
      try {
        const json = JSON.parse(data);
        if (json.title) item.title = json.title;
      } catch (e) {}
    });
  }).on("error", () => {});
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
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-GCMV-PIN");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function isNasAuthorized(req) {
  if (!AUTH_TOKEN) return false;
  const header = req.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expectedBuffer = Buffer.from(AUTH_TOKEN);
  const suppliedBuffer = Buffer.from(supplied);
  return suppliedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function isRemoteAuthorized(req, bodyJson) {
  if (!serverConfig.pinRequired || !serverConfig.remotePin) return true;
  const headerPin = req.headers["x-gcmv-pin"];
  if (headerPin && headerPin.trim() === serverConfig.remotePin.trim()) return true;
  if (bodyJson && bodyJson.pin && String(bodyJson.pin).trim() === serverConfig.remotePin.trim()) return true;
  return false;
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

function getWebRemoteHtml(pinRequired) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>🌸 Gacha MV Remote</title>
  <style>
    :root {
      --bg: #0d0a1a;
      --card-bg: #16122a;
      --card-border: rgba(255, 46, 147, 0.25);
      --pink: #ff2e93;
      --cyan: #00e5ff;
      --green: #00ffaa;
      --text: #ffffff;
      --subtext: #a09bb8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 14px; min-height: 100vh; }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid var(--card-border); }
    h1 { font-size: 19px; color: var(--text); font-weight: 800; display: flex; align-items: center; gap: 6px; }
    .badge { font-size: 11px; background: rgba(0,255,170,0.15); color: var(--green); border: 1px solid var(--green); border-radius: 12px; padding: 3px 8px; font-weight: 700; }
    .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; padding: 16px; margin-bottom: 14px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
    .card-title { font-size: 13px; font-weight: 700; color: var(--cyan); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }
    .now-playing-title { font-size: 15px; font-weight: 700; color: var(--text); line-height: 1.3; margin-bottom: 12px; word-break: break-word; }
    .ctrl-row { display: flex; gap: 10px; margin-top: 10px; }
    .btn-ctrl { flex: 1; height: 46px; border: none; border-radius: 12px; background: rgba(255,255,255,0.08); color: #fff; font-size: 16px; font-weight: 700; cursor: pointer; transition: all 0.15s; display: flex; align-items: center; justify-content: center; gap: 6px; }
    .btn-ctrl:active { transform: scale(0.96); background: rgba(255,255,255,0.18); }
    .btn-primary { background: linear-gradient(135deg, var(--pink), #8f00ff); color: #fff; }
    .btn-accent { background: rgba(0, 229, 255, 0.2); border: 1px solid var(--cyan); color: var(--cyan); }
    .input-box { width: 100%; height: 46px; background: #211a3e; border: 1px solid rgba(255,255,255,0.15); border-radius: 12px; padding: 0 14px; color: #fff; font-size: 14px; margin-bottom: 10px; outline: none; }
    .input-box:focus { border-color: var(--pink); box-shadow: 0 0 10px rgba(255,46,147,0.3); }
    .btn-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
    .btn-act { height: 42px; border: none; border-radius: 10px; font-size: 12px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px; transition: all 0.15s; }
    .btn-act:active { transform: scale(0.96);    .btn-now { background: var(--pink); color: #fff; }
    .btn-next { background: #6b21a8; color: #fff; border: 1px solid #a855f7; }
    .btn-queue { background: rgba(0,229,255,0.15); color: var(--cyan); border: 1px solid var(--cyan); }
    .search-item { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 10px; display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
    .search-thumb-row { display: flex; gap: 10px; align-items: center; }
    .search-thumb { width: 96px; height: 54px; object-fit: cover; border-radius: 6px; flex-shrink: 0; background: #222; }
    .search-meta { flex: 1; min-width: 0; }
    .search-title { font-size: 13px; font-weight: 700; color: #fff; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .search-channel { font-size: 11px; color: var(--subtext); margin-top: 3px; }
    .queue-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
    .queue-num { font-size: 12px; font-weight: 800; color: var(--cyan); margin-right: 10px; min-width: 18px; }
    .queue-title { font-size: 13px; font-weight: 600; color: #eee; flex: 1; word-break: break-word; }
    .queue-del { background: none; border: none; color: #ff4444; font-size: 16px; padding: 6px; cursor: pointer; }
    .queue-empty { color: var(--subtext); font-size: 13px; font-style: italic; text-align: center; padding: 18px 0; }
    .vol-wrap { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
    .vol-slider { flex: 1; accent-color: var(--pink); }
    .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #2e1b4e; border: 1px solid var(--pink); color: #fff; padding: 10px 18px; border-radius: 20px; font-size: 13px; font-weight: 700; box-shadow: 0 4px 15px rgba(0,0,0,0.5); opacity: 0; pointer-events: none; transition: opacity 0.25s ease; z-index: 100; }
    .toast.show { opacity: 1; }
    /* PIN Modal */
    .pin-overlay { position: fixed; inset: 0; background: rgba(13,10,26,0.95); display: flex; align-items: center; justify-content: center; z-index: 200; padding: 20px; }
    .pin-card { background: var(--card-bg); border: 1px solid var(--pink); border-radius: 20px; padding: 24px; width: 100%; max-width: 320px; text-align: center; }
    .pin-input { width: 100%; height: 50px; font-size: 24px; text-align: center; letter-spacing: 8px; background: #211a3e; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; color: #fff; margin: 16px 0; outline: none; }
    .pin-btn { width: 100%; height: 46px; background: var(--pink); color: #fff; border: none; border-radius: 12px; font-size: 15px; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <header>
    <h1>🌸 Gacha MV Remote</h1>
    <span class="badge" id="connBadge">● CONNECTED</span>
  </header>

  <!-- Now Playing -->
  <div class="card">
    <div class="card-title">🎵 Now Playing on Player</div>
    <div class="now-playing-title" id="nowPlayingTitle">Loading...</div>
    <div class="ctrl-row">
      <button class="btn-ctrl btn-primary" id="btnPlayPause">⏸️ Pause</button>
      <button class="btn-ctrl btn-accent" id="btnSkipNext">⏭️ Skip</button>
    </div>
    <div class="vol-wrap">
      <span style="font-size:13px; font-weight:700;">🔊 Volume:</span>
      <input type="range" id="sliderVol" class="vol-slider" min="0" max="200" value="100">
      <span id="volVal" style="font-size:12px; color:var(--cyan); min-width:40px;">100%</span>
    </div>
  </div>

  <!-- Search YouTube -->
  <div class="card">
    <div class="card-title">🔍 Search YouTube / GCMV</div>
    <div style="display:flex; gap:8px; margin-bottom:10px;">
      <input type="text" id="inputSearch" class="input-box" style="margin-bottom:0;" placeholder="Search songs, GCMV, GLMV...">
      <button class="btn-ctrl btn-primary" id="btnSearch" style="width:76px; height:46px; flex:none; font-size:14px;">Search</button>
    </div>
    <div id="searchResults" style="display:flex; flex-direction:column; max-height:360px; overflow-y:auto;"></div>
  </div>

  <!-- Add Video to Queue -->
  <div class="card">
    <div class="card-title">➕ Add Video from Link / ID</div>
    <input type="text" id="inputUrl" class="input-box" placeholder="Paste YouTube link or Video ID...">
    <div class="btn-grid">
      <button class="btn-act btn-now" id="btnPlayNow">▶️ Play Now</button>
      <button class="btn-act btn-next" id="btnPlayNext">⏭️ Play Next</button>
      <button class="btn-act btn-queue" id="btnAddQueue">➕ Add Queue</button>
    </div>
  </div>

  <!-- Active Queue -->
  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
      <div class="card-title" style="margin-bottom:0;">📋 Active Queue (<span id="queueCount">0</span>)</div>
      <button id="btnClearQueue" style="background:none; border:none; color:var(--pink); font-size:12px; font-weight:700; cursor:pointer;">Clear All</button>
    </div>
    <div id="queueList"></div>
  </div>

  <div id="toast" class="toast"></div>

  ${pinRequired ? `
  <div id="pinOverlay" class="pin-overlay">
    <div class="pin-card">
      <h2 style="font-size:18px; margin-bottom:6px;">🔒 Remote PIN Required</h2>
      <p style="font-size:12px; color:var(--subtext);">Enter the 4-digit PIN configured in Player Settings</p>
      <input type="password" id="pinInput" class="pin-input" maxlength="8" placeholder="••••" autofocus>
      <button id="btnSubmitPin" class="pin-btn">Unlock Remote</button>
    </div>
  </div>` : ""}

  <script>
    let currentPin = localStorage.getItem('gcmv_remote_pin') || '';
    let isPlaying = false;

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2600);
    }

    async function api(path, opts = {}) {
      opts.headers = opts.headers || {};
      if (currentPin) opts.headers['X-GCMV-PIN'] = currentPin;
      try {
        const r = await fetch(path, opts);
        if (r.status === 401) {
          const po = document.getElementById('pinOverlay');
          if (po) po.style.display = 'flex';
        }
        return await r.json();
      } catch (e) { return null; }
    }

    async function refreshStatus() {
      const data = await api('/api/status');
      if (!data) return;
      if (data.currentVideo) {
        document.getElementById('nowPlayingTitle').textContent = data.currentVideo.title || 'Playing video';
        isPlaying = data.currentVideo.isPlaying;
        document.getElementById('btnPlayPause').textContent = isPlaying ? '⏸️ Pause' : '▶️ Play';
      }
      const queue = data.queue || [];
      document.getElementById('queueCount').textContent = queue.length;
      const qList = document.getElementById('queueList');
      if (queue.length === 0) {
        qList.innerHTML = '<div class="queue-empty">Queue is empty. Add a video above!</div>';
      } else {
        qList.innerHTML = queue.map((item, idx) => \`
          <div class="queue-item">
            <span class="queue-num">\${idx + 1}</span>
            <span class="queue-title">\${item.title || item.videoId}</span>
            <button class="queue-del" onclick="deleteQueueItem('\${item.id}')">🗑️</button>
          </div>
        \`).join('');
      }
    }

    async function doSearch() {
      const q = document.getElementById('inputSearch').value.trim();
      if (!q) return showToast('⚠️ Enter a search query');
      const sResults = document.getElementById('searchResults');
      sResults.innerHTML = '<div style="color:var(--subtext); text-align:center; padding:15px;">🔍 Searching...</div>';
      const res = await api('/api/search?q=' + encodeURIComponent(q));
      if (!res || !res.results || res.results.length === 0) {
        sResults.innerHTML = '<div style="color:var(--subtext); text-align:center; padding:15px;">No results found</div>';
        return;
      }
      window._lastSearchResults = res.results;
      sResults.innerHTML = res.results.map((item, idx) => \`
        <div class="search-item">
          <div class="search-thumb-row">
            <img class="search-thumb" src="\${item.thumbnail || ''}" alt="" onerror="this.style.display='none'">
            <div class="search-meta">
              <div class="search-title">\${item.title || 'Video'}</div>
              <div class="search-channel">\${item.channel || ''}</div>
            </div>
          </div>
          <div class="btn-grid">
            <button class="btn-act btn-now" onclick="actionSearchResult('\${item.id}', \${idx}, 'play_now')">▶️ Play Now</button>
            <button class="btn-act btn-next" onclick="actionSearchResult('\${item.id}', \${idx}, 'play_next')">⏭️ Play Next</button>
            <button class="btn-act btn-queue" onclick="actionSearchResult('\${item.id}', \${idx}, 'add_queue')">➕ Add Queue</button>
          </div>
        </div>
      \`).join('');
    }

    window.actionSearchResult = async function(id, idx, action) {
      const item = (window._lastSearchResults && window._lastSearchResults[idx]) || { id: id };
      const res = await api('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.id || id, title: item.title, action: action, pin: currentPin })
      });
      if (res && res.success) {
        const actLabel = action === 'play_now' ? '▶️ Playing now!' : action === 'play_next' ? '⏭️ Queued next!' : '➕ Added to queue!';
        showToast(actLabel);
        refreshStatus();
      } else {
        showToast('❌ ' + (res?.error || 'Action failed'));
      }
    };

    document.getElementById('btnSearch').addEventListener('click', doSearch);
    document.getElementById('inputSearch').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch();
    });

    async function addVideo(action) {
      const input = document.getElementById('inputUrl');
      const val = input.value.trim();
      if (!val) return showToast('⚠️ Enter a YouTube URL or Video ID');
      const res = await api('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: val, action: action, pin: currentPin })
      });
      if (res && res.success) {
        input.value = '';
        const actLabel = action === 'play_now' ? '▶️ Playing now!' : action === 'play_next' ? '⏭️ Queued to play next!' : '➕ Added to queue!';
        showToast(actLabel);
        refreshStatus();
      } else {
        showToast('❌ ' + (res?.error || 'Failed to add video'));
      }
    }

    window.deleteQueueItem = async function(id) {
      await api('/api/queue?id=' + encodeURIComponent(id), { method: 'DELETE' });
      refreshStatus();
    };

    document.getElementById('btnPlayNow').addEventListener('click', () => addVideo('play_now'));
    document.getElementById('btnPlayNext').addEventListener('click', () => addVideo('play_next'));
    document.getElementById('btnAddQueue').addEventListener('click', () => addVideo('add_queue'));

    document.getElementById('btnPlayPause').addEventListener('click', async () => {
      await api('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: isPlaying ? 'pause' : 'play' })
      });
      isPlaying = !isPlaying;
      document.getElementById('btnPlayPause').textContent = isPlaying ? '⏸️ Pause' : '▶️ Play';
    });

    document.getElementById('btnSkipNext').addEventListener('click', async () => {
      await api('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'next' })
      });
      showToast('⏭️ Skipped!');
      setTimeout(refreshStatus, 600);
    });

    document.getElementById('btnClearQueue').addEventListener('click', async () => {
      if (!confirm('Clear all queued songs?')) return;
      await api('/api/queue', { method: 'DELETE' });
      refreshStatus();
    });

    const slider = document.getElementById('sliderVol');
    slider.addEventListener('input', (e) => {
      document.getElementById('volVal').textContent = e.target.value + '%';
    });
    slider.addEventListener('change', async (e) => {
      await api('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'volume', value: parseInt(e.target.value, 10) })
      });
    });

    const btnPin = document.getElementById('btnSubmitPin');
    if (btnPin) {
      btnPin.addEventListener('click', async () => {
        const pinVal = document.getElementById('pinInput').value.trim();
        const res = await api('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: pinVal })
        });
        if (res && res.success) {
          currentPin = pinVal;
          localStorage.setItem('gcmv_remote_pin', pinVal);
          document.getElementById('pinOverlay').style.display = 'none';
          refreshStatus();
        } else {
          alert('❌ Incorrect PIN');
        }
      });
    }

    refreshStatus();
    setInterval(refreshStatus, 2500);
  </script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  setCorsHeaders(req, res);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  // 1. Web Remote HTML UI
  if (req.method === "GET" && (pathname === "/" || pathname === "/remote")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=UTF-8" });
    res.end(getWebRemoteHtml(serverConfig.pinRequired && Boolean(serverConfig.remotePin)));
    return;
  }

  // 2. Status check (Remote + NAS)
  if (req.method === "GET" && (pathname === "/api/status" || pathname === "/health")) {
    const isNas = Boolean(req.headers.authorization);
    let videoCount = 0;
    let totalSegments = 0;
    if (isNas) {
      const db = readDb();
      videoCount = Object.keys(db).length;
      Object.values(db).forEach((arr) => {
        if (Array.isArray(arr)) totalSegments += arr.length;
      });
    }

    const localIp = getLocalIp();
    const addresses = getAvailableIps();
    const serverUrl = `http://${localIp}:${boundPort}/remote`;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "online",
        service: "Gacha MV Player Remote & NAS Server",
        version: "1.0.3.3",
        serverUrl: serverUrl,
        ip: localIp,
        addresses: addresses,
        port: boundPort,
        pinRequired: serverConfig.pinRequired && Boolean(serverConfig.remotePin),
        currentVideo: currentPlayback,
        queue: queue,
        videoCount: videoCount,
        totalSegments: totalSegments,
        timestamp: new Date().toISOString()
      })
    );
    return;
  }

  // 2b. QR Code generation (SVG)
  if (req.method === "GET" && (pathname === "/api/qr" || pathname === "/qr.svg")) {
    const localIp = getLocalIp();
    const targetUrl = (query && query.url) ? String(query.url).trim() : `http://${localIp}:${boundPort}/remote`;
    if (qrcodeLib) {
      try {
        const qr = qrcodeLib(0, "M");
        qr.addData(targetUrl);
        qr.make();
        const svg = qr.createSvgTag({ scalable: true });
        res.writeHead(200, {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        });
        res.end(svg);
        return;
      } catch (e) {}
    }
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("QR Generator unavailable");
    return;
  }

  // 2c. YouTube Search API (Zero external API keys)
  if (req.method === "GET" && pathname === "/api/search") {
    const q = (query && query.q ? String(query.q).trim() : "");
    if (!q) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'q' query parameter" }));
      return;
    }
    searchYouTube(q, (err, results) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Search failed", results: [] }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ query: q, results: results }));
      }
    });
    return;
  }

  // 3. Auth check for Remote PIN
  if (req.method === "POST" && pathname === "/api/auth") {
    readBody(req, res, (body) => {
      try {
        const data = JSON.parse(body || "{}");
        const pin = String(data.pin || "").trim();
        if (!serverConfig.pinRequired || pin === serverConfig.remotePin) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Invalid PIN" }));
        }
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
      }
    });
    return;
  }

  // 4. Remote Queue API (GET, POST, DELETE)
  if (pathname === "/api/queue") {
    // GET /api/queue (or ?pop=true)
    if (req.method === "GET") {
      if (query.pop === "true") {
        const popped = queue.length > 0 ? queue.shift() : null;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, item: popped, queue }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, queue }));
      return;
    }

    // POST /api/queue
    if (req.method === "POST") {
      readBody(req, res, (body) => {
        try {
          const data = JSON.parse(body || "{}");
          if (!isRemoteAuthorized(req, data)) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "PIN required" }));
            return;
          }

          const rawUrl = data.url || data.videoId;
          const action = data.action || "add_queue"; // play_now, play_next, add_queue
          const title = data.title && String(data.title).trim();
          const videoId = extractYouTubeVideoId(rawUrl);

          if (!videoId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Could not extract valid YouTube video ID" }));
            return;
          }

          const item = {
            id: `q_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            videoId: videoId,
            title: title ? title : `YouTube Video (${videoId})`,
            addedAt: Date.now()
          };
          if (!title) {
            fetchVideoTitleAsync(item);
          }

          if (action === "play_now") {
            pendingControls.push({ action: "play_now", videoId, title: item.title });
          } else if (action === "play_next") {
            queue.unshift(item);
          } else {
            queue.push(item);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, item, action, queue }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
        }
      });
      return;
    }

    // DELETE /api/queue
    if (req.method === "DELETE") {
      if (query.id) {
        queue = queue.filter((item) => item.id !== query.id);
      } else {
        queue = [];
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, queue }));
      return;
    }
  }

  // 5. Playback Control API
  if (pathname === "/api/control" && req.method === "POST") {
    readBody(req, res, (body) => {
      try {
        const data = JSON.parse(body || "{}");
        if (!isRemoteAuthorized(req, data)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "PIN required" }));
          return;
        }

        const action = data.action; // play, pause, next, volume, play_now
        const val = data.value;

        if (action === "next") {
          const nextItem = queue.length > 0 ? queue.shift() : null;
          if (nextItem) {
            pendingControls.push({ action: "play_now", videoId: nextItem.videoId, title: nextItem.title });
          } else {
            pendingControls.push({ action: "next" });
          }
        } else if (action === "play_now" && (data.videoId || data.url)) {
          const vid = extractYouTubeVideoId(data.videoId || data.url);
          pendingControls.push({ action: "play_now", videoId: vid, title: data.title });
        } else {
          pendingControls.push({ action, value: val });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, action }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
      }
    });
    return;
  }

  // 6. Polling endpoint for Desktop Extension
  if (pathname === "/api/control/poll" && req.method === "GET") {
    const actions = [...pendingControls];
    pendingControls = [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, actions }));
    return;
  }

  // 7. Playback update from Desktop Extension or APK
  if (pathname === "/api/playback" && req.method === "POST") {
    readBody(req, res, (body) => {
      try {
        const data = JSON.parse(body || "{}");
        if (data.videoId) currentPlayback.videoId = data.videoId;
        if (data.title) currentPlayback.title = data.title;
        if (typeof data.isPlaying === "boolean") currentPlayback.isPlaying = data.isPlaying;
        if (typeof data.volume === "number") currentPlayback.volume = data.volume;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, currentVideo: currentPlayback }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
      }
    });
    return;
  }

  // 8. Server Config Endpoint (Set PIN / PinRequired from extension settings)
  if (pathname === "/api/config") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        pinRequired: serverConfig.pinRequired,
        remotePin: serverConfig.remotePin ? "••••" : ""
      }));
      return;
    }
    if (req.method === "POST") {
      readBody(req, res, (body) => {
        try {
          const data = JSON.parse(body || "{}");
          if (typeof data.pinRequired === "boolean") serverConfig.pinRequired = data.pinRequired;
          if (typeof data.remotePin === "string") serverConfig.remotePin = data.remotePin.trim();
          saveConfig(serverConfig);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, pinRequired: serverConfig.pinRequired }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
        }
      });
      return;
    }
  }

  // --- NAS DATABASE SYNC ENDPOINTS (Protected by NAS_AUTH_TOKEN) ---

  // Check auth for NAS endpoints
  if (pathname === "/api/skipSegments" || pathname === "/skipSegments" || pathname === "/api/database" || pathname === "/api/add") {
    if (!isNasAuthorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }

  // 9. Fetch Segments for a specific Video (SponsorBlock-compatible endpoint)
  if (req.method === "GET" && (pathname === "/api/skipSegments" || pathname === "/skipSegments")) {
    const videoId = query.videoID || query.videoId || query.v;
    if (!isValidVideoId(videoId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing videoID query parameter" }));
      return;
    }

    const db = readDb();
    const videoSegments = db[videoId] || [];

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

  // 10. Add or Update a Segment
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

  // 11. Delete a Segment
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

  // 12. Entire Database Import & Export
  if (req.method === "GET" && pathname === "/api/database") {
    const db = readDb();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(db, null, 2));
    return;
  }

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

// Automatic Port Fallback (Tries up to 20 ports if busy)
let currentPort = PORT;
const INITIAL_PORT = PORT;

function startServer(portToTry) {
  server.removeAllListeners("error");
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && currentPort - INITIAL_PORT < 20) {
      console.warn(`[Remote Server] Port ${currentPort} busy, trying ${currentPort + 1}...`);
      currentPort++;
      startServer(currentPort);
    } else {
      console.error("[Remote Server] Failed to start server:", err);
    }
  });

  server.listen(portToTry, BIND_HOST, () => {
    console.log(`🌸 Gacha MV NAS & Remote Server running on http://${BIND_HOST}:${portToTry}`);
    console.log(`📱 Phone Web Remote available at: http://${getLocalIp()}:${portToTry}/remote`);
    console.log(`📁 Storing database at: ${DB_FILE}`);
  });
}

startServer(currentPort);
