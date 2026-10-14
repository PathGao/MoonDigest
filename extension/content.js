// background.js re-injects this file when its version probe misses
// (e.g. mid-navigation). A repeat run must be a no-op, and top-level const would
// throw on redeclaration, so the body sits in this block.
// Bilibili video pages load this in every frame; a subframe only runs it when viewer-frame.js (document_start)
// marked it as 分拣台's viewer. Bilibili iframes on other sites stay inert.
if (!globalThis.__MDG_CONTENT_SCRIPT_LOADED__ && (window === window.top || document.documentElement.hasAttribute("data-mdg-viewer"))) {
// Only for when get-settings fails; the background owns the stored settings.
const DEFAULT_SETTINGS = { ...MdgSettings.DEFAULTS, ...MdgSettings.LOCAL_DEFAULTS };
const { formatCompactTimestamp, buildSubtitlePreview, buildSrt, buildTxt, shouldShowHoursInNote, subtitleMismatchWarning } = MdgNote;
const { escapeHtml } = MdgErrors;

const MDG_VERSION = chrome.runtime.getManifest().version;
// In 分拣台's viewer the tab is 分拣台 itself: the side panel takes the video by reference, not from the tab.
const IN_VIEWER = window !== window.top;
// A subtitle picked from a list the page has since replaced with another video's.
const VIDEO_SWITCHED = "视频已切换，请刷新";
globalThis.__MDG_CONTENT_SCRIPT_LOADED__ = MDG_VERSION;
const state = {
  fetchRunId: 0,
  refreshPromise: null,
  site: "",
  videoId: "",
  aid: "",
  cid: "",
  meta: null,
  pageIndex: 1,
  pageCount: 0,
  pageTitle: "",
  videoDuration: 0,
  description: "",
  title: "",
  author: "",
  authorUrl: "",
  cover: "",
  videoTags: [],
  uploadDate: "",
  subtitles: [],
  selectedSubtitleId: "",
  selectedSubtitleUrl: "",
  selectedSubtitleLang: "",
  subtitleBody: [],
  subtitleFetchState: "idle",
  subtitleFailure: "",
  // B站 listed no subtitle because it saw a logged-out viewer (MdgSites.loadSubtitle's needLogin): not a failure.
  subtitleNeedLogin: false,
  subtitleWarning: "", // set when the shown subtitle's time range does not match the video
  chapters: [],
  hotComments: [],
  markdown: "",
  srt: "",
  txt: "",
  // Focus mode: off → requested (asked for by URL or popup, view not open yet) → entering (open, waiting for the
  // player) ⇄ open (shown). Only stepReader changes it; the three flags below are views of it.
  readerPhase: "off",
  readerGen: 0, // bumped on every entry and close, so an entry's late steps can tell they belong to a closed one
  get readerMode() {
    return this.readerPhase !== "off";
  },
  get readingViewOpen() {
    return this.readerPhase === "entering" || this.readerPhase === "open";
  },
  get readingViewReady() {
    return this.readerPhase === "open";
  },
  readingAutoScroll: true,
  readingTheme: "light",
  readingFontScale: "m",
  readingLetterSpacing: "normal",
  readingLineHeight: "tight",
  readingContentWidth: "medium",
  readingChapterVisible: true,
  readingSettingsExpanded: false,
  readingDescriptionExpanded: false,
  readingActiveSubtitleIndex: -1,
  readingActiveChapterIndex: -1,
  readingNextScrollBehavior: "smooth",
  currentClipSignature: "",
  readingVideoEl: null,
  readingPlayerHost: null,
  readingMainOriginalParent: null,
  readingMainOriginalNextSibling: null,
  readingPlayerAdjustedNodes: [],
  readingPlayerObserver: null,
  readingPlayerObserverTimer: 0,
  readingPlayerMountTimer: 0,
  readingPlayerRetryTimer: 0,
  readingPlayerRetries: 0,
  readingMiniDismissTimer: 0,
  readingControlsHideTimer: 0,
  readingControlsRecoveryTimer: 0,
  readingControlsRecoveryInFlight: false,
  readingControlsLastRecoverAt: 0,
  readingControlsHoverHost: null,
  readingHeaderHoverHost: null,
  readingHeaderHideTimer: 0,
  readingVideoEventsBound: false,
  readingLayoutBound: false,
  uiEventsBound: false,
  runtimeEventsBound: false,
  settingsWatcherBound: false,
  normalPageStateGuardBound: false,
  urlWatcherStarted: false,
  playerAiQuickActionObserver: null,
  playerAiQuickActionLayoutBound: false,
  playerAiQuickActionSyncTimer: 0,
  playerAiQuickActionCursorHideTimer: 0,
  playerAiQuickActionSubmitting: false,
  playerAiQuickActionSuppressedUntil: 0,
  readingDocumentClickBound: false,
  readingManualScrollPauseUntil: 0,
  readingProgrammaticScrollUntil: 0,
  statusText: "准备就绪，点击「刷新」开始。",
  messageText: "",
  settings: { ...DEFAULT_SETTINGS }
};

// mdg_reader=1 in the URL only requests reader mode; the mode itself lives in
// state.readerMode because YouTube drops unknown query params in place during
// its SPA boot (around 3 s after load, before document_idle on a fast load).
function isReaderMode() {
  return state.readerMode;
}

// Every focus-mode change. A pair not in the table (entering twice, ready after a close) is refused and changes nothing.
const READER_STEPS = {
  mark: { off: "requested" },
  enter: { requested: "entering" },
  ready: { entering: "open" },
  unready: { open: "entering" },
  close: { requested: "off", entering: "off", open: "off" }
};
function stepReader(event) {
  const next = READER_STEPS[event][state.readerPhase];
  if (!next) {
    return false;
  }
  state.readerPhase = next;
  if (event === "enter" || event === "close") {
    state.readerGen++;
  }
  return true;
}

function hasReaderParam(url) {
  try {
    return new URL(url).searchParams.get("mdg_reader") === "1";
  } catch {
    return false;
  }
}

// The navigation entry keeps the URL the document loaded with after the rewrite.
function readerEntryRequested() {
  return hasReaderParam(location.href) || hasReaderParam(performance.getEntriesByType("navigation")[0]?.name);
}

function stripReaderModeUrl(url = location.href) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("mdg_reader");
    return parsed.toString();
  } catch {
    return url;
  }
}

function replaceReaderModeUrl(nextUrl) {
  const targetUrl = String(nextUrl || "").trim();
  if (!targetUrl || targetUrl === location.href) {
    return;
  }

  try {
    history.replaceState(history.state, "", targetUrl);
    state.currentClipSignature = computeCurrentClipSignature(location.href);
  } catch (error) {
    logWarn("[MDG] failed to replace reader mode url", error);
  }
}

function isWatchlaterPage(url = location.href) {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "/list/watchlater";
  } catch {
    return false;
  }
}

// Mirrors --mdg-reader-side-width in content.css; 0 below 900px, where the transcript sits under the video.
function getReaderSideWidthPx() {
  if (window.innerWidth <= 900) {
    return 0;
  }
  const max = { compact: 340, narrow: 390, wide: 520, full: 600 }[state.readingContentWidth] || 440;
  return Math.min(max, window.innerWidth * 0.45);
}

function getReaderPagePaddingPx() {
  return Math.min(32, Math.max(16, window.innerWidth * 0.028));
}

function getReaderMainWidthLimit() {
  const side = getReaderSideWidthPx();
  const sideSpace = side ? side + getReaderPagePaddingPx() * 2 : 0;
  return Math.max(320, window.innerWidth - sideSpace - getReaderPagePaddingPx() * 2);
}

function clearNativeReaderFloatingStyles(playerHost = state.readingPlayerHost) {
  if (!state.readingViewOpen || !playerHost) {
    return;
  }

  const targets = [];
  let current = playerHost;
  let depth = 0;
  while (current && current !== document.body && depth < 8) {
    if (
      current.matches?.(sel(reader().playerLayout))
    ) {
      targets.push(current);
    }
    if (current.id === "playerWrap") {
      break;
    }
    current = current.parentElement;
    depth += 1;
  }

  targets.forEach((node) => {
    node.style.removeProperty("position");
    node.style.removeProperty("inset");
    node.style.removeProperty("left");
    node.style.removeProperty("top");
    node.style.removeProperty("right");
    node.style.removeProperty("bottom");
    node.style.removeProperty("transform");
    node.style.removeProperty("width");
    node.style.removeProperty("height");
    node.style.removeProperty("max-width");
    node.style.removeProperty("max-height");
    node.style.removeProperty("margin");
    node.style.removeProperty("z-index");
  });
}

function getReaderPlayerWrapNode(playerHost = state.readingPlayerHost) {
  return closestIn(playerHost, reader().playerWrap) || queryFirst(reader().playerWrap);
}

function hasNativeReaderPlayerLayoutIssue(playerHost = state.readingPlayerHost) {
  if (!state.readingViewOpen || !playerHost) {
    return false;
  }

  const playerStyle = window.getComputedStyle(playerHost);
  if (playerStyle.position === "fixed" || playerStyle.position === "sticky") {
    return true;
  }

  const playerRect = playerHost.getBoundingClientRect();
  const wrapNode = getReaderPlayerWrapNode(playerHost);
  if (!wrapNode) {
    return false;
  }

  const wrapRect = wrapNode.getBoundingClientRect();
  return wrapRect.height <= 8 && playerRect.height > 120;
}

function shouldDebugLog() {
  return Boolean(state.settings?.enableDebugLogs);
}

function logInfo(...args) {
  if (shouldDebugLog()) {
    console.info(...args);
  }
}

function logWarn(...args) {
  if (shouldDebugLog()) {
    console.warn(...args);
  }
}

const ids = {
  root: "mdg-root",
  readingView: "mdg-reading-view",
  readingStatus: "mdg-reading-status",
  readingCloseBtn: "mdg-reading-close-btn",
  readingAutoScroll: "mdg-reading-autoscroll",
  readingThemeSelect: "mdg-reading-theme-select",
  readingSettingsBtn: "mdg-reading-settings-btn",
  readingAiBtn: "mdg-reading-ai-btn",
  readingSettingsPanel: "mdg-reading-settings-panel",
  readingFontScaleSelect: "mdg-reading-font-scale-select",
  readingLetterSpacingSelect: "mdg-reading-letter-spacing-select",
  readingLineHeightSelect: "mdg-reading-line-height-select",
  readingContentWidthSelect: "mdg-reading-content-width-select",
  readingChapterVisible: "mdg-reading-chapter-visible",
  readingSubtitleSelect: "mdg-reading-subtitle-select",
  readingInfoSummary: "mdg-reading-info-summary",
  readingInfoDescription: "mdg-reading-info-description",
  readingDescriptionBtn: "mdg-reading-description-btn",
  readingMeta: "mdg-reading-meta",
  readingChapterList: "mdg-reading-chapters",
  readingTranscriptList: "mdg-reading-transcript",
  readingTranscriptTailSpacer: "mdg-reading-tail-spacer"
};

// An extension reload or update leaves the previous copy running in its own isolated world with a
// dead chrome.runtime. Ask it to stand down; v2.0.0 and older can't and still hold their root.
document.dispatchEvent(new Event("mdg-content-superseded"));
// 3.5.x and older listen for the name from before the rename. Remove after 3.6.
document.dispatchEvent(new Event("boc-content-superseded"));
const predecessorStillRunning = Boolean(document.getElementById(ids.root));
document.addEventListener("mdg-content-superseded", standDown, { once: true });

init();

// Every focus-mode entry goes through here; the view only opens in reader mode.
function markReaderMode() {
  stepReader("mark");
  document.documentElement.setAttribute("data-mdg-reader-mode", "1");
  document.body.setAttribute("data-mdg-reader-mode", "1");
}

function standDown() {
  state.superseded = true;
  // Focus mode moved the page's player into our view; a reload restores the page and the URL reopens focus mode.
  if (state.readerMode || state.readingViewOpen) {
    location.reload();
    return;
  }
  removePlayerAiQuickActionButton();
  document.getElementById(ids.root)?.remove();
}

function init() {
  logInfo(`[MDG] content script loaded, version=${MDG_VERSION}`);
  ensureUiReady({ forceRecreate: true });

  const shouldEnterReaderMode = readerEntryRequested();
  if (shouldEnterReaderMode) {
    markReaderMode();
  } else {
    clearReaderModePageState();
  }

  bindRuntimeEvents();
  bindSettingsWatcher();
  bindNormalPageStateGuard();
  bindPlayerAiQuickActionLayoutEvents();
  startUrlWatcher();
  getSettings().then((settings) => {
    state.settings = settings;
    hydrateReaderStateFromSettings(settings);
    applyReadingViewPresentation();
    startPlayerAiQuickActionObserver();
    schedulePlayerAiQuickActionSync();
    if (shouldEnterReaderMode) {
      enterReaderMode().catch((error) => {
        setReadingNotice(`专注模式启动失败：${getErrorMessage(error)}`);
      });
    }
  });
}

function ensureUiReady({ forceRecreate = false } = {}) {
  const existingRoot = document.getElementById(ids.root);
  if (existingRoot && forceRecreate) {
    existingRoot.remove();
    state.uiEventsBound = false;
  }

  let root = document.getElementById(ids.root);
  if (!root) {
    root = document.createElement("div");
    root.id = ids.root;
    root.innerHTML = buildUiHtml();
    document.body.appendChild(root);
    document.documentElement.dataset.mdgSite = currentSite()?.id || "";
    state.uiEventsBound = false;
  }

  if (!state.uiEventsBound) {
    bindUiEvents();
    state.uiEventsBound = true;
  }
}

function clearReaderModePageState() {
  document.documentElement.removeAttribute("data-mdg-reader-mode");
  document.documentElement.removeAttribute("data-mdg-reader-line-height");
  document.documentElement.removeAttribute("data-mdg-reader-theme");
  document.documentElement.removeAttribute("data-mdg-reader-font-scale");
  document.documentElement.removeAttribute("data-mdg-reader-letter-spacing");
  document.documentElement.removeAttribute("data-mdg-reader-content-width");
  document.documentElement.removeAttribute("data-mdg-reader-chapter-visibility");
  document.documentElement.removeAttribute("data-mdg-reader-has-chapters");
  document.body.removeAttribute("data-mdg-reader-mode");
  document.body.removeAttribute("data-mdg-reader-line-height");
  document.body.removeAttribute("data-mdg-reading-active");
}

function shouldForceNormalPageState() {
  return !state.readerMode && !state.readingViewOpen;
}

function enforceNormalPageStateIfNeeded() {
  if (state.superseded || !shouldForceNormalPageState()) {
    return;
  }
  clearReaderModePageState();
}

function bindNormalPageStateGuard() {
  if (state.normalPageStateGuardBound) {
    return;
  }
  state.normalPageStateGuardBound = true;

  const observer = new MutationObserver(() => {
    enforceNormalPageStateIfNeeded();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      "data-mdg-reader-mode",
      "data-mdg-reader-line-height",
      "data-mdg-reader-theme",
      "data-mdg-reader-font-scale",
      "data-mdg-reader-letter-spacing",
      "data-mdg-reader-content-width",
      "data-mdg-reader-chapter-visibility",
      "data-mdg-reader-has-chapters"
    ]
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["data-mdg-reader-mode", "data-mdg-reader-line-height", "data-mdg-reading-active"]
  });
  enforceNormalPageStateIfNeeded();
}

function bindRuntimeEvents() {
  if (state.runtimeEventsBound) {
    return;
  }
  state.runtimeEventsBound = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (message.type === "popup-get-state") {
      sendResponse({ ok: true, payload: getPopupPayload() });
      return false;
    }

    // Opening the popup reads the video as it is; its 刷新 button sends force.
    if (message.type === "popup-refresh") {
      settledClip(message.force === true)
        .then(() => sendResponse({ ok: true, payload: getPopupPayload() }))
        .catch((error) =>
          sendResponse({ ok: false, error: fetchErrorText(error), payload: getPopupPayload() })
        );
      return true;
    }

    if (message.type === "popup-select-subtitle") {
      switchSubtitle(String(message.url || "").trim())
        .then(() => sendResponse({ ok: true, payload: getPopupPayload() }))
        .catch((error) => sendResponse({ ok: false, error: fetchErrorText(error), payload: getPopupPayload() }));
      return true;
    }

    if (message.type === "popup-send-obsidian") {
      sendToObsidian()
        .then((failure) => sendResponse({ ok: true, ...failure, payload: getPopupPayload() }))
        .catch((error) =>
          sendResponse({ ok: false, error: getErrorMessage(error), payload: getPopupPayload() })
        );
      return true;
    }

    if (message.type === "popup-trigger-reading-view") {
      state.playerAiQuickActionSuppressedUntil = Date.now() + 2500;
      removePlayerAiQuickActionButton();
      ensureUiReady();
      const readerUrl = String(message.readerUrl || "").trim();
      // That old copy would strip focus mode's page attributes; a fresh load leaves only this one.
      if (readerUrl && predecessorStillRunning) {
        sendResponse({ ok: true });
        location.assign(readerUrl);
        return false;
      }
      if (readerUrl) {
        replaceReaderModeUrl(readerUrl);
      }
      markReaderMode();
      if (!state.readingViewOpen) {
        enterReaderMode().catch((error) => {
          logWarn("[MDG] reading mode trigger failed", error);
        });
      }
      sendResponse({ ok: true });
      return false;
    }

    // The side panel and the player's ✦ (through background.js) read the video here; refresh is their 刷新.
    if (message.type === "sidepanel-get-context") {
      // From 分拣台's side panel (videoId): a viewer that autoplayed on to another video does not answer for it.
      if (message.videoId && MdgSites.parseRef(location.href)?.id !== message.videoId) return false;
      clipContext(message.refresh === true)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: fetchErrorText(error), ...(error?.code != null && { code: error.code }) }));
      return true;
    }

    if (message.type === "sidepanel-seek-video-time") {
      // From 分拣台: only the viewer frame playing that video answers.
      if (message.videoId && MdgSites.parseRef(location.href)?.id !== message.videoId) return false;
      const seconds = Number(message.seconds);
      const video = getRuntimeVideoElement();
      if (!video) {
        sendResponse({ ok: false, error: "当前页面没有找到可联动的视频播放器。" });
        return false;
      }
      const nextTime = seekVideo(video, seconds);
      if (state.readingViewOpen) {
        state.readingManualScrollPauseUntil = 0;
        state.readingNextScrollBehavior = "auto";
        updateReaderFollowState();
        syncReadingViewPlayback(true);
      }
      sendResponse({ ok: true, currentTime: nextTime });
      return false;
    }

    return false;
  });
}

