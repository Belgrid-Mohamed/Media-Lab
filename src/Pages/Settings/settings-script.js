/** ============================================================================
 * SETTINGS MODAL ENGINE - src/Pages/Settings/settings-script.js
 * Every control is saved to localStorage and announced to the main window with
 * the "settingsUpdated" event; the main window reads the values when needed.
 * ========================================================================== */

(function () {
  const $ = (id) => document.getElementById(id);

  const closeBtn = $("closeSettingsModalBtn");
  const modalOverlay = $("settingsModalOverlay");
  const browseDirBtn = $("browseDirBtn");
  const openDirBtn = $("openDirBtn");
  const modalCurrentDirText = $("modalCurrentDirText");
  const modalAvailableStorageText = $("modalAvailableStorageText");
  const resetSettingsBtn = $("resetSettingsBtn");
  const exportConfigBtn = $("exportConfigBtn");
  const importConfigBtn = $("importConfigBtn");

  const sidebarButtons = document.querySelectorAll(".sidebar-item-btn");
  const tabPanels = document.querySelectorAll(".settings-section-panel");

  function readBool(key, fallback) {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "true";
  }

  function triggerSettingsUpdated() {
    localStorage.setItem("settingsUpdated", Date.now().toString());
    window.dispatchEvent(new Event("settingsUpdated"));
  }

  /** --------------------------------------------------------------------------
   * DEFINITIONS
   * -------------------------------------------------------------------------- */
  const customDropdownsMap = [
    { id: "prefLanguage", key: "prefLanguage", default: "en" },
    { id: "prefDefaultType", key: "prefDefaultType", default: "video" },
    { id: "prefVideoFormat", key: "prefFormat", default: "MP4" },
    { id: "prefVideoQuality", key: "prefQuality", default: "1080p" },
    { id: "prefAudioFormat", key: "prefAudioFormat", default: "MP3" },
    { id: "prefAudioQuality", key: "prefAudioQuality", default: "320k" },
    { id: "prefDuplicateHandling", key: "prefDuplicateHandling", default: "ask" },
    { id: "prefAudioLang", key: "prefAudioLang", default: "auto", searchable: true, first: [["original", "Original"], ["auto", "Auto"]] },
    { id: "prefSubMode", key: "prefSubMode", default: "embedded" },
    { id: "prefSubFormat", key: "prefSubFormat", default: "srt" },
    { id: "prefSubLang", key: "prefSubLang", default: "auto", searchable: true, first: [["auto", "Auto"], ["all", "All available"]] },
  ].map((d) => ({
    ...d,
    wrapperId: `${d.id}Wrapper`,
    btnId: `${d.id}Btn`,
    menuId: `${d.id}Menu`,
    labelId: `${d.id}Label`,
  }));

  /** Every language offered by the two searchable dropdowns (code, name). */
  const LANGUAGES = [
    ["af","Afrikaans"],["sq","Albanian"],["am","Amharic"],["ar","Arabic"],["hy","Armenian"],["az","Azerbaijani"],
    ["eu","Basque"],["be","Belarusian"],["bn","Bengali"],["bs","Bosnian"],["bg","Bulgarian"],["my","Burmese"],
    ["ca","Catalan"],["zh","Chinese"],["hr","Croatian"],["cs","Czech"],["da","Danish"],["nl","Dutch"],
    ["en","English"],["et","Estonian"],["fil","Filipino"],["fi","Finnish"],["fr","French"],["gl","Galician"],
    ["ka","Georgian"],["de","German"],["el","Greek"],["gu","Gujarati"],["ha","Hausa"],["he","Hebrew"],
    ["hi","Hindi"],["hu","Hungarian"],["is","Icelandic"],["id","Indonesian"],["ga","Irish"],["it","Italian"],
    ["ja","Japanese"],["jv","Javanese"],["kn","Kannada"],["kk","Kazakh"],["km","Khmer"],["ko","Korean"],
    ["ku","Kurdish"],["ky","Kyrgyz"],["lo","Lao"],["lv","Latvian"],["lt","Lithuanian"],["mk","Macedonian"],
    ["ms","Malay"],["ml","Malayalam"],["mt","Maltese"],["mr","Marathi"],["mn","Mongolian"],["ne","Nepali"],
    ["no","Norwegian"],["fa","Persian"],["pl","Polish"],["pt","Portuguese"],["pa","Punjabi"],["ro","Romanian"],
    ["ru","Russian"],["sr","Serbian"],["si","Sinhala"],["sk","Slovak"],["sl","Slovenian"],["so","Somali"],
    ["es","Spanish"],["sw","Swahili"],["sv","Swedish"],["ta","Tamil"],["te","Telugu"],["th","Thai"],
    ["tr","Turkish"],["uk","Ukrainian"],["ur","Urdu"],["uz","Uzbek"],["vi","Vietnamese"],["cy","Welsh"],
    ["zu","Zulu"],
  ];

  const preferencesMap = [
    { id: "prefRememberWinSize", type: "checkbox", default: true },
    { id: "prefPreventSleep", type: "checkbox", default: false },
    { id: "prefMinimizeToTray", type: "checkbox", default: false },
    { id: "prefStartMinimized", type: "checkbox", default: false },
    { id: "prefAutoUpdate", type: "checkbox", default: true },
    { id: "prefAlwaysAskDir", type: "checkbox", default: false },
    { id: "prefMaxConcurrent", type: "value", default: "3" },
    { id: "prefAutoRetry", type: "checkbox", default: true },
    { id: "prefMaxRetries", type: "value", default: "3" },
    { id: "prefAutoDetect", type: "checkbox", default: true },
    { id: "prefAutoDownloadCopied", type: "checkbox", default: false },
    { id: "prefRestrictPlatforms", type: "checkbox", default: false },
    { id: "prefPlaylistSubfolder", type: "checkbox", default: true },
    { id: "prefTrackPrefix", type: "checkbox", default: false },
    { id: "prefGroupPlaylist", type: "checkbox", default: false },
    { id: "prefChapters", type: "checkbox", default: false },
    { id: "prefCaptions", type: "checkbox", default: false },
    { id: "prefSubAuto", type: "checkbox", default: true },
    { id: "prefEmbedThumb", type: "checkbox", default: false },
  ].map((p) => ({ ...p, key: p.id }));

  /** --------------------------------------------------------------------------
   * STORAGE / DIRECTORY
   * -------------------------------------------------------------------------- */
  function formatDiskSize(bytes) {
    const gb = bytes / 1024 ** 3;
    return gb >= 1024 ? `${(gb / 1024).toFixed(2)} TB` : `${gb.toFixed(1)} GB`;
  }

  async function currentDownloadDir() {
    let dir = localStorage.getItem("downloadDir");
    if (!dir && window.api && window.api.getDefaultDownloadDir) {
      try {
        dir = await window.api.getDefaultDownloadDir();
      } catch {}
    }
    return dir || "";
  }

  async function refreshDirectoryInfo() {
    const dir = await currentDownloadDir();
    if (modalCurrentDirText) {
      modalCurrentDirText.textContent = dir || "Default Downloads Folder";
      modalCurrentDirText.title = dir;
    }
    if (!modalAvailableStorageText) return;
    modalAvailableStorageText.textContent = "…";
    let text = "Unknown";
    if (window.api && window.api.getDiskSpace) {
      try {
        const info = await window.api.getDiskSpace(dir);
        if (info && Number.isFinite(info.free))
          text = formatDiskSize(info.free);
      } catch {}
    }
    modalAvailableStorageText.textContent = text;
  }

  if (browseDirBtn) {
    browseDirBtn.addEventListener("click", async () => {
      if (!(window.api && window.api.selectFolder)) return;
      const folder = await window.api.selectFolder(await currentDownloadDir());
      if (folder) {
        localStorage.setItem("downloadDir", folder);
        await refreshDirectoryInfo();
        triggerSettingsUpdated();
      }
    });
  }

  if (openDirBtn) {
    openDirBtn.addEventListener("click", async () => {
      if (!(window.api && window.api.openFolder)) return;
      const res = await window.api.openFolder(await currentDownloadDir());
      if (res && !res.ok && modalAvailableStorageText) {
        modalAvailableStorageText.textContent = "Folder unavailable";
      }
    });
  }

  /** --------------------------------------------------------------------------
   * SIDEBAR TAB NAVIGATION + CLOSE
   * -------------------------------------------------------------------------- */
  sidebarButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      sidebarButtons.forEach((b) => b.classList.remove("active"));
      tabPanels.forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const panel = $(`tab-${btn.dataset.tab}`);
      if (panel) panel.classList.add("active");
    });
  });

  if (closeBtn)
    closeBtn.addEventListener("click", () => {
      if (modalOverlay) modalOverlay.classList.add("hidden");
    });

  /** --------------------------------------------------------------------------
   * SUB-FEATURES: a row with data-requires="prefA prefB=x|y" is only shown while
   * every listed parent is on (toggle checked) or holds one of the listed values.
   * -------------------------------------------------------------------------- */
  function parentHolds(spec) {
    const [id, vals] = spec.split("=");
    if (vals === undefined) {
      const el = $(id);
      return !!(el && el.checked);
    }
    const d = customDropdownsMap.find((x) => x.id === id);
    const current = localStorage.getItem(d ? d.key : id) || (d ? d.default : "");
    return vals.split("|").includes(current);
  }

  function updateDependencies() {
    document
      .querySelectorAll(".settings-modal-container [data-requires]")
      .forEach((row) => {
        const ok = row.dataset.requires.split(/\s+/).filter(Boolean).every(parentHolds);
        row.classList.toggle("hidden", !ok);
        if (!ok) {
          row.querySelectorAll(".custom-select-menu").forEach((m) => m.classList.add("hidden"));
          row.querySelectorAll(".custom-select-wrapper").forEach((w) => w.classList.remove("open"));
        }
      });
  }

  /** --------------------------------------------------------------------------
   * THEME TOGGLE (System / Dark / Light)
   * -------------------------------------------------------------------------- */
  function syncTheme() {
    const val = localStorage.getItem("prefTheme") || "dark";
    document.querySelectorAll("#prefThemeToggle .theme-opt").forEach((b) => {
      const on = b.dataset.value === val;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
  }
  const themeToggle = $("prefThemeToggle");
  if (themeToggle)
    themeToggle.addEventListener("click", (e) => {
      const b = e.target.closest(".theme-opt");
      if (!b) return;
      localStorage.setItem("prefTheme", b.dataset.value);
      syncTheme();
      triggerSettingsUpdated();
    });

  /** The searchable dropdowns (audio track, subtitle language) get their options here. */
  function buildLanguageMenu(d) {
    const menu = $(d.menuId);
    if (!menu || menu.dataset.built) return;
    menu.dataset.built = "1";
    const search = document.createElement("input");
    search.type = "text";
    search.className = "custom-select-search";
    search.placeholder = "Search language…";
    search.setAttribute("aria-label", "Search language");
    menu.appendChild(search);
    const list = document.createElement("div");
    list.className = "custom-select-list";
    [...d.first, ...LANGUAGES].forEach(([value, name]) => {
      const o = document.createElement("div");
      o.className = "custom-select-option";
      o.dataset.value = value;
      o.textContent = name;
      list.appendChild(o);
    });
    menu.appendChild(list);
    const empty = document.createElement("div");
    empty.className = "custom-select-empty hidden";
    empty.textContent = "No language found";
    menu.appendChild(empty);
    search.addEventListener("click", (e) => e.stopPropagation());
    search.addEventListener("input", () => {
      const needle = search.value.trim().toLowerCase();
      let shown = 0;
      list.querySelectorAll(".custom-select-option").forEach((o) => {
        const hit = !needle || o.textContent.toLowerCase().includes(needle) || o.dataset.value.toLowerCase() === needle;
        o.classList.toggle("hidden", !hit);
        if (hit) shown++;
      });
      empty.classList.toggle("hidden", shown > 0);
    });
  }

  /** --------------------------------------------------------------------------
   * CUSTOM DROPDOWNS (events bound once, `sync` re-reads the stored value)
   * -------------------------------------------------------------------------- */
  function closeAllMenus() {
    document
      .querySelectorAll(".settings-modal-container .custom-select-menu")
      .forEach((m) => m.classList.add("hidden"));
    document
      .querySelectorAll(".settings-modal-container .custom-select-wrapper")
      .forEach((w) => w.classList.remove("open"));
  }

  const dropdownSyncers = [];

  function setupCustomDropdown(d) {
    const wrapper = $(d.wrapperId);
    const btn = $(d.btnId);
    const menu = $(d.menuId);
    const label = $(d.labelId);
    if (!wrapper || !btn || !menu) return;
    if (d.searchable) buildLanguageMenu(d);

    const items = menu.querySelectorAll(".custom-select-option");

    function sync() {
      const val = localStorage.getItem(d.key) || d.default;
      let matched = null;
      items.forEach((item) => {
        const hit = item.dataset.value === val;
        item.classList.toggle("selected", hit);
        if (hit) matched = item;
      });
      if (!matched && items.length) {
        matched = items[0];
        matched.classList.add("selected");
      }
      if (label && matched) label.innerHTML = matched.innerHTML.trim();
    }
    dropdownSyncers.push(sync);
    sync();

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (wrapper.classList.contains("disabled")) return;
      const wasOpen = !menu.classList.contains("hidden");
      closeAllMenus();
      if (!wasOpen) {
        menu.classList.remove("hidden");
        wrapper.classList.add("open");
        const search = menu.querySelector(".custom-select-search");
        if (search) {
          search.value = "";
          search.dispatchEvent(new Event("input"));
          search.focus();
          const sel = menu.querySelector(".custom-select-option.selected");
          if (sel) sel.scrollIntoView({ block: "nearest" });
        }
      }
    });

    menu.addEventListener("click", (e) => {
      const item = e.target.closest(".custom-select-option");
      if (!item) return;
      localStorage.setItem(d.key, item.dataset.value);
      sync();
      updateDependencies();
      menu.classList.add("hidden");
      wrapper.classList.remove("open");
      triggerSettingsUpdated();
    });
  }

  document.addEventListener("click", closeAllMenus);

  /** --------------------------------------------------------------------------
   * TOGGLES / INPUTS
   * -------------------------------------------------------------------------- */
  function updateRangeBadge() {
    const rangeEl = $("prefMaxConcurrent");
    const badgeEl = $("maxTasksBadge");
    if (rangeEl && badgeEl)
      badgeEl.textContent = `${rangeEl.value} Task${rangeEl.value === "1" ? "" : "s"}`;
  }

  function syncPreferences() {
    preferencesMap.forEach((item) => {
      const el = $(item.id);
      if (!el) return;
      if (item.type === "checkbox") {
        el.checked = readBool(item.key, item.default);
      } else {
        el.value = localStorage.getItem(item.key) || item.default;
      }
      el.classList.remove("invalid");
    });
    updateRangeBadge();
    syncTheme();
    updateDependencies();
  }

  function bindPreferences() {
    preferencesMap.forEach((item) => {
      const el = $(item.id);
      if (!el) return;

      if (item.type === "checkbox") {
        el.addEventListener("change", () => {
          localStorage.setItem(item.key, el.checked);
          updateDependencies();
          triggerSettingsUpdated();
        });
        return;
      }

      const save = () => {
        localStorage.setItem(item.key, el.value);
        triggerSettingsUpdated();
      };
      el.addEventListener("change", save);
      el.addEventListener("input", () => {
        if (item.id === "prefMaxConcurrent") updateRangeBadge();
        save();
      });
    });
  }

  /** --------------------------------------------------------------------------
   * EXPORT / IMPORT / RESET
   * -------------------------------------------------------------------------- */
  const SETTING_KEY = /^pref[A-Za-z0-9]{1,60}$/;

  function collectSettings() {
    const settings = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (SETTING_KEY.test(key) || key === "downloadDir")
        settings[key] = localStorage.getItem(key);
    }
    return settings;
  }

  if (exportConfigBtn) {
    exportConfigBtn.addEventListener("click", () => {
      const data = {
        app: "mb-media-downloader",
        version: 1,
        settings: collectSettings(),
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mb-media-downloader-settings.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  if (importConfigBtn) {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".json,application/json";
    fileInput.className = "hidden";
    document.body.appendChild(fileInput);

    importConfigBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const parsed = JSON.parse(reader.result);
          const settings = parsed && parsed.settings;
          if (!settings || typeof settings !== "object")
            throw new Error("bad file");
          Object.entries(settings).forEach(([key, value]) => {
            const ok = SETTING_KEY.test(key) || key === "downloadDir";
            if (ok && typeof value === "string" && value.length <= 2000)
              localStorage.setItem(key, value);
          });
          syncAll();
          triggerSettingsUpdated();
        } catch {
          if (modalAvailableStorageText)
            modalAvailableStorageText.textContent = "Invalid settings file";
        }
        fileInput.value = "";
      };
      reader.readAsText(file);
    });
  }

  if (resetSettingsBtn) {
    resetSettingsBtn.addEventListener("click", () => {
      const doomed = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (SETTING_KEY.test(key) || key === "downloadDir") doomed.push(key);
      }
      doomed.forEach((k) => localStorage.removeItem(k));
      syncAll();
      triggerSettingsUpdated();
    });
  }

  /** --------------------------------------------------------------------------
   * START
   * -------------------------------------------------------------------------- */
  function syncAll() {
    dropdownSyncers.forEach((fn) => fn());
    syncPreferences();
    refreshDirectoryInfo();
  }

  customDropdownsMap.forEach(setupCustomDropdown);
  bindPreferences();
  syncAll();

  // The main window asks for a refresh when the modal is shown again
  window.addEventListener("settingsRefresh", syncAll);
})();
