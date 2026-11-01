/** ============================================================================
 * downloads-scripts/queue-scripts.js
 * The download queue: scheduler, drawing the list, selection, keyboard shortcuts, mouse actions, context menu and toolbar.
 * Loads after core.js.
 *
 * Sections (in file order) and their features:
 *
 *  [queue-engine] The download scheduler: decides what runs, when, and sends it to the main process.
 *    - Settings accessors: max concurrent downloads, download folder, yt-dlp options
 *    - URL validation (isValidMediaUrl, checkIfPlaylistUrl) and desktop notifications
 *    - Data limit: stops starting downloads once the limit is reached
 *    - Keeps the system awake while downloads run and pushes app preferences to the main process
 *    - Queue completion alert (notifyIfQueueFinished)
 *    - startTask (sends one task to the main process) and processNext (fills free download slots)
 *
 *  [queue-context-menu] The right-click menu on a download card.
 *    - Menu icons and which items show for each status (queued, downloading, paused, completed, failed, cancelled)
 *    - Actions: Open file/folder, Start, Pause, Resume, Retry, Prioritize, Copy link, Explore Playlist, Cancel/Remove
 *    - Applies to the whole selection, not just the card under the pointer
 *    - Menu is closed by blur, resize, scroll and clicks elsewhere
 *
 *  [queue-render] Draws the queue list and each download card.
 *    - renderQueue: search filter, ordering, empty state, counters
 *    - createQueueRowCard: thumbnail, title, status, progress, trim label
 *    - statusLabel and trimLabel text helpers
 *
 *  [queue-selection] The selection model shared by mouse and keyboard.
 *    - selectedTaskIds / focused line / range anchor
 *    - paintSelection (repaints classes in place without rebuilding the list)
 *    - setSelection, rangeIds, selectAllVisible, selectByPointer (Ctrl/Shift click)
 *    - scrollToTask and openTask (double-click / Enter)
 *
 *  [queue-actions] Actions that run on selected downloads.
 *    - Pause and resume (selected or a given list)
 *    - Copy links to the clipboard
 *    - Remove tasks (with confirmation, not while downloading)
 *    - Open the files of completed downloads
 *
 *  [queue-mouse] Mouse handling on the queue list.
 *    - Click, Ctrl/Shift+click and double-click on cards
 *    - Marquee (rubber-band) selection with edge auto-scroll
 *    - Right-click on a card opens the context menu with the selection kept
 *    - Clicking outside the list clears the selection (except on the controls that act on it)
 *
 *  [queue-keyboard] Keyboard shortcuts for the queue.
 *    - Enter opens completed files, Space toggles the focused item
 *    - Esc / Mod+Backspace clear selection and hide the context menu
 *    - Mod+A select all, Mod+C copy links, Mod+P pause, Mod+R resume/retry, Mod+D / Delete remove
 *    - Up/Down move focus and select, Shift extends a range, Ctrl moves focus only, Home/End jump
 *    - Ctrl/Cmd+R arrives from the main process (onShortcut) so the page is not reloaded
 *
 *  [queue-toolbar] The queue search box.
 *    - Queue search input (re-renders the list as you type)
 *
 * Split from the old downloads-script.js. The five files are classic scripts that share one
 * scope (like the old single closure), so they can call each other's functions freely.
 * Load order, set in downloads-index.html: core, queue-scripts, trim-engine, video-player, playlist-explorer.
 * ========================================================================== */

/* ############################################################################
 # SECTION: queue-engine
 # The download scheduler: decides what runs, when, and sends it to the main process.
 ############################################################################ */

/** --------------------------------------------------------------------------
 * SCHEDULER & WORKFLOW
 * -------------------------------------------------------------------------- */
