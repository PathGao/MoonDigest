// node extension/triage/shared.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "shared.js"), "utf8"), ctx);
const UI = ctx.TriageUi;
const plain = (v) => JSON.parse(JSON.stringify(v));

// 「今天 / 昨天 / 10月5日 HH:MM 刷新过」, by calendar day, not by 24 hours.
{
  const now = new Date(2026, 9, 8, 0, 30).getTime();
  assert.strictEqual(UI.syncedText(0, now), "");
  assert.strictEqual(UI.syncedText(new Date(2026, 9, 8, 0, 5).getTime(), now), "今天 00:05 刷新过");
  assert.strictEqual(UI.syncedText(new Date(2026, 9, 7, 23, 59).getTime(), now), "昨天 23:59 刷新过", "an hour ago but before midnight");
  assert.strictEqual(UI.syncedText(new Date(2026, 9, 5, 17, 25).getTime(), now), "10月5日 17:25 刷新过");
}

// A 0 count stays and is dimmed; no count (null) is not 0.
{
  assert.ok(UI.filterBtn('data-x="a"', "全部", 0, false).includes('class="zero">全部 0<'));
  assert.ok(!UI.filterBtn('data-x="a"', "全部", 3, true).includes("zero"));
  assert.ok(!UI.filterBtn('data-x="a"', "全部", null, false).includes("zero") && UI.filterBtn('data-x="a"', "全部", null, false).includes(">全部</button>"));
  assert.ok(UI.filterBtn('data-x="a"', "<b>", 1, false).includes("&lt;b&gt; 1"), "labels are escaped");
}

// Row 1's meta keeps the error after the parts; empty parts drop out.
assert.strictEqual(UI.headMeta(["今天 10:00 刷新过", 0, "2 个已失效"], ""), "今天 10:00 刷新过 · 2 个已失效");
assert.strictEqual(UI.headMeta(["a"], "出错了"), 'a · <span class="fail-text">出错了</span>');
assert.strictEqual(UI.resultCount("  ", 5), "");
assert.strictEqual(UI.resultCount("x", 5), "5 个结果");

// The sort control marks the open sort and says the direction in words.
{
  const html = UI.sortControl({ sorts: { a: "甲", b: "乙" }, sort: "b", dir: "asc", words: "A→Z", selectAttr: "data-s", dirAttr: "data-d" });
  assert.ok(html.includes('<option value="b" selected>乙') && !html.includes('value="a" selected') && html.includes('aria-label="排序方向：A→Z"'));
}

// Counts and durations read the same in both modes: one decimal for 万 and 亿, hours from 60 minutes up.
assert.deepStrictEqual([123456, 100000, 9999, 250000000, 150000].map(UI.fmtCount), ["12.3万", "10万", "9999", "2.5亿", "15万"]);
assert.deepStrictEqual([0, 65, 75 * 60, 3600, 59.9].map(UI.fmtDuration), ["00:00", "01:05", "1:15:00", "1:00:00", "00:59"]);
assert.strictEqual(UI.fmtDate(0), "");
assert.strictEqual(UI.fmtDate(new Date(2026, 0, 5, 12).getTime() / 1000), "2026-01-05");
assert.strictEqual(UI.img("//i0.hdslb.com/a.jpg", "48w_48h_1c"), "https://i0.hdslb.com/a.jpg@48w_48h_1c.webp");
assert.strictEqual(UI.img("https://i0.hdslb.com/a.jpg@1c.webp", "48w"), "https://i0.hdslb.com/a.jpg@1c.webp", "a sized URL stays");

// Tag names: the pages and the background clean them the same way, so AI suggestions match what was typed.
{
  const bg = fs.readFileSync(path.join(__dirname, "triage-bg.js"), "utf8");
  const at = bg.indexOf("function triageCleanTagName(");
  vm.runInContext(bg.slice(at, bg.indexOf("\n}\n", at) + 2), ctx);
  const cases = [["入门，进阶", "入门进阶"], ["入门, 进阶", "入门 进阶"], ["a，b、c,d", "abcd"], [" 一二三四五六七八九十甲乙丙 ", "一二三四五六七八九十甲乙"], ["、", ""], [null, ""], ["  AI  ", "AI"]];
  for (const [raw, want] of cases) {
    assert.strictEqual(UI.cleanTagName(raw), want, String(raw));
    assert.strictEqual(ctx.triageCleanTagName(raw), want, `background: ${raw}`);
  }
}

