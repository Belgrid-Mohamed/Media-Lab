const { clipboard } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const { createLimiter, fetchJson, formatBytes, getCached, isValidHttpUrl, lastErrorLine, metadataCache, normalizeUrl, parseJsonLine, sanitizeLang, setCached } = require("./utils");
const { ACODEC_ORDER, ANALYSIS_FLAGS, CACHE_TTL_MS, MAX_PARALLEL_ANALYSES, PLAYLIST_SEARCH_LIMIT, PLAYLIST_SEARCH_PARALLEL, PREFETCH_HOSTS, QUALITY_HEIGHTS, QUICK_FLAGS, SIZE_FAMILIES, VCODEC_ORDER, previewDir } = require("./config");
const { engine, getExtractorFlags } = require("./binaries-manager");
const { inFocusContext, runYtDlp, withTier } = require("./process-control");

const pendingFetches = new Map();

async function getFastMetadata(url, timeoutMs = 1000) {
  const ytMatch = url.match(
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i,
  );
  let fastThumb = "";
  let videoId = "";
  if (ytMatch && ytMatch[1]) {
    videoId = ytMatch[1];
    fastThumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }

  let oembedUrl = "";
  if (videoId || url.includes("youtube.com") || url.includes("youtu.be")) {
    oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  } else if (
    url.includes("vimeo.com") ||
    url.includes("tiktok.com") ||
    url.includes("soundcloud.com")
  ) {
    oembedUrl = `https://noembed.com/embed?url=${encodeURIComponent(url)}`;
  }

  let oembedData = null;
  if (oembedUrl) {
    oembedData = await fetchJson(oembedUrl, timeoutMs);
  }

  const title = oembedData?.title || "";
  const thumb = oembedData?.thumbnail_url || fastThumb || "";

  if (title || thumb) {
    return {
      title: title || "Untitled Video",
      uploader: oembedData?.author_name || "",
      thumb: thumb,
      size: "",
      sizeBytes: 0,
      streamSizes: [],
      isPartial: true,
    };
  }

  return null;
}

function parseOptions(format, quality, extra = {}) {
  const f = String(format || "").toLowerCase();
  const q = String(quality || "").toLowerCase();
  const audioFormat = ["mp3", "m4a", "flac", "wav", "opus"].find((x) =>
    f.includes(x),
  );
  // "4k" must NOT count as audio, only bitrates such as "320k" / "320 kbps"
  const audioOnly = !!audioFormat || /\b\d{2,3}\s*k(bps)?\b/.test(q);

  const rawLang = String(extra.audioLang || "auto").toLowerCase();
  let audioPrefs = [];
  if (rawLang === "original") {
    audioPrefs = ["ba[format_note*=original]"];
  } else if (sanitizeLang(rawLang)) {
    audioPrefs = [`ba[language^=${sanitizeLang(rawLang)}]`];
  }

  if (audioOnly) {
    const m = q.match(/(\d{2,3})\s*k/);
    const targetAudioFmt = audioFormat || "mp3";
    return {
      audioOnly: true,
      selectorArgs: ["-f", [...audioPrefs, "ba", "b"].join("/")],
      postArgs: [
        "-x",
        "--audio-format",
        targetAudioFmt,
        "--audio-quality",
        m ? `${m[1]}K` : "0",
      ],
    };
  }

  // Any real height ("1080p", "1920p" for vertical video, "4k") caps the selection
  let cap = null;
  const heightMatch = q.match(/(\d{3,4})\s*p/);
  if (heightMatch) cap = Number(heightMatch[1]);
  else if (q.includes("4k")) cap = 2160;

  const v = cap ? `bv*[height<=${cap}]` : "bv*";
  const parts = [];
  audioPrefs.forEach((a) => parts.push(`${v}+${a}`));
  parts.push(`${v}+ba`);
  if (cap) parts.push(`b[height<=${cap}]`);
  parts.push("bv*+ba");
  parts.push("b");
  const selector = parts.join("/");

  let sort = "res,vcodec:h264,acodec:m4a";
  let merge = "mp4";
  if (f.includes("mkv")) {
    merge = "mkv";
  } else if (f.includes("webm")) {
    sort = "res,vcodec:vp9,acodec:opus";
    merge = "webm";
  } else if (f.includes("mov")) {
    merge = "mov";
  } else if (f.includes("avi")) {
    merge = "avi";
  }

  return {
    audioOnly: false,
    selectorArgs: ["-f", selector, "-S", sort],
    postArgs: ["--merge-output-format", merge],
  };
}

