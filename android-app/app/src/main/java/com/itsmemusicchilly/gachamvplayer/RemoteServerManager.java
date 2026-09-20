package com.itsmemusicchilly.gachamvplayer;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Embedded Lightweight HTTP Server for Gacha MV Player.
 * Runs on local Wi-Fi, allowing phones/tablets to remotely add videos to the queue
 * (Play Now, Play Next, Add to Queue), control playback, and view the active queue.
 */
public class RemoteServerManager {

    private static final String TAG = "GCMV_RemoteServer";
    private static final int DEFAULT_PORT = 8080;
    private static final int MAX_PORT_ATTEMPTS = 20;

    public interface RemoteActionListener {
        void onPlayNow(String videoId, String title);
        void onControlAction(String action, Object value);
    }

    public static class QueueItem {
        public final String id;
        public final String videoId;
        public String title;
        public final long addedAt;

        public QueueItem(String id, String videoId, String title) {
            this.id = id != null ? id : UUID.randomUUID().toString();
            this.videoId = videoId;
            this.title = title != null && !title.isEmpty() ? title : "YouTube Video (" + videoId + ")";
            this.addedAt = System.currentTimeMillis();
        }

        public JSONObject toJson() {
            JSONObject obj = new JSONObject();
            try {
                obj.put("id", id);
                obj.put("videoId", videoId);
                obj.put("title", title);
                obj.put("addedAt", addedAt);
            } catch (Exception ignored) {}
            return obj;
        }
    }

    private final Context context;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private ServerSocket serverSocket = null;
    private volatile boolean isRunning = false;
    private int boundPort = DEFAULT_PORT;
    private RemoteActionListener listener = null;

    private final List<QueueItem> queue = new CopyOnWriteArrayList<>();
    private String currentVideoId = "";
    private String currentTitle = "No video playing";
    private boolean isPlaying = false;
    private int currentVolume = 100;

    public RemoteServerManager(Context context) {
        this.context = context.getApplicationContext();
    }

    public void setListener(RemoteActionListener listener) {
        this.listener = listener;
    }

    public synchronized void start(int preferredPort) {
        if (isRunning) return;

        int portToTry = preferredPort > 0 ? preferredPort : DEFAULT_PORT;
        executor.execute(() -> {
            int port = portToTry;
            for (int i = 0; i < MAX_PORT_ATTEMPTS; i++) {
                try {
                    serverSocket = new ServerSocket(port);
                    boundPort = port;
                    isRunning = true;
                    Log.i(TAG, "Remote server started on port " + boundPort);
                    break;
                } catch (Exception e) {
                    Log.w(TAG, "Port " + port + " busy, trying " + (port + 1) + "...");
                    port++;
                }
            }

            if (serverSocket == null || !isRunning) {
                Log.e(TAG, "Failed to bind remote server after " + MAX_PORT_ATTEMPTS + " attempts.");
                return;
            }

            while (isRunning && serverSocket != null && !serverSocket.isClosed()) {
                try {
                    Socket client = serverSocket.accept();
                    executor.execute(() -> handleClient(client));
                } catch (Exception e) {
                    if (!isRunning) break;
                    Log.e(TAG, "Error accepting client connection", e);
                }
            }
        });
    }

