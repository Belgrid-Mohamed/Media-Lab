/** ============================================================================
 * downloads-scripts/video-player.js
 * The trim preview video player: control bar, streaming / file preview, seeking, play / pause and arrow-key skipping.
 * Loads after trim-engine.js. Uses the trim state defined in trim-engine.js.
 *
 * Sections (in file order) and their features:
 *
 *  [player-controls] The YouTube-style player control bar built inside the trim preview.
 *    - Seek bar, play/pause, volume, mute, time display
 *    - Settings menu: playback speed and preview quality
 *    - Fullscreen, auto-hide while playing
 *    - Injects its own styles (trimCtl)
 *
 *  [player-video] The preview video itself: streaming, file preview and seeking.
 *    - 'Loading the rest' pill, loading spinner and seek poster
 *    - Streaming player (trimStream, MediaSource) with the 24 filmstrip tiles from the stream
 *    - Fallback to a small file copy (fallbackToFile, requestFilmCopy)
 *    - ensureVideo, startFilePreview, adoptFullPreview, resetVideo, failVideo
 *    - Video element events (loadeddata, error, ended, playing, seeked)
 *    - Main process events: preview ready and preview progress
 *    - seekVideo (throttled with requestAnimationFrame)
 *
 *  [player-playback] What the player shows and how it plays.
 *    - renderPreview, renderPlayhead, setPlayhead, previewNote
 *    - Play / pause (startTrimPlay, stopTrimPlay, toggleTrimPlay) with the loop inside the clip
 *    - Play/pause badge flash
 *    - Arrow-key skipping with an on-screen skip indicator
 *    - Keyboard and mouse on the player: click, double-click for fullscreen, M mute, F fullscreen
 *    - warmPreview: starts preparing the preview when the pointer reaches the scissors button
 *
 * Split from the old downloads-script.js. The five files are classic scripts that share one
 * scope (like the old single closure), so they can call each other's functions freely.
 * Load order, set in downloads-index.html: core, queue-scripts, trim-engine, video-player, playlist-explorer.
 * ========================================================================== */

/* ############################################################################
 # SECTION: player-controls
 # The YouTube-style player control bar built inside the trim preview.
 ############################################################################ */

/* ---- player controls (YouTube style) ----
 * They show while the pointer is over the player (and fade while a video plays and the
 * pointer rests): seek bar, play / pause, volume, time, settings (speed, quality) and
 * fullscreen. Built here with their own styles, so no other file has to change.
 */
