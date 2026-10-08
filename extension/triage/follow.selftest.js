// node extension/triage/follow.selftest.js
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
vm.runInContext(fs.readFileSync(path.join(__dirname, "../tag-core.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "shared.js"), "utf8"), ctx);
vm.runInContext(`const UI = globalThis.TriageUi;\n${pure}\n;Object.assign(globalThis, { syncFinished, dirLabel, followAiSettings, aiRequests, normDays, settingsProblem, followStatus, lastPostOf, recentTitles, upRow, visibleUps, mergeFeed, feedMatch, sideIds, feedList, feedLeaving, withTags, stepIn, tagsOf, restoreTags, fmtAgo, feedCounts, STATUS, viewRecord, latestBvid, aiBlocked, withAllowRemove });`, ctx);
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
  assert.deepStrictEqual(v({ tagState: "untagged" }).list, ["1", "4"]);
  assert.deepStrictEqual(v({ side: "special" }).list, ["3"]);
  assert.deepStrictEqual(v({ tags: new Set(["t1"]) }).list, ["3", "2"]);
  assert.deepStrictEqual(v({ side: "gone" }).list, ["8", "9"], "已取消关注: newest first, list order kept");
  assert.deepStrictEqual(v({ side: "gone", source: "bili" }).list, ["9"]);
  assert.deepStrictEqual(v({ q: "原理" }).list, ["2"], "search reads the sign too");
  const c = v({ status: "active" });
  assert.deepStrictEqual(c.list, ["1", "3"]);
  assert.deepStrictEqual(c.counts, { "": 4, active: 2, slow: 1, stale: 1, tagged: 1, untagged: 1, recent: 0, tags: { t1: 1 } }, "status counts ignore the status pick; the other groups apply it");
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
  assert.ok(t.feedMatch(it("3"), D, "special") && !t.feedMatch(it("1"), D, "special"));
  assert.ok(!t.feedMatch(it("1"), D, "gone"));
}

// ----- B站 分组: read-only filters "g:<tagid>" for the UP list and the feed, absent when there are none -----
{
  const D = base();
  D.list = { list: ["1", "2", "3"], groups: { 1: [7], 2: [7, 8], 3: [0] } };
  D.people = { 1: { name: "a" }, 2: { name: "b" }, 3: { name: "c" } };
  D.tags = [{ id: "t1" }];
  assert.deepStrictEqual(plain(t.sideIds(D)), ["all", "special", "gone"], "the sidebar is scope only: no tag items");
  D.groups = [];
  assert.deepStrictEqual(plain(t.sideIds(D)), ["all", "special", "gone"], "no custom groups: nothing added");
  D.groups = [{ id: 7, name: "数码" }, { id: 8, name: "音乐" }];
  assert.deepStrictEqual(plain(t.sideIds(D)).slice(3), ["g:7", "g:8"]);
  const rows = new Map(D.list.list.map((m) => [m, t.upRow(m, D, now, {})]));
  const v = (side, status = "") => plain(t.visibleUps(D, rows, { side, status, q: "" }));
  assert.deepStrictEqual(v("g:7").list.sort(), ["1", "2"]);
  assert.deepStrictEqual(v("g:8").list, ["2"]);
  assert.strictEqual(v("g:7").counts[""], 2, "counts are over the group's members");
  assert.deepStrictEqual(v("g:7", "active").list, [], "the 状态 filter applies on top");
  assert.ok(t.feedMatch({ mid: "2" }, D, "g:8") && !t.feedMatch({ mid: "1" }, D, "g:8") && !t.feedMatch({ mid: "9" }, D, "g:7"));
}


// ----- 关注's own AI settings: first use copies 收藏夹's, then they are independent -----
{
  const triage = { triageTitleBatchSize: 15, triageIntervalSec: 2, triageAiNewTagMax: 3, triageAiRemoveTags: true };
  const first = plain(t.followAiSettings(undefined, triage));
  assert.deepStrictEqual(first.value, { batchSize: 15, intervalSec: 2, newTagMax: 3, allowRemove: true }, "seeded from 收藏夹");
  assert.deepStrictEqual(first.seed, first.value, "the seed is stored");
  assert.strictEqual(t.followAiSettings(undefined, { ...triage, triageAiBatchSize: 7 }).value.batchSize, 7, "收藏夹's own AI 打标签 batch size, once it has one");
  assert.strictEqual(t.followAiSettings(undefined, { ...triage, triageAiBatchSize: null }).value.batchSize, 15, "else the 标题粗看 value it used to share");
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
  assert.deepStrictEqual(plain(t.normDays("1", "99999")), { followSlowDays: 7, followDeadDays: 3651 }, "clamped");
  assert.strictEqual(t.settingsProblem("90", "90"), "断更天数要比慢更大");
  assert.strictEqual(t.settingsProblem("120", "60"), "断更天数要比慢更大");
  assert.strictEqual(t.settingsProblem("", ""), "");
  assert.strictEqual(t.settingsProblem("30", "200"), "");
}

assert.deepStrictEqual([t.dirLabel("last", "desc"), t.dirLabel("follow", "asc"), t.dirLabel("fans", "desc"), t.dirLabel("fans", "asc")], ["新→旧", "旧→新", "从多到少", "从少到多"]);
assert.strictEqual(t.fmtAgo(now - 100, now), "今天");
assert.strictEqual(t.fmtAgo(ago(3), now), "3 天前");
assert.strictEqual(t.fmtAgo(ago(65), now), "2 个月前");
assert.strictEqual(t.fmtAgo(ago(800), now), "2 年前");

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
  assert.deepStrictEqual(plain(t.restoreTags(now, before, new Set(["x", "y", "z", "w"]))), { a: ["x"], b: ["y", "w"] }, "b's later edit stays");
  assert.deepStrictEqual(plain(t.restoreTags({}, { a: ["x", "dead"] }, new Set(["x"]))), { a: ["x"] }, "a tag deleted since stays gone");
}

// One keydown handler for the page (triage.js onKey): follow.js hands it its keys, and triage.js knows no 关注 ids.
{
  assert.ok(!/addEventListener\("keydown"/.test(source), "follow.js has no page-wide keydown listener");
  assert.ok(source.includes("T.setModeKeys("), "follow.js registers its keys");
  assert.ok(!/fw[A-Z]/.test(fs.readFileSync(path.join(__dirname, "triage.js"), "utf8")), "triage.js names no 关注 element");
}

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

// 标签… on 2+ UP 主 is one step that asks before U, with 收藏夹's words (shared.js undoAsk).
assert.ok(source.includes(`pushTagUndo(before, "标签修改", { ask: changes.length > 1 ? UI.undoAsk("tags", changes.length, "UP 主") : null });`), "pickClosed asks for 2+");

// B站 writes and U (DESIGN §5): a single 重新关注 has no confirm and U unfollows again with its 已取消关注 record; batch
// 特别关注 is one step that asks before U; single 取消关注 keeps its confirm.
{
  const fn = (name) => source.slice(source.indexOf(`function ${name}(`), source.indexOf("\n}\n", source.indexOf(`function ${name}(`)));
  const re = fn("refollow");
  assert.ok(re.indexOf("mids.length === 1") < re.indexOf("askConfirm") && /act: 2, gone/.test(re) && re.includes("已在 B站重新关注「"), "single 重新关注: no confirm, U with the record");
  assert.ok(/pushWriteUndo\(done, \{[\s\S]*ask: \[`在 B站把/.test(fn("setSpecial")), "batch 特别关注 is undoable, asked with 在 B站…");
  assert.ok(source.includes("const starOne = (mid) => setSpecial([mid], !rows.get(mid).special);"), "★ goes the same way");
  assert.ok(fn("pushWriteUndo").includes("ask: done.length > 1 ? ask : null"), "U asks for 2+ only");
  assert.ok(/async function unfollow[\s\S]*?askConfirm/.test(source), "取消关注 still asks");
}

// 关注设置 and the AI settings it seeds: a failed chrome.storage.sync.set says so, as 收藏夹设置 does.
assert.strictEqual((source.match(/chrome\.storage\.sync\.set\(/g) || []).length, 3);
assert.ok(/\.set\(\{ follow_ai_settings: seed \}\)\.catch\(\(e\) => toast\(`保存设置失败：/.test(source) && /try \{\s*await chrome\.storage\.sync\.set\(\{ follow_ai_settings: ai, \.\.\.days \}\);\s*\} catch \(e\) \{\s*return toast\(`保存设置失败：/.test(source), "both writes catch");

// The player's T / Esc reach 关注 through triage.js's one message listener (modeKeys), as page keys do.
assert.ok(!/addEventListener\("message"/.test(source), "follow.js has no message listener of its own");

// 已取消关注 is a filter like the others: the selection stays, the ones not listed show as 「另有 N 个被筛选隐藏」.
assert.ok(source.includes("for (const m of [...F.sel]) if (!rows.has(m)) F.sel.delete(m);"), "renderUps drops only UP 主 that are gone from the data");

// Rows 3 and 4 (DESIGN §3): row 3's groups AND together, one pick each, and each group counts with its own pick left out;
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
assert.ok(source.includes('if (typeof view?.side === "string") F.side = view.side;') && /function pickSide\(id\) \{[^}]*saveView\(\);/.test(source), "restored on load, saved on every pick");
// B13: I = ✦ AI 打标签 (or why not), O / Enter plays the current UP's newest video that has a bvid.
assert.strictEqual(t.latestBvid({ titles: [{ t: "a" }, { t: "b", bvid: "BV2" }, { t: "c", bvid: "BV3" }] }), "BV2");
assert.strictEqual(t.latestBvid({ titles: [{ t: "a" }] }), "");
assert.strictEqual(t.aiBlocked("ups", "all"), "");
assert.ok(t.aiBlocked("feed", "all") && t.aiBlocked("ups", "gone"), "视频投稿 and 已取消关注 say why");
{
  const key = source.slice(source.indexOf("function followKey("), source.indexOf("T.setModeKeys"));
  assert.ok(key.includes('key === "i") aiReason() ? toast(aiReason()) : openAi()') && /key === "o" \|\| key === "Enter"\) && shown\.includes\(F\.cur\)\) \{\s*const bvid = latestBvid\(rows\.get\(F\.cur\)\);\s*bvid \? play\(bvid\)/.test(key), "followKey has I and O / Enter");
}
// B15: 「允许 AI 去掉已有标签」 is kept in follow_ai_settings, as 收藏夹 keeps its own.
assert.deepStrictEqual(plain(t.withAllowRemove({ batchSize: 10, intervalSec: 2, newTagMax: 1, allowRemove: false }, true)), { batchSize: 10, intervalSec: 2, newTagMax: 1, allowRemove: true });
assert.ok(/async setAllowRemove\(on\) \{\s*const next = withAllowRemove\(await aiSettings\(\), on\);\s*try \{\s*await chrome\.storage\.sync\.set\(\{ follow_ai_settings: next \}\);/.test(source), "the AI dialog's switch saves");

// The 关注 tab is 视频投稿 (we read only B站's video posts, which B站 itself calls 视频投稿): no page text says 动态.
// Comments may; B站 page scripts outside triage/ talk about B站's own 动态 page.
for (const f of ["triage.html", "triage.js", "follow.js", "follow-bg.js", "shared.js", "tag-picker.js", "tag-dialogs.js"]) {
  const text = fs.readFileSync(path.join(__dirname, f), "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.ok(!text.includes("动态"), `${f} still says 动态 to the user`);
}

console.log("follow selftest: all passed");
