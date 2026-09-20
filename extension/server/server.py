#!/usr/bin/env python3
"""
Gacha MV Player - Standalone Python 3 NAS Database & Local Wi-Fi Remote Server
Zero external dependencies! Runs with standard library on any Python 3.7+ system.
"""

import http.server
import json
import os
import urllib.parse
import urllib.request
import sys
import time
import random
import hmac
import re
import math
import socket
import threading

PORT = int(os.environ.get("PORT", 3000))
BIND_HOST = os.environ.get("BIND_HOST", "0.0.0.0")
AUTH_TOKEN = os.environ.get("NAS_AUTH_TOKEN", "").strip()
ALLOWED_ORIGINS = {origin.strip() for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",") if origin.strip()}
MAX_BODY_BYTES = 1024 * 1024
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
DB_FILE = os.path.join(DATA_DIR, "database.json")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")

os.makedirs(DATA_DIR, exist_ok=True)
if not os.path.exists(DB_FILE):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump({}, f, indent=2)

server_config = {
    "pinRequired": bool(os.environ.get("REMOTE_PIN")),
    "remotePin": os.environ.get("REMOTE_PIN", "").strip()
}

if os.path.exists(CONFIG_FILE):
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            loaded = json.load(f)
            if isinstance(loaded, dict):
                server_config.update(loaded)
    except Exception:
        pass

def save_config(cfg):
    try:
        server_config.update(cfg)
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(server_config, f, indent=2)
    except Exception as e:
        print(f"[Server] Error saving config: {e}")

# In-Memory Queue & Controls
queue_lock = threading.Lock()
queue = []
pending_controls = []
current_playback = {
    "videoId": "",
    "title": "No video playing",
    "isPlaying": False,
    "volume": 100
}

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def get_available_ips():
    results = []
    # Method 1: ip -j addr (Linux)
    try:
        import subprocess
        proc = subprocess.run(["ip", "-j", "addr"], capture_output=True, text=True, timeout=2)
        if proc.returncode == 0:
            data = json.loads(proc.stdout)
            for iface in data:
                ifname = iface.get("ifname", "").lower()
                addr_info = iface.get("addr_info", [])
                for addr in addr_info:
                    if addr.get("family") == "inet" and addr.get("local") != "127.0.0.1":
                        ip = addr.get("local")
                        label = ifname
                        itype = "other"
                        if "tailscale" in ifname or ifname.startswith("ts") or ip.startswith("100."):
                            itype = "tailscale"
                            label = "Tailscale"
                        elif ifname.startswith("wlan") or ifname.startswith("wl") or "wifi" in ifname:
                            itype = "wifi"
                            label = "Wi-Fi"
                        elif ifname.startswith("eth") or ifname.startswith("en"):
                            itype = "ethernet"
                            label = "Ethernet"
                        elif "ap" in ifname or "hotspot" in ifname:
                            itype = "hotspot"
                            label = "Hotspot"
                        results.append({"name": label, "ip": ip, "type": itype})
            if results:
                return results
    except Exception:
        pass

    # Method 2: socket fallback
    try:
        host = socket.gethostname()
        for info in socket.getaddrinfo(host, None):
            if info[0] == socket.AF_INET:
                ip = info[4][0]
                if ip != "127.0.0.1" and not any(r["ip"] == ip for r in results):
                    itype = "tailscale" if ip.startswith("100.") else "wifi" if ip.startswith("192.168.") else "other"
                    name = "Tailscale" if itype == "tailscale" else "Wi-Fi" if itype == "wifi" else "LAN"
                    results.append({"name": name, "ip": ip, "type": itype})
    except Exception:
        pass

    if not results:
        local_ip = get_local_ip()
        results.append({"name": "Wi-Fi", "ip": local_ip, "type": "wifi"})
    return results

