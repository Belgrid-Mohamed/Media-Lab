const { versionAtLeast } = require("./utils");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

/** ============================================================================
 * binaries-manager.js: where the tools are and how they are called.
 * The web installer puts yt-dlp, ffmpeg, ffprobe and deno in <userData>/bin; the app only
 * finds them here. (Updating yt-dlp itself is in updates-mechanism.js.)
 * ========================================================================== */
const isWin = process.platform === "win32";

function getBinDir() {
  return path.join(app.getPath("userData"), "bin");
}

function getBinPaths() {
  const binDir = getBinDir();
  return {
    binDir,
    ytDlp: path.join(binDir, isWin ? "yt-dlp.exe" : "yt-dlp"),
    ffmpeg: path.join(binDir, isWin ? "ffmpeg.exe" : "ffmpeg"),
    ffprobe: path.join(binDir, isWin ? "ffprobe.exe" : "ffprobe"),
    // JavaScript runtime. Without it yt-dlp can only see YouTube's 360p format.
    deno: path.join(binDir, isWin ? "deno.exe" : "deno"),
  };
}

/** Checks if all required binaries (yt-dlp, ffmpeg, ffprobe, deno) are installed */
function checkBinariesExist() {
  const { ytDlp, ffmpeg, ffprobe, deno } = getBinPaths();
  return (
    fs.existsSync(ytDlp) &&
    fs.existsSync(ffmpeg) &&
    fs.existsSync(ffprobe) &&
    fs.existsSync(deno)
  );
}

/**
 * Flags added to every yt-dlp call.
 * The old "player_client=android,web" override is gone: the android client only
 * returns YouTube's 360p stream, and forcing it hid every higher quality.
 * yt-dlp now picks its own clients, and gets a JavaScript runtime (Deno, put in place
 * by the installer) to solve YouTube's challenge, which unlocks 144p to 2160p+.
 */
/** Shared state: the installed yt-dlp version, and the first-run install (others wait for it). */
const engine = { version: null, setup: Promise.resolve() };


function getExtractorFlags() {
  const { deno } = getBinPaths();
  if (!fs.existsSync(deno)) return [];
  // Older yt-dlp builds don't know --js-runtimes and would refuse to start
  if (engine.version && !versionAtLeast(engine.version, "2025.11.12")) return [];
  return ["--js-runtimes", `deno:${deno}`];
}

module.exports = {
  checkBinariesExist,
  engine,
  getBinPaths,
  getExtractorFlags,
};
