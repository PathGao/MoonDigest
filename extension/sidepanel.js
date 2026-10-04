const SELECTED_PROVIDER_KEY = "boc_ai_selected_provider";
const CONVERSATIONS_STORAGE_KEY = BocLimits.KEYS.aiConversations;
const NOTE_PATHS_STORAGE_KEY = BocLimits.KEYS.obsidianNotePaths;
const {
  stripThinkBlocks,
  normalizeMarkdownForSectionPaste,
  isTimestampOnlyInlineCode,
  TIMESTAMP_PATTERN,
  buildConversationTurns,
  buildAiConversationFilename,
  buildAiConversationMarkdown,
  resolveFolderTemplate,
  buildNoteFilename,
  sanitizeFileName
} = BocNote;
const PLAYER_AI_QUICK_ACTION_STORAGE_KEY = "boc_player_ai_quick_action_v1";
const NON_VIDEO_CONTEXT_MESSAGE = "当前页不是支持的视频页面，<br>无法获取当前页面信息作为对话上下文，<br>仅支持 AI 对话。";
const STREAM_SLOW_NOTICE_MS = 15000;
const FOLLOW_PLAYBACK_KEY = "boc_sp_follow_playback";
const PREVIOUS_VIDEO_CONVERSATION_KEY = "boc_sp_previous_video_conversation";
const FOLLOWED_LIVE_VIDEO = "followed";

const els = {
  header: document.querySelector(".sp-header"),
  contextChip: document.getElementById("spContextChip"),
  refreshBtn: document.getElementById("spRefreshBtn"),
  followBtn: document.getElementById("spFollowBtn"),
  previousVideoBar: document.getElementById("spPreviousVideo"),
  modelSelect: document.getElementById("spModelSelect"),
  settingsBtn: document.getElementById("spSettingsBtn"),
  newChatBtn: document.getElementById("spNewChatBtn"),
  presetBtn: document.getElementById("spPresetBtn"),
  historyBtn: document.getElementById("spHistoryBtn"),
  saveConversationBtn: document.getElementById("spSaveConversationBtn"),
  syncStatus: document.getElementById("spSyncStatus"),
  copyConversationBtn: document.getElementById("spCopyConversationBtn"),
  downloadConversationBtn: document.getElementById("spDownloadConversationBtn"),
  presetPopover: document.getElementById("spPresetPopover"),
  presetList: document.getElementById("spPresetList"),
  presetInput: document.getElementById("spPresetInput"),
  presetAddBtn: document.getElementById("spPresetAddBtn"),
  followups: document.getElementById("spFollowups"),
  historyPopover: document.getElementById("spHistoryPopover"),
  exportBtn: document.getElementById("spExportBtn"),
  exportPopover: document.getElementById("spExportPopover"),
  historyList: document.getElementById("spHistoryList"),
  historyClearBtn: document.getElementById("spHistoryClearBtn"),
  messages: document.getElementById("spMessages"),
  input: document.getElementById("spInput"),
  stopBtn: document.getElementById("spStopBtn"),
};

const DEFAULT_AI_PREFS = {
  aiSystemPrompt: "",
  playerAiQuickPrompt: "",
  aiPresetPrompts: []
};

let contextData = null;
let currentContextKey = "";
let providers = [];
let activeStream = null;
let sendPending = false;
let chatHistory = [];
let suggestionsNode = null;
let aiPrefs = { ...DEFAULT_AI_PREFS };
let savedConversations = [];
let currentConversationId = "";
let currentConversationMeta = null;
let liveContextData = null;
let liveContextKey = "";
let liveTabUrl = "";
let contextNoticeTimer = 0;
let shouldAutoScrollMessages = true;
let liveContextSyncTimer = 0;
let liveContextSyncForceRefresh = false;
let modelSelectMeasureCanvas = null;
let streamSlowNoticeTimer = 0;
let streamFirstTokenReceived = false;
let initCompleted = false;
let followPlayback = localStorage.getItem(FOLLOW_PLAYBACK_KEY) !== "0";
let lastLiveVideoUrl = "";
let previousVideoConversationId = "";
let previousVideoExpanded = false;
let previousVideoBarSignature = "";

init().catch((err) => {
  resetConversationView(`初始化失败：${escapeHtml(err?.message || err)}`);
});

async function init() {
  bindEvents();
  renderFollowButton();
  await loadProvidersAndPrefs();
  await loadSavedConversations();
  await loadPreviousVideoConversationId();
  await loadContextState();
  await restoreLatestConversationForCurrentContext();
  renderInitialState();
  autosizeInput();
  initCompleted = true;
  await consumePendingPlayerAiQuickAction();
}

function bindEvents() {
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  els.input.addEventListener("input", autosizeInput);
  els.messages.addEventListener("scroll", () => {
    shouldAutoScrollMessages = isMessagesNearBottom();
  });
  els.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.contextChip.addEventListener("click", () => {
    void openCurrentContextUrl();
  });
  els.newChatBtn.addEventListener("click", () => {
    void startNewConversation();
  });
  els.refreshBtn.addEventListener("click", () => refreshContextManually());
  els.followBtn?.addEventListener("click", () => {
    followPlayback = !followPlayback;
    localStorage.setItem(FOLLOW_PLAYBACK_KEY, followPlayback ? "1" : "0");
    renderFollowButton();
  });
  els.previousVideoBar?.addEventListener("click", handlePreviousVideoBarClick);
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== "boc-video-changed") {
      return false;
    }
    void getActiveTab()
      .then((tab) => {
        if (tab?.id && sender?.tab?.id === tab.id) {
          scheduleLiveContextSync(true);
        }
      })
      .catch(() => {});
    return false;
  });
  els.presetBtn.addEventListener("click", togglePresetPopover);
  els.historyBtn.addEventListener("click", toggleHistoryPopover);
  els.exportBtn.addEventListener("click", toggleExportPopover);
  // Each export action closes the menu; the action itself is bound below.
  els.exportPopover.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("button")) hideExportPopover();
  });
  els.saveConversationBtn?.addEventListener("click", () => {
    void saveCurrentConversationToObsidian();
  });
  els.copyConversationBtn?.addEventListener("click", () => {
    void copyCurrentConversationMarkdown();
  });
  els.downloadConversationBtn?.addEventListener("click", () => {
    const note = buildCurrentConversationNote();
    if (note) BocDownload.text(note.filename, note.content);
    else showConversationContextNotice("当前没有可下载的对话。", 2200);
  });
  els.historyClearBtn?.addEventListener("click", () => {
    void clearAllConversations();
  });
  els.stopBtn?.addEventListener("click", () => {
    stopActiveStream();
  });
  els.presetAddBtn.addEventListener("click", addPresetPrompt);
  els.presetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      addPresetPrompt();
    }
  });
  els.modelSelect.addEventListener("change", () => {
    if (els.modelSelect.value) {
      localStorage.setItem(SELECTED_PROVIDER_KEY, els.modelSelect.value);
    }
    updateModelSelectWidth();
  });
  window.addEventListener("resize", updateModelSelectWidth);
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleLiveContextSync(true);
    }
  });
  window.addEventListener("focus", () => {
    scheduleLiveContextSync(true);
  });
  chrome.tabs.onActivated.addListener(() => {
    scheduleLiveContextSync(true);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab?.active) {
      return;
    }
    if (!changeInfo.url && changeInfo.status !== "complete") {
      return;
    }
    scheduleLiveContextSync(Boolean(changeInfo.url));
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      (areaName === "sync" &&
        (changes.aiProviders ||
          changes.aiSystemPrompt ||
          changes.playerAiQuickPrompt ||
          changes.aiPresetPrompts ||
          changes.obsidianEnabled)) ||
      (areaName === "local" && changes.aiProviderKeys)
    ) {
      void refreshProvidersAndPrefsAfterExternalChange();
    }
    // The history page deletes conversations too; without this the next save here would bring them back.
    if (areaName === "local" && changes[CONVERSATIONS_STORAGE_KEY]) {
      savedConversations = normalizeConversations(changes[CONVERSATIONS_STORAGE_KEY].newValue);
      renderHistoryList();
    }
    if (areaName === "local" && changes[PLAYER_AI_QUICK_ACTION_STORAGE_KEY] && initCompleted) {
      void handlePlayerAiQuickActionRequest(changes[PLAYER_AI_QUICK_ACTION_STORAGE_KEY].newValue);
    }
  });
}

function autosizeInput() {
  els.input.style.height = "auto";
  const next = Math.min(els.input.scrollHeight, 320);
  const minHeight = document.body.classList.contains("sp-non-video-context") ? 72 : 94;
  els.input.style.height = `${Math.max(next, minHeight)}px`;
}

function setStreamingUiState(isStreaming, { stopping = false } = {}) {
  els.input.disabled = isStreaming;
  renderFollowups();
  if (els.stopBtn) {
    els.stopBtn.hidden = !isStreaming;
    els.stopBtn.disabled = stopping;
    els.stopBtn.textContent = stopping ? "停止中..." : "停止";
  }
}

async function loadProvidersAndPrefs({ preferredProviderId = "" } = {}) {
  const [providersResp, settingsResp] = await Promise.all([
    sendRuntimeMessage({ type: "ai-providers-list" }),
    sendRuntimeMessage({ type: "get-settings" }).catch(() => ({ ok: false }))
  ]);
  providers = Array.isArray(providersResp?.providers)
    ? providersResp.providers.filter((p) => p.enabled)
    : [];
  document.body.classList.toggle("sp-obsidian-off", settingsResp?.settings?.obsidianEnabled !== true);
  aiPrefs = {
    aiSystemPrompt: String(settingsResp?.settings?.aiSystemPrompt || "").trim(),
    playerAiQuickPrompt: String(settingsResp?.settings?.playerAiQuickPrompt || "").trim(),
    aiPresetPrompts: Array.isArray(settingsResp?.settings?.aiPresetPrompts)
      ? settingsResp.settings.aiPresetPrompts.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12)
      : []
  };
  renderModelSelect(preferredProviderId);
  renderPresetPrompts();
  renderFollowups();
}

function renderModelSelect(preferredProviderId = "") {
  if (!providers.length) {
    els.modelSelect.innerHTML = '<option value="">未配置平台</option>';
    els.modelSelect.disabled = true;
    updateModelSelectWidth();
    return;
  }

  els.modelSelect.innerHTML = providers
    .map((p) => {
      const label = String(p.model || p.name || "").trim();
      return `<option value="${escapeHtml(p.id)}">${escapeHtml(label)}</option>`;
    })
    .join("");

  const savedProviderId = String(preferredProviderId || localStorage.getItem(SELECTED_PROVIDER_KEY) || "").trim();
  const matchedProvider = providers.find((item) => item.id === savedProviderId) || providers[0];
  els.modelSelect.value = matchedProvider?.id || "";
  els.modelSelect.disabled = false;
  updateModelSelectWidth();
}

async function refreshProvidersAndPrefsAfterExternalChange() {
  const previousProviderId = String(els.modelSelect?.value || localStorage.getItem(SELECTED_PROVIDER_KEY) || "").trim();
  await loadProvidersAndPrefs({ preferredProviderId: previousProviderId });
  if (activeStream) {
    return;
  }
  renderHistoryList();
  renderInitialState();
}

async function consumePendingPlayerAiQuickAction() {
  const data = await chrome.storage.local.get([PLAYER_AI_QUICK_ACTION_STORAGE_KEY]).catch(() => ({}));
  const request = normalizePlayerAiQuickActionRequest(data?.[PLAYER_AI_QUICK_ACTION_STORAGE_KEY]);
  if (!request) {
    return false;
  }
  return handlePlayerAiQuickActionRequest(request, { fromStorageChange: false });
}

