// MoonDigest 关注分拣台 background 层。classic script，background.js 在 triage-bg.js 之后 importScripts，共享全局作用域，
// 顶层名字统一带 follow / FOLLOW_ 前缀。B站 请求走 triage-bg.js 的 triageBiliGetJson / triageBiliPost，WBI 用 sites.js。
//
// 消息（回复 { ok: true, data } 或 { ok: false, error, code? }；code: THROTTLED / NETWORK / NOT_LOGGED_IN）。时间都是秒，mid 都是字符串。
// - follow-sync {}            开始或接着跑同步，立即返回 {}；进度在 storage follow_jobs。
// - follow-sync-stop {}       停下；再发 follow-sync 从游标接着跑。
// - follow-feed { offset }    一页视频动态 { items: [{ bvid, aid, title, cover, duration, play, mid, name, face, at }], offset, hasMore }，缓存 3 分钟。
// - follow-relation { mid, act, gone? }  1 关注 / 2 取关，成功后改好 follow_list、follow_unfollowed、follow_tag_map；gone = 撤销重新关注时放回的取关记录。
//                             取关记录存当时的分组；重新关注时放回还在的那些 → { groups, groupsError }（没放回不算失败）。
// - follow-group-move { mids, from, to }  关注分组：from 为空是复制到 to（copyUsers），否则从 from 移到 to（moveUsers）。
//                             -10 是特别关注，0 是默认分组。成功后改好 follow_list.special / groups。
//                             整批被拒时逐个再发，→ { skipped: [{ mid, error }] } 是 B站 不收的（如已注销）；全被拒才报错。
// - follow-forget { mids }    清理：删掉这些人的已取消关注记录（连同记录里的标签），不改 B站。
// - follow-group-create { name } → { id, name }；follow-group-rename { id, name }；follow-group-delete { id }
//                             新建、改名、删除 B站 的关注分组，成功后改好 follow_groups（删除时成员的 groups 也去掉它）。
// - follow-ai-tag { instruction, mids, tags, maxNewTags, allowRemove, scope }
//                             tags、新建上限和能否去掉标签都由页面按「关注设置」和弹窗给出。提案 { newTags, assignments: { mid: { add, remove } }, note }，不写任何东西。
//
// 同步分三步，每步做完记进 follow_jobs.cursor；跑着时开 1 分钟的 follow-keepalive 闹钟，worker 被杀后由它叫醒、从游标接着跑：
// 1 list：拉我的全部关注 → follow_list / follow_people；和上次比，消失的人进 follow_unfollowed（source "bili"），只在拉全时判断。
//   第一次同步每拉一页就先写进 follow_list（partial: true），界面不用等拉完。
// 2 feed：视频动态往回翻过 followSlowDays 天 → follow_last（谁最近发过、最近 3 个标题），翻完才写，翻到一半的每页存进 follow_last_wip，界面边翻边读。6 小时内翻过就跳过。
// 3 arc：动态里没出现的人逐个 arc/search（约 1 秒 1 个）→ follow_content；已有记录且不早于 follow_last.since 的跳过。
//   一个视频都没有的再查 x/space/upstat 的视频播放量（views）：大于 0 是发过视频、现在全没了（投稿已清空）；查不到就不记 views，下次再查。
//   投稿已清空的人又有了视频（UP 回归：动态里出现或这次查到）记进 follow_jobs.posted。
//   follow_jobs.cur 是正在查的人。做完写 follow_jobs.statusAt：更新状态已齐，界面不用等第 4 步。
// 4 stats：每个关注的人的粉丝数（x/relation/stat）→ follow_stats；7 天内查过的跳过。
// 所有 GET 共用一个队列（间隔 1–1.5 秒），30 秒没回应算断网；风控（412、429、-352/-412/-799/-509）整队暂停 90 秒重试，第三次报 THROTTLED。
// 被风控拦过之后放慢：之后 10 分钟间隔改成 3 秒，再被拦就从那时重新算（follow_jobs.slowUntil，界面写「B站限流变慢」）。

// ===== 纯函数 =====

const FOLLOW_GONE_CODES = TriageUi.UP_GONE_CODES; // arc/search：账号没了，永久；其他错误码都算暂时
const FOLLOW_PLACEHOLDER_NAMES = new Set(["", "账号已注销"]);
const followNow = () => Math.floor(Date.now() / 1000);
const followIsDefaultFace = (f) => !f || /\/noface\.(jpg|gif|png)/.test(f);

// follow_people 条目合并：占位名和默认头像不覆盖已知的；注销账号保留旧名并标 gone。
function followMergePerson(old, nu) {
  const gone = nu.name === "账号已注销";
  if (!old) return gone ? { ...nu, gone: true } : nu;
  const out = { ...old, ...nu };
  if (FOLLOW_PLACEHOLDER_NAMES.has(nu.name || "") && old.name) out.name = old.name;
  if (followIsDefaultFace(nu.face) && !followIsDefaultFace(old.face)) out.face = old.face;
  if (gone) {
    out.gone = true;
    if (!nu.sign) out.sign = old.sign || "";
  } else delete out.gone;
  return out;
}

