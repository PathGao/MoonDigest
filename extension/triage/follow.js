// 关注 mode of the 分拣台: UP 主 cards sorted into my own UP tags, and the video feed of the people I follow.
// The top bar's 收藏夹 | 关注 switch puts body.follow-mode on; follow.css then hides the folder view and this file draws
// into #followSide and #followMain (the same grid areas as the folder view, so the shared viewer sits beside the list).
// Data comes from follow-bg.js through follow_* storage and the follow-* messages (see follow-port-contract.md).
// Tags live only in this extension (follow_tags / follow_tag_map); writes to B站 (取消关注, 重新关注, 特别关注) ask first.
import "./triage.js"; // runs first: it sets up the page and globalThis.MoonTriage (viewer, toast, confirm dialog)

// ---------- pure: follow.selftest.js lifts everything between these markers ----------
// PURE-START
const DAY = 86400;
// -404 / -626: the account is gone for good; it has no videos to wait for.
const GONE_CODES = [-404, -626];
const STATUS = [["", "全部"], ["active", "活跃"], ["slow", "慢更"], ["dead", "断更"], ["stale", "慢更或断更 · 待查"], ["none", "没投过稿"], ["unchecked", "未查"]];
// Catppuccin Latte accents, as the folder view's TAG_COLORS: mauve, blue, green, red and yellow are left out (they mean
// where-you-are, next step, keep, delete and pending).
const TAG_COLORS = ["#da86c3", "#298287", "#dc6d2d", "#3590a0", "#8595ea", "#cf5c66", "#2497c6", "#cf8686", "#ce9386"];

// The newest post we know of, in seconds: the video feed (re-read on every sync) first, then the UP's own videos
// (follow_content, fetched once for people the feed did not show). 0 = none known.
function lastPostOf(mid, D) {
  const c = D.content?.[mid];
  const own = c?.code === 0 ? (c.v || []).map((v) => v.c || 0) : [];
  const feed = (D.last?.v?.[mid] || []).map((v) => v.c || 0);
  return Math.max(0, D.last?.map?.[mid] || 0, ...own, ...feed);
}

// 更新状态: active | slow | dead by the newest post; none = 没投过稿 (or the account is gone); stale = the feed reached
// back past slowDays without them and their videos were not read yet (慢更还是断更待查); unchecked = 未查.
function followStatus(mid, D, now, slowDays = 90, deadDays = 365) {
  const last = lastPostOf(mid, D);
  if (last) {
    const days = (now - last) / DAY;
    return days >= deadDays ? "dead" : days >= slowDays ? "slow" : "active";
  }
  const c = D.content?.[mid];
  if (c && (c.code === 0 || GONE_CODES.includes(c.code))) return "none";
  if (D.last?.since && D.last.since <= now - slowDays * DAY) return "stale";
  return "unchecked";
}

// The 3 newest titles from both sources, newest first, one per title.
function recentTitles(mid, D) {
  const c = D.content?.[mid];
  const all = [...(D.last?.v?.[mid] || []), ...(c?.code === 0 ? c.v || [] : [])].sort((a, b) => (b.c || 0) - (a.c || 0));
  const seen = new Set();
  return all.filter((v) => v.t && !seen.has(v.t) && seen.add(v.t)).slice(0, 3);
}

const liveTags = (mid, D) => (D.map?.[mid] || []).filter((id) => D.tags.some((t) => t.id === id));

function upRow(mid, D, now, cfg) {
  const p = D.people?.[mid] || {};
  const c = D.content?.[mid];
  const gone = D.gone?.[mid] || null;
  return {
    mid,
    name: p.name || `未获取名字（${mid}）`,
    face: p.face || "",
    sign: p.sign || "",
    ov: p.ov || "",
    status: followStatus(mid, D, now, cfg.slowDays, cfg.deadDays),
    last: lastPostOf(mid, D),
    count: c?.code === 0 ? c.count || 0 : 0,
    closed: Boolean(p.gone) || GONE_CODES.includes(c?.code),
    zone: Object.entries(c?.tlist || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || "",
    titles: recentTitles(mid, D),
    followed: D.list?.followTime?.[mid] || 0,
    fans: Number.isFinite(D.stats?.[mid]?.follower) ? D.stats[mid].follower : null,
    special: Boolean(D.list?.special?.[mid]),
    gone,
    // An unfollowed UP keeps the tags it had, to put back on 重新关注.
    tagIds: gone ? (gone.tagIds || []).filter((id) => D.tags.some((t) => t.id === id)) : liveTags(mid, D)
  };
}

// B站 分组 (follow_groups, read-only) are left-column items "g:<tagid>"; members come from follow_list.groups.
const groupId = (side) => (/^g:\d+$/.test(side) ? Number(side.slice(2)) : null);
const inGroup = (mid, D, side) => (D.list?.groups?.[mid] || []).includes(groupId(side));
// Every left-column id, B站 分组 last. No custom groups = the same ids as before groups existed.
const sideIds = (D) => ["all", "untagged", "special", "gone", ...D.tags.map((t) => t.id), ...(D.groups || []).map((g) => `g:${g.id}`)];

// The UPs of a left-column item, before 更新状态 / search: the follow list (or the unfollowed, newest first).
function sideMids(D, rows, side) {
  if (side === "gone") return Object.keys(D.gone || {}).sort((a, b) => (D.gone[b].at || 0) - (D.gone[a].at || 0));
  const list = (D.list?.list || []).filter((m) => rows.has(m));
  if (side === "all") return list;
  if (side === "untagged") return list.filter((m) => !rows.get(m).tagIds.length);
  if (side === "special") return list.filter((m) => rows.get(m).special);
  if (groupId(side) != null) return list.filter((m) => inGroup(m, D, side));
  return list.filter((m) => rows.get(m).tagIds.includes(side));
}

// What the list shows: f = { side, status, q, sort, recent: Set | null, source: "" | "bili" | "app" (已取消关注 only) }. counts are per 更新状态 over the side's UPs
// (search and 「AI 刚打的」 applied), so a status filter never hides its own count.
function visibleUps(D, rows, f) {
  const q = String(f.q || "").trim().toLowerCase();
  const base = sideMids(D, rows, f.side).filter((m) => {
    const u = rows.get(m);
    return (!q || `${u.name}\n${u.sign}\n${u.zone}`.toLowerCase().includes(q)) && (!f.recent || f.recent.has(m)) && (!f.source || u.gone?.source === f.source);
  });
  const counts = { "": base.length };
  for (const m of base) counts[rows.get(m).status] = (counts[rows.get(m).status] || 0) + 1;
  let list = base.filter((m) => !f.status || rows.get(m).status === f.status);
  if (f.side !== "gone") {
    const cmp = sortCmp(f.sort, f.dir);
    list = [...list].sort((a, b) => cmp(rows.get(a), rows.get(b)));
  }
  return { list, counts };
}

// UP 主 sort: 最近更新 (last post), 关注时间, 粉丝数, 名字; dir "desc" = big / new first. An UP with no value (never
// posted or unknown, no follow time, 粉丝数未查) sinks to the bottom in both directions; ties keep the list order.
const SORTS = { last: "最近更新", follow: "关注时间", fans: "粉丝数", name: "名字" };
const SORT_DIR = { last: "desc", follow: "desc", fans: "desc", name: "asc" }; // each sort's default direction
function sortCmp(sort, dir = SORT_DIR[sort] || "desc") {
  const val = { last: (u) => u.last || null, follow: (u) => u.followed || null, fans: (u) => u.fans ?? null, name: (u) => u.name }[sort] || ((u) => u.last || null);
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const [x, y] = [val(a), val(b)];
    if (x == null || y == null) return (x == null) - (y == null);
    return sign * (typeof x === "string" ? x.localeCompare(y, "zh") : x - y);
  };
}
// The direction button's words: time sorts 新→旧 / 旧→新, counts 从多到少 / 从少到多, names A→Z / Z→A.
function dirLabel(sort, dir) {
  if (sort === "name") return dir === "asc" ? "A→Z" : "Z→A";
  if (sort === "fans") return dir === "asc" ? "从少到多" : "从多到少";
  return dir === "asc" ? "旧→新" : "新→旧";
}
// 粉丝 12.3万: one decimal from 万 up, none below.
function fmtFans(n) {
  const one = (v) => String(Math.round(v * 10) / 10);
  return n >= 1e8 ? `${one(n / 1e8)}亿` : n >= 1e4 ? `${one(n / 1e4)}万` : String(n);
}

// Adds a feed page to the loaded videos without repeats, newest first (B站 pages overlap and come slightly out of
// order); ties keep their order. add = the videos that were new.
function mergeFeed(items, page) {
  const seen = new Set(items.map((it) => it.bvid));
  const add = page.filter((it) => it?.bvid && !seen.has(it.bvid) && seen.add(it.bvid));
  return { items: [...items, ...add].sort((a, b) => (b.at || 0) - (a.at || 0)), add };
}

// Whether a feed video belongs to the picked left-column item.
function feedMatch(it, D, side) {
  if (side === "all") return true;
  if (side === "gone") return false;
  if (side === "special") return Boolean(D.list?.special?.[it.mid]);
  if (groupId(side) != null) return inGroup(it.mid, D, side);
  const ids = liveTags(it.mid, D);
  return side === "untagged" ? !ids.length : ids.includes(side);
}

// The 动态 list: the picked item's videos, plus keep (bvids): the cards showing when the tag picker opened stay until
// it closes, so ticking a tag never pulls a card out from under it. feedLeaving = the kept cards that go on close.
const feedList = (items, D, side, keep) => items.filter((it) => feedMatch(it, D, side) || keep?.has(it.bvid));
const feedLeaving = (items, D, side, keep) => items.filter((it) => keep?.has(it.bvid) && !feedMatch(it, D, side));

// The tag map after adding / removing tags on mids; an UP left with none drops out of the map.
function withTags(map, mids, add, remove) {
  const out = { ...map };
  for (const m of mids) {
    const ids = [...new Set([...(out[m] || []).filter((id) => !remove.includes(id)), ...add])];
    if (ids.length) out[m] = ids;
    else delete out[m];
  }
  return out;
}
// The picker's click: all of mids have the tag → take it off all, otherwise put it on all.
function pickToggle(map, mids, id) {
  const all = mids.every((m) => (map[m] || []).includes(id));
  return withTags(map, mids, all ? [] : [id], all ? [id] : []);
}

// T / Esc forwarded by viewer-frame.js while focus is in the player: only from the viewer's own frame and B站's origin.
function fromViewer(e, frameWin) {
  const ok = frameWin && e.source === frameWin && e.origin === "https://www.bilibili.com" && e.data?.type === "mdg-viewer-key";
  return ok && ["t", "Escape"].includes(e.data.key) ? e.data.key : "";
}

