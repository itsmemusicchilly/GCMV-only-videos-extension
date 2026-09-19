#!/usr/bin/env python3
"""
Gacha MV Player - Standalone Python 3 NAS Database Server
Zero external dependencies! Runs with standard library on any Python 3.7+ system.
"""

import http.server
import json
import os
import urllib.parse
import sys
import time
import random
import hmac
import re
import math

PORT = int(os.environ.get("PORT", 3000))
BIND_HOST = os.environ.get("BIND_HOST", "127.0.0.1")
AUTH_TOKEN = os.environ.get("NAS_AUTH_TOKEN", "").strip()
ALLOWED_ORIGINS = {origin.strip() for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",") if origin.strip()}
MAX_BODY_BYTES = 1024 * 1024
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
DB_FILE = os.path.join(DATA_DIR, "database.json")

if not AUTH_TOKEN:
    print("[NAS Server] NAS_AUTH_TOKEN is required. Refusing to start without authentication.", file=sys.stderr)
    sys.exit(1)

os.makedirs(DATA_DIR, exist_ok=True)
if not os.path.exists(DB_FILE):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump({}, f, indent=2)

def read_db():
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            if not is_valid_database(data):
                raise ValueError("database.json has an invalid structure")
            return data
    except Exception as e:
        print(f"[NAS Server] Error reading database: {e}")
        return {}

def write_db(data):
    try:
        temp_file = f"{DB_FILE}.tmp"
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(temp_file, DB_FILE)
        return True
    except Exception as e:
        print(f"[NAS Server] Error writing database: {e}")
        return False

def is_valid_video_id(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) is not None

def is_valid_segment(segment):
    if not isinstance(segment, dict):
        return False
    try:
        start = float(segment.get("start"))
        end = float(segment.get("end"))
        return math.isfinite(start) and math.isfinite(end) and start >= 0 and end > start
    except (TypeError, ValueError):
        return False

def is_valid_database(data):
    return isinstance(data, dict) and all(
        is_valid_video_id(video_id)
        and isinstance(segments, list)
        and all(is_valid_segment(segment) for segment in segments)
        for video_id, segments in data.items()
    )

def is_allowed_origin(origin):
    if not origin:
        return False
    return re.fullmatch(r"(?:chrome|moz)-extension://[A-Za-z0-9_-]+", origin) is not None or origin in ALLOWED_ORIGINS

