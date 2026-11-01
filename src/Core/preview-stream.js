const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { spawn } = require("child_process");
const { createLimiter, normalizeUrl } = require("./utils");
const { CACHE_TTL_MS, FFMPEG_BASE, MAX_CHUNKS_AT_ONCE, MAX_CHUNK_FILES, MAX_STREAM_SESSIONS, MAX_TILES_AT_ONCE, PREVIEW_HEIGHTS, STREAM_FIRST, STREAM_MIME_AV, STREAM_MIME_V, TILE_COUNT, TILE_HEIGHT, previewDir } = require("./config");
const { engine, getBinPaths } = require("./binaries-manager");
const { previewInfoFile, runPreviewJob } = require("./preview");
const { killProcessTree, trackProc } = require("./process-control");
const { send } = require("./window");

/**
 * STREAMING PREVIEW (like an online player)
 * Nothing waits for a whole file. The player asks for the video in short pieces, as it needs
 * them: a few seconds to start, then a bigger piece whenever the buffer runs low. A jump to
 * another moment, or another quality, simply asks for the pieces from that point on.
 *
 * Each piece is cut straight from the stream addresses yt-dlp already found (ffmpeg, one short
 * call) and re-encoded small and uniform (h264 + aac, fragmented mp4), so every piece starts
 * exactly where it was asked to and any piece can follow any other, in any quality. If the
 * addresses can't be read directly, yt-dlp cuts the piece instead (it knows every site).
 * The window gets the pieces through IPC (stream-open / stream-chunk).
 */
const streamSessions = new Map();

// id -> session
const streamChunkJobs = new Map();

// piece key -> { promise, kill, waiters, cancelled }
const streamReqs = new Map();

const chunkFiles = [];

// { file, sid }, oldest first
const chunkSlots = createLimiter(MAX_CHUNKS_AT_ONCE);

const streamByUrl = new Map();

// link -> session id
const streamOpening = new Map();

// seconds in the first piece (start, jump, quality change)

function cancelTilesJob(job) {
  if (!job) return;
  job.cancelled = true;
  for (const kill of job.kills) kill();
}

function closeStreamSession(id) {
  const session = streamSessions.get(id);
  if (!session) return;
  streamSessions.delete(id);
  if (streamByUrl.get(session.urlKey) === id)
    streamByUrl.delete(session.urlKey);
  cancelTilesJob(session.tiles);
  for (const [key, job] of streamChunkJobs) {
    if (key.startsWith(`${id}|`)) {
      job.cancelled = true;
      if (job.kill) job.kill();
    }
  }
  for (let i = chunkFiles.length - 1; i >= 0; i--) {
    if (chunkFiles[i].sid !== id) continue;
    try {
      fs.unlinkSync(chunkFiles[i].file);
    } catch {}
    chunkFiles.splice(i, 1);
  }
}

function streamSummary(s) {
  return {
    id: s.id,
    duration: s.duration,
    heights: s.heights,
    mime: s.hasAudio ? STREAM_MIME_AV : STREAM_MIME_V,
    startHeight: s.startHeight,
    first: STREAM_FIRST,
  };
}

/** A session per link: the background warm-up and the window end up with the same one. */
function openPreviewStream(url) {
  const urlKey = normalizeUrl(url);
  const known = streamSessions.get(streamByUrl.get(urlKey));
  if (known && Date.now() - known.created < CACHE_TTL_MS)
    return Promise.resolve(streamSummary(known));
  if (streamOpening.has(urlKey)) return streamOpening.get(urlKey);
  const job = buildPreviewStream(url, urlKey).finally(() =>
    streamOpening.delete(urlKey),
  );
  streamOpening.set(urlKey, job);
  return job;
}

