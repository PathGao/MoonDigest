// Shared modules must load before the top-level code below reads them (e.g. MdgLimits).
importScripts("common.js", "errors.js", "limits.js", "settings.js", "sites.js", "tag-core.js", "note.js", "triage/shared.js");

// Side panel stream watchdog: "first" until any SSE chunk arrives (reasoning chunks count), then "idle" between chunks.
const STREAM_TIMEOUT_MS = { first: 90000, idle: 60000 };
const AI_TEST_TIMEOUT_MS = 30000;
const LEGACY_DEFAULT_AI_SYSTEM_PROMPT = [
  "你是一名专业的视频内容分析助手。基于字幕与评论提炼高价值信息，不要复述内容，不要输出思考过程或 think 标签。",
  "优先输出：主题与核心观点、关键数据与事实、逻辑链路与重要结论、可执行建议。",
  "回答应结构化、信息密度高、便于收藏和复习；自动过滤广告、废话和重复表达。",
  "信息不足时明确说明，不得猜测或编造；涉及专业内容时，区分事实、数据、推测与作者观点。",
  "输出时间戳时请使用普通正文格式，如 09:15、01:09:15，不要使用反引号、代码块或表格代码格式包裹时间戳。"
].join("\n");
const EXPECTED_CONTENT_SCRIPT_VERSION = chrome.runtime.getManifest().version || "";
// content.js has two manifest entries with the same files: Bilibili video pages also run in 分拣台's viewer frame.
const READER_ENTRIES = chrome.runtime.getManifest().content_scripts.filter((entry) => entry.js.includes("content.js"));
const READER_SCRIPTS = { ...READER_ENTRIES[0], matches: READER_ENTRIES.flatMap((entry) => entry.matches) };
// The marks on B站 pages (badges.js) run in every frame.
const BADGES_SCRIPTS = chrome.runtime.getManifest().content_scripts.find((entry) => entry.js.includes("badges.js"));

// The 3.6 storage key rename (MdgLimits.migrateRenamedKeys). Runs on update and on every browser start until nothing is left to move.
async function migrateRenamedStorage() {
  await MdgLimits.migrateRenamedKeys(chrome.storage.local);
  if (chrome.storage.session) await MdgLimits.migrateRenamedKeys(chrome.storage.session);
}
chrome.runtime.onStartup.addListener(() => void migrateRenamedStorage());

chrome.runtime.onInstalled.addListener(async () => {
  await migrateRenamedStorage();
  await initializeSettingsStorage();
  // Chrome leaves tabs opened before an install or update without our content script, and an
  // update leaves the old copy running with a dead chrome.runtime. The fresh copy replaces it
  // (content.js and badges.js each tell the old copy to stand down).
  const [readerTabs, badgeTabs] = await Promise.all([READER_SCRIPTS, BADGES_SCRIPTS].map((entry) => chrome.tabs.query({ url: entry.matches })));
  await Promise.allSettled([
    ...readerTabs.map((tab) => injectReaderContent(tab.id)),
    ...badgeTabs.map((tab) => injectEntry(tab.id, BADGES_SCRIPTS))
  ]);
});

async function ensureReaderContentReady(tabId) {
  if (!chrome.scripting || !tabId) {
    return;
  }

  const loadedVersion = await probeContentScriptVersion(tabId);
  if (loadedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
    return;
  }

  // Each extension load runs in a fresh isolated world, so the probe never sees an older copy. A failed injection
  // (Chrome's error page) words its failure below, not in Chrome's English.
  await injectReaderContent(tabId).catch(() => {});
  const reinjectedVersion = await probeContentScriptVersion(tabId);
  if (reinjectedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
    return;
  }

  // The reason only: the popup says MdgErrors.TEXT.readerStartFailed in front of it.
  throw new Error("扩展脚本未能和当前页面同步");
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeContentScriptVersion(tabId) {
  try {
    const probe = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__MDG_CONTENT_SCRIPT_LOADED__ || ""
    });
    return String(probe?.[0]?.result || "");
  } catch {
    return "";
  }
}

function injectReaderContent(tabId) {
  return injectEntry(tabId, READER_SCRIPTS);
}

// A manifest content_scripts entry into an open tab: every frame for an all_frames entry.
// ponytail: all_frames goes to every frame we have host access to, not only the entry's matches; badges.js finds nothing to mark elsewhere.
async function injectEntry(tabId, entry) {
  const target = { tabId, allFrames: Boolean(entry.all_frames) };
  await chrome.scripting.insertCSS({ target, files: entry.css });
  await chrome.scripting.executeScript({ target, files: entry.js });
}

async function sendMessageToTab(tabId, message, options = {}) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, options, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

// The video page's content script did not answer: the reason (专注模式), or with what to do (the side panel).
const PAGE_SILENT = "视频页没有回应";
const PAGE_SILENT_RETRY = `${PAGE_SILENT}，${MdgErrors.TEXT.reloadRetry}`;

async function triggerReaderModeInTab(tabId, readerUrl = "", retries = 12, delayMs = 300) {
  const videoId = MdgSites.parseRef(readerUrl)?.id;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) {
      await sleep(delayMs);
      // The tab moved on to another page while we waited: its page must not be sent back to this video.
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (MdgSites.parseRef(tab?.url || "")?.id !== videoId) return false;
    }

    try {
      const response = await sendMessageToTab(tabId, {
        type: "popup-trigger-reading-view",
        readerUrl
      });
      if (response?.ok) {
        return true;
      }
    } catch (error) {
      const message = String(error?.message || "");
      if (message.includes("Could not establish connection. Receiving end does not exist.")) {
        try {
          await ensureReaderContentReady(tabId);
        } catch {
          // keep retrying
        }
        continue;
      }
    }
  }

  return false;
}