function bindSettingsWatcher() {
  if (state.settingsWatcherBound || !chrome.storage?.onChanged) {
    return;
  }
  state.settingsWatcherBound = true;

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" && areaName !== "local") {
      return;
    }
    // The popup copies state.markdown as is, so a new answer must reach it before the next refresh.
    const runId = state.fetchRunId;
    if (changes[MdgLimits.KEYS.aiConversations] && state.markdown) {
      loadAiTurns().then((turns) => {
        if (runId !== state.fetchRunId) return;
        state.aiTurns = turns;
        rebuildDerivedContent();
      });
    }
    const extrasRef = { site: state.site, videoId: state.videoId, pageIndex: state.pageIndex };
    if (MdgNote.triageExtrasKeys(extrasRef).some((key) => changes[key]) && state.markdown) {
      loadTriageExtras().then((extras) => {
        if (runId !== state.fetchRunId) return;
        state.triageExtras = extras;
        rebuildDerivedContent();
      });
    }
    // Any setting (sync keys of MdgSettings.DEFAULTS) or the AI platforms. Note settings (附带热门评论, 笔记属性, 笔记标签…)
    // shape the note: the popup copies and downloads state.markdown and the side panel builds from state.settings, so
    // both rebuild here, like 写入 Obsidian, which builds with the settings of the moment.
    const changed = areaName === "sync" && Object.keys(changes).some((k) => k === "aiProviders" || Object.hasOwn(MdgSettings.DEFAULTS, k));
    if (!changed) {
      return;
    }

    getSettings()
      .then((settings) => {
        state.settings = settings;
        hydrateReaderStateFromSettings(settings);
        applyReadingViewPresentation();
        schedulePlayerAiQuickActionSync();
        if (state.markdown && runId === state.fetchRunId) refreshDerivedContent().catch(() => {});
      })
      .catch((error) => {
        logWarn("[MDG] failed to refresh settings after storage change", error);
      });
  });
}

function buildUiHtml() {
  return `
    <section id="${ids.readingView}" aria-hidden="true" data-mdg-reader-ready="0" aria-busy="true">
      <div class="mdg-reading-layout">
        <aside class="mdg-reading-rail">
          <div class="mdg-reading-eyebrow">章节</div>
          <div id="${ids.readingChapterList}" class="mdg-reading-list"></div>
        </aside>

        <section class="mdg-reading-stage">
          <header class="mdg-reading-header">
            <div class="mdg-reading-header-copy">
              <strong class="mdg-reading-title">${escapeHtml(state.title || "专注模式")}</strong>
              <div id="${ids.readingMeta}" class="mdg-reading-meta">${escapeHtml(currentSite()?.domain || "")}</div>
            </div>
            <div class="mdg-reading-actions">
              <button id="${ids.readingAiBtn}" type="button" class="mdg-reading-icon-btn" title="AI 总结" aria-label="AI 总结">${buildPlayerAiQuickActionIconSvg()}</button>
              <button id="${ids.readingThemeSelect}" type="button" class="mdg-reading-icon-btn" title="主题" aria-label="切换主题">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
              </button>
              <button id="${ids.readingSettingsBtn}" type="button" class="mdg-reading-icon-btn" title="设置" aria-label="设置" aria-expanded="false" aria-controls="${ids.readingSettingsPanel}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
              <button id="${ids.readingCloseBtn}" type="button" class="mdg-reading-icon-btn" title="退出" aria-label="退出专注模式">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </header>

          <section id="${ids.readingSettingsPanel}" class="mdg-reading-panel mdg-reading-settings-panel" hidden>
            <section class="mdg-reading-settings-group">
              <div class="mdg-reading-eyebrow">排版</div>
              <div class="mdg-reading-stepper-list">
                ${buildReaderStepperControl({
                  id: ids.readingFontScaleSelect,
                  title: "字号",
                  settingKey: "readerFontScale"
                })}
                ${buildReaderStepperControl({
                  id: ids.readingLetterSpacingSelect,
                  title: "字间距",
                  settingKey: "readerLetterSpacing"
                })}
                ${buildReaderStepperControl({
                  id: ids.readingLineHeightSelect,
                  title: "行间距",
                  settingKey: "readerLineHeight"
                })}
                ${buildReaderStepperControl({
                  id: ids.readingContentWidthSelect,
                  title: "字幕栏宽度",
                  settingKey: "readerContentWidth"
                })}
              </div>
            </section>

            <section class="mdg-reading-settings-group">
              <div class="mdg-reading-eyebrow">字幕</div>
              <div class="mdg-reading-controls">
                <label class="mdg-reading-toggle mdg-reading-toggle-inline">
                  <input id="${ids.readingAutoScroll}" type="checkbox" checked />
                  <span>跟随</span>
                </label>
                <label class="mdg-reading-toggle mdg-reading-toggle-inline">
                  <input id="${ids.readingChapterVisible}" type="checkbox" checked />
                  <span>章节</span>
                </label>
              </div>
              <div class="mdg-reading-controls">
                <select id="${ids.readingSubtitleSelect}" class="mdg-reading-select" aria-label="字幕语言">
                </select>
              </div>
            </section>

            <section class="mdg-reading-settings-group mdg-reading-info-group">
              <div class="mdg-reading-eyebrow">视频信息</div>
              <div id="${ids.readingInfoSummary}" class="mdg-reading-info-list"></div>
            </section>
            <section class="mdg-reading-settings-group mdg-reading-info-group">
              <div class="mdg-reading-eyebrow">视频简介</div>
              <div id="${ids.readingInfoDescription}" class="mdg-reading-info-copy"></div>
              <button id="${ids.readingDescriptionBtn}" type="button" class="mdg-reading-text-btn">展开简介</button>
            </section>
          </section>

          <div class="mdg-reading-player-shell">
            <div class="mdg-reading-player-slot"></div>
          </div>

          <section class="mdg-reading-main">
            <div id="${ids.readingTranscriptList}" class="mdg-reading-transcript"></div>
          </section>
        </section>
      </div>
    </section>
    <p id="${ids.readingStatus}" class="mdg-reading-status" role="status" title="点击关闭" hidden></p>
  `;
}

function bindUiEvents() {
  const readingView = byId(ids.readingView);
  const readingCloseBtn = byId(ids.readingCloseBtn);
  const readingAutoScroll = byId(ids.readingAutoScroll);
  const readingThemeSelect = byId(ids.readingThemeSelect);
  const readingSettingsToggleBtn = byId(ids.readingSettingsBtn);
  const readingFontScaleSelect = byId(ids.readingFontScaleSelect);
  const readingLetterSpacingSelect = byId(ids.readingLetterSpacingSelect);
  const readingLineHeightSelect = byId(ids.readingLineHeightSelect);
  const readingContentWidthSelect = byId(ids.readingContentWidthSelect);
  const readingDescriptionBtn = byId(ids.readingDescriptionBtn);
  const chapterList = byId(ids.readingChapterList);
  const transcriptList = byId(ids.readingTranscriptList);

  readingCloseBtn.addEventListener("click", () => {
    replaceReaderModeUrl(stripReaderModeUrl(location.href));
    closeReadingView();
  });
  readingAutoScroll.addEventListener("change", (event) => {
    state.readingAutoScroll = Boolean(event.target.checked);
    if (state.readingAutoScroll) {
      state.readingManualScrollPauseUntil = 0;
      syncReadingViewPlayback(true);
    }
    updateReaderFollowState();
  });
  const readingChapterVisible = byId(ids.readingChapterVisible);
  if (readingChapterVisible) {
    readingChapterVisible.addEventListener("change", (event) => {
      updateReaderPreferences({ readerChapterVisible: Boolean(event.target.checked) }, { persist: true });
    });
  }
  readingThemeSelect.addEventListener("click", () => {
    const themes = ["light", "dark", "paper"];
    const current = state.readingTheme || "light";
    const nextIndex = (themes.indexOf(current) + 1) % themes.length;
    updateReaderPreferences({ readerTheme: themes[nextIndex] }, { persist: true });
    readingThemeSelect.classList.add("is-active");
    setTimeout(() => readingThemeSelect.classList.remove("is-active"), 300);
  });
  readingSettingsToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    state.readingSettingsExpanded = !state.readingSettingsExpanded;
    renderReaderPanels();
    // The panel is display:none until now, so the description could not be measured before.
    if (state.readingSettingsExpanded) {
      renderReadingInfoPanel();
    }
  });
  readingDescriptionBtn.addEventListener("click", () => {
    state.readingDescriptionExpanded = !state.readingDescriptionExpanded;
    renderReadingInfoPanel();
  });
  bindReaderStepperControl(readingFontScaleSelect, "readerFontScale");
  bindReaderStepperControl(readingLetterSpacingSelect, "readerLetterSpacing");
  bindReaderStepperControl(readingLineHeightSelect, "readerLineHeight");
  bindReaderStepperControl(readingContentWidthSelect, "readerContentWidth");

  byId(ids.readingSubtitleSelect).addEventListener("change", onReadingSubtitleChange);

  if (!state.readingDocumentClickBound) {
    document.addEventListener("click", (e) => {
      if (!state.readingSettingsExpanded) return;
      const settingsPanel = document.getElementById(ids.readingSettingsPanel);
      const settingsBtnEl = document.getElementById(ids.readingSettingsBtn);
      if (!settingsPanel || !settingsBtnEl) {
        return;
      }
      if (!settingsPanel.contains(e.target) && !settingsBtnEl.contains(e.target)) {
        state.readingSettingsExpanded = false;
        renderReaderPanels();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (MdgTyping.composing(e) || e.key !== "Escape" || !state.readingSettingsExpanded) return;
      // Esc in Bilibili's own fields (the comment box, the danmaku box) is theirs; in the panel's own controls it closes it.
      const from = e.composedPath?.()[0] || e.target;
      if (MdgTyping.typingIn(e) && !document.getElementById(ids.readingSettingsPanel)?.contains(from)) return;
      state.readingSettingsExpanded = false;
      renderReaderPanels();
      document.getElementById(ids.readingSettingsBtn)?.focus();
    });
    state.readingDocumentClickBound = true;
  }

  const handleReaderManualScroll = () => {
    if (Date.now() <= state.readingProgrammaticScrollUntil) {
      return;
    }
    noteManualReaderInteraction();
  };
  transcriptList.addEventListener("scroll", handleReaderManualScroll);
  transcriptList.addEventListener("wheel", handleReaderManualScroll, { passive: true });
  chapterList.addEventListener("wheel", handleReaderManualScroll, { passive: true });
  chapterList.addEventListener("pointerdown", () => noteManualReaderInteraction(3500));
  transcriptList.addEventListener("pointerdown", () => noteManualReaderInteraction(3500));
  byId(ids.readingStatus).addEventListener("click", () => setReadingNotice(""));
  // Same request as the popup's AI 总结, so it works even when the player button is turned off.
  byId(ids.readingAiBtn).addEventListener("click", () => {
    sendRuntimeMessage({ type: "player-ai-quick-action", source: "popup", contextRef: viewerContextRef() })
      .then((resp) => setReadingNotice(resp?.ok ? "" : `打开侧边栏失败：${resp?.error || "未知错误"}`))
      .catch((error) => setReadingNotice(`打开侧边栏失败：${getErrorMessage(error)}`));
  });
  chapterList.addEventListener("click", onReadingChapterClick);
  transcriptList.addEventListener("click", onReadingTranscriptClick);
  readingView.addEventListener("transitionend", () => {
    if (!state.readingViewOpen) {
      stopReadingViewSync();
    }
  });
}

function startUrlWatcher() {
  if (state.urlWatcherStarted) {
    return;
  }
  state.urlWatcherStarted = true;

  window.setInterval(checkUrlChange, 1200);
  // YouTube navigates in place; its event beats the interval by up to a second.
  document.addEventListener("yt-navigate-finish", checkUrlChange);
}

function checkUrlChange() {
  if (state.superseded) {
    return;
  }
  const nextUrl = location.href;
  const nextSignature = computeCurrentClipSignature();
  if (nextSignature === state.currentClipSignature) {
    return;
  }

  state.currentClipSignature = nextSignature;
  try {
    if (!IN_VIEWER) chrome.runtime.sendMessage({ type: "mdg-video-changed", url: nextUrl })?.catch?.(() => {});
  } catch {}
  enforceNormalPageStateIfNeeded();
  ensureUiReady();
  // Invalidate the previous video's run so nothing waiting on it gets its subtitles.
  state.fetchRunId++;
  state.refreshPromise = null;
  resetClipState();
  const shouldEnterReaderMode = hasReaderParam(nextUrl);
  if (!state.readingViewOpen && shouldEnterReaderMode) {
    markReaderMode();
    enterReaderMode().catch((error) => {
      setReadingNotice(`专注模式启动失败：${getErrorMessage(error)}`);
    });
    return;
  }
  if (state.readingViewOpen || shouldEnterReaderMode) {
    setReadingNotice("");
    const runId = state.fetchRunId;
    waitForVideoMetadata().then(() => {
      if (runId !== state.fetchRunId) {
        return;
      }
      refreshClip().catch((error) => {
        if (!isStaleRunError(error)) {
          setReadingNotice(`自动刷新失败：${fetchErrorText(error)}`);
        }
      });
    });
  }
  // Out of 专注模式 nothing is read here: the next entry that asks (popup, side panel, player ✦) reads it via settledClip.
}

function resetClipState() {
  state.site = "";
  state.videoId = "";
  state.aid = "";
  state.cid = "";
  state.meta = null;
  state.pageIndex = 1;
  state.pageCount = 0;
  state.pageTitle = "";
  state.videoDuration = 0;
  state.description = "";
  state.title = "";
  state.author = "";
  state.authorUrl = "";
  state.cover = "";
  state.videoTags = [];
  state.uploadDate = "";
  state.subtitles = [];
  state.selectedSubtitleId = "";
  state.selectedSubtitleUrl = "";
  state.selectedSubtitleLang = "";
  state.subtitleBody = [];
  state.subtitleFetchState = "idle";
  state.subtitleWarning = "";
  state.subtitleFailure = "";
  state.subtitleNeedLogin = false;
  state.chapters = [];
  state.hotComments = [];
  state.triageExtras = null;
  state.markdown = "";
  state.srt = "";
  state.txt = "";
  state.currentClipSignature = computeCurrentClipSignature();
  stopReadingViewSync();
  state.readingActiveSubtitleIndex = -1;
  state.readingActiveChapterIndex = -1;
  state.readingVideoEl = null;
  stopReaderPlayerObserver();

  setMessage("");
  if (state.readingViewOpen) {
    renderReadingView();
  }
}

function buildSidepanelContext() {
  const settings = state.settings || DEFAULT_SETTINGS;
  const body = state.subtitleBody || [];
  let subtitleMarkdown = "";
  try {
    subtitleMarkdown = body.length
      ? MdgNote.buildAiContext(state, body, settings, currentRef())
      : "";
  } catch (e) {
    subtitleMarkdown = "";
    logWarn("[MDG] sidepanel-get-context: buildMarkdown failed", e);
  }
  return {
    ok: true,
    payload: {
      url: location.href,
      title: state.title || "",
      author: state.author || "",
      uploadDate: state.uploadDate || "",
      site: state.site || "",
      videoId: state.videoId || "",
      cid: state.cid || "",
      aid: state.aid || "",
      description: state.description || "",
      pageIndex: Number(state.pageIndex) > 0 ? Number(state.pageIndex) : 1,
      pageCount: Number(state.pageCount) > 0 ? Number(state.pageCount) : 0,
      pageTitle: state.pageTitle || "",
      subtitleBody: body,
      subtitleMarkdown,
      subtitleFailure: state.subtitleFailure,
      subtitleNeedLogin: state.subtitleNeedLogin,
      subtitleWarning: state.subtitleWarning || "",
      subtitleLang: state.selectedSubtitleLang || "",
      selectedSubtitleId: state.selectedSubtitleId || "",
      selectedSubtitleUrl: state.selectedSubtitleUrl || "",
      subtitleOptions: state.subtitles || [],
      hotComments: state.hotComments || []
    }
  };
}

// The tab's current video, settled: every entry point (popup, side panel, player ✦, focus mode) reads it here.
// It first takes up a URL change the 1.2 s watcher has not seen yet, so nothing returns the old video or races a second
// fetch. It joins the run in flight, or starts one when forced or nothing is loaded. A run the video change
// superseded is never the answer: it waits for the run that replaced it, or starts one for the current video.
// Rejects with the current video's failure.
async function settledClip(force = false) {
  for (;;) {
    checkUrlChange();
    let run = state.refreshPromise;
    if (!run && (force || !state.videoId)) {
      run = refreshClip();
      force = false;
    }
    if (!run) return;
    const runId = state.fetchRunId;
    const failure = await run.then(() => null, (error) => error);
    if (runId !== state.fetchRunId) continue;
    if (failure) throw failure;
    return;
  }
}

// The context the side panel and the AI get, with the hot comments of the same video.
async function clipContext(refresh) {
  for (;;) {
    await settledClip(refresh);
    refresh = false;
    const runId = state.fetchRunId;
    let comments = state.hotComments;
    if (!comments?.length && currentSite()?.fetchComments && state.videoId) {
      comments = await fetchHotComments().catch((error) => {
        logWarn("[MDG] failed to fetch hot comments for the side panel", error);
        return [];
      });
    }
    if (runId !== state.fetchRunId) continue;
    state.hotComments = comments;
    return buildSidepanelContext();
  }
}

// Every run registers itself, whoever started it (popup, URL watcher, refresh button), so settledClip can join it.
function refreshClip() {
  const run = runRefreshClip().finally(() => {
    if (state.refreshPromise === run) {
      state.refreshPromise = null;
    }
  });
  state.refreshPromise = run;
  return run;
}