/** Reads the saved analysis of a link and opens a session: length, qualities, codec string. */
async function buildPreviewStream(url, urlKey) {
  await engine.setup;
  const infoFile = await previewInfoFile(url);
  if (!infoFile) return { error: "No analysis of this link" };
  let info;
  try {
    info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
  } catch {
    return { error: "Unreadable analysis" };
  }
  if (info.is_live || info.live_status === "is_live")
    return { error: "Live stream" };
  const duration = Number(info.duration) || 0;
  if (!(duration > 1)) return { error: "Unknown length" };

  const formats = Array.isArray(info.formats) ? info.formats : [];
  const direct = (f) =>
    f &&
    /^https?:\/\//i.test(f.url || "") &&
    /^(https?|m3u8(_native)?)$/i.test(f.protocol || "https");
  const videos = formats.filter(
    (f) => direct(f) && f.vcodec && f.vcodec !== "none" && Number(f.height) > 0,
  );
  const audios = formats.filter(
    (f) =>
      direct(f) &&
      f.acodec &&
      f.acodec !== "none" &&
      (!f.vcodec || f.vcodec === "none"),
  );
  if (!videos.length) return { error: "No picture to stream" };
  const maxHeight = Math.max(...videos.map((f) => Number(f.height)));
  const heights = PREVIEW_HEIGHTS.filter((h) => h <= maxHeight);
  if (!heights.length) heights.push(PREVIEW_HEIGHTS[0]);
  const hasAudio =
    audios.length > 0 || videos.some((f) => f.acodec && f.acodec !== "none");
  // opens at a modest quality so it starts at once (the menu offers the rest)
  const wanted = duration > 1200 ? 240 : 360;
  const startHeight = heights.filter((h) => h <= wanted).pop() || heights[0];

  while (streamSessions.size >= MAX_STREAM_SESSIONS)
    closeStreamSession(streamSessions.keys().next().value);
  const id = crypto.randomBytes(8).toString("hex");
  const session = {
    id,
    url,
    urlKey,
    created: Date.now(),
    duration,
    videos,
    audios,
    hasAudio,
    heights,
    startHeight,
    headers: info.http_headers || {},
    tiles: null,
  };
  streamSessions.set(id, session);
  streamByUrl.set(urlKey, id);
  return streamSummary(session);
}

/** The video and audio streams that make a piece at about `height` (the nearest not above it). */
function pickStreamsFor(session, height) {
  const below = session.videos.filter((f) => Number(f.height) <= height);
  const target = below.length
    ? Math.max(...below.map((f) => Number(f.height)))
    : Math.min(...session.videos.map((f) => Number(f.height)));
  const isAvc = (f) => (/^avc1/i.test(f.vcodec || "") ? 1 : 0);
  const video = session.videos
    .filter((f) => Number(f.height) === target)
    .sort(
      (a, b) =>
        isAvc(b) - isAvc(a) ||
        (b.ext === "mp4") - (a.ext === "mp4") ||
        (Number(a.tbr) || 1e9) - (Number(b.tbr) || 1e9),
    )[0];
  const muxed = !!(video.acodec && video.acodec !== "none");
  let audio = null;
  if (!muxed && session.audios.length) {
    audio = session.audios
      .slice()
      .sort(
        (a, b) =>
          (b.ext === "m4a") - (a.ext === "m4a") ||
          (Number(a.abr) || 1e9) - (Number(b.abr) || 1e9),
      )[0];
  }
  return { video, audio, muxed };
}

function headerArgs(session, format) {
  const all = { ...session.headers, ...(format.http_headers || {}) };
  const text = Object.entries(all)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return text ? ["-headers", `${text}\r\n`] : [];
}