// cur = 存着的 follow_list（含同步期间在这里关注 / 取关的），fresh = 这次拉到的 { list, followTime, special, groups, complete }，
// unf = follow_unfollowed，live = 还存在的 UP 标签 id，startedAt = 这次同步开始的时间。
// - 同步开始后在这里关注、B站 列表还没反映的人保留。
// - 同步开始后在这里改过分组的人（cur.groupsAt ≥ startedAt，或上一条保留的人）用 cur 的分组，fresh 可能是改之前抓的。
// - unf 里的人只有关注时间晚于取关时间才算重新关注（back，标签进 restore）；否则仍算取关、不进列表。
//   例外：source "bili" 是从 B站 列表里少了这个人推出来的，B站 列表又有他就是还关注着（推错了），也算 back。
// - cur 里有、fresh 里没有、unf 里也没有的人是在 B站 取关的：gone[mid] = { at, tagIds, source: "bili" }。只在 fresh 拉全时判断。
// - changes = { at, added, removed, partial? }：新列表比 cur 多的人、gone 的人，给界面的「已刷新 +N −M」。没有上次的列表时为 null。
//   没拉全时 removed 为空、partial = { read, total }（读到几个、B站 说共几个），界面写琥珀「已刷新（部分）+N」。
function followDiff(cur, fresh, unf, tagMap, live, startedAt, at) {
  const inFresh = new Set(fresh.list);
  const ft = { ...fresh.followTime };
  const kept = (cur.list || []).filter((m) => !inFresh.has(m) && (cur.followTime?.[m] || 0) >= startedAt);
  for (const m of kept) ft[m] = cur.followTime[m];
  const back = [];
  const restore = {};
  const list = [...kept, ...fresh.list].filter((m) => {
    const u = unf[m];
    if (!u) return true;
    if (!((ft[m] || 0) > (u.at || 0)) && !(u.source === "bili" && inFresh.has(m))) return false;
    back.push(m);
    const ids = (u.tagIds || []).filter((id) => live.has(id));
    if (ids.length) restore[m] = ids;
    return true;
  });
  const gone = {};
  if (fresh.complete) {
    for (const m of cur.list || []) {
      if (!inFresh.has(m) && !kept.includes(m) && !unf[m]) gone[m] = { at, tagIds: tagMap[m] || [], source: "bili", groups: FollowCore.groupsOf(m, { list: cur }) };
    }
  }
  const inList = new Set(list);
  const only = (o) => Object.fromEntries(Object.entries(o || {}).filter(([m]) => inList.has(m)));
  const old = new Set(cur.list || []);
  const touched = Object.fromEntries(Object.entries(cur.groupsAt || {}).filter(([m, t]) => t >= startedAt && inList.has(m)));
  const special = only(fresh.special);
  const groups = only(fresh.groups);
  for (const m of new Set([...kept, ...Object.keys(touched)])) {
    if (cur.special?.[m]) special[m] = 1;
    else delete special[m];
    if (cur.groups?.[m]?.length) groups[m] = cur.groups[m];
    else delete groups[m];
  }
  return {
    list: { at, list, followTime: only(ft), special, groups, groupsAt: touched, complete: !!fresh.complete },
    gone,
    changes: !cur.list ? null : { at, added: list.filter((m) => !old.has(m)), removed: Object.keys(gone), ...(fresh.complete ? {} : { partial: { read: fresh.list.length, total: fresh.total } }) },
    back,
    restore
  };
}

// feed/all 的一条动态 → 视频，不是投稿视频的返回 null。
function followFeedItem(it) {
  const a = it?.modules?.module_dynamic?.major?.archive;
  if (!a?.bvid) return null;
  const au = it.modules.module_author || {};
  return {
    bvid: a.bvid,
    aid: String(a.aid ?? ""),
    title: a.title || "",
    cover: TriageUi.https(a.cover),
    duration: Math.max(0, MdgCommon.parseTimestamp(a.duration_text)),
    play: MdgCommon.parseCount(a.stat?.play),
    mid: String(au.mid ?? ""),
    name: au.name || "",
    face: au.face || "",
    at: Number(au.pub_ts) || 0
  };
}

// arc/search 的 data → follow_content 记录（不含 at）
function followArcRecord(d) {
  return {
    code: 0,
    count: Number(d?.page?.count) || 0,
    tlist: Object.fromEntries(Object.values(d?.list?.tlist || {}).map((t) => [t.name, t.count])),
    v: (d?.list?.vlist || []).slice(0, TriageUi.UP_RECENT).map((x) => ({ t: x.title, c: x.created }))
  };
}

// 一个视频并进 follow_last：map 记每人最新发布时间，v 记每人最近 ≤UP_RECENT 个视频 { t, c, bvid }，按 bvid 去重。返回有没有改
// （比留下的都旧、马上被挤掉的不算）。
// 以前从动态记下的条目没有 bvid：同标题同时间的就是它，换成带 bvid 的。
function followNoteVideo(last, it) {
  let changed = false;
  if (!(last.map[it.mid] >= it.at)) {
    last.map[it.mid] = it.at;
    changed = true;
  }
  const v = (last.v[it.mid] ||= []);
  const i = v.findIndex((x) => (x.bvid ? x.bvid === it.bvid : x.c === it.at && x.t === it.title));
  if (i >= 0 && v[i].bvid) return changed;
  if (i >= 0) v.splice(i, 1);
  const entry = { t: it.title, c: it.at, bvid: it.bvid };
  v.push(entry);
  v.sort((x, y) => y.c - x.c);
  v.length = Math.min(v.length, TriageUi.UP_RECENT);
  return changed || i >= 0 || v.includes(entry);
}

// 把一页动态并进 follow_last，since 是翻到的最早时间。
function followFoldFeed(last, items) {
  for (const it of items) {
    if (!it.mid || !it.at) continue;
    followNoteVideo(last, it);
    if (it.at < last.since) last.since = it.at;
  }
  return last;
}

// 序号|名字|签名|主要分区|最近标题|现有标签
function followAiLine(item, n) {
  const list = (a, sep) => (Array.isArray(a) ? a.map(triageCell).filter(Boolean) : []).join(sep);
  return [n, triageCell(item.name), triageCell(item.sign), triageCell(item.tname), list(item.titles, "；"), list(item.currentTags, "、")].join("|");
}

// 批量打标签的对象换成 UP 主，规则和收藏夹同一份（triageBuildCommandMessages）。
const FOLLOW_AI_UNIT = {
  intro: "你是 B站关注整理助手，按用户指令给关注的 UP 主打标签、做分类。",
  noun: " UP 主",
  basis: "- 主要依据是最近标题和主要分区，签名只作参考。",
  header: "UP 主列表，每行格式：序号|名字|签名|主要分区|最近标题（；分隔）|现有标签（没有的字段留空）：",
  line: followAiLine
};

