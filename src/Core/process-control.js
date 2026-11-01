const { AsyncLocalStorage } = require("async_hooks");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { spawn } = require("child_process");
const { normalizeUrl } = require("./utils");
const { BOT_ERROR, CONNECT_ERROR, COOKIE_BROWSERS, DNS_ERROR, FOCUS_HOLD_MS, IS_YOUTUBE_URL, isWin } = require("./config");
const { appPrefs } = require("./system");
const { getBinPaths } = require("./binaries-manager");

/** --------------------------------------------------------------------------
 * FEATURE PRIORITY
 * When the person opens a feature (trim, qualities, playlist explorer, ...), the work it
 * starts runs at a higher CPU priority than the rest (downloads keep running, only slower).
 * Each IPC call of those features runs inside a "focus" context; every process started
 * inside that context belongs to the feature.
 * -------------------------------------------------------------------------- */
const focusContext = new AsyncLocalStorage();
const trackedProcs = new Set(); // { child, kind, url, focus, feature, tier, level }
let focusActive = false;
let focusTimer = null;
let focusedFeature = ""; // the feature the person has open right now ("quality", "playlist", "trim")
let focusedUrl = ""; // the link it was opened for

const inFocusContext = () => !!focusContext.getStore()?.focus;

/** Which feature each IPC channel belongs to. */
const FEATURE_OF_CHANNEL = {
  "fetch-quick-info": "quality",
  "fetch-media-info": "quality",
  "fetch-playlist-items": "playlist",
  "fetch-playlist-summary": "playlist",
  "find-video-playlist": "playlist",
  "stream-open": "trim",
  "stream-chunk": "trim",
  "stream-tiles": "trim",
  "stream-prefetch": "trim",
  "prepare-preview": "trim",
};

/**
 * Runs `fn` so that every process it starts carries a tier:
 *   "boost": the app's own first look at a link (default quality): it goes ahead of the rest
 *            until the person opens another feature;
 *   "low":   the app's own background lookups: they never slow down the first look.
 * `feature` says which feature the work belongs to (see focusFeature).
 */
function withTier(tier, feature, fn) {
  return focusContext.run({ ...(focusContext.getStore() || {}), tier, feature }, fn);
}

/**
 * How much CPU a process gets:
 *  - a feature is open: its processes go up, everything else goes down;
 *  - no feature open: the first look at a link goes up, background lookups go down.
 */
function wantedLevel(entry) {
  if (focusedFeature) {
    const mine = entry.feature
      ? entry.feature === focusedFeature && (!entry.url || !focusedUrl || sameLink(entry.url, focusedUrl))
      : entry.focus;
    return mine ? "above" : "below";
  }
  if (entry.tier === "boost") return "above";
  if (entry.tier === "low") return "below";
  if (!focusActive) return "normal";
  return entry.focus ? "above" : "below";
}

function applyPriority(entry, atSpawn = false) {
  const pid = entry.child && entry.child.pid;
  if (!pid) return;
  const P = os.constants.priority;
  const want = wantedLevel(entry);
  if (entry.level === want || (atSpawn && want === "normal")) return;
  entry.level = want;
  const value =
    want === "below"
      ? P.PRIORITY_BELOW_NORMAL
      : want === "above"
        ? P.PRIORITY_ABOVE_NORMAL
        : P.PRIORITY_NORMAL;
  try {
    os.setPriority(pid, value); // raising can be refused without rights: harmless
  } catch {}
}

/**
 * Called right after a process is started.
 * kind "download": a download in the queue (it slows down while a feature is in use).
 * url: the link the process works on.
 */
function trackProc(child, { kind = "work", url = "" } = {}) {
  if (!child || !child.pid) return;
  const store = focusContext.getStore() || {};
  const entry = {
    child,
    kind,
    url,
    focus: !!store.focus,
    feature: store.feature || "",
    tier: store.tier || "",
    level: "normal",
  };
  trackedProcs.add(entry);
  child.once("close", () => trackedProcs.delete(entry));
  applyPriority(entry, true);
}

const sameLink = (a, b) =>
  normalizeUrl(a) === normalizeUrl(b) ||
  normalizeUrl(a, { playlist: true }) === normalizeUrl(b, { playlist: true });

function setFocusActive(on) {
  if (focusActive === on) return;
  focusActive = on;
  if (!on) {
    focusedFeature = "";
    focusedUrl = "";
  }
  for (const entry of trackedProcs) applyPriority(entry);
}

function beginFocus() {
  setFocusActive(true);
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => setFocusActive(false), FOCUS_HOLD_MS);
}

/** The renderer says which feature the person just opened (name "" = all closed). */
function focusFeature(name, url) {
  if (!name) {
    // Nothing is open any more: the downloads go back to full speed at once
    focusedFeature = "";
    focusedUrl = "";
    clearTimeout(focusTimer);
    setFocusActive(false);
    for (const entry of trackedProcs) applyPriority(entry);
    return;
  }
  // The feature being opened takes the front; whatever the previous one was still doing yields
  focusedFeature = name;
  focusedUrl = String(url || "");
  beginFocus();
  for (const entry of trackedProcs) applyPriority(entry);
}

