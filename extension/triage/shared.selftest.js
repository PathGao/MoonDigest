// node extension/triage/shared.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({ setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../typing.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../tag-core.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "shared.js"), "utf8"), ctx);
const UI = ctx.TriageUi;
const plain = (v) => JSON.parse(JSON.stringify(v));

// Headroom: reading down past the header folds it; any step back up, the top, or focus in the header unfolds it.
{
  const step = (s, top, full = 200) => plain(UI.headroomStep(s, { top, full }));
  let s = { collapsed: false, last: 0 };
  s = step(s, 150);
  assert.deepStrictEqual(s, { collapsed: false, last: 150 }, "within the header's height: stays full");
  s = step(s, 260);
  assert.deepStrictEqual(s, { collapsed: true, last: 260 }, "forward past the header: folds");
  assert.deepStrictEqual(step(s, 265), s, "a step under 8px is ignored");
  assert.deepStrictEqual(step(s, 253), { collapsed: true, last: 260 }, "so is a small step back");
  assert.deepStrictEqual(step(s, 250), { collapsed: false, last: 250 }, "any real step back unfolds");
  assert.deepStrictEqual(step({ collapsed: true, last: 5000 }, 4990), { collapsed: false, last: 4990 }, "far from the top too");
  let slow = s;
  for (const top of [263, 266, 269]) slow = step(slow, top);
  assert.deepStrictEqual(slow, { collapsed: true, last: 269 }, "slow 3px steps add up: last moves only on a counted step");
  slow = { collapsed: false, last: 300 };
  for (const top of [303, 306, 309]) slow = step(slow, top);
  assert.deepStrictEqual(slow, { collapsed: true, last: 309 }, "slow forward steps fold too once they reach 8px");
  assert.deepStrictEqual(step({ collapsed: true, last: 5 }, 0), { collapsed: false, last: 0 }, "the top is always full, even by a small step");
  assert.deepStrictEqual(plain(UI.headroomStep({ collapsed: true, last: 900 }, { focus: true })), { collapsed: false, last: 900 }, "focus in the header unfolds");
  assert.deepStrictEqual(step({ collapsed: false, last: 900 }, 1000), { collapsed: true, last: 1000 }, "after a focus, the next read down folds again");
}

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

// Tag names (the background uses this same function, so AI suggestions match what was typed).
{
  const cases = [["入门，进阶", "入门进阶"], ["入门, 进阶", "入门 进阶"], ["a，b、c,d", "abcd"], [" 一二三四五六七八九十甲乙丙 ", "一二三四五六七八九十甲乙"], ["、", ""], [null, ""], ["  AI  ", "AI"]];
  for (const [raw, want] of cases) {
    assert.strictEqual(UI.cleanTagName(raw), want, String(raw));
  }
}

// Video links: only a plain primary click plays here; modified clicks are the browser's.
{
  const click = (o) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });
  assert.ok(UI.plainClick(click({})));
  for (const k of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) assert.ok(!UI.plainClick(click({ [k]: true })), k);
  assert.ok(!UI.plainClick(click({ button: 1 })), "middle click");
}

