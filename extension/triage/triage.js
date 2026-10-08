// Static-server preview only: load the fake chrome.* before anything reads it. Never fetched inside the extension.
if (!globalThis.chrome?.runtime?.id) await import("./dev/mock-chrome.js");

// ---------- constants ----------
const THROTTLE_MS = globalThis.__TRIAGE_THROTTLE_MS || 10 * 60 * 1000;
// Error code -> [backoff ms, status label]. AI 429s clear far sooner than B站 risk control.
const THROTTLES = { THROTTLED: [THROTTLE_MS, "B站限流"], AI_THROTTLED: [60 * 1000, "AI 平台限流"] };
const GROUP_SIZE = 10;
const SYNC_MIN_GAP_MS = 60 * 1000;
// Progress tabs: how far a video has been looked at. The AI class is a filter inside a tab, never a tab.
// 阅览 sits apart after them.
const STAGES = [
  ["none", "未分析"],
  ["coarse", "粗看完成"],
  ["fine", "细看完成"],
  ["done", "处理完成"]
];
const K = {
  lastFolder: "triage_last_folder",
  tags: "triage_tags", // [{ id, name, color, folder, rule? }]: folder is the mediaId the tag belongs to; rule is the one line the AI follows
  folderCriteria: "triage_folder_criteria", // { [mediaId]: 判断标准 }
  simplified: "triage_simplified_v1",
  tagsByFolder: "triage_tags_by_folder_v1",
  videoTags: "triage_video_tags",
  basket: "triage_basket",
  notes: "triage_notes", // { [bvid]: { text, updatedAt } }, shared with the history page and note export
  decisions: (id) => `triage_decisions_${id}`, // 取消收藏 only: it changes one Bilibili folder
  kept: "triage_kept", // { [bvid]: { action: "keep", at } }: 保留 belongs to the video, so it shows in every folder
  keptMigrated: "triage_kept_v1",
  removed: "triage_removed", // { [bvid]: { item, at, movedTo?, hidden?, inFolder?: { id, title } | null, from?: [{ id, title, at }] } }: videos that left every folder, kept until the user cleans them
  left: "triage_left", // { [bvid]: { [folderId]: { title, at } } }: folders a video left while still in another chosen one; becomes the record's from
  included: "triage_included_folders", // [mediaId]: the folders the user chose; only these are listed and read
  snapshot: (id) => `triage_snapshot_${id}`,
  aiHistory: "triage_ai_command_history",
  sort: "triage_sort", // { [mediaId]: { sort, dir } }: each folder's card order; none = 收藏时间 新→旧
  aiRecent: "triage_ai_recent" // { [mediaId]: { at, bvids } }: 「AI 刚打的」, the videos the last applied 批量打 changed
};
// 「AI 刚打的」: the videos the last applied 批量打 changed in a folder, to look over on their cards. Only these end it.
const AI_RECENT_RULES = ["点 ×：不再标出，标签不变", "再让 AI 打一次：换成新的一批"];
const AI_RECENT_UNDO = "按 U 撤销这次 AI 打标签前会先问你；确认后这批视频的标签都回到 AI 打之前，包括你之后又改过的。";
const ALL = "all"; // the 所有收藏夹 view's folder-select value
const REMOVED = "removed"; // the 已出分拣范围 view
const TOVIEW = "toview"; // 稍后再看, listed by triage-bg as one more folder
// The fixed AI classes, shown as chips inside 粗看完成 and 细看完成.
// The ids are the badge color classes too.
const VERDICTS = { keep: "值得留", drop: "可清理", unsure: "拿不准" };

// One-time fold of the old schemes (triage_schemes + triage_folder_scheme) into per-folder 判断标准 and one tag list (pure).
// Each folder seen in triage gets its scheme's criteria (unmapped = the default scheme's) when non-empty; folders never
// opened in triage start empty. Tags: the default scheme's, plus other schemes' tags some video uses; same name → the
// first id wins and video tags are remapped to it. Without schemes, the pre-scheme triage_tags and global criteria carry over.
function simplifyMigration({ schemes, folderScheme, tags, videoTags, criteria, folderIds = [], folderCriteria }) {
  const list = Array.isArray(schemes) && schemes.length ? schemes : null;
  const def = list && (list.find((x) => x?.id === "default") || list[0]);
  const vt = videoTags || {};
  const fs = folderScheme || {};
  const used = new Set(Object.values(vt).flat());
  const candidates = list
    ? [...(def.tags || []), ...list.filter((x) => x !== def).flatMap((x) => (x?.tags || []).filter((t) => used.has(t?.id)))]
    : Array.isArray(tags) ? tags : [];
  const out = [];
  const remap = {};
  for (const t of candidates) {
    const name = String(t?.name ?? "").trim();
    if (!name || !t.id || out.some((x) => x.id === t.id)) continue;
    const kept = out.find((x) => x.name === name);
    if (kept) remap[t.id] = kept.id;
    else out.push({ id: t.id, name, color: t.color || UI.TAG_COLORS[out.length % UI.TAG_COLORS.length] });
  }
  const nextVideoTags = Object.fromEntries(Object.entries(vt).map(([b, ids]) => [b, [...new Set(ids.map((id) => remap[id] || id))]]));
  const crit = {};
  for (const f of new Set([...folderIds.map(String), ...Object.keys(fs)])) {
    const text = String((list ? (list.find((x) => x?.id === fs[f]) || def).criteria : criteria) || "").trim();
    if (text) crit[f] = text;
  }
  return { tags: out, videoTags: nextVideoTags, folderCriteria: { ...crit, ...folderCriteria } };
}

const newTagId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

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

// A listed video counts as favorited again after our 取消收藏 only when Bilibili's favorite time (seconds) is not older
// than it: a list fetched before the 取消收藏, or lagging behind it, still holds the video with its old time. No favTime
// keeps the 取消收藏.
const refavorited = (it, dec) => (it.favTime || 0) * 1000 >= dec.at;

// 所有收藏夹 (pure): lists = [{ id, items, decisions }] in folder order. A video in several folders appears once with
// every folder id in .folders. A folder the video was unfavorited from no longer counts unless it was favorited there
// again since; a video left in no folder is dropped.
function mergeFolderItems(lists) {
  const map = new Map();
  for (const { id, items, decisions: d = {} } of lists) {
    for (const it of items) {
      const dec = d[it.bvid];
      if (dec?.action === "unfav" && !refavorited(it, dec)) continue;
      const m = map.get(it.bvid);
      if (m) m.folders.push(id);
      else map.set(it.bvid, { ...it, folders: [id] });
    }
  }
  return [...map.values()];
}

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

// 已出分拣范围 (pure): a folder's full new list replaces its old one. A video that left it and is in no other folder's
// list is recorded with its last known item and where it had been (its trail, then this folder); a video listed again
// is dropped from the record and this folder from its trail. One that left but is still in another chosen folder only
// gets this folder on its trail. One still in the folder's id list (ids) only stopped being listed: Bilibili hides a
// video that became invalid, so it is marked hidden.
function updateRemoved(removed, left, oldItems, newItems, otherBvids, at, ids, folder) {
  const next = { ...removed };
  const trail = { ...left };
  const now = new Set(newItems.map((it) => it.bvid));
  const stillThere = new Set(ids || []);
  for (const b of now) {
    delete next[b];
    forgetLeft(trail, b, folder.id);
  }
  for (const it of oldItems) {
    const b = it.bvid;
    if (now.has(b) || next[b]) continue;
    if (otherBvids.has(b)) {
      trail[b] = { ...trail[b], [folder.id]: { title: folder.title, at } };
      continue;
    }
    next[b] = { item: it, at, from: originOf(trail, b, folder, at) };
    if (stillThere.has(b)) next[b].hidden = true;
    delete trail[b];
  }
  return { removed: next, left: trail };
}
// 移动 to a folder outside triage (pure): like updateRemoved for the moved videos, with where they went. From 已出分拣范围
// itself (from null) the record keeps the origin it had.
function moveToRemoved(removed, left, items, otherBvids, from, at, movedTo) {
  const next = { ...removed };
  const trail = { ...left };
  for (const it of items) {
    if (otherBvids.has(it.bvid)) continue;
    next[it.bvid] = { item: it, at, movedTo, from: from ? originOf(trail, it.bvid, from, at) : removed[it.bvid]?.from };
    delete trail[it.bvid];
  }
  return { removed: next, left: trail };
}
// The folders a video left before (its trail), then the one it leaves now.
function originOf(left, bvid, folder, at) {
  const before = Object.entries(left[bvid] || {}).filter(([id]) => id !== folder.id).map(([id, e]) => ({ id, title: e.title, at: e.at }));
  return [...before, { id: folder.id, title: folder.title, at }];
}
// Records from before `from` existed: a 取消收藏 done here in folder X is a fact that the video was in X (pure).
function inferFrom(decisionsByFolder, bvid, titleOf) {
  const ids = Object.entries(decisionsByFolder).filter(([, d]) => d?.[bvid]?.action === "unfav").map(([id]) => id);
  return ids.length ? ids.map((id) => ({ id, title: titleOf(id) })) : undefined;
}
// Listed in this folder again: it never left it (mutates trail).
function forgetLeft(trail, bvid, folderId) {
  if (!trail[bvid]?.[folderId]) return;
  const { [folderId]: _, ...rest } = trail[bvid];
  if (Object.keys(rest).length) trail[bvid] = rest;
  else delete trail[bvid];
}

// A video that turns invalid comes back as Bilibili's placeholder; keep what was known about it before (pure).
function keepInvalidInfo(items, oldItems) {
  const old = new Map((oldItems || []).map((it) => [it.bvid, it]));
  return items.map((it) => {
    const o = it.invalid && old.get(it.bvid);
    return o ? { ...it, title: o.title || it.title, cover: o.cover || it.cover, upper: o.upper || it.upper, intro: o.intro || it.intro, duration: o.duration || it.duration } : it;
  });
}

// 所有收藏夹 (pure): a cached list is stale when the folder's current video ids differ from it as a set.
function idsChanged(cached, ids) {
  const have = new Set(cached);
  const now = new Set(ids);
  return have.size !== now.size || [...now].some((b) => !have.has(b));
}
// 切换收藏夹 (pure): the fetched newest pages, then the cached rest still in the folder's id list. null when an added id
// is in neither (moved in from deep in the list), so the caller loads the whole folder.
function mergeHead(head, cachedItems, oldIds, ids) {
  const now = new Set(ids);
  const inHead = new Set(head.map((it) => it.bvid));
  const items = [...head, ...cachedItems.filter((it) => now.has(it.bvid) && !inHead.has(it.bvid))];
  const got = new Set(items.map((it) => it.bvid));
  const old = new Set(oldIds);
  return ids.every((b) => old.has(b) || got.has(b)) ? items : null;
}
const unfavOnly = (d) => Object.fromEntries(Object.entries(d).filter(([, v]) => v?.action === "unfav"));

