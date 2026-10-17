const SELECTED_PROVIDER_KEY = MdgLimits.KEYS.aiSelectedProvider;
// Before the first read: 3.5 and older kept it under the old key prefix. Either page may open first after the update.
try {
  MdgLimits.migrateRenamedLocalStorage(localStorage);
} catch {}
const CONVERSATIONS_STORAGE_KEY = MdgLimits.KEYS.aiConversations;
const { escapeHtml } = MdgErrors;
const setDisabledReason = MdgErrors.setReason;
const {
  stripThinkBlocks,
  normalizeMarkdownForSectionPaste,
  renderMarkdown,
  TIMESTAMP_PATTERN,
  buildConversationTurns,
  buildAiConversationFilename,
  buildAiConversationMarkdown
} = MdgNote;
const PLAYER_AI_QUICK_ACTION_STORAGE_KEY = MdgLimits.KEYS.playerAiQuickAction;
// Marks a control that starts an AI request (tokens.css draws it in the text color).
const AI_SPARK = '<span class="ai-spark" aria-hidden="true"></span>';
const NON_VIDEO_CONTEXT_MESSAGE = MdgErrors.TEXT.notVideoPage;
const EMPTY_INTRO = "AI 会读这期视频的字幕和评论，回答你的问题。";
const STREAM_SLOW_NOTICE_MS = 15000;
const PREVIOUS_VIDEO_CONVERSATION_KEY = "mdg_sp_previous_video_conversation";
const FOLLOWED_LIVE_VIDEO = "followed";
const QUICK_ACTION_MAX_AGE_MS = 15000;
// How long a notice stays: a short confirmation, a failure, a result worth reading.
const NOTICE_SHORT_MS = 2200;
const NOTICE_MS = 3000;
const NOTICE_LONG_MS = 4000;
// A history conversation whose B站 video was deleted or hidden: no retry brings it back, so it is only read.
const VIDEO_GONE = "视频已失效，这段对话只能查看，不能继续提问。";

const els = {
  contextChip: document.getElementById("spContextChip"),
  contextTitle: document.querySelector("#spContextChip .sp-context-title"),
  contextMeta: document.querySelector("#spContextChip .sp-context-meta"),
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
  messages: document.getElementById("spMessages"),
  input: document.getElementById("spInput"),
  sendBtn: document.getElementById("spSendBtn"),
  generating: document.getElementById("spGenerating"),
  note: document.getElementById("spNote"),
  noteToggle: document.getElementById("spNoteToggle"),
  noteText: document.getElementById("spNoteText"),
  noteInput: document.getElementById("spNoteInput"),
};
const NOTES_STORAGE_KEY = MdgLimits.KEYS.triageNotes;

const { buildConversationContextRef, doesTabMatchContextUrl, needsConversationPageHydration } = SidepanelState;

// The conversation, its context and the tab's, with every rule about them (sidepanel-state.js). This page does the
// I/O, runs the effects it returns (act) and draws what view() says.
const state = SidepanelState.create();
let providers = [];
// The reply in flight: its port and the node it streams into. state knows it as streaming.
let activeStream = null;
let sendPending = false;
let suggestionsNode = null;
// The AI settings as get-settings returns them; MdgSettings.DEFAULTS until then or when it fails.
let aiPrefs = aiPrefsOf(MdgSettings.DEFAULTS);
// The question just sent here, held at the top of the panel while its reply grows below it (the turn anchor of
// assistant-ui's turnAnchor="top"): { epoch, node, top }, top being where it was last scrolled to. The spacer after the
// reply makes the room to scroll it up there and shrinks to nothing once the reply fills the panel. Nothing follows the
// reply down; the reader scrolls. Until they do, something growing above it (the note card a first save shows) scrolls
// it back up; top is null once they have.
let turnAnchor = null;
const turnSpacer = document.createElement("div");
let liveContextSyncTimer = 0;
let streamSlowNoticeTimer = 0;
let streamSlowNotice = null;
let streamFirstTokenReceived = false;
// A redraw asked for while a reply streams (a detached reply ended into this conversation, another window saved it):
// done when that reply ends, so the answer it brought shows.
let redrawAfterStream = false;
// What was typed in the input for each conversation left, by sidepanel-state.js's draftKey; back in it when it is shown
// again. Kept only while the panel is open.
const drafts = new Map();
// Reading the AI platforms failed: why, said where 没有启用的 AI 平台 would be (it is not that).
let providersError = "";
// A 写入 Obsidian in flight: a second one would open a second overwrite dialog. Its button says so (syncExportButtons).
let obsidianWriting = false;
// get-settings failed: the defaults stand in for the 快捷追问, so changing them would save the defaults over the user's.
let settingsReadFailed = false;
let initCompleted = false;
// What a context load waits for before it places the tab's video (init's reads: the saved conversations it may restore,
// the platforms the empty state depends on). The context itself is asked for meanwhile.
let initReads = null;
let contextLoadSeq = 0;
let contextLoad = null;
let contextLoadFollow = false;
let previousVideoExpanded = false;
let previousVideoBarSignature = "";

init().catch((err) => {
  console.error(err);
  resetConversationView(`${MdgErrors.TEXT.initFailed}：${escapeHtml(err?.message || err)}`);
});

async function init() {
  bindEvents();
  // The tab's video shows from its URL (its saved conversation, or a placeholder) as soon as these are read; its
  // subtitles and comments, read meanwhile, fill it in.
  initReads = Promise.all([loadProvidersAndPrefs(), loadSavedConversations(), loadPreviousVideoConversationId()]);
  await loadContextState();
  // A conversation was drawn when it was shown; the empty state shows what the payload brought.
  if (state.view().bound) updateContextChip();
  else renderInitialState();
  autosizeInput();
  initCompleted = true;
  await consumePendingPlayerAiQuickAction();
}

function bindEvents() {
  els.input.addEventListener("keydown", (e) => {
    if (MdgTyping.composing(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  els.input.addEventListener("input", () => {
    autosizeInput();
    syncSummaryButton();
  });
  turnSpacer.className = "sp-turn-spacer";
  turnSpacer.setAttribute("aria-hidden", "true");
  // The reply streaming, its end notes and a resized panel all change the room needed: one sizing per frame.
  let spacerFrame = 0;
  const resizeSpacer = () => {
    spacerFrame ||= window.requestAnimationFrame(() => {
      spacerFrame = 0;
      syncTurnSpacer();
    });
  };
  new ResizeObserver(resizeSpacer).observe(els.messages);
  new MutationObserver(resizeSpacer).observe(els.messages, { childList: true, subtree: true, characterData: true });
  for (const type of ["wheel", "touchmove", "keydown", "pointerdown"]) {
    els.messages.addEventListener(type, () => turnAnchor && (turnAnchor.top = null), { passive: true });
  }
  els.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.contextChip.addEventListener("animationend", () => els.contextChip.classList.remove("is-switched"));
  els.contextChip.addEventListener("click", () => {
    void openCurrentContextUrl();
  });
  els.newChatBtn.addEventListener("click", () => {
    void startNewConversation();
  });
  els.previousVideoBar?.addEventListener("click", handlePreviousVideoBarClick);
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== "mdg-video-changed") {
      return false;
    }
    void getActiveTab()
      .then((tab) => {
        if (tab?.id && sender?.tab?.id === tab.id) {
          scheduleLiveContextSync();
        }
      })
      .catch(() => {});
    return false;
  });
  els.noteToggle.addEventListener("click", () => {
    els.noteToggle.hidden = true;
    els.noteInput.hidden = false;
    els.noteInput.focus();
  });
  // Enter or Esc saves and closes, like the triage card; Shift+Enter is a newline. Never mid-IME.
  els.noteInput.addEventListener("keydown", (e) => {
    if (MdgTyping.composing(e) || !(e.key === "Escape" || (e.key === "Enter" && !e.shiftKey))) return;
    e.preventDefault();
    void saveNote();
  });
  els.noteInput.addEventListener("focusout", () => {
    if (!els.noteInput.hidden) void saveNote();
  });
  els.presetBtn.addEventListener("click", togglePresetPopover);
  els.historyBtn.addEventListener("click", toggleHistoryPopover);
  // Focuses an open 视频记录 tab instead of a second one, as the popup and the settings page do.
  document.querySelector(".sp-history-manage")?.addEventListener("click", async (event) => {
    event.preventDefault();
    const r = await sendRuntimeMessage({ type: "history-open" }).catch(() => null);
    if (!r?.ok) chrome.tabs.create({ url: chrome.runtime.getURL(MdgCommon.PAGES.history) });
  });
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
    void downloadCurrentConversation();
  });
  // One button in place: 发送, or 停止 while a reply streams.
  els.sendBtn.addEventListener("click", () => {
    if (activeStream) stopActiveStream();
    else void sendMessage();
  });
  els.presetAddBtn.addEventListener("click", addPresetPrompt);
  els.presetInput.addEventListener("input", syncPresetAdd);
  els.presetInput.addEventListener("keydown", (e) => {
    if (MdgTyping.composing(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      addPresetPrompt();
    }
  });
  els.modelSelect.addEventListener("change", () => {
    syncModelSelectTitle();
    if (els.modelSelect.value) {
      localStorage.setItem(SELECTED_PROVIDER_KEY, els.modelSelect.value);
    }
  });
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleLiveContextSync();
    }
  });
  window.addEventListener("focus", () => {
    scheduleLiveContextSync();
  });
  chrome.tabs.onActivated.addListener(() => {
    scheduleLiveContextSync();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab?.active) {
      return;
    }
    if (!changeInfo.url && changeInfo.status !== "complete") {
      return;
    }
    scheduleLiveContextSync();
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      (areaName === "sync" &&
        (changes[MdgLimits.KEYS.aiProviderList] ||
          changes.aiSystemPrompt ||
          changes.playerAiQuickPrompt ||
          changes.aiPresetPrompts ||
          changes.obsidianEnabled)) ||
      (areaName === "local" && changes[MdgLimits.KEYS.aiApiKeys])
    ) {
      void refreshProvidersAndPrefsAfterExternalChange();
    }
    // The history page deletes conversations too; without this the next save here would bring them back.
    if (areaName === "local" && changes[CONVERSATIONS_STORAGE_KEY]) {
      const change = changes[CONVERSATIONS_STORAGE_KEY];
      void act({ type: "SAVED_CHANGED", list: change.newValue, previous: change.oldValue });
      renderHistoryList();
    }
    if (areaName === "local" && changes[NOTES_STORAGE_KEY] && els.noteInput.hidden) {
      void renderNote();
    }
    if (areaName === "local") followTriageAnalysis(changes);
    if (areaName === "local" && changes[PLAYER_AI_QUICK_ACTION_STORAGE_KEY] && initCompleted) {
      void handlePlayerAiQuickActionRequest(changes[PLAYER_AI_QUICK_ACTION_STORAGE_KEY].newValue);
    }
  });
}