/**
 * yt-dlp's preference number for a codec, given the codec asked for with -S
 * (`vcodec:h264`): that codec first, then the ones ranked below it, then the ones
 * ranked above it (closest first).
 */
function codecPreference(order, codec, preferredIndex) {
  const n = order.length + 3;
  const value = codec == null ? null : String(codec).toLowerCase();
  let p;
  if (value === null) p = 2;
  else if (value === "none") p = 1;
  else {
    const i = order.findIndex((re) => re.test(value));
    p = i >= 0 ? n - i : 3;
  }
  const limit = n - preferredIndex;
  return p <= limit ? p : -p;
}

const rawInfoFiles = new Map();

/** The saved analysis of a link if it is still fresh ("" if none). Never waits. */
function freshRawInfoFile(url) {
  const entry = rawInfoFiles.get(`info|${normalizeUrl(url)}`);
  return entry && fs.existsSync(entry.file) && Date.now() - entry.at < CACHE_TTL_MS ? entry.file : "";
}

/** Keeps the raw analysis of a link in the temp folder (a few at a time). */
function saveRawInfo(key, text) {
  try {
    fs.mkdirSync(previewDir, { recursive: true });
    const file = path.join(
      previewDir,
      `info-${crypto.randomBytes(6).toString("hex")}.json`,
    );
    fs.writeFileSync(file, text);
    const old = rawInfoFiles.get(key);
    rawInfoFiles.set(key, { file, at: Date.now() });
    if (old) {
      try {
        fs.unlinkSync(old.file);
      } catch {}
    }
    while (rawInfoFiles.size > 12) {
      const [oldKey, oldest] = rawInfoFiles.entries().next().value;
      rawInfoFiles.delete(oldKey);
      try {
        fs.unlinkSync(oldest.file);
      } catch {}
    }
  } catch {
    /* previews then simply look the link up themselves */
  }
}

/**
 * YouTube publishes small "storyboard" sprite sheets of every video (the thumbnails you
 * see when hovering the seek bar). yt-dlp lists them as "mhtml" formats. They give the
 * trim dialog a filmstrip and a frame preview without downloading any video.
 * Returns null for sites that don't have them.
 */