function runFfmpeg(args, job, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(getBinPaths().ffmpeg, args, { windowsHide: true });
      trackProc(child);
    } catch (err) {
      return resolve({ code: -1, stderr: err.message });
    }
    job.kill = () => killProcessTree(child);
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    const timer = setTimeout(() => killProcessTree(child), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/** What every piece is encoded as: small, uniform, and playable piece after piece. */
function pieceEncodeArgs(height, hasAudio) {
  return [
    "-vf",
    `scale=-2:${height},format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "30",
    "-g",
    "30",
    "-profile:v",
    "baseline", // (constrained baseline = avc1.42c028, as declared to the player)
    "-level",
    "4.0",
    ...(hasAudio
      ? ["-c:a", "aac", "-b:a", "64k", "-ac", "2", "-ar", "44100"]
      : ["-an"]),
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
  ];
}

function videoEncodeArgs(height) {
  return [
    "-vf",
    `scale=-2:${height},format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "30",
    "-g",
    "30",
    "-profile:v",
    "baseline",
    "-level",
    "4.0",
    "-an",
  ];
}

const audioEncodeArgs = () => [
  "-vn",
  "-c:a",
  "aac",
  "-b:a",
  "64k",
  "-ac",
  "2",
  "-ar",
  "44100",
];

async function produceChunk(session, height, start, dur, job) {
  const began = Date.now();
  fs.mkdirSync(previewDir, { recursive: true });
  const file = path.join(
    previewDir,
    `chunk-${session.id}-${height}-${Math.round(start * 1000)}-${Math.round(dur * 1000)}.mp4`,
  );
  const size = (f) => {
    try {
      return fs.statSync(f).size;
    } catch {
      return 0;
    }
  };
  const clean = (...files) => {
    for (const f of files) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  };
  if (size(file) > 0) return file;
  const part = `${file}.part`;
  const finish = (how) => {
    fs.renameSync(part, file);
    chunkFiles.push({ file, sid: session.id });
    while (chunkFiles.length > MAX_CHUNK_FILES) clean(chunkFiles.shift().file);
    console.log(
      `[stream] ${height}p ${start.toFixed(1)}s +${dur.toFixed(1)}s ready in ${((Date.now() - began) / 1000).toFixed(1)}s (${how})`,
    );
    return file;
  };

  const { video, audio } = pickStreamsFor(session, height);
  const outHeight = Math.min(height, Number(video.height) || height);
  // ffmpeg's defaults probe several megabytes of every address before it starts: far too slow
  // for a few seconds of video, so the probe is kept small (and the connection reused)
  const fast = [
    "-probesize",
    "262144",
    "-analyzeduration",
    "500000",
    "-multiple_requests",
    "1",
  ];
  const open = (f, flags) => [
    ...flags,
    "-rw_timeout",
    "15000000",
    ...headerArgs(session, f),
    "-ss",
    String(start),
    "-i",
    f.url,
  ];

  // 1. straight from the stream addresses. Picture and sound live at different addresses:
  //    they are cut at the same time, then joined without re-encoding.
  const direct = async (flags) => {
    if (!(audio && session.hasAudio)) {
      const args = [
        ...FFMPEG_BASE,
        ...open(video, flags),
        "-t",
        String(dur),
        "-map",
        "0:v:0",
        ...(session.hasAudio ? ["-map", "0:a:0?"] : []),
        ...pieceEncodeArgs(outHeight, session.hasAudio),
        part,
      ];
      const r = await runFfmpeg(args, job);
      return r.code === 0 && size(part) > 0;
    }
    // One ffmpeg for picture and sound together: one start-up instead of three (two cuts and
    // a join). If it fails, the three-step way below is the fallback.
    const together = await runFfmpeg(
      [
        ...FFMPEG_BASE,
        ...open(video, flags),
        ...open(audio, flags),
        "-t",
        String(dur),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        ...pieceEncodeArgs(outHeight, true),
        part,
      ],
      job,
    );
    if (together.code === 0 && size(part) > 0) return true;
    clean(part);
    if (job.cancelled) return false;
    const vPart = `${file}.v.part`;
    const aPart = `${file}.a.part`;
    const jv = { kill: null };
    const ja = { kill: null };
    job.kill = () => {
      if (jv.kill) jv.kill();
      if (ja.kill) ja.kill();
    };
    const [rv, ra] = await Promise.all([
      runFfmpeg(
        [
          ...FFMPEG_BASE,
          ...open(video, flags),
          "-t",
          String(dur),
          "-map",
          "0:v:0",
          ...videoEncodeArgs(outHeight),
          "-f",
          "mp4",
          vPart,
        ],
        jv,
      ),
      runFfmpeg(
        [
          ...FFMPEG_BASE,
          ...open(audio, flags),
          "-t",
          String(dur),
          "-map",
          "0:a:0",
          ...audioEncodeArgs(),
          "-f",
          "mp4",
          aPart,
        ],
        ja,
      ),
    ]);
    let ok = false;
    if (
      rv.code === 0 &&
      ra.code === 0 &&
      size(vPart) > 0 &&
      size(aPart) > 0 &&
      !job.cancelled
    ) {
      const joined = await runFfmpeg(
        [
          ...FFMPEG_BASE,
          "-i",
          vPart,
          "-i",
          aPart,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c",
          "copy",
          "-movflags",
          "frag_keyframe+empty_moov+default_base_moof",
          "-f",
          "mp4",
          part,
        ],
        job,
      );
      ok = joined.code === 0 && size(part) > 0;
    }
    clean(vPart, aPart);
    return ok;
  };

  for (const flags of [fast, []]) {
    // (the second try is the same without the speed-ups, should this ffmpeg not know one)
    if (await direct(flags))
      return finish(flags === fast ? "direct" : "direct, plain options");
    clean(part);
    if (job.cancelled) throw new Error("Cancelled");
  }

  // 2. yt-dlp cuts the section (it copes with every site's quirks), the same encode follows
  const handle = {};
  job.kill = () => handle.kill && handle.kill();
  const cut = await runPreviewJob(
    session.url,
    { height },
    { range: [start, start + dur + 0.5], handle },
  );
  if (job.cancelled) {
    if (cut.file) clean(cut.file);
    throw new Error("Cancelled");
  }
  if (cut.error) throw new Error(cut.error);
  const encode = [
    ...FFMPEG_BASE,
    "-i",
    cut.file,
    "-t",
    String(dur),
    ...pieceEncodeArgs(height, session.hasAudio),
    part,
  ];
  const r = await runFfmpeg(encode, job);
  clean(cut.file);
  if (r.code === 0 && size(part) > 0) return finish("yt-dlp");
  clean(part);
  throw new Error(
    String(r.stderr || "")
      .trim()
      .split(/\r?\n/)
      .pop() || "The piece could not be made",
  );
}

function startChunkJob(key, session, height, start, dur) {
  const job = { kill: null, waiters: 0, cancelled: false, promise: null };
  job.promise = (async () => {
    await chunkSlots.acquire();
    try {
      if (job.cancelled) throw new Error("Cancelled");
      return await produceChunk(session, height, start, dur, job);
    } finally {
      chunkSlots.release();
    }
  })().finally(() => {
    if (streamChunkJobs.get(key) === job) streamChunkJobs.delete(key);
  });
  job.promise.catch(() => {}); // an unwanted piece that fails must not be an unhandled rejection
  streamChunkJobs.set(key, job);
  return job;
}

/** What the window may ask for, made safe; null if there is nothing left to make. */
function normalizeChunkRequest(session, o) {
  const opts = o || {};
  const height = PREVIEW_HEIGHTS.includes(Number(opts.height))
    ? Number(opts.height)
    : session.startHeight;
  const start = Math.min(
    Math.max(0, Number(opts.start) || 0),
    Math.max(0, session.duration - 0.5),
  );
  const dur = Math.min(
    60,
    Math.max(1, Number(opts.dur) || STREAM_FIRST),
    session.duration - start + 0.001,
  );
  return dur > 0.4 ? { height, start, dur } : null;
}

function getChunkJob(session, req) {
  const key = `${session.id}|${req.height}|${req.start.toFixed(3)}|${req.dur.toFixed(3)}`;
  return (
    streamChunkJobs.get(key) ||
    startChunkJob(key, session, req.height, req.start, req.dur)
  );
}

/**
 * WARM-UP: the moment a link has been analysed (long before the trim window is opened) the
 * session is opened and the first piece is made, so the player has something to show at once.
 */
function prewarmPreviewStream(url) {
  openPreviewStream(url)
    .then((summary) => {
      const session = summary && streamSessions.get(summary.id);
      if (!session) return;
      const req = normalizeChunkRequest(session, {
        start: 0,
        dur: STREAM_FIRST,
      });
      // the first seconds and the timeline pictures start together: both are ready when the
      // scissors are clicked (the pictures no longer wait for the first piece)
      if (req) {
        getChunkJob(session, req)
          .promise.catch(() => {})
          .then(() => {
            // ... and then the second piece, so playing right after the click does not wait
            // for it (the player asks for this very piece next: 4 s, from where the first ends)
            const next = normalizeChunkRequest(session, {
              start: req.start + req.dur,
              dur: 4,
            });
            if (next) getChunkJob(session, next).promise.catch(() => {});
          });
      }
      ensureTiles(session);
    })
    .catch(() => {});
}

// small one-frame jobs: more at once fills the strip sooner
const tileSlots = createLimiter(MAX_TILES_AT_ONCE);

function runFfmpegImage(args, job, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(getBinPaths().ffmpeg, args, { windowsHide: true });
      trackProc(child);
    } catch {
      return resolve({ code: -1, image: Buffer.alloc(0) });
    }
    const kill = () => killProcessTree(child);
    job.kills.add(kill);
    const parts = [];
    child.stdout.on("data", (d) => parts.push(d));
    child.stderr.resume();
    const timer = setTimeout(kill, timeoutMs);
    const end = (code) => {
      clearTimeout(timer);
      job.kills.delete(kill);
      resolve({ code, image: Buffer.concat(parts) });
    };
    child.on("error", () => end(-1));
    child.on("close", end);
  });
}