    public synchronized void stop() {
        isRunning = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (Exception ignored) {}
            serverSocket = null;
        }
    }

    public boolean isRunning() {
        return isRunning;
    }

    public int getBoundPort() {
        return boundPort;
    }

    public String getServerUrl() {
        String ip = getLocalIpAddress();
        return "http://" + ip + ":" + boundPort;
    }

    public String getLocalIpAddress() {
        try {
            // First check Wi-Fi manager
            WifiManager wm = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wm != null && wm.getConnectionInfo() != null) {
                int ipInt = wm.getConnectionInfo().getIpAddress();
                if (ipInt != 0) {
                    return String.format(
                            "%d.%d.%d.%d",
                            (ipInt & 0xff),
                            (ipInt >> 8 & 0xff),
                            (ipInt >> 16 & 0xff),
                            (ipInt >> 24 & 0xff)
                    );
                }
            }

            // Fallback: iterate network interfaces
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            for (NetworkInterface nif : Collections.list(interfaces)) {
                if (nif.isLoopback() || !nif.isUp()) continue;
                for (InetAddress addr : Collections.list(nif.getInetAddresses())) {
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error resolving IP", e);
        }
        return "127.0.0.1";
    }

    public void updatePlaybackState(String videoId, String title, boolean playing, int volume) {
        if (videoId != null && !videoId.isEmpty()) this.currentVideoId = videoId;
        if (title != null && !title.isEmpty()) this.currentTitle = title;
        this.isPlaying = playing;
        if (volume > 0) this.currentVolume = volume;
    }

    public List<QueueItem> getQueue() {
        return queue;
    }

    public String getQueueJson() {
        JSONArray arr = new JSONArray();
        for (QueueItem item : queue) {
            arr.put(item.toJson());
        }
        return arr.toString();
    }

    public synchronized QueueItem popNextQueuedVideo() {
        if (queue.isEmpty()) return null;
        return queue.remove(0);
    }

    public synchronized void clearQueue() {
        queue.clear();
    }

    public synchronized boolean removeQueueItem(String id) {
        if (id == null) return false;
        return queue.removeIf(item -> id.equals(item.id));
    }

    public synchronized QueueItem addVideoToQueue(String rawUrl, String action) {
        String videoId = extractYouTubeVideoId(rawUrl);
        if (videoId == null) return null;

        QueueItem item = new QueueItem(null, videoId, "YouTube Video (" + videoId + ")");
        fetchVideoTitleAsync(item);

        if ("play_now".equalsIgnoreCase(action)) {
            mainHandler.post(() -> {
                if (listener != null) listener.onPlayNow(item.videoId, item.title);
            });
        } else if ("play_next".equalsIgnoreCase(action)) {
            queue.add(0, item);
        } else {
            queue.add(item);
        }
        return item;
    }

    private void fetchVideoTitleAsync(QueueItem item) {
        executor.execute(() -> {
            try {
                URL u = new URL("https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=" + item.videoId + "&format=json");
                HttpURLConnection conn = (HttpURLConnection) u.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(3000);
                conn.setReadTimeout(3000);
                if (conn.getResponseCode() == 200) {
                    try (BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                        StringBuilder sb = new StringBuilder();
                        String line;
                        while ((line = r.readLine()) != null) sb.append(line);
                        JSONObject json = new JSONObject(sb.toString());
                        if (json.has("title")) {
                            item.title = json.getString("title");
                        }
                    }
                }
                conn.disconnect();
            } catch (Exception ignored) {}
        });
    }

    public static String extractYouTubeVideoId(String input) {
        if (input == null || input.trim().isEmpty()) return null;
        String s = input.trim();

        // 1. Raw 11-char ID
        if (Pattern.matches("^[a-zA-Z0-9_-]{11}$", s)) {
            return s;
        }

        // 2. youtu.be/<id>
        Pattern p1 = Pattern.compile("(?:youtu\\.be/|youtube\\.com/(?:embed/|v/|shorts/|watch\\?v=|watch\\?.+&v=))([a-zA-Z0-9_-]{11})");
        Matcher m1 = p1.matcher(s);
        if (m1.find()) {
            return m1.group(1);
        }
        return null;
    }

    private void handleClient(Socket socket) {
        try (InputStream in = socket.getInputStream();
             OutputStream out = socket.getOutputStream()) {

            BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            String requestLine = reader.readLine();
            if (requestLine == null) return;

            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;

            String method = parts[0].toUpperCase();
            String fullPath = parts[1];

            // Read headers
            String line;
            int contentLength = 0;
            String authHeader = "";
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                String lower = line.toLowerCase();
                if (lower.startsWith("content-length:")) {
                    try {
                        contentLength = Integer.parseInt(line.substring(15).trim());
                    } catch (Exception ignored) {}
                } else if (lower.startsWith("authorization:")) {
                    authHeader = line.substring(14).trim();
                } else if (lower.startsWith("x-gcmv-pin:")) {
                    authHeader = line.substring(11).trim();
                }
            }

            // Read body if present
            String body = "";
            if (contentLength > 0 && contentLength < 1024 * 1024) {
                char[] buf = new char[contentLength];
                int read = 0;
                while (read < contentLength) {
                    int r = reader.read(buf, read, contentLength - read);
                    if (r == -1) break;
                    read += r;
                }
                body = new String(buf, 0, read);
            }

            // Parse path and query
            String path = fullPath;
            String query = "";
            int qIdx = fullPath.indexOf('?');
            if (qIdx != -1) {
                path = fullPath.substring(0, qIdx);
                query = fullPath.substring(qIdx + 1);
            }

            // Check PIN requirement from shared preferences
            android.content.SharedPreferences sp = context.getSharedPreferences("gacha_prefs", Context.MODE_PRIVATE);
            boolean pinRequired = sp.getBoolean("remotePinEnabled", false);
            String configuredPin = sp.getString("remotePin", "1234").trim();

            // Options preflight
            if ("OPTIONS".equals(method)) {
                sendResponse(out, 204, "text/plain", "");
                return;
            }

            // API: Check Auth / Status
            if ("/api/status".equals(path)) {
                JSONObject res = new JSONObject();
                res.put("status", "ok");
                res.put("pinRequired", pinRequired);
                res.put("currentVideo", new JSONObject()
                        .put("videoId", currentVideoId)
                        .put("title", currentTitle)
                        .put("isPlaying", isPlaying)
                        .put("volume", currentVolume));
                res.put("queue", new JSONArray(getQueueJson()));
                sendResponse(out, 200, "application/json", res.toString());
                return;
            }

            if ("/api/auth".equals(path) && "POST".equals(method)) {
                JSONObject json = new JSONObject(body.isEmpty() ? "{}" : body);
                String clientPin = json.optString("pin", "").trim();
                boolean valid = !pinRequired || configuredPin.equals(clientPin);
                JSONObject res = new JSONObject();
                res.put("success", valid);
                res.put("pinRequired", pinRequired);
                sendResponse(out, valid ? 200 : 401, "application/json", res.toString());
                return;
            }

            // Protected API calls: check PIN if enabled
            if (pinRequired && path.startsWith("/api/")) {
                boolean authorized = false;
                if (!authHeader.isEmpty()) {
                    String supplied = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : authHeader;
                    if (configuredPin.equals(supplied.trim())) authorized = true;
                }
                if (!authorized && !body.isEmpty()) {
                    try {
                        JSONObject bJson = new JSONObject(body);
                        if (configuredPin.equals(bJson.optString("pin", "").trim())) authorized = true;
                    } catch (Exception ignored) {}
                }
                if (!authorized) {
                    sendResponse(out, 401, "application/json", "{\"error\":\"PIN required\"}");
                    return;
                }
            }

            // API: Add to Queue
            if ("/api/queue".equals(path) && "POST".equals(method)) {
                JSONObject json = new JSONObject(body.isEmpty() ? "{}" : body);
                String urlOrId = json.optString("url", "").trim();
                String action = json.optString("action", "add_queue").trim(); // play_now, play_next, add_queue

                if (urlOrId.isEmpty()) {
                    sendResponse(out, 400, "application/json", "{\"error\":\"Missing 'url' field\"}");
                    return;
                }

                QueueItem item = addVideoToQueue(urlOrId, action);
                if (item == null) {
                    sendResponse(out, 400, "application/json", "{\"error\":\"Could not extract valid YouTube video ID\"}");
                    return;
                }

                JSONObject res = new JSONObject();
                res.put("success", true);
                res.put("item", item.toJson());
                res.put("action", action);
                res.put("queue", new JSONArray(getQueueJson()));
                sendResponse(out, 200, "application/json", res.toString());
                return;
            }

            // API: Remove or Clear Queue
            if ("/api/queue".equals(path) && "DELETE".equals(method)) {
                String idToRemove = null;
                if (!query.isEmpty()) {
                    for (String param : query.split("&")) {
                        String[] pair = param.split("=");
                        if (pair.length == 2 && "id".equals(pair[0])) {
                            idToRemove = URLDecoder.decode(pair[1], "UTF-8");
                        }
                    }
                }
                if (idToRemove != null && !idToRemove.isEmpty()) {
                    removeQueueItem(idToRemove);
                } else {
                    clearQueue();
                }
                JSONObject res = new JSONObject();
                res.put("success", true);
                res.put("queue", new JSONArray(getQueueJson()));
                sendResponse(out, 200, "application/json", res.toString());
                return;
            }

            // API: Playback Control
            if ("/api/control".equals(path) && "POST".equals(method)) {
                JSONObject json = new JSONObject(body.isEmpty() ? "{}" : body);
                String action = json.optString("action", "").trim(); // play, pause, next, volume
                Object val = json.opt("value");

                if ("next".equals(action)) {
                    QueueItem next = popNextQueuedVideo();
                    if (next != null) {
                        mainHandler.post(() -> {
                            if (listener != null) listener.onPlayNow(next.videoId, next.title);
                        });
                    } else {
                        mainHandler.post(() -> {
                            if (listener != null) listener.onControlAction("next", null);
                        });
                    }
                } else {
                    mainHandler.post(() -> {
                        if (listener != null) listener.onControlAction(action, val);
                    });
                }

                JSONObject res = new JSONObject();
                res.put("success", true);
                res.put("action", action);
                sendResponse(out, 200, "application/json", res.toString());
                return;
            }

            // HTML Web Remote UI
            if ("/".equals(path) || "/remote".equals(path)) {
                sendResponse(out, 200, "text/html; charset=UTF-8", getWebRemoteHtml(pinRequired));
                return;
            }

            sendResponse(out, 404, "text/plain", "Not Found");
        } catch (Exception e) {
            Log.e(TAG, "Error handling remote client", e);
        }
    }

    private void sendResponse(OutputStream out, int statusCode, String contentType, String content) {
        try {
            byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
            String header = "HTTP/1.1 " + statusCode + " " + getStatusText(statusCode) + "\r\n" +
                    "Content-Type: " + contentType + "\r\n" +
                    "Content-Length: " + bytes.length + "\r\n" +
                    "Access-Control-Allow-Origin: *\r\n" +
                    "Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n" +
                    "Access-Control-Allow-Headers: Content-Type, Authorization, X-GCMV-PIN\r\n" +
                    "Connection: close\r\n\r\n";
            out.write(header.getBytes(StandardCharsets.UTF_8));
            out.write(bytes);
            out.flush();
        } catch (Exception ignored) {}
    }

    private String getStatusText(int code) {
        switch (code) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 404: return "Not Found";
            default: return "Response";
        }
    }

    private String getWebRemoteHtml(boolean pinRequired) {
        return "<!DOCTYPE html>\n" +
                "<html lang=\"en\">\n" +
                "<head>\n" +
                "  <meta charset=\"UTF-8\">\n" +
                "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no\">\n" +
                "  <title>🌸 Gacha MV Remote</title>\n" +
                "  <style>\n" +
                "    :root {\n" +
                "      --bg: #0d0a1a;\n" +
                "      --card-bg: #16122a;\n" +
                "      --card-border: rgba(255, 46, 147, 0.25);\n" +
                "      --pink: #ff2e93;\n" +
                "      --cyan: #00e5ff;\n" +
                "      --green: #00ffaa;\n" +
                "      --text: #ffffff;\n" +
                "      --subtext: #a09bb8;\n" +
                "    }\n" +
                "    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }\n" +
                "    body { background: var(--bg); color: var(--text); padding: 14px; min-height: 100vh; }\n" +
                "    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid var(--card-border); }\n" +
                "    h1 { font-size: 19px; color: var(--text); font-weight: 800; display: flex; align-items: center; gap: 6px; }\n" +
                "    .badge { font-size: 11px; background: rgba(0,255,170,0.15); color: var(--green); border: 1px solid var(--green); border-radius: 12px; padding: 3px 8px; font-weight: 700; }\n" +
                "    .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; padding: 16px; margin-bottom: 14px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }\n" +
                "    .card-title { font-size: 13px; font-weight: 700; color: var(--cyan); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }\n" +
                "    .now-playing-title { font-size: 15px; font-weight: 700; color: var(--text); line-height: 1.3; margin-bottom: 12px; word-break: break-word; }\n" +
                "    .ctrl-row { display: flex; gap: 10px; margin-top: 10px; }\n" +
                "    .btn-ctrl { flex: 1; height: 46px; border: none; border-radius: 12px; background: rgba(255,255,255,0.08); color: #fff; font-size: 16px; font-weight: 700; cursor: pointer; transition: all 0.15s; display: flex; align-items: center; justify-content: center; gap: 6px; }\n" +
                "    .btn-ctrl:active { transform: scale(0.96); background: rgba(255,255,255,0.18); }\n" +
                "    .btn-primary { background: linear-gradient(135deg, var(--pink), #8f00ff); color: #fff; }\n" +
                "    .btn-accent { background: rgba(0, 229, 255, 0.2); border: 1px solid var(--cyan); color: var(--cyan); }\n" +
                "    .input-box { width: 100%; height: 46px; background: #211a3e; border: 1px solid rgba(255,255,255,0.15); border-radius: 12px; padding: 0 14px; color: #fff; font-size: 14px; margin-bottom: 10px; outline: none; }\n" +
                "    .input-box:focus { border-color: var(--pink); box-shadow: 0 0 10px rgba(255,46,147,0.3); }\n" +
                "    .btn-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }\n" +
                "    .btn-act { height: 42px; border: none; border-radius: 10px; font-size: 12px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px; transition: all 0.15s; }\n" +
                "    .btn-act:active { transform: scale(0.96); }\n" +
                "    .btn-now { background: var(--pink); color: #fff; }\n" +
                "    .btn-next { background: #6b21a8; color: #fff; border: 1px solid #a855f7; }\n" +
                "    .btn-queue { background: rgba(0,229,255,0.15); color: var(--cyan); border: 1px solid var(--cyan); }\n" +
                "    .queue-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }\n" +
                "    .queue-num { font-size: 12px; font-weight: 800; color: var(--cyan); margin-right: 10px; min-width: 18px; }\n" +
                "    .queue-title { font-size: 13px; font-weight: 600; color: #eee; flex: 1; word-break: break-word; }\n" +
                "    .queue-del { background: none; border: none; color: #ff4444; font-size: 16px; padding: 6px; cursor: pointer; }\n" +
                "    .queue-empty { color: var(--subtext); font-size: 13px; font-style: italic; text-align: center; padding: 18px 0; }\n" +
                "    .vol-wrap { display: flex; align-items: center; gap: 10px; margin-top: 14px; }\n" +
                "    .vol-slider { flex: 1; accent-color: var(--pink); }\n" +
                "    .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #2e1b4e; border: 1px solid var(--pink); color: #fff; padding: 10px 18px; border-radius: 20px; font-size: 13px; font-weight: 700; box-shadow: 0 4px 15px rgba(0,0,0,0.5); opacity: 0; pointer-events: none; transition: opacity 0.25s ease; z-index: 100; }\n" +
                "    .toast.show { opacity: 1; }\n" +
                "    /* PIN Modal */\n" +
                "    .pin-overlay { position: fixed; inset: 0; background: rgba(13,10,26,0.95); display: flex; align-items: center; justify-content: center; z-index: 200; padding: 20px; }\n" +
                "    .pin-card { background: var(--card-bg); border: 1px solid var(--pink); border-radius: 20px; padding: 24px; width: 100%; max-width: 320px; text-align: center; }\n" +
                "    .pin-input { width: 100%; height: 50px; font-size: 24px; text-align: center; letter-spacing: 8px; background: #211a3e; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; color: #fff; margin: 16px 0; outline: none; }\n" +
                "    .pin-btn { width: 100%; height: 46px; background: var(--pink); color: #fff; border: none; border-radius: 12px; font-size: 15px; font-weight: 700; cursor: pointer; }\n" +
                "  </style>\n" +
                "</head>\n" +
                "<body>\n" +
                "  <header>\n" +
                "    <h1>🌸 Gacha MV Remote</h1>\n" +
                "    <span class=\"badge\" id=\"connBadge\">● CONNECTED</span>\n" +
                "  </header>\n" +
                "\n" +
                "  <!-- Now Playing -->\n" +
                "  <div class=\"card\">\n" +
                "    <div class=\"card-title\">🎵 Now Playing on Player</div>\n" +
                "    <div class=\"now-playing-title\" id=\"nowPlayingTitle\">Loading...</div>\n" +
                "    <div class=\"ctrl-row\">\n" +
                "      <button class=\"btn-ctrl btn-primary\" id=\"btnPlayPause\">⏸️ Pause</button>\n" +
                "      <button class=\"btn-ctrl btn-accent\" id=\"btnSkipNext\">⏭️ Skip</button>\n" +
                "    </div>\n" +
                "    <div class=\"vol-wrap\">\n" +
                "      <span style=\"font-size:13px; font-weight:700;\">🔊 Volume:</span>\n" +
                "      <input type=\"range\" id=\"sliderVol\" class=\"vol-slider\" min=\"0\" max=\"200\" value=\"100\">\n" +
                "      <span id=\"volVal\" style=\"font-size:12px; color:var(--cyan); min-width:40px;\">100%</span>\n" +
                "    </div>\n" +
                "  </div>\n" +
                "\n" +
                "  <!-- Add Video to Queue -->\n" +
                "  <div class=\"card\">\n" +
                "    <div class=\"card-title\">➕ Add Video from Phone</div>\n" +
                "    <input type=\"text\" id=\"inputUrl\" class=\"input-box\" placeholder=\"Paste YouTube link or Video ID...\">\n" +
                "    <div class=\"btn-grid\">\n" +
                "      <button class=\"btn-act btn-now\" id=\"btnPlayNow\">▶️ Play Now</button>\n" +
                "      <button class=\"btn-act btn-next\" id=\"btnPlayNext\">⏭️ Play Next</button>\n" +
                "      <button class=\"btn-act btn-queue\" id=\"btnAddQueue\">➕ Add Queue</button>\n" +
                "    </div>\n" +
                "  </div>\n" +
                "\n" +
                "  <!-- Active Queue -->\n" +
                "  <div class=\"card\">\n" +
                "    <div style=\"display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;\">\n" +
                "      <div class=\"card-title\" style=\"margin-bottom:0;\">📋 Active Queue (<span id=\"queueCount\">0</span>)</div>\n" +
                "      <button id=\"btnClearQueue\" style=\"background:none; border:none; color:var(--pink); font-size:12px; font-weight:700; cursor:pointer;\">Clear All</button>\n" +
                "    </div>\n" +
                "    <div id=\"queueList\"></div>\n" +
                "  </div>\n" +
                "\n" +
                "  <div id=\"toast\" class=\"toast\"></div>\n" +
                "\n" +
                (pinRequired ?
                "  <div id=\"pinOverlay\" class=\"pin-overlay\">\n" +
                "    <div class=\"pin-card\">\n" +
                "      <h2 style=\"font-size:18px; margin-bottom:6px;\">🔒 Remote PIN Required</h2>\n" +
                "      <p style=\"font-size:12px; color:var(--subtext);\">Enter the 4-digit PIN configured in Player Settings</p>\n" +
                "      <input type=\"password\" id=\"pinInput\" class=\"pin-input\" maxlength=\"8\" placeholder=\"••••\" autofocus>\n" +
                "      <button id=\"btnSubmitPin\" class=\"pin-btn\">Unlock Remote</button>\n" +
                "    </div>\n" +
                "  </div>\n" : "") +
                "\n" +
                "  <script>\n" +
                "    let currentPin = localStorage.getItem('gcmv_remote_pin') || '';\n" +
                "    let isPlaying = false;\n" +
                "\n" +
                "    function showToast(msg) {\n" +
                "      const t = document.getElementById('toast');\n" +
                "      t.textContent = msg;\n" +
                "      t.classList.add('show');\n" +
                "      setTimeout(() => t.classList.remove('show'), 2600);\n" +
                "    }\n" +
                "\n" +
                "    async function api(path, opts = {}) {\n" +
                "      opts.headers = opts.headers || {};\n" +
                "      if (currentPin) opts.headers['X-GCMV-PIN'] = currentPin;\n" +
                "      try {\n" +
                "        const r = await fetch(path, opts);\n" +
                "        if (r.status === 401) {\n" +
                "          const po = document.getElementById('pinOverlay');\n" +
                "          if (po) po.style.display = 'flex';\n" +
                "        }\n" +
                "        return await r.json();\n" +
                "      } catch (e) { return null; }\n" +
                "    }\n" +
                "\n" +
                "    async function refreshStatus() {\n" +
                "      const data = await api('/api/status');\n" +
                "      if (!data) return;\n" +
                "      if (data.currentVideo) {\n" +
                "        document.getElementById('nowPlayingTitle').textContent = data.currentVideo.title || 'Playing video';\n" +
                "        isPlaying = data.currentVideo.isPlaying;\n" +
                "        document.getElementById('btnPlayPause').textContent = isPlaying ? '⏸️ Pause' : '▶️ Play';\n" +
                "      }\n" +
                "      const queue = data.queue || [];\n" +
                "      document.getElementById('queueCount').textContent = queue.length;\n" +
                "      const qList = document.getElementById('queueList');\n" +
                "      if (queue.length === 0) {\n" +
                "        qList.innerHTML = '<div class=\"queue-empty\">Queue is empty. Add a video above!</div>';\n" +
                "      } else {\n" +
                "        qList.innerHTML = queue.map((item, idx) => `\n" +
                "          <div class=\"queue-item\">\n" +
                "            <span class=\"queue-num\">${idx + 1}</span>\n" +
                "            <span class=\"queue-title\">${item.title || item.videoId}</span>\n" +
                "            <button class=\"queue-del\" onclick=\"deleteQueueItem('${item.id}')\">🗑️</button>\n" +
                "          </div>\n" +
                "        `).join('');\n" +
                "      }\n" +
                "    }\n" +
                "\n" +
                "    async function addVideo(action) {\n" +
                "      const input = document.getElementById('inputUrl');\n" +
                "      const val = input.value.trim();\n" +
                "      if (!val) return showToast('⚠️ Enter a YouTube URL or Video ID');\n" +
                "      const res = await api('/api/queue', {\n" +
                "        method: 'POST',\n" +
                "        headers: { 'Content-Type': 'application/json' },\n" +
                "        body: JSON.stringify({ url: val, action: action, pin: currentPin })\n" +
                "      });\n" +
                "      if (res && res.success) {\n" +
                "        input.value = '';\n" +
                "        const actLabel = action === 'play_now' ? '▶️ Playing now!' : action === 'play_next' ? '⏭️ Queued to play next!' : '➕ Added to queue!';\n" +
                "        showToast(actLabel);\n" +
                "        refreshStatus();\n" +
                "      } else {\n" +
                "        showToast('❌ ' + (res?.error || 'Failed to add video'));\n" +
                "      }\n" +
                "    }\n" +
                "\n" +
                "    window.deleteQueueItem = async function(id) {\n" +
                "      await api('/api/queue?id=' + encodeURIComponent(id), { method: 'DELETE' });\n" +
                "      refreshStatus();\n" +
                "    };\n" +
                "\n" +
                "    document.getElementById('btnPlayNow').addEventListener('click', () => addVideo('play_now'));\n" +
                "    document.getElementById('btnPlayNext').addEventListener('click', () => addVideo('play_next'));\n" +
                "    document.getElementById('btnAddQueue').addEventListener('click', () => addVideo('add_queue'));\n" +
                "\n" +
                "    document.getElementById('btnPlayPause').addEventListener('click', async () => {\n" +
                "      await api('/api/control', {\n" +
                "        method: 'POST',\n" +
                "        headers: { 'Content-Type': 'application/json' },\n" +
                "        body: JSON.stringify({ action: isPlaying ? 'pause' : 'play' })\n" +
                "      });\n" +
                "      isPlaying = !isPlaying;\n" +
                "      document.getElementById('btnPlayPause').textContent = isPlaying ? '⏸️ Pause' : '▶️ Play';\n" +
                "    });\n" +
                "\n" +
                "    document.getElementById('btnSkipNext').addEventListener('click', async () => {\n" +
                "      await api('/api/control', {\n" +
                "        method: 'POST',\n" +
                "        headers: { 'Content-Type': 'application/json' },\n" +
                "        body: JSON.stringify({ action: 'next' })\n" +
                "      });\n" +
                "      showToast('⏭️ Skipped!');\n" +
                "      setTimeout(refreshStatus, 600);\n" +
                "    });\n" +
                "\n" +
                "    document.getElementById('btnClearQueue').addEventListener('click', async () => {\n" +
                "      if (!confirm('Clear all queued songs?')) return;\n" +
                "      await api('/api/queue', { method: 'DELETE' });\n" +
                "      refreshStatus();\n" +
                "    });\n" +
                "\n" +
                "    const slider = document.getElementById('sliderVol');\n" +
                "    slider.addEventListener('input', (e) => {\n" +
                "      document.getElementById('volVal').textContent = e.target.value + '%';\n" +
                "    });\n" +
                "    slider.addEventListener('change', async (e) => {\n" +
                "      await api('/api/control', {\n" +
                "        method: 'POST',\n" +
                "        headers: { 'Content-Type': 'application/json' },\n" +
                "        body: JSON.stringify({ action: 'volume', value: parseInt(e.target.value, 10) })\n" +
                "      });\n" +
                "    });\n" +
                "\n" +
                "    const btnPin = document.getElementById('btnSubmitPin');\n" +
                "    if (btnPin) {\n" +
                "      btnPin.addEventListener('click', async () => {\n" +
                "        const pinVal = document.getElementById('pinInput').value.trim();\n" +
                "        const res = await api('/api/auth', {\n" +
                "          method: 'POST',\n" +
                "          headers: { 'Content-Type': 'application/json' },\n" +
                "          body: JSON.stringify({ pin: pinVal })\n" +
                "        });\n" +
                "        if (res && res.success) {\n" +
                "          currentPin = pinVal;\n" +
                "          localStorage.setItem('gcmv_remote_pin', pinVal);\n" +
                "          document.getElementById('pinOverlay').style.display = 'none';\n" +
                "          refreshStatus();\n" +
                "        } else {\n" +
                "          alert('❌ Incorrect PIN');\n" +
                "        }\n" +
                "      });\n" +
                "    }\n" +
                "\n" +
                "    refreshStatus();\n" +
                "    setInterval(refreshStatus, 2500);\n" +
                "  </script>\n" +
                "</body>\n" +
                "</html>";
    }
}
