// background.js and popup.js re-inject this file when their version probe misses
// (e.g. mid-navigation). A repeat run must be a no-op, and top-level const would
// throw on redeclaration, so the body sits in this block.
if (!globalThis.__BOC_CONTENT_SCRIPT_LOADED__) {
const DEFAULT_SETTINGS = {
  obsidianEnabled: false,
  noteFolder: "Clippings/{{site}}",
  obsidianApiBaseUrl: "http://127.0.0.1:27123",
  obsidianApiKey: "",
  tags: "clippings",
  downloadFormat: "srt",
  youtubeSubtitleLang: "auto",
  includeDateInFilename: true,
  includeHotCommentsInNote: false,
  includeCoverInNote: true,
  enablePlayerAiQuickAction: true,
  playerAiQuickPrompt: "整理这期视频的内容，输出结构化总结：主题、核心观点、关键细节、结论与可执行启发。",
  includeTimestampInBody: true,
  enableDebugLogs: false,
  readerTheme: "light",
  readerFontScale: "m",
  readerLetterSpacing: "normal",
  readerLineHeight: "tight",
  readerContentWidth: "medium",
  readerChapterVisibility: "show",
  readerTranscriptVisible: true,
  frontmatterFields: BocNote.DEFAULT_FRONTMATTER_FIELDS,
  fixedFrontmatterProperties: [],
  notePlaceholderSections: []
};
const { formatCompactTimestamp, buildSubtitlePreview, buildSrt, buildTxt, shouldShowHoursInNote } = BocNote;

const BOC_VERSION = chrome.runtime.getManifest().version;
const CACHE_KEY_PREFIX = "boc_subtitle_cache_";
globalThis.__BOC_CONTENT_SCRIPT_LOADED__ = BOC_VERSION;
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
  chapters: [],
  hotComments: [],
  markdown: "",
  srt: "",
  txt: "",
  readingViewOpen: false,
  readingAutoScroll: true,
  readingTheme: "light",
  readingFontScale: "m",
  readingLetterSpacing: "normal",
  readingLineHeight: "tight",
  readingContentWidth: "medium",
  readingChapterVisible: true,
  readingTranscriptVisible: true,
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
  playerAiQuickActionRevealTimer: 0,
  playerAiQuickActionHideTimer: 0,
  playerAiQuickActionCursorHideTimer: 0,
  playerAiQuickActionSubmitting: false,
  playerAiQuickActionSuppressedUntil: 0,
  readingDocumentClickBound: false,
  readingManualScrollPauseUntil: 0,
  readingProgrammaticScrollUntil: 0,
  readingViewReady: false,
  statusText: "准备就绪，点击“刷新抓取”开始。",
  messageText: "",
  settings: { ...DEFAULT_SETTINGS }
};

function isReaderMode(url = location.href) {
  try {
    return new URL(url).searchParams.get("boc_reader") === "1";
  } catch {
    return false;
  }
}

function stripReaderModeUrl(url = location.href) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("boc_reader");
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
    logWarn("[BOC] failed to replace reader mode url", error);
  }
}

function isWatchlaterPage(url = location.href) {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "/list/watchlater";
  } catch {
    return false;
  }
}

function getReaderContentMaxPx() {
  if (state.readingContentWidth === "compact") {
    return 680;
  }
  if (state.readingContentWidth === "narrow") {
    return 760;
  }
  if (state.readingContentWidth === "wide") {
    return 980;
  }
  if (state.readingContentWidth === "full") {
    return 1100;
  }
  return 860;
}

function getReaderPagePaddingPx() {
  return Math.min(32, Math.max(16, window.innerWidth * 0.028));
}

