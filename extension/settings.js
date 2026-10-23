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
    "生成带时间戳的笔记"
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

  // The web-page set of the three AI texts (2026-10-21, DESIGN): a page has its main text, no subtitles, comments or times.
  const WEB_PRESET_PROMPTS = Object.freeze(["列出文中的关键论据", "解释文中的专业概念", "提炼可执行的建议", "生成适合笔记的摘要"]);
  const WEB_SYSTEM_PROMPT = [
    "你是一名专业的阅读助手。",
    "基于网页正文提炼高价值信息，不要复述原文，不要输出思考过程或 think 标签。",
    "优先输出：主题与核心观点、关键论据与事实、逻辑链路与重要结论、可执行建议。",
    "回答应结构化、信息密度高、便于收藏和复习，可适当使用列表和表格。",
    "忽略导航、广告、评论区和与正文无关的内容。",
    "正文没有写到的不要猜测或编造；区分文中的事实、数据、推测与作者观点。"
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
    seenShow: "off", // one of SEEN_SHOW
    seenThreshold: SEEN_THRESHOLD.def,
    seenStyle: "badge", // one of SEEN_STYLES
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
    // The video set is the original three keys (stored values untouched); web pages read the web* keys.
    aiSystemPrompt: SYSTEM_PROMPT,
    aiPresetPrompts: PRESET_PROMPTS,
    webAiSystemPrompt: WEB_SYSTEM_PROMPT,
    webAiSummaryPrompt: "整理这篇网页的内容，输出结构化总结：主题、核心观点、关键细节、结论与可执行启发。",
    webAiPresetPrompts: WEB_PRESET_PROMPTS
  });
  const LOCAL_DEFAULTS = Object.freeze({ obsidianApiKey: "" });

  const FIXED_PROPERTY_TYPES = new Set(["text", "number", "checkbox", "list", "date"]);
  // A 自定属性 name note.js writes and the settings page accepts: letters, digits, _, - and spaces, starting with a letter,
  // digit or _ (a key like 「-评分」 would read as a YAML list item and break the block).
  const FIXED_PROPERTY_KEY_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_\-\s]*$/u;
  // Names a note writes itself, lower case: every note field, 星标's starred, a web page's published. A 自定属性 with one
  // would repeat the key, so note.js leaves it out and the settings page refuses it.
  const RESERVED_PROPERTY_KEYS = Object.freeze([...DEFAULTS.frontmatterFields, "video_tags", "starred", "published"]);
  // 正文附加段落's positions, in the settings page's order, by the names it shows.
  const NOTE_SECTION_LABELS = Object.freeze({ before_intro: "简介前", before_chapters: "章节前", before_subtitle: "字幕前" });
  const NOTE_SECTION_POSITIONS = new Set(Object.keys(NOTE_SECTION_LABELS));
  const MAX_NOTE_SECTIONS = 5;
  const MAX_PRESET_PROMPTS = 12;

  // A note field as stored: "bvid" was video_id's name before the site registry (the settings page and note.js both read it).
  const normalizeFrontmatterField = (value) => text(value).replace(/^bvid$/, "video_id");
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

  // 观看进度 (设置页「封面显示」): its legal values; anything else is DEFAULTS' 关. seenOn: the history is read and drawn.
  const SEEN_SHOW = Object.freeze(["off", "bar", "mark", "both"]);
  const normalizeSeenShow = (v) => (SEEN_SHOW.includes(v) ? v : DEFAULTS.seenShow);
  const seenOn = (v) => normalizeSeenShow(v) !== "off";
  // 观看进度's look on covers (设置页「看完了标记样式」): 角标 or 封面遮罩; anything else is DEFAULTS'.
  const SEEN_STYLES = Object.freeze(["badge", "veil"]);
  const normalizeSeenStyle = (v) => (SEEN_STYLES.includes(v) ? v : DEFAULTS.seenStyle);

  // 专注模式: each setting's legal values in stepper order (the theme button cycles them); an unknown value is DEFAULTS'.
  const READER_OPTIONS = Object.freeze({
    readerTheme: ["light", "dark", "paper"],
    readerFontScale: ["xs", "s", "m", "l", "xl"],
    readerLetterSpacing: ["tighter", "tight", "normal", "relaxed", "loose"],
    readerLineHeight: ["compact", "tight", "normal", "relaxed", "loose"],
    readerContentWidth: ["compact", "narrow", "medium", "wide", "full"]
  });
  // 专注模式's own settings: the only ones a video page saves (save-settings from a content script).
  const READER_KEYS = Object.freeze([...Object.keys(READER_OPTIONS), "readerChapterVisible"]);
  const oneOf = (key) => (value) => (READER_OPTIONS[key].includes(value) ? value : DEFAULTS[key]);
  const normalizeReaderTheme = oneOf("readerTheme");
  const normalizeReaderFontScale = oneOf("readerFontScale");
  const normalizeReaderLetterSpacing = oneOf("readerLetterSpacing");
  const normalizeReaderLineHeight = oneOf("readerLineHeight");
  const normalizeReaderContentWidth = oneOf("readerContentWidth");

  // Every on/off setting (a boolean in DEFAULTS), by its default: default on stays on unless stored false, default off
  // is on only when stored true. A non-boolean (an imported file's "true") never flips a switch away from its default.
  function normalizeSwitches(settings) {
    const out = { ...settings };
    for (const [k, def] of Object.entries(DEFAULTS)) {
      if (typeof def === "boolean") out[k] = def ? out[k] !== false : out[k] === true;
    }
    return out;
  }

  globalThis.MdgSettings = Object.freeze({
    DEFAULTS,
    FIXED_PROPERTY_KEY_RE,
    RESERVED_PROPERTY_KEYS,
    LOCAL_DEFAULTS,
    NOTE_SECTION_LABELS,
    MAX_NOTE_SECTIONS,
    MAX_PRESET_PROMPTS,
    SEEN_THRESHOLD,
    READER_OPTIONS,
    READER_KEYS,
    SEEN_SHOW,
    normalizeSeenShow,
    seenOn,
    SEEN_STYLES,
    normalizeSeenStyle,
    intIn,
    normalizeSwitches,
    normalizeSeenThreshold,
    normalizeApiKey,
    normalizeFrontmatterField,
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
