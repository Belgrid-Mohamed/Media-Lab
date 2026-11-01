const { app } = require("electron");
const path = require("path");

const FOCUS_HOLD_MS = 15000;

// each request from the feature keeps the focus for this long
const FOCUS_CHANNELS = new Set([
  "stream-open",
  "stream-chunk",
  "stream-tiles",
  "stream-prefetch",
  "prepare-preview",
  "fetch-media-info",
  "fetch-quick-info",
  "fetch-playlist-items",
  "fetch-playlist-summary",
  "find-video-playlist",
]);

const isWin = process.platform === "win32";

const CACHE_TTL_MS = 15 * 60 * 1000;

const TRACKING_PARAMS = [
  "si",
  "feature",
  "pp",
  "fbclid",
  "igshid",
  "gclid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
];

const TRAY_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAfElEQVR42mNgwAM++Cn/pwZmIAVQy1KyHENry/E6gl6WY3UEvS3HcMTIdgC5mtEB2Y4YdcCoA0YdMCQcQC6gagjQwnKSo4DalpOVBqhpOdmJkFqWD+1siOwIiqrkgWoLDB0HUAoobhXR0gGjjdLB0zEZFF2zQdE5HYjuOQBivo0oCnS2CgAAAABJRU5ErkJggg==";

/** The site's name could not be looked up (DNS): a problem of the network, not of the link. */
const DNS_ERROR =
  /Failed to resolve|getaddrinfo failed|Name or service not known|Temporary failure in name resolution|nodename nor servname/i;

/** The site was found but could not be reached or the connection broke off. */
const CONNECT_ERROR =
  /Failed to establish a new connection|Network is unreachable|No route to host|Connection (?:refused|reset|aborted)|Remote end closed connection|timed out/i;

/** YouTube wants proof that a person is behind the request (it flags some networks). */
const BOT_ERROR = /not a bot|--cookies-from-browser|--cookies for the authentication/i;

const IS_YOUTUBE_URL = /(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/i;

/** Browsers whose signed-in YouTube session can be borrowed, best first. */
const COOKIE_BROWSERS = ["firefox", "edge", "chrome", "brave", "opera", "vivaldi"];

/** The only qualities the app ever offers (nothing else is listed or computed). */
const QUALITY_HEIGHTS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];

// yt-dlp's own preference orders (best first). The estimate below follows them so it
// predicts the streams a download will really pick. Matching is anchored at the start,
// exactly like yt-dlp's.
const VCODEC_ORDER = [
  "av0?1",
  "vp0?9.2",
  "vp0?9",
  "[hx]265|he?vc?",
  "h264|avc",
  "vp0?8",
  "mp4v|h263",
  "theora",
].map((r) => new RegExp(`^(?:${r})`, "i"));

const ACODEC_ORDER = [
  "[af]lac",
  "wav|aiff",
  "opus",
  "vorbis|ogg",
  "aac",
  "mp?4a?",
  "mp3",
  "ac-?4",
  "e-?a?c-?3",
  "ac-?3",
  "dts",
].map((r) => new RegExp(`^(?:${r})`, "i"));

// What the download asks for with -S: MP4/MKV/MOV -> h264 + m4a, WebM -> vp9 + opus
const SIZE_FAMILIES = {
  mp4: { video: 4, audio: 5 },
  webm: { video: 2, audio: 2 },
};

/** --------------------------------------------------------------------------
 * LOCAL PREVIEW FILE
 * YouTube increasingly hides direct stream addresses (and its preview pictures) from
 * yt-dlp, so the trim popover can't always play a stream. Instead, yt-dlp downloads a
 * tiny copy exactly like a normal download does (240p, low-bitrate audio: a few MB).
 * It lives in the temp folder, is played through mbpreview://, and is deleted on exit.
 * -------------------------------------------------------------------------- */
const previewDir = path.join(app.getPath("temp"), "mb-media-preview");

// normalized link -> Promise (one download per link)
const MAX_PREVIEW_FILES = 8;

/**
 * FAST PREVIEW
 * A preview used to mean downloading the whole small copy before anything played, one job
 * at a time, and every job also repeated YouTube's slow look-up. Now:
 *   1. The analysis the composer already made (every format and its address) is kept in a
 *      temp file, and every preview job starts from it (--load-info-json): no second look-up.
 *   2. The first few seconds are fetched on their own (--download-sections) and play at once.
 *   3. The whole small copy keeps downloading in the background, in parallel, reporting its
 *      progress; when it is ready the player carries on from the same moment.
 */
