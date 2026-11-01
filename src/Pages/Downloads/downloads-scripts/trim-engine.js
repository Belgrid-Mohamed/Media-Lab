/** ============================================================================
 * downloads-scripts/trim-engine.js
 * The trim (cut) feature: shared trim state, storyboard filmstrip, clip selection / timeline dragging / chapters, and the trim dialog.
 * Loads after queue-scripts.js. Works together with video-player.js (the player is the trim preview).
 *
 * Sections (in file order) and their features:
 *
 *  [trim-state] Shared state and small helpers for the trim (cut) feature.
 *    - trimSel (clip start/end), trimPlay (playhead), trimFilm (filmstrip), trimVid (video state)
 *    - clamp, cssUrl, trimDialogOpen
 *    - Mode checks: videoMode, framesMode, canPlay (video vs storyboard frames)
 *
 *  [trim-filmstrip] Storyboard frames and the filmstrip shown on the trim timeline.
 *    - frameCell / frameStyle / paintFrame: pick and paint a storyboard frame for a time
 *    - ensureSheetsLoaded: loads the storyboard sheets
 *    - captureTiles: captures real frames from the video
 *    - buildFilmstrip: builds the tile strip
 *
 *  [trim-selection] The trim selection: range, timeline dragging and chapters.
 *    - setTrimRange, moveTrimHandle, updateTrimUI
 *    - Dragging on the timeline: move the clip, resize either edge
 *    - Edge keyboard control: arrows = 1 s, Shift+arrows = 10 s, Home / End
 *    - Start / End time inputs
 *    - Chapters list: click cuts that chapter, Shift/Ctrl+click adds it to the clip
 *
 *  [trim-dialog] Opening, closing and resetting the trim popover.
 *    - placeTrimPopover (arrow points at the scissors button)
 *    - openTrimDialog / closeTrimDialog and repositioning on window resize
 *    - Reset and Done buttons (Done applies the trim to the download and shows a toast)
 *    - Space plays / pauses while the dialog is open
 *
 * Split from the old downloads-script.js. The five files are classic scripts that share one
 * scope (like the old single closure), so they can call each other's functions freely.
 * Load order, set in downloads-index.html: core, queue-scripts, trim-engine, video-player, playlist-explorer.
 * ========================================================================== */

/* ############################################################################
 # SECTION: trim-state
 # Shared state and small helpers for the trim (cut) feature.
 ############################################################################ */

/* ---- trim (cut) popover ----
 * trimSel  = the clip: start / end in seconds (start >= 0, end <= duration, length >= 1 s).
 * trimPlay = the playhead (the moment the player shows) and the play loop.
 *
 * The player, best source first:
 *   1. a small copy of the real video, streamed by the app itself (info.preview), with
 *      sound when the stream has it
 *   2. YouTube's storyboard sprite sheets: still frames stepped in real time
 *   3. the thumbnail
 * The filmstrip under it: storyboard frames, else frames grabbed from the video,
 * else plain cells.
 */