const TRIM_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const TRIM_QUALITIES = [1080, 720, 480, 360, 240, 144];
const trimCtl = (() => {
  const state = { rate: 1, volume: 1, muted: false };
  let idleTimer = 0;
  let leaveTimer = 0;
  let scrubbing = false;
  let qualityNote = "";

  const style = document.createElement("style");
  style.textContent = `
    .trim-controls { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3; padding: 1.8rem 0.55rem 0.3rem;
      background: linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0)); opacity: 0; pointer-events: none;
      transition: opacity 0.18s ease; cursor: default; user-select: none; }
    .trim-preview.ctl-active .trim-controls, .trim-controls:focus-within { opacity: 1; pointer-events: auto; }
    .trim-preview:not(.has-video) .trim-controls { display: none; }
    .trim-preview.ctl-idle { cursor: none; }
    .trim-preview.has-video.playing .trim-play-btn { opacity: 0 !important; pointer-events: none; }
    .tc-seek { position: relative; height: 16px; display: flex; align-items: center; cursor: pointer; touch-action: none; outline: none; }
    .tc-seek-track { position: relative; width: 100%; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.28); transition: height 0.12s ease; }
    .tc-seek:hover .tc-seek-track, .tc-seek.scrubbing .tc-seek-track, .tc-seek:focus-visible .tc-seek-track { height: 5px; }
    .tc-seek-range { position: absolute; top: 0; bottom: 0; background: rgba(255,255,255,0.42); border-radius: 2px; }
    .tc-seek-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: var(--primary-accent); border-radius: 2px; }
    .tc-seek-thumb { position: absolute; top: 50%; left: 0; width: 13px; height: 13px; margin: -6.5px 0 0 -6.5px; border-radius: 50%;
      background: var(--primary-accent); box-shadow: 0 0 0 1px rgba(0,0,0,0.25); pointer-events: none; transform: scale(1); transition: transform 0.12s ease; }
    .tc-seek:hover .tc-seek-thumb, .tc-seek.scrubbing .tc-seek-thumb, .tc-seek:focus-visible .tc-seek-thumb { transform: scale(1.25); }
    .tc-seek-tip { position: absolute; bottom: 18px; left: 0; padding: 0.12rem 0.4rem; border-radius: 4px; background: rgba(0,0,0,0.85);
      color: #fff; font-size: 0.66rem; font-weight: 600; font-variant-numeric: tabular-nums; transform: translateX(-50%);
      pointer-events: none; opacity: 0; transition: opacity 0.1s ease; white-space: nowrap; }
    .tc-seek:hover .tc-seek-tip, .tc-seek.scrubbing .tc-seek-tip { opacity: 1; }
    .tc-row { display: flex; align-items: center; gap: 0.1rem; }
    .tc-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; min-width: 32px; padding: 0; line-height: 0;
      border: none; border-radius: 50%; background: transparent; color: #fff; font: inherit; cursor: pointer;
      transition: background-color 0.15s ease, transform 0.1s ease; }
    .tc-btn svg { display: block; }
    .tc-btn:hover { background: rgba(255,255,255,0.14); }
    .tc-btn:active { transform: scale(0.92); }
    .tc-btn:focus-visible { outline: 2px solid var(--primary-accent); outline-offset: 1px; }
    .trim-preview:not(.playing) .tc-pause, .trim-preview.playing .tc-play { display: none; }
    .tc-vol { display: flex; align-items: center; }
    .tc-vol-range { --v: 100%; -webkit-appearance: none; appearance: none; width: 0; opacity: 0; margin: 0; height: 14px; background: transparent; cursor: pointer; outline: none;
      transition: width 0.15s ease, opacity 0.15s ease, margin 0.15s ease; }
    .tc-vol-range::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; background: linear-gradient(to right, var(--primary-accent) var(--v), rgba(255,255,255,0.3) var(--v)); }
    .tc-vol-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 11px; height: 11px; margin-top: -4px; border: 0; border-radius: 50%; background: var(--primary-accent); }
    .tc-vol:hover .tc-vol-range, .tc-vol:focus-within .tc-vol-range { width: 60px; opacity: 1; margin: 0 0.35rem 0 0.1rem; }
    .tc-on-muted, .trim-controls.is-muted .tc-on-sound { display: none; }
    .trim-controls.is-muted .tc-on-muted { display: block; }
    .tc-time { margin-left: 0.3rem; color: #fff; font-size: 0.7rem; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .tc-spacer { flex: 1; }
    .tc-settings { position: relative; }
    .tc-gear { transition: transform 0.2s ease; }
    .tc-settings.open .tc-gear { transform: rotate(40deg); }
    .tc-menu { position: absolute; right: 0; bottom: calc(100% + 8px); display: none; min-width: 190px; max-height: 150px; overflow-y: auto;
      padding: 0.25rem; background: rgba(18,19,26,0.97); border: 1px solid var(--border-main); border-radius: 10px;
      box-shadow: 0 10px 26px rgba(0,0,0,0.55); }
    .tc-settings.open .tc-menu { display: block; }
    .tc-panel { display: flex; flex-direction: column; }
    .tc-panel.tc-hidden { display: none; }
    .tc-item { display: flex; align-items: center; gap: 0.5rem; width: 100%; padding: 0.32rem 0.55rem; border: none; border-radius: 6px;
      background: transparent; color: #e5e7eb; font: inherit; font-size: 0.74rem; text-align: left; cursor: pointer; }
    .tc-item:hover:not(:disabled) { background: rgba(255,255,255,0.12); }
    .tc-item:disabled { opacity: 0.5; cursor: default; }
    .tc-item .tc-label { flex: 1; }
    .tc-item .tc-val { color: #9da3b4; }
    .tc-item .tc-check { width: 14px; visibility: hidden; color: var(--primary-accent); font-weight: 800; }
    .tc-item.active .tc-check { visibility: visible; }
    .tc-item.tc-head { border-bottom: 1px solid var(--border-main); border-radius: 6px 6px 0 0; margin-bottom: 0.2rem; font-weight: 700; }
    .trim-preview:fullscreen { border: 0; border-radius: 0; aspect-ratio: auto; }
    .trim-preview:fullscreen .trim-controls { padding: 3rem 1.4rem 0.8rem; }
    .trim-preview:fullscreen .tc-menu { max-height: 50vh; }
    .trim-preview:fullscreen .tc-time { font-size: 0.85rem; }
    .tc-fs-exit, .trim-controls.is-fs .tc-fs-enter { display: none; }
    .trim-controls.is-fs .tc-fs-exit { display: block; }

    /* the chosen quality is marked with a dot */
    .tc-item .tc-dot { position: relative; flex: none; width: 14px; height: 14px; }
    .tc-item.active .tc-dot::after { content: ""; position: absolute; left: 50%; top: 50%; width: 7px; height: 7px;
      margin: -3.5px 0 0 -3.5px; border-radius: 50%; background: var(--primary-accent); }

    /* keyboard focus lands on the player itself: no ring around the picture */
    .trim-preview:focus { outline: none; }

    /* the last picture stays on screen while a new quality opens */
    .trim-swap { position: absolute; inset: 0; z-index: 1; display: none; width: 100%; height: 100%; object-fit: contain;
      background: #000; pointer-events: none; }
    .trim-swap.show { display: block; }

    /* YouTube-style play / pause badge: only for a click on the picture */
    .trim-badge { position: absolute; left: 50%; top: 50%; z-index: 2; width: 58px; height: 58px; margin: -29px 0 0 -29px;
      display: flex; align-items: center; justify-content: center; border-radius: 50%; background: rgba(0, 0, 0, 0.6);
      color: #fff; opacity: 0; pointer-events: none; }
    .trim-badge svg { display: block; }
    .trim-badge[data-icon="play"] .tb-pause, .trim-badge[data-icon="pause"] .tb-play { display: none; }
    .trim-badge.pop { animation: trimBadgePop 0.6s ease-out; }
    @keyframes trimBadgePop {
      0% { opacity: 0; transform: scale(0.6); }
      18% { opacity: 1; transform: scale(1); }
      100% { opacity: 0; transform: scale(1.45); }
    }
    .trim-preview.badge-on .trim-play-btn { opacity: 0 !important; }
    /* with the real video showing, the click-on-picture badge replaces the big orange play button */
    .trim-preview.has-video .trim-play-btn { display: none !important; }

    /* skip indicators: "< -10" on the left, "+10 >" on the right */
    .trim-seek-ind { position: absolute; top: 50%; z-index: 2; display: flex; align-items: center; gap: 0.2rem;
      padding: 0.5rem 0.95rem; border-radius: 999px; background: rgba(0, 0, 0, 0.6); color: #fff; font-size: 0.9rem;
      font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; opacity: 0; pointer-events: none;
      transform: translateY(-50%) scale(0.92); transition: opacity 0.18s ease, transform 0.18s ease; }
    .trim-seek-ind.left { left: 12%; }
    .trim-seek-ind.right { right: 12%; }
    .trim-seek-ind.show { opacity: 1; transform: translateY(-50%) scale(1); }
    .trim-seek-ind.bump { animation: trimSeekBump 0.2s ease-out; }
    .trim-seek-ind svg { display: block; }
    @keyframes trimSeekBump {
      0% { transform: translateY(-50%) scale(1.14); }
      100% { transform: translateY(-50%) scale(1); }
    }
    @media (prefers-reduced-motion: reduce) {
      .trim-badge.pop { animation-duration: 0.01s; }
      .trim-seek-ind, .trim-seek-ind.bump { transition: none; animation: none; }
    }
  `;
  document.head.appendChild(style);

  const ICON = (path, size = 18) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="${path}"/></svg>`;
  const CHEVRON = (dir) =>
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="${dir === "back" ? "m15 6-6 6 6 6" : "m9 6 6 6-6 6"}"/></svg>`;

  const bar = document.createElement("div");
  bar.className = "trim-controls";
  bar.innerHTML = `
    <div class="tc-seek" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0">
      <div class="tc-seek-track">
        <div class="tc-seek-range"></div>
        <div class="tc-seek-fill"></div>
        <div class="tc-seek-thumb"></div>
      </div>
      <div class="tc-seek-tip">00:00</div>
    </div>
    <div class="tc-row">
      <button type="button" class="tc-btn" data-act="play" aria-label="Play or pause (space)">
        <span class="tc-play">${ICON("M8 5v14l11-7z", 20)}</span>
        <span class="tc-pause">${ICON("M7 5h4v14H7zM13 5h4v14h-4z", 20)}</span>
      </button>
      <div class="tc-vol">
        <button type="button" class="tc-btn" data-act="mute" aria-label="Mute or unmute (m)">
          <span class="tc-on-sound">${ICON("M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z")}</span>
          <span class="tc-on-muted">${ICON("M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z")}</span>
        </button>
        <input class="tc-vol-range" type="range" min="0" max="1" step="0.02" value="1" aria-label="Volume" />
      </div>
      <span class="tc-time">00:00 / 00:00</span>
      <span class="tc-spacer"></span>
      <div class="tc-settings">
        <button type="button" class="tc-btn" data-act="settings" aria-haspopup="true" aria-label="Settings">
          <span class="tc-gear">${ICON("M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.5.5 0 0 0-.59.22L2.74 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.26.42.5.42h3.84c.24 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z")}</span>
        </button>
        <div class="tc-menu" role="menu">
          <div class="tc-panel" data-panel="main">
            <button type="button" class="tc-item" data-open="speed"><span class="tc-label">Playback speed</span><span class="tc-val" data-val="speed">Normal</span>${CHEVRON("next")}</button>
            <button type="button" class="tc-item" data-open="quality"><span class="tc-label">Quality</span><span class="tc-val" data-val="quality">Auto</span>${CHEVRON("next")}</button>
          </div>
          <div class="tc-panel tc-hidden" data-panel="speed">
            <button type="button" class="tc-item tc-head" data-open="main">${CHEVRON("back")}<span class="tc-label">Playback speed</span></button>
            ${TRIM_RATES.map((r) => `<button type="button" class="tc-item" data-rate="${r}"><span class="tc-check">✓</span><span class="tc-label">${r === 1 ? "Normal" : r}</span></button>`).join("")}
          </div>
          <div class="tc-panel tc-hidden" data-panel="quality">
            <button type="button" class="tc-item tc-head" data-open="main">${CHEVRON("back")}<span class="tc-label">Quality</span></button>
            <div class="tc-q-list"></div>
          </div>
        </div>
      </div>
      <button type="button" class="tc-btn" data-act="fullscreen" aria-label="Fullscreen (f)">
        <span class="tc-fs-enter">${ICON("M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z", 20)}</span>
        <span class="tc-fs-exit">${ICON("M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z", 20)}</span>
      </button>
    </div>
  `;
  trimPreview.appendChild(bar);

  // A still of the current picture: it covers the player for the instant a new quality opens
  const swap = document.createElement("canvas");
  swap.className = "trim-swap";
  trimPreview.insertBefore(swap, bar);
  function snapshot() {
    try {
      if (!trimVideo.videoWidth) return;
      swap.width = trimVideo.videoWidth;
      swap.height = trimVideo.videoHeight;
      swap.getContext("2d").drawImage(trimVideo, 0, 0);
      swap.classList.add("show");
    } catch {}
  }
  const hideSnapshot = () => swap.classList.remove("show");
  const hasSnapshot = () => swap.classList.contains("show");

  const seek = bar.querySelector(".tc-seek");
  const seekFill = bar.querySelector(".tc-seek-fill");
  const seekThumb = bar.querySelector(".tc-seek-thumb");
  const seekRange = bar.querySelector(".tc-seek-range");
  const seekTip = bar.querySelector(".tc-seek-tip");
  const range = bar.querySelector(".tc-vol-range");
  const timeEl = bar.querySelector(".tc-time");
  const settings = bar.querySelector(".tc-settings");
  const qList = bar.querySelector(".tc-q-list");

  /* ---- volume & speed ---- */
  function apply() {
    trimVideo.volume = state.volume;
    trimVideo.muted = state.muted;
    // A new source resets the speed to the default one, so set both
    trimVideo.defaultPlaybackRate = state.rate;
    trimVideo.playbackRate = state.rate;
    range.value = state.muted ? 0 : state.volume;
    range.style.setProperty("--v", `${Number(range.value) * 100}%`);
    bar.classList.toggle("is-muted", state.muted || state.volume === 0);
    refreshMenu();
  }

  function toggleMute() {
    state.muted = !state.muted;
    if (!state.muted && state.volume === 0) state.volume = 0.5;
    apply();
  }

  /* ---- settings menu ---- */
  const menuOpen = () => settings.classList.contains("open");

  function showPanel(name) {
    bar
      .querySelectorAll(".tc-panel")
      .forEach((p) =>
        p.classList.toggle("tc-hidden", p.dataset.panel !== name),
      );
    if (name === "quality") {
      buildQualityList();
      // the current choice (often "Auto", at the bottom) must be in view
      requestAnimationFrame(() =>
        qList.querySelector(".active")?.scrollIntoView({ block: "nearest" }),
      );
    }
  }

  function openMenu() {
    settings.classList.add("open");
    showPanel("main");
  }

  function closeMenu() {
    settings.classList.remove("open");
  }

  function qualityText() {
    if (qualityNote) return qualityNote;
    return trimVid.quality ? `${trimVid.quality}p` : "Auto";
  }

  function refreshMenu() {
    bar.querySelector('[data-val="speed"]').textContent =
      state.rate === 1 ? "Normal" : `${state.rate}x`;
    bar.querySelector('[data-val="quality"]').textContent = qualityText();
    bar
      .querySelectorAll("[data-rate]")
      .forEach((b) =>
        b.classList.toggle("active", Number(b.dataset.rate) === state.rate),
      );
  }

  /** Heights up to what the video really has, highest first, then Auto (like YouTube). */
  function buildQualityList() {
    // the stream knows the real qualities at once; the full analysis may still be running
    const max = trimVid.heights?.length
      ? Math.max(...trimVid.heights)
      : Number(appState.info?.maxHeight) || 0;
    const heights = TRIM_QUALITIES.filter((h) => !max || h <= max);
    const items = [...heights, 0];
    qList.innerHTML = items
      .map(
        (h) =>
          `<button type="button" class="tc-item${trimVid.quality === h ? " active" : ""}" data-quality="${h}"${trimVid.switching ? " disabled" : ""}><span class="tc-dot"></span><span class="tc-label">${h ? h + "p" : "Auto"}</span></button>`,
      )
      .join("");
  }

  /**
   * A new quality is a new small copy of the video (made by yt-dlp like the first one).
   * The current copy keeps playing while the new one is prepared; the swap then carries on
   * from the same moment, with the last picture held on screen. The trim range, the
   * playhead and the volume / speed are untouched.
   */
  function setQuality(height, byUser = false) {
    closeMenu();
    if (trimVid.switching || height === trimVid.quality) return;
    const url = appState.url;
    if (!url || !window.api?.preparePreview) return;
    const key = trimVid.key;
    if (byUser) trimVid.picked = true;
    if (trimVid.stream) {
      // streaming: show the loading sign and fetch the new quality's first seconds at once
      trimVid.quality = height;
      refreshMenu();
      trimStream.setHeight(height);
      return;
    }
    setSpin(true);
    trimVid.switching = true;
    trimVid.switchTo = height;
    trimVid.percent = 0;
    qualityNote = "";
    refreshMenu();

    const failed = () => {
      setSpin(false);
      trimVid.switching = false;
      trimVid.switchTo = 0;
      trimVid.percent = 0;
      trimVid.refused = height;
      qualityNote = height ? `${height}p unavailable` : "Unavailable";
      setTimeout(() => {
        qualityNote = "";
        refreshMenu();
      }, 4000);
      refreshMenu(); // the current copy simply carries on
    };

    window.api
      .preparePreview(url, {
        proxyUrl: readStr("prefProxyUrl", ""),
        extraArgs: readStr("prefYtdlpArgs", ""),
        duration: duration(),
        height,
        head: false, // the picture keeps playing meanwhile, so the whole copy is what's needed
      })
      .then((res) => {
        if (trimVid.key !== key) return; // the link changed meanwhile
        if (!res || !res.id) return failed();
        trimVid.switching = false;
        trimVid.switchTo = 0;
        trimVid.percent = 0;
        trimVid.partial = false; // this copy is the whole video
        trimVid.waiting = false;
        updateWait();
        const resume = trimPlay.playing;
        const at = trimPlay.t;
        snapshot();
        stopTrimPlay();
        trimPlay.t = at;
        trimVid.quality = height;
        trimVid.resumePlay = resume;
        trimVid.src = `mbpreview://${res.id}/v`;
        apply(); // volume and speed survive a new source
        trimVideo.src = trimVid.src;
        trimVideo.load();
        refreshMenu();
      })
      .catch(() => {
        if (trimVid.key === key) failed();
      });
  }

  /* ---- show / hide ---- */
  function activate() {
    clearTimeout(leaveTimer);
    trimPreview.classList.add("ctl-active");
    trimPreview.classList.remove("ctl-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // While playing, the bar fades when the pointer rests on the picture
      if (
        trimPlay.playing &&
        !scrubbing &&
        !menuOpen() &&
        !bar.matches(":hover")
      ) {
        trimPreview.classList.remove("ctl-active");
        trimPreview.classList.add("ctl-idle");
      }
    }, 2500);
  }

  function deactivate() {
    clearTimeout(idleTimer);
    if (scrubbing) return;
    trimPreview.classList.remove("ctl-active", "ctl-idle");
    closeMenu();
  }

  trimPreview.addEventListener("pointerenter", activate);
  trimPreview.addEventListener("pointermove", activate);
  trimPreview.addEventListener("pointerleave", () => {
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(deactivate, 120);
  });

  /* ---- seek bar ---- */
  const timeAt = (clientX) => {
    const r = seek.getBoundingClientRect();
    return clamp((clientX - r.left) / Math.max(r.width, 1), 0, 1) * duration();
  };

  function placeTip(clientX) {
    const r = seek.getBoundingClientRect();
    const x = clamp(clientX - r.left, 0, r.width);
    seekTip.style.left = `${clamp(x, 22, Math.max(22, r.width - 22))}px`;
    seekTip.textContent = formatClock(Math.round(timeAt(clientX)));
  }

  seek.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !duration()) return;
    e.preventDefault();
    seek.focus({ preventScroll: true }); // arrow keys now skip from here
    seek.setPointerCapture(e.pointerId);
    scrubbing = true;
    seek.classList.add("scrubbing");
    placeTip(e.clientX);
    setPlayhead(timeAt(e.clientX));
  });
  seek.addEventListener("pointermove", (e) => {
    placeTip(e.clientX);
    if (scrubbing) setPlayhead(timeAt(e.clientX));
  });
  const endScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    seek.classList.remove("scrubbing");
    try {
      seek.releasePointerCapture(e.pointerId);
    } catch {}
  };
  seek.addEventListener("pointerup", endScrub);
  seek.addEventListener("pointercancel", endScrub);
  /* ---- fullscreen ---- */
  function toggleFullscreen() {
    if (document.fullscreenElement === trimPreview) {
      document.exitFullscreen().catch(() => {});
    } else if (trimPreview.requestFullscreen) {
      trimPreview.requestFullscreen().catch(() => {});
    }
  }
  document.addEventListener("fullscreenchange", () => {
    bar.classList.toggle("is-fs", document.fullscreenElement === trimPreview);
  });

  /* ---- clicks on the bar (they must not play / pause the video underneath) ---- */
  bar.addEventListener("click", (e) => {
    e.stopPropagation();
    activate();
    const quality = e.target.closest("[data-quality]");
    if (quality) return setQuality(Number(quality.dataset.quality), true);
    const rate = e.target.closest("[data-rate]");
    if (rate) {
      state.rate = Number(rate.dataset.rate);
      apply();
      return closeMenu();
    }
    const open = e.target.closest("[data-open]");
    if (open) return showPanel(open.dataset.open);
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "play") toggleTrimPlay();
    else if (act === "mute") toggleMute();
    else if (act === "fullscreen") toggleFullscreen();
    else if (act === "settings") menuOpen() ? closeMenu() : openMenu();
  });
  bar.addEventListener("dblclick", (e) => e.stopPropagation());
  range.addEventListener("input", () => {
    state.volume = Number(range.value);
    state.muted = state.volume === 0;
    apply();
  });

  apply();
  return {
    get rate() {
      return state.rate;
    },
    get scrubbing() {
      return scrubbing;
    },
    apply,
    activate,
    menuOpen,
    closeMenu,
    toggleMute,
    toggleFullscreen,
    setQuality,
    hideSnapshot,
    hasSnapshot,
    snapshot,
    refreshMenu,
    setTime: (text) => {
      timeEl.textContent = text;
    },
    /** t = playhead, d = video length, [from, to] = the clip being cut */
    setProgress: (t, d, from, to) => {
      const pct = (n) => `${clamp((n / d) * 100, 0, 100)}%`;
      seekFill.style.width = pct(t);
      seekThumb.style.left = pct(t);
      seekRange.style.display = from <= 0 && to >= d ? "none" : "block";
      seekRange.style.left = pct(from);
      seekRange.style.width = `${clamp(((to - from) / d) * 100, 0, 100)}%`;
      seek.setAttribute("aria-valuemax", String(Math.round(d)));
      seek.setAttribute("aria-valuenow", String(Math.round(t)));
    },
  };
})();