// Grows with the text; sidepanel.css's min-height and max-height bound it.
function autosizeInput() {
  els.input.style.height = "auto";
  els.input.style.height = `${els.input.scrollHeight}px`;
}

// Why the shown conversation cannot be asked in at all: a web page, or a video that is gone.
function readOnlyReason() {
  return state.view().nonVideo ? MdgErrors.TEXT.notVideoPage : contextFailure()?.gone ? VIDEO_GONE : "";
}

function setStreamingUiState(isStreaming, { stopping = false } = {}) {
  const blocked = isStreaming ? "" : readOnlyReason();
  // The input says why too: while streaming the 正在生成… line's words, else the send button's.
  setDisabledReason(els.input, isStreaming ? els.generating.textContent : blocked);
  renderFollowups();
  els.generating.hidden = !isStreaming;
  setDisabledReason(els.sendBtn, stopping ? "正在停止生成" : blocked);
  els.sendBtn.classList.toggle("is-stop", isStreaming);
  els.sendBtn.innerHTML = isStreaming ? (stopping ? MdgErrors.LABEL.stopping : MdgErrors.LABEL.stop) : `${AI_SPARK}发送`;
  syncExportButtons();
}

// 导出对话 and each item in its menu: disabled with the reason while there is nothing to export.
function syncExportButtons() {
  const nothing = buildConversationTurns(state.view().messages).length ? "" : "当前没有可导出的对话";
  setDisabledReason(els.exportBtn, nothing, "导出整段对话");
  for (const item of [els.copyConversationBtn, els.downloadConversationBtn]) if (item) setDisabledReason(item, nothing);
  if (els.saveConversationBtn) setDisabledReason(els.saveConversationBtn, nothing || (obsidianWriting ? MdgErrors.TEXT.obsidianWriting : ""));
}


async function loadProvidersAndPrefs({ preferredProviderId = "" } = {}) {
  const [providersResp, settingsResp] = await Promise.all([
    sendRuntimeMessage({ type: "ai-providers-list" }).catch((error) => ({ ok: false, error: error.message })),
    sendRuntimeMessage({ type: "get-settings" }).catch(() => ({ ok: false }))
  ]);
  const providersRead = Boolean(providersResp?.ok && Array.isArray(providersResp.providers));
  providersError = providersRead ? "" : `读取 AI 平台失败：${MdgErrors.text(providersResp)}`;
  providers = providersRead ? providersResp.providers.filter((p) => p.enabled) : [];
  settingsReadFailed = !(settingsResp?.ok && settingsResp.settings);
  const settings = settingsReadFailed ? MdgSettings.DEFAULTS : settingsResp.settings;
  document.body.classList.toggle("sp-obsidian-off", !settings.obsidianEnabled);
  aiPrefs = aiPrefsOf(settings);
  renderModelSelect(preferredProviderId);
  renderPresetPrompts();
  renderFollowups();
}

function aiPrefsOf({ aiSystemPrompt, playerAiQuickPrompt, aiPresetPrompts }) {
  return { aiSystemPrompt, playerAiQuickPrompt, aiPresetPrompts: [...aiPresetPrompts] };
}

function renderModelSelect(preferredProviderId = "") {
  if (!providers.length) {
    const text = providersError || MdgErrors.TEXT.aiNone;
    els.modelSelect.innerHTML = `<option value="">${escapeHtml(text)}</option>`;
    els.modelSelect.title = text;
    els.modelSelect.disabled = true;
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
  syncModelSelectTitle();
}

// The select is narrow, so the full model name lives in its tooltip.
function syncModelSelectTitle() {
  els.modelSelect.title = els.modelSelect.selectedOptions[0]?.textContent || "";
}

async function refreshProvidersAndPrefsAfterExternalChange() {
  const previousProviderId = String(els.modelSelect?.value || localStorage.getItem(SELECTED_PROVIDER_KEY) || "").trim();
  await loadProvidersAndPrefs({ preferredProviderId: previousProviderId });
  if (activeStream) {
    return;
  }
  renderHistoryList();
  // A conversation draws nothing from these settings (the select, 快捷追问 and the Obsidian item are drawn above); only
  // the empty state does, and it is drawn again only if it changed.
  const { messages, unanswered } = state.view();
  if (!messages.length && !unanswered) renderInitialState();
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
    contextRef: value.contextRef && typeof value.contextRef === "object" ? value.contextRef : null,
    frameId: Number(value.frameId) || 0
  };
}

