/** ============================================================================
 * downloads-scripts/core.js
 * Core of the Downloads page: everything that is not the queue, the trim engine, the video player or the playlist explorer.
 * Loads FIRST. Its last section (boot) waits for DOMContentLoaded, so it starts the page only after every other file has loaded.
 *
 * Sections (in file order) and their features:
 *
 *  [dom-and-state] Grabs every DOM element the Downloads page uses and loads the saved queue.
 *    - Element references: URL bar, toolbar buttons, header menus, window controls, trim popover, format & quality popover, playlist popover and side panel
 *    - Loads the saved queue from localStorage (key: downloadsQueue)
 *    - Selection / focus state shared by the queue scripts (focusedTaskId, anchorTaskId, visibleIds, contextMenuEl)
 *
 *  [helpers-and-ui] Small shared helpers plus the toast and modal UI.
 *    - HTML escaping and safe image URLs (esc, safeImgUrl)
 *    - Formatting and parsing: bytes, clock times (formatBytes, formatClock, parseClock)
 *    - Settings readers (readStr, readBool), theme and language (applyTheme, applyLanguage), loadText
 *    - saveQueue (writes the queue to localStorage)
 *    - showToast and showModal
 *    - updateButtonStates (enables/disables toolbar buttons from the queue)
 *
 *  [header-menus] The header: File / Tools / Help dropdowns, import & export, window controls and the Settings window opener.
 *    - Dropdown toggling (closeAllDropdowns, toggleDropdown)
 *    - File menu: import links from a file, export the queue, exit
 *    - Window controls: tray, minimize, maximize, close
 *    - Settings modal overlay (openSettingsModal)
 *
 *  [composer-state] The URL bar composer: its shared state, defaults, locking and popover plumbing.
 *    - appState (url, link info, format, quality, trim, playlist state)
 *    - Quality and bitrate tables, normQuality, heightBadge, offered heights, size estimates
 *    - Defaults loaded from Settings (loadDefaultsFromSettings)
 *    - Locking controls until the link is analysed (syncComposerLock, popover covers)
 *    - Popover placement and closing (placePopover, closeAllPopovers)
 *    - Capsule toggles for cut, chapters, subtitles that follow the Settings values
 *
 *  [format-quality] The format & quality popover.
 *    - Format pills (MP4, audio formats, ...) and setFormat
 *    - Quality list with real sizes per quality (renderQualityOptions)
 *    - Estimated size line (updateEstimatedSize)
 *    - 'Make these my defaults' button
 *
 *  [link-analysis] Analyses a pasted link and watches the clipboard.
 *    - onUrlChanged (debounced) and analyze: quick info first, then the full details
 *    - resetComposer and refreshLinkUI
 *    - Auto-detect links on the clipboard (checkClipboard) on focus, visibility change and a timer
 *
 *  [add-to-queue] Adding links to the queue.
 *    - resolveSaveFolder (default folder or ask each time)
 *    - Duplicate handling (applyDuplicatePolicy, taskKey)
 *    - enqueueSingle and enqueuePlaylist
 *    - triggerDownload (Download button / Enter in the URL bar)
 *
 *  [settings-and-ipc] Reacts to Settings changes and to events from the main process.
 *    - onSettingsChanged: re-applies theme, language and the cut / chapters / subtitles defaults, then re-checks auto-detect and the data limit
 *    - IPC listeners: download progress, complete, error
 *    - reconcileWithMain: re-syncs the queue with the main process on startup
 *    - startupEngineCheck: checks for a yt-dlp update shortly after start
 *
 *  [boot] Startup: runs the first render and starts the queue. Must be the last script loaded.
 *    - Applies defaults, first renders, then reconciles with the main process
 *    - Then starts processNext, checks the clipboard and schedules the engine check
 *
 * Split from the old downloads-script.js. The five files are classic scripts that share one
 * scope (like the old single closure), so they can call each other's functions freely.
 * Load order, set in downloads-index.html: core, queue-scripts, trim-engine, video-player, playlist-explorer.
 * ========================================================================== */

/* ############################################################################
 # SECTION: dom-and-state
 # Grabs every DOM element the Downloads page uses and loads the saved queue.
 ############################################################################ */

const STORAGE_KEY = "downloadsQueue";
const FALLBACK_THUMB =
  "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=150&q=80";

// Elements
const urlInput = document.getElementById("urlInput");
const downloadBtn = document.getElementById("downloadBtn");
const queueList = document.getElementById("queueList");
const emptyQueueState = document.getElementById("emptyQueueState");
const queueSearchInput = document.getElementById("queueSearchInput");
const toastContainer = document.getElementById("toastContainer");
const importFileInput = document.getElementById("importFileInput");

// Feature Toggle Buttons
const btnToggleCut = document.getElementById("btnToggleCut");
const btnToggleChapters = document.getElementById("btnToggleChapters");
const btnToggleSubtitles = document.getElementById("btnToggleSubtitles");

// Toolbar Action Controls

// Selection & Queue Counter Controls
const queueCounterText = document.getElementById("queueCounterText");
const selectedCounterText = document.getElementById("selectedCounterText");
const toggleSelectAllBtn = document.getElementById("toggleSelectAllBtn");

// Header Menus
const menuFileBtn = document.getElementById("menuFileBtn");
const fileDropdown = document.getElementById("fileDropdown");
const fileImport = document.getElementById("fileImport");
const fileExport = document.getElementById("fileExport");
const fileExit = document.getElementById("fileExit");

const menuToolsBtn = document.getElementById("menuToolsBtn");
const toolsDropdown = document.getElementById("toolsDropdown");
const helpDropdownBtn = document.getElementById("helpDropdownBtn");
const helpDropdown = document.getElementById("helpDropdown");
const openSettingsModalBtn = document.getElementById("openSettingsModalBtn");

// Window Controls
const winTray = document.getElementById("winTray");
const winMinimize = document.getElementById("winMinimize");
const winMaximize = document.getElementById("winMaximize");
const winClose = document.getElementById("winClose");

let queue = [];
try {
  queue = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
} catch {
  queue = [];
}
if (!Array.isArray(queue)) queue = [];

const selectedTaskIds = new Set();
let focusedTaskId = null; // keyboard focus line
let anchorTaskId = null; // where Shift-ranges start
let visibleIds = []; // task ids in the order they are shown (after filter/sort)
let contextMenuEl = null;

// Trim popover
const trimPopover = document.getElementById("trimPopover");
const closeTrimPopoverBtn = document.getElementById("closeTrimPopoverBtn");
const trimModal = trimPopover; // the loading cover is laid over the popover
const trimVideo = document.getElementById("trimVideo");
const trimPreviewNote = document.getElementById("trimPreviewNote");
const trimPreview = document.getElementById("trimPreview");
const trimPreviewThumb = document.getElementById("trimPreviewThumb");
const trimPreviewFrame = document.getElementById("trimPreviewFrame");
const trimPlayBtn = document.getElementById("trimPlayBtn");
const trimSlider = document.getElementById("trimSlider"); // the timeline
const trimFilmstrip = document.getElementById("trimFilmstrip");
const trimShadeLeft = document.getElementById("trimShadeLeft");
const trimShadeRight = document.getElementById("trimShadeRight");
const trimRange = document.getElementById("trimRange");
const trimHandleStart = document.getElementById("trimHandleStart");
const trimHandleEnd = document.getElementById("trimHandleEnd");
const trimChaptersSection = document.getElementById("trimChaptersSection");
const trimStartInput = document.getElementById("trimStartInput");
const trimEndInput = document.getElementById("trimEndInput");
const trimMinLabel = document.getElementById("trimMinLabel");
const trimMaxLabel = document.getElementById("trimMaxLabel");
const trimClipLengthText = document.getElementById("trimClipLengthText");
const chaptersPillList = document.getElementById("chaptersPillList");
const trimResetBtn = document.getElementById("trimResetBtn");
const trimDoneBtn = document.getElementById("trimDoneBtn");

// Format & quality popover
const formatQualityPopover = document.getElementById("formatQualityPopover");
const quickFormatQualityBtn = document.getElementById(
  "quickFormatQualityBtn",
);
const quickFormatQualityLabel = document.getElementById(
  "quickFormatQualityLabel",
);
const formatPillGroup = document.getElementById("formatPillGroup");
const qualityOptionsList = document.getElementById("qualityOptionsList");
const fqEstimatedSizeText = document.getElementById("fqEstimatedSizeText");
const btnMakeDefaultFormat = document.getElementById("btnMakeDefaultFormat");

// Playlist button + popover (they replace the link icon once a link is pasted)
const urlLinkIcon = document.getElementById("urlLinkIcon");
const playlistPeekWrapper = document.getElementById("playlistPeekWrapper");
const btnExplorePlaylist = document.getElementById("btnExplorePlaylist");
const playlistPeekBadge = document.getElementById("playlistPeekBadge");
const playlistPopover = document.getElementById("playlistPopover");
const playlistPopoverHost = document.getElementById("playlistPopoverView");
// Playlist side panel (opened from "Explore Playlist" in the queue's right-click menu)
const playlistViewContainer = document.getElementById(
  "playlistViewContainer",
);
const playlistPanelHost = document.getElementById("playlistPanelView");
const togglePlaylistViewBtn = document.getElementById(
  "togglePlaylistViewBtn",
);