// ===== B站 请求 =====

const FOLLOW_API = TRIAGE_BILI_API;
const FOLLOW_CFG = { gapMs: 1000, jitterMs: 500, backoffMs: TriageUi.BILI_HOLD_MS, strikes: 3, emptyRetryMs: 1500, netRetry: [5000, 15000, 60000], slowGapMs: 3000, slowForMs: 10 * 60 * 1000 };
const followSleep = (ms) => new Promise((r) => setTimeout(r, ms));

let followQueue = Promise.resolve();
let followLastAt = -Infinity;
let followHoldUntil = 0;
let followOnHold = null; // ({ until, why }) 队列暂停时告诉正在跑的同步
let followSlowUntil = 0; // 毫秒；之前放慢间隔
const followGap = () => (Date.now() < followSlowUntil ? FOLLOW_CFG.slowGapMs : FOLLOW_CFG.gapMs);

// 每个 GET 等上一个的时间再加间隔；风控或断网暂停整个队列。睡醒再算一次：睡着时才来的暂停也要等。
function followSlot() {
  const turn = followQueue.then(async () => {
    const jitter = Math.random() * FOLLOW_CFG.jitterMs;
    for (let wait; (wait = Math.max(followLastAt + followGap() + jitter, followHoldUntil) - Date.now()) > 0; ) await followSleep(wait);
    followLastAt = Date.now();
  });
  followQueue = turn.catch(() => {});
  return turn;
}

function followHold(ms, why) {
  followHoldUntil = Math.max(followHoldUntil, Date.now() + ms);
  if (why === "throttled") followSlowUntil = followHoldUntil + FOLLOW_CFG.slowForMs;
  const hold = { until: Math.ceil(followHoldUntil / 1000), why };
  try {
    followOnHold?.(hold);
  } catch {}
  // Slowed outside a sync too (视频投稿's pages): kept in follow_jobs, which a restarted worker reads back (followResume).
  if (why === "throttled" && !followOnHold) followPatchJob({ slowUntil: Math.ceil(followSlowUntil / 1000) }).catch(() => {});
  // The 视频投稿 page reads follow_hold while it waits for a page, as the sync's pill reads follow_jobs.hold.
  chrome.storage.local.set(MdgLimits.followFull({ hold })).catch(() => {});
}

// Every GET goes through triage-bg.js's channel, paced by this queue.
const FOLLOW_PACE = { slot: followSlot, hold: followHold, cfg: FOLLOW_CFG };
const followGetJson = (url) => triageBiliGetJson(url, FOLLOW_PACE);

// A B站 code as an error (triage-bg.js triageCodeError): -101 is NOT_LOGGED_IN (a string code, so every phase stops on
// it like on THROTTLED); any other stays B站's own number (FOLLOW_GONE_CODES, or a temporary one the phases skip).
const followCodeError = (j, what) => triageCodeError(j, what, true);

async function followGetData(url) {
  const j = await followGetJson(url);
  if (j.code !== 0) throw followCodeError(j);
  return j.data;
}

// 该有内容却回空，可能是风控：等 1.5 秒再问一次。
async function followAgain(once, empty) {
  const r = await once();
  if (!empty(r)) return r;
  await followSleep(FOLLOW_CFG.emptyRetryMs);
  return once();
}

const followQuery = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null)).toString();

// The key is sites.js's (one per worker); nav goes through this queue like every other GET.
const FOLLOW_WBI_IO = { fetchJson: followGetJson };
async function followWbiData(base, params) {
  const signed = async () => {
    try {
      return `${base}?${await MdgSites.biliWbiSigned(params, FOLLOW_WBI_IO)}`;
    } catch (e) {
      throw e.code ? e : triageError("拿不到 WBI 签名密钥");
    }
  };
  let j = await followGetJson(signed);
  if (j.code === -403) {
    MdgSites.biliWbiReset();
    j = await followGetJson(signed);
  }
  if (j.code !== 0) throw followCodeError(j);
  return j.data;
}

async function followFeedPage(offset = "") {
  const url = `${FOLLOW_API}/x/polymer/web-dynamic/v1/feed/all?${followQuery({ type: "video", offset })}`;
  const d = await followAgain(() => followGetData(url), (d) => !offset && !d?.items?.length);
  return { items: (d?.items || []).map(followFeedItem).filter(Boolean), offset: String(d?.offset || ""), hasMore: !!d?.has_more };
}

async function followArcSearch(mid) {
  const params = { mid, ps: 30, pn: 1, order: "pubdate", platform: "web", web_location: 1550101 };
  const d = await followAgain(
    () => followWbiData(`${FOLLOW_API}/x/space/wbi/arc/search`, params),
    (d) => (Number(d?.page?.count) || 0) > 0 && !d?.list?.vlist?.length
  );
  return followArcRecord(d);
}

// ===== 存储 =====

// 对 follow_ 键的读改写排队执行，和分拣台「关注」共用一把 Web Lock（MdgLimits.updateFollow），同步、关注 / 取关和页面上改标签
// 不会互相覆盖。names 和 fn 收到、返回的都是短名（list、tag_map …）。fn(当前值) 返回要写的 patch；值为 undefined 的键删掉。
const followUpdate = (names, fn) => MdgLimits.updateFollow(names, fn);

// B站 页面上「+ UP 标签」的一次改动（badges.js）：页面在另一个 origin，拿不到同一把锁，所以由这里在锁里重读再改。
async function followUpTag({ mid, op } = {}) {
  mid = String(mid || "");
  if (!/^\d+$/.test(mid) || !op || typeof op !== "object") throw triageError("缺少 mid 或 op");
  const one = op.create != null ? { create: String(op.create) } : { toggle: String(op.toggle) };
  let r = null;
  await followUpdate(["tags", "tag_map"], (s) => {
    r = MdgTagCore.applyUpTag(s.tags, s.tag_map, mid, one);
    return r?.map && (r.tags !== s.tags ? { tags: r.tags, tag_map: r.map } : { tag_map: r.map });
  });
  return r;
}