async function handlePlayerAiQuickActionRequest(value, { fromStorageChange = true } = {}) {
  const request = normalizePlayerAiQuickActionRequest(value);
  if (!request) {
    return false;
  }
  // A request for another tab is never consumed, so an old one must not replay when the panel opens there later.
  if (Date.now() - request.createdAt > QUICK_ACTION_MAX_AGE_MS) {
    await chrome.storage.local.remove(PLAYER_AI_QUICK_ACTION_STORAGE_KEY).catch(() => null);
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

  // A reference (分拣台, 视频记录) names its video; otherwise AI 总结 is about the tab's, so read it first.
  if (!request.contextRef) await loadContextState({ silent: true });
  else if (request.frameId) viewerFrame = { tabId: request.tabId, frameId: request.frameId, videoId: String(request.contextRef.videoId || "") };
  await act({ type: "SUMMARY", prompt: request.prompt, ref: request.contextRef });
  return true;
}

// The AI 总结 button only fills an empty input, so with text in it the button is off and says why.
function syncSummaryButton() {
  const button = suggestionsNode?.querySelector('.sp-summary-btn[data-act="summary"]');
  if (button) setDisabledReason(button, els.input.value.trim() ? "输入框里有文字，清空后才能填入 AI 总结" : "", aiPrefs.playerAiQuickPrompt);
}

// AI 总结 never sends by itself: it fills an empty input and leaves the send to the user.
function fillPrompt(prompt) {
  if (!els.input.value.trim()) {
    els.input.value = prompt;
  }
  autosizeInput();
  syncSummaryButton();
  els.input.focus();
  const end = els.input.value.length;
  els.input.setSelectionRange(end, end);
}

// Runs an event through the state and does what it asks. A reply leaving the conversation is let go first; another
// conversation is then drawn afresh, before the effects that show on it (the draft, AI 总结, 正在加载原视频信息…).
async function act(event) {
  const epoch = state.view().epoch;
  const effects = state.dispatch(event);
  for (const effect of effects) {
    if (effect.type === "detach" || effect.type === "dropStream") releaseActiveStream(effect);
  }
  if (state.view().epoch !== epoch) {
    // Another conversation: the 导出对话 menu and the auto-sync status were about the one before.
    hideExportPopover();
    hideSyncStatus();
    clearStreamRuntimeState();
    removeConversationContextNotice();
    updateContextChip();
    renderHistoryList();
    renderInitialState();
  }
  for (const effect of effects) await runEffect(effect);
  return effects;
}

async function runEffect(effect) {
  switch (effect.type) {
    case "save":
      return saveConversations();
    case "autoSync":
      return scheduleAutoSync(effect.id);
    case "draft": {
      const typed = els.input.value.trim() ? els.input.value : "";
      drafts.delete(effect.from);
      if (typed && effect.from !== effect.to) drafts.set(effect.from, typed);
      els.input.value = drafts.get(effect.to) || "";
      drafts.delete(effect.to);
      syncSummaryButton();
      return autosizeInput();
    }
    case "fill":
      return fillPrompt(effect.prompt);
    case "focus":
      autosizeInput();
      return els.input?.focus?.();
    case "previous":
      return setPreviousVideoConversation(effect.id);
    case "followed":
      return flashContextChip();
    case "placed":
      // The tab URL's video in the empty conversation, before its subtitles load.
      updateContextChip();
      return renderInitialState();
    case "hidePopovers":
      hidePresetPopover();
      return hideHistoryPopover();
    case "redraw":
      // Another window's panel saved this conversation: drawn again, but never over a reply streaming here.
      return redrawConversation();
    case "resolve":
      return hydratePinnedConversationContext({ silent: effect.silent, notice: showConversationContextNotice("正在加载原视频信息…") });
  }
}

// Switching videos or conversations mid-reply hands the reply to its saved conversation (state saved the question
// there), which then becomes the previous-video bar. The port stays open, so the background keeps streaming while the
// new one is usable at once. A dropped reply (its conversation deleted) is cut off.
function releaseActiveStream({ type, conversationId, promptIndex }) {
  const stream = activeStream;
  activeStream = null;
  clearStreamRuntimeState();
  if (!stream) {
    return;
  }
  if (type === "dropStream") {
    closeStream(stream);
    return;
  }
  stream.conversationId = conversationId;
  stream.promptIndex = promptIndex;
}

// Tab switches and sends overlap their loads; only the newest one writes the context, and an older caller gets the
// newest one's result (contextLoadSeq, contextLoad and contextLoadFollow are declared above init, which loads at once).
// A follow asked for by a superseded load carries over to the newer one.
function loadContextState(opts = {}) {
  const seq = ++contextLoadSeq;
  contextLoadFollow ||= Boolean(opts.follow);
  const run = readContextState({ ...opts, follow: contextLoadFollow }, () => seq !== contextLoadSeq);
  contextLoad = run;
  const settle = () => {
    if (seq === contextLoadSeq) contextLoadFollow = false;
  };
  run.then(settle, settle);
  return run;
}

async function readContextState({ refresh = false, silent = false, follow = false }, superseded) {
  const tab = await getActiveTab();
  if (superseded()) return contextLoad;
  const request = tab?.id ? sendRuntimeMessage({ type: "ai-sidepanel-get-state", tabId: tab.id, refresh }).catch((error) => ({ ok: false, error: error.message })) : null;
  await initReads?.catch(() => {});
  if (superseded()) return contextLoad;
  const atTab = await act({ type: "TAB_READ", tab: tab?.id ? { url: tab.url, title: tab.title } : null, follow });
  const followed = atTab.some((effect) => effect.type === "followed");
  if (!tab?.id) {
    updateContextChip();
    if (!silent && !state.view().bound) {
      resetConversationView(state.view().live.error);
    }
    return false;
  }

  const resp = await request;
  if (superseded()) return contextLoad;

  const ok = Boolean(resp?.ok && resp.payload);
  // A web page always answers; only reading a video fails, said as the popup and 专注模式 say it.
  const effects = await act({ type: "CONTEXT_ARRIVED", payload: ok ? resp.payload : null, error: ok ? "" : `${MdgErrors.TEXT.videoReadFailed}：${MdgErrors.text(resp)}`, follow });
  if (!ok) {
    updateContextChip();
    if (!silent && !state.view().bound) {
      resetConversationView(contextErrorHtml(), { retry: true });
    }
    return false;
  }
  if (effects.some((effect) => effect.type === "followed")) {
    return FOLLOWED_LIVE_VIDEO;
  }
  renderHistoryList();
  updateContextChip();
  renderSuggestions();
  return followed ? FOLLOWED_LIVE_VIDEO : true;
}

// The note belongs to the video (multi-part videos share one); web pages have none.
function noteVideoId(context = state.view().context) {
  const ref = context?.isVideoContext === false ? null : buildConversationContextRef(context);
  return ref?.site ? ref.videoId : "";
}

async function renderNote() {
  const id = noteVideoId();
  els.note.hidden = !id;
  if (!id || !els.noteInput.hidden) return;
  const text = String((await chrome.storage.local.get(NOTES_STORAGE_KEY))[NOTES_STORAGE_KEY]?.[id]?.text || "");
  if (id !== noteVideoId() || !els.noteInput.hidden) return;
  els.noteInput.value = text;
  els.noteToggle.classList.toggle("is-empty", !text.trim());
  els.noteText.textContent = text;
  els.noteText.title = text;
  els.noteInput.dataset.videoId = id;
}

async function saveNote() {
  const id = els.noteInput.dataset.videoId;
  els.noteInput.hidden = true;
  els.noteToggle.hidden = false;
  if (id) await MdgLimits.saveVideoNote(id, els.noteInput.value);
  await renderNote();
}

function updateContextChip() {
  void renderNote();
  renderFollowups();
  const { context, mismatch } = state.view();
  if (!context) {
    setContextChipText("读取失败");
    els.contextChip.title = "";
    els.contextChip.disabled = true;
    els.contextChip.classList.remove("is-mismatch");
    return;
  }

  const shortTitle = context.title || (context.pending ? MdgErrors.TEXT.loading : context.url ? MdgErrors.TEXT.untitledVideo : "未知视频");
  setContextChipText(shortTitle, context.isVideoContext === false ? "" : context.author);
  els.contextChip.classList.toggle("is-mismatch", mismatch);
  els.contextChip.title = context.url
    ? `${context.title || ""}${mismatch ? "\n当前页不是这段对话绑定的视频" : ""}${context.isVideoContext === false ? "" : "\n点击跳转目标视频"}`
    : context.title || "";
  els.contextChip.disabled = !String(context.url || "").trim();
}

function setContextChipText(title, meta = "") {
  els.contextTitle.textContent = title;
  els.contextMeta.textContent = String(meta || "").trim();
  els.contextMeta.hidden = !els.contextMeta.textContent;
}

async function openCurrentContextUrl() {
  const { context, pinned } = state.view();
  const targetUrl = String(context?.url || pinned?.contextUrl || "").trim();
  if (!targetUrl) {
    return;
  }
  const tab = await getActiveTab().catch(() => null);
  if (!tab?.id) {
    return;
  }
  try {
    const sameVideo = doesTabMatchContextUrl(tab.url || "", targetUrl, state.view().live.context);
    if (!sameVideo) {
      await chrome.tabs.update(tab.id, { url: targetUrl });
      await waitForTabComplete(tab.id);
    }
    await loadContextState({ silent: true });
  } catch {}
}

function renderInitialState() {
  // A question waiting for its video stands in for the empty state, which comes back if it is not sent.
  if (waiting()) return;
  updateSidepanelLayoutState();
  const { context, messages, unanswered } = state.view();
  // A conversation stays readable without a platform; sending then says why (the model select and 快捷追问 too).
  if (messages.length || unanswered) {
    renderConversationMessages();
    return;
  }
  // Without a platform nothing else works, so the empty state only offers to add one.
  if (!providers.length) {
    resetConversationView("");
    return;
  }
  if (!context) {
    resetConversationView(contextErrorHtml(), { retry: true });
    return;
  }
  if (context.isVideoContext === false) {
    resetConversationView(NON_VIDEO_CONTEXT_MESSAGE);
    return;
  }
  resetConversationView("");
}

// Why the tab's context could not be read (B站 限流, the extension reloaded…), as the read said.
function contextErrorHtml() {
  return escapeHtml(state.view().live.error);
}

// The empty state drawn ([stateHtml, retry]); "" once anything else is drawn into the messages.
let emptyStateShown = "";

// retry: a context read failed, so offer to read it again (the context otherwise refreshes on its own).
// The same empty state again (a tab event, the panel shown again) is not torn down: only its suggestions update.
function resetConversationView(stateHtml = "", { retry = false } = {}) {
  updateSidepanelLayoutState();
  const shown = JSON.stringify([stateHtml, retry]);
  if (suggestionsNode?.isConnected && emptyStateShown === shown) {
    renderSuggestions();
    renderPresetPrompts();
    return;
  }
  emptyStateShown = shown;
  drawnEpoch = -1;
  clearMessages();
  if (stateHtml) {
    const stateNode = document.createElement("div");
    stateNode.className = "sp-center-error";
    stateNode.innerHTML = stateHtml;
    if (retry) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sp-chip sp-grant-btn";
      button.textContent = MdgErrors.LABEL.retry;
      button.addEventListener("click", () => void refreshContextManually());
      stateNode.append(document.createElement("br"), button);
    }
    els.messages.appendChild(stateNode);
  }
  suggestionsNode = document.createElement("div");
  suggestionsNode.className = "sp-suggestions";
  suggestionsNode.id = "spSuggestions";
  els.messages.appendChild(suggestionsNode);
  renderSuggestions();
  renderPresetPrompts();
  renderFollowups();
  turnAnchor = null;
  scrollToBottom();
}

// What the AI will read: the intro says so when there are no subtitles (background.js tells the AI the same).
function introText() {
  const context = state.view().context;
  if (String(context?.subtitleMarkdown || "").trim()) {
    return EMPTY_INTRO;
  }
  // The video page's sentence (MdgErrors.subtitleMissing), with its 未登录 hint.
  const hint = context?.subtitleNeedLogin ? `${MdgErrors.TEXT.subtitleLoginHint}。` : "";
  return `${MdgErrors.subtitleMissing(context || {})}，AI 只能读标题、简介和评论。${hint}`;
}

// What the empty conversation offers; summary: AI 总结 is offered, for the video it names.
function suggestionsContent() {
  const { context, messages } = state.view();
  if (messages.length) {
    return { html: "" };
  }
  if (providersError) {
    return { html: `<p class="sp-empty-intro">${escapeHtml(providersError)}</p>` };
  }
  if (!providers.length) {
    return { html: `<p class="sp-empty-intro">${EMPTY_INTRO}${MdgErrors.TEXT.aiNone}。</p><button type="button" class="sp-summary-btn" data-act="settings">去设置页添加平台</button>` };
  }
  if (!context || context.isVideoContext === false) {
    return { html: "" };
  }
  // A followed video's placeholder: no summary to offer until its subtitles arrive (sending still waits for them).
  if (context.pending) {
    return { html: `<p class="sp-empty-intro" aria-busy="true">${MdgErrors.TEXT.subtitleReading}</p>` };
  }
  // The intro and the one-click summary as the main action; the preset chips sit above the input (renderFollowups).
  const prompt = aiPrefs.playerAiQuickPrompt;
  const ref = buildConversationContextRef(context);
  return {
    html: `<p class="sp-empty-intro">${escapeHtml(introText())}</p>${prompt ? `<button type="button" class="sp-summary-btn" data-act="summary" title="${escapeHtml(prompt)}">${AI_SPARK}${MdgErrors.LABEL.aiSummary}</button>` : ""}`,
    summary: { prompt, video: `${ref.site}:${ref.videoId}:${ref.pageIndex}` }
  };
}