function pickStoryboard(formats, duration) {
  const boards = formats.filter(
    (f) =>
      (String(f.format_note || "").toLowerCase() === "storyboard" ||
        String(f.ext || "").toLowerCase() === "mhtml" ||
        /^sb\d/i.test(String(f.format_id || ""))) &&
      Array.isArray(f.fragments) &&
      f.fragments.length &&
      Number(f.columns) > 0 &&
      Number(f.rows) > 0 &&
      Number(f.width) > 0 &&
      Number(f.height) > 0,
  );
  if (!boards.length) return null;

  // The sharpest board that is still small (<= 320 px wide): crisp enough, light to load
  const small = boards.filter((f) => Number(f.width) <= 320);
  const board = (small.length ? small : boards).sort(
    (a, b) => Number(b.width) - Number(a.width),
  )[0];

  const cols = Math.floor(Number(board.columns));
  const rows = Math.floor(Number(board.rows));
  const perSheet = cols * rows;
  const sheets = board.fragments
    .map((fr) => String((fr && fr.url) || ""))
    .filter((u) => /^https:\/\//i.test(u))
    .slice(0, 80);
  if (!sheets.length || perSheet < 1) return null;

  // Seconds covered by one frame: a full sheet's duration / frames per sheet
  const sheetSeconds =
    Number(board.fragments[0] && board.fragments[0].duration) || 0;
  let interval =
    sheetSeconds > 0
      ? sheetSeconds / perSheet
      : Number(board.fps) > 0
        ? 1 / Number(board.fps)
        : 0;
  if (!(interval > 0) && duration)
    interval = duration / (perSheet * sheets.length);
  if (!(interval > 0)) return null;

  return {
    width: Math.round(Number(board.width)),
    height: Math.round(Number(board.height)),
    cols,
    rows,
    interval,
    sheets,
  };
}

function buildMediaInfo(meta) {
  const duration = Math.round(Number(meta.duration) || 0);
  const formats = Array.isArray(meta.formats) ? meta.formats : [];

  const sizeOf = (f) => {
    const exact = Number(f.filesize || f.filesize_approx) || 0;
    if (exact) return exact;
    const tbr = Number(f.tbr) || (Number(f.vbr) || 0) + (Number(f.abr) || 0);
    return duration && tbr ? Math.round(((tbr * 1000) / 8) * duration) : 0;
  };
  const hasVideo = (f) =>
    f.vcodec && f.vcodec !== "none" && Number(f.height) > 0;
  const hasAudio = (f) => f.acodec && f.acodec !== "none";
  // Playlist-style manifests (HLS) are not what a download picks over plain streams
  const isDirect = (f) => /^(https?|ftps?)$/i.test(String(f.protocol || ""));
  const preferDirect = (list) => {
    const direct = list.filter(isDirect);
    return direct.length ? direct : list;
  };
  const best = (list, keyOf) => {
    let top = null;
    let topKey = null;
    for (const f of list) {
      const key = keyOf(f);
      let better = !top;
      if (top) {
        for (let i = 0; i < key.length; i++) {
          if (key[i] !== topKey[i]) {
            better = key[i] > topKey[i];
            break;
          }
        }
      }
      if (better) {
        top = f;
        topKey = key;
      }
    }
    return top;
  };

  const audioOnly = preferDirect(
    formats.filter((f) => hasAudio(f) && !hasVideo(f)),
  );
  const pickAudio = (fam) =>
    best(audioOnly, (f) => [
      codecPreference(ACODEC_ORDER, f.acodec, fam.audio),
      Number(f.language_preference) || 0,
      Number(f.quality) || 0,
      Number(f.audio_channels) || 0,
      sizeOf(f),
      Number(f.tbr) || 0,
      Number(f.asr) || 0,
    ]);
  const pickVideo = (cap, fam) =>
    best(
      preferDirect(
        formats.filter((f) => hasVideo(f) && Number(f.height) <= cap),
      ),
      (f) => {
        const w = Number(f.width);
        const h = Number(f.height);
        return [
          w > 0 ? Math.min(w, h) : h,
          codecPreference(VCODEC_ORDER, f.vcodec, fam.video),
          codecPreference(ACODEC_ORDER, f.acodec, fam.audio),
          Number(f.quality) || 0,
          Number(f.fps) || 0,
          sizeOf(f),
          Number(f.tbr) || 0,
        ];
      },
    );

  // Size of "the best stream up to that height", the way the download will pick it
  const qualitySizes = {};
  for (const [famName, fam] of Object.entries(SIZE_FAMILIES)) {
    const audio = pickAudio(fam);
    const audioBytes = audio ? sizeOf(audio) : 0;
    for (const h of QUALITY_HEIGHTS) {
      const v = pickVideo(h, fam);
      const vBytes = v ? sizeOf(v) : 0;
      (qualitySizes[h] = qualitySizes[h] || {})[famName] = vBytes
        ? vBytes + (hasAudio(v) ? 0 : audioBytes)
        : 0;
    }
  }
  const maxHeight = formats.reduce(
    (max, f) => (hasVideo(f) ? Math.max(max, Number(f.height)) : max),
    0,
  );

  const chapters = (Array.isArray(meta.chapters) ? meta.chapters : [])
    .map((c, i) => ({
      name: String(c.title || `Chapter ${i + 1}`),
      start: Math.max(0, Math.floor(Number(c.start_time) || 0)),
      end: Math.min(duration || Infinity, Math.ceil(Number(c.end_time) || 0)),
    }))
    .filter((c) => c.end > c.start);

  const langKeys = (obj) =>
    Object.keys(obj && typeof obj === "object" ? obj : {})
      .filter((k) => /^[A-Za-z0-9_-]{1,24}$/.test(k) && !/live_chat/i.test(k))
      .slice(0, 400);

  return {
    title: meta.title || meta.fulltitle || "Untitled",
    thumb:
      meta.thumbnail ||
      (meta.thumbnails && meta.thumbnails[meta.thumbnails.length - 1]?.url) ||
      "",
    uploader: meta.uploader || meta.channel || "",
    duration,
    isLive: !!meta.is_live,
    chapters,
    storyboard: pickStoryboard(formats, duration),
    qualitySizes,
    maxHeight,
    hasVideo: maxHeight > 0,
    language: String(meta.language || ""),
    captions: {
      manual: langKeys(meta.subtitles),
      auto: langKeys(meta.automatic_captions),
    },
  };
}

const analysisJobs = new Map();

const analysisSlots = createLimiter(MAX_PARALLEL_ANALYSES);

/**
 * Full analysis of one link (qualities, sizes, chapters). Calling it again for the
 * same video while it is running (or after it finished) reuses that work, so the
 * renderer can start it the moment a link appears and ask again later for free.
 * `pin` marks work a download depends on, so a cancel request can't stop it.
 */
async function fetchMediaInfo(url, { pin = false } = {}) {
  const key = `info|${normalizeUrl(url)}`;
  const cached = getCached(key);
  if (cached) return cached;

  const running = analysisJobs.get(key);
  if (running && !running.cancelled) {
    if (pin) running.pinned = true;
    return running.promise;
  }

  // The quick extraction of this same link already reads every stream and keeps the result
  // as this analysis: wait for it instead of starting a second, slower extraction.
  const quickPrefix = `quick|${normalizeUrl(url)}|`;
  const quickRunning = [...quickJobs.entries()].find(([k]) => k.startsWith(quickPrefix));
  if (quickRunning) {
    try {
      await quickRunning[1];
    } catch {}
    const after = getCached(key);
    if (after) return after;
  }

  const job = { handle: {}, pinned: pin, cancelled: false, promise: null };
  const cancelled = () => ({ error: "Cancelled", cancelled: true });

  job.promise = (async () => {
    await engine.setup; // wait for the first-run install (the runtime decides which qualities exist)
    await analysisSlots.acquire(inFocusContext()); // a feature the user just opened goes first
    try {
      if (job.cancelled) return cancelled();
      const res = await runYtDlp(
        [url, ...ANALYSIS_FLAGS, ...getExtractorFlags()],
        60000,
        job.handle,
      );
      if (job.cancelled) return cancelled();
      if (!res.stdout.trim()) return { error: lastErrorLine(res.stderr) };
      try {
        const info = buildMediaInfo(JSON.parse(res.stdout));
        saveRawInfo(key, res.stdout);
        setCached(key, info);
        rememberLanguage(url, info.language);
        return info;
      } catch {
        return { error: "Could not read video info" };
      }
    } finally {
      analysisSlots.release();
    }
  })();

  analysisJobs.set(key, job);
  try {
    return await job.promise;
  } finally {
    if (analysisJobs.get(key) === job) analysisJobs.delete(key);
  }
}

/** Title / thumbnail / channel in a fraction of a second (oEmbed), shown while the full analysis runs. */
async function fetchLinkPreview(url) {
  const key = `preview|${normalizeUrl(url)}`;
  const cached = getCached(key);
  if (cached) return cached;
  const fast = await getFastMetadata(url, 2500);
  const result = {
    title: fast && fast.title !== "Untitled Video" ? fast.title : "",
    thumb: (fast && fast.thumb) || "",
    uploader: (fast && fast.uploader) || "",
  };
  if (result.title || result.thumb) setCached(key, result);
  return result;
}

/** --------------------------------------------------------------------------
 * TWO-LEVEL PREFETCH
 *   Level 1  title, thumbnail, channel, duration and the estimated size for the
 *            default quality (instant oEmbed preview + a lean yt-dlp call)
 *   Level 2  every quality with its size, and chapters (the full analysis)
 * Level 2 starts as soon as level 1 is done. Both levels are cached and shared, so
 * a link can be prefetched the moment it is copied (even while the app is in the
 * background) and the composer finds it ready when the user comes back.
 * -------------------------------------------------------------------------- */
const prefetchPrefs = { watchClipboard: true, format: "MP4", quality: "1080p" };

const prefetchJobs = new Map();

// normalized url -> { preview, quick, full, cancelled }
const quickJobs = new Map();

/**
 * Background work (playlist search, summaries) waits until the first look at the link is
 * done: that one gives the default size and the quality list, and makes the link downloadable.
 * Work for a feature the person just opened goes ahead at once.
 */
async function afterQuick() {
  if (inFocusContext()) return;
  while (quickJobs.size) await Promise.race([...quickJobs.values()]).catch(() => {});
}

// cache key -> promise

/** The language each link was seen to be in (used by "Auto" subtitles when the full analysis isn't ready). */
const languageByUrl = new Map();

function rememberLanguage(url, lang) {
  const value = String(lang || "").trim();
  if (value) languageByUrl.set(normalizeUrl(url), value);
}

async function fetchQuickInfo(
  url,
  format = prefetchPrefs.format,
  quality = prefetchPrefs.quality,
) {
  const key = `quick|${normalizeUrl(url)}|${String(format).toLowerCase()}|${String(quality).toLowerCase()}`;
  const cached = getCached(key);
  if (cached) return cached;
  const inflight = quickJobs.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    await engine.setup;
    await analysisSlots.acquire(true);
    try {
      const { selectorArgs } = parseOptions(format, quality, {});
      // The first look at a link (default quality) goes ahead of everything the app does by itself
      const res = await withTier("boost", "quality", () => runYtDlp(
        [
          url,
          ...QUICK_FLAGS,
          ...getExtractorFlags(),
          ...selectorArgs,
          "--print",
          "%(.{title,uploader,channel,duration,thumbnail,is_live,language,filesize,filesize_approx})j",
          "--print",
          "%(requested_formats.:.{filesize,filesize_approx})j",
          // Everything the full analysis would give, from this same extraction
          "--print",
          "%(formats.:.{height,width,vcodec,acodec,filesize,filesize_approx,tbr,vbr,abr,fps,protocol,asr,quality,language_preference,audio_channels})j",
          "--print",
          "%(chapters)j",
          "--print",
          "%(subtitles)j",
          "--print",
          "%(automatic_captions)j",
          // The whole result, kept so the download (and the preview) start from it instead of
          // reading the link again: that is what made "Starting" take 10-20 s
          "--print",
          "%()j",
        ],
        45000,
      ));

      // One line per --print, in order (a missing field prints "null", never a blank)
      const lines = String(res.stdout || "")
        .split(/\r?\n/)
        .map((l) => l.trim());
      const head = parseJsonLine(lines[0]);
      if (!head) return { error: lastErrorLine(res.stderr) };

      const sizeOf = (o) => Number(o && (o.filesize || o.filesize_approx)) || 0;
      let parts = [];
      try {
        const arr = JSON.parse(lines[1]);
        if (Array.isArray(arr)) parts = arr;
      } catch {}
      let streamSizes = parts.map(sizeOf);
      if (!streamSizes.length || streamSizes.some((n) => !n)) {
        const whole = sizeOf(head);
        streamSizes = whole ? [whole] : [];
      }
      const total = streamSizes.reduce((a, b) => a + b, 0);

      rememberLanguage(url, head.language);

      // This extraction already knows which qualities exist, their sizes, the chapters and
      // the caption languages, so keep it as the full analysis: no second extraction is
      // needed and the quality list can unlock as soon as this call returns. (If the table
      // came back unusable, level 2 still runs the normal way.)
      const rawInfo = lines[6] || "";
      try {
        const parsed = JSON.parse(rawInfo);
        if (parsed && parsed._type !== "playlist" && Array.isArray(parsed.formats) && parsed.formats.length)
          saveRawInfo(`info|${normalizeUrl(url)}`, rawInfo);
      } catch {}
      const formatTable = parseJsonLine(lines[2]);
      if (Array.isArray(formatTable) && formatTable.length) {
        const info = buildMediaInfo({
          title: head.title,
          thumbnail: head.thumbnail,
          uploader: head.uploader,
          channel: head.channel,
          duration: head.duration,
          is_live: head.is_live,
          language: head.language,
          formats: formatTable,
          chapters: parseJsonLine(lines[3]),
          subtitles: parseJsonLine(lines[4]),
          automatic_captions: parseJsonLine(lines[5]),
        });
        const hasAudio = formatTable.some(
          (f) => f && f.acodec && f.acodec !== "none",
        );
        if (info.hasVideo || hasAudio)
          setCached(`info|${normalizeUrl(url)}`, info);
      }

      const result = {
        title: head.title || "",
        thumb: head.thumbnail || "",
        uploader: head.uploader || head.channel || "",
        duration: Math.round(Number(head.duration) || 0),
        isLive: !!head.is_live,
        size: total ? formatBytes(total) : "",
        sizeBytes: total,
        streamSizes,
      };
      setCached(key, result);
      return result;
    } finally {
      analysisSlots.release();
    }
  })();

  quickJobs.set(key, promise);
  try {
    return await promise;
  } finally {
    quickJobs.delete(key);
  }
}

