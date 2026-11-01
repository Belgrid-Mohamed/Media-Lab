/** ============================================================================
 * ipc-handlers.js: every message the window can send to the main process.
 * Each handler is one line that calls the module that does the work.
 * ========================================================================== */
const { ipcMain, app, shell, clipboard } = require("electron");
const fs = require("fs");
const { FOCUS_CHANNELS } = require("./config");
const { isValidHttpUrl } = require("./utils");
const { appPrefs, saveAppPrefs, getDiskSpace, readLocale, setPreventSleep } = require("./system");
const { minimizeWindow, toggleMaximize, hideToTray, closeWindow, selectFolder, notify } = require("./window");
const { focusFeature, focusWrap, withTier } = require("./process-control");
const { checkYtDlpUpdate, readYtDlpVersion, updateYtDlp } = require("./updates-mechanism");
const { prefetchPrefs, ensurePrefetch, cancelMediaInfo, fetchLinkPreview, fetchPlaylistItemsInternal, fetchPlaylistSummary, findPlaylistOfVideo } = require("./link-info");
const { preparePreviewFile, cancelPreview } = require("./preview");
const { openPreviewStream, closeStreamSession, prewarmPreviewStream, readStreamChunk, startStreamTiles, cancelStreamChunk, prefetchStreamChunk } = require("./preview-stream");
const { startDownloadJob, cancelDownload, getDownloadStates } = require("./downloader");

// Handlers of the features the person opens (trim, qualities, ...) run in the "focus" context:
// the work they start gets CPU priority over the rest (see process-control.js).
const wrap = (channel, fn) => (FOCUS_CHANNELS.has(channel) ? focusWrap(fn, channel) : fn);
const handle = (channel, fn) => ipcMain.handle(channel, wrap(channel, fn));
const on = (channel, fn) => ipcMain.on(channel, wrap(channel, fn));

/** For links: a bad link gets `bad` back instead of reaching yt-dlp. */
const whenValid = (fn, bad) => (event, url, ...rest) => (isValidHttpUrl(url) ? fn(url, ...rest) : bad);

function registerIpcHandlers() {
  // ---- window
  on("win-minimize", minimizeWindow);
  on("win-maximize", toggleMaximize);
  on("win-to-tray", hideToTray);
  on("win-close", closeWindow);
  on("focus-feature", (event, name, url) => focusFeature(name, url));

  // ---- settings and system
  on("set-app-prefs", (event, prefs) => {
    if (!prefs || typeof prefs !== "object") return;
    appPrefs.rememberWindow = prefs.rememberWindow !== false;
    appPrefs.startMinimized = !!prefs.startMinimized;
    appPrefs.minimizeToTray = !!prefs.minimizeToTray;
    prefetchPrefs.watchClipboard = prefs.autoDetect !== false;
    if (typeof prefs.defaultFormat === "string" && /^[A-Za-z0-9]{2,8}$/.test(prefs.defaultFormat))
      prefetchPrefs.format = prefs.defaultFormat;
    if (typeof prefs.defaultQuality === "string" && /^[A-Za-z0-9 ]{2,20}$/.test(prefs.defaultQuality))
      prefetchPrefs.quality = prefs.defaultQuality;
    saveAppPrefs();
    // Only register a login item for the packaged app, never for `electron .`
    if (app.isPackaged && (process.platform === "win32" || process.platform === "darwin")) {
      try {
        app.setLoginItemSettings({ openAtLogin: appPrefs.startMinimized, args: ["--hidden"] });
      } catch {}
    }
  });
  on("set-prevent-sleep", (event, enabled) => setPreventSleep(enabled));
  on("notify", (event, title, body) => notify(title, body));
  handle("select-folder", (event, defaultPath) => selectFolder(defaultPath));
  handle("get-default-download-dir", () => app.getPath("downloads"));
  handle("get-disk-space", async (event, dir) => {
    try {
      return await getDiskSpace(dir);
    } catch {
      return null;
    }
  });
  handle("get-locale", (event, code) => readLocale(code));
  handle("read-clipboard", () => {
    try {
      return clipboard.readText();
    } catch {
      return "";
    }
  });

  // ---- files and folders
  handle("open-folder", async (event, dir) => {
    const target = dir && String(dir).trim() ? String(dir) : app.getPath("downloads");
    try {
      if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
      const err = await shell.openPath(target);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  on("open-file", (event, filePath) => filePath && shell.openPath(filePath));
  on("show-in-folder", (event, filePath) => filePath && shell.showItemInFolder(filePath));

  // ---- yt-dlp engine
  handle("ytdlp-version", readYtDlpVersion);
  handle("ytdlp-check-update", checkYtDlpUpdate);
  handle("ytdlp-update", updateYtDlp);

  // ---- link analysis
  handle("fetch-media-info", whenValid((url) => ensurePrefetch(url).full, { error: "Invalid URL" }));
  handle("fetch-quick-info", whenValid((url) => ensurePrefetch(url).quick, { error: "Invalid URL" }));
  handle("fetch-link-preview", whenValid(fetchLinkPreview, null));
  on("cancel-media-info", whenValid(cancelMediaInfo));
  handle("fetch-playlist-items", whenValid(fetchPlaylistItemsInternal, { success: false, items: [] }));
  handle(
    "fetch-playlist-summary",
    whenValid(async (url) => {
      try {
        return await fetchPlaylistSummary(url);
      } catch {
        return { success: false };
      }
    }, { success: false }),
  );
  handle(
    "find-video-playlist",
    whenValid(async (url) => {
      try {
        return await findPlaylistOfVideo(url);
      } catch (err) {
        return { success: false, reason: "error", error: err.message };
      }
    }, { success: false, reason: "invalid" }),
  );

  // ---- trim preview and player
  // The app's own preparation of the trim preview: never ahead of what the person is looking at
  on("prewarm-preview", whenValid((url) => withTier("low", "trim", () => prewarmPreviewStream(url))));
  handle("prepare-preview", whenValid((url, extra) => preparePreviewFile(url, extra || {}), { error: "Invalid URL" }));
  on("cancel-preview", (event, url) => cancelPreview(url));
  handle(
    "stream-open",
    whenValid(async (url) => {
      try {
        return await openPreviewStream(url);
      } catch (err) {
        return { error: err.message };
      }
    }, { error: "Invalid URL" }),
  );
  handle("stream-chunk", (event, id, opts) => readStreamChunk(id, opts));
  handle("stream-tiles", (event, id) => startStreamTiles(id));
  on("stream-cancel", (event, req) => cancelStreamChunk(req));
  on("stream-prefetch", (event, id, opts) => prefetchStreamChunk(id, opts));
  on("stream-close", (event, id) => closeStreamSession(String(id)));

  // ---- downloads
  on("start-download", (event, payload) => startDownloadJob(payload));
  on("cancel-download", (event, downloadId, opts) => cancelDownload(downloadId, opts));
  handle("get-download-states", getDownloadStates);
}

module.exports = {
  registerIpcHandlers,
};
