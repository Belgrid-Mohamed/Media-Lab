const { app } = require("electron");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { execFile, execFileSync, spawn } = require("child_process");
const { formatBytes, formatEta, formatSpeed, getCached, isValidHttpUrl, lastErrorLine, normalizeUrl, sanitizeLang, sanitizeProxy, sanitizeSpeedLimit, sanitizeTrim, sleep, toNum } = require("./utils");
const { send } = require("./window");
const { BOT_ERROR, CONNECT_ERROR, DNS_ERROR, MKV_FILE, MOV_FILE, PARTIAL_DIR_NAME, isWin } = require("./config");
const { getBinPaths, getExtractorFlags } = require("./binaries-manager");
const { ensurePrefetch, freshRawInfoFile, languageByUrl, parseOptions } = require("./link-info");
const { cookieCandidates, knownCookieArgs, setWorkingCookieBrowser, trackProc } = require("./process-control");
const { appPrefs } = require("./system");

/**
 * --sub-langs for the caption language setting. "auto" = the captions in the video's own
 * language (the uploader's track if there is one, otherwise YouTube's auto-generated
 * captions in that language), so one track is embedded without choosing a language.
 */
function pickSubtitleLangs(setting, info, languageHint) {
  const chosen = String(setting || "auto").toLowerCase();
  if (chosen === "all") return "all,-live_chat"; // every language the video has (not the chat)
  if (chosen !== "auto") return `${sanitizeLang(chosen) || "en"}.*`;

  const lang = String(
    (info && info.language) || languageHint || "",
  ).toLowerCase();
  const base = lang.split(/[-_]/)[0];
  const caps = info && info.captions;
  if (caps && (caps.manual.length || caps.auto.length)) {
    const same = (k) => {
      const x = k.toLowerCase();
      return !!base && (x === lang || x.split(/[-_]/)[0] === base);
    };
    const orig = (k) => /-orig$/i.test(k);
    const found =
      caps.manual.find((k) => k.toLowerCase() === lang) ||
      caps.manual.find(same) ||
      caps.auto.find((k) => orig(k) && (!base || same(k))) ||
      caps.auto.find(same) ||
      (!base ? caps.auto.find(orig) || caps.manual[0] : null);
    if (found) return found;
  }
  // Captions of this link aren't known yet: ask for the video's own language if we know it
  if (base && /^[a-z0-9]{2,8}$/.test(base)) return `${base},${base}-orig`;
  return ".*-orig";
}

/** --------------------------------------------------------------------------
 * DOWNLOAD EXECUTION & MONITORING
 * -------------------------------------------------------------------------- */

const running = new Map();

const finished = new Map();

function emitProgress(downloadId, job, payload) {
  const clean = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v !== undefined) clean[k] = v;
  }
  if (payload.title) job.title = payload.title;
  job.snapshot = { ...(job.snapshot || {}), ...clean };
  send("download-progress", { downloadId, ...clean });
}

/**
 * Where the unfinished files of a download live. Next to the download they would show up in
 * the person's folder, so they go to the app's own data folder whenever that is on the same
 * disk (the finished file is then moved into place at once, without copying). Only when the
 * download folder is on another disk do they stay in a hidden folder inside it.
 */
function partialDirFor(targetDir) {
  try {
    const base = path.join(app.getPath("userData"), "partial");
    fs.mkdirSync(base, { recursive: true });
    if (fs.statSync(base).dev === fs.statSync(targetDir).dev) {
      const id = crypto.createHash("sha1").update(path.resolve(targetDir)).digest("hex").slice(0, 12);
      return { dir: path.join(base, id), inside: false };
    }
  } catch {}
  return { dir: path.join(targetDir, PARTIAL_DIR_NAME), inside: true };
}

function ensurePartialDir(targetDir) {
  const { dir, inside } = partialDirFor(targetDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (inside && isWin) {
      // A leading dot is not enough on Windows: the folder is marked hidden and system
      // before yt-dlp writes anything, so it is never seen.
      try {
        execFileSync("attrib", ["+h", "+s", dir], { windowsHide: true, timeout: 5000 });
      } catch {}
    }
    return dir;
  } catch {
    return ""; // cannot create it: yt-dlp keeps the files next to the download as before
  }
}

/** Removes the folder of unfinished files once nothing is left in it (and the old hidden one). */
function removePartialDirIfEmpty(targetDir) {
  for (const dir of [partialDirFor(targetDir).dir, path.join(targetDir, PARTIAL_DIR_NAME)]) {
    try {
      fs.rmdirSync(dir); // fails while it holds files
    } catch {}
  }
}