/* ############################################################################
 # SECTION: player-video
 # The preview video itself: streaming, file preview and seeking.
 ############################################################################ */

/* ---- the video ----
 * yt-dlp downloads a tiny copy of the video (240p, a few MB) into the temp folder, and the
 * player plays it from there (main.js, "LOCAL PREVIEW FILE"). It's started the moment the
 * mouse reaches the scissors button, so it is usually ready by the time the popover opens.
 */
/* The "loading the rest" pill: shown only when a moment that isn't loaded yet was asked for. */
const trimWaitStyle = document.createElement("style");
trimWaitStyle.textContent = `
  .trim-wait { position: absolute; left: 0.6rem; top: 0.6rem; z-index: 4; display: none; align-items: center; gap: 0.4rem;
    padding: 0.25rem 0.6rem; border-radius: 999px; background: rgba(0,0,0,0.7); color: #fff; font-size: 0.7rem; font-weight: 600; pointer-events: none; }
  .trim-wait.show { display: flex; }
  .trim-wait::before { content: ""; width: 10px; height: 10px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.35);
    border-top-color: #fff; animation: trimWaitSpin 0.8s linear infinite; }
  @keyframes trimWaitSpin { to { transform: rotate(360deg); } }
  .trim-preview.poster-on .trim-video { opacity: 0 !important; }
`;
document.head.appendChild(trimWaitStyle);
const trimWaitPill = document.createElement("div");
trimWaitPill.className = "trim-wait";
trimWaitPill.setAttribute("aria-live", "polite");
trimPreview.appendChild(trimWaitPill);

