// Static-server preview only: load the fake chrome.* before anything reads it. Never fetched inside the extension.
if (!globalThis.chrome?.runtime?.id) await import("./dev/mock-chrome.js");

// ---------- constants ----------
const THROTTLE_MS = globalThis.__TRIAGE_THROTTLE_MS || 10 * 60 * 1000;
// Error code -> [backoff ms, status label]. AI 429s clear far sooner than B站 risk control.
const THROTTLES = { THROTTLED: [THROTTLE_MS, "B站限流"], AI_THROTTLED: [60 * 1000, "AI 平台限流"] };
const GROUP_SIZE = 10;
const TAG_LIMIT = 10; // tags per folder; only creating a new one is refused past it
const SYNC_MIN_GAP_MS = 60 * 1000;
// Catppuccin Latte accents (desaturated); chips keep --text on top, so these are only borders and tints.
// Mauve, blue, green, red and yellow are left out: they mean where-you-are, next step, keep, delete and pending.
const TAG_COLORS = ["#da86c3", "#298287", "#dc6d2d", "#3590a0", "#8595ea", "#cf5c66", "#2497c6", "#cf8686", "#ce9386"];
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
  watched: "triage_watched", // { [bvid]: at }: 手动看过, set when a video leaves 优先看 as watched; it shows in every folder
  removed: "triage_removed", // { [bvid]: { item, at } }: videos that left every folder, kept until the user cleans them
  included: "triage_included_folders", // [mediaId]: the folders the user chose; only these are listed and read
  snapshot: (id) => `triage_snapshot_${id}`,
  aiHistory: "triage_ai_command_history"
};
const ALL = "all"; // the 所有收藏夹 view's folder-select value
const REMOVED = "removed"; // the 已取消收藏 view
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
    else out.push({ id: t.id, name, color: t.color || TAG_COLORS[out.length % TAG_COLORS.length] });
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