// frameId: 分拣台's viewer frame (the tab is 分拣台), asked for its video like a video page. A frame that closed or
// plays another video than videoId does not answer, and the side panel reads the video like a closed page instead.
async function getAiSidepanelState(tabId, { refresh = false, frameId = 0, videoId = "" } = {}) {
  if (!tabId) {
    throw new Error(MdgErrors.TEXT.noTab);
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id) {
    throw new Error(MdgErrors.TEXT.noTab);
  }

  const inViewer = frameId > 0;
  if (!inViewer && !MdgSites.matchSite(tab.url)) {
    return {
      title: String(tab.title || "").trim(),
      url: String(tab.url || "").trim(),
      author: "",
      uploadDate: "",
      subtitleMarkdown: "",
      hotComments: [],
      isVideoContext: false
    };
  }
  // The viewer's content script came with the 分拣台 page, which an extension update reloads.
  if (!inViewer) await ensureReaderContentReady(tab.id);

  // The page settles its current video (joins a run, follows a URL change) and answers with its comments.
  // Chrome's English messaging errors (no content script, the port closed) all mean the page did not answer.
  const resp = await sendMessageToTab(tab.id, { type: "sidepanel-get-context", refresh, videoId }, inViewer ? { frameId } : {}).catch(() => {
    throw new Error(PAGE_SILENT_RETRY);
  });
  if (!resp?.ok || !resp.payload) {
    throw Object.assign(new Error(MdgErrors.text(resp, "读取当前页面失败")), resp?.code != null ? { code: resp.code } : {});
  }
  return { ...resp.payload, url: MdgSites.videoUrl(resp.payload), isVideoContext: true };
}

async function openAiSidepanelForTab(tabId) {
  if (chrome.sidePanel?.open) {
    await chrome.sidePanel.open({ tabId });
    return;
  }

  throw new Error("当前浏览器不支持扩展侧边栏");
}

const FETCH_TIMEOUT_MS = 15000;

// Obsidian's Local REST API and the cover images written into the vault; a hung request would block the write forever.
// status 408 is what obsidianError reads as OBSIDIAN_DOWN. The timeout also covers reading the body, so a body that
// stalls is the same 408 as headers that never come.
async function fetchWithTimeout(url, options = {}, ms = FETCH_TIMEOUT_MS) {
  const timedOut = (error) => {
    if (error?.name !== "TimeoutError") return error;
    return Object.assign(new Error(`请求超时：${ms / 1000} 秒没有响应`), { status: MdgErrors.TIMEOUT_STATUS });
  };
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
  } catch (error) {
    throw timedOut(error);
  }
  for (const m of ["json", "text", "arrayBuffer", "blob"]) {
    const read = res?.[m];
    if (typeof read === "function") res[m] = (...args) => Promise.resolve().then(() => read.apply(res, args)).catch((error) => Promise.reject(timedOut(error)));
  }
  return res;
}

function refFromAiContext(ref) {
  const site = MdgSites.SITES[ref.site];
  if (!site || !ref.videoId) {
    return null;
  }
  return {
    site: site.id,
    id: ref.videoId,
    part: { index: ref.pageIndex, cid: ref.cid, explicit: true },
    url: site.canonicalUrl(ref.videoId, ref.pageIndex)
  };
}

function findTabForRef(ref) {
  return chrome.tabs.query({}).then((tabs) =>
    tabs.find((tab) => {
      const parsed = MdgSites.parseRef(tab.url || "");
      return parsed && parsed.site === ref.site && parsed.id === ref.id;
    }) || null
  );
}

async function resolveAiSidepanelContext(contextRef) {
  const ref = MdgSites.contextRef(contextRef);
  const videoRef = ref.isVideoContext ? refFromAiContext(ref) : null;
  if (!videoRef) {
    return {
      title: ref.title,
      url: ref.url,
      author: ref.author,
      uploadDate: ref.uploadDate,
      subtitleMarkdown: "",
      hotComments: [],
      isVideoContext: false
    };
  }

  const site = MdgSites.SITES[videoRef.site];
  // Sites whose API only answers from inside the page are read through an open tab.
  if (site.pageOnly) {
    const tab = await findTabForRef(videoRef);
    if (!tab?.id) {
      throw new Error(`请先打开这个 ${site.label} 视频页，再继续这段对话`);
    }
    // The page answers only while it still shows this video.
    return getAiSidepanelState(tab.id, { videoId: videoRef.id });
  }

  const settings = await getMergedSettings();
  // Only bilibili gets here (YouTube is pageOnly): the channel 细看 and 分拣台 notes read through (signed, one try,
  // risk control as THROTTLED), so a B站 limit fails the follow-up as a limit instead of reading as 没有字幕.
  const io = TRIAGE_BILI_IO;
  const meta = await site.fetchMeta(videoRef, io);
  // Like the video page: the chosen track first, then the others (MdgSites.loadSubtitle). A B站 limit fails the
  // follow-up; a failed track list or download, like tracks with only empty bodies, leaves the AI the title, description
  // and comments, with the reason in subtitleFailure (the side panel and the AI read it as 字幕抓取失败).
  const found = await MdgSites.loadSubtitle(site, videoRef, meta, io, {
    prefer: { previousId: ref.selectedSubtitleId, previousUrl: ref.selectedSubtitleUrl, previousLang: ref.subtitleLang }
  });
  const { track, body, bundle } = found;
  const subtitleWarning = found.mismatch ? MdgNote.subtitleMismatchWarning(found.mismatch) : "";

  const hotComments = site.fetchComments ? await site.fetchComments(videoRef, meta, io).catch(() => []) : [];
  const title = String(meta.title || ref.title || "").trim();
  // The same note the video page sends (content.js buildSidepanelContext), with the fields its state carries.
  const noteMeta = { ...MdgNote.noteMetaOf({ site: site.id, videoId: videoRef.id, meta, bundle, track }), title };
  const subtitleLang = noteMeta.selectedSubtitleLang;
  const noteRef = { site: site.id, id: videoRef.id, part: { index: meta.pageIndex || 1, cid: meta.cid }, url: MdgSites.videoUrl({ ...meta, site: site.id, videoId: videoRef.id }) };
  return {
    title,
    url: noteRef.url,
    author: String(meta.author || ref.author || "").trim(),
    uploadDate: String(meta.uploadDate || ref.uploadDate || "").trim(),
    site: site.id,
    videoId: videoRef.id,
    cid: String(meta.cid || ""),
    aid: String(meta.aid || ""),
    pageIndex: meta.pageIndex || 1,
    // A P1 conversation note is named 「 P1」 when the video has parts (MdgNote), as with the video page open.
    pageCount: meta.pageCount || 0,
    pageTitle: String(meta.pageTitle || ref.pageTitle || "").trim(),
    description: String(meta.description || ""),
    subtitleLang,
    selectedSubtitleId: String(track?.id || "").trim(),
    selectedSubtitleUrl: String(track?.url || "").trim(),
    subtitleWarning,
    subtitleFailure: found.failure,
    subtitleMarkdown: body.length ? MdgNote.buildAiContext(noteMeta, body, settings, noteRef) : "",
    // No list because B站 wants a login: the side panel says so instead of 没有字幕, like on the video page.
    subtitleNeedLogin: found.needLogin,
    hotComments,
    isVideoContext: true
  };
}