// Video links: only a plain primary click plays here; modified clicks are the browser's.
{
  const click = (o) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });
  assert.ok(UI.plainClick(click({})));
  for (const k of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) assert.ok(!UI.plainClick(click({ [k]: true })), k);
  assert.ok(!UI.plainClick(click({ button: 1 })), "middle click");
}

// CSV: cells a spreadsheet would run as a formula get a leading '; BOM and CRLF around the rows.
{
  for (const s of ["=1+1", "+cmd", "-2", "@SUM(A1)", "\tx", "\rx"]) assert.ok(UI.toCsv([[s]]).slice(1).replace(/^"/, "").startsWith(`'${s[0]}`), JSON.stringify(s));
  assert.strictEqual(UI.toCsv([['=HYPERLINK("x")', "普通 标题", "a,b"], [1, null]]), `\ufeff"'=HYPERLINK(""x"")",普通 标题,"a,b"\r\n1,\r\n`);
}

// A card's tag chip escapes its name and says what undoes it.
assert.ok(UI.cardTagChip({ id: "t1", name: "<b>", color: "#fff" }, "点一下去掉").includes('data-untag="t1" aria-label="去掉标签 &lt;b&gt;" title="点一下去掉">&lt;b&gt;<span class="x"'));

// AI 打标签's proposal, as both modes use it: merge, cap, excluded, changes, tally. Rows are UPs here, videos in 收藏夹.
{
  const tags = [{ id: "t1", name: "科普" }, { id: "t2", name: "游戏" }];
  const map = { a: ["t1"], b: ["t2"] };
  const opts = { tags, map, maxNewTags: 1, excluded: new Set(["游戏"]), scope: new Set(["a", "b", "c"]) };
  const p = { newTags: [], rows: [], notes: [], errors: [] };
  UI.mergeAiBatch(p, { newTags: ["美食", "旅行"], assignments: { a: { add: ["科普", "美食"], remove: [] }, b: { add: ["旅行"], remove: ["游戏"] }, c: { add: ["游戏", "科普"] }, z: { add: ["科普"] } }, note: "n1" }, opts);
  UI.mergeAiBatch(p, { assignments: { c: { add: ["美食"], remove: ["科普"] } } }, opts);
  assert.deepStrictEqual(plain(p.newTags).map((x) => x.name), ["美食"], "new tags capped at maxNewTags");
  assert.deepStrictEqual(plain(p.rows), [
    { id: "a", add: ["new:美食"], remove: [] },
    { id: "c", add: ["id:t1", "new:美食"], remove: [] }
  ], "existing tag on a → nothing; excluded 游戏 never added or removed; out-of-scope z dropped; batches merge per UP");
  assert.deepStrictEqual(p.notes, ["n1"]);
  const follow = new Set(["a", "b"]); // c was unfollowed while the proposal was open
  const ch = plain(UI.aiChanges(p, map, follow, (key) => `new-${key}`));
  assert.deepStrictEqual(ch, [["a", ["t1"], ["t1", "new-美食"]]], "an unfollowed UP gets nothing");
  p.newTags[0].checked = false;
  assert.deepStrictEqual(plain(UI.aiChanges(p, map, follow, (key) => `new-${key}`)), [], "an unchecked new tag adds nothing");
  p.newTags[0].checked = true;
  const tally = plain(UI.aiTally(p, [["a", ["t1"], ["t1", "n"]], ["b", ["t1"], ["n"]], ["c", ["t2"], ["t2", "n"]]], (id) => ({ t1: "科普", t2: "游戏", n: "美食" })[id]));
  assert.deepStrictEqual(tally, [{ cls: "add", text: "+ 美食", n: 3 }, { cls: "remove", text: "− 科普", n: 1 }]);
}

console.log("shared selftest: all passed");