/**
 * Starts (or joins) the prefetch for a link. Safe to call from anywhere, any number
 * of times: clipboard watcher, composer, download start.
 */
function ensurePrefetch(url) {
  const key = normalizeUrl(url);
  const existing = prefetchJobs.get(key);
  if (existing) return existing;

  // Level 1 (title, thumbnail, duration, size) starts at once. Level 2 (every quality, chapters,
  // storyboard) starts the first time somebody reads `job.full`: when the person opens the
  // qualities or the cutting, or when the app is idle. It no longer eats bandwidth for a
  // feature nobody is using.
  const job = { cancelled: false, preview: null, quick: null, _full: null };
  job.preview = fetchLinkPreview(url).catch(() => null);
  job.quick = fetchQuickInfo(url).catch((err) => ({ error: err.message }));
  Object.defineProperty(job, "full", {
    enumerable: true,
    get() {
      if (!job._full) {
        job._full = job.quick
          .then(() =>
            job.cancelled
              ? { error: "Cancelled", cancelled: true }
              : fetchMediaInfo(url),
          )
          .catch((err) => ({ error: err.message }));
        // A failed or cancelled run is never served again; finished ones expire with the cache
        job._full.then((result) => {
          if (!result || result.error) return forget();
          setTimeout(forget, CACHE_TTL_MS).unref?.();
        });
      }
      return job._full;
    },
  });
  prefetchJobs.set(key, job);

  const forget = () => {
    if (prefetchJobs.get(key) === job) prefetchJobs.delete(key);
  };
  // level 1 alone also expires, if level 2 is never asked for
  job.quick.then(() => {
    setTimeout(() => {
      if (!job._full) forget();
    }, CACHE_TTL_MS).unref?.();
  });
  return job;
}

