// node extension/triage/shared.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const PS = require("../page-sources.selftest.js");

const ctx = vm.createContext({ setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../common.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../limits.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../errors.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../typing.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../tag-core.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../settings.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "shared.js"), "utf8"), ctx);
const UI = ctx.TriageUi;
// 关注 waits B站限流 out for 90 s (DESIGN), in one place: follow-bg.js's queue and follow.js's write and feed waits read it.
assert.strictEqual(UI.BILI_HOLD_MS, 90000);
for (const [f, src] of [["关注", PS.text(PS.follow)], ["follow-bg.js", PS.read("triage/follow-bg.js")]]) assert.ok(/\.BILI_HOLD_MS/.test(src) && !/WAIT_SEC = 90|backoffMs: 90000/.test(src), f);
// L5: 关注's group name, one limit and one wording (最多) for the page and the background.
assert.deepStrictEqual(["", "a".repeat(UI.GROUP_NAME_MAX), "a".repeat(UI.GROUP_NAME_MAX + 1)].map(UI.groupNameError), ["分组名不能为空", "", `分组名最多 ${UI.GROUP_NAME_MAX} 个字`]);
for (const f of [...PS.follow, "triage/follow-bg.js"]) assert.ok(!/分组名不能为空|分组名最[多长]|NAME_MAX = 16/.test(PS.read(f)), `${f} checks a group name itself`);
const TAG = ctx.MdgTagCore;
const plain = (v) => JSON.parse(JSON.stringify(v));
// Untrusted text (titles, UP names, comments, AI replies, tag names, paths) stays text: no tag of its own, no way out of
// a quoted attribute.
const XSS = ["<img src=x onerror=alert(1)>", `"'><script>alert(1)</script>`];
const assertInert = (html, where) => assert.ok(!/<img src=x|<script|"'>/i.test(html) && /&lt;|&#60;/.test(html), `${where}: ${html}`);

// T3: a whole-list redraw keeps the first card in view at its place, not the pixel offset: a card added above (a 刷新
// put a new favorite first) or gone leaves the cards under the eye where they were. At the top it stays at the top.
{
  const list = { scrollTop: 250, keys: [], getBoundingClientRect: () => ({ top: 0, bottom: 300 }) };
  list.querySelectorAll = () => list.keys.map((k, i) => ({ dataset: { bvid: k }, getBoundingClientRect: () => ({ top: i * 100 - list.scrollTop, bottom: i * 100 + 100 - list.scrollTop }) }));
  const redraw = (before, after, top) => {
    list.keys = before;
    list.scrollTop = top;
    const restore = UI.keepScroll(list, ".card");
    list.keys = after;
    list.scrollTop = 0; // innerHTML may reset it
    restore();
    return list.scrollTop;
  };
  const keys = ["a", "b", "c", "d", "e"];
  assert.strictEqual(redraw(keys, ["new", ...keys], 250), 350, "c, half under the top edge, stays half under it");
  assert.strictEqual(redraw(keys, ["a", "c", "d", "e"], 250), 150, "b gone above: c stays put");
  assert.strictEqual(redraw(keys, ["a", "b", "d", "e"], 250), 150, "c itself gone: d, the next one in view, stays put");
  assert.strictEqual(redraw(keys, ["x", "y", "z"], 250), 250, "none left: the old offset");
  assert.strictEqual(redraw(keys, ["new", ...keys], 0), 0, "at the top: stays at the top, the new card shows");
}

// The header fold on a fake page: only its toggle folds and unfolds (no scroll or focus listener), each mode keeps its
// own state in storage and gets it back on a reload; rows that grow while folded are measured again on unfolding.
{
  const on = (o) => ((o.L = {}), (o.addEventListener = (t, f) => (o.L[t] ||= []).push(f)), o);
  const made = [];
  const body = new Set();
  let stored = {};
  let measureAll;
  Object.assign(ctx, {
    ResizeObserver: class { constructor(f) { measureAll = f; } observe() {} },
    MutationObserver: class { observe() {} },
    document: { body: { classList: { contains: (c) => body.has(c) } }, createElement: () => (made.push(on({})), made.at(-1)) },
    chrome: { storage: { local: {
      get: () => ({ then: (f) => f(JSON.parse(JSON.stringify(stored))) }),
      set: (o) => ((stored = { ...stored, ...JSON.parse(JSON.stringify(o)) }), { catch() {} })
    } } }
  });
  const page = () => {
    let y = 0;
    const rows = ["folder-head", "tabrow", "stagebar", "tagbar"].map((c) => {
      const r = { offsetTop: y, offsetHeight: 50, offsetParent: {}, classList: { contains: (x) => x === c }, querySelector: () => null, prepend() {} };
      y += 50;
      return r;
    });
    rows[0].nextElementSibling = rows[1];
    const vars = {};
    const cls = new Set();
    const foldLog = []; // [folded, head-instant] at each fold change
    const main = on({
      classList: { toggle: (c, b) => (c === "head-folded" && b !== cls.has(c) && foldLog.push([b, cls.has("head-instant")]), b ? cls.add(c) : cls.delete(c)) },
      style: { setProperty: (k, v) => (vars[k] = v) },
      querySelectorAll: () => rows
    });
    made.length = 0;
    const sync = UI.headFold(main);
    const toggle = made.find((b) => b.className === "act-btn head-toggle");
    const scroll = (top) => main.L.scroll[0]({ target: { scrollTop: top, matches: (sel) => sel === ".list, .fw-list" } });
    return { rows, vars, sync, foldLog, instant: () => cls.has("head-instant"), folded: () => cls.has("head-folded"), shadow: () => cls.has("head-scrolled"), scroll, toggle, click: () => toggle.L.click[0]() };
  };
  const p = page();
  assert.deepStrictEqual([p.folded(), p.toggle.ariaLabel, p.toggle.title, p.vars["--head-h"]], [false, "收起头部", "收起头部", "200px"]);
  assert.ok(!p.toggle.L.click[1], "one click handler");
  p.click();
  assert.deepStrictEqual([p.folded(), p.toggle.ariaLabel, plain(stored.triage_head_folded)], [true, "展开头部", { fav: true }], "the toggle folds and remembers it for 收藏夹");
  p.rows[3].offsetHeight = 90; // the tag row wraps to two lines while folded
  measureAll();
  assert.deepStrictEqual([p.folded(), p.vars["--head-h"]], [true, "200px"], "folded: the full height is kept, and a re-measure does not unfold");
  p.click();
  assert.deepStrictEqual([p.folded(), p.vars["--head-h"], p.toggle.ariaLabel], [false, "240px", "收起头部"], "unfolding measures the rows again");
  p.click();
  body.add("follow-mode");
  measureAll();
  assert.ok(!p.folded(), "关注 has its own state: unfolded");
  p.click();
  assert.deepStrictEqual(plain(stored.triage_head_folded), { fav: true, follow: true });
  body.delete("follow-mode");
  stored.triage_head_folded = { fav: false, follow: true };
  const q = page();
  assert.ok(!q.folded(), "a reload in 收藏夹 gets 收藏夹's state back");
  body.add("follow-mode");
  measureAll();
  assert.ok(q.folded(), "and 关注's");
  body.delete("follow-mode");
  // K1: a mode switch (setMode calls sync right after toggling body.follow-mode) applies the new mode's fold at once,
  // with head-instant on while it changes and off afterwards; no ResizeObserver round needed.
  q.foldLog.length = 0;
  q.sync();
  body.add("follow-mode");
  q.sync();
  assert.deepStrictEqual([q.folded(), q.instant(), plain(q.foldLog)], [true, false, [[false, true], [true, true]]], "switching modes folds or unfolds at once, without animation");
  q.rows[3].offsetHeight = 90;
  q.sync();
  assert.deepStrictEqual([q.folded(), q.vars["--head-h"]], [true, "240px"], "sync after drawing the mode measures its rows again, folded");
  q.rows[3].offsetHeight = 50;
  body.delete("follow-mode");
  q.sync();
  // Scrolling the list only shows the shadow under the header; it never folds or unfolds.
  measureAll();
  q.scroll(300);
  assert.deepStrictEqual([q.shadow(), q.folded()], [true, false], "scrolled: shadow, still unfolded");
  q.click();
  q.scroll(0);
  assert.deepStrictEqual([q.shadow(), q.folded()], [false, true], "back at the top: no shadow, still folded");
  // Nothing else folds or unfolds it: no focus listener, and no other file touches the class.
  const src = fs.readFileSync(path.join(__dirname, "shared.js"), "utf8");
  assert.ok(!/"focusin"|headroom/i.test(src), "shared.js does not unfold on focus");
  for (const f of PS.triage) assert.ok(!PS.read(f).includes("head-folded"), `${f} sets the fold itself`);
  // K4: at ≤1099 the rule under row 2's first line runs the row's full width, under the fold toggle too, not from the tabs.
  const narrow = fs.readFileSync(path.join(__dirname, "triage.css"), "utf8").split("@media (max-width: 1099px)")[1].split("\n}\n")[0];
  assert.ok(/\.tabrow::after \{[^}]*left: 0; right: 0;[^}]*background: var\(--border\)/.test(narrow) && !/\.tabs \{[^}]*border-bottom: 1px solid var\(--border\)/.test(narrow), "row 2's rule spans the toggle and the tabs");
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
  assert.ok(!UI.sortControl({ sorts: { a: "甲" }, sort: "a", selectAttr: "data-s" }).includes("<button"), "no dirAttr, no button");
  const re = UI.sortControl({ sorts: { a: "甲" }, sort: "a", selectAttr: "data-s", btn: { attrs: "data-r", label: "再随机一次", icon: "↻" } });
  assert.ok(re.includes('data-r title="再随机一次" aria-label="再随机一次">↻</button>') && !re.includes("排序方向"), "btn takes the direction button's place");
}