function getMaxConcurrent() {
  const n = parseInt(localStorage.getItem("prefMaxConcurrent"), 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

function getDownloadDir() {
  return localStorage.getItem("downloadDir") || "";
}

function getDownloadOptions() {
  return {
    audioLang: readStr("prefAudioLang", "auto"),
    chapters: readBool("prefChapters", false),
    captions: readBool("prefCaptions", false),
    subLang: readStr("prefSubLang", "auto"),
    subMode: readStr("prefSubMode", "embedded"), // embedded | separate | both
    subFormat: readStr("prefSubFormat", "srt"),
    subAuto: readBool("prefSubAuto", true),
    embedThumb: readBool("prefEmbedThumb", false),
    trackPrefix: readBool("prefTrackPrefix", false),
    autoRetry: readBool("prefAutoRetry", true),
    maxRetries: parseInt(localStorage.getItem("prefMaxRetries"), 10) || 3,
    speedLimit: localStorage.getItem("prefSpeedLimit") || "",
    proxyUrl: localStorage.getItem("prefProxyUrl") || "",
    extraArgs: localStorage.getItem("prefYtdlpArgs") || "",
  };
}

function isValidMediaUrl(rawUrl) {
  if (!rawUrl || /\s/.test(rawUrl)) return false;
  try {
    const u = new URL(rawUrl);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function checkIfPlaylistUrl(url) {
  try {
    const u = new URL(url);
    const list = (u.searchParams.get("list") || "").toUpperCase();
    if (list.startsWith("RD")) return false;
    return !!list || u.pathname.toLowerCase().includes("/playlist");
  } catch {
    return false;
  }
}

/** Desktop notifications only when "Enable System Notifications" is on. */
function desktopNotify(title, body) {
  if (readBool("prefNotifyEnable", false) && window.api?.notify)
    window.api.notify(tr(title), tr(body));
}

/* ---- Data limit (Network tab): counts data downloaded since the app started ---- */
const bytesByTask = new Map();
let limitReached = false;
let lastLimitToast = 0;

function parseDataLimit(text) {
  const m = String(text || "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(MB|GB|TB)$/i);
  if (!m) return 0;
  const mult = { MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[
    m[2].toUpperCase()
  ];
  return Math.round(Number(m[1]) * mult);
}

function usedBytes() {
  let total = 0;
  bytesByTask.forEach((b) => (total += b));
  return total;
}

function dataLimitHit() {
  const limit = parseDataLimit(localStorage.getItem("prefDataLimit"));
  if (!limit) return false;
  return usedBytes() >= limit;
}

function enforceDataLimit() {
  const limit = parseDataLimit(localStorage.getItem("prefDataLimit"));
  if (!limit || usedBytes() < limit) {
    limitReached = false;
    return false;
  }
  if (!limitReached) {
    limitReached = true;
    queue.forEach((t) => {
      if (t.status === "in_progress" || t.status === "queued") {
        if (t.status === "in_progress" && window.api?.cancelDownload)
          window.api.cancelDownload(t.id, { keepPartial: true });
        t.status = "paused";
        t.stage = "";
      }
    });
    saveQueue();
    renderQueue();
    showToast(
      tr("Data limit reached ({limit}). Downloads paused.", { limit: formatBytes(limit) }),
      "warning",
      6000,
    );
    desktopNotify("Data limit reached", "Downloads were paused.");
  }
  return true;
}

/* ---- Keep the system awake while downloads run (Network tab) ---- */
let sleepBlocked = null;
function syncPreventSleep() {
  const want =
    readBool("prefPreventSleep", false) &&
    queue.some((t) => t.status === "in_progress");
  if (want !== sleepBlocked) {
    sleepBlocked = want;
    if (window.api?.setPreventSleep) window.api.setPreventSleep(want);
  }
}

function pushAppPrefs() {
  if (window.api?.setAppPrefs)
    window.api.setAppPrefs({
      rememberWindow: readBool("prefRememberWinSize", true),
      startMinimized: readBool("prefStartMinimized", false),
      minimizeToTray: readBool("prefMinimizeToTray", false),
      // The main process prefetches a link the moment it is copied
      autoDetect: readBool("prefAutoDetect", true),
      defaultFormat: effectiveDefaults().format,
      defaultQuality: effectiveDefaults().quality,
    });
}

/* ---- "Queue Completion Alerts" ---- */
let sessionCompleted = 0;
function notifyIfQueueFinished() {
  if (!sessionCompleted) return;
  const busy = queue.some(
    (t) => t.status === "in_progress" || t.status === "queued",
  );
  if (busy) return;
  if (readBool("prefQueueCompleteNotify", true)) {
    showToast(
      tr("All downloads finished ({n})", { n: sessionCompleted }),
      "success",
      5000,
    );
    desktopNotify(
      "All downloads finished",
      tr(sessionCompleted === 1 ? "{n} item completed." : "{n} items completed.", { n: sessionCompleted }),
    );
  }
  sessionCompleted = 0;
}

function startTask(task) {
  task.status = "in_progress";
  task.stage = "downloading";
  task.stageText = "";
  task.error = "";
  task.progress = task.progress || 0;
  task.speed = "";
  task.eta = "";

  if (!window.api || !window.api.startDownload) {
    task.status = "failed";
    task.error = "Download engine is not available";
    return;
  }

  window.api.startDownload({
    downloadId: task.id,
    url: task.url,
    format: task.format,
    quality: task.quality,
    saveFolder: task.saveFolder || getDownloadDir(),
    subfolder: task.subfolder || "",
    playlistIndex: task.playlistIndex,
    dupSuffix: task.dupSuffix || 0,
    streamSizes: task.streamSizes || [],
    trim: task.trim || null,
    title: isPlaceholderTitle(task.title) ? "" : task.title,
    options: {
      ...getDownloadOptions(),
      ...(task.opts || {}),
      overwrite: !!task.overwrite,
    },
  });
}

function processNext() {
  if (enforceDataLimit()) {
    if (
      queue.some((t) => t.status === "queued") &&
      Date.now() - lastLimitToast > 5000
    ) {
      lastLimitToast = Date.now();
      showToast(
        "Data limit reached. Raise it in Settings → Network & Access.",
        "warning",
        5000,
      );
    }
  } else {
    const max = getMaxConcurrent();
    let active = queue.filter((t) => t.status === "in_progress").length;
    const pending = queue
      .filter((t) => t.status === "queued")
      .sort(
        (a, b) =>
          (b.priority || 0) - (a.priority || 0) ||
          new Date(a.createdAt || 0) - new Date(b.createdAt || 0),
      );
    for (const task of pending) {
      if (active >= max) break;
      startTask(task);
      active++;
    }
  }

  saveQueue();
  renderQueue();
  syncPreventSleep();
}

/* ############################################################################
 # SECTION: queue-context-menu
 # The right-click menu on a download card.
 ############################################################################ */

/** --------------------------------------------------------------------------
 * CUSTOM RIGHT-CLICK CONTEXT MENU
 *
 * Opens on a download card and acts on the selection (a right-click on a card
 * that is not selected selects it first). What is enabled follows the status:
 *
 *                       Queued  Downloading  Paused  Completed  Failed  Cancelled
 *   Open File / Folder     -         -          -       yes        -        -
 *   Start                 yes        -          -        -         -        -
 *   Pause                  -        yes         -        -         -        -
 *   Resume                 -         -         yes       -         -        -
 *   Retry                  -         -          -        -        yes      yes
 *   Prioritize            yes       yes        yes       -         -        -
 *   Copy Video Link, Explore Playlist, File Details: every status
 *   Cancel                 -        yes         -        -         -        -
 *   Remove                yes        -         yes      yes       yes      yes
 *
 * Start / Pause / Resume / Retry share one row, and so do Cancel / Remove: the
 * label and the icon change with the status. File Details is a placeholder for
 * now.
 * -------------------------------------------------------------------------- */
const menuIcon = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const MENU_ICONS = {
  openFile: menuIcon(
    '<path d="M10.5 5.5H8A3.5 3.5 0 0 0 4.5 9v7A3.5 3.5 0 0 0 8 19.5h7a3.5 3.5 0 0 0 3.5-3.5v-2.5"/><path d="M14 3.5h6.5V10"/><path d="M20.5 3.5 11 13"/>',
  ),
  openFolder: menuIcon(
    '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.7a2 2 0 0 1 1.5.68L12.2 6.4a2 2 0 0 0 1.5.68h4.8A2.5 2.5 0 0 1 21 9.58V17.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z"/>',
  ),
  start: menuIcon(
    '<path d="M8.33 4.85L17.53 10.37Q20.25 12.00 17.53 13.63L8.33 19.15Q5.61 20.78 5.61 17.61L5.61 6.39Q5.61 3.22 8.33 4.85Z"/>',
  ),
  pause: menuIcon(
    '<rect x="6" y="4.5" width="4" height="15" rx="1.6"/><rect x="14" y="4.5" width="4" height="15" rx="1.6"/>',
  ),
  resume: menuIcon(
    '<path d="M8.33 4.85L17.53 10.37Q20.25 12.00 17.53 13.63L8.33 19.15Q5.61 20.78 5.61 17.61L5.61 6.39Q5.61 3.22 8.33 4.85Z"/>',
  ),
  retry: menuIcon(
    '<path d="M20 12A8 8 0 1 1 18.9 7.94"/><path d="M19 3.5v4.45h-4.45"/>',
  ),
  prioritize: menuIcon(
    '<path d="M13 2.8V9.8h6.2L10 21.2l.9-7.8H4.7Z"/>',
  ),
  copy: menuIcon(
    '<rect x="8.5" y="8.5" width="12.5" height="12.5" rx="3"/><path d="M7 15.5H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h6.5a3 3 0 0 1 3 3v1"/>',
  ),
  playlist: menuIcon(
    '<path d="M4 4v16M8.5 7v13M13 7v13M17 5.5l3.5 13.5"/>',
  ),
  details: menuIcon(
    '<circle cx="12" cy="12" r="9"/><path d="M12 16.5v-5"/><path d="M12 7.9h.01"/>',
  ),
  cancel: menuIcon(
    '<path d="M6 6l12 12M18 6 6 18"/>',
  ),
  remove: menuIcon(
    '<path d="M4 7h16"/><path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6.5 7l.8 11.2a2.5 2.5 0 0 0 2.5 2.3h4.4a2.5 2.5 0 0 0 2.5-2.3L17.5 7"/>',
  ),
};

/** status -> what the shared "Start / Pause / Resume / Retry" row shows. */
const MENU_FLOW = {
  queued: { key: "start", label: "Start" },
  in_progress: { key: "pause", label: "Pause" },
  paused: { key: "resume", label: "Resume" },
  failed: { key: "retry", label: "Retry" },
  cancelled: { key: "retry", label: "Retry" },
};
const FLOW_STATUSES = {
  start: ["queued"],
  pause: ["in_progress"],
  resume: ["paused"],
  retry: ["failed", "cancelled"],
};

function removeContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
}

/** Queued -> Start: begins now, even if every download slot is busy. */
function startTasksNow(list) {
  const waiting = list.filter((t) => t.status === "queued");
  if (!waiting.length) return;
  if (enforceDataLimit()) {
    showToast(
      "Data limit reached. Raise it in Settings → Network & Access.",
      "warning",
      5000,
    );
    return;
  }
  waiting.forEach(startTask);
  saveQueue();
  renderQueue();
  syncPreventSleep();
  showToast(tr("Started {x}", { x: plural(waiting.length, "download") }), "info");
}

/** Downloading -> Cancel: stops it, deletes the partial files; Retry starts it over. */
function cancelTasks(list) {
  const active = list.filter((t) => t.status === "in_progress");
  if (!active.length) return;
  active.forEach((t) => {
    if (window.api && window.api.cancelDownload)
      window.api.cancelDownload(t.id, { keepPartial: false });
    t.status = "cancelled";
    t.stage = "";
    t.stageText = "";
    t.progress = 0;
    t.speed = "";
    t.eta = "";
    t.error = "";
  });
  saveQueue();
  processNext(); // frees the slots for whatever is still queued
  showToast(tr("Cancelled {x}", { x: plural(active.length, "download") }), "warning");
}

/** Moves the downloads to the top and puts them first in line for a free slot. */
function prioritizeTasks(list) {
  if (!list.length) return;
  let top = queue.reduce((m, t) => Math.max(m, t.priority || 0), 0);
  // keep the order they have on screen: the card that is highest now stays highest
  [...list].reverse().forEach((t) => {
    t.priority = ++top;
  });
  saveQueue();
  processNext(); // a queued download that now comes first takes the next free slot
  if (queueList) queueList.scrollTop = 0;
  showToast(
    list.length === 1
      ? "Moved to the top of the queue"
      : tr("Moved {n} downloads to the top", { n: list.length }),
    "success",
  );
}

const MAX_OPEN = 5; // files / folders opened at once

function openTasks(list) {
  list.slice(0, MAX_OPEN).forEach(openTask);
  if (list.length > MAX_OPEN)
    showToast(tr("Opened {a} of {b} files", { a: MAX_OPEN, b: list.length }), "info");
}

/** Shows each file in its folder (one window per folder). */
function openTaskFolders(list) {
  const dirOf = (p) =>
    p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
  const seen = new Set();
  for (const t of list) {
    if (seen.size >= MAX_OPEN) break;
    const key = t.filePath ? dirOf(t.filePath) : t.saveFolder || "";
    if (seen.has(key)) continue;
    seen.add(key);
    if (t.filePath && window.api && window.api.showInFolder)
      window.api.showInFolder(t.filePath);
    else if (window.api && window.api.openFolder)
      window.api.openFolder(t.saveFolder || getDownloadDir());
  }
}

function runMenuFlow(key, list) {
  if (key === "start") startTasksNow(list);
  else if (key === "pause") pauseTasks(list);
  else resumeTasks(list); // resume / retry
}

function createContextMenu(e, item) {
  removeContextMenu();
  e.preventDefault();

  const picked = selectedTasks();
  const targets = picked.some((t) => t.id === item.id) ? picked : [item];
  const withStatus = (...s) => targets.filter((t) => s.includes(t.status));

  // Start / Pause / Resume / Retry: follows the clicked card (else the first card it fits)
  const flowItem = MENU_FLOW[item.status]
    ? item
    : targets.find((t) => MENU_FLOW[t.status]);
  const flow = flowItem ? MENU_FLOW[flowItem.status] : null;
  const flowTargets = flow ? withStatus(...FLOW_STATUSES[flow.key]) : [];

  const openable = withStatus("completed").filter((t) => t.filePath);
  const finished = withStatus("completed");
  const prioritizable = withStatus("queued", "in_progress", "paused");
  const cancelling = item.status === "in_progress";
  const removable = targets.filter((t) => t.status !== "in_progress");

  const entries = [
    {
      icon: "openFile",
      label: "Open File",
      enabled: openable.length > 0,
      run: () => openTasks(openable),
    },
    {
      icon: "openFolder",
      label: "Open Folder",
      enabled: finished.length > 0,
      run: () => openTaskFolders(finished),
    },
    "-",
    {
      icon: flow ? flow.key : "start",
      label: flow ? flow.label : "Start",
      enabled: flowTargets.length > 0,
      run: () => runMenuFlow(flow.key, flowTargets),
    },
    {
      icon: "prioritize",
      label: "Prioritize",
      enabled: prioritizable.length > 0,
      run: () => prioritizeTasks(prioritizable),
    },
    "-",
    {
      icon: "copy",
      label: "Copy Video Link",
      enabled: true,
      run: () => copyTaskLinks(targets),
    },
    {
      icon: "playlist",
      label: "Explore Playlist",
      enabled: true,
      run: () => explorePlaylist(item),
    },
    {
      icon: "details",
      label: "File Details",
      enabled: true,
      run: () => showToast("File Details is coming soon", "info"),
    },
    "-",
    cancelling
      ? {
          icon: "cancel",
          label: "Cancel",
          enabled: true,
          run: () => cancelTasks(withStatus("in_progress")),
        }
      : {
          icon: "remove",
          label: "Remove",
          enabled: removable.length > 0,
          run: () => removeTasks(removable),
        },
  ];

  const menu = document.createElement("div");
  menu.className = "custom-context-menu";
  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;

  const rows = []; // the enabled rows, for the keyboard
  entries.forEach((entry) => {
    if (entry === "-") {
      const divider = document.createElement("div");
      divider.className = "context-menu-divider";
      divider.setAttribute("role", "separator");
      menu.appendChild(divider);
      return;
    }
    const row = document.createElement("div");
    row.className = `context-menu-item${entry.enabled ? "" : " disabled"}`;
    row.setAttribute("role", "menuitem");
    row.setAttribute("aria-disabled", String(!entry.enabled));
    row.innerHTML = `<div class="context-menu-item-left">${MENU_ICONS[entry.icon]}<span>${esc(tr(entry.label))}</span></div>`;
    row.addEventListener("click", (ev) => {
      if (!entry.enabled) return ev.stopPropagation(); // a dimmed row keeps the menu open
      removeContextMenu();
      entry.run();
    });
    menu.appendChild(row);
    if (entry.enabled) rows.push(row);
  });

  // Keyboard: Up / Down / Home / End move, Enter or Space runs, Esc closes (global handler)
  let current = -1;
  const highlight = (index) => {
    current = index;
    rows.forEach((r, n) => r.classList.toggle("kb-active", n === index));
  };
  menu.addEventListener("mouseover", () => highlight(-1));
  menu.addEventListener("keydown", (ev) => {
    if (!rows.length) return;
    if (ev.key === "ArrowDown")
      highlight(current < 0 ? 0 : (current + 1) % rows.length);
    else if (ev.key === "ArrowUp")
      highlight(
        current < 0
          ? rows.length - 1
          : (current - 1 + rows.length) % rows.length,
      );
    else if (ev.key === "Home") highlight(0);
    else if (ev.key === "End") highlight(rows.length - 1);
    else if ((ev.key === "Enter" || ev.key === " ") && current >= 0)
      rows[current].click();
    else return;
    ev.preventDefault();
  });
  menu.addEventListener("contextmenu", (ev) => ev.preventDefault());

  document.body.appendChild(menu);
  contextMenuEl = menu;

  // Keep it inside the window
  const margin = 8;
  const left = Math.max(
    margin,
    Math.min(e.clientX, window.innerWidth - menu.offsetWidth - margin),
  );
  const top = Math.max(
    margin,
    Math.min(e.clientY, window.innerHeight - menu.offsetHeight - margin),
  );
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.focus({ preventScroll: true });
}

// The menu goes away with anything that moves the list or the window under it
window.addEventListener("blur", removeContextMenu);
window.addEventListener("resize", removeContextMenu);
if (queueList)
  queueList.addEventListener("scroll", removeContextMenu, { passive: true });
document.addEventListener("contextmenu", (e) => {
  const t = e.target;
  if (
    t &&
    t.closest &&
    (t.closest(".custom-context-menu") || t.closest(".queue-row-card"))
  )
    return;
  removeContextMenu();
});

/* ############################################################################
 # SECTION: queue-render
 # Draws the queue list and each download card.
 ############################################################################ */

/** --------------------------------------------------------------------------
 * QUEUE CARD RENDERING
 * -------------------------------------------------------------------------- */
function renderQueue() {
  if (!queueList) return;

  const query = (queueSearchInput?.value || "").trim().toLowerCase();

  let processed = queue.filter((t) => {
    if (
      query &&
      !(
        (t.title || "").toLowerCase().includes(query) ||
        (t.url || "").toLowerCase().includes(query)
      )
    ) {
      return false;
    }
    return true;
  });

  // Newest first; a prioritised download sits above the rest (the latest one on top)
  processed.sort(
    (a, b) =>
      (b.priority || 0) - (a.priority || 0) ||
      new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
  );

  // "Group Playlist Files in Queue": each playlist's items sit together under a header
  // (the group is placed where its newest item would be; items keep the playlist's order)
  const grouped = readBool("prefGroupPlaylist", false);
  const blocks = []; // { group?, items }
  if (grouped) {
    const seen = new Set();
    processed.forEach((t) => {
      if (!t.playlistGroup) return blocks.push({ items: [t] });
      if (seen.has(t.playlistGroup)) return;
      seen.add(t.playlistGroup);
      const items = processed
        .filter((x) => x.playlistGroup === t.playlistGroup)
        .sort((a, b) => (a.playlistIndex || 0) - (b.playlistIndex || 0));
      blocks.push({ group: t.playlistGroup, title: t.playlistTitle || "Playlist", items });
    });
    processed = blocks.flatMap((b) =>
      b.group && collapsedGroups.has(b.group) ? [] : b.items,
    );
  }

  // Selection only ever covers what is on screen (filtering/searching drops the rest)
  visibleIds = processed.map((t) => t.id);
  const visible = new Set(visibleIds);
  for (const id of Array.from(selectedTaskIds))
    if (!visible.has(id)) selectedTaskIds.delete(id);
  if (focusedTaskId && !visible.has(focusedTaskId)) focusedTaskId = null;
  if (anchorTaskId && !visible.has(anchorTaskId)) anchorTaskId = null;

  if (processed.length === 0 && !blocks.length) {
    queueList.innerHTML = "";
    if (emptyQueueState) emptyQueueState.style.display = "flex";
    updateButtonStates();
    return;
  }

  if (emptyQueueState) emptyQueueState.style.display = "none";

  const frag = document.createDocumentFragment();
  if (grouped) {
    blocks.forEach((b) => {
      if (!b.group) {
        frag.appendChild(createQueueRowCard(b.items[0]));
        return;
      }
      frag.appendChild(createQueueGroupHeader(b));
      if (collapsedGroups.has(b.group)) return;
      b.items.forEach((item) => {
        const card = createQueueRowCard(item);
        card.classList.add("in-group");
        frag.appendChild(card);
      });
    });
  } else {
    processed.forEach((item) => {
      const card = createQueueRowCard(item);
      frag.appendChild(card);
    });
  }

  queueList.replaceChildren(frag);
  updateButtonStates();
}

/** Folded playlist groups (kept while the app runs). */
const collapsedGroups = new Set();

function createQueueGroupHeader(block) {
  const done = block.items.filter((t) => t.status === "completed").length;
  const head = document.createElement("div");
  head.className = `queue-group-header${collapsedGroups.has(block.group) ? " collapsed" : ""}`;
  head.dataset.group = block.group;
  head.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
    <span class="queue-group-title truncate" title="${esc(block.title)}">${esc(block.title)}</span>
    <span class="queue-group-count">${done}/${block.items.length}</span>`;
  head.addEventListener("click", () => {
    if (collapsedGroups.has(block.group)) collapsedGroups.delete(block.group);
    else collapsedGroups.add(block.group);
    renderQueue();
  });
  return head;
}

function statusLabel(item) {
  switch (item.status) {
    case "in_progress":
      if (item.stage === "cutting") return tr("Cutting");
      if (item.stage === "processing")
        return tr(String(item.stageText || "Processing")).replace(/…$/, "");
      // Nothing has arrived yet (0%): "Starting"; the first bytes make it "Downloading"
      if (!(item.progress > 0) && !item.speed) return tr("Starting");
      return tr("Downloading");
    case "completed":
      return tr("Completed");
    case "paused":
      return tr("Paused");
    case "failed":
      return tr("Failed");
    case "cancelled":
      return tr("Cancelled");
    default:
      return tr("Queued");
  }
}

function trimLabel(item) {
  return item.trim
    ? `✂ ${formatClock(item.trim.start)}–${formatClock(item.trim.end)}`
    : "";
}

function cardLeftText(item) {
  // While data arrives the speed sits next to the state: "Downloading · 2.4 MB/s"
  let left = item.speed ? `${statusLabel(item)} · ${item.speed}` : statusLabel(item);
  if (!item.speed && item.status === "in_progress" && item.stageText)
    left = tr(item.stageText);
  if (item.status === "failed" && item.error) left = `${tr("Failed")} · ${item.error}`;
  return left;
}

function cardRightText(item) {
  const trimText = trimLabel(item);
  return `${sanitizeFormat(item.format)}${item.size ? " • " + item.size : ""}${trimText ? " • " + trimText : ""}`;
}

/* Progress ticks arrive many times a second. They only touch the numbers of the card
 * that changed (at most ~5 times a second), never rebuild the whole list. */
const dirtyCards = new Set();
let cardFlushTimer = 0;

function updateQueueCard(item) {
  dirtyCards.add(item.id);
  if (!cardFlushTimer) cardFlushTimer = setTimeout(flushQueueCards, 200);
}

function flushQueueCards() {
  cardFlushTimer = 0;
  const ids = [...dirtyCards];
  dirtyCards.clear();
  let rebuild = false;
  for (const id of ids) {
    const item = taskById(id);
    const card = queueList?.querySelector(`.queue-row-card[data-task-id="${id}"]`);
    const pct = card?.querySelector(".card-percent");
    const fill = card?.querySelector(".card-progress-bar-fill");
    if (!item || !card || !pct || !fill) {
      rebuild = true;
      continue;
    }
    const p = item.progress || 0;
    pct.textContent = `${p}%`;
    fill.style.width = `${p}%`;
    card.className = card.className.replace(/\s*stage-\w+/g, "");
    if (item.status === "in_progress" && item.stage)
      card.classList.add(`stage-${item.stage}`);
    const title = card.querySelector(".card-title");
    const name = item.title || item.url || "";
    if (title && title.textContent !== name) {
      title.textContent = name;
      title.title = item.title || "";
    }
    const img = card.querySelector(".card-thumb");
    const thumb = safeImgUrl(item.thumb);
    if (img && thumb && img.getAttribute("src") !== thumb) img.src = thumb;
    const bottom = card.querySelectorAll(".card-bottom-row > div");
    if (bottom[0]) bottom[0].textContent = cardLeftText(item);
    if (bottom[1]) bottom[1].textContent = cardRightText(item);
  }
  if (rebuild) renderQueue();
}

function createQueueRowCard(item) {
  const card = document.createElement("div");
  const stageClass =
    item.status === "in_progress" && item.stage ? ` stage-${item.stage}` : "";
  card.className = `queue-row-card ${selectedTaskIds.has(item.id) ? "selected" : ""}${item.id === focusedTaskId ? " focused" : ""}${stageClass}`;
  card.dataset.taskId = item.id;

  const cleanFmt = sanitizeFormat(item.format);
  const statusText = statusLabel(item);
  const title = esc(item.title || item.url);
  const trimText = trimLabel(item);

  const showProgress =
    item.status === "in_progress" ||
    (item.status === "paused" && (item.progress || 0) > 0);

  const leftText = cardLeftText(item);

  card.innerHTML = `
    <img class="card-thumb" src="${esc(safeImgUrl(item.thumb))}" alt="Thumb" decoding="async" draggable="false" />
    <div class="card-body">
      <div class="card-top-row">
        <div class="card-title truncate" title="${esc(item.title)}">${title}</div>
        ${showProgress ? `<div class="card-percent">${item.progress || 0}%</div>` : ""}
      </div>
      ${
        showProgress
          ? `
        <div class="card-progress-bar-bg">
          <div class="card-progress-bar-fill" style="width: ${item.progress || 0}%;"></div>
        </div>
      `
          : ""
      }
      <div class="card-bottom-row">
        <div class="truncate" title="${esc(item.error)}">${esc(leftText)}</div>
        <div>${esc(cleanFmt)}${item.size ? " • " + esc(item.size) : ""}${trimText ? " • " + esc(trimText) : ""}</div>
      </div>
    </div>
  `;

  return card;
}

/* ############################################################################
 # SECTION: queue-selection
 # The selection model shared by mouse and keyboard.
 ############################################################################ */

/** --------------------------------------------------------------------------
 * SELECTION MODEL (mouse and keyboard share it)
 *   selectedTaskIds  what is highlighted
 *   focusedTaskId    the keyboard focus line (dotted outline)
 *   anchorTaskId     where Shift-ranges start
 * Selection changes repaint classes in place; the list is not rebuilt, so a
 * drag or a click is never interrupted by a progress update.
 * -------------------------------------------------------------------------- */
const taskById = (id) => queue.find((t) => t.id === id);
const selectedTasks = () =>
  visibleIds
    .filter((id) => selectedTaskIds.has(id))
    .map(taskById)
    .filter(Boolean);

function cardFor(id) {
  return queueList
    ? queueList.querySelector(`[data-task-id="${CSS.escape(id)}"]`)
    : null;
}

function paintSelection() {
  if (queueList) {
    for (const card of queueList.children) {
      const id = card.dataset.taskId;
      card.classList.toggle("selected", selectedTaskIds.has(id));
      card.classList.toggle("focused", id === focusedTaskId);
    }
  }
  updateButtonStates();
}

function setSelection(ids, { focus, anchor } = {}) {
  selectedTaskIds.clear();
  for (const id of ids) selectedTaskIds.add(id);
  if (focus !== undefined) focusedTaskId = focus;
  if (anchor !== undefined) anchorTaskId = anchor;
  paintSelection();
}

function rangeIds(fromId, toId) {
  const to = visibleIds.indexOf(toId);
  if (to < 0) return [];
  const from = visibleIds.indexOf(fromId);
  if (from < 0) return [toId];
  return visibleIds.slice(Math.min(from, to), Math.max(from, to) + 1);
}

function scrollToTask(id) {
  const card = cardFor(id);
  if (card) card.scrollIntoView({ block: "nearest" });
}

function selectAllVisible() {
  if (!visibleIds.length) return;
  const focus = visibleIds.includes(focusedTaskId)
    ? focusedTaskId
    : visibleIds[0];
  const anchor = visibleIds.includes(anchorTaskId)
    ? anchorTaskId
    : visibleIds[0];
  setSelection(visibleIds, { focus, anchor });
}

/** Click / Ctrl+Click / Shift+Click (Ctrl+Shift+Click adds the range). */
function selectByPointer(id, e) {
  const additive = e.ctrlKey || e.metaKey;
  if (e.shiftKey) {
    const anchor = visibleIds.includes(anchorTaskId) ? anchorTaskId : id;
    const range = rangeIds(anchor, id);
    setSelection(additive ? [...selectedTaskIds, ...range] : range, {
      focus: id,
      anchor,
    });
  } else if (additive) {
    const next = new Set(selectedTaskIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelection(next, { focus: id, anchor: id });
  } else {
    setSelection([id], { focus: id, anchor: id });
  }
}

/** Opens a finished download (its file; the folder if the path is unknown). */
function openTask(item) {
  if (!item || item.status !== "completed" || !window.api) return false;
  if (item.filePath && window.api.openFile)
    window.api.openFile(item.filePath);
  else if (window.api.showInFolder)
    window.api.showInFolder(item.filePath || getDownloadDir());
  else return false;
  return true;
}

/* ############################################################################
 # SECTION: queue-actions
 # Actions that run on selected downloads.
 ############################################################################ */

/** --------------------------------------------------------------------------
 * ACTIONS ON THE SELECTION
 * -------------------------------------------------------------------------- */
const plural = (n, word) => `${n} ${tr(n === 1 ? word : word + "s")}`;

function pauseSelected() {
  const targets = selectedTasks().filter(
    (t) => t.status === "in_progress" || t.status === "queued",
  );
  if (!targets.length) {
    if (selectedTaskIds.size)
      showToast("No active or queued downloads selected", "info");
    return;
  }
  pauseTasks(targets);
}

function pauseTasks(targets) {
  targets.forEach((t) => {
    if (t.status === "in_progress" && window.api && window.api.cancelDownload)
      window.api.cancelDownload(t.id, { keepPartial: true });
    t.status = "paused";
    t.stage = "";
    t.stageText = "";
    t.speed = "";
    t.eta = "";
  });
  saveQueue();
  processNext(); // frees the slots for whatever is still queued
  showToast(tr("Paused {x}", { x: plural(targets.length, "download") }), "warning");
}

function resumeSelected() {
  const targets = selectedTasks().filter(
    (t) =>
      t.status === "paused" ||
      t.status === "failed" ||
      t.status === "cancelled",
  );
  if (!targets.length) {
    if (selectedTaskIds.size)
      showToast("No paused, failed or cancelled downloads selected", "info");
    return;
  }
  resumeTasks(targets);
}

/** Paused downloads carry on; failed and cancelled ones start over (retry). */
function resumeTasks(targets) {
  const retried = targets.filter(
    (t) => t.status === "failed" || t.status === "cancelled",
  ).length;
  targets.forEach((t) => {
    if (t.status === "cancelled") t.progress = 0; // its partial files were discarded
    t.status = "queued";
    t.stage = "";
    t.error = "";
  });
  saveQueue();
  processNext();
  showToast(
    retried
      ? targets.length > retried
        ? tr("Retrying {x}, resumed {n}", { x: plural(retried, "download"), n: targets.length - retried })
        : tr("Retrying {x}", { x: plural(retried, "download") })
      : tr("Resumed {x}", { x: plural(targets.length, "download") }),
    "info",
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const box = document.createElement("textarea");
      box.value = text;
      box.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
      document.body.appendChild(box);
      box.select();
      const ok = document.execCommand("copy");
      box.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

async function copySelectedLinks() {
  return copyTaskLinks(selectedTasks());
}

async function copyTaskLinks(list) {
  const links = list.map((t) => t.url).filter(Boolean);
  if (!links.length) return;
  const ok = await copyText(links.join("\n"));
  showToast(
    ok
      ? tr("Copied {x} to clipboard", { x: plural(links.length, "link") })
      : "Couldn't copy the links",
    ok ? "success" : "error",
  );
}

/** Remove is only available while nothing selected is actively downloading. */
async function removeSelected() {
  const targets = selectedTasks();
  if (!targets.length) return;
  const active = targets.filter((t) => t.status === "in_progress").length;
  if (active) {
    showToast(
      active === 1
        ? "This download is active. Pause it first (Ctrl+P), then remove it."
        : tr("{n} selected downloads are active. Pause them first (Ctrl+P), then remove.", { n: active }),
      "warning",
      4500,
    );
    return;
  }

  await removeTasks(targets);
}

/** Asks first, then drops the tasks (leftover partial files go too). Active ones are skipped. */
async function removeTasks(list) {
  const targets = list.filter((t) => t.status !== "in_progress");
  if (!targets.length) return;
  const ids = new Set(targets.map((t) => t.id));
  const choice = await showModal({
    title: "Remove Selected Tasks",
    message: tr("Are you sure you want to remove {x} from the queue?", { x: plural(ids.size, "task") }),
    buttons: [
      { key: "delete", text: "Remove", type: "danger" },
      { key: "cancel", text: "Cancel", type: "secondary" },
    ],
  });
  if (choice !== "delete") return;

  queue = queue.filter((t) => {
    if (!ids.has(t.id)) return true;
    if (t.status !== "completed" && window.api && window.api.cancelDownload)
      window.api.cancelDownload(t.id, { keepPartial: false });
    return false;
  });
  ids.forEach((id) => selectedTaskIds.delete(id));
  saveQueue();
  renderQueue();
}

/** Enter: opens the completed file(s) of the selection, else of the focused item. */
function openSelectedFiles() {
  const pool = selectedTaskIds.size
    ? selectedTasks()
    : [taskById(focusedTaskId)].filter(Boolean);
  if (!pool.length) return;
  const done = pool.filter((t) => t.status === "completed");
  if (!done.length) {
    showToast("Only completed downloads can be opened", "info");
    return;
  }
  openTasks(done);
}

/* ############################################################################
 # SECTION: queue-mouse
 # Mouse handling on the queue list.
 ############################################################################ */

/** --------------------------------------------------------------------------
 * MOUSE: click, Ctrl/Shift+click, double-click, marquee (rubber-band) selection
 * Selection happens on mouse-down (like a file manager), so a list that is
 * redrawn by a progress update can never swallow a click.
 * -------------------------------------------------------------------------- */
const MARQUEE_THRESHOLD = 4; // px before a press becomes a drag
const EDGE_ZONE = 40; // px from the list edge where auto-scroll starts
const EDGE_SPEED = 18; // max px scrolled per frame
let marquee = null;

const cardUnder = (target) =>
  target && target.closest ? target.closest(".queue-row-card") : null;

function startMarquee(e, kind, preSelection) {
  const rect = queueList.getBoundingClientRect();
  marquee = {
    kind,
    pre: preSelection, // selection before this press (kept when Shift/Ctrl is held)
    startX: e.clientX - rect.left,
    startY: e.clientY - rect.top + queueList.scrollTop,
    x: e.clientX,
    y: e.clientY,
    extend: e.shiftKey || e.ctrlKey || e.metaKey,
    active: false,
    box: null,
    raf: 0,
  };
  document.addEventListener("mousemove", onMarqueeMove);
  document.addEventListener("mouseup", endMarquee);
  window.addEventListener("blur", endMarquee);
}

function onMarqueeMove(e) {
  if (!marquee) return;
  marquee.x = e.clientX;
  marquee.y = e.clientY;
  marquee.extend = e.shiftKey || e.ctrlKey || e.metaKey;
  if (!marquee.active) {
    const rect = queueList.getBoundingClientRect();
    const dx = e.clientX - (rect.left + marquee.startX);
    const dy = e.clientY - (rect.top + marquee.startY - queueList.scrollTop);
    if (Math.hypot(dx, dy) < MARQUEE_THRESHOLD) return;
    marquee.active = true;
    marquee.box = document.createElement("div");
    marquee.box.className = "queue-marquee";
    document.body.appendChild(marquee.box);
    marquee.raf = requestAnimationFrame(marqueeFrame);
  }
}

function marqueeFrame() {
  const m = marquee;
  if (!m || !m.active) return;
  const rect = queueList.getBoundingClientRect();

  // Auto-scroll while the pointer is near (or beyond) the top / bottom edge
  let dy = 0;
  if (m.y < rect.top + EDGE_ZONE)
    dy = -Math.ceil(
      EDGE_SPEED * Math.min(1, (rect.top + EDGE_ZONE - m.y) / EDGE_ZONE),
    );
  else if (m.y > rect.bottom - EDGE_ZONE)
    dy = Math.ceil(
      EDGE_SPEED * Math.min(1, (m.y - (rect.bottom - EDGE_ZONE)) / EDGE_ZONE),
    );
  if (dy) queueList.scrollTop += dy;

  // The box in list-content coordinates (so it stays put while the list scrolls)
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const curX = clamp(m.x - rect.left, 0, queueList.clientWidth);
  const curY = clamp(
    m.y - rect.top + queueList.scrollTop,
    0,
    queueList.scrollHeight,
  );
  const box = {
    left: Math.min(m.startX, curX),
    right: Math.max(m.startX, curX),
    top: Math.min(m.startY, curY),
    bottom: Math.max(m.startY, curY),
  };

  // Draw it, clipped to the visible part of the list
  const L = Math.max(rect.left + box.left, rect.left);
  const R = Math.min(rect.left + box.right, rect.right);
  const T = Math.max(rect.top - queueList.scrollTop + box.top, rect.top);
  const B = Math.min(
    rect.top - queueList.scrollTop + box.bottom,
    rect.bottom,
  );
  Object.assign(m.box.style, {
    left: `${L}px`,
    top: `${T}px`,
    width: `${Math.max(0, R - L)}px`,
    height: `${Math.max(0, B - T)}px`,
  });

  // Everything the box touches (plus the old selection when Shift/Ctrl is held)
  const next = new Set(m.extend ? m.pre : []);
  for (const card of queueList.children) {
    const r = card.getBoundingClientRect();
    const top = r.top - rect.top + queueList.scrollTop;
    const left = r.left - rect.left;
    if (
      box.left < left + r.width &&
      box.right > left &&
      box.top < top + r.height &&
      box.bottom > top
    )
      next.add(card.dataset.taskId);
  }
  let changed = next.size !== selectedTaskIds.size;
  if (!changed)
    for (const id of next) if (!selectedTaskIds.has(id)) changed = true;
  if (changed) {
    const first = visibleIds.find((id) => next.has(id)) || null;
    setSelection(next, {
      focus:
        visibleIds.includes(focusedTaskId) && next.has(focusedTaskId)
          ? focusedTaskId
          : first,
      anchor:
        visibleIds.includes(anchorTaskId) && next.has(anchorTaskId)
          ? anchorTaskId
          : first,
    });
  }
  m.raf = requestAnimationFrame(marqueeFrame);
}

function endMarquee() {
  const m = marquee;
  if (!m) return;
  marquee = null;
  document.removeEventListener("mousemove", onMarqueeMove);
  document.removeEventListener("mouseup", endMarquee);
  window.removeEventListener("blur", endMarquee);
  cancelAnimationFrame(m.raf);
  if (m.box) m.box.remove();
  // A plain click on empty space clears the selection
  if (!m.active && m.kind === "blank" && !m.extend)
    setSelection([], { focus: null, anchor: null });
}

if (queueList) {
  queueList.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const rect = queueList.getBoundingClientRect();
    if (e.clientX > rect.left + queueList.clientWidth) return; // the scrollbar
    removeContextMenu();
    // Keyboard shortcuts must reach the list, not a text box that kept focus
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused.blur) focused.blur();
    e.preventDefault(); // no text selection or image drag while pressing / dragging

    const card = cardUnder(e.target);
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const pre = new Set(selectedTaskIds);
    if (card) {
      const id = card.dataset.taskId;
      if (e.detail >= 2 && !additive) {
        // Double-click (counted by the browser): open the finished download
        setSelection([id], { focus: id, anchor: id });
        openTask(taskById(id));
        return;
      }
      selectByPointer(id, e);
    }
    startMarquee(e, card ? "card" : "blank", pre);
  });

  queueList.addEventListener("contextmenu", (e) => {
    const card = cardUnder(e.target);
    const item = card && taskById(card.dataset.taskId);
    if (!item) return;
    if (selectedTaskIds.has(item.id)) {
      focusedTaskId = item.id;
      paintSelection();
    } else {
      setSelection([item.id], { focus: item.id, anchor: item.id });
    }
    createContextMenu(e, item);
  });
}

// Clicking anywhere outside the list clears the selection (except on the controls
// that act on it, the context menu and dialogs)
document.addEventListener("mousedown", (e) => {
  if (
    e.button !== 0 ||
    marquee ||
    (selectedTaskIds.size === 0 && !focusedTaskId)
  )
    return;
  const t = e.target;
  if (
    !t ||
    !t.closest ||
    t.closest("#queueContainer, .custom-context-menu, .custom-modal-backdrop")
  )
    return;
  const keeps = [toggleSelectAllBtn, queueSearchInput];
  if (keeps.some((el) => el && el.contains(t))) return;
  setSelection([], { focus: null, anchor: null });
});

/* ############################################################################
 # SECTION: queue-keyboard
 # Keyboard shortcuts for the queue.
 ############################################################################ */

/** --------------------------------------------------------------------------
 * KEYBOARD SHORTCUTS
 *   Enter            open completed file(s)
 *   Space            toggle the focused item
 *   Esc / Mod+Bksp   clear selection, hide context menu
 *   Mod+A            select all visible      Mod+C   copy links
 *   Mod+P            pause selected          Mod+R   resume / retry selected
 *   Mod+D (Delete)   remove selected (not while downloading)
 *   Up / Down        move focus and select   Shift+Up/Down   extend range
 *   Ctrl+Up/Down     move focus only         Home / End      first / last
 * Mod = Ctrl (Windows, Linux) or Cmd (macOS).
 * -------------------------------------------------------------------------- */
const isTypingTarget = (el) =>
  !!(
    el &&
    el.closest &&
    el.closest(
      "input, textarea, select, [contenteditable=''], [contenteditable='true']",
    )
  );

/** True while something else owns the keyboard (dialog, settings, popover, menu). */
function keyboardTaken(target) {
  return !!(
    document.querySelector(".custom-modal-backdrop") ||
    (settingsModalOverlay &&
      !settingsModalOverlay.classList.contains("hidden")) ||
    document.querySelector(".popover-panel:not(.hidden)") ||
    (target && target.closest && target.closest(".custom-context-menu"))
  );
}

function moveFocus(step, e) {
  if (!visibleIds.length) return;
  const current = visibleIds.indexOf(focusedTaskId);
  let index;
  if (step === "first") index = 0;
  else if (step === "last") index = visibleIds.length - 1;
  else if (current < 0) index = step > 0 ? 0 : visibleIds.length - 1;
  else index = Math.min(visibleIds.length - 1, Math.max(0, current + step));
  const id = visibleIds[index];
  const mod = e.ctrlKey || e.metaKey;

  if (e.shiftKey) {
    // Extend the range from the anchor (Ctrl+Shift also keeps the old selection)
    const anchor = visibleIds.includes(anchorTaskId)
      ? anchorTaskId
      : current >= 0
        ? focusedTaskId
        : id;
    const range = rangeIds(anchor, id);
    setSelection(mod ? [...selectedTaskIds, ...range] : range, {
      focus: id,
      anchor,
    });
  } else if (mod) {
    // Move the focus line only; the selection stays as it is
    focusedTaskId = id;
    paintSelection();
  } else {
    setSelection([id], { focus: id, anchor: id });
  }
  scrollToTask(id);
}

function toggleFocused() {
  if (!visibleIds.length) return;
  const id = visibleIds.includes(focusedTaskId)
    ? focusedTaskId
    : visibleIds[0];
  const next = new Set(selectedTaskIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  setSelection(next, { focus: id, anchor: id });
  scrollToTask(id);
}

/** Explicit "clear": drops the selection and the focus line, so Up/Down start afresh. */
function clearSelectionAndMenu() {
  removeContextMenu();
  setSelection([], { focus: null, anchor: null });
}

document.addEventListener("keydown", (e) => {
  const key = e.key;
  const mod = e.ctrlKey || e.metaKey;

  if (key === "Escape") {
    if (document.querySelector(".custom-modal-backdrop")) return;
    removeContextMenu();
    if (settingsModalOverlay) settingsModalOverlay.classList.add("hidden");
    // With a popover open, Esc only closes the popover
    if (!document.querySelector(".popover-panel:not(.hidden)"))
      clearSelectionAndMenu();
    return;
  }

  if (isTypingTarget(e.target) || e.altKey || keyboardTaken(e.target)) return;

  if (mod && key === "Backspace") {
    e.preventDefault();
    clearSelectionAndMenu();
    return;
  }

  if (mod && !e.shiftKey) {
    switch (key.toLowerCase()) {
      case "a":
        e.preventDefault();
        selectAllVisible();
        return;
      case "p":
        e.preventDefault();
        if (!e.repeat) pauseSelected();
        return;
      case "r":
        e.preventDefault();
        if (!e.repeat) resumeSelected();
        return;
      case "c":
        // Plain text the user highlighted elsewhere keeps its normal copy
        if (selectedTaskIds.size && !String(window.getSelection() || "")) {
          e.preventDefault();
          copySelectedLinks();
        }
        return;
      case "d":
        e.preventDefault();
        if (!e.repeat) removeSelected();
        return;
    }
  }

  const onControl =
    e.target &&
    e.target.closest &&
    e.target.closest("button, a, [role='button'], summary");

  switch (key) {
    case "ArrowDown":
      e.preventDefault();
      moveFocus(1, e);
      break;
    case "ArrowUp":
      e.preventDefault();
      moveFocus(-1, e);
      break;
    case "Home":
      e.preventDefault();
      moveFocus("first", e);
      break;
    case "End":
      e.preventDefault();
      moveFocus("last", e);
      break;
    case " ":
      if (onControl) return; // a focused button keeps its own Space
      e.preventDefault();
      if (!e.repeat) toggleFocused();
      break;
    case "Enter":
      if (onControl) return;
      e.preventDefault();
      if (!e.repeat) openSelectedFiles();
      break;
    case "Delete":
      e.preventDefault();
      if (!e.repeat) removeSelected();
      break;
  }
});

// Ctrl/Cmd+R arrives from the main process (it would otherwise reload the page)
if (window.api && window.api.onShortcut) {
  window.api.onShortcut((name) => {
    if (name !== "resume") return;
    if (
      isTypingTarget(document.activeElement) ||
      keyboardTaken(document.activeElement)
    )
      return;
    resumeSelected();
  });
}

/* ############################################################################
 # SECTION: queue-toolbar
 # The queue search box.
 ############################################################################ */

if (queueSearchInput) {
  queueSearchInput.addEventListener("input", renderQueue);
}
