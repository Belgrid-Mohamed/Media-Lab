const https = require("https");
const { BOT_ERROR, CACHE_TTL_MS, CONNECT_ERROR, DNS_ERROR, TRACKING_PARAMS } = require("./config");

function versionAtLeast(version, min) {
  const a = String(version)
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const b = String(min)
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

/** --------------------------------------------------------------------------
 * METADATA IN-MEMORY CACHE & FAST OEMBED EXTRACTOR (< 200ms)
 * -------------------------------------------------------------------------- */
const metadataCache = new Map();

/**
 * Stable cache key for a link. Different spellings of the same YouTube video
 * (youtu.be/ID, watch?v=ID&t=30s, shorts/ID, m.youtube.com...) share one key, so a
 * prefetch started for one is reused for the others. Video ids are case-sensitive,
 * so nothing here is lowercased except the host. Playlists keep their `list` id.
 */
function normalizeUrl(url, { playlist = false } = {}) {
  const raw = String(url || "").trim();
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
    if (!playlist) {
      let id = "";
      if (host === "youtube.com" || host === "music.youtube.com") {
        id =
          u.searchParams.get("v") ||
          (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/) ||
            [])[1] ||
          "";
      } else if (host === "youtu.be") {
        id = u.pathname.slice(1).split("/")[0];
      }
      if (/^[\w-]{11}$/.test(id)) return `yt:${id}`;
    }
    TRACKING_PARAMS.forEach((k) => u.searchParams.delete(k));
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return raw;
  }
}

function getCached(key) {
  if (!key) return null;
  const cached = metadataCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  metadataCache.delete(key);
  return null;
}

function setCached(key, data) {
  if (!key || !data || data.error) return;
  metadataCache.set(key, { data, timestamp: Date.now() });
  // Prefetching fills the cache in the background, so keep it bounded (oldest first)
  if (metadataCache.size > 300) {
    metadataCache.delete(metadataCache.keys().next().value);
  }
}

function fetchJson(url, timeoutMs = 1000, headers = {}) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get(url, { timeout: timeoutMs, headers }, (res) => {
        if (res.statusCode !== 200) return resolve(null);
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(null);
          }
        });
      });
    } catch {
      return resolve(null);
    }
    if (req) {
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
    }
  });
}

/** --------------------------------------------------------------------------
 * HELPERS & FORMAT PARSERS
 * -------------------------------------------------------------------------- */

function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes <= 0) return "";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    sizes.length - 1,
  );
  return (
    parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + " " + sizes[i]
  );
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return "";
  return formatBytes(bytesPerSec, 1) + "/s";
}

function formatEta(seconds) {
  if (seconds === null || seconds === undefined || seconds < 0) return "";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function toNum(v) {
  if (v === undefined || v === null || v === "" || v === "NA" || v === "None") {
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isValidHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** "Can't find www.example.com ..." in plain words, with yt-dlp's own line kept after it. */
function friendlyError(text) {
  const host = (String(text).match(/host='([^']+)'/) ||
    String(text).match(/resolve '([^']+)'/) ||
    [])[1];
  const site = host || "the site";
  if (/not a bot/i.test(text))
    return `YouTube is asking to confirm you're not a bot. Sign in to YouTube in Firefox, Edge or Chrome on this computer and try again (the app borrows that session automatically). · ${text}`;
  if (BOT_ERROR.test(text))
    return `This site wants you signed in. Sign in to it in Firefox, Edge or Chrome on this computer and try again (the app borrows that session automatically). · ${text}`;
  if (DNS_ERROR.test(text))
    return `Can't find ${site}: this network's DNS cannot look it up. Check your internet, VPN or DNS (for example 1.1.1.1 or 8.8.8.8). · ${text}`;
  if (CONNECT_ERROR.test(text))
    return `Can't connect to ${site}: check your internet, VPN or firewall. · ${text}`;
  return text;
}

function lastErrorLine(stderr) {
  const lines = String(stderr || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const err = [...lines].reverse().find((l) => l.startsWith("ERROR"));
  return friendlyError(err || lines[lines.length - 1] || "Download failed");
}

function sanitizeLang(code) {
  const c = String(code || "").toLowerCase();
  return /^[a-z]{2,3}$/.test(c) ? c : "";
}

/** Trim range from the renderer: seconds, 0 <= start < end. Returns null if invalid. */
function sanitizeTrim(t) {
  if (!t || typeof t !== "object") return null;
  const start = Math.floor(Number(t.start));
  const end = Math.ceil(Number(t.end));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end <= start) return null;
  // Always cut at the exact frame. A raw stream copy keeps the old duration and broken
  // timestamps in the file, so players showed the old length and stalled after the cut.
  return { start, end, exact: true };
}

function sanitizeSpeedLimit(v) {
  const t = String(v || "").trim();
  return /^\d+(\.\d+)?[KkMmGg]?$/.test(t) ? t : "";
}

function sanitizeProxy(v) {
  const t = String(v || "").trim();
  if (!t) return "";
  try {
    const u = new URL(t);
    return /^(https?|socks4a?|socks5h?):$/.test(u.protocol) ? t : "";
  } catch {
    return "";
  }
}

function parseJsonLine(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A counter of how many things may run at once. `acquire()` waits for a free place;
 * `acquire(true)` jumps ahead of the ones already waiting. Call `release()` when done.
 */
function createLimiter(max) {
  let active = 0;
  const waiting = [];
  return {
    acquire(urgent = false) {
      return new Promise((resolve) => {
        if (active < max) {
          active++;
          resolve();
        } else if (urgent) waiting.unshift(resolve);
        else waiting.push(resolve);
      });
    },
    release() {
      const next = waiting.shift();
      if (next) next(); // the place goes straight to the next one
      else active--;
    },
  };
}

module.exports = {
  createLimiter,
  fetchJson,
  formatBytes,
  formatEta,
  formatSpeed,
  getCached,
  isValidHttpUrl,
  lastErrorLine,
  metadataCache,
  normalizeUrl,
  parseJsonLine,
  sanitizeLang,
  sanitizeProxy,
  sanitizeSpeedLimit,
  sanitizeTrim,
  setCached,
  sleep,
  toNum,
  versionAtLeast,
};