// Counts and durations read the same in both modes: one decimal for 万 and 亿, hours from 60 minutes up.
assert.deepStrictEqual([123456, 100000, 9999, 250000000, 150000].map(UI.fmtCount), ["12.3万", "10万", "9999", "2.5亿", "15万"]);
assert.deepStrictEqual([0, 65, 587, 75 * 60, 3600, 3605, 59.9].map(UI.fmtDuration), ["0:00", "1:05", "9:47", "1:15:00", "1:00:00", "1:00:05", "0:59"]);
assert.strictEqual(UI.fmtDate(0), "");
assert.strictEqual(UI.fmtDate(new Date(2026, 0, 5, 12).getTime() / 1000), "2026-01-05");
{
  const now = 1_800_000_000;
  const ago = (d) => now - d * 86400;
  assert.strictEqual(UI.fmtAgo(now - 100, now), "今天");
  assert.strictEqual(UI.fmtAgo(ago(3), now), "3 天前");
  assert.strictEqual(UI.fmtAgo(ago(65), now), "2 个月前");
  assert.strictEqual(UI.fmtAgo(ago(800), now), "2 年前");
  assert.strictEqual(UI.fmtAgo(ago(362), now), "1 年前", "360–364 days are 1 年前, not 12 个月前");
  // Calendar days, as dayText: yesterday 23:00 seen at 01:00 is 1 天前, not 今天.
  const at = (d, h) => new Date(2026, 9, d, h).getTime() / 1000;
  assert.strictEqual(UI.fmtAgo(at(14, 23), at(15, 1)), "1 天前");
  assert.strictEqual(UI.fmtAgo(at(15, 0), at(15, 23)), "今天");
}
assert.strictEqual(UI.https("//i0.hdslb.com/a.jpg"), "https://i0.hdslb.com/a.jpg");
assert.strictEqual(UI.https("http://i0.hdslb.com/a.jpg"), "https://i0.hdslb.com/a.jpg");
// An UP's recent titles: both sources, newest first, one per title, at most UP_RECENT; a failed content record adds none.
assert.deepStrictEqual(
  [...UI.upTitles([{ t: "a", c: 5 }, { t: "b", c: 3 }], { code: 0, v: [{ t: "a", c: 5 }, { t: "c", c: 4 }, { t: "d", c: 1 }] }).map((x) => x.t)],
  ["a", "c", "b"]
);
assert.strictEqual(UI.upTitles(undefined, { code: -404, v: [{ t: "x", c: 1 }] }).length, 0);
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