const FOLLOW_STOPPED = () => triageError(MdgErrors.LABEL.stopped, "STOPPED");
// The arc and stats phases' step after the UP 主 they skipped this time.
const followSkippedText = (n) => (n ? `（${n} 个暂时没查到，下次再查）` : "");
const followPatchJob = (fields) => followUpdate(["jobs"], (s) => ({ jobs: { ...s.jobs, ...fields } }));

// ===== 同步 =====

let followRun = null; // { stop, abort, halt, promise }

async function followSyncJob(ctx) {
  const c = ctx.cursor || { phase: "list" };
  const get = ctx.get;

  if (c.phase === "list") {
    await ctx.progress({ phase: "list", step: "", done: 0, total: 0, cursor: c });
    const nav = (await get(() => followGetJson(`${FOLLOW_API}/x/web-interface/nav`))).data || {};
    if (!nav.isLogin || !nav.mid) throw triageNotLoggedIn();
    const fresh = { list: [], followTime: {}, special: {}, groups: {} };
    const people = {};
    let total = 0;
    // A total that moves between pages (a follow or unfollow on B站 meanwhile) shifts the pages: someone may fall
    // between two of them, so the read is not complete and nobody missing from it counts as unfollowed.
    let shifted = false;
    const stored = (await MdgLimits.followGet(["list"])).list;
    const showPages = !stored || stored.partial;
    // ponytail: 100 页 = 5000 人，B站 关注上限也是这个数
    for (let pn = 1; pn <= 100; pn++) {
      const url = `${FOLLOW_API}/x/relation/followings?${followQuery({ vmid: nav.mid, pn, ps: 50, order: "desc" })}`;
      const j = await get(() => followAgain(() => followGetJson(url), (j) => pn === 1 && j.code === 0 && !j.data?.list?.length));
      if (j.code !== 0) throw followCodeError(j, "读取关注列表失败：");
      const page = j.data?.list || [];
      const pageTotal = Number(j.data?.total) || 0;
      if (pn > 1 && pageTotal !== total) shifted = true;
      total = pageTotal;
      for (const x of page) {
        const mid = String(x.mid);
        if (people[mid]) continue;
        fresh.list.push(mid);
        if (x.mtime) fresh.followTime[mid] = Number(x.mtime);
        if (x.special === 1 || (x.tag || []).includes(FOLLOW_SPECIAL)) fresh.special[mid] = 1;
        const groups = (x.tag || []).filter((t) => t > 0);
        if (groups.length) fresh.groups[mid] = groups;
        people[mid] = { mid, name: x.uname || "", face: x.face || "", sign: String(x.sign || "").slice(0, 60), ov: x.official_verify?.desc || "" };
      }
      if (showPages) {
        await followUpdate(["list", "people", "unfollowed", "tags"], (s) => {
          const live = new Set((s.tags || []).map((t) => t.id));
          const d = followDiff(s.list || {}, fresh, { ...s.unfollowed }, {}, live, ctx.startedAt, followNow());
          const ppl = { ...s.people };
          for (const x of page) ppl[String(x.mid)] = followMergePerson(ppl[String(x.mid)], people[String(x.mid)]);
          return { list: { ...d.list, partial: true }, people: ppl };
        });
      }
      await ctx.progress({ done: fresh.list.length, total: Math.max(total, fresh.list.length) });
      if (!page.length || fresh.list.length >= total) break;
    }
    fresh.complete = !shifted && fresh.list.length >= total;
    fresh.total = total;
    // B站 关注分组 names. 0 默认分组 and -10 特别关注 are B站's fixed ones; the page names them itself.
    const tags = await get(() => followGetData(`${FOLLOW_API}/x/relation/tags`));
    const groups = (Array.isArray(tags) ? tags : []).filter((g) => g.tagid > 0).map((g) => ({ id: g.tagid, name: String(g.name || ""), count: Number(g.count) || 0 }));
    let changes = null;
    await followUpdate(["list", "people", "unfollowed", "tag_map", "tags"], (s) => {
      const unf = { ...s.unfollowed };
      const tagMap = { ...s.tag_map };
      const live = new Set((s.tags || []).map((t) => t.id));
      const d = followDiff(s.list || {}, fresh, unf, tagMap, live, ctx.startedAt, followNow());
      // 拉到一半先显示的列表不算上次的列表，不报「新关注」。
      changes = s.list?.partial ? null : d.changes;
      for (const [mid, rec] of Object.entries(d.gone)) {
        unf[mid] = rec;
        delete tagMap[mid];
      }
      for (const mid of d.back) delete unf[mid];
      for (const [mid, ids] of Object.entries(d.restore)) if (!tagMap[mid]?.length) tagMap[mid] = ids;
      const ppl = { ...s.people };
      for (const [mid, p] of Object.entries(people)) ppl[mid] = followMergePerson(ppl[mid], p);
      return { list: d.list, people: ppl, unfollowed: unf, tag_map: tagMap, groups };
    });
    if (changes) await ctx.progress({ changes });
    Object.assign(c, { phase: "feed", offset: "" });
  }

  const slowDays = TriageUi.numSetting("slowDays", (await chrome.storage.sync.get({ followSlowDays: null })).followSlowDays);
  if (c.phase === "feed") {
    const st = await MdgLimits.followGet(["last", "last_wip"]);
    const lp = st.last;
    const fresh = lp && followNow() - lp.at < 6 * 3600 && lp.since <= followNow() - slowDays * 86400;
    if (!fresh) {
      // 翻到一半的存在 follow_last_wip，翻完才换掉 follow_last：中途停下或限流时，上次翻全的还在。
      const wip = c.offset && st.last_wip;
      if (!wip) c.offset = "";
      const last = wip ? { ...wip, v: wip.v || {} } : { at: followNow(), since: followNow(), map: {}, v: {} };
      await ctx.progress({ phase: "feed", step: `读取视频投稿：找出 ${slowDays} 天内投稿的 UP 主`, done: 0, total: 0, cursor: c });
      // ponytail: 600 页（约 12000 个视频）封顶，slowDays 内发得更多要调大
      for (let p = 0; p < 600; p++) {
        const r = await get(() => followFeedPage(c.offset));
        followFoldFeed(last, r.items);
        c.offset = r.offset;
        const end = !r.hasMore || !r.offset || last.since <= followNow() - slowDays * 86400 || p === 599;
        // 断点（游标和 follow_last_wip）每页都存，界面读 follow_last_wip 边翻边更新状态。也走 followUpdate：
        // 排在前面的 followNoteFeedPosts 读的是旧 follow_last，直接写会被它随后写回的旧值盖掉。翻完换掉 follow_last 时，
        // 同步开始后视频投稿页并进旧 follow_last 的新视频（第一页读过之后才发的）一起带上。
        last.at = followNow();
        await followUpdate(["last"], (st) => {
          if (!end) return { last_wip: last };
          const old = st.last?.v || {};
          for (const [mid, vs] of Object.entries(old)) for (const x of vs) if (x.bvid && x.c >= ctx.startedAt) followNoteVideo(last, { mid, at: x.c, title: x.t, bvid: x.bvid });
          return { last, last_wip: undefined };
        });
        await ctx.progress({ done: Object.keys(last.map).length, cursor: c });
        if (end) break;
      }
    }
    c.phase = "arc";
  }

  if (c.phase === "stats") return followStatsPhase(ctx);
  const s = await MdgLimits.followGet(["list", "last", "content"]);
  const seen = s.last?.map || {};
  const since = s.last?.since || 0;
  const have = s.content || {};
  const targets = (s.list?.list || []).filter((m) => !seen[m]);
  // 投稿已清空的人（没视频、播放量 > 0）又有了视频：动态里看到了，或这次查到了。记进 follow_jobs.posted 给界面的刷新结果，
  // 旧的 0 个视频记录删掉（动态里有的就不用再查），下次不再报。
  const wasCleared = (m) => have[m] && !have[m].code && !have[m].count && have[m].views > 0;
  // 接着跑时先接上已经报过的（它们的记录已删，这次认不出来了）。
  const posted = [...(ctx.posted || [])];
  const seenBack = (s.list?.list || []).filter((m) => wasCleared(m) && seen[m]);
  if (seenBack.length) {
    await followUpdate(["content"], (st) => {
      const fc = { ...st.content };
      for (const m of seenBack) delete fc[m];
      return { content: fc };
    });
    for (const m of seenBack) delete have[m];
    posted.push(...seenBack);
    await ctx.progress({ posted });
  }
  const known = (m) => have[m] && (FOLLOW_GONE_CODES.has(have[m].code) || (!have[m].code && (have[m].count || have[m].views != null))) && have[m].at >= since;
  let done = targets.filter(known).length;
  let skipped = 0;
  const step = "查投稿：视频投稿里没有的 UP 主";
  await ctx.progress({ phase: "arc", step, done, total: targets.length, skipped, cursor: c });
  for (const mid of targets) {
    if (known(mid)) continue;
    await ctx.progress({ cur: mid });
    let rec;
    try {
      rec = await get(() => followArcSearch(mid));
    } catch (e) {
      rec = followGoneRecord(e, { count: 0, tlist: {}, v: [] });
      if (!rec) {
        skipped++;
        await ctx.progress({ skipped, step: `${step}${followSkippedText(skipped)}` });
        continue;
      }
    }
    if (!rec.code && !rec.count) {
      const views = await get(() => followGetData(`${FOLLOW_API}/x/space/upstat?mid=${mid}`)).then((d) => Number(d?.archive?.view), (e) => {
        if (typeof e.code === "string") throw e;
        return NaN;
      });
      if (Number.isFinite(views)) rec.views = views;
    }
    if (wasCleared(mid) && rec.count) {
      posted.push(mid);
      await ctx.progress({ posted });
    }
    await followUpdate(["content"], (st) => ({ content: { ...st.content, [mid]: { ...rec, at: followNow() } } }));
    await ctx.progress({ done: ++done });
  }
  // 到这里更新状态已经齐了：statusAt 告诉界面不用等后面的粉丝数。
  if (c.phase !== "stats") {
    c.phase = "stats";
    await ctx.progress({ statusAt: followNow(), cursor: c });
  }
  await followStatsPhase(ctx);
}

