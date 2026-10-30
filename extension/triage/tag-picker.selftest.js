// node extension/triage/tag-picker.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// A small fake DOM: the dialog and its parts record listeners; fire() runs them like the browser would.
function node(extra = {}) {
  const L = {};
  return Object.assign({ L, addEventListener: (t, f) => (L[t] ||= []).push(f), classList: { on: new Set(), toggle(c, v) { v ? this.on.add(c) : this.on.delete(c); } }, style: {}, dataset: {} }, extra);
}
const fire = (n, type, e = {}) => {
  const ev = { prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; }, isComposing: false, keyCode: 0, ...e };
  (n.L[type] || []).forEach((f) => f(ev));
  return ev;
};
const input = node({ value: "", focused: 0, focus() { this.focused++; }, setAttribute(k, v) { this[k] = v; } });
const list = node({ innerHTML: "", querySelector: () => null });
const parts = { ".tp-input": input, ".picker-list": list, ".tp-title": node({ textContent: "" }), ".tp-note": node({ textContent: "" }) };
const calls = [];
const dlg = node({
  open: false,
  offsetWidth: 248,
  offsetHeight: 200,
  querySelector: (s) => parts[s],
  contains: (el) => Boolean(el?.inside),
  show() { this.open = true; calls.push("show"); },
  showModal() { this.open = true; calls.push("showModal"); },
  close() { this.open = false; calls.push("close"); },
  getBoundingClientRect: () => ({ left: 100, right: 400, top: 100, bottom: 400 })
});
const doc = node({ getElementById: (id) => (id === "tagPicker" ? dlg : null), querySelector: () => ({ getBoundingClientRect: () => ({ left: 50, right: 90, top: 300, bottom: 320 }) }), body: {} });
const win = node();
const ctx = vm.createContext({ document: doc, addEventListener: win.addEventListener, innerWidth: 1440, innerHeight: 900, setTimeout, clearTimeout });
for (const f of ["../errors.js", "../typing.js", "../tag-core.js", "../settings.js", "shared.js", "tag-picker.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
const P = ctx.TagPicker;
const plain = (v) => JSON.parse(JSON.stringify(v));
const wait = () => new Promise((r) => setTimeout(r, 10));
const key = (k, o = {}) => fire(dlg, "keydown", { key: k, target: input, ...o });

// Pure: the click rule, what closing saves, the rows.
{
  const sets = new Map([["a", new Set(["x"])], ["b", new Set()]]);
  P.toggle(sets, "x");
  assert.deepStrictEqual([...sets.values()].map((s) => [...s]), [["x"], ["x"]], "some have it → all get it");
  P.toggle(sets, "x");
  assert.deepStrictEqual([...sets.values()].map((s) => [...s]), [[], []], "all have it → off all");
  const before = new Map([["a", ["x", "y"]], ["b", []]]);
  const after = new Map([["a", new Set(["y", "z"])], ["b", new Set()]]);
  assert.deepStrictEqual(plain(P.changesOf(before, after)), [{ key: "a", add: ["z"], remove: ["x"] }], "unchanged targets save nothing");
  // Applied to what is stored then: a tag added elsewhere meanwhile (w) stays.
  assert.deepStrictEqual(plain(P.applyChange(["x", "y", "w"], { add: ["z"], remove: ["x"] })), ["y", "w", "z"]);
  const tags = [{ id: "1", name: "游戏" }, { id: "2", name: "Go" }];
  const ids = (q, c) => plain(P.rowsOf(tags, q, c).map((r) => r.create ? `+${r.create}` : r.tag.id));
  assert.deepStrictEqual(ids("", true), ["1", "2"]);
  assert.deepStrictEqual(ids("go", true), ["2", "+go"], "case-insensitive match first, 新建 last for a new name");
  assert.deepStrictEqual(ids("Go", true), ["2"], "an existing name is not created again");
  assert.deepStrictEqual(ids("x", false), [], "nothing to create where tags cannot be made");
}

// A press inside keeps the focus in the filter, on a tag or between tags; the box and the backdrop keep theirs.
{
  const press = (target) => fire(dlg, "mousedown", { target }).prevented;
  assert.deepStrictEqual([press(list), press(input), press(dlg)], [1, 0, 0]);
}

// Pure: the keys, the order, the grid.
{
  assert.deepStrictEqual([0, 8, 9, 10].map(P.keyOf), ["1", "9", "0", ""], "1–9, then 0 for the tenth, then none");
  assert.deepStrictEqual(["1", "9", "0"].map(P.indexOfKey), [0, 8, 9]);
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));
  const uses = (id) => Number(id.slice(1));
  assert.deepStrictEqual(plain(P.orderOf(many(10), uses)), many(10).map((t) => t.id), "ten keep their order");
  assert.strictEqual(P.orderOf(many(11), uses)[0], "t10", "eleven: most used first");
  assert.deepStrictEqual(plain(P.inOrder([{ id: "new" }, { id: "b" }, { id: "a" }], ["a", "b"]).map((t) => t.id)), ["a", "b", "new"], "made since opening: last");
  // 7 tags:  0 1 2 / 3 4 5 / 6
  assert.strictEqual(P.gridMove(0, 7, "ArrowDown"), 3);
  assert.strictEqual(P.gridMove(6, 7, "ArrowDown"), 0, "the column wraps");
  assert.strictEqual(P.gridMove(1, 7, "ArrowUp"), 4, "a short column wraps to its own last row");
  assert.strictEqual(P.gridMove(6, 7, "ArrowRight"), 0);
  assert.strictEqual(P.gridMove(0, 7, "ArrowLeft"), 6);
  assert.strictEqual(P.gridMove(0, 0, "ArrowDown"), 0);
}

