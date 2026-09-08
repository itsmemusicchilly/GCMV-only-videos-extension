# 🏠 Gacha MV Player - Self-Hosted NAS Server

Run your own private database server for **Gacha MV Player** on your **Synology**, **TrueNAS**, **unRAID**, **QNAP**, or any home server/Docker host.

---

## ⚡ 1-Minute Quickstart

### Method A: Direct Node.js (Easiest, No Docker Needed)
If your NAS has Node.js installed (e.g. Synology Node.js package):
```bash
NAS_AUTH_TOKEN="replace-with-a-long-random-token" BIND_HOST="0.0.0.0" node server.js
```
The server will run on `http://YOUR_NAS_IP:3000`.

### Method B: Direct Python 3 (Zero Setup)
```bash
NAS_AUTH_TOKEN="replace-with-a-long-random-token" BIND_HOST="0.0.0.0" python3 server.py
```
The server will run on `http://YOUR_NAS_IP:3000`.

### Method C: Docker / Docker Compose (Synology, Portainer, TrueNAS, unRAID)
1. Copy the `server/` directory to your NAS.
2. Create `server/.env` with a long random token:
   ```env
   NAS_AUTH_TOKEN=replace-with-a-long-random-token
   ```
3. In the `server/` directory, run:
   ```bash
   docker compose up -d
   ```
4. Your database is now active at `http://YOUR_NAS_IP:3080` with persistent storage in `./data/database.json`.

---

## 🔌 Connecting to Your Extension

1. Open YouTube and click the floating **Gacha Jukebox** on the bottom right (or open the browser extension popup).
2. Go to the **⚙️ Settings** tab.
3. Scroll to **🏠 Self-Hosted NAS Database**:
   - Toggle **Connect to NAS Database** ON.
   - Enter your NAS URL (e.g. `http://192.168.1.50:3000` or `https://nas.mydomain.com`).
   - Enter the same `NAS_AUTH_TOKEN` configured on the server.
   - Click **⚡ Test Connection** (will confirm with `✅ Connected (200 OK)`).
   - Toggle **Auto-Sync new skips to NAS** ON.

---

## 📡 API Endpoints

- `GET /health` or `GET /api/status`: Check server health, version, and total segment count.
- `GET /api/skipSegments?videoID=VIDEO_ID`: Get all skip segments & POI drops for a video.
- `POST /api/skipSegments`: Add or update a skip segment.
- `DELETE /api/skipSegments?videoID=VIDEO_ID&id=SEGMENT_ID`: Delete a skip segment.
- `GET /api/database`: Export the complete database JSON.
- `POST /api/database`: Import / restore a database JSON.

Segment reads use no-cache headers so clients always receive the latest NAS
data. Posting an existing segment `id` updates it instead of creating a
duplicate.

Every endpoint requires `Authorization: Bearer YOUR_NAS_AUTH_TOKEN`. The
server refuses to start without a token, binds to localhost by default for
direct runs, limits request bodies to 1 MiB, and writes the database
atomically. Set `BIND_HOST=0.0.0.0` only on a trusted LAN, VPN, or protected
reverse proxy. `ALLOWED_ORIGINS` can contain a comma-separated list of any
additional web origins that should receive CORS access.