function getReaderMainWidthLimit() {
  return Math.max(320, Math.min(getReaderContentMaxPx(), window.innerWidth - getReaderPagePaddingPx() * 2));
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

function normalizeReaderTheme(value) {
  return value === "dark" || value === "paper" ? value : "light";
}

function normalizeReaderFontScale(value) {
  return ["xs", "s", "m", "l", "xl"].includes(value) ? value : "m";
}

function normalizeReaderLetterSpacing(value) {
  return ["tighter", "tight", "normal", "relaxed", "loose"].includes(value) ? value : "normal";
}

function normalizeReaderLineHeight(value) {
  return ["compact", "tight", "normal", "relaxed", "loose"].includes(value) ? value : "tight";
}

function normalizeReaderContentWidth(value) {
  return ["compact", "narrow", "medium", "wide", "full"].includes(value) ? value : "medium";
}

function normalizeReaderChapterVisibility(value) {
  return value === "hide" || value === "auto" ? value : "show";
}

function normalizeReaderTranscriptVisible(value) {
  return value !== false;
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
  root: "boc-root",
  readingView: "boc-reading-view",
  readingPlayerSlot: "boc-reading-player-slot",
  readingStatus: "boc-reading-status",
  readingCloseBtn: "boc-reading-close-btn",
  readingAutoScroll: "boc-reading-autoscroll",
  readingTranscriptVisible: "boc-reading-transcript-visible",
  readingThemeSelect: "boc-reading-theme-select",
  readingSettingsBtn: "boc-reading-settings-btn",
  readingSettingsPanel: "boc-reading-settings-panel",
  readingFontScaleSelect: "boc-reading-font-scale-select",
  readingLetterSpacingSelect: "boc-reading-letter-spacing-select",
  readingLineHeightSelect: "boc-reading-line-height-select",
  readingContentWidthSelect: "boc-reading-content-width-select",
  readingChapterVisible: "boc-reading-chapter-visible",
  readingSubtitleSelect: "boc-reading-subtitle-select",
  readingInfoSummary: "boc-reading-info-summary",
  readingInfoDescription: "boc-reading-info-description",
  readingDescriptionBtn: "boc-reading-description-btn",
  readingMeta: "boc-reading-meta",
  readingChapterList: "boc-reading-chapters",
  readingTranscriptList: "boc-reading-transcript",
  readingTranscriptTailSpacer: "boc-reading-tail-spacer"
};

init();

function init() {
  logInfo(`[BOC] content script loaded, version=${BOC_VERSION}`);
  ensureUiReady({ forceRecreate: true });

  const shouldEnterReaderMode = isReaderMode();
  if (shouldEnterReaderMode) {
    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");
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
        setReadingNotice(`阅读视图启动失败：${getErrorMessage(error)}`);
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
    document.documentElement.dataset.bocSite = currentSite()?.id || "";
    state.uiEventsBound = false;
  }

  if (!state.uiEventsBound) {
    bindUiEvents();
    state.uiEventsBound = true;
  }
}

function clearReaderModePageState() {
  document.documentElement.removeAttribute("data-boc-reader-mode");
  document.documentElement.removeAttribute("data-boc-reader-line-height");
  document.documentElement.removeAttribute("data-boc-reader-theme");
  document.documentElement.removeAttribute("data-boc-reader-font-scale");
  document.documentElement.removeAttribute("data-boc-reader-letter-spacing");
  document.documentElement.removeAttribute("data-boc-reader-content-width");
  document.documentElement.removeAttribute("data-boc-reader-chapter-visibility");
  document.documentElement.removeAttribute("data-boc-reader-has-chapters");
  document.documentElement.removeAttribute("data-boc-reader-transcript-visible");
  document.body.removeAttribute("data-boc-reader-mode");
  document.body.removeAttribute("data-boc-reader-line-height");
  document.body.removeAttribute("data-boc-reading-active");
}

function shouldForceNormalPageState(url = location.href) {
  return !isReaderMode(url) && !state.readingViewOpen;
}

function enforceNormalPageStateIfNeeded(url = location.href) {
  if (!shouldForceNormalPageState(url)) {
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
      "data-boc-reader-mode",
      "data-boc-reader-line-height",
      "data-boc-reader-theme",
      "data-boc-reader-font-scale",
      "data-boc-reader-letter-spacing",
      "data-boc-reader-content-width",
      "data-boc-reader-chapter-visibility",
      "data-boc-reader-has-chapters",
      "data-boc-reader-transcript-visible"
    ]
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["data-boc-reader-mode", "data-boc-reader-line-height", "data-boc-reading-active"]
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

    if (message.type === "popup-refresh") {
      refreshClipShared()
        .then(() => sendResponse({ ok: true, payload: getPopupPayload() }))
        .catch((error) =>
          sendResponse({ ok: false, error: getErrorMessage(error), payload: getPopupPayload() })
        );
      return true;
    }

    if (message.type === "popup-select-subtitle") {
      const url = String(message.url || "").trim();
      const lang = String(message.lang || "unknown");
      const subtitleId = String(message.subtitleId || "");
      if (!url) {
        sendResponse({ ok: false, error: "Missing subtitle URL", payload: getPopupPayload() });
        return false;
      }
      loadSubtitle(url, lang, state.fetchRunId, subtitleId)
        .then(() => {
          setStatus("字幕切换完成。");
          sendResponse({ ok: true, payload: getPopupPayload() });
        })
        .catch((error) =>
          sendResponse({ ok: false, error: getErrorMessage(error), payload: getPopupPayload() })
        );
      return true;
    }

    if (message.type === "popup-send-obsidian") {
      sendToObsidian()
        .then(() => sendResponse({ ok: true, payload: getPopupPayload() }))
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
      if (readerUrl) {
        replaceReaderModeUrl(readerUrl);
        document.documentElement.setAttribute("data-boc-reader-mode", "1");
        document.body.setAttribute("data-boc-reader-mode", "1");
      }
      if (!state.readingViewOpen) {
        enterReaderMode().catch((error) => {
          logWarn("[BOC] reading mode trigger failed", error);
        });
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "sidepanel-get-context") {
      const respond = () => sendResponse(buildSidepanelContext());
      // Mid-run the state already holds the title but no subtitles, and background.js
      // reads that as "loaded, no subtitles"; answer once the run has settled.
      if (state.refreshPromise) {
        waitForRefreshIdle().then(respond);
        return true;
      }
      respond();
      return false;
    }

    if (message.type === "sidepanel-get-hot-comments") {
      if (!currentSite()?.fetchComments || !state.videoId) {
        state.hotComments = [];
        sendResponse({ ok: true, comments: [], note: "当前站点不支持评论" });
        return false;
      }

      fetchHotComments(20)
        .then((hotComments) => {
          state.hotComments = hotComments;
          sendResponse({ ok: true, comments: hotComments });
        })
        .catch((error) => {
          state.hotComments = [];
          sendResponse({ ok: true, comments: [], note: String(error?.message || error) });
        });
      return true;
    }

    if (message.type === "sidepanel-seek-video-time") {
      const seconds = Number(message.seconds);
      const video = getRuntimeVideoElement();
      if (!video) {
        sendResponse({ ok: false, error: "当前页面没有找到可联动的视频播放器。" });
        return false;
      }
      const nextTime = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
      const wasPaused = Boolean(video.paused);
      video.currentTime = nextTime;
      if (!wasPaused) {
        video.play().catch(() => {});
      }
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
    if (
      !changes.enablePlayerAiQuickAction &&
      !changes.playerAiQuickPrompt &&
      !changes.readerTheme &&
      !changes.readerFontScale &&
      !changes.readerLetterSpacing &&
      !changes.readerLineHeight &&
      !changes.readerContentWidth &&
      !changes.readerChapterVisibility &&
      !changes.readerTranscriptVisible
    ) {
      return;
    }

    getSettings()
      .then((settings) => {
        state.settings = settings;
        hydrateReaderStateFromSettings(settings);
        applyReadingViewPresentation();
        schedulePlayerAiQuickActionSync();
      })
      .catch((error) => {
        logWarn("[BOC] failed to refresh settings after storage change", error);
      });
  });
}

function buildUiHtml() {
  return `
    <section id="${ids.readingView}" aria-hidden="true" data-boc-reader-ready="0" aria-busy="true">
      <div class="boc-reading-layout">
        <aside class="boc-reading-rail">
          <div class="boc-reading-eyebrow">章节</div>
          <div id="${ids.readingChapterList}" class="boc-reading-list"></div>
        </aside>

        <section class="boc-reading-stage">
          <header class="boc-reading-header">
            <div class="boc-reading-header-copy">
              <strong class="boc-reading-title">${escapeHtml(state.title || "字幕阅读")}</strong>
              <div id="${ids.readingMeta}" class="boc-reading-meta">${escapeHtml(currentSite()?.domain || "")}</div>
            </div>
            <div class="boc-reading-actions">
              <button id="${ids.readingThemeSelect}" type="button" class="boc-reading-icon-btn" title="主题" aria-label="切换主题">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
              </button>
              <button id="${ids.readingSettingsBtn}" type="button" class="boc-reading-icon-btn" title="设置" aria-label="设置" aria-expanded="false" aria-controls="${ids.readingSettingsPanel}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
              <button id="${ids.readingCloseBtn}" type="button" class="boc-reading-icon-btn" title="退出" aria-label="退出阅读视图">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </header>

          <section id="${ids.readingSettingsPanel}" class="boc-reading-panel boc-reading-settings-panel" hidden>
            <section class="boc-reading-settings-group">
              <div class="boc-reading-eyebrow">排版</div>
              <div class="boc-reading-stepper-list">
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
                  title: "正文宽度",
                  settingKey: "readerContentWidth"
                })}
              </div>
            </section>

            <section class="boc-reading-settings-group">
              <div class="boc-reading-controls">
                <label class="boc-reading-toggle boc-reading-toggle-inline">
                  <input id="${ids.readingAutoScroll}" type="checkbox" checked />
                  <span>滚动</span>
                </label>
                <label class="boc-reading-toggle boc-reading-toggle-inline">
                  <input id="${ids.readingTranscriptVisible}" type="checkbox" checked />
                  <span>字幕</span>
                </label>
                <label class="boc-reading-toggle boc-reading-toggle-inline">
                  <input id="${ids.readingChapterVisible}" type="checkbox" checked />
                  <span>章节</span>
                </label>
              </div>
            </section>

            <section class="boc-reading-settings-group">
              <div class="boc-reading-controls">
                <select id="${ids.readingSubtitleSelect}" class="boc-reading-select boc-reading-select-sm" aria-label="字幕语言">
                </select>
              </div>
            </section>

            <section class="boc-reading-settings-group boc-reading-info-group">
              <div class="boc-reading-eyebrow">视频摘要</div>
              <div id="${ids.readingInfoSummary}" class="boc-reading-info-list"></div>
            </section>
            <section class="boc-reading-settings-group boc-reading-info-group">
              <div class="boc-reading-eyebrow">视频简介</div>
              <div id="${ids.readingInfoDescription}" class="boc-reading-info-copy"></div>
              <button id="${ids.readingDescriptionBtn}" type="button" class="boc-reading-text-btn">展开简介</button>
            </section>
          </section>

          <div class="boc-reading-player-shell">
            <div id="${ids.readingPlayerSlot}" class="boc-reading-player-slot"></div>
          </div>

          <section class="boc-reading-main">
            <div id="${ids.readingTranscriptList}" class="boc-reading-transcript"></div>
          </section>
        </section>
      </div>
    </section>
    <p id="${ids.readingStatus}" class="boc-reading-status" role="status" title="点击关闭" hidden></p>
  `;
}

function bindUiEvents() {
  const readingView = byId(ids.readingView);
  const readingCloseBtn = byId(ids.readingCloseBtn);
  const readingAutoScroll = byId(ids.readingAutoScroll);
  const readingTranscriptVisible = byId(ids.readingTranscriptVisible);
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
    if (isReaderMode()) {
      replaceReaderModeUrl(stripReaderModeUrl(location.href));
    }
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
  readingTranscriptVisible.addEventListener("change", (event) => {
    updateReaderPreferences({ readerTranscriptVisible: Boolean(event.target.checked) }, { persist: true });
    const main = document.querySelector(".boc-reading-main");
    if (main) {
      main.style.display = event.target.checked ? "" : "none";
    }
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
  });
  readingDescriptionBtn.addEventListener("click", () => {
    state.readingDescriptionExpanded = !state.readingDescriptionExpanded;
    renderReadingInfoPanel();
  });
  bindReaderStepperControl(readingFontScaleSelect, "readerFontScale");
  bindReaderStepperControl(readingLetterSpacingSelect, "readerLetterSpacing");
  bindReaderStepperControl(readingLineHeightSelect, "readerLineHeight");
  bindReaderStepperControl(readingContentWidthSelect, "readerContentWidth");

  const readingSubtitleSelect = byId(ids.readingSubtitleSelect);
  readingSubtitleSelect.addEventListener("change", (event) => {
    const option = event.target.options[event.target.selectedIndex];
    const url = String(option?.value || "");
    if (!url) return;
    loadSubtitle(url, String(option.dataset.lang || "unknown"), state.fetchRunId, String(option.dataset.id || ""))
      .then(() => {
        renderReadingView();
        syncReadingViewPlayback(true);
      })
      .catch((error) => {
        logWarn("[BOC] failed to switch subtitle in reading view", error);
      });
  });

  // Click outside settings panel to close
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
      if (e.key !== "Escape" || !state.readingSettingsExpanded) return;
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
  const nextUrl = location.href;
  const nextSignature = computeCurrentClipSignature();
  if (nextSignature === state.currentClipSignature) {
    return;
  }

  state.currentClipSignature = nextSignature;
  try {
    chrome.runtime.sendMessage({ type: "boc-video-changed", url: nextUrl })?.catch?.(() => {});
  } catch {}
  enforceNormalPageStateIfNeeded(nextUrl);
  ensureUiReady();
  // Invalidate the previous video's run so nothing waiting on it gets its subtitles.
  state.fetchRunId++;
  resetClipState();
  const shouldEnterReaderMode = isReaderMode(nextUrl);
  if (!state.readingViewOpen && shouldEnterReaderMode) {
    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");
    enterReaderMode().catch((error) => {
      setReadingNotice(`阅读视图启动失败：${getErrorMessage(error)}`);
    });
    return;
  }
  if (state.readingViewOpen || shouldEnterReaderMode) {
    setReadingNotice("");
    waitForVideoMetadata().then(() => {
      refreshClip().catch((error) => {
        if (!isStaleRunError(error)) {
          setReadingNotice(`自动刷新失败：${getErrorMessage(error)}`);
        }
      });
    });
    return;
  }
  setStatus("检测到页面变化，请点击“刷新抓取”加载当前视频字幕。");
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
  state.subtitleFailure = "";
  state.chapters = [];
  state.hotComments = [];
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
      ? BocNote.buildMarkdown(state, body, { ...settings, includeHotCommentsInNote: false }, currentRef())
      : "";
  } catch (e) {
    subtitleMarkdown = "";
    logWarn("[BOC] sidepanel-get-context: buildMarkdown failed", e);
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
      subtitleLang: state.selectedSubtitleLang || "",
      selectedSubtitleId: state.selectedSubtitleId || "",
      selectedSubtitleUrl: state.selectedSubtitleUrl || "",
      subtitleOptions: state.subtitles || [],
      hotComments: []
    }
  };
}