/* The loading sign: a spinner over the picture, like any online player. */
const trimSpinStyle = document.createElement("style");
trimSpinStyle.textContent = `
  .trim-spin { position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
    border: 4px solid rgba(255,255,255,0.28); border-top-color: #fff; z-index: 4; display: none; pointer-events: none;
    filter: drop-shadow(0 1px 4px rgba(0,0,0,0.6)); animation: trimWaitSpin 0.8s linear infinite; }
  .trim-spin.show { display: block; }
  .trim-preview.spinning .trim-play-btn { opacity: 0 !important; }
`;
document.head.appendChild(trimSpinStyle);
const trimSpin = document.createElement("div");
trimSpin.className = "trim-spin";
trimSpin.setAttribute("aria-hidden", "true");
trimPreview.appendChild(trimSpin);
let spinTimer = 0;
function setSpin(on) {
  if (!on) {
    clearTimeout(spinTimer);
    spinTimer = 0;
    if (typeof hideSeekPoster === "function") hideSeekPoster();
  }
  trimSpin.classList.toggle("show", !!on);
  trimPreview.classList.toggle("spinning", !!on);
}
/** Shows the loading sign only if the wait lasts: a quick catch-up never flashes it. */
function spinSoon(ms) {
  if (spinTimer || trimSpin.classList.contains("show")) return;
  spinTimer = setTimeout(() => {
    spinTimer = 0;
    setSpin(true);
  }, ms);
}
function cancelSpinSoon() {
  clearTimeout(spinTimer);
  spinTimer = 0;
}

function updateWait() {
  setSpin(trimVid.waiting); // (the file fallback) a moment that isn't loaded yet
}

/* ---- streaming player ----
 * The video is played piece by piece through a MediaSource: a few seconds to start, then a
 * bigger piece whenever the buffer runs low. A jump to a moment that isn't loaded, or a new
 * quality, shows the loading sign and fetches the pieces from that point on, so playing
 * starts as soon as the first few seconds are there (main.js, "STREAMING PREVIEW").
 */
/* ---- filmstrip pictures from the stream: always the same 24 slices of the video ---- */
const TILE_GRID = 24;
const trimTiles = { els: [], data: [] };
/** Each slice of the strip shows the nearest picture that has arrived: it fills at once, then sharpens. */
function refreshTileImages() {
  const n = trimTiles.els.length;
  for (let i = 0; i < n; i++) {
    const ideal = clamp(
      Math.round(((i + 0.5) / n) * TILE_GRID - 0.5),
      0,
      TILE_GRID - 1,
    );
    let pick = -1;
    for (let k = 0; k < TILE_GRID && pick < 0; k++) {
      if (trimTiles.data[ideal + k]) pick = ideal + k;
      else if (ideal - k >= 0 && trimTiles.data[ideal - k]) pick = ideal - k;
    }
    const el = trimTiles.els[i];
    if (pick < 0 || el.dataset.pic === String(pick)) continue;
    el.dataset.pic = String(pick);
    el.style.backgroundImage = `url(data:image/jpeg;base64,${trimTiles.data[pick]})`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
  }
}
window.api?.onStreamTile?.((ev) => {
  if (!ev || ev.id !== trimStream.sessionId) return;
  if (ev.failed) {
    // no pictures from the stream: the strip is drawn from a small copy instead
    trimVid.tilesFailed = true;
    trimFilm.stripKey = "";
    if (!trimVid.capReq) {
      trimVid.capReq = true;
      requestFilmCopy();
    }
    if (trimDialogOpen()) updateTrimUI();
    return;
  }
  if (ev.count !== TILE_GRID) return;
  trimTiles.data[ev.index] = ev.data;
  refreshTileImages();
});

/* A jump shows the nearest filmstrip picture at once (blurred), until the video is there. */
const trimSeekStyle = document.createElement("style");
trimSeekStyle.textContent = `
  .trim-seekposter { position: absolute; inset: 0; z-index: 2; display: none; pointer-events: none;
    background-size: cover; background-position: center; filter: blur(3px) brightness(0.85); }
  .trim-seekposter.show { display: block; }
`;
document.head.appendChild(trimSeekStyle);
const trimSeekPoster = document.createElement("div");
trimSeekPoster.className = "trim-seekposter";
trimPreview.appendChild(trimSeekPoster);
function showSeekPoster(t) {
  if (!duration()) return;
  const ideal = clamp(
    Math.floor((t / duration()) * TILE_GRID),
    0,
    TILE_GRID - 1,
  );
  for (let k = 0; k < TILE_GRID; k++) {
    const data =
      trimTiles.data[ideal + k] ||
      (ideal - k >= 0 ? trimTiles.data[ideal - k] : null);
    if (!data) continue;
    trimSeekPoster.style.backgroundImage = `url(data:image/jpeg;base64,${data})`;
    trimSeekPoster.classList.add("show");
    return;
  }
}
const hideSeekPoster = () => trimSeekPoster.classList.remove("show");