// 一个 UP 主的请求失败了（查投稿、粉丝数）：THROTTLED / NETWORK / STOPPED / NOT_LOGGED_IN 停下整个同步；账号没了记下来
// （empty 加上 B站 的码）；其他（WBI -403、HTTP 5xx…）是暂时的，返回 null：不记，下次再查。
function followGoneRecord(e, empty) {
  if (typeof e.code === "string") throw e;
  return FOLLOW_GONE_CODES.has(e.code) ? { code: e.code, ...empty } : null;
}

// 第 4 步：每个关注的人的粉丝数（x/relation/stat，一人一次）→ follow_stats。7 天内查过的跳过，所以接着跑不重查。
const FOLLOW_STATS_DAYS = 7;
async function followStatsPhase(ctx) {
  const s = await MdgLimits.followGet(["list", "stats"]);
  const have = s.stats || {};
  const targets = s.list?.list || [];
  const known = (m) => have[m] && followNow() - (have[m].at || 0) < FOLLOW_STATS_DAYS * 86400;
  let done = targets.filter(known).length;
  let skipped = 0;
  // The pill adds done/total itself.
  const step = () => `查粉丝数${followSkippedText(skipped)}`;
  await ctx.progress({ phase: "stats", step: step(), done, total: targets.length, skipped });
  for (const mid of targets) {
    if (known(mid)) continue;
    let rec;
    try {
      const d = await ctx.get(() => followGetData(`${FOLLOW_API}/x/relation/stat?vmid=${mid}`));
      rec = { follower: Number(d?.follower) || 0 };
    } catch (e) {
      rec = followGoneRecord(e, { follower: 0 });
      if (!rec) {
        skipped++;
        await ctx.progress({ skipped, step: step() });
        continue;
      }
    }
    await followUpdate(["stats"], (st) => ({ stats: { ...st.stats, [mid]: { ...rec, at: followNow() } } }));
    done++;
    await ctx.progress({ done, step: step() });
  }
}