function cleanupJobFiles(info) {
  if (!info) return;

  const targetDir =
    info.targetDir || info.saveFolder || app.getPath("downloads");
  const titleHint = String(info.title || info.snapshot?.title || "")
    .toLowerCase()
    .trim();

  const performDeletion = () => {
    try {
      if (!fs.existsSync(targetDir)) return;
      // the folder of unfinished files first (and the hidden one an older version left)
      const entries = []; // { abs, name, unfinished }
      for (const dir of [partialDirFor(targetDir).dir, path.join(targetDir, PARTIAL_DIR_NAME)]) {
        try {
          for (const f of fs.readdirSync(dir)) entries.push({ abs: path.join(dir, f), name: f, unfinished: true });
        } catch {}
      }
      for (const f of fs.readdirSync(targetDir)) entries.push({ abs: path.join(targetDir, f), name: f, unfinished: false });

      const cleanTitleHint = titleHint.replace(/[\\/:*?"<>|]/g, "").trim();
      const words = cleanTitleHint.split(/\s+/).filter((w) => w.length > 2);

      for (const entry of entries) {
        const lowerEntry = entry.name.toLowerCase();

        const isPartFile =
          entry.unfinished || // anything in that folder is unfinished work
          lowerEntry.endsWith(".part") ||
          lowerEntry.endsWith(".ytdl") ||
          lowerEntry.includes(".part-frag") ||
          lowerEntry.endsWith(".temp") ||
          lowerEntry.endsWith(".tmp");

        if (!isPartFile) continue;

        let isMatch = false;

        if (cleanTitleHint.length > 0) {
          if (lowerEntry.includes(cleanTitleHint.slice(0, 15))) {
            isMatch = true;
          } else if (words.length > 0) {
            const matchedWords = words.filter((w) =>
              lowerEntry.includes(w),
            ).length;
            if (matchedWords >= Math.min(2, words.length)) {
              isMatch = true;
            }
          }
        }

        if (!isMatch && !cleanTitleHint) {
          try {
            const stat = fs.statSync(entry.abs);
            if (Date.now() - stat.mtimeMs < 60000) {
              isMatch = true;
            }
          } catch {}
        }

        if (isMatch) {
          try {
            fs.unlinkSync(entry.abs);
          } catch {}
        }
      }
    } catch {}
  };

  performDeletion();
  setTimeout(performDeletion, 300);
  setTimeout(performDeletion, 1000);
  setTimeout(() => {
    performDeletion();
    removePartialDirIfEmpty(targetDir);
  }, 2500);
}

function killJob(downloadId, keepPartial = false) {
  const job = running.get(downloadId);
  if (!job) return;
  if (job.cutTimer) clearInterval(job.cutTimer);
  job.cancelled = true;
  running.delete(downloadId);
  if (job.child && job.child.pid) {
    if (isWin) {
      spawn("taskkill", ["/pid", String(job.child.pid), "/T", "/F"], {
        windowsHide: true,
      });
    } else {
      job.child.kill("SIGKILL");
    }
  }
  if (!keepPartial) {
    cleanupJobFiles(job);
  }
}

/** --------------------------------------------------------------------------
 * PROGRESS TRACKER
 * Turns yt-dlp's per-file progress lines into ONE overall percentage. A video with a separate
 * audio stream is two files; subtitles, thumbnails and other side files are ignored, so
 * they can't move the bar or make "all streams finished" wrong.
 * -------------------------------------------------------------------------- */
const SIDE_FILES = /\.(vtt|srt|ass|ttml|srv[123]|json3|lrc|jpe?g|png|webp|description|json)$/i;
const SPEED_WINDOW_MS = 3000; // the rate is what really arrived over the last seconds

function createProgressTracker(expectedTotal) {
  let expected = Number(expectedTotal) > 0 ? Number(expectedTotal) : 0;
  const files = new Map(); // filename -> { downloaded, total, finished }
  const samples = []; // { t, done }: bytes received so far, over time
  let best = 0;
  let lastSpeed = 0;
  let mostDone = 0;

  /** Bytes per second measured from the bytes that arrived, not taken from yt-dlp's smoothing. */
  function measuredSpeed(now, done, reported) {
    samples.push({ t: now, done });
    while (samples.length > 2 && now - samples[0].t > SPEED_WINDOW_MS) samples.shift();
    const first = samples[0];
    const span = (now - first.t) / 1000;
    if (span >= 0.5 && done >= first.done) return (done - first.done) / span;
    return reported > 0 ? reported : lastSpeed;
  }

  /** Returns null for side files, otherwise { percent, speed, eta, totalBytes, doneBytes }. */
  function update(p) {
    if (!p || !p.filename || SIDE_FILES.test(p.filename)) return null;

    const prev = files.get(p.filename);
    files.set(p.filename, {
      downloaded: p.downloaded > 0 ? p.downloaded : prev ? prev.downloaded : 0,
      total: p.total > 0 ? p.total : prev ? prev.total : 0,
      finished: p.status === "finished",
    });

    let done = 0;
    let known = 0;
    for (const f of files.values()) {
      done += f.downloaded;
      known += Math.max(f.total, f.downloaded);
    }
    mostDone = Math.max(mostDone, done);

    // When every file has finished, their real total is the truth: an estimate that was too
    // high must not leave the bar short of the end.
    const denom = allFinished() ? known : Math.max(expected, known);
    // The bar is the share of bytes received (99% at most: 100% means the file is in place)
    best = Math.max(best, denom > 0 ? Math.min(99, (done / denom) * 100) : 0);

    lastSpeed = measuredSpeed(Date.now(), done, p.speed);
    const eta = samples.length > 1 && lastSpeed > 0 && denom > done ? (denom - done) / lastSpeed : null;
    return { percent: Math.round(best), speed: lastSpeed, eta, totalBytes: denom, doneBytes: mostDone };
  }

  // Every file yt-dlp started is complete AND nothing is still expected to come (the audio
  // of a video starts after the video has finished)
  const allFinished = () => {
    if (!files.size || ![...files.values()].every((f) => f.finished)) return false;
    if (files.size >= 2 || !expected) return true;
    let known = 0;
    for (const f of files.values()) known += Math.max(f.total, f.downloaded);
    return known >= expected * 0.9;
  };

  return {
    update,
    allFinished,
    started: () => mostDone > 0,
    setExpected: (n) => {
      if (Number(n) > 0) expected = Number(n);
    },
  };
}

/** --------------------------------------------------------------------------
 * POST-PROCESSING
 * The text comes from the step yt-dlp reports it is running (merging, embedding, ...); the
 * bar stays at 99% (all bytes are in) until the file is in place.
 * -------------------------------------------------------------------------- */
const POST_STEP_TEXT = [
  [/Merger/i, "Merging audio and video…"],
  [/ExtractAudio|AudioConvertor/i, "Converting audio…"],
  [/EmbedThumbnail/i, "Embedding thumbnail…"],
  [/EmbedSubtitle/i, "Embedding subtitles…"],
  [/Chapters|FFmpegMetadata/i, "Embedding chapters…"],
  [/Fixup/i, "Fixing up…"],
  [/VideoConvertor|VideoRemuxer/i, "Converting video…"],
  [/MoveFiles/i, "Finishing up…"],
];

/** Steps that are not the end of the download (they run before or beside it). */
const EARLY_POST_STEPS = /ThumbnailsConvertor|MetadataParser|SponsorBlock|ModifyChapters|SubtitlesConvertor/i;

function showPostProcessStep(job, downloadId, step) {
  const entry = POST_STEP_TEXT.find(([re]) => re.test(step));
  const text = entry ? entry[1] : "Finishing up…";
  if (job.processing && job.stepText === text) return;
  job.processing = true;
  job.stepText = text;
  if (job.cutTimer) clearInterval(job.cutTimer);
  emitProgress(downloadId, job, {
    stage: "processing",
    stageText: text,
    percent: 99,
    speed: "",
    eta: "",
  });
}

/** Real length of a media file in seconds (0 if it can't be read). */
function probeDuration(file) {
  return new Promise((resolve) => {
    execFile(
      getBinPaths().ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        file,
      ],
      { windowsHide: true, timeout: 30000 },
      (err, stdout) => {
        const n = err ? 0 : parseFloat(String(stdout).trim());
        resolve(Number.isFinite(n) && n > 0 ? n : 0);
      },
    );
  });
}

/* ----------------------------------------------------------------------------
 * Reading an MP4's own header
 * ffprobe's "duration" is worked out from the streams, so it can look right while the
 * header (mvhd) that Windows players read still holds the length of the full video.
 * These helpers read that header directly so a stale length can be detected.
 * -------------------------------------------------------------------------- */
function* movBoxes(buf, start = 0, end = buf.length) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    let hdr = 8;
    if (size === 1) {
      if (off + 16 > end) return;
      size = Number(buf.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < hdr || off + size > end) return;
    yield { type, body: off + hdr, end: off + size };
    off += size;
  }
}