/* ############################################################################
 # SECTION: helpers-and-ui
 # Small shared helpers plus the toast and modal UI.
 ############################################################################ */

/** --------------------------------------------------------------------------
 * SMALL HELPERS
 * -------------------------------------------------------------------------- */
/** HTML-escape anything that came from the network before it touches innerHTML. */
function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

function safeImgUrl(u) {
  return /^https?:\/\//i.test(u || "") ? u : FALLBACK_THUMB;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  const v = bytes / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Accepts "90", "1:30" or "01:01:30". Returns seconds, or null if unreadable. */
function parseClock(text) {
  const parts = String(text || "")
    .trim()
    .split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p.trim())))
    return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

function readStr(key, fallback) {
  const v = localStorage.getItem(key);
  return v === null || v === "" ? fallback : v;
}

function isAudioFormat(fmt) {
  return AUDIO_FORMATS.includes(String(fmt || "").toUpperCase());
}

function isPlaceholderTitle(t) {
  return !t || /^fetching info/i.test(t);
}

function loadText(url) {
  return fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    })
    .catch(
      () =>
        new Promise((resolve, reject) => {
          const x = new XMLHttpRequest();
          x.open("GET", url);
          x.onload = () => resolve(x.responseText);
          x.onerror = () => reject(new Error("Could not load " + url));
          x.send();
        }),
    );
}

/** Light / dark / system theme + interface language attribute. */
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const pref = readStr("prefTheme", "dark");
  const resolved =
    pref === "system" ? (systemDark.matches ? "dark" : "light") : pref;
  document.documentElement.dataset.theme = resolved;
}
/** Switches the interface language at once: i18n.js retranslates the page, then redraws it. */
function applyLanguage() {
  i18n.setLanguage(readStr("prefLanguage", "en"));
}
// Parts drawn by scripts are drawn again in the new language
window.addEventListener("languageChanged", () => {
  removeContextMenu();
  renderQueue();
  updateButtonStates();
  if (typeof refreshLinkUI === "function") refreshLinkUI();
});
systemDark.addEventListener("change", applyTheme);
applyTheme();
applyLanguage();

function sanitizeFormat(fmt) {
  if (!fmt) return "MP4";
  return fmt.replace(/\s*\(.*?\)/g, "").trim();
}

function saveQueue() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch (err) {
    console.warn("Queue save error:", err);
  }
}

function readBool(key, fallback) {
  const v = localStorage.getItem(key);
  return v === null ? fallback : v === "true";
}

/** --------------------------------------------------------------------------
 * UI FEEDBACK: TOASTS & MODALS
 * -------------------------------------------------------------------------- */
function showToast(message, type = "info", duration = 3000) {
  if (!toastContainer) return;
  const card = document.createElement("div");
  card.className = `toast-card ${type}`;
  const text = document.createElement("span");
  text.textContent = tr(message);
  const close = document.createElement("span");
  close.textContent = "✕";
  close.style.cssText = "cursor:pointer; opacity:0.6; font-size:0.8rem;";
  close.addEventListener("click", () => card.remove());
  card.append(text, close);
  toastContainer.appendChild(card);
  setTimeout(() => {
    card.style.opacity = "0";
    card.style.transform = "translateY(10px)";
    card.style.transition = "all 0.2s ease";
    setTimeout(() => card.remove(), 200);
  }, duration);
}

function showModal({ title, message, buttons = [] }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "custom-modal-backdrop";

    const box = document.createElement("div");
    box.className = "custom-modal-box";

    const titleEl = document.createElement("div");
    titleEl.className = "custom-modal-title";
    titleEl.textContent = tr(title);

    const msgEl = document.createElement("div");
    msgEl.className = "custom-modal-msg";
    msgEl.textContent = tr(message);

    const actionsEl = document.createElement("div");
    actionsEl.className = "custom-modal-actions";

    buttons.forEach((btn) => {
      const b = document.createElement("button");
      b.className =
        btn.type === "danger"
          ? "btn-danger-action"
          : btn.type === "primary"
            ? "btn-download-action"
            : "btn-secondary-action";
      b.textContent = tr(btn.text);
      b.addEventListener("click", () => {
        backdrop.remove();
        resolve(btn.key);
      });
      actionsEl.appendChild(b);
    });

    box.appendChild(titleEl);
    box.appendChild(msgEl);
    box.appendChild(actionsEl);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
  });
}

/** --------------------------------------------------------------------------
 * TOOLBAR BUTTON GREYING & COUNTERS
 * -------------------------------------------------------------------------- */
function updateButtonStates() {
  if (queueCounterText) {
    queueCounterText.textContent = tr(queue.length === 1 ? "{n} item in queue" : "{n} items in queue", { n: queue.length });
  }

  if (selectedCounterText) {
    const selectedCount = selectedTaskIds.size;
    selectedCounterText.textContent = tr("{n} selected", { n: selectedCount });
    selectedCounterText.style.color =
      selectedCount > 0 ? "var(--primary-accent)" : "";
  }
}

if (toggleSelectAllBtn) {
  toggleSelectAllBtn.addEventListener("click", () => {
    if (visibleIds.length > 0 && selectedTaskIds.size === visibleIds.length) {
      setSelection([]);
    } else {
      selectAllVisible();
    }
  });
}

/* ############################################################################
 # SECTION: header-menus
 # The header: File / Tools / Help dropdowns, import & export, window controls and the Settings window opener.
 ############################################################################ */

/** --------------------------------------------------------------------------
 * HEADER DROPDOWN TOGGLES
 * -------------------------------------------------------------------------- */
function closeAllDropdowns() {
  if (fileDropdown) fileDropdown.classList.add("hidden");
  if (toolsDropdown) toolsDropdown.classList.add("hidden");
  if (helpDropdown) helpDropdown.classList.add("hidden");
  removeContextMenu();
}

function toggleDropdown(btn, dropdown) {
  if (!dropdown) return;
  const isHidden = dropdown.classList.contains("hidden");
  closeAllDropdowns();
  if (isHidden) dropdown.classList.remove("hidden");
}

if (menuFileBtn)
  menuFileBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDropdown(menuFileBtn, fileDropdown);
  });

if (menuToolsBtn)
  menuToolsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDropdown(menuToolsBtn, toolsDropdown);
  });

if (helpDropdownBtn)
  helpDropdownBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDropdown(helpDropdownBtn, helpDropdown);
  });

document.addEventListener("click", closeAllDropdowns);

/** --------------------------------------------------------------------------
 * FILE MENU IMPORT & EXPORT
 * -------------------------------------------------------------------------- */
if (fileImport) {
  fileImport.addEventListener("click", () => {
    if (importFileInput) importFileInput.click();
  });
}

if (importFileInput) {
  importFileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const content = evt.target.result;
        let links = [];

        if (file.name.endsWith(".json")) {
          const parsed = JSON.parse(content);
          links = Array.isArray(parsed)
            ? parsed.map((item) =>
                typeof item === "string" ? item : item.url,
              )
            : [];
        } else {
          links = content
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.startsWith("http"));
        }

        let addedCount = 0;
        links.forEach((url) => {
          if (isValidMediaUrl(url)) {
            queue.unshift({
              id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              url,
              title: "Fetching info...",
              thumb: FALLBACK_THUMB,
              progress: 0,
              status: "queued",
              format: appState.selectedFormat,
              quality: appState.selectedQuality,
              createdAt: new Date().toISOString(),
            });
            addedCount++;
          }
        });

        saveQueue();
        renderQueue();
        processNext();
        showToast(tr("Imported {n} links into queue", { n: addedCount }), "success");
      } catch {
        showToast("Failed to parse import file", "error");
      }
      importFileInput.value = "";
    };
    reader.readAsText(file);
  });
}

