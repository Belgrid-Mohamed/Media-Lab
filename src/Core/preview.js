const fs = require("fs");
const { ReadableStream } = require("stream/web");
const crypto = require("crypto");
const path = require("path");
const { CACHE_TTL_MS, MAX_FULL_PREVIEWS_AT_ONCE, MAX_PREVIEW_FILES, PREVIEW_HEAD_SECONDS, PREVIEW_HEIGHTS, previewDir } = require("./config");
const { createLimiter, normalizeUrl, sanitizeProxy } = require("./utils");
const { fetchMediaInfo, rawInfoFiles } = require("./link-info");
const { engine, getBinPaths, getExtractorFlags } = require("./binaries-manager");
const { runYtDlp } = require("./process-control");
const { send } = require("./window");

/** --------------------------------------------------------------------------
 * VIDEO PREVIEW (trim popover player)
 * The player loads mbpreview://<random id>/v. Only ids created by this process are
 * served (see LOCAL PREVIEW FILE), so the page can never read arbitrary files.
 * -------------------------------------------------------------------------- */
const previewSources = new Map();

// id -> { file }

async function handlePreviewRequest(request) {
  try {
    const source = previewSources.get(new URL(request.url).hostname);
    if (!source || !source.file)
      return new Response("Not found", { status: 404 });
    return serveLocalPreview(source.file, request.headers.get("range"));
  } catch {
    return new Response("Preview error", { status: 502 });
  }
}

const previewFiles = new Map();

// normalized link -> { id, file }
const previewJobs = new Map();


// one preview download at a time

function clearPreviewDir() {
  try {
    fs.rmSync(previewDir, { recursive: true, force: true });
  } catch {}
}

/** Custom yt-dlp options from Settings, minus the ones that would run programs. */
function previewUserArgs(extra) {
  const out = [];
  const proxy = sanitizeProxy(extra && extra.proxyUrl);
  if (proxy) out.push("--proxy", proxy);
  const blocked =
    /^--(exec|exec-before-download|netrc-cmd|use-postprocessor|plugin-dirs|config-locations?)(=|$)/i;
  const tokens = String((extra && extra.extraArgs) || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (blocked.test(tokens[i])) {
      if (
        !tokens[i].includes("=") &&
        tokens[i + 1] &&
        !tokens[i + 1].startsWith("-")
      )
        i++;
      continue;
    }
    out.push(tokens[i]);
  }
  return out;
}

function serveLocalPreview(file, rangeHeader) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return new Response("Gone", { status: 404 });
  }
  const type = /\.webm$/i.test(file)
    ? "video/webm"
    : /\.mkv$/i.test(file)
      ? "video/x-matroska"
      : "video/mp4";
  let start = 0;
  let end = size - 1;
  let status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || ""));
  if (m && (m[1] || m[2])) {
    if (m[1] === "") {
      start = Math.max(0, size - Number(m[2])); // "last N bytes"
    } else {
      start = Number(m[1]);
      if (m[2]) end = Math.min(end, Number(m[2]));
    }
    if (start > end || start >= size) {
      return new Response("Range not satisfiable", {
        status: 416,
        headers: { "content-range": `bytes */${size}` },
      });
    }
    status = 206;
  }
  const headers = {
    "content-type": type,
    "accept-ranges": "bytes",
    "content-length": String(end - start + 1),
  };
  if (status === 206)
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
  return new Response(fileToWebStream(file, start, end), { status, headers });
}

/**
 * A byte range of a file as a web stream. The player often stops reading in the middle (it
 * jumped elsewhere): the stream then closes quietly instead of throwing "Controller is
 * already closed", which Readable.toWeb did and which ended up as an error box.
 */
function fileToWebStream(file, start, end) {
  const input = fs.createReadStream(file, { start, end });
  let finished = false;
  return new ReadableStream({
    start(controller) {
      const stop = () => {
        finished = true;
        input.destroy();
      };
      input.on("data", (chunk) => {
        if (finished) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
          if (controller.desiredSize <= 0) input.pause();
        } catch {
          stop(); // the reader is gone
        }
      });
      input.on("end", () => {
        if (finished) return;
        finished = true;
        try {
          controller.close();
        } catch {}
      });
      input.on("error", (err) => {
        if (finished) return;
        finished = true;
        try {
          controller.error(err);
        } catch {}
      });
    },
    pull() {
      if (!finished) input.resume();
    },
    cancel() {
      finished = true;
      input.destroy();
    },
  });
}

// "info|link" -> { file, at }
const previewHeads = new Map();

// key -> { id, file }
const previewHeadJobs = new Map();

// key -> Promise
const previewHandles = new Map();