// ---------- state ----------
const S = {
  allFolders: [], // every folder on Bilibili
  folders: [], // the ones taking part in triage
  included: [],
  removedCheck: null, // 已出分拣范围 only: { done, total, what, error } while its folders, then its videos, are checked
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
  aiRecent: {},
  sortBy: {}, // triage_sort
  aiRecentFilter: false, // AI 刚打的
  kindFilter: "", // kindOf: "invalid" (已失效) anywhere; "unfav" / "out" in 已出分拣范围 only
  seenCfg: { on: false, bar: false, mark: false, threshold: 80, style: "badge" }, // 设置页「观看进度 → 封面显示」
  seenPct: {}, // bvid → [percent, view_at] from the history, null when it has none
  noteOpen: new Set(), // empty notes the user opened for editing
  settings: {
    triageIntervalSec: 8,
    triageTitleBatchSize: 30,
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
  focusIndex: 0,
  selected: new Set(),
  group: null, // the running 细看 batch: { bvids: [], stop: bool }
  write: { running: false, stop: false },
  stage1: { running: false, stop: false, done: 0, total: 0 },
  stage1Skip: new Set(),
  analyzing: new Set(),
  throttleUntil: 0,
  throttleLabel: "",
  undo: [],
  lastSyncAt: 0,
  readAt: {}, // mediaId → when its list was last read from B站, for 「今天 HH:MM 刷新过」
  syncError: "", // the open folder's last 刷新 failure; stays under the title until a read succeeds
  syncing: false,
  aiHistory: [],
  viewing: "",
  // One 批量打标签 run at a time (mediaId is its folder); it keeps going when another folder is opened. Each folder keeps
  // its own proposal, and proposal reads and writes the open folder's.
  ai: {
    running: false,
    stop: false,
    mediaId: "",
    // Tag ids greyed out in 批量打 for this opening of the dialog: not sent to the AI, never added, kept or removed.
    excluded: new Set(),
    proposals: {},
    get proposal() {
      return this.proposals[S.mediaId] || null;
    },
    set proposal(p) {
      if (p) this.proposals[S.mediaId] = p;
      else delete this.proposals[S.mediaId];
    }
  }
};

const criteria = () => S.folderCriteria[S.mediaId] || "";
// A 粗看 or 细看 result remembers the 判断标准 it was made under (loadResults stamps older ones with the folder's
// current one), so after the criteria change the old results can be redone.
const isStale = (r) => Boolean(r) && (r.criteria ?? criteria()) !== criteria();
const inFolderOnly = () => S.mediaId && S.mediaId !== ALL && S.mediaId !== REMOVED;
const staleCoarse = () => (inFolderOnly() ? S.items.filter((it) => !it.invalid && stageOf(it) === "coarse" && isStale(S.titleRes[it.bvid])) : []);
const staleFine = () => (inFolderOnly() ? S.items.filter((it) => stageOf(it) === "fine" && isStale(S.analyses[it.bvid])) : []);
// What the AI is told about the open folder; its 判断标准 is relative to this.
const folderContext = () => ({ title: folderTitle(), intro: S.folderIntro[S.mediaId] || "" });

const $ = (id) => document.getElementById(id);

const { composing, typingIn, bindLive } = globalThis.BocTyping;

const UI = globalThis.TriageUi;
const { esc, pad, fmtDate, fmtDuration, fmtCount, cleanTagName, plainClick, img } = UI;
// Row 2 and the sidebar foot are drawn by shared.js, as in 关注; here before el picks them up.
$("favRowTools").insertAdjacentHTML("beforeend", UI.searchBox("searchInput", "searchCount", "搜这个收藏夹") + UI.rowButtons({
  activityId: "activity", refreshId: "refreshBtn", refreshLabel: "从 B站刷新这个收藏夹", exportId: "exportBtn", menuId: "tools",
  menuHtml: UI.menuItem('id="writeBtn" aria-label="批量导出"', "批量导出…", "摘录，或逐个视频的笔记") + UI.menuItem('id="csvBtn" aria-label="下载这个收藏夹的表格 CSV"', "这个收藏夹的表格 (CSV)", "标题、AI 判断、标签、备注") + "<hr>" + UI.BACKUP_ITEM,
  settingsAttr: "data-open-settings", settingsLabel: "收藏夹设置"
}));
$("favSync").outerHTML = UI.syncPill("sync");
$("favSide").insertAdjacentHTML("beforeend", UI.sideFoot({ settingsAttrs: 'id="settingsBtn" aria-label="收藏夹设置"', settingsLabel: "收藏夹设置" }));
const REFRESH_EMPTY = `<button type="button" data-refresh>${UI.ICON.refresh}刷新</button>`;
const el = {};
[
  "folderSelect", "folderList", "folderHead", "settingsHeading", "settingsFoldersHeading", "settingsAi", "settingsFirstRunHint", "searchInput", "searchCount", "refreshBtn", "activity", "settingsBtn", "helpBtn",
  "banner", "bannerText", "bannerBtn", "bannerClose", "syncNotice", "syncText", "syncViewBtn", "syncCloseBtn", "syncDetail",
  "tabs", "stagebar", "sortBox", "classFilter", "tagFilter", "aiTagSlot", "listHeader", "list", "basket", "basketToggle", "basketCount",
  "basketList", "basketClearBtn", "toast", "settingsDialog", "folderToggles", "thinkingRow", "intervalInput",
  "batchSizeInput", "tagLimitInput", "aiNewTagMaxInput", "aiRemoveTagsInput", "aiFormRemoveTagsInput", "openOptionsBtn", "thinkingInput", "titleMaxInput",
  "titleMaxHint", "analyzeMaxInput", "analyzeMaxHint", "settingsError", "csvBtn", "confirmDialog",
  "confirmTitle", "confirmBody", "confirmOk", "transferDialog", "transferTitle", "transferBody", "transferTarget", "transferNewRow", "transferUnchosen", "transferHow", "transferName", "transferPrivate",
  "criteriaDialog", "criteriaTitle", "criteriaInput", "tagsDialog", "tagsModeManage", "tagsModeBatch", "tagsManage", "tagsRows", "newTagInput", "addTagBtn", "helpDialog",
  "aiForm", "aiScope", "aiScopeCount", "aiInstruction", "aiHistory",
  "aiTagsPreview", "aiProgress", "aiCloseBtn", "aiStopBtn", "aiRunBtn",
  "aiReview", "aiReviewSummary", "aiNotes", "aiNewTagsHead", "aiNewTags", "aiRows", "aiRecentRules", "aiRecentUndo", "aiDiscardBtn", "aiApplyBtn",
  "biliBtn", "main", "viewer", "viewerTitle", "viewerNextBtn", "viewerFocusBtn", "viewerTabBtn", "viewerCloseBtn", "viewerFrame", "viewerTags",
  "tools", "writeBtn", "writeDialog", "writeScope", "writeFormat", "writeScopeCount", "writeOverwriteRow", "writeOverwrite", "writeProgress", "writeFailed", "writeStopBtn", "writeCopyBtn", "writeRunBtn", "writeMdBtn"
].forEach((id) => (el[id] = $(id)));

// ---------- utils ----------
function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
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
// Writes obj to storage.local; a failure is logged and toasted once (关注 writes through this too).
function store(obj) {
  return chrome.storage.local.set(obj).catch((e) => {
    console.error("[triage] storage write failed", Object.keys(obj), e);
    if (storeFailShown) return;
    storeFailShown = true;
    toast(`保存失败，本地存储可能已满：${e?.message || e}`, true);
  });
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

// Waits ms, returning early when keepGoing() turns false.
async function sleepWhile(ms, keepGoing) {
  const end = Date.now() + ms;
  while (Date.now() < end && keepGoing()) {
    await new Promise((r) => setTimeout(r, Math.min(200, end - Date.now())));
  }
}

function openTab(url) {
  chrome.tabs.create({ url });
}

let ownTabId;
// Opens the side panel on this tab with the video as its context; the panel takes the request
// the same way as the player's AI 总结 button.
function askAi(it) {
  const contextRef = { site: "bilibili", videoId: it.bvid, title: it.title, author: it.upper, url: videoUrl(it.bvid) };
  chrome.storage.local.set({ boc_player_ai_quick_action_v1: { id: `triage-${Date.now()}`, tabId: ownTabId, prompt: "", contextRef } });
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

function askConfirm(title, bodyHtml, okText, { danger = false } = {}) {
  el.confirmTitle.textContent = title;
  el.confirmBody.innerHTML = bodyHtml;
  el.confirmOk.className = danger ? "danger solid" : "primary";
  el.confirmOk.textContent = okText;
  el.confirmOk.setAttribute("aria-label", okText);
  el.confirmDialog.returnValue = "";
  el.confirmDialog.showModal();
  return new Promise((resolve) => {
    el.confirmDialog.addEventListener("close", () => resolve(el.confirmDialog.returnValue === "ok"), { once: true });
  });
}

// kind "ai" marks an AI setup problem; a run that then succeeds clears only that kind, whichever folder it ran in.
function showBanner(text, btnText, onClick, kind = "") {
  el.banner.dataset.kind = kind;
  el.bannerText.textContent = text;
  el.bannerBtn.textContent = btnText;
  el.bannerBtn.setAttribute("aria-label", btnText);
  el.bannerBtn.onclick = onClick;
  el.banner.hidden = false;
}

function handleAiError(error) {
  const text = String(error || "AI 调用失败");
  const origin = /未授权访问 (https?:\/\/[^\s，]+)/.exec(text)?.[1];
  if (origin) {
    // The click is the user gesture permissions.request needs; the service worker cannot ask.
    showBanner(text, `授权访问 ${origin}`, async () => {
      if (await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false)) {
        el.banner.hidden = true;
        toast("已授权，请重试");
      }
    }, "ai");
  } else if (text.includes("配置 AI")) {
    showBanner("还没有配置 AI 平台", "去设置", () => send({ type: "open-options" }), "ai");
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
const aiNewTagRoom = () => Math.max(0, Math.min(S.settings.triageAiNewTagMax, tagLimit() - viewTags().length));
const FOLDER_ONLY = "标签按收藏夹分开，请先打开一个具体收藏夹";
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
const ownStage1 = () => S.stage1.running && S.stage1.mediaId === String(S.mediaId);
const ownGroup = () => (S.group?.mediaId === String(S.mediaId) ? S.group : null);
const runWhere = (run) => (run.mediaId === String(S.mediaId) ? "" : `（${folderName(run.mediaId)}）`);

// verdict is keep / drop / unsure, or "none" before 粗分. A done 细看 with an unknown verdict counts as unsure;
// a 粗分 result with one (left from the old custom tiers) counts as not classified, so 粗分 can run again.
// An invalid video is 可清理 whatever the AI said, but keeps the AI's reason and step after the 已失效 note.
function verdictOf(it) {
  const v = aiVerdictOf(it);
  if (!it.invalid) return v;
  return { verdict: "drop", reason: v.reason ? `视频已失效。AI 原理由：${v.reason}` : "视频已失效", stage: Math.max(v.stage, 0), failed: "" };
}

function aiVerdictOf(it) {
  const a = S.analyses[it.bvid];
  const failed = a?.status === "error" ? a.error || "分析失败" : "";
  if (a?.status === "done") return { verdict: VERDICTS[a.verdict] ? a.verdict : "unsure", reason: a.reason, stage: 2, failed: "" };
  const t = S.titleRes[it.bvid];
  if (t && VERDICTS[t.verdict]) return { verdict: t.verdict, reason: t.reason, stage: 1, low: t.confidence === "low", failed };
  return { verdict: "none", reason: "", stage: -1, failed };
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

function passFilter(it) {
  if (S.finishedFilter && !isFinished(it)) return false;
  if (S.aiRecentFilter && !aiRecentSet().has(it.bvid)) return false;
  if (S.kindFilter && kindOf(it) !== S.kindFilter) return false;
  if (S.tagFilter.size && !hasAllTags(tagIdsOf(it.bvid), S.tagFilter, (id) => tagById(id)?.name ?? id)) return false;
  const words = S.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = searchText(it);
  return words.every((w) => text.includes(w));
}

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
  const missing = sort === "play" && S.items.some((it) => !it.invalid && !Number.isFinite(it.play));
  el.sortBox.innerHTML = `${missing ? `<span class="muted">播放量要再同步一次才有</span>` : ""}${UI.sortControl({ sorts: SORTS, sort, dir, words: sortWords(sort, dir), selectAttr: "data-sort", dirAttr: "data-sort-dir" })}`;
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
  if (S.tab !== "coarse") return list;
  const batch = new Set(ownGroup()?.bvids || nextBatch());
  const rank = (it) => (failedAnalysis(it.bvid) ? 3 : batch.has(it.bvid) ? 0 : 1 + unsureFirst(it));
  return list.sort((x, y) => rank(x) - rank(y));
}
const selectedIn = (list) => list.filter((it) => S.selected.has(it.bvid));
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

// The 细看 batch: the first GROUP_SIZE selected cards of 粗看完成, otherwise its first GROUP_SIZE, 拿不准 / low confidence first.
function nextBatch() {
  const open = S.items.filter((it) => inTab(it, "coarse") && passFilter(it) && needsAnalysis(it.bvid));
  const sel = selectedIn(open);
  return (sel.length ? sel : open.sort((x, y) => unsureFirst(x) - unsureFirst(y))).slice(0, GROUP_SIZE).map((it) => it.bvid);
}

// ---------- init ----------
init();
// 关注 mode (follow.js) borrows the viewer, the toast, the confirm dialog and the undo stack, and takes the keys while on.
const followMode = () => Boolean(document.body?.classList.contains("follow-mode"));
// modeKeys(key, e): null while that mode is off (the keys below run); otherwise true when it used the key.
let modeKeys = null;
globalThis.MoonTriage = {
  openViewer, closeViewer, toast, askConfirm, send, store, handleAiError, THROTTLES, sleepWhile, viewing: () => S.viewing,
  undo, pushUndo, help: () => el.helpDialog.showModal(), setModeKeys: (fn) => (modeKeys = fn)
};

async function init() {
  UI.fillSetRows(document);
  bindEvents();
  // Read up front: sidePanel.open must run inside the click's user gesture, before any await.
  chrome.tabs.getCurrent().then((tab) => (ownTabId = tab?.id));
  const [{ tags, videoTags, folderCriteria }, kept, basket, notes, settingsResp] = await Promise.all([
    loadTagsAndCriteria().then(async (r) => ({ ...r, ...(await loadTagsByFolder(r)) })),
    loadKept(),
    storeGet(K.basket, []),
    storeGet(K.notes, {}),
    send({ type: "triage-settings-get" })
  ]);
  Object.assign(S, { tags, videoTags, folderCriteria, kept });
  S.basket = basket.map(({ bvid, title, cover, upper, duration, opened }) => ({ bvid, title, cover, upper, duration, ...(opened ? { opened: true } : {}) }));
  S.notes = notes;
  S.aiHistory = await storeGet(K.aiHistory, []);
  S.aiRecent = await storeGet(K.aiRecent, {});
  S.sortBy = await storeGet(K.sort, {});
  if (settingsResp.ok) Object.assign(S.settings, settingsResp.data);
  renderTagLimit();
  el.aiRecentRules.innerHTML = AI_RECENT_RULES.map((r) => `<li>${esc(r)}</li>`).join("");
  el.aiRecentUndo.textContent = AI_RECENT_UNDO;
  const syncObsidian = ({ obsidianEnabled }) => document.body.classList.toggle("obsidian-off", obsidianEnabled !== true);
  const sync = await chrome.storage.sync.get({ obsidianEnabled: false, ...SEEN_DEFAULTS });
  syncObsidian(sync);
  setSeenCfg(sync);
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
  });
  chrome.runtime.onMessage.addListener((msg) => {
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
const SEEN_DEFAULTS = { seenShow: "off", seenThreshold: 80, seenStyle: "badge" };
function setSeenCfg(v) {
  const bar = v.seenShow === "bar" || v.seenShow === "both";
  const mark = v.seenShow === "mark" || v.seenShow === "both";
  S.seenCfg = { on: bar || mark, bar, mark, threshold: Number(v.seenThreshold) || 80, style: v.seenStyle === "veil" ? "veil" : "badge" };
  document.documentElement.dataset.seenStyle = S.seenCfg.style;
  // The background reads only what is new, at most every 10 minutes (triage-seen-sync); its writes come back through followSeen.
  if (S.seenCfg.on) send({ type: "triage-seen-sync" });
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
// 100% reads 看完了, otherwise 看到 N%; ✓ (and the strong look) means it counts as 看完了.
const seenWords = (p, done) => (p >= 100 ? "✓ 看完了" : done ? `✓ 看到 ${p}%` : `看到 ${p}%`);
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
  // A real link (right-click 在新标签页中打开, ⌘-click), out of the tab order: the title is the same link for the keyboard.
  return `<a class="cover-wrap${seen ? " seen" : ""}" href="${esc(videoUrl(it.bvid))}" data-act="open" tabindex="-1" aria-hidden="true">${pic}${tag}${dur}${mark}${p ? `<span class="seen-bar" title="看到 ${p}%"><i style="width:${Math.max(p, 2)}%"></i></span>` : ""}</a>`;
}

// Runs simplifyMigration once (flag key), then drops the old scheme keys it read.
async function loadTagsAndCriteria() {
  const got = await chrome.storage.local.get([K.tags, K.videoTags, K.folderCriteria, K.simplified, "triage_schemes", "triage_folder_scheme"]);
  if (got[K.simplified]) return { tags: got[K.tags] || [], videoTags: got[K.videoTags] || {}, folderCriteria: got[K.folderCriteria] || {} };
  const keys = (await chrome.storage.local.getKeys?.()) ?? Object.keys((await chrome.storage.local.get(null)) || {});
  const folderIds = keys.map((k) => /^triage_(?:snapshot|decisions)_(.+)$/.exec(k)?.[1]).filter(Boolean);
  const { triageCriteria } = await chrome.storage.sync.get({ triageCriteria: "" });
  const out = simplifyMigration({
    schemes: got.triage_schemes,
    folderScheme: got.triage_folder_scheme,
    tags: got[K.tags],
    videoTags: got[K.videoTags],
    criteria: triageCriteria,
    folderIds,
    folderCriteria: got[K.folderCriteria]
  });
  await chrome.storage.local.set({ [K.tags]: out.tags, [K.videoTags]: out.videoTags, [K.folderCriteria]: out.folderCriteria, [K.simplified]: true });
  await chrome.storage.local.remove(["triage_schemes", "triage_folder_scheme"]);
  await chrome.storage.sync.remove("triageCriteria");
  return out;
}

// Runs tagsByFolderMigration until every tag has a folder (flag key), from the cached folder lists.
async function loadTagsByFolder({ tags, videoTags }) {
  if (await storeGet(K.tagsByFolder, false)) return { tags, videoTags };
  const keys = ((await chrome.storage.local.getKeys?.()) ?? Object.keys((await chrome.storage.local.get(null)) || {})).filter((k) => k.startsWith("triage_snapshot_"));
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

// A folder that is no longer chosen (deleted on Bilibili or unticked) gets no new list to diff against, so its videos
// (unless in a chosen folder's list) move to 已出分拣范围 here and its records go. Runs once S.folders is known.
function retireUnchosenFolders() {
  return serialStore(async () => {
    if (!S.allFolders.length) return; // 默认收藏夹 always exists; an empty list is never "every folder deleted"
    if (!S.included.length) return; // nothing chosen yet (or all unticked by accident): never empty every folder into 已出分拣范围
    const live = new Set(S.folders.map((f) => String(f.id)));
    const keys = ((await chrome.storage.local.getKeys?.()) ?? Object.keys((await chrome.storage.local.get(null)) || {})).filter((k) => k.startsWith("triage_snapshot_"));
    const gone = keys.map((k) => k.slice(16)).filter((id) => !live.has(id));
    if (!gone.length) return;
    const got = await chrome.storage.local.get([K.removed, K.left, ...keys]);
    const otherBvids = new Set([...live].flatMap((id) => got[K.snapshot(id)]?.bvids || []));
    let out = { removed: got[K.removed] || {}, left: got[K.left] || {} };
    for (const id of gone) {
      const old = got[K.snapshot(id)];
      const oldItems = old?.items || (old?.bvids || []).map((bvid) => ({ bvid, title: old.titles?.[bvid] || bvid }));
      out = updateRemoved(out.removed, out.left, oldItems, [], otherBvids, Date.now(), null, { id, title: folderName(id) });
    }
    await chrome.storage.local.set({ [K.removed]: out.removed, [K.left]: out.left });
    await chrome.storage.local.remove(gone.flatMap((id) => [K.snapshot(id), K.decisions(id)]));
  });
}

// Opt-in: a new user starts with no folder chosen. The first load after this change keeps every folder for
// someone who already triaged (a snapshot exists), minus the ones they had switched off.
async function loadIncluded() {
  const got = await chrome.storage.local.get([K.included, "triage_excluded_folders"]);
  if (Array.isArray(got[K.included])) return got[K.included];
  const keys = (await chrome.storage.local.getKeys?.()) ?? Object.keys((await chrome.storage.local.get(null)) || {});
  const off = (got.triage_excluded_folders || []).map(String);
  const included = keys.some((k) => k.startsWith("triage_snapshot_"))
    ? S.allFolders.map((f) => String(f.id)).filter((id) => !off.includes(id))
    : [];
  await chrome.storage.local.set({ [K.included]: included });
  await chrome.storage.local.remove("triage_excluded_folders");
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
    const needLogin = /登录/.test(r.error || "");
    if (needLogin) showBanner(r.error, "去登录", () => openTab("https://passport.bilibili.com/login"));
    else showBanner(`读取收藏夹失败：${r.error}`, "重试", loadFolders);
    el.list.innerHTML = `<p class="empty">无法读取收藏夹</p>`;
    return;
  }
  S.allFolders = r.data.folders || [];
  S.mid = r.data.mid;
  S.included = (await loadIncluded()).map(String);
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
  S.items = [];
  S.itemMap = new Map();
  S.selected.clear();
  S.tagFilter.clear();
  S.finishedFilter = false;
  S.aiRecentFilter = false;
  S.kindFilter = "";
  S.undo = [];
  S.focused = "";
  S.focusIndex = 0;
  S.syncError = "";
  hideSyncNotice();
  if (!all && !removed) storeSet(K.lastFolder, mediaId);
  el.folderSelect.value = mediaId;
  el.list.innerHTML = loadingHtml();
  let ok;
  if (all) ok = await openAll();
  else if (removed) ok = await openRemoved();
  else ok = (await openCached(token)) || (token === S.folderToken && (await syncFolder({ force: true })));
  if (!ok) return;
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
  S.items = [...snap.items];
  S.itemMap = new Map(S.items.map((it) => [it.bvid, it]));
  if (!(await loadResults(token))) return false;
  checkCached(token, snap);
  return true;
}

async function checkCached(token, snap) {
  if (writingTo(S.mediaId)) return deferRead(() => quickSync({ force: true }));
  const r = await send({ type: "triage-folder-ids", mediaId: S.mediaId });
  if (token !== S.folderToken) return;
  if (!r.ok) syncFolder({ force: true });
  else if (!idsChanged(snap.ids || snap.bvids, r.data.bvids)) S.lastSyncAt = S.readAt[S.mediaId] = Date.now();
  else syncFolder({ force: true, cached: { snap, ids: r.data.bvids } });
}

// bvid → { item, from } for videos in another chosen folder's cached list (from: its id) or in 已出分拣范围 (from: REMOVED).
async function localItems(mediaId) {
  const others = S.folders.map((f) => String(f.id)).filter((id) => id !== String(mediaId));
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

// A batch 取消收藏 / 移动 changes its folders on Bilibili chunk by chunk, and a paged read across that shifts past videos
// that never moved; the lists also trail a write by about a second. So those folders are not read while the run lasts
// and for WRITE_SETTLE_MS after; a read asked for meanwhile runs once they settle.
const WRITE_SETTLE_MS = 3000;
const lastWrite = {}; // mediaId → when a run last wrote to it
const markWritten = (...ids) => ids.forEach((id) => (lastWrite[String(id)] = Date.now()));
function writingTo(id) {
  const k = String(id);
  return [S.unfavBatch, S.transferRun].some((run) => run && (run.mediaId === k || run.to === k)) || Date.now() - (lastWrite[k] || 0) < WRITE_SETTLE_MS;
}
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
async function quickSync({ force = false } = {}) {
  if (!force && Date.now() - S.lastSyncAt < SYNC_MIN_GAP_MS) return;
  const token = S.folderToken;
  const snap = S.mediaId === TOVIEW ? null : await storeGet(K.snapshot(S.mediaId), null);
  if (token !== S.folderToken) return;
  if (!snap?.items || snap.intro === undefined) syncFolder({ force });
  else checkCached(token, snap);
}

// A chosen folder other than the open one with a proposal waiting.
const otherAiFolder = () => Object.keys(S.ai.proposals).find((id) => id !== String(S.mediaId) && S.folders.some((f) => String(f.id) === id));

// ---------- sync with bilibili ----------
// cached ({ snap, ids }, from checkCached) fetches only the newest pages and takes the rest from the cached list.
async function syncFolder({ force = false, cached = null } = {}) {
  // S.syncing holds the token of the running sync, so a forced sync for a newly opened folder is not blocked by the old one.
  if (S.syncing === S.folderToken || (!force && Date.now() - S.lastSyncAt < SYNC_MIN_GAP_MS)) return false;
  if (writingTo(S.mediaId)) {
    deferRead(() => (cached ? quickSync({ force: true }) : syncFolder({ force: true })), !cached);
    return false;
  }
  const token = S.folderToken;
  S.syncing = token;
  S.loadPage = null;
  const mediaId = S.mediaId;
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
      const needLogin = /登录/.test(r.error || "");
      if (needLogin) showBanner(r.error, "去登录", () => openTab("https://passport.bilibili.com/login"));
      else S.syncError = `刷新失败：${r.error}`;
      if (!S.items.length) el.list.innerHTML = UI.emptyState("无法读取这个收藏夹", needLogin ? "登录 B站后点刷新。" : r.error, REFRESH_EMPTY);
      return false;
    }
    S.lastSyncAt = S.readAt[mediaId] = Date.now();
    S.syncError = "";
    if (r.data.info) S.folderIntro[mediaId] = r.data.info.intro;
    const snap = await storeGet(K.snapshot(mediaId), null);
    if (token !== S.folderToken) return false;
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
    S.items = next;
    S.itemMap = new Map(next.map((it) => [it.bvid, it]));
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

// The full item list doubles as the 所有收藏夹 cache; bvids/invalid/titles drive the sync diff. Videos that left every
// chosen folder go to 已出分拣范围.
function saveSnapshot(mediaId, items, ids = null) {
  return serialStore(async () => {
    const others = S.folders.map((f) => String(f.id)).filter((id) => id !== String(mediaId));
    const got = await chrome.storage.local.get([K.snapshot(mediaId), K.removed, K.left, ...others.map(K.snapshot)]);
    const old = got[K.snapshot(mediaId)];
    const oldItems = old?.items || (old?.bvids || []).map((bvid) => ({ bvid, title: old.titles?.[bvid] || bvid }));
    const otherBvids = new Set(others.flatMap((id) => got[K.snapshot(id)]?.bvids || []));
    const { removed, left } = updateRemoved(got[K.removed] || {}, got[K.left] || {}, oldItems, items, otherBvids, Date.now(), ids, { id: String(mediaId), title: folderName(mediaId) });
    await chrome.storage.local.set({
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
  S.items = Object.values(rec)
    .sort((x, y) => y.at - x.at)
    .map(({ item, at, movedTo, hidden, inFolder, from }) => ({ ...item, removedAt: at, movedTo, hidden, inFolder, from: from || inferFrom(decisionsByFolder, item.bvid, folderName) }));
  S.itemMap = new Map(S.items.map((it) => [it.bvid, it]));
  if (!(await loadResults(token))) return false;
  checkRemoved(token);
  return true;
}

// Re-favorited videos leave 已出分拣范围 as soon as one chosen folder's id list has them again; then each one left is
// asked where it is now (checkWhere).
async function checkRemoved(token) {
  const ids = S.folders.map((f) => String(f.id));
  S.removedCheck = { done: 0, total: ids.length, what: "个收藏夹，重新收藏的会自动移出", error: "" };
  for (const id of ids) {
    if (token !== S.folderToken) return;
    if (writingTo(id)) {
      S.removedCheck.done++; // checked next time; its list is changing now
      continue;
    }
    const r = await send({ type: "triage-folder-ids", mediaId: id });
    if (token !== S.folderToken) return;
    if (!r.ok) {
      S.removedCheck.error = `核对「${folderName(id)}」失败：${r.error}，可点刷新重试`;
      render();
      return;
    }
    S.removedCheck.done++;
    await dropRemoved(r.data.bvids);
    render();
    await new Promise((res) => setTimeout(res, 300));
  }
  await checkWhere(token);
  if (token === S.folderToken && !S.removedCheck.error) S.removedCheck = null;
  render();
}

// Asks Bilibili, per video, which folders hold it (not invalid ones: those are known, and records too old to have an aid
// are left as they are). Only folders not chosen count; one in a chosen folder is taken out by the next id check.
async function checkWhere(token) {
  if (token !== S.folderToken) return;
  const list = S.items.filter((it) => it.aid && kindOf(it) !== "invalid");
  S.removedCheck = { done: 0, total: list.length, what: "个视频还在不在收藏夹里", error: "" };
  const found = {};
  for (const it of list) {
    if (token !== S.folderToken) break;
    const r = await send({ type: "triage-fav-where", aid: it.aid });
    if (token !== S.folderToken) break;
    if (!r.ok) {
      S.removedCheck.error = `核对《${shortTitle(it)}》的收藏状态失败：${r.error}，可点刷新重试`;
      break;
    }
    const folders = r.data?.folders || [];
    const out = folders.find((f) => !S.included.includes(String(f.id)));
    if (out || !folders.length) {
      it.inFolder = out ? { id: out.id, title: out.title } : null;
      found[it.bvid] = it.inFolder;
    }
    S.removedCheck.done++;
    render();
    await new Promise((res) => setTimeout(res, 150));
  }
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
      S.items = S.items.filter((it) => !back.includes(it.bvid));
      S.itemMap = new Map(S.items.map((it) => [it.bvid, it]));
    }
    return back.length;
  });
}

// Deletes everything MoonDigest holds for these videos (AI results, 保留, note, tags, 播放列表, 取消收藏 records) and their record.
async function cleanRemoved(list) {
  if (!list.length) return;
  const one = list.length === 1 ? `《${shortTitle(list[0])}》` : `这 ${list.length} 个视频`;
  const body = `<p>删除${one}的 AI 分析、备注、标签和播放列表记录，无法撤销。<br>要留存请先从「导出」菜单导出。</p>`;
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
    await chrome.storage.local.remove(bvids.flatMap((b) => [`triage_title_${b}`, `triage_analysis_${b}`]));
    const write = { [K.removed]: rec, [K.notes]: S.notes, [K.videoTags]: S.videoTags, [K.kept]: S.kept, [K.basket]: S.basket };
    noteOwnWrites(write);
    await chrome.storage.local.set(write);
    S.removedCount = Object.keys(rec).length;
    S.items = S.items.filter((it) => !set.has(it.bvid));
    S.itemMap = new Map(S.items.map((it) => [it.bvid, it]));
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
    if (t.ok && t.data?.[b]) S.titleRes[b] = stamped(`triage_title_${b}`, t.data[b]);
    if (a.ok && a.data?.[b]) S.analyses[b] = stamped(`triage_analysis_${b}`, a.data[b]);
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
  S.items = items;
  S.itemMap = new Map(items.map((it) => [it.bvid, it]));
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
    if (writingTo(next)) {
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
    const r = await send({ type: "triage-folder-items", mediaId: id });
    if (token !== S.folderToken) return;
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

function loadAllLine() {
  const L = S.loadAll;
  const n = S.folders.length;
  const loaded = n - L.queue.length;
  const partial = L.partial ? `（${L.partial} 个只加载了部分）` : "";
  if (!L.queue.length && !L.check.length) return `<span class="muted">${n} 个收藏夹 · ${S.items.length} 个视频${partial}</span>`;
  const busy = L.running && !L.paused;
  const now = busy ? ` · 正在加载「${esc(folderName(L.queue[0]))}」${pageText(L.queue[0])}` : "";
  const text = L.check.length
    ? `${busy ? "正在核对" : "已核对"} ${L.checkTotal - L.check.length} / ${L.checkTotal} 个收藏夹`
    : `已加载 ${loaded} / ${n} 个收藏夹${partial}${now}（第一次较慢，之后只核对变化）`;
  const btn = L.paused
    ? `<button type="button" class="link" data-head="all-resume" aria-label="继续加载收藏夹">继续</button>`
    : `<button type="button" class="link" data-head="all-pause" aria-label="暂停加载收藏夹">暂停</button>`;
  return `<span class="muted"${busy ? ' aria-busy="true"' : ""}>${text} · ${btn}</span>${L.error ? `<span class="fail-text">${esc(L.error)}</span>` : ""}`;
}

const folderName = (id) => id === REMOVED ? "已出分拣范围" : S.allFolders.find((f) => String(f.id) === String(id))?.title || String(id);
// The folder select's counts follow our own writes at once instead of waiting for the next folder-list load.
function bumpCount(id, delta) {
  const f = S.allFolders.find((x) => String(x.id) === String(id));
  if (!f || !delta) return;
  f.count = Math.max(0, Number(f.count || 0) + delta);
  const opt = el.folderSelect.querySelector?.(`option[value="${f.id}"]`);
  if (opt) opt.textContent = `${f.title} (${f.count})`;
}
const folderNames = (it) => it.folders.map(folderName).join("、");

// A video in several folders: pick which ones to unfavorite it from (all checked by default).
async function pickUnfavFolders(it) {
  const boxes = it.folders
    .map((f) => `<label class="toggle"><input type="checkbox" value="${esc(f)}" checked /> ${esc(folderName(f))}</label>`)
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
  const head = partial ? `只加载了前 ${partial.count} 个（第 ${partial.page} 页失败：${partial.error}），可稍后重试同步。` : "";
  const where = (it) => (it.from === REMOVED ? "原在已出分拣范围" : `也在「${folderName(it.from)}」`);
  UI.setSync(syncEls(), {
    label: `B站已同步${partial ? "（部分）" : ""} +${added.length}${partial ? "" : ` −${removed.length}`}`,
    text: `${head}B站同步：${parts.join(" · ")}`,
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
      return `<button type="button" class="side-item${on ? " on" : ""}" data-folder="${esc(o.value)}"${on ? ' aria-current="true"' : ""}${o.title ? ` title="${esc(o.title)}"` : ""}>${thumb}<span class="side-name">${esc(m[1])}</span>${m[2] ? `<span class="side-count">${m[2]}</span>` : ""}</button>`;
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
  const explain = S.mediaId === REMOVED && "离开了你勾选的所有收藏夹，AI 分析、备注和标签都还留着，清理前可先从「导出」菜单导出";
  const meta = UI.headMeta([inFolderView() && UI.syncedText(S.readAt[S.mediaId]), invalid && `${invalid} 个已失效`, explain], S.syncError);
  const thumb = inFolderView() && S.mediaId !== TOVIEW ? folderThumb(S.mediaId, el.folderSelect.querySelector?.(`option[value="${S.mediaId}"]`)?.dataset.cover) : "";
  el.folderHead.innerHTML = `${thumb}<div class="folder-text"><h1 class="folder-title">${UI.titleHtml(folderTitle(), S.items.length)}</h1><div class="folder-meta">${meta}</div></div>`;
}

// What is running, in one place on every tab: the first that applies wins. done/total draws a bar,
// act puts a button on it (handled like the step bar's buttons), warn turns it amber.
function activityState() {
  const left = S.throttleUntil - Date.now();
  const wait = UI.waitText(S.throttleLabel, Math.ceil(left / 1000));
  if (S.group) {
    const done = groupDone(S.group);
    const where = runWhere(S.group);
    const text = where ? `字幕细看 ${done}/${S.group.bvids.length}${where}` : S.group.text || `字幕细看 ${done}/${S.group.bvids.length}`;
    return { text: wait || text, done, total: S.group.bvids.length, act: "group", actLabel: S.group.stop ? "暂停中" : "暂停细看", stopping: S.group.stop, warn: Boolean(wait) };
  }
  if (S.stage1.running) {
    const where = runWhere(S.stage1);
    const text = where ? `标题粗看中 ${S.stage1.done}/${S.stage1.total}${where}` : S.stage1.text;
    return { text: wait || text, done: S.stage1.done, total: S.stage1.total, act: "stage1", actLabel: S.stage1.stop ? "暂停中" : "暂停粗看", stopping: S.stage1.stop, warn: Boolean(wait) };
  }
  const move = S.transferRun;
  if (move) return { text: `${move.verb}到「${move.toName}」${move.done}/${move.total}${runWhere(move)}`, done: move.done, total: move.total };
  const unfav = S.unfavBatch;
  if (unfav) return { text: `取消收藏中 ${unfav.done}/${unfav.total}${runWhere(unfav)}`, done: unfav.done, total: unfav.total };
  if (wait) return { text: wait, warn: true };
  // Loading 所有收藏夹 is not here: its own line leads the step bar on every tab of that view.
  if (S.syncing) return { text: `刷新中…${pageText(S.mediaId)}` };
  if (S.ai.running) {
    const where = S.ai.mediaId === String(S.mediaId) ? "" : `（${folderName(S.ai.mediaId)}）`;
    return { text: `AI 打标签运行中${where}`, act: "tags", actLabel: "查看" };
  }
  if (S.ai.proposal) return { text: "标签建议待确认", act: "tags", actLabel: "查看" };
  const other = otherAiFolder();
  if (other) return { text: `「${folderName(other)}」的标签建议待确认`, act: "aiOther", actLabel: "查看" };
  // A finished 粗看 keeps its last line for its own folder.
  if (S.stage1.text && !runWhere(S.stage1)) return { text: S.stage1.text };
  return null;
}

function renderStatus() {
  const a = activityState();
  UI.setActivity(el.activity, a && { ...a, btn: a.act && { attrs: `data-head="${a.act}"`, label: a.actLabel, disabled: a.stopping } });
}

function tick() {
  if (S.throttleUntil) renderStatus();
}

function renderTabs() {
  const c = stageCounts();
  const tab = (key, label, cls, n) =>
    `<button type="button" role="tab" class="${cls}" data-tab="${key}" aria-selected="${S.tab === key}" aria-label="${label} ${n}">${label}<span class="count">${n}</span></button>`;
  const steps = STAGES.map(([key, label]) => tab(key, label, c[key] ? "step" : "step zero", c[key]));
  el.searchCount.textContent = UI.resultCount(S.query, c.read);
  // Say what the box searches: the open folder (or 所有收藏夹 / 已出分拣范围) and the tab you are on.
  const tabName = Object.fromEntries([...STAGES, ["read", "全部"]])[S.tab];
  const scope = `在「${folderTitle()}」${tabName ? ` · ${tabName}` : ""}里搜`;
  if (el.searchInput.placeholder !== scope) el.searchInput.placeholder = scope;
  // 已出分拣范围 has no steps; its tabs are why the videos left (kindOf), 全部 first for the ones not checked yet.
  const kindTabs = () =>
    [["", "全部"], ...KINDS].map(([kind, label]) => {
      const n = kind ? S.items.filter((it) => kindOf(it) === kind).length : S.items.length;
      return `<button type="button" role="tab" class="${n ? "step" : "step zero"}" data-kindtab="${kind}" aria-selected="${S.kindFilter === kind}" aria-label="${label} ${n}">${label}<span class="count">${n}</span></button>`;
    }).join("");
  el.tabs.innerHTML = S.mediaId === REMOVED ? kindTabs() :
    steps.join(`<span class="arrow" aria-hidden="true">→</span>`) + `<span class="tab-sep" aria-hidden="true"></span>` + tab("read", "阅览全部", "read-tab", c.read);

  // The tag row lists only what the tab on screen has (or a filter that is on, so it can be turned off).
  const here = S.mediaId === REMOVED || S.tab === "read" ? S.items : S.items.filter((it) => stageOf(it) === S.tab);
  const hereTags = new Set(here.flatMap((it) => tagIdsOf(it.bvid)));
  const chips = tagChips().filter((c) => c.ids.some((id) => hereTags.has(id) || S.tagFilter.has(id)));
  const chip = (on, any, attr, label, aria) =>
    !on && !any ? "" : `<button type="button" class="chip watched${on ? " on" : ""}" ${attr} aria-pressed="${on}" aria-label="${aria}">${label}</button>`;
  const watchedChip =
    S.seenCfg.mark || S.finishedFilter ? chip(S.finishedFilter, here.some(isFinished), "data-finishedfilter", "看完了", "只看 B站历史记录里看完了的视频") : "";
  // Only when this view has an invalid video, like those above; with 全选 it picks them all for 取消收藏 or 清理. 已出分拣范围
  // has it as a tab instead.
  const invalidN = S.items.filter((it) => kindOf(it) === "invalid").length;
  const invalidOn = S.kindFilter === "invalid";
  const invalidChip = S.mediaId === REMOVED || (!invalidOn && !invalidN) ? "" : `<button type="button" class="chip invalid${invalidOn ? " on" : ""}" data-kindfilter="invalid" aria-pressed="${invalidOn}" aria-label="只看已失效的视频">已失效 ${invalidN}</button>`;
  const recentN = S.items.filter((it) => aiRecentSet().has(it.bvid)).length;
  const recentTip = `最近一次 AI 打标签改动的视频，在卡片上逐个看，不对的按 T 改。\n${AI_RECENT_RULES.map((r) => `· ${r}`).join("\n")}\n${AI_RECENT_UNDO}`;
  const recentChip = !recentN && !S.aiRecentFilter ? "" : `<span class="ai-recent"><button type="button" class="chip ai-recent-chip${S.aiRecentFilter ? " on" : ""}" data-airecent aria-pressed="${S.aiRecentFilter}" title="${esc(recentTip)}">${AI_SPARK}AI 刚打的 ${recentN}</button><button type="button" class="ai-recent-x" data-airecent-done aria-label="不再标出「AI 刚打的」，标签不变" title="不再标出，标签不变">×</button></span>`;
  el.tagFilter.innerHTML = recentChip + invalidChip + watchedChip + (chips.length
    ? chips
        .map((c) => {
          const on = c.ids.some((id) => S.tagFilter.has(id));
          return `<button type="button" class="chip${on ? " on" : ""}" style="--c:${esc(c.color)}" data-tagfilter="${esc(c.ids.join(","))}" aria-pressed="${on}" aria-label="按标签筛选 ${esc(c.name)}" title="可多选：只显示同时带有所选标签的视频">${esc(c.name)}</button>`;
        })
        .join("")
    : viewTags().length ? "" : `<span class="muted">还没有自定义标签</span>`); // created in 标签管理
  // 标签管理 and ✦ AI 打标签 at the right end of the tags they act on, as in 关注; AI 打标签 says when a run or a proposal is pending.
  el.aiTagSlot.innerHTML = UI.tagButtons({ manageAttrs: "data-tags-manage", aiAttrs: 'data-ai-tag aria-label="AI 打标签 (I)"', state: S.ai.running ? " · 运行中" : S.ai.proposal ? " · 待确认" : "" });
  renderSort();
}

const AI_SPARK = UI.AI_SPARK;

const headBtn = (act, label, cls = "", disabled = false, verdict = "", title = "", busy = false, ai = false) =>
  `<button type="button"${cls ? ` class="${cls}"` : ""} data-head="${act}"${verdict ? ` data-verdict="${verdict}"` : ""} aria-label="${esc(label)}"${title ? ` title="${esc(title)}"` : ""}${busy ? ' aria-busy="true"' : ""}${disabled ? " disabled" : ""}>${ai ? AI_SPARK : ""}${esc(label)}</button>`;

// The folder's 判断标准 next to the 粗看/细看 button; clicking it opens the editor.
function criteriaLine() {
  const text = criteria();
  const short = text.length > 24 ? `${text.slice(0, 24)}…` : text;
  return text
    ? `<span class="run-line" title="${esc(text)}">判断标准：${esc(short)}</span><button type="button" class="link" data-head="criteria" aria-label="修改判断标准">改判断标准</button>`
    : `<span class="run-line" title="没写判断标准时，AI 从收藏夹名和简介推测用途，按它判断值得留还是可清理">未设判断标准，AI 按收藏夹名「${esc(folderTitle())}」推测用途</span><button type="button" class="link" data-head="criteria" aria-label="写一句判断标准">写判断标准</button>`;
}

function renderListHeader(list) {
  const t = S.tab;
  const busy = S.stage1.running || Boolean(S.group);
  const all = S.mediaId === ALL;
  const sortHint = `<span class="muted">请在具体收藏夹里分拣</span>`;
  // AI-class chips with per-class counts inside the tab (search and tag filter applied).
  // It renders into its own slot at the left of the row, so it adds nothing to the action html.
  let segHtml = "";
  const inStage = S.items.filter((it) => (t === "read" || stageOf(it) === t) && passFilter(it));
  const n = (k) => (k === "all" ? inStage.length : inStage.filter((it) => classOf(it) === k).length);
  const classBtn = (k, label) => UI.filterBtn(`data-class-filter="${k}"`, label, n(k), S.classFilter[t] === k);
  // 阅览 also holds decided videos; they leave the AI classes for 已保留 (已取消收藏 has its own folder).
  const CLASSES = [["all", "全部"], ...Object.entries(VERDICTS), ...(t === "read" ? [["kept", "已保留"]] : [])];
  const seg = () => {
    segHtml = `<span class="seg" role="group" aria-label="按 AI 判断筛选">${CLASSES.map(([k, label]) => classBtn(k, label)).join("")}</span>`;
    return "";
  };
  const batchBtn = (route, verdict = "") => {
    const run = S.unfavBatch;
    if (route === "unfav" && run && !runWhere(run)) return headBtn("batch-unfav", `取消收藏中 ${run.done}/${run.total}`, "danger", true, "", "", true);
    const n = batchList(verdict || null).length;
    const verb = route === "unfav" ? "取消收藏" : "保留";
    // One batch 取消收藏 at a time: while another folder's runs, this one waits.
    return headBtn(`batch-${route}`, verdict ? `${verb}（AI：${VERDICTS[verdict]}）${n} 个` : `${verb}选中的 ${n} 个`, route === "unfav" ? "danger" : "", !n || (route === "unfav" && Boolean(run || S.transferRun)), verdict, route === "keep" ? KEEP_TIP : "");
  };
  const transferBtn = () => {
    const run = S.transferRun;
    if (run) return headBtn("transfer", `${run.verb}中 ${run.done}/${run.total}${runWhere(run)}`, "", true, "", "", true);
    const n = transferList().length;
    return headBtn("transfer", S.mediaId === REMOVED ? `收藏选中的 ${n} 个到…` : `移动/复制选中的 ${n} 个…`, "", !n || Boolean(S.unfavBatch));
  };
  const groupBtn = (cls) => {
    if (ownGroup()) return headBtn("group", `${S.group.stop ? "暂停中" : "暂停细看"} ${groupDone(S.group)}/${S.group.bvids.length}`, "primary", S.group.stop);
    const batch = nextBatch();
    const label = batch.some((b) => S.selected.has(b)) ? selectedIn(list).length > batch.length ? `细看选中的前 ${batch.length} 个` : `细看选中 ${batch.length} 个` : batch.length ? `细看下一批 ${batch.length} 个` : "细看";
    return headBtn("group", label, cls, !batch.length || busy, "", "", false, true);
  };
  // Pausing waits for the current batch or video; until then the button says so and takes no second click.
  const stage1Pause = () => headBtn("stage1", `${S.stage1.stop ? "暂停中" : "暂停粗看"} ${S.stage1.done}/${S.stage1.total}`, "primary", S.stage1.stop);
  // Results made under an older 判断标准 can be redone; 细看 goes one batch at a time like a normal run.
  const redoBtn = (act, verb, n) => (n ? headBtn(act, `按新标准重新${verb} ${n} 个`, "", busy, "", `这些视频是按旧的判断标准${verb}的`, false, true) : "");
  const sel = selectedIn(list).length;
  const f = S.classFilter[t];
  // html is what this step does; selActs acts on the selection and goes to its own bar below the filters.
  let html = "";
  let selActs = "";
  if (all && t === "none") html = sortHint;
  else if (all && t === "coarse") html = seg() + sortHint;
  else if (t === "none") {
    // The criteria the AI reads sits just before the button that sends it.
    html = criteriaLine();
    if (ownStage1()) html += stage1Pause();
    else {
      const n = stage1Pending().length;
      html += headBtn("stage1", n ? `标题粗看这 ${n} 个` : "标题粗看", "primary", !n || busy, "", "", false, true);
    }
    if (sel) selActs = batchBtn("keep");
  } else if (t === "coarse") {
    // A selection gets 细看 plus both batch buttons; 可清理 / 值得留 lead with their batch button, 细看 stays secondary.
    html = seg() + criteriaLine() + redoBtn("redo-coarse", "粗看", staleCoarse().length);
    if (sel) selActs = groupBtn("primary") + batchBtn("keep");
    else if (f === "drop") html += batchBtn("unfav", "drop") + groupBtn("");
    else if (f === "keep") html += batchBtn("keep", "keep") + groupBtn("");
    else html += groupBtn("primary");
  } else if (t === "fine") {
    // A selection gets both buttons; without one 值得留 and 可清理 each get a button, 拿不准 none.
    html = seg();
    const staleN = staleFine().length;
    if (staleN && !all) html += criteriaLine() + redoBtn("redo-fine", "细看", Math.min(staleN, GROUP_SIZE));
    if (all) html += sortHint;
    else if (sel) selActs = batchBtn("keep");
    else {
      if (f === "all" || f === "drop") html += batchBtn("unfav", "drop");
      if (f === "all" || f === "keep") html += batchBtn("keep", "keep");
    }
  } else if (t === "read" && S.mediaId === REMOVED) {
    const c = S.removedCheck;
    html = seg();
    if (c) html += c.error ? `<span class="fail-text">${esc(c.error)}</span>` : `<span class="muted" aria-busy="true">正在核对 ${c.done} / ${c.total} ${c.what}</span>`;
    html += `${sel ? headBtn("clean-selected", `清理选中的 ${sel} 个`, "danger") : headBtn("clean-removed", `清理这 ${list.length} 个`, "danger", !list.length)}`;
  } else if (t === "read") {
    // 阅览 mixes 粗看 guesses with 细看 conclusions, so no class-wide batch here: only the selection.
    html = seg();
    if (all) html += sortHint;
    else if (sel) selActs = batchBtn("keep");
  }
  // 移动/复制 works on a selection in any tab of a single folder; in 已出分拣范围 it is 收藏到. 取消收藏 goes last, set apart.
  if (sel && S.mediaId !== ALL) selActs += transferBtn();
  if (sel && !all && S.mediaId !== REMOVED) selActs += batchBtn("unfav");
  // 全选 adds every card listed under the current tab and filters; other tabs keep their selection.
  const unselected = S.mediaId !== ALL ? list.filter((it) => !S.selected.has(it.bvid)).length : 0;
  const selectAll = unselected ? `<button type="button" class="link" data-head="select-all" aria-label="全选这里列出的 ${list.length} 个">全选这里的 ${list.length} 个</button>` : "";
  if (all) html = loadAllLine() + html;
  const shown = selectedIn(list).length;
  const hidden = S.selected.size - shown;
  const selbar = S.selected.size
    ? `<div class="selbar" role="toolbar" aria-label="选中的视频"><strong class="sel-count">已选中 ${shown} 个</strong>${hidden ? `<span class="muted">另有 ${hidden} 个被筛选隐藏</span>` : ""}<button type="button" class="link" data-head="clear-selected" aria-label="清空选中">清空选中</button>${selectAll}<span class="sel-actions">${selActs}</span></div>`
    : "";
  el.classFilter.innerHTML = segHtml;
  el.listHeader.innerHTML = `${S.selected.size ? "" : `<span class="select-all">${selectAll}</span>`}<div class="step-actions">${html}</div>${selbar}`;
}

function recentUnfavs() {
  return Object.entries(S.decisions)
    .filter(([b, d]) => d.action === "unfav" && d.aid && !S.itemMap.has(b))
    .sort((x, y) => y[1].at - x[1].at)
    .slice(0, BocLimits.TRIAGE_RECENT_UNFAV);
}

function recentUnfavHtml() {
  const list = recentUnfavs();
  if (!list.length) return "";
  const rows = list
    .map(([b, d]) => {
      const title = esc(d.title || b);
      return `<li><span class="recent-title">${title}</span><span class="muted">${esc(fmtTime(d.at))}</span>
        ${refaving.has(b) ? `<button type="button" aria-busy="true" disabled>重新收藏中…</button>` : `<button type="button" data-refav="${esc(b)}" aria-label="重新收藏 ${title}">重新收藏</button>`}</li>`;
    })
    .join("");
  // One line per batch 取消收藏 of two or more still listed, newest first.
  const batches = [...new Set(list.map(([, d]) => d.batch).filter(Boolean))]
    .map((batch) => ({ batch, n: unfavBatchItems(batch).length }))
    .filter((x) => x.n > 1);
  const batchRows = batches
    .map(({ batch, n }) => {
      const busy = unfavBatchItems(batch).some((it) => refaving.has(it.bvid));
      return `<p class="recent-batch"><span>${esc(fmtTime(batch))} 批量取消收藏 ${n} 个</span>${busy ? `<button type="button" aria-busy="true" disabled>重新收藏中…</button>` : `<button type="button" data-refav-batch="${batch}" aria-label="这批 ${n} 个全部重新收藏">这批全部重新收藏</button>`}</p>`;
    })
    .join("");
  return `<section class="recent-unfav" aria-label="最近取消收藏"><h3>最近取消收藏 <span class="muted">${list.length}</span></h3>${batchRows}<ul>${rows}</ul></section>`;
}

// Re-favorites items ([{ bvid, aid }]) into mediaId one by one, stopping at the first failure. It changes Bilibili, so
// it runs to the end even after another folder opens.
async function refavMany(mediaId, items) {
  const rest = items.slice();
  let n = 0;
  let error = "";
  for (const it of items) refaving.add(it.bvid);
  render();
  while (rest.length) {
    if (n) await new Promise((r) => setTimeout(r, 300));
    if (S.mediaId === mediaId) toast(`正在重新收藏 ${n + 1}/${items.length}…`);
    const r = await send({ type: "triage-refav", mediaId, aid: rest[0].aid });
    if (!r.ok) {
      error = r.error;
      break;
    }
    bumpCount(mediaId, 1);
    const { bvid } = rest.shift();
    refaving.delete(bvid);
    await patchDecisions(mediaId, { [bvid]: null });
    n++;
  }
  for (const it of rest) refaving.delete(it.bvid);
  render();
  return { n, rest, error };
}

// The records one batch 取消收藏 left in the open folder, all of them (the list shows only the latest).
const unfavBatchItems = (batch) =>
  Object.entries(S.decisions)
    .filter(([b, d]) => d.action === "unfav" && d.batch === batch && d.aid && !S.itemMap.has(b))
    .map(([bvid, d]) => ({ bvid, aid: d.aid }));

async function refavBatch(batch) {
  const items = unfavBatchItems(batch).filter((it) => !refaving.has(it.bvid));
  if (!items.length) return;
  const mediaId = String(S.mediaId);
  const { n, rest, error } = await refavMany(mediaId, items);
  const where = S.mediaId === mediaId ? "" : `「${folderName(mediaId)}」`;
  if (error) toast(`${where}重新收藏中断（已完成 ${n} 个，剩余 ${rest.length} 个可再点重试）：${error}`, true);
  else toast(`${where}已重新收藏这批 ${n} 个`);
  if (!where) quickSync({ force: true });
}

const refaving = new Set();
async function refavRecent(bvid) {
  const d = S.decisions[bvid];
  if (!d?.aid || refaving.has(bvid)) return;
  const mediaId = S.mediaId;
  refaving.add(bvid);
  render();
  const r = await send({ type: "triage-refav", mediaId, aid: d.aid });
  refaving.delete(bvid);
  if (!r.ok) {
    render();
    toast(`重新收藏失败：${r.error}`, true);
    return;
  }
  bumpCount(mediaId, 1);
  await patchDecisions(mediaId, { [bvid]: null });
  if (mediaId !== S.mediaId) return;
  toast(`已重新收藏《${d.title || bvid}》`);
  render();
  quickSync({ force: true });
}

let listDeferred = false;
function renderList() {
  // Rebuilding the list mid-IME in a note would drop the composition and leave the raw pinyin; compositionend renders.
  if (BocTyping.isComposing() && document.activeElement?.closest?.("[data-note]")) return void (listDeferred = true);
  listDeferred = false;
  const list = visibleItems();
  renderListHeader(list);
  // 保留 only marks the video here, while 取消收藏 changed Bilibili; say so where both end up.
  const recent = S.tab === "done" ? `<p class="muted tab-note">已保留：${KEEP_TIP}。<br>已取消收藏：已从 B站收藏夹移走，最近的操作可按 U 撤销。</p>${recentUnfavHtml()}` : "";
  if (!S.items.length) {
    const empty = S.mediaId === REMOVED ? `<p class="empty">没有已出分拣范围的视频</p>` : S.loadAll?.queue.length ? `<p class="empty">正在加载收藏夹…</p>`
      : UI.emptyState("这个收藏夹是空的", "在 B站收藏了视频后，点刷新读进来。", REFRESH_EMPTY);
    el.list.innerHTML = `${empty}${recent}`;
    return;
  }
  if (!list.length) {
    const empty = { none: "没有未分析的视频", coarse: "没有粗看完成的视频", fine: "没有细看完成的视频", done: "还没有处理过的视频" };
    const f = S.classFilter[S.tab];
    const filtered = S.finishedFilter || S.aiRecentFilter || S.kindFilter || S.tagFilter.size || (f && f !== "all");
    const text = S.query.trim() ? "没有匹配搜索的视频" : filtered ? "没有符合筛选的视频" : empty[S.tab] || "这里没有视频";
    el.list.innerHTML = `<p class="empty">${text}</p>${recent}`;
    return;
  }
  if (!list.some((it) => it.bvid === S.focused)) {
    S.focused = list[Math.min(S.focusIndex, list.length - 1)].bvid;
  }
  S.focusIndex = list.findIndex((it) => it.bvid === S.focused);
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
  const failed = S.tab === "coarse" ? list.filter((it) => failedAnalysis(it.bvid)).length : 0;
  const failedHead = `<div class="group-head">分析失败 ${failed} · <button type="button" class="link" data-retry-failed aria-label="全部重试"${S.group || S.stage1.running ? " disabled" : ""}>${AI_SPARK}全部重试</button></div>`;
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
const KEEP_TIP = "只在 MoonDigest 里标记，B站收藏夹不变";

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
  const basketBtn = `<button type="button" data-act="basket" class="${inBasket ? "on" : ""}" aria-pressed="${inBasket}" aria-label="${inBasket ? "移出" : "加入"}播放列表 (E)">播放列表<kbd class="key">E</kbd></button>`;
  const askBtn = `<button type="button" data-act="ask" aria-label="问 AI (Q)">${AI_SPARK}问 AI<kbd class="key">Q</kbd></button>`;
  const meta = [it.upper, fmtDate(it.pubdate), Number.isFinite(it.play) && `▶ ${fmtCount(it.play)}`, ["", "粗看", "细看"][v.stage], seenText(it), it.invalid && "已失效", it.folders?.length && `收藏夹：${folderNames(it)}`].filter(Boolean);
  const left = removed && [originHtml(it), it.removedAt && `<span>${esc(leftText(it))}</span>`].filter(Boolean).join("");

  const verdict = decision ? "" : verdictBadge(b, v);
  // The button matching the AI's verdict leads; the other stays plain.
  const keepCls = !decision && v.verdict === "keep" ? "ok solid" : "";
  const unfavCls = !decision && v.verdict === "drop" ? "danger solid" : "";
  const note = S.notes[b]?.text || "";
  const noteHtml =
    note || S.noteOpen.has(b)
      ? `<textarea class="note" data-note rows="1" placeholder="一句话备注，回车保存" aria-label="备注">${esc(note)}</textarea>`
      : "";
  const failed = v.failed
    ? `<span class="fail-text">分析失败：${esc(v.failed)}</span><button type="button" data-act="retry" aria-label="重试分析">${AI_SPARK}重试</button>`
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
      <div class="meta">${meta.map(esc).join(" · ")}</div>
      ${body.join("")}
      <div class="card-foot verdict-row">${verdict}<span class="reason">${esc(v.reason)}</span>${failed}</div>
      ${chips ? `<div class="chips">${chips}</div>` : ""}
      ${noteHtml}
      <div class="card-foot">
        ${decision ? `<span class="badge ${decision.action === "keep" ? "keep" : "drop"}">${ACTION_LABEL[decision.action]}</span>` : ""}
        ${noteHtml ? "" : `<button type="button" class="link note-add" data-act="note" aria-label="添加备注">✎ 备注</button>`}
        <span class="spacer"></span>
        <div class="actions">
          ${removed ? `<span class="pair">
            <button type="button" data-select="${esc(b)}" class="${S.selected.has(b) ? "on" : ""}" aria-pressed="${S.selected.has(b)}" aria-label="选中 ${esc(it.title)}">选中</button>
            <button type="button" class="danger" data-clean="${esc(b)}" aria-label="清理 ${esc(it.title)}">清理</button>
          </span>
          <span class="more">${basketBtn}${askBtn}</span>` : `<span class="pair">
            <button type="button" data-act="keep" class="${keepCls}" aria-label="保留 (S)" title="只在 MoonDigest 里标记，B站收藏夹不变"${decision ? " disabled" : ""}>保留<kbd class="key">S</kbd></button>
            ${moving.has(b) ? `<button type="button" aria-busy="true" disabled>正在${S.transferRun?.verb || "移动"}…</button>` : deciding.has(b) ? `<button type="button" aria-busy="true" disabled>正在取消收藏…</button>` : `<button type="button" data-act="unfav" class="${unfavCls}" aria-label="取消收藏 (D)"${decision?.action === "unfav" ? " disabled" : ""}>取消收藏<kbd class="key">D</kbd></button>`}
          </span>
          <span class="more">
            <button type="button" data-act="tag" aria-label="打标签 (T)">标签<kbd class="key">T</kbd></button>
            ${basketBtn}${askBtn}
            <button type="button" data-act="select" class="${S.selected.has(b) ? "on" : ""}" aria-pressed="${S.selected.has(b)}" aria-label="选中 (X)">选中<kbd class="key">X</kbd></button>
          </span>`}
        </div>
      </div>
    </div>
  </article>`;
}

// 已出分拣范围: when and why the video left. 「10月5日 17:25」 this year, 「2025年10月5日」 before.
function leftText(it) {
  const d = new Date(it.removedAt);
  const day = `${d.getMonth() + 1}月${d.getDate()}日`;
  const when = d.getFullYear() === new Date().getFullYear() ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getFullYear()}年${day}`;
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

function folderTitle() {
  if (S.mediaId === ALL) return "所有收藏夹";
  if (S.mediaId === REMOVED) return "已出分拣范围";
  return S.folders.find((f) => String(f.id) === String(S.mediaId))?.title || "收藏夹";
}

function setFocus(bvid, scroll = true) {
  S.focused = bvid;
  const list = visibleItems();
  S.focusIndex = Math.max(0, list.findIndex((it) => it.bvid === bvid));
  for (const node of el.list.querySelectorAll(".card.focused")) node.classList.remove("focused");
  const card = el.list.querySelector(`.card[data-bvid="${CSS.escape(bvid)}"]`);
  if (card) {
    card.classList.add("focused");
    if (scroll) card.scrollIntoView({ block: "nearest" });
  }
}

const pointerMoved = (at, x, y) => !at || at.x !== x || at.y !== y;

function moveFocus(delta) {
  const list = visibleItems();
  if (!list.length) return;
  const i = list.findIndex((it) => it.bvid === S.focused);
  const next = Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i + delta)));
  setFocus(list[next].bvid);
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
function pushUndo(entry) {
  S.undo.push(entry);
  if (S.undo.length > BocLimits.TRIAGE_UNDO_STEPS) S.undo.shift();
}
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

const deciding = new Set(); // bvids with an unfav request in flight
const moving = new Set(); // bvids with a 移动/复制/收藏到 request in flight
async function decide(bvid, action) {
  const it = S.itemMap.get(bvid);
  if (!it || deciding.has(bvid) || moving.has(bvid)) return;
  if (action === "unfav" && S.transferRun?.bvids.has(bvid)) return toast(`这个视频在等待${S.transferRun.verb}，结束后再取消收藏`, true);
  const prev = S.decisions[bvid] || null;
  if (prev?.action === action) return;
  if (prev?.action === "unfav") {
    toast("这个视频已取消收藏，按 U 撤销后再改", true);
    return;
  }
  const before = visibleItems();
  const token = S.folderToken;
  if (action === "keep") {
    patchKept({ [bvid]: { action, at: Date.now() } });
    pushUndo({ kind: "keepMany", bvids: [bvid] });
    toast(`已保留《${shortTitle(it)}》 · U 撤销`);
    render();
    advanceFrom(bvid, before);
    return;
  }
  // 所有收藏夹 items carry .folders: 取消收藏 asks which when there are several.
  let folders = it.folders ? [...it.folders] : [S.mediaId];
  if (folders.length > 1) folders = await pickUnfavFolders(it);
  if (folders.length) {
    deciding.add(bvid);
    render();
    const done = [];
    for (const f of folders) {
      const r = await send({ type: "triage-unfav", mediaId: f, aids: [it.aid] });
      if (!r.ok) {
        toast(`取消收藏失败：${r.error}`, true);
        break;
      }
      bumpCount(f, -1);
      done.push(f);
    }
    deciding.delete(bvid);
    if (!done.length) render();
    folders = done;
  }
  if (!folders.length) return;
  const rec = unfavRecord(it, Date.now());
  const prevs = Object.fromEntries(folders.map((f) => [f, (f === S.mediaId ? S.decisions : S.folderDecisions[f])?.[bvid] || null]));
  for (const f of folders) await patchDecisions(f, { [bvid]: rec });
  // After a folder switch the record is saved under its folder; the undo entry would point at a video no longer listed.
  if (token !== S.folderToken) return;
  const left = it.folders ? (it.folders = it.folders.filter((f) => !folders.includes(f))) : [];
  if (it.folders) it.left = [...new Set([...(it.left || []), ...folders])];
  if (it.folders && !left.length) S.decisions[bvid] = rec;
  pushUndo({ kind: "decision", bvid, action, prev, prevs });
  const from = left.length ? `从「${folders.map(folderName).join("、")}」` : "";
  toast(`已${from}取消收藏《${shortTitle(it)}》 · U 撤销`);
  render();
  advanceFrom(bvid, before);
}

// U undoes the last step wherever it was; a step that changed several videos asks first, so a stray U costs nothing.
function batchUndoAsk(entry) {
  if (entry.kind === "mode") return entry.ask || null;
  const n = entry.kind === "keepMany" ? entry.bvids.length : entry.kind === "unfavMany" ? entry.items.length : entry.kind === "aiApply" ? entry.changes.length : 0;
  if (n < 2) return null;
  if (entry.kind === "keepMany") return [`撤销批量保留？`, `<p>上一步保留了 ${n} 个视频，撤销后它们不再标为保留。</p>`];
  if (entry.kind === "unfavMany") return [`撤销批量取消收藏？`, `<p>会把 ${n} 个视频重新收藏回 B站。</p>`];
  return [`撤销这次 AI 打标签？`, `<p>这次 AI 打标签改过的 ${n} 个视频，标签都改回 AI 打之前，包括你之后又改过的。</p>`];
}

async function undo() {
  const top = S.undo.at(-1);
  const ask = top && batchUndoAsk(top);
  if (ask && (!(await askConfirm(ask[0], ask[1], "撤销")) || S.undo.at(-1) !== top)) return;
  const entry = S.undo.pop();
  if (!entry) {
    toast("没有可撤销的操作");
    return;
  }
  // A step of another mode (关注's tags): it undoes itself and redraws its own view.
  if (entry.kind === "mode") return toast(await entry.undo());
  if (entry.kind === "decision") {
    const it = S.itemMap.get(entry.bvid);
    const token = S.folderToken;
    if (entry.action === "unfav") toast(`正在重新收藏《${shortTitle(it)}》…`);
    for (const [mediaId, prev] of Object.entries(entry.prevs)) {
      if (entry.action === "unfav") {
        const r = await send({ type: "triage-refav", mediaId, aid: it.aid });
        if (!r.ok) {
          if (token === S.folderToken) toast(`撤销失败：${r.error}。可到 B站手动重新收藏`, true);
          return;
        }
        bumpCount(mediaId, 1);
      }
      await patchDecisions(mediaId, { [entry.bvid]: prev });
    }
    if (token !== S.folderToken) return;
    if (it.folders) {
      if (entry.action === "unfav") {
        it.folders = [...new Set([...it.folders, ...Object.keys(entry.prevs)])];
        it.left = (it.left || []).filter((f) => !it.folders.includes(f));
      }
      if (entry.prev) S.decisions[entry.bvid] = entry.prev;
      else delete S.decisions[entry.bvid];
    }
    toast(`已撤销：${entry.action === "unfav" ? "重新收藏" : "取消保留"}《${shortTitle(it)}》`);
    S.focused = entry.bvid;
  } else if (entry.kind === "unfavMany") {
    const mediaId = String(S.mediaId);
    const { n, rest, error } = await refavMany(mediaId, entry.items);
    // Elsewhere the ones left stay listed under their folder's 最近取消收藏.
    const here = S.mediaId === mediaId;
    const where = here ? "" : `「${folderName(mediaId)}」`;
    if (error && here) {
      pushUndo({ kind: "unfavMany", items: rest });
      toast(`撤销中断（已重新收藏 ${n} 个，剩余 ${rest.length} 个可再按 U 重试）：${error}`, true);
    } else if (error) toast(`${where}撤销中断（已重新收藏 ${n} 个，剩余 ${rest.length} 个在它的最近取消收藏里）：${error}`, true);
    else toast(`${where}已重新收藏 ${n} 个`);
  } else if (entry.kind === "basket") {
    for (const { i, x } of entry.removed) if (!S.basket.some((y) => y.bvid === x.bvid)) S.basket.splice(i, 0, x);
    saveBasket();
    toast(`已撤销：放回播放列表 ${entry.removed.length} 个`);
    render();
  } else if (entry.kind === "keepMany") {
    patchKept(Object.fromEntries(entry.bvids.map((b) => [b, null])));
    const it = entry.bvids.length === 1 && S.itemMap.get(entry.bvids[0]);
    toast(it ? `已撤销：取消保留《${shortTitle(it)}》` : `已撤销批量保留 ${entry.bvids.length} 个`);
    if (it) S.focused = it.bvid;
  } else if (entry.kind === "tags") {
    writeVideoTags(entry.bvid, entry.prev);
    saveVideoTags();
    toast("已撤销标签修改");
    S.focused = entry.bvid;
  } else if (entry.kind === "aiApply") {
    // Every video the batch changed goes back to before it, edits made since included; a tag deleted since stays gone.
    for (const c of entry.changes) writeVideoTags(c.bvid, c.before.filter((id) => tagById(id)));
    const used = new Set(Object.values(S.videoTags).flat());
    S.tags = S.tags.filter((t) => !entry.created.includes(t.id) || used.has(t.id));
    for (const id of [...S.tagFilter]) if (!tagById(id)) S.tagFilter.delete(id);
    saveTags();
    saveVideoTags();
    // Another tab, or a later batch here, may have replaced the folder's 「AI 刚打的」 since.
    if (S.aiRecent[entry.folder]?.at === entry.at) endAiRecent(entry.folder);
    toast(`已撤销 AI 打标签：${entry.changes.length} 个视频改回 AI 打之前`);
  }
  render();
  setFocus(S.focused);
}

// Batch buttons act on the selected cards of the tab, otherwise on every card with this verdict (none without one).
function batchList(verdict) {
  const list = visibleItems().filter((it) => !isProcessed(it.bvid));
  const sel = selectedIn(list);
  return sel.length ? sel : verdict == null ? [] : list.filter((it) => verdictOf(it).verdict === verdict);
}

async function batchUnfav(list) {
  if (!list.length || S.unfavBatch || S.transferRun) return;
  const titles = list.slice(0, 10).map((it) => `<li>${esc(it.title)}</li>`).join("");
  const more = list.length > 10 ? `<p>等 ${list.length} 个</p>` : "";
  const ok = await askConfirm(`取消收藏这 ${list.length} 个视频？`, `<ul>${titles}</ul>${more}`, `取消收藏 ${list.length} 个`, { danger: true });
  if (!ok || S.unfavBatch) return;
  // It changes Bilibili, so it runs to the end even after another folder opens.
  const mediaId = String(S.mediaId);
  const batch = Date.now();
  let done = 0;
  S.unfavBatch = { mediaId, done, total: list.length };
  for (let i = 0; i < list.length; i += 20) {
    const chunk = list.slice(i, i + 20);
    S.unfavBatch.done = done;
    chunk.forEach((it) => deciding.add(it.bvid));
    render();
    const r = await send({ type: "triage-unfav", mediaId, aids: chunk.map((it) => it.aid) });
    chunk.forEach((it) => deciding.delete(it.bvid));
    if (!r.ok) {
      toast(`${S.mediaId === mediaId ? "" : `「${folderName(mediaId)}」`}批量取消收藏失败（已完成 ${done} 个）：${r.error}`, true);
      break;
    }
    markWritten(mediaId);
    bumpCount(mediaId, -chunk.length);
    const at = Date.now();
    await patchDecisions(mediaId, Object.fromEntries(chunk.map((it) => [it.bvid, unfavRecord(it, at, batch)])));
    done += chunk.length;
    if (i + 20 < list.length) await new Promise((r2) => setTimeout(r2, 1000));
  }
  S.unfavBatch = null;
  if (done && S.mediaId === mediaId) {
    pushUndo({ kind: "unfavMany", items: list.slice(0, done).map(({ bvid, aid }) => ({ bvid, aid })) });
    for (const it of list.slice(0, done)) S.selected.delete(it.bvid);
    toast(`已取消收藏 ${done} 个 · U 撤销`);
  } else if (done) {
    // Elsewhere they are saved under their folder and listed in its 最近取消收藏, where they can be re-favorited.
    toast(`「${folderName(mediaId)}」已取消收藏 ${done} 个，可在它的最近取消收藏里撤销`);
  }
  render();
}

// 移动/复制 takes every selected card still in the folder here, 保留 ones too (unlike 取消收藏, which skips them).
const transferList = () => selectedIn(visibleItems()).filter((it) => it.aid && S.decisions[it.bvid]?.action !== "unfav");

// Resolves { move, target } (target: { id } or { create, privacy }), or null when cancelled.
function askTransfer(list) {
  const from = String(S.mediaId);
  const add = from === REMOVED;
  const targets = S.allFolders.filter((f) => String(f.id) !== from && String(f.id) !== TOVIEW);
  el.transferTitle.textContent = add ? `把这 ${list.length} 个视频收藏到` : `移动或复制这 ${list.length} 个视频`;
  el.transferHow.hidden = add;
  for (const btn of el.transferDialog.querySelectorAll("button[value=copy], button[value=move]")) btn.hidden = add;
  el.transferDialog.querySelector("button[value=add]").hidden = !add;
  const noAid = selectedIn(visibleItems()).filter((it) => !it.aid).length;
  el.transferBody.innerHTML = `<ul>${list.slice(0, 10).map((it) => `<li>${esc(it.title)}</li>`).join("")}</ul>${list.length > 10 ? `<p>等 ${list.length} 个</p>` : ""}${noAid ? `<p class="dialog-hint">另有 ${noAid} 个缺少视频编号（很早以前留下的记录），不能${add ? "收藏" : "移动或复制"}。</p>` : ""}`;
  el.transferTarget.innerHTML =
    targets.map((f) => `<option value="${esc(f.id)}">${esc(f.title)} (${esc(f.count)})</option>`).join("") + `<option value="new">新建收藏夹…</option>`;
  el.transferName.value = "";
  el.transferPrivate.checked = false;
  toggleTransferNew();
  el.transferDialog.returnValue = "";
  el.transferDialog.showModal();
  return new Promise((resolve) => {
    el.transferDialog.addEventListener(
      "close",
      () => {
        const how = el.transferDialog.returnValue;
        if (!["move", "copy", "add"].includes(how)) return resolve(null);
        const v = el.transferTarget.value;
        resolve({ how, target: v === "new" ? { create: el.transferName.value.trim(), privacy: el.transferPrivate.checked } : { id: v } });
      },
      { once: true }
    );
  });
}
function toggleTransferNew() {
  const v = el.transferTarget.value;
  const on = v === "new";
  el.transferNewRow.hidden = !on;
  el.transferName.required = on;
  const out = !on && !S.included.includes(v);
  el.transferUnchosen.hidden = !out;
  if (out) {
    el.transferUnchosen.innerHTML = S.mediaId === REMOVED
      ? `「${esc(folderName(v))}」没有勾选分拣：收藏后这些视频仍在「已出分拣范围」。<br>以后在收藏夹设置里勾选它，会自动找回。`
      : `「${esc(folderName(v))}」没有勾选分拣：移动过去的视频会进「已出分拣范围」。<br>以后在收藏夹设置里勾选它，这些视频会自动找回。复制不受影响。`;
  }
}

// Folders are not read while a run writes them (writingTo), so both cached lists change here instead of by a sync: the target
// gains the videos (a new folder starts with exactly these), the source loses them without counting them as having left
// every folder (已出分拣范围). A folder with no cached list is left to its first load.
function patchSnapshot(mediaId, { add = [], drop = [] }, created = false) {
  return serialStore(async () => {
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
    for (const b of drop) left[b] = { ...left[b], [String(mediaId)]: { title: folderName(mediaId), at: Date.now() } };
    await chrome.storage.local.set({
      [K.left]: left,
      [key]: {
        ...old,
        bvids: [...added, ...old.bvids.filter(keep)],
        invalid: (old.invalid || []).filter(keep),
        titles: { ...old.titles, ...Object.fromEntries(fresh.map((it) => [it.bvid, it.title])) },
        items: [...fresh, ...(old.items || []).filter((it) => keep(it.bvid))],
        ids: old.ids ? [...added, ...old.ids.filter(keep)] : old.ids,
        at: Date.now()
      }
    });
  });
}

// It changes Bilibili, so like 取消收藏 it runs to the end even after another folder opens.
async function batchTransfer(list) {
  if (!list.length || S.transferRun || S.unfavBatch) return;
  const from = String(S.mediaId);
  const ask = await askTransfer(list);
  if (!ask || S.transferRun || S.unfavBatch) return;
  const { how, target } = ask;
  const add = how === "add"; // from 已出分拣范围: no source folder on Bilibili
  const move = how === "move";
  const verb = { move: "移动", copy: "复制", add: "收藏" }[how];
  let to = target.id;
  let toName = folderName(to);
  if (target.create) {
    const r = await send({ type: "triage-folder-create", title: target.create, privacy: target.privacy });
    if (!r.ok) return toast(`新建收藏夹失败：${r.error}`, true);
    to = String(r.data.id);
    toName = r.data.title;
    // Chosen for triage right away, without reloading the folder list.
    const f = { id: Number(to), title: toName, count: 0 };
    S.allFolders.push(f);
    S.folders.push(f);
    S.included = [...S.included, to];
    await chrome.storage.local.set({ [K.included]: S.included });
  }
  // From 稍后再看 or 已出分拣范围 Bilibili takes one video per request: one per chunk keeps the count exact on a failure.
  const one = add || from === TOVIEW;
  const size = one ? 1 : 20;
  let done = 0;
  S.transferRun = { mediaId: from, to, verb, toName, done, total: list.length, bvids: new Set(list.map((it) => it.bvid)) };
  for (let i = 0; i < list.length; i += size) {
    const chunk = list.slice(i, i + size);
    // Read per chunk: ticking or unticking the target meanwhile takes effect for the rest.
    const chosen = S.included.includes(to);
    S.transferRun.done = done;
    chunk.forEach((it) => moving.add(it.bvid));
    render();
    const r = await send({ type: "triage-transfer", from: add ? "" : from, to, aids: chunk.map((it) => it.aid), move });
    chunk.forEach((it) => moving.delete(it.bvid));
    if (!r.ok) {
      toast(`${S.mediaId === from ? "" : `「${folderName(from)}」`}${verb}到「${toName}」中断（已完成 ${done} 个）：${r.error}`, true);
      break;
    }
    markWritten(from, to);
    bumpCount(to, chunk.length);
    if (move) bumpCount(from, -chunk.length);
    // Both cached lists follow each chunk; neither folder is read from Bilibili until the run settles (writingTo).
    if (chosen) await patchSnapshot(to, { add: chunk.map(({ removedAt, movedTo, hidden, from, ...it }) => it) }, Boolean(target.create));
    if (add) {
      if (chosen) await dropRemoved(chunk.map((it) => it.bvid));
      else await addMovedToRemoved(from, chunk.map(({ removedAt, movedTo, hidden, from, ...it }) => it), { id: to, title: toName });
    }
    if (move) {
      const gone = new Set(chunk.map((it) => it.bvid));
      await patchSnapshot(from, { drop: [...gone] });
      if (!chosen) await addMovedToRemoved(from, chunk, { id: to, title: toName });
      if (S.mediaId === from) {
        S.items = S.items.filter((it) => !gone.has(it.bvid));
        S.itemMap = new Map(S.items.map((it) => [it.bvid, it]));
      }
    }
    for (const it of chunk) S.selected.delete(it.bvid);
    done += chunk.length;
    if (i + size < list.length) await new Promise((r2) => setTimeout(r2, one ? 300 : 1000));
  }
  S.transferRun = null;
  // A folder-list load meanwhile (分拣设置 saved) may have listed it already, or dropped it while Bilibili lagged.
  const made = target.create && S.allFolders.find((x) => String(x.id) === to);
  if (made && !el.folderSelect.querySelector(`option[value="${to}"]`)) {
    el.folderSelect.querySelector(`option[value="${REMOVED}"]`)?.previousElementSibling?.before(new Option(`${toName} (${made.count})`, to));
  }
  if (done === list.length) {
    const where = S.mediaId === from ? "" : `「${folderName(from)}」`;
    toast(`${where}已${verb} ${done} 个到「${toName}」${(move || add) && !S.included.includes(to) ? "，它们在「已出分拣范围」里，勾选这个收藏夹后会自动找回" : ""}`);
  }
  render();
}

// Moved to a folder outside triage: like any video that left every chosen folder, it goes to 已出分拣范围, marked with
// where it went. Ticking that folder brings it back (recoverRemoved).
function addMovedToRemoved(from, items, movedTo) {
  return serialStore(async () => {
    const others = S.folders.map((f) => String(f.id)).filter((id) => id !== from);
    const got = await chrome.storage.local.get([K.removed, K.left, ...others.map(K.snapshot)]);
    const otherBvids = new Set(others.flatMap((id) => got[K.snapshot(id)]?.bvids || []));
    const at = Date.now();
    const source = from === REMOVED ? null : { id: from, title: folderName(from) };
    const { removed, left } = moveToRemoved(got[K.removed] || {}, got[K.left] || {}, items, otherBvids, source, at, movedTo);
    await chrome.storage.local.set({ [K.removed]: removed, [K.left]: left });
    if (S.mediaId === REMOVED) {
      for (const it of items) {
        const rec = removed[it.bvid];
        if (!rec) continue;
        const shown = S.itemMap.get(it.bvid);
        if (shown) Object.assign(shown, { removedAt: at, movedTo, from: rec.from });
        else S.items.unshift({ ...it, removedAt: at, movedTo, from: rec.from });
      }
      S.itemMap = new Map(S.items.map((x) => [x.bvid, x]));
    }
    S.removedCount = Object.keys(removed).length;
    renderTop();
  });
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
  pushUndo({ kind: "keepMany", bvids: list.map((it) => it.bvid) });
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
  pushUndo({ kind: "tags", bvid, prev });
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
const aiRecentSet = () => new Set(S.aiRecent[String(S.mediaId)]?.bvids || []);
const saveAiRecent = () => storeSet(K.aiRecent, S.aiRecent);
// × and U end the folder's 「AI 刚打的」; × leaves the tags as they are.
function endAiRecent(folder = String(S.mediaId)) {
  delete S.aiRecent[folder];
  if (folder === String(S.mediaId)) S.aiRecentFilter = false;
  saveAiRecent();
}

// T on a card opens the shared picker (tag-picker.js) as a modal; T in the player or 「+ 标签」 on the viewer line opens
// it under that line. One video at a time; closing saves once, as one undo step.
function openPicker(bvid, anchor = "") {
  const it = S.itemMap.get(bvid);
  if (!it || S.mediaId === REMOVED) return;
  const folders = pickerFolders(bvid);
  const one = folders.length === 1;
  TagPicker.open({
    title: `打标签 ·《${shortTitle(it)}》`,
    targets: [bvid],
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

function savePicked(changes) {
  for (const c of changes) {
    const prev = (S.videoTags[c.key] || []).filter((id) => tagById(id));
    if (setVideoTags(c.key, TagPicker.applyChange(prev, c), prev)) toast("标签已更新 · U 撤销");
  }
  render();
  setFocus(S.focused, true);
}

// The viewer's second line, as 关注's: the playing video's tags and 「+ 标签 T」; a tag opens the picker too.
function renderViewerTags() {
  const it = !followMode() && S.viewing && S.itemMap.get(S.viewing);
  el.viewerTags.hidden = !it;
  if (!it) return void (el.viewerTags.innerHTML = "");
  const edit = S.mediaId !== REMOVED;
  const chips = tagIdsOf(it.bvid)
    .map(tagById)
    .map((t) => `<span class="chip" style="--c:${esc(t.color)}"${edit ? " data-vtag" : ""}>${esc(t.name)}</span>`)
    .join("");
  el.viewerTags.innerHTML = (chips || `<span class="none">未打标签</span>`) + (edit ? `<span class="sep">·</span>${UI.tagPlusBtn("data-vtag", "给这个视频打标签")}` : "");
}
const tagPlaying = () => S.viewing && openPicker(S.viewing, "#viewerTags .tag-plus");

// ---------- 判断标准 ----------
function openCriteria() {
  el.criteriaTitle.textContent = `判断标准 ·「${folderTitle()}」`;
  el.criteriaInput.value = criteria();
  el.criteriaDialog.returnValue = "";
  el.criteriaDialog.showModal();
  el.criteriaInput.focus();
}

async function saveCriteria() {
  const text = el.criteriaInput.value.trim();
  const changed = text !== criteria();
  if (text) S.folderCriteria[S.mediaId] = text;
  else delete S.folderCriteria[S.mediaId];
  storeSet(K.folderCriteria, S.folderCriteria);
  render();
  const stale = staleCoarse();
  if (!changed || !stale.length || S.stage1.running || S.group) return;
  const ok = await askConfirm(
    "判断标准改了",
    `<p>「粗看完成」里有 ${stale.length} 个视频是按旧标准粗看的，要按新标准重新粗看吗？</p><p>已细看和已处理的视频不动；细看完成页可以另外按新标准重新细看。</p>`,
    "重新粗看"
  );
  if (ok) runStage1(stale);
}

// ---------- 标签 dialog: 管理 / 批量打 ----------
// 标签管理 (tag row) opens 管理, ✦ AI 打标签 (tag row) opens AI 打标签: one dialog, two sections.

function openTags(mode = "manage") {
  S.ai.excluded.clear();
  showTagsMode(mode);
  el.tagsDialog.showModal();
  if (mode === "manage") el.newTagInput.focus();
}

function showTagsMode(mode) {
  const manage = mode === "manage";
  el.tagsModeManage.setAttribute("aria-pressed", String(manage));
  el.tagsModeBatch.setAttribute("aria-pressed", String(!manage));
  el.tagsManage.hidden = !manage;
  if (!manage) return S.ai.proposal && !S.ai.running ? showAiReview() : showAiForm();
  el.aiForm.hidden = el.aiReview.hidden = true;
  renderTagManager();
}

// A rename, rule or color edit from 管理; false (and nothing saved) for an empty or duplicate name.
function saveTagEdit(t, field, value) {
  const text = field === "name" ? cleanTagName(value) : String(value ?? "").trim();
  if (field === "name") {
    const why = UI.tagNameError(text, S.tags.filter((x) => x !== t && x.folder === t.folder));
    if (why) {
      toast(why, true);
      return false;
    }
    t.name = text;
  } else if (field === "color") t.color = UI.cycleTagColor(t.color);
  else if (field === "rule") {
    if (text) t.rule = text.slice(0, 80);
    else delete t.rule;
  } else return false;
  saveTags();
  render();
  return true;
}

function renderTagManager() {
  const own = inFolderView();
  el.newTagInput.disabled = el.addTagBtn.disabled = !own;
  if (!own) return (el.tagsRows.innerHTML = `<p class="muted">${FOLDER_ONLY}</p>`);
  const counts = {};
  for (const ids of Object.values(S.videoTags)) for (const id of ids) counts[id] = (counts[id] || 0) + 1;
  const tags = viewTags();
  el.tagsRows.innerHTML = tags.length
    ? tags.map((t) => UI.tagRowHtml(t, { count: counts[t.id] || 0, who: "视频" })).join("")
    : `<p class="muted">这个收藏夹还没有自定义标签</p>`;
}

async function deleteTag(id) {
  const t = tagById(id);
  const n = Object.values(S.videoTags).filter((ids) => ids.includes(id)).length;
  const ok = await askConfirm(...UI.deleteTagAsk(t, n, "视频"), "删除", { danger: true });
  if (!ok) return;
  S.tags = S.tags.filter((x) => x.id !== id);
  for (const [b, ids] of Object.entries(S.videoTags)) {
    const rest = ids.filter((x) => x !== id);
    if (rest.length) S.videoTags[b] = rest;
    else delete S.videoTags[b];
  }
  S.tagFilter.delete(id);
  S.undo = S.undo.filter((e) => e.kind !== "tags" && e.kind !== "aiApply");
  saveTags();
  saveVideoTags();
  renderTagManager();
  render();
}

// ---------- AI stage 1: titles ----------
function aiItem(it) {
  return { bvid: it.bvid, title: it.title, upper: it.upper, duration: it.duration, pubdate: it.pubdate, intro: it.intro };
}

async function throttleWait(code, keepGoing) {
  const [ms, label] = THROTTLES[code];
  S.throttleUntil = Date.now() + ms;
  S.throttleLabel = label;
  renderStatus();
  await sleepWhile(ms, keepGoing);
  S.throttleUntil = 0;
  renderStatus();
}

const stage1Pending = () => S.items.filter((it) => stageOf(it) === "none" && !S.stage1Skip.has(it.bvid));

// list: 未分析 by default; 重新粗看 passes the cards whose 粗看 used an older 判断标准. Their old results stay on the
// cards until new ones replace them, so a stopped or failed run loses nothing.
async function runStage1(list = stage1Pending()) {
  if (S.stage1.running) return;
  // Everything the run needs is taken now: it keeps going after another folder opens.
  const folder = String(S.mediaId);
  const crit = criteria();
  const ctx = folderContext();
  // Due: no 粗看 yet, or one made under another 判断标准.
  const due = (it) => {
    const r = S.titleRes[it.bvid];
    return !VERDICTS[r?.verdict] || (r.criteria ?? crit) !== crit;
  };
  // Timed-out batches are skipped for this run only, so clicking 标题粗看 again retries them.
  const timedOut = new Set();
  // In its own folder the live step decides (a card may have been sorted meanwhile); elsewhere only the result does.
  const pending = () =>
    list.filter((it) => !timedOut.has(it.bvid) && !S.stage1Skip.has(it.bvid) && !it.invalid && due(it) && (S.mediaId !== folder || ["none", "coarse"].includes(stageOf(it))));
  const total = pending().length;
  // The run owns its line (text); the activity bar reads it, in its folder or as a hint elsewhere.
  S.stage1 = { running: true, stop: false, done: 0, total, mediaId: folder, text: "" };
  const keepGoing = () => !S.stage1.stop;
  const size = Math.max(1, Number(S.settings.triageTitleBatchSize) || 30);
  let done = 0;
  let retried = false;
  let failedOut = false;
  render();
  while (keepGoing()) {
    const batch = pending().slice(0, size);
    if (!batch.length) break;
    S.stage1.text = `标题粗看中 ${done}/${total}`;
    for (const it of batch) S.analyzing.add(it.bvid);
    render();
    const r = await send({ type: "triage-classify-titles", items: batch.map(aiItem), criteria: crit, folder: ctx });
    for (const it of batch) S.analyzing.delete(it.bvid);
    if (!r.ok) {
      if (THROTTLES[r.code]) {
        await throttleWait(r.code, keepGoing);
        continue;
      }
      if (r.code === "AI_TIMEOUT") {
        // First timeout retries the same batch; a second one skips it and moves on.
        retried = !retried;
        if (retried) continue;
        batch.forEach((it) => timedOut.add(it.bvid));
        toast(r.error, true);
        continue;
      }
      handleAiError(r.error);
      failedOut = true;
      break;
    }
    retried = false;
    const results = r.data?.results || {};
    for (const it of batch) {
      if (results[it.bvid]) S.titleRes[it.bvid] = { criteria: crit, ...results[it.bvid] };
      else S.stage1Skip.add(it.bvid);
    }
    done += batch.length;
    S.stage1.done = done;
    render();
    if (pending().length) await sleepWhile(S.settings.triageIntervalSec * 1000, keepGoing);
  }
  S.stage1.running = false;
  if (!failedOut) clearAiBanner();
  S.stage1.text = timedOut.size
    ? `标题粗看完成 ${done} 个，${timedOut.size} 个因 AI 超时跳过，再点标题粗看可重试`
    : done ? `标题粗看完成 ${done} 个` : "";
  if (S.stage1.text && runWhere(S.stage1)) toast(`「${folderName(folder)}」${S.stage1.text}`);
  render();
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
    stop: false,
    redo: redo ? new Set(bvids) : null,
    mediaId: String(S.mediaId),
    items: new Map(bvids.map((b) => [b, S.itemMap.get(b)])),
    crit: criteria(),
    ctx: folderContext()
  };
  runGroup();
}

const groupPending = (group, b) => (group.redo ? group.redo.has(b) : needsAnalysis(b, group));
const groupDone = (group) => group.bvids.filter((b) => !groupPending(group, b)).length;

async function analyzeOne(bvid, force = false, crit = criteria(), ctx = folderContext()) {
  S.analyzing.add(bvid);
  render();
  const r = await send({ type: "triage-analyze", bvid, force, criteria: crit, folder: ctx });
  S.analyzing.delete(bvid);
  return r;
}

async function runGroup() {
  const group = S.group;
  const keepGoing = () => !group.stop && S.group === group;
  render();
  while (keepGoing()) {
    const b = group.bvids.find((x) => groupPending(group, x));
    if (!b) break;
    group.text = `${group.redo ? "按新标准重新细看" : "字幕细看"} ${groupDone(group) + 1}/${group.bvids.length}`;
    const r = await analyzeOne(b, Boolean(group.redo), group.crit, group.ctx);
    if (!r.ok && THROTTLES[r.code]) {
      render();
      await throttleWait(r.code, keepGoing);
      continue;
    }
    group.redo?.delete(b);
    const keepOld = !r.ok && group.redo && S.analyses[b]?.status === "done";
    if (keepOld) toast(`重新细看失败，保留原来的结果：${r.error}`, true);
    else S.analyses[b] = r.ok ? { criteria: group.crit, ...r.data } : { bvid: b, status: "error", error: r.error };
    const err = r.ok ? "" : String(r.error || "");
    if (/配置 AI|截断|未授权访问/.test(err)) handleAiError(err);
    if (/配置 AI|未授权访问/.test(err)) group.stop = true;
    render();
    if (group.bvids.some((x) => groupPending(group, x))) await sleepWhile(S.settings.triageIntervalSec * 1000, keepGoing);
  }
  if (S.group !== group) return;
  // A run that stopped on a setup error keeps its banner; any other finished batch clears it.
  if (!group.stop) clearAiBanner();
  S.group = null;
  if (runWhere(group) && !group.stop) toast(`「${folderName(group.mediaId)}」这批字幕细看完成`);
  render();
}

// Failed results live only on this page; dropping them puts the cards back in the batch runner.
function retryFailed() {
  const failed = visibleItems().filter((it) => failedAnalysis(it.bvid)).map((it) => it.bvid);
  for (const b of failed) delete S.analyses[b];
  startGroup(failed);
}

async function retry(bvid) {
  const r = await analyzeOne(bvid, true);
  if (!r.ok) {
    S.analyses[bvid] = { bvid, status: "error", error: r.error };
    if (THROTTLES[r.code]) toast(`${THROTTLES[r.code][1]}，请稍后再试`, true);
    else handleAiError(r.error);
  } else {
    S.analyses[bvid] = { criteria: criteria(), ...r.data };
  }
  render();
}

// ---------- AI command ----------
const isAnalyzed = (it) => S.analyses[it.bvid]?.status === "done";

function aiScopeItems() {
  const scope = el.aiScope.value;
  if (scope === "selected") return visibleSelected();
  if (scope === "analyzed") return visibleItems().filter(isAnalyzed);
  return visibleItems();
}

function aiCommandItem(it) {
  const out = aiItem(it);
  const a = S.analyses[it.bvid];
  if (isAnalyzed(it)) {
    out.oneLiner = a.oneLiner || "";
    out.points = a.points || [];
  }
  const own = new Set(viewTags().map((t) => t.id));
  const names = tagIdsOf(it.bvid).filter((id) => own.has(id) && !S.ai.excluded.has(id)).map((id) => tagById(id).name);
  if (names.length) out.currentTags = names;
  return out;
}

function showAiForm() {
  el.aiForm.hidden = false;
  el.aiReview.hidden = true;
  renderAiForm();
}

function showAiReview() {
  el.aiForm.hidden = true;
  el.aiReview.hidden = false;
  renderAiReview();
}

function renderAiForm() {
  const counts = { filter: visibleItems().length, selected: visibleSelected().length, analyzed: visibleItems().filter(isAnalyzed).length };
  const labels = { filter: "当前筛选", selected: "选中", analyzed: "细看过的" };
  for (const o of el.aiScope.options) {
    o.textContent = `${labels[o.value]} · ${counts[o.value]} 个`;
    o.disabled = !counts[o.value];
  }
  if (el.aiScope.selectedOptions[0]?.disabled) el.aiScope.value = "filter";
  el.aiFormRemoveTagsInput.checked = S.settings.triageAiRemoveTags === true;
  const items = aiScopeItems();
  const n = items.length;
  const done = items.filter(isAnalyzed).length;
  const size = Math.max(1, Number(S.settings.triageTitleBatchSize) || 30);
  const parts = [done && `${done} 个细看过（按总结和要点判断）`, n - done && `${n - done} 个只有标题和简介，标签可能不准`].filter(Boolean);
  el.aiScopeCount.textContent = n ? `${n} 个视频：${parts.join("，")}。分 ${Math.ceil(n / size)} 批发送` : "作用范围里没有视频";
  const tags = viewTags();
  const room = aiNewTagRoom();
  const noneUsable = tags.length > 0 && tags.every((t) => S.ai.excluded.has(t.id));
  const roomHint = noneUsable
    ? room ? `已有标签都不给 AI 用，AI 只会新建标签（这次最多 ${room} 个），你确认后才创建。` : "已有标签都不给 AI 用，名额也满了，AI 打不了标签。"
    : room ? `AI 这次最多新建 ${room} 个（这个收藏夹还剩 ${tagLimit() - tags.length} 个名额），你确认后才创建。` : "名额已满，AI 只会用已有标签。";
  const useChip = (t) => {
    const on = !S.ai.excluded.has(t.id);
    return `<button type="button" class="chip tag-use${on ? " on" : ""}" style="--c:${esc(t.color)}" data-use="${esc(t.id)}" aria-pressed="${on}" title="${on ? "点一下：这次不让 AI 用" : "点一下：让 AI 用"}">${esc(t.name)}</button>`;
  };
  el.aiTagsPreview.innerHTML = !inFolderView()
    ? `<p class="dialog-hint">${FOLDER_ONLY}再让 AI 打标签。</p>`
    : tags.length
      ? `<span id="aiTagsLabel" class="grid-label">可用标签</span><div class="chips" role="group" aria-labelledby="aiTagsLabel">${tags.map(useChip).join("")}</div><p class="dialog-meta">点掉的标签这次不给 AI 用。<br>${roomHint}</p>`
      : `<p class="dialog-hint">这个收藏夹还没有自定义标签。${roomHint}想打得准，先在<button type="button" class="link" data-tags-mode="manage">「管理」</button>里建好标签、每个写一句说明。</p>`;
  el.aiHistory.innerHTML = S.aiHistory.length
    ? `<span class="muted">最近：</span>` +
      S.aiHistory
        .map((h, i) => `<button type="button" class="chip" data-h="${i}" title="${esc(h)}" aria-label="使用指令 ${esc(h)}">${esc(h.length > 18 ? `${h.slice(0, 18)}…` : h)}</button>`)
        .join("")
    : "";
  if (S.ai.running && S.ai.mediaId !== String(S.mediaId)) {
    el.aiScopeCount.textContent = `正在处理「${folderName(S.ai.mediaId)}」的视频，完成后可在状态栏点「查看」确认`;
    el.aiTagsPreview.innerHTML = "";
  }
  setBusy(el.aiRunBtn, S.ai.running && "运行中…");
  el.aiStopBtn.hidden = !S.ai.running;
}

async function runAiCommand() {
  if (S.ai.running) return;
  const instruction = el.aiInstruction.value.trim();
  const items = aiScopeItems();
  if (!inFolderView()) {
    el.aiProgress.textContent = FOLDER_ONLY;
    return;
  }
  if (!instruction) {
    el.aiProgress.textContent = "请先写指令";
    el.aiInstruction.focus();
    return;
  }
  if (!items.length) {
    el.aiProgress.textContent = "作用范围里没有视频";
    return;
  }
  S.aiHistory = [instruction, ...S.aiHistory.filter((x) => x !== instruction)].slice(0, 5);
  storeSet(K.aiHistory, S.aiHistory);
  // Everything the run sends is taken now: the run outlives a folder switch, and the page then holds another folder.
  const folder = String(S.mediaId);
  const excluded = new Set(viewTags().filter((t) => S.ai.excluded.has(t.id)).map((t) => t.name));
  const opts = { maxNewTags: aiNewTagRoom(), allowRemove: S.settings.triageAiRemoveTags === true, folder, excluded };
  const tags = viewTags().filter((t) => !excluded.has(t.name)).map((t) => ({ name: t.name, rule: t.rule || "" }));
  const payload = items.map(aiCommandItem);
  const size = Math.max(1, Number(S.settings.triageTitleBatchSize) || 30);
  const scopeSet = new Set(items.map((it) => it.bvid));
  const total = Math.ceil(items.length / size);
  const p = { newTags: [], rows: [], notes: [], errors: [] };
  const keepGoing = () => !S.ai.stop;
  S.ai.running = true;
  S.ai.mediaId = folder;
  S.ai.stop = false;
  renderAiForm();
  renderTop();
  for (let i = 0; i < total && keepGoing(); i++) {
    el.aiProgress.textContent = `AI 正在处理第 ${i + 1} / ${total} 批…`;
    const batch = payload.slice(i * size, (i + 1) * size);
    const r = await send({ type: "triage-ai-command", instruction, items: batch, tags, maxNewTags: opts.maxNewTags, allowRemove: opts.allowRemove });
    if (!r.ok) {
      p.errors.push(`第 ${i + 1} 批失败：${r.error}`);
      if (/截断|配置 AI|未授权访问/.test(r.error || "")) handleAiError(r.error);
    } else {
      // not tagIdsOf: the open folder may have changed since the run started
      UI.mergeAiBatch(p, r.data, { ...opts, tags: S.tags.filter((t) => t.folder === folder), map: S.videoTags, scope: scopeSet });
    }
    if (i + 1 < total) await sleepWhile(S.settings.triageIntervalSec * 1000, keepGoing);
  }
  S.ai.running = false;
  el.aiProgress.textContent = "";
  if (S.ai.stop) p.errors.push("已手动停止，这里只有已完成批次的建议");
  for (const t of p.newTags) t.checked = p.rows.some((r) => r.add.includes(`new:${t.key}`));
  S.ai.proposals[folder] = p;
  renderTop();
  if (folder !== String(S.mediaId)) {
    if (el.tagsDialog.open) renderAiForm();
    toast(`「${folderName(folder)}」的标签建议已完成，在状态栏点「查看」确认`);
  } else if (el.tagsDialog.open && el.tagsManage.hidden) showAiReview();
  else toast("AI 打标签已完成，按 I 查看建议");
}

// What a proposal changes (shared.js); a video that left the folder since keeps its tags.
const rowChanges = (p, idOf = (key) => UI.previewId(p, key, viewTags())) => UI.aiChanges(p, S.videoTags, S.itemMap, idOf);
const tallyNow = (p) => UI.aiTally(p, rowChanges(p), (id) => tagById(id)?.name);

function renderAiReview() {
  const p = S.ai.proposal;
  el.aiNotes.innerHTML =
    p.errors.map((e) => `<p class="fail-text">${esc(e)}</p>`).join("") +
    p.notes.map((n) => `<p class="muted">AI 说明：${esc(n)}</p>`).join("");
  const uses = (t) => p.rows.filter((r) => S.itemMap.has(r.id) && r.add.includes(`new:${t.key}`)).length;
  el.aiNewTagsHead.hidden = !p.newTags.length;
  el.aiNewTags.innerHTML = p.newTags
    .map((t, i) => {
      const n = uses(t);
      return `<div class="ai-newtag" data-i="${i}">
      <input type="checkbox" data-nt="checked"${t.checked ? " checked" : ""} aria-label="创建标签 ${esc(t.name)}" />
      <input type="text" data-nt="name" value="${esc(t.name)}" maxlength="12" aria-label="新标签名称" />
      <span class="muted">${n ? `用在 ${n} 个视频` : "没有视频用到"}</span>
    </div>`;
    })
    .join("");
  renderAiRows();
}

function renderAiRows() {
  const p = S.ai.proposal;
  const n = rowChanges(p).length;
  const newTags = p.newTags.filter((t) => t.checked && cleanTagName(t.name)).length;
  el.aiReviewSummary.textContent = `· ${n} 个视频有改动 · 新标签 ${newTags} 个 · 点「应用」前不会改动任何东西`;
  const tally = tallyNow(p);
  el.aiRows.innerHTML = tally.length
    ? `<div class="chips">${tally.map((t) => `<span class="chip ${t.cls}">${esc(t.text)} <b>${t.n}</b></span>`).join("")}</div>`
    : `<p class="empty">AI 没有提出改动</p>`;
  el.aiApplyBtn.textContent = n ? `应用到 ${n} 个视频` : "应用";
  el.aiApplyBtn.setAttribute("aria-label", el.aiApplyBtn.textContent);
  el.aiApplyBtn.disabled = !n && !newTags;
}

function applyAiProposal() {
  const p = S.ai.proposal;
  if (!p) return;
  const hadTags = new Set(S.tags.map((t) => t.id));
  const idFor = {};
  for (const t of p.newTags) {
    if (t.checked && cleanTagName(t.name)) idFor[t.key] = createTag(t.name)?.id;
  }
  const changes = []; // [{ bvid, before }]: what U puts back
  for (const [bvid, before, after] of rowChanges(p, (key) => idFor[key])) {
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
  if (at || created.length) pushUndo({ kind: "aiApply", changes, created, folder, at });
  el.tagsDialog.close();
  render();
  toast(`已应用 AI 建议：${changes.length} 个视频，列表只显示这些 · U 撤销`);
}

// ---------- 播放列表 ----------
// triage_basket is the 播放列表 in order: [{ bvid, title, cover?, upper?, duration?, opened? }]; the copied
// fields show videos outside the open folder (entries from before they were copied have only the title).
const saveBasket = () => storeSet(K.basket, S.basket);

function toggleBasket(bvid) {
  const i = S.basket.findIndex((x) => x.bvid === bvid);
  const it = S.itemMap.get(bvid);
  if (i >= 0) {
    S.basket.splice(i, 1);
    toast("已移出播放列表");
  } else if (it) {
    S.basket.push({ bvid, title: it.title, cover: it.cover, upper: it.upper, duration: it.duration });
    toast(`已加入播放列表《${shortTitle(it)}》`);
    el.basket.classList.remove("bump");
    void el.basket.offsetWidth;
    el.basket.classList.add("bump");
  }
  saveBasket();
  render();
}

// The list keeps the order videos were added in. Opening one only marks it; only 已看 removes it —
// opening a video isn't watching it.
function openBasketItem(i) {
  const x = S.basket[i];
  if (!x) return;
  x.opened = true;
  saveBasket();
  openViewer(x);
}

// 已看，下一个 in the viewer: the playing video leaves the list and the next one takes its place.
function basketDoneAndNext() {
  removeBasketItems([S.basket.findIndex((x) => x.bvid === S.viewing)]);
  if (S.basket.length) openBasketItem(Math.max(0, S.basket.findIndex((x) => !x.opened)));
  else {
    closeViewer();
    toast("播放列表已经看完了");
  }
}

// 已看 and 清空 take videos out of the list, nothing else; favorites and decisions are untouched. U puts them back.
function removeBasketItems(indexes) {
  const removed = indexes.filter((i) => S.basket[i]).sort((a, b) => a - b).map((i) => ({ i, x: S.basket[i] }));
  if (!removed.length) return;
  const gone = new Set(removed.map((r) => r.x.bvid));
  S.basket = S.basket.filter((x) => !gone.has(x.bvid));
  saveBasket();
  pushUndo({ kind: "basket", removed });
  render();
}

function clearBasket() {
  const n = S.basket.length;
  removeBasketItems(S.basket.map((_, i) => i));
  toast(`已清空播放列表 ${n} 个 · U 撤销`);
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
        <button type="button" data-basket="done" aria-label="已看，移出 ${title}">已看</button>
      </div>
      ${note ? `<div class="muted basket-note">${esc(note)}</div>` : ""}
    </div>`;
    })
    .join("");
  el.viewerNextBtn.hidden = !S.basket.some((x) => x.bvid === S.viewing);
}

function mdLinkText(s) {
  return String(s).replace(/([\[\]])/g, "\\$1");
}

// 一篇摘录: one Markdown file with each video's link, AI summary, tags and note.
function buildMarkdown(items, now = new Date()) {
  const lines = [
    "---",
    `title: B站摘录 ${stamp(now, false)} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
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
    if (it.upper || it.invalid) lines.push([it.upper && `UP：${it.upper}`, it.invalid && "已失效"].filter(Boolean).join(" · "), "");
    if (done && a.oneLiner) lines.push(`> ${a.oneLiner}`, "");
    if (done && a.points?.length) lines.push(...a.points.map((p) => `- ${p}`), "");
    const names = tagIdsOf(it.bvid).map((id) => tagById(id).name);
    if (names.length) lines.push(`标签：${names.join("、")}`, "");
    const note = S.notes[it.bvid]?.text?.trim();
    if (note) lines.push(`备注：${note}`, "");
  }
  return lines.join("\n");
}

// ---------- 批量导出 ----------
// 播放列表 videos outside the open folder export with their stored title. 逐个视频笔记 leaves out invalid videos (no
// subtitle to fetch); 一篇摘录 keeps them, marked, so their notes and tags still go out.
function writeScopeItems(scope = el.writeScope.value, notes = el.writeFormat?.value === "notes") {
  const list =
    scope === "all" ? S.items
    : scope === "basket" ? S.basket.map((x) => S.itemMap.get(x.bvid) || { bvid: x.bvid, title: x.title || x.bvid })
    : scope === "selected" ? visibleSelected()
    : visibleItems();
  return notes ? list.filter((it) => !it.invalid) : list;
}

// The 阅览 tab opens it preset; a running notes export keeps its own choice.
function openWrite({ scope, format } = {}) {
  if (!S.write.running && scope) [el.writeScope.value, el.writeFormat.value] = [scope, format];
  el.writeProgress.textContent = "";
  el.writeFailed.hidden = true;
  el.writeFailed.innerHTML = "";
  renderWriteScope();
  el.writeDialog.showModal();
}

function renderWriteScope() {
  const n = writeScopeItems().length;
  const notes = el.writeFormat.value === "notes";
  const busy = S.write.running;
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

// 一篇摘录 needs summaries of 播放列表 videos from other folders too.
async function digestMarkdown() {
  const items = writeScopeItems();
  const missing = items.map((it) => it.bvid).filter((b) => !S.analyses[b]);
  if (missing.length) {
    const r = await send({ type: "triage-analysis-get", bvids: missing });
    for (const b of missing) if (r.ok && r.data?.[b]) S.analyses[b] = r.data[b];
  }
  return buildMarkdown(items);
}

// how: copy | download | obsidian
async function exportDigest(how) {
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
    BocDownload.text(filename, markdown);
    el.writeProgress.textContent = `已下载 ${filename}`;
  } else {
    const r = await send({ type: "triage-export", filename, markdown });
    setBusy(el.writeRunBtn, false);
    el.writeProgress.textContent = r.ok ? `已写入 ${r.data?.path || filename}` : `写入 Obsidian 失败：${r.error}`;
  }
}

function safeNoteName(name) {
  return String(name).replace(/[\\/:*?"<>|#^[\]]/g, "_").trim() || "收藏夹";
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
// A relative link inside the zip; <> keeps spaces in the filename (note filenames never hold < or >).
const mdLink = (path, title) => `[${oneLine(title).replace(/[[\]\\]/g, "\\$&") || path}](<${path}>)`;
// | [ ] or a newline in the alias would end the link early; the path is already a safe note filename.
function wikiLink(path, title) {
  const target = String(path).replace(/\.md$/, "");
  return `[[${target}|${oneLine(String(title ?? "").replace(/[|[\]]/g, " ")) || target}]]`;
}

// The 逐个视频笔记 index, the same in the vault and in the zip; only the link form differs.
function indexMarkdown(written, link) {
  const lines = [`# ${folderTitle()}`, "", `${stamp(new Date(), false)} · ${written.length} 篇`, ""];
  for (const w of written) {
    const oneLiner = S.analyses[w.bvid]?.oneLiner;
    lines.push(`- ${link(w.path, w.title)}${oneLiner ? ` ${oneLine(oneLiner)}` : ""}`);
  }
  return lines.join("\n");
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let c = ~0;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// files: [{ name, text }] → zip bytes. Stored (no compression); flag bit 11 marks the names as UTF-8.
// "Made by" Unix with mode 0644: made by DOS, Info-ZIP unzip (macOS's) reads the names as a DOS code page and mangles them.
function zipStored(files, now = new Date()) {
  const enc = new TextEncoder();
  const entries = files.map((f) => ({ name: enc.encode(f.name), data: enc.encode(f.text) }));
  const localSize = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length, 0);
  const centralSize = entries.reduce((n, e) => n + 46 + e.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  const put = (at, fields) => fields.reduce((p, [size, value]) => (size === 2 ? view.setUint16(p, value, true) : view.setUint32(p, value, true), p + size), at);
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  let local = 0;
  let central = localSize;
  for (const e of entries) {
    const common = [[2, 20], [2, 0x0800], [2, 0], [2, time], [2, date], [4, crc32(e.data)], [4, e.data.length], [4, e.data.length], [2, e.name.length], [2, 0]];
    out.set(e.name, put(local, [[4, 0x04034b50], ...common]));
    out.set(e.data, local + 30 + e.name.length);
    out.set(e.name, put(central, [[4, 0x02014b50], [2, 0x0314], ...common, [2, 0], [2, 0], [2, 0], [4, 0x81a40000], [4, local]]));
    local += 30 + e.name.length + e.data.length;
    central += 46 + e.name.length;
  }
  put(central, [[4, 0x06054b50], [2, 0], [2, 0], [2, entries.length], [2, entries.length], [4, centralSize], [4, localSize], [2, 0]]);
  return out;
}

// The zip's files: the index named after the folder, then each note under its vault filename (a repeat gets " (2)").
function zipNotes(base, written) {
  const used = new Set([`${base}.md`]);
  const notes = written.map((w) => {
    let path = w.filename;
    for (let i = 2; used.has(path); i++) path = w.filename.replace(/\.md$/, ` (${i}).md`);
    used.add(path);
    return { ...w, path };
  });
  return [{ name: `${base}.md`, text: indexMarkdown(notes, mdLink) }, ...notes.map((w) => ({ name: w.path, text: w.markdown }))];
}

// md: build the same notes but download them as a zip (one note each plus the index) instead of writing to the vault.
async function runWrite(md = false) {
  const items = writeScopeItems();
  const overwrite = el.writeOverwrite.checked;
  const token = S.folderToken;
  S.write = { running: true, stop: false };
  const keepGoing = () => !S.write.stop && token === S.folderToken;
  renderWriteScope();
  el.writeFailed.hidden = true;
  const written = [];
  const failed = [];
  for (let i = 0; i < items.length && keepGoing(); i++) {
    const it = items[i];
    el.writeProgress.textContent = `${md ? "生成" : "写入"} ${i + 1}/${items.length}：${it.title}`;
    const r = await send(md ? { type: "triage-build-note", bvid: it.bvid } : { type: "triage-write-note", bvid: it.bvid, overwrite });
    if (r.ok) written.push({ ...r.data, bvid: it.bvid });
    else failed.push(`${it.title}：${r.error}`);
    if (i + 1 < items.length) await sleepWhile(S.settings.triageIntervalSec * 1000, keepGoing);
  }
  let indexPath = "";
  if (md && written.length && token === S.folderToken) {
    const base = safeNoteName(folderTitle());
    indexPath = `${base}.zip`;
    BocDownload.text(indexPath, zipStored(zipNotes(base, written)), "application/zip");
  } else if (written.length && keepGoing()) {
    const r = await send({ type: "triage-export", filename: `${safeNoteName(folderTitle())}.md`, markdown: indexMarkdown(written, wikiLink) });
    if (r.ok) indexPath = r.data?.path || "";
    else failed.push(`索引：${r.error}`);
  }
  S.write.running = false;
  const skipped = written.filter((w) => w.skipped).length;
  const aiUpdated = written.filter((w) => w.aiUpdated).length;
  el.writeProgress.textContent = [
    S.write.stop ? "已停止。" : "完成。",
    `${md ? "下载" : "写入"} ${written.length - skipped} 篇`,
    skipped ? `已存在跳过 ${skipped} 篇` : "",
    aiUpdated ? `其中更新 AI 问答 ${aiUpdated} 篇` : "",
    failed.length ? `失败 ${failed.length} 篇` : "",
    indexPath ? `${md ? "文件" : "索引"}：${indexPath}` : ""
  ].filter(Boolean).join(" · ");
  el.writeFailed.innerHTML = failed.map((f) => `<li>${esc(f)}</li>`).join("");
  el.writeFailed.hidden = !failed.length;
  renderWriteScope();
}

// ---------- data export ----------
const BACKUP_PREFIXES = [K.kept, K.removed, K.left, K.tags, K.folderCriteria, "triage_video_tags", "triage_basket", K.notes, "triage_snapshot_", "triage_decisions_", "triage_title_", "triage_analysis_"];

async function buildBackup() {
  const all = await chrome.storage.local.get(null);
  const out = {
    app: "moondigest",
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest?.().version || "",
    settings: {
      triageIntervalSec: S.settings.triageIntervalSec,
      triageTitleBatchSize: S.settings.triageTitleBatchSize
    },
    tags: [],
    folderCriteria: {}, // mediaId → 判断标准
    videoTags: {},
    basket: [],
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
    else if (k === "triage_video_tags") out.videoTags = v;
    else if (k === "triage_basket") out.basket = v;
    else if (k === K.notes) out.notes = v;
    else if (k.startsWith("triage_snapshot_")) folder(k.slice(16)).snapshot = v;
    else if (k.startsWith("triage_decisions_")) folder(k.slice(17)).decisions = v;
    else if (k.startsWith("triage_title_")) out.titleResults[k.slice(13)] = v;
    else if (k.startsWith("triage_analysis_")) out.analyses[k.slice(16)] = v;
  }
  // 关注's own data (UP tags, who has which, 已取消关注, the last AI batch); its copies of B站 data come back on 刷新.
  out.follow = {};
  for (const k of ["follow_tags", "follow_tag_map", "follow_unfollowed", "follow_ai_recent", "follow_ai_history"]) if (all?.[k] !== undefined) out.follow[k.slice(7)] = all[k];
  return out;
}


function buildCsv() {
  const title = folderTitle();
  const header = ["收藏夹", "BV号", "标题", "UP主", "时长", "链接", "封面", "发布时间", "收藏时间", "简介", "AI判断", "判断来源", "理由", "一句话", "要点", "标签", "备注", "播放列表", "我的处理", "处理时间", "是否失效", "原在", "离开原因"];
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
      S.basket.some((x) => x.bvid === it.bvid) ? "在播放列表" : "",
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
    if (S.seenCfg.on) send({ type: "triage-seen-sync", force: true });
    if (inFolderView() && writingTo(S.mediaId)) toast("这个收藏夹正在批量修改，结束后自动刷新");
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
    S.focusIndex = 0;
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
  bindLive(el.searchInput, (q) => {
    S.query = q;
    S.focusIndex = 0;
    render();
  });
  // Esc clears the box; on an empty box it hands the keys back to the cards.
  el.searchInput.addEventListener("keydown", (e) => {
    if (composing(e) || e.key !== "Escape") return;
    e.preventDefault();
    if (!el.searchInput.value) return el.searchInput.blur();
    el.searchInput.value = S.query = "";
    render();
  });
  el.tagFilter.addEventListener("click", (e) => {
    if (e.target.closest("[data-airecent-done]")) {
      endAiRecent();
      return render();
    }
    if (e.target.closest("[data-airecent]")) {
      S.aiRecentFilter = !S.aiRecentFilter;
      return render();
    }
    if (e.target.closest("[data-finishedfilter]")) {
      S.finishedFilter = !S.finishedFilter;
      return render();
    }
    const kind = e.target.closest("[data-kindfilter]")?.dataset.kindfilter;
    if (kind) {
      S.kindFilter = S.kindFilter === kind ? "" : kind;
      return render();
    }
    const btn = e.target.closest("[data-tagfilter]");
    if (!btn) return;
    const ids = btn.dataset.tagfilter.split(",");
    const on = ids.some((id) => S.tagFilter.has(id));
    for (const id of ids) on ? S.tagFilter.delete(id) : S.tagFilter.add(id);
    render();
  });

  const onHeadClick = (e) => {
    const filter = e.target.closest("[data-class-filter]");
    if (filter) {
      S.classFilter[S.tab] = filter.dataset.classFilter;
      return render();
    }
    const btn = e.target.closest("[data-head]");
    if (!btn) return;
    const act = btn.dataset.head;
    if (act === "tags") openTags("batch");
    else if (act === "aiOther") openFolder(otherAiFolder()).then(() => openTags("batch"));
    else if (act === "stage1") {
      if (!S.stage1.running) return runStage1();
      S.stage1.stop = true;
      S.stage1.text = "粗看将在当前批次后暂停";
      render();
    } else if (act === "group") {
      if (S.group) {
        S.group.stop = true;
        S.group.text = "细看将在当前视频后暂停";
        return render();
      }
      const batch = nextBatch();
      for (const b of batch) S.selected.delete(b);
      startGroup(batch);
    } else if (act === "batch-unfav") batchUnfav(batchList(btn.dataset.verdict || null));
    else if (act === "batch-keep") batchKeep(batchList(btn.dataset.verdict || null));
    else if (act === "criteria") openCriteria();
    else if (act === "redo-coarse") runStage1(staleCoarse());
    else if (act === "redo-fine") startGroup(staleFine().slice(0, GROUP_SIZE).map((it) => it.bvid), true);
    else if (act === "all-pause") {
      S.loadAll.paused = true;
      render();
    } else if (act === "all-resume") {
      S.loadAll.paused = false;
      runLoadAll(S.folderToken);
    }
    else if (act === "clean-removed") cleanRemoved(visibleItems());
    else if (act === "clean-selected") cleanRemoved(selectedIn(visibleItems()));
    else if (act === "transfer") batchTransfer(transferList());
    else if (act === "select-all") {
      for (const it of visibleItems()) S.selected.add(it.bvid);
      render();
    } else if (act === "clear-selected") {
      S.selected.clear();
      render();
    }
  };
  el.transferTarget.addEventListener("change", toggleTransferNew);
  // Enter would submit with the form's first button, 取消; 移动 or 复制 has to be chosen.
  el.transferName.addEventListener("keydown", (e) => {
    if (!composing(e) && e.key === "Enter") e.preventDefault();
  });
  el.stagebar.addEventListener("click", onHeadClick);
  el.listHeader.addEventListener("click", onHeadClick);
  el.activity.addEventListener("click", onHeadClick);

  el.list.addEventListener("click", (e) => {
    if (e.target.closest("[data-pick-folders]")) return openSettings(false, true);
    if (e.target.closest("[data-refresh]")) return el.refreshBtn.click();
    const refav = e.target.closest("[data-refav]");
    if (refav) return refavRecent(refav.dataset.refav);
    const refavAll = e.target.closest("[data-refav-batch]");
    if (refavAll) return refavBatch(Number(refavAll.dataset.refavBatch));
    const pick = e.target.closest("[data-select]");
    if (pick) {
      const b = pick.dataset.select;
      if (S.selected.has(b)) S.selected.delete(b);
      else S.selected.add(b);
      return render();
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
  el.viewerNextBtn.addEventListener("click", basketDoneAndNext);
  el.viewerTabBtn.addEventListener("click", () => openTab(videoUrl(S.viewing)));
  // The viewer frame is the only one in this tab running content.js, so this reaches it like the popup's 专注模式.
  el.viewerFocusBtn.addEventListener("click", () => chrome.tabs.sendMessage(ownTabId, { type: "popup-trigger-reading-view" }).catch(() => toast("视频页还没加载好，稍后再试", true)));

  el.settingsBtn.addEventListener("click", () => openSettings());
  for (const input of [el.thinkingInput, el.batchSizeInput, el.titleMaxInput, el.analyzeMaxInput]) {
    input.addEventListener("input", renderTokenHints);
  }
  el.settingsDialog.querySelector("form").addEventListener("submit", (e) => {
    if (e.submitter?.value !== "save") return;
    const bad = [el.titleMaxInput, el.analyzeMaxInput].filter((input) => parseMaxTokens(input.value) === null);
    el.settingsError.hidden = !bad.length;
    if (bad.length) {
      e.preventDefault();
      el.settingsError.textContent = "输出上限需为整数：0 或留空表示自动，否则在 200–32000 之间";
      bad[0].focus();
    }
  });
  el.settingsDialog.addEventListener("click", (e) => {
    const all = e.target.closest("[data-folders-all]");
    if (!all && !e.target.closest("[data-folders-none]")) return;
    for (const box of el.folderToggles.querySelectorAll("input")) box.checked = Boolean(all);
  });
  el.settingsDialog.addEventListener("close", async () => {
    if (el.settingsDialog.returnValue !== "save") return;
    const patch = {
      triageIntervalSec: Math.max(0, Number(el.intervalInput.value) || 0),
      triageTitleBatchSize: Math.max(1, Math.min(100, Number(el.batchSizeInput.value) || 30)),
      triageThinking: el.thinkingInput.checked,
      triageTitleMaxTokens: parseMaxTokens(el.titleMaxInput.value),
      triageAnalyzeMaxTokens: parseMaxTokens(el.analyzeMaxInput.value),
      triageTagLimit: Math.max(1, Math.min(50, Math.floor(Number(el.tagLimitInput.value)) || 10)),
      triageAiNewTagMax: el.aiNewTagMaxInput.value === "" ? 5 : Math.max(0, Math.min(50, Math.floor(Number(el.aiNewTagMaxInput.value)) || 0)),
      triageAiRemoveTags: el.aiRemoveTagsInput.checked
    };
    const r = await send({ type: "triage-settings-save", ...patch });
    if (!r.ok) {
      toast(`保存设置失败：${r.error}`, true);
      return;
    }
    Object.assign(S.settings, patch);
    renderTagLimit();
    toast("设置已保存");
    const included = [...el.folderToggles.querySelectorAll("input:checked")].map((x) => x.value);
    const same = included.length === S.included.length && included.every((id) => S.included.includes(id));
    if (S.allFolders.length && !same) {
      const ticked = included.filter((id) => !S.included.includes(id));
      await storeSet(K.included, included);
      await loadFolders();
      recoverRemoved(ticked);
    }
  });
  el.writeBtn.addEventListener("click", () => openWrite());
  el.writeScope.addEventListener("change", renderWriteScope);
  el.writeFormat.addEventListener("change", renderWriteScope);
  const digest = () => el.writeFormat.value === "digest";
  el.writeCopyBtn.addEventListener("click", () => exportDigest("copy"));
  el.writeRunBtn.addEventListener("click", () => (digest() ? exportDigest("obsidian") : runWrite()));
  el.writeMdBtn.addEventListener("click", () => (digest() ? exportDigest("download") : runWrite(true)));
  el.writeStopBtn.addEventListener("click", () => {
    S.write.stop = true;
    el.writeProgress.textContent = "将在当前视频后停止…";
  });
  el.writeDialog.addEventListener("close", () => {
    if (S.write.running) S.write.stop = true;
  });
  el.openOptionsBtn.addEventListener("click", () => send({ type: "open-options" }));
  // Both modes' 导出 menus carry the same 完整备份 item.
  document.addEventListener("click", async (e) => {
    if (!e.target.closest("[data-backup]")) return;
    try {
      BocDownload.text(`MoonDigest备份-${stamp()}.json`, JSON.stringify(await buildBackup(), null, 2), "application/json");
    } catch (err) {
      toast(`导出备份失败：${err.message}`, true);
    }
  });
  el.csvBtn.addEventListener("click", () => {
    if (!S.items.length) {
      toast("当前收藏夹没有视频可导出", true);
      return;
    }
    const title = folderTitle().replace(/[\\/:*?"<>|]/g, "_");
    BocDownload.text(`MoonDigest-${title}-${stamp(new Date(), false)}.csv`, buildCsv(), "text/csv;charset=utf-8");
  });
  el.helpBtn.addEventListener("click", () => el.helpDialog.showModal());
  // A download leaves the page as it was, so the 导出 menu would stay open over it.
  el.tools.addEventListener("click", (e) => e.target.closest("button") && el.tools.hidePopover());
  document.querySelector("[data-open-settings]")?.addEventListener("click", () => openSettings());
  el.toast.addEventListener("click", () => (el.toast.hidden = true));

  UI.bindSync(syncEls());
  el.bannerClose.addEventListener("click", () => (el.banner.hidden = true));

  el.viewerTags.addEventListener("click", (e) => e.target.closest("[data-vtag]") && tagPlaying());
  // T pressed while focus is in the player (viewer-frame.js); 关注 has its own listener in follow.js.
  window.addEventListener("message", (e) => !followMode() && UI.viewerKeyFrom(e, el.viewerFrame.contentWindow) === "t" && tagPlaying());

  el.criteriaInput.addEventListener("keydown", (e) => {
    if (composing(e) || e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    el.criteriaDialog.close("save");
  });
  el.criteriaDialog.addEventListener("close", () => {
    if (el.criteriaDialog.returnValue === "save") saveCriteria();
  });
  el.aiTagSlot.addEventListener("click", (e) => {
    if (e.target.closest("[data-tags-manage]")) openTags("manage");
    else if (e.target.closest("[data-ai-tag]")) openTags("batch");
  });
  el.tagsDialog.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tags-mode]");
    if (btn) showTagsMode(btn.dataset.tagsMode);
  });
  el.aiTagsPreview.addEventListener("click", (e) => {
    const id = e.target.closest("[data-use]")?.dataset.use;
    if (!id) return;
    if (!S.ai.excluded.delete(id)) S.ai.excluded.add(id);
    renderAiForm();
    el.aiTagsPreview.querySelector(`[data-use="${CSS.escape(id)}"]`)?.focus();
  });
  el.tagsRows.addEventListener("change", (e) => {
    const row = e.target.closest(".tag-row");
    const t = row && tagById(row.dataset.id);
    const field = e.target.dataset.field;
    if (t && field && !saveTagEdit(t, field, e.target.value) && field === "name") e.target.value = t.name;
  });
  el.tagsRows.addEventListener("click", (e) => {
    const row = e.target.closest(".tag-row");
    const t = row && tagById(row.dataset.id);
    if (t && e.target.closest("[data-tag-del]")) deleteTag(t.id);
    else if (t && e.target.closest("[data-tag-color]") && saveTagEdit(t, "color")) renderTagManager();
  });
  const addTag = () => {
    const name = cleanTagName(el.newTagInput.value);
    const why = UI.tagNameError(name, viewTags());
    if (why) return toast(why, true);
    if (!createTag(name)) return;
    el.newTagInput.value = "";
    renderTagManager();
    render();
  };
  el.addTagBtn.addEventListener("click", addTag);
  // Enter in a name field: 新建 adds the tag; a rename or an AI tag name would submit the form and close the dialog (as in follow.js).
  el.tagsDialog.addEventListener("keydown", (e) => {
    if (composing(e) || e.key !== "Enter" || !e.target.matches?.('#newTagInput, [data-field="name"], [data-nt="name"]')) return;
    e.preventDefault();
    if (e.target === el.newTagInput) addTag();
  });

  // 批量打
  el.aiScope.addEventListener("change", renderAiForm);
  // The same switch as in 收藏夹设置, saved as soon as it flips.
  el.aiFormRemoveTagsInput.addEventListener("change", async () => {
    const on = el.aiFormRemoveTagsInput.checked;
    const r = await send({ type: "triage-settings-save", triageAiRemoveTags: on });
    if (!r.ok) {
      el.aiFormRemoveTagsInput.checked = !on;
      toast(`保存设置失败：${r.error}`, true);
      return;
    }
    S.settings.triageAiRemoveTags = on;
  });
  el.aiHistory.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-h]");
    if (btn) el.aiInstruction.value = S.aiHistory[Number(btn.dataset.h)];
  });
  el.aiRunBtn.addEventListener("click", runAiCommand);
  el.aiStopBtn.addEventListener("click", () => {
    S.ai.stop = true;
    el.aiProgress.textContent = "将在当前批次完成后停止…";
  });
  el.aiCloseBtn.addEventListener("click", () => el.tagsDialog.close());
  el.aiNewTags.addEventListener("change", (e) => {
    const t = S.ai.proposal?.newTags[Number(e.target.closest(".ai-newtag")?.dataset.i)];
    if (t && e.target.dataset.nt === "checked") {
      t.checked = e.target.checked;
      renderAiRows();
    }
  });
  el.aiNewTags.addEventListener("input", (e) => {
    const t = S.ai.proposal?.newTags[Number(e.target.closest(".ai-newtag")?.dataset.i)];
    const field = e.target.dataset.nt;
    if (!t || field !== "name") return;
    t.name = e.target.value;
    renderAiRows();
  });
  el.aiDiscardBtn.addEventListener("click", () => {
    S.ai.proposal = null;
    showAiForm();
    renderTop();
  });
  el.aiApplyBtn.addEventListener("click", applyAiProposal);

  // basket
  el.basketToggle.addEventListener("click", () => setBasketOpen(el.basket.classList.contains("collapsed")));
  el.basketClearBtn.addEventListener("click", clearBasket);
  el.basketList.addEventListener("click", (e) => {
    const act = e.target.closest("[data-basket]")?.dataset.basket;
    if (!act) return;
    const i = Number(e.target.closest(".basket-item").dataset.i);
    if (act === "open") openBasketItem(i);
    else if (act === "done") removeBasketItems([i]);
  });
}

// Returns 0 for auto, the integer for 200–32000, or null when invalid.
function parseMaxTokens(value) {
  const s = String(value ?? "").trim();
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isInteger(n)) return null;
  return n === 0 || (n >= 200 && n <= 32000) ? n : null;
}

// The tag caps are written into the static hints of the 标签 and help dialogs.
function renderTagLimit() {
  for (const node of document.querySelectorAll("[data-tag-limit]")) node.textContent = tagLimit();
  for (const node of document.querySelectorAll("[data-ai-new-tag-max]")) node.textContent = S.settings.triageAiNewTagMax;
}

function renderTokenHints() {
  const batch = Math.max(1, Number(el.batchSizeInput.value) || 30);
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
    .map((f) => `<label class="toggle"><input type="checkbox" value="${esc(f.id)}"${S.included.includes(String(f.id)) ? " checked" : ""} /> ${esc(f.title)} <span class="muted">${esc(f.count)}</span></label>`)
    .join("") || `<p class="dialog-hint">收藏夹列表还没加载</p>`;
  el.thinkingRow.hidden = !hasThinkingToggle();
  el.intervalInput.value = S.settings.triageIntervalSec ?? 8;
  el.batchSizeInput.value = S.settings.triageTitleBatchSize ?? 30;
  el.thinkingInput.checked = Boolean(S.settings.triageThinking);
  el.titleMaxInput.value = S.settings.triageTitleMaxTokens || "";
  el.analyzeMaxInput.value = S.settings.triageAnalyzeMaxTokens || "";
  el.tagLimitInput.value = tagLimit();
  el.aiNewTagMaxInput.value = S.settings.triageAiNewTagMax;
  el.aiRemoveTagsInput.checked = S.settings.triageAiRemoveTags === true;
  el.settingsError.hidden = true;
  renderTokenHints();
  el.settingsDialog.returnValue = "";
  el.settingsDialog.showModal();
  if (scrollToLimits) el.titleMaxInput.scrollIntoView({ block: "center" });
}

function openViewer(it) {
  S.viewing = it.bvid;
  el.viewerTitle.textContent = it.title;
  el.viewerFrame.src = videoUrl(it.bvid);
  el.viewer.hidden = false;
  el.main.classList.add("viewing");
  render();
}

function setBasketOpen(open) {
  el.basket.classList.toggle("collapsed", !open);
  el.basketToggle.setAttribute("aria-expanded", String(open));
}

// Likes, coins and favorites happen on Bilibili's own page, so the folder is re-read once the viewer closes.
function closeViewer() {
  if (!S.viewing) return;
  S.viewing = "";
  el.viewerFrame.src = "about:blank";
  el.viewer.hidden = true;
  el.main.classList.remove("viewing");
  render();
  if (inFolderView() && !followMode()) quickSync({ force: true });
}

function cardAction(act, bvid) {
  const it = S.itemMap.get(bvid);
  if (!it) return;
  if (act === "open") openViewer(it);
  else if (act === "ask") askAi(it);
  else if (act === "unfav") decide(bvid, "unfav");
  else if (act === "keep") decide(bvid, "keep");
  else if (act === "tag") openPicker(bvid);
  else if (act === "basket") toggleBasket(bvid);
  else if (act === "retry") retry(bvid);
  else if (act === "note") {
    S.noteOpen.add(bvid);
    renderList();
    el.list.querySelector(`.card[data-bvid="${CSS.escape(bvid)}"] [data-note]`)?.focus();
  }
  else if (act === "select") {
    if (S.selected.has(bvid)) S.selected.delete(bvid);
    else S.selected.add(bvid);
    render();
  }
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
    i: () => openTags("batch")
  };
  const nav = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };
  const cardKeys = { d: "unfav", s: "keep", t: "tag", e: "basket", q: "ask", x: "select", o: "open", Enter: "open" };
  if (key === "Escape" && S.viewing) closeViewer();
  else if (map[key]) map[key]();
  else if (nav[key]) moveFocus(nav[key]);
  // 已出分拣范围 has no 保留 / 取消收藏 / 标签; 播放列表 and 问 AI work there.
  else if (S.mediaId === REMOVED && key !== "e" && key !== "q") return;
  else if (key === "u") undo();
  else if (cardKeys[key] && S.focused) cardAction(cardKeys[key], S.focused);
  else return;
  e.preventDefault();
}
