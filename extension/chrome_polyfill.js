/**
 * Chrome Extension Polyfill for Gacha MV Player Android App
 * Bridges chrome.storage.local, chrome.runtime, and browser events using localStorage.
 */
(function() {
  if (window.chrome && window.chrome.storage && window.chrome.storage.local) {
    return;
  }

  const STORAGE_PREFIX = "gcmv_ext_";
  const listeners = [];

  function hydrateFromNativePrefs() {
    if (!(window.AndroidBridge && typeof window.AndroidBridge.getAllPrefs === "function")) {
      return;
    }
    try {
      const native = JSON.parse(window.AndroidBridge.getAllPrefs() || "{}");
      if (!native || typeof native !== "object") return;
      for (const [k, v] of Object.entries(native)) {
        localStorage.setItem(STORAGE_PREFIX + k, JSON.stringify(v));
      }
    } catch (e) {
      console.warn("[GCMV Polyfill] Native hydrate failed:", e);
    }
  }

  function persistToNativePrefs(key, value) {
    if (!(window.AndroidBridge && typeof window.AndroidBridge.savePref === "function")) {
      return;
    }
    try {
      window.AndroidBridge.savePref(key, JSON.stringify(value));
    } catch (e) {
      console.warn("[GCMV Polyfill] Native persist failed:", e);
    }
  }

  hydrateFromNativePrefs();

  function getFromStorage(keys) {
    const result = {};
    if (keys === null || keys === undefined) {
      for (let i = 0; i < localStorage.length; i++) {
        const fullKey = localStorage.key(i);
        if (fullKey && fullKey.startsWith(STORAGE_PREFIX)) {
          const key = fullKey.slice(STORAGE_PREFIX.length);
          try {
            result[key] = JSON.parse(localStorage.getItem(fullKey));
          } catch (e) {
            result[key] = localStorage.getItem(fullKey);
          }
        }
      }
      return result;
    }

    if (typeof keys === "string") {
      keys = [keys];
    }

    if (Array.isArray(keys)) {
      for (const k of keys) {
        const item = localStorage.getItem(STORAGE_PREFIX + k);
        if (item !== null) {
          try {
            result[k] = JSON.parse(item);
          } catch (e) {
            result[k] = item;
          }
        }
      }
      return result;
    }

    if (typeof keys === "object") {
      for (const [k, defaultVal] of Object.entries(keys)) {
        const item = localStorage.getItem(STORAGE_PREFIX + k);
        if (item !== null) {
          try {
            result[k] = JSON.parse(item);
          } catch (e) {
            result[k] = item;
          }
        } else {
          result[k] = defaultVal;
        }
      }
      return result;
    }

    return result;
  }

  function setToStorage(items) {
    const changes = {};
    for (const [k, newVal] of Object.entries(items)) {
      const fullKey = STORAGE_PREFIX + k;
      const oldRaw = localStorage.getItem(fullKey);
      let oldVal = undefined;
      if (oldRaw !== null) {
        try {
          oldVal = JSON.parse(oldRaw);
        } catch (e) {
          oldVal = oldRaw;
        }
      }
      localStorage.setItem(fullKey, JSON.stringify(newVal));
      persistToNativePrefs(k, newVal);
      changes[k] = { oldValue: oldVal, newValue: newVal };
    }

    for (const cb of listeners) {
      try {
        cb(changes, "local");
      } catch (e) {
        console.error("[GCMV Polyfill] Listener error:", e);
      }
    }
  }

  window.chrome = window.chrome || {};
  window.browser = window.browser || window.chrome;

  window.chrome.storage = {
    local: {
      get: function(keys, callback) {
        return new Promise((resolve) => {
          const res = getFromStorage(keys);
          if (typeof callback === "function") {
            callback(res);
          }
          resolve(res);
        });
      },
      set: function(items, callback) {
        return new Promise((resolve) => {
          setToStorage(items);
          if (typeof callback === "function") {
            callback();
          }
          resolve();
        });
      },
      remove: function(keys, callback) {
        return new Promise((resolve) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) {
            localStorage.removeItem(STORAGE_PREFIX + k);
          }
          if (typeof callback === "function") {
            callback();
          }
          resolve();
        });
      },
      clear: function(callback) {
        return new Promise((resolve) => {
          for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && k.startsWith(STORAGE_PREFIX)) {
              localStorage.removeItem(k);
            }
          }
          if (typeof callback === "function") {
            callback();
          }
          resolve();
        });
      }
    },
    onChanged: {
      addListener: function(listener) {
        if (typeof listener === "function" && !listeners.includes(listener)) {
          listeners.push(listener);
        }
      },
      removeListener: function(listener) {
        const idx = listeners.indexOf(listener);
        if (idx !== -1) {
          listeners.splice(idx, 1);
        }
      },
      hasListener: function(listener) {
        return listeners.includes(listener);
      }
    }
  };

  window.chrome.runtime = window.chrome.runtime || {
    id: "gacha-mv-player-android",
    getURL: function(path) {
      return path;
    },
    sendMessage: function(msg, callback) {
      return new Promise((resolve) => {
        if (typeof callback === "function") callback({});
        resolve({});
      });
    },
    onMessage: {
      addListener: function() {},
      removeListener: function() {}
    }
  };

  window.chrome.tabs = window.chrome.tabs || {
    query: function(queryInfo, callback) {
      const tabs = [{ id: 1, url: window.location.href, active: true }];
      if (typeof callback === "function") callback(tabs);
      return Promise.resolve(tabs);
    },
    sendMessage: function(tabId, message, callback) {
      if (window.AndroidBridge && window.AndroidBridge.onTabMessage) {
        window.AndroidBridge.onTabMessage(JSON.stringify(message));
      }
      if (typeof callback === "function") callback({});
      return Promise.resolve({});
    },
    create: function(createProperties, callback) {
      if (createProperties && createProperties.url) {
        if (window.AndroidBridge && window.AndroidBridge.loadUrl) {
          window.AndroidBridge.loadUrl(createProperties.url);
        } else {
          window.location.href = createProperties.url;
        }
      }
      if (typeof callback === "function") callback({});
      return Promise.resolve({});
    }
  };

  console.log("[GCMV] Chrome extension polyfill initialized successfully for Android app.");
})();