def search_youtube(query):
    search_url = f"https://www.youtube.com/results?search_query={urllib.parse.quote_plus(query)}"
    req = urllib.request.Request(
        search_url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9"
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
            return parse_youtube_search_results(html)
    except Exception as e:
        print(f"[Server] Search error: {e}")
        return []

def parse_youtube_search_results(html):
    marker = "var ytInitialData = "
    idx = html.find(marker)
    if idx == -1:
        marker2 = 'window["ytInitialData"] = '
        idx = html.find(marker2)
        if idx == -1:
            return []
        idx += len(marker2)
    else:
        idx += len(marker)

    end_idx = html.find(";</script>", idx)
    if end_idx == -1:
        end_idx = html.find(";\n", idx)
    if end_idx == -1:
        return []

    try:
        data = json.loads(html[idx:end_idx].strip())
        results = []
        contents = (
            data.get("contents", {})
            .get("twoColumnSearchResultsRenderer", {})
            .get("primaryContents", {})
            .get("sectionListRenderer", {})
            .get("contents", [])
        )
        for section in contents:
            items = section.get("itemSectionRenderer", {}).get("contents", [])
            for item in items:
                vr = item.get("videoRenderer")
                if not vr or "videoId" not in vr:
                    continue
                vid = vr["videoId"]
                title = ""
                if "runs" in vr.get("title", {}):
                    title = "".join(r.get("text", "") for r in vr["title"]["runs"])
                elif "simpleText" in vr.get("title", {}):
                    title = vr["title"]["simpleText"]

                channel = ""
                if "runs" in vr.get("ownerText", {}):
                    channel = "".join(r.get("text", "") for r in vr["ownerText"]["runs"])

                thumbnail = ""
                thumbs = vr.get("thumbnail", {}).get("thumbnails", [])
                if thumbs:
                    thumbnail = thumbs[-1].get("url", "")
                else:
                    thumbnail = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"

                results.append({
                    "id": vid,
                    "title": title or f"YouTube Video ({vid})",
                    "channel": channel,
                    "thumbnail": thumbnail
                })
                if len(results) >= 20:
                    break
            if len(results) >= 20:
                break
        return results
    except Exception as e:
        print(f"[Server] JSON parse search error: {e}")
        return []

def extract_youtube_video_id(input_str):
    if not input_str or not isinstance(input_str, str):
        return None
    s = input_str.strip()
    if re.fullmatch(r"[a-zA-Z0-9_-]{11}", s):
        return s
    m = re.search(r"(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([a-zA-Z0-9_-]{11})", s)
    if m:
        return m.group(1)
    return None

def fetch_video_title_async(item):
    def run():
        try:
            oembed_url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={item['videoId']}&format=json"
            req = urllib.request.Request(oembed_url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=4) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    if "title" in data:
                        item["title"] = data["title"]
        except Exception:
            pass
    threading.Thread(target=run, daemon=True).start()

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

def get_web_remote_html(pin_required):
    pin_modal = """
  <div id="pinOverlay" class="pin-overlay">
    <div class="pin-card">
      <h2 style="font-size:18px; margin-bottom:6px;">🔒 Remote PIN Required</h2>
      <p style="font-size:12px; color:var(--subtext);">Enter the 4-digit PIN configured in Player Settings</p>
      <input type="password" id="pinInput" class="pin-input" maxlength="8" placeholder="••••" autofocus>
      <button id="btnSubmitPin" class="pin-btn">Unlock Remote</button>
    </div>
  </div>""" if pin_required else ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>🌸 Gacha MV Remote</title>
  <style>
    :root {{
      --bg: #0d0a1a;
      --card-bg: #16122a;
      --card-border: rgba(255, 46, 147, 0.25);
      --pink: #ff2e93;
      --cyan: #00e5ff;
      --green: #00ffaa;
      --text: #ffffff;
      --subtext: #a09bb8;
    }}
    * {{ box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }}
    body {{ background: var(--bg); color: var(--text); padding: 14px; min-height: 100vh; }}
    header {{ display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid var(--card-border); }}
    h1 {{ font-size: 19px; color: var(--text); font-weight: 800; display: flex; align-items: center; gap: 6px; }}
    .badge {{ font-size: 11px; background: rgba(0,255,170,0.15); color: var(--green); border: 1px solid var(--green); border-radius: 12px; padding: 3px 8px; font-weight: 700; }}
    .card {{ background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; padding: 16px; margin-bottom: 14px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }}
    .card-title {{ font-size: 13px; font-weight: 700; color: var(--cyan); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }}
    .now-playing-title {{ font-size: 15px; font-weight: 700; color: var(--text); line-height: 1.3; margin-bottom: 12px; word-break: break-word; }}
    .ctrl-row {{ display: flex; gap: 10px; margin-top: 10px; }}
    .btn-ctrl {{ flex: 1; height: 46px; border: none; border-radius: 12px; background: rgba(255,255,255,0.08); color: #fff; font-size: 16px; font-weight: 700; cursor: pointer; transition: all 0.15s; display: flex; align-items: center; justify-content: center; gap: 6px; }}
    .btn-ctrl:active {{ transform: scale(0.96); background: rgba(255,255,255,0.18); }}
    .btn-primary {{ background: linear-gradient(135deg, var(--pink), #8f00ff); color: #fff; }}
    .btn-accent {{ background: rgba(0, 229, 255, 0.2); border: 1px solid var(--cyan); color: var(--cyan); }}
    .input-box {{ width: 100%; height: 46px; background: #211a3e; border: 1px solid rgba(255,255,255,0.15); border-radius: 12px; padding: 0 14px; color: #fff; font-size: 14px; margin-bottom: 10px; outline: none; }}
    .input-box:focus {{ border-color: var(--pink); box-shadow: 0 0 10px rgba(255,46,147,0.3); }}
    .btn-grid {{ display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }}
    .btn-act {{ height: 42px; border: none; border-radius: 10px; font-size: 12px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px; transition: all 0.15s; }}
    .btn-act:active {{ transform: scale(0.96); }}
    .btn-now {{ background: var(--pink); color: #fff; }}
    .btn-next {{ background: #6b21a8; color: #fff; border: 1px solid #a855f7; }}
    .btn-queue {{ background: rgba(0,229,255,0.15); color: var(--cyan); border: 1px solid var(--cyan); }}
    .search-item {{ background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 10px; display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }}
    .search-thumb-row {{ display: flex; gap: 10px; align-items: center; }}
    .search-thumb {{ width: 96px; height: 54px; object-fit: cover; border-radius: 6px; flex-shrink: 0; background: #222; }}
    .search-meta {{ flex: 1; min-width: 0; }}
    .search-title {{ font-size: 13px; font-weight: 700; color: #fff; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }}
    .search-channel {{ font-size: 11px; color: var(--subtext); margin-top: 3px; }}
    .queue-item {{ display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }}
    .queue-num {{ font-size: 12px; font-weight: 800; color: var(--cyan); margin-right: 10px; min-width: 18px; }}
    .queue-title {{ font-size: 13px; font-weight: 600; color: #eee; flex: 1; word-break: break-word; }}
    .queue-del {{ background: none; border: none; color: #ff4444; font-size: 16px; padding: 6px; cursor: pointer; }}
    .queue-empty {{ color: var(--subtext); font-size: 13px; font-style: italic; text-align: center; padding: 18px 0; }}
    .vol-wrap {{ display: flex; align-items: center; gap: 10px; margin-top: 14px; }}
    .vol-slider {{ flex: 1; accent-color: var(--pink); }}
    .toast {{ position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #2e1b4e; border: 1px solid var(--pink); color: #fff; padding: 10px 18px; border-radius: 20px; font-size: 13px; font-weight: 700; box-shadow: 0 4px 15px rgba(0,0,0,0.5); opacity: 0; pointer-events: none; transition: opacity 0.25s ease; z-index: 100; }}
    .toast.show {{ opacity: 1; }}
    /* PIN Modal */
    .pin-overlay {{ position: fixed; inset: 0; background: rgba(13,10,26,0.95); display: flex; align-items: center; justify-content: center; z-index: 200; padding: 20px; }}
    .pin-card {{ background: var(--card-bg); border: 1px solid var(--pink); border-radius: 20px; padding: 24px; width: 100%; max-width: 320px; text-align: center; }}
    .pin-input {{ width: 100%; height: 50px; font-size: 24px; text-align: center; letter-spacing: 8px; background: #211a3e; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; color: #fff; margin: 16px 0; outline: none; }}
    .pin-btn {{ width: 100%; height: 46px; background: var(--pink); color: #fff; border: none; border-radius: 12px; font-size: 15px; font-weight: 700; cursor: pointer; }}
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
{pin_modal}

  <script>
    let currentPin = localStorage.getItem('gcmv_remote_pin') || '';
    let isPlaying = false;

    function showToast(msg) {{
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2600);
    }}

    async function api(path, opts = {{}}) {{
      opts.headers = opts.headers || {{}};
      if (currentPin) opts.headers['X-GCMV-PIN'] = currentPin;
      try {{
        const r = await fetch(path, opts);
        if (r.status === 401) {{
          const po = document.getElementById('pinOverlay');
          if (po) po.style.display = 'flex';
        }}
        return await r.json();
      }} catch (e) {{ return {{ success: false, error: e.message || 'Network error' }}; }}
    }}

    async function refreshStatus() {{
      const data = await api('/api/status');
      if (!data) return;
      if (data.currentVideo) {{
        document.getElementById('nowPlayingTitle').textContent = data.currentVideo.title || 'Playing video';
        isPlaying = data.currentVideo.isPlaying;
        document.getElementById('btnPlayPause').textContent = isPlaying ? '⏸️ Pause' : '▶️ Play';
      }}
      const q = data.queue || [];
      document.getElementById('queueCount').textContent = q.length;
      const qList = document.getElementById('queueList');
      if (q.length === 0) {{
        qList.innerHTML = '<div class="queue-empty">Queue is empty. Add a video above!</div>';
      }} else {{
        qList.innerHTML = q.map((item, idx) => `
          <div class="queue-item">
            <span class="queue-num">${{idx + 1}}</span>
            <span class="queue-title">${{item.title || item.videoId}}</span>
            <button class="queue-del" onclick="deleteQueueItem('${{item.id}}')">🗑️</button>
          </div>
        `).join('');
      }}
    }}

    async function doSearch() {{
      const q = document.getElementById('inputSearch').value.trim();
      if (!q) return showToast('⚠️ Enter a search query');
      const sResults = document.getElementById('searchResults');
      sResults.innerHTML = '<div style="color:var(--subtext); text-align:center; padding:15px;">🔍 Searching...</div>';
      const res = await api('/api/search?q=' + encodeURIComponent(q));
      const results = Array.isArray(res) ? res : (res?.results || []);
      if (!results || results.length === 0) {{
        sResults.innerHTML = '<div style="color:var(--subtext); text-align:center; padding:15px;">No results found</div>';
        return;
      }}
      window._lastSearchResults = results;
      sResults.innerHTML = results.map((item, idx) => `
        <div class="search-item">
          <div class="search-thumb-row">
            <img class="search-thumb" src="${{item.thumbnail || ''}}" alt="" onerror="this.style.display='none'">
            <div class="search-meta">
              <div class="search-title">${{item.title || 'Video'}}</div>
              <div class="search-channel">${{item.channel || ''}}</div>
            </div>
          </div>
          <div class="btn-grid">
            <button class="btn-act btn-now" onclick="actionSearchResult('${{item.videoId || item.id}}', ${{idx}}, 'play_now')">▶️ Play Now</button>
            <button class="btn-act btn-next" onclick="actionSearchResult('${{item.videoId || item.id}}', ${{idx}}, 'play_next')">⏭️ Play Next</button>
            <button class="btn-act btn-queue" onclick="actionSearchResult('${{item.videoId || item.id}}', ${{idx}}, 'add_queue')">➕ Add Queue</button>
          </div>
        </div>
      `).join('');
    }}

    window.actionSearchResult = async function(id, idx, action) {{
      const item = (window._lastSearchResults && window._lastSearchResults[idx]) || {{ videoId: id, id: id }};
      const targetId = item.videoId || item.id || id;
      const res = await api('/api/queue', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ url: targetId, title: item.title, action: action, pin: currentPin }})
      }});
      if (res && res.success) {{
        const actLabel = action === 'play_now' ? '▶️ Playing now!' : action === 'play_next' ? '⏭️ Queued next!' : '➕ Added to queue!';
        showToast(actLabel);
        refreshStatus();
      }} else {{
        showToast('❌ ' + (res?.error || 'Action failed'));
      }}
    }};

    document.getElementById('btnSearch').addEventListener('click', doSearch);
    document.getElementById('inputSearch').addEventListener('keydown', (e) => {{
      if (e.key === 'Enter') doSearch();
    }});

    async function addVideo(action) {{
      const input = document.getElementById('inputUrl');
      const val = input.value.trim();
      if (!val) return showToast('⚠️ Enter a YouTube URL or Video ID');
      const res = await api('/api/queue', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ url: val, action: action, pin: currentPin }})
      }});
      if (res && res.success) {{
        input.value = '';
        const actLabel = action === 'play_now' ? '▶️ Playing now!' : action === 'play_next' ? '⏭️ Queued to play next!' : '➕ Added to queue!';
        showToast(actLabel);
        refreshStatus();
      }} else {{
        showToast('❌ ' + (res?.error || 'Failed to add video'));
      }}
    }}

    window.deleteQueueItem = async function(id) {{
      await api('/api/queue?id=' + encodeURIComponent(id), {{ method: 'DELETE' }});
      refreshStatus();
    }};

    document.getElementById('btnPlayNow').addEventListener('click', () => addVideo('play_now'));
    document.getElementById('btnPlayNext').addEventListener('click', () => addVideo('play_next'));
    document.getElementById('btnAddQueue').addEventListener('click', () => addVideo('add_queue'));

    document.getElementById('btnPlayPause').addEventListener('click', async () => {{
      await api('/api/control', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ action: isPlaying ? 'pause' : 'play' }})
      }});
      isPlaying = !isPlaying;
      document.getElementById('btnPlayPause').textContent = isPlaying ? '⏸️ Pause' : '▶️ Play';
    }});

    document.getElementById('btnSkipNext').addEventListener('click', async () => {{
      await api('/api/control', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ action: 'next' }})
      }});
      showToast('⏭️ Skipped!');
      setTimeout(refreshStatus, 600);
    }});

    document.getElementById('btnClearQueue').addEventListener('click', async () => {{
      if (!confirm('Clear all queued songs?')) return;
      await api('/api/queue', {{ method: 'DELETE' }});
      refreshStatus();
    }});

    const slider = document.getElementById('sliderVol');
    slider.addEventListener('input', (e) => {{
      document.getElementById('volVal').textContent = e.target.value + '%';
    }});
    slider.addEventListener('change', async (e) => {{
      await api('/api/control', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ action: 'volume', value: parseInt(e.target.value, 10) }})
      }});
    }});

    const btnPin = document.getElementById('btnSubmitPin');
    if (btnPin) {{
      btnPin.addEventListener('click', async () => {{
        const pinVal = document.getElementById('pinInput').value.trim();
        const res = await api('/api/auth', {{
          method: 'POST',
          headers: {{ 'Content-Type': 'application/json' }},
          body: JSON.stringify({{ pin: pinVal }})
        }});
        if (res && res.success) {{
          currentPin = pinVal;
          localStorage.setItem('gcmv_remote_pin', pinVal);
          document.getElementById('pinOverlay').style.display = 'none';
          refreshStatus();
        }} else {{
          alert('❌ Incorrect PIN');
        }}
      }});
    }}

    refreshStatus();
    setInterval(refreshStatus, 2500);
  </script>
