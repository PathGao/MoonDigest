// node extension/triage/follow.selftest.js
if (process.versions.bun) (console.error("This selftest needs Node: it fails or hangs under bun (see 自检 in README.md)."), process.exit(1));
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// follow.js is a page module; lift only its pure block (between the PURE markers).
const source = fs.readFileSync(path.join(__dirname, "follow.js"), "utf8");
const pure = source.slice(source.indexOf("// PURE-START"), source.indexOf("// PURE-END"));
assert.ok(pure.includes("function followStatus") && !pure.includes("document"), "harness lifts the pure block");
const ctx = vm.createContext({ setTimeout, clearTimeout });
// The pure block sorts with shared.js (UI.byValue / UI.dirWords), as the page does.
vm.runInContext(fs.readFileSync(path.join(__dirname, "../errors.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../tag-core.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../settings.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "shared.js"), "utf8"), ctx);
vm.runInContext(`const UI = globalThis.TriageUi;\n${pure}\n;Object.assign(globalThis, { syncFinished, dirLabel, followAiSettings, aiRequests, normDays, settingsProblem, followStatus, withFeedInProgress, lastPostOf, recentTitles, upRow, visibleUps, mergeFeed, shuffled, feedOrdered, feedMatch, sideIds, feedList, feedLeaving, withTags, stepIn, tagsOf, restoreTags, feedCounts, STATUS, viewRecord, latestBvid, favUpMid, aiBlocked, withAllowRemove, groupsOf, regrouped, groupCalls, groupTargets, groupName, groupMoveLabel, outKind });`, ctx);
const t = ctx;
const plain = (v) => JSON.parse(JSON.stringify(v));

const DAY = 86400;
const now = 1_800_000_000;
const ago = (d) => now - d * DAY;
const base = () => ({ list: null, last: null, content: {}, people: {}, tags: [], map: {}, gone: {} });

// ----- 更新状态, feed first -----
{
  const D = base();
  D.last = { since: ago(95), map: { a: ago(3), s: ago(100) }, v: { f: [{ t: "x", c: ago(10), bvid: "BV1" }] } };
  D.content = {
    // fetched long ago: its newest video is old, but the feed saw a newer one → 活跃
    a: { code: 0, v: [{ t: "old", c: ago(400) }] },
    d: { code: 0, v: [{ t: "old", c: ago(400) }] },
    n: { code: 0, count: 0, v: [] },
    x: { code: -404 },
    e: { code: -352 } // a temporary error is not a check
  };
  assert.strictEqual(t.followStatus("a", D, now), "active", "the feed's newer post wins over follow_content");
  assert.strictEqual(t.followStatus("f", D, now), "active", "feed videos (follow_last.v) date an UP too");
  assert.strictEqual(t.followStatus("s", D, now), "slow");
  assert.strictEqual(t.followStatus("d", D, now), "dead");
  assert.strictEqual(t.followStatus("n", D, now), "none");
  assert.strictEqual(t.followStatus("x", D, now), "none", "a gone account has nothing to wait for");
  assert.strictEqual(t.followStatus("e", D, now), "stale", "feed reached past slowDays without them, videos not read");
  assert.strictEqual(t.followStatus("q", D, now), "stale");
  // custom days
  assert.strictEqual(t.followStatus("s", D, now, 120, 365), "active");
{
  const last = { at: 1, since: 100, map: { a: 500, b: 900 }, v: { a: [{ t: "A1", c: 500, bvid: "BVa1" }], b: [{ t: "B1", c: 900, bvid: "BVb1" }] } };
  const wip = { at: 2, since: 800, map: { a: 950, c: 990 }, v: { a: [{ t: "A2", c: 950, bvid: "BVa2" }, { t: "A1", c: 500, bvid: "BVa1" }], c: [{ t: "C1", c: 990, bvid: "BVc1" }] } };
  const m = t.withFeedInProgress(last, wip);
  assert.deepStrictEqual({ ...m.map }, { a: 950, b: 900, c: 990 }, "the walk in progress adds newer posts");
  assert.strictEqual(m.since, 100, "since stays the finished walk's");
  assert.deepStrictEqual([...m.v.a.map((x) => x.t)], ["A2", "A1"], "titles merged once each, newest first");
  assert.strictEqual(t.withFeedInProgress(null, wip), wip, "a first walk is shown as it goes");
  assert.strictEqual(t.withFeedInProgress(last, undefined), last);
}
  assert.strictEqual(t.followStatus("d", D, now, 90, 500), "slow");
  // a feed that does not reach back slowDays cannot tell: 未查
  D.last.since = ago(20);
  assert.strictEqual(t.followStatus("q", D, now), "unchecked");
  D.last = null;
  assert.strictEqual(t.followStatus("q", D, now), "unchecked");
  // boundary: exactly slowDays is 慢更, just under is 活跃
  const B = base();
  B.last = { since: ago(95), map: { b: ago(90), c: now - 90 * DAY + 60 } };
  assert.strictEqual(t.followStatus("b", B, now), "slow");
  assert.strictEqual(t.followStatus("c", B, now), "active");
}

// ----- recent titles: both sources, newest first, no repeats, 3 at most -----
{
  const D = base();
  D.last = { v: { m: [{ t: "B", c: 5, bvid: "BVb" }, { t: "A", c: 9, bvid: "BVa" }] } };
  D.content = { m: { code: 0, v: [{ t: "A", c: 9 }, { t: "C", c: 7 }, { t: "D", c: 1 }] } };
  assert.deepStrictEqual(plain(t.recentTitles("m", D)).map((v) => v.t), ["A", "C", "B"]);
  assert.strictEqual(t.recentTitles("m", D)[0].bvid, "BVa", "the feed's copy (with bvid) is kept");
}

// ----- side, status, search, sort -----
{
  const D = base();
  D.list = { list: ["1", "2", "3", "4"], followTime: { 1: 10, 2: 40, 3: 30, 4: 20 }, special: { 3: 1 } };
  D.people = { 1: { name: "乙" }, 2: { name: "甲", sign: "讲原理" }, 3: { name: "丙" }, 4: { name: "丁" } };
  D.last = { since: ago(95), map: { 1: ago(1), 2: ago(200), 3: ago(5) } };
  D.tags = [{ id: "t1", name: "科普" }];
  D.map = { 2: ["t1", "deleted"], 3: ["t1"] };
  D.gone = { 9: { at: 5, tagIds: ["t1"], source: "bili" }, 8: { at: 7, tagIds: [], source: "app" } };
  const rows = new Map([...D.list.list, ...Object.keys(D.gone)].map((m) => [m, t.upRow(m, D, now, { slowDays: 90, deadDays: 365 })]));
  assert.deepStrictEqual(plain(rows.get("2").tagIds), ["t1"], "a deleted tag id is not shown");
  assert.deepStrictEqual(plain(rows.get("9").tagIds), ["t1"], "an unfollowed UP shows the tags it had");
  const v = (f) => plain(t.visibleUps(D, rows, { side: "all", status: "", q: "", sort: "last", recent: null, ...f }));
  assert.deepStrictEqual(v({}).list, ["1", "3", "2", "4"], "newest post first; never posted last");
  assert.deepStrictEqual(v({ sort: "follow" }).list, ["2", "3", "4", "1"]);
  assert.deepStrictEqual(v({ sort: "name" }).list, ["丙", "丁", "甲", "乙"].map((n) => Object.keys(D.people).find((m) => D.people[m].name === n)));
  assert.deepStrictEqual(v({ tagState: "untagged" }).list, ["1", "4"]);
  assert.deepStrictEqual(v({ side: "g:-10" }).list, ["3"], "特别关注 is the sidebar's group -10");
  assert.deepStrictEqual(v({ tags: new Set(["t1"]) }).list, ["3", "2"]);
  assert.deepStrictEqual(v({ side: "out" }).list, ["8", "9"], "已出分拣范围: the unfollowed newest first, list order kept");
  assert.deepStrictEqual(v({ side: "out", source: "bili" }).list, ["9"]);
  assert.deepStrictEqual(v({ q: "原理" }).list, ["2"], "search reads the sign too");
  const c = v({ status: "active" });
  assert.deepStrictEqual(c.list, ["1", "3"]);
  assert.deepStrictEqual(c.counts, { "": 4, active: 2, slow: 1, stale: 1, tagged: 1, untagged: 1, recent: 0, source: { bili: 0, app: 0 }, tags: { t1: 1 } }, "status counts ignore the status pick; the other groups apply it");
  // 已出分拣范围: 在哪取消关注 is a row 3 group. 全部 counts with it cleared; its chips count with search and row 4 applied.
  const out = v({ side: "out", source: "app" });
  assert.deepStrictEqual([out.list, out.counts[""], out.counts.source], [["8"], 2, { bili: 1, app: 1 }]);
  assert.deepStrictEqual(v({ side: "out", tags: new Set(["t1"]) }).counts.source, { bili: 1, app: 0 }, "row 4 applies");
  assert.deepStrictEqual(v({ side: "out", tagState: "untagged" }).counts.source, { bili: 0, app: 1 }, "未打标签 applies");
  assert.deepStrictEqual(v({ recent: new Set(["4", "2"]) }).list, ["2", "4"], "「AI 刚打的」 narrows the list");
  // direction toggle; a missing value sinks in both directions (4 never posted)
  assert.deepStrictEqual(v({ sort: "last", dir: "asc" }).list, ["2", "3", "1", "4"], "很久没更新在前, never-posted still last");
  assert.deepStrictEqual(v({ sort: "follow", dir: "asc" }).list, ["1", "4", "3", "2"], "最早关注 first");
  const names = (list) => list.map((m) => D.people[m].name);
  assert.deepStrictEqual(names(v({ sort: "name", dir: "desc" }).list), names(v({ sort: "name", dir: "asc" }).list).reverse());
  D.stats = { 1: { follower: 500 }, 3: { follower: 123456 }, 4: { follower: 0 } };
  const rows2 = new Map([...D.list.list].map((m) => [m, t.upRow(m, D, now, { slowDays: 90, deadDays: 365 })]));
  const v2 = (f) => plain(t.visibleUps(D, rows2, { side: "all", status: "", q: "", recent: null, ...f })).list;
  assert.strictEqual(rows2.get("2").fans, null, "no count = 粉丝数未查");
  assert.strictEqual(rows2.get("4").fans, 0, "0 fans is a count");
  assert.deepStrictEqual(v2({ sort: "fans", dir: "desc" }), ["3", "1", "4", "2"], "多→少, 未查 last");
  assert.deepStrictEqual(v2({ sort: "fans", dir: "asc" }), ["4", "1", "3", "2"], "少→多, 未查 still last");
  delete D.stats;
}

// ----- feed: merge without repeats, newest first; tag match -----
{
  const a = t.mergeFeed([], [{ bvid: "x", at: 5 }, { bvid: "y", at: 9 }]);
  assert.deepStrictEqual(plain(a.items).map((i) => i.bvid), ["y", "x"]);
  const b = t.mergeFeed(a.items, [{ bvid: "y", at: 9 }, { bvid: "z", at: 7 }, { bvid: "z", at: 7 }]);
  assert.deepStrictEqual(plain(b.items).map((i) => i.bvid), ["y", "z", "x"]);
  assert.deepStrictEqual(plain(b.add).map((i) => i.bvid), ["z"]);
  const D = base();
  D.tags = [{ id: "t1" }];
  D.map = { 1: ["t1"], 2: ["gone-tag"] };
  D.list = { special: { 3: 1 } };
  const it = (mid) => ({ mid });
  const L = (f) => plain(t.feedList(["1", "2", "3"].map(it), D, { side: "all", ...f }, null)).map((x) => x.mid);
  assert.deepStrictEqual(L({ tags: new Set(["t1"]) }), ["1"], "row 4 goes by the video's UP");
  assert.deepStrictEqual(L({ tagState: "untagged" }), ["2", "3"], "only a deleted tag = untagged");
  assert.ok(t.feedMatch(it("3"), D, "g:-10") && !t.feedMatch(it("1"), D, "g:-10"));
  assert.ok(!t.feedMatch(it("1"), D, "out"));
}

// ----- 已出分拣范围: 已取消关注, 已注销 (a placeholder name or arc's -404) and 投稿已清空 (no video, but watched before) -----
{
  const D = base();
  D.list = { list: ["1", "2", "3", "4", "5"] };
  D.people = { 1: { name: "a" }, 2: { name: "b", gone: true }, 3: { name: "c" }, 4: { name: "d" }, 5: { name: "e" } };
  D.content = { 3: { code: 0, count: 0, views: 4200 }, 4: { code: 0, count: 0, views: 0 }, 5: { code: -404, count: 0 } };
  D.gone = { 9: { at: 5, tagIds: [], source: "app" } };
  const rows = new Map([...D.list.list, "9"].map((m) => [m, t.upRow(m, D, now, { slowDays: 90, deadDays: 365 })]));
  assert.deepStrictEqual(["1", "2", "3", "4", "5", "9"].map((m) => t.outKind(rows.get(m))), ["", "closed", "cleared", "", "closed", "gone"], "never posted (no views) stays in");
  const v = (f) => plain(t.visibleUps(D, rows, { side: "all", status: "", q: "", sort: "follow", ...f }).list);
  assert.deepStrictEqual(v({}), ["1", "4"], "全部 leaves 已出分拣范围 out");
  assert.deepStrictEqual(v({ side: "out" }), ["9", "2", "3", "5"], "the unfollowed, then the followed that left");
  assert.deepStrictEqual(v({ side: "out", kind: "closed" }), ["2", "5"]);
  assert.deepStrictEqual(v({ side: "out", kind: "cleared" }), ["3"]);
  D.gone[8] = { at: 9, tagIds: [], source: "bili" };
  rows.set("8", t.upRow("8", D, now, { slowDays: 90, deadDays: 365 }));
  assert.deepStrictEqual(v({ side: "out", sort: "left", dir: "desc" }), ["8", "9", "2", "3", "5"], "离开时间: newest left first, the still followed after");
  assert.strictEqual(t.viewRecord({ mode: "follow", tab: "ups", sort: "last", dir: "desc", side: "out" }).side, "all", "已出分拣范围 is not remembered");
  D.last = { map: { 3: now - 60 } };
  assert.strictEqual(t.outKind(t.upRow("3", D, now, { slowDays: 90, deadDays: 365 })), "", "a post seen again: back in the list");
}

// ----- 关注分组 (B站's): the sidebar's "g:<tagid>" items, 默认分组 (0) and 特别关注 (-10) first -----
{
  const D = base();
  D.list = { list: ["1", "2", "3", "4"], groups: { 1: [7], 2: [7, 8], 3: [0] }, special: { 4: 1, 2: 1 } };
  D.people = { 1: { name: "a" }, 2: { name: "b" }, 3: { name: "c" }, 4: { name: "d" } };
  D.tags = [{ id: "t1" }];
  assert.deepStrictEqual(plain(t.sideIds(D)), ["all", "g:0", "g:-10", "out"], "scope only: no tag items; B站's fixed groups always");
  D.groups = [{ id: 7, name: "数码" }, { id: 8, name: "音乐" }];
  assert.deepStrictEqual(plain(t.sideIds(D)), ["all", "g:0", "g:-10", "g:7", "g:8", "out"]);
  assert.deepStrictEqual([t.groupName(0, D), t.groupName(-10, D), t.groupName(8, D)], ["默认分组", "特别关注", "音乐"]);
  assert.deepStrictEqual(plain(t.groupsOf("2", D)), [-10, 7, 8], "an UP's groups: -10 from special, then its own");
  assert.deepStrictEqual(plain(t.groupsOf("3", D)), [], "0 is not a group of its own");
  const rows = new Map(D.list.list.map((m) => [m, t.upRow(m, D, now, {})]));
  const v = (side, status = "") => plain(t.visibleUps(D, rows, { side, status, q: "" }));
  assert.deepStrictEqual(v("g:7").list.sort(), ["1", "2"]);
  assert.deepStrictEqual(v("g:8").list, ["2"]);
  assert.deepStrictEqual(v("g:0").list.sort(), ["3", "4"], "默认分组 = in none of your own; 特别关注 alone is still 默认分组");
  assert.deepStrictEqual(v("g:-10").list.sort(), ["2", "4"]);
  assert.strictEqual(v("g:7").counts[""], 2, "counts are over the group's members");
  assert.deepStrictEqual(v("g:7", "active").list, [], "the 状态 filter applies on top");
  assert.ok(t.feedMatch({ mid: "2" }, D, "g:8") && !t.feedMatch({ mid: "1" }, D, "g:8") && !t.feedMatch({ mid: "9" }, D, "g:7"));
  // Targets: every group but the one the sidebar is on; 默认分组 only for a move (B站 has no copy into it).
  assert.deepStrictEqual(plain(t.groupTargets(D, 7, "move")), [[0, "默认分组"], [-10, "特别关注"], [8, "音乐"]]);
  assert.deepStrictEqual(plain(t.groupTargets(D, null, "copy")), [[-10, "特别关注"], [7, "数码"], [8, "音乐"]]);
  assert.deepStrictEqual(plain(t.groupTargets(D, -10, "copy")), [[7, "数码"], [8, "音乐"]]);
}

// ----- 关注分组 writes: the follow-group-move requests from where each UP is to where it should be -----
{
  // 移到 / 复制到 / ★ as the wanted groups.
  assert.deepStrictEqual(plain(t.regrouped([7], 7, 8)), [8], "move");
  assert.deepStrictEqual(plain(t.regrouped([7], null, 8)), [7, 8], "copy");
  assert.deepStrictEqual(plain(t.regrouped([7, 8], null, 8)), [7, 8], "already there");
  assert.deepStrictEqual(plain(t.regrouped([-10, 7], -10, 0)), [7], "out of 特别关注 to 默认分组");
  assert.deepStrictEqual(plain(t.regrouped([], 0, 7)), [7], "from 默认分组");
  // 特别关注 is a flag on top of the groups: 默认分组 → 特别关注 adds, the UP stays in 默认分组; the words say so.
  assert.strictEqual(t.groupMoveLabel(0, -10, true, { groups: [] }), "加进「特别关注」", "默认分组 → 特别关注 is an add");
  assert.strictEqual(t.groupMoveLabel(0, 7, true, { groups: [{ id: 7, name: "数码" }] }), "移到「数码」");
  assert.strictEqual(t.groupMoveLabel(7, -10, true, { groups: [] }), "移到「特别关注」");
  assert.strictEqual(t.groupMoveLabel(null, -10, false, { groups: [] }), "复制到「特别关注」");
  const cur = { a: [7], b: [7], c: [7, 8], d: [], e: [-10] };
  const calls = (want, mids = Object.keys(want), size) => plain(t.groupCalls(mids, (m) => cur[m], (m) => want[m], size));
  const mv = (mids, from, to) => ({ type: "follow-group-move", mids, from, to });
  // A copy is copyUsers (from []); UP 主 already there send nothing.
  assert.deepStrictEqual(calls({ a: [7, 9], b: [7, 9], c: [7, 8, 9], d: [9], e: [-10, 9] }), [mv(["a", "b", "c", "d", "e"], [], [9])], "one request per (from, to)");
  assert.deepStrictEqual(calls({ a: [7], c: [7, 8] }), [], "no change, no request");
  // A move: from what leaves to what joins.
  assert.deepStrictEqual(calls({ a: [9], b: [9], c: [8, 9] }), [mv(["a", "b", "c"], [7], [9])]);
  // Leaving with nothing joining: to what is left (B站's own way out of 特别关注), else 默认分组 (0).
  assert.deepStrictEqual(calls({ c: [8], a: [] }), [mv(["c"], [7], [8]), mv(["a"], [7], [0])]);
  assert.deepStrictEqual(calls({ e: [] }), [mv(["e"], [-10], [0])], "★ off");
  assert.deepStrictEqual(calls({ d: [-10] }), [mv(["d"], [], [-10])], "★ on");
  // At most size UP 主 per request.
  assert.deepStrictEqual(calls({ a: [9], b: [9] }, ["a", "b"], 1), [mv(["a"], [7], [9]), mv(["b"], [7], [9])]);
  // U: the same function from now back to before.
  const after = { a: [9], c: [8, 9] };
  assert.deepStrictEqual(plain(t.groupCalls(["a", "c"], (m) => after[m], (m) => cur[m])), [mv(["a", "c"], [9], [7])]);
}

// ----- 关注's own AI settings: first use copies 收藏夹's, then they are independent -----
{
  const triage = { triageAiBatchSize: 15, triageIntervalSec: 2, triageAiNewTagMax: 3, triageAiRemoveTags: true };
  const first = plain(t.followAiSettings(undefined, triage));
  assert.deepStrictEqual(first.value, { batchSize: 15, intervalSec: 2, newTagMax: 3, allowRemove: true }, "seeded from 收藏夹");
  assert.deepStrictEqual(first.seed, first.value, "the seed is stored");
  assert.strictEqual(t.followAiSettings(undefined, { ...triage, triageAiBatchSize: 7 }).value.batchSize, 7, "收藏夹's own AI 打标签 batch size, once it has one");
  assert.strictEqual(t.followAiSettings(undefined, { ...triage, triageAiBatchSize: null }).value.batchSize, 30, "else 关注's default: the removed 标题粗看 batch size is no fallback");
  assert.deepStrictEqual(plain(t.followAiSettings(undefined, null)).value, { batchSize: 30, intervalSec: 8, newTagMax: 5, allowRemove: false }, "global defaults without 收藏夹 settings");
  const own = { batchSize: 40, intervalSec: 0, newTagMax: 0, allowRemove: false };
  const later = plain(t.followAiSettings(own, { ...triage, triageAiNewTagMax: 9 }));
  assert.deepStrictEqual(later, { value: own, seed: null }, "a stored 关注 value wins; 收藏夹 changes do not leak in");
  assert.deepStrictEqual(plain(t.followAiSettings({ batchSize: 500, intervalSec: -3, newTagMax: "x" }, null)).value, { batchSize: 100, intervalSec: 8, newTagMax: 5, allowRemove: false }, "clamped");
  // The requests use 关注's values
  const { batches, intervalMs } = plain(t.aiRequests(["a", "b", "c", "d", "e"], { batchSize: 2, intervalSec: 3, newTagMax: 1, allowRemove: false }, "分", [], true));
  assert.deepStrictEqual(batches.map((b) => b.mids), [["a", "b"], ["c", "d"], ["e"]]);
  assert.ok(batches.every((b) => b.type === "follow-ai-tag" && b.maxNewTags === 1 && b.allowRemove === true && b.instruction === "分"));
  assert.strictEqual(intervalMs, 3000);
  assert.deepStrictEqual(plain(t.normDays("", "")), { followSlowDays: 90, followDeadDays: 365 });
  assert.deepStrictEqual(plain(t.normDays("400", "100")), { followSlowDays: 400, followDeadDays: 401 });
  assert.deepStrictEqual(plain(t.normDays("1", "99999")), { followSlowDays: 90, followDeadDays: 3651 }, "below the minimum is the default, above the maximum the maximum");
  assert.deepStrictEqual(plain(t.normDays("-5", "x")), { followSlowDays: 90, followDeadDays: 365 }, "negative or not a number is the default");
  assert.deepStrictEqual(plain(t.normDays("90", "-5")), { followSlowDays: 90, followDeadDays: 365 }, "a negative 断更 is the default, not 慢更 + 1");
  assert.deepStrictEqual(plain(t.normDays("5000", "3")), { followSlowDays: 3650, followDeadDays: 3651 }, "断更 stays a day past 慢更");
  assert.strictEqual(t.settingsProblem("90", "90"), "断更天数要比慢更大");
  assert.strictEqual(t.settingsProblem("120", "60"), "断更天数要比慢更大");
  assert.strictEqual(t.settingsProblem("", ""), "");
  assert.strictEqual(t.settingsProblem("30", "200"), "");
  assert.deepStrictEqual([t.settingsProblem("abc", "200"), t.settingsProblem("400", "x")], ["", "断更天数要比慢更大"], "not a number: its default");
}

assert.deepStrictEqual([t.dirLabel("last", "desc"), t.dirLabel("follow", "asc"), t.dirLabel("fans", "desc"), t.dirLabel("fans", "asc")], ["新→旧", "旧→新", "从多到少", "从少到多"]);

// ----- tagging from 动态: deferred removal (the picker itself is tag-picker.selftest.js) -----
{
  const D = { ...base(), tags: [{ id: "g", name: "游戏" }, { id: "s", name: "生活" }], map: { b: ["g"] } };
  // what the picker's close saves: an UP left with no tag leaves the map
  assert.deepStrictEqual(plain(t.withTags(D.map, ["a"], ["s"], [])), { b: ["g"], a: ["s"] });
  assert.deepStrictEqual(plain(t.withTags(D.map, ["b"], [], ["g"])), {}, "unticking the last tag drops the UP from the map");
  const U = { side: "all", tagState: "untagged" };

  // 未打标签: tagging 「a」 with the picker open keeps a's cards until it closes
  const items = [{ bvid: "1", mid: "a" }, { bvid: "2", mid: "a" }, { bvid: "3", mid: "c" }, { bvid: "4", mid: "b" }];
  const keep = new Set(t.feedList(items, D, U, null).filter((it) => it.mid === "a").map((it) => it.bvid));
  assert.deepStrictEqual([...keep], ["1", "2"]);
  const tagged = { ...D, map: { b: ["g"], a: ["s"] } };
  assert.deepStrictEqual(t.feedList(items, tagged, U, keep).map((it) => it.bvid), ["1", "2", "3"], "open: a's cards stay");
  assert.deepStrictEqual(t.feedList(items, tagged, U, null).map((it) => it.bvid), ["3"], "closed: they leave");
  assert.strictEqual(t.feedLeaving(items, tagged, U, keep).length, 2, "the toast counts the cards that left");
  assert.strictEqual(t.feedLeaving(items, D, U, keep).length, 0, "nothing ticked → nothing leaves");
  // keep never adds cards that were not showing (b is in 游戏, not 未打标签)
  assert.deepStrictEqual(t.feedList(items, D, U, new Set(["1"])).map((it) => it.bvid), ["1", "2", "3"]);
  // ticking a tag into the filtered one shows the UP's other cards at once
  assert.deepStrictEqual(t.feedList(items, tagged, { side: "all", tags: new Set(["s"]) }, new Set()).map((it) => it.bvid), ["1", "2"]);
}

// J / K over the cards on screen; U gives the touched UPs their tags back and leaves the rest
{
  assert.strictEqual(t.stepIn([], "", 1), "");
  assert.strictEqual(t.stepIn(["a", "b", "c"], "", 1), "a", "none current: J starts at the top");
  assert.strictEqual(t.stepIn(["a", "b", "c"], "a", 1), "b");
  assert.strictEqual(t.stepIn(["a", "b", "c"], "c", 1), "c", "stops at the end");
  assert.strictEqual(t.stepIn(["a", "b", "c"], "b", -1), "a");
  assert.strictEqual(t.stepIn(["a", "b", "c"], "a", -1), "a", "stops at the top");
  assert.strictEqual(t.stepIn(["a", "b"], "gone", -1), "a", "a current card that left the list: back to the top");

  const before = t.tagsOf({ a: ["x"], b: ["y"] }, ["a", "n"]);
  assert.deepStrictEqual(plain(before), { a: ["x"], n: [] });
  const now = { a: ["x", "z"], b: ["y", "w"], n: ["x"] };
  const all = new Set(["a", "b", "n"]);
  assert.deepStrictEqual(plain(t.restoreTags(now, before, new Set(["x", "y", "z", "w"]), all)), { a: ["x"], b: ["y", "w"] }, "b's later edit stays");
  assert.deepStrictEqual(plain(t.restoreTags({}, { a: ["x", "dead"] }, new Set(["x"]), all)), { a: ["x"] }, "a tag deleted since stays gone");
  // Unfollowed since: their tags went into the 已取消关注 record; U leaves them out instead of a ghost entry.
  assert.deepStrictEqual(plain(t.restoreTags({}, { a: ["x"], g: ["x"] }, new Set(["x"]), all)), { a: ["x"] }, "an UP unfollowed since is skipped");
}

// One keydown handler for the page (triage.js onKey): follow.js hands it its keys, and triage.js knows no 关注 ids.
{
  assert.ok(!/addEventListener\("keydown"/.test(source), "follow.js has no page-wide keydown listener");
  assert.ok(source.includes("T.setModeKeys("), "follow.js registers its keys");
  assert.ok(!/fw[A-Z]/.test(fs.readFileSync(path.join(__dirname, "triage.js"), "utf8")), "triage.js names no 关注 element");
}

// G5 / L2 / A5: 关注's B站 writes are a second writes.js adapter on 关注's own runs: one by one with a gap, on B站限流 the
// pill keeps its line and counts down 90 s, then the same request goes again; 停止 keeps what went through. Its lane is
// its own, so a 收藏夹 batch never blocks it.
(async () => {
  for (const f of ["runs.js", "writes.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
  const code = source.slice(source.indexOf("const runs = MdgRuns.create("), source.indexOf("async function unfollow("));
  const env = { F: { sel: new Set(["1", "2", "3"]) }, toasts: [], sent: [], answers: [], clock: 0, waits: [], gaps: [] };
  // The real runs.js on a fake clock: a sleep moves it on at once, or stops once ok() turns false.
  const MdgRuns = {
    create: (o) => ctx.MdgRuns.create({
      ...o,
      now: () => env.clock,
      async sleep(ms, ok = () => true) {
        if (ms === 1000 && !env.waiting) env.gaps.push(ms);
        for (let left = ms; left > 0 && ok(); left -= 100) (env.clock += 100), await new Promise((r) => setImmediate(r));
      }
    })
  };
  const T = { hold: () => null };
  const run = new Function("env", "MdgRuns", "MdgWrites", "UI", "T", `const { F } = env; const D = {}; const AI = {}; const PHASE = {}; const nowSec = () => env.clock / 1000;
    const send = async (c) => (env.sent.push(c.mid), env.answers.shift() || { ok: true });
    const toast = (m) => env.toasts.push(m); const load = async () => {}; const rows = new Map(); const sideMids = () => []; const outKind = () => ""; const render = () => {}; const renderSel = () => {}; const renderFoot = () => {};
    let runs;
    const renderSync = () => { const w = runs?.get("follow-write")?.wait; env.waiting = Boolean(w); if (w) env.waits.push(runs.pill(["follow-write"]).text); if (env.sent.length >= env.stopAfter) (env.stopAfter = Infinity), W.stop(); };
    ${code.replace("const runs = ", "runs = ")}; return { relationRun, W, runs };`);
  const fns = run(env, MdgRuns, ctx.MdgWrites, t.TriageUi, T);
  const calls = ["1", "2", "3"].map((mid) => ({ mid }));
  env.answers = [{ ok: true }, { ok: false, code: "THROTTLED" }, { ok: true }, { ok: true }];
  assert.strictEqual(await fns.relationRun(calls, "取消关注"), 3);
  assert.deepStrictEqual(env.sent, ["1", "2", "2", "3"], "the throttled request goes again, then the rest");
  assert.deepStrictEqual(env.gaps, [1000, 1000], "a gap between two UP 主, none after the limit's countdown");
  assert.strictEqual(env.waits[0], "取消关注中 1/3 · B站限流卡住，1:30 后重试", "the count is what went through");
  assert.ok(env.waits.length > 80 && env.waits.at(-1).endsWith("0:01 后重试"), "the pill counts down the wait");
  assert.deepStrictEqual([env.toasts, [...env.F.sel]], [["已取消关注 3 个"], []]);
  // 停止 during the wait: what went through stays, the run says how far it got.
  Object.assign(env, { sent: [], toasts: [], waits: [], stopAfter: 2, answers: [{ ok: true }, { ok: false, code: "THROTTLED" }] });
  assert.strictEqual(await fns.relationRun(calls, "取消关注", { quiet: true }), 1);
  assert.deepStrictEqual(env.sent, ["1", "2"]);
  assert.deepStrictEqual(env.toasts, ["已停止取消关注：完成 1 个，未完成 2 个"]);
  // A failure stops there and says which; the lane is free after it.
  Object.assign(env, { sent: [], toasts: [], stopAfter: Infinity, answers: [{ ok: true }, { ok: false, error: "-352" }] });
  assert.strictEqual(await fns.relationRun(calls, "重新关注"), 1);
  assert.deepStrictEqual([env.toasts, fns.W.busy()], [["重新关注第 2 个时出错：-352（前 1 个已完成）"], ""]);
  assert.ok(!/过一会儿再试/.test(source), "no 「过一会儿再试」 without a countdown");
  assert.ok(!/F\.busy/.test(source), "the write running is W's, not page state");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// The tag row's buttons open the shared dialogs (tag-dialogs.js) with 关注's adapters: 标签管理 → 标签管理, ✦ AI 打标签
// (and 查看 in the progress pill, data-fw="ai") → AI 打标签. 关注 draws no tag dialog of its own.
{
  assert.ok(source.includes('else if (act === "ai") openAi();') && source.includes('else if (act === "tags") openManage();'), "each button its own dialog");
  assert.ok(source.includes("const openManage = () => TagDialogs.manage.open(manageTags);") && /async function openAi\(\) \{[^}]*\}\s*TagDialogs\.ai\.open\(aiTags\);/.test(source));
  assert.ok(/const manageTags = \{\s*who: "UP 主"/.test(source) && /const aiTags = \{\s*who: "UP 主"[\s\S]*?manage: manageTags,/.test(source), "关注's adapters, linked");
  assert.ok(!/<dialog id="fwTagsDialog"|data-fwmode/.test(source), "no combined 「UP 主标签」 dialog");
}

// 刷新 then 动态: a finished sync drops the loaded feed, so the next look reads it again.
{
  assert.ok(t.syncFinished({ running: true, finishedAt: null }, { running: false, finishedAt: 5 }));
  assert.ok(!t.syncFinished({ finishedAt: 5 }, { finishedAt: 5, beat: 6 }), "a tick of the same job is not a finish");
  assert.ok(!t.syncFinished({ running: true }, { running: false, hold: null }), "stopped (no finishedAt) is not a finish");
  assert.ok(/if \(syncFinished\(changes\.follow_jobs\?\.oldValue, changes\.follow_jobs\?\.newValue\)\) \{\s*F\.feed = null;/.test(source), "the page drops F.feed on it");
}

// The deep link's hash is dropped once read: the same tag clicked again changes the hash again (the worker sets it), and a
// reload in 收藏夹 does not jump back to 关注.
assert.ok(/if \(!\/\^follow\(&\|\$\)\/\.test\(h\)\) return false;\s*history\.replaceState\(null, "", location\.pathname \+ location\.search\);/.test(source), "followHash drops the hash");

// #follow&up=<mid> (the B站 tag picker's button) clears what could hide the card, then makes it current.
assert.ok(/if \(up\) \{\s*const side = rows\.has\(up\) && outKind\(rows\.get\(up\)\) \? "out" : "all";[\s\S]*?F\.side = side;\s*F\.status = F\.tagState = F\.source = F\.kind = F\.q = "";[\s\S]*?F\.tags = new Set\(\);\s*\}/.test(source), "followHash clears the filters for up");
assert.ok(/render\(\);\s*if \(up\) \{\s*setCur\(up, false\);\s*E\.list\.querySelector\("\.fw-up\.focused"\)\?\.scrollIntoView\(\{ block: "center" \}\);/.test(source), "followHash makes the UP current, centered");

// 标签… on 2+ UP 主 is one step that asks before U, with 收藏夹's words (shared.js undoAsk).
assert.ok(source.includes(`pushTagUndo(before, "标签修改", { ask: changes.length > 1 ? UI.undoAsk("tags", changes.length, "UP 主") : null });`), "pickClosed asks for 2+");

// B站 writes and U (DESIGN 产品决策 · 改 B站 的操作和撤销): a single 重新关注 has no confirm and U unfollows again with its 已取消关注 record; batch
// 特别关注 is one step that asks before U; single 取消关注 keeps its confirm.
{
  const fn = (name) => source.slice(source.indexOf(`function ${name}(`), source.indexOf("\n}\n", source.indexOf(`function ${name}(`)));
  const re = fn("refollow");
  assert.ok(re.indexOf("mids.length === 1") < re.indexOf("askConfirm") && /act: 2, gone/.test(re) && re.includes("已在 B站重新关注「"), "single 重新关注: no confirm, U with the record");
  assert.ok(fn("pushWriteUndo").includes("ask: done.length > 1 ? ask : null"), "U asks for 2+ only");
  assert.ok(/async function unfollow[\s\S]*?askConfirm/.test(source), "取消关注 still asks");
}

// 关注分组 on B站 (DESIGN 产品决策 · 改 B站 的操作和撤销): move / copy / ★ go through regroup, one undo step of only what B站 confirmed; a batch's
// confirm is the 移动 / 复制 dialog titled 在 B站…; 删除 always asks, says where the members go, and drops the group steps.
{
  const fn = (name) => source.slice(source.indexOf(`function ${name}(`), source.indexOf("\n}\n", source.indexOf(`function ${name}(`)));
  const rg = fn("regroup");
  assert.ok(rg.includes("const done = calls.flatMap((c) => c.mids).slice(0, n).filter((m) => !skipped.some((x) => x.mid === m));") && /if \(done\.length\) \{\s*pushWriteUndo\(done,/.test(rg), "U only for the UP 主 B站 confirmed (none after a timeout)");
  assert.ok(rg.includes("mids.filter((m) => !rows.get(m)?.closed)") && /relationRun\(calls, label, \{ quiet: true, skipped \}\)/.test(rg) && /if \(skipped\.length\) \{[\s\S]*?askConfirm\([^\n]*\{ alone: true \}\)/.test(rg), "closed accounts and the ones B站 left out are listed after, still selected");
  assert.ok(/back: \(\) => groupCalls\(done, \(m\) => groupsOf\(m, D\), \(m\) => before\[m\]\)/.test(rg) && /ask: \[`在 B站撤销/.test(rg) && rg.includes("groups: true"), "U puts back the groups they had, asked for 2+");
  assert.ok(/async function starOne\(mid\) \{[\s\S]*?await regroup\(\[mid\],[^\n]*SPECIAL/.test(source), "★ is a move of group -10");
  const mc = fn("moveOrCopy");
  assert.ok(/UI\.askTransfer\(\{\s*title: `在 B站把这 \$\{mids\.length\} 个 UP 主\$\{verb\}到分组`,\s*n: mids\.length,\s*hows: \[how\],/.test(mc), "the batch confirm: 在 B站…, the count on its one button");
  assert.ok(mc.indexOf("createGroup(") < mc.indexOf("regroup("), "新建分组… first");
  assert.ok(mc.includes("const label = groupMoveLabel(move ? from : null, to, move, D);") && mc.includes("放进自己建的分组后，就不在默认分组里了。"), "toast and U use the add words");
  assert.ok(/note: \(v\) => \(v === String\(SPECIAL\) \? `\$\{move && from === 0 \? "还留在默认分组里/.test(mc), "the dialog says 特别关注 keeps them in 默认分组");
  const del = fn("deleteGroup");
  assert.ok(/askConfirm\([\s\S]*?\);\s*if \(!ok\) return;\s*const r = await send\(\{ type: "follow-group-delete"/.test(del) && del.includes("默认分组") && del.includes("不能按 U 撤销") && del.includes("T.dropModeUndo((step) => step.groups)"), "删除: confirm first, members → 默认分组, no U");
  assert.ok(/T\.pushUndo\(\{\s*kind: "mode",\s*groups: true,\s*undo: async \(\) => \(\(await renameGroup\(\{ id: g\.id, name \}, old, true\)\)/.test(fn("renameGroup")), "改名: U renames back");
  assert.ok(!/follow-special|data-fw="special-|side-note|只读，在 B站 改/.test(source), "no 特别关注 toggle of its own, no read-only note");
}

// 关注设置 and the AI settings it seeds: a failed chrome.storage.sync.set says so, as 收藏夹设置 does.
assert.strictEqual((source.match(/chrome\.storage\.sync\.set\(/g) || []).length, 3);
assert.ok(/\.set\(\{ follow_ai_settings: seed \}\)\.catch\(\(e\) => toast\(`\$\{MdgErrors\.TEXT\.settingsSaveFailed\}：/.test(source) && /try \{\s*await chrome\.storage\.sync\.set\(\{ follow_ai_settings: ai, \.\.\.days \}\);\s*\} catch \(e\) \{\s*return toast\(`\$\{MdgErrors\.TEXT\.settingsSaveFailed\}：/.test(source), "both writes catch");

// The player's T / Esc reach 关注 through triage.js's one message listener (modeKeys), as page keys do.
assert.ok(!/addEventListener\("message"/.test(source), "follow.js has no message listener of its own");

// 已取消关注 is a filter like the others: the selection stays, the ones not listed show as 「另有 N 个被筛选隐藏」.
assert.ok(source.includes("for (const m of [...F.sel]) if (!rows.has(m)) F.sel.delete(m);"), "renderUps drops only UP 主 that are gone from the data");

// Rows 3 and 4 (DESIGN 产品决策 · 分拣台): row 3's groups AND together, one pick each, and each group counts with its own pick left out;
// row 4's tags AND, counted with row 4's picks left out; 全部 counts row 3 cleared.
{
  const D = base();
  D.list = { list: ["1", "2", "3", "4", "5"] };
  D.people = Object.fromEntries(D.list.list.map((m) => [m, { name: m }]));
  D.last = { since: ago(95), map: { 1: ago(1), 2: ago(2), 3: ago(200), 4: ago(300) } }; // 5: 待查
  D.tags = [{ id: "a" }, { id: "b" }];
  D.map = { 1: ["a"], 2: ["a", "b"], 3: ["b"] };
  const rows = new Map(D.list.list.map((m) => [m, t.upRow(m, D, now, { slowDays: 90, deadDays: 365 })]));
  const v = (f) => plain(t.visibleUps(D, rows, { side: "all", q: "", ...f }));
  const all = new Set(["2", "3"]);
  let r = v({ status: "active", tagState: "tagged", recentAll: all });
  assert.deepStrictEqual(r.list.sort(), ["1", "2"], "活跃 AND 已打标签");
  assert.deepStrictEqual([r.counts.active, r.counts.slow, r.counts.stale || 0], [2, 1, 0], "更新状态 counts keep 已打标签, drop their own pick");
  assert.deepStrictEqual([r.counts.tagged, r.counts.untagged], [2, 0], "未打标签 / 已打标签 keep 活跃, drop their own pick");
  assert.deepStrictEqual([r.counts[""], r.counts.recent], [5, 1], "全部 = row 3 cleared; AI 刚打的 counted under the other picks");
  assert.deepStrictEqual(r.counts.tags, { a: 2, b: 1 }, "row 4 counts the listed UP 主");
  r = v({ tags: new Set(["a", "b"]), recentAll: all });
  assert.deepStrictEqual(r.list, ["2"], "row 4: AND");
  assert.deepStrictEqual(r.counts.tags, { a: 2, b: 2 }, "row 4's counts leave its own picks out");
  assert.strictEqual(r.counts[""], 1, "全部 keeps row 4");
  r = v({ recent: all, recentAll: all, status: "stale" });
  assert.deepStrictEqual(r.list, [], "AI 刚打的 AND 待查");
  assert.strictEqual(r.counts.recent, 0);
  assert.strictEqual(r.counts.stale || 0, 0, "待查 counted under AI 刚打的");
  // 待查 is always there (dimmed at 0), under its short name; the full name is its tooltip.
  assert.deepStrictEqual(plain(t.STATUS.find(([id]) => id === "stale")), ["stale", "待查"]);
  assert.ok(source.includes('UI.stateGroup("更新状态", STATUS.slice(1).map(') && source.includes("慢更或断更 · 待查："), "every 更新状态 pill is drawn; 待查 has the full name in its title");
  // 视频投稿: row 3 by the video's UP; counts as above.
  const items = [{ bvid: "x", mid: "1", title: "甲" }, { bvid: "y", mid: "2", title: "乙" }, { bvid: "z", mid: "4", title: "丙" }];
  const c = plain(t.feedCounts(items, D, { side: "all", q: "", tagState: "tagged", tags: new Set(["b"]) }));
  assert.deepStrictEqual(c, { "": 1, tagged: 1, untagged: 0, tags: { a: 2, b: 1 } });
}

// B12: the sidebar item is remembered with the rest of the view and checked against the data on load.
assert.deepStrictEqual(plain(t.viewRecord({ mode: "follow", tab: "ups", sort: "last", dir: "desc", side: "g:7", q: "x" })), { mode: "follow", tab: "ups", sort: "last", dir: "desc", side: "g:7" });
assert.strictEqual(t.viewRecord({ mode: "follow", tab: "feed", sort: "last", dir: "desc", fsort: "random", side: "all" }).fsort, "random", "视频投稿's sort is remembered");

// 视频投稿's sort: 更新时间 is the loaded order; 随机 shuffles, then shuffles each new page in at the bottom.
{
  const v = (...ids) => ids.map((bvid) => ({ bvid }));
  const ids = (r) => r.items.map((it) => it.bvid).join("");
  const rev = () => 0; // Fisher–Yates with j = 0 every step
  assert.deepStrictEqual(plain(t.feedOrdered(v("a", "b"), "time", ["b", "a"])), { items: v("a", "b"), order: null }, "更新时间 ignores and drops 随机's order");
  const r = t.feedOrdered(v("a", "b", "c"), "random", null, rev);
  assert.strictEqual(ids(r), "bca");
  const r2 = t.feedOrdered(v("a", "b", "c", "d", "e"), "random", r.order, rev);
  assert.strictEqual(ids(r2), "bcaed", "shown cards stay put; the new page is shuffled on its own below");
  assert.strictEqual(ids(t.feedOrdered(v("a", "b"), "random", ["x", "b", "a"])), "ba", "videos no longer loaded drop out");
  const all = t.shuffled([1, 2, 3, 4, 5]);
  assert.deepStrictEqual([...all].sort(), [1, 2, 3, 4, 5], "a shuffle keeps every item");
}
assert.ok(source.includes('if (typeof view?.side === "string") F.side = view.side === "special" ? `g:${SPECIAL}` : view.side === "gone" ? "out" : view.side;') && /function pickSide\(id\) \{[^}]*saveView\(\);/.test(source), "restored on load, saved on every pick");
// B13: I = ✦ AI 打标签 (or why not), O / Enter plays the current UP's newest video that has a bvid.
assert.strictEqual(t.latestBvid({ titles: [{ t: "a" }, { t: "b", bvid: "BV2" }, { t: "c", bvid: "BV3" }] }), "BV2");
assert.strictEqual(t.latestBvid({ titles: [{ t: "a" }] }), "");
assert.strictEqual(t.aiBlocked("ups", "all"), "");
assert.ok(t.aiBlocked("feed", "all") && t.aiBlocked("ups", "out"), "视频投稿 and 已出分拣范围 say why");
{
  const key = source.slice(source.indexOf("function followKey("), source.indexOf("T.setModeKeys"));
  assert.ok(key.includes('key === "i") aiReason() ? toast(aiReason()) : openAi()') && /key === "o" \|\| key === "Enter"\) && shown\.includes\(F\.cur\)\) \{\s*const bvid = latestBvid\(rows\.get\(F\.cur\)\);\s*bvid \? play\(bvid\)/.test(key), "followKey has I and O / Enter");
}
// B15: 「允许 AI 去掉已有标签」 is kept in follow_ai_settings, as 收藏夹 keeps its own.
assert.deepStrictEqual(plain(t.withAllowRemove({ batchSize: 10, intervalSec: 2, newTagMax: 1, allowRemove: false }, true)), { batchSize: 10, intervalSec: 2, newTagMax: 1, allowRemove: true });
assert.ok(/async setAllowRemove\(on\) \{\s*const next = withAllowRemove\(await aiSettings\(\), on\);\s*try \{\s*await chrome\.storage\.sync\.set\(\{ follow_ai_settings: next \}\);/.test(source), "the AI dialog's switch saves");

// The 关注 tab is 视频投稿 (we read only B站's video posts, which B站 itself calls 视频投稿): no page text says 动态.
// Comments may; B站 page scripts outside triage/ talk about B站's own 动态 page.
for (const f of ["triage.html", "triage.js", "triage-core.js", "follow.js", "follow-bg.js", "shared.js", "tag-picker.js", "tag-dialogs.js"]) {
  const text = fs.readFileSync(path.join(__dirname, f), "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.ok(!text.includes("动态"), `${f} still says 动态 to the user`);
}

console.log("follow selftest: all passed");

// ----- wording written once (H3, H6, H7) -----
{
  // The sync pill's button says what row 3's says: 暂停刷新, as 收藏夹's pill says 暂停粗看.
  assert.ok(source.includes('sync: { attrs: "data-fw-stop", label: "暂停刷新" }'), "pill says 暂停刷新");
  // The CSV hint and the group-name cap each have one constant.
  for (const s of ["名字、标签、更新状态、最后投稿、粉丝数", "最多 16 个字", "> 16", '"16"', "newMax: 16"]) assert.strictEqual(source.split(s).length - 1, s === "名字、标签、更新状态、最后投稿、粉丝数" ? 1 : 0, s);
}

// ----- the 收藏夹 player's UP 标签 line finds its UP -----
{
  const rows = new Map([["7", { mid: "7", name: "新名字" }], ["8", { mid: "8", name: "乙" }]]);
  assert.strictEqual(t.favUpMid({ mid: "7", name: "旧名字" }, rows), "7", "the mid wins over a renamed UP");
  assert.strictEqual(t.favUpMid({ mid: "9", name: "乙" }, rows), "", "a mid not followed is not matched by name");
  assert.strictEqual(t.favUpMid({ mid: "", name: "乙" }, rows), "8", "an item saved before mids falls back to the name");
  assert.strictEqual(t.favUpMid({ mid: "", name: "" }, rows), "");
  assert.strictEqual(t.favUpMid(null, rows), "");
}

// ----- 关注 through the page: triage.js and follow.js (as triage.html loads them) on a stub DOM -----
// setup(ctx) runs before follow.js. FW is what follow.js keeps to itself and the tests read or drive.
async function followPage({ store = {}, handlers = {}, setup = () => {} } = {}) {
  const els = new Map();
  // An element: what the code sets is kept, listeners per type (fire); anything else is a no-op.
  function elem(id = "") {
    const L = {};
    const cls = new Set();
    const o = {
      id, L, hidden: false, disabled: false, dataset: {}, style: { setProperty() {} }, innerHTML: "", textContent: "", value: "", scrollTop: 0, title: "",
      classList: { toggle: (c, on = !cls.has(c)) => (on ? cls.add(c) : cls.delete(c), on), add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
      addEventListener: (type, f) => (L[type] ||= []).push(f),
      querySelector: () => elem(),
      querySelectorAll: () => [],
      closest: () => null,
      contentWindow: {}
    };
    return new Proxy(o, {
      get: (x, k) => (k in x ? x[k] : typeof k === "symbol" ? undefined : k === "lastChild" ? (x[k] = elem()) : () => {}),
      set: (x, k, v) => ((x[k] = v), true)
    });
  }
  const $ = (id) => els.get(id) || els.set(id, elem(id)).get(id);
  const winL = {};
  const sent = [];
  const toasts = [];
  const asked = [];
  const picks = [];
  class Observer { observe() {} disconnect() {} }
  const ctx = vm.createContext({
    console, structuredClone, TextEncoder, URLSearchParams, clearTimeout,
    setTimeout: (f, ms) => setTimeout(f, Math.min(ms || 0, 5)),
    setInterval: () => 0,
    clearInterval() {},
    ResizeObserver: Observer, MutationObserver: Observer, IntersectionObserver: Observer,
    CSS: { escape: (x) => x },
    getSelection: () => ({ isCollapsed: true, removeAllRanges() {} }),
    location: { hash: "", pathname: "/triage.html", search: "" },
    history: { replaceState() {} },
    TagDialogs: { manage: { open() {}, isOpen: () => false }, ai: { open() {}, isOpen: () => false, render() {}, progress() {} } },
    document: { body: elem("body"), getElementById: (id) => (id === "tagPicker" ? null : $(id)), querySelector: () => null, querySelectorAll: () => [], createElement: () => elem(), addEventListener() {} },
    window: { addEventListener: (type, f) => (winL[type] ||= []).push(f), open() {} },
    chrome: {
      runtime: { id: "test", sendMessage: (msg, cb) => (sent.push(msg), Promise.resolve((handlers[msg.type] || (() => ({ ok: true })))(msg)).then(cb)) },
      tabs: { getCurrent: async () => ({}) },
      storage: {
        local: {
          get: async (k) => Object.fromEntries([].concat(k).filter((x) => x in store).map((x) => [x, structuredClone(store[x])])),
          set: async (o) => void Object.assign(store, structuredClone(o)),
          remove: async (keys) => [].concat(keys).forEach((k) => delete store[k])
        },
        sync: { get: async (d) => ({ ...d }), async set() {} },
        onChanged: { addListener() {} }
      }
    }
  });
  const html = fs.readFileSync(path.join(__dirname, "triage.html"), "utf8");
  for (const [, attrs, src] of html.matchAll(/<script([^>]*) src="([^"]+)"/g)) {
    if (!/type="module"/.test(attrs) && !src.endsWith("/tag-dialogs.js")) vm.runInContext(fs.readFileSync(path.join(__dirname, src), "utf8"), ctx);
  }
  Object.assign(ctx.TagPicker, { open: (o) => picks.push(o), close() {}, isOpen: () => false });
  const triage = fs.readFileSync(path.join(__dirname, "triage.js"), "utf8").replace(/^if \(!globalThis\.chrome\?\.runtime\?\.id\) await import.*$/m, "").replace(/^init\(\);$/m, "");
  vm.runInContext(`${triage}\n;bindEvents(); globalThis.S = S; globalThis.el = el;`, ctx);
  // triage.js draws only the player's lines here (and 关注's through its hook); its toast and confirm are recorded.
  const toast = (m) => toasts.push(m);
  const askConfirm = async (title) => (asked.push(title), true);
  Object.assign(ctx, { render: () => ctx.renderViewerTags(), renderStatus() {}, toast, askConfirm });
  Object.assign(ctx.MoonTriage, { toast, askConfirm });
  setup(ctx);
  const follow = fs.readFileSync(path.join(__dirname, "follow.js"), "utf8").replace(/^import "\.\/triage\.js";.*$/m, "");
  await vm.runInContext(`(async () => {\n${follow}\n;globalThis.FW = { F, E, W, relationRun, pushWriteUndo, render, refollow };\n})()`, ctx);
  const settle = async (n = 30) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1));
  };
  await settle();
  // Real time (runs' countdowns sleep), 3 s at most.
  const until = async (ok) => {
    for (const end = Date.now() + 3000; !ok() && Date.now() < end; ) await settle(1);
  };
  const key = (k) => ctx.onKey({ key: k, target: { closest: () => null }, preventDefault() {} });
  const click = (id, sel, dataset) => ($(id).L.click || []).forEach((f) => f({ button: 0, preventDefault() {}, target: { closest: (s) => (s === sel ? { dataset, closest: () => null } : null) } }));
  return { ctx, FW: ctx.FW, $, winL, sent, toasts, asked, picks, store, settle, until, key, click };
}

(async () => {
  const sec = Math.floor(Date.now() / 1000);
  const page = (o = {}) => ({
    follow_view: { mode: "follow", tab: "ups" },
    follow_list: { list: ["u1", "u2"] },
    follow_people: { u1: { name: "甲" }, u2: { name: "乙" } },
    follow_last: { since: sec - 95 * DAY, map: { u1: sec - DAY }, v: { u1: [{ t: "A", c: sec - DAY, bvid: "BVa" }] } },
    ...o
  });
  const feed = { ok: true, data: { items: [{ bvid: "BVb", mid: "u2", name: "乙", title: "B", at: sec - 2 * DAY }, { bvid: "BVc", mid: "u1", name: "甲", title: "C", at: sec - 3 * DAY }], offset: "", hasMore: false } };
  const feedSends = (p) => p.sent.filter((m) => m.type === "follow-feed").length;

  // S3: UP 主 and 视频投稿 share #fwList and the selection belongs to its tab: switching starts the other at its top, none picked.
  {
    const p = await followPage({ store: page(), handlers: { "follow-feed": () => feed } });
    const { F, E } = p.FW;
    F.sel.add("u1");
    E.list.scrollTop = 500;
    p.click("followMain", "[data-fwtab]", { fwtab: "feed" });
    assert.deepStrictEqual([F.tab, F.sel.size, E.list.scrollTop], ["feed", 0, 0], "switching tabs clears the selection and scrolls to the top");
  }

  // K1: every mode switch (the view restored on load, the 收藏夹 | 关注 switch) syncs the header fold right after
  // toggling body.follow-mode, and again once the mode is drawn.
  {
    const calls = [];
    const p = await followPage({ store: page(), setup: (ctx) => (ctx.TriageUi.headFold = () => () => calls.push(ctx.document.body.classList.contains("follow-mode"))) });
    assert.deepStrictEqual(calls, [true, true], "restoring 关注 on load syncs the fold in 关注");
    p.click("modeSwitch", "[data-mode]", { mode: "fav" });
    await p.settle();
    assert.deepStrictEqual(calls, [true, true, false, false], "switching to 收藏夹 syncs it in 收藏夹");
  }

  // S4 / R2: the player. T tags the playing video's UP before the 视频投稿 card under the mouse; B站's autoplay moves the
  // playing mark and its UP on (a video in 视频投稿, or in an UP card's newest posts); an UP not known: T does nothing.
  {
    const p = await followPage({ store: page({ follow_view: { mode: "follow", tab: "feed" } }), handlers: { "follow-feed": () => feed } });
    const { F } = p.FW;
    p.click("followMain", "[data-play]", { play: "BVb" });
    assert.deepStrictEqual([F.viewing, F.viewingMid, p.ctx.S.viewing], ["BVb", "u2", "BVb"]);
    F.hover = "BVc";
    p.key("t");
    assert.deepStrictEqual([plain(p.picks.at(-1)?.targets), p.picks.at(-1)?.anchor], [["u2"], "#fwViewerUp .tag-plus"], "T in the player tags the playing UP, not the hovered card's");
    const autoplay = (bvid) => p.winL.message.forEach((f) => f({ source: p.ctx.el.viewerFrame.contentWindow, origin: "https://www.bilibili.com", data: { type: "mdg-viewer-video", bvid } }));
    autoplay("BVa");
    assert.deepStrictEqual([F.viewing, F.viewingMid], ["BVa", "u1"], "a video only in an UP card's posts");
    autoplay("BVc");
    assert.deepStrictEqual([F.viewing, F.viewingMid], ["BVc", "u1"], "a 视频投稿 video");
    autoplay("BVzz");
    const n = p.picks.length;
    p.key("t");
    assert.deepStrictEqual([F.viewing, F.viewingMid, p.picks.length], ["BVzz", "", n], "an unknown UP: no line, T does nothing");
  }

  // 视频投稿 on B站限流: the foot's amber pill counts down, nothing loads meanwhile, then the same page is asked again.
  {
    let calls = 0;
    const p = await followPage({
      store: page({ follow_view: { mode: "follow", tab: "feed" } }),
      handlers: { "follow-feed": () => (++calls === 2 ? { ok: false, code: "THROTTLED" } : feed) }, // 1: setMode's warm-up
      setup: (ctx) => (ctx.TriageUi.BILI_HOLD_MS = 400)
    });
    const { F } = p.FW;
    const pill = p.$("fwFoot").lastChild;
    assert.ok(F.feed.wait && pill.title === "B站限流卡住，0:01 后重试" && pill.classList.contains("warn"), `the foot counts down: ${pill.title}`);
    p.click("followMain", "[data-fw]", { fw: "more" });
    assert.strictEqual(feedSends(p), 2, "加载更多 does nothing during the wait");
    await p.until(() => F.feed.items.length);
    assert.deepStrictEqual([feedSends(p), F.feed.wait, plain(F.feed.items.map((x) => x.bvid))], [3, false, ["BVb", "BVc"]], "then it loads again by itself");
  }

  // F8 / F10 / F11 / F15: a card pick (X) redraws what counts the selection: 全选 and 清理 in row 3 (drawn in barR), ✦ AI
  // 打标签 in row 4, the bar; the bar has no AI 打标签, its group buttons say how many, a running write is named.
  {
    let release;
    const p = await followPage({
      store: page({ follow_unfollowed: { u3: { at: sec - DAY, source: "app", name: "丙" } } }),
      handlers: { "follow-relation": () => new Promise((r) => (release = r)) }
    });
    const { F, E } = p.FW;
    const found = {};
    E.barR.querySelector = (sel) => (found[sel] ||= { setAttribute(k, v) { this[k] = v; } });
    F.cur = "u1";
    p.key("x");
    assert.strictEqual(found["[data-fw=select-all]"]["aria-checked"], "mixed", "全选 turns mixed on X");
    assert.ok(p.$("fwAiSlot").innerHTML.includes(">AI 打标签选中的 1 个</button>"), p.$("fwAiSlot").innerHTML);
    // K2 / K3: AI 打标签 and the bar count the selected ones listed; filters hiding all of them: all of them, never 0.
    F.sel.add("u2");
    F.q = "甲";
    p.FW.render();
    assert.ok(p.$("fwAiSlot").innerHTML.includes(">AI 打标签选中的 1 个</button>") && E.sel.innerHTML.includes("已选中 1 个</strong><span class=\"muted\">另有 1 个被筛选隐藏</span>"), p.$("fwAiSlot").innerHTML + E.sel.innerHTML);
    F.q = "没有这个人";
    p.FW.render();
    assert.ok(p.$("fwAiSlot").innerHTML.includes(">AI 打标签选中的 2 个</button>") && E.sel.innerHTML.includes("已选中 2 个</strong><span class=\"muted\">都被筛选隐藏</span>"), p.$("fwAiSlot").innerHTML + E.sel.innerHTML);
    F.q = "";
    F.sel.delete("u2");
    p.FW.render();
    const bar = E.sel.innerHTML;
    assert.ok(!bar.includes("AI 打标签") && bar.includes(">移动选中的 1 个到分组…<") && bar.includes(">复制选中的 1 个到分组…<"), bar);
    const running = p.FW.relationRun([{ type: "follow-relation", mid: "u2", act: 2 }], "取消关注");
    await p.until(() => release);
    assert.ok(E.sel.innerHTML.includes('disabled title="取消关注还在跑，等它完成"'), E.sel.innerHTML);
    // G7 / G8: 标签… only changes tags, so the write does not hold it; the cards' B站 buttons (★) are disabled with why.
    assert.ok(E.sel.innerHTML.includes('aria-label="标签…">'), E.sel.innerHTML);
    const n = p.picks.length;
    p.click("followMain", "[data-fw]", { fw: "pick-sel" });
    assert.strictEqual(p.picks.length, n + 1, "标签… opens while a write runs");
    assert.ok(/data-star="u1"[^>]* disabled title="取消关注还在跑，等它完成"/.test(E.list.innerHTML), E.list.innerHTML);
    const side = F.side;
    F.side = "out";
    p.FW.render();
    for (const b of ["refollow", "clean"]) assert.ok(new RegExp(`data-${b}="u3"[^>]* disabled title="取消关注还在跑，等它完成"`).test(E.list.innerHTML), b);
    F.side = side;
    release({ ok: true });
    await running;
    F.sel.clear();
    F.side = "out";
    p.FW.render();
    assert.ok(p.$("fwBarR").innerHTML.includes(">清理这 1 个<"), p.$("fwBarR").innerHTML);
    F.cur = "u3";
    p.key("x");
    assert.ok(found["[data-fw=clean]"].outerHTML?.includes(">清理选中的 1 个<"), "清理 follows the pick");
    // J2: filters hide the whole selection: still 「清理选中的 1 个」, off with why, and a click cleans nothing.
    F.tagState = "tagged";
    p.FW.render();
    assert.ok(p.$("fwBarR").innerHTML.includes('aria-label="清理选中的 1 个" disabled title="选中的都被筛选隐藏了"'), p.$("fwBarR").innerHTML);
    // J14: the bar's buttons count the whole hidden selection too, off with why.
    assert.ok(E.sel.innerHTML.includes('aria-label="重新关注选中的 1 个" disabled title="选中的都被筛选隐藏了"'), E.sel.innerHTML);
    const asked = p.asked.length;
    p.click("followMain", "[data-fw]", { fw: "clean" });
    await p.settle();
    assert.strictEqual(p.asked.length, asked, "no 清理 confirm for a hidden selection");
    F.tagState = "";
    // K1: none of the selection can take it: the count is the selection's, never 0, off with why.
    p.FW.render();
    assert.ok(E.sel.innerHTML.includes('aria-label="取消关注选中的 1 个" disabled title="选中的都已取消关注"'), E.sel.innerHTML);
  }

  // J8: an empty list says why: the search, else the filters, else the group is empty.
  {
    const p = await followPage({ store: page({ follow_unfollowed: { u3: { at: sec - DAY, source: "app", name: "丙" } }, follow_tags: [{ id: "t1", name: "科普", color: "#111" }], follow_tag_map: { u1: ["t1"] } }) });
    const { F, E } = p.FW;
    // J10: row 4's chip says what it lists.
    assert.ok(E.tagRow.innerHTML.includes('title="可多选：只显示同时带有所选标签的 UP 主"'), E.tagRow.innerHTML);
    F.side = "g:-10";
    p.FW.render();
    assert.ok(E.list.innerHTML.includes("这个分组没有 UP 主"), E.list.innerHTML);
    F.side = "all";
    F.tagState = "untagged";
    F.tags = new Set(["t1"]);
    p.FW.render();
    assert.ok(E.list.innerHTML.includes("没有符合筛选的 UP 主"), E.list.innerHTML);
    F.tagState = "";
    F.tags = new Set();
    // J9: #follow&up= into 已出分拣范围 (u3 unfollowed) and back clears the selection, as the sidebar does.
    const hash = async (up) => {
      p.ctx.location.hash = `#follow&up=${up}`;
      for (const f of p.winL.hashchange) await f();
    };
    F.sel.add("u1");
    await hash("u3");
    assert.deepStrictEqual([F.side, F.sel.size], ["out", 0], "into 已出分拣范围");
    F.sel.add("u3");
    await hash("u1");
    assert.deepStrictEqual([F.side, F.sel.size], ["all", 0], "out of it");
  }

  // U on a 关注 write while another runs: refused before its confirm, with 收藏夹's words; the step stays for later.
  {
    let release;
    const p = await followPage({ store: page(), handlers: { "follow-relation": (m) => (m.act === 2 ? new Promise((r) => (release = r)) : { ok: true }) } });
    const { FW } = p;
    const back = () => ["u1", "u2"].map((mid) => ({ type: "follow-relation", mid, act: 1 }));
    FW.pushWriteUndo(["u1", "u2"], { label: "取消关注", backLabel: "重新关注", back, ask: ["在 B站撤销取消关注？", "", "撤销 2 个"] });
    const running = FW.relationRun([{ type: "follow-relation", mid: "u3", act: 2 }], "取消关注");
    await p.until(() => release);
    p.key("u");
    await p.settle();
    assert.deepStrictEqual([p.toasts.at(-1), p.asked.length, p.ctx.S.modeUndo.length], ["取消关注还在跑，等它完成再撤销", 0, 1], "refused before the confirm; the step stays");
    release({ ok: true });
    await running;
    p.key("u");
    await p.until(() => p.toasts.at(-1) === "已撤销：取消关注 2 个");
    assert.deepStrictEqual([plain(p.asked), p.ctx.S.modeUndo.length, p.sent.filter((m) => m.act === 1).map((m) => m.mid).join()], [["在 B站撤销取消关注？"], 0, "u1,u2"], "once it is done, U asks and undoes");
  }

  // K4: a batch 重新关注 is one undo step; U asks first, unfollows them again and puts back their 已取消关注 records.
  {
    const gone = { u3: { at: sec - DAY, source: "app", name: "丙" }, u4: { at: sec - DAY, source: "bili", name: "丁" } };
    const p = await followPage({ store: page({ follow_unfollowed: gone }) });
    await p.FW.refollow(["u3", "u4"]);
    assert.deepStrictEqual([plain(p.asked), p.ctx.S.modeUndo.length, p.toasts.at(-1)], [["在 B站重新关注 2 个 UP 主？"], 1, "已在 B站重新关注 2 个 UP 主 · U 撤销"]);
    p.key("u");
    await p.until(() => p.toasts.at(-1) === "已撤销：重新关注 2 个");
    const back = p.sent.filter((m) => m.act === 2);
    assert.deepStrictEqual([plain(p.asked).at(-1), p.ctx.S.modeUndo.length, plain(back.map((m) => [m.mid, m.gone.source]))], ["在 B站撤销重新关注？", 0, [["u3", "app"], ["u4", "bili"]]]);
  }

  // Running a write keeps its UP 主 selected (DESIGN 筛选和计数): only one it took out of the list (取消关注 here) leaves
  // the selection; one still listed stays, as does one the batch did not reach.
  {
    let store;
    const p = await followPage({
      store: (store = page({ follow_list: { list: ["u1", "u2", "u4"] }, follow_people: { u1: { name: "甲" }, u2: { name: "乙" }, u4: { name: "丁" } } })),
      handlers: { "follow-relation": (m) => (m.act === 2 && ((store.follow_list = { list: store.follow_list.list.filter((x) => x !== m.mid) }), (store.follow_unfollowed = { [m.mid]: { at: sec, source: "app", name: "乙" } })), { ok: true }) }
    });
    const { F, relationRun } = p.FW;
    for (const m of ["u1", "u2", "u4"]) F.sel.add(m);
    await relationRun([{ type: "follow-relation", mid: "u1", act: 1 }, { type: "follow-relation", mid: "u2", act: 2 }], "取消关注");
    assert.deepStrictEqual(plain([...F.sel].sort()), ["u1", "u4"], "the unfollowed one leaves; the rest stay selected");
  }

  // The refresh held by the background (follow_jobs.hold): its pill says why and counts down.
  for (const [why, words] of [["throttled", "B站限流卡住"], ["offline", "网络断了"]]) {
    const p = await followPage({ store: page({ follow_jobs: { running: true, phase: "list", hold: { until: Math.ceil(Date.now() / 1000) + 60, why } } }) });
    const pill = p.$("fwActivity");
    assert.ok(new RegExp(`^读取关注列表 · ${words}，[01]:\\d\\d 后重试$`).test(pill.title) && pill.classList.contains("warn"), pill.title);
  }

  // 暂停刷新 at row 3's right end stops the refresh, as the pill's 暂停 does: one request per click.
  {
    const p = await followPage({ store: page({ follow_jobs: { running: true, phase: "list" } }) });
    assert.ok(p.$("fwBarR").innerHTML.includes("data-fw-stop"), p.$("fwBarR").innerHTML);
    p.click("followMain", "[data-fw-stop]", {});
    assert.strictEqual(p.sent.filter((m) => m.type === "follow-sync-stop").length, 1);
  }

  // Reloaded during the background's queue pause (follow_hold): the 视频投稿 page it waits for shows the countdown at once.
  {
    const p = await followPage({
      store: page({ follow_view: { mode: "follow", tab: "feed" }, follow_hold: { until: Math.ceil(Date.now() / 1000) + 60, why: "throttled" } }),
      handlers: { "follow-feed": () => new Promise(() => {}) }
    });
    const pill = p.$("fwFoot").lastChild;
    assert.ok(p.FW.F.feed.loading && /^B站限流卡住，[01]:\d\d 后重试$/.test(pill.title) && pill.classList.contains("warn"), `the foot counts down: ${pill.title}`);
  }

  // 停止 on a 关注 write's pill: 停止中 (disabled, with why) until the request in flight lands, as 收藏夹's.
  {
    let release;
    const p = await followPage({ store: page(), handlers: { "follow-relation": (m) => (m.mid === "u1" ? new Promise((r) => (release = r)) : { ok: true }) } });
    const running = p.FW.relationRun(["u1", "u2"].map((mid) => ({ type: "follow-relation", mid, act: 2 })), "取消关注");
    await p.until(() => release);
    p.click("followMain", "[data-fw-busystop]", {});
    const pill = p.$("fwActivity").innerHTML;
    assert.ok(pill.includes('aria-label="停止中" disabled title="当前这一批做完就停止"'), pill);
    release({ ok: true });
    await running;
    assert.deepStrictEqual([p.sent.filter((m) => m.type === "follow-relation").length, p.toasts.at(-1)], [1, "已停止取消关注：完成 1 个，未完成 1 个"]);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