const PREVIEW_HEAD_SECONDS = 8;

// link -> Set of running yt-dlp handles (for cancel)
const MAX_FULL_PREVIEWS_AT_ONCE = 2;

// request id -> piece key
const MAX_STREAM_SESSIONS = 6;

const MAX_CHUNK_FILES = 90;

const MAX_CHUNKS_AT_ONCE = 3;

const STREAM_MIME_AV = 'video/mp4; codecs="avc1.42c028,mp4a.40.2"';

const STREAM_MIME_V = 'video/mp4; codecs="avc1.42c028"';

// link -> Promise (two callers at once share one)
const STREAM_FIRST = 3;

const FFMPEG_BASE = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];

/* ---- the filmstrip: a picture for each slice of the timeline, one by one ---- */
const MAX_TILES_AT_ONCE = 6;

/** Filmstrip pictures: sent one by one as they are ready (pictures already made are sent again at once). */
/** The filmstrip is always the same 24 slices of the video (the window picks the ones it needs). */
const TILE_COUNT = 24;

const TILE_HEIGHT = 60;

/** The preview heights the player's quality menu offers; 0 = automatic. */
const PREVIEW_HEIGHTS = [144, 240, 360, 480, 720, 1080];

/**
 * Flags for link analysis only. "skip=translated_subs" stops yt-dlp from building a
 * list of machine-translated captions in every language (megabytes of JSON the app
 * never reads); the retry / timeout flags make a bad link fail fast.
 */
const ANALYSIS_FLAGS = [
  "--no-playlist",
  "-J",
  "--no-warnings",
  "--no-call-home",
  "--encoding",
  "utf-8",
  "--extractor-retries",
  "2",
  "--socket-timeout",
  "30",
  "--extractor-args",
  "youtube:skip=translated_subs",
];

// cache key -> { promise, handle, pinned, cancelled }
const MAX_PARALLEL_ANALYSES = 2;

/** Lean call: no formats list, no HLS manifest, no translated captions. */
const QUICK_FLAGS = [
  "--no-playlist",
  "--skip-download",
  "--no-warnings",
  "--no-call-home",
  "--encoding",
  "utf-8",
  "--extractor-retries",
  "2",
  "--socket-timeout",
  "30",
  "--extractor-args",
  "youtube:skip=hls,translated_subs",
];

const PREFETCH_HOSTS =
  /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|soundcloud\.com|dailymotion\.com|twitter\.com|x\.com|facebook\.com|fb\.watch|instagram\.com|twitch\.tv|reddit\.com|bilibili\.com|bandcamp\.com|mixcloud\.com)$/i;

const PLAYLIST_SEARCH_LIMIT = 60;

// playlists looked at per channel
const PLAYLIST_SEARCH_PARALLEL = 4;

/** Hidden folder (next to the download) that holds the unfinished files of a download. */
const PARTIAL_DIR_NAME = ".mb-partial";

const MOV_FILE = /\.(mp4|m4v|m4a|mov)$/i;

const MKV_FILE = /\.(mkv|webm)$/i;

module.exports = {
  ACODEC_ORDER,
  ANALYSIS_FLAGS,
  BOT_ERROR,
  CACHE_TTL_MS,
  CONNECT_ERROR,
  COOKIE_BROWSERS,
  DNS_ERROR,
  FFMPEG_BASE,
  FOCUS_CHANNELS,
  FOCUS_HOLD_MS,
  IS_YOUTUBE_URL,
  MAX_CHUNKS_AT_ONCE,
  MAX_CHUNK_FILES,
  MAX_FULL_PREVIEWS_AT_ONCE,
  MAX_PARALLEL_ANALYSES,
  MAX_PREVIEW_FILES,
  MAX_STREAM_SESSIONS,
  MAX_TILES_AT_ONCE,
  MKV_FILE,
  MOV_FILE,
  PARTIAL_DIR_NAME,
  PLAYLIST_SEARCH_LIMIT,
  PLAYLIST_SEARCH_PARALLEL,
  PREFETCH_HOSTS,
  PREVIEW_HEAD_SECONDS,
  PREVIEW_HEIGHTS,
  QUALITY_HEIGHTS,
  QUICK_FLAGS,
  SIZE_FAMILIES,
  STREAM_FIRST,
  STREAM_MIME_AV,
  STREAM_MIME_V,
  TILE_COUNT,
  TILE_HEIGHT,
  TRACKING_PARAMS,
  TRAY_ICON,
  VCODEC_ORDER,
  isWin,
  previewDir,
};