/** Wraps an IPC handler of a feature channel so everything it starts runs in the focus context. */
function focusWrap(fn, channel = "") {
  const feature = FEATURE_OF_CHANNEL[channel] || "";
  return (...args) => {
    // A call marked { background: true } is work the app started by itself: it must not count
    // as the person using a feature, and it never slows down the first look at a link.
    const background = args.some((a) => a && typeof a === "object" && a.background === true);
    if (background) return focusContext.run({ focus: false, tier: "low", feature }, () => fn(...args));
    beginFocus();
    return focusContext.run({ focus: true, feature }, () => fn(...args));
  };
}

let workingCookieBrowser = null;

// remembered after the first one that works

/** Browsers to try, in order: the one chosen in app-prefs.json, the last working one, the rest. */
function cookieCandidates() {
  const list = [];
  const add = (b) => b && !list.includes(b) && list.push(b);
  add(appPrefs.cookiesBrowser);
  add(workingCookieBrowser);
  if (!appPrefs.cookiesBrowser) COOKIE_BROWSERS.forEach(add);
  return list;
}

/** Cookie flags to put in front of a YouTube call when a session is known to work. */
function knownCookieArgs(argsOrUrl) {
  const hit = Array.isArray(argsOrUrl)
    ? argsOrUrl.some((a) => IS_YOUTUBE_URL.test(String(a)))
    : IS_YOUTUBE_URL.test(String(argsOrUrl));
  if (!hit) return [];
  if (appPrefs.cookiesFile) return ["--cookies", appPrefs.cookiesFile];
  const b = appPrefs.cookiesBrowser || workingCookieBrowser;
  return b ? ["--cookies-from-browser", b] : [];
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  if (isWin) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
  } else {
    child.kill("SIGKILL");
  }
}

/** Analysis timings go to the same downloads.log file as the downloads (shows where slow calls spend their time). */
function logTiming(line) {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "downloads.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function runYtDlpOnce(args, timeoutMs = 0, handle = null, onStdout = null) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    let timer = null;

    try {
      child = spawn(getBinPaths().ytDlp, args, {
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      });
      trackProc(child, { url: String(args.find((a) => /^https?:\/\//i.test(String(a))) || "") });
    } catch (err) {
      resolve({ code: -1, stdout, stderr: err.message });
      return;
    }

    // A cancel returns to the caller immediately; it does not wait for the process tree to exit
    if (handle)
      handle.kill = () => {
        if (timer) clearTimeout(timer);
        killProcessTree(child);
        resolve({ code: -1, stdout: "", stderr: "Cancelled" });
      };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killProcessTree(child);
        resolve({ code: -1, stdout, stderr: "Process timed out" });
      }, timeoutMs);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdout += d;
      if (onStdout) onStdout(d);
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * yt-dlp, with one more try over IPv4 only when the connection broke off (a broken IPv6
 * route is a common reason a site cannot be reached). A DNS failure, a cancel, our own
 * timeout or an answer that already started to arrive are returned as they are.
 */
async function runYtDlp(args, timeoutMs = 0, handle = null, onStdout = null) {
  // A YouTube session that already worked once goes along from the start
  if (!args.includes("--cookies-from-browser") && !args.includes("--cookies"))
    args = [...args, ...knownCookieArgs(args)];
  const t0 = Date.now();
  const first = await runYtDlpOnce(args, timeoutMs, handle, onStdout);
  // timing for the console: where the time of a slow call went
  const timing = `[yt-dlp] ${((Date.now() - t0) / 1000).toFixed(1)}s code=${first.code} focus=${inFocusContext()} ${String(args[0]).slice(0, 80)}`;
  console.log(timing);
  logTiming(timing);
  if (first.code === 0 || first.stdout) return first;
  // "Sign in to confirm you're not a bot": borrow a signed-in browser session, one by one
  if (
    BOT_ERROR.test(first.stderr) &&
    !args.includes("--cookies-from-browser") &&
    !args.includes("--cookies")
  ) {
    for (const browser of cookieCandidates()) {
      if (handle && handle.cancelled) break;
      const res = await runYtDlpOnce(
        [...args, "--cookies-from-browser", browser],
        timeoutMs,
        handle,
        onStdout,
      );
      if (res.code === 0) {
        workingCookieBrowser = browser;
        return res;
      }
      if (res.stderr === "Cancelled") return res;
    }
    return first;
  }
  if (args.includes("--force-ipv4")) return first;
  if (first.stderr === "Cancelled" || first.stderr === "Process timed out") return first;
  if (DNS_ERROR.test(first.stderr) || !CONNECT_ERROR.test(first.stderr)) return first;
  return runYtDlpOnce([...args, "--force-ipv4"], timeoutMs, handle, onStdout);
}

const setWorkingCookieBrowser = (browser) => {
  workingCookieBrowser = browser;
};

module.exports = {
  cookieCandidates,
  focusFeature,
  focusWrap,
  inFocusContext,
  killProcessTree,
  knownCookieArgs,
  runYtDlp,
  setWorkingCookieBrowser,
  trackProc,
  withTier,
};