const FOLLOW_ALARM = "follow-keepalive";
let followPinger = null;
// 跑着时每 20 秒调一次扩展 API，重置 worker 的空闲计时；另开 1 分钟的闹钟，worker 被杀后由它叫醒，按游标接着跑。没在跑就清掉。
function followKeepAlive(on) {
  if (on && !followPinger) {
    followPinger = setInterval(() => chrome.runtime?.getPlatformInfo?.(), 20000);
    chrome.alarms?.create(FOLLOW_ALARM, { periodInMinutes: 1 });
  }
  if (!on && followPinger) {
    clearInterval(followPinger);
    followPinger = null;
    chrome.alarms?.clear(FOLLOW_ALARM);
  }
}

async function followStart() {
  if (followRun) return;
  const run = (followRun = { stop: false });
  run.halt = new Promise((_, reject) => (run.abort = () => reject(FOLLOW_STOPPED())));
  run.halt.catch(() => {});
  followKeepAlive(true);
  const prev = (await MdgLimits.followGet(["jobs"])).jobs || {};
  // 慢速只存在内存里；worker 重启后从上次写下的 slowUntil 接回来，不然一重启就回到 1 秒间隔。
  followSlowUntil = Math.max(followSlowUntil, (prev.slowUntil || 0) * 1000);
  // 停下或出错后再开始从游标接着跑；超过一天的游标作废，从头来。
  const cursor = prev.cursor && !prev.finishedAt && followNow() - (prev.startedAt || 0) < 86400 ? prev.cursor : null;
  const startedAt = cursor ? prev.startedAt : followNow();
  await followPatchJob({
    running: true, error: null, errorCode: null, hold: null, finishedAt: null, slowUntil: Math.ceil(followSlowUntil / 1000),
    ...(cursor ? {} : { startedAt, phase: "list", step: "", done: 0, total: 0, skipped: 0, cursor: null, changes: null, posted: [] })
  });
  followOnHold = (hold) => followPatchJob({ hold, slowUntil: Math.ceil(followSlowUntil / 1000) }).catch(() => {});
  // 停下立即生效，退避中也一样：正在等的请求直接丢掉。
  const get = async (call) => {
    if (run.stop) throw FOLLOW_STOPPED();
    const p = call();
    p.catch(() => {});
    return Promise.race([p, run.halt]);
  };
  const ctx = { cursor, startedAt, posted: cursor ? prev.posted || [] : [], get, progress: (fields) => followPatchJob({ ...fields, hold: null, beat: followNow() }) };
  run.promise = followSyncJob(ctx)
    .then(
      // The 动态 pages cached before it would hide what it just found.
      () => (followFeedCache.clear(), followPatchJob({ running: false, finishedAt: followNow(), lastFinishedAt: followNow(), step: "", cursor: null, hold: null })),
      (e) =>
        followPatchJob(
          e.code === "STOPPED" ? { running: false, hold: null } : { running: false, hold: null, error: e.message, errorCode: e.code ?? null }
        )
    )
    .catch((e) => console.warn("[follow] 同步状态写入失败", e))
    .finally(() => {
      followRun = null;
      followOnHold = null;
      followKeepAlive(false);
    });
}

// Each 停止 counts: a resume (followResume) that read running before it does not start the sync again.
let followStops = 0;
async function followStop() {
  followStops++;
  if (followRun) {
    followRun.stop = true;
    followRun.abort();
    await followRun.promise;
  } else await followPatchJob({ running: false, hold: null }); // 被杀的 worker 留下的 running
}

// worker 启动时：上次还在跑就接着跑。
async function followResume() {
  const stops = followStops;
  const j = (await MdgLimits.followGet(["jobs"])).jobs;
  followSlowUntil = Math.max(followSlowUntil, (j?.slowUntil || 0) * 1000);
  if (j?.running && stops === followStops) await followStart();
  else if (!followRun) chrome.alarms?.clear(FOLLOW_ALARM);
}

// ===== 关注 / 动态 / AI =====

