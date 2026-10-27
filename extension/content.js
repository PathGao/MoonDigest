// background.js re-injects this file when its version probe misses
// (e.g. mid-navigation). A repeat run must be a no-op, and top-level const would
// throw on redeclaration, so the body sits in this block.
// Bilibili video pages load this in every frame; a subframe only runs it when viewer-frame.js (document_start)
// marked it as 分拣台's viewer. Bilibili iframes on other sites stay inert.
if (!globalThis.__MDG_CONTENT_SCRIPT_LOADED__ && (window === window.top || document.documentElement.hasAttribute("data-mdg-viewer"))) {
// The settings until get-settings answers (and if it never does); the background owns the stored settings.
const DEFAULT_SETTINGS = { ...MdgSettings.DEFAULTS, ...MdgSettings.LOCAL_DEFAULTS };
const { formatCompactTimestamp, buildSubtitlePreview, buildSrt, buildTxt, shouldShowHoursInNote, subtitleMismatchWarning } = MdgNote;
const { sleep } = MdgCommon;
const { escapeHtml } = MdgErrors;

const MDG_VERSION = chrome.runtime.getManifest().version;
// In 分拣台's viewer the tab is 分拣台 itself: the side panel takes the video by reference, not from the tab.
const IN_VIEWER = window !== window.top;
// A subtitle picked from a list the page has since replaced with another video's.
const VIDEO_SWITCHED = `视频已切换，${MdgErrors.TEXT.reloadRetry}`;
// A jump to a time point (the side panel, 专注模式) on a page without a player to drive.
const NO_PLAYER = "当前页面没有找到可联动的视频播放器。";
globalThis.__MDG_CONTENT_SCRIPT_LOADED__ = MDG_VERSION;
// The popup's status line before a read: on load, and after a video change cleared the last video's.
const STATUS_READY = "准备就绪，点击「刷新」开始。";
// The video page's reads: a video change ends the run in flight, so nothing waiting on it writes the new video's state.
const clipRuns = MdgCommon.latest();
// Focus mode's entries: an entry or a close (stepReader) ends the run, so a closed entry's late steps stop.
const readerRuns = MdgCommon.latest();
const state = {
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
  // The failed read's code (subtitleFetchState error): B站's -404 says the video is gone, and MdgErrors.remedies whether 重试 helps.
  readCode: "",
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
  readingTheme: DEFAULT_SETTINGS.readerTheme,
  readingFontScale: DEFAULT_SETTINGS.readerFontScale,
  readingLetterSpacing: DEFAULT_SETTINGS.readerLetterSpacing,
  readingLineHeight: DEFAULT_SETTINGS.readerLineHeight,
  readingContentWidth: DEFAULT_SETTINGS.readerContentWidth,
  readingChapterVisible: DEFAULT_SETTINGS.readerChapterVisible,
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
  playerAiQuickActionObserver: null,
  playerAiQuickActionSyncTimer: 0,
  playerAiQuickActionCursorHideTimer: 0,
  playerAiQuickActionSubmitting: false,
  playerAiQuickActionSuppressedUntil: 0,
  readingFollowPaused: false,
  readingLastInputAt: 0,
  readingProgrammaticScrollUntil: 0,
  statusText: STATUS_READY,
  // The popup shows statusText red while this is true: a read that failed, or a settled read with a failed part.
  statusError: false,
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
    readerRuns.next();
  }
  return true;
}

function hasReaderParam(url) {
  try {
    return new URL(url).searchParams.get(MdgCommon.READER_PARAM) === "1";
  } catch {
    return false;
  }
}

// The navigation entry keeps the URL the document loaded with after the rewrite. Only the first copy of this script
// takes it (marked on <html>, which every copy sees): a copy injected later, after an extension update, must not
// reopen focus mode the user has left, or open it on the video YouTube navigated to since.
function readerEntryRequested() {
  const root = document.documentElement;
  const loadedWith = !root.hasAttribute("data-mdg-reader-entry-taken") && hasReaderParam(performance.getEntriesByType("navigation")[0]?.name);
  root.setAttribute("data-mdg-reader-entry-taken", "1");
  return hasReaderParam(location.href) || loadedWith;
}

function stripReaderModeUrl(url = location.href) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete(MdgCommon.READER_PARAM);
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

  // The clip signature stays: it ignores mdg_reader, and a video change the URL watcher has not seen yet must still
  // look like one to it.
  try {
    history.replaceState(history.state, "", targetUrl);
  } catch (error) {
    logWarn("[MDG] failed to replace reader mode url", error);
  }
}

// The playlist player: 稍后再看 (/list/watchlater), a 收藏夹 or 合集 played through (/list/ml…).
function isListPlayerPage(url = location.href) {
  try {
    return new URL(url).pathname.startsWith("/list/");
  } catch {
    return false;
  }
}

// Mirrors --mdg-reader-side-width in content.css, whose per-width maximum (--mdg-reader-side-max) it reads; 0 below
// 900px, where the transcript sits under the video.
function getReaderSideWidthPx() {
  if (window.innerWidth <= 900) {
    return 0;
  }
  const max = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--mdg-reader-side-max")) || 440;
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

  targets.forEach(clearReaderPlacement);
}

// The inline placement a site's floating player leaves on a node, which focus mode lays out itself.
const READER_PLACEMENT_PROPS = ["position", "inset", "left", "top", "right", "bottom", "transform", "width", "height", "max-width", "max-height", "margin", "z-index"];
function clearReaderPlacement(node) {
  READER_PLACEMENT_PROPS.forEach((prop) => node.style.removeProperty(prop));
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
  return state.settings.enableDebugLogs;
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
  readingFollowResumeBtn: "mdg-reading-follow-resume",
  readingTranscriptTailSpacer: "mdg-reading-tail-spacer",
  // In the page's DOM, next to its player: the transcript column focus mode moves there.
  readingInlineHost: "mdg-reading-inline-host",
  // Above the player of a page without a title of its own (番剧, 活动页).
  readingPageTitle: "mdg-reading-page-title"
};

// Focus mode's attributes on <html> and <body>: set while it is open, cleared together on close and by the guard.
const READER_MODE = "data-mdg-reader-mode";
const READER_PAGE_ATTRS = [READER_MODE, "data-mdg-reader-theme", "data-mdg-reader-font-scale", "data-mdg-reader-letter-spacing", "data-mdg-reader-line-height", "data-mdg-reader-content-width", "data-mdg-reader-chapter-visibility", "data-mdg-reader-has-chapters"];
const READING_ACTIVE = "data-mdg-reading-active";
// Page nodes focus mode keeps (and their path to <body>) and the ones it hides; content.css keys on both.
const READER_KEEP = "data-mdg-reader-keep";
const READER_HIDDEN = "data-mdg-reader-hidden";
// A player host hidden until it is mounted (content.css).
const READER_FADING = "data-mdg-reader-fading";
const AI_SUMMARY = MdgErrors.LABEL.aiSummary;
const READER_NAME = MdgErrors.LABEL.readingView;
const PLAYER_WAIT = "正在等待视频播放器就绪…";
const META_READING = MdgErrors.TEXT.videoReading;
// A subtitle track without a label or language, in the dropdown and focus mode's info line.
const UNNAMED_SUBTITLE = "未命名字幕";
// How long the reader leaves the transcript alone, the playing line in view, before following resumes by itself.
const READER_FOLLOW_IDLE_MS = 1000;
// Between two tries to mount the player after focus mode opened without one.
const PLAYER_RETRY_MS = 500;
// How long after navigation focus mode waits for the page to be hydrated (pageHydrating).
const HYDRATE_WAIT_MS = 10000;
// Smaller than this is a thumbnail or a preview, not the player.
const MIN_PLAYER = { width: 240, height: 120 };
// The appearance settings focus mode changes itself; a change to them does not touch the note.
const { READER_KEYS } = MdgSettings;
// 排版's steppers in the settings panel, in order: the control's id, its name, the setting it changes (its values are
// MdgSettings.READER_OPTIONS[settingKey]), where state keeps it, and each value's name.
const READER_STEPPERS = [
  { id: ids.readingFontScaleSelect, title: "字号", settingKey: "readerFontScale", stateKey: "readingFontScale", labels: { xs: "最小", s: "偏小", m: "标准", l: "偏大", xl: "最大" } },
  { id: ids.readingLetterSpacingSelect, title: "字间距", settingKey: "readerLetterSpacing", stateKey: "readingLetterSpacing", labels: { tighter: "最紧", tight: "偏紧", normal: "标准", relaxed: "偏松", loose: "最松" } },
  { id: ids.readingLineHeightSelect, title: "行间距", settingKey: "readerLineHeight", stateKey: "readingLineHeight", labels: { compact: "最紧", tight: "偏紧", normal: "标准", relaxed: "偏松", loose: "最松" } },
  { id: ids.readingContentWidthSelect, title: "字幕栏宽度", settingKey: "readerContentWidth", stateKey: "readingContentWidth", labels: { compact: "最窄", narrow: "偏窄", medium: "标准", wide: "偏宽", full: "最宽" } }
];
const readerStepper = (settingKey) => READER_STEPPERS.find((stepper) => stepper.settingKey === settingKey);

// An extension reload or update leaves the previous copy running in its own isolated world with a
// dead chrome.runtime. Ask it to stand down; v2.0.0 and older can't and still hold their root.
document.dispatchEvent(new Event("mdg-content-superseded"));
// 3.5.x and older listen for the name from before the rename. Remove after 3.6.
document.dispatchEvent(new Event("boc-content-superseded"));
const predecessorStillRunning = Boolean(document.getElementById(ids.root));
document.addEventListener("mdg-content-superseded", standDown, { once: true });
// What a superseded copy stops (standDown): the page listeners, observers and the URL watcher hang off this signal.
const life = new AbortController();

init();

// Every focus-mode entry goes through here; the view only opens in reader mode. A Shorts page has no room for the
// transcript beside its vertical player: the same video's watch page loads instead and enters from its URL.
function markReaderMode() {
  const watchUrl = shortsReaderUrl();
  if (watchUrl) {
    // Back returns to the Short, not to a URL that comes straight back here. Opened from an mdg_reader URL, the Short
    // is still loading and Chrome replaces its history entry with the watch page: Back skips it.
    replaceReaderModeUrl(stripReaderModeUrl());
    location.assign(watchUrl);
    return;
  }
  stepReader("mark");
  document.documentElement.setAttribute(READER_MODE, "1");
  document.body.setAttribute(READER_MODE, "1");
}

// The watch page asking for 专注模式 of the YouTube Short at url, "" for any other page.
function shortsReaderUrl(url = location.href) {
  const ref = new URL(url).pathname.startsWith("/shorts/") && MdgSites.parseRef(url);
  if (ref?.site !== "youtube") {
    return "";
  }
  const watch = new URL(ref.url);
  watch.searchParams.set(MdgCommon.READER_PARAM, "1");
  return watch.href;
}

