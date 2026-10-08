// MoonDigest 关注分拣台 background 层。classic script，background.js 在 triage-bg.js 之后 importScripts，共享全局作用域，
// 顶层名字统一带 follow / FOLLOW_ 前缀。B站 请求走 triage-bg.js 的 triageBiliJson / triageBiliPost，WBI 用 sites.js。
//
// 消息（回复 { ok: true, data } 或 { ok: false, error, code? }；code: THROTTLED / NETWORK / NOT_LOGGED_IN）。时间都是秒，mid 都是字符串。
// - follow-sync {}            开始或接着跑同步，立即返回 {}；进度在 storage follow_jobs。
// - follow-sync-stop {}       停下；再发 follow-sync 从游标接着跑。
// - follow-feed { offset }    一页视频动态 { items: [{ bvid, aid, title, cover, duration, play, mid, name, face, at }], offset, hasMore }，缓存 3 分钟。
// - follow-relation { mid, act, gone? }  1 关注 / 2 取关，成功后改好 follow_list、follow_unfollowed、follow_tag_map；gone = 撤销重新关注时放回的取关记录。
// - follow-special { mid, on }    特别关注开 / 关，成功后改好 follow_list.special。
// - follow-ai-tag { instruction, mids, tags?, maxNewTags?, allowRemove? }
//                             提案 { newTags, assignments: { mid: { add, remove } }, note }，不写任何东西。
//
// 同步分三步，每步做完记进 follow_jobs.cursor；跑着时开 1 分钟的 follow-keepalive 闹钟，worker 被杀后由它叫醒、从游标接着跑：
// 1 list：拉我的全部关注 → follow_list / follow_people；和上次比，消失的人进 follow_unfollowed（source "bili"），只在拉全时判断。
// 2 feed：视频动态往回翻过 followSlowDays 天 → follow_last（谁最近发过、最近 3 个标题）。6 小时内翻过就跳过。
// 3 arc：动态里没出现的人逐个 arc/search（约 1 秒 1 个）→ follow_content；已有记录且不早于 follow_last.since 的跳过。
//   做完写 follow_jobs.statusAt：更新状态已齐，界面不用等第 4 步。
// 4 stats：每个关注的人的粉丝数（x/relation/stat）→ follow_stats；7 天内查过的跳过。
// 所有 GET 共用一个队列（间隔 1–1.5 秒），30 秒没回应算断网；风控（412、-352/-412/-799/-509）整队暂停 90 秒重试，第三次报 THROTTLED。

// ===== 纯函数 =====

const FOLLOW_GONE_CODES = new Set([-404, -626]); // arc/search：账号没了，永久；其他错误码都算暂时
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
// - unf 里的人只有关注时间晚于取关时间才算重新关注（back，标签进 restore）；否则仍算取关、不进列表。
// - cur 里有、fresh 里没有、unf 里也没有的人是在 B站 取关的：gone[mid] = { at, tagIds, source: "bili" }。只在 fresh 拉全时判断。
// - changes = { at, added, removed }：新列表比 cur 多的人、gone 的人，给界面的「新关注 +N · 取关 −M」。没拉全或没有上次的列表时为 null。
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
    if (!((ft[m] || 0) > (u.at || 0))) return false;
    back.push(m);
    const ids = (u.tagIds || []).filter((id) => live.has(id));
    if (ids.length) restore[m] = ids;
    return true;
  });
  const gone = {};
  if (fresh.complete) {
    for (const m of cur.list || []) {
      if (!inFresh.has(m) && !kept.includes(m) && !unf[m]) gone[m] = { at, tagIds: tagMap[m] || [], source: "bili" };
    }
  }
  const inList = new Set(list);
  const only = (o) => Object.fromEntries(Object.entries(o || {}).filter(([m]) => inList.has(m)));
  const old = new Set(cur.list || []);
  return {
    list: { at, list, followTime: only(ft), special: only(fresh.special), groups: only(fresh.groups), complete: !!fresh.complete },
    gone,
    changes: fresh.complete && cur.list ? { at, added: list.filter((m) => !old.has(m)), removed: Object.keys(gone) } : null,
    back,
    restore
  };
}