// A newer run (e.g. the video changed) may start while we wait; wait until none is in flight.
async function waitForRefreshIdle() {
  while (state.refreshPromise) {
    await state.refreshPromise.catch(() => {});
  }
}

// A refresh that lands while one is in flight joins it instead of cancelling it.
function refreshClipShared() {
  return state.refreshPromise || refreshClip();
}

// Every run registers itself, whoever started it (popup, URL watcher, refresh button),
// so sidepanel-get-context can wait for it.
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
    setStatus("正在抓取视频信息...");
    state.subtitleFetchState = "loading";
    if (state.readingViewOpen) {
      renderReadingView();
    }
    state.settings = await getSettings();
    ensureRunActive(runId);

    const site = currentSite();
    const ref = site?.parseRef(location.href);
    if (!ref) {
      throw new Error("当前页面不是支持的视频地址，无法抓取字幕。");
    }
    state.site = ref.site;
    state.videoId = ref.id;

    const meta = await retryAsync(() => site.fetchMeta(ref, siteIo()), 2, 250);
    ensureRunActive(runId);
    logInfo("[BOC] raw meta data", { meta });

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
    state.currentClipSignature = computeCurrentClipSignature();
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

    logInfo("[BOC] resolved video ids", {
      url: location.href,
      aid: state.aid,
      site: state.site,
      videoId: state.videoId,
      cid: state.cid,
      pageIndex: state.pageIndex,
      videoDuration: state.videoDuration
    });

    setStatus("正在获取可用字幕...");
    const subtitleBundle = await retryAsync(
      () => fetchSubtitleBundle(),
      3,
      500
    );
    ensureRunActive(runId);
    state.subtitles = BocSites.rankTracks(subtitleBundle.tracks, subtitleLangTarget());
    state.chapters = BocSites.normalizeChapters(subtitleBundle.chapters);
    logInfo(
      "[BOC] chapters",
      state.chapters.map((item) => ({
        from: item.from,
        to: item.to,
        title: item.title
      }))
    );
    logInfo(
      "[BOC] subtitle tracks",
      state.subtitles.map((item) => ({
        id: item.id,
        lang: item.lang,
        label: item.label,
        kind: item.kind,
        source: item.source,
        url: item.url
      }))
    );

    let selected = null;
    // 无字幕时也允许进入阅读视图，只是字幕区域保持空态。
    if (state.subtitles.length === 0) {
      if (!state.meta?.gate) {
        await showNoSubtitleState(runId);
        return;
      }
      // Gated for the cookieless player call; the transcript runs with cookies.
      selected = await loadTranscriptFallback(new Error(state.meta.gate), runId);
    } else {
      const preferred = BocSites.pickPreferredTrack(state.subtitles, {
        previousId: state.selectedSubtitleId,
        previousUrl: state.selectedSubtitleUrl,
        previousLang: state.selectedSubtitleLang
      });
      const candidates = buildSubtitleCandidates(state.subtitles, preferred);
      try {
        selected = await tryLoadSubtitleCandidates(candidates, runId);
      } catch (error) {
        if (error?.status === 429) {
          selected = await loadTranscriptFallback(error, runId);
        } else {
          const message = getErrorMessage(error, "");
          if (!message.includes("HTTP") && error?.code !== "SUBTITLE_DURATION_MISMATCH") {
            throw error;
          }
          selected = await retrySubtitleCandidates(preferred, runId).catch((retryError) => {
            if (isStaleRunError(retryError)) {
              throw retryError;
            }
            return loadTranscriptFallback(retryError, runId);
          });
        }
      }
    }
    ensureRunActive(runId);
    if (selected) {
      logInfo("[BOC] selected subtitle track", {
        id: selected.id,
        lang: selected.lang,
        label: selected.label
      });
    }
    state.subtitleFetchState = "ready";
    if (state.readingViewOpen) {
      moveReadingMainInline();
      renderReadingView();
      setReadingNotice("");
      startReaderPlayerObserver();
      syncReadingViewPlayback(true);
    }
    setStatus("抓取完成，可以复制、下载或发送到 Obsidian。");
  } catch (error) {
    if (isStaleRunError(error)) {
      return;
    }
    // Reasons arrive with or without a trailing full stop; strip it so the sentences below join cleanly.
    const reason = (
      error?.code === "SUBTITLE_DURATION_MISMATCH"
        ? "未找到与当前视频时长匹配的字幕轨，可能该视频无可用字幕"
        : getErrorMessage(error)
    ).replace(/[。.！!；;，,\s]+$/u, "");
    // Only the subtitle step failed: keep the video info and degrade to the no-subtitle state.
    if (metaLoaded) {
      try {
        await showNoSubtitleState(runId, reason);
      } catch (degradeError) {
        if (isStaleRunError(degradeError)) {
          return;
        }
        throw degradeError;
      }
      return;
    }
    state.subtitleFetchState = "error";
    resetClipState();
    state.subtitleFetchState = "error";
    if (state.readingViewOpen) {
      renderReadingView();
    }
    setStatus(`抓取失败：${reason}。`);
    throw error;
  }
}

// Signed subtitle URLs expire quickly, so a failed track list is fetched again once.
async function retrySubtitleCandidates(preferred, runId) {
  const subtitleBundle = await retryAsync(() => fetchSubtitleBundle(), 2, 500);
  ensureRunActive(runId);
  state.subtitles = BocSites.rankTracks(subtitleBundle.tracks, subtitleLangTarget());
  state.chapters = BocSites.normalizeChapters(subtitleBundle.chapters);
  const retryPreferred = BocSites.pickPreferredTrack(state.subtitles, {
    previousId: preferred.id,
    previousUrl: preferred.url,
    previousLang: preferred.label || preferred.lang || ""
  });
  if (!retryPreferred) {
    throw new Error("字幕列表为空。");
  }
  return tryLoadSubtitleCandidates(buildSubtitleCandidates(state.subtitles, retryPreferred), runId);
}

// YouTube only: the watch page's transcript panel, tried after the subtitle
// tracks are rate-limited, all fail, or the video is gated. When it fails too
// the original `cause` is rethrown so its message (429, gate) reaches the user.
async function loadTranscriptFallback(cause, runId) {
  const site = currentSite();
  const ref = currentRef();
  if (!site?.fetchTranscript || !ref) {
    throw cause;
  }
  let result;
  try {
    result = await site.fetchTranscript(ref, siteIo());
  } catch (error) {
    logWarn("[BOC] transcript fallback failed", { cause: getErrorMessage(cause), error: getErrorMessage(error) });
    throw cause;
  }
  ensureRunActive(runId);
  state.subtitles = [result.track, ...state.subtitles.filter((item) => item.id !== result.track.id)];
  await commitSubtitleBody(result.segments, { url: result.track.url, lang: result.track.label, subtitleId: result.track.id }, runId);
  return result.track;
}

async function loadSubtitle(url, lang, runId = state.fetchRunId, subtitleId = "", forceRefresh = false) {
  if (!url) {
    throw new Error("字幕 URL 为空。");
  }

  const cacheKey = getSubtitleCacheKey({
    videoId: state.videoId,
    cid: state.cid,
    subtitleId,
    subtitleUrl: url,
    lang
  });

  // 尝试从缓存读取
  if (!forceRefresh) {
    const cachedBody = await loadSubtitleFromCache(cacheKey);
    if (cachedBody && Array.isArray(cachedBody) && cachedBody.length > 0) {
      const cachedCheck = validateSubtitleByDuration(cachedBody, state.videoDuration);
      if (!cachedCheck.ok) {
        logWarn("[BOC] cached subtitle duration mismatch, clearing cache", {
          cacheKey,
          reason: cachedCheck.reason
        });
        await clearSubtitleCacheByKey(cacheKey);
      } else {
        logInfo("[BOC] using cached subtitle", { cacheKey, itemCount: cachedBody.length });
        ensureRunActive(runId);
        state.selectedSubtitleId = subtitleId ? String(subtitleId) : state.selectedSubtitleId;
        state.selectedSubtitleUrl = url;
        state.selectedSubtitleLang = lang;
        state.subtitleBody = cachedBody;
        state.subtitleFetchState = "ready";
        await refreshDerivedContent();
        if (state.readingViewOpen) {
          renderReadingView();
          syncReadingViewPlayback(true);
        }
        return;
      }
    }
  }

  // 从网络获取
  logInfo("[BOC] fetch subtitle body", { url });
  const body = await currentSite().fetchSegments({ id: subtitleId, url, lang }, siteIo());
  await commitSubtitleBody(body, { url, lang, subtitleId }, runId);
}

// Validates, caches and installs a freshly fetched body as the selected track.
async function commitSubtitleBody(body, { url, lang, subtitleId }, runId) {
  const cacheKey = getSubtitleCacheKey({ videoId: state.videoId, cid: state.cid, subtitleId, subtitleUrl: url, lang });
  ensureRunActive(runId);
  if (body.length === 0) {
    throw new Error("字幕文件为空。");
  }
  const durationCheck = validateSubtitleByDuration(body, state.videoDuration);
  if (!durationCheck.ok) {
    const mismatchError = new Error("字幕时长与当前视频不匹配。");
    mismatchError.code = "SUBTITLE_DURATION_MISMATCH";
    mismatchError.details = durationCheck;
    throw mismatchError;
  }

  // 存入缓存
  await saveSubtitleToCache(cacheKey, body);

  state.selectedSubtitleId = subtitleId ? String(subtitleId) : state.selectedSubtitleId;
  state.selectedSubtitleUrl = url;
  state.selectedSubtitleLang = lang;
  state.subtitleBody = body;
  state.subtitleFetchState = "ready";
  await refreshDerivedContent();
  if (state.readingViewOpen) {
    renderReadingView();
    syncReadingViewPlayback(true);
  }
}