function startTilesJob(session, count, tileHeight) {
  const job = {
    count,
    tileHeight,
    done: new Map(),
    cancelled: false,
    kills: new Set(),
    failures: 0,
    reported: false,
  };
  // the smallest picture there is: a thumbnail needs nothing more, and it is the quickest to reach
  const source = session.videos
    .slice()
    .sort(
      (a, b) =>
        Number(a.height) - Number(b.height) ||
        (Number(a.tbr) || 1e9) - (Number(b.tbr) || 1e9),
    )[0];

  const makeTile = async (index) => {
    await tileSlots.acquire();
    try {
      if (job.cancelled) return;
      const at = ((index + 0.5) / count) * session.duration;
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-probesize",
        "262144",
        "-analyzeduration",
        "500000",
        "-multiple_requests",
        "1",
        "-rw_timeout",
        "15000000",
        ...headerArgs(session, source),
        "-noaccurate_seek", // the nearest keyframe is as good as any frame for a thumbnail
        "-ss",
        String(at),
        "-i",
        source.url,
        "-frames:v",
        "1",
        "-vf",
        `scale=-2:${tileHeight}`,
        "-q:v",
        "6",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ];
      const r = await runFfmpegImage(args, job);
      if (job.cancelled) return;
      if (r.code === 0 && r.image.length > 200) {
        const data = r.image.toString("base64");
        job.done.set(index, data);
        send("stream-tile", { id: session.id, index, count, data });
      } else if (++job.failures >= 3 && !job.done.size && !job.reported) {
        job.reported = true; // the window then draws the strip another way
        send("stream-tile", { id: session.id, failed: true });
      }
    } finally {
      tileSlots.release();
    }
  };
  // Coarse to fine: the start and the middle first, then the gaps. The whole strip is covered
  // after a few pictures (the window shows the nearest one for each slice) and then sharpens.
  const order = [];
  for (let step = Math.max(1, Math.floor(count / 2)); ; step = Math.floor(step / 2)) {
    for (let i = 0; i < count; i += step) if (!order.includes(i)) order.push(i);
    if (step === 1) break;
  }
  for (const i of order) makeTile(i).catch(() => {}); // a few at a time, in this order
  return job;
}

