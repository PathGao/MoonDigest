"use strict";
// 收藏夹's constants, page state (S, el, runs), storage and message I/O, toast and dialogs, and what the
// cards derive from S (tags, stage, class, filters, sort, the next batch).

// ---------- constants ----------
// Error code -> the limit wait (runs.js's hold: { ms, label }). AI 429s clear far sooner than B站 risk control. B站's
// wait is read when used: the dev preview's mock sets __TRIAGE_THROTTLE_MS after this script has run.
const THROTTLES = {
  THROTTLED: { get ms() { return globalThis.__TRIAGE_THROTTLE_MS || 10 * 60 * 1000; }, label: TriageUi.BILI_STUCK },
  AI_THROTTLED: MdgRuns.AI_HOLD
};
const SYNC_MIN_GAP_MS = 60 * 1000;
// Progress tabs: how far a video has been looked at. The AI class is a filter inside a tab, never a tab.
// 阅览 sits apart after them.
const STAGES = [
  ["none", "未分析"],
  ["coarse", "粗看完成"],
  ["fine", "细看完成"],
  ["done", "处理完成"]
];
const READ_TAB = "阅览全部";
const NEXT_BATCH = "下一批"; // a step's button and the cards it will send
// The two AI steps' names, and a run's name: the step, or its redo under a changed 判断标准 (按新标准重新粗看).
const STEP_NAME = { coarse: "标题粗看", fine: "字幕细看" };
const runName = (step, redo) => (redo ? `按新标准重新${STEP_NAME[step].slice(2)}` : STEP_NAME[step]);
// Storage keys. The shared ones come from MdgLimits.KEYS; the rest only this page uses.
const KEYS = MdgLimits.KEYS;
const K = {
  lastFolder: "triage_last_folder",
  folderList: "triage_folder_list", // { mid, folders }: B站's folder list as last read, so the page opens before it reads it again
  tags: KEYS.triageTags, // [{ id, name, color, folder, rule? }]: folder is the mediaId the tag belongs to; rule is the one line the AI follows
  folderCriteria: KEYS.triageFolderCriteria, // { [mediaId]: 判断标准 }
  videoTags: KEYS.triageVideoTags,
  basket: KEYS.triageBasket,
  notes: KEYS.triageNotes,
  decisions: KEYS.triageDecisions, // 取消收藏 only: it changes one Bilibili folder
  kept: KEYS.triageKept, // { [bvid]: { action: "keep", at } }: 保留 belongs to the video, so it shows in every folder
  removed: KEYS.triageRemoved, // { [bvid]: { item, at, movedTo?, hidden?, inFolder?: { id, title } | null, from?: [{ id, title, at }] } }: videos that left every folder, kept until the user cleans them
  left: "triage_left", // { [bvid]: { [folderId]: { title, at } } }: folders a video left while still in another chosen one; becomes the record's from
  included: KEYS.triageIncludedFolders, // [mediaId]: the folders the user chose; only these are listed and read
  snapshot: KEYS.triageSnapshot,
  aiHistory: "triage_ai_command_history",
  readAt: "triage_read_at", // { [mediaId]: ms }: when each folder's list was last read from B站, for 「今天 HH:MM 刷新过」
  sort: "triage_sort", // { [mediaId]: { sort, dir } }: each folder's card order; none = 收藏时间 新→旧
  aiRecent: "triage_ai_recent", // { [mediaId]: { at, bvids } }: 「AI 刚打的」, the videos the last applied 批量打 changed
  aiProposals: "triage_ai_proposals" // { [mediaId]: proposal }: AI 打标签 proposals waiting for 应用, kept across a reload
};
const ALL = "all"; // the 所有收藏夹 view's folder-select value
const REMOVED = "removed"; // the 已出分拣范围 view
const REMOVED_NAME = globalThis.TriageUi.removedName;
const SETTINGS_NAME = "收藏夹设置";
const PICK_FOLDERS = "选择收藏夹";
const NO_FOLDERS = "没有找到收藏夹"; // the first run's button, and the dialog it opens
// 收藏夹's B站 writes: names on buttons, in the pill and in toasts.
const REFAV = "重新收藏";
const UNFAV = "取消收藏"; // also the verb W.pending answers for a video waiting to be unfavorited
const REFAVING = `${REFAV}中…`;
const UNFAV_MANY = "批量取消收藏";
const UNDO = globalThis.TriageUi.UNDO;
// 待播's remove: the list's button, E on a card in it, the card's ✓ 待播.
const BASKET_REMOVE = "从待播移除";
const BASKET_REMOVED = `已${BASKET_REMOVE}${UNDO}`;
const RECENT_UNFAV = "最近取消收藏"; // 处理完成's list of the unfavorited, where each can be 重新收藏
// 取消收藏 or 保留 on a video already unfavorited: its card's buttons and the D / S keys say the same.
const UNFAVED = "已经取消收藏了";
const KEEP_UNFAVED = `${UNFAVED}，要保留先在「${RECENT_UNFAV}」里${REFAV}`;
const TOVIEW = "toview"; // 稍后再看, listed by triage-bg as one more folder
// The fixed AI classes, shown as chips inside 粗看完成 and 细看完成.
// The ids are the badge color classes too.
const { VERDICTS } = MdgTagCore;

const newTagId = () => MdgTagCore.newTagId("t");