// Whole video card: a plain click anywhere plays, except on a control inside the card or after a text-selection drag.
// A tiny closest() for the selector shapes shared.js uses: tag, [attr], [attr=v], :not(...), comma lists.
{
  const split = (sel) => sel.split(/,(?![^(]*\))/).map((x) => x.trim());
  const matches = (el, sel) =>
    split(sel).some((one) => {
      const [, tag, attrs, not] = one.match(/^([a-z]*)((?:\[[^\]]+\])*)(?::not\((.*)\))?$/);
      if (tag && el.tag !== tag) return false;
      for (const [, k, v] of attrs.matchAll(/\[([\w-]+)(?:=([^\]]+))?\]/g)) if (!(k in el.attrs) || (v !== undefined && el.attrs[k] !== v)) return false;
      return !(not && matches(el, not));
    });
  const node = (tag, attrs = {}, parent = null) => ({ tag, attrs, parent, closest(sel) { for (let n = this; n; n = n.parent) if (matches(n, sel)) return n; return null; } });
  const card = node("article", { "data-bvid": "BV1" });
  const body = node("div", {}, card);
  const click = (target, o) => ({ target, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });
  const plays = (target, o) => UI.cardPlayClick(click(target, o));
  assert.ok(plays(body), "blank card area plays");
  assert.ok(plays(node("span", {}, node("div", {}, body))), "meta text plays");
  assert.ok(plays(node("a", { href: "x", "data-play": "BV1" }, body)), "视频投稿 title / cover");
  assert.ok(plays(node("a", { href: "x", "data-act": "open" }, body)), "收藏夹 title");
  for (const k of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) assert.ok(!plays(body, { [k]: true }), `${k}-click on the card does not play`);
  assert.ok(!plays(body, { button: 1 }), "middle click does not play");
  const plus = node("button", { "data-pick": "1" }, body);
  assert.ok(!plays(node("kbd", {}, plus)), "「+ 标签 T」 does not play");
  assert.ok(!plays(node("span", { "data-pick": "1" }, body)), "a 视频投稿 tag chip does not play");
  assert.ok(!plays(node("span", {}, node("button", { "data-untag": "t" }, body))), "a 收藏夹 tag chip's × does not play");
  assert.ok(!plays(node("button", { "data-act": "keep" }, body)), "保留 does not play");
  assert.ok(!plays(node("textarea", { "data-note": "" }, body)), "the note box does not play");
  assert.ok(!plays(node("span", {}, node("a", { href: "space", target: "_blank" }, body))), "the UP name link does not play");
  ctx.getSelection = () => ({ isCollapsed: false });
  assert.ok(!plays(body), "the click ending a text-selection drag does not play");
  ctx.getSelection = () => ({ isCollapsed: true });
  assert.ok(plays(body), "a collapsed selection is a plain click");

  // Selecting: a click anywhere on the card picks (cover and UP links too); the video titles play, the controls keep their own.
  const picks = (target, o) => UI.cardPickClick(click(target, o));
  assert.ok(picks(body), "a card click picks, with nothing selected too");
  for (const a of [node("a", { href: "x" }, body), node("a", { href: "space", target: "_blank" }, body)]) {
    assert.ok(picks(a), "the cover and the UP links pick");
    for (const k of ["metaKey", "ctrlKey"]) assert.ok(!picks(a, { [k]: true }), `${k}-click on a link stays the browser's`);
  }
  for (const a of [node("a", { href: "x", "data-act": "open" }, body), node("a", { href: "x", "data-play": "BV1" }, body)]) {
    assert.ok(!picks(a) && plays(a), "a video title plays, it does not pick");
  }
  assert.ok(!picks(body, { button: 1 }), "middle click does not pick");
  assert.ok(picks(body, { shiftKey: true }), "Shift+click picks (a range)");
  for (const c of [node("button", { "data-act": "keep" }, body), node("button", { "data-act": "unfav" }, body), node("button", { "data-act": "note" }, body), node("button", { "data-star": "1" }, body), node("span", {}, plus), node("textarea", { "data-note": "" }, body), node("button", { "data-untag": "t" }, body)]) {
    assert.ok(!picks(c), `${c.attrs["data-act"] || Object.keys(c.attrs)[0] || c.tag} keeps its own click`);
  }
  ctx.getSelection = () => ({ isCollapsed: false });
  assert.ok(!picks(body), "the end of a text-selection drag does not pick");
  delete ctx.getSelection;

  // pickCard: a toggle, or with range every listed id between the anchor and this one; returns the new anchor.
  const ids = ["a", "b", "c", "d", "e"];
  const sel = new Set();
  let anchor = UI.pickCard(sel, ids, "b", "", false);
  assert.deepStrictEqual([...sel], ["b"]);
  anchor = UI.pickCard(sel, ids, "d", anchor, true);
  assert.deepStrictEqual([...sel].sort(), ["b", "c", "d"], "Shift picks b..d");
  anchor = UI.pickCard(sel, ids, "a", anchor, true);
  assert.deepStrictEqual([...sel].sort(), ["a", "b", "c", "d"], "a range upward from the last pick");
  UI.pickCard(sel, ids, "d", anchor, false);
  assert.ok(!sel.has("d"), "a plain pick on a selected card clears it");
  UI.pickCard(sel, ids, "e", "gone", true);
  assert.ok(sel.has("e"), "an anchor no longer listed: Shift picks just this one");
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