/** Same rule the composer uses to decide a link is a playlist. */
function isPlaylistLink(url) {
  try {
    const u = new URL(url);
    const list = (u.searchParams.get("list") || "").toUpperCase();
    if (list.startsWith("RD")) return false;
    // a video link that also carries its playlist is that video (its own qualities and sizes)
    if (u.searchParams.get("v")) return false;
    if (/(^|\.)youtu\.be$/i.test(u.hostname) && u.pathname.length > 1) return false;
    return !!list || u.pathname.toLowerCase().includes("/playlist");
  } catch {
    return false;
  }
}

function prefetchLink(url) {
  if (isPlaylistLink(url)) {
    fetchPlaylistSummary(url).catch(() => {}); // title and total, long before the list
  } else ensurePrefetch(url); // title, thumbnail, duration: level 1 only
}

/**
 * Starts the prefetch at the moment a supported link is copied, even when the app is
 * in the background. Only the clipboard text is read, only supported sites are acted
 * on, and nothing is stored or logged. Follows the "auto-detect links" setting.
 */
let lastClipboardText = "";

function watchClipboard() {
  const timer = setInterval(() => {
    if (!prefetchPrefs.watchClipboard) return;
    let text = "";
    try {
      text = String(clipboard.readText() || "").trim();
    } catch {
      return;
    }
    if (!text || text === lastClipboardText) return;
    lastClipboardText = text;
    if (text.length > 2048 || /\s/.test(text) || !isValidHttpUrl(text)) return;
    let host = "";
    try {
      host = new URL(text).hostname;
    } catch {
      return;
    }
    if (PREFETCH_HOSTS.test(host)) prefetchLink(text);
  }, 600);
  timer.unref?.();
}

