// Pure helpers and constants every runtime shares: loaded first by every page, every manifest content_scripts entry and
// the worker's importScripts (load-order.selftest.js checks). It reads no other file and keeps no state.
// Idempotent like limits.js.
(() => {
  if (globalThis.MdgCommon) {
    return;
  }

  const pad = (n) => String(n).padStart(2, "0");
  // The local day of ms or a Date, 2026-10-14 (toISOString's UTC day is yesterday before 8:00 in UTC+8); withTime adds
  // -0730 (exports made several times a day).
  function localDate(value = new Date(), withTime = false) {
    const d = new Date(value);
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return withTime ? `${day}-${pad(d.getHours())}${pad(d.getMinutes())}` : day;
  }

  // A file name: Obsidian's forbidden characters replaced (so wiki links to a note resolve), whitespace runs (newlines
  // too) as one space, no leading dots (Obsidian skips dotfiles), at most 120 characters, counted by code point so an
  // emoji is never cut in half; fallback when nothing is left.
  const fileName = (value, fallback = "") =>
    Array.from(String(value ?? "").replace(/[\\/:*?"<>|#^[\]]/g, "_").replace(/\s+/g, " ").replace(/^[\s.]+/, "").trim()).slice(0, 120).join("") || fallback;

  // "1:02:03" / "12:34" → seconds; -1 for anything that is not h:mm:ss digits, an empty text or segment included.
  function parseTimestamp(text) {
    const parts = String(text ?? "").split(":");
    if (parts.some((item) => !/^\s*\d+\s*$/.test(item))) {
      return -1;
    }
    return parts.reduce((total, item) => total * 60 + Number(item), 0);
  }

  // A count as sites write it: "322K", "1.2M", "1,234", "12.5万", "1.2亿", 2505 → a number; anything else → 0.
  const COUNT_UNITS = { k: 1e3, m: 1e6, b: 1e9, 千: 1e3, 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8 };
  function parseCount(text) {
    const match = String(text ?? "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([kmb千万萬亿億])?/i);
    return match ? Math.round(Number(match[1]) * (COUNT_UNITS[String(match[2] || "").toLowerCase()] || 1)) : 0;
  }

  // The extension pages a tab opens, for chrome.runtime.getURL (a page's own <a href> writes the path relative to it).
  const PAGES = Object.freeze({ triage: "triage/triage.html", history: "history/history.html" });

  // The youtubeSubtitleLang setting's targets besides "auto", with their names (the settings page lists them).
  const SUBTITLE_LANGS = Object.freeze({ "zh-Hans": "简体中文", "zh-Hant": "繁體中文", en: "English", ja: "日本語" });

  // The video page address's query parameter that asks for 专注模式 (=1): the popup's 新标签页 sets it, content.js reads
  // and strips it, and puts it back to reload into 专注模式.
  const READER_PARAM = "mdg_reader";
  // The side panel's chat port (chrome.runtime.connect): sidepanel.js opens it, background.js answers it.
  const CHAT_PORT = "sidepanel-chat";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  globalThis.MdgCommon = Object.freeze({ localDate, fileName, parseTimestamp, parseCount, sleep, PAGES, SUBTITLE_LANGS, READER_PARAM, CHAT_PORT });
})();