const trimSel = { start: 0, end: 0 };
const trimPlay = { t: 0, playing: false, raf: 0, last: 0 };
const trimFilm = {
  sheetsKey: "",
  ready: false, // the first sprite sheet has loaded
  imgs: [],
  stripKey: "",
  frameKey: "",
};
const trimVid = {
  src: "",
  state: "idle", // idle | loading | ready | failed
  key: "",
  reason: "",
  quality: 0, // preview height chosen in the player's menu, 0 = automatic
  switching: false, // a copy in another quality is being prepared
  resumePlay: false, // keep playing once the new copy has loaded
  picked: false, // the person chose a quality in the menu (the download quality stops steering it)
  refused: 0, // a height that could not be prepared: not tried again
  partial: false, // only the first seconds are loaded; the whole copy is still coming
  headSeconds: 0, // how long those first seconds are
  waiting: false, // the person asked for a moment that isn't loaded yet
  wantAt: 0, // that moment (seconds); the playing clock would otherwise overwrite it
  percent: 0, // how far the whole copy (or a quality switch) is
  switchTo: 0, // the quality being switched to
  poster: false, // show the thumbnail instead of the (often black) first frame
  stream: false, // played piece by piece (MediaSource), not from a file
  heights: null, // the qualities this video really has (known as soon as the stream opens)
  capSrc: "", // a small whole copy, only used to draw the filmstrip when the stream can't
  capReq: false,
  tilesFailed: false, // no filmstrip pictures from the stream
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const cssUrl = (u) =>
  String(u).replace(/["\\\r\n]/g, (c) => encodeURIComponent(c));
const trimDialogOpen = () => !trimPopover.classList.contains("hidden");
const storyboard = () => appState.info?.storyboard || null;
const videoMode = () => trimVid.state === "ready";
const framesMode = () => !videoMode() && !!storyboard() && trimFilm.ready;
const canPlay = () => videoMode() || framesMode();

/* ############################################################################
 # SECTION: trim-filmstrip
 # Storyboard frames and the filmstrip shown on the trim timeline.
 ############################################################################ */

/* ---- storyboard frames ---- */
/** Which sprite sheet and cell show the picture at `t` seconds. */
function frameCell(sb, t) {
  const per = sb.cols * sb.rows;
  const frames = Math.max(
    1,
    Math.min(per * sb.sheets.length, Math.ceil(duration() / sb.interval)),
  );
  const idx = clamp(Math.floor(t / sb.interval), 0, frames - 1);
  const sheet = Math.min(sb.sheets.length - 1, Math.floor(idx / per));
  const inSheet = idx - sheet * per;
  return {
    sheet,
    col: inSheet % sb.cols,
    row: Math.floor(inSheet / sb.cols),
  };
}

/** Percentage-based style: the same rule fits a box of any size (used by the player). */
function frameStyle(sb, t) {
  const { sheet, col, row } = frameCell(sb, t);
  return {
    url: sb.sheets[sheet],
    size: `${sb.cols * 100}% ${sb.rows * 100}%`,
    pos: `${sb.cols > 1 ? (col / (sb.cols - 1)) * 100 : 0}% ${sb.rows > 1 ? (row / (sb.rows - 1)) * 100 : 0}%`,
  };
}

function paintFrame(el, f) {
  el.style.backgroundImage = `url("${cssUrl(f.url)}")`;
  el.style.backgroundSize = f.size;
  el.style.backgroundPosition = f.pos;
}

/** A narrow slice of a frame, cropped to fill a filmstrip tile of tw x th pixels. */
function paintTileFrame(tile, sb, t, tw, th) {
  const { sheet, col, row } = frameCell(sb, t);
  const ratio = sb.width / sb.height;
  const cellH = Math.max(th, tw / ratio); // scale the frame so it covers the tile
  const cellW = cellH * ratio;
  tile.style.backgroundImage = `url("${cssUrl(sb.sheets[sheet])}")`;
  tile.style.backgroundSize = `${sb.cols * cellW}px ${sb.rows * cellH}px`;
  tile.style.backgroundPosition = `${-(col * cellW + (cellW - tw) / 2)}px ${-(row * cellH + (cellH - th) / 2)}px`;
}

/** Warms the first sprite sheets so scrubbing doesn't wait for the network. */
function ensureSheetsLoaded(sb) {
  const key = sb ? sb.sheets[0] : "";
  if (trimFilm.sheetsKey === key) return;
  trimFilm.sheetsKey = key;
  trimFilm.ready = false;
  trimFilm.imgs = [];
  trimFilm.stripKey = "";
  trimFilm.frameKey = "";
  if (!sb) return;
  sb.sheets.slice(0, 6).forEach((url, i) => {
    const img = new Image();
    img.onload = () => {
      if (i !== 0 || trimFilm.sheetsKey !== key) return;
      trimFilm.ready = true;
      trimFilm.stripKey = "";
      trimFilm.frameKey = "";
      if (trimDialogOpen()) updateTrimUI();
    };
    img.src = url;
    trimFilm.imgs.push(img);
  });
}

/* ---- filmstrip ---- */
let captureToken = 0;

/** Fills the tiles with frames grabbed from the preview video, one seek at a time. */
async function captureTiles(key, tiles, times, tw, th) {
  const token = ++captureToken;
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  const waitFor = (name, ms) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), ms);
      v.addEventListener(
        name,
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      v.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("video error"));
        },
        { once: true },
      );
    });
  try {
    const loaded = waitFor("loadeddata", 10000);
    v.src = trimVid.capSrc || trimVid.src;
    await loaded;
    for (let i = 0; i < tiles.length; i++) {
      if (token !== captureToken || trimFilm.stripKey !== key) return;
      const seeked = waitFor("seeked", 8000);
      v.currentTime = Math.min(
        times[i],
        Math.max(0, (v.duration || times[i]) - 0.1),
      );
      await seeked;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(tw * 2);
      canvas.height = Math.round(th * 2);
      const vw = v.videoWidth || 16;
      const vh = v.videoHeight || 9;
      const scale = Math.max(canvas.width / vw, canvas.height / vh); // cover
      const dw = vw * scale;
      const dh = vh * scale;
      canvas
        .getContext("2d")
        .drawImage(
          v,
          (canvas.width - dw) / 2,
          (canvas.height - dh) / 2,
          dw,
          dh,
        );
      tiles[i].appendChild(canvas);
    }
  } catch {
    /* the plain cells stay: nothing to show */
  } finally {
    v.removeAttribute("src");
    v.load();
  }
}