async function runRefreshClip() {
  const runId = ++state.fetchRunId;
  let metaLoaded = false;
  try {
    setMessage("");
    setStatus("正在抓取视频信息…");
    state.subtitleFetchState = "loading";
    if (state.readingViewOpen) {
      renderReadingView();
    }
    state.settings = await getSettings();
    ensureRunActive(runId);

    const site = currentSite();
    const ref = site?.parseRef(location.href);
    if (!ref) {
      throw new Error(MdgErrors.TEXT.notVideoPage);
    }
    state.site = ref.site;
    state.videoId = ref.id;
    // Taken before the awaits: a navigation mid-run must still look like a change to checkUrlChange.
    const clipSignature = computeCurrentClipSignature();

    const meta = await retryAsync(() => site.fetchMeta(ref, siteIo()), 2, 250);
    ensureRunActive(runId);
    logInfo("[MDG] raw meta data", { meta });

    const dom = site.readDom(document);
    state.meta = meta;
    metaLoaded = true;
    state.aid = meta.aid || "";
    state.title = meta.title || dom.title;
    state.author = meta.author || dom.author;
    state.authorUrl = meta.authorUrl || "";
    state.cover = meta.cover || "";
    state.videoTags = Array.isArray(meta.tags) ? meta.tags : [];
    state.uploadDate = meta.uploadDate || dom.uploadDate;
    state.description = meta.description || dom.description;
    state.pageCount = Number(meta.pageCount) || 0;
    state.currentClipSignature = clipSignature;
    state.pageIndex = Number(meta.pageIndex) > 0 ? Number(meta.pageIndex) : 1;
    state.pageTitle = meta.pageTitle || "";
    state.cid = meta.cid || "";
    state.videoDuration = Number(meta.duration) || 0;
    if (!(state.videoDuration > 0)) {
      state.videoDuration = readRuntimeVideoDuration();
    }
    if (!(state.videoDuration > 0)) {
      throw new Error("无法获取当前视频时长，已停止抓取以避免串到错误字幕。");
    }

    logInfo("[MDG] resolved video ids", {
      url: location.href,
      aid: state.aid,
      site: state.site,
      videoId: state.videoId,
      cid: state.cid,
      pageIndex: state.pageIndex,
      videoDuration: state.videoDuration
    });

    setStatus("正在获取可用字幕…");
    const found = await MdgSites.loadSubtitle(
      pageSubtitleSite(site, runId),
      currentRef(),
      { ...state.meta, duration: state.videoDuration },
      { ...siteIo(), fresh: true },
      {
        prefer: { previousId: state.selectedSubtitleId, previousUrl: state.selectedSubtitleUrl, previousLang: state.selectedSubtitleLang },
        step: runStep(runId)
      }
    );
    state.subtitles = found.tracks;
    state.chapters = MdgSites.normalizeChapters(
      found.bundle.chapters?.length ? found.bundle.chapters : MdgSites.parseChaptersFromDescription(state.description)
    );
    logInfo("[MDG] subtitle tracks", state.subtitles.map(({ id, lang, label, kind, url }) => ({ id, lang, label, kind, url })));
    // 无字幕时也允许进入专注模式，只是字幕区域保持空态。
    if (!found.track) {
      await showNoSubtitleState(runId, { failure: found.error ? failureReason(found.error) : "", needLogin: found.needLogin });
      return;
    }
    logInfo("[MDG] selected subtitle track", { id: found.track.id, lang: found.track.lang, label: found.track.label });
    await showSubtitle(found, runId);
    if (state.readingViewOpen) {
      moveReadingMainInline();
      renderReadingView();
      setReadingNotice(state.subtitleWarning);
      startReaderPlayerObserver();
      syncReadingViewPlayback(true);
    }
    setStatus(
      state.subtitleWarning + (state.settings.obsidianEnabled ? "抓取完成，可以复制、下载或写入 Obsidian。" : "抓取完成，可以复制或下载。")
    );
  } catch (error) {
    // A newer run (the video changed) owns the state now: an old video's late failure must not reset or mark it.
    if (isStaleRunError(error) || runId !== state.fetchRunId) {
      return;
    }
    const reason = failureReason(error);
    // Only the subtitle step failed: keep the video info and degrade to the no-subtitle state.
    if (metaLoaded) {
      try {
        await showNoSubtitleState(runId, { failure: reason });
      } catch (degradeError) {
        if (isStaleRunError(degradeError) || runId !== state.fetchRunId) {
          return;
        }
        throw degradeError;
      }
      return;
    }
    resetClipState();
    state.subtitleFetchState = "error";
    if (state.readingViewOpen) {
      renderReadingView();
    }
    setStatus(`抓取失败：${reason}。`);
    throw error;
  }
}

// Reasons arrive with or without a trailing full stop; strip it so the sentences after them join cleanly.
function failureReason(error) {
  return fetchErrorText(error).replace(/[。.！!；;，,\s]+$/u, "");
}

// The page's reads under the shared subtitle step (MdgSites.loadSubtitle). The track list is retried; B站 sometimes
// answers it empty under risk control (one more try 1.5s later), and as logged out when the background request goes
// without the page's cookies (asked again from the page). A rate-limited subtitle file waits a few seconds once.
function pageSubtitleSite(site, runId) {
  const fetchTracks = async (ref, meta, io) => {
    const bundle = await site.fetchTracks(ref, meta, io);
    return bundle.needLogin && !site.pageOnly ? site.fetchTracks(ref, meta, { ...io, fetchJson }) : bundle;
  };
  return {
    ...site,
    async fetchTracks(ref, meta, io) {
      const bundle = await retryAsync(() => fetchTracks(ref, meta, io), 3, 500);
      if (bundle.tracks.length || site.id !== "bilibili") return bundle;
      await sleep(1500);
      ensureRunActive(runId);
      return fetchTracks(ref, meta, io);
    },
    async fetchRaw(track, io) {
      try {
        return await site.fetchRaw(track, io);
      } catch (error) {
        if (error?.status !== 429) throw error;
      }
      await sleep(3000 + Math.random() * 2000);
      ensureRunActive(runId);
      return site.fetchRaw(track, io).catch((error) => {
        throw error?.status === 429 ? Object.assign(new Error("字幕接口限流（429），稍后再试"), { status: 429 }) : error;
      });
    }
  };
}

// Shows the track MdgSites.loadSubtitle or loadFirstTrack chose, with the warning when its time range does not match.
async function showSubtitle({ track, body, mismatch }, runId) {
  state.selectedSubtitleId = track.id ? String(track.id) : state.selectedSubtitleId;
  state.selectedSubtitleUrl = track.url;
  state.selectedSubtitleLang = track.label || track.lang || "unknown";
  state.subtitleBody = body;
  state.subtitleWarning = mismatch ? subtitleMismatchWarning(mismatch) : "";
  state.subtitleFetchState = "ready";
  await refreshDerivedContent();
  ensureRunActive(runId);
  if (state.readingViewOpen) {
    renderReadingView();
    syncReadingViewPlayback(true);
  }
}

// The popup's and focus mode's subtitle pickers. Only a track of the video shown: the list may belong to a video the
// page has since left. A track whose time range does not match the video is used with the warning, as on first load.
async function switchSubtitle(url) {
  const track = url && state.subtitles.find((item) => item.url === url);
  if (!track) {
    throw new Error(VIDEO_SWITCHED);
  }
  const runId = state.fetchRunId;
  try {
    const got = await MdgSites.loadFirstTrack(currentSite(), [track], { videoId: state.videoId, cid: state.cid }, siteIo(), state.videoDuration, runStep(runId));
    if (!got.track) throw got.error;
    await showSubtitle(got, runId);
  } catch (error) {
    throw isStaleRunError(error) ? new Error(VIDEO_SWITCHED) : error;
  }
  setStatus(`${state.subtitleWarning}字幕切换完成。`);
}

function onReadingSubtitleChange(event) {
  const option = event.target.options[event.target.selectedIndex];
  const url = String(option?.value || "");
  if (!url) return;
  return switchSubtitle(url)
    .then(() => {
      renderReadingView();
      syncReadingViewPlayback(true);
      setReadingNotice(state.subtitleWarning);
    })
    .catch((error) => {
      // The dropdown goes back to the track still shown.
      renderReadingSubtitleSelect();
      setReadingNotice(`字幕切换失败：${fetchErrorText(error)}`);
    });
}

function renderReadingSubtitleSelect() {
  renderSubtitleOptions(byId(ids.readingSubtitleSelect));
}

// Translated tracks already say 机器翻译 in their label.
function subtitleOptionLabel(item) {
  return `${item.label || item.lang || "未命名字幕"}${{ ai: "（AI）", auto: "（自动）" }[item.kind] || ""}`;
}

function renderSubtitleOptions(select) {
  const subtitles = state.subtitles || [];

  if (subtitles.length === 0) {
    select.innerHTML = '<option value="">暂无字幕</option>';
    select.disabled = true;
    return;
  }

  select.innerHTML = subtitles
    .map((item) => {
      const selectedById =
        state.selectedSubtitleId && String(item.id) === String(state.selectedSubtitleId);
      const selectedByUrl = item.url === state.selectedSubtitleUrl;
      const selected = selectedById || selectedByUrl ? "selected" : "";
      const label = item.label || item.lang || "unknown";
      return `<option value="${escapeHtml(item.url)}" data-lang="${escapeHtml(
        label
      )}" data-id="${escapeHtml(String(item.id || ""))}" ${selected}>${escapeHtml(
        subtitleOptionLabel(item)
      )}</option>`;
    })
    .join("");
  select.disabled = false;
}

function getPopupPayload() {
  const subtitleOptions = (state.subtitles || []).map((item) => {
    const label = item.label || item.lang || "unknown";
    const selectedById =
      state.selectedSubtitleId && String(item.id) === String(state.selectedSubtitleId);
    const selectedByUrl = item.url === state.selectedSubtitleUrl;
    return {
      id: String(item.id || ""),
      url: item.url,
      lang: label,
      optionLabel: subtitleOptionLabel(item),
      selected: selectedById || selectedByUrl
    };
  });

  return {
    contentVersion: MDG_VERSION,
    site: currentSite()?.id || "",
    url: cleanVideoUrl(),
    title: state.title || "",
    author: state.author || "",
    uploadDate: state.uploadDate || "",
    cover: state.cover || "",
    duration: state.videoDuration || 0,
    tags: String(state.settings?.tags || ""),
    status: state.statusText || "",
    message: state.messageText || "",
    subtitlePreview: buildSubtitlePreview(state.subtitleBody || [], state.settings || DEFAULT_SETTINGS),
    markdown: state.markdown || "",
    // 下载 .md: the same name as the note 写入 Obsidian writes (MdgNote.buildNoteFilename).
    filename: MdgNote.buildNoteFilename(state, state.settings || DEFAULT_SETTINGS),
    srt: state.srt || "",
    txt: state.txt || "",
    subtitleOptions
  };
}

// The background (write-video-note) picks the path and writes; this page sends its note and draws the overwrite dialog.
// Resolves { ok: false, error, code } when the write failed, { written: false } when the existing note was left alone
// (取消, video switched), nothing otherwise.
async function sendToObsidian() {
  state.settings = await getSettings();
  if (!state.settings.obsidianEnabled) {
    return;
  }
  await refreshDerivedContent();
  if (!state.markdown) {
    setMessage("没有可写入的内容，请先点击「刷新」。");
    return;
  }

  // Taken before the overwrite dialog: autoplay or a link can change the video (and reset state) while it is open.
  const clip = computeCurrentClipSignature();
  const ref = { site: state.site, videoId: state.videoId, cid: state.cid, pageIndex: state.pageIndex, pageCount: state.pageCount, pageTitle: state.pageTitle, title: state.title, author: state.author, uploadDate: state.uploadDate, url: cleanVideoUrl() };
  const request = { type: "write-video-note", ref, page: { markdown: state.markdown, cover: state.cover } };
  // Answering the dialog closes the popup, so after it progress and results also show on the page.
  let onPage = false;
  const report = (text, ok) => {
    setMessage(text);
    if (onPage) setReadingNotice(text, { hideMs: ok ? 3000 : 0, error: !ok });
  };
  try {
    let resp = await sendRuntimeMessage(request);
    if (resp?.ok && resp.ask) {
      const mode = await confirmOverwriteNote(resp.path, { hasAiSection: resp.hasAiSection });
      if (!mode) {
        setMessage(MdgErrors.TEXT.obsidianCancelled);
        return { written: false };
      }
      onPage = true;
      if (computeCurrentClipSignature() !== clip) {
        setMessage("视频已切换，未写入 Obsidian。");
        setReadingNotice("视频已切换，未写入 Obsidian。");
        return { written: false };
      }
      setReadingNotice("正在写入 Obsidian…", { busy: true });
      resp = await sendRuntimeMessage({ ...request, mode });
    }
    if (!resp?.ok) {
      throw MdgErrors.fromResp(resp, MdgErrors.TEXT.obsidianWriteFailed);
    }
    report(resp.text, true);
  } catch (error) {
    if (MdgErrors.reloaded(error)) {
      report(MdgErrors.TEXT.reloaded);
      return;
    }
    report(`写入 Obsidian 失败：${getErrorMessage(error)}`);
    // Not set up or a wrong key: the settings page. A closed Obsidian only gets the red line.
    if (error.action === "settings") requestOpenOptions();
    return { ok: false, error: getErrorMessage(error), code: error.cause?.code };
  }
}

let cancelOverwriteNote = null;

// Resolves "ai" (replace only the marked AI 问答 section), "full" (rewrite the note) or "" (cancel).
// 整篇覆盖 never sits next to the default button: a slip must not turn an update into a rewrite.
function confirmOverwriteNote(filepath, { hasAiSection = false } = {}) {
  // A second dialog answers the first with 取消, so its caller does not wait forever.
  cancelOverwriteNote?.();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "mdg-confirm-overlay";
    overlay.innerHTML = hasAiSection
      ? `
      <div class="mdg-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="mdgConfirmTitle">
        <div id="mdgConfirmTitle" class="mdg-confirm-title">该笔记已存在</div>
        <div class="mdg-confirm-body">只更新 AI 问答：保留原笔记，只替换标记之间的「AI 问答」。整篇覆盖：替换全部内容。</div>
        <div class="mdg-confirm-path"></div>
        <div class="mdg-confirm-actions">
          <button type="button" class="mdg-confirm-danger" data-choice="full">整篇覆盖</button>
          <button type="button" class="mdg-confirm-cancel" data-choice="">取消</button>
          <button type="button" class="mdg-confirm-primary" data-choice="ai">只更新 AI 问答</button>
        </div>
      </div>
    `
      : `
      <div class="mdg-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="mdgConfirmTitle">
        <div id="mdgConfirmTitle" class="mdg-confirm-title">该笔记已存在</div>
        <div class="mdg-confirm-body">没有 AI 问答可更新。整篇覆盖会替换全部内容：</div>
        <div class="mdg-confirm-path"></div>
        <div class="mdg-confirm-actions">
          <button type="button" class="mdg-confirm-danger" data-choice="full">整篇覆盖</button>
          <button type="button" class="mdg-confirm-cancel" data-choice="">取消</button>
        </div>
      </div>
    `;
    overlay.querySelector(".mdg-confirm-path").textContent = String(filepath || "");

    const cleanup = (value) => {
      cancelOverwriteNote = null;
      overlay.remove();
      document.removeEventListener("keydown", onKeydown, true);
      resolve(value);
    };
    const onKeydown = (event) => {
      if (MdgTyping.composing(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup("");
      }
    };

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        cleanup("");
      }
    });
    overlay.querySelectorAll("[data-choice]").forEach((button) => {
      button.addEventListener("click", () => cleanup(button.dataset.choice));
    });
    cancelOverwriteNote = () => cleanup("");
    document.addEventListener("keydown", onKeydown, true);
    document.body.appendChild(overlay);
    (overlay.querySelector(".mdg-confirm-primary") || overlay.querySelector(".mdg-confirm-cancel")).focus();
  });
}

function setStatus(text) {
  state.statusText = String(text || "");
}

function setMessage(text) {
  state.messageText = String(text || "");
}

// failure: why the subtitle fetch failed; needLogin: B站 hid them from a logged-out viewer; neither: there are none.
async function showNoSubtitleState(runId, { failure = "", needLogin = false } = {}) {
  state.subtitleFailure = failure;
  state.subtitleNeedLogin = needLogin;
  const label = MdgErrors.subtitleMissing(state);
  const hint = needLogin ? `${MdgErrors.TEXT.subtitleLoginHint}。` : "";
  state.selectedSubtitleId = "";
  state.selectedSubtitleUrl = "";
  state.selectedSubtitleLang = "";
  state.subtitleBody = [];
  state.subtitleFetchState = "empty";
  state.hotComments = [];
  if (state.readingViewOpen) {
    moveReadingMainInline();
    renderReadingView();
    startReaderPlayerObserver();
    syncReadingViewPlayback(true);
  }
  setStatus(`${label}，正在读取评论…`);
  await refreshDerivedContent();
  ensureRunActive(runId);
  setStatus(`${label}，可导出简介与评论。${hint}`);
}

function cleanupReaderFloatingArtifacts(playerHost = state.readingPlayerHost) {
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  }
  dismissReaderMiniPlayer(playerHost);
  const runtimeHost = findReaderPlayerHost(getRuntimeVideoElement());
  if (runtimeHost && runtimeHost !== playerHost) {
    dismissReaderMiniPlayer(runtimeHost);
  }
}

async function enterReaderMode() {
  if (!stepReader("enter")) {
    return;
  }
  const gen = state.readerGen;
  const readingView = byId(ids.readingView);
  state.readingPlayerRetries = 0;
  document.body.setAttribute("data-mdg-reading-active", "1");
  hydrateReaderStateFromSettings(state.settings);
  applyReadingViewPresentation();
  alignReaderViewportToPlayer();
  await sleep(0);
  if (gen !== state.readerGen) {
    return;
  }
  openReaderViewShell(readingView);
  applyReaderPageFocus();
  startReaderPlayerObserver();
  renderReadingView();

  const earlyPlayerHost = findReaderPlayerHost(getRuntimeVideoElement());
  if (earlyPlayerHost) {
    earlyPlayerHost.setAttribute("data-mdg-reader-fading", "1");
  }

  await sleep(0);
  if (gen !== state.readerGen) {
    return;
  }

  // The view stays hidden until the player is in, so say so unless that is instant.
  const waitNotice = window.setTimeout(() => state.readingViewOpen && setReadingNotice("正在等待视频播放器就绪…", { busy: true }), 150);
  const mounted = await ensureReaderPlayerMounted({ retries: 50, delayMs: 150, forceLayout: true });
  window.clearTimeout(waitNotice);
  const mountedPlayerHost = state.readingPlayerHost || earlyPlayerHost;
  if (mountedPlayerHost) {
    mountedPlayerHost.removeAttribute("data-mdg-reader-fading");
  }
  if (gen !== state.readerGen) {
    return;
  }
  if (!mounted) {
    // Don't throw - keep UI open and keep retrying in background
    setReadingNotice("正在等待视频播放器就绪…", { busy: true });
    scheduleReaderPlayerRetry();
    return;
  }

  finishEnterReaderMode();
}

function scheduleReaderPlayerRetry() {
  if (state.readingPlayerRetryTimer) {
    window.clearTimeout(state.readingPlayerRetryTimer);
    state.readingPlayerRetryTimer = 0;
  }
  // Keep trying to mount player in background, for about 30 seconds.
  const gen = state.readerGen;
  const tryMount = async () => {
    state.readingPlayerRetryTimer = 0;
    if (gen !== state.readerGen || !state.readingViewOpen) return;
    state.readingPlayerRetries += 1;
    if (state.readingPlayerRetries > 12) {
      replaceReaderModeUrl(stripReaderModeUrl(location.href));
      closeReadingView();
      setReadingNotice("视频播放器长时间未就绪，已退出专注模式，请刷新网页重试");
      return;
    }
    const mounted = await ensureReaderPlayerMounted({ retries: 10, delayMs: 200, forceLayout: true });
    const retryHost = state.readingPlayerHost;
    if (retryHost) {
      retryHost.removeAttribute("data-mdg-reader-fading");
    }
    if (gen !== state.readerGen) return;
    if (mounted) {
      finishEnterReaderMode();
    } else if (state.readingViewOpen) {
      state.readingPlayerRetryTimer = window.setTimeout(tryMount, 500);
    }
  };
  state.readingPlayerRetryTimer = window.setTimeout(tryMount, 500);
}