// The stored records' shapes and the export helpers (pure) live in triage-core.js.
const { refavorited, mergeFolderItems, updateRemoved, moveToRemoved, inferFrom, forgetLeft, noteLeft, keepInvalidInfo, idsChanged, mergeHead, unfavOnly, mdLinkText, oneLine, mdLink, wikiLink } = TriageCore;

// 收藏夹设置's number settings: [stored key, TriageUi.NUM_SETTINGS kind, its input in the dialog].
const NUM_FIELDS = [
  ["triageIntervalSec", "interval", "intervalInput"],
  ["triageCoarseBatchSize", "coarseBatch", "coarseBatchInput"],
  ["triageFineBatchSize", "fineBatch", "fineBatchInput"],
  ["triageTitleMaxTokens", "maxTokens", "titleMaxInput"],
  ["triageAnalyzeMaxTokens", "maxTokens", "analyzeMaxInput"],
  ["triageTagLimit", "tagLimit", "tagLimitInput"],
  ["triageAiNewTagMax", "newTagMax", "aiNewTagMaxInput"],
  ["triageAiBatchSize", "aiBatch", "aiBatchInput"]
];

// ---------- state ----------
const S = {
  allFolders: [], // every folder on Bilibili
  folders: [], // the ones taking part in triage
  included: [],
  removedCheck: null, // 已出分拣范围 only: { done, total, what, error } while its folders, then its videos, are checked (what: the pill's 核对… word)
  mediaId: "",
  folderToken: 0,
  items: [],
  itemMap: new Map(),
  titleRes: {},
  analyses: {},
  decisions: {}, // the open folder's 取消收藏 over the global 保留
  kept: {},
  removedCount: 0,
  folderIntro: {}, // { [mediaId]: Bilibili folder intro }, read with the folder list
  folderDecisions: {}, // 所有收藏夹 only: { [mediaId]: that folder's decisions }
  loadAll: null, // 所有收藏夹 only: { lists: { [mediaId]: { items, at } }, check, checkTotal, queue, paused, running, error, partial }
  tags: [],
  folderCriteria: {},
  videoTags: {},
  basket: [],
  notes: {},
  finishedFilter: false, // 看完了
  dupFilter: false, // 所有收藏夹 only: 重复收藏
  tagState: "", // row 3: "" | "untagged" | "tagged"
  aiRecent: {},
  sortBy: {}, // triage_sort
  aiRecentFilter: false, // AI 刚打的
  kindFilter: "", // kindOf: "invalid" (已失效) anywhere; "unfav" / "out" in 已出分拣范围 only
  seenCfg: MdgSurfaces.seenConfig(MdgSurfaces.SEEN_DEFAULTS), // 设置页「观看进度 → 封面显示」
  seenPct: {}, // bvid → [percent, view_at] from the history, null when it has none
  noteOpen: new Set(), // empty notes the user opened for editing
  settings: {
    // Until triage-settings-get answers: the defaults (TriageUi.NUM_SETTINGS). triageTagLimit: tags per folder, only
    // creating a new one is refused past it; triageAiNewTagMax: new tags one 批量打 may propose.
    ...Object.fromEntries(NUM_FIELDS.map(([key, kind]) => [key, TriageUi.numSetting(kind)])),
    triageThinking: false,
    triageAiRemoveTags: false, // 批量打 may also take tags off
    thinkingToggle: false
  },
  tab: "none",
  classFilter: { coarse: "all", fine: "all", read: "all" }, // each tab keeps its own AI-class chip; a folder switch resets them
  tagFilter: new Set(),
  query: "",
  focused: "",
  selected: new Set(),
  group: null, // the running 细看 batch: { bvids, redo, mediaId, items, judge }; its count is runs' "group"
  write: { mediaId: "", text: "" }, // 逐个视频笔记 (runs' "write"): { md, mediaId, text } (text: the finished line)
  stage1: { mediaId: "" }, // the folder of the last 标题粗看 (runs' "stage1")
  coarseFailed: new Map(), // bvid → why its 粗看 failed (this page only, like a failed 细看)
  analyzing: new Set(),
  seenRead: { busy: false, pages: 0, until: 0 }, // the background's read of the watch history (triage_seen_meta)
  undo: [], // 收藏夹's steps; a folder switch clears them
  modeUndo: [], // 关注's steps ({ kind: "mode" }): U undoes only the steps of the mode it is pressed in
  lastSyncAt: 0,
  readAt: {}, // K.readAt
  foldersRead: null, // the folder list's last read: null before it answers, "" read, else why it failed
  syncError: "", // the open folder's last 刷新 failure; stays under the title until a read succeeds
  readError: "", // why a folder with nothing listed could not be read; the list says so until a read succeeds
  syncing: false,
  aiHistory: [],
  viewing: "",
  // The 收藏夹 video in the viewer, taken when it opens so its lines outlive a folder switch: { item, folders } (folders:
  // the ones whose tags it shows and the picker offers; null in 已出分拣范围, where every tag shows and none is edited).
  viewer: null,
  // One 批量打标签 run at a time (mediaId is its folder); it keeps going when another folder is opened. Each folder keeps
  // its own proposal, and proposal reads and writes the open folder's.
  ai: {
    mediaId: "", // the folder of the run (runs' "ai")
    // Tag ids greyed out in 批量打 for this opening of the dialog: not sent to the AI, never added, kept or removed.
    excluded: new Set(),
    proposals: {},
    get proposal() {
      return this.proposals[S.mediaId] || null;
    },
    set proposal(p) {
      if (p) this.proposals[S.mediaId] = p;
      else delete this.proposals[S.mediaId];
      saveAiProposals();
    }
  }
};