async function resolveAiSidepanelPageRef(contextRef) {
  const ref = MdgSites.contextRef(contextRef);
  const videoRef = ref.isVideoContext ? refFromAiContext(ref) : null;
  const site = videoRef ? MdgSites.SITES[videoRef.site] : null;
  const fallback = {
    url: videoRef?.url || ref.url,
    site: ref.site,
    videoId: ref.videoId,
    cid: ref.cid,
    pageIndex: ref.pageIndex,
    pageCount: ref.pageCount,
    pageTitle: ref.pageTitle
  };
  if (!site || site.pageOnly) {
    return fallback;
  }
  const meta = await site.fetchMeta(videoRef, TRIAGE_BILI_IO);
  return {
    ...fallback,
    url: MdgSites.videoUrl({ ...meta, site: site.id, videoId: videoRef.id }),
    cid: String(meta.cid || ref.cid || ""),
    pageIndex: meta.pageIndex || ref.pageIndex,
    pageCount: meta.pageCount || 0,
    pageTitle: String(meta.pageTitle || ref.pageTitle || "")
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "get-settings") {
    getMergedSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "save-settings") {
    saveSettings(message.settings || {})
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message, field: error.field }));
    return true;
  }

  if (message.type === "settings-export" || message.type === "settings-import") {
    (message.type === "settings-export" ? exportSettings() : importSettings(message.file))
      .then((file) => sendResponse({ ok: true, file }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // The content script's isolated world cannot reach the player API; a
  // MAIN-world read can, and chrome.scripting is not subject to the page CSP.
  // Only the watch page's own content script may ask, and only for its tab.
  if (message.type === "yt-player-response") {
    const tabId = sender?.tab?.id;
    if (!tabId || !/^https:\/\/www\.youtube\.com\//.test(String(sender.url || ""))) {
      sendResponse({ ok: false, error: "not a YouTube tab" });
      return false;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => document.getElementById("movie_player")?.getPlayerResponse?.() ?? globalThis.ytInitialPlayerResponse ?? null
      })
      .then((results) => sendResponse({ ok: true, data: results?.[0]?.result ?? null }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ensure-reader-content") {
    ensureReaderContentReady(Number(message.tabId) || 0)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // 视频记录, as 分拣台 (triage-open): the popup, the side panel and the settings page focus an open one.
  if (message.type === "history-open") {
    focusOrOpenPage(chrome.runtime.getURL(MdgCommon.PAGES.history))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // Focuses a settings page that is already open, as the side panel and 视频记录 do (no caller asks for a section).
  if (message.type === "open-options") {
    chrome.runtime
      .openOptionsPage()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "player-ai-quick-action") {
    const tabId = Number(message.tabId || sender?.tab?.id || 0) || 0;
    if (!tabId) {
      sendResponse({ ok: false, error: MdgErrors.TEXT.noTab });
      return false;
    }

    const openPromise = openAiSidepanelForTab(tabId);
    // Awaited once settings load; without a handler now, a fast rejection is reported as uncaught.
    openPromise.catch(() => {});
    getMergedSettings()
      .then(async (settings) => {
        // The setting hides the player button (no source); the popup's and 专注模式's AI 总结 are always available.
        if (!["popup", "reader"].includes(message.source) && !settings.enablePlayerAiQuickAction) {
          throw new Error("✦ AI 总结按钮未开启");
        }
        await openPromise;
        // From 分拣台's viewer frame: the tab is 分拣台, so the panel takes the video by reference like 问 AI, and
        // asks that frame for it (getAiSidepanelState with frameId).
        const viewer = sender?.frameId && message.contextRef;
        await MdgLimits.askSidepanel({
          tabId,
          prompt: MdgSettings.normalizePlayerAiQuickPrompt(settings.playerAiQuickPrompt),
          contextRef: viewer ? message.contextRef : null,
          frameId: viewer ? sender.frameId : 0
        });
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message || MdgErrors.TEXT.unknown }));
    return true;
  }

  if (message.type === "open-reading-view-tab") {
    const url = String(message.url || "").trim();
    const tabId = Number(message.tabId || 0) || 0;
    if (!url) {
      sendResponse({ ok: false, error: "缺少视频地址" });
      return false;
    }
    if (!tabId) {
      sendResponse({ ok: false, error: MdgErrors.TEXT.noTab });
      return false;
    }

    let readerUrl = "";
    try {
      const parsed = new URL(url);
      if (!MdgSites.matchSite(parsed.href)) {
        throw new Error(MdgErrors.TEXT.notVideoPage);
      }
      parsed.searchParams.set(MdgCommon.READER_PARAM, "1");
      readerUrl = parsed.toString();
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "专注模式的地址无效" });
      return false;
    }

    ensureReaderContentReady(tabId)
      .then(() => triggerReaderModeInTab(tabId, readerUrl))
      .then((triggered) => {
        if (!triggered) {
          // The reason only: the page says MdgErrors.TEXT.readerStartFailed in front of it.
          throw new Error(PAGE_SILENT);
        }
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "fetch-json") {
    const url = typeof message.url === "string" ? message.url : "";
    // The proxy carries the user's cookies, so it only serves the video sites.
    if (!MdgSites.isAllowedFetchUrl(url)) {
      sendResponse({ ok: false, error: "URL not allowed" });
      return false;
    }
    // The same request, timeout and words as 分拣台 and the side panel (triageBiliGetJson, one try); the page retries.
    triageBiliGetJson(url)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message, code: error.code, status: error.status }));
    return true;
  }

  // The settings page validates both fields before it asks.
  if (message.type === "test-obsidian-connection") {
    testObsidianConnection(String(message.baseUrl || "").trim(), String(message.apiKey || "").trim()).then(sendResponse);
    return true;
  }

  if (message.type === "ai-providers-list") {
    loadAiProviders()
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-providers-save") {
    saveAiProviders(message.providers || [])
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-providers-delete") {
    deleteAiProvider(String(message.providerId || ""))
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-providers-test") {
    const baseUrl = String(message.baseUrl || "").trim();
    const providerId = String(message.providerId || "").trim();
    const model = String(message.model || "").trim();
    Promise.resolve()
      .then(async () => {
        const directApiKey = String(message.apiKey || "").trim();
        if (directApiKey) {
          return directApiKey;
        }
        if (!providerId) {
          return "";
        }
        const keys = await loadAiProviderKeys();
        return String(keys[providerId] || "").trim();
      })
      .then((apiKey) => testAiConnection({ baseUrl, apiKey, model, requiresKey: message.requiresKey }))
      .then((resp) => sendResponse(resp))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-sidepanel-get-state") {
    const tabId = Number(message.tabId || 0) || 0;
    getAiSidepanelState(tabId, { refresh: message.refresh === true, frameId: Number(message.frameId) || 0, videoId: String(message.videoId || "") })
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message, code: error.code }));
    return true;
  }

  if (message.type === "ai-sidepanel-resolve-context") {
    resolveAiSidepanelContext(message.contextRef || {})
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message, code: error.code }));
    return true;
  }

  if (message.type === "ai-sidepanel-resolve-page-ref") {
    resolveAiSidepanelPageRef(message.contextRef || {})
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== MdgCommon.CHAT_PORT) {
    return;
  }

  let activeAbortController = null;
  let activeAbortMeta = null;
  let watchdogId = 0;

  const clearWatchdog = () => {
    clearTimeout(watchdogId);
    watchdogId = 0;
  };

  // code: AI_TIMEOUT (no first answer: maybe a wrong address or model, so 去设置) or AI_STALLED (the reply stopped
  // midway: only 重试 helps).
  const armWatchdog = (ms, reason, code) => {
    clearWatchdog();
    watchdogId = setTimeout(() => abortActiveRequest({ type: "timeout", reason, code }), ms);
  };

  const clearActiveRequestState = () => {
    clearWatchdog();
    activeAbortController = null;
    activeAbortMeta = null;
  };

  const abortActiveRequest = (meta = null) => {
    activeAbortMeta = meta;
    clearWatchdog();
    if (activeAbortController && !activeAbortController.signal.aborted) {
      activeAbortController.abort();
    }
  };

  port.onDisconnect.addListener(() => {
    abortActiveRequest({ type: "silent" });
    clearActiveRequestState();
  });

  port.onMessage.addListener(async (msg) => {
    if (!msg) return;
    if (msg.action === "stop") {
      abortActiveRequest({ type: "stopped", reason: MdgErrors.TEXT.aiStopped });
      return;
    }
    if (msg.action !== "chat") return;

    try {
      abortActiveRequest({ type: "silent" });
      clearActiveRequestState();
      activeAbortController = new AbortController();
      armWatchdog(STREAM_TIMEOUT_MS.first, MdgErrors.aiTimeout(STREAM_TIMEOUT_MS.first), "AI_TIMEOUT");
      const providers = await loadAiProviders();
      const provider = providers.find((p) => p.id === msg.providerId);
      if (!provider) {
        port.postMessage({ type: "error", error: "没找到选中的 AI 平台", code: MdgErrors.CODE.AI_SETUP });
        clearActiveRequestState();
        return;
      }
      const keys = await loadAiProviderKeys();
      const apiKey = keys[provider.id] || "";
      const problem = aiProviderProblem(provider, apiKey);
      if (problem) {
        port.postMessage({ type: "error", error: problem.text, code: problem.code });
        clearActiveRequestState();
        return;
      }
      await streamChat({
        provider: { ...provider, apiKey },
        context: msg.context || {},
        userPrompt: msg.prompt || "",
        history: Array.isArray(msg.history) ? msg.history : [],
        port,
        signal: activeAbortController.signal,
        getAbortMeta: () => activeAbortMeta,
        onActivity: () => armWatchdog(STREAM_TIMEOUT_MS.idle, MdgErrors.aiStalled(STREAM_TIMEOUT_MS.idle), "AI_STALLED")
      });
    } catch (e) {
      port.postMessage({ type: "error", error: String(e?.message || e) });
    } finally {
      clearActiveRequestState();
    }
  });
});