// gone (with act 2): the 已取消关注 record a 重新关注 took, put back as it was when that 重新关注 is undone.
async function followRelation({ mid, act, gone }) {
  mid = String(mid ?? "");
  act = Number(act);
  if (!/^\d+$/.test(mid) || (act !== 1 && act !== 2)) throw triageError("缺少 mid 或 act 不对");
  await triageBiliPost("/x/relation/modify", { fid: mid, act, re_src: 11 });
  const at = followNow();
  // 重新关注：取关记录里的分组还在的，放回去（一次 copyUsers）。没放回不算重新关注失败（groupsError 带原因）。
  let back = [];
  let groupsError = "";
  if (act === 1) {
    const s0 = await MdgLimits.followGet(["unfollowed", "groups"]);
    const have = new Set([FOLLOW_SPECIAL, ...(s0.groups || []).map((g) => g.id)]);
    back = (s0.unfollowed?.[mid]?.groups || []).filter((id) => have.has(id));
    if (back.length) await triageBiliPost("/x/relation/tags/copyUsers", { fids: mid, tagids: back.join(",") }).catch((e) => {
      groupsError = e.message;
      back = [];
    });
  }
  await followUpdate(["list", "unfollowed", "tag_map", "tags"], (s) => {
    const f = s.list || {};
    const unf = { ...s.unfollowed };
    const tagMap = { ...s.tag_map };
    const followTime = { ...f.followTime };
    const special = { ...f.special };
    const groups = { ...f.groups };
    const list = (f.list || []).filter((x) => x !== mid);
    if (act === 2) {
      // 重复取关不覆盖已有记录；标签挪进记录。撤销重新关注时放回原记录。
      if (gone && typeof gone === "object") unf[mid] = { at: Number(gone.at) || at, tagIds: (Array.isArray(gone.tagIds) ? gone.tagIds : []).map(String), source: gone.source === "bili" ? "bili" : "app", ...(Array.isArray(gone.groups) ? { groups: gone.groups.map(Number).filter(Number.isInteger) } : {}) };
      else if (!unf[mid]) unf[mid] = { at, tagIds: tagMap[mid] || [], source: "app", groups: FollowCore.groupsOf(mid, { list: f }) };
      delete tagMap[mid];
      delete followTime[mid];
      delete special[mid];
      delete groups[mid]; // B站 取关时分组一起没了
    } else {
      const live = new Set((s.tags || []).map((t) => t.id));
      const ids = (unf[mid]?.tagIds || []).filter((id) => live.has(id));
      if (ids.length && !tagMap[mid]?.length) tagMap[mid] = ids;
      delete unf[mid];
      followTime[mid] = at;
      list.unshift(mid);
      if (back.includes(FOLLOW_SPECIAL)) special[mid] = 1;
      const own = back.filter((id) => id > 0);
      if (own.length) groups[mid] = own;
    }
    return { list: { ...f, list, followTime, special, groups, groupsAt: { ...f.groupsAt, [mid]: at } }, unfollowed: unf, tag_map: tagMap };
  });
  return { groups: back, groupsError };
}

// ===== 关注分组 =====
// B站's fixed groups: -10 特别关注, 0 默认分组 (in none of your own). follow_list keeps -10 as special[mid] and the
// custom ones in groups[mid].
const FOLLOW_SPECIAL = TriageUi.FOLLOW_SPECIAL;

// An UP's groups after from leaves and to joins (pure); 0 is no group.
function followGroupsApply(ids, from, to) {
  const out = ids.filter((id) => !from.includes(id));
  for (const id of to) if (id !== 0 && !out.includes(id)) out.push(id);
  return out;
}

const followGroupName = (name) => {
  const n = String(name ?? "").trim();
  const bad = TriageUi.groupNameError(n);
  if (bad) throw triageError(bad);
  return n;
};
const followIds = (a) => (Array.isArray(a) ? a : []).map(Number);

// Copy (no from) or move the mids on B站 in one request; follow_list follows only once B站 said yes.
async function followGroupMove({ mids, from, to }) {
  const list = [...new Set((Array.isArray(mids) ? mids : []).map(String))];
  from = followIds(from);
  to = followIds(to);
  if (!list.length || !list.every((m) => /^\d+$/.test(m)) || !to.length || ![...from, ...to].every(Number.isInteger)) throw triageError("缺少 mids 或分组");
  if (!from.length && to.includes(0)) throw triageError("默认分组不能复制进去");
  const st = await MdgLimits.followGet(["list", "people"]);
  const f = st.list || {};
  const notFollowed = list.filter((m) => !f.list?.includes(m));
  if (notFollowed.length) throw triageError(`还没关注 ${notFollowed.map((m) => `「${st.people?.[m]?.name || m}」`).join("、")}，不能改分组`);
  const post = (ms) => from.length
    ? triageBiliPost("/x/relation/tags/moveUsers", { fids: ms.join(","), beforeTagids: from.join(","), afterTagids: to.join(",") })
    : triageBiliPost("/x/relation/tags/copyUsers", { fids: ms.join(","), tagids: to.join(",") });
  // B站 refuses the whole request for one UP it won't take (a closed account). Refused (an error with no code: not 限流,
  // 断网 or 未登录), the rest go one by one and the refused come back in skipped; every one refused is the request's error.
  let done = list;
  const skipped = [];
  try {
    await post(list);
  } catch (e) {
    if (e.code || list.length < 2) throw e;
    done = [];
    for (const m of list) {
      await followSleep(TriageUi.FOLLOW_WRITE_GAP_MS);
      try {
        await post([m]);
        done.push(m);
      } catch (e1) {
        if (!e1.code) {
          skipped.push({ mid: m, error: e1.message });
          continue;
        }
        // 限流、断网、未登录：已经改好的先记下（页面按 follow_list 的变化给它们撤销），再报错。
        if (done.length) await followGroupsDone(done, from, to);
        throw e1;
      }
    }
    if (!done.length) throw e;
  }
  await followGroupsDone(done, from, to);
  return { skipped };
}

async function followGroupsDone(done, from, to) {
  await followUpdate(["list"], (s) => {
    const fl = s.list || {};
    const special = { ...fl.special };
    const groups = { ...fl.groups };
    for (const m of done) {
      const ids = followGroupsApply(FollowCore.groupsOf(m, { list: { special, groups } }), from, to);
      if (ids.includes(FOLLOW_SPECIAL)) special[m] = 1;
      else delete special[m];
      const own = ids.filter((id) => id > 0);
      if (own.length) groups[m] = own;
      else delete groups[m];
    }
    return { list: { ...fl, special, groups, groupsAt: { ...fl.groupsAt, ...Object.fromEntries(done.map((m) => [m, followNow()])) } } };
  });
}

async function followForget({ mids }) {
  const list = (Array.isArray(mids) ? mids : []).map(String);
  await followUpdate(["unfollowed"], (s) => {
    const unf = { ...s.unfollowed };
    for (const m of list) delete unf[m];
    return { unfollowed: unf };
  });
  return {};
}