// The long tasks (runs.js) and the progress pill's rows. A limit counts down the pill and sends the same request again.
const runs = MdgRuns.create({ redraw: () => renderStatus(), hold: (r) => THROTTLES[r.code] || null, sleep: (ms, ok) => sleepWhile(ms, ok) });
// What runs or waits, in this order on every tab (the first wins), then the finished lines. A run's row is its own;
// these are mirrored from elsewhere.
const PILL = ["group", "stage1", "fav", "write", "load", "check", "sync", "ai", "proposal", "aiOther", "seen", "seenRead"];
runs.put("load", () => loadAllActivity());
// S.syncing is the token of the folder being read: one left meanwhile no longer shows it.
const ownSync = () => Boolean(S.syncing) && S.syncing === S.folderToken;
runs.put("sync", () => ownSync() && { text: `${UI.REFRESHING}…${pageText(S.mediaId)}` });
runs.put("proposal", () => S.ai.proposal && { text: UI.AI_TAGS_PENDING });
runs.put("aiOther", () => otherAiFolder() && { text: `「${folderName(otherAiFolder())}」的${UI.AI_TAGS_PENDING}` });
// 观看进度's 30-minute pause on B站 risk control comes from the background (triage_seen_meta); tick() redraws it.
runs.put("seen", () => S.seenCfg.on && S.seenRead.until > Date.now() && { text: MdgErrors.LABEL.seen, wait: { until: S.seenRead.until, label: THROTTLES.THROTTLED.label } });
runs.put("seenRead", () => S.seenCfg.on && S.seenRead.busy && S.seenRead.pages && { text: `读观看进度… 已读 ${S.seenRead.pages} 页` });
// The pill's button per job: [data-head, label, label while it stops, why it is off then (it waits for the step in
// flight)]. Row 3's 暂停粗看 / 暂停细看 and the pill's line while pausing use the same words.
const VIEW = "查看"; // the pill's button to an AI 打标签 run or proposal
const PILL_BTN = {
  group: ["group", "暂停细看", "暂停中", "当前视频细看完就暂停"],
  stage1: ["stage1", "暂停粗看", "暂停中", "当前批次粗看完就暂停"],
  write: ["write", MdgErrors.LABEL.stop, MdgErrors.LABEL.stopping, "当前视频做完就停止"],
  fav: ["fav", MdgErrors.LABEL.stop, MdgErrors.LABEL.stopping, globalThis.TriageUi.WRITE_STOPPING],
  ai: ["tags", VIEW],
  proposal: ["tags", VIEW],
  aiOther: ["aiOther", VIEW]
};
const stopWhy = (act) => Object.values(PILL_BTN).find((b) => b[0] === act)?.[3] || "";
const aiRunning = () => Boolean(runs.get("ai"));
const writeRunning = () => Boolean(runs.get("write"));

const criteriaFor = (id) => S.folderCriteria[id] || "";
const criteria = () => criteriaFor(S.mediaId);
// The folder a video is judged under: the open one, or in 所有收藏夹 the first chosen folder (list order) it is in.
const homeOf = (it) => (S.mediaId === ALL ? S.folders.map((f) => String(f.id)).find((id) => it?.folders?.includes(id)) : String(S.mediaId));
// What the AI is told about a folder; its 判断标准 is relative to this.
const folderContext = (id = S.mediaId) => ({ title: folderTitle(id), intro: S.folderIntro[id] || "" });
// Everything a 粗看 or 细看 request about this video carries, taken when its run starts.
const judgeOf = (it) => {
  const home = homeOf(it);
  return { home, crit: criteriaFor(home), ctx: folderContext(home) };
};
// A 粗看 or 细看 result remembers the 判断标准 it was made under (loadResults stamps older ones with the folder's
// current one), so after the criteria change the old results can be redone.
const isStale = (r, crit = criteria()) => Boolean(r) && (r.criteria ?? crit) !== crit;
const inFolderOnly = () => S.mediaId && S.mediaId !== ALL && S.mediaId !== REMOVED;
const judged = () => S.mediaId && S.mediaId !== REMOVED;
const staleCoarse = () => (judged() ? S.items.filter((it) => !it.invalid && stageOf(it) === "coarse" && isStale(S.titleRes[it.bvid], criteriaFor(homeOf(it)))) : []);
const staleFine = () => (judged() ? S.items.filter((it) => !it.invalid && stageOf(it) === "fine" && isStale(S.analyses[it.bvid], criteriaFor(homeOf(it)))) : []);

const $ = (id) => document.getElementById(id);

const { composing, typingIn } = globalThis.MdgTyping;