if (fileExport) {
  fileExport.addEventListener("click", () => {
    if (queue.length === 0) {
      showToast("Queue is empty", "warning");
      return;
    }
    const dataStr =
      "data:text/json;charset=utf-8," +
      encodeURIComponent(JSON.stringify(queue, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute(
      "download",
      `downloads-queue-${Date.now()}.json`,
    );
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    showToast("Downloads list exported successfully", "success");
  });
}

if (fileExit) {
  fileExit.addEventListener("click", () => {
    if (window.api && window.api.close) window.api.close();
  });
}

/** --------------------------------------------------------------------------
 * SETTINGS MODAL OVERLAY INJECTION
 * -------------------------------------------------------------------------- */
let settingsModalOverlay = null;

async function openSettingsModal() {
  closeAllDropdowns();
  closeAllPopovers();
  if (!settingsModalOverlay) {
    try {
      const html = await loadText("../Settings/settings-index.html");
      const wrapper = document.createElement("div");
      wrapper.id = "settingsModalOverlay";
      wrapper.className = "settings-modal-overlay";
      wrapper.innerHTML = html;
      i18n.apply(wrapper); // the Settings window opens in the language already chosen
      document.body.appendChild(wrapper);
      settingsModalOverlay = wrapper;

      const script = document.createElement("script");
      script.src = "../Settings/settings-script.js";
      document.body.appendChild(script);
    } catch (err) {
      showToast("Failed to open Settings modal", "error");
    }
  } else {
    settingsModalOverlay.classList.remove("hidden");
    // Pick up anything changed elsewhere (e.g. "Make this my default")
    window.dispatchEvent(new Event("settingsRefresh"));
  }
}

if (openSettingsModalBtn) {
  openSettingsModalBtn.addEventListener("click", openSettingsModal);
}

/** --------------------------------------------------------------------------
 * WINDOW CONTROLS
 * -------------------------------------------------------------------------- */
if (winTray) {
  winTray.addEventListener("click", () => {
    if (window.api && window.api.minimizeToTray) window.api.minimizeToTray();
    else if (window.api && window.api.hide) window.api.hide();
  });
}

if (winMinimize) {
  winMinimize.addEventListener("click", () => {
    if (window.api && window.api.minimize) window.api.minimize();
  });
}

if (winMaximize) {
  winMaximize.addEventListener("click", () => {
    if (window.api && window.api.maximize) window.api.maximize();
  });
}

if (winClose) {
  winClose.addEventListener("click", () => {
    if (window.api && window.api.close) window.api.close();
    else window.close();
  });
}

/* ############################################################################
 # SECTION: composer-state
 # The URL bar composer: its shared state, defaults, locking and popover plumbing.
 ############################################################################ */

/** ==========================================================================
 * URL BAR COMPOSER: real link analysis, trim (cut), format & quality
 * Cut and Quality stay disabled until a link has been analysed, so every
 * quality, size and chapter shown comes from the link itself.
 * ======================================================================== */
const appState = {
  url: "",
  info: null, // level 2: full analysis (every quality + size, chapters)
  quick: null, // level 1: title, thumbnail, duration, size of the default quality
  preview: null, // instant title / thumbnail
  sizeStaging: false, // sizes are being revealed one format at a time (see revealSizes)
  sizeReady: new Set(), // formats whose sizes may be shown already
  quickSel: "", // "FORMAT|quality" that level 1's size was measured for
  quickPending: false,
  fullPending: false,
  fullStarted: false, // level 2 (qualities, chapters, storyboard) is on its way
  embedChapters: true, // this download only; settings decide the starting value
  embedCaptions: false,
  failed: false,
  loading: false, // only while a playlist is being read
  isPlaylist: false,
  playlist: null, // { url, title, author, items: [{..., selected}] }
  single: null, // the same shape for a lone video, so the popover can list it too
  found: null, // { searching, model }: the playlist found for a lone video (popover only)
  selectedFormat: "MP4",
  selectedQuality: "1080p",
  trim: { active: false, start: 0, end: 0, exact: false },
};
let playlistViewsReady = false; // true once both playlist views below exist

/** The only qualities the app offers: nothing else is listed or looked up. */
const QUALITY_HEIGHTS = [4320, 2160, 1440, 1080, 720, 480, 360, 240, 144];
const BITRATES = [
  { label: "320 kbps", badge: "Ultra High", kbps: 320 },
  { label: "256 kbps", badge: "High Quality", kbps: 256 },
  { label: "192 kbps", badge: "Standard", kbps: 192 },
  { label: "128 kbps", badge: "Compact", kbps: 128 },
];
const AUDIO_KBPS = BITRATES.map((o) => o.kbps);

/* ---- the formats and qualities offered: read from the Settings page ----
 * Settings (settings-index.html) is the one place that lists them, so a format or quality
 * added there (a new <div class="custom-select-option" data-value="…">) shows up here
 * by itself: as a pill, a quality row, and a valid default. The lists below are only the
 * fallback used until (or if) that page can't be read. The arrays are changed in place. */
const VIDEO_FORMATS = [
  { value: "MP4", label: "MP4" },
  { value: "MKV", label: "MKV" },
  { value: "MOV", label: "MOV" },
  { value: "WEBM", label: "WebM" },
];
const AUDIO_FORMATS = ["MP3", "M4A"];
const AUDIO_BADGES = {
  320: "Ultra High",
  256: "High Quality",
  192: "Standard",
  128: "Compact",
  96: "Low",
  64: "Low",
};

function readMenuOptions(doc, menuId) {
  const menu = doc.getElementById(menuId);
  if (!menu) return [];
  return [...menu.querySelectorAll(".custom-select-option[data-value]")].map(
    (o) => ({
      value: o.dataset.value.trim(),
      label: o.textContent.replace(/\s+/g, " ").trim(),
    }),
  );
}

async function loadOptionCatalog() {
  try {
    const html = await loadText("../Settings/settings-index.html");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const vf = readMenuOptions(doc, "prefVideoFormatMenu");
    const af = readMenuOptions(doc, "prefAudioFormatMenu");
    const vq = readMenuOptions(doc, "prefVideoQualityMenu")
      .map((o) => parseInt(o.value, 10))
      .filter((n) => n > 0);
    const aq = readMenuOptions(doc, "prefAudioQualityMenu")
      .map((o) => parseInt(o.value, 10))
      .filter((n) => n > 0);
    if (vf.length)
      VIDEO_FORMATS.splice(
        0,
        VIDEO_FORMATS.length,
        ...vf.map((o) => ({ value: o.value.toUpperCase(), label: o.label })),
      );
    if (af.length)
      AUDIO_FORMATS.splice(0, AUDIO_FORMATS.length, ...af.map((o) => o.value.toUpperCase()));
    if (vq.length)
      QUALITY_HEIGHTS.splice(0, QUALITY_HEIGHTS.length, ...[...new Set(vq)].sort((a, b) => b - a));
    if (aq.length) {
      BITRATES.splice(
        0,
        BITRATES.length,
        ...[...new Set(aq)]
          .sort((a, b) => b - a)
          .map((k) => ({ label: `${k} kbps`, badge: AUDIO_BADGES[k] || "", kbps: k })),
      );
      AUDIO_KBPS.splice(0, AUDIO_KBPS.length, ...BITRATES.map((o) => o.kbps));
    }
  } catch {}
  buildFormatPills();
  if (typeof refreshLinkUI === "function") refreshLinkUI();
}

/** The format pills: the video formats, then the audio ones, as Settings lists them. */
function buildFormatPills() {
  formatPillGroup.innerHTML = "";
  const add = (value, label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "format-pill";
    b.dataset.format = value;
    b.textContent = label;
    formatPillGroup.appendChild(b);
  };
  VIDEO_FORMATS.forEach((f) => add(f.value, f.label.toUpperCase()));
  AUDIO_FORMATS.forEach((f) => add(f, f));
  renderPills();
}

/** Maps any stored quality (old values included) onto one of the listed options. */
function normQuality(q, audio) {
  const t = String(q || "").trim();
  if (audio) {
    const k = t.match(/(\d{2,3})\s*k/i);
    const want = k ? Number(k[1]) : 320; // "best" / empty -> the top bitrate
    const near = AUDIO_KBPS.reduce((a, b) =>
      Math.abs(b - want) < Math.abs(a - want) ? b : a,
    );
    return `${near} kbps`;
  }
  if (!t) return "1080p";
  if (/^best/i.test(t) || /^8\s*k/i.test(t)) return "4320p";
  if (/^4\s*k/i.test(t)) return "2160p";
  if (/^2\s*k/i.test(t)) return "1440p";
  const p = t.match(/^(\d{3,4})\s*p/i);
  if (p) {
    const fit = QUALITY_HEIGHTS.filter((x) => x <= Number(p[1]));
    return `${fit.length ? fit[0] : QUALITY_HEIGHTS[QUALITY_HEIGHTS.length - 1]}p`;
  }
  return "1080p";
}

function heightBadge(h) {
  if (h >= 4320) return "8K";
  if (h >= 2160) return "4K";
  if (h >= 1440) return "2K";
  if (h >= 1080) return "Full HD";
  if (h >= 720) return "HD";
  return "SD";
}

/** The format + quality a new link starts with ("Make these my defaults" decides video or audio). */
function effectiveDefaults() {
  if (readStr("prefDefaultType", "video") === "audio")
    return {
      format: readStr("prefAudioFormat", "MP3").toUpperCase(),
      quality: normQuality(readStr("prefAudioQuality", "320k"), true),
    };
  return {
    format: readStr("prefFormat", "MP4").toUpperCase(),
    quality: normQuality(readStr("prefQuality", "1080p"), false),
  };
}

function loadDefaultsFromSettings() {
  const d = effectiveDefaults();
  appState.selectedFormat = d.format;
  appState.selectedQuality = d.quality;
}

const duration = () =>
  (appState.info && appState.info.duration) ||
  (appState.quick && appState.quick.duration) ||
  0;
const selKey = () => `${appState.selectedFormat}|${appState.selectedQuality}`;
/** True while level 2 (qualities + chapters) is still on its way. */
const isFullPending = () => appState.fullPending && !appState.info;
const isLiveLink = () => !!(appState.info?.isLive ?? appState.quick?.isLive);

function loadingRow(text) {
  const row = document.createElement("div");
  row.className = "q-loading";
  const spin = document.createElement("span");
  spin.className = "mini-spinner";
  const label = document.createElement("span");
  label.textContent = text;
  row.append(spin, label);
  return row;
}

/** Standard heights this link can really give (all of them until its streams are known). */
function offeredHeights() {
  const max = appState.info?.maxHeight || 0;
  if (!max) return QUALITY_HEIGHTS.slice();
  const ceiling =
    QUALITY_HEIGHTS.slice()
      .reverse()
      .find((h) => h >= max) || QUALITY_HEIGHTS[0];
  return QUALITY_HEIGHTS.filter((h) => h <= ceiling);
}

/** Highest offered height not above the wanted one. */
function pickVideoQuality(wanted) {
  const want = parseInt(wanted, 10) || 1080;
  const usable = offeredHeights();
  const fit = usable.filter((h) => h <= want);
  return `${fit.length ? fit[0] : usable[usable.length - 1]}p`;
}

function clipFraction() {
  const d = duration();
  return appState.trim.active && d
    ? Math.max(0.001, (appState.trim.end - appState.trim.start) / d)
    : 1;
}

/** Estimated bytes for a quality option, from the link's real stream list. */
function qualityBytes(quality, fmt = appState.selectedFormat) {
  const info = appState.info;
  const dur = duration();
  if (!dur) return 0;
  if (appState.sizeStaging && !appState.sizeReady.has(String(fmt).toUpperCase()))
    return 0;
  let bytes = 0;
  if (isAudioFormat(fmt)) {
    const k = /(\d{2,3})\s*k/i.exec(quality);
    bytes = Number(k ? k[1] : 320) * 125 * dur;
  } else {
    const entry = info?.qualitySizes?.[String(parseInt(quality, 10))];
    bytes = entry ? entry[/webm/i.test(fmt) ? "webm" : "mp4"] || 0 : 0;
  }
  return Math.round(bytes * clipFraction());
}

/* ---- lock / unlock controls ---- */
function lockReason(what) {
  if (appState.loading) return "Analyzing link…";
  if (appState.isPlaylist && what === "trim")
    return "Trimming isn't available for playlists";
  if (isLiveLink()) return "Live streams can't be trimmed";
  return what === "trim"
    ? "Paste a link to enable trimming"
    : "Paste a link to see available qualities";
}

/** Tells the main process which feature the person just opened: it goes first there ("" = none). */
function boostFeature(name, url = appState.url) {
  try {
    window.api?.focusFeature?.(name, url || "");
  } catch {}
}

/** A loading cover over a popover, or over one section of it. */
function setPopoverCover(panel, text, show) {
  let el = panel.querySelector(":scope > .popover-loading");
  if (!el) {
    panel.classList.add("has-cover");
    el = document.createElement("div");
    el.className = "popover-loading hidden";
    const spin = document.createElement("span");
    spin.className = "mini-spinner";
    const label = document.createElement("span");
    label.textContent = text;
    el.append(spin, label);
    panel.appendChild(el);
  }
  el.classList.toggle("hidden", !show);
}

/**
 * Trim: covered until the video's duration is known.
 * Quality section only (video formats): covered until the link's real qualities are
 * known. The format buttons above it stay usable.
 */
function syncPopoverLoading() {
  setPopoverCover(
    trimModal,
    "Loading video details…",
    duration() === 0 && (appState.quickPending || appState.fullPending),
  );
  // (No cover over the quality list any more: the starting quality is selectable at once
  // and the other rows fill in as the link's streams are read.)
  setPopoverCover(qualityOptionsList.parentElement, "", false);
}

function syncComposerLock() {
  // A link is usable the moment it is accepted: nothing waits for the analysis.
  const hasLink = !!appState.url && !appState.loading && !appState.failed;
  const waiting = appState.quickPending || appState.fullPending;
  const canTrim =
    hasLink &&
    !appState.isPlaylist &&
    !isLiveLink() &&
    (duration() > 0 || waiting);

  btnToggleCut.disabled = !canTrim;
  // (The cutting preview is no longer prepared here: it starts when the scissors are reached
  // for, or when the app is idle: see featureLoader.)
  btnToggleCut.title = canTrim
    ? appState.trim.active
      ? `Trim: ${formatClock(appState.trim.start)} – ${formatClock(appState.trim.end)}`
      : "Trim before downloading"
    : lockReason("trim");
  if (!canTrim) {
    btnToggleCut.classList.remove("active");
    closeTrimDialog();
  }

  quickFormatQualityBtn.disabled = !hasLink;
  quickFormatQualityBtn.classList.toggle(
    "is-loading",
    appState.loading || (isFullPending() && appState.fullStarted),
  );
  quickFormatQualityBtn.title = hasLink
    ? "Format & quality"
    : lockReason("quality");
  if (!hasLink) formatQualityPopover.classList.add("hidden");

  syncPopoverLoading();
  updateCapsuleLabel();
}

function updateCapsuleLabel() {
  quickFormatQualityLabel.textContent = appState.loading
    ? "Analyzing…"
    : `${appState.selectedFormat} · ${appState.selectedQuality}`;
  syncPeek(); // the playlist views show the same format and quality
}

/* ---- popovers ---- */
/**
 * Puts a popover exactly --popover-gap (styles.css) under the link bar. Each popover hangs
 * from a different button, so "100% of the button" would give every one a different gap.
 */
function setPopoverTop(panel) {
  const bar = document.querySelector(".url-capsule-bar");
  const host = panel.offsetParent;
  if (!bar || !host) return;
  const gap =
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--popover-gap",
      ),
    ) || 12;
  const top =
    bar.getBoundingClientRect().bottom -
    host.getBoundingClientRect().top +
    gap;
  panel.style.setProperty("--pop-top", `${Math.round(top)}px`);
}