async function followGroupCreate({ name }) {
  name = followGroupName(name);
  const data = await triageBiliPost("/x/relation/tag/create", { tag: name });
  const id = Number(data?.tagid);
  if (!(id > 0)) throw triageError("B站没有给出新分组的编号，刷新后看一下");
  await followUpdate(["groups"], (s) => ({ groups: [...(s.groups || []).filter((g) => g.id !== id), { id, name, count: 0 }] }));
  return { id, name };
}

const followOwnGroup = (id) => {
  id = Number(id);
  if (!(id > 0)) throw triageError("特别关注和默认分组是 B站 固定的，不能改名或删除");
  return id;
};

async function followGroupRename({ id, name }) {
  id = followOwnGroup(id);
  name = followGroupName(name);
  await triageBiliPost("/x/relation/tag/update", { tagid: id, name });
  await followUpdate(["groups"], (s) => ({ groups: (s.groups || []).map((g) => (g.id === id ? { ...g, name } : g)) }));
  return {};
}

// B站 keeps following its members; the ones in no other group are back in 默认分组.
async function followGroupDelete({ id }) {
  id = followOwnGroup(id);
  await triageBiliPost("/x/relation/tag/del", { tagid: id });
  await followUpdate(["groups", "list"], (s) => {
    const fl = s.list || {};
    const groups = TriageUi.withoutTag(fl.groups || {}, id);
    const groupsAt = { ...fl.groupsAt };
    for (const [m, ids] of Object.entries(fl.groups || {})) if (ids.includes(id)) groupsAt[m] = followNow();
    return { groups: (s.groups || []).filter((g) => g.id !== id), list: { ...fl, groups, groupsAt } };
  });
  return {};
}

const FOLLOW_FEED_TTL_MS = TriageUi.FEED_CACHE_MS;
const followFeedCache = new Map(); // offset → { at, data }
async function followFeed({ offset = "" } = {}) {
  const key = String(offset || "");
  const hit = followFeedCache.get(key);
  if (hit && Date.now() - hit.at < FOLLOW_FEED_TTL_MS) return hit.data;
  const data = await followFeedPage(key);
  for (const [k, v] of followFeedCache) if (Date.now() - v.at >= FOLLOW_FEED_TTL_MS) followFeedCache.delete(k);
  followFeedCache.set(key, { at: Date.now(), data });
  await followNoteFeedPosts(data.items);
  return data;
}

// Posts seen in the live feed are newer than the last sync: fold them into follow_last so 「最后投稿」 and 更新状态
// on the UP 主 tab match the 动态 tab without a full 刷新. Only map / v grow; at and since (the sync's coverage) stay.
async function followNoteFeedPosts(items) {
  if (!items?.length) return;
  await followUpdate(["last"], (s) => {
    const L = s.last;
    if (!L?.map) return null;
    let changed = false;
    L.v ||= {};
    for (const it of items) if (it.mid && it.at && followNoteVideo(L, it)) changed = true;
    return changed ? { last: L } : null;
  });
}

// scope: the dialog's 作用范围 ("selected" or "filter"), for the words when every one asked is unfollowed by now.
async function followAiTag({ instruction, mids, tags, maxNewTags, allowRemove, aiProviderId, scope }) {
  const s = await MdgLimits.followGet(["list", "people", "content", "last", "last_wip", "tags", "tag_map"]);
  // The feed read still going counts, as on the cards.
  const last = TriageUi.withFeedInProgress(s.last, s.last_wip);
  const followed = new Set(s.list?.list || []);
  const asked = [...new Set((Array.isArray(mids) ? mids : []).map(String))];
  const list = asked.filter((m) => followed.has(m));
  if (!asked.length) throw triageError("缺少 mids");
  if (!list.length) throw triageError(`${scope === "selected" ? "选中" : "列出"}的都已取消关注`);
  const tagName = new Map((s.tags || []).map((t) => [t.id, t.name]));
  const items = list.map((mid) => {
    const p = s.people?.[mid] || {};
    const c = s.content?.[mid];
    const top = Object.entries(c?.tlist || {}).sort((a, b) => b[1] - a[1])[0];
    return {
      bvid: mid, // triageParseCommand 按 bvid 认条目
      name: p.name,
      sign: p.sign,
      tname: top?.[0] || "",
      titles: TriageUi.upTitles(last?.v?.[mid], c).map((x) => x.t),
      currentTags: (s.tag_map?.[mid] || []).map((id) => tagName.get(id)).filter(Boolean)
    };
  });
  if (!Array.isArray(tags)) throw triageError("缺少 tags");
  // triageAiCommand reads maxNewTags as the newTagMax setting and allowRemove as true or not.
  return triageAiCommand({ instruction, items, tags, maxNewTags, allowRemove, aiProviderId }, FOLLOW_AI_UNIT);
}

const FOLLOW_HANDLERS = {
  "follow-sync": async () => (await followStart(), {}),
  "follow-sync-stop": async () => (await followStop(), {}),
  "follow-feed": (msg) => followFeed(msg),
  "follow-relation": (msg) => followRelation(msg),
  "follow-forget": (msg) => followForget(msg),
  "follow-group-move": (msg) => followGroupMove(msg),
  "follow-group-create": (msg) => followGroupCreate(msg),
  "follow-group-rename": (msg) => followGroupRename(msg),
  "follow-group-delete": (msg) => followGroupDelete(msg),
  "follow-ai-tag": (msg) => followAiTag(msg),
  "follow-up-tag": (msg) => followUpTag(msg)
};

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  const resume = () => followResume().catch((e) => console.warn("[follow] 接着同步失败", e));
  resume();
  chrome.alarms?.onAlarm.addListener((alarm) => alarm.name === FOLLOW_ALARM && resume());
  triageListen("follow-", FOLLOW_HANDLERS, ["follow-up-tag"]);
}