/** The row of thumbnails under the player. */
function buildFilmstrip() {
  const d = duration();
  const w = trimSlider.clientWidth;
  const h = trimSlider.clientHeight;
  if (!w || !h || !d) return;
  const sb = storyboard();
  const mode = framesMode()
    ? "frames"
    : trimStream.active && !trimVid.tilesFailed
      ? "tiles" // pictures cut from the stream, one by one
      : videoMode() &&
          !trimVid.partial &&
          (!trimVid.stream || !!trimVid.capSrc) // needs a whole copy
        ? "capture"
        : "plain";
  const key = `${mode}|${mode === "frames" ? sb.sheets[0] : mode === "capture" || mode === "tiles" ? trimVid.key : ""}|${w}|${h}|${d}`;
  if (key === trimFilm.stripKey) return;
  trimFilm.stripKey = key;

  // narrow slices (about 0.65 x the height), like a video editor's timeline
  const n = clamp(Math.round(w / (h * 0.65)), 4, 24);
  const tw = w / n;
  trimFilmstrip.innerHTML = "";
  const tiles = [];
  const times = [];
  for (let i = 0; i < n; i++) {
    const tile = document.createElement("div");
    tile.className = "trim-tile";
    const t = ((i + 0.5) / n) * d;
    if (mode === "frames") paintTileFrame(tile, sb, t, tw, h);
    trimFilmstrip.appendChild(tile);
    tiles.push(tile);
    times.push(t);
  }
  if (mode === "capture") captureTiles(key, tiles, times, tw, h);
  if (mode === "tiles") {
    trimTiles.els = tiles;
    refreshTileImages(); // pictures that arrived before the strip existed
    if (trimTiles.data.filter(Boolean).length < TILE_GRID)
      window.api?.streamTiles?.(trimStream.sessionId, {}).catch(() => {});
  }
}

/* ############################################################################
 # SECTION: trim-selection
 # The trim selection: range, timeline dragging and chapters.
 ############################################################################ */

/* ---- selection ---- */
function setTrimRange(start, end) {
  const d = duration();
  if (!d) return;
  start = clamp(Math.floor(start), 0, d - 1);
  end = clamp(Math.ceil(end), start + 1, d);
  trimSel.start = start;
  trimSel.end = end;
  updateTrimUI();
}

