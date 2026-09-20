/**
 * Gacha MV Player - Universal Background Service Worker & Script
 * Proxies HTTP requests to private local LAN / Tailscale NAS servers to avoid
 * browser Mixed Content restrictions on HTTPS YouTube pages.
 * Also acts as the 24/7 Cloud Remote Host (Paho MQTT over WebSocket) so phone
 * remotes can pair via Room Code with zero scripts on PC.
 */

if (typeof importScripts === "function" && typeof Paho === "undefined") {
  try {
    importScripts("paho-mqtt-min.js");
  } catch (e) {
    console.warn("[GCMV] Could not import paho-mqtt in background:", e);
  }
}

const extensionApi = typeof browser !== "undefined" ? browser : chrome;
const runtime = extensionApi.runtime;

let cloudMqttClient = null;
let activeRoomCode = "";
let cachedPlayerState = {
  currentVideo: null,
  isPlaying: false,
  volume: 100,
  queue: []
};

function getLocalStorage(defaults) {
  try {
    const result = extensionApi.storage.local.get(defaults);
    if (result && typeof result.then === "function") return result;
  } catch (_) {}

  return new Promise((resolve, reject) => {
    extensionApi.storage.local.get(defaults, (value) => {
      const lastError = extensionApi.runtime && extensionApi.runtime.lastError;
      if (lastError) reject(new Error(lastError.message));
      else resolve(value);
    });
  });
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let res = "GCMV-";
  for (let i = 0; i < 4; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res;
}

function broadcastCloudState() {
  if (!cloudMqttClient || !cloudMqttClient.isConnected()) return;
  const cleanCode = activeRoomCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const stateTopic = `gcmv/room/${cleanCode}/state`;

  try {
    const PahoLib = typeof Paho !== "undefined" ? Paho : (typeof window !== "undefined" ? window.Paho : null);
    if (!PahoLib || !PahoLib.MQTT) return;
    const msg = new PahoLib.MQTT.Message(JSON.stringify({
      type: "STATE",
      currentVideo: cachedPlayerState.currentVideo,
      isPlaying: cachedPlayerState.isPlaying,
      volume: cachedPlayerState.volume,
      queue: cachedPlayerState.queue
    }));
    msg.destinationName = stateTopic;
    msg.retained = true;
    cloudMqttClient.send(msg);
  } catch (e) {
    console.warn("[GCMV] Error broadcasting cloud state:", e);
  }
}

async function handleCloudRemoteCommand(cmd) {
  if (!cmd || !cmd.action) return;

  if (cmd.action === "get_state") {
    broadcastCloudState();
    return;
  }

  // Forward command to active or open YouTube tabs
  extensionApi.tabs.query({ url: ["*://*.youtube.com/*", "*://youtube.com/*", "*://m.youtube.com/*"] }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      if (cmd.videoId && (cmd.action === "play_now" || cmd.action === "play_next")) {
        extensionApi.tabs.create({ url: `https://www.youtube.com/watch?v=${cmd.videoId}` });
      }
      return;
    }

    const activeTab = tabs.find(t => t.active) || tabs[0];
    extensionApi.tabs.sendMessage(activeTab.id, { type: "GCMV_REMOTE_CMD", command: cmd }, () => {
      if (extensionApi.runtime.lastError) {
        tabs.forEach(t => {
          if (t.id !== activeTab.id) {
            extensionApi.tabs.sendMessage(t.id, { type: "GCMV_REMOTE_CMD", command: cmd }, () => {
              if (extensionApi.runtime.lastError) {}
            });
          }
        });
      }
    });
  });
}

async function initCloudRemoteHost() {
  const PahoLib = typeof Paho !== "undefined" ? Paho : (typeof window !== "undefined" ? window.Paho : null);
  if (!PahoLib || !PahoLib.MQTT || !PahoLib.MQTT.Client) {
    console.warn("[GCMV] Paho MQTT library not loaded, skipping Cloud Remote Host in background");
    return;
  }

  try {
    const stored = await getLocalStorage({ cloudRoomCode: "", cloudRemoteEnabled: true, cloudRemoteQueue: [] });
    if (stored.cloudRemoteEnabled === false) return;

    activeRoomCode = stored.cloudRoomCode || generateRoomCode();
    if (!stored.cloudRoomCode) {
      await extensionApi.storage.local.set({ cloudRoomCode: activeRoomCode });
    }
    if (Array.isArray(stored.cloudRemoteQueue)) {
      cachedPlayerState.queue = stored.cloudRemoteQueue;
    }

    const cleanCode = activeRoomCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const clientId = "gcmv-host-" + Math.random().toString(36).substring(2, 10);
    const cmdTopic = `gcmv/room/${cleanCode}/cmd`;

    if (cloudMqttClient) {
      try { cloudMqttClient.disconnect(); } catch (_) {}
      cloudMqttClient = null;
    }

    const client = new PahoLib.MQTT.Client("broker.hivemq.com", 8884, "/mqtt", clientId);

    client.onConnectionLost = (resp) => {
      console.warn("[GCMV] Background Cloud MQTT connection lost:", resp ? resp.errorMessage : "");
      setTimeout(() => { initCloudRemoteHost(); }, 5000);
    };

    client.onMessageArrived = (msg) => {
      try {
        const payload = JSON.parse(msg.payloadString);
        handleCloudRemoteCommand(payload);
      } catch (e) {
        console.warn("[GCMV] Invalid MQTT command payload:", e);
      }
    };

    client.connect({
      useSSL: true,
      timeout: 8,
      keepAliveInterval: 30,
      cleanSession: true,
      onSuccess: () => {
        console.log(`[GCMV] 🌸 Cloud Remote Host online in background! Room: ${cleanCode}`);
        cloudMqttClient = client;
        client.subscribe(cmdTopic, {
          onSuccess: () => {
            console.log(`[GCMV] Subscribed to ${cmdTopic}`);
            broadcastCloudState();
          },
          onFailure: (err) => {
            console.warn("[GCMV] Failed to subscribe to cmdTopic:", err);
          }
        });
      },
      onFailure: (err) => {
        console.warn("[GCMV] Failed to connect to HiveMQ, retrying in 8s:", err ? err.errorMessage : "");
        setTimeout(() => { initCloudRemoteHost(); }, 8000);
      }
    });
  } catch (e) {
    console.warn("[GCMV] Error initializing Cloud Remote Host in background:", e);
  }
}

