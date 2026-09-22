/**
 * Gacha MV Player - YouTube Content Script
 * Injects Quick Filter Chips, Floating Jukebox Widget (with in-page Settings),
 * Fullscreen auto-hide, Autoplay Guard, Deep Description Scanning,
 * and 1-Click "It's Gacha!" Whitelist Button.
 */

(function () {
  "use strict";

  // Prevent multiple injections
  if (window.__GACHA_MV_LOADED__) return;
  window.__GACHA_MV_LOADED__ = true;

  // Low-end hardware optimization: intercept MediaSource & canPlayType to block AV1 (av01) and VP9 (vp09 / vp9)
  // so YouTube's player uses hardware-accelerated AVC (H.264), eliminating CPU decoding lag on weaker devices.
  function installCodecOptimizationShim() {
    if (window.__GCMV_CODEC_SHIM_APPLIED__) return;
    window.__GCMV_CODEC_SHIM_APPLIED__ = true;
    try {
      const isBlockedCodec = (type) => {
        if (!type || typeof type !== "string") return false;
        return /av01|av1|vp09|vp9/i.test(type);
      };

      if (window.MediaSource && typeof window.MediaSource.isTypeSupported === "function") {
        const origIsTypeSupported = window.MediaSource.isTypeSupported.bind(window.MediaSource);
        window.MediaSource.isTypeSupported = function (type) {
          if (settings.smoothPlayback !== false && isBlockedCodec(type)) {
            return false;
          }
          return origIsTypeSupported(type);
        };
      }
      if (window.HTMLMediaElement && window.HTMLMediaElement.prototype && typeof window.HTMLMediaElement.prototype.canPlayType === "function") {
        const origCanPlay = window.HTMLMediaElement.prototype.canPlayType;
        window.HTMLMediaElement.prototype.canPlayType = function (type) {
          if (settings.smoothPlayback !== false && isBlockedCodec(type)) {
            return "";
          }
          return origCanPlay.call(this, type);
        };
      }
    } catch (e) {
      console.warn("[GCMV] Codec shim error:", e);
    }
  }
  installCodecOptimizationShim();

  // The Android WebView injects this script into YouTube's main world, where
  // Trusted Types are enforced. Keep all HTML creation behind one private
  // policy so the same source works both there and in extension isolated worlds.
  const trustedHtmlPolicy = (() => {
    if (!window.trustedTypes || typeof window.trustedTypes.createPolicy !== "function") return null;
    try {
      return window.trustedTypes.createPolicy("gacha-mv-player", {
        createHTML: (html) => html
      });
    } catch (error) {
      console.warn("[GCMV] Could not create Trusted Types policy:", error);
      return null;
    }
  })();

  function asTrustedHtml(html) {
    return trustedHtmlPolicy ? trustedHtmlPolicy.createHTML(html) : html;
  }

  function isAndroidApp() {
    return !!(window.AndroidBridge);
  }

  function markAndroidHost() {
    if (!isAndroidApp()) return;
    const root = document.documentElement;
    if (root) root.classList.add("gacha-android-app");
    if (document.body) document.body.classList.add("gacha-android-app");
  }

  function appendTrustedHtml(target, html) {
    const parsed = new DOMParser().parseFromString(asTrustedHtml(html), "text/html");
    while (parsed.body.firstChild) {
      target.appendChild(parsed.body.firstChild);
    }
  }

  // YouTube's page enforces Trusted Types, so the Android WebView cannot assign
  // a QR SVG string to innerHTML. Draw the modules with DOM nodes instead.
  function localQrImageUrl(remoteUrl) {
    try {
      const parsed = new URL(remoteUrl);
      if (parsed.protocol !== "http:") return "";
      const host = parsed.hostname;
      const isLocal = host === "localhost" || host === "127.0.0.1" || host.endsWith(".local") ||
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host);
      if (!isLocal) return "";
      return parsed.origin + "/api/qr";
    } catch (_) {
      return "";
    }
  }

  function paintQrCode(target, url) {
    if (!target) return false;
    while (target.firstChild) target.removeChild(target.firstChild);
    if (!url) return false;

    const generator = (typeof qrcode === "function") ? qrcode : null;
    if (generator) {
      const qr = generator(0, "M");
      qr.addData(url);
      qr.make();
      const count = qr.getModuleCount();
      const svgNs = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNs, "svg");
      svg.setAttribute("viewBox", "0 0 " + count + " " + count);
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.setAttribute("shape-rendering", "crispEdges");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "QR Code");

      const background = document.createElementNS(svgNs, "rect");
      background.setAttribute("x", "0");
      background.setAttribute("y", "0");
      background.setAttribute("width", String(count));
      background.setAttribute("height", String(count));
      background.setAttribute("fill", "#ffffff");
      svg.appendChild(background);

      for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
          if (!qr.isDark(row, col)) continue;
          const cell = document.createElementNS(svgNs, "rect");
          cell.setAttribute("x", String(col));
          cell.setAttribute("y", String(row));
          cell.setAttribute("width", "1");
          cell.setAttribute("height", "1");
          cell.setAttribute("fill", "#000000");
          svg.appendChild(cell);
        }
      }
      target.appendChild(svg);
      return true;
    }

    const imgSrc = localQrImageUrl(url);
    if (!imgSrc) return false;
    const img = document.createElement("img");
    img.alt = "QR Code";
    img.src = imgSrc;
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    target.appendChild(img);
    return true;
  }

  // Universal storage adapter: supports Firefox (browser.storage Promises)
  // and Chromium/Android (chrome.storage callback wrapped into Promise)
  const extStorage = {
    get: function (defaults) {
      if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
        return browser.storage.local.get(defaults);
      }
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        try {
          return new Promise((resolve) => {
            chrome.storage.local.get(defaults, (data) => resolve(data || defaults));
          });
        } catch (e) {
          return Promise.resolve(defaults);
        }
      }
      return Promise.resolve(defaults);
    },
    set: function (data) {
      if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
        return browser.storage.local.set(data);
      }
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        try {
          return new Promise((resolve) => {
            chrome.storage.local.set(data, () => resolve());
          });
        } catch (e) {
          return Promise.resolve();
        }
      }
      return Promise.resolve();
    }
  };

  let settings = {
    enabled: true,
    blockAds: true,
    showJukebox: true,
    showSearchChips: true,
    autoplayGuard: true,
    autoSkipNonGacha: true,
    smoothPlayback: true,
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
    preferredResolution: "auto",
    remoteServerEnabled: true,
    remoteServerUrl: "",
    remotePinEnabled: false,
    remotePin: "",
    showBottomLeftQr: false,
    showBottomRightQr: false,
    showQrInFullscreen: true
  };

  let gachaWhitelist = {
    videoIds: [],
    channels: []
  };

  // Web Audio Booster State
  let audioCtx = null;
  let gainNode = null;
  let compressorNode = null;
  let waveShaperNode = null;
  let attachedMediaSource = null;
  let attachedVideoElement = null;
  let volumeToastTimer = null;

  let customSkipDb = {}; // { [videoId]: [ { id, start, end, category, label } ] }
  let ignoredSegments = {}; // { [videoId]: [ segmentId, ... ] }
  let retimedSegments = {}; // { [videoId]: { [segmentId]: { start, end } } }
  let activeVideoSegments = []; // Skippable active segments
  let allLoadedSegments = []; // All segments including POI & ignored
  let activePoiHighlight = null; // Current POI drop
  let poiJumpedVideoId = ""; // Video ID where POI drop auto-jump was executed or checked
  let activeSegmentVideoId = "";
  let segmentLoadGeneration = 0;
  let isSkipping = false;
  let lastSkippedSegment = null;

  let jukeboxPanelOpen = false;
  let activePanelTab = "music"; // "music" | "skiplist" | "settings"
  let videoListenerAttached = false;
  let currentSkipTimer = null;
  let userDismissedSkipForVideoId = "";
  let autoSkipCheckGeneration = 0;
  let autoSkipPollTimer = null;
  let autoplayGuardTimeout = null;
  let autoSkipMutedVideo = null;
  let autoSkipPreviousMuted = false;

  // Auto-Unmute State
  let userManuallyMutedForVideoId = "";
  let lastAutoUnmuteToastTime = 0;
  let lastAutoUnmutedVideoId = "";
  let gestureUnmuteArmed = false;

  // Top-level Global Bridge API for Android app and navigation hooks
  window.__gachaOpenSettings = function() {
    injectFloatingJukebox();
    const tabS = document.getElementById("gachaTabSettings");
    if (tabS) tabS.click();
    const p = document.getElementById("gachaJukeboxPanel");
    if (p) {
      p.classList.remove("gacha-hidden");
      p.style.setProperty("display", "flex", "important");
      jukeboxPanelOpen = true;
      const bd = document.getElementById("gacha-drawer-backdrop");
      if (bd) bd.classList.add("active");
    }
  };

  window.__gachaOpenJukebox = function() {
    injectFloatingJukebox();
    const tabM = document.getElementById("gachaTabMusic");
    if (tabM) tabM.click();
    const p = document.getElementById("gachaJukeboxPanel");
    if (p) {
      p.classList.remove("gacha-hidden");
      p.style.setProperty("display", "flex", "important");
      jukeboxPanelOpen = true;
      const bd = document.getElementById("gacha-drawer-backdrop");
      if (bd) bd.classList.add("active");
    }
  };

  window.__gachaOpenSkipList = function() {
    injectFloatingJukebox();
    const tabL = document.getElementById("gachaTabSkipList");
    if (tabL) tabL.click();
    const p = document.getElementById("gachaJukeboxPanel");
    if (p) {
      p.classList.remove("gacha-hidden");
      p.style.setProperty("display", "flex", "important");
      jukeboxPanelOpen = true;
      const bd = document.getElementById("gacha-drawer-backdrop");
      if (bd) bd.classList.add("active");
    }
  };

  window.__gachaJumpPoi = function() {
    if (typeof activePoiHighlight !== "undefined" && activePoiHighlight) {
      jumpToPoi(activePoiHighlight.start);
    } else {
      const vid = getCurrentVideoId();
      if (vid) {
        loadVideoSegments(vid);
        setTimeout(() => {
          if (activePoiHighlight) jumpToPoi(activePoiHighlight.start);
        }, 500);
      }
    }
  };

  window.__gachaMvReinit = function() {
    applyFeatures();
    const vid = getCurrentVideoId();
    if (vid) {
      setupVideoPlayerListeners();
      if (settings.autoSkipNonGacha) {
        checkCurrentVideoForAutoSkip();
      }
      loadVideoSegments(vid);
    }
  };

  window.__gachaPlayPrevious = function() {
    if (typeof playPreviousTrack === "function") playPreviousTrack();
  };
  window.__gachaTogglePlayPause = function() {
    if (typeof togglePlayPause === "function") togglePlayPause();
  };
  window.__gachaSetLoopMode = function(mode) {
    if (typeof setLoopMode === "function") setLoopMode(mode);
  };
  window.__gachaGetLoopMode = function() {
    return typeof currentLoopMode !== "undefined" ? currentLoopMode : "off";
  };

  // Keywords that identify a true Gacha video in title or channel
  const GACHA_POSITIVE_KEYWORDS = [
    "gcmv",
    "glmv",
    "glmv2",
    "glmv 2",
    "gcmv 2",
    "gc mv",
    "gl mv",
    "gc/mv",
    "gl/mv",
    "gl2",
    "gl 2",
    "gacha",
    "gacha club",
    "gacha life",
    "gacha life 2",
    "gachaclub",
    "gachalife",
    "gachalife2",
    "gachamv",
    "gacha lyric",
    "gacha lyrics",
    "gacha lyric video",
    "gcmv lyric",
    "gcmv lyrics",
    "glmv lyric",
    "glmv lyrics",
    "glmv2 lyric",
    "glmv2 lyrics",
    "gacha animation",
    "glmm",
    "gcmm",
    "gc mm",
    "gl mm",
    "gacha meme",
    "gacha mini movie",
    "gacha edit",
    "gacha singing battle",
    "gacha music video",
    "gachaverse",
    "gacha studio",
    "gachastudio",
    "gacha trend",
    "gacha audio",
    "gacha song",
    "gacha songs",
    "gacha story",
    "gacha stories",
    "gachatuber",
    "starity",
    "viarrah",
    "senpaibuns",
    "luni",
    "rosytea"
  ];

  const GACHA_HASHTAGS = [
    "#gacha",
    "#gcmv",
    "#glmv",
    "#glmv2",
    "#gachaclub",
    "#gachalife",
    "#gachaanimation",
    "#glmm",
    "#gcmm",
    "#gachameme",
    "#gachaedit",
    "#gachaverse",
    "#gachastudio",
    "#gachalife2"
  ];

  // Specific keywords & channels that indicate non-Gacha official / regular lyric videos
  const NON_GACHA_INDICATORS = [
    "official music video",
    "official video",
    "official mv",
    "official audio",
    "official visualizer",
    "official lyric video",
    "official lyric",
    "lyric video",
    "lyrics video",
    "(lyrics)",
    "[lyrics]",
    "(lyric)",
    "[lyric]",
    "- lyrics",
    " lyrics",
    "vevo"
  ];

  const NON_GACHA_CHANNELS = [
    "vevo",
    "7clouds",
    "taz network",
    "syrebralvibes",
    "cassiopeia",
    "superblyrics",
    "epiphany",
    "sensual musique",
    "trap nation",
    "chill nation",
    "clean lyrics",
    "the vibe guide",
    "royal music",
    "shadow music",
    "gold coast music",
    "lyrics",
    "records"
  ];

  // ==========================================================
  // Whitelist Management (Solution 3)
  // ==========================================================
  async function loadWhitelist() {
    try {
      const data = await extStorage.get({ gachaWhitelist: { videoIds: [], channels: [] } });
      gachaWhitelist = data.gachaWhitelist || { videoIds: [], channels: [] };
    } catch (e) {
      console.warn("[Gacha MV] Could not load whitelist", e);
    }
  }

  async function whitelistGacha(videoId, channelName) {
    if (videoId && !gachaWhitelist.videoIds.includes(videoId)) {
      gachaWhitelist.videoIds.push(videoId);
    }
    if (channelName) {
      const lower = channelName.toLowerCase().trim();
      if (lower && !gachaWhitelist.channels.includes(lower)) {
        gachaWhitelist.channels.push(lower);
      }
    }

    try {
      await extStorage.set({ gachaWhitelist });
      showToast("🌸 Added to Gacha Whitelist! ✨");
    } catch (e) {
      console.error("[Gacha MV] Failed to save whitelist", e);
    }

    // Immediately re-evaluate and un-dim across page
    restoreAutoSkipMute();
    applyFeedBadgesAndFilters(true);
  }

  // ==========================================================
  // Studio-Grade 1x - 10x Volume Booster & Anti-Distortion DSP
  // ==========================================================
  function makeSoftClippingCurve(nSamples = 4096) {
    const curve = new Float32Array(nSamples);
    for (let i = 0; i < nSamples; ++i) {
      const x = (i * 2) / (nSamples - 1) - 1; // -1.0 to +1.0
      // Hyperbolic tangent (tanh) creates a smooth, musical soft-knee saturation
      // preventing harsh digital clipping when boosted up to 10x (+20dB)
      curve[i] = Math.tanh(x);
    }
    return curve;
  }

  function ensureAudioContextResumed() {
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
  }

  function setupAudioBooster(video) {
    if (!video) {
      video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    }
    if (!video) return;

    const boostValue = typeof settings.volumeBoost === "number" ? settings.volumeBoost : 100;
    if ((!settings.enabled || boostValue <= 100) && !video.__gachaSourceNode__) return;

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;

      if (!audioCtx || audioCtx.state === "closed") {
        audioCtx = new AudioContextClass();
        gainNode = null;
        compressorNode = null;
        waveShaperNode = null;
        attachedMediaSource = null;
        attachedVideoElement = null;
      }

      // 1. Initialize persistent DSP chain if not yet created
      if (!gainNode || !compressorNode || !waveShaperNode) {
        gainNode = audioCtx.createGain();

        // Multi-stage Smart Limiter (DynamicsCompressorNode)
        compressorNode = audioCtx.createDynamicsCompressor();
        compressorNode.threshold.setValueAtTime(-8, audioCtx.currentTime);
        compressorNode.knee.setValueAtTime(25, audioCtx.currentTime);
        compressorNode.ratio.setValueAtTime(14, audioCtx.currentTime);
        compressorNode.attack.setValueAtTime(0.003, audioCtx.currentTime);
        compressorNode.release.setValueAtTime(0.20, audioCtx.currentTime);

        // Soft Clipper (WaveShaperNode with tanh curve)
        waveShaperNode = audioCtx.createWaveShaper();
        waveShaperNode.curve = makeSoftClippingCurve();
        waveShaperNode.oversample = "none";

        gainNode.connect(compressorNode);
        compressorNode.connect(waveShaperNode);
        waveShaperNode.connect(audioCtx.destination);
      }

      // 2. Connect or retrieve MediaElementSourceNode for this specific video element
      let sourceNode = video.__gachaSourceNode__;
      if (!sourceNode || sourceNode.context !== audioCtx) {
        try {
          sourceNode = audioCtx.createMediaElementSource(video);
          video.__gachaSourceNode__ = sourceNode;
        } catch (e) {
          sourceNode = video.__gachaSourceNode__ || attachedMediaSource;
        }
      }

      // 3. Track the active source. applyVolumeBoostGain chooses a transparent
      // direct route at 1x and the DSP chain only above 1x.
      if (sourceNode && gainNode) {
        attachedMediaSource = sourceNode;
        attachedVideoElement = video;
      }

      applyVolumeBoostGain(false);
      ensureAudioContextResumed();

      // 4. Attach continuous audio resumption listeners to the video element
      if (!video.__gachaAudioHooksAttached__) {
        video.__gachaAudioHooksAttached__ = true;
        const resumeEvents = ["play", "playing", "timeupdate", "loadeddata", "volumechange", "canplay"];
        resumeEvents.forEach((evt) => {
          video.addEventListener(evt, ensureAudioContextResumed, { passive: true });
        });
      }

      // 5. Attach global interaction resume triggers once
      if (!window.__gachaAudioGlobalHooksAttached__) {
        window.__gachaAudioGlobalHooksAttached__ = true;
        ["pointerdown", "click", "keydown", "touchstart"].forEach((evt) => {
          window.addEventListener(evt, ensureAudioContextResumed, { passive: true, capture: true });
        });
      }
    } catch (e) {
      console.warn("[Gacha MV] Web Audio setup note:", e);
    }
  }

  function applyVolumeBoostGain(smooth = true) {
    if (!gainNode || !audioCtx) return;
    const boostVal = settings.enabled && typeof settings.volumeBoost === "number" ? settings.volumeBoost : 100;
    const multiplier = Math.max(1, Math.min(10, boostVal / 100)); // 1.0 to 10.0

    ensureAudioContextResumed();

    if (compressorNode) {
      // Dynamic threshold scaling:
      // At 1x (100%): threshold is -6dB
      // At 10x (1000%): threshold is -18dB (anti-clipping compression)
      const dynThreshold = -6 - (multiplier - 1) * (12 / 9);
      if (smooth) {
        compressorNode.threshold.setTargetAtTime(dynThreshold, audioCtx.currentTime, 0.05);
      } else {
        compressorNode.threshold.setValueAtTime(dynThreshold, audioCtx.currentTime);
      }
    }

    if (smooth) {
      gainNode.gain.setTargetAtTime(multiplier, audioCtx.currentTime, 0.03);
    } else {
      gainNode.gain.setValueAtTime(multiplier, audioCtx.currentTime);
    }

    if (attachedMediaSource) {
      try { attachedMediaSource.disconnect(); } catch (_) {}
      try {
        attachedMediaSource.connect(multiplier <= 1 ? audioCtx.destination : gainNode);
      } catch (e) {
        console.warn("[Gacha MV] Web Audio routing error:", e);
      }
    }
  }

  async function setVolumeBoost(newVal, showToastMsg = false) {
    const clamped = Math.max(100, Math.min(1000, Math.round(newVal)));
    settings.volumeBoost = clamped;
    await extStorage.set({ volumeBoost: clamped });

    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (video) {
      setupAudioBooster(video);
      applyVolumeBoostGain();
    }

    updateInpageVolumeBoostUI();

    if (showToastMsg) {
      const mult = (clamped / 100).toFixed(clamped % 100 === 0 ? 1 : 2);
      showVolumeToast(`🔊 Volume Boost: ${clamped}% (${mult}x) 🛡️`);
    }
  }

  function showVolumeToast(text) {
    let toast = document.getElementById("gacha-vol-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "gacha-vol-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.remove("fade-out");
    toast.classList.add("visible");

    if (volumeToastTimer) clearTimeout(volumeToastTimer);
    volumeToastTimer = setTimeout(() => {
      if (toast) {
        toast.classList.add("fade-out");
        setTimeout(() => toast.classList.remove("visible", "fade-out"), 300);
      }
    }, 1500);
  }

  let volumeHotkeysAttached = false;
  function setupVolumeHotkeys() {
    if (volumeHotkeysAttached) return;
    volumeHotkeysAttached = true;
    window.addEventListener(
      "keydown",
      (e) => {
        if (!settings.enabled) return;
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;

        if (e.shiftKey && (e.key === "ArrowUp" || e.key === "Up")) {
          e.preventDefault();
          e.stopPropagation();
          const cur = settings.volumeBoost || 100;
          setVolumeBoost(cur + 50, true);
        } else if (e.shiftKey && (e.key === "ArrowDown" || e.key === "Down")) {
          e.preventDefault();
          e.stopPropagation();
          const cur = settings.volumeBoost || 100;
          setVolumeBoost(cur - 50, true);
        }
      },
      true
    );
  }

  function injectPlayerBarBoostControl() {
    if (!settings.enabled) {
      const existingBtn = document.getElementById("gachaYtBoostContainer");
      if (existingBtn) existingBtn.remove();
      const existingPop = document.getElementById("gachaYtBoostPopover");
      if (existingPop) existingPop.remove();
      return;
    }

    const leftControls = document.querySelector(".ytp-left-controls");
    const player = document.querySelector("#movie_player, .html5-video-player");
    if (!leftControls || !player) return;

    // 1. Inject / Update Button in Player Controls
    let boostContainer = document.getElementById("gachaYtBoostContainer");
    if (!boostContainer) {
      boostContainer = document.createElement("div");
      boostContainer.id = "gachaYtBoostContainer";
      boostContainer.className = "gacha-yt-boost-container";
      appendTrustedHtml(boostContainer, `
        <button type="button" class="ytp-button gacha-yt-boost-btn" id="gachaYtBoostBtn" title="Gacha Volume Booster (Shift+Up/Down)">
          <span class="gacha-yt-boost-icon">🔊</span>
          <span class="gacha-yt-boost-badge" id="gachaYtBoostBadge">100%</span>
        </button>
      `);

      const volArea = leftControls.querySelector(".ytp-volume-area");
      if (volArea && volArea.nextSibling) {
        leftControls.insertBefore(boostContainer, volArea.nextSibling);
      } else {
        leftControls.appendChild(boostContainer);
      }
    }

    // 2. Inject Popover directly into the Video Player root (#movie_player) so it is NEVER clipped by overflow:hidden
    let popover = document.getElementById("gachaYtBoostPopover");
    if (!popover || !player.contains(popover)) {
      if (popover) popover.remove();
      popover = document.createElement("div");
      popover.id = "gachaYtBoostPopover";
      popover.className = "gacha-yt-boost-popover";
      appendTrustedHtml(popover, `
        <div class="gacha-yt-boost-pop-header">
          <div class="gacha-yt-boost-pop-title">
            <span>🔊 Volume Booster</span>
            <span class="gacha-yt-boost-limiter">🛡️ Anti-Distortion</span>
          </div>
          <span class="gacha-yt-boost-pop-val" id="gachaYtBoostPopVal">100% (1.0x)</span>
        </div>
        <div class="gacha-yt-boost-slider-wrap">
          <input type="range" class="gacha-yt-boost-range" id="gachaYtBoostRange" min="100" max="1000" step="10" value="100" />
          <div class="gacha-yt-boost-ticks">
            <span>1x</span>
            <span>3x</span>
            <span>5x</span>
            <span>8x</span>
            <span>10x</span>
          </div>
        </div>
        <div class="gacha-yt-boost-presets">
          <button type="button" class="gacha-yt-preset-chip active" data-boost="100">1x</button>
          <button type="button" class="gacha-yt-preset-chip" data-boost="200">2x</button>
          <button type="button" class="gacha-yt-preset-chip" data-boost="400">4x</button>
          <button type="button" class="gacha-yt-preset-chip" data-boost="600">6x</button>
          <button type="button" class="gacha-yt-preset-chip" data-boost="1000">10x MAX</button>
          <button type="button" class="gacha-yt-preset-reset" id="gachaYtBoostReset">↩️ Reset</button>
        </div>
      `);
      player.appendChild(popover);

      // Bind Popover events
      const range = popover.querySelector("#gachaYtBoostRange");
      const chips = popover.querySelectorAll(".gacha-yt-preset-chip");
      const resetBtn = popover.querySelector("#gachaYtBoostReset");

      if (range) {
        range.addEventListener("input", (e) => {
          setVolumeBoost(parseInt(e.target.value, 10));
        });
      }

      chips.forEach((chip) => {
        chip.addEventListener("click", () => {
          const b = parseInt(chip.getAttribute("data-boost"), 10);
          if (!isNaN(b)) setVolumeBoost(b);
        });
      });

      if (resetBtn) {
        resetBtn.addEventListener("click", () => setVolumeBoost(100));
      }

      popover.addEventListener("click", (e) => e.stopPropagation());
    }

    // Bind Button Click
    const boostBtn = boostContainer.querySelector("#gachaYtBoostBtn");
    if (boostBtn) {
      boostBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();

        const currentPop = document.getElementById("gachaYtBoostPopover");
        if (!currentPop) return;

        const isCurrentlyOpen = currentPop.classList.contains("gacha-open");
        if (isCurrentlyOpen) {
          currentPop.classList.remove("gacha-open");
        } else {
          // Position relative to player
          const pRect = player.getBoundingClientRect();
          const bRect = boostBtn.getBoundingClientRect();

          const leftPos = Math.max(12, Math.min(pRect.width - 270, bRect.left - pRect.left - 20));
          const bottomPos = Math.max(52, pRect.bottom - bRect.top + 10);

          currentPop.style.left = `${leftPos}px`;
          currentPop.style.bottom = `${bottomPos}px`;
          currentPop.classList.add("gacha-open");
        }
      };
    }

    // Global outside click handler
    if (!window.__gachaYtBoostGlobalClickAttached__) {
      window.__gachaYtBoostGlobalClickAttached__ = true;
      document.addEventListener("click", (e) => {
        const pop = document.getElementById("gachaYtBoostPopover");
        const btn = document.getElementById("gachaYtBoostBtn");
        if (pop && pop.classList.contains("gacha-open")) {
          if (!pop.contains(e.target) && (!btn || !btn.contains(e.target))) {
            pop.classList.remove("gacha-open");
          }
        }
      });
    }

    updateInpageVolumeBoostUI();
  }

  function updateInpageVolumeBoostUI() {
    const boost = Math.max(100, Math.min(1000, Math.round(settings.volumeBoost || 100)));
    const mult = (boost / 100).toFixed(boost % 100 === 0 ? 1 : 2);
    const label = `${boost}% (${mult}x)`;

    // Player bar
    const badge = document.getElementById("gachaYtBoostBadge");
    if (badge) badge.textContent = `${boost}%`;

    const popVal = document.getElementById("gachaYtBoostPopVal");
    if (popVal) popVal.textContent = label;

    const range = document.getElementById("gachaYtBoostRange");
    if (range) range.value = boost;

    const ytChips = document.querySelectorAll(".gacha-yt-preset-chip");
    ytChips.forEach((c) => {
      const b = parseInt(c.getAttribute("data-boost"), 10);
      c.classList.toggle("active", b === boost);
    });

    // Jukebox Widget Tab 1
    const inpageBadge = document.getElementById("inpageVolumeBadge");
    if (inpageBadge) inpageBadge.textContent = label;

    const inpageSlider = document.getElementById("inpageVolumeSlider");
    if (inpageSlider) inpageSlider.value = boost;

    const inpageChips = document.querySelectorAll(".inpage-vol-preset");
    inpageChips.forEach((c) => {
      const b = parseInt(c.getAttribute("data-boost"), 10);
      c.classList.toggle("active", b === boost);
    });
  }

  // ==========================================================
  // Auto-Unmute Audio Engine & Manual Mute Detection
  // ==========================================================
  let manualMuteListenersAttached = false;

  function setupManualMuteDetection() {
    if (manualMuteListenersAttached) return;
    manualMuteListenersAttached = true;

    document.addEventListener(
      "click",
      (e) => {
        if (!e.isTrusted) return;
        const muteBtn = e.target.closest(
          ".ytp-mute-button, .ytm-mute-button, button[aria-label*='Mute' i], button[aria-label*='mute' i], button[title*='Mute' i], button[title*='mute' i]"
        );
        if (muteBtn) {
          setTimeout(() => {
            const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
            const player = document.getElementById("movie_player");
            const isMuted = (video && video.muted) || (player && typeof player.isMuted === "function" && player.isMuted());
            const vid = getCurrentVideoId();
            if (isMuted) {
              userManuallyMutedForVideoId = vid;
            } else {
              userManuallyMutedForVideoId = "";
            }
          }, 80);
        }
      },
      true
    );

    document.addEventListener(
      "keydown",
      (e) => {
        if (!e.isTrusted) return;
        if (e.key === "m" || e.key === "M") {
          const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : "";
          if (tag === "input" || tag === "textarea" || (e.target && e.target.isContentEditable)) return;
          setTimeout(() => {
            const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
            const player = document.getElementById("movie_player");
            const isMuted = (video && video.muted) || (player && typeof player.isMuted === "function" && player.isMuted());
            const vid = getCurrentVideoId();
            if (isMuted) {
              userManuallyMutedForVideoId = vid;
            } else {
              userManuallyMutedForVideoId = "";
            }
          }, 80);
        }
      },
      true
    );
  }

  let isContinuousListeningSession = false;

  function isWatchPage() {
    const p = window.location.pathname;
    return Boolean(
      p.startsWith("/watch") ||
      p.startsWith("/shorts") ||
      (new URLSearchParams(window.location.search)).get("v")
    );
  }

  function armUserGestureUnmute(targetVideoId) {
    if (gestureUnmuteArmed) return;
    gestureUnmuteArmed = true;

    const onUserGesture = () => {
      window.removeEventListener("pointerdown", onUserGesture, true);
      window.removeEventListener("click", onUserGesture, true);
      window.removeEventListener("touchstart", onUserGesture, true);
      window.removeEventListener("keydown", onUserGesture, true);
      gestureUnmuteArmed = false;

      // User has interacted: mark continuous session active
      isContinuousListeningSession = true;

      // Programmatically unmute immediately during user activation without dispatching synthetic clicks
      const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
      const player = document.getElementById("movie_player");
      if (video && video.muted) {
        try { video.muted = false; } catch (e) {}
      }
      if (player && typeof player.unMute === "function") {
        try { player.unMute(); } catch (e) {}
      }
      if (player && typeof player.setVolume === "function" && typeof player.getVolume === "function" && player.getVolume() === 0) {
        try { player.setVolume(100); } catch (e) {}
      }

      const isReallyStillMuted = video?.muted || (player && typeof player.isMuted === "function" && player.isMuted());
      if (!isReallyStillMuted && isWatchPage()) {
        const now = Date.now();
        const currentVid = targetVideoId || getCurrentVideoId();
        if (lastAutoUnmutedVideoId !== currentVid || now - lastAutoUnmuteToastTime > 6000) {
          lastAutoUnmuteToastTime = now;
          lastAutoUnmutedVideoId = currentVid;
          showToast("🔊 Auto-Unmuted 🌸");
        }
      }
    };

    window.addEventListener("pointerdown", onUserGesture, { capture: true, once: true });
    window.addEventListener("click", onUserGesture, { capture: true, once: true });
    window.addEventListener("touchstart", onUserGesture, { capture: true, once: true });
    window.addEventListener("keydown", onUserGesture, { capture: true, once: true });
  }

  function attemptAutoUnmute(reason = "") {
    if (!settings.enabled || settings.autoUnmute === false) return;
    if (wasAdPlaying) return;

    // 1. STRICT SCOPE: Only execute on actual watch/shorts pages. NEVER on Homepage, Search results, or Feeds!
    if (!isWatchPage()) return;

    const currentVid = getCurrentVideoId();
    if (!currentVid) return;

    if (userManuallyMutedForVideoId && userManuallyMutedForVideoId === currentVid) {
      return;
    }

    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    const player = document.getElementById("movie_player");
    if (!video) return;

    const wasMuted = video.muted || (player && typeof player.isMuted === "function" && player.isMuted());
    if (!wasMuted) {
      // Video is playing with sound on watch page: continuous session is active
      isContinuousListeningSession = true;
      return;
    }

    // 2. Fresh entry from Home or Search: do not blast unmuted audio automatically!
    // Exception: APK (AndroidBridge) and m.youtube.com — the user already tapped to open YouTube,
    // so treat as a continuous session immediately and auto-unmute without waiting for a gesture.
    const isMobileContext = Boolean(window.AndroidBridge) || window.location.host === "m.youtube.com";
    if (!isContinuousListeningSession && !isMobileContext) {
      armUserGestureUnmute(currentVid);
      return;
    }
    if (isMobileContext) {
      isContinuousListeningSession = true;
    }

    // 3. Continuous autoplay / next video: proceed with safe auto-unmute
    const wasPausedBefore = video.paused;

    try {
      video.muted = false;
    } catch (e) {}

    if (player && typeof player.unMute === "function") {
      try {
        player.unMute();
      } catch (e) {}
    }

    if (player && typeof player.setVolume === "function" && typeof player.getVolume === "function" && player.getVolume() === 0) {
      try {
        player.setVolume(100);
      } catch (e) {}
    }

    // Check if floating overlay on mobile / embed needs to be clicked (never click desktop player bar buttons!)
    const isStillMuted = video.muted || (player && typeof player.isMuted === "function" && player.isMuted());
    if (isStillMuted) {
      const mobileUnmuteOverlays = document.querySelectorAll(
        ".ytp-unmute:not(.ytp-mute-button), .player-unmute, .ytm-unmute"
      );
      mobileUnmuteOverlays.forEach((btn) => {
        if (typeof btn.click === "function") {
          try { btn.click(); } catch (e) {}
        }
      });
    }

    // CRITICAL: Check if unmuting caused the browser Autoplay Policy to immediately pause the video!
    if (!wasPausedBefore && video.paused) {
      // Browser rejected unmuted autoplay. Immediately restore muted state to keep video playing smoothly!
      video.muted = true;
      const playProm = video.play();
      if (playProm !== undefined) {
        playProm.catch(() => {});
      }
      armUserGestureUnmute(currentVid);
      return;
    }

    const isReallyStillMuted = video.muted || (player && typeof player.isMuted === "function" && player.isMuted());
    if (!isReallyStillMuted) {
      isContinuousListeningSession = true;
      const now = Date.now();
      if (lastAutoUnmutedVideoId !== currentVid || now - lastAutoUnmuteToastTime > 6000) {
        lastAutoUnmuteToastTime = now;
        lastAutoUnmutedVideoId = currentVid;
        showToast("🔊 Auto-Unmuted 🌸");
      }
    } else {
      armUserGestureUnmute(currentVid);
    }
  }

  // ==========================================================
  // Video Auto-Play Recovery Engine
  // ==========================================================
  function attemptAutoplayRecovery(reason = "") {
    if (!settings.enabled) return;
    if (window.__gachaUserManuallyPaused) return;

    const isWatch = window.location.pathname.startsWith("/watch") || window.location.pathname.startsWith("/shorts");
    if (!isWatch) return;

    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    const moviePlayer = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
    if (!video) return;

    // If video is already playing or ended, nothing to recover
    if (!video.paused || video.ended) return;

    // Only auto-play if at the beginning of the video (within first 3 seconds) or newly loaded
    if (video.currentTime > 3.0) return;

    // 1. Try moviePlayer API first
    if (moviePlayer && typeof moviePlayer.playVideo === "function") {
      try {
        moviePlayer.playVideo();
      } catch (_) {}
    }

    // 2. Call video.play() with browser autoplay policy handling
    try {
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          // If browser autoplay policy blocked unmuted playback (NotAllowedError):
          // Start playing muted so playback continues without freezing, then arm gesture unmute!
          if (!video.muted) {
            video.muted = true;
            video.play().catch(() => {});
            armUserGestureUnmute(getCurrentVideoId());
          }

          // Fallback: tap the YouTube player play button
          const playBtn = document.querySelector(
            ".ytp-play-button, .player-controls-play-pause, [data-testid='play-button'], button.ytp-play-button"
          );
          if (playBtn && typeof playBtn.click === "function") {
            try { playBtn.click(); } catch (_) {}
          }
        });
      }
    } catch (_) {}
  }

  window.__gachaAutoplayRecovery = attemptAutoplayRecovery;

  // ==========================================================
  // Preferred Video Resolution Engine
  // ==========================================================
  // ==========================================================
  // Preferred Video Resolution Engine
  // ==========================================================
  const QUALITY_HEIGHT_MAP = {
    highres: 4320,
    hd2880: 2880,
    hd2160: 2160,
    "4k": 2160,
    "2160p": 2160,
    hd1440: 1440,
    "2k": 1440,
    "1440p": 1440,
    hd1080: 1080,
    "1080p": 1080,
    hd720: 720,
    "720p": 720,
    large: 480,
    "480p": 480,
    medium: 360,
    "360p": 360,
    small: 240,
    "240p": 240,
    tiny: 144,
    "144p": 144
  };

  let lastAppliedResVideoId = "";
  let lastAppliedResChoice = "";
  let qualityAttemptedForVideoId = "";
  let isAutomatingQuality = false;

  function ensureStealthQualityStyle() {
    if (!document.getElementById("gacha-quality-stealth-style")) {
      const s = document.createElement("style");
      s.id = "gacha-quality-stealth-style";
      s.textContent = `
        .gacha-stealth-quality-active .ytp-popup.ytp-settings-menu,
        .gacha-stealth-quality-active .ytp-settings-menu {
          opacity: 0 !important;
          pointer-events: auto !important;
        }
      `;
      (document.head || document.documentElement).appendChild(s);
    }
  }

  function simulateClick(element) {
    if (!element) return;
    try {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      element.click();
    } catch (e) {
      try { element.click(); } catch (err) {}
    }
  }

  function switchQualityViaMenu(targetHeight) {
    if (isAutomatingQuality || wasAdPlaying) return;
    const settingsBtn = document.querySelector(".ytp-settings-button");
    const player = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
    if (!settingsBtn || !player) return;

    // Do not interfere if user is currently looking at the settings menu
    if (settingsBtn.getAttribute("aria-expanded") === "true") return;

    isAutomatingQuality = true;
    ensureStealthQualityStyle();
    player.classList.add("gacha-stealth-quality-active");

    const cleanup = () => {
      const menu = document.querySelector(".ytp-popup.ytp-settings-menu, .ytp-settings-menu");
      const isVisible = menu && (menu.style.display !== "none" && getComputedStyle(menu).display !== "none");
      if (settingsBtn.getAttribute("aria-expanded") === "true" && isVisible) {
        settingsBtn.click();
      }
      player.classList.remove("gacha-stealth-quality-active");
      isAutomatingQuality = false;
    };

    try {
      // 1. Open settings menu
      settingsBtn.click();

      // 2. Poll for main settings menu items (up to 24 attempts * 25ms = 600ms)
      let openAttempts = 0;
      const openInterval = setInterval(() => {
        openAttempts++;
        const menuItems = Array.from(document.querySelectorAll(".ytp-settings-menu .ytp-menuitem"));
        let qualityItem = null;

        for (const item of menuItems) {
          const text = (item.textContent || "").toLowerCase();
          if (
            text.includes("quality") ||
            text.includes("calidad") ||
            text.includes("qualité") ||
            text.includes("qualität") ||
            text.includes("qualità") ||
            text.includes("qualidade") ||
            text.includes("画质") ||
            text.includes("畫質") ||
            text.includes("画質") ||
            text.includes("화질") ||
            text.includes("качество") ||
            /\b\d{3,4}p\b/i.test(text)
          ) {
            qualityItem = item;
            break;
          }
        }

        if (qualityItem || openAttempts >= 24) {
          clearInterval(openInterval);
          if (!qualityItem) {
            cleanup();
            return;
          }

          // 3. Click Quality menuitem to open resolutions sub-panel
          qualityItem.click();

          // 4. Poll for resolution sub-panel options (up to 28 attempts * 25ms = 700ms)
          let subAttempts = 0;
          let clickedAdvanced = false;
          const subInterval = setInterval(() => {
            subAttempts++;

            // Isolate submenu items: prefer [role="menuitemradio"], fallback to non-popup items in last panel
            let subItems = Array.from(document.querySelectorAll(".ytp-settings-menu [role='menuitemradio']"));
            if (subItems.length === 0) {
              const panels = document.querySelectorAll(".ytp-settings-menu .ytp-panel");
              if (panels.length > 1) {
                subItems = Array.from(panels[panels.length - 1].querySelectorAll(".ytp-menuitem:not([aria-haspopup='true'])"));
              }
            }

            // Check for intermediate "Advanced" menu item on mobile/new YouTube layouts
            if (!clickedAdvanced && subItems.length > 0 && !subItems.some((el) => /\b\d{3,4}p\b|4k|2k/i.test(el.textContent || ""))) {
              const advItem = subItems.find((el) => {
                const t = (el.textContent || "").toLowerCase();
                return (
                  t.includes("advanced") ||
                  t.includes("avanzada") ||
                  t.includes("avancée") ||
                  t.includes("erweitert") ||
                  t.includes("avanzate") ||
                  t.includes("avançado") ||
                  t.includes("高级") ||
                  t.includes("高級") ||
                  t.includes("詳細設定") ||
                  t.includes("고급")
                );
              });
              if (advItem) {
                clickedAdvanced = true;
                advItem.click();
                return;
              }
            }

            const resOptions = [];
            for (const item of subItems) {
              const text = (item.textContent || "").trim();

              // CRITICAL: Auto must be identified first! YouTube displays "Auto (1080p HD)" or "Auto (720p)"
              // which contains resolution numbers like 1080p, but represents the Auto setting.
              const isAuto = /auto|automático|automatique|automatisch|авто/i.test(text);
              if (isAuto) {
                resOptions.push({
                  item,
                  height: 0,
                  isAuto: true,
                  isPremium: false,
                  text
                });
                continue;
              }

              let height = 0;
              const pMatch = text.match(/(\d{3,4})p/i);
              if (pMatch) {
                height = parseInt(pMatch[1], 10);
              } else if (/\b4k\b/i.test(text)) {
                height = 2160;
              } else if (/\b2k\b/i.test(text)) {
                height = 1440;
              }

              if (height > 0) {
                resOptions.push({
                  item,
                  height,
                  isPremium: /premium/i.test(text),
                  text
                });
              }
            }

            if (resOptions.some((o) => o.height > 0) || subAttempts >= 28) {
              clearInterval(subInterval);

              const valid = resOptions.filter((o) => o.height > 0);
              let chosenItem = null;
              let chosenHeight = 0;
              let fallbackNotice = "";

              if (targetHeight === 0) {
                // Auto requested
                chosenItem = resOptions.find((o) => o.isAuto)?.item || null;
              } else if (valid.length > 0) {
                // Sort descending: highest resolution first (2160, 1440, 1080, 720, ...)
                // Prioritize Premium when heights are equal (e.g. 1080p Premium vs standard 1080p)
                valid.sort((a, b) => {
                  if (b.height !== a.height) return b.height - a.height;
                  if (a.isPremium && !b.isPremium) return -1;
                  if (!a.isPremium && b.isPremium) return 1;
                  return 0;
                });

                // 1. Exact match (prefer Premium over standard if available per user choice)
                const exact = valid.filter((o) => o.height === targetHeight);
                if (exact.length > 0) {
                  const prem = exact.find((o) => o.isPremium);
                  const selected = prem || exact[0];
                  chosenItem = selected.item;
                  chosenHeight = selected.height;
                } else if (targetHeight >= valid[0].height) {
                  // 2. Target higher than highest available -> choose highest available! (e.g. 4K requested, max 1080p)
                  chosenItem = valid[0].item;
                  chosenHeight = valid[0].height;
                  if (valid[0].height < targetHeight) {
                    fallbackNotice = `📺 ${valid[0].height}p (Max available)`;
                  }
                } else {
                  // 3. Target lower than highest -> choose highest available <= targetHeight
                  const below = valid.filter((o) => o.height <= targetHeight);
                  const selected = below.length > 0 ? below[0] : valid[valid.length - 1];
                  chosenItem = selected.item;
                  chosenHeight = selected.height;
                }
              }

              if (chosenItem) {
                simulateClick(chosenItem);
                const currentVid = getCurrentVideoId();
                if (currentVid) {
                  qualityAttemptedForVideoId = currentVid;
                  lastAppliedResVideoId = currentVid;
                }
                if (chosenHeight > 0) {
                  lastAppliedResChoice = `${chosenHeight}p`;
                }
                if (fallbackNotice) {
                  showToast(fallbackNotice);
                }
              }

              setTimeout(cleanup, 60);
            }
          }, 25);
        }
      }, 25);
    } catch (e) {
      cleanup();
    }
  }

  function handleVideoMetadataForQuality() {
    applyPreferredResolution("metadata-loaded");
  }

  function applyPreferredResolution(reason = "") {
    if (!settings.enabled || wasAdPlaying) return;
    const target = (settings.preferredResolution || "auto").toLowerCase().trim();
    const currentVid = getCurrentVideoId();
    if (!currentVid) return;

    const player = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (!player) return;

    if (target === "auto") {
      if (lastAppliedResVideoId === currentVid && lastAppliedResChoice === "auto") return;
      if (typeof player.setPlaybackQualityRange === "function") {
        try { player.setPlaybackQualityRange("auto", "auto"); } catch (e) {}
      }
      if (typeof player.setPlaybackQuality === "function") {
        try { player.setPlaybackQuality("auto"); } catch (e) {}
      }
      qualityAttemptedForVideoId = currentVid;
      lastAppliedResVideoId = currentVid;
      lastAppliedResChoice = "auto";
      return;
    }

    const targetHeight = parseInt(target, 10);
    if (isNaN(targetHeight)) return;

    // Fast path: if video is already running at target height, no action needed
    if (video && video.videoHeight && video.videoHeight === targetHeight) {
      qualityAttemptedForVideoId = currentVid;
      lastAppliedResVideoId = currentVid;
      lastAppliedResChoice = `${targetHeight}p`;
      return;
    }

    // Single-attempt per video guard to prevent repeated menu opening loops
    const isManualChange = reason === "drawer-change" || reason === "popup-change" || reason === "storage-changed" || reason === "user-select";
    if (!isManualChange && qualityAttemptedForVideoId === currentVid) {
      return;
    }

    let levels = [];
    if (typeof player.getAvailableQualityLevels === "function") {
      try {
        levels = player.getAvailableQualityLevels() || [];
      } catch (e) {}
    } else if (typeof player.getAvailableQualityData === "function") {
      try {
        const data = player.getAvailableQualityData() || [];
        levels = data.map((d) => (d && typeof d === "object" ? (d.quality || d.qualityLabel) : d));
      } catch (e) {}
    }

    const validLevels = [];
    if (Array.isArray(levels)) {
      levels.forEach((lvl) => {
        if (!lvl || lvl === "auto") return;
        const code = typeof lvl === "string" ? lvl : (lvl.quality || "");
        if (!code || code === "auto") return;
        let height = QUALITY_HEIGHT_MAP[code];
        if (!height) {
          const match = String(code).match(/(\d+)/);
          if (match) height = parseInt(match[1], 10);
        }
        if (height && !isNaN(height)) {
          if (!validLevels.some((item) => item.code === code)) {
            validLevels.push({ code, height });
          }
        }
      });
    }

    let chosenCode = "";
    if (validLevels.length > 0) {
      validLevels.sort((a, b) => b.height - a.height);
      const exact = validLevels.find((l) => l.height === targetHeight);
      if (exact) {
        chosenCode = exact.code;
      } else if (targetHeight >= validLevels[0].height) {
        chosenCode = validLevels[0].code;
      } else {
        const below = validLevels.filter((l) => l.height <= targetHeight);
        chosenCode = below.length > 0 ? below[0].code : validLevels[validLevels.length - 1].code;
      }
    }

    if (lastAppliedResVideoId === currentVid && lastAppliedResChoice === (chosenCode || `${targetHeight}p`)) {
      return;
    }

    try {
      if (chosenCode && typeof player.setPlaybackQualityRange === "function") {
        player.setPlaybackQualityRange(chosenCode, chosenCode);
      }
      if (chosenCode && typeof player.setPlaybackQuality === "function") {
        player.setPlaybackQuality(chosenCode);
      }
      try {
        const qualityPref = JSON.stringify({
          data: chosenCode || (targetHeight >= 2160 ? "hd2160" : targetHeight >= 1440 ? "hd1440" : `hd${targetHeight}`),
          expiration: Date.now() + 30 * 24 * 60 * 60 * 1000,
          creation: Date.now()
        });
        window.localStorage.setItem("yt-player-quality", qualityPref);
      } catch (e) {}
    } catch (e) {}

    // Modern YouTube DASH streaming requires DOM-based quality menu automation
    switchQualityViaMenu(targetHeight);
  }

  // ==========================================================
  // YouTube Video & Cosmetic Ad Blocker Engine
  // ==========================================================
  let wasAdPlaying = false;
  let userMutedStateBeforeAd = false;
  let userPlaybackRateBeforeAd = 1;
  let adBlockerInterval = null;

  function dismissEnforcementModals() {
    const enforcementModals = document.querySelectorAll(
      "ytd-enforcement-message-view-model, tp-yt-paper-dialog:has(ytd-enforcement-message-view-model), yt-playability-error-supported-renderers:has(ytd-enforcement-message-view-model)"
    );
    if (enforcementModals.length > 0) {
      enforcementModals.forEach((modal) => {
        const dialog = modal.closest("tp-yt-paper-dialog") || modal;
        dialog.remove();
      });
      document.querySelectorAll("tp-yt-iron-overlay-backdrop").forEach((b) => b.remove());
      const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
      if (video && video.paused) {
        video.play().catch(() => {});
      }
    }

    const popupDialogs = document.querySelectorAll("ytd-popup-container tp-yt-paper-dialog");
    popupDialogs.forEach((dialog) => {
      const text = (dialog.textContent || "").toLowerCase();
      if (
        text.includes("ad blockers violate") ||
        text.includes("ad blockers are not allowed") ||
        text.includes("allow youtube ads") ||
        text.includes("turn off your ad blocker")
      ) {
        dialog.remove();
        document.querySelectorAll("tp-yt-iron-overlay-backdrop").forEach((b) => b.remove());
        const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
        if (video && video.paused) {
          video.play().catch(() => {});
        }
      }
    });
  }

  function runAdBlockerCycle() {
    if (!settings.enabled || settings.blockAds === false) {
      if (wasAdPlaying) {
        wasAdPlaying = false;
        const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
        if (video) {
          video.muted = userMutedStateBeforeAd;
          video.playbackRate = userPlaybackRateBeforeAd;
        }
      }
      return;
    }

    const player = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");

    const isAdActive =
      Boolean(player && (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting"))) ||
      document.querySelector(".ytp-ad-player-overlay, .ytp-ad-module:not(:empty), .ytp-ad-text, .ytp-ad-preview-container") !== null;

    // Fast-path: When no ad is playing and wasn't playing, skip all heavy DOM queries
    if (!isAdActive && !wasAdPlaying) {
      if (document.querySelector("ytd-enforcement-message-view-model, yt-playability-error-supported-renderers:has(ytd-enforcement-message-view-model)")) {
        dismissEnforcementModals();
      }
      return;
    }

    // Dismiss Anti-Adblock Enforcement Modals & Overlays if present
    dismissEnforcementModals();

    if (isAdActive && video) {
      if (!wasAdPlaying) {
        wasAdPlaying = true;
        userMutedStateBeforeAd = video.muted;
        userPlaybackRateBeforeAd = video.playbackRate > 0 && video.playbackRate <= 4 ? video.playbackRate : 1;
      }

      // Silence audio during ads
      if (!video.muted) {
        video.muted = true;
      }

      // Fast forward at 16x speed
      if (video.playbackRate !== 16) {
        video.playbackRate = 16.0;
      }

      // Jump to the end of the ad if valid duration is present
      if (!isNaN(video.duration) && isFinite(video.duration) && video.duration > 0) {
        video.currentTime = video.duration;
      }

      // Auto-click all YouTube skip button variants
      const skipSelectors = [
        ".ytp-ad-skip-button",
        ".ytp-ad-skip-button-modern",
        ".ytp-skip-ad-button",
        ".ytp-ad-skip-button-slot button",
        "button.ytp-ad-skip-button",
        "button.ytp-ad-skip-button-modern",
        ".ytp-ad-skip-button-container button"
      ];
      for (const sel of skipSelectors) {
        const btns = document.querySelectorAll(sel);
        btns.forEach((btn) => {
          if (typeof btn.click === "function") {
            btn.click();
          }
        });
      }

      // Auto-close banner / overlay ads inside the player
      const overlayCloseSelectors = [
        ".ytp-ad-overlay-close-button",
        "button.ytp-ad-overlay-close-button",
        ".ytp-ad-overlay-close-container button"
      ];
      for (const sel of overlayCloseSelectors) {
        const btns = document.querySelectorAll(sel);
        btns.forEach((btn) => {
          if (typeof btn.click === "function") {
            btn.click();
          }
        });
      }
    } else if (wasAdPlaying && video) {
      // Main video returned, restore audio and playback rate
      wasAdPlaying = false;
      const currentVid = getCurrentVideoId();
      if (settings.autoUnmute !== false && userManuallyMutedForVideoId !== currentVid) {
        video.muted = false;
        attemptAutoUnmute("ad-finish");
      } else {
        video.muted = userMutedStateBeforeAd;
      }
      video.playbackRate = userPlaybackRateBeforeAd;
    }
  }

  // ==========================================================
  // Auto-confirm YouTube "Are you still watching?" / "Continue watching?"
  // ==========================================================
  const STILL_WATCHING_PHRASES = [
    "continue watching",
    "still watching",
    "still there",
    "video paused",
    "are you watching",
    "are you still there"
  ];
  const STILL_WATCHING_CONFIRM_LABELS = new Set([
    "yes",
    "continue",
    "watch",
    "ok",
    "okay",
    "continue watching",
    "watch as usual"
  ]);
  let lastStillWatchingDismissAt = 0;
  let stillWatchingObserver = null;
  let stillWatchingRaf = false;

  function textLooksLikeStillWatching(text) {
    const t = (text || "").toLowerCase();
    return STILL_WATCHING_PHRASES.some((phrase) => t.includes(phrase));
  }

  function isUsableOverlay(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function clickStillWatchingConfirm(root) {
    const selectors = [
      "#confirm-button button",
      "#confirm-button yt-button-shape button",
      "yt-button-renderer#confirm-button button",
      "#confirm-button",
      "button[aria-label='Yes']",
      "button[aria-label='Continue watching']",
      "button[aria-label='Continue']",
      ".ytp-confirm-dialog-button"
    ];
    for (const sel of selectors) {
      const btn = root.querySelector(sel);
      if (btn && isUsableOverlay(btn) && typeof btn.click === "function") {
        btn.click();
        return true;
      }
    }

    const buttons = root.querySelectorAll("button, yt-button-shape, tp-yt-paper-button, ytm-button-renderer, .yt-spec-button-shape-next");
    for (const btn of buttons) {
      const label = (btn.getAttribute("aria-label") || btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!STILL_WATCHING_CONFIRM_LABELS.has(label)) {
        continue;
      }
      const clickable = btn.matches("button, [role='button']") ? btn : (btn.querySelector("button, [role='button']") || btn);
      if (typeof clickable.click === "function") {
        clickable.click();
        return true;
      }
    }
    return false;
  }

  function resumeMainVideo() {
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (video && video.paused) {
      video.play().catch(() => {});
    }
  }

  function dismissStillWatchingPrompt() {
    if (!settings.enabled) return;
    const now = Date.now();
    if (now - lastStillWatchingDismissAt < 400) return;

    const dialogs = document.querySelectorAll(
      "yt-confirm-dialog-renderer, ytm-confirmation-dialog-renderer, ytm-confirm-dialog-renderer, ytd-modal-with-title-and-button-renderer, ytm-modal-with-title-and-button-renderer, .ytp-popup.ytp-confirm-dialog, tp-yt-paper-dialog.ytd-popup-container"
    );

    let dismissed = false;
    dialogs.forEach((dialog) => {
      if (dismissed || !isUsableOverlay(dialog)) return;
      if (dialog.closest(".ytp-settings-menu, #gacha-floating-widget, #gachaJukeboxPanel")) return;
      if (!textLooksLikeStillWatching(dialog.textContent)) return;
      if (clickStillWatchingConfirm(dialog)) dismissed = true;
    });

    if (dismissed) {
      lastStillWatchingDismissAt = now;
      document.querySelectorAll("tp-yt-iron-overlay-backdrop, ytm-popup-container .overlay-backdrop").forEach((backdrop) => {
        if (isUsableOverlay(backdrop) && !backdrop.closest("#gacha-floating-widget, #gachaJukeboxPanel")) {
          backdrop.remove();
        }
      });
      resumeMainVideo();
    }
  }

  function scheduleStillWatchingDismiss() {
    if (stillWatchingRaf) return;
    stillWatchingRaf = true;
    requestAnimationFrame(() => {
      stillWatchingRaf = false;
      dismissStillWatchingPrompt();
    });
  }

  function startStillWatchingGuard() {
    if (stillWatchingObserver) return;
    stillWatchingObserver = new MutationObserver(scheduleStillWatchingDismiss);
    const attach = () => {
      const root = document.documentElement || document.body;
      if (!root) return;
      stillWatchingObserver.observe(root, { childList: true, subtree: true });
      dismissStillWatchingPrompt();
    };
    if (document.body) attach();
    else document.addEventListener("DOMContentLoaded", attach, { once: true });
  }

  // ==========================================================
  // SponsorBlock (https://sponsor.ajay.app) & Custom DB Engine
  // ==========================================================
  function formatCategoryLabel(cat) {
    switch (cat) {
      case "poi_highlight":
        return "🌟 Highlight / Drop";
      case "music_offtopic":
        return "🎵 Non-Music / Dialogue";
      case "intro":
        return "🎬 Intro Scene";
      case "outro":
        return "🏁 Outro / Credits";
      case "sponsor":
        return "🛡️ Sponsor Segment";
      case "selfpromo":
        return "📢 Self Promotion";
      case "preview":
        return "🎞️ Preview / Recap";
      case "custom":
        return "✂️ Custom Skip";
      default:
        return "⚡ Skip Segment";
    }
  }

  function formatTime(sec) {
    if (isNaN(sec) || sec === null || sec === undefined) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  }

  async function fetchSponsorBlockSegments(videoId) {
    if (!settings.enabled || !settings.useSponsorBlockApi || !videoId) return [];
    try {
      const categories = [];
      if (settings.skipNonMusic) categories.push("music_offtopic");
      if (settings.skipIntroOutro) {
        categories.push("intro");
        categories.push("outro");
      }
      if (settings.skipSponsor) {
        categories.push("sponsor");
        categories.push("selfpromo");
        categories.push("preview");
      }
      if (settings.showPoiHighlights) {
        categories.push("poi_highlight");
      }

      if (categories.length === 0) return [];

      const url = `https://sponsor.ajay.app/api/skipSegments?videoID=${videoId}&categories=${encodeURIComponent(
        JSON.stringify(categories)
      )}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      if (!Array.isArray(data)) return [];

      return data.map((item, idx) => ({
        id: item.UUID || `sb_${item.category}_${item.segment[0]}_${idx}`,
        start: parseFloat(item.segment[0]),
        end: parseFloat(item.segment[1]),
        category: item.category,
        label: formatCategoryLabel(item.category),
        source: "sponsorblock"
      }));
    } catch (e) {
      return [];
    }
  }

  async function nasFetch(url, options = {}) {
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

  async function fetchNasSegments(videoId) {
    if (!settings.enabled || !settings.useNasServer || !settings.nasServerUrl || !videoId) return [];
    try {
      const baseUrl = settings.nasServerUrl.trim().replace(/\/+$/, "");
      const url = `${baseUrl}/api/skipSegments?videoID=${encodeURIComponent(videoId)}&_=${Date.now()}`;
      const res = await nasFetch(url);
      if (!res.ok || !Array.isArray(res.data)) return [];

      return res.data.map((item, idx) => ({
        id: item.UUID || item.id || `nas_${item.category}_${item.segment?.[0] || item.start}_${idx}`,
        start: parseFloat(item.segment ? item.segment[0] : item.start),
        end: parseFloat(item.segment ? item.segment[1] : item.end),
        category: item.category || "custom",
        label: item.label || formatCategoryLabel(item.category || "custom"),
        source: "nas"
      }));
    } catch (e) {
      return [];
    }
  }

  async function syncSegmentToNas(videoId, start, end, category = "custom", label = "", id = null) {
    if (!settings.useNasServer || !settings.nasAutoSync || !settings.nasServerUrl || !videoId) {
      return { ok: false, skipped: true };
    }
    try {
      const baseUrl = settings.nasServerUrl.trim().replace(/\/+$/, "");
      const res = await nasFetch(`${baseUrl}/api/skipSegments`, {
        method: "POST",
        body: { videoId, start, end, category, label, id }
      });
      if (res && res.ok) {
        console.log("[Gacha MV] ☁️ Segment pushed to NAS successfully:", res.data);
        return res;
      } else {
        console.warn("[Gacha MV] ⚠️ NAS sync response:", res);
        return res || { ok: false, status: 0, error: "No response from NAS" };
      }
    } catch (e) {
      console.warn("[Gacha MV] Could not sync segment to NAS:", e);
      return { ok: false, status: 0, error: e.message || "NAS upload failed" };
    }
  }

  async function deleteNasSegment(videoId, segmentId) {
    if (!settings.useNasServer || !settings.nasAutoSync || !settings.nasServerUrl || !videoId || !segmentId) return;
    try {
      const baseUrl = settings.nasServerUrl.trim().replace(/\/+$/, "");
      await nasFetch(`${baseUrl}/api/skipSegments?videoID=${encodeURIComponent(videoId)}&id=${encodeURIComponent(segmentId)}`, {
        method: "DELETE"
      });
    } catch (e) {
      console.warn("[Gacha MV] Could not delete segment from NAS:", e);
    }
  }

  async function persistNasCredentialsFromDom() {
    const urlEl = document.getElementById("gachaNasUrlInput");
    const tokenEl = document.getElementById("gachaNasTokenInput");
    const payload = {};
    if (urlEl) {
      payload.nasServerUrl = urlEl.value.trim();
      settings.nasServerUrl = payload.nasServerUrl;
    }
    if (tokenEl) {
      payload.nasAuthToken = tokenEl.value.trim();
      settings.nasAuthToken = payload.nasAuthToken;
    }
    if (Object.keys(payload).length) {
      await extStorage.set(payload);
    }
  }

  async function testNasConnection(rawUrl, rawToken) {
    let parsed;
    try {
      parsed = new URL((rawUrl || "").trim());
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        throw new Error("invalid URL");
      }
    } catch (_) {
      return { success: false, message: "Enter a valid server origin, for example http://192.168.1.50:3080" };
    }
    const token = (rawToken || "").trim();
    if (!token) return { success: false, message: "Enter the NAS_AUTH_TOKEN configured on the server" };

    const cleanUrl = parsed.origin;
    if (!(await ensureNasHostPermission(cleanUrl))) {
      return { success: false, message: "Grant NAS access from the extension popup, then try again" };
    }

    settings.nasServerUrl = cleanUrl;
    settings.nasAuthToken = token;
    await extStorage.set({ nasServerUrl: cleanUrl, nasAuthToken: token });
    const res = await nasFetch(`${cleanUrl}/api/status`);
    if (!res.ok || !res.data) {
      return { success: false, message: res.error || `HTTP ${res.status || "error"}` };
    }

    settings.useNasServer = true;
    await extStorage.set({ useNasServer: true });
    const inputEl = document.querySelector("#gachaNasUrlInput");
    if (inputEl) inputEl.value = cleanUrl;
    return {
      success: true,
      message: `Connected! (${res.data.totalSegments || 0} segments on NAS)`,
      data: res.data
    };
  }

  async function exportFullDbToNas() {
    if (!settings.useNasServer || !settings.nasServerUrl) {
      showToast("⚠️ Configure NAS server URL first");
      return;
    }
    const baseUrl = settings.nasServerUrl.trim().replace(/\/+$/, "");
    try {
      const res = await nasFetch(`${baseUrl}/api/database?merge=true`, {
        method: "POST",
        body: customSkipDb
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = res.data || {};
      showToast(`💾 Backed up ${data.videoCount || 0} videos to NAS!`);
    } catch (e) {
      showToast(`❌ NAS Backup failed: ${e.message}`);
    }
  }

  async function importFullDbFromNas() {
    if (!settings.useNasServer || !settings.nasServerUrl) {
      showToast("⚠️ Configure NAS server URL first");
      return;
    }
    const baseUrl = settings.nasServerUrl.trim().replace(/\/+$/, "");
    try {
      const res = await nasFetch(`${baseUrl}/api/database`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const remoteDb = res.data;
      if (typeof remoteDb === "object" && remoteDb !== null && !Array.isArray(remoteDb)) {
        customSkipDb = { ...customSkipDb, ...remoteDb };
        await extStorage.set({ customSkipDb });
        showToast(`📥 Imported ${Object.keys(remoteDb).length} videos from NAS!`);
        activeSegmentVideoId = "";
        loadVideoSegments(new URLSearchParams(window.location.search).get("v"));
      }
    } catch (e) {
      showToast(`❌ NAS Import failed: ${e.message}`);
    }
  }

  async function loadVideoSegments(videoId) {
    const loadGeneration = ++segmentLoadGeneration;

    if (!videoId) {
      activeVideoSegments = [];
      allLoadedSegments = [];
      activePoiHighlight = null;
      activeSegmentVideoId = "";
      poiJumpedVideoId = "";
      renderTimelineMarkers();
      updateSkipListUI();
      return;
    }

    if (poiJumpedVideoId && poiJumpedVideoId !== videoId) {
      poiJumpedVideoId = "";
    }
    activeSegmentVideoId = videoId;
    activeVideoSegments = [];
    allLoadedSegments = [];
    activePoiHighlight = null;

    // Load storage settings
    const data = await extStorage.get({
      customSkipDb: {},
      ignoredSegments: {},
      retimedSegments: {}
    });
    customSkipDb = data.customSkipDb || {};
    ignoredSegments = data.ignoredSegments || {};
    retimedSegments = data.retimedSegments || {};

    const videoIgnored = ignoredSegments[videoId] || [];
    const videoRetimed = retimedSegments[videoId] || {};

    // 1. Fetch SponsorBlock segments
    let sbSegments = [];
    if (settings.useSponsorBlockApi) {
      sbSegments = await fetchSponsorBlockSegments(videoId);
    }

    // 2. Fetch Custom DB segments
    let customSegments = [];
    if (settings.useCustomDb && customSkipDb[videoId]) {
      customSegments = customSkipDb[videoId].map((s, idx) => ({
        id: s.id || `custom_${idx}_${s.start}`,
        start: s.start,
        end: s.end,
        category: s.category || "custom",
        label: s.label || formatCategoryLabel(s.category || "custom"),
        source: "custom"
      }));
    }

    // 3. Fetch NAS Server segments
    let nasSegments = [];
    if (settings.useNasServer && settings.nasServerUrl) {
      nasSegments = await fetchNasSegments(videoId);
    }

    // A locally-created segment keeps the same ID when uploaded to NAS. Prefer
    // the freshly fetched NAS copy so it appears only once in the UI.
    const uniqueSegments = new Map();
    for (const seg of [...customSegments, ...nasSegments, ...sbSegments]) {
      const key = seg.source === "sponsorblock" ? `sponsorblock:${seg.id}` : seg.id;
      uniqueSegments.set(key, seg);
    }

    const merged = [...uniqueSegments.values()].map((seg) => {
      const isIgnored = videoIgnored.includes(seg.id);
      const retimed = videoRetimed[seg.id];

      if (retimed) {
        return {
          ...seg,
          originalStart: seg.start,
          originalEnd: seg.end,
          start: retimed.start,
          end: retimed.end,
          retimed: true,
          ignored: isIgnored
        };
      }

      return {
        ...seg,
        ignored: isIgnored,
        retimed: false
      };
    });

    merged.sort((a, b) => a.start - b.start);

    // Ignore an older request if a newer refresh completed while it was loading.
    if (loadGeneration !== segmentLoadGeneration) return;

    allLoadedSegments = merged;

    // Find POI Highlight (Drop / Chorus / Best part)
    const poi = merged.find((s) => s.category === "poi_highlight" && !s.ignored);
    activePoiHighlight = poi || null;

    // Skippable segments (non-POI, not ignored)
    activeVideoSegments = merged.filter((s) => s.category !== "poi_highlight" && !s.ignored);

    renderTimelineMarkers();
    updateSkipListUI();

    if (activePoiHighlight) {
      attemptPoiAutoJump();
    }
  }

  async function toggleIgnoreSegment(videoId, segmentId) {
    if (!videoId || !segmentId) return;

    if (!ignoredSegments[videoId]) {
      ignoredSegments[videoId] = [];
    }

    const idx = ignoredSegments[videoId].indexOf(segmentId);
    let nowIgnored = false;
    if (idx >= 0) {
      ignoredSegments[videoId].splice(idx, 1);
      nowIgnored = false;
    } else {
      ignoredSegments[videoId].push(segmentId);
      nowIgnored = true;
    }

    try {
      await extStorage.set({ ignoredSegments });
      showToast(nowIgnored ? "🚫 Marked segment as Incorrect / Ignored" : "✅ Restored segment to active list");
      activeSegmentVideoId = "";
      loadVideoSegments(videoId);
    } catch (e) {
      console.error("[Gacha MV] Failed to toggle ignore segment", e);
    }
  }

  async function saveRetimedSegment(videoId, segmentId, newStart, newEnd) {
    if (!videoId || !segmentId || isNaN(newStart) || isNaN(newEnd) || newStart >= newEnd) {
      showToast("⚠️ Invalid start or end seconds for retiming");
      return;
    }

    if (!retimedSegments[videoId]) {
      retimedSegments[videoId] = {};
    }

    retimedSegments[videoId][segmentId] = {
      start: parseFloat(newStart.toFixed(1)),
      end: parseFloat(newEnd.toFixed(1))
    };

    try {
      await extStorage.set({ retimedSegments });
      showToast("⏱️ Retimed segment saved successfully!");
      activeSegmentVideoId = "";
      loadVideoSegments(videoId);
    } catch (e) {
      console.error("[Gacha MV] Failed to save retimed segment", e);
    }
  }

  async function resetRetimedSegment(videoId, segmentId) {
    if (!videoId || !segmentId || !retimedSegments[videoId] || !retimedSegments[videoId][segmentId]) return;
    delete retimedSegments[videoId][segmentId];

    try {
      await extStorage.set({ retimedSegments });
      showToast("↩️ Reset to original timing");
      activeSegmentVideoId = "";
      loadVideoSegments(videoId);
    } catch (e) {
      console.error("[Gacha MV] Failed to reset retimed segment", e);
    }
  }

  async function saveCustomSkipSegment(videoId, start, end, category = "custom", label = "") {
    if (!videoId || isNaN(start) || isNaN(end) || (category !== "poi_highlight" && start >= end)) {
      showToast("⚠️ Invalid start or end time");
      return { success: false, error: "Invalid segment times" };
    }

    if (!customSkipDb[videoId]) {
      customSkipDb[videoId] = [];
    }

    const id = `custom_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const segment = {
      id: id,
      start: parseFloat(start.toFixed(1)),
      end: category === "poi_highlight" ? parseFloat(start.toFixed(1)) + 1 : parseFloat(end.toFixed(1)),
      category: category,
      label: label || formatCategoryLabel(category)
    };

    customSkipDb[videoId].push(segment);

    try {
      await extStorage.set({ customSkipDb });

      let nasResult = { ok: false, skipped: true };
      if (settings.useNasServer && settings.nasAutoSync && settings.nasServerUrl) {
        showToast("☁️ Uploading segment to NAS...");
        nasResult = await syncSegmentToNas(
          videoId,
          segment.start,
          segment.end,
          segment.category,
          segment.label,
          segment.id
        );
      }

      // The NAS POST must finish before this uncached GET, otherwise the new
      // segment can be missing until the page is reloaded.
      activeSegmentVideoId = "";
      await loadVideoSegments(videoId);

      if (nasResult.ok) {
        showToast("☁️ Segment uploaded and refreshed from NAS!");
      } else if (!nasResult.skipped) {
        showToast(`⚠️ Saved locally; NAS upload failed: ${nasResult.error || "HTTP " + nasResult.status}`);
      } else {
        showToast(category === "poi_highlight" ? "🌟 Added POI Highlight Drop!" : "💾 Saved custom skip segment!");
      }

      return { success: true, nasSynced: Boolean(nasResult.ok), segment };
    } catch (e) {
      console.error("[Gacha MV] Failed to save custom skip segment", e);
      showToast(`❌ Failed to save segment: ${e.message || "Unknown error"}`);
      return { success: false, error: e.message || "Failed to save segment" };
    }
  }

  async function deleteCustomSkipSegment(videoId, idOrIndex) {
    if (!videoId || !customSkipDb[videoId]) return;

    let targetId = typeof idOrIndex === "string" ? idOrIndex : customSkipDb[videoId][idOrIndex]?.id;

    if (typeof idOrIndex === "string") {
      customSkipDb[videoId] = customSkipDb[videoId].filter((s) => s.id !== idOrIndex);
    } else {
      customSkipDb[videoId].splice(idOrIndex, 1);
    }

    if (customSkipDb[videoId].length === 0) {
      delete customSkipDb[videoId];
    }

    try {
      await extStorage.set({ customSkipDb });
      if (targetId) deleteNasSegment(videoId, targetId);
      showToast("🗑️ Removed custom segment");
      activeSegmentVideoId = "";
      loadVideoSegments(videoId);
    } catch (e) {
      console.error("[Gacha MV] Failed to delete custom skip", e);
    }
  }

  function seekVideo(time, suppressToast = false) {
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (video && !isNaN(time)) {
      video.currentTime = time;
      if (!suppressToast) {
        showToast(`▶️ Jumped to ${formatTime(time)}`);
      }
    }
  }

  function renderTimelineMarkers() {
    document.querySelectorAll(".gacha-timeline-segment, .gacha-timeline-poi, #gacha-custom-timeline-track, .gacha-player-drop-pill").forEach((el) => el.remove());

    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (!video || !video.duration || isNaN(video.duration)) return;

    const duration = video.duration;

    // Find progress container or player container
    let progressBar = document.querySelector(
      ".ytp-progress-bar, .ytp-progress-list, ytm-custom-control-progress-bar, .ytm-progress-bar, .progress-bar-line, .player-progress-bar, .player-control-background"
    );

    const playerContainer =
      document.querySelector(".html5-video-player, ytm-player, #player-control-overlay, .player-container, #player") ||
      video.parentElement;

    // If on mobile or progress bar not easily nestable, create our dedicated glowing track
    let track = document.getElementById("gacha-custom-timeline-track");
    if (!track && playerContainer) {
      track = document.createElement("div");
      track.id = "gacha-custom-timeline-track";
      track.title = "Gacha Multi-Color Timeline (Click to Seek)";
      track.addEventListener("click", (e) => {
        const rect = track.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const targetPercent = Math.max(0, Math.min(1, clickX / rect.width));
        seekVideo(targetPercent * duration);
      });
      playerContainer.appendChild(track);
    }

    const targetBars = [progressBar, track].filter(Boolean);

    // 1. Render POI Highlight drop marker (Golden star & Floating pill)
    if (activePoiHighlight && settings.showPoiHighlights) {
      const leftPercent = (activePoiHighlight.start / duration) * 100;
      
      targetBars.forEach((bar) => {
        const poiMarker = document.createElement("div");
        poiMarker.className = "gacha-timeline-poi";
        poiMarker.style.left = `${leftPercent}%`;
        poiMarker.title = `🌟 Best Part / Music Drop (${formatTime(activePoiHighlight.start)}) - Click to Jump`;
        poiMarker.textContent = "★";
        poiMarker.addEventListener("click", (e) => {
          e.stopPropagation();
          seekVideo(activePoiHighlight.start);
        });
        bar.appendChild(poiMarker);
      });

      // Also attach floating Jump to Drop pill on player container
      if (playerContainer && !playerContainer.querySelector(".gacha-player-drop-pill")) {
        const pill = document.createElement("div");
        pill.className = "gacha-player-drop-pill";
        const pillIcon = document.createElement("span");
        pillIcon.textContent = "🌟";
        const pillLabel = document.createElement("span");
        pillLabel.textContent = `Drop (${formatTime(activePoiHighlight.start)})`;
        pill.append(pillIcon, pillLabel);
        pill.title = "Jump straight to the best part / drop!";
        pill.addEventListener("click", (e) => {
          e.stopPropagation();
          seekVideo(activePoiHighlight.start);
        });
        playerContainer.appendChild(pill);
      }
    }

    // 2. Render Skip Segments
    activeVideoSegments.forEach((seg) => {
      const leftPercent = (seg.start / duration) * 100;
      const widthPercent = Math.max(1, ((seg.end - seg.start) / duration) * 100);

      targetBars.forEach((bar) => {
        const marker = document.createElement("div");
        marker.className = `gacha-timeline-segment gacha-seg-${seg.category}${seg.retimed ? " gacha-seg-retimed" : ""}`;
        marker.style.left = `${leftPercent}%`;
        marker.style.width = `${widthPercent}%`;
        marker.title = `⚡ Auto-Skip: ${seg.label} (${formatTime(seg.start)} - ${formatTime(seg.end)})${
          seg.retimed ? " [Retimed]" : ""
        }`;
        marker.addEventListener("click", (e) => {
          e.stopPropagation();
          seekVideo(seg.start);
        });
        bar.appendChild(marker);
      });
    });
  }

  function showUnskipToast(label, start, end, originalTime) {
    const existing = document.getElementById("gacha-unskip-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "gacha-unskip-toast";
    toast.className = "gacha-unskip-toast";

    const icon = document.createElement("span");
    icon.className = "gacha-unskip-icon";
    icon.textContent = "⚡";
    toast.appendChild(icon);

    const textDiv = document.createElement("div");
    textDiv.className = "gacha-unskip-text";
    const strong = document.createElement("strong");
    strong.textContent = `Skipped ${label}`;
    const small = document.createElement("small");
    small.textContent = `${formatTime(start)} ➔ ${formatTime(end)}`;
    textDiv.appendChild(strong);
    textDiv.appendChild(small);
    toast.appendChild(textDiv);

    const btn = document.createElement("button");
    btn.className = "gacha-unskip-btn";
    btn.id = "gachaUnskipBtn";
    btn.title = "Jump back to watch this section";
    btn.textContent = "Unskip ↩";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      seekVideo(originalTime);
      toast.remove();
    });
    toast.appendChild(btn);

    document.body.appendChild(toast);
    handleFullscreenState();

    setTimeout(() => {
      if (toast && toast.parentNode) {
        toast.classList.add("fade-out");
        setTimeout(() => toast.remove(), 400);
      }
    }, 4500);
  }

  function parseUrlTimestamp(val) {
    if (!val) return 0;
    val = String(val).trim();
    if (!isNaN(val)) return parseFloat(val);
    let seconds = 0;
    const matchH = val.match(/(\d+)\s*h/i);
    const matchM = val.match(/(\d+)\s*m/i);
    const matchS = val.match(/(\d+)\s*s/i);
    if (matchH) seconds += parseInt(matchH[1], 10) * 3600;
    if (matchM) seconds += parseInt(matchM[1], 10) * 60;
    if (matchS) seconds += parseInt(matchS[1], 10);
    if (!matchH && !matchM && !matchS) {
      const num = parseFloat(val);
      if (!isNaN(num)) seconds = num;
    }
    return seconds;
  }

  function showPoiJumpToast(dropTime, originalTime) {
    const existing = document.getElementById("gacha-unskip-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "gacha-unskip-toast";
    toast.className = "gacha-unskip-toast gacha-poi-toast";

    const icon = document.createElement("span");
    icon.className = "gacha-unskip-icon";
    icon.textContent = "🌟";
    toast.appendChild(icon);

    const textDiv = document.createElement("div");
    textDiv.className = "gacha-unskip-text";
    const strong = document.createElement("strong");
    strong.textContent = `Jumped to Music Drop (${formatTime(dropTime)})`;
    const small = document.createElement("small");
    small.textContent = `Skipped straight to the best part`;
    textDiv.appendChild(strong);
    textDiv.appendChild(small);
    toast.appendChild(textDiv);

    const btn = document.createElement("button");
    btn.className = "gacha-unskip-btn";
    btn.id = "gachaPoiUndoBtn";
    btn.title = "Jump back to the beginning";
    btn.textContent = "Undo ↩";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      seekVideo(originalTime, true);
      toast.remove();
    });
    toast.appendChild(btn);

    document.body.appendChild(toast);
    handleFullscreenState();

    setTimeout(() => {
      if (toast && toast.parentNode) {
        toast.classList.add("fade-out");
        setTimeout(() => toast.remove(), 400);
      }
    }, 5000);
  }

  function attemptPoiAutoJump(video) {
    if (!settings.enabled || !settings.showPoiHighlights || !activePoiHighlight) return;
    const vid = getCurrentVideoId();
    if (!vid || poiJumpedVideoId === vid) return;

    // Drop must be meaningful (> 3s) to jump forward
    if (activePoiHighlight.start <= 3) {
      poiJumpedVideoId = vid;
      return;
    }

    // Check if the URL has an explicit timestamp parameter (t= or start=)
    const urlParams = new URLSearchParams(window.location.search);
    const urlTime = urlParams.get("t") || urlParams.get("start");
    if (urlTime) {
      const parsed = parseUrlTimestamp(urlTime);
      if (parsed >= 3) {
        poiJumpedVideoId = vid;
        return;
      }
    }

    const currentTargetVideo = video || document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (!currentTargetVideo || !currentTargetVideo.duration) return;

    // Only auto-jump if video is near the beginning (under 3 seconds)
    if (currentTargetVideo.currentTime >= 3) {
      poiJumpedVideoId = vid;
      return;
    }

    poiJumpedVideoId = vid;
    const originalTime = currentTargetVideo.currentTime || 0;
    seekVideo(activePoiHighlight.start, true);
    showPoiJumpToast(activePoiHighlight.start, originalTime);
  }

  let lastTimeUpdateCheck = 0;

  function handleVideoTimeUpdate(e) {
    if (!settings.enabled) return;
    const now = Date.now();
    if (now - lastTimeUpdateCheck < 250) return;
    lastTimeUpdateCheck = now;

    const video = e.target;
    if (!video || !video.duration || isSkipping) return;

    attemptPoiAutoJump(video);

    if (activeVideoSegments.length === 0) return;

    const curTime = video.currentTime;

    for (let i = 0; i < activeVideoSegments.length; i++) {
      const seg = activeVideoSegments[i];
      if (curTime >= seg.start && curTime < seg.end - 0.25) {
        isSkipping = true;
        const originalTime = curTime;
        video.currentTime = seg.end;
        lastSkippedSegment = {
          start: seg.start,
          end: seg.end,
          originalTime: originalTime,
          label: seg.label
        };

        showUnskipToast(seg.label, seg.start, seg.end, originalTime);

        setTimeout(() => {
          isSkipping = false;
        }, 600);
        break;
      }
    }
  }

  let savedMixContext = null;
  try {
    const storedMix = sessionStorage.getItem("gcmv_saved_mix");
    if (storedMix) savedMixContext = JSON.parse(storedMix);
  } catch (_) {}

  function hasAnyQueuedVideos() {
    if (cloudRemoteQueue && cloudRemoteQueue.length > 0) return true;
    if (window.AndroidBridge && typeof window.AndroidBridge.hasQueuedVideo === "function") {
      try {
        return Boolean(window.AndroidBridge.hasQueuedVideo());
      } catch (_) {}
    }
    return false;
  }

  function captureCurrentMixState() {
    try {
      const url = new URL(window.location.href);
      const listId = url.searchParams.get("list");
      // If we are already playing an off-mix queue video or not in a playlist/mix, do not overwrite existing saved context
      if (!listId || url.searchParams.get("gcmv_queue")) {
        return;
      }

      const currentVid = getCurrentVideoId();
      let currentMixIndex = -1;
      const urlIndex = url.searchParams.get("index");
      if (urlIndex) {
        const parsed = parseInt(urlIndex, 10);
        if (!isNaN(parsed) && parsed > 0) currentMixIndex = parsed;
      }

      let nextVid = "";
      let nextIndex = -1;

      // 1. Try extracting from moviePlayer API (Desktop YouTube)
      try {
        const moviePlayer = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
        if (moviePlayer && typeof moviePlayer.getPlaylist === "function") {
          const playlist = moviePlayer.getPlaylist();
          const pIndex = typeof moviePlayer.getPlaylistIndex === "function" ? moviePlayer.getPlaylistIndex() : -1;
          if (Array.isArray(playlist) && playlist.length > 0) {
            const resolvedIndex = pIndex >= 0 ? pIndex : playlist.indexOf(currentVid);
            if (resolvedIndex >= 0) {
              if (currentMixIndex === -1) currentMixIndex = resolvedIndex + 1;
              if (resolvedIndex + 1 < playlist.length) {
                nextVid = playlist[resolvedIndex + 1];
                nextIndex = resolvedIndex + 2;
              }
            }
          }
        }
      } catch (_) {}

      // 2. Query DOM playlist items (works on Desktop & Mobile / Android WebView)
      const playlistItems = document.querySelectorAll(
        "ytd-playlist-panel-renderer #items ytd-playlist-panel-video-renderer, " +
        "ytd-playlist-panel-video-renderer, " +
        "ytm-playlist-video-renderer, " +
        "ytm-compact-playlist-video-renderer, " +
        "ytm-playlist-panel-video-renderer, " +
        "ytm-custom-playlist-video-renderer, " +
        ".playlist-items ytm-playlist-video-renderer, " +
        ".playlist-panel-videos ytm-playlist-video-renderer"
      );

      if (playlistItems && playlistItems.length > 0) {
        let domCurrentIndex = -1;
        const parsedItems = [];

        for (let i = 0; i < playlistItems.length; i++) {
          const item = playlistItems[i];
          const link = item.querySelector("a#wc-endpoint, a#thumbnail, a.media-item-thumbnail-container, a");
          let itemVid = "";
          let itemIdx = -1;

          if (link && link.href) {
            try {
              const u = new URL(link.href, window.location.origin);
              itemVid = u.searchParams.get("v") || "";
              const idxParam = u.searchParams.get("index");
              if (idxParam) {
                const parsed = parseInt(idxParam, 10);
                if (!isNaN(parsed) && parsed > 0) itemIdx = parsed;
              }
            } catch (_) {}
          }

          const isSelected =
            (currentVid && itemVid === currentVid) ||
            item.hasAttribute("selected") ||
            item.getAttribute("aria-selected") === "true" ||
            item.classList.contains("selected") ||
            item.classList.contains("active");

          if (isSelected && domCurrentIndex === -1) {
            domCurrentIndex = i;
            if (itemIdx > 0 && currentMixIndex === -1) currentMixIndex = itemIdx;
          }

          const titleEl = item.querySelector("#video-title, .media-item-headline, .compact-media-item-headline, .title");
          const channelEl = item.querySelector("#byline, #channel-name, .media-item-byline, .compact-media-item-byline");
          const title = titleEl ? titleEl.textContent.trim() : "";
          const channel = channelEl ? channelEl.textContent.trim() : "";
          const isGacha = typeof isGachaVideo === "function" ? isGachaVideo(title, channel, "", itemVid) : true;

          parsedItems.push({
            index: i,
            videoId: itemVid,
            playlistIndex: itemIdx,
            title,
            channel,
            isGacha
          });
        }

        if (domCurrentIndex !== -1) {
          const upcoming = parsedItems.slice(domCurrentIndex + 1);
          let chosen = null;

          // If Mix Guard is enabled, prefer the first upcoming Gacha video in the mix
          if (settings.enabled && settings.autoplayGuard) {
            chosen = upcoming.find(it => it.isGacha && it.videoId);
          }

          // If no Gacha video found or Mix Guard not active, pick immediate next item
          if (!chosen && upcoming.length > 0) {
            chosen = upcoming.find(it => it.videoId) || upcoming[0];
          }

          if (chosen && chosen.videoId) {
            nextVid = chosen.videoId;
            if (chosen.playlistIndex > 0) {
              nextIndex = chosen.playlistIndex;
            } else if (currentMixIndex > 0) {
              nextIndex = currentMixIndex + (chosen.index - domCurrentIndex);
            }
          }
        }
      }

      // 3. Fallback for nextIndex if not explicitly determined
      if (nextIndex <= 0) {
        nextIndex = currentMixIndex > 0 ? currentMixIndex + 1 : 2;
      }

      savedMixContext = {
        listId: listId,
        lastVideoId: currentVid,
        nextVideoId: nextVid,
        nextIndex: nextIndex,
        savedAt: Date.now()
      };
      sessionStorage.setItem("gcmv_saved_mix", JSON.stringify(savedMixContext));
      console.log("[GCMV] 🎵 Captured Mix state before queue:", savedMixContext);
    } catch (e) {
      console.warn("[GCMV] Error capturing Mix state:", e);
    }
  }

  function resumeSavedMix() {
    if (!savedMixContext || !savedMixContext.listId) return;
    const mix = { ...savedMixContext };
    savedMixContext = null;
    sessionStorage.removeItem("gcmv_saved_mix");

    showToast("🎵 Queue finished: Resuming YouTube Mix 🌸");

    const host = window.AndroidBridge ? "m.youtube.com" : (window.location.host || "www.youtube.com");
    let resumeUrl = "https://" + host + "/watch?";
    const params = new URLSearchParams();

    if (mix.nextVideoId) {
      params.set("v", mix.nextVideoId);
    }
    params.set("list", mix.listId);
    if (mix.nextIndex && mix.nextIndex > 0) {
      params.set("index", String(mix.nextIndex));
    }

    resumeUrl += params.toString();
    console.log("[GCMV] 🎵 Resuming saved Mix via URL:", resumeUrl);

    if (mix.nextVideoId) {
      const moviePlayer = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
      if (moviePlayer) {
        navigateToVideo(mix.nextVideoId, "", false, mix.listId, mix.nextIndex || "");
        return;
      }
    }

    if (window.AndroidBridge && typeof window.AndroidBridge.loadUrl === "function") {
      window.AndroidBridge.loadUrl(resumeUrl);
    } else {
      window.location.href = resumeUrl;
    }
  }

  // ==========================================================
  // Playback Navigation & Looping State (Session-scoped)
  // ==========================================================
  let sessionPlaybackHistory = []; // [ { videoId, title, url } ] (max 50)
  let currentSessionTrack = null;  // { videoId, title, url }
  let currentLoopMode = "off";     // "off" | "once" | "infinite"
  let lastPrevClickTime = 0;

  function recordCurrentTrackSession(videoId, title) {
    const vid = videoId || getCurrentVideoId();
    if (!vid) return;

    if (currentSessionTrack && currentSessionTrack.videoId === vid) {
      if ((!currentSessionTrack.title || currentSessionTrack.title === vid) && title) {
        currentSessionTrack.title = title;
      }
      return;
    }

    if (currentSessionTrack && currentSessionTrack.videoId) {
      const lastHistory = sessionPlaybackHistory[sessionPlaybackHistory.length - 1];
      if (!lastHistory || lastHistory.videoId !== currentSessionTrack.videoId) {
        sessionPlaybackHistory.push(currentSessionTrack);
        if (sessionPlaybackHistory.length > 50) {
          sessionPlaybackHistory.shift();
        }
      }
    }

    let trackTitle = title;
    if (!trackTitle) {
      const titleEl = document.querySelector("h1.title, h1.ytm-watch-video-title, #title h1, .slim-video-information-title, yt-formatted-string.ytd-watch-metadata");
      trackTitle = titleEl ? titleEl.textContent.trim() : document.title.replace(/ - YouTube$/, "").trim();
    }

    currentSessionTrack = {
      videoId: vid,
      title: trackTitle || vid,
      url: window.location.href
    };
  }

  function getTrackStartTime() {
    const vid = getCurrentVideoId();
    if (vid && Array.isArray(activeVideoSegments)) {
      const introSeg = activeVideoSegments.find(s => s.start <= 1.0 && s.end > 1.0 && (s.category === "intro" || s.category === "sponsor"));
      if (introSeg && (settings.skipIntroOutro || settings.skipSponsor)) {
        return introSeg.end;
      }
    }
    return 0;
  }

  function updateInpagePlayPauseState() {
    const btn = document.getElementById("btnInpagePlayPause");
    if (!btn) return;
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    const isPlaying = video && !video.paused && !video.ended;
    btn.innerHTML = isPlaying ? "⏸️ Pause" : "▶️ Play";
  }

  function togglePlayPause() {
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    const moviePlayer = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
    if (video) {
      if (video.paused || video.ended) {
        window.__gachaUserManuallyPaused = false;
        if (moviePlayer && typeof moviePlayer.playVideo === "function") {
          try { moviePlayer.playVideo(); } catch (_) { video.play().catch(() => {}); }
        } else {
          video.play().catch(() => {});
        }
      } else {
        window.__gachaUserManuallyPaused = true;
        if (moviePlayer && typeof moviePlayer.pauseVideo === "function") {
          try { moviePlayer.pauseVideo(); } catch (_) { video.pause(); }
        } else {
          video.pause();
        }
      }
    }
    updateInpagePlayPauseState();
    broadcastCloudState();
  }

  function setLoopMode(mode) {
    if (mode !== "off" && mode !== "once" && mode !== "infinite") {
      mode = "off";
    }
    currentLoopMode = mode;

    const inpageLoopSelect = document.getElementById("inpageSelectLoopMode");
    if (inpageLoopSelect && inpageLoopSelect.value !== currentLoopMode) {
      inpageLoopSelect.value = currentLoopMode;
    }

    if (mode === "once") {
      showToast("🔂 Loop: Current track will repeat once 🌸");
    } else if (mode === "infinite") {
      showToast("🔁 Loop: Looping indefinitely 🌸");
    }

    broadcastCloudState();
  }

  function handleLoopReplay(video) {
    if (!video) {
      video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    }

    if (currentLoopMode === "once") {
      setLoopMode("off");
      showToast("🔂 Replaying track once 🌸");
    } else if (currentLoopMode === "infinite") {
      showToast("🔁 Looping track 🌸");
    }

    const startTime = getTrackStartTime();
    const moviePlayer = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
    if (moviePlayer && typeof moviePlayer.seekTo === "function") {
      try {
        moviePlayer.seekTo(startTime, true);
        if (typeof moviePlayer.playVideo === "function") moviePlayer.playVideo();
      } catch (_) {}
    } else if (video) {
      video.currentTime = startTime;
      try {
        const p = video.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (_) {}
    }
    updateInpagePlayPauseState();
    broadcastCloudState();
  }

  function playPreviousTrack() {
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    const moviePlayer = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
    const now = Date.now();
    const isDoubleClicked = (now - lastPrevClickTime) < 2500;
    lastPrevClickTime = now;

    if (currentLoopMode !== "off") {
      setLoopMode("off");
    }

    const curTime = video ? video.currentTime : 0;
    if (video && curTime > 3.0 && !isDoubleClicked) {
      const startTime = getTrackStartTime();
      if (moviePlayer && typeof moviePlayer.seekTo === "function") {
        try {
          moviePlayer.seekTo(startTime, true);
          if (typeof moviePlayer.playVideo === "function") moviePlayer.playVideo();
        } catch (_) {}
      } else {
        video.currentTime = startTime;
        try { video.play().catch(() => {}); } catch (_) {}
      }
      showToast("⏮️ Restarting track 🌸");
      updateInpagePlayPauseState();
      broadcastCloudState();
      return;
    }

    if (sessionPlaybackHistory.length > 0) {
      const prevTrack = sessionPlaybackHistory.pop();
      if (prevTrack && prevTrack.videoId) {
        currentSessionTrack = null;
        showToast("⏮️ Playing previous: " + (prevTrack.title || prevTrack.videoId) + " 🌸");
        navigateToTrack(prevTrack);
        setTimeout(broadcastCloudState, 1000);
        return;
      }
    }

    dispatchMainWorldPlayerAction("previous");
    const prevBtn = document.querySelector(".ytp-prev-button, button.prev-button, [aria-label*='Previous video']");
    if (prevBtn) {
      prevBtn.click();
      showToast("⏮️ Previous video 🌸");
    } else if (moviePlayer && typeof moviePlayer.previousVideo === "function") {
      moviePlayer.previousVideo();
      moviePlayer.playVideo?.();
      showToast("⏮️ Previous video 🌸");
    } else if (video) {
      video.currentTime = 0;
      try { video.play().catch(() => {}); } catch (_) {}
      showToast("⏮️ Restarting track 🌸");
    }
    setTimeout(broadcastCloudState, 1000);
  }

  function navigateToTrack(track) {
    if (!track || !track.videoId) return;
    let listId = "";
    let index = "";
    if (track.url) {
      try {
        const u = new URL(track.url, window.location.origin);
        listId = u.searchParams.get("list") || "";
        index = u.searchParams.get("index") || "";
      } catch (_) {}
    }
    navigateToVideo(track.videoId, track.title || "", false, listId, index);
  }

  function dispatchMainWorldPlayerAction(action, param = "") {
    try {
      const nonceEl = document.querySelector("script[nonce]");
      const s = document.createElement("script");
      if (nonceEl) {
        const nonceVal = nonceEl.nonce || nonceEl.getAttribute("nonce");
        if (nonceVal) s.setAttribute("nonce", nonceVal);
      }
      if (action === "next") {
        s.textContent = `(function() {
          try {
            const p = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
            if (p && typeof p.nextVideo === 'function') {
              p.nextVideo();
              p.playVideo?.();
            }
          } catch (_) {}
        })();`;
      } else if (action === "previous") {
        s.textContent = `(function() {
          try {
            const p = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
            if (p && typeof p.previousVideo === 'function') {
              p.previousVideo();
              p.playVideo?.();
            }
          } catch (_) {}
        })();`;
      } else if (action === "loadVideoById" && param) {
        const sanitized = String(param).replace(/[^a-zA-Z0-9_-]/g, "");
        s.textContent = `(function() {
          try {
            const p = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
            if (p && typeof p.loadVideoById === 'function') {
              p.loadVideoById('${sanitized}');
              p.playVideo?.();
            }
          } catch (_) {}
        })();`;
      }
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch (_) {}
  }

  async function executeSkipNextTrack(triggerSource = "user_skip") {
    // 1. If currently in a loop mode, break out of loop on explicit skip
    if (currentLoopMode !== "off") {
      setLoopMode("off");
    }

    // 2. Check for queued video from Cloud Remote P2P Queue
    if (cloudRemoteQueue && cloudRemoteQueue.length > 0) {
      captureCurrentMixState();
      const item = cloudRemoteQueue.shift();
      extStorage.set({ cloudRemoteQueue }).catch(() => {});
      broadcastCloudState();
      if (typeof refreshInpageQueue === "function") refreshInpageQueue();
      showToast("📱 Remote Queue: Playing next ➔ " + (item.title || item.videoId) + " 🌸");
      navigateToVideo(item.videoId, item.title, true);
      return;
    }

    // 3. Check for queued video from Android APK Bridge
    if (window.AndroidBridge && typeof window.AndroidBridge.popNextQueuedVideo === "function") {
      try {
        const queuedJson = window.AndroidBridge.popNextQueuedVideo();
        if (queuedJson) {
          const item = JSON.parse(queuedJson);
          if (item && item.videoId) {
            captureCurrentMixState();
            showToast("📱 Remote Queue: Playing next ➔ " + (item.title || item.videoId) + " 🌸");
            navigateToVideo(item.videoId, item.title, true);
            return;
          }
        }
      } catch (e) {
        console.warn("[GCMV] Error popping queued video from bridge:", e);
      }
    }

    // 4. Check for queued video from Desktop Remote Server / NAS
    if (!window.AndroidBridge && (settings.remoteServerEnabled !== false || settings.useNasServer)) {
      const serverUrl = (settings.remoteServerUrl || settings.nasServerUrl || "http://127.0.0.1:3000").trim().replace(/\/+$/, "");
      try {
        const res = await fetch(serverUrl + "/api/queue?pop=true", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (data && data.item && data.item.videoId) {
            captureCurrentMixState();
            showToast("📱 Remote Queue: Playing next ➔ " + (data.item.title || data.item.videoId) + " 🌸");
            navigateToVideo(data.item.videoId, data.item.title, true);
            return;
          }
        }
      } catch (e) {}
    }

    // 5. If no queued videos remain, check if we have a saved Mix to return to!
    if (savedMixContext && savedMixContext.listId) {
      resumeSavedMix();
      return;
    }

    const initialVid = getCurrentVideoId();
    const wasFullscreen = isPlayerMediaFullscreen();
    showToast("⏭️ Skipping to next track... 🌸");
    ensureYoutubeAutoplayToggleOn();

    // 6. Try native YouTube Next button
    const nextSelectors = [
      ".ytp-next-button",
      "button.ytp-next-button",
      "[data-testid='next-button']",
      ".player-controls-next",
      ".icon-button.player-control-next",
      "ytm-next-button"
    ];
    let nextBtn = null;
    for (const sel of nextSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        nextBtn = el;
        break;
      }
    }
    if (nextBtn) {
      try {
        nextBtn.click();
      } catch (_) {}
    }

    // 7. Try YouTube player's movie_player API directly and via main world injection
    dispatchMainWorldPlayerAction("next");
    const moviePlayer = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
    if (moviePlayer && typeof moviePlayer.nextVideo === "function") {
      try {
        moviePlayer.nextVideo();
        moviePlayer.playVideo?.();
      } catch (_) {}
    }

    // 8. Dispatch native YouTube Next keyboard shortcut (Shift + N)
    try {
      const shiftNInit = {
        key: "N",
        code: "KeyN",
        shiftKey: true,
        keyCode: 78,
        which: 78,
        bubbles: true,
        cancelable: true,
        composed: true
      };
      const keydownEvt = new KeyboardEvent("keydown", shiftNInit);
      const keyupEvt = new KeyboardEvent("keyup", shiftNInit);
      (moviePlayer || document.body || window).dispatchEvent(keydownEvt);
      (moviePlayer || document.body || window).dispatchEvent(keyupEvt);
      window.dispatchEvent(keydownEvt);
    } catch (_) {}

    // 9. If in a mix or playlist panel, navigate to next playlist item
    const isMix =
      window.location.search.includes("list=") ||
      Boolean(document.querySelector("ytd-playlist-panel-renderer, ytm-playlist-video-renderer"));

    function triggerPlaylistFallback() {
      const playlistItems = document.querySelectorAll(
        "ytd-playlist-panel-renderer #items ytd-playlist-panel-video-renderer, ytd-playlist-panel-video-renderer, ytm-playlist-video-renderer, ytm-compact-playlist-video-renderer"
      );
      if (playlistItems && playlistItems.length > 0) {
        let currentIndex = -1;
        for (let i = 0; i < playlistItems.length; i++) {
          const item = playlistItems[i];
          const link = item.querySelector("a#wc-endpoint, a#thumbnail, a.media-item-thumbnail-container, a");
          let itemVid = "";
          if (link && link.href) {
            try {
              const u = new URL(link.href, window.location.origin);
              itemVid = u.searchParams.get("v") || "";
            } catch (e) {}
          }
          if ((initialVid && itemVid === initialVid) || item.classList.contains("selected") || item.classList.contains("active") || item.hasAttribute("selected")) {
            currentIndex = i;
            break;
          }
        }
        const nextIndex = currentIndex !== -1 ? currentIndex + 1 : 1;
        if (nextIndex < playlistItems.length) {
          const nextItem = playlistItems[nextIndex];
          const nextEl = nextItem.querySelector("a#wc-endpoint, a#thumbnail, a.media-item-thumbnail-container, a") || nextItem;
          let nextVid = "";
          if (nextEl && nextEl.href) {
            try {
              const u = new URL(nextEl.href, window.location.origin);
              nextVid = u.searchParams.get("v") || "";
            } catch (e) {}
          }
          if (wasFullscreen && nextVid) {
            // Prioritize in-player loadVideoById to preserve fullscreen
            dispatchMainWorldPlayerAction("loadVideoById", nextVid);
            const p = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
            if (p && typeof p.loadVideoById === "function") {
              try {
                p.loadVideoById(nextVid);
                p.playVideo?.();
                return;
              } catch (_) {}
            }
          }
          saveFullscreenStateBeforeNavigate();
          if (typeof nextEl.click === "function") nextEl.click();
          if (nextEl.href) {
            setTimeout(() => {
              if (getCurrentVideoId() === initialVid) {
                if (window.AndroidBridge && typeof window.AndroidBridge.loadUrl === "function") {
                  window.AndroidBridge.loadUrl(nextEl.href);
                } else if (!isPlayerMediaFullscreen()) {
                  // Only fall back to hard reload when NOT in player fullscreen to preserve fullscreen mode
                  window.location.href = nextEl.href;
                }
              }
            }, 2500);
          }
        }
      }
    }

    if (isMix) {
      if (wasFullscreen) {
        // While in fullscreen: prioritize in-player API and do NOT click outer playlist links immediately.
        // Wait 2 seconds: only if videoId hasn't changed, fall back to playlist fallback.
        setTimeout(() => {
          if (getCurrentVideoId() === initialVid) {
            triggerPlaylistFallback();
          }
        }, 2000);
      } else {
        triggerPlaylistFallback();
      }
    }

    // 10. Verification and fallback if still on same video after 2500ms
    setTimeout(() => {
      const currentVid = getCurrentVideoId();
      if (currentVid === initialVid) {
        const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
        if (video && !isNaN(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.5) {
          try {
            // Nudge to end of track to trigger seamless in-player autoplay transition without reload
            video.currentTime = Math.max(0, video.duration - 0.2);
            video.play().catch(() => {});
          } catch (_) {}
        } else if (!window.AndroidBridge) {
          checkAndEnforceGachaNext("autoplay_guard");
        }
      }
      setTimeout(broadcastCloudState, 1000);
    }, 2500);
  }

  let isHandlingQueueTransition = false;
  function checkPreemptiveQueueTransition(video) {
    if (!video || isHandlingQueueTransition) return;
    if (!settings.enabled) return;

    const cur = video.currentTime;
    const dur = video.duration;

    // Trigger pre-emptively when within 0.8s of the end or if ended
    if (dur > 0 && (cur >= dur - 0.8 || video.ended)) {
      if (currentLoopMode !== "off") {
        isHandlingQueueTransition = true;
        handleLoopReplay(video);
        setTimeout(() => { isHandlingQueueTransition = false; }, 2500);
        return;
      }
      if (!hasAnyQueuedVideos()) return;
      isHandlingQueueTransition = true;
      try { video.pause(); } catch (_) {}
      captureCurrentMixState();
      checkAndEnforceGachaNext("queue_immediate");
      setTimeout(() => { isHandlingQueueTransition = false; }, 2500);
    }
  }

  function handleVideoTimeUpdateForQueue() {
    checkPreemptiveQueueTransition(this);
  }

  function handleVideoEnded() {
    if (!settings.enabled) return;

    // 0. If loop mode is active, repeat current track
    if (currentLoopMode !== "off") {
      const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
      handleLoopReplay(video);
      return;
    }

    // 1. If we have queued videos, play immediately with 0 delay!
    if (hasAnyQueuedVideos()) {
      captureCurrentMixState();
      checkAndEnforceGachaNext("queue_immediate");
      return;
    }

    // 2. If queue is empty, check if we have a saved Mix to return to!
    if (savedMixContext && savedMixContext.listId) {
      resumeSavedMix();
      return;
    }

    // 3. Otherwise standard autoplay guard
    if (!settings.autoplayGuard) return;
    if (autoplayGuardTimeout) clearTimeout(autoplayGuardTimeout);
    autoplayGuardTimeout = setTimeout(() => {
      checkAndEnforceGachaNext();
    }, 400);
  }

  function handleVideoPlayForBooster() {
    const video = this;
    setupAudioBooster(video);
    injectPlayerBarBoostControl();
    ensureAudioContextResumed();
  }

  function handleVideoPlayingForBooster() {
    setupAudioBooster(this);
    ensureAudioContextResumed();
  }

  function handleVideoLoadedDataForBooster() {
    setupAudioBooster(this);
    injectPlayerBarBoostControl();
    ensureAudioContextResumed();
  }

  // ==========================================================
  // Cloud WebRTC / PeerJS Remote Host Engine (Zero-Script)
  // ==========================================================
  let cloudPeer = null;
  let cloudConnections = [];
  let cloudRoomCode = "";
  let cloudRemoteQueue = [];
  let cloudMqttClient = null;

  function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let res = "GCMV-";
    for (let i = 0; i < 4; i++) {
      res += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return res;
  }

  function getPlaybackStateObject() {
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    const videoId = getCurrentVideoId();
    const titleEl = document.querySelector("h1.title, h1.ytm-watch-video-title, #title h1, .slim-video-information-title, yt-formatted-string.ytd-watch-metadata");
    const title = titleEl ? titleEl.textContent.trim() : document.title.replace(/ - YouTube$/, "").trim();
    const isPlaying = video ? !video.paused && !video.ended : false;
    const volume = video ? Math.round(video.volume * 100) : 100;
    const currentTime = video ? video.currentTime : 0;
    const duration = video ? video.duration : 0;

    if (currentSessionTrack && currentSessionTrack.videoId === videoId && (!currentSessionTrack.title || currentSessionTrack.title === videoId) && title) {
      currentSessionTrack.title = title;
    }

    return {
      type: "STATE",
      currentVideo: { videoId, title, currentTime, duration },
      isPlaying,
      volume,
      loopMode: currentLoopMode,
      queue: cloudRemoteQueue,
      roomCode: cloudRoomCode,
      pinRequired: Boolean(settings.remotePinEnabled)
    };
  }

  function broadcastCloudMqttMessage(obj) {
    if (!cloudMqttClient || !cloudMqttClient.isConnected()) return;
    try {
      const PahoLib = typeof Paho !== "undefined" ? Paho : (typeof window !== "undefined" ? window.Paho : null);
      if (!PahoLib || !PahoLib.MQTT) return;
      const cleanCode = (cloudRoomCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!cleanCode) return;
      const msg = new PahoLib.MQTT.Message(JSON.stringify(obj));
      msg.destinationName = `gcmv/room/${cleanCode}/state`;
      msg.retained = (obj.type === "STATE");
      cloudMqttClient.send(msg);
    } catch (e) {
      console.warn("[GCMV] broadcastCloudMqttMessage error:", e);
    }
  }

  function sendCloudStateToPeer(conn) {
    if (conn && conn.open) {
      try {
        conn.send(getPlaybackStateObject());
      } catch (_) {}
    }
  }

  function broadcastCloudState() {
    const state = getPlaybackStateObject();
    if (cloudConnections.length > 0) {
      cloudConnections.forEach(conn => {
        if (conn && conn.open) {
          try { conn.send(state); } catch (_) {}
        }
      });
    }
    broadcastCloudMqttMessage(state);
  }

  function textFromYtNode(node) {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (typeof node.simpleText === "string") return node.simpleText;
    if (Array.isArray(node.runs)) return node.runs.map((run) => run && run.text ? run.text : "").join("");
    return "";
  }

  function videoFromSearchRenderer(vr) {
    if (!vr || typeof vr !== "object") return null;
    const videoId = vr.videoId ||
      (vr.navigationEndpoint && vr.navigationEndpoint.watchEndpoint && vr.navigationEndpoint.watchEndpoint.videoId) ||
      "";
    if (!videoId) return null;
    const title = textFromYtNode(vr.title) || textFromYtNode(vr.headline);
    if (!title) return null;
    const channel = textFromYtNode(vr.ownerText) || textFromYtNode(vr.shortBylineText) || textFromYtNode(vr.longBylineText);
    let thumbnail = "";
    const thumbs = vr.thumbnail && vr.thumbnail.thumbnails;
    if (Array.isArray(thumbs) && thumbs.length > 0) {
      thumbnail = thumbs[thumbs.length - 1].url || "";
      if (thumbnail.startsWith("//")) thumbnail = "https:" + thumbnail;
    }
    if (!thumbnail) thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    return { videoId, title, channel, thumbnail };
  }

  function collectSearchResults(root, limit) {
    const max = limit || 20;
    const results = [];
    const seen = new Set();
    const rendererKeys = ["videoRenderer", "compactVideoRenderer", "videoWithContextRenderer"];

    function walk(node) {
      if (!node || results.length >= max) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (typeof node !== "object") return;
      for (const key of rendererKeys) {
        if (!node[key]) continue;
        const item = videoFromSearchRenderer(node[key]);
        if (item && !seen.has(item.videoId)) {
          seen.add(item.videoId);
          results.push(item);
          if (results.length >= max) return;
        }
      }
      for (const value of Object.values(node)) walk(value);
    }

    walk(root);
    return results;
  }

  function innertubeSearchContext() {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === "function") {
        const context = window.ytcfg.get("INNERTUBE_CONTEXT");
        if (context && context.client) return context;
      }
    } catch (_) {}
    const mobile = location.hostname === "m.youtube.com" || location.hostname.startsWith("m.");
    return {
      client: {
        clientName: mobile ? "MWEB" : "WEB",
        clientVersion: "2.20240901.00.00",
        hl: "en",
        gl: "US"
      }
    };
  }

  async function performYouTubeSearch(query) {
    try {
      const context = innertubeSearchContext();
      let endpoint = `${location.origin}/youtubei/v1/search?prettyPrint=false`;
      try {
        const apiKey = window.ytcfg && typeof window.ytcfg.get === "function" ? window.ytcfg.get("INNERTUBE_API_KEY") : "";
        if (apiKey) endpoint += "&key=" + encodeURIComponent(apiKey);
      } catch (_) {}
      const headers = { "Content-Type": "application/json" };
      if (context.client && context.client.clientName) {
        headers["X-YouTube-Client-Name"] = context.client.clientName === "MWEB" ? "2" : "1";
      }
      if (context.client && context.client.clientVersion) {
        headers["X-YouTube-Client-Version"] = context.client.clientVersion;
      }
      const res = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify({ context, query })
      });
      if (res.ok) {
        const data = await res.json();
        const results = collectSearchResults(data, 20);
        if (results.length > 0) return results;
      }
    } catch (e) {
      console.warn("[GCMV] Innertube search error:", e);
    }

    try {
      const searchUrl = `${location.origin}/results?search_query=${encodeURIComponent(query)}`;
      const res = await fetch(searchUrl, { credentials: "same-origin" });
      if (!res.ok) return [];
      const html = await res.text();
      return parseYouTubeSearchResultsFromHtml(html);
    } catch (e) {
      console.warn("[GCMV] YouTube search error:", e);
      return [];
    }
  }

  function extractYtInitialData(html) {
    const markers = ["var ytInitialData = ", 'window["ytInitialData"] = ', "window['ytInitialData'] = "];
    let idx = -1;
    let marker = "";
    for (const candidate of markers) {
      const found = html.indexOf(candidate);
      if (found !== -1 && (idx === -1 || found < idx)) {
        idx = found;
        marker = candidate;
      }
    }
    if (idx === -1) return null;

    let i = idx + marker.length;
    while (html[i] === " " || html[i] === "\n" || html[i] === "\r") i++;

    if (html[i] === "'" || html[i] === '"') {
      const quote = html[i];
      i++;
      let out = "";
      while (i < html.length) {
        if (html[i] === "\\") {
          const next = html[i + 1];
          if (next === "x" && /^[0-9a-fA-F]{2}$/.test(html.slice(i + 2, i + 4))) {
            out += String.fromCharCode(parseInt(html.slice(i + 2, i + 4), 16));
            i += 4;
            continue;
          }
          if (next === "u" && /^[0-9a-fA-F]{4}$/.test(html.slice(i + 2, i + 6))) {
            out += String.fromCharCode(parseInt(html.slice(i + 2, i + 6), 16));
            i += 6;
            continue;
          }
          const escaped = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"' };
          out += Object.prototype.hasOwnProperty.call(escaped, next) ? escaped[next] : (next || "");
          i += 2;
          continue;
        }
        if (html[i] === quote) break;
        out += html[i];
        i++;
      }
      return JSON.parse(out);
    }

    const jsonStart = html.indexOf("{", i);
    let endIdx = html.indexOf(";</script>", jsonStart);
    if (endIdx === -1) endIdx = html.indexOf(";\n", jsonStart);
    if (jsonStart === -1 || endIdx === -1) return null;
    let jsonStr = html.substring(jsonStart, endIdx).trim();
    if (jsonStr.endsWith(";")) jsonStr = jsonStr.slice(0, -1).trim();
    return JSON.parse(jsonStr);
  }

  function parseYouTubeSearchResultsFromHtml(html) {
    try {
      const root = extractYtInitialData(html);
      if (!root) return [];
      return collectSearchResults(root, 20);
    } catch (e) {
      console.warn("[GCMV] Search parse error:", e);
      return [];
    }
  }

  async function handleCloudRemoteCommand(data, conn) {
    if (!data || typeof data !== "object") return;
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");

    // PIN Validation
    const pinRequired = Boolean(settings.remotePinEnabled);
    const configuredPin = (settings.remotePin || "1234").trim();
    if (pinRequired && data.action !== "get_state") {
      const clientPin = (data.pin != null ? String(data.pin) : "").trim();
      if (clientPin !== configuredPin) {
        if (conn && conn.open) {
          try { conn.send({ type: "PIN_ERROR", message: "PIN required or invalid" }); } catch (_) {}
        }
        broadcastCloudMqttMessage({ type: "PIN_ERROR", message: "PIN required or invalid" });
        return;
      }
      if (data.action === "auth_pin") {
        if (conn && conn.open) {
          try { conn.send({ type: "PIN_OK" }); } catch (_) {}
        }
        broadcastCloudMqttMessage({ type: "PIN_OK" });
        return;
      }
    } else if (data.action === "auth_pin") {
      if (conn && conn.open) {
        try { conn.send({ type: "PIN_OK" }); } catch (_) {}
      }
      broadcastCloudMqttMessage({ type: "PIN_OK" });
      return;
    }

    switch (data.action) {
      case "get_state":
        sendCloudStateToPeer(conn);
        broadcastCloudState();
        break;

      case "play":
        if (video) video.play().catch(() => {});
        updateInpagePlayPauseState();
        broadcastCloudState();
        break;

      case "pause":
        if (video) video.pause();
        updateInpagePlayPauseState();
        broadcastCloudState();
        break;

      case "prev":
        playPreviousTrack();
        break;

      case "skip":
      case "next":
        executeSkipNextTrack("remote_skip");
        setTimeout(broadcastCloudState, 1000);
        break;

      case "set_loop":
        if (data.mode) {
          setLoopMode(data.mode);
        }
        break;

      case "volume":
        if (video && typeof data.value === "number") {
          video.volume = Math.max(0, Math.min(100, data.value)) / 100;
          broadcastCloudState();
        }
        break;

      case "seek":
        if (video && typeof data.time === "number") {
          video.currentTime = data.time;
          broadcastCloudState();
        }
        break;

      case "play_now":
        if (data.videoId) {
          if (window.AndroidBridge && typeof window.AndroidBridge.loadUrl === "function") {
            window.AndroidBridge.loadUrl("https://m.youtube.com/watch?v=" + data.videoId);
          } else {
            captureCurrentMixState();
            navigateToVideo(data.videoId, data.title || "", true);
          }
          setTimeout(broadcastCloudState, 1200);
        }
        break;

      case "play_next":
        if (data.videoId) {
          cloudRemoteQueue.unshift({
            id: "q_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
            videoId: data.videoId,
            title: data.title || data.videoId,
            addedAt: Date.now()
          });
          if (window.AndroidBridge && typeof window.AndroidBridge.addVideoToQueue === "function") {
            try { window.AndroidBridge.addVideoToQueue(data.videoId, data.title || "", "play_next"); } catch (_) {}
          }
          await extStorage.set({ cloudRemoteQueue });
          broadcastCloudState();
          if (typeof refreshInpageQueue === "function") refreshInpageQueue();
        }
        break;

      case "add_queue":
        if (data.videoId) {
          cloudRemoteQueue.push({
            id: "q_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
            videoId: data.videoId,
            title: data.title || data.videoId,
            addedAt: Date.now()
          });
          if (window.AndroidBridge && typeof window.AndroidBridge.addVideoToQueue === "function") {
            try { window.AndroidBridge.addVideoToQueue(data.videoId, data.title || "", "add_queue"); } catch (_) {}
          }
          await extStorage.set({ cloudRemoteQueue });
          broadcastCloudState();
          if (typeof refreshInpageQueue === "function") refreshInpageQueue();
        }
        break;

      case "remove_queue":
        if (data.id) {
          cloudRemoteQueue = cloudRemoteQueue.filter(item => item.id !== data.id);
          if (window.AndroidBridge && typeof window.AndroidBridge.removeQueueItem === "function") {
            try { window.AndroidBridge.removeQueueItem(data.id); } catch (_) {}
          }
          await extStorage.set({ cloudRemoteQueue });
          broadcastCloudState();
          if (typeof refreshInpageQueue === "function") refreshInpageQueue();
        }
        break;

      case "clear_queue":
        cloudRemoteQueue = [];
        if (window.AndroidBridge && typeof window.AndroidBridge.clearQueue === "function") {
          try { window.AndroidBridge.clearQueue(); } catch (_) {}
        }
        await extStorage.set({ cloudRemoteQueue });
        broadcastCloudState();
        if (typeof refreshInpageQueue === "function") refreshInpageQueue();
        break;

      case "search":
        if (data.query) {
          const results = await performYouTubeSearch(data.query);
          if (conn && conn.open) {
            conn.send({ type: "SEARCH_RESULTS", query: data.query, results });
          }
          broadcastCloudMqttMessage({ type: "SEARCH_RESULTS", query: data.query, results });
          try {
            chrome.runtime.sendMessage({
              type: "GCMV_SEARCH_RESULTS",
              query: data.query,
              results: results
            }, () => {
              if (chrome.runtime.lastError) {}
            });
          } catch (_) {}
        }
        break;
    }
  }

  try {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request && request.type === "GCMV_REMOTE_CMD") {
        handleCloudRemoteCommand(request.command);
        sendResponse({ ok: true });
        return true;
      }
    });
  } catch (_) {}

  function initCloudMqttHost() {
    const PahoLib = typeof Paho !== "undefined" ? Paho : (typeof window !== "undefined" ? window.Paho : null);
    if (!PahoLib || !PahoLib.MQTT || !PahoLib.MQTT.Client) {
      console.warn("[GCMV] Paho MQTT not available in content script");
      return;
    }
    const cleanCode = (cloudRoomCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!cleanCode) return;
    const clientId = "gcmv-host-" + Math.random().toString(36).substring(2, 10);
    const cmdTopic = `gcmv/room/${cleanCode}/cmd`;

    if (cloudMqttClient) {
      try { cloudMqttClient.disconnect(); } catch (_) {}
      cloudMqttClient = null;
    }

    try {
      const client = new PahoLib.MQTT.Client("broker.hivemq.com", 8884, "/mqtt", clientId);
      client.onConnectionLost = (resp) => {
        console.warn("[GCMV] Content Cloud MQTT connection lost:", resp ? resp.errorMessage : "");
        setTimeout(initCloudMqttHost, 6000);
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
          console.log(`[GCMV] 🌸 Content Cloud Remote MQTT online! Room: ${cleanCode}`);
          cloudMqttClient = client;
          client.subscribe(cmdTopic, {
            onSuccess: () => {
              broadcastCloudState();
            },
            onFailure: (err) => console.warn("[GCMV] Failed to subscribe to cmdTopic:", err)
          });
        },
        onFailure: (err) => {
          console.warn("[GCMV] Content MQTT connection failed:", err ? err.errorMessage : "");
          setTimeout(initCloudMqttHost, 8000);
        }
      });
    } catch (e) {
      console.warn("[GCMV] Error initializing Content MQTT host:", e);
    }
  }

  async function initCloudRemoteHost() {
    try {
      const stored = await extStorage.get({ cloudRoomCode: "", cloudRemoteEnabled: true, cloudRemoteQueue: [] });
      if (stored.cloudRemoteEnabled === false) return;

      if (window.AndroidBridge && typeof window.AndroidBridge.getCloudRoomCode === "function") {
        const bridgeCode = window.AndroidBridge.getCloudRoomCode();
        if (bridgeCode) cloudRoomCode = bridgeCode;
      }
      if (!cloudRoomCode) {
        cloudRoomCode = stored.cloudRoomCode || generateRoomCode();
      }
      await extStorage.set({ cloudRoomCode });

      if (Array.isArray(stored.cloudRemoteQueue)) {
        cloudRemoteQueue = stored.cloudRemoteQueue;
      }

      initCloudMqttHost();

      if (typeof Peer !== "undefined") {
        const cleanCode = cloudRoomCode.toLowerCase().replace(/[^a-z0-9]/g, "");
        const peerId = `gcmv-${cleanCode}`;

        if (cloudPeer) {
          try { cloudPeer.destroy(); } catch (_) {}
        }

        cloudPeer = new Peer(peerId);

        cloudPeer.on("open", (id) => {
          console.log(`[GCMV] 🌸 Cloud Remote Host online! Room: ${cloudRoomCode} (Peer: ${id})`);
          renderBottomRightQrCode();
        });

        cloudPeer.on("connection", (conn) => {
          cloudConnections.push(conn);
          console.log(`[GCMV] 📱 Phone connected via Cloud P2P! (${conn.peer})`);

          conn.on("open", () => {
            sendCloudStateToPeer(conn);
          });

          conn.on("data", async (data) => {
            handleCloudRemoteCommand(data, conn);
          });

          conn.on("close", () => {
            cloudConnections = cloudConnections.filter(c => c !== conn);
          });

          conn.on("error", () => {
            cloudConnections = cloudConnections.filter(c => c !== conn);
          });
        });

        cloudPeer.on("error", (err) => {
          console.warn("[GCMV] Cloud Remote Peer error:", err);
        });
      }
    } catch (e) {
      console.warn("[GCMV] Error initializing Cloud Remote Host:", e);
    }
  }

  function reportPlaybackStateToRemote() {
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    const videoId = getCurrentVideoId();
    if (!videoId) return;

    const titleEl = document.querySelector("h1.title, h1.ytm-watch-video-title, #title h1, .slim-video-information-title, yt-formatted-string.ytd-watch-metadata");
    const title = titleEl ? titleEl.textContent.trim() : document.title.replace(/ - YouTube$/, "").trim();
    const isPlaying = video ? !video.paused && !video.ended : false;
    const volume = video ? Math.round(video.volume * 100) : 100;

    broadcastCloudState();

    try {
      chrome.runtime.sendMessage({
        type: "GCMV_PLAYER_STATE",
        state: {
          videoId,
          title,
          isPlaying,
          volume,
          loopMode: currentLoopMode,
          currentTime: video ? video.currentTime : 0,
          duration: video ? video.duration : 0,
          queue: cloudRemoteQueue
        }
      }, () => {
        if (chrome.runtime.lastError) {}
      });
    } catch (_) {}

    if (window.AndroidBridge && typeof window.AndroidBridge.updateCurrentPlayback === "function") {
      try {
        window.AndroidBridge.updateCurrentPlayback(videoId, title, isPlaying, volume);
      } catch (e) {}
    } else {
      const serverUrl = (settings.remoteServerUrl || settings.nasServerUrl || "http://127.0.0.1:3000").trim().replace(/\/+$/, "");
      fetch(serverUrl + "/api/playback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, title, isPlaying, volume })
      }).catch(() => {});
    }
  }

  // Periodic status update to Cloud Remote & Background Host (every 2.5s while active)
  setInterval(() => {
    if (!settings.enabled) return;
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (video && !video.paused) {
      reportPlaybackStateToRemote();
    }
  }, 2500);

  let remotePollInterval = null;
  function startRemoteControlPolling() {
    if (window.AndroidBridge) return; // AndroidBridge handles controls natively!
    if (remotePollInterval) clearInterval(remotePollInterval);

    remotePollInterval = setInterval(async () => {
      if (!settings.enabled || settings.remoteServerEnabled === false) return;
      const serverUrl = (settings.remoteServerUrl || settings.nasServerUrl || "http://127.0.0.1:3000").trim().replace(/\/+$/, "");
      try {
        const res = await fetch(serverUrl + "/api/control/poll", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (data && Array.isArray(data.actions) && data.actions.length > 0) {
          const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
          for (const item of data.actions) {
            if (item.action === "play" && video) {
              video.play().catch(() => {});
            } else if (item.action === "pause" && video) {
              video.pause();
            } else if (item.action === "prev") {
              playPreviousTrack();
            } else if (item.action === "next" || item.action === "skip") {
              executeSkipNextTrack("remote_skip");
            } else if (item.action === "play_now" && item.videoId) {
              captureCurrentMixState();
              navigateToVideo(item.videoId, item.title, true);
            } else if (item.action === "volume" && video && typeof item.value === "number") {
              video.volume = Math.max(0, Math.min(100, item.value)) / 100;
            }
          }
        }
      } catch (e) {}
    }, 1500);
  }

  function handleVideoPlayEvents() {
    if (settings.enabled) {
      if (settings.autoSkipNonGacha) {
        checkCurrentVideoForAutoSkip();
      }
      const vid = getCurrentVideoId();
      if (vid && activeSegmentVideoId !== vid) {
        loadVideoSegments(vid);
      }
      if (vid) {
        recordRecentPlayedVideoId(vid);
      }
      ensureYoutubeAutoplayToggleOn();
      attemptPoiAutoJump();
      if (settings.autoUnmute !== false) {
        attemptAutoUnmute("play-event");
      }
      applyPreferredResolution("play-event");
      reportPlaybackStateToRemote();
    }
  }

  // ==========================================================
  // Auto-Unfreeze Buffer Stall Watchdog
  // Recovers playback if video pauses or hangs at a timestamp gap
  // even though media is already buffered ahead in memory.
  // ==========================================================
  let bufferWatchdogInterval = null;
  let lastObservedCurrentTime = -1;
  let stallDetectionCounter = 0;
  let lastNudgeTimestamp = 0;
  let consecutiveNudges = 0;

  function initBufferStallWatchdog(video) {
    if (bufferWatchdogInterval) {
      clearInterval(bufferWatchdogInterval);
      bufferWatchdogInterval = null;
    }
    if (!video) return;

    lastObservedCurrentTime = -1;
    stallDetectionCounter = 0;

    bufferWatchdogInterval = setInterval(() => {
      if (!settings.enabled || settings.smoothPlayback === false) return;
      if (!video || !document.body.contains(video)) return;

      // Only monitor when video is supposed to be playing
      if (video.paused || video.ended || video.seeking || window.__gachaUserManuallyPaused) {
        stallDetectionCounter = 0;
        lastObservedCurrentTime = video.currentTime;
        return;
      }

      const curTime = video.currentTime;

      // Check if time is stalled (moved less than 0.02s in 250ms interval)
      if (lastObservedCurrentTime >= 0 && Math.abs(curTime - lastObservedCurrentTime) < 0.02) {
        let bufferedAhead = 0;
        try {
          const b = video.buffered;
          if (b && b.length > 0) {
            for (let i = 0; i < b.length; i++) {
              const start = b.start(i);
              const end = b.end(i);
              if (curTime >= start - 0.2 && curTime <= end) {
                bufferedAhead = end - curTime;
                break;
              }
            }
          }
        } catch (_) {}

        // If buffered ahead by at least 0.5s, data is in memory but decode/playback clock stalled!
        if (bufferedAhead >= 0.5) {
          stallDetectionCounter++;
          // Stalled for ~500ms (2 consecutive intervals)
          if (stallDetectionCounter >= 2) {
            const now = Date.now();
            if (now - lastNudgeTimestamp > 3000) {
              consecutiveNudges = 0;
            }
            if (consecutiveNudges < 3) {
              consecutiveNudges++;
              lastNudgeTimestamp = now;
              stallDetectionCounter = 0;
              console.log(`[GCMV] Auto-unfreeze: buffered ahead ${bufferedAhead.toFixed(1)}s, nudging +0.05s from ${curTime.toFixed(2)}s`);
              try {
                video.currentTime = curTime + 0.05;
                if (video.paused) {
                  video.play().catch(() => {});
                }
              } catch (_) {}
            }
          }
        } else {
          stallDetectionCounter = 0;
        }
      } else {
        stallDetectionCounter = 0;
      }

      lastObservedCurrentTime = curTime;
    }, 250);
  }

  function setupVideoPlayerListeners() {
    const video =
      document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (!video) return;

    if (settings.enabled && settings.autoUnmute !== false) {
      attemptAutoUnmute("setup-listeners");
    }
    applyPreferredResolution("setup-listeners");

    // Initialize Web Audio Booster & Controls
    setupAudioBooster(video);
    injectPlayerBarBoostControl();
    initBufferStallWatchdog(video);

    // Attach timeupdate for SponsorBlock skipping
    video.removeEventListener("timeupdate", handleVideoTimeUpdate);
    video.addEventListener("timeupdate", handleVideoTimeUpdate);

    // Resolution quality listener on metadata load
    video.removeEventListener("loadedmetadata", handleVideoMetadataForQuality);
    video.addEventListener("loadedmetadata", handleVideoMetadataForQuality);
    video.removeEventListener("canplay", handleVideoMetadataForQuality);
    video.addEventListener("canplay", handleVideoMetadataForQuality);

    // Attach metadata listeners for timeline markers (exclude progress/playing to eliminate DOM thrashing during video buffering)
    ["loadedmetadata", "durationchange", "seeked", "canplay"].forEach((evt) => {
      video.removeEventListener(evt, renderTimelineMarkers);
      video.addEventListener(evt, renderTimelineMarkers);
    });

    // Auto-skip trigger on video play & load
    video.removeEventListener("play", handleVideoPlayEvents);
    video.addEventListener("play", handleVideoPlayEvents);
    video.removeEventListener("playing", handleVideoPlayEvents);
    video.addEventListener("playing", handleVideoPlayEvents);
    video.removeEventListener("loadstart", handleVideoPlayEvents);
    video.addEventListener("loadstart", handleVideoPlayEvents);

    video.removeEventListener("play", handleVideoPlayForBooster);
    video.addEventListener("play", handleVideoPlayForBooster);
    video.removeEventListener("playing", handleVideoPlayingForBooster);
    video.addEventListener("playing", handleVideoPlayingForBooster);
    video.removeEventListener("loadeddata", handleVideoLoadedDataForBooster);
    video.addEventListener("loadeddata", handleVideoLoadedDataForBooster);

    // Autoplay guard & Queue listener - always listen for ended so queue can pop even if autoplayGuard is off
    video.removeEventListener("ended", handleVideoEnded);
    video.addEventListener("ended", handleVideoEnded);

    // Pre-emptive queue transition on timeupdate (prevents YouTube Mix from auto-advancing)
    video.removeEventListener("timeupdate", handleVideoTimeUpdateForQueue);
    video.addEventListener("timeupdate", handleVideoTimeUpdateForQueue);

    // Auto-play recovery on canplay
    video.removeEventListener("canplay", handleVideoCanPlayForRecovery);
    video.addEventListener("canplay", handleVideoCanPlayForRecovery);

    // Track user-initiated pause so the auto-play recovery
    // doesn't override an intentional user pause
    video.removeEventListener("pause", handleUserPauseTrack);
    video.removeEventListener("play", handleUserPlayResume);
    video.removeEventListener("playing", handleUserPlayResume);
    video.addEventListener("pause", handleUserPauseTrack);
    video.addEventListener("play", handleUserPlayResume);
    video.addEventListener("playing", handleUserPlayResume);
    videoListenerAttached = true;
  }

  function handleVideoCanPlayForRecovery() {
    attemptAutoplayRecovery("video-canplay");
  }

  let lastUserPauseInteractionTime = 0;
  let lastNavigatedTime = Date.now();

  // Listen for physical user gestures targeting play/pause controls or keyboard
  if (!window.__gachaUserPauseGlobalHooksAttached__) {
    window.__gachaUserPauseGlobalHooksAttached__ = true;
    document.addEventListener(
      "pointerdown",
      (e) => {
        const target = e.target;
        if (!target) return;
        if (
          target.closest &&
          (target.closest(".ytp-play-button") ||
            target.closest(".player-controls-play-pause") ||
            target.closest("[data-testid='play-button']") ||
            target.closest(".ytp-cued-thumbnail-overlay") ||
            target.closest(".html5-video-player"))
        ) {
          lastUserPauseInteractionTime = Date.now();
        }
      },
      { capture: true, passive: true }
    );

    document.addEventListener(
      "keydown",
      (e) => {
        if (
          e.target &&
          (e.target.tagName === "INPUT" ||
            e.target.tagName === "TEXTAREA" ||
            e.target.isContentEditable)
        ) {
          return;
        }
        if (e.code === "Space" || e.key === " " || e.code === "KeyK" || e.key === "k" || e.key === "K") {
          lastUserPauseInteractionTime = Date.now();
        }
      },
      { capture: true, passive: true }
    );
  }

  function handleUserPauseTrack(e) {
    const video = e?.target || document.querySelector("video.html5-main-video") || document.querySelector("video");

    // 1. Never treat video ending as an intentional user pause
    if (video && (video.ended || (video.duration > 0 && video.currentTime >= video.duration - 0.5))) {
      return;
    }

    // 2. Never treat internal skip, ad handling, or queue transition as a user pause
    if (isHandlingQueueTransition || isSkipping || wasAdPlaying || autoSkipMutedVideo) {
      return;
    }

    // 3. Never treat initial track load/buffer (within 2.5s of navigation) as a user pause
    if (Date.now() - lastNavigatedTime < 2500 && (!video || video.currentTime < 1.0)) {
      return;
    }

    // 4. Only flag as manual pause if accompanied by a real user interaction or trusted mid-playback event
    const isRecentUserInteraction = Date.now() - lastUserPauseInteractionTime < 1500;
    if (isRecentUserInteraction || (e && e.isTrusted && video && video.currentTime > 1.0 && !video.seeking)) {
      window.__gachaUserManuallyPaused = true;
    }
  }

  function handleUserPlayResume() {
    window.__gachaUserManuallyPaused = false;
  }

  // ==========================================================
  // Metadata & Classification
  // ==========================================================
  function isGachaVideo(title = "", channelName = "", descriptionText = "", videoId = "", keywords = []) {
    // 1. Check user whitelist first
    if (videoId && gachaWhitelist.videoIds.includes(videoId)) {
      return true;
    }
    if (channelName && gachaWhitelist.channels.includes(channelName.toLowerCase().trim())) {
      return true;
    }

    const lowerTitle = (title || "").toLowerCase();
    const lowerChannel = (channelName || "").toLowerCase();
    const lowerDesc = (descriptionText || "").toLowerCase();

    // 2. Check title for explicit Gacha keywords
    const titleMatch = GACHA_POSITIVE_KEYWORDS.some((kw) => lowerTitle.includes(kw));
    if (titleMatch) return true;

    // 2b. "MEP" (Multi-Editor Project) is a common Gacha collab format that doesn't
    // always include the word "gacha"/"gcmv" in the title. Match it as a whole word
    // (not a plain substring) so it doesn't false-positive on words like "gameplay"
    // or "homepage", which contain "mep" as a substring.
    const mepPattern = /\bmeps?\b/i;
    if (
      mepPattern.test(lowerTitle) ||
      mepPattern.test(lowerChannel) ||
      mepPattern.test(lowerDesc) ||
      (Array.isArray(keywords) && keywords.some((tag) => mepPattern.test((tag || "").toLowerCase())))
    ) {
      return true;
    }

    // 3. Check channel name for Gacha keywords/creators
    const channelMatch = GACHA_POSITIVE_KEYWORDS.some((kw) => lowerChannel.includes(kw));
    if (channelMatch) return true;

    // 4. Check explicit creator hashtags in description or title
    const hashtagMatch = GACHA_HASHTAGS.some((ht) => lowerDesc.includes(ht) || lowerTitle.includes(ht));
    if (hashtagMatch) return true;

    // 5. Check description text for positive Gacha keywords/credits
    const descMatch = GACHA_POSITIVE_KEYWORDS.some((kw) => lowerDesc.includes(kw));
    if (descMatch) return true;

    // 6. Check YouTube video tags / keywords if available
    if (Array.isArray(keywords) && keywords.length > 0) {
      const tagMatch = keywords.some((tag) => {
        const lowerTag = (tag || "").toLowerCase().trim();
        return (
          GACHA_POSITIVE_KEYWORDS.some((kw) => lowerTag.includes(kw)) ||
          GACHA_HASHTAGS.some((ht) => lowerTag.includes(ht.replace("#", "")))
        );
      });
      if (tagMatch) return true;
    }

    return false;
  }

  function isNonGachaOfficialOrLyric(title = "", channelName = "", descriptionText = "", videoId = "", keywords = []) {
    // If it is identified as Gacha (or whitelisted), it is NEVER non-Gacha
    if (isGachaVideo(title, channelName, descriptionText, videoId, keywords)) {
      return false;
    }

    const lowerTitle = (title || "").toLowerCase();
    const lowerChannel = (channelName || "").toLowerCase();

    // Check for explicit official music video or plain lyric video indicators
    const hasIndicator = NON_GACHA_INDICATORS.some((kw) => lowerTitle.includes(kw));
    const isArtistOrLyricChannel =
      NON_GACHA_CHANNELS.some((ch) => lowerChannel.includes(ch)) ||
      lowerChannel.includes(" - topic") ||
      lowerChannel.endsWith("records") ||
      lowerChannel.endsWith("vevo");

    return hasIndicator || isArtistOrLyricChannel;
  }

  function cleanSongTitleForGacha(rawTitle) {
    if (!rawTitle) return "Trending GCMV GLMV";
    let cleaned = rawTitle;

    // Remove bracketed official/lyric tags: [Official Music Video], (Lyrics), etc.
    cleaned = cleaned.replace(
      /\s*[([][^)]*(official|music video|mv|lyric|lyrics|audio|video|visualizer|hd|4k|remastered|explicit|prod)[^)]*[)\]]/gi,
      ""
    );
    // Remove standalone indicator keywords
    cleaned = cleaned.replace(
      /\b(official music video|official video|official mv|official audio|official lyric video|lyric video|lyrics video|lyrics|official visualizer)\b/gi,
      ""
    );
    cleaned = cleaned.trim();
    if (!cleaned) cleaned = rawTitle.trim();
    return `${cleaned} GCMV GLMV`;
  }

  // ==========================================================
  // Initialization
  // ==========================================================
  async function init() {
    markAndroidHost();
    try {
      const data = await extStorage.get({
        enabled: true,
        blockAds: true,
        showJukebox: true,
        showSearchChips: true,
        autoplayGuard: true,
        autoSkipNonGacha: true,
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
        preferredResolution: "auto",
        remoteServerEnabled: true,
        remoteServerUrl: "",
        remotePinEnabled: false,
        remotePin: "",
        showBottomLeftQr: false,
        showBottomRightQr: false,
        showQrInFullscreen: true,
        customSkipDb: {},
        ignoredSegments: {},
        retimedSegments: {}
      });
      settings = { ...settings, ...data };
      if (settings.showBottomLeftQr === undefined && settings.showBottomRightQr !== undefined) {
        settings.showBottomLeftQr = settings.showBottomRightQr;
      }
      if (typeof settings.nasServerUrl !== "string") settings.nasServerUrl = "";
      if (typeof settings.nasAuthToken !== "string") settings.nasAuthToken = "";
      if (settings.useNasServer && !settings.nasAuthToken) {
        settings.useNasServer = false;
        settings.nasAutoSync = false;
        await extStorage.set({ useNasServer: false, nasAutoSync: false });
      }
      customSkipDb = data.customSkipDb || {};
      ignoredSegments = data.ignoredSegments || {};
      retimedSegments = data.retimedSegments || {};
    } catch (e) {
      console.warn("[Gacha MV] Could not load storage, using defaults", e);
    }

    await loadWhitelist();
    setupVolumeHotkeys();
    setupManualMuteDetection();
    applyFeatures();
    setupFullscreenListener();
    startRemoteControlPolling();
    initCloudRemoteHost();

    startStillWatchingGuard();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") persistNasCredentialsFromDom();
    });
    window.addEventListener("pagehide", persistNasCredentialsFromDom);

    if (!adBlockerInterval) {
      adBlockerInterval = setInterval(() => {
        dismissStillWatchingPrompt();
        runAdBlockerCycle();
      }, 1000);
    }

    // Auto-retry passes as YouTube Polymer components and feeds hydrate on initial visit
    [300, 800, 1500, 3000].forEach((delay) => {
      setTimeout(() => {
        if (settings.enabled) {
          applyFeatures();
        }
      }, delay);
    });
  }

  function applyFeatures() {
    markAndroidHost();
    if (!settings.enabled) {
      restoreAutoSkipMute();
      const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
      if (wasAdPlaying && video) {
        video.muted = userMutedStateBeforeAd;
        video.playbackRate = userPlaybackRateBeforeAd;
        wasAdPlaying = false;
      }
      applyVolumeBoostGain(false);
      document.body?.classList.remove("gacha-block-ads");
      removeSearchChips();
      removeSkipOverlay();
      cleanFeedBadges();
      activeVideoSegments = [];
      activeSegmentVideoId = "";
      renderTimelineMarkers();
      if (settings.showJukebox) {
        injectFloatingJukebox();
        updateInpageSettingsUI();
      } else {
        removeFloatingJukebox();
      }
      updateBottomLeftQrVisibility();
      return;
    }

    document.body?.classList.toggle("gacha-block-ads", settings.blockAds !== false);
    const isSmooth = settings.smoothPlayback !== false;
    document.documentElement?.classList.toggle("gacha-smooth-playback", isSmooth);
    document.body?.classList.toggle("gacha-smooth-playback", isSmooth);
    runAdBlockerCycle();

    if (settings.showSearchChips) {
      injectSearchChips();
    } else {
      removeSearchChips();
    }

    if (settings.showJukebox) {
      injectFloatingJukebox();
      updateInpageSettingsUI();
    } else {
      removeFloatingJukebox();
    }
    updateBottomLeftQrVisibility();

    const urlParams = new URLSearchParams(window.location.search);
    const videoId = urlParams.get("v") || (window.location.pathname.startsWith("/watch/") ? window.location.pathname.replace("/watch/", "") : "");
    const isWatch = Boolean(videoId) || window.location.pathname.startsWith("/watch") || window.location.pathname.startsWith("/shorts");

    if (isWatch) {
      setupVideoPlayerListeners();
      ensureYoutubeAutoplayToggleOn();
      checkAndRestoreFullscreen();

      if (videoId) {
        if (activeSegmentVideoId !== videoId) {
          poiJumpedVideoId = "";
          loadVideoSegments(videoId);
        }
      }

      if (settings.autoSkipNonGacha) {
        checkCurrentVideoForAutoSkip();
      }
    } else {
      activeVideoSegments = [];
      activeSegmentVideoId = "";
      poiJumpedVideoId = "";
      renderTimelineMarkers();
    }

    if (settings.filterOfficialVideos) {
      applyFeedBadgesAndFilters();
    }
  }

  // ==========================================================
  // Video Player Media Fullscreen Detection & Hiding
  // ==========================================================
  function isPlayerMediaFullscreen() {
    // 1. Check YouTube player's fullscreen class
    const moviePlayer = document.querySelector("#movie_player, .html5-video-player");
    if (moviePlayer && moviePlayer.classList.contains("ytp-fullscreen")) {
      return true;
    }

    // 2. Check if ytd-watch-flexy has fullscreen attribute (YouTube video player full mode)
    const watchFlexy = document.querySelector("ytd-watch-flexy");
    if (watchFlexy && watchFlexy.hasAttribute("fullscreen")) {
      return true;
    }

    // 3. Check if document.fullscreenElement is the player or video element (NOT root html document on F11)
    const fullEl =
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement;
    if (fullEl && fullEl !== document.documentElement && fullEl !== document.body) {
      return true;
    }

    // 4. Check Android Bridge custom view
    if (window.AndroidBridge && typeof window.AndroidBridge.isFullscreen === "function") {
      try {
        if (window.AndroidBridge.isFullscreen()) return true;
      } catch (e) {}
    }

    return false;
  }

  function saveFullscreenStateBeforeNavigate() {
    try {
      if (isPlayerMediaFullscreen()) {
        sessionStorage.setItem("gcmv_restore_fullscreen", "true");
      }
    } catch (e) {}
  }

  function checkAndRestoreFullscreen() {
    try {
      if (sessionStorage.getItem("gcmv_restore_fullscreen") !== "true") return;

      let attempts = 0;
      let tappedVideo = false;

      const interval = setInterval(() => {
        attempts++;
        if (isPlayerMediaFullscreen()) {
          sessionStorage.removeItem("gcmv_restore_fullscreen");
          clearInterval(interval);
          return;
        }

        const fsBtn = document.querySelector(
          ".fullscreen-icon, button.fullscreen-icon, button[aria-label='Full screen'], button[aria-label='fullscreen'], .ytp-fullscreen-button, button[data-title-no-tooltip='Full screen'], .icon-button.player-control-fullscreen, [data-button-id='fullscreen']"
        );
        const video = document.querySelector("video");

        if (fsBtn) {
          const rect = fsBtn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            if (window.AndroidBridge && typeof window.AndroidBridge.simulateTap === "function") {
              window.AndroidBridge.simulateTap(rect.left + rect.width / 2, rect.top + rect.height / 2);
            }
            if (typeof fsBtn.click === "function") {
              fsBtn.click();
            }
          } else {
            // Button exists but zero dimensions (hidden controls). Tap video to wake controls
            if (!tappedVideo && video) {
              tappedVideo = true;
              const vRect = video.getBoundingClientRect();
              if (vRect.width > 0 && vRect.height > 0 && window.AndroidBridge && typeof window.AndroidBridge.simulateTap === "function") {
                window.AndroidBridge.simulateTap(vRect.left + vRect.width / 2, vRect.top + vRect.height / 2);
              }
            }
          }
        } else if (video) {
          const vRect = video.getBoundingClientRect();
          if (vRect.width > 0 && vRect.height > 0) {
            if (!tappedVideo && window.AndroidBridge && typeof window.AndroidBridge.simulateTap === "function") {
              tappedVideo = true;
              window.AndroidBridge.simulateTap(vRect.left + vRect.width / 2, vRect.top + vRect.height / 2);
            }
            if (typeof video.requestFullscreen === "function") {
              video.requestFullscreen().catch(() => {});
            }
          }
        }

        if (attempts > 35) {
          clearInterval(interval);
          sessionStorage.removeItem("gcmv_restore_fullscreen");
        }
      }, 300);

      // One-time fallback on user touch/pointer or desktop mouse/keyboard interaction
      const onUserTouch = (evt) => {
        if (sessionStorage.getItem("gcmv_restore_fullscreen") === "true") {
          sessionStorage.removeItem("gcmv_restore_fullscreen");
          const btn = document.querySelector(
            ".fullscreen-icon, button.fullscreen-icon, button[aria-label='Full screen'], button[aria-label='fullscreen'], .ytp-fullscreen-button, .icon-button.player-control-fullscreen"
          );
          const vid = document.querySelector("video");
          const target = evt && evt.target;
          const isPlayerTarget = target && (target.closest("#movie_player, .html5-video-player, video") || target.tagName === "VIDEO");

          if (btn && typeof btn.click === "function") {
            btn.click();
          } else if (vid && typeof vid.requestFullscreen === "function") {
            vid.requestFullscreen().catch(() => {});
          }

          // If the user tapped/clicked on the video itself to recover fullscreen, YouTube's default click handler
          // pauses the video. Automatically unpause so there is no accidental pause glitch!
          if (isPlayerTarget) {
            setTimeout(() => {
              if (vid && vid.paused && !window.__gachaUserManuallyPaused) {
                vid.play().catch(() => {});
              }
              const p = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
              if (p && typeof p.playVideo === "function") {
                try { p.playVideo(); } catch (_) {}
              }
            }, 80);
          }
        }
      };
      ["pointerdown", "touchstart", "click", "mousedown", "keydown"].forEach((evt) => {
        window.addEventListener(evt, onUserTouch, { once: true, capture: true });
        document.addEventListener(evt, onUserTouch, { once: true, capture: true });
      });
    } catch (e) {}
  }

  window.__gachaRestoreFullscreen = checkAndRestoreFullscreen;

  function navigateToVideo(videoId, title, stripMix = false, playlistId = "", playlistIndex = "") {
    if (!videoId) return;
    recordCurrentTrackSession(videoId, title);
    const wasFullscreen = isPlayerMediaFullscreen();
    if (!wasFullscreen) {
      saveFullscreenStateBeforeNavigate();
    }
    recordRecentPlayedVideoId(videoId);
    window.__gachaUserManuallyPaused = false;
    lastNavigatedTime = Date.now();

    let cleanPath = "/watch?v=" + videoId;
    if (!stripMix && playlistId) {
      cleanPath += "&list=" + encodeURIComponent(playlistId);
      if (playlistIndex) cleanPath += "&index=" + encodeURIComponent(playlistIndex);
    } else if (stripMix) {
      cleanPath += "&gcmv_queue=1";
    }
    const fullCleanUrl = "https://" + (window.location.host || "m.youtube.com") + cleanPath;

    // 1. Try desktop YouTube movie_player SPA navigation (preserves fullscreen seamlessly without reload)
    const moviePlayer = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
    if (moviePlayer) {
      dispatchMainWorldPlayerAction("loadVideoById", videoId);
      try {
        if (typeof moviePlayer.loadVideoById === "function") {
          moviePlayer.loadVideoById(videoId);
          if (typeof moviePlayer.playVideo === "function") {
            moviePlayer.playVideo();
          }
        }
      } catch (_) {}
      try {
        window.history.pushState(null, "", cleanPath);
        // Do NOT dispatch yt-navigate-finish when in fullscreen: it causes ytd-watch-flexy to re-render and drop fullscreen!
        if (!wasFullscreen) {
          window.dispatchEvent(new CustomEvent("yt-navigate-finish"));
        }
      } catch (e) {}
      if (title) showToast("▶️ Playing: " + title + " 🌸");
      setTimeout(() => {
        attemptAutoplayRecovery("navigateToVideo");
      }, 350);

      // Verify that the video changed after 2500ms; if stuck and NOT in fullscreen, fallback to hard navigation
      setTimeout(() => {
        if (getCurrentVideoId() !== videoId && !isPlayerMediaFullscreen() && !window.AndroidBridge) {
          window.location.href = fullCleanUrl;
        }
      }, 2500);
      return;
    }

    // 2. AndroidBridge native navigation
    if (window.AndroidBridge && typeof window.AndroidBridge.loadUrl === "function") {
      saveFullscreenStateBeforeNavigate();
      window.AndroidBridge.loadUrl("https://m.youtube.com" + cleanPath);
      return;
    }

    // 3. Fallback to location.href
    saveFullscreenStateBeforeNavigate();
    window.location.href = fullCleanUrl;
  }

  window.__gachaPlayNow = navigateToVideo;

  function handleFullscreenState() {
    const isPlayerFull = isPlayerMediaFullscreen();
    const widget = document.getElementById("gacha-floating-widget");
    const skipOverlay = document.getElementById("gacha-skip-overlay");

    if (isPlayerFull) {
      document.body?.classList.add("gacha-player-fullscreen");

      if (widget) {
        widget.classList.add("gacha-player-fullscreen-hidden");
        widget.style.setProperty("display", "none", "important");
      }
      if (skipOverlay) {
        skipOverlay.classList.add("gacha-player-fullscreen-hidden");
        skipOverlay.style.setProperty("display", "none", "important");
      }
    } else {
      document.body?.classList.remove("gacha-player-fullscreen");

      if (widget) {
        widget.classList.remove("gacha-player-fullscreen-hidden");
        if (settings.enabled && settings.showJukebox) {
          widget.style.removeProperty("display");
        }
      }
      if (skipOverlay) {
        skipOverlay.classList.remove("gacha-player-fullscreen-hidden");
        skipOverlay.style.removeProperty("display");
      }
    }
  }

  function setupFullscreenListener() {
    [
      "fullscreenchange",
      "webkitfullscreenchange",
      "mozfullscreenchange",
      "MSFullscreenChange",
      "resize",
      "keydown",
      "keyup"
    ].forEach((evt) => {
      document.addEventListener(evt, handleFullscreenState, { passive: true });
      window.addEventListener(evt, handleFullscreenState, { passive: true });
    });

    // Relaxed heartbeat interval check for YouTube player transitions
    setInterval(handleFullscreenState, 1000);
  }

  // ==========================================================
  // Auto-Skip Official / Non-Gacha Videos & YouTube Mixes
  // ==========================================================
  function findFirstGachaAfterCurrentInMix(targetVideoId = "") {
    const playlistItems = document.querySelectorAll(
      "ytd-playlist-panel-renderer #items ytd-playlist-panel-video-renderer, ytm-playlist-video-renderer, ytm-compact-playlist-video-renderer"
    );
    if (!playlistItems || playlistItems.length === 0) return null;

    let foundCurrent = false;
    const currentVId = targetVideoId || (new URLSearchParams(window.location.search).get("v") || "");

    for (let i = 0; i < playlistItems.length; i++) {
      const item = playlistItems[i];
      const link = item.querySelector("a#wc-endpoint, a#thumbnail, a.media-item-thumbnail-container, a");

      let itemVideoId = "";
      if (link && link.href) {
        try {
          const u = new URL(link.href, window.location.origin);
          itemVideoId = u.searchParams.get("v") || "";
        } catch (e) {}
      }

      const isSelected =
        (currentVId && itemVideoId === currentVId) ||
        item.hasAttribute("selected") ||
        item.classList.contains("selected") ||
        item.classList.contains("active");

      if (isSelected) {
        foundCurrent = true;
        continue;
      }

      if (foundCurrent) {
        const titleEl = item.querySelector("#video-title, .media-item-headline, .compact-media-item-headline, .title");
        const channelEl = item.querySelector("#byline, #channel-name, .media-item-byline, .compact-media-item-byline");
        const title = titleEl ? titleEl.textContent.trim() : "";
        const channel = channelEl ? channelEl.textContent.trim() : "";

        if (isGachaVideo(title, channel, "", itemVideoId)) {
          return { element: link || item, title: title, videoId: itemVideoId };
        }
      }
    }

    return null;
  }

  function findNextNonGachaSkipTargetInMix(targetVideoId = "") {
    const playlistItems = document.querySelectorAll(
      "ytd-playlist-panel-renderer #items ytd-playlist-panel-video-renderer, ytm-playlist-video-renderer, ytm-compact-playlist-video-renderer"
    );
    if (!playlistItems || playlistItems.length === 0) return null;

    let currentIndex = -1;
    const currentVId = targetVideoId || (new URLSearchParams(window.location.search).get("v") || "");

    const parsedItems = [];
    for (let i = 0; i < playlistItems.length; i++) {
      const item = playlistItems[i];
      const link = item.querySelector("a#wc-endpoint, a#thumbnail, a.media-item-thumbnail-container, a");

      let itemVideoId = "";
      if (link && link.href) {
        try {
          const u = new URL(link.href, window.location.origin);
          itemVideoId = u.searchParams.get("v") || "";
        } catch (e) {}
      }

      const isSelected =
        (currentVId && itemVideoId === currentVId) ||
        item.hasAttribute("selected") ||
        item.classList.contains("selected") ||
        item.classList.contains("active");

      const titleEl = item.querySelector("#video-title, .media-item-headline, .compact-media-item-headline, .title");
      const channelEl = item.querySelector("#byline, #channel-name, .media-item-byline, .compact-media-item-byline");
      const title = titleEl ? titleEl.textContent.trim() : "";
      const channel = channelEl ? channelEl.textContent.trim() : "";

      parsedItems.push({
        element: link || item,
        title,
        channel,
        videoId: itemVideoId,
        isGacha: isGachaVideo(title, channel, "", itemVideoId)
      });

      if (isSelected && currentIndex === -1) {
        currentIndex = i;
      }
    }

    if (currentIndex === -1) return null;

    const nextIndex = currentIndex + 1;
    if (nextIndex >= parsedItems.length) return null;

    // If the immediate next video in mix is already Gacha, do NOT skip!
    if (parsedItems[nextIndex].isGacha) {
      return null;
    }

    // The immediate next video is non-Gacha. Find the next Gacha video after it to skip the non-Gacha song(s).
    for (let i = nextIndex + 1; i < parsedItems.length; i++) {
      if (parsedItems[i].isGacha) {
        return parsedItems[i];
      }
    }

    return null;
  }

  function findFirstGachaRecommendation() {
    const recommendations = document.querySelectorAll(
      "ytd-compact-video-renderer, ytd-video-renderer, ytd-rich-item-renderer, ytm-compact-video-renderer, ytm-video-with-context-renderer, ytm-rich-item-renderer, ytm-watch-next-video-renderer, ytm-media-item, .compact-media-item, .media-item"
    );
    if (!recommendations || recommendations.length === 0) return null;

    for (let i = 0; i < recommendations.length; i++) {
      const rec = recommendations[i];
      const titleEl = rec.querySelector("#video-title, #title, .media-item-headline, .compact-media-item-headline, .video-title, h3, h4");
      const channelEl = rec.querySelector("#channel-name, #byline, .media-item-byline, .compact-media-item-byline, ytm-channel-name");
      const title = titleEl?.textContent?.trim() || "";
      const channel = channelEl?.textContent?.trim() || "";
      const link = rec.querySelector("a#thumbnail, a.yt-simple-endpoint, a.media-item-thumbnail-container, a.compact-media-item-image, a[href*='watch']");

      let recVideoId = "";
      if (link && link.href) {
        try {
          const u = new URL(link.href, window.location.origin);
          recVideoId = u.searchParams.get("v") || "";
          if (!recVideoId && u.pathname.startsWith("/watch/")) {
            recVideoId = u.pathname.replace("/watch/", "");
          }
        } catch (e) {}
      }

      if (isGachaVideo(title, channel, "", recVideoId)) {
        return { element: link || rec, title, channel, videoId: recVideoId };
      }
    }

    return null;
  }

  function getVerifiedCurrentVideoMetadata(targetVideoId) {
    if (!targetVideoId) return null;

    let title = "";
    let channel = "";
    let description = "";
    let keywords = [];
    let isVerified = false;

    // 1. Try extracting directly from YouTube's movie_player API (verified by video_id)
    try {
      const moviePlayer = document.querySelector("#movie_player");
      if (moviePlayer && typeof moviePlayer.getVideoData === "function") {
        const vData = moviePlayer.getVideoData();
        if (vData && vData.video_id === targetVideoId) {
          title = vData.title || "";
          channel = vData.author || "";
          if (title) {
            isVerified = true;
          }
        }
      }
    } catch (e) {}

    // 2. Try extracting from ytd-watch-flexy polymer component (verified by videoId)
    try {
      const watchFlexy = document.querySelector("ytd-watch-flexy");
      if (watchFlexy) {
        const flexyVideoId = watchFlexy.getAttribute("video-id") || watchFlexy.videoId;
        const pDetails = watchFlexy.playerData?.videoDetails;
        if (pDetails && (pDetails.videoId === targetVideoId || flexyVideoId === targetVideoId)) {
          if (!title) title = pDetails.title || "";
          if (!channel) channel = pDetails.author || "";
          if (!description) description = pDetails.shortDescription || "";
          if (Array.isArray(pDetails.keywords)) keywords = pDetails.keywords;
          if (title) {
            isVerified = true;
          }
        }
      }
    } catch (e) {}

    // 3. Check DOM elements if URL or canonical link matches targetVideoId
    const isUrlMatch = window.location.href.includes(targetVideoId);
    const canonicalLink = document.querySelector('link[rel="canonical"]')?.href || "";
    const isCanonicalMatch = canonicalLink.includes(targetVideoId);

    const watchFlexyEl = document.querySelector("ytd-watch-flexy");
    const flexyVideoAttr = watchFlexyEl?.getAttribute("video-id") || "";
    const isFlexyMatch = flexyVideoAttr === targetVideoId;

    if (isUrlMatch || isCanonicalMatch || isFlexyMatch) {
      const titleEl =
        document.querySelector("h1.ytd-watch-metadata yt-formatted-string") ||
        document.querySelector("#title h1") ||
        document.querySelector("h1.title") ||
        document.querySelector("ytm-slim-video-metadata-renderer .slim-video-metadata-title") ||
        document.querySelector("h2.slim-video-metadata-title") ||
        document.querySelector(".slim-video-metadata-title") ||
        document.querySelector("ytm-video-description-header-renderer .slim-video-metadata-title") ||
        document.querySelector(".video-details .title") ||
        document.querySelector("h2.title") ||
        document.querySelector("h1");

      const channelEl =
        document.querySelector("ytd-channel-name yt-formatted-string") ||
        document.querySelector("#owner #channel-name a") ||
        document.querySelector("ytm-slim-owner-renderer .slim-owner-channel-name") ||
        document.querySelector(".slim-owner-channel-name a") ||
        document.querySelector(".ytm-badge-and-byline-item-byline") ||
        document.querySelector("ytm-channel-name") ||
        document.querySelector(".channel-name") ||
        document.querySelector(".byline");

      const descEl =
        document.querySelector("#description-inner") ||
        document.querySelector("#description yt-formatted-string") ||
        document.querySelector("ytd-text-inline-expander") ||
        document.querySelector("ytm-expandable-video-description-body-renderer") ||
        document.querySelector("ytm-structured-description-content-renderer") ||
        document.querySelector(".structured-description-header-description") ||
        document.querySelector(".slim-video-metadata-description") ||
        document.querySelector(".video-description");

      const domTitle = titleEl ? titleEl.textContent.trim() : "";
      const domChannel = channelEl ? channelEl.textContent.trim() : "";
      const domDesc = descEl ? descEl.textContent.trim() : "";

      if (!title && domTitle) title = domTitle;
      if (!channel && domChannel) channel = domChannel;
      if (!description && domDesc) description = domDesc;

      // Also fallback to document.title if present
      if (!title && document.title && document.title.includes("YouTube")) {
        const cleanedDocTitle = document.title.replace(/\s*-\s*YouTube$/i, "").trim();
        if (cleanedDocTitle && !["YouTube", "Home", "Explore", "Subscriptions"].includes(cleanedDocTitle)) {
          title = cleanedDocTitle;
        }
      }

      if (title) {
        isVerified = true;
      }
    }

    return {
      title,
      channel,
      description,
      keywords,
      isVerified
    };
  }

  function getCurrentVideoId() {
    const urlParams = new URLSearchParams(window.location.search);
    let vid = urlParams.get("v") || "";
    if (vid) return vid;

    const path = window.location.pathname;
    if (path.startsWith("/watch/")) {
      vid = path.replace("/watch/", "").split("/")[0].split("?")[0];
    } else if (path.startsWith("/shorts/")) {
      vid = path.replace("/shorts/", "").split("/")[0].split("?")[0];
    } else if (path.startsWith("/embed/")) {
      vid = path.replace("/embed/", "").split("/")[0].split("?")[0];
    }

    if (!vid) {
      const canonical = document.querySelector('link[rel="canonical"]')?.href || "";
      const match = canonical.match(/[?&]v=([a-zA-Z0-9_-]+)/);
      if (match) vid = match[1];
    }

    if (!vid) {
      const flexy = document.querySelector("ytd-watch-flexy, ytm-watch");
      vid = flexy?.getAttribute("video-id") || "";
    }

    return vid || "";
  }

  function checkCurrentVideoForAutoSkip() {
    if (!settings.enabled || !settings.autoSkipNonGacha) return;

    const videoId = getCurrentVideoId();
    if (!videoId) return;

    if (userDismissedSkipForVideoId === videoId) {
      return;
    }

    const currentGen = ++autoSkipCheckGeneration;
    if (autoSkipPollTimer) {
      clearTimeout(autoSkipPollTimer);
      autoSkipPollTimer = null;
    }

    let attempts = 0;
    const maxAttempts = 30; // 30 * 100ms = 3.0 seconds

    function pollMetadata() {
      if (currentGen !== autoSkipCheckGeneration) return;

      const currentUrlVideoId = getCurrentVideoId();
      if (currentUrlVideoId !== videoId) return;

      const meta = getVerifiedCurrentVideoMetadata(videoId);
      attempts++;

      if (meta && meta.title) {
        const title = meta.title;
        const channel = meta.channel;
        const description = meta.description;
        const keywords = meta.keywords;

        // 1. Check if it's Gacha (including description, keywords, and whitelist)
        if (isGachaVideo(title, channel, description, videoId, keywords)) {
          removeSkipOverlay();
          restoreAutoSkipMute();
          return;
        }

        // 2. Strict Mode: ANY video that is not Gacha is immediately skipped!
        triggerAutoSkip(title, channel, videoId);
        return;
      }

      if (attempts < maxAttempts) {
        autoSkipPollTimer = setTimeout(pollMetadata, 100);
      }
    }

    autoSkipPollTimer = setTimeout(pollMetadata, 50);
  }

  function muteForAutoSkip(video) {
    if (!video) return;
    if (autoSkipMutedVideo && autoSkipMutedVideo !== video) restoreAutoSkipMute();
    if (autoSkipMutedVideo !== video) {
      autoSkipMutedVideo = video;
      autoSkipPreviousMuted = video.muted;
    }
    video.muted = true;
  }

  function restoreAutoSkipMute() {
    if (!autoSkipMutedVideo) return;
    autoSkipMutedVideo.muted = autoSkipPreviousMuted;
    autoSkipMutedVideo = null;
    autoSkipPreviousMuted = false;
  }

  function triggerAutoSkip(title, channel, videoId) {
    removeSkipOverlay();
    window.__gachaUserManuallyPaused = false;
    lastNavigatedTime = Date.now();

    // 1. Immediately mute and pause the video so non-Gacha audio/video does NOT play aloud
    const video =
      document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (video) {
      try {
        muteForAutoSkip(video);
        video.pause();
      } catch (e) {}
    }

    const currentVid = getCurrentVideoId();
    if (currentVid !== videoId) return; // Abort if user navigated away

    const isMix =
      window.location.search.includes("list=") ||
      Boolean(document.querySelector("ytd-playlist-panel-renderer, ytm-playlist-video-renderer, .playlist-items"));

    const nextGachaInMix = isMix ? findFirstGachaAfterCurrentInMix(videoId) : null;
    const nextGachaRec = !nextGachaInMix ? findFirstGachaRecommendation() : null;
    const gachaSearchQuery = cleanSongTitleForGacha(title);

    // 2. Smart Transition
    if (nextGachaInMix && nextGachaInMix.element) {
      showToast(`🛡️ Non-Gacha skipped ➔ ${nextGachaInMix.title.substring(0, 24)}... 🌸`, videoId, channel);
      nextGachaInMix.element.click();
      setTimeout(() => { attemptAutoplayRecovery("autoskip-mix"); }, 500);
    } else if (nextGachaRec && nextGachaRec.element) {
      showToast(`🛡️ Non-Gacha skipped ➔ ${nextGachaRec.title.substring(0, 24)}... 🌸`, videoId, channel);
      nextGachaRec.element.click();
      setTimeout(() => { attemptAutoplayRecovery("autoskip-rec"); }, 500);
    } else {
      showToast(`🛡️ Non-Gacha skipped ➔ Finding GCMV version... 🌸`, videoId, channel);
      executeYoutubeSearch(gachaSearchQuery);
    }
  }

  function removeSkipOverlay() {
    if (currentSkipTimer) {
      clearInterval(currentSkipTimer);
      currentSkipTimer = null;
    }
    const el = document.getElementById("gacha-skip-overlay");
    if (el) el.remove();
  }

  // ==========================================================
  // Feed & Sidebar Highlights, Dims & "It's Gacha!" Button (Solution 1 & 3)
  // ==========================================================
  function applyFeedBadgesAndFilters(forceAll = false) {
    if (!settings.enabled || !settings.filterOfficialVideos) return;

    if (forceAll) {
      document.querySelectorAll("[data-gacha-checked]").forEach((el) => {
        el.removeAttribute("data-gacha-checked");
      });
    }

    const cards = document.querySelectorAll(
      "ytd-video-renderer:not([data-gacha-checked]), ytd-compact-video-renderer:not([data-gacha-checked]), ytd-grid-video-renderer:not([data-gacha-checked]), ytd-rich-item-renderer:not([data-gacha-checked]), ytm-video-with-context-renderer:not([data-gacha-checked]), ytm-compact-video-renderer:not([data-gacha-checked]), ytm-rich-item-renderer:not([data-gacha-checked]), ytm-playlist-video-renderer:not([data-gacha-checked]), ytm-shorts-lockup-view-model:not([data-gacha-checked]), ytm-media-item:not([data-gacha-checked]), .compact-media-item:not([data-gacha-checked]), .media-item:not([data-gacha-checked])"
    );

    if (!cards || cards.length === 0) return;

    cards.forEach((card) => {
      const titleEl = card.querySelector("#video-title, #title, .media-item-headline, .compact-media-item-headline, .video-title, h3 a, h4 a, h3 .yt-core-attributed-string, h4 .yt-core-attributed-string, .yt-core-attributed-string");
      const channelEl = card.querySelector("#channel-name, #byline, ytd-channel-name, .media-item-byline, .compact-media-item-byline, ytm-channel-name, .ytm-badge-and-byline-item-byline");
      const thumbEl = card.querySelector("ytd-thumbnail, #thumbnail, .media-item-thumbnail-container, ytm-thumbnail-cover, .thumbnail, a.media-item-thumbnail-container, a.compact-media-item-image, yt-img-shadow, .ytThumbnailViewModelHost");
      const snippetEl = card.querySelector(
        ".metadata-snippet-container, #description-text, .snippet-text, ytd-metadata-snippet-renderer, .media-item-snippet"
      );

      let title = titleEl && titleEl.textContent ? titleEl.textContent.trim() : "";
      if (!title) {
        const labeled = card.querySelector("a[href*='watch'][aria-label], a[href*='/shorts/'][aria-label]");
        if (labeled) title = (labeled.getAttribute("aria-label") || "").trim();
      }
      if (!title) return; // Do not mark skeleton placeholders! Wait until YouTube populates the title.

      const badgeHost = thumbEl || card.querySelector("a[href*='watch'], a[href*='/shorts/']") || card;

      card.setAttribute("data-gacha-checked", "1");
      const channel = channelEl ? channelEl.textContent.trim() : "";
      const description = snippetEl ? snippetEl.textContent.trim() : "";

      // Extract video ID from thumbnail href
      let videoId = "";
      const link = card.querySelector("a#thumbnail, a.yt-simple-endpoint, a.media-item-thumbnail-container, a.compact-media-item-image, a[href*='watch'], a[href*='/shorts/']");
      if (link && link.href) {
        try {
          const u = new URL(link.href, window.location.origin);
          videoId = u.searchParams.get("v") || "";
          if (!videoId && u.pathname.startsWith("/watch/")) {
            videoId = u.pathname.replace("/watch/", "");
          }
          if (!videoId && u.pathname.startsWith("/shorts/")) {
            videoId = u.pathname.replace("/shorts/", "").split("/")[0];
          }
        } catch (e) {}
      }

      // Check if it's Gacha (Title, Channel, Description, or Whitelisted)
      if (isGachaVideo(title, channel, description, videoId)) {
        card.classList.remove("gacha-dimmed-video");

        // Remove any whitelist button if present
        const oldWBtn = badgeHost.querySelector(".gacha-whitelist-btn");
        if (oldWBtn) oldWBtn.remove();

        // Add verified badge
        if (!badgeHost.querySelector(".gacha-verified-badge")) {
          const badge = document.createElement("span");
          badge.className = "gacha-verified-badge";
          badge.textContent = title.toLowerCase().includes("lyric") ? "🎀 Gacha Lyrics" : "🌸 Gacha MV";
          badgeHost.style.position = "relative";
          badgeHost.appendChild(badge);
        }
      } else {
        // Any video that is NOT Gacha is dimmed
        card.classList.add("gacha-dimmed-video");
        const badge = badgeHost.querySelector(".gacha-verified-badge");
        if (badge) badge.remove();

        // Add 1-Click "It's Gacha!" button onto dimmed card (Solution 3)
        if (!badgeHost.querySelector(".gacha-whitelist-btn")) {
          const wBtn = document.createElement("button");
          wBtn.className = "gacha-whitelist-btn";
          wBtn.textContent = "🌸 It's Gacha!";
          wBtn.title = "Click to mark as Gacha and never dim or skip again";
          badgeHost.style.position = "relative";

          wBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            whitelistGacha(videoId, channel);
          });

          badgeHost.appendChild(wBtn);
        }
      }
    });
  }

  function cleanFeedBadges() {
    document.querySelectorAll("[data-gacha-checked]").forEach((el) => el.removeAttribute("data-gacha-checked"));
    document.querySelectorAll(".gacha-verified-badge").forEach((b) => b.remove());
    document.querySelectorAll(".gacha-whitelist-btn").forEach((b) => b.remove());
    document.querySelectorAll(".gacha-dimmed-video").forEach((c) => c.classList.remove("gacha-dimmed-video"));
  }

  // ==========================================================
  // Quick Search Chips Injection
  // ==========================================================
  const CHIP_PRESETS = [
    { label: "🌸 GCMV Only", query: "GCMV Gacha Club Music Video" },
    { label: "✨ GLMV Classic", query: "GLMV Gacha Life Music Video" },
    { label: "🌟 GLMV2 New", query: "GLMV2 Gacha Life 2 MV" },
    { label: "🎀 Gacha Lyrics", query: "Gacha Lyric Video GLMV GCMV" },
    { label: "🔥 Trending Gacha", query: "Trending GCMV GLMV" },
    { label: "💔 Emotional/Sad", query: "Sad Emotional GCMV GLMV" },
    { label: "⚡ High Energy/Rock", query: "Upbeat Rock Nightcore GCMV" },
    { label: "🎲 Random Gacha MV", query: "Best GCMV songs compilation" }
  ];

  function getChipsMountTarget() {
    const path = window.location.pathname;
    if (path.startsWith("/watch")) {
      // Do not inject search chips in sidebar on watch pages
      return null;
    }

    const existingHost = document.getElementById("gacha-chips-host");
    const mobileTopbar = document.querySelector("ytm-mobile-topbar-renderer");
    const chipBar = document.querySelector("ytm-feed-filter-chip-bar-renderer, ytd-feed-filter-chip-bar-renderer, ytm-chip-cloud-renderer");
    const masthead = document.querySelector("#masthead-container, ytd-masthead");

    if (existingHost && document.contains(existingHost)) {
      if (mobileTopbar && existingHost.previousElementSibling !== mobileTopbar && mobileTopbar.parentNode) {
        mobileTopbar.insertAdjacentElement("afterend", existingHost);
      }
      return existingHost;
    }

    const host = document.createElement("div");
    host.id = "gacha-chips-host";

    if (mobileTopbar && mobileTopbar.parentNode) {
      mobileTopbar.insertAdjacentElement("afterend", host);
    } else if (chipBar && chipBar.parentNode) {
      chipBar.insertAdjacentElement("beforebegin", host);
    } else if (masthead && masthead.parentNode) {
      masthead.insertAdjacentElement("afterend", host);
    } else {
      const parent = document.body || document.documentElement;
      parent.insertBefore(host, parent.firstChild);
    }
    return host;
  }

  function injectSearchChips() {
    if (!settings.enabled || !settings.showSearchChips) {
      removeSearchChips();
      return;
    }

    if (window.location.pathname.startsWith("/watch")) {
      removeSearchChips();
      return;
    }

    const target = getChipsMountTarget();
    if (!target) return;

    const existing = document.getElementById("gacha-search-chips-bar");
    if (existing) {
      if (existing.parentElement === target) return;
      existing.remove();
    }

    const chipsBar = document.createElement("div");
    chipsBar.id = "gacha-search-chips-bar";

    const label = document.createElement("span");
    label.className = "gacha-chip-label";
    label.textContent = "🌸 Gacha MV:";
    chipsBar.appendChild(label);

    CHIP_PRESETS.forEach((preset) => {
      const chip = document.createElement("button");
      chip.className = "gacha-chip";
      chip.textContent = preset.label;
      chip.title = `Search ${preset.query} on YouTube`;

      chip.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        executeYoutubeSearch(preset.query);
      });

      chipsBar.appendChild(chip);
    });

    target.prepend(chipsBar);
    handleFullscreenState();
  }

  function removeSearchChips() {
    const el = document.getElementById("gacha-search-chips-bar");
    if (el) el.remove();
  }

  function executeYoutubeSearch(query) {
    if (!query) return;

    // 1. Try filling search input
    const input =
      document.querySelector("input#search") ||
      document.querySelector("input[name='search_query']") ||
      document.querySelector("input.ytd-searchbox") ||
      document.querySelector("input.search-input") ||
      document.querySelector("ytm-searchbox input");

    if (input) {
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));

      const form = document.querySelector("form#search-form") || input.closest("form");
      if (form) {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    }

    // 2. Direct SPA / Browser Navigation
    const searchUrl = `/results?search_query=${encodeURIComponent(query)}`;
    if (window.AndroidBridge && typeof window.AndroidBridge.loadUrl === "function") {
      window.AndroidBridge.loadUrl(`https://m.youtube.com${searchUrl}`);
    } else {
      window.location.href = searchUrl;
    }
  }

  // ==========================================================
  // Floating Jukebox Widget (With Streams, Skip List, & Settings Tabs)
  // ==========================================================
  function injectFloatingJukebox() {
    const existing = document.getElementById("gacha-floating-widget");
    if (existing) {
      if (!existing.querySelector("#inpageToggleNas") || !existing.querySelector("#btnInpagePrevTrack")) {
        existing.remove(); // Auto-upgrade DOM to latest version with player controls & NAS
      } else {
        return;
      }
    }

    const widget = document.createElement("div");
    widget.id = "gacha-floating-widget";

    const widgetDoc = new DOMParser().parseFromString(asTrustedHtml(`
      <!-- Launcher Button -->
      <button class="gacha-float-btn" id="gachaFloatToggle" title="Open Gacha MV Jukebox & Skip List">
        <span class="gacha-float-icon">🌸</span>
        <span>Gacha Jukebox</span>
        <div class="gacha-eq">
          <span></span><span></span><span></span>
        </div>
      </button>

      <!-- Panel Drawer -->
      <div class="gacha-panel gacha-hidden" id="gachaJukeboxPanel">
        <!-- Mobile Drag/Swipe Handle -->
        <div class="gacha-drawer-handle-bar" id="gachaDrawerHandleBar">
          <span class="gacha-drawer-handle"></span>
        </div>

        <div class="gacha-panel-header">
          <div class="gacha-panel-title">
            <span>🌸</span>
            <strong>Gacha MV Player</strong>
          </div>
          <button class="gacha-panel-close" id="gachaPanelClose" title="Close">✕</button>
        </div>

        <!-- Navigation Tabs (3 Tabs) -->
        <div class="gacha-panel-tabs">
          <button class="gacha-tab-btn active" id="gachaTabMusic">🎵 Streams</button>
          <button class="gacha-tab-btn" id="gachaTabSkipList">📋 Skip List</button>
          <button class="gacha-tab-btn" id="gachaTabSettings">⚙️ Settings</button>
        </div>

        <!-- Tab 1: Music Streams & Search -->
        <div class="gacha-tab-content" id="gachaTabContentMusic">
          <div class="gacha-guard-status">
            <span>🛡️ Non-Gacha Skipper</span>
            <span id="gachaPanelSkipperStatus" style="color:#00ffaa;">ACTIVE</span>
          </div>

          <!-- In-Panel Playback Navigation & Loop Bar -->
          <div class="gacha-panel-player-bar" id="inpagePlayerControls">
            <div class="gacha-player-btn-group">
              <button type="button" class="gacha-player-btn" id="btnInpagePrevTrack" title="Previous Track (Shift+P, Alt+Left)">⏮️ Prev</button>
              <button type="button" class="gacha-player-btn gacha-player-btn-primary" id="btnInpagePlayPause" title="Play / Pause">⏯️ Play</button>
              <button type="button" class="gacha-player-btn" id="btnInpageSkipNext" title="Skip to Next">⏭️ Next</button>
            </div>
            <div class="gacha-player-loop-group">
              <span class="gacha-loop-label">🔁 Loop:</span>
              <select id="inpageSelectLoopMode" class="gacha-loop-select" title="Loop Mode">
                <option value="off">Off</option>
                <option value="once">🔂 Loop Once</option>
                <option value="infinite">🔁 Loop Indefinitely</option>
              </select>
            </div>
          </div>

          <!-- In-Panel Volume Booster (1x - 10x) -->
          <div class="gacha-panel-volume-box">
            <div class="gacha-panel-vol-header">
              <div class="gacha-panel-vol-title">
                <span>🔊 Volume Booster</span>
                <span class="gacha-panel-limiter-badge">🛡️ Anti-Distortion</span>
              </div>
              <span class="gacha-panel-vol-badge" id="inpageVolumeBadge">100% (1.0x)</span>
            </div>
            <div class="gacha-panel-vol-slider-wrap">
              <input type="range" id="inpageVolumeSlider" min="100" max="1000" step="10" value="100" class="gacha-panel-vol-range" />
              <div class="gacha-panel-vol-ticks">
                <span>1x</span><span>3x</span><span>5x</span><span>8x</span><span>10x</span>
              </div>
            </div>
            <div class="gacha-panel-vol-presets">
              <button type="button" class="inpage-vol-preset active" data-boost="100">1x</button>
              <button type="button" class="inpage-vol-preset" data-boost="200">2x</button>
              <button type="button" class="inpage-vol-preset" data-boost="400">4x</button>
              <button type="button" class="inpage-vol-preset" data-boost="600">6x</button>
              <button type="button" class="inpage-vol-preset" data-boost="1000">10x MAX</button>
              <button type="button" class="inpage-vol-reset" id="btnInpageVolumeReset">↩️ Reset</button>
            </div>
          </div>

          <!-- Active Remote Queue Section -->
          <div class="gacha-panel-queue-box" id="inpageQueueBox" style="background:#211a3e; border-radius:12px; padding:10px; margin-bottom:12px; border:1px solid rgba(0, 229, 255, 0.25);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <span style="font-size:12px; font-weight:700; color:#00e5ff;">📋 Active Remote Queue (<span id="inpageQueueCount">0</span>)</span>
              <button type="button" id="btnInpageClearQueue" style="background:none; border:none; color:#ff2e93; font-size:11px; font-weight:700; cursor:pointer;">Clear</button>
            </div>
            <div id="inpageQueueItems" style="max-height:120px; overflow-y:auto;">
              <div style="color:#a09bb8; font-size:11px; font-style:italic;">No queued videos. Send one from your phone!</div>
            </div>
          </div>

          <div class="gacha-panel-search">
            <input type="text" id="gachaPanelSearchInput" placeholder="Search any song as GCMV..." />
            <button id="gachaPanelSearchBtn">Go</button>
          </div>

          <div class="gacha-playlist-list">
            <button class="gacha-item-btn" data-query="GCMV Gacha Club Music Video 2024">
              <span class="gacha-item-icon">🌸</span>
              <div class="gacha-item-info">
                <strong>GCMV Club Stream</strong>
                <small>Top Gacha Club music videos</small>
              </div>
            </button>

            <button class="gacha-item-btn" data-query="GLMV Gacha Life Music Video Best">
              <span class="gacha-item-icon">✨</span>
              <div class="gacha-item-info">
                <strong>GLMV Classic Hits</strong>
                <small>Timeless Gacha Life music videos</small>
              </div>
            </button>

            <button class="gacha-item-btn" data-query="GLMV2 Gacha Life 2 Music Video">
              <span class="gacha-item-icon">🌟</span>
              <div class="gacha-item-info">
                <strong>GLMV2 Fresh Releases</strong>
                <small>Next-gen Gacha Life 2 creations</small>
              </div>
            </button>

            <button class="gacha-item-btn" data-query="Gacha Lyric Video GLMV GCMV">
              <span class="gacha-item-icon">🎀</span>
              <div class="gacha-item-info">
                <strong>Gacha Lyric Videos</strong>
                <small>GLMV & GCMV with animated lyrics</small>
              </div>
            </button>

            <button class="gacha-item-btn" data-query="Sad Emotional GCMV GLMV Story">
              <span class="gacha-item-icon">💔</span>
              <div class="gacha-item-info">
                <strong>Story & Emotional MVs</strong>
                <small>Deep storyline music videos</small>
              </div>
            </button>

            <button class="gacha-item-btn" data-query="High Energy Rock Nightcore GCMV">
              <span class="gacha-item-icon">⚡</span>
              <div class="gacha-item-info">
                <strong>Upbeat & Nightcore</strong>
                <small>Fast-paced energetic songs</small>
              </div>
            </button>

            <button class="gacha-item-btn" data-query="Gacha Singing Battle GCMV GLMV">
              <span class="gacha-item-icon">🎤</span>
              <div class="gacha-item-info">
                <strong>Singing Battles</strong>
                <small>Voice & singing battle edits</small>
              </div>
            </button>
          </div>
        </div>

        <!-- Tab 2: Current Video Skiplist & Custom Segments -->
        <div class="gacha-tab-content gacha-hidden" id="gachaTabContentSkipList">
          <!-- POI Drop Highlight Banner -->
          <div id="gachaPoiBanner" class="gacha-poi-card gacha-hidden"></div>

          <!-- Segments Header -->
          <div class="gacha-skiplist-header">
            <span>Video Skip Segments</span>
            <span class="gacha-badge-count" id="gachaSkipCountBadge">0 segments</span>
          </div>

          <!-- Segments List -->
          <div class="gacha-segments-list" id="gachaSegmentsList">
            <span class="gacha-empty-note">Open a YouTube video to view skip segments and POI highlights.</span>
          </div>

          <!-- Add Custom Skip / POI Drop Box -->
          <div class="gacha-add-segment-box">
            <div class="gacha-add-seg-title">
              <span>➕ Add Custom Timestamp Skip</span>
            </div>
            <div class="gacha-add-seg-grid">
              <div class="gacha-input-group">
                <label>Category:</label>
                <select id="gachaAddCategory" class="gacha-select">
                  <option value="custom">✂️ Custom Segment</option>
                  <option value="poi_highlight">🌟 Highlight / Music Drop</option>
                  <option value="music_offtopic">🎵 Non-Music / Dialogue</option>
                  <option value="intro">🎬 Intro Scene</option>
                  <option value="outro">🏁 Outro / Credits</option>
                  <option value="sponsor">🛡️ Sponsor Segment</option>
                  <option value="selfpromo">📢 Self Promotion</option>
                </select>
              </div>
              <div class="gacha-time-row">
                <div class="gacha-input-group">
                  <label>Start (s):</label>
                  <div class="gacha-time-input-wrap">
                    <input type="number" step="0.5" id="gachaAddStart" class="gacha-time-input" placeholder="0.0">
                    <button type="button" class="gacha-time-cur-btn" id="gachaBtnCurStart" title="Set to current video timestamp">📍 Now</button>
                  </div>
                </div>
                <div class="gacha-input-group" id="gachaAddEndWrap">
                  <label>End (s):</label>
                  <div class="gacha-time-input-wrap">
                    <input type="number" step="0.5" id="gachaAddEnd" class="gacha-time-input" placeholder="0.0">
                    <button type="button" class="gacha-time-cur-btn" id="gachaBtnCurEnd" title="Set to current video timestamp">📍 Now</button>
                  </div>
                </div>
              </div>
              <button type="button" class="gacha-btn-add-skip" id="gachaBtnAddCustomSkip">💾 Save & Sync Skip Segment</button>
            </div>
          </div>
        </div>

        <!-- Tab 3: In-Page YouTube Settings -->
        <div class="gacha-tab-content gacha-hidden" id="gachaTabContentSettings">
          <div class="gacha-inpage-settings-list">
            <!-- Master Extension Toggle -->
            <label class="gacha-inpage-item gacha-inpage-master" for="inpageToggleMaster">
              <div class="gacha-inpage-desc">
                <span class="gacha-inpage-title">Extension Active</span>
                <span class="gacha-inpage-sub">Master power switch</span>
              </div>
              <input type="checkbox" id="inpageToggleMaster" class="gacha-inpage-switch" ${settings.enabled ? "checked" : ""}>
            </label>

            <!-- YouTube Video & Cosmetic Ad Blocker -->
            <label class="gacha-inpage-item" for="inpageToggleBlockAds">
              <div class="gacha-inpage-desc">
                <span class="gacha-inpage-title">🛡️ YouTube Ad Blocker</span>
                <span class="gacha-inpage-sub">Auto-skips video ads, mutes promos & hides banners</span>
              </div>
              <input type="checkbox" id="inpageToggleBlockAds" class="gacha-inpage-switch" ${settings.blockAds !== false ? "checked" : ""}>
            </label>

            <!-- Auto-Skip Non-Gacha -->
            <label class="gacha-inpage-item" for="inpageToggleAutoSkip">
              <div class="gacha-inpage-desc">
                <span class="gacha-inpage-title">⏭️ Auto-Skip Official & Plain Lyrics</span>
                <span class="gacha-inpage-sub">Redirects non-Gacha songs to GCMV versions</span>
              </div>
              <input type="checkbox" id="inpageToggleAutoSkip" class="gacha-inpage-switch" ${settings.autoSkipNonGacha ? "checked" : ""}>
            </label>

            <!-- SponsorBlock & Custom Segments -->
            <label class="gacha-inpage-item" for="inpageToggleSkipNonMusic">
              <div class="gacha-inpage-desc">
                <span class="gacha-inpage-title">⚡ Skip Dialogue / Story Talking</span>
                <span class="gacha-inpage-sub">Jumps straight to the song</span>
              </div>
              <input type="checkbox" id="inpageToggleSkipNonMusic" class="gacha-inpage-switch" ${settings.skipNonMusic ? "checked" : ""}>
            </label>

            <label class="gacha-inpage-item" for="inpageToggleSkipIntroOutro">
              <div class="gacha-inpage-desc">
                <span class="gacha-inpage-title">⏩ Skip Intros & Outros</span>
                <span class="gacha-inpage-sub">Skips intro logos and end screens</span>
              </div>
              <input type="checkbox" id="inpageToggleSkipIntroOutro" class="gacha-inpage-switch" ${settings.skipIntroOutro ? "checked" : ""}>
            </label>

            <label class="gacha-inpage-item" for="inpageToggleSkipSponsor">
              <div class="gacha-inpage-desc">
                <span class="gacha-inpage-title">🛡️ Skip Sponsors & Self-Promos</span>
                <span class="gacha-inpage-sub">Skips promotional segments</span>
              </div>
              <input type="checkbox" id="inpageToggleSkipSponsor" class="gacha-inpage-switch" ${settings.skipSponsor ? "checked" : ""}>
            </label>

            <label class="gacha-inpage-item" for="inpageTogglePoiHighlights">
              <div class="gacha-inpage-desc">
                <span class="gacha-inpage-title">🌟 POI Highlights & Drops</span>
                <span class="gacha-inpage-sub">Auto-skips to music drop &amp; shows timeline star</span>
              </div>
              <input type="checkbox" id="inpageTogglePoiHighlights" class="gacha-inpage-switch" ${settings.showPoiHighlights ? "checked" : ""}>
            </label>

            <label class="gacha-inpage-item" for="inpageToggleSponsorBlock">
              <div class="gacha-inpage-desc">
                <span class="gacha-inpage-title">🌐 SponsorBlock API</span>
                <span class="gacha-inpage-sub">Fetch public segments from sponsor.ajay.app</span>
              </div>
              <input type="checkbox" id="inpageToggleSponsorBlock" class="gacha-inpage-switch" ${settings.useSponsorBlockApi ? "checked" : ""}>
            </label>

            <label class="gacha-inpage-item" for="inpageToggleCustomDb">
              <div class="gacha-inpage-desc">
                <span class="gacha-inpage-title">💾 Custom Segments DB</span>
                <span class="gacha-inpage-sub">Use your custom timestamp skips</span>
              </div>
              <input type="checkbox" id="inpageToggleCustomDb" class="gacha-inpage-switch" ${settings.useCustomDb ? "checked" : ""}>
            </label>

            <!-- Self-Hosted NAS Database -->
            <div class="gacha-nas-box">
              <label class="gacha-inpage-item gacha-inpage-nas" for="inpageToggleNas">
                <div class="gacha-inpage-desc">
                  <span class="gacha-inpage-title">🏠 Self-Hosted NAS Database</span>
                  <span class="gacha-inpage-sub">Sync with Synology, TrueNAS, unRAID, or Docker</span>
                </div>
                <input type="checkbox" id="inpageToggleNas" class="gacha-inpage-switch" ${settings.useNasServer ? "checked" : ""}>
              </label>

              <div id="gachaNasDetails" class="gacha-nas-details${settings.useNasServer ? "" : " gacha-hidden"}">
                <div class="gacha-nas-input-group">
                  <label>NAS Server URL:</label>
                  <div class="gacha-nas-input-row">
                    <input type="text" id="gachaNasUrlInput" class="gacha-time-input" placeholder="http://192.168.1.50:3080" value="">
                    <button type="button" class="gacha-btn-nas-test" id="gachaBtnNasTest" title="Test connection to NAS">⚡ Test</button>
                  </div>
                  <label>NAS access token:</label>
                  <input type="password" id="gachaNasTokenInput" class="gacha-time-input" placeholder="Token configured on your NAS server" value="" autocomplete="off">
                  <div id="gachaNasStatusBadge" class="gacha-nas-status-badge"></div>
                </div>

                <label class="gacha-inpage-item gacha-nas-subitem" for="inpageToggleNasAutoSync">
                  <div class="gacha-inpage-desc">
                    <span class="gacha-inpage-title" style="font-size:11px;">🔄 Auto-Sync New Skips to NAS</span>
                    <span class="gacha-inpage-sub">Uploads custom skips to NAS immediately</span>
                  </div>
                  <input type="checkbox" id="inpageToggleNasAutoSync" class="gacha-inpage-switch" ${settings.nasAutoSync ? "checked" : ""}>
                </label>

                <div class="gacha-nas-sync-btns">
                  <button type="button" class="gacha-btn-nas-action" id="gachaBtnNasExport">💾 Backup All to NAS</button>
                  <button type="button" class="gacha-btn-nas-action" id="gachaBtnNasImport">📥 Restore from NAS</button>
                </div>
              </div>
            </div>

            <!-- Phone Remote & Queue Card -->
            <div class="gacha-nas-box" style="margin-top:10px;">
              <label class="gacha-inpage-item" for="inpageToggleRemote">
                <div class="gacha-inpage-desc">
                  <span class="gacha-inpage-title">📱 Phone Remote Control &amp; Queue</span>
                  <span class="gacha-inpage-sub">Add songs &amp; control playback from phone</span>
                </div>
                <input type="checkbox" id="inpageToggleRemote" class="gacha-inpage-switch" ${settings.remoteServerEnabled !== false ? "checked" : ""}>
              </label>
              <div id="inpageRemoteDetails" class="gacha-nas-details">
                <div class="gacha-nas-input-group">
                  <label>Remote Web URL:</label>
                  <div class="gacha-nas-input-row">
                    <input type="text" id="inpageRemoteUrlInput" class="gacha-time-input" readonly value="Loading...">
                    <button type="button" class="gacha-btn-nas-test" id="btnInpageCopyRemoteUrl">📋 Copy</button>
                  </div>
                  <div id="inpageRemoteIpChips" style="display:none; gap:6px; flex-wrap:wrap; margin-top:8px;"></div>
                  <div id="inpageRemoteQrContainer" style="text-align: center; margin-top: 10px; background: rgba(0,0,0,0.25); padding: 10px; border-radius: 8px;">
                    <div id="inpageRemoteQrBox" style="width: 140px; height: 140px; margin: 0 auto; background: #fff; padding: 6px; border-radius: 6px; display: flex; align-items: center; justify-content: center; box-sizing: border-box; cursor: pointer;" title="Click to copy URL"></div>
                    <div style="font-size: 11px; color: #a09bb8; margin-top: 6px;">📷 Scan with phone camera to open</div>
                  </div>
                  <div style="margin-top: 12px; padding-top: 10px; border-top: 1px dashed rgba(255, 46, 147, 0.3);">
                    <label class="gacha-inpage-item" for="inpageToggleBottomLeftQr" style="padding: 6px 0; background: transparent; margin: 0;">
                      <div class="gacha-inpage-desc">
                        <span class="gacha-inpage-title" style="font-size: 12px;">📱 Display QR Code at Bottom Left</span>
                        <span class="gacha-inpage-sub">Show on-screen floating QR badge so viewers can scan anytime</span>
                      </div>
                      <input type="checkbox" id="inpageToggleBottomLeftQr" class="gacha-inpage-switch" ${Boolean(settings.showBottomLeftQr || settings.showBottomRightQr) ? "checked" : ""}>
                    </label>

                    <label class="gacha-inpage-item" id="inpageRowQrFullscreen" for="inpageToggleQrFullscreen" style="padding: 6px 0; background: transparent; margin: 0; ${Boolean(settings.showBottomLeftQr || settings.showBottomRightQr) ? '' : 'display:none;'}">
                      <div class="gacha-inpage-desc">
                        <span class="gacha-inpage-title" style="font-size: 12px;">📺 Show QR Code in Fullscreen</span>
                        <span class="gacha-inpage-sub">Keep floating QR badge visible during fullscreen video playback</span>
                      </div>
                      <input type="checkbox" id="inpageToggleQrFullscreen" class="gacha-inpage-switch" ${settings.showQrInFullscreen !== false ? "checked" : ""}>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <!-- Autoplay Guard -->
            <label class="gacha-inpage-item" for="inpageToggleAutoplayGuard">
              <div class="gacha-inpage-desc">
                <span class="gacha-inpage-title">🛡️ Gacha Autoplay Guard</span>
                <span class="gacha-inpage-sub">Keeps autoplay strictly on GCMV / GLMV</span>
              </div>
              <input type="checkbox" id="inpageToggleAutoplayGuard" class="gacha-inpage-switch" ${settings.autoplayGuard ? "checked" : ""}>
            </label>

            <!-- Auto Unmute Audio -->
            <label class="gacha-inpage-item" for="inpageToggleAutoUnmute">
              <div class="gacha-inpage-desc">
                <span class="gacha-inpage-title">🔊 Auto Unmute Audio</span>
                <span class="gacha-inpage-sub">Unmutes videos on load &amp; after ads</span>
              </div>
              <input type="checkbox" id="inpageToggleAutoUnmute" class="gacha-inpage-switch" ${settings.autoUnmute !== false ? "checked" : ""}>
            </label>

            <!-- Smooth Playback / Low-End Hardware -->
            <label class="gacha-inpage-item" for="inpageToggleSmoothPlayback">
              <div class="gacha-inpage-desc">
                <span class="gacha-inpage-title">🚀 Smooth Playback (Low-Spec / TV Box)</span>
                <span class="gacha-inpage-sub">Forces H.264 hardware decoding &amp; fixes buffer pauses</span>
              </div>
              <input type="checkbox" id="inpageToggleSmoothPlayback" class="gacha-inpage-switch" ${settings.smoothPlayback !== false ? "checked" : ""}>
            </label>

            <!-- Preferred Resolution -->
            <div class="gacha-inpage-item">
              <div class="gacha-inpage-desc">
                <span class="gacha-inpage-title">📺 Preferred Resolution</span>
                <span class="gacha-inpage-sub">Auto fallback to highest if not found</span>
              </div>
              <select id="inpageSelectResolution" class="gacha-inpage-select">
                <option value="auto" ${settings.preferredResolution === "auto" ? "selected" : ""}>Auto</option>
                <option value="2160p" ${settings.preferredResolution === "2160p" ? "selected" : ""}>4K (2160p)</option>
                <option value="1440p" ${settings.preferredResolution === "1440p" ? "selected" : ""}>1440p (2K)</option>
                <option value="1080p" ${settings.preferredResolution === "1080p" ? "selected" : ""}>1080p</option>
                <option value="720p" ${settings.preferredResolution === "720p" ? "selected" : ""}>720p</option>
                <option value="480p" ${settings.preferredResolution === "480p" ? "selected" : ""}>480p</option>
                <option value="360p" ${settings.preferredResolution === "360p" ? "selected" : ""}>360p</option>
                <option value="240p" ${settings.preferredResolution === "240p" ? "selected" : ""}>240p</option>
                <option value="144p" ${settings.preferredResolution === "144p" ? "selected" : ""}>144p</option>
              </select>
            </div>

            <!-- Search Filter Chips -->
            <label class="gacha-inpage-item" for="inpageToggleSearchChips">
              <div class="gacha-inpage-desc">
                <span class="gacha-inpage-title">🏷️ Search Filter Chips</span>
                <span class="gacha-inpage-sub">Tags below YouTube search bar</span>
              </div>
              <input type="checkbox" id="inpageToggleSearchChips" class="gacha-inpage-switch" ${settings.showSearchChips ? "checked" : ""}>
            </label>

            <!-- Highlight & Dim -->
            <label class="gacha-inpage-item" for="inpageToggleFilterOfficial">
              <div class="gacha-inpage-desc">
                <span class="gacha-inpage-title">✨ Highlight & Dim Feeds</span>
                <span class="gacha-inpage-sub">Gacha badges & dims plain videos</span>
              </div>
              <input type="checkbox" id="inpageToggleFilterOfficial" class="gacha-inpage-switch" ${settings.filterOfficialVideos ? "checked" : ""}>
            </label>
          </div>
        </div>
      </div>
    `), "text/html");

    while (widgetDoc.body.firstChild) {
      widget.appendChild(widgetDoc.body.firstChild);
    }

    const target = document.body || document.documentElement;
    if (!target) return;
    target.appendChild(widget);
    markAndroidHost();
    if (isAndroidApp()) {
      widget.classList.add("gacha-android-embedded");
    }

    // Mobile Backdrop Overlay
    let backdrop = document.getElementById("gacha-drawer-backdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.id = "gacha-drawer-backdrop";
      target.appendChild(backdrop);
    }
    backdrop.onclick = () => closePanel();

    const toggleBtn = widget.querySelector("#gachaFloatToggle");
    const panel = widget.querySelector("#gachaJukeboxPanel");
    const closeBtn = widget.querySelector("#gachaPanelClose");
    const drawerHandleBar = widget.querySelector("#gachaDrawerHandleBar");

    const tabMusic = widget.querySelector("#gachaTabMusic");
    const tabSkipList = widget.querySelector("#gachaTabSkipList");
    const tabSettings = widget.querySelector("#gachaTabSettings");
    const contentMusic = widget.querySelector("#gachaTabContentMusic");
    const contentSkipList = widget.querySelector("#gachaTabContentSkipList");
    const contentSettings = widget.querySelector("#gachaTabContentSettings");

    const searchInput = widget.querySelector("#gachaPanelSearchInput");
    const searchBtn = widget.querySelector("#gachaPanelSearchBtn");
    const playlistItems = widget.querySelectorAll(".gacha-item-btn");

    const inpageToggleMaster = widget.querySelector("#inpageToggleMaster");
    const inpageToggleBlockAds = widget.querySelector("#inpageToggleBlockAds");
    const inpageToggleAutoSkip = widget.querySelector("#inpageToggleAutoSkip");
    const inpageToggleSkipNonMusic = widget.querySelector("#inpageToggleSkipNonMusic");
    const inpageToggleSkipIntroOutro = widget.querySelector("#inpageToggleSkipIntroOutro");
    const inpageToggleSkipSponsor = widget.querySelector("#inpageToggleSkipSponsor");
    const inpageTogglePoiHighlights = widget.querySelector("#inpageTogglePoiHighlights");
    const inpageToggleSponsorBlock = widget.querySelector("#inpageToggleSponsorBlock");
    const inpageToggleCustomDb = widget.querySelector("#inpageToggleCustomDb");
    const inpageToggleNas = widget.querySelector("#inpageToggleNas");
    const nasDetails = widget.querySelector("#gachaNasDetails");
    const nasUrlInput = widget.querySelector("#gachaNasUrlInput");
    const nasTokenInput = widget.querySelector("#gachaNasTokenInput");
    const btnNasTest = widget.querySelector("#gachaBtnNasTest");
    const nasStatusBadge = widget.querySelector("#gachaNasStatusBadge");
    const inpageToggleNasAutoSync = widget.querySelector("#inpageToggleNasAutoSync");
    const btnNasExport = widget.querySelector("#gachaBtnNasExport");
    const btnNasImport = widget.querySelector("#gachaBtnNasImport");
    const inpageToggleAutoplayGuard = widget.querySelector("#inpageToggleAutoplayGuard");
    const inpageToggleAutoUnmute = widget.querySelector("#inpageToggleAutoUnmute");
    const inpageToggleSmoothPlayback = widget.querySelector("#inpageToggleSmoothPlayback");
    const inpageSelectResolution = widget.querySelector("#inpageSelectResolution");
    const inpageToggleSearchChips = widget.querySelector("#inpageToggleSearchChips");
    const inpageToggleFilterOfficial = widget.querySelector("#inpageToggleFilterOfficial");

    const inpageQueueCount = widget.querySelector("#inpageQueueCount");
    const inpageQueueItems = widget.querySelector("#inpageQueueItems");
    const btnInpageClearQueue = widget.querySelector("#btnInpageClearQueue");
    const inpageToggleRemote = widget.querySelector("#inpageToggleRemote");
    const inpageRemoteDetails = widget.querySelector("#inpageRemoteDetails");
    const inpageRemoteUrlInput = widget.querySelector("#inpageRemoteUrlInput");
    const btnInpageCopyRemoteUrl = widget.querySelector("#btnInpageCopyRemoteUrl");

    async function refreshInpageQueue() {
      if (!inpageQueueItems || !inpageQueueCount) return;
      let items = [];
      if (cloudRemoteQueue && cloudRemoteQueue.length > 0) {
        items = [...cloudRemoteQueue];
      }
      if (window.AndroidBridge && typeof window.AndroidBridge.getQueueJson === "function") {
        try {
          const bridgeItems = JSON.parse(window.AndroidBridge.getQueueJson()) || [];
          items = [...items, ...bridgeItems];
        } catch (e) {}
      } else {
        const serverUrl = (settings.remoteServerUrl || settings.nasServerUrl || "http://127.0.0.1:3000").trim().replace(/\/+$/, "");
        try {
          const res = await fetch(serverUrl + "/api/queue", { cache: "no-store" });
          if (res.ok) {
            const data = await res.json();
            items = [...items, ...(data.queue || [])];
          }
        } catch (e) {}
      }

      inpageQueueCount.textContent = items.length;
      if (items.length === 0) {
        inpageQueueItems.innerHTML = '<div style="color:#a09bb8; font-size:11px; font-style:italic; padding:4px 0;">No queued videos. Send one from your phone!</div>';
      } else {
        inpageQueueItems.innerHTML = items.map((it, idx) => `
          <div style="display:flex; align-items:center; justify-content:space-between; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.06);">
            <span style="font-size:11px; font-weight:bold; color:#00e5ff; margin-right:6px;">${idx + 1}.</span>
            <span style="font-size:11px; color:#fff; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${it.title || it.videoId}</span>
            <button type="button" class="btn-inpage-play-now" data-vid="${it.videoId}" data-id="${it.id}" style="background:none; border:none; color:#00ffaa; font-size:11px; font-weight:bold; cursor:pointer; padding:2px 6px;">▶ Play</button>
            <button type="button" class="btn-inpage-del-item" data-id="${it.id}" style="background:none; border:none; color:#ff4444; font-size:11px; cursor:pointer; padding:2px 4px;">✕</button>
          </div>
        `).join("");

        inpageQueueItems.querySelectorAll(".btn-inpage-play-now").forEach(btn => {
          btn.onclick = () => {
            const vid = btn.getAttribute("data-vid");
            const qId = btn.getAttribute("data-id");
            if (cloudRemoteQueue && cloudRemoteQueue.some(it => it.id === qId)) {
              cloudRemoteQueue = cloudRemoteQueue.filter(it => it.id !== qId);
              extStorage.set({ cloudRemoteQueue }).catch(() => {});
              broadcastCloudState();
            }
            if (window.AndroidBridge && typeof window.AndroidBridge.removeQueueItem === "function") {
              window.AndroidBridge.removeQueueItem(qId);
            }
            captureCurrentMixState();
            navigateToVideo(vid, "", true);
          };
        });

        inpageQueueItems.querySelectorAll(".btn-inpage-del-item").forEach(btn => {
          btn.onclick = async () => {
            const qId = btn.getAttribute("data-id");
            if (cloudRemoteQueue && cloudRemoteQueue.some(it => it.id === qId)) {
              cloudRemoteQueue = cloudRemoteQueue.filter(it => it.id !== qId);
              await extStorage.set({ cloudRemoteQueue });
              broadcastCloudState();
            }
            if (window.AndroidBridge && typeof window.AndroidBridge.removeQueueItem === "function") {
              window.AndroidBridge.removeQueueItem(qId);
            } else {
              const serverUrl = (settings.remoteServerUrl || settings.nasServerUrl || "http://127.0.0.1:3000").trim().replace(/\/+$/, "");
              await fetch(serverUrl + "/api/queue?id=" + encodeURIComponent(qId), { method: "DELETE" }).catch(() => {});
            }
            refreshInpageQueue();
          };
        });
      }
    }

    if (btnInpageClearQueue) {
      btnInpageClearQueue.onclick = async () => {
        cloudRemoteQueue = [];
        await extStorage.set({ cloudRemoteQueue });
        broadcastCloudState();
        if (window.AndroidBridge && typeof window.AndroidBridge.clearQueue === "function") {
          window.AndroidBridge.clearQueue();
        } else {
          const serverUrl = (settings.remoteServerUrl || settings.nasServerUrl || "http://127.0.0.1:3000").trim().replace(/\/+$/, "");
          await fetch(serverUrl + "/api/queue", { method: "DELETE" }).catch(() => {});
        }
        refreshInpageQueue();
      };
    }

    const inpageRemoteQrBox = widget.querySelector("#inpageRemoteQrBox");
    const inpageRemoteQrContainer = widget.querySelector("#inpageRemoteQrContainer");

    function renderInpageQrCode(url) {
      renderBottomRightQrCode(url);
      if (!inpageRemoteQrBox || !url || url === "Server Stopped") {
        if (inpageRemoteQrContainer) inpageRemoteQrContainer.classList.add("gacha-hidden");
        return;
      }
      try {
        const painted = paintQrCode(inpageRemoteQrBox, url);
        if (inpageRemoteQrContainer) {
          inpageRemoteQrContainer.classList.toggle("gacha-hidden", !painted);
        }
        if (!painted) console.warn("[GCMV] QR render error: generator unavailable");
      } catch (e) {
        console.warn("[GCMV] QR render error:", e);
      }
    }

    if (inpageRemoteUrlInput) {
      (async () => {
        if (window.AndroidBridge && typeof window.AndroidBridge.getCloudRoomCode === "function") {
          const bCode = window.AndroidBridge.getCloudRoomCode();
          if (bCode) cloudRoomCode = bCode;
        }

        let bestUrl = "";
        let addresses = [];
        let serverPort = 8080;

        if (cloudRoomCode) {
          bestUrl = `https://itsmemusicchilly.github.io/GCMV-only-videos-extension/remote/?room=${cloudRoomCode}`;
        }

        if (window.AndroidBridge && typeof window.AndroidBridge.getRemoteServerUrl === "function") {
          const localU = window.AndroidBridge.getRemoteServerUrl();
          if (localU && localU !== "Server Stopped") {
            try {
              const parsed = new URL(localU);
              addresses.push({ name: "Local Wi-Fi", ip: parsed.hostname, type: "wifi" });
              serverPort = parseInt(parsed.port, 10) || 8080;
            } catch (_) {}
          }
        } else {
          let probeUrl = settings.remoteServerUrl || "";
          if (!probeUrl) {
            const probePorts = [3000, 3001, 3002, 8080, 8081];
            for (const port of probePorts) {
              try {
                const res = await fetch(`http://127.0.0.1:${port}/api/status`, { cache: "no-store" });
                if (res.ok) {
                  const data = await res.json();
                  serverPort = port;
                  if (data && Array.isArray(data.addresses)) {
                    addresses = data.addresses;
                  }
                  if (data && data.serverUrl) {
                    probeUrl = data.serverUrl;
                    break;
                  } else if (data && data.ip) {
                    probeUrl = `http://${data.ip}:${port}/remote`;
                    break;
                  }
                }
              } catch (e) {}
            }
          }
          if (!bestUrl && probeUrl) bestUrl = probeUrl;
        }

        if (!bestUrl) {
          bestUrl = cloudRoomCode
            ? `https://itsmemusicchilly.github.io/GCMV-only-videos-extension/remote/?room=${cloudRoomCode}`
            : "http://127.0.0.1:3000/remote";
        }

        inpageRemoteUrlInput.value = bestUrl;
        renderInpageQrCode(bestUrl);

        const chipsContainer = widget.querySelector("#inpageRemoteIpChips");
        if (chipsContainer) {
          chipsContainer.innerHTML = "";
          if (cloudRoomCode) {
            const roomBtn = document.createElement("button");
            roomBtn.type = "button";
            roomBtn.className = "gacha-btn-nas-test";
            roomBtn.textContent = `🔑 Room: ${cloudRoomCode}`;
            roomBtn.style.cssText = "font-size:11px; padding:4px 8px; border-radius:12px; margin:2px; cursor:pointer; background:linear-gradient(135deg,#ff2e93,#7928ca); color:#fff; border:none; font-weight:700;";
            roomBtn.onclick = () => {
              const cloudUrl = `https://itsmemusicchilly.github.io/GCMV-only-videos-extension/remote/?room=${cloudRoomCode}`;
              inpageRemoteUrlInput.value = cloudUrl;
              renderInpageQrCode(cloudUrl);
            };
            chipsContainer.appendChild(roomBtn);
          }
          if (addresses.length > 0) {
            chipsContainer.style.display = "flex";
            addresses.forEach((info) => {
              const btn = document.createElement("button");
              btn.type = "button";
              btn.className = "gacha-btn-nas-test";
              const icon = info.type === "tailscale" ? "🔒" : info.type === "wifi" ? "📶" : info.type === "ethernet" ? "🌐" : "📱";
              btn.textContent = `${icon} ${info.name}: ${info.ip}`;
              btn.style.cssText = "font-size:11px; padding:4px 8px; border-radius:12px; margin:2px; cursor:pointer;";
              btn.onclick = () => {
                const newUrl = `http://${info.ip}:${serverPort}/remote`;
                inpageRemoteUrlInput.value = newUrl;
                renderInpageQrCode(newUrl);
              };
              chipsContainer.appendChild(btn);
            });
          } else if (cloudRoomCode) {
            chipsContainer.style.display = "flex";
          } else {
            chipsContainer.style.display = "none";
          }
        }
      })();
    }

    const copyInpageUrl = () => {
      if (inpageRemoteUrlInput && inpageRemoteUrlInput.value && inpageRemoteUrlInput.value !== "Server Stopped" && inpageRemoteUrlInput.value !== "Loading...") {
        navigator.clipboard.writeText(inpageRemoteUrlInput.value).then(() => {
          showToast("📋 Remote URL copied to clipboard! 🌸");
        }).catch(() => {});
      }
    };

    if (btnInpageCopyRemoteUrl) btnInpageCopyRemoteUrl.onclick = copyInpageUrl;
    if (inpageRemoteQrBox) inpageRemoteQrBox.onclick = copyInpageUrl;
    if (inpageRemoteUrlInput) inpageRemoteUrlInput.onclick = copyInpageUrl;

    if (inpageToggleRemote) {
      inpageToggleRemote.onchange = async (e) => {
        const isRemote = e.target.checked;
        settings.remoteServerEnabled = isRemote;
        if (inpageRemoteDetails) inpageRemoteDetails.classList.toggle("gacha-hidden", !isRemote);
        await extStorage.set({ remoteServerEnabled: isRemote });
        if (window.AndroidBridge && typeof window.AndroidBridge.savePref === "function") {
          window.AndroidBridge.savePref("remoteServerEnabled", JSON.stringify(isRemote));
        }
      };
    }

    const inpageToggleBottomLeftQr = widget.querySelector("#inpageToggleBottomLeftQr") || widget.querySelector("#inpageToggleBottomRightQr");
    const inpageToggleQrFullscreen = widget.querySelector("#inpageToggleQrFullscreen");
    const inpageRowQrFullscreen = widget.querySelector("#inpageRowQrFullscreen");

    if (inpageToggleBottomLeftQr) {
      inpageToggleBottomLeftQr.onchange = async (e) => {
        const val = e.target.checked;
        settings.showBottomLeftQr = val;
        settings.showBottomRightQr = val;
        bottomLeftQrDismissed = false;
        if (inpageRowQrFullscreen) inpageRowQrFullscreen.style.display = val ? "" : "none";
        await extStorage.set({ showBottomLeftQr: val, showBottomRightQr: val });
        updateBottomLeftQrVisibility();
        if (window.AndroidBridge && typeof window.AndroidBridge.savePref === "function") {
          window.AndroidBridge.savePref("showBottomLeftQr", JSON.stringify(val));
          window.AndroidBridge.savePref("showBottomRightQr", JSON.stringify(val));
        }
      };
    }

    if (inpageToggleQrFullscreen) {
      inpageToggleQrFullscreen.onchange = async (e) => {
        const val = e.target.checked;
        settings.showQrInFullscreen = val;
        await extStorage.set({ showQrInFullscreen: val });
        updateBottomLeftQrVisibility();
        if (window.AndroidBridge && typeof window.AndroidBridge.savePref === "function") {
          window.AndroidBridge.savePref("showQrInFullscreen", JSON.stringify(val));
        }
      };
    }

    const btnCurStart = widget.querySelector("#gachaBtnCurStart");
    const btnCurEnd = widget.querySelector("#gachaBtnCurEnd");
    const inputStart = widget.querySelector("#gachaAddStart");
    const inputEnd = widget.querySelector("#gachaAddEnd");
    const selectCat = widget.querySelector("#gachaAddCategory");
    const btnAddCustomSkip = widget.querySelector("#gachaBtnAddCustomSkip");

    const btnInpagePrevTrack = widget.querySelector("#btnInpagePrevTrack");
    const btnInpagePlayPause = widget.querySelector("#btnInpagePlayPause");
    const btnInpageSkipNext = widget.querySelector("#btnInpageSkipNext");
    const inpageSelectLoopMode = widget.querySelector("#inpageSelectLoopMode");

    if (btnInpagePrevTrack) {
      btnInpagePrevTrack.onclick = () => playPreviousTrack();
    }
    if (btnInpagePlayPause) {
      btnInpagePlayPause.onclick = () => togglePlayPause();
    }
    if (btnInpageSkipNext) {
      btnInpageSkipNext.onclick = () => executeSkipNextTrack("user_skip");
    }
    if (inpageSelectLoopMode) {
      inpageSelectLoopMode.value = currentLoopMode;
      inpageSelectLoopMode.onchange = (e) => setLoopMode(e.target.value);
    }

    function openPanel() {
      const p = document.getElementById("gachaJukeboxPanel");
      if (!p) return;
      p.classList.remove("gacha-hidden");
      p.style.setProperty("display", "flex", "important");
      jukeboxPanelOpen = true;

      updateInpagePlayPauseState();
      const loopSel = document.getElementById("inpageSelectLoopMode");
      if (loopSel) loopSel.value = currentLoopMode;

      const bd = document.getElementById("gacha-drawer-backdrop");
      if (bd) bd.classList.add("active");

      if (activePanelTab === "music") {
        refreshInpageQueue();
        setTimeout(() => {
          const sInput = document.getElementById("gachaPanelSearchInput");
          if (sInput) sInput.focus();
        }, 60);
      } else if (activePanelTab === "skiplist") {
        updateSkipListUI();
      }
    }

    function closePanel() {
      persistNasCredentialsFromDom();
      const p = document.getElementById("gachaJukeboxPanel");
      if (!p) return;
      p.classList.add("gacha-hidden");
      p.style.setProperty("display", "none", "important");
      jukeboxPanelOpen = false;

      const bd = document.getElementById("gacha-drawer-backdrop");
      if (bd) bd.classList.remove("active");
    }

    // Expose control functions to window for Android app and navigation bridges
    window.__gachaOpenPanel = openPanel;
    window.__gachaClosePanel = closePanel;
    window.__gachaOpenSettings = function() {
      injectFloatingJukebox();
      const tabS = document.getElementById("gachaTabSettings");
      if (tabS) tabS.click();
      openPanel();
    };
    window.__gachaOpenJukebox = function() {
      injectFloatingJukebox();
      const tabM = document.getElementById("gachaTabMusic");
      if (tabM) tabM.click();
      openPanel();
    };
    window.__gachaOpenSkipList = function() {
      injectFloatingJukebox();
      const tabL = document.getElementById("gachaTabSkipList");
      if (tabL) tabL.click();
      openPanel();
    };

    function togglePanel(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const p = document.getElementById("gachaJukeboxPanel");
      if (!p) return;

      const isCurrentlyHidden = p.classList.contains("gacha-hidden") || p.style.display === "none";
      if (isCurrentlyHidden) {
        openPanel();
      } else {
        closePanel();
      }
    }

    if (toggleBtn) toggleBtn.addEventListener("click", togglePanel);
    if (panel) panel.addEventListener("click", (e) => e.stopPropagation());

    if (closeBtn) {
      closeBtn.onclick = function (e) {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        closePanel();
      };
    }

    // Touch Swipe-Down to close drawer on mobile screens
    let touchStartY = 0;
    let touchCurrentY = 0;
    if (drawerHandleBar) {
      drawerHandleBar.addEventListener(
        "touchstart",
        (e) => {
          if (e.touches && e.touches[0]) {
            touchStartY = e.touches[0].clientY;
          }
        },
        { passive: true }
      );

      drawerHandleBar.addEventListener(
        "touchmove",
        (e) => {
          if (e.touches && e.touches[0]) {
            touchCurrentY = e.touches[0].clientY;
          }
        },
        { passive: true }
      );

      drawerHandleBar.addEventListener(
        "touchend",
        () => {
          if (touchCurrentY > 0 && touchCurrentY - touchStartY > 45) {
            closePanel();
          }
          touchStartY = 0;
          touchCurrentY = 0;
        },
        { passive: true }
      );
    }

    if (!window.__gachaJukeboxOutsideClickAttached__) {
      window.__gachaJukeboxOutsideClickAttached__ = true;
      document.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        const widgetEl = document.getElementById("gacha-floating-widget");
        const p = document.getElementById("gachaJukeboxPanel");
        const bd = document.getElementById("gacha-drawer-backdrop");
        if (jukeboxPanelOpen && widgetEl && p) {
          if (!widgetEl.contains(e.target) && e.target !== bd) {
            closePanel();
          }
        }
      });
    }

    function setTab(tabName) {
      activePanelTab = tabName;
      [tabMusic, tabSkipList, tabSettings].forEach((t) => t && t.classList.remove("active"));
      [contentMusic, contentSkipList, contentSettings].forEach((c) => c && c.classList.add("gacha-hidden"));

      if (tabName === "music") {
        if (tabMusic) tabMusic.classList.add("active");
        if (contentMusic) contentMusic.classList.remove("gacha-hidden");
        refreshInpageQueue();
      } else if (tabName === "skiplist") {
        if (tabSkipList) tabSkipList.classList.add("active");
        if (contentSkipList) contentSkipList.classList.remove("gacha-hidden");
        updateSkipListUI();
      } else if (tabName === "settings") {
        if (tabSettings) tabSettings.classList.add("active");
        if (contentSettings) contentSettings.classList.remove("gacha-hidden");
      }
    }

    if (tabMusic) tabMusic.addEventListener("click", () => setTab("music"));
    if (tabSkipList) tabSkipList.addEventListener("click", () => setTab("skiplist"));
    if (tabSettings) tabSettings.addEventListener("click", () => setTab("settings"));

    if (inpageToggleMaster) {
      inpageToggleMaster.addEventListener("change", async (e) => {
        const isEnabled = e.target.checked;
        await extStorage.set({ enabled: isEnabled });
        showToast(isEnabled ? "🌸 Gacha MV Mode Enabled!" : "⏸️ Gacha MV Mode Disabled");
      });
    }

    if (inpageToggleBlockAds) {
      inpageToggleBlockAds.addEventListener("change", async (e) => {
        const isBlocked = e.target.checked;
        await extStorage.set({ blockAds: isBlocked });
        settings.blockAds = isBlocked;
        document.body?.classList.toggle("gacha-block-ads", settings.enabled && settings.blockAds !== false);
        runAdBlockerCycle();
        showToast(isBlocked ? "🛡️ YouTube Ad Blocker ON" : "🛡️ YouTube Ad Blocker OFF");
      });
    }

    if (inpageToggleAutoSkip) {
      inpageToggleAutoSkip.addEventListener("change", async (e) => {
        await extStorage.set({ autoSkipNonGacha: e.target.checked });
        showToast(e.target.checked ? "⏭️ Non-Gacha Auto-Skip ON" : "⏭️ Auto-Skip OFF");
      });
    }

    if (inpageToggleSkipNonMusic) {
      inpageToggleSkipNonMusic.addEventListener("change", async (e) => {
        await extStorage.set({ skipNonMusic: e.target.checked });
        activeSegmentVideoId = "";
        loadVideoSegments(new URLSearchParams(window.location.search).get("v"));
      });
    }

    if (inpageToggleSkipIntroOutro) {
      inpageToggleSkipIntroOutro.addEventListener("change", async (e) => {
        await extStorage.set({ skipIntroOutro: e.target.checked });
        activeSegmentVideoId = "";
        loadVideoSegments(new URLSearchParams(window.location.search).get("v"));
      });
    }

    if (inpageToggleSkipSponsor) {
      inpageToggleSkipSponsor.addEventListener("change", async (e) => {
        await extStorage.set({ skipSponsor: e.target.checked });
        activeSegmentVideoId = "";
        loadVideoSegments(new URLSearchParams(window.location.search).get("v"));
      });
    }

    if (inpageTogglePoiHighlights) {
      inpageTogglePoiHighlights.addEventListener("change", async (e) => {
        await extStorage.set({ showPoiHighlights: e.target.checked });
        activeSegmentVideoId = "";
        loadVideoSegments(new URLSearchParams(window.location.search).get("v"));
      });
    }

    if (inpageToggleSponsorBlock) {
      inpageToggleSponsorBlock.addEventListener("change", async (e) => {
        await extStorage.set({ useSponsorBlockApi: e.target.checked });
        activeSegmentVideoId = "";
        loadVideoSegments(new URLSearchParams(window.location.search).get("v"));
      });
    }

    if (inpageToggleCustomDb) {
      inpageToggleCustomDb.addEventListener("change", async (e) => {
        await extStorage.set({ useCustomDb: e.target.checked });
        activeSegmentVideoId = "";
        loadVideoSegments(new URLSearchParams(window.location.search).get("v"));
      });
    }

    // NAS Database Event Listeners
    if (inpageToggleNas) {
      inpageToggleNas.addEventListener("change", async (e) => {
        const isNas = e.target.checked;
        if (isNas && (!nasUrlInput?.value.trim() || !nasTokenInput?.value.trim())) {
          e.target.checked = false;
          if (nasDetails) nasDetails.classList.remove("gacha-hidden");
          await extStorage.set({ useNasServer: false });
          showToast("⚠️ Enter the NAS URL and token, then test the connection");
          return;
        }
        if (nasDetails) nasDetails.classList.toggle("gacha-hidden", !isNas);
        await extStorage.set({ useNasServer: isNas });
        showToast(isNas ? "🏠 Connected to NAS DB Mode" : "🏠 NAS DB Disabled");
        activeSegmentVideoId = "";
        loadVideoSegments(new URLSearchParams(window.location.search).get("v"));
      });
    }

    async function persistNasInputs(reloadSegments) {
      const url = nasUrlInput ? nasUrlInput.value.trim() : "";
      const token = nasTokenInput ? nasTokenInput.value.trim() : "";
      settings.nasServerUrl = url;
      settings.nasAuthToken = token;
      await extStorage.set({ nasServerUrl: url, nasAuthToken: token });
      if (reloadSegments) {
        activeSegmentVideoId = "";
        loadVideoSegments(new URLSearchParams(window.location.search).get("v"));
      }
    }

    if (nasUrlInput) {
      nasUrlInput.addEventListener("input", () => persistNasInputs(false));
      nasUrlInput.addEventListener("change", () => persistNasInputs(true));
      nasUrlInput.addEventListener("blur", () => persistNasInputs(true));
    }

    if (nasTokenInput) {
      nasTokenInput.addEventListener("input", () => persistNasInputs(false));
      nasTokenInput.addEventListener("change", () => persistNasInputs(false));
      nasTokenInput.addEventListener("blur", () => persistNasInputs(false));
    }

    if (btnNasTest) {
      btnNasTest.addEventListener("click", async () => {
        const url = nasUrlInput ? nasUrlInput.value.trim() : settings.nasServerUrl;
        if (nasStatusBadge) {
          nasStatusBadge.textContent = "";
          const span = document.createElement("span");
          span.style.color = "#00f0ff";
          span.textContent = `⏳ Testing connection to ${url}...`;
          nasStatusBadge.appendChild(span);
        }
        const token = nasTokenInput ? nasTokenInput.value.trim() : settings.nasAuthToken;
        const res = await testNasConnection(url, token);
        if (nasStatusBadge) {
          nasStatusBadge.textContent = "";
          const span = document.createElement("span");
          span.style.color = res.success ? "#00ffaa" : "#ff6666";
          span.textContent = (res.success ? "✅ " : "❌ ") + res.message;
          nasStatusBadge.appendChild(span);
        }
      });
    }

    if (inpageToggleNasAutoSync) {
      inpageToggleNasAutoSync.addEventListener("change", async (e) => {
        await extStorage.set({ nasAutoSync: e.target.checked });
      });
    }

    if (btnNasExport) {
      btnNasExport.addEventListener("click", exportFullDbToNas);
    }

    if (btnNasImport) {
      btnNasImport.addEventListener("click", importFullDbFromNas);
    }

    if (inpageToggleAutoplayGuard) {
      inpageToggleAutoplayGuard.addEventListener("change", async (e) => {
        await extStorage.set({ autoplayGuard: e.target.checked });
        showToast(e.target.checked ? "🛡️ Autoplay Guard ON" : "🛡️ Autoplay Guard OFF");
      });
    }

    if (inpageToggleAutoUnmute) {
      inpageToggleAutoUnmute.addEventListener("change", async (e) => {
        await extStorage.set({ autoUnmute: e.target.checked });
        showToast(e.target.checked ? "🔊 Auto Unmute ON" : "🔇 Auto Unmute OFF");
        if (e.target.checked) {
          attemptAutoUnmute("toggle-enabled");
        }
      });
    }

    if (inpageToggleSmoothPlayback) {
      inpageToggleSmoothPlayback.addEventListener("change", async (e) => {
        const isSmooth = e.target.checked;
        await extStorage.set({ smoothPlayback: isSmooth });
        settings.smoothPlayback = isSmooth;
        document.documentElement?.classList.toggle("gacha-smooth-playback", isSmooth);
        document.body?.classList.toggle("gacha-smooth-playback", isSmooth);
        showToast(isSmooth ? "🚀 Smooth Playback ON (H.264 HW Mode)" : "🚀 Smooth Playback OFF");
      });
    }

    if (inpageSelectResolution) {
      inpageSelectResolution.addEventListener("change", async (e) => {
        const newRes = e.target.value;
        await extStorage.set({ preferredResolution: newRes });
        settings.preferredResolution = newRes;
        lastAppliedResChoice = "";
        qualityAttemptedForVideoId = "";
        applyPreferredResolution("drawer-change");
        showToast(`📺 Resolution: ${newRes === "auto" ? "Auto" : newRes}`);
      });
    }

    if (inpageToggleSearchChips) {
      inpageToggleSearchChips.addEventListener("change", async (e) => {
        await extStorage.set({ showSearchChips: e.target.checked });
      });
    }

    // Jukebox Volume Booster Listeners
    const inpageVolumeSlider = widget.querySelector("#inpageVolumeSlider");
    const inpagePresets = widget.querySelectorAll(".inpage-vol-preset");
    const btnInpageVolumeReset = widget.querySelector("#btnInpageVolumeReset");

    if (inpageVolumeSlider) {
      inpageVolumeSlider.addEventListener("input", (e) => {
        setVolumeBoost(parseInt(e.target.value, 10));
      });
    }

    inpagePresets.forEach((chip) => {
      chip.addEventListener("click", () => {
        const b = parseInt(chip.getAttribute("data-boost"), 10);
        if (!isNaN(b)) setVolumeBoost(b);
      });
    });

    if (btnInpageVolumeReset) {
      btnInpageVolumeReset.addEventListener("click", () => setVolumeBoost(100));
    }

    // Custom Skip / POI Helper Buttons
    if (btnCurStart) {
      btnCurStart.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
        if (video && inputStart) {
          inputStart.value = video.currentTime.toFixed(1);
          inputStart.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
    }

    if (btnCurEnd) {
      btnCurEnd.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
        if (video && inputEnd) {
          inputEnd.value = video.currentTime.toFixed(1);
          inputEnd.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
    }

    if (btnAddCustomSkip) {
      btnAddCustomSkip.addEventListener("click", async () => {
        const urlParams = new URLSearchParams(window.location.search);
        const videoId = urlParams.get("v") || "";
        if (!videoId) {
          showToast("⚠️ Open a video first to add segments");
          return;
        }

        const start = parseFloat(inputStart.value);
        const category = selectCat.value;
        const end = category === "poi_highlight" ? start + 1 : parseFloat(inputEnd.value);

        if (isNaN(start) || (category !== "poi_highlight" && (isNaN(end) || start >= end))) {
          showToast("⚠️ Please enter valid start and end seconds");
          return;
        }

        const result = await saveCustomSkipSegment(videoId, start, end, category);
        if (result && result.success) {
          inputStart.value = "";
          inputEnd.value = "";
        }
      });
    }

    function doPanelSearch() {
      const q = searchInput.value.trim();
      if (!q) return;
      let finalQ = q;
      if (!isGachaVideo(q)) {
        finalQ = `${q} GCMV GLMV`;
      }
      executeYoutubeSearch(finalQ);
    }

    searchBtn.addEventListener("click", doPanelSearch);
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doPanelSearch();
    });

    playlistItems.forEach((btn) => {
      btn.addEventListener("click", () => {
        const query = btn.getAttribute("data-query");
        if (query) executeYoutubeSearch(query);
      });
    });

    updateSkipListUI();
    handleFullscreenState();
  }

  function updateInpageSettingsUI() {
    const inpageToggleMaster = document.querySelector("#inpageToggleMaster");
    const inpageToggleBlockAds = document.querySelector("#inpageToggleBlockAds");
    const inpageToggleAutoSkip = document.querySelector("#inpageToggleAutoSkip");
    const inpageToggleSkipNonMusic = document.querySelector("#inpageToggleSkipNonMusic");
    const inpageToggleSkipIntroOutro = document.querySelector("#inpageToggleSkipIntroOutro");
    const inpageToggleSkipSponsor = document.querySelector("#inpageToggleSkipSponsor");
    const inpageTogglePoiHighlights = document.querySelector("#inpageTogglePoiHighlights");
    const inpageToggleSponsorBlock = document.querySelector("#inpageToggleSponsorBlock");
    const inpageToggleCustomDb = document.querySelector("#inpageToggleCustomDb");
    const inpageToggleNas = document.querySelector("#inpageToggleNas");
    const nasDetails = document.querySelector("#gachaNasDetails");
    const nasUrlInput = document.querySelector("#gachaNasUrlInput");
    const nasTokenInput = document.querySelector("#gachaNasTokenInput");
    const inpageToggleNasAutoSync = document.querySelector("#inpageToggleNasAutoSync");
    const inpageToggleAutoplayGuard = document.querySelector("#inpageToggleAutoplayGuard");
    const inpageToggleAutoUnmute = document.querySelector("#inpageToggleAutoUnmute");
    const inpageToggleSmoothPlayback = document.querySelector("#inpageToggleSmoothPlayback");
    const inpageSelectResolution = document.querySelector("#inpageSelectResolution");
    const inpageToggleSearchChips = document.querySelector("#inpageToggleSearchChips");
    const inpageToggleFilterOfficial = document.querySelector("#inpageToggleFilterOfficial");
    const statusText = document.querySelector("#gachaPanelSkipperStatus");

    if (inpageToggleMaster) inpageToggleMaster.checked = settings.enabled;
    if (inpageToggleBlockAds) inpageToggleBlockAds.checked = settings.blockAds !== false;
    if (inpageToggleAutoSkip) inpageToggleAutoSkip.checked = settings.autoSkipNonGacha;
    if (inpageToggleSkipNonMusic) inpageToggleSkipNonMusic.checked = settings.skipNonMusic;
    if (inpageToggleSkipIntroOutro) inpageToggleSkipIntroOutro.checked = settings.skipIntroOutro;
    if (inpageToggleSkipSponsor) inpageToggleSkipSponsor.checked = settings.skipSponsor;
    if (inpageTogglePoiHighlights) inpageTogglePoiHighlights.checked = settings.showPoiHighlights;
    if (inpageToggleSponsorBlock) inpageToggleSponsorBlock.checked = settings.useSponsorBlockApi;
    if (inpageToggleCustomDb) inpageToggleCustomDb.checked = settings.useCustomDb;
    if (inpageToggleNas) inpageToggleNas.checked = settings.useNasServer;
    if (nasDetails) nasDetails.classList.toggle("gacha-hidden", !settings.useNasServer);
    if (nasUrlInput) nasUrlInput.value = settings.nasServerUrl || "";
    if (nasTokenInput) nasTokenInput.value = settings.nasAuthToken || "";
    if (inpageToggleNasAutoSync) inpageToggleNasAutoSync.checked = settings.nasAutoSync;
    if (inpageToggleAutoplayGuard) inpageToggleAutoplayGuard.checked = settings.autoplayGuard;
    if (inpageToggleAutoUnmute) inpageToggleAutoUnmute.checked = settings.autoUnmute !== false;
    if (inpageToggleSmoothPlayback) inpageToggleSmoothPlayback.checked = settings.smoothPlayback !== false;
    if (inpageSelectResolution) inpageSelectResolution.value = settings.preferredResolution || "auto";
    if (inpageToggleSearchChips) inpageToggleSearchChips.checked = settings.showSearchChips;
    if (inpageToggleFilterOfficial) inpageToggleFilterOfficial.checked = settings.filterOfficialVideos;

    const inpageToggleBottomLeftQr = document.querySelector("#inpageToggleBottomLeftQr") || document.querySelector("#inpageToggleBottomRightQr");
    const inpageToggleQrFullscreen = document.querySelector("#inpageToggleQrFullscreen");
    const inpageRowQrFullscreen = document.querySelector("#inpageRowQrFullscreen");
    const isQrActive = Boolean(settings.showBottomLeftQr || settings.showBottomRightQr);
    if (inpageToggleBottomLeftQr) inpageToggleBottomLeftQr.checked = isQrActive;
    if (inpageToggleQrFullscreen) inpageToggleQrFullscreen.checked = settings.showQrInFullscreen !== false;
    if (inpageRowQrFullscreen) inpageRowQrFullscreen.style.display = isQrActive ? "" : "none";

    if (statusText) {
      statusText.textContent = settings.enabled && settings.autoSkipNonGacha ? "ACTIVE" : "PAUSED";
      statusText.style.color = settings.enabled && settings.autoSkipNonGacha ? "#00ffaa" : "#8389a0";
    }

    updateSkipListUI();
  }

  function updateSkipListUI() {
    const bannerEl = document.getElementById("gachaPoiBanner");
    const listEl = document.getElementById("gachaSegmentsList");
    const countBadge = document.getElementById("gachaSkipCountBadge");
    if (!listEl) return;

    const urlParams = new URLSearchParams(window.location.search);
    const videoId = urlParams.get("v") || "";

    if (!videoId) {
      listEl.textContent = "";
      const emptyNote = document.createElement("span");
      emptyNote.className = "gacha-empty-note";
      emptyNote.textContent = "Open a YouTube video to view skip segments and POI highlights.";
      listEl.appendChild(emptyNote);
      if (bannerEl) bannerEl.classList.add("gacha-hidden");
      if (countBadge) countBadge.textContent = "0 segments";
      return;
    }

    // 1. POI Highlight Banner
    if (bannerEl) {
      if (activePoiHighlight && settings.showPoiHighlights) {
        bannerEl.classList.remove("gacha-hidden");
        bannerEl.textContent = "";

        const poiInfo = document.createElement("div");
        poiInfo.className = "gacha-poi-info";

        const starSpan = document.createElement("span");
        starSpan.className = "gacha-poi-star";
        starSpan.textContent = "🌟";
        poiInfo.appendChild(starSpan);

        const textDiv = document.createElement("div");
        const strong = document.createElement("strong");
        strong.textContent = "Highlight Drop / Best Part";
        const small = document.createElement("small");
        small.textContent = `Starts at ${formatTime(activePoiHighlight.start)}`;
        textDiv.appendChild(strong);
        textDiv.appendChild(small);
        poiInfo.appendChild(textDiv);
        bannerEl.appendChild(poiInfo);

        const jumpBtn = document.createElement("button");
        jumpBtn.className = "gacha-poi-jump-btn";
        jumpBtn.id = "gachaBtnJumpPoi";
        jumpBtn.textContent = "▶️ Jump to Drop";
        jumpBtn.addEventListener("click", () => seekVideo(activePoiHighlight.start));
        bannerEl.appendChild(jumpBtn);
      } else {
        bannerEl.classList.add("gacha-hidden");
      }
    }

    // 2. Segments List
    if (countBadge) {
      countBadge.textContent = `${allLoadedSegments.length} segment${allLoadedSegments.length === 1 ? "" : "s"}`;
    }

    if (allLoadedSegments.length === 0) {
      listEl.textContent = "";
      const emptyNote = document.createElement("span");
      emptyNote.className = "gacha-empty-note";
      emptyNote.textContent = "No skip segments found for this video. You can add one below!";
      listEl.appendChild(emptyNote);
      return;
    }

    listEl.textContent = "";
    allLoadedSegments.forEach((seg) => {
      const item = document.createElement("div");
      item.className = `gacha-seg-card${seg.ignored ? " is-ignored" : ""}${seg.category === "poi_highlight" ? " is-poi" : ""}`;

      const cardTop = document.createElement("div");
      cardTop.className = "gacha-seg-card-top";

      const cardTitle = document.createElement("div");
      cardTitle.className = "gacha-seg-card-title";

      const catBadge = document.createElement("span");
      catBadge.className = `gacha-seg-cat-badge gacha-seg-${seg.category}`;
      catBadge.textContent = seg.label;
      cardTitle.appendChild(catBadge);

      const sourceTag = document.createElement("span");
      sourceTag.className = "gacha-seg-source-tag";
      sourceTag.textContent = seg.source === "sponsorblock" ? "🌐 SponsorBlock" : "💾 Custom DB";
      cardTitle.appendChild(sourceTag);
      cardTop.appendChild(cardTitle);

      const timingDiv = document.createElement("div");
      timingDiv.className = "gacha-seg-timing";

      const timingStrong = document.createElement("strong");
      timingStrong.textContent = `${formatTime(seg.start)} ➔ ${formatTime(seg.end)}`;
      timingDiv.appendChild(timingStrong);

      const statusTag = document.createElement("span");
      if (seg.ignored) {
        statusTag.className = "gacha-tag-status tag-ignored";
        statusTag.textContent = "🚫 Ignored (Incorrect)";
      } else if (seg.retimed) {
        statusTag.className = "gacha-tag-status tag-retimed";
        statusTag.textContent = `⏱️ Retimed (${formatTime(seg.originalStart)}➔${formatTime(seg.originalEnd)})`;
      } else {
        statusTag.className = "gacha-tag-status tag-active";
        statusTag.textContent = "Active";
      }
      timingDiv.appendChild(statusTag);
      cardTop.appendChild(timingDiv);
      item.appendChild(cardTop);

      // Actions row
      const actionsDiv = document.createElement("div");
      actionsDiv.className = "gacha-seg-card-actions";

      const jumpBtn = document.createElement("button");
      jumpBtn.className = "gacha-seg-btn btn-jump";
      jumpBtn.title = "Jump to start of segment";
      jumpBtn.textContent = "▶️ Jump";
      jumpBtn.addEventListener("click", () => seekVideo(seg.start));
      actionsDiv.appendChild(jumpBtn);

      const retimeBtn = document.createElement("button");
      retimeBtn.className = "gacha-seg-btn btn-retime";
      retimeBtn.title = "Retime start/end seconds";
      retimeBtn.textContent = "⏱️ Retime";
      actionsDiv.appendChild(retimeBtn);

      const ignoreBtn = document.createElement("button");
      ignoreBtn.className = "gacha-seg-btn btn-ignore";
      ignoreBtn.title = "Mark as incorrect or restore";
      ignoreBtn.textContent = seg.ignored ? "✅ Restore" : "🚫 Incorrect";
      ignoreBtn.addEventListener("click", () => toggleIgnoreSegment(videoId, seg.id));
      actionsDiv.appendChild(ignoreBtn);

      if (seg.source === "custom") {
        const delBtn = document.createElement("button");
        delBtn.className = "gacha-seg-btn btn-del";
        delBtn.title = "Delete custom segment";
        delBtn.textContent = "🗑️";
        delBtn.addEventListener("click", () => deleteCustomSkipSegment(videoId, seg.id));
        actionsDiv.appendChild(delBtn);
      }
      item.appendChild(actionsDiv);

      // Inline Retime Editor
      const retimeBox = document.createElement("div");
      retimeBox.className = "gacha-seg-retime-box gacha-hidden";

      const retimeInputs = document.createElement("div");
      retimeInputs.className = "gacha-retime-inputs";

      // Start input wrap
      const startWrap = document.createElement("div");
      const startLabel = document.createElement("label");
      startLabel.textContent = "New Start (s):";
      startWrap.appendChild(startLabel);
      const startInputWrap = document.createElement("div");
      startInputWrap.className = "gacha-time-input-wrap";
      const retimeStartInput = document.createElement("input");
      retimeStartInput.type = "number";
      retimeStartInput.step = "0.5";
      retimeStartInput.className = "gacha-retime-start";
      retimeStartInput.value = seg.start;
      const btnReStartNow = document.createElement("button");
      btnReStartNow.type = "button";
      btnReStartNow.className = "gacha-time-cur-btn btn-retime-cur-start";
      btnReStartNow.textContent = "📍 Now";
      btnReStartNow.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
        if (video) {
          retimeStartInput.value = video.currentTime.toFixed(1);
          retimeStartInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      startInputWrap.appendChild(retimeStartInput);
      startInputWrap.appendChild(btnReStartNow);
      startWrap.appendChild(startInputWrap);
      retimeInputs.appendChild(startWrap);

      // End input wrap
      const endWrap = document.createElement("div");
      const endLabel = document.createElement("label");
      endLabel.textContent = "New End (s):";
      endWrap.appendChild(endLabel);
      const endInputWrap = document.createElement("div");
      endInputWrap.className = "gacha-time-input-wrap";
      const retimeEndInput = document.createElement("input");
      retimeEndInput.type = "number";
      retimeEndInput.step = "0.5";
      retimeEndInput.className = "gacha-retime-end";
      retimeEndInput.value = seg.end;
      const btnReEndNow = document.createElement("button");
      btnReEndNow.type = "button";
      btnReEndNow.className = "gacha-time-cur-btn btn-retime-cur-end";
      btnReEndNow.textContent = "📍 Now";
      btnReEndNow.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
        if (video) {
          retimeEndInput.value = video.currentTime.toFixed(1);
          retimeEndInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      endInputWrap.appendChild(retimeEndInput);
      endInputWrap.appendChild(btnReEndNow);
      endWrap.appendChild(endInputWrap);
      retimeInputs.appendChild(endWrap);

      retimeBox.appendChild(retimeInputs);

      // Retime Buttons
      const retimeBtns = document.createElement("div");
      retimeBtns.className = "gacha-retime-btns";

      const btnSaveRetime = document.createElement("button");
      btnSaveRetime.className = "gacha-btn-save-retime";
      btnSaveRetime.textContent = "💾 Save Retime";
      btnSaveRetime.addEventListener("click", () => {
        const nStart = parseFloat(retimeStartInput.value);
        const nEnd = parseFloat(retimeEndInput.value);
        if (isNaN(nStart) || isNaN(nEnd) || nStart >= nEnd) {
          showToast("⚠️ Invalid start and end times");
          return;
        }
        saveRetimedSegment(videoId, seg.id, nStart, nEnd);
      });
      retimeBtns.appendChild(btnSaveRetime);

      if (seg.retimed) {
        const btnResetRetime = document.createElement("button");
        btnResetRetime.className = "gacha-btn-reset-retime";
        btnResetRetime.textContent = "↩️ Reset to Original";
        btnResetRetime.addEventListener("click", () => resetRetimedSegment(videoId, seg.id));
        retimeBtns.appendChild(btnResetRetime);
      }
      retimeBox.appendChild(retimeBtns);

      retimeBtn.addEventListener("click", () => {
        retimeBox.classList.toggle("gacha-hidden");
      });

      item.appendChild(retimeBox);
      listEl.appendChild(item);
    });
  }

  function removeFloatingJukebox() {
    const el = document.getElementById("gacha-floating-widget");
    if (el) el.remove();
    const bd = document.getElementById("gacha-drawer-backdrop");
    if (bd) bd.remove();
  }

  // ==========================================================
  // Bottom-Left Remote QR Code Overlay Badge
  // ==========================================================
  let currentRemoteQrUrl = "";
  let bottomLeftQrDismissed = false;

  function getActiveRemoteUrl() {
    if (currentRemoteQrUrl) return currentRemoteQrUrl;
    if (cloudRoomCode) {
      return `https://itsmemusicchilly.github.io/GCMV-only-videos-extension/remote/?room=${cloudRoomCode}`;
    }
    if (window.AndroidBridge && typeof window.AndroidBridge.getRemoteServerUrl === "function") {
      const u = window.AndroidBridge.getRemoteServerUrl();
      if (u && u !== "Server Stopped") return u;
    }
    if (settings.remoteServerUrl) {
      return settings.remoteServerUrl;
    }
    return "http://127.0.0.1:3000/remote";
  }

  function renderBottomLeftQrCode(overrideUrl) {
    const qrWidget = document.getElementById("gacha-bottom-left-qr") || document.getElementById("gacha-bottom-right-qr");
    if (!qrWidget) return;
    const qrBox = qrWidget.querySelector("#gacha-bl-qr-svg-box") || qrWidget.querySelector("#gacha-br-qr-svg-box");
    const roomText = qrWidget.querySelector("#gacha-bl-qr-room-text") || qrWidget.querySelector("#gacha-br-qr-room-text");
    if (!qrBox) return;

    const url = overrideUrl || getActiveRemoteUrl();
    if (overrideUrl) currentRemoteQrUrl = overrideUrl;

    if (roomText) {
      if (cloudRoomCode) {
        roomText.textContent = `Room: ${cloudRoomCode}`;
        roomText.style.display = "";
      } else {
        try {
          const parsed = new URL(url);
          roomText.textContent = `${parsed.hostname}:${parsed.port || "80"}`;
        } catch (_) {
          roomText.textContent = "Remote Control";
        }
      }
    }

    try {
      const painted = paintQrCode(qrBox, url);
      if (!painted) console.warn("[GCMV] Bottom-left QR render error: generator unavailable");
    } catch (e) {
      console.warn("[GCMV] Bottom-left QR render error:", e);
    }
  }

  function injectBottomLeftQrWidget() {
    let qrWidget = document.getElementById("gacha-bottom-left-qr") || document.getElementById("gacha-bottom-right-qr");
    if (qrWidget) return qrWidget;

    qrWidget = document.createElement("div");
    qrWidget.id = "gacha-bottom-left-qr";
    qrWidget.className = "gacha-bl-qr-compact";
    qrWidget.title = "Click to expand / collapse";

    appendTrustedHtml(qrWidget, `
      <button type="button" class="gacha-bl-qr-close" title="Dismiss QR overlay" aria-label="Close">✕</button>
      <div class="gacha-bl-qr-box" id="gacha-bl-qr-svg-box"></div>
      <div class="gacha-bl-qr-info">
        <span class="gacha-bl-qr-label">📱 Remote</span>
        <span class="gacha-bl-qr-room" id="gacha-bl-qr-room-text">Room: ...</span>
      </div>
      <div class="gacha-bl-qr-actions">
        <button type="button" class="gacha-bl-qr-btn gacha-bl-qr-btn-copy" id="gacha-bl-qr-copy-btn">📋 Copy URL</button>
        <button type="button" class="gacha-bl-qr-btn gacha-bl-qr-btn-jukebox" id="gacha-bl-qr-jukebox-btn">🎵 Open Jukebox</button>
      </div>
    `);

    // Toggle compact / expanded on click
    qrWidget.addEventListener("click", (e) => {
      if (e.target.closest(".gacha-bl-qr-close, .gacha-br-qr-close") || e.target.closest(".gacha-bl-qr-btn, .gacha-br-qr-btn")) {
        return;
      }
      qrWidget.classList.toggle("gacha-bl-qr-compact");
      qrWidget.classList.toggle("gacha-bl-qr-expanded");
    });

    // Close button
    const closeBtn = qrWidget.querySelector(".gacha-bl-qr-close") || qrWidget.querySelector(".gacha-br-qr-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        bottomLeftQrDismissed = true;
        qrWidget.classList.add("gacha-hidden");
        document.documentElement.classList.remove("gacha-qr-overlay-active");
      });
    }

    // Copy button
    const copyBtn = qrWidget.querySelector("#gacha-bl-qr-copy-btn") || qrWidget.querySelector("#gacha-br-qr-copy-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const url = getActiveRemoteUrl();
        try {
          await navigator.clipboard.writeText(url);
          copyBtn.textContent = "✅ Copied!";
          setTimeout(() => {
            if (copyBtn) copyBtn.textContent = "📋 Copy URL";
          }, 1500);
        } catch (err) {
          console.warn("[GCMV] Clipboard copy failed:", err);
        }
      });
    }

    // Open Jukebox button
    const jukeboxBtn = qrWidget.querySelector("#gacha-bl-qr-jukebox-btn") || qrWidget.querySelector("#gacha-br-qr-jukebox-btn");
    if (jukeboxBtn) {
      jukeboxBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (typeof window.__gachaOpenJukebox === "function") {
          window.__gachaOpenJukebox();
        }
      });
    }

    (document.body || document.documentElement).appendChild(qrWidget);
    return qrWidget;
  }

  function updateBottomLeftQrVisibility() {
    const isEnabled = Boolean(settings.showBottomLeftQr || settings.showBottomRightQr);
    const shouldShow = Boolean(isEnabled && !bottomLeftQrDismissed);
    const fullscreenEnabled = settings.showQrInFullscreen !== false;

    document.documentElement.classList.toggle("gacha-qr-fullscreen-enabled", fullscreenEnabled);
    if (document.body) {
      document.body.classList.toggle("gacha-qr-fullscreen-enabled", fullscreenEnabled);
    }

    let qrWidget = document.getElementById("gacha-bottom-left-qr") || document.getElementById("gacha-bottom-right-qr");

    if (!shouldShow) {
      if (qrWidget) {
        qrWidget.classList.add("gacha-hidden");
      }
      document.documentElement.classList.remove("gacha-qr-overlay-active");
      return;
    }

    if (!qrWidget) {
      qrWidget = injectBottomLeftQrWidget();
    } else {
      qrWidget.classList.remove("gacha-hidden");
    }

    document.documentElement.classList.add("gacha-qr-overlay-active");
    renderBottomLeftQrCode();
  }

  const renderBottomRightQrCode = renderBottomLeftQrCode;
  const updateBottomRightQrVisibility = updateBottomLeftQrVisibility;

  // ==========================================================
  // Autoplay Guard (Strictly selects Gacha / Gacha Lyric MVs)
  // ==========================================================
  const CURATED_GACHA_FALLBACK_POOL = [
    { id: "1eV8vgTFv5k", title: "Dynasty - GCMV" },
    { id: "L4_X300rLGE", title: "Monster - GCMV" },
    { id: "3Q3zL1cQ8jA", title: "Legends Never Die - GLMV" },
    { id: "WcO_S5rZ7Gg", title: "Play Date - GLMV" },
    { id: "kJQP7kiw5Fk", title: "Despacito - GLMV" },
    { id: "RgKAFK5djSk", title: "See You Again - GLMV" },
    { id: "OPf0YbXqDm0", title: "Uptown Funk - GCMV" },
    { id: "2Vv-BfVoq4g", title: "Perfect - GLMV" },
    { id: "fJ9rUzIMcZQ", title: "Queen - GCMV" },
    { id: "fKopy74weus", title: "Thunder - GLMV" },
    { id: "7PCkvCPvDXk", title: "Believer - GLMV" },
    { id: "hT_nvWreIhg", title: "Counting Stars - GCMV" },
    { id: "JGwWNGJdvx8", title: "Shape of You - GLMV" },
    { id: "CevxZvSJLk8", title: "Roar - GLMV" },
    { id: "YQHsXMglC9A", title: "Hello - GLMV" },
    { id: "kXYiU_JCYtU", title: "Numb - GCMV" },
    { id: "09R8_2nJtjg", title: "Sugar - GCMV" },
    { id: "60ItHLz5WEA", title: "Faded - GLMV" },
    { id: "YykjpeuMNEk", title: "Hymn for the Weekend - GCMV" },
    { id: "aJOTlE1K90k", title: "Darkside - GLMV" }
  ];

  async function getRecentPlayedVideoIds() {
    try {
      const data = await extStorage.get({ recentPlayedVideoIds: [] });
      return Array.isArray(data.recentPlayedVideoIds) ? data.recentPlayedVideoIds : [];
    } catch (e) {
      return [];
    }
  }

  async function recordRecentPlayedVideoId(videoId) {
    if (!videoId) return;
    try {
      let list = await getRecentPlayedVideoIds();
      list = list.filter((id) => id !== videoId);
      list.unshift(videoId);
      if (list.length > 15) {
        list = list.slice(0, 15);
      }
      await extStorage.set({ recentPlayedVideoIds: list });
    } catch (e) {}
  }

  let lastAutoplayToggleAttemptAt = 0;
  function ensureYoutubeAutoplayToggleOn() {
    if (!settings.enabled || !settings.autoplayGuard) return;
    const now = Date.now();
    if (now - lastAutoplayToggleAttemptAt < 1500) return;

    try {
      // 1. Desktop YouTube HTML5 player
      const desktopToggle = document.querySelector(".ytp-autonav-toggle-button");
      const desktopBtn = document.querySelector("button[data-tooltip-target-id='ytp-autonav-toggle-button'], button.ytp-autonav-toggle-button");
      const targetBtn = desktopBtn || desktopToggle?.closest("button");

      if (desktopToggle) {
        const toggleAriaChecked = desktopToggle.getAttribute("aria-checked");
        const btnAriaChecked = targetBtn?.getAttribute("aria-checked");
        const btnAriaLabel = (targetBtn?.getAttribute("aria-label") || "").toLowerCase();
        const btnTitle = (targetBtn?.getAttribute("data-title-no-tooltip") || targetBtn?.getAttribute("title") || "").toLowerCase();

        // Autoplay is DEFINITELY ON if:
        const isDefinitelyOn =
          toggleAriaChecked === "true" ||
          btnAriaChecked === "true" ||
          btnAriaLabel.includes("autoplay is on") ||
          btnAriaLabel.includes("turn off autoplay") ||
          btnTitle.includes("autoplay is on") ||
          btnTitle.includes("turn off autoplay");

        // Autoplay is DEFINITELY OFF if:
        const isDefinitelyOff =
          toggleAriaChecked === "false" ||
          btnAriaChecked === "false" ||
          btnAriaLabel.includes("autoplay is off") ||
          btnAriaLabel.includes("turn on autoplay") ||
          btnTitle.includes("autoplay is off") ||
          btnTitle.includes("turn on autoplay");

        if (isDefinitelyOff && !isDefinitelyOn) {
          lastAutoplayToggleAttemptAt = now;
          (targetBtn || desktopToggle).click();
        }
      }

      // 2. Mobile YouTube web (m.youtube.com)
      const mobileToggle = document.querySelector(
        "#autonav-toggle-button, ytm-autonav-toggle-button button, button.autonav-toggle-button, button[aria-label*='Autoplay'], button[aria-label*='autoplay']"
      );
      if (mobileToggle) {
        const mChecked = mobileToggle.getAttribute("aria-checked");
        const mPressed = mobileToggle.getAttribute("aria-pressed");
        const mLabel = (mobileToggle.getAttribute("aria-label") || "").toLowerCase();

        const isMobileOn =
          mChecked === "true" ||
          mPressed === "true" ||
          mLabel.includes("turn off autoplay") ||
          mLabel.includes("autoplay is on");

        const isMobileOff =
          mChecked === "false" ||
          mPressed === "false" ||
          mLabel.includes("turn on autoplay") ||
          mLabel.includes("autoplay is off");

        if (isMobileOff && !isMobileOn) {
          lastAutoplayToggleAttemptAt = now;
          mobileToggle.click();
        }
      }
    } catch (e) {
      console.warn("[GCMV] ensureYoutubeAutoplayToggleOn error:", e);
    }
  }

  function setupAutoplayGuard() {
    const video =
      document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (!video) return;

    video.removeEventListener("ended", handleVideoEnded);
    if (settings.autoplayGuard) {
      video.addEventListener("ended", handleVideoEnded);
      ensureYoutubeAutoplayToggleOn();
    }
  }

  async function checkAndEnforceGachaNext(triggerSource = "autoplay_guard") {
    const isExplicitSkip = triggerSource === "remote_skip" || triggerSource === "user_skip" || triggerSource === true;
    if (isExplicitSkip) {
      return executeSkipNextTrack(triggerSource);
    }
    if (!settings.enabled || (!settings.autoplayGuard && triggerSource !== "queue_immediate")) return;

    if (currentLoopMode !== "off") {
      const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
      handleLoopReplay(video);
      return;
    }

    ensureYoutubeAutoplayToggleOn();

    // 0. Check for queued video from Cloud Remote P2P Queue
    if (cloudRemoteQueue && cloudRemoteQueue.length > 0) {
      captureCurrentMixState();
      const item = cloudRemoteQueue.shift();
      extStorage.set({ cloudRemoteQueue }).catch(() => {});
      broadcastCloudState();
      if (typeof refreshInpageQueue === "function") refreshInpageQueue();
      showToast("📱 Remote Queue: Playing next ➔ " + (item.title || item.videoId) + " 🌸");
      navigateToVideo(item.videoId, item.title, true);
      return;
    }

    // 1. Check for queued video from Android APK Bridge
    if (window.AndroidBridge && typeof window.AndroidBridge.popNextQueuedVideo === "function") {
      try {
        const queuedJson = window.AndroidBridge.popNextQueuedVideo();
        if (queuedJson) {
          const item = JSON.parse(queuedJson);
          if (item && item.videoId) {
            captureCurrentMixState();
            showToast("📱 Remote Queue: Playing next ➔ " + (item.title || item.videoId) + " 🌸");
            navigateToVideo(item.videoId, item.title, true);
            return;
          }
        }
      } catch (e) {
        console.warn("[GCMV] Error popping queued video from bridge:", e);
      }
    }

    // 2. Check for queued video from Desktop Remote Server
    if (!window.AndroidBridge && (settings.remoteServerEnabled !== false || settings.useNasServer)) {
      const serverUrl = (settings.remoteServerUrl || settings.nasServerUrl || "http://127.0.0.1:3000").trim().replace(/\/+$/, "");
      try {
        const res = await fetch(serverUrl + "/api/queue?pop=true", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (data && data.item && data.item.videoId) {
            captureCurrentMixState();
            showToast("📱 Remote Queue: Playing next ➔ " + (data.item.title || data.item.videoId) + " 🌸");
            navigateToVideo(data.item.videoId, data.item.title, true);
            return;
          }
        }
      } catch (e) {}
    }

    // 3. If no queued videos remain, check if we have a saved Mix to return to!
    if (savedMixContext && savedMixContext.listId) {
      resumeSavedMix();
      return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const currentVideoId = urlParams.get("v") || getCurrentVideoId() || "";
    const isMix =
      window.location.search.includes("list=") ||
      Boolean(document.querySelector("ytd-playlist-panel-renderer, ytm-playlist-video-renderer"));

    // If in a mix/playlist, check if the next video is non-Gacha and needs skipping
    if (isMix) {
      if (isExplicitSkip) {
        // User explicitly tapped Skip: advance to the next item in playlist regardless
        const playlistItems = document.querySelectorAll(
          "ytd-playlist-panel-renderer #items ytd-playlist-panel-video-renderer, ytm-playlist-video-renderer, ytm-compact-playlist-video-renderer"
        );
        if (playlistItems && playlistItems.length > 0) {
          const currentVId = currentVideoId || getCurrentVideoId();
          let currentIndex = -1;
          for (let i = 0; i < playlistItems.length; i++) {
            const item = playlistItems[i];
            const link = item.querySelector("a#wc-endpoint, a#thumbnail, a.media-item-thumbnail-container, a");
            let itemVid = "";
            if (link && link.href) {
              try {
                const u = new URL(link.href, window.location.origin);
                itemVid = u.searchParams.get("v") || "";
              } catch (e) {}
            }
            if ((currentVId && itemVid === currentVId) || item.classList.contains("selected") || item.classList.contains("active")) {
              currentIndex = i;
              break;
            }
          }
          const nextIndex = currentIndex !== -1 ? currentIndex + 1 : 1;
          if (nextIndex < playlistItems.length) {
            const nextItem = playlistItems[nextIndex];
            const nextEl = nextItem.querySelector("a#wc-endpoint, a#thumbnail, a.media-item-thumbnail-container, a") || nextItem;
            let nextVid = "";
            if (nextEl && nextEl.href) {
              try {
                const u = new URL(nextEl.href, window.location.origin);
                nextVid = u.searchParams.get("v") || "";
              } catch (e) {}
            }
            showToast("⏭️ Skipping to next playlist track... 🌸");
            if (isPlayerMediaFullscreen() && nextVid) {
              navigateToVideo(nextVid);
            } else {
              saveFullscreenStateBeforeNavigate();
              if (typeof nextEl.click === "function") nextEl.click();
              else if (nextEl.href) window.location.href = nextEl.href;
            }
            return;
          }
        }
      }

      const skipTargetInMix = findNextNonGachaSkipTargetInMix(currentVideoId);
      if (skipTargetInMix && (skipTargetInMix.element || skipTargetInMix.videoId)) {
        showToast("🛡️ Mix Guard: Skipping non-Gacha track ➔ " + skipTargetInMix.title.substring(0, 25) + "... 🌸");
        if (isPlayerMediaFullscreen() && skipTargetInMix.videoId) {
          navigateToVideo(skipTargetInMix.videoId, skipTargetInMix.title);
        } else {
          saveFullscreenStateBeforeNavigate();
          if (skipTargetInMix.element && typeof skipTargetInMix.element.click === "function") {
            skipTargetInMix.element.click();
          } else if (skipTargetInMix.videoId) {
            navigateToVideo(skipTargetInMix.videoId, skipTargetInMix.title);
          }
        }
        return;
      }
      // If the next track is already Gacha (or playlist end), ensure autoplay toggle is active
      ensureYoutubeAutoplayToggleOn();
      if (!isExplicitSkip) return;
    }

    let retryCount = 0;
    async function evaluateRecommendations() {
      const recommendations = document.querySelectorAll(
        "ytd-compact-video-renderer, ytd-video-renderer, ytd-rich-item-renderer, ytm-compact-video-renderer, ytm-video-with-context-renderer, ytm-rich-item-renderer, ytm-watch-next-video-renderer, ytm-media-item, .compact-media-item, .media-item"
      );

      if (!recommendations || recommendations.length === 0) {
        if (!isExplicitSkip && retryCount < 4) {
          retryCount++;
          setTimeout(evaluateRecommendations, 350);
          return;
        }
        await playCuratedFallback();
        return;
      }

      // Check upcoming / first recommendation
      const firstCard = recommendations[0];
      const firstTitleEl = firstCard?.querySelector("#video-title, #title, .media-item-headline, .compact-media-item-headline, .video-title, h3, h4");
      const firstChannelEl = firstCard?.querySelector("#channel-name, #byline, .media-item-byline, .compact-media-item-byline, ytm-channel-name");
      const firstLink = firstCard?.querySelector("a#thumbnail, a.yt-simple-endpoint, a.media-item-thumbnail-container, a.compact-media-item-image, a[href*='watch']");
      let firstVideoId = "";
      if (firstLink && firstLink.href) {
        try {
          const u = new URL(firstLink.href, window.location.origin);
          firstVideoId = u.searchParams.get("v") || "";
        } catch (e) {}
      }

      const firstTitle = firstTitleEl?.textContent?.trim() || "";
      const firstChannel = firstChannelEl?.textContent?.trim() || "";

      if (isGachaVideo(firstTitle, firstChannel, "", firstVideoId)) {
        if (isExplicitSkip) {
          showToast("🌸 Skipping ➔ " + firstTitle.substring(0, 30) + "... ✨");
          if (firstVideoId) recordRecentPlayedVideoId(firstVideoId);
          saveFullscreenStateBeforeNavigate();
          navigateToVideo(firstVideoId, firstTitle);
          return;
        }

        showToast("✨ Next up: " + firstTitle.substring(0, 35) + "...");
        if (firstVideoId) recordRecentPlayedVideoId(firstVideoId);
        // Allow YouTube's native autonav countdown (4-6s) to advance naturally without synthetic DOM clicks.
        // Fallback: If YouTube doesn't navigate within 5.5s, trigger clean navigation with autoplay recovery!
        setTimeout(() => {
          const vid = document.querySelector("video.html5-main-video") || document.querySelector("video");
          const nowVid = getCurrentVideoId();
          if (nowVid === currentVideoId && (vid?.ended || vid?.paused)) {
            navigateToVideo(firstVideoId, firstTitle);
          }
        }, 5500);
        return;
      }

      let foundGacha = false;
      // Find the first recommendation that is a GCMV / GLMV / Gacha Lyric Video
      for (let i = 0; i < recommendations.length; i++) {
        const rec = recommendations[i];
        const titleEl = rec.querySelector("#video-title, #title, .media-item-headline, .compact-media-item-headline, .video-title, h3, h4");
        const channelEl = rec.querySelector("#channel-name, #byline, .media-item-byline, .compact-media-item-byline, ytm-channel-name");
        const title = titleEl?.textContent?.trim() || "";
        const channel = channelEl?.textContent?.trim() || "";
        const link = rec.querySelector("a#thumbnail, a.yt-simple-endpoint, a.media-item-thumbnail-container, a.compact-media-item-image, a[href*='watch']");

        let recVideoId = "";
        if (link && link.href) {
          try {
            const u = new URL(link.href, window.location.origin);
            recVideoId = u.searchParams.get("v") || "";
          } catch (e) {}
        }

        if (recVideoId && recVideoId !== currentVideoId && isGachaVideo(title, channel, "", recVideoId)) {
          foundGacha = true;
          showToast("🌸 Skipping ➔ " + title.substring(0, 30) + "... ✨");
          if (recVideoId) recordRecentPlayedVideoId(recVideoId);
          saveFullscreenStateBeforeNavigate();
          navigateToVideo(recVideoId, title);
          break;
        }
      }

      // If no Gacha video found in recommendations, play curated fallback
      if (!foundGacha) {
        await playCuratedFallback();
      }
    }

    async function playCuratedFallback() {
      try {
        const recents = await getRecentPlayedVideoIds();
        let pool = CURATED_GACHA_FALLBACK_POOL.filter(
          (item) => !recents.includes(item.id) && item.id !== currentVideoId
        );
        if (pool.length === 0) {
          pool = CURATED_GACHA_FALLBACK_POOL.filter((item) => item.id !== currentVideoId);
        }
        if (pool.length === 0) {
          pool = CURATED_GACHA_FALLBACK_POOL;
        }
        const picked = pool[Math.floor(Math.random() * pool.length)];
        showToast("🌸 Gacha Autoplay: Up next ➔ " + picked.title);
        navigateToVideo(picked.id, picked.title);
      } catch (err) {
        console.warn("[GCMV] Error in playCuratedFallback:", err);
      }
    }

    evaluateRecommendations();
  }

  window.__gachaForceSkip = () => executeSkipNextTrack("user_skip");
  window.__gachaSkipVideo = () => executeSkipNextTrack("user_skip");
  window.__gachaPlayNext = () => executeSkipNextTrack("user_skip");

  function showToast(msg, videoId = "", channelName = "") {
    const existing = document.querySelector(".gacha-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "gacha-toast";

    const bodyDiv = document.createElement("div");
    bodyDiv.className = "gacha-toast-body";

    const iconSpan = document.createElement("span");
    iconSpan.textContent = "🌸";
    bodyDiv.appendChild(iconSpan);

    const msgSpan = document.createElement("span");
    msgSpan.textContent = msg;
    bodyDiv.appendChild(msgSpan);

    toast.appendChild(bodyDiv);

    if (videoId || channelName) {
      const wBtn = document.createElement("button");
      wBtn.className = "gacha-toast-whitelist-btn";
      wBtn.textContent = "🌸 It's Gacha!";
      wBtn.title = "Mark this video / channel as Gacha so it is never skipped again";
      wBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        whitelistGacha(videoId, channelName);
        toast.remove();
      });
      toast.appendChild(wBtn);
    }

    const target = document.body || document.documentElement;
    if (target) target.appendChild(toast);
    handleFullscreenState();

    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 4500);
  }

  // ==========================================================
  // Storage & Navigation Listeners
  // ==========================================================
  const storageChangeApi = (typeof browser !== "undefined" && browser.storage && browser.storage.onChanged)
    ? browser.storage.onChanged
    : (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged ? chrome.storage.onChanged : null);

  if (storageChangeApi) {
    storageChangeApi.addListener((changes, areaName) => {
      if (areaName === "local") {
        let changed = false;
        for (const key of [
          "enabled",
          "blockAds",
          "showJukebox",
          "showSearchChips",
          "autoplayGuard",
          "autoSkipNonGacha",
          "filterOfficialVideos",
          "skipNonMusic",
          "skipIntroOutro",
          "skipSponsor",
          "showPoiHighlights",
          "useSponsorBlockApi",
          "useCustomDb",
          "useNasServer",
          "nasServerUrl",
          "nasAuthToken",
          "nasAutoSync",
          "volumeBoost",
          "autoUnmute",
          "smoothPlayback",
          "preferredResolution",
          "showBottomLeftQr",
          "showBottomRightQr",
          "showQrInFullscreen"
        ]) {
          if (changes[key] !== undefined) {
            settings[key] = changes[key].newValue;
            changed = true;
          }
        }
        if (changes.showBottomLeftQr !== undefined || changes.showBottomRightQr !== undefined) {
          bottomLeftQrDismissed = false;
        }
        if (changes.smoothPlayback !== undefined) {
          settings.smoothPlayback = changes.smoothPlayback.newValue !== false;
          const isSmooth = settings.smoothPlayback;
          document.documentElement?.classList.toggle("gacha-smooth-playback", isSmooth);
          document.body?.classList.toggle("gacha-smooth-playback", isSmooth);
          const inpageToggleSmoothPlayback = document.querySelector("#inpageToggleSmoothPlayback");
          if (inpageToggleSmoothPlayback) inpageToggleSmoothPlayback.checked = isSmooth;
        }
        if (changes.autoUnmute !== undefined && changes.autoUnmute.newValue) {
          attemptAutoUnmute("storage-enabled");
        }
        if (changes.volumeBoost !== undefined) {
          settings.volumeBoost = changes.volumeBoost.newValue;
          applyVolumeBoostGain();
          updateInpageVolumeBoostUI();
        }
        if (changes.preferredResolution !== undefined) {
          lastAppliedResChoice = "";
          qualityAttemptedForVideoId = "";
          applyPreferredResolution("storage-changed");
          const inpageSelectResolution = document.querySelector("#inpageSelectResolution");
          if (inpageSelectResolution) inpageSelectResolution.value = settings.preferredResolution || "auto";
        }
        if (changes.customSkipDb !== undefined) {
          customSkipDb = changes.customSkipDb.newValue || {};
          activeSegmentVideoId = ""; // Force reload segments
          changed = true;
        }
        if (changes.ignoredSegments !== undefined) {
          ignoredSegments = changes.ignoredSegments.newValue || {};
          activeSegmentVideoId = "";
          changed = true;
        }
        if (changes.retimedSegments !== undefined) {
          retimedSegments = changes.retimedSegments.newValue || {};
          activeSegmentVideoId = "";
          changed = true;
        }
        if (changes.gachaWhitelist !== undefined) {
          gachaWhitelist = changes.gachaWhitelist.newValue || { videoIds: [], channels: [] };
          changed = true;
        }
        if (changed) {
          applyFeatures();
        }
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "GACHA_STATE_CHANGED":
        settings.enabled = msg.enabled;
        applyFeatures();
        sendResponse({ success: true });
        break;

      case "SET_VOLUME_BOOST":
        setVolumeBoost(msg.boost);
        sendResponse({ success: true, boost: settings.volumeBoost });
        break;

      case "GET_VOLUME_BOOST":
        sendResponse({ boost: settings.volumeBoost || 100 });
        break;

      case "SEEK_VIDEO":
        seekVideo(msg.time);
        sendResponse({ success: true });
        break;

      case "GET_CURRENT_VIDEO_SEGMENTS": {
        const urlParams = new URLSearchParams(window.location.search);
        const vId = urlParams.get("v") || "";
        sendResponse({
          videoId: vId,
          allSegments: allLoadedSegments,
          poi: activePoiHighlight,
          activeSegments: activeVideoSegments,
          volumeBoost: settings.volumeBoost || 100
        });
        break;
      }

      case "TOGGLE_IGNORE_SEGMENT":
        toggleIgnoreSegment(msg.videoId, msg.segmentId);
        sendResponse({ success: true });
        break;

      case "RETIME_SEGMENT":
        saveRetimedSegment(msg.videoId, msg.segmentId, msg.start, msg.end);
        sendResponse({ success: true });
        break;

      case "RESET_RETIME_SEGMENT":
        resetRetimedSegment(msg.videoId, msg.segmentId);
        sendResponse({ success: true });
        break;

      case "ADD_CUSTOM_SEGMENT":
        saveCustomSkipSegment(msg.videoId, msg.start, msg.end, msg.category, msg.label)
          .then(sendResponse)
          .catch((error) => sendResponse({ success: false, error: error.message || "Failed to save segment" }));
        return true;

      case "DELETE_CUSTOM_SEGMENT":
        deleteCustomSkipSegment(msg.videoId, msg.segmentId);
        sendResponse({ success: true });
        break;
    }
    return true;
  });

  // Handle YouTube Desktop & Mobile SPA Navigation
  let lastNavigationHref = window.location.href;
  function handlePageNavigation() {
    autoSkipCheckGeneration++;
    if (autoSkipPollTimer) {
      clearTimeout(autoSkipPollTimer);
      autoSkipPollTimer = null;
    }
    if (autoplayGuardTimeout) {
      clearTimeout(autoplayGuardTimeout);
      autoplayGuardTimeout = null;
    }
    videoListenerAttached = false;
    userDismissedSkipForVideoId = "";
    userManuallyMutedForVideoId = "";
    qualityAttemptedForVideoId = "";
    window.__gachaUserManuallyPaused = false;
    lastNavigatedTime = Date.now();
    isSkipping = false;
    lastSkippedSegment = null;
    removeSkipOverlay();
    recordCurrentTrackSession();
    updateInpagePlayPauseState();

    // If navigating away from watch pages to Home or Search, reset continuous listening session
    if (!isWatchPage()) {
      isContinuousListeningSession = false;
      gestureUnmuteArmed = false;
    }

    // Restore only state that this extension changed. Preserve user mute and
    // playback-rate choices across YouTube SPA navigation.
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    restoreAutoSkipMute();
    if (video && wasAdPlaying) {
      video.muted = userMutedStateBeforeAd;
      video.playbackRate = userPlaybackRateBeforeAd;
    }
    wasAdPlaying = false;
    userMutedStateBeforeAd = false;
    userPlaybackRateBeforeAd = 1;

    if (video && settings.enabled && settings.volumeBoost > 100) {
      setupAudioBooster(video);
    }
    ensureAudioContextResumed();

    applyFeatures();
    handleFullscreenState();
    lastNavigationHref = window.location.href;

    // Follow-up retries as new page components mount and populate
    [300, 800, 1500, 2500, 4000].forEach((delay) => {
      setTimeout(() => {
        if (settings.enabled) {
          applyFeatures();
          ensureAudioContextResumed();
          if (isWatchPage()) {
            attemptAutoplayRecovery("navigation-delay");
            if (settings.autoUnmute !== false) {
              attemptAutoUnmute("navigation-delay");
            }
            applyPreferredResolution("navigation-delay");
          }
        }
      }, delay);
    });
  }

  [
    "yt-navigate-finish",
    "ytm-page-update",
    "yt-page-data-updated",
    "yt-visibility-refresh",
    "DOMContentLoaded",
    "load",
    "popstate",
    "hashchange",
    "yt-navigate"
  ].forEach((evt) => {
    window.addEventListener(evt, handlePageNavigation);
  });

  // URL polling fallback for mobile browsers that don't emit custom events
  setInterval(() => {
    if (window.location.href !== lastNavigationHref) {
      handlePageNavigation();
    }
  }, 1200);

  // Continuous DOM observer with adaptive throttling during video playback
  let observerDebounceTimeout = null;
  const observer = new MutationObserver(() => {
    if (observerDebounceTimeout) return;
    const isWatch = window.location.pathname.startsWith("/watch") || window.location.pathname.startsWith("/shorts");
    const debounceDelay = isWatch ? 800 : 350;
    observerDebounceTimeout = setTimeout(() => {
      observerDebounceTimeout = null;

      handleFullscreenState();

      if (!settings.enabled) return;

      if (settings.blockAds !== false) {
        runAdBlockerCycle();
      }

      if (isWatch) {
        injectPlayerBarBoostControl();
      }

      if (settings.autoplayGuard && !videoListenerAttached) {
        setupAutoplayGuard();
      }
      if (settings.showSearchChips && !isWatch && !document.getElementById("gacha-search-chips-bar")) {
        injectSearchChips();
      }
      if (settings.showJukebox && !document.getElementById("gacha-floating-widget")) {
        injectFloatingJukebox();
      }

      // Do not run heavy feed card lookups during active video playback
      if (settings.filterOfficialVideos && !isWatch) {
        applyFeedBadgesAndFilters();
      }
    }, debounceDelay);
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Initial call with DOM ready guard & continuous watchdog
  function startInit() {
    if (document.body || document.readyState === "interactive" || document.readyState === "complete") {
      init();
    } else {
      document.addEventListener("DOMContentLoaded", () => init(), { once: true });
      window.addEventListener("load", () => init(), { once: true });
      setTimeout(init, 300);
    }

    // Continuous Video & UI Watchdog (Runs every 1500ms)
    setInterval(() => {
      if (!settings.enabled) return;

      const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
      if (video && !videoListenerAttached) {
        setupVideoPlayerListeners();
      }

      const isWatch = window.location.pathname.startsWith("/watch") || window.location.pathname.startsWith("/shorts");
      if (video && video.paused && !video.ended && video.currentTime < 2.0 && isWatch && !window.__gachaUserManuallyPaused) {
        attemptAutoplayRecovery("watchdog");
      }

      if (settings.showJukebox && !document.getElementById("gacha-floating-widget")) {
        injectFloatingJukebox();
      }
      if (settings.showSearchChips && !isWatch && !document.getElementById("gacha-search-chips-bar")) {
        injectSearchChips();
      }
      if (settings.blockAds !== false) {
        runAdBlockerCycle();
      }
    }, 1500);

    // Desktop Playback Keyboard Shortcuts (Shift+P, Alt+Left)
    if (!window.__gachaPlaybackShortcutsAttached__) {
      window.__gachaPlaybackShortcutsAttached__ = true;
      window.addEventListener("keydown", (e) => {
        const tag = (e.target && e.target.tagName ? e.target.tagName.toLowerCase() : "");
        if (tag === "input" || tag === "textarea" || (e.target && e.target.isContentEditable)) {
          return;
        }

        if ((e.shiftKey && (e.key === "P" || e.key === "p")) || (e.altKey && e.key === "ArrowLeft")) {
          e.preventDefault();
          e.stopPropagation();
          playPreviousTrack();
        }
      }, true);
    }
  }

  startInit();
})();
