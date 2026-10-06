const DEFAULT_PRESET_PROMPTS = [
  "按时间顺序整理这期视频的内容",
  "根据评论总结观众的看法",
  "按章节整理视频内容",
  "生成带时间轴的笔记"
];
const DEFAULT_PLAYER_AI_QUICK_PROMPT = "整理这期视频的内容，输出结构化总结：主题、核心观点、关键细节、结论与可执行启发。";
const DEFAULT_AI_SYSTEM_PROMPT = [
  "你是一名专业的视频内容分析助手。",
  "基于字幕与评论提炼高价值信息，不要复述内容，不要输出思考过程或 think 标签。",
  "优先输出：主题与核心观点、关键数据与事实、逻辑链路与重要结论、可执行建议。",
  "回答应结构化、信息密度高、便于收藏和复习，可适当使用 Emoji、列表和表格。",
  "自动过滤广告、废话和重复表达。",
  "信息不足时明确说明，不得猜测或编造；涉及专业内容时，区分事实、数据、推测与作者观点。",
  "输出时间戳时请使用普通正文格式，如 09:15、01:09:15，不要使用反引号、代码块或表格代码格式包裹时间戳。"
].join("\n");

const DEFAULT_SETTINGS = {
  obsidianEnabled: false,
  noteFolder: "MoonDigest/{{site}}",
  obsidianApiBaseUrl: "http://127.0.0.1:27123",
  obsidianApiKey: "",
  tags: "MoonDigest",
  downloadFormat: "srt",
  youtubeSubtitleLang: "auto",
  includeDateInFilename: true,
  includeHotCommentsInNote: false,
  includeCoverInNote: true,
  includeAiChatInNote: true,
  enablePlayerAiQuickAction: true,
  playerAiQuickPrompt: DEFAULT_PLAYER_AI_QUICK_PROMPT,
  includeTimestampInBody: true,
  showBiliTriageBadges: true,
  seenShow: "off",
  seenThreshold: 80,
  seenStyle: "badge",
  enableDebugLogs: false,
  frontmatterFields: [
    "title",
    "url",
    "site",
    "video_id",
    "cid",
    "author",
    "author_url",
    "upload_date",
    "duration",
    "cover",
    "subtitle_lang",
    "created",
    "tags"
  ],
  fixedFrontmatterProperties: [],
  notePlaceholderSections: [],
  aiSystemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
  aiPresetPrompts: DEFAULT_PRESET_PROMPTS.slice()
};

const CUSTOM_PROPERTY_KEY_PATTERN = /^[\p{L}\p{N}_\-\s]+$/u;
const FIXED_PROPERTY_TYPES = new Set(["text", "number", "checkbox", "list", "date"]);
const FRONTMATTER_TEMPLATE_TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/;
const FRONTMATTER_DATE_VALUE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_SECTION_POSITIONS = new Set(["before_intro", "before_chapters", "before_subtitle"]);
const MAX_NOTE_PLACEHOLDER_SECTIONS = 5;