/** Slides a popover sideways (and its caret the opposite way) so it never touches the window edge. */
function placePopover(panel) {
  panel.style.removeProperty("--pop-shift");
  const r = panel.getBoundingClientRect();
  const margin = 12;
  let shift = 0;
  if (r.left < margin) shift = margin - r.left;
  else if (r.right > window.innerWidth - margin)
    shift = window.innerWidth - margin - r.right;
  if (shift) panel.style.setProperty("--pop-shift", `${Math.round(shift)}px`);
  setPopoverTop(panel);
}

function closeAllPopovers() {
  closeTrimDialog();
  formatQualityPopover.classList.add("hidden");
  playlistPopover.classList.add("hidden");
  btnExplorePlaylist.setAttribute("aria-expanded", "false");
}

btnToggleCut.addEventListener("click", (e) => {
  e.stopPropagation();
  if (btnToggleCut.disabled) return;
  const wasHidden = trimPopover.classList.contains("hidden");
  closeAllPopovers();
  if (wasHidden) openTrimDialog();
});

quickFormatQualityBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (quickFormatQualityBtn.disabled) return;
  const wasHidden = formatQualityPopover.classList.contains("hidden");
  closeAllPopovers();
  if (wasHidden) {
    renderPills();
    renderQualityOptions();
    updateEstimatedSize();
    formatQualityPopover.classList.remove("hidden");
    placePopover(formatQualityPopover);
    qualityOptionsList
      .querySelector(".selected")
      ?.scrollIntoView({ block: "nearest" });
  }
});

if (closeTrimPopoverBtn)
  closeTrimPopoverBtn.addEventListener("click", () => closeTrimDialog());
trimPopover.addEventListener("click", (e) => e.stopPropagation());
formatQualityPopover.addEventListener("click", (e) => e.stopPropagation());
playlistPopover.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", closeAllPopovers);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllPopovers();
});

/* ---- capsule toggles: settings control the form, never the other way round ----
 * "Embed chapters" / "Embed subtitles" start from the Metadata settings. Switching
 * one in the form changes that download only; once it is launched (or when the
 * setting itself changes) the form goes back to what Settings say.
 */
const settingsEmbed = () => ({
  chapters: readBool("prefChapters", false),
  captions: readBool("prefCaptions", false),
});
let lastSettingsEmbed = settingsEmbed();

function syncToggleButtons() {
  btnToggleChapters.classList.toggle("active", appState.embedChapters);
  btnToggleSubtitles.classList.toggle("active", appState.embedCaptions);
  btnToggleChapters.title = `Embed chapters: ${appState.embedChapters ? "on" : "off"}`;
  btnToggleSubtitles.title = `Embed subtitles: ${appState.embedCaptions ? "on" : "off"}`;
}

/** Back to the Settings values (after a download is launched). */
function applyEmbedDefaults() {
  lastSettingsEmbed = settingsEmbed();
  appState.embedChapters = lastSettingsEmbed.chapters;
  appState.embedCaptions = lastSettingsEmbed.captions;
  syncToggleButtons();
}