function finishEnterReaderMode() {
  if (!state.readingViewOpen || !isReaderMode()) return;

  alignReaderViewportToPlayer();
  moveReadingMainInline();
  scheduleReaderMiniPlayerDismiss();
  maybeRefreshReaderSubtitleInBackground();
  syncReaderModeAfterMount();
  settleReaderModePresentation();
  bindReaderHeaderActionsHover();
}

function openReaderViewShell(readingView = byId(ids.readingView)) {
  if (!readingView) {
    return;
  }
  readingView.classList.add("open", "reader-page");
  readingView.setAttribute("aria-hidden", "false");
  setReadingViewReady(false);
  setReadingNotice("");
}

function maybeRefreshReaderSubtitleInBackground() {
  if (state.subtitleBody.length) {
    return;
  }
  const runId = state.fetchRunId;
  waitForVideoMetadata().then(() => {
    if (runId !== state.fetchRunId) {
      return;
    }
    // Joins a read in flight or reads a video not read yet; a video already read without subtitles is not reread.
    settledClip(false).catch((error) => setReadingNotice(`字幕加载失败：${fetchErrorText(error)}`));
  });
}

function waitForVideoMetadata(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const video = getRuntimeVideoElement();
      const duration = Number(video?.duration);
      const ready = video && Number.isFinite(duration) && duration > 0;
      if (ready || Date.now() - start >= timeoutMs) {
        resolve();
        return;
      }
      window.setTimeout(check, 150);
    };
    check();
  });
}

function syncReaderModeAfterMount() {
  startReaderPlayerObserver();
  layoutReaderPlayerHost();
  syncReadingViewPlayback(true);
  updateReaderFollowState();
}

function settleReaderModePresentation() {
  if (!isReaderPresentationStable()) {
    setReadingViewReady(false);
    setReadingNotice("正在等待视频播放器就绪…", { busy: true });
    scheduleReaderPlayerRetry();
    return false;
  }
  setReadingViewReady(true);
  state.readingPlayerRetries = 0;
  setReadingNotice("");
  return true;
}