const trimStream = (() => {
  let FIRST = 3; // seconds fetched to start, after a jump, and after a quality change
  const AHEAD_LONG = 900; // (videos over 30 min) how far ahead to load; shorter ones load all of it
  const chunkLen = (h) => (h >= 1080 ? 8 : h >= 720 ? 12 : 20);
  let S = null;
  let reqCounter = 0;

  const autoHeight = () => (duration() > 1200 ? 144 : 240);

  function covering(t) {
    if (!S || !S.sb) return null;
    let b;
    try {
      b = S.sb.buffered;
    } catch {
      return null;
    }
    for (let i = 0; i < b.length; i++)
      if (t >= b.start(i) - 0.1 && t < b.end(i) - 0.05)
        return { start: b.start(i), end: b.end(i) };
    return null;
  }

  const idle = () =>
    new Promise((resolve) => {
      if (!S || !S.sb.updating) return resolve();
      S.sb.addEventListener("updateend", () => resolve(), { once: true });
    });

  async function removeRange(from, to) {
    await idle();
    if (!S) return;
    const sb = S.sb;
    await new Promise((resolve) => {
      sb.addEventListener("updateend", resolve, { once: true });
      try {
        sb.remove(from, to);
      } catch {
        resolve();
      }
    });
  }

  async function append(data, start, len) {
    await idle();
    const sb = S.sb;
    const run = () =>
      new Promise((resolve, reject) => {
        const cleanup = () => {
          sb.removeEventListener("updateend", ok);
          sb.removeEventListener("error", bad);
        };
        const ok = () => {
          cleanup();
          resolve();
        };
        const bad = () => {
          cleanup();
          reject(new Error("append failed"));
        };
        sb.addEventListener("updateend", ok);
        sb.addEventListener("error", bad);
        try {
          // each piece is placed at its own moment; its edges are trimmed to its slot
          sb.appendWindowEnd = Infinity;
          sb.appendWindowStart = Math.max(0, start - 0.001);
          sb.appendWindowEnd = start + len + 0.001;
          sb.timestampOffset = start;
          sb.appendBuffer(data);
        } catch (err) {
          cleanup();
          reject(err);
        }
      });
    try {
      await run();
    } catch (err) {
      if (err && err.name === "QuotaExceededError") {
        S.limited = true; // the browser's buffer is full: stop loading everything
        // the browser's buffer is full: drop what was played a while ago
        await removeRange(0, Math.max(0, trimVideo.currentTime - 10));
        await run();
      } else throw err;
    }
  }

  const wantTime = () => (S.jump != null ? S.jump : trimVideo.currentTime || 0);

  function finish() {
    if (S.ms.readyState === "open" && !S.sb.updating) {
      try {
        S.ms.endOfStream();
      } catch {}
    }
  }

  function abortCurrent() {
    if (S.req && window.api?.cancelStreamChunk)
      window.api.cancelStreamChunk(S.req.id);
    S.seq++;
    S.busy = false;
    S.req = null;
    clearTimeout(S.retry);
  }

  function bufferedRanges() {
    const out = [];
    let b;
    try {
      b = S.sb.buffered;
    } catch {
      return out;
    }
    for (let i = 0; i < b.length; i++)
      out.push({ start: b.start(i), end: b.end(i) });
    return out;
  }

  const tooManyTries = (at) => (S.tries.get(at.toFixed(1)) || 0) >= 4;

  /**
   * What to fetch next, in this order: the playhead's own moment (if it isn't loaded), then
   * on ahead without stopping, then any stretch that a jump skipped. So once the preview
   * plays, the video keeps downloading little by little, whether it is playing or paused.
   */
  function nextNeeded(t) {
    const ranges = bufferedRanges();
    const cur = ranges.findIndex((r) => t >= r.start - 0.1 && t < r.end - 0.05);
    const len = chunkLen(S.height);
    if (cur < 0)
      return { start: Math.floor(t * 2) / 2, len: FIRST, urgent: true };

    let end = ranges[cur].end;
    let i = cur + 1;
    while (i < ranges.length && ranges[i].start - end < 1)
      end = Math.max(end, ranges[i++].end);
    const limit = S.duration > 1800 ? t + AHEAD_LONG : Infinity;
    if (end < S.duration - 0.1 && end < limit) {
      const stop = i < ranges.length ? ranges[i].start : S.duration;
      const piece = Math.min(len, stop - end); // never into what is already there
      if (piece >= 1 && !tooManyTries(end)) return { start: end, len: piece };
    }
    if (S.duration <= 1800 && !S.limited) {
      let cursor = 0;
      for (const r of ranges) {
        const hole = Math.min(len, r.start - cursor);
        if (r.start - cursor > 1 && !tooManyTries(cursor))
          return { start: cursor, len: hole };
        cursor = Math.max(cursor, r.end);
      }
    }
    return null;
  }

  function pump() {
    if (!S || S.closed || !S.sb || S.busy) return;
    let start;
    let len;
    let flush = false;
    let urgent = false;
    if (S.force != null) {
      // a new quality: its first seconds from the playhead, replacing the old quality ahead
      start = S.force;
      len = FIRST;
      flush = true;
      urgent = true;
      S.force = null;
    } else {
      const need = nextNeeded(wantTime());
      // before the trim window is opened only the first seconds are prepared; the rest of the
      // video keeps downloading once the scissors have been clicked
      if (need && !need.urgent && !trimDialogOpen()) return;
      if (!need) {
        const all = bufferedRanges();
        if (
          all.length === 1 &&
          all[0].start < 1 &&
          all[0].end >= S.duration - 0.1
        )
          finish();
        return;
      }
      ({ start, len, urgent } = need);
    }
    if (start >= S.duration - 0.05) return finish();
    load(start, Math.min(len, S.duration - start), flush, !!urgent);
  }

  async function load(start, len, flush, urgent) {
    if (!urgent)
      S.tries.set(start.toFixed(1), (S.tries.get(start.toFixed(1)) || 0) + 1);
    const mine = ++S.seq;
    const req = ++reqCounter;
    S.busy = true;
    S.req = { id: req, start, len };
    let ok = false;
    try {
      const data = await window.api.streamChunk(S.id, {
        height: S.height,
        start,
        dur: len,
        req,
      });
      if (!S || S.closed || S.seq !== mine) return;
      if (!data || !data.byteLength)
        throw new Error((data && data.error) || "empty piece");
      if (flush) await removeRange(start, Infinity);
      if (!S || S.closed || S.seq !== mine) return;
      await append(data, start, len);
      S.errors = 0;
      ok = true;
      afterAppend();
    } catch (err) {
      if (!S || S.closed || S.seq !== mine) return;
      if (++S.errors >= 3) {
        fail(String((err && err.message) || err));
        return;
      }
      S.retry = setTimeout(pump, 500 * S.errors);
    } finally {
      if (S && S.seq === mine) {
        S.busy = false;
        S.req = null;
      }
    }
    if (ok && S && !S.closed && S.seq === mine) pump();
  }

  function afterAppend() {
    if (S.jump != null) {
      const target = S.jump;
      S.jump = null;
      if (!covering(trimVideo.currentTime)) {
        try {
          trimVideo.currentTime = target;
        } catch {}
      }
    }
    if (S.resumeAfter && covering(trimVideo.currentTime)) {
      S.resumeAfter = false;
      const p = trimVideo.play();
      if (p && p.catch) p.catch(() => {});
    }
    if (covering(trimVideo.currentTime)) setSpin(false);
  }

  function fail(reason) {
    console.warn("Streaming preview stopped:", reason);
    const cb = S && S.onFail;
    close();
    if (cb) cb(reason);
  }

  async function open(url, key, height, onFail) {
    if (
      !window.api?.streamOpen ||
      !window.api?.streamChunk ||
      typeof MediaSource === "undefined"
    )
      return false;
    let res;
    try {
      res = await window.api.streamOpen(url, {});
    } catch {
      return false;
    }
    if (!res || !res.id) return false;
    if (
      trimVid.key !== key ||
      !res.mime ||
      !MediaSource.isTypeSupported(res.mime)
    ) {
      window.api.closeStream?.(res.id);
      return false;
    }
    close(); // (a session of an earlier link)
    const ms = new MediaSource();
    const objUrl = URL.createObjectURL(ms);
    if (res.first) FIRST = res.first;
    S = {
      id: res.id,
      duration: res.duration,
      mime: res.mime,
      ms,
      sb: null,
      objUrl,
      height: res.startHeight || height, // the main process knows which qualities exist
      seq: 0,
      busy: false,
      req: null,
      errors: 0,
      jump: trimPlay.t || 0,
      force: null,
      closed: false,
      retry: 0,
      resumeAfter: false,
      tries: new Map(), // how often a background stretch was tried
      limited: false, // the browser's buffer filled up
      onFail,
    };
    trimVid.heights = res.heights || null;
    trimVid.stream = true;
    trimTiles.data = []; // (a new video: new filmstrip pictures)
    trimTiles.els = [];
    const opened = new Promise((resolve) =>
      ms.addEventListener("sourceopen", resolve, { once: true }),
    );
    trimVid.src = objUrl;
    trimVideo.src = objUrl;
    trimVideo.load();
    await opened;
    if (!S || S.ms !== ms) return false; // closed meanwhile
    try {
      ms.duration = S.duration;
      S.sb = ms.addSourceBuffer(S.mime);
      S.sb.mode = "segments";
    } catch (err) {
      const cb = onFail;
      close();
      cb && cb(String(err));
      return true; // the fallback is already on its way
    }
    spinSoon(500); // (the popover already says it is loading)
    pump();
    return true;
  }

  function close() {
    if (!S) return;
    const s = S;
    S = null;
    s.closed = true;
    clearTimeout(s.retry);
    if (s.req) window.api?.cancelStreamChunk?.(s.req.id);
    window.api?.closeStream?.(s.id);
    setSpin(false);
    try {
      URL.revokeObjectURL(s.objUrl);
    } catch {}
    trimVid.stream = false;
  }

  /** A new quality (0 = automatic): stop, show the loading sign, fetch from the playhead. */
  function setHeight(h) {
    if (!S) return false;
    const eff = h || autoHeight();
    if (eff === S.height) return true;
    S.height = eff;
    abortCurrent();
    S.resumeAfter = !trimVideo.paused;
    if (S.resumeAfter) trimVideo.pause(); // it carries on once the new quality is there
    S.force = trimVideo.currentTime;
    S.jump = null;
    setSpin(true);
    pump();
    return true;
  }

  // a jump: to a moment that is loaded nothing shows; otherwise the nearest filmstrip picture
  // appears at once, the loading sign follows if it lasts, and the pieces come from there
  trimVideo.addEventListener("seeking", () => {
    if (!S || !S.sb) return;
    const t = trimVideo.currentTime;
    if (covering(t)) {
      cancelSpinSoon();
      pump();
      return;
    }
    showSeekPoster(t);
    spinSoon(180);
    if (S.req && t >= S.req.start - 0.1 && t < S.req.start + S.req.len) {
      S.jump = null; // the piece on its way covers it
      return;
    }
    abortCurrent();
    S.jump = t;
    pump();
  });
  trimVideo.addEventListener("waiting", () => {
    if (!S || !S.sb) return;
    if (covering(trimVideo.currentTime)) return; // only catching up: nothing is loading
    spinSoon(200);
    pump();
  });
  const settled = () => {
    if (
      S &&
      S.sb &&
      covering(trimVideo.currentTime) &&
      S.force == null &&
      !(S.busy && S.resumeAfter)
    )
      setSpin(false);
  };
  trimVideo.addEventListener("playing", settled);
  trimVideo.addEventListener("canplay", settled);
  trimVideo.addEventListener("seeked", settled);
  trimVideo.addEventListener("timeupdate", () => {
    if (S && S.sb) pump();
  });

  return {
    open,
    close,
    setHeight,
    fail: (reason) => S && fail(reason),
    resume: () => {
      if (S && S.sb) pump();
    },
    get active() {
      return !!S;
    },
    get sessionId() {
      return S ? S.id : "";
    },
    get height() {
      return S ? S.height : 0;
    },
  };
})();

