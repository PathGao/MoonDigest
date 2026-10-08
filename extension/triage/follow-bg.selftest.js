// /usr/local/bin/node extension/triage/follow-bg.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({ TextEncoder, URL, URLSearchParams, console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController });
// The worker's own load order: every file background.js importScripts, in that order.
const order = [...fs.readFileSync(path.join(__dirname, "../background.js"), "utf8").matchAll(/importScripts\(([^)]*)\)/g)].flatMap((m) => m[1].match(/"[^"]+"/g).map((f) => JSON.parse(f)));
const load = (c) => order.forEach((file) => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), c));
const FAST = "Object.assign(FOLLOW_CFG, { gapMs: 0, jitterMs: 0, backoffMs: 5, emptyRetryMs: 0, netRetry: [1, 1, 1] }); TRIAGE_BILI_CFG.timeoutMs = 40;";
load(ctx);
vm.runInContext(FAST, ctx);
const t = ctx;
const plain = (x) => JSON.parse(JSON.stringify(x));
const now = () => Math.floor(Date.now() / 1000);

// ---- fake chrome: storage + csrf cookie ----
let local = {};
let sync = {};
const pick = (store, keys) => {
  if (keys == null) return { ...store };
  if (typeof keys === "string") keys = [keys];
  if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, plain(store[k])]));
  return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in store ? plain(store[k]) : d]));
};
t.chrome = {
  storage: {
    local: { get: async (k) => pick(local, k), set: async (o) => void Object.assign(local, plain(o)), remove: async (k) => [k].flat().forEach((x) => delete local[x]) },
    sync: { get: async (k) => pick(sync, k) }
  },
  cookies: { get: async () => ({ value: "csrf" }) },
  runtime: { getPlatformInfo: async () => ({}) }
};

// ---- fake B站 ----
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
let calls = [];
let posts = [];
let routes = {};
let postReply = null; // () => a fetch answer (or a promise that never settles) for the next POSTs; null = code 0
t.fetch = async (url, init = {}) => {
  if (init.method === "POST") {
    posts.push([url.replace("https://api.bilibili.com", ""), Object.fromEntries(new URLSearchParams(init.body))]);
    return postReply ? postReply() : json({ code: 0, data: {} });
  }
  const u = new URL(url);
  calls.push(u.pathname.replace(/^\/x\//, "") + (u.searchParams.get("mid") ? `#${u.searchParams.get("mid")}` : u.searchParams.has("pn") ? `#${u.searchParams.get("pn")}` : u.searchParams.has("offset") ? `#${u.searchParams.get("offset") || "0"}` : ""));
  const r = routes[u.pathname];
  if (!r) throw new Error(`no route ${u.pathname}`);
  return r(u);
};
const key32 = "abcdefghijklmnopqrstuvwxyz012345";
const nav = () => json({ code: 0, data: { isLogin: true, mid: 1000, wbi_img: { img_url: `https://i0/${key32}.png`, sub_url: `https://i0/${key32.split("").reverse().join("")}.png` } } });
const person = (mid, extra = {}) => ({ mid: Number(mid), uname: `UP${mid}`, face: `f${mid}`, sign: `签名${mid}`, mtime: 100 + Number(mid), tag: null, ...extra });
const followings = (pages, total) => (u) => json({ code: 0, data: { total, list: pages[Number(u.searchParams.get("pn")) - 1] || [] } });
const dyn = (mid, bvid, at) => ({
  modules: { module_author: { mid, name: `UP${mid}`, face: "", pub_ts: at }, module_dynamic: { major: { archive: { bvid, aid: 1, title: `T-${bvid}`, cover: "http://c", duration_text: "1:02:03", stat: { play: "1.5万" } } } } }
});
const feed = (pages) => (u) => {
  const i = Number(u.searchParams.get("offset") || 0);
  return json({ code: 0, data: { items: pages[i], offset: String(i + 1), has_more: i + 1 < pages.length } });
};
const arcOk = (count) => json({ code: 0, data: { page: { count }, list: { tlist: { 1: { name: "知识", count }, 2: { name: "游戏", count: 1 } }, vlist: [1, 2, 3, 4].map((n) => ({ title: `v${n}`, created: 50 - n })) } } });
// A hang (an endless retry) fails instead of running forever.
setTimeout(() => {
  console.error("follow-bg selftest: timed out");
  process.exit(1);
}, 15000).unref();
let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.error("follow-bg selftest: ended before the last check");
    process.exitCode = 1;
  }
});
const runSync = async () => {
  await t.followStart();
  await vm.runInContext("followRun && followRun.promise", ctx);
};