/** A changed setting reaches the form; an unchanged one leaves the form's choice alone. */
function followSettingsEmbed() {
  const s = settingsEmbed();
  if (s.chapters !== lastSettingsEmbed.chapters)
    appState.embedChapters = s.chapters;
  if (s.captions !== lastSettingsEmbed.captions)
    appState.embedCaptions = s.captions;
  lastSettingsEmbed = s;
  syncToggleButtons();
}

btnToggleChapters.addEventListener("click", () => {
  appState.embedChapters = !appState.embedChapters;
  syncToggleButtons();
});
btnToggleSubtitles.addEventListener("click", () => {
  appState.embedCaptions = !appState.embedCaptions;
  syncToggleButtons();
});

/* ############################################################################
 # SECTION: format-quality
 # The format & quality popover.
 ############################################################################ */

/* ---- format & quality ---- */
function renderPills() {
  formatPillGroup.querySelectorAll(".format-pill").forEach((p) => {
    p.classList.toggle(
      "active",
      p.dataset.format.toUpperCase() ===
        appState.selectedFormat.toUpperCase(),
    );
  });
}

function setFormat(fmt) {
  const wasAudio = isAudioFormat(appState.selectedFormat);
  const nowAudio = isAudioFormat(fmt);
  appState.selectedFormat = fmt.toUpperCase();
  if (wasAudio !== nowAudio) {
    appState.selectedQuality = nowAudio
      ? normQuality(readStr("prefAudioQuality", "320k"), true)
      : pickVideoQuality(normQuality(readStr("prefQuality", "1080p"), false));
  }
  renderPills();
  renderQualityOptions();
  updateCapsuleLabel();
  updateEstimatedSize();
  syncPopoverLoading();
}

/** Scrolls the pill row so this pill is whole, with half of the next (or previous) one showing. */
function revealPill(pill) {
  const row = formatPillGroup;
  const next = pill.nextElementSibling;
  const prev = pill.previousElementSibling;
  const left = pill.offsetLeft - row.offsetLeft;
  const right = left + pill.offsetWidth;
  if (right > row.scrollLeft + row.clientWidth - 1) {
    row.scrollTo({
      left: right + (next ? next.offsetWidth / 2 : 0) - row.clientWidth,
    });
  } else if (left < row.scrollLeft + 1) {
    row.scrollTo({
      left: left - (prev ? prev.offsetWidth / 2 : 0),
    });
  }
}

formatPillGroup.addEventListener("click", (e) => {
  const pill = e.target.closest(".format-pill");
  if (!pill) return;
  setFormat(pill.dataset.format);
  const again = [...formatPillGroup.children].find(
    (p) => p.dataset.format === pill.dataset.format,
  );
  if (again) revealPill(again);
});

// the mouse wheel moves the row sideways (there is no scroll bar)
formatPillGroup.addEventListener(
  "wheel",
  (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      formatPillGroup.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  },
  { passive: false },
);

function selectQuality(value) {
  appState.selectedQuality = value;
  renderQualityOptions();
  updateCapsuleLabel();
  updateEstimatedSize();
}

/** `locked`: which qualities this video has isn't known yet, so nothing can be picked. */
function addQualityRow(name, badge, value, offered, bytes, pending, locked) {
  const selected = appState.selectedQuality === value && offered;
  const item = document.createElement("div");
  item.className = `quality-option-item ${selected ? "selected" : ""} ${offered ? "" : "disabled"}`;
  const left = document.createElement("div");
  left.className = "q-label-group";
  const n = document.createElement("span");
  n.className = "q-name";
  n.textContent = name;
  const b = document.createElement("span");
  b.className = "q-badge";
  b.textContent = badge;
  left.append(n, b);

  const right = document.createElement("div");
  right.className = "q-right";
  const size = document.createElement("span");
  size.className = offered ? "q-size" : "q-status";
  if (!offered) size.textContent = tr("Not offered");
  else if (bytes) size.textContent = `≈ ${formatBytes(bytes)}`;
  else if (pending) {
    // the loader of a quality whose size isn't known yet
    const spin = document.createElement("span");
    spin.className = "mini-spinner";
    size.appendChild(spin);
  }
  right.appendChild(size);
  item.append(left, right);
  if (offered && !locked)
    item.addEventListener("click", () => selectQuality(value));
  qualityOptionsList.appendChild(item);
}

/** The size yt-dlp itself measured for the starting selection beats any estimate. */
function measuredBytes(format, quality) {
  const q = appState.quick;
  return q && q.sizeBytes && appState.quickSel === `${format}|${quality}`
    ? q.sizeBytes
    : 0;
}

/** Size shown for a row (and clipped to the trim range). */
function rowBytes(quality) {
  const exact = measuredBytes(appState.selectedFormat, quality);
  return exact ? Math.round(exact * clipFraction()) : qualityBytes(quality);
}

function renderQualityOptions() {
  qualityOptionsList.innerHTML = "";
  const pending =
    (!appState.info && (appState.fullPending || appState.quickPending)) ||
    (appState.sizeStaging &&
      !appState.sizeReady.has(appState.selectedFormat.toUpperCase()));

  if (isAudioFormat(appState.selectedFormat)) {
    BITRATES.forEach((o) =>
      addQualityRow(
        o.label,
        o.badge,
        o.label,
        true,
        rowBytes(o.label),
        pending,
      ),
    );
    return;
  }

  // The standard qualities are always listed, instantly. Sizes appear as soon as the
  // link's streams are known, and heights above what the video has are marked.
  // (Playlists have no per-video list, so nothing is marked there.)
  if (appState.info && !appState.info.hasVideo) {
    const empty = document.createElement("div");
    empty.className = "q-empty";
    empty.textContent = tr("This link has no video streams. Choose MP3 or M4A.");
    qualityOptionsList.appendChild(empty);
    return;
  }

  // Until the link's streams are known nothing can be picked (the whole popover shows
  // its loading cover): a quality that turns out not to exist must never be chosen.
  // The one exception is the starting quality (the person's default): it is what the
  // download uses anyway, so it can be chosen at once while the others are looked up.
  const locked = isFullPending();

  const offered = offeredHeights();
  if (!locked && !offered.some((h) => `${h}p` === appState.selectedQuality)) {
    appState.selectedQuality = pickVideoQuality(appState.selectedQuality);
    updateCapsuleLabel();
  }

  let startQ = (appState.quickSel || "").split("|")[1] || "";
  if (!/^\d+p$/.test(startQ)) startQ = appState.selectedQuality; // started on audio
  QUALITY_HEIGHTS.forEach((h) =>
    addQualityRow(
      `${h}p`,
      heightBadge(h),
      `${h}p`,
      offered.includes(h),
      rowBytes(`${h}p`),
      pending,
      locked && `${h}p` !== startQ,
    ),
  );
}

function estimateBytes() {
  return rowBytes(appState.selectedQuality);
}

function updateEstimatedSize() {
  if (!fqEstimatedSizeText) return;
  const bytes = estimateBytes();
  fqEstimatedSizeText.textContent = bytes
    ? `≈ ${formatBytes(bytes)}`
    : appState.quickPending ||
        isFullPending() ||
        (appState.sizeStaging &&
          !appState.sizeReady.has(appState.selectedFormat.toUpperCase()))
      ? "…"
      : "—";
}

btnMakeDefaultFormat.addEventListener("click", () => {
  const fmt = appState.selectedFormat;
  const q = appState.selectedQuality;
  if (isAudioFormat(fmt)) {
    localStorage.setItem("prefAudioFormat", fmt);
    localStorage.setItem("prefAudioQuality", `${parseInt(q, 10) || 320}k`);
    localStorage.setItem("prefDefaultType", "audio");
  } else {
    const known = VIDEO_FORMATS.find((f) => f.value === fmt);
    localStorage.setItem("prefFormat", known ? known.label : fmt);
    localStorage.setItem("prefQuality", `${parseInt(q, 10) || 1080}p`);
    localStorage.setItem("prefDefaultType", "video");
  }
  window.dispatchEvent(new Event("settingsUpdated"));
  window.dispatchEvent(new Event("settingsRefresh")); // the Settings dropdowns show them too
  showToast(tr("Default saved: {fmt} · {q}", { fmt, q }), "success");
  formatQualityPopover.classList.add("hidden");
});

/* ############################################################################
 # SECTION: link-analysis
 # Analyses a pasted link and watches the clipboard.
 ############################################################################ */

/* ---- analysing the pasted link ---- */
let analyzeTimer = null;
let analyzeToken = 0;

