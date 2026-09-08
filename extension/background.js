/**
 * Gacha MV Player - Universal Background Service Worker & Script
 * Proxies HTTP requests to private local LAN / Tailscale NAS servers to avoid
 * browser Mixed Content restrictions on HTTPS YouTube pages.
 * Uses the callback response form supported by Firefox and Chromium.
 */

const extensionApi = typeof browser !== "undefined" ? browser : chrome;
const runtime = extensionApi.runtime;

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

function isAllowedApiPath(pathname) {
  return ["/", "/health", "/api/status", "/api/skipSegments", "/skipSegments", "/api/database"].includes(pathname);
}

runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "FETCH_NAS") return undefined;

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

  // Keep sendResponse alive until the fetch above completes. Firefox and
  // Chromium both support this callback-based WebExtension response pattern.
  return true;
});