function getSubtitleCacheKey({ videoId, cid, subtitleId = "", subtitleUrl = "", lang = "" }) {
  const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
  return `${CACHE_KEY_PREFIX}${videoId}_${cid}_${sourceKey}`;
}

function buildSubtitleSourceKey(subtitleId, subtitleUrl, lang) {
  const id = String(subtitleId || "").trim();
  if (id) {
    return `id_${id}`;
  }

  const normalizedUrl = BocSites.trackUrlKey(subtitleUrl);
  if (normalizedUrl) {
    return `url_${normalizedUrl}`;
  }

  return `lang_${String(lang || "").trim().toLowerCase() || "unknown"}`;
}

async function loadSubtitleFromCache(cacheKey) {
  try {
    const result = await chrome.storage.local.get(cacheKey);
    return result[cacheKey]?.body || null;
  } catch {
    return null;
  }
}

// The cache only serves track switches on recent videos, so it keeps the newest
// 50 entries from the last 30 days.
async function saveSubtitleToCache(cacheKey, body) {
  try {
    const now = Date.now();
    await chrome.storage.local.set({ [cacheKey]: { body, timestamp: now } });
    const all = await chrome.storage.local.get(null);
    const stale = Object.entries(all)
      .filter(([key]) => key.startsWith(CACHE_KEY_PREFIX))
      .sort(([, a], [, b]) => (Number(b?.timestamp) || 0) - (Number(a?.timestamp) || 0))
      .filter(([, value], index) => index >= 50 || now - (Number(value?.timestamp) || 0) > 30 * 86400000)
      .map(([key]) => key);
    if (stale.length) {
      await chrome.storage.local.remove(stale);
    }
  } catch (error) {
    logWarn("[BOC] failed to save subtitle cache", error);
  }
}

async function clearSubtitleCacheByKey(cacheKey) {
  try {
    await chrome.storage.local.remove(cacheKey);
  } catch (error) {
    logWarn("[BOC] failed to clear subtitle cache by key", { cacheKey, error });
  }
}

function renderReadingSubtitleSelect() {
  renderSubtitleOptions(byId(ids.readingSubtitleSelect));
}

// Translated tracks already say 机器翻译 in their label.
function subtitleOptionLabel(item) {
  return `${item.label || item.lang || "unknown"}${{ ai: " [AI]", auto: " [自动]" }[item.kind] || ""}`;
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
    contentVersion: BOC_VERSION,
    site: currentSite()?.id || "",
    url: cleanVideoUrl(),
    title: state.title || "",
    author: state.author || "",
    uploadDate: state.uploadDate || "",
    tags: String(state.settings?.tags || ""),
    status: state.statusText || "",
    message: state.messageText || "",
    subtitlePreview: buildSubtitlePreview(state.subtitleBody || [], state.settings || DEFAULT_SETTINGS),
    markdown: state.markdown || "",
    srt: state.srt || "",
    txt: state.txt || "",
    downloadFormat: normalizeDownloadFormat(state.settings?.downloadFormat),
    subtitleOptions
  };
}

async function sendToObsidian() {
  state.settings = await getSettings();
  if (!state.settings.obsidianEnabled) {
    setMessage("Obsidian 写入未启用，请在设置的「进阶 2」中开启。");
    return;
  }
  await refreshDerivedContent();
  if (!state.markdown) {
    setMessage("没有可发送内容，请先刷新抓取。");
    return;
  }

  const filename = BocNote.buildNoteFilename(state, state.settings);
  const folder = BocNote.resolveFolderTemplate(state.settings.noteFolder || "", state);
  const filepath = folder ? `${folder}/${filename}` : filename;
  const baseUrl = String(state.settings.obsidianApiBaseUrl || "").trim();
  const apiKey = String(state.settings.obsidianApiKey || "").trim();
  if (!baseUrl || !apiKey) {
    setMessage("请先在设置中填写 Obsidian Local REST API 地址和 API Key。");
    requestOpenOptions();
    return;
  }

  try {
    const exists = await checkObsidianNoteExists(baseUrl, apiKey, filepath);
    if (exists) {
      const shouldOverwrite = await confirmOverwriteNote(filepath);
      if (!shouldOverwrite) {
        setMessage("已取消保存，原笔记未被覆盖。");
        return;
      }
    }
    await writeNoteByLocalApi(baseUrl, apiKey, filepath, state.markdown, { url: state.cover, name: `${state.site}-${state.videoId}` });
    setMessage(`已写入 Obsidian：${filepath}`);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      setMessage("扩展刚刚更新，请刷新当前页面后重试。");
      return;
    }
    setMessage(`写入失败：${getErrorMessage(error)}`);
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
    throw new Error(toReadableText(resp?.error, "Local API 检查失败"));
  }
  return Boolean(resp.exists);
}

async function writeNoteByLocalApi(baseUrl, apiKey, filepath, content, cover) {
  const resp = await sendRuntimeMessage({
    type: "write-obsidian-note",
    baseUrl,
    apiKey,
    filepath,
    content,
    cover
  });
  if (!resp?.ok) {
    throw new Error(toReadableText(resp?.error, "Local API 写入失败"));
  }
}

function confirmOverwriteNote(filepath) {
  return new Promise((resolve) => {
    const existing = document.querySelector(".boc-confirm-overlay");
    if (existing) {
      existing.remove();
    }

    const overlay = document.createElement("div");
    overlay.className = "boc-confirm-overlay";
    overlay.innerHTML = `
      <div class="boc-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="bocConfirmTitle">
        <div id="bocConfirmTitle" class="boc-confirm-title">该笔记已存在</div>
        <div class="boc-confirm-body">继续会覆盖原内容：</div>
        <div class="boc-confirm-path"></div>
        <div class="boc-confirm-actions">
          <button type="button" class="boc-confirm-cancel">取消</button>
          <button type="button" class="boc-confirm-primary">覆盖</button>
        </div>
      </div>
    `;
    overlay.querySelector(".boc-confirm-path").textContent = String(filepath || "");

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
    overlay.querySelector(".boc-confirm-cancel")?.addEventListener("click", () => cleanup(false));
    overlay.querySelector(".boc-confirm-primary")?.addEventListener("click", () => cleanup(true));
    document.addEventListener("keydown", onKeydown, true);
    document.body.appendChild(overlay);
    overlay.querySelector(".boc-confirm-primary")?.focus();
  });
}

function setStatus(text) {
  state.statusText = String(text || "");
}

function setMessage(text) {
  state.messageText = String(text || "");
}