/** Moves one edge; it stops 1 second short of the other instead of pushing it. */
function moveTrimHandle(which, seconds) {
  if (which === "start")
    setTrimRange(Math.min(seconds, trimSel.end - 1), trimSel.end);
  else setTrimRange(trimSel.start, Math.max(seconds, trimSel.start + 1));
}

function markChapterRows() {
  const partial = trimSel.start > 0 || trimSel.end < duration();
  chaptersPillList.querySelectorAll(".chapter-row").forEach((row) => {
    const inside =
      Number(row.dataset.start) >= trimSel.start &&
      Number(row.dataset.end) <= trimSel.end;
    row.classList.toggle("active", partial && inside);
  });
}

function updateTrimUI() {
  const d = duration();
  const max = Math.max(d, 1);
  trimSel.start = clamp(trimSel.start, 0, Math.max(0, d - 1));
  trimSel.end = clamp(trimSel.end || d, trimSel.start + 1, Math.max(d, 1));
  const { start, end } = trimSel;

  const startPct = (start / max) * 100;
  const endPct = (end / max) * 100;
  trimRange.style.left = `${startPct}%`;
  trimRange.style.width = `${endPct - startPct}%`;
  trimShadeLeft.style.width = `${startPct}%`;
  trimShadeRight.style.width = `${100 - endPct}%`;

  [
    [trimHandleStart, start, "Trim start"],
    [trimHandleEnd, end, "Trim end"],
  ].forEach(([el, value, name]) => {
    el.setAttribute("aria-valuemin", "0");
    el.setAttribute("aria-valuemax", String(d));
    el.setAttribute("aria-valuenow", String(value));
    el.setAttribute("aria-valuetext", `${name} ${formatClock(value)}`);
  });

  // Don't overwrite a field while the user is typing in it
  if (document.activeElement !== trimStartInput)
    trimStartInput.value = formatClock(start);
  if (document.activeElement !== trimEndInput)
    trimEndInput.value = formatClock(end);
  trimMinLabel.textContent = formatClock(0);
  trimMaxLabel.textContent = formatClock(d);
  trimClipLengthText.textContent = formatClock(end - start);

  markChapterRows();
  ensureSheetsLoaded(storyboard());
  if (trimDialogOpen()) ensureVideo();
  buildFilmstrip();
  renderPlayhead();
  renderPreview();
}

/* ---- dragging on the timeline ----
 *   near the left / right edge  -> move that edge
 *   inside the clip             -> move the whole clip (click = jump the playhead there)
 *   outside the clip            -> move the playhead (scrub)
 */
const EDGE_PX = 10;
let trimDrag = null; // { mode, offset, length, originX, moved }

function trimTimeAt(clientX) {
  const r = trimSlider.getBoundingClientRect();
  return Math.round(clamp((clientX - r.left) / r.width, 0, 1) * duration());
}

function trimHit(clientX) {
  const r = trimSlider.getBoundingClientRect();
  const d = Math.max(duration(), 1);
  const sx = r.left + (trimSel.start / d) * r.width;
  const ex = r.left + (trimSel.end / d) * r.width;
  const inner = Math.min(EDGE_PX, (ex - sx) / 3); // a tiny clip keeps its two edges apart
  if (clientX >= sx - EDGE_PX && clientX <= sx + inner) return "start";
  if (clientX >= ex - inner && clientX <= ex + EDGE_PX) return "end";
  if (clientX > sx + inner && clientX < ex - inner) {
    // A clip that is the whole video can't move: dragging inside it scrubs instead
    return trimSel.start === 0 && trimSel.end >= duration()
      ? "scrub"
      : "move";
  }
  return "scrub";
}

