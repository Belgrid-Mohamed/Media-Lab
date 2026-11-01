const { app, screen, Tray, nativeImage, Menu, BrowserWindow, dialog, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const { appPrefs } = require("./system");
const { TRAY_ICON } = require("./config");

let mainWindow;

const windowStatePath = () =>
  path.join(app.getPath("userData"), "window-state.json");

function loadWindowState() {
  try {
    const st = JSON.parse(fs.readFileSync(windowStatePath(), "utf8"));
    if (Number.isFinite(st.width) && Number.isFinite(st.height)) return st;
  } catch {}
  return null;
}

function saveWindowState() {
  if (!appPrefs.rememberWindow || !mainWindow || mainWindow.isDestroyed())
    return;
  try {
    const b = mainWindow.getNormalBounds();
    fs.writeFileSync(
      windowStatePath(),
      JSON.stringify({ ...b, maximized: mainWindow.isMaximized() }),
    );
  } catch {}
}

function isOnScreen(b) {
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return false;
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return (
      b.x >= w.x - 50 &&
      b.y >= w.y - 50 &&
      b.x < w.x + w.width - 80 &&
      b.y < w.y + w.height - 80
    );
  });
}

let tray = null;

let quitting = false;

// true once the app is really closing (tray "Quit", before-quit)
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function ensureTray() {
  if (tray && !tray.isDestroyed()) return;
  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON));
  tray.setToolTip("MB Media Downloader");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show", click: showMainWindow },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", showMainWindow);
}

function createWindow() {
  const saved = appPrefs.rememberWindow ? loadWindowState() : null;
  const opts = {
    width: 980,
    height: 700,
    minWidth: 620,
    minHeight: 520,
    title: "MB Media Downloader",
    frame: false,
    show: false,
    backgroundColor: "#111218",
    webPreferences: {
      preload: path.join(__dirname, "..", "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (saved) {
    opts.width = Math.max(opts.minWidth, saved.width);
    opts.height = Math.max(opts.minHeight, saved.height);
    if (isOnScreen(saved)) {
      opts.x = saved.x;
      opts.y = saved.y;
    }
  }

  mainWindow = new BrowserWindow(opts);
  if (saved && saved.maximized) mainWindow.maximize();

  mainWindow.once("ready-to-show", () => {
    const startHidden =
      appPrefs.startMinimized && process.argv.includes("--hidden");
    if (startHidden) ensureTray();
    else mainWindow.show();
  });
  mainWindow.on("close", (event) => {
    saveWindowState();
    // "Minimize to Tray on Close": the window hides, downloads keep running; the tray's Quit closes the app
    if (appPrefs.minimizeToTray && !quitting) {
      event.preventDefault();
      ensureTray();
      mainWindow.hide();
    }
  });

  // Ctrl/Cmd+R would reload the page (default menu). The queue uses it for Resume/Retry,
  // so it is handed to the page as a message instead.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (
      input.type === "keyDown" &&
      (input.control || input.meta) &&
      !input.shift &&
      !input.alt &&
      String(input.key).toLowerCase() === "r"
    ) {
      event.preventDefault();
      send("app-shortcut", "resume");
    }
  });

  mainWindow.loadFile(
    path.join(__dirname, "..", "Pages", "Downloads", "downloads-index.html"),
  );
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** --- window controls used by the renderer's title bar and by the other modules --- */
const getMainWindow = () => mainWindow;
const setQuitting = () => {
  quitting = true;
};
const minimizeWindow = () => mainWindow?.minimize();
const closeWindow = () => mainWindow?.close();

function toggleMaximize() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
}

function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  ensureTray();
  mainWindow.hide();
}

async function selectFolder(defaultPath) {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    ...(defaultPath && fs.existsSync(String(defaultPath)) ? { defaultPath: String(defaultPath) } : {}),
  });
  return result.canceled ? "" : result.filePaths[0];
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: String(title || "MB Media Downloader"),
    body: String(body || ""),
    silent: false,
  });
  n.on("click", showMainWindow);
  n.show();
}

module.exports = {
  closeWindow,
  createWindow,
  getMainWindow,
  hideToTray,
  minimizeWindow,
  notify,
  selectFolder,
  send,
  setQuitting,
  toggleMaximize,
};