/** { movie, track } in seconds: the header's length and the longest track's length. */
function readMovDurations(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    let off = 0;
    while (off + 8 <= size) {
      fs.readSync(fd, head, 0, 16, off);
      let boxSize = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      let hdr = 8;
      if (boxSize === 1) {
        boxSize = Number(head.readBigUInt64BE(8));
        hdr = 16;
      } else if (boxSize === 0) {
        boxSize = size - off;
      }
      if (boxSize < hdr) return null;
      if (type === "moov") {
        if (boxSize > 64 * 1024 * 1024) return null;
        const buf = Buffer.alloc(boxSize - hdr);
        fs.readSync(fd, buf, 0, buf.length, off + hdr);
        let timescale = 0;
        let movie = 0;
        let track = 0;
        for (const box of movBoxes(buf)) {
          if (box.type !== "mvhd") continue;
          if (buf[box.body] === 1) {
            timescale = buf.readUInt32BE(box.body + 20);
            movie = Number(buf.readBigUInt64BE(box.body + 24));
          } else {
            timescale = buf.readUInt32BE(box.body + 12);
            movie = buf.readUInt32BE(box.body + 16);
          }
        }
        if (!timescale) return null;
        for (const trak of movBoxes(buf)) {
          if (trak.type !== "trak") continue;
          for (const child of movBoxes(buf, trak.body, trak.end)) {
            if (child.type !== "tkhd") continue;
            const dur =
              buf[child.body] === 1
                ? Number(buf.readBigUInt64BE(child.body + 28))
                : buf.readUInt32BE(child.body + 20);
            track = Math.max(track, dur / timescale);
          }
        }
        return { movie: movie / timescale, track };
      }
      off += boxSize;
    }
  } catch {
    /* unreadable: treated as "can't tell" */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return null;
}