function resetComposer() {
  analyzeToken++;
  // Stop analysing the link we are leaving (a download never depends on it)
  if (appState.url && appState.fullPending)
    window.api?.cancelMediaInfo?.(appState.url);
  appState.url = "";
  sizeRun++;
  appState.sizeStaging = false;
  appState.sizeReady = new Set();
  appState.info = null;
  appState.quick = null;
  appState.preview = null;
  appState.quickSel = "";
  appState.quickPending = false;
  appState.fullPending = false;
  appState.fullStarted = false;
  featureLoader.reset();
  appState.failed = false;
  appState.loading = false;
  appState.isPlaylist = false;
  appState.trim = { active: false, start: 0, end: 0, exact: false };
  trimSel.start = 0;
  trimSel.end = 0;
  trimPlay.t = 0;
  resetVideo();
  btnToggleCut.classList.remove("active");
  loadDefaultsFromSettings();
  appState.playlist = null;
  appState.plSummary = null;
  appState.single = null;
  appState.found = null;
  renderChaptersList();
  updateTrimUI();
  renderPills();
  renderQualityOptions();
  updateEstimatedSize();
  syncComposerLock();
}

function onUrlChanged() {
  const raw = urlInput.value.trim();
  clearTimeout(analyzeTimer);
  if (
    raw === appState.url &&
    (appState.info ||
      appState.quick ||
      appState.isPlaylist ||
      appState.fullPending ||
      appState.quickPending)
  )
    return;
  if (!isValidMediaUrl(raw)) {
    if (appState.url || appState.loading) resetComposer();
    return;
  }
  analyzeTimer = setTimeout(() => analyze(raw), 300);
}

/** Re-draws everything that depends on the link's data (safe to call at any time). */
function refreshLinkUI() {
  renderChaptersList();
  updateTrimUI();
  renderPills();
  renderQualityOptions();
  updateEstimatedSize();
  syncComposerLock();
}

/** Keeps an untouched trim range in step with the real duration once it is known. */
function adoptDuration(previous) {
  const dur = duration();
  if (!dur) return;
  if (!appState.trim.active) appState.trim.end = dur;
  const untouched =
    trimSel.start === 0 &&
    (!trimSel.end || trimSel.end <= 1 || trimSel.end === previous);
  if (untouched) trimSel.end = dur;
}

/* ---- staged loading: what the person asks for first, the rest while they are away ----
 * Level 1 (title, thumbnail, duration, size, the playlist's name and total) comes at once.
 * Everything else is loaded for the feature the person reaches for (qualities, explore
 * playlist, cutting), and only that one first. When they do nothing (the window is in the
 * background, or no input for a few seconds) the app fetches the rest by itself, one
 * at a time, in this order: qualities, then the playlist, then the cutting preview. */
/** Sizes are shown in this order, one format at a time: the starting (default) format first,
 * then MP4, then MP3, then every other format. The format being looked at jumps the queue. */
let sizeRun = 0;
async function revealSizes(startFormat) {
  const run = ++sizeRun;
  appState.sizeStaging = true;
  appState.sizeReady = new Set();
  const all = [...VIDEO_FORMATS.map((f) => f.value), ...AUDIO_FORMATS];
  const order = [...new Set([startFormat, "MP4", "MP3", ...all].map((f) => f.toUpperCase()))];
  while (run === sizeRun) {
    const next =
      order.find(
        (f) => !appState.sizeReady.has(f) && f === appState.selectedFormat.toUpperCase(),
      ) || order.find((f) => !appState.sizeReady.has(f));
    if (!next) break;
    appState.sizeReady.add(next);
    renderQualityOptions();
    updateEstimatedSize();
    await new Promise((r) => setTimeout(r, 120));
  }
  if (run === sizeRun) appState.sizeStaging = false;
}

const featureLoader = (() => {
  const IDLE_MS = 5000; // no input for this long = the person is doing something else
  const ORDER = ["qualities", "playlist", "cutting"];
  let url = "";
  let token = 0;
  let started = {};
  let running = 0;
  let timer = 0;
  let lastActivity = Date.now();

  ["pointerdown", "pointermove", "keydown", "wheel"].forEach((ev) =>
    document.addEventListener(ev, () => (lastActivity = Date.now()), {
      capture: true,
      passive: true,
    }),
  );
  const away = () =>
    document.hidden ||
    !document.hasFocus() ||
    Date.now() - lastActivity > IDLE_MS;

  /** Each loader gets (asked) and returns a promise; asked = the person reached for it. */
  const loaders = {
    async qualities(asked) {
      const api = window.api;
      appState.fullStarted = true;
      syncComposerLock();
      let info = null;
      try {
        info = await api.fetchMediaInfo(url, asked ? undefined : { background: true });
      } catch (err) {
        info = { error: err.message };
      }
      if (token !== analyzeToken) return; // the link changed while we were waiting
      appState.fullPending = false;
      appState.fullStarted = false;
      if (!info || info.error) {
        appState.info = null;
        if (info?.cancelled) {
          refreshLinkUI();
          return;
        }
        started.qualities = false; // asking again tries again
        // Level 1 may still have given the title and duration; only a link with nothing is an error
        if (!appState.quick && !appState.preview) appState.failed = true;
        refreshLinkUI();
        if (asked)
          showToast(
            tr("Couldn't read this link: {error}", { error: info?.error || tr("unknown error") }),
            "error",
            5000,
          );
        return;
      }
      const previous = duration();
      appState.info = info;
      revealSizes((appState.quickSel || "").split("|")[0] || appState.selectedFormat);
      adoptDuration(previous);
      if (!isAudioFormat(appState.selectedFormat))
        appState.selectedQuality = pickVideoQuality(appState.selectedQuality);
      refreshLinkUI();
    },
    async playlist(asked) {
      // a lone video: which of its channel's playlists holds it (the popover only)
      await startPlaylistSearch(url, token, !asked);
    },
    async cutting(asked) {
      if (asked) {
        // The cutting's own calls (stream, timeline pictures) go first; the chapters and the
        // storyboard come with the qualities, right behind them.
        try {
          ensureVideo();
        } catch {}
        run("qualities", true);
      } else {
        window.api?.prewarmPreview?.(url); // first seconds + timeline pictures, in the background
      }
    },
  };

  function run(name, asked) {
    if (!url || started[name]) return started[name] || null;
    running++;
    const mine = token;
    started[name] = Promise.resolve(loaders[name](asked))
      .catch(() => {})
      .finally(() => {
        if (mine !== token) return;
        running--;
        schedule();
      });
    return started[name];
  }

  function tick() {
    timer = 0;
    if (!url) return;
    const next = ORDER.find((n) => !started[n]);
    if (!next) return; // everything has been fetched
    if (!running && away()) run(next, false);
    schedule();
  }
  function schedule() {
    if (timer || !url) return;
    timer = setTimeout(tick, 1000);
  }

  return {
    /** A new link: nothing is loaded for it beyond level 1. */
    begin(link, t) {
      this.reset();
      url = link;
      token = t;
      schedule();
    },
    reset() {
      clearTimeout(timer);
      timer = 0;
      url = "";
      started = {};
      running = 0;
    },
    /** The person reached for a feature: its data goes first, now. */
    request(name) {
      if (url && loaders[name]) run(name, true);
    },
    /** Starts a feature's data at once, but quietly (the app's own work, not the person's). */
    prime(name) {
      if (url && loaders[name]) run(name, false);
    },
  };
})();

/**
 * A link that is a playlist and nothing else (…/playlist?list=…): it is downloaded as a list.
 * A video link that also carries its playlist (watch?v=…&list=…&index=N) stays that video:
 * its qualities and sizes are its own, and the playlist is explored from the button.
 */
function isPlaylistOnlyUrl(url) {
  if (!checkIfPlaylistUrl(url)) return false;
  try {
    const u = new URL(url);
    if (u.searchParams.get("v")) return false;
    if (/(^|\.)youtu\.be$/i.test(u.hostname) && u.pathname.length > 1) return false;
    if (/^\/(?:watch|shorts|live|embed)\b/i.test(u.pathname)) return false;
  } catch {}
  return true;
}

async function analyze(url) {
  resetComposer();
  const token = analyzeToken;
  appState.url = url;

  if (isPlaylistOnlyUrl(url)) {
    appState.loading = true;
    syncComposerLock();
    const ok = await loadPlaylist(url);
    if (token !== analyzeToken) return;
    appState.loading = false;
    if (ok) {
      appState.isPlaylist = true;
      renderQualityOptions();
      syncComposerLock();
      return;
    }
    // Not a readable playlist: fall back to the single video
  }

  const api = window.api;
  if (!api?.fetchMediaInfo) {
    appState.failed = true;
    syncComposerLock();
    showToast(
      "Couldn't read this link: Download engine is not available",
      "error",
      5000,
    );
    return;
  }

  // The composer is usable right away; everything below fills in as it arrives.
  appState.quickPending = true;
  appState.fullPending = true; // qualities: not loaded yet (see featureLoader)
  appState.quickSel = selKey();
  refreshLinkUI();

  // Instant: title + thumbnail (oEmbed, usually well under a second)
  api
    .fetchLinkPreview?.(url)
    .then((p) => {
      if (token !== analyzeToken || !p || !(p.title || p.thumb)) return;
      appState.preview = p;
      syncPeek();
    })
    .catch(() => {});

  // Level 1: duration + estimated size for the default quality
  (api.fetchQuickInfo ? api.fetchQuickInfo(url, { background: true }) : Promise.resolve(null))
    .catch(() => null)
    .then((quick) => {
      if (token !== analyzeToken) return;
      appState.quickPending = false;
      if (quick && !quick.error) {
        const previous = duration();
        appState.quick = quick;
        adoptDuration(previous);
      }
      refreshLinkUI();
    });

  // Qualities, the video's playlist and the cutting preview: only for the feature the person
  // reaches for, or one by one while they are away (never all at once, never unasked at full speed)
  featureLoader.begin(url, token);
  // The playlist button's number (how many videos the video's playlist holds) is level 1 too:
  // it is asked for at once, behind the default quality in priority. The button shows its
  // loader meanwhile and never a "1" first.
  if (isYoutubeLink(url)) featureLoader.prime("playlist");
}