</body>
</html>"""

class NasHandler(http.server.BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        origin = self.headers.get("Origin", "")
        if is_allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        else:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-GCMV-PIN")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def _require_nas_auth(self):
        if not AUTH_TOKEN:
            return False
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

    def _is_remote_authorized(self, body_json=None):
        if not server_config.get("pinRequired") or not server_config.get("remotePin"):
            return True
        header_pin = self.headers.get("X-GCMV-PIN", "").strip()
        expected_pin = server_config.get("remotePin", "").strip()
        if header_pin and header_pin == expected_pin:
            return True
        if body_json and isinstance(body_json, dict) and str(body_json.get("pin", "")).strip() == expected_pin:
            return True
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
            return json.loads(body) if body else {}
        except Exception:
            self.send_response(400)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Invalid JSON body"}).encode("utf-8"))
            return None

    def do_GET(self):
        global queue, pending_controls
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # 1. Web Remote HTML
        if path in ("/", "/remote"):
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "text/html; charset=UTF-8")
            self.end_headers()
            html = get_web_remote_html(server_config.get("pinRequired") and bool(server_config.get("remotePin")))
            self.wfile.write(html.encode("utf-8"))
            return

        # 2. Health & Status Check
        if path in ("/api/status", "/health"):
            is_nas = bool(self.headers.get("Authorization"))
            video_count = 0
            total_segments = 0
            if is_nas:
                db = read_db()
                video_count = len(db)
                total_segments = sum(len(v) for v in db.values() if isinstance(v, list))

            with queue_lock:
                q_copy = list(queue)

            local_ip = get_local_ip()
            bound_port = server_port
            server_url = f"http://{local_ip}:{bound_port}/remote"
            addresses = get_available_ips()

            resp = {
                "status": "online",
                "service": "Gacha MV Player Python Remote & NAS Server",
                "version": "1.0.3.3",
                "serverUrl": server_url,
                "ip": local_ip,
                "addresses": addresses,
                "port": bound_port,
                "pinRequired": server_config.get("pinRequired") and bool(server_config.get("remotePin")),
                "currentVideo": current_playback,
                "queue": q_copy,
                "videoCount": video_count,
                "totalSegments": total_segments,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            }
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(resp).encode("utf-8"))
            return

        # 2b. YouTube Search API (Zero external API keys)
        if path == "/api/search":
            q_list = query.get("q")
            if not q_list or not q_list[0].strip():
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Missing 'q' query parameter"}).encode("utf-8"))
                return
            q = q_list[0].strip()
            results = search_youtube(q)
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"query": q, "results": results}).encode("utf-8"))
            return

        # 3. Remote Queue GET
        if path == "/api/queue":
            pop_item = query.get("pop", ["false"])[0] == "true"
            with queue_lock:
                popped = queue.pop(0) if (pop_item and len(queue) > 0) else None
                q_copy = list(queue)
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "item": popped, "queue": q_copy}).encode("utf-8"))
            return

        # 4. Control Polling for Desktop Extension
        if path == "/api/control/poll":
            with queue_lock:
                actions = list(pending_controls)
                pending_controls.clear()
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "actions": actions}).encode("utf-8"))
            return

        # 5. Remote Config GET
        if path == "/api/config":
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            resp = {
                "pinRequired": server_config.get("pinRequired", False),
                "remotePin": "••••" if server_config.get("remotePin") else ""
            }
            self.wfile.write(json.dumps(resp).encode("utf-8"))
            return

        # --- NAS DATABASE SYNC GET ENDPOINTS ---
        if path in ("/api/skipSegments", "/skipSegments"):
            if not self._require_nas_auth():
                return
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

        if path == "/api/database":
            if not self._require_nas_auth():
                return
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
        self.wfile.write(json.dumps({"error": "Endpoint not found"}).encode("utf-8"))

    def do_POST(self):
        global queue, pending_controls, current_playback
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self._read_json_body()
        if body is None:
            return

        # 1. Auth check
        if path == "/api/auth":
            pin = str(body.get("pin", "")).strip()
            expected = server_config.get("remotePin", "").strip()
            if not server_config.get("pinRequired") or pin == expected:
                self.send_response(200)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": True}).encode("utf-8"))
            else:
                self.send_response(401)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": "Invalid PIN"}).encode("utf-8"))
            return

        # 2. Add to Queue
        if path == "/api/queue":
            if not self._is_remote_authorized(body):
                self.send_response(401)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "PIN required"}).encode("utf-8"))
                return

            raw_url = body.get("url") or body.get("videoId")
            action = body.get("action", "add_queue")
            title = body.get("title", "").strip() if isinstance(body.get("title"), str) else ""
            video_id = extract_youtube_video_id(raw_url)
            if not video_id:
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Could not extract valid YouTube video ID"}).encode("utf-8"))
                return

            item = {
                "id": f"q_{int(time.time() * 1000)}_{random.randint(100, 999)}",
                "videoId": video_id,
                "title": title if title else f"YouTube Video ({video_id})",
                "addedAt": int(time.time() * 1000)
            }
            if not title:
                fetch_video_title_async(item)

            with queue_lock:
                if action == "play_now":
                    pending_controls.append({"action": "play_now", "videoId": video_id, "title": item["title"]})
                elif action == "play_next":
                    queue.insert(0, item)
                else:
                    queue.append(item)
                q_copy = list(queue)

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "item": item, "action": action, "queue": q_copy}).encode("utf-8"))
            return

        # 3. Playback Control
        if path == "/api/control":
            if not self._is_remote_authorized(body):
                self.send_response(401)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "PIN required"}).encode("utf-8"))
                return

            action = body.get("action")
            val = body.get("value")
            with queue_lock:
                if action == "next":
                    next_item = queue.pop(0) if len(queue) > 0 else None
                    if next_item:
                        pending_controls.append({"action": "play_now", "videoId": next_item["videoId"], "title": next_item["title"]})
                    else:
                        pending_controls.append({"action": "next"})
                elif action == "play_now" and (body.get("videoId") or body.get("url")):
                    vid = extract_youtube_video_id(body.get("videoId") or body.get("url"))
                    pending_controls.append({"action": "play_now", "videoId": vid, "title": body.get("title", "")})
                else:
                    pending_controls.append({"action": action, "value": val})

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "action": action}).encode("utf-8"))
            return

        # 4. Playback State Update (from player)
        if path == "/api/playback":
            if "videoId" in body:
                current_playback["videoId"] = body["videoId"]
            if "title" in body:
                current_playback["title"] = body["title"]
            if "isPlaying" in body and isinstance(body["isPlaying"], bool):
                current_playback["isPlaying"] = body["isPlaying"]
            if "volume" in body and isinstance(body["volume"], (int, float)):
                current_playback["volume"] = int(body["volume"])

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "currentVideo": current_playback}).encode("utf-8"))
            return

        # 5. Remote Config Update
        if path == "/api/config":
            if "pinRequired" in body and isinstance(body["pinRequired"], bool):
                server_config["pinRequired"] = body["pinRequired"]
            if "remotePin" in body and isinstance(body["remotePin"], str):
                server_config["remotePin"] = body["remotePin"].strip()
            save_config(server_config)
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "pinRequired": server_config.get("pinRequired", False)}).encode("utf-8"))
            return

        # --- NAS DATABASE SYNC POST ENDPOINTS ---
        if path in ("/api/skipSegments", "/api/add"):
            if not self._require_nas_auth():
                return
            video_id = body.get("videoId") or body.get("videoID")
            try:
                start = float(body.get("start"))
                end = float(body.get("end"))
            except (TypeError, ValueError):
                start, end = -1, -1

            category = str(body.get("category", "custom"))[:64]
            label = str(body.get("label", ""))[:256]

            if not is_valid_video_id(video_id) or not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Invalid videoId, start, or end timestamp"}).encode("utf-8"))
                return

            db = read_db()
            if video_id not in db:
                db[video_id] = []

            seg_id = str(body.get("id", f"nas_{int(time.time()*1000)}_{random.randint(100, 999)}"))[:200]
            segment = {"id": seg_id, "start": round(start, 1), "end": round(end, 1), "category": category, "label": label}

            existing_idx = next((i for i, s in enumerate(db[video_id]) if s.get("id") == seg_id or s.get("UUID") == seg_id), -1)
            if existing_idx >= 0:
                db[video_id][existing_idx] = segment
            else:
                db[video_id].append(segment)

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
            self.wfile.write(json.dumps({"success": True, "id": seg_id, "segment": segment}).encode("utf-8"))
            return

        if path == "/api/database":
            if not self._require_nas_auth():
                return
            if not is_valid_database(body) or not write_db(body):
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Invalid database payload"}).encode("utf-8"))
                return

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "videoCount": len(body)}).encode("utf-8"))
            return

        self.send_response(404)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Endpoint not found"}).encode("utf-8"))

    def do_DELETE(self):
        global queue
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/api/queue":
            q_id = query.get("id", [None])[0]
            with queue_lock:
                if q_id:
                    queue = [item for item in queue if item.get("id") != q_id]
                else:
                    queue.clear()
                q_copy = list(queue)

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "queue": q_copy}).encode("utf-8"))
            return

        if path == "/api/skipSegments":
            if not self._require_nas_auth():
                return
            v_list = query.get("videoID") or query.get("videoId")
            s_list = query.get("id") or query.get("UUID")
            if not v_list or not s_list:
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Missing videoId or segment id"}).encode("utf-8"))
                return

            video_id, segment_id = v_list[0], s_list[0]
            db = read_db()
            if video_id in db:
                db[video_id] = [s for s in db[video_id] if s.get("id") != segment_id and s.get("UUID") != segment_id]
                if not db[video_id]:
                    del db[video_id]
                write_db(db)

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True}).encode("utf-8"))
            return

        self.send_response(404)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Endpoint not found"}).encode("utf-8"))

def main():
    start_port = PORT
    httpd = None
    bound_port = start_port

    for p in range(start_port, start_port + 20):
        try:
            httpd = http.server.ThreadingHTTPServer((BIND_HOST, p), NasHandler)
            bound_port = p
            break
        except OSError:
            print(f"[Remote Server] Port {p} busy, trying {p + 1}...")

    if not httpd:
        print(f"[Remote Server] Failed to bind to any port in range {start_port}-{start_port + 20}", file=sys.stderr)
        sys.exit(1)

    print(f"🌸 Gacha MV NAS & Remote Server running on http://{BIND_HOST}:{bound_port}")
    print(f"📱 Phone Web Remote available at: http://{get_local_ip()}:{bound_port}/remote")
    print(f"📁 Storing database at: {DB_FILE}")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
        httpd.server_close()

if __name__ == "__main__":
    main()