// Drawn again only when it changed, so a redraw never blinks it; the 分拣台 card of the same video stays until its new
// read is in. AI 总结 is offered (SUMMARY_SHOWN) at every call: the fill is per conversation, not per drawing.
function renderSuggestions() {
  const node = suggestionsNode;
  if (!node || waiting()) {
    return;
  }
  renderFollowups();
  const { html, summary } = suggestionsContent();
  const video = summary?.video || "";
  if (node.dataset.html !== html || node.dataset.video !== video) {
    const card = video && node.dataset.video === video ? node.querySelector(".sp-triage-summary") : null;
    node.innerHTML = html;
    if (card) node.prepend(card);
    Object.assign(node.dataset, { html, video });
    node.querySelector('[data-act="settings"]')?.addEventListener("click", () => chrome.runtime.openOptionsPage());
    node.querySelector('[data-act="summary"]')?.addEventListener("click", () => fillPrompt(summary.prompt));
    if (video) void renderTriageSummary(node);
  }
  if (!summary) {
    return;
  }
  syncSummaryButton();
  void act({ type: "SUMMARY_SHOWN", prompt: summary.prompt });
}

// 分拣台 finishing 细看 on the open video: its AI 总结 card shows now, not at the next redraw.
function followTriageAnalysis(changes) {
  const videoId = buildConversationContextRef(state.view().context)?.videoId;
  if (videoId && suggestionsNode && changes[MdgLimits.KEYS.triageAnalysis(videoId)]) void renderTriageSummary(suggestionsNode);
}

// A summary the triage page already paid for, shown before the first question; nothing is requested here.
// It is per bvid and summarizes P1, so other parts don't show it.
async function renderTriageSummary(node) {
  const ref = buildConversationContextRef(state.view().context);
  if (ref?.site !== "bilibili" || ref.pageIndex !== 1) {
    return;
  }
  const key = MdgLimits.KEYS.triageAnalysis(ref.videoId);
  const summary = MdgNote.buildTriageSummary((await chrome.storage.local.get(key))[key]);
  const now = state.view();
  const nowRef = buildConversationContextRef(now.context);
  if (node !== suggestionsNode || now.messages.length || nowRef?.videoId !== ref.videoId || nowRef.pageIndex !== 1) {
    return;
  }
  // The card a redraw kept goes now, also when the analysis is gone.
  node.querySelector(".sp-triage-summary")?.remove();
  if (!summary) return;
  // renderMarkdown has no blockquotes, so the one-liner loses its "> ".
  node.insertAdjacentHTML("afterbegin", `<div class="sp-triage-summary"><div class="sp-triage-summary-label">分拣台的 AI 总结</div>${renderMarkdown(summary.replace(/^> /, ""))}</div>`);
}

// Preset chips above the input stay put whenever presets exist; when a send is impossible they are disabled
// and say why, so the layout never jumps. Long lists show the first few plus a visible toggle.
const FOLLOWUP_PREVIEW = 4;
let followupsExpanded = false;
let followupsRendered = "";

function followupBlockReason() {
  if (!providers.length) {
    return providersError || MdgErrors.TEXT.aiNone;
  }
  const { context, messages, pinned } = state.view();
  const readOnly = readOnlyReason();
  if (readOnly) {
    return readOnly;
  }
  if (activeStream) {
    return els.generating.textContent;
  }
  if (context?.pending) {
    return MdgErrors.TEXT.subtitleReading;
  }
  if (!messages.length && !pinned && !context) {
    return "打开一个视频后才能用快捷追问";
  }
  return "";
}

