// 关注 mode of the 分拣台: UP 主 cards sorted into my own UP tags, and the video feed of the people I follow.
// The top bar's 收藏夹 | 关注 switch puts body.follow-mode on; follow.css then hides the folder view and this file draws
// into #followSide and #followMain (the same grid areas as the folder view, so the shared viewer sits beside the list).
// Data comes from follow-bg.js through follow_* storage and the follow-* messages (the message list is in follow-bg.js's header).
// Tags live only in this extension (follow_tags / follow_tag_map). B站 writes: 取消关注, 重新关注 and the 关注分组 (新建, 改名,
// 删除, 移到 / 复制到, ★ 特别关注 which is group -10), see DESIGN 产品决策 · 改 B站 的操作和撤销 for what asks first and what U undoes.
import "./triage.js"; // runs first: it starts 收藏夹 (fav-*.js), which gives globalThis.MoonTriage (viewer, toast, confirm dialog)

// 关注's pure functions: follow-core.js (FollowCore), loaded before this module.
const {
  ALL, STATUS, withFeedInProgress, liveTags, upRow, SPECIAL, groupId, groupsOf, groupName, groupNames, groupMembers,
  sideIds, SOURCE, OUT_KINDS, outKind, groupMoveLabel, regrouped, groupCalls, groupTargets, sideMids, visibleUps,
  SORTS, OUT_SORTS, SORT_DIR, dirLabel, mergeFeed, FEED_SORTS, feedOrdered, feedCounts, feedList, feedLeaving,
  withTags, stepIn, tagsOf, restoreTags, normAi, followAiSettings, aiRequests, settingsProblem, normDays,
  keptOrder, syncFinished, viewRecord, latestBvid, aiBlocked, withAllowRemove, favUpMid, playingMid, unknownLast, aiBare,
  aiRoomHint, syncView
} = globalThis.FollowCore;

// ---------- page ----------
const T = globalThis.MoonTriage;
const UI = globalThis.TriageUi;
const { toast, askConfirm, send } = T;
const { esc, fmtDate, fmtAgo, fmtDuration, fmtCount, cleanTagName, plainClick, img } = UI;
// What 导出 → UP 主表格 holds; B站 caps a group name at 16 characters.
const CSV_HINT = "名字、标签、更新状态、最后投稿、粉丝数";
const { GROUP_NAME_MAX } = TriageUi;
// The follow_* keys the page draws from, by short name (MdgLimits.KEYS.follow).
const KEYS = ["list", "people", "last", "last_wip", "content", "tags", "tag_map", "unfollowed", "jobs", "ai_recent", "stats", "groups"];
const VIEW_KEY = MdgLimits.KEYS.follow("view"); // { mode: "fav" | "follow", tab: "ups" | "feed", sort, dir, fsort, side }
const saveView = () => T.store({ [VIEW_KEY]: viewRecord(F) });
const AI_HISTORY_KEY = MdgLimits.KEYS.follow("ai_history");
const STATUS_TEXT = Object.fromEntries(STATUS);
const STATUS_BADGE = { active: "keep", slow: "unsure", dead: "drop", stale: "unsure low", none: "none", unchecked: "none" };
const PHASE = { list: "读取关注列表", feed: "读取视频投稿", arc: "查投稿" };
const TAB = { ups: "UP 主", feed: "视频投稿" };
const WHO = UI.upWho; // what this mode tags, for shared.js's words (sp, tagsWord)
const NO_DATA = "还没有关注数据";
const STOP_SYNC = "暂停刷新";
const SPACE_TIP = "在分拣台里打开空间";
const EMPTY_GROUP = "这个分组没有 UP 主";
const NO_UPS_LISTED = "这里没有列出 UP 主"; // 全选 and 清理 with nothing listed
const GROUPS_TITLE = "分组管理";
const NEW_GROUP_NAME = `新分组名称（最多 ${GROUP_NAME_MAX} 个字）`;
const starLabel = (on) => (on ? "设为特别关注" : "取消特别关注");
const unfollowSel = (n) => `取消关注选中的 ${n} 个`;
const FEED_RUN = "follow-feed"; // 视频投稿's wait for B站限流 in runs
const DRY_PAGES = 3; // the feed stops loading by itself after this many pages in a row without a video for the picked item
const FEED_KEEP_MS = UI.FEED_CACHE_MS; // as the background's cache; older lists start over
const space = (mid) => `https://space.bilibili.com/${mid}`;
const video = UI.videoUrl;
const nowSec = () => Date.now() / 1000;

let D = { tags: [], map: {}, gone: {}, people: {}, content: {}, jobs: {}, list: null, last: null, recent: null };
let rows = new Map();
let shown = [];
const cfg = { slowDays: UI.numSetting("slowDays"), deadDays: UI.numSetting("deadDays") };
const F = {
  mode: "fav",
  tab: "ups",
  side: "all",
  status: "",
  kind: "", // 已出分拣范围's tab: "" (全部) | "gone" | "closed" | "cleared"
  outSort: { sort: "left", dir: "desc" }, // 已出分拣范围's own sort (OUT_SORTS), not remembered
  source: "", // 已取消关注: "" | "bili" (在 B站取关) | "app" (在这里取关)
  hold: null, // follow_hold: the background's queue pause { until, why }, shown at the 视频投稿 foot while a page waits
  q: "", // UP 主's search; 视频投稿 keeps its own (fq)
  fq: "",
  sort: "last",
  dir: "desc",
  fsort: "time", // 视频投稿's sort (FEED_SORTS)
  sel: new Set(),
  anchor: "", // the UP a Shift+click picks from: the last one picked

  recentFilter: false,
  tagState: "", // row 3: "" | "untagged" | "tagged" (in 视频投稿 the video's UP)
  tags: new Set(), // row 4: tag ids, AND; both tabs
  loaded: false,
  order: null, // the UP 主 cards' order (mids) kept while a refresh runs (renderUps), null otherwise
  feed: null, // { items, order, offset, hasMore, loading, error, errorCode, wait, dry, at, stale }; order: 随机's (feedOrdered); wait: B站限流, waiting FEED_RUN out; stale: a refresh finished since
  viewing: "",
  viewingMid: "", // the playing video's UP
  hover: "", // the 视频投稿 card under the mouse (bvid), for T
  cur: "" // the current UP card (mid): J / K, X, T
};
const $ = (id) => document.getElementById(id);
const side = $("followSide");
const main = $("followMain");

// The same four rows as 收藏夹, from the same shared.js pieces: 关注 · N | sort; UP 主 | 视频投稿 | search, 刷新, 导出;
// filters | 全选 and ✦ AI 打标签; the list.
main.innerHTML = `
  <div class="folder-head fw-head">
    <div class="folder-info"><div class="folder-text"><h1 id="fwTitle" class="folder-title">关注</h1><div id="fwMeta" class="folder-meta"></div></div>
      <button type="button" class="link bili-link" data-fw="bili" aria-label="在 B站打开我的空间">在 B站打开 ↗</button>
      ${UI.syncPill("fwSync")}
    </div>
    <span id="fwSort" class="sort-box"></span>
  </div>
  <div class="tabrow">
    <nav id="fwTabs" class="tabs fw-tabs" role="tablist" aria-label="关注"></nav>
    <span class="row-tools" role="toolbar" aria-label="关注的操作">${UI.searchBox("fwQ", "fwQCount", UI.searchScope("关注", TAB.ups))}${UI.rowButtons({
      activityId: "fwActivity", refreshId: "fwRefreshBtn", refreshLabel: "从 B站刷新关注", refreshTitle: "读取关注列表和视频投稿，再逐个查询视频投稿里没有的 UP 主",
      exportId: "fwExportBtn", menuId: "fwExport",
      menuHtml: UI.menuItem('data-fw="csv" aria-label="下载 UP 主表格 CSV"', "UP 主表格 (CSV)", CSV_HINT) + "<hr>" + UI.BACKUP_ITEM,
      settingsAttr: 'data-fw="settings"', settingsLabel: "关注设置"
    })}</span>
  </div>
  <div class="stagebar fw-bar"><span id="fwBar" class="class-filter state-row"></span><div class="list-header"><div id="fwBarR" class="step-actions"></div></div></div>
  <div class="tagbar fw-tagbar"><span id="fwTagRow" class="tagfilter"></span><span id="fwTools" class="fw-tools"><span id="fwAiSlot"></span></span></div>
  <div id="fwList" class="fw-list" aria-label="UP 主"></div>
  <div id="fwSel"></div>`;
// Both modes' rows exist from here on (收藏夹's are in triage.html), so the shared header fold starts here.
const headSync = UI.headFold($("main"));
const SYNC = { pill: $("fwSyncViewBtn"), notice: $("fwSyncNotice"), text: $("fwSyncText"), detail: $("fwSyncDetail"), close: $("fwSyncCloseBtn") };
UI.bindSync(SYNC);
const E = { sort: $("fwSort"), title: $("fwTitle"), tools: $("fwTools"), meta: $("fwMeta"), tabs: $("fwTabs"), bar: $("fwBar"), barR: $("fwBarR"), tagRow: $("fwTagRow"), list: $("fwList"), sel: $("fwSel"), q: $("fwQ"), qCount: $("fwQCount") };
// Without the sidebar its items become a select in the top bar, where 收藏夹 shows its folder select.
const sideSlot = document.createElement("span");
sideSlot.className = "fw-side-slot";
$("folderSelect").after(sideSlot);

// ---------- data ----------
async function load() {
  const got = await MdgLimits.followGet([...KEYS, "ai_proposal", "hold"]);
  D = {
    list: got.list || null,
    people: got.people || {},
    last: withFeedInProgress(got.last, got.last_wip),
    content: got.content || {},
    tags: got.tags || [],
    map: got.tag_map || {},
    gone: got.unfollowed || {},
    jobs: got.jobs || {},
    recent: got.ai_recent || null,
    stats: got.stats || {},
    groups: got.groups || []
  };
  // A pause that began before this page opened: storage.onChanged keeps it from here on.
  F.hold = got.hold || null;
  // An AI 打标签 proposal waiting for 应用 survives a reload; the one in memory (maybe edited on the review page) wins.
  if (!AI.proposal && !aiRunning()) AI.proposal = got.ai_proposal || null;
  derive();
}
// 关注's data, read once: on entering 关注, or for the 收藏夹 player's 「UP 标签」 line. F.loaded holds the read.
const ensureLoaded = () => (F.loaded ||= load());
function derive() {
  const now = nowSec();
  rows = new Map();
  for (const mid of [...(D.list?.list || []), ...Object.keys(D.gone)]) if (!rows.has(mid)) rows.set(mid, upRow(mid, D, now, cfg));
  if (!sideIds(D).includes(F.side)) F.side = "all";
  for (const id of [...F.tags]) if (!D.tags.some((t) => t.id === id)) F.tags.delete(id);
  if (!D.recent?.mids?.length) F.recentFilter = false;
  // A proposal naming a deleted tag no longer fits; it is dropped rather than applied.
  if (AI.proposal && !UI.aiProposalOk(AI.proposal, tagOf)) setAiProposal(null);
}
const following = () => D.list?.list || [];
const tagOf = (id) => D.tags.find((t) => t.id === id);
const nameOf = (mid) => rows.get(mid)?.name || mid;
const upName = (mid) => D.people?.[mid]?.name || F.feed?.items.find((it) => it.mid === mid)?.name || nameOf(mid);
const write = T.store;
// A batch confirm's list, as 收藏夹's.
const names = (mids) => UI.confirmList(mids.map(nameOf));

// follow_tags and follow_tag_map are written by B站 pages (badges.js) and follow-bg.js too, and D catches up only on the
// redraw a second later: a change applies to what storage holds now, one at a time. Resolves { prev, next }.
let tagWrites = Promise.resolve();
function updateStored(name, empty, change) {
  const run = tagWrites.then(async () => {
    const prev = (await MdgLimits.followGet([name]))[name] || empty;
    const next = change(prev);
    await write(MdgLimits.followFull({ [name]: next }));
    return { prev, next };
  });
  tagWrites = run.catch(() => {});
  return run;
}
async function setTagMap(change) {
  const r = await updateStored("tag_map", {}, change);
  D.map = r.next;
  derive();
  return r;
}
async function saveTags(change) {
  const r = await updateStored("tags", [], change);
  D.tags = r.next;
  derive();
  return r;
}
const changeTags = (mids, add, remove) => setTagMap((map) => withTags(map, mids, add, remove));
// 关注's undo steps live in fav-*.js (S.modeUndo, apart from 收藏夹's): U in 关注 undoes only these.
function pushTagUndo(before, label, { ask = null, created = [], recentAt = 0 } = {}) {
  T.pushUndo({
    kind: "mode",
    tags: true, // dropped when a tag is deleted
    ask,
    undo: async () => {
      const followed = new Set(following());
      const gone = Object.keys(before).filter((m) => !followed.has(m)).length;
      const { next: map } = await setTagMap((m) => restoreTags(m, before, new Set(D.tags.map((t) => t.id)), followed));
      const used = new Set(Object.values(map).flat());
      if (created.some((id) => !used.has(id))) await saveTags((tags) => tags.filter((t) => !created.includes(t.id) || used.has(t.id)));
      if (recentAt && D.recent?.at === recentAt) {
        D.recent = null;
        F.recentFilter = false;
        await chrome.storage.local.remove(MdgLimits.KEYS.follow("ai_recent"));
      }
      render();
      return `已撤销：${label}${gone ? `（${gone} 个已取消关注，标签没改）` : ""}`;
    }
  });
}
const newTag = MdgTagCore.newUpTag;