const fullPreviewSlots = createLimiter(MAX_FULL_PREVIEWS_AT_ONCE);

/** The saved analysis of a link, waiting for the one in progress if needed ("" if none). */
async function previewInfoFile(url) {
  const key = `info|${normalizeUrl(url)}`;
  const fresh = (e) =>
    e && fs.existsSync(e.file) && Date.now() - e.at < CACHE_TTL_MS;
  let entry = rawInfoFiles.get(key);
  if (!fresh(entry)) {
    await fetchMediaInfo(url).catch(() => null); // joins the running analysis, or starts it
    entry = rawInfoFiles.get(key);
  }
  return fresh(entry) ? entry.file : "";
}

function trackPreviewHandle(url, handle, add) {
  let set = previewHandles.get(url);
  if (add) {
    if (!set) previewHandles.set(url, (set = new Set()));
    set.add(handle);
  } else if (set) {
    set.delete(handle);
    if (!set.size) previewHandles.delete(url);
  }
}

/** Turns yt-dlp's "[download]  42.0% ..." lines into one overall percentage. */
function previewProgressParser(onPercent) {
  let part = 0;
  let last = 0;
  let pending = "";
  return (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n|\r/);
    pending = lines.pop();
    for (const line of lines) {
      if (/^\[download\]\s+Destination:/.test(line)) {
        part++;
        continue;
      }
      const hit = /^\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
      if (!hit) continue;
      // the picture comes first and holds most of the bytes, then the sound
      const overall =
        part <= 1 ? Number(hit[1]) * 0.8 : 80 + Number(hit[1]) * 0.2;
      if (overall > last) {
        last = overall;
        onPercent(Math.min(99, Math.round(last)));
      }
    }
  };
}

/** One yt-dlp run that leaves a small mp4 in the temp folder. */
async function runPreviewJob(
  url,
  extra,
  {
    section = 0,
    range = null,
    handle: ownHandle = null,
    onPercent = null,
  } = {},
) {
  await engine.setup; // yt-dlp, ffmpeg and the JS runtime must be installed first
  fs.mkdirSync(previewDir, { recursive: true });
  const infoFile = await previewInfoFile(url);

  const attempt = async (useInfo) => {
    const id = crypto.randomBytes(8).toString("hex");
    const args = [
      ...(useInfo ? ["--load-info-json", infoFile] : [url]),
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "-f",
      "bv*+ba/b",
      // the smallest picture that still looks fine in a 360 px player (144p for long videos,
      // so the copy stays small), h264 + aac so every system plays it
      "-S",
      // the first seconds are capped at 360p so they arrive at once, whatever quality was chosen
      `res:${range ? previewHeight(extra) : section ? Math.min(previewHeight(extra), 360) : previewHeight(extra)},vcodec:h264,acodec:m4a,+size`,
      ...(range
        ? ["--download-sections", `*${range[0]}-${range[1]}`]
        : section
          ? ["--download-sections", `*0-${section}`]
          : ["--max-filesize", "250M"]),
      "--merge-output-format",
      "mp4",
      "--ffmpeg-location",
      getBinPaths().binDir,
      "-o",
      path.join(previewDir, `${id}.%(ext)s`),
      "--no-mtime",
      "--windows-filenames",
      "--encoding",
      "utf-8",
      "--concurrent-fragments",
      "4",
      ...getExtractorFlags(),
      ...previewUserArgs(extra),
    ];
    const handle = ownHandle || {};
    trackPreviewHandle(url, handle, true);
    let res;
    try {
      res = await runYtDlp(
        args,
        section || range ? 45000 : 240000,
        handle,
        onPercent ? previewProgressParser(onPercent) : null,
      );
    } finally {
      trackPreviewHandle(url, handle, false);
    }
    const name = fs
      .readdirSync(previewDir)
      .find((f) => f.startsWith(id) && !/\.part$|\.ytdl$|\.f\d+\./.test(f));
    return { id, name, res };
  };

  let out = await attempt(!!infoFile);
  // The saved analysis could not be used (old, odd site): ask yt-dlp about the link itself
  if (!out.name && infoFile && out.res.stderr !== "Cancelled")
    out = await attempt(false);
  if (!out.name) {
    const line = String(out.res.stderr || "")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .pop();
    return { error: line || "The preview could not be prepared" };
  }
  return { id: out.id, file: path.join(previewDir, out.name) };
}

function forgetOldPreviews(map) {
  while (map.size > MAX_PREVIEW_FILES) {
    const [oldKey, old] = map.entries().next().value;
    map.delete(oldKey);
    previewSources.delete(old.id);
    try {
      fs.unlinkSync(old.file);
    } catch {}
  }
}