class NasHandler(http.server.BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        origin = self.headers.get("Origin", "")
        if is_allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")

    def do_OPTIONS(self):
        self.send_response(204 if is_allowed_origin(self.headers.get("Origin", "")) else 403)
        self._send_cors_headers()
        self.end_headers()

    def _require_auth(self):
        header = self.headers.get("Authorization", "")
        supplied = header[7:] if header.startswith("Bearer ") else ""
        if hmac.compare_digest(supplied, AUTH_TOKEN):
            return True
        self.send_response(401)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("WWW-Authenticate", "Bearer")
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Unauthorized"}).encode("utf-8"))
        return False

    def _read_json_body(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > MAX_BODY_BYTES:
            self.send_response(413)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Request body exceeds 1 MiB limit"}).encode("utf-8"))
            return None
        try:
            body = self.rfile.read(content_length).decode("utf-8")
            return json.loads(body)
        except Exception:
            self.send_response(400)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Invalid JSON body"}).encode("utf-8"))
            return None

    def do_GET(self):
        if not self._require_auth():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # 1. Health / Status check
        if path in ("/", "/health", "/api/status"):
            db = read_db()
            total_segments = sum(len(v) for v in db.values() if isinstance(v, list))
            resp = {
                "status": "online",
                "service": "Gacha MV Player Python NAS Server",
                "version": "1.0.3.1",
                "videoCount": len(db),
                "totalSegments": total_segments
            }
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(resp).encode("utf-8"))
            return

        # 2. Get segments for a video
        if path in ("/api/skipSegments", "/skipSegments"):
            v_list = query.get("videoID") or query.get("videoId") or query.get("v")
            if not v_list:
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Missing videoID parameter"}).encode("utf-8"))
                return

            video_id = v_list[0]
            if not is_valid_video_id(video_id):
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Invalid videoID parameter"}).encode("utf-8"))
                return
            db = read_db()
            video_segs = db.get(video_id, [])

            sb_formatted = [
                {
                    "UUID": s.get("id", f"nas_{video_id}_{idx}"),
                    "segment": [s.get("start", 0), s.get("end", 0)],
                    "category": s.get("category", "custom"),
                    "label": s.get("label", s.get("category", "Custom Skip")),
                    "actionType": "skip",
                    "source": "nas"
                }
                for idx, s in enumerate(video_segs)
            ]

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(sb_formatted).encode("utf-8"))
            return

        # 3. Full Database Export
        if path == "/api/database":
            db = read_db()
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(db, indent=2).encode("utf-8"))
            return

        self.send_response(404)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Not Found"}).encode("utf-8"))

    def do_POST(self):
        if not self._require_auth():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        payload = self._read_json_body()
        if payload is None:
            return
        if not isinstance(payload, dict):
            self.send_response(400)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "JSON body must be an object"}).encode("utf-8"))
            return

        # Add Segment
        if path in ("/api/skipSegments", "/api/add"):
            video_id = payload.get("videoId") or payload.get("videoID")
            start = payload.get("start")
            end = payload.get("end")
            category = str(payload.get("category", "custom"))[:64]
            label = str(payload.get("label", ""))[:256]

            try:
                start = float(start)
                end = float(end)
            except (TypeError, ValueError):
                start = math.nan
                end = math.nan

            if not is_valid_video_id(video_id) or not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Missing videoId, start, or end"}).encode("utf-8"))
                return

            db = read_db()
            if video_id not in db:
                db[video_id] = []

            seg_id = str(payload.get("id") or f"nas_{int(time.time()*1000)}_{random.randint(100,999)}")[:200]
            segment = {
                "id": seg_id,
                "start": round(start, 1),
                "end": round(end, 1),
                "category": category,
                "label": label
            }

            existing_index = next(
                (i for i, item in enumerate(db[video_id]) if (item.get("id") or item.get("UUID")) == seg_id),
                None
            )
            if existing_index is None:
                db[video_id].append(segment)
            else:
                db[video_id][existing_index] = segment

            if not write_db(db):
                self.send_response(500)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Could not save database"}).encode("utf-8"))
                return

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "success": True,
                "id": seg_id,
                "segment": segment,
                "message": "Updated on NAS" if existing_index is not None else "Saved to NAS"
            }).encode("utf-8"))
            return

        # Import full database
        if path == "/api/database":
            if not is_valid_database(payload):
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Invalid database payload"}).encode("utf-8"))
                return
            is_merge = query.get("merge", ["false"])[0].lower() == "true"
            final_db = payload
            if is_merge:
                current = read_db()
                final_db = {**current}
                for v_id, segs in payload.items():
                    if v_id not in final_db:
                        final_db[v_id] = []
                    if isinstance(segs, list):
                        final_db[v_id].extend(segs)

            if not is_valid_database(final_db) or not write_db(final_db):
                self.send_response(500)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Could not save database"}).encode("utf-8"))
                return
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "videoCount": len(final_db)}).encode("utf-8"))
            return

        self.send_response(404)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Not Found"}).encode("utf-8"))

    def do_DELETE(self):
        if not self._require_auth():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/api/skipSegments":
            v_list = query.get("videoID") or query.get("videoId")
            id_list = query.get("id") or query.get("UUID")

            if not v_list or not id_list:
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Missing videoId or id"}).encode("utf-8"))
                return

            video_id = v_list[0]
            seg_id = id_list[0]
            if not is_valid_video_id(video_id) or len(seg_id) > 200:
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Invalid videoId or id"}).encode("utf-8"))
                return

            db = read_db()
            if video_id in db:
                db[video_id] = [s for s in db[video_id] if s.get("id") != seg_id and s.get("UUID") != seg_id]
                if len(db[video_id]) == 0:
                    del db[video_id]
                if not write_db(db):
                    self.send_response(500)
                    self._send_cors_headers()
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "Could not save database"}).encode("utf-8"))
                    return

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "message": "Deleted from NAS"}).encode("utf-8"))
            return

        self.send_response(404)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Not Found"}).encode("utf-8"))

if __name__ == "__main__":
    server_address = (BIND_HOST, PORT)
    httpd = http.server.HTTPServer(server_address, NasHandler)
    print(f"🌸 Gacha MV NAS Python Server running on http://{BIND_HOST}:{PORT}")
    print(f"📁 Database file: {DB_FILE}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        httpd.server_close()