// ---------- mode ----------
async function setMode(mode, save = true) {
  if (mode === F.mode) return;
  TagPicker.close();
  if (T.viewing()) T.closeViewer();
  F.mode = mode;
  const on = mode === "follow";
  document.body.classList.toggle("follow-mode", on);
  side.hidden = main.hidden = !on;
  headSync();
  for (const b of document.querySelectorAll("#modeSwitch [data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  if (save) saveView();
  if (on) await ensureLoaded();
  if (on) feedOnEnter();
  // One feed page (cached a few minutes in the worker) brings posts made since the last 刷新 into 最后投稿.
  if (on) send({ type: "follow-feed", offset: "" }).catch(() => {});
  if (on) render();
  headSync(); // the rows as drawn: re-measure the full height, still without animation
}
function setTab(tab) {
  TagPicker.close();
  if (T.viewing()) T.closeViewer();
  if (tab !== F.tab) F.sel.clear(); // a selection belongs to its tab (switching the sidebar keeps it)
  if (tab === "feed" && tab !== F.tab) feedOnEnter();
  F.tab = tab;
  E.q.value = tab === "feed" ? F.fq : F.q;
  saveView();
  fromTop(); // both tabs draw into #fwList
}

// ---------- render ----------
function render() {
  if (F.mode !== "follow") return renderViewerUp();
  // Say what the box searches, as 收藏夹: where (the sidebar item or row 4's tags) · what (更新状态 or the tab).
  const where = F.side === "out" ? UI.removedName : [F.side !== "all" && sideLabel(F.side), ...[...F.tags].map((id) => tagOf(id)?.name)].filter(Boolean).join("、") || "关注";
  const what = F.tab === "feed" ? TAB.feed : F.side === "out" ? Object.fromEntries([["", ALL], ...OUT_KINDS])[F.kind] : F.status ? STATUS_TEXT[F.status] : TAB.ups;
  UI.setSearchScope(E.q, where, what);
  renderSide();
  renderHead();
  renderTabs();
  if (F.tab === "feed") renderFeed();
  else renderUps();
  renderViewerUp();
}

// The sidebar is scope only: 全部 · B站's 关注分组 (默认分组, ★ 特别关注, your own) · 已出分拣范围 (tags are rows 3 and 4).
const sideLabel = (id) => (id === "all" ? ALL : id === "out" ? UI.removedName : groupName(groupId(id), D));
const sideCount = (id) => sideMids(D, rows, id).length;
// The sort the list and its control use: 已出分拣范围's own, else the UP 主 list's.
const sortState = () => (F.side === "out" ? F.outSort : F);
const OUT_TIP = "不在关注分拣里、但 MoonDigest 还留着信息的 UP 主：取消关注的、已注销的、投稿已清空的";
const STAR = '<span class="star-mark" aria-hidden="true">★</span>';
function renderSide() {
  const item = (id) => UI.sideItem({ attrs: `data-side="${esc(id)}"`, label: sideLabel(id), count: sideCount(id), on: F.side === id, pre: id === `g:${SPECIAL}` ? STAR : "" });
  const ids = sideIds(D);
  side.innerHTML = `<div class="side-head">关注分组</div><div class="folder-list">${ids.slice(0, -1).map(item).join("")}</div>
    <button type="button" class="quiet side-manage" data-fw="groups" title="新建、改名或删除 B站 的关注分组">${GROUPS_TITLE}</button>
    ${sideCount("out") || F.side === "out" ? `<hr>${item("out").replace("<button ", `<button title="${OUT_TIP}" `)}` : ""}${UI.sideFoot({ settingsAttrs: 'data-fw="settings" aria-label="关注设置"', settingsLabel: "关注设置" })}`;
  sideSlot.innerHTML = sideSelect();
}

// A sync takes minutes, so like 粗看 / 细看 it also leads row 3's right end as the primary button, with its count.
const runSlot = () => {
  const j = D.jobs || {};
  return `<span id="fwRunSlot">${j.running ? `<button type="button" class="primary" data-fw-stop aria-label="${STOP_SYNC}">${STOP_SYNC}${j.total ? ` ${j.done || 0}/${j.total}` : ""}</button>` : ""}</span>`;
};
// The progress pill, as in 收藏夹 (runs' table): while the sync job runs it takes 刷新's place (progress, the B站限流
// countdown, 暂停刷新, the word row 3 uses); otherwise a B站 write (停止), then AI 打标签 running or waiting to be confirmed (查看).
const PILL = ["sync", "follow-write", "follow-ai", "proposal"];
const PILL_BTN = { sync: { attrs: "data-fw-stop", label: STOP_SYNC }, "follow-write": { attrs: "data-fw-busystop", label: MdgErrors.LABEL.stop }, "follow-ai": { attrs: 'data-fw="ai"', label: "查看" }, proposal: { attrs: 'data-fw="ai"', label: "查看" } };
function renderSync() {
  const j = D.jobs || {};
  const slot = $("fwRunSlot");
  if (slot) slot.outerHTML = runSlot();
  const btn = $("fwRefreshBtn");
  btn.disabled = Boolean(j.running);
  if (j.running) btn.setAttribute("aria-busy", "true");
  else btn.removeAttribute("aria-busy");
  const { job, stopping, ...a } = runs.pill(PILL) || {};
  const stop = job === "follow-write" && stopping && { ...PILL_BTN[job], label: MdgErrors.LABEL.stopping, reason: UI.WRITE_STOPPING };
  UI.setActivity($("fwActivity"), a.text && { ...a, btn: stop || PILL_BTN[job] });
}

// The last refresh's 新关注 / 在 B站取关 (follow_jobs.changes, see followDiff) as 收藏夹's 「已刷新」 pill. Each refresh's
// changes show once per page; 关闭 hides them until the next.
let syncSeenAt = null;
// posted: UP 回归, 投稿已清空 UP 主 that have videos again (follow_jobs.posted), back in the list.
function renderSyncChanges() {
  const j = D.jobs || {};
  const posted = j.posted || [];
  const c = j.changes || (posted.length ? { at: j.startedAt, added: [], removed: [] } : null);
  if (!c || `${c.at}|${posted.length}` === syncSeenAt) return;
  syncSeenAt = `${c.at}|${posted.length}`;
  UI.setSync(SYNC, syncView(c, posted, (mids) => mids.map((m) => D.people?.[m]?.name || m)));
}

// 标签管理 and ✦ AI 打标签 with its state, as in 收藏夹. AI 打标签 works on followed UP 主: in 视频投稿 and 已出分拣范围 it is
// disabled and says why (a run or a proposal stays reachable).
const aiReason = () => (aiRunning() || AI.proposal ? "" : aiBlocked(F.tab, F.side));
function renderAiButton() {
  $("fwAiSlot").innerHTML = UI.tagButtons({ manageAttrs: 'data-fw="tags"', aiAttrs: 'data-fw="ai"', who: WHO, aiReason: aiReason(), noTags: !D.tags.length, picked: F.tab === "ups" ? selShown().length || F.sel.size : 0, running: aiRunning(), pending: Boolean(AI.proposal) });
}
function renderAiState() {
  renderSync();
  renderAiButton();
}

// 关注 · N, when the list was read, and the last refresh's error, which stays until a refresh gets through.
// Not logged in (the last refresh or the 视频投稿 page said so): the same 去登录 banner as 收藏夹. Shown once per error,
// so 关闭 sticks until the next one.
let loginSeen = "";
// Leaving 关注 leaves the banner: B站's login is the same for 收藏夹, which may have shown it too.
function renderLogin() {
  if (F.mode !== "follow") return;
  const j = D.jobs || {};
  const login = (code) => MdgErrors.action(code) === "login"; // follow-bg.js reports B站's -101 as NOT_LOGGED_IN
  const err = !j.running && login(j.errorCode) ? j.error : login(F.feed?.errorCode) ? F.feed.error : "";
  if (err !== loginSeen) T.loginBanner(Boolean(err));
  loginSeen = err;
}
function renderHead() {
  const at = D.list?.at || 0;
  const j = D.jobs || {};
  // As 收藏夹's. On B站限流 follow-bg.js's error is MdgErrors.TEXT.biliThrottled.
  const err = !j.running && j.error ? `刷新失败：${j.error}` : "";
  const out = F.side === "out";
  E.title.innerHTML = out ? UI.titleHtml(UI.removedName, sideCount("out")) : UI.titleHtml("关注", D.list ? sideCount("all") : null);
  renderLogin();
  E.meta.innerHTML = out
    ? UI.headMeta([...OUT_KINDS.map(([k, label]) => [sideMids(D, rows, "out").filter((m) => outKind(rows.get(m)) === k).length, label]).filter(([n]) => n).map(([n, label]) => `${n} 个${label}`), `不在关注分拣里了，标签都还留着，${UI.CLEAN_BACKUP.meta}`])
    : UI.headMeta([D.list ? UI.syncedText(at * 1000) : NO_DATA], err);
  main.querySelector('[data-fw="bili"]').hidden = out;
  // 导出 → UP 主表格: nothing to put in it before the first refresh.
  const csv = $("fwExport").querySelector('[data-fw="csv"]');
  const noCsv = D.list ? "" : `${NO_DATA}，先刷新`;
  csv.querySelector("small").textContent = noCsv || CSV_HINT;
  UI.setReason(csv, noCsv);
  renderSync();
  renderSyncChanges();
}

function renderTabs() {
  const tab = (key, label, n) =>
    `<button type="button" role="tab" data-fwtab="${key}" aria-selected="${F.tab === key}"${n == null ? "" : ` aria-label="${label} ${n}"`}>${label}${n == null ? "" : `<span class="count">${n}</span>`}</button>`;
  // 已出分拣范围 has no 视频投稿; its tabs are why the UP 主 left (outKind), 全部 first.
  if (F.side === "out") {
    const all = sideMids(D, rows, "out");
    E.tabs.innerHTML = UI.kindTabs("data-fwkind", [["", ALL], ...OUT_KINDS].map(([k, label]) => [k, label, k ? all.filter((m) => outKind(rows.get(m)) === k).length : all.length]), F.kind);
    return;
  }
  E.tabs.innerHTML = tab("ups", TAB.ups, sideCount("all")) + tab("feed", TAB.feed);
}

// The left column as a select with the same counts, for widths without the sidebar (in the top bar, see sideSlot).
const sideSelect = () =>
  `<select class="fw-side-select" name="followScope" data-fw="side" aria-label="UP 主范围">${sideIds(D)
    .map((id) => `<option value="${esc(id)}"${F.side === id ? " selected" : ""}>${id === `g:${SPECIAL}` ? "★ " : ""}${esc(sideLabel(id))} (${sideCount(id)})</option>`).join("")}</select>`;

// Row 3's 未打标签 / 已打标签 (prefix 「UP 」 in 视频投稿, where it goes by the video's UP).
const tagStateGroup = (counts, prefix = "") =>
  UI.tagStateGroup((k) => `data-fw-tagstate="${k}"`, (k) => counts[k], F.tagState, prefix);
// Row 3 of UP 主: 全部 | 更新状态 | 未打标签 已打标签 | ✦ AI 刚打的 (only while there is one). 待查 always shows.
function stateRowUps(counts) {
  const anyOn = F.status || F.tagState || F.recentFilter;
  const out = [
    UI.stateGroup(ALL, UI.filterBtn("data-fw-all", ALL, counts[""], !anyOn)),
    UI.stateGroup("更新状态", STATUS.slice(1).map(([id, label]) => UI.filterBtn(`data-status="${id}"${id === "stale" ? ` title="慢更或断更 · 待查：${cfg.slowDays} 天里没在视频投稿里出现，查完投稿才知道是哪种"` : ""}`, label, counts[id] || 0, F.status === id)).join("")),
    tagStateGroup(counts)
  ];
  out.push(UI.aiRecentChip({ attrs: 'data-fw="recent"', xAttrs: 'data-fw="recent-done"', n: counts.recent, on: F.recentFilter, who: WHO }));
  return out.join("");
}
// Row 4: the tags listed UP 主 (or videos) have, or that are on, with counts; several = AND.
const tagRowHtml = (counts) =>
  D.tags
    .filter((t) => counts[t.id] || F.tags.has(t.id))
    .map((t) => UI.tagFilterChip(`data-fw-tag="${esc(t.id)}"`, { name: t.name, color: t.color, on: F.tags.has(t.id), n: counts[t.id] || 0, what: F.tab === "feed" ? `${WHO}的视频` : WHO }))
    .join("");
// Anything in rows 3 and 4 narrowing the list (for 「N 个结果」); the sidebar is scope, as 收藏夹's folder.
const filtersOn = () => (F.side === "out" ? Boolean(F.source || F.tagState || F.tags.size) : Boolean(F.tagState || F.tags.size || (F.tab === "ups" && (F.status || F.recentFilter))));

// ----- UP 主 -----
function renderUps() {
  const recentAll = new Set((D.recent?.mids || []).filter((m) => rows.has(m) && !rows.get(m).gone));
  const out = F.side === "out";
  let { list, counts } = visibleUps(D, rows, out ? { side: F.side, q: F.q, sort: F.outSort.sort, dir: F.outSort.dir, kind: F.kind, source: F.source, tagState: F.tagState, tags: F.tags } : { side: F.side, status: F.status, q: F.q, sort: F.sort, dir: F.dir, recent: F.recentFilter ? recentAll : null, recentAll, tagState: F.tagState, tags: F.tags });
  // A refresh rewrites the data every second for minutes: meanwhile the cards keep their order (newly listed ones go
  // last), and are sorted again once it ends, or when you change what is listed or the sort (fromTop).
  const syncing = Boolean(D.jobs?.running);
  if (syncing && F.order) list = keptOrder(list, F.order);
  F.order = syncing ? list : null;
  shown = list;
  // Switching between groups keeps the selection (into or out of 已出分拣范围 clears it); the ones not listed count as 被筛选隐藏.
  for (const m of [...F.sel]) if (!rows.has(m)) F.sel.delete(m);
  // 已出分拣范围's row 3: 全部 | 在哪取消关注 (on 全部 and 已取消关注) | 未打标签 已打标签.
  const seg = out
    ? [UI.stateGroup(ALL, UI.filterBtn("data-fw-all", ALL, counts[""], !F.source && !F.tagState)),
      (F.kind === "" || F.kind === "gone") && UI.stateGroup("在哪取消关注", Object.entries(SOURCE).map(([id, label]) => UI.filterBtn(`data-source="${id}"`, label, counts.source[id], F.source === id)).join("")),
      tagStateGroup(counts)].filter(Boolean).join("")
    : stateRowUps(counts);
  // 全选 heads the right-hand buttons, as in 收藏夹: it acts on the UP 主 listed now. 已出分拣范围 adds 清理, as 收藏夹's.
  const shows = Boolean(D.list || out);
  E.bar.innerHTML = shows ? UI.labeledRow("状态", seg) : "";
  E.barR.innerHTML = shows ? UI.selectAllBox('data-fw="select-all"', list.length, list.filter((m) => F.sel.has(m)).length, NO_UPS_LISTED) + (out ? cleanBtn(list) : "") + runSlot() : "";
  E.tagRow.innerHTML = UI.labeledRow("标签", tagRowHtml(counts.tags));
  E.tools.hidden = !D.list && !out;
  const so = sortState();
  E.sort.hidden = !out && !D.list;
  E.sort.innerHTML = UI.sortControl({ sorts: out ? OUT_SORTS : SORTS, sort: so.sort, dir: so.dir, words: dirLabel(so.sort, so.dir), selectAttr: 'data-fw="sort"', dirAttr: 'data-fw="dir"' });
  E.qCount.textContent = UI.resultCount(F.q.trim() || filtersOn(), list.length);
  const hint = hintHtml();
  const restore = UI.keepScroll(E.list, ".fw-up[data-mid]");
  let body;
  if (!D.list && !out) body = emptyHtml();
  else if (!list.length) body = `<p class="empty">${UI.noMatch(F.q, filtersOn(), WHO) || (out && !F.kind ? "没有已出分拣范围的 UP 主" : F.side.startsWith("g:") ? EMPTY_GROUP : "这里没有 UP 主")}</p>`;
  else body = list.map(upCard).join("");
  E.list.className = "fw-list";
  E.list.innerHTML = hint + body;
  restore();
  renderSel();
}

// 清理, as 收藏夹's: it only forgets (B站 is untouched), so it takes the 已取消关注 among the selected listed ones (none
// when filters hide them all), else among all listed. The ones still followed are left out: they would come back with
// the next 刷新, so 取消关注 comes first.
const cleanable = (mids) => mids.filter((m) => rows.get(m)?.gone);
// What 清理 takes from list: { picked: whether there is a selection, mids }.
function cleanTargets(list = shown) {
  const picked = F.sel.size > 0;
  return { picked, mids: cleanable(picked ? list.filter((m) => F.sel.has(m)) : list) };
}
function cleanBtn(list) {
  const { picked, mids } = cleanTargets(list);
  const shownSel = list.filter((m) => F.sel.has(m)).length;
  // All of it hidden, or none of it cleanable: the count is the selection's (listed, else all of it), disabled with why.
  const n = picked ? mids.length || shownSel || F.sel.size : mids.length;
  const why = !list.length ? NO_UPS_LISTED : !mids.length ? "还关注着的先取消关注，再清理" : "";
  return UI.cleanBtn('data-fw="clean"', { picked: F.sel.size, shown: shownSel, n, busy: busyWhy(), why });
}

function emptyHtml() {
  const j = D.jobs || {};
  const act = j.running ? `<p class="muted" aria-busy="true">${UI.REFRESHING}…读到就显示在这里</p>` : UI.refreshEmpty('data-fw="sync" class="primary"');
  return UI.emptyState(NO_DATA, "读取关注列表和视频投稿，按最后投稿时间分为活跃、慢更、断更；视频投稿里没有的 UP 主再逐个查询。只读，不改 B站。", act);
}

// Why some 更新状态 are missing, with the job's live state or the button that fills them in.
function hintHtml() {
  if (!D.list || F.side === "out") return "";
  const parts = [];
  if (D.list.complete === false && !D.jobs?.running) parts.push(`<p class="fw-hint warn">这次关注列表没读全，没有把任何人记成已取消关注。下次刷新会再读。</p>`);
  const counts = unknownLast(D, rows);
  const open = counts.unchecked + counts.stale;
  if (open) {
    const running = D.jobs?.running;
    const stale = counts.stale ? `「待查」= ${cfg.slowDays} 天里没在视频投稿里出现，查完投稿才分得清慢更还是断更。` : "";
    const act = running ? `<span class="muted" aria-busy="true">正在查，状态边查边更新</span>` : `<button type="button" data-fw="sync">${MdgErrors.LABEL.refresh}（约 ${Math.max(1, Math.ceil(open / 60))} 分钟）</button>`;
    parts.push(`<p class="fw-hint">${open} 个 UP 主还不知道最后投稿时间。${stale}${act}</p>`);
  }
  return parts.join("");
}

// The UP 主 whose videos the sync is reading now, as 粗看's 分析中… cards.
const checking = () => (D.jobs?.running && D.jobs.phase === "arc" ? D.jobs.cur || "" : "");

function upCard(mid) {
  const u = rows.get(mid);
  const now = nowSec();
  const sel = F.sel.has(mid);
  // Times are relative, the date on hover (UI.agoHtml); the rest is text.
  const meta = [
    esc(u.zone),
    u.last ? `最后投稿 ${UI.agoHtml(u.last, now)}` : u.status === "stale" && !u.gone ? esc(`${cfg.slowDays} 天以上没投稿`) : "",
    u.count && `${u.count} 个视频`,
    u.fans != null ? `粉丝 ${esc(fmtCount(u.fans))}` : sortState().sort === "fans" && !u.gone ? "粉丝数未查" : "",
    !u.gone && u.followed && `关注于 ${UI.agoHtml(u.followed, now)}`
  ].filter(Boolean);
  // As 收藏夹's 已出分拣范围 cards: why it left, on its own line.
  const kind = outKind(u);
  const left = kind === "gone" ? `${esc(UI.dayText((u.gone.at || now) * 1000))} ${SOURCE[u.gone.source === "bili" ? "bili" : "app"]}`
    : kind === "closed" ? "账号已注销"
    : kind === "cleared" ? `投稿已清空：一个视频都看不到了，以前的视频播放过 ${esc(fmtCount(D.content[mid].views))} 次`
    : "";
  // Its 关注分组, as 收藏夹's 原在「A」: where the unfollowed were (records from before groups were kept have none), where
  // the still followed are. Groups deleted since are left out; none of your own is 默认分组.
  const gids = kind === "gone" ? u.gone.groups : kind ? groupsOf(mid, D) : null;
  const gnames = gids ? groupNames(gids, D) : [];
  const origin = UI.originChip(kind === "gone" ? "原在" : "在", gnames);
  const chips = u.tagIds.map(tagOf).map((t) => u.gone
    ? `<span class="chip" style="--c:${esc(t.color)}">${esc(t.name)}</span>`
    : UI.cardTagChip(t)).join("");
  const titles = u.titles.length
    ? `<ul class="fw-titles">${u.titles.map((v) => `<li>${v.bvid ? `<a class="fw-title" href="${esc(video(v.bvid))}" data-play="${esc(v.bvid)}" title="在分拣台里播放">${esc(v.t)}</a>` : `<span class="fw-title">${esc(v.t)}</span>`}<span class="meta">${UI.agoHtml(v.c, now)}</span></li>`).join("")}</ul>`
    : "";
  // While a B站 batch runs, the buttons that write B站 (and 清理, which drops the records those batches write) are
  // disabled with why; the handler's guard is left for other paths.
  const busy = UI.reasonAttrs(busyWhy());
  const right = u.gone
    ? `<button type="button" data-refollow="${esc(mid)}" aria-label="重新关注 ${esc(u.name)}"${busy}>重新关注</button>${UI.cardCleanBtn(mid, u.name, busyWhy())}`
    : kind
    ? `<button type="button" class="danger" data-unfollow="${esc(mid)}" aria-label="取消关注 ${esc(u.name)}"${busy}>取消关注</button>`
    : `<button type="button" class="star${u.special ? " on" : ""}" data-star="${esc(mid)}" aria-pressed="${u.special}" aria-label="${starLabel(!u.special)} ${esc(u.name)}"${UI.reasonAttrs(busyWhy(), `${starLabel(!u.special)}（改 B站）`)}>${u.special ? "★" : "☆"}</button>`;
  const playing = F.viewing && (F.viewing === upView(mid) || u.titles.some((v) => v.bvid === F.viewing));
  return `<article class="card fw-up${sel ? " selected" : ""}${playing ? " playing" : ""}${F.cur === mid ? " focused" : ""}" data-mid="${esc(mid)}" aria-label="${esc(u.name)}">
    <a class="fw-avatar" href="${space(mid)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">${u.face ? `<img src="${esc(img(u.face, "96w_96h_1c"))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</a>
    <div class="card-body">
      <div class="fw-name-row"><a class="fw-name" href="${space(mid)}" data-space="${esc(mid)}" target="_blank" rel="noopener" title="${SPACE_TIP}">${esc(u.name)}</a>${kind ? "" : checking() === mid ? '<span class="badge running" aria-busy="true">查投稿中…</span>' : `<span class="badge ${STATUS_BADGE[u.status]}">${STATUS_TEXT[u.status]}</span>`}${u.ov ? `<span class="meta fw-ov" title="${esc(u.ov)}">${esc(u.ov)}</span>` : ""}</div>
      ${left ? `<div class="left-row">${origin}${left}</div>` : ""}
      ${meta.length ? `<div class="meta">${meta.join(" · ")}</div>` : ""}
      ${u.sign ? `<div class="fw-sign" title="${esc(u.sign)}">${esc(u.sign)}</div>` : ""}
      ${titles}
      <div class="chips fw-foot-row">${chips}${u.gone ? "" : addBtn(mid, u.name)}</div>
    </div>
    <div class="fw-right">${right}</div>
  </article>`;
}

// The selection the bar acts on: the selected UP 主 listed now. Switching the sidebar keeps the rest, as a filter does.
function selShown() {
  return shown.filter((m) => F.sel.has(m));
}
// Why a write cannot start, naming the one running, as 收藏夹 does.
const busyWhy = () => UI.busyText(W.busy());

// The selection bar, and what in rows 3 and 4 counts the selection: 全选, 清理 (已出分拣范围) and ✦ AI 打标签.
function renderSel() {
  const n = selShown().length;
  const box = E.barR.querySelector("[data-fw=select-all]");
  if (box) box.setAttribute("aria-checked", UI.selectAllState(shown.length, n));
  const clean = F.side === "out" && E.barR.querySelector("[data-fw=clean]");
  if (clean) clean.outerHTML = cleanBtn(shown);
  renderAiButton();
  if (F.tab !== "ups" || !F.sel.size) return (E.sel.innerHTML = "");
  const hidden = F.sel.size - n;
  const busy = busyWhy();
  // As 收藏夹's selection bar: the buttons that act on B站 say how many, label and aria-label alike.
  const btn = (act, label, reason, cls = "") => UI.actBtn(`data-fw="${act}"`, label, { reason, cls });
  // 移动 leaves the sidebar's group, so 全部 has none to leave.
  // 已出分拣范围: 重新关注 the unfollowed, 取消关注 the ones still followed (清理 is in row 3, as 收藏夹's).
  // Filters hiding the whole selection: the buttons count all of it, off (none).
  const pool = n ? selShown() : [...F.sel];
  const k = pool.length;
  const gone = pool.filter((m) => rows.get(m)?.gone).length;
  const acts = (none) => F.side === "out"
    ? btn("refollow", `重新关注选中的 ${gone || k} 个`, busy || none || (!gone && "选中的都还关注着")) + btn("unfollow", unfollowSel(k - gone || k), busy || none || (k === gone && "选中的都已取消关注"), "danger")
    : btn("pick-sel", "标签…", none) +
      btn("move-sel", `移动选中的 ${k} 个到分组…`, busy || none || (groupId(F.side) == null && `先在分组列表里选一个分组：「${ALL}」里不知道从哪个分组移走`)) +
      btn("copy-sel", `复制选中的 ${k} 个到分组…`, busy || none) +
      btn("unfollow", unfollowSel(k), busy || none, "danger");
  E.sel.innerHTML = UI.selbar({ label: "选中的 UP 主", n, hidden, clearAttrs: 'data-fw="select-none"', acts });
}

// ----- 视频投稿 -----
const freshFeed = () => ({ items: [], offset: "", hasMore: true, loading: false, error: "", wait: false, dry: 0, at: Date.now() });

// What the 视频投稿 list and its counts go by.
const feedF = () => ({ side: F.side, q: F.fq, tagState: F.tagState, tags: F.tags });
// Coming back to 视频投稿 (the tab or the mode) after FEED_KEEP_MS, or after a refresh finished (stale), starts it over;
// a redraw meanwhile keeps the pages loaded.
function feedOnEnter() {
  if (F.feed && !F.feed.loading && (F.feed.stale || Date.now() - F.feed.at > FEED_KEEP_MS)) F.feed = null;
}
function renderFeed() {
  F.feed ||= freshFeed();
  const ord = feedOrdered(F.feed.items, F.fsort, F.feed.order);
  F.feed.order = ord.order;
  const items = ord.items;
  // 更新时间 has no direction button; 随机 puts 再随机一次 in its place (picking 随机 again in the select does nothing).
  E.sort.hidden = false;
  E.sort.innerHTML = UI.sortControl({ sorts: FEED_SORTS, sort: F.fsort, selectAttr: 'data-fw="fsort"', btn: F.fsort === "random" && { attrs: 'data-fw="reshuffle"', label: "再随机一次", icon: "↻" } });
  E.tools.hidden = false;
  renderAiButton();
  // Row 3: 全部 | UP 未打标签 UP 已打标签; no count before the first page arrives. Row 4 counts videos. No 全选 here.
  const c = feedCounts(items, D, feedF());
  const n = (k) => (items.length ? c[k] : null);
  E.bar.innerHTML = UI.labeledRow("状态", UI.stateGroup(ALL, UI.filterBtn("data-fw-all", ALL, n(""), !F.tagState)) + tagStateGroup({ tagged: n("tagged"), untagged: n("untagged") }, "UP "));
  E.barR.innerHTML = runSlot();
  E.tagRow.innerHTML = UI.labeledRow("标签", tagRowHtml(c.tags));
  const list = feedList(items, D, feedF(), pick.keep);
  E.qCount.textContent = UI.resultCount(F.fq.trim() || filtersOn(), list.length);
  const restore = UI.keepScroll(E.list, ".fw-video[data-bvid]");
  E.list.className = "fw-list fw-feed";
  E.list.innerHTML = `<div class="fw-grid">${list.map(feedCard).join("")}</div><div class="fw-foot" id="fwFoot"></div>`;
  restore();
  E.sel.innerHTML = "";
  renderFoot(list.length);
  observeFoot();
  if (!items.length && F.feed.hasMore && !F.feed.loading && !F.feed.error && !F.feed.wait) more();
}

const addBtn = (mid, name) => UI.tagPlusBtn(`data-pick="${esc(mid)}"`, MdgErrors.upTagTitle(name));

// The viewer's 「UP 标签」 line: the playing video's UP, its tags, + 标签 (the same picker as the cards). In 关注 it is
// the only line and T tags this UP; in 收藏夹 it sits under 「视频标签」, where T tags the video, and shows only for an
// UP you follow (or did), since UP tags live on 关注's UP 主.
const vline = document.createElement("div");
vline.id = "fwViewerUp";
vline.className = "viewer-line";
vline.hidden = true;
$("viewerTags").after(vline);
function renderViewerUp() {
  const follow = F.mode === "follow";
  const up = !follow && T.viewingUp();
  if (up && !F.loaded) return void ensureLoaded().then(renderViewerUp);
  const mid = follow ? (F.viewing && F.viewingMid) || "" : favUpMid(up, rows);
  vline.hidden = !mid;
  if (!mid) return void (vline.innerHTML = "");
  const u = rows.get(mid);
  const it = F.feed?.items.find((x) => x.mid === mid);
  const name = upName(mid);
  const face = u?.face || it?.face;
  const ids = u ? u.tagIds : liveTags(mid, D);
  const chips = ids.map(tagOf).map((t) => `<span class="chip" style="--c:${esc(t.color)}"${u?.gone ? "" : ` data-pick="${esc(mid)}"`}>${esc(t.name)}</span>`).join("");
  const pre = `${face ? `<img src="${esc(img(face, "48w_48h_1c"))}" alt="" referrerpolicy="no-referrer">` : ""}<a class="name" href="${space(mid)}" target="_blank" rel="noopener">${esc(name)}</a>`;
  vline.innerHTML = UI.viewerLine({ label: "UP 标签", pre, chips, plus: !u?.gone && { attrs: `data-pick="${esc(mid)}"`, label: MdgErrors.upTagTitle(name), key: follow } });
}
// B站's autoplay moved the player on (收藏夹's showViewing, fav-*.js): the pink card, this line and T follow the new video.
T.setViewerHook(() => {
  const b = T.viewing();
  if (F.mode !== "follow" || !b || b === F.viewing) return renderViewerUp();
  F.viewing = b;
  F.viewingMid = playingMid(b, F.feed?.items, rows);
  render();
});

function feedCard(it) {
  const ids = liveTags(it.mid, D);
  const on = F.viewing === it.bvid;
  const chips = ids.map(tagOf).map((t) => `<span class="chip" style="--c:${esc(t.color)}" data-pick="${esc(it.mid)}">${esc(t.name)}</span>`).join("");
  const target = pick.anchor && pick.mids[0] === it.mid;
  return `<article class="fw-video${on ? " playing" : ""}${target ? " fw-target" : ""}" data-bvid="${esc(it.bvid)}"${on ? ' aria-current="true"' : ""}>
    <a class="cover-wrap" href="${esc(video(it.bvid))}" data-play="${esc(it.bvid)}" tabindex="-1" aria-hidden="true">${it.cover ? `<img class="cover" src="${esc(img(it.cover, "480w_270h_1c"))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}<span class="cover-dur">${it.duration ? esc(fmtDuration(it.duration)) : ""}</span></a>
    <div class="fw-video-body">
      <a class="title" href="${esc(video(it.bvid))}" data-play="${esc(it.bvid)}" title="${esc(it.title)}" aria-label="播放 ${esc(it.title)}">${esc(it.title)}</a>
      <div class="meta fw-video-meta"><a class="fw-up-link" href="${space(it.mid)}" data-space="${esc(it.mid)}" title="${SPACE_TIP}" target="_blank" rel="noopener">${it.face ? `<img src="${esc(img(it.face, "48w_48h_1c"))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}<span>${esc(it.name)}</span></a>${UI.agoHtml(it.at, nowSec())}${it.play ? `<span>▶ ${esc(fmtCount(it.play))}</span>` : ""}</div>
      <div class="chips">${chips}${addBtn(it.mid, it.name)}</div>
    </div>
  </article>`;
}

// How far back the feed was read, and the way to read further. 加载更多 is the view's blue button once loading by
// itself stopped (DRY_PAGES pages without a video here).
function renderFoot(n = feedList(F.feed.items, D, feedF(), null).length) {
  const foot = $("fwFoot");
  if (!foot) return;
  const f = F.feed;
  const oldest = f.items.length ? Math.min(...f.items.map((it) => it.at)) : 0;
  const where = F.side === "out" ? "已出分拣范围的 UP 主不在视频投稿里。" : "";
  const reach = oldest ? `已加载到 ${fmtDate(oldest)}（${fmtAgo(oldest, nowSec())}），共 ${f.items.length} 个视频。` : "";
  // Stuck, as the sync's amber pill with the red ⚠ and the countdown: B站限流 (then more() tries again by itself), or the
  // background holding its queue (risk control, a dropped connection) while this page waits for a page.
  const hold = f.loading && F.hold?.until > nowSec() ? F.hold : null;
  const stuck = f.wait ? runs.get(FEED_RUN)?.wait || UI.BILI_STUCK : hold && UI.waitText(holdLabel(hold), Math.ceil(hold.until - nowSec()));
  if (stuck) {
    foot.innerHTML = `<p>${esc(reach)}</p><span class="activity" role="status"></span>`;
    return UI.setActivity(foot.lastChild, { text: stuck, stuck: true });
  }
  let text;
  if (f.error) text = f.error;
  else if (f.loading) text = f.items.length ? `${reach}正在加载更早的…` : "正在读关注的人的新视频…";
  else if (!n && f.items.length) text = `${where || (UI.noMatch(F.fq, filtersOn(), "视频") || "这里的 UP 主最近没发视频") + "。"}${reach}`;
  else if (!f.hasMore) text = f.items.length ? `${reach}B站 只提供到这里。` : "关注的人最近都没发视频。";
  else text = reach;
  const stopped = !n || f.dry >= DRY_PAGES;
  const btn = f.error ? `<button type="button" data-fw="more">${MdgErrors.LABEL.retry}</button>`
    : f.hasMore && !f.loading ? `<button type="button" class="${stopped ? "primary" : ""}" data-fw="more">加载更多</button>` : "";
  foot.innerHTML = `<p${f.loading ? ' aria-busy="true"' : ""}>${esc(text)}</p>${btn}`;
}

let io = null;
function observeFoot() {
  io ||= new IntersectionObserver((entries) => {
    if (F.tab === "feed" && entries.some((e) => e.isIntersecting) && F.feed.dry < DRY_PAGES && !F.feed.error && !F.feed.wait) more();
  }, { root: E.list, rootMargin: "400px 0px" });
  io.disconnect();
  const foot = $("fwFoot");
  if (foot) io.observe(foot);
}

// The background already paused its queue twice before answering THROTTLED; wait its pause again, then go on.
async function waitFeed(f) {
  const here = () => F.feed === f;
  f.wait = true;
  await runs.wait(FEED_RUN, runs.hold({ code: MdgErrors.CODE.THROTTLED }), here);
  f.wait = false;
  if (here()) more();
}

async function more({ byHand = false } = {}) {
  const f = F.feed;
  if (!f.hasMore || f.loading || f.wait) return;
  if (byHand) f.dry = 0;
  f.loading = true;
  f.error = "";
  f.errorCode = null;
  renderFoot();
  const tick = setInterval(() => F.feed === f && F.tab === "feed" && renderFoot(), 1000);
  const r = await send({ type: "follow-feed", offset: f.offset }).finally(() => clearInterval(tick));
  f.loading = false;
  if (F.feed !== f) return;
  if (r.code === MdgErrors.CODE.THROTTLED) waitFeed(f);
  else if (!r.ok) {
    f.errorCode = r.code;
    f.error = MdgErrors.action(r.code) === "login" ? MdgErrors.TEXT.biliLogin : `读取失败：${MdgErrors.text(r)}`;
  }
  else {
    const { items, add } = mergeFeed(f.items, r.data.items || []);
    f.items = items;
    f.offset = r.data.offset || "";
    f.hasMore = Boolean(r.data.hasMore && r.data.offset);
    f.dry = feedList(add, D, feedF(), null).length ? 0 : f.dry + 1;
  }
  if (F.mode === "follow" && F.tab === "feed") renderFeed();
  renderLogin();
}

function play(bvid) {
  const fed = F.feed?.items.find((x) => x.bvid === bvid);
  const up = !fed && [...rows.values()].find((u) => u.titles.some((v) => v.bvid === bvid));
  const it = fed || up?.titles.find((v) => v.bvid === bvid);
  if (!it) return;
  F.viewing = bvid;
  F.viewingMid = playingMid(bvid, F.feed?.items, rows);
  T.openViewer({ bvid, title: it.title || it.t });
  render();
}

// An UP's space in the player, as a video plays there: F.viewing is "up:<mid>", so T and the line above the player are this UP's.
const upView = (mid) => `up:${mid}`;
function openSpace(mid) {
  F.viewing = upView(mid);
  F.viewingMid = mid;
  T.openViewer({ bvid: F.viewing, url: space(mid) });
  render();
}

// ---------- B站 writes: one request at a time, stopped by the first error ----------
// 关注's long tasks (runs.js): B站 writes, 视频投稿's wait for B站限流 and AI 打标签; the background refresh (follow_jobs)
// is a row mirrored from storage. 关注 waits B站限流 out for UI.BILI_HOLD_MS, an AI limit as 收藏夹 does.
const runs = MdgRuns.create({
  redraw() {
    renderSync();
    if (F.feed?.wait) renderFoot();
  },
  hold: (r) => (r.code === MdgErrors.CODE.THROTTLED ? { ms: UI.BILI_HOLD_MS, label: UI.BILI_STUCK } : T.hold(r))
});
// The background's queue pause (follow_jobs.hold, follow_hold) in words.
const holdLabel = (h) => (h.why === "throttled" ? UI.BILI_STUCK : MdgErrors.TEXT.netDown);
// The refresh's line, its hold (B站 risk control or a dropped connection) counting down after it; once the hold is over
// the requests go slower for a while (follow-bg.js FOLLOW_CFG.slowForMs).
runs.put("sync", () => {
  const j = D.jobs || {};
  if (!j.running) return null;
  const held = j.hold?.until > nowSec();
  const slowed = !held && (j.slowUntil || 0) > nowSec();
  const text = `${slowed ? "B站限流变慢 · " : ""}${j.step || PHASE[j.phase] || UI.REFRESHING}${j.total ? ` ${j.done || 0}/${j.total}` : j.done ? ` ${j.done}` : ""}`;
  return { text, done: j.done || 0, total: j.total || 0, slowed, wait: held && { until: j.hold.until * 1000, label: holdLabel(j.hold) } };
});
runs.put("proposal", () => AI.proposal && { text: UI.AI_TAGS_PENDING });
// 关注's writes to B站 (writes.js), on their own lane: their keys are mids, their undo steps 关注's, and a 收藏夹 batch
// never blocks them.
const W = MdgWrites.create({ runs, lane: "follow-write", send, line: (p) => `${p.name}中 ${p.done}/${p.total}` });
// calls = the requests, each with the mids it changes (a relation request one UP, a group request up to 20).
// Returns how many UP 主 went through: the ones a group request left out (B站 took the rest) are not counted. Its progress shows in the row's progress pill, as a 收藏夹 batch does, with 停止.
// UI.FOLLOW_WRITE_GAP_MS between requests. B站限流 (THROTTLED): the pill counts down, then the same request
// goes again; 停止 ends the run there, keeping what went through (and its undo).
const perUp = (mids, msg) => mids.map((mid) => msg(mid));
// skipped (an array) gets the UP 主 a group request left out ({ mid, error }); lost, the ones 重新关注 could not put
// back in their groups ({ mid, error }).
// The UP 主 it went through stay selected while they stay listed here (DESIGN 筛选和计数): those it took out of the
// sidebar item or 已出分拣范围's tab (取消关注, 重新关注, 移到) leave the selection once the data is read again.
async function relationRun(calls, label, { quiet = false, skipped = [], lost = [] } = {}) {
  const chunks = calls.map((c) => ({ msg: c, keys: c.mids || [c.mid], folders: [], gap: UI.FOLLOW_WRITE_GAP_MS }));
  const ran = new Set();
  let out = 0;
  const running = W.run("follow-write", label, {
    verb: label,
    chunks,
    onChunk(c, r) {
      const left = r?.data?.skipped || [];
      skipped.push(...left);
      out += left.length;
      if (r?.data?.groupsError) lost.push({ mid: c.msg.mid, error: r.data.groupsError });
      for (const mid of c.keys) if (!left.some((x) => x.mid === mid)) ran.add(mid);
      renderSel();
    }
  });
  // The cards too: their B站 buttons are disabled while it runs.
  render();
  const r = await running;
  if (r.busy) return toast(UI.busyText(r.busy)), 0;
  const done = r.done - out;
  if (r.stopped) toast(UI.stopWords(label, { done, total: done + r.total - r.done }));
  else if (r.error || r.done < r.total) toast(`${label}第 ${r.done + 1} 个时出错：${MdgErrors.text(r)}${r.done ? `（前 ${r.done} 个已完成）` : ""}`, true);
  else if (!quiet) toast(`已${label} ${done} 个`);
  await load();
  const listed = new Set(sideMids(D, rows, F.side).filter((m) => !F.kind || F.side !== "out" || outKind(rows.get(m)) === F.kind));
  for (const m of ran) if (!listed.has(m)) F.sel.delete(m);
  render();
  return done;
}

async function unfollow(mids) {
  if (!mids.length) return;
  // Always asked, even for one: following again later does not bring back the follow date, ★ 特别关注 or 关注分组.
  const ok = await askConfirm(`在 B站取消关注 ${mids.length} 个 UP 主？`, `${names(mids)}<p class="dialog-hint">标签会保留，可以在「已出分拣范围 › 已取消关注」里重新关注，不想留记录的也在那里清理。重新关注后会放回原来的分组和特别关注，关注日期变成重新关注的那天。</p>`, `取消关注 ${mids.length} 个`, { danger: true });
  if (ok) await relationRun(perUp(mids, (mid) => ({ type: "follow-relation", mid, act: 2 })), "取消关注");
}
// 清理, as 收藏夹's: deletes 已取消关注 records with the tags they keep, asked first, no U. B站 is not touched.
async function clean(mids) {
  if (!mids.length) return;
  const one = mids.length === 1;
  const ok = await askConfirm(one ? `清理「${nameOf(mids[0])}」？` : `清理这 ${mids.length} 个 UP 主？`, `${one ? "" : names(mids)}<p>删除${one ? "它" : "它们"}的取消关注记录和标签，无法撤销。删除后不能再从这里重新关注。<br>${UI.CLEAN_BACKUP.ask}</p>`, `清理 ${mids.length} 个`, { danger: true });
  if (!ok) return;
  const r = await send({ type: "follow-forget", mids });
  if (!r.ok) return toast(`清理失败：${r.error}`, true);
  await load();
  render();
  toast(`已清理 ${mids.length} 个 UP 主`);
}

// U on a B站 write: done = the UP 主 it went through for, back() = the requests that reverse it, built when U is pressed.
// Undoing 2+ asks first (ask). A reversal that fails says why itself (relationRun's toast), so the step then returns "";
// one B站 went through but left UP 主 out of says which.
// groups marks the 关注分组 steps, dropped when a group is deleted. undone: the toast after it, when 「已撤销：label…」 reads badly.
// As 收藏夹's write steps, U refuses while a 关注 write runs (blocked), before any confirm.
function pushWriteUndo(done, { label, backLabel, back, ask = null, groups = false, undone = "" }) {
  T.pushUndo({
    kind: "mode",
    groups,
    ask: done.length > 1 ? ask : null,
    blocked: () => UI.busyText(W.busy(), { undo: true }),
    undo: async () => {
      const calls = back();
      const want = calls.reduce((n, c) => n + (c.mids || [c.mid]).length, 0);
      const skipped = [];
      const n = await relationRun(calls, backLabel, { quiet: true, skipped });
      if (skipped.length && n + skipped.length === want) return `${backLabel}：${skipped.length} 个 UP 主 B站 没改（${upName(skipped[0].mid)}：${skipped[0].error}），其余已撤销`;
      return n < want ? "" : undone || `已撤销：${label}${done.length > 1 ? ` ${done.length} 个` : `「${upName(done[0])}」`}`;
    }
  });
}

async function refollow(mids) {
  if (!mids.length) return;
  // One: no confirm (nothing is lost); U unfollows again and puts back its 已取消关注 record: when, where and the tags.
  if (mids.length === 1) {
    const [mid] = mids;
    const gone = D.gone[mid];
    const lost = [];
    if (!(await relationRun([{ type: "follow-relation", mid, act: 1 }], "重新关注", { quiet: true, lost }))) return;
    pushWriteUndo(mids, { label: "重新关注", backLabel: "取消关注", back: () => [{ type: "follow-relation", mid, act: 2, gone }] });
    return toast(`已在 B站重新关注「${upName(mid)}」${lost.length ? `，没能放回原来的分组：${lost[0].error}` : ""}${UI.UNDO}`, lost.length > 0);
  }
  // A batch asks first and is one undo step for the ones B站 took, asked before U (as 收藏夹's batch 取消收藏).
  const ok = await askConfirm(`在 B站重新关注 ${mids.length} 个 UP 主？`, `${names(mids)}<p class="dialog-hint">原来的标签会放回去，有分组记录的也放回原来的分组。可以按 U 撤销。</p>`, `重新关注 ${mids.length} 个`);
  if (!ok) return;
  const gone = Object.fromEntries(mids.map((m) => [m, D.gone[m]]));
  const lost = [];
  const done = mids.slice(0, await relationRun(perUp(mids, (mid) => ({ type: "follow-relation", mid, act: 1 })), "重新关注", { quiet: true, lost }));
  if (!done.length) return;
  pushWriteUndo(done, {
    label: "重新关注",
    backLabel: "取消关注",
    back: () => done.map((mid) => ({ type: "follow-relation", mid, act: 2, gone: gone[mid] })),
    ask: ["在 B站撤销重新关注？", `<p>这 ${done.length} 个 UP 主在 B站再取消关注，「已出分拣范围 › 已取消关注」里的记录和标签照原样放回。</p>${names(done)}`, `撤销 ${done.length} 个`]
  });
  if (lost.length) {
    const list = lost.map(({ mid, error }) => `<li>${esc(upName(mid))}：${esc(error)}</li>`).join("");
    askConfirm(`${lost.length} 个 UP 主没能放回原来的分组`, `<ul>${list}</ul><p class="dialog-hint">已经重新关注，现在在默认分组里。按 U 撤销会取消关注，记录照原样放回。</p>`, "知道了", { alone: true });
  } else if (done.length === mids.length) toast(`已在 B站重新关注 ${done.length} 个 UP 主${UI.UNDO}`);
}
// ---------- 关注分组 on B站 (DESIGN 产品决策 · 改 B站 的操作和撤销) ----------
// mids from the groups they are in now to want(mid), as one undo step that puts back the groups they had (U on 2+ asks
// first). Only what B站 confirmed is undone: the UP 主 whose groups follow_list now shows changed (follow-bg.js writes
// it only after B站 said yes, also for the ones done before a request stopped on 限流); a request with no answer is
// neither kept here nor undone (its toast says to look after a 刷新). B站 won't regroup a closed account: the known
// ones are not sent, and they and any B站 left out are listed afterwards, still selected. Returns { done: the UP 主
// that changed, skipped, ok: no request failed }.
async function regroup(mids, want, label) {
  const before = Object.fromEntries(mids.map((m) => [m, groupsOf(m, D)]));
  const skipped = mids.filter((m) => rows.get(m)?.closed).map((mid) => ({ mid, error: "账号已注销" }));
  const calls = groupCalls(mids.filter((m) => !rows.get(m)?.closed), (m) => before[m], want);
  const known = skipped.length;
  await relationRun(calls, label, { quiet: true, skipped });
  const same = (a, b) => String([...a].sort()) === String([...b].sort());
  const done = calls.flatMap((c) => c.mids).filter((m) => !same(groupsOf(m, D), before[m]));
  if (done.length) {
    pushWriteUndo(done, {
      label,
      backLabel: `撤销${label}`,
      groups: true,
      undone: done.length > 1 ? "" : `已撤销：把「${upName(done[0])}」${label}`,
      back: () => groupCalls(done, (m) => groupsOf(m, D), (m) => before[m]),
      ask: [`在 B站撤销${label}？`, `<p>这 ${done.length} 个 UP 主回到原来的分组。</p>${names(done)}`, `撤销 ${done.length} 个`]
    });
  }
  if (skipped.length) {
    const list = skipped.map(({ mid, error }) => `<li>${esc(nameOf(mid))}：${esc(error)}</li>`).join("");
    askConfirm(`${skipped.length} 个 UP 主没能${label}`, `<ul>${list}</ul><p class="dialog-hint">它们还选着。其余的已经做完。</p>`, "知道了", { alone: true });
  }
  return { done, skipped, ok: done.length + skipped.length - known === calls.reduce((k, c) => k + c.mids.length, 0) };
}
// A card's ★: 特别关注 is group -10, so it is a single move with no confirm and U.
async function starOne(mid) {
  const on = !rows.get(mid).special;
  const label = starLabel(on);
  const { done } = await regroup([mid], (m) => regrouped(groupsOf(m, D), on ? null : SPECIAL, on ? SPECIAL : 0), label);
  if (done.length) toast(`已${label}「${upName(mid)}」${UI.UNDO}`);
}
// 移动 / 复制选中的 N 个到分组… on the selection: the shared 移动 / 复制 dialog, which is the batch's confirm (在 B站…, the count on
// its button). A move leaves the sidebar's group; 新建分组… makes the group first.
async function moveOrCopy(mids, how) {
  const from = groupId(F.side);
  if (!mids.length || (how === "move" && from == null)) return;
  const move = how === "move";
  const verb = move ? "移" : "复制";
  const ask = await UI.askTransfer({
    title: `在 B站把这 ${mids.length} 个 UP 主${verb}到分组`,
    n: mids.length,
    hows: [how],
    list: names(mids),
    label: "目标分组",
    options: groupTargets(D, from, how).map(([id, name]) => [String(id), `${name} (${sideCount(`g:${id}`)})`]),
    newText: "新建分组…",
    newPlaceholder: NEW_GROUP_NAME,
    newMax: GROUP_NAME_MAX,
    how: move ? (from === 0 ? "放进自己建的分组后，就不在默认分组里了。" : `从「${groupName(from, D)}」移走。`) : "原来的分组里也留着。",
    note: (v) => (v === String(SPECIAL) ? `${move && from === 0 ? "还留在默认分组里：特别关注只是多一个标记。" : ""}特别关注的 UP 主发视频，手机 B站会推送。` : v === "0" ? "不在别的分组的会回到默认分组，还关注着。" : "")
  });
  if (!ask || W.busy()) return;
  let to = Number(ask.target.id);
  if (ask.target.create != null) {
    const g = await createGroup(ask.target.create);
    if (!g) return;
    to = g.id;
  }
  const label = groupMoveLabel(move ? from : null, to, move, D);
  const { done, skipped, ok } = await regroup(mids, (m) => regrouped(groupsOf(m, D), move ? from : null, to), label);
  // A stopped run has said how far it got (relationRun's toast); the skipped have their own dialog.
  const n = done.length;
  const already = mids.length - n - skipped.length;
  if (!ok) return;
  if (n) toast(`已把 ${n} 个 UP 主${label}${already ? `（另外 ${already} 个已经在里面）` : ""}${UI.UNDO}`);
  else if (skipped.length) return;
  else toast(`选中的都已经在「${groupName(to, D)}」里了`);
}

// 分组管理: 标签管理's dialog (tag-dialogs.js) with B站's groups. 新建 and 改名 at once on B站 (改名 undoable with U);
// 删除 always asks, says where the members go, and has no U. While a 关注 batch writes B站 they wait, as the other B站
// writes do: a batch moving UP 主 into a group deleted meanwhile would end with an undo step for a group that is gone.
async function createGroup(name) {
  if (W.busy()) return void toast(busyWhy());
  const why = groupNameError(name);
  if (why) return void toast(why, true);
  const r = await send({ type: "follow-group-create", name: name.trim() });
  if (!r.ok) return void toast(`新建分组失败：${r.error}`, true);
  await load();
  render();
  return r.data;
}
const groupNameError = (name, self = null) => {
  const n = String(name ?? "").trim();
  return TriageUi.groupNameError(n) || ([0, SPECIAL, ...D.groups.map((g) => g.id)].some((id) => id !== self && groupName(id, D) === n) ? "已有同名分组" : "");
};
async function renameGroup(g, name, undo = false) {
  name = String(name ?? "").trim();
  if (name === g.name) return true;
  if (W.busy()) return toast(busyWhy()), false;
  const why = groupNameError(name, g.id);
  if (why) return toast(why, true), false;
  const r = await send({ type: "follow-group-rename", id: g.id, name });
  if (!r.ok) return toast(`改名失败：${r.error}`, true), false;
  const old = g.name;
  await load();
  render();
  if (undo) return true;
  T.pushUndo({
    kind: "mode",
    groups: true,
    undo: async () => ((await renameGroup({ id: g.id, name }, old, true)) ? `已撤销：分组改名「${old}」` : "")
  });
  toast(`分组已改名为「${name}」${UI.UNDO}`);
  return true;
}
async function deleteGroup(g) {
  if (W.busy()) return toast(busyWhy());
  const n = groupMembers(D, g.id);
  const ok = await askConfirm(
    `在 B站删除分组「${g.name}」？`,
    `<p>${n ? `里面的 ${n} 个 UP 主还关注着，不在别的分组的会回到「默认分组」。` : `${EMPTY_GROUP}。`}</p><p class="dialog-hint">删除后不能按 U 撤销，要用的话得重新建分组、再把人放进去。</p>`,
    "删除分组",
    { danger: true }
  );
  if (!ok) return;
  if (W.busy()) return toast(busyWhy()); // a batch started while the dialog was open
  const r = await send({ type: "follow-group-delete", id: g.id });
  if (!r.ok) return toast(`删除分组失败：${r.error}`, true);
  // Moves into or out of it undone now would ask B站 about a group that is gone.
  T.dropModeUndo((step) => step.groups);
  await load();
  render();
  toast(`已删除分组「${g.name}」`);
}
const manageGroups = {
  who: WHO,
  text: { title: GROUPS_TITLE, saved: "新建、改名和删除立即在 B站 生效。", newName: NEW_GROUP_NAME, newMax: GROUP_NAME_MAX, add: "新建", addLabel: "新建分组" },
  hint: () => "这里就是 B站 的关注分组。特别关注和默认分组是 B站 固定的，不能改名或删除；要把人放进分组，选中后用选中栏的「移动选中的 N 个到分组…」「复制选中的 N 个到分组…」。",
  tags: () => D.groups,
  count: (id) => sideCount(`g:${id}`),
  row: (g, n) => `<div class="tag-row group-row" data-id="${esc(g.id)}">
      <input type="text" name="followGroupName" value="${esc(g.name)}" data-field="name" maxlength="${GROUP_NAME_MAX}" aria-label="分组名称" />
      <span class="muted">${n} 个 UP 主</span>
      <button type="button" class="danger" data-tag-del aria-label="删除分组 ${esc(g.name)}">删除</button>
    </div>`,
  addReason: (name) => groupNameError(name),
  add: createGroup,
  edit: (g, field, value) => renameGroup(g, value),
  remove: deleteGroup
};

// ---------- dialogs ----------

// ----- 刷新, 导出, 关注设置 -----
// 刷新 from row 2, the empty state or the hint above the list: btn stays off until the background answers.
async function startSync(btn) {
  btn.disabled = true;
  const r = await send({ type: "follow-sync" });
  if (!r.ok) {
    toast(MdgErrors.text(r, "刷新没开始"), true);
    btn.disabled = false;
  }
}
$("fwRefreshBtn").addEventListener("click", (e) => startSync(e.currentTarget));
// 暂停 is on the pill and, as 暂停刷新, at row 3's right end (#fwBarR): both are inside #followMain.
main.addEventListener("click", (e) => {
  if (e.target.closest("[data-fw-stop]")) send({ type: "follow-sync-stop" });
  if (e.target.closest("[data-fw-busystop]")) W.stop();
});
// The UP 主 table: built from what the page already has. 完整备份 is 收藏夹's ([data-backup], fav-*.js).
function upCsv() {
  const head = ["UP 主", "mid", "主页", "标签", "更新状态", "最后投稿", "粉丝数", SORTS.follow, "特别关注", "签名"];
  const out = [head, ...following().map((m) => rows.get(m)).filter(Boolean).map((u) => [u.name, u.mid, space(u.mid), u.tagIds.map((id) => tagOf(id)?.name).filter(Boolean).join("、"), STATUS_TEXT[u.status] || "", u.last ? fmtDate(u.last) : "", u.fans ?? "", u.followed ? fmtDate(u.followed) : "", u.special ? "是" : "", u.sign])];
  return UI.toCsv(out);
}
$("fwExport").addEventListener("click", (e) => e.target.closest("button") && $("fwExport").hidePopover());
// The markup is in triage.html beside 收藏夹设置; 收藏夹 (fav-*.js) fills the shared rows' names (UI.fillSetRows).
const settingsDialog = $("fwSettingsDialog");
settingsDialog.querySelector("[data-open-options]").addEventListener("click", T.openOptions);

// follow_ai_settings, seeded from the 收藏夹 values on first use and stored then.
async function aiSettings() {
  const own = (await MdgLimits.followGet(["ai_settings"], chrome.storage.sync)).ai_settings;
  const triage = own ? null : await send({ type: "triage-settings-get" });
  const { value, seed } = followAiSettings(own, triage?.ok ? triage.data : null);
  // Not stored (sync quota, …): the copied values still work this time, and the next use tries again.
  if (seed) await chrome.storage.sync.set(MdgLimits.followFull({ ai_settings: seed })).catch((e) => toast(`${MdgErrors.TEXT.settingsSaveFailed}：${e.message}`, true));
  return value;
}
async function openSettings() {
  const ai = await aiSettings();
  $("fwSlowInput").value = cfg.slowDays;
  $("fwDeadInput").value = cfg.deadDays;
  $("fwBatchInput").value = ai.batchSize;
  $("fwIntervalInput").value = ai.intervalSec;
  $("fwNewMaxInput").value = ai.newTagMax;
  $("fwRemoveInput").checked = ai.allowRemove;
  $("fwSettingsError").hidden = true;
  settingsDialog.returnValue = "";
  settingsDialog.showModal();
}
// As 收藏夹设置: an invalid value keeps the dialog open with the reason; the rest is clamped on save.
settingsDialog.querySelector("form").addEventListener("submit", (e) => {
  if (e.submitter?.value !== "save") return;
  const why = settingsProblem($("fwSlowInput").value, $("fwDeadInput").value);
  $("fwSettingsError").hidden = !why;
  if (!why) return;
  e.preventDefault();
  $("fwSettingsError").textContent = why;
  $("fwDeadInput").focus();
});
settingsDialog.addEventListener("close", async () => {
  if (settingsDialog.returnValue !== "save") return;
  const ai = normAi({ batchSize: $("fwBatchInput").value, intervalSec: $("fwIntervalInput").value, newTagMax: $("fwNewMaxInput").value, allowRemove: $("fwRemoveInput").checked });
  // followSlowDays / followDeadDays keep their keys, so values set on the old settings-page section carry over.
  const days = normDays($("fwSlowInput").value, $("fwDeadInput").value);
  try {
    await chrome.storage.sync.set({ ...MdgLimits.followFull({ ai_settings: ai }), ...days });
  } catch (e) {
    return toast(`${MdgErrors.TEXT.settingsSaveFailed}：${e.message}`, true);
  }
  if (!aiRunning()) AI.settings = ai;
  cfg.slowDays = days.followSlowDays;
  cfg.deadDays = days.followDeadDays;
  if (F.loaded) derive();
  render();
  toast(MdgErrors.TEXT.settingsSaved);
});

// ----- 标签管理 (tag-dialogs.js) -----
const manageTags = {
  who: WHO,
  hint: () => "UP 标签和收藏夹的视频标签分开，只存在 MoonDigest 里，不改 B站。",
  tags: () => D.tags,
  count: (id) => following().filter((m) => rows.get(m)?.tagIds.includes(id)).length,
  addReason: (value) => UI.tagNameError(cleanTagName(value), D.tags),
  async add(value) {
    const t = await addTag(value);
    if (t) render();
    return t;
  },
  edit: editTag,
  remove: (t) => deleteTag(t.id)
};
const openManage = () => TagDialogs.manage.open(manageTags);
async function addTag(name) {
  name = cleanTagName(name);
  if (!name) return null;
  let t = null;
  await saveTags((tags) => (t = tags.find((x) => x.name === name)) ? tags : [...tags, (t = newTag(name, tags))]);
  return t;
}
// A rename, rule or color edit from 标签管理 (shared.js editedTag, as 收藏夹's saveTagEdit).
async function editTag(old, field, value) {
  const { tag, why } = UI.editedTag(old, field, value, D.tags.filter((x) => x.id !== old.id));
  if (why) toast(why, true);
  if (!tag) return false;
  await saveTags((tags) => tags.map((x) => (x.id === old.id ? tag : x)));
  render();
  return true;
}
async function deleteTag(id) {
  const t = tagOf(id);
  const n = following().filter((m) => rows.get(m)?.tagIds.includes(id)).length;
  // The confirm dialog is a second modal; the tag dialog stays open under it.
  if (!(await askConfirm(...UI.deleteTagAsk(t, n, WHO), "删除", { danger: true }))) return;
  await setTagMap((map) => UI.withoutTag(map, id));
  await saveTags((tags) => tags.filter((x) => x.id !== id));
  // As 收藏夹: tag steps undone now would work on a tag that is gone.
  T.dropModeUndo((step) => step.tags);
  F.tags.delete(id);
  render();
}

// ----- 打标签 (one UP from its card, or the selection): the shared picker, tag-picker.js -----
// A modal for the UP 主 cards and the selection; anchored (the 视频投稿 card's or the viewer line's 「+ 标签」, a CSS selector
// so it survives redraws) a popover. While the popover is open, pick.keep holds the cards it was opened over (see
// feedList), so the cards that no longer match the filter leave when it closes, with a toast.
const pick = { mids: [], anchor: "", keep: null };
function openPick(mids, anchor = "") {
  if (anchor && rows.get(mids[0])?.gone) return;
  TagPicker.close(); // saves the open one before pick is reset for this one
  pick.mids = mids;
  pick.anchor = anchor;
  pick.keep = anchor && F.feed ? new Set(feedList(F.feed.items, D, feedF(), null).filter((it) => it.mid === mids[0]).map((it) => it.bvid)) : null;
  const n = pick.keep?.size || 0;
  TagPicker.open({
    title: UI.pickTitle(mids.length, upName(mids[0]), WHO),
    note: n ? `这里有这个 UP 主的 ${n} 个视频` : "",
    targets: mids,
    idsOf: (m) => liveTags(m, D),
    tags: () => D.tags,
    canCreate: true,
    create: addTag,
    anchor,
    onClose: pickClosed
  });
  if (anchor) render();
}
async function pickClosed(changes) {
  const { keep, mids, anchor } = pick;
  pick.anchor = "";
  pick.keep = null;
  // One close is one save and one undo step, as 收藏夹's picker.
  if (changes.length) {
    const { prev } = await setTagMap((map) => changes.reduce((m, c) => withTags(m, [c.key], c.add, c.remove), map));
    const before = tagsOf(prev, changes.map((c) => c.key));
    pushTagUndo(before, MdgErrors.LABEL.tagEdit, { ask: changes.length > 1 ? UI.undoAsk("tags", changes.length, WHO) : null });
  }
  if (F.mode !== "follow") return renderViewerUp();
  render();
  const left = anchor && F.tab === "feed" && F.feed ? feedLeaving(F.feed.items, D, feedF(), keep).length : 0;
  const msg = left ? `「${upName(mids[0])}」的 ${left} 个视频已移出当前筛选` : changes.length ? "标签已更新" : "";
  if (msg) toast(`${msg}${UI.UNDO}`);
}

// T: with the viewer open, the playing video's UP (its 「UP 标签」 line), as 收藏夹's T tags the playing video; else the
// UP of the 视频投稿 card under the mouse, else the current UP card. A playing video whose UP is unknown: nothing.
function tagByKey() {
  if (F.viewing) return void (F.viewingMid && !rows.get(F.viewingMid)?.gone && openPick([F.viewingMid], "#fwViewerUp .tag-plus"));
  const it = F.tab === "feed" && F.hover && F.feed?.items.find((x) => x.bvid === F.hover);
  if (it) openPick([it.mid], `.fw-video[data-bvid="${CSS.escape(it.bvid)}"] .tag-plus`);
  else if (F.tab === "ups" && shown.includes(F.cur) && !rows.get(F.cur)?.gone) openPick([F.cur]);
}
// A modal dialog (confirm, settings, the modal picker) owns the keys; the popover does not.
const modalOpen = () => Boolean(document.querySelector("dialog[open]:not(.tp-pop)"));
const NAV = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };
// 关注's keys, from 收藏夹's one keydown handler (onKey; typing and IME already left out) and its one listener for the
// player's T / Esc.
function followKey(key) {
  if (modalOpen()) return false;
  else if (key === "Escape" && T.viewing()) T.closeViewer();
  // As 收藏夹: Esc with nothing else open clears the selection.
  else if (key === "Escape" && F.tab === "ups" && F.sel.size && !document.querySelector("dialog[open], :popover-open")) {
    F.sel.clear();
    render();
  } else if (key === "t") tagByKey();
  else if (key === "?") T.help();
  else if (key === "/") E.q.focus();
  else if (key === "u") T.undo();
  else if (key === "i") aiReason() ? toast(aiReason()) : openAi();
  else if (F.tab === "ups" && (key === "o" || key === "Enter") && shown.includes(F.cur)) {
    const bvid = latestBvid(rows.get(F.cur));
    bvid ? play(bvid) : toast("这个 UP 主还没有能在这里播放的视频");
  } else if (F.tab === "ups" && NAV[key]) setCur(stepIn(shown, F.cur, NAV[key]));
  else if (F.tab === "ups" && key === "x" && shown.includes(F.cur)) toggleSel(F.cur);
  else return false;
  return true;
}
T.setModeKeys((key) => (F.mode === "follow" ? followKey(key) : null));
// The current UP card, outlined as 收藏夹's current card; the mouse makes a card current only when the hand moves it.
function setCur(mid, scroll = true) {
  F.cur = mid;
  for (const n of E.list.querySelectorAll(".fw-up.focused")) n.classList.remove("focused");
  const card = mid && E.list.querySelector(`.fw-up[data-mid="${CSS.escape(mid)}"]`);
  card?.classList.add("focused");
  if (scroll) card?.scrollIntoView({ block: "nearest" });
}
function toggleSel(mid) {
  if (F.sel.has(mid)) F.sel.delete(mid);
  else F.sel.add(mid);
  const on = F.sel.has(mid);
  const card = E.list.querySelector(`.fw-up[data-mid="${CSS.escape(mid)}"]`);
  card?.classList.toggle("selected", on);
  F.anchor = mid;
  renderSel();
}

// ----- AI 打标签: the folder view's 批量打 flow, one UP per line -----
// A run is runs' "follow-ai".
const AI = { proposal: null, excluded: new Set(), settings: {}, history: [] };
const aiRunning = () => Boolean(runs.get("follow-ai"));
function setAiProposal(p) {
  AI.proposal = p;
  if (p) write(MdgLimits.followFull({ ai_proposal: p }));
  else chrome.storage.local.remove(MdgLimits.KEYS.follow("ai_proposal"));
}

// The AI tags only UP 主 still followed.
const followedOf = (mids) => {
  const live = new Set(following());
  return mids.filter((m) => live.has(m));
};
const aiScopeMids = (scope) => followedOf(scope === "selected" ? selShown() : F.side === "out" ? [] : [...shown]);
async function openAi() {
  if (!aiRunning()) {
    AI.settings = await aiSettings();
    AI.history = (await chrome.storage.local.get(AI_HISTORY_KEY))[AI_HISTORY_KEY] || [];
  }
  TagDialogs.ai.open(aiTags);
}
function aiScopeText(scope) {
  const mids = aiScopeMids(scope);
  const bare = aiBare(mids, rows);
  return mids.length
    ? `${mids.length} 个 UP 主${bare ? `，其中 ${bare} 个还没查投稿，AI 只能看名字和签名` : ""}${UI.batchesText(Math.ceil(mids.length / AI.settings.batchSize))}`
    : "作用范围里没有 UP 主";
}
const aiTags = {
  who: WHO,
  sees: "名字、签名、主要分区和最近的视频标题",
  example: "按内容分成 科普、游戏、生活，每人只打一个",
  excluded: AI.excluded,
  manage: manageTags,
  tags: () => D.tags,
  scopes: () => [
    { value: "filter", label: UI.scopeLabel.filter, n: aiScopeMids("filter").length },
    { value: "selected", label: UI.scopeLabel.selected, n: followedOf([...F.sel]).length, shown: aiScopeMids("selected").length }
  ],
  scopeText: aiScopeText,
  room: () => AI.settings.newTagMax,
  roomHint: () => `${aiRoomHint(D.tags, AI.excluded, AI.settings.newTagMax)}<br>每批数量、间隔和新建上限在「关注设置」里改。`,
  blocked: () => aiBlocked(F.tab, F.side),
  history: () => AI.history,
  allowRemove: () => AI.settings.allowRemove,
  // As 收藏夹: the switch is a setting, kept for the next run.
  async setAllowRemove(on) {
    const next = withAllowRemove(await aiSettings(), on);
    try {
      await chrome.storage.sync.set(MdgLimits.followFull({ ai_settings: next }));
    } catch (e) {
      toast(`${MdgErrors.TEXT.settingsSaveFailed}：${e.message}`, true);
      return false;
    }
    AI.settings = next;
    return true;
  },
  running: aiRunning,
  proposal: () => AI.proposal,
  run: runAi,
  stop: () => runs.stop("follow-ai"),
  stopping: () => Boolean(runs.get("follow-ai")?.stopping),
  discard() {
    setAiProposal(null);
    renderAiState();
  },
  apply: () => applyAi(),
  map: () => D.map,
  live: () => new Set(following()),
  tagName: (id) => tagOf(id)?.name
};

// instruction, scope and allowRemove come from the dialog, which has checked that there is an instruction and UP 主.
async function runAi({ instruction, scope, allowRemove }) {
  const mids = aiScopeMids(scope);
  if (aiRunning() || !mids.length) return;
  const progress = (text) => TagDialogs.ai.progress(aiTags, text);
  AI.history = UI.aiHistoryAdd(AI.history, instruction);
  T.store({ [AI_HISTORY_KEY]: AI.history });
  const excluded = new Set(D.tags.filter((t) => AI.excluded.has(t.id)).map((t) => t.name));
  const tags = D.tags.filter((t) => !excluded.has(t.name)).map((t) => ({ name: t.name, rule: t.rule || "" }));
  const opts = { tags: D.tags, map: D.map, maxNewTags: AI.settings.newTagMax, excluded, scope: new Set(mids) };
  const { batches, intervalMs } = aiRequests(mids, AI.settings, instruction, tags, allowRemove);
  // The same run loop as 收藏夹 (fav-*.js), on 关注's runs; each batch gets what is left of the run's new-tag cap.
  const running = T.runAiBatches({
    R: runs,
    job: "follow-ai",
    total: batches.length,
    request: (i, p) => ({ ...batches[i], maxNewTags: Math.max(0, opts.maxNewTags - p.newTags.length) }),
    merge: (p, data) => UI.mergeAiBatch(p, data, opts),
    intervalMs,
    progress: (text) => (progress(text), renderSync())
  });
  renderAiState();
  let { proposal, errors } = await running;
  // A tag deleted during the run is still named by the batches before it: dropped as a stored one is (derive), as 收藏夹's.
  if (proposal && !UI.aiProposalOk(proposal, tagOf)) {
    proposal = null;
    errors.push(UI.AI_TAG_GONE);
    progress(errors.at(-1));
  }
  setAiProposal(proposal);

  renderAiState();
  const open = TagDialogs.ai.isOpen(aiTags);
  if (open) TagDialogs.ai.render(aiTags);
  else toast(proposal ? UI.AI_TAGS_DONE : UI.aiTagsFailed(errors.at(-1)), !proposal);
}


async function applyAi() {
  const p = AI.proposal;
  if (!p) return;
  const had = new Set(D.tags.map((t) => t.id));
  const idFor = {};
  for (const t of p.newTags) if (t.checked && cleanTagName(t.name)) idFor[t.key] = (await addTag(t.name))?.id;
  const created = Object.values(idFor).filter((id) => id && !had.has(id));
  setAiProposal(null);
  let changes = [];
  const { prev } = await setTagMap((cur) => {
    changes = UI.aiChanges(p, cur, new Set(following()), (key) => idFor[key]);
    const map = { ...cur };
    for (const [mid, , after] of changes) {
      if (after.length) map[mid] = after;
      else delete map[mid];
    }
    return map;
  });
  const n = changes.length;
  const before = tagsOf(prev, changes.map(([mid]) => mid));
  // This batch replaces the last one; the list shows it to look over.
  F.recentFilter = n > 0;
  if (n) {
    D.recent = { at: Date.now(), mids: changes.map(([mid]) => mid) };
    await write(MdgLimits.followFull({ ai_recent: D.recent }));
  }
  if (n || created.length) pushTagUndo(before, `AI 打标签（${n} 个 UP 主）`, { ask: n > 1 ? UI.undoAsk("ai", n, WHO) : null, created, recentAt: n ? D.recent.at : 0 });
  render();
  // Only new tags: no UP 主 changed, so the list stays as it was.
  toast(UI.aiApplied(n, WHO, created.length));
}

// ---------- events ----------
document.getElementById("modeSwitch").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode]");
  if (b) setMode(b.dataset.mode);
});

side.addEventListener("click", (e) => {
  const s = e.target.closest("[data-side]");
  if (s) return pickSide(s.dataset.side);
  if (e.target.closest("[data-fw=settings]")) openSettings();
  if (e.target.closest("[data-fw=groups]")) TagDialogs.manage.open(manageGroups);
});
sideSlot.addEventListener("change", (e) => e.target.dataset.fw === "side" && pickSide(e.target.value));
// Into or out of 已出分拣范围 starts clean, as opening it in 收藏夹 does: no selection, tab, source or tag filter. It has
// only UP 主 (its tabs are why they left).
function freshScope(id) {
  F.kind = F.source = F.tagState = "";
  F.sel.clear();
  F.tags = new Set();
  // 视频投稿 has its own search (F.fq): the box shows the UP 主 one again, as setTab does.
  if (id === "out" && F.tab !== "ups") {
    F.tab = "ups";
    E.q.value = F.q;
  }
}
function pickSide(id) {
  if (id === F.side) return;
  if (id === "out" || F.side === "out") freshScope(id);
  F.side = id;
  if (F.feed) F.feed.dry = 0;
  saveView();
  fromTop();
}
// A new sidebar item, tab, filter, search or sort lists other cards: it starts at the top, as 收藏夹's.
function fromTop() {
  E.list.scrollTop = 0;
  F.order = null;
  render();
}

main.addEventListener("click", async (e) => {
  const t = e.target;
  const tab = t.closest("[data-fwtab]");
  if (tab) return setTab(tab.dataset.fwtab);
  // As 收藏夹's kind tabs: a selection belongs to its tab.
  const kt = t.closest("[data-fwkind]");
  if (kt) {
    if (kt.dataset.fwkind !== F.kind) F.sel.clear();
    F.kind = kt.dataset.fwkind;
    if (F.kind !== "" && F.kind !== "gone") F.source = "";
    return fromTop();
  }
  const s = t.closest("[data-side]");
  if (s) return pickSide(s.dataset.side);
  // Row 3: one pick per group, a second click clears it; 全部 clears the row (not row 4's tags). Row 4: AND.
  const st = t.closest("[data-status]");
  if (st) {
    F.status = F.status === st.dataset.status ? "" : st.dataset.status;
    return fromTop();
  }
  if (t.closest("[data-fw-all]")) {
    F.status = F.tagState = F.source = "";
    F.recentFilter = false;
    return fromTop();
  }
  const ts = t.closest("[data-fw-tagstate]");
  if (ts) {
    F.tagState = F.tagState === ts.dataset.fwTagstate ? "" : ts.dataset.fwTagstate;
    return fromTop();
  }
  const tg = t.closest("[data-fw-tag]");
  if (tg) {
    if (!F.tags.delete(tg.dataset.fwTag)) F.tags.add(tg.dataset.fwTag);
    if (F.feed) F.feed.dry = 0;
    return fromTop();
  }
  const src = t.closest("[data-source]");
  if (src) {
    F.source = F.source === src.dataset.source ? "" : src.dataset.source;
    return fromTop();
  }
  // The UP cards pick as 收藏夹's do (UI.cardPickClick): a click anywhere but the video titles and controls.
  const up = t.closest(".fw-up");
  if (up && UI.cardPickClick(e)) {
    e.preventDefault();
    if (!e.shiftKey) return toggleSel(up.dataset.mid);
    getSelection().removeAllRanges();
    F.anchor = UI.pickCard(F.sel, shown, up.dataset.mid, F.anchor, true);
    return render();
  }
  const sp = t.closest("[data-space]");
  if (sp) {
    if (!plainClick(e)) return;
    e.preventDefault();
    return openSpace(sp.dataset.space);
  }
  const playBtn = t.closest("[data-play]");
  if (playBtn) {
    if (!plainClick(e)) return;
    e.preventDefault();
    return play(playBtn.dataset.play);
  }
  const card = t.closest(".fw-video");
  if (card && UI.cardPlayClick(e)) return play(card.dataset.bvid);
  const untag = t.closest("[data-untag]");
  if (untag) {
    const mid = untag.closest("[data-mid]").dataset.mid;
    const name = tagOf(untag.dataset.untag)?.name;
    const { prev } = await changeTags([mid], [], [untag.dataset.untag]);
    const before = tagsOf(prev, [mid]);
    pushTagUndo(before, `去掉「${name}」`);
    toast(UI.untagged(name));
    return render();
  }
  const pk = t.closest("[data-pick]");
  if (pk) {
    const card = pk.closest(".fw-video");
    return openPick([pk.dataset.pick], card ? `.fw-video[data-bvid="${CSS.escape(card.dataset.bvid)}"] .tag-plus` : "");
  }
  const star = t.closest("[data-star]");
  if (star) return W.busy() ? toast(busyWhy()) : starOne(star.dataset.star);
  const cl = t.closest("[data-clean]");
  if (cl) return W.busy() ? toast(busyWhy()) : clean([cl.dataset.clean]);
  const uf = t.closest("[data-unfollow]");
  if (uf) return W.busy() ? toast(busyWhy()) : unfollow([uf.dataset.unfollow]);
  const re = t.closest("[data-refollow]");
  if (re) return W.busy() ? toast(busyWhy()) : refollow([re.dataset.refollow]);
  const act = t.closest("[data-fw]")?.dataset.fw;
  if (!act || t.closest("select")) return;
  if (act === "sync") startSync(t.closest("button"));
  else if (act === "dir") {
    const so = sortState();
    so.dir = so.dir === "asc" ? "desc" : "asc";
    saveView();
    fromTop();
  } else if (act === "reshuffle") {
    F.feed.order = null;
    fromTop();
  } else if (act === "ai") openAi();
  else if (act === "tags") openManage();
  else if (act === "settings") openSettings();
  else if (act === "bili") window.open("https://space.bilibili.com/", "_blank", "noopener");
  else if (act === "csv") MdgDownload.text(`MoonDigest-关注-${MdgCommon.localDate()}.csv`, upCsv(), "text/csv;charset=utf-8");
  else if (act === "recent") {
    F.recentFilter = !F.recentFilter;
    fromTop();
  } else if (act === "recent-done") {
    F.recentFilter = false;
    D.recent = null;
    await chrome.storage.local.remove(MdgLimits.KEYS.follow("ai_recent"));
    fromTop();
  } else if (act === "more") more({ byHand: true });
  else if (act === "select-all") {
    UI.toggleAll(shown, F.sel);
    render();
  } else if (act === "select-none") {
    F.sel.clear();
    render();
  } else if (act === "pick-sel") openPick(selShown());
  // 标签… only changes MoonDigest's tags, so a B站 batch does not hold it; the rest write B站 (清理 drops their records).
  else if (W.busy()) toast(busyWhy());
  else if (act === "unfollow") unfollow(selShown().filter((m) => !rows.get(m).gone));
  else if (act === "refollow") refollow(selShown().filter((m) => rows.get(m).gone));
  else if (act === "clean") clean(cleanTargets().mids);
  else if (act === "move-sel" || act === "copy-sel") moveOrCopy(selShown(), act === "move-sel" ? "move" : "copy");
});
// The selection bar sits outside the list; its buttons share the handler above through #followMain.

// One box, two searches: UP 主 and 视频投稿 each keep their own text (setTab swaps it in).
UI.bindSearch(E.q, (q) => {
  if (F.tab === "feed") F.fq = q;
  else F.q = q;
  fromTop();
});
main.addEventListener("change", (e) => {
  const act = e.target.dataset.fw;
  if (act === "sort") {
    const so = sortState();
    so.sort = e.target.value;
    so.dir = SORT_DIR[so.sort];
    saveView();
    fromTop();
  } else if (act === "fsort") {
    // 更新时间 is the loaded list as it is; 随机 shuffles it anew. Both start at the top.
    F.fsort = e.target.value;
    F.feed.order = null;
    saveView();
    fromTop();
  } else if (act === "side") pickSide(e.target.value);
});

vline.addEventListener("click", (e) => {
  const pk = e.target.closest("[data-pick]");
  if (pk) openPick([pk.dataset.pick], "#fwViewerUp .tag-plus");
});
E.list.addEventListener("mouseover", (e) => (F.hover = e.target.closest(".fw-video")?.dataset.bvid || ""));
E.list.addEventListener("mouseleave", () => (F.hover = ""));
let pointerAt = "";
E.list.addEventListener("mousemove", (e) => {
  const at = `${e.clientX},${e.clientY}`;
  if (at === pointerAt) return;
  pointerAt = at;
  const mid = e.target.closest(".fw-up")?.dataset.mid;
  if (mid && mid !== F.cur) setCur(mid, false);
});

// Storage: follow_jobs ticks often while a sync runs, so it redraws only the head and hint; data changes redraw all,
// at most once a second.
let redrawTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes.followSlowDays || changes.followDeadDays)) {
    const days = normDays(changes.followSlowDays?.newValue ?? cfg.slowDays, changes.followDeadDays?.newValue ?? cfg.deadDays);
    cfg.slowDays = days.followSlowDays;
    cfg.deadDays = days.followDeadDays;
    if (F.loaded) derive();
    return render();
  }
  const fc = MdgLimits.followShort(changes);
  if (area === "local" && fc.hold) F.hold = fc.hold.newValue || null;
  if (area !== "local" || !F.loaded) return;
  // A finished refresh may change who is followed: 视频投稿 reads from page 1 again the next time it is opened, not
  // under the pages loaded now.
  if (syncFinished(fc.jobs?.oldValue, fc.jobs?.newValue) && F.feed) F.feed.stale = true;
  const keys = Object.keys(fc).filter((k) => KEYS.includes(k));
  if (!keys.length) return;
  if (keys.every((k) => k === "jobs")) {
    const was = checking();
    const running = Boolean(D.jobs?.running);
    D.jobs = fc.jobs.newValue || {};
    if (F.mode === "follow") renderHead();
    // A run starting or ending changes the hint above the list, and the 查投稿中… card moves on: redraw the list for them.
    if (F.mode === "follow" && F.tab === "ups" && (!D.list || checking() !== was || running !== Boolean(D.jobs.running))) renderUps();
    return;
  }
  if (redrawTimer) return;
  redrawTimer = setTimeout(async () => {
    redrawTimer = 0;
    await load();
    render();
  }, 1000);
});
// 「N 秒后重试」 counts down.
setInterval(() => {
  if (F.mode === "follow" && D.jobs?.running && D.jobs.hold?.until) renderHead();
}, 1000);

// Leaving the viewer (× or Esc) clears the playing mark. Opening or closing it re-lays the list, as in 收藏夹: the card
// playing (or that was, else the current one) is brought back into view.
new MutationObserver(() => {
  const card = F.mode === "follow" ? E.list.querySelector(".playing") || E.list.querySelector(".focused") : null;
  const sel = card?.dataset.mid ? `[data-mid="${CSS.escape(card.dataset.mid)}"]` : card?.dataset.bvid ? `[data-bvid="${CSS.escape(card.dataset.bvid)}"]` : "";
  if (F.viewing && !T.viewing()) {
    F.viewing = "";
    render();
  }
  if (sel) E.list.querySelector(sel)?.scrollIntoView({ block: "nearest" });
}).observe($("viewer"), { attributes: true, attributeFilter: ["hidden"] });

const [{ [VIEW_KEY]: view }, days] = await Promise.all([
  chrome.storage.local.get(VIEW_KEY),
  chrome.storage.sync.get({ followSlowDays: null, followDeadDays: null })
]);
({ followSlowDays: cfg.slowDays, followDeadDays: cfg.deadDays } = normDays(days.followSlowDays, days.followDeadDays));
if (view?.tab === "feed") F.tab = "feed";
if (SORTS[view?.sort]) F.sort = view.sort;
if (view?.dir === "asc" || view?.dir === "desc") F.dir = view.dir;
if (FEED_SORTS[view?.fsort]) F.fsort = view.fsort;
if (typeof view?.side === "string") F.side = view.side === "special" ? `g:${SPECIAL}` : view.side === "gone" ? "out" : view.side; // checked against the data on load (derive)
// Deep link from the UP tag picker on B站 pages: #follow opens 关注, &tag=<id> picks that tag (unknown id → 全部),
// &up=<mid> clears the filters and makes that UP's card current (unknown mid → just the list).
// A hash wins over the remembered mode; an open tab only gets its hash changed. Handled once, the hash goes: the same
// link clicked again is a hash change again, and a reload opens the mode last used.
async function followHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (!/^follow(&|$)/.test(h)) return false;
  history.replaceState(null, "", location.pathname + location.search);
  const params = new URLSearchParams(h.slice(6));
  const tag = params.get("tag");
  const up = params.get("up");
  if (F.mode !== "follow") await setMode("follow");
  // Both clear what could hide the card or the tag's UP 主: the 视频投稿 tab, the search and rows 3 and 4. The tag becomes
  // row 4's only pick over all of 关注 (an unknown id → nothing picked).
  if (up || tag) {
    const side = !tag && rows.has(up) && outKind(rows.get(up)) ? "out" : "all";
    // Into or out of 已出分拣范围 clears the selection, as the sidebar does.
    if (side === "out" || F.side === "out") freshScope(side);
    if (tag) F.sel.clear();
    F.tab = "ups";
    F.side = side;
    if (F.feed) F.feed.dry = 0; // as pickSide
    F.status = F.tagState = F.source = F.kind = F.q = "";
    E.q.value = "";
    F.recentFilter = false;
    F.tags = new Set(tag && D.tags.some((x) => x.id === tag) ? [tag] : []);
  }
  derive();
  render();
  if (up) {
    setCur(up, false);
    E.list.querySelector(".fw-up.focused")?.scrollIntoView({ block: "center" });
  }
  return true;
}
window.addEventListener("hashchange", followHash);
// As 收藏夹: closing or reloading the page would stop a B站 batch write halfway, so the browser asks first.
window.addEventListener("beforeunload", (e) => {
  if (!W.busy()) return;

  e.preventDefault();
  e.returnValue = true;
});
if (!(await followHash()) && view?.mode === "follow") setMode("follow", false);