(async () => {
  const tags = [{ id: "g", name: "游戏", color: "#1" }, { id: "s", name: "生活", color: "#2" }, { id: "k", name: "科普", color: "#3" }];
  const stored = { a: ["g"], b: [] };
  const saved = [];
  let made = 0;
  const opts = (o = {}) => ({
    title: "打标签",
    targets: ["a"],
    idsOf: (k) => stored[k],
    tags: () => tags,
    canCreate: true,
    create: async (name) => {
      made++;
      const t = { id: `n${made}`, name, color: "#4" };
      tags.push(t);
      return t;
    },
    onClose: (c) => saved.push(plain(c)),
    ...o
  });

  // Modal: opens with the filter focused, tags numbered, the target's tags ticked.
  P.open(opts());
  assert.deepStrictEqual(calls.splice(0), ["showModal"]);
  assert.ok(input.focused && P.isOpen());
  assert.ok(list.innerHTML.includes('aria-checked="true"><span class="slot">✓</span>') && list.innerHTML.includes('<span class="n" aria-hidden="true">3</span>'));

  // → then Enter ticks the second tag; 1 ticks the first (游戏 off); Enter that picks an IME candidate ticks nothing.
  assert.strictEqual(key("ArrowRight").prevented, 1);
  assert.strictEqual(key("Enter").prevented, 1, "Enter never submits the form");
  key("1");
  const ime = key("Enter", { isComposing: true, keyCode: 229 });
  assert.strictEqual(ime.prevented, 0, "the IME gets its Enter");
  assert.strictEqual(key("Escape", { keyCode: 229, isComposing: true }).prevented, 0, "Esc mid-IME cancels the composition, not the picker");
  assert.ok(P.isOpen());
  // Esc closes and saves once: 生活 on, 游戏 off.
  assert.strictEqual(key("Escape").prevented, 1);
  assert.deepStrictEqual(saved.splice(0), [[{ key: "a", add: ["s"], remove: ["g"] }]]);
  assert.ok(!P.isOpen() && !dlg.open);
  fire(dlg, "close");
  P.close();
  assert.deepStrictEqual(saved, [], "the dialog's close event and a second close save nothing more");

  // A digit is the filter's text once something is typed; 9 with fewer tags does nothing.
  P.open(opts());
  input.value = "游";
  assert.strictEqual(key("1").prevented, 0, "1 goes into the filter");
  // A space takes the numbers away, so a name can start with a digit: the digit is text, and the name has no space.
  input.value = " ";
  fire(input, "input");
  await wait();
  assert.ok(!list.innerHTML.includes('class="n"'), list.innerHTML);
  assert.strictEqual(key("1").prevented, 0, "1 goes into the box");
  input.value = "";
  fire(input, "input");
  await wait();
  key("1");
  input.value = "";
  assert.strictEqual(key("9").prevented, 0);
  assert.strictEqual(key("2", { metaKey: true }).prevented, 0, "⌘2 is the browser's");
  key("1");
  P.close();
  assert.deepStrictEqual(saved.splice(0), [[]], "closing without a tick saves nothing");

  // Several targets: – for some, a click puts it on all, a second click takes it off all.
  P.open(opts({ targets: ["a", "b"] }));
  assert.ok(list.innerHTML.includes('aria-checked="mixed"><span class="slot">–</span>') && list.innerHTML.includes("1 个有"));
  fire(list, "click", { target: { closest: () => ({ dataset: { i: "0" } }) } });
  assert.ok(list.innerHTML.includes('style="--c:#1" title="游戏" aria-checked="true"><span class="slot">✓</span><span class="name">游戏</span>'));
  P.close();
  assert.deepStrictEqual(saved.splice(0), [[{ key: "b", add: ["g"], remove: [] }]]);

  // The filter waits for the IME; Enter on 新建「…」 creates it and ticks it on every target.
  P.open(opts({ targets: ["a", "b"] }));
  fire(input, "compositionstart");
  input.value = "dian";
  fire(input, "input", { isComposing: true });
  await wait();
  assert.ok(!list.innerHTML.includes("新建"), "no filtering mid-composition");
  input.value = "电影";
  fire(input, "compositionend");
  await wait();
  assert.ok(list.innerHTML.includes("新建「电影」"));
  key("Enter");
  await wait();
  assert.strictEqual(made, 1);
  assert.strictEqual(input.value, "", "the filter clears after creating");
  key("Escape");
  assert.deepStrictEqual(saved.splice(0), [[{ key: "a", add: ["n1"], remove: [] }, { key: "b", add: ["n1"], remove: [] }]]);

  // Any close of the dialog saves.
  P.open(opts());
  key("2");
  dlg.close();
  fire(dlg, "close");
  assert.deepStrictEqual(saved.splice(0), [[{ key: "a", add: ["s"], remove: [] }]]);

  // Popover: shown under the anchor; a click inside keeps it, outside closes and saves; so does the window losing focus.
  calls.length = 0;
  P.open(opts({ anchor: "#x .tag-plus" }));
  assert.deepStrictEqual(calls.splice(0), ["show"]);
  assert.ok(dlg.classList.on.has("tp-pop") && dlg.style.top === "326px" && dlg.style.left === "50px");
  fire(doc, "click", { target: { inside: true } });
  assert.ok(P.isOpen());
  fire(doc, "click", { target: {} });
  assert.ok(!P.isOpen());
  assert.deepStrictEqual(saved.splice(0), [[]]);
  P.open(opts({ anchor: "#x" }));
  fire(win, "blur");
  assert.ok(!P.isOpen());
  // A modal ignores both, and sits centered (no popover position left over).
  P.open(opts());
  assert.ok(!dlg.classList.on.has("tp-pop") && dlg.style.top === "" && dlg.style.left === "");
  fire(doc, "click", { target: {} });
  fire(win, "blur");
  assert.ok(P.isOpen());
  // Opening another closes (and saves) the open one first; its late close event leaves the new one open.
  key("2");
  saved.length = 0;
  P.open(opts({ targets: ["b"] }));
  assert.deepStrictEqual(saved.splice(0), [[{ key: "a", add: ["s"], remove: [] }]]);
  fire(dlg, "close");
  assert.ok(P.isOpen() && dlg.open, "the old close event does not close the new picker");
  P.close();

  // C539: where no tag can be made, the box does not offer 新建.
  P.open(opts({ canCreate: false }));
  assert.ok(!input.placeholder.includes("新建") && !input["aria-label"].includes("新建") , input.placeholder);
  P.close();
  P.open(opts());
  assert.ok(input.placeholder.includes("新建"), input.placeholder);
  P.close();

  console.log("tag-picker selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
