// node extension/triage/shared.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({ setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../typing.js"), "utf8"), ctx);
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
  assert.strictEqual(UI.dayText(new Date(2025, 9, 5, 17, 25).getTime(), now), "2025年10月5日", "another year: the year, no time");
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
assert.strictEqual(UI.resultCount("", 5), "");
assert.strictEqual(UI.resultCount(true, 5), "5 个结果");

// The sort control marks the open sort and says the direction in words.
{
  const html = UI.sortControl({ sorts: { a: "甲", b: "乙" }, sort: "b", dir: "asc", words: "A→Z", selectAttr: "data-s", dirAttr: "data-d" });
  assert.ok(html.includes('<option value="b" selected>乙') && !html.includes('value="a" selected') && html.includes('aria-label="排序方向：A→Z"'));
}

// Counts and durations read the same in both modes: one decimal for 万 and 亿, hours from 60 minutes up.
assert.deepStrictEqual([123456, 100000, 9999, 250000000, 150000].map(UI.fmtCount), ["12.3万", "10万", "9999", "2.5亿", "15万"]);
assert.deepStrictEqual([0, 65, 587, 75 * 60, 3600, 3605, 59.9].map(UI.fmtDuration), ["0:00", "1:05", "9:47", "1:15:00", "1:00:00", "1:00:05", "0:59"]);
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

// Both modes take the proposal functions from here and keep no copy of their own.
for (const file of ["triage.js", "follow.js"]) {
  const src = fs.readFileSync(path.join(__dirname, file), "utf8");
  for (const fn of ["mergeAiBatch", "aiChanges", "aiTally", "previewId"]) {
    assert.ok(!new RegExp(`(function|const|let) ${fn}\\b`).test(src), `${file} has its own ${fn}`);
    assert.ok(src.includes(`UI.${fn}(`), `${file} calls the shared ${fn}`);
  }
}

// Keys from the viewer frame: only that frame, only B站's origin, only T / Esc.
{
  const frame = {};
  const msg = (data, source = frame, origin = "https://www.bilibili.com") => ({ data, source, origin });
  assert.strictEqual(UI.viewerKeyFrom(msg({ type: "mdg-viewer-key", key: "t" }), frame), "t");
  assert.strictEqual(UI.viewerKeyFrom(msg({ type: "mdg-viewer-key", key: "Escape" }), frame), "Escape");
  assert.strictEqual(UI.viewerKeyFrom(msg({ type: "mdg-viewer-key", key: "t" }, {}), frame), "", "another frame / window");
  assert.strictEqual(UI.viewerKeyFrom(msg({ type: "mdg-viewer-key", key: "t" }, frame, "https://evil.example"), frame), "", "another origin");
  assert.strictEqual(UI.viewerKeyFrom(msg({ type: "mdg-viewer-key", key: "d" }), frame), "", "other keys");
  assert.strictEqual(UI.viewerKeyFrom(msg({ type: "x", key: "t" }), frame), "");
  assert.strictEqual(UI.viewerKeyFrom(msg({ type: "mdg-viewer-key", key: "t" }, null), null), "", "no frame loaded");
}

// Tags: a new tag takes the first free color, so deleting a tag frees its color (counting would reuse a taken one).
{
  const C = UI.TAG_COLORS;
  assert.strictEqual(UI.nextTagColor([]), C[0]);
  assert.strictEqual(UI.nextTagColor([{ color: C[0] }, { color: C[2] }]), C[1], "a deleted tag's color is reused, not a taken one");
  assert.strictEqual(UI.nextTagColor(C.map((color) => ({ color }))), C[0], "all taken: round again");
  assert.strictEqual(UI.cycleTagColor(C[0]), C[1]);
  assert.strictEqual(UI.cycleTagColor(C.at(-1)), C[0]);
  assert.strictEqual(UI.cycleTagColor("#000"), C[0], "a color from elsewhere starts the palette");
  assert.strictEqual(UI.tagNameError("", []), "标签名不能为空");
  assert.strictEqual(UI.tagNameError("a", [{ name: "a" }]), "已有同名标签");
  assert.strictEqual(UI.tagNameError("a", [{ name: "b" }]), "");
  // Both modes' 管理 rows: the color button, the who in placeholder and count, escaped names.
  const row = (who) => UI.tagRowHtml({ id: "x", name: "<i>", color: "#fff", rule: "r" }, { count: 3, who });
  for (const [who, words] of [["视频", "视频"], ["UP 主", " UP 主"]]) {
    assert.ok(row(who).includes("data-tag-color") && row(who).includes("data-tag-del") && row(who).includes(`3 个${words}<`) && row(who).includes(`什么样的${words}打这个标签`));
    assert.ok(row(who).includes('value="&lt;i&gt;"') && !row(who).includes("<i>"));
  }
  assert.ok(UI.deleteTagAsk({ name: "甲" }, 2, "UP 主")[1].includes("2 个 UP 主上"));
  assert.deepStrictEqual([...UI.deleteTagAsk({ name: "甲" }, 2, "视频")], ["删除标签「甲」？", "<p>将从 2 个视频上去掉这个标签，无法撤销。</p>"]);
  assert.ok(UI.tagPlusBtn('data-x="1"', "给 <b> 打标签").includes('data-x="1" aria-label="给 &lt;b&gt; 打标签">+ 标签 <kbd'));
}