function normalizePlayerAiQuickActionRequest(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const id = String(value.id || "").trim();
  const prompt = String(value.prompt || "").trim();
  const tabId = Number(value.tabId || 0) || 0;
  if (!id || !tabId) {
    return null;
  }
  return {
    id,
    prompt,
    tabId,
    createdAt: Number(value.createdAt) || Date.now(),
    contextRef: value.contextRef && typeof value.contextRef === "object" ? value.contextRef : null
  };
}

async function handlePlayerAiQuickActionRequest(value, { fromStorageChange = true } = {}) {
  const request = normalizePlayerAiQuickActionRequest(value);
  if (!request) {
    return false;
  }

  const activeTab = await getActiveTab().catch(() => null);
  if (activeTab?.id && request.tabId !== activeTab.id) {
    return false;
  }

  if (fromStorageChange) {
    await chrome.storage.local.remove(PLAYER_AI_QUICK_ACTION_STORAGE_KEY).catch(() => null);
  } else {
    const latest = await chrome.storage.local.get([PLAYER_AI_QUICK_ACTION_STORAGE_KEY]).catch(() => ({}));
    const latestId = String(latest?.[PLAYER_AI_QUICK_ACTION_STORAGE_KEY]?.id || "").trim();
    if (latestId && latestId !== request.id) {
      return false;
    }
    await chrome.storage.local.remove(PLAYER_AI_QUICK_ACTION_STORAGE_KEY).catch(() => null);
  }

  if (request.contextRef) {
    await openRequestedVideoContext(request.contextRef);
  }
  await runPlayerAiQuickActionPrompt(request.prompt);
  return true;
}

// The triage and history pages hand over a video that is not open: continue its latest conversation,
// else start one bound to it, and resolve the context like a history conversation.
async function openRequestedVideoContext(ref) {
  await detachActiveStream();
  const contextRef = normalizeConversationContextRef(ref);
  const placeholder = buildContextPlaceholder(contextRef);
  if (!(await restoreLatestConversationForCurrentContext(placeholder, buildContextKey(placeholder)))) {
    applyConversation({ id: "", contextKey: "", contextTitle: placeholder.title, contextUrl: placeholder.url, contextRef, messages: [] });
  }
  renderInitialState();
  showConversationContextNotice("正在加载原视频上下文...");
  await hydratePinnedConversationContext();
}

async function runPlayerAiQuickActionPrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text) {
    autosizeInput();
    els.input?.focus?.();
    return;
  }
  await startNewConversation();
  els.input.value = text;
  autosizeInput();
  await sendMessage();
}

function updateModelSelectWidth() {
  if (!els.modelSelect) {
    return;
  }
  const selectedOption = els.modelSelect.options[els.modelSelect.selectedIndex];
  const text = String(selectedOption?.textContent || "").trim() || "未配置平台";
  const computedStyle = window.getComputedStyle(els.modelSelect);
  const measuredTextWidth = measureTextWidth(text, computedStyle);
  const extraCharsWidth = measureTextWidth("000", computedStyle);
  const desiredWidth = Math.ceil(measuredTextWidth + extraCharsWidth + 36);
  const minWidth = 92;
  const maxWidth = getModelSelectMaxWidth();
  const nextWidth = Math.max(minWidth, Math.min(desiredWidth, maxWidth));
  els.modelSelect.style.width = `${nextWidth}px`;
}

function measureTextWidth(text, style) {
  if (!modelSelectMeasureCanvas) {
    modelSelectMeasureCanvas = document.createElement("canvas");
  }
  const ctx = modelSelectMeasureCanvas.getContext("2d");
  if (!ctx) {
    return text.length * 8;
  }
  const fontStyle = style?.fontStyle || "normal";
  const fontVariant = style?.fontVariant || "normal";
  const fontWeight = style?.fontWeight || "400";
  const fontSize = style?.fontSize || "11px";
  const fontFamily = style?.fontFamily || "sans-serif";
  ctx.font = `${fontStyle} ${fontVariant} ${fontWeight} ${fontSize} ${fontFamily}`;
  return ctx.measureText(text).width;
}

function getModelSelectMaxWidth() {
  const header = els.header;
  if (!header || !els.contextChip || !els.refreshBtn || !els.settingsBtn) {
    return 172;
  }
  const style = window.getComputedStyle(header);
  const gap = Number.parseFloat(style.columnGap || style.gap || "0") || 0;
  const paddingLeft = Number.parseFloat(style.paddingLeft || "0") || 0;
  const paddingRight = Number.parseFloat(style.paddingRight || "0") || 0;
  const contentWidth = header.clientWidth - paddingLeft - paddingRight;
  const siblingWidth =
    els.contextChip.offsetWidth +
    els.refreshBtn.offsetWidth +
    (els.followBtn?.offsetWidth || 0) +
    els.settingsBtn.offsetWidth +
    gap * (els.followBtn ? 4 : 3);
  return Math.max(92, Math.floor(contentWidth - siblingWidth));
}

// A conversation owns the context its first question was asked in. Tab changes only update the live context
// (and contextData while no conversation or reply holds it), so they never relabel an existing or in-flight one.
function isContextBound() {
  return currentConversationMeta?.pinnedContext === true || Boolean(activeStream);
}

async function loadContextState({ forceRefresh = false, silent = false, follow = false } = {}) {
  const tab = await getActiveTab();
  if (!tab?.id) {
    liveContextData = null;
    liveContextKey = "";
    liveTabUrl = "";
    if (!isContextBound()) {
      contextData = null;
      currentContextKey = "";
    }
    updateContextChip();
    if (!silent && !isContextBound()) {
      resetConversationView("找不到当前标签页。");
    }
    return false;
  }

  liveTabUrl = String(tab.url || "").trim();
  // Subtitles and comments take seconds to load, but the tab URL already names the new video, so following
  // switches now and the full reply below fills the context in. Watch-later URLs name the part by oid, not ?p=.
  const tabRef = follow ? BocSites.parseRef(liveTabUrl) : null;
  let followed = false;
  if (tabRef && !tabRef.part?.oid && isFollowCandidate(lastLiveVideoUrl, tabRef.url)) {
    lastLiveVideoUrl = tabRef.url;
    await detachActiveStream();
    await followLiveVideo(buildTabVideoPlaceholder(tab, tabRef));
    followed = true;
  }

  const resp = await sendRuntimeMessage({
    type: "ai-sidepanel-get-state",
    tabId: tab.id,
    forceRefresh
  }).catch((error) => ({ ok: false, error: error.message }));

  if (!resp?.ok || !resp.payload) {
    liveContextData = null;
    liveContextKey = "";
    if (!isContextBound()) {
      contextData = null;
      currentContextKey = "";
    }
    updateContextChip();
    if (!silent && !isContextBound()) {
      resetConversationView(escapeHtml(resp?.error || "当前页面上下文读取失败。"));
    }
    return false;
  }

  liveContextData = resp.payload;
  liveContextKey = buildContextKey(resp.payload);
  const followFromUrl = lastLiveVideoUrl;
  const liveVideoUrl = resp.payload.isVideoContext !== false && liveContextKey.startsWith("video:") ? String(resp.payload.url || "") : "";
  if (liveVideoUrl) {
    lastLiveVideoUrl = liveVideoUrl;
  }
  if (follow && isFollowCandidate(followFromUrl, liveVideoUrl)) {
    await detachActiveStream();
    await followLiveVideo(liveContextData);
    return FOLLOWED_LIVE_VIDEO;
  }
  if (isContextBound()) {
    renderHistoryList();
    updateContextChip();
    return followed ? FOLLOWED_LIVE_VIDEO : true;
  }

  const contextChanged = applyContextPayload(resp.payload);
  renderHistoryList();
  if (contextChanged) {
    await restoreLatestConversationForCurrentContext();
    renderInitialState();
  }
  return followed ? FOLLOWED_LIVE_VIDEO : true;
}

// Stands in for a followed video until its subtitles load; sending always waits for the full context.
function buildTabVideoPlaceholder(tab, ref) {
  const title = String(tab.title || "").replace(/_哔哩哔哩_bilibili$| - YouTube$/, "").trim();
  return {
    ...buildContextPlaceholder({ site: ref.site, videoId: ref.id, url: ref.url, pageIndex: ref.part?.index || 1 }),
    // Right after an in-page navigation the tab can still carry the previous video's title.
    title: title === contextData?.title ? "" : title,
    pending: true
  };
}

function applyContextPayload(payload) {
  const nextContext = payload && typeof payload === "object" ? payload : null;
  const nextKey = buildContextKey(nextContext);
  // An empty key (loading or blank tab) is a different context too, so returning to a video restores its conversation.
  // A followed video's placeholder has no cid yet, so its full context is matched by URL.
  const fillsPlaceholder = Boolean(contextData?.pending && doesTabMatchContextUrl(nextContext?.url || "", contextData.url));
  const contextChanged = !fillsPlaceholder && nextKey !== currentContextKey;

  contextData = nextContext;
  currentContextKey = nextKey;
  updateContextChip();

  if (contextChanged) {
    restartChat({ keepContext: true });
  } else {
    renderSuggestions();
  }
  return contextChanged;
}

function buildContextKey(payload) {
  if (!payload) {
    return "";
  }
  const videoKey = BocSites.buildContextKey(buildConversationContextRef(payload) || {});
  if (videoKey) {
    return videoKey;
  }
  const normalizedUrl = normalizeContextUrlForKey(payload.url);
  return normalizedUrl ? `url:${normalizedUrl}` : "";
}

function normalizeContextUrlForKey(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  try {
    const parsed = new URL(text);
    parsed.hash = "";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return text;
  }
}

function updateContextChip() {
  if (!contextData) {
    els.contextChip.textContent = "无上下文";
    els.contextChip.title = "";
    els.contextChip.disabled = true;
    els.contextChip.classList.remove("is-mismatch");
    return;
  }

  const shortTitle = contextData.title ? truncate(contextData.title, 19) : contextData.pending ? "加载中…" : "未知视频";
  els.contextChip.textContent = shortTitle;
  const mismatch = isBoundConversationMismatched();
  els.contextChip.classList.toggle("is-mismatch", mismatch);
  els.contextChip.title = contextData.url
    ? `${contextData.title || ""}${mismatch ? "\n当前页不是这个对话绑定的视频" : ""}\n点击跳转目标视频，或开启新对话`
    : contextData.title || "";
  els.contextChip.disabled = !String(contextData.url || "").trim();
}

function isBoundConversationMismatched() {
  if (currentConversationMeta?.pinnedContext !== true) {
    return false;
  }
  const targetUrl = String(currentConversationMeta?.contextUrl || contextData?.url || "").trim();
  if (!targetUrl) {
    return false;
  }
  if (!liveTabUrl) {
    return true;
  }
  return !doesTabMatchContextUrl(liveTabUrl, targetUrl);
}

async function openCurrentContextUrl() {
  const targetUrl = String(contextData?.url || currentConversationMeta?.contextUrl || "").trim();
  if (!targetUrl) {
    return;
  }
  const tab = await getActiveTab().catch(() => null);
  if (!tab?.id) {
    return;
  }
  try {
    const sameVideo = doesTabMatchContextUrl(tab.url || "", targetUrl);
    if (!sameVideo) {
      await chrome.tabs.update(tab.id, { url: targetUrl });
      await waitForTabComplete(tab.id);
    }
    await loadContextState({ forceRefresh: true, silent: true });
  } catch {}
}

function renderInitialState() {
  updateSidepanelLayoutState();
  if (!contextData) {
    resetConversationView("当前页面不是支持的视频页，无法读取视频信息。");
    return;
  }
  if (!providers.length) {
    resetConversationView('还没有配置 AI 平台，<a href="#" id="spOpenSettings">前往设置</a>');
    document.getElementById("spOpenSettings")?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    return;
  }
  if (chatHistory.length) {
    renderConversationMessages();
    return;
  }
  if (contextData.isVideoContext === false) {
    resetConversationView(NON_VIDEO_CONTEXT_MESSAGE);
    return;
  }
  resetConversationView("");
}