async function ensureReaderPlayerMounted({ retries = 1, delayMs = 100, forceLayout = false } = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    // Exiting mid-loop must not leave the page's player stripped of controls and picture-in-picture.
    if (!isReaderMode()) {
      return false;
    }
    const video = getRuntimeVideoElement();
    const playerHost = findReaderPlayerHost(video);
    if (video && playerHost) {
      const previousHost = state.readingPlayerHost;
      const previousVideo = state.readingVideoEl;
      video.controls = false;
      video.removeAttribute("controls");
      video.disablePictureInPicture = true;
      video.setAttribute("disablepictureinpicture", "");
      video.removeAttribute("autopictureinpicture");
      state.readingPlayerHost = playerHost;
      const miniPlayerClosed = dismissReaderMiniPlayer(playerHost);
      if (miniPlayerClosed) {
        await sleep(120);
      }
      const activeHost = findReaderPlayerHost(video) || playerHost;
      state.readingPlayerHost = activeHost;
      // YouTube moves #movie_player from the skeleton #player into
      // ytd-watch-flexy after load, into a branch the page focus hid; the
      // transcript host follows the player into its new wrap.
      if (isReaderMode()) {
        if (video.closest("[data-mdg-reader-hidden='1']")) {
          applyReaderPageFocus();
        }
        moveReadingMainInline();
      }
      normalizeReaderPlayerContainer(activeHost);
      if (state.readingViewOpen) {
        clearNativeReaderFloatingStyles(activeHost);
        if (hasNativeReaderPlayerLayoutIssue(activeHost)) {
          normalizeReaderPlayerContainer(activeHost);
          clearNativeReaderFloatingStyles(activeHost);
        }
      }
      if (previousHost && previousHost !== activeHost) {
        setReaderPlayerControlsVisible(false, previousHost);
        cleanupReaderPlayerHostNode(previousHost);
      }
      if (previousVideo !== video) {
        state.readingVideoEventsBound = false;
      }
      activeHost.classList.add("mdg-reader-player-host");
      bindReadingViewVideo(video);
      bindReaderPlayerControlsHover(activeHost);
      bindReaderLayout();
      if (
        forceLayout ||
        previousHost !== activeHost ||
        attempt > 0 ||
        miniPlayerClosed ||
        hasNativeReaderPlayerLayoutIssue(activeHost)
      ) {
        layoutReaderPlayerHost();
        if (hasNativeReaderPlayerLayoutIssue(activeHost)) {
          normalizeReaderPlayerContainer(activeHost);
          clearNativeReaderFloatingStyles(activeHost);
          layoutReaderPlayerHost();
        }
      }
      if (state.readingViewOpen && !isWatchlaterPage()) {
        await ensureReaderPlayerControlsRecovered(activeHost, {
          reason: attempt > 0 ? "mount-retry" : "mount"
        });
        queueEnsureReaderPlayerControlsRecovered({
          reason: attempt > 0 ? "post-mount-retry" : "post-mount",
          delayMs: 220,
          minIntervalMs: 240
        });
      }
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
      }
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

function queueEnsureReaderPlayerMounted() {
  if (!state.readingViewOpen || !isReaderMode() || state.readingPlayerMountTimer) {
    return;
  }
  state.readingPlayerMountTimer = window.setTimeout(() => {
    state.readingPlayerMountTimer = 0;
    ensureReaderPlayerMounted({ retries: 12, delayMs: 120, forceLayout: true }).catch((error) => {
      logWarn("[MDG] ensure reader player mounted failed", error);
    });
  }, 60);
}

function findReaderPlayerHost(video) {
  if (!video) {
    return null;
  }

  return closestIn(video, reader().playerHost) || video.parentElement;
}

function closeReadingView() {
  cleanupReaderFloatingArtifacts();
  stepReader("close");
  setReadingNotice("");
  state.readingSettingsExpanded = false;
  state.readingManualScrollPauseUntil = 0;
  state.readingProgrammaticScrollUntil = 0;
  state.readingNextScrollBehavior = "smooth";
  if (state.readingPlayerRetryTimer) {
    window.clearTimeout(state.readingPlayerRetryTimer);
    state.readingPlayerRetryTimer = 0;
  }
  const readingView = byId(ids.readingView);
  readingView.classList.remove("open", "reader-page");
  readingView.setAttribute("aria-hidden", "true");
  readingView.setAttribute("data-mdg-reader-ready", "0");
  readingView.removeAttribute("data-mdg-reader-follow");
  document.body.removeAttribute("data-mdg-reading-active");
  document.documentElement.removeAttribute("data-mdg-reader-mode");
  document.body.removeAttribute("data-mdg-reader-mode");
  document.documentElement.removeAttribute("data-mdg-reader-theme");
  document.documentElement.removeAttribute("data-mdg-reader-font-scale");
  document.documentElement.removeAttribute("data-mdg-reader-letter-spacing");
  document.documentElement.removeAttribute("data-mdg-reader-line-height");
  document.documentElement.removeAttribute("data-mdg-reader-content-width");
  document.documentElement.removeAttribute("data-mdg-reader-chapter-visibility");
  document.documentElement.removeAttribute("data-mdg-reader-has-chapters");
  document.body.removeAttribute("data-mdg-reader-theme");
  document.body.removeAttribute("data-mdg-reader-font-scale");
  document.body.removeAttribute("data-mdg-reader-letter-spacing");
  document.body.removeAttribute("data-mdg-reader-line-height");
  document.body.removeAttribute("data-mdg-reader-content-width");
  document.body.removeAttribute("data-mdg-reader-chapter-visibility");
  document.body.removeAttribute("data-mdg-reader-has-chapters");
  restoreReadingMainInline();
  stopReadingViewSync();
  unbindReaderLayout();
  cleanupReaderPlayerHost();
  clearReaderPageFocus();
  // Mounting turned picture-in-picture off on the page's own video.
  const video = getRuntimeVideoElement();
  if (video) {
    video.disablePictureInPicture = false;
    video.removeAttribute("disablepictureinpicture");
  }
  const sendingBar = reader().sendingBar ? document.querySelector(reader().sendingBar) : null;
  if (sendingBar) {
    sendingBar.style.setProperty("display", "none", "important");
    window.setTimeout(() => {
      sendingBar.style.removeProperty("display");
    }, 200);
  }
  window.setTimeout(() => cleanupReaderFloatingArtifacts(), 40);
  window.setTimeout(() => cleanupReaderFloatingArtifacts(), 220);
}

function renderReadingView() {
  const titleNode = document.querySelector(".mdg-reading-title");
  const metaNode = byId(ids.readingMeta);
  const chapterList = byId(ids.readingChapterList);
  const transcriptList = byId(ids.readingTranscriptList);
  const chapters = MdgSites.normalizeChapters(state.chapters || []);
  const body = Array.isArray(state.subtitleBody) ? state.subtitleBody : [];
  const transcriptItems = getReadingTranscriptItems();
  const withHours = shouldShowHoursInNote(state, body);
  const hasChapters = chapters.length > 0;

  if (titleNode) {
    titleNode.textContent = state.title || "专注模式";
  }
  if (metaNode) {
    metaNode.textContent = buildReadingMetaLine();
  }

  if (chapters.length === 0) {
    chapterList.innerHTML = '<div class="mdg-reading-empty">当前视频没有章节。</div>';
  } else {
    chapterList.innerHTML = chapters
      .map(
        (item, index) => `
          <button
            type="button"
            class="mdg-reading-chapter"
            data-index="${index}"
            data-seconds="${Number(item.from || 0) || 0}"
          >
            <span class="mdg-reading-chapter-time">${escapeHtml(
              formatCompactTimestamp(item.from, withHours)
            )}</span>
            <span class="mdg-reading-chapter-title">${escapeHtml(item.title)}</span>
          </button>
        `
      )
      .join("");
  }

  if (transcriptItems.length === 0) {
    const failed = state.subtitleFetchState === "error" || Boolean(state.subtitleFailure) || state.subtitleNeedLogin;
    transcriptList.innerHTML = `<div class="mdg-reading-empty">${escapeHtml(getReadingTranscriptPlaceholderText())}${
      failed ? '<button type="button" class="mdg-reading-retry">重试</button>' : ""
    }</div>`;
  } else {
    transcriptList.innerHTML = transcriptItems
      .map(
        (item) => `
          <button
            type="button"
            class="mdg-reading-item"
            data-index="${item.index}"
            data-seconds="${item.from}"
          >
            <span class="mdg-reading-time">${escapeHtml(
              formatCompactTimestamp(item.from, withHours)
            )}</span>
            <span class="mdg-reading-text">${escapeHtml(item.content)}</span>
          </button>
        `
      )
      .join("");
    transcriptList.insertAdjacentHTML(
      "beforeend",
      `<div id="${ids.readingTranscriptTailSpacer}" class="mdg-reading-tail-spacer" aria-hidden="true"></div>`
    );
  }

  updateReaderChapterPresence(hasChapters);
  renderReadingInfoPanel();
  renderReadingSubtitleSelect();
  renderReaderPanels();
  applyReadingViewPresentation();
  updateReadingTranscriptTailSpacer();
  state.readingActiveSubtitleIndex = -1;
  state.readingActiveChapterIndex = -1;
}

function getReadingTranscriptPlaceholderText() {
  // idle: the video just changed and its fetch has not started yet.
  if (state.subtitleFetchState === "loading" || state.subtitleFetchState === "idle") {
    return "正在加载字幕…";
  }
  if (state.subtitleFetchState === "error") {
    return "字幕加载失败。";
  }
  return `${MdgErrors.subtitleMissing(state)}。${state.subtitleNeedLogin ? `${MdgErrors.TEXT.subtitleLoginHint}。` : ""}`;
}

function getReadingTranscriptItems(body = state.subtitleBody) {
  return (Array.isArray(body) ? body : [])
    .map((item, index) => ({
      index,
      from: Number(item?.from || 0) || 0,
      content: String(item?.content || "").trim()
    }))
    .filter((item) => item.content);
}

function updateReadingTranscriptTailSpacer() {
  const spacer = document.getElementById(ids.readingTranscriptTailSpacer);
  if (!spacer) {
    return;
  }
  const inlineHost = document.getElementById("mdg-reading-inline-host");
  const transcriptList = document.getElementById(ids.readingTranscriptList);
  const hostHeight = inlineHost?.clientHeight || transcriptList?.clientHeight || 0;
  const spacerHeight = Math.max(hostHeight, Math.round(window.innerHeight * 0.92), 320);
  spacer.style.height = `${spacerHeight}px`;
}

function hydrateReaderStateFromSettings(settings = state.settings) {
  state.readingTheme = MdgSettings.normalizeReaderTheme(settings?.readerTheme);
  state.readingFontScale = MdgSettings.normalizeReaderFontScale(settings?.readerFontScale);
  state.readingLetterSpacing = MdgSettings.normalizeReaderLetterSpacing(settings?.readerLetterSpacing ?? settings?.readerLineHeight);
  state.readingLineHeight = MdgSettings.normalizeReaderLineHeight(settings?.readerLineHeight);
  state.readingContentWidth = MdgSettings.normalizeReaderContentWidth(settings?.readerContentWidth);
  state.readingChapterVisible = settings?.readerChapterVisible !== undefined ? Boolean(settings.readerChapterVisible) : true;
}

function applyReadingViewPresentation() {
  const readingView = byId(ids.readingView);
  readingView.dataset.theme = state.readingTheme;
  readingView.dataset.fontScale = state.readingFontScale;
  readingView.dataset.letterSpacing = state.readingLetterSpacing;
  readingView.dataset.lineHeight = state.readingLineHeight;
  readingView.dataset.contentWidth = state.readingContentWidth;
  readingView.dataset.chapterVisibility = state.readingChapterVisible ? "auto" : "hide";
  document.documentElement.dataset.mdgReaderTheme = state.readingTheme;
  document.documentElement.dataset.mdgReaderFontScale = state.readingFontScale;
  document.documentElement.dataset.mdgReaderLetterSpacing = state.readingLetterSpacing;
  document.documentElement.dataset.mdgReaderLineHeight = state.readingLineHeight;
  document.documentElement.dataset.mdgReaderContentWidth = state.readingContentWidth;
  document.documentElement.dataset.mdgReaderChapterVisibility = state.readingChapterVisible ? "auto" : "hide";
  document.body.dataset.mdgReaderTheme = state.readingTheme;
  document.body.dataset.mdgReaderFontScale = state.readingFontScale;
  document.body.dataset.mdgReaderLetterSpacing = state.readingLetterSpacing;
  document.body.dataset.mdgReaderLineHeight = state.readingLineHeight;
  document.body.dataset.mdgReaderContentWidth = state.readingContentWidth;
  document.body.dataset.mdgReaderChapterVisibility = state.readingChapterVisible ? "auto" : "hide";
  const readingChapterVisibleEl = byId(ids.readingChapterVisible);
  if (readingChapterVisibleEl) {
    readingChapterVisibleEl.checked = state.readingChapterVisible;
  }
}

function updateReaderChapterPresence(hasChapters) {
  const value = hasChapters ? "1" : "0";
  const readingView = byId(ids.readingView);
  readingView.dataset.hasChapters = value;
  document.documentElement.dataset.mdgReaderHasChapters = value;
  document.body.dataset.mdgReaderHasChapters = value;
}

function getToggleLabel(key, value) {
  const labels = {
    fontScale: { xs: "最小", s: "偏小", m: "标准", l: "偏大", xl: "最大" },
    letterSpacing: { tighter: "最紧", tight: "偏紧", normal: "标准", relaxed: "偏松", loose: "最松" },
    lineHeight: { compact: "最紧", tight: "偏紧", normal: "标准", relaxed: "偏松", loose: "最松" },
    contentWidth: { compact: "最窄", narrow: "偏窄", medium: "标准", wide: "偏宽", full: "最宽" }
  };
  return labels[key]?.[value] || "标准";
}

function getReaderStepperConfig(settingKey) {
  const configs = {
    readerFontScale: {
      options: ["xs", "s", "m", "l", "xl"],
      labelKey: "fontScale",
      getCurrent: () => state.readingFontScale,
      buildPayload: (value) => ({ readerFontScale: value })
    },
    readerLetterSpacing: {
      options: ["tighter", "tight", "normal", "relaxed", "loose"],
      labelKey: "letterSpacing",
      getCurrent: () => state.readingLetterSpacing,
      buildPayload: (value) => ({ readerLetterSpacing: value })
    },
    readerLineHeight: {
      options: ["compact", "tight", "normal", "relaxed", "loose"],
      labelKey: "lineHeight",
      getCurrent: () => state.readingLineHeight,
      buildPayload: (value) => ({ readerLineHeight: value })
    },
    readerContentWidth: {
      options: ["compact", "narrow", "medium", "wide", "full"],
      labelKey: "contentWidth",
      getCurrent: () => state.readingContentWidth,
      buildPayload: (value) => ({ readerContentWidth: value })
    }
  };
  return configs[settingKey] || null;
}

function buildReaderStepperControl({
  id,
  title,
  settingKey
}) {
  const config = getReaderStepperConfig(settingKey);
  if (!config) {
    return "";
  }
  return `
    <div id="${id}" class="mdg-reading-stepper">
      <span class="mdg-reading-stepper-title">${escapeHtml(title)}</span>
      <div class="mdg-reading-stepper-buttons" role="group" aria-label="${escapeHtml(title)}">
        ${config.options
          .map(
            (option, index) => `
          <button
            type="button"
            class="mdg-reading-stepper-btn"
            data-value="${escapeHtml(option)}"
            aria-label="${escapeHtml(title)} ${escapeHtml(getToggleLabel(config.labelKey, option))}"
            title="${escapeHtml(getToggleLabel(config.labelKey, option))}"
          >${index + 1}</button>
        `
          )
          .join("")}
      </div>
    </div>
  `;
}

function bindReaderStepperControl(node, settingKey) {
  if (!node || node.dataset.mdgBound === "1") {
    return;
  }

  node.addEventListener("click", (event) => {
    const button = event.target.closest("[data-value]");
    if (!button) {
      return;
    }
    setReaderPreference(settingKey, button.dataset.value || "");
  });
  node.dataset.mdgBound = "1";
}

function setReaderPreference(settingKey, nextValue) {
  const config = getReaderStepperConfig(settingKey);
  if (!config) {
    return;
  }

  const current = config.getCurrent();
  if (!config.options.includes(nextValue) || nextValue === current) {
    return;
  }
  updateReaderPreferences(config.buildPayload(nextValue), { persist: true });
}

function renderReaderStepperState(node, settingKey) {
  const config = getReaderStepperConfig(settingKey);
  if (!node || !config) {
    return;
  }

  const current = config.getCurrent();
  node.querySelectorAll("[data-value]").forEach((button) => {
    const isActive = button.dataset.value === current;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function renderReaderPanels() {
  const settingsPanel = byId(ids.readingSettingsPanel);
  const settingsBtn = byId(ids.readingSettingsBtn);
  settingsPanel.hidden = !state.readingSettingsExpanded;
  settingsBtn.classList.toggle("is-active", state.readingSettingsExpanded);
  settingsBtn.setAttribute("aria-expanded", String(state.readingSettingsExpanded));
  byId(ids.readingAutoScroll).checked = state.readingAutoScroll;
  renderReaderStepperState(byId(ids.readingFontScaleSelect), "readerFontScale");
  renderReaderStepperState(byId(ids.readingLetterSpacingSelect), "readerLetterSpacing");
  renderReaderStepperState(byId(ids.readingLineHeightSelect), "readerLineHeight");
  renderReaderStepperState(byId(ids.readingContentWidthSelect), "readerContentWidth");
}

function renderReadingInfoPanel() {
  const summaryNode = byId(ids.readingInfoSummary);
  const descriptionNode = byId(ids.readingInfoDescription);
  const descriptionBtn = byId(ids.readingDescriptionBtn);
  const summaryItems = buildReadingSummaryItems();
  const description = String(state.description || "").trim();

  summaryNode.innerHTML =
    summaryItems.length === 0
      ? '<div class="mdg-reading-empty">当前视频信息还未就绪。</div>'
      : summaryItems
          .map(
            (item) => `
              <div class="mdg-reading-info-item">
                <span class="mdg-reading-info-label">${escapeHtml(item.label)}</span>
                <span class="mdg-reading-info-value">${escapeHtml(item.value)}</span>
              </div>
            `
          )
          .join("");

  if (!description) {
    descriptionNode.innerHTML = '<div class="mdg-reading-empty">当前视频没有简介。</div>';
    descriptionNode.classList.remove("is-collapsed");
    descriptionBtn.hidden = true;
  } else {
    descriptionNode.textContent = description;
    const fullScrollHeight = descriptionNode.scrollHeight;
    descriptionNode.classList.add("is-collapsed");
    const clampedClientHeight = descriptionNode.clientHeight;
    descriptionNode.classList.toggle("is-collapsed", !state.readingDescriptionExpanded);
    const hasOverflow = fullScrollHeight > clampedClientHeight + 2;
    if (!hasOverflow) {
      descriptionNode.classList.remove("is-collapsed");
      descriptionBtn.hidden = true;
      return;
    }
    descriptionBtn.hidden = false;
    descriptionBtn.textContent = state.readingDescriptionExpanded ? "收起简介" : "展开简介";
  }
}

function buildReadingSummaryItems() {
  const items = [];
  if (state.title) {
    items.push({ label: "标题", value: state.title });
  }
  if (state.author) {
    items.push({ label: "作者", value: state.author });
  }
  if (state.uploadDate) {
    items.push({ label: "日期", value: state.uploadDate });
  }
  if (Number(state.pageCount) > 1) {
    const pageParts = [`P${Number(state.pageIndex) > 0 ? Number(state.pageIndex) : 1}`];
    if (state.pageTitle) {
      pageParts.push(state.pageTitle);
    }
    items.push({ label: "分P", value: pageParts.join(" ") });
  }
  return items;
}

function updateReaderPreferences(next, { persist = true } = {}) {
  state.readingTheme = MdgSettings.normalizeReaderTheme(next.readerTheme ?? state.readingTheme);
  state.readingFontScale = MdgSettings.normalizeReaderFontScale(next.readerFontScale ?? state.readingFontScale);
  state.readingLetterSpacing = MdgSettings.normalizeReaderLetterSpacing(
    next.readerLetterSpacing ?? state.readingLetterSpacing
  );
  state.readingLineHeight = MdgSettings.normalizeReaderLineHeight(next.readerLineHeight ?? state.readingLineHeight);
  state.readingContentWidth = MdgSettings.normalizeReaderContentWidth(next.readerContentWidth ?? state.readingContentWidth);
  state.readingChapterVisible = next.readerChapterVisible !== undefined ? Boolean(next.readerChapterVisible) : state.readingChapterVisible;
  state.settings = {
    ...state.settings,
    readerTheme: state.readingTheme,
    readerFontScale: state.readingFontScale,
    readerLetterSpacing: state.readingLetterSpacing,
    readerLineHeight: state.readingLineHeight,
    readerContentWidth: state.readingContentWidth,
    readerChapterVisible: state.readingChapterVisible
  };
  applyReadingViewPresentation();
  renderReaderPanels();
  if (persist) {
    persistReaderSettings();
  }
}

// Only the reader keys: state.settings is stale for everything else, and save-settings keeps the keys it is not sent.
function persistReaderSettings() {
  const { readerTheme, readerFontScale, readerLetterSpacing, readerLineHeight, readerContentWidth, readerChapterVisible } = state.settings;
  const settings = { readerTheme, readerFontScale, readerLetterSpacing, readerLineHeight, readerContentWidth, readerChapterVisible };
  sendRuntimeMessage({ type: "save-settings", settings }).catch((error) => {
    logWarn("[MDG] failed to persist reader settings", error);
  });
}

function buildReadingMetaLine() {
  const parts = [];
  if (state.author) {
    parts.push(state.author);
  }
  if (state.uploadDate) {
    parts.push(state.uploadDate);
  }
  parts.push(currentSite()?.domain || "");
  if (Number(state.pageCount) > 1) {
    const pageParts = [`P${Number(state.pageIndex) > 0 ? Number(state.pageIndex) : 1}`];
    if (state.pageTitle) {
      pageParts.push(state.pageTitle);
    }
    parts.push(pageParts.join(" "));
  }
  if (state.selectedSubtitleLang) {
    parts.push(`字幕：${state.selectedSubtitleLang}`);
  }
  return parts.join(" · ");
}

// Errors and waits only; an empty text hides the notice. It sits outside the
// reading view, which stays invisible until the player is ready.
// busy: a 正在… notice (gray, spinner); hideMs: a result that clears itself; error: one the user must handle (red).
function setReadingNotice(text, { busy = false, hideMs = 0, error = false } = {}) {
  const notice = byId(ids.readingStatus);
  window.clearTimeout(state.readingNoticeTimer);
  notice.textContent = text;
  notice.hidden = !text;
  notice.setAttribute("aria-busy", String(busy));
  notice.toggleAttribute("data-error", error);
  if (hideMs) state.readingNoticeTimer = window.setTimeout(() => setReadingNotice(""), hideMs);
}

function setReadingViewReady(ready) {
  stepReader(ready ? "ready" : "unready");
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  readingView.setAttribute("data-mdg-reader-ready", state.readingViewReady ? "1" : "0");
  readingView.setAttribute("aria-busy", state.readingViewReady ? "false" : "true");
}

function isReaderPresentationStable(playerHost = state.readingPlayerHost) {
  if (!state.readingViewOpen || !playerHost?.isConnected) {
    return false;
  }
  const rect = playerHost.getBoundingClientRect();
  if (!(rect.width > 240) || !(rect.height > 120)) {
    return false;
  }
  return !hasNativeReaderPlayerLayoutIssue(playerHost);
}

function bindReaderLayout() {
  if (state.readingLayoutBound) {
    return;
  }
  window.addEventListener("resize", layoutReaderPlayerHost);
  window.addEventListener("scroll", layoutReaderPlayerHost, { passive: true });
  document.addEventListener("fullscreenchange", layoutReaderPlayerHost);
  document.addEventListener("webkitfullscreenchange", layoutReaderPlayerHost);
  state.readingLayoutBound = true;
}

function unbindReaderLayout() {
  if (!state.readingLayoutBound) {
    return;
  }
  window.removeEventListener("resize", layoutReaderPlayerHost);
  window.removeEventListener("scroll", layoutReaderPlayerHost);
  document.removeEventListener("fullscreenchange", layoutReaderPlayerHost);
  document.removeEventListener("webkitfullscreenchange", layoutReaderPlayerHost);
  state.readingLayoutBound = false;
}

function layoutReaderPlayerHost() {
  if (!state.readingViewOpen || !isReaderMode()) {
    return;
  }

  const playerHost = state.readingPlayerHost;
  if (!playerHost) {
    return;
  }

  const rect = playerHost.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) {
    return;
  }

  // Size from the space available, not from the player's current box: that box already
  // follows these numbers, so measuring it would only ever shrink the player.
  // Never narrower than 16:9: a vertical video keeps black bars instead of a box too
  // narrow for the player's control bar.
  const video = state.readingVideoEl;
  const aspectRatio = Math.max(
    16 / 9,
    Number(video?.videoWidth) > 0 && Number(video?.videoHeight) > 0
      ? Number(video.videoWidth) / Number(video.videoHeight)
      : 0
  );
  // The player box has a 1px border on each side; size the inside to the video so no
  // sliver of black shows at the edges.
  const border = 2;
  let renderedWidth = Math.floor(getReaderMainWidthLimit());
  let renderedHeight = Math.ceil((renderedWidth - border) / aspectRatio) + border;
  // Keep the whole video and the chapter strip under it on screen.
  const wrapNode = getReaderPlayerWrapNode(playerHost);
  if (wrapNode) {
    const wrapTop = wrapNode.getBoundingClientRect().top + window.scrollY;
    const rail = document.querySelector(".mdg-reading-rail");
    const railSpace = rail?.offsetHeight ? rail.offsetHeight + 12 : 0;
    const heightLimit = Math.max(200, window.innerHeight - wrapTop - railSpace - getReaderPagePaddingPx());
    if (renderedHeight > heightLimit) {
      renderedWidth = Math.floor((heightLimit - border) * aspectRatio) + border;
      renderedHeight = heightLimit;
    }
  }

  clearNativeReaderFloatingStyles(playerHost);
  cleanupReaderPlayerHostNode(playerHost);
  // On <html>: the player and title these size are page nodes outside #mdg-reading-view.
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--mdg-reader-player-rendered-width", `${Math.round(renderedWidth)}px`);
  rootStyle.setProperty("--mdg-reader-player-rendered-height", `${Math.round(renderedHeight)}px`);
  updateReadingTranscriptTailSpacer();
  queueEnsureReaderPlayerControlsRecovered({
    reason: "layout-native",
    delayMs: 120
  });
}

function cleanupReaderPlayerHostNode(playerHost) {
  if (!playerHost) {
    return;
  }
  playerHost.classList.remove("mdg-reader-player-host");
  playerHost.style.removeProperty("position");
  playerHost.style.removeProperty("inset");
  playerHost.style.removeProperty("left");
  playerHost.style.removeProperty("top");
  playerHost.style.removeProperty("right");
  playerHost.style.removeProperty("bottom");
  playerHost.style.removeProperty("transform");
  playerHost.style.removeProperty("width");
  playerHost.style.removeProperty("height");
  playerHost.style.removeProperty("margin");
  playerHost.style.removeProperty("z-index");
  playerHost.style.removeProperty("max-width");
  playerHost.style.removeProperty("max-height");
}

function cleanupReaderPlayerHost() {
  restoreReaderPlayerContainer();
  unbindReaderPlayerControlsHover();
  unbindReaderHeaderActionsHover();
  if (state.readingControlsRecoveryTimer) {
    window.clearTimeout(state.readingControlsRecoveryTimer);
    state.readingControlsRecoveryTimer = 0;
  }
  state.readingControlsRecoveryInFlight = false;
  document.documentElement.style.removeProperty("--mdg-reader-player-rendered-width");
  document.documentElement.style.removeProperty("--mdg-reader-player-rendered-height");
  const playerHost = state.readingPlayerHost;
  if (!playerHost) {
    return;
  }
  setReaderPlayerControlsVisible(false, playerHost);
  cleanupReaderPlayerHostNode(playerHost);
  state.readingPlayerHost = null;
}

function stopReadingViewSync() {
  if (state.readingMiniDismissTimer) {
    window.clearTimeout(state.readingMiniDismissTimer);
    state.readingMiniDismissTimer = 0;
  }
  if (state.readingControlsHideTimer) {
    window.clearTimeout(state.readingControlsHideTimer);
    state.readingControlsHideTimer = 0;
  }
  if (state.readingControlsRecoveryTimer) {
    window.clearTimeout(state.readingControlsRecoveryTimer);
    state.readingControlsRecoveryTimer = 0;
  }
  state.readingControlsRecoveryInFlight = false;
  if (state.readingPlayerMountTimer) {
    window.clearTimeout(state.readingPlayerMountTimer);
    state.readingPlayerMountTimer = 0;
  }
  if (state.readingPlayerRetryTimer) {
    window.clearTimeout(state.readingPlayerRetryTimer);
    state.readingPlayerRetryTimer = 0;
  }
  stopReaderPlayerObserver();
  unbindReaderPlayerControlsHover();
  if (state.readingVideoEl && state.readingVideoEl.__mdgReadingSyncHandler) {
    const video = state.readingVideoEl;
    video.removeEventListener("timeupdate", video.__mdgReadingSyncHandler);
    video.removeEventListener("seeked", video.__mdgReadingSyncHandler);
    video.removeEventListener("loadedmetadata", video.__mdgReadingSyncHandler);
    delete video.__mdgReadingSyncHandler;
  }
  state.readingVideoEventsBound = false;
}

function startReaderPlayerObserver() {
  if (!isReaderMode() || state.readingPlayerObserver || !document.body) {
    return;
  }
  // Throttled, not debounced: danmaku mutate the page nonstop and would starve a debounce.
  const observer = new MutationObserver(() => {
    if (state.readingPlayerObserverTimer) {
      return;
    }
    state.readingPlayerObserverTimer = window.setTimeout(() => {
      state.readingPlayerObserverTimer = 0;
      if (!state.readingViewOpen) {
        return;
      }
      const nextVideo = getRuntimeVideoElement();
      const nextHost = findReaderPlayerHost(nextVideo);
      if (
        nextVideo &&
        nextHost &&
        (nextVideo !== state.readingVideoEl ||
          nextHost !== state.readingPlayerHost ||
          nextVideo.closest("[data-mdg-reader-hidden='1']"))
      ) {
        queueEnsureReaderPlayerMounted();
      }
      if (document.querySelector(sel(reader().miniPlayer))) {
        scheduleReaderMiniPlayerDismiss();
      }
    }, 150);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  state.readingPlayerObserver = observer;
}

function stopReaderPlayerObserver() {
  if (state.readingPlayerObserver) {
    state.readingPlayerObserver.disconnect();
    state.readingPlayerObserver = null;
  }
  window.clearTimeout(state.readingPlayerObserverTimer);
  state.readingPlayerObserverTimer = 0;
}

function bindReadingViewVideo(video = getRuntimeVideoElement()) {
  if (!video) {
    if (state.readingVideoEl && state.readingVideoEl.__mdgReadingSyncHandler) {
      const prev = state.readingVideoEl;
      prev.removeEventListener("timeupdate", prev.__mdgReadingSyncHandler);
      prev.removeEventListener("seeked", prev.__mdgReadingSyncHandler);
      prev.removeEventListener("loadedmetadata", prev.__mdgReadingSyncHandler);
      delete prev.__mdgReadingSyncHandler;
    }
    state.readingVideoEl = null;
    state.readingVideoEventsBound = false;
    return null;
  }

  if (state.readingVideoEl === video && state.readingVideoEventsBound) {
    return video;
  }

  if (state.readingVideoEl && state.readingVideoEl.__mdgReadingSyncHandler) {
    const prev = state.readingVideoEl;
    prev.removeEventListener("timeupdate", prev.__mdgReadingSyncHandler);
    prev.removeEventListener("seeked", prev.__mdgReadingSyncHandler);
    prev.removeEventListener("loadedmetadata", prev.__mdgReadingSyncHandler);
  }

  const syncHandler = (event) => {
    if (state.readingViewOpen) {
      if (event?.type === "loadedmetadata") {
        layoutReaderPlayerHost();
      }
      if (event?.type === "seeked") {
        state.readingNextScrollBehavior = "auto";
        queueEnsureReaderPlayerControlsRecovered({
          reason: "seeked",
          delayMs: 140,
          minIntervalMs: 320
        });
      }
      const latestHost = findReaderPlayerHost(video);
      if (latestHost && latestHost !== state.readingPlayerHost) {
        queueEnsureReaderPlayerMounted();
      }
      syncReadingViewPlayback();
    }
  };
  video.addEventListener("timeupdate", syncHandler);
  video.addEventListener("seeked", syncHandler);
  video.addEventListener("loadedmetadata", syncHandler);
  video.__mdgReadingSyncHandler = syncHandler;
  state.readingVideoEl = video;
  state.readingPlayerHost = findReaderPlayerHost(video) || state.readingPlayerHost;
  state.readingVideoEventsBound = true;
  return video;
}

function getRuntimeVideoElement() {
  if (state.readingVideoEl?.isConnected) {
    const currentHost = findReaderPlayerHost(state.readingVideoEl);
    const currentRect = state.readingVideoEl.getBoundingClientRect();
    if (
      currentHost?.isConnected &&
      currentRect.width > 120 &&
      currentRect.height > 68 &&
      !isIgnoredReaderVideoCandidate(state.readingVideoEl)
    ) {
      return state.readingVideoEl;
    }
  }

  const candidates = Array.from(document.querySelectorAll("video")).filter(
    (item) => item.isConnected && !isIgnoredReaderVideoCandidate(item)
  );
  if (candidates.length === 0) {
    return null;
  }

  const visible = candidates
    .map((item) => {
      const rect = item.getBoundingClientRect();
      const host = findReaderPlayerHost(item);
      const inPlayer = Boolean(
        host &&
          (host.matches?.(sel(reader().playerHost)) || host.querySelector?.(sel(reader().playerHost)))
      );
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const score =
        area +
        (inPlayer ? 1000000 : 0) +
        (!item.paused ? 20000 : 0) +
        Number(item.readyState || 0) * 2000 +
        (item.currentSrc ? 10000 : 0) +
        (item === state.readingVideoEl ? 500 : 0);
      return { item, rect, score };
    })
    .filter(({ rect }) => rect.width > 240 && rect.height > 120)
    .sort((a, b) => b.score - a.score)[0];

  return visible?.item || candidates[0] || null;
}

function isIgnoredReaderVideoCandidate(video) {
  if (!video) {
    return true;
  }
  const host = findReaderPlayerHost(video);
  const blockedSelector = sel([
    ...reader().miniPlayer,
    ...reader().endingPanel,
    "[class*='mini-player']",
    "[class*='picture-in-picture']",
    "[class*='adcard']",
    ...reader().ignoredVideo
  ]);
  return Boolean(video.closest(blockedSelector) || host?.closest?.(blockedSelector));
}

function applyReaderPageFocus() {
  clearReaderPageFocus();

  const root = byId(ids.root);
  const video = getRuntimeVideoElement();
  const playerHost = findReaderPlayerHost(video);
  const titleNode = findReaderTitleContainer();
  const keepRoots = [
    root,
    playerHost,
    titleNode,
    document.getElementById("mdg-reading-inline-host"),
    document.querySelector(".mdg-reading-rail")
  ].filter(Boolean);

  keepRoots.forEach((node) => {
    markReaderKeepSubtree(node);
    markReaderKeepPath(node);
  });

  const keepNodes = Array.from(document.querySelectorAll("[data-mdg-reader-keep='1']"));
  keepNodes.forEach((parent) => {
    Array.from(parent.children || []).forEach((child) => {
      if (child.id === ids.root) {
        return;
      }
      if (!child.hasAttribute("data-mdg-reader-keep")) {
        child.setAttribute("data-mdg-reader-hidden", "1");
      }
    });
  });

  pruneReaderNonKeepBranches(document.body);
  hideReaderNoiseNodes(keepRoots);
}

function clearReaderPageFocus() {
  document.querySelectorAll("[data-mdg-reader-keep]").forEach((node) => {
    node.removeAttribute("data-mdg-reader-keep");
  });
  document.querySelectorAll("[data-mdg-reader-hidden]").forEach((node) => {
    node.removeAttribute("data-mdg-reader-hidden");
  });
}

function moveReadingMainInline() {
  if (!isReaderMode()) {
    return;
  }

  const readingMain = document.querySelector(".mdg-reading-main");
  if (!readingMain) {
    return;
  }

  if (!state.readingMainOriginalParent) {
    state.readingMainOriginalParent = readingMain.parentElement;
    state.readingMainOriginalNextSibling = readingMain.nextSibling;
  }
  const playerWrap = getReaderPlayerWrapNode(state.readingPlayerHost) || state.readingPlayerHost;
  const hostParent = playerWrap?.parentElement;
  if (!playerWrap || !hostParent) {
    return;
  }

  let inlineHost = document.getElementById("mdg-reading-inline-host");
  if (!inlineHost) {
    inlineHost = document.createElement("div");
    inlineHost.id = "mdg-reading-inline-host";
  }

  // Chapters go right under the video, the transcript column after them.
  const rail = document.querySelector(".mdg-reading-rail");
  if (rail && (rail.parentElement !== hostParent || rail.previousElementSibling !== playerWrap)) {
    playerWrap.insertAdjacentElement("afterend", rail);
  }
  const hostAnchor = rail || playerWrap;
  if (inlineHost.parentElement !== hostParent || inlineHost.previousElementSibling !== hostAnchor) {
    hostAnchor.insertAdjacentElement("afterend", inlineHost);
  }

  if (!inlineHost.dataset.mdgScrollBound) {
    const handleInlineHostManualScroll = () => {
      if (Date.now() <= state.readingProgrammaticScrollUntil) {
        return;
      }
      noteManualReaderInteraction();
    };
    inlineHost.addEventListener("scroll", handleInlineHostManualScroll);
    inlineHost.addEventListener("wheel", handleInlineHostManualScroll, { passive: true });
    inlineHost.dataset.mdgScrollBound = "1";
  }

  if (readingMain.parentElement !== inlineHost) {
    inlineHost.appendChild(readingMain);
  }
  updateReadingTranscriptTailSpacer();
}

function restoreReadingMainInline() {
  const readingMain = document.querySelector(".mdg-reading-main");
  const inlineHost = document.getElementById("mdg-reading-inline-host");
  if (readingMain && state.readingMainOriginalParent) {
    if (state.readingMainOriginalNextSibling?.parentNode === state.readingMainOriginalParent) {
      state.readingMainOriginalParent.insertBefore(readingMain, state.readingMainOriginalNextSibling);
    } else {
      state.readingMainOriginalParent.appendChild(readingMain);
    }
  }
  const layout = document.querySelector(`#${ids.readingView} .mdg-reading-layout`);
  const rail = document.querySelector(".mdg-reading-rail");
  if (layout && rail && rail.parentElement !== layout) {
    layout.prepend(rail);
  }
  inlineHost?.remove();
  state.readingMainOriginalParent = null;
  state.readingMainOriginalNextSibling = null;
}

function pruneReaderNonKeepBranches(node) {
  if (!node?.children?.length) {
    return;
  }

  Array.from(node.children).forEach((child) => {
    if (child.id === ids.root) {
      return;
    }
    const childHasKeep = child.hasAttribute("data-mdg-reader-keep");
    const childContainsKeep = Boolean(child.querySelector?.("[data-mdg-reader-keep='1']"));
    if (!childHasKeep && !childContainsKeep) {
      child.setAttribute("data-mdg-reader-hidden", "1");
      return;
    }
    pruneReaderNonKeepBranches(child);
  });
}

function hideReaderNoiseNodes(keepRoots = []) {
  const keepSet = new Set(keepRoots.filter(Boolean));
  const keepSelector = sel([...reader().keepRoots, "#mdg-root"]);
  document.querySelectorAll(sel(reader().noise)).forEach((node) => {
    if (Array.from(keepSet).some((keepNode) => keepNode === node || node.contains(keepNode))) {
      return;
    }
    if (node.closest(keepSelector)) {
      return;
    }
    node.setAttribute("data-mdg-reader-hidden", "1");
    const card = node.closest(sel(reader().cards));
    if (card && !card.closest(keepSelector)) {
      card.setAttribute("data-mdg-reader-hidden", "1");
    }
  });
}

function markReaderKeepSubtree(node) {
  if (!node) {
    return;
  }
  node.setAttribute("data-mdg-reader-keep", "1");
  node.querySelectorAll("*").forEach((child) => {
    child.setAttribute("data-mdg-reader-keep", "1");
  });
}

function markReaderKeepPath(node) {
  let current = node;
  while (current && current !== document.body) {
    current.setAttribute("data-mdg-reader-keep", "1");
    current = current.parentElement;
  }
  document.body.setAttribute("data-mdg-reader-keep", "1");
}

function findReaderTitleContainer() {
  const title = queryFirst([...reader().title, "h1", "[data-title]"]);
  if (!title) {
    return null;
  }
  return title;
}

function dismissReaderMiniPlayer(playerHost = state.readingPlayerHost) {
  const explicitClose = Array.from(document.querySelectorAll(sel(reader().miniClose))).find(isVisibleReaderControl);
  if (explicitClose) {
    explicitClose.click();
    return true;
  }

  if (!playerHost) {
    return false;
  }

  const computed = window.getComputedStyle(playerHost);
  const fixedLike = computed.position === "fixed" || /mini|picture|float|fixed-player/i.test(playerHost.className || "");
  if (!fixedLike) {
    return false;
  }

  const roots = Array.from(
    new Set([
      playerHost,
      playerHost.parentElement,
      closestIn(playerHost, reader().playerWrap),
      closestIn(playerHost, reader().playerHost)
    ].filter(Boolean))
  );

  const selectors = [
    ...reader().miniClose,
    "[class*='mini'][class*='close']",
    "[class*='close']",
    "button[aria-label*='关闭']",
    "button[title*='关闭']",
    "[role='button'][aria-label*='关闭']",
    "[role='button'][title*='关闭']"
  ];

  for (const root of roots) {
    for (const selector of selectors) {
      const candidates = Array.from(root.querySelectorAll(selector)).filter(isVisibleReaderControl);
      const button = candidates.sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        return rectA.width * rectA.height - rectB.width * rectB.height;
      })[0];
      if (button) {
        button.click();
        return true;
      }
    }
  }

  const playerRect = playerHost.getBoundingClientRect();
  for (const root of roots) {
    const fallback = Array.from(root.querySelectorAll("button, [role='button'], [tabindex], div, span"))
      .filter((node) => {
        if (!isVisibleReaderControl(node)) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const nearTopRight =
          rect.width <= 48 &&
          rect.height <= 48 &&
          rect.left >= playerRect.right - 96 &&
          rect.top <= playerRect.top + 96;
        return nearTopRight && (style.cursor === "pointer" || node.hasAttribute("role") || node.hasAttribute("tabindex"));
      })
      .sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        return rectA.top + (playerRect.right - rectA.right) - (rectB.top + (playerRect.right - rectB.right));
      })[0];

    if (fallback) {
      fallback.click();
      return true;
    }
  }

  return false;
}

function scheduleReaderMiniPlayerDismiss(maxAttempts = 12, delayMs = 180) {
  if (!state.readingViewOpen) {
    return;
  }
  if (state.readingMiniDismissTimer) {
    window.clearTimeout(state.readingMiniDismissTimer);
    state.readingMiniDismissTimer = 0;
  }

  let attempts = 0;
  const run = () => {
    if (!state.readingViewOpen) {
      state.readingMiniDismissTimer = 0;
      return;
    }

    const closed = dismissReaderMiniPlayer();
    const host = findReaderPlayerHost(getRuntimeVideoElement());
    if (host) {
      state.readingPlayerHost = host;
      normalizeReaderPlayerContainer(host);
      layoutReaderPlayerHost();
    }

    attempts += 1;
    const miniExists = Boolean(document.querySelector(sel(reader().miniPlayer)));
    const hostFixed = Boolean(host && window.getComputedStyle(host).position === "fixed");
    if (attempts < maxAttempts && (miniExists || hostFixed || closed)) {
      state.readingMiniDismissTimer = window.setTimeout(run, delayMs);
      return;
    }
    state.readingMiniDismissTimer = 0;
  };

  state.readingMiniDismissTimer = window.setTimeout(run, 40);
}

function getReaderControlsRoot(playerHost = state.readingPlayerHost) {
  return (
    closestIn(playerHost, reader().playerWrap) ||
    closestIn(playerHost, reader().playerHost) ||
    playerHost ||
    queryFirst(reader().playerWrap) ||
    queryFirst(reader().playerHost)
  );
}

function getReaderPlayerControlsState(playerHost = state.readingPlayerHost) {
  const controlRoot = getReaderControlsRoot(playerHost);
  const nodes = reader().controls.map(
    (selector) => {
      const node = controlRoot?.querySelector(selector) || null;
      return {
        selector,
        exists: Boolean(node),
        visible: isVisibleReaderControl(node)
      };
    }
  );

  return {
    controlRootFound: Boolean(controlRoot),
    hostHasNoCursor: Boolean(reader().noCursorClass && playerHost?.classList.contains(reader().noCursorClass)),
    anyPresent: nodes.some((item) => item.exists),
    anyHidden: nodes.some((item) => item.exists && !item.visible),
    nodes
  };
}

function hasReaderPlayerControlsIssue(playerHost = state.readingPlayerHost) {
  if (!state.readingViewOpen || !playerHost || isWatchlaterPage()) {
    return false;
  }

  const snapshot = getReaderPlayerControlsState(playerHost);
  return snapshot.hostHasNoCursor || (snapshot.anyPresent && snapshot.anyHidden);
}

function queueEnsureReaderPlayerControlsRecovered({
  reason = "unknown",
  delayMs = 120,
  minIntervalMs = 480
} = {}) {
  if (!state.readingViewOpen || isWatchlaterPage()) {
    return;
  }
  const playerHost = state.readingPlayerHost;
  if (!playerHost?.isConnected || state.readingControlsRecoveryInFlight) {
    return;
  }

  const now = Date.now();
  if (state.readingControlsRecoveryTimer) {
    return;
  }
  if (now - state.readingControlsLastRecoverAt < minIntervalMs) {
    return;
  }

  state.readingControlsRecoveryTimer = window.setTimeout(() => {
    state.readingControlsRecoveryTimer = 0;
    if (!state.readingViewOpen || isWatchlaterPage()) {
      return;
    }
    const activeHost = state.readingPlayerHost;
    if (!activeHost?.isConnected || !hasReaderPlayerControlsIssue(activeHost)) {
      return;
    }

    state.readingControlsRecoveryInFlight = true;
    state.readingControlsLastRecoverAt = Date.now();
    ensureReaderPlayerControlsRecovered(activeHost, {
      reason,
      retryDelayMs: 120
    })
      .catch((error) => {
        logWarn("[MDG] queued reader controls recovery failed", { reason, error });
      })
      .finally(() => {
        state.readingControlsRecoveryInFlight = false;
      });
  }, delayMs);
}

function setReaderPlayerControlsVisible(visible, playerHost = state.readingPlayerHost) {
  if (!state.readingViewOpen || !playerHost) {
    return;
  }

  const controlRoot = getReaderControlsRoot(playerHost);
  if (!controlRoot) {
    return;
  }

  reader().controls.forEach((selector) => {
    const displayValue = "block";
    const node = controlRoot.querySelector(selector);
    if (!node) {
      return;
    }

    if (visible) {
      node.style.setProperty("display", displayValue, "important");
      node.setAttribute("data-mdg-reader-controls-forced", "1");
      return;
    }

    if (node.getAttribute("data-mdg-reader-controls-forced") === "1") {
      node.style.removeProperty("display");
      node.removeAttribute("data-mdg-reader-controls-forced");
    }
  });

  const noCursorClass = reader().noCursorClass;
  if (!noCursorClass) {
    return;
  }
  if (visible) {
    if (playerHost.classList.contains(noCursorClass)) {
      playerHost.classList.remove(noCursorClass);
      playerHost.setAttribute("data-mdg-reader-no-cursor-cleared", "1");
    }
    return;
  }

  if (playerHost.getAttribute("data-mdg-reader-no-cursor-cleared") === "1") {
    playerHost.classList.add(noCursorClass);
    playerHost.removeAttribute("data-mdg-reader-no-cursor-cleared");
  }
}

async function ensureReaderPlayerControlsRecovered(
  playerHost = state.readingPlayerHost,
  { reason = "unknown", retryDelayMs = 90 } = {}
) {
  if (!state.readingViewOpen || !playerHost || isWatchlaterPage()) {
    return false;
  }

  const before = getReaderPlayerControlsState(playerHost);
  logInfo("[MDG] reader controls check", {
    reason,
    hostClassName: typeof playerHost.className === "string" ? playerHost.className : "",
    hostHasNoCursor: before.hostHasNoCursor,
    controlRootFound: before.controlRootFound,
    controls: before.nodes
  });

  if (!hasReaderPlayerControlsIssue(playerHost)) {
    return false;
  }

  logInfo("[MDG] recovering normal reader controls", {
    reason,
    hostClassName: typeof playerHost.className === "string" ? playerHost.className : ""
  });
  setReaderPlayerControlsVisible(true, playerHost);
  layoutReaderPlayerHost();

  let after = getReaderPlayerControlsState(playerHost);
  logInfo("[MDG] reader controls after recovery", {
    reason,
    hostClassName: typeof playerHost.className === "string" ? playerHost.className : "",
    hostHasNoCursor: after.hostHasNoCursor,
    controls: after.nodes,
    retried: false
  });
  if (!hasReaderPlayerControlsIssue(playerHost)) {
    return true;
  }

  await sleep(retryDelayMs);
  logInfo("[MDG] retrying normal reader controls recovery", {
    reason,
    hostClassName: typeof playerHost.className === "string" ? playerHost.className : ""
  });
  setReaderPlayerControlsVisible(true, playerHost);
  layoutReaderPlayerHost();
  after = getReaderPlayerControlsState(playerHost);
  logInfo("[MDG] reader controls after retry", {
    reason,
    hostClassName: typeof playerHost.className === "string" ? playerHost.className : "",
    hostHasNoCursor: after.hostHasNoCursor,
    controls: after.nodes,
    retried: true
  });
  return !hasReaderPlayerControlsIssue(playerHost);
}

function scheduleReaderPlayerControlsHide(playerHost = state.readingControlsHoverHost || state.readingPlayerHost) {
  if (state.readingControlsHideTimer) {
    window.clearTimeout(state.readingControlsHideTimer);
  }
  state.readingControlsHideTimer = window.setTimeout(() => {
    state.readingControlsHideTimer = 0;
    if (!state.readingViewOpen) {
      return;
    }
    setReaderPlayerControlsVisible(false, playerHost);
  }, 1200);
}

function bindReaderPlayerControlsHover(playerHost = state.readingPlayerHost) {
  if (!state.readingViewOpen || !isWatchlaterPage() || !playerHost) {
    return;
  }

  if (state.readingControlsHoverHost && state.readingControlsHoverHost !== playerHost) {
    unbindReaderPlayerControlsHover();
  }
  if (playerHost.__mdgReaderControlsHoverBound) {
    state.readingControlsHoverHost = playerHost;
    return;
  }

  const showControls = () => {
    if (!state.readingViewOpen) {
      return;
    }
    setReaderPlayerControlsVisible(true, playerHost);
    scheduleReaderPlayerControlsHide(playerHost);
  };
  const hideControls = () => {
    if (state.readingControlsHideTimer) {
      window.clearTimeout(state.readingControlsHideTimer);
      state.readingControlsHideTimer = 0;
    }
    setReaderPlayerControlsVisible(false, playerHost);
  };

  playerHost.addEventListener("mouseenter", showControls, true);
  playerHost.addEventListener("mousemove", showControls, true);
  playerHost.addEventListener("mouseleave", hideControls, true);
  playerHost.__mdgReaderControlsHoverBound = { showControls, hideControls };
  state.readingControlsHoverHost = playerHost;
}

function unbindReaderPlayerControlsHover() {
  const playerHost = state.readingControlsHoverHost;
  if (state.readingControlsHideTimer) {
    window.clearTimeout(state.readingControlsHideTimer);
    state.readingControlsHideTimer = 0;
  }
  if (!playerHost?.__mdgReaderControlsHoverBound) {
    state.readingControlsHoverHost = null;
    return;
  }

  const { showControls, hideControls } = playerHost.__mdgReaderControlsHoverBound;
  playerHost.removeEventListener("mouseenter", showControls, true);
  playerHost.removeEventListener("mousemove", showControls, true);
  playerHost.removeEventListener("mouseleave", hideControls, true);
  delete playerHost.__mdgReaderControlsHoverBound;
  setReaderPlayerControlsVisible(false, playerHost);
  state.readingControlsHoverHost = null;
}

function setReaderHeaderActionsVisible(visible) {
  const actions = document.querySelector(".mdg-reading-actions");
  if (!actions) {
    return;
  }
  if (visible) {
    actions.removeAttribute("data-mdg-icon-hidden");
    return;
  }
  actions.setAttribute("data-mdg-icon-hidden", "1");
}

function scheduleReaderHeaderActionsHide(delayMs = 10000) {
  if (state.readingHeaderHideTimer) {
    window.clearTimeout(state.readingHeaderHideTimer);
    state.readingHeaderHideTimer = 0;
  }
  state.readingHeaderHideTimer = window.setTimeout(() => {
    state.readingHeaderHideTimer = 0;
    if (!state.readingViewOpen) {
      return;
    }
    setReaderHeaderActionsVisible(false);
  }, delayMs);
}

function bindReaderHeaderActionsHover() {
  if (!state.readingViewOpen) {
    return;
  }
  const header = document.querySelector(".mdg-reading-header");
  if (!header || header.__mdgReaderHeaderHoverBound) {
    state.readingHeaderHoverHost = header || null;
    return;
  }

  const showActions = () => {
    if (!state.readingViewOpen) {
      return;
    }
    if (state.readingHeaderHideTimer) {
      window.clearTimeout(state.readingHeaderHideTimer);
      state.readingHeaderHideTimer = 0;
    }
    setReaderHeaderActionsVisible(true);
  };
  const hideActionsLater = () => {
    if (!state.readingViewOpen) {
      return;
    }
    scheduleReaderHeaderActionsHide();
  };

  // Anywhere along the top of the page brings them back, not just over the buttons.
  const onMove = (event) => {
    if (event.clientY > 80 || header.matches(":hover")) return;
    showActions();
    hideActionsLater();
  };
  header.addEventListener("mouseenter", showActions, true);
  header.addEventListener("mouseleave", hideActionsLater, true);
  document.addEventListener("mousemove", onMove, { passive: true });
  header.__mdgReaderHeaderHoverBound = { showActions, hideActionsLater, onMove };
  state.readingHeaderHoverHost = header;
  setReaderHeaderActionsVisible(true);
  scheduleReaderHeaderActionsHide();
}

function unbindReaderHeaderActionsHover() {
  const header = state.readingHeaderHoverHost;
  if (state.readingHeaderHideTimer) {
    window.clearTimeout(state.readingHeaderHideTimer);
    state.readingHeaderHideTimer = 0;
  }
  if (!header?.__mdgReaderHeaderHoverBound) {
    state.readingHeaderHoverHost = null;
    return;
  }
  const { showActions, hideActionsLater, onMove } = header.__mdgReaderHeaderHoverBound;
  header.removeEventListener("mouseenter", showActions, true);
  header.removeEventListener("mouseleave", hideActionsLater, true);
  document.removeEventListener("mousemove", onMove);
  delete header.__mdgReaderHeaderHoverBound;
  state.readingHeaderHoverHost = null;
  setReaderHeaderActionsVisible(true);
}

function startPlayerAiQuickActionObserver() {
  if (state.playerAiQuickActionObserver || !document.body) {
    return;
  }

  const observer = new MutationObserver(() => {
    schedulePlayerAiQuickActionSync();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  state.playerAiQuickActionObserver = observer;
}

function bindPlayerAiQuickActionLayoutEvents() {
  if (state.playerAiQuickActionLayoutBound) {
    return;
  }
  const schedule = () => schedulePlayerAiQuickActionSync(80);
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("pageshow", schedule, { passive: true });
  document.addEventListener("fullscreenchange", schedule);
  document.addEventListener("webkitfullscreenchange", schedule);
  window.visualViewport?.addEventListener?.("resize", schedule, { passive: true });
  state.playerAiQuickActionLayoutBound = true;
}

function schedulePlayerAiQuickActionSync(delayMs = 120) {
  if (state.playerAiQuickActionSyncTimer) {
    window.clearTimeout(state.playerAiQuickActionSyncTimer);
  }
  state.playerAiQuickActionSyncTimer = window.setTimeout(() => {
    state.playerAiQuickActionSyncTimer = 0;
    syncPlayerAiQuickActionButton();
  }, delayMs);
}

function syncPlayerAiQuickActionButton() {
  if (state.superseded) {
    return;
  }
  let existing = document.getElementById("mdg-player-ai-quick-action");
  // Expandos are per isolated world: a button without ours was left by a previous copy and calls into its dead context.
  if (existing && !existing.__mdgOwned) {
    existing.closest(".mdg-player-ai-wrap")?.remove();
    existing.remove();
    existing = null;
  }
  const existingWrap = existing?.closest(".mdg-player-ai-wrap");
  if (!state.settings?.enablePlayerAiQuickAction || !state.settings.hasAiProvider || state.readingViewOpen || isReaderMode()) {
    removePlayerAiQuickActionButton();
    return;
  }

  if (!hasPlayerSubtitleControl()) {
    removePlayerAiQuickActionButton();
    return;
  }

  const playerHost = findPlayerAiQuickActionHost();
  if (!playerHost) {
    if (!existingWrap?.isConnected) {
      existingWrap?.remove();
      existing?.remove();
    } else {
      schedulePlayerAiQuickActionSync(260);
    }
    return;
  }

  let button = existing;
  let wrap = existingWrap instanceof HTMLElement ? existingWrap : null;
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "mdg-player-ai-wrap";
  }
  if (!button) {
    button = document.createElement("button");
    button.id = "mdg-player-ai-quick-action";
    button.type = "button";
    button.className = "mdg-player-ai-quick-action";
    button.title = "AI 总结";
    button.setAttribute("aria-label", "AI 总结");
    button.innerHTML = buildPlayerAiQuickActionIconSvg();
    button.addEventListener("click", handlePlayerAiQuickActionClick, true);
    button.__mdgOwned = true;
  }

  if (button.parentElement !== wrap) {
    wrap.replaceChildren(button);
  }
  if (wrap.parentElement !== playerHost) {
    playerHost.appendChild(wrap);
  }
  bindPlayerAiQuickActionCursorSync(wrap);
  syncPlayerAiQuickActionVisuals(button);
}

function removePlayerAiQuickActionButton() {
  if (state.playerAiQuickActionCursorHideTimer) {
    window.clearTimeout(state.playerAiQuickActionCursorHideTimer);
    state.playerAiQuickActionCursorHideTimer = 0;
  }
  document.getElementById("mdg-player-ai-quick-action")?.closest(".mdg-player-ai-wrap")?.remove();
}

function bindPlayerAiQuickActionCursorSync(wrap) {
  if (!(wrap instanceof HTMLElement)) {
    return;
  }
  const host = wrap.parentElement instanceof HTMLElement ? wrap.parentElement : null;
  if (!host || wrap.__mdgPlayerAiCursorHost === host) {
    return;
  }
  const hideForIdle = () => {
    state.playerAiQuickActionCursorHideTimer = 0;
    wrap.classList.remove("is-active");
  };
  const showForCursorActivity = () => {
    if (!wrap.isConnected || state.readingViewOpen || isReaderMode()) {
      wrap.classList.remove("is-active");
      return;
    }
    wrap.classList.add("is-active");
    if (state.playerAiQuickActionCursorHideTimer) {
      window.clearTimeout(state.playerAiQuickActionCursorHideTimer);
    }
    state.playerAiQuickActionCursorHideTimer = window.setTimeout(hideForIdle, 1900);
  };
  const hideImmediately = () => {
    if (state.playerAiQuickActionCursorHideTimer) {
      window.clearTimeout(state.playerAiQuickActionCursorHideTimer);
      state.playerAiQuickActionCursorHideTimer = 0;
    }
    wrap.classList.remove("is-active");
  };
  host.addEventListener("mousemove", showForCursorActivity, { passive: true });
  host.addEventListener("mouseenter", showForCursorActivity, { passive: true });
  host.addEventListener("mouseleave", hideImmediately, { passive: true });
  host.addEventListener("pointermove", showForCursorActivity, { passive: true });
  wrap.__mdgPlayerAiCursorHost = host;
}

function hasPlayerSubtitleControl() {
  return Boolean(findPlayerSubtitleControlNode());
}

function findPlayerSubtitleControlNode() {
  const controlRoots = Array.from(
    document.querySelectorAll(sel(reader().subtitleControlRoots))
  );

  for (const root of controlRoots) {
    const candidates = Array.from(
      root.querySelectorAll(
        "[aria-label*='字幕'], [title*='字幕'], [data-text*='字幕'], [class*='subtitle'], [class*='caption'], button, [role='button']"
      )
    );
    const matched = candidates.find((node) => isPlayerSubtitleControlNode(node));
    if (matched) {
      return matched;
    }
  }

  return null;
}

function isPlayerSubtitleControlNode(node) {
  if (!(node instanceof Element)) {
    return false;
  }
  const text = [
    node.getAttribute("aria-label"),
    node.getAttribute("title"),
    node.getAttribute("data-text"),
    node.textContent,
    typeof node.className === "string" ? node.className : ""
  ]
    .filter((item) => typeof item === "string" && item.trim())
    .join(" ");
  return /字幕|subtitle/i.test(text);
}

function findPlayerAiQuickActionHost() {
  const candidates = reader().aiQuickActionHosts.map((selector) => document.querySelector(selector));
  return candidates.find((node) => node instanceof HTMLElement && isVisibleReaderControl(node)) || null;
}

function buildPlayerAiQuickActionIconSvg() {
  return `
      <svg viewBox="0 0 132 132" focusable="false" aria-hidden="true" data-ai-icon="badge">
        <path stroke-width="8.25" d="M22 90.7494C22 99.8618 29.3873 107.249 38.5 107.249C38.5 114.843 44.6561 120.999 52.25 120.999C59.8438 120.999 66 114.843 66 107.249C66 114.843 72.1562 120.999 79.75 120.999C87.3438 120.999 93.5 114.843 93.5 107.249C102.613 107.249 110 99.8613 110 90.7489C110 87.621 109.13 84.6967 107.618 82.2046C115.24 80.7466 121 74.0454 121 65.9989C121 57.9518 115.24 51.2507 107.618 49.7929C109.13 47.3006 110 44.3763 110 41.2487C110 32.1359 102.613 24.7487 93.5 24.7487C93.5 17.1547 87.3438 10.9987 79.75 10.9987C72.1562 10.9987 66 17.1552 66 24.7492C66 17.1552 59.8438 10.9992 52.25 10.9992C44.6561 10.9992 38.5 17.1552 38.5 24.7492C29.3873 24.7492 22 32.1365 22 41.2492C22 44.3768 22.8702 47.3012 24.3817 49.7934C16.76 51.2512 11 57.9524 11 65.9994C11 74.0459 16.76 80.7471 24.3817 82.2052C22.8702 84.6972 22 87.6216 22 90.7494Z"></path>
        <path stroke-width="8.25" d="M41.25 79.7494L51.3804 49.3582C51.8997 47.8002 53.3577 46.7493 55 46.7493C56.6423 46.7493 58.1004 47.8002 58.6196 49.3582L68.75 79.7494M85.25 46.7493V79.7494M46.75 68.7494H63.25"></path>
      </svg>
  `;
}

function syncPlayerAiQuickActionVisuals(button) {
  if (!(button instanceof HTMLElement)) {
    return;
  }
  const wrap = button.parentElement instanceof HTMLElement ? button.parentElement : null;
  const hitSize = 36;
  const iconSize = 24;
  const baseColor = "#f6f7f8";
  [wrap, button].filter(Boolean).forEach((node) => {
    node.style.setProperty("--mdg-player-ai-action-hit-size", `${hitSize}px`);
    node.style.setProperty("--mdg-player-ai-action-color", baseColor);
    node.style.setProperty("--mdg-player-ai-action-hover-color", baseColor);
  });
  button.style.setProperty("--mdg-player-ai-action-icon-size", `${iconSize}px`);
}

async function handlePlayerAiQuickActionClick(event) {
  event.preventDefault();
  event.stopPropagation();
  if (
    state.playerAiQuickActionSubmitting ||
    state.readingViewOpen ||
    isReaderMode() ||
    Date.now() < state.playerAiQuickActionSuppressedUntil
  ) {
    return;
  }

  state.playerAiQuickActionSubmitting = true;
  const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
  if (button) {
    button.disabled = true;
  }

  try {
    state.settings = await getSettings();
    if (!state.settings?.enablePlayerAiQuickAction) {
      throw new Error("✦ AI 按钮未开启");
    }
    const resp = await sendRuntimeMessage({ type: "player-ai-quick-action", contextRef: viewerContextRef() });
    if (!resp?.ok) {
      throw new Error(resp?.error || "未知错误");
    }
    setMessage("点发送开始 AI 总结");
  } catch (error) {
    setMessage(`打开侧边栏失败：${getErrorMessage(error)}`);
    setReadingNotice(`打开侧边栏失败：${getErrorMessage(error)}`);
  } finally {
    state.playerAiQuickActionSubmitting = false;
    if (button) {
      button.disabled = false;
    }
  }
}

// The video playing in 分拣台's viewer, in the shape 分拣台's 问 AI hands the side panel; null in a normal tab.
function viewerContextRef() {
  const ref = IN_VIEWER ? MdgSites.parseRef(location.href) : null;
  if (!ref) return null;
  return { site: ref.site, videoId: ref.id, pageIndex: ref.part?.index || 1, title: state.title, author: state.author, url: ref.url };
}

function isVisibleReaderControl(node) {
  if (!node || typeof node.getBoundingClientRect !== "function") {
    return false;
  }
  const rect = node.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const style = window.getComputedStyle(node);
  return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
}

function normalizeReaderPlayerContainer(playerHost = state.readingPlayerHost) {
  if (!playerHost) {
    return;
  }

  restoreReaderPlayerContainer();
  const adjusted = [];
  let current = playerHost;
  let depth = 0;

  while (current && current !== document.body && depth < 12) {
    const computed = window.getComputedStyle(current);
    const className = typeof current.className === "string" ? current.className : "";
    const isPlayerLayoutNode = current.matches?.(sel(reader().playerLayout));
    const isExplicitMiniNode = current.matches?.(
      sel([...reader().miniPlayer, "[class*='mini-player']", "[class*='picture-in-picture']"])
    );
    const hasFloatingPosition = computed.position === "fixed" || computed.position === "sticky";
    const isMiniLike =
      hasFloatingPosition ||
      /mini|picture|float|fixed-player/i.test(className) ||
      current.matches?.(sel(reader().miniPlayer));
    const shouldReset = state.readingViewOpen
      ? Boolean(isExplicitMiniNode || (isPlayerLayoutNode && isMiniLike))
      : isPlayerLayoutNode || isMiniLike;

    if (shouldReset) {
      adjusted.push({
        node: current,
        position: current.style.position,
        left: current.style.left,
        top: current.style.top,
        right: current.style.right,
        bottom: current.style.bottom,
        width: current.style.width,
        height: current.style.height,
        transform: current.style.transform,
        margin: current.style.margin,
        zIndex: current.style.zIndex
      });
      current.setAttribute("data-mdg-reader-player-reset", "1");
      current.style.setProperty("position", "static", "important");
      current.style.setProperty("left", "auto", "important");
      current.style.setProperty("top", "auto", "important");
      current.style.setProperty("right", "auto", "important");
      current.style.setProperty("bottom", "auto", "important");
      current.style.setProperty("transform", "none", "important");
      current.style.setProperty("margin", "0", "important");
      current.style.setProperty("z-index", "auto", "important");
      if (current !== playerHost) {
        current.style.removeProperty("width");
        current.style.removeProperty("height");
      }
    }

    current = current.parentElement;
    depth += 1;
  }

  state.readingPlayerAdjustedNodes = adjusted;
}

function restoreReaderPlayerContainer() {
  const adjusted = Array.isArray(state.readingPlayerAdjustedNodes) ? state.readingPlayerAdjustedNodes : [];
  adjusted.forEach((item) => {
    const node = item?.node;
    if (!node?.isConnected) {
      return;
    }
    node.style.position = item.position || "";
    node.style.left = item.left || "";
    node.style.top = item.top || "";
    node.style.right = item.right || "";
    node.style.bottom = item.bottom || "";
    node.style.width = item.width || "";
    node.style.height = item.height || "";
    node.style.transform = item.transform || "";
    node.style.margin = item.margin || "";
    node.style.zIndex = item.zIndex || "";
    node.removeAttribute("data-mdg-reader-player-reset");
  });
  state.readingPlayerAdjustedNodes = [];
}

function alignReaderViewportToPlayer() {
  if (!isReaderMode()) {
    return;
  }

  const titleNode = findReaderTitleContainer();
  const playerHost = state.readingPlayerHost || findReaderPlayerHost(getRuntimeVideoElement());
  const anchor = titleNode || playerHost;
  if (!anchor) {
    return;
  }

  const titleRect = titleNode?.getBoundingClientRect?.();
  const playerRect = playerHost?.getBoundingClientRect?.();
  const top = Math.min(
    titleRect?.top ?? Number.POSITIVE_INFINITY,
    playerRect?.top ?? Number.POSITIVE_INFINITY
  );
  if (!Number.isFinite(top)) {
    return;
  }

  const nextTop = Math.max(0, window.scrollY + top - 16);
  window.scrollTo({ top: nextTop, behavior: "auto" });
  window.setTimeout(() => {
    if (!state.readingViewOpen || !isReaderMode()) {
      return;
    }
    window.scrollTo({ top: nextTop, behavior: "auto" });
    layoutReaderPlayerHost();
  }, 120);
}

function syncReadingViewPlayback(forceScroll = false) {
  if (!state.readingViewOpen) {
    return;
  }

  layoutReaderPlayerHost();

  const runtimeVideo = getRuntimeVideoElement();
  const runtimeHost = findReaderPlayerHost(runtimeVideo);
  if (runtimeVideo && runtimeHost) {
    const playerChanged =
      runtimeVideo !== state.readingVideoEl || runtimeHost !== state.readingPlayerHost;
    if (playerChanged) {
      queueEnsureReaderPlayerMounted();
    }
  }

  const video = bindReadingViewVideo(runtimeVideo || state.readingVideoEl);
  if (!video) {
    return;
  }

  const currentTime = Number(video.currentTime || 0) || 0;
  const subtitleIndex = findActiveSubtitleIndex(currentTime);
  const chapterIndex = findActiveChapterIndex(currentTime);
  const changed =
    subtitleIndex !== state.readingActiveSubtitleIndex ||
    chapterIndex !== state.readingActiveChapterIndex;
  updateReaderFollowState();
  if (changed || forceScroll) {
    setActiveReadingItems(subtitleIndex, chapterIndex, true);
  }
}

function findActiveSubtitleIndex(currentTime) {
  const items = Array.isArray(state.subtitleBody) ? state.subtitleBody : [];
  const matches = (item) => {
    const from = Number(item?.from || 0) || 0;
    const rawTo = Number(item?.to || 0) || 0;
    return currentTime >= from && currentTime < (rawTo > from ? rawTo : from + 2);
  };
  // Playback mostly moves forward, so look from the active line first.
  for (let index = Math.max(0, state.readingActiveSubtitleIndex); index < items.length; index += 1) {
    if (matches(items[index])) {
      return index;
    }
  }
  return items.findIndex(matches);
}

function findActiveChapterIndex(currentTime) {
  const chapters = MdgSites.normalizeChapters(state.chapters || []);
  for (let index = 0; index < chapters.length; index += 1) {
    const item = chapters[index];
    const from = Number(item?.from || 0) || 0;
    const next = chapters[index + 1];
    const explicitTo = Number(item?.to || 0) || 0;
    const fallbackTo = next && Number(next.from) > from ? Number(next.from) : explicitTo;
    const to = fallbackTo > from ? fallbackTo : Number.POSITIVE_INFINITY;
    if (currentTime >= from && currentTime < to) {
      return index;
    }
  }
  return -1;
}

function setActiveReadingItems(subtitleIndex, chapterIndex, shouldScroll = false) {
  const transcriptList = byId(ids.readingTranscriptList);
  const chapterList = byId(ids.readingChapterList);
  const nextTranscript = transcriptList.querySelector(`[data-index="${subtitleIndex}"]`);
  const nextChapter = chapterList.querySelector(`[data-index="${chapterIndex}"]`);
  const currentTranscript = transcriptList.querySelector(".mdg-reading-item.is-active");
  const currentChapter = chapterList.querySelector(".mdg-reading-chapter.is-active");

  if (currentTranscript && currentTranscript !== nextTranscript) {
    currentTranscript.classList.remove("is-active");
  }
  if (currentChapter && currentChapter !== nextChapter) {
    currentChapter.classList.remove("is-active");
  }
  if (nextTranscript) {
    nextTranscript.classList.add("is-active");
  }
  if (nextChapter) {
    nextChapter.classList.add("is-active");
  }

  if (shouldScroll && state.readingAutoScroll) {
    if (Date.now() < state.readingManualScrollPauseUntil) {
      updateReaderFollowState();
      state.readingActiveSubtitleIndex = subtitleIndex;
      state.readingActiveChapterIndex = chapterIndex;
      return;
    }
    if (nextTranscript) {
      scrollReadingTranscriptItemIntoView(nextTranscript);
    }
    if (nextChapter) {
      scrollReadingRailItemIntoView(nextChapter);
    }
  }

  state.readingActiveSubtitleIndex = subtitleIndex;
  state.readingActiveChapterIndex = chapterIndex;
}

function scrollReadingRailItemIntoView(node) {
  if (!node) {
    return;
  }
  state.readingProgrammaticScrollUntil = Date.now() + 600;
  node.scrollIntoView({
    behavior: "smooth",
    block: "nearest",
    inline: "nearest"
  });
}

function scrollReadingTranscriptItemIntoView(node) {
  if (!node) {
    return;
  }

  const transcriptList = byId(ids.readingTranscriptList);
  const inlineHost = document.getElementById("mdg-reading-inline-host");
  const listRect = transcriptList.getBoundingClientRect();
  const itemRect = node.getBoundingClientRect();
  if (!(listRect.height > 0) || !(itemRect.height > 0)) {
    scrollReadingRailItemIntoView(node);
    return;
  }

  const behavior = state.readingNextScrollBehavior === "auto" ? "auto" : "smooth";
  state.readingProgrammaticScrollUntil = Date.now() + (behavior === "auto" ? 120 : 800);
  state.readingNextScrollBehavior = "smooth";
  if (inlineHost && inlineHost.scrollHeight > inlineHost.clientHeight + 8) {
    const hostRect = inlineHost.getBoundingClientRect();
    const computed = window.getComputedStyle(node);
    const lineHeight = Number.parseFloat(computed.lineHeight) || itemRect.height || 32;
    const desiredOffset = lineHeight * 2.5;
    const targetScrollTop =
      inlineHost.scrollTop + (itemRect.top - hostRect.top) - desiredOffset;
    inlineHost.scrollTo({
      top: Math.max(0, Math.round(targetScrollTop)),
      behavior
    });
    return;
  }
  const desiredTop = listRect.top + Math.max(72, Math.min(listRect.height * 0.24, 220));
  const nextTop = window.scrollY + itemRect.top - desiredTop;
  window.scrollTo({
    top: Math.max(0, Math.round(nextTop)),
    behavior
  });
}

function jumpReadingTarget(seconds) {
  const video = bindReadingViewVideo();
  if (!video) {
    setReadingNotice("当前页面没有找到可联动的视频播放器。");
    return;
  }

  state.readingManualScrollPauseUntil = 0;
  state.readingNextScrollBehavior = "auto";
  updateReaderFollowState();
  seekVideo(video, seconds);
  syncReadingViewPlayback(true);
}

// Every jump to a time point (专注模式 rows and chapters, the side panel's timestamps) keeps a paused video paused.
function seekVideo(video, seconds) {
  const nextTime = Math.max(0, Number(seconds) || 0);
  const wasPaused = Boolean(video.paused);
  video.currentTime = nextTime;
  if (!wasPaused) video.play().catch(() => {});
  return nextTime;
}

function onReadingChapterClick(event) {
  const target = event.target.closest(".mdg-reading-chapter");
  if (!target) {
    return;
  }
  jumpReadingTarget(target.dataset.seconds);
}

function onReadingTranscriptClick(event) {
  if (event.target.closest(".mdg-reading-retry")) {
    settledClip(true).catch((error) => setReadingNotice(`字幕加载失败：${fetchErrorText(error)}`));
    return;
  }
  const target = event.target.closest(".mdg-reading-item");
  if (!target) {
    return;
  }
  // Don't jump if user is selecting text
  if (window.getSelection()?.toString().trim()) {
    return;
  }
  jumpReadingTarget(target.dataset.seconds);
}

function noteManualReaderInteraction(durationMs = 3000) {
  if (!state.readingAutoScroll) {
    updateReaderFollowState();
    return;
  }
  state.readingManualScrollPauseUntil = Date.now() + durationMs;
  updateReaderFollowState();
}

function updateReaderFollowState() {
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  // A paused video gets no playback ticks to clear the hint, so it is not shown while paused; the scroll guard still holds.
  const manual = Date.now() < state.readingManualScrollPauseUntil && !state.readingVideoEl?.paused;
  const mode = !state.readingAutoScroll ? "off" : manual ? "manual" : "auto";
  if (readingView.getAttribute("data-mdg-reader-follow") !== mode) {
    readingView.setAttribute("data-mdg-reader-follow", mode);
  }
}

function computeCurrentClipSignature(url = location.href) {
  const ref = MdgSites.parseRef(url);
  return ref ? [ref.site, ref.id, ref.part?.index || 1, ref.part?.oid || ""].join("|") : "";
}

// The language setting is YouTube's only; Bilibili keeps the default order.
function subtitleLangTarget() {
  return state.site === "youtube" ? MdgSites.normalizeSubtitleLang(state.settings?.youtubeSubtitleLang) : "auto";
}

function currentSite() {
  return MdgSites.matchSite(location.href);
}

function reader() {
  return (currentSite() || MdgSites.SITES.bilibili).reader;
}

// Joins a selector list; an empty list yields a selector that matches nothing.
function sel(list) {
  return list.length ? list.join(", ") : ":not(*)";
}

function closestIn(node, list) {
  for (const selector of list) {
    const hit = node?.closest?.(selector);
    if (hit) {
      return hit;
    }
  }
  return null;
}

function queryFirst(list, root = document) {
  for (const selector of list) {
    const hit = root.querySelector(selector);
    if (hit) {
      return hit;
    }
  }
  return null;
}

// Sites that answer outside the page (Bilibili API and its cross-origin hdslb
// subtitle files) are read through the background worker, as background.js
// itself does; pageOnly sites are fetched from the page directly.
function siteIo() {
  return {
    doc: document,
    subtitleLang: subtitleLangTarget(),
    readPlayer: async () => {
      const resp = await sendRuntimeMessage({ type: "yt-player-response" });
      if (!resp?.ok) {
        throw new Error(toReadableText(resp?.error, "player read failed"));
      }
      return resp.data;
    },
    capturePot: ytCapturePot,
    fetchJson: (url) => (currentSite()?.pageOnly ? fetchJson(url) : fetchJsonInBackground(url)),
    fetchText: async (url) => (await fetchOk(url, { credentials: "include" })).text(),
    postJson: async (url, body, headers = {}) =>
      (
        await fetchOk(url, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body)
        })
      ).json()
  };
}