// 所有收藏夹: one proposal, each folder's new tags apart (same name, two entries), each within its own cap; the preview
// matches a same-name tag only in the new tag's folder.
{
  const p = { newTags: [], rows: [], notes: [], errors: [] };
  const base = { map: {}, maxNewTags: 1, scope: new Set(["v"]) };
  UI.mergeAiBatch(p, { newTags: ["科普", "多余"], assignments: { v: { add: ["科普"] } } }, { ...base, tags: [], newTagFolder: "A" });
  UI.mergeAiBatch(p, { newTags: ["科普"], assignments: { v: { add: ["科普"] } } }, { ...base, tags: [], newTagFolder: "B" });
  assert.deepStrictEqual(plain(p.newTags), [{ key: "A/科普", name: "科普", checked: true, folder: "A" }, { key: "B/科普", name: "科普", checked: true, folder: "B" }]);
  assert.deepStrictEqual(plain(p.rows), [{ id: "v", add: ["new:A/科普", "new:B/科普"], remove: [] }]);
  const tags = [{ id: "b1", name: "科普", folder: "B" }];
  assert.deepStrictEqual([UI.previewId(p, "A/科普", tags), UI.previewId(p, "B/科普", tags)], ["new:A/科普", "b1"]);
}

// Both modes take the proposal functions from here and keep no copy of their own; the review page's counts
// (changes before 应用, the tally, 用在 N 个) are tag-dialogs.js's alone, from the adapter's map / live / tagName.
for (const [file, fns] of [["triage.js", ["mergeAiBatch", "aiChanges"]], ["follow.js", ["mergeAiBatch", "aiChanges"]], ["tag-dialogs.js", ["aiChanges", "aiTally", "previewId"]]]) {
  const src = fs.readFileSync(path.join(__dirname, file), "utf8");
  for (const fn of [...fns, "aiTally", "previewId"]) assert.ok(!new RegExp(`(function|const|let) ${fn}\\b`).test(src), `${file} has its own ${fn}`);
  for (const fn of fns) assert.ok(src.includes(`UI.${fn}(`), `${file} calls the shared ${fn}`);
  if (file !== "tag-dialogs.js") assert.ok(!/UI\.(aiTally|previewId)\(|\b(changes|tally|uses): \(p/.test(src), `${file} counts the review itself`);
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
  // The player's tag lines: the name first, never 「未打标签」; empty is just 「+ 标签」, whose T shows only where T acts.
  const vl = (o) => UI.viewerLine({ label: "UP 标签", chips: "", ...o });
  assert.strictEqual(vl({ plus: { attrs: "data-p", label: "给 a 打标签" } }), `<span class="row-label">UP 标签</span>${UI.tagPlusBtn("data-p", "给 a 打标签")}`);
  assert.ok(!vl({ plus: { attrs: "data-p", label: "x", key: false } }).includes("<kbd") && vl({ pre: "<a>n</a>", chips: "<i>c</i>" }).endsWith("</span><a>n</a><i>c</i>"));
  assert.ok(![vl({}), vl({ plus: { attrs: "", label: "" } })].some((h) => h.includes("未打标签")));
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
  assert.deepStrictEqual([...UI.undoAsk("tags", 3, "UP 主")], ["撤销批量改标签？", "<p>上一步改了 3 个 UP 主的标签，撤销后都改回去。</p>", "撤销"]);
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

// The pieces both modes draw once, here: each mode calls the shared one and keeps no markup or wording of its own.
{
  const src = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
  const [fav, fw] = [src("triage.js"), src("follow.js")];
  const both = (needle, why) => [["triage.js", fav], ["follow.js", fw]].forEach(([f, s]) => assert.ok(s.includes(needle), `${f}: ${why}`));
  const neither = (re, why) => [["triage.js", fav], ["follow.js", fw]].forEach(([f, s]) => assert.ok(!re.test(s), `${f}: ${why}`));

  // U's confirm: the same words in both units.
  assert.deepStrictEqual([...UI.undoAsk("ai", 3, "UP 主")], ["撤销这次 AI 打标签？", "<p>这次 AI 打标签改过的 3 个 UP 主，标签都改回 AI 打之前，包括你之后又改过的。</p>", "撤销"]);
  assert.deepStrictEqual([...UI.undoAsk("keep", 2, "视频")], ["撤销批量保留？", "<p>上一步保留了 2 个视频，撤销后它们不再标为保留。</p>", "撤销"]);
  both("UI.undoAsk(", "asks before undoing with undoAsk");
  neither(/撤销这次 AI 打标签？|撤销批量[^ ]*？/, "writes its own undo confirm");

  // The selection bar.
  const bar = UI.selbar({ label: "选中的视频", n: 2, hidden: 1, clearAttrs: 'data-x="clear"', acts: "<b>A</b>" });
  assert.ok(bar.startsWith('<div class="selbar" role="toolbar" aria-label="选中的视频"><strong class="sel-count">已选中 2 个</strong><span class="muted">另有 1 个被筛选隐藏</span><button type="button" class="quiet" data-x="clear" aria-label="清空选中">清空选中</button>') && bar.endsWith('<span class="sel-actions"><b>A</b></span></div>'), bar);
  assert.ok(!UI.selbar({ label: "x", n: 1, hidden: 0, clearAttrs: "", acts: "" }).includes("隐藏"));
  both("UI.selbar({", "draws its selection bar with selbar");
  neither(/class="selbar"|已选中 \$\{/, "draws its own selection bar");

  // 「✦ AI 刚打的」: one chip, its × and the same tooltip (with the mode's unit); gone at 0 unless it is on.
  const chip = UI.aiRecentChip({ attrs: "data-r", xAttrs: "data-rx", n: 2, on: false, who: "UP 主" });
  assert.ok(chip.includes('class="seg ai-recent"') && chip.includes("data-r title=\"最近一次 AI 打标签改动的 UP 主，在卡片上逐个看，不对的按 T 改。") && chip.includes("AI 刚打的 2</button>") && chip.includes('class="ai-recent-x" data-rx'), chip);
  assert.ok(chip.includes(UI.aiRecentUndo("UP 主")), "the tooltip says how U undoes it");
  assert.strictEqual(UI.aiRecentChip({ attrs: "", xAttrs: "", n: 0, on: false, who: "视频" }), "");
  assert.ok(UI.aiRecentChip({ attrs: "", xAttrs: "", n: 0, on: true, who: "视频" }).includes("AI 刚打的 0"), "on at 0 stays, to switch off");
  both("UI.aiRecentChip({", "draws 「AI 刚打的」 with aiRecentChip");
  neither(/AI_RECENT_X|"AI 刚打的", UI\.filterBtn/, "builds 「AI 刚打的」 itself");

  // A sidebar entry: a 0 stays, dimmed; no count when there is none.
  const side = UI.sideItem({ attrs: 'data-s="a"', label: "<全部>", count: 0, on: true, pre: "★" });
  assert.strictEqual(side, '<button type="button" class="side-item on zero" data-s="a" aria-current="true">★<span class="side-name">&lt;全部&gt;</span><span class="side-count">0</span></button>');
  assert.ok(!UI.sideItem({ attrs: "", label: "x", count: null, on: false }).includes("side-count"));
  both("UI.sideItem({", "draws its sidebar entries with sideItem");
  neither(/class="side-item\$\{/, "draws its own sidebar entry");

  // Nothing listed: search first, then filters; neither → the mode's own text.
  assert.strictEqual(UI.noMatch(" 甲 ", true, "UP 主"), "没有匹配搜索的 UP 主");
  assert.strictEqual(UI.noMatch("", true, "视频"), "没有符合筛选的视频");
  assert.strictEqual(UI.noMatch("  ", false, "视频"), "");
  both("UI.noMatch(", "says why nothing is listed with noMatch");
  neither(/没有匹配搜索的(视频| UP 主)|没有符合筛选的(视频| UP 主)/, "words the empty list itself");

  // 刷新 in an empty state: one look in both modes, never a second solid blue.
  assert.strictEqual(UI.refreshEmpty("data-r"), `<button type="button" data-r>${UI.ICON.refresh}刷新</button>`);
  both("UI.refreshEmpty(", "draws the empty state's 刷新 with refreshEmpty");
  neither(/\$\{UI\.ICON\.refresh\}刷新/, "draws its own 刷新");
}

// 「+ 标签 T」 has one look, in triage.css, wherever it shows (视频投稿 cards, UP cards, the viewer line).
{
  const [tc, fc] = ["triage.css", "follow.css"].map((f) => fs.readFileSync(path.join(__dirname, f), "utf8"));
  assert.strictEqual((tc.match(/tag-plus \{/g) || []).length, 1, "triage.css styles 「+ 标签」 once, for every place");
  assert.ok(!/tag-plus(:hover)? \{[^}]*(border|color|height|padding)/.test(fc), "follow.css has no 「+ 标签」 style of its own");
}

// Touch has no hover: a card's secondary actions (「更多」) show on every card, in both modes, by one triage.css rule.
{
  const css = ["triage.css", "follow.css"].map((f) => fs.readFileSync(path.join(__dirname, f), "utf8")).join("\n");
  assert.ok(css.includes("@media (hover: hover) { .card:not(.focused, :focus-within) .more button:not(.on) { visibility: hidden; } }"), "only a mouse hides them");
  assert.ok(!/@media \(hover: none\) \{[^}]*\.more/.test(css), "no touch rule of a mode's own for .more");
}

// Rows 3 and 4 have 8px above and below, and both modes' lists start 8px under row 4 (DESIGN §3): the list runs under
// the header, so its top padding is the header's measured height plus 8px.
{
  const css = ["triage.css", "follow.css"].map((f) => fs.readFileSync(path.join(__dirname, f), "utf8")).join("\n");
  assert.ok(/^\.stagebar, \.tagbar \{ padding-top: 8px; padding-bottom: 8px; \}/m.test(css), "rows 3 and 4 pad 8px");
  for (const sel of ["list", "fw-list"]) assert.ok(new RegExp(`^\\.${sel} \\{[^}]*padding: calc\\(var\\(--head-h, 0px\\) \\+ 8px\\) 8px \\d+px;`, "m").test(css), `${sel} starts 8px under the header`);
}

// 收藏夹设置 and 关注设置 both live in triage.html; every row they share (AI 打标签每批数量 included) is a data-set-row that
// fillSetRows names, so the words exist once.
{
  const html = fs.readFileSync(path.join(__dirname, "triage.html"), "utf8");
  const dlg = (id) => html.slice(html.indexOf(`<dialog id="${id}"`), html.indexOf("</dialog>", html.indexOf(`<dialog id="${id}"`)));
  for (const id of ["settingsDialog", "fwSettingsDialog"]) {
    for (const row of Object.keys({ interval: 1, newTagMax: 1, allowRemove: 1, aiBatch: 1 })) assert.ok(dlg(id).includes(`data-set-row="${row}"`), `${id} has the shared ${row} row`);
  }
  for (const f of ["triage.html", "triage.js", "follow.js"]) assert.ok(!fs.readFileSync(path.join(__dirname, f), "utf8").includes("AI 打标签每批数量"), `${f} names the batch row itself`);
  assert.ok(!/<dialog/.test(fs.readFileSync(path.join(__dirname, "follow.js"), "utf8")), "follow.js builds no dialog markup");
  const root = { querySelectorAll: () => [row] };
  const row = { dataset: { setRow: "aiBatch" }, querySelector: () => ({ id: "x" }), insertAdjacentHTML(_, h) { this.html = h; } };
  UI.fillSetRows(root);
  assert.ok(row.html.includes(">AI 打标签每批数量</label>") && row.html.includes("1–100 个一批。"), row.html);
}

// A number field out of range snaps back into it; empty stays empty; data-zero-ok keeps 0 below min.
{
  const num = (value, min, max, zeroOk) => {
    const input = { type: "number", value, min, max, dataset: zeroOk ? { zeroOk: "" } : {} };
    UI.clampNumber(input);
    return String(input.value);
  };
  assert.deepStrictEqual(["60", "0", "-3", "7.6", ""].map((v) => num(v, "1", "50")), ["50", "1", "1", "8", ""]);
  assert.strictEqual(num("9999", "0", ""), "9999", "no max");
  assert.deepStrictEqual(["0", "-5", "50", "40000"].map((v) => num(v, "200", "32000", true)), ["0", "0", "200", "32000"]);
}

// Rows 3 and 4 start with their name, 「状态」 and 「标签」, in 收藏夹 and in both 关注 tabs (UP 主, 视频投稿).
{
  assert.strictEqual(UI.labeledRow("状态", "<b>x</b>"), '<span class="row-label">状态</span><b>x</b>');
  const count = (f, re) => (fs.readFileSync(path.join(__dirname, f), "utf8").match(re) || []).length;
  assert.strictEqual(count("triage.js", /UI\.labeledRow\("状态", /g), 1, "收藏夹 row 3");
  assert.strictEqual(count("triage.js", /UI\.labeledRow\("标签", /g), 1, "收藏夹 row 4");
  assert.strictEqual(count("follow.js", /UI\.labeledRow\("状态", /g), 2, "关注 row 3, UP 主 and 视频投稿");
  assert.strictEqual(count("follow.js", /UI\.labeledRow\("标签", /g), 2, "关注 row 4, UP 主 and 视频投稿");
  for (const f of ["triage.js", "follow.js"]) assert.strictEqual(count(f, /row-label/g), 0, `${f} draws no label of its own`);
}

// 移动 / 复制 (askTransfer): one dialog for 收藏夹's folders and 关注's groups; the mode passes its targets and words.
(async () => {
  const nodes = {};
  const node = (id, extra = {}) => (nodes[id] = { id, hidden: false, value: "", textContent: "", innerHTML: "", attrs: {}, L: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { (this.L[t] ||= []).push(f); }, ...extra });
  const btn = (value) => ({ value, hidden: false, textContent: "", attrs: {}, cls: new Set(), classList: { toggle(c, on) { on ? this.o.cls.add(c) : this.o.cls.delete(c); } }, setAttribute(k, v) { this.attrs[k] = v; } });
  const buttons = ["copy", "move", "add"].map(btn);
  for (const b of buttons) b.classList.o = b;
  node("transferDialog", { returnValue: "", open: false, showModal() { this.open = true; }, querySelectorAll: () => buttons });
  for (const id of ["transferTitle", "transferBody", "transferLabel", "transferHow", "transferTarget", "transferNewRow", "transferUnchosen", "transferName", "transferPrivate", "transferPrivateRow"]) node(id);
  ctx.document = { getElementById: (id) => nodes[id] };
  const close = (how, value, name = "") => {
    nodes.transferTarget.value = value;
    nodes.transferName.value = name;
    nodes.transferDialog.returnValue = how;
    nodes.transferDialog.L.close.at(-1)();
  };
  const group = {
    title: "在 B站把这 2 个 UP 主复制到分组", n: 2, hows: ["copy"], list: "<ul></ul>", label: "目标分组",
    options: [["-10", "特别关注 (3)"], ["7", "<数码> (2)"]], newText: "新建分组…", newPlaceholder: "新分组名称", newMax: 16, how: "原来的分组里也留着。",
    note: (v) => (v === "-10" ? "会推送" : "")
  };
  let p = UI.askTransfer(group);
  assert.ok(nodes.transferDialog.open && nodes.transferLabel.textContent === "目标分组" && nodes.transferName.maxLength === 16);
  assert.deepStrictEqual(buttons.map((b) => [b.value, b.hidden, b.textContent, b.cls.has("primary")]), [["copy", false, "复制 2 个", true], ["move", true, "移动 2 个", false], ["add", true, "收藏 2 个", false]], "only the mode's button, blue, with the count");
  assert.ok(nodes.transferTarget.innerHTML.includes("&lt;数码&gt;") && nodes.transferTarget.innerHTML.endsWith('<option value="new">新建分组…</option>'));
  assert.ok(nodes.transferPrivateRow.hidden, "设为私密 is 收藏夹's");
  nodes.transferTarget.value = "-10";
  nodes.transferTarget.L.change[0]();
  assert.deepStrictEqual([nodes.transferUnchosen.hidden, nodes.transferUnchosen.innerHTML, nodes.transferNewRow.hidden], [false, "会推送", true]);
  nodes.transferTarget.value = "new";
  nodes.transferTarget.L.change[0]();
  assert.ok(!nodes.transferNewRow.hidden && nodes.transferName.required && nodes.transferUnchosen.hidden);
  close("copy", "new", "  周末看 ");
  assert.deepStrictEqual(plain(await p), { how: "copy", target: { create: "周末看", privacy: false } });
  p = UI.askTransfer(group);
  close("move", "7");
  assert.strictEqual(await p, null, "a button the mode did not show is a cancel");
  p = UI.askTransfer({ ...group, hows: ["copy", "move"], privacy: true, how: "" });
  assert.ok(buttons[1].cls.has("primary") && !buttons[0].cls.has("primary") && !nodes.transferPrivateRow.hidden && nodes.transferHow.hidden, "收藏夹: 复制 and 移动, 移动 blue");
  nodes.transferPrivate.checked = true;
  close("move", "7");
  assert.deepStrictEqual(plain(await p), { how: "move", target: { id: "7" } });
  assert.strictEqual(nodes.transferTarget.L.change.length, 1, "bound once");
  console.log("shared selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