// A card's tag chip escapes its name and says what undoes it, one sentence for both modes (both have U).
assert.ok(UI.cardTagChip({ id: "t1", name: "<b>", color: "#fff" }).includes('data-untag="t1" aria-label="去掉标签 &lt;b&gt;" title="点一下去掉这个标签 · U 撤销">&lt;b&gt;<span class="x"'));
for (const [f, src] of [["收藏夹", PS.text(PS.favorites)], ["关注", PS.text(PS.follow)]]) {
  assert.ok(src.includes("UI.cardTagChip(t)") && !src.includes("点一下去掉这个标签"), `${f}: the shared tag chip and its tooltip`);
  // The card's tag button and the done toast: the shared 「+ 标签 T」 and one sentence.
  assert.ok(!/>标签<kbd/.test(src) && src.includes("UI.AI_TAGS_DONE") && !src.includes("按 I 查看建议"), `${f}: 「+ 标签 T」 and AI_TAGS_DONE`);
  // H8: the instruction history and the AI 打标签 toasts come from shared.js.
  assert.ok(src.includes("UI.aiHistoryAdd(") && !src.includes(".slice(0, 5)") && !/AI 打标签没有成功|已应用 AI 建议/.test(src), `${f}: shared AI history and toasts`);
}
assert.strictEqual(UI.aiHistoryAdd(["a", "b", "c", "d", "e"], "c").join(), "c,a,b,d,e");
assert.strictEqual(UI.aiHistoryAdd(["a", "b", "c", "d", "e"], "f").join(), "f,a,b,c,d");
assert.strictEqual(UI.aiApplied(3, "UP 主"), "已应用 AI 建议：3 个 UP 主，列表只显示这些 · U 撤销");
assert.strictEqual(UI.aiApplied(2, "视频"), "已应用 AI 建议：2 个视频，列表只显示这些 · U 撤销");
// C652: nothing changed shows no list and no 「列表只显示这些」 (both modes).
assert.strictEqual(UI.aiApplied(0, "视频", 2), "已新建 2 个标签，没有视频的标签要改 · U 撤销");
assert.strictEqual(UI.aiApplied(0, "视频"), "AI 建议里没有要改的标签");
assert.strictEqual(UI.aiTagsFailed("x"), "AI 打标签没有成功：x");

// AI 打标签's proposal, as both modes use it: merge, cap, excluded, changes, tally. Rows are UPs here, videos in 收藏夹.
{
  const tags = [{ id: "t1", name: "科普" }, { id: "t2", name: "游戏" }];
  const map = { a: ["t1"], b: ["t2"] };
  const opts = { tags, map, maxNewTags: 1, excluded: new Set(["游戏"]), scope: new Set(["a", "b", "c"]) };
  const p = { newTags: [], rows: [], notes: [], errors: [] };
  UI.mergeAiBatch(p, { newTags: ["美食", "旅行"], assignments: { a: { add: ["科普", "美食"], remove: [] }, b: { add: ["旅行"], remove: ["游戏"] }, c: { add: ["游戏", "科普"] }, z: { add: ["科普"] } }, note: "n1" }, opts);
  UI.mergeAiBatch(p, { assignments: { c: { add: ["美食"], remove: ["科普"] } } }, opts);
  assert.deepStrictEqual(plain(p.newTags).map((x) => x.name), ["美食", "旅行"], "new tags past maxNewTags are kept");
  assert.deepStrictEqual(plain(p.caps), { "": 1 }, "the cap the review page compares against");
  assert.deepStrictEqual(plain(p.excludedHits), ["游戏"], "an add naming a turned-off tag is dropped and listed; a remove of it is not listed");
  assert.deepStrictEqual(plain(p.rows), [
    { id: "a", add: ["new:美食"], remove: [] },
    { id: "b", add: ["new:旅行"], remove: [] },
    { id: "c", add: ["id:t1", "new:美食"], remove: [] }
  ], "existing tag on a → nothing; excluded 游戏 never added or removed; out-of-scope z dropped; batches merge per UP");
  assert.deepStrictEqual(p.notes, ["n1"]);
  const follow = new Set(["a", "b"]); // c was unfollowed while the proposal was open
  const ch = plain(UI.aiChanges(p, map, follow, (key) => `new-${key}`));
  assert.deepStrictEqual(ch, [["a", ["t1"], ["t1", "new-美食"]], ["b", ["t2"], ["t2", "new-旅行"]]], "an unfollowed UP gets nothing");
  p.newTags[0].checked = false;
  assert.deepStrictEqual(plain(UI.aiChanges(p, map, follow, (key) => `new-${key}`)).map((c) => c[0]), ["b"], "an unchecked new tag adds nothing");
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
  assert.deepStrictEqual(plain(p.newTags), [{ key: "A/科普", name: "科普", checked: true, folder: "A" }, { key: "A/多余", name: "多余", checked: true, folder: "A" }, { key: "B/科普", name: "科普", checked: true, folder: "B" }]);
  assert.deepStrictEqual(plain(p.caps), { A: 1, B: 1 });
  assert.deepStrictEqual(plain(p.rows), [{ id: "v", add: ["new:A/科普", "new:B/科普"], remove: [] }]);
  const tags = [{ id: "b1", name: "科普", folder: "B" }];
  assert.deepStrictEqual([UI.previewId(p, "A/科普", tags), UI.previewId(p, "B/科普", tags)], ["new:A/科普", "b1"]);
}