function resetConversationView(stateHtml = "") {
  updateSidepanelLayoutState();
  els.messages.innerHTML = "";
  if (stateHtml) {
    const stateNode = document.createElement("div");
    stateNode.className = "sp-center-error";
    stateNode.innerHTML = stateHtml;
    els.messages.appendChild(stateNode);
  }
  suggestionsNode = document.createElement("div");
  suggestionsNode.className = "sp-suggestions";
  suggestionsNode.id = "spSuggestions";
  els.messages.appendChild(suggestionsNode);
  renderSuggestions();
  renderPresetPrompts();
  renderFollowups();
  shouldAutoScrollMessages = true;
  scrollToBottom(true);
}

function renderSuggestions() {
  if (!suggestionsNode) {
    return;
  }
  if (!contextData || !providers.length || chatHistory.length || contextData.isVideoContext === false) {
    suggestionsNode.innerHTML = "";
    return;
  }
  const prompt = aiPrefs.playerAiQuickPrompt;
  suggestionsNode.innerHTML = prompt
    ? `<button type="button" class="sp-summary-btn" title="${escapeHtml(prompt)}">总结这期视频</button>`
    : "";
  suggestionsNode.querySelector("button")?.addEventListener("click", () => sendPrompt(prompt));
  void renderTriageSummary(suggestionsNode);
}

// A summary the triage page already paid for, shown before the first question; nothing is requested here.
// It is per bvid and summarizes P1, so other parts don't show it.
async function renderTriageSummary(node) {
  const ref = buildConversationContextRef(contextData);
  if (ref?.site !== "bilibili" || ref.pageIndex !== 1) {
    return;
  }
  const key = `triage_analysis_${ref.videoId}`;
  const summary = BocNote.buildTriageSummary((await chrome.storage.local.get(key))[key]);
  if (!summary || node !== suggestionsNode || chatHistory.length || buildConversationContextRef(contextData)?.videoId !== ref.videoId) {
    return;
  }
  node.querySelector(".sp-triage-summary")?.remove();
  // renderMarkdown has no blockquotes, so the one-liner loses its "> ".
  node.insertAdjacentHTML("afterbegin", `<div class="sp-triage-summary"><div class="sp-triage-summary-label">分拣台的 AI 总结</div>${renderMarkdown(summary.replace(/^> /, ""))}</div>`);
}

// Follow-up chips: only once there is a reply to follow up on, and not mid-stream.
// Long lists show the first few plus a visible toggle instead of a hidden scroll area.
const FOLLOWUP_PREVIEW = 4;
let followupsExpanded = false;

function renderFollowups() {
  if (!els.followups) {
    return;
  }
  const show = !els.input.disabled && chatHistory.some((message) => message.role === "assistant");
  const prompts = show ? aiPrefs.aiPresetPrompts || [] : [];
  const collapsible = prompts.length > FOLLOWUP_PREVIEW + 1;
  const visible = collapsible && !followupsExpanded ? prompts.slice(0, FOLLOWUP_PREVIEW) : prompts;
  els.followups.hidden = !prompts.length;
  els.followups.innerHTML = visible
    .map((prompt) => `<button type="button" class="sp-followup-chip" title="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>`)
    .join("");
  els.followups.querySelectorAll("button").forEach((btn, index) => {
    btn.addEventListener("click", () => sendPrompt(visible[index]));
  });
  if (collapsible) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "sp-followup-chip sp-followup-more";
    toggle.textContent = followupsExpanded ? "收起" : `更多 ${prompts.length - FOLLOWUP_PREVIEW} 个`;
    toggle.setAttribute("aria-expanded", String(followupsExpanded));
    toggle.addEventListener("click", () => {
      followupsExpanded = !followupsExpanded;
      renderFollowups();
    });
    els.followups.append(toggle);
  }
}

function sendPrompt(prompt) {
  els.input.value = prompt;
  autosizeInput();
  void sendMessage();
}

function renderPresetPrompts() {
  if (!els.presetList) {
    return;
  }
  const prompts = Array.isArray(aiPrefs.aiPresetPrompts) ? aiPrefs.aiPresetPrompts : [];
  if (!prompts.length) {
    els.presetList.innerHTML = '<span class="sp-preset-empty">还没有快捷追问</span>';
    return;
  }
  els.presetList.innerHTML = prompts
    .map((prompt, index) => `
      <span class="sp-preset-item">
        <button type="button" class="sp-preset-chip" data-index="${index}" title="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>
        <button type="button" class="sp-preset-remove" data-index="${index}" aria-label="删除快捷追问">×</button>
      </span>
    `)
    .join("");
  els.presetList.querySelectorAll(".sp-preset-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const index = Number(btn.getAttribute("data-index") || -1);
      insertPresetPrompt(prompts[index] || "");
      hidePresetPopover();
    });
  });
  els.presetList.querySelectorAll(".sp-preset-remove").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const index = Number(btn.getAttribute("data-index") || -1);
      await removePresetPrompt(index);
    });
  });
}

function renderHistoryList() {
  renderPreviousVideoBar();
  if (!els.historyList) {
    return;
  }
  if (els.historyClearBtn) {
    els.historyClearBtn.hidden = savedConversations.length === 0;
  }
  if (!savedConversations.length) {
    els.historyList.innerHTML = '<span class="sp-history-empty">还没有历史对话</span>';
    return;
  }

  const liveVideoRef = liveContextData?.isVideoContext ? liveContextData : null;
  const canHighlightLiveMatches = Boolean(
    liveVideoRef &&
    currentConversationMeta?.pinnedContext &&
    currentConversationMeta?.contextUrl &&
    !doesTabMatchContextUrl(liveVideoRef.url || liveTabUrl, currentConversationMeta.contextUrl || "")
  );

  els.historyList.innerHTML = savedConversations
    .map((conversation) => {
      const isActive = conversation.id === currentConversationId;
      const isLiveMatch = Boolean(
        !isActive &&
        canHighlightLiveMatches &&
        doesConversationMatchCurrentContext(conversation, liveVideoRef, liveContextKey)
      );
      const metaText = formatConversationTimestamp(conversation.updatedAt || conversation.createdAt);
      const titleDisplay = buildConversationTitleDisplay(conversation.title, 30);
      return `
        <div class="sp-history-item ${isActive ? "is-active" : ""} ${isLiveMatch ? "is-live-match" : ""}" data-id="${escapeHtml(conversation.id)}">
          <button type="button" class="sp-history-open" data-id="${escapeHtml(conversation.id)}">
            <span class="sp-history-title" title="${escapeHtml(conversation.title)}">
              <span class="sp-history-title-main">${escapeHtml(titleDisplay.main)}</span>
              ${titleDisplay.suffix ? `<span class="sp-history-title-suffix">${escapeHtml(titleDisplay.suffix)}</span>` : ""}
            </span>
            <span class="sp-history-meta" title="${escapeHtml(metaText)}">${escapeHtml(metaText)}</span>
          </button>
          <button type="button" class="sp-history-remove" data-id="${escapeHtml(conversation.id)}" aria-label="删除历史对话">×</button>
        </div>
      `;
    })
    .join("");

  els.historyList.querySelectorAll(".sp-history-open").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = String(btn.getAttribute("data-id") || "");
      loadConversationById(id);
      hideHistoryPopover();
    });
  });

  els.historyList.querySelectorAll(".sp-history-remove").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const id = String(btn.getAttribute("data-id") || "");
      await deleteConversation(id);
    });
  });
}

async function loadSavedConversations() {
  const data = await chrome.storage.local.get([CONVERSATIONS_STORAGE_KEY]).catch(() => ({}));
  savedConversations = normalizeConversations(data?.[CONVERSATIONS_STORAGE_KEY]);
  renderHistoryList();
  void hydrateConversationPageMetadata();
}

