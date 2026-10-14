// Static-server preview only: load the fake chrome.* before anything reads it. Never fetched inside the extension.
if (!globalThis.chrome?.runtime?.id) await import("./dev/mock-chrome.js");

// ---------- constants ----------
const THROTTLE_MS = globalThis.__TRIAGE_THROTTLE_MS || 10 * 60 * 1000;
// Error code -> the limit wait (runs.js's hold: { ms, label }). AI 429s clear far sooner than B站 risk control.
const THROTTLES = { THROTTLED: { ms: THROTTLE_MS, label: "B站限流卡住" }, AI_THROTTLED: { ms: 60 * 1000, label: "AI 平台限流卡住" } };
const SYNC_MIN_GAP_MS = 60 * 1000;
// Progress tabs: how far a video has been looked at. The AI class is a filter inside a tab, never a tab.
// 阅览 sits apart after them.
const STAGES = [
  ["none", "未分析"],
  ["coarse", "粗看完成"],
  ["fine", "细看完成"],
  ["done", "处理完成"]
];
// Storage keys. The shared ones come from MdgLimits.KEYS; the rest only this page uses.
const KEYS = MdgLimits.KEYS;
const K = {
  lastFolder: "triage_last_folder",
  tags: KEYS.triageTags, // [{ id, name, color, folder, rule? }]: folder is the mediaId the tag belongs to; rule is the one line the AI follows
  folderCriteria: KEYS.triageFolderCriteria, // { [mediaId]: 判断标准 }
  simplified: KEYS.triageSimplified,
  tagsByFolder: "triage_tags_by_folder_v1",
  videoTags: KEYS.triageVideoTags,
  basket: KEYS.triageBasket,
  notes: KEYS.triageNotes,
  decisions: (id) => `triage_decisions_${id}`, // 取消收藏 only: it changes one Bilibili folder
  kept: "triage_kept", // { [bvid]: { action: "keep", at } }: 保留 belongs to the video, so it shows in every folder
  keptMigrated: "triage_kept_v1",
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
const TOVIEW = "toview"; // 稍后再看, listed by triage-bg as one more folder
// The fixed AI classes, shown as chips inside 粗看完成 and 细看完成.
// The ids are the badge color classes too.
const { VERDICTS } = MdgTagCore;

// One-time fold of the global 判断标准 (sync triageCriteria, released since v1.2.0) into per-folder 判断标准, and a clean
// tag list (pure). Each folder seen in triage gets the global criteria when non-empty; folders never opened in triage
// start empty. Tags: same name → the first id wins and video tags are remapped to it.
function simplifyMigration({ tags, videoTags, criteria, folderIds = [], folderCriteria }) {
  const vt = videoTags || {};
  const candidates = Array.isArray(tags) ? tags : [];
  const out = [];
  const remap = {};
  for (const t of candidates) {
    const name = String(t?.name ?? "").trim();
    if (!name || !t.id || out.some((x) => x.id === t.id)) continue;
    const kept = out.find((x) => x.name === name);
    if (kept) remap[t.id] = kept.id;
    else out.push({ id: t.id, name, color: t.color || UI.nextTagColor(out) });
  }
  const nextVideoTags = Object.fromEntries(Object.entries(vt).map(([b, ids]) => [b, [...new Set(ids.map((id) => remap[id] || id))]]));
  const crit = {};
  const text = String(criteria || "").trim();
  if (text) for (const f of new Set(folderIds.map(String))) crit[f] = text;
  return { tags: out, videoTags: nextVideoTags, folderCriteria: { ...crit, ...folderCriteria } };
}

const newTagId = () => MdgTagCore.newTagId("t");

// One-time move of the global tags into folders (pure). folders = [{ id, bvids }], chosen first. A tag without a folder
// goes to the folder its videos are in; used in several, the first keeps it and each other gets a copy (new id), and
// each video points to the copy of every folder it is in. Unused (or used only outside these folders) → fallback;
// without a fallback the tag stays unplaced.
function tagsByFolderMigration({ tags = [], videoTags = {}, folders = [], fallback = "" }) {
  const folderOf = {};
  for (const f of folders) for (const b of f.bvids || []) (folderOf[b] ||= []).push(String(f.id));
  const copies = {}; // { [old id]: { [folder]: id } }
  const out = [];
  for (const t of tags) {
    if (t.folder) {
      out.push(t);
      continue;
    }
    const users = Object.keys(videoTags).filter((b) => videoTags[b].includes(t.id));
    const used = folders.map((f) => String(f.id)).filter((f) => users.some((b) => folderOf[b]?.includes(f)));
    if (!used.length) {
      out.push(fallback ? { ...t, folder: fallback } : t);
      continue;
    }
    copies[t.id] = {};
    used.forEach((f, i) => {
      const id = i ? newTagId() : t.id;
      copies[t.id][f] = id;
      out.push({ ...t, id, folder: f });
    });
  }
  const remap = (b, id) => {
    const mine = copies[id] ? (folderOf[b] || []).map((f) => copies[id][f]).filter(Boolean) : [];
    return mine.length ? mine : [id];
  };
  const nextVideoTags = Object.fromEntries(Object.entries(videoTags).map(([b, ids]) => [b, [...new Set(ids.flatMap((id) => remap(b, id)))]]));
  return { tags: out, videoTags: nextVideoTags };
}

// The stored records' shapes and the export helpers (pure) live in triage-core.js.
const { refavorited, mergeFolderItems, updateRemoved, moveToRemoved, inferFrom, forgetLeft, noteLeft, keepInvalidInfo, idsChanged, mergeHead, unfavOnly, mdLinkText, safeNoteName, oneLine, mdLink, wikiLink, zipStored } = TriageCore;

// One-time split (pure): 保留 moves out of every triage_decisions_<folder> into one list, the newest per video winning.
function splitKept(all) {
  const kept = { ...(all[K.kept] || {}) };
  const folders = {};
  for (const [k, d] of Object.entries(all)) {
    if (!k.startsWith("triage_decisions_")) continue;
    folders[k] = {};
    for (const [b, v] of Object.entries(d || {})) {
      if (v?.action !== "keep") folders[k][b] = v;
      else if (!((kept[b]?.at || 0) >= (v.at || 0))) kept[b] = v;
    }
  }
  return { kept, folders };
}

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
  aiRecent: {},
  sortBy: {}, // triage_sort
  aiRecentFilter: false, // AI 刚打的
  kindFilter: "", // kindOf: "invalid" (已失效) anywhere; "unfav" / "out" in 已出分拣范围 only
  seenCfg: MdgSurfaces.seenConfig(MdgSurfaces.SEEN_DEFAULTS), // 设置页「观看进度 → 封面显示」
  seenPct: {}, // bvid → [percent, view_at] from the history, null when it has none
  noteOpen: new Set(), // empty notes the user opened for editing
  settings: {
    triageIntervalSec: 8,
    triageFineBatchSize: 10, // 字幕细看每批数量, 1–50
    triageCoarseBatchSize: 100, // 标题粗看每批数量, 1–1000
    triageThinking: false,
    triageTitleMaxTokens: 0,
    triageAnalyzeMaxTokens: 0,
    triageTagLimit: 10, // tags per folder; only creating a new one is refused past it
    triageAiNewTagMax: 5, // new tags one 批量打 may propose
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
  syncError: "", // the open folder's last 刷新 failure; stays under the title until a read succeeds
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
runs.put("sync", () => S.syncing && { text: `刷新中…${pageText(S.mediaId)}` });
runs.put("proposal", () => S.ai.proposal && { text: "标签建议待确认" });
runs.put("aiOther", () => otherAiFolder() && { text: `「${folderName(otherAiFolder())}」的标签建议待确认` });
// 观看进度's 30-minute pause on B站 risk control comes from the background (triage_seen_meta); tick() redraws it.
runs.put("seen", () => S.seenCfg.on && S.seenRead.until > Date.now() && { text: "观看进度", wait: { until: S.seenRead.until, label: THROTTLES.THROTTLED.label } });
runs.put("seenRead", () => S.seenCfg.on && S.seenRead.busy && S.seenRead.pages && { text: `读观看进度… 已读 ${S.seenRead.pages} 页` });
// The pill's button per job: [data-head, label, label while it stops (it then waits for the step in flight)].
const PILL_BTN = { group: ["group", "暂停细看", "暂停中"], stage1: ["stage1", "暂停粗看", "暂停中"], write: ["write", "停止", "停止中"], fav: ["fav", "停止", "停止中"], ai: ["tags", "查看"], proposal: ["tags", "查看"], aiOther: ["aiOther", "查看"] };
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
const staleFine = () => (judged() ? S.items.filter((it) => stageOf(it) === "fine" && isStale(S.analyses[it.bvid], criteriaFor(homeOf(it)))) : []);

const $ = (id) => document.getElementById(id);

const { composing, typingIn } = globalThis.MdgTyping;

const UI = globalThis.TriageUi;
const { esc, pad, fmtDate, fmtDuration, fmtCount, cleanTagName, plainClick, img } = UI;
// Row 2 and the sidebar foot are drawn by shared.js, as in 关注; here before el picks them up.
$("favRowTools").insertAdjacentHTML("beforeend", UI.searchBox("searchInput", "searchCount", "搜这个收藏夹") + UI.rowButtons({
  activityId: "activity", refreshId: "refreshBtn", refreshLabel: "从 B站刷新这个收藏夹", exportId: "exportBtn", menuId: "tools",
  menuHtml: UI.menuItem('id="writeBtn" aria-label="导出摘录或笔记"', "摘录或笔记…", "摘录，或逐个视频的笔记") + UI.menuItem('id="csvBtn" aria-label="下载这个收藏夹的表格 CSV"', "这个收藏夹的表格 (CSV)", "标题、AI 判断、标签、备注") + "<hr>" + UI.BACKUP_ITEM,
  settingsAttr: "data-open-settings", settingsLabel: "收藏夹设置"
}));
$("favSync").outerHTML = UI.syncPill("sync");
$("favSide").insertAdjacentHTML("beforeend", UI.sideFoot({ settingsAttrs: 'id="settingsBtn" aria-label="收藏夹设置"', settingsLabel: "收藏夹设置" }));
const REFRESH_EMPTY = UI.refreshEmpty("data-refresh");
const el = {};
[
  "folderSelect", "folderList", "folderHead", "settingsHeading", "settingsFoldersHeading", "settingsAi", "settingsFirstRunHint", "searchInput", "searchCount", "refreshBtn", "activity", "settingsBtn", "helpBtn",
  "banner", "bannerText", "bannerBtn", "bannerClose", "syncNotice", "syncText", "syncViewBtn", "syncCloseBtn", "syncDetail",
  "tabs", "stagebar", "sortBox", "classFilter", "tagFilter", "aiTagSlot", "listHeader", "list", "basket", "basketToggle", "basketCount",
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
const showLogin = () => showBanner("没登录 B站：先在这个浏览器里登录 B站", "去登录", () => openTab("https://passport.bilibili.com/login"), "login");
// The AI platform picked at the top of the side panel: sidepanel.js keeps it in this extension's localStorage under
// this key (SELECTED_PROVIDER_KEY there). Every request carries it; the background's AI calls use it (triageChat).
const AI_PROVIDER_KEY = "mdg_ai_selected_provider";
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
function sendRaw(msg) {
  const id = aiProviderId();
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(id ? { ...msg, aiProviderId: id } : msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(resp || { ok: false, error: "后台无响应" });
      });
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) });
    }
  });
}