// Install and update migrate old keys only. Defaults are never written to sync: every reader fills them in
// (getMergedSettings, sync.get(DEFAULTS)), so a changed default reaches everyone who never set that setting.
async function initializeSettingsStorage() {
  // A missing toggle means an upgrade from before it existed (or a fresh install, which has no key).
  const { obsidianEnabled: storedObsidianEnabled } = await chrome.storage.sync.get("obsidianEnabled");
  await migrateInitialQuickPrompts();
  await removeDeadStorageKeys();
  const localCurrent = await chrome.storage.local.get(MdgSettings.LOCAL_DEFAULTS);

  await chrome.storage.local.set({
    obsidianApiKey: MdgSettings.normalizeApiKey(localCurrent.obsidianApiKey)
  });

  // A configured key means the user was already writing to Obsidian.
  if (typeof storedObsidianEnabled !== "boolean") {
    await chrome.storage.sync.set({ obsidianEnabled: Boolean(MdgSettings.normalizeApiKey(localCurrent.obsidianApiKey)) });
  }
}

// Keys no code reads any more; removing absent keys is a no-op, so this reruns on every install/update.
// The scheme keys and triage_excluded_folders only ever existed in pre-release v2.0 builds. Sync's triageCriteria stays
// after triage's migration: another computer that has not updated yet still reads it.
async function removeDeadStorageKeys() {
  const keys = (await chrome.storage.local.getKeys?.()) ?? Object.keys((await chrome.storage.local.get(null)) || {});
  const dead = ["triage_tab", "triage_read_verdict", "triage_tag_presets", "triage_schemes_migrated", "triage_watched", "triage_schemes", "triage_folder_scheme", "triage_excluded_folders"];
  await chrome.storage.local.remove(keys.filter((k) => dead.includes(k) || k.startsWith("triage_verdict_override_")));
  await chrome.storage.sync.remove(["triageExportFolder", "readerChapterVisibility"]);
}