// 动态里的播放数是文字："2505"、"12.5万"、"1.2亿"。
function followCount(v) {
  const s = String(v ?? "");
  const n = parseFloat(s) || 0;
  return Math.round(s.includes("亿") ? n * 1e8 : s.includes("万") ? n * 1e4 : n);
}

// "12:34" / "1:02:03" → 秒
function followDuration(text) {
  return String(text || "").split(":").reduce((s, p) => s * 60 + (Number(p) || 0), 0);
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
    cover: String(a.cover || "").replace(/^http:\/\//, "https://"),
    duration: followDuration(a.duration_text),
    play: followCount(a.stat?.play),
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
    v: (d?.list?.vlist || []).slice(0, 3).map((x) => ({ t: x.title, c: x.created }))
  };
}

// 把一页动态并进 follow_last：map 记每人最新发布时间，v 记每人最近 ≤3 个视频，since 是翻到的最早时间。
function followFoldFeed(last, items) {
  for (const it of items) {
    if (!it.mid || !it.at) continue;
    if (!(last.map[it.mid] >= it.at)) last.map[it.mid] = it.at;
    if (it.at < last.since) last.since = it.at;
    const v = (last.v[it.mid] ||= []);
    if (!v.some((x) => x.bvid === it.bvid)) {
      v.push({ t: it.title, c: it.at, bvid: it.bvid });
      v.sort((x, y) => y.c - x.c);
      v.length = Math.min(v.length, 3);
    }
  }
  return last;
}