async function storeGet(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r?.[key] ?? fallback;
}
// key → JSON of this page's writes whose change event has not come back yet; see followShared.
const ownWrites = {};
function noteOwnWrites(obj) {
  for (const [k, v] of Object.entries(obj)) {
    const list = (ownWrites[k] ||= []);
    list.push(JSON.stringify(v ?? null));
    if (list.length > 20) list.shift(); // an unchanged value fires no event, so its entry would never leave
  }
}
let storeFailShown = false;
function storeSet(key, value) {
  noteOwnWrites({ [key]: value });
  return store({ [key]: value });
}
// Writes obj to storage.local; a failure is logged and toasted once (关注 writes through this too). Resolves false on failure.
function store(obj) {
  return chrome.storage.local.set(obj).then(
    () => true,
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

function stamp(d = new Date(), withTime = true) {
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${day}-${pad(d.getHours())}${pad(d.getMinutes())}` : day;
}
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${stamp(d, false)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const videoUrl = (bvid) => `https://www.bilibili.com/video/${bvid}`;

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
  chrome.storage.local.set({ [KEYS.playerAiQuickAction]: { id: `triage-${Date.now()}`, tabId: ownTabId, prompt: "", contextRef } });
  chrome.sidePanel.open({ tabId: ownTabId }).catch((err) => toast(`打开侧边栏失败：${err.message}`, true));
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
// An error stays until the next toast or a click on it; anything else goes after 6 s.
function toast(text, error = false) {
  el.toast.textContent = text;
  el.toast.classList.toggle("error", error);
  el.toast.title = error ? "点一下关闭" : "";
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  if (!error) toastTimer = setTimeout(() => (el.toast.hidden = true), 6000);
}

// alone: only the one button (a notice, not a question).
// reason: the OK button is disabled with why (only 取消 is left).
function askConfirm(title, bodyHtml, okText, { danger = false, alone = false, reason = "" } = {}) {
  el.confirmDialog.querySelector("button[value=cancel]").hidden = alone;
  el.confirmTitle.textContent = title;
  el.confirmBody.innerHTML = bodyHtml;
  el.confirmOk.className = danger ? "danger solid" : "primary";
  el.confirmOk.textContent = okText;
  el.confirmOk.setAttribute("aria-label", okText);
  UI.setReason(el.confirmOk, reason);
  el.confirmDialog.returnValue = "";
  el.confirmDialog.showModal();
  return new Promise((resolve) => {
    el.confirmDialog.addEventListener("close", () => resolve(el.confirmDialog.returnValue === "ok"), { once: true });
  });
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

// AI errors after which every later request fails alike: the AI_ codes MdgErrors.CODES sends to 去设置 (the side panel
// offers 去设置 on the same list), plus 未授权访问 (no code; the banner offers the grant). 粗看, 细看 and AI 打标签 stop at
// the first one. AI_TIMEOUT sends the
// same request again and ends the run after AI_TIMEOUT_TRIES in a row; AI_THROTTLED waits, AI_THROTTLE_WAITS times in a
// row at most, then ends the run as AI_GAVE_UP.
const aiSettingsCode = (code) => String(code || "").startsWith("AI_") && MdgErrors.action(code) === "settings";
const aiEnds = (r) => aiSettingsCode(r.code) || /未授权访问/.test(r.error || "");
const AI_TIMEOUT_TRIES = 2;
const AI_THROTTLE_WAITS = 5;
const aiGaveUp = () => ({ ok: false, code: "AI_GAVE_UP", error: `AI 平台持续限流，已等待重试 ${AI_THROTTLE_WAITS} 次，已停止` });
// A run's judge (runs.js) of AI answers, by the rule above, with its own counts in a row; any other error fails only this
// request (a video in 细看, a batch in 粗看). "ok"; "retry" (the same request at once); "wait" (THROTTLES[r.code],
// then the same request); "stop" (r is then AI_GAVE_UP after too many waits); "item" (only this request failed).
function aiJudge() {
  const n = { timeouts: 0, waits: 0 };
  return (r) => {
    if (!r.ok && r.code === "AI_TIMEOUT" && ++n.timeouts < AI_TIMEOUT_TRIES) return "retry";
    if (!r.ok && r.code === "AI_THROTTLED" && n.waits++ === AI_THROTTLE_WAITS) Object.assign(r, aiGaveUp());
    if (!r.ok && THROTTLES[r.code]) return "wait";
    if (!r.ok && aiEnds(r)) return "stop";
    n.timeouts = n.waits = 0;
    return r.ok ? "ok" : "item";
  };
}

function handleAiError(error, code = "") {
  const text = String(error || "AI 调用失败");
  const access = MdgErrors.grantOrigin(text);
  if (access) {
    showBanner(text, `授权访问 ${access.origin}`, async () => {
      if (await access.request()) {
        el.banner.hidden = true;
        toast("已授权，请重试");
      }
    }, "ai");
  } else if (text.includes("配置 AI")) {
    showBanner("还没有配置 AI 平台", "去设置", () => send({ type: "open-options" }), "ai");
  } else if (aiSettingsCode(code)) {
    showBanner(text, "去设置", () => send({ type: "open-options" }), "ai");
  } else if (text.includes("截断")) {
    showBanner(`${text}。建议调大输出上限${hasThinkingToggle() ? "或关闭思考" : ""}`, "打开收藏夹设置", () => openSettings(true), "ai");
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
// How many new tags 批量打 may propose: at most triageAiNewTagMax, within the folder's room.
const tagLimit = () => S.settings.triageTagLimit;
const aiNewTagRoom = (folder = S.mediaId) => Math.max(0, Math.min(S.settings.triageAiNewTagMax, tagLimit() - S.tags.filter((t) => t.folder === String(folder)).length));
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

// MdgTagCore.verdictOf with the failed 细看's error, or the failed 粗看's on a card without a 粗看 (not for an invalid
// video, which is 可清理 anyway).
function verdictOf(it) {
  const a = S.analyses[it.bvid];
  const v = MdgTagCore.verdictOf({ title: S.titleRes[it.bvid], analysis: a, invalid: it.invalid });
  return { ...v, failed: it.invalid ? "" : a?.status === "error" ? a.error || "分析失败" : failedCoarse(it) ? S.coarseFailed.get(it.bvid) || "分析失败" : "" };
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
const KINDS = [["unfav", "已取消收藏"], ["out", "在未勾选收藏夹"], ["invalid", "已失效"]];
function kindOf(it) {
  if (it.invalid || it.hidden) return "invalid";
  const at = it.inFolder !== undefined ? it.inFolder : it.movedTo;
  return at ? "out" : it.inFolder === null ? "unfav" : "";
}

// 重复收藏: in more than one chosen folder (所有收藏夹 only; elsewhere items have no .folders).
const isDup = (it) => it.folders?.length > 1;

// skip leaves one filter group out, so that group's own counts never hide its siblings: a row-3 group ("seen", "recent",
// "kind"), "states" (all of row 3) or "tags" (row 4). 已出分拣范围's kind is its tab, never skipped.
function passFilter(it, skip = "") {
  const on = (g) => skip !== g && (skip !== "states" || g === "tags");
  if (on("dup") && S.dupFilter && !isDup(it)) return false;
  if (on("seen") && S.finishedFilter && !isFinished(it)) return false;
  if (on("recent") && S.aiRecentFilter && !aiRecentSet().has(it.bvid)) return false;
  if ((S.mediaId === REMOVED || on("kind")) && S.kindFilter && kindOf(it) !== S.kindFilter) return false;
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
function renderSort() {
  const { sort, dir } = sortOf();
  const missing = S.items.some((it) => !it.invalid && !Number.isFinite(it.play));
  const sorts = missing ? { ...SORTS, play: "播放量（刷新后才有）" } : SORTS;
  el.sortBox.innerHTML = UI.sortControl({ sorts, sort, dir, words: sortWords(sort, dir), selectAttr: "data-sort", dirAttr: "data-sort-dir" });
  // 导出 → 摘录或笔记 and this folder's table: nothing to put in them without videos (a running export stays reachable).
  const empty = S.items.length ? "" : "这个收藏夹没有视频";
  for (const [btn, sub, on] of [[el.writeBtn, "摘录，或逐个视频的笔记", writeRunning()], [el.csvBtn, "标题、AI 判断、标签、备注", false]]) {
    const small = btn.querySelector("small");
    if (small) small.textContent = empty && !on ? empty : sub;
    UI.setReason(btn, on ? "" : empty);
  }
}
function setSort(sort, dir) {
  S.sortBy = { ...S.sortBy, [String(S.mediaId)]: { sort, dir } };
  storeSet(K.sort, S.sortBy);
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
// The batch sizes in 收藏夹设置: whole numbers within min–max; empty or not a number is the default.
const intSetting = (v, min, max, def) => Math.max(min, Math.min(max, Math.floor(Number(v)) || def));
const coarseBatchSize = () => intSetting(S.settings.triageCoarseBatchSize, 1, 1000, 100);
const fineBatchSize = () => intSetting(S.settings.triageFineBatchSize, 1, 50, 10);
// 请求间隔, as 关注's: 0–600 s, empty is the default 8 (0 is a value here, not empty).
const intervalSetting = (v) => (v === "" || v == null ? 8 : intSetting(v, 0, 600, 0));
// A step's batch, for 标题粗看, 字幕细看, their 按新标准重新… and 重试 (tab: the tab the step's videos are in). A
// selection there decides alone: the selected ones of open, maybe none (the button then says why, never falling back
// to the next batch); without one, open. At most n.
const picking = (tab) => tab === S.tab && S.selected.size > 0;
const pickBatch = (open, n, tab) => (picking(tab) ? selectedIn(open) : open).slice(0, n);
// The selected ones listed now (the selection is the open tab's).
const pickedShown = () => S.items.filter((it) => S.selected.has(it.bvid) && inTab(it, S.tab) && passFilter(it)).length;
// Its button: 「verb下一批 N 个」 (just verb when none), 「verb选中 N 个」, 「verb选中的前 N 个」 (more selected than n).
const batchLabel = (verb, batch, open, tab) =>
  !picking(tab) ? (batch.length ? `${verb}下一批 ${batch.length} 个` : verb)
  : !batch.length ? `${verb}选中 ${pickedShown()} 个`
  : selectedIn(open).length > batch.length ? `${verb}选中的前 ${batch.length} 个` : `${verb}选中 ${batch.length} 个`;
// Why it is disabled when the selection has nothing it can run (why: 「选中的都不能字幕细看」 and the like).
const pickReason = (why, batch, tab) => (!picking(tab) || batch.length ? "" : pickedShown() ? why : "选中的都被筛选隐藏了");
// What 按新标准重新粗看 / 细看 can send: the stale ones its tab lists now (search and filters applied), from any tab
// (the 判断标准 dialog offers 重新粗看 too); then one run's batch of them.
const redoCoarseOpen = () => staleCoarse().filter((it) => inTab(it, "coarse") && passFilter(it));
const redoCoarseList = () => pickBatch(redoCoarseOpen(), coarseBatchSize(), "coarse");
const redoFineOpen = () => staleFine().filter((it) => inTab(it, "fine") && passFilter(it));
const redoFineList = () => pickBatch(redoFineOpen(), fineBatchSize(), "fine");
// 按新标准重新粗看 / 细看's batch, label and why it is disabled: row 3's button and the 「判断标准改了」 dialog's.
const redoState = (verb, open, cap, tab) => {
  const batch = pickBatch(open, cap, tab);
  const why = aiBusyReason() || pickReason(`选中的都不用按新标准重新${verb}`, batch, tab) || (batch.length ? "" : `当前筛选下没有要重新${verb}的视频`);
  return { batch, label: batchLabel(`按新标准重新${verb}`, batch, open, tab), why };
};
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

// ---------- init ----------
init();
// 关注 mode (follow.js) borrows the viewer, the toast and the confirm dialog, keeps its undo steps here (S.modeUndo) and
// takes the keys while on.
const followMode = () => Boolean(document.body?.classList.contains("follow-mode"));
// modeKeys(key, e): null while that mode is off (the keys below run); otherwise true when it used the key.
let modeKeys = null;
// 关注's 「UP 标签」 line, redrawn with the 「视频标签」 line.
let viewerHook = null;
globalThis.MoonTriage = {
  openViewer, closeViewer, toast, askConfirm, send, store, runAiBatches, hold: (r) => THROTTLES[r.code] || null, viewing: () => S.viewing,
  // The playing 收藏夹 video's UP as { mid, name } (mid "" on items saved before it was stored); null in 关注 or with
  // nothing playing.
  viewingUp() {
    const it = !followMode() && S.viewer?.item;
    return it ? { mid: it.upperMid || "", name: it.upper || "" } : null;
  },
  // 关注's 没登录: the same 去登录 banner as 收藏夹's; off hides it only when it is that one.
  loginBanner(on) {
    if (on) showLogin();
    else if (el.banner.dataset.kind === "login") el.banner.hidden = true;
  },
  undo, pushUndo, dropModeUndo: (drop) => (S.modeUndo = S.modeUndo.filter((e) => !drop(e))), help: () => el.helpDialog.showModal(), setModeKeys: (fn) => (modeKeys = fn), setViewerHook: (fn) => (viewerHook = fn)
};

async function init() {
  UI.fillSetRows(document);
  UI.clampNumbers(document);
  bindEvents();
  // Read up front: sidePanel.open must run inside the click's user gesture, before any await.
  chrome.tabs.getCurrent().then((tab) => (ownTabId = tab?.id));
  const [{ tags, videoTags, folderCriteria }, kept, basket, notes, settingsResp, aiHistory, aiRecent, sortBy, readAt, aiProposals] = await Promise.all([
    loadTagsAndCriteria().then(async (r) => ({ ...r, ...(await loadTagsByFolder(r)) })),
    loadKept(),
    storeGet(K.basket, []),
    storeGet(K.notes, {}),
    send({ type: "triage-settings-get" }),
    storeGet(K.aiHistory, []),
    storeGet(K.aiRecent, {}),
    storeGet(K.sort, {}),
    storeGet(K.readAt, {}),
    storeGet(K.aiProposals, {})
  ]);
  Object.assign(S, { tags, videoTags, folderCriteria, kept, notes, aiHistory, aiRecent, sortBy, readAt });
  S.ai.proposals = aiProposals;
  pruneAiProposals();
  S.basket = basket.map(({ bvid, title, cover, upper, duration, opened }) => ({ bvid, title, cover, upper, duration, ...(opened ? { opened: true } : {}) }));
  if (settingsResp.ok) Object.assign(S.settings, settingsResp.data);
  renderTagLimit();
  const syncObsidian = ({ obsidianEnabled }) => document.body.classList.toggle("obsidian-off", obsidianEnabled !== true);
  const sync = await chrome.storage.sync.get({ obsidianEnabled: false, triageAiBatchSize: null, ...SEEN_DEFAULTS });
  if (sync.triageAiBatchSize != null) S.settings.triageAiBatchSize = sync.triageAiBatchSize;
  syncObsidian(sync);
  setSeenCfg(sync);
  followSeenMeta(await storeGet(KEYS.triageSeenMeta));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.obsidianEnabled) syncObsidian({ obsidianEnabled: changes.obsidianEnabled.newValue });
    if (area === "sync" && Object.keys(SEEN_DEFAULTS).some((k) => changes[k])) {
      chrome.storage.sync.get(SEEN_DEFAULTS).then((v) => {
        setSeenCfg(v);
        loadSeen(S.folderToken).then(render);
      });
    }
    if (area === "local") followSeen(changes);
    if (area === "local") followNotes(changes);
    if (area === "local") followShared(changes);
    if (area === "local") followIncluded(changes);
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "triage-seen-done") {
      S.seenRead.busy = false;
      return renderStatus();
    }
    if (msg?.type !== "triage-folder-page") return;
    S.loadPage = { mediaId: msg.mediaId, page: msg.page };
    renderTop();
    if (S.loadAll) renderListHeader(visibleItems());
    else if (!S.items.length && msg.mediaId === String(S.mediaId)) el.list.innerHTML = loadingHtml();
  });
  renderBasket();
  await loadFolders();
  setInterval(tick, 1000);
}

// A new folder choice (收藏夹设置, or 导入设置 on the options page, which writes it here): the folder list reloads and
// newly ticked folders take back their videos; unticked ones move theirs to 已出分拣范围 (retireUnchosenFolders).
async function applyIncluded(included) {
  const ticked = included.filter((id) => !S.included.includes(id));
  await loadFolders();
  recoverRemoved(ticked);
}
function followIncluded(changes) {
  const c = changes[K.included];
  if (!c || ownEcho(K.included, c) || !S.allFolders.length) return;
  const included = (c.newValue || []).map(String);
  if (included.length === S.included.length && included.every((id) => S.included.includes(id))) return;
  applyIncluded(included);
}

// Another triage tab wrote one of the lists every page writes whole: take its value, so the next
// write here does not put back what it removed. This page's own writes come back as events too and are skipped: an
// older one arriving after a newer edit would undo that edit.
const SHARED = { kept: {}, videoTags: {}, tags: [], basket: [], folderCriteria: {}, aiRecent: {} };
function followShared(changes) {
  let changed = false;
  for (const [name, empty] of Object.entries(SHARED)) {
    const c = changes[K[name]];
    if (!c) continue;
    if (ownEcho(K[name], c)) continue;
    const value = c.newValue ?? structuredClone(empty);
    if (name === "kept") followKept(value);
    else S[name] = value;
    changed = true;
  }
  // 取消收藏 records: the open folder's, as openFolder builds them; in 所有收藏夹 those of the loaded folders.
  for (const [key, c] of Object.entries(changes)) {
    const id = /^triage_decisions_(.+)$/.exec(key)?.[1];
    if (!id || ownEcho(key, c)) continue;
    const d = c.newValue || {};
    if (id === String(S.mediaId)) S.decisions = { ...S.kept, ...d };
    else if (S.loadAll && S.folderDecisions[id]) {
      S.folderDecisions[id] = d;
      rebuildAll();
    } else continue;
    changed = true;
  }
  if (changed) render();
}
// The side panel and history page edit the same notes. A pending local save is newer than any echo, and this page's
// own saves coming back must not re-render: that rebuilds the note being typed (and its IME composition).
function followNotes(changes) {
  const c = changes[K.notes];
  if (!c || noteTimer || ownEcho(K.notes, c)) return;
  S.notes = c.newValue || {};
  render();
}
function ownEcho(key, c) {
  const mine = ownWrites[key] || [];
  const i = mine.indexOf(JSON.stringify(c.newValue ?? null));
  if (i >= 0) mine.splice(0, i + 1);
  return i >= 0;
}
// 保留 also sits in the open view's decisions (see openFolder and rebuildAll); 取消收藏 there wins, as on open.
function followKept(kept) {
  for (const [b, d] of Object.entries(S.decisions)) if (d?.action === "keep" && !kept[b]) delete S.decisions[b];
  for (const [b, d] of Object.entries(kept)) if (S.decisions[b]?.action !== "unfav") S.decisions[b] = d;
  S.kept = kept;
}

// ---------- 观看进度：看完了 ----------
const { SEEN_DEFAULTS, seenConfig, seenWords } = MdgSurfaces;
function setSeenCfg(v) {
  S.seenCfg = seenConfig(v);
  document.documentElement.dataset.seenStyle = S.seenCfg.style;
  // The background reads only what is new, at most every 10 minutes (triage-seen-sync); its writes come back through followSeen.
  if (S.seenCfg.on) seenSync(false);
}
// While this page waits on a read it shows the pages read so far; B站 risk control shows how long the background waits.
// A run started by a Bilibili page is joined when its first page lands. triage-seen-sync answers as a read starts, which
// then goes on in the background until triage-seen-done.
async function seenSync(force) {
  const r = S.seenRead;
  if (r.busy) return;
  r.busy = true;
  const res = await send({ type: "triage-seen-sync", force });
  r.busy = Boolean(res.data?.reading);
  if (res.data?.until) r.until = res.data.until;
  if (force && res.data?.skipped === "throttled") toast(runs.pill(["seen"])?.text || "");
  renderStatus();
}

function followSeenMeta(meta) {
  S.seenRead.pages = meta?.resume?.pages || 0;
  S.seenRead.until = meta?.backoffUntil || 0;
  if (S.seenRead.pages && !S.seenRead.busy && S.seenCfg.on) seenSync(false);
  renderStatus();
}
// Reads the listed videos' history entries not read yet; one key per video, so a folder costs a few KB.
async function loadSeen(token) {
  if (!S.seenCfg.on) return;
  const want = S.items.map((it) => it.bvid).filter((b) => !(b in S.seenPct));
  if (!want.length) return;
  const got = await chrome.storage.local.get(want.map((b) => `seen_${b}`));
  if (token !== S.folderToken) return;
  for (const b of want) S.seenPct[b] = got[`seen_${b}`] || null;
}
function followSeen(changes) {
  if (changes[KEYS.triageSeenMeta]) followSeenMeta(changes[KEYS.triageSeenMeta].newValue);
  let hit = false;
  for (const [key, c] of Object.entries(changes)) {
    if (!key.startsWith("seen_")) continue;
    S.seenPct[key.slice(5)] = c.newValue || null;
    hit = true;
  }
  if (hit && S.seenCfg.on) render();
}
// Percent watched: the history's, else 稍后再看's own progress; null with no record or with the setting off.
function seenPercentOf(it) {
  if (!S.seenCfg.on) return null;
  const h = S.seenPct[it.bvid]?.[0];
  if (h) return h;
  if (it.seen == null || it.seen === 0) return null;
  return it.seen < 0 ? 100 : it.duration > 0 ? Math.min(100, Math.round((it.seen / it.duration) * 100)) : null;
}
// 看完了: the history says at least the set share was watched (only while that mark is shown).
const isFinished = (it) => S.seenCfg.mark && (seenPercentOf(it) ?? 0) >= S.seenCfg.threshold;
// The cover with its progress bar and, once 看完了, the corner tag or the veil (html[data-seen-style] picks one).
// Below the share, a faint 看到 N% says how far it got.
function coverHtml(it) {
  const pic = `<img class="cover" src="${esc(img(it.cover, "480w_270h_1c"))}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
  const known = seenPercentOf(it);
  const p = S.seenCfg.bar ? known : null;
  const seen = isFinished(it);
  const faint = !seen && known && S.seenCfg.mark;
  const label = seenWords(known, seen);
  const mark = seen ? `<span class="seen-veil">${label}</span><span class="seen-tag">${label}</span>` : faint ? `<span class="seen-tag faint">${label}</span>` : "";
  // Once the user has decided, their decision replaces the AI's verdict label; the AI's reason and summary stay.
  const v = isProcessed(it.bvid) ? { verdict: "none" } : verdictOf(it);
  const tag = S.analyzing.has(it.bvid) ? `<span class="cover-tag running">分析中…</span>` : VERDICTS[v.verdict] ? `<span class="cover-tag ${v.verdict}" title="${esc(v.reason)}">${VERDICTS[v.verdict]}</span>` : "";
  const dur = it.duration ? `<span class="cover-dur">${fmtDuration(it.duration)}</span>` : "";
  // A real link for right-click 在新标签页中打开 and ⌘-click; a plain click selects the card. Out of the tab order: the title
  // is the same link for the keyboard, and the title is what plays.
  return `<a class="cover-wrap${seen ? " seen" : ""}" href="${esc(videoUrl(it.bvid))}" tabindex="-1" aria-hidden="true">${pic}${tag}${dur}${mark}${p ? `<span class="seen-bar" title="看到 ${p}%"><i style="width:${Math.max(p, 2)}%"></i></span>` : ""}</a>`;
}

// Runs simplifyMigration once (flag key), then drops the sync criteria it read.
async function loadTagsAndCriteria() {
  const got = await chrome.storage.local.get([K.tags, K.videoTags, K.folderCriteria, K.simplified]);
  if (got[K.simplified]) return { tags: got[K.tags] || [], videoTags: got[K.videoTags] || {}, folderCriteria: got[K.folderCriteria] || {} };
  const keys = (await chrome.storage.local.getKeys?.()) ?? Object.keys((await chrome.storage.local.get(null)) || {});
  const folderIds = keys.map((k) => /^triage_(?:snapshot|decisions)_(.+)$/.exec(k)?.[1]).filter(Boolean);
  const { triageCriteria } = await chrome.storage.sync.get({ triageCriteria: "" });
  const out = simplifyMigration({
    tags: got[K.tags],
    videoTags: got[K.videoTags],
    criteria: triageCriteria,
    folderIds,
    folderCriteria: got[K.folderCriteria]
  });
  await chrome.storage.local.set({ [K.tags]: out.tags, [K.videoTags]: out.videoTags, [K.folderCriteria]: out.folderCriteria, [K.simplified]: true });
  await chrome.storage.sync.remove("triageCriteria");
  return out;
}

// Runs tagsByFolderMigration until every tag has a folder (flag key), from the cached folder lists.
async function loadTagsByFolder({ tags, videoTags }) {
  if (await storeGet(K.tagsByFolder, false)) return { tags, videoTags };
  const keys = ((await chrome.storage.local.getKeys?.()) ?? Object.keys((await chrome.storage.local.get(null)) || {})).filter((k) => k.startsWith(KEYS.triageSnapshotPrefix));
  const got = await chrome.storage.local.get([K.included, K.lastFolder, ...keys]);
  const included = (got[K.included] || []).map(String);
  const cached = keys.map((k) => k.slice(16));
  const ids = [...new Set([...included.filter((id) => cached.includes(id)), ...cached])];
  const out = tagsByFolderMigration({
    tags,
    videoTags,
    folders: ids.map((id) => ({ id, bvids: got[K.snapshot(id)]?.bvids || [] })),
    fallback: String(got[K.lastFolder] || included[0] || "")
  });
  const done = out.tags.every((t) => t.folder);
  await chrome.storage.local.set({ [K.tags]: out.tags, [K.videoTags]: out.videoTags, ...(done ? { [K.tagsByFolder]: true } : {}) });
  return out;
}

async function loadKept() {
  const got = await chrome.storage.local.get([K.kept, K.keptMigrated]);
  if (got[K.keptMigrated]) return got[K.kept] || {};
  const { kept, folders } = splitKept((await chrome.storage.local.get(null)) || {});
  await chrome.storage.local.set({ ...folders, [K.kept]: kept, [K.keptMigrated]: true });
  return kept;
}

// The chosen folders other than exceptId, the ones whose cached lists keep a video out of 已出分拣范围. 稍后再看 missing
// from the list because its read failed is not deleted: it counts until the next read.
function chosenOtherIds(exceptId) {
  const ids = S.folders.map((f) => String(f.id));
  if (S.toviewUnread && !ids.includes(TOVIEW)) ids.push(TOVIEW);
  return ids.filter((id) => id !== String(exceptId));
}

// A folder that is no longer chosen (deleted on Bilibili or unticked) gets no new list to diff against, so its videos
// (unless in a chosen folder's list) move to 已出分拣范围 here and its records go. Runs once S.folders is known.
function retireUnchosenFolders() {
  return serialStore(async () => {
    if (!S.allFolders.length) return; // 默认收藏夹 always exists; an empty list is never "every folder deleted"
    if (!S.included.length) return; // nothing chosen yet (or all unticked by accident): never empty every folder into 已出分拣范围
    const live = new Set(chosenOtherIds());
    const keys = ((await chrome.storage.local.getKeys?.()) ?? Object.keys((await chrome.storage.local.get(null)) || {})).filter((k) => k.startsWith(KEYS.triageSnapshotPrefix));
    const gone = keys.map((k) => k.slice(KEYS.triageSnapshotPrefix.length)).filter((id) => !live.has(id));
    if (!gone.length) return;
    const got = await chrome.storage.local.get([K.removed, K.left, ...keys]);
    const otherBvids = new Set([...live].flatMap((id) => got[K.snapshot(id)]?.bvids || []));
    let out = { removed: got[K.removed] || {}, left: got[K.left] || {} };
    for (const id of gone) {
      const old = got[K.snapshot(id)];
      const oldItems = old?.items || (old?.bvids || []).map((bvid) => ({ bvid, title: old.titles?.[bvid] || bvid }));
      out = updateRemoved(out.removed, out.left, oldItems, [], otherBvids, Date.now(), null, { id, title: folderName(id) });
    }
    if (!(await store({ [K.removed]: out.removed, [K.left]: out.left }))) return; // keep the old lists until it is recorded
    await chrome.storage.local.remove(gone.flatMap((id) => [K.snapshot(id), K.decisions(id)]));
  });
}

// Opt-in: a new user starts with no folder chosen. The first load after this change keeps every folder for
// someone who already triaged (a snapshot exists).
async function loadIncluded() {
  const got = await chrome.storage.local.get(K.included);
  if (Array.isArray(got[K.included])) return got[K.included];
  const keys = (await chrome.storage.local.getKeys?.()) ?? Object.keys((await chrome.storage.local.get(null)) || {});
  const included = keys.some((k) => k.startsWith(KEYS.triageSnapshotPrefix)) ? S.allFolders.map((f) => String(f.id)) : [];
  await chrome.storage.local.set({ [K.included]: included });
  return included;
}

// 稍后再看 says how far each video was watched on Bilibili: seconds, or -1 once finished.
function seenText(it) {
  if (S.seenCfg.on || it.seen == null || it.seen === 0) return "";
  if (it.seen < 0) return "看完了";
  return it.duration > 0 ? `看到 ${Math.min(99, Math.max(1, Math.round((it.seen / it.duration) * 100)))}%` : "";
}

// 「（p/P 页）」 while a folder of more than one page (40 videos each, the most Bilibili allows) loads.
function pageText(mediaId) {
  if (String(mediaId) === TOVIEW) return ""; // read in one request, no pages
  const pages = Math.ceil(Number(S.folders.find((f) => String(f.id) === String(mediaId))?.count || 0) / 40);
  const done = S.loadPage?.mediaId === String(mediaId) ? S.loadPage.page : 0;
  return pages > 1 ? `（${Math.min(done, pages)}/${pages} 页）` : "";
}
const loadingHtml = () => `<p class="empty">正在加载收藏夹…${pageText(S.mediaId)}</p>`;

async function loadFolders() {
  el.banner.hidden = true;
  el.list.innerHTML = `<p class="empty">正在加载收藏夹列表…</p>`;
  const r = await send({ type: "triage-folders" });
  if (!r.ok) {
    if (MdgErrors.action(r.code) !== "login") showBanner(`读取收藏夹失败：${r.error}`, "重试", loadFolders); // send() showed 去登录
    el.list.innerHTML = `<p class="empty">无法读取收藏夹</p>`;
    return;
  }
  S.allFolders = r.data.folders || [];
  S.toviewUnread = Boolean(r.data.toviewUnread);
  S.mid = r.data.mid;
  S.included = (await loadIncluded()).map(String);
  // Its data stays (retireUnchosenFolders keeps it); say so, amber like any reminder that blocks nothing.
  if (S.toviewUnread && S.included.includes(TOVIEW)) showBanner("稍后再看这次没读到，点「重试」再读一次", "重试", loadFolders, "toview");
  S.folders = S.allFolders.filter((f) => S.included.includes(String(f.id)));
  await retireUnchosenFolders();
  S.removedCount = Object.keys(await storeGet(K.removed, {})).length;
  // 所有收藏夹 leads and 已出分拣范围 closes the list; renderTop keeps their labels and visibility current.
  el.folderSelect.innerHTML =
    `<option value="${ALL}" title="把所有收藏夹合在一起看和搜索。第一次要逐个加载，收藏夹多时需要几分钟；之后只核对变化，很快">所有收藏夹</option><hr />` +
    S.folders.map((f) => `<option value="${esc(f.id)}"${f.cover ? ` data-cover="${esc(f.cover)}"` : ""}>${esc(f.title)} (${esc(f.count)})</option>`).join("") +
    `<hr /><option value="${REMOVED}" title="不在你勾选的收藏夹里、但 MoonDigest 还留着信息的视频：取消收藏的、在没勾选的收藏夹里的、已失效的">已出分拣范围</option>`;
  renderTop();
  if (!S.folders.length) {
    el.list.innerHTML = S.allFolders.length
      ? `<div class="empty pick-folders"><p><strong>先选要分拣的收藏夹</strong></p>
          <p>MoonDigest 只读取你勾选的收藏夹，没勾的不会读取里面的内容。<br>以后可以在「收藏夹设置」里随时改。</p>
          <button type="button" class="primary" data-pick-folders>选择收藏夹</button></div>`
      : `<p class="empty">没有找到收藏夹</p>`;
    return;
  }
  // Back to the last real folder, else the first (默认收藏夹); 所有收藏夹 is slow to load, so it never opens by itself.
  const last = String(await storeGet(K.lastFolder, ""));
  const pick = String((S.folders.find((f) => String(f.id) === last) || S.folders[0]).id);
  el.folderSelect.value = pick;
  await openFolder(pick);
}

let openSeq = 0;
async function openFolder(mediaId) {
  // Loaded before any state changes so S.mediaId and S.decisions always belong to the same folder; a later click
  // during the read wins.
  const seq = ++openSeq;
  const all = mediaId === ALL;
  const removed = mediaId === REMOVED;
  // 已出分拣范围 shows 保留 too; its 取消收藏 is on each card's leaving line.
  const decisions = all ? {} : removed ? { ...S.kept } : { ...S.kept, ...(await storeGet(K.decisions(mediaId), {})) };
  if (seq !== openSeq) return;
  const token = ++S.folderToken;
  S.mediaId = mediaId;
  S.decisions = decisions;
  S.folderDecisions = {};
  S.loadAll = null;
  S.removedCheck = null;
  setItems([]);
  S.selected.clear();
  S.tagFilter.clear();
  S.finishedFilter = S.dupFilter = false;
  S.aiRecentFilter = false;
  S.kindFilter = "";
  S.undo = [];
  S.focused = "";
  S.syncError = "";
  hideSyncNotice();
  if (!all && !removed) storeSet(K.lastFolder, mediaId);
  el.folderSelect.value = mediaId;
  el.list.innerHTML = loadingHtml();
  let ok;
  if (all) ok = await openAll();
  else if (removed) ok = await openRemoved();
  else ok = (await openCached(token)) || (token === S.folderToken && (await syncFolder({ force: true })));
  // A failed first read (limit, offline) still leaves the last folder's step and chips behind; a later folder owns the page.
  if (!ok && token !== S.folderToken) return;
  S.tab = removed ? "read" : currentStage(stageCounts());
  S.classFilter = { coarse: "all", fine: "all", read: "all" };
  S.focused = visibleItems()[0]?.bvid || "";
  render();
}

// A folder with a cached list shows it at once; one light id request then decides whether it needs a full sync.
// 稍后再看 is read in one request anyway, and its watch progress goes stale, so it always syncs.
async function openCached(token) {
  const mediaId = S.mediaId;
  if (mediaId === TOVIEW) return false;
  const snap = await storeGet(K.snapshot(mediaId), null);
  // Snapshots from before the intro was cached sync once, so the AI is not told an empty intro.
  if (token !== S.folderToken || !snap?.items || snap.intro === undefined) return false;
  S.folderIntro[mediaId] = snap.intro;
  setItems([...snap.items]);
  if (!(await loadResults(token))) return false;
  checkCached(token, snap);
  return true;
}

async function checkCached(token, snap) {
  if (fav.state().writing(S.mediaId)) return deferRead(() => quickSync({ force: true }));
  const r = await send({ type: "triage-folder-ids", mediaId: S.mediaId });
  if (token !== S.folderToken) return;
  if (!r.ok) syncFolder({ force: true });
  else if (!idsChanged(snap.ids || snap.bvids, r.data.bvids)) markRead(S.mediaId);
  else syncFolder({ force: true, cached: { snap, ids: r.data.bvids } });
}

// bvid → { item, from } for videos in another chosen folder's cached list (from: its id) or in 已出分拣范围 (from: REMOVED).
async function localItems(mediaId) {
  const others = chosenOtherIds(mediaId);
  const got = await chrome.storage.local.get([K.removed, ...others.map(K.snapshot)]);
  const local = new Map();
  for (const id of others) for (const item of got[K.snapshot(id)]?.items || []) if (!local.has(item.bvid)) local.set(item.bvid, { item, from: id });
  for (const [bvid, rec] of Object.entries(got[K.removed] || {})) if (!local.has(bvid)) local.set(bvid, { item: rec.item, from: REMOVED });
  return local;
}

// Changed ids without the full load: removed videos leave the cached list, added ones come from local when MoonDigest
// already holds them, and only truly new ones are fetched from the newest part of the list. null when an added id is
// found nowhere (a new favorite deep in the list), so the caller loads the whole folder.
async function fromCache(mediaId, { snap, ids }, local) {
  const old = snap.ids || snap.bvids;
  const oldSet = new Set(old);
  const added = ids.filter((b) => !oldSet.has(b));
  const moved = added.filter((b) => local.has(b)).map((b) => local.get(b).item);
  let head = [];
  let info = { intro: snap.intro };
  if (moved.length < added.length) {
    const r = await send({ type: "triage-folder-items", mediaId, known: [...snap.bvids, ...moved.map((it) => it.bvid)] });
    if (!r.ok || !r.data.head) return r;
    head = r.data.items;
    info = r.data.info || info;
  }
  const items = mergeHead(head, [...moved, ...snap.items], old, ids);
  return items && { ok: true, data: { items, ids, info } };
}

// A folder being written (fav.state().writing: a batch on it, or a write a moment ago) is not read; a read asked for
// meanwhile runs once it settles.
// The latest request replaces a waiting one (it may be for the folder opened since), except that a waiting full sync
// is not traded for the light check.
let deferredRead = null;
function deferRead(fn, full = false) {
  if (deferredRead?.full && deferredRead.token === S.folderToken && !full) return;
  clearTimeout(deferredRead?.timer);
  const token = S.folderToken;
  const timer = setTimeout(() => {
    deferredRead = null;
    if (token === S.folderToken) fn();
  }, 1000);
  deferredRead = { timer, token, full };
}

// The light refresh (back on the tab, the player closed, a video re-favorited): check the id list and apply only the
// difference. 刷新 still loads the whole folder, which also catches videos that became invalid.
// Coming back to the tab fires both focus and visibilitychange: while one check runs, the other returns.
let quickChecking = null;
async function quickSync({ force = false } = {}) {
  if (!force && (Date.now() - S.lastSyncAt < SYNC_MIN_GAP_MS || quickChecking === S.folderToken)) return;
  const token = S.folderToken;
  quickChecking = token;
  try {
    const snap = S.mediaId === TOVIEW ? null : await storeGet(K.snapshot(S.mediaId), null);
    if (token !== S.folderToken) return;
    if (!snap?.items || snap.intro === undefined) syncFolder({ force });
    else await checkCached(token, snap);
  } finally {
    if (quickChecking === token) quickChecking = null;
  }
}

// A chosen folder other than the open one with a proposal waiting.
const otherAiFolder = () => Object.keys(S.ai.proposals).find((id) => id !== String(S.mediaId) && (id === ALL || S.folders.some((f) => String(f.id) === id)));

// The folder's list and its bvid lookup, always replaced together.
function setItems(list) {
  S.items = list;
  S.itemMap = new Map(list.map((it) => [it.bvid, it]));
}

// ---------- sync with bilibili ----------
// cached ({ snap, ids }, from checkCached) fetches only the newest pages and takes the rest from the cached list.
async function syncFolder({ force = false, cached = null } = {}) {
  // S.syncing holds the token of the running sync, so a forced sync for a newly opened folder is not blocked by the old one.
  if (S.syncing === S.folderToken || (!force && Date.now() - S.lastSyncAt < SYNC_MIN_GAP_MS)) return false;
  if (fav.state().writing(S.mediaId)) {
    deferRead(() => (cached ? quickSync({ force: true }) : syncFolder({ force: true })), !cached);
    return false;
  }
  const token = S.folderToken;
  S.syncing = token;
  S.loadPage = null;
  const mediaId = S.mediaId;
  const started = Date.now();
  renderTop();
  try {
    // Videos MoonDigest already holds from another chosen folder or 已出分拣范围: added here, they reuse that info.
    const local = await localItems(mediaId);
    if (token !== S.folderToken) return false;
    let r = cached ? await fromCache(mediaId, cached, local) : null;
    if (token !== S.folderToken) return false;
    r ||= await send({ type: "triage-folder-items", mediaId });
    if (token !== S.folderToken) return false;
    if (!r.ok) {
      const needLogin = MdgErrors.action(r.code) === "login"; // send() showed 去登录
      if (!needLogin) S.syncError = `刷新失败：${r.error}`;
      if (!S.items.length) el.list.innerHTML = UI.emptyState("无法读取这个收藏夹", needLogin ? "登录 B站后点刷新。" : r.error, REFRESH_EMPTY);
      return false;
    }
    markRead(mediaId);
    S.syncError = "";
    if (r.data.info) S.folderIntro[mediaId] = r.data.info.intro;
    const snap = await storeGet(K.snapshot(mediaId), null);
    if (token !== S.folderToken) return false;
    // A run that wrote here while the list was read makes it stale (it would bring moved videos back): read again later.
    if (fav.state().writing(mediaId, started)) {
      deferRead(() => syncFolder({ force: true }), true);
      return false;
    }
    const remote = keepInvalidInfo(r.data.items || [], snap?.items);
    // A partial list proves what exists, never what was removed, so it skips the removed diff and the snapshot.
    const partial = r.data.partial ? { ...r.data.partial, count: remote.length } : null;
    const remoteSet = new Set(remote.map((it) => it.bvid));
    const diff = { added: [], removed: [], invalid: [], restored: [] };
    const restored = new Set();

    for (const it of remote) {
      const dec = S.decisions[it.bvid];
      if (dec?.action === "unfav" && refavorited(it, dec)) {
        delete S.decisions[it.bvid];
        restored.add(it.bvid);
        diff.restored.push(it.title);
      }
    }
    if (snap) {
      const snapSet = new Set(snap.bvids);
      const snapInvalid = new Set(snap.invalid || []);
      for (const it of remote) {
        if (!snapSet.has(it.bvid) && !restored.has(it.bvid)) diff.added.push({ ...it, from: local.get(it.bvid)?.from });
        if (it.invalid && snapSet.has(it.bvid) && !snapInvalid.has(it.bvid)) diff.invalid.push(it.title);
      }
      // Still in the id list but no longer listed: Bilibili hid it as invalid.
      const ids = new Set(r.data.ids || []);
      for (const b of partial ? [] : snap.bvids) {
        if (!remoteSet.has(b) && S.decisions[b]?.action !== "unfav") (ids.has(b) ? diff.invalid : diff.removed).push(snap.titles?.[b] || b);
      }
    }
    if (restored.size) patchDecisions(mediaId, Object.fromEntries([...restored].map((b) => [b, null])));

    // Remote order, newly added first; keep items we unfavorited this session so undo stays possible,
    // and after a partial load keep everything the missing pages may still hold.
    const addedSet = new Set(diff.added.map((it) => it.bvid));
    const next = [...remote.filter((it) => addedSet.has(it.bvid)), ...remote.filter((it) => !addedSet.has(it.bvid))];
    for (const it of S.items) {
      if (!remoteSet.has(it.bvid) && (partial || S.decisions[it.bvid]?.action === "unfav")) next.push(it);
    }
    setItems(next);
    if (S.group?.mediaId === String(mediaId)) S.group.bvids = S.group.bvids.filter((b) => S.itemMap.has(b));
    for (const b of [...S.selected]) if (!S.itemMap.has(b)) S.selected.delete(b);

    if (!partial) await saveSnapshot(mediaId, remote, r.data.ids);
    if (!(await loadResults(token))) return false;
    showSyncNotice(diff, partial);
    render();
    return true;
  } finally {
    if (S.syncing === token) S.syncing = false;
    renderTop();
  }
}

// A read of the folder's list from B站 got through: kept, so a reopened page still says when.
function markRead(mediaId) {
  S.lastSyncAt = S.readAt[mediaId] = Date.now();
  storeSet(K.readAt, S.readAt);
}

// The full item list doubles as the 所有收藏夹 cache; bvids/invalid/titles drive the sync diff. Videos that left every
// chosen folder go to 已出分拣范围.
function saveSnapshot(mediaId, items, ids = null) {
  return serialStore(async () => {
    const others = chosenOtherIds(mediaId);
    const got = await chrome.storage.local.get([K.snapshot(mediaId), K.removed, K.left, ...others.map(K.snapshot)]);
    const old = got[K.snapshot(mediaId)];
    const oldItems = old?.items || (old?.bvids || []).map((bvid) => ({ bvid, title: old.titles?.[bvid] || bvid }));
    const otherBvids = new Set(others.flatMap((id) => got[K.snapshot(id)]?.bvids || []));
    const { removed, left } = updateRemoved(got[K.removed] || {}, got[K.left] || {}, oldItems, items, otherBvids, Date.now(), ids, { id: String(mediaId), title: folderName(mediaId) });
    const saved = await store({
      [K.snapshot(mediaId)]: {
        bvids: items.map((it) => it.bvid),
        invalid: items.filter((it) => it.invalid).map((it) => it.bvid),
        titles: Object.fromEntries(items.map((it) => [it.bvid, it.title])),
        items,
        ids, // the folder's id list at this load; 所有收藏夹 compares the next id list with it
        intro: S.folderIntro[mediaId] ?? old?.intro
      },
      [K.removed]: removed,
      [K.left]: left
    });
    if (!saved) return;
    S.removedCount = Object.keys(removed).length;
    renderTop();
  });
}

// ---------- 已出分拣范围 ----------
async function openRemoved() {
  const token = S.folderToken;
  const keys = ((await chrome.storage.local.getKeys?.()) ?? Object.keys((await chrome.storage.local.get(null)) || {})).filter((k) => k.startsWith("triage_decisions_"));
  const got = await chrome.storage.local.get([K.removed, ...keys]);
  if (token !== S.folderToken) return false;
  const rec = got[K.removed] || {};
  const decisionsByFolder = Object.fromEntries(keys.map((k) => [k.slice("triage_decisions_".length), got[k]]));
  setItems(Object.values(rec)
    .sort((x, y) => y.at - x.at)
    .map(({ item, at, movedTo, hidden, inFolder, from }) => ({ ...item, removedAt: at, movedTo, hidden, inFolder, from: from || inferFrom(decisionsByFolder, item.bvid, folderName) })));
  if (!(await loadResults(token))) return false;
  checkRemoved(token);
  return true;
}

// Re-favorited videos leave 已出分拣范围 as soon as one chosen folder's id list has them again; then each one left is
// asked where it is now (checkWhere). Both are runs' "check": the count in the pill, a B站 limit counting down there and
// asking again, a failure in row 3 (S.removedCheck.error). Opening another folder ends them.
async function checkRemoved(token) {
  const ids = S.folders.map((f) => String(f.id));
  const alive = () => token === S.folderToken;
  S.removedCheck = { error: "" };
  // A check of an earlier opening ends once its request in flight lands.
  while (runs.busy("check") && alive()) await sleepWhile(50, () => true);
  let i = 0;
  const r = await runs.run("check", {
    total: ids.length,
    gap: 300,
    alive,
    line: (d, t) => `核对收藏夹 ${d}/${t}`,
    next: () => (i < ids.length ? { id: ids[i++] } : null),
    // A folder being written is checked next time; its list is changing now.
    act: ({ id }) => (fav.state().writing(id) ? { ok: true } : send({ type: "triage-folder-ids", mediaId: id })),
    async done(step, x) {
      if (!alive() || !x.data) return;
      await dropRemoved(x.data.bvids);
      render();
    }
  });
  if (!alive()) return;
  if (r.error) {
    S.removedCheck.error = `核对「${folderName(ids[i - 1])}」失败：${r.error}，可点刷新重试`;
    return render();
  }
  await checkWhere(token);
  if (alive() && !S.removedCheck.error) S.removedCheck = null;
  render();
}

// Asks Bilibili, per video, which folders hold it (not invalid ones: those are known, and records too old to have an aid
// are left as they are). Only folders not chosen count; one in a chosen folder is taken out by the next id check.
async function checkWhere(token) {
  if (token !== S.folderToken) return;
  const list = S.items.filter((it) => it.aid && kindOf(it) !== "invalid");
  const alive = () => token === S.folderToken;
  const found = {};
  let mid; // who is logged in, asked once per check (the first answer carries it)
  let i = 0;
  const r = await runs.run("check", {
    total: list.length,
    gap: 150,
    alive,
    line: (d, t) => `核对视频的收藏状态 ${d}/${t}`,
    next: () => (i < list.length ? { it: list[i++] } : null),
    act: ({ it }) => send({ type: "triage-fav-where", aid: it.aid, mid }),
    done({ it }, x) {
      if (!alive()) return;
      mid ||= x.data?.mid;
      const folders = x.data?.folders || [];
      const out = folders.find((f) => !S.included.includes(String(f.id)));
      if (out || !folders.length) {
        it.inFolder = out ? { id: out.id, title: out.title } : null;
        found[it.bvid] = it.inFolder;
      }
      render();
    }
  });
  if (r.error) S.removedCheck.error = `核对《${shortTitle(list[i - 1])}》的收藏状态失败：${r.error}，可点刷新重试`;

  await serialStore(async () => {
    const rec = await storeGet(K.removed, {});
    const hit = Object.keys(found).filter((b) => rec[b]);
    for (const b of hit) rec[b].inFolder = found[b];
    if (hit.length) await storeSet(K.removed, rec);
  });
}

// Drops these bvids from 已出分拣范围 (they are in a folder again); returns how many were there.
function dropRemoved(bvids) {
  return serialStore(async () => {
    const rec = await storeGet(K.removed, {});
    // A hidden invalid video stays in the id list; only its listing coming back (updateRemoved) takes it out.
    const back = bvids.filter((b) => rec[b] && !rec[b].hidden);
    if (!back.length) return 0;
    for (const b of back) delete rec[b];
    await storeSet(K.removed, rec);
    S.removedCount = Object.keys(rec).length;
    if (S.mediaId === REMOVED) {
      setItems(S.items.filter((it) => !back.includes(it.bvid)));
    }
    return back.length;
  });
}

// Deletes everything MoonDigest holds for these videos (AI results, 保留, note, tags, 待播, 取消收藏 records) and their record.
async function cleanRemoved(list) {
  if (!list.length) return;
  if (favBusyReason()) return toast(favBusyReason(), true);
  const one = list.length === 1 ? `《${shortTitle(list[0])}》` : `这 ${list.length} 个视频`;
  const body = `<p>删除${one}的 AI 判断、AI 总结、备注、标签、保留标记、待播记录和取消收藏记录，无法撤销。删除后不能再从「处理完成」重新收藏。<br>要留存请先从「导出」菜单导出。</p>`;
  if (!(await askConfirm(`清理${one}？`, body, `清理 ${list.length} 个`, { danger: true }))) return;
  return serialStore(async () => {
    const bvids = list.map((it) => it.bvid);
    const set = new Set(bvids);
    const rec = await storeGet(K.removed, {});
    for (const b of bvids) {
      for (const map of [rec, S.notes, S.videoTags, S.kept, S.analyses, S.titleRes]) delete map[b];
    }
    S.basket = S.basket.filter((x) => !set.has(x.bvid));
    const decisionKeys = ((await chrome.storage.local.getKeys?.()) ?? Object.keys((await chrome.storage.local.get(null)) || {})).filter((k) => k.startsWith("triage_decisions_"));
    const decisions = await chrome.storage.local.get(decisionKeys);
    for (const map of [...Object.values(decisions), S.decisions, ...Object.values(S.folderDecisions)]) for (const b of bvids) delete map[b];
    noteOwnWrites(decisions);
    await chrome.storage.local.set(decisions);
    await chrome.storage.local.remove(bvids.flatMap((b) => [KEYS.triageTitle(b), KEYS.triageAnalysis(b)]));
    const write = { [K.removed]: rec, [K.notes]: S.notes, [K.videoTags]: S.videoTags, [K.kept]: S.kept, [K.basket]: S.basket };
    noteOwnWrites(write);
    await chrome.storage.local.set(write);
    S.removedCount = Object.keys(rec).length;
    setItems(S.items.filter((it) => !set.has(it.bvid)));
    for (const b of set) S.selected.delete(b);
    toast(`已清理 ${list.length} 个视频`);
    render();
  });
}

// Reads cached 粗分/细看 results for listed videos not loaded yet; false when the folder changed meanwhile.
async function loadResults(token) {
  await loadSeen(token);
  if (token !== S.folderToken) return false;
  const missing = S.items.map((it) => it.bvid).filter((b) => !(b in S.titleRes) && !(b in S.analyses));
  if (!missing.length) return true;
  const [t, a] = await Promise.all([
    send({ type: "triage-title-get", bvids: missing }),
    send({ type: "triage-analysis-get", bvids: missing })
  ]);
  if (token !== S.folderToken) return false;
  // Results from before criteria were recorded count as made under this folder's current criteria.
  const stamp = {};
  const stamped = (key, r) => {
    if (!inFolderOnly() || r.criteria !== undefined) return r;
    stamp[key] = { ...r, criteria: criteria() };
    return stamp[key];
  };
  for (const b of missing) {
    if (t.ok && t.data?.[b]) S.titleRes[b] = stamped(KEYS.triageTitle(b), t.data[b]);
    if (a.ok && a.data?.[b]) S.analyses[b] = stamped(KEYS.triageAnalysis(b), a.data[b]);
  }
  if (Object.keys(stamp).length) await chrome.storage.local.set(stamp);
  return true;
}

// ---------- 所有收藏夹 ----------
// Folders with a cached list (triage_snapshot_*.items) show at once, then each is checked against the folder's video ids
// (one light request) and re-fetched if they differ. Folders without a cache are fetched one by one in the background
// with the same loader and request interval as the rest of the page.
async function openAll() {
  const token = S.folderToken;
  const ids = S.folders.map((f) => String(f.id));
  const got = await chrome.storage.local.get(ids.flatMap((id) => [K.snapshot(id), K.decisions(id)]));
  if (token !== S.folderToken) return false;
  const lists = {};
  for (const f of S.folders) {
    const id = String(f.id);
    S.folderDecisions[id] = got[K.decisions(id)] || {};
    const snap = got[K.snapshot(id)];
    if (snap?.items) lists[id] = { items: snap.items, ids: snap.ids };
    else if (!Number(f.count)) lists[id] = { items: [] };
  }
  const check = ids.filter((id) => got[K.snapshot(id)]?.items);
  S.loadAll = { lists, check, checkTotal: check.length, queue: ids.filter((id) => !lists[id]), paused: false, running: false, error: "", partial: 0 };
  rebuildAll();
  if (!(await loadResults(token))) return false;
  runLoadAll(token);
  return true;
}

function rebuildAll() {
  const L = S.loadAll;
  const lists = S.folders.map((f) => String(f.id)).filter((id) => L.lists[id]).map((id) => ({ id, ...L.lists[id], decisions: S.folderDecisions[id] }));
  const items = mergeFolderItems(lists);
  const decisions = {};
  for (const it of items) if (S.kept[it.bvid]) decisions[it.bvid] = S.kept[it.bvid];
  // Keep videos unfavorited from every folder this session, so they sit in 处理完成 and U can undo.
  const have = new Set(items.map((it) => it.bvid));
  for (const it of S.items) {
    if (!have.has(it.bvid) && S.decisions[it.bvid]?.action === "unfav") {
      items.push(it);
      decisions[it.bvid] = S.decisions[it.bvid];
    }
  }
  setItems(items);
  S.decisions = decisions;
  for (const b of [...S.selected]) if (!S.itemMap.has(b)) S.selected.delete(b);
}

async function runLoadAll(token) {
  const L = S.loadAll;
  if (!L || L.running) return;
  const keepGoing = () => !L.paused && token === S.folderToken;
  L.running = true;
  L.error = "";
  render();
  while ((L.check.length || L.queue.length) && keepGoing()) {
    // Checks go first: they are light (~300 ms apart) and may add folders to the full-load queue.
    const next = L.check[0] ?? L.queue[0];
    if (fav.state().writing(next)) {
      // A folder being written waits at the back of its line.
      const line = L.check.length ? L.check : L.queue;
      line.push(line.shift());
      await sleepWhile(1000, keepGoing);
      continue;
    }
    if (L.check.length) {
      const id = L.check[0];
      const r = await send({ type: "triage-folder-ids", mediaId: id });
      if (token !== S.folderToken) return;
      if (runs.hold(r)) {
        await runs.wait("load", runs.hold(r), keepGoing);
        continue;
      }
      if (!r.ok) {
        L.error = `核对「${folderName(id)}」失败：${r.error}`;
        L.paused = true;
        break;
      }
      L.check.shift();
      await dropRemoved(r.data.bvids);
      const list = L.lists[id];
      const bvids = list.items.map((it) => it.bvid);
      if (idsChanged(list.ids || bvids, r.data.bvids)) {
        // Only the difference, as in a single folder; the whole folder loads when that is not enough.
        const q = await fromCache(id, { snap: { ...list, bvids }, ids: r.data.bvids }, await localItems(id));
        if (token !== S.folderToken) return;
        if (q?.ok && !q.data.partial) {
          L.lists[id] = { items: q.data.items, ids: q.data.ids };
          await saveSnapshot(id, q.data.items, q.data.ids);
          rebuildAll();
          if (!(await loadResults(token))) return;
        } else L.queue.push(id);
      }
      render();
      if (L.check.length || L.queue.length) await sleepWhile(300, keepGoing);
      continue;
    }
    const id = L.queue[0];
    S.loadPage = null;
    // The folder being read, for the pill; not the next one while waiting between two.
    L.current = id;
    renderStatus();
    const r = await send({ type: "triage-folder-items", mediaId: id });
    L.current = "";
    if (token !== S.folderToken) return;
    if (runs.hold(r)) {
      await runs.wait("load", runs.hold(r), keepGoing);
      continue;
    }
    if (!r.ok) {
      L.error = `「${folderName(id)}」加载失败：${r.error}`;

      L.paused = true;
      break;
    }
    L.queue.shift();
    const items = keepInvalidInfo(r.data.items || [], (await storeGet(K.snapshot(id), null))?.items);
    L.lists[id] = { items, ids: r.data.ids };
    // A partial list is still searchable but never becomes the cache, as in syncFolder.
    if (r.data.partial) L.partial++;
    else await saveSnapshot(id, items, r.data.ids);
    rebuildAll();
    if (!(await loadResults(token))) return;
    render();
    if (L.queue.length) await sleepWhile(S.settings.triageIntervalSec * 1000, keepGoing);
  }
  L.running = false;
  render();
}

// 刷新 in 所有收藏夹 re-fetches every folder; the cached lists stay visible until each one is replaced.
function refreshAll() {
  const L = S.loadAll;
  if (!L) return;
  L.queue = S.folders.map((f) => String(f.id));
  L.check = [];
  L.paused = false;
  L.partial = 0;
  runLoadAll(S.folderToken);
}

// Row 3 of 所有收藏夹: what was loaded once done, else only a failure (the progress is in the pill, loadAllActivity).
function loadAllLine() {
  const L = S.loadAll;
  const n = S.folders.length;
  const partial = L.partial ? `（${L.partial} 个只加载了部分）` : "";
  if (!L.queue.length && !L.check.length) return `<span class="muted">${n} 个收藏夹 · ${S.items.length} 个视频${partial}</span>`;
  return L.error ? `<span class="fail-text">${esc(L.error)}</span>` : "";
}

// The pill's row while 所有收藏夹 checks or loads its folders: counts, the folder being read and its pages; 暂停 / 继续
// on it. runs adds the B站限流 countdown.
function loadAllActivity() {
  const L = S.loadAll;
  if (!L || (!L.queue.length && !L.check.length)) return null;
  const n = S.folders.length;
  const [verb, done, total] = L.check.length ? ["核对", L.checkTotal - L.check.length, L.checkTotal] : ["加载", n - L.queue.length, n];
  const now = L.current ? ` · 「${folderName(L.current)}」${pageText(L.current)}` : "";
  const text = L.paused ? `${verb}收藏夹 ${done}/${total} · 已暂停` : `${verb}收藏夹 ${done}/${total}${now}`;
  return { text, done, total, act: L.paused ? "all-resume" : "all-pause", actLabel: L.paused ? "继续" : "暂停" };
}

const folderName = (id) => id === REMOVED ? "已出分拣范围" : id === ALL ? "所有收藏夹" : S.allFolders.find((f) => String(f.id) === String(id))?.title || String(id);
// The folder select's counts follow our own writes at once instead of waiting for the next folder-list load.
function bumpCount(id, delta) {
  const f = S.allFolders.find((x) => String(x.id) === String(id));
  if (!f || !delta) return;
  f.count = Math.max(0, Number(f.count || 0) + delta);
  const opt = el.folderSelect.querySelector?.(`option[value="${f.id}"]`);
  if (opt) opt.textContent = `${f.title} (${f.count})`;
}
// 所有收藏夹's batch 取消收藏 (and its undo) names the folder it is writing to now.
const unfavWhere = (run) => (run.folder && run.folder !== run.mediaId ? `「${folderName(run.folder)}」` : "");
const folderNames = (it) => it.folders.map(folderName).join("、");

// A video in several folders: pick which ones to unfavorite it from (all checked by default).
async function pickUnfavFolders(it) {
  const boxes = it.folders
    .map((f) => `<label class="toggle"><input type="checkbox" name="unfavFolder" value="${esc(f)}" checked /> ${esc(folderName(f))}</label>`)
    .join("");
  const ok = await askConfirm(`取消收藏《${shortTitle(it)}》？`, `<p>这个视频在 ${it.folders.length} 个收藏夹里，从勾选的收藏夹取消收藏：</p>${boxes}`, "取消收藏", { danger: true });
  return ok ? [...el.confirmBody.querySelectorAll("input:checked")].map((x) => x.value) : [];
}

// Row 1's sync pill (shared.js draws it, as in 关注). Declarations, not consts: init() runs above them.
function syncEls() {
  return { pill: el.syncViewBtn, notice: el.syncNotice, text: el.syncText, detail: el.syncDetail, close: el.syncCloseBtn };
}

function showSyncNotice(diff, partial) {
  const { added, removed, invalid, restored } = diff;
  if (!partial && !added.length && !removed.length && !invalid.length && !restored.length) {
    if (el.syncNotice.dataset.partial) hideSyncNotice();
    return;
  }
  el.syncNotice.dataset.partial = partial ? "1" : "";
  const fromOthers = added.filter((it) => it.from).length;
  const parts = [`新增 ${added.length - fromOthers}`, ...(fromOthers ? [`来自其他收藏夹 ${fromOthers}`] : []), ...(partial ? [] : [`已在B站移除 ${removed.length}`]), `已失效 ${invalid.length}`];
  if (restored.length) parts.push(`恢复 ${restored.length}`);
  const head = partial ? `只加载了前 ${partial.count} 个（第 ${partial.page} 页失败：${partial.error}），可稍后再刷新。` : "";
  const where = (it) => (it.from === REMOVED ? "原在已出分拣范围" : `也在「${folderName(it.from)}」`);
  UI.setSync(syncEls(), {
    label: `已刷新${partial ? "（部分）" : ""} +${added.length}${partial ? "" : ` −${removed.length}`}`,
    text: `${head}刷新结果：${parts.join(" · ")}`,
    // A partial load is a notice to retry later, not a blocker: amber, per the color rules in tokens.css.
    warn: Boolean(partial),
    sections: [
      ["新增", added.filter((it) => !it.from).map((it) => it.title)],
      ["来自其他收藏夹", added.filter((it) => it.from).map((it) => `${it.title}（${where(it)}）`)],
      ["已在B站移除", removed],
      ["已失效", invalid],
      ["恢复（在B站重新收藏）", restored]
    ]
  });
}

function hideSyncNotice() {
  UI.setSync(syncEls(), null);
}

// ---------- render ----------
function render() {
  renderTop();
  renderTabs();
  renderList();
  renderBasket();
  renderViewerTags();
}

function renderTop() {
  // 已出分拣范围 has no Bilibili page of its own; the link would land on the homepage under that title.
  el.biliBtn.hidden = !S.mid || S.mediaId === REMOVED;
  el.biliBtn.title = S.mediaId === TOVIEW ? "B站稍后再看" : inFolderView() ? "B站收藏夹" : "B站主页";
  setBusy(el.refreshBtn, (S.syncing || S.loadAll?.running) && `刷新中…${S.syncing ? pageText(S.mediaId) : ""}`);
  const allOpt = el.folderSelect.querySelector(`option[value="${ALL}"]`);
  if (allOpt) {
    allOpt.hidden = !S.folders.length;
    allOpt.textContent = `所有收藏夹 (${S.folders.reduce((n, f) => n + (Number(f.count) || 0), 0)})`;
  }
  const removedOpt = el.folderSelect.querySelector(`option[value="${REMOVED}"]`);
  const showRemoved = Boolean(S.removedCount) || S.mediaId === REMOVED;
  if (removedOpt) {
    removedOpt.textContent = `已出分拣范围 (${S.removedCount})`;
    removedOpt.hidden = !showRemoved;
  }
  renderFolderList();
  renderFolderHead();
  renderTagButtons();
  renderStatus();
}

// The sidebar is the folder select drawn as a list: same options, same order, same hidden ones; a click sets the select.
function renderFolderList() {
  const opts = el.folderSelect.options;
  if (!opts?.length) return;
  el.folderList.innerHTML = [...opts]
    .filter((o) => !o.hidden)
    .map((o) => {
      const on = o.value === String(S.mediaId);
      const m = /^(.*?)(?: \((\d+)\))?$/.exec(o.textContent);
      const real = o.value !== ALL && o.value !== REMOVED;
      const thumb = real ? folderThumb(o.value, o.dataset.cover) : "";
      return UI.sideItem({ attrs: `data-folder="${esc(o.value)}"${o.title ? ` title="${esc(o.title)}"` : ""}`, label: m[1], count: m[2] == null ? null : Number(m[2]), on, pre: thumb });
    })
    .join("");
}

// The folder's cover, or a fixed colored tint (never gray) when it has none or the image fails (the error listener drops it).
// Pink means 「where you are」 and blue 「next step」 here, so a generated tint never lands on them.
const thumbHue = (id) => {
  let h = Math.round((Number(id) || [...String(id)].reduce((s, ch) => s + ch.charCodeAt(0), 0)) * 137.5) % 360;
  while ((h >= 180 && h <= 240) || h >= 300 || h <= 10) h = (h + 47) % 360;
  return h;
};
const TOVIEW_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>`;
function folderThumb(id, cover) {
  const img = cover ? `<img src="${esc(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : "";
  // An empty 稍后再看 shows a gray clock, like Bilibili's own icon for it.
  if (String(id) === TOVIEW) return `<span class="folder-thumb toview-thumb" aria-hidden="true">${img || TOVIEW_ICON}</span>`;
  return `<span class="folder-thumb" style="--h:${thumbHue(id)}" aria-hidden="true">${img}</span>`;
}

function renderFolderHead() {
  if (!S.mediaId) return (el.folderHead.innerHTML = "");
  const invalid = S.items.filter((it) => it.invalid || it.hidden).length;
  const explain = S.mediaId === REMOVED && "离开了你勾选的所有收藏夹，AI 判断、AI 总结、备注和标签都还留着，清理前可先从「导出」菜单导出";
  const meta = UI.headMeta([inFolderView() && UI.syncedText(S.readAt[S.mediaId]), invalid && `${invalid} 个已失效`, explain], S.syncError);
  const thumb = inFolderView() && S.mediaId !== TOVIEW ? folderThumb(S.mediaId, el.folderSelect.querySelector?.(`option[value="${S.mediaId}"]`)?.dataset.cover) : "";
  el.folderHead.innerHTML = `${thumb}<div class="folder-text"><h1 class="folder-title">${UI.titleHtml(folderTitle(), S.items.length)}</h1><div class="folder-meta">${meta}</div></div>`;
}

// What is running, in one place on every tab: runs' pill (PILL's order). done/total draws a bar, act puts a button on
// it (handled like the step bar's buttons), stuck turns it amber, finished green.
function activityState() {
  const { job, stopping, ...a } = runs.pill(PILL) || {};
  const btn = !a.finished && a.text && PILL_BTN[job];
  if (!btn) return a.text ? a : null;
  return btn[2] ? { ...a, act: btn[0], actLabel: stopping ? btn[2] : btn[1], stopping } : { ...a, act: btn[0], actLabel: btn[1] };
}

function renderStatus() {
  const a = activityState();
  UI.setActivity(el.activity, a && { ...a, btn: a.act && { attrs: `data-head="${a.act}"`, label: a.actLabel, reason: a.stopping ? { write: "当前视频做完就停止", fav: UI.WRITE_STOPPING }[a.act] || "当前这一步做完就暂停" : "" } });
}

// 观看进度's countdown each second (runs' own waits redraw themselves).
function tick() {
  if (!S.seenRead.until) return;

  renderStatus();
  // The wait is over: read again, as the pill said.
  if (Date.now() >= S.seenRead.until) {
    S.seenRead.until = 0;
    if (S.seenCfg.on) seenSync(false);
  }
}

function renderTabs() {
  const c = stageCounts();
  // 处理完成 says what 保留 and 取消收藏 did (one only marks the video here, the other changed B站): in its tooltip, with
  // the dot while it is open.
  const tip = (key) => (key === "done" ? DONE_TIP : "");
  const tab = (key, label, cls, n) =>
    `<button type="button" role="tab" class="${cls}" data-tab="${key}" aria-selected="${S.tab === key}" aria-label="${label} ${n}"${tip(key) ? ` title="${esc(tip(key))}" aria-description="${esc(tip(key))}"` : ""}>${label}${tip(key) && S.tab === key ? UI.WARN_DOT : ""}<span class="count">${n}</span></button>`;
  const steps = STAGES.map(([key, label]) => tab(key, label, c[key] ? "step" : "step zero", c[key]));
  // Say what the box searches: the open folder (or 所有收藏夹 / 已出分拣范围) and the tab you are on.
  const tabName = Object.fromEntries([...STAGES, ["read", "全部"]])[S.tab];
  const scope = `在「${folderTitle()}」${tabName ? ` · ${tabName}` : ""}里搜`;
  UI.setSearchScope(el.searchInput, scope);
  // 已出分拣范围 has no steps; its tabs are why the videos left (kindOf), 全部 first for the ones not checked yet.
  const kindTabs = () =>
    [["", "全部"], ...KINDS].map(([kind, label]) => {
      const n = kind ? S.items.filter((it) => kindOf(it) === kind).length : S.items.length;
      return `<button type="button" role="tab" class="${n ? "step" : "step zero"}" data-kindtab="${kind}" aria-selected="${S.kindFilter === kind}" aria-label="${label} ${n}">${label}<span class="count">${n}</span></button>`;
    }).join("");
  el.tabs.innerHTML = S.mediaId === REMOVED ? kindTabs() :
    steps.join(`<span class="arrow" aria-hidden="true">→</span>`) + `<span class="tab-sep" aria-hidden="true"></span>` + tab("read", "阅览全部", "read-tab", c.read);

  // Row 4: only the tags the tab on screen has (or a filter that is on, so it can be turned off), each with how many
  // videos listed here carry it (row 3 and search applied, row 4's own picks left out).
  const here = S.mediaId === REMOVED || S.tab === "read" ? S.items : S.items.filter((it) => stageOf(it) === S.tab);
  const hereTags = new Set(here.flatMap((it) => tagIdsOf(it.bvid)));
  const chips = tagChips().filter((c) => c.ids.some((id) => hereTags.has(id) || S.tagFilter.has(id)));
  const counted = here.filter((it) => inTab(it, S.tab) && passFilter(it, "tags")).map((it) => tagIdsOf(it.bvid));
  el.tagFilter.innerHTML = UI.labeledRow("标签", chips
    .map((c) => {
      const on = c.ids.some((id) => S.tagFilter.has(id));
      const n = counted.filter((ids) => c.ids.some((id) => ids.includes(id))).length;
      return `<button type="button" class="chip${on ? " on" : ""}${n ? "" : " zero"}" style="--c:${esc(c.color)}" data-tagfilter="${esc(c.ids.join(","))}" aria-pressed="${on}" aria-label="按标签筛选 ${esc(c.name)} ${n}" title="可多选：只显示同时带有所选标签的视频">${esc(c.name)}<span class="chip-n">${n}</span></button>`;
    })
    .join(""));
  renderTagButtons();
  renderSort();
}

// 标签管理 and ✦ AI 打标签 at the right end of the tags they act on, as in 关注; AI 打标签 says when a run or a proposal is
// pending, so renderTop draws them too (a run ends without a list render). Without tags 标签管理 has the warn dot (the
// new-tag box says what to do).
let shownPicked = 0; // the selected videos listed now (renderListHeader); ✦ AI 打标签 says how many
function renderTagButtons() {
  el.aiTagSlot.innerHTML = UI.tagButtons({
    picked: shownPicked,
    manageAttrs: "data-tags-manage",
    aiAttrs: "data-ai-tag",
    state: aiRunning() ? " · 运行中" : S.ai.proposal ? " · 待确认" : "",
    manageReason: inFolderView() ? "" : FOLDER_ONLY,
    aiReason: aiTagReason(),
    noTags: !viewTags().length
  });
}

const AI_SPARK = UI.AI_SPARK;

// reason: why it is disabled ("" = enabled); it then replaces title as the tooltip.
const headBtn = (act, label, cls = "", reason = "", verdict = "", title = "", busy = false, ai = false) =>
  `<button type="button"${cls ? ` class="${cls}"` : ""} data-head="${act}"${verdict ? ` data-verdict="${verdict}"` : ""} aria-label="${esc(label)}"${UI.reasonAttrs(reason, title)}${busy ? ' aria-busy="true"' : ""}>${ai ? AI_SPARK : ""}${esc(label)}</button>`;

// Why ✦ AI 打标签 cannot open: not in one folder, or nothing to tag and nothing pending.
const aiTagReason = () => (S.mediaId === REMOVED ? FOLDER_ONLY : !S.items.length && !aiRunning() && !S.ai.proposal ? "这里没有视频" : "");

// Why 粗看 / 细看 cannot start: another AI run goes first.
const aiBusyReason = () => (runs.get("stage1") ? "粗看还在跑，等它完成" : S.group ? "细看还在跑，等它完成" : "");
// Why 清理 cannot start: it drops the 取消收藏 records a running B站 batch writes.
const favBusyReason = () => (fav.state().busy ? `${fav.state().busy}还在跑，等它完成` : "");


// The folder's 判断标准, before the 粗看/细看 button it is for. Written: the text in the tooltip. Not written: the warn
// dot (the AI then guesses from the folder name; the editor's placeholder says so).
function criteriaBtn() {
  const text = criteria();
  const pen = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>';
  return `<button type="button" class="act-btn" data-head="criteria" title="${esc(text ? `判断标准：${text}` : "还没写判断标准")}" aria-label="${text ? "判断标准" : "判断标准（还没写）"}">${pen}判断标准${text ? "" : UI.WARN_DOT}</button>`;
}

// Whether anything in row 3 is on (全部 is pressed when not).
const statesOn = (t = S.tab) => (S.classFilter[t] && S.classFilter[t] !== "all") || Boolean(S.finishedFilter || S.dupFilter || S.aiRecentFilter || (S.mediaId !== REMOVED && S.kindFilter));
// Row 3: what the system knows about each video, in groups split by a thin rule. One pick per group (a second click
// clears it), groups AND together, and each group counts with its own pick left out. 全部 clears row 3 only. The fixed
// groups come first (a 0 stays, dimmed); the chips that exist only sometimes (看完了, 已失效, AI 刚打的) go last and
// leave at 0, so their coming and going moves nothing else.
function stateRowHtml(t = S.tab) {
  const removed = S.mediaId === REMOVED;
  const base = removed || t === "read" ? S.items : S.items.filter((it) => stageOf(it) === t);
  const cf = S.classFilter[t];
  const inClass = (it) => !cf || cf === "all" || classOf(it) === cf;
  const cnt = (skip, fn) => base.filter((it) => (skip === "class" || skip === "states" || inClass(it)) && passFilter(it, skip) && fn(it)).length;
  const group = UI.stateGroup;
  const groups = [group("全部", UI.filterBtn("data-states-all", "全部", cnt("states", () => true), !statesOn(t)))];
  // 所有收藏夹 only, right after 全部 (asked for there); like 已失效 it leaves at 0 unless on.
  const dupN = S.mediaId === ALL ? cnt("dup", isDup) : 0;
  if (dupN || S.dupFilter) groups.push(group("重复收藏", UI.filterBtn('data-dupfilter title="只看同时在两个以上收藏夹里的视频"', "重复收藏", dupN, S.dupFilter)));
  // 未分析 has no AI verdict to filter by. 阅览 also holds decided videos: they leave the AI classes for 已保留.
  if (t !== "none") {
    const classes = [...Object.entries(VERDICTS), ...(t === "read" ? [["kept", "已保留"]] : [])];
    groups.push(group("按 AI 判断筛选", classes.map(([k, label]) => UI.filterBtn(`data-class-filter="${k}"`, label, cnt("class", (it) => classOf(it) === k), cf === k)).join("")));
  }
  const seenN = cnt("seen", isFinished);
  if ((S.seenCfg.mark && seenN) || S.finishedFilter) groups.push(group("看完了", UI.filterBtn('data-finishedfilter title="只看 B站历史记录里看完了的视频"', "看完了", seenN, S.finishedFilter)));
  // 已出分拣范围 has 已失效 as a tab instead.
  const invalidN = cnt("kind", (it) => kindOf(it) === "invalid");
  const invalidOn = S.kindFilter === "invalid";
  if (!removed && (invalidN || invalidOn)) groups.push(group("已失效", UI.filterBtn('data-kindfilter="invalid" class="st-danger" title="只看已失效的视频"', "已失效", invalidN, invalidOn)));
  const recentN = cnt("recent", (it) => aiRecentSet().has(it.bvid));
  groups.push(UI.aiRecentChip({ attrs: "data-airecent", xAttrs: "data-airecent-done", n: recentN, on: S.aiRecentFilter, who: "视频" }));
  return groups.join("");
}

// A row-3 click: the pick, or clearing it when it is on already; "all" clears the row (row 4's tags stay).
function pickState(group, value = "") {
  const t = S.tab;
  if (group === "all") {
    S.classFilter[t] = "all";
    S.finishedFilter = S.dupFilter = S.aiRecentFilter = false;
    if (S.mediaId !== REMOVED) S.kindFilter = "";
  } else if (group === "class") S.classFilter[t] = S.classFilter[t] === value ? "all" : value;
  else if (group === "kind") S.kindFilter = S.kindFilter === value ? "" : value;
  else if (group === "seen") S.finishedFilter = !S.finishedFilter;
  else if (group === "dup") S.dupFilter = !S.dupFilter;
  else if (group === "recent") S.aiRecentFilter = !S.aiRecentFilter;
}

function renderListHeader(list) {
  const t = S.tab;
  // The selection belongs to the tab: a video that left it (保留, 取消收藏, a run moved it on) leaves the selection.
  for (const b of [...S.selected]) {
    const it = S.itemMap.get(b);
    if (!it || (t !== "read" && stageOf(it) !== t)) S.selected.delete(b);
  }
  const all = S.mediaId === ALL;
  // Search, row 3 or row 4 on: how many the tab lists.
  el.searchCount.textContent = UI.resultCount(S.query.trim() || statesOn(t) || S.tagFilter.size, list.length);
  const { run: favRun, busy: favBusy } = fav.state();
  const batchBtn = (route, verdict = "") => {
    const run = favRun?.job === "unfav" ? favRun : null;
    if (route === "unfav" && run && !runWhere(run)) return headBtn("batch-unfav", `取消收藏中${unfavWhere(run)} ${run.done}/${run.total}`, "danger", "正在取消收藏", "", "", true);
    const n = batchList(verdict || null).length;
    const verb = route === "unfav" ? "取消收藏" : "保留";
    // One batch 取消收藏 at a time: while another folder's runs, this one waits.
    const reason = !verdict && hiddenAll ? hiddenAll : !n ? (verdict ? `这里没有 AI 判断为${VERDICTS[verdict]}、还没处理的视频` : "选中的都已经处理过了")
      : route === "unfav" && run ? `「${folderName(run.mediaId)}」的批量取消收藏还在跑`
      : route === "unfav" && favBusy ? `${favBusy}还在跑，等它完成` : "";
    return headBtn(`batch-${route}`, verdict ? `${verb}（AI：${VERDICTS[verdict]}）${n} 个` : `${verb}选中的 ${n} 个`, route === "unfav" ? "danger" : "", reason, verdict, route === "keep" ? KEEP_TIP : "");
  };
  const transferBtn = () => {
    const run = favRun?.job === "transfer" ? favRun : null;
    if (run) return headBtn("transfer", `${run.verb}中 ${run.done}/${run.total}${runWhere(run)}`, "", `正在${run.verb}`, "", "", true);
    const n = transferList().length;
    const reason = hiddenAll || (!n ? "选中的视频已取消收藏，或缺少视频编号" : favBusy ? `${favBusy}还在跑，等它完成` : "");
    return headBtn("transfer", S.mediaId === REMOVED ? `收藏选中的 ${n} 个到…` : `移动/复制选中的 ${n} 个…`, "", reason);
  };
  const groupBtn = (cls) => {
    const g = ownGroup() && runs.get("group");
    if (g) return headBtn("group", `${g.stopping ? "暂停中" : "暂停细看"} ${g.done}/${g.total}`, "primary", g.stopping ? "当前视频细看完就暂停" : "");
    const open = fineOpen();
    const batch = pickBatch(open, fineBatchSize(), "coarse");
    const label = batchLabel("字幕细看", batch, open, "coarse");
    const none = S.items.some((it) => inTab(it, "coarse") && needsAnalysis(it.bvid)) ? "当前筛选下没有要细看的视频" : "没有要细看的视频";
    return headBtn("group", label, cls, aiBusyReason() || pickReason("选中的都不能字幕细看", batch, "coarse") || (batch.length ? "" : none), "", "", false, true);
  };
  // Pausing waits for the current batch or video; until then the button says so and takes no second click.
  const stage1Pause = (g = runs.get("stage1")) => headBtn("stage1", `${g.stopping ? "暂停中" : "暂停粗看"} ${g.done}/${g.total}`, "primary", g.stopping ? "当前批次粗看完就暂停" : "");

  // Results made under an older 判断标准 can be redone, only those listed, one batch at a time and the selection first
  // like the step's own button. all: how many the folder has, so the button stays (disabled) while filters hide them.
  const redoBtn = (act, verb, open, cap, all) => {
    const { label, why } = redoState(verb, open, cap, t);
    return all ? headBtn(act, label, "", why, "", `这些视频是按旧的判断标准${verb}的`, false, true) : "";
  };
  const sel = selectedIn(list).length;
  // A selection that filters hide entirely: the bar keeps its buttons, disabled with why, as 关注's.
  const hiddenAll = !sel && S.selected.size ? "选中的都被筛选隐藏了" : "";
  const f = S.classFilter[t];
  // html is what this step does; selActs acts on the selection and goes to its own bar below the filters.
  let html = "";
  let selActs = "";
  // 所有收藏夹 has no one 判断标准 to show: its runs ask for each folder's first (askAllCriteria).
  const critBtn = all ? "" : criteriaBtn();
  if (t === "none") {
    // The criteria the AI reads sits just before the button that sends it.
    html = critBtn;
    if (ownStage1()) html += stage1Pause();
    else {
      const open = coarseOpen();
      const pending = pickBatch(open, coarseBatchSize(), "none");
      const none = S.items.some((it) => stageOf(it) === "none" && !S.coarseFailed.has(it.bvid)) ? "当前筛选下没有要粗看的视频" : "没有要粗看的视频";
      html += headBtn("stage1", batchLabel("标题粗看", pending, open, "none"), "primary", aiBusyReason() || pickReason("选中的都不能标题粗看", pending, "none") || (pending.length ? "" : none), "", "", false, true);
    }
  } else if (t === "coarse") {
    // 细看 stays in row 3 like 标题粗看 and takes the selection; 可清理 / 值得留 lead with their batch button, 细看 stays secondary.
    html = critBtn + redoBtn("redo-coarse", "粗看", redoCoarseOpen(), coarseBatchSize(), staleCoarse().length);
    if (sel) html += groupBtn("primary");
    else if (f === "drop") html += batchBtn("unfav", "drop") + groupBtn("");
    else if (f === "keep") html += batchBtn("keep", "keep") + groupBtn("");
    else html += groupBtn("primary");
  } else if (t === "fine") {
    // A selection gets both buttons; without one 值得留 and 可清理 each get a button, 拿不准 none.
    html = "";
    const staleN = staleFine().length;
    if (staleN) html += critBtn + redoBtn("redo-fine", "细看", redoFineOpen(), fineBatchSize(), staleN);
    if (!sel) {
      if (f === "all" || f === "drop") html += batchBtn("unfav", "drop");
      if (f === "all" || f === "keep") html += batchBtn("keep", "keep");
    }
  } else if (t === "read" && S.mediaId === REMOVED) {
    const c = S.removedCheck;
    html = "";
    // Its progress is in the pill (activityState); a failure stays here.
    if (c?.error) html += `<span class="fail-text">${esc(c.error)}</span>`;
    html += `${sel ? headBtn("clean-selected", `清理选中的 ${sel} 个`, "danger", favBusyReason()) : headBtn("clean-removed", `清理这 ${list.length} 个`, "danger", favBusyReason() || (list.length ? "" : "这里没有列出视频"))}`;
  } else if (t === "read") {
    // 阅览 mixes 粗看 guesses with 细看 conclusions, so no class-wide batch here: only the selection.
    html = "";
  }
  // 保留 in every tab but 已出分拣范围; 标签… and 移动/复制 in any tab of a single folder (in 已出分拣范围 移动 is 收藏到).
  // 取消收藏 goes last, set apart. A selection the filters hide keeps them, disabled (hiddenAll).
  const picked = S.selected.size;
  if (picked && S.mediaId !== REMOVED) selActs = batchBtn("keep");
  if (picked && inFolderView()) selActs += headBtn("sel-tags", "标签…", "", hiddenAll);
  if (picked && S.mediaId !== ALL) selActs += transferBtn();
  if (picked && S.mediaId !== REMOVED) selActs += batchBtn("unfav");
  // 全选 heads the right-hand buttons, so row 3's chips coming and going never move it. It acts on what is listed, in
  // 所有收藏夹 too (across its folders).
  html = UI.selectAllBox('data-head="select-all"', list.length, sel) + (all ? loadAllLine() : "") + html;
  const hidden = S.selected.size - sel;
  const selbar = S.selected.size ? UI.selbar({ label: "选中的视频", n: sel, hidden, clearAttrs: 'data-head="clear-selected"', acts: selActs }) : "";
  el.classFilter.innerHTML = UI.labeledRow("状态", stateRowHtml(t));
  el.listHeader.innerHTML = `<div class="step-actions">${html}</div>${selbar}`;
  shownPicked = sel;
  renderTagButtons();
}

function recentUnfavs() {
  return Object.entries(S.decisions)
    .filter(([b, d]) => d.action === "unfav" && d.aid && !S.itemMap.has(b))
    .sort((x, y) => y[1].at - x[1].at)
    .slice(0, MdgLimits.TRIAGE_RECENT_UNFAV);
}

function recentUnfavHtml() {
  const list = recentUnfavs();
  if (!list.length) return "";
  const { busy, pending } = fav.state();
  const wait = busy ? `${busy}还在跑，等它完成` : "";
  const rows = list
    .map(([b, d]) => {
      const title = esc(d.title || b);
      return `<li><span class="recent-title">${title}</span><span class="muted">${esc(fmtTime(d.at))}</span>
        ${pending(b) ? `<button type="button" aria-busy="true" disabled>重新收藏中…</button>` : `<button type="button" data-refav="${esc(b)}" aria-label="重新收藏 ${title}"${UI.reasonAttrs(wait)}>重新收藏</button>`}</li>`;
    })
    .join("");
  // One line per batch 取消收藏 of two or more still listed, newest first.
  const batches = [...new Set(list.map(([, d]) => d.batch).filter(Boolean))]
    .map((batch) => ({ batch, n: unfavBatchItems(batch).length }))
    .filter((x) => x.n > 1);
  const batchRows = batches
    .map(({ batch, n }) => {
      const going = unfavBatchItems(batch).some((it) => pending(it.bvid));
      return `<p class="recent-batch"><span>${esc(fmtTime(batch))} 批量取消收藏 ${n} 个</span>${going ? `<button type="button" aria-busy="true" disabled>重新收藏中…</button>` : `<button type="button" data-refav-batch="${batch}" aria-label="这批 ${n} 个全部重新收藏"${UI.reasonAttrs(wait)}>这批全部重新收藏</button>`}</p>`;
    })
    .join("");
  return `<section class="recent-unfav" aria-label="最近取消收藏"><h3>最近取消收藏 <span class="muted">${list.length}</span></h3>${batchRows}<ul>${rows}</ul></section>`;
}

// Closing or reloading the page stops a batch write halfway and loses a notes export: the browser asks first.
window.addEventListener("beforeunload", (e) => {
  if (!writeRunning() && !fav.state().busy) return;
  e.preventDefault();
  e.returnValue = true;
});

// The records one batch 取消收藏 left in the open folder, all of them (the list shows only the latest).
const unfavBatchItems = (batch) =>
  Object.entries(S.decisions)
    .filter(([b, d]) => d.action === "unfav" && d.batch === batch && d.aid && !S.itemMap.has(b))
    .map(([bvid, d]) => ({ bvid, aid: d.aid }));

let listDeferred = false;
// The card a Shift+click picks from: the last one picked by click or X.
let pickAnchor = "";
function renderList() {
  // Rebuilding the list mid-IME in a note would drop the composition and leave the raw pinyin; compositionend renders.
  if (MdgTyping.isComposing() && document.activeElement?.closest?.("[data-note]")) return void (listDeferred = true);
  listDeferred = false;
  const list = visibleItems();
  renderListHeader(list);
  const recent = S.tab === "done" ? recentUnfavHtml() : "";
  if (!S.items.length) {
    const empty = S.mediaId === REMOVED ? `<p class="empty">没有已出分拣范围的视频</p>` : S.loadAll?.queue.length ? `<p class="empty">正在加载收藏夹…</p>`
      : UI.emptyState("这个收藏夹是空的", "在 B站收藏视频后，点「刷新」读取。", REFRESH_EMPTY);
    el.list.innerHTML = `${empty}${recent}`;
    return;
  }
  if (!list.length) {
    const empty = { none: "没有未分析的视频", coarse: "没有粗看完成的视频", fine: "没有细看完成的视频", done: "还没有处理过的视频" };
    const f = S.classFilter[S.tab];
    const filtered = S.finishedFilter || S.dupFilter || S.aiRecentFilter || S.kindFilter || S.tagFilter.size || (f && f !== "all");
    const text = UI.noMatch(S.query, filtered, "视频") || empty[S.tab] || "这里没有视频";
    el.list.innerHTML = `<p class="empty">${text}</p>${recent}`;
    return;
  }
  // The focused card left the list: the card now in its place takes the focus (its place read before the rebuild).
  if (!list.some((it) => it.bvid === S.focused)) {
    const was = [...el.list.querySelectorAll(".card")].findIndex((c) => c.dataset.bvid === S.focused);
    S.focused = list[Math.min(Math.max(was, 0), list.length - 1)].bvid;
  }
  // 粗看完成 shows which cards the button will send (or is sending) before anything runs.
  // Those cards get a label before the title.
  let marked = new Set();
  let word = "";
  if (S.tab === "coarse") {
    const bvids = ownGroup()?.bvids || nextBatch();
    marked = new Set(bvids);
    word = ownGroup() ? "本批" : bvids.some((b) => S.selected.has(b)) ? "已选中" : "下一批";
  }
  const expanded = S.tab === "fine" || S.tab === "read" || S.tab === "done";
  const failedList = list.filter((it) => failedIn(S.tab, it));
  const failed = failedList.length;
  const failedHead = failedHeadHtml(failedList);
  // Background progress re-renders the list; keep a note being typed in focus.
  const typing = document.activeElement?.closest?.("[data-note]");
  const caret = typing && [typing.closest(".card").dataset.bvid, typing.selectionStart, typing.selectionEnd];
  const scroll = el.list.scrollTop;
  el.list.innerHTML =
    list
      .map((it, i) => {
        const head = failed && i === list.length - failed ? failedHead : "";
        return head + cardHtml(it, expanded, marked.has(it.bvid) ? word : "");
      })
      .join("") + recent;
  el.list.scrollTop = scroll;
  if (caret) {
    const box = el.list.querySelector(`.card[data-bvid="${CSS.escape(caret[0])}"] [data-note]`);
    box?.focus();
    box?.setSelectionRange(caret[1], caret[2]);
  }
}

// The badge shows 「AI」 + the class name, colored by it (keep green, drop red, unsure yellow).
const verdictLabel = (v) => VERDICTS[v] || "未分析";
const verdictBadge = (b, v, low = v.low) =>
  S.analyzing.has(b)
    ? `<span class="badge running">分析中…</span>`
    : `<span class="badge ${VERDICTS[v.verdict] ? v.verdict : "none"}${low ? " low" : ""}">${VERDICTS[v.verdict] ? `<span class="ai-mark">AI</span>` : ""}${esc(verdictLabel(v.verdict))}${low ? " · 低置信" : ""}</span>`;
const ACTION_LABEL = { unfav: "已取消收藏", keep: "已保留" };
const KEEP_TIP = "保留标记只存在 MoonDigest 里，B站收藏夹不变";
const DONE_TIP = `已保留：${KEEP_TIP}。\n已取消收藏：已从 B站收藏夹移走，最近的操作可按 U 撤销。`;

// What a 细看 judged from, on the card's meta line, in the video page's words: no subtitle (and why), or a subtitle
// whose time range may not match the video. Nothing for a matching subtitle.
function basisText(a) {
  if (a.source !== "meta") return a.subtitleWarning ? esc(a.subtitleWarning.replace(/。$/, "")) : "";
  if (a.needLogin) return "未登录 B站拿不到字幕，按简介和评论判断";
  return a.subtitleFailure ? esc(`字幕抓取失败：${a.subtitleFailure}，按简介和评论判断`) : "没有字幕，按简介和评论判断";
}
function cardHtml(it, expanded, mark) {
  const b = it.bvid;
  const v = verdictOf(it);
  const a = S.analyses[b];
  const done = a?.status === "done";
  const decision = S.decisions[b];
  const inBasket = S.basket.some((x) => x.bvid === b);
  const cls = ["card"];
  if (b === S.focused) cls.push("focused");
  if (S.selected.has(b)) cls.push("selected");
  if (mark) cls.push("in-batch");
  if (b === S.viewing) cls.push("playing");

  const removed = S.mediaId === REMOVED;
  const basketBtn = inBasket
    ? `<button type="button" data-act="basket" class="on" aria-label="已在待播，点一下移除 (E)" title="已在待播，点一下移除">✓ 待播</button>`
    : `<button type="button" data-act="basket" aria-label="加入待播 (E)" title="加入待播">+ 待播<kbd class="key">E</kbd></button>`;
  const askBtn = `<button type="button" data-act="ask" aria-label="问 AI (Q)">${AI_SPARK}问 AI<kbd class="key">Q</kbd></button>`;
  // The 发布时间 is relative, the date on hover; the rest is text.
  const meta = [esc(it.upper), it.pubdate && UI.agoHtml(it.pubdate), Number.isFinite(it.play) && esc(`▶ ${fmtCount(it.play)}`), ["", "粗看", "细看"][v.stage], done && basisText(a), esc(seenText(it)), it.invalid && "已失效", it.folders?.length && esc(`收藏夹：${folderNames(it)}`)].filter(Boolean);
  const left = removed && [originHtml(it), it.removedAt && `<span>${esc(leftText(it))}</span>`].filter(Boolean).join("");

  const verdict = decision ? "" : verdictBadge(b, v);
  // The button matching the AI's verdict leads; the other stays plain.
  const keepCls = !decision && v.verdict === "keep" ? "ok solid" : "";
  const unfavCls = !decision && v.verdict === "drop" ? "danger solid" : "";
  const waiting = fav.state().pending(b); // the B站 write it waits for
  const note = S.notes[b]?.text || "";
  const noteHtml =
    note || S.noteOpen.has(b)
      ? `<textarea class="note" name="videoNote" data-note rows="1" placeholder="一句话备注，回车保存" aria-label="备注">${esc(note)}</textarea>`
      : "";
  const failed = v.failed
    ? `<span class="fail-text">分析失败：${esc(v.failed)}</span><button type="button" data-act="retry" aria-label="重试分析"${UI.reasonAttrs(aiBusyReason())}>${AI_SPARK}重试</button>`
    : "";

  const chips = tagIdsOf(b)
    .map((id) => tagById(id))
    .map((t) => UI.cardTagChip(t, "点一下去掉这个标签 · U 撤销"))
    .join("");

  const body = [];
  if (done && a.oneLiner) body.push(`<p class="oneliner">${esc(a.oneLiner)}</p>`);
  if (done && expanded && a.points?.length) body.push(`<ol class="points">${a.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>`);

  return `<article class="${cls.join(" ")}" data-bvid="${esc(b)}" aria-label="${esc(it.title)}">
    ${coverHtml(it)}
    <div class="card-body">
      <div class="title-row">${mark ? `<span class="batch-tag">${mark}</span>` : ""}<a class="title" href="${esc(videoUrl(b))}" data-act="open" aria-label="打开视频 ${esc(it.title)}">${esc(it.title)}</a></div>
      ${left ? `<div class="left-row">${left}</div>` : ""}
      <div class="meta">${meta.join(" · ")}</div>
      ${body.join("")}
      <div class="card-foot verdict-row">${verdict}<span class="reason">${esc(v.reason)}</span>${failed}</div>
      ${chips ? `<div class="chips">${chips}</div>` : ""}
      ${noteHtml}
      <div class="card-foot">
        ${decision ? `<span class="badge ${decision.action === "keep" ? "keep" : "drop"}">${ACTION_LABEL[decision.action]}</span>` : ""}
        ${noteHtml ? "" : `<button type="button" class="quiet note-add" data-act="note" aria-label="添加备注">✎ 备注</button>`}
        <span class="spacer"></span>
        <div class="actions">
          ${removed ? `<span class="pair">
            <button type="button" class="danger" data-clean="${esc(b)}" aria-label="清理 ${esc(it.title)}"${UI.reasonAttrs(favBusyReason())}>清理</button>
          </span>
          <span class="more">${basketBtn}${askBtn}</span>` : `<span class="pair">
            <button type="button" data-act="keep" class="${keepCls}" aria-label="保留 (S)"${UI.reasonAttrs(decision ? (decision.action === "keep" ? "已经保留了" : "已经取消收藏了") : "", KEEP_TIP)}>保留<kbd class="key">S</kbd></button>
            ${waiting ? `<button type="button" aria-busy="true" disabled>正在${waiting}…</button>` : `<button type="button" data-act="unfav" class="${unfavCls}" aria-label="取消收藏 (D)"${UI.reasonAttrs(decision?.action === "unfav" ? "已经取消收藏了" : "")}>取消收藏<kbd class="key">D</kbd></button>`}
          </span>
          <span class="more">
            <button type="button" data-act="tag" aria-label="打标签 (T)">标签<kbd class="key">T</kbd></button>
            ${basketBtn}${askBtn}
          </span>`}
        </div>
      </div>
    </div>
  </article>`;
}

// 已出分拣范围: when (the shared day text: 「今天 17:25」, 「10月5日 17:25」, 「2025年10月5日」) and why the video left.
function leftText(it) {
  const when = UI.dayText(it.removedAt);
  const kind = kindOf(it);
  const at = it.inFolder || it.movedTo;
  const why = it.hidden ? "已失效（B站已隐藏）"
    : kind === "out" ? `${it.movedTo?.id === at.id ? "移到" : "在"}「${at.title}」（未勾选）`
    : kind === "unfav" ? "已取消收藏" : "离开收藏夹";
  return `${when} ${why}`;
}
// 原在「A」「B」, or 原在「A」「B」等 N 个 with the whole list in the title; nothing for records from before the origin was kept.
function originHtml(it) {
  const names = (it.from || []).map((f) => `「${f.title}」`);
  if (!names.length) return "";
  const text = names.length > 2 ? `原在${names.slice(0, 2).join("")}等 ${names.length} 个` : `原在${names.join("")}`;
  return `<span class="origin-chip" title="${esc(`原在${names.join("")}`)}">${esc(text)}</span>`;
}

function folderTitle(id = S.mediaId) {
  if (id === ALL) return "所有收藏夹";
  if (id === REMOVED) return "已出分拣范围";
  return S.folders.find((f) => String(f.id) === String(id))?.title || "收藏夹";
}

function setFocus(bvid, scroll = true) {
  S.focused = bvid;
  for (const node of el.list.querySelectorAll(".card.focused")) node.classList.remove("focused");
  const card = el.list.querySelector(`.card[data-bvid="${CSS.escape(bvid)}"]`);
  if (card) {
    card.classList.add("focused");
    if (scroll) card.scrollIntoView({ block: "nearest" });
  }
}

const pointerMoved = (at, x, y) => !at || at.x !== x || at.y !== y;

function moveFocus(delta) {
  const cards = [...el.list.querySelectorAll(".card")];
  if (!cards.length) return;
  const i = cards.findIndex((c) => c.dataset.bvid === S.focused);
  const next = Math.max(0, Math.min(cards.length - 1, (i < 0 ? 0 : i + delta)));
  setFocus(cards[next].dataset.bvid);
}

// Focus the next unprocessed card after `bvid` in the given pre-change list.
function advanceFrom(bvid, before) {
  const i = before.findIndex((it) => it.bvid === bvid);
  const now = new Set(visibleItems().map((it) => it.bvid));
  const next =
    before.slice(i + 1).find((it) => now.has(it.bvid) && !isProcessed(it.bvid)) ||
    visibleItems().find((it) => !isProcessed(it.bvid));
  if (next) setFocus(next.bvid);
  else setFocus(S.focused, true);
}

// ---------- decisions ----------
// An undo step is { kind, ask, blocked?, undo }: undo() undoes it and returns its toast; ask ([title, body, button] or
// null) is confirmed first; blocked() ("" or why) refuses it. 关注's steps (kind "mode") go on their own stack.
function pushUndo(entry) {
  const steps = entry.kind === "mode" ? S.modeUndo : S.undo;
  steps.push(entry);
  if (steps.length > MdgLimits.TRIAGE_UNDO_STEPS) steps.shift();
}
// A step kept on this page (保留, 标签, AI 打标签, 待播): fn undoes it and returns the toast, then the page redraws. One
// that changed several videos asks first (askKind: shared.js undoAsk), so a stray U costs nothing.
const pageStep = (kind, n, askKind, fn) => ({
  kind,
  ask: askKind && n > 1 ? UI.undoAsk(askKind, n, "视频") : null,
  undo: async () => {
    const text = fn();
    render();
    setFocus(S.focused);
    return text;
  }
});
const keepStep = (bvids) =>
  pageStep("keepMany", bvids.length, "keep", () => {
    patchKept(Object.fromEntries(bvids.map((b) => [b, null])));
    const it = bvids.length === 1 && S.itemMap.get(bvids[0]);
    if (it) S.focused = it.bvid;
    return it ? `已撤销：取消保留《${shortTitle(it)}》` : `已撤销批量保留 ${bvids.length} 个`;
  });
// Patch one folder's decisions even after the user switched away from it; a null value deletes.
// Merged into the stored record, not written from memory: a batch running for this folder may have written it after
// the open folder read it.
function patchDecisions(mediaId, patch) {
  return serialStore(async () => {
    const stored = await storeGet(K.decisions(mediaId), {});
    const maps = [stored, mediaId === S.mediaId && S.decisions, S.folderDecisions[mediaId]].filter(Boolean);
    for (const d of maps) {
      for (const [b, v] of Object.entries(patch)) {
        if (v) d[b] = v;
        else delete d[b];
      }
    }
    await storeSet(K.decisions(mediaId), unfavOnly(stored));
  });
}
// 保留 is one list for every folder; a null value deletes.
function patchKept(patch) {
  for (const [b, v] of Object.entries(patch)) {
    if (v) S.kept[b] = S.decisions[b] = v;
    else {
      delete S.kept[b];
      delete S.decisions[b];
    }
  }
  return storeSet(K.kept, S.kept);
}
// aid and title let 最近取消收藏 re-favorite the video after it has left the folder list.
// batch: when the batch 取消收藏 that made it started, so 最近取消收藏 can re-favorite that batch in one go.
const unfavRecord = (it, at, batch) => ({ action: "unfav", at, aid: it.aid, title: it.title, ...(batch && { batch }) });
const saveVideoTags = () => storeSet(K.videoTags, S.videoTags);
const shortTitle = (it) => (it.title.length > 24 ? `${it.title.slice(0, 24)}…` : it.title);

// S on a card: 保留 belongs to the video, so it shows in every folder.
function keepOne(bvid) {
  const it = S.itemMap.get(bvid);
  if (!it || fav.state().pending(bvid)) return;
  const prev = S.decisions[bvid];
  if (prev?.action === "keep") return;
  if (prev?.action === "unfav") return toast("这个视频已取消收藏，按 U 撤销后再改", true);
  const before = visibleItems();
  patchKept({ [bvid]: { action: "keep", at: Date.now() } });
  pushUndo(keepStep([bvid]));
  toast(`已保留《${shortTitle(it)}》 · U 撤销`);
  render();
  advanceFrom(bvid, before);
}

// ---------- 收藏夹's B站 writes ----------
// Every write to Bilibili's folders goes through fav; writes.js sends them (one batch at a time as runs' "fav", chunks,
// limit holds, which folders were just written). fav asks, plans the requests, keeps the local records after each chunk,
// tells the result and pushes the undo step. fav.state() is what the page draws and its reads check.
// A batch's run: { job, verb, done, total, mediaId: where it started, folder: where it writes now, to/toName for 移动 / 复制 }.
const favRun = (p) => p && { ...p.meta, job: p.job, name: p.name, done: p.done, total: p.total, folder: String(p.folders[0] ?? p.meta.mediaId) };
function favLine(p) {
  const run = favRun(p);
  return run.job === "transfer" ? `${run.verb}到「${run.toName}」${run.done}/${run.total}${runWhere(run)}` : `${run.verb}中${unfavWhere(run)} ${run.done}/${run.total}${runWhere(run)}`;
}
const W = MdgWrites.create({
  runs,
  lane: "fav",
  send: (msg) => (render(), send(msg)), // redrawn first, so the cards and buttons show what is pending
  line: favLine,
  settleMs: globalThis.__TRIAGE_SETTLE_MS || 3000
});
// Bilibili takes 稍后再看 (and 收藏到 from 已出分拣范围) one video per request: one per chunk keeps the count exact on a
// failure. Other folders take 20, a second apart.
const chunkSize = (one) => (one ? 1 : 20);
const chunkGap = (one) => (one ? 300 : 1000);
function chunksOf(items, one, make) {
  const out = [];
  for (let i = 0; i < items.length; i += chunkSize(one)) out.push({ ...make(items.slice(i, i + chunkSize(one))), gap: chunkGap(one) });
  return out;
}
const refavChunk = (f, { bvid, aid }) => ({ msg: { type: "triage-refav", mediaId: f, aid }, keys: [bvid], folders: [f], gap: chunkGap(true) });
async function refavDone({ folders: [f], keys: [bvid] }) {
  bumpCount(f, 1);
  await patchDecisions(f, { [bvid]: null });
  renderStatus();
}
// 停止 on the pill (as 关注's): what went through stays.
const stopWords = (what, r) => `已停止${what}：完成 ${r.done} 个，未完成 ${r.total - r.done} 个`;
const undoBlocked = () => (W.busy() ? `${W.busy()}还在跑，等它完成再撤销` : "");
const busyError = (r) => r.error || (r.busy ? `${r.busy}还在跑，等它完成` : "");

// Re-favorites items ([{ bvid, aid }]) into mediaId, one per request; the first failure stops it. It changes Bilibili,
// so it runs to the end even after another folder opens. Returns { n, rest, error }.
async function refavInto(mediaId, items) {
  const r = await W.run("refav", "重新收藏", { verb: "重新收藏", chunks: items.map((it) => refavChunk(mediaId, it)), folders: [mediaId], meta: { mediaId, verb: "重新收藏" }, onChunk: refavDone });
  render();
  return { n: r.done, rest: items.slice(r.done), error: busyError(r), stopped: r.stopped };
}

// 所有收藏夹's batch 取消收藏 undone: each video back in every folder it was taken out of, as one run.
async function refavGone(gone) {
  const chunks = Object.entries(gone).flatMap(([f, items]) => items.map((it) => refavChunk(f, it)));
  const r = await W.run("refav", "重新收藏", {
    verb: "重新收藏",
    chunks,
    folders: [String(S.mediaId)],
    meta: { mediaId: String(S.mediaId), verb: "重新收藏" },
    async onChunk(c) {
      await refavDone(c);
      const [f] = c.folders;
      const it = S.itemMap.get(c.keys[0]);
      if (!it?.folders) return;
      it.folders = [...new Set([...it.folders, f])];
      it.left = (it.left || []).filter((x) => x !== f);
      if (S.decisions[it.bvid]?.action === "unfav") delete S.decisions[it.bvid];
    }
  });
  render();
  const rest = {};
  for (const c of chunks.slice(r.done)) (rest[c.folders[0]] ||= []).push({ bvid: c.keys[0], aid: c.msg.aid });
  return { n: r.done, rest, error: busyError(r), stopped: r.stopped };
}

// The U step of a 取消收藏: Bilibili favorites them again, so it waits for a running batch.
const favStep = (n, ask, undo) => ({ kind: "fav", ask: n > 1 ? ask : null, blocked: undoBlocked, undo });
const refavAsk = (n) => [`在 B站重新收藏这 ${n} 个视频？`, `<p>撤销上一步的批量取消收藏。</p>`, `重新收藏 ${n} 个`];
const redraw = () => (render(), setFocus(S.focused), "");

// A batch undo cut short: by a failure, or by 停止 (what went through stays undone). [what happened, U again, why].
const cutWords = (error, stopped) => (error ? ["撤销中断", "重试", `：${error}`] : stopped ? ["已停止撤销", "撤销", ""] : null);
// U on a batch 取消收藏 in one folder: back into it. Elsewhere the ones left stay under its 最近取消收藏.
function unfavManyStep(mediaId, items) {
  return favStep(items.length, refavAsk(items.length), async () => {
    const { n, rest, error, stopped } = await refavInto(mediaId, items);
    const here = S.mediaId === mediaId;
    const where = here ? "" : `「${folderName(mediaId)}」`;
    const cut = cutWords(error, stopped);
    if (cut && here) {
      pushUndo(unfavManyStep(mediaId, rest));
      toast(`${cut[0]}（已重新收藏 ${n} 个，剩余 ${rest.length} 个可再按 U ${cut[1]}）${cut[2]}`, Boolean(error));
    } else if (cut) toast(`${where}${cut[0]}（已重新收藏 ${n} 个，剩余 ${rest.length} 个在它的最近取消收藏里）${cut[2]}`, Boolean(error));
    else toast(`${where}已重新收藏 ${n} 个`);
    return redraw();
  });
}
// U on 所有收藏夹's batch 取消收藏: each video back in every folder it left (gone: folder → [{ bvid, aid }]). Elsewhere
// the ones left stay under each folder's 最近取消收藏.
function goneStep(items, gone) {
  return favStep(items.length, refavAsk(items.length), async () => {
    const { rest, error, stopped } = await refavGone(gone);
    const here = S.mediaId === ALL;
    const left = items.filter((x) => Object.values(rest).some((list) => list.some((y) => y.bvid === x.bvid)));
    const cut = cutWords(error, stopped);
    if (cut && here) {
      pushUndo(goneStep(left, rest));
      toast(`${cut[0]}（剩余 ${left.length} 个可再按 U ${cut[1]}）${cut[2]}`, Boolean(error));
    } else if (cut) toast(`「${folderName(ALL)}」${cut[0]}（剩余 ${left.length} 个在各收藏夹的最近取消收藏里）${cut[2]}`, Boolean(error));
    else toast(`已重新收藏 ${items.length} 个`);
    return redraw();
  });
}
// U on one 取消收藏 (D): back into each folder it left (prevs: folder → its record before), and its record back.
function unfavStep(it, prev, prevs) {
  return favStep(1, null, async () => {
    const token = S.folderToken;
    toast(`正在重新收藏《${shortTitle(it)}》…`);
    for (const [mediaId, before] of Object.entries(prevs)) {
      const { error } = await refavInto(mediaId, [{ bvid: it.bvid, aid: it.aid }]);
      if (error) {
        if (token === S.folderToken) toast(`撤销失败：${error}。可到 B站手动重新收藏`, true);
        return "";
      }
      await patchDecisions(mediaId, { [it.bvid]: before });
    }
    if (token !== S.folderToken) return "";
    if (it.folders) {
      it.folders = [...new Set([...it.folders, ...Object.keys(prevs)])];
      it.left = (it.left || []).filter((f) => !it.folders.includes(f));
      if (prev) S.decisions[it.bvid] = prev;
      else delete S.decisions[it.bvid];
    }
    toast(`已撤销：重新收藏《${shortTitle(it)}》`);
    S.focused = it.bvid;
    return redraw();
  });
}

const fav = {
  // D on a card. It does not wait for a batch; only a video the running batch still has to write is refused. A B站
  // limit fails at once (a key press does not wait ten minutes).
  async unfav(bvid) {
    const it = S.itemMap.get(bvid);
    const pending = W.pending(bvid);
    if (!it || S.decisions[bvid]?.action === "unfav") return;
    if (pending) return toast(pending === "取消收藏" ? "这个视频已在等待取消收藏" : `这个视频在等待${pending}，结束后再取消收藏`, true);
    const prev = S.decisions[bvid] || null;
    const before = visibleItems();
    const token = S.folderToken;
    // 所有收藏夹 items carry .folders: 取消收藏 asks which when there are several.
    let folders = it.folders ? [...it.folders] : [S.mediaId];
    if (folders.length > 1) folders = await pickUnfavFolders(it);
    if (!folders.length) return;
    const r = await W.single("取消收藏", folders.map((f) => ({ msg: { type: "triage-unfav", mediaId: f, aids: [it.aid] }, keys: [bvid], folders: [f] })), ({ folders: [f] }) => bumpCount(f, -1));
    if (r.error) toast(`取消收藏失败：${r.limited ? `${THROTTLES.THROTTLED.label}，请稍后再试` : r.error}`, true);
    folders = folders.slice(0, r.done);
    if (!folders.length) return render();
    const rec = unfavRecord(it, Date.now());
    const prevs = Object.fromEntries(folders.map((f) => [f, (f === S.mediaId ? S.decisions : S.folderDecisions[f])?.[bvid] || null]));
    for (const f of folders) await patchDecisions(f, { [bvid]: rec });
    // After a folder switch the record is saved under its folder; the undo step would point at a video no longer listed.
    if (token !== S.folderToken) return;
    const left = it.folders ? (it.folders = it.folders.filter((f) => !folders.includes(f))) : [];
    if (it.folders) it.left = [...new Set([...(it.left || []), ...folders])];
    if (it.folders && !left.length) S.decisions[bvid] = rec;
    pushUndo(unfavStep(it, prev, prevs));
    const from = left.length ? `从「${folders.map(folderName).join("、")}」` : "";
    toast(`已${from}取消收藏《${shortTitle(it)}》 · U 撤销`);
    render();
    advanceFrom(bvid, before);
  },

  // The selection bar's and 「按 AI 判断」's batch 取消收藏. It runs to the end even after another folder opens;
  // 所有收藏夹 goes folder by folder.
  async unfavMany(list) {
    if (!list.length || W.busy()) return;
    const all = S.mediaId === ALL;
    const folders = all
      ? await pickBatchUnfavFolders(list)
      : (await askConfirm(`在 B站取消收藏这 ${list.length} 个视频？`, UI.confirmList(list.map((it) => it.title)), `取消收藏 ${list.length} 个`, { danger: true })) ? [String(S.mediaId)] : [];
    if (!folders.length) return;
    const mediaId = String(S.mediaId);
    const token = S.folderToken;
    const batch = Date.now();
    const gone = {}; // folder → the videos taken out of it
    const chunks = folders.flatMap((f) =>
      chunksOf(all ? list.filter((it) => it.folders.includes(f)) : list, f === TOVIEW, (items) => ({ msg: { type: "triage-unfav", mediaId: f, aids: items.map((it) => it.aid) }, keys: items.map((it) => it.bvid), folders: [f], items }))
    );
    let sent = 0;
    const r = await W.run("unfav", "批量取消收藏", {
      verb: "取消收藏",
      chunks,
      folders: [mediaId],
      meta: { mediaId, verb: "取消收藏" },
      async onChunk({ folders: [f], items }) {
        sent++;
        bumpCount(f, -items.length);
        const at = Date.now();
        await patchDecisions(f, Object.fromEntries(items.map((it) => [it.bvid, unfavRecord(it, at, batch)])));
        (gone[f] ||= []).push(...items.map(({ bvid, aid }) => ({ bvid, aid })));
      }
    });
    if (r.busy) return;
    const done = r.done;
    const fail = r.error && `${all || S.mediaId !== mediaId ? `「${folderName(chunks[sent].folders[0])}」` : ""}批量取消收藏失败（已完成 ${done} 个）：${r.error}`;
    const stop = r.stopped && `${S.mediaId !== mediaId ? `「${folderName(mediaId)}」` : ""}${stopWords("批量取消收藏", r)}`;
    // After a failure or 停止 the ones done are still recorded and undoable; the toast says how far it got.
    const tell = (msg, undoHint) => toast(fail || stop ? `${fail || stop}${undoHint}` : msg, Boolean(fail));
    if (!done && (fail || stop)) toast(fail || stop, Boolean(fail));
    else if (done && all && token === S.folderToken) {
      // As a single 取消收藏 here: the video leaves those folders, and the view once it is in none.
      const at = Date.now();
      for (const [f, items] of Object.entries(gone)) {
        for (const { bvid } of items) {
          const it = S.itemMap.get(bvid);
          it.folders = it.folders.filter((x) => x !== f);
          it.left = [...new Set([...(it.left || []), f])];
          if (!it.folders.length) S.decisions[bvid] = unfavRecord(it, at, batch);
        }
      }
      const videos = list.filter((it) => Object.values(gone).some((items) => items.some((x) => x.bvid === it.bvid)));
      pushUndo(goneStep(videos.map(({ bvid, aid }) => ({ bvid, aid })), gone));
      for (const it of videos) S.selected.delete(it.bvid);
      tell(`已从 ${Object.keys(gone).length} 个收藏夹取消收藏 ${videos.length} 个视频 · U 撤销`, " · U 撤销已完成的");
    } else if (done && all) {
      tell(`已从 ${Object.keys(gone).length} 个收藏夹取消收藏，可在各收藏夹的最近取消收藏里撤销`, "，已完成的可在各收藏夹的最近取消收藏里撤销");
    } else if (done && S.mediaId === mediaId) {
      pushUndo(unfavManyStep(mediaId, list.slice(0, done).map(({ bvid, aid }) => ({ bvid, aid }))));
      for (const it of list.slice(0, done)) S.selected.delete(it.bvid);
      tell(`已取消收藏 ${done} 个 · U 撤销`, " · U 撤销已完成的");
    } else if (done) {
      // Elsewhere they are saved under their folder and listed in its 最近取消收藏, where they can be re-favorited.
      tell(`「${folderName(mediaId)}」已取消收藏 ${done} 个，可在它的最近取消收藏里撤销`, "，已完成的可在它的最近取消收藏里撤销");
    }
    render();
  },

  // 移动 / 复制 (收藏到 from 已出分拣范围) of the selection. It runs to the end even after another folder opens. A new
  // target folder is made only once this run has the slot.
  async transfer(list) {
    if (!list.length || W.busy()) return;
    const from = String(S.mediaId);
    const ask = await askTransfer(list);
    if (!ask) return;
    const { how, target } = ask;
    const add = how === "add"; // from 已出分拣范围: no source folder on Bilibili
    const move = how === "move";
    const verb = { move: "移动", copy: "复制", add: "收藏" }[how];
    const meta = { mediaId: from, verb, to: target.id, toName: folderName(target.id) };
    const plainItem = ({ removedAt, movedTo, hidden, from, ...it }) => it;
    const r = await W.run("transfer", "移动/复制", async () => {
      if (target.create) {
        const made = await send({ type: "triage-folder-create", title: target.create, privacy: target.privacy });
        if (!made.ok) return void toast(`新建收藏夹失败：${made.error}`, true);
        meta.to = String(made.data.id);
        meta.toName = made.data.title;
        // Chosen for triage right away, without reloading the folder list.
        const f = { id: Number(meta.to), title: meta.toName, count: 0 };
        S.allFolders.push(f);
        S.folders.push(f);
        S.included = [...S.included, meta.to];
        await chrome.storage.local.set({ [K.included]: S.included });
      }
      const { to, toName } = meta;
      const chunks = chunksOf(list, add || from === TOVIEW, (items) => ({ msg: { type: "triage-transfer", from: add ? "" : from, to, aids: items.map((it) => it.aid), move }, keys: items.map((it) => it.bvid), folders: [from, to], items }));
      return {
        verb,
        chunks,
        folders: [from, to],
        meta,
        // Folders are not read while being written, so both cached lists follow each chunk here instead of by a sync.
        async onChunk({ items }) {
          // Read per chunk: ticking or unticking the target meanwhile takes effect for the rest.
          const chosen = S.included.includes(to);
          bumpCount(to, items.length);
          if (move) bumpCount(from, -items.length);
          if (chosen) await patchSnapshot(to, { add: items.map(plainItem) }, Boolean(target.create));
          if (add) {
            if (chosen) await dropRemoved(items.map((it) => it.bvid));
            else await addMovedToRemoved(from, items.map(plainItem), { id: to, title: toName });
          }
          if (move) {
            const gone = new Set(items.map((it) => it.bvid));
            // One queued step, so a folder save in between never sees the videos gone from here but not yet recorded.
            await serialStore(async () => {
              await patchSnapshotNow(from, { drop: [...gone] });
              if (!chosen) await addMovedNow(from, items, { id: to, title: toName });
            });
            if (S.mediaId === from) setItems(S.items.filter((it) => !gone.has(it.bvid)));
          }
          for (const it of items) S.selected.delete(it.bvid);
        }
      };
    });
    if (!r.total) return;
    const { to, toName } = meta;
    const where = S.mediaId === from ? "" : `「${folderName(from)}」`;
    if (r.error) toast(`${where}${verb}到「${toName}」中断（已完成 ${r.done} 个）：${r.error}`, true);
    else if (r.stopped) toast(`${where}${stopWords(`${verb}到「${toName}」`, r)}`);
    // A folder-list load meanwhile (分拣设置 saved) may have listed it already, or dropped it while Bilibili lagged.
    const made = target.create && S.allFolders.find((x) => String(x.id) === to);
    if (made && !el.folderSelect.querySelector(`option[value="${to}"]`)) {
      el.folderSelect.querySelector(`option[value="${REMOVED}"]`)?.previousElementSibling?.before(new Option(`${toName} (${made.count})`, to));
    }
    if (r.done === list.length) {
      toast(`${where}已${verb} ${r.done} 个到「${toName}」${(move || add) && !S.included.includes(to) ? "，它们在「已出分拣范围」里，勾选这个收藏夹后会自动找回" : ""}`);
    }
    render();
  },

  // 最近取消收藏's 重新收藏 of one video.
  async refav(bvid) {
    const d = S.decisions[bvid];
    if (!d?.aid || W.busy()) return;
    const mediaId = S.mediaId;
    const { error } = await refavInto(String(mediaId), [{ bvid, aid: d.aid }]);
    if (error) return toast(`重新收藏失败：${error}`, true);
    if (mediaId !== S.mediaId) return;
    toast(`已重新收藏《${d.title || bvid}》`);
    quickSync({ force: true });
  },

  // 最近取消收藏's 这批全部重新收藏: every record one batch 取消收藏 left here.
  async refavBatch(batch) {
    const items = unfavBatchItems(batch);
    if (!items.length || W.busy()) return;
    const mediaId = String(S.mediaId);
    const { n, rest, error, stopped } = await refavInto(mediaId, items);
    const where = S.mediaId === mediaId ? "" : `「${folderName(mediaId)}」`;
    if (error) toast(`${where}重新收藏中断（已完成 ${n} 个，剩余 ${rest.length} 个可再点重试）：${error}`, true);
    else if (stopped) toast(`${where}${stopWords("重新收藏", { done: n, total: items.length })}`);
    else toast(`${where}已重新收藏这批 ${n} 个`);
    if (!where) quickSync({ force: true });
  },

  // What the page draws and checks: busy (the running batch's name, "" when none), run (it, once planned: favRun),
  // pending(bvid) (the verb a video waits for, ""), writing(folder, since?) (not to be read now). Its pill line is
  // favLine, in runs' table.
  state() {
    return { busy: W.busy(), run: favRun(W.progress()), pending: W.pending, writing: W.writing };
  }

};

// U undoes the last step of the mode it is pressed in.
async function undo() {
  const steps = followMode() ? S.modeUndo : S.undo;
  const top = steps.at(-1);
  if (!top) return toast("没有可撤销的操作");
  // A step that writes to Bilibili waits for a running batch.
  const blocked = top.blocked?.();
  if (blocked) return toast(blocked, true);
  if (top.ask && (!(await askConfirm(top.ask[0], top.ask[1], top.ask[2] || "撤销")) || steps.at(-1) !== top || top.blocked?.())) return;
  steps.pop();
  const text = await top.undo();
  return text && toast(text);
}

// Batch buttons act on the selected cards of the tab, otherwise on every card with this verdict (none without one).
function batchList(verdict) {
  const list = visibleItems().filter((it) => !isProcessed(it.bvid));
  const sel = selectedIn(list);
  return sel.length ? sel : verdict == null ? [] : list.filter((it) => verdictOf(it).verdict === verdict);
}

// 所有收藏夹: which folders to take this batch out of, each with how many of its videos (all checked by default); the
// button counts the videos left in a checked folder. [] on 取消.
async function pickBatchUnfavFolders(list) {
  const ids = S.folders.map((f) => String(f.id)).filter((f) => list.some((it) => it.folders?.includes(f)));
  const boxes = ids
    .map((f) => `<label class="toggle"><input type="checkbox" name="batchUnfavFolder" value="${esc(f)}" checked /> 「${esc(folderName(f))}」· ${list.filter((it) => it.folders.includes(f)).length} 个</label>`)
    .join("");
  const ask = askConfirm(`在 B站取消收藏这 ${list.length} 个视频？`, `<p>从勾选的收藏夹取消收藏。重复收藏的视频，从每个勾选的收藏夹都取消。</p>${boxes}${UI.confirmList(list.map((it) => it.title))}`, `取消收藏 ${list.length} 个`, { danger: true });
  const checked = () => [...el.confirmBody.querySelectorAll("input:checked")].map((x) => x.value);
  el.confirmBody.onchange = () => {
    const n = list.filter((it) => it.folders.some((f) => checked().includes(f))).length;
    el.confirmOk.textContent = `取消收藏 ${n} 个`;
    el.confirmOk.setAttribute("aria-label", el.confirmOk.textContent);
    el.confirmOk.disabled = !n;
  };
  const ok = await ask;
  el.confirmBody.onchange = null;
  el.confirmOk.disabled = false;
  return ok ? checked() : [];
}

// 移动/复制 takes every selected card still in the folder here, 保留 ones too (unlike 取消收藏, which skips them).
const transferList = () => selectedIn(visibleItems()).filter((it) => it.aid && S.decisions[it.bvid]?.action !== "unfav");

// The shared 移动 / 复制 dialog (shared.js askTransfer) with this folder's targets.
function askTransfer(list) {
  const from = String(S.mediaId);
  const add = from === REMOVED;
  const noAid = selectedIn(visibleItems()).filter((it) => !it.aid).length;
  return UI.askTransfer({
    title: add ? `在 B站把这 ${list.length} 个视频收藏到` : `在 B站移动或复制这 ${list.length} 个视频`,
    n: list.length,
    hows: add ? ["add"] : ["copy", "move"],
    list: `<ul>${list.slice(0, 10).map((it) => `<li>${esc(it.title)}</li>`).join("")}</ul>${list.length > 10 ? `<p>等 ${list.length} 个</p>` : ""}${noAid ? `<p class="dialog-hint">另有 ${noAid} 个缺少视频编号（很早以前留下的记录），不能${add ? "收藏" : "移动或复制"}。</p>` : ""}`,
    label: "目标收藏夹",
    options: S.allFolders.filter((f) => String(f.id) !== from && String(f.id) !== TOVIEW).map((f) => [String(f.id), `${f.title} (${f.count})`]),
    newText: "新建收藏夹…",
    newPlaceholder: "新收藏夹名称",
    newMax: 20,
    privacy: true,
    how: add ? "" : "复制：原收藏夹里也留着。移动：从原收藏夹移走。",
    note: (v) =>
      v === "new" || S.included.includes(v)
        ? ""
        : add
          ? `「${esc(folderName(v))}」没有勾选分拣：收藏后这些视频仍在「已出分拣范围」。<br>以后在收藏夹设置里勾选它，会自动找回。`
          : `「${esc(folderName(v))}」没有勾选分拣：移动过去的视频会进「已出分拣范围」。<br>以后在收藏夹设置里勾选它，这些视频会自动找回。复制不受影响。`
  });
}

// Folders are not read while a run writes them (fav.state().writing), so both cached lists change here instead of by a sync: the target
// gains the videos (a new folder starts with exactly these), the source loses them without counting them as having left
// every folder (已出分拣范围). A folder with no cached list is left to its first load.
function patchSnapshot(...args) {
  return serialStore(() => patchSnapshotNow(...args));
}
// patchSnapshot for a fn already running in serialStore.
async function patchSnapshotNow(mediaId, { add = [], drop = [] }, created = false) {
  const key = K.snapshot(mediaId);
  const got = await chrome.storage.local.get([key, K.left]);
  const snap = got[key];
  if (!snap && !created) return;
  const old = snap || { bvids: [], invalid: [], titles: {}, items: [], ids: [], intro: "" };
  const gone = new Set(drop);
  const fresh = add.filter((it) => !old.bvids.includes(it.bvid));
  const added = fresh.map((it) => it.bvid);
  const keep = (b) => !gone.has(b);
  // The trail follows this move like a folder diff would: added here forgets this folder, dropped from here adds it.
  const left = { ...got[K.left] };
  for (const it of add) forgetLeft(left, it.bvid, String(mediaId));
  const folder = { id: String(mediaId), title: folderName(mediaId) };
  const at = Date.now();
  for (const b of drop) noteLeft(left, b, folder, at);
  await store({
    [K.left]: left,
    [key]: {
      ...old,
      bvids: [...added, ...old.bvids.filter(keep)],
      invalid: (old.invalid || []).filter(keep),
      titles: { ...old.titles, ...Object.fromEntries(fresh.map((it) => [it.bvid, it.title])) },
      items: [...fresh, ...(old.items || []).filter((it) => keep(it.bvid))],
      ids: old.ids ? [...added, ...old.ids.filter(keep)] : old.ids
    }
  });
}

// Moved to a folder outside triage: like any video that left every chosen folder, it goes to 已出分拣范围, marked with
// where it went. Ticking that folder brings it back (recoverRemoved).
function addMovedToRemoved(...args) {
  return serialStore(() => addMovedNow(...args));
}
// addMovedToRemoved for a fn already running in serialStore.
async function addMovedNow(from, items, movedTo) {
  const others = chosenOtherIds(from);
  const got = await chrome.storage.local.get([K.removed, K.left, ...others.map(K.snapshot)]);
  const otherBvids = new Set(others.flatMap((id) => got[K.snapshot(id)]?.bvids || []));
  const at = Date.now();
  const source = from === REMOVED ? null : { id: from, title: folderName(from) };
  const { removed, left } = moveToRemoved(got[K.removed] || {}, got[K.left] || {}, items, otherBvids, source, at, movedTo);
  if (!(await store({ [K.removed]: removed, [K.left]: left }))) return;
  if (S.mediaId === REMOVED) {
    for (const it of items) {
      const rec = removed[it.bvid];
      if (!rec) continue;
      const shown = S.itemMap.get(it.bvid);
      if (shown) Object.assign(shown, { removedAt: at, movedTo, from: rec.from });
      else S.items.unshift({ ...it, removedAt: at, movedTo, from: rec.from });
    }
    setItems(S.items);
  }
  S.removedCount = Object.keys(removed).length;
  renderTop();
}

// Newly ticked folders take back their videos from 已出分拣范围 at once, without waiting for the folder to be opened.
async function recoverRemoved(ids) {
  if (!Object.keys(await storeGet(K.removed, {})).length) return;
  let n = 0;
  for (const id of ids) {
    const r = await send({ type: "triage-folder-ids", mediaId: id });
    if (r.ok) n += await dropRemoved(r.data.bvids);
  }
  if (n) {
    toast(`已从「已出分拣范围」找回 ${n} 个视频`);
    renderTop();
  }
}

function batchKeep(list) {
  if (!list.length) return;
  const at = Date.now();
  patchKept(Object.fromEntries(list.map((it) => [it.bvid, { action: "keep", at }])));
  for (const it of list) S.selected.delete(it.bvid);
  pushUndo(keepStep(list.map((it) => it.bvid)));
  toast(`已标记保留 ${list.length} 个 · U 撤销`);
  render();
}

// ---------- tags ----------
const saveTags = () => storeSet(K.tags, S.tags);

// Returns the folder's tag with this name, creating it if needed; the color comes from the palette in turn.
// null (with a toast) outside a folder or when the folder already has tagLimit() tags.
function createTag(name, folder = S.mediaId) {
  name = cleanTagName(name);
  if (!name) return toast(UI.tagNameError(name, []), true), null;
  if (folder === ALL || folder === REMOVED || !folder) return toast(FOLDER_ONLY, true), null;
  const own = S.tags.filter((t) => t.folder === String(folder));
  const existing = own.find((t) => t.name === name);
  if (existing) return existing;
  if (own.length >= tagLimit()) return toast(`这个收藏夹已经有 ${own.length} 个标签了，先删掉不用的，或在收藏夹设置里调高上限`, true), null;
  const tag = { id: newTagId(), name, color: UI.nextTagColor(own), folder: String(folder) };
  S.tags.push(tag);
  saveTags();
  return tag;
}

function writeVideoTags(bvid, ids) {
  if (ids.length) S.videoTags[bvid] = ids;
  else delete S.videoTags[bvid];
}
function setVideoTags(bvid, ids, prev) {
  const same = ids.length === prev.length && ids.every((id) => prev.includes(id));
  if (same) return false;
  writeVideoTags(bvid, ids);
  saveVideoTags();
  pushUndo(
    pageStep("tags", 1, "", () => {
      writeVideoTags(bvid, prev);
      saveVideoTags();
      S.focused = bvid;
      return "已撤销标签修改";
    })
  );
  return true;
}

// A tag's chip on the card takes it off that video in one click; U puts it back.
function removeVideoTag(bvid, id) {
  const prev = (S.videoTags[bvid] || []).filter((x) => tagById(x));
  const name = tagById(id)?.name;
  if (!setVideoTags(bvid, prev.filter((x) => x !== id), prev)) return;
  render();
  toast(`已去掉「${name}」· U 撤销`);
}

// 「AI 刚打的」 of the open folder (a Set of bvids); empty in 所有收藏夹 and 已出分拣范围.
// Asked per video while filtering, so the set is built once per list (lists are replaced, never changed in place).
let aiRecentMemo = [null, new Set()];
const aiRecentSet = () => {
  const bvids = S.aiRecent[String(S.mediaId)]?.bvids;
  if (aiRecentMemo[0] !== bvids) aiRecentMemo = [bvids, new Set(bvids || [])];
  return aiRecentMemo[1];
};
const saveAiRecent = () => storeSet(K.aiRecent, S.aiRecent);
// × and U end the folder's 「AI 刚打的」; × leaves the tags as they are.
function endAiRecent(folder = String(S.mediaId)) {
  delete S.aiRecent[folder];
  if (folder === String(S.mediaId)) S.aiRecentFilter = false;
  saveAiRecent();
}

// T on a card opens the shared picker (tag-picker.js) as a modal; T in the player or 「+ 标签」 on the viewer line opens
// it under that line. The selection bar's 标签… opens it for the selected videos (one folder). Closing saves once, as
// one undo step. home ({ item, folders }, the viewer's) tags that video in its own folders, whatever is open.
function openPicker(bvids, anchor = "", home = null) {
  bvids = [].concat(bvids).filter((b) => home || S.itemMap.has(b));
  if (!bvids.length || (!home && S.mediaId === REMOVED)) return;
  const bvid = bvids[0];
  const folders = home?.folders || pickerFolders(bvid);
  const one = folders.length === 1;
  TagPicker.open({
    title: UI.pickTitle(bvids.length, shortTitle(home?.item || S.itemMap.get(bvid)), "视频"),
    targets: bvids,
    // Every tag of the video, so saving keeps the ones of other folders the picker does not list.
    idsOf: (b) => (S.videoTags[b] || []).filter((id) => tagById(id)),
    tags: () => S.tags.filter((t) => folders.includes(t.folder)),
    canCreate: one,
    create: (name) => createTag(name, folders[0]),
    empty: one ? "输入名称后回车新建标签" : "在具体收藏夹里新建标签",
    anchor,
    onClose: savePicked
  });
}

// The picker's tags: the open folder's; in 所有收藏夹 those of the folders the video is in. New tags need one folder.
function pickerFolders(bvid) {
  return inFolderView() ? [String(S.mediaId)] : (S.itemMap.get(bvid)?.folders || []).map(String);
}

// Several videos changed (标签… on a selection) are one undo step too.
function savePicked(changes) {
  if (changes.length === 1) {
    const [c] = changes;
    const prev = (S.videoTags[c.key] || []).filter((id) => tagById(id));
    if (setVideoTags(c.key, TagPicker.applyChange(prev, c), prev)) toast("标签已更新 · U 撤销");
  } else if (changes.length) {
    const prevs = {};
    for (const c of changes) {
      prevs[c.key] = (S.videoTags[c.key] || []).filter((id) => tagById(id));
      writeVideoTags(c.key, TagPicker.applyChange(prevs[c.key], c));
    }
    saveVideoTags();
    const n = Object.keys(prevs).length;
    pushUndo(
      pageStep("tagsMany", n, "tags", () => {
        for (const [b, prev] of Object.entries(prevs)) writeVideoTags(b, prev);
        saveVideoTags();
        return `已撤销 ${n} 个视频的标签修改`;
      })
    );
    toast(`${changes.length} 个视频的标签已更新 · U 撤销`);
  }
  render();
  setFocus(S.focused, true);
}

// The viewer's 「视频标签」 line: the playing video's tags and 「+ 标签 T」; a tag opens the picker too. 关注 then draws
// its 「UP 标签」 line under it (viewerHook).
// In 关注 too, for a video that is in a chosen folder; T there stays on the UP line.
function renderViewerTags() {
  const v = S.viewer;
  el.viewerTags.hidden = !v;
  if (!v) el.viewerTags.innerHTML = "";
  else {
    const edit = Boolean(v.folders?.length);
    const chips = (S.videoTags[v.item.bvid] || [])
      .map(tagById)
      .filter((t) => t && (!v.folders || v.folders.includes(t.folder)))
      .map((t) => `<span class="chip" style="--c:${esc(t.color)}"${edit ? " data-vtag" : ""}>${esc(t.name)}</span>`)
      .join("");
    el.viewerTags.innerHTML = UI.viewerLine({ label: "视频标签", chips, plus: edit && { attrs: "data-vtag", label: "打视频标签" } });
  }
  viewerHook?.();
}
const tagPlaying = () => S.viewer?.folders?.length && openPicker(S.viewing, "#viewerTags .tag-plus", S.viewer);

// ---------- 判断标准 ----------
function openCriteria() {
  el.criteriaTitle.textContent = `判断标准 ·「${folderTitle()}」`;
  el.criteriaInput.value = criteria();
  el.criteriaDialog.returnValue = "";
  el.criteriaDialog.showModal();
  el.criteriaInput.focus();
}

// One folder's 判断标准; empty removes it. The caller stores S.folderCriteria.
function setCriteria(id, text) {
  text = text.trim();
  if (text) S.folderCriteria[id] = text;
  else delete S.folderCriteria[id];
}

async function saveCriteria() {
  const changed = el.criteriaInput.value.trim() !== criteria();
  setCriteria(S.mediaId, el.criteriaInput.value);
  storeSet(K.folderCriteria, S.folderCriteria);
  render();
  // Asked whenever 粗看完成 has stale ones, filters or not. Its button is row 3's 按新标准重新粗看 (listed ones, the
  // selection first, one batch), disabled with the same why when that has none.
  const stale = staleCoarse().length;
  if (!changed || !stale) return;
  const open = redoCoarseOpen();
  const { batch, label, why } = redoState("粗看", open, coarseBatchSize(), "coarse");
  const shown = open.length < stale ? `（当前筛选下列出 ${open.length} 个）` : "";
  const ok = await askConfirm(
    "判断标准改了",
    `<p>「粗看完成」里有 ${stale} 个视频是按旧标准粗看的${shown}，要按新标准重新粗看吗？</p><p>已细看和已处理的视频不动；细看完成页可以另外按新标准重新细看。</p>`,
    label,
    { reason: why }
  );
  if (ok) runStage1(batch, true);
}

// 所有收藏夹 has no one 判断标准: before a 粗看 or 细看 run it lists each folder the run touches, with its videos and its
// 判断标准 to edit (saved as in the 判断标准 dialog). false on 取消.
async function askAllCriteria(title, verb, items) {
  const n = new Map();
  for (const it of items) n.set(homeOf(it), (n.get(homeOf(it)) || 0) + 1);
  const rows = S.folders
    .map((f) => String(f.id))
    .filter((id) => n.has(id))
    .map((id, i) => `<div class="crit-row"><label for="critAll${i}">「${esc(folderName(id))}」· ${n.get(id)} 个</label><textarea id="critAll${i}" rows="2" data-crit="${esc(id)}" placeholder="还没写判断标准，AI 按收藏夹名和简介推测">${esc(criteriaFor(id))}</textarea></div>`)
    .join("");
  const ok = await askConfirm(title, `<p>每个视频按它所在收藏夹的判断标准判断。</p><p>重复收藏的视频，按收藏夹列表里排最前的那个。</p>${rows}`, `开始${verb} ${items.length} 个`);
  if (!ok) return false;
  for (const box of el.confirmBody.querySelectorAll("[data-crit]")) setCriteria(box.dataset.crit, box.value);
  storeSet(K.folderCriteria, S.folderCriteria);
  render();
  return true;
}
// A 粗看 / 细看 button: in 所有收藏夹 after askAllCriteria, elsewhere at once.
async function startJudging(title, verb, items, start) {
  if (S.mediaId === ALL && !(await askAllCriteria(title, verb, items))) return;
  start();
}

// ---------- 标签管理 (tag-dialogs.js): the open folder's tags ----------
const tagCounts = () => {
  const counts = {};
  for (const ids of Object.values(S.videoTags)) for (const id of ids) counts[id] = (counts[id] || 0) + 1;
  return counts;
};
const manageTags = {
  who: "视频",
  hint: () => `这里是这个收藏夹的标签，最多 ${tagLimit()} 个（在收藏夹设置里改）。`,
  reason: () => (inFolderView() ? "" : FOLDER_ONLY),
  tags: () => (inFolderView() ? viewTags() : []),
  count: (id) => tagCounts()[id] || 0,
  add(value) {
    const name = cleanTagName(value);
    const why = UI.tagNameError(name, viewTags());
    if (why) return void toast(why, true);
    const t = createTag(name);
    if (t) render();
    return t;
  },
  edit: (t, field, value) => saveTagEdit(t, field, value),
  remove: (t) => deleteTag(t.id)
};
const openManage = () => TagDialogs.manage.open(manageTags);

// A rename, rule or color edit from 标签管理 (shared.js editedTag); false (and nothing saved) for an empty or duplicate name.
function saveTagEdit(t, field, value) {
  const { tag, why } = UI.editedTag(t, field, value, S.tags.filter((x) => x !== t && x.folder === t.folder));
  if (why) toast(why, true);
  if (!tag) return false;
  delete t.rule;
  Object.assign(t, tag);
  saveTags();
  render();
  return true;
}

async function deleteTag(id) {
  const t = tagById(id);
  const n = Object.values(S.videoTags).filter((ids) => ids.includes(id)).length;
  const ok = await askConfirm(...UI.deleteTagAsk(t, n, "视频"), "删除", { danger: true });
  if (!ok) return;
  S.tags = S.tags.filter((x) => x.id !== id);
  S.videoTags = UI.withoutTag(S.videoTags, id);
  S.tagFilter.delete(id);
  // A tag step undone now would put the deleted tag's id back on its videos.
  S.undo = S.undo.filter((e) => e.kind !== "tags" && e.kind !== "tagsMany" && e.kind !== "aiApply");
  saveTags();
  saveVideoTags();
  pruneAiProposals();
  render();
}

const saveAiProposals = () => storeSet(K.aiProposals, S.ai.proposals);
// A proposal naming a deleted tag no longer fits; it is dropped rather than applied.
function pruneAiProposals() {
  const fits = Object.entries(S.ai.proposals).filter(([, p]) => UI.aiProposalOk(p, (id) => Boolean(tagById(id))));
  if (fits.length === Object.keys(S.ai.proposals).length) return;
  S.ai.proposals = Object.fromEntries(fits);
  saveAiProposals();
}

// ---------- AI stage 1: titles ----------
function aiItem(it) {
  return { bvid: it.bvid, title: it.title, upper: it.upper, duration: it.duration, pubdate: it.pubdate, intro: it.intro };
}


// Titles one 粗看 request carries (a fixed size; the output limit's 自动 grows with it).
const TITLES_PER_REQUEST = 30;

// What 标题粗看 counts and sends: the first coarseBatchSize() 未分析 videos listed now (search and filters applied),
// not the hidden ones. A selection wins, like 细看's nextBatch.
const coarseOpen = () => S.items.filter((it) => stageOf(it) === "none" && !S.coarseFailed.has(it.bvid) && passFilter(it));
const stage1Pending = () => pickBatch(coarseOpen(), coarseBatchSize(), "none");

// list: 未分析 by default; 重新粗看 passes the cards whose 粗看 used an older 判断标准. Their old results stay on the
// cards until new ones replace them, so a stopped or failed run loses nothing.
// redo: 按新标准重新粗看, which only changes the pill's words.
async function runStage1(list = stage1Pending(), redo = false) {
  if (runs.get("stage1")) return;
  // Everything the run needs is taken now: it keeps going after another folder opens. Sending a card again drops its
  // old failure; a failure in this run keeps it from being sent twice.
  for (const it of list) S.coarseFailed.delete(it.bvid);
  const folder = String(S.mediaId);
  const judge = new Map(list.map((it) => [it.bvid, judgeOf(it)]));
  // Due: no 粗看 yet, or one made under another 判断标准.
  const due = (it) => {
    const r = S.titleRes[it.bvid];
    return !VERDICTS[r?.verdict] || isStale(r, judge.get(it.bvid).crit);
  };
  // In its own folder the live step decides (a card may have been sorted meanwhile); elsewhere only the result does.
  const pending = () =>
    list.filter((it) => !S.coarseFailed.has(it.bvid) && !it.invalid && due(it) && (S.mediaId !== folder || ["none", "coarse"].includes(stageOf(it))));
  const run = (S.stage1 = { mediaId: folder });
  const running = runs.run("stage1", {
    total: pending().length,
    gap: S.settings.triageIntervalSec * 1000,
    // In its folder the line says when it will pause; elsewhere it names its folder. Its finished line shows only there.
    line(d, t, stopping) {
      const where = runWhere(run);
      return !where && stopping ? "粗看将在当前批次后暂停" : `${redo && !where ? "按新标准重新粗看" : "标题粗看中"} ${d}/${t}${where}`;
    },
    finished: (d) => (d && !runWhere(run) ? `${redo ? "按新标准重新粗看" : "标题粗看"}完成 ${d} 个` : ""),
    next() {
      // One request carries one 判断标准: in 所有收藏夹 a batch is the first pending video's folder only.
      const left = pending();
      if (!left.length) return null;
      const { home, crit, ctx } = judge.get(left[0].bvid);
      const batch = left.filter((it) => judge.get(it.bvid).home === home).slice(0, TITLES_PER_REQUEST);
      return { batch, crit, ctx, n: batch.length };
    },
    async act({ batch, crit, ctx }) {
      for (const it of batch) S.analyzing.add(it.bvid);
      render();
      const r = await send({ type: "triage-classify-titles", items: batch.map(aiItem), criteria: crit, folder: ctx });
      for (const it of batch) S.analyzing.delete(it.bvid);
      return r;
    },
    // An error every later request would get too ends the run and leaves the cards as they were; one about this batch
    // (a reply in the wrong format, too long) fails its cards and the run goes on, as in 细看.
    judge: aiJudge(),
    done({ batch, crit }, r) {
      const results = r.data?.results || {};
      for (const it of batch) {
        if (results[it.bvid]) S.titleRes[it.bvid] = { criteria: crit, ...results[it.bvid] };
        else S.coarseFailed.set(it.bvid, r.ok ? "AI 回复里没有这个视频" : r.error || "分析失败");
      }
      // A redone card keeps its old 粗看, as a redone 细看 keeps its old result.
      if (!r.ok && batch.some((it) => VERDICTS[S.titleRes[it.bvid]?.verdict])) toast(`重新粗看失败，保留原来的结果：${r.error}`, true);
      if (/截断/.test(r.error || "")) handleAiError(r.error);
      render();
    }
  });
  render();
  const r = await running;
  if (r.error) handleAiError(r.error, r.code);
  // As 细看: a paused run keeps the banner; only a finished one clears it.
  else if (!r.stopped) clearAiBanner();
  otherFolderToast(run, redo ? "按新标准重新粗看" : "标题粗看", r);
  render();
}

// A run that ends in another folder says so there: how many it did, and whether it paused or stopped on an error.
function otherFolderToast(run, name, r) {
  if (!runWhere(run) || r.busy || !(r.done || r.stopped || r.error)) return;
  toast(`「${folderName(run.mediaId)}」${name}${r.error ? "出错停下，" : r.stopped ? "已暂停，" : ""}完成 ${r.done} 个`);
}

// ---------- AI stage 2: subtitle group ----------
// group: a 细看 run, which judges by its own items (the open folder's list is empty while a folder loads, and may be
// another folder's); 已处理 is read only in its own folder.
const needsAnalysis = (b, group = null) => {
  const own = !group || group.mediaId === String(S.mediaId);
  const it = group ? group.items.get(b) : S.itemMap.get(b);
  const a = S.analyses[b];
  return it && !it.invalid && !(own && isProcessed(b)) && a?.status !== "done" && a?.status !== "error";
};

// redo: 细看 these again under the current criteria; each keeps its old result until the new one arrives.
function startGroup(bvids, redo = false) {
  if (!bvids.length || S.group) return;
  S.group = {
    bvids,
    redo: redo ? new Set(bvids) : null,
    mediaId: String(S.mediaId),
    items: new Map(bvids.map((b) => [b, S.itemMap.get(b)])),
    judge: new Map(bvids.map((b) => [b, judgeOf(S.itemMap.get(b))]))
  };
  runGroup();
}

const groupPending = (group, b) => (group.redo ? group.redo.has(b) : needsAnalysis(b, group));

async function analyzeOne(bvid, force, { crit, ctx }) {
  S.analyzing.add(bvid);
  render();
  const r = await send({ type: "triage-analyze", bvid, force, criteria: crit, folder: ctx });
  S.analyzing.delete(bvid);
  render();
  return r;
}

async function runGroup() {
  const group = S.group;
  const running = runs.run("group", {
    total: group.bvids.filter((b) => groupPending(group, b)).length,
    gap: S.settings.triageIntervalSec * 1000,
    alive: () => S.group === group,
    line(d, t, stopping) {
      const where = runWhere(group);
      return !where && stopping ? "细看将在当前视频后暂停" : `${group.redo && !where ? "按新标准重新细看" : "字幕细看中"} ${d}/${t}${where}`;
    },
    finished: (d) => (d && !runWhere(group) ? `${group.redo ? "按新标准重新细看" : "字幕细看"}完成 ${d} 个` : ""),
    next() {
      const b = group.bvids.find((x) => groupPending(group, x));
      return b ? { b, judge: group.judge.get(b) } : null;
    },
    act: ({ b, judge }) => analyzeOne(b, Boolean(group.redo), judge),
    // An error that is not this video's ends the run and leaves the card as it was.
    judge: aiJudge(),
    done({ b, judge }, r) {
      group.redo?.delete(b);
      const keepOld = !r.ok && group.redo && S.analyses[b]?.status === "done";
      if (keepOld) toast(`重新细看失败，保留原来的结果：${r.error}`, true);
      else S.analyses[b] = r.ok ? { criteria: judge.crit, ...r.data } : { bvid: b, status: "error", error: r.error };
      if (/截断/.test(r.error || "")) handleAiError(r.error);
      render();
    }
  });
  render();
  const r = await running;
  if (S.group !== group) return;
  if (r.error) handleAiError(r.error, r.code);
  // A run that stopped on a setup error keeps its banner, and a paused one; any other finished batch clears it.
  const ended = r.error || r.stopped;
  if (!ended) clearAiBanner();
  S.group = null;
  otherFolderToast(group, group.redo ? "按新标准重新细看" : "字幕细看", r);
  render();
}


// Failed results live only on this page. 重试 sends the failed cards of the open tab like the step's own button: the
// selected ones first, one batch, through startJudging; dropping a failed 细看 puts its card back in the batch runner.
// failed: the open tab's failed cards listed now. label is the group head's button, and the 所有收藏夹 dialog's title.
function retryState(failed) {
  const batch = pickBatch(failed, S.tab === "none" ? coarseBatchSize() : fineBatchSize(), S.tab);
  const label = !picking(S.tab) && batch.length === failed.length ? "全部重试" : batchLabel("重试", batch, failed, S.tab);
  return { batch, label, why: aiBusyReason() || pickReason("选中的都不能重试", batch, S.tab) };
}
const failedHeadHtml = (failed) => {
  const { label, why } = retryState(failed);
  return `<div class="group-head">分析失败 ${failed.length} · <button type="button" data-retry-failed aria-label="${label}"${UI.reasonAttrs(why)}>${AI_SPARK}${label}</button></div>`;
};
function retryFailed() {
  const { batch, label, why } = retryState(visibleItems().filter((it) => failedIn(S.tab, it)));
  if (!batch.length || why) return;
  if (S.tab === "none") return startJudging(label, "粗看", batch, () => runStage1(batch));
  startJudging(label, "细看", batch, () => {
    for (const it of batch) delete S.analyses[it.bvid];
    startGroup(batch.map((it) => it.bvid));
  });
}

// A card's 重试 is a run of one through the step's own runner (pill, finish line, banner), 粗看 or 细看 alike; the
// button is disabled while another AI run goes (the guard covers the keyboard).
function retry(bvid) {
  const it = S.itemMap.get(bvid);
  if (!it || aiBusyReason()) return;
  if (failedCoarse(it)) return runStage1([it]);
  delete S.analyses[bvid];
  startGroup([bvid]);
}

// ---------- AI 打标签 (tag-dialogs.js) ----------
const isAnalyzed = (it) => S.analyses[it.bvid]?.status === "done";

function aiScopeItems(scope) {
  if (scope === "selected") return visibleSelected();
  if (scope === "analyzed") return visibleItems().filter(isAnalyzed);
  return visibleItems();
}

// folder: the one this request tags in; excluded: tag names the AI may not see.
function aiCommandItem(it, folder, excluded) {
  const out = aiItem(it);
  const a = S.analyses[it.bvid];
  if (isAnalyzed(it)) {
    out.oneLiner = a.oneLiner || "";
    out.points = a.points || [];
  }
  const names = tagIdsOf(it.bvid).map(tagById).filter((t) => t.folder === folder && !excluded.has(t.name)).map((t) => t.name);
  if (names.length) out.currentTags = names;
  return out;
}

// The AI 打标签 batch size (shared.js SET_ROWS aiBatch).
const aiBatchSize = () => intSetting(S.settings.triageAiBatchSize, 1, 100, 30);

// AI 打标签 tags each folder with its own tags: one part per folder, in 所有收藏夹 every chosen folder the items are in
// (a video in several folders is in each of their parts).
function aiParts(items) {
  if (S.mediaId !== ALL) return [{ folder: String(S.mediaId), items }];
  return S.folders.map((f) => String(f.id)).map((folder) => ({ folder, items: items.filter((it) => it.folders?.includes(folder)) })).filter((p) => p.items.length);
}

function aiScopeText(scope) {
  const items = aiScopeItems(scope);
  const n = items.length;
  const done = items.filter(isAnalyzed).length;
  const size = aiBatchSize();
  const parts = [done && `${done} 个细看过（按 AI 总结和要点判断）`, n - done && `${n - done} 个只有标题和简介，标签可能不准`].filter(Boolean);
  if (!n) return "作用范围里没有视频";
  if (S.mediaId !== ALL) return `${n} 个视频：${parts.join("，")}。分 ${Math.ceil(n / size)} 批发送`;
  const folders = aiParts(items);
  const batches = folders.reduce((sum, p) => sum + Math.ceil(p.items.length / size), 0);
  return `${n} 个视频：${parts.join("，")}。按收藏夹分开打，各用各的标签（重复收藏的视频在每个收藏夹各打一次），${folders.length} 个收藏夹共 ${batches} 批发送`;
}

// The most new tags one run may make: in 所有收藏夹, the roomiest folder's.
const aiRoom = () => (S.mediaId === ALL ? Math.max(0, ...S.folders.map((f) => aiNewTagRoom(f.id))) : aiNewTagRoom());
function aiRoomHint() {
  const tags = aiTags.tags();
  const noneUsable = tags.length > 0 && tags.every((t) => S.ai.excluded.has(t.id));
  const room = aiRoom();
  if (S.mediaId === ALL) {
    return noneUsable
      ? room ? `已有标签都不给 AI 用，AI 只会新建标签（每个收藏夹最多 ${room} 个），你确认后才创建。` : "已有标签都不给 AI 用，名额也满了，AI 打不了标签。"
      : room ? `AI 这次在每个收藏夹最多新建 ${room} 个（不超过它剩下的名额），你确认后才创建。` : "各收藏夹名额已满，AI 只会用已有标签。";
  }
  return noneUsable
    ? room ? `已有标签都不给 AI 用，AI 只会新建标签（这次最多 ${room} 个），你确认后才创建。` : "已有标签都不给 AI 用，名额也满了，AI 打不了标签。"
    : room ? `AI 这次最多新建 ${room} 个（这个收藏夹还剩 ${tagLimit() - tags.length} 个名额），你确认后才创建。` : "名额已满，AI 只会用已有标签。";
}

const aiTags = {
  who: "视频",
  sees: "标题和简介（细看过的还看 AI 总结和要点），不改 AI 判断",
  example: "把这些按技术深度分成 入门/进阶/硬核 三个标签",
  excluded: S.ai.excluded,
  manage: manageTags,
  // 所有收藏夹: one chip per name, as in row 4; turning it off keeps that name from the AI in every folder.
  tags: () => viewTags().filter((t, i, all) => all.findIndex((x) => x.name === t.name) === i),
  scopes: () => [
    { value: "filter", label: "当前筛选", n: visibleItems().length },
    { value: "selected", label: "选中", n: visibleSelected().length },
    { value: "analyzed", label: "细看过的", n: visibleItems().filter(isAnalyzed).length }
  ],
  scopeText: aiScopeText,
  room: aiRoom,
  roomHint: aiRoomHint,
  blocked: () =>
    S.mediaId === REMOVED ? `${FOLDER_ONLY}再让 AI 打标签。` : aiRunning() && S.ai.mediaId !== String(S.mediaId) ? `正在处理「${folderName(S.ai.mediaId)}」的视频，完成后可点进度胶囊上的「查看」确认` : "",
  history: () => S.aiHistory,
  allowRemove: () => S.settings.triageAiRemoveTags === true,
  // The same switch as in 收藏夹设置, saved as soon as it flips.
  async setAllowRemove(on) {
    const r = await send({ type: "triage-settings-save", triageAiRemoveTags: on });
    if (!r.ok) return toast(`保存设置失败：${r.error}`, true), false;
    S.settings.triageAiRemoveTags = on;
    return true;
  },
  running: aiRunning,
  proposal: () => S.ai.proposal,
  run: runAiCommand,
  stop: () => runs.stop("ai"),
  discard() {
    S.ai.proposal = null;
    renderTop();
  },
  apply: () => applyAiProposal(),
  map: () => S.videoTags,
  live: () => S.itemMap,
  tagName: (id) => tagById(id)?.name,
  where: () => String(S.mediaId)
};
const openAi = () => TagDialogs.ai.open(aiTags);

// One AI 打标签 run, for both modes, as job on the mode's runs (R): request(i, p) is batch i's message, merge(p, data)
// folds an answer in. An AI 429 or timeout sends the same batch again, up to AI_THROTTLE_WAITS / AI_TIMEOUT_TRIES in a
// row; an error that fails every batch alike (aiEnds) ends the run. Returns
// { proposal, errors }: proposal is null when no batch got through, so there is nothing to confirm (the progress line says why).
// name(i), when given, says which batch in the progress line and errors (所有收藏夹 names the folder); where() follows
// the pill's line (another folder's run). progress(text) is the dialog's line, counting down with the pill.
async function runAiBatches({ R = runs, job, total, request, merge, intervalMs, progress, name = null, where = () => "" }) {
  const which = (i, full = false) => (name ? name(i) : full ? `第 ${i + 1} / ${total} 批` : `第 ${i + 1} 批`);
  const p = { newTags: [], rows: [], notes: [], errors: [] };
  let answered = 0;
  let i = 0;
  const r = await R.run(job, {
    total,
    tick: () => R.get(job)?.wait && progress(`${R.get(job).wait}${which(i - 1)}…`),
    gap: intervalMs,
    line: (d, t) => `AI 打标签 ${d}/${t} 批${where()}`,
    next: () => (i < total ? { i: i++ } : null),
    act: ({ i }) => (progress(`AI 正在处理${which(i, true)}…`), send(request(i, p))),
    judge: aiJudge(),
    done({ i }, x) {
      if (x.ok) return answered++, merge(p, x.data, i);
      p.errors.push(`${which(i)}失败：${x.error}`);
      // 截断 is reported with what to change.
      if (/截断/.test(x.error || "")) handleAiError(x.error, x.code);
    }
  });

  if (r.error) {
    p.errors.push(`${which(i - 1)}失败：${r.error}`);
    handleAiError(r.error, r.code);
  }
  if (r.stopped) p.errors.push("已手动停止，这里只有已完成批次的建议");
  for (const t of p.newTags) t.checked = p.rows.some((r) => r.add.includes(`new:${t.key}`));
  progress(answered ? "" : p.errors.join("；"));
  return { proposal: answered ? p : null, errors: p.errors };
}

// instruction, scope and allowRemove come from the dialog, which has checked that there is an instruction and items.
async function runAiCommand({ instruction, scope, allowRemove }) {
  if (aiRunning() || S.mediaId === REMOVED) return;
  const items = aiScopeItems(scope);
  if (!items.length) return;
  S.aiHistory = [instruction, ...S.aiHistory.filter((x) => x !== instruction)].slice(0, 5);
  storeSet(K.aiHistory, S.aiHistory);
  // Everything the run sends is taken now: the run outlives a folder switch, and the page then holds another folder.
  // The proposal is kept under the open view (所有收藏夹 too); each part tags in its own folder.
  const folder = String(S.mediaId);
  const all = folder === ALL;
  const excluded = new Set(viewTags().filter((t) => S.ai.excluded.has(t.id)).map((t) => t.name));
  const size = aiBatchSize();
  let from = 0;
  const parts = aiParts(items).map(({ folder: f, items: list }) => {
    const own = S.tags.filter((t) => t.folder === f);
    const part = {
      folder: f,
      from,
      n: Math.ceil(list.length / size),
      payload: list.map((it) => aiCommandItem(it, f, excluded)),
      tags: own.filter((t) => !excluded.has(t.name)).map((t) => ({ name: t.name, rule: t.rule || "" })),
      // newTagFolder keeps same-name new tags of two folders apart in the one proposal.
      opts: { maxNewTags: aiNewTagRoom(f), allowRemove, excluded, newTagFolder: all ? f : undefined, scope: new Set(list.map((it) => it.bvid)) }
    };
    from += part.n;
    return part;
  });
  const partOf = (i) => {
    const part = parts.findLast((x) => x.from <= i);
    return [part, i - part.from];
  };
  S.ai.mediaId = folder;
  const running = runAiBatches({
    job: "ai",
    total: from,
    request: (i) => {
      const [part, j] = partOf(i);
      return { type: "triage-ai-command", instruction, items: part.payload.slice(j * size, (j + 1) * size), tags: part.tags, maxNewTags: part.opts.maxNewTags, allowRemove };
    },
    // not tagIdsOf: the open folder may have changed since the run started
    merge: (p, data, i) => {
      const [part] = partOf(i);
      UI.mergeAiBatch(p, data, { ...part.opts, tags: S.tags.filter((t) => t.folder === part.folder), map: S.videoTags });
    },
    name: all ? (i) => {
      const [part, j] = partOf(i);
      return `「${folderName(part.folder)}」第 ${j + 1}/${part.n} 批`;
    } : undefined,
    where: () => (S.ai.mediaId === String(S.mediaId) ? "" : `（${folderName(S.ai.mediaId)}）`),
    intervalMs: S.settings.triageIntervalSec * 1000,
    progress: (text) => (TagDialogs.ai.progress(aiTags, text, folder), renderStatus())
  });
  renderTop();
  const { proposal: p, errors } = await running;
  if (p) {
    for (const t of p.newTags) if (t.folder) t.where = folderName(t.folder);
    S.ai.proposals[folder] = p;
    saveAiProposals();
  }
  renderTop();
  // Open, the dialog turns to the proposal (or, in another folder, back to its form).
  const open = TagDialogs.ai.isOpen(aiTags);
  if (open) TagDialogs.ai.render(aiTags);
  if (!p) {
    if (!open) toast(`AI 打标签没有成功：${errors.at(-1)}`, true);
    return;
  }
  if (folder !== String(S.mediaId)) toast(`「${folderName(folder)}」的标签建议已完成，点进度胶囊上的「查看」确认`);
  else if (!open) toast("AI 打标签已完成，按 I 查看建议");
}

// What a proposal changes (shared.js); a video that left the folder since keeps its tags.

function applyAiProposal() {
  const p = S.ai.proposal;
  if (!p) return;
  const hadTags = new Set(S.tags.map((t) => t.id));
  const idFor = {};
  for (const t of p.newTags) {
    if (t.checked && cleanTagName(t.name)) idFor[t.key] = createTag(t.name, t.folder || S.mediaId)?.id;
  }
  const changes = []; // [{ bvid, before }]: what U puts back
  for (const [bvid, before, after] of UI.aiChanges(p, S.videoTags, S.itemMap, (key) => idFor[key])) {
    writeVideoTags(bvid, after);
    changes.push({ bvid, before });
  }
  saveTags();
  saveVideoTags();
  const folder = String(S.mediaId);
  const created = S.tags.filter((t) => !hadTags.has(t.id)).map((t) => t.id);
  S.ai.proposal = null;
  // This batch replaces the folder's last one; the list shows it to look over. U ends it only while it is still this one.
  const at = changes.length ? Date.now() : 0;
  if (at) {
    S.aiRecent[folder] = { at, bvids: changes.map((c) => c.bvid) };
    S.aiRecentFilter = true;
    saveAiRecent();
  }
  if (at || created.length)
    pushUndo(
      pageStep("aiApply", changes.length, "ai", () => {
        // Every video the batch changed goes back to before it, edits made since included; a tag deleted since stays gone.
        for (const c of changes) writeVideoTags(c.bvid, c.before.filter((id) => tagById(id)));
        const used = new Set(Object.values(S.videoTags).flat());
        S.tags = S.tags.filter((t) => !created.includes(t.id) || used.has(t.id));
        for (const id of [...S.tagFilter]) if (!tagById(id)) S.tagFilter.delete(id);
        saveTags();
        saveVideoTags();
        // Another tab, or a later batch here, may have replaced the folder's 「AI 刚打的」 since.
        if (S.aiRecent[folder]?.at === at) endAiRecent(folder);
        return `已撤销 AI 打标签：${changes.length} 个视频改回 AI 打之前`;
      })
    );
  render();
  toast(`已应用 AI 建议：${changes.length} 个视频，列表只显示这些 · U 撤销`);
}

// ---------- 待播 ----------
// triage_basket is the 待播 in order: [{ bvid, title, cover?, upper?, duration?, opened? }]; the copied
// fields show videos outside the open folder (entries from before they were copied have only the title).
const saveBasket = () => storeSet(K.basket, S.basket);

function toggleBasket(bvid) {
  const i = S.basket.findIndex((x) => x.bvid === bvid);
  const it = S.itemMap.get(bvid);
  if (i >= 0) {
    removeBasketItems([i]);
    toast("已从待播移除 · U 撤销");
    return;
  }
  if (it) {
    S.basket.push({ bvid, title: it.title, cover: it.cover, upper: it.upper, duration: it.duration });
    toast(`已加入待播《${shortTitle(it)}》`);
    el.basket.classList.remove("bump");
    void el.basket.offsetWidth;
    el.basket.classList.add("bump");
  }
  saveBasket();
  render();
}

// The list keeps the order videos were added in. Opening one only marks it; only 移除 removes it —
// opening a video isn't watching it.
function openBasketItem(i) {
  const x = S.basket[i];
  if (!x) return;
  x.opened = true;
  saveBasket();
  openViewer(x);
}

// 移除 and 清空 take videos out of the list, nothing else; favorites and decisions are untouched. U puts them back
// (basketStep), each at its place.
function basketStep(removed) {
  return pageStep("basket", 0, "", () => {
    for (const { i, x } of removed) if (!S.basket.some((y) => y.bvid === x.bvid)) S.basket.splice(i, 0, x);
    saveBasket();
    return `已撤销：放回待播 ${removed.length} 个`;
  });
}
function removeBasketItems(indexes) {
  const removed = indexes.filter((i) => S.basket[i]).sort((a, b) => a - b).map((i) => ({ i, x: S.basket[i] }));
  if (!removed.length) return;
  const gone = new Set(removed.map((r) => r.x.bvid));
  S.basket = S.basket.filter((x) => !gone.has(x.bvid));
  saveBasket();
  pushUndo(basketStep(removed));
  render();
}

function clearBasket() {
  const n = S.basket.length;
  removeBasketItems(S.basket.map((_, i) => i));
  toast(`已清空待播 ${n} 个 · U 撤销`);
}

function renderBasket() {
  el.basket.hidden = !S.basket.length;
  el.basketCount.textContent = S.basket.length;
  el.basketList.innerHTML = S.basket
    .map((x, i) => {
      const it = S.itemMap.get(x.bvid) || x;
      const title = esc(it.title || x.bvid);
      const meta = [it.upper, fmtDuration(it.duration)].filter(Boolean).map(esc).join(" · ");
      const note = S.notes[x.bvid]?.text?.trim();
      return `<div class="basket-item${x.opened ? " opened" : ""}${x.bvid === S.viewing ? " playing" : ""}" data-i="${i}">
      <button type="button" class="basket-open" data-basket="open" aria-label="打开视频 ${title}">
        ${it.cover ? `<img class="basket-cover" src="${esc(img(it.cover, "160w_90h_1c"))}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ""}
        <span class="basket-text"><span class="basket-title">${title}</span>${meta || x.opened ? `<span class="muted">${[meta, x.opened && "已打开"].filter(Boolean).join(" · ")}</span>` : ""}</span>
      </button>
      <div class="basket-actions">
        <button type="button" data-basket="remove" aria-label="从待播移除 ${title}" title="从待播移除">移除</button>
      </div>
      ${note ? `<div class="muted basket-note">${esc(note)}</div>` : ""}
    </div>`;
    })
    .join("");
}

// 一篇摘录: one Markdown file with each video's link, AI summary, tags and note.
function buildMarkdown(items, now = new Date()) {
  const lines = [
    "---",
    `title: B站摘录 ${fmtTime(now)}`,
    `created: ${stamp(now, false)}`,
    "tags:",
    "  - B站摘录",
    "---",
    ""
  ];
  for (const it of items) {
    const a = S.analyses[it.bvid];
    const done = a?.status === "done";
    lines.push(`## [${mdLinkText(it.title)}](${videoUrl(it.bvid)})`, "");
    if (it.upper || it.invalid) lines.push([it.upper && `UP 主：${it.upper}`, it.invalid && "已失效"].filter(Boolean).join(" · "), "");
    if (done && a.oneLiner) lines.push(`> ${a.oneLiner}`, "");
    if (done && a.points?.length) lines.push(...a.points.map((p) => `- ${p}`), "");
    const names = tagIdsOf(it.bvid).map((id) => tagById(id).name);
    if (names.length) lines.push(`标签：${names.join("、")}`, "");
    const note = S.notes[it.bvid]?.text?.trim();
    if (note) lines.push(`备注：${note}`, "");
  }
  return lines.join("\n");
}

// ---------- 摘录或笔记 (导出) ----------
// 逐个视频笔记 leaves out invalid videos (no subtitle to fetch); 一篇摘录 keeps them, marked, so their notes and tags
// still go out. 待播 is a list to watch from, not an export scope.
function writeScopeItems(scope = el.writeScope.value, notes = el.writeFormat?.value === "notes") {
  const list =
    scope === "all" ? S.items
    : scope === "selected" ? visibleSelected()
    : visibleItems();
  return notes ? list.filter((it) => !it.invalid) : list;
}

// The 阅览 tab opens it preset; a running notes export keeps its own choice.
function openWrite({ scope, format } = {}) {
  if (!writeRunning() && scope) [el.writeScope.value, el.writeFormat.value] = [scope, format];
  // A notes run, running or finished, keeps its progress and failures here until the next export.
  if (!writeRunning() && !S.write.text) clearWriteResult();
  renderWriteScope();
  el.writeDialog.showModal();
}

function stopWrite() {
  runs.stop("write");
  el.writeProgress.textContent = "将在当前视频后停止…";
  renderStatus();
}

function clearWriteResult() {
  S.write.text = "";
  el.writeProgress.textContent = "";
  el.writeProgress.classList.remove("fail-text");
  el.writeSettingsBtn.hidden = true;
  el.writeFailed.hidden = true;
  el.writeFailed.innerHTML = "";
}

function renderWriteScope() {
  const labels = { filter: "当前筛选", selected: "选中 (X)", all: "整个收藏夹" };
  for (const o of el.writeScope.options) {
    const c = writeScopeItems(o.value).length;
    o.textContent = `${labels[o.value]} · ${c} 个`;
    o.disabled = !c;
  }
  if (el.writeScope.selectedOptions[0]?.disabled) el.writeScope.value = [...el.writeScope.options].find((o) => !o.disabled)?.value || "filter";
  const busy = runs.get("write");
  const n = busy ? busy.total : writeScopeItems().length;
  const notes = el.writeFormat.value === "notes";
  const obsidianOff = document.body.classList.contains("obsidian-off");
  el.writeScopeCount.textContent = notes
    ? `共 ${n} 个视频，逐个抓字幕，间隔 ${S.settings.triageIntervalSec} 秒。下载 .zip 每个视频一篇，另附索引${obsidianOff ? "" : "；写入 Obsidian 每个视频一篇，另写一篇以收藏夹命名的索引"}。`
    : `共 ${n} 个视频，合成一篇：链接、AI 总结、标签和你的备注。`;
  el.writeOverwriteRow.hidden = !notes;
  el.writeMdBtn.textContent = notes ? "下载 .zip" : "下载 .md";
  el.writeMdBtn.setAttribute("aria-label", el.writeMdBtn.textContent);
  el.writeCopyBtn.hidden = notes || busy;
  el.writeRunBtn.hidden = el.writeMdBtn.hidden = busy;
  el.writeStopBtn.hidden = !busy;
  el.writeCopyBtn.disabled = el.writeRunBtn.disabled = el.writeMdBtn.disabled = !n;
  el.writeScope.disabled = el.writeFormat.disabled = el.writeOverwrite.disabled = busy;
}

// Every scope is the open folder's videos, whose summaries loadResults has already read.
const digestMarkdown = () => buildMarkdown(writeScopeItems());

// how: copy | download | obsidian
async function exportDigest(how) {
  clearWriteResult();
  const filename = `B站摘录-${stamp()}.md`;
  if (how === "obsidian") {
    setBusy(el.writeRunBtn, "写入中…");
    el.writeProgress.textContent = "正在写入 Obsidian…";
  }
  const markdown = await digestMarkdown();
  if (how === "copy") {
    await navigator.clipboard.writeText(markdown).then(
      () => (el.writeProgress.textContent = "已复制 Markdown"),
      (err) => (el.writeProgress.textContent = `复制失败：${err.message}`)
    );
  } else if (how === "download") {
    MdgDownload.text(filename, markdown);
    el.writeProgress.textContent = `已下载 ${filename}`;
  } else {
    const r = await send({ type: "triage-export", filename, markdown });
    setBusy(el.writeRunBtn, false);
    el.writeProgress.textContent = r.ok ? `已写入 ${r.data?.path || filename}` : `写入 Obsidian 失败：${r.error}`;
    el.writeProgress.classList.toggle("fail-text", !r.ok);
    el.writeSettingsBtn.hidden = MdgErrors.action(r.code) !== "settings";
  }
}

// The 逐个视频笔记 index, the same in the vault and in the zip; only the link form differs. title: the run's folder.
function indexMarkdown(written, link, title) {
  const lines = [`# ${title}`, "", `${stamp(new Date(), false)} · ${written.length} 篇`, ""];
  for (const w of written) {
    lines.push(`- ${link(w.path, w.title)}${w.oneLiner ? ` ${oneLine(w.oneLiner)}` : ""}`);
  }
  return lines.join("\n");
}

// The zip's files: the index named after the folder, then each note under its vault filename (a repeat gets " (2)").
function zipNotes(base, written, title) {
  const used = new Set([`${base}.md`]);
  const notes = written.map((w) => {
    let path = w.filename;
    for (let i = 2; used.has(path); i++) path = w.filename.replace(/\.md$/, ` (${i}).md`);
    used.add(path);
    return { ...w, path };
  });
  return [{ name: `${base}.md`, text: indexMarkdown(notes, mdLink, title) }, ...notes.map((w) => ({ name: w.path, text: w.markdown }))];
}

// Obsidian itself unusable (obsidian.js obsidianError): every later note would fail alike, so the run stops.
const OBSIDIAN_CODES = new Set(["OBSIDIAN", "OBSIDIAN_DOWN"]);
// md: build the same notes but download them as a zip (one note each plus the index) instead of writing to the vault.
// The run keeps going with the dialog closed or another folder open: the activity pill shows it, the dialog reopens on it.
async function runWrite(md = false) {
  const items = writeScopeItems();
  const overwrite = el.writeOverwrite.checked;
  // Taken now: the index is named after this folder and lists these one-liners wherever the page is by then.
  const title = folderTitle();
  const oneLiners = Object.fromEntries(items.map((it) => [it.bvid, S.analyses[it.bvid]?.oneLiner]));
  clearWriteResult();
  if (el.banner.dataset.kind === "obsidian") el.banner.hidden = true;
  S.write = { md, mediaId: String(S.mediaId), text: "" };
  const written = [];
  const failed = [];
  // Notes written without their subtitle (字幕抓取失败) or with one that may not match the video: amber, like any
  // reminder that does not stop the run (DESIGN.md 琥珀), under the red failures.
  const warned = [];
  const showFailed = () => {
    el.writeFailed.innerHTML = [...failed.map((f) => `<li>${esc(f)}</li>`), ...warned.map((w) => `<li class="warn">${esc(w)}</li>`)].join("");
    el.writeFailed.hidden = !failed.length && !warned.length;
  };
  let obsidian = null; // the reply that showed Obsidian itself is unusable
  let indexPath = "";
  let i = 0;
  let index = false;
  const verb = md ? "生成" : "写入";
  const running = runs.run("write", {
    total: items.length,
    gap: S.settings.triageIntervalSec * 1000,
    line: (d, t) => `${verb}笔记 ${d}/${t}${runWhere(S.write)}`,
    finished: () => S.write.text && `${S.write.text}${runWhere(S.write)}`,
    // Obsidian closed, not set up or refusing the key fails every note alike: checked first, and such a failure ends the run.
    async plan() {
      if (md) return {};
      el.writeProgress.textContent = "正在检查 Obsidian…";
      const r = await send({ type: "triage-obsidian-check" });
      return r.ok ? {} : void (obsidian = r);
    },
    // Each video, then the vault's index (no gap before it) once every video is done.
    next() {
      if (i < items.length) return { it: items[i], i: i++ };
      if (md || index || !written.length) return null;
      return (index = { index: true, n: 0, gap: 0 });
    },
    act(s) {
      if (s.index) return send({ type: "triage-export", filename: `${safeNoteName(title)}.md`, markdown: indexMarkdown(written, wikiLink, title) });
      el.writeProgress.textContent = `${verb} ${s.i + 1}/${items.length}：${s.it.title}`;
      return send(md ? { type: "triage-build-note", bvid: s.it.bvid } : { type: "triage-write-note", bvid: s.it.bvid, overwrite });
    },
    // B站 risk control: wait as 粗看 / 细看 do, then the same video again.
    judge(r) {
      if (runs.hold(r)) {
        el.writeProgress.textContent = `${runs.hold(r).label}，等待后重试：${items[i - 1].title}`;
        return "wait";
      }
      return r.ok ? "ok" : OBSIDIAN_CODES.has(r.code) ? "stop" : "item";
    },
    done(s, r) {
      if (s.index) indexPath = r.ok ? r.data?.path || "" : (failed.push(`索引：${r.error}`), "");
      else if (r.ok) {
        written.push({ ...r.data, bvid: s.it.bvid, oneLiner: oneLiners[s.it.bvid] });
        if (r.data?.subtitleWarning) warned.push(`${s.it.title}：${r.data.subtitleWarning}`), showFailed();
      }
      else {
        failed.push(`${s.it.title}：${r.error}`);
        showFailed();
      }
    }
  });
  renderWriteScope();
  const run = await running;
  if (run.error) obsidian = { error: run.error, code: run.code };
  if (md && written.length) {
    const base = safeNoteName(title);
    indexPath = `${base}.zip`;
    MdgDownload.text(indexPath, zipStored(zipNotes(base, written, title)), "application/zip");
  }
  const skipped = written.filter((w) => w.skipped).length;
  const aiUpdated = written.filter((w) => w.aiUpdated).length;
  const counts = [
    `${md ? "下载" : "写入"} ${written.length - skipped} 篇`,
    skipped ? `已存在跳过 ${skipped} 篇` : "",
    aiUpdated ? `其中更新 AI 问答 ${aiUpdated} 篇` : "",
    failed.length ? `失败 ${failed.length} 篇` : ""
  ].filter(Boolean);
  el.writeProgress.textContent = [
    obsidian ? `写入 Obsidian 失败：${obsidian.error}。已停止` : run.stopped ? "已停止。" : "完成。",
    ...counts,
    indexPath ? `${md ? "文件" : "索引"}：${indexPath}` : ""
  ].filter(Boolean).join(" · ");
  el.writeProgress.classList.toggle("fail-text", Boolean(obsidian));
  const toSettings = MdgErrors.action(obsidian?.code) === "settings";
  el.writeSettingsBtn.hidden = !toSettings;
  showFailed();
  // The pill's green line; an Obsidian failure goes to the red banner instead, with 去设置 unless Obsidian is just not running.
  if (obsidian) showBanner(`写入 Obsidian 失败：${obsidian.error}`, toSettings ? "去设置" : "", () => send({ type: "open-options" }), "obsidian");
  else S.write.text = `逐个视频笔记${run.stopped ? "已停止" : "完成"}：${counts.join(" · ")}`;

  renderWriteScope();
  renderStatus();
}

// ---------- data export ----------
// 待播 stays out: a list to watch from, not something to keep.
const { triageSnapshotPrefix: SNAPSHOT, triageTitlePrefix: TITLE, triageAnalysisPrefix: ANALYSIS } = KEYS;
const BACKUP_PREFIXES = [K.kept, K.removed, K.left, K.tags, K.folderCriteria, K.videoTags, K.notes, SNAPSHOT, "triage_decisions_", TITLE, ANALYSIS];

async function buildBackup() {
  const all = await chrome.storage.local.get(null);
  const out = {
    app: "moondigest",
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest?.().version || "",
    settings: {
      triageIntervalSec: S.settings.triageIntervalSec,
      triageAiBatchSize: aiBatchSize()
    },
    tags: [],
    folderCriteria: {}, // mediaId → 判断标准
    videoTags: {},
    notes: {},
    folders: {},
    titleResults: {},
    analyses: {}
  };
  const folder = (id) =>
    (out.folders[id] ||= { title: S.allFolders.find((f) => String(f.id) === id)?.title || "", snapshot: null, decisions: {} });
  for (const [k, v] of Object.entries(all || {})) {
    if (!BACKUP_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (k === K.tags) out.tags = v;
    else if (k === K.kept) out.kept = v;
    else if (k === K.removed) out.removed = v;
    else if (k === K.left) out.left = v;
    else if (k === K.folderCriteria) out.folderCriteria = v;
    else if (k === K.videoTags) out.videoTags = v;
    else if (k === K.notes) out.notes = v;
    else if (k.startsWith(SNAPSHOT)) folder(k.slice(SNAPSHOT.length)).snapshot = v;
    else if (k.startsWith("triage_decisions_")) folder(k.slice(17)).decisions = v;
    else if (k.startsWith(TITLE)) out.titleResults[k.slice(TITLE.length)] = v;
    else if (k.startsWith(ANALYSIS)) out.analyses[k.slice(ANALYSIS.length)] = v;
  }
  // 关注's own data (UP tags, who has which, 已取消关注, the last AI batch); its copies of B站 data come back on 刷新.
  out.follow = {};
  for (const k of ["follow_tags", "follow_tag_map", "follow_unfollowed", "follow_ai_recent", "follow_ai_history"]) if (all?.[k] !== undefined) out.follow[k.slice(7)] = all[k];
  return out;
}


function buildCsv() {
  const title = folderTitle();
  const header = ["收藏夹", "BV 号", "标题", "UP 主", "时长", "链接", "封面", "发布时间", "收藏时间", "简介", "AI 判断", "判断来源", "理由", "一句话", "要点", "标签", "备注", "我的处理", "处理时间", "是否失效", "原在", "离开原因"];
  const rows = [header];
  for (const it of S.items) {
    const v = verdictOf(it);
    const a = S.analyses[it.bvid];
    const done = a?.status === "done";
    const d = S.decisions[it.bvid];
    rows.push([
      it.folders ? folderNames(it) : title,
      it.bvid,
      it.title,
      it.upper,
      fmtDuration(it.duration),
      videoUrl(it.bvid),
      it.cover || "",
      fmtDate(it.pubdate),
      fmtDate(it.favTime),
      it.intro || "",
      v.verdict === "none" ? "" : verdictLabel(v.verdict),
      ["", "标题粗看", "字幕细看"][v.stage] || "",
      v.reason,
      done ? a.oneLiner || "" : "",
      done ? (a.points || []).join(" | ") : "",
      tagIdsOf(it.bvid).map((id) => tagById(id).name).join("、"),
      S.notes[it.bvid]?.text?.trim() || "",
      d ? (d.action === "unfav" ? "取消收藏" : "保留") : "",
      d ? fmtTime(d.at) : "",
      it.invalid ? "是" : "否",
      (it.from || []).map((f) => f.title).join("、"),
      it.removedAt ? leftText(it) : ""
    ]);
  }
  return UI.toCsv(rows);
}

// ---------- events ----------
function bindEvents() {
  el.sortBox.addEventListener("change", (e) => {
    if (e.target.matches("[data-sort]")) setSort(e.target.value, SORT_DIR[e.target.value]);
  });
  el.sortBox.addEventListener("click", (e) => {
    if (!e.target.closest("[data-sort-dir]")) return;
    const { sort, dir } = sortOf();
    setSort(sort, dir === "asc" ? "desc" : "asc");
  });
  el.folderSelect.addEventListener("change", () => openFolder(el.folderSelect.value));
  // A cover that fails to load leaves the colored tint behind it.
  for (const box of [el.folderList, el.folderHead]) box.addEventListener("error", (e) => e.target.remove?.(), true);
  el.folderList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-folder]");
    if (btn && btn.dataset.folder !== String(S.mediaId)) openFolder(btn.dataset.folder);
  });
  el.refreshBtn.addEventListener("click", () => {
    if (S.seenCfg.on) seenSync(true);
    if (inFolderView() && fav.state().writing(S.mediaId)) toast("这个收藏夹正在批量修改，结束后自动刷新");
    S.mediaId === ALL ? refreshAll() : S.mediaId === REMOVED ? openFolder(REMOVED) : S.mediaId && syncFolder({ force: true });
  });
  const autoSync = () => {
    if (S.mediaId && S.mediaId !== ALL && S.mediaId !== REMOVED && document.visibilityState === "visible") quickSync();
  };
  window.addEventListener("focus", autoSync);
  document.addEventListener("visibilitychange", autoSync);

  const showTab = (tab) => {
    if (tab !== S.tab) S.selected.clear();
    S.tab = tab;
    S.focused = "";
    el.list.scrollTop = 0;
    render();
  };
  el.tabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab]");
    if (btn) showTab(btn.dataset.tab);
    const kind = e.target.closest("[data-kindtab]");
    if (kind) {
      S.kindFilter = kind.dataset.kindtab;
      S.selected.clear(); // a selection belongs to its tab
      render();
    }
  });
  UI.bindSearch(el.searchInput, (q) => {
    S.query = q;
    // A search that hides the focused card starts the focus at the top.
    const f = S.itemMap.get(S.focused);
    if (!f || !passFilter(f)) S.focused = "";
    render();
  });
  // Row 3: one pick per group, a second click clears it; 全部 clears the whole row (not row 4's tags).
  el.classFilter.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    e.stopPropagation();
    if (b.matches("[data-airecent-done]")) endAiRecent();
    else if (b.matches("[data-states-all]")) pickState("all");
    else if (b.dataset.classFilter) pickState("class", b.dataset.classFilter);
    else if (b.matches("[data-finishedfilter]")) pickState("seen");
    else if (b.matches("[data-dupfilter]")) pickState("dup");
    else if (b.dataset.kindfilter) pickState("kind", b.dataset.kindfilter);
    else if (b.matches("[data-airecent]")) pickState("recent");
    else return;
    render();
  });
  el.tagFilter.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tagfilter]");
    if (!btn) return;
    const ids = btn.dataset.tagfilter.split(",");
    const on = ids.some((id) => S.tagFilter.has(id));
    for (const id of ids) on ? S.tagFilter.delete(id) : S.tagFilter.add(id);
    render();
  });

  const onHeadClick = (e) => {
    const btn = e.target.closest("[data-head]");
    if (!btn) return;
    const act = btn.dataset.head;
    if (act === "tags") openAi();
    else if (act === "aiOther") openFolder(otherAiFolder()).then(openAi);
    else if (act === "stage1") {
      if (!runs.get("stage1")) {
        const list = stage1Pending();
        return startJudging("标题粗看", "粗看", list, () => runStage1(list));
      }
      runs.stop("stage1");
      render();
    } else if (act === "group") {
      if (S.group) {
        runs.stop("group");
        return render();
      }
      // The batch stays selected, as with 标题粗看; its cards leave the selection when they leave the tab.
      const batch = nextBatch();
      startJudging("字幕细看", "细看", batch.map((b) => S.itemMap.get(b)), () => startGroup(batch));
    } else if (act === "batch-unfav") fav.unfavMany(batchList(btn.dataset.verdict || null));
    else if (act === "batch-keep") batchKeep(batchList(btn.dataset.verdict || null));
    else if (act === "criteria") openCriteria();
    else if (act === "write") stopWrite();
    else if (act === "fav") W.stop();
    else if (act === "redo-coarse") {
      const list = redoCoarseList();
      startJudging("按新标准重新粗看", "重新粗看", list, () => runStage1(list, true));
    } else if (act === "redo-fine") {
      const list = redoFineList();
      startJudging("按新标准重新细看", "重新细看", list, () => startGroup(list.map((it) => it.bvid), true));
    }
    else if (act === "sel-tags") openPicker(visibleSelected().map((it) => it.bvid));
    else if (act === "all-pause") {
      S.loadAll.paused = true;
      render();
    } else if (act === "all-resume") {
      S.loadAll.paused = false;
      runLoadAll(S.folderToken);
    }
    else if (act === "clean-removed") cleanRemoved(visibleItems());
    else if (act === "clean-selected") cleanRemoved(selectedIn(visibleItems()));
    else if (act === "transfer") fav.transfer(transferList());
    else if (act === "select-all") {
      UI.toggleAll(visibleItems().map((it) => it.bvid), S.selected);
      render();
    } else if (act === "clear-selected") {
      S.selected.clear();
      render();
    }
  };
  // listHeader is inside stagebar; binding both would handle one bubbling click twice.
  el.stagebar.addEventListener("click", onHeadClick);
  el.activity.addEventListener("click", onHeadClick);

  el.list.addEventListener("click", (e) => {
    if (e.target.closest("[data-pick-folders]")) return openSettings(false, true);
    if (e.target.closest("[data-refresh]")) return el.refreshBtn.click();
    const refav = e.target.closest("[data-refav]");
    if (refav) return fav.refav(refav.dataset.refav);
    const refavAll = e.target.closest("[data-refav-batch]");
    if (refavAll) return fav.refavBatch(Number(refavAll.dataset.refavBatch));
    const picked = e.target.closest(".card[data-bvid]");
    if (picked && UI.cardPickClick(e)) {
      e.preventDefault();
      if (e.shiftKey) getSelection().removeAllRanges();
      setFocus(picked.dataset.bvid, false);
      pickAnchor = UI.pickCard(S.selected, visibleItems().map((it) => it.bvid), picked.dataset.bvid, pickAnchor, e.shiftKey);
      return showPicks();
    }
    const clean = e.target.closest("[data-clean]");
    if (clean) return cleanRemoved([S.itemMap.get(clean.dataset.clean)].filter(Boolean));
    if (e.target.closest("[data-retry-failed]")) return retryFailed();
    const card = e.target.closest(".card");
    if (!card) return;
    if (e.target.closest("a[href]")) {
      if (!plainClick(e)) return;
      e.preventDefault();
    }
    const bvid = card.dataset.bvid;
    const untag = e.target.closest("[data-untag]");
    if (untag) return removeVideoTag(bvid, untag.dataset.untag);
    const act = e.target.closest("[data-act]")?.dataset.act;
    setFocus(bvid, false);
    if (act) cardAction(act, bvid);
    else if (UI.cardPlayClick(e)) cardAction("open", bvid);
  });

  // The pointer makes a card current only when the hand moves it. A mousemove at the same position comes from the
  // list scrolling (J/K, wheel) or re-rendering under a still pointer and must not steal the keyboard's current card.
  let pointerAt = null;
  el.list.addEventListener("mousemove", (e) => {
    if (!pointerMoved(pointerAt, e.clientX, e.clientY)) return;
    pointerAt = { x: e.clientX, y: e.clientY };
    const bvid = e.target.closest(".card")?.dataset.bvid;
    if (bvid && bvid !== S.focused) setFocus(bvid, false);
  });

  // A note saves 400 ms after typing stops, but never mid-IME: compositionend saves the committed text.
  const noteEdit = (e) => {
    if (!e.target.matches("[data-note]")) return;
    const b = e.target.closest(".card").dataset.bvid;
    const text = e.target.value.trim();
    if (text) S.notes[b] = { text: e.target.value, updatedAt: Date.now() };
    else delete S.notes[b];
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      noteTimer = 0;
      storeSet(K.notes, S.notes);
    }, 400);
  };
  el.list.addEventListener("input", (e) => !e.isComposing && noteEdit(e));
  el.list.addEventListener("compositionend", (e) => {
    noteEdit(e);
    if (listDeferred) setTimeout(renderList);
  });
  // Enter (or Esc) saves now and leaves the note so card keys work again; Shift+Enter is a newline. Never mid-IME.
  el.list.addEventListener("keydown", (e) => {
    if (composing(e) || !e.target.matches("[data-note]")) return;
    if (!(e.key === "Escape" || (e.key === "Enter" && !e.shiftKey))) return;
    e.preventDefault();
    if (noteTimer) {
      clearTimeout(noteTimer);
      noteTimer = 0;
      storeSet(K.notes, S.notes);
    }
    e.target.blur();
  });
  // An emptied note folds back to 「+ 备注」.
  el.list.addEventListener("focusout", (e) => {
    if (!e.target.matches("[data-note]") || e.target.value.trim()) return;
    S.noteOpen.delete(e.target.closest(".card").dataset.bvid);
    setTimeout(renderList);
  });

  document.addEventListener("keydown", onKey);
  el.viewerCloseBtn.addEventListener("click", closeViewer);
  // The open folder's own Bilibili page; 所有收藏夹 and 已出分拣范围 have none, so they go to the space page.
  el.biliBtn.addEventListener("click", () =>
    openTab(
      S.mediaId === TOVIEW
        ? "https://www.bilibili.com/watchlater/list"
        : `https://space.bilibili.com/${S.mid}${inFolderView() ? `/favlist?fid=${S.mediaId}&ftype=create` : ""}`
    )
  );

  el.settingsBtn.addEventListener("click", () => openSettings());
  for (const input of [el.thinkingInput, el.titleMaxInput, el.analyzeMaxInput]) {
    input.addEventListener("input", renderTokenHints);
  }
  el.settingsDialog.addEventListener("click", (e) => {
    const all = e.target.closest("[data-folders-all]");
    if (!all && !e.target.closest("[data-folders-none]")) return;
    for (const box of el.folderToggles.querySelectorAll("input")) box.checked = Boolean(all);
  });
  el.settingsDialog.addEventListener("close", async () => {
    if (el.settingsDialog.returnValue !== "save") return;
    const patch = {
      triageIntervalSec: intervalSetting(el.intervalInput.value),
      triageCoarseBatchSize: intSetting(el.coarseBatchInput.value, 1, 1000, 100),
      triageFineBatchSize: intSetting(el.fineBatchInput.value, 1, 50, 10),
      triageThinking: el.thinkingInput.checked,
      triageTitleMaxTokens: Number(el.titleMaxInput.value) || 0,
      triageAnalyzeMaxTokens: Number(el.analyzeMaxInput.value) || 0,
      triageTagLimit: Math.max(1, Math.min(50, Math.floor(Number(el.tagLimitInput.value)) || 10)),
      triageAiNewTagMax: el.aiNewTagMaxInput.value === "" ? 5 : Math.max(0, Math.min(50, Math.floor(Number(el.aiNewTagMaxInput.value)) || 0)),
      triageAiRemoveTags: el.aiRemoveTagsInput.checked
    };
    const triageAiBatchSize = intSetting(el.aiBatchInput.value, 1, 100, 30);
    const r = await send({ type: "triage-settings-save", ...patch });
    // The background's settings do not know this key; it is stored here, beside them in chrome.storage.sync.
    const saved = r.ok && (await chrome.storage.sync.set({ triageAiBatchSize }).then(() => true, (e) => ((r.error = e.message), false)));
    if (!saved) {
      toast(`保存设置失败：${r.error}`, true);
      return;
    }
    Object.assign(S.settings, patch, { triageAiBatchSize });
    renderTagLimit();
    toast("设置已保存");
    const included = [...el.folderToggles.querySelectorAll("input:checked")].map((x) => x.value);
    // 稍后再看 had no checkbox (its read failed): its choice stays as it was.
    if (S.toviewUnread && S.included.includes(TOVIEW)) included.push(TOVIEW);
    const same = included.length === S.included.length && included.every((id) => S.included.includes(id));
    if (S.allFolders.length && !same) {
      await storeSet(K.included, included);
      await applyIncluded(included);
    }
  });
  el.writeBtn.addEventListener("click", () => openWrite());
  el.writeScope.addEventListener("change", renderWriteScope);
  el.writeFormat.addEventListener("change", renderWriteScope);
  const digest = () => el.writeFormat.value === "digest";
  el.writeCopyBtn.addEventListener("click", () => exportDigest("copy"));
  el.writeRunBtn.addEventListener("click", () => (digest() ? exportDigest("obsidian") : runWrite()));
  el.writeMdBtn.addEventListener("click", () => (digest() ? exportDigest("download") : runWrite(true)));
  el.writeStopBtn.addEventListener("click", stopWrite);
  el.writeSettingsBtn.addEventListener("click", () => send({ type: "open-options" }));
  el.openOptionsBtn.addEventListener("click", () => send({ type: "open-options" }));
  // Both modes' 导出 menus carry the same 完整备份 item.
  document.addEventListener("click", async (e) => {
    if (!e.target.closest("[data-backup]")) return;
    try {
      MdgDownload.text(`MoonDigest备份-${stamp()}.json`, JSON.stringify(await buildBackup(), null, 2), "application/json");
    } catch (err) {
      toast(`导出备份失败：${err.message}`, true);
    }
  });
  el.csvBtn.addEventListener("click", () => {
    const title = folderTitle().replace(/[\\/:*?"<>|]/g, "_");
    MdgDownload.text(`MoonDigest-${title}-${stamp(new Date(), false)}.csv`, buildCsv(), "text/csv;charset=utf-8");
  });
  el.helpBtn.addEventListener("click", () => el.helpDialog.showModal());
  // A download leaves the page as it was, so the 导出 menu would stay open over it.
  el.tools.addEventListener("click", (e) => e.target.closest("button") && el.tools.hidePopover());
  document.querySelector("[data-open-settings]")?.addEventListener("click", () => openSettings());
  el.toast.addEventListener("click", () => (el.toast.hidden = true));

  UI.bindSync(syncEls());
  el.bannerClose.addEventListener("click", () => (el.banner.hidden = true));

  el.viewerTags.addEventListener("click", (e) => e.target.closest("[data-vtag]") && tagPlaying());
  // T / Esc pressed while focus is in the player (viewer-frame.js): the one listener for both modes, as onKey is. 关注 takes
  // them through modeKeys; in 收藏夹, T tags the playing video and Esc closes the player, unless a dialog is open.
  // The same listener takes the video the player shows now: B站's autoplay may have moved on (viewer-frame.js).
  window.addEventListener("message", (e) => {
    const b = e.source === el.viewerFrame.contentWindow && e.origin === "https://www.bilibili.com" && e.data?.type === "mdg-viewer-video" && e.data.bvid;
    if (b) {
      if (!S.viewing || typeof b !== "string" || !/^BV\w+$/.test(b) || b === S.viewing) return;
      viewerPast = [...viewerPast, ...(S.viewer?.folders || [])];
      return showViewing(b);
    }
    const key = UI.viewerKeyFrom(e, el.viewerFrame.contentWindow);
    if (!key || modeKeys?.(key, e) != null || document.querySelector("dialog[open]")) return;
    if (key === "Escape") closeViewer();
    else tagPlaying();
  });

  el.criteriaInput.addEventListener("keydown", (e) => {
    if (composing(e) || e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    el.criteriaDialog.close("save");
  });
  el.criteriaDialog.addEventListener("close", () => {
    if (el.criteriaDialog.returnValue === "save") saveCriteria();
  });
  el.aiTagSlot.addEventListener("click", (e) => {
    if (e.target.closest("[data-tags-manage]")) openManage();
    else if (e.target.closest("[data-ai-tag]")) openAi();
  });

  // basket
  el.basketToggle.addEventListener("click", () => setBasketOpen(el.basket.classList.contains("collapsed")));
  el.basketClearBtn.addEventListener("click", clearBasket);
  el.basketList.addEventListener("click", (e) => {
    const act = e.target.closest("[data-basket]")?.dataset.basket;
    if (!act) return;
    const i = Number(e.target.closest(".basket-item").dataset.i);
    if (act === "open") openBasketItem(i);
    else if (act === "remove") {
      removeBasketItems([i]);
      toast("已从待播移除 · U 撤销");
    }
  });
}

// The tag caps are written into the help dialog's static hints.
function renderTagLimit() {
  for (const node of document.querySelectorAll("[data-tag-limit]")) node.textContent = tagLimit();
  for (const node of document.querySelectorAll("[data-ai-new-tag-max]")) node.textContent = S.settings.triageAiNewTagMax;
}

function renderTokenHints() {
  const batch = TITLES_PER_REQUEST;
  const on = el.thinkingInput.checked;
  const titleAuto = on ? 150 * batch + 4000 : 60 * batch + 200;
  const analyzeAuto = on ? 8000 : 1000;
  el.titleMaxHint.textContent = `留空 = 自动（${titleAuto}），被截断时再调大。`;
  el.analyzeMaxHint.textContent = `留空 = 自动（${analyzeAuto}）`;
}

// firstRun: the first open, before any folder is chosen, asks only for folders.
function openSettings(scrollToLimits = false, firstRun = false) {
  el.settingsHeading.textContent = firstRun ? "选择要分拣的收藏夹" : "收藏夹设置";
  el.settingsAi.hidden = firstRun;
  el.settingsFoldersHeading.hidden = firstRun;
  el.settingsFirstRunHint.hidden = !firstRun;
  el.folderToggles.innerHTML = S.allFolders
    .map((f) => `<label class="toggle"><input type="checkbox" name="includedFolder" value="${esc(f.id)}"${S.included.includes(String(f.id)) ? " checked" : ""} /> ${esc(f.title)} <span class="muted">${esc(f.count)}</span></label>`)
    .join("") || `<p class="dialog-hint">收藏夹列表还没加载</p>`;
  el.thinkingRow.hidden = !hasThinkingToggle();
  el.intervalInput.value = S.settings.triageIntervalSec ?? 8;
  el.coarseBatchInput.value = coarseBatchSize();
  el.fineBatchInput.value = fineBatchSize();
  el.aiBatchInput.value = aiBatchSize();
  el.thinkingInput.checked = Boolean(S.settings.triageThinking);
  el.titleMaxInput.value = S.settings.triageTitleMaxTokens || "";
  el.analyzeMaxInput.value = S.settings.triageAnalyzeMaxTokens || "";
  el.tagLimitInput.value = tagLimit();
  el.aiNewTagMaxInput.value = S.settings.triageAiNewTagMax;
  el.aiRemoveTagsInput.checked = S.settings.triageAiRemoveTags === true;
  renderTokenHints();
  el.settingsDialog.returnValue = "";
  el.settingsDialog.showModal();
  if (scrollToLimits) el.titleMaxInput.scrollIntoView({ block: "center" });
}

// it.url: another B站 page in its place (an UP's space, with bvid its own key).
function openViewer(it) {
  viewerPast = [];
  el.viewerFrame.src = it.url || videoUrl(it.bvid);
  el.viewer.hidden = false;
  el.main.classList.add("viewing");
  showViewing(it.bvid);
}

// The folders of videos played earlier in this viewer (B站's autoplay moved on): closing refreshes them too.
let viewerPast = [];

// The viewer now shows b: the pink card, its tag lines and T follow it. A video in no chosen folder has no lines.
function showViewing(b) {
  S.viewing = b;
  const own = viewerOf(b);
  S.viewer = own;
  render();
  // A 待播 video from a folder not open (or one played in 关注): its folders are the chosen ones whose cached list holds it.
  if (!own) {
    viewerHome(b).then((v) => {
      if (S.viewing !== b || !v) return;
      S.viewer = v;
      renderViewerTags();
    });
  }
}

// S.viewer for a video of the open view; null when it is not in it.
function viewerOf(b) {
  return S.itemMap.has(b) ? { item: S.itemMap.get(b), folders: S.mediaId === REMOVED ? null : pickerFolders(b) } : null;
}
async function viewerHome(bvid) {
  const ids = S.folders.map((f) => String(f.id));
  const got = await chrome.storage.local.get(ids.map(K.snapshot));
  const folders = ids.filter((id) => got[K.snapshot(id)]?.items?.some((x) => x.bvid === bvid));
  return folders.length ? { item: got[K.snapshot(folders[0])].items.find((x) => x.bvid === bvid), folders } : null;
}

function setBasketOpen(open) {
  el.basket.classList.toggle("collapsed", !open);
  el.basketToggle.setAttribute("aria-expanded", String(open));
}

// Likes, coins and favorites happen on Bilibili's own page, so the folder is re-read once the viewer closes.
// Only the video's own folder, when it is the one open; another folder checks its list when it is opened.
function closeViewer() {
  if (!S.viewing) return;
  const home = [...(S.viewer?.folders || []), ...viewerPast];
  S.viewing = "";
  S.viewer = null;
  el.viewerFrame.src = "about:blank";
  el.viewer.hidden = true;
  el.main.classList.remove("viewing");
  render();
  if (inFolderView() && !followMode() && home.includes(String(S.mediaId))) quickSync({ force: true });
}

function cardAction(act, bvid) {
  const it = S.itemMap.get(bvid);
  if (!it) return;
  if (act === "open") openViewer(it);
  else if (act === "ask") askAi(it);
  else if (act === "unfav") fav.unfav(bvid);
  else if (act === "keep") keepOne(bvid);
  else if (act === "tag") openPicker(bvid);
  else if (act === "basket") toggleBasket(bvid);
  else if (act === "retry") retry(bvid);
  else if (act === "note") {
    S.noteOpen.add(bvid);
    renderList();
    el.list.querySelector(`.card[data-bvid="${CSS.escape(bvid)}"] [data-note]`)?.focus();
  }
  else if (act === "select") {
    pickAnchor = UI.pickCard(S.selected, [], bvid);
    showPicks();
  }
}

// A pick changes only the cards' blue marks, the selection bar and the failed group's 重试, so the list is not rebuilt;
// in 粗看完成 the selection is the next batch (its order and labels), so that tab draws everything again.
function showPicks() {
  if (S.tab === "coarse") return render();
  for (const card of el.list.querySelectorAll(".card[data-bvid]")) card.classList.toggle("selected", S.selected.has(card.dataset.bvid));
  const list = visibleItems();
  const head = el.list.querySelector(".group-head");
  if (head) head.outerHTML = failedHeadHtml(list.filter((it) => failedIn(S.tab, it)));
  renderListHeader(list);
}

function onKey(e) {
  if (composing(e) || typingIn(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if ((e.key === "Enter" || e.key === " ") && t.closest?.("button, a")) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // Before the open-dialog check: the mode decides which of its dialogs own the keys.
  const used = modeKeys?.(key, e);
  if (used != null) return used && e.preventDefault();
  if (document.querySelector("dialog[open]")) return;
  const map = {
    "?": () => el.helpDialog.showModal(),
    "/": () => el.searchInput.focus(),
    i: () => (aiTagReason() ? toast(aiTagReason()) : openAi())
  };
  const nav = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };
  const cardKeys = { d: "unfav", s: "keep", t: "tag", e: "basket", q: "ask", x: "select", o: "open", Enter: "open" };
  if (key === "Escape" && S.viewing) closeViewer();
  // Esc with nothing else open clears the selection, so cards play on a click again.
  else if (key === "Escape" && S.selected.size && !document.querySelector(":popover-open")) {
    S.selected.clear();
    render();
  } else if (map[key]) map[key]();
  else if (nav[key]) moveFocus(nav[key]);
  else if (key === "u") undo();
  // 已出分拣范围 has no 保留 / 取消收藏 / 标签; 待播, 问 AI, X, O / Enter (play, like a title click) and U work there
  // (X picks for 清理 and 收藏到).
  else if (S.mediaId === REMOVED && !["e", "q", "x", "o", "Enter"].includes(key)) return;
  else if (cardKeys[key] && S.focused) cardAction(cardKeys[key], S.focused);
  else return;
  e.preventDefault();
}