/**
 * Rewrites a trimmed file once (streams are copied, nothing is re-encoded) so the whole
 * container, header included, describes the clip: timestamps from the start, index first,
 * no chapters left over from the full video. Returns { ok, warning }.
 * The original is only replaced by a finished, non-empty copy. On Windows the replacement can
 * fail while a player, Explorer's preview or an antivirus still has the file open, so it is
 * retried for a few seconds and, if it still fails, the user is told instead of it being
 * hidden.
 */
async function finalizeClip(file) {
  const isMov = MOV_FILE.test(file);
  if (!isMov && !MKV_FILE.test(file)) return { ok: true }; // audio files carry no such header

  const ext = path.extname(file);
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file, ext)}.finalizing${ext}`,
  );
  const dropTemp = () => {
    try {
      fs.unlinkSync(temp);
    } catch {}
  };

  const args = [
    "-y",
    "-v",
    "error",
    "-i",
    file,
    "-map",
    "0",
    "-c",
    "copy",
    "-map_metadata",
    "0",
    "-map_chapters",
    "-1",
  ];
  if (isMov) args.push("-movflags", "+faststart");
  args.push(temp);

  const failure = await new Promise((resolve) => {
    execFile(
      getBinPaths().ffmpeg,
      args,
      { windowsHide: true, timeout: 10 * 60 * 1000 },
      (err, _stdout, stderr) =>
        resolve(err ? String(stderr || err.message).trim() : ""),
    );
  });
  let tempSize = 0;
  try {
    tempSize = fs.statSync(temp).size;
  } catch {}
  if (failure || !tempSize) {
    dropTemp();
    console.error("[clip] could not rewrite the trimmed file:", failure);
    return {
      ok: false,
      warning:
        "The clip was saved, but its length could not be corrected (the file could not be rewritten).",
    };
  }

  let replaced = false;
  let lastError = null;
  for (let attempt = 0; attempt < 10 && !replaced; attempt++) {
    try {
      fs.renameSync(temp, file);
      replaced = true;
    } catch (err) {
      lastError = err;
      await sleep(500);
    }
  }
  if (!replaced) {
    dropTemp();
    console.error("[clip] could not replace the trimmed file:", lastError);
    return {
      ok: false,
      warning:
        "The clip was saved, but its length could not be corrected because the file is in use. Close any player that has it open and download it again.",
    };
  }

  if (isMov) {
    const header = readMovDurations(file);
    if (header && Math.abs(header.movie - header.track) > 1.5) {
      console.error("[clip] header still disagrees with the tracks:", header);
      return {
        ok: false,
        warning:
          "The clip was saved, but its length may show incorrectly in some players.",
      };
    }
  }
  return { ok: true };
}

/**
 * Everything yt-dlp prints for a download goes to downloads.log (next to the app's data),
 * so a download that misbehaves can be looked at afterwards. Kept below ~1 MB.
 */
function openDownloadLog(downloadId, url, args) {
  const file = path.join(app.getPath("userData"), "downloads.log");
  const t0 = Date.now();
  const write = (text) => {
    try {
      fs.appendFileSync(file, text);
    } catch {}
  };
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024)
      fs.writeFileSync(file, "");
  } catch {}
  write(`\n===== ${new Date().toISOString()} ${downloadId} ${url}\n$ yt-dlp ${args.join(" ")}\n`);
  return (kind, chunk) => {
    const text = String(chunk).replace(/\r?\n$/, "");
    if (text) write(`[${((Date.now() - t0) / 1000).toFixed(1)}s ${kind}] ${text}\n`);
  };
}

function startDownloadJob(payload) {
  const { url, quality, format, saveFolder, downloadId, subfolder } = payload;

  if (!isValidHttpUrl(url)) {
    send("download-error", { downloadId, error: "Invalid URL" });
    return;
  }

  if (running.has(downloadId)) return;
  finished.delete(downloadId);

  let targetDir =
    saveFolder && saveFolder.trim() !== ""
      ? saveFolder
      : app.getPath("downloads");
  if (subfolder) {
    targetDir = path.join(targetDir, subfolder.replace(/[\\/:*?"<>|]/g, "_"));
  }
  try {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  } catch {
    targetDir = app.getPath("downloads");
  }

  const userOpts = payload.options || {};
  const opts = parseOptions(format, quality, userOpts);
  // Trimming a live/audio-only/whole file is still valid; only a bad range is dropped
  const trim = sanitizeTrim(payload.trim);
  const clipSeconds = trim ? trim.end - trim.start : 0;

  const sumSizes = (arr) =>
    (Array.isArray(arr) ? arr : []).reduce(
      (a, b) => a + (Number(b) > 0 ? Number(b) : 0),
      0,
    );
  let expectedTotal = sumSizes(payload.streamSizes);

  const tracker = createProgressTracker(expectedTotal);

  const job = {
    child: null,
    cancelled: false,
    snapshot: {},
    targetDir,
    title: payload.title || "",
    processing: false,
    cutting: false,
    cutTimer: null,
    cutSeenRealProgress: false,
  };
  running.set(downloadId, job);

  // Title / thumbnail are normally known already (link analysis or playlist list).
  // Re-running `yt-dlp -J` here would repeat 10-20 s of work for every download.
  const knownInfo = getCached(`info|${normalizeUrl(url)}`);
  if (!expectedTotal && knownInfo) {
    if (knownInfo.title) job.title = knownInfo.title;
    emitProgress(downloadId, job, {
      title: knownInfo.title || undefined,
      thumb: knownInfo.thumb || undefined,
    });
  } else if (!expectedTotal && !payload.title) {
    // Join the prefetch for this link instead of running another full analysis
    const pre = ensurePrefetch(url);
    const applyInfo = (info) => {
      if (job.cancelled || running.get(downloadId) !== job) return;
      if (info && !info.error) {
        const total = sumSizes(info.streamSizes);
        if (total && !expectedTotal) {
          expectedTotal = total;
          tracker.setExpected(total);
        }
        if (info.title) job.title = info.title;
        emitProgress(downloadId, job, {
          title: info.title || undefined,
          thumb: info.thumb || undefined,
          size: info.size || undefined,
        });
      }
    };
    pre.preview.then(applyInfo).catch(() => {});
    pre.quick.then(applyInfo).catch(() => {});
  }

  // Template output filename format
  // "Duplicate files handling: Rename" adds " (2)", " (3)"… after the name
  const dupN = Math.floor(Number(payload.dupSuffix) || 0);
  const dupText = dupN > 1 ? ` (${dupN})` : "";
  let outputFilenameTemplate = `%(title)s${dupText}.%(ext)s`;
  if (payload.playlistIndex && userOpts.trackPrefix) {
    const padIndex = String(payload.playlistIndex).padStart(2, "0");
    outputFilenameTemplate = `${padIndex} - %(title)s${dupText}.%(ext)s`;
  }

  // Unfinished files (.part, fragments, thumbnails, subtitles) live in a hidden folder next
  // to the download and are moved into place when the file is complete.
  const partialDir = ensurePartialDir(targetDir);

  const featureArgs = [];
  featureArgs.push(
    userOpts.chapters !== false && !trim
      ? "--embed-chapters"
      : "--no-embed-chapters",
  );
  if (userOpts.embedThumb !== false) {
    featureArgs.push("--embed-thumbnail");
  }

  if (!opts.audioOnly) {
    if (userOpts.captions) {
      // Mode: embedded in the video, saved as separate files, or both
      const mode = ["embedded", "separate", "both"].includes(userOpts.subMode)
        ? userOpts.subMode
        : userOpts.separateSub
          ? "separate"
          : "embedded";
      const fmt = String(userOpts.subFormat || "srt").toLowerCase();
      featureArgs.push("--write-subs");
      if (userOpts.subAuto !== false) featureArgs.push("--write-auto-subs");
      featureArgs.push(
        "--sub-langs",
        pickSubtitleLangs(
          userOpts.subLang,
          knownInfo,
          languageByUrl.get(normalizeUrl(url)),
        ),
      );
      // File format of the separate files (.json = YouTube's own json3 captions)
      if (mode !== "embedded") {
        if (fmt === "json") featureArgs.push("--sub-format", "json3");
        else if (["srt", "vtt", "ass", "lrc"].includes(fmt))
          featureArgs.push("--sub-format", `${fmt}/best`, "--convert-subs", fmt);
      }
      // Only formats a video container can hold are embedded
      const embeddable = mode === "embedded" || ["srt", "vtt", "ass"].includes(fmt);
      if (mode !== "separate" && embeddable) {
        featureArgs.push("--embed-subs");
        if (mode === "embedded") featureArgs.push("--compat-options", "no-keep-subs");
      }
    }
  }

  if (trim) {
    // Only the selected range is fetched; ffmpeg does the cutting
    featureArgs.push("--download-sections", `*${trim.start}-${trim.end}`);
    if (trim.exact) featureArgs.push("--force-keyframes-at-cuts");
  }
  if (userOpts.overwrite) featureArgs.push("--force-overwrites");
  if (payload.__ipv4Retry) featureArgs.push("--force-ipv4"); // the second try after a broken connection
  // YouTube's "not a bot" check: use a signed-in browser session (see the retry below)
  const hasOwnCookies = /--cookies(?:-from-browser)?\b/.test(String(userOpts.extraArgs || ""));
  const cookieTry = payload.__cookieTry || ""; // browser being tried after a bot check
  if (!hasOwnCookies) {
    if (cookieTry) featureArgs.push("--cookies-from-browser", cookieTry);
    else featureArgs.push(...knownCookieArgs(url));
  }

  const speedLimit = sanitizeSpeedLimit(userOpts.speedLimit);
  if (speedLimit) featureArgs.push("-r", speedLimit);
  const proxyUrl = sanitizeProxy(userOpts.proxyUrl);
  if (proxyUrl) featureArgs.push("--proxy", proxyUrl);
  if (userOpts.extraArgs) {
    const rawExtra = String(userOpts.extraArgs).trim().split(/\s+/);
    featureArgs.push(...rawExtra);
  }

  const pathFile = path.join(
    app.getPath("temp"),
    `ytdlp-studio-${downloadId}.txt`,
  );
  try {
    fs.unlinkSync(pathFile);
  } catch {}

  const retryCount =
    userOpts.autoRetry === false
      ? 0
      : Math.min(10, Math.max(1, Number(userOpts.maxRetries) || 3));

  // The link was already analysed: reuse that result instead of letting yt-dlp read the link
  // again (10-20 s before the first byte). If it cannot be used, the download is retried
  // from the link itself (see the failure branch below).
  const infoFile = payload.__noInfo ? "" : freshRawInfoFile(url);

  const args = [
    ...(infoFile ? ["--load-info-json", infoFile] : [url]),
    "--no-warnings",
    "--ignore-errors",
    "--retries",
    String(retryCount),
    "--fragment-retries",
    String(retryCount),
    "--no-playlist",
    "--ffmpeg-location",
    getBinPaths().binDir,
    "-P",
    `home:${targetDir}`,
    ...(partialDir ? ["-P", `temp:${partialDir}`] : []),
    "-o",
    outputFilenameTemplate,
    "--no-mtime",
    "--newline",
    "--progress", // keep the progress lines even if a print option made yt-dlp quiet
    "--windows-filenames",
    "--encoding",
    "utf-8",
    "--embed-metadata",
    // Use the whole connection: several pieces of a fragmented stream at once, and a new
    // address when the site slows a download down on purpose (YouTube does)
    "--concurrent-fragments",
    "8",
    "--throttled-rate",
    "300K",
    "--buffer-size",
    "256K",
    "--progress-template",
    "download:PROG|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.filename)s",
    "--progress-template",
    "postprocess:POST|%(progress.status)s|%(progress.postprocessor)s",
    "--print-to-file",
    "after_move:filepath",
    pathFile,
    ...getExtractorFlags(),
    ...opts.selectorArgs,
    ...opts.postArgs,
    ...featureArgs,
  ];

  console.log(`Starting download (${downloadId}):`, url);
  const dlLog = openDownloadLog(downloadId, url, args);

  let child;
  try {
    child = spawn(getBinPaths().ytDlp, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    trackProc(child, { kind: "download", url }); // downloads are not a feature: they slow down while one is in use
  } catch (err) {
    if (running.get(downloadId) === job) running.delete(downloadId);
    send("download-error", { downloadId, error: err.message });
    return;
  }
  job.child = child;

  let lastSent = 0;
  let stderrBuf = "";
  let stdoutRemainder = "";
  let cutPct = 1;

  /** The "cutting" stage: ffmpeg is extracting the chosen range. */
  function beginCutting() {
    if (!trim || job.cutting || job.processing || job.cancelled) return;
    job.cutting = true;
    emitProgress(downloadId, job, {
      stage: "cutting",
      stageText: "Cutting selected range…",
      percent: Math.max(1, cutPct),
      speed: "",
      eta: "",
    });
    // If ffmpeg reports no timing, creep slowly so the bar never looks frozen
    job.cutTimer = setInterval(() => {
      if (job.cancelled || job.processing || job.cutSeenRealProgress) return;
      cutPct += (85 - cutPct) * 0.04;
      emitProgress(downloadId, job, {
        stage: "cutting",
        stageText: "Cutting selected range…",
        percent: Math.round(cutPct),
      });
    }, 600);
  }

  /** ffmpeg prints "time=HH:MM:SS.xx" while cutting; map it onto the clip length. */
  function readFfmpegTime(text) {
    if (!trim || job.processing || !clipSeconds) return;
    const all = text.match(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g);
    if (!all) return;
    const m = all[all.length - 1].match(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
    const done = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    beginCutting();
    job.cutSeenRealProgress = true;
    cutPct = Math.max(cutPct, Math.min(88, (done / clipSeconds) * 88));
    const now = Date.now();
    if (now - lastSent < 150) return;
    lastSent = now;
    emitProgress(downloadId, job, {
      stage: "cutting",
      stageText: "Cutting selected range…",
      percent: Math.max(1, Math.round(cutPct)),
      speed: "",
      eta: "",
    });
  }

  function handleProgressLine(line) {
    if (job.processing) return;

    const p = line.split("|");
    const dlStatus = String(p[1] || "");
    const downloaded = toNum(p[2]) || 0;
    const streamTotal = toNum(p[3]) || toNum(p[4]) || 0;
    const speed = toNum(p[5]) || 0;
    const filename = p.slice(7).join("|");

    const t = tracker.update({ filename, downloaded, total: streamTotal, speed, status: dlStatus });
    if (!t) return; // a subtitle, thumbnail or other side file

    // ffmpeg section downloads report bytes too; treat them as the cutting stage
    if (trim) beginCutting();
    const pct = t.percent;

    const now = Date.now();
    if (now - lastSent < 150) return;
    lastSent = now;

    if (trim) {
      job.cutSeenRealProgress = true;
      cutPct = Math.max(cutPct, pct);
    }
    emitProgress(downloadId, job, {
      stage: trim ? "cutting" : "downloading",
      stageText: trim ? "Cutting selected range…" : "",
      percent: Math.max(1, trim ? Math.round(cutPct) : pct),
      speed: formatSpeed(t.speed),
      eta: formatEta(t.eta),
      size: t.totalBytes ? formatBytes(t.totalBytes) : undefined,
      bytes: t.doneBytes || undefined,
    });
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    dlLog("out", chunk);
    const text = stdoutRemainder + chunk;
    const lines = text.split(/\r?\n/);
    stdoutRemainder = lines.pop();
    readFfmpegTime(chunk);
    for (const line of lines) {
      if (line.startsWith("PROG|")) {
        handleProgressLine(line);
      } else if (line.startsWith("POST|")) {
        // yt-dlp also runs steps BEFORE the download (thumbnail conversion, metadata parsing):
        // those must not switch the bar while the real download has not even started. After
        // bytes have arrived, a step that merges or embeds is the final stage; any other step
        // counts only once every stream that was started is complete.
        const step = line.split("|")[2] || "";
        if (
          tracker.started() &&
          !job.cancelled &&
          !EARLY_POST_STEPS.test(step) &&
          (tracker.allFinished() || POST_STEP_TEXT.some(([re]) => re.test(step)))
        )
          showPostProcessStep(job, downloadId, step);
      } else if (
        trim &&
        /^\[(download\] Destination:|ffmpeg\])|ffmpeg/i.test(line)
      ) {
        beginCutting();
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    dlLog("err", chunk);
    stderrBuf = (stderrBuf + chunk).slice(-4000);
    readFfmpegTime(chunk);
  });

  child.on("error", (err) => {
    if (job.cutTimer) clearInterval(job.cutTimer);
    if (job.cancelled) return;
    if (running.get(downloadId) === job) running.delete(downloadId);
    finished.set(downloadId, { status: "failed", error: err.message });
    send("download-error", { downloadId, error: err.message });
  });

  child.on("close", async (code) => {
    if (job.cutTimer) clearInterval(job.cutTimer);
    if (job.cancelled) return;

    let filePath = "";
    try {
      const lines = fs
        .readFileSync(pathFile, "utf8")
        .split(/\r?\n/)
        .filter(Boolean);
      filePath = lines[lines.length - 1] || "";
      fs.unlinkSync(pathFile);
    } catch {}

    const fileExists = filePath && fs.existsSync(filePath);

    // A trimmed file is rewritten once, without re-encoding, so its header, timestamps and
    // duration describe the clip and not the original video. Then its real length is read.
    let durationSeconds = 0;
    let clipWarning = "";
    if (trim && fileExists) {
      emitProgress(downloadId, job, {
        stage: "processing",
        stageText: "Finalizing clip…",
        percent: 98,
        speed: "",
        eta: "",
      });
      const finalized = await finalizeClip(filePath);
      clipWarning = finalized.warning || "";
      durationSeconds = await probeDuration(filePath);
    }

    if (job.cancelled) return;
    if (running.get(downloadId) === job) running.delete(downloadId);

    if (code === 0 || fileExists) {
      if (cookieTry) setWorkingCookieBrowser(cookieTry); // this session works: keep using it
      removePartialDirIfEmpty(targetDir);
      // The real size of the finished file replaces the estimate on the card
      let sizeBytes = 0;
      try {
        if (fileExists) sizeBytes = fs.statSync(filePath).size;
      } catch {}
      finished.set(downloadId, {
        status: "completed",
        filePath,
        sizeBytes,
        durationSeconds,
        warning: clipWarning,
      });
      send("download-complete", {
        downloadId,
        filePath,
        sizeBytes,
        durationSeconds,
        warning: clipWarning,
      });
    } else {
      // The saved analysis could not be used (expired address, odd site): start again from the link
      if (infoFile && !job.cancelled) {
        startDownloadJob({ ...payload, __noInfo: true });
        return;
      }
      // The connection broke off before anything was saved: one more try over IPv4 only.
      // (Not for DNS failures: another address family does not help there.)
      if (
        !payload.__ipv4Retry &&
        !DNS_ERROR.test(stderrBuf) &&
        CONNECT_ERROR.test(stderrBuf)
      ) {
        startDownloadJob({ ...payload, __ipv4Retry: true });
        return;
      }
      // YouTube asked for proof of a person: try the signed-in browsers one after another
      if (BOT_ERROR.test(stderrBuf) && !hasOwnCookies && !job.cancelled) {
        const list = cookieCandidates();
        const next = list[list.indexOf(cookieTry) + 1];
        if (next && (cookieTry || !appPrefs.cookiesFile)) {
          startDownloadJob({ ...payload, __cookieTry: next });
          return;
        }
      }
      const error =
        lastErrorLine(stderrBuf) || "Download failed (Exit code " + code + ")";
      finished.set(downloadId, { status: "failed", error });
      send("download-error", { downloadId, error });
    }
  });
}

function getDownloadStates() {
  const runningStates = {};
  for (const [id, job] of running.entries()) runningStates[id] = job.snapshot || {};
  return { running: runningStates, finished: Object.fromEntries(finished) };
}

function cancelDownload(downloadId, opts = {}) {
  const keepPartial = !!opts.keepPartial;
  if (running.get(downloadId)) return killJob(downloadId, keepPartial);
  if (keepPartial) return;
  let targetDir = opts.saveFolder && opts.saveFolder.trim() !== "" ? opts.saveFolder : app.getPath("downloads");
  if (opts.subfolder) targetDir = path.join(targetDir, opts.subfolder.replace(/[\\/:*?"<>|]/g, "_"));
  cleanupJobFiles({ targetDir, title: opts.title || "" });
}

function killAllDownloads() {
  for (const id of Array.from(running.keys())) killJob(id, true);
}

module.exports = {
  cancelDownload,
  getDownloadStates,
  killAllDownloads,
  startDownloadJob,
};