// 序号|名字|签名|主要分区|最近标题|现有标签
function followAiLine(item, n) {
  const clean = (s) => String(s ?? "").replace(/[|\r\n]+/g, " ").trim();
  const list = (a, sep) => (Array.isArray(a) ? a.map(clean).filter(Boolean) : []).join(sep);
  return [n, clean(item.name), clean(item.sign), clean(item.tname), list(item.titles, "；"), list(item.currentTags, "、")].join("|");
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

const FOLLOW_API = "https://api.bilibili.com";
const FOLLOW_CFG = { gapMs: 1000, jitterMs: 500, backoffMs: 90000, strikes: 3, timeoutMs: 30000, emptyRetryMs: 1500, netRetry: [5000, 15000, 60000] };
const followSleep = (ms) => new Promise((r) => setTimeout(r, ms));

let followQueue = Promise.resolve();
let followLastAt = -Infinity;
let followHoldUntil = 0;
let followOnHold = null; // ({ until, why }) 队列暂停时告诉正在跑的同步

// 每个 GET 等上一个的时间再加间隔；风控或断网暂停整个队列。
function followSlot() {
  const turn = followQueue.then(async () => {
    const wait = Math.max(followLastAt + FOLLOW_CFG.gapMs + Math.random() * FOLLOW_CFG.jitterMs, followHoldUntil) - Date.now();
    if (wait > 0) await followSleep(wait);
    followLastAt = Date.now();
  });
  followQueue = turn.catch(() => {});
  return turn;
}

function followHold(ms, why) {
  followHoldUntil = Math.max(followHoldUntil, Date.now() + ms);
  try {
    followOnHold?.({ until: Math.ceil(followHoldUntil / 1000), why });
  } catch {}
}

// 30 秒没回应、连接断了都算 NETWORK。
async function followFetch(url) {
  const ctl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${FOLLOW_CFG.timeoutMs / 1000} 秒没有回应`)), FOLLOW_CFG.timeoutMs);
  });
  try {
    return await Promise.race([fetch(url, { credentials: "include", signal: ctl.signal }), timeout]);
  } catch (e) {
    ctl.abort();
    throw triageError(`网络断了：${e?.message || e}`, "NETWORK");
  } finally {
    clearTimeout(timer);
  }
}

// GET → 整个 JSON。url 可以是 async 函数（WBI 签名，每次重试重新签；风控时先丢掉签名密钥，旧密钥也回 -352）。
async function followGetJson(url) {
  let net = 0;
  for (let strike = 1; ; strike++) {
    const u = typeof url === "function" ? await url() : url;
    await followSlot();
    let json = null;
    try {
      json = await triageBiliJson(await followFetch(u));
    } catch (e) {
      if (e.code === "NETWORK" && net < FOLLOW_CFG.netRetry.length) {
        followHold(FOLLOW_CFG.netRetry[net++], "network");
        strike--;
        continue;
      }
      if (e.code !== "THROTTLED") throw e;
    }
    if (json && !BILI_RISK_CODES.has(json.code)) return json;
    if (strike >= FOLLOW_CFG.strikes) throw triageError("被 B站 限流，已暂停", "THROTTLED");
    if (typeof url === "function") BocSites.biliWbiReset();
    followHold(FOLLOW_CFG.backoffMs, "throttled");
  }
}

async function followGetData(url) {
  const j = await followGetJson(url);
  if (j.code !== 0) throw triageError(`B站返回 ${j.code}：${j.message}`, j.code);
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
      return `${base}?${await BocSites.biliWbiSigned(params, FOLLOW_WBI_IO)}`;
    } catch (e) {
      throw e.code ? e : triageError("拿不到 WBI 签名密钥");
    }
  };
  let j = await followGetJson(signed);
  if (j.code === -403) {
    BocSites.biliWbiReset();
    j = await followGetJson(signed);
  }
  if (j.code !== 0) throw triageError(`B站返回 ${j.code}：${j.message}`, j.code);
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

let followStoreChain = Promise.resolve();
// 本 worker 里对 follow_ 键的读改写排队执行，同步和关注 / 取关不会互相覆盖。fn(当前值) 返回要写的 patch。
function followUpdate(keys, fn) {
  const p = followStoreChain.then(async () => {
    const patch = await fn(await chrome.storage.local.get(keys));
    if (patch) await chrome.storage.local.set(patch);
    return patch;
  });
  followStoreChain = p.catch(() => {});
  return p;
}

const followPatchJob = (fields) => followUpdate(["follow_jobs"], (s) => ({ follow_jobs: { ...s.follow_jobs, ...fields } }));

// ===== 同步 =====

let followRun = null; // { stop, abort, halt, promise }

async function followSyncJob(ctx) {
  const c = ctx.cursor || { phase: "list" };
  const get = ctx.get;

  if (c.phase === "list") {
    await ctx.progress({ phase: "list", step: "拉我的关注", done: 0, total: 0, cursor: c });
    const nav = (await get(() => followGetJson(`${FOLLOW_API}/x/web-interface/nav`))).data || {};
    if (!nav.isLogin || !nav.mid) throw triageError("未登录 B站：先在这个浏览器里登录 B站", "NOT_LOGGED_IN");
    const fresh = { list: [], followTime: {}, special: {}, groups: {} };
    const people = {};
    let total = 0;
    // ponytail: 100 页 = 5000 人，B站 关注上限也是这个数
    for (let pn = 1; pn <= 100; pn++) {
      const url = `${FOLLOW_API}/x/relation/followings?${followQuery({ vmid: nav.mid, pn, ps: 50, order: "desc" })}`;
      const j = await get(() => followAgain(() => followGetJson(url), (j) => pn === 1 && j.code === 0 && !j.data?.list?.length));
      if (j.code !== 0) throw triageError(`拉我的关注失败：${j.code} ${j.message || ""}`, j.code);
      const page = j.data?.list || [];
      total = Number(j.data?.total) || 0;
      for (const x of page) {
        const mid = String(x.mid);
        if (people[mid]) continue;
        fresh.list.push(mid);
        if (x.mtime) fresh.followTime[mid] = Number(x.mtime);
        if (x.special === 1 || (x.tag || []).includes(-10)) fresh.special[mid] = 1;
        const groups = (x.tag || []).filter((t) => t >= 0);
        if (groups.length) fresh.groups[mid] = groups;
        people[mid] = { mid, name: x.uname || "", face: x.face || "", sign: String(x.sign || "").slice(0, 60), ov: x.official_verify?.desc || "" };
      }
      await ctx.progress({ done: fresh.list.length, total: Math.max(total, fresh.list.length) });
      if (!page.length || fresh.list.length >= total) break;
    }
    fresh.complete = fresh.list.length >= total;
    // B站 关注分组 names, shown read-only in 关注. 0 默认分组 and -10 特别关注 are left out (特别关注 has its own filter).
    const tags = await get(() => followGetData(`${FOLLOW_API}/x/relation/tags`));
    const groups = (Array.isArray(tags) ? tags : []).filter((g) => g.tagid > 0).map((g) => ({ id: g.tagid, name: String(g.name || ""), count: Number(g.count) || 0 }));
    let changes = null;
    await followUpdate(["follow_list", "follow_people", "follow_unfollowed", "follow_tag_map", "follow_tags"], (s) => {
      const unf = { ...s.follow_unfollowed };
      const tagMap = { ...s.follow_tag_map };
      const live = new Set((s.follow_tags || []).map((t) => t.id));
      const d = followDiff(s.follow_list || {}, fresh, unf, tagMap, live, ctx.startedAt, followNow());
      changes = d.changes;
      for (const [mid, rec] of Object.entries(d.gone)) {
        unf[mid] = rec;
        delete tagMap[mid];
      }
      for (const mid of d.back) delete unf[mid];
      for (const [mid, ids] of Object.entries(d.restore)) if (!tagMap[mid]?.length) tagMap[mid] = ids;
      const ppl = { ...s.follow_people };
      for (const [mid, p] of Object.entries(people)) ppl[mid] = followMergePerson(ppl[mid], p);
      return { follow_list: d.list, follow_people: ppl, follow_unfollowed: unf, follow_tag_map: tagMap, follow_groups: groups };
    });
    if (changes) await ctx.progress({ changes });
    Object.assign(c, { phase: "feed", offset: "" });
  }

  const slowDays = Math.max(1, Number((await chrome.storage.sync.get({ followSlowDays: 90 })).followSlowDays) || 90);
  if (c.phase === "feed") {
    const lp = (await chrome.storage.local.get("follow_last")).follow_last;
    const fresh = lp && followNow() - lp.at < 6 * 3600 && lp.since <= followNow() - slowDays * 86400;
    if (!fresh) {
      const last = c.offset && lp ? { ...lp, v: lp.v || {} } : { at: followNow(), since: followNow(), map: {}, v: {} };
      await ctx.progress({ phase: "feed", step: `翻视频投稿，找 ${slowDays} 天内发过视频的人`, done: 0, total: 0, cursor: c });
      // ponytail: 600 页（约 12000 个视频）封顶，slowDays 内发得更多要调大
      for (let p = 0; p < 600; p++) {
        const r = await get(() => followFeedPage(c.offset));
        followFoldFeed(last, r.items);
        c.offset = r.offset;
        const end = !r.hasMore || !r.offset || last.since <= followNow() - slowDays * 86400;
        if (p % 10 === 9 || end) {
          last.at = followNow();
          await chrome.storage.local.set({ follow_last: last });
          await ctx.progress({ done: Object.keys(last.map).length, cursor: c });
        }
        if (end) break;
      }
    }
    c.phase = "arc";
  }

  if (c.phase === "stats") return followStatsPhase(ctx);
  const s = await chrome.storage.local.get(["follow_list", "follow_last", "follow_content"]);
  const seen = s.follow_last?.map || {};
  const since = s.follow_last?.since || 0;
  const have = s.follow_content || {};
  const targets = (s.follow_list?.list || []).filter((m) => !seen[m]);
  const known = (m) => have[m] && (!have[m].code || FOLLOW_GONE_CODES.has(have[m].code)) && have[m].at >= since;
  let done = targets.filter(known).length;
  let skipped = 0;
  const step = "查视频投稿里没出现的人";
  await ctx.progress({ phase: "arc", step, done, total: targets.length, skipped, cursor: c });
  for (const mid of targets) {
    if (known(mid)) continue;
    let rec;
    try {
      rec = await get(() => followArcSearch(mid));
    } catch (e) {
      // THROTTLED / NETWORK / STOPPED 停下整个同步；账号没了记下来；其他（WBI -403、HTTP 5xx…）是暂时的，不记，下次再查。
      if (typeof e.code === "string") throw e;
      if (!FOLLOW_GONE_CODES.has(e.code)) {
        skipped++;
        await ctx.progress({ skipped, step: `${step}（${skipped} 个暂时没查到，下次再查）` });
        continue;
      }
      rec = { code: e.code, count: 0, tlist: {}, v: [] };
    }
    await followUpdate(["follow_content"], (st) => ({ follow_content: { ...st.follow_content, [mid]: { ...rec, at: followNow() } } }));
    await ctx.progress({ done: ++done });
  }
  // 到这里更新状态已经齐了：statusAt 告诉界面不用等后面的粉丝数。
  if (c.phase !== "stats") {
    c.phase = "stats";
    await ctx.progress({ statusAt: followNow(), cursor: c });
  }
  await followStatsPhase(ctx);
}

// 第 4 步：每个关注的人的粉丝数（x/relation/stat，一人一次）→ follow_stats。7 天内查过的跳过，所以接着跑不重查。
const FOLLOW_STATS_DAYS = 7;
async function followStatsPhase(ctx) {
  const s = await chrome.storage.local.get(["follow_list", "follow_stats"]);
  const have = s.follow_stats || {};
  const targets = s.follow_list?.list || [];
  const known = (m) => have[m] && followNow() - (have[m].at || 0) < FOLLOW_STATS_DAYS * 86400;
  let done = targets.filter(known).length;
  let skipped = 0;
  const step = () => `查粉丝数 ${done}/${targets.length}${skipped ? `（${skipped} 个暂时没查到，下次再查）` : ""}`;
  await ctx.progress({ phase: "stats", step: step(), done, total: targets.length, skipped });
  for (const mid of targets) {
    if (known(mid)) continue;
    let rec;
    try {
      const d = await ctx.get(() => followGetData(`${FOLLOW_API}/x/relation/stat?vmid=${mid}`));
      rec = { follower: Number(d?.follower) || 0 };
    } catch (e) {
      // 同 arc：THROTTLED / NETWORK / STOPPED 停下；账号没了记下来；其他暂时的不记。
      if (typeof e.code === "string") throw e;
      if (!FOLLOW_GONE_CODES.has(e.code)) {
        skipped++;
        await ctx.progress({ skipped, step: step() });
        continue;
      }
      rec = { code: e.code, follower: 0 };
    }
    await followUpdate(["follow_stats"], (st) => ({ follow_stats: { ...st.follow_stats, [mid]: { ...rec, at: followNow() } } }));
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
  run.halt = new Promise((_, reject) => (run.abort = () => reject(triageError("已停止", "STOPPED"))));
  run.halt.catch(() => {});
  followKeepAlive(true);
  const prev = (await chrome.storage.local.get("follow_jobs")).follow_jobs || {};
  // 停下或出错后再开始从游标接着跑；超过一天的游标作废，从头来。
  const cursor = prev.cursor && !prev.finishedAt && followNow() - (prev.startedAt || 0) < 86400 ? prev.cursor : null;
  const startedAt = cursor ? prev.startedAt : followNow();
  await followPatchJob({
    running: true, error: null, throttled: false, hold: null, finishedAt: null,
    ...(cursor ? {} : { startedAt, phase: "list", step: "", done: 0, total: 0, skipped: 0, cursor: null, changes: null })
  });
  followOnHold = (hold) => followPatchJob({ hold }).catch(() => {});
  // 停下立即生效，退避中也一样：正在等的请求直接丢掉。
  const get = async (call) => {
    if (run.stop) throw triageError("已停止", "STOPPED");
    const p = call();
    p.catch(() => {});
    return Promise.race([p, run.halt]);
  };
  const ctx = { cursor, startedAt, get, progress: (fields) => followPatchJob({ ...fields, hold: null, beat: followNow() }) };
  run.promise = followSyncJob(ctx)
    .then(
      // The 动态 pages cached before it would hide what it just found.
      () => (followFeedCache.clear(), followPatchJob({ running: false, finishedAt: followNow(), lastFinishedAt: followNow(), step: "", cursor: null, hold: null })),
      (e) =>
        followPatchJob(
          e.code === "STOPPED" ? { running: false, hold: null } : { running: false, hold: null, error: e.message, throttled: e.code === "THROTTLED" }
        )
    )
    .catch((e) => console.warn("[follow] 同步状态写入失败", e))
    .finally(() => {
      followRun = null;
      followOnHold = null;
      followKeepAlive(false);
    });
}

async function followStop() {
  if (followRun) {
    followRun.stop = true;
    followRun.abort();
    await followRun.promise;
  } else await followPatchJob({ running: false, hold: null }); // 被杀的 worker 留下的 running
}

// worker 启动时：上次还在跑就接着跑。
async function followResume() {
  const j = (await chrome.storage.local.get("follow_jobs")).follow_jobs;
  if (j?.running) await followStart();
  else if (!followRun) chrome.alarms?.clear(FOLLOW_ALARM);
}

// ===== 关注 / 特别关注 / 动态 / AI =====

// gone (with act 2): the 已取消关注 record a 重新关注 took, put back as it was when that 重新关注 is undone.
async function followRelation({ mid, act, gone }) {
  mid = String(mid ?? "");
  act = Number(act);
  if (!/^\d+$/.test(mid) || (act !== 1 && act !== 2)) throw triageError("缺少 mid 或 act 不对");
  await triageBiliPost("/x/relation/modify", { fid: mid, act, re_src: 11 });
  const at = followNow();
  await followUpdate(["follow_list", "follow_unfollowed", "follow_tag_map", "follow_tags"], (s) => {
    const f = s.follow_list || {};
    const unf = { ...s.follow_unfollowed };
    const tagMap = { ...s.follow_tag_map };
    const followTime = { ...f.followTime };
    const special = { ...f.special };
    const groups = { ...f.groups };
    const list = (f.list || []).filter((x) => x !== mid);
    if (act === 2) {
      // 重复取关不覆盖已有记录；标签挪进记录。撤销重新关注时放回原记录。
      if (gone && typeof gone === "object") unf[mid] = { at: Number(gone.at) || at, tagIds: (Array.isArray(gone.tagIds) ? gone.tagIds : []).map(String), source: gone.source === "bili" ? "bili" : "app" };
      else if (!unf[mid]) unf[mid] = { at, tagIds: tagMap[mid] || [], source: "app" };
      delete tagMap[mid];
      delete followTime[mid];
      delete special[mid];
      delete groups[mid]; // B站 取关时分组一起没了
    } else {
      const live = new Set((s.follow_tags || []).map((t) => t.id));
      const ids = (unf[mid]?.tagIds || []).filter((id) => live.has(id));
      if (ids.length && !tagMap[mid]?.length) tagMap[mid] = ids;
      delete unf[mid];
      followTime[mid] = at;
      list.unshift(mid);
    }
    return { follow_list: { ...f, list, followTime, special, groups }, follow_unfollowed: unf, follow_tag_map: tagMap };
  });
  return {};
}

// 关掉时从 -10 挪回原来的分组（没有就默认分组 0），关注本身不变。
async function followSpecial({ mid, on }) {
  mid = String(mid ?? "");
  const f = (await chrome.storage.local.get("follow_list")).follow_list || {};
  if (!f.list?.includes(mid)) throw triageError("还没关注这个人，不能设特别关注");
  if (on) await triageBiliPost("/x/relation/tags/copyUsers", { fids: mid, tagids: -10 });
  else await triageBiliPost("/x/relation/tags/moveUsers", { fids: mid, beforeTagids: -10, afterTagids: (f.groups?.[mid]?.length ? f.groups[mid] : [0]).join(",") });
  await followUpdate(["follow_list"], (s) => {
    const special = { ...s.follow_list?.special };
    if (on) special[mid] = 1;
    else delete special[mid];
    return { follow_list: { ...s.follow_list, special } };
  });
  return {};
}

const FOLLOW_FEED_TTL_MS = 3 * 60 * 1000;
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

// Posts seen in the live feed are newer than the last sync: fold them into follow_last so 「最近更新」 and 更新状态
// on the UP 主 tab match the 动态 tab without a full 刷新. Only map / v grow; at and since (the sync's coverage) stay.
async function followNoteFeedPosts(items) {
  if (!items?.length) return;
  await followUpdate(["follow_last"], (s) => {
    const L = s.follow_last;
    if (!L?.map) return null;
    let changed = false;
    L.v ||= {};
    for (const it of items) {
      if (!it.mid || !it.at) continue;
      if (it.at > (L.map[it.mid] || 0)) { L.map[it.mid] = it.at; changed = true; }
      const v = L.v[it.mid] || [];
      if (!v.some((x) => x.c === it.at && x.t === it.title)) {
        L.v[it.mid] = [...v, { t: it.title, c: it.at }].sort((x, y) => y.c - x.c).slice(0, 3);
        changed = true;
      }
    }
    return changed ? { follow_last: L } : null;
  });
}

async function followAiTag({ instruction, mids, tags, maxNewTags, allowRemove }) {
  const s = await chrome.storage.local.get(["follow_list", "follow_people", "follow_content", "follow_last", "follow_tags", "follow_tag_map"]);
  const followed = new Set(s.follow_list?.list || []);
  const list = [...new Set((Array.isArray(mids) ? mids : []).map(String))].filter((m) => followed.has(m));
  if (!list.length) throw triageError("缺少 mids");
  const tagName = new Map((s.follow_tags || []).map((t) => [t.id, t.name]));
  const items = list.map((mid) => {
    const p = s.follow_people?.[mid] || {};
    const c = s.follow_content?.[mid];
    const top = Object.entries(c?.tlist || {}).sort((a, b) => b[1] - a[1])[0];
    const v = s.follow_last?.v?.[mid]?.length ? s.follow_last.v[mid] : c?.v || [];
    return {
      bvid: mid, // triageParseCommand 按 bvid 认条目
      name: p.name,
      sign: p.sign,
      tname: top?.[0] || "",
      titles: v.map((x) => x.t),
      currentTags: (s.follow_tag_map?.[mid] || []).map((id) => tagName.get(id)).filter(Boolean)
    };
  });
  const tagList = Array.isArray(tags) ? tags : (s.follow_tags || []).map((t) => ({ name: t.name, rule: t.rule || "" }));
  // 关注's own settings (follow_ai_settings, written by the page's 关注设置); the 收藏夹 values only before it exists.
  const set = await chrome.storage.sync.get({ follow_ai_settings: null, triageAiNewTagMax: 5, triageAiRemoveTags: false });
  const own = set.follow_ai_settings || {};
  return triageAiCommand({
    instruction,
    items,
    tags: tagList,
    maxNewTags: maxNewTags ?? own.newTagMax ?? set.triageAiNewTagMax,
    allowRemove: (allowRemove ?? own.allowRemove ?? set.triageAiRemoveTags) === true
  }, FOLLOW_AI_UNIT);
}

const FOLLOW_HANDLERS = {
  "follow-sync": async () => (await followStart(), {}),
  "follow-sync-stop": async () => (await followStop(), {}),
  "follow-feed": (msg) => followFeed(msg),
  "follow-relation": (msg) => followRelation(msg),
  "follow-special": (msg) => followSpecial(msg),
  "follow-ai-tag": (msg) => followAiTag(msg)
};

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  followResume().catch((e) => console.warn("[follow] 接着同步失败", e));
  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === FOLLOW_ALARM) followResume().catch((e) => console.warn("[follow] 接着同步失败", e));
  });
  triageListen("follow-", FOLLOW_HANDLERS);
}
