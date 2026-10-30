// How pages show an error the background already classified: the shared sentences, what each error code asks the
// user to do, and the helpers every page used to copy, HTML escaping among them. The background classifies (triage-bg.js triageAiHttpError,
// obsidian.js obsidianError) and reads TEXT from here too. Loaded by the content script (manifest), background
// (importScripts) and the pages; load-order.selftest.js checks every user of MdgErrors loads it first. Idempotent like limits.js.
(() => {
  if (globalThis.MdgErrors) {
    return;
  }

  // The text table: a sentence (TEXT) or a control's name (LABEL) shown on more than one page lives here once. Pages
  // read it; a page's static copy is marked data-text="key" (wording.selftest.js keeps both equal and finds copies).
  const TEXT = Object.freeze({
    // After 授权 on an AI run's stop (分拣台, 摘读记录) or a side panel reply's error: the button beside it is 重试.
    granted: "已授权，请重试",
    obsidianUnset: "请先在设置页填写 Obsidian Local REST API 地址和 API Key",
    obsidianKey: "Obsidian 的 API Key 无效或未授权",
    obsidianDown: "连不上 Obsidian，请确认它已打开并启用了 Local REST API",
    obsidianOff: "写入 Obsidian 未启用",
    // HTTP 404 from the Local REST API: the address points somewhere else (a wrong path or port).
    obsidianNotFound: "Obsidian Local REST API 地址不对（HTTP 404）",
    // 取消 in the 该笔记已存在 dialog: the page sent no second write-video-note, so nothing was written.
    obsidianCancelled: "已取消写入 Obsidian，原笔记未被覆盖。",
    // The conversation (side panel) or the video (video page) changed while the 该笔记已存在 dialog was open: nothing
    // was written (copied, downloaded), and it is no failure (not red).
    obsidianConvSwitched: "对话已切换，未写入 Obsidian。",
    convSwitchedCopy: "对话已切换，未复制。",
    convSwitchedDownload: "对话已切换，未下载。",
    obsidianVideoSwitched: "视频已切换，未写入 Obsidian。",
    // 摘读记录: the record was deleted while the dialog was open.
    recordGoneWrite: "记录已删除，未写入。",
    recordGoneCopy: "记录已删除，未复制。",
    recordGoneDownload: "记录已删除，未下载。",
    // The extension reloaded under a page whose content script still runs: chrome.runtime no longer answers.
    reloaded: "扩展刚刚更新，请刷新网页",
    // No AI platform to send to (none added, none enabled): the background's AI_SETUP, the side panel and 分拣台 say this.
    aiNone: "没有启用的 AI 平台",
    // A video-only tool (专注模式, the popup's subtitle tools) asked for on a tab that is not a B站 / YouTube video page:
    // the popup, the background and the content script say this.
    notVideoPage: "当前网页不是支持的视频页",
    // A tab nothing can be read from (chrome://, file:, extension pages): the popup, the background and the side panel.
    pageUnsupported: "这个页面不能读取：只支持 B站 / YouTube 视频页和普通网页",
    // An http(s) page before web pages are granted: the side panel offers 允许读取网页; the popup and the background say it too.
    pageGrant: "读取网页正文要先允许一次，之后所有网页都能直接读",
    // B站 risk control (HTTP 412 or MdgSites.BILI_RISK_CODES), the background's code THROTTLED.
    biliThrottled: "B站限流，请稍后再试",
    // Not logged in to B站 (the background's NOT_LOGGED_IN, B站's -101), on any read or write; pages add 去登录.
    biliLogin: "未登录 B站：先在这个浏览器里登录 B站",
    // What a page that can reload adds to subtitleMissing's 未登录 sentence (the video page, the side panel); notes do not.
    subtitleLoginHint: "登录 B站后刷新网页",
    // The popup and 专注模式 say the same for the same situation. Reading the video (its info; a subtitle failure alone
    // is subtitleMissing) failed, on 刷新, on entering 专注模式 or on its automatic refresh; followed by 「：原因」.
    videoReadFailed: "读取视频失败",
    // 专注模式 did not start (popup, video page); followed by 「：原因」, a reason without instructions.
    readerStartFailed: "专注模式启动失败",
    // The chosen subtitle track could not be loaded; followed by 「：原因」.
    subtitleSwitchFailed: "字幕切换失败",
    // A track picked in the popup's or the side panel's 字幕 dropdown, while it loads.
    subtitleSwitching: "正在切换字幕…",
    // 复制 Markdown, 下载 .md or 写入 Obsidian before the page has a note.
    noNoteYet: "还没有笔记内容，请先点「刷新」",
    // A side panel reply that ended without one word of answer (only thinking, or nothing); the panel offers 重试.
    aiEmpty: "AI 平台没有返回回答",
    // The connection dropped once the platform had answered (background.js streamChat): code AI_STALLED, only 重试.
    aiDropped: "回复中断：连接断了",
    // The answer hit the model's output limit (finish_reason length): code AI_TRUNCATED (分拣台, the side panel).
    aiTruncated: "模型输出被截断",
    // A write to Obsidian that failed without the background saying why (video page, side panel, history page).
    obsidianWriteFailed: "Local REST API 写入失败",
    // Any failed write to Obsidian, on every entry (popup, video page, side panel, 摘读记录, 分拣台); 「：原因」 follows.
    obsidianFailed: "写入 Obsidian 失败",
    // A web page whose main text could not be read (readWebPage failed): the side panel and the popup lead its reason with this.
    pageReadFailed: "读取网页失败",
    // get-settings did not answer: the popup and the video page stop instead of going on with the defaults.
    settingsReadFailed: "读取设置失败",
    // A dropped connection (fetch's TypeError): the video page, 分拣台's B站 requests, 关注's paused refresh.
    netDown: "网络断了",
    // Asking Chrome or the background to open the side panel failed (popup, video page, 摘读记录, 分拣台); 「：原因」 follows.
    sidepanelOpenFailed: "打开侧边栏失败",
    // The browser has no extension side panel, or turned it off (Chromium's "API Unavailable"): openSidepanel's reason.
    sidepanelUnsupported: "当前浏览器不支持扩展侧边栏",
    // 继续问 on a 摘读记录 record that is neither a video nor a web page (a chrome:// or extension page).
    notVideo: "这个页面不能读取，不能继续问",
    // The side panel's 停止 ended the reply (the background's port message, the panel's own stop).
    aiStopped: "已停止生成",
    // chrome.tabs found no active tab (popup, side panel, background).
    noTab: "找不到当前标签页",
    // Every selection is hidden by a search or filter: the buttons that act on it are disabled with this (分拣台, 摘读记录).
    hiddenAll: "选中的都被筛选隐藏了",
    // B站's 62004 (the video is under review), on every read.
    biliReviewing: "视频审核中，过后再试",
    // A reply or a caught error that came without words.
    unknown: "未知错误",
    // A write to Obsidian in flight: the status line (popup, video page, side panel, 摘读记录, 分拣台's 导出) and the
    // button's own short form.
    obsidianWriting: "正在写入 Obsidian…",
    writing: "写入中…",
    copied: "已复制 Markdown",
    // 下载 .md of one note, on every entry (popup, side panel, 摘读记录, 一篇摘录); a zip of several says its count.
    downloaded: "已下载 .md",
    // The note has nothing in it (obsidian.js resolveNote, code NOTE_EMPTY): one sentence per exit (note-actions.js).
    nothingToCopy: "没有可复制的内容",
    nothingToDownload: "没有可下载的内容",
    nothingToWrite: "没有可写入 Obsidian 的内容",
    // A copy to the clipboard failed (popup, side panel, 摘读记录, 分拣台); 「：原因」 follows (noClipboard when the clipboard refused).
    copyFailed: "复制失败",
    // 下载 .md failed (side panel, 摘读记录); 「：原因」 follows.
    downloadFailed: "下载失败",
    // The page lost focus while the note was prepared, or the browser refused (Chrome's English NotAllowedError).
    noClipboard: "无法访问剪贴板，点一下页面再试",
    // The side panel while the video page reads the subtitle for it.
    subtitleReading: "正在读取视频字幕…",
    // 分拣台's 收藏夹设置 / 关注设置 and their AI 参数; a failure is followed by 「：原因」.
    settingsSaved: "设置已保存",
    settingsSaveFailed: "保存设置失败",
    aiParamsHint: "一般不用改。AI 平台在设置页。",
    noUndo: "没有可撤销的操作",
    // The address answers, but not in JSON as the Local REST API does (another local service): 测试连接, the pre-run check.
    obsidianNotApi: "这个地址不是 Obsidian Local REST API",
    // Reloading the page helps: it plays the wrong video, its player never got ready, a page did not start (popup,
    // 专注模式, YouTube's player, 分拣台, the settings page); alone or after 「原因，」. A video page that does not answer
    // says pageSilent.
    reloadRetry: "请刷新网页后重试",
    // The video page's copy of the extension did not answer, or could not be put there (code PAGE_SILENT, pageSilent):
    // the popup, 专注模式, the side panel and the background's writes. Only reloading the page helps.
    pageSilent: "视频页没有回应，请刷新网页后重试",
    // 摘读记录 and the settings page's AI platform row; followed by 「：原因」.
    deleteFailed: "删除失败",
    // Waiting for the first data: 摘读记录's list, the side panel's chip.
    loading: "正在加载…",
    // A known video without a title (摘读记录, the side panel's conversations; an AI 笔记's file name adds the id).
    // 未知视频 is only the side panel's chip with no video at all (DESIGN 术语表).
    untitledVideo: "无标题视频",
    // The 备注 box (side panel, 摘读记录, 分拣台).
    notePlaceholder: "一句话备注，回车保存",
    // 全选 and 清理 with nothing listed (收藏夹); 摘读记录 says 这里没有列出记录, 关注 这里没有列出 UP 主.
    noVideosListed: "这里没有列出视频",
    sidepanelOpening: "正在打开侧边栏…",
    // The popup or the side panel did not start; followed by 「：原因」.
    initFailed: "初始化失败",
    // The popup and the video page while the video's info is read.
    videoReading: "正在读取视频信息…",
    // 去设置 / ⚙ that could not open the settings page (video page, popup, 分拣台); followed by 「：原因」.
    settingsOpenFailed: "打开设置失败",
    // A tab opened or sent elsewhere that must load first (MdgSites.waitTabLoaded: the background's write of a page
    // not open, the side panel's jump to a time).
    tabClosed: "标签页已关闭",
    tabLoadTimeout: "标签页加载超时",
    // A note read and ready (the video page's read for the popup, the popup's read of a web page): what its exits can do.
    readDone: "读取完成，可以复制或下载。",
    readDoneObsidian: "读取完成，可以复制、下载或写入 Obsidian。",
    // YouTube's HTTP 429 on a subtitle, after the video page's one wait; B站's is biliThrottled.
    ytThrottled: "YouTube 限流，请稍后再试",
    // Tags and 保留 marks are MoonDigest's own (B站 pages' UP tag picker, 关注's 标签管理 and 帮助, 收藏夹's 保留).
    localOnly: "只存在 MoonDigest 里，不改 B站"
  });

  // Names of controls and pages that recur across pages (DESIGN 术语表). A name also appears inside sentences
  // (「请先点「刷新」」), so wording.selftest.js matches a name only as a whole literal, text or attribute.
  const LABEL = Object.freeze({
    // The note's three exits, in this order on every page (DESIGN).
    copyMd: "复制 Markdown",
    downloadMd: "下载 .md",
    writeObsidian: "写入 Obsidian",
    toSettings: "去设置",
    // PAGE_GRANT's button (action grantPage): the side panel and the popup ask for every http(s) site (grantPages).
    grantPage: "允许读取网页",
    retry: "重试",
    refresh: "刷新",
    history: "摘读记录",
    // A video's decision on a B站 page's mark and on the 分拣台's card.
    kept: "已保留",
    unfaved: "已取消收藏",
    // The new-tag box of every tag picker and dialog, and its button (标签管理, B站 pages' 「+ UP 标签」).
    newTagName: "新标签名称",
    newTag: "新建标签",
    triage: "B站分拣台",
    // The player's ✦ button and 专注模式's; the settings page names its switch after it.
    aiSummary: "AI 总结",
    readingView: "专注模式",
    // The settings section, its storage row, B站 pages' column and 分拣台's run.
    seen: "观看进度",
    // 100% on a cover (B站 pages) and the settings page's sample.
    seenDone: "✓ 看完了",
    // Asks Chrome for an AI platform's origin (settings page, side panel, 分拣台); the sentence beside it names it.
    grant: "授权",
    openSettings: "打开设置页",
    // The settings dialogs (收藏夹设置, 关注设置, 摘读记录设置).
    aiParams: "请求和 AI 参数",
    saveSettings: "保存设置",
    // An undo step's name (U, 关注 and 摘读记录).
    tagEdit: "标签修改",
    selectAll: "全选",
    // Settings the background names when one is too long to save (SYNC_ITEM_NAMES).
    aiSystemPrompt: "系统提示词",
    playerAiQuickPrompt: "AI 总结要求",
    aiPresetPrompts: "快捷追问",
    fixedFrontmatterProperties: "自定属性",
    notePlaceholderSections: "正文附加段落",
    // B站's own list: a B站 page's row and 分拣台's folder.
    watchLater: "稍后再看",
    // B站 pages' columns, 摘读记录 and the 收藏夹 CSV.
    aiVerdict: "AI 判断",
    videoTags: "视频标签",
    // Note properties: 专注模式's info line, the settings page, the popup's 详情.
    uploadDate: "发布日期",
    exportDate: "导出日期",
    // Opens the 备注 box (side panel, 摘读记录, 分拣台).
    noteAdd: "✎ 备注",
    // The help dialogs (分拣台's two, 摘读记录) and the buttons they name.
    shortcuts: "快捷键",
    keyTagNumber: "打标签时勾选或去掉第几个标签",
    keySearch: "搜索（Esc 清空）",
    keyHelp: "显示本帮助",
    aiTag: "AI 打标签",
    gotIt: "知道了",
    tagsMenu: "标签…",
    // The settings page's custom AI platform, and the name a platform stored without one gets (background.js).
    customAi: "自定义",
    // A B站 video deleted or hidden: the error of every read (sites.js, not B站's own words) and the verdict's reason
    // (tag-core.js). A name, so the sentences around it (侧边栏, notes) may say it too.
    videoGone: "视频已失效",
    // A running job's stop button, and the same once pressed while the step in flight finishes (side panel, 分拣台).
    stop: "停止",
    stopping: "停止中",
    // A job the user stopped (分拣台's toasts and status lines; 关注's background names its stop error so).
    stopped: "已停止",
    // A B站 page's mark on an invalid video the AI never judged (no 「AI」: it is the snapshot's fact, not a verdict).
    invalid: "已失效",
    // 收藏夹's page for videos that left every checked folder, and its storage row on the settings page.
    removed: "已出分拣范围",
    // 收藏夹's two AI steps: a B站 page's mark names the step that judged the video, 分拣台 its buttons and runs.
    coarseRead: "标题粗看",
    fineRead: "字幕细看"
  });

  // How long a B站 / YouTube read waits for an answer: the background's B站 channel (triage-bg.js triageBiliFetch,
  // which also serves the video page's fetch-json) and the video page's own fetches (content.js fetchOk).
  const NET_TIMEOUT_MS = 30000;
  const netTimeout = (ms) => `${TEXT.netDown}：${ms / 1000} 秒没有回应`;

  // AI_TIMEOUT: no answer from the AI platform in ms (each caller's own limit: side panel, 分拣台, 测试连接).
  const aiTimeout = (ms) => `AI 平台 ${ms / 1000} 秒没有回应`;
  // AI_STALLED: a side panel reply that stopped midway for ms. Only 重试 helps (no 去设置: the platform did answer).
  const aiStalled = (ms) => `回复中断：${ms / 1000} 秒没有新内容`;
  // The 「+ UP 标签」 button's name and the UP tag picker's title (B站 pages, 关注).
  const upTagTitle = (name) => `给「${name}」打 UP 标签`;

  // Why a reader has no subtitle: the one sentence of every entry (video page, 专注模式, popup, side panel, the AI's
  // context, 分拣台, notes), without a full stop. subtitleNeedLogin is its own state (B站 hides subtitles from a
  // logged-out viewer), not a failure; subtitleFailure is why the fetch failed. A state, never an instruction.
  const subtitleMissing = ({ subtitleNeedLogin = false, subtitleFailure = "" } = {}) =>
    subtitleNeedLogin ? "未登录 B站，拿不到字幕" : subtitleFailure ? `字幕抓取失败：${subtitleFailure}` : "视频没有字幕";

  // Error code (or a situation without one: PAGE_*, SUBTITLE_*) → what every entry shows: text replaces the background's
  // words; action is the button beside the error, "settings" (去设置), "grant" (授权), "grantPage" (允许读取网页) or
  // "login" (去登录); retry: false where no second try can help (otherwise 重试). remedies() reads it; the entries
  // (entry-matrix.selftest.js lists them) render what it says and decide nothing of their own. Numbers are B站's own codes.
  // A gone video's sentence is LABEL.videoGone (sites.js says it); no text here, so a -404 from another B站 call keeps its words.
  const GONE = { retry: false };
  const CODES = Object.freeze({
    // The AI platform errors after which every request fails alike: 分拣台 stops its run on them, and every entry offers
    // 去设置 (an unreachable platform or a timeout may be a wrong base URL or model).
    AI_AUTH: { action: "settings" },
    AI_QUOTA: { action: "settings" },
    AI_SETUP: { action: "settings" },
    AI_NETWORK: { action: "settings" },
    AI_TIMEOUT: { action: "settings" },
    // No access to the AI provider's origin yet (noAccess): every request fails alike, so 分拣台 stops its run; the fix
    // is 授权 (grantOrigin reads the origin from the words), not the settings page.
    AI_ACCESS: { action: "grant" },
    // The model's answer hit the output limit (TEXT.aiTruncated): 重试 on the side panel; 分拣台's banner also offers
    // 打开收藏夹设置 for its 输出上限.
    AI_TRUNCATED: {},
    // 分拣台 only: AI 平台 still limited after AI_THROTTLE_WAITS waits in a row.
    AI_GAVE_UP: { action: "settings" },
    // AI_THROTTLED (a run waits, the side panel offers 重试) and AI_STALLED (the platform did answer: 重试 only) are
    // not listed: 重试 alone.
    // Obsidian itself is unusable (not set up, off, wrong key): every write fails alike and the fix is in the settings
    // page. OBSIDIAN_DOWN (closed, plugin off, timeout) also fails every write, but the settings page cannot fix it.
    OBSIDIAN: { action: "settings" },
    // A note with nothing in it (no conversation, analysis or 备注): a second try finds nothing either.
    NOTE_EMPTY: { retry: false },
    NOT_LOGGED_IN: { action: "login", text: TEXT.biliLogin },
    [-101]: { action: "login", text: TEXT.biliLogin },
    THROTTLED: { text: TEXT.biliThrottled },
    62004: { text: TEXT.biliReviewing },
    // Deleted or hidden on B站 (MdgSites.isBiliVideoGone's codes; entry-matrix.selftest.js keeps both lists equal).
    [-404]: GONE,
    62002: GONE,
    62012: GONE,
    // A web page by background.js readWebPage's pageAccess (pageCode): read failed (timeout, no main text: TEXT.pageReadFailed),
    // not granted yet (TEXT.pageGrant), or a tab nothing can read (chrome://, extension pages: TEXT.pageUnsupported).
    // The sentences are pageText's.
    PAGE_FAILED: {},
    // A video page's content script did not answer (pageSilent): a second try fails alike, reloading the page helps.
    PAGE_SILENT: { text: TEXT.pageSilent, retry: false },
    PAGE_GRANT: { action: "grantPage", retry: false },
    PAGE_UNSUPPORTED: { retry: false },
    // Why a video has no subtitle (subtitleCode; the sentence is subtitleMissing): a failed fetch and 未登录 may pass on
    // a second read, a video without subtitles does not.
    SUBTITLE_FAILED: {},
    SUBTITLE_LOGIN: {},
    SUBTITLE_NONE: { retry: false }
  });

  // The table's codes by name, for the files that write or compare one (CODE.THROTTLED, not "THROTTLED").
  const CODE = Object.freeze(Object.fromEntries(Object.keys(CODES).filter((k) => /^[A-Z_]+$/.test(k)).map((k) => [k, k])));
  // The HTTP status a timed-out request carries (background.js fetchWithTimeout); obsidianError reads it as OBSIDIAN_DOWN.
  const TIMEOUT_STATUS = 408;

  // What helps, in the order the buttons stand: the action, then "retry". An entry whose own button already runs the
  // step again (分拣台's and 摘读记录's runs, a 写入 Obsidian button, the popup's 刷新) leaves "retry" to that button.
  const remedies = (code) => [...(CODES[code]?.action ? [CODES[code].action] : []), ...(CODES[code]?.retry === false ? [] : ["retry"])];
  const action = (code) => CODES[code]?.action || "none";
  const pageCode = (pageAccess) => ({ failed: CODE.PAGE_FAILED, needPermission: CODE.PAGE_GRANT, unsupported: CODE.PAGE_UNSUPPORTED })[pageAccess] || "";
  // The sentence for a web page read (background.js readWebPage's { pageAccess, pageError }): "" when ready, undefined
  // without a pageAccess.
  const pageText = (page) =>
    ({ ready: "", needPermission: TEXT.pageGrant, unsupported: TEXT.pageUnsupported, failed: `${TEXT.pageReadFailed}：${page?.pageError}` })[page?.pageAccess];
  // grantPage: every http(s) site at once (optional host permissions). Asked inside the click: request needs its gesture.
  const grantPages = () => chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] }).catch(() => false);
  // Why a video has no subtitle ({ subtitleNeedLogin, subtitleFailure }, as subtitleMissing takes it) as a SUBTITLE_ code.
  const subtitleCode = ({ subtitleNeedLogin = false, subtitleFailure = "" } = {}) =>
    subtitleNeedLogin ? CODE.SUBTITLE_LOGIN : subtitleFailure ? CODE.SUBTITLE_FAILED : CODE.SUBTITLE_NONE;

  // A background reply { ok: false, error, code? } in the user's words.
  function text(resp, fallback = TEXT.unknown) {
    const own = typeof resp?.error === "string" ? resp.error.trim() : "";
    return CODES[resp?.code]?.text || own || fallback;
  }

  // The reply as an Error to throw; error.action says which button the catch shows, error.cause is the reply.
  // A caught error (or a plain string) in the user's words: a known code's sentence, else its message, else fallback.
  // Codes and English internals never reach the page as they are (content.js keeps rawErrorText for logs).
  const messageOf = (error, fallback = TEXT.unknown) =>
    typeof error === "string" ? error.trim() || fallback : text({ error: error?.message, code: error?.code }, fallback);

  const fromResp = (resp, fallback) => Object.assign(new Error(text(resp, fallback), { cause: resp }), { action: action(resp?.code) });

  // An AI provider's origin the extension may not reach yet (host permissions are optional): the background's
  // hostPermissionError, and 测试连接 when the user declines the request. grantOrigin reads it back.
  const noAccess = (origin) => `未授权访问 ${origin}，授权后重试`;

  // The background's noAccess sentence (hostPermissionError, 测试连接): an upgraded install lacks the AI provider's
  // origin. request() must run in a click handler: permissions.request needs the user gesture, the worker cannot ask.
  // Only for a code whose remedy is 授权 (AI_ACCESS): words an AI platform returns must not choose which origin is asked for.
  function grantOrigin(message, code) {
    if (action(code) !== "grant") return null;
    const origin = /未授权访问 (https?:\/\/[^\s，]+)/.exec(String(message || ""))?.[1];
    return origin ? { origin, request: () => chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false) } : null;
  }

  // Chrome's own English errors when a page's content script is asked (chrome.tabs.sendMessage): none runs there
  // ("Could not establish connection. Receiving end does not exist."), the page closed the port before answering, the tab
  // or frame is gone. noReceiver is the one case where injecting the script and asking again can help (each caller keeps
  // its own retries); pageSilent says any of them, a sender's error it marked chrome: true, or a page that never answered
  // (no error: a timeout), as TEXT.pageSilent with code PAGE_SILENT, and passes any other error on as it is.
  const CHROME_SILENT = /Receiving end does not exist|Could not establish connection|message port closed|No tab with id|No frame with id/;
  const noReceiver = (error) => /Receiving end does not exist/.test(String(error?.message || ""));
  const pageSilent = (error) =>
    !error || error.chrome || CHROME_SILENT.test(String(error.message || "")) ? Object.assign(new Error(TEXT.pageSilent, { cause: error }), { code: CODE.PAGE_SILENT }) : error;

  // chrome.tabs.sendMessage for the background, the popup and the side panel, with Chrome's error marked chrome: true
  // (pageSilent words it). inject (pages only): a tab without the video page's script (noReceiver) gets it from the
  // background (ensure-reader-content), then the message goes once more.
  async function tabMessage(tabId, message, { frameId, inject = false } = {}) {
    const send = () =>
      new Promise((resolve, reject) =>
        chrome.tabs.sendMessage(tabId, message, ...(frameId === undefined ? [] : [{ frameId }]), (resp) =>
          chrome.runtime.lastError ? reject(Object.assign(new Error(chrome.runtime.lastError.message), { chrome: true })) : resolve(resp)
        )
      );
    try {
      return await send();
    } catch (error) {
      if (!inject || !noReceiver(error)) throw error;
    }
    const resp = await chrome.runtime.sendMessage({ type: "ensure-reader-content", tabId });
    if (!resp?.ok) throw fromResp(resp, TEXT.reloaded);
    return send();
  }

  // chrome.sidePanel.open for every entry (background, 摘读记录, 分拣台), called inside the click before any await. A
  // browser without the API, or with it turned off (Chromium rejects with "API Unavailable"), says sidepanelUnsupported.
  const openSidepanel = (options) =>
    chrome.sidePanel?.open
      ? chrome.sidePanel.open(options).catch((error) => {
          throw /API Unavailable/i.test(String(error?.message || "")) ? new Error(TEXT.sidepanelUnsupported, { cause: error }) : error;
        })
      : Promise.reject(new Error(TEXT.sidepanelUnsupported));

  // What chrome.runtime calls throw in a content script whose extension was reloaded (badges.js checks
  // chrome.runtime.id instead).
  const reloaded = (error) => /Extension context invalidated/.test(String(error?.message || ""));

  // Text into markup, in element content and in quoted attributes: the one copy every page, the video page and 分拣台
  // (TriageUi.esc) build HTML with. Titles, UP names, comments, AI replies and tag names all pass through it.
  // badges.js builds its DOM with textContent and does not need it.
  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  // A control that cannot be used is disabled and says why (DESIGN: no clickable button that only toasts): the tooltip,
  // and aria-description for screen readers; without a reason it is enabled with its own title. Every extension page
  // and the 分拣台 (TriageUi.setReason) use this one.
  function setReason(node, reason, title = "") {
    node.disabled = Boolean(reason);
    node.title = reason || title;
    if (reason) node.setAttribute("aria-description", reason);
    else node.removeAttribute("aria-description");
  }

  globalThis.MdgErrors = Object.freeze({ TEXT, LABEL, action, remedies, pageCode, pageText, grantPages, subtitleCode, text, messageOf, fromResp, grantOrigin, noReceiver, pageSilent, tabMessage, openSidepanel, reloaded, escapeHtml, setReason, subtitleMissing, aiTimeout, aiStalled, upTagTitle, noAccess, NET_TIMEOUT_MS, netTimeout, CODE, TIMEOUT_STATUS });
})();