// aiInitialQuickPrompts (empty-panel chips) merged into aiPresetPrompts, the single follow-up list.
// Initial first; dedupe makes a rerun after a partial write a no-op.
async function migrateInitialQuickPrompts() {
  const { aiInitialQuickPrompts, aiPresetPrompts } = await chrome.storage.sync.get([
    "aiInitialQuickPrompts",
    "aiPresetPrompts"
  ]);
  if (aiInitialQuickPrompts === undefined) {
    return;
  }
  const merged = [...(Array.isArray(aiInitialQuickPrompts) ? aiInitialQuickPrompts : []), ...(Array.isArray(aiPresetPrompts) ? aiPresetPrompts : [])];
  await chrome.storage.sync.set({ aiPresetPrompts: MdgSettings.normalizeAiPresetPrompts(merged) });
  await chrome.storage.sync.remove("aiInitialQuickPrompts");
}

function normalizeSyncSettings(settings) {
  // Every on/off setting by its default, in one place (MdgSettings.normalizeSwitches).
  const merged = MdgSettings.normalizeSwitches(settings);
  merged.downloadFormat = MdgSettings.normalizeDownloadFormat(merged.downloadFormat);
  merged.youtubeSubtitleLang = MdgSites.normalizeSubtitleLang(merged.youtubeSubtitleLang);
  merged.playerAiQuickPrompt = MdgSettings.normalizePlayerAiQuickPrompt(merged.playerAiQuickPrompt);
  // The settings table's cells turned off (bili-surfaces.js); options.js and badges.js drop cells that do not exist.
  merged.biliMarksOff = Array.isArray(merged.biliMarksOff) ? merged.biliMarksOff.filter((c) => typeof c === "string") : [];
  merged.seenShow = MdgSettings.normalizeSeenShow(merged.seenShow);
  merged.seenThreshold = MdgSettings.normalizeSeenThreshold(merged.seenThreshold);
  merged.seenStyle = MdgSettings.normalizeSeenStyle(merged.seenStyle);
  merged.readerTheme = MdgSettings.normalizeReaderTheme(merged.readerTheme);
  merged.readerFontScale = MdgSettings.normalizeReaderFontScale(merged.readerFontScale);
  merged.readerLetterSpacing = MdgSettings.normalizeReaderLetterSpacing(merged.readerLetterSpacing);
  merged.readerLineHeight = MdgSettings.normalizeReaderLineHeight(merged.readerLineHeight);
  merged.readerContentWidth = MdgSettings.normalizeReaderContentWidth(merged.readerContentWidth);
  // options.js and note.js map over it: a settings file may carry anything.
  merged.frontmatterFields = Array.isArray(merged.frontmatterFields) ? merged.frontmatterFields.filter((f) => typeof f === "string") : MdgSettings.DEFAULTS.frontmatterFields;
  merged.fixedFrontmatterProperties = MdgSettings.normalizeFixedFrontmatterProperties(merged.fixedFrontmatterProperties);
  merged.notePlaceholderSections = MdgSettings.normalizeNotePlaceholderSections(merged.notePlaceholderSections);
  merged.aiSystemPrompt = normalizeAiSystemPrompt(merged.aiSystemPrompt);
  merged.aiPresetPrompts = MdgSettings.normalizeAiPresetPrompts(merged.aiPresetPrompts);
  return merged;
}

async function getMergedSettings() {
  const [syncSettings, localSettings] = await Promise.all([
    chrome.storage.sync.get(MdgSettings.DEFAULTS),
    chrome.storage.local.get(MdgSettings.LOCAL_DEFAULTS)
  ]);

  const merged = normalizeSyncSettings({ ...MdgSettings.DEFAULTS, ...syncSettings });
  return {
    ...merged,
    obsidianApiKey: MdgSettings.normalizeApiKey(localSettings.obsidianApiKey)
  };
}

// chrome.storage.sync keeps at most 8 KB per setting (its key plus its JSON, in UTF-8 bytes; QUOTA_BYTES_PER_ITEM):
// about 2700 汉字. Past it Chrome refuses the whole save in English without naming the setting, so it is checked first.
const SYNC_ITEM_BYTES = 8192;
const SYNC_ITEM_NAMES = Object.fromEntries(["aiSystemPrompt", "playerAiQuickPrompt", "aiPresetPrompts", "fixedFrontmatterProperties", "notePlaceholderSections"].map((k) => [k, MdgErrors.LABEL[k]]));
const oversizedSyncItem = (payload) => Object.keys(payload).find((k) => k.length + new TextEncoder().encode(JSON.stringify(payload[k])).length > SYNC_ITEM_BYTES) || "";
// Saving and importing both check before sync.set.
function checkSyncItems(payload) {
  const big = oversizedSyncItem(payload);
  if (big) throw Object.assign(new Error(`${SYNC_ITEM_NAMES[big] || big}太长，存不下：最多约 2700 个汉字（英文约 8000 个字符）`), { field: big });
}

// Callers send partial settings (the options page has no reading-view controls). Only the keys they send are written,
// so two pages saving at once never write back each other's keys from a stale read.
async function saveSettings(settings) {
  const payload = settings && typeof settings === "object" ? settings : {};
  const normalized = normalizeSyncSettings({ ...MdgSettings.DEFAULTS, ...payload });
  const syncPayload = Object.fromEntries(Object.keys(payload).filter((k) => k in normalized && k !== "obsidianApiKey").map((k) => [k, normalized[k]]));
  checkSyncItems(syncPayload);

  await Promise.all([
    chrome.storage.sync.set(syncPayload),
    "obsidianApiKey" in payload && chrome.storage.local.set({ obsidianApiKey: MdgSettings.normalizeApiKey(payload.obsidianApiKey) })
  ]);
}