function standDown() {
  state.superseded = true;
  // Focus mode moved the page's player into our view; a reload restores the page and mdg_reader reopens focus mode
  // (put back: YouTube drops it from the address soon after load).
  if (state.readerMode) {
    const url = new URL(location.href);
    url.searchParams.set(MdgCommon.READER_PARAM, "1");
    location.replace(url.href);
    return;
  }
  life.abort();
  removePlayerAiQuickActionButton();
  document.getElementById(ids.root)?.remove();
}

function init() {
  ensureUiReady({ forceRecreate: true });

  const shouldEnterReaderMode = readerEntryRequested();
  if (shouldEnterReaderMode) {
    markReaderMode();
  } else {
    clearReaderModePageState();
  }

  bindRuntimeEvents();
  bindSettingsWatcher();
  bindReaderSettingsDismiss();
  bindNormalPageStateGuard();
  bindPlayerAiQuickActionLayoutEvents();
  startUrlWatcher();
  // Unread settings keep the defaults state starts with.
  getSettings()
    .catch(() => state.settings)
    .then((settings) => {
      state.settings = settings;
      // After the settings: the debug log setting decides whether it shows.
      logInfo(`[MDG] content script loaded, version=${MDG_VERSION}`);
      hydrateReaderStateFromSettings(settings);
      applyReadingViewPresentation();
      startPlayerAiQuickActionObserver();
      schedulePlayerAiQuickActionSync();
      if (shouldEnterReaderMode) {
        startReaderMode();
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
  for (const node of [document.documentElement, document.body]) {
    READER_PAGE_ATTRS.forEach((name) => node.removeAttribute(name));
  }
  document.body.removeAttribute(READING_ACTIVE);
}

function shouldForceNormalPageState() {
  return !state.readerMode;
}

function enforceNormalPageStateIfNeeded() {
  if (state.superseded || !shouldForceNormalPageState()) {
    return;
  }
  clearReaderModePageState();
}

function bindNormalPageStateGuard() {
  const observer = new MutationObserver(() => {
    enforceNormalPageStateIfNeeded();
  });
  life.signal.addEventListener("abort", () => observer.disconnect());
  observer.observe(document.documentElement, { attributes: true, attributeFilter: READER_PAGE_ATTRS });
  observer.observe(document.body, { attributes: true, attributeFilter: [...READER_PAGE_ATTRS, READING_ACTIVE] });
  enforceNormalPageStateIfNeeded();
}

function bindRuntimeEvents() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (message.type === "popup-get-state") {
      sendResponse({ ok: true, payload: getPopupPayload() });
      return false;
    }

    // Opening the popup reads the video as it is; its 刷新 button sends refresh.
    if (message.type === "popup-refresh") {
      settledClip(message.refresh === true)
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
        .then((result) => sendResponse({ ok: true, ...result, payload: getPopupPayload() }))
        .catch((error) =>
          sendResponse({ ok: false, error: MdgErrors.messageOf(error), payload: getPopupPayload() })
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
        startReaderMode();
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
        sendResponse({ ok: false, error: NO_PLAYER });
        return false;
      }
      const nextTime = seekVideo(video, seconds);
      if (state.readingViewOpen) {
        state.readingFollowPaused = false;
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
  if (!chrome.storage?.onChanged) {
    return;
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" && areaName !== "local") {
      return;
    }
    // The popup copies state.markdown as is, so a new answer must reach it before the next refresh.
    const run = clipRuns.current;
    if (changes[MdgLimits.KEYS.aiConversations] && state.markdown) {
      loadAiTurns().then((turns) => {
        if (!run.alive) return;
        state.aiTurns = turns;
        rebuildDerivedContent();
      });
    }
    // A write recorded a note (obsidian.js): 下载 .md takes its name from now on.
    const pathsKey = MdgLimits.KEYS.obsidianNotePaths;
    if (areaName === "local" && changes[pathsKey]) state.notePaths = changes[pathsKey].newValue || {};
    const extrasRef = { site: state.site, videoId: state.videoId, pageIndex: state.pageIndex };
    if (MdgNote.triageExtrasKeys(extrasRef).some((key) => changes[key]) && state.markdown) {
      loadTriageExtras().then((extras) => {
        if (!run.alive) return;
        state.triageExtras = extras;
        rebuildDerivedContent();
      });
    }
    // Any setting (sync keys of MdgSettings.DEFAULTS) or the AI platforms. Note settings (附带热门评论, 笔记属性, 笔记标签…)
    // shape the note: the popup copies and downloads state.markdown and the side panel builds from state.settings, so
    // both rebuild here, like 写入 Obsidian, which builds with the settings of the moment.
    const changed = areaName === "sync" && Object.keys(changes).some((k) => k === MdgLimits.KEYS.aiProviderList || Object.hasOwn(MdgSettings.DEFAULTS, k));
    if (!changed) {
      return;
    }
    // Focus mode's look (another tab's, or this one's own save) does not shape the note.
    const noteChanged = Object.keys(changes).some((k) => !READER_KEYS.includes(k));

    getSettings()
      .then((settings) => {
        state.settings = settings;
        hydrateReaderStateFromSettings(settings);
        applyReadingViewPresentation();
        schedulePlayerAiQuickActionSync();
        if (noteChanged && state.markdown && run.alive) refreshDerivedContent().catch(() => {});
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
              <strong class="mdg-reading-title">${escapeHtml(state.title || READER_NAME)}</strong>
              <div id="${ids.readingMeta}" class="mdg-reading-meta">${escapeHtml(currentSite()?.domain || "")}</div>
            </div>
            <div class="mdg-reading-actions">
              <button id="${ids.readingAiBtn}" type="button" class="mdg-reading-icon-btn" title="${AI_SUMMARY}" aria-label="${AI_SUMMARY}">${buildPlayerAiQuickActionIconSvg()}</button>
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
                ${READER_STEPPERS.map(buildReaderStepperControl).join("")}
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
            <div class="mdg-reading-follow-hint">跟随已停<button id="${ids.readingFollowResumeBtn}" type="button">回到当前</button></div>
            <div id="${ids.readingTranscriptList}" class="mdg-reading-transcript"></div>
          </section>
        </section>
      </div>
    </section>
    <p id="${ids.readingStatus}" class="mdg-reading-status" role="status" title="点击关闭" hidden></p>
  `;
}

function bindUiEvents() {
  const readingCloseBtn = byId(ids.readingCloseBtn);
  const readingAutoScroll = byId(ids.readingAutoScroll);
  const readingThemeSelect = byId(ids.readingThemeSelect);
  const readingSettingsToggleBtn = byId(ids.readingSettingsBtn);
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
      state.readingFollowPaused = false;
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
    const themes = MdgSettings.READER_OPTIONS.readerTheme;
    const current = state.readingTheme;
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
  READER_STEPPERS.forEach(({ id, settingKey }) => bindReaderStepperControl(byId(id), settingKey));

  byId(ids.readingSubtitleSelect).addEventListener("change", onReadingSubtitleChange);

  bindReaderManualScroll(transcriptList);
  bindReaderManualScroll(chapterList);
  chapterList.addEventListener("pointerdown", () => noteManualReaderInteraction());
  transcriptList.addEventListener("pointerdown", () => noteManualReaderInteraction());
  byId(ids.readingFollowResumeBtn).addEventListener("click", () => {
    state.readingFollowPaused = false;
    syncReadingViewPlayback(true);
  });
  byId(ids.readingStatus).addEventListener("click", () => setReadingNotice(""));
  // The popup's request, from 专注模式 (source reader): it works even when the player button is turned off.
  byId(ids.readingAiBtn).addEventListener("click", () => {
    askSidepanel("reader").then((ok) => ok && setReadingNotice(""));
  });
  chapterList.addEventListener("click", onReadingChapterClick);
  transcriptList.addEventListener("click", onReadingTranscriptClick);
}

// The settings panel closes on a click outside it or Esc; on the document, so bound once (bindUiEvents runs again
// whenever the root is recreated).
function bindReaderSettingsDismiss() {
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
  }, { signal: life.signal });
  document.addEventListener("keydown", (e) => {
    if (MdgTyping.composing(e) || e.key !== "Escape" || !state.readingSettingsExpanded) return;
    // Esc in Bilibili's own fields (the comment box, the danmaku box) is theirs; in the panel's own controls it closes it.
    const from = e.composedPath?.()[0] || e.target;
    if (MdgTyping.typingIn(e) && !document.getElementById(ids.readingSettingsPanel)?.contains(from)) return;
    state.readingSettingsExpanded = false;
    renderReaderPanels();
    document.getElementById(ids.readingSettingsBtn)?.focus();
  }, { signal: life.signal });
}

// Wheel, touch and keys are always the reader's. A bare scroll event may be our own, so it counts only outside the
// programmatic scroll's window.
function bindReaderManualScroll(node) {
  node.addEventListener("scroll", () => {
    if (Date.now() > state.readingProgrammaticScrollUntil) noteManualReaderInteraction();
  });
  for (const type of ["wheel", "touchstart", "keydown"]) {
    node.addEventListener(type, () => noteManualReaderInteraction(), { passive: true });
  }
}

// Our own scroll's scroll events are ignored until then. Overlapping scrolls keep the later end.
function guardProgrammaticScroll(ms) {
  state.readingProgrammaticScrollUntil = Math.max(state.readingProgrammaticScrollUntil, Date.now() + ms);
}

function startUrlWatcher() {
  const timer = window.setInterval(checkUrlChange, 1200);
  life.signal.addEventListener("abort", () => window.clearInterval(timer));
  // Both sites navigate in place (B站's next part or next 稍后再看 video too); the Navigation API sees each URL change
  // at once, the interval is the fallback. YouTube's own event comes when its page has switched.
  window.navigation?.addEventListener("currententrychange", checkUrlChange, { signal: life.signal });
  document.addEventListener("yt-navigate-finish", checkUrlChange, { signal: life.signal });
  // Media events do not bubble: caught on the way down, whichever <video> the player swaps in.
  document.addEventListener("loadedmetadata", checkPlayerChange, { capture: true, signal: life.signal });
}

function checkUrlChange() {
  if (!state.superseded && computeCurrentClipSignature() !== state.currentClipSignature) {
    videoChanged();
  }
}

// A 活动页 switches videos without touching its URL, a 番剧 ss… page may play on into the next episode: on a page whose
// URL names no video, the player loading another one is the change the URL watcher cannot see.
// loadedmetadata and settledClip both ask: one read serves every caller waiting, so one change resets the state once.
let playerCheck = null;
function checkPlayerChange() {
  return (playerCheck ||= readPlayerChange().finally(() => (playerCheck = null)));
}
async function readPlayerChange() {
  const watching = () => !state.superseded && state.videoId && !MdgSites.parseRef(location.href);
  if (!watching()) {
    return;
  }
  // Unread (no answer from the background) is no change: the next read asks the player again.
  const ref = await readPlayerRef().catch(() => null);
  // Compared again: the URL watcher may have reset the state while the player answered.
  if (watching() && ref && isOtherClip(ref, state)) {
    videoChanged();
  }
}

// Another video, or another part once the read knows its cid: before that, only the id can tell.
function isOtherClip(ref, clip) {
  return ref.id !== clip.videoId || Boolean(clip.cid && ref.part.cid !== clip.cid);
}

function videoChanged() {
  const nextUrl = location.href;
  state.currentClipSignature = computeCurrentClipSignature();
  try {
    if (!IN_VIEWER) chrome.runtime.sendMessage({ type: "mdg-video-changed" })?.catch?.(() => {});
  } catch {}
  enforceNormalPageStateIfNeeded();
  ensureUiReady();
  // Invalidate the previous video's run so nothing waiting on it gets its subtitles.
  clipRuns.next();
  state.refreshPromise = null;
  const prev = { id: state.videoId, title: state.title };
  resetClipState();
  setStatus(STATUS_READY);
  // Another part of the same video keeps its title until the info is read. The page's own title is not used: at this
  // point it may still be the last video's (B站 updates it later, YouTube's og:title not at all).
  if (MdgSites.parseRef(nextUrl)?.id === prev.id) state.title = prev.title;
  const action = clipChangeAction(state.readingViewOpen, hasReaderParam(nextUrl));
  if (action === "enter") {
    markReaderMode();
    startReaderMode();
  } else if (action === "refresh") {
    setReadingNotice("");
    // Not waiting for the player: the video's info and duration come from the site (sites.js fetchMeta).
    refreshClip().catch(readerReadFailed);
  }
}

// 专注模式 open reads the new clip, the reader URL param opens it. Otherwise nothing is read here: the next entry that
// asks (popup, side panel, player ✦) reads it via settledClip.
function clipChangeAction(readingViewOpen, readerParam) {
  if (readingViewOpen) return "refresh";
  return readerParam ? "enter" : "none";
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
  state.readCode = "";
  state.subtitleWarning = "";
  state.subtitleFailure = "";
  state.subtitleNeedLogin = false;
  state.chapters = [];
  state.hotComments = [];
  state.commentsFailure = "";
  state.triageExtras = null;
  state.markdown = "";
  state.srt = "";
  state.txt = "";
  state.currentClipSignature = computeCurrentClipSignature();
  state.readingActiveSubtitleIndex = -1;
  state.readingActiveChapterIndex = -1;

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
  const { pageIndex, pageCount } = clipPage(state);
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
      pageIndex,
      pageCount,
      pageTitle: state.pageTitle || "",
      subtitleMarkdown,
      subtitleFailure: state.subtitleFailure,
      subtitleNeedLogin: state.subtitleNeedLogin,
      subtitleWarning: state.subtitleWarning || "",
      subtitleLang: state.selectedSubtitleLang || "",
      selectedSubtitleId: state.selectedSubtitleId || "",
      selectedSubtitleUrl: state.selectedSubtitleUrl || "",
      // The side panel's 字幕 dropdown, as the popup's.
      subtitleOptions: subtitleOptionItems(),
      subtitleMissing: noTrackText(),
      hotComments: state.hotComments || []
    }
  };
}

// The tab's current video, settled: every entry point (popup, side panel, player ✦, focus mode) reads it here.
// It first takes up a URL change the URL watcher has not seen yet, so nothing returns the old video or races a second
// fetch. It joins the run in flight, or starts one when forced or nothing is loaded. A run the video change
// superseded is never the answer: it waits for the run that replaced it, or starts one for the current video.
// Rejects with the current video's failure.
async function settledClip(force = false) {
  for (;;) {
    await checkPlayerChange();
    checkUrlChange();
    let run = state.refreshPromise;
    if (!run && (force || !state.videoId)) {
      run = refreshClip();
      force = false;
    }
    if (!run) return;
    const current = clipRuns.current;
    const failure = await run.then(() => null, (error) => error);
    if (!current.alive) continue;
    if (failure) throw failure;
    return;
  }
}

// The context the side panel and the AI get, with the hot comments of the same video.
async function clipContext(refresh) {
  for (;;) {
    await settledClip(refresh);
    refresh = false;
    const run = clipRuns.current;
    let comments = state.hotComments;
    if (!comments?.length && currentSite()?.fetchComments && state.videoId) {
      comments = await fetchHotComments().catch((error) => {
        logWarn("[MDG] failed to fetch hot comments for the side panel", error);
        return [];
      });
    }
    if (!run.alive) continue;
    // A note refresh may have got them meanwhile.
    if (comments.length) state.hotComments = comments;
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
  const run = clipRuns.next();
  let metaLoaded = false;
  try {
    setStatus(META_READING);
    // A read starts clean: the last read's subtitle state and comments must not leak into this one's note.
    Object.assign(state, { subtitleFetchState: "loading", readCode: "", subtitleFailure: "", subtitleNeedLogin: false, subtitleWarning: "", hotComments: [], commentsFailure: "" });
    if (state.readingViewOpen) {
      renderReadingView();
    }
    state.settings = await getSettings();
    run.check();

    const site = currentSite();
    // Taken before the awaits: a navigation mid-run must still look like a change to checkUrlChange.
    const clipSignature = computeCurrentClipSignature();
    const ref = site?.parseRef(location.href) || (site?.playerRef && (await waitPlayerRef(run)));
    run.check();
    if (!ref) {
      throw new Error(site?.playerRef ? NO_PLAYER : MdgErrors.TEXT.notVideoPage);
    }
    state.site = ref.site;
    state.videoId = ref.id;

    const meta = await retryAsync(() => site.fetchMeta(ref, siteIo(run)), 2, 250);
    run.check();
    logInfo("[MDG] raw meta data", { meta });

    state.meta = meta;
    metaLoaded = true;
    Object.assign(state, clipFields(meta, site.readDom(document)));
    state.currentClipSignature = clipSignature;
    // Without a duration the subtitle is not checked against one, as on every other entry (sites.js).
    state.videoDuration ||= readRuntimeVideoDuration();
    if (state.readingViewOpen) {
      renderReadingView();
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

    setStatus(MdgErrors.TEXT.subtitleReading);
    const found = await MdgSites.loadSubtitle(
      pageSubtitleSite(site, run),
      currentRef(),
      { ...state.meta, duration: state.videoDuration },
      { ...siteIo(run), fresh: true },
      {
        prefer: { previousId: state.selectedSubtitleId, previousUrl: state.selectedSubtitleUrl, previousLang: state.selectedSubtitleLang },
        step: run.step
      }
    );
    state.subtitles = found.tracks;
    state.chapters = MdgSites.normalizeChapters(
      found.bundle.chapters?.length ? found.bundle.chapters : MdgSites.parseChaptersFromDescription(state.description)
    );
    logInfo("[MDG] subtitle tracks", state.subtitles.map(({ id, lang, label, kind, url }) => ({ id, lang, label, kind, url })));
    // 无字幕时也允许进入专注模式，只是字幕区域保持空态。
    if (!found.track) {
      await showNoSubtitleState(run, { failure: found.error ? failureReason(found.error) : "", needLogin: found.needLogin });
      return;
    }
    logInfo("[MDG] selected subtitle track", { id: found.track.id, lang: found.track.lang, label: found.track.label });
    await showSubtitle(found, run);
    setStatus(state.subtitleWarning + readDoneText(), Boolean(state.commentsFailure));
  } catch (error) {
    const action = readFailureAction(error, run.alive, metaLoaded);
    if (action === "ignore") {
      return;
    }
    const reason = failureReason(error);
    if (action === "degrade") {
      try {
        await showNoSubtitleState(run, { failure: reason });
      } catch (degradeError) {
        if (MdgCommon.isStale(degradeError) || !run.alive) {
          return;
        }
        throw degradeError;
      }
      return;
    }
    resetClipState();
    state.subtitleFetchState = "error";
    state.readCode = error?.code ?? "";
    if (state.readingViewOpen) {
      renderReadingView();
    }
    setStatus(`${MdgErrors.TEXT.videoReadFailed}：${reason}。`, true);
    throw error;
  }
}

// The video's info a read keeps: the site's first, the page's where the site has none.
function clipFields(meta, dom) {
  return {
    aid: meta.aid || "",
    title: meta.title || dom.title,
    author: meta.author || dom.author,
    authorUrl: meta.authorUrl || "",
    cover: meta.cover || "",
    videoTags: Array.isArray(meta.tags) ? meta.tags : [],
    uploadDate: meta.uploadDate || dom.uploadDate,
    description: meta.description || dom.description,
    ...clipPage(meta),
    pageTitle: meta.pageTitle || "",
    cid: meta.cid || "",
    videoDuration: Number(meta.duration) > 0 ? Number(meta.duration) : 0
  };
}

// Parts count from 1; a count of 0 is unknown.
function clipPage({ pageIndex, pageCount }) {
  return { pageIndex: Number(pageIndex) > 0 ? Number(pageIndex) : 1, pageCount: Number(pageCount) > 0 ? Number(pageCount) : 0 };
}

// What a failed read does. A newer run (the video changed) owns the state now: an old video's late failure must not
// reset or mark it ("ignore"). Only the subtitle step failed: keep the video info and degrade to the no-subtitle state.
// A limit is no subtitle failure: it fails the read like the side panel and 逐个视频笔记 do, so no note says it and
// 重试 reads it all again ("fail").
function readFailureAction(error, alive, metaLoaded) {
  if (MdgCommon.isStale(error) || !alive) return "ignore";
  return metaLoaded && !MdgSites.isLimit(error) ? "degrade" : "fail";
}

// Reasons arrive with or without a trailing full stop; strip it so the sentences after them join cleanly.
function failureReason(error) {
  return MdgSites.trimReason(fetchErrorText(error));
}

// The page's reads under the shared subtitle step (MdgSites.loadSubtitle). The track list is retried; B站 sometimes
// answers it empty under risk control (one more try 1.5s later), and as logged out when the background request goes
// without the page's cookies (asked again from the page). A rate-limited subtitle file waits a few seconds once.
function pageSubtitleSite(site, run) {
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
      run.check();
      return fetchTracks(ref, meta, io);
    },
    async fetchRaw(track, io) {
      try {
        return await site.fetchRaw(track, io);
      } catch (error) {
        if (error?.status !== 429) throw error;
      }
      await sleep(3000 + Math.random() * 2000);
      run.check();
      return site.fetchRaw(track, io).catch((error) => {
        // B站's 429 is THROTTLED already (sites.js biliJson), as on every other entry.
        throw error?.status === 429 && error.code !== MdgErrors.CODE.THROTTLED ? Object.assign(new Error(MdgErrors.TEXT.ytThrottled), { status: 429 }) : error;
      });
    }
  };
}

// Shows the track MdgSites.loadSubtitle or loadFirstTrack chose, with the warning when its time range does not match.
async function showSubtitle({ track, body, mismatch }, run) {
  state.selectedSubtitleId = track.id ? String(track.id) : state.selectedSubtitleId;
  state.selectedSubtitleUrl = track.url;
  // Empty for a nameless track, as the background has it (the note's subtitle_lang says unknown then).
  state.selectedSubtitleLang = track.label || track.lang || "";
  state.subtitleBody = body;
  state.subtitleWarning = mismatch ? subtitleMismatchWarning(mismatch) : "";
  state.subtitleFetchState = "ready";
  // Only the note waits for the hot comments: the transcript shows as soon as it is here.
  if (state.readingViewOpen) {
    moveReadingMainInline();
    renderReadingView();
    startReaderPlayerObserver();
    syncReadingViewPlayback(true);
    setReadingNotice(state.subtitleWarning);
  }
  await refreshDerivedContent();
  run.check();
}

// The popup's and focus mode's subtitle pickers. Only a track of the video shown: the list may belong to a video the
// page has since left. A track whose time range does not match the video is used with the warning, as on first load.
// The latest pick wins: a switch that loads after a newer one started shows nothing and resolves.
const subtitleSwitches = MdgCommon.latest();
async function switchSubtitle(url) {
  const track = url && state.subtitles.find((item) => item.url === url);
  if (!track) {
    throw new Error(VIDEO_SWITCHED);
  }
  const run = clipRuns.current;
  const pick = subtitleSwitches.next();
  try {
    const got = await MdgSites.loadFirstTrack(pageSubtitleSite(currentSite(), run), [track], { videoId: state.videoId, cid: state.cid }, siteIo(run), state.videoDuration, run.step);
    if (!pick.alive) return;
    if (!got.track) throw got.error;
    await showSubtitle(got, run);
  } catch (error) {
    if (!pick.alive) return;
    throw MdgCommon.isStale(error) ? new Error(VIDEO_SWITCHED) : error;
  }
  if (!pick.alive) return;
  setStatus(`${state.subtitleWarning}字幕切换完成。`);
  // The side panel shows the track too: one picked here (popup, 专注模式, the panel itself) is drawn there.
  chrome.runtime.sendMessage({ type: "mdg-subtitle-changed" })?.catch?.(() => {});
}

function onReadingSubtitleChange(event) {
  const option = event.target.options[event.target.selectedIndex];
  const url = String(option?.value || "");
  if (!url) return;
  // showSubtitle draws the new track in focus mode.
  return switchSubtitle(url).catch((error) => {
    // The dropdown goes back to the track still shown.
    renderReadingSubtitleSelect();
    setReadingNotice(`${MdgErrors.TEXT.subtitleSwitchFailed}：${fetchErrorText(error)}`, { error: true });
  });
}

function renderReadingSubtitleSelect() {
  renderSubtitleOptions(byId(ids.readingSubtitleSelect));
}

function renderSubtitleOptions(select) {
  MdgSites.fillSubtitleSelect(select, subtitleOptionItems(), noTrackText());
}

// Translated tracks already say 机器翻译 in their label.
function subtitleOptionLabel(item) {
  return `${item.label || item.lang || UNNAMED_SUBTITLE}${{ ai: "（AI）", auto: "（自动）" }[item.kind] || ""}`;
}

// Why no subtitle is shown (专注模式's transcript and dropdown, the popup's dropdown and 下载字幕's reason): the read
// state first, so a read in progress or a failed one (a limit) never says 视频没有字幕; after a read, MdgErrors.subtitleMissing.
function noTrackText() {
  // idle: the video just changed and its fetch has not started yet.
  if (state.subtitleFetchState === "loading" || state.subtitleFetchState === "idle") {
    return MdgErrors.TEXT.subtitleReading;
  }
  // Only reading the video itself sets error (a subtitle failure is subtitleMissing below).
  if (state.subtitleFetchState === "error") {
    return MdgSites.isBiliVideoGone(state.readCode) ? MdgErrors.LABEL.videoGone : MdgErrors.TEXT.videoReadFailed;
  }
  return MdgErrors.subtitleMissing(state);
}

// The subtitle dropdown's entries, for 专注模式's, the popup's and the side panel's.
function subtitleOptionItems() {
  return (state.subtitles || []).map((item) => {
    const label = item.label || item.lang || "";
    const selectedById =
      state.selectedSubtitleId && String(item.id) === String(state.selectedSubtitleId);
    const selectedByUrl = item.url === state.selectedSubtitleUrl;
    return {
      id: String(item.id || ""),
      url: item.url,
      lang: label,
      optionLabel: subtitleOptionLabel(item),
      selected: Boolean(selectedById || selectedByUrl)
    };
  });
}

function getPopupPayload() {
  return {
    site: currentSite()?.id || "",
    url: cleanVideoUrl(),
    title: state.title || "",
    author: state.author || "",
    uploadDate: state.uploadDate || "",
    cover: state.cover || "",
    duration: state.videoDuration || 0,
    tags: MdgNote.noteTags({ userTags: state.triageExtras?.userTags }, state.settings || DEFAULT_SETTINGS).join(", "),
    status: state.statusText || "",
    statusError: state.statusError,
    subtitlePreview: buildSubtitlePreview(state.subtitleBody || [], state.settings || DEFAULT_SETTINGS),
    markdown: state.markdown || "",
    // write-video-note's ref for this note, when the background reads this tab for a write from elsewhere.
    noteRef: noteRef(),
    // What 写入 Obsidian's result starts with for this note (the side panel sends it with the note as page.warning).
    noteWarning: MdgNote.noteSubtitleWarning(state.subtitleWarning, state),
    // 下载 .md: the same name as the note 写入 Obsidian writes: the one it recorded, else MdgNote.buildNoteFilename.
    filename: MdgNote.recordedFilename(state.notePaths, MdgSites.buildContextKey(noteRef()), MdgNote.buildNoteFilename(state, state.settings || DEFAULT_SETTINGS)),
    // The subtitle dropdown's line when there is no track, and 下载字幕's reason: the same as 专注模式's (noTrackText).
    subtitleMissing: noTrackText(),
    srt: state.srt || "",
    txt: state.txt || "",
    subtitleOptions: subtitleOptionItems()
  };
}

// The video part write-video-note names the note by: this page's write, and a write from elsewhere that reads this tab.
function noteRef() {
  return { site: state.site, videoId: state.videoId, cid: state.cid, pageIndex: state.pageIndex, pageCount: state.pageCount, pageTitle: state.pageTitle, title: state.title, author: state.author, uploadDate: state.uploadDate, url: cleanVideoUrl() };
}

// The background (write-video-note) picks the path and writes; this page hands its note to MdgNoteActions and draws
// the overwrite dialog itself (a content script cannot show the extension pages' <dialog>).
// Resolves { ok, text, code? }: text is the result for the popup to show (ok: false is red). The result never goes into
// the popup's status (statusText): answering the dialog closes the popup, so from then on it shows on the page only.
// The video shown, by identity: autoplay or a link changes it (and resets the state) while 写入 Obsidian reads or asks,
// and then the note must not go. A refresh of the same video (the side panel's, 专注模式's 重试) starts a new run but
// is the same video, so this is not the run.
const clipIdentity = () => [state.site, state.videoId, state.cid, state.pageIndex].join("|");

async function sendToObsidian() {
  const clip = clipIdentity();
  state.settings = await getSettings();
  // Turned off in the settings page while the popup that still shows the button was open: the background says so with
  // its OBSIDIAN code, so the popup offers 去设置 as on every other entry.
  await refreshDerivedContent();
  if (clipIdentity() !== clip) {
    return { ok: true, text: MdgErrors.TEXT.obsidianVideoSwitched };
  }
  // The popup disables 写入 Obsidian without a note; the note can still go when the video changes meanwhile.
  if (!state.markdown) {
    return { ok: false, text: MdgErrors.TEXT.noNoteYet };
  }

  const request = { ref: noteRef(), page: { markdown: state.markdown, cover: state.cover, warning: MdgNote.noteSubtitleWarning(state.subtitleWarning, state) } };
  // Once the dialog was answered the popup has closed: the result shows on the page.
  let onPage = false;
  const choose = async (path, opts) => {
    const mode = await confirmOverwriteNote(path, opts);
    onPage = true;
    if (mode) setReadingNotice(MdgErrors.TEXT.obsidianWriting, { busy: true });
    return mode;
  };
  const r = await MdgNoteActions.run("write", {
    request: () => request,
    send: sendRuntimeMessage,
    isStale: () => (clipIdentity() === clip ? "" : MdgErrors.TEXT.obsidianVideoSwitched),
    dialogs: { choose }
  });
  // Not set up or a wrong key: 去设置, opened only on its click (the popup shows it from code when the page did not
  // take over). A closed Obsidian only gets the red line.
  const settings = r.remedies.includes("settings") ? { label: MdgErrors.LABEL.toSettings, run: requestOpenOptions } : null;
  if (onPage) setReadingNotice(r.text, { hideMs: r.ok ? 3000 : 0, error: !r.ok, action: settings });
  return { ok: r.ok, text: r.text, ...(r.code && { code: r.code }) };
}

let cancelOverwriteNote = null;

// Resolves "ai" (replace only the marked AI 问答 section), "full" (rewrite the note) or "" (cancel). aiOff: why there is no
// AI 问答 to update is 「附带 AI 问答」 off (as MdgOverwriteDialog.choose).
// 整篇覆盖 never sits next to the default button: a slip must not turn an update into a rewrite.
function confirmOverwriteNote(filepath, { hasAiSection = false, aiOff = false } = {}) {
  // A second dialog answers the first with 取消, so its caller does not wait forever.
  cancelOverwriteNote?.();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "mdg-confirm-overlay";
    overlay.innerHTML = `
      <div class="mdg-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="mdgConfirmTitle">
        <div id="mdgConfirmTitle" class="mdg-confirm-title">该笔记已存在</div>
        <div class="mdg-confirm-body">${hasAiSection ? "只更新 AI 问答：保留原笔记，只替换标记之间的「AI 问答」。整篇覆盖：替换全部内容。" : `${aiOff ? "「附带 AI 问答」已关。" : "没有 AI 问答可更新。"}整篇覆盖会替换全部内容：`}</div>
        <div class="mdg-confirm-path"></div>
        <div class="mdg-confirm-actions">
          <button type="button" class="mdg-confirm-danger" data-choice="full">整篇覆盖</button>
          <button type="button" class="mdg-confirm-cancel" data-choice="">取消</button>
          ${hasAiSection ? '<button type="button" class="mdg-confirm-primary" data-choice="ai">只更新 AI 问答</button>' : ""}
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

    // A press and a release both on the overlay, as download.js's dialog: a text selection dragged out of the box
    // ends with a click on the overlay too.
    let downOutside = false;
    overlay.addEventListener("pointerdown", (event) => (downOutside = event.target === overlay));
    overlay.addEventListener("click", (event) => {
      if (downOutside && event.target === overlay) {
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

function setStatus(text, error = false) {
  state.statusText = String(text || "");
  state.statusError = error;
}

// failure: why the subtitle fetch failed; needLogin: B站 hid them from a logged-out viewer; neither: there are none.
async function showNoSubtitleState(run, { failure = "", needLogin = false } = {}) {
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
    // The read settled: an earlier read's red failure no longer applies (showSubtitle does the same with its warning).
    setReadingNotice("");
  }
  setStatus(`${label}，正在读取评论…`);
  await refreshDerivedContent();
  run.check();
  setStatus(`${label}。${readDoneText()}${hint}`, Boolean(failure || state.commentsFailure));
}

// The popup's status after a read, with or without a subtitle: what the note can do, and a comment read that failed.
function readDoneText() {
  const comments = state.commentsFailure ? `评论读取失败：${state.commentsFailure}。` : "";
  return comments + (state.settings.obsidianEnabled ? MdgErrors.TEXT.readDoneObsidian : MdgErrors.TEXT.readDone);
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

// Every entry into 专注模式 (the URL, a SPA video change, the popup): a failure is red on the page, the same sentence.
function startReaderMode() {
  enterReaderMode().catch((error) => {
    setReadingNotice(`${MdgErrors.TEXT.readerStartFailed}：${MdgErrors.messageOf(error)}`, { error: true });
  });
}

async function enterReaderMode() {
  if (!stepReader("enter")) {
    return;
  }
  const run = readerRuns.current;
  const readingView = byId(ids.readingView);
  state.readingPlayerRetries = 0;
  document.body.setAttribute(READING_ACTIVE, "1");
  hydrateReaderStateFromSettings(state.settings);
  applyReadingViewPresentation();
  alignReaderViewportToPlayer();
  await sleep(0);
  if (!run.alive) {
    return;
  }
  openReaderViewShell(readingView);
  applyReaderPageFocus();
  startReaderPlayerObserver();
  renderReadingView();

  findReaderPlayerHost(getRuntimeVideoElement())?.setAttribute(READER_FADING, "1");

  await sleep(0);
  if (!run.alive) {
    return;
  }

  // The view stays hidden until the player is in, so say so unless that is instant.
  const waitNotice = window.setTimeout(() => state.readingViewOpen && setReadingNotice(PLAYER_WAIT, { busy: true }), 150);
  const mounted = await ensureReaderPlayerMounted({ retries: 50, delayMs: 150, forceLayout: true });
  window.clearTimeout(waitNotice);
  clearReaderFading();
  if (!run.alive) {
    return;
  }
  if (!mounted) {
    // Don't throw - keep UI open and keep retrying in background
    setReadingNotice(PLAYER_WAIT, { busy: true });
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
  const run = readerRuns.current;
  const tryMount = async () => {
    state.readingPlayerRetryTimer = 0;
    if (!run.alive || !state.readingViewOpen) return;
    state.readingPlayerRetries += 1;
    if (state.readingPlayerRetries > 12) {
      replaceReaderModeUrl(stripReaderModeUrl(location.href));
      closeReadingView();
      setReadingNotice(`视频播放器长时间未就绪，已退出专注模式，${MdgErrors.TEXT.reloadRetry}`, { error: true });
      return;
    }
    const mounted = await ensureReaderPlayerMounted({ retries: 10, delayMs: 200, forceLayout: true });
    if (!run.alive) return;
    if (mounted) {
      finishEnterReaderMode();
    } else if (state.readingViewOpen) {
      state.readingPlayerRetryTimer = window.setTimeout(tryMount, PLAYER_RETRY_MS);
    }
  };
  state.readingPlayerRetryTimer = window.setTimeout(tryMount, PLAYER_RETRY_MS);
}

// Whichever host the entry hid (the one found first may not be the one mounted), and on a close mid-entry.
function clearReaderFading() {
  document.querySelectorAll(`[${READER_FADING}]`).forEach((node) => node.removeAttribute(READER_FADING));
}

function finishEnterReaderMode() {
  if (!state.readingViewOpen) return;

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
  // Joins a read in flight or reads a video not read yet; a video already read without subtitles is not reread.
  settledClip(false).catch(readerReadFailed);
}

// A read focus mode started (entry, video change, 重试) failed: red in focus mode, nothing once it has closed.
function readerReadFailed(error) {
  if (state.readingViewOpen && !MdgCommon.isStale(error)) {
    setReadingNotice(`${MdgErrors.TEXT.videoReadFailed}：${fetchErrorText(error)}`, { error: true });
  }
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
    setReadingNotice(PLAYER_WAIT, { busy: true });
    scheduleReaderPlayerRetry();
    return false;
  }
  setReadingViewReady(true);
  state.readingPlayerRetries = 0;
  setReadingNotice("");
  return true;
}

async function ensureReaderPlayerMounted({ retries = 1, delayMs = 100, forceLayout = false } = {}) {
  const run = readerRuns.current;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    // Exiting mid-loop must not leave the page's player stripped of controls and picture-in-picture.
    if (!isReaderMode()) {
      return false;
    }
    if (pageHydrating()) {
      await sleep(delayMs);
      continue;
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
        // Closed (or closed and reopened) while the mini player went away, or the page plays another video now: the
        // page's player stays as the close left it, and the next mount starts from the video it has.
        if (!isReaderMode() || !run.alive || getRuntimeVideoElement() !== video) {
          return false;
        }
      }
      const activeHost = findReaderPlayerHost(video) || playerHost;
      state.readingPlayerHost = activeHost;
      // YouTube moves #movie_player from the skeleton #player into
      // ytd-watch-flexy after load, into a branch the page focus hid; the
      // transcript host follows the player into its new wrap.
      if (video.closest(`[${READER_HIDDEN}="1"]`)) {
        applyReaderPageFocus();
      }
      moveReadingMainInline();
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
      if (state.readingViewOpen && !isListPlayerPage()) {
        await ensureReaderPlayerControlsRecovered(activeHost, {
          reason: attempt > 0 ? "mount-retry" : "mount"
        });
        if (!run.alive) {
          return false;
        }
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

// B站 hands its server-rendered page to the client only after load (Vue then drops data-server-rendered). Focus mode
// put into the page before that leaves the page's own part switching dead for the visit (列表、下一个、自动连播), so the
// mount waits; past HYDRATE_WAIT_MS it goes ahead, in case a page keeps the marker.
function pageHydrating() {
  const marks = reader().hydrating || [];
  return Boolean(marks.length && document.querySelector(sel(marks))) && performance.now() < HYDRATE_WAIT_MS;
}

function queueEnsureReaderPlayerMounted() {
  if (!state.readingViewOpen || state.readingPlayerMountTimer) {
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
  state.readingFollowPaused = false;
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
  clearReaderModePageState();
  clearReaderFading();
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

function renderReadingPageTitle() {
  const node = document.getElementById(ids.readingPageTitle);
  if (node) {
    node.textContent = node.title = state.title || "";
  }
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
    titleNode.textContent = state.title || READER_NAME;
  }
  renderReadingPageTitle();
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
    transcriptList.innerHTML = `<div class="mdg-reading-empty">${escapeHtml(getReadingTranscriptPlaceholderText())}${
      readingRetryShown() ? `<button type="button" class="mdg-reading-retry">${MdgErrors.LABEL.retry}</button>` : ""
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

// 专注模式's 重试 under an empty transcript, as MdgErrors.remedies says for the failed read or the missing subtitle: not
// for a video that is gone or has no subtitles (no read brings them back).
function readingRetryShown() {
  return MdgErrors.remedies(state.subtitleFetchState === "error" ? state.readCode : MdgErrors.subtitleCode(state)).includes("retry");
}

function getReadingTranscriptPlaceholderText() {
  const text = noTrackText();
  return text.endsWith("…") ? text : `${text}。${state.subtitleNeedLogin ? `${MdgErrors.TEXT.subtitleLoginHint}。` : ""}`;
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
  const inlineHost = document.getElementById(ids.readingInlineHost);
  const transcriptList = document.getElementById(ids.readingTranscriptList);
  const hostHeight = inlineHost?.clientHeight || transcriptList?.clientHeight || 0;
  const spacerHeight = Math.max(hostHeight, Math.round(window.innerHeight * 0.92), 320);
  spacer.style.height = `${spacerHeight}px`;
}

function hydrateReaderStateFromSettings(settings = state.settings) {
  state.readingTheme = MdgSettings.normalizeReaderTheme(settings?.readerTheme);
  state.readingFontScale = MdgSettings.normalizeReaderFontScale(settings?.readerFontScale);
  state.readingLetterSpacing = MdgSettings.normalizeReaderLetterSpacing(settings?.readerLetterSpacing);
  state.readingLineHeight = MdgSettings.normalizeReaderLineHeight(settings?.readerLineHeight);
  state.readingContentWidth = MdgSettings.normalizeReaderContentWidth(settings?.readerContentWidth);
  state.readingChapterVisible = MdgSettings.normalizeSwitches({ ...settings }).readerChapterVisible;
}

function applyReadingViewPresentation() {
  const readingView = byId(ids.readingView);
  readingView.dataset.theme = state.readingTheme;
  readingView.dataset.fontScale = state.readingFontScale;
  readingView.dataset.letterSpacing = state.readingLetterSpacing;
  readingView.dataset.lineHeight = state.readingLineHeight;
  readingView.dataset.contentWidth = state.readingContentWidth;
  readingView.dataset.chapterVisibility = state.readingChapterVisible ? "auto" : "hide";
  for (const node of [document.documentElement, document.body]) {
    Object.assign(node.dataset, {
      mdgReaderTheme: state.readingTheme,
      mdgReaderFontScale: state.readingFontScale,
      mdgReaderLetterSpacing: state.readingLetterSpacing,
      mdgReaderLineHeight: state.readingLineHeight,
      mdgReaderContentWidth: state.readingContentWidth,
      mdgReaderChapterVisibility: readingView.dataset.chapterVisibility
    });
  }
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

function buildReaderStepperControl({ id, title, settingKey }) {
  const { labels } = readerStepper(settingKey);
  return `
    <div id="${id}" class="mdg-reading-stepper">
      <span class="mdg-reading-stepper-title">${escapeHtml(title)}</span>
      <div class="mdg-reading-stepper-buttons" role="group" aria-label="${escapeHtml(title)}">
        ${MdgSettings.READER_OPTIONS[settingKey]
          .map(
            (option, index) => `
          <button
            type="button"
            class="mdg-reading-stepper-btn"
            data-value="${escapeHtml(option)}"
            aria-label="${escapeHtml(title)} ${escapeHtml(labels[option] || "标准")}"
            title="${escapeHtml(labels[option] || "标准")}"
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
  if (!MdgSettings.READER_OPTIONS[settingKey].includes(nextValue) || nextValue === state[readerStepper(settingKey).stateKey]) {
    return;
  }
  updateReaderPreferences({ [settingKey]: nextValue }, { persist: true });
}

function renderReaderStepperState(node, settingKey) {
  if (!node) {
    return;
  }
  const current = state[readerStepper(settingKey).stateKey];
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
  READER_STEPPERS.forEach(({ id, settingKey }) => renderReaderStepperState(byId(id), settingKey));
}

function renderReadingInfoPanel() {
  const summaryNode = byId(ids.readingInfoSummary);
  const descriptionNode = byId(ids.readingInfoDescription);
  const descriptionBtn = byId(ids.readingDescriptionBtn);
  const summaryItems = buildReadingSummaryItems();
  const description = String(state.description || "").trim();

  summaryNode.innerHTML =
    summaryItems.length === 0
      ? `<div class="mdg-reading-empty">${escapeHtml(readingInfoMissingText(""))}</div>`
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
    descriptionNode.innerHTML = `<div class="mdg-reading-empty">${escapeHtml(readingInfoMissingText("当前视频没有简介。"))}</div>`;
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

// Why the info panel has nothing to show: the video is still being read, its read failed, or (read) none.
function readingInfoMissingText(none) {
  if (state.meta) return none;
  return state.subtitleFetchState === "error" ? MdgErrors.TEXT.videoReadFailed : META_READING;
}

// 「P2 标题」 for a video in parts, "" otherwise.
function pageLabel() {
  if (!(Number(state.pageCount) > 1)) return "";
  return [`P${Number(state.pageIndex) > 0 ? Number(state.pageIndex) : 1}`, state.pageTitle].filter(Boolean).join(" ");
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
    items.push({ label: MdgErrors.LABEL.uploadDate, value: state.uploadDate });
  }
  if (pageLabel()) {
    items.push({ label: "分 P", value: pageLabel() });
  }
  return items;
}

// Callers pass only values from the controls' option lists.
function updateReaderPreferences(next, { persist = true } = {}) {
  state.settings = { ...state.settings, ...next };
  hydrateReaderStateFromSettings(state.settings);
  applyReadingViewPresentation();
  renderReaderPanels();
  if (persist) {
    persistReaderSettings();
  }
}

// Only the reader keys: state.settings is stale for everything else, and save-settings keeps the keys it is not sent.
// The change shows at once; a failed save says so, or the next page would bring the old look back unexplained.
async function persistReaderSettings() {
  const settings = Object.fromEntries(READER_KEYS.map((key) => [key, state.settings[key]]));
  try {
    const resp = await sendRuntimeMessage({ type: "save-settings", settings });
    if (!resp?.ok) throw MdgErrors.fromResp(resp);
  } catch (error) {
    setReadingNotice(MdgErrors.reloaded(error) ? MdgErrors.TEXT.reloaded : `${MdgErrors.TEXT.settingsSaveFailed}：${MdgErrors.messageOf(error)}`, { error: true });
  }
}

function buildReadingMetaLine() {
  const parts = [];
  if (state.author) {
    parts.push(state.author);
  }
  if (state.uploadDate) {
    parts.push(state.uploadDate);
  }
  parts.push(currentSite()?.domain || "", pageLabel());
  if (state.selectedSubtitleUrl) {
    parts.push(`字幕：${state.selectedSubtitleLang || UNNAMED_SUBTITLE}`);
  }
  return parts.filter(Boolean).join(" · ");
}

// Errors and waits only; an empty text hides the notice. It sits outside the
// reading view, which stays invisible until the player is ready.
// busy: a 正在… notice (gray, spinner); hideMs: a result that clears itself; error: one the user must handle (red);
// action: { label, run }, a button after the text (去设置).
function setReadingNotice(text, { busy = false, hideMs = 0, error = false, action = null } = {}) {
  const notice = byId(ids.readingStatus);
  window.clearTimeout(state.readingNoticeTimer);
  notice.textContent = text;
  if (action) notice.append(Object.assign(document.createElement("button"), { type: "button", textContent: action.label, onclick: action.run }));
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
  if (!(rect.width > MIN_PLAYER.width) || !(rect.height > MIN_PLAYER.height)) {
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
  if (!state.readingViewOpen) {
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
  // The cleanup drops leftover inline sizes; the host keeps its class, which hides the page's own subtitles.
  playerHost.classList.add("mdg-reader-player-host");
  // On <html>: the player and title these size are page nodes outside #mdg-reading-view.
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--mdg-reader-player-rendered-width", `${Math.round(renderedWidth)}px`);
  rootStyle.setProperty("--mdg-reader-player-rendered-height", `${Math.round(renderedHeight)}px`);
  updateReadingTranscriptTailSpacer();
  queueEnsureReaderPlayerControlsRecovered({ reason: "layout-native" });
}

function cleanupReaderPlayerHostNode(playerHost) {
  if (!playerHost) {
    return;
  }
  playerHost.classList.remove("mdg-reader-player-host");
  clearReaderPlacement(playerHost);
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
  unbindReadingVideo();
  state.readingVideoEventsBound = false;
}

const READING_VIDEO_EVENTS = ["timeupdate", "seeked", "loadedmetadata"];
function unbindReadingVideo(video = state.readingVideoEl) {
  if (!video?.__mdgReadingSyncHandler) return;
  READING_VIDEO_EVENTS.forEach((type) => video.removeEventListener(type, video.__mdgReadingSyncHandler));
  delete video.__mdgReadingSyncHandler;
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
          nextVideo.closest(`[${READER_HIDDEN}="1"]`))
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
    unbindReadingVideo();
    state.readingVideoEl = null;
    state.readingVideoEventsBound = false;
    return null;
  }

  if (state.readingVideoEl === video && state.readingVideoEventsBound) {
    return video;
  }

  unbindReadingVideo();

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
  READING_VIDEO_EVENTS.forEach((type) => video.addEventListener(type, syncHandler));
  video.__mdgReadingSyncHandler = syncHandler;
  state.readingVideoEl = video;
  // The player host is ensureReaderPlayerMounted's to change (it cleans up the one it replaces); a new host here is
  // queued for it, as in syncHandler.
  if (findReaderPlayerHost(video) !== state.readingPlayerHost) queueEnsureReaderPlayerMounted();
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
    .filter(({ rect }) => rect.width > MIN_PLAYER.width && rect.height > MIN_PLAYER.height)
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
    document.getElementById(ids.readingInlineHost),
    document.getElementById(ids.readingPageTitle),
    document.querySelector(".mdg-reading-rail")
  ].filter(Boolean);

  keepRoots.forEach((node) => {
    markReaderKeepSubtree(node);
    markReaderKeepPath(node);
  });

  const keepNodes = Array.from(document.querySelectorAll(`[${READER_KEEP}="1"]`));
  keepNodes.forEach((parent) => {
    Array.from(parent.children || []).forEach((child) => {
      if (child.id === ids.root) {
        return;
      }
      if (!child.hasAttribute(READER_KEEP)) {
        child.setAttribute(READER_HIDDEN, "1");
      }
    });
  });

  pruneReaderNonKeepBranches(document.body);
  hideReaderNoiseNodes(keepRoots);
}

function clearReaderPageFocus() {
  document.querySelectorAll(`[${READER_KEEP}]`).forEach((node) => {
    node.removeAttribute(READER_KEEP);
  });
  document.querySelectorAll(`[${READER_HIDDEN}]`).forEach((node) => {
    node.removeAttribute(READER_HIDDEN);
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

  let inlineHost = document.getElementById(ids.readingInlineHost);
  if (!inlineHost) {
    inlineHost = document.createElement("div");
    inlineHost.id = ids.readingInlineHost;
  }

  // Chapters go right under the video, the transcript column after them.
  const rail = document.querySelector(".mdg-reading-rail");
  if (rail && (rail.parentElement !== hostParent || rail.previousElementSibling !== playerWrap)) {
    playerWrap.insertAdjacentElement("afterend", rail);
  }
  // 番剧 and 活动页 show no title above their player: the video's goes there, as on /video/.
  const pageTitle = document.getElementById(ids.readingPageTitle) || (currentSite()?.playerRef && !queryFirst(reader().title) && Object.assign(document.createElement("h1"), { id: ids.readingPageTitle }));
  if (pageTitle && pageTitle.nextElementSibling !== playerWrap) {
    playerWrap.insertAdjacentElement("beforebegin", pageTitle);
    renderReadingPageTitle();
  }
  const hostAnchor = rail || playerWrap;
  if (inlineHost.parentElement !== hostParent || inlineHost.previousElementSibling !== hostAnchor) {
    hostAnchor.insertAdjacentElement("afterend", inlineHost);
  }

  if (!inlineHost.dataset.mdgScrollBound) {
    bindReaderManualScroll(inlineHost);
    inlineHost.dataset.mdgScrollBound = "1";
  }

  if (readingMain.parentElement !== inlineHost) {
    inlineHost.appendChild(readingMain);
  }
  updateReadingTranscriptTailSpacer();
}

function restoreReadingMainInline() {
  const readingMain = document.querySelector(".mdg-reading-main");
  const inlineHost = document.getElementById(ids.readingInlineHost);
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
  document.getElementById(ids.readingPageTitle)?.remove();
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
    const childHasKeep = child.hasAttribute(READER_KEEP);
    const childContainsKeep = Boolean(child.querySelector?.(`[${READER_KEEP}="1"]`));
    if (!childHasKeep && !childContainsKeep) {
      child.setAttribute(READER_HIDDEN, "1");
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
    node.setAttribute(READER_HIDDEN, "1");
    const card = node.closest(sel(reader().cards));
    if (card && !card.closest(keepSelector)) {
      card.setAttribute(READER_HIDDEN, "1");
    }
  });
}

function markReaderKeepSubtree(node) {
  if (!node) {
    return;
  }
  node.setAttribute(READER_KEEP, "1");
  node.querySelectorAll("*").forEach((child) => {
    child.setAttribute(READER_KEEP, "1");
  });
}

function markReaderKeepPath(node) {
  let current = node;
  while (current && current !== document.body) {
    current.setAttribute(READER_KEEP, "1");
    current = current.parentElement;
  }
  document.body.setAttribute(READER_KEEP, "1");
}

function findReaderTitleContainer() {
  const title = queryFirst([...reader().title, "h1", "[data-title]"]);
  if (!title) {
    return null;
  }
  return title;
}

// A class naming a floating (mini, picture-in-picture) player. YouTube puts ytp-rounded-miniplayer-not-regular-wide-video
// on every player of a vertical video in place: taking it for a mini player collapsed the watch page's player to 0px.
function hasFloatingPlayerClass(node) {
  const className = typeof node?.className === "string" ? node.className : "";
  return /mini|picture|float|fixed-player/i.test(className.replace(/\bytp-rounded-miniplayer-not-regular-wide-video\b/g, ""));
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
  const fixedLike = computed.position === "fixed" || hasFloatingPlayerClass(playerHost);
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
    // A new host goes through the mount, which cleans up the one it replaces.
    if (host && host !== state.readingPlayerHost) {
      queueEnsureReaderPlayerMounted();
    } else if (host) {
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
  if (!state.readingViewOpen || !playerHost || isListPlayerPage()) {
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
  if (!state.readingViewOpen || isListPlayerPage()) {
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
    if (!state.readingViewOpen || isListPlayerPage()) {
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
  // Restoring runs after the close too: it only undoes what was marked forced.
  if ((visible && !state.readingViewOpen) || !playerHost) {
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
  if (!state.readingViewOpen || !playerHost || isListPlayerPage()) {
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
  // Closed or remounted on another host meanwhile: forcing this one's controls would stick on a page node.
  if (!state.readingViewOpen || playerHost !== state.readingPlayerHost) {
    return false;
  }
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
  if (!state.readingViewOpen || !isListPlayerPage() || !playerHost) {
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
  life.signal.addEventListener("abort", () => observer.disconnect());
}

function bindPlayerAiQuickActionLayoutEvents() {
  const schedule = () => schedulePlayerAiQuickActionSync(80);
  const opts = { passive: true, signal: life.signal };
  window.addEventListener("resize", schedule, opts);
  window.addEventListener("scroll", schedule, opts);
  window.addEventListener("pageshow", schedule, opts);
  document.addEventListener("fullscreenchange", schedule, opts);
  document.addEventListener("webkitfullscreenchange", schedule, opts);
  window.visualViewport?.addEventListener?.("resize", schedule, opts);
}

// Throttled, not debounced, like the focus-mode player observer: danmaku mutate the page nonstop, and a debounce
// would never run. A call while one is pending joins it.
function schedulePlayerAiQuickActionSync(delayMs = 120) {
  if (state.playerAiQuickActionSyncTimer) {
    return;
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
  if (!state.settings?.enablePlayerAiQuickAction || !state.settings.hasAiProvider || isReaderMode()) {
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
    button.title = AI_SUMMARY;
    button.setAttribute("aria-label", AI_SUMMARY);
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
}

function removePlayerAiQuickActionButton() {
  if (state.playerAiQuickActionCursorHideTimer) {
    window.clearTimeout(state.playerAiQuickActionCursorHideTimer);
    state.playerAiQuickActionCursorHideTimer = 0;
  }
  document.getElementById("mdg-player-ai-quick-action")?.closest(".mdg-player-ai-wrap")?.remove();
}

// Bound once per player host (the wrap is rebuilt and moved): the listeners act on the wrap the host holds now.
function bindPlayerAiQuickActionCursorSync(wrap) {
  const host = wrap.parentElement;
  if (!host || host.__mdgPlayerAiCursorBound) {
    return;
  }
  const currentWrap = () => {
    const node = document.getElementById("mdg-player-ai-quick-action")?.closest(".mdg-player-ai-wrap");
    return node?.parentElement === host ? node : null;
  };
  const hideImmediately = () => {
    window.clearTimeout(state.playerAiQuickActionCursorHideTimer);
    state.playerAiQuickActionCursorHideTimer = 0;
    currentWrap()?.classList.remove("is-active");
  };
  const showForCursorActivity = () => {
    const node = currentWrap();
    if (!node || isReaderMode()) {
      node?.classList.remove("is-active");
      return;
    }
    node.classList.add("is-active");
    window.clearTimeout(state.playerAiQuickActionCursorHideTimer);
    state.playerAiQuickActionCursorHideTimer = window.setTimeout(hideImmediately, 1900);
  };
  host.addEventListener("mousemove", showForCursorActivity, { passive: true });
  host.addEventListener("mouseenter", showForCursorActivity, { passive: true });
  host.addEventListener("mouseleave", hideImmediately, { passive: true });
  host.addEventListener("pointermove", showForCursorActivity, { passive: true });
  host.__mdgPlayerAiCursorBound = true;
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

// The player ✦ and 专注模式's AI 总结 (source reader): the background opens the side panel on this video. The
// background checks the ✦ AI 总结按钮 setting (one check for every sender) and answers why when it is off. A failure is red
// on the page, not statusText: that is the popup's status line, which would show it long after, maybe over another
// video. Resolves whether the panel opened.
async function askSidepanel(source) {
  try {
    const resp = await sendRuntimeMessage({ type: "player-ai-quick-action", ...(source && { source }), contextRef: await viewerContextRef() });
    if (!resp?.ok) throw MdgErrors.fromResp(resp);
    return true;
  } catch (error) {
    setReadingNotice(MdgErrors.reloaded(error) ? MdgErrors.TEXT.reloaded : `${MdgErrors.TEXT.sidepanelOpenFailed}：${MdgErrors.messageOf(error)}`, { error: true });
    return false;
  }
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
    await askSidepanel();
  } finally {
    state.playerAiQuickActionSubmitting = false;
    if (button) {
      button.disabled = false;
    }
  }
}

// The video playing in 分拣台's viewer, in the shape 分拣台's 问 AI hands the side panel; null in a normal tab. A 番剧's URL
// names none: its player does (the click's user activation outlasts that one round trip).
async function viewerContextRef() {
  const ref = IN_VIEWER ? MdgSites.parseRef(location.href) || (await readPlayerRef().catch(() => null)) : null;
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
    const isPlayerLayoutNode = current.matches?.(sel(reader().playerLayout));
    const isExplicitMiniNode = current.matches?.(
      sel([...reader().miniPlayer, "[class*='mini-player']", "[class*='picture-in-picture']"])
    );
    const hasFloatingPosition = computed.position === "fixed" || computed.position === "sticky";
    const isMiniLike =
      hasFloatingPosition ||
      hasFloatingPlayerClass(current) ||
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
    if (!state.readingViewOpen) {
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
  // Checked every tick, so the hint goes as soon as following may resume, not at the next line.
  readerFollowHeld();
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
  return MdgSites.chapterRanges(state.chapters || []).findIndex((item) => currentTime >= item.from && currentTime < item.to);
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
    if (readerFollowHeld()) {
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

// Only the rail scrolls, sideways: scrollIntoView would scroll the page too.
function scrollReadingRailItemIntoView(node) {
  const rail = byId(ids.readingChapterList);
  const railRect = rail.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  const delta = rect.left < railRect.left ? rect.left - railRect.left : rect.right > railRect.right ? rect.right - railRect.right : 0;
  if (!delta) {
    return;
  }
  guardProgrammaticScroll(600);
  rail.scrollTo({ left: rail.scrollLeft + delta, behavior: "smooth" });
}

function scrollReadingTranscriptItemIntoView(node) {
  if (!node) {
    return;
  }

  const transcriptList = byId(ids.readingTranscriptList);
  const inlineHost = document.getElementById(ids.readingInlineHost);
  const listRect = transcriptList.getBoundingClientRect();
  const itemRect = node.getBoundingClientRect();
  // Not laid out (hidden): nothing to scroll to.
  if (!(listRect.height > 0) || !(itemRect.height > 0)) {
    return;
  }

  const behavior = state.readingNextScrollBehavior === "auto" ? "auto" : "smooth";
  guardProgrammaticScroll(behavior === "auto" ? 120 : 800);
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
    setReadingNotice(NO_PLAYER, { error: true });
    return;
  }
  // A jump that works answers the last one that found no player.
  if (byId(ids.readingStatus).textContent === NO_PLAYER) setReadingNotice("");

  state.readingFollowPaused = false;
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
    settledClip(true).catch(readerReadFailed);
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

function noteManualReaderInteraction() {
  if (state.readingAutoScroll) {
    state.readingFollowPaused = true;
    state.readingLastInputAt = Date.now();
  }
  updateReaderFollowState();
}

// Once the reader scrolls, clicks or types in focus mode's lists, the transcript stops following the video. It
// follows again by itself only when the playing line is back in view (scrolled back to, or caught up with), the
// reader has left the lists alone for a moment and no text is selected there; a jump or 回到当前 resumes it at once.
// No timeout: the reader may read back for minutes, and the hint offers 回到当前.
function readerFollowHeld() {
  if (!state.readingFollowPaused) {
    return false;
  }
  const selection = window.getSelection?.();
  const selecting = selection && !selection.isCollapsed && byId(ids.readingTranscriptList).contains(selection.anchorNode);
  if (selecting || Date.now() - state.readingLastInputAt < READER_FOLLOW_IDLE_MS || !readingActiveLineInView()) {
    return true;
  }
  state.readingFollowPaused = false;
  return false;
}

function readingActiveLineInView() {
  const node = byId(ids.readingTranscriptList).querySelector(".mdg-reading-item.is-active");
  const rect = node?.getBoundingClientRect();
  if (!(rect?.height > 0)) {
    return false;
  }
  const host = document.getElementById(ids.readingInlineHost);
  const box = host && host.scrollHeight > host.clientHeight + 8 ? host.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  return rect.top >= box.top && rect.bottom <= box.bottom;
}

function updateReaderFollowState() {
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  // Following only moves a playing video's transcript, so the hint waits for playback.
  const manual = state.readingFollowPaused && !state.readingVideoEl?.paused;
  const mode = !state.readingAutoScroll ? "off" : manual ? "manual" : "auto";
  if (readingView.getAttribute("data-mdg-reader-follow") !== mode) {
    readingView.setAttribute("data-mdg-reader-follow", mode);
  }
}

function computeCurrentClipSignature(url = location.href) {
  const ref = MdgSites.parseRef(url);
  if (ref) {
    return [ref.site, ref.id, ref.part?.index || 1, ref.part?.oid || ""].join("|");
  }
  // A page whose URL names no video (sites.js playerRef) changes video with its path, or in place (checkPlayerChange).
  return MdgSites.matchPage(url) ? new URL(url).pathname : "";
}

// The video the player has loaded on a page whose URL names none, null while it has not (sites.js playerRef).
async function readPlayerRef() {
  return currentSite()?.playerRef?.(location.href, await siteIo().readPlayer()) || null;
}

// The player may still be loading, or be on the last episode right after an in-page switch: asked again for 10 秒.
async function waitPlayerRef(run) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ref = await readPlayerRef();
    if (ref) {
      return ref;
    }
    await sleep(500);
    run.check();
  }
  return null;
}

// The language setting is YouTube's only; Bilibili keeps the default order.
function subtitleLangTarget() {
  return state.site === "youtube" ? MdgSettings.normalizeSubtitleLang(state.settings?.youtubeSubtitleLang) : "auto";
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
// Every request goes under the run's signal: a video change ends them, not only ignores their answers.
function siteIo(run = clipRuns.current) {
  const { signal } = run;
  return {
    doc: document,
    subtitleLang: subtitleLangTarget(),
    readPlayer: async () => {
      const resp = await sendRuntimeMessage({ type: "page-player" });
      if (!resp?.ok) {
        throw MdgErrors.fromResp(resp, "读取播放器失败");
      }
      return resp.data;
    },
    capturePot: (videoId) => ytCapturePot(videoId, run),
    fetchJson: (url) => (currentSite()?.pageOnly ? fetchJson(url, signal) : fetchJsonInBackground(url, signal)),
    fetchText: async (url) => (await fetchOk(url, { credentials: "include", signal })).text(),
    postJson: async (url, body, headers = {}) =>
      (
        await fetchOk(url, {
          method: "POST",
          credentials: "include",
          signal,
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
// youtube.com timedtext URLs. Captures queue up: two reads toggling the button at once would each take the other's
// click for the state they found and leave captions flipped.
// A capture queued behind another may find its video gone (run ended): it leaves the button alone.
let potQueue = Promise.resolve();
function ytCapturePot(videoId, run) {
  const capture = potQueue.then(() => capturePot(videoId, run));
  potQueue = capture.catch(() => {});
  return capture;
}

async function capturePot(videoId, run) {
  let pot = MdgSites.ytPotFromUrls(performance.getEntriesByType("resource").map((entry) => entry.name), videoId);
  const button = document.querySelector("#movie_player .ytp-subtitles-button");
  if (pot || !button) {
    return pot;
  }
  run.check();
  const wasOn = button.getAttribute("aria-pressed") === "true";
  // Right after load the player may not fetch captions on the first click yet; a second round a few seconds later does.
  for (let attempt = 0; attempt < 2 && !pot; attempt += 1) {
    run.check();
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

function cleanVideoUrl() {
  return MdgSites.videoUrl({ ...state, url: location.href });
}


async function fetchHotComments() {
  const site = currentSite();
  const ref = currentRef();
  if (!site?.fetchComments || !ref) {
    return [];
  }
  return site.fetchComments(ref, state.meta, siteIo());
}

// A failed fetch in the user's words: a dropped connection is named (fetch's English TypeError becomes TEXT.netDown);
// codes with their own words (THROTTLED, 62004) read as elsewhere, any other
// error keeps its own message (「B站请求失败 HTTP 403」 from the background or the page, httpError).
function fetchErrorText(error) {
  if (/failed to fetch|networkerror|load failed/i.test(String(error?.message ?? ""))) {
    return MdgErrors.TEXT.netDown;
  }
  return MdgErrors.messageOf(error);
}

// For logs and retry checks only: the raw message (or the string thrown) with its code. The page shows MdgErrors.messageOf.
const rawErrorText = (error) => `${typeof error === "string" ? error : error?.message || ""}${error?.code ? ` (code: ${error.code})` : ""}`;

// MV3's promise form; async turns the synchronous throw of a reloaded extension into a rejection too.
async function sendRuntimeMessage(message) {
  return chrome.runtime.sendMessage(message);
}

// 去设置 on the page's notice. Red on the page, not the popup's status line: the popup has closed by now (the 该笔记已存在
// dialog took the focus).
async function requestOpenOptions() {
  try {
    const resp = await sendRuntimeMessage({ type: "open-options" });
    if (!resp?.ok) throw MdgErrors.fromResp(resp);
  } catch (error) {
    setReadingNotice(MdgErrors.reloaded(error) ? MdgErrors.TEXT.reloaded : `${MdgErrors.TEXT.settingsOpenFailed}：${MdgErrors.messageOf(error)}`, { error: true });
  }
}

// Rejects when the background does not answer: a read or a 写入 Obsidian must not go on with the defaults (another
// note format, another folder) as if they were the user's.
async function getSettings() {
  const hasAiProvider = await loadHasAiProvider();
  const response = await sendRuntimeMessage({ type: "get-settings" });
  if (!response?.ok) {
    throw MdgErrors.fromResp(response, MdgErrors.TEXT.settingsReadFailed);
  }
  return { ...DEFAULT_SETTINGS, ...(response.settings || {}), hasAiProvider };
}

// The player's AI button waits for a platform so it does not sit on every video unasked; get-settings does not carry
// the platform list. The focus-mode one always shows: opening focus mode is already asking to read the video.
async function loadHasAiProvider() {
  try {
    const { [MdgLimits.KEYS.aiProviderList]: aiProviders } = await chrome.storage.sync.get({ [MdgLimits.KEYS.aiProviderList]: [] });
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


async function retryAsync(task, retries = 1, delayMs = 180) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      // A limit (MdgSites.isLimit): retrying at once only digs deeper, and it fails the read (runRefreshClip).
      if (MdgSites.isLimit(error)) {
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
      const backoffDelay = Math.min(delayMs * 2 ** attempt, 5000);
      logInfo(`[MDG] retrying after ${backoffDelay}ms, attempt ${attempt + 1}/${retries}`, {
        error: rawErrorText(error),
        code: error.code
      });
      await sleep(backoffDelay);
    }
  }
  throw lastError || new Error("Unknown retry error");
}

// An HTTP answer by its status: only a server error may pass on a retry (403, 404 stay what they are). Without one, a
// dropped connection or a timeout: the background's NETWORK, or the words fetch and fetchOk throw.
function isRetryableNetworkError(error) {
  if (error?.status) {
    return error.status >= 500;
  }
  if (error?.code === "NETWORK") {
    return true;
  }
  const message = rawErrorText(error).toLowerCase();
  return ["failed to fetch", "fetch failed", "networkerror", "net::", "timeout", "timed out", "超时", MdgErrors.TEXT.netDown].some((words) => message.includes(words));
}

function readRuntimeVideoDuration() {
  const video = getRuntimeVideoElement();
  const duration = Number(video?.duration);
  if (Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  return 0;
}

async function fetchJson(url, signal) {
  return (await fetchOk(url, { credentials: "include", signal })).json();
}

// A hung request would keep refreshPromise pending, and with it the popup's refresh and sidepanel-get-context, so
// every page fetch gives up after MdgErrors.NET_TIMEOUT_MS, with the background's words (fetch-json says the same).
// init.signal (the run's) ends it too: fetch rejects with its STALE_RUN reason.
async function fetchOk(url, init) {
  let response;
  const timeout = AbortSignal.timeout(MdgErrors.NET_TIMEOUT_MS);
  try {
    response = await fetch(url, { ...init, cache: "no-store", signal: init?.signal ? anySignal([timeout, init.signal]) : timeout });
  } catch (error) {
    throw error?.name === "TimeoutError" ? new Error(MdgErrors.netTimeout(MdgErrors.NET_TIMEOUT_MS)) : error;
  }
  if (!response.ok) {
    throw httpError(response.status);
  }
  return response;
}

// A signal aborted (with its reason) when any of the given ones is. AbortSignal.any needs Chrome 116; the side panel
// runs from 114.
function anySignal(signals) {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

// In the background's words for the same failure (triageBiliJson's 「B站请求失败 HTTP 403」), named after the site.
function httpError(status) {
  const site = currentSite()?.label || "";
  const who = /[A-Za-z]$/.test(site) ? `${site} ` : site;
  return Object.assign(new Error(`${who}请求失败 HTTP ${status}`), { status });
}

// The run's abort ends the wait here and tells the background to abort its request (fetch-json-cancel, by this page's
// id). The listener goes when the answer comes, so a later abort of the run cancels nothing and rejects nothing.
let proxiedFetchSeq = 0;
async function fetchJsonInBackground(url, signal) {
  const id = ++proxiedFetchSeq;
  let cancel = () => {};
  try {
    signal?.throwIfAborted();
    const cancelled = new Promise((_, reject) => {
      cancel = () => {
        reject(signal.reason);
        sendRuntimeMessage({ type: "fetch-json-cancel", id }).catch(() => {});
      };
    });
    signal?.addEventListener("abort", cancel, { once: true });
    const resp = await Promise.race([sendRuntimeMessage({ type: "fetch-json", url, id }), cancelled]);
    if (!resp?.ok) {
      // code: THROTTLED (412) and NETWORK, as triageBiliGetJson says them; status: 429 waits in pageSubtitleSite.
      throw Object.assign(MdgErrors.fromResp(resp, "后台请求失败"), { status: resp?.status, code: resp?.code });
    }
    return resp.data;
  } catch (error) {
    if (MdgErrors.reloaded(error)) {
      throw new Error(MdgErrors.TEXT.reloaded);
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
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

// The 分拣台 summary, the video's 备注 and its 分拣 tags, so this note matches what 分拣台 writes for the video.
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
          MdgNote.buildMarkdown({ ...state, userTags: state.triageExtras?.userTags, starred: state.triageExtras?.starred }, body, state.settings, currentRef()),
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
// A failed comment read is said in the popup's status (commentsFailure, readDoneText); the note goes without them.
async function refreshDerivedContent() {
  const run = clipRuns.current;
  let hotComments = state.hotComments;
  let commentsFailure = "";
  if (state.settings?.includeHotCommentsInNote || state.subtitleFetchState === "empty") {
    const shouldFetchComments = !Array.isArray(hotComments) || hotComments.length === 0;
    if (shouldFetchComments) {
      try {
        hotComments = await fetchHotComments();
      } catch (error) {
        hotComments = [];
        commentsFailure = failureReason(error);
        logWarn("[MDG] failed to fetch hot comments for note export", error);
      }
    }
  }
  const aiTurns = await loadAiTurns();
  const triageExtras = await loadTriageExtras();
  const pathsKey = MdgLimits.KEYS.obsidianNotePaths;
  let notePaths = {};
  try {
    notePaths = (await chrome.storage.local.get(pathsKey))[pathsKey] || {};
  } catch {}
  if (!run.alive) {
    return;
  }
  // Two overlapping refreshes of one video: comments one of them got are not replaced by the other's failure.
  if (hotComments.length || !state.hotComments?.length) {
    Object.assign(state, { hotComments, commentsFailure });
  }
  Object.assign(state, { aiTurns, triageExtras, notePaths });
  rebuildDerivedContent();
}
}