function normalizeConversations(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const messages = Array.isArray(item?.messages)
        ? item.messages
            .filter((msg) => msg && (msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string")
            .map((msg) => ({ role: msg.role, content: String(msg.content) }))
        : [];
      const id = String(item?.id || "").trim();
      if (!id || !messages.length) {
        return null;
      }
      const contextTitle = String(item?.contextTitle || "").trim();
      const contextRef = normalizeConversationContextRef(item?.contextRef || item?.contextSnapshot || item);
      const contextUrl = String(item?.contextUrl || "").trim();
      return {
        id,
        title: normalizeConversationTitle(item?.title, contextTitle, contextRef, contextUrl),
        contextKey: resolveConversationStorageKey(item?.contextKey, contextRef, contextUrl),
        contextTitle,
        contextUrl,
        isVideoContext: item?.isVideoContext !== false,
        createdAt: Number(item?.createdAt) || Date.now(),
        updatedAt: Number(item?.updatedAt) || Date.now(),
        contextRef,
        pageHydrated: item?.pageHydrated === true,
        messages
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, BocLimits.AI_CONVERSATIONS);
}

function resolveConversationStorageKey(rawKey, contextRef, contextUrl = "") {
  const normalizedRefKey = buildContextKey(contextRef);
  if (normalizedRefKey) {
    return normalizedRefKey;
  }
  const normalizedUrlKey = buildContextKey({ url: contextUrl });
  if (normalizedUrlKey) {
    return normalizedUrlKey;
  }
  return String(rawKey || "").trim();
}

async function hydrateConversationPageMetadata() {
  const candidates = savedConversations
    .filter((item) => needsConversationPageHydration(item))
    .slice(0, 12);
  if (!candidates.length) {
    return;
  }

  let changed = false;
  for (const conversation of candidates) {
    const contextRef = conversation.contextRef || null;
    if (!contextRef?.videoId) {
      continue;
    }
    const response = await sendRuntimeMessage({
      type: "ai-sidepanel-resolve-page-ref",
      contextRef
    }).catch(() => null);
    if (!response?.ok || !response.payload) {
      continue;
    }
    // One successful lookup settles the page metadata; without the flag every open refetched it.
    conversation.pageHydrated = true;
    changed = true;

    const payload = response.payload;
    const nextPageIndex = Number(payload.pageIndex) > 0 ? Number(payload.pageIndex) : 1;
    const nextUrl = String(payload.url || conversation.contextUrl || contextRef.url || "").trim();
    const nextContextRef = {
      ...contextRef,
      url: nextUrl,
      cid: String(payload.cid || contextRef.cid || "").trim(),
      pageIndex: nextPageIndex,
      pageTitle: String(payload.pageTitle || contextRef.pageTitle || "").trim()
    };
    const nextTitle = normalizeConversationTitle(conversation.title, conversation.contextTitle, nextContextRef, nextUrl);
    const nextContextKey = resolveConversationStorageKey(conversation.contextKey, nextContextRef, nextUrl);
    if (
      nextTitle === conversation.title &&
      nextUrl === conversation.contextUrl &&
      nextContextKey === conversation.contextKey &&
      Number(conversation.contextRef?.pageIndex || 1) === nextPageIndex
    ) {
      continue;
    }

    conversation.title = nextTitle;
    conversation.contextUrl = nextUrl;
    conversation.contextKey = nextContextKey;
    conversation.contextRef = nextContextRef;
  }

  if (!changed) {
    return;
  }

  if (currentConversationId) {
    const activeConversation = savedConversations.find((item) => item.id === currentConversationId);
    if (activeConversation) {
      currentConversationMeta = {
        ...currentConversationMeta,
        title: activeConversation.title,
        contextKey: activeConversation.contextKey,
        contextUrl: activeConversation.contextUrl,
        contextRef: activeConversation.contextRef
      };
    }
  }
  renderHistoryList();
  updateContextChip();
  await saveConversations();
}

function needsConversationPageHydration(conversation) {
  if (!conversation?.isVideoContext || conversation.pageHydrated) {
    return false;
  }
  if (/-P\d+$/i.test(String(conversation.title || "").trim())) {
    return false;
  }
  const pageIndex = Number(conversation.contextRef?.pageIndex || 0) || 0;
  if (pageIndex > 1) {
    return true;
  }
  const urlPageIndex = extractPageIndexFromContextUrl(conversation.contextUrl || conversation.contextRef?.url || "");
  if (urlPageIndex > 1) {
    return true;
  }
  return conversation.contextRef?.site === "bilibili" && Boolean(conversation.contextRef?.videoId && conversation.contextRef?.cid);
}

async function saveConversations() {
  savedConversations = normalizeConversations(savedConversations);
  await chrome.storage.local.set({
    [CONVERSATIONS_STORAGE_KEY]: savedConversations.slice(0, BocLimits.AI_CONVERSATIONS)
  });
  renderHistoryList();
}

async function restoreLatestConversationForCurrentContext(currentRef = liveContextData || contextData, targetContextKey = liveContextKey || currentContextKey) {
  const latest = savedConversations.find((item) => doesConversationMatchCurrentContext(item, currentRef, targetContextKey));
  if (!latest) {
    currentConversationId = "";
    currentConversationMeta = null;
    chatHistory = [];
    return false;
  }
  applyConversation(latest);
  return true;
}

function doesConversationMatchCurrentContext(conversation, currentRef, targetContextKey = "") {
  if (!conversation) {
    return false;
  }
  const normalizedConversationKey = resolveConversationStorageKey(
    conversation.contextKey,
    conversation.contextRef,
    conversation.contextUrl
  );
  const normalizedTargetKey = String(targetContextKey || buildContextKey(currentRef)).trim();
  if (normalizedConversationKey && normalizedTargetKey && normalizedConversationKey === normalizedTargetKey) {
    return true;
  }

  const conversationUrl = String(conversation.contextUrl || conversation.contextRef?.url || "").trim();
  const currentUrl = String(currentRef?.url || "").trim();
  if (conversationUrl && currentUrl) {
    return doesTabMatchContextUrl(currentUrl, conversationUrl);
  }
  return false;
}

function applyConversation(conversation) {
  if (!conversation) {
    return;
  }
  currentConversationId = conversation.id;
  currentConversationMeta = {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    contextKey: conversation.contextKey,
    contextTitle: conversation.contextTitle,
    contextUrl: conversation.contextUrl,
    isVideoContext: conversation.isVideoContext !== false,
    pinnedContext: true,
    contextRef: conversation.contextRef || null,
    resolvedContext: null
  };
  chatHistory = Array.isArray(conversation.messages)
    ? conversation.messages.map((item) => ({ role: item.role, content: String(item.content || "") }))
    : [];
  if (liveContextData && conversation.contextKey && conversation.contextKey === liveContextKey) {
    contextData = { ...liveContextData };
    currentContextKey = liveContextKey;
    currentConversationMeta.resolvedContext = { ...liveContextData };
  } else if (conversation.contextRef) {
    contextData = buildContextPlaceholder(conversation.contextRef);
    currentContextKey = conversation.contextKey || buildContextKey(contextData);
  }
  updateContextChip();
  renderHistoryList();
}

async function loadConversationById(id) {
  const conversation = savedConversations.find((item) => item.id === id);
  if (!conversation || (activeStream && id === currentConversationId)) {
    return;
  }
  // The reply in flight belongs to the conversation it was asked in, not to the one being opened.
  await detachActiveStream();
  applyConversation(conversation);
  renderInitialState();
  if (conversation.contextKey && conversation.contextKey !== liveContextKey) {
    showConversationContextNotice("正在加载原视频上下文...");
    void hydratePinnedConversationContext({ silent: true });
  }
}

async function deleteConversation(id) {
  const wasCurrent = id && id === currentConversationId;
  savedConversations = savedConversations.filter((item) => item.id !== id);
  await saveConversations();
  if (!wasCurrent) {
    return;
  }
  currentConversationId = "";
  currentConversationMeta = null;
  chatHistory = [];
  if (liveContextData) {
    contextData = { ...liveContextData };
    currentContextKey = liveContextKey || buildContextKey(liveContextData);
    updateContextChip();
  }
  renderInitialState();
}

async function clearAllConversations() {
  if (!savedConversations.length) {
    return;
  }
  if (!confirm("确定要清空全部历史对话吗？")) {
    return;
  }
  savedConversations = [];
  currentConversationId = "";
  currentConversationMeta = null;
  chatHistory = [];
  await saveConversations();
  hideHistoryPopover();
  if (liveContextData) {
    contextData = { ...liveContextData };
    currentContextKey = liveContextKey || buildContextKey(liveContextData);
    updateContextChip();
  }
  renderInitialState();
}

function insertPresetPrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text) {
    return;
  }
  const current = els.input.value.trim();
  els.input.value = current ? `${current}\n${text}` : text;
  els.input.focus();
  autosizeInput();
}

function togglePresetPopover(event) {
  event?.stopPropagation();
  hideHistoryPopover();
  hideExportPopover();
  const willShow = els.presetPopover.hidden;
  els.presetPopover.hidden = !willShow;
  if (willShow) {
    renderPresetPrompts();
    els.presetInput.value = "";
    els.presetInput.focus();
  }
}

function hidePresetPopover() {
  els.presetPopover.hidden = true;
}

function toggleHistoryPopover(event) {
  event?.stopPropagation();
  hidePresetPopover();
  hideExportPopover();
  const willShow = els.historyPopover.hidden;
  els.historyPopover.hidden = !willShow;
  if (willShow) {
    renderHistoryList();
  }
}

function hideHistoryPopover() {
  els.historyPopover.hidden = true;
}

function toggleExportPopover(event) {
  event?.stopPropagation();
  hidePresetPopover();
  hideHistoryPopover();
  els.exportPopover.hidden = !els.exportPopover.hidden;
}

function hideExportPopover() {
  els.exportPopover.hidden = true;
}

function handleDocumentClick(event) {
  if (els.presetPopover.hidden && els.historyPopover.hidden && els.exportPopover.hidden) {
    return;
  }
  if (!(event.target instanceof Element)) {
    hidePresetPopover();
    hideHistoryPopover();
    hideExportPopover();
    return;
  }
  if (event.target.closest("#spPresetPopover") || event.target.closest("#spPresetBtn")) {
    return;
  }
  if (event.target.closest("#spHistoryPopover") || event.target.closest("#spHistoryBtn")) {
    return;
  }
  if (event.target.closest("#spExportPopover") || event.target.closest("#spExportBtn")) {
    return;
  }
  hidePresetPopover();
  hideHistoryPopover();
  hideExportPopover();
}

function scheduleLiveContextSync(forceRefresh = false) {
  liveContextSyncForceRefresh = liveContextSyncForceRefresh || forceRefresh;
  if (liveContextSyncTimer) {
    window.clearTimeout(liveContextSyncTimer);
  }
  liveContextSyncTimer = window.setTimeout(() => {
    const nextForceRefresh = liveContextSyncForceRefresh;
    liveContextSyncTimer = 0;
    liveContextSyncForceRefresh = false;
    void syncLiveContextState(nextForceRefresh);
  }, forceRefresh ? 120 : 220);
}

async function syncLiveContextState(forceRefresh = false) {
  const ok = await loadContextState({ forceRefresh, silent: true, follow: true }).catch(() => false);
  if (ok === FOLLOWED_LIVE_VIDEO) {
    return;
  }
  if (isContextBound()) {
    updateContextChip();
    return;
  }
  if (!ok || !contextData || !providers.length || !chatHistory.length) {
    renderInitialState();
    return;
  }
  renderSuggestions();
}

// 跟随播放：只在当前对话绑定的是“刚才在播的视频”（或还没有对话）时才切走，
// 用户主动打开的无关历史对话不动。视频按 URL（站点、id、分 P）比较，标签页 URL 和完整上下文都能判断。
function isFollowCandidate(fromUrl, toUrl) {
  if (!followPlayback || !fromUrl || !toUrl || doesTabMatchContextUrl(toUrl, fromUrl)) {
    return false;
  }
  if (!currentConversationMeta && !chatHistory.length) {
    return true;
  }
  return doesTabMatchContextUrl(currentConversationMeta?.contextUrl || contextData?.url || "", fromUrl);
}

// Switching videos mid-reply hands the reply to its saved conversation, which then becomes the previous-video bar.
// The port stays open, so the background keeps streaming while the new video is usable at once.
async function detachActiveStream() {
  const stream = activeStream;
  if (!stream) {
    return;
  }
  activeStream = null;
  clearStreamRuntimeState();
  chatHistory.push({ role: "user", content: stream.prompt });
  // The id is assigned before the first await, so a reply ending during the save still finds its conversation.
  const saving = persistCurrentConversation(stream);
  stream.conversationId = currentConversationId;
  stream.promptIndex = chatHistory.length - 1;
  await saving;
}

// Puts the answer after its question, or drops the question when nothing came back.
// chatHistory gets the same patch when the user has reopened that conversation meanwhile.
async function finishDetachedStream({ conversationId, promptIndex, prompt, raw }) {
  const conversation = savedConversations.find((item) => item.id === conversationId);
  if (!conversation) {
    return;
  }
  const isCurrent = conversationId === currentConversationId;
  [conversation.messages, ...(isCurrent ? [chatHistory] : [])].forEach((messages) => {
    if (messages[promptIndex]?.role !== "user" || messages[promptIndex].content !== prompt || messages[promptIndex + 1]?.role === "assistant") {
      return;
    }
    if (raw.trim()) {
      messages.splice(promptIndex + 1, 0, { role: "assistant", content: raw });
    } else {
      messages.splice(promptIndex, 1);
    }
  });
  conversation.updatedAt = Date.now();
  await saveConversations();
  scheduleAutoSync(conversationId);
  if (isCurrent && !activeStream) {
    renderConversationMessages();
  }
}

async function followLiveVideo(context) {
  const previous = currentConversationId && chatHistory.length
    ? savedConversations.find((item) => item.id === currentConversationId)
    : null;
  if (previous) {
    setPreviousVideoConversation(previous.id);
  }
  contextData = { ...context };
  currentContextKey = buildContextKey(context);
  const draft = els.input.value;
  restartChat({ keepContext: true });
  els.input.value = draft;
  autosizeInput();
  await restoreLatestConversationForCurrentContext(contextData, currentContextKey);
  renderHistoryList();
  updateContextChip();
  renderInitialState();
  showConversationContextNotice(`已切换到新视频：${truncate(context.title || "未知视频", 24)}`, 2500);
}

function renderFollowButton() {
  if (!els.followBtn) {
    return;
  }
  els.followBtn.classList.toggle("is-active", followPlayback);
  els.followBtn.setAttribute("aria-pressed", followPlayback ? "true" : "false");
  els.followBtn.title = `跟随播放：视频切换时自动切到新视频（${followPlayback ? "已开启" : "已关闭"}）`;
}

async function loadPreviousVideoConversationId() {
  const data = await chrome.storage.session?.get([PREVIOUS_VIDEO_CONVERSATION_KEY]).catch(() => ({}));
  previousVideoConversationId = String(data?.[PREVIOUS_VIDEO_CONVERSATION_KEY] || "").trim();
  renderPreviousVideoBar();
}

function setPreviousVideoConversation(id) {
  previousVideoConversationId = String(id || "");
  previousVideoExpanded = false;
  if (previousVideoConversationId) {
    void chrome.storage.session?.set({ [PREVIOUS_VIDEO_CONVERSATION_KEY]: previousVideoConversationId }).catch(() => {});
  } else {
    void chrome.storage.session?.remove(PREVIOUS_VIDEO_CONVERSATION_KEY).catch(() => {});
  }
  renderPreviousVideoBar();
}