// Every setting (收藏夹 and 关注 included) lives in sync, except the 分拣台's folder choice (收藏夹设置) and each folder's
// 判断标准, kept in local beside the data; the file carries those as `local`. The sort is a quick toggle, not a setting. Keys and data stay out of the file. The key filter only guards
// against a copy left in sync by an older version.
const SETTINGS_FILE_VERSION = 1;
const { triageIncludedFolders: FOLDERS_KEY, triageFolderCriteria: CRITERIA_KEY } = MdgLimits.KEYS;
const LOCAL_SETTING_KEYS = [FOLDERS_KEY, CRITERIA_KEY];

// API keys stay on this machine (chrome.storage.local): neither the settings file nor sync carries one, whether the
// settings come from sync (export) or from a file (import), and a platform's own apiKey goes too.
function withoutApiKeys({ obsidianApiKey, [AI_PROVIDER_KEYS_STORAGE]: keys, ...settings }) {
  if (Array.isArray(settings[AI_PROVIDERS])) settings[AI_PROVIDERS] = settings[AI_PROVIDERS].map((p) => (p && typeof p === "object" ? (({ apiKey, ...rest }) => rest)(p) : p));
  return settings;
}

async function exportSettings() {
  const [synced, local] = await Promise.all([chrome.storage.sync.get(null), chrome.storage.local.get(LOCAL_SETTING_KEYS)]);
  const settings = withoutApiKeys(synced);
  return {
    app: "moondigest",
    kind: "settings",
    schemaVersion: SETTINGS_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version || "",
    settings,
    local
  };
}

// Replaces every setting with the file's. Set first, then remove the rest, so a failed write (sync quota) changes nothing;
// initializeSettingsStorage then migrates an older file's keys; what it lacks reads as the default. A file without the folder
// choice or the 判断标准 (older than them) leaves the current ones.
async function importSettings(file) {
  const isMap = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  const folders = file?.local?.[FOLDERS_KEY];
  const foldersOk = folders === undefined || (Array.isArray(folders) && folders.every((id) => /^\w+$/.test(String(id))));
  const criteria = file?.local?.[CRITERIA_KEY];
  const criteriaOk = criteria === undefined || (isMap(criteria) && Object.entries(criteria).every(([id, text]) => /^\w+$/.test(id) && typeof text === "string"));
  if (file?.app !== "moondigest" || file.kind !== "settings" || typeof file.schemaVersion !== "number" || !isMap(file.settings) || (file.local !== undefined && !isMap(file.local)) || !foldersOk || !criteriaOk) {
    throw new Error("不是 MoonDigest 的设置文件");
  }
  if (!(file.schemaVersion <= SETTINGS_FILE_VERSION)) throw new Error("这个文件来自更新的版本，先更新 MoonDigest 再导入");
  const settings = withoutApiKeys(file.settings);
  checkSyncItems(settings);
  const current = Object.keys(await chrome.storage.sync.get(null));
  await chrome.storage.sync.set(settings);
  await chrome.storage.sync.remove(current.filter((k) => !(k in settings)));
  if (folders) await chrome.storage.local.set({ [FOLDERS_KEY]: folders.map(String) });
  if (criteria) await chrome.storage.local.set({ [CRITERIA_KEY]: criteria });
  await initializeSettingsStorage();
}

function toString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeAiSystemPrompt(value) {
  const normalized = toString(value).trim();
  if (normalized === LEGACY_DEFAULT_AI_SYSTEM_PROMPT) {
    return MdgSettings.DEFAULTS.aiSystemPrompt;
  }
  return normalized;
}

// ===== AI 模型平台存储 =====

const { aiApiKeys: AI_PROVIDER_KEYS_STORAGE, aiProviderList: AI_PROVIDERS } = MdgLimits.KEYS;

// An AI platform's address as requests use it: no spaces, no trailing slashes.
const trimBaseUrl = (url) => String(url || "").trim().replace(/\/+$/, "");

function normalizeAiProvider(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "").trim();
  if (!id) return null;
  return {
    id,
    presetId: String(item.presetId || "custom"),
    name: String(item.name || "").trim() || MdgErrors.LABEL.customAi,
    baseUrl: trimBaseUrl(item.baseUrl),
    model: String(item.model || "").trim(),
    temperature: typeof item.temperature === "number" ? item.temperature : 0.7,
    requiresKey: item.requiresKey !== false,
    enabled: item.enabled !== false
  };
}

async function loadAiProviders() {
  const [syncData, keys] = await Promise.all([
    chrome.storage.sync.get(AI_PROVIDERS),
    loadAiProviderKeys()
  ]);
  const list = Array.isArray(syncData[AI_PROVIDERS]) ? syncData[AI_PROVIDERS] : [];
  return list
    .map(normalizeAiProvider)
    .filter(Boolean)
    .map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
}

// Saves and deletes each read and rewrite the whole list and key map: one at a time, so neither undoes the other.
let aiProviderWrites = Promise.resolve();
function serialAiProviders(write) {
  const done = aiProviderWrites.then(write);
  aiProviderWrites = done.catch(() => {});
  return done;
}

function saveAiProviders(items) {
  return serialAiProviders(() => writeAiProviders(items));
}
async function writeAiProviders(items) {
  const rawList = Array.isArray(items) ? items : [];
  const keys = await loadAiProviderKeys();
  const nextList = [];
  for (const raw of rawList) {
    const normalized = normalizeAiProvider(raw);
    if (!normalized) continue;
    nextList.push(normalized);
    const incomingKey = String(raw?.apiKey || "").trim();
    if (incomingKey) {
      keys[normalized.id] = incomingKey;
    } else if (raw.hasSavedKey === false) {
      // The settings page dropped the key (the base URL moved to another host): it must not go to the new address.
      delete keys[normalized.id];
    }
  }
  await Promise.all([
    chrome.storage.sync.set({ [AI_PROVIDERS]: nextList }),
    chrome.storage.local.set({ [AI_PROVIDER_KEYS_STORAGE]: keys })
  ]);
  return nextList.map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
}