urlInput.addEventListener("input", onUrlChanged);

/* A feature that opens, or is reached for, asks for its data first. */
{
  // What the main process calls each feature while it is open (see boostFeature)
  const FEATURE_NAME = { qualities: "quality", cutting: "trim", playlist: "playlist" };
  const allClosed = () =>
    [formatQualityPopover, trimPopover, playlistPopover, playlistViewContainer].every(
      (p) => !p || p.classList.contains("hidden"),
    );
  const watchOpen = (el, stage) => {
    if (!el) return;
    new MutationObserver(() => {
      if (!el.classList.contains("hidden")) {
        // The whole connection and the processor go to this feature (the downloads wait a
        // moment), and its data is asked for first.
        boostFeature(FEATURE_NAME[stage]);
        featureLoader.request(stage);
      } else if (allClosed()) boostFeature(""); // nothing open any more: back to normal
    }).observe(el, { attributes: true, attributeFilter: ["class"] });
  };
  watchOpen(formatQualityPopover, "qualities");
  watchOpen(trimPopover, "cutting");
  watchOpen(playlistPopover, "playlist");
  watchOpen(playlistViewContainer, "playlist");
  const reach = (el, stage) =>
    el && el.addEventListener("pointerenter", () => featureLoader.request(stage));
  reach(quickFormatQualityBtn, "qualities");
  reach(btnExplorePlaylist, "playlist");
  reach(btnToggleCut, "cutting");
}

/* ---- Auto-Detect Links (Network tab) ---- */
const SUPPORTED_HOSTS =
  /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|soundcloud\.com|dailymotion\.com|twitter\.com|x\.com|facebook\.com|fb\.watch|instagram\.com|twitch\.tv|reddit\.com|bilibili\.com|bandcamp\.com|mixcloud\.com)$/i;
let lastClipboard = "";
let autoDetectWasOn = readBool("prefAutoDetect", true);

async function checkClipboard() {
  if (!readBool("prefAutoDetect", true)) return;
  if (!window.api || !window.api.readClipboard) return;
  let text = "";
  try {
    text = ((await window.api.readClipboard()) || "").trim();
  } catch {
    return;
  }
  if (!text || text === lastClipboard) return;
  lastClipboard = text;
  if (!isValidMediaUrl(text)) return;
  let host = "";
  try {
    host = new URL(text).hostname;
  } catch {
    return;
  }
  if (!SUPPORTED_HOSTS.test(host)) return;
  // Never overwrite something the user is typing right now
  if (document.activeElement === urlInput && urlInput.value.trim()) return;
  if (urlInput.value.trim() === text) return;
  urlInput.value = text;
  const autoDownload = readBool("prefAutoDownloadCopied", false);
  showToast(
    autoDownload ? "Downloading the copied link…" : "Link detected from clipboard",
    "info",
  );
  clearTimeout(analyzeTimer);
  await analyze(text);
  // "Auto Download Copied Links": start it with the default settings, nothing to confirm
  if (autoDownload && urlInput.value.trim() === text && appState.url === text)
    triggerDownload();
}

window.addEventListener("focus", checkClipboard);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) checkClipboard();
});
setInterval(() => {
  if (document.hasFocus()) checkClipboard();
}, 1500);

/* ############################################################################
 # SECTION: add-to-queue
 # Adding links to the queue.
 ############################################################################ */

/* ---- adding to the queue: save folder + duplicate handling ---- */
/** Returns "" for the default folder, a path if the user picked one, null if cancelled. */
async function resolveSaveFolder() {
  if (!readBool("prefAlwaysAskDir", false)) return "";
  if (!window.api?.selectFolder) return "";
  const dir = await window.api.selectFolder(getDownloadDir());
  if (!dir) {
    showToast("Download cancelled: no folder chosen", "warning");
    return null;
  }
  return dir;
}

const taskKey = (url, trim) =>
  `${String(url).trim().toLowerCase()}|${trim ? trim.start + "-" + trim.end : ""}`;

/**
 * Applies "Duplicate Files Handling" (Playlists tab).
 * Returns the entries to add (each with an `overwrite` flag), or null if cancelled.
 */
async function applyDuplicatePolicy(entries) {
  const existing = new Map();
  queue.forEach((t) => {
    if (["queued", "in_progress", "completed", "paused"].includes(t.status))
      existing.set(taskKey(t.url, t.trim), t);
  });
  const dups = entries.filter((e) => existing.has(taskKey(e.url, e.trim)));
  if (!dups.length) return entries.map((e) => ({ ...e, overwrite: false }));

  let mode = readStr("prefDuplicateHandling", "ask");
  if (mode === "ask") {
    const choice = await showModal({
      title: "Already in your queue",
      message:
        dups.length === 1
          ? "This link is already in your downloads. Replace it, keep both, or skip it?"
          : tr("{n} of these links are already in your downloads. Replace them, keep both, or skip them?", { n: dups.length }),
      buttons: [
        { key: "overwrite", text: "Replace", type: "primary" },
        { key: "rename", text: "Keep both", type: "secondary" },
        { key: "skip", text: "Skip duplicates", type: "secondary" },
        { key: "cancel", text: "Cancel", type: "secondary" },
      ],
    });
    if (choice === "cancel") return null;
    mode = choice;
  }

  const result = [];
  entries.forEach((e) => {
    const old = existing.get(taskKey(e.url, e.trim));
    if (!old) return result.push({ ...e, overwrite: false });
    if (mode === "skip") return;
    if (mode === "rename") {
      // Keep both: the new file gets " (2)", " (3)"… after its name
      const same = queue.filter(
        (t) => taskKey(t.url, t.trim) === taskKey(e.url, e.trim),
      ).length;
      return result.push({ ...e, overwrite: false, dupSuffix: same + 1 });
    }
    // Replace: only finished/paused items can be replaced; running ones are left alone
    if (old.status === "queued" || old.status === "in_progress") return;
    queue = queue.filter((t) => t.id !== old.id);
    result.push({ ...e, overwrite: true });
  });
  if (!result.length) showToast("Already in your queue: skipped", "info");
  return result;
}

function newTaskId(n = 0) {
  return `task_${Date.now()}_${n}_${Math.random().toString(36).substring(2, 6)}`;
}

async function enqueuePlaylist(items, playlistTitle, playlistUrl = "") {
  const dir = await resolveSaveFolder();
  if (dir === null) return false;
  const entries = await applyDuplicatePolicy(
    items.map((i) => ({ url: i.url, trim: null, item: i })),
  );
  if (!entries || !entries.length) return false;

  const playlistGroup = newTaskId(); // one id for everything added from this playlist now
  const subfolder = readBool("prefPlaylistSubfolder", true)
    ? playlistTitle || "Playlist"
    : "";
  const opts = {
    chapters: appState.embedChapters,
    captions: appState.embedCaptions,
  };
  entries.forEach((e, n) => {
    queue.push({
      id: newTaskId(n),
      url: e.item.url,
      title: e.item.title,
      thumb: e.item.thumb,
      progress: 0,
      status: "queued",
      format: appState.selectedFormat,
      quality: appState.selectedQuality,
      subfolder,
      playlistIndex: e.item.index,
      playlistUrl, // lets "Explore Playlist" in the queue's menu open it again
      playlistTitle: playlistTitle || "Playlist", // for "Group Playlist Files in Queue"
      playlistGroup,
      saveFolder: dir,
      overwrite: e.overwrite,
      dupSuffix: e.dupSuffix || 0,
      opts,
      createdAt: new Date().toISOString(),
    });
  });
  saveQueue();
  showToast(
    tr(entries.length === 1 ? "Queued {n} item from playlist" : "Queued {n} items from playlist", { n: entries.length }),
    "success",
  );
  processNext();
  return true;
}