function renderPreviousVideoBar() {
  const bar = els.previousVideoBar;
  if (!bar) {
    return;
  }
  const conversation = previousVideoConversationId
    ? savedConversations.find((item) => item.id === previousVideoConversationId)
    : null;
  if (!conversation) {
    previousVideoBarSignature = "";
    bar.hidden = true;
    if (previousVideoConversationId) {
      setPreviousVideoConversation("");
    }
    return;
  }
  const isCurrent = conversation.id === currentConversationId;
  const signature = [conversation.id, conversation.updatedAt, conversation.messages.length, previousVideoExpanded, isCurrent].join("|");
  if (signature === previousVideoBarSignature) {
    return;
  }
  previousVideoBarSignature = signature;
  bar.hidden = isCurrent;
  if (isCurrent) {
    return;
  }
  const title = conversation.contextTitle || conversation.title || "未知视频";
  const messagesHtml = previousVideoExpanded
    ? conversation.messages
        .map((message) =>
          message.role === "user"
            ? `<div class="sp-msg sp-msg-user">${escapeHtml(message.content)}</div>`
            : `<div class="sp-msg sp-msg-assistant"><div class="sp-msg-assistant-body">${renderMarkdown(message.content)}</div></div>`
        )
        .join("")
    : "";
  bar.innerHTML = `
    <div class="sp-prev-head">
      <button type="button" class="sp-prev-toggle" data-action="toggle" aria-expanded="${previousVideoExpanded}" title="${escapeHtml(title)}">
        <span class="sp-prev-label">上一个视频：</span>
        <span class="sp-prev-title">${escapeHtml(title)}</span>
        <span class="sp-prev-count">· ${conversation.messages.length} 条消息</span>
        <svg class="sp-prev-chevron" viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
      </button>
      <button type="button" class="sp-prev-dismiss" data-action="dismiss" aria-label="关闭上一个视频" title="关闭">×</button>
    </div>
    ${previousVideoExpanded ? `
    <div class="sp-prev-body">
      <div class="sp-prev-messages">${messagesHtml}</div>
      <div class="sp-prev-actions">
        <button type="button" class="sp-prev-action" data-action="resume">回到这个对话</button>
        <button type="button" class="sp-prev-action" data-action="open">打开视频</button>
      </div>
    </div>` : ""}
  `;
}

function handlePreviousVideoBarClick(event) {
  const action = event.target instanceof Element ? event.target.closest("[data-action]")?.getAttribute("data-action") : "";
  const conversation = savedConversations.find((item) => item.id === previousVideoConversationId);
  if (!action || !conversation) {
    return;
  }
  if (action === "toggle") {
    previousVideoExpanded = !previousVideoExpanded;
    renderPreviousVideoBar();
  } else if (action === "dismiss") {
    setPreviousVideoConversation("");
  } else if (action === "resume") {
    previousVideoExpanded = false;
    loadConversationById(conversation.id);
  } else if (action === "open") {
    void openPreviousVideoUrl(conversation.contextUrl || conversation.contextRef?.url || "");
  }
}

async function openPreviousVideoUrl(url) {
  const targetUrl = String(url || "").trim();
  const tab = await getActiveTab().catch(() => null);
  if (!targetUrl || !tab?.id || doesTabMatchContextUrl(tab.url || "", targetUrl)) {
    return;
  }
  await chrome.tabs.update(tab.id, { url: targetUrl }).catch(() => null);
}

async function addPresetPrompt() {
  const text = String(els.presetInput.value || "").trim();
  if (!text) {
    return;
  }
  const nextPrompts = [...(aiPrefs.aiPresetPrompts || [])];
  if (!nextPrompts.includes(text)) {
    nextPrompts.push(text);
  }
  aiPrefs.aiPresetPrompts = nextPrompts.slice(0, 12);
  await persistAiPresetPrompts();
  els.presetInput.value = "";
  renderPresetPrompts();
  renderFollowups();
}

async function removePresetPrompt(index) {
  if (index < 0) {
    return;
  }
  aiPrefs.aiPresetPrompts = (aiPrefs.aiPresetPrompts || []).filter((_, itemIndex) => itemIndex !== index);
  await persistAiPresetPrompts();
  renderPresetPrompts();
  renderFollowups();
}

// save-settings keeps the keys it is not sent.
async function persistAiPresetPrompts() {
  await sendRuntimeMessage({ type: "save-settings", settings: { aiPresetPrompts: (aiPrefs.aiPresetPrompts || []).slice(0, 12) } }).catch(() => null);
}

function updateSidepanelLayoutState() {
  const useCompactInput = Boolean(
    contextData &&
    contextData.isVideoContext === false &&
    !chatHistory.length &&
    !currentConversationMeta?.pinnedContext
  );
  document.body.classList.toggle("sp-non-video-context", useCompactInput);
  if (els.input) {
    autosizeInput();
  }
}

async function refreshContextManually() {
  if (els.refreshBtn.disabled) {
    return;
  }
  setRefreshing(true);
  try {
    const ok = await loadContextState({ forceRefresh: true });
    if (ok) {
      if (!contextData || !providers.length || !chatHistory.length) {
        renderInitialState();
      } else {
        renderSuggestions();
      }
    }
  } finally {
    setRefreshing(false);
  }
}

function setRefreshing(isRefreshing) {
  els.refreshBtn.disabled = isRefreshing;
  els.refreshBtn.classList.toggle("is-loading", isRefreshing);
  if (isRefreshing) {
    els.refreshBtn.setAttribute("aria-busy", "true");
  } else {
    els.refreshBtn.removeAttribute("aria-busy");
  }
}

async function startNewConversation() {
  hidePresetPopover();
  hideHistoryPopover();
  setRefreshing(true);
  try {
    await loadContextState({ forceRefresh: true, silent: true });
  } finally {
    setRefreshing(false);
  }
  if (liveContextData) {
    contextData = { ...liveContextData };
    currentContextKey = liveContextKey || buildContextKey(liveContextData);
    updateContextChip();
  }
  restartChat({ keepContext: true });
  renderInitialState();
}

function renderConversationMessages() {
  updateSidepanelLayoutState();
  els.messages.innerHTML = "";
  suggestionsNode = null;
  if (!chatHistory.length) {
    resetConversationView("");
    return;
  }
  chatHistory.forEach((message) => {
    if (message.role === "user") {
      appendUserMessage(message.content, false);
      return;
    }
    const node = document.createElement("div");
    node.className = "sp-msg sp-msg-assistant";
    renderAssistantMessage(node, String(message.content || ""));
    els.messages.appendChild(node);
  });
  renderFollowups();
  shouldAutoScrollMessages = true;
  scrollToBottom(true);
}

function buildConversationTitle(context) {
  const rawTitle = String(context?.title || "当前页面").trim() || "当前页面";
  const baseTitle = extractConversationBaseTitle(rawTitle);
  return appendConversationPageSuffix(baseTitle, context);
}

function buildConversationContextRef(context) {
  if (!context || typeof context !== "object") {
    return null;
  }
  return {
    title: String(context.title || "").trim(),
    url: String(context.url || "").trim(),
    author: String(context.author || "").trim(),
    uploadDate: String(context.uploadDate || "").trim(),
    // Conversations saved before the site registry carry bvid instead of site/videoId.
    site: String(context.site || (context.bvid ? "bilibili" : BocSites.matchSite(context.url)?.id || "")).trim(),
    videoId: String(context.videoId || context.bvid || BocSites.parseRef(context.url)?.id || "").trim(),
    cid: String(context.cid || "").trim(),
    aid: String(context.aid || "").trim(),
    pageIndex: Number(context.pageIndex) > 0 ? Number(context.pageIndex) : 1,
    pageCount: Number(context.pageCount) > 0 ? Number(context.pageCount) : 0,
    pageTitle: String(context.pageTitle || "").trim(),
    subtitleLang: String(context.subtitleLang || "").trim(),
    selectedSubtitleId: String(context.selectedSubtitleId || "").trim(),
    selectedSubtitleUrl: String(context.selectedSubtitleUrl || "").trim(),
    isVideoContext: context.isVideoContext !== false
  };
}

function normalizeConversationContextRef(ref) {
  return buildConversationContextRef(ref);
}

function buildContextPlaceholder(ref) {
  if (!ref || typeof ref !== "object") {
    return null;
  }
  return {
    title: String(ref.title || "").trim(),
    url: String(ref.url || "").trim(),
    author: String(ref.author || "").trim(),
    uploadDate: String(ref.uploadDate || "").trim(),
    site: String(ref.site || "").trim(),
    videoId: String(ref.videoId || "").trim(),
    cid: String(ref.cid || "").trim(),
    aid: String(ref.aid || "").trim(),
    pageIndex: Number(ref.pageIndex) > 0 ? Number(ref.pageIndex) : 1,
    pageCount: Number(ref.pageCount) > 0 ? Number(ref.pageCount) : 0,
    pageTitle: String(ref.pageTitle || "").trim(),
    subtitleLang: String(ref.subtitleLang || "").trim(),
    selectedSubtitleId: String(ref.selectedSubtitleId || "").trim(),
    selectedSubtitleUrl: String(ref.selectedSubtitleUrl || "").trim(),
    subtitleMarkdown: "",
    hotComments: [],
    isVideoContext: ref.isVideoContext !== false
  };
}

function normalizeConversationTitle(title, contextTitle = "", contextRef = null, contextUrl = "") {
  const preferredTitle = String(contextTitle || "").trim() || String(title || "").trim();
  const baseTitle = extractConversationBaseTitle(preferredTitle);
  return appendConversationPageSuffix(baseTitle || "历史对话", contextRef || { url: contextUrl });
}