// Start Cloud Remote Host on background startup
initCloudRemoteHost();

function isAllowedApiPath(pathname) {
  return ["/", "/health", "/api/status", "/api/skipSegments", "/skipSegments", "/api/database"].includes(pathname);
}

runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return undefined;

  // Cloud Remote State & Control Messages
  if (msg.type === "GCMV_PLAYER_STATE") {
    if (msg.state) {
      cachedPlayerState.currentVideo = {
        videoId: msg.state.videoId,
        title: msg.state.title,
        currentTime: msg.state.currentTime || 0,
        duration: msg.state.duration || 0
      };
      cachedPlayerState.isPlaying = Boolean(msg.state.isPlaying);
      if (typeof msg.state.volume === "number") {
        cachedPlayerState.volume = msg.state.volume;
      }
      if (Array.isArray(msg.state.queue)) {
        cachedPlayerState.queue = msg.state.queue;
      }
      broadcastCloudState();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "GCMV_SEARCH_RESULTS") {
    if (cloudMqttClient && cloudMqttClient.isConnected()) {
      const cleanCode = activeRoomCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const stateTopic = `gcmv/room/${cleanCode}/state`;
      try {
        const PahoLib = typeof Paho !== "undefined" ? Paho : (typeof window !== "undefined" ? window.Paho : null);
        const m = new PahoLib.MQTT.Message(JSON.stringify({
          type: "SEARCH_RESULTS",
          results: msg.results || []
        }));
        m.destinationName = stateTopic;
        cloudMqttClient.send(m);
      } catch (_) {}
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "GCMV_ROOM_CODE_CHANGED") {
    if (msg.roomCode && msg.roomCode !== activeRoomCode) {
      activeRoomCode = msg.roomCode;
      initCloudRemoteHost();
    }
    sendResponse({ ok: true });
    return true;
  }

  // NAS Proxy
  if (msg.type === "FETCH_NAS") {
    const { url, method = "GET", body = null } = msg;

    (async () => {
      try {
        if (!sender || sender.id !== runtime.id) {
          throw new Error("Untrusted extension message sender");
        }

        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          throw new Error("Only HTTP and HTTPS server URLs are supported");
        }

        const normalizedMethod = String(method).toUpperCase();
        if (!["GET", "POST", "DELETE"].includes(normalizedMethod)) {
          throw new Error("Unsupported NAS request method");
        }

        const stored = await getLocalStorage({ nasServerUrl: "", nasAuthToken: "" });
        if (!stored.nasServerUrl) throw new Error("NAS server is not configured");

        const configuredUrl = new URL(stored.nasServerUrl);
        if (parsedUrl.origin !== configuredUrl.origin || !isAllowedApiPath(parsedUrl.pathname)) {
          throw new Error("Request is outside the configured NAS server API");
        }

        const reqHeaders = {};
        let reqBody = body;
        if (stored.nasAuthToken) {
          reqHeaders.Authorization = `Bearer ${stored.nasAuthToken}`;
        }
        if (body && typeof body === "object") {
          reqHeaders["Content-Type"] = "application/json";
          reqBody = JSON.stringify(body);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        let res;
        try {
          res = await fetch(parsedUrl.href, {
            method: normalizedMethod,
            headers: reqHeaders,
            body: normalizedMethod !== "GET" ? reqBody : null,
            cache: "no-store",
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeoutId);
        }

        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }

        const responsePayload = {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          data: data
        };

        sendResponse(responsePayload);
      } catch (err) {
        const errorPayload = {
          ok: false,
          status: 0,
          error: err.message || "Network request failed",
          data: null
        };

        sendResponse(errorPayload);
      }
    })();

    return true;
  }

  return undefined;
});
