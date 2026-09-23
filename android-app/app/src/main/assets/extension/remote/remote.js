    let mqttClient = null;
    let peer = null;
    let peerConn = null;
    let activeRoomCode = "";
    let isPlaying = false;
    let isConnected = false;
    let reconnectTimeout = null;
    let currentPin = localStorage.getItem("gcmv_remote_pin") || "";
    let hostRequiresPin = false;
    let pinAuthenticated = false;

    function showToast(msg) {
      const t = document.getElementById("toast");
      t.textContent = msg;
      t.classList.add("show");
      setTimeout(() => t.classList.remove("show"), 2500);
    }

    function setConnectionBadge(state, text) {
      const b = document.getElementById("connBadge");
      b.className = "badge " + (state === "connected" ? "badge-connected" : state === "connecting" ? "badge-connecting" : "badge-disconnected");
      b.textContent = (state === "connected" ? "● " : state === "connecting" ? "◌ " : "○ ") + text;
    }

    function sanitizeRoomCode(raw) {
      return (raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    }

    function formatTime(sec) {
      const s = Math.floor(sec || 0);
      const m = Math.floor(s / 60);
      const rem = s % 60;
      return `${m}:${rem < 10 ? '0' : ''}${rem}`;
    }

    const MQTT_BROKERS = [
      { name: "EMQX", host: "broker.emqx.io", port: 8084, path: "/mqtt", ssl: true },
      { name: "HiveMQ", host: "broker.hivemq.com", port: 8884, path: "/mqtt", ssl: true }
    ];

    let currentBrokerIndex = 0;
    let activeBrokerName = "";

    function onSuccessfulConnection(cleanCode, brokerName) {
      isConnected = true;
      const via = brokerName ? ` (${brokerName})` : "";
      setConnectionBadge("connected", `ROOM ${cleanCode}${via}`);
      document.getElementById("mainControlsView").classList.remove("hidden");
      document.getElementById("activeRoomTag").textContent = `Room: ${cleanCode}`;
      document.getElementById("inputRoomCode").value = cleanCode;
      const hintEl = document.getElementById("roomHint");
      if (hintEl) {
        hintEl.replaceChildren();
        const s = document.createElement("span");
        s.style.cssText = "color:#00ffaa; font-weight:700;";
        s.textContent = `● Connected to Room ${cleanCode}${via}!`;
        hintEl.appendChild(s);
      }
      showToast(`🟢 Connected to Room ${cleanCode}!`);
      if (currentPin) {
        sendCommand({ action: "auth_pin", pin: currentPin });
      }
    }

    // Commands can land in a gap where the player's connection to the broker
    // has dropped and not yet reconnected. Track each command until the
    // player echoes its cmdId back in a STATE update, and resend it a few
    // times if that ack never shows up.
    let pendingCommands = {};
    const CMD_RETRY_MS = 3500;
    const CMD_MAX_ATTEMPTS = 6;

    function transmitCommand(cmd) {
      let sent = false;

      // 1. Send via MQTT WebSocket
      if (mqttClient && mqttClient.isConnected()) {
        try {
          const PahoLib = typeof Paho !== "undefined" ? Paho : (typeof window !== "undefined" ? window.Paho : null);
          const msg = new PahoLib.MQTT.Message(JSON.stringify(cmd));
          msg.destinationName = `gcmv/room/${activeRoomCode}/cmd`;
          mqttClient.send(msg);
          sent = true;
        } catch (e) {
          console.warn("[GCMV Remote] MQTT send error:", e);
        }
      }

      // 2. Also send via PeerJS if open
      if (peerConn && peerConn.open) {
        try {
          peerConn.send(cmd);
          sent = true;
        } catch (_) {}
      }

      return sent;
    }

    function scheduleCommandRetry(cmd) {
      const entry = pendingCommands[cmd.cmdId];
      if (!entry) return;
      entry.timer = setTimeout(() => {
        const pending = pendingCommands[cmd.cmdId];
        if (!pending) return; // already acknowledged
        if (pending.attempts >= CMD_MAX_ATTEMPTS) {
          delete pendingCommands[cmd.cmdId];
          showToast("⚠️ Player isn't responding — check its connection");
          return;
        }
        pending.attempts++;
        console.warn(`[GCMV Remote] No ack for ${cmd.action}, retrying (attempt ${pending.attempts})`);
        transmitCommand(cmd);
        scheduleCommandRetry(cmd);
      }, CMD_RETRY_MS);
    }

    function ackCommand(ackId) {
      if (!ackId) return;
      const pending = pendingCommands[ackId];
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        delete pendingCommands[ackId];
      }
    }

    function sendCommand(cmd) {
      if (!cmd) return;
      if (!cmd.cmdId) {
        cmd.cmdId = "c_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
      }
      if (currentPin) {
        cmd.pin = currentPin;
      }

      const sent = transmitCommand(cmd);

      if (!pendingCommands[cmd.cmdId]) {
        pendingCommands[cmd.cmdId] = { attempts: 0, timer: null };
        scheduleCommandRetry(cmd);
      }

      if (!sent && !isConnected) {
        showToast("⚠️ Not connected to player. Reconnecting...");
        scheduleReconnect();
      }
    }

    function connectMqtt(cleanCode, brokerIdx = 0) {
      const PahoLib = typeof Paho !== "undefined" ? Paho : (typeof window !== "undefined" ? window.Paho : null);
      if (!PahoLib || !PahoLib.MQTT || !PahoLib.MQTT.Client) {
        console.warn("[GCMV Remote] Paho MQTT library not available");
        return;
      }

      if (mqttClient) {
        try { mqttClient.disconnect(); } catch (_) {}
        mqttClient = null;
      }

      currentBrokerIndex = brokerIdx;
      const broker = MQTT_BROKERS[currentBrokerIndex] || MQTT_BROKERS[0];
      const clientId = "gcmv-rm-" + Math.random().toString(36).substring(2, 10);
      const stateTopic = `gcmv/room/${cleanCode}/state`;
      const client = new PahoLib.MQTT.Client(broker.host, broker.port, broker.path, clientId);

      client.onConnectionLost = (resp) => {
        console.warn(`[GCMV Remote] MQTT (${broker.name}) connection lost:`, resp ? resp.errorMessage : "");
        if (!peerConn || !peerConn.open) {
          isConnected = false;
          setConnectionBadge("disconnected", "DISCONNECTED");
          scheduleReconnect();
        }
      };

      client.onMessageArrived = (msg) => {
        try {
          const data = JSON.parse(msg.payloadString);
          handleIncomingData(data);
        } catch (e) {
          console.warn("[GCMV Remote] MQTT payload parse error:", e);
        }
      };

      client.connect({
        useSSL: broker.ssl,
        timeout: 4,
        keepAliveInterval: 30,
        cleanSession: true,
        onSuccess: () => {
          console.log(`[GCMV Remote] 🌸 MQTT connected to room ${cleanCode} via ${broker.name}`);
          mqttClient = client;
          activeBrokerName = broker.name;
          client.subscribe(stateTopic, {
            onSuccess: () => {
              onSuccessfulConnection(cleanCode, broker.name);
              sendCommand({ action: "get_state" });
            },
            onFailure: (err) => {
              console.warn(`[GCMV Remote] Failed to subscribe to stateTopic on ${broker.name}:`, err);
            }
          });
        },
        onFailure: (err) => {
          console.warn(`[GCMV Remote] MQTT connection to ${broker.name} failed:`, err ? err.errorMessage : "");
          // Immediate failover to fallback broker
          if (currentBrokerIndex + 1 < MQTT_BROKERS.length) {
            console.log(`[GCMV Remote] Trying fallback broker: ${MQTT_BROKERS[currentBrokerIndex + 1].name}`);
            connectMqtt(cleanCode, currentBrokerIndex + 1);
          } else if (!isConnected) {
            scheduleReconnect();
          }
        }
      });
    }

    function connectPeerJs(cleanCode) {
      if (typeof Peer === "undefined") return;

      if (peer) {
        try { peer.destroy(); } catch (_) {}
      }

      try {
        peer = new Peer();

        peer.on("open", () => {
          const targetPeerId = `gcmv-${cleanCode.toLowerCase()}`;
          peerConn = peer.connect(targetPeerId, { reliable: true });

          peerConn.on("open", () => {
            onSuccessfulConnection(cleanCode, "P2P");
            peerConn.send({ action: "get_state" });
          });

          peerConn.on("data", (data) => {
            handleIncomingData(data);
          });

          peerConn.on("close", () => {
            if (!mqttClient || !mqttClient.isConnected()) {
              isConnected = false;
              setConnectionBadge("disconnected", "DISCONNECTED");
              scheduleReconnect();
            }
          });
        });

        peer.on("error", (err) => {
          console.warn("[GCMV Remote] Peer error:", err);
        });
      } catch (e) {
        console.warn("[GCMV Remote] PeerJS init error:", e);
      }
    }

    function connectToRoom(code) {
      const cleanCode = sanitizeRoomCode(code);
      if (!cleanCode) {
        showToast("⚠️ Enter a valid Room Code");
        return;
      }

      activeRoomCode = cleanCode;
      localStorage.setItem("gcmv_last_room", cleanCode);
      setConnectionBadge("connecting", "CONNECTING...");
      const hintEl = document.getElementById("roomHint");
      if (hintEl) {
        hintEl.replaceChildren();
        hintEl.append("Connecting to Room ");
        const st = document.createElement("strong");
        st.textContent = cleanCode;
        hintEl.append(st, "...");
      }

      // 1. Connect via fast & rock-solid MQTT WebSocket relay (EMQX primary ~0.2s, HiveMQ fallback)
      connectMqtt(cleanCode, 0);

      // 2. Also connect via WebRTC PeerJS in parallel
      connectPeerJs(cleanCode);
    }

    function scheduleReconnect() {
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      reconnectTimeout = setTimeout(() => {
        if (activeRoomCode && !isConnected) {
          connectToRoom(activeRoomCode);
        }
      }, 3000);
    }

    function handleIncomingData(data) {
      if (!data) return;

      if (data.type === "STATE") {
        ackCommand(data.ackId);
        if (data.pinRequired) {
          hostRequiresPin = true;
          if (!pinAuthenticated && !currentPin) {
            document.getElementById("pinOverlay").classList.remove("hidden");
          }
        } else {
          hostRequiresPin = false;
          pinAuthenticated = true;
          document.getElementById("pinOverlay").classList.add("hidden");
        }

        if (data.currentVideo) {
          document.getElementById("nowPlayingTitle").textContent = data.currentVideo.title || "Playing video";
          const cur = formatTime(data.currentVideo.currentTime);
          const dur = formatTime(data.currentVideo.duration);
          document.getElementById("playerTime").textContent = `${cur} / ${dur}`;
        }
        isPlaying = Boolean(data.isPlaying);
        document.getElementById("btnPlayPause").textContent = isPlaying ? "⏸️ Pause" : "▶️ Play";

        if (typeof data.volume === "number") {
          document.getElementById("sliderVol").value = data.volume;
          document.getElementById("volVal").textContent = `${Math.round(data.volume)}%`;
        }

        if (data.loopMode) {
          const selectLoop = document.getElementById("selectLoopMode");
          if (selectLoop && selectLoop.value !== data.loopMode) {
            selectLoop.value = data.loopMode;
          }
        }

        renderQueue(data.queue || []);
      } else if (data.type === "PIN_ERROR" || data.type === "AUTH_ERROR") {
        showToast("❌ Incorrect PIN. Please try again.");
        pinAuthenticated = false;
        document.getElementById("pinOverlay").classList.remove("hidden");
        const pInput = document.getElementById("pinInput");
        if (pInput) { pInput.value = ""; pInput.focus(); }
      } else if (data.type === "PIN_OK") {
        pinAuthenticated = true;
        document.getElementById("pinOverlay").classList.add("hidden");
        showToast("🔓 Remote unlocked!");
      } else if (data.type === "SEARCH_RESULTS") {
        renderSearchResults(data.results || []);
      } else if (data.type === "TOAST") {
        showToast(data.message || "");
      }
    }

    function renderQueue(queue) {
      document.getElementById("queueCount").textContent = queue.length;
      const qList = document.getElementById("queueList");
      qList.replaceChildren();
      if (!queue || queue.length === 0) {
        const emptyDiv = document.createElement("div");
        emptyDiv.className = "queue-empty";
        emptyDiv.textContent = "Queue is empty. Add a video above!";
        qList.appendChild(emptyDiv);
        return;
      }
      queue.forEach((item, idx) => {
        const div = document.createElement("div");
        div.className = "queue-item";
        const num = document.createElement("span");
        num.className = "queue-num";
        num.textContent = idx + 1;
        const title = document.createElement("span");
        title.className = "queue-title";
        title.textContent = item.title || item.videoId;
        const delBtn = document.createElement("button");
        delBtn.className = "queue-del";
        delBtn.title = "Remove";
        delBtn.textContent = "🗑️";
        delBtn.addEventListener("click", () => deleteQueueItem(item.id));
        div.append(num, title, delBtn);
        qList.appendChild(div);
      });
    }

    window.deleteQueueItem = function(id) {
      sendCommand({ action: "remove_queue", id: id });
    };

    function renderSearchResults(results) {
      const container = document.getElementById("searchResults");
      container.replaceChildren();
      if (!results || results.length === 0) {
        const noRes = document.createElement("div");
        noRes.style.cssText = "color:var(--subtext); text-align:center; padding:15px;";
        noRes.textContent = "No results found";
        container.appendChild(noRes);
        return;
      }
      window._lastSearchResults = results;
      results.forEach((item, idx) => {
        const itemDiv = document.createElement("div");
        itemDiv.className = "search-item";
        const row = document.createElement("div");
        row.className = "search-thumb-row";
        if (item.thumbnail) {
          const img = document.createElement("img");
          img.className = "search-thumb";
          img.src = item.thumbnail;
          img.alt = "";
          img.addEventListener("error", () => { img.style.display = "none"; });
          row.appendChild(img);
        }
        const meta = document.createElement("div");
        meta.className = "search-meta";
        const title = document.createElement("div");
        title.className = "search-title";
        title.textContent = item.title || "Video";
        const channel = document.createElement("div");
        channel.className = "search-channel";
        channel.textContent = item.channel || "";
        meta.append(title, channel);
        row.appendChild(meta);

        const btnGrid = document.createElement("div");
        btnGrid.className = "btn-grid";

        const btnNow = document.createElement("button");
        btnNow.className = "btn-act btn-now";
        btnNow.textContent = "▶️ Play Now";
        btnNow.addEventListener("click", () => actionSearchResult(item.videoId || item.id, idx, "play_now"));

        const btnNext = document.createElement("button");
        btnNext.className = "btn-act btn-next";
        btnNext.textContent = "⏭️ Play Next";
        btnNext.addEventListener("click", () => actionSearchResult(item.videoId || item.id, idx, "play_next"));

        const btnQueue = document.createElement("button");
        btnQueue.className = "btn-act btn-queue";
        btnQueue.textContent = "➕ Add Queue";
        btnQueue.addEventListener("click", () => actionSearchResult(item.videoId || item.id, idx, "add_queue"));

        btnGrid.append(btnNow, btnNext, btnQueue);
        itemDiv.append(row, btnGrid);
        container.appendChild(itemDiv);
      });
    }

    window.actionSearchResult = function(id, idx, action) {
      const item = (window._lastSearchResults && window._lastSearchResults[idx]) || { videoId: id, id: id };
      const targetId = item.videoId || item.id || id;
      sendCommand({
        action: action,
        videoId: targetId,
        title: item.title || "Video"
      });
      const actLabel = action === "play_now" ? "▶️ Playing now!" : action === "play_next" ? "⏭️ Queued next!" : "➕ Added to queue!";
      showToast(actLabel);
    };

    // UI Event Listeners
    const btnSubmitPin = document.getElementById("btnSubmitPin");
    if (btnSubmitPin) {
      btnSubmitPin.addEventListener("click", () => {
        const pin = (document.getElementById("pinInput").value || "").trim();
        if (!pin) return showToast("⚠️ Enter 4-digit PIN");
        currentPin = pin;
        localStorage.setItem("gcmv_remote_pin", pin);
        sendCommand({ action: "auth_pin", pin: currentPin });
      });
    }

    const pinInput = document.getElementById("pinInput");
    if (pinInput) {
      pinInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && btnSubmitPin) btnSubmitPin.click();
      });
    }

    document.getElementById("btnConnectRoom").addEventListener("click", () => {
      const code = document.getElementById("inputRoomCode").value;
      connectToRoom(code);
    });

    document.getElementById("inputRoomCode").addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("btnConnectRoom").click();
    });

    document.getElementById("btnPrevTrack").addEventListener("click", () => {
      sendCommand({ action: "prev" });
    });

    document.getElementById("btnPlayPause").addEventListener("click", () => {
      sendCommand({ action: isPlaying ? "pause" : "play" });
    });

    document.getElementById("btnSkipNext").addEventListener("click", () => {
      sendCommand({ action: "skip" });
    });

    document.getElementById("selectLoopMode").addEventListener("change", (e) => {
      sendCommand({ action: "set_loop", mode: e.target.value });
    });

    const sliderVol = document.getElementById("sliderVol");
    sliderVol.addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10);
      document.getElementById("volVal").textContent = `${val}%`;
      sendCommand({ action: "volume", value: val });
    });

    document.getElementById("btnSearch").addEventListener("click", () => {
      const q = document.getElementById("inputSearch").value.trim();
      if (!q) return showToast("⚠️ Enter a search query");
      const searchResEl = document.getElementById("searchResults");
      if (searchResEl) {
        searchResEl.replaceChildren();
        const searching = document.createElement("div");
        searching.style.cssText = "color:var(--subtext); text-align:center; padding:15px;";
        searching.textContent = "🔍 Searching...";
        searchResEl.appendChild(searching);
      }
      sendCommand({ action: "search", query: q });
    });

    document.getElementById("inputSearch").addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("btnSearch").click();
    });

    function addFromInput(action) {
      const input = document.getElementById("inputUrl");
      const val = input.value.trim();
      if (!val) return showToast("⚠️ Paste a YouTube URL or Video ID");

      let videoId = val;
      const m = val.match(/(?:v=|\/embed\/|youtu\.be\/|\/v\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
      if (m) videoId = m[1];

      sendCommand({ action: action, videoId: videoId, title: "" });
      input.value = "";
      showToast(action === "play_now" ? "▶️ Playing now!" : action === "play_next" ? "⏭️ Queued next!" : "➕ Added to queue!");
    }

    document.getElementById("btnPlayNow").addEventListener("click", () => addFromInput("play_now"));
    document.getElementById("btnPlayNext").addEventListener("click", () => addFromInput("play_next"));
    document.getElementById("btnAddQueue").addEventListener("click", () => addFromInput("add_queue"));

    document.getElementById("btnClearQueue").addEventListener("click", () => {
      sendCommand({ action: "clear_queue" });
      showToast("🗑️ Queue cleared");
    });

    // Auto-connect from URL params (e.g. ?room=GCMV-8492) or localStorage
    function init() {
      const params = new URLSearchParams(window.location.search);
      const roomParam = params.get("room") || localStorage.getItem("gcmv_last_room");
      if (roomParam) {
        document.getElementById("inputRoomCode").value = roomParam;
        connectToRoom(roomParam);
      }

      // Real-time state polling (every 2s) so playback time, progress and track changes stay live
      setInterval(() => {
        if (isConnected) {
          sendCommand({ action: "get_state" });
        }
      }, 2000);
    }

    if (document.readyState === "loading") {
      window.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