// failure: why the subtitle fetch failed; empty when the video simply has no subtitles.
async function showNoSubtitleState(runId, failure = "") {
  const label = failure ? `字幕抓取失败：${failure}` : "当前视频无字幕";
  state.subtitleFailure = failure;
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
  setStatus(`${label}${failure ? "。" : "，"}正在读取评论...`);
  await refreshDerivedContent();
  ensureRunActive(runId);
  setStatus(failure ? `${label}。已保留视频信息，可导出简介与评论。` : `${label}，可导出简介与评论。`);
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
  const readingView = byId(ids.readingView);
  state.readingViewOpen = true;
  state.readingPlayerRetries = 0;
  document.body.setAttribute("data-boc-reading-active", "1");
  hydrateReaderStateFromSettings(state.settings);
  applyReadingViewPresentation();
  alignReaderViewportToPlayer();
  await sleep(0);
  openReaderViewShell(readingView);
  applyReaderPageFocus();
  renderReadingView();

  const earlyPlayerHost = findReaderPlayerHost(getRuntimeVideoElement());
  if (earlyPlayerHost) {
    earlyPlayerHost.setAttribute("data-boc-reader-fading", "1");
  }

  await sleep(0);

  // Try to mount player, with more retries for slower pages (like watch later)
  const mounted = await ensureReaderPlayerMounted({ retries: 50, delayMs: 150, forceLayout: true });
  const mountedPlayerHost = state.readingPlayerHost || earlyPlayerHost;
  if (mountedPlayerHost) {
    mountedPlayerHost.removeAttribute("data-boc-reader-fading");
  }
  if (!mounted) {
    // Don't throw - keep UI open and keep retrying in background
    setReadingNotice("正在等待视频播放器就绪...");
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
  const tryMount = async () => {
    state.readingPlayerRetryTimer = 0;
    if (!state.readingViewOpen || !isReaderMode()) return;
    state.readingPlayerRetries += 1;
    if (state.readingPlayerRetries > 12) {
      replaceReaderModeUrl(stripReaderModeUrl(location.href));
      closeReadingView();
      setReadingNotice("视频播放器长时间未就绪，已退出阅读视图，可刷新页面后重试。");
      return;
    }
    const mounted = await ensureReaderPlayerMounted({ retries: 10, delayMs: 200, forceLayout: true });
    const retryHost = state.readingPlayerHost;
    if (retryHost) {
      retryHost.removeAttribute("data-boc-reader-fading");
    }
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
  waitForVideoMetadata().then(() => {
    refreshClip().catch((error) => {
      if (!isStaleRunError(error)) {
        setReadingNotice(`字幕加载失败：${getErrorMessage(error)}`);
      }
    });
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
    setReadingNotice("正在等待视频播放器就绪...");
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
      activeHost.classList.add("boc-reader-player-host");
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
      logWarn("[BOC] ensure reader player mounted failed", error);
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
  state.readingViewOpen = false;
  state.readingViewReady = false;
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
  readingView.setAttribute("data-boc-reader-ready", "0");
  readingView.removeAttribute("data-boc-reader-follow");
  document.body.removeAttribute("data-boc-reading-active");
  document.documentElement.removeAttribute("data-boc-reader-mode");
  document.body.removeAttribute("data-boc-reader-mode");
  document.documentElement.removeAttribute("data-boc-reader-theme");
  document.documentElement.removeAttribute("data-boc-reader-font-scale");
  document.documentElement.removeAttribute("data-boc-reader-letter-spacing");
  document.documentElement.removeAttribute("data-boc-reader-line-height");
  document.documentElement.removeAttribute("data-boc-reader-content-width");
  document.documentElement.removeAttribute("data-boc-reader-chapter-visibility");
  document.documentElement.removeAttribute("data-boc-reader-has-chapters");
  document.body.removeAttribute("data-boc-reader-theme");
  document.body.removeAttribute("data-boc-reader-font-scale");
  document.body.removeAttribute("data-boc-reader-letter-spacing");
  document.body.removeAttribute("data-boc-reader-line-height");
  document.body.removeAttribute("data-boc-reader-content-width");
  document.body.removeAttribute("data-boc-reader-chapter-visibility");
  document.body.removeAttribute("data-boc-reader-has-chapters");
  restoreReadingMainInline();
  stopReadingViewSync();
  unbindReaderLayout();
  cleanupReaderPlayerHost();
  clearReaderPageFocus();
  const sendingBar = reader().sendingBar ? document.querySelector(reader().sendingBar) : null;
  if (sendingBar) {
    sendingBar.setAttribute("data-boc-reader-hide-sending-bar", "1");
    sendingBar.style.setProperty("display", "none", "important");
    window.setTimeout(() => {
      sendingBar.style.removeProperty("display");
      sendingBar.removeAttribute("data-boc-reader-hide-sending-bar");
    }, 200);
  }
  window.setTimeout(() => cleanupReaderFloatingArtifacts(), 40);
  window.setTimeout(() => cleanupReaderFloatingArtifacts(), 220);
}

function renderReadingView() {
  const titleNode = document.querySelector(".boc-reading-title");
  const metaNode = byId(ids.readingMeta);
  const chapterList = byId(ids.readingChapterList);
  const transcriptList = byId(ids.readingTranscriptList);
  const chapters = BocSites.normalizeChapters(state.chapters || []);
  const body = Array.isArray(state.subtitleBody) ? state.subtitleBody : [];
  const transcriptItems = getReadingTranscriptItems();
  const withHours = shouldShowHoursInNote(state, body);
  const hasChapters = chapters.length > 0;

  if (titleNode) {
    titleNode.textContent = state.title || "字幕阅读";
  }
  if (metaNode) {
    metaNode.textContent = buildReadingMetaLine();
  }

  if (chapters.length === 0) {
    chapterList.innerHTML = '<div class="boc-reading-empty">当前视频没有章节。</div>';
  } else {
    chapterList.innerHTML = chapters
      .map(
        (item, index) => `
          <button
            type="button"
            class="boc-reading-chapter"
            data-index="${index}"
            data-seconds="${Number(item.from || 0) || 0}"
          >
            <span class="boc-reading-chapter-time">${escapeHtml(
              formatCompactTimestamp(item.from, withHours)
            )}</span>
            <span class="boc-reading-chapter-title">${escapeHtml(item.title)}</span>
          </button>
        `
      )
      .join("");
  }

  if (transcriptItems.length === 0) {
    transcriptList.innerHTML = `<div class="boc-reading-empty">${escapeHtml(
      getReadingTranscriptPlaceholderText()
    )}</div>`;
  } else {
    transcriptList.innerHTML = transcriptItems
      .map(
        (item) => `
          <button
            type="button"
            class="boc-reading-item"
            data-index="${item.index}"
            data-seconds="${item.from}"
          >
            <span class="boc-reading-time">${escapeHtml(
              formatCompactTimestamp(item.from, withHours)
            )}</span>
            <span class="boc-reading-text">${escapeHtml(item.content)}</span>
          </button>
        `
      )
      .join("");
    transcriptList.insertAdjacentHTML(
      "beforeend",
      `<div id="${ids.readingTranscriptTailSpacer}" class="boc-reading-tail-spacer" aria-hidden="true"></div>`
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
  if (state.subtitleFetchState === "loading") {
    return "正在加载字幕...";
  }
  if (state.subtitleFetchState === "error") {
    return "字幕加载失败，请刷新重试。";
  }
  return state.subtitleFailure ? `字幕抓取失败：${state.subtitleFailure}。` : "当前视频无字幕。";
}

function getReadingTranscriptItems(body = state.subtitleBody) {
  return (Array.isArray(body) ? body : [])
    .map((item, index) => ({
      index,
      from: Number(item?.from || 0) || 0,
      to: Number(item?.to || 0) || 0,
      content: String(item?.content || "").trim()
    }))
    .filter((item) => item.content);
}

function updateReadingTranscriptTailSpacer() {
  const spacer = document.getElementById(ids.readingTranscriptTailSpacer);
  if (!spacer) {
    return;
  }
  const inlineHost = document.getElementById("boc-reading-inline-host");
  const transcriptList = document.getElementById(ids.readingTranscriptList);
  const hostHeight = inlineHost?.clientHeight || transcriptList?.clientHeight || 0;
  const spacerHeight = Math.max(hostHeight, Math.round(window.innerHeight * 0.92), 320);
  spacer.style.height = `${spacerHeight}px`;
}

function hydrateReaderStateFromSettings(settings = state.settings) {
  state.readingTheme = normalizeReaderTheme(settings?.readerTheme);
  state.readingFontScale = normalizeReaderFontScale(settings?.readerFontScale);
  state.readingLetterSpacing = normalizeReaderLetterSpacing(settings?.readerLetterSpacing ?? settings?.readerLineHeight);
  state.readingLineHeight = normalizeReaderLineHeight(settings?.readerLineHeight);
  state.readingContentWidth = normalizeReaderContentWidth(settings?.readerContentWidth);
  state.readingChapterVisible = settings?.readerChapterVisible !== undefined ? Boolean(settings.readerChapterVisible) : true;
  state.readingTranscriptVisible = normalizeReaderTranscriptVisible(settings?.readerTranscriptVisible);
}

function applyReadingViewPresentation() {
  const readingView = byId(ids.readingView);
  readingView.dataset.theme = state.readingTheme;
  readingView.dataset.fontScale = state.readingFontScale;
  readingView.dataset.letterSpacing = state.readingLetterSpacing;
  readingView.dataset.lineHeight = state.readingLineHeight;
  readingView.dataset.contentWidth = state.readingContentWidth;
  readingView.dataset.chapterVisibility = state.readingChapterVisible ? "auto" : "hide";
  readingView.dataset.transcriptVisible = state.readingTranscriptVisible ? "1" : "0";
  document.documentElement.dataset.bocReaderTheme = state.readingTheme;
  document.documentElement.dataset.bocReaderFontScale = state.readingFontScale;
  document.documentElement.dataset.bocReaderLetterSpacing = state.readingLetterSpacing;
  document.documentElement.dataset.bocReaderLineHeight = state.readingLineHeight;
  document.documentElement.dataset.bocReaderContentWidth = state.readingContentWidth;
  document.documentElement.dataset.bocReaderChapterVisibility = state.readingChapterVisible ? "auto" : "hide";
  document.documentElement.dataset.bocReaderTranscriptVisible = state.readingTranscriptVisible ? "1" : "0";
  document.body.dataset.bocReaderTheme = state.readingTheme;
  document.body.dataset.bocReaderFontScale = state.readingFontScale;
  document.body.dataset.bocReaderLetterSpacing = state.readingLetterSpacing;
  document.body.dataset.bocReaderLineHeight = state.readingLineHeight;
  document.body.dataset.bocReaderContentWidth = state.readingContentWidth;
  document.body.dataset.bocReaderChapterVisibility = state.readingChapterVisible ? "auto" : "hide";
  document.body.dataset.bocReaderTranscriptVisible = state.readingTranscriptVisible ? "1" : "0";
  const readingChapterVisibleEl = byId(ids.readingChapterVisible);
  if (readingChapterVisibleEl) {
    readingChapterVisibleEl.checked = state.readingChapterVisible;
  }
  const main = document.querySelector(".boc-reading-main");
  if (main) {
    main.style.display = state.readingTranscriptVisible ? "" : "none";
  }
  const inlineHost = document.getElementById("boc-reading-inline-host");
  if (inlineHost) {
    const leftContainer = document.querySelector(".left-container");
    const bgColor = leftContainer ? getComputedStyle(leftContainer).backgroundColor : "";
    if (state.readingTranscriptVisible) {
      inlineHost.style.border = "";
      inlineHost.style.background = "";
      inlineHost.style.marginTop = "";
      inlineHost.style.boxShadow = "";
      inlineHost.style.borderRadius = "";
    } else {
      inlineHost.style.border = "none";
      inlineHost.style.background = bgColor;
      inlineHost.style.marginTop = "0";
      inlineHost.style.boxShadow = "none";
      inlineHost.style.borderRadius = "0";
    }
  }
}

function updateReaderChapterPresence(hasChapters) {
  const value = hasChapters ? "1" : "0";
  const readingView = byId(ids.readingView);
  readingView.dataset.hasChapters = value;
  document.documentElement.dataset.bocReaderHasChapters = value;
  document.body.dataset.bocReaderHasChapters = value;
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
    <div id="${id}" class="boc-reading-stepper" data-reader-setting-id="${id}">
      <span class="boc-reading-stepper-title">${escapeHtml(title)}</span>
      <div class="boc-reading-stepper-buttons" role="group" aria-label="${escapeHtml(title)}">
        ${config.options
          .map(
            (option, index) => `
          <button
            type="button"
            class="boc-reading-stepper-btn"
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
  if (!node || node.dataset.bocBound === "1") {
    return;
  }

  node.addEventListener("click", (event) => {
    const button = event.target.closest("[data-value]");
    if (!button) {
      return;
    }
    setReaderPreference(settingKey, button.dataset.value || "");
  });
  node.dataset.bocBound = "1";
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
  byId(ids.readingTranscriptVisible).checked = state.readingTranscriptVisible;
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
      ? '<div class="boc-reading-empty">当前视频信息还未就绪。</div>'
      : summaryItems
          .map(
            (item) => `
              <div class="boc-reading-info-item">
                <span class="boc-reading-info-label">${escapeHtml(item.label)}</span>
                <span class="boc-reading-info-value">${escapeHtml(item.value)}</span>
              </div>
            `
          )
          .join("");

  if (!description) {
    descriptionNode.innerHTML = '<div class="boc-reading-empty">当前视频没有简介。</div>';
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
    descriptionBtn.textContent = state.readingDescriptionExpanded ? "收起简介" : "查看更多";
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
  state.readingTheme = normalizeReaderTheme(next.readerTheme ?? state.readingTheme);
  state.readingFontScale = normalizeReaderFontScale(next.readerFontScale ?? state.readingFontScale);
  state.readingLetterSpacing = normalizeReaderLetterSpacing(
    next.readerLetterSpacing ?? state.readingLetterSpacing
  );
  state.readingLineHeight = normalizeReaderLineHeight(next.readerLineHeight ?? state.readingLineHeight);
  state.readingContentWidth = normalizeReaderContentWidth(next.readerContentWidth ?? state.readingContentWidth);
  state.readingChapterVisible = next.readerChapterVisible !== undefined ? Boolean(next.readerChapterVisible) : state.readingChapterVisible;
  state.readingTranscriptVisible = normalizeReaderTranscriptVisible(
    next.readerTranscriptVisible ?? state.readingTranscriptVisible
  );
  state.settings = {
    ...state.settings,
    readerTheme: state.readingTheme,
    readerFontScale: state.readingFontScale,
    readerLetterSpacing: state.readingLetterSpacing,
    readerLineHeight: state.readingLineHeight,
    readerContentWidth: state.readingContentWidth,
    readerChapterVisible: state.readingChapterVisible,
    readerTranscriptVisible: state.readingTranscriptVisible
  };
  applyReadingViewPresentation();
  renderReaderPanels();
  if (persist) {
    persistReaderSettings();
  }
}

function persistReaderSettings() {
  sendRuntimeMessage({ type: "save-settings", settings: state.settings }).catch((error) => {
    logWarn("[BOC] failed to persist reader settings", error);
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
function setReadingNotice(text) {
  const notice = byId(ids.readingStatus);
  notice.textContent = text;
  notice.hidden = !text;
}

function setReadingViewReady(ready) {
  state.readingViewReady = Boolean(ready);
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  readingView.setAttribute("data-boc-reader-ready", state.readingViewReady ? "1" : "0");
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

  const readingView = byId(ids.readingView);
  const playerHost = state.readingPlayerHost;
  if (!playerHost) {
    return;
  }

  const rect = playerHost.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) {
    return;
  }

  const video = state.readingVideoEl;
  let renderedWidth = rect.width;
  let renderedHeight = rect.height;
  if (Number(video?.videoWidth) > 0 && Number(video?.videoHeight) > 0) {
    const aspectRatio = Number(video.videoWidth) / Number(video.videoHeight);
    if (aspectRatio > 0) {
      const hostAspectRatio = rect.width / rect.height;
      if (hostAspectRatio > aspectRatio) {
        renderedHeight = rect.height;
        renderedWidth = rect.height * aspectRatio;
      } else {
        renderedWidth = rect.width;
        renderedHeight = rect.width / aspectRatio;
      }
    }
  }

  const widthLimit = getReaderMainWidthLimit();
  if (renderedWidth > widthLimit) {
    const scale = widthLimit / renderedWidth;
    renderedWidth = widthLimit;
    renderedHeight *= scale;
  }

  clearNativeReaderFloatingStyles(playerHost);
  cleanupReaderPlayerHostNode(playerHost);
  readingView.style.setProperty("--boc-reader-player-rendered-width", `${Math.round(renderedWidth)}px`);
  readingView.style.setProperty("--boc-reader-player-rendered-height", `${Math.round(renderedHeight)}px`);
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
  playerHost.classList.remove("boc-reader-player-host");
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
  const readingView = byId(ids.readingView);
  readingView?.style.removeProperty("--boc-reader-player-rendered-width");
  readingView?.style.removeProperty("--boc-reader-player-rendered-height");
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
  if (state.readingVideoEl && state.readingVideoEl.__bocReadingSyncHandler) {
    const video = state.readingVideoEl;
    video.removeEventListener("timeupdate", video.__bocReadingSyncHandler);
    video.removeEventListener("seeked", video.__bocReadingSyncHandler);
    video.removeEventListener("loadedmetadata", video.__bocReadingSyncHandler);
    delete video.__bocReadingSyncHandler;
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
      if (nextVideo && nextHost && (nextVideo !== state.readingVideoEl || nextHost !== state.readingPlayerHost)) {
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
    if (state.readingVideoEl && state.readingVideoEl.__bocReadingSyncHandler) {
      const prev = state.readingVideoEl;
      prev.removeEventListener("timeupdate", prev.__bocReadingSyncHandler);
      prev.removeEventListener("seeked", prev.__bocReadingSyncHandler);
      prev.removeEventListener("loadedmetadata", prev.__bocReadingSyncHandler);
      delete prev.__bocReadingSyncHandler;
    }
    state.readingVideoEl = null;
    state.readingVideoEventsBound = false;
    return null;
  }

  if (state.readingVideoEl === video && state.readingVideoEventsBound) {
    return video;
  }

  if (state.readingVideoEl && state.readingVideoEl.__bocReadingSyncHandler) {
    const prev = state.readingVideoEl;
    prev.removeEventListener("timeupdate", prev.__bocReadingSyncHandler);
    prev.removeEventListener("seeked", prev.__bocReadingSyncHandler);
    prev.removeEventListener("loadedmetadata", prev.__bocReadingSyncHandler);
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
  video.__bocReadingSyncHandler = syncHandler;
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
    "[data-boc-reader-hidden='1']",
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
  const keepRoots = [root, playerHost, titleNode].filter(Boolean);

  keepRoots.forEach((node) => {
    markReaderKeepSubtree(node);
    markReaderKeepPath(node);
  });

  const keepNodes = Array.from(document.querySelectorAll("[data-boc-reader-keep='1']"));
  keepNodes.forEach((parent) => {
    Array.from(parent.children || []).forEach((child) => {
      if (child.id === ids.root) {
        return;
      }
      if (!child.hasAttribute("data-boc-reader-keep")) {
        child.setAttribute("data-boc-reader-hidden", "1");
      }
    });
  });

  pruneReaderNonKeepBranches(document.body);
  hideReaderNoiseNodes(keepRoots);
}

function clearReaderPageFocus() {
  document.querySelectorAll("[data-boc-reader-keep]").forEach((node) => {
    node.removeAttribute("data-boc-reader-keep");
  });
  document.querySelectorAll("[data-boc-reader-hidden]").forEach((node) => {
    node.removeAttribute("data-boc-reader-hidden");
  });
}

function moveReadingMainInline() {
  if (!isReaderMode()) {
    return;
  }

  const readingMain = document.querySelector(".boc-reading-main");
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

  let inlineHost = document.getElementById("boc-reading-inline-host");
  if (!inlineHost) {
    inlineHost = document.createElement("div");
    inlineHost.id = "boc-reading-inline-host";
  }

  if (inlineHost.parentElement !== hostParent || inlineHost.previousElementSibling !== playerWrap) {
    playerWrap.insertAdjacentElement("afterend", inlineHost);
  }

  if (!inlineHost.dataset.bocScrollBound) {
    const handleInlineHostManualScroll = () => {
      if (Date.now() <= state.readingProgrammaticScrollUntil) {
        return;
      }
      noteManualReaderInteraction();
    };
    inlineHost.addEventListener("scroll", handleInlineHostManualScroll);
    inlineHost.addEventListener("wheel", handleInlineHostManualScroll, { passive: true });
    inlineHost.dataset.bocScrollBound = "1";
  }

  if (readingMain.parentElement !== inlineHost) {
    inlineHost.appendChild(readingMain);
  }
  const leftContainer = document.querySelector(".left-container");
  const bgColor = leftContainer ? getComputedStyle(leftContainer).backgroundColor : "";
  if (state.readingTranscriptVisible) {
    inlineHost.style.border = "";
    inlineHost.style.background = "";
    inlineHost.style.marginTop = "";
    inlineHost.style.boxShadow = "";
    inlineHost.style.borderRadius = "";
  } else {
    inlineHost.style.border = "none";
    inlineHost.style.background = bgColor;
    inlineHost.style.marginTop = "0";
    inlineHost.style.boxShadow = "none";
    inlineHost.style.borderRadius = "0";
  }
  updateReadingTranscriptTailSpacer();
}

function restoreReadingMainInline() {
  const readingMain = document.querySelector(".boc-reading-main");
  const inlineHost = document.getElementById("boc-reading-inline-host");
  if (readingMain && state.readingMainOriginalParent) {
    if (state.readingMainOriginalNextSibling?.parentNode === state.readingMainOriginalParent) {
      state.readingMainOriginalParent.insertBefore(readingMain, state.readingMainOriginalNextSibling);
    } else {
      state.readingMainOriginalParent.appendChild(readingMain);
    }
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
    const childHasKeep = child.hasAttribute("data-boc-reader-keep");
    const childContainsKeep = Boolean(child.querySelector?.("[data-boc-reader-keep='1']"));
    if (!childHasKeep && !childContainsKeep) {
      child.setAttribute("data-boc-reader-hidden", "1");
      return;
    }
    pruneReaderNonKeepBranches(child);
  });
}

function hideReaderNoiseNodes(keepRoots = []) {
  const keepSet = new Set(keepRoots.filter(Boolean));
  const keepSelector = sel([...reader().keepRoots, "#boc-root"]);
  document.querySelectorAll(sel(reader().noise)).forEach((node) => {
    if (Array.from(keepSet).some((keepNode) => keepNode === node || node.contains(keepNode))) {
      return;
    }
    if (node.closest(keepSelector)) {
      return;
    }
    node.setAttribute("data-boc-reader-hidden", "1");
    const card = node.closest(sel(reader().cards));
    if (card && !card.closest(keepSelector)) {
      card.setAttribute("data-boc-reader-hidden", "1");
    }
  });
}

function markReaderKeepSubtree(node) {
  if (!node) {
    return;
  }
  node.setAttribute("data-boc-reader-keep", "1");
  node.querySelectorAll("*").forEach((child) => {
    child.setAttribute("data-boc-reader-keep", "1");
  });
}

function markReaderKeepPath(node) {
  let current = node;
  while (current && current !== document.body) {
    current.setAttribute("data-boc-reader-keep", "1");
    current = current.parentElement;
  }
  document.body.setAttribute("data-boc-reader-keep", "1");
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
        logWarn("[BOC] queued reader controls recovery failed", { reason, error });
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
      node.setAttribute("data-boc-reader-controls-forced", "1");
      return;
    }

    if (node.getAttribute("data-boc-reader-controls-forced") === "1") {
      node.style.removeProperty("display");
      node.removeAttribute("data-boc-reader-controls-forced");
    }
  });

  const noCursorClass = reader().noCursorClass;
  if (!noCursorClass) {
    return;
  }
  if (visible) {
    if (playerHost.classList.contains(noCursorClass)) {
      playerHost.classList.remove(noCursorClass);
      playerHost.setAttribute("data-boc-reader-no-cursor-cleared", "1");
    }
    return;
  }

  if (playerHost.getAttribute("data-boc-reader-no-cursor-cleared") === "1") {
    playerHost.classList.add(noCursorClass);
    playerHost.removeAttribute("data-boc-reader-no-cursor-cleared");
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
  logInfo("[BOC] reader controls check", {
    reason,
    hostClassName: typeof playerHost.className === "string" ? playerHost.className : "",
    hostHasNoCursor: before.hostHasNoCursor,
    controlRootFound: before.controlRootFound,
    controls: before.nodes
  });

  if (!hasReaderPlayerControlsIssue(playerHost)) {
    return false;
  }

  logInfo("[BOC] recovering normal reader controls", {
    reason,
    hostClassName: typeof playerHost.className === "string" ? playerHost.className : ""
  });
  setReaderPlayerControlsVisible(true, playerHost);
  layoutReaderPlayerHost();

  let after = getReaderPlayerControlsState(playerHost);
  logInfo("[BOC] reader controls after recovery", {
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
  logInfo("[BOC] retrying normal reader controls recovery", {
    reason,
    hostClassName: typeof playerHost.className === "string" ? playerHost.className : ""
  });
  setReaderPlayerControlsVisible(true, playerHost);
  layoutReaderPlayerHost();
  after = getReaderPlayerControlsState(playerHost);
  logInfo("[BOC] reader controls after retry", {
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
  if (playerHost.__bocReaderControlsHoverBound) {
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
  playerHost.__bocReaderControlsHoverBound = { showControls, hideControls };
  state.readingControlsHoverHost = playerHost;
}

function unbindReaderPlayerControlsHover() {
  const playerHost = state.readingControlsHoverHost;
  if (state.readingControlsHideTimer) {
    window.clearTimeout(state.readingControlsHideTimer);
    state.readingControlsHideTimer = 0;
  }
  if (!playerHost?.__bocReaderControlsHoverBound) {
    state.readingControlsHoverHost = null;
    return;
  }

  const { showControls, hideControls } = playerHost.__bocReaderControlsHoverBound;
  playerHost.removeEventListener("mouseenter", showControls, true);
  playerHost.removeEventListener("mousemove", showControls, true);
  playerHost.removeEventListener("mouseleave", hideControls, true);
  delete playerHost.__bocReaderControlsHoverBound;
  setReaderPlayerControlsVisible(false, playerHost);
  state.readingControlsHoverHost = null;
}

function setReaderHeaderActionsVisible(visible) {
  const actions = document.querySelector(".boc-reading-actions");
  if (!actions) {
    return;
  }
  if (visible) {
    actions.removeAttribute("data-boc-icon-hidden");
    return;
  }
  actions.setAttribute("data-boc-icon-hidden", "1");
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
  const header = document.querySelector(".boc-reading-header");
  if (!header || header.__bocReaderHeaderHoverBound) {
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

  header.addEventListener("mouseenter", showActions, true);
  header.addEventListener("mouseleave", hideActionsLater, true);
  header.__bocReaderHeaderHoverBound = { showActions, hideActionsLater };
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
  if (!header?.__bocReaderHeaderHoverBound) {
    state.readingHeaderHoverHost = null;
    return;
  }
  const { showActions, hideActionsLater } = header.__bocReaderHeaderHoverBound;
  header.removeEventListener("mouseenter", showActions, true);
  header.removeEventListener("mouseleave", hideActionsLater, true);
  delete header.__bocReaderHeaderHoverBound;
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
  const existing = document.getElementById("boc-player-ai-quick-action");
  const existingWrap = existing?.closest(".boc-player-ai-wrap");
  if (!state.settings?.enablePlayerAiQuickAction || state.readingViewOpen || isReaderMode()) {
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
    wrap.className = "boc-player-ai-wrap";
    wrap.setAttribute("data-boc-extension-node", "ai-quick-action");
  }
  if (!button) {
    button = document.createElement("button");
    button.id = "boc-player-ai-quick-action";
    button.type = "button";
    button.className = "boc-player-ai-quick-action";
    button.title = "用 AI 分析这期视频";
    button.setAttribute("aria-label", "用 AI 分析这期视频");
    button.innerHTML = buildPlayerAiQuickActionIconSvg();
    button.addEventListener("click", handlePlayerAiQuickActionClick, true);
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
  if (state.playerAiQuickActionRevealTimer) {
    window.clearTimeout(state.playerAiQuickActionRevealTimer);
    state.playerAiQuickActionRevealTimer = 0;
  }
  if (state.playerAiQuickActionHideTimer) {
    window.clearTimeout(state.playerAiQuickActionHideTimer);
    state.playerAiQuickActionHideTimer = 0;
  }
  if (state.playerAiQuickActionCursorHideTimer) {
    window.clearTimeout(state.playerAiQuickActionCursorHideTimer);
    state.playerAiQuickActionCursorHideTimer = 0;
  }
  document.getElementById("boc-player-ai-quick-action")?.closest(".boc-player-ai-wrap")?.remove();
}

function bindPlayerAiQuickActionCursorSync(wrap) {
  if (!(wrap instanceof HTMLElement)) {
    return;
  }
  const host = wrap.parentElement instanceof HTMLElement ? wrap.parentElement : null;
  if (!host || wrap.__bocPlayerAiCursorHost === host) {
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
  wrap.__bocPlayerAiCursorHost = host;
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
    node.style.setProperty("--boc-player-ai-action-hit-size", `${hitSize}px`);
    node.style.setProperty("--boc-player-ai-action-color", baseColor);
    node.style.setProperty("--boc-player-ai-action-hover-color", baseColor);
  });
  button.style.setProperty("--boc-player-ai-action-icon-size", `${iconSize}px`);
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
      throw new Error("AI 按钮未开启");
    }
    const resp = await sendRuntimeMessage({ type: "player-ai-quick-action" });
    if (!resp?.ok) {
      throw new Error(resp?.error || "打开 AI 侧边栏失败");
    }
    setMessage("已打开 AI 侧边栏并发送快捷提示词。");
  } catch (error) {
    setMessage(`AI 快捷操作失败：${getErrorMessage(error)}`);
  } finally {
    state.playerAiQuickActionSubmitting = false;
    if (button) {
      button.disabled = false;
    }
  }
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
      current.setAttribute("data-boc-reader-player-reset", "1");
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
    node.removeAttribute("data-boc-reader-player-reset");
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
  const chapters = BocSites.normalizeChapters(state.chapters || []);
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
  const currentTranscript = transcriptList.querySelector(".boc-reading-item.is-active");
  const currentChapter = chapterList.querySelector(".boc-reading-chapter.is-active");

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
  const inlineHost = document.getElementById("boc-reading-inline-host");
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

  const nextTime = Math.max(0, Number(seconds || 0) || 0);
  state.readingManualScrollPauseUntil = 0;
  state.readingNextScrollBehavior = "auto";
  updateReaderFollowState();
  video.currentTime = nextTime;
  if (video.paused) {
    video.play().catch(() => {});
  }
  syncReadingViewPlayback(true);
}

function onReadingChapterClick(event) {
  const target = event.target.closest(".boc-reading-chapter");
  if (!target) {
    return;
  }
  jumpReadingTarget(target.dataset.seconds);
}

function onReadingTranscriptClick(event) {
  const target = event.target.closest(".boc-reading-item");
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
  const mode =
    !state.readingAutoScroll ? "off" : Date.now() < state.readingManualScrollPauseUntil ? "manual" : "auto";
  if (readingView.getAttribute("data-boc-reader-follow") !== mode) {
    readingView.setAttribute("data-boc-reader-follow", mode);
  }
}

function computeCurrentClipSignature(url = location.href) {
  const ref = BocSites.parseRef(url);
  return ref ? [ref.site, ref.id, ref.part?.index || 1, ref.part?.oid || ""].join("|") : "";
}

// The language setting is YouTube's only; Bilibili keeps the default order.
function subtitleLangTarget() {
  return state.site === "youtube" ? BocSites.normalizeSubtitleLang(state.settings?.youtubeSubtitleLang) : "auto";
}

function currentSite() {
  return BocSites.matchSite(location.href);
}

function reader() {
  return (currentSite() || BocSites.SITES.bilibili).reader;
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
// content script shares the document's performance timeline, so an earlier
// request is read from it; otherwise captions are toggled (off and on, or on
// and off) until the player fires one, and the button is left as found.
// The token goes nowhere but youtube.com timedtext URLs.
async function ytCapturePot(videoId) {
  const found = () => BocSites.ytPotFromUrls(performance.getEntriesByType("resource").map((entry) => entry.name), videoId);
  let pot = found();
  const button = document.querySelector("#movie_player .ytp-subtitles-button");
  if (pot || !button) {
    return pot;
  }
  const seen = [];
  const observer = new PerformanceObserver((list) => list.getEntries().forEach((entry) => seen.push(entry.name)));
  observer.observe({ type: "resource" });
  let clicks = 0;
  try {
    while (!pot && clicks < 2) {
      button.click();
      clicks += 1;
      for (let waited = 0; !pot && waited < 5000; waited += 250) {
        await sleep(250);
        pot = BocSites.ytPotFromUrls(seen, videoId);
      }
    }
  } finally {
    observer.disconnect();
    if (clicks % 2 === 1) {
      button.click();
    }
  }
  logInfo("[BOC] youtube pot capture", { clicks, found: Boolean(pot) });
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
  return BocSites.cleanUrl(href);
}

async function fetchSubtitleBundle() {
  const site = currentSite();
  const ref = currentRef();
  if (!site || !ref) {
    throw new Error("当前页面不是支持的视频地址。");
  }
  const bundle = await site.fetchTracks(ref, state.meta, siteIo());
  const chapters = bundle.chapters?.length
    ? bundle.chapters
    : BocSites.parseChaptersFromDescription(state.description);
  return { tracks: bundle.tracks, chapters };
}

async function fetchHotComments(count = 20) {
  const site = currentSite();
  const ref = currentRef();
  if (!site?.fetchComments || !ref) {
    return [];
  }
  return site.fetchComments(ref, state.meta, siteIo(), count);
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
  } catch {
    // ignore
  }
  const text = String(value);
  if (!text || text === "[object Object]") {
    return fallback;
  }
  return text;
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

function isExtensionContextInvalidated(error) {
  const msg = String(error?.message || "");
  return msg.includes("Extension context invalidated");
}

function requestOpenOptions() {
  sendRuntimeMessage({ type: "open-options" })
    .then((resp) => {
      if (!resp?.ok) {
        setMessage(`打开设置失败：${toReadableText(resp?.error, "未知错误")}`);
      }
    })
    .catch((error) => {
      if (isExtensionContextInvalidated(error)) {
        setMessage("扩展刚刚更新，请刷新当前页面后重试。");
        return;
      }
      setMessage(`打开设置失败：${getErrorMessage(error)}`);
    });
}

async function getSettings() {
  try {
    const response = await sendRuntimeMessage({ type: "get-settings" });
    if (!response?.ok) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...(response.settings || {}) };
  } catch (error) {
    return { ...DEFAULT_SETTINGS };
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

function isStaleRunError(error) {
  return error?.code === "STALE_RUN";
}

async function retryAsync(task, retries = 1, delayMs = 180) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      // 如果不是网络错误也不是可重试的业务错误，立即抛出
      const isNetworkError = isRetryableNetworkError(error);
      const isRetryable = error?.retryable === true;
      if (!isNetworkError && !isRetryable) {
        throw error;
      }
      if (attempt >= retries) {
        throw error;
      }
      // 指数退避：delayMs * 2^(attempt-1)，最多等待 5 秒
      const backoffDelay = Math.min(delayMs * Math.pow(2, attempt - 1), 5000);
      logInfo(`[BOC] retrying after ${backoffDelay}ms, attempt ${attempt + 1}/${retries}`, {
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

function buildSubtitleCandidates(subtitles, preferred) {
  const tracks = subtitles || [];
  const seen = new Set();
  const list = [];

  const pushUnique = (item) => {
    if (!item) {
      return;
    }
    const key =
      `${String(item.id || "").trim()}|` +
      `${BocSites.trackUrlKey(item.url)}|` +
      `${String(item.lang || "").trim().toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    list.push(item);
  };

  pushUnique(preferred);
  for (const item of tracks) {
    pushUnique(item);
  }
  return list;
}

// A refresh always goes to the network so an old cache entry cannot misalign the subtitles.
async function tryLoadSubtitleCandidates(candidates, runId) {
  let lastError = null;
  let backedOff = false;
  for (const item of candidates || []) {
    try {
      logInfo("[BOC] try subtitle track", {
        id: item.id,
        lang: item.lang,
        label: item.label,
        kind: item.kind,
        url: item.url
      });
      const load = () => loadSubtitle(item.url, item.label || item.lang || "unknown", runId, item.id, true);
      try {
        await load();
      } catch (error) {
        // A short burst often clears after a few seconds; one backed-off retry, then stop.
        if (error?.status !== 429 || backedOff) {
          throw error;
        }
        backedOff = true;
        await sleep(3000 + Math.random() * 2000);
        ensureRunActive(runId);
        await load();
      }
      return item;
    } catch (error) {
      // Every track hits the same endpoint, so trying the rest only extends the rate limit.
      if (error?.status === 429) {
        const limited = new Error("字幕接口限流（429），稍后再试");
        limited.status = 429;
        throw limited;
      }
      lastError = error;
      const reasonCode = toReadableText(error?.code, "");
      const reasonMessage = getErrorMessage(error, "unknown");
      const meta = {
        id: item.id,
        lang: item.lang,
        label: item.label,
        reason: reasonCode || reasonMessage
      };
      if (reasonCode === "SUBTITLE_DURATION_MISMATCH") {
        logInfo(`[BOC] subtitle track skipped ${JSON.stringify(meta)}`);
      } else {
        logWarn(`[BOC] subtitle track rejected ${JSON.stringify(meta)}`);
      }
      ensureRunActive(runId);
      continue;
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("这个视频暂时没有可用字幕。");
}

function validateSubtitleByDuration(body, videoDuration) {
  const duration = Number(videoDuration || 0);
  if (!Array.isArray(body) || body.length === 0) {
    return { ok: false, reason: "empty", videoDuration: duration, maxTo: 0 };
  }

  let maxTo = 0;
  for (const item of body) {
    const to = Number(item?.to);
    const from = Number(item?.from);
    if (Number.isFinite(to) && to > maxTo) {
      maxTo = to;
    }
    if (Number.isFinite(from) && from > maxTo) {
      maxTo = from;
    }
  }

  if (!(duration > 0)) {
    return { ok: true, reason: "skip-no-video-duration", videoDuration: duration, maxTo };
  }

  const upperTolerance = Math.max(12, duration * 0.15);
  if (maxTo > duration + upperTolerance) {
    return { ok: false, reason: "too-long", videoDuration: duration, maxTo };
  }

  let minCoverageRatio = 0;
  if (duration >= 600) {
    minCoverageRatio = 0.18;
  } else if (duration >= 300) {
    minCoverageRatio = 0.22;
  } else if (duration >= 180) {
    minCoverageRatio = 0.25;
  }

  if (minCoverageRatio > 0 && maxTo < duration * minCoverageRatio) {
    return { ok: false, reason: "too-short", videoDuration: duration, maxTo };
  }

  return { ok: true, reason: "ok", videoDuration: duration, maxTo };
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
    if (isExtensionContextInvalidated(error)) {
      throw new Error("扩展刚刚更新，请刷新当前页面后重试。");
    }
    throw error;
  }
}

function rebuildDerivedContent() {
  const body = Array.isArray(state.subtitleBody) ? state.subtitleBody : [];
  state.markdown = body.length || state.subtitleFetchState === "empty" ? BocNote.buildMarkdown(state, body, state.settings, currentRef()) : "";
  state.srt = body.length ? buildSrt(body) : "";
  state.txt = body.length ? buildTxt(body, state.settings) : "";
}

// Without subtitles the comments are most of the note, so they are fetched
// regardless of includeHotCommentsInNote.
async function refreshDerivedContent({ refreshComments = false } = {}) {
  if (state.settings?.includeHotCommentsInNote || state.subtitleFetchState === "empty") {
    const shouldFetchComments =
      refreshComments || !Array.isArray(state.hotComments) || state.hotComments.length === 0;
    if (shouldFetchComments) {
      try {
        state.hotComments = await fetchHotComments(20);
      } catch (error) {
        state.hotComments = [];
        logWarn("[BOC] failed to fetch hot comments for note export", error);
      }
    }
  }

  rebuildDerivedContent();
}

function normalizeDownloadFormat(value) {
  return value === "txt" ? "txt" : "srt";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
}
