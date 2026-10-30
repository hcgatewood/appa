// live_reload.js reloads the page when its file changes on disk. appa adds it, after socket.io's client, to every
// Markdown and HTML page it serves.
//
// The page names its file by its own URL, so appa never writes a file name into a script, where a quote or
// "</script>" in the name would need escaping.

// The function wrapper keeps the client's names from colliding with the page's own scripts
(() => {
  const { socketPath } = document.currentScript.dataset;
  const socket = io({ path: socketPath });

  // "connect" fires again after a reconnect, e.g. when appa restarts, and the new server knows nothing of this page
  socket.on("connect", () => socket.emit("watch", location.pathname));
  socket.on("file_updated", () => location.reload());

  // A page restored from the back-forward cache may have missed updates while it was cached
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });
})();
