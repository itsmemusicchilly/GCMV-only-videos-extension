// Gacha MV Player - Main World Execution Context
// Provides direct access to YouTube's movie_player without CSP / Trusted Types restrictions
(function() {
  if (window.__GCMV_MAIN_WORLD_LOADED__) return;
  window.__GCMV_MAIN_WORLD_LOADED__ = true;

  function getPlayer() {
    return document.getElementById("movie_player") || document.querySelector(".html5-video-player");
  }

  window.addEventListener("GCMV_MAIN_WORLD_CMD", function(e) {
    if (!e || !e.detail) return;
    const { action, videoId, time } = e.detail;
    const player = getPlayer();

    if (action === "loadVideoById" && videoId) {
      if (player && typeof player.loadVideoById === "function") {
        try {
          player.loadVideoById(videoId);
          if (typeof player.playVideo === "function") {
            player.playVideo();
          }
          window.dispatchEvent(new CustomEvent("GCMV_MAIN_WORLD_RESP", {
            detail: { action: "loadVideoById", success: true, videoId: videoId }
          }));
        } catch (err) {
          console.warn("[GCMV MainWorld] loadVideoById error:", err);
        }
      }
    } else if (action === "next") {
      if (player && typeof player.nextVideo === "function") {
        player.nextVideo();
        player.playVideo?.();
      }
    } else if (action === "previous") {
      if (player && typeof player.previousVideo === "function") {
        player.previousVideo();
        player.playVideo?.();
      }
    } else if (action === "play") {
      player?.playVideo?.();
    } else if (action === "pause") {
      player?.pauseVideo?.();
    } else if (action === "seek" && typeof time === "number") {
      player?.seekTo?.(time, true);
    }
  });
})();
