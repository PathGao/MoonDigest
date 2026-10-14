// The settings' defaults and the normalizers more than one context applies, in one place. The background owns the
// stored settings (normalizeSyncSettings); pages and the content script use DEFAULTS only when get-settings fails.
// Loaded by the content scripts (manifest), background (importScripts) and the pages, before note.js, which reads it.
// load-order.selftest.js checks every user of MdgSettings loads it first. Idempotent like limits.js.
(() => {
  if (globalThis.MdgSettings) {
    return;
  }

  // Keeps numbers ("5"); only null and undefined become "".
  const text = (value) => String(value ?? "").trim();

  // Follow-up quick questions. The one-click summary lives in playerAiQuickPrompt, so none of these summarize.
  const PRESET_PROMPTS = Object.freeze([
    "按时间顺序整理这期视频的内容",
    "根据评论总结观众的看法",
    "按章节整理视频内容",
    "生成带时间轴的笔记"
  ]);
  const SYSTEM_PROMPT = [
    "你是一名专业的视频内容分析助手。",
    "基于字幕与评论提炼高价值信息，不要复述内容，不要输出思考过程或 think 标签。",
    "优先输出：主题与核心观点、关键数据与事实、逻辑链路与重要结论、可执行建议。",
    "回答应结构化、信息密度高、便于收藏和复习，可适当使用 Emoji、列表和表格。",
    "自动过滤广告、废话和重复表达。",
    "信息不足时明确说明，不得猜测或编造；涉及专业内容时，区分事实、数据、推测与作者观点。",
    "输出时间戳时请使用普通正文格式，如 09:15、01:09:15，不要使用反引号、代码块或表格代码格式包裹时间戳。"
  ].join("\n");

  // 看到多少算看完了 (%): the range and default every reader takes (background, B站 pages, 分拣台, settings page).
  const SEEN_THRESHOLD = Object.freeze({ min: 1, max: 100, def: 80 });
  // A whole-number setting as stored or typed (every page, B站 pages and the background; TriageUi.intIn is this): empty,
  // not a number or below lo is def, the rest is rounded and capped at hi.
  const intIn = (v, lo, hi, def) => {
    const n = v == null || String(v).trim() === "" ? NaN : Math.round(Number(v));
    return Number.isFinite(n) && n >= lo ? Math.min(hi, n) : def;
  };
  const normalizeSeenThreshold = (v) => intIn(v, SEEN_THRESHOLD.min, SEEN_THRESHOLD.max, SEEN_THRESHOLD.def);

  // chrome.storage.sync. obsidianApiKey stays on this machine: LOCAL_DEFAULTS, chrome.storage.local.
  const DEFAULTS = Object.freeze({
    obsidianEnabled: false,
    noteFolder: "MoonDigest/{{site}}",
    obsidianApiBaseUrl: "http://127.0.0.1:27123",
    tags: "MoonDigest",
    downloadFormat: "srt",
    youtubeSubtitleLang: "auto",
    includeDateInFilename: true,
    includeHotCommentsInNote: false,
    includeCoverInNote: true,
    includeAiChatInNote: true,
    enablePlayerAiQuickAction: true,
    playerAiQuickPrompt: "整理这期视频的内容，输出结构化总结：主题、核心观点、关键细节、结论与可执行启发。",
    includeTimestampInBody: true,
    showBiliTriageBadges: true,
    showBiliUpTags: true,
    showBiliVerdicts: false,
    biliMarksOff: Object.freeze([]),
    seenShow: "off",
    seenThreshold: SEEN_THRESHOLD.def,
    seenStyle: "badge",
    enableDebugLogs: false,
    readerTheme: "light",
    readerFontScale: "m",
    readerLetterSpacing: "normal",
    readerLineHeight: "tight",
    readerContentWidth: "medium",
    readerChapterVisible: true,
    // The note fields on by default; note.js adds the ones a user can only turn on.
    frontmatterFields: Object.freeze(["title", "url", "site", "video_id", "cid", "author", "author_url", "upload_date", "duration", "cover", "subtitle_lang", "created", "tags"]),
    fixedFrontmatterProperties: Object.freeze([]),
    notePlaceholderSections: Object.freeze([]),
    aiSystemPrompt: SYSTEM_PROMPT,
    aiPresetPrompts: PRESET_PROMPTS
  });
  const LOCAL_DEFAULTS = Object.freeze({ obsidianApiKey: "" });

  const FIXED_PROPERTY_TYPES = new Set(["text", "number", "checkbox", "list", "date"]);
  const NOTE_SECTION_POSITIONS = new Set(["before_intro", "before_chapters", "before_subtitle"]);
  const MAX_NOTE_SECTIONS = 5;
  const MAX_PRESET_PROMPTS = 12;

  const normalizeApiKey = (value) => text(value).replace(/^Bearer\s+/i, "").trim();
  const normalizeDownloadFormat = (value) => (value === "txt" ? "txt" : "srt");
  const normalizePlayerAiQuickPrompt = (value) => text(value);
  // 快捷追问: trimmed, no blanks or repeats, at most MAX_PRESET_PROMPTS.
  const normalizeAiPresetPrompts = (value) =>
    Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))].slice(0, MAX_PRESET_PROMPTS) : [];

  function normalizeFixedPropertyType(value) {
    const type = text(value).toLowerCase();
    return FIXED_PROPERTY_TYPES.has(type) ? type : "text";
  }

  function normalizeFixedPropertyValue(type, value) {
    return normalizeFixedPropertyType(type) === "checkbox" ? text(value).toLowerCase() : text(value);
  }

  const isFixedPropertyRowEffectivelyEmpty = (type, value) => !text(value);

  function normalizeFixedFrontmatterProperties(items) {
    if (!Array.isArray(items)) {
      return [];
    }
    return items
      .map((item) => ({
        key: text(item?.key),
        type: normalizeFixedPropertyType(item?.type),
        value: normalizeFixedPropertyValue(item?.type, item?.value)
      }))
      .filter((item) => item.key && !isFixedPropertyRowEffectivelyEmpty(item.type, item.value));
  }

  function normalizeNoteSectionPosition(value) {
    const key = text(value).toLowerCase();
    return NOTE_SECTION_POSITIONS.has(key) ? key : "before_intro";
  }

  function normalizeNotePlaceholderSections(items) {
    if (!Array.isArray(items)) {
      return [];
    }
    return items
      .map((item) => ({ title: text(item?.title), position: normalizeNoteSectionPosition(item?.position), content: text(item?.content) }))
      .filter((item) => item.title)
      .slice(0, MAX_NOTE_SECTIONS);
  }

  // Reading view: an unknown value falls back to the default.
  const oneOf = (allowed, fallback) => (value) => (allowed.includes(value) ? value : fallback);
  const normalizeReaderTheme = oneOf(["light", "dark", "paper"], "light");
  const normalizeReaderFontScale = oneOf(["xs", "s", "m", "l", "xl"], "m");
  const normalizeReaderLetterSpacing = oneOf(["tighter", "tight", "normal", "relaxed", "loose"], "normal");
  const normalizeReaderLineHeight = oneOf(["compact", "tight", "normal", "relaxed", "loose"], "tight");
  const normalizeReaderContentWidth = oneOf(["compact", "narrow", "medium", "wide", "full"], "medium");

  globalThis.MdgSettings = Object.freeze({
    DEFAULTS,
    LOCAL_DEFAULTS,
    NOTE_SECTION_POSITIONS,
    MAX_NOTE_SECTIONS,
    MAX_PRESET_PROMPTS,
    SEEN_THRESHOLD,
    intIn,
    normalizeSeenThreshold,
    normalizeApiKey,
    normalizeDownloadFormat,
    normalizePlayerAiQuickPrompt,
    normalizeAiPresetPrompts,
    normalizeFixedPropertyType,
    normalizeFixedPropertyValue,
    isFixedPropertyRowEffectivelyEmpty,
    normalizeFixedFrontmatterProperties,
    normalizeNoteSectionPosition,
    normalizeNotePlaceholderSections,
    normalizeReaderTheme,
    normalizeReaderFontScale,
    normalizeReaderLetterSpacing,
    normalizeReaderLineHeight,
    normalizeReaderContentWidth
  });
})();