function renderFollowups() {
  if (!els.followups) {
    return;
  }
  const prompts = aiPrefs.aiPresetPrompts || [];
  const reason = followupBlockReason();
  const collapsible = prompts.length > FOLLOWUP_PREVIEW + 1;
  const visible = collapsible && !followupsExpanded ? prompts.slice(0, FOLLOWUP_PREVIEW) : prompts;
  // Context updates call this often; rebuilding unchanged chips would cut a running marquee and drop focus.
  const signature = JSON.stringify([prompts, reason, followupsExpanded]);
  if (signature === followupsRendered) {
    return;
  }
  followupsRendered = signature;
  els.followups.hidden = !prompts.length;
  els.followups.innerHTML = visible
    .map((prompt) => `<button type="button" class="sp-followup-chip">${AI_SPARK}<span class="sp-followup-text"><span>${escapeHtml(prompt)}</span></span></button>`)
    .join("");
  els.followups.querySelectorAll("button").forEach((btn, index) => {
    setDisabledReason(btn, reason, visible[index]);
    btn.addEventListener("click", () => sendPrompt(visible[index]));
    const start = () => startFollowupMarquee(btn);
    const stop = () => btn.classList.remove("is-marquee");
    btn.addEventListener("mouseenter", start);
    btn.addEventListener("focus", start);
    btn.addEventListener("mouseleave", stop);
    btn.addEventListener("blur", stop);
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

// Only a chip whose text overflows scrolls, by exactly the hidden width, at a steady speed.
function startFollowupMarquee(btn) {
  const text = btn.querySelector(".sp-followup-text");
  const shift = text.scrollWidth - text.clientWidth;
  if (shift <= 0) {
    return;
  }
  btn.style.setProperty("--marquee-shift", `-${shift}px`);
  btn.style.setProperty("--marquee-duration", `${(2 + shift / 20).toFixed(2)}s`);
  btn.classList.add("is-marquee");
}

// 快捷追问 sends its text as is; the input box and what is typed there stay.
function sendPrompt(prompt) {
  void sendMessage(prompt);
}

function renderPresetPrompts() {
  if (!els.presetList) {
    return;
  }
  syncPresetAdd();
  const prompts = Array.isArray(aiPrefs.aiPresetPrompts) ? aiPrefs.aiPresetPrompts : [];
  if (!prompts.length) {
    els.presetList.innerHTML = '<span class="sp-preset-empty">还没有快捷追问</span>';
    return;
  }
  els.presetList.innerHTML = prompts
    .map((prompt) => `
      <span class="sp-preset-item">
        <span class="sp-preset-chip" title="${escapeHtml(prompt)}">${escapeHtml(prompt)}</span>
        <button type="button" class="sp-preset-remove" aria-label="删除快捷追问">×</button>
      </span>
    `)
    .join("");
  els.presetList.querySelectorAll(".sp-preset-remove").forEach((btn, index) => {
    setDisabledReason(btn, settingsReadFailed ? PRESETS_UNREAD : "", "删除快捷追问");
    btn.addEventListener("click", () => void removePresetPrompt(prompts[index]));
  });
}

function renderHistoryList() {
  renderPreviousVideoBar();
  if (!els.historyList) {
    return;
  }
  // Only the shown video's conversations; the history page lists and searches all of them.
  const { history: conversations, id: currentId } = state.view();
  if (!conversations.length) {
    els.historyList.innerHTML = '<span class="sp-history-empty">这里还没有历史对话</span>';
    return;
  }

  els.historyList.innerHTML = conversations
    .map((conversation) => {
      const isActive = conversation.id === currentId;
      const metaText = formatConversationTimestamp(conversation.updatedAt || conversation.createdAt);
      const titleDisplay = buildConversationTitleDisplay(conversation.title, 30);
      return `
        <div class="sp-history-item ${isActive ? "is-active" : ""}" data-id="${escapeHtml(conversation.id)}">
          <button type="button" class="sp-history-open" data-id="${escapeHtml(conversation.id)}">
            <span class="sp-history-title" title="${escapeHtml(conversation.title)}">
              <span class="sp-history-title-main">${escapeHtml(titleDisplay.main)}</span>
              ${titleDisplay.suffix ? `<span class="sp-history-title-suffix">${escapeHtml(titleDisplay.suffix)}</span>` : ""}
            </span>
            <span class="sp-history-meta" title="${escapeHtml(metaText)}">${escapeHtml(metaText)}</span>
          </button>
          <button type="button" class="sp-history-remove" data-id="${escapeHtml(conversation.id)}" aria-label="删除历史对话" title="删除">
            <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
              <path d="M3 6h18"></path>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
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
  await act({ type: "SAVED_CHANGED", list: data?.[CONVERSATIONS_STORAGE_KEY] });
  renderHistoryList();
  void hydrateConversationPageMetadata();
}

async function hydrateConversationPageMetadata() {
  const candidates = state.view().saved.filter((c) => c.contextRef?.videoId && needsConversationPageHydration(c)).slice(0, 12);
  let changed = false;
  for (const { id, contextRef } of candidates) {
    const response = await sendRuntimeMessage({
      type: "ai-sidepanel-resolve-page-ref",
      contextRef
    }).catch(() => null);
    // A video that is gone never answers: settled without data, so it stops taking a slot at every open.
    const payload = response?.ok ? response.payload : MdgSites.isBiliVideoGone(response?.code) ? null : undefined;
    if (payload !== undefined) {
      changed = state.dispatch({ type: "PAGE_HYDRATED", id, payload }).length > 0 || changed;
    }
  }
  if (!changed) {
    return;
  }
  renderHistoryList();
  updateContextChip();
  await saveConversations();
}

// Merged by entry into a fresh read (SidepanelState.mergeSaved), so a conversation 视频记录 deleted is not written back.
// A failed write leaves the created and deleted ids for the next save.
async function saveConversations() {
  let written = null;
  await MdgLimits.updateConversations((stored) => {
    const { saved, unsaved } = state.view();
    written = unsaved;
    return SidepanelState.mergeSaved(stored, saved, unsaved);
  });
  state.dispatch({ type: "SAVED_WRITTEN", ...written });
  renderHistoryList();
}

function loadConversationById(id) {
  return act({ type: "OPEN", id });
}

async function deleteConversation(id) {
  if (!confirm("删除这条历史对话？删除后不能恢复。")) {
    return;
  }
  await act({ type: "DELETED", id });
}

// A menu and its button: the button says whether it is open (aria-expanded).
function setPopover(button, popover, open) {
  popover.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

function togglePresetPopover(event) {
  event?.stopPropagation();
  hideHistoryPopover();
  hideExportPopover();
  const willShow = els.presetPopover.hidden;
  setPopover(els.presetBtn, els.presetPopover, willShow);
  if (willShow) {
    renderPresetPrompts();
    els.presetInput.value = "";
    syncPresetAdd();
    els.presetInput.focus();
  }
}

function hidePresetPopover() {
  setPopover(els.presetBtn, els.presetPopover, false);
}

function toggleHistoryPopover(event) {
  event?.stopPropagation();
  hidePresetPopover();
  hideExportPopover();
  const willShow = els.historyPopover.hidden;
  setPopover(els.historyBtn, els.historyPopover, willShow);
  if (willShow) {
    renderHistoryList();
  }
}

function hideHistoryPopover() {
  setPopover(els.historyBtn, els.historyPopover, false);
}

function toggleExportPopover(event) {
  event?.stopPropagation();
  hidePresetPopover();
  hideHistoryPopover();
  setPopover(els.exportBtn, els.exportPopover, els.exportPopover.hidden);
}

function hideExportPopover() {
  setPopover(els.exportBtn, els.exportPopover, false);
}

function handleDocumentClick(event) {
  if (els.presetPopover.hidden && els.historyPopover.hidden && els.exportPopover.hidden) {
    return;
  }
  // A click inside a menu keeps it; its button's own click stops before it gets here.
  if (event.target instanceof Element && event.target.closest("#spPresetPopover, #spHistoryPopover, #spExportPopover")) {
    return;
  }
  hidePresetPopover();
  hideHistoryPopover();
  hideExportPopover();
}

// Following the tab never forces a read: the page follows its own URL changes and reads a new video once. Only 刷新 forces.
function scheduleLiveContextSync() {
  if (liveContextSyncTimer) {
    window.clearTimeout(liveContextSyncTimer);
  }
  liveContextSyncTimer = window.setTimeout(() => {
    liveContextSyncTimer = 0;
    void syncLiveContextState();
  }, 120);
}

async function syncLiveContextState() {
  const ok = await loadContextState({ silent: true, follow: true }).catch(() => false);
  if (ok === FOLLOWED_LIVE_VIDEO) {
    return;
  }
  const { bound, context, messages } = state.view();
  if (bound) {
    updateContextChip();
    return;
  }
  if (!ok || !context || !providers.length || !messages.length) {
    renderInitialState();
    return;
  }
  renderSuggestions();
}

// A video switch lights up the chip that names the video; the animation fades it back on its own.
function flashContextChip() {
  const chip = els.contextChip;
  chip.classList.remove("is-switched");
  void chip.offsetWidth;
  chip.classList.add("is-switched");
}

async function loadPreviousVideoConversationId() {
  const data = await chrome.storage.session?.get([PREVIOUS_VIDEO_CONVERSATION_KEY]).catch(() => ({}));
  state.dispatch({ type: "PREVIOUS_LOADED", id: String(data?.[PREVIOUS_VIDEO_CONVERSATION_KEY] || "").trim() });
  renderPreviousVideoBar();
}

// state already names the bar's conversation (id); this keeps it for the session and draws the bar collapsed.
function setPreviousVideoConversation(id) {
  previousVideoExpanded = false;
  if (id) {
    void chrome.storage.session?.set({ [PREVIOUS_VIDEO_CONVERSATION_KEY]: id }).catch(() => {});
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
  const { previousId, saved, id: currentId } = state.view();
  const conversation = previousId ? saved.find((item) => item.id === previousId) : null;
  if (!conversation) {
    previousVideoBarSignature = "";
    bar.hidden = true;
    if (previousId) {
      void act({ type: "PREVIOUS_DISMISSED" });
    }
    return;
  }
  const isCurrent = conversation.id === currentId;
  const signature = [conversation.id, conversation.updatedAt, conversation.messages.length, previousVideoExpanded, isCurrent].join("|");
  if (signature === previousVideoBarSignature) {
    return;
  }
  previousVideoBarSignature = signature;
  bar.hidden = isCurrent;
  if (isCurrent) {
    return;
  }
  const title = conversation.contextTitle || conversation.title || MdgErrors.TEXT.untitledVideo;
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
  const { previousId, saved } = state.view();
  const conversation = saved.find((item) => item.id === previousId);
  if (!action || !conversation) {
    return;
  }
  if (action === "toggle") {
    previousVideoExpanded = !previousVideoExpanded;
    renderPreviousVideoBar();
  } else if (action === "dismiss") {
    void act({ type: "PREVIOUS_DISMISSED" });
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
  if (!targetUrl || !tab?.id || doesTabMatchContextUrl(tab.url || "", targetUrl, state.view().live.context)) {
    return;
  }
  await chrome.tabs.update(tab.id, { url: targetUrl }).catch(() => null);
}

const PRESETS_UNREAD = "读取设置失败，暂时不能修改快捷追问";
// 添加 is disabled with the reason while the box is empty, holds one already listed, or the list is full (one past the
// limit would be cut when saved); Enter follows the same rule, and the typed text stays.
function presetAddReason() {
  if (settingsReadFailed) return PRESETS_UNREAD;
  const text = String(els.presetInput.value || "").trim();
  if (!text) return "先输入快捷追问";
  if ((aiPrefs.aiPresetPrompts || []).includes(text)) return "已有这条快捷追问";
  const full = (aiPrefs.aiPresetPrompts || []).length >= MdgSettings.MAX_PRESET_PROMPTS;
  return full ? `最多 ${MdgSettings.MAX_PRESET_PROMPTS} 条快捷追问，先删掉一条再添加` : "";
}
function syncPresetAdd() {
  setDisabledReason(els.presetAddBtn, presetAddReason());
}

async function addPresetPrompt() {
  if (presetAddReason()) {
    return;
  }
  const text = String(els.presetInput.value || "").trim();
  if (!(await editPresetPrompts((list) => (list.includes(text) ? list : [...list, text])))) {
    return;
  }
  els.presetInput.value = "";
  renderPresetPrompts();
  renderFollowups();
}

async function removePresetPrompt(prompt) {
  if (settingsReadFailed) {
    return;
  }
  if (await editPresetPrompts((list) => list.filter((item) => item !== prompt))) {
    renderPresetPrompts();
    renderFollowups();
  }
}

// Edits save one after another, each on the list the one before saved: a second × clicked during a save removes the
// prompt it was drawn for, and the first removal stays.
let presetWrites = Promise.resolve();
function editPresetPrompts(change) {
  const run = presetWrites.then(() => persistAiPresetPrompts(change(aiPrefs.aiPresetPrompts || [])));
  presetWrites = run.catch(() => false);
  return run;
}

// save-settings keeps the keys it is not sent. The list changes only once it is saved; a refusal (the sync storage
// full, say) leaves it and the typed text as they were and says why. False then.
async function persistAiPresetPrompts(prompts) {
  const resp = await sendRuntimeMessage({ type: "save-settings", settings: { aiPresetPrompts: prompts } }).catch((error) => ({ ok: false, error: error.message }));
  if (!resp?.ok) {
    showConversationContextNotice(`${MdgErrors.TEXT.settingsSaveFailed}：${MdgErrors.text(resp)}`, NOTICE_LONG_MS, { error: true });
    return false;
  }
  aiPrefs.aiPresetPrompts = prompts;
  return true;
}

function updateSidepanelLayoutState() {
  const { context, messages, pinned } = state.view();
  const useCompactInput = Boolean(context && context.isVideoContext === false && !messages.length && !pinned);
  document.body.classList.toggle("sp-non-video-context", useCompactInput);
  if (!activeStream) {
    setStreamingUiState(false);
  }
  if (els.input) {
    autosizeInput();
  }
}

let refreshingContext = false;
async function refreshContextManually() {
  if (refreshingContext) {
    return;
  }
  refreshingContext = true;
  try {
    const ok = await loadContextState({ refresh: true });
    // A question sent while it read: redrawing the empty state would wipe it and its reply.
    if (ok && !activeStream) {
      const { context, messages } = state.view();
      if (!context || !providers.length || !messages.length) {
        renderInitialState();
      } else {
        renderSuggestions();
      }
    }
  } finally {
    refreshingContext = false;
  }
}

// A reply in flight goes on into the conversation it was asked in, as when switching video or conversation.
// The new one takes the tab's context; when the tab cannot be read it starts without one (the empty state then shows
// the read error and 重试), never with the video of the conversation that was open.
async function startNewConversation() {
  await loadContextState({ silent: true });
  await act({ type: "NEW" });
}

// The note card leads the conversation and survives every redraw.
function clearMessages() {
  els.messages.replaceChildren(els.note);
}

// The conversation drawn in the messages (its epoch), -1 for the empty state: drawn again, it keeps the reader's place.
let drawnEpoch = -1;

function renderConversationMessages() {
  updateSidepanelLayoutState();
  // How far the reader scrolled from the anchored question, kept across the redraw. Before they scroll it is 0, also
  // while the scroll to it is still under way (the first save of a new conversation redraws right after sending).
  const pastAnchor = turnAnchor?.top === null && turnAnchor.node.isConnected ? els.messages.scrollTop - turnAnchorTop() : 0;
  const { epoch } = state.view();
  const keptTop = drawnEpoch === epoch ? els.messages.scrollTop : null;
  clearMessages();
  suggestionsNode = null;
  const { messages, nonVideo, unanswered } = state.view();
  if (!messages.length && !unanswered) {
    resetConversationView("");
    return;
  }
  messages.forEach((message) => {
    if (message.role === "user") {
      appendUserMessage(message.content);
      return;
    }
    const node = document.createElement("div");
    node.className = "sp-msg sp-msg-assistant";
    renderAssistantMessage(node, String(message.content || ""));
    els.messages.appendChild(node);
  });
  if (unanswered) {
    appendUserMessage(unanswered.prompt);
    const node = document.createElement("div");
    node.className = "sp-msg sp-msg-assistant";
    els.messages.appendChild(node);
    appendReplyEnd(node, { ...unanswered, raw: "", saved: false });
  }
  const failed = nonVideo ? NON_VIDEO_CONTEXT_MESSAGE : contextFailure()?.text;
  if (failed) {
    showConversationContextError(failed);
  }
  renderFollowups();
  drawnEpoch = epoch;
  // Drawn again in place (another window saved it, a reply ended into it): the question sent here stays where it was,
  // and without one the reader stays where they read. Another conversation opens at its end.
  const question = [...els.messages.querySelectorAll(".sp-msg-user")].pop();
  if (turnAnchor?.epoch === epoch && question) {
    turnAnchor.node = question;
    syncTurnSpacer();
    els.messages.scrollTo({ top: turnAnchorTop() + pastAnchor, behavior: "instant" });
    return;
  }
  turnAnchor = null;
  if (keptTop === null) scrollToBottom();
  else els.messages.scrollTo({ top: keptTop, behavior: "instant" });
}

// Cut by characters, not UTF-16 units, so an emoji is never split in two.
const cutTitle = (text, max) => {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
};

function buildConversationTitleDisplay(title, maxChars = 22) {
  const value = String(title || "").trim();
  const match = value.match(/^(.*?)(-P\d+)$/i);
  if (!match) {
    return { main: cutTitle(value, maxChars), suffix: "" };
  }

  const suffix = String(match[2] || "").trim();
  const reservedChars = Math.max(suffix.length + 3, 6);
  return { main: cutTitle(String(match[1] || "").trim(), Math.max(maxChars - reservedChars, 8)), suffix };
}

// 2026-10-14 07:30, local time.
function formatConversationTimestamp(value) {
  const date = new Date(Number(value) || Date.now());
  return `${MdgCommon.localDate(date)} ${date.toTimeString().slice(0, 5)}`;
}

async function ensureCurrentContextForSend() {
  if (state.view().pinned) {
    const notice = state.view().resolved ? null : showConversationContextNotice("正在加载原视频信息…");
    await loadContextState({ refresh: false, silent: true }).catch(() => null);
    return hydratePinnedConversationContext({ notice });
  }
  const loadingNotice = state.view().context?.pending ? showConversationContextNotice("正在加载视频信息…") : null;
  const ok = await loadContextState({ refresh: false, silent: true });
  loadingNotice?.remove();
  // A placeholder still standing means the subtitles never arrived; never answer from it.
  const context = state.view().context;
  if (!ok || !context || context.pending) {
    resetConversationView(contextErrorHtml(), { retry: true });
    return false;
  }
  return true;
}

// The shown conversation's own video failed to load: { epoch, text (said under it, again at each redraw; "" when the
// load was silent), gone (deleted or hidden on B站: the conversation is only read) }.
let lastContextFailure = null;
const contextFailure = () => (lastContextFailure?.epoch === state.view().epoch ? lastContextFailure : null);

// Loads the shown conversation's own context (state decides when: resolve effects). A load the conversation was
// switched away from meanwhile does nothing. notice: the 正在加载… line it takes down when done.
async function hydratePinnedConversationContext({ silent = false, notice = null } = {}) {
  const { epoch, pinned, resolved } = state.view();
  if (resolved) {
    // Like a video page's context at each send: the viewer playing this video answers again (a track picked since).
    const again = await askViewerFrame(pinned.contextRef);
    if (again) state.dispatch({ type: "CONTEXT_RESOLVED", epoch, payload: again.payload });
    updateContextChip();
    notice?.remove();
    return true;
  }
  const contextRef = pinned?.contextRef || null;
  if (!contextRef) {
    notice?.remove();
    if (!silent) {
      showConversationContextError("历史对话缺少原视频信息，无法继续。");
    }
    return false;
  }

  const response = await resolveConversationContext(contextRef).catch((error) => ({
    ok: false,
    error: error?.message || String(error || "")
  }));
  const ok = Boolean(response?.ok && response.payload);
  const [result] = state.dispatch({ type: "CONTEXT_RESOLVED", epoch, payload: ok ? response.payload : null });
  notice?.remove();
  if (!result) {
    return false;
  }
  // Deleted or hidden on B站 (as the 分拣台 and 视频记录 tell it): no retry will bring it back. Else a send tries again.
  const gone = !ok && MdgSites.isBiliVideoGone(response?.code);
  const text = gone ? VIDEO_GONE : `读取原视频失败：${MdgErrors.text(response)}`;
  lastContextFailure = ok ? null : { epoch, text: silent ? "" : text, gone };
  updateContextChip();
  if (!activeStream) setStreamingUiState(false);
  if (ok) {
    return true;
  }
  // Nothing is loading any more: the error below is the state.
  if (result.wasPending) {
    suggestionsNode?.replaceChildren();
  }
  if (!silent) {
    showConversationContextError(text);
  }
  return false;
}

// 分拣台's viewer frame that last asked for AI 总结: { tabId, frameId, videoId }. Its content script answers for its
// video like a video page does (the track picked in its 专注模式 included); once it is closed or plays another video or part,
// the conversation's video is read like a closed video page's.
let viewerFrame = null;

async function askViewerFrame(contextRef) {
  const frame = viewerFrame;
  if (!frame || frame.videoId !== String(contextRef?.videoId || "")) return null;
  if ((await getActiveTab().catch(() => null))?.id !== frame.tabId) return null;
  const resp = await sendRuntimeMessage({ type: "ai-sidepanel-get-state", tabId: frame.tabId, frameId: frame.frameId, videoId: frame.videoId }).catch(() => null);
  // The frame answers for the part it plays; after it moved on to the next part it no longer plays this one.
  if (resp?.ok && resp.payload && buildConversationContextRef(resp.payload).pageIndex === buildConversationContextRef(contextRef).pageIndex) return resp;
  if (viewerFrame === frame) viewerFrame = null;
  return null;
}

async function resolveConversationContext(contextRef) {
  const fromViewer = await askViewerFrame(contextRef);
  if (fromViewer) return fromViewer;
  return sendRuntimeMessage({ type: "ai-sidepanel-resolve-context", contextRef });
}

// The question sent while its video's content still loads ({ epoch }): drawn at once, so a passive redraw of its
// conversation meanwhile (a tab event, a settings change) is skipped, and another window's save is drawn after it.
let waitingTurn = null;
const waiting = () => waitingTurn?.epoch === state.view().epoch;

// prompt: a 快捷追问 or 重试 sends it without touching the input box; without it the box's text is sent and cleared.
// The question shows at once at the top and its reply's cursor under it; replaces (重试's failed turn) and the empty state
// are hidden meanwhile. onStart runs once the question is surely sent (重试 takes the failed turn away only then). Not
// sent (the video did not load, the conversation changed), the question goes and what it hid comes back.
async function sendMessage(prompt, { onStart = null, replaces = [] } = {}) {
  const typed = prompt === undefined;
  const text = String(typed ? els.input.value : prompt).trim();
  // sendPending closes the window while the context loads, when a second Enter or chip click would send twice.
  if (!text || activeStream || sendPending || readOnlyReason()) {
    return;
  }
  hidePresetPopover();
  hideHistoryPopover();

  const providerId = els.modelSelect.value;
  // No enabled platform: keep the conversation and the typed text, and go to settings like 去设置页添加平台.
  if (!providerId) {
    showConversationContextNotice(`${MdgErrors.TEXT.aiNone}，已打开设置页。`, NOTICE_MS);
    chrome.runtime.openOptionsPage();
    return;
  }

  // The typed question leaves the box now: what is typed while the context loads is the next one. Not sent, it comes
  // back into an empty box.
  const { epoch } = state.view();
  const unsent = () => {
    if (typed && !els.input.value.trim()) {
      els.input.value = text;
      autosizeInput();
    }
  };
  if (typed) {
    els.input.value = "";
    autosizeInput();
  }
  const hidden = [suggestionsNode, ...els.messages.querySelectorAll(".sp-center-error"), ...replaces].filter((node) => node && !node.hidden);
  for (const node of hidden) node.hidden = true;
  const question = appendUserMessage(text);
  turnAnchor = { epoch, node: question, top: -Infinity };
  const reply = appendAssistantPlaceholder();
  waitingTurn = { epoch };
  sendPending = true;
  let hasContext = false;
  try {
    hasContext = await ensureCurrentContextForSend();
  } finally {
    sendPending = false;
    waitingTurn = null;
  }
  // Another conversation now (the tab moved to another video, another was opened): the question was not asked there.
  // Nor when the tab left the video while the context loaded, or a saved video no longer resolves to one.
  const here = hasContext && !activeStream && state.view().epoch === epoch;
  const context = state.view().context;
  if (!here || !context.isVideoContext) {
    question.remove();
    reply.remove();
    if (turnAnchor?.node === question) turnAnchor = null;
    for (const node of hidden) node.hidden = false;
    unsent();
    if (here) showConversationContextError(NON_VIDEO_CONTEXT_MESSAGE);
    if (redrawAfterStream && state.view().epoch === epoch) {
      redrawAfterStream = false;
      renderConversationMessages();
    }
    return;
  }

  onStart?.();
  suggestionsNode?.remove();
  suggestionsNode = null;
  removeCenteredState();

  const stream = {
    port: chrome.runtime.connect({ name: MdgCommon.CHAT_PORT }),
    node: reply,
    prompt: text,
    raw: "",
    notice: "",
    frame: 0,
    ended: false
  };
  activeStream = stream;
  // The reply belongs to the conversation and the context it is asked in (state keeps both until it ends).
  state.dispatch({ type: "SEND", prompt: text });
  setStreamingUiState(true);
  startStreamSlowNoticeTimer();

  stream.port.onMessage.addListener((msg) => {
    if (!msg || stream.ended) {
      return;
    }
    if (msg.type === "token") {
      // A reply that left for its saved conversation says nothing about the one asked here now.
      if (stream === activeStream) handleFirstStreamToken();
      stream.raw += String(msg.data || "");
      scheduleStreamRender(stream);
    } else if (msg.type === "notice") {
      stream.notice = String(msg.text || "");
    } else if (msg.type === "done") {
      endStream(stream);
    } else if (msg.type === "stopped") {
      endStream(stream, { stopped: msg.reason || MdgErrors.TEXT.aiStopped });
    } else if (msg.type === "error") {
      endStream(stream, { error: MdgErrors.text(msg), code: msg.code });
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
      ...context,
      aiSystemPrompt: aiPrefs.aiSystemPrompt
    },
    prompt: text,
    history: state.view().messages
  });
}

function appendUserMessage(text) {
  const node = document.createElement("div");
  node.className = "sp-msg sp-msg-user";
  node.textContent = text;
  els.messages.appendChild(node);
  return node;
}

function appendAssistantPlaceholder() {
  const node = document.createElement("div");
  node.className = "sp-msg sp-msg-assistant";
  const cursor = document.createElement("span");
  cursor.className = "sp-msg-cursor";
  node.appendChild(cursor);
  els.messages.appendChild(node);
  syncTurnSpacer();
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

// A reply that left its conversation ended: state puts it after its question, also in the shown conversation when
// the user reopened it meanwhile.
async function finishDetachedStream({ conversationId, promptIndex, prompt, raw }) {
  const effects = await act({ type: "REPLY_FINISHED", conversationId, promptIndex, prompt, raw });
  if (effects.length && conversationId === state.view().id) {
    redrawConversation();
  }
}

function redrawConversation() {
  if (activeStream || waiting()) redrawAfterStream = true;
  else renderConversationMessages();
}

// Every way a reply ends lands here. A partial answer is kept and saved, also when the stream fails.
function endStream(stream, { stopped = "", error = "", code = "" } = {}) {
  closeStream(stream);
  if (stream !== activeStream) {
    if (stream.conversationId) {
      void finishDetachedStream(stream);
    }
    return;
  }
  activeStream = null;
  clearStreamRuntimeState();
  const { node, raw, prompt, notice } = stream;
  const saved = Boolean(raw.trim());
  const failed = !saved && Boolean(stopped || error);
  // An unanswered failure is not saved, so state keeps it for every redraw (去设置 and a focus change redraw).
  void act({ type: "STREAM_ENDED", raw, failure: failed ? { stopped, notice, error, code } : null });
  if (failed) {
    node.innerHTML = "";
  } else {
    renderAssistantMessage(node, raw);
  }
  appendReplyEnd(node, { prompt, raw, stopped, notice, error, code, saved });
  setStreamingUiState(false);
  if (redrawAfterStream) {
    redrawAfterStream = false;
    renderConversationMessages();
  }
  els.input.focus();
}

// How a reply ended, under it: 已停止生成, the background's notice, the error with its buttons.
function appendReplyEnd(node, { prompt, raw, stopped, notice, error, code, saved }) {
  [stopped, notice].filter(Boolean).forEach((text) => {
    const note = document.createElement("div");
    note.className = "sp-msg-stopped";
    note.textContent = text;
    node.appendChild(note);
  });
  if (error) {
    appendStreamError({ node, prompt, raw }, error, saved, code);
  }
}

function appendStreamError({ node, prompt, raw }, error, saved, code = "") {
  const err = document.createElement("div");
  err.className = "sp-msg-error";
  err.textContent = `错误：${error}`;
  node.appendChild(err);
  // Only the background's own AI_ACCESS: words an AI platform returns must not choose which origin is asked for.
  const access = code === "AI_ACCESS" ? MdgErrors.grantOrigin(error) : null;
  if (access) {
    const grant = document.createElement("button");
    grant.type = "button";
    grant.className = "sp-chip sp-grant-btn";
    grant.textContent = MdgErrors.LABEL.grant;
    grant.addEventListener("click", async () => {
      if (await access.request()) {
        err.textContent = "已授权，请重新发送";
        grant.remove();
      }
    });
    node.appendChild(grant);
  }
  // The AI platform errors 分拣台 stops on (MdgErrors.CODES): 去设置 comes before 重试.
  if (MdgErrors.action(code) === "settings") {
    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "sp-chip sp-grant-btn";
    settings.textContent = MdgErrors.LABEL.toSettings;
    settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
    node.appendChild(settings);
  }
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "sp-chip sp-grant-btn";
  retry.innerHTML = `${AI_SPARK}${MdgErrors.LABEL.retry}`;
  // The retry replaces the failed turn instead of repeating the question below it.
  // Only once the resend starts: one that stops before (the video no longer loads) keeps the failed turn.
  retry.addEventListener("click", () => {
    if (activeStream || sendPending) return;
    const question = node.previousElementSibling?.classList.contains("sp-msg-user") ? node.previousElementSibling : null;
    const turn = [question, node].filter(Boolean);
    void sendMessage(prompt, {
      replaces: turn,
      onStart: () => {
        state.dispatch({ type: "RETRY", prompt, raw, saved });
        for (const item of turn) item.remove();
      }
    });
  });
  node.appendChild(retry);
}

function stopActiveStream() {
  if (!activeStream) {
    return;
  }
  setStreamingUiState(true, { stopping: true });
  try {
    activeStream.port.postMessage({ action: "stop" });
  } catch {
    endStream(activeStream, { stopped: MdgErrors.TEXT.aiStopped });
  }
}

function startStreamSlowNoticeTimer() {
  clearStreamRuntimeState();
  streamFirstTokenReceived = false;
  streamSlowNoticeTimer = window.setTimeout(() => {
    if (!activeStream || streamFirstTokenReceived) {
      return;
    }
    streamSlowNotice = showConversationContextNotice("AI 平台响应较慢，仍在等待…");
  }, STREAM_SLOW_NOTICE_MS);
}

// The slow notice goes at the first token, and only it: a notice shown while the reply waits (a copy, a jump) stays.
function handleFirstStreamToken() {
  if (streamFirstTokenReceived) {
    return;
  }
  clearStreamRuntimeState();
  streamFirstTokenReceived = true;
}

function clearStreamRuntimeState() {
  if (streamSlowNoticeTimer) {
    window.clearTimeout(streamSlowNoticeTimer);
    streamSlowNoticeTimer = 0;
  }
  streamFirstTokenReceived = false;
  streamSlowNotice?.remove();
  streamSlowNotice = null;
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
  copyBtn.setAttribute("aria-label", "复制这条回复的 Markdown");
  copyBtn.setAttribute("title", "复制这条回复的 Markdown");
  copyBtn.innerHTML = `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <rect x="9" y="9" width="10" height="10" rx="2"></rect>
      <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1"></path>
    </svg><span>${MdgErrors.LABEL.copyMd}</span>
  `;
  copyBtn.addEventListener("click", () => void copyMarkdown(pasteReadyRaw));
  actions.appendChild(copyBtn);

  node.appendChild(actions);
}

// The conversation as its own note, for copy and download (obsidian.js builds the one it writes the same way).
// Like the 视频记录 page's export, the triage summary (bilibili P1 only) and the video's note lead it.
async function buildCurrentConversationNote() {
  const { messages, resolved, context: shown, pinned } = state.view();
  const turns = buildConversationTurns(messages);
  if (!turns.length) {
    return null;
  }
  const context = resolved || shown || pinned?.contextRef || {};
  const filename = buildAiConversationFilename(context);
  const noteId = noteVideoId(context);
  const ref = buildConversationContextRef(context);
  const extrasRef = { site: ref.site, videoId: noteId, pageIndex: ref.pageIndex };
  const { analysis, note } = MdgNote.triageExtras(await chrome.storage.local.get(MdgNote.triageExtrasKeys(extrasRef)), extrasRef);
  const markdown = buildAiConversationMarkdown({ context, turns, filename });
  return { context, filename, content: MdgNote.withTriageSummary(markdown, analysis, note) };
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
  const conversation = state.view().saved.find((item) => item.id === conversationId);
  if (!conversation?.contextRef) {
    return;
  }
  try {
    const resp = await sendRuntimeMessage({ type: "sync-video-note-ai", ref: conversation.contextRef, conversation: { messages: conversation.messages } });
    if (!resp?.ok) {
      throw MdgErrors.fromResp(resp, MdgErrors.TEXT.obsidianWriteFailed);
    }
    // Nothing to sync (the video has no note): an earlier failure or gone note no longer holds.
    if (!resp.path) {
      hideSyncStatus();
      return;
    }
    // The background's words: the note updated (hides after a while) or gone (stays).
    showSyncStatus(resp.text, resp.exists ? { autoHideMs: NOTICE_MS } : {});
  } catch (error) {
    // Not set up or a wrong key: 去设置 before 重试, like a manual write; a closed Obsidian gets 重试 only.
    const settings = error?.action === "settings" ? () => chrome.runtime.openOptionsPage() : null;
    showSyncStatus(`${MdgErrors.TEXT.obsidianFailed}：${MdgErrors.messageOf(error)}`, { retry: () => autoSyncConversation(conversationId), settings, error: true });
  }
}

// A failed manual write is red; a wrong key opens the settings page, as for 未配置 (a closed Obsidian does not).
function showObsidianFailure(error) {
  showConversationContextNotice(`${MdgErrors.TEXT.obsidianFailed}：${MdgErrors.messageOf(error)}`, NOTICE_LONG_MS, { error: true });
  if (error?.action === "settings") chrome.runtime.openOptionsPage?.();
}

let syncStatusTimer = 0;
function showSyncStatus(text, { autoHideMs = 0, retry = null, settings = null, error = false } = {}) {
  if (!els.syncStatus) {
    return;
  }
  window.clearTimeout(syncStatusTimer);
  els.syncStatus.classList.toggle("is-error", error);
  els.syncStatus.querySelector("span").textContent = text;
  for (const [act, run] of [["settings", settings], ["retry", retry]]) {
    const button = els.syncStatus.querySelector(`button[data-act="${act}"]`);
    button.hidden = !run;
    button.onclick = run ? () => { els.syncStatus.hidden = true; void run(); } : null;
  }
  els.syncStatus.hidden = false;
  if (autoHideMs > 0) {
    syncStatusTimer = window.setTimeout(() => {
      els.syncStatus.hidden = true;
    }, autoHideMs);
  }
}

function hideSyncStatus() {
  window.clearTimeout(syncStatusTimer);
  if (els.syncStatus) els.syncStatus.hidden = true;
}

// With no conversation the menu's items are disabled (syncExportButtons); what can fail is reading the note's extras.
async function downloadCurrentConversation() {
  try {
    const note = await buildCurrentConversationNote();
    if (note) MdgDownload.text(note.filename, note.content);
  } catch (error) {
    showConversationContextNotice(`下载失败：${MdgErrors.messageOf(error)}`, NOTICE_MS, { error: true });
  }
}

async function copyCurrentConversationMarkdown() {
  try {
    const note = await buildCurrentConversationNote();
    if (note) await copyMarkdown(note.content);
  } catch (error) {
    showConversationContextNotice(`${MdgErrors.TEXT.copyFailed}：${MdgErrors.messageOf(error)}`, NOTICE_MS, { error: true });
  }
}

// Every copy on this page (the export menu's 复制 Markdown and a reply's own): 已复制 Markdown, or the failure in red.
async function copyMarkdown(text) {
  try {
    await navigator.clipboard.writeText(text);
    showConversationContextNotice(MdgErrors.TEXT.copied, NOTICE_SHORT_MS);
  } catch (error) {
    showConversationContextNotice(`${MdgErrors.TEXT.copyFailed}：${MdgErrors.messageOf(error, MdgErrors.TEXT.noClipboard)}`, NOTICE_MS, { error: true });
  }
}

// The background (write-video-note) decides where the conversation goes: the video note's AI 问答 section, a note it
// builds, or the conversation's own note. This page sends the conversation, and the open video page's note when the
// tab shows this video, and asks before an existing note is touched.
async function saveCurrentConversationToObsidian() {
  // Taken before any await: switching video mid-write must not put another video's chat into this note.
  const { epoch, resolved, context: shown, pinned, messages: shownMessages } = state.view();
  const context = resolved || shown || pinned?.contextRef || {};
  const messages = shownMessages.slice();
  // Its button is disabled without a conversation and during a write (syncExportButtons).
  if (obsidianWriting || !buildConversationTurns(messages).length) return;
  obsidianWriting = true;
  syncExportButtons();
  showConversationContextNotice(MdgErrors.TEXT.obsidianWriting);
  try {
    const ref = buildConversationContextRef(context);
    const request = { type: "write-video-note", ref, conversation: { messages }, page: await openPageNote(ref) };
    let resp = await sendRuntimeMessage(request);
    if (resp?.ok && resp.ask) {
      const mode = await MdgOverwriteDialog.choose(resp.path, { hasAiSection: resp.hasAiSection, fullReason: resp.fullReason });
      if (!mode) {
        showConversationContextNotice(MdgErrors.TEXT.obsidianCancelled, NOTICE_SHORT_MS);
        return;
      }
      if (epoch !== state.view().epoch) {
        showConversationContextNotice(MdgErrors.TEXT.obsidianConvSwitched, NOTICE_SHORT_MS);
        return;
      }
      resp = await sendRuntimeMessage({ ...request, mode });
    }
    if (!resp?.ok) {
      throw MdgErrors.fromResp(resp, MdgErrors.TEXT.obsidianWriteFailed);
    }
    showConversationContextNotice(resp.text, NOTICE_LONG_MS);
    // The note exists now: an auto-sync's gone note or failure no longer holds.
    hideSyncStatus();
  } catch (error) {
    showObsidianFailure(error);
  } finally {
    obsidianWriting = false;
    syncExportButtons();
  }
}

// The note the popup's 写入 Obsidian would write, when the active tab shows this video; settled like the popup's read.
async function openPageNote(ref) {
  const tab = await getActiveTab();
  const { live } = state.view();
  if (!ref.videoId || !tab?.id || !live.context || !doesTabMatchContextUrl(live.tabUrl, ref.url, live.context)) {
    return undefined;
  }
  const resp = await sendMessageToActiveTab(tab.id, { type: "popup-refresh" }, 1).catch(() => null);
  const page = resp?.ok ? resp.payload : null;
  return page?.markdown && doesTabMatchContextUrl(page.url, ref.url) ? { markdown: page.markdown, cover: page.cover, warning: page.noteWarning } : undefined;
}

// A caught error's words: its message (or the string thrown), else fallback; never 「{}」 for an Error without words.
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
      const seconds = MdgCommon.parseTimestamp(timestamp);
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

// A newer click takes over: an older jump still loading the page neither seeks nor says anything.
let jumpSeq = 0;
async function jumpToAssistantTimestamp(seconds, label) {
  const seq = ++jumpSeq;
  const safeSeconds = Math.max(0, Number(seconds || 0) || 0);
  const { context, pinned } = state.view();
  const targetUrl = String(context?.url || pinned?.contextUrl || "").trim();
  if (!targetUrl) {
    showConversationContextNotice("没有可跳转的视频", NOTICE_SHORT_MS);
    return;
  }

  const tab = await getActiveTab().catch(() => null);
  if (!tab?.id) {
    showConversationContextNotice(MdgErrors.TEXT.noTab, NOTICE_SHORT_MS, { error: true });
    return;
  }

  // Up while the video page loads (up to 15 秒), not for a fixed time.
  const busy = showConversationContextNotice(`正在跳转到 ${label}…`);

  // 分拣台 is an extension page: only its viewer frame playing this video seeks, and the tab stays put.
  const inTriage = String(tab.url || "").startsWith(chrome.runtime.getURL("triage/"));
  try {
    if (!inTriage && !doesTabMatchContextUrl(tab.url || "", targetUrl, state.view().live.context)) {
      await chrome.tabs.update(tab.id, { url: targetUrl });
      await waitForTabComplete(tab.id);
    }
    if (seq !== jumpSeq) return;
    const response = await sendMessageToActiveTab(tab.id, {
      type: "sidepanel-seek-video-time",
      seconds: safeSeconds,
      videoId: inTriage ? MdgSites.parseRef(targetUrl)?.id || "" : ""
    }, inTriage ? 1 : undefined);
    if (!response?.ok) {
      throw MdgErrors.fromResp(response, MdgErrors.TEXT.reloadRetry);
    }
    busy.remove();
  } catch (error) {
    if (seq !== jumpSeq) return;
    showConversationContextNotice(inTriage ? "先在分拣台里播放这个视频，再点时间" : `时间跳转失败：${MdgErrors.messageOf(error)}`, NOTICE_MS, { error: true });
  }
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      throw new Error("标签页已关闭");
    }
    if (tab.status === "complete") {
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
  // Chrome's words (Receiving end does not exist…) mean the page's copy of the extension did not answer.
  throw new Error(MdgErrors.TEXT.reloadRetry, { cause: lastError });
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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
  emptyStateShown = "";
  const stateNode = document.createElement("div");
  stateNode.className = "sp-center-error";
  stateNode.textContent = String(message);
  els.messages.appendChild(stateNode);
  scrollToBottom();
}

// One notice line: a new one takes its place. error: a failure the user must handle (red). Returns the notice, so a
// 正在… flow takes down its own when done, never one shown since.
function showConversationContextNotice(message, autoHideMs = 0, { error = false } = {}) {
  removeConversationContextNotice();
  const notice = document.createElement("div");
  notice.className = "sp-context-notice";
  notice.classList.toggle("is-error", error);
  notice.textContent = String(message || "").trim();
  // Notices that stay up are the 正在… ones; they get the shared spinner.
  notice.setAttribute("aria-busy", String(!(autoHideMs > 0)));
  els.messages.prepend(notice);
  if (autoHideMs > 0) {
    window.setTimeout(() => notice.remove(), autoHideMs);
  }
  return notice;
}

function removeConversationContextNotice() {
  els.messages.querySelectorAll(".sp-context-notice").forEach((node) => node.remove());
}

// Instant: a redraw starts from the top, and the smooth scrolling sidepanel.css sets would run down the whole conversation.
function scrollToBottom() {
  els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: "instant" });
}

// Where the panel scrolls to put the anchored question at its top. A question taller than a third of the panel shows
// only its last third, so the reply still starts in view.
function turnAnchorTop() {
  const { node } = turnAnchor;
  const top = offsetInMessages(node) - parseFloat(getComputedStyle(els.messages).paddingTop);
  return top + Math.max(0, node.offsetHeight - els.messages.clientHeight / 3);
}

// A node's top in the scrolled content of the messages box.
function offsetInMessages(node) {
  return node.getBoundingClientRect().top - els.messages.getBoundingClientRect().top + els.messages.scrollTop;
}

// Room after the reply, enough to scroll the anchored question to the top, and no more.
function syncTurnSpacer() {
  if (!turnAnchor?.node?.isConnected) {
    turnSpacer.remove();
    return;
  }
  if (els.messages.lastElementChild !== turnSpacer) {
    els.messages.append(turnSpacer);
  }
  const top = turnAnchorTop();
  // Where the content ends is where the spacer starts: scrollHeight never goes below the box's height.
  const content = offsetInMessages(turnSpacer) + parseFloat(getComputedStyle(els.messages).paddingBottom);
  turnSpacer.style.height = `${Math.max(0, Math.ceil(top + els.messages.clientHeight - content))}px`;
  if (turnAnchor.top !== null && Math.abs(top - turnAnchor.top) > 1) {
    turnAnchor.top = top;
    els.messages.scrollTop = top;
  }
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
