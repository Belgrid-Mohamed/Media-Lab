/** ============================================================================
 * downloads-scripts/playlist-explorer.js
 * The playlist explorer: the shared playlist view, its data, the popover under the link bar and the side panel.
 * Loads last.
 *
 * Sections (in file order) and their features:
 *
 *  [playlist-view] The playlist view component, used in two places: the popover and the side panel.
 *    - createPlaylistView: item list, search, range selection (e.g. 1-5, 8), select all, totals
 *    - Duration and size estimates for the chosen items
 *    - Helpers: parseRange, formatBadgeTime, formatTotalTime, estimateBytesFor
 *
 *  [playlist-data] Where the playlist view gets its data.
 *    - Models for the pasted link: loading, single video, input, found playlist
 *    - Looking for the playlist a single video belongs to (startPlaylistSearch)
 *    - fetchPlaylistModel and loadPlaylist (via the main process)
 *    - canonicalPlaylistUrl, pastedVideoId, isYoutubeLink
 *
 *  [playlist-popover] The playlist popover under the link bar.
 *    - Popover view instance and downloadFromPopover
 *    - placePlaylistPopover / openPlaylistPopover
 *    - syncPeek: the button that replaces the link icon once a link is pasted
 *
 *  [playlist-panel] The playlist side panel opened from 'Explore Playlist' in the queue's right-click menu.
 *    - showPlaylistPanel, panel view and model
 *    - playlistUrlOf and explorePlaylist
 *    - Sets playlistViewsReady once both playlist views exist
 *
 * Split from the old downloads-script.js. The five files are classic scripts that share one
 * scope (like the old single closure), so they can call each other's functions freely.
 * Load order, set in downloads-index.html: core, queue-scripts, trim-engine, video-player, playlist-explorer.
 * ========================================================================== */

/* ############################################################################
 # SECTION: playlist-view
 # The playlist view component, used in two places: the popover and the side panel.
 ############################################################################ */

/* ---- Playlist view: one design, two homes ----
 * The popover under the link bar (opened from the button that replaces the link icon once
 * a link is pasted) and the side panel (opened from "Explore Playlist" in the queue's
 * right-click menu) are drawn by the same component, so they always look and act alike.
 */
const RANGE_ONLY = /^[\d\s,\-–]+$/;

/** Rough kbit/s (video + audio) per height: only for the "≈ size" line, real sizes are per file. */
const VIDEO_KBPS = {
  4320: 40000,
  2160: 14000,
  1440: 7000,
  1080: 3200,
  720: 1800,
  480: 1000,
  360: 600,
  240: 350,
  144: 200,
};

function selectedPlaylistItems() {
  return appState.playlist
    ? appState.playlist.items.filter((i) => i.selected)
    : [];
}