// 已取消收藏 (pure): a folder's full new list replaces its old one. A video that left it and is in no other folder's
// list is recorded with its last known item; a video listed again is dropped from the record. One still in the folder's
// id list (ids) only stopped being listed: Bilibili hides a video that became invalid, so it is marked hidden.
function updateRemoved(removed, oldItems, newItems, otherBvids, at, ids = null) {
  const next = { ...removed };
  const now = new Set(newItems.map((it) => it.bvid));
  const stillThere = new Set(ids || []);
  for (const b of now) delete next[b];
  for (const it of oldItems) {
    if (now.has(it.bvid) || otherBvids.has(it.bvid) || next[it.bvid]) continue;
    next[it.bvid] = stillThere.has(it.bvid) ? { item: it, at, hidden: true } : { item: it, at };
  }
  return next;
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
  removedCheck: null, // 已取消收藏 only: { done, total, error } while its folders are checked
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
  watched: {},
  watchedFilter: false,
  invalidFilter: false, // 已失效: invalid in a folder, or hidden by Bilibili in 已取消收藏
  seenCfg: { on: false, bar: false, mark: false, threshold: 80, style: "badge" }, // 设置页「观看进度 → 封面显示」
  seenPct: {}, // bvid → [percent, view_at] from the history, null when it has none
  noteOpen: new Set(), // empty notes the user opened for editing
  settings: {
    triageIntervalSec: 8,
    triageTitleBatchSize: 30,
    triageThinking: false,
    triageTitleMaxTokens: 0,
    triageAnalyzeMaxTokens: 0,
    deepseek: false
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
  syncing: false,
  aiHistory: [],
  viewing: "",
  // One 批量打标签 run at a time (mediaId is its folder); it keeps going when another folder is opened. Each folder keeps
  // its own proposal, and proposal reads and writes the open folder's.
  ai: {
    running: false,
    stop: false,
    mediaId: "",
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
const el = {};
[
  "folderSelect", "settingsHeading", "settingsFoldersHeading", "settingsAi", "settingsFirstRunHint", "removedBtn", "searchInput", "searchCount", "refreshBtn", "activity", "settingsBtn", "helpBtn", "tools",
  "banner", "bannerText", "bannerBtn", "bannerClose", "syncNotice", "syncText", "syncViewBtn", "syncCloseBtn", "syncDetail",
  "tabs", "stagebar", "classFilter", "tagFilter", "listHeader", "list", "basket", "basketToggle", "basketCount",
  "basketList", "toast", "settingsDialog", "folderToggles", "thinkingRow", "intervalInput",
  "batchSizeInput", "openOptionsBtn", "thinkingInput", "titleMaxInput",
  "titleMaxHint", "analyzeMaxInput", "analyzeMaxHint", "settingsError", "backupBtn", "csvBtn", "confirmDialog",
  "confirmTitle", "confirmBody", "confirmOk", "transferDialog", "transferTitle", "transferBody", "transferTarget", "transferNewRow", "transferUnchosen", "transferHow", "transferName", "transferPrivate", "pickerDialog", "pickerTitle", "pickerInput", "pickerList",
  "criteriaDialog", "criteriaTitle", "criteriaInput", "tagsDialog", "tagsModeManage", "tagsModeBatch", "tagsManage", "tagsRows", "newTagInput", "addTagBtn", "helpDialog",
  "aiBtn", "aiForm", "aiScope", "aiScopeCount", "aiInstruction", "aiHistory",
  "aiTagsPreview", "aiProgress", "aiCloseBtn", "aiStopBtn", "aiRunBtn",
  "aiReview", "aiReviewSummary", "aiNotes", "aiNewTags", "aiAllBtn", "aiNoneBtn", "aiRows", "aiDiscardBtn", "aiApplyBtn",
  "biliBtn", "main", "viewer", "viewerTitle", "viewerNextBtn", "viewerTabBtn", "viewerCloseBtn", "viewerFrame",
  "writeBtn", "writeDialog", "writeScope", "writeFormat", "writeScopeCount", "writeOverwriteRow", "writeOverwrite", "writeProgress", "writeFailed", "writeStopBtn", "writeCopyBtn", "writeRunBtn", "writeMdBtn"
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
  return chrome.storage.local.set({ [key]: value }).catch((e) => {
    console.error("[triage] storage write failed", key, e);
    if (storeFailShown) return;
    storeFailShown = true;
    toast(`保存失败，本地存储可能已满：${e?.message || e}`, true);
  });
}

function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const pad = (n) => String(n).padStart(2, "0");
function fmtDuration(sec) {
  sec = Math.max(0, Number(sec) || 0);
  return `${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))}`;
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
function toast(text, error = false) {
  el.toast.textContent = text;
  el.toast.classList.toggle("error", error);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 6000);
}

function askConfirm(title, bodyHtml, okText) {
  el.confirmTitle.textContent = title;
  el.confirmBody.innerHTML = bodyHtml;
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
    showBanner(`还没有可用的 AI 服务：${text}`, "去配置", () => send({ type: "open-options" }), "ai");
  } else if (text.includes("截断")) {
    showBanner(`${text}。建议调大输出上限或关闭思考`, "打开分拣设置", () => openSettings(true), "ai");
  } else toast(text, true);
}
const clearAiBanner = () => {
  if (el.banner.dataset.kind === "ai") el.banner.hidden = true;
};

// ---------- derived ----------
const tagById = (id) => S.tags.find((t) => t.id === id);
const inFolderView = () => S.mediaId !== ALL && S.mediaId !== REMOVED;
// The open folder's tags; 所有收藏夹 has every chosen folder's, 已取消收藏 every tag.
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
// How many new tags 批量打 may propose: at most 5, within the folder's room.
const aiNewTagRoom = () => Math.max(0, Math.min(5, TAG_LIMIT - viewTags().length));
const FOLDER_ONLY = "标签按收藏夹分开，请先打开一个具体收藏夹";
// A video's tags in the open view. A tag belongs to one folder and stays there when the video moves, so a folder shows
// only its own; 所有收藏夹 those of the video's folders (as the picker); 已取消收藏 every one.
function tagIdsOf(bvid) {
  const folders = S.mediaId === REMOVED ? null : pickerFolders(bvid);
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
function verdictOf(it) {
  const a = S.analyses[it.bvid];
  const failed = a?.status === "error" ? a.error || "分析失败" : "";
  if (it.invalid) return { verdict: "drop", reason: "视频已失效", stage: 0, failed: "" };
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

function passFilter(it) {
  if (S.watchedFilter && !isSeen(it)) return false;
  if (S.invalidFilter && !(it.invalid || it.hidden)) return false;
  if (S.tagFilter.size && !tagIdsOf(it.bvid).some((id) => S.tagFilter.has(id))) return false;
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
  // 阅览 (and 已取消收藏) is every video of the folder, whatever its step.
  if (tab !== "read" && stageOf(it) !== tab) return false;
  const f = S.classFilter[tab];
  return !f || f === "all" || verdictOf(it).verdict === f;
}

const failedAnalysis = (b) => S.analyses[b]?.status === "error";

// 拿不准 and low confidence are what 细看 is for, so they go first in 粗看完成.
const unsureFirst = (it) => {
  const v = verdictOf(it);
  return v.verdict === "unsure" || v.low ? 0 : 1;
};

// 粗看完成 lists the batch the button will send (or is sending) first, then 拿不准 / low confidence, failed cards last.
function visibleItems() {
  const list = S.items.filter((it) => inTab(it, S.tab) && passFilter(it));
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

async function init() {
  bindEvents();
  // Read up front: sidePanel.open must run inside the click's user gesture, before any await.
  chrome.tabs.getCurrent().then((tab) => (ownTabId = tab?.id));
  const [{ tags, videoTags, folderCriteria }, kept, basket, notes, watched, settingsResp] = await Promise.all([
    loadTagsAndCriteria().then(async (r) => ({ ...r, ...(await loadTagsByFolder(r)) })),
    loadKept(),
    storeGet(K.basket, []),
    storeGet(K.notes, {}),
    storeGet(K.watched, {}),
    send({ type: "triage-settings-get" })
  ]);
  Object.assign(S, { tags, videoTags, folderCriteria, kept });
  S.basket = basket.map(({ bvid, title, cover, upper, duration, opened }) => ({ bvid, title, cover, upper, duration, ...(opened ? { opened: true } : {}) }));
  S.notes = notes;
  S.watched = watched;
  S.aiHistory = await storeGet(K.aiHistory, []);
  if (settingsResp.ok) Object.assign(S.settings, settingsResp.data);
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
    // The side panel and history page edit the same notes; a pending local save is newer than any echo.
    if (area === "local" && changes[K.notes] && !noteTimer) {
      S.notes = changes[K.notes].newValue || {};
      render();
    }
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
const SHARED = { kept: {}, videoTags: {}, tags: [], basket: [], watched: {}, folderCriteria: {} };
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
function ownEcho(key, c) {
  const mine = ownWrites[key] || [];
  const i = mine.indexOf(JSON.stringify(c.newValue ?? null));
  if (i >= 0) mine.splice(0, i + 1);
  return i >= 0;
}
// 保留 also sits in the open view's decisions (see openFolder and rebuildAll); 取消收藏 there wins, as on open.
function followKept(kept) {
  if (S.mediaId !== REMOVED) {
    for (const [b, d] of Object.entries(S.decisions)) if (d?.action === "keep" && !kept[b]) delete S.decisions[b];
    for (const [b, d] of Object.entries(kept)) if (S.decisions[b]?.action !== "unfav") S.decisions[b] = d;
  }
  S.kept = kept;
}

// ---------- 看过 ----------
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
// 看过: marked by hand, or watched at least the set share.
const isSeen = (it) => Boolean(S.watched[it.bvid]) || (S.seenCfg.mark && (seenPercentOf(it) ?? 0) >= S.seenCfg.threshold);
function seenLabel(it) {
  const p = seenPercentOf(it) ?? 0;
  return p >= 100 ? "✓ 看完了" : p >= S.seenCfg.threshold ? `✓ 看过 ${p}%` : "✓ 看过";
}
// The cover with its progress bar and, once 看过, the corner tag or the veil (html[data-seen-style] picks one).
function coverHtml(it) {
  const img = `<img class="cover" src="${esc(it.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
  const p = S.seenCfg.bar ? seenPercentOf(it) : null;
  // 手动看过 shows as before (footer badge) unless 看过标记 is on.
  const seen = S.seenCfg.mark && isSeen(it);
  if (!p && !seen) return img;
  const label = esc(seenLabel(it));
  return `<span class="cover-wrap${seen ? " seen" : ""}">${img}${seen ? `<span class="seen-veil">${label}</span><span class="seen-tag">${label}</span>` : ""}${p ? `<span class="seen-bar" title="看了 ${p}%"><i style="width:${Math.max(p, 2)}%"></i></span>` : ""}</span>`;
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
// (unless in a chosen folder's list) move to 已取消收藏 here and its records go. Runs once S.folders is known.
async function retireUnchosenFolders() {
  if (!S.allFolders.length) return; // 默认收藏夹 always exists; an empty list is never "every folder deleted"
  if (!S.included.length) return; // nothing chosen yet (or all unticked by accident): never empty every folder into 已取消收藏
  const live = new Set(S.folders.map((f) => String(f.id)));
  const keys = ((await chrome.storage.local.getKeys?.()) ?? Object.keys((await chrome.storage.local.get(null)) || {})).filter((k) => k.startsWith("triage_snapshot_"));
  const gone = keys.map((k) => k.slice(16)).filter((id) => !live.has(id));
  if (!gone.length) return;
  const got = await chrome.storage.local.get([K.removed, ...keys]);
  const otherBvids = new Set([...live].flatMap((id) => got[K.snapshot(id)]?.bvids || []));
  let removed = got[K.removed] || {};
  for (const id of gone) {
    const old = got[K.snapshot(id)];
    const oldItems = old?.items || (old?.bvids || []).map((bvid) => ({ bvid, title: old.titles?.[bvid] || bvid }));
    removed = updateRemoved(removed, oldItems, [], otherBvids, Date.now());
  }
  await chrome.storage.local.set({ [K.removed]: removed });
  await chrome.storage.local.remove(gone.flatMap((id) => [K.snapshot(id), K.decisions(id)]));
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
  if (it.seen < 0) return "已看完";
  return it.duration > 0 ? `看过 ${Math.min(99, Math.max(1, Math.round((it.seen / it.duration) * 100)))}%` : "";
}

// 「（p/P 页）」 while a folder of more than one page (20 videos each) loads.
function pageText(mediaId) {
  if (String(mediaId) === TOVIEW) return ""; // read in one request, no pages
  const pages = Math.ceil(Number(S.folders.find((f) => String(f.id) === String(mediaId))?.count || 0) / 20);
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
    if (needLogin) showBanner(`未登录 B 站：${r.error}`, "去登录", () => openTab("https://passport.bilibili.com/login"));
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
  // 所有收藏夹 leads and 已取消收藏 closes the list; renderTop keeps their labels and visibility current.
  el.folderSelect.innerHTML =
    `<option value="${ALL}" title="把所有收藏夹合在一起看和搜索。第一次要逐个加载，收藏夹多时需要几分钟；之后只核对变化，很快">所有收藏夹</option><hr />` +
    S.folders.map((f) => `<option value="${esc(f.id)}">${esc(f.title)} (${esc(f.count)})</option>`).join("") +
    `<hr /><option value="${REMOVED}" title="离开了你勾选的所有收藏夹、但 MoonDigest 还留着信息的视频">已取消收藏</option>`;
  renderTop();
  if (!S.folders.length) {
    el.list.innerHTML = S.allFolders.length
      ? `<div class="empty pick-folders"><p><strong>先选要分拣的收藏夹</strong></p>
          <p>MoonDigest 只读取你勾选的收藏夹，没勾的不会读取里面的内容。以后可以在「分拣设置」里随时改。</p>
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

async function openFolder(mediaId) {
  // Loaded before any state changes so S.mediaId and S.decisions always belong to the same folder.
  const all = mediaId === ALL;
  const removed = mediaId === REMOVED;
  const decisions = all || removed ? {} : { ...S.kept, ...(await storeGet(K.decisions(mediaId), {})) };
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
  S.watchedFilter = false;
  S.invalidFilter = false;
  S.undo = [];
  S.focused = "";
  S.focusIndex = 0;
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
  else if (!idsChanged(snap.ids || snap.bvids, r.data.bvids)) S.lastSyncAt = Date.now();
  else syncFolder({ force: true, cached: { snap, ids: r.data.bvids } });
}

// bvid → { item, from } for videos in another chosen folder's cached list (from: its id) or in 已取消收藏 (from: REMOVED).
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
let deferredRead = 0;
function deferRead(fn) {
  if (deferredRead) return;
  const token = S.folderToken;
  deferredRead = setTimeout(() => {
    deferredRead = 0;
    if (token === S.folderToken) fn();
  }, 1000);
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
    deferRead(() => (cached ? quickSync({ force: true }) : syncFolder({ force: true })));
    return false;
  }
  const token = S.folderToken;
  S.syncing = token;
  S.loadPage = null;
  const mediaId = S.mediaId;
  renderTop();
  try {
    // Videos MoonDigest already holds from another chosen folder or 已取消收藏: added here, they reuse that info.
    const local = await localItems(mediaId);
    if (token !== S.folderToken) return false;
    let r = cached ? await fromCache(mediaId, cached, local) : null;
    if (token !== S.folderToken) return false;
    r ||= await send({ type: "triage-folder-items", mediaId });
    if (token !== S.folderToken) return false;
    if (!r.ok) {
      const needLogin = /登录/.test(r.error || "");
      if (needLogin) showBanner(`未登录 B 站：${r.error}`, "去登录", () => openTab("https://passport.bilibili.com/login"));
      else toast(`刷新收藏夹失败：${r.error}`, true);
      if (!S.items.length) el.list.innerHTML = `<p class="empty">无法读取这个收藏夹</p>`;
      return false;
    }
    S.lastSyncAt = Date.now();
    if (r.data.info) S.folderIntro[mediaId] = r.data.info.intro;
    const snap = await storeGet(K.snapshot(mediaId), null);
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
// chosen folder go to 已取消收藏.
async function saveSnapshot(mediaId, items, ids = null) {
  const others = S.folders.map((f) => String(f.id)).filter((id) => id !== String(mediaId));
  const got = await chrome.storage.local.get([K.snapshot(mediaId), K.removed, ...others.map(K.snapshot)]);
  const old = got[K.snapshot(mediaId)];
  const oldItems = old?.items || (old?.bvids || []).map((bvid) => ({ bvid, title: old.titles?.[bvid] || bvid }));
  const otherBvids = new Set(others.flatMap((id) => got[K.snapshot(id)]?.bvids || []));
  const removed = updateRemoved(got[K.removed] || {}, oldItems, items, otherBvids, Date.now(), ids);
  await chrome.storage.local.set({
    [K.snapshot(mediaId)]: {
      bvids: items.map((it) => it.bvid),
      invalid: items.filter((it) => it.invalid).map((it) => it.bvid),
      titles: Object.fromEntries(items.map((it) => [it.bvid, it.title])),
      items,
      ids, // the folder's id list at this load; 所有收藏夹 compares the next id list with it
      intro: S.folderIntro[mediaId] ?? old?.intro
    },
    [K.removed]: removed
  });
  S.removedCount = Object.keys(removed).length;
  renderTop();
}

// ---------- 已取消收藏 ----------
async function openRemoved() {
  const token = S.folderToken;
  const rec = await storeGet(K.removed, {});
  if (token !== S.folderToken) return false;
  S.items = Object.values(rec)
    .sort((x, y) => y.at - x.at)
    .map(({ item, at, movedTo, hidden }) => ({ ...item, removedAt: at, movedTo, hidden }));
  S.itemMap = new Map(S.items.map((it) => [it.bvid, it]));
  if (!(await loadResults(token))) return false;
  checkRemoved(token);
  return true;
}

// Re-favorited videos leave 已取消收藏 as soon as one chosen folder's id list has them again.
async function checkRemoved(token) {
  const ids = S.folders.map((f) => String(f.id));
  S.removedCheck = { done: 0, total: ids.length, error: "" };
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
  if (token === S.folderToken) S.removedCheck = null;
  render();
}

// Drops these bvids from 已取消收藏 (they are in a folder again); returns how many were there.
async function dropRemoved(bvids) {
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
}

// Deletes everything MoonDigest holds for these videos (AI results, 保留, note, tags, 优先看, 取消收藏 records) and their record.
async function cleanRemoved(list) {
  if (!list.length) return;
  const one = list.length === 1 ? `《${shortTitle(list[0])}》` : `这 ${list.length} 个视频`;
  const body = `<p>删除${one}的 AI 分析、备注、标签和优先看记录，无法撤销。要留存请先「批量导出」。</p>`;
  if (!(await askConfirm(`清理${one}？`, body, `清理 ${list.length} 个`))) return;
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

const folderName = (id) => id === REMOVED ? "已取消收藏" : S.allFolders.find((f) => String(f.id) === String(id))?.title || String(id);
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
  const ok = await askConfirm(`取消收藏《${shortTitle(it)}》？`, `<p>这个视频在 ${it.folders.length} 个收藏夹里，从勾选的收藏夹取消收藏：</p>${boxes}`, "取消收藏");
  return ok ? [...el.confirmBody.querySelectorAll("input:checked")].map((x) => x.value) : [];
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
  el.syncText.textContent = `${head}B站同步：${parts.join(" · ")}`;
  el.syncViewBtn.textContent = `B站同步${partial ? "（部分）" : ""} +${added.length}${partial ? "" : ` −${removed.length}`}`;
  // A partial load is a notice to retry later, not a blocker: amber, per the color rules in tokens.css.
  el.syncViewBtn.classList.toggle("warn", Boolean(partial));
  const section = (label, titles) =>
    titles.length ? `<div><strong>${label}</strong><ul>${titles.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : "";
  const where = (it) => (it.from === REMOVED ? "原在已取消收藏" : `也在「${folderName(it.from)}」`);
  el.syncDetail.innerHTML =
    section("新增", added.filter((it) => !it.from).map((it) => it.title)) +
    section("来自其他收藏夹", added.filter((it) => it.from).map((it) => `${it.title}（${where(it)}）`)) +
    section("已在B站移除", removed) +
    section("已失效", invalid) +
    section("恢复（在B站重新收藏）", restored);
  el.syncNotice.hidden = true;
  el.syncViewBtn.hidden = false;
  el.syncViewBtn.setAttribute("aria-expanded", "false");
}

function hideSyncNotice() {
  el.syncNotice.hidden = true;
  el.syncViewBtn.hidden = true;
}

// ---------- render ----------
function render() {
  renderTop();
  renderTabs();
  renderList();
  renderBasket();
}

function renderTop() {
  el.biliBtn.hidden = !S.mid;
  el.biliBtn.textContent = S.mediaId === TOVIEW ? "B 站稍后再看 ↗" : inFolderView() ? "B 站收藏夹 ↗" : "B 站主页 ↗";
  setBusy(el.refreshBtn, (S.syncing || S.loadAll?.running) && `刷新中…${S.syncing ? pageText(S.mediaId) : ""}`);
  const allOpt = el.folderSelect.querySelector(`option[value="${ALL}"]`);
  if (allOpt) allOpt.hidden = !S.folders.length;
  const removedOpt = el.folderSelect.querySelector(`option[value="${REMOVED}"]`);
  const showRemoved = Boolean(S.removedCount) || S.mediaId === REMOVED;
  if (removedOpt) {
    removedOpt.textContent = `已取消收藏 (${S.removedCount})`;
    removedOpt.hidden = !showRemoved;
  }
  el.removedBtn.textContent = `已取消收藏 ${S.removedCount}`;
  el.removedBtn.hidden = !showRemoved;
  el.aiBtn.innerHTML = `${AI_SPARK}标签${S.ai.running ? " · 运行中" : S.ai.proposal ? " · 待确认" : ""}`;
  renderStatus();
}

// What is running, in one place on every tab: the first that applies wins. done/total draws a bar,
// act puts a button on it (handled like the step bar's buttons), warn turns it amber.
function activityState() {
  const left = S.throttleUntil - Date.now();
  const wait = left > 0 ? `${S.throttleLabel}，${fmtDuration(Math.ceil(left / 1000))} 后重试` : "";
  if (S.group) {
    const done = groupDone(S.group);
    const where = runWhere(S.group);
    const text = where ? `字幕细看 ${done}/${S.group.bvids.length}${where}` : S.group.text || `字幕细看 ${done}/${S.group.bvids.length}`;
    return { text: wait || text, done, total: S.group.bvids.length, act: "group", actLabel: "暂停细看", warn: Boolean(wait) };
  }
  if (S.stage1.running) {
    const where = runWhere(S.stage1);
    const text = where ? `标题粗看中 ${S.stage1.done}/${S.stage1.total}${where}` : S.stage1.text;
    return { text: wait || text, done: S.stage1.done, total: S.stage1.total, act: "stage1", actLabel: "暂停粗看", warn: Boolean(wait) };
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
    return { text: `标签 AI 运行中${where}`, act: "tags", actLabel: "查看" };
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
  el.activity.hidden = !a;
  if (!a) return;
  el.activity.classList.toggle("warn", Boolean(a.warn));
  const bar = a.total ? `<span class="activity-bar" aria-hidden="true"><i style="width:${Math.round((a.done / a.total) * 100)}%"></i></span>` : "";
  const btn = a.act ? `<button type="button" data-head="${a.act}" aria-label="${esc(a.actLabel)}">${esc(a.actLabel)}</button>` : "";
  el.activity.innerHTML = `<span class="activity-text">${esc(a.text)}</span>${bar}${btn}`;
}

function tick() {
  if (S.throttleUntil) renderStatus();
}

function renderTabs() {
  const c = stageCounts();
  const cur = currentStage(c);
  // The selected tab is solid; the step to work on next only gets a dot.
  const tab = (key, label, cls, n) =>
    `<button type="button" role="tab" class="${cls}" data-tab="${key}" aria-selected="${S.tab === key}" aria-label="${label} ${n}${key === cur ? "，当前这一步" : ""}">${label}<span class="count">${n}</span>${key === cur ? `<span class="now" aria-hidden="true"></span>` : ""}</button>`;
  const steps = STAGES.map(([key, label]) => tab(key, label, c[key] ? "step" : "step zero", c[key]));
  el.searchCount.textContent = S.query.trim() ? `搜索：${c.read} 个结果` : "";
  el.tabs.innerHTML = S.mediaId === REMOVED ? tab("read", "已取消收藏", "read-tab", c.read) :
    steps.join(`<span class="arrow" aria-hidden="true">→</span>`) + `<span class="tab-sep" aria-hidden="true"></span>` + tab("read", "阅览", "read-tab", c.read);

  const chips = tagChips();
  // Only when this view has a 看过 video (or the filter is on, so it can be turned off).
  const watchedChip = !S.watchedFilter && !S.items.some(isSeen) ? "" : `<button type="button" class="chip watched${S.watchedFilter ? " on" : ""}" data-watchedfilter aria-pressed="${S.watchedFilter}" aria-label="只看看过的视频">看过</button>`;
  // Only when this view has an invalid video, like 看过; with 全选 it picks them all for 取消收藏 or 清理.
  const invalidN = S.items.filter((it) => it.invalid || it.hidden).length;
  const invalidChip = !S.invalidFilter && !invalidN ? "" : `<button type="button" class="chip invalid${S.invalidFilter ? " on" : ""}" data-invalidfilter aria-pressed="${S.invalidFilter}" aria-label="只看已失效的视频">已失效 ${invalidN}</button>`;
  el.tagFilter.innerHTML = invalidChip + watchedChip + (chips.length
    ? chips
        .map((c) => {
          const on = c.ids.some((id) => S.tagFilter.has(id));
          return `<button type="button" class="chip${on ? " on" : ""}" style="--c:${esc(c.color)}" data-tagfilter="${esc(c.ids.join(","))}" aria-pressed="${on}" aria-label="按标签筛选 ${esc(c.name)}">${esc(c.name)}</button>`;
        })
        .join("")
    : `<span class="muted">还没有自定义标签</span>`); // created from the 标签 button
}

// Marks a control that starts an AI request (tokens.css draws it in the text color).
const AI_SPARK = '<span class="ai-spark" aria-hidden="true"></span>';

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
  const seg = () => {
    const inStage = S.items.filter((it) => (t === "read" || stageOf(it) === t) && passFilter(it));
    const n = (k) => (k === "all" ? inStage.length : inStage.filter((it) => verdictOf(it).verdict === k).length);
    segHtml = `<span class="seg" role="group" aria-label="按 AI 判断筛选">${[["all", "全部"], ...Object.entries(VERDICTS)]
      .map(([k, label]) => `<button type="button" data-class-filter="${k}" aria-pressed="${S.classFilter[t] === k}">${label} ${n(k)}</button>`)
      .join("")}</span>`;
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
    if (ownGroup()) return headBtn("group", `暂停细看 ${groupDone(S.group)}/${S.group.bvids.length}`, "primary");
    const batch = nextBatch();
    const label = batch.some((b) => S.selected.has(b)) ? selectedIn(list).length > batch.length ? `细看选中的前 ${batch.length} 个` : `细看选中 ${batch.length} 个` : batch.length ? `细看下一批 ${batch.length} 个` : "细看";
    return headBtn("group", label, cls, !batch.length || busy, "", "", false, true);
  };
  const stage1Pause = () => headBtn("stage1", `暂停粗看 ${S.stage1.done}/${S.stage1.total}`, "primary");
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
    if (!sel && list.length && f === "unsure") html += `<span class="muted">按 X 或全选后可批量保留、取消收藏、移动或复制</span>`;
  } else if (t === "read" && S.mediaId === REMOVED) {
    const c = S.removedCheck;
    html = seg();
    if (c) html += c.error ? `<span class="fail-text">${esc(c.error)}</span>` : `<span class="muted" aria-busy="true">正在核对 ${c.done} / ${c.total} 个收藏夹，重新收藏的会自动移出</span>`;
    html += `<span class="muted">离开了你勾选的所有收藏夹的视频，AI 分析、备注和标签都还留着。需要的先批量导出，再清理。</span>
      ${headBtn("export-read", "批量导出…", "", !list.length)}${sel ? headBtn("clean-selected", `清理选中的 ${sel} 个`, "danger") : headBtn("clean-removed", `清理这 ${list.length} 个`, "danger", !list.length)}`;
  } else if (t === "read") {
    // 阅览 mixes 粗看 guesses with 细看 conclusions, so no class-wide batch here: only the selection.
    html = seg();
    if (all) html += sortHint;
    else if (sel) selActs = batchBtn("keep");
    else if (list.length) html += `<span class="muted">按 X 或全选后可批量保留、取消收藏、移动或复制</span>`;
    html += headBtn("export-read", "批量导出…", "", !list.length);
  }
  // 移动/复制 works on a selection in any tab of a single folder; in 已取消收藏 it is 收藏到. 取消收藏 goes last, set apart.
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

function renderList() {
  const list = visibleItems();
  renderListHeader(list);
  // 保留 only marks the video here, while 取消收藏 changed Bilibili; say so where both end up.
  const recent = S.tab === "done" ? `<p class="muted tab-note">已保留：${KEEP_TIP}。已取消收藏：已从 B 站收藏夹移走，最近的操作可按 U 撤销。</p>${recentUnfavHtml()}` : "";
  if (!S.items.length) {
    const empty = S.mediaId === REMOVED ? "没有已取消收藏的视频" : S.loadAll?.queue.length ? "正在加载收藏夹…" : "这个收藏夹是空的";
    el.list.innerHTML = `<p class="empty">${empty}</p>${recent}`;
    return;
  }
  if (!list.length) {
    const empty = { none: "没有未分析的视频", coarse: "没有粗看完成的视频", fine: "没有细看完成的视频", done: "还没有处理过的视频" };
    const f = S.classFilter[S.tab];
    const filtered = S.watchedFilter || S.invalidFilter || S.tagFilter.size || (f && f !== "all");
    const text = filtered ? "没有符合筛选的视频" : S.query.trim() ? "没有匹配搜索的视频" : empty[S.tab] || "这里没有视频";
    el.list.innerHTML = `<p class="empty">${text}</p>${recent}`;
    return;
  }
  el.list.classList.toggle("reading", S.mediaId === REMOVED);
  if (S.mediaId === REMOVED) {
    el.list.innerHTML = list.map(readHtml).join("");
    return;
  }
  if (!list.some((it) => it.bvid === S.focused)) {
    S.focused = list[Math.min(S.focusIndex, list.length - 1)].bvid;
  }
  S.focusIndex = list.findIndex((it) => it.bvid === S.focused);
  // 粗看完成 shows which cards the button will send (or is sending) before anything runs.
  // Those cards get a left bar and a label before the title.
  let marked = new Set();
  let word = "";
  if (S.tab === "coarse") {
    const bvids = ownGroup()?.bvids || nextBatch();
    marked = new Set(bvids);
    word = ownGroup() ? "本批" : bvids.some((b) => S.selected.has(b)) ? "已选中" : "下一批";
  }
  const expanded = S.tab === "fine" || S.tab === "read";
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
const KEEP_TIP = "只在 MoonDigest 里标记，B 站收藏夹不变";

function cardHtml(it, expanded, mark) {
  const b = it.bvid;
  const v = verdictOf(it);
  const a = S.analyses[b];
  const done = a?.status === "done";
  const decision = S.decisions[b];
  const inBasket = S.basket.some((x) => x.bvid === b);
  const cls = ["card"];
  if (b === S.focused) cls.push("focused");
  if (isProcessed(b)) cls.push("decided");
  if (S.selected.has(b)) cls.push("selected");
  if (mark) cls.push("in-batch");

  // Where the verdict came from, as one muted meta item.
  const source = [["", "粗看", "细看"][v.stage], done && (a.source === "subtitle" ? "字幕" : "简介")].filter(Boolean).join("·");
  const meta = [it.upper, fmtDuration(it.duration), source, seenText(it), it.invalid && "已失效", it.folders?.length && `收藏夹：${folderNames(it)}`].filter(Boolean);

  const verdict = verdictBadge(b, v);
  // The button matching the AI's verdict leads; the other stays plain.
  const keepCls = !decision && v.verdict === "keep" ? "ok solid" : "";
  const unfavCls = !decision && v.verdict === "drop" ? "danger solid" : "";
  const note = S.notes[b]?.text || "";
  const noteHtml =
    note || S.noteOpen.has(b)
      ? `<textarea class="note" data-note rows="1" placeholder="一句话备注，只有你自己看" aria-label="备注">${esc(note)}</textarea>`
      : "";
  const failed = v.failed
    ? `<span class="fail-text">分析失败：${esc(v.failed)}</span><button type="button" data-act="retry" aria-label="重试分析">${AI_SPARK}重试</button>`
    : "";

  const chips = tagIdsOf(b)
    .map((id) => tagById(id))
    .map((t) => `<span class="chip on" style="--c:${esc(t.color)}">${esc(t.name)}</span>`)
    .join("");

  const body = [];
  if (done && a.oneLiner) body.push(`<p class="oneliner">${esc(a.oneLiner)}</p>`);
  if (done && expanded && a.points?.length) body.push(`<ol class="points">${a.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>`);

  return `<article class="${cls.join(" ")}" data-bvid="${esc(b)}" aria-label="${esc(it.title)}">
    ${coverHtml(it)}
    <div class="card-body">
      <div class="title-row">${mark ? `<span class="batch-tag">${mark}</span>` : ""}<button type="button" class="title" data-act="open" aria-label="打开视频 ${esc(it.title)}">${esc(it.title)}</button></div>
      <div class="meta">${meta.map(esc).join(" · ")}</div>
      ${body.join("")}
      <div class="card-foot">${verdict}${S.watched[b] ? `<button type="button" class="badge watched" data-act="unwatch" aria-label="手动标的看过，点一下取消" title="${esc(fmtTime(S.watched[b]))} 手动标为看过 · 点一下取消"><span class="ai-mark">手动</span>看过</button>` : ""}<span class="reason">${esc(v.reason)}</span>${failed}</div>
      ${chips ? `<div class="chips">${chips}</div>` : ""}
      ${noteHtml}
      <div class="card-foot">
        ${decision ? `<span class="badge ${decision.action === "keep" ? "keep" : "drop"}">${ACTION_LABEL[decision.action]}</span>` : ""}
        ${noteHtml ? "" : `<button type="button" class="link note-add" data-act="note" aria-label="添加备注">+ 备注</button>`}
        <span class="spacer"></span>
        <div class="actions">
          <span class="more">
            <button type="button" data-act="tag" aria-label="打标签 (T)">标签<kbd class="key">T</kbd></button>
            <button type="button" data-act="basket" class="${inBasket ? "on" : ""}" aria-pressed="${inBasket}" aria-label="${inBasket ? "移出" : "加入"}优先看 (E)">优先看<kbd class="key">E</kbd></button>
            <button type="button" data-act="ask" aria-label="问 AI (Q)">${AI_SPARK}问 AI<kbd class="key">Q</kbd></button>
            <button type="button" data-act="select" class="${S.selected.has(b) ? "on" : ""}" aria-pressed="${S.selected.has(b)}" aria-label="选中 (X)">选中<kbd class="key">X</kbd></button>
          </span>
          <button type="button" data-act="keep" class="${keepCls}" aria-label="保留 (S)" title="只在 MoonDigest 里标记，B 站收藏夹不变"${decision ? " disabled" : ""}>保留<kbd class="key">S</kbd></button>
          ${moving.has(b) ? `<button type="button" aria-busy="true" disabled>正在${S.transferRun?.verb || "移动"}…</button>` : deciding.has(b) ? `<button type="button" aria-busy="true" disabled>正在取消收藏…</button>` : `<button type="button" data-act="unfav" class="${unfavCls}" aria-label="取消收藏 (D)"${decision?.action === "unfav" ? " disabled" : ""}>取消收藏<kbd class="key">D</kbd></button>`}
        </div>
      </div>
    </div>
  </article>`;
}

// ---------- reading view ----------
function readHtml(it) {
  const b = it.bvid;
  const v = verdictOf(it);
  const a = S.analyses[b];
  const done = a?.status === "done";
  const verdict = verdictBadge(b, v);
  const names = tagIdsOf(b).map((id) => tagById(id));
  const body = [];
  if (done && a.oneLiner) body.push(`<p class="oneliner">${esc(a.oneLiner)}</p>`);
  if (done && a.points?.length) body.push(`<ol class="points">${a.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>`);
  if (names.length) body.push(`<div class="chips">${names.map((t) => `<span class="chip on" style="--c:${esc(t.color)}">${esc(t.name)}</span>`).join("")}</div>`);
  return `<article class="read-item${isProcessed(b) ? " decided" : ""}${S.selected.has(b) ? " selected" : ""}" data-bvid="${esc(b)}">
    <h3><a href="${videoUrl(b)}" target="_blank" rel="noopener">${esc(it.title)}</a></h3>
    <div class="meta">${[it.upper, fmtDuration(it.duration)].filter(Boolean).map(esc).join(" · ")}${it.folders?.length ? ` · 收藏夹：${esc(folderNames(it))}` : ""}${it.removedAt ? (it.movedTo ? ` · 移到「${esc(it.movedTo.title)}」（未勾选）：${esc(fmtTime(it.removedAt))}` : it.hidden ? ` · 已失效（B 站已隐藏）：${esc(fmtTime(it.removedAt))}` : ` · 离开收藏夹：${esc(fmtTime(it.removedAt))}`) : ""} · ${verdict}${v.reason ? ` <span class="reason">${esc(v.reason)}</span>` : ""}</div>
    ${body.join("")}${it.removedAt ? `<button type="button" data-select="${esc(b)}" class="${S.selected.has(b) ? "on" : ""}" aria-pressed="${S.selected.has(b)}" aria-label="选中 ${esc(it.title)}">选中</button>` : ""}${it.removedAt ? `<button type="button" class="danger" data-clean="${esc(b)}" aria-label="清理 ${esc(it.title)}">清理</button>` : ""}
  </article>`;
}

function folderTitle() {
  if (S.mediaId === ALL) return "所有收藏夹";
  if (S.mediaId === REMOVED) return "已取消收藏";
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
async function patchDecisions(mediaId, patch) {
  const stored = await storeGet(K.decisions(mediaId), {});
  const maps = [stored, mediaId === S.mediaId && S.decisions, S.folderDecisions[mediaId]].filter(Boolean);
  for (const d of maps) {
    for (const [b, v] of Object.entries(patch)) {
      if (v) d[b] = v;
      else delete d[b];
    }
  }
  await storeSet(K.decisions(mediaId), unfavOnly(stored));
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
  if (it.folders && !left.length) S.decisions[bvid] = rec;
  pushUndo({ kind: "decision", bvid, action, prev, prevs });
  const from = left.length ? `从「${folders.map(folderName).join("、")}」` : "";
  toast(`已${from}取消收藏《${shortTitle(it)}》 · U 撤销`);
  render();
  advanceFrom(bvid, before);
}

async function undo() {
  const entry = S.undo.pop();
  if (!entry) {
    toast("没有可撤销的操作");
    return;
  }
  if (entry.kind === "decision") {
    const it = S.itemMap.get(entry.bvid);
    const token = S.folderToken;
    if (entry.action === "unfav") toast(`正在重新收藏《${shortTitle(it)}》…`);
    for (const [mediaId, prev] of Object.entries(entry.prevs)) {
      if (entry.action === "unfav") {
        const r = await send({ type: "triage-refav", mediaId, aid: it.aid });
        if (!r.ok) {
          if (token === S.folderToken) toast(`撤销失败：${r.error}。可到 B 站手动重新收藏`, true);
          return;
        }
        bumpCount(mediaId, 1);
      }
      await patchDecisions(mediaId, { [entry.bvid]: prev });
    }
    if (token !== S.folderToken) return;
    if (it.folders) {
      if (entry.action === "unfav") it.folders = [...new Set([...it.folders, ...Object.keys(entry.prevs)])];
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
  } else if (entry.kind === "watched") {
    if (entry.prev) S.watched[entry.bvid] = entry.prev;
    else delete S.watched[entry.bvid];
    saveWatched();
    if (entry.basketEntry) {
      S.basket.splice(entry.basketEntry.i, 0, entry.basketEntry.x);
      saveBasket();
    }
    toast(entry.prev ? "已撤销：取消手动看过" : "已撤销：手动看过");
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
    S.tags = entry.prevTags;
    S.videoTags = entry.prevVideoTags;
    for (const id of [...S.tagFilter]) if (!tagById(id)) S.tagFilter.delete(id);
    saveTags();
    saveVideoTags();
    toast(`已撤销批量打标签对 ${entry.count} 个视频的改动`);
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
  const ok = await askConfirm(`取消收藏这 ${list.length} 个视频？`, `<ul>${titles}</ul>${more}`, `取消收藏 ${list.length} 个`);
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
    toast(`已取消收藏 ${done} 个 · 撤销(U)`);
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
    el.transferUnchosen.textContent = S.mediaId === REMOVED
      ? `「${folderName(v)}」没有勾选分拣：收藏后这些视频仍在「已取消收藏」。以后在分拣设置里勾选它，会自动找回。`
      : `「${folderName(v)}」没有勾选分拣：移动过去的视频会进「已取消收藏」。以后在分拣设置里勾选它，这些视频会自动找回。复制不受影响。`;
  }
}

// Folders are not read while a run writes them (writingTo), so both cached lists change here instead of by a sync: the target
// gains the videos (a new folder starts with exactly these), the source loses them without counting them as having left
// every folder (已取消收藏). A folder with no cached list is left to its first load.
async function patchSnapshot(mediaId, { add = [], drop = [] }, created = false) {
  const key = K.snapshot(mediaId);
  const snap = await storeGet(key, null);
  if (!snap && !created) return;
  const old = snap || { bvids: [], invalid: [], titles: {}, items: [], ids: [], intro: "" };
  const gone = new Set(drop);
  const fresh = add.filter((it) => !old.bvids.includes(it.bvid));
  const added = fresh.map((it) => it.bvid);
  const keep = (b) => !gone.has(b);
  await chrome.storage.local.set({
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
}

// It changes Bilibili, so like 取消收藏 it runs to the end even after another folder opens.
async function batchTransfer(list) {
  if (!list.length || S.transferRun || S.unfavBatch) return;
  const from = String(S.mediaId);
  const ask = await askTransfer(list);
  if (!ask || S.transferRun || S.unfavBatch) return;
  const { how, target } = ask;
  const add = how === "add"; // from 已取消收藏: no source folder on Bilibili
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
  // From 稍后再看 or 已取消收藏 Bilibili takes one video per request: one per chunk keeps the count exact on a failure.
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
    if (chosen) await patchSnapshot(to, { add: chunk.map(({ removedAt, movedTo, ...it }) => it) }, Boolean(target.create));
    if (add) {
      if (chosen) await dropRemoved(chunk.map((it) => it.bvid));
      else await addMovedToRemoved(from, chunk.map(({ removedAt, movedTo, ...it }) => it), { id: to, title: toName });
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
    toast(`${where}已${verb} ${done} 个到「${toName}」${(move || add) && !S.included.includes(to) ? "，它们在「已取消收藏」里，勾选这个收藏夹后会自动找回" : ""}`);
  }
  render();
}

// Moved to a folder outside triage: like any video that left every chosen folder, it goes to 已取消收藏, marked with
// where it went. Ticking that folder brings it back (recoverRemoved).
async function addMovedToRemoved(from, items, movedTo) {
  const others = S.folders.map((f) => String(f.id)).filter((id) => id !== from);
  const got = await chrome.storage.local.get([K.removed, ...others.map(K.snapshot)]);
  const otherBvids = new Set(others.flatMap((id) => got[K.snapshot(id)]?.bvids || []));
  const removed = got[K.removed] || {};
  const at = Date.now();
  for (const it of items) if (!otherBvids.has(it.bvid)) removed[it.bvid] = { item: it, at, movedTo };
  await chrome.storage.local.set({ [K.removed]: removed });
  if (S.mediaId === REMOVED) {
    for (const it of items) {
      if (!removed[it.bvid]) continue;
      const shown = S.itemMap.get(it.bvid);
      if (shown) Object.assign(shown, { removedAt: at, movedTo });
      else S.items.unshift({ ...it, removedAt: at, movedTo });
    }
    S.itemMap = new Map(S.items.map((x) => [x.bvid, x]));
  }
  S.removedCount = Object.keys(removed).length;
  renderTop();
}

// Newly ticked folders take back their videos from 已取消收藏 at once, without waiting for the folder to be opened.
async function recoverRemoved(ids) {
  if (!Object.keys(await storeGet(K.removed, {})).length) return;
  let n = 0;
  for (const id of ids) {
    const r = await send({ type: "triage-folder-ids", mediaId: id });
    if (r.ok) n += await dropRemoved(r.data.bvids);
  }
  if (n) {
    toast(`已从「已取消收藏」找回 ${n} 个视频`);
    renderTop();
  }
}

function batchKeep(list) {
  if (!list.length) return;
  const at = Date.now();
  patchKept(Object.fromEntries(list.map((it) => [it.bvid, { action: "keep", at }])));
  for (const it of list) S.selected.delete(it.bvid);
  pushUndo({ kind: "keepMany", bvids: list.map((it) => it.bvid) });
  toast(`已标记保留 ${list.length} 个 · 撤销(U)`);
  render();
}

// ---------- tags ----------
const saveTags = () => storeSet(K.tags, S.tags);

// Returns the folder's tag with this name, creating it if needed; the color comes from the palette in turn.
// null (with a toast) outside a folder or when the folder already has TAG_LIMIT tags.
function createTag(name, folder = S.mediaId) {
  if (folder === ALL || folder === REMOVED || !folder) return toast(FOLDER_ONLY, true), null;
  const own = S.tags.filter((t) => t.folder === String(folder));
  const existing = own.find((t) => t.name === name);
  if (existing) return existing;
  if (own.length >= TAG_LIMIT) return toast(`这个收藏夹已经有 ${TAG_LIMIT} 个标签了，先删掉不用的`, true), null;
  const tag = { id: newTagId(), name, color: TAG_COLORS[own.length % TAG_COLORS.length], folder: String(folder) };
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

const picker = { bvid: "", prev: [], ids: [], index: 0, options: [] };

function openPicker(bvid) {
  const it = S.itemMap.get(bvid);
  if (!it) return;
  picker.bvid = bvid;
  // Every tag of the video, so saving keeps the ones of other folders the picker does not list.
  picker.prev = (S.videoTags[bvid] || []).filter((id) => tagById(id));
  picker.ids = [...picker.prev];
  picker.index = 0;
  el.pickerTitle.textContent = `打标签 ·《${shortTitle(it)}》`;
  el.pickerInput.value = "";
  renderPicker();
  el.pickerDialog.showModal();
  el.pickerInput.focus();
}

// The picker's tags: the open folder's; in 所有收藏夹 those of the folders the video is in. New tags need one folder.
function pickerFolders(bvid) {
  return inFolderView() ? [String(S.mediaId)] : (S.itemMap.get(bvid)?.folders || []).map(String);
}

function renderPicker() {
  const q = el.pickerInput.value.trim();
  const folders = pickerFolders(picker.bvid);
  const tags = S.tags.filter((t) => folders.includes(t.folder));
  const opts = tags.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase())).map((t) => ({ tag: t }));
  if (q && folders.length === 1 && !tags.some((t) => t.name === q)) opts.unshift({ create: q });
  picker.options = opts;
  picker.index = Math.min(picker.index, Math.max(0, opts.length - 1));
  el.pickerList.innerHTML = opts.length
    ? opts
        .map((o, i) => {
          const active = i === picker.index ? " active" : "";
          if (o.create) return `<li role="option" class="picker-opt${active}" data-i="${i}" aria-selected="${i === picker.index}">新建「${esc(o.create)}」</li>`;
          const on = picker.ids.includes(o.tag.id);
          return `<li role="option" class="picker-opt${active}" data-i="${i}" aria-selected="${i === picker.index}" aria-checked="${on}"><span class="check">${on ? "✓" : ""}</span><span class="dot" style="--c:${esc(o.tag.color)}"></span>${esc(o.tag.name)}</li>`;
        })
        .join("")
    : `<li class="muted">${folders.length === 1 ? "输入名称后回车新建标签" : "在具体收藏夹里新建标签"}</li>`;
  el.pickerList.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

function pickOption(i) {
  const o = picker.options[i];
  if (!o) return;
  if (o.create) {
    const t = createTag(o.create, pickerFolders(picker.bvid)[0]);
    if (t) picker.ids.push(t.id);
    el.pickerInput.value = "";
    picker.index = 0;
  } else if (picker.ids.includes(o.tag.id)) {
    picker.ids = picker.ids.filter((id) => id !== o.tag.id);
  } else {
    picker.ids.push(o.tag.id);
  }
  renderPicker();
}

function closePicker() {
  const changed = setVideoTags(picker.bvid, picker.ids, picker.prev);
  render();
  if (changed) toast("标签已更新 · 撤销(U)");
  setFocus(S.focused, true);
}

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
  if (ok) redoCoarse(stale);
}

// The old 粗看 results go, so these videos are back in 未分析 and the next 标题粗看 run takes them.
async function redoCoarse(list) {
  const bvids = list.map((it) => it.bvid);
  for (const b of bvids) delete S.titleRes[b];
  await chrome.storage.local.remove(bvids.map((b) => `triage_title_${b}`));
  runStage1();
}

// ---------- 标签 dialog: 管理 / 批量打 ----------
// The 标签 button opens 批量打 while a run or a proposal is pending, otherwise 管理.
function tagsBtnMode() {
  return S.ai.running || S.ai.proposal ? "batch" : "manage";
}

function openTags(mode = "manage") {
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

// A rename or rule edit from 管理; false (and nothing saved) for an empty or duplicate name.
function saveTagEdit(t, field, value) {
  const text = String(value ?? "").trim();
  if (field === "name") {
    if (!text || S.tags.some((x) => x !== t && x.folder === t.folder && x.name === text)) {
      toast(text ? "已有同名标签" : "标签名不能为空", true);
      return false;
    }
    t.name = text;
  } else if (field === "rule") {
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
    ? tags
        .map(
          (t) => `<div class="tag-row" data-id="${esc(t.id)}">
      <span class="dot" style="--c:${esc(t.color)}"></span>
      <input type="text" value="${esc(t.name)}" data-field="name" aria-label="标签名称" />
      <input type="text" value="${esc(t.rule || "")}" data-field="rule" maxlength="80" placeholder="什么样的视频打这个标签（给 AI 看，可不写）" aria-label="${esc(t.name)} 的说明" />
      <span class="muted">${counts[t.id] || 0} 个视频</span>
      <button type="button" class="danger" data-field="delete" aria-label="删除标签 ${esc(t.name)}">删除</button>
    </div>`
        )
        .join("")
    : `<p class="muted">这个收藏夹还没有自定义标签</p>`;
}

async function deleteTag(id) {
  const t = tagById(id);
  const n = Object.values(S.videoTags).filter((ids) => ids.includes(id)).length;
  const ok = await askConfirm(`删除标签「${t.name}」？`, `<p>将从 ${n} 个视频上移除这个标签，无法撤销。</p>`, "删除");
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
  return { bvid: it.bvid, title: it.title, upper: it.upper, duration: it.duration, intro: it.intro };
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

async function runStage1() {
  if (S.stage1.running) return;
  // Everything the run needs is taken now: it keeps going after another folder opens.
  const folder = String(S.mediaId);
  const crit = criteria();
  const ctx = folderContext();
  const list = stage1Pending();
  // Timed-out batches are skipped for this run only, so clicking 标题粗看 again retries them.
  const timedOut = new Set();
  // In its own folder the live step decides (a card may have been sorted meanwhile); elsewhere only the result does.
  const pending = () =>
    list.filter((it) => !timedOut.has(it.bvid) && !S.stage1Skip.has(it.bvid) && (S.mediaId === folder ? stageOf(it) === "none" : !VERDICTS[S.titleRes[it.bvid]?.verdict]));
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
  const names = tagIdsOf(it.bvid).filter((id) => own.has(id)).map((id) => tagById(id).name);
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
  const labels = { filter: "当前筛选结果", selected: "已选中 (X)", analyzed: "只处理细看过的" };
  for (const o of el.aiScope.options) {
    o.textContent = `${labels[o.value]} · ${counts[o.value]} 个`;
    o.disabled = !counts[o.value];
  }
  if (el.aiScope.selectedOptions[0]?.disabled) el.aiScope.value = "filter";
  const items = aiScopeItems();
  const n = items.length;
  const done = items.filter(isAnalyzed).length;
  const size = Math.max(1, Number(S.settings.triageTitleBatchSize) || 30);
  const parts = [done && `${done} 个细看过（按总结和要点判断）`, n - done && `${n - done} 个只有标题和简介，标签可能不准`].filter(Boolean);
  el.aiScopeCount.textContent = n ? `${n} 个视频：${parts.join("，")}。分 ${Math.ceil(n / size)} 批发送` : "作用范围里没有视频";
  const tags = viewTags();
  const room = aiNewTagRoom();
  const roomHint = room ? `AI 这次最多新建 ${room} 个（这个收藏夹还剩 ${TAG_LIMIT - tags.length} 个名额），你确认后才创建。` : "名额已满，AI 只会用已有标签。";
  el.aiTagsPreview.innerHTML = !inFolderView()
    ? `<p class="dialog-hint">${FOLDER_ONLY}再批量打。</p>`
    : tags.length
      ? `<div class="chips">AI 能用的标签：${tags.map((t) => `<span class="chip">${esc(t.name)}</span>`).join("")}</div><p class="dialog-hint">${roomHint}</p>`
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
  const opts = { maxNewTags: aiNewTagRoom(), folder };
  const tags = viewTags().map((t) => ({ name: t.name, rule: t.rule || "" }));
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
    const r = await send({ type: "triage-ai-command", instruction, items: batch, tags, maxNewTags: opts.maxNewTags });
    if (!r.ok) {
      p.errors.push(`第 ${i + 1} 批失败：${r.error}`);
      if (/截断|配置 AI|未授权访问/.test(r.error || "")) handleAiError(r.error);
    } else {
      mergeAiBatch(p, r.data, opts, scopeSet);
    }
    if (i + 1 < total) await sleepWhile(S.settings.triageIntervalSec * 1000, keepGoing);
  }
  S.ai.running = false;
  el.aiProgress.textContent = "";
  if (S.ai.stop) p.errors.push("已手动停止，这里只有已完成批次的建议");
  S.ai.proposals[folder] = p;
  renderTop();
  if (folder !== String(S.mediaId)) {
    if (el.tagsDialog.open) renderAiForm();
    toast(`「${folderName(folder)}」的标签建议已完成，在状态栏点「查看」确认`);
  } else if (el.tagsDialog.open && el.tagsManage.hidden) showAiReview();
  else toast("批量打标签已完成，按 I 查看建议");
}

function mergeAiBatch(p, data, opts, scopeSet) {
  const existing = (name) => S.tags.find((t) => t.folder === opts.folder && t.name === name);
  const proposed = (name) => p.newTags.find((t) => t.key === name);
  const addNew = (name) => {
    if (p.newTags.length >= opts.maxNewTags) return null;
    const t = { key: name, name, checked: true };
    p.newTags.push(t);
    return t;
  };

  for (const raw of data?.newTags || []) {
    const name = String(raw ?? "").trim();
    if (name && !existing(name) && !proposed(name)) addNew(name);
  }
  if (data?.note) p.notes.push(String(data.note));

  for (const [bvid, a] of Object.entries(data?.assignments || {})) {
    if (!scopeSet.has(bvid)) continue;
    const current = S.videoTags[bvid] || []; // not tagIdsOf: the open folder may have changed since the run started
    const add = [];
    for (const raw of a?.add || []) {
      const name = String(raw ?? "").trim();
      if (!name) continue;
      const t = existing(name);
      if (t) {
        if (!current.includes(t.id)) add.push(`id:${t.id}`);
        continue;
      }
      const nt = proposed(name) || addNew(name);
      if (nt) add.push(`new:${nt.key}`);
    }
    const remove = (a?.remove || [])
      .map((n) => existing(String(n ?? "").trim()))
      .filter((t) => t && current.includes(t.id))
      .map((t) => t.id);
    if (!add.length && !remove.length) continue;
    const row = p.rows.find((r) => r.bvid === bvid);
    if (row) {
      row.add = [...new Set([...row.add, ...add])];
      row.remove = [...new Set([...row.remove, ...remove])];
      row.reason = a?.reason || row.reason;
    } else {
      p.rows.push({ bvid, add, remove, reason: a?.reason || "", checked: true });
    }
  }
}

// Row changes after dropping adds of unchecked new tags. A video that left the folder since the proposal is skipped.
function effectiveRow(p, row) {
  if (!S.itemMap.has(row.bvid)) return { add: [], empty: true };
  const add = row.add.filter((ref) => !ref.startsWith("new:") || p.newTags.find((t) => t.key === ref.slice(4))?.checked);
  return { add, empty: !add.length && !row.remove.length };
}

function refName(p, ref) {
  return ref.startsWith("id:") ? tagById(ref.slice(3))?.name || "" : p.newTags.find((t) => t.key === ref.slice(4))?.name || "";
}

function renderAiReview() {
  const p = S.ai.proposal;
  el.aiNotes.innerHTML =
    p.errors.map((e) => `<p class="fail-text">${esc(e)}</p>`).join("") +
    p.notes.map((n) => `<p class="muted">AI 说明：${esc(n)}</p>`).join("");
  el.aiNewTags.innerHTML = p.newTags.length
    ? p.newTags
        .map(
          (t, i) => `<div class="ai-newtag" data-i="${i}">
      <input type="checkbox" data-nt="checked"${t.checked ? " checked" : ""} aria-label="创建标签 ${esc(t.name)}" />
      <input type="text" data-nt="name" value="${esc(t.name)}" aria-label="新标签名称" />
    </div>`
        )
        .join("")
    : `<p class="muted">没有新标签</p>`;
  renderAiRows();
}

function renderAiRows() {
  const p = S.ai.proposal;
  const rows = p.rows.map((r) => ({ r, e: effectiveRow(p, r) })).filter((x) => !x.e.empty);
  const checked = rows.filter((x) => x.r.checked).length;
  el.aiReviewSummary.textContent = `${rows.length} 个视频有改动 · 新标签 ${p.newTags.filter((t) => t.checked).length} 个 · 点「应用选中」前不会改动任何东西`;
  el.aiRows.innerHTML = rows.length
    ? rows
        .map(({ r, e }) => {
          const it = S.itemMap.get(r.bvid);
          const chips =
            e.add.map((ref) => `<span class="chip add">+ ${esc(refName(p, ref))}</span>`).join("") +
            r.remove.map((id) => `<span class="chip remove">− ${esc(tagById(id)?.name)}</span>`).join("");
          return `<div class="ai-row${r.checked ? "" : " off"}" data-bvid="${esc(r.bvid)}">
        <input type="checkbox" data-row${r.checked ? " checked" : ""} aria-label="应用到 ${esc(it?.title)}" />
        <div class="ai-row-body">
          <div class="ai-row-title">${esc(it?.title || r.bvid)}</div>
          <div class="chips">${chips}</div>
          ${r.reason ? `<div class="muted">${esc(r.reason)}</div>` : ""}
        </div>
      </div>`;
        })
        .join("")
    : `<p class="empty">AI 没有提出改动</p>`;
  el.aiApplyBtn.textContent = `应用选中 (${checked})`;
  el.aiApplyBtn.setAttribute("aria-label", el.aiApplyBtn.textContent);
  el.aiApplyBtn.disabled = !checked && !p.newTags.some((t) => t.checked);
}

function applyAiProposal() {
  const p = S.ai.proposal;
  if (!p) return;
  const rows = p.rows.filter((r) => r.checked).map((r) => ({ r, e: effectiveRow(p, r) })).filter((x) => !x.e.empty);
  const prevTags = structuredClone(S.tags);
  const prevVideoTags = structuredClone(S.videoTags);
  const idFor = {};
  for (const t of p.newTags) {
    const name = t.name.trim();
    if (t.checked && name) idFor[t.key] = createTag(name)?.id;
  }
  for (const { r, e } of rows) {
    const ids = new Set(S.videoTags[r.bvid] || []);
    for (const ref of e.add) {
      const id = ref.startsWith("id:") ? ref.slice(3) : idFor[ref.slice(4)];
      if (id) ids.add(id);
    }
    for (const id of r.remove) ids.delete(id);
    if (ids.size) S.videoTags[r.bvid] = [...ids];
    else delete S.videoTags[r.bvid];
  }
  saveTags();
  saveVideoTags();
  pushUndo({ kind: "aiApply", prevTags, prevVideoTags, count: rows.length });
  S.ai.proposal = null;
  el.tagsDialog.close();
  render();
  toast(`已应用 AI 建议：${rows.length} 个视频 · 撤销(U)`);
}

// ---------- 优先看 ----------
// triage_basket is the 优先看 list in order: [{ bvid, title, cover?, upper?, duration?, opened? }]; the copied
// fields show videos outside the open folder (entries from before they were copied have only the title).
const saveBasket = () => storeSet(K.basket, S.basket);

function toggleBasket(bvid) {
  const i = S.basket.findIndex((x) => x.bvid === bvid);
  const it = S.itemMap.get(bvid);
  if (i >= 0) {
    S.basket.splice(i, 1);
    toast("已移出优先看");
  } else if (it) {
    S.basket.push({ bvid, title: it.title, cover: it.cover, upper: it.upper, duration: it.duration });
    toast(`已加入优先看《${shortTitle(it)}》`);
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

// 已看，下一个 in the viewer: the playing video is marked watched, leaves the queue, and the next one takes its place.
function basketDoneAndNext() {
  removeBasketItem(S.basket.findIndex((x) => x.bvid === S.viewing));
  if (S.basket.length) openBasketItem(Math.max(0, S.basket.findIndex((x) => !x.opened)));
  else {
    closeViewer();
    toast("优先看已经看完了");
  }
}

// 已看 marks the video 手动看过 and takes it out of 优先看; favorites and decisions are untouched. U undoes both.
function removeBasketItem(i) {
  const [x] = S.basket.splice(i, 1);
  if (!x) return;
  saveBasket();
  setWatched(x.bvid, true, { i, x });
}

const saveWatched = () => storeSet(K.watched, S.watched);
function setWatched(bvid, on, basketEntry = null) {
  pushUndo({ kind: "watched", bvid, prev: S.watched[bvid] || 0, basketEntry });
  if (on) S.watched[bvid] = Date.now();
  else delete S.watched[bvid];
  saveWatched();
  render();
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
        ${it.cover ? `<img class="basket-cover" src="${esc(it.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ""}
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
    if (it.upper) lines.push(`UP：${it.upper}`, "");
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
// 优先看 videos outside the open folder export with their stored title.
function writeScopeItems(scope = el.writeScope.value) {
  const list =
    scope === "all" ? S.items
    : scope === "basket" ? S.basket.map((x) => S.itemMap.get(x.bvid) || { bvid: x.bvid, title: x.title || x.bvid })
    : scope === "selected" ? visibleSelected()
    : visibleItems();
  return list.filter((it) => !it.invalid);
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
    ? `共 ${n} 个视频，逐个抓字幕，间隔 ${S.settings.triageIntervalSec} 秒。下载 .md 合成一个文件${obsidianOff ? "" : "；写入 Obsidian 每个视频一篇，另写一篇以收藏夹命名的索引"}。`
    : `共 ${n} 个视频，合成一篇：链接、AI 总结、标签和你的笔记。`;
  el.writeOverwriteRow.hidden = !notes;
  el.writeCopyBtn.hidden = notes || busy;
  el.writeRunBtn.hidden = el.writeMdBtn.hidden = busy;
  el.writeStopBtn.hidden = !busy;
  el.writeCopyBtn.disabled = el.writeRunBtn.disabled = el.writeMdBtn.disabled = !n;
  el.writeScope.disabled = el.writeFormat.disabled = el.writeOverwrite.disabled = busy;
  // One blue button: 写入 Obsidian, or 下载 .md when Obsidian is off.
  el.writeMdBtn.classList.toggle("primary", obsidianOff);
}

// 一篇摘录 needs summaries of 优先看 videos from other folders too.
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
// | [ ] or a newline in the alias would end the link early; the path is already a safe note filename.
function wikiLink(path, title) {
  const target = String(path).replace(/\.md$/, "");
  return `[[${target}|${oneLine(String(title ?? "").replace(/[|[\]]/g, " ")) || target}]]`;
}

// md: build the same notes but download them as one file instead of writing to the vault.
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
    indexPath = `${safeNoteName(folderTitle())}.md`;
    const notes = written.map((w) => `# ${w.title}\n\n${w.markdown.replace(/^---\n([\s\S]*?)\n---\n/, "```yaml\n$1\n```\n")}`);
    BocDownload.text(indexPath, [`# ${folderTitle()}`, `${stamp(new Date(), false)} · ${written.length} 篇`, ...notes].join("\n\n"));
  } else if (written.length && keepGoing()) {
    const lines = [`# ${folderTitle()}`, "", `${stamp(new Date(), false)} · ${written.length} 篇`, ""];
    for (const w of written) {
      const oneLiner = S.analyses[w.bvid]?.oneLiner;
      lines.push(`- ${wikiLink(w.path, w.title)}${oneLiner ? ` ${oneLine(oneLiner)}` : ""}`);
    }
    const r = await send({ type: "triage-export", filename: `${safeNoteName(folderTitle())}.md`, markdown: lines.join("\n") });
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
const BACKUP_PREFIXES = [K.kept, K.watched, K.removed, K.tags, K.folderCriteria, "triage_video_tags", "triage_basket", K.notes, "triage_snapshot_", "triage_decisions_", "triage_title_", "triage_analysis_"];

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
    else if (k === K.watched) out.watched = v;
    else if (k === K.removed) out.removed = v;
    else if (k === K.folderCriteria) out.folderCriteria = v;
    else if (k === "triage_video_tags") out.videoTags = v;
    else if (k === "triage_basket") out.basket = v;
    else if (k === K.notes) out.notes = v;
    else if (k.startsWith("triage_snapshot_")) folder(k.slice(16)).snapshot = v;
    else if (k.startsWith("triage_decisions_")) folder(k.slice(17)).decisions = v;
    else if (k.startsWith("triage_title_")) out.titleResults[k.slice(13)] = v;
    else if (k.startsWith("triage_analysis_")) out.analyses[k.slice(16)] = v;
  }
  return out;
}

function csvField(v) {
  let s = String(v ?? "");
  // Spreadsheets run a cell that starts with = + - @ (or tab/CR) as a formula; a leading ' keeps it text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function buildCsv() {
  const title = folderTitle();
  const header = ["收藏夹", "BV号", "标题", "UP主", "时长", "链接", "AI判断", "判断来源", "理由", "一句话", "要点", "标签", "我的处理", "处理时间", "是否失效"];
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
      v.verdict === "none" ? "" : verdictLabel(v.verdict),
      ["", "标题粗看", "字幕细看"][v.stage] || "",
      v.reason,
      done ? a.oneLiner || "" : "",
      done ? (a.points || []).join(" | ") : "",
      tagIdsOf(it.bvid).map((id) => tagById(id).name).join("、"),
      d ? (d.action === "unfav" ? "取消收藏" : "保留") : "",
      d ? fmtTime(d.at) : "",
      it.invalid ? "是" : "否"
    ]);
  }
  return "﻿" + rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

// ---------- events ----------
function bindEvents() {
  el.folderSelect.addEventListener("change", () => openFolder(el.folderSelect.value));
  el.removedBtn.addEventListener("click", () => {
    el.tools.hidePopover();
    openFolder(REMOVED);
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
  });
  el.searchInput.addEventListener("input", (e) => {
    if (e.isComposing) return;
    S.query = el.searchInput.value;
    S.focusIndex = 0;
    render();
  });
  // Esc clears the box; on an empty box it hands the keys back to the cards.
  el.searchInput.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.isComposing) return;
    e.preventDefault();
    if (!el.searchInput.value) return el.searchInput.blur();
    el.searchInput.value = S.query = "";
    render();
  });
  el.tagFilter.addEventListener("click", (e) => {
    if (e.target.closest("[data-watchedfilter]")) {
      S.watchedFilter = !S.watchedFilter;
      return render();
    }
    if (e.target.closest("[data-invalidfilter]")) {
      S.invalidFilter = !S.invalidFilter;
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
    if (act === "tags") el.aiBtn.click();
    else if (act === "aiOther") openFolder(otherAiFolder()).then(() => openTags("batch"));
    else if (act === "stage1") {
      if (!S.stage1.running) return runStage1();
      S.stage1.stop = true;
      S.stage1.text = "粗看将在当前批次后暂停";
      renderStatus();
    } else if (act === "group") {
      if (S.group) {
        S.group.stop = true;
        S.group.text = "细看将在当前视频后暂停";
        return renderStatus();
      }
      const batch = nextBatch();
      for (const b of batch) S.selected.delete(b);
      startGroup(batch);
    } else if (act === "batch-unfav") batchUnfav(batchList(btn.dataset.verdict || null));
    else if (act === "batch-keep") batchKeep(batchList(btn.dataset.verdict || null));
    else if (act === "criteria") openCriteria();
    else if (act === "redo-coarse") redoCoarse(staleCoarse());
    else if (act === "redo-fine") startGroup(staleFine().slice(0, GROUP_SIZE).map((it) => it.bvid), true);
    else if (act === "all-pause") {
      S.loadAll.paused = true;
      render();
    } else if (act === "all-resume") {
      S.loadAll.paused = false;
      runLoadAll(S.folderToken);
    }
    else if (act === "export-read") openWrite({ scope: "filter", format: "digest" });
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
    if (e.key === "Enter" && !e.isComposing) e.preventDefault();
  });
  el.stagebar.addEventListener("click", onHeadClick);
  el.activity.addEventListener("click", onHeadClick);

  el.list.addEventListener("click", (e) => {
    if (e.target.closest("[data-pick-folders]")) return openSettings(false, true);
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
    const bvid = card.dataset.bvid;
    const act = e.target.closest("[data-act]")?.dataset.act;
    setFocus(bvid, false);
    if (act) cardAction(act, bvid);
  });

  el.list.addEventListener("input", (e) => {
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
  });
  // Enter (or Esc) saves now and leaves the note so card keys work again; Shift+Enter is a newline. Never mid-IME.
  el.list.addEventListener("keydown", (e) => {
    if (!e.target.matches("[data-note]") || e.isComposing || e.keyCode === 229) return;
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
  // The open folder's own Bilibili page; 所有收藏夹 and 已取消收藏 have none, so they go to the space page.
  el.biliBtn.addEventListener("click", () =>
    openTab(
      S.mediaId === TOVIEW
        ? "https://www.bilibili.com/watchlater/list"
        : `https://space.bilibili.com/${S.mid}${inFolderView() ? `/favlist?fid=${S.mediaId}&ftype=create` : ""}`
    )
  );
  el.viewerNextBtn.addEventListener("click", basketDoneAndNext);
  el.viewerTabBtn.addEventListener("click", () => openTab(videoUrl(S.viewing)));

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
      triageAnalyzeMaxTokens: parseMaxTokens(el.analyzeMaxInput.value)
    };
    const r = await send({ type: "triage-settings-save", ...patch });
    if (!r.ok) {
      toast(`保存设置失败：${r.error}`, true);
      return;
    }
    Object.assign(S.settings, patch);
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
  el.backupBtn.addEventListener("click", async () => {
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

  el.syncViewBtn.addEventListener("click", () => {
    el.syncNotice.hidden = !el.syncNotice.hidden;
    el.syncViewBtn.setAttribute("aria-expanded", String(!el.syncNotice.hidden));
  });
  el.syncCloseBtn.addEventListener("click", hideSyncNotice);
  el.bannerClose.addEventListener("click", () => (el.banner.hidden = true));

  // tag picker
  el.pickerInput.addEventListener("input", () => {
    picker.index = 0;
    renderPicker();
  });
  el.pickerInput.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // Enter confirms the IME candidate, not the tag
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = picker.options.length;
      if (n) picker.index = (picker.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      renderPicker();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickOption(picker.index);
    }
  });
  el.pickerList.addEventListener("mousedown", (e) => {
    const li = e.target.closest("[data-i]");
    if (!li) return;
    e.preventDefault();
    picker.index = Number(li.dataset.i);
    pickOption(picker.index);
    el.pickerInput.focus();
  });
  el.pickerDialog.addEventListener("close", closePicker);
  // A backdrop click closes and saves like Esc. The dialog's own padding is also the dialog element, so check the point too.
  el.pickerDialog.addEventListener("click", (e) => {
    if (e.target !== el.pickerDialog) return;
    const r = el.pickerDialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) el.pickerDialog.close();
  });

  el.criteriaInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    el.criteriaDialog.close("save");
  });
  el.criteriaDialog.addEventListener("close", () => {
    if (el.criteriaDialog.returnValue === "save") saveCriteria();
  });
  el.aiBtn.addEventListener("click", () => openTags(tagsBtnMode()));
  el.tagsDialog.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tags-mode]");
    if (btn) showTagsMode(btn.dataset.tagsMode);
  });
  el.tagsRows.addEventListener("change", (e) => {
    const row = e.target.closest(".tag-row");
    const t = row && tagById(row.dataset.id);
    const field = e.target.dataset.field;
    if (t && field && !saveTagEdit(t, field, e.target.value) && field === "name") e.target.value = t.name;
  });
  el.tagsRows.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-field="delete"]');
    if (btn) deleteTag(btn.closest(".tag-row").dataset.id);
  });
  const addTag = () => {
    const name = el.newTagInput.value.trim();
    if (!name || !createTag(name)) return;
    el.newTagInput.value = "";
    renderTagManager();
    render();
  };
  el.addTagBtn.addEventListener("click", addTag);
  el.newTagInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    }
  });

  // 批量打
  el.aiScope.addEventListener("change", renderAiForm);
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
  el.aiRows.addEventListener("change", (e) => {
    if (!e.target.matches("[data-row]")) return;
    const row = S.ai.proposal?.rows.find((r) => r.bvid === e.target.closest(".ai-row").dataset.bvid);
    if (row) row.checked = e.target.checked;
    renderAiRows();
  });
  const setAllRows = (checked) => {
    for (const r of S.ai.proposal?.rows || []) r.checked = checked;
    renderAiRows();
  };
  el.aiAllBtn.addEventListener("click", () => setAllRows(true));
  el.aiNoneBtn.addEventListener("click", () => setAllRows(false));
  el.aiDiscardBtn.addEventListener("click", () => {
    S.ai.proposal = null;
    showAiForm();
    renderTop();
  });
  el.aiApplyBtn.addEventListener("click", applyAiProposal);

  // basket
  el.basketToggle.addEventListener("click", () => setBasketOpen(el.basket.classList.contains("collapsed")));
  el.basketList.addEventListener("click", (e) => {
    const act = e.target.closest("[data-basket]")?.dataset.basket;
    if (!act) return;
    const i = Number(e.target.closest(".basket-item").dataset.i);
    if (act === "open") openBasketItem(i);
    else if (act === "done") removeBasketItem(i);
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

function renderTokenHints() {
  const batch = Math.max(1, Number(el.batchSizeInput.value) || 30);
  const on = el.thinkingInput.checked;
  const titleAuto = on ? 150 * batch + 4000 : 60 * batch + 200;
  const analyzeAuto = on ? 8000 : 1000;
  el.titleMaxHint.textContent = `留空为自动 = ${titleAuto}（每批 ${batch} 个，思考${on ? "开" : "关"}）。只有提示“输出被截断”时才需要调大。`;
  el.analyzeMaxHint.textContent = `留空为自动 = ${analyzeAuto}（思考${on ? "开" : "关"}）`;
}

// firstRun: the first open, before any folder is chosen, asks only for folders.
function openSettings(scrollToLimits = false, firstRun = false) {
  el.settingsHeading.textContent = firstRun ? "选择要分拣的收藏夹" : "分拣设置";
  el.settingsAi.hidden = firstRun;
  el.settingsFoldersHeading.hidden = firstRun;
  el.settingsFirstRunHint.hidden = !firstRun;
  el.folderToggles.innerHTML = S.allFolders
    .map((f) => `<label class="toggle"><input type="checkbox" value="${esc(f.id)}"${S.included.includes(String(f.id)) ? " checked" : ""} /> ${esc(f.title)} <span class="muted">${esc(f.count)}</span></label>`)
    .join("") || `<p class="dialog-hint">收藏夹列表还没加载</p>`;
  el.thinkingRow.hidden = !S.settings.deepseek;
  el.intervalInput.value = S.settings.triageIntervalSec ?? 8;
  el.batchSizeInput.value = S.settings.triageTitleBatchSize ?? 30;
  el.thinkingInput.checked = Boolean(S.settings.triageThinking);
  el.titleMaxInput.value = S.settings.triageTitleMaxTokens || "";
  el.analyzeMaxInput.value = S.settings.triageAnalyzeMaxTokens || "";
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
  if (inFolderView()) quickSync({ force: true });
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
  else if (act === "unwatch") setWatched(bvid, false);
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
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  if (document.querySelector("dialog[open]")) return;
  const t = e.target;
  if (t.closest?.("input, textarea, select, [contenteditable]")) return;
  if ((e.key === "Enter" || e.key === " ") && t.closest?.("button, a")) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const map = {
    "?": () => el.helpDialog.showModal(),
    "/": () => el.searchInput.focus(),
    i: () => openTags("batch")
  };
  const nav = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };
  const cardKeys = { d: "unfav", s: "keep", t: "tag", e: "basket", q: "ask", x: "select", o: "open", Enter: "open" };
  if (key === "Escape" && S.viewing) closeViewer();
  else if (map[key]) map[key]();
  else if (S.mediaId === REMOVED) return;
  else if (nav[key]) moveFocus(nav[key]);
  else if (key === "u") undo();
  else if (cardKeys[key] && S.focused) cardAction(cardKeys[key], S.focused);
  else return;
  e.preventDefault();
}