async function enqueueSingle(rawUrl) {
  const same = appState.url === rawUrl;
  // Whatever has arrived so far is enough: nothing here waits for level 2
  const info = same
    ? appState.info || appState.quick || appState.preview
    : null;
  const trim = appState.trim.active
    ? {
        start: appState.trim.start,
        end: appState.trim.end,
        exact: appState.trim.exact,
      }
    : null;

  const dir = await resolveSaveFolder();
  if (dir === null) return false;
  const entries = await applyDuplicatePolicy([{ url: rawUrl, trim }]);
  if (!entries || !entries.length) return false;

  const est = estimateBytes();
  queue.unshift({
    id: newTaskId(),
    url: rawUrl,
    title: info?.title || "Fetching info...",
    thumb: info?.thumb || FALLBACK_THUMB,
    progress: 0,
    status: "queued",
    format: appState.selectedFormat,
    quality: appState.selectedQuality,
    trim,
    duration: same ? duration() : 0,
    size: est ? formatBytes(est) : "",
    sizeBytes: est,
    streamSizes: est ? [est] : [],
    saveFolder: dir,
    overwrite: entries[0].overwrite,
    dupSuffix: entries[0].dupSuffix || 0,
    opts: {
      chapters: appState.embedChapters,
      captions: appState.embedCaptions,
    },
    createdAt: new Date().toISOString(),
  });
  saveQueue();
  showToast(
    trim ? "Added trimmed download to queue" : "Added task to queue",
    "success",
  );
  processNext();
  return true;
}

let adding = false;
async function triggerDownload() {
  if (adding) return;
  const rawUrl = (urlInput?.value || "").trim();
  if (!isValidMediaUrl(rawUrl)) {
    showToast("Please enter a valid HTTP/HTTPS media URL", "warning");
    return;
  }
  adding = true;
  try {
    let done = false;
    if (isPlaylistOnlyUrl(rawUrl)) {
      if (!appState.playlist || appState.playlist.url !== rawUrl) {
        showToast("Fetching playlist items...", "info");
        await loadPlaylist(rawUrl);
      }
      if (appState.playlist && appState.playlist.url === rawUrl) {
        const chosen = selectedPlaylistItems();
        if (!chosen.length) {
          showToast("Select at least one video from the playlist", "warning");
          return;
        }
        done = await enqueuePlaylist(
          chosen,
          appState.playlist.title,
          appState.playlist.url,
        );
      } else {
        done = await enqueueSingle(rawUrl);
      }
    } else {
      done = await enqueueSingle(rawUrl);
    }
    if (done) {
      urlInput.value = "";
      appState.playlist = null;
      resetComposer();
      applyEmbedDefaults();
    }
  } finally {
    adding = false;
  }
}

if (downloadBtn) downloadBtn.addEventListener("click", triggerDownload);
if (urlInput)
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") triggerDownload();
  });

/* ############################################################################
 # SECTION: settings-and-ipc
 # Reacts to Settings changes and to events from the main process.
 ############################################################################ */

/** --------------------------------------------------------------------------
 * SETTINGS CHANGES (fired by the Settings window and by the capsule buttons)
 * -------------------------------------------------------------------------- */
function onSettingsChanged() {
  renderQueue(); // "Group Playlist Files in Queue" may have changed
  applyTheme();
  applyLanguage();
  followSettingsEmbed();
  pushAppPrefs();

  const autoNow = readBool("prefAutoDetect", true);
  if (autoNow && !autoDetectWasOn) {
    lastClipboard = ""; // pick up a link that is already on the clipboard
  }
  autoDetectWasOn = autoNow;
  if (autoNow) checkClipboard();

  if (!appState.url) (loadDefaultsFromSettings(), updateCapsuleLabel());
  if (!dataLimitHit()) limitReached = false;
  processNext();
}
window.addEventListener("settingsUpdated", onSettingsChanged);

/** --------------------------------------------------------------------------
 * API LISTENERS (ELECTRON IPC)
 * -------------------------------------------------------------------------- */
if (window.api) {
  window.api.onProgress((data) => {
    const item = queue.find((t) => t.id === data.downloadId);
    // Late events from a paused / removed download must not revive it
    if (!item || item.status !== "in_progress") return;

    if (data.stage) item.stage = data.stage;
    if (data.stageText !== undefined) item.stageText = data.stageText;
    if (data.percent !== undefined) item.progress = Math.round(data.percent);
    if (data.speed !== undefined) item.speed = data.speed;
    if (data.eta !== undefined) item.eta = data.eta;
    if (data.title) item.title = data.title;
    if (data.thumb) item.thumb = data.thumb;
    if (data.size) item.size = data.size;
    if (data.bytes) {
      bytesByTask.set(item.id, data.bytes);
      enforceDataLimit();
    }
    updateQueueCard(item); // only this card's numbers, not the whole list
  });

  window.api.onComplete((data) => {
    const item = queue.find((t) => t.id === data.downloadId);
    if (!item || item.status === "cancelled") return;
    item.status = "completed";
    item.stage = "";
    item.stageText = "";
    item.progress = 100;
    item.speed = "";
    item.eta = "";
    item.overwrite = false;
    item.filePath = data.filePath;
    if (data.durationSeconds > 0) item.clipSeconds = data.durationSeconds; // for the length display
    if (data.warning) showToast(data.warning, "error", 8000);
    if (data.sizeBytes > 0) {
      item.sizeBytes = data.sizeBytes;
      item.size = formatBytes(data.sizeBytes);
    }
    sessionCompleted++;
    saveQueue();
    renderQueue();
    showToast(tr("Completed: {title}", { title: item.title || tr("Video") }), "success");
    desktopNotify("Download complete", item.title || "Video");
    processNext();
    notifyIfQueueFinished();
  });

  window.api.onError((data) => {
    if (data.downloadId === "setup") {
      showToast(data.error || "Setup failed", "error", 6000);
      return;
    }
    const item = queue.find((t) => t.id === data.downloadId);
    if (!item || item.status === "cancelled") return;
    item.status = "failed";
    item.stage = "";
    item.speed = "";
    item.eta = "";
    item.error = data.error || "Download failed";
    saveQueue();
    renderQueue();
    showToast(tr("Failed: {title}", { title: item.title || tr("Download") }), "error");
    processNext();
    notifyIfQueueFinished();
  });
}

/** After a restart, match saved "in progress" items with what the engine is really doing. */
async function reconcileWithMain() {
  const stale = queue.filter((t) => t.status === "in_progress");
  if (!stale.length) return;
  let states = { running: {}, finished: {} };
  if (window.api?.getDownloadStates) {
    try {
      states = await window.api.getDownloadStates();
    } catch {}
  }
  stale.forEach((t) => {
    const run = states.running?.[t.id];
    const fin = states.finished?.[t.id];
    if (run) {
      t.progress = run.percent ?? t.progress;
      t.stage = run.stage || t.stage;
      t.stageText = run.stageText || "";
      t.speed = run.speed || "";
      t.eta = run.eta || "";
    } else if (fin && fin.status === "completed") {
      t.status = "completed";
      t.progress = 100;
      t.filePath = fin.filePath;
      if (fin.durationSeconds > 0) t.clipSeconds = fin.durationSeconds;
      if (fin.sizeBytes > 0) {
        t.sizeBytes = fin.sizeBytes;
        t.size = formatBytes(fin.sizeBytes);
      }
    } else if (fin && fin.status === "failed") {
      t.status = "failed";
      t.error = fin.error;
    } else {
      t.status = "queued"; // the app was closed mid-download: start it again
    }
  });
}

/** Engine update check on launch ("Automatically Download App Updates" / "Update Availability Alerts"). */
async function startupEngineCheck() {
  if (!window.api?.checkYtdlpUpdate) return;
  const auto = readBool("prefAutoUpdate", true);
  const notify = readBool("prefUpdateNotify", true);
  if (!auto && !notify) return;
  try {
    const info = await window.api.checkYtdlpUpdate();
    if (!info || !info.updateAvailable) return;
    const idle = !queue.some((t) => t.status === "in_progress");
    if (auto && idle) {
      showToast("Updating the download engine…", "info", 4000);
      const res = await window.api.updateYtdlp();
      showToast(
        res.ok
          ? "Download engine updated"
          : tr("Engine update failed: {message}", { message: res.message }),
        res.ok ? "success" : "error",
        5000,
      );
    } else if (notify) {
      showToast(tr("yt-dlp {v} is available", { v: info.latestVersion }), "info", 6000);
      desktopNotify(
        "Update available",
        tr("yt-dlp {v} is available.", { v: info.latestVersion }),
      );
    }
  } catch {}
}

/* ############################################################################
 # SECTION: boot
 # Startup: runs the first render and starts the queue. Must be the last script loaded.
 ############################################################################ */

/** --------------------------------------------------------------------------
 * INIT
 * -------------------------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", () => {
  buildFormatPills();
  loadOptionCatalog();
  loadDefaultsFromSettings();
  applyEmbedDefaults();
  renderChaptersList();
  updateTrimUI();
  renderPills();
  renderQualityOptions();
  updateEstimatedSize();
  syncComposerLock();
  showPlaylistPanel(false);
  syncPeek();
  renderQueue();
  pushAppPrefs();

  reconcileWithMain().finally(() => {
    renderQueue();
    processNext();
    checkClipboard();
    setTimeout(startupEngineCheck, 6000);
  });
});