// Sync keeps the platforms only; whether a key is saved (hasSavedKey) is read from the key map.
function deleteAiProvider(providerId) {
  return serialAiProviders(async () => {
    const list = await loadAiProviders();
    const next = list.filter((p) => p.id !== providerId);
    await chrome.storage.sync.set({ [AI_PROVIDERS]: next.map(({ hasSavedKey, ...p }) => p) });
    const keys = await loadAiProviderKeys();
    if (keys && providerId in keys) {
      delete keys[providerId];
      await chrome.storage.local.set({ [AI_PROVIDER_KEYS_STORAGE]: keys });
    }
    return next;
  });
}

async function loadAiProviderKeys() {
  const localData = await chrome.storage.local.get([AI_PROVIDER_KEYS_STORAGE]);
  const keys = localData?.[AI_PROVIDER_KEYS_STORAGE];
  return keys && typeof keys === "object" ? keys : {};
}

// ===== AI 调用 =====

const { AI_HISTORY_MAX_CHARS, sampleAiSubtitle } = MdgLimits;

// Keeps the newest turns within the budget, starting at a user message.
function trimAiHistory(history) {
  const items = (Array.isArray(history) ? history : []).filter(
    (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
  );
  let start = items.length;
  let total = 0;
  while (start > 0 && total + items[start - 1].content.length <= AI_HISTORY_MAX_CHARS) {
    start -= 1;
    total += items[start].content.length;
  }
  while (start < items.length && items[start].role !== "user") {
    start += 1;
  }
  return { messages: items.slice(start), dropped: start };
}

// Returns the request messages plus notices for the user about what was cut to fit.
function buildAiMessages({ context, userPrompt, history, systemPrompt }) {
  const ctx = context || {};
  const subtitle = sampleAiSubtitle(ctx.subtitleMarkdown);
  const trimmed = trimAiHistory(history);
  const notices = [];
  // The side panel only sends video contexts.
  const sections = [
    `你是一个视频助手。当前用户正在看一个视频，标题：「${ctx.title || "未知"}」`,
    `作者：${ctx.author || "未知"} | 上传日期：${ctx.uploadDate || "未知"}`
  ];

  if (subtitle.step > 1) {
    sections.push(
      `以下是视频的字幕。全文过长，按时间均匀抽取了约 1/${subtitle.step} 的行，没抽到的内容你看不到；回答细节时说明可能有遗漏：\n\n${subtitle.text}`
    );
    notices.push(`字幕过长，只发送了均匀抽取的约 1/${subtitle.step}`);
  } else if (subtitle.text) {
    sections.push(`以下是视频的字幕全文：\n\n${subtitle.text}`);
  } else {
    // The sentence every entry shows; not logged in or failed, the video may have subtitles (aiSubtitleMissing, as 细看).
    const why = { subtitleNeedLogin: Boolean(ctx.subtitleNeedLogin), subtitleFailure: String(ctx.subtitleFailure || "").trim() };
    const missing = MdgErrors.subtitleMissing(why);
    sections.push(`${aiSubtitleMissing(why)}你拿不到视频里说了什么或画面内容，以下仅基于简介和评论回答，不要假装看过视频；简介和评论回答不了的，告诉用户：${missing}。`);
    notices.push(`${missing}，只根据标题、简介和评论回答`);
    const description = String(ctx.description || "").trim();
    if (description) {
      sections.push(`以下是视频简介：\n\n${description}`);
    }
  }
  // The video page's warning for a subtitle whose time range does not match the video (sent anyway, as there).
  if (subtitle.text && ctx.subtitleWarning) {
    notices.push(String(ctx.subtitleWarning).replace(/。$/, ""));
  }
  if (Array.isArray(ctx.hotComments) && ctx.hotComments.length) {
    const block = ctx.hotComments
      .map(MdgSites.cleanComment)
      .map((c, i) => `${i + 1}. ${c.uname}（赞 ${c.like}）: ${c.message}`)
      .join("\n");
    sections.push(`以下是按热度排序的前 ${ctx.hotComments.length} 条热门评论：\n\n${block}`);
  }
  const customSystemPrompt = normalizeAiSystemPrompt(systemPrompt);
  if (customSystemPrompt) {
    sections.push(`以下是额外系统要求：\n${customSystemPrompt}`);
  }
  if (trimmed.dropped) {
    sections.push(`对话过长，最早的 ${trimmed.dropped} 条消息没有提供给你。`);
    notices.push(`对话过长，最早的 ${trimmed.dropped} 条消息没有发送`);
  }
  return {
    messages: [
      { role: "system", content: sections.join("\n\n") },
      ...trimmed.messages,
      { role: "user", content: String(userPrompt || "") }
    ],
    notices
  };
}

// The reply's content tokens. An error in a chunk throws (triageAiBodyError), so does a 200 body that is plain JSON with
// an error instead of SSE lines; the last line is read even without a closing newline.
async function* parseOpenAISSE(response, onActivity) {
  if (!response || !response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let plain = "";
  for (let done = false; !done; ) {
    const chunk = await reader.read();
    done = chunk.done;
    if (!done) onActivity?.();
    buffer += decoder.decode(chunk.value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = done ? "" : lines.pop();
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) {
        plain += line;
        continue;
      }
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      if (!data) continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const bodyError = triageAiBodyError(json);
      if (bodyError) throw bodyError;
      const delta = json?.choices?.[0]?.delta?.content;
      if (delta) yield String(delta);
    }
  }
  let json = null;
  try {
    json = JSON.parse(plain);
  } catch {}
  const bodyError = triageAiBodyError(json);
  if (bodyError) throw bodyError;
  // A platform or proxy that ignores stream:true answers with one plain completion.
  const whole = json?.choices?.[0]?.message?.content;
  if (whole) yield String(whole);
}

// DeepSeek、智谱（国内/国际）、Kimi（国内/国际）用同一个 thinking 参数开关思考；其他平台不发该参数。triage-bg.js 也用它
function supportsThinkingToggle(baseUrl) {
  return /^https?:\/\/(api\.deepseek\.com|open\.bigmodel\.cn|api\.z\.ai|api\.moonshot\.(cn|ai))(\/|:|$)/i.test(String(baseUrl || ""));
}

// The one OpenAI-compatible request every AI call sends (the side panel's streamChat, 测试连接, 分拣台's triageChat): POST
// to chat/completions with the key as Bearer. Thinking is off unless asked, on the platforms that think by default.
function postChat({ baseUrl, apiKey, signal, thinking = false }, body) {
  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey && { Authorization: `Bearer ${apiKey}` }) },
    signal,
    body: JSON.stringify({ ...body, ...(supportsThinkingToggle(baseUrl) && { thinking: { type: thinking ? "enabled" : "disabled" } }) })
  });
}

