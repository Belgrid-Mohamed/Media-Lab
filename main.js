/** ============================================================================
 * main.js: Electron main process. It only starts the app; the work lives in src/Core.
 * ========================================================================== */
const { app, protocol, dialog } = require("electron");
const path = require("path");

// A stream the player stopped reading, or a connection the other side dropped, is not an error
// worth a message box: everything else is still shown.
process.on("uncaughtException", (err) => {
  if (err && ["ERR_INVALID_STATE", "ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE"].includes(err.code)) {
    console.warn("Ignored:", err.code);
    return;
  }
  dialog.showErrorBox("A JavaScript error occurred in the main process", String((err && err.stack) || err));
});

// "mbpreview://" lets the trim popover play a small copy of a video (see preview.js)
protocol.registerSchemesAsPrivileged([
  { scheme: "mbpreview", privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

// The app name and the data folder must be set before the Core modules read them
app.setName("mb-media-downloader-v2");
app.setPath("userData", path.join(app.getPath("appData"), "mb-media-downloader-v2"));

const { loadAppPrefs } = require("./src/Core/system");
const { createWindow, getMainWindow, setQuitting } = require("./src/Core/window");
const { watchClipboard } = require("./src/Core/link-info");
const { handlePreviewRequest, clearPreviewDir } = require("./src/Core/preview");
const { setupEngine } = require("./src/Core/updates-mechanism");
const { killAllDownloads } = require("./src/Core/downloader");
const { registerIpcHandlers } = require("./src/Core/ipc-handlers");

if (process.platform === "win32") {
  app.setAppUserModelId(app.isPackaged ? "com.mbmediadownloader.app" : process.execPath);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerIpcHandlers();

  app.on("second-instance", () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    protocol.handle("mbpreview", handlePreviewRequest);
    clearPreviewDir(); // leftovers from a crashed session
    loadAppPrefs();
    createWindow();
    watchClipboard();
    await setupEngine();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    setQuitting();
    killAllDownloads();
    clearPreviewDir();
  });
}
