/**
 * Gacha MV Player - Popup Controller
 */

document.addEventListener("DOMContentLoaded", async () => {
  // Universal storage adapter: supports Firefox (browser.storage Promises)
  // and Chromium/Android (chrome.storage callback wrapped into Promise)
  const extStorage = {
    get: function (defaults) {
      if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
        return browser.storage.local.get(defaults);
      }
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        try {
          const res = chrome.storage.local.get(defaults);
          if (res && typeof res.then === "function") return res;
        } catch (_) {}
        return new Promise((resolve) => {
          chrome.storage.local.get(defaults, (data) => {
            resolve(data || {});
          });
        });
      }
      return Promise.resolve({});
    },
    set: function (items) {
      if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
        return browser.storage.local.set(items);
      }
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        try {
          const res = chrome.storage.local.set(items);
          if (res && typeof res.then === "function") return res;
        } catch (_) {}
        return new Promise((resolve) => {
          chrome.storage.local.set(items, () => {
            resolve();
          });
        });
      }
      return Promise.resolve();
    }
  };

  // DOM Elements
  const masterToggle = document.getElementById("masterToggle");
  const statusBadge = document.getElementById("statusBadge");
  const statusText = document.getElementById("statusText");
  const activeContentArea = document.getElementById("activeContentArea");
  const disabledOverlay = document.getElementById("disabledOverlay");

  const toggleJukebox = document.getElementById("toggleJukebox");
  const toggleSearchChips = document.getElementById("toggleSearchChips");
  const toggleBlockAds = document.getElementById("toggleBlockAds");
  const toggleAutoSkipNonGacha = document.getElementById("toggleAutoSkipNonGacha");
  const toggleAutoplayGuard = document.getElementById("toggleAutoplayGuard");
  const toggleAutoUnmute = document.getElementById("toggleAutoUnmute");
  const toggleSmoothPlayback = document.getElementById("toggleSmoothPlayback");
  const selectResolution = document.getElementById("selectResolution");
  const toggleFilterOfficial = document.getElementById("toggleFilterOfficial");

  const toggleSkipNonMusic = document.getElementById("toggleSkipNonMusic");
  const toggleSkipIntroOutro = document.getElementById("toggleSkipIntroOutro");
  const toggleSkipSponsor = document.getElementById("toggleSkipSponsor");
  const togglePoiHighlights = document.getElementById("togglePoiHighlights");
  const toggleSponsorBlockApi = document.getElementById("toggleSponsorBlockApi");
  const toggleCustomDb = document.getElementById("toggleCustomDb");

  const toggleNasServer = document.getElementById("toggleNasServer");
  const popupNasDetails = document.getElementById("popupNasDetails");
  const popupNasUrlInput = document.getElementById("popupNasUrlInput");
  const popupNasTokenInput = document.getElementById("popupNasTokenInput");
  const btnPopupNasTest = document.getElementById("btnPopupNasTest");
  const popupNasStatus = document.getElementById("popupNasStatus");
  const togglePopupNasAutoSync = document.getElementById("togglePopupNasAutoSync");
  const btnPopupNasExport = document.getElementById("btnPopupNasExport");
  const btnPopupNasImport = document.getElementById("btnPopupNasImport");

  const toggleRemoteServer = document.getElementById("toggleRemoteServer");
  const popupRemoteDetails = document.getElementById("popupRemoteDetails");
  const popupRemoteUrlInput = document.getElementById("popupRemoteUrlInput");
  const btnPopupCopyRemoteUrl = document.getElementById("btnPopupCopyRemoteUrl");
  const btnPopupOpenRemoteTab = document.getElementById("btnPopupOpenRemoteTab");
  const popupRemoteStatusBadge = document.getElementById("popupRemoteStatusBadge");
  const popupRemoteStatusText = document.getElementById("popupRemoteStatusText");
  const popupRemoteOnlineView = document.getElementById("popupRemoteOnlineView");
  const popupRemoteOfflineView = document.getElementById("popupRemoteOfflineView");
  const btnPopupCopyServerCmd = document.getElementById("btnPopupCopyServerCmd");
  const btnPopupRetryRemote = document.getElementById("btnPopupRetryRemote");
  const popupServerCmdText = document.getElementById("popupServerCmdText");

  const btnTabCloudRemote = document.getElementById("btnTabCloudRemote");
  const btnTabLocalRemote = document.getElementById("btnTabLocalRemote");
  const popupCloudRoomView = document.getElementById("popupCloudRoomView");
  const popupLocalServerView = document.getElementById("popupLocalServerView");
  const popupCloudRoomCodeText = document.getElementById("popupCloudRoomCodeText");
  const btnPopupCopyRoomCode = document.getElementById("btnPopupCopyRoomCode");
  const btnPopupRegenRoomCode = document.getElementById("btnPopupRegenRoomCode");
  const popupCloudRemoteUrlInput = document.getElementById("popupCloudRemoteUrlInput");
  const btnPopupCopyCloudUrl = document.getElementById("btnPopupCopyCloudUrl");
  const btnPopupOpenCloudTab = document.getElementById("btnPopupOpenCloudTab");
  const popupCloudQrBox = document.getElementById("popupCloudQrBox");
  const popupCloudQrContainer = document.getElementById("popupCloudQrContainer");

  const btnInstantRadio = document.getElementById("btnInstantRadio");
  const gachaSearchInput = document.getElementById("gachaSearchInput");
  const btnSearch = document.getElementById("btnSearch");
  const catCards = document.querySelectorAll(".cat-card");

  // Popup Skiplist Elements
  const popupVideoBadge = document.getElementById("popupVideoBadge");
  const popupPoiCard = document.getElementById("popupPoiCard");
  const popupPoiTiming = document.getElementById("popupPoiTiming");
  const btnPopupJumpPoi = document.getElementById("btnPopupJumpPoi");
  const popupSegmentsList = document.getElementById("popupSegmentsList");

  // Volume Booster Elements
  const popupVolumeBadge = document.getElementById("popupVolumeBadge");
  const popupVolumeSlider = document.getElementById("popupVolumeSlider");
  const btnPopupVolumeReset = document.getElementById("btnPopupVolumeReset");
  const volPresets = document.querySelectorAll(".btn-vol-preset");

  let currentActiveTabId = null;
  let currentVideoId = null;

  function formatTime(sec) {
    if (isNaN(sec) || sec === null || sec === undefined) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  }

  function updateVolumeBoostUI(boost) {
    const val = Math.max(100, Math.min(1000, Math.round(boost)));
    if (popupVolumeBadge) {
      const mult = (val / 100).toFixed(val % 100 === 0 ? 1 : 2);
      popupVolumeBadge.textContent = `${val}% (${mult}x)`;
    }
    if (popupVolumeSlider) {
      popupVolumeSlider.value = val;
    }
    if (volPresets) {
      volPresets.forEach((btn) => {
        const b = parseInt(btn.getAttribute("data-boost"), 10);
        btn.classList.toggle("active", b === val);
      });
    }
  }

  async function setVolumeBoost(val) {
    const boost = Math.max(100, Math.min(1000, Math.round(val)));
    updateVolumeBoostUI(boost);
    await extStorage.set({ volumeBoost: boost });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "SET_VOLUME_BOOST", boost: boost });
      }
    });
  }

  // Load existing settings
  try {
    const settings = await extStorage.get({
      enabled: true,
      blockAds: true,
      showJukebox: true,
      showSearchChips: true,
      autoSkipNonGacha: true,
      autoplayGuard: true,
      filterOfficialVideos: true,
      skipNonMusic: true,
      skipIntroOutro: true,
      skipSponsor: true,
      showPoiHighlights: true,
      useSponsorBlockApi: true,
      useCustomDb: true,
      useNasServer: false,
      nasServerUrl: "",
      nasAuthToken: "",
      nasAutoSync: false,
      volumeBoost: 100,
      autoUnmute: true,
      smoothPlayback: true,
      preferredResolution: "auto",
      remoteServerEnabled: true,
      remoteServerUrl: ""
    });

    // Version 1.0.0 enabled NAS access without authentication. Disable that
    // legacy state until the user supplies a token and tests the connection.
    if (settings.useNasServer && !settings.nasAuthToken) {
      settings.useNasServer = false;
      settings.nasAutoSync = false;
      await extStorage.set({ useNasServer: false, nasAutoSync: false });
    }

    applyUIState(settings.enabled);
    updateVolumeBoostUI(settings.volumeBoost || 100);
    masterToggle.checked = settings.enabled;
    toggleJukebox.checked = settings.showJukebox;
    toggleSearchChips.checked = settings.showSearchChips;
    if (toggleBlockAds) toggleBlockAds.checked = settings.blockAds !== false;
    if (toggleAutoSkipNonGacha) toggleAutoSkipNonGacha.checked = settings.autoSkipNonGacha;
    toggleAutoplayGuard.checked = settings.autoplayGuard;
    if (toggleAutoUnmute) toggleAutoUnmute.checked = settings.autoUnmute !== false;
    if (toggleSmoothPlayback) toggleSmoothPlayback.checked = settings.smoothPlayback !== false;
    if (selectResolution) selectResolution.value = settings.preferredResolution || "auto";
    if (toggleFilterOfficial) toggleFilterOfficial.checked = settings.filterOfficialVideos;
    if (toggleSkipNonMusic) toggleSkipNonMusic.checked = settings.skipNonMusic;
    if (toggleSkipIntroOutro) toggleSkipIntroOutro.checked = settings.skipIntroOutro;
    if (toggleSkipSponsor) toggleSkipSponsor.checked = settings.skipSponsor;
    if (togglePoiHighlights) togglePoiHighlights.checked = settings.showPoiHighlights;
    if (toggleSponsorBlockApi) toggleSponsorBlockApi.checked = settings.useSponsorBlockApi;
    if (toggleCustomDb) toggleCustomDb.checked = settings.useCustomDb;
    if (toggleNasServer) {
      toggleNasServer.checked = settings.useNasServer;
      if (popupNasDetails) popupNasDetails.classList.toggle("hidden", !settings.useNasServer);
    }
    if (popupNasUrlInput) popupNasUrlInput.value = settings.nasServerUrl || "";
    if (popupNasTokenInput) popupNasTokenInput.value = settings.nasAuthToken || "";
    if (togglePopupNasAutoSync) togglePopupNasAutoSync.checked = settings.nasAutoSync;

    if (toggleRemoteServer) {
      toggleRemoteServer.checked = settings.remoteServerEnabled !== false;
      if (popupRemoteDetails) popupRemoteDetails.classList.toggle("hidden", settings.remoteServerEnabled === false);
    }
    initPopupCloudRoom();
    discoverAndSetRemoteUrl();
  } catch (err) {
    console.error("[Gacha MV] Failed to load settings:", err);
  }

  let activeCloudRoomCode = "";

  function generatePopupRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let res = "GCMV-";
    for (let i = 0; i < 4; i++) {
      res += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return res;
  }

  function renderCloudQrCode(url) {
    if (!popupCloudQrBox || !url) return;
    try {
      if (typeof qrcode === "function") {
        const qr = qrcode(0, "M");
        qr.addData(url);
        qr.make();
        popupCloudQrBox.innerHTML = qr.createSvgTag({ scalable: true });
        if (popupCloudQrContainer) popupCloudQrContainer.classList.remove("hidden");
      }
    } catch (e) {
      console.warn("[GCMV] QR render error:", e);
    }
  }

  async function initPopupCloudRoom() {
    const stored = await extStorage.get({ cloudRoomCode: "" });
    activeCloudRoomCode = stored.cloudRoomCode || generatePopupRoomCode();
    if (!stored.cloudRoomCode) {
      await extStorage.set({ cloudRoomCode: activeCloudRoomCode });
    }

    if (popupCloudRoomCodeText) {
      popupCloudRoomCodeText.textContent = activeCloudRoomCode;
    }

    const cloudUrl = `https://itsmemusicchilly.github.io/GCMV-only-videos-extension/remote/?room=${activeCloudRoomCode}`;
    if (popupCloudRemoteUrlInput) {
      popupCloudRemoteUrlInput.value = cloudUrl;
    }
    renderCloudQrCode(cloudUrl);
  }

  const popupRemoteQrBox = document.getElementById("popupRemoteQrBox");
  const popupRemoteQrContainer = document.getElementById("popupRemoteQrContainer");

  function renderPopupQrCode(url) {
    if (!popupRemoteQrBox || !url) return;
    try {
      if (typeof qrcode === "function") {
        const qr = qrcode(0, "M");
        qr.addData(url);
        qr.make();
        popupRemoteQrBox.innerHTML = qr.createSvgTag({ scalable: true });
        if (popupRemoteQrContainer) popupRemoteQrContainer.classList.remove("hidden");
      }
    } catch (e) {
      console.warn("[GCMV] QR render error:", e);
    }
  }

  async function discoverAndSetRemoteUrl() {
    let bestUrl = settings.remoteServerUrl || "";
    let addresses = [];
    let serverPort = 3000;
    let serverOnline = false;

    // Probe common local ports to find running remote server and get its real LAN IP
    const probePorts = [3000, 3001, 3002, 8080, 8081];
    for (const port of probePorts) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 600);
        const res = await fetch(`http://127.0.0.1:${port}/api/status`, { cache: "no-store", signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
          const data = await res.json();
          serverPort = port;
          serverOnline = true;
          if (data && Array.isArray(data.addresses)) {
            addresses = data.addresses;
          }
          if (data && data.serverUrl) {
            bestUrl = data.serverUrl;
            break;
          } else if (data && data.ip) {
            bestUrl = `http://${data.ip}:${port}/remote`;
            break;
          }
        }
      } catch (e) {}
    }

    if (serverOnline) {
      if (!bestUrl) bestUrl = `http://127.0.0.1:${serverPort}/remote`;
      if (popupRemoteStatusBadge) {
        popupRemoteStatusBadge.style.background = "rgba(0, 255, 170, 0.15)";
        popupRemoteStatusBadge.style.color = "#00ffaa";
        popupRemoteStatusBadge.style.border = "1px solid rgba(0, 255, 170, 0.3)";
      }
      if (popupRemoteStatusText) popupRemoteStatusText.textContent = "ONLINE";
      if (popupRemoteOnlineView) {
        popupRemoteOnlineView.classList.remove("hidden");
        popupRemoteOnlineView.style.display = "flex";
      }
      if (popupRemoteOfflineView) {
        popupRemoteOfflineView.classList.add("hidden");
        popupRemoteOfflineView.style.display = "none";
      }

      if (popupRemoteUrlInput) {
        popupRemoteUrlInput.value = bestUrl;
      }
      renderPopupQrCode(bestUrl);

      const chipsContainer = document.getElementById("popupRemoteIpChips");
      if (chipsContainer) {
        chipsContainer.innerHTML = "";
        if (addresses.length > 1) {
          chipsContainer.style.display = "flex";
          addresses.forEach((info) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "btn-popup-test";
            const icon = info.type === "tailscale" ? "🔒" : info.type === "wifi" ? "📶" : info.type === "ethernet" ? "🌐" : "📱";
            btn.textContent = `${icon} ${info.name}: ${info.ip}`;
            btn.style.cssText = "font-size:10px; padding:3px 7px; border-radius:10px; margin:2px; cursor:pointer;";
            btn.onclick = () => {
              const newUrl = `http://${info.ip}:${serverPort}/remote`;
              if (popupRemoteUrlInput) popupRemoteUrlInput.value = newUrl;
              renderPopupQrCode(newUrl);
            };
            chipsContainer.appendChild(btn);
          });
        } else {
          chipsContainer.style.display = "none";
        }
      }
    } else {
      if (popupRemoteStatusBadge) {
        popupRemoteStatusBadge.style.background = "rgba(255, 82, 82, 0.15)";
        popupRemoteStatusBadge.style.color = "#ff5252";
        popupRemoteStatusBadge.style.border = "1px solid rgba(255, 82, 82, 0.3)";
      }
      if (popupRemoteStatusText) popupRemoteStatusText.textContent = "OFFLINE";
      if (popupRemoteOnlineView) {
        popupRemoteOnlineView.classList.add("hidden");
        popupRemoteOnlineView.style.display = "none";
      }
      if (popupRemoteOfflineView) {
        popupRemoteOfflineView.classList.remove("hidden");
        popupRemoteOfflineView.style.display = "flex";
      }
      if (popupRemoteUrlInput) {
        popupRemoteUrlInput.value = settings.remoteServerUrl || "http://127.0.0.1:3000/remote";
      }
    }
  }

  // Update UI appearance according to enabled status
  function applyUIState(isEnabled) {
    if (isEnabled) {
      statusBadge.className = "status-badge active";
      statusText.textContent = "ACTIVE";
      activeContentArea.classList.remove("hidden");
      disabledOverlay.classList.add("hidden");
    } else {
      statusBadge.className = "status-badge disabled";
      statusText.textContent = "DISABLED";
      activeContentArea.classList.add("hidden");
      disabledOverlay.classList.remove("hidden");
    }
  }

  // Master Toggle Change
  masterToggle.addEventListener("change", async (e) => {
    const isEnabled = e.target.checked;
    await extStorage.set({ enabled: isEnabled });
    applyUIState(isEnabled);

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "GACHA_STATE_CHANGED", enabled: isEnabled });
      }
    });
  });

  // Volume Booster Slider & Preset Events
  if (popupVolumeSlider) {
    popupVolumeSlider.addEventListener("input", (e) => {
      setVolumeBoost(parseInt(e.target.value, 10));
    });
  }

  if (volPresets) {
    volPresets.forEach((btn) => {
      btn.addEventListener("click", () => {
        const boostVal = parseInt(btn.getAttribute("data-boost"), 10);
        if (!isNaN(boostVal)) {
          setVolumeBoost(boostVal);
        }
      });
    });
  }

  if (btnPopupVolumeReset) {
    btnPopupVolumeReset.addEventListener("click", () => {
      setVolumeBoost(100);
    });
  }

  // Feature Toggles Change
  toggleJukebox.addEventListener("change", async (e) => {
    await extStorage.set({ showJukebox: e.target.checked });
  });

  toggleSearchChips.addEventListener("change", async (e) => {
    await extStorage.set({ showSearchChips: e.target.checked });
  });

  if (toggleBlockAds) {
    toggleBlockAds.addEventListener("change", async (e) => {
      await extStorage.set({ blockAds: e.target.checked });
    });
  }

  if (toggleAutoSkipNonGacha) {
    toggleAutoSkipNonGacha.addEventListener("change", async (e) => {
      await extStorage.set({ autoSkipNonGacha: e.target.checked });
    });
  }

  toggleAutoplayGuard.addEventListener("change", async (e) => {
    await extStorage.set({ autoplayGuard: e.target.checked });
  });

  if (toggleAutoUnmute) {
    toggleAutoUnmute.addEventListener("change", async (e) => {
      await extStorage.set({ autoUnmute: e.target.checked });
    });
  }

  if (toggleSmoothPlayback) {
    toggleSmoothPlayback.addEventListener("change", async (e) => {
      await extStorage.set({ smoothPlayback: e.target.checked });
    });
  }

  if (selectResolution) {
    selectResolution.addEventListener("change", async (e) => {
      await extStorage.set({ preferredResolution: e.target.value });
    });
  }

  if (toggleFilterOfficial) {
    toggleFilterOfficial.addEventListener("change", async (e) => {
      await extStorage.set({ filterOfficialVideos: e.target.checked });
    });
  }

  if (toggleSkipNonMusic) {
    toggleSkipNonMusic.addEventListener("change", async (e) => {
      await extStorage.set({ skipNonMusic: e.target.checked });
    });
  }

  if (toggleSkipIntroOutro) {
    toggleSkipIntroOutro.addEventListener("change", async (e) => {
      await extStorage.set({ skipIntroOutro: e.target.checked });
    });
  }

  if (toggleSkipSponsor) {
    toggleSkipSponsor.addEventListener("change", async (e) => {
      await extStorage.set({ skipSponsor: e.target.checked });
    });
  }

  if (togglePoiHighlights) {
    togglePoiHighlights.addEventListener("change", async (e) => {
      await extStorage.set({ showPoiHighlights: e.target.checked });
    });
  }

  if (toggleSponsorBlockApi) {
    toggleSponsorBlockApi.addEventListener("change", async (e) => {
      await extStorage.set({ useSponsorBlockApi: e.target.checked });
    });
  }

  if (toggleCustomDb) {
    toggleCustomDb.addEventListener("change", async (e) => {
      await extStorage.set({ useCustomDb: e.target.checked });
    });
  }

  // NAS Server Handlers
  if (toggleNasServer) {
    toggleNasServer.addEventListener("change", async (e) => {
      const isNas = e.target.checked;
      if (isNas && (!popupNasUrlInput?.value.trim() || !popupNasTokenInput?.value.trim())) {
        e.target.checked = false;
        if (popupNasDetails) popupNasDetails.classList.remove("hidden");
        await extStorage.set({ useNasServer: false });
        setNasStatus("Enter the server URL and token, then use Test to enable NAS access", "#ffcc66");
        return;
      }
      if (popupNasDetails) popupNasDetails.classList.toggle("hidden", !isNas);
      await extStorage.set({ useNasServer: isNas });
    });
  }

  function persistNasFields() {
    const url = popupNasUrlInput ? popupNasUrlInput.value.trim() : "";
    const token = popupNasTokenInput ? popupNasTokenInput.value.trim() : "";
    return extStorage.set({ nasServerUrl: url, nasAuthToken: token });
  }

  if (popupNasUrlInput) {
    popupNasUrlInput.addEventListener("input", persistNasFields);
    popupNasUrlInput.addEventListener("change", persistNasFields);
    popupNasUrlInput.addEventListener("blur", persistNasFields);
  }

  if (popupNasTokenInput) {
    popupNasTokenInput.addEventListener("input", persistNasFields);
    popupNasTokenInput.addEventListener("change", persistNasFields);
    popupNasTokenInput.addEventListener("blur", persistNasFields);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistNasFields();
  });
  window.addEventListener("pagehide", persistNasFields);

  if (togglePopupNasAutoSync) {
    togglePopupNasAutoSync.addEventListener("change", async (e) => {
      await extStorage.set({ nasAutoSync: e.target.checked });
    });
  }

  if (toggleRemoteServer) {
    toggleRemoteServer.addEventListener("change", async (e) => {
      const isRemote = e.target.checked;
      if (popupRemoteDetails) popupRemoteDetails.classList.toggle("hidden", !isRemote);
      await extStorage.set({ remoteServerEnabled: isRemote });
    });
  }

  if (btnPopupCopyRemoteUrl) {
    btnPopupCopyRemoteUrl.addEventListener("click", () => {
      if (popupRemoteUrlInput && popupRemoteUrlInput.value) {
        navigator.clipboard.writeText(popupRemoteUrlInput.value).then(() => {
          const orig = btnPopupCopyRemoteUrl.textContent;
          btnPopupCopyRemoteUrl.textContent = "Copied!";
          setTimeout(() => { btnPopupCopyRemoteUrl.textContent = orig; }, 1500);
        }).catch(() => {});
      }
    });
  }

  if (btnPopupOpenRemoteTab) {
    btnPopupOpenRemoteTab.addEventListener("click", () => {
      const url = (popupRemoteUrlInput && popupRemoteUrlInput.value) || "http://127.0.0.1:3000/remote";
      chrome.tabs.create({ url });
    });
  }

  if (btnPopupCopyServerCmd) {
    btnPopupCopyServerCmd.addEventListener("click", () => {
      const cmd = (popupServerCmdText && popupServerCmdText.textContent) || "./start-phone-remote.sh";
      navigator.clipboard.writeText(cmd).then(() => {
        const orig = btnPopupCopyServerCmd.textContent;
        btnPopupCopyServerCmd.textContent = "Copied!";
        setTimeout(() => { btnPopupCopyServerCmd.textContent = orig; }, 1500);
      }).catch(() => {});
    });
  }

  if (btnPopupRetryRemote) {
    btnPopupRetryRemote.addEventListener("click", async () => {
      const orig = btnPopupRetryRemote.textContent;
      btnPopupRetryRemote.textContent = "⏳...";
      await discoverAndSetRemoteUrl();
      setTimeout(() => { btnPopupRetryRemote.textContent = orig; }, 600);
    });
  }

  if (popupRemoteQrBox) {
    popupRemoteQrBox.addEventListener("click", () => {
      if (popupRemoteUrlInput && popupRemoteUrlInput.value) {
        navigator.clipboard.writeText(popupRemoteUrlInput.value).then(() => {
          if (btnPopupCopyRemoteUrl) {
            const orig = btnPopupCopyRemoteUrl.textContent;
            btnPopupCopyRemoteUrl.textContent = "Copied!";
            setTimeout(() => { btnPopupCopyRemoteUrl.textContent = orig; }, 1500);
          }
        }).catch(() => {});
      }
    });
  }

  // Cloud Room (Zero-Script) Event Listeners
  if (btnTabCloudRemote && btnTabLocalRemote) {
    btnTabCloudRemote.addEventListener("click", () => {
      btnTabCloudRemote.classList.add("active");
      btnTabLocalRemote.classList.remove("active");
      if (popupCloudRoomView) popupCloudRoomView.classList.remove("hidden");
      if (popupLocalServerView) popupLocalServerView.classList.add("hidden");
      if (popupRemoteStatusBadge) {
        popupRemoteStatusBadge.style.background = "rgba(0, 255, 170, 0.15)";
        popupRemoteStatusBadge.style.color = "#00ffaa";
        popupRemoteStatusBadge.style.border = "1px solid rgba(0, 255, 170, 0.3)";
      }
      if (popupRemoteStatusText) popupRemoteStatusText.textContent = "CLOUD READY";
    });

    btnTabLocalRemote.addEventListener("click", () => {
      btnTabLocalRemote.classList.add("active");
      btnTabCloudRemote.classList.remove("active");
      if (popupCloudRoomView) popupCloudRoomView.classList.add("hidden");
      if (popupLocalServerView) popupLocalServerView.classList.remove("hidden");
      discoverAndSetRemoteUrl();
    });
  }

  if (btnPopupCopyRoomCode) {
    btnPopupCopyRoomCode.addEventListener("click", () => {
      if (activeCloudRoomCode) {
        navigator.clipboard.writeText(activeCloudRoomCode).then(() => {
          const orig = btnPopupCopyRoomCode.textContent;
          btnPopupCopyRoomCode.textContent = "Copied!";
          setTimeout(() => { btnPopupCopyRoomCode.textContent = orig; }, 1500);
        }).catch(() => {});
      }
    });
  }

  if (btnPopupRegenRoomCode) {
    btnPopupRegenRoomCode.addEventListener("click", async () => {
      activeCloudRoomCode = generatePopupRoomCode();
      await extStorage.set({ cloudRoomCode: activeCloudRoomCode });
      if (popupCloudRoomCodeText) popupCloudRoomCodeText.textContent = activeCloudRoomCode;
      const cloudUrl = `https://itsmemusicchilly.github.io/GCMV-only-videos-extension/remote/?room=${activeCloudRoomCode}`;
      if (popupCloudRemoteUrlInput) popupCloudRemoteUrlInput.value = cloudUrl;
      renderCloudQrCode(cloudUrl);
    });
  }

  if (btnPopupCopyCloudUrl) {
    btnPopupCopyCloudUrl.addEventListener("click", () => {
      if (popupCloudRemoteUrlInput && popupCloudRemoteUrlInput.value) {
        navigator.clipboard.writeText(popupCloudRemoteUrlInput.value).then(() => {
          const orig = btnPopupCopyCloudUrl.textContent;
          btnPopupCopyCloudUrl.textContent = "Copied!";
          setTimeout(() => { btnPopupCopyCloudUrl.textContent = orig; }, 1500);
        }).catch(() => {});
      }
    });
  }

  if (btnPopupOpenCloudTab) {
    btnPopupOpenCloudTab.addEventListener("click", () => {
      const url = chrome.runtime.getURL("remote/index.html?room=" + activeCloudRoomCode);
      chrome.tabs.create({ url });
    });
  }

  if (popupCloudQrBox) {
    popupCloudQrBox.addEventListener("click", () => {
      if (popupCloudRemoteUrlInput && popupCloudRemoteUrlInput.value) {
        navigator.clipboard.writeText(popupCloudRemoteUrlInput.value).then(() => {
          if (btnPopupCopyCloudUrl) {
            const orig = btnPopupCopyCloudUrl.textContent;
            btnPopupCopyCloudUrl.textContent = "Copied!";
            setTimeout(() => { btnPopupCopyCloudUrl.textContent = orig; }, 1500);
          }
        }).catch(() => {});
      }
    });
  }

  async function popupNasFetch(url, options = {}) {
    const msg = {
      type: "FETCH_NAS",
      url: url,
      method: options.method || "GET",
      body: options.body || null
    };

    // 1. Try Firefox Promise-based browser.runtime.sendMessage
    try {
      if (typeof browser !== "undefined" && browser.runtime && browser.runtime.sendMessage) {
        const resp = await browser.runtime.sendMessage(msg);
        if (resp && typeof resp === "object" && "ok" in resp) {
          return resp;
        }
      }
    } catch (_) {}

    // 2. Try Chrome callback-based chrome.runtime.sendMessage
    return new Promise((resolve) => {
      try {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage(msg, (resp) => {
            if (chrome.runtime.lastError || !resp) {
              resolve({ ok: false, status: 0, error: chrome.runtime.lastError?.message || "NAS proxy unavailable", data: null });
            } else {
              resolve(resp);
            }
          });
          return;
        }
      } catch (_) {}

      resolve({ ok: false, status: 0, error: "NAS proxy unavailable", data: null });
    });
  }

  async function ensureNasHostPermission(baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      const originPattern = `${parsed.protocol}//${parsed.host}/*`;
      if (typeof browser !== "undefined" && browser.permissions) {
        return await browser.permissions.request({ origins: [originPattern] });
      }
      if (chrome.permissions) {
        return await new Promise((resolve) => chrome.permissions.request({ origins: [originPattern] }, resolve));
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  async function prepareNasConfig() {
    const rawUrl = popupNasUrlInput ? popupNasUrlInput.value.trim() : "";
    const token = popupNasTokenInput ? popupNasTokenInput.value.trim() : "";
    let parsed;
    try {
      parsed = new URL(rawUrl);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        throw new Error("invalid URL");
      }
    } catch (_) {
      setNasStatus("❌ Enter a valid server origin, for example http://192.168.1.50:3080", "#ff6666");
      return null;
    }
    if (!token) {
      setNasStatus("❌ Enter the NAS_AUTH_TOKEN configured on the server", "#ff6666");
      return null;
    }
    const baseUrl = parsed.origin;
    if (!(await ensureNasHostPermission(baseUrl))) {
      setNasStatus("❌ Browser permission for this NAS address was not granted", "#ff6666");
      return null;
    }
    await extStorage.set({ nasServerUrl: baseUrl, nasAuthToken: token });
    if (popupNasUrlInput) popupNasUrlInput.value = baseUrl;
    return baseUrl;
  }

  function setNasStatus(text, color = "#00f0ff") {
    if (!popupNasStatus) return;
    popupNasStatus.textContent = "";
    const span = document.createElement("span");
    span.style.color = color;
    span.textContent = text;
    popupNasStatus.appendChild(span);
  }

  function setPopupSegmentsNote(text) {
    if (!popupSegmentsList) return;
    popupSegmentsList.textContent = "";
    const span = document.createElement("span");
    span.className = "popup-note";
    span.textContent = text;
    popupSegmentsList.appendChild(span);
  }

  if (btnPopupNasTest) {
    btnPopupNasTest.addEventListener("click", async () => {
      const baseUrl = await prepareNasConfig();
      if (!baseUrl) return;
      setNasStatus(`⏳ Testing ${baseUrl}...`, "#00f0ff");
      const res = await popupNasFetch(`${baseUrl}/health`);
      if (res.ok && res.data) {
        await extStorage.set({ useNasServer: true });
        if (toggleNasServer) toggleNasServer.checked = true;
        if (popupNasDetails) popupNasDetails.classList.remove("hidden");
        setNasStatus(`✅ Connected! (${res.data.totalSegments || 0} segments on NAS)`, "#00ffaa");
      } else {
        setNasStatus(`❌ ${res.error || "HTTP " + res.status}`, "#ff6666");
      }
    });
  }

  if (btnPopupNasExport) {
    btnPopupNasExport.addEventListener("click", async () => {
      const baseUrl = await prepareNasConfig();
      if (!baseUrl) return;
      const { customSkipDb = {} } = await extStorage.get("customSkipDb");
      setNasStatus("⏳ Uploading backup to NAS...", "#00f0ff");
      const res = await popupNasFetch(`${baseUrl}/api/database?merge=true`, {
        method: "POST",
        body: customSkipDb
      });
      if (res.ok) {
        const data = res.data || {};
        setNasStatus(`💾 Backup saved! (${data.videoCount || Object.keys(customSkipDb).length} videos)`, "#00ffaa");
      } else {
        setNasStatus(`❌ Backup error: ${res.error || "HTTP " + res.status}`, "#ff6666");
      }
    });
  }

  if (btnPopupNasImport) {
    btnPopupNasImport.addEventListener("click", async () => {
      const baseUrl = await prepareNasConfig();
      if (!baseUrl) return;
      setNasStatus("⏳ Downloading from NAS...", "#00f0ff");
      const res = await popupNasFetch(`${baseUrl}/api/database`);
      if (res.ok && res.data && typeof res.data === "object" && !Array.isArray(res.data)) {
        const remoteDb = res.data;
        const { customSkipDb = {} } = await extStorage.get("customSkipDb");
        const merged = { ...customSkipDb, ...remoteDb };
        await extStorage.set({ customSkipDb: merged });
        setNasStatus(`📥 Restored ${Object.keys(remoteDb).length} videos from NAS!`, "#00ffaa");
      } else {
        setNasStatus(`❌ Restore error: ${res.error || "HTTP " + res.status}`, "#ff6666");
      }
    });
  }

  // Instant Gacha Radio Button
  btnInstantRadio.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.youtube.com/results?search_query=GCMV+GLMV+Gacha+Music+Video+Playlist" });
    window.close();
  });

  // Search Logic
  function executeSearch() {
    const query = gachaSearchInput.value.trim();
    if (!query) return;

    const lower = query.toLowerCase();
    let finalQuery = query;
    if (!lower.includes("gcmv") && !lower.includes("glmv") && !lower.includes("gacha")) {
      finalQuery = `${query} GCMV GLMV`;
    }

    chrome.tabs.create({ url: `https://www.youtube.com/results?search_query=${encodeURIComponent(finalQuery)}` });
    window.close();
  }

  btnSearch.addEventListener("click", executeSearch);
  gachaSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      executeSearch();
    }
  });

  // Category Cards Click
  catCards.forEach((card) => {
    card.addEventListener("click", () => {
      const query = card.getAttribute("data-query");
      if (query) {
        chrome.tabs.create({ url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}` });
        window.close();
      }
    });
  });

  // ==========================================================
  // Current Video Skiplist & POI Highlights in Popup
  // ==========================================================
  async function loadActiveTabVideoSegments() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || !tab.url.includes("youtube.com/watch")) {
        if (popupVideoBadge) popupVideoBadge.textContent = "No YouTube Video";
        if (popupPoiCard) popupPoiCard.classList.add("hidden");
        setPopupSegmentsNote("Open a YouTube video to view active skip segments and POI highlights.");
        return;
      }

      currentActiveTabId = tab.id;
      if (popupVideoBadge) popupVideoBadge.textContent = "YouTube Video Active";

      chrome.tabs.sendMessage(tab.id, { type: "GET_CURRENT_VIDEO_SEGMENTS" }, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          setPopupSegmentsNote("Video loaded. Refreshing segments...");
          return;
        }

        currentVideoId = resp.videoId;

        // 1. POI Card
        if (resp.poi && togglePoiHighlights && togglePoiHighlights.checked) {
          if (popupPoiCard) popupPoiCard.classList.remove("hidden");
          if (popupPoiTiming) popupPoiTiming.textContent = `Starts at ${formatTime(resp.poi.start)}`;
          if (btnPopupJumpPoi) {
            btnPopupJumpPoi.onclick = () => {
              chrome.tabs.sendMessage(tab.id, { type: "SEEK_VIDEO", time: resp.poi.start });
            };
          }
        } else {
          if (popupPoiCard) popupPoiCard.classList.add("hidden");
        }

        // 2. Segments List
        const all = resp.allSegments || [];
        if (all.length === 0) {
          setPopupSegmentsNote("No skip segments found for this video.");
          return;
        }

        if (!popupSegmentsList) return;
        popupSegmentsList.textContent = "";

        all.forEach((seg) => {
          const item = document.createElement("div");
          item.className = `popup-seg-item${seg.ignored ? " is-ignored" : ""}`;

          const topRow = document.createElement("div");
          topRow.className = "popup-seg-row-top";

          const badge = document.createElement("span");
          badge.className = `popup-seg-badge ${seg.category || ""}`;
          badge.textContent = seg.label || "";
          topRow.appendChild(badge);

          const timingDiv = document.createElement("div");
          timingDiv.className = "popup-seg-timing";

          const timingStrong = document.createElement("strong");
          timingStrong.textContent = `${formatTime(seg.start)} ➔ ${formatTime(seg.end)}`;
          timingDiv.appendChild(timingStrong);

          const statusTag = document.createElement("span");
          if (seg.ignored) {
            statusTag.className = "popup-seg-status-tag ignored";
            statusTag.textContent = "🚫 Ignored";
          } else if (seg.retimed) {
            statusTag.className = "popup-seg-status-tag retimed";
            statusTag.textContent = "⏱️ Retimed";
          } else {
            statusTag.className = "popup-seg-status-tag active";
            statusTag.textContent = "Active";
          }
          timingDiv.appendChild(statusTag);
          topRow.appendChild(timingDiv);
          item.appendChild(topRow);

          const actionsDiv = document.createElement("div");
          actionsDiv.className = "popup-seg-actions";

          const jumpBtn = document.createElement("button");
          jumpBtn.className = "popup-seg-btn btn-jump";
          jumpBtn.textContent = "▶️ Jump";
          jumpBtn.addEventListener("click", () => {
            chrome.tabs.sendMessage(tab.id, { type: "SEEK_VIDEO", time: seg.start });
          });
          actionsDiv.appendChild(jumpBtn);

          const ignoreBtn = document.createElement("button");
          ignoreBtn.className = "popup-seg-btn btn-ignore";
          ignoreBtn.textContent = seg.ignored ? "✅ Restore" : "🚫 Ignore / Incorrect";
          ignoreBtn.addEventListener("click", () => {
            chrome.tabs.sendMessage(tab.id, {
              type: "TOGGLE_IGNORE_SEGMENT",
              videoId: currentVideoId,
              segmentId: seg.id
            }, () => {
              loadActiveTabVideoSegments();
            });
          });
          actionsDiv.appendChild(ignoreBtn);

          if (seg.source === "custom") {
            const delBtn = document.createElement("button");
            delBtn.className = "popup-seg-btn btn-del";
            delBtn.textContent = "🗑️";
            delBtn.addEventListener("click", () => {
              chrome.tabs.sendMessage(tab.id, {
                type: "DELETE_CUSTOM_SEGMENT",
                videoId: currentVideoId,
                segmentId: seg.id
              }, () => {
                loadActiveTabVideoSegments();
              });
            });
            actionsDiv.appendChild(delBtn);
          }

          item.appendChild(actionsDiv);
          popupSegmentsList.appendChild(item);
        });
      });
    } catch (e) {
      console.warn("[Gacha MV] Could not query active tab:", e);
    }
  }

  loadActiveTabVideoSegments();
});