// AI 打标签 proposal, as the folder view's 批量打: p = { newTags: [{ key, name, checked }], rows: [{ mid, add: ["id:<id>" |
// "new:<key>"], remove: [id] }], notes, errors }. opts = { tags, map, maxNewTags, excluded: Set of names, scope: Set of mids }.
function mergeAiBatch(p, data, opts) {
  const existing = (name) => opts.tags.find((t) => t.name === name);
  const proposed = (name) => p.newTags.find((t) => t.key === name);
  const addNew = (name) => {
    if (p.newTags.length >= opts.maxNewTags) return null;
    const t = { key: name, name, checked: true };
    p.newTags.push(t);
    return t;
  };
  const blocked = (name) => opts.excluded?.has(name);
  for (const raw of data?.newTags || []) {
    const name = String(raw ?? "").trim();
    if (name && !blocked(name) && !existing(name) && !proposed(name)) addNew(name);
  }
  if (data?.note) p.notes.push(String(data.note));
  for (const [mid, a] of Object.entries(data?.assignments || {})) {
    if (!opts.scope.has(mid)) continue;
    const current = opts.map[mid] || [];
    const add = [];
    for (const raw of a?.add || []) {
      const name = String(raw ?? "").trim();
      if (!name || blocked(name)) continue;
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
      .filter((t) => t && !blocked(t.name) && current.includes(t.id))
      .map((t) => t.id);
    if (!add.length && !remove.length) continue;
    const row = p.rows.find((r) => r.mid === mid);
    if (row) {
      row.add = [...new Set([...row.add, ...add])];
      row.remove = [...new Set([...row.remove, ...remove])];
    } else p.rows.push({ mid, add, remove });
  }
}

// [mid, before, after] for every row that changes its UP's tags. idOf(key) is a new tag's id (or a stand-in before
// 应用); an unchecked new tag adds nothing. Only UPs in follow (still followed) change.
function aiChanges(p, map, follow, idOf) {
  const out = [];
  for (const r of p.rows) {
    if (!follow.has(r.mid)) continue;
    const before = map[r.mid] || [];
    const ids = new Set(before);
    for (const ref of r.add) {
      const key = ref.slice(4);
      const id = ref.startsWith("id:") ? ref.slice(3) : p.newTags.find((t) => t.key === key)?.checked && idOf(key);
      if (id) ids.add(id);
    }
    for (const id of r.remove) ids.delete(id);
    const after = [...ids];
    if (after.length !== before.length || after.some((id) => !before.includes(id))) out.push([r.mid, before, after]);
  }
  return out;
}

// The confirm page sums the changes up per tag ("+ 科普 12"); UPs are judged afterwards on their cards.
function aiTally(changes, nameOf) {
  const tally = new Map();
  for (const [, before, after] of changes) {
    const rows = after.filter((id) => !before.includes(id)).map((id) => ["add", `+ ${nameOf(id)}`])
      .concat(before.filter((id) => !after.includes(id)).map((id) => ["remove", `− ${nameOf(id)}`]));
    for (const [cls, text] of rows) {
      const t = tally.get(text) || { cls, text, n: 0 };
      t.n++;
      tally.set(text, t);
    }
  }
  return [...tally.values()].sort((a, b) => (a.cls === "remove") - (b.cls === "remove") || b.n - a.n);
}

// 关注's own AI 打标签 settings (chrome.storage.sync follow_ai_settings), clamped like the 分拣设置 fields.
function normAi(s = {}) {
  const int = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
  return { batchSize: int(s.batchSize, 1, 100, 30), intervalSec: int(s.intervalSec, 0, 600, 8), newTagMax: int(s.newTagMax, 0, 50, 5), allowRemove: s.allowRemove === true };
}
// The first use copies the 收藏夹 values (triage-settings-get, or the defaults); seed is what to store then. After that the
// two are independent: a stored value always wins.
function followAiSettings(own, triage) {
  if (own && typeof own === "object") return { value: normAi(own), seed: null };
  const t = triage || {};
  const value = normAi({ batchSize: t.triageTitleBatchSize, intervalSec: t.triageIntervalSec, newTagMax: t.triageAiNewTagMax, allowRemove: t.triageAiRemoveTags });
  return { value, seed: value };
}
// The follow-ai-tag requests of one run: mids in batches of cfg.batchSize; maxNewTags is the run's cap (each batch gets
// what is left of it), allowRemove the dialog's switch.
function aiRequests(mids, cfg, instruction, tags, allowRemove) {
  const out = [];
  for (let i = 0; i < mids.length; i += cfg.batchSize) out.push({ type: "follow-ai-tag", instruction, mids: mids.slice(i, i + cfg.batchSize), tags, maxNewTags: cfg.newTagMax, allowRemove });
  return { batches: out, intervalMs: cfg.intervalSec * 1000 };
}
// Why the days cannot be saved, or "" (empty boxes fall back to the defaults).
function settingsProblem(slow, dead) {
  const s = String(slow).trim() === "" ? 90 : Number(slow);
  const d = String(dead).trim() === "" ? 365 : Number(dead);
  if (!Number.isFinite(s) || !Number.isFinite(d)) return "天数要填数字";
  return d > s ? "" : "断更天数要比慢更大";
}
// 慢更 7–3650 days, 断更 at least a day more.
function normDays(slow, dead) {
  const num = (v, d) => (Number.isFinite(parseFloat(v)) ? Math.round(parseFloat(v)) : d);
  const followSlowDays = Math.min(3650, Math.max(7, num(slow, 90)));
  return { followSlowDays, followDeadDays: Math.min(3651, Math.max(followSlowDays + 1, num(dead, 365))) };
}

// 「3 天前」 style ages for seconds; under a day is 今天.
function fmtAgo(sec, now) {
  const d = Math.floor((now - sec) / DAY);
  if (d < 1) return "今天";
  if (d < 31) return `${d} 天前`;
  if (d < 365) return `${Math.floor(d / 30)} 个月前`;
  return `${Math.floor(d / 365)} 年前`;
}
// A plain primary click on a video link plays it in the viewer here; with ⌘ / Ctrl / Shift / Alt the browser opens it.
const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
// PURE-END

// ---------- page ----------
const T = globalThis.MoonTriage;
const UI = globalThis.TriageUi;
const { esc, toast, askConfirm, send } = T;
const KEYS = ["follow_list", "follow_people", "follow_last", "follow_content", "follow_tags", "follow_tag_map", "follow_unfollowed", "follow_jobs", "follow_ai_recent", "follow_stats", "follow_groups"];
const VIEW_KEY = "follow_view"; // { mode: "fav" | "follow", tab: "ups" | "feed", sort, dir }
const saveView = () => chrome.storage.local.set({ [VIEW_KEY]: { mode: F.mode, tab: F.tab, sort: F.sort, dir: F.dir } });
const AI_HISTORY_KEY = "follow_ai_history";
const STATUS_TEXT = Object.fromEntries(STATUS);
const STATUS_BADGE = { active: "keep", slow: "unsure", dead: "drop", stale: "unsure low", none: "none", unchecked: "none" };
const PHASE = { list: "读关注列表", feed: "翻视频动态", arc: "查投稿" };
const DRY_PAGES = 3; // the feed stops loading by itself after this many pages in a row without a video for the picked item
const FEED_KEEP_MS = 3 * 60 * 1000; // as the background's cache; older lists start over
const space = (mid) => `https://space.bilibili.com/${mid}`;
const video = (bvid) => `https://www.bilibili.com/video/${bvid}`;
const nowSec = () => Date.now() / 1000;
// hdslb images: https and a small webp copy.
const img = (u, size) => {
  const s = String(u || "").replace(/^(https?:)?\/\//, "https://");
  return /hdslb\.com\//.test(s) && !s.includes("@") ? `${s}@${size}.webp` : s;
};
const pad = (n) => String(n).padStart(2, "0");
const fmtDate = (sec) => {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmtDur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}:` : "") + `${pad(Math.floor((s % 3600) / 60))}:${pad(Math.floor(s % 60))}`;
const fmtCount = (n) => (n >= 1e4 ? `${(n / 1e4).toFixed(n >= 1e5 ? 0 : 1)}万` : String(n || 0));
const AI_SPARK = UI.AI_SPARK;
const PLACEHOLDER = { ups: "搜 UP 主：名字、签名、分区", feed: "搜动态：标题、UP 主" };

let D = { tags: [], map: {}, gone: {}, people: {}, content: {}, jobs: {}, list: null, last: null, recent: null };
let rows = new Map();
let shown = [];
const cfg = { slowDays: 90, deadDays: 365 };
const F = {
  mode: "fav",
  tab: "ups",
  side: "all",
  status: "",
  source: "", // 已取消关注: "" | "bili" (在 B站取关) | "app" (在这里取关)
  q: "", // UP 主's search; 动态 keeps its own (fq)
  fq: "",
  sort: "last",
  dir: "desc",
  sel: new Set(),
  busy: "", // the B站 write running, e.g. 取消关注 3/10
  recentFilter: false,
  loaded: false,
  feed: null, // { items, offset, hasMore, loading, error, dry, at }
  viewing: "",
  viewingMid: "", // the playing video's UP
  hover: "" // the 动态 card under the mouse (bvid), for T
};
const $ = (id) => document.getElementById(id);
const side = $("followSide");
const main = $("followMain");

// The same four rows as 收藏夹, from the same shared.js pieces: 关注 · N | sort; UP 主 | 动态 | search, 刷新, 导出;
// filters | 全选 and ✦ AI 打标签; the list.
main.innerHTML = `
  <div class="folder-head fw-head">
    <div class="folder-info"><div class="folder-text"><h1 id="fwTitle" class="folder-title">关注</h1><div id="fwMeta" class="folder-meta"></div></div>
      <button type="button" class="bili-link" data-fw="bili" aria-label="在 B站打开我的空间">在 B站打开 ↗</button>
    </div>
    <span id="fwSort" class="sort-box"></span>
  </div>
  <div class="tabrow">
    <nav id="fwTabs" class="tabs fw-tabs" role="tablist" aria-label="关注"></nav>
    <span class="row-tools" role="toolbar" aria-label="关注的操作">${UI.searchBox("fwQ", "fwQCount", PLACEHOLDER.ups)}${UI.rowButtons({
      activityId: "fwActivity", refreshId: "fwRefreshBtn", refreshLabel: "从 B站刷新关注", refreshTitle: "读关注列表、翻视频动态，再查动态里没出现的人",
      exportId: "fwExportBtn", menuId: "fwExport",
      menuHtml: UI.menuItem('data-fw="csv" aria-label="下载 UP 主表格 CSV"', "UP 主表格 (CSV)", "名字、标签、更新状态、最后投稿、粉丝数") + "<hr>" + UI.BACKUP_ITEM,
      settingsAttr: 'data-fw="settings"', settingsLabel: "关注设置"
    })}</span>
  </div>
  <div class="stagebar fw-bar"><span id="fwBar" class="fw-bar-dyn"></span><span id="fwTools" class="fw-tools"><span id="fwSelAll"></span>${UI.aiTagBtn('data-fw="ai" aria-label="AI 打标签"')}</span></div>
  <div id="fwList" class="fw-list" aria-label="UP 主"></div>
  <div id="fwSel"></div>`;
const E = { sort: $("fwSort"), title: $("fwTitle"), tools: $("fwTools"), selAll: $("fwSelAll"), meta: $("fwMeta"), tabs: $("fwTabs"), bar: $("fwBar"), list: $("fwList"), sel: $("fwSel"), q: $("fwQ"), qCount: $("fwQCount") };
// Without the sidebar its items become a select in the top bar, where 收藏夹 shows its folder select.
const sideSlot = document.createElement("span");
sideSlot.className = "fw-side-slot";
$("folderSelect").after(sideSlot);

// ---------- data ----------
async function load() {
  const got = await chrome.storage.local.get(KEYS);
  D = {
    list: got.follow_list || null,
    people: got.follow_people || {},
    last: got.follow_last || null,
    content: got.follow_content || {},
    tags: got.follow_tags || [],
    map: got.follow_tag_map || {},
    gone: got.follow_unfollowed || {},
    jobs: got.follow_jobs || {},
    recent: got.follow_ai_recent || null,
    stats: got.follow_stats || {},
    groups: got.follow_groups || []
  };
  derive();
}
function derive() {
  const now = nowSec();
  rows = new Map();
  for (const mid of [...(D.list?.list || []), ...Object.keys(D.gone)]) if (!rows.has(mid)) rows.set(mid, upRow(mid, D, now, cfg));
  if (!sideIds(D).includes(F.side)) F.side = "all";
  if (!D.recent?.mids?.length) F.recentFilter = false;
}
const following = () => D.list?.list || [];
const tagOf = (id) => D.tags.find((t) => t.id === id);
const nameOf = (mid) => rows.get(mid)?.name || mid;
const upName = (mid) => D.people?.[mid]?.name || F.feed?.items.find((it) => it.mid === mid)?.name || nameOf(mid);
const write = (obj) => chrome.storage.local.set(obj);
const names = (mids) => mids.slice(0, 20).map((m) => esc(nameOf(m))).join("、") + (mids.length > 20 ? ` 等 ${mids.length} 个` : "");

async function setTagMap(map) {
  D.map = map;
  derive();
  await write({ follow_tag_map: map });
}
async function saveTags(tags) {
  D.tags = tags;
  derive();
  await write({ follow_tags: tags });
}
const changeTags = (mids, add, remove) => setTagMap(withTags(D.map, mids, add, remove));
function newTag(name) {
  const color = TAG_COLORS.find((c) => !D.tags.some((t) => t.color === c)) || TAG_COLORS[D.tags.length % TAG_COLORS.length];
  return { id: `ft${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, color, rule: "" };
}
const cleanName = (s) => String(s ?? "").replace(/[,，、]/g, "").trim().slice(0, 12);

// ---------- mode ----------
async function setMode(mode, save = true) {
  if (mode === F.mode) return;
  closePick();
  if (T.viewing()) T.closeViewer();
  F.mode = mode;
  const on = mode === "follow";
  document.body.classList.toggle("follow-mode", on);
  side.hidden = main.hidden = !on;
  for (const b of document.querySelectorAll("#modeSwitch [data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  if (save) saveView();
  if (on && !F.loaded) {
    F.loaded = true;
    await load();
  }
  // One feed page (cached a few minutes in the worker) brings posts made since the last 刷新 into 最近更新.
  if (on) send({ type: "follow-feed", offset: "" }).catch(() => {});
  if (on) render();
}
function setTab(tab) {
  closePick();
  if (T.viewing()) T.closeViewer();
  F.tab = tab;
  E.q.value = tab === "feed" ? F.fq : F.q;
  saveView();
  render();
}

// ---------- render ----------
function render() {
  if (F.mode !== "follow") return;
  if (E.q.placeholder !== PLACEHOLDER[F.tab]) {
    E.q.placeholder = PLACEHOLDER[F.tab];
    E.q.setAttribute("aria-label", `${PLACEHOLDER[F.tab]} (/)`);
  }
  renderSide();
  renderHead();
  renderTabs();
  if (F.tab === "feed") renderFeed();
  else renderUps();
  renderViewerUp();
}

function renderSide() {
  const list = following();
  const n = (fn) => list.filter((m) => rows.has(m) && fn(rows.get(m))).length;
  const item = (id, label, count, pre = "") =>
    `<button type="button" class="side-item${F.side === id ? " on" : ""}${count ? "" : " zero"}" data-side="${esc(id)}"${F.side === id ? ' aria-current="true"' : ""}>${pre}<span class="side-name">${esc(label)}</span><span class="side-count">${count}</span></button>`;
  side.innerHTML = `<div class="side-head">UP 主</div><div class="folder-list">${[
    item("all", "全部", list.length),
    item("untagged", "未打标签", n((u) => !u.tagIds.length)),
    item("special", "特别关注", n((u) => u.special), '<span class="star-mark" aria-hidden="true">★</span>'),
    ...D.tags.map((t) => item(t.id, t.name, n((u) => u.tagIds.includes(t.id)), `<i class="dot" style="--c:${esc(t.color)}"></i>`))
  ].join("")}</div><p class="side-note">标签只存在扩展里，不改 B站</p><hr>${item("gone", "已取消关注", Object.keys(D.gone).length)}${
    D.groups.length
      ? `<hr><div class="side-head">B站 分组</div><div class="folder-list">${D.groups.map((g) => item(`g:${g.id}`, g.name, n((u) => inGroup(u.mid, D, `g:${g.id}`)))).join("")}</div>
  <p class="side-note">只读，在 B站 改</p>`
      : ""
  }${UI.sideFoot({ tagsAttrs: 'data-fw="tags"', settingsAttrs: 'data-fw="settings" aria-label="关注设置"', settingsLabel: "关注设置" })}`;
  sideSlot.innerHTML = sideSelect();
}

// The sync job: while it runs the progress pill (progress, the B站限流 countdown, 暂停) takes 刷新's place, as in 收藏夹.
function renderSync() {
  const j = D.jobs || {};
  const pill = $("fwActivity");
  const btn = $("fwRefreshBtn");
  btn.disabled = Boolean(j.running);
  if (j.running) btn.setAttribute("aria-busy", "true");
  else btn.removeAttribute("aria-busy");
  pill.hidden = !j.running;
  if (!j.running) return;
  const left = j.hold?.until ? Math.ceil(j.hold.until - nowSec()) : 0;
  const wait = left > 0 && `${j.hold.why === "throttled" ? "B站限流" : "网络断了"}，${fmtDur(left)} 后重试`;
  const text = wait || `${j.step || PHASE[j.phase] || "刷新中"}${j.total ? ` ${j.done || 0}/${j.total}` : j.done ? ` ${j.done}` : ""}`;
  pill.classList.toggle("warn", Boolean(wait));
  pill.innerHTML = UI.activityHtml({ text, done: j.done || 0, total: wait ? 0 : j.total || 0, btn: { attrs: "data-fw-stop", label: "暂停" } });
}

// 关注 · N, when the list was read, and the last refresh's error, which stays until a refresh gets through.
function renderHead() {
  const at = D.list?.at || 0;
  const j = D.jobs || {};
  const err = j.running ? "" : j.throttled ? "上次刷新被 B站限流暂停了，再点刷新接着查" : j.error ? `上次刷新出错：${j.error}` : "";
  E.title.innerHTML = UI.titleHtml("关注", D.list ? following().length : null);
  E.meta.innerHTML = UI.headMeta([D.list ? UI.syncedText(at * 1000) : "还没有关注数据"], err);
  renderSync();
}

function renderTabs() {
  const tab = (key, label, n) =>
    `<button type="button" role="tab" data-fwtab="${key}" aria-selected="${F.tab === key}">${label}${n == null ? "" : `<span class="count">${n}</span>`}</button>`;
  E.tabs.innerHTML = tab("ups", "UP 主", following().length) + tab("feed", "动态");
}

// The left column as a select, for widths without the sidebar (in the top bar, see sideSlot).
const sideSelect = () =>
  `<select class="fw-side-select" data-fw="side" aria-label="UP 主标签">${[["all", "全部"], ["untagged", "未打标签"], ["special", "★ 特别关注"], ...D.tags.map((t) => [t.id, t.name]), ...D.groups.map((g) => [`g:${g.id}`, `B站 分组 · ${g.name}`]), ["gone", "已取消关注"]]
    .map(([id, label]) => `<option value="${esc(id)}"${F.side === id ? " selected" : ""}>${esc(label)}</option>`).join("")}</select>`;

// ----- UP 主 -----
function renderUps() {
  const recent = F.recentFilter ? new Set(D.recent?.mids || []) : null;
  const gone = F.side === "gone";
  const { list, counts } = visibleUps(D, rows, { side: F.side, status: gone ? "" : F.status, q: F.q, sort: F.sort, dir: F.dir, recent, source: gone ? F.source : "" });
  shown = list;
  for (const m of [...F.sel]) if (!rows.has(m) || (F.side === "gone") !== Boolean(rows.get(m).gone)) F.sel.delete(m);
  const goneN = (src) => Object.values(D.gone).filter((g) => !src || g.source === src).length;
  const seg = gone
    ? [["", "全部"], ["bili", "在 B站取关"], ["app", "在这里取关"]].map(([id, label]) => UI.filterBtn(`data-source="${id}"`, label, goneN(id), F.source === id)).join("")
    : STATUS.filter(([id]) => id !== "stale" || counts.stale || F.status === "stale") // 待查 exists only while someone is
      .map(([id, label]) => UI.filterBtn(`data-status="${id}"`, label, counts[id] || 0, F.status === id))
      .join("");
  const recentN = (D.recent?.mids || []).filter((m) => rows.has(m) && !rows.get(m).gone).length;
  const recentChip = recentN || F.recentFilter
    ? `<span class="ai-recent"><button type="button" class="chip ai-recent-chip${F.recentFilter ? " on" : ""}" data-fw="recent" aria-pressed="${F.recentFilter}" title="最近一次 AI 打标签改动的 UP 主，在卡片上逐个看，不对的点卡片上的标签改。\n点 ×：不再标出，标签不变。再打一次：换成新的一批。">${AI_SPARK}AI 刚打的 ${recentN}</button><button type="button" class="ai-recent-x" data-fw="recent-done" aria-label="不再标出「AI 刚打的」，标签不变" title="不再标出，标签不变">×</button></span>`
    : "";
  E.bar.innerHTML = D.list || gone ? `<span class="seg" role="group" aria-label="${gone ? "在哪取关" : "更新状态"}">${seg}</span>${gone ? "" : recentChip}` : "";
  E.tools.hidden = !D.list && !gone;
  E.tools.querySelector("[data-fw=ai]").hidden = gone;
  // 全选 is always on offer while nothing is selected, as in 收藏夹; with a selection it moves into the selection bar.
  E.selAll.innerHTML = list.length && !F.sel.size ? `<button type="button" class="link" data-fw="select-all">全选这里的 ${list.length} 个</button>` : "";
  E.sort.hidden = gone || !D.list;
  E.sort.innerHTML = UI.sortControl({ sorts: SORTS, sort: F.sort, dir: F.dir, words: dirLabel(F.sort, F.dir), selectAttr: 'data-fw="sort"', dirAttr: 'data-fw="dir"' });
  E.qCount.textContent = UI.resultCount(F.q, list.length);
  const hint = hintHtml(counts);
  const scroll = E.list.scrollTop;
  let body;
  if (!D.list && F.side !== "gone") body = emptyHtml();
  else if (!list.length) body = `<p class="empty">${F.side === "gone" && !Object.keys(D.gone).length ? "还没取消关注过谁" : F.q.trim() ? "没有匹配搜索的 UP 主" : "没有符合筛选的 UP 主"}</p>`;
  else body = list.map(upCard).join("");
  E.list.className = "fw-list";
  E.list.innerHTML = hint + body;
  E.list.scrollTop = scroll;
  renderSel();
}

function emptyHtml() {
  const j = D.jobs || {};
  const act = j.running ? `<p class="muted" aria-busy="true">刷新中…读完就显示在这里</p>` : `<button type="button" class="primary" data-fw="sync">${UI.ICON.refresh}刷新</button>`;
  return UI.emptyState("还没有关注数据", "先从 B站读你的关注列表，再翻视频动态看谁最近发过视频，动态里没出现的人再一个个查投稿。只读，不改 B站。", act);
}

// Why some 更新状态 are missing, with the job's live state or the button that fills them in.
function hintHtml(counts) {
  if (!D.list || F.side === "gone") return "";
  const parts = [];
  if (D.list.complete === false) parts.push(`<p class="fw-hint warn">这次关注列表没读全，没有把任何人记成取关。下次刷新会再读。</p>`);
  const open = (counts.unchecked || 0) + (counts.stale || 0);
  if (open) {
    const running = D.jobs?.running;
    const stale = counts.stale ? `「待查」= ${cfg.slowDays} 天里没在视频动态出现，查完投稿才分得清慢更还是断更。` : "";
    const act = running ? `<span class="muted" aria-busy="true">正在查，状态边查边更新</span>` : `<button type="button" data-fw="sync">查投稿时间（约 ${Math.max(1, Math.ceil(open / 60))} 分钟）</button>`;
    parts.push(`<p class="fw-hint">${open} 个 UP 主还不知道最后投稿时间。${stale}${act}</p>`);
  }
  return parts.join("");
}

function upCard(mid) {
  const u = rows.get(mid);
  const now = nowSec();
  const sel = F.sel.has(mid);
  const meta = [
    u.closed && "账号已注销",
    u.zone,
    u.last ? `最后投稿 ${fmtAgo(u.last, now)}` : u.status === "stale" && !u.gone ? `${cfg.slowDays} 天以上没投稿` : "",
    u.count && `${u.count} 个视频`,
    u.fans != null ? `粉丝 ${fmtFans(u.fans)}` : F.sort === "fans" && !u.gone ? "粉丝数未查" : "",
    u.gone ? `${u.gone.source === "bili" ? "在 B站取关" : "在这里取关"} · ${fmtAgo(u.gone.at || now, now)}` : u.followed && `关注于 ${fmtDate(u.followed)}`
  ].filter(Boolean);
  const chips = u.tagIds.map(tagOf).map((t) => u.gone
    ? `<span class="chip" style="--c:${esc(t.color)}">${esc(t.name)}</span>`
    : `<button type="button" class="chip card-tag" style="--c:${esc(t.color)}" data-untag="${esc(t.id)}" aria-label="去掉标签 ${esc(t.name)}" title="点一下去掉这个标签">${esc(t.name)}<span class="x" aria-hidden="true">×</span></button>`).join("");
  const titles = u.titles.length
    ? `<ul class="fw-titles">${u.titles.map((v) => `<li>${v.bvid ? `<a class="fw-title" href="${esc(video(v.bvid))}" data-play="${esc(v.bvid)}" title="在右侧播放">${esc(v.t)}</a>` : `<span class="fw-title">${esc(v.t)}</span>`}<span class="meta">${esc(fmtAgo(v.c, now))}</span></li>`).join("")}</ul>`
    : "";
  const right = u.gone
    ? `<button type="button" data-refollow="${esc(mid)}" aria-label="重新关注 ${esc(u.name)}">重新关注</button>`
    : `<button type="button" class="star${u.special ? " on" : ""}" data-star="${esc(mid)}" aria-pressed="${u.special}" title="${u.special ? "取消特别关注" : "设为特别关注"}（改 B站）" aria-label="${u.special ? "取消特别关注" : "设为特别关注"} ${esc(u.name)}">${u.special ? "★" : "☆"}</button>`;
  const playing = F.viewing && u.titles.some((v) => v.bvid === F.viewing);
  return `<article class="card fw-up${sel ? " selected" : ""}${playing ? " playing" : ""}" data-mid="${esc(mid)}" aria-label="${esc(u.name)}">
    <a class="fw-avatar" href="${space(mid)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">${u.face ? `<img src="${esc(img(u.face, "96w_96h_1c"))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</a>
    <div class="card-body">
      <div class="fw-name-row"><a class="fw-name" href="${space(mid)}" target="_blank" rel="noopener" title="在 B站打开空间">${esc(u.name)}</a>${u.gone ? "" : `<span class="badge ${STATUS_BADGE[u.status]}">${STATUS_TEXT[u.status]}</span>`}${u.ov ? `<span class="meta fw-ov" title="${esc(u.ov)}">${esc(u.ov)}</span>` : ""}</div>
      ${meta.length ? `<div class="meta">${meta.map(esc).join(" · ")}</div>` : ""}
      ${u.sign ? `<div class="fw-sign" title="${esc(u.sign)}">${esc(u.sign)}</div>` : ""}
      ${titles}
      <div class="chips fw-foot-row">${chips}${u.gone ? "" : `<button type="button" class="link fw-tag-add" data-pick="${esc(mid)}" aria-label="给 ${esc(u.name)} 打标签">+ 标签</button>`}<span class="more"><button type="button" data-select="${esc(mid)}" class="${sel ? "on" : ""}" aria-pressed="${sel}" aria-label="选中 ${esc(u.name)} (X)">选中<kbd class="key">X</kbd></button></span></div>
    </div>
    <div class="fw-right">${right}</div>
  </article>`;
}

function renderSel() {
  const n = F.sel.size;
  if (F.tab !== "ups" || !n) return (E.sel.innerHTML = "");
  const unselected = shown.filter((m) => !F.sel.has(m)).length;
  const all = unselected ? `<button type="button" class="link" data-fw="select-all">全选这里的 ${shown.length} 个</button>` : "";
  const busy = F.busy ? " disabled" : "";
  const acts = F.side === "gone"
    ? `<button type="button" data-fw="refollow"${busy}>重新关注</button>`
    : `<button type="button" data-fw="pick-sel"${busy}>标签…</button>
       <button type="button" data-fw="ai">${AI_SPARK}AI 打标签</button>
       <button type="button" data-fw="special-on"${busy}>★ 设为特别关注</button>
       <button type="button" data-fw="special-off"${busy}>取消特别关注</button>
       <button type="button" class="danger" data-fw="unfollow"${busy}>取消关注</button>`;
  E.sel.innerHTML = `<div class="selbar" role="toolbar" aria-label="选中的 UP 主"><strong class="sel-count">已选中 ${n} 个</strong>${F.busy ? `<span class="muted" aria-busy="true">${esc(F.busy)}</span>` : ""}<button type="button" class="link" data-fw="select-none">清空选中</button>${all}<span class="sel-actions">${acts}</span></div>`;
}

// ----- 动态 -----
const freshFeed = () => ({ items: [], offset: "", hasMore: true, loading: false, error: "", dry: 0, at: Date.now() });

function renderFeed() {
  if (!F.feed || (!F.feed.loading && Date.now() - F.feed.at > FEED_KEEP_MS)) F.feed = freshFeed();
  const items = F.feed.items;
  const count = (side) => items.filter((it) => feedMatch(it, D, side)).length;
  // No count before the first page arrives.
  const pill = (id, label, color = "") => UI.filterBtn(`data-side="${esc(id)}"`, label, items.length ? count(id) : null, F.side === id, color ? `<i class="dot" style="--c:${esc(color)}"></i>` : "");
  E.tools.hidden = E.sort.hidden = true; // 动态 comes newest first from B站: no sort
  E.bar.innerHTML = `<span class="seg fw-pills" role="group" aria-label="按标签看">${[pill("all", "全部"), pill("untagged", "未打标签"), pill("special", "★ 特别关注"), ...D.tags.map((t) => pill(t.id, t.name, t.color))].join("")}</span>${
    D.groups.length ? `<span class="seg fw-pills fw-groups" role="group" aria-label="按 B站 分组看"><span class="fw-group-label">B站 分组</span>${D.groups.map((g) => pill(`g:${g.id}`, g.name)).join("")}</span>` : ""
  }`;
  const q = F.fq.trim().toLowerCase();
  const list = feedList(items, D, F.side, pick.keep).filter((it) => !q || `${it.title}\n${it.name}`.toLowerCase().includes(q));
  E.qCount.textContent = UI.resultCount(F.fq, list.length);
  const note = !D.tags.length ? `<p class="fw-hint">还没给 UP 主打标签。在「UP 主」页签打上标签，这里就能只看一类 UP 主的新视频。下面是全部关注的新视频。</p>` : "";
  const scroll = E.list.scrollTop;
  E.list.className = "fw-list fw-feed";
  E.list.innerHTML = `${note}<div class="fw-grid">${list.map(feedCard).join("")}</div><div class="fw-foot" id="fwFoot"></div>`;
  E.list.scrollTop = scroll;
  E.sel.innerHTML = "";
  renderFoot(list.length);
  observeFoot();
  if (!items.length && F.feed.hasMore && !F.feed.loading && !F.feed.error) more();
}

const addBtn = (mid, name) =>
  `<button type="button" class="link fw-tag-add" data-pick="${esc(mid)}" aria-label="给 ${esc(name)} 打标签">+ 标签 <kbd class="fw-k" aria-hidden="true">T</kbd></button>`;

// The viewer's second line in 关注: the playing video's UP · its tags · + 标签 (the same picker as the cards).
const vline = document.createElement("div");
vline.id = "fwViewerUp";
vline.className = "fw-vline";
vline.hidden = true;
document.querySelector("#viewer .viewer-head").after(vline);
function renderViewerUp() {
  const mid = F.mode === "follow" && F.viewing ? F.viewingMid : "";
  vline.hidden = !mid;
  if (!mid) return (vline.innerHTML = "");
  const u = rows.get(mid);
  const it = F.feed?.items.find((x) => x.mid === mid);
  const name = upName(mid);
  const face = u?.face || it?.face;
  const ids = u ? u.tagIds : liveTags(mid, D);
  const chips = ids.map(tagOf).map((t) => `<span class="chip" style="--c:${esc(t.color)}"${u?.gone ? "" : ` data-pick="${esc(mid)}"`}>${esc(t.name)}</span>`).join("");
  vline.innerHTML = `${face ? `<img src="${esc(img(face, "48w_48h_1c"))}" alt="" referrerpolicy="no-referrer">` : ""}<a class="name" href="${space(mid)}" target="_blank" rel="noopener">${esc(name)}</a><span class="sep">·</span>${chips || `<span class="none">未打标签</span>`}${u?.gone ? "" : `<span class="sep">·</span>${addBtn(mid, name)}`}`;
}

function feedCard(it) {
  const ids = liveTags(it.mid, D);
  const on = F.viewing === it.bvid;
  const chips = ids.map(tagOf).map((t) => `<span class="chip" style="--c:${esc(t.color)}" data-pick="${esc(it.mid)}">${esc(t.name)}</span>`).join("");
  const target = pick.anchor && pick.mids[0] === it.mid;
  return `<article class="fw-video${on ? " playing" : ""}${target ? " fw-target" : ""}" data-bvid="${esc(it.bvid)}"${on ? ' aria-current="true"' : ""}>
    <a class="cover-wrap" href="${esc(video(it.bvid))}" data-play="${esc(it.bvid)}" tabindex="-1" aria-hidden="true">${it.cover ? `<img class="cover" src="${esc(img(it.cover, "480w_270h_1c"))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}<span class="cover-dur">${it.duration ? esc(fmtDur(it.duration)) : ""}</span></a>
    <div class="fw-video-body">
      <a class="title" href="${esc(video(it.bvid))}" data-play="${esc(it.bvid)}" title="${esc(it.title)}" aria-label="播放 ${esc(it.title)}">${esc(it.title)}</a>
      <div class="meta fw-video-meta"><a class="fw-up-link" href="${space(it.mid)}" target="_blank" rel="noopener">${it.face ? `<img src="${esc(img(it.face, "48w_48h_1c"))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}<span>${esc(it.name)}</span></a><span>${esc(fmtAgo(it.at, nowSec()))}</span>${it.play ? `<span>▶ ${esc(fmtCount(it.play))}</span>` : ""}</div>
      <div class="chips">${chips}${addBtn(it.mid, it.name)}</div>
    </div>
  </article>`;
}

// How far back the feed was read, and the way to read further. 加载更多 is the view's blue button once loading by
// itself stopped (DRY_PAGES pages without a video here).
function renderFoot(n = F.feed.items.filter((it) => feedMatch(it, D, F.side)).length) {
  const foot = $("fwFoot");
  if (!foot) return;
  const f = F.feed;
  const oldest = f.items.length ? Math.min(...f.items.map((it) => it.at)) : 0;
  const where = F.side === "gone" ? "已取消关注的人不在动态里。" : "";
  const reach = oldest ? `已往前看到 ${fmtDate(oldest)}（${fmtAgo(oldest, nowSec())}），共 ${f.items.length} 个视频。` : "";
  let text;
  if (f.error) text = f.error;
  else if (f.loading) text = f.items.length ? `${reach}正在加载更早的…` : "正在读关注的人的新视频…";
  else if (!n && f.items.length) text = `${where || "这里的 UP 主最近没发视频。"}${reach}`;
  else if (!f.hasMore) text = f.items.length ? `${reach}B站只给到这里。` : "关注的人最近都没发视频。";
  else text = reach;
  const stopped = !n || f.dry >= DRY_PAGES;
  const btn = f.error ? `<button type="button" data-fw="more">重试</button>`
    : f.hasMore && !f.loading ? `<button type="button" class="${stopped ? "primary" : ""}" data-fw="more">加载更多</button>` : "";
  foot.innerHTML = `<p${f.loading ? ' aria-busy="true"' : ""}>${esc(text)}</p>${btn}`;
}

let io = null;
function observeFoot() {
  io ||= new IntersectionObserver((entries) => {
    if (F.tab === "feed" && entries.some((e) => e.isIntersecting) && F.feed.dry < DRY_PAGES && !F.feed.error) more();
  }, { root: E.list, rootMargin: "400px 0px" });
  io.disconnect();
  const foot = $("fwFoot");
  if (foot) io.observe(foot);
}

async function more({ byHand = false } = {}) {
  const f = F.feed;
  if (!f.hasMore || f.loading) return;
  if (byHand) f.dry = 0;
  f.loading = true;
  f.error = "";
  renderFoot();
  const r = await send({ type: "follow-feed", offset: f.offset });
  f.loading = false;
  if (F.feed !== f) return;
  if (!r.ok) f.error = r.code === "NOT_LOGGED_IN" ? "没登录 B站，登录后点重试" : r.code === "THROTTLED" ? "被 B站限流了，过一会儿点重试" : `没读到：${r.error || "未知错误"}`;
  else {
    const { items, add } = mergeFeed(f.items, r.data.items || []);
    f.items = items;
    f.offset = r.data.offset || "";
    f.hasMore = Boolean(r.data.hasMore && r.data.offset);
    f.dry = add.some((it) => feedMatch(it, D, F.side)) ? 0 : f.dry + 1;
  }
  if (F.mode === "follow" && F.tab === "feed") renderFeed();
}

function play(bvid) {
  const fed = F.feed?.items.find((x) => x.bvid === bvid);
  const up = !fed && [...rows.values()].find((u) => u.titles.some((v) => v.bvid === bvid));
  const it = fed || up?.titles.find((v) => v.bvid === bvid);
  if (!it) return;
  F.viewing = bvid;
  F.viewingMid = fed?.mid || up?.mid || "";
  T.openViewer({ bvid, title: it.title || it.t });
  render();
  E.list.querySelector(`[data-bvid="${CSS.escape(bvid)}"]`)?.scrollIntoView({ block: "nearest" });
}

// ---------- B站 writes: one UP at a time, stopped by the first error ----------
async function relationRun(mids, label, msg) {
  F.busy = `${label} 0/${mids.length}`;
  renderSel();
  let done = 0;
  try {
    for (const mid of mids) {
      F.busy = `${label} ${done + 1}/${mids.length}`;
      renderSel();
      const r = await send(msg(mid));
      if (!r.ok) throw new Error(r.code === "THROTTLED" ? "被 B站限流了，过一会儿再试" : r.error || "未知错误");
      F.sel.delete(mid);
      done++;
    }
    toast(`已${label} ${done} 个`);
  } catch (e) {
    toast(`${label}第 ${done + 1} 个时出错：${e.message}${done ? `（前 ${done} 个已完成）` : ""}`, true);
  } finally {
    F.busy = "";
    await load();
    render();
  }
}

async function unfollow(mids) {
  if (!mids.length) return;
  const ok = await askConfirm(`在 B站取消关注 ${mids.length} 个 UP 主？`, `<p>${names(mids)}</p><p class="dialog-hint">标签会记着，在「已取消关注」里可以重新关注。</p>`, "取消关注", { danger: true });
  if (ok) await relationRun(mids, "取消关注", (mid) => ({ type: "follow-relation", mid, act: 2 }));
}
async function refollow(mids) {
  if (!mids.length) return;
  const ok = await askConfirm(`在 B站重新关注 ${mids.length} 个 UP 主？`, `<p>${names(mids)}</p><p class="dialog-hint">原来的标签会放回去。</p>`, "重新关注");
  if (ok) await relationRun(mids, "重新关注", (mid) => ({ type: "follow-relation", mid, act: 1 }));
}
// 特别关注 is B站's only group the phone app pushes new videos for.
async function special(mids, on) {
  mids = mids.filter((m) => rows.get(m) && !rows.get(m).gone && rows.get(m).special !== on);
  if (!mids.length) return toast(on ? "选中的都已经是特别关注了" : "选中的都不是特别关注");
  const label = on ? "设为特别关注" : "取消特别关注";
  const why = on ? "特别关注的 UP 主发视频，手机 B站会推送。" : "取消后还关注着，只是不再推送。";
  const ok = await askConfirm(`在 B站把 ${mids.length} 个 UP 主${on ? "设为" : "取消"}特别关注？`, `<p>${names(mids)}</p><p class="dialog-hint">${why}</p>`, label);
  if (ok) await relationRun(mids, label, (mid) => ({ type: "follow-special", mid, on }));
}

// ---------- dialogs ----------
document.body.insertAdjacentHTML("beforeend", `
  <dialog id="fwTagsDialog" class="wide" aria-label="UP 主标签">
    <form method="dialog">
      <div class="ai-review-head">
        <h2>UP 主标签</h2>
        <span class="seg" role="group" aria-label="UP 主标签">
          <button type="button" data-fwmode="manage" aria-pressed="true">管理</button>
          <button type="button" data-fwmode="ai" aria-pressed="false">AI 打标签</button>
        </span>
      </div>
      <section id="fwManage" class="ai-section">
        <p class="dialog-hint">UP 主的标签和收藏夹的视频标签分开，只存在扩展里，不改 B站。改名、颜色、说明和删除立即保存。</p>
        <div id="fwTagRows" class="tag-rows"></div>
        <div class="tag-add">
          <input id="fwNewTag" type="text" maxlength="12" placeholder="新标签名称" aria-label="新标签名称" autocomplete="off">
          <button id="fwAddTag" type="button">添加</button>
        </div>
        <div class="dialog-actions"><span class="spacer"></span><button type="submit" class="primary">完成</button></div>
      </section>
      <section id="fwAiForm" class="ai-section" hidden>
        <p class="dialog-hint">用一句话让 AI 给一批 UP 主打标签。AI 看名字、签名、主要分区和最近的视频标题，只给建议，你点「应用」后才生效。</p>
        <div class="ai-grid">
          <label for="fwAiInstruction">指令</label>
          <textarea id="fwAiInstruction" rows="3" placeholder="例如：按内容分成 科普、游戏、生活，每人只打一个"></textarea>
          <div id="fwAiHistory" class="ai-history"></div>
          <label for="fwAiScope">作用范围</label>
          <select id="fwAiScope"><option value="view">当前筛选</option><option value="sel">选中</option></select>
          <p id="fwAiScopeCount" class="dialog-meta"></p>
          <div id="fwAiTags" class="fw-ai-tags"></div>
          <label class="toggle"><input id="fwAiRemove" type="checkbox" class="switch"> 允许 AI 去掉已有标签</label>
        </div>
        <p id="fwAiProgress" class="dialog-meta" aria-live="polite"></p>
        <div class="dialog-actions">
          <span class="spacer"></span>
          <button type="button" data-fwai="close">关闭</button>
          <button id="fwAiStop" type="button" class="danger" data-fwai="stop" hidden>停止</button>
          <button id="fwAiRun" type="button" class="primary" data-fwai="run">${AI_SPARK}运行</button>
        </div>
      </section>
      <section id="fwAiReview" class="ai-section" hidden>
        <h3>检查 AI 的建议 <span id="fwAiSummary" class="dialog-meta"></span></h3>
        <div id="fwAiNotes"></div>
        <h3 id="fwAiNewHead">新标签</h3>
        <div id="fwAiNew" class="tag-rows"></div>
        <h3>改动汇总</h3>
        <div id="fwAiTally" class="ai-tally"></div>
        <p class="dialog-hint">应用后列表只显示「✦ AI 刚打的」这些 UP 主，在卡片上逐个看，不对的点卡片上的标签改。</p>
        <div class="dialog-actions">
          <span class="spacer"></span>
          <button type="button" data-fwai="discard">放弃</button>
          <button id="fwAiApply" type="button" class="primary" data-fwai="apply">应用</button>
        </div>
      </section>
    </form>
  </dialog>
  <dialog id="fwPickDialog" aria-label="打标签" tabindex="-1">
    <form method="dialog">
      <h2 id="fwPickTitle">打标签</h2>
      <p id="fwPickSrc" class="fw-pop-only dialog-meta"></p>
      <input id="fwPickInput" type="text" maxlength="12" placeholder="输入筛选，或输入新名称后回车新建" aria-label="筛选或新建标签" autocomplete="off">
      <ul id="fwPickList" class="picker-list" role="listbox" aria-label="标签"></ul>
      <p class="dialog-meta fw-modal-only">点一下勾选或去掉，立即保存 · 只存在扩展里，不改 B站</p>
      <p class="fw-pop-only fw-pick-keys"><span><kbd class="fw-k">1</kbd>–<kbd class="fw-k">9</kbd> 勾选</span><span><kbd class="fw-k">T</kbd> 打开</span><span><kbd class="fw-k">Esc</kbd> 关闭</span></p>
      <div class="dialog-actions fw-modal-only"><span class="spacer"></span><button type="submit" class="primary">完成</button></div>
    </form>
  </dialog>`);
const tagsDialog = $("fwTagsDialog");

// ----- 刷新, 导出, 关注设置 -----
const refresh = $("fwRefreshBtn");
refresh.addEventListener("click", async () => {
  refresh.disabled = true;
  const r = await send({ type: "follow-sync" });
  if (!r.ok) {
    toast(r.error || "刷新没开始", true);
    refresh.disabled = false;
  }
});
$("fwActivity").addEventListener("click", (e) => {
  if (e.target.closest("[data-fw-stop]")) send({ type: "follow-sync-stop" });
});
// The UP 主 table: built from what the page already has. 完整备份 is triage.js's ([data-backup]).
function upCsv() {
  const head = ["UP主", "mid", "主页", "标签", "更新状态", "最后投稿", "粉丝数", "关注于", "特别关注", "签名"];
  const out = [head, ...following().map((m) => rows.get(m)).filter(Boolean).map((u) => [u.name, u.mid, space(u.mid), u.tagIds.map((id) => tagOf(id)?.name).filter(Boolean).join("、"), STATUS_TEXT[u.status] || "", u.last ? fmtDate(u.last) : "", u.fans ?? "", u.followed ? fmtDate(u.followed) : "", u.special ? "是" : "", u.sign])];
  return "\ufeff" + out.map((r) => r.map(T.csvField).join(",")).join("\r\n") + "\r\n";
}
$("fwExport").addEventListener("click", (e) => e.target.closest("button") && $("fwExport").hidePopover());
document.body.insertAdjacentHTML("beforeend", `
  <dialog id="fwSettingsDialog" aria-label="关注设置">
    <form method="dialog">
      <h2>关注设置</h2>
      <div class="settings-cols fw-settings-cols">
        <section class="set-group">
          <h3>更新状态</h3>
          <p class="dialog-hint">按最后投稿离现在多少天分活跃、慢更、断更。</p>
          <div class="set-card">
            <div class="set-row"><div><label class="name" for="fwSlowInput">多少天没投稿算慢更</label><p class="hint">7–3650。刷新时视频动态往回翻这么多天，越大翻得越久。</p></div><input id="fwSlowInput" type="number" min="7" max="3650" step="1"></div>
            <div class="set-row"><div><label class="name" for="fwDeadInput">多少天没投稿算断更</label><p class="hint">要比慢更的天数大。</p></div><input id="fwDeadInput" type="number" min="8" max="3651" step="1"></div>
          </div>
        </section>
        <section class="set-group">
          <h3>AI 打标签</h3>
          <div class="set-card">
            <div class="set-row"><div><label class="name" for="fwBatchInput">每批数量</label><p class="hint">1–100 个 UP 主一批。</p></div><input id="fwBatchInput" type="number" min="1" max="100" step="1"></div>
            <div class="set-row" data-set-row="interval"><input id="fwIntervalInput" type="number" min="0" max="600" step="1"></div>
            <div class="set-row" data-set-row="newTagMax"><input id="fwNewMaxInput" type="number" min="0" max="50" step="1"></div>
            <div class="set-row" data-set-row="allowRemove"><input id="fwRemoveInput" type="checkbox" class="switch"></div>
          </div>
        </section>
      </div>
      <p id="fwSettingsError" class="form-error" role="alert" hidden></p>
      <div class="dialog-actions">
        <button type="button" class="link" data-open-options aria-label="打开设置页">打开设置页</button>
        <span class="spacer"></span>
        <button value="cancel" type="submit" formnovalidate aria-label="取消">取消</button>
        <button value="save" type="submit" class="primary" aria-label="保存设置">保存</button>
      </div>
    </form>
  </dialog>`);
const settingsDialog = $("fwSettingsDialog");
UI.fillSetRows(settingsDialog);
settingsDialog.querySelector("[data-open-options]").addEventListener("click", () => send({ type: "open-options" }));

// follow_ai_settings, seeded from the 收藏夹 values on first use and stored then.
async function aiSettings() {
  const own = (await chrome.storage.sync.get("follow_ai_settings")).follow_ai_settings;
  const triage = own ? null : await send({ type: "triage-settings-get" });
  const { value, seed } = followAiSettings(own, triage?.ok ? triage.data : null);
  if (seed) await chrome.storage.sync.set({ follow_ai_settings: seed });
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
  await chrome.storage.sync.set({ follow_ai_settings: ai, ...days });
  if (!AI.running) AI.settings = ai;
  cfg.slowDays = days.followSlowDays;
  cfg.deadDays = days.followDeadDays;
  if (F.loaded) derive();
  render();
  toast("设置已保存");
});
const pickDialog = $("fwPickDialog");

// ----- 管理 -----
function openTags(mode) {
  showTagsMode(mode);
  tagsDialog.showModal();
  if (mode === "manage") $("fwNewTag").focus();
}
function showTagsMode(mode) {
  for (const b of tagsDialog.querySelectorAll("[data-fwmode]")) b.setAttribute("aria-pressed", String(b.dataset.fwmode === mode));
  $("fwManage").hidden = mode !== "manage";
  $("fwAiForm").hidden = mode !== "ai" || Boolean(AI.proposal && !AI.running);
  $("fwAiReview").hidden = mode !== "ai" || !AI.proposal || AI.running;
  if (mode === "manage") renderTagRows();
  else if (AI.proposal && !AI.running) renderAiReview();
  else renderAiForm();
}
function renderTagRows() {
  const counts = {};
  for (const m of following()) for (const id of rows.get(m)?.tagIds || []) counts[id] = (counts[id] || 0) + 1;
  $("fwTagRows").innerHTML = D.tags.length
    ? D.tags.map((t) => `<div class="tag-row fw-tag-row" data-id="${esc(t.id)}">
        <button type="button" class="fw-color" style="--c:${esc(t.color)}" data-color title="换一个颜色" aria-label="换 ${esc(t.name)} 的颜色"></button>
        <input type="text" value="${esc(t.name)}" data-field="name" maxlength="12" aria-label="标签名称">
        <input type="text" value="${esc(t.rule || "")}" data-field="rule" maxlength="80" placeholder="什么样的 UP 主打这个标签（给 AI 看，可不写）" aria-label="${esc(t.name)} 的说明">
        <span class="muted">${counts[t.id] || 0} 个 UP 主</span>
        <button type="button" class="danger" data-del aria-label="删除标签 ${esc(t.name)}">删除</button>
      </div>`).join("")
    : `<p class="muted">还没有 UP 主标签</p>`;
}
async function addTag(name) {
  name = cleanName(name);
  if (!name) return null;
  const old = D.tags.find((t) => t.name === name);
  if (old) return old;
  const t = newTag(name);
  await saveTags([...D.tags, t]);
  return t;
}
async function editTag(id, field, value) {
  const t = { ...tagOf(id) };
  if (field === "name") {
    const name = cleanName(value);
    if (!name || D.tags.some((x) => x.id !== id && x.name === name)) {
      toast(name ? "已有同名标签" : "标签名不能为空", true);
      return renderTagRows();
    }
    t.name = name;
  } else if (field === "rule") t.rule = String(value || "").trim().slice(0, 80);
  else if (field === "color") t.color = TAG_COLORS[(TAG_COLORS.indexOf(t.color) + 1) % TAG_COLORS.length];
  await saveTags(D.tags.map((x) => (x.id === id ? t : x)));
  renderTagRows();
  render();
}
async function deleteTag(id) {
  const t = tagOf(id);
  const n = following().filter((m) => rows.get(m)?.tagIds.includes(id)).length;
  // The confirm dialog is a second modal; the tag dialog stays open under it.
  if (!(await askConfirm(`删除标签「${t.name}」？`, `<p>将从 ${n} 个 UP 主上去掉这个标签，无法撤销。</p>`, "删除", { danger: true }))) return;
  const map = {};
  for (const [m, ids] of Object.entries(D.map)) {
    const rest = ids.filter((x) => x !== id);
    if (rest.length) map[m] = rest;
  }
  await setTagMap(map);
  await saveTags(D.tags.filter((x) => x.id !== id));
  if (F.side === id) F.side = "all";
  renderTagRows();
  render();
}

// ----- 打标签 (one UP from its card, or the selection) -----
// The same picker two ways: a modal for the UP 主 cards and the selection; anchored to an element (the 动态 card's or
// the viewer line's 「+ 标签」, a CSS selector so it survives redraws) it is a small popover: 1–9 tick, Esc or a click
// outside closes. While the popover is open, pick.keep holds the cards it was opened over (see feedList).
const pick = { mids: [], anchor: "", keep: null, typing: false };
function openPick(mids, anchor = "") {
  closePick();
  if (anchor && rows.get(mids[0])?.gone) return;
  pick.mids = mids;
  pick.anchor = anchor;
  pick.typing = false;
  pick.keep = anchor && F.feed ? new Set(feedList(F.feed.items, D, F.side, null).filter((it) => it.mid === mids[0]).map((it) => it.bvid)) : null;
  $("fwPickTitle").textContent = mids.length === 1 ? `给「${upName(mids[0])}」打标签` : `给选中的 ${mids.length} 个 UP 主打标签`;
  $("fwPickInput").value = "";
  pickDialog.classList.toggle("fw-pop", Boolean(anchor));
  renderPick();
  if (!anchor) {
    pickDialog.showModal();
    return $("fwPickInput").focus();
  }
  const n = pick.keep?.size || 0;
  $("fwPickSrc").textContent = n ? `这里有 TA 的 ${n} 个视频` : "";
  pickDialog.show();
  placePick();
  pickDialog.focus(); // also takes the keys back from the player's frame
  render();
}
// Closes either way; for the popover, the cards that no longer match the filter leave now.
function closePick() {
  if (!pick.anchor) return pickDialog.open && pickDialog.close();
  const { keep, mids } = pick;
  pick.anchor = "";
  pick.keep = null;
  pickDialog.close();
  if (F.mode !== "follow") return;
  render();
  const left = F.tab === "feed" && F.feed ? feedLeaving(F.feed.items, D, F.side, keep).length : 0;
  if (left) toast(`「${upName(mids[0])}」的 ${left} 个视频已移出「${sideName(F.side)}」`);
}
const sideName = (id) => ({ all: "全部", untagged: "未打标签", special: "特别关注", gone: "已取消关注" })[id] || tagOf(id)?.name || "";
function placePick() {
  const r = (document.querySelector(pick.anchor) || E.list).getBoundingClientRect();
  const w = pickDialog.offsetWidth;
  const h = pickDialog.offsetHeight;
  let y = r.bottom + 6;
  if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 6);
  pickDialog.style.left = `${Math.min(Math.max(8, r.left), innerWidth - w - 8)}px`;
  pickDialog.style.top = `${y}px`;
}
function renderPick() {
  const pop = Boolean(pick.anchor);
  const q = cleanName($("fwPickInput").value);
  $("fwPickInput").hidden = pop && !pick.typing;
  const list = D.tags.filter((t) => !q || t.name.includes(q));
  const have = (t) => pick.mids.filter((m) => (D.map[m] || []).includes(t.id)).length;
  const create = q && !D.tags.some((t) => t.name === q)
    ? `<li class="picker-opt" role="option" data-new="${esc(q)}"><span class="check">+</span>新建「${esc(q)}」</li>`
    : pop && !pick.typing ? `<li class="picker-opt fw-pick-new" role="option" data-typing><span class="check">+</span>新建标签</li>` : "";
  $("fwPickList").innerHTML = list.map((t, i) => {
    const n = have(t);
    const mark = n === pick.mids.length ? "✓" : n ? "–" : "";
    const key = pop && !q && i < 9 ? `<span class="n">${i + 1}</span>` : "";
    return `<li class="picker-opt" role="option" data-id="${esc(t.id)}" aria-selected="${n === pick.mids.length}"><span class="check">${mark}</span><span class="dot" style="--c:${esc(t.color)}"></span>${esc(t.name)}${pick.mids.length > 1 && n ? `<span class="muted">${n} 个有</span>` : ""}${key}</li>`;
  }).join("") + create || `<li class="muted">还没有标签，输入名称后回车新建</li>`;
}
async function togglePick(id) {
  await setTagMap(pickToggle(D.map, pick.mids, id));
  renderPick();
  render();
}

// T: the UP of the 动态 card under the mouse, otherwise of the video playing in the viewer.
function tagByKey() {
  const it = F.tab === "feed" && F.hover && F.feed?.items.find((x) => x.bvid === F.hover);
  if (it) openPick([it.mid], `.fw-video[data-bvid="${CSS.escape(it.bvid)}"] .fw-tag-add`);
  else if (F.viewing && F.viewingMid && !rows.get(F.viewingMid)?.gone) openPick([F.viewingMid], "#fwViewerUp .fw-tag-add");
}
// A modal dialog (confirm, settings, the modal picker) owns the keys; the popover does not.
const modalOpen = () => Boolean(document.querySelector("dialog[open]:not(.fw-pop)"));
function followKey(key) {
  if (key === "Escape" && pick.anchor) closePick();
  else if (key === "Escape" && T.viewing() && !modalOpen()) T.closeViewer();
  else if (key === "t" && !modalOpen()) tagByKey();
  else if (/^[1-9]$/.test(key) && pick.anchor && D.tags[key - 1]) togglePick(D.tags[key - 1].id);
  else return false;
  return true;
}

// ----- AI 打标签: the folder view's 批量打 flow, one UP per line -----
const AI = { running: false, stop: false, proposal: null, excluded: new Set(), settings: {}, history: [] };

function aiScopeMids(scope = $("fwAiScope").value) {
  const live = new Set(following());
  return (scope === "sel" ? [...F.sel] : F.side === "gone" ? [] : [...shown]).filter((m) => live.has(m));
}
async function loadAi() {
  AI.settings = await aiSettings();
  AI.history = (await chrome.storage.local.get(AI_HISTORY_KEY))[AI_HISTORY_KEY] || [];
  AI.excluded.clear();
  $("fwAiScope").value = F.sel.size ? "sel" : "view";
  $("fwAiRemove").checked = AI.settings.allowRemove;
}
async function openAi() {
  if (!AI.running) await loadAi();
  openTags("ai");
}
function renderAiForm() {
  const counts = { view: aiScopeMids("view").length, sel: aiScopeMids("sel").length };
  for (const o of $("fwAiScope").options) {
    o.textContent = `${o.value === "sel" ? "选中" : "当前筛选"} · ${counts[o.value]} 个`;
    o.disabled = !counts[o.value];
  }
  if ($("fwAiScope").selectedOptions[0]?.disabled) $("fwAiScope").value = counts.view ? "view" : "sel";
  const mids = aiScopeMids();
  const size = AI.settings.batchSize;
  const bare = mids.filter((m) => !rows.get(m)?.titles.length && !rows.get(m)?.zone).length;
  $("fwAiScopeCount").textContent = mids.length
    ? `${mids.length} 个 UP 主${bare ? `，其中 ${bare} 个还没查投稿，AI 只能看名字和签名` : ""}。分 ${Math.ceil(mids.length / size)} 批发送`
    : "作用范围里没有 UP 主";
  const max = AI.settings.newTagMax;
  const roomHint = `${max ? `AI 这次最多新建 ${max} 个标签，你确认后才创建。` : "AI 只会用已有标签。"}<br>每批数量、间隔和新建上限在左下角的「关注设置」里改。`;
  const useChip = (t) => {
    const on = !AI.excluded.has(t.id);
    return `<button type="button" class="chip tag-use${on ? " on" : ""}" style="--c:${esc(t.color)}" data-use="${esc(t.id)}" aria-pressed="${on}" title="${on ? "点一下：这次不让 AI 用" : "点一下：让 AI 用"}">${esc(t.name)}</button>`;
  };
  $("fwAiTags").innerHTML = D.tags.length
    ? `<span class="grid-label">可用标签</span><div class="chips">${D.tags.map(useChip).join("")}</div><p class="dialog-meta">点掉的标签这次不给 AI 用。<br>${roomHint}</p>`
    : `<p class="dialog-hint">还没有 UP 主标签。${roomHint}想打得准，先在<button type="button" class="link" data-fwmode="manage">「管理」</button>里建好标签、每个写一句说明。</p>`;
  $("fwAiHistory").innerHTML = AI.history.length
    ? `<span class="muted">最近：</span>${AI.history.map((h, i) => `<button type="button" class="chip" data-h="${i}" title="${esc(h)}">${esc(h.length > 18 ? `${h.slice(0, 18)}…` : h)}</button>`).join("")}`
    : "";
  const run = $("fwAiRun");
  run.disabled = AI.running;
  run.innerHTML = AI.running ? "运行中…" : `${AI_SPARK}运行`;
  if (AI.running) run.setAttribute("aria-busy", "true");
  else run.removeAttribute("aria-busy");
  $("fwAiStop").hidden = !AI.running;
}

async function runAi() {
  if (AI.running) return;
  const instruction = $("fwAiInstruction").value.trim();
  const mids = aiScopeMids();
  const progress = $("fwAiProgress");
  if (!instruction) {
    progress.textContent = "请先写指令";
    return $("fwAiInstruction").focus();
  }
  if (!mids.length) return (progress.textContent = "作用范围里没有 UP 主");
  AI.history = [instruction, ...AI.history.filter((x) => x !== instruction)].slice(0, 5);
  chrome.storage.local.set({ [AI_HISTORY_KEY]: AI.history });
  const excluded = new Set(D.tags.filter((t) => AI.excluded.has(t.id)).map((t) => t.name));
  const tags = D.tags.filter((t) => !excluded.has(t.name)).map((t) => ({ name: t.name, rule: t.rule || "" }));
  const opts = { tags: D.tags, map: D.map, maxNewTags: AI.settings.newTagMax, excluded, scope: new Set(mids) };
  const { batches, intervalMs } = aiRequests(mids, AI.settings, instruction, tags, $("fwAiRemove").checked);
  const total = batches.length;
  const p = { newTags: [], rows: [], notes: [], errors: [] };
  AI.running = true;
  AI.stop = false;
  renderAiForm();
  for (let i = 0; i < total && !AI.stop; i++) {
    progress.textContent = `AI 正在处理第 ${i + 1} / ${total} 批…`;
    const r = await send({ ...batches[i], maxNewTags: Math.max(0, opts.maxNewTags - p.newTags.length) });
    if (!r.ok) {
      p.errors.push(`第 ${i + 1} 批失败：${r.error}`);
      if (/配置 AI|未授权访问/.test(r.error || "")) break;
    } else mergeAiBatch(p, r.data, opts);
    if (i + 1 < total) {
      const end = Date.now() + intervalMs;
      while (Date.now() < end && !AI.stop) await new Promise((res) => setTimeout(res, 200));
    }
  }
  if (AI.stop) p.errors.push("已手动停止，这里只有已完成批次的建议");
  for (const t of p.newTags) t.checked = p.rows.some((r) => r.add.includes(`new:${t.key}`));
  AI.running = false;
  AI.proposal = p;
  progress.textContent = "";
  if (tagsDialog.open) showTagsMode("ai");
  else toast("AI 打标签完成，点「AI 打标签」查看建议");
}

const previewId = (p, key) => {
  const name = p.newTags.find((t) => t.key === key)?.name.trim();
  return name && (D.tags.find((t) => t.name === name)?.id || `new:${key}`);
};
const changesNow = (p) => aiChanges(p, D.map, new Set(following()), (key) => previewId(p, key));

function renderAiReview() {
  const p = AI.proposal;
  $("fwAiNotes").innerHTML = p.errors.map((e) => `<p class="fail-text">${esc(e)}</p>`).join("") + p.notes.map((n) => `<p class="muted">AI 说明：${esc(n)}</p>`).join("");
  const uses = (t) => p.rows.filter((r) => r.add.includes(`new:${t.key}`)).length;
  $("fwAiNewHead").hidden = !p.newTags.length;
  $("fwAiNew").innerHTML = p.newTags.map((t, i) => `<div class="ai-newtag" data-i="${i}">
      <input type="checkbox" data-nt="checked"${t.checked ? " checked" : ""} aria-label="创建标签 ${esc(t.name)}">
      <input type="text" data-nt="name" value="${esc(t.name)}" maxlength="12" aria-label="新标签名称">
      <span class="muted">${uses(t) ? `用在 ${uses(t)} 个 UP 主` : "没有 UP 主用到"}</span>
    </div>`).join("");
  renderAiTally();
}
function renderAiTally() {
  const p = AI.proposal;
  const changes = changesNow(p);
  const newN = p.newTags.filter((t) => t.checked && t.name.trim()).length;
  $("fwAiSummary").textContent = `· ${changes.length} 个 UP 主有改动 · 新标签 ${newN} 个 · 点「应用」前不会改动任何东西`;
  const name = (id) => (id.startsWith("new:") ? p.newTags.find((t) => t.key === id.slice(4))?.name.trim() : tagOf(id)?.name) || "";
  const tally = aiTally(changes, name);
  $("fwAiTally").innerHTML = tally.length
    ? `<div class="chips">${tally.map((t) => `<span class="chip ${t.cls}">${esc(t.text)} <b>${t.n}</b></span>`).join("")}</div>`
    : `<p class="empty">AI 没有提出改动</p>`;
  const apply = $("fwAiApply");
  apply.textContent = changes.length ? `应用到 ${changes.length} 个 UP 主` : "应用";
  apply.disabled = !changes.length && !newN;
}
async function applyAi() {
  const p = AI.proposal;
  if (!p) return;
  const idFor = {};
  for (const t of p.newTags) if (t.checked && t.name.trim()) idFor[t.key] = (await addTag(t.name))?.id;
  const changes = aiChanges(p, D.map, new Set(following()), (key) => idFor[key]);
  const map = { ...D.map };
  for (const [mid, , after] of changes) {
    if (after.length) map[mid] = after;
    else delete map[mid];
  }
  AI.proposal = null;
  // This batch replaces the last one; the list shows it to look over.
  const recent = changes.length ? { at: Date.now(), mids: changes.map(([mid]) => mid) } : D.recent;
  D.recent = recent;
  F.recentFilter = Boolean(changes.length);
  await setTagMap(map);
  if (changes.length) await write({ follow_ai_recent: recent });
  tagsDialog.close();
  render();
  toast(`已应用 AI 建议：${changes.length} 个 UP 主，列表只显示这些`);
}

// ---------- events ----------
document.getElementById("modeSwitch").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode]");
  if (b) setMode(b.dataset.mode);
});

side.addEventListener("click", (e) => {
  const s = e.target.closest("[data-side]");
  if (s) return pickSide(s.dataset.side);
  if (e.target.closest("[data-fw=tags]")) openTags("manage");
  else if (e.target.closest("[data-fw=settings]")) openSettings();
});
sideSlot.addEventListener("change", (e) => e.target.dataset.fw === "side" && pickSide(e.target.value));
function pickSide(id) {
  if (id === F.side) return;
  F.side = id;
  F.sel.clear();
  if (F.feed) F.feed.dry = 0;
  render();
  E.list.scrollTop = 0;
}

main.addEventListener("click", async (e) => {
  const t = e.target;
  const tab = t.closest("[data-fwtab]");
  if (tab) return setTab(tab.dataset.fwtab);
  const s = t.closest("[data-side]");
  if (s) return pickSide(s.dataset.side);
  const st = t.closest("[data-status]");
  if (st) {
    F.status = st.dataset.status;
    return render();
  }
  const src = t.closest("[data-source]");
  if (src) {
    F.source = src.dataset.source;
    return render();
  }
  const playBtn = t.closest("[data-play]");
  if (playBtn) {
    if (!plainClick(e)) return;
    e.preventDefault();
    return play(playBtn.dataset.play);
  }
  const untag = t.closest("[data-untag]");
  if (untag) {
    await changeTags([untag.closest("[data-mid]").dataset.mid], [], [untag.dataset.untag]);
    return render();
  }
  const pk = t.closest("[data-pick]");
  if (pk) {
    const card = pk.closest(".fw-video");
    return openPick([pk.dataset.pick], card ? `.fw-video[data-bvid="${CSS.escape(card.dataset.bvid)}"] .fw-tag-add` : "");
  }
  const sel = t.closest("[data-select]");
  if (sel) {
    const mid = sel.dataset.select;
    if (F.sel.has(mid)) F.sel.delete(mid);
    else F.sel.add(mid);
    sel.closest(".card").classList.toggle("selected", F.sel.has(mid));
    sel.classList.toggle("on", F.sel.has(mid));
    sel.setAttribute("aria-pressed", String(F.sel.has(mid)));
    return renderSel();
  }
  const star = t.closest("[data-star]");
  if (star) return F.busy ? toast("上一批还没做完") : special([star.dataset.star], !rows.get(star.dataset.star).special);
  const re = t.closest("[data-refollow]");
  if (re) return F.busy ? toast("上一批还没做完") : refollow([re.dataset.refollow]);
  const act = t.closest("[data-fw]")?.dataset.fw;
  if (!act || t.closest("select")) return;
  if (act === "sync") {
    t.closest("button").disabled = true;
    const r = await send({ type: "follow-sync" });
    if (!r.ok) {
      toast(r.error || "刷新没开始", true);
      t.closest("button").disabled = false;
    }
  } else if (act === "dir") {
    F.dir = F.dir === "asc" ? "desc" : "asc";
    saveView();
    render();
  } else if (act === "ai") openAi();
  else if (act === "settings") openSettings();
  else if (act === "bili") window.open("https://space.bilibili.com/", "_blank", "noopener");
  else if (act === "csv") BocDownload.text(`MoonDigest-关注-${fmtDate(nowSec())}.csv`, upCsv(), "text/csv;charset=utf-8");
  else if (act === "recent") {
    F.recentFilter = !F.recentFilter;
    render();
  } else if (act === "recent-done") {
    F.recentFilter = false;
    D.recent = null;
    await chrome.storage.local.remove("follow_ai_recent");
    render();
  } else if (act === "more") more({ byHand: true });
  else if (act === "select-all") {
    shown.forEach((m) => F.sel.add(m));
    render();
  } else if (act === "select-none") {
    F.sel.clear();
    render();
  } else if (F.busy) toast("上一批还没做完");
  else if (act === "pick-sel") openPick([...F.sel]);
  else if (act === "unfollow") unfollow([...F.sel]);
  else if (act === "refollow") refollow([...F.sel]);
  else if (act === "special-on" || act === "special-off") special([...F.sel], act === "special-on");
});
// The selection bar sits outside the list; its buttons share the handler above through #followMain.

// One box, two searches: UP 主 and 动态 each keep their own text (setTab swaps it in).
T.bindSearch(E.q, (q) => {
  if (F.tab === "feed") F.fq = q;
  else F.q = q;
  render();
});
main.addEventListener("change", (e) => {
  const act = e.target.dataset.fw;
  if (act === "sort") {
    F.sort = e.target.value;
    F.dir = SORT_DIR[F.sort];
    saveView();
    render();
  } else if (act === "side") pickSide(e.target.value);
});

tagsDialog.addEventListener("click", async (e) => {
  const t = e.target;
  const mode = t.closest("[data-fwmode]");
  if (mode) {
    if (mode.dataset.fwmode === "ai" && !AI.running) await loadAi();
    return showTagsMode(mode.dataset.fwmode);
  }
  const row = t.closest(".fw-tag-row");
  if (row && t.closest("[data-color]")) return editTag(row.dataset.id, "color");
  if (row && t.closest("[data-del]")) return deleteTag(row.dataset.id);
  if (t.closest("#fwAddTag")) {
    const input = $("fwNewTag");
    if (cleanName(input.value) && D.tags.some((x) => x.name === cleanName(input.value))) return toast("已有同名标签", true);
    if (await addTag(input.value)) {
      input.value = "";
      renderTagRows();
      render();
    }
    return;
  }
  const use = t.closest("[data-use]");
  if (use) {
    if (AI.excluded.has(use.dataset.use)) AI.excluded.delete(use.dataset.use);
    else AI.excluded.add(use.dataset.use);
    return renderAiForm();
  }
  const h = t.closest("[data-h]");
  if (h) {
    $("fwAiInstruction").value = AI.history[Number(h.dataset.h)] || "";
    return $("fwAiInstruction").focus();
  }
  const ai = t.closest("[data-fwai]")?.dataset.fwai;
  if (ai === "run") runAi();
  else if (ai === "stop") AI.stop = true;
  else if (ai === "close") tagsDialog.close();
  else if (ai === "discard") {
    AI.proposal = null;
    showTagsMode("ai");
  } else if (ai === "apply") applyAi();
});
tagsDialog.addEventListener("change", (e) => {
  const t = e.target;
  const row = t.closest(".fw-tag-row");
  if (row && t.dataset.field) return editTag(row.dataset.id, t.dataset.field, t.value);
  if (t.id === "fwAiScope") return renderAiForm();
  const nt = t.closest(".ai-newtag");
  if (nt && AI.proposal) {
    const tag = AI.proposal.newTags[Number(nt.dataset.i)];
    if (t.dataset.nt === "checked") tag.checked = t.checked;
    else tag.name = cleanName(t.value);
    renderAiTally();
  }
});
tagsDialog.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "fwNewTag" && !e.isComposing) {
    e.preventDefault();
    $("fwAddTag").click();
  }
  if (e.key === "Enter" && e.target.matches?.(".fw-tag-row input") && !e.isComposing) e.preventDefault();
});

pickDialog.addEventListener("click", async (e) => {
  const opt = e.target.closest(".picker-opt");
  if (!opt) return;
  if ("typing" in opt.dataset) {
    pick.typing = true;
    renderPick();
    placePick();
    return $("fwPickInput").focus();
  }
  if (opt.dataset.new) {
    const tag = await addTag(opt.dataset.new);
    $("fwPickInput").value = "";
    pick.typing = false;
    if (tag) await togglePick(tag.id);
    if (pick.anchor) pickDialog.focus();
  } else await togglePick(opt.dataset.id);
});
vline.addEventListener("click", (e) => {
  const pk = e.target.closest("[data-pick]");
  if (pk) openPick([pk.dataset.pick], "#fwViewerUp .fw-tag-add");
});
// The popover: Esc and 1–9 (before triage.js's keys), a click outside or into the player closes it.
document.addEventListener("keydown", (e) => {
  if (F.mode !== "follow" || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
  if ((key === "Escape" ? pick.anchor : !typing && key !== "Escape") && followKey(key)) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);
window.addEventListener("message", (e) => {
  const key = fromViewer(e, $("viewerFrame").contentWindow);
  if (key && F.mode === "follow") followKey(key);
});
document.addEventListener("click", (e) => {
  if (pick.anchor && !pickDialog.contains(e.target) && !e.target.closest("[data-pick]")) closePick();
}, true);
window.addEventListener("blur", () => pick.anchor && closePick());
addEventListener("resize", () => pick.anchor && placePick());
E.list.addEventListener("mouseover", (e) => (F.hover = e.target.closest(".fw-video")?.dataset.bvid || ""));
E.list.addEventListener("mouseleave", () => (F.hover = ""));
$("fwPickInput").addEventListener("input", renderPick);
$("fwPickInput").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  e.preventDefault();
  const first = $("fwPickList").querySelector(".picker-opt");
  if (first) first.click();
});

// Storage: follow_jobs ticks often while a sync runs, so it redraws only the head and hint; data changes redraw all,
// at most once a second.
let redrawTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes.followSlowDays || changes.followDeadDays)) {
    cfg.slowDays = changes.followSlowDays?.newValue ?? cfg.slowDays;
    cfg.deadDays = changes.followDeadDays?.newValue ?? cfg.deadDays;
    if (F.loaded) derive();
    return render();
  }
  if (area !== "local" || !F.loaded) return;
  const keys = Object.keys(changes).filter((k) => KEYS.includes(k));
  if (!keys.length) return;
  if (keys.every((k) => k === "follow_jobs")) {
    D.jobs = changes.follow_jobs.newValue || {};
    if (F.mode === "follow") renderHead();
    if (F.mode === "follow" && F.tab === "ups" && !D.list) renderUps();
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

// Leaving the viewer (×, Esc, the tab button) clears the playing mark.
new MutationObserver(() => {
  if (F.viewing && !T.viewing()) {
    F.viewing = "";
    if (F.mode === "follow") render();
  }
}).observe($("viewer"), { attributes: true, attributeFilter: ["hidden"] });

const [{ [VIEW_KEY]: view }, days] = await Promise.all([
  chrome.storage.local.get(VIEW_KEY),
  chrome.storage.sync.get({ followSlowDays: 90, followDeadDays: 365 })
]);
cfg.slowDays = Number(days.followSlowDays) || 90;
cfg.deadDays = Number(days.followDeadDays) || 365;
if (view?.tab === "feed") F.tab = "feed";
if (SORTS[view?.sort]) F.sort = view.sort;
if (view?.dir === "asc" || view?.dir === "desc") F.dir = view.dir;
// Deep link from the UP tag chips on B站 pages: #follow opens 关注, &tag=<id> picks that tag (unknown id → 全部).
// A hash wins over the remembered mode; an open tab only gets its hash changed.
async function followHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (!/^follow(&|$)/.test(h)) return false;
  const tag = new URLSearchParams(h.slice(6)).get("tag");
  if (tag) {
    F.side = tag;
    F.sel.clear();
  }
  if (F.mode !== "follow") await setMode("follow");
  derive();
  render();
  return true;
}
window.addEventListener("hashchange", followHash);
if (!(await followHash()) && view?.mode === "follow") setMode("follow", false);