const UI = globalThis.TriageUi;
const { esc, pad, fmtDate, fmtDuration, fmtCount, cleanTagName, plainClick, img } = UI;
// What 导出's two items hold.
const WRITE_HINT = "摘录，或逐个视频的笔记";
const CSV_HINT = "标题、AI 判断、标签、备注";
// Row 2 and the sidebar foot are drawn by shared.js, as in 关注; here before el picks them up.
$("favRowTools").insertAdjacentHTML("beforeend", UI.searchBox("searchInput", "searchCount", "搜这个收藏夹") + UI.rowButtons({
  activityId: "activity", refreshId: "refreshBtn", refreshLabel: "从 B站刷新这个收藏夹", exportId: "exportBtn", menuId: "tools",
  menuHtml: UI.menuItem('id="writeBtn" aria-label="导出摘录或笔记"', "摘录或笔记…", WRITE_HINT) + UI.menuItem('id="csvBtn" aria-label="下载这个收藏夹的表格 CSV"', "这个收藏夹的表格 (CSV)", CSV_HINT) + "<hr>" + UI.BACKUP_ITEM,
  settingsAttr: "data-open-settings", settingsLabel: SETTINGS_NAME
}));
$("favSync").outerHTML = UI.syncPill("sync");
$("favSide").insertAdjacentHTML("beforeend", UI.sideFoot({ settingsAttrs: `id="settingsBtn" aria-label="${SETTINGS_NAME}"`, settingsLabel: SETTINGS_NAME }));
const REFRESH_EMPTY = UI.refreshEmpty("data-refresh");
const el = {};
[
  "folderSelect", "folderList", "folderHead", "settingsHeading", "settingsFoldersHeading", "settingsAi", "settingsFirstRunHint", "searchInput", "searchCount", "refreshBtn", "activity", "settingsBtn", "helpBtn",
  "banner", "bannerText", "bannerBtn", "bannerClose", "syncNotice", "syncText", "syncViewBtn", "syncCloseBtn", "syncDetail",
  "tabs", "stagebar", "sortBox", "classFilter", "tagFilter", "aiTagSlot", "listHeader", "favSel", "list", "basket", "basketToggle", "basketCount",
  "basketList", "basketClearBtn", "toast", "settingsDialog", "folderToggles", "thinkingRow", "intervalInput",
  "coarseBatchInput", "fineBatchInput", "aiBatchInput", "tagLimitInput", "aiNewTagMaxInput", "aiRemoveTagsInput", "openOptionsBtn", "thinkingInput", "titleMaxInput",
  "titleMaxHint", "analyzeMaxInput", "analyzeMaxHint", "csvBtn", "confirmDialog",
  "confirmTitle", "confirmBody", "confirmOk",
  "criteriaDialog", "criteriaTitle", "criteriaInput", "helpDialog",
  "biliBtn", "main", "viewer", "viewerCloseBtn", "viewerFrame", "viewerTags",
  "tools", "writeBtn", "writeDialog", "writeScope", "writeFormat", "writeScopeCount", "writeOverwriteRow", "writeOverwrite", "writeProgress", "writeFailed", "writeStopBtn", "writeSettingsBtn", "writeCopyBtn", "writeRunBtn", "writeMdBtn"
].forEach((id) => (el[id] = $(id)));

// ---------- utils ----------
// Not logged in to B站 (the background's NOT_LOGGED_IN, B站's -101), on a read or a write in either mode: the 去登录 banner.
function send(msg) {
  return sendRaw(msg).then((r) => (MdgErrors.action(r.code) === "login" && showLogin(), r));
}
// 去设置 and 设置页 buttons: the settings page, or a toast saying why it did not open.
const openOptions = () => send({ type: "open-options" }).then((r) => r.ok || toast(`${MdgErrors.TEXT.settingsOpenFailed}：${MdgErrors.text(r)}`, true));
const showLogin = () => showBanner(MdgErrors.TEXT.biliLogin, "去登录", () => openTab("https://passport.bilibili.com/login"), "login");
// The AI platform picked at the top of the side panel: sidepanel.js keeps it in this extension's localStorage under
// this key (SELECTED_PROVIDER_KEY there). Every request carries it; the background's AI calls use it (triageChat).
const AI_PROVIDER_KEY = KEYS.aiSelectedProvider;
// Before the first read: 3.5 and older kept it under the old key prefix. Either page may open first after the update.
try {
  MdgLimits.migrateRenamedLocalStorage(localStorage);
} catch {}
function aiProviderId() {
  try {
    return localStorage.getItem(AI_PROVIDER_KEY) || "";
  } catch {
    return "";
  }
}
const NO_REPLY = "后台无响应";
function sendRaw(msg) {
  const id = aiProviderId();
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(id ? { ...msg, aiProviderId: id } : msg, (resp) => {
        // Chrome's own words (English) go to the console; the page says the one Chinese sentence.
        const err = chrome.runtime.lastError;
        if (err) console.warn("[triage] no reply to", msg.type, err.message);
        resolve(!err && resp ? resp : { ok: false, error: NO_REPLY });
      });
    } catch (e) {
      console.warn("[triage] no reply to", msg.type, e);
      resolve({ ok: false, error: NO_REPLY });
    }
  });
}

async function storeGet(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r?.[key] ?? fallback;
}
// key → [{ json, at }] of this page's writes whose change event has not come back yet; see followShared.
const ownWrites = {};
// A write of an unchanged value fires no event, so its entry would wait forever and swallow another tab's later write
// of that value; an event comes back within milliseconds, so an entry older than this is dropped.
const ECHO_MS = 2000;
function noteOwnWrites(obj) {
  for (const [k, v] of Object.entries(obj)) {
    const list = (ownWrites[k] ||= []);
    list.push({ json: JSON.stringify(v ?? null), at: Date.now() });
    if (list.length > 20) list.shift();
  }
}
let storeFailShown = false;
function storeSet(key, value) {
  noteOwnWrites({ [key]: value });
  return store({ [key]: value });
}
// Writes obj to storage.local; a failure is logged and toasted once until a write succeeds again (关注 writes through
// this too). Resolves false on failure.
function store(obj) {
  return chrome.storage.local.set(obj).then(
    () => ((storeFailShown = false), true),
    (e) => {
      console.error("[triage] storage write failed", Object.keys(obj), e);
      if (!storeFailShown) toast(`保存失败，本地存储可能已满：${e?.message || e}`, true);
      storeFailShown = true;
      return false;
    }
  );
}
// Read-modify-writes of a shared record (已出分拣范围, the left trail, a folder's list or 取消收藏) run one at a time: two overlapping ones each
// write back what they read, and the first one's change is lost. A queued fn must not queue another (it would wait on itself).
let storeChain = Promise.resolve();
function serialStore(fn) {
  const run = storeChain.then(fn);
  storeChain = run.catch(() => {});
  return run;
}