/** The first seconds only: ready in a moment, and the player starts with them. */
function ensureHeadPreview(url, key, extra) {
  const ready = previewHeads.get(key);
  if (ready && fs.existsSync(ready.file)) {
    previewSources.set(ready.id, { file: ready.file });
    return Promise.resolve({
      id: ready.id,
      audio: true,
      local: true,
      partial: true,
      headSeconds: PREVIEW_HEAD_SECONDS,
    });
  }
  if (previewHeadJobs.has(key)) return previewHeadJobs.get(key);

  const job = runPreviewJob(url, extra, { section: PREVIEW_HEAD_SECONDS })
    .then((r) => {
      if (r.error) return r;
      previewSources.set(r.id, { file: r.file });
      previewHeads.set(key, { id: r.id, file: r.file });
      forgetOldPreviews(previewHeads);
      return {
        id: r.id,
        audio: true,
        local: true,
        partial: true,
        headSeconds: PREVIEW_HEAD_SECONDS,
      };
    })
    .catch((err) => ({ error: err.message }))
    .finally(() => previewHeadJobs.delete(key));
  previewHeadJobs.set(key, job);
  return job;
}

/** The whole small copy, in the background; the window is told how far it is and when it is done. */
function ensureFullPreview(url, key, extra) {
  const ready = previewFiles.get(key);
  if (ready && fs.existsSync(ready.file)) {
    previewSources.set(ready.id, { file: ready.file });
    return Promise.resolve({ id: ready.id, audio: true, local: true });
  }
  if (previewJobs.has(key)) return previewJobs.get(key);

  const height = PREVIEW_HEIGHTS.includes(Number(extra.height))
    ? Number(extra.height)
    : 0;
  let lastSent = 0;
  let lastPercent = -1;
  const reportProgress = (percent) => {
    const now = Date.now();
    if (percent === lastPercent || now - lastSent < 200) return;
    lastPercent = percent;
    lastSent = now;
    send("preview-progress", { url, height, percent });
  };

  const job = (async () => {
    await fullPreviewSlots.acquire();
    try {
      const r = await runPreviewJob(url, extra, { onPercent: reportProgress });
      if (r.error) return r;
      previewSources.set(r.id, { file: r.file });
      previewFiles.set(key, { id: r.id, file: r.file });
      forgetOldPreviews(previewFiles);
      send("preview-ready", { url, height, id: r.id });
      return { id: r.id, audio: true, local: true };
    } finally {
      fullPreviewSlots.release();
    }
  })()
    .catch((err) => ({ error: err.message }))
    .finally(() => previewJobs.delete(key));
  previewJobs.set(key, job);
  return job;
}

function previewHeight(extra) {
  const wanted = Number(extra && extra.height);
  if (PREVIEW_HEIGHTS.includes(wanted)) return wanted;
  return Number(extra && extra.duration) > 1200 ? 144 : 240;
}

function preparePreviewFile(url, extra) {
  const wanted = Number(extra && extra.height);
  const key = PREVIEW_HEIGHTS.includes(wanted)
    ? `${normalizeUrl(url)}|${wanted}`
    : normalizeUrl(url);

  // already complete: nothing to wait for
  const ready = previewFiles.get(key);
  if (ready && fs.existsSync(ready.file))
    return ensureFullPreview(url, key, extra);

  const full = ensureFullPreview(url, key, extra); // keeps going in the background
  const tiny =
    Number(extra.duration) > 0 &&
    Number(extra.duration) <= PREVIEW_HEAD_SECONDS + 3;
  if (extra.head === false || tiny) return full; // a quality switch, or a very short video

  // Whichever is ready first starts the player: normally the first seconds
  const head = ensureHeadPreview(url, key, extra);
  return new Promise((resolve) => {
    let left = 2;
    let firstError = null;
    const done = (r) => {
      if (r && r.id) return resolve(r);
      firstError = firstError || r;
      if (--left === 0)
        resolve(firstError || { error: "The preview could not be prepared" });
    };
    head.then(done, (err) => done({ error: err.message }));
    full.then(done, (err) => done({ error: err.message }));
  });
}

/** The link was changed or cleared: stop its preview downloads (they would only waste bandwidth). */
function cancelPreview(url) {
  const set = previewHandles.get(url);
  if (!set) return;
  for (const handle of [...set]) if (handle.kill) handle.kill();
  previewHandles.delete(url);
}

module.exports = {
  cancelPreview,
  clearPreviewDir,
  handlePreviewRequest,
  preparePreviewFile,
  previewInfoFile,
  runPreviewJob,
};
