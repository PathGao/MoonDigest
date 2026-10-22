// Only for when get-settings fails; the background owns the stored settings.
const DEFAULT_SETTINGS = { ...MdgSettings.DEFAULTS, ...MdgSettings.LOCAL_DEFAULTS };
const { escapeHtml } = MdgErrors;

// The {{名称}} a typed 自定属性 may be, whole (note.js buildFrontmatterTemplateContext fills them): anything else does not
// read as that type and note.js leaves the property out of the note. A 复选框 takes none.
const TYPED_PROPERTY_VARS = { number: ["duration", "cid"], date: ["upload_date", "created"], checkbox: [] };
const FRONTMATTER_DATE_VALUE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIXED_PROPERTY_TYPE_LABELS = { text: "文本", number: "数字", checkbox: "复选框", list: "列表", date: "日期" };
// An AI platform row's boxes, by the names its 测试连接 reason and the save check give them.
const AI_FIELD = { baseUrl: "接口地址", model: "模型", key: "API Key" };
const TRASH_ICON = `<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M4 7h16"></path><path d="M9 3h6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path></svg>`;

const AI_PRESETS = [
  { id: "openai_compat", name: "OpenAI 兼容", baseUrl: "https://api.openai.com/v1", model: "gpt-6-luna", requiresKey: true },
  { id: "deepseek",      name: "DeepSeek",    baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", requiresKey: true },
  { id: "zhipu",         name: "智谱 GLM",    baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.7-flash", requiresKey: true },
  { id: "minimax",       name: "MiniMax",     baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M2.7-highspeed", requiresKey: true },
  { id: "moonshot",      name: "Moonshot",    baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.6", requiresKey: true },
  { id: "openrouter",    name: "OpenRouter",  baseUrl: "https://openrouter.ai/api/v1", model: "~google/gemini-flash-latest", requiresKey: true },
  { id: "ollama",        name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1", model: "", requiresKey: false },
  { id: "custom",        name: MdgErrors.LABEL.customAi, baseUrl: "", model: "", requiresKey: true }
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
  showBiliUpTags: document.getElementById("showBiliUpTags"),
  showBiliVerdicts: document.getElementById("showBiliVerdicts"),
  biliMarks: document.getElementById("biliMarks"),
  seenShow: document.getElementById("seenShow"),
  seenThreshold: document.getElementById("seenThreshold"),
  seenStyle: document.getElementById("seenStyle"),
  seenDemo: document.getElementById("seenDemo"),
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
  webAiSystemPrompt: document.getElementById("webAiSystemPrompt"),
  webAiSummaryPrompt: document.getElementById("webAiSummaryPrompt"),
  webAiPresetPrompts: document.getElementById("webAiPresetPrompts"),
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
// The languages after 自动 are MdgCommon.SUBTITLE_LANGS, the targets the subtitle choice matches.
elements.youtubeSubtitleLang.append(...Object.entries(MdgCommon.SUBTITLE_LANGS).map(([value, name]) => new Option(name, value)));

// Form state keys that are not an element id, mapped to the element whose section they belong to.
const STATE_KEY_NODES = {
  frontmatterFields: elements.frontmatterFields[0],
  fixedFrontmatterProperties: elements.fixedPropertiesList,
  notePlaceholderSections: elements.noteSectionsList,
  providers: elements.aiProvidersList,
  biliMarksOff: elements.biliMarks
};

// The form differs from what was last loaded or saved; a passed provider test reminds the user to save.
let hasUnsavedChanges = false;
let savedForm = null;
// The URL and key of the last Obsidian test and whether it passed; the header says 「已连接」 only while those are saved.
let obsidianTest = null;
// The button whose save or test is running (setBusy).
let busyButton = null;

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
  initPromptTabs();
  document.getElementById("exportSettingsBtn").addEventListener("click", exportSettingsFile);
  const importFile = document.getElementById("importSettingsFile");
  document.getElementById("importSettingsBtn").addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => {
    const file = importFile.files[0];
    importFile.value = "";
    if (file) void importSettingsFile(file);
  });
  document.getElementById("seen").addEventListener("input", syncSeenRows);
  [elements.showBiliVerdicts, elements.showBiliTriageBadges, elements.showBiliUpTags, elements.seenShow].forEach((el) => el.addEventListener("change", syncBiliMarks));
  // Like the 分拣台's number boxes (TriageUi.clampNumber): above max shows max, an invalid number is cleared, and an
  // empty box is the default its grey 「默认 N」 names.
  elements.seenThreshold.addEventListener("change", () => TriageUi.clampNumber(elements.seenThreshold));
  // Range and 「默认 N」 from settings.js, like the 分拣台's number boxes.
  const { min, max, def } = MdgSettings.SEEN_THRESHOLD;
  TriageUi.numBox(elements.seenThreshold, min, max, def);
  TriageUi.fillNumHints(document);
  // 观看进度's caps, as the 数据与存储 table states them (limits.js).
  for (const node of document.querySelectorAll("[data-seen-limits]")) node.textContent = MdgLimits.SEEN_LIMITS_TEXT;
  // Both 追问 sets (video, web page): blank, repeated and lines past MAX_PRESET_PROMPTS are dropped from the box, not only
  // from what is saved. The side panel edits them too: a box follows it unless it has an unsaved edit, so the next save
  // does not put the old list back.
  for (const key of ["aiPresetPrompts", "webAiPresetPrompts"]) {
    elements[key].addEventListener("change", () => (elements[key].value = readFormPayload()[key].join("\n")));
    chrome.storage.onChanged.addListener((changes, area) => {
      const next = changes[key]?.newValue;
      if (area !== "sync" || !Array.isArray(next) || !savedForm) return;
      if (JSON.stringify(readFormPayload()[key]) !== JSON.stringify(savedForm.payload[key])) return;
      elements[key].value = next.join("\n");
      savedForm.payload[key] = readFormPayload()[key];
      syncUnsaved();
    });
  }
  elements.testConnectionBtn.addEventListener("click", testConnection);
  elements.addFixedPropertyBtn.addEventListener("click", () => {
    addFixedPropertyRow();
    syncUnsaved();
  });
  elements.addNoteSectionBtn.addEventListener("click", () => {
    addNoteSectionRow();
    syncUnsaved();
  });
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
  // Typing in any box marked red (by validation or by save-settings' too-long field) clears its mark.
  document.addEventListener("input", (event) => event.target.classList?.remove("input-error"));
  elements.obsidianApiKey.addEventListener("input", syncObsidianKeyTag);
  for (const box of [elements.obsidianApiBaseUrl, elements.obsidianApiKey]) box.addEventListener("input", syncObsidianTest);
  // Focuses an open triage or 摘读记录 tab instead of a second one.
  for (const [page, type] of [[MdgCommon.PAGES.triage, "triage-open"], [MdgCommon.PAGES.history, "history-open"]]) {
    document.querySelector(`a.jump[href$="${page}"]`)?.addEventListener("click", async (event) => {
      event.preventDefault();
      const r = await chrome.runtime.sendMessage({ type }).catch(() => null);
      if (!r?.ok) chrome.tabs.create({ url: chrome.runtime.getURL(page) });
    });
  }
  document.querySelectorAll(".var[data-var]").forEach((button) => {
    button.addEventListener("click", () => {
      const folder = elements.noteFolder.value.trim().replace(/\/+$/, "");
      elements.noteFolder.value = (folder ? `${folder}/` : "") + button.dataset.var;
      elements.noteFolder.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
  elements.filenameSample.textContent = `${MdgCommon.localDate()}-视频标题.md`;
  trackCurrentSection();
}

// Marks the section list entry: the one clicked until the page scrolls away from where the jump left it,
// else the section at the top of the window.
// A short section near the end never reaches the top, so a click has to win over the scroll position.
function trackCurrentSection() {
  const links = Array.from(elements.toc.querySelectorAll("a"));
  const sections = Array.from(document.querySelectorAll("section.sec"));
  const setCurrent = (id) => links.forEach((link) => link.setAttribute("aria-current", String(link.hash === `#${id}`)));
  let clicked = null;
  let clickedY = null; // where the jump landed; set on the frame after the click
  const update = () => {
    if (clicked && (clickedY === null || Math.abs(scrollY - clickedY) < 2)) return setCurrent(clicked.id);
    clicked = null;
    const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
    const current = atEnd ? sections.at(-1) : sections.filter((s) => s.getBoundingClientRect().top <= 80).at(-1) || sections[0];
    setCurrent(current.id);
  };
  links.forEach((link) =>
    link.addEventListener("click", () => {
      clicked = document.getElementById(link.hash.slice(1));
      clickedY = null;
      setCurrent(clicked.id);
      requestAnimationFrame(() => (clickedY = scrollY));
    })
  );
  addEventListener("scroll", update, { passive: true });
  update();
}

// Exports what is saved, not unsaved edits in the form.
async function exportSettingsFile() {
  const resp = await chrome.runtime.sendMessage({ type: "settings-export" }).catch((e) => ({ error: e.message }));
  if (!resp?.ok) return setStatus(`导出失败：${MdgErrors.text(resp)}`, true);
  MdgDownload.text(`MoonDigest设置-${MdgCommon.localDate()}.json`, JSON.stringify(resp.file, null, 2), "application/json");
  setStatus(hasUnsavedChanges ? "已导出已保存的设置，未保存的修改不在文件里" : "已导出设置");
}

// How many folders chosen here the file leaves out: importing it takes them out of 分拣, as unticking them would.
// A file without a folder choice keeps the current one.
function droppedFolders(current, next) {
  if (!Array.isArray(current) || !Array.isArray(next)) {
    return 0;
  }
  const keep = new Set(next.map(String));
  return current.filter((id) => !keep.has(String(id))).length;
}

async function importSettingsFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return setStatus("导入失败：文件不是有效的 JSON", true);
  }
  const lost = hasUnsavedChanges ? "本页未保存的修改会丢失。" : "";
  const key = MdgLimits.KEYS.triageIncludedFolders;
  const current = (await chrome.storage.local.get(key).catch(() => ({})))[key];
  const dropped = droppedFolders(current, data?.local?.[key]);
  const out = dropped ? `当前勾选的 ${dropped} 个收藏夹在文件里没有勾选：导入后它们的视频会进「已出分拣范围」，取消收藏记录会被删除。` : "";
  if (!confirm(`用「${file.name}」替换当前的全部设置？${lost}${out}已保存的 Key 不变。`)) return;
  const resp = await chrome.runtime.sendMessage({ type: "settings-import", file: data }).catch((e) => ({ error: e.message }));
  if (!resp?.ok) return setStatus(`导入失败：${MdgErrors.text(resp)}`, true);
  // Reload so every control, the AI list and the host-permission banner show the imported values.
  hasUnsavedChanges = false;
  location.reload();
}

// A failed read says so: an empty storage would read as 0 used.
async function renderStorageLimits() {
  let all;
  try {
    all = await chrome.storage.local.get(null);
  } catch (error) {
    const cell = Object.assign(document.createElement("td"), { colSpan: 3, textContent: `读取存储用量失败：${error.message || MdgErrors.TEXT.unknown}` });
    const tr = document.createElement("tr");
    tr.append(cell);
    elements.storageLimits.replaceChildren(tr);
    return;
  }
  elements.storageLimits.replaceChildren(
    ...MdgLimits.describe(MdgLimits.storageUsage(all)).map((row) => {
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

// A failed read shows no values and offers no save: defaults or an empty platform list saved over the real ones would erase them.
async function loadSettings() {
  let settings, providers;
  try {
    [settings, providers] = await Promise.all([getSettings(), loadAiProviders()]);
  } catch (error) {
    document.querySelector("main").inert = true;
    setStatus(`读取设置失败：${error.message || MdgErrors.TEXT.unknown}，${MdgErrors.TEXT.reloadRetry}`, true);
    return;
  }
  void renderStorageLimits();
  elements.obsidianEnabled.checked = settings.obsidianEnabled;
  syncObsidianBody();
  elements.noteFolder.value = settings.noteFolder || "";
  elements.obsidianApiBaseUrl.value = settings.obsidianApiBaseUrl || "";
  elements.obsidianApiKey.value = settings.obsidianApiKey || "";
  elements.tags.value = settings.tags || "";
  elements.downloadFormat.value = MdgSettings.normalizeDownloadFormat(settings.downloadFormat);
  elements.youtubeSubtitleLang.value = settings.youtubeSubtitleLang || "auto";
  elements.includeDateInFilename.checked = settings.includeDateInFilename;
  elements.includeHotCommentsInNote.checked = settings.includeHotCommentsInNote;
  elements.includeCoverInNote.checked = settings.includeCoverInNote;
  elements.includeAiChatInNote.checked = settings.includeAiChatInNote;
  elements.enablePlayerAiQuickAction.checked = settings.enablePlayerAiQuickAction;
  elements.playerAiQuickPrompt.value = String(settings.playerAiQuickPrompt || "");
  elements.includeTimestampInBody.checked = settings.includeTimestampInBody;
  elements.showBiliTriageBadges.checked = settings.showBiliTriageBadges;
  elements.showBiliUpTags.checked = settings.showBiliUpTags;
  elements.showBiliVerdicts.checked = settings.showBiliVerdicts;
  renderBiliMarks(settings.biliMarksOff);
  elements.seenShow.value = MdgSettings.normalizeSeenShow(settings.seenShow);
  elements.seenThreshold.value = String(MdgSettings.normalizeSeenThreshold(settings.seenThreshold));
  elements.seenStyle.value = MdgSettings.normalizeSeenStyle(settings.seenStyle);
  syncSeenRows();
  syncBiliMarks();
  elements.enableDebugLogs.checked = settings.enableDebugLogs;
  const selectedFields = new Set((settings.frontmatterFields || DEFAULT_SETTINGS.frontmatterFields).map(MdgSettings.normalizeFrontmatterField));
  elements.frontmatterFields.forEach((checkbox) => {
    checkbox.checked = selectedFields.has(checkbox.value);
  });
  renderFixedPropertyRows(settings.fixedFrontmatterProperties);
  renderNoteSectionRows(settings.notePlaceholderSections);
  elements.aiSystemPrompt.value = settings.aiSystemPrompt || "";
  elements.aiPresetPrompts.value = (Array.isArray(settings.aiPresetPrompts) ? settings.aiPresetPrompts : []).join("\n");
  elements.webAiSystemPrompt.value = settings.webAiSystemPrompt || "";
  elements.webAiSummaryPrompt.value = String(settings.webAiSummaryPrompt || "");
  elements.webAiPresetPrompts.value = (Array.isArray(settings.webAiPresetPrompts) ? settings.webAiPresetPrompts : []).join("\n");

  renderAiProviders(providers);
  renderHostPermissionBanner(hostPermissionUrls(settings, providers));
  markSaved();
}

// B站页面上显示什么: a row per kind of page, a box per mark that page offers (bili-surfaces.js); the rest show 「–」.
function renderBiliMarks(off) {
  const { ROWS, COLS, allowed, normalizeOff } = MdgSurfaces;
  const no = new Set(normalizeOff(off));
  const head = document.getElementById("biliMarksHead");
  head.replaceChildren(document.createElement("th"), ...Object.values(COLS).map((name) => Object.assign(document.createElement("th"), { textContent: name, scope: "col" })));
  elements.biliMarks.replaceChildren(
    ...Object.entries(ROWS).map(([key, name]) => {
      const tr = document.createElement("tr");
      tr.append(Object.assign(document.createElement("th"), { textContent: name, scope: "row" }));
      for (const [col, colName] of Object.entries(COLS)) {
        const td = document.createElement("td");
        if (allowed(key, col)) {
          const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: !no.has(`${key}.${col}`) });
          box.dataset.cell = `${key}.${col}`;
          box.dataset.col = col;
          box.setAttribute("aria-label", `${name}：${colName}`);
          td.append(box);
        } else {
          td.textContent = "–";
          td.className = "none";
        }
        tr.append(td);
      }
      return tr;
    })
  );
}

// A column whose switch is off (above, or 封面显示 in 观看进度) keeps its boxes but greys them out.
function syncBiliMarks() {
  // The reason names the switch by its own label.
  const why = (on, el) => (on ? "" : `「${document.querySelector(`label[for="${el.id}"]`).textContent}」关着`);
  const off = {
    verdict: why(elements.showBiliVerdicts.checked, elements.showBiliVerdicts),
    vtags: why(elements.showBiliTriageBadges.checked, elements.showBiliTriageBadges),
    ups: why(elements.showBiliUpTags.checked, elements.showBiliUpTags),
    plus: why(elements.showBiliUpTags.checked, elements.showBiliUpTags),
    seen: why(elements.seenShow.value !== "off", elements.seenShow)
  };
  elements.biliMarks.querySelectorAll("input[data-col]").forEach((box) => MdgErrors.setReason(box, off[box.dataset.col]));
}

// 看到多少算看完了 and the mark style only matter while the mark is shown. The example covers follow the unsaved form:
// options.css reads data-show and data-style, and the 2nd and 3rd covers sit at the share and at half of it.
function syncSeenRows() {
  const mark = elements.seenShow.value === "mark" || elements.seenShow.value === "both";
  document.querySelectorAll("[data-seen-mark-row]").forEach((row) => (row.hidden = !mark));
  const demo = elements.seenDemo;
  demo.dataset.show = elements.seenShow.value;
  demo.dataset.style = elements.seenStyle.value;
  const share = readFormPayload().seenThreshold;
  const half = Math.floor(share / 2);
  const cover = (at, pct, words) => {
    const fig = demo.querySelector(`[data-seen-at="${at}"]`);
    fig.hidden = pct < 1; // a 1% share leaves nothing below it
    fig.querySelector(".seen-tag").textContent = words;
    fig.querySelector("i").style.width = `${pct}%`;
  };
  cover("full", share, MdgSurfaces.seenWords(share, true));
  cover("half", half, MdgSurfaces.seenWords(half, false));
}

async function saveSettings() {
  clearInputErrors();
  const payload = collectFormPayload();
  const validation = validateSettings(payload, { testing: false });
  if (!validation.ok) {
    applyValidationError(validation);
    return;
  }
  const aiProvidersPayload = collectAiProviders();
  const aiProvidersValidation = validateAiProviders(aiProvidersPayload);
  if (!aiProvidersValidation.ok) {
    const { index, box, message } = aiProvidersValidation;
    const row = elements.aiProvidersList.querySelectorAll(".ai-provider-row")[index];
    applyValidationError({ field: box ? row?.querySelector(box) : null, message });
    return;
  }

  // Remote hosts are optional permissions; the save click is the user gesture that may request them.
  const hostUrls = hostPermissionUrls(payload, aiProvidersPayload);
  const deniedHosts = await requestHostPermissions(hostUrls);

  setBusy(elements.saveBtn);
  setStatus("正在保存…", false, true);
  try {
    const fail = (error) => ({ ok: false, error: error.message });
    const resp = await chrome.runtime.sendMessage({ type: "save-settings", settings: payload }).catch(fail);
    if (!resp?.ok) {
      // A setting too long for Chrome's sync storage: the box it came from is marked, as a validation error is.
      if (elements[resp?.field]) applyValidationError({ field: elements[resp.field], message: resp.error });
      else setStatus(`${MdgErrors.TEXT.settingsSaveFailed}：${MdgErrors.text(resp)}`, true);
      return;
    }
    renderFixedPropertyRows(payload.fixedFrontmatterProperties);
    renderNoteSectionRows(payload.notePlaceholderSections);
    // The box shows what was saved: 150 is stored and shown as 100; an emptied box stays empty under 「默认 N」.
    TriageUi.clampNumber(elements.seenThreshold);
    elements.aiPresetPrompts.value = payload.aiPresetPrompts.join("\n");
    elements.webAiPresetPrompts.value = payload.webAiPresetPrompts.join("\n");
    // The settings are saved whatever the AI platforms' save does: a failure there leaves only the platforms unsaved.
    savedForm.payload = readFormState().payload;
    // A test of other values says nothing about the ones just saved.
    if (obsidianTest && obsidianTest.target !== obsidianTarget(payload)) {
      obsidianTest = null;
      setTestResult("");
    }

    // AI 平台：list 走 sync、apiKey 走 local
    const aiResp = await chrome.runtime.sendMessage({ type: "ai-providers-save", providers: aiProvidersPayload }).catch(fail);
    if (!aiResp?.ok) {
      syncUnsaved();
      renderSavedState();
      setStatus(`${MdgErrors.TEXT.settingsSaved}，但 AI 平台保存失败：${MdgErrors.text(aiResp)}`, true);
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
    setStatus(`${MdgErrors.TEXT.settingsSaved}${payload.obsidianEnabled && !payload.obsidianApiKey ? "（未填写 Local REST API Key，暂不可写入 Obsidian）" : ""}`);
  } catch (error) {
    setStatus(`${MdgErrors.TEXT.settingsSaveFailed}：${error.message || MdgErrors.TEXT.unknown}`, true);
  } finally {
    setBusy(null);
  }
}

async function getSettings() {
  const resp = await chrome.runtime.sendMessage({ type: "get-settings" });
  if (!resp?.ok) throw MdgErrors.fromResp(resp);
  return { ...DEFAULT_SETTINGS, ...(resp.settings || {}) };
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
// Rows are compared as typed: a half-filled one is dropped from the payload, but it is still an edit that saving must validate.
function readFormState() {
  const payload = { ...readFormPayload(), fixedFrontmatterProperties: collectFixedPropertyRows(), notePlaceholderSections: collectNoteSectionRows() };
  return { payload, providers: collectAiProviders() };
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

// Section-list badges, the no-AI note and the Obsidian guide follow what is saved, not what is being typed.
function renderSavedState() {
  const providers = savedForm.providers;
  const aiReady = providers.length > 0;
  elements.noAiNote.hidden = aiReady;
  setPill(elements.aiPill, aiReady, aiReady ? providers[0].name : "未配置");
  // Only a configured section gets a pill; without one the section itself says what to add.
  elements.aiSectionPill.hidden = !aiReady;
  if (aiReady) setPill(elements.aiSectionPill, true, `已配置 ${providers.length} 个平台`);

  const { obsidianEnabled, obsidianApiKey } = savedForm.payload;
  const obsidianConnected = obsidianTest?.ok && obsidianTest.target === obsidianTarget(savedForm.payload);
  const obsidianText = !obsidianEnabled ? "关" : !obsidianApiKey ? "待填 Key" : obsidianConnected ? "已连接" : "已开";
  setPill(elements.obsidianPill, obsidianEnabled && Boolean(obsidianApiKey), obsidianText);
  elements.obsidianPill.classList.toggle("off", !obsidianEnabled);

  // Open for first-time setup; once a key is saved it folds to one line. Only flips when that changes, so a guide the user opened stays open.
  const firstSetup = !obsidianApiKey;
  if (elements.obsidianGuide.classList.contains("first") !== firstSetup) {
    elements.obsidianGuide.classList.toggle("first", firstSetup);
    elements.obsidianGuide.open = firstSetup;
  }
  syncObsidianKeyTag();
  syncObsidianTest();
}

function setPill(node, ok, text) {
  node.textContent = text;
  node.classList.toggle("ok", ok);
  node.classList.toggle("off", !ok);
}

function syncObsidianKeyTag() {
  const saved = savedForm?.payload.obsidianApiKey;
  elements.obsidianKeyTag.hidden = !saved || MdgSettings.normalizeApiKey(elements.obsidianApiKey.value) !== saved;
}

// 测试连接 needs the 地址 and the Key: disabled with the reason while either box is empty, like an AI platform row's.
// While a save or a test runs it stays disabled; setBusy(null) calls this again.
// The result next to it is for the 地址 and Key it tested: an edit away from them clears it.
function syncObsidianTest() {
  const typed = { obsidianApiBaseUrl: normalizeBaseUrl(elements.obsidianApiBaseUrl.value), obsidianApiKey: MdgSettings.normalizeApiKey(elements.obsidianApiKey.value) };
  if (obsidianTest && obsidianTest.target !== obsidianTarget(typed)) setTestResult("");
  if (busyButton) return;
  const missing = [["地址", elements.obsidianApiBaseUrl], ["Key", elements.obsidianApiKey]].filter(([, box]) => !box.value.trim()).map(([name]) => name);
  MdgErrors.setReason(elements.testConnectionBtn, missing.length ? `先填 Local REST API ${missing.join("和 ")}` : "", "用填好的地址和 Key 连一次 Obsidian 的 Local REST API");
}

function syncSaveBar() {
  elements.saveBar.hidden = !hasUnsavedChanges && !elements.status.textContent;
  elements.unsavedHint.hidden = !hasUnsavedChanges;
  elements.saveBtn.hidden = !hasUnsavedChanges;
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
  const normalizedApiKey = MdgSettings.normalizeApiKey(elements.obsidianApiKey.value);

  return {
    obsidianEnabled: elements.obsidianEnabled.checked,
    noteFolder: elements.noteFolder.value.trim(),
    obsidianApiBaseUrl: normalizedBaseUrl,
    obsidianApiKey: normalizedApiKey,
    tags: elements.tags.value.trim(),
    downloadFormat: MdgSettings.normalizeDownloadFormat(elements.downloadFormat.value),
    youtubeSubtitleLang: elements.youtubeSubtitleLang.value,
    includeDateInFilename: elements.includeDateInFilename.checked,
    includeHotCommentsInNote: elements.includeHotCommentsInNote.checked,
    includeCoverInNote: elements.includeCoverInNote.checked,
    includeAiChatInNote: elements.includeAiChatInNote.checked,
    enablePlayerAiQuickAction: elements.enablePlayerAiQuickAction.checked,
    playerAiQuickPrompt: MdgSettings.normalizePlayerAiQuickPrompt(elements.playerAiQuickPrompt.value),
    includeTimestampInBody: elements.includeTimestampInBody.checked,
    showBiliTriageBadges: elements.showBiliTriageBadges.checked,
    showBiliUpTags: elements.showBiliUpTags.checked,
    showBiliVerdicts: elements.showBiliVerdicts.checked,
    biliMarksOff: Array.from(elements.biliMarks.querySelectorAll("input[data-cell]:not(:checked)"), (input) => input.dataset.cell),
    seenShow: elements.seenShow.value,
    seenThreshold: MdgSettings.normalizeSeenThreshold(elements.seenThreshold.value),
    seenStyle: MdgSettings.normalizeSeenStyle(elements.seenStyle.value),
    enableDebugLogs: elements.enableDebugLogs.checked,
    frontmatterFields: selectedFields,
    fixedFrontmatterProperties: MdgSettings.normalizeFixedFrontmatterProperties(collectFixedPropertyRows()),
    notePlaceholderSections: MdgSettings.normalizeNotePlaceholderSections(collectNoteSectionRows()),
    aiSystemPrompt: String(elements.aiSystemPrompt?.value || "").trim(),
    aiPresetPrompts: MdgSettings.normalizeAiPresetPrompts(elements.aiPresetPrompts.value.split("\n")),
    webAiSystemPrompt: String(elements.webAiSystemPrompt?.value || "").trim(),
    webAiSummaryPrompt: MdgSettings.normalizePlayerAiQuickPrompt(elements.webAiSummaryPrompt.value),
    webAiPresetPrompts: MdgSettings.normalizeAiPresetPrompts(elements.webAiPresetPrompts.value.split("\n"))
  };
}

// testing: 测试连接 checks only the 地址, even while Obsidian is off (an empty Key cannot get here: syncObsidianTest).
function validateSettings(payload, { testing }) {
  if (!payload.obsidianEnabled && !testing) {
    return validateNoteExtras();
  }
  const folder = testing ? { ok: true } : validateNoteFolder(payload.noteFolder);
  if (!folder.ok) return folder;

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
  // [::1] is not in manifest host_permissions, so requests to it would fail.
  if (hostname === "[::1]") {
    return { ok: false, field: elements.obsidianApiBaseUrl, message: "不支持 [::1]，请改用 127.0.0.1" };
  }
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    return {
      ok: false,
      field: elements.obsidianApiBaseUrl,
      message: "请使用本机地址（127.0.0.1 或 localhost），不要填写公网/局域网地址"
    };
  }

  if ((parsedUrl.pathname && parsedUrl.pathname !== "/") || parsedUrl.search || parsedUrl.hash) {
    return { ok: false, field: elements.obsidianApiBaseUrl, message: "地址请只填写到端口，例如 http://127.0.0.1:27123" };
  }

  return testing ? { ok: true } : validateNoteExtras();
}

// A path inside the vault: a . or .. folder would point the write somewhere else.
function validateNoteFolder(folder) {
  const error = (message) => ({ ok: false, field: elements.noteFolder, message });
  if (!folder) return error("请填写笔记目录（例如：MoonDigest/{{site}}）");
  if (/^[\/\\]|[\/\\]$/.test(folder)) return error("笔记目录不要以 / 开头或结尾");
  if (/[\\:*?"<>|\u0000-\u001f]/.test(folder)) return error('笔记目录不能包含 \\ : * ? " < > | 这些字符');
  if (folder.split("/").some((part) => /^\s*\.{1,2}\s*$/.test(part))) return error("笔记目录不能包含 . 或 .. 这样的文件夹");
  return { ok: true };
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

// The 视频 / 网页 prompt tabs. Arrow keys move between them, as in any tablist.
function showPromptTab(tab) {
  for (const t of document.querySelectorAll('.kind-tabs [role="tab"]')) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
  }
}

function initPromptTabs() {
  const tabs = [...document.querySelectorAll('.kind-tabs [role="tab"]')];
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => showPromptTab(tab));
    tab.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = tabs[(i + step + tabs.length) % tabs.length];
      showPromptTab(next);
      next.focus();
    });
  });
}

function applyValidationError(validation) {
  clearInputErrors();
  validation?.row?.closest("details")?.setAttribute("open", "");
  if (validation?.field) {
    validation.field.classList.add("input-error");
    validation.field.focus();
  }
  // A property or section row's own error line repeats the message under the row (validation.field marks its box).
  const rowError = validation?.row?.querySelector(".fixed-property-error, .note-section-error");
  if (rowError) {
    rowError.hidden = false;
    rowError.textContent = validation.message;
  }
  setStatus(validation?.message || "设置校验失败", true);
}

function clearInputErrors() {
  document.querySelectorAll(".input-error").forEach((input) => input.classList.remove("input-error"));
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
  const type = MdgSettings.normalizeFixedPropertyType(item.type);
  const row = document.createElement("div");
  row.className = "fixed-property-row";
  row.innerHTML = `
    <div class="fixed-property-fields">
      <div class="fixed-property-field fixed-property-field-type">${buildFixedPropertyTypePicker(type)}</div>
      <div class="fixed-property-field fixed-property-field-key">
        <input class="fixed-property-key" name="fixedPropertyKey" type="text" placeholder="属性名" value="${escapeHtml(item.key)}" />
      </div>
      <div class="fixed-property-field fixed-property-field-value">
        <div class="fixed-property-value-slot">${buildFixedPropertyValueControl(type, item.value)}</div>
      </div>
      <div class="fixed-property-field fixed-property-field-remove">
        <button class="fixed-property-remove" type="button" aria-label="删除属性" title="删除属性">
          ${TRASH_ICON}
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
      const nextType = MdgSettings.normalizeFixedPropertyType(option.getAttribute("data-type"));
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
  rows.forEach((item) => addNoteSectionRow(item));
  updateNoteSectionEmptyState();
}

function addNoteSectionRow(item = {}) {

  const position = MdgSettings.normalizeNoteSectionPosition(item.position);
  const row = document.createElement("div");
  row.className = "note-section-row";
  row.innerHTML = `
    <div class="note-section-fields">
      <div class="note-section-field note-section-field-position">
        <select class="note-section-position" name="noteSectionPosition" aria-label="段落位置">
          ${buildNoteSectionPositionOptions(position)}
        </select>
      </div>
      <div class="note-section-field note-section-field-title">
        <input class="note-section-title" name="noteSectionTitle" type="text" placeholder="段落标题，例：总结" value="${escapeHtml(item.title)}" />
      </div>
      <div class="note-section-field note-section-field-content">
        <input class="note-section-content" name="noteSectionContent" type="text" placeholder="默认内容（可空）" value="${escapeHtml(item.content)}" />
      </div>
      <div class="note-section-field note-section-field-remove">
        <button class="note-section-remove" type="button" aria-label="删除段落" title="删除段落">
          ${TRASH_ICON}
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

// Also 「+ 添加段落」: disabled with the reason at MAX_NOTE_SECTIONS rows, not clickable only to say so.
function updateNoteSectionEmptyState() {
  const count = elements.noteSectionsList.children.length;
  elements.noteSectionsEmpty.hidden = count > 0;
  MdgErrors.setReason(elements.addNoteSectionBtn, count >= MdgSettings.MAX_NOTE_SECTIONS ? `最多 ${MdgSettings.MAX_NOTE_SECTIONS} 段，先删掉一段再添加` : "");
}

function collectNoteSectionRows({ includeRow = false } = {}) {
  return Array.from(elements.noteSectionsList.querySelectorAll(".note-section-row")).map((row) => {
    const item = {
      title: String(row.querySelector(".note-section-title")?.value || "").trim(),
      position: MdgSettings.normalizeNoteSectionPosition(row.querySelector(".note-section-position")?.value),
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
  if (rows.length > MdgSettings.MAX_NOTE_SECTIONS) {
    return { ok: false, message: `正文附加段落最多 ${MdgSettings.MAX_NOTE_SECTIONS} 段` };
  }
  for (const item of rows) {
    const title = String(item?.title || "").trim();
    const content = String(item?.content || "").trim();
    if (content && !title) {
      return { ok: false, row: item.row, field: item.row?.querySelector(".note-section-title"), message: "请填写段落标题" };
    }
  }
  return { ok: true };
}

function buildNoteSectionPositionOptions(selectedPosition) {
  const current = MdgSettings.normalizeNoteSectionPosition(selectedPosition);
  return Object.entries(MdgSettings.NOTE_SECTION_LABELS)
    .map(([value, label]) => `<option value="${value}" ${value === current ? "selected" : ""}>${label}</option>`)
    .join("");
}

function collectFixedPropertyRows({ includeRow = false } = {}) {
  return Array.from(elements.fixedPropertiesList.querySelectorAll(".fixed-property-row")).map((row) => {
    const type = MdgSettings.normalizeFixedPropertyType(row.querySelector(".fixed-property-type-picker")?.getAttribute("data-type"));
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
    const type = MdgSettings.normalizeFixedPropertyType(item?.type);
    const value = item?.value;
    const lowerKey = key.toLowerCase();
    const valueText = typeof value === "string" ? value.trim() : "";
    // The message goes under the row; the box it is about is marked.
    const keyError = (message) => ({ ok: false, row: item.row, field: item.row?.querySelector(".fixed-property-key"), message });
    const valueError = (message) => ({ ok: false, row: item.row, field: item.row?.querySelector(".fixed-property-value"), message });

    if (!key && MdgSettings.isFixedPropertyRowEffectivelyEmpty(type, value)) {
      continue;
    }
    if (!key) {
      return keyError("请填写自定属性的属性名");
    }
    // note.js leaves out any other name, so the settings page does not take it.
    if (!MdgSettings.FIXED_PROPERTY_KEY_RE.test(key)) {
      return keyError(key.startsWith("-") ? "属性名不能以短横线开头，笔记里会被读成列表" : "属性名只能包含文字、数字、空格、下划线和短横线");
    }
    const token = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/.exec(valueText)?.[1];
    const typedVar = Boolean(token) && (TYPED_PROPERTY_VARS[type] || []).includes(token);
    const orVars = (TYPED_PROPERTY_VARS[type] || []).map((name) => `{{${name}}}`).join("、");

    if (type === "number") {
      if (!valueText) {
        return valueError("请填写数字类型的属性值");
      }
      if (!typedVar && !Number.isFinite(Number(valueText))) {
        return valueError(`数字类型的属性值必须是有效数字，或 ${orVars}`);
      }
    } else if (type === "checkbox") {
      if (!valueText) {
        return valueError("请填写复选框类型的属性值");
      }
      const normalizedCheckboxValue = valueText.toLowerCase();
      if (normalizedCheckboxValue !== "true" && normalizedCheckboxValue !== "false") {
        return valueError("复选框类型的属性值只能填写 true 或 false");
      }
    } else if (type === "date") {
      if (!valueText) {
        return valueError("请填写日期类型的属性值");
      }
      if (!typedVar && !isCalendarDate(valueText)) {
        return valueError(`日期类型请填写存在的日期 YYYY-MM-DD，或 ${orVars}`);
      }
    } else if (!valueText) {
      return valueError("请填写自定属性的属性值");
    }
    if (Array.from(elements.frontmatterFields).some((checkbox) => checkbox.value === lowerKey)) {
      return keyError("该属性名与自带属性重复，请换一个名称");
    }
    if (seenKeys.has(lowerKey)) {
      return keyError("自定属性名不能重复");
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

// YYYY-MM-DD naming a day that exists (2026-02-30 does not).
function isCalendarDate(text) {
  const day = new Date(`${text}T00:00:00Z`);
  return FRONTMATTER_DATE_VALUE_RE.test(text) && !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === text;
}

function readFixedPropertyValue(row) {
  return String(row.querySelector(".fixed-property-value")?.value || "").trim();
}

function buildFixedPropertyValueControl(type, value) {
  const normalizedType = MdgSettings.normalizeFixedPropertyType(type);
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
  return `<input class="fixed-property-value" name="fixedPropertyValue" type="text" placeholder="${placeholder}" value="${escapeHtml(value)}" />`;
}

function buildFixedPropertyTypePicker(type) {
  const normalizedType = MdgSettings.normalizeFixedPropertyType(type);
  return `
    <div class="fixed-property-type-picker" data-type="${normalizedType}" data-open="false">
      <button class="fixed-property-type-button" type="button" aria-label="属性类型" aria-haspopup="true" aria-expanded="false">
        <span class="fixed-property-type-label">${getFixedPropertyTypeLabel(normalizedType)}</span>
        <svg viewBox="0 0 12 12" focusable="false" aria-hidden="true">
          <path d="M2.25 4.5 6 8.25 9.75 4.5"></path>
        </svg>
      </button>
      <div class="fixed-property-type-menu" hidden>
        ${Object.entries(FIXED_PROPERTY_TYPE_LABELS).map(([value, label]) => `<button class="fixed-property-type-option" type="button" data-type="${value}">${label}</button>`).join("")}
      </div>
    </div>
  `;
}

function getFixedPropertyTypeLabel(type) {
  return FIXED_PROPERTY_TYPE_LABELS[MdgSettings.normalizeFixedPropertyType(type)];
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

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/g, "");
}


async function testConnection() {
  clearInputErrors();
  const payload = collectFormPayload();
  const validation = validateSettings(payload, { testing: true });
  if (!validation.ok) {
    applyValidationError(validation);
    return;
  }

  setBusy(elements.testConnectionBtn);
  setTestResult("");
  obsidianTest = { target: obsidianTarget(payload), ok: false };
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "test-obsidian-connection",
      baseUrl: payload.obsidianApiBaseUrl,
      apiKey: payload.obsidianApiKey
    });

    obsidianTest.ok = Boolean(resp?.ok);
    if (!resp?.ok) {
      setTestResult(`失败：${MdgErrors.text(resp)}`, true);
      return;
    }

    const service = resp?.service ? `（${resp.service}）` : "";
    setTestResult(`连接成功${service}${hasUnsavedChanges ? "，记得保存设置" : ""}`);
  } catch (error) {
    setTestResult(`失败：${error.message || MdgErrors.TEXT.unknown}`, true);
  } finally {
    setBusy(null);
    renderSavedState();
  }
}

function obsidianTarget(settings) {
  return `${settings.obsidianApiBaseUrl}\n${settings.obsidianApiKey}`;
}

// The Obsidian test result sits next to its button.
function setTestResult(text, isError = false) {
  elements.obsidianTestResult.textContent = text;
  elements.obsidianTestResult.dataset.error = String(isError);
}

// Both buttons wait while either runs; the running one gets the shared busy look from tokens.css. Idle, each shows
// its words from options.html.
function setBusy(active) {
  busyButton = active;
  for (const [button, busy] of [[elements.saveBtn, "保存中…"], [elements.testConnectionBtn, "测试中…"]]) {
    button.dataset.idle ??= button.textContent;
    button.disabled = Boolean(active);
    button.textContent = button === active ? busy : button.dataset.idle;
    button.setAttribute("aria-busy", String(button === active));
  }
  if (!active) syncObsidianTest();
}

// ===== AI 模型平台 =====

async function loadAiProviders() {
  const resp = await chrome.runtime.sendMessage({ type: "ai-providers-list" });
  if (!resp?.ok) throw MdgErrors.fromResp(resp);
  return Array.isArray(resp.providers) ? resp.providers : [];
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

// An AI platform address that sends the API Key in clear text over the internet: http:// to a public host. Saving it is
// allowed (a user may run an encrypted tunnel); the row only warns. Not warned: this computer and the local network,
// 100.64.0.0/10 and *.ts.net (Tailscale-style encrypted networks), a host name without a dot, IPv6 loopback and private.
const PLAIN_HTTP_WARNING = "这个地址不是 https，Key 会明文发出，确认这条线路是加密的再用";
function plainHttpWarning(url) {
  let host;
  try {
    const parsed = new URL(String(url || "").trim());
    if (parsed.protocol !== "http:") return "";
    host = parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
  const [a, b] = host.split(".").map(Number);
  const privateV4 = /^\d+\.\d+\.\d+\.\d+$/.test(host) && (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  const local = host.startsWith("[") ? /^\[(::1\]|f[cd]|fe[89ab])/.test(host) : !host.includes(".") || /\.(local|ts\.net)$/.test(host) || privateV4;
  return local ? "" : PLAIN_HTTP_WARNING;
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
  row.dataset.keyOrigin = urlOrigin(baseUrl);
  row.dataset.currentPresetId = presetId;
  row.innerHTML = `
    <select class="ai-provider-preset" name="aiProviderPreset" aria-label="平台">
      ${AI_PRESETS.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === presetId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
    </select>
    <input class="ai-provider-baseurl" name="aiProviderBaseUrl" type="text" aria-label="${AI_FIELD.baseUrl}" placeholder="如 https://api.openai.com/v1" value="${escapeHtml(baseUrl)}" />
    <input class="ai-provider-model" name="aiProviderModel" type="text" aria-label="${AI_FIELD.model}" placeholder="如 gpt-6-luna" value="${escapeHtml(model)}" />
    <div class="key">
      <input class="ai-provider-apikey" name="aiProviderApiKey" type="password" aria-label="${AI_FIELD.key}" placeholder="${apiKeyPlaceholder(hasSavedKey, requiresKey)}" autocomplete="off" />
      <span class="keytag"${hasSavedKey ? "" : " hidden"}>已保存</span>
    </div>
    <button type="button" class="sm ai-provider-test"><span class="ai-spark" aria-hidden="true"></span>测试连接</button>
    <button type="button" class="ai-provider-remove">
      ${TRASH_ICON}
    </button>
    <p class="ai-provider-warn" hidden></p>
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
    row.dataset.currentPresetId = next.id;
    syncKey();
    syncTest();
    syncWarn();
    hideStatus();
  });

  // A test result is for the values it tested: an edit hides it, and a test running meanwhile shows nothing.
  const statusNode = row.querySelector(".ai-provider-status");
  const hideStatus = () => {
    statusNode.hidden = true;
    row.dataset.edited = "1";
  };
  for (const sel of [".ai-provider-baseurl", ".ai-provider-model", ".ai-provider-apikey"]) row.querySelector(sel).addEventListener("input", hideStatus);

  // 测试连接 needs this row's 接口地址 and 模型: disabled with the reason while either box is empty.
  const testBtn = row.querySelector(".ai-provider-test");
  const syncTest = () => {
    if (row.dataset.testing) return; // a running test keeps the button off until it answers
    const missing = [[AI_FIELD.baseUrl, ".ai-provider-baseurl"], [AI_FIELD.model, ".ai-provider-model"]].filter(([, sel]) => !row.querySelector(sel).value.trim()).map(([name]) => name);
    MdgErrors.setReason(testBtn, missing.length ? `先填${missing.join("和")}` : "", "用这一行的地址、模型和 Key 向 AI 发一条测试消息");
  };
  syncTest();
  for (const sel of [".ai-provider-baseurl", ".ai-provider-model"]) row.querySelector(sel).addEventListener("input", syncTest);

  // Long addresses end in an ellipsis; hovering shows the whole one.
  const baseUrlInput = row.querySelector(".ai-provider-baseurl");
  const warnNode = row.querySelector(".ai-provider-warn");
  const syncWarn = () => {
    warnNode.textContent = plainHttpWarning(baseUrlInput.value);
    warnNode.hidden = !warnNode.textContent;
  };
  syncWarn();
  baseUrlInput.addEventListener("input", syncWarn);
  baseUrlInput.addEventListener("mouseenter", () => {
    baseUrlInput.title = baseUrlInput.value;
  });

  const keyInput = row.querySelector(".ai-provider-apikey");
  const syncKey = () => {
    const saved = savedKeyApplies(row);
    const preset = AI_PRESETS.find((p) => p.id === row.querySelector(".ai-provider-preset").value) || AI_PRESETS.at(-1);
    keyInput.placeholder = apiKeyPlaceholder(saved, preset.requiresKey);
    row.querySelector(".keytag").hidden = !saved || Boolean(keyInput.value);
  };
  keyInput.addEventListener("input", syncKey);
  baseUrlInput.addEventListener("input", syncKey);

  // Two clicks in place instead of a system dialog: the first turns the trash icon into 「确认删除」.
  const removeBtn = row.querySelector(".ai-provider-remove");
  const name = (text) => {
    removeBtn.setAttribute("aria-label", text);
    removeBtn.title = text;
  };
  name("删除平台");
  const disarm = () => {
    if (!removeBtn.classList.contains("armed")) return;
    removeBtn.classList.remove("armed");
    removeBtn.innerHTML = TRASH_ICON;
    name("删除平台");
  };
  removeBtn.addEventListener("blur", disarm);
  // A delete the background did not write keeps the row, with why.
  removeBtn.addEventListener("click", async () => {
    if (!removeBtn.classList.contains("armed")) {
      removeBtn.classList.add("armed");
      removeBtn.textContent = "确认删除";
      name("再点一次删除平台，它保存的 API Key 也一起删除");
      removeBtn.focus();
      return;
    }
    const resp = await chrome.runtime.sendMessage({ type: "ai-providers-delete", providerId: row.dataset.providerId }).catch((error) => ({ ok: false, error: error.message }));
    if (!resp?.ok) {
      disarm();
      showAiProviderStatus(statusNode, `${MdgErrors.TEXT.deleteFailed}：${MdgErrors.text(resp)}`, true);
      return;
    }
    row.remove();
    updateAiProvidersEmptyState();
    updateSavedProviders((list) => list.filter((item) => item.id !== row.dataset.providerId));
  });

  testBtn.addEventListener("click", () => testAiProviderRow(row, syncTest));

  elements.aiProvidersList.appendChild(row);
  updateAiProvidersEmptyState();
}

// 测试连接 with what the row says now, saved or not. An address not saved yet may lack its host permission: it is asked
// for first, in this click (permissions.request needs the user gesture, so nothing is awaited before it), and a granted
// one is not asked again. Declined, or the background found it missing: the status says so, with 授权.
// The background checks 接口地址, 模型名 and API Key (aiProviderProblem) and answers in the side panel's words.
// sync: the row's own check, which leaves 测试连接 disabled while 接口地址 or 模型 is empty.
async function testAiProviderRow(row, sync) {
  const statusNode = row.querySelector(".ai-provider-status");
  const testBtn = row.querySelector(".ai-provider-test");
  const baseUrl = row.querySelector(".ai-provider-baseurl").value.trim();
  const pattern = hostPermissionPattern(baseUrl);
  const asked = pattern ? chrome.permissions.request({ origins: [pattern] }).catch(() => false) : true;
  const apiKey = row.querySelector(".ai-provider-apikey").value.trim();
  const model = row.querySelector(".ai-provider-model").value.trim();
  const requiresKey = (AI_PRESETS.find((p) => p.id === row.querySelector(".ai-provider-preset").value) || AI_PRESETS.at(-1)).requiresKey;
  showAiProviderStatus(statusNode, "正在测试…");
  statusNode.setAttribute("aria-busy", "true");
  testBtn.disabled = true;
  row.dataset.testing = "1";
  delete row.dataset.edited;
  const resp = !(await asked)
    ? { ok: false, error: MdgErrors.noAccess(pattern.replace(/\/\*$/, "")), code: "AI_ACCESS" }
    : await chrome.runtime.sendMessage({ type: "ai-providers-test", providerId: savedKeyApplies(row) ? row.dataset.providerId || "" : "", baseUrl, apiKey, model, requiresKey }).catch((error) => ({
        ok: false,
        error: error.message
      }));
  statusNode.setAttribute("aria-busy", "false");
  delete row.dataset.testing;
  sync();
  if (row.dataset.edited) return;
  if (resp?.ok) {
    showAiProviderStatus(statusNode, hasUnsavedChanges ? "连接成功，记得保存设置" : "连接成功");
    return;
  }
  showAiProviderStatus(statusNode, `失败：${MdgErrors.text(resp)}`, true);
  const access = MdgErrors.grantOrigin(resp?.error, resp?.code);
  if (access) {
    const grant = document.createElement("button");
    grant.type = "button";
    grant.className = "sm";
    grant.textContent = MdgErrors.LABEL.grant;
    grant.addEventListener("click", async () => {
      if (await access.request()) await testAiProviderRow(row, sync);
    });
    statusNode.append(" ", grant);
  }
}

// A saved Key belongs to the host it was saved for: once 接口地址 points at another host it is neither sent nor counted as
// filled, so switching platform asks for that platform's Key.
function savedKeyApplies(row) {
  return row.dataset.hasSavedKey === "1" && urlOrigin(row.querySelector(".ai-provider-baseurl").value) === row.dataset.keyOrigin;
}

function urlOrigin(url) {
  try {
    return new URL(String(url).trim()).origin;
  } catch {
    return "";
  }
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
      hasSavedKey: savedKeyApplies(row)
    };
  });
}

function hostPermissionUrls(settings, providers) {
  return [settings.obsidianEnabled ? settings.obsidianApiBaseUrl : "", ...providers.map((item) => item.baseUrl)];
}

// Loopback hosts are in host_permissions already; everything else is optional.
function hostPermissionPattern(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (!/^https?:$/.test(parsed.protocol) || ["localhost", "127.0.0.1"].includes(parsed.hostname)) {
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

// Points at the row (index) and its box (a selector) that is wrong.
function validateAiProviders(items) {
  const seenIds = new Set();
  for (const [index, item] of items.entries()) {
    const error = (box, message) => ({ ok: false, index, box, message });
    const missing = (field, box) => error(box, `平台「${item.name}」需要填写${field}`);
    if (!item.baseUrl) return missing(AI_FIELD.baseUrl, ".ai-provider-baseurl");
    try {
      const u = new URL(item.baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return error(".ai-provider-baseurl", `接口地址必须以 http(s):// 开头（${item.baseUrl}）`);
      }
    } catch {
      return error(".ai-provider-baseurl", `接口地址格式不正确：${item.baseUrl}`);
    }
    if (item.requiresKey && !item.apiKey && !item.hasSavedKey) return missing(` ${AI_FIELD.key}`, ".ai-provider-apikey");
    if (!item.model) return missing(AI_FIELD.model, ".ai-provider-model");
    if (seenIds.has(item.id)) return error("", `平台 id 重复，${MdgErrors.TEXT.reloadRetry}`);
    seenIds.add(item.id);
  }
  return { ok: true };
}