(async () => {
  // ---------- pure: followings diff ----------
  {
    const cur = { list: ["1", "2", "9"], followTime: { 1: 10, 2: 10, 9: 10 } };
    const live = new Set(["a"]);
    const d = t.followDiff(cur, { list: ["1", "2"], followTime: { 1: 10, 2: 10 }, complete: true }, {}, { 9: ["a", "x"] }, live, 500, 600);
    assert.deepStrictEqual(plain(d.gone), { 9: { at: 600, tagIds: ["a", "x"], source: "bili" } }, "vanished account recorded with its tags");
    const partial = t.followDiff(cur, { list: ["1"], followTime: { 1: 10 }, complete: false }, {}, {}, live, 500, 600);
    assert.deepStrictEqual(plain(partial.gone), {}, "a partial fetch never marks anyone gone");
    // 新关注 +N · 取关 −M: only from a complete fetch against a list we had
    assert.deepStrictEqual(plain(d.changes), { at: 600, added: [], removed: ["9"] });
    assert.strictEqual(partial.changes, null, "a partial fetch gives no changes");
    const grew = t.followDiff(cur, { list: ["5", "1", "2", "9"], followTime: {}, complete: true }, {}, {}, live, 500, 600);
    assert.deepStrictEqual(plain(grew.changes), { at: 600, added: ["5"], removed: [] });
    assert.strictEqual(t.followDiff({}, { list: ["1"], followTime: {}, complete: true }, {}, {}, live, 500, 600).changes, null, "the first sync lists nobody as new");
    // re-follow only when the follow time is newer than the unfollow
    const unf = { 3: { at: 200, tagIds: ["a", "dead"] }, 4: { at: 200 } };
    const r = t.followDiff({ list: [] }, { list: ["3", "4"], followTime: { 3: 300, 4: 150 }, complete: true }, unf, {}, live, 500, 600);
    assert.deepStrictEqual(plain(r.back), ["3"]);
    assert.deepStrictEqual(plain(r.restore), { 3: ["a"] }, "only tags that still exist come back");
    assert.deepStrictEqual(plain(r.list.list), ["3"], "an old follow time keeps the unfollow record");
    // a follow made here during the sync and not on B站's list yet is kept, and not marked gone
    const k = t.followDiff({ list: ["7"], followTime: { 7: 550 } }, { list: [], complete: true }, {}, {}, live, 500, 600);
    assert.deepStrictEqual(plain(k.list.list), ["7"]);
    assert.deepStrictEqual(plain(k.gone), {});
  }

  // ---------- pure: feed item, arc record, folding ----------
  {
    const it = t.followFeedItem(dyn(5, "BV5", 999));
    assert.deepStrictEqual(plain(it), { bvid: "BV5", aid: "1", title: "T-BV5", cover: "https://c", duration: 3723, play: 15000, mid: "5", name: "UP5", face: "", at: 999 });
    assert.strictEqual(t.followFeedItem({ modules: { module_dynamic: { major: { type: "MAJOR_TYPE_UGC_SEASON" } } } }), null);
    const last = t.followFoldFeed({ since: 1000, map: {}, v: {} }, [1, 2, 3, 4].map((n) => t.followFeedItem(dyn(5, `BV${n}`, 900 - n))));
    assert.strictEqual(last.map[5], 899);
    assert.strictEqual(last.since, 896);
    assert.deepStrictEqual(plain(last.v[5].map((x) => x.bvid)), ["BV1", "BV2", "BV3"], "≤3 newest titles");
    const rec = t.followArcRecord((await arcOk(7).json()).data);
    assert.deepStrictEqual(plain(rec), { code: 0, count: 7, tlist: { 知识: 7, 游戏: 1 }, v: [{ t: "v1", c: 49 }, { t: "v2", c: 48 }, { t: "v3", c: 47 }] });
  }

  // ---------- full sync: diff, feed first, arc only for unseen, permanent vs temporary ----------
  {
    local = {
      follow_list: { list: ["1", "9"], followTime: { 1: 101, 9: 50 } },
      follow_tag_map: { 9: ["t1"], 1: ["t1"] },
      follow_tags: [{ id: "t1", name: "知识区" }],
      follow_content: { 4: { code: 0, count: 1, tlist: {}, v: [], at: now() } } // fresh record: skipped
    };
    sync = { followSlowDays: 30 };
    calls = [];
    const old = now() - 40 * 86400;
    routes = {
      "/x/web-interface/nav": nav,
      "/x/relation/stat": (u) => json({ code: 0, data: { follower: 10 * Number(u.searchParams.get("vmid")) } }),
      "/x/relation/followings": followings([[person(1), person(2, { special: 1, tag: [-10, 7] })], [person(3), person(4), person(5), person(6)]], 6),
      "/x/relation/tags": () => json({ code: 0, data: [{ tagid: -10, name: "特别关注", count: 1 }, { tagid: 0, name: "默认分组", count: 5 }, { tagid: 7, name: "数码", count: 1 }] }),
      "/x/polymer/web-dynamic/v1/feed/all": feed([[dyn(2, "BV2", now() - 60)], [dyn(3, "BV3", old)], [dyn(6, "BV6", now())]]),
      "/x/space/wbi/arc/search": (u) => {
        const mid = u.searchParams.get("mid");
        assert.ok(u.searchParams.get("w_rid"), "arc/search is WBI-signed");
        if (mid === "5") return json({ code: -404, message: "啥都木有" });
        if (mid === "6") return json({ code: 500, message: "服务器错误" });
        return arcOk(3);
      }
    };
    await runSync();
    const j = local.follow_jobs;
    assert.strictEqual(j.running, false);
    assert.ok(j.finishedAt && !j.error, j.error);
    assert.deepStrictEqual(plain(local.follow_list.list), ["1", "2", "3", "4", "5", "6"]);
    assert.deepStrictEqual(plain(local.follow_list.special), { 2: 1 });
    assert.deepStrictEqual(plain(local.follow_list.groups), { 2: [7] });
    assert.deepStrictEqual(plain(local.follow_groups), [{ id: 7, name: "数码", count: 1 }], "B站 分组 names stored, 默认分组 and 特别关注 left out");
    assert.strictEqual(calls.filter((c) => c === "relation/tags").length, 1, "group names fetched once per sync");
    assert.strictEqual(local.follow_unfollowed[9].source, "bili");
    assert.deepStrictEqual([plain(local.follow_jobs.changes.added), plain(local.follow_jobs.changes.removed)], [["2", "3", "4", "5", "6"], ["9"]], "the sync's changes reach follow_jobs");
    assert.deepStrictEqual(plain(local.follow_unfollowed[9].tagIds), ["t1"]);
    assert.ok(!local.follow_tag_map[9] && local.follow_tag_map[1], "the vanished account's tags moved into the record");
    assert.strictEqual(local.follow_people[2].name, "UP2");
    // the feed stops once it is past slowDays (page 3 never asked)
    assert.ok(!calls.includes("polymer/web-dynamic/v1/feed/all#2"), calls.join(","));
    assert.deepStrictEqual(Object.keys(local.follow_last.map).sort(), ["2", "3"]);
    assert.strictEqual(local.follow_last.since, old);
    // arc/search only for followings missing from the feed and without a fresh record: 1, 5, 6
    assert.deepStrictEqual(calls.filter((c) => c.startsWith("space")), ["space/wbi/arc/search#1", "space/wbi/arc/search#5", "space/wbi/arc/search#6"]);
    assert.strictEqual(local.follow_content[1].count, 3);
    assert.strictEqual(local.follow_content[5].code, -404, "a gone account is recorded");
    assert.ok(!local.follow_content[6], "a temporary error is not recorded");
    assert.strictEqual(local.follow_content[4].count, 1, "a fresh record is not asked again");

    // second run: feed is fresh (skipped), 6 is asked again, 1 and 5 are not; a record older than since is asked again
    local.follow_content[1].at = old - 1;
    calls = [];
    routes["/x/space/wbi/arc/search"] = () => arcOk(2);
    await runSync();
    assert.ok(!calls.some((c) => c.startsWith("polymer")), "fresh feed skipped");
    assert.deepStrictEqual(calls.filter((c) => c.startsWith("space")), ["space/wbi/arc/search#1", "space/wbi/arc/search#6"]);
  }

  // ---------- a feed walk cut off midway keeps the last complete one; continue finishes it ----------
  {
    const prev = { at: now() - 7 * 3600, since: now() - 40 * 86400, map: { 1: now() - 99, 4: now() - 99 }, v: {} };
    local = { follow_list: { list: ["1", "2", "4"], followTime: { 1: 101, 2: 102, 4: 104 } }, follow_last: prev };
    const pages = Array.from({ length: 12 }, (_, i) => [dyn(2, `BVw${i}`, now() - i)]);
    pages.push([dyn(4, "BVend", now() - 40 * 86400)]);
    const ok = feed(pages);
    routes["/x/polymer/web-dynamic/v1/feed/all"] = (u) => (Number(u.searchParams.get("offset") || 0) === 11 ? json({ code: -352, message: "风控" }) : ok(u));
    await runSync();
    assert.strictEqual(local.follow_jobs.throttled, true);
    assert.deepStrictEqual(plain(local.follow_last), prev, "a walk cut off midway does not replace the last complete one");
    assert.strictEqual(local.follow_jobs.cursor.offset, "10", "cursor kept");
    routes["/x/polymer/web-dynamic/v1/feed/all"] = ok;
    calls = [];
    await runSync();
    assert.ok(local.follow_jobs.finishedAt && !local.follow_jobs.error, local.follow_jobs.error);
    assert.ok(!calls.includes("polymer/web-dynamic/v1/feed/all#0"), "continue picks up at the cursor");
    assert.deepStrictEqual(Object.keys(local.follow_last.map).sort(), ["2", "4"], "the finished walk replaces it");
    assert.ok(!local.follow_last_wip, "the walk in progress is cleared");
  }

  // ---------- partial followings: nobody marked gone ----------
  {
    local = { follow_list: { list: ["1", "9"], followTime: {} }, follow_last: { at: now(), since: 0, map: { 1: 1 } } };
    routes = { ...routes, "/x/relation/followings": followings([[person(1)]], 5) };
    await runSync();
    assert.ok(!local.follow_jobs.error, local.follow_jobs.error);
    assert.strictEqual(local.follow_list.complete, false);
    assert.strictEqual(local.follow_jobs.changes, null, "a partial sync shows no changes");
    assert.deepStrictEqual(local.follow_unfollowed || {}, {});
  }

  // ---------- risk control: back off, then THROTTLED after three strikes ----------
  {
    local = { follow_list: { list: ["1"] }, follow_last: { at: now(), since: 0, map: {} }, follow_jobs: { cursor: { phase: "arc" }, startedAt: now() } };
    let holds = 0;
    routes["/x/space/wbi/arc/search"] = () => (holds++, json({ code: -352, message: "风控" }));
    calls = [];
    await runSync();
    assert.strictEqual(holds, 3);
    // The WBI key was cached by the syncs above; each risk answer drops it, so strikes 2 and 3 read nav again.
    assert.strictEqual(calls.filter((c) => c === "web-interface/nav").length, 2, calls.join(","));
    assert.strictEqual(local.follow_jobs.throttled, true);
    assert.match(local.follow_jobs.error, /限流/);
    assert.ok(!local.follow_content?.[1]);
    // HTTP 412 counts the same; the third strike stops
    holds = 0;
    routes["/x/space/wbi/arc/search"] = () => (holds++, holds < 3 ? json({}, 412) : arcOk(1));
    await runSync();
    assert.ok(!local.follow_jobs.error && local.follow_content[1].count === 1, "recovers within three strikes");
  }

  // ---------- resume after the worker is killed; stop / continue ----------
  {
    local = {
      follow_list: { list: ["1", "2", "3"] },
      follow_last: { at: now(), since: 0, map: {} },
      follow_content: { 1: { code: 0, count: 1, tlist: {}, v: [], at: now() } },
      follow_jobs: { running: true, phase: "arc", cursor: { phase: "arc" }, startedAt: now() - 60 } // a killed worker left this
    };
    calls = [];
    routes["/x/space/wbi/arc/search"] = () => arcOk(1);
    await t.followResume();
    await vm.runInContext("followRun && followRun.promise", ctx);
    assert.deepStrictEqual(calls.filter((c) => c.startsWith("space")), ["space/wbi/arc/search#2", "space/wbi/arc/search#3"], "resumes at its cursor");
    assert.strictEqual(local.follow_jobs.running, false);

    // stop lands mid-request; continue picks up where it was
    local.follow_content = {};
    local.follow_jobs = { cursor: { phase: "arc" }, startedAt: now() };
    calls = [];
    let release;
    routes["/x/space/wbi/arc/search"] = (u) => (u.searchParams.get("mid") === "2" ? new Promise((r) => (release = r)) : arcOk(1));
    vm.runInContext("TRIAGE_BILI_CFG.timeoutMs = 5000", ctx);
    await t.followStart();
    while (!release) await new Promise((r) => setTimeout(r, 5));
    await t.followStop();
    assert.strictEqual(local.follow_jobs.running, false);
    assert.ok(!local.follow_jobs.error, "a stop is not an error");
    assert.deepStrictEqual(local.follow_jobs.cursor, { phase: "arc" }, "cursor kept for continue");
    assert.ok(local.follow_content[1] && !local.follow_content[2]);
    release(arcOk(1));
    routes["/x/space/wbi/arc/search"] = () => arcOk(1);
    calls = [];
    await runSync();
    vm.runInContext("TRIAGE_BILI_CFG.timeoutMs = 40", ctx);
    assert.deepStrictEqual(calls.filter((c) => c.startsWith("space")), ["space/wbi/arc/search#2", "space/wbi/arc/search#3"]);
    assert.ok(local.follow_jobs.finishedAt);
  }

  // ---------- follower counts: after the statuses, 7-day skip, resume, permanent vs temporary ----------
  {
    const stat = (u) => u.searchParams.get("vmid");
    local = {
      follow_list: { list: ["1", "2", "3", "4", "5"] },
      follow_last: { at: now(), since: 0, map: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 } }, // everyone in the feed: no arc/search
      follow_stats: { 1: { follower: 7, at: now() - 6 * 86400 }, 2: { follower: 7, at: now() - 8 * 86400 } },
      follow_jobs: { cursor: { phase: "arc" }, startedAt: now() }
    };
    let statusAtSeen = 0;
    const asked = [];
    routes["/x/relation/stat"] = (u) => {
      asked.push(stat(u));
      statusAtSeen ||= local.follow_jobs.statusAt && local.follow_jobs.phase === "stats" ? 1 : 0;
      if (stat(u) === "4") return json({ code: -404, message: "啥都木有" });
      if (stat(u) === "5") return json({ code: -500, message: "服务器错误" });
      return json({ code: 0, data: { follower: 100 } });
    };
    await runSync();
    assert.ok(statusAtSeen, "statusAt is written before the follower counts start");
    assert.deepStrictEqual(asked, ["2", "3", "4", "5"], "a count younger than 7 days is skipped");
    assert.strictEqual(local.follow_stats[1].follower, 7);
    assert.strictEqual(local.follow_stats[2].follower, 100);
    assert.strictEqual(local.follow_stats[4].code, -404, "a gone account is recorded");
    assert.ok(!local.follow_stats[5], "a temporary error is not recorded");
    assert.strictEqual(local.follow_jobs.skipped, 1);
    assert.match(local.follow_jobs.step, /^$/, "step cleared when finished");
    assert.ok(local.follow_jobs.finishedAt && local.follow_jobs.statusAt);

    // resume: a killed worker at the stats cursor asks only what is left, and redoes no arc/search
    local.follow_stats = { 1: { follower: 1, at: now() } };
    local.follow_last.map = { 1: 1 }; // 2–5 have no content record: a restart from the arc phase would ask them
    local.follow_jobs = { running: true, phase: "stats", cursor: { phase: "stats" }, startedAt: now() - 60, statusAt: 5 };
    asked.length = 0;
    calls = [];
    let steps = [];
    routes["/x/relation/stat"] = (u) => (asked.push(stat(u)), steps.push(local.follow_jobs.step), json({ code: 0, data: { follower: 1 } }));
    await t.followResume();
    await vm.runInContext("followRun && followRun.promise", ctx);
    assert.deepStrictEqual(asked, ["2", "3", "4", "5"]);
    assert.ok(!calls.some((c) => c.startsWith("space") || c.startsWith("polymer")));
    assert.strictEqual(local.follow_jobs.statusAt, 5, "a resumed stats phase does not touch statusAt");
    assert.strictEqual(steps[0], "查粉丝数 1/5");
    assert.strictEqual(steps[1], "查粉丝数 2/5");
  }

  // ---------- feed page: timeout retried, cache ----------
  {
    let n = 0;
    routes["/x/polymer/web-dynamic/v1/feed/all"] = () => (++n === 1 ? new Promise(() => {}) : json({ code: 0, data: { items: [dyn(8, "BV8", 5), { modules: {} }], offset: "o2", has_more: true } }));
    local.follow_last = { at: 1, since: 0, map: { 8: 3 }, v: { 8: [{ t: "old", c: 3 }] } };
    const page = await t.followFeed({ offset: "" });
    assert.strictEqual(n, 2, "a request with no answer in time is retried");
    assert.strictEqual(local.follow_last.map[8], 5, "a newer post seen in the feed updates 最近更新");
    assert.strictEqual(local.follow_last.v[8][0].c, 5, "and leads its recent titles");
    assert.deepStrictEqual([local.follow_last.at, local.follow_last.since], [1, 0], "the sync's coverage is untouched");
    assert.deepStrictEqual(plain(local.follow_last.v[8][0]), { t: "T-BV8", c: 5, bvid: "BV8" }, "the same entry shape as a sync, with its bvid");
    await t.followNoteFeedPosts([{ ...page.items[0], title: "改了标题" }]);
    t.followFoldFeed(local.follow_last, page.items);
    assert.strictEqual(local.follow_last.v[8].length, 2, "the same video is not noted twice (by bvid)");
    assert.deepStrictEqual([local.follow_last.at, local.follow_last.since], [1, 0]);
    assert.deepStrictEqual(plain(page.items.map((x) => x.bvid)), ["BV8"]);
    assert.deepStrictEqual([page.offset, page.hasMore], ["o2", true]);
    await t.followFeed({ offset: "" });
    assert.strictEqual(n, 2, "cached");
    // A finished 刷新 drops the cache: 动态 then shows what the sync found.
    await runSync();
    const afterSync = n;
    await t.followFeed({ offset: "" });
    assert.strictEqual(n, afterSync + 1, "read again after a sync");
  }

  // ---------- relation / special: local stores updated after success ----------
  {
    local = {
      follow_list: { list: ["1", "2"], followTime: { 1: 10, 2: 10 }, special: { 1: 1 }, groups: { 1: [5] } },
      follow_tag_map: { 1: ["a", "b"] },
      follow_tags: [{ id: "a", name: "A" }]
    };
    posts = [];
    await t.followRelation({ mid: 1, act: 2 });
    assert.deepStrictEqual(posts[0], ["/x/relation/modify", { fid: "1", act: "2", re_src: "11", csrf: "csrf" }]);
    const rec = local.follow_unfollowed[1];
    assert.deepStrictEqual([rec.source, plain(rec.tagIds)], ["app", ["a", "b"]]);
    assert.ok(!local.follow_tag_map[1] && !local.follow_list.list.includes("1") && !local.follow_list.special[1] && !local.follow_list.groups[1]);
    local.follow_unfollowed[1].at = 1;
    await t.followRelation({ mid: "1", act: 2 });
    assert.strictEqual(local.follow_unfollowed[1].at, 1, "unfollow twice keeps the first record");
    await t.followRelation({ mid: "1", act: 1 });
    assert.ok(!local.follow_unfollowed[1]);
    assert.deepStrictEqual(plain(local.follow_tag_map[1]), ["a"], "tags that still exist come back");
    assert.strictEqual(local.follow_list.list[0], "1");
    assert.ok(local.follow_list.followTime[1] >= now() - 5);
    await assert.rejects(t.followRelation({ mid: "x", act: 2 }), /mid/);
    // U on a single 重新关注: unfollow again with the record it took, which comes back as it was (not a new 在这里取关).
    await t.followRelation({ mid: "1", act: 2, gone: { at: 7, tagIds: ["a", "b"], source: "bili", extra: "<x>" } });
    assert.deepStrictEqual(plain(local.follow_unfollowed[1]), { at: 7, tagIds: ["a", "b"], source: "bili" });
    assert.ok(!local.follow_tag_map[1] && !local.follow_list.list.includes("1"));
    await t.followRelation({ mid: "1", act: 1 });

  }

  // ---------- 关注分组: B站 params, follow_list / follow_groups changed only after B站 said yes ----------
  {
    local = {
      follow_list: { list: ["1", "2", "3"], special: { 1: 1 }, groups: { 1: [5], 2: [5, 6] } },
      follow_groups: [{ id: 5, name: "五", count: 2 }, { id: 6, name: "六", count: 1 }]
    };
    posts = [];
    const g = () => plain(local.follow_list.groups);
    // 复制 (no from): copyUsers; the ones copied keep their groups.
    await t.followGroupMove({ mids: ["2", "3"], from: [], to: [7] });
    assert.deepStrictEqual(posts[0], ["/x/relation/tags/copyUsers", { fids: "2,3", tagids: "7", csrf: "csrf" }]);
    assert.deepStrictEqual(g(), { 1: [5], 2: [5, 6, 7], 3: [7] });
    // 移动: moveUsers from → to.
    await t.followGroupMove({ mids: ["2"], from: [5], to: [8] });
    assert.deepStrictEqual(posts[1], ["/x/relation/tags/moveUsers", { fids: "2", beforeTagids: "5", afterTagids: "8", csrf: "csrf" }]);
    assert.deepStrictEqual(g()[2], [6, 7, 8]);
    // 特别关注 is group -10: in and out through the same calls; out to 默认分组 (0) leaves no group.
    await t.followGroupMove({ mids: ["3"], from: [], to: [-10] });
    assert.deepStrictEqual([posts[2][1].tagids, local.follow_list.special[3]], ["-10", 1]);
    await t.followGroupMove({ mids: ["1"], from: [-10], to: [5] });
    assert.deepStrictEqual([posts[3][1].beforeTagids, posts[3][1].afterTagids], ["-10", "5"]);
    assert.ok(!local.follow_list.special[1] && g()[1].length === 1, "out of 特别关注, still in 五 once");
    await t.followGroupMove({ mids: ["3"], from: [7], to: [0] });
    assert.ok(!(3 in g()) && local.follow_list.special[3] === 1, "the last own group left: 默认分组, 特别关注 kept");
    // Refused before anything is sent.
    const sent = posts.length;
    await assert.rejects(t.followGroupMove({ mids: ["9"], from: [], to: [5] }), /还没关注/);
    await assert.rejects(t.followGroupMove({ mids: ["1"], from: [], to: [0] }), /默认分组/);
    await assert.rejects(t.followGroupMove({ mids: ["x"], from: [], to: [5] }), /缺少/);
    await assert.rejects(t.followGroupMove({ mids: ["1"], from: [5], to: [] }), /缺少/);
    assert.strictEqual(posts.length, sent);

    // B站 says no, or no answer in time: nothing changes here; the timeout says to look.
    const before = JSON.stringify(local);
    postReply = () => json({ code: 22104, message: "分组不存在" });
    await assert.rejects(t.followGroupMove({ mids: ["2"], from: [], to: [99] }), /22104/);
    await assert.rejects(t.followGroupCreate({ name: "新" }), /22104/);
    postReply = () => new Promise(() => {});
    await assert.rejects(t.followGroupMove({ mids: ["2"], from: [6], to: [5] }), (e) => e.code === "NETWORK" && /不确定 B站 是否已改，刷新后看一下/.test(e.message));
    await assert.rejects(t.followGroupRename({ id: 5, name: "x" }), (e) => e.code === "NETWORK");
    await assert.rejects(t.followGroupDelete({ id: 5 }), (e) => e.code === "NETWORK");
    postReply = null;
    assert.strictEqual(JSON.stringify(local), before, "no local change without B站's yes");

    // 新建 / 改名 / 删除.
    postReply = () => json({ code: 0, data: { tagid: 42 } });
    assert.deepStrictEqual(plain(await t.followGroupCreate({ name: "  学习  " })), { id: 42, name: "学习" });
    postReply = null;
    assert.deepStrictEqual(posts.at(-1), ["/x/relation/tag/create", { tag: "学习", csrf: "csrf" }]);
    assert.deepStrictEqual(plain(local.follow_groups.at(-1)), { id: 42, name: "学习", count: 0 });
    await assert.rejects(t.followGroupCreate({ name: "一二三四五六七八九十一二三四五六七" }), /16/, "17 characters");
    await assert.rejects(t.followGroupCreate({ name: " " }), /不能为空/);
    await t.followGroupRename({ id: 6, name: "六六" });
    assert.deepStrictEqual(posts.at(-1), ["/x/relation/tag/update", { tagid: "6", name: "六六", csrf: "csrf" }]);
    assert.strictEqual(local.follow_groups.find((x) => x.id === 6).name, "六六");
    await assert.rejects(t.followGroupRename({ id: -10, name: "x" }), /固定/);
    await assert.rejects(t.followGroupDelete({ id: 0 }), /固定/);
    await t.followGroupDelete({ id: 5 });
    assert.deepStrictEqual(posts.at(-1), ["/x/relation/tag/del", { tagid: "5", csrf: "csrf" }]);
    assert.ok(!local.follow_groups.some((x) => x.id === 5));
    assert.deepStrictEqual(g(), { 2: [6, 7, 8] }, "members lose the group; 1 (only in 五) is back in 默认分组");
    assert.deepStrictEqual(plain(t.followGroupsApply([-10, 5], [5], [0])), [-10]);
  }

  // ---------- AI proposal ----------
  {
    // The checks, the 0–50 cap and the parsing are triage-bg.js's triageAiCommand; 关注 only builds the UP 主 items.
    assert.ok(!/triageChat\(|triageParseCommand\(|Math\.min\(50/.test(fs.readFileSync(path.join(__dirname, "follow-bg.js"), "utf8")), "follow-bg.js has its own AI command");
    assert.strictEqual(t.followAiLine({ name: "U|p", sign: "s\nx", tname: "知识", titles: ["a", "b"], currentTags: ["A"] }, 2), "2|U p|s x|知识|a；b|A");
    local = {
      follow_list: { list: ["1", "2"] },
      follow_people: { 1: { name: "甲", sign: "讲物理" }, 2: { name: "乙" } },
      follow_content: { 1: { tlist: { 游戏: 2, 知识: 9 }, v: [{ t: "量子" }] } },
      follow_last: { v: { 2: [{ t: "新番" }] } },
      follow_tags: [{ id: "a", name: "硬核", rule: "讲科学" }],
      follow_tag_map: { 2: ["a"] }
    };
    sync = {};
    let sent;
    t.triageChat = async (messages, maxTokens, thinking) => {
      sent = { messages, maxTokens, thinking };
      return { content: '{"new_tags":["动画","x1","x2","x3","x4","x5"],"items":[{"i":1,"add":["硬核","不存在"]},{"i":2,"add":["动画"],"remove":["硬核"]}],"note":"好"}' };
    };
    const r = plain(await t.followAiTag({ instruction: "按内容分", mids: [1, "2", "99"] }));
    assert.ok(sent.messages[1].content.endsWith("1|甲|讲物理|知识|量子|\n2|乙|||新番|硬核"), sent.messages[1].content);
    assert.ok(sent.messages[0].content.includes("硬核：讲科学") && sent.messages[0].content.includes("remove 留空"), "add-only by default");
    // 关注's rules are 收藏夹's word for word with 视频 → UP 主; only the 依据 line is its own.
    const rules = (s) => s.slice(s.indexOf("规则："), s.indexOf("只输出")).split("\n").filter((l) => !l.includes("主要依据"));
    const video = t.triageBuildCommandMessages({ instruction: "x", tags: [], items: [] })[0].content.replaceAll("视频", " UP 主");
    assert.deepStrictEqual(rules(sent.messages[0].content), rules(video), "video and UP prompts share their rule lines");
    assert.ok(rules(video).length > 6);
    assert.strictEqual(sent.thinking, false);
    assert.deepStrictEqual(r.newTags, ["动画", "x1", "x2", "x3", "x4"], "new-tag cap 5");
    assert.deepStrictEqual(r.assignments, { 1: { add: ["硬核"], remove: [] }, 2: { add: ["动画"], remove: [] } }, "unknown tags and removes dropped; 99 not followed");
    const chat = t.triageChat;
    t.triageChat = async (...a) => (await chat(...a), { content: '{"new_tags":["新"],"items":[{"i":1,"add":["新"],"remove":["硬核"]}],"note":"n"}' });
    const r2 = plain(await t.followAiTag({ instruction: "x", mids: ["2"], maxNewTags: 0, allowRemove: true }));
    assert.ok(sent.messages[0].content.includes("这次不能新建标签") && sent.messages[0].content.includes("remove 只能填"));
    assert.deepStrictEqual(r2, { newTags: [], assignments: { 2: { add: [], remove: ["硬核"] } }, note: "n" }, "remove only when allowed, no new tags at 0");
    t.triageChat = async () => ({ content: '{"new_tags":[],"items":[{"i":1,"add":["硬核"' });
    await assert.rejects(t.followAiTag({ instruction: "x", mids: ["1"] }), /不完整/, "truncated answer");
    await assert.rejects(t.followAiTag({ instruction: "x", mids: ["99"] }), /缺少 mids/);
    // 关注's own follow_ai_settings win over the 收藏夹 values when the page sends none.
    sync = { follow_ai_settings: { newTagMax: 0, allowRemove: true }, triageAiNewTagMax: 5, triageAiRemoveTags: false };
    t.triageChat = async (...a) => (await chat(...a), { content: '{"new_tags":["新"],"items":[{"i":1,"add":["新"],"remove":["硬核"]}],"note":"n"}' });
    const r3 = plain(await t.followAiTag({ instruction: "x", mids: ["2"] }));
    assert.deepStrictEqual(r3, { newTags: [], assignments: { 2: { add: [], remove: ["硬核"] } }, note: "n" }, "follow_ai_settings used, not triageAi*");
    sync = {};
  }

  // ---------- keepalive alarm: a killed worker is woken by it and resumes; cleared when idle ----------
  {
    const alarms = new Map();
    let onAlarm = null;
    // A new worker: same files, same order, now with chrome present at load like the real service worker.
    const worker = () => {
      const w = vm.createContext({ TextEncoder, URL, URLSearchParams, console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, fetch: t.fetch });
      w.chrome = {
        ...t.chrome,
        // triage-bg.js's own start-up needs these
        runtime: { ...t.chrome.runtime, onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
        storage: { ...t.chrome.storage, onChanged: { addListener() {} } },
        declarativeNetRequest: { updateSessionRules: async () => {} },
        tabs: { TAB_ID_NONE: -1 },
        alarms: {
          create: (name, info) => void alarms.set(name, info),
          clear: async (name) => alarms.delete(name),
          onAlarm: { addListener: (fn) => (onAlarm = fn) }
        }
      };
      load(w);
      vm.runInContext(FAST, w);
      return w;
    };
    const settle = async (w) => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
      await vm.runInContext("followRun && followRun.promise", w);
    };
    local = { follow_list: { list: ["1", "2"] }, follow_last: { at: now(), since: 0, map: {} }, follow_jobs: { finishedAt: 1 } };
    alarms.set("follow-keepalive", { periodInMinutes: 1 }); // left over from a worker killed after its job ended
    let w = worker();
    await settle(w);
    assert.ok(!alarms.has("follow-keepalive"), "an idle worker clears a leftover alarm");
    // a job runs: the alarm is set while it runs and cleared once it ends
    let seenAlarm = false;
    routes["/x/space/wbi/arc/search"] = () => ((seenAlarm ||= alarms.get("follow-keepalive")?.periodInMinutes === 1), arcOk(1));
    await w.followStart();
    await settle(w);
    assert.ok(seenAlarm, "alarm set while the job runs");
    assert.ok(!alarms.has("follow-keepalive"), "alarm cleared when nothing runs");
    // the worker is killed mid-job (storage still says running). A woken worker resumes at load; the alarm itself also
    // resumes when the worker is up but holds no run for a job storage marks running.
    w = worker();
    await settle(w);
    local.follow_list = { list: ["1", "2"] };
    local.follow_content = { 1: { code: 0, count: 1, tlist: {}, v: [], at: now() } };
    local.follow_jobs = { running: true, phase: "arc", cursor: { phase: "arc" }, startedAt: now() - 60 };
    calls = [];
    onAlarm({ name: "follow-keepalive" });
    await settle(w);
    assert.deepStrictEqual(calls.filter((c) => c.startsWith("space")), ["space/wbi/arc/search#2"], "resumed once, at its cursor");
    assert.ok(local.follow_jobs.finishedAt && !local.follow_jobs.running);
    assert.ok(!alarms.has("follow-keepalive"));
    onAlarm({ name: "other" });
    await settle(w);
    assert.strictEqual(calls.filter((c) => c.startsWith("space")).length, 1, "other alarms ignored");
  }

  finished = true;
  console.log("follow-bg selftest ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