/** The stream couldn't go on: carry on with the file copy (the old way). */
function fallbackToFile(key) {
  if (trimVid.key !== key) return;
  trimStream.close();
  trimVid.stream = false;
  trimVid.heights = null;
  trimVid.src = "";
  trimVid.state = "loading";
  trimVideo.removeAttribute("src");
  trimVideo.load();
  setSpin(false);
  startFilePreview(appState.url, key);
}

/** A small whole copy, only to draw the filmstrip; it never holds up the player. */
function requestFilmCopy() {
  const key = trimVid.key;
  const url = appState.url;
  if (!trimVid.stream || trimVid.capSrc || !url || !window.api?.preparePreview)
    return;
  window.api
    .preparePreview(url, {
      proxyUrl: readStr("prefProxyUrl", ""),
      extraArgs: readStr("prefYtdlpArgs", ""),
      duration: duration(),
      height: 240,
      head: false,
    })
    .then((res) => {
      if (trimVid.key !== key || !res || !res.id) return;
      trimVid.capSrc = `mbpreview://${res.id}/v`;
      trimFilm.stripKey = "";
      if (trimDialogOpen()) updateTrimUI();
    })
    .catch(() => {});
}

function resetVideo() {
  // the copies being made for the old link are no longer wanted
  if (trimVid.key && window.api?.cancelPreview)
    window.api.cancelPreview(trimVid.key);
  trimStream.close();
  stopTrimPlay();
  trimVid.src = "";
  trimVid.heights = null;
  trimVid.capSrc = "";
  trimVid.capReq = false;
  trimVid.tilesFailed = false;
  trimVid.state = "idle";
  trimVid.key = "";
  trimVid.reason = "";
  trimVid.quality = 0;
  trimVid.switching = false;
  trimVid.resumePlay = false;
  trimVid.picked = false;
  trimVid.refused = 0;
  trimVid.partial = false;
  trimVid.headSeconds = 0;
  trimVid.waiting = false;
  trimVid.wantAt = 0;
  trimVid.percent = 0;
  trimVid.switchTo = 0;
  trimVid.poster = false;
  updateWait();
  trimCtl.hideSnapshot();
  trimVideo.removeAttribute("src");
  trimVideo.load();
}

function failVideo(reason) {
  trimVid.state = "failed";
  trimVid.reason = reason;
  trimFilm.stripKey = "";
  if (trimDialogOpen()) updateTrimUI();
}

/**
 * The quality the preview opens at: the one selected for the download (the nearest the
 * player offers that is not above it). Audio downloads have no picture quality: Auto.
 */
function defaultPreviewHeight() {
  if (isAudioFormat(appState.selectedFormat)) return 0;
  const want = parseInt(appState.selectedQuality, 10) || 0;
  if (!want) return 0;
  const max = Number(appState.info?.maxHeight) || 0;
  const options = TRIM_QUALITIES.filter((h) => !max || h <= max); // highest first
  if (!options.length) return 0;
  return options.find((h) => h <= want) || options[options.length - 1];
}

/** The download quality changed since the preview was made (and nobody picked one): follow it. */
function adoptDownloadQuality() {
  if (
    trimVid.stream ||
    trimVid.picked ||
    trimVid.switching ||
    trimVid.state !== "ready"
  )
    return;
  const want = defaultPreviewHeight();
  if (want && want !== trimVid.quality && want !== trimVid.refused)
    trimCtl.setQuality(want);
}