const stamp = (d = new Date(), withTime = true) => MdgCommon.localDate(d, withTime);
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${stamp(d, false)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const videoUrl = UI.videoUrl;

// Waits ms, returning early when keepGoing() turns false. Every wait of the page goes through it (runs' too).
function sleepWhile(ms, keepGoing) {
  return MdgRuns.sleep(ms, keepGoing);
}

function openTab(url) {
  chrome.tabs.create({ url });
}

let ownTabId;
// Opens the side panel on this tab with the video as its context; the panel takes the request
// the same way as the player's AI 总结 button.
function askAi(it) {
  const contextRef = { site: "bilibili", videoId: it.bvid, title: it.title, author: it.upper, url: videoUrl(it.bvid) };
  MdgLimits.askSidepanel({ tabId: ownTabId, contextRef });
  chrome.sidePanel.open({ tabId: ownTabId }).catch((err) => toast(`${MdgErrors.TEXT.sidepanelOpenFailed}：${err.message}`, true));
}

// Busy button: disabled + aria-busy (tokens.css draws the spinner) + 「…中」 text; false restores it.
function setBusy(btn, text) {
  if (text) {
    btn.dataset.idle ??= btn.innerHTML;
    btn.textContent = text;
  } else if (btn.dataset.idle != null) {
    btn.innerHTML = btn.dataset.idle;
    delete btn.dataset.idle;
  }
  btn.disabled = Boolean(text);
  if (text) btn.setAttribute("aria-busy", "true");
  else btn.removeAttribute("aria-busy");
}

let toastTimer = 0;
let noteTimer = 0;
const notePending = new Set(); // bvids whose note waits for noteTimer
// Each pending note goes through MdgLimits.saveVideoNote (fresh read, this one entry, write), so notes the side panel
// or 摘读记录 saved meanwhile are kept; storeSet marks the write as this page's own echo.
async function flushNotes() {
  clearTimeout(noteTimer);
  noteTimer = 0;
  for (const b of [...notePending]) {
    await MdgLimits.saveVideoNote(b, S.notes[b]?.text || "", (notes) => storeSet(K.notes, notes));
    if (!noteTimer) notePending.delete(b); // typing again meanwhile keeps it pending
  }
}
// An error stays until the next toast or a click on it; anything else goes after 6 s.
function toast(text, error = false) {
  el.toast.textContent = text;
  el.toast.classList.toggle("error", error);
  el.toast.title = error ? "点一下关闭" : "";
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  if (!error) toastTimer = setTimeout(() => (el.toast.hidden = true), 6000);
}

// The confirm dialog is shared.js's, as 摘读记录's (a function here so the tests can stand in for it).
function askConfirm(...args) {
  return UI.askConfirm(...args);
}

// kind "ai" marks an AI setup problem; a run that then succeeds clears only that kind, whichever folder it ran in.
// No btnText: the banner has only its ×.
function showBanner(text, btnText, onClick, kind = "") {
  el.banner.dataset.kind = kind;
  el.bannerText.textContent = text;
  el.bannerBtn.hidden = !btnText;
  el.bannerBtn.textContent = btnText;
  el.bannerBtn.setAttribute("aria-label", btnText);
  el.bannerBtn.onclick = onClick;
  el.banner.hidden = false;
}

// The AI run rules (aiJudge and the codes that end a run) are runs.js's, shared with 摘读记录; here a B站 limit (细看's
// subtitles) waits too.
const { aiSettingsCode, aiEnds } = MdgRuns;
const aiJudge = () => MdgRuns.aiJudge((r) => THROTTLES[r.code]);

// limit: the 收藏夹设置 row a cut answer asks to raise, 粗看输出上限 (标题粗看 and ✦ AI 打标签) or 细看输出上限.
function handleAiError(error, code = "", limit = "粗看") {
  const text = String(error || "AI 调用失败");
  const access = MdgErrors.grantOrigin(text, code);
  if (access) {
    showBanner(text, MdgErrors.LABEL.grant, async () => {
      if (await access.request()) {
        el.banner.hidden = true;
        toast(MdgErrors.TEXT.granted);
      }
    }, "ai");
  } else if (aiSettingsCode(code)) {
    showBanner(text, MdgErrors.LABEL.toSettings, openOptions, "ai");
  } else if (code === "AI_TRUNCATED") {
    showBanner(`${text}。建议调大${limit}输出上限${hasThinkingToggle() ? "或关闭思考" : ""}`, `打开${SETTINGS_NAME}`, () => openSettings(true), "ai");
  } else toast(text, true);
}
// Only platforms with the 开启思考 switch in 收藏夹设置 can turn thinking off.
const hasThinkingToggle = () => Boolean(S.settings.thinkingToggle);
const clearAiBanner = () => {
  if (el.banner.dataset.kind === "ai") el.banner.hidden = true;
};

// ---------- derived ----------
const tagById = (id) => S.tags.find((t) => t.id === id);
const inFolderView = () => S.mediaId !== ALL && S.mediaId !== REMOVED;
// The open folder's tags; 所有收藏夹 has every chosen folder's, 已出分拣范围 every tag.
function viewTags() {
  if (S.mediaId === REMOVED) return S.tags;
  const ids = S.mediaId === ALL ? S.folders.map((f) => String(f.id)) : [String(S.mediaId)];
  return S.tags.filter((t) => ids.includes(t.folder));
}
// Filter chips: one per name, so same-name tags of several folders filter together.
function tagChips() {
  const chips = [];
  for (const t of viewTags()) {
    const c = chips.find((x) => x.name === t.name);
    if (c) c.ids.push(t.id);
    else chips.push({ name: t.name, color: t.color, ids: [t.id] });
  }
  return chips;
}
// Tags per folder (收藏夹设置); only creating a new one is refused past it.
const tagLimit = () => S.settings.triageTagLimit;
const FOLDER_ONLY = "标签按收藏夹分开，先打开一个具体收藏夹";
// A video's tags in the open view. A tag belongs to one folder and stays there when the video moves, so a folder shows
// only its own; 所有收藏夹 those of the video's folders (as the picker) and of the ones it was just unfavorited from;
// 已出分拣范围 every one.
function tagIdsOf(bvid) {
  const left = inFolderView() ? [] : S.itemMap.get(bvid)?.left || [];
  const folders = S.mediaId === REMOVED ? null : [...pickerFolders(bvid), ...left.map(String)];
  return (S.videoTags[bvid] || []).filter((id) => {
    const t = tagById(id);
    return t && (!folders || folders.includes(t.folder));
  });
}
// Only 取消收藏 / 保留 finish a video; tags and notes never do.
const isProcessed = (bvid) => Boolean(S.decisions[bvid]);
// 粗看 and 细看 runs keep going in their own folder (mediaId) after another one opens; these are the open folder's.
const ownStage1 = () => Boolean(runs.get("stage1")) && S.stage1.mediaId === String(S.mediaId);

const ownGroup = () => (S.group?.mediaId === String(S.mediaId) ? S.group : null);
const runWhere = (run) => (run.mediaId === String(S.mediaId) ? "" : `（${folderName(run.mediaId)}）`);

// A failed 粗看 or 细看 on its card and its group head; the reason follows on the card.
const ANALYSIS_FAILED = "分析失败";
// A card whose 粗看 or 细看 request is in flight, on its cover and on its verdict badge.
const ANALYZING = "分析中…";
// MdgTagCore.verdictOf with the failed 细看's error, or the failed 粗看's on a card without a 粗看 (not for an invalid
// video, which is 可清理 anyway).
function verdictOf(it) {
  const a = S.analyses[it.bvid];
  const v = MdgTagCore.verdictOf({ title: S.titleRes[it.bvid], analysis: a, invalid: it.invalid });
  return { ...v, failed: it.invalid ? "" : a?.status === "error" ? MdgErrors.text(a) : failedCoarse(it) ? S.coarseFailed.get(it.bvid) || MdgErrors.TEXT.unknown : "" };
}

// Search covers title, uploader, the AI one-liner and points, the note and tag names; every word must match.
function searchText(it) {
  const a = S.analyses[it.bvid];
  return [it.title, it.upper, a?.oneLiner, ...(a?.points || []), S.notes[it.bvid]?.text, ...tagIdsOf(it.bvid).map((id) => tagById(id).name)]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

// Several tag chips narrow the list: a video must carry every selected tag. One chip can stand for same-named tags of
// several folders (所有收藏夹), so selected ids are grouped by name and any id of a group counts (pure).
function hasAllTags(videoIds, selectedIds, nameOf) {
  const have = new Set(videoIds);
  const groups = new Map();
  for (const id of selectedIds) groups.set(nameOf(id), [...(groups.get(nameOf(id)) || []), id]);
  return [...groups.values()].every((ids) => ids.some((id) => have.has(id)));
}

// Why a video is in 已出分拣范围: "invalid" (also invalid in a folder), "out" (still in a folder that is not chosen), "unfav"
// (in no folder), "" until checked. inFolder, once looked up, outranks where a 移动 here sent it.
const KINDS = [["unfav", MdgErrors.LABEL.unfaved], ["out", "在未勾选收藏夹"], ["invalid", MdgErrors.LABEL.invalid]];
const KIND_NAME = Object.fromEntries(KINDS);
// A decided card's badge and the 已保留 chip.
const ACTION_LABEL = { unfav: KIND_NAME.unfav, keep: MdgErrors.LABEL.kept };
function kindOf(it) {
  if (it.invalid || it.hidden) return "invalid";
  const at = it.inFolder !== undefined ? it.inFolder : it.movedTo;
  return at ? "out" : it.inFolder === null ? "unfav" : "";
}

// 重复收藏: in more than one chosen folder (所有收藏夹 only; elsewhere items have no .folders).
const isDup = (it) => it.folders?.length > 1;

// skip leaves one filter group out, so that group's own counts never hide its siblings: a row-3 group ("seen", "recent",
// "kind", "tagged"), "states" (all of row 3) or "tags" (row 4). 已出分拣范围's kind is its tab, never skipped.
function passFilter(it, skip = "") {
  const on = (g) => skip !== g && (skip !== "states" || g === "tags");
  if (on("dup") && S.dupFilter && !isDup(it)) return false;
  if (on("seen") && S.finishedFilter && !isFinished(it)) return false;
  if (on("recent") && S.aiRecentFilter && !aiRecentSet().has(it.bvid)) return false;
  if ((S.mediaId === REMOVED || on("kind")) && S.kindFilter && kindOf(it) !== S.kindFilter) return false;
  if (on("tagged") && S.tagState && (tagIdsOf(it.bvid).length > 0) !== (S.tagState === "tagged")) return false;
  if (on("tags") && S.tagFilter.size && !hasAllTags(tagIdsOf(it.bvid), S.tagFilter, (id) => tagById(id)?.name ?? id)) return false;
  const words = queryWords();
  if (!words.length) return true;
  const text = searchText(it);
  return words.every((w) => text.includes(w));
}

// The search words, split once per query rather than once per video.
let queryMemo = ["", []];
const queryWords = () => (queryMemo[0] === S.query ? queryMemo[1] : (queryMemo = [S.query, S.query.toLowerCase().split(/\s+/).filter(Boolean)])[1]);

// Which AI steps have run, not what they said. Invalid videos (可清理) can never be 细看'd, so they stop at 粗看;
// a failed 细看 stays where its 粗看 put it.
function stageOf(it) {
  const b = it.bvid;
  if (isProcessed(b)) return "done";
  if (S.analyses[b]?.status === "done") return "fine";
  if (it.invalid || VERDICTS[S.titleRes[b]?.verdict]) return "coarse";
  return "none";
}

function inTab(it, tab) {
  // 阅览 (and 已出分拣范围) is every video of the folder, whatever its step.
  if (tab !== "read" && stageOf(it) !== tab) return false;
  const f = S.classFilter[tab];
  return !f || f === "all" || classOf(it) === f;
}

// The filter chip a card falls under: the user's decision once there is one (as on the card), else the AI verdict.
const classOf = (it) => (isProcessed(it.bvid) ? (S.decisions[it.bvid].action === "keep" ? "kept" : "unfav") : verdictOf(it).verdict);

const failedAnalysis = (b) => S.analyses[b]?.status === "error";
// A 粗看 that failed on a card still without one: it stays in 未分析 with the failure and a retry, like a failed 细看.
const failedCoarse = (it) => S.coarseFailed.has(it.bvid) && !it.invalid && !VERDICTS[S.titleRes[it.bvid]?.verdict];
// The failed cards of a tab: 粗看's in 未分析, 细看's in 粗看完成.
const failedIn = (tab, it) => (tab === "none" ? failedCoarse(it) : tab === "coarse" && failedAnalysis(it.bvid));

// 拿不准 and low confidence are what 细看 is for, so they go first in 粗看完成.
const unsureFirst = (it) => {
  const v = verdictOf(it);
  return v.verdict === "unsure" || v.low ? 0 : 1;
};

// ---------- sort: the card order inside a tab, kept per folder ----------
const SORTS = { fav: "收藏时间", pub: "发布时间", play: "播放量", dur: "时长", title: "标题" };
const SORT_DIR = { fav: "desc", pub: "desc", play: "desc", dur: "desc", title: "asc" };
const sortOf = (id = S.mediaId) => {
  const s = S.sortBy?.[id];
  return SORTS[s?.sort] ? { sort: s.sort, dir: s.dir === "asc" || s.dir === "desc" ? s.dir : SORT_DIR[s.sort] } : { sort: "fav", dir: "desc" };
};
// (pure) 收藏时间 新→旧 is the list as Bilibili gives it, 旧→新 that reversed. The others order by value; a video without
// one (a 播放量 from before it was stored, no 发布时间 or 时长) sinks to the bottom in both directions. Ties keep list order.
function sortItems(list, sort = "fav", dir = SORT_DIR[sort] || "desc") {
  if (sort === "fav" || !SORTS[sort]) return dir === "asc" ? [...list].reverse() : [...list];
  const val = { pub: (it) => it.pubdate || null, play: (it) => (Number.isFinite(it.play) ? it.play : null), dur: (it) => it.duration || null, title: (it) => it.title || null }[sort];
  return [...list].sort(UI.byValue(val, dir));
}
const sortWords = (sort, dir) => UI.dirWords({ title: "name", play: "count", dur: "length" }[sort], dir);
// The view holds no video at all: the list's empty state and 导出's reason say it alike.
const noVideosText = () => (S.mediaId === REMOVED ? `${REMOVED_NAME}里没有视频` : S.mediaId === ALL ? "勾选的收藏夹里都没有视频" : "这个收藏夹没有视频");
function renderSort() {
  const { sort, dir } = sortOf();
  const missing = S.items.some((it) => !it.invalid && !Number.isFinite(it.play));
  const sorts = missing ? { ...SORTS, play: "播放量（刷新后才有）" } : SORTS;
  el.sortBox.innerHTML = UI.sortControl({ sorts, sort, dir, words: sortWords(sort, dir), selectAttr: "data-sort", dirAttr: "data-sort-dir" });
  // 导出 → 摘录或笔记 and this folder's table: nothing to put in them without videos (a running export stays reachable).
  const empty = S.items.length ? "" : noVideosText();
  for (const [btn, sub, on] of [[el.writeBtn, WRITE_HINT, writeRunning()], [el.csvBtn, CSV_HINT, false]]) {
    const small = btn.querySelector("small");
    if (small) small.textContent = empty && !on ? empty : sub;
    UI.setReason(btn, on ? "" : empty);
  }
}
function setSort(sort, dir) {
  S.sortBy = { ...S.sortBy, [String(S.mediaId)]: { sort, dir } };
  storeSet(K.sort, S.sortBy);
  el.list.scrollTop = 0; // as a new filter: from the first card
  render();
}

// 粗看完成 lists the batch the button will send (or is sending) first, then 拿不准 / low confidence, failed cards last.
// Within that, and in every other tab, cards follow the folder's sort.
function visibleItems() {
  const list = sortItems(S.items.filter((it) => inTab(it, S.tab) && passFilter(it)), sortOf().sort, sortOf().dir);
  // 未分析 lists the failed 粗看 cards last.
  if (S.tab === "none") return list.sort((x, y) => failedCoarse(x) - failedCoarse(y));
  if (S.tab !== "coarse") return list;
  const batch = new Set(ownGroup()?.bvids || nextBatch());
  const rank = (it) => (failedAnalysis(it.bvid) ? 3 : batch.has(it.bvid) ? 0 : 1 + unsureFirst(it));
  return list.sort((x, y) => rank(x) - rank(y));
}
const selectedIn = (list) => list.filter((it) => S.selected.has(it.bvid));
// The batch sizes in 收藏夹设置 (UI.numSetting: rounded into min–max, empty is the default).
const coarseBatchSize = () => UI.numSetting("coarseBatch", S.settings.triageCoarseBatchSize);
const fineBatchSize = () => UI.numSetting("fineBatch", S.settings.triageFineBatchSize);
// A step's batch, for 标题粗看, 字幕细看, their 按新标准重新… and 重试 (tab: the tab the step's videos are in). A
// selection there decides alone: the selected ones of open, maybe none (the button then says why, never falling back
// to the next batch); without one, open. At most n.
const picking = (tab) => tab === S.tab && S.selected.size > 0;
const pickBatch = (open, n, tab) => (picking(tab) ? selectedIn(open) : open).slice(0, n);
// The selected ones listed now (the selection is the open tab's).
const pickedShown = () => S.items.filter((it) => S.selected.has(it.bvid) && inTab(it, S.tab) && passFilter(it)).length;
// Its button: 「verb下一批 N 个」 (just verb when none), 「verb选中的 N 个」, 「verb选中的前 N 个」 (more selected than n).
// With nothing of the selection to run, N is the whole selection, hidden ones too (pickReason says why).
const batchLabel = (verb, batch, open, tab) =>
  !picking(tab) ? (batch.length ? `${verb}${NEXT_BATCH} ${batch.length} 个` : verb)
  : !batch.length ? `${verb}选中的 ${S.selected.size} 个`
  : selectedIn(open).length > batch.length ? `${verb}选中的前 ${batch.length} 个` : `${verb}选中的 ${batch.length} 个`;
// 标题粗看's and 字幕细看's buttons; in 所有收藏夹 also their dialog's title (named like the button).
const stage1Label = (batch) => batchLabel(STEP_NAME.coarse, batch, coarseOpen(), "none");
const groupLabel = (batch) => batchLabel(STEP_NAME.fine, batch, fineOpen(), "coarse");
// Why it is disabled when the selection has nothing it can run (why: 「选中的都不能字幕细看」 and the like).
const pickReason = (why, batch, tab) => (!picking(tab) || batch.length ? "" : pickedShown() ? why : UI.HIDDEN_ALL);
// What 按新标准重新粗看 / 细看 can send: the stale ones its tab lists now (search and filters applied), from any tab
// (the 判断标准 dialog offers 重新粗看 too); redoState takes one run's batch of them.
const redoCoarseOpen = () => staleCoarse().filter((it) => inTab(it, "coarse") && passFilter(it));
const redoFineOpen = () => staleFine().filter((it) => inTab(it, "fine") && passFilter(it));
// 按新标准重新粗看 / 细看's batch, label and why it is disabled: row 3's button and the 「判断标准改了」 dialog's.
const redoState = (verb, open, cap, tab) => {
  const batch = pickBatch(open, cap, tab);
  const why = aiBusyReason() || pickReason(`选中的都不用按新标准重新${verb}`, batch, tab) || (batch.length ? "" : `当前筛选下没有要重新${verb}的视频`);
  return { batch, label: batchLabel(`按新标准重新${verb}`, batch, open, tab), why, verb };
};
// One step's redo, as row 3's button, the 「判断标准改了」 dialog and their click all take it.
const redoOf = (step) => (step === "coarse" ? redoState("粗看", redoCoarseOpen(), coarseBatchSize(), "coarse") : redoState("细看", redoFineOpen(), fineBatchSize(), "fine"));
// The selection belongs to the open tab (switching tabs clears it). A filter may hide part of it: every action and count
// takes only what is listed, and the selection bar says how many are hidden.
const visibleSelected = () => selectedIn(visibleItems());

function stageCounts() {
  const c = { none: 0, coarse: 0, fine: 0, done: 0, read: 0 };
  for (const it of S.items) {
    if (!passFilter(it)) continue;
    c[stageOf(it)]++;
    c.read++;
  }
  return c;
}
// The earliest step that still has videos.
const currentStage = (c) => STAGES.find(([k]) => c[k])?.[0] || "none";

// The 细看 batch: the first fineBatchSize() selected cards of 粗看完成, otherwise its first fineBatchSize(), 拿不准 / low confidence first.
const fineOpen = () => S.items.filter((it) => inTab(it, "coarse") && passFilter(it) && needsAnalysis(it.bvid)).sort((x, y) => unsureFirst(x) - unsureFirst(y));
function nextBatch() {
  return pickBatch(fineOpen(), fineBatchSize(), "coarse").map((it) => it.bvid);
}