function ensureTiles(session) {
  if (!session.tiles)
    session.tiles = startTilesJob(session, TILE_COUNT, TILE_HEIGHT);
  return session.tiles;
}

/**
 * The pointer rests over a moment of the timeline: its first seconds start being made, so a
 * click there shows at once. Only the latest guess is kept going (an older one that nobody is
 * waiting for is stopped), so guesses never hold up a piece the player really needs.
 */
let hintJob = null;

/** --- calls from the player (one function each, so the IPC layer stays thin) --- */
const streamKey = (session, req) =>
  `${session.id}|${req.height}|${req.start.toFixed(3)}|${req.dur.toFixed(3)}`;

async function readStreamChunk(id, opts) {
  const session = streamSessions.get(id);
  if (!session) return { error: "Unknown session" };
  const req = normalizeChunkRequest(session, opts);
  if (!req) return { error: "Beyond the end" };
  const job = getChunkJob(session, req);
  const reqId = opts && opts.req;
  job.waiters++;
  streamReqs.set(reqId, streamKey(session, req));
  try {
    return await fs.promises.readFile(await job.promise);
  } catch (err) {
    return { error: err.message };
  } finally {
    job.waiters--;
    streamReqs.delete(reqId);
  }
}

/** Filmstrip pictures: sent one by one as they are ready (pictures already made are sent again at once). */
function startStreamTiles(id) {
  const session = streamSessions.get(id);
  if (!session) return { error: "Unknown session" };
  const started = !!session.tiles;
  const job = ensureTiles(session);
  if (started) {
    for (const [index, data] of job.done) send("stream-tile", { id, index, count: TILE_COUNT, data });
  }
  return { ok: true, count: TILE_COUNT };
}

function stopJob(job) {
  job.cancelled = true;
  if (job.kill) job.kill();
}

/** The player no longer needs a piece (it jumped elsewhere): stop making it. */
function cancelStreamChunk(reqId) {
  const key = streamReqs.get(reqId);
  const job = key && streamChunkJobs.get(key);
  if (job && job.waiters <= 1) stopJob(job);
}

/** The player will probably ask for this piece next: start it, and drop the previous guess. */
function prefetchStreamChunk(id, opts) {
  const session = streamSessions.get(id);
  if (!session) return;
  const req = normalizeChunkRequest(session, opts);
  if (!req) return;
  const key = streamKey(session, req);
  if (hintJob && hintJob.key !== key && hintJob.job.waiters === 0) {
    stopJob(hintJob.job);
    if (streamChunkJobs.get(hintJob.key) === hintJob.job) streamChunkJobs.delete(hintJob.key);
  }
  hintJob = { key, job: getChunkJob(session, req) };
}

module.exports = {
  cancelStreamChunk,
  closeStreamSession,
  openPreviewStream,
  prefetchStreamChunk,
  prewarmPreviewStream,
  readStreamChunk,
  startStreamTiles,
};
