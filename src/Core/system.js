const { app, powerSaveBlocker } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

/** --------------------------------------------------------------------------
 * WINDOW MANAGEMENT
 * -------------------------------------------------------------------------- */

/** App-level preferences the main process needs before the renderer exists */
const appPrefsPath = () => path.join(app.getPath("userData"), "app-prefs.json");

const appPrefs = {
  rememberWindow: true,
  startMinimized: false,
  minimizeToTray: false,
  cookiesBrowser: "", // optional: "firefox" | "edge" | "chrome" | "brave" ...
  cookiesFile: "", // optional: path to a cookies.txt
};

function loadAppPrefs() {
  try {
    const saved = JSON.parse(fs.readFileSync(appPrefsPath(), "utf8"));
    if (typeof saved.rememberWindow === "boolean")
      appPrefs.rememberWindow = saved.rememberWindow;
    if (typeof saved.startMinimized === "boolean")
      appPrefs.startMinimized = saved.startMinimized;
    if (typeof saved.minimizeToTray === "boolean")
      appPrefs.minimizeToTray = saved.minimizeToTray;
    if (typeof saved.cookiesBrowser === "string")
      appPrefs.cookiesBrowser = saved.cookiesBrowser.trim().toLowerCase();
    if (typeof saved.cookiesFile === "string")
      appPrefs.cookiesFile = saved.cookiesFile.trim();
  } catch {}
}

function saveAppPrefs() {
  try {
    fs.writeFileSync(appPrefsPath(), JSON.stringify(appPrefs));
  } catch {}
}

let sleepBlockerId = null;

function powershellDiskInfo(driveLetter) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$d = Get-PSDrive -Name '${driveLetter}'; "$($d.Free)|$($d.Used + $d.Free)"`,
      ],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const [free, total] = String(stdout).trim().split("|").map(Number);
        resolve(Number.isFinite(free) ? { free, total } : null);
      },
    );
  });
}

async function getDiskSpace(dir) {
  let p =
    dir && String(dir).trim()
      ? path.resolve(String(dir))
      : app.getPath("downloads");
  while (!fs.existsSync(p)) {
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }

  if (fs.promises.statfs) {
    try {
      const st = await fs.promises.statfs(p);
      return {
        free: Number(st.bavail) * Number(st.bsize),
        total: Number(st.blocks) * Number(st.bsize),
      };
    } catch {}
  }

  const m = path.parse(p).root.match(/^([A-Za-z]):/);
  if (m) return powershellDiskInfo(m[1]);
  return null;
}

function setPreventSleep(on) {
  if (on && sleepBlockerId === null) {
    sleepBlockerId = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!on && sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
}

/** The texts of one interface language (Locales/<code>.json in the app folder). */
function readLocale(code) {
  const name = String(code || "");
  if (!/^[a-z]{2}$/.test(name)) return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "Locales", name + ".json"), "utf8"));
  } catch {
    return {};
  }
}

module.exports = {
  appPrefs,
  getDiskSpace,
  loadAppPrefs,
  readLocale,
  saveAppPrefs,
  setPreventSleep,
};