async function fetchPlaylistItemsInternal(url) {
  const normUrl = normalizeUrl(url, { playlist: true });
  const cacheKey = `playlist|${normUrl}`;

  const cached = getCached(cacheKey);
  if (cached) return cached;

  if (pendingFetches.has(cacheKey)) {
    return await pendingFetches.get(cacheKey);
  }

  const fetchPromise = (async () => {
    const res = await runYtDlp(
      [
        url,
        "--flat-playlist",
        "-J",
        "--no-warnings",
        "--no-call-home",
        "--encoding",
        "utf-8",
        ...getExtractorFlags(),
      ],
      20000,
    );

    try {
      if (res.stdout.trim()) {
        const data = JSON.parse(res.stdout);
        const entries = (data.entries || []).filter(Boolean);
        const result = {
          success: entries.length > 0,
          playlistTitle: data.title || "Playlist",
          playlistAuthor: data.uploader || data.channel || "",
          items: entries
            .map((item, index) => ({
              url:
                item.url ||
                (item.id ? `https://www.youtube.com/watch?v=${item.id}` : ""),
              title: item.title || "Untitled Video",
              thumb:
                item.thumbnails && item.thumbnails.length > 0
                  ? item.thumbnails[item.thumbnails.length - 1].url
                  : item.id
                    ? `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`
                    : "",
              id: item.id || Math.random().toString(36).substring(2, 9),
              duration: Number(item.duration) || 0,
              channel: item.channel || item.uploader || "",
              index: index + 1,
            }))
            .filter((i) => i.url),
        };
        if (result.success) {
          setCached(cacheKey, result);
        }
        return result;
      }
    } catch (err) {
      console.error("Playlist parse error:", err.message);
    }
    return { success: false, items: [] };
  })();

  pendingFetches.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    pendingFetches.delete(cacheKey);
  }
}

/**
 * PLAYLIST SUMMARY: the title and the total number of videos, nothing else.
 * Asking yt-dlp for just the first entry reads a single page of the playlist (one request)
 * instead of paging through all of it, and YouTube reports the total with it, so the app
 * can show "50" and the playlist's name while the list itself is still being read.
 */
/**
 * The playlist's name and video count straight from its web page (a fraction of a second),
 * long before yt-dlp has read anything. Only for YouTube; anything unexpected gives null and
 * the normal way (yt-dlp) takes over.
 */
