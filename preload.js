/* ============================================================================
   preload.js
   Exposes secure IPC bridges between the renderer UI and main process.
   (One bridge only: `window.api`.)
   ========================================================================== */
const { contextBridge, ipcRenderer } = require("electron");

/** Subscribes once per callback and returns an unsubscribe function. */
function listen(channel, callback) {
  const handler = (_event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("api", {
  // Window controls
  minimize: () => ipcRenderer.send("win-minimize"),
  maximize: () => ipcRenderer.send("win-maximize"),
  minimizeToTray: () => ipcRenderer.send("win-to-tray"),
  close: () => ipcRenderer.send("win-close"),
  setAppPrefs: (prefs) => ipcRenderer.send("set-app-prefs", prefs),
  setPreventSleep: (on) => ipcRenderer.send("set-prevent-sleep", !!on),

  // File system & utilities
  selectFolder: (defaultPath) =>
    ipcRenderer.invoke("select-folder", defaultPath),
  getDefaultDownloadDir: () => ipcRenderer.invoke("get-default-download-dir"),
  getDiskSpace: (dir) => ipcRenderer.invoke("get-disk-space", dir),
  readClipboard: () => ipcRenderer.invoke("read-clipboard"),
  notify: (title, body) => ipcRenderer.send("notify", title, body),
  openFile: (filePath) => ipcRenderer.send("open-file", filePath),
  showInFolder: (filePath) => ipcRenderer.send("show-in-folder", filePath),
  openFolder: (dir) => ipcRenderer.invoke("open-folder", dir),

  // yt-dlp: metadata, downloads
  // `opts.background: true` marks work the app starts by itself while the person is away:
  // it runs after anything the person asked for and never takes priority over it.
  fetchMediaInfo: (url, opts) =>
    ipcRenderer.invoke("fetch-media-info", url, opts),
  fetchLinkPreview: (url) => ipcRenderer.invoke("fetch-link-preview", url),
  fetchQuickInfo: (url, opts) => ipcRenderer.invoke("fetch-quick-info", url, opts),
  preparePreview: (url, extra) =>
    ipcRenderer.invoke("prepare-preview", url, extra),
  cancelMediaInfo: (url) => ipcRenderer.send("cancel-media-info", url),
  cancelPreview: (url) => ipcRenderer.send("cancel-preview", url),
  fetchPlaylistItems: (url, opts) =>
    ipcRenderer.invoke("fetch-playlist-items", url, opts),
  findVideoPlaylist: (url, opts) =>
    ipcRenderer.invoke("find-video-playlist", url, opts),
  // The playlist's name and how many videos it holds, in a moment (level 1)
  fetchPlaylistSummary: (url, opts) =>
    ipcRenderer.invoke("fetch-playlist-summary", url, opts),
  // The person opened a feature (trim, qualities, playlist): it gets priority over the rest
  focusFeature: (name, url) => ipcRenderer.send("focus-feature", name, url),
  // Gets the cutting preview (first seconds + timeline pictures) ready in the background
  prewarmPreview: (url) => ipcRenderer.send("prewarm-preview", url),
  startDownload: (payload) => ipcRenderer.send("start-download", payload),
  cancelDownload: (downloadId, opts) =>
    ipcRenderer.send("cancel-download", downloadId, opts),
  getDownloadStates: () => ipcRenderer.invoke("get-download-states"),

  // Trim preview: the streaming player, its timeline pictures and the file copies
  streamOpen: (url) => ipcRenderer.invoke("stream-open", url),
  streamChunk: (id, opts) => ipcRenderer.invoke("stream-chunk", id, opts),
  cancelStreamChunk: (req) => ipcRenderer.send("stream-cancel", req),
  streamTiles: (id) => ipcRenderer.invoke("stream-tiles", id),
  streamPrefetch: (id, opts) => ipcRenderer.send("stream-prefetch", id, opts),
  closeStream: (id) => ipcRenderer.send("stream-close", id),

  // yt-dlp engine
  getLocale: (code) => ipcRenderer.invoke("get-locale", code),
  getYtdlpVersion: () => ipcRenderer.invoke("ytdlp-version"),
  checkYtdlpUpdate: () => ipcRenderer.invoke("ytdlp-check-update"),
  updateYtdlp: () => ipcRenderer.invoke("ytdlp-update"),

  // Events
  onProgress: (callback) => listen("download-progress", callback),
  onComplete: (callback) => listen("download-complete", callback),
  onError: (callback) => listen("download-error", callback),
  onShortcut: (callback) => listen("app-shortcut", callback),
  onStreamTile: (callback) => listen("stream-tile", callback),
  onPreviewReady: (callback) => listen("preview-ready", callback),
  onPreviewProgress: (callback) => listen("preview-progress", callback),
});
