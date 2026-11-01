/* ============================================================================
   i18n.js: interface language, switched instantly (no restart).
   - The texts of the app are written in English in the code and the pages. The language
     files in /Locales map each English text to its translation ("Settings": "Ajustes").
   - tr("English text", { name: value }) returns the translated text ({name} is replaced).
   - In the HTML, data-i18n marks an element whose text is translated, and data-i18n-attrs
     lists its attributes to translate (title, placeholder, aria-label).
   - i18n.setLanguage(code) loads the file, retranslates the page and fires "languageChanged"
     so the parts drawn by scripts (queue, menus, counters) can draw themselves again.
   A text missing from a language file simply stays in English.
   ========================================================================== */
(function () {
  const SUPPORTED = ["en", "es", "fr", "de", "pt"];
  const cache = { en: {} };
  let dict = {};
  let current = "en";
  let token = 0; // a slow load must not overwrite a newer choice

  const norm = (s) => String(s).replace(/\s+/g, " ").trim();

  /** Translates a text; unknown texts stay as they are. */
  function tr(text, vars) {
    let out = Object.prototype.hasOwnProperty.call(dict, text) ? dict[text] : text;
    if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    return out;
  }

  /** "system" follows the computer's language; anything unsupported falls back to English. */
  function resolve(code) {
    let c = String(code || "en");
    if (c === "system") c = (navigator.language || "en").slice(0, 2);
    c = c.toLowerCase().slice(0, 2);
    return SUPPORTED.includes(c) ? c : "en";
  }

  async function load(code) {
    if (cache[code]) return cache[code];
    let data = null;
    try {
      data = window.api && window.api.getLocale ? await window.api.getLocale(code) : null;
    } catch {}
    cache[code] = data && typeof data === "object" ? data : {};
    return cache[code];
  }

  /** Translates every marked element under `root` (also the Settings window once it is added). */
  function apply(root = document) {
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      if (el.dataset.i18nSrc === undefined) el.dataset.i18nSrc = norm(el.textContent);
      el.textContent = tr(el.dataset.i18nSrc);
    });
    root.querySelectorAll("[data-i18n-attrs]").forEach((el) => {
      for (const attr of el.dataset.i18nAttrs.split(" ")) {
        const store = "data-i18n-src-" + attr;
        if (!el.hasAttribute(store)) el.setAttribute(store, norm(el.getAttribute(attr) || ""));
        el.setAttribute(attr, tr(el.getAttribute(store)));
      }
    });
  }

  async function setLanguage(pref) {
    const code = resolve(pref);
    if (code === current && cache[code]) return;
    const mine = ++token;
    const data = await load(code);
    if (mine !== token) return;
    current = code;
    dict = data;
    document.documentElement.lang = code;
    document.title = tr("Downloads - MB Media Downloader");
    apply(document);
    window.dispatchEvent(new Event("languageChanged"));
  }

  window.tr = tr;
  window.i18n = { setLanguage, apply, current: () => current };
})();