function generateConversationId() {
  return `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractConversationBaseTitle(title) {
  const raw = String(title || "").trim();
  if (!raw) {
    return "当前页面";
  }
  const normalizedRaw = raw.replace(/-P\d+$/i, "").trim();
  const parts = normalizedRaw
    .split(/\s+[|｜]\s+|\s+-\s+|\s+[—–]\s+|\s+[·•]\s+|\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return parts[0] || normalizedRaw;
}

function buildConversationTitleDisplay(title, maxChars = 22) {
  const value = String(title || "").trim();
  const match = value.match(/^(.*?)(-P\d+)$/i);
  if (!match) {
    return {
      main: value.length > maxChars ? `${value.slice(0, maxChars)}...` : value,
      suffix: ""
    };
  }

  const suffix = String(match[2] || "").trim();
  const baseTitle = String(match[1] || "").trim();
  const reservedChars = Math.max(suffix.length + 3, 6);
  const availableChars = Math.max(maxChars - reservedChars, 8);
  return {
    main: baseTitle.length > availableChars ? `${baseTitle.slice(0, availableChars)}...` : baseTitle,
    suffix
  };
}

function appendConversationPageSuffix(title, context) {
  const baseTitle = String(title || "").trim() || "历史对话";
  const existingSuffixMatch = baseTitle.match(/-P\d+$/i);
  const cleanTitle = existingSuffixMatch ? baseTitle.replace(/-P\d+$/i, "").trim() : baseTitle;
  const pageSuffix = extractConversationPageSuffix(context);
  return pageSuffix ? `${cleanTitle}${pageSuffix}` : cleanTitle;
}

function extractConversationPageSuffix(context) {
  const pageIndex = Number(context?.pageIndex || context?.page || 0) || extractPageIndexFromContextUrl(context?.url);
  return pageIndex > 1 ? `-P${pageIndex}` : "";
}

function extractPageIndexFromContextUrl(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    const page = Number(parsed.searchParams.get("p") || "1");
    return Number.isFinite(page) && page > 0 ? page : 1;
  } catch {
    return 1;
  }
}

function formatConversationTimestamp(value) {
  const date = new Date(Number(value) || Date.now());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

// A new conversation takes the context its reply was asked in (the stream's), not whatever the tab shows now.
async function persistCurrentConversation({ context = contextData, contextKey = currentContextKey } = {}) {
  if (!chatHistory.length || !context) {
    return;
  }
  const now = Date.now();
  if (!currentConversationId) {
    currentConversationId = generateConversationId();
    currentConversationMeta = {
      id: currentConversationId,
      title: buildConversationTitle(context),
      createdAt: now,
      contextKey,
      contextTitle: String(context.title || "").trim(),
      contextUrl: String(context.url || "").trim(),
      isVideoContext: context.isVideoContext !== false,
      pinnedContext: true,
      contextRef: buildConversationContextRef(context),
      resolvedContext: { ...context }
    };
  }
  const nextConversation = {
    id: currentConversationId,
    title: currentConversationMeta?.title || buildConversationTitle(context),
    contextKey: String(currentConversationMeta?.contextKey || contextKey || "").trim(),
    contextTitle: String(currentConversationMeta?.contextTitle || context.title || "").trim(),
    contextUrl: String(currentConversationMeta?.contextUrl || context.url || "").trim(),
    isVideoContext: currentConversationMeta?.isVideoContext !== false,
    createdAt: Number(currentConversationMeta?.createdAt) || now,
    updatedAt: now,
    contextRef: currentConversationMeta?.contextRef || buildConversationContextRef(context),
    pageHydrated: savedConversations.find((item) => item.id === currentConversationId)?.pageHydrated === true,
    messages: chatHistory.map((item) => ({ role: item.role, content: String(item.content || "") }))
  };
  savedConversations = [
    nextConversation,
    ...savedConversations.filter((item) => item.id !== currentConversationId)
  ];
  currentConversationMeta = {
    id: nextConversation.id,
    title: nextConversation.title,
    createdAt: nextConversation.createdAt,
    updatedAt: nextConversation.updatedAt,
    contextKey: nextConversation.contextKey,
    contextTitle: nextConversation.contextTitle,
    contextUrl: nextConversation.contextUrl,
    isVideoContext: nextConversation.isVideoContext,
    pinnedContext: true,
    contextRef: nextConversation.contextRef,
    resolvedContext: currentConversationMeta?.resolvedContext ? { ...currentConversationMeta.resolvedContext } : { ...context }
  };
  await saveConversations();
}

async function ensureCurrentContextForSend() {
  if (currentConversationMeta?.pinnedContext) {
    await loadContextState({ forceRefresh: false, silent: true }).catch(() => null);
    return hydratePinnedConversationContext();
  }
  const loadingNotice = contextData?.pending;
  if (loadingNotice) {
    showConversationContextNotice("正在加载视频上下文...");
  }
  const ok = await loadContextState({ forceRefresh: false, silent: true });
  if (loadingNotice) {
    removeConversationContextNotice();
  }
  // A placeholder still standing means the subtitles never arrived; never answer from it.
  if (!ok || !contextData || contextData.pending) {
    resetConversationView("当前页面上下文读取失败。");
    return false;
  }
  return true;
}

async function hydratePinnedConversationContext({ silent = false } = {}) {
  const targetKey = String(currentConversationMeta?.contextKey || "").trim();
  const cachedResolvedContext = currentConversationMeta?.resolvedContext;
  if (cachedResolvedContext && typeof cachedResolvedContext === "object") {
    contextData = { ...cachedResolvedContext };
    currentContextKey = targetKey || buildContextKey(contextData);
    updateContextChip();
    removeConversationContextNotice();
    return true;
  }

  if (targetKey && liveContextKey && targetKey === liveContextKey) {
    const ok = await loadContextState({ forceRefresh: false, silent: true });
    // contextData of a bound conversation is not refreshed from the tab; the live payload is its resolved context.
    if (ok && liveContextData && liveContextKey === targetKey) {
      contextData = { ...liveContextData };
      currentContextKey = targetKey;
      currentConversationMeta = {
        ...currentConversationMeta,
        resolvedContext: { ...contextData }
      };
      updateContextChip();
      removeConversationContextNotice();
      return true;
    }
  }

  const contextRef = currentConversationMeta?.contextRef || null;
  if (!contextRef) {
    removeConversationContextNotice();
    if (!silent) {
      showConversationContextError("历史对话缺少原视频信息，无法继续。");
    }
    return false;
  }

  const response = await resolveConversationContext(contextRef).catch((error) => ({
    ok: false,
    error: error?.message || String(error || "")
  }));
  if (!response?.ok || !response.payload) {
    removeConversationContextNotice();
    if (!silent) {
      showConversationContextError(`历史视频上下文获取失败：${response?.error || "未知错误"}`);
    }
    return false;
  }

  contextData = response.payload;
  currentContextKey = targetKey || buildContextKey(contextData);
  currentConversationMeta = {
    ...currentConversationMeta,
    contextKey: currentContextKey,
    contextTitle: String(contextData.title || currentConversationMeta?.contextTitle || "").trim(),
    contextUrl: String(contextData.url || currentConversationMeta?.contextUrl || "").trim(),
    contextRef: buildConversationContextRef(contextData),
    resolvedContext: { ...contextData }
  };
  updateContextChip();
  removeConversationContextNotice();
  return true;
}

async function resolveConversationContext(contextRef) {
  const tab = await getActiveTab().catch(() => null);
  return sendRuntimeMessage({
    type: "ai-sidepanel-resolve-context",
    tabId: Number(tab?.id || 0) || 0,
    contextRef
  });
}

async function sendMessage() {
  const text = els.input.value.trim();
  // sendPending closes the window while the context loads, when a second Enter or chip click would send twice.
  if (!text || activeStream || sendPending) {
    return;
  }
  hidePresetPopover();
  hideHistoryPopover();

  const providerId = els.modelSelect.value;
  if (!providerId) {
    resetConversationView("请先在设置页配置并启用一个 AI 平台。");
    return;
  }

  sendPending = true;
  let hasContext = false;
  try {
    hasContext = await ensureCurrentContextForSend();
  } finally {
    sendPending = false;
  }
  if (!hasContext || activeStream) {
    return;
  }
  if (!currentConversationMeta?.pinnedContext && currentConversationMeta?.contextKey && currentConversationMeta.contextKey !== currentContextKey) {
    currentConversationId = "";
    currentConversationMeta = null;
  }

  suggestionsNode?.remove();
  suggestionsNode = null;
  removeCenteredState();

  appendUserMessage(text);
  els.input.value = "";
  autosizeInput();
  const stream = {
    port: chrome.runtime.connect({ name: "sidepanel-chat" }),
    node: appendAssistantPlaceholder(),
    prompt: text,
    context: contextData,
    contextKey: currentContextKey,
    raw: "",
    notice: "",
    frame: 0,
    ended: false
  };
  activeStream = stream;
  setStreamingUiState(true);
  startStreamSlowNoticeTimer();

  stream.port.onMessage.addListener((msg) => {
    if (!msg || stream.ended) {
      return;
    }
    if (msg.type === "token") {
      handleFirstStreamToken();
      stream.raw += String(msg.data || "");
      scheduleStreamRender(stream);
    } else if (msg.type === "notice") {
      stream.notice = String(msg.text || "");
    } else if (msg.type === "done") {
      endStream(stream);
    } else if (msg.type === "stopped") {
      endStream(stream, { stopped: msg.reason || "已停止生成" });
    } else if (msg.type === "error") {
      endStream(stream, { error: msg.error || "未知错误" });
    }
  });
  // Only the background end can trigger this: the extension reloaded or the service worker died mid-reply.
  stream.port.onDisconnect.addListener(() => {
    if (!stream.ended) {
      endStream(stream, { error: "连接中断：扩展可能已重新加载，可重试" });
    }
  });

  stream.port.postMessage({
    action: "chat",
    providerId,
    context: {
      ...stream.context,
      aiSystemPrompt: aiPrefs.aiSystemPrompt
    },
    prompt: text,
    history: chatHistory
  });
}

function appendUserMessage(text, shouldScroll = true) {
  const node = document.createElement("div");
  node.className = "sp-msg sp-msg-user";
  node.textContent = text;
  els.messages.appendChild(node);
  if (shouldScroll) {
    shouldAutoScrollMessages = true;
    scrollToBottom(true);
  }
}

function appendAssistantPlaceholder() {
  const node = document.createElement("div");
  node.className = "sp-msg sp-msg-assistant";
  const cursor = document.createElement("span");
  cursor.className = "sp-msg-cursor";
  node.appendChild(cursor);
  els.messages.appendChild(node);
  shouldAutoScrollMessages = true;
  scrollToBottom(true);
  return node;
}

// Rendering the whole markdown per token is quadratic in the reply length, so render at most once per frame.
function scheduleStreamRender(stream) {
  if (stream.frame) {
    return;
  }
  stream.frame = window.requestAnimationFrame(() => {
    stream.frame = 0;
    if (stream.ended) {
      return;
    }
    stream.node.innerHTML = renderMarkdown(stream.raw) + '<span class="sp-msg-cursor"></span>';
    scrollToBottom();
  });
}

function closeStream(stream) {
  stream.ended = true;
  window.cancelAnimationFrame(stream.frame);
  stream.frame = 0;
  try {
    stream.port.disconnect();
  } catch {}
}

// Every way a reply ends lands here. A partial answer is kept and saved, also when the stream fails.
function endStream(stream, { stopped = "", error = "" } = {}) {
  closeStream(stream);
  if (stream !== activeStream) {
    if (stream.conversationId) {
      void finishDetachedStream(stream);
    }
    return;
  }
  activeStream = null;
  clearStreamRuntimeState();
  const { node, prompt, raw } = stream;
  const saved = Boolean(raw.trim());
  if (saved || !(stopped || error)) {
    renderAssistantMessage(node, raw);
  } else {
    node.innerHTML = "";
  }
  if (saved) {
    chatHistory.push({ role: "user", content: prompt }, { role: "assistant", content: raw });
    void persistCurrentConversation(stream);
    scheduleAutoSync(currentConversationId);
  }
  [stopped, stream.notice].filter(Boolean).forEach((text) => {
    const note = document.createElement("div");
    note.className = "sp-msg-stopped";
    note.textContent = text;
    node.appendChild(note);
  });
  if (error) {
    appendStreamError(stream, error, saved);
  }
  setStreamingUiState(false);
  els.input.focus();
  scrollToBottom();
}

function appendStreamError({ node, prompt, raw }, error, saved) {
  const err = document.createElement("div");
  err.className = "sp-msg-error";
  err.textContent = `错误：${error}`;
  node.appendChild(err);
  const origin = /未授权访问 (https?:\/\/[^\s，]+)/.exec(String(error))?.[1];
  if (origin) {
    const grant = document.createElement("button");
    grant.type = "button";
    grant.className = "sp-chip sp-grant-btn";
    grant.textContent = `授权访问 ${origin}`;
    // The click is the user gesture permissions.request needs; the service worker cannot ask.
    grant.addEventListener("click", async () => {
      if (await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false)) {
        err.textContent = "已授权，请重新发送";
        grant.remove();
      }
    });
    node.appendChild(grant);
  }
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "sp-chip sp-grant-btn";
  retry.textContent = "重试";
  // The retry replaces the failed turn instead of repeating the question below it.
  retry.addEventListener("click", () => {
    if (activeStream || sendPending) return;
    const last = chatHistory.length - 2;
    if (saved && chatHistory[last]?.content === prompt && chatHistory[last + 1]?.content === raw) {
      chatHistory.splice(last, 2);
    }
    if (node.previousElementSibling?.classList.contains("sp-msg-user")) {
      node.previousElementSibling.remove();
    }
    node.remove();
    els.input.value = prompt;
    void sendMessage();
  });
  node.appendChild(retry);
}

function stopActiveStream() {
  if (!activeStream) {
    return;
  }
  if (els.stopBtn) {
    els.stopBtn.disabled = true;
    els.stopBtn.textContent = "停止中...";
  }
  try {
    activeStream.port.postMessage({ action: "stop" });
  } catch {
    endStream(activeStream, { stopped: "已停止生成" });
  }
}

function startStreamSlowNoticeTimer() {
  clearStreamRuntimeState();
  streamFirstTokenReceived = false;
  streamSlowNoticeTimer = window.setTimeout(() => {
    if (!activeStream || streamFirstTokenReceived) {
      return;
    }
    showConversationContextNotice("模型响应较慢，仍在等待服务器返回...", 0);
  }, STREAM_SLOW_NOTICE_MS);
}

function handleFirstStreamToken() {
  if (streamFirstTokenReceived) {
    return;
  }
  streamFirstTokenReceived = true;
  clearStreamRuntimeState();
}

function clearStreamRuntimeState() {
  if (streamSlowNoticeTimer) {
    window.clearTimeout(streamSlowNoticeTimer);
    streamSlowNoticeTimer = 0;
  }
  streamFirstTokenReceived = false;
  removeConversationContextNotice();
}

function renderAssistantMessage(node, raw) {
  if (!node) {
    return;
  }
  node.innerHTML = "";
  const cleanedRaw = stripThinkBlocks(raw);
  const pasteReadyRaw = normalizeMarkdownForSectionPaste(cleanedRaw);

  const content = document.createElement("div");
  content.className = "sp-msg-assistant-body";
  content.innerHTML = renderMarkdown(cleanedRaw);
  linkifyAssistantTimestamps(content);
  node.appendChild(content);

  const actions = document.createElement("div");
  actions.className = "sp-msg-actions";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "sp-msg-copy-btn";
  copyBtn.setAttribute("aria-label", "复制回复");
  copyBtn.setAttribute("title", "复制回复");
  copyBtn.innerHTML = `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <rect x="9" y="9" width="10" height="10" rx="2"></rect>
      <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1"></path>
    </svg>
  `;
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pasteReadyRaw);
      copyBtn.disabled = true;
      window.setTimeout(() => {
        copyBtn.disabled = false;
      }, 500);
    } catch {
      copyBtn.disabled = true;
      window.setTimeout(() => {
        copyBtn.disabled = false;
      }, 500);
    }
  });
  actions.appendChild(copyBtn);

  node.appendChild(actions);
}

// The same note feeds the Obsidian save and the clipboard copy; only the save knows where the
// video note lives, so only it passes the source backlink.
function buildCurrentConversationNote(sourcePath = "") {
  const turns = buildConversationTurns(chatHistory);
  if (!turns.length) {
    return null;
  }
  const context = currentConversationMeta?.resolvedContext || contextData || currentConversationMeta?.contextRef || {};
  const filename = buildAiConversationFilename(context);
  return { context, filename, content: buildAiConversationMarkdown({ context, turns, filename, sourcePath }) };
}

// Where the page's 保存到 Obsidian puts this video's note: same folder template and filename builder.
function videoNotePathFor(context, settings) {
  const folder = resolveFolderTemplate(settings?.noteFolder || "", context);
  const filename = buildNoteFilename(context, settings || {});
  return folder ? `${folder}/${filename}` : filename;
}

async function boundVideoNotePath(noteKey) {
  const paths = (await chrome.storage.local.get(NOTE_PATHS_STORAGE_KEY))[NOTE_PATHS_STORAGE_KEY] || {};
  return paths[noteKey]?.path || "";
}

// The note a manual save recorded wins over the computed path, which carries today's date when
// includeDateInFilename is on and so only matches a note saved today.
async function resolveVideoNotePath(context, settings) {
  const noteKey = BocSites.buildContextKey(buildConversationContextRef(context) || {});
  return (noteKey && (await boundVideoNotePath(noteKey))) || videoNotePathFor(context, settings);
}

// Rewrites the marked AI 问答 section of the video's note when that note exists; never creates one.
// Resolves to the background result ({ exists, updated }) or null when the conversation has no video.
async function syncVideoNoteAiSection({ context, messages, settings, baseUrl, apiKey }) {
  const noteKey = BocSites.buildContextKey(buildConversationContextRef(context) || {});
  if (!noteKey) {
    return null;
  }
  const section = BocNote.buildAiSection(buildConversationTurns(messages));
  if (!section) {
    return null;
  }
  const filepath = await resolveVideoNotePath(context, settings);
  const resp = await sendRuntimeMessage({ type: "update-obsidian-ai-section", baseUrl, apiKey, filepath, section, noteKey });
  if (!resp?.ok) {
    throw new Error(getReadableText(resp?.error, "Local API 写入失败"));
  }
  return resp;
}

// ---- auto-sync: after a manual save bound the video to its note, every finished answer updates the section ----
const AUTO_SYNC_DEBOUNCE_MS = 1500;
const autoSyncTimers = new Map();

function scheduleAutoSync(conversationId) {
  if (!conversationId) {
    return;
  }
  window.clearTimeout(autoSyncTimers.get(conversationId));
  autoSyncTimers.set(
    conversationId,
    window.setTimeout(() => {
      autoSyncTimers.delete(conversationId);
      void autoSyncConversation(conversationId);
    }, AUTO_SYNC_DEBOUNCE_MS)
  );
}

async function autoSyncConversation(conversationId) {
  const conversation = savedConversations.find((item) => item.id === conversationId);
  const noteKey = conversation?.contextRef ? BocSites.buildContextKey(conversation.contextRef) : "";
  if (!noteKey || !(await boundVideoNotePath(noteKey))) {
    return;
  }
  const settingsResp = await sendRuntimeMessage({ type: "get-settings" }).catch(() => null);
  const settings = settingsResp?.ok ? settingsResp.settings || {} : {};
  const baseUrl = String(settings.obsidianApiBaseUrl || "").trim();
  const apiKey = String(settings.obsidianApiKey || "").trim();
  if (!settings.obsidianEnabled || settings.includeAiChatInNote === false || !baseUrl || !apiKey) {
    return;
  }
  try {
    const result = await syncVideoNoteAiSection({ context: conversation.contextRef, messages: conversation.messages, settings, baseUrl, apiKey });
    if (!result) {
      return;
    }
    if (!result.exists) {
      showSyncStatus("笔记已不存在，未同步");
      return;
    }
    showSyncStatus("已同步到 Obsidian ✓", { autoHideMs: 3000 });
  } catch (error) {
    showSyncStatus(`同步失败 · ${readableObsidianError(error)}`, { retry: () => autoSyncConversation(conversationId) });
  }
}

function readableObsidianError(error) {
  const text = getErrorMessage(error);
  return /failed to fetch|networkerror|load failed/i.test(text) ? "连不上 Obsidian，请确认它已打开并启用了 Local REST API" : text;
}

let syncStatusTimer = 0;
function showSyncStatus(text, { autoHideMs = 0, retry = null } = {}) {
  if (!els.syncStatus) {
    return;
  }
  window.clearTimeout(syncStatusTimer);
  els.syncStatus.querySelector("span").textContent = text;
  const button = els.syncStatus.querySelector("button");
  button.hidden = !retry;
  button.onclick = retry ? () => { els.syncStatus.hidden = true; void retry(); } : null;
  els.syncStatus.hidden = false;
  if (autoHideMs > 0) {
    syncStatusTimer = window.setTimeout(() => {
      els.syncStatus.hidden = true;
    }, autoHideMs);
  }
}

async function copyCurrentConversationMarkdown() {
  const note = buildCurrentConversationNote();
  if (!note) {
    showConversationContextNotice("当前没有可复制的对话。", 2200);
    return;
  }
  try {
    await navigator.clipboard.writeText(note.content);
    showConversationContextNotice("已复制对话 Markdown。", 2200);
  } catch (error) {
    showConversationContextNotice(`复制失败：${getErrorMessage(error)}`, 3000);
  }
}

async function saveCurrentConversationToObsidian() {
  const settingsBundle = await loadObsidianSettings();
  if (!settingsBundle) {
    return;
  }
  const context = currentConversationMeta?.resolvedContext || contextData || currentConversationMeta?.contextRef || {};
  if (!buildConversationTurns(chatHistory).length) {
    showConversationContextNotice("当前没有可保存的历史对话。", 2200);
    return;
  }
  // Update the video note first: a 404 clears the recorded path, so the backlink below is computed afresh.
  let videoNoteNotice = "";
  if (settingsBundle.settings.includeAiChatInNote !== false) {
    try {
      const result = await syncVideoNoteAiSection({ context, messages: chatHistory, ...settingsBundle });
      if (result?.exists) {
        videoNoteNotice = "，视频笔记的 AI 问答已更新";
      } else if (result && !result.exists) {
        videoNoteNotice = "；视频笔记已不存在，已解除关联";
      }
    } catch (error) {
      videoNoteNotice = `；视频笔记的 AI 问答更新失败：${readableObsidianError(error)}`;
    }
  }
  const note = buildCurrentConversationNote(await resolveVideoNotePath(context, settingsBundle.settings));
  const folder = resolveFolderTemplate(settingsBundle.settings.noteFolder || "", note.context);
  const filepath = folder ? `${folder}/${note.filename}` : note.filename;

  const written = await saveMarkdownToObsidian({
    button: els.saveConversationBtn,
    filepath,
    content: note.content,
    baseUrl: settingsBundle.baseUrl,
    apiKey: settingsBundle.apiKey
  });
  if (written && videoNoteNotice) {
    showConversationContextNotice(`已写入 Obsidian：${filepath}${videoNoteNotice}。`, 4000);
  }
}

async function loadObsidianSettings() {
  const settingsResp = await sendRuntimeMessage({ type: "get-settings" }).catch((error) => ({
    ok: false,
    error: error?.message || String(error || "")
  }));
  if (!settingsResp?.ok) {
    showConversationContextNotice(`读取设置失败：${settingsResp?.error || "未知错误"}`, 3000);
    return null;
  }

  const settings = settingsResp.settings || {};
  const baseUrl = String(settings.obsidianApiBaseUrl || "").trim();
  const apiKey = String(settings.obsidianApiKey || "").trim();
  if (!baseUrl || !apiKey) {
    showConversationContextNotice("请先在设置页填写 Obsidian Local REST API 地址和 API Key。", 3500);
    chrome.runtime.openOptionsPage?.();
    return null;
  }

  return { settings, baseUrl, apiKey };
}

async function saveMarkdownToObsidian({ button, filepath, content, baseUrl, apiKey }) {
  try {
    if (button) {
      button.disabled = true;
      button.classList.add("is-saving");
    }
    const exists = await checkObsidianNoteExists(baseUrl, apiKey, filepath);
    if (exists) {
      const shouldOverwrite = await confirmOverwriteNote(filepath);
      if (!shouldOverwrite) {
        showConversationContextNotice("已取消保存，原笔记未被覆盖。", 2200);
        return false;
      }
    }
    await writeNoteByLocalApi(baseUrl, apiKey, filepath, content);
    showConversationContextNotice(`已写入 Obsidian：${filepath}`, 2600);
    return true;
  } catch (error) {
    showConversationContextNotice(`写入失败：${getErrorMessage(error)}`, 4000);
  } finally {
    if (button) {
      button.classList.remove("is-saving");
      window.setTimeout(() => {
        button.disabled = false;
      }, 500);
    }
  }
}

async function checkObsidianNoteExists(baseUrl, apiKey, filepath) {
  const resp = await sendRuntimeMessage({
    type: "obsidian-note-exists",
    baseUrl,
    apiKey,
    filepath
  });
  if (!resp?.ok) {
    throw new Error(getReadableText(resp?.error, "Local API 检查失败"));
  }
  return Boolean(resp.exists);
}

async function writeNoteByLocalApi(baseUrl, apiKey, filepath, content) {
  const resp = await sendRuntimeMessage({
    type: "write-obsidian-note",
    baseUrl,
    apiKey,
    filepath,
    content
  });
  if (!resp?.ok) {
    throw new Error(getReadableText(resp?.error, "Local API 写入失败"));
  }
}

function getReadableText(value, fallback = "") {
  if (typeof value === "string") {
    return value.trim() || fallback;
  }
  if (value == null) {
    return fallback;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value || fallback);
  }
}

function getErrorMessage(error, fallback = "未知错误") {
  return getReadableText(error?.message || error, fallback);
}

function confirmOverwriteNote(filepath) {
  return new Promise((resolve) => {
    const existing = document.querySelector(".sp-confirm-overlay");
    if (existing) {
      existing.remove();
    }

    const overlay = document.createElement("div");
    overlay.className = "sp-confirm-overlay";
    overlay.innerHTML = `
      <div class="sp-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="spConfirmTitle">
        <div id="spConfirmTitle" class="sp-confirm-title">该笔记已存在</div>
        <div class="sp-confirm-body">继续会覆盖原内容：</div>
        <div class="sp-confirm-path"></div>
        <div class="sp-confirm-actions">
          <button type="button" class="sp-confirm-cancel">取消</button>
          <button type="button" class="sp-confirm-primary">覆盖</button>
        </div>
      </div>
    `;
    overlay.querySelector(".sp-confirm-path").textContent = String(filepath || "");

    const cleanup = (value) => {
      overlay.remove();
      document.removeEventListener("keydown", onKeydown, true);
      resolve(value);
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup(false);
      }
    };

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        cleanup(false);
      }
    });
    overlay.querySelector(".sp-confirm-cancel")?.addEventListener("click", () => cleanup(false));
    overlay.querySelector(".sp-confirm-primary")?.addEventListener("click", () => cleanup(true));
    document.addEventListener("keydown", onKeydown, true);
    document.body.appendChild(overlay);
    overlay.querySelector(".sp-confirm-primary")?.focus();
  });
}

function linkifyAssistantTimestamps(root) {
  if (!root) {
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    const current = walker.currentNode;
    if (!(current instanceof Text)) {
      continue;
    }
    const parent = current.parentElement;
    if (!parent || parent.closest("a, code, pre, button")) {
      continue;
    }
    TIMESTAMP_PATTERN.lastIndex = 0;
    if (!TIMESTAMP_PATTERN.test(current.textContent || "")) {
      continue;
    }
    textNodes.push(current);
  }

  textNodes.forEach((node) => {
    const text = node.textContent || "";
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let hasMatch = false;
    TIMESTAMP_PATTERN.lastIndex = 0;
    let match;
    while ((match = TIMESTAMP_PATTERN.exec(text))) {
      hasMatch = true;
      if (match.index > lastIndex) {
        fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const timestamp = match[0];
      const seconds = parseTimestampToSeconds(timestamp);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sp-timestamp-link";
      button.textContent = timestamp;
      button.setAttribute("title", `跳转到 ${timestamp}`);
      button.addEventListener("click", () => {
        void jumpToAssistantTimestamp(seconds, timestamp);
      });
      fragment.append(button);
      lastIndex = match.index + timestamp.length;
    }
    if (!hasMatch) {
      return;
    }
    if (lastIndex < text.length) {
      fragment.append(document.createTextNode(text.slice(lastIndex)));
    }
    node.replaceWith(fragment);
  });
}

function parseTimestampToSeconds(value) {
  const parts = String(value || "")
    .trim()
    .split(":")
    .map((item) => Number(item));
  if (!parts.length || parts.some((item) => !Number.isFinite(item) || item < 0)) {
    return 0;
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

async function jumpToAssistantTimestamp(seconds, label = "") {
  const safeSeconds = Math.max(0, Number(seconds || 0) || 0);
  const targetUrl = String(contextData?.url || currentConversationMeta?.contextUrl || "").trim();
  if (!targetUrl) {
    showConversationContextNotice("当前没有可跳转的视频上下文。", 2200);
    return;
  }

  const tab = await getActiveTab().catch(() => null);
  if (!tab?.id) {
    showConversationContextNotice("找不到当前标签页。", 2200);
    return;
  }

  showConversationContextNotice(`正在跳转到 ${label || formatSecondsAsTimestamp(safeSeconds)}...`, 1800);

  try {
    const sameVideo = doesTabMatchContextUrl(tab.url || "", targetUrl);
    if (!sameVideo) {
      await chrome.tabs.update(tab.id, { url: targetUrl });
      await waitForTabComplete(tab.id);
    }
    const response = await sendMessageToActiveTab(tab.id, {
      type: "sidepanel-seek-video-time",
      seconds: safeSeconds
    });
    if (!response?.ok) {
      throw new Error(response?.error || "视频时间跳转失败");
    }
  } catch (error) {
    showConversationContextNotice(`时间跳转失败：${error?.message || error}`, 2600);
  }
}

function doesTabMatchContextUrl(tabUrl, targetUrl) {
  const current = BocSites.parseRef(tabUrl);
  const target = BocSites.parseRef(targetUrl);
  if (!current || !target) {
    return String(tabUrl || "").trim() === String(targetUrl || "").trim();
  }
  return current.site === target.site && current.id === target.id && (current.part?.index || 1) === (target.part?.index || 1);
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") {
      return true;
    }
    await delay(250);
  }
  throw new Error("视频页面加载超时");
}

async function sendMessageToActiveTab(tabId, message, retries = 12) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(resp);
        });
      });
    } catch (error) {
      lastError = error;
      await delay(220);
    }
  }
  throw lastError || new Error("无法连接视频页面");
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatSecondsAsTimestamp(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hour = Math.floor(safe / 3600);
  const minute = Math.floor((safe % 3600) / 60);
  const second = safe % 60;
  if (hour > 0) {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  }
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function restartChat({ keepContext = false } = {}) {
  clearStreamRuntimeState();
  if (activeStream) {
    closeStream(activeStream);
    activeStream = null;
  }
  chatHistory = [];
  currentConversationId = "";
  currentConversationMeta = null;
  if (!keepContext) {
    currentContextKey = buildContextKey(contextData);
  }
  updateContextChip();
  resetConversationView("");
  setStreamingUiState(false);
  els.input.value = "";
  autosizeInput();
  renderPreviousVideoBar();
}

function removeCenteredState() {
  els.messages.querySelectorAll(".sp-center-error").forEach((node) => node.remove());
}

function showConversationContextError(message) {
  if (!String(message || "").trim()) {
    return;
  }
  removeConversationContextNotice();
  removeCenteredState();
  const stateNode = document.createElement("div");
  stateNode.className = "sp-center-error";
  stateNode.textContent = String(message);
  els.messages.appendChild(stateNode);
  scrollToBottom();
}

function showConversationContextNotice(message, autoHideMs = 0) {
  removeConversationContextNotice();
  const notice = document.createElement("div");
  notice.className = "sp-context-notice";
  notice.textContent = String(message || "").trim();
  els.messages.prepend(notice);
  if (autoHideMs > 0) {
    contextNoticeTimer = window.setTimeout(() => {
      removeConversationContextNotice();
    }, autoHideMs);
  }
}

function removeConversationContextNotice() {
  if (contextNoticeTimer) {
    window.clearTimeout(contextNoticeTimer);
    contextNoticeTimer = 0;
  }
  els.messages.querySelectorAll(".sp-context-notice").forEach((node) => node.remove());
}

function isMessagesNearBottom(threshold = 56) {
  const { scrollTop, scrollHeight, clientHeight } = els.messages;
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

function renderMarkdown(text) {
  let escaped = escapeHtml(stripThinkBlocks(text));
  const codeBlocks = [];
  escaped = escaped.replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return `\u0001BOC_CODE_${codeBlocks.length - 1}\u0001`;
  });

  const lines = escaped.split("\n");
  const out = [];
  let listType = "";
  let listStartNumber = 1;
  let paraBuf = [];

  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${renderInline(paraBuf.join(" "))}</p>`);
      paraBuf = [];
    }
  };
  const closeList = () => {
    if (!listType) {
      return;
    }
    out.push(listType === "ul" ? "</ul>" : "</ol>");
    listType = "";
    listStartNumber = 1;
  };
  const openList = (nextType, startNumber = 1) => {
    if (listType === nextType && (nextType !== "ol" || listStartNumber === startNumber)) {
      return;
    }
    closeList();
    listType = nextType;
    listStartNumber = nextType === "ol" ? startNumber : 1;
    if (nextType === "ul") {
      out.push("<ul>");
      return;
    }
    out.push(startNumber > 1 ? `<ol start="${startNumber}">` : "<ol>");
  };
  const getNextListType = (startIndex) => {
    for (let index = startIndex; index < lines.length; index += 1) {
      const nextLine = lines[index].trim();
      if (!nextLine) {
        continue;
      }
      if (/^[-*+]\s+(.+)$/.test(nextLine)) {
        return "ul";
      }
      if (/^\d+\.\s+(.+)$/.test(nextLine)) {
        return "ol";
      }
      break;
    }
    return "";
  };
  const isTableSeparatorLine = (value) => /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(value);
  const isTableRowLine = (value) => /^\|.+\|$/.test(value);
  const splitTableCells = (value) =>
    value
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => renderInline(cell.trim()));

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    const codeMatch = line.match(/^\u0001BOC_CODE_(\d+)\u0001$/);
    if (codeMatch) {
      flushPara();
      closeList();
      out.push(`<pre><code>${codeBlocks[Number(codeMatch[1])]}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length + 2;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (
      isTableRowLine(line) &&
      index + 1 < lines.length &&
      isTableSeparatorLine(lines[index + 1].trim())
    ) {
      flushPara();
      closeList();
      const headers = splitTableCells(line);
      const bodyRows = [];
      index += 2;
      while (index < lines.length) {
        const tableLine = lines[index].trim();
        if (!isTableRowLine(tableLine)) {
          index -= 1;
          break;
        }
        bodyRows.push(splitTableCells(tableLine));
        index += 1;
      }
      out.push(
        `<table><thead><tr>${headers.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${
          bodyRows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")
        }</tbody></table>`
      );
      continue;
    }

    const ul = line.match(/^[-*+]\s+(.+)$/);
    if (ul) {
      flushPara();
      openList("ul");
      out.push(`<li>${renderInline(ul[1])}</li>`);
      continue;
    }

    const ol = line.match(/^(\d+)\.\s+(.+)$/);
    if (ol) {
      flushPara();
      const orderNumber = Number(ol[1]) || 1;
      openList("ol", orderNumber);
      out.push(`<li>${renderInline(ol[2])}</li>`);
      continue;
    }

    if (!line) {
      flushPara();
      if (listType && getNextListType(index + 1) === listType) {
        continue;
      }
      closeList();
      continue;
    }

    paraBuf.push(line);
  }

  flushPara();
  closeList();
  return out.join("");
}

function renderInline(text) {
  return text
    .replace(/`([^`]+)`/g, (_, c) => (isTimestampOnlyInlineCode(c) ? c : `<code>${c}</code>`))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, c) => `<strong>${c}</strong>`)
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, pre, c) => `${pre}<em>${c}</em>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
      const safeUrl = /^(https?:|mailto:|#)/i.test(u) ? u : "#";
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    });
}

function scrollToBottom(force = false) {
  if (!force && !shouldAutoScrollMessages) {
    return;
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value, max) {
  const s = String(value || "");
  return s.length > max ? s.slice(0, max) + "..." : s;
}