const AI_PRESETS = [
  { id: "openai_compat", name: "OpenAI 兼容", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", requiresKey: true },
  { id: "deepseek",      name: "DeepSeek",    baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", requiresKey: true },
  { id: "zhipu",         name: "智谱 GLM",    baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", requiresKey: true },
  { id: "minimax",       name: "MiniMax",     baseUrl: "https://api.minimaxi.com/v1", model: "", requiresKey: true },
  { id: "moonshot",      name: "Moonshot",    baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", requiresKey: true },
  { id: "openrouter",    name: "OpenRouter",  baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", requiresKey: true },
  { id: "ollama",        name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1", model: "", requiresKey: false },
  { id: "custom",        name: "自定义",      baseUrl: "", model: "", requiresKey: true }
];

const elements = {
  obsidianEnabled: document.getElementById("obsidianEnabled"),
  noteFolder: document.getElementById("noteFolder"),
  obsidianApiBaseUrl: document.getElementById("obsidianApiBaseUrl"),
  obsidianApiKey: document.getElementById("obsidianApiKey"),
  tags: document.getElementById("tags"),
  downloadFormat: document.getElementById("downloadFormat"),
  youtubeSubtitleLang: document.getElementById("youtubeSubtitleLang"),
  includeDateInFilename: document.getElementById("includeDateInFilename"),
  includeHotCommentsInNote: document.getElementById("includeHotCommentsInNote"),
  includeCoverInNote: document.getElementById("includeCoverInNote"),
  includeAiChatInNote: document.getElementById("includeAiChatInNote"),
  storageLimits: document.getElementById("storageLimits"),
  enablePlayerAiQuickAction: document.getElementById("enablePlayerAiQuickAction"),
  playerAiQuickPrompt: document.getElementById("playerAiQuickPrompt"),
  includeTimestampInBody: document.getElementById("includeTimestampInBody"),
  showBiliTriageBadges: document.getElementById("showBiliTriageBadges"),
  seenShow: document.getElementById("seenShow"),
  seenThreshold: document.getElementById("seenThreshold"),
  seenStyle: document.getElementById("seenStyle"),
  enableDebugLogs: document.getElementById("enableDebugLogs"),
  frontmatterFields: document.querySelectorAll('input[name="frontmatterField"]'),
  fixedPropertiesList: document.getElementById("fixedPropertiesList"),
  fixedPropertiesEmpty: document.getElementById("fixedPropertiesEmpty"),
  addFixedPropertyBtn: document.getElementById("addFixedPropertyBtn"),
  noteSectionsList: document.getElementById("noteSectionsList"),
  noteSectionsEmpty: document.getElementById("noteSectionsEmpty"),
  addNoteSectionBtn: document.getElementById("addNoteSectionBtn"),
  aiProvidersHead: document.getElementById("aiProvidersHead"),
  aiProvidersList: document.getElementById("aiProvidersList"),
  aiPromptRows: document.getElementById("aiPromptRows"),
  aiPromptsLater: document.getElementById("aiPromptsLater"),
  addAiProviderBtn: document.getElementById("addAiProviderBtn"),
  aiSystemPrompt: document.getElementById("aiSystemPrompt"),
  aiPresetPrompts: document.getElementById("aiPresetPrompts"),
  saveBar: document.getElementById("saveBar"),
  unsavedHint: document.getElementById("unsavedHint"),
  saveBtn: document.getElementById("saveBtn"),
  testConnectionBtn: document.getElementById("testConnectionBtn"),
  status: document.getElementById("status"),
  hostPermissionBanner: document.getElementById("hostPermissionBanner"),
  hostPermissionText: document.getElementById("hostPermissionText"),
  hostPermissionBtn: document.getElementById("hostPermissionBtn"),
  unsavedWhere: document.getElementById("unsavedWhere"),
  toc: document.getElementById("toc"),
  aiPill: document.getElementById("aiPill"),
  aiSectionPill: document.getElementById("aiSectionPill"),
  obsidianPill: document.getElementById("obsidianPill"),
  noAiNote: document.getElementById("noAiNote"),
  obsidianGuide: document.getElementById("obsidianGuide"),
  obsidianKeyTag: document.getElementById("obsidianKeyTag"),
  obsidianTestResult: document.getElementById("obsidianTestResult"),
  filenameSample: document.getElementById("filenameSample")
};

// Form state keys that are not an element id, mapped to the element whose section they belong to.
const STATE_KEY_NODES = {
  frontmatterFields: elements.frontmatterFields[0],
  fixedFrontmatterProperties: elements.fixedPropertiesList,
  notePlaceholderSections: elements.noteSectionsList,
  providers: elements.aiProvidersList
};

// The form differs from what was last loaded or saved; a passed provider test reminds the user to save.
let hasUnsavedChanges = false;
let savedForm = null;
// The last Obsidian test passed; the header says 「已连接」 only after that.
let obsidianConnected = false;

init();

function init() {
  loadSettings();
  ["input", "change"].forEach((type) => document.addEventListener(type, syncUnsaved));
  window.addEventListener("beforeunload", (event) => {
    if (hasUnsavedChanges) {
      event.preventDefault();
    }
  });
  elements.saveBtn.addEventListener("click", saveSettings);
  elements.seenShow.addEventListener("change", syncSeenRows);
  elements.testConnectionBtn.addEventListener("click", testConnection);
  elements.addFixedPropertyBtn.addEventListener("click", () => addFixedPropertyRow());
  elements.addNoteSectionBtn.addEventListener("click", () => addNoteSectionRow());
  elements.addAiProviderBtn.addEventListener("click", () => {
    addAiProviderRow();
    syncUnsaved();
  });
  elements.obsidianEnabled.addEventListener("change", syncObsidianBody);
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest(".fixed-property-type-picker")) {
      closeAllFixedPropertyMenus();
    }
  });
  [elements.noteFolder, elements.obsidianApiBaseUrl, elements.obsidianApiKey, elements.tags].forEach((input) => {
    input?.addEventListener("input", () => input.classList.remove("input-error"));
  });
  elements.obsidianApiKey.addEventListener("input", syncObsidianKeyTag);
  // Focuses an open triage tab instead of a second one.
  document.querySelector('a.jump[href$="triage.html"]')?.addEventListener("click", async (event) => {
    event.preventDefault();
    const r = await chrome.runtime.sendMessage({ type: "triage-open" }).catch(() => null);
    if (!r?.ok) chrome.tabs.create({ url: chrome.runtime.getURL("triage/triage.html") });
  });
  document.querySelectorAll(".var[data-var]").forEach((button) => {
    button.addEventListener("click", () => {
      const folder = elements.noteFolder.value.trim().replace(/\/+$/, "");
      elements.noteFolder.value = (folder ? `${folder}/` : "") + button.dataset.var;
      elements.noteFolder.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
  elements.filenameSample.textContent = `${new Date().toLocaleDateString("sv-SE")}-视频标题.md`;
  trackCurrentSection();
}

// Marks the section list entry for the section at the top of the window.
function trackCurrentSection() {
  const links = Array.from(elements.toc.querySelectorAll("a"));
  const setCurrent = (id) => links.forEach((link) => link.setAttribute("aria-current", String(link.hash === `#${id}`)));
  setCurrent("basic");
  const observer = new IntersectionObserver(
    (entries) => entries.forEach((entry) => entry.isIntersecting && setCurrent(entry.target.id)),
    { rootMargin: "-80px 0px -70% 0px" }
  );
  document.querySelectorAll("section.sec").forEach((section) => observer.observe(section));
}

async function renderStorageLimits() {
  const all = await chrome.storage.local.get(null).catch(() => ({}));
  elements.storageLimits.replaceChildren(
    ...BocLimits.describe(BocLimits.storageUsage(all)).map((row) => {
      const tr = document.createElement("tr");
      const label = document.createElement("th");
      label.textContent = row.label;
      const usage = document.createElement("td");
      usage.className = "use";
      usage.textContent = row.usage;
      const rule = document.createElement("td");
      rule.className = "rule";
      rule.textContent = row.rule;
      tr.append(label, usage, rule);
      return tr;
    })
  );
}

async function loadSettings() {
  const settings = await getSettings();
  void renderStorageLimits();
  elements.obsidianEnabled.checked = settings.obsidianEnabled === true;
  syncObsidianBody();
  elements.noteFolder.value = settings.noteFolder || "";
  elements.obsidianApiBaseUrl.value = settings.obsidianApiBaseUrl || "";
  elements.obsidianApiKey.value = settings.obsidianApiKey || "";
  elements.tags.value = settings.tags || "";
  elements.downloadFormat.value = normalizeDownloadFormat(settings.downloadFormat);
  elements.youtubeSubtitleLang.value = settings.youtubeSubtitleLang || "auto";
  elements.includeDateInFilename.checked = settings.includeDateInFilename !== false;
  elements.includeHotCommentsInNote.checked = Boolean(settings.includeHotCommentsInNote);
  elements.includeCoverInNote.checked = settings.includeCoverInNote !== false;
  elements.includeAiChatInNote.checked = settings.includeAiChatInNote !== false;
  elements.enablePlayerAiQuickAction.checked = Boolean(settings.enablePlayerAiQuickAction);
  elements.playerAiQuickPrompt.value = String(settings.playerAiQuickPrompt || "");
  elements.includeTimestampInBody.checked = Boolean(settings.includeTimestampInBody);
  elements.showBiliTriageBadges.checked = settings.showBiliTriageBadges !== false;
  elements.seenShow.value = ["bar", "mark", "both"].includes(settings.seenShow) ? settings.seenShow : "off";
  syncSeenRows();
  elements.seenThreshold.value = String(settings.seenThreshold || 80);
  elements.seenStyle.value = settings.seenStyle === "veil" ? "veil" : "badge";
  elements.enableDebugLogs.checked = Boolean(settings.enableDebugLogs);
  // "bvid" was the field name before the site registry.
  const selectedFields = new Set((settings.frontmatterFields || DEFAULT_SETTINGS.frontmatterFields).map((field) => (field === "bvid" ? "video_id" : field)));
  elements.frontmatterFields.forEach((checkbox) => {
    checkbox.checked = selectedFields.has(checkbox.value);
  });
  renderFixedPropertyRows(settings.fixedFrontmatterProperties);
  renderNoteSectionRows(settings.notePlaceholderSections);
  elements.aiSystemPrompt.value = settings.aiSystemPrompt || "";
  elements.aiPresetPrompts.value = (Array.isArray(settings.aiPresetPrompts) ? settings.aiPresetPrompts : []).join("\n");

  const providers = await loadAiProviders();
  renderAiProviders(providers);
  renderHostPermissionBanner(hostPermissionUrls(settings, providers));
  markSaved();
}

// 看多少算看完了 and the mark style only matter while the mark is shown.
function syncSeenRows() {
  const mark = elements.seenShow.value === "mark" || elements.seenShow.value === "both";
  document.querySelectorAll("[data-seen-mark-row]").forEach((row) => (row.hidden = !mark));
}

async function saveSettings() {
  clearInputErrors();
  const payload = collectFormPayload();
  const validation = validateSettings(payload, { requireApiKey: false });
  if (!validation.ok) {
    applyValidationError(validation);
    return;
  }
  const aiProvidersPayload = collectAiProviders();
  const aiProvidersValidation = validateAiProviders(aiProvidersPayload);
  if (!aiProvidersValidation.ok) {
    applyValidationError(aiProvidersValidation);
    return;
  }

  // Remote hosts are optional permissions; the save click is the user gesture that may request them.
  const hostUrls = hostPermissionUrls(payload, aiProvidersPayload);
  const deniedHosts = await requestHostPermissions(hostUrls);

  setBusy(elements.saveBtn);
  setStatus("正在保存…", false, true);
  try {
    const resp = await sendRuntimeMessage({ type: "save-settings", settings: payload });
    if (!resp?.ok) {
      setStatus(resp?.error || "保存失败", true);
      return;
    }
    renderFixedPropertyRows(payload.fixedFrontmatterProperties);
    renderNoteSectionRows(payload.notePlaceholderSections);

    // AI 平台：list 走 sync、apiKey 走 local
    const aiResp = await sendRuntimeMessage({ type: "ai-providers-save", providers: aiProvidersPayload });
    if (!aiResp?.ok) {
      setStatus(`已保存，但 AI 平台保存失败：${aiResp?.error || "未知错误"}`, true);
      return;
    }
    // 用最新列表（含 hasSavedKey）重新渲染，避免误以为 Key 丢了
    renderAiProviders(aiResp.providers || []);
    markSaved();
    renderHostPermissionBanner(hostUrls);
    if (deniedHosts.length) {
      setStatus(`已保存，但未授权访问 ${deniedHosts.join("、")}，相关请求会失败；重新保存可再次授权`, true);
      return;
    }
    setStatus(
      payload.obsidianEnabled && !payload.obsidianApiKey
        ? "保存成功（未填写 Local REST API Key，暂不可写入 Obsidian）"
        : "保存成功"
    );
  } catch (error) {
    setStatus(error.message || "保存失败", true);
  } finally {
    setBusy(null);
  }
}

async function getSettings() {
  try {
    const resp = await sendRuntimeMessage({ type: "get-settings" });
    if (!resp?.ok) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...(resp.settings || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function setStatus(text, isError = false, busy = false) {
  elements.status.textContent = text;
  elements.status.dataset.error = isError ? "true" : "false";
  elements.status.setAttribute("aria-busy", String(busy));
  syncSaveBar();
}

// One sticky bar: shown while there are unsaved edits or a status to read; save is clickable only with edits.
function setUnsaved(value) {
  hasUnsavedChanges = value;
  if (value) setStatus("");
  syncSaveBar();
}

// Compares content, so an edit that is undone (add a row, then remove it) is not "unsaved".
function readFormState() {
  return { payload: readFormPayload(), providers: collectAiProviders() };
}

function markSaved() {
  savedForm = readFormState();
  syncUnsaved();
  renderSavedState();
}

// The sections whose content differs from the saved copy; a key with no section still counts as a change.
function changedSections() {
  if (!savedForm) return [];
  const flat = (state) => ({ ...state.payload, providers: state.providers });
  const now = flat(readFormState());
  const saved = flat(savedForm);
  const changed = new Set();
  for (const key of Object.keys(now)) {
    if (JSON.stringify(now[key]) !== JSON.stringify(saved[key])) {
      changed.add((STATE_KEY_NODES[key] || elements[key])?.closest?.("section.sec") || null);
    }
  }
  return Array.from(changed);
}

function syncUnsaved() {
  const changed = changedSections();
  elements.toc.querySelectorAll("a").forEach((link) => {
    link.querySelector(".dot").hidden = !changed.some((section) => section && link.hash === `#${section.id}`);
  });
  const names = Array.from(document.querySelectorAll("section.sec"), (section) => changed.includes(section) && section.dataset.name).filter(Boolean);
  elements.unsavedWhere.textContent = names.length ? `：${names.join("、")}` : "";
  setUnsaved(changed.length > 0);
}

// Deleting a provider is written right away, so the saved copy follows.
function updateSavedProviders(update) {
  if (savedForm) {
    savedForm.providers = update(savedForm.providers);
  }
  syncUnsaved();
  renderSavedState();
}

// Header pills, the no-AI note and the Obsidian guide follow what is saved, not what is being typed.
function renderSavedState() {
  const providers = savedForm.providers;
  const aiReady = providers.length > 0;
  elements.noAiNote.hidden = aiReady;
  setPill(elements.aiPill, aiReady, aiReady ? `AI · ${providers[0].name}` : "AI 未配置");
  setPill(elements.aiSectionPill, aiReady, aiReady ? `已配置 ${providers.length} 个平台` : "没配也能用");

  const { obsidianEnabled, obsidianApiKey } = savedForm.payload;
  const obsidianText = !obsidianEnabled ? "Obsidian 关" : !obsidianApiKey ? "Obsidian 待填 Key" : obsidianConnected ? "Obsidian 已连接" : "Obsidian 已开";
  setPill(elements.obsidianPill, obsidianEnabled && Boolean(obsidianApiKey), obsidianText);
  elements.obsidianPill.classList.toggle("off", !obsidianEnabled);

  // Open for first-time setup; once a key is saved it folds to one line. Only flips when that changes, so a guide the user opened stays open.
  const firstSetup = !obsidianApiKey;
  if (elements.obsidianGuide.classList.contains("first") !== firstSetup) {
    elements.obsidianGuide.classList.toggle("first", firstSetup);
    elements.obsidianGuide.open = firstSetup;
  }
  syncObsidianKeyTag();
}

function setPill(node, ok, text) {
  node.textContent = text;
  node.classList.toggle("ok", ok);
  node.classList.toggle("off", !ok);
}

function syncObsidianKeyTag() {
  const saved = savedForm?.payload.obsidianApiKey;
  elements.obsidianKeyTag.hidden = !saved || normalizeApiKey(elements.obsidianApiKey.value) !== saved;
}

function syncSaveBar() {
  elements.saveBar.hidden = !hasUnsavedChanges && !elements.status.textContent;
  elements.unsavedHint.hidden = !hasUnsavedChanges;
  elements.saveBtn.hidden = !hasUnsavedChanges;
}

function normalizeDownloadFormat(value) {
  return value === "txt" ? "txt" : "srt";
}

// Also writes the normalized Obsidian URL and key back into their inputs.
function collectFormPayload() {
  const payload = readFormPayload();
  elements.obsidianApiBaseUrl.value = payload.obsidianApiBaseUrl;
  elements.obsidianApiKey.value = payload.obsidianApiKey;
  return payload;
}

function readFormPayload() {
  const selectedFields = Array.from(elements.frontmatterFields)
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.value);

  const normalizedBaseUrl = normalizeBaseUrl(elements.obsidianApiBaseUrl.value);
  const normalizedApiKey = normalizeApiKey(elements.obsidianApiKey.value);

  return {
    obsidianEnabled: elements.obsidianEnabled.checked,
    noteFolder: elements.noteFolder.value.trim(),
    obsidianApiBaseUrl: normalizedBaseUrl,
    obsidianApiKey: normalizedApiKey,
    tags: elements.tags.value.trim(),
    downloadFormat: normalizeDownloadFormat(elements.downloadFormat.value),
    youtubeSubtitleLang: elements.youtubeSubtitleLang.value,
    includeDateInFilename: elements.includeDateInFilename.checked,
    includeHotCommentsInNote: elements.includeHotCommentsInNote.checked,
    includeCoverInNote: elements.includeCoverInNote.checked,
    includeAiChatInNote: elements.includeAiChatInNote.checked,
    enablePlayerAiQuickAction: elements.enablePlayerAiQuickAction.checked,
    playerAiQuickPrompt: normalizePlayerAiQuickPrompt(elements.playerAiQuickPrompt.value),
    includeTimestampInBody: elements.includeTimestampInBody.checked,
    showBiliTriageBadges: elements.showBiliTriageBadges.checked,
    seenShow: elements.seenShow.value,
    seenThreshold: Math.min(100, Math.max(1, Math.round(Number(elements.seenThreshold.value)) || 80)),
    seenStyle: elements.seenStyle.value === "veil" ? "veil" : "badge",
    enableDebugLogs: elements.enableDebugLogs.checked,
    frontmatterFields: selectedFields,
    fixedFrontmatterProperties: normalizeFixedFrontmatterProperties(collectFixedPropertyRows()),
    notePlaceholderSections: normalizeNotePlaceholderSections(collectNoteSectionRows()),
    aiSystemPrompt: String(elements.aiSystemPrompt?.value || "").trim(),
    aiPresetPrompts: [...new Set(elements.aiPresetPrompts.value.split("\n").map((line) => line.trim()).filter(Boolean))].slice(0, 12)
  };
}

function validateSettings(payload, { requireApiKey }) {
  if (!payload.obsidianEnabled && !requireApiKey) {
    return validateNoteExtras();
  }
  if (!payload.noteFolder) {
    return { ok: false, field: elements.noteFolder, message: "请填写笔记目录（例如：MoonDigest/{{site}}）" };
  }
  if (/^[\/\\]|[\/\\]$/.test(payload.noteFolder)) {
    return { ok: false, field: elements.noteFolder, message: "笔记目录无需以 / 开头或结尾" };
  }
  if (/[\\:*?"<>|\u0000-\u001f]/.test(payload.noteFolder)) {
    return { ok: false, field: elements.noteFolder, message: "笔记目录包含非法字符，请修改后再试" };
  }

  if (!payload.obsidianApiBaseUrl) {
    return { ok: false, field: elements.obsidianApiBaseUrl, message: "请填写 Local REST API 地址" };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(payload.obsidianApiBaseUrl);
  } catch {
    return { ok: false, field: elements.obsidianApiBaseUrl, message: "Local REST API 地址格式不正确" };
  }

  const protocol = parsedUrl.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return { ok: false, field: elements.obsidianApiBaseUrl, message: "Local REST API 地址仅支持 http 或 https" };
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const isLocal = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  if (!isLocal) {
    return {
      ok: false,
      field: elements.obsidianApiBaseUrl,
      message: "请使用本机地址（127.0.0.1 或 localhost），不要填写公网/局域网地址"
    };
  }

  if ((parsedUrl.pathname && parsedUrl.pathname !== "/") || parsedUrl.search || parsedUrl.hash) {
    return { ok: false, field: elements.obsidianApiBaseUrl, message: "地址请只填写到端口，例如 http://127.0.0.1:27123" };
  }

  if (requireApiKey && !payload.obsidianApiKey) {
    return { ok: false, field: elements.obsidianApiKey, message: "测试连接前请填写 Local REST API Key" };
  }

  return validateNoteExtras();
}

function validateNoteExtras() {
  if (/[\r\n]/.test(elements.tags.value)) {
    return { ok: false, field: elements.tags, message: "默认标签请使用逗号分隔，不要换行" };
  }

  const fixedPropertyValidation = validateFixedFrontmatterProperties(collectFixedPropertyRows({ includeRow: true }));
  if (!fixedPropertyValidation.ok) {
    return fixedPropertyValidation;
  }

  const noteSectionValidation = validateNotePlaceholderSections(collectNoteSectionRows({ includeRow: true }));
  if (!noteSectionValidation.ok) {
    return noteSectionValidation;
  }

  return { ok: true };
}

// Note-format settings stay visible (copy and download use them); only Obsidian-specific text hides.
function syncObsidianBody() {
  document.querySelectorAll("#obsidianBody, .obsidian-only").forEach((el) => (el.hidden = !elements.obsidianEnabled.checked));
}

function normalizePlayerAiQuickPrompt(value) {
  return String(value || "").trim();
}

function applyValidationError(validation) {
  clearInputErrors();
  validation?.row?.closest("details")?.setAttribute("open", "");
  if (validation?.field) {
    validation.field.classList.add("input-error");
    validation.field.focus();
  }
  if (validation?.row) {
    const keyInput = validation.row.querySelector(".fixed-property-key");
    const valueInput = validation.row.querySelector(".fixed-property-value");
    const titleInput = validation.row.querySelector(".note-section-title");
    const contentInput = validation.row.querySelector(".note-section-content");
    const positionSelect = validation.row.querySelector(".note-section-position");
    const noteSectionErrorNode = validation.row.querySelector(".note-section-error");
    if (titleInput || contentInput || positionSelect) {
      if (titleInput && !String(titleInput.value || "").trim()) {
        titleInput.classList.add("input-error");
        titleInput.focus();
      } else if (positionSelect && !NOTE_SECTION_POSITIONS.has(String(positionSelect.value || "").trim())) {
        positionSelect.classList.add("input-error");
        positionSelect.focus();
      } else if (contentInput && validation.requireContent) {
        contentInput.classList.add("input-error");
        contentInput.focus();
      } else if (titleInput) {
        titleInput.classList.add("input-error");
        titleInput.focus();
      }
      if (noteSectionErrorNode) {
        noteSectionErrorNode.hidden = false;
        noteSectionErrorNode.textContent = validation.message || "正文附加段落校验失败";
      }
      setStatus(validation?.message || "设置校验失败", true);
      return;
    }
    if (keyInput && !String(keyInput.value || "").trim()) {
      keyInput.classList.add("input-error");
      keyInput.focus();
    } else if (valueInput && !String(valueInput.value || "").trim()) {
      valueInput.classList.add("input-error");
      valueInput.focus();
    } else if (keyInput) {
      keyInput.classList.add("input-error");
      keyInput.focus();
    }

    const errorNode = validation.row.querySelector(".fixed-property-error");
    if (errorNode) {
      errorNode.hidden = false;
      errorNode.textContent = validation.message || "固定属性校验失败";
    }
  }
  setStatus(validation?.message || "设置校验失败", true);
}

function clearInputErrors() {
  [elements.noteFolder, elements.obsidianApiBaseUrl, elements.obsidianApiKey, elements.tags].forEach((input) => {
    input?.classList.remove("input-error");
  });
  clearFixedPropertyErrors();
  clearNoteSectionErrors();
}

function renderFixedPropertyRows(items) {
  elements.fixedPropertiesList.innerHTML = "";
  const rows = Array.isArray(items) ? items : [];
  rows.forEach((item) => addFixedPropertyRow(item));
  updateFixedPropertyEmptyState();
}

function addFixedPropertyRow(item = {}) {
  const type = normalizeFixedPropertyType(item.type);
  const row = document.createElement("div");
  row.className = "fixed-property-row";
  row.innerHTML = `
    <div class="fixed-property-fields">
      <div class="fixed-property-field fixed-property-field-type">${buildFixedPropertyTypePicker(type)}</div>
      <div class="fixed-property-field fixed-property-field-key">
        <input class="fixed-property-key" type="text" placeholder="属性名" value="${escapeAttribute(item.key)}" />
      </div>
      <div class="fixed-property-field fixed-property-field-value">
        <div class="fixed-property-value-slot">${buildFixedPropertyValueControl(type, item.value)}</div>
      </div>
      <div class="fixed-property-field fixed-property-field-remove">
        <button class="fixed-property-remove" type="button" aria-label="删除属性" title="删除属性">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M4 7h16"></path>
            <path d="M9 3h6"></path>
            <path d="M10 11v6"></path>
            <path d="M14 11v6"></path>
            <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>
          </svg>
        </button>
      </div>
    </div>
    <p class="fixed-property-error" hidden></p>
  `;

  row.querySelector(".fixed-property-remove")?.addEventListener("click", () => {
    row.remove();
    updateFixedPropertyEmptyState();
    syncUnsaved();
  });

  const typeButton = row.querySelector(".fixed-property-type-button");
  const typePicker = row.querySelector(".fixed-property-type-picker");
  const typeMenu = row.querySelector(".fixed-property-type-menu");

  typeButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = typePicker?.dataset.open === "true";
    closeAllFixedPropertyMenus();
    if (typePicker && typeMenu && !isOpen) {
      typePicker.dataset.open = "true";
      typeButton.setAttribute("aria-expanded", "true");
      typeMenu.hidden = false;
    }
  });

  row.querySelectorAll(".fixed-property-type-option").forEach((option) => {
    option.addEventListener("click", () => {
      const nextType = normalizeFixedPropertyType(option.getAttribute("data-type"));
      const valueSlot = row.querySelector(".fixed-property-value-slot");
      if (typePicker) {
        typePicker.dataset.type = nextType;
        typePicker.dataset.open = "false";
      }
      if (typeButton) {
        typeButton.setAttribute("aria-expanded", "false");
        const labelNode = typeButton.querySelector(".fixed-property-type-label");
        if (labelNode) {
          labelNode.textContent = getFixedPropertyTypeLabel(nextType);
        }
      }
      if (typeMenu) {
        typeMenu.hidden = true;
      }
      const currentValue = readFixedPropertyValue(row);
      if (valueSlot) {
        valueSlot.innerHTML = buildFixedPropertyValueControl(nextType, currentValue);
        bindFixedPropertyValueEvents(row);
      }
      clearFixedPropertyErrorState(row);
      syncUnsaved();
    });
  });

  row.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", () => {
      input.classList.remove("input-error");
      clearFixedPropertyErrorState(row);
    });
  });
  bindFixedPropertyValueEvents(row);

  elements.fixedPropertiesList.appendChild(row);
  updateFixedPropertyEmptyState();
}

function updateFixedPropertyEmptyState() {
  const hasRows = elements.fixedPropertiesList.children.length > 0;
  elements.fixedPropertiesEmpty.hidden = hasRows;
}

function renderNoteSectionRows(items) {
  elements.noteSectionsList.innerHTML = "";
  const rows = Array.isArray(items) ? items : [];
  rows.forEach((item) => addNoteSectionRow(item, { skipLimit: true }));
  updateNoteSectionEmptyState();
}

function addNoteSectionRow(item = {}, { skipLimit = false } = {}) {
  if (!skipLimit && elements.noteSectionsList.children.length >= MAX_NOTE_PLACEHOLDER_SECTIONS) {
    setStatus(`正文附加段落最多添加 ${MAX_NOTE_PLACEHOLDER_SECTIONS} 个`, true);
    return;
  }

  const position = normalizeNoteSectionPosition(item.position);
  const row = document.createElement("div");
  row.className = "note-section-row";
  row.innerHTML = `
    <div class="note-section-fields">
      <div class="note-section-field note-section-field-position">
        <select class="note-section-position" aria-label="段落位置">
          ${buildNoteSectionPositionOptions(position)}
        </select>
      </div>
      <div class="note-section-field note-section-field-title">
        <input class="note-section-title" type="text" placeholder="段落标题，例：总结" value="${escapeAttribute(item.title)}" />
      </div>
      <div class="note-section-field note-section-field-content">
        <input class="note-section-content" type="text" placeholder="默认内容（可空）" value="${escapeAttribute(item.content)}" />
      </div>
      <div class="note-section-field note-section-field-remove">
        <button class="note-section-remove" type="button" aria-label="删除段落" title="删除段落">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M4 7h16"></path>
            <path d="M9 3h6"></path>
            <path d="M10 11v6"></path>
            <path d="M14 11v6"></path>
            <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>
          </svg>
        </button>
      </div>
    </div>
    <p class="note-section-error" hidden></p>
  `;

  row.querySelector(".note-section-remove")?.addEventListener("click", () => {
    row.remove();
    updateNoteSectionEmptyState();
    syncUnsaved();
  });

  row.querySelectorAll(".note-section-title, .note-section-content, .note-section-position").forEach((input) => {
    input.addEventListener("input", () => clearNoteSectionErrorState(row));
    input.addEventListener("change", () => clearNoteSectionErrorState(row));
  });

  elements.noteSectionsList.appendChild(row);
  updateNoteSectionEmptyState();
}

function updateNoteSectionEmptyState() {
  const hasRows = elements.noteSectionsList.children.length > 0;
  elements.noteSectionsEmpty.hidden = hasRows;
}

function collectNoteSectionRows({ includeRow = false } = {}) {
  return Array.from(elements.noteSectionsList.querySelectorAll(".note-section-row")).map((row) => {
    const item = {
      title: String(row.querySelector(".note-section-title")?.value || "").trim(),
      position: normalizeNoteSectionPosition(row.querySelector(".note-section-position")?.value),
      content: String(row.querySelector(".note-section-content")?.value || "").trim()
    };
    if (includeRow) {
      item.row = row;
    }
    return item;
  });
}

function validateNotePlaceholderSections(items) {
  const rows = Array.isArray(items) ? items : [];
  if (rows.length > MAX_NOTE_PLACEHOLDER_SECTIONS) {
    return { ok: false, message: `正文附加段落最多添加 ${MAX_NOTE_PLACEHOLDER_SECTIONS} 个` };
  }
  for (const item of rows) {
    const title = String(item?.title || "").trim();
    const position = normalizeNoteSectionPosition(item?.position);
    const content = String(item?.content || "").trim();
    if (!title && !content) {
      continue;
    }
    if (!title) {
      return { ok: false, row: item.row, message: "请填写段落标题" };
    }
    if (!NOTE_SECTION_POSITIONS.has(position)) {
      return { ok: false, row: item.row, message: "请选择有效的位置" };
    }
  }
  return { ok: true };
}

function normalizeNotePlaceholderSections(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => ({
      title: String(item?.title || "").trim(),
      position: normalizeNoteSectionPosition(item?.position),
      content: String(item?.content || "").trim()
    }))
    .filter((item) => item.title)
    .slice(0, MAX_NOTE_PLACEHOLDER_SECTIONS);
}

function normalizeNoteSectionPosition(value) {
  const key = String(value || "").trim().toLowerCase();
  return NOTE_SECTION_POSITIONS.has(key) ? key : "before_intro";
}

function buildNoteSectionPositionOptions(selectedPosition) {
  const current = normalizeNoteSectionPosition(selectedPosition);
  const options = [
    { value: "before_intro", label: "简介前" },
    { value: "before_chapters", label: "章节前" },
    { value: "before_subtitle", label: "字幕前" }
  ];
  return options
    .map((item) => `<option value="${item.value}" ${item.value === current ? "selected" : ""}>${item.label}</option>`)
    .join("");
}

function collectFixedPropertyRows({ includeRow = false } = {}) {
  return Array.from(elements.fixedPropertiesList.querySelectorAll(".fixed-property-row")).map((row) => {
    const type = normalizeFixedPropertyType(row.querySelector(".fixed-property-type-picker")?.getAttribute("data-type"));
    const item = {
      key: String(row.querySelector(".fixed-property-key")?.value || "").trim(),
      type,
      value: readFixedPropertyValue(row)
    };
    if (includeRow) {
      item.row = row;
    }
    return item;
  });
}

function validateFixedFrontmatterProperties(items) {
  const seenKeys = new Set();
  const rows = Array.isArray(items) ? items : [];
  for (const item of rows) {
    const key = String(item?.key || "").trim();
    const type = normalizeFixedPropertyType(item?.type);
    const value = item?.value;
    const lowerKey = key.toLowerCase();
    const valueText = typeof value === "string" ? value.trim() : "";

    if (!key && isFixedPropertyRowEffectivelyEmpty(type, value)) {
      continue;
    }
    if (!key) {
      return { ok: false, row: item.row, message: "请填写固定属性的属性名" };
    }
    if (!CUSTOM_PROPERTY_KEY_PATTERN.test(key)) {
      return { ok: false, row: item.row, message: "属性名仅支持中文、英文、数字、空格、下划线和短横线" };
    }
    const hasTemplateToken = containsFrontmatterTemplateToken(valueText);

    if (type === "number") {
      if (!valueText) {
        return { ok: false, row: item.row, message: "请填写数字类型的属性值" };
      }
      if (!hasTemplateToken && !Number.isFinite(Number(valueText))) {
        return { ok: false, row: item.row, message: "数字类型的属性值必须是有效数字" };
      }
    } else if (type === "checkbox") {
      if (!valueText) {
        return { ok: false, row: item.row, message: "请填写复选框类型的属性值" };
      }
      const normalizedCheckboxValue = valueText.toLowerCase();
      if (!hasTemplateToken && normalizedCheckboxValue !== "true" && normalizedCheckboxValue !== "false") {
        return { ok: false, row: item.row, message: "复选框类型的属性值只能填写 true 或 false" };
      }
    } else if (type === "date") {
      if (!valueText) {
        return { ok: false, row: item.row, message: "请填写日期类型的属性值" };
      }
      if (!hasTemplateToken && !FRONTMATTER_DATE_VALUE_RE.test(valueText)) {
        return { ok: false, row: item.row, message: "日期类型请填写 YYYY-MM-DD，或使用 {{upload_date}} 这类变量" };
      }
    } else if (!valueText) {
      return { ok: false, row: item.row, message: "请填写固定属性的属性值" };
    }
    if (Array.from(elements.frontmatterFields).some((checkbox) => checkbox.value === lowerKey)) {
      return { ok: false, row: item.row, message: "该属性名与系统字段重复，请换一个名称" };
    }
    if (seenKeys.has(lowerKey)) {
      return { ok: false, row: item.row, message: "固定属性名不能重复" };
    }
    seenKeys.add(lowerKey);
  }

  return { ok: true };
}

function clearFixedPropertyErrors() {
  elements.fixedPropertiesList.querySelectorAll(".fixed-property-key, .fixed-property-value").forEach((input) => {
    input.classList.remove("input-error");
  });
  elements.fixedPropertiesList.querySelectorAll(".fixed-property-error").forEach((node) => {
    node.hidden = true;
    node.textContent = "";
  });
}

function clearNoteSectionErrors() {
  elements.noteSectionsList.querySelectorAll(".note-section-title, .note-section-content, .note-section-position").forEach((input) => {
    input.classList.remove("input-error");
  });
  elements.noteSectionsList.querySelectorAll(".note-section-error").forEach((node) => {
    node.hidden = true;
    node.textContent = "";
  });
}

function normalizeFixedFrontmatterProperties(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => ({
      key: String(item?.key || "").trim(),
      type: normalizeFixedPropertyType(item?.type),
      value: normalizeFixedPropertyValue(item?.type, item?.value)
    }))
    .filter((item) => item.key && !isFixedPropertyRowEffectivelyEmpty(item.type, item.value));
}

function normalizeFixedPropertyType(value) {
  const type = String(value || "").trim().toLowerCase();
  return FIXED_PROPERTY_TYPES.has(type) ? type : "text";
}

function normalizeFixedPropertyValue(type, value) {
  const normalizedType = normalizeFixedPropertyType(type);
  if (normalizedType === "checkbox") {
    return String(value || "").trim().toLowerCase();
  }
  return String(value || "").trim();
}

function isFixedPropertyRowEffectivelyEmpty(type, value) {
  return !String(value || "").trim();
}

function containsFrontmatterTemplateToken(value) {
  return FRONTMATTER_TEMPLATE_TOKEN_RE.test(String(value || "").trim());
}

function readFixedPropertyValue(row) {
  return String(row.querySelector(".fixed-property-value")?.value || "").trim();
}

function buildFixedPropertyValueControl(type, value) {
  const normalizedType = normalizeFixedPropertyType(type);
  const placeholder =
    normalizedType === "number"
      ? "数字值"
      : normalizedType === "checkbox"
        ? "true / false"
        : normalizedType === "list"
          ? "多个值，用逗号分隔"
          : normalizedType === "date"
            ? "YYYY-MM-DD 或 {{upload_date}}"
          : "属性值";
  return `<input class="fixed-property-value" type="text" placeholder="${placeholder}" value="${escapeAttribute(value)}" />`;
}

function buildFixedPropertyTypePicker(type) {
  const normalizedType = normalizeFixedPropertyType(type);
  return `
    <div class="fixed-property-type-picker" data-type="${normalizedType}" data-open="false">
      <button class="fixed-property-type-button" type="button" aria-label="属性类型" aria-haspopup="true" aria-expanded="false">
        <span class="fixed-property-type-label">${getFixedPropertyTypeLabel(normalizedType)}</span>
        <svg viewBox="0 0 12 12" focusable="false" aria-hidden="true">
          <path d="M2.25 4.5 6 8.25 9.75 4.5"></path>
        </svg>
      </button>
      <div class="fixed-property-type-menu" hidden>
        <button class="fixed-property-type-option" type="button" data-type="text">文本</button>
        <button class="fixed-property-type-option" type="button" data-type="number">数字</button>
        <button class="fixed-property-type-option" type="button" data-type="checkbox">复选框</button>
        <button class="fixed-property-type-option" type="button" data-type="list">列表</button>
        <button class="fixed-property-type-option" type="button" data-type="date">日期</button>
      </div>
    </div>
  `;
}

function getFixedPropertyTypeLabel(type) {
  const normalizedType = normalizeFixedPropertyType(type);
  if (normalizedType === "number") {
    return "数字";
  }
  if (normalizedType === "checkbox") {
    return "复选框";
  }
  if (normalizedType === "list") {
    return "列表";
  }
  if (normalizedType === "date") {
    return "日期";
  }
  return "文本";
}

function bindFixedPropertyValueEvents(row) {
  row.querySelectorAll(".fixed-property-value").forEach((input) => {
    input.addEventListener("input", () => clearFixedPropertyErrorState(row));
    input.addEventListener("change", () => clearFixedPropertyErrorState(row));
  });
}

function clearFixedPropertyErrorState(row) {
  row.querySelectorAll(".fixed-property-key, .fixed-property-value").forEach((input) => {
    input.classList.remove("input-error");
  });
  const errorNode = row.querySelector(".fixed-property-error");
  if (errorNode) {
    errorNode.hidden = true;
    errorNode.textContent = "";
  }
}

function clearNoteSectionErrorState(row) {
  row.querySelectorAll(".note-section-title, .note-section-content, .note-section-position").forEach((input) => {
    input.classList.remove("input-error");
  });
  const errorNode = row.querySelector(".note-section-error");
  if (errorNode) {
    errorNode.hidden = true;
    errorNode.textContent = "";
  }
}

function closeAllFixedPropertyMenus() {
  elements.fixedPropertiesList.querySelectorAll(".fixed-property-type-picker").forEach((picker) => {
    picker.setAttribute("data-open", "false");
    const button = picker.querySelector(".fixed-property-type-button");
    const menu = picker.querySelector(".fixed-property-type-menu");
    if (button) {
      button.setAttribute("aria-expanded", "false");
    }
    if (menu) {
      menu.hidden = true;
    }
  });
}

function escapeAttribute(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/g, "");
}

function normalizeApiKey(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
}


async function testConnection() {
  clearInputErrors();
  const payload = collectFormPayload();
  const validation = validateSettings(payload, { requireApiKey: true });
  if (!validation.ok) {
    applyValidationError(validation);
    return;
  }

  setBusy(elements.testConnectionBtn);
  setTestResult("");
  try {
    const resp = await sendRuntimeMessage({
      type: "test-obsidian-connection",
      baseUrl: payload.obsidianApiBaseUrl,
      apiKey: payload.obsidianApiKey
    });

    obsidianConnected = Boolean(resp?.ok);
    if (!resp?.ok) {
      setTestResult(`连接失败：${resp?.error || "未知错误"}`, true);
      return;
    }

    const service = resp?.service ? `（${resp.service}）` : "";
    setTestResult(`连接成功${service}`);
  } catch (error) {
    obsidianConnected = false;
    setTestResult(`连接失败：${error.message || "未知错误"}`, true);
  } finally {
    setBusy(null);
    renderSavedState();
  }
}

// The Obsidian test result sits next to its button.
function setTestResult(text, isError = false) {
  elements.obsidianTestResult.textContent = text;
  elements.obsidianTestResult.dataset.error = String(isError);
}

// Both buttons wait while either runs; the running one gets the shared busy look from tokens.css.
function setBusy(active) {
  for (const [button, idle, busy] of [[elements.saveBtn, "保存", "保存中…"], [elements.testConnectionBtn, "测试连接", "测试中…"]]) {
    button.disabled = Boolean(active);
    button.textContent = button === active ? busy : idle;
    button.setAttribute("aria-busy", String(button === active));
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

// ===== AI 模型平台 =====

async function loadAiProviders() {
  try {
    const resp = await sendRuntimeMessage({ type: "ai-providers-list" });
    if (!resp?.ok) return [];
    return Array.isArray(resp.providers) ? resp.providers : [];
  } catch {
    return [];
  }
}

function renderAiProviders(items) {
  elements.aiProvidersList.innerHTML = "";
  const list = Array.isArray(items) ? items : [];
  list.forEach((item) => addAiProviderRow(item));
  updateAiProvidersEmptyState();
}

function updateAiProvidersEmptyState() {
  const hasRows = elements.aiProvidersList.children.length > 0;
  elements.aiProvidersHead.hidden = !hasRows;
  // The prompt settings do nothing without a platform, so they wait until a row is added.
  elements.aiPromptRows.hidden = !hasRows;
  elements.aiPromptsLater.hidden = hasRows;
}

function generateAiProviderId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function addAiProviderRow(item = {}) {
  const id = String(item.id || generateAiProviderId());
  const presetId = String(item.presetId || "custom");
  const preset = AI_PRESETS.find((p) => p.id === presetId) || AI_PRESETS[AI_PRESETS.length - 1];
  const baseUrl = String(item.baseUrl ?? preset.baseUrl ?? "");
  const model = String(item.model || "");
  const requiresKey = item.requiresKey !== false && preset.requiresKey !== false;
  const hasSavedKey = Boolean(item.hasSavedKey);

  const row = document.createElement("div");
  row.className = "ai-provider-row";
  row.dataset.providerId = id;
  row.dataset.hasSavedKey = hasSavedKey ? "1" : "0";
  row.dataset.currentPresetId = presetId;
  row.innerHTML = `
    <select class="ai-provider-preset" aria-label="平台">
      ${AI_PRESETS.map((p) => `<option value="${escapeAttribute(p.id)}" ${p.id === presetId ? "selected" : ""}>${escapeAttribute(p.name)}</option>`).join("")}
    </select>
    <input class="ai-provider-baseurl" type="text" aria-label="接口地址" placeholder="如 https://api.openai.com/v1" value="${escapeAttribute(baseUrl)}" />
    <input class="ai-provider-model" type="text" aria-label="模型" placeholder="如 gpt-4o-mini" value="${escapeAttribute(model)}" />
    <div class="key">
      <input class="ai-provider-apikey" type="password" aria-label="API Key" placeholder="${apiKeyPlaceholder(hasSavedKey, requiresKey)}" autocomplete="off" />
      <span class="keytag"${hasSavedKey ? "" : " hidden"}>已保存</span>
    </div>
    <button type="button" class="sm ai-provider-test" title="用这一行的地址、模型和 Key 向 AI 发一条测试消息"><span class="ai-spark" aria-hidden="true"></span>测试连接</button>
    <button type="button" class="ai-provider-remove" aria-label="删除平台" title="删除平台">
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <path d="M4 7h16"></path>
        <path d="M9 3h6"></path>
        <path d="M10 11v6"></path>
        <path d="M14 11v6"></path>
        <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>
      </svg>
    </button>
    <p class="ai-provider-status" hidden></p>
  `;

  row.querySelector(".ai-provider-preset").addEventListener("change", (e) => {
    const previousPreset = AI_PRESETS.find((p) => p.id === row.dataset.currentPresetId) || null;
    const next = AI_PRESETS.find((p) => p.id === e.target.value);
    if (!next) return;
    const baseUrlInput = row.querySelector(".ai-provider-baseurl");
    const currentBaseUrl = baseUrlInput.value.trim();
    if (!currentBaseUrl || (previousPreset && currentBaseUrl === previousPreset.baseUrl)) {
      baseUrlInput.value = next.baseUrl;
    }
    const modelInput = row.querySelector(".ai-provider-model");
    if (!modelInput.value.trim() || (previousPreset && modelInput.value.trim() === previousPreset.model)) {
      modelInput.value = next.model;
    }
    const apikeyInput = row.querySelector(".ai-provider-apikey");
    apikeyInput.placeholder = apiKeyPlaceholder(row.dataset.hasSavedKey === "1", next.requiresKey);
    row.dataset.currentPresetId = next.id;
  });

  const keyInput = row.querySelector(".ai-provider-apikey");
  keyInput.addEventListener("input", () => {
    row.querySelector(".keytag").hidden = row.dataset.hasSavedKey !== "1" || Boolean(keyInput.value);
  });

  // Two clicks in place instead of a system dialog: the first turns the trash icon into 「确认删除」.
  const removeBtn = row.querySelector(".ai-provider-remove");
  const trashIcon = removeBtn.innerHTML;
  const disarm = () => {
    if (!removeBtn.classList.contains("armed")) return;
    removeBtn.classList.remove("armed");
    removeBtn.innerHTML = trashIcon;
    removeBtn.setAttribute("aria-label", "删除平台");
    removeBtn.title = "删除平台";
  };
  removeBtn.addEventListener("blur", disarm);
  removeBtn.addEventListener("click", async () => {
    if (!removeBtn.classList.contains("armed")) {
      removeBtn.classList.add("armed");
      removeBtn.textContent = "确认删除";
      removeBtn.setAttribute("aria-label", "再点一次删除平台，它保存的 API Key 也一起删除");
      removeBtn.title = "再点一次删除，API Key 一起删掉";
      removeBtn.focus();
      return;
    }
    if (row.dataset.providerId) {
      try {
        await sendRuntimeMessage({ type: "ai-providers-delete", providerId: row.dataset.providerId });
      } catch {}
    }
    row.remove();
    updateAiProvidersEmptyState();
    updateSavedProviders((list) => list.filter((item) => item.id !== row.dataset.providerId));
  });

  row.querySelector(".ai-provider-test")?.addEventListener("click", async () => {
    const statusNode = row.querySelector(".ai-provider-status");
    const baseUrl = row.querySelector(".ai-provider-baseurl").value.trim();
    const apiKey = row.querySelector(".ai-provider-apikey").value.trim();
    const model = row.querySelector(".ai-provider-model").value.trim();
    if (!baseUrl) {
      showAiProviderStatus(statusNode, "请填写接口地址", true);
      return;
    }
    if (!model) {
      showAiProviderStatus(statusNode, "请填写模型名", true);
      return;
    }
    const testBtn = row.querySelector(".ai-provider-test");
    showAiProviderStatus(statusNode, "正在测试…");
    statusNode.setAttribute("aria-busy", "true");
    testBtn.disabled = true;
    const resp = await sendRuntimeMessage({
      type: "ai-providers-test",
      providerId: row.dataset.providerId || "",
      baseUrl,
      apiKey,
      model
    }).catch((error) => ({ ok: false, error: error.message }));
    statusNode.setAttribute("aria-busy", "false");
    testBtn.disabled = false;
    if (resp?.ok) {
      showAiProviderStatus(statusNode, hasUnsavedChanges ? "测试通过，记得保存设置" : "连接成功");
    } else {
      showAiProviderStatus(statusNode, `失败：${resp?.error || "未知错误"}`, true);
    }
  });

  elements.aiProvidersList.appendChild(row);
  updateAiProvidersEmptyState();
}

function apiKeyPlaceholder(hasSavedKey, requiresKey) {
  return hasSavedKey ? "••••••••••••" : requiresKey === false ? "可选" : "必填";
}

function showAiProviderStatus(node, text, isError = false) {
  if (!node) return;
  node.hidden = false;
  node.textContent = text;
  node.dataset.error = isError ? "true" : "false";
}

function collectAiProviders() {
  return Array.from(elements.aiProvidersList.querySelectorAll(".ai-provider-row")).map((row) => {
    const presetSelect = row.querySelector(".ai-provider-preset");
    const preset = AI_PRESETS.find((p) => p.id === presetSelect.value) || AI_PRESETS[AI_PRESETS.length - 1];
    const apiKey = row.querySelector(".ai-provider-apikey").value.trim();
    const baseUrl = row.querySelector(".ai-provider-baseurl").value.trim().replace(/\/+$/, "");
    return {
      id: row.dataset.providerId || generateAiProviderId(),
      presetId: preset.id,
      name: preset.name,
      baseUrl,
      model: row.querySelector(".ai-provider-model").value.trim(),
      temperature: 0.7,
      requiresKey: preset.requiresKey,
      enabled: true,
      apiKey,
      hasSavedKey: row.dataset.hasSavedKey === "1"
    };
  });
}

function hostPermissionUrls(settings, providers) {
  return [settings.obsidianEnabled === true ? settings.obsidianApiBaseUrl : "", ...providers.map((item) => item.baseUrl)];
}

// Loopback hosts are in host_permissions already; everything else is optional.
function hostPermissionPattern(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (!/^https?:$/.test(parsed.protocol) || ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
      return "";
    }
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return "";
  }
}

async function missingHostPermissions(urls) {
  const origins = [...new Set(urls.map(hostPermissionPattern).filter(Boolean))];
  if (!chrome.permissions?.request) {
    return [];
  }
  const missing = [];
  for (const origin of origins) {
    if (!(await chrome.permissions.contains({ origins: [origin] }))) {
      missing.push(origin);
    }
  }
  return missing;
}

// Returns the patterns the user declined (empty when everything is granted).
async function requestHostPermissions(urls) {
  const missing = await missingHostPermissions(urls);
  if (!missing.length) {
    return [];
  }
  const granted = await chrome.permissions.request({ origins: missing }).catch(() => false);
  return granted ? [] : missing;
}

// Installs upgraded from before 1.2.0 never went through the save-time request.
async function renderHostPermissionBanner(urls) {
  const missing = await missingHostPermissions(urls);
  elements.hostPermissionBanner.hidden = !missing.length;
  if (!missing.length) {
    return;
  }
  elements.hostPermissionText.textContent = `未授权访问 ${missing.map((pattern) => pattern.replace(/\/\*$/, "")).join("、")}，AI 请求会失败。`;
  elements.hostPermissionBtn.onclick = async () => {
    await chrome.permissions.request({ origins: missing }).catch(() => false);
    renderHostPermissionBanner(urls);
  };
}

function validateAiProviders(items) {
  const seenIds = new Set();
  for (const item of items) {
    if (!item.baseUrl) {
      return { ok: false, message: "每个平台都需要填写接口地址" };
    }
    try {
      const u = new URL(item.baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { ok: false, message: `接口地址必须以 http(s):// 开头（${item.baseUrl}）` };
      }
    } catch {
      return { ok: false, message: `接口地址格式不正确：${item.baseUrl}` };
    }
    if (item.requiresKey && !item.apiKey && !item.hasSavedKey) {
      return { ok: false, message: `平台「${item.name}」需要填写 API Key` };
    }
    if (!item.model) {
      return { ok: false, message: `平台「${item.name}」需要填写模型名` };
    }
    if (seenIds.has(item.id)) {
      return { ok: false, message: "平台 id 重复，请刷新页面后重试" };
    }
    seenIds.add(item.id);
  }
  return { ok: true };
}