/** Duration badge on a thumbnail: 544 -> "9:04", 4000 -> "1:06:40" */
function formatBadgeTime(seconds) {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** 11520 -> "3h 12m" */
function formatTotalTime(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m` : `${s}s`;
}

function estimateBytesFor(items) {
  const audio = isAudioFormat(appState.selectedFormat);
  const n = parseInt(appState.selectedQuality, 10);
  const kbps = audio ? n || 320 : VIDEO_KBPS[n] || 3200;
  const seconds = items.reduce(
    (sum, i) => sum + (Number(i.duration) || 0),
    0,
  );
  return Math.round(kbps * 125 * seconds);
}

/** "1-5, 8, 12-16" -> Set of item numbers (never more than `max`, so "1-999999999" is harmless) */
function parseRange(text, max = Infinity) {
  const picked = new Set();
  for (const part of String(text).split(",")) {
    const m = part.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    const hi = Math.min(Math.max(a, b), max);
    for (let n = Math.min(a, b); n <= hi; n++) picked.add(n);
  }
  return picked;
}

function messageRow(text) {
  const el = document.createElement("div");
  el.className = "playlist-empty";
  el.textContent = text;
  return el;
}

/**
 * Draws the playlist view into `root`.
 *   getModel()   -> { url, title, author, items: [{..., selected}], loading?, error?, rev } | null
 *   onDownload() -> called with (model, chosenItems)
 * Rows are built once per list and only repainted when a selection changes, so clicking
 * never resets the scroll position or reloads thumbnails.
 */
function createPlaylistView(root, { getModel, onDownload, emptyText }) {
  root.classList.add("playlist-view");
  root.innerHTML = `
    <div class="pl-header">
      <h3 class="pl-title truncate"></h3>
      <p class="pl-subtitle truncate"></p>
    </div>
    <div class="pl-search">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <circle cx="11" cy="11" r="8"></circle>
        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
      </svg>
      <input type="text" class="pl-search-input" placeholder="Search or type a range, e.g. 1-5, 8, 12-16" autocomplete="off" spellcheck="false" aria-label="Search videos or type a range" />
      <span class="pl-search-divider"></span>
      <button type="button" class="btn-link-orange pl-select-all">Select all</button>
    </div>
    <div class="pl-list" role="listbox" aria-multiselectable="true"></div>
    <div class="pl-footer">
      <div class="pl-meta">
        <span class="pl-meta-left"></span>
        <span class="pl-meta-right"></span>
      </div>
      <button type="button" class="btn-download-action full-width-btn pl-download"></button>
    </div>`;

  const pick = (sel) => root.querySelector(sel);
  const titleEl = pick(".pl-title");
  const subtitleEl = pick(".pl-subtitle");
  const searchEl = pick(".pl-search-input");
  const allBtn = pick(".pl-select-all");
  const listEl = pick(".pl-list");
  const metaLeft = pick(".pl-meta-left");
  const metaRight = pick(".pl-meta-right");
  const downloadBtn = pick(".pl-download");

  let query = "";
  let drawn = { items: null, rev: -1, key: "" };
  const rowEls = new Map(); // item -> row element

  /** The numbers typed as a range ("1-5, 8"), or null when the text is a plain search. */
  function rangeSet(m) {
    const q = query.trim();
    if (!q || !RANGE_ONLY.test(q)) return null;
    const picked = parseRange(q, m.items.length);
    return picked.size ? picked : null;
  }

  /** The rows on show: a range shows everything (and selects it), text filters by title / channel. */
  function visibleItems(m) {
    const q = query.trim().toLowerCase();
    if (!q || rangeSet(m)) return m.items;
    const found = m.items.filter(
      (i) =>
        String(i.title || "")
          .toLowerCase()
          .includes(q) ||
        String(i.channel || "")
          .toLowerCase()
          .includes(q),
    );
    // Half-typed range ("1-"): keep the list as it is instead of emptying it
    return !found.length && RANGE_ONLY.test(q) ? m.items : found;
  }

  function paintRow(item) {
    const row = rowEls.get(item);
    if (!row) return;
    row.classList.toggle("selected", !!item.selected);
    row.setAttribute("aria-selected", String(!!item.selected));
  }

  function makeRow(item) {
    const row = document.createElement("div");
    row.className = "pl-row";
    row.dataset.id = item.id || "";
    row.setAttribute("role", "option");
    row.tabIndex = 0;
    if (item.title) row.title = `${item.index}. ${item.title}`;

    const thumb = document.createElement("div");
    thumb.className = "pl-thumb";
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    img.src = safeImgUrl(item.thumb);
    img.addEventListener("error", () => img.remove());
    thumb.appendChild(img);
    if (item.duration) {
      const badge = document.createElement("span");
      badge.className = "pl-duration";
      badge.textContent = formatBadgeTime(item.duration);
      thumb.appendChild(badge);
    }

    const text = document.createElement("div");
    text.className = "pl-row-text";
    const title = document.createElement("p");
    title.className = "pl-row-title";
    title.textContent = item.title || tr("Untitled video");
    text.appendChild(title);
    if (item.channel) {
      const channel = document.createElement("span");
      channel.className = "pl-row-channel truncate";
      channel.textContent = item.channel;
      text.appendChild(channel);
    }

    row.append(thumb, text);
    const toggle = () => {
      item.selected = !item.selected;
      paintRow(item);
      updateChrome();
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (e) => {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      toggle();
    });
    return row;
  }

  function updateFade() {
    listEl.classList.toggle(
      "fade-bottom",
      listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight > 6,
    );
  }
  listEl.addEventListener("scroll", updateFade, { passive: true });

  /** Footer, "Select all" and the download button: everything that follows the selection. */
  function updateChrome() {
    const m = getModel();
    const ready = !!m && !m.loading && !m.error;
    const chosen = ready ? m.items.filter((i) => i.selected) : [];
    const shown = ready ? visibleItems(m) : [];

    allBtn.textContent =
      tr(shown.length && shown.every((i) => i.selected) ? "Clear" : "Select all");
    searchEl.placeholder = tr("Search or type a range, e.g. 1-5, 8, 12-16");
    searchEl.setAttribute("aria-label", tr("Search videos or type a range"));
    allBtn.disabled = !shown.length;

    metaLeft.textContent = "";
    if (chosen.length) {
      const seconds = chosen.reduce(
        (s, i) => s + (Number(i.duration) || 0),
        0,
      );
      if (seconds > 0) {
        const total = document.createElement("strong");
        total.textContent = formatTotalTime(seconds);
        metaLeft.appendChild(total);
        const bytes = estimateBytesFor(chosen);
        if (bytes > 0)
          metaLeft.appendChild(
            document.createTextNode(` · ≈ ${formatBytes(bytes)}`),
          );
      } else {
        metaLeft.textContent = tr("{n} selected", { n: chosen.length });
      }
    } else if (ready) {
      metaLeft.textContent = tr("Nothing selected");
    }
    metaRight.textContent = `${appState.selectedFormat} · ${appState.selectedQuality}`;

    downloadBtn.textContent = tr("Download selected ({n})", { n: chosen.length });
    downloadBtn.disabled = !chosen.length;
  }

  function render() {
    const m = getModel();
    drawn =
      m && !m.loading && !m.error ? drawn : { items: null, rev: -1, key: "" };

    if (!m) {
      titleEl.textContent = tr("Playlist");
      titleEl.removeAttribute("title");
      subtitleEl.textContent = tr(emptyText);
      listEl.replaceChildren(messageRow(tr(emptyText)));
    } else if (m.loading) {
      titleEl.textContent = m.title || tr("Playlist");
      const text = tr(m.loadingText || "Reading playlist…");
      // the total is known before the list: say it, the loading row below says the rest
      subtitleEl.textContent = m.count
        ? `${m.author ? m.author + " · " : ""}${tr(m.count === 1 ? "{n} video" : "{n} videos", { n: m.count })}`
        : "";
      listEl.replaceChildren(loadingRow(text));
    } else if (m.error) {
      titleEl.textContent = m.title || tr("Playlist");
      subtitleEl.textContent = tr(m.error);
      listEl.replaceChildren(messageRow(tr(m.error)));
    } else {
      const count = m.items.length;
      titleEl.textContent = m.title || tr("Playlist");
      titleEl.title = m.title || "";
      subtitleEl.textContent = `${m.author ? m.author + " · " : ""}${tr(count === 1 ? "{n} video" : "{n} videos", { n: count })}`;

      const shown = visibleItems(m);
      const key = shown.map((i) => i.index).join(",");
      if (
        drawn.items !== m.items ||
        drawn.rev !== m.rev ||
        drawn.key !== key
      ) {
        rowEls.clear();
        const frag = document.createDocumentFragment();
        for (const item of shown) {
          const row = makeRow(item);
          rowEls.set(item, row);
          frag.appendChild(row);
        }
        listEl.replaceChildren(
          ...(shown.length ? [frag] : [messageRow(tr("No videos match"))]),
        );
        listEl.scrollTop = 0;
        // Open on the video the person pasted, so it is easy to find inside its playlist
        const here = m.focusId
          ? shown.find((i) => i.id === m.focusId && rowEls.get(i))
          : null;
        if (here) {
          const row = rowEls.get(here);
          row.classList.add("current");
          listEl.scrollTop = Math.max(
            0,
            row.offsetTop - (listEl.clientHeight - row.offsetHeight) / 2,
          );
        }
        drawn = { items: m.items, rev: m.rev, key };
      }
      shown.forEach(paintRow);
    }

    updateChrome();
    requestAnimationFrame(updateFade);
  }

  searchEl.addEventListener("input", () => {
    query = searchEl.value;
    const m = getModel();
    if (m && !m.loading && !m.error) {
      const picked = rangeSet(m);
      if (picked) m.items.forEach((i) => (i.selected = picked.has(i.index)));
    }
    render();
  });

  allBtn.addEventListener("click", () => {
    const m = getModel();
    if (!m || m.loading || m.error) return;
    const shown = visibleItems(m);
    const all = shown.every((i) => i.selected);
    shown.forEach((i) => {
      i.selected = !all;
      paintRow(i);
    });
    updateChrome();
  });

  downloadBtn.addEventListener("click", () => {
    const m = getModel();
    if (!m || m.loading || m.error) return;
    const chosen = m.items.filter((i) => i.selected);
    if (chosen.length) onDownload(m, chosen);
  });

  return {
    render,
    refreshLayout: updateFade,
    focusSearch: () => searchEl.focus({ preventScroll: true }),
    reset: () => {
      searchEl.value = "";
      query = "";
    },
  };
}

/* ############################################################################
 # SECTION: playlist-data
 # Where the playlist view gets its data.
 ############################################################################ */

/* ---- data: the pasted link ---- */
const LOADING_MODEL = {
  url: "",
  title: "Playlist",
  author: "",
  items: [],
  loading: true,
  rev: 0,
};

/** A lone video, in the same shape as a playlist (so the popover can list it too). */
function singleModel() {
  let model = appState.single;
  if (!model || model.url !== appState.url) {
    model = appState.single = {
      url: appState.url,
      title: "",
      author: "",
      rev: 0,
      items: [
        {
          url: appState.url,
          index: 1,
          selected: true,
          title: "",
          thumb: "",
          duration: 0,
          channel: "",
        },
      ],
    };
  }
  const src = appState.info || appState.quick || {};
  const pv = appState.preview || {};
  const item = model.items[0];
  const next = {
    title: src.title || pv.title || "Fetching info…",
    thumb: src.thumb || pv.thumb || "",
    duration: duration(),
    channel: src.uploader || src.channel || pv.uploader || "",
  };
  if (Object.keys(next).some((k) => item[k] !== next[k])) {
    Object.assign(item, next);
    model.title = next.title;
    model.author = next.channel;
    model.rev++;
  }
  return model;
}

/** What the popover shows: the playlist, or the lone video, or "reading…". */
function inputModel() {
  if (!appState.url) return null;
  if (appState.playlist) return appState.playlist;
  if (appState.loading) {
    const s = appState.plSummary;
    return s
      ? {
          ...LOADING_MODEL,
          url: appState.url,
          title: s.title || LOADING_MODEL.title,
          author: s.author || "",
          count: s.count || 0,
        }
      : LOADING_MODEL;
  }
  const found = appState.found;
  if (found?.searching)
    return {
      ...LOADING_MODEL,
      url: appState.url,
      title: singleModel().title,
      loadingText: "Looking for this video's playlist…",
    };
  if (found?.model) return found.model;
  return singleModel();
}

const isYoutubeLink = (url) => {
  try {
    return /(^|\.)(youtube\.com|youtu\.be)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

/**
 * A lone video link says nothing about playlists, so the main process looks through the
 * playlists of the video's channel. The result is only for the popover: the big download
 * button still downloads the one video that was pasted.
 */
async function startPlaylistSearch(url, token, background = false) {
  if (!window.api?.findVideoPlaylist || !isYoutubeLink(url)) return;
  appState.found = { searching: true, model: null };
  syncPeek();
  let res = null;
  try {
    res = await window.api.findVideoPlaylist(url, background ? { background: true } : undefined);
  } catch {
    res = null;
  }
  if (token !== analyzeToken) return; // the link changed while we were looking
  const ok = !!(res && res.success && res.items?.length);
  appState.found = {
    searching: false,
    model: ok ? foundModel(res, url) : null,
  };
  syncPeek();
}

/** The playlist the main process found for a video link, in the shape the views draw. */
function foundModel(res, videoUrl) {
  return {
    url: res.playlistUrl || videoUrl,
    title: res.playlistTitle || "Playlist",
    author: res.playlistAuthor || "",
    items: res.items.map((i) => ({ ...i, selected: true })),
    focusId: pastedVideoId(videoUrl),
    rev: 0,
  };
}

/**
 * A YouTube link that carries a playlist (watch?v=...&list=...) becomes the playlist's own
 * address, which lists every video of it; other links stay as they are.
 */
function canonicalPlaylistUrl(url) {
  try {
    const u = new URL(url);
    const list = u.searchParams.get("list");
    if (
      list &&
      !list.toUpperCase().startsWith("RD") &&
      /(^|\.)(youtube\.com|youtu\.be)$/i.test(u.hostname)
    )
      return `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`;
  } catch {}
  return url;
}

/** The id of the video a pasted link points at ("" for a bare playlist link). */
function pastedVideoId(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)youtu\.be$/i.test(u.hostname))
      return u.pathname.slice(1).split("/")[0] || "";
    return u.searchParams.get("v") || "";
  } catch {
    return "";
  }
}

async function fetchPlaylistModel(url) {
  const ask = async (target) => {
    try {
      return window.api?.fetchPlaylistItems
        ? await window.api.fetchPlaylistItems(target)
        : null;
    } catch {
      return null;
    }
  };
  const canonical = canonicalPlaylistUrl(url);
  let res = await ask(canonical);
  if ((!res || !res.success || !res.items?.length) && canonical !== url)
    res = await ask(url); // the playlist's own address failed: try the link as pasted
  if (!res || !res.success || !res.items?.length) return null;
  return {
    url,
    focusId: pastedVideoId(url), // the video the person pasted: marked and scrolled to
    title: res.playlistTitle || "Playlist",
    author: res.playlistAuthor || "",
    items: res.items.map((i) => ({ ...i, selected: true })),
    rev: 0,
  };
}

async function loadPlaylist(url) {
  // First, in a moment: the playlist's name and how many videos it holds. The icon and the
  // popover show them while the list itself is still being read.
  const token = analyzeToken;
  appState.plSummary = null;
  window.api
    ?.fetchPlaylistSummary?.(canonicalPlaylistUrl(url))
    .then((s) => {
      if (token !== analyzeToken || appState.playlist) return; // outdated, or the list came first
      if (s && s.success && (s.title || s.count)) {
        appState.plSummary = s;
        syncPeek();
      }
    })
    .catch(() => {});
  syncPeek();
  const model = await fetchPlaylistModel(url);
  appState.playlist = model;
  syncPeek();
  return !!model;
}

/* ############################################################################
 # SECTION: playlist-popover
 # The playlist popover under the link bar.
 ############################################################################ */

/* ---- the popover under the link bar ---- */
async function downloadFromPopover(model, chosen) {
  if (adding || !chosen.length) return;
  closeAllPopovers();
  // A lone video downloads exactly like the big button (trim, format, quality...)
  if (model === appState.single) return triggerDownload();
  adding = true;
  try {
    if (await enqueuePlaylist(chosen, model.title, model.url)) {
      urlInput.value = "";
      appState.playlist = null;
      resetComposer();
      applyEmbedDefaults();
    }
  } finally {
    adding = false;
  }
}

const popoverView = createPlaylistView(playlistPopoverHost, {
  getModel: inputModel,
  emptyText: "Paste a link to see its videos",
  onDownload: downloadFromPopover,
});

/** The arrow points at the button; the popover opens a little to its left (as designed). */
function placePlaylistPopover() {
  const host = playlistPopover.offsetParent;
  if (!host) return;
  const hostRect = host.getBoundingClientRect();
  const btnRect = btnExplorePlaylist.getBoundingClientRect();
  const cx = btnRect.left + btnRect.width / 2;
  const w = playlistPopover.offsetWidth;
  const margin = 12;
  const left = clamp(
    cx - 76,
    margin,
    Math.max(margin, window.innerWidth - margin - w),
  );
  playlistPopover.style.left = `${Math.round(left - hostRect.left)}px`;
  playlistPopover.style.setProperty(
    "--caret-x",
    `${Math.round(clamp(cx - left - 5, 14, w - 24))}px`,
  );
  setPopoverTop(playlistPopover);
}

function openPlaylistPopover() {
  playlistPopover.classList.remove("hidden");
  btnExplorePlaylist.setAttribute("aria-expanded", "true");
  popoverView.render();
  placePlaylistPopover();
  popoverView.refreshLayout();
  popoverView.focusSearch();
}

btnExplorePlaylist.addEventListener("click", (e) => {
  e.stopPropagation();
  const wasHidden = playlistPopover.classList.contains("hidden");
  closeAllPopovers();
  if (wasHidden) openPlaylistPopover();
});

window.addEventListener("resize", () => {
  if (!playlistPopover.classList.contains("hidden")) placePlaylistPopover();
});

/**
 * The button takes the link icon's place as soon as there is a link, and shows how many
 * videos it holds (1 for a lone video). No link: the link icon comes back.
 */
function syncPeek() {
  if (!playlistViewsReady) return;
  const hasLink = !!appState.url && !appState.failed;
  playlistPeekWrapper.classList.toggle("hidden", !hasLink);
  urlLinkIcon.classList.toggle("hidden", hasLink);

  if (hasLink) {
    const model = inputModel();
    const loading = !!model.loading;
    const known = loading && Number(model.count) > 0; // the total is known before the list
    const count = loading ? (known ? model.count : 0) : model.items.length;
    playlistPeekBadge.classList.toggle("is-loading", loading && !known);
    playlistPeekBadge.textContent =
      loading && !known ? "" : count > 999 ? "999+" : String(count);
    btnExplorePlaylist.title = loading
      ? known
        ? `${model.title} · ${count} video${count === 1 ? "" : "s"} · reading the list…`
        : "Reading playlist…"
      : appState.playlist || appState.found?.model
        ? `Explore playlist · ${count} video${count === 1 ? "" : "s"}`
        : "Show this video";
    if (!playlistPopover.classList.contains("hidden")) {
      popoverView.render();
      placePlaylistPopover();
    }
  } else {
    playlistPopover.classList.add("hidden");
    btnExplorePlaylist.setAttribute("aria-expanded", "false");
  }

  if (!playlistViewContainer.classList.contains("hidden")) panelView.render();
}

/* ############################################################################
 # SECTION: playlist-panel
 # The playlist side panel opened from 'Explore Playlist' in the queue's right-click menu.
 ############################################################################ */

/* ---- the side panel: "Explore Playlist" from the queue's right-click menu ---- */
let panelModel = null;
let panelToken = 0;

const panelView = createPlaylistView(playlistPanelHost, {
  getModel: () => panelModel,
  emptyText: "Right-click a download and choose Explore Playlist",
  onDownload: async (model, chosen) => {
    if (adding || !chosen.length) return;
    adding = true;
    try {
      await enqueuePlaylist(chosen, model.title, model.url);
    } finally {
      adding = false;
    }
  },
});

function showPlaylistPanel(show) {
  playlistViewContainer.classList.toggle("hidden", !show);
  togglePlaylistViewBtn.classList.toggle("active", show);
  if (show) {
    panelView.render();
    requestAnimationFrame(panelView.refreshLayout);
  }
}

togglePlaylistViewBtn.addEventListener("click", () =>
  showPlaylistPanel(playlistViewContainer.classList.contains("hidden")),
);

/** The playlist a download came from ("" when it is not part of one). */
function playlistUrlOf(task) {
  if (task.playlistUrl) return task.playlistUrl;
  if (!task.url || !checkIfPlaylistUrl(task.url)) return "";
  return canonicalPlaylistUrl(task.url);
}

/**
 * "Explore Playlist" works for every download, whatever its status. A download that came
 * from a playlist (or whose link carries one) opens that playlist; any other one is
 * resolved from its link, the same way the popover does it for a pasted video.
 */
async function explorePlaylist(task) {
  const known = playlistUrlOf(task);
  const key = known || task.url;
  closeAllPopovers();
  showPlaylistPanel(true);
  // Same download as before: keep its playlist (and what was ticked) instead of reading it again
  if (panelModel && panelModel.key === key && !panelModel.error) return;

  const token = ++panelToken;
  const shell = {
    url: key,
    key,
    title: "Playlist",
    author: "",
    items: [],
    rev: 0,
  };
  panelModel = {
    ...shell,
    loading: true,
    loadingText: known
      ? "Reading playlist…"
      : "Looking for this video's playlist…",
  };
  panelView.reset();
  panelView.render();

  let model = null;
  if (known) {
    model = await fetchPlaylistModel(known);
    if (model) model.focusId = pastedVideoId(task.url);
  }
  if (!model && window.api?.findVideoPlaylist && isYoutubeLink(task.url)) {
    if (token !== panelToken) return;
    panelModel = {
      ...shell,
      loading: true,
      loadingText: "Looking for this video's playlist…",
    };
    panelView.render();
    let res = null;
    try {
      res = await window.api.findVideoPlaylist(task.url);
    } catch {
      res = null;
    }
    if (res && res.success && res.items?.length)
      model = foundModel(res, task.url);
  }
  if (token !== panelToken) return; // another download was explored meanwhile

  if (model) {
    model.key = key;
    panelModel = model;
  } else {
    const error = known
      ? "Couldn't read this playlist"
      : "No playlist found for this video";
    panelModel = { ...shell, error };
    showToast(error, "info");
  }
  panelView.render();
  panelView.refreshLayout();
}

playlistViewsReady = true;

// A new interface language: both playlist views draw their texts again
window.addEventListener("languageChanged", () => {
  popoverView.render();
  if (!playlistViewContainer.classList.contains("hidden")) panelView.render();
});