function ensureVideo() {
  if (trimVid.stream && trimDialogOpen()) trimStream.resume(); // the window just opened: keep downloading
  const url = appState.url;
  if (!url) return;
  if (trimVid.key !== url) {
    resetVideo(); // a different link: start over
    trimVid.key = url;
  }
  if (trimVid.state !== "idle") return; // loading, ready or failed already
  if (!window.api?.preparePreview) {
    failVideo("update");
    return;
  }
  trimVid.state = "loading";
  const key = trimVid.key;
  // Streaming opens at a modest quality so it starts at once (the menu offers the rest)
  const startHeight = Math.min(
    defaultPreviewHeight() || (duration() > 1200 ? 144 : 240),
    360,
  );
  trimStream
    .open(url, key, startHeight, () => fallbackToFile(key))
    .then((ok) => {
      if (trimVid.key !== key) return;
      if (ok) {
        trimVid.quality = trimStream.height || startHeight;
        trimVid.poster = true; // the thumbnail shows until playing starts
        trimFilm.stripKey = ""; // the strip now comes from the stream
        window.api?.streamTiles?.(trimStream.sessionId, {}).catch(() => {}); // pictures first
        if (trimDialogOpen()) updateTrimUI();
        return;
      }
      startFilePreview(url, key); // no stream for this link: the file copy, the old way
    })
    .catch(() => {
      if (trimVid.key === key) startFilePreview(url, key);
    });
}

/** The file copy: the first seconds, then the whole small copy in the background. */
function startFilePreview(url, key) {
  const wanted = defaultPreviewHeight();
  let used = wanted;
  const request = (height) =>
    window.api.preparePreview(url, {
      proxyUrl: readStr("prefProxyUrl", ""),
      extraArgs: readStr("prefYtdlpArgs", ""),
      duration: duration(),
      ...(height ? { height } : {}),
    });
  request(wanted)
    .then((res) => {
      if ((!res || !res.id) && wanted) {
        // that quality can't be prepared (too large, not offered...): open on Auto instead
        used = 0;
        trimVid.refused = wanted;
        return request(0);
      }
      return res;
    })
    .then((res) => {
      if (trimVid.key !== key) return; // the link changed while the copy was downloading
      if (!res || !res.id) {
        console.warn("Preview not available:", res && res.error);
        failVideo("download");
        return;
      }
      trimVid.quality = used;
      trimVid.partial = !!res.partial; // just the first seconds; the rest follows in the background
      trimVid.headSeconds = Number(res.headSeconds) || 0;
      trimVid.poster = true; // the thumbnail shows until playing starts
      trimVid.waiting = false;
      trimVid.percent = 0;
      trimVid.src = `mbpreview://${res.id}/v`;
      trimCtl.apply(); // volume and speed survive a new source
      trimVideo.src = trimVid.src;
      trimVideo.load();
    })
    .catch(() => {
      if (trimVid.key === key) failVideo("download");
    });
}

trimVideo.addEventListener("loadeddata", () => {
  if (!trimVid.src) return;
  trimCtl.apply();
  setSpin(false);
  if (trimVid.partial)
    trimVid.headSeconds = trimVideo.duration || trimVid.headSeconds;
  if (trimVid.state !== "ready") trimFilm.stripKey = ""; // first load only: a quality switch keeps the strip
  trimVid.state = "ready";
  try {
    trimVideo.currentTime = clamp(
      trimPlay.t,
      0,
      trimVideo.duration || trimPlay.t,
    );
  } catch {}
  if (trimDialogOpen()) updateTrimUI();
  if (trimCtl.hasSnapshot()) {
    // a quality switch: the still goes once the new copy shows the same moment
    if (trimVideo.seeking)
      trimVideo.addEventListener("seeked", trimCtl.hideSnapshot, {
        once: true,
      });
    else trimCtl.hideSnapshot();
    setTimeout(trimCtl.hideSnapshot, 1500);
  }
  if (trimVid.resumePlay) {
    trimVid.resumePlay = false;
    startTrimPlay(true); // the quality changed while playing: carry on from the same moment
  }
  adoptDownloadQuality(); // the download quality may have changed while the copy was loading
});
trimVideo.addEventListener("error", () => {
  if (!trimVid.src) return; // clearing the source also raises an error event
  if (trimVid.stream) {
    trimStream.fail("the player reported an error"); // goes on with the file copy
    return;
  }
  stopTrimPlay();
  trimCtl.hideSnapshot();
  failVideo("play");
});
trimVideo.addEventListener("ended", () => {
  if (!trimPlay.playing) return;
  if (trimVid.partial) {
    // the end of the first seconds: carry on as soon as the rest has loaded
    trimPlay.t =
      trimVid.wantAt > 0 ? trimVid.wantAt : trimVideo.duration || trimPlay.t;
    stopTrimPlay();
    trimVid.waiting = true;
    updateWait();
    return;
  }
  trimVideo.currentTime = trimSel.start; // loop the clip
  const p = trimVideo.play();
  if (p && p.catch) p.catch(() => stopTrimPlay());
});

const dropPoster = () => {
  if (!trimVid.poster) return;
  trimVid.poster = false;
  renderPreview();
};
trimVideo.addEventListener("playing", dropPoster);
trimVideo.addEventListener("seeked", () => {
  if (trimVideo.currentTime > 0.3) dropPoster();
});

/**
 * The whole copy is ready: swap to it at the same moment (the picture is held by a still
 * while it loads), and carry on playing if the person was playing or waiting for it.
 */
function adoptFullPreview(id) {
  const resume = trimPlay.playing || trimVid.waiting;
  const at = trimVid.wantAt > 0 ? trimVid.wantAt : trimPlay.t;
  trimVid.wantAt = 0;
  trimCtl.snapshot();
  stopTrimPlay();
  trimPlay.t = at;
  trimVid.partial = false;
  trimVid.waiting = false;
  trimVid.headSeconds = 0;
  trimVid.percent = 0;
  updateWait();
  trimVid.resumePlay = resume;
  trimVid.src = `mbpreview://${id}/v`;
  trimCtl.apply();
  trimVideo.src = trimVid.src;
  trimVideo.load();
}

window.api?.onPreviewReady?.((data) => {
  if (!data || data.url !== trimVid.key || !trimVid.partial) return;
  if ((Number(data.height) || 0) !== (trimVid.quality || 0)) return;
  if (trimVid.switching) return; // a quality switch brings its own copy
  adoptFullPreview(data.id);
});

window.api?.onPreviewProgress?.((data) => {
  if (!data || data.url !== trimVid.key) return;
  const height = Number(data.height) || 0;
  if (trimVid.switching && height === trimVid.switchTo) {
    trimVid.percent = data.percent;
    trimCtl.refreshMenu();
  } else if (trimVid.partial && height === (trimVid.quality || 0)) {
    trimVid.percent = data.percent;
    updateWait();
  }
});

let seekRaf = 0;
let seekTo = 0;
/** One seek per animation frame, however fast the pointer moves. */
function seekVideo(t) {
  seekTo = t;
  if (seekRaf) return;
  seekRaf = requestAnimationFrame(() => {
    seekRaf = 0;
    if (videoMode()) {
      trimVideo.currentTime = seekTo;
      // a moment beyond the first seconds: it shows as soon as the rest has loaded
      const beyond =
        trimVid.partial && seekTo > (trimVid.headSeconds || 0) - 0.2;
      trimVid.wantAt = beyond ? seekTo : 0;
      if (beyond !== trimVid.waiting) {
        trimVid.waiting = beyond;
        updateWait();
      }
    }
  });
}

/* ############################################################################
 # SECTION: player-playback
 # What the player shows and how it plays.
 ############################################################################ */

/* ---- player picture ---- */
function previewNote() {
  if (videoMode() || framesMode()) return "";
  if (trimVid.state === "failed")
    return trimVid.reason === "update"
      ? "The preview needs the latest main.js and preload.js"
      : "The preview couldn't be prepared";
  if (appState.info?.isLive ?? appState.quick?.isLive)
    return "No preview for live streams";
  return ""; // (the popover already shows that the details are loading)
}