// Remote hosts are optional permissions since 1.2.0, so an upgraded install may lack its AI provider's origin.
// Answered with code AI_ACCESS; the side panel and the settings page read the origin back (MdgErrors.grantOrigin) to offer 授权.
async function hostPermissionError(url) {
  try {
    const { protocol, hostname } = new URL(url);
    const origin = `${protocol}//${hostname}`;
    return (await chrome.permissions.contains({ origins: [`${origin}/*`] })) ? "" : MdgErrors.noAccess(origin);
  } catch {
    return "";
  }
}

// The caller checked the provider (aiProviderProblem); loadAiProviders normalized its baseUrl (normalizeAiProvider).
async function streamChat({ provider, context, userPrompt, history, port, signal, getAbortMeta, onActivity }) {
  if (!port) return;
  const { baseUrl } = provider;

  const { messages, notices } = buildAiMessages({
    context,
    userPrompt,
    history,
    systemPrompt: context?.aiSystemPrompt || ""
  });
  if (notices.length) {
    port.postMessage({ type: "notice", text: notices.join("；") });
  }

  let response;
  try {
    // Newer fast models think by default; the side panel never asks for it.
    response = await postChat({ baseUrl, apiKey: provider.apiKey, signal }, { model: provider.model, messages, stream: true, temperature: provider.temperature });
  } catch (e) {
    if (signal?.aborted) {
      postStreamAbort(port, getAbortMeta?.());
      return;
    }
    const err = await aiFetchError(baseUrl);
    port.postMessage({ type: "error", error: err.message, code: err.code });
    return;
  }

  // The 分拣台's classification (triage-bg.js); the code tells the panel whether 重试 can help.
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // Stopped or timed out while the error body was read: that is what happened, as on the other two paths.
    if (signal?.aborted) {
      postStreamAbort(port, getAbortMeta?.());
      return;
    }
    const e = triageAiHttpError(response.status, text);
    port.postMessage({ type: "error", error: e.message, ...(e.code && { code: e.code }) });
    return;
  }

  try {
    let answered = false;
    for await (const token of parseOpenAISSE(response, onActivity)) {
      answered = true;
      port.postMessage({ type: "token", data: token });
    }
    // Only thinking, or nothing: an error the panel shows with 重试, not an empty bubble.
    port.postMessage(answered ? { type: "done" } : { type: "error", error: MdgErrors.TEXT.aiEmpty });
  } catch (e) {
    if (signal?.aborted) {
      postStreamAbort(port, getAbortMeta?.());
      return;
    }
    // A connection dropped mid-reply is a TypeError ("network error").
    const err = e instanceof TypeError ? triageError(AI_NETWORK_TEXT, "AI_NETWORK") : e;
    port.postMessage({ type: "error", error: String(err?.message || err), ...(err?.code && { code: err.code }) });
  }
}

function postStreamAbort(port, abortMeta) {
  if (abortMeta?.type === "stopped") {
    port.postMessage({ type: "stopped", reason: abortMeta.reason || MdgErrors.TEXT.aiStopped });
  } else if (abortMeta?.type === "timeout") {
    port.postMessage({ type: "error", error: abortMeta.reason, code: abortMeta.code });
  }
}

// The settings page's 测试连接, answered in the words and codes of the side panel and 分拣台: aiProviderProblem,
// triageAiHttpError, triageAiBodyError, aiFetchError, MdgErrors.aiTimeout. The row's address is not saved, so not normalized yet.
async function testAiConnection({ baseUrl, apiKey, model, requiresKey }) {
  const problem = aiProviderProblem({ baseUrl, model, requiresKey }, apiKey);
  if (problem) {
    return { ok: false, error: problem.text, code: problem.code };
  }
  return probeAiChatCompletion({
    baseUrl: trimBaseUrl(baseUrl),
    apiKey,
    model: String(model).trim()
  });
}

async function probeAiChatCompletion({ baseUrl, apiKey, model }) {
  let response;
  const signal = AbortSignal.timeout(AI_TEST_TIMEOUT_MS);
  const timedOut = { ok: false, error: MdgErrors.aiTimeout(AI_TEST_TIMEOUT_MS), code: "AI_TIMEOUT" };
  try {
    response = await postChat({ baseUrl, apiKey, signal }, { model, stream: false, temperature: 0, max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
  } catch (error) {
    if (error?.name === "TimeoutError") return timedOut;
    const err = await aiFetchError(baseUrl);
    return { ok: false, error: err.message, code: err.code };
  }

  try {
    if (!response.ok) throw triageAiHttpError(response.status, await response.text().catch(() => ""));
    // Some platforms answer 余额不足 or 限流 with HTTP 200: read the body as 分拣台 does.
    await triageAiJson(response);
    return { ok: true };
  } catch (e) {
    // The 30 s also cover reading the reply: a body that stalls is the same timeout, not 「不是 JSON」.
    if (signal.aborted) return timedOut;
    return { ok: false, error: e.message, ...(e.code && { code: e.code }) };
  }
}

// triage/shared.js (loaded at the top) is the pages' TriageUi; it touches no DOM until called, so the worker reuses its
// formatters, tag rules and intIn.
// obsidian.js answers write-video-note and sync-video-note-ai: the background is the only writer to Obsidian.
importScripts("obsidian.js", "triage/triage-bg.js", "triage/follow-bg.js");
