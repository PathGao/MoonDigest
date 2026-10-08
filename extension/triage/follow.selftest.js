// node extension/triage/follow.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// follow.js is a page module; lift only its pure block (between the PURE markers).
const source = fs.readFileSync(path.join(__dirname, "follow.js"), "utf8");
const pure = source.slice(source.indexOf("// PURE-START"), source.indexOf("// PURE-END"));
assert.ok(pure.includes("function followStatus") && !pure.includes("document"), "harness lifts the pure block");
const ctx = vm.createContext({});
vm.runInContext(`${pure}\n;Object.assign(globalThis, { followAiSettings, aiRequests, normDays, followStatus, lastPostOf, recentTitles, upRow, visibleUps, mergeFeed, feedMatch, mergeAiBatch, aiChanges, aiTally, fmtAgo });`, ctx);
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
  assert.deepStrictEqual(v({ side: "untagged" }).list, ["1", "4"]);
  assert.deepStrictEqual(v({ side: "special" }).list, ["3"]);
  assert.deepStrictEqual(v({ side: "t1" }).list, ["3", "2"]);
  assert.deepStrictEqual(v({ side: "gone" }).list, ["8", "9"], "已取消关注: newest first, list order kept");
  assert.deepStrictEqual(v({ side: "gone", source: "bili" }).list, ["9"]);
  assert.deepStrictEqual(v({ q: "原理" }).list, ["2"], "search reads the sign too");
  const c = v({ status: "active" });
  assert.deepStrictEqual(c.list, ["1", "3"]);
  assert.deepStrictEqual(c.counts, { "": 4, active: 2, slow: 1, stale: 1 }, "counts ignore the status filter");
  assert.deepStrictEqual(v({ recent: new Set(["4", "2"]) }).list, ["2", "4"], "「AI 刚打的」 narrows the list");
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
  assert.ok(t.feedMatch(it("1"), D, "t1") && !t.feedMatch(it("2"), D, "t1"));
  assert.ok(t.feedMatch(it("2"), D, "untagged"), "only a deleted tag = untagged");
  assert.ok(t.feedMatch(it("3"), D, "special") && !t.feedMatch(it("1"), D, "special"));
  assert.ok(!t.feedMatch(it("1"), D, "gone"));
}

// ----- AI proposal: merge, cap, excluded, changes, tally -----
{
  const tags = [{ id: "t1", name: "科普" }, { id: "t2", name: "游戏" }];
  const map = { a: ["t1"], b: ["t2"] };
  const opts = { tags, map, maxNewTags: 1, excluded: new Set(["游戏"]), scope: new Set(["a", "b", "c"]) };
  const p = { newTags: [], rows: [], notes: [], errors: [] };
  t.mergeAiBatch(p, { newTags: ["美食", "旅行"], assignments: { a: { add: ["科普", "美食"], remove: [] }, b: { add: ["旅行"], remove: ["游戏"] }, c: { add: ["游戏", "科普"] }, z: { add: ["科普"] } }, note: "n1" }, opts);
  t.mergeAiBatch(p, { assignments: { c: { add: ["美食"], remove: ["科普"] } } }, opts);
  assert.deepStrictEqual(plain(p.newTags).map((x) => x.name), ["美食"], "new tags capped at maxNewTags");
  assert.deepStrictEqual(plain(p.rows), [
    { mid: "a", add: ["new:美食"], remove: [] },
    { mid: "c", add: ["id:t1", "new:美食"], remove: [] }
  ], "existing tag on a → nothing; excluded 游戏 never added or removed; out-of-scope z dropped; batches merge per UP");
  assert.deepStrictEqual(p.notes, ["n1"]);
  const follow = new Set(["a", "b"]); // c was unfollowed while the proposal was open
  const ch = plain(t.aiChanges(p, map, follow, (key) => `new-${key}`));
  assert.deepStrictEqual(ch, [["a", ["t1"], ["t1", "new-美食"]]], "an unfollowed UP gets nothing");
  p.newTags[0].checked = false;
  assert.deepStrictEqual(plain(t.aiChanges(p, map, follow, (key) => `new-${key}`)), [], "an unchecked new tag adds nothing");
  p.newTags[0].checked = true;
  const tally = plain(t.aiTally([["a", ["t1"], ["t1", "n"]], ["b", ["t1"], ["n"]], ["c", ["t2"], ["t2", "n"]]], (id) => ({ t1: "科普", t2: "游戏", n: "美食" })[id]));
  assert.deepStrictEqual(tally, [{ cls: "add", text: "+ 美食", n: 3 }, { cls: "remove", text: "− 科普", n: 1 }]);
}

// ----- 关注's own AI settings: first use copies 收藏夹's, then they are independent -----
{
  const triage = { triageTitleBatchSize: 15, triageIntervalSec: 2, triageAiNewTagMax: 3, triageAiRemoveTags: true };
  const first = plain(t.followAiSettings(undefined, triage));
  assert.deepStrictEqual(first.value, { batchSize: 15, intervalSec: 2, newTagMax: 3, allowRemove: true }, "seeded from 收藏夹");
  assert.deepStrictEqual(first.seed, first.value, "the seed is stored");
  assert.deepStrictEqual(plain(t.followAiSettings(undefined, null)).value, { batchSize: 30, intervalSec: 8, newTagMax: 5, allowRemove: false }, "global defaults without 收藏夹 settings");
  const own = { batchSize: 40, intervalSec: 0, newTagMax: 0, allowRemove: false };
  const later = plain(t.followAiSettings(own, { ...triage, triageTitleBatchSize: 99, triageAiNewTagMax: 9 }));
  assert.deepStrictEqual(later, { value: own, seed: null }, "a stored 关注 value wins; 收藏夹 changes do not leak in");
  assert.deepStrictEqual(plain(t.followAiSettings({ batchSize: 500, intervalSec: -3, newTagMax: "x" }, null)).value, { batchSize: 100, intervalSec: 0, newTagMax: 5, allowRemove: false }, "clamped");
  // The requests use 关注's values
  const { batches, intervalMs } = plain(t.aiRequests(["a", "b", "c", "d", "e"], { batchSize: 2, intervalSec: 3, newTagMax: 1, allowRemove: false }, "分", [], true));
  assert.deepStrictEqual(batches.map((b) => b.mids), [["a", "b"], ["c", "d"], ["e"]]);
  assert.ok(batches.every((b) => b.type === "follow-ai-tag" && b.maxNewTags === 1 && b.allowRemove === true && b.instruction === "分"));
  assert.strictEqual(intervalMs, 3000);
  assert.deepStrictEqual(plain(t.normDays("", "")), { followSlowDays: 90, followDeadDays: 365 });
  assert.deepStrictEqual(plain(t.normDays("400", "100")), { followSlowDays: 400, followDeadDays: 401 });
}

assert.strictEqual(t.fmtAgo(now - 100, now), "今天");
assert.strictEqual(t.fmtAgo(ago(3), now), "3 天前");
assert.strictEqual(t.fmtAgo(ago(65), now), "2 个月前");
assert.strictEqual(t.fmtAgo(ago(800), now), "2 年前");

console.log("follow selftest: all passed");