// Both modes take the proposal functions from here and keep no copy of their own; the review page's counts
// (changes before 应用, the tally, 用在 N 个) are tag-dialogs.js's alone, from the adapter's map / live / tagName.
for (const [file, fns, src] of [["收藏夹", ["mergeAiBatch", "aiChanges"], PS.text(PS.favorites)], ["关注", ["mergeAiBatch", "aiChanges"], PS.text(PS.follow)], ["tag-dialogs.js", ["aiChanges", "aiTally", "previewId"], PS.read("triage/tag-dialogs.js")]]) {
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
  const C = TAG.TAG_COLORS;
  assert.strictEqual(UI.nextTagColor([]), C[0]);
  assert.strictEqual(UI.nextTagColor([{ color: C[0] }, { color: C[2] }]), C[1], "a deleted tag's color is reused, not a taken one");
  assert.strictEqual(UI.nextTagColor(C.map((color) => ({ color }))), C[0], "all taken: round again");
  assert.strictEqual(TAG.cycleTagColor(C[0]), C[1]);
  assert.strictEqual(TAG.cycleTagColor(C.at(-1)), C[0]);
  assert.strictEqual(TAG.cycleTagColor("#000"), C[0], "a color from elsewhere starts the palette");
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
  // The picker's title names which tags: a lone name does not say whether it is a video or an UP 主.
  assert.deepStrictEqual([UI.pickTitle(1, "甲", "视频"), UI.pickTitle(1, "乙", "UP 主"), UI.pickTitle(3, "", "UP 主")], ["给「甲」打视频标签", "给「乙」打 UP 标签", "给选中的 3 个 UP 主打标签"]);
  assert.deepStrictEqual([UI.tagsWord("视频"), UI.tagsWord("UP 主")], ["视频标签", " UP 标签"], "one name for each unit's tags (the picker and the tag dialogs)");
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
  const t0 = { id: "a", name: "甲", color: TAG.TAG_COLORS[0], rule: "旧说明" };
  assert.deepStrictEqual(plain(UI.editedTag(t0, "rule", "  ").tag), { id: "a", name: "甲", color: TAG.TAG_COLORS[0] });
  assert.strictEqual(UI.editedTag(t0, "rule", ` ${"讲".repeat(90)} `).tag.rule.length, 80);
  assert.strictEqual(UI.editedTag(t0, "name", " 乙, ", []).tag.name, "乙");
  assert.deepStrictEqual(plain(UI.editedTag(t0, "name", "乙", [{ name: "乙" }])), { why: "已有同名标签" });
  assert.strictEqual(UI.editedTag(t0, "color").tag.color, TAG.TAG_COLORS[1]);
  assert.strictEqual(t0.rule, "旧说明", "the tag itself is not changed");
  assert.deepStrictEqual([...UI.undoAsk("tags", 3, "UP 主")], ["撤销批量改标签？", "<p>上一步改了 3 个 UP 主的标签，撤销后都改回去。</p>", "撤销"]);
  assert.deepStrictEqual(plain(UI.withoutTag({ x: ["a", "b"], y: ["a"] }, "a")), { x: ["b"] });
  // follow.js's page part is not in a harness; it must go through the same functions.
  const follow = PS.text(PS.follow);
  assert.ok(follow.includes("UI.editedTag(") && follow.includes("UI.withoutTag("), "关注 edits and deletes tags with the shared functions");
}

// 全选: none / some / all of what is listed → unchecked / mixed / checked. Nothing listed: 「全选」 with no number, disabled
// with a reason. A click deselects only when every listed one is selected, and never touches what is not listed.
{
  assert.deepStrictEqual([UI.selectAllState(3, 0), UI.selectAllState(3, 1), UI.selectAllState(3, 3), UI.selectAllState(0, 0)], ["false", "mixed", "true", "false"]);
  const box = UI.selectAllBox('data-x="all"', 3, 1);
  assert.ok(box.includes('role="checkbox"') && box.includes('aria-checked="mixed"') && box.includes("全选 3 个") && !box.includes("disabled"), box);
  const none = UI.selectAllBox('data-x="all"', 0, 0, "这里没有列出 UP 主");
  assert.ok(none.includes(">全选</button>") && none.includes('disabled title="这里没有列出 UP 主" aria-description="这里没有列出 UP 主"'), none);
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
  // No tags yet: named by the unit, as the 标签管理 dialog's empty list (C489).
  assert.ok(UI.tagButtons({ manageAttrs: "data-m", aiAttrs: "data-a", noTags: true, who: "视频" }).includes('aria-label="标签管理（还没有视频标签）">标签管理<i class="dot-warn"'));
  assert.ok(UI.tagButtons({ manageAttrs: "data-m", aiAttrs: "data-a", noTags: true, who: UI.upWho }).includes('aria-label="标签管理（还没有 UP 标签）"'));
  const off = UI.tagButtons({ manageAttrs: "data-m", aiAttrs: "data-a", noTags: true, manageReason: "先打开", aiReason: "先打开" });
  assert.ok(!off.includes("dot-warn") && (off.match(/disabled title="先打开"/g) || []).length === 2, off);
  // K9: the run's state is drawn here from running / pending, never counting a selection.
  const ai = (o) => UI.tagButtons({ manageAttrs: "data-m", aiAttrs: "data-a", picked: 2, ...o }).match(/<\/span>(AI 打标签[^<]*)<\/button>/)[1];
  assert.deepStrictEqual([ai({}), ai({ running: true }), ai({ pending: true }), ai({ running: true, pending: true })], ["AI 打标签选中的 2 个", "AI 打标签 · 运行中", "AI 打标签 · 待确认", "AI 打标签 · 运行中"]);
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
  for (const [f, src] of [["收藏夹", PS.text(PS.favorites)], ["关注", PS.text(PS.follow)]]) assert.ok(src.includes("UI.bindSearch("), `${f} binds its search with bindSearch`);
}