function renderPreview() {
  const d = duration();
  const t = clamp(trimPlay.t, 0, d);
  trimCtl.setTime(`${formatClock(t)} / ${formatClock(d)}`);

  const thumb =
    appState.info?.thumb ||
    appState.quick?.thumb ||
    appState.preview?.thumb ||
    "";
  if (trimPreviewThumb.dataset.src !== thumb) {
    trimPreviewThumb.dataset.src = thumb;
    trimPreviewThumb.style.backgroundImage = thumb
      ? `url("${cssUrl(thumb)}")`
      : "none";
  }

  const sb = storyboard();
  trimPreview.classList.toggle("has-video", videoMode());
  trimPreview.classList.toggle(
    "poster-on",
    videoMode() && trimVid.poster && !!thumb,
  );
  trimPreview.classList.toggle("has-frame", framesMode());
  trimPlayBtn.classList.toggle("hidden", !canPlay());
  trimPreviewNote.textContent = previewNote();
  if (framesMode()) {
    const f = frameStyle(sb, t);
    const key = `${f.url}|${f.pos}`;
    if (key !== trimFilm.frameKey) {
      trimFilm.frameKey = key;
      paintFrame(trimPreviewFrame, f);
      trimPreviewFrame.style.setProperty(
        "--frame-ar",
        `${sb.width} / ${sb.height}`,
      );
    }
  }
}

function renderPlayhead() {
  const d = Math.max(duration(), 1);
  trimCtl.setProgress(
    clamp(trimPlay.t, 0, d),
    d,
    trimSel.start,
    trimSel.end || d,
  );
}

function setPlayhead(t) {
  trimPlay.t = clamp(t, 0, duration());
  if (videoMode()) seekVideo(trimPlay.t);
  renderPlayhead();
  renderPreview();
}

/* ---- play / pause ---- */
function stopTrimPlay() {
  trimPlay.playing = false;
  cancelAnimationFrame(trimPlay.raf);
  trimPreview.classList.remove("playing");
  trimPlayBtn.setAttribute("aria-label", "Play preview");
  if (trimVid.state === "ready" && !trimVideo.paused) trimVideo.pause();
}

/** keepPosition: carry on from the playhead (a resume), instead of starting the clip over. */
function startTrimPlay(keepPosition = false) {
  if (!canPlay() || !duration()) return;
  // Pressing play: start from the clip's beginning when the playhead is outside it
  if (
    !keepPosition &&
    (trimPlay.t < trimSel.start || trimPlay.t >= trimSel.end - 0.05)
  )
    trimPlay.t = trimSel.start;
  if (videoMode() && trimVid.partial) {
    const inside = trimPlay.t < (trimVid.headSeconds || 0) - 0.2;
    trimVid.waiting = !inside;
    trimVid.wantAt = inside ? 0 : trimPlay.t;
    updateWait();
    if (!inside) return; // starts by itself once the rest has loaded
  }
  trimPlay.playing = true;
  trimPlay.last = performance.now();
  trimPreview.classList.add("playing");
  trimPlayBtn.setAttribute("aria-label", "Pause preview");
  if (videoMode()) {
    trimVideo.currentTime = trimPlay.t;
    const p = trimVideo.play();
    if (p && p.catch) p.catch(() => stopTrimPlay());
  }
  const tick = (now) => {
    if (!trimPlay.playing) return;
    // While the user drags the timeline or the player bar, their position wins
    const interacting = !!trimDrag || trimCtl.scrubbing;
    const before = trimPlay.t;
    if (videoMode()) {
      // the video is the clock (unless a seek is still on its way)
      if (!interacting && !seekRaf) trimPlay.t = trimVideo.currentTime;
    } else {
      if (!interacting)
        trimPlay.t += ((now - trimPlay.last) / 1000) * trimCtl.rate;
      trimPlay.last = now;
    }
    // Loop the clip only when playing runs into its end (a seek past it keeps playing)
    const reachedEnd = before < trimSel.end && trimPlay.t >= trimSel.end;
    if (!interacting && (reachedEnd || trimPlay.t >= duration())) {
      trimPlay.t = trimSel.start;
      if (videoMode()) trimVideo.currentTime = trimSel.start;
    }
    renderPlayhead();
    renderPreview();
    trimPlay.raf = requestAnimationFrame(tick);
  };
  trimPlay.raf = requestAnimationFrame(tick);
}

function toggleTrimPlay() {
  if (trimPlay.playing) stopTrimPlay();
  else startTrimPlay();
}
/* ---- play / pause badge ----
 * Like YouTube: a click on the picture (not on the controls) pauses or resumes, and the
 * badge shows what just happened for a moment.
 */
const badgeIcon = (path) =>
  `<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="${path}"/></svg>`;
const trimBadge = document.createElement("div");
trimBadge.className = "trim-badge";
trimBadge.setAttribute("aria-hidden", "true");
trimBadge.innerHTML = `<span class="tb-play">${badgeIcon("M7 4.5v15l12.5-7.5z")}</span><span class="tb-pause">${badgeIcon("M6 4h4.5v16H6zM13.5 4H18v16h-4.5z")}</span>`;
trimPreview.appendChild(trimBadge);
let badgeTimer = 0;

function popBadge(icon) {
  trimBadge.dataset.icon = icon;
  trimBadge.classList.remove("pop");
  void trimBadge.offsetWidth; // restart the animation on a quick second click
  trimBadge.classList.add("pop");
  trimPreview.classList.add("badge-on"); // the big play button steps aside meanwhile
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    trimBadge.classList.remove("pop");
    trimPreview.classList.remove("badge-on");
  }, 650);
}

/* ---- skipping with the arrow keys ----
 * Each press moves 5 s. Presses in a row add up on screen ("+5", "+10", "+15"...) and the
 * count starts again after a short pause, or when the direction changes.
 * It works once the seek bar's handle or the picture has been clicked.
 */
const SKIP_STEP = 5;
const skipChevron = (dir) =>
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="${dir < 0 ? "m15 6-6 6 6 6" : "m9 6 6 6-6 6"}"/></svg>`;
const skipInd = { "-1": null, 1: null };
[-1, 1].forEach((dir) => {
  const el = document.createElement("div");
  el.className = `trim-seek-ind ${dir < 0 ? "left" : "right"}`;
  el.setAttribute("aria-hidden", "true");
  trimPreview.appendChild(el);
  skipInd[dir] = el;
});
const skip = { dir: 0, total: 0, timer: 0 };

function skipBy(dir) {
  if (!canPlay() || !duration()) return;
  if (skip.dir !== dir) skip.total = 0;
  skip.dir = dir;
  skip.total += SKIP_STEP;
  setPlayhead(trimPlay.t + dir * SKIP_STEP);

  const el = skipInd[dir];
  skipInd[-dir].classList.remove("show", "bump");
  el.innerHTML =
    dir < 0
      ? `${skipChevron(-1)}<span>-${skip.total}</span>`
      : `<span>+${skip.total}</span>${skipChevron(1)}`;
  el.classList.add("show");
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");

  clearTimeout(skip.timer);
  skip.timer = setTimeout(() => {
    skipInd[-1].classList.remove("show", "bump");
    skipInd[1].classList.remove("show", "bump");
    skip.dir = 0;
    skip.total = 0;
  }, 900);
}

trimPreview.tabIndex = -1; // a click on the picture gives it the keyboard
trimPreview.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.target.closest && e.target.closest(".tc-menu")) return;
  e.preventDefault();
  skipBy(e.key === "ArrowRight" ? 1 : -1);
});

trimPreview.addEventListener("click", () => {
  if (trimCtl.menuOpen()) return trimCtl.closeMenu();
  trimPreview.focus({ preventScroll: true });
  const wasPlaying = trimPlay.playing;
  toggleTrimPlay();
  trimCtl.activate();
  // the badge shows the new state, and only if the click really changed it
  if (trimPlay.playing !== wasPlaying)
    popBadge(trimPlay.playing ? "play" : "pause");
});
trimPreview.addEventListener("dblclick", () => trimCtl.toggleFullscreen());

// M mutes, F goes fullscreen (not while typing in a field)
document.addEventListener("keydown", (e) => {
  if (!trimDialogOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === "m" || e.key === "M") trimCtl.toggleMute();
  else if (e.key === "f" || e.key === "F") trimCtl.toggleFullscreen();
});

// Reaching for the scissors starts preparing the preview, so it is ready when the popover opens
const warmPreview = () => {
  if (!btnToggleCut.disabled && duration() > 0) ensureVideo();
};
btnToggleCut.addEventListener("pointerenter", warmPreview);
btnToggleCut.addEventListener("focus", warmPreview);