function parsePlaylistPage(html) {
  const num = (t) => Number(String(t).replace(/[^\d]/g, "")) || 0;
  const patterns = [
    /"(?:numVideosText|videoCountText)":\{"runs":\[\{"text":"([\d.,\u00a0\u202f ]+)"/,
    /"stats":\[\{"runs":\[\{"text":"([\d.,\u00a0\u202f ]+)"/,
    /"content":"([\d.,\u00a0\u202f ]+) videos?"/i,
    /"text":"([\d.,\u00a0\u202f ]+) videos?"/i,
    /"videoCount":"(\d+)"/,
  ];
  let count = 0;
  for (const re of patterns) {
    const m = html.match(re);
    if (m && num(m[1]) > 0) {
      count = num(m[1]);
      break;
    }
  }
  let title = "";
  const t = html.match(/<meta property="og:title" content="([^"]*)"/i);
  if (t)
    title = t[1]
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  return { count, title };
}

function fetchPlaylistSummaryFast(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let id = "";
    try {
      const u = new URL(url);
      if (!/(^|\.)(youtube\.com|youtu\.be)$/i.test(u.hostname)) return resolve(null);
      id = u.searchParams.get("list") || "";
    } catch {
      return resolve(null);
    }
    if (!/^[\w-]{10,64}$/.test(id) || id.toUpperCase().startsWith("RD")) return resolve(null);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const req = https.get(
      `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}&hl=en`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: "CONSENT=YES+1; SOCS=CAI",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return finish(null);
        }
        let html = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          html += c;
          if (html.length > 1.5e6) req.destroy(); // the data we need is near the top
        });
        res.on("end", () => {
          const { count, title } = parsePlaylistPage(html);
          finish(count ? { success: true, title: title || "", author: "", count, thumb: "", fast: true } : null);
        });
        res.on("error", () => finish(null));
      },
    );
    req.on("error", () => finish(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(null);
    });
  });
}

async function fetchPlaylistSummary(url) {
  const normUrl = normalizeUrl(url, { playlist: true });
  const cacheKey = `playlistsum|${normUrl}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // the whole list may already be known
  const full = getCached(`playlist|${normUrl}`);
  if (full && full.success) {
    return {
      success: true,
      title: full.playlistTitle,
      author: full.playlistAuthor,
      count: full.items.length,
      thumb: (full.items[0] && full.items[0].thumb) || "",
    };
  }
  if (pendingFetches.has(cacheKey)) return await pendingFetches.get(cacheKey);

  const job = (async () => {
    // The page gives the count at once; yt-dlp then adds the author and the first thumbnail
    const quick = await fetchPlaylistSummaryFast(url);
    if (quick) {
      setCached(cacheKey, quick); // (the list itself brings the author and pictures)
      return quick;
    }
    await afterQuick();
    return fetchPlaylistSummarySlow(url, cacheKey);
  })();

  pendingFetches.set(cacheKey, job);
  try {
    return await job;
  } finally {
    pendingFetches.delete(cacheKey);
  }
}

async function fetchPlaylistSummarySlow(url, cacheKey) {
  {
    await engine.setup;
    const res = await runYtDlp(
      [
        url,
        "--flat-playlist",
        "-J",
        "--playlist-items",
        "1",
        "--no-warnings",
        "--no-call-home",
        "--encoding",
        "utf-8",
        ...getExtractorFlags(),
      ],
      15000,
    );
    try {
      const data = JSON.parse(res.stdout);
      const first = (data.entries || []).filter(Boolean)[0] || {};
      const count = Math.max(0, Math.round(Number(data.playlist_count) || 0));
      const summary = {
        success: !!(data.title || count),
        title: data.title || "",
        author:
          data.uploader ||
          data.channel ||
          first.channel ||
          first.uploader ||
          "",
        count, // 0 = this site doesn't say: wait for the list
        thumb:
          (first.thumbnails && first.thumbnails.length
            ? first.thumbnails[first.thumbnails.length - 1].url
            : first.id
              ? `https://i.ytimg.com/vi/${first.id}/hqdefault.jpg`
              : "") || "",
      };
      if (summary.success) setCached(cacheKey, summary);
      return summary;
    } catch {
      return { success: false };
    }
  }
}

/** --------------------------------------------------------------------------
 * FIND THE PLAYLIST OF A SINGLE VIDEO
 * YouTube has no "which playlists contain this video?" lookup, and a plain video link
 * carries no playlist. What can be done is to take the video's own channel, list that
 * channel's playlists and see which one holds the video (the usual case: a lecture that
 * belongs to its series). Playlists made by other people are out of reach.
 * -------------------------------------------------------------------------- */
function youtubeVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
    let id = "";
    if (host === "youtube.com")
      id =
        u.searchParams.get("v") ||
        (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/) ||
          [])[1] ||
        "";
    else if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
    return /^[\w-]{11}$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

// playlists read at the same time
let latestPlaylistSearch = 0;

async function findPlaylistOfVideo(url) {
  const videoId = youtubeVideoId(url);
  if (!videoId) return { success: false, reason: "unsupported" };

  const cacheKey = `video-playlist|${videoId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  if (pendingFetches.has(cacheKey)) return await pendingFetches.get(cacheKey);

  const mine = ++latestPlaylistSearch; // a newer search makes this one stop early
  const superseded = () => mine !== latestPlaylistSearch;

  const search = (async () => {
    // 1. The video's channel: oEmbed knows it in a fraction of a second (yt-dlp is the fallback)
    let fastChannel = "";
    try {
      const oe = await fetchJson(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
        2500,
      );
      if (oe && /^https?:\/\//i.test(String(oe.author_url || "")))
        fastChannel = String(oe.author_url);
    } catch {}
    const head = fastChannel
      ? { stdout: fastChannel }
      : await runYtDlp(
      [
        `https://www.youtube.com/watch?v=${videoId}`,
        "--no-playlist",
        "--skip-download",
        "--no-warnings",
        "--print",
        "%(channel_url)s",
        "--encoding",
        "utf-8",
        ...getExtractorFlags(),
      ],
      20000,
    );
    const channelUrl = head.stdout.trim().split(/\r?\n/).pop().trim();
    if (!/^https?:\/\//i.test(channelUrl))
      return { success: false, reason: "no-channel" };
    if (superseded()) return { success: false, reason: "superseded" };

    // 2. The channel's playlists
    const tab = await runYtDlp(
      [
        `${channelUrl.replace(/\/+$/, "")}/playlists`,
        "--flat-playlist",
        "-J",
        "--playlist-end",
        String(PLAYLIST_SEARCH_LIMIT),
        "--no-warnings",
        "--encoding",
        "utf-8",
        ...getExtractorFlags(),
      ],
      30000,
    );
    let playlists = [];
    try {
      const data = JSON.parse(tab.stdout);
      playlists = (data.entries || [])
        .filter(Boolean)
        .map(
          (e) =>
            e.url ||
            (e.id ? `https://www.youtube.com/playlist?list=${e.id}` : ""),
        )
        .filter((u) => /[?&]list=/.test(u));
    } catch {}
    if (!playlists.length) return { success: false, reason: "no-playlists" };

    // 3. Which of them holds the video (a few at a time, stopping at the first match)
    let found = null;
    let next = 0;
    const worker = async () => {
      while (!found && !superseded()) {
        const i = next++;
        if (i >= playlists.length) return;
        const res = await fetchPlaylistItemsInternal(playlists[i]);
        if (found || superseded()) return;
        if (res.success && res.items.some((it) => it.id === videoId))
          found = { ...res, playlistUrl: playlists[i] };
      }
    };
    await Promise.all(
      Array.from({ length: PLAYLIST_SEARCH_PARALLEL }, () => worker()),
    );

    if (superseded()) return { success: false, reason: "superseded" };
    return found
      ? { ...found, success: true }
      : { success: false, reason: "not-found" };
  })();

  pendingFetches.set(cacheKey, search);
  try {
    const result = await search;
    if (result.reason !== "superseded") setCached(cacheKey, result);
    return result;
  } finally {
    pendingFetches.delete(cacheKey);
  }
}

/** The user changed the link: stop analysing the old one (unless a download needs it). */
function cancelMediaInfo(url) {
  const norm = normalizeUrl(url);
  const pre = prefetchJobs.get(norm);
  if (pre) {
    pre.cancelled = true; // level 2 won't start if level 1 is still running
    prefetchJobs.delete(norm);
  }
  const job = analysisJobs.get(`info|${norm}`);
  if (job && !job.pinned) {
    job.cancelled = true;
    if (job.handle.kill) job.handle.kill();
  }
}

/** Forget everything read so far (the runtime or yt-dlp changed, so older answers may be wrong). */
function resetAnalysisCaches() {
  metadataCache.clear();
  prefetchJobs.clear();
}

module.exports = {
  cancelMediaInfo,
  ensurePrefetch,
  fetchLinkPreview,
  fetchMediaInfo,
  fetchPlaylistItemsInternal,
  fetchPlaylistSummary,
  findPlaylistOfVideo,
  languageByUrl,
  parseOptions,
  prefetchPrefs,
  freshRawInfoFile,
  rawInfoFiles,
  resetAnalysisCaches,
  watchClipboard,
};