trimSlider.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !duration()) return;
  e.preventDefault();
  const mode = trimHit(e.clientX);
  const t = trimTimeAt(e.clientX);
  trimDrag = {
    mode,
    originX: e.clientX,
    moved: false,
    length: trimSel.end - trimSel.start,
    // keeps the grabbed point under the pointer instead of snapping the edge to it
    offset: mode === "end" ? t - trimSel.end : t - trimSel.start,
  };
  trimSlider.setPointerCapture(e.pointerId);
  if (mode === "scrub") setPlayhead(t);
  if (mode === "start") setPlayhead(trimSel.start);
  if (mode === "end") setPlayhead(trimSel.end);
  if (mode === "move") trimSlider.style.cursor = "grabbing";
});

trimSlider.addEventListener("pointermove", (e) => {
  if (!trimDrag) {
    // hover: show what a drag here would do
    const mode = duration() ? trimHit(e.clientX) : "scrub";
    trimSlider.style.cursor =
      mode === "start" || mode === "end"
        ? "ew-resize"
        : mode === "move"
          ? "grab"
          : "pointer";
    return;
  }
  if (Math.abs(e.clientX - trimDrag.originX) > 2) trimDrag.moved = true;
  const t = trimTimeAt(e.clientX);
  const d = duration();
  if (trimDrag.mode === "scrub") {
    setPlayhead(t);
  } else if (trimDrag.mode === "start") {
    moveTrimHandle("start", t - trimDrag.offset);
    setPlayhead(trimSel.start);
  } else if (trimDrag.mode === "end") {
    moveTrimHandle("end", t - trimDrag.offset);
    setPlayhead(trimSel.end);
  } else {
    const s = clamp(t - trimDrag.offset, 0, d - trimDrag.length);
    setTrimRange(s, s + trimDrag.length);
    setPlayhead(trimSel.start);
  }
});

const endTrimDrag = (e) => {
  if (!trimDrag) return;
  // A click (no drag) inside the clip jumps the playhead there
  if (trimDrag.mode === "move" && !trimDrag.moved)
    setPlayhead(trimTimeAt(e.clientX));
  trimDrag = null;
  trimSlider.style.cursor = "";
  if (trimSlider.hasPointerCapture?.(e.pointerId))
    trimSlider.releasePointerCapture(e.pointerId);
};
trimSlider.addEventListener("pointerup", endTrimDrag);
trimSlider.addEventListener("pointercancel", endTrimDrag);

// Keyboard on the edges: arrows = 1 s, Shift+arrows = 10 s, Home / End = the video's ends
[
  [trimHandleStart, "start"],
  [trimHandleEnd, "end"],
].forEach(([el, which]) => {
  el.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 10 : 1;
    const current = which === "start" ? trimSel.start : trimSel.end;
    let next = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = current - step;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp")
      next = current + step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = duration();
    if (next === null) return;
    e.preventDefault();
    moveTrimHandle(which, next);
    setPlayhead(which === "start" ? trimSel.start : trimSel.end);
  });
});

trimStartInput.addEventListener("change", () => {
  const sec = parseClock(trimStartInput.value);
  if (sec === null) return updateTrimUI();
  moveTrimHandle("start", sec);
  trimStartInput.value = formatClock(trimSel.start);
  setPlayhead(trimSel.start);
});
trimEndInput.addEventListener("change", () => {
  const sec = parseClock(trimEndInput.value);
  if (sec === null) return updateTrimUI();
  moveTrimHandle("end", sec);
  trimEndInput.value = formatClock(trimSel.end);
  setPlayhead(trimSel.end);
});