// The pieces both modes draw once, here: each mode calls the shared one and keeps no markup or wording of its own.
{
  const src = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
  const modes = [["收藏夹", PS.text(PS.favorites)], ["关注", PS.text(PS.follow)]];
  const both = (needle, why) => modes.forEach(([f, s]) => assert.ok(s.includes(needle), `${f}: ${why}`));
  const neither = (re, why) => modes.forEach(([f, s]) => assert.ok(!re.test(s), `${f}: ${why}`));

  // U's confirm: the same words in both units.
  assert.deepStrictEqual([...UI.undoAsk("ai", 3, "UP 主")], ["撤销这次 AI 打标签？", "<p>这次 AI 打标签改过的 3 个 UP 主，标签都改回 AI 打之前，包括你之后又改过的。</p>", "撤销"]);
  assert.deepStrictEqual([...UI.undoAsk("keep", 2, "视频")], ["撤销批量保留？", "<p>上一步保留了 2 个视频，撤销后它们不再标为保留。</p>", "撤销"]);
  both("UI.undoAsk(", "asks before undoing with undoAsk");
  neither(/撤销这次 AI 打标签？|撤销批量[^ ]*？/, "writes its own undo confirm");

  // The selection bar.
  const bar = UI.selbar({ label: "选中的视频", n: 2, hidden: 1, clearAttrs: 'data-x="clear"', acts: (none) => `<b>A${none}</b>` });
  assert.ok(bar.startsWith('<div class="selbar" role="toolbar" aria-label="选中的视频"><strong class="sel-count">已选中 2 个</strong><span class="muted">另有 1 个被筛选隐藏</span><button type="button" class="quiet" data-x="clear" aria-label="清空选中">清空选中</button>') && bar.endsWith('<span class="sel-actions"><b>A</b></span></div>'), bar);
  assert.ok(!UI.selbar({ label: "x", n: 1, hidden: 0, clearAttrs: "", acts: () => "" }).includes("隐藏"));
  // Filters hide the whole selection: the bar keeps its buttons and tells each why it is off, the same in both modes.
  assert.ok(UI.selbar({ label: "x", n: 0, hidden: 2, clearAttrs: "", acts: (none) => UI.actBtn('data-x="a"', "保留选中的 2 个", { reason: none }) }).includes('aria-label="保留选中的 2 个" disabled title="选中的都被筛选隐藏了"'));
  assert.ok(UI.selbar({ label: "x", n: 0, hidden: 2, clearAttrs: "", acts: () => "" }).includes('已选中 2 个</strong><span class="muted">都被筛选隐藏</span>'), "the title counts the whole hidden selection, as the buttons");
  both("UI.selbar({", "draws its selection bar with selbar");
  neither(/class="selbar"|已选中 \$\{|选中的都被筛选隐藏了/, "draws its own selection bar or its hidden-all reason");
  // One button builder for row 3 and the bar; one 清理 button.
  assert.strictEqual(UI.actBtn('data-x="m"', "移动", { cls: "danger", title: "t", pre: "✦" }), '<button type="button" class="danger" data-x="m" aria-label="移动" title="t">✦移动</button>');
  assert.strictEqual(UI.cleanBtn('data-x="c"', { picked: 3, shown: 3, n: 3 }), '<button type="button" class="danger" data-x="c" aria-label="清理选中的 3 个">清理选中的 3 个</button>');
  assert.ok(UI.cleanBtn('data-x="c"', { picked: 0, shown: 0, n: 5, busy: "忙" }).includes('aria-label="清理这 5 个" disabled title="忙"'));
  // A selection filters hide whole: still 「清理选中的 N 个」 with the true count, off with why, never 「清理这 N 个」.
  assert.ok(UI.cleanBtn('data-x="c"', { picked: 2, shown: 0, n: 2, why: "空" }).includes('aria-label="清理选中的 2 个" disabled title="选中的都被筛选隐藏了"'));
  both("UI.cleanBtn(", "draws 清理 with cleanBtn");
  // K9: one copy of these words and numbers, in shared.js.
  neither(/"B站限流卡住"|标签建议待确认| · 运行中| · 待确认|slowDays = 90|deadDays = 365/, "a copy of shared.js's words or defaults");
  for (const f of ["shared.js", "triage-bg.js"]) assert.ok(!/maxlength="80"|slice\(0, 80\)/.test(src(f)), `${f}: the 说明's cap is TAG_RULE_MAX`);
  // K5: before 清理 both modes name one way to keep a copy, from shared.js.
  both("${UI.CLEAN_BACKUP.ask}", "the 清理 confirm's backup line");
  both("${UI.CLEAN_BACKUP.meta}", "已出分拣范围's backup hint");
  neither(/「导出」菜单(导出|备份)/, "no backup wording of its own");
  neither(/清理选中的 \$\{|清理这 \$\{[^}]*\} 个`|<button type="button"\$\{cls/, "builds its own 清理 or action button");
  // J10: row 4's tag chip, 已出分拣范围's tabs and its 「原在…」 chip are drawn once; a batch confirm lists with confirmList.
  assert.strictEqual(UI.tagFilterChip('data-x="t"', { name: "科普", color: "#111", n: 2, on: true, what: "UP 主" }), '<button type="button" class="chip on" style="--c:#111" data-x="t" aria-pressed="true" aria-label="按标签筛选 科普 2" title="可多选：只显示同时带有所选标签的 UP 主">科普<span class="chip-n">2</span></button>');
  assert.strictEqual(UI.kindTabs("data-k", [["", "全部", 3], ["gone", "已取消关注", 0]], ""), '<button type="button" role="tab" class="step" data-k="" aria-selected="true" aria-label="全部 3">全部<span class="count">3</span></button><button type="button" role="tab" class="step zero" data-k="gone" aria-selected="false" aria-label="已取消关注 0">已取消关注<span class="count">0</span></button>');
  assert.strictEqual(UI.originChip("原在", ["A", "B", "C"]), '<span class="origin-chip" title="原在「A」「B」「C」">原在「A」「B」等 3 个</span>');
  assert.strictEqual(UI.originChip("在", []), "");
  for (const [needle, re, what] of [["UI.tagFilterChip(", /class="chip\$\{on/, "row 4's tag chip"], ["UI.kindTabs(", /role="tab" class="\$\{n \?/, "已出分拣范围's tabs"], ["UI.originChip(", /class="origin-chip"/, "the 「原在…」 chip"]]) {
    both(needle, `draws ${what} with the shared one`);
    neither(re, `draws its own ${what}`);
  }
  neither(/\.slice\(0, 10\)/, "lists a batch confirm by hand instead of UI.confirmList");
  // What waits for a running step: one sentence, U's version asks to wait before undoing.
  assert.deepStrictEqual([UI.busyText("取消关注"), UI.busyText("取消关注", { undo: true }), UI.busyText("")], ["取消关注还在跑，等它完成", "取消关注还在跑，等它完成再撤销", ""]);
  neither(/还在跑/, "writes its own 「…还在跑」");
  // Whole-number settings: empty or not a number is the default, 0 is a value, rounded, clamped.
  assert.deepStrictEqual(["", null, undefined, "x", " ", 0, "0", 7.5, 7.4, -3, 2000, "12"].map((v) => UI.intIn(v, 0, 1000, 8)), [8, 8, 8, 8, 8, 0, 0, 8, 7, 8, 1000, 12]);
  assert.strictEqual(UI.intIn(0, 1, 50, 10), 10, "below the minimum is the default");
  // K12: the rule is written once, in settings.js; TriageUi.intIn and normalizeSeenThreshold are it.
  assert.strictEqual(UI.intIn, ctx.MdgSettings.intIn, "TriageUi.intIn is MdgSettings.intIn");
  const ruleCopies = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "dev" ? [] : ruleCopies(path.join(dir, e.name))) : e.name.endsWith(".js") && !e.name.endsWith(".selftest.js") && /Math\.round\(Number\(v\)\)/.test(fs.readFileSync(path.join(dir, e.name), "utf8")) ? [e.name] : []));
  assert.deepStrictEqual(ruleCopies(path.join(__dirname, "..")), ["settings.js"], "the whole-number rule is written only in settings.js");
  for (const [f, src] of [...modes, ...["triage/triage-bg.js", "triage/follow-bg.js", "background.js"].map((f) => [f, PS.read(f)])]) {
    const bare = /intSetting|intervalSetting|Math\.floor\(Number\(|Number\((el\.\w+|\$\("\w+"\))\.value\)|Number\((s|days|merged)\.\w+\)|parseFloat\(merged\./;
    assert.ok(/\.(intIn|numSetting|normalizeSeenThreshold)\b/.test(src) && !bare.test(src), `${f}: parses its whole-number settings with intIn`);
  }
  // J15: the dialogs' settings take range and default from NUM_SETTINGS alone: no reader writes them again.
  for (const f of [...PS.triage, ...PS.own("background.js")]) {
    const src = PS.read(f);
    assert.ok(!/intIn\([^)]*, ((600|100|50|1000|3650|3651), [1-9]\d*|32000, \d+)\)|(IntervalSec|BatchSize|TagLimit|NewTagMax|MaxTokens|Days): \d|\? (90|365) :/.test(src), `${f} writes a setting's range or default itself`);
  }

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
  assert.ok(/^<button type="button" data-r><svg[^]*<\/svg>刷新<\/button>$/.test(UI.refreshEmpty("data-r")), UI.refreshEmpty("data-r"));
  both("UI.refreshEmpty(", "draws the empty state's 刷新 with refreshEmpty");
  // K8: the icons stay inside shared.js, drawn by its helpers.
  assert.ok(!("ICON" in UI), "ICON is not exported");
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

// Rows 3 and 4 have 8px above and below, and both modes' lists start 8px under row 4 (DESIGN 视觉设计 · 分拣台): the list runs under
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
  for (const f of ["triage/triage.html", ...PS.triage]) assert.ok(!PS.read(f).includes("AI 打标签每批数量"), `${f} names the batch row itself`);
  assert.ok(!/<dialog/.test(PS.text(PS.follow)), "关注 builds no dialog markup");
  const root = { querySelectorAll: (sel) => (sel.includes("data-num") ? [] : [row]) };
  const row = { dataset: { setRow: "aiBatch" }, querySelector: () => ({ id: "x" }), insertAdjacentHTML(_, h) { this.html = h; } };
  UI.fillSetRows(root);
  assert.ok(row.html.includes(">AI 打标签每批数量</label>") && row.html.includes("1–100 个一批。"), row.html);
  // J15: each number box gets its range and default from NUM_SETTINGS: 「默认 N」, 「自动」 where the default is 0.
  const box = (num) => ({ dataset: { num } });
  const boxes = [box("aiBatch"), box("maxTokens"), box("newTagMax")];
  UI.fillSetRows({ querySelectorAll: (sel) => (sel === "input[data-num]" ? boxes : []) });
  assert.deepStrictEqual(boxes.map((b) => [b.min, b.max, b.placeholder]), [[1, 100, "默认 30"], [200, 32000, "自动"], [0, 50, "默认 5"]]);
  assert.deepStrictEqual(["", "x", 0, 999].map((v) => UI.numSetting("aiBatch", v)), [30, 30, 30, 100], "numSetting reads the same table");
  const numbers = [...html.matchAll(/<input [^>]*type="number"[^>]*>/g)].map((m) => m[0]);
  assert.strictEqual(numbers.length, 13);
  for (const n of numbers) assert.ok(/data-num="(\w+)"/.test(n) && UI.NUM_SETTINGS[n.match(/data-num="(\w+)"/)[1]] && !/ (min|max|placeholder)=/.test(n), `${n}: range and default come from NUM_SETTINGS`);
  // Hints write a setting's numbers through [data-num-min|max|default] spans that fillSetRows fills from the same table;
  // no page text (tags stripped, so filled spans are empty) or SET_ROWS hint spells a range, 默认 or 最多 of the table.
  const spans = [{ dataset: { numMin: "tagLimit" } }, { dataset: { numMax: "coarseBatch" } }, { dataset: { numDefault: "fineBatch" } }];
  UI.fillSetRows({ querySelectorAll: (sel) => (sel.includes("data-num-max") ? spans : []) });
  assert.deepStrictEqual(spans.map((n) => n.textContent), [1, 1000, 10]);
  for (const m of html.matchAll(/data-num-(?:min|max|default)="(\w+)"/g)) assert.ok(UI.NUM_SETTINGS[m[1]], m[0]);
  assert.ok(/data-num-max="coarseBatch"/.test(html) && /data-num-default="fineBatch"/.test(html), "the batch hints read the table");
  assert.ok(!/<span data-(tag-limit|ai-new-tag-max)>[^<]/.test(html), "the help dialog's caps are filled, not written");
  // The settings page's two batch hints use the same spans, and every page with spans runs a script that fills them.
  const optionsHtml = fs.readFileSync(path.join(__dirname, "../options.html"), "utf8");
  for (const s of ['data-num-default="coarseBatch"', 'data-num-max="coarseBatch"', 'data-num-default="fineBatch"', 'data-num-max="fineBatch"']) assert.ok(optionsHtml.includes(s), `options.html: ${s}`);
  for (const [page, text] of [["triage.html", html], ["../options.html", optionsHtml]]) {
    const own = [...text.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => path.join(path.dirname(path.join(__dirname, page)), m[1])).filter((f) => !f.endsWith("shared.js"));
    assert.ok(own.some((f) => /\b(fillNumHints|fillSetRows)\(document\)/.test(fs.readFileSync(f, "utf8"))), `${page}: no script fills the data-num spans`);
  }
  const table = Object.values(UI.NUM_SETTINGS);
  const setRows = fs.readFileSync(path.join(__dirname, "shared.js"), "utf8").match(/const SET_ROWS = \{[\s\S]*?\n  \};/)[0];
  const pages = ["triage.html", "../options.html", "../popup.html", "../sidepanel.html", "../history/history.html"];
  for (const [where, text] of [...pages.map((p) => [p, fs.readFileSync(path.join(__dirname, p), "utf8").replace(/<[^>]*>/g, "")]), ["SET_ROWS", setRows]]) {
    for (const [hit, lo, hi] of text.matchAll(/(\d+)\s*–\s*(\d+)/g)) assert.ok(!table.some(([min, max]) => +lo === min && +hi === max), `${where}: ${hit} repeats a NUM_SETTINGS range`);
    for (const [hit, n] of text.matchAll(/默认 ?(\d+)/g)) assert.ok(!table.some(([, , def]) => +n === def), `${where}: ${hit} repeats a NUM_SETTINGS default`);
    for (const [hit, n] of text.matchAll(/最多 ?(\d+)/g)) assert.ok(!table.some(([, max]) => +n === max), `${where}: ${hit} repeats a NUM_SETTINGS max`);
  }
  // Fixed numbers the hints quote (titles per 粗看 request, 简介 chars, hot comments, 快捷追问 and 段落 caps, subtitle chars)
  // live in code alone; hints show them through [data-hint-num] spans.
  const hintSpans = [...optionsHtml.matchAll(/data-hint-num="(\w+)"/g)].map((m) => ({ dataset: { hintNum: m[1] } }));
  UI.fillNumHints({ querySelectorAll: (sel) => (sel === "[data-hint-num]" ? hintSpans : []) });
  assert.deepStrictEqual(hintSpans.map((n) => `${n.dataset.hintNum}=${n.textContent}`).sort(), ["aiSubtitleWan=6", "deepComments=10", "hotComments=20", "introChars=120", "noteSections=5", "presetPrompts=12", "titlesPerRequest=20"]);
  assert.ok(/一次请求带 <span data-hint-num="titlesPerRequest"><\/span> 个标题/.test(optionsHtml), "options.html's 粗看 hint reads TITLES_PER_REQUEST");
  const optionsText = optionsHtml.replace(/<[^>]*>/g, "");
  for (const re of [/\d+ ?条热门评论/, /最多 ?\d+ ?[段条]/, /简介前 ?\d+/, /\d+ ?万字/]) assert.ok(!re.test(optionsText), `options.html writes ${re} itself`);
  const bg = fs.readFileSync(path.join(__dirname, "triage-bg.js"), "utf8");
  assert.ok(/fetchComments\(ref, m, TRIAGE_BILI_IO, TriageUi\.DEEP_COMMENTS\)/.test(bg) && !/slice\(0, 120\)/.test(bg), "细看 and 粗看 read DEEP_COMMENTS and INTRO_CHARS");
  for (const p of pages) assert.ok(!/\d+ ?个标题/.test(fs.readFileSync(path.join(__dirname, p), "utf8").replace(/<[^>]*>/g, "")), `${p} writes the titles per request itself`);
  for (const f of PS.pageCode) assert.ok(!/TITLES_PER_REQUEST\s*=/.test(PS.read(f)), `${f} sets the titles per request itself`);
  // 看到多少算看完了: range and default only in settings.js's SEEN_THRESHOLD; every reader (background, bili-surfaces.js,
  // options) parses with normalizeSeenThreshold, and the settings page's box gets min, max and 「默认 N」 from code.
  const seenReaders = [...PS.pageCode, "bili-surfaces.js", "options.html", "triage/triage.html"];
  for (const f of seenReaders) {
    const src = PS.read(f);
    assert.ok(!/seenThreshold\b[^\n]*\b(80|100)\b|\b1, 100\b|\|\| 80\b/.test(src), `${f} writes 看到多少算看完了's range or default itself`);
  }
  assert.ok(!/id="seenThreshold"[^>]* (min|max|placeholder)=/.test(optionsHtml), "options.html's 看到多少算看完了 box takes its range from code");
  for (const f of ["../background.js", "../bili-surfaces.js", "../options.js"]) assert.ok(/MdgSettings\.normalizeSeenThreshold\(/.test(fs.readFileSync(path.join(__dirname, f), "utf8")), `${f} parses 看到多少算看完了 with normalizeSeenThreshold`);
}

// A number field above max becomes max; below min (or negative) it is emptied, which means the default.
{
  const num = (value, min, max) => {
    const input = { type: "number", value, min, max, dataset: {} };
    UI.clampNumber(input);
    return String(input.value);
  };
  assert.deepStrictEqual(["60", "0", "-3", "7.6", ""].map((v) => num(v, "1", "50")), ["50", "", "", "8", ""]);
  assert.deepStrictEqual(["0", "-5", "12"].map((v) => num(v, "0", "600")), ["0", "", "12"], "0 stays where min is 0");
  assert.strictEqual(num("9999", "0", ""), "9999", "no max");
  // 输出上限 (min 200, empty = 自动): 0, negative and below 200 are 自动.
  assert.deepStrictEqual(["0", "-5", "50", "40000"].map((v) => num(v, "200", "32000")), ["", "", "", "32000"]);
}

// Rows 3 and 4 start with their name, 「状态」 and 「标签」, in 收藏夹 and in both 关注 tabs (UP 主, 视频投稿).
{
  assert.strictEqual(UI.labeledRow("状态", "<b>x</b>"), '<span class="row-label">状态</span><b>x</b>');
  const count = (files, re) => (PS.text(files).match(re) || []).length;
  assert.strictEqual(count(PS.favorites, /UI\.labeledRow\("状态", /g), 1, "收藏夹 row 3");
  assert.strictEqual(count(PS.favorites, /UI\.labeledRow\("标签", /g), 1, "收藏夹 row 4");
  assert.strictEqual(count(PS.follow, /UI\.labeledRow\("状态", /g), 2, "关注 row 3, UP 主 and 视频投稿");
  assert.strictEqual(count(PS.follow, /UI\.labeledRow\("标签", /g), 2, "关注 row 4, UP 主 and 视频投稿");
  assert.strictEqual(count(PS.triage, /row-label/g), 0, "分拣台 draws no label of its own");
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

  for (const bad of XSS) {
    assertInert(UI.titleHtml(bad, 2), "titleHtml");
    assertInert(UI.cardTagChip({ id: bad, name: bad, color: "#fff" }, bad), "cardTagChip");
    assertInert(UI.tagRowHtml({ id: bad, name: bad, color: "#fff", rule: bad }, { count: 1, who: "视频" }), "tagRowHtml");
    assertInert(UI.tagPlusBtn('data-x="1"', `给 ${bad} 打 UP 标签`), "tagPlusBtn");
    assertInert(UI.sideItem({ attrs: "", label: bad }), "sideItem");
  }
  {
    // A stuck pill: the countdown sits apart from the line (a narrow window cuts the line only), the whole text on hover.
    const el = { classList: { toggle() {} } };
    const text = "加载收藏夹 1/3（电影） · B站限流卡住，1:29 后重试";
    UI.setActivity(el, { text, wait: "B站限流卡住，1:29 后重试", stuck: true, done: 1, total: 3 });
    assert.strictEqual(el.title, text);
    assert.ok(el.innerHTML.includes('<span class="activity-text">加载收藏夹 1/3（电影）</span><span>· B站限流卡住，1:29 后重试</span>'), el.innerHTML);
  }
  console.log("shared selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