// The page player's timedtext requests carry the subtitle PO token. The
// content script shares the document's performance timeline, but YouTube
// clears resource timings periodically, so an earlier request is rarely still
// there; then captions are switched on (off first when already on, since only
// the on-click fetches), the token is read from the request the observer
// delivers, and the button is left as found. The token goes nowhere but
// youtube.com timedtext URLs.
async function ytCapturePot(videoId) {
  let pot = MdgSites.ytPotFromUrls(performance.getEntriesByType("resource").map((entry) => entry.name), videoId);
  const button = document.querySelector("#movie_player .ytp-subtitles-button");
  if (pot || !button) {
    return pot;
  }
  const wasOn = button.getAttribute("aria-pressed") === "true";
  // Right after load the player may not fetch captions on the first click yet; a second round a few seconds later does.
  for (let attempt = 0; attempt < 2 && !pot; attempt += 1) {
    pot = await toggleCaptionsForPot(button, wasOn, videoId);
  }
  logInfo("[MDG] youtube pot capture", { wasOn, found: Boolean(pot) });
  return pot;
}

async function toggleCaptionsForPot(button, wasOn, videoId) {
  const pot = await new Promise((resolve) => {
    const observer = new PerformanceObserver((list) => {
      const hit = MdgSites.ytPotFromUrls(list.getEntries().map((entry) => entry.name), videoId);
      if (hit) {
        observer.disconnect();
        resolve(hit);
      }
    });
    observer.observe({ type: "resource" });
    window.setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, 5000);
    if (wasOn) {
      button.click();
    }
    button.click();
  });
  if (!wasOn) {
    button.click();
  }
  return pot;
}