/* ---- chapters ---- */
function renderChaptersList() {
  chaptersPillList.innerHTML = "";
  if (isFullPending() && !isLiveLink()) {
    trimChaptersSection.classList.remove("hidden");
    chaptersPillList.appendChild(loadingRow("Loading chapters…"));
    return;
  }
  const chapters = appState.info?.chapters || [];
  trimChaptersSection.classList.toggle("hidden", !chapters.length);
  if (!chapters.length) return;
  chapters.forEach((ch) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "chapter-row";
    row.dataset.start = ch.start;
    row.dataset.end = ch.end;
    row.title = `${ch.name} · ${formatClock(ch.start)} – ${formatClock(ch.end)}`;
    const name = document.createElement("span");
    name.className = "chapter-name";
    name.textContent = ch.name;
    const time = document.createElement("span");
    time.className = "chapter-time";
    time.textContent = formatClock(ch.start);
    row.append(name, time);
    chaptersPillList.appendChild(row);
  });
  markChapterRows();
}

// Click a chapter to cut exactly that chapter; Shift/Ctrl+click adds it to the clip
chaptersPillList.addEventListener("click", (e) => {
  const row = e.target.closest(".chapter-row");
  if (!row) return;
  let start = Number(row.dataset.start);
  let end = Number(row.dataset.end);
  if (e.shiftKey || e.ctrlKey || e.metaKey) {
    start = Math.min(start, trimSel.start);
    end = Math.max(end, trimSel.end);
  }
  setTrimRange(start, end);
  setPlayhead(trimSel.start);
});

/* ############################################################################
 # SECTION: trim-dialog
 # Opening, closing and resetting the trim popover.
 ############################################################################ */

/* ---- open / close / reset / done ---- */
/** The arrow points at the scissors button; the popover extends to the left of it (as designed). */
function placeTrimPopover() {
  const wrapper = trimPopover.offsetParent;
  if (!wrapper) return;
  const wr = wrapper.getBoundingClientRect();
  const br = btnToggleCut.getBoundingClientRect();
  const cx = br.left + br.width / 2;
  const w = trimPopover.offsetWidth;
  const margin = 12;
  const left = clamp(
    cx + 103 - w,
    margin,
    Math.max(margin, window.innerWidth - margin - w),
  );
  trimPopover.style.left = `${Math.round(left - wr.left)}px`;
  trimPopover.style.setProperty(
    "--caret-x",
    `${Math.round(clamp(cx - left - 5, 14, w - 24))}px`,
  );
  setPopoverTop(trimPopover);
}

function openTrimDialog() {
  if (appState.trim.active) {
    trimSel.start = appState.trim.start;
    trimSel.end = appState.trim.end;
  }
  trimPopover.classList.remove("hidden"); // visible first: the filmstrip is sized from it
  placeTrimPopover();
  trimFilm.stripKey = "";
  trimPlay.t = trimSel.start; // the player opens on the first frame of the clip
  updateTrimUI(); // also starts loading the preview video
  adoptDownloadQuality();
}

function closeTrimDialog() {
  stopTrimPlay();
  if (document.fullscreenElement === trimPreview)
    document.exitFullscreen().catch(() => {});
  trimPopover.classList.add("hidden");
}

window.addEventListener("resize", () => {
  if (!trimDialogOpen()) return;
  placeTrimPopover();
  trimFilm.stripKey = "";
  updateTrimUI();
});

document.addEventListener("keydown", (e) => {
  if (!trimDialogOpen() || e.code !== "Space") return;
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "BUTTON") return;
  e.preventDefault();
  toggleTrimPlay();
});

trimResetBtn.addEventListener("click", () => {
  appState.trim = { active: false, start: 0, end: duration(), exact: false };
  btnToggleCut.classList.remove("active");
  setTrimRange(0, duration());
  setPlayhead(0);
  syncComposerLock();
});

trimDoneBtn.addEventListener("click", () => {
  const d = duration();
  const start = trimSel.start;
  const end = trimSel.end || d;
  const custom = start > 0 || end < d;
  appState.trim = { active: custom, start, end, exact: false };
  btnToggleCut.classList.toggle("active", custom);
  if (custom)
    showToast(
      tr("Trim set: {a} – {b}", { a: formatClock(start), b: formatClock(end) }),
      "success",
    );
  closeTrimDialog();
  syncComposerLock();
  updateEstimatedSize();
});