// 标签管理 edits and deletes, one implementation for both modes: a cleared rule drops the field (关注 used to keep ""),
// names are cleaned and checked, the color cycles; a deleted tag leaves every item, and an item left bare drops out.
{
  const t0 = { id: "a", name: "甲", color: UI.TAG_COLORS[0], rule: "旧说明" };
  assert.deepStrictEqual(plain(UI.editedTag(t0, "rule", "  ").tag), { id: "a", name: "甲", color: UI.TAG_COLORS[0] });
  assert.strictEqual(UI.editedTag(t0, "rule", ` ${"讲".repeat(90)} `).tag.rule.length, 80);
  assert.strictEqual(UI.editedTag(t0, "name", " 乙, ", []).tag.name, "乙");
  assert.deepStrictEqual(plain(UI.editedTag(t0, "name", "乙", [{ name: "乙" }])), { why: "已有同名标签" });
  assert.strictEqual(UI.editedTag(t0, "color").tag.color, UI.TAG_COLORS[1]);
  assert.strictEqual(t0.rule, "旧说明", "the tag itself is not changed");
  assert.deepStrictEqual([...UI.tagsUndoAsk(3, "UP 主")], ["撤销批量改标签？", "<p>上一步改了 3 个 UP 主的标签，撤销后都改回去。</p>", "撤销"]);
  assert.deepStrictEqual(plain(UI.withoutTag({ x: ["a", "b"], y: ["a"] }, "a")), { x: ["b"] });
  // follow.js's page part is not in a harness; it must go through the same functions.
  const follow = fs.readFileSync(path.join(__dirname, "follow.js"), "utf8");
  assert.ok(follow.includes("UI.editedTag(") && follow.includes("UI.withoutTag("), "关注 edits and deletes tags with the shared functions");
}

// 全选: none / some / all of what is listed → unchecked / mixed / checked. Nothing listed: 「全选」 with no number, disabled
// with a reason. A click deselects only when every listed one is selected, and never touches what is not listed.
{
  assert.deepStrictEqual([UI.selectAllState(3, 0), UI.selectAllState(3, 1), UI.selectAllState(3, 3), UI.selectAllState(0, 0)], ["false", "mixed", "true", "false"]);
  const box = UI.selectAllBox('data-x="all"', 3, 1);
  assert.ok(box.includes('role="checkbox"') && box.includes('aria-checked="mixed"') && box.includes("全选 3 个") && !box.includes("disabled"), box);
  const none = UI.selectAllBox('data-x="all"', 0, 0);
  assert.ok(none.includes(">全选</button>") && none.includes('disabled title="这里没有列出可选的" aria-description="这里没有列出可选的"'), none);
  const sel = new Set(["hidden", "a"]);
  UI.toggleAll(["a", "b"], sel);
  assert.deepStrictEqual([...sel].sort(), ["a", "b", "hidden"], "some selected → all listed selected");
  UI.toggleAll(["a", "b"], sel);
  assert.deepStrictEqual([...sel], ["hidden"], "all selected → listed ones deselected, the hidden one stays");
}

// A disabled control says why (tooltip + aria-description); an enabled one keeps its usual tooltip.
{
  assert.strictEqual(UI.reasonAttrs("", "提示"), ' title="提示"');
  assert.strictEqual(UI.reasonAttrs("", ""), "");
  assert.strictEqual(UI.reasonAttrs("没有<视频>", "提示"), ' disabled title="没有&lt;视频&gt;" aria-description="没有&lt;视频&gt;"');
  const attrs = {};
  const node = { setAttribute: (k, v) => (attrs[k] = v), removeAttribute: (k) => delete attrs[k] };
  UI.setReason(node, "作用范围里没有视频");
  assert.deepStrictEqual([node.disabled, node.title, attrs["aria-description"]], [true, "作用范围里没有视频", "作用范围里没有视频"]);
  UI.setReason(node, "");
  assert.deepStrictEqual([node.disabled, node.title, attrs["aria-description"]], [false, "", undefined]);
  // 标签管理: the warn dot while there are no tags, not when it is disabled anyway.
  assert.ok(UI.tagButtons({ manageAttrs: "data-m", aiAttrs: "data-a", noTags: true }).includes('aria-label="标签管理（还没有标签）">标签管理<i class="dot-warn"'));
  const off = UI.tagButtons({ manageAttrs: "data-m", aiAttrs: "data-a", noTags: true, manageReason: "先打开", aiReason: "先打开" });
  assert.ok(!off.includes("dot-warn") && (off.match(/disabled title="先打开"/g) || []).length === 2, off);
}

console.log("shared selftest: all passed");

// The search box, both modes (收藏夹 and 关注 bind it the same way): Esc clears it; Esc on an empty box blurs it, so J / K
// reach the cards again; Esc that belongs to the IME does nothing.
{
  const L = {};
  let blurred = 0;
  const got = [];
  const input = { value: "", addEventListener: (type, f) => (L[type] ||= []).push(f), blur: () => blurred++ };
  UI.bindSearch(input, (q) => got.push(q));
  const esc = (o = {}) => {
    const e = { key: "Escape", isComposing: false, keyCode: 27, prevented: 0, preventDefault() { this.prevented++; }, ...o };
    L.keydown.forEach((f) => f(e));
    return e;
  };
  input.value = "路";
  assert.strictEqual(esc({ isComposing: true }).prevented, 0, "the IME's Esc");
  esc();
  assert.deepStrictEqual([input.value, got.join(), blurred], ["", "", 0], "Esc clears the box and the search");
  esc();
  assert.strictEqual(blurred, 1, "Esc on an empty box blurs it");
  assert.ok(L.compositionend && L.input, "it filters through bindLive");
  for (const f of ["triage.js", "follow.js"]) assert.ok(fs.readFileSync(path.join(__dirname, f), "utf8").includes("UI.bindSearch("), `${f} binds its search with bindSearch`);
}
