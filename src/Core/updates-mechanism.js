const { runYtDlp } = require("./process-control");
const { checkBinariesExist, engine } = require("./binaries-manager");
const { fetchJson } = require("./utils");
const { resetAnalysisCaches } = require("./link-info");
const { send } = require("./window");

/** --------------------------------------------------------------------------
 * yt-dlp ENGINE: VERSION, UPDATE CHECK, SELF-UPDATE
 * -------------------------------------------------------------------------- */
async function readYtDlpVersion() {
  const res = await runYtDlp(["--version"], 10000);
  return res.code === 0 ? res.stdout.trim() : "";
}

/** Reads the installed version into the shared engine state. */
async function loadYtDlpVersion() {
  const version = await readYtDlpVersion();
  if (version) engine.version = version;
  return version;
}

async function checkYtDlpUpdate() {
  const [currentVersion, latest] = await Promise.all([
    readYtDlpVersion(),
    fetchJson("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest", 8000, {
      "User-Agent": "mb-media-downloader",
    }),
  ]);
  const latestVersion = latest && latest.tag_name ? String(latest.tag_name) : "";
  return {
    currentVersion,
    latestVersion,
    updateAvailable: !!(currentVersion && latestVersion && currentVersion !== latestVersion),
  };
}

async function updateYtDlp() {
  const res = await runYtDlp(["-U"], 120000);
  await loadYtDlpVersion();
  resetAnalysisCaches(); // answers read with the old version may be wrong
  const last = String(res.stdout || res.stderr || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return { ok: res.code === 0, message: last || "" };
}

/**
 * First start: check that the installer left every tool in place, then read the yt-dlp
 * version. Everything that needs the engine waits for `engine.setup`.
 */
function setupEngine() {
  engine.setup = (async () => {
    if (!checkBinariesExist()) {
      send("download-error", {
        downloadId: "setup",
        error: "Some required tools are missing. Please reinstall MB Media Downloader.",
      });
    }
    await loadYtDlpVersion();
  })();
  return engine.setup;
}

module.exports = {
  checkYtDlpUpdate,
  readYtDlpVersion,
  setupEngine,
  updateYtDlp,
};