function currentRef() {
  const site = currentSite();
  if (!site || !state.videoId) {
    return null;
  }
  return { site: state.site, id: state.videoId, part: { index: state.pageIndex, cid: state.cid }, url: cleanVideoUrl() };
}

function cleanVideoUrl(href = location.href) {
  const site = currentSite();
  if (site && state.videoId && site.id === state.site) {
    return site.canonicalUrl(state.videoId, state.pageCount > 1 ? state.pageIndex : 1);
  }
  return MdgSites.cleanUrl(href);
}


async function fetchHotComments() {
  const site = currentSite();
  const ref = currentRef();
  if (!site?.fetchComments || !ref) {
    return [];
  }
  return site.fetchComments(ref, state.meta, siteIo());
}

function toReadableText(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text === "[object Object]") {
      return fallback;
    }
    return text;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    if (json && json !== "{}") {
      return json;
    }
  } catch {}
  const text = String(value);
  if (!text || text === "[object Object]") {
    return fallback;
  }
  return text;
}

// A failed fetch in the user's words: B站 risk control (HTTP 412 or its codes) and a dropped connection are named,
// and no raw English, HTTP status or B站 code is shown. getErrorMessage keeps the raw text for logs and retry checks.
function fetchErrorText(error) {
  if (isBiliRiskError(error)) {
    return MdgErrors.TEXT.biliThrottled;
  }
  if (/failed to fetch|networkerror|load failed/i.test(toReadableText(error?.message, ""))) {
    return MdgErrors.TEXT.network;
  }
  // B站 codes with their own words (62004 审核中) read as in 分拣台 and the other pages.
  return MdgErrors.text({ error: toReadableText(error?.message, ""), code: error?.code }, getErrorMessage(error));
}

function getErrorMessage(error, fallback = "未知错误") {
  const code = toReadableText(error?.code, "");
  const message = toReadableText(error?.message, "");
  if (message) {
    return code ? `${message} (code: ${code})` : message;
  }
  if (code) {
    return `code: ${code}`;
  }
  return toReadableText(error, fallback);
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(resp);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function requestOpenOptions() {
  sendRuntimeMessage({ type: "open-options" })
    .then((resp) => {
      if (!resp?.ok) {
        setMessage(`打开设置失败：${toReadableText(resp?.error, "未知错误")}`);
      }
    })
    .catch((error) => {
      if (MdgErrors.reloaded(error)) {
        setMessage(MdgErrors.TEXT.reloaded);
        return;
      }
      setMessage(`打开设置失败：${getErrorMessage(error)}`);
    });
}

async function getSettings() {
  const hasAiProvider = await loadHasAiProvider();
  try {
    const response = await sendRuntimeMessage({ type: "get-settings" });
    if (!response?.ok) {
      return { ...DEFAULT_SETTINGS, hasAiProvider };
    }
    return { ...DEFAULT_SETTINGS, ...(response.settings || {}), hasAiProvider };
  } catch (error) {
    return { ...DEFAULT_SETTINGS, hasAiProvider };
  }
}

// The player's AI button waits for a platform so it does not sit on every video unasked; get-settings does not carry
// the platform list. The focus-mode one always shows: opening focus mode is already asking to read the video.
async function loadHasAiProvider() {
  try {
    const { aiProviders } = await chrome.storage.sync.get({ aiProviders: [] });
    return Array.isArray(aiProviders) && aiProviders.some((p) => p?.id && p.enabled !== false);
  } catch {
    return false;
  }
}

function byId(id) {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing node: ${id}`);
  }
  return node;
}

function ensureRunActive(runId) {
  if (runId !== state.fetchRunId) {
    const error = new Error("Stale refresh run");
    error.code = "STALE_RUN";
    throw error;
  }
}

// The shared subtitle step's step hook: a run the video change superseded stops at its next wait.
function runStep(runId) {
  return (promise) => promise.then((value) => (ensureRunActive(runId), value));
}

function isStaleRunError(error) {
  return error?.code === "STALE_RUN";
}

// B站 risk control (sites.js's B站 reads say THROTTLED; HTTP 412 or its codes elsewhere): retrying at once only digs
// deeper, so it is never retried.
const isBiliRiskError = (error) => error?.code === "THROTTLED" || error?.status === 412 || MdgSites.BILI_RISK_CODES.has(error?.code);

async function retryAsync(task, retries = 1, delayMs = 180) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (isBiliRiskError(error)) {
        throw error;
      }
      const isNetworkError = isRetryableNetworkError(error);
      const isRetryable = error?.retryable === true;
      if (!isNetworkError && !isRetryable) {
        throw error;
      }
      if (attempt >= retries) {
        throw error;
      }
      const backoffDelay = Math.min(delayMs * Math.pow(2, attempt - 1), 5000);
      logInfo(`[MDG] retrying after ${backoffDelay}ms, attempt ${attempt + 1}/${retries}`, {
        error: getErrorMessage(error),
        code: error.code
      });
      await sleep(backoffDelay);
    }
  }
  throw lastError || new Error("Unknown retry error");
}

function isRetryableNetworkError(error) {
  if (error?.status === 429) {
    return false;
  }
  const message = getErrorMessage(error, "").toLowerCase();
  if (!message) {
    return false;
  }

  if (message.includes("http ")) {
    return true;
  }

  return (
    message.includes("请求失败") ||
    message.includes("failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("networkerror") ||
    message.includes("net::") ||
    message.includes("background fetch failed") ||
    message.includes("timeout") ||
    message.includes("超时") ||
    message.includes("timed out")
  );
}

async function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}


function readRuntimeVideoDuration() {
  const video = getRuntimeVideoElement();
  const duration = Number(video?.duration);
  if (Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  return 0;
}

async function fetchJson(url) {
  return (await fetchOk(url, { credentials: "include" })).json();
}

// A hung request would keep refreshPromise pending, and with it the popup's
// refresh and sidepanel-get-context, so every page fetch gives up after 15s.
async function fetchOk(url, init) {
  let response;
  try {
    response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(15000) });
  } catch (error) {
    throw error?.name === "TimeoutError" ? new Error("请求超时，请稍后重试") : error;
  }
  if (!response.ok) {
    throw httpError(response.status);
  }
  return response;
}

function httpError(status) {
  const error = new Error(`请求失败：${status}`);
  error.status = status;
  return error;
}

async function fetchJsonInBackground(url) {
  try {
    const resp = await sendRuntimeMessage({ type: "fetch-json", url });
    if (!resp?.ok) {
      const error = new Error(toReadableText(resp?.error, "Background fetch failed"));
      error.status = resp?.status;
      throw error;
    }
    return resp.data;
  } catch (error) {
    if (MdgErrors.reloaded(error)) {
      throw new Error(MdgErrors.TEXT.reloaded);
    }
    throw error;
  }
}

// The newest side panel conversation about this video, for the note's AI 问答 section.
async function loadAiTurns() {
  try {
    const key = MdgLimits.KEYS.aiConversations;
    const conversation = MdgNote.pickConversation((await chrome.storage.local.get(key))[key], state);
    return MdgNote.buildConversationTurns(conversation?.messages);
  } catch (error) {
    logWarn("[MDG] failed to load AI conversation for note export", error);
    return [];
  }
}

// The 分拣台 summary, the video's 我的备注 and its 分拣 tags, so this note matches what 分拣台 writes for the video.
async function loadTriageExtras() {
  if (!state.videoId) {
    return null;
  }
  try {
    const ref = { site: state.site, videoId: state.videoId, pageIndex: state.pageIndex };
    return MdgNote.triageExtras(await chrome.storage.local.get(MdgNote.triageExtrasKeys(ref)), ref);
  } catch (error) {
    logWarn("[MDG] failed to load triage summary for note export", error);
    return null;
  }
}

function rebuildDerivedContent() {
  const body = Array.isArray(state.subtitleBody) ? state.subtitleBody : [];
  state.markdown =
    body.length || state.subtitleFetchState === "empty"
      ? MdgNote.withTriageSummary(
          MdgNote.buildMarkdown({ ...state, userTags: state.triageExtras?.userTags }, body, state.settings, currentRef()),
          state.triageExtras?.analysis,
          state.triageExtras?.note
        )
      : "";
  state.srt = body.length ? buildSrt(body) : "";
  state.txt = body.length ? buildTxt(body, state.settings) : "";
}

// Without subtitles the comments are most of the note, so they are fetched
// regardless of includeHotCommentsInNote.
// Read for the video of the run it started in; a newer run (the video changed) fills its own.
async function refreshDerivedContent() {
  const runId = state.fetchRunId;
  let hotComments = state.hotComments;
  if (state.settings?.includeHotCommentsInNote || state.subtitleFetchState === "empty") {
    const shouldFetchComments = !Array.isArray(hotComments) || hotComments.length === 0;
    if (shouldFetchComments) {
      try {
        hotComments = await fetchHotComments();
      } catch (error) {
        hotComments = [];
        logWarn("[MDG] failed to fetch hot comments for note export", error);
      }
    }
  }
  const aiTurns = await loadAiTurns();
  const triageExtras = await loadTriageExtras();
  if (runId !== state.fetchRunId) {
    return;
  }
  Object.assign(state, { hotComments, aiTurns, triageExtras });
  rebuildDerivedContent();
}
}
