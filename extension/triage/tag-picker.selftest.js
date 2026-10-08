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
const input = node({ value: "", focused: 0, focus() { this.focused++; } });
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
for (const f of ["../typing.js", "../tag-core.js", "shared.js", "tag-picker.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
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

  // Modal: opens with the filter focused, rows numbered 1–9, the target's tags ticked.
  P.open(opts());
  assert.deepStrictEqual(calls.splice(0), ["showModal"]);
  assert.ok(input.focused && P.isOpen());
  assert.ok(list.innerHTML.includes('aria-checked="true"><span class="check">✓</span>') && list.innerHTML.includes('<span class="n" aria-hidden="true">3</span>'));

  // ↓ then Enter ticks the second row; 1 ticks the first (游戏 off); Enter that picks an IME candidate ticks nothing.
  assert.strictEqual(key("ArrowDown").prevented, 1);
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
  input.value = "";
  assert.strictEqual(key("9").prevented, 0);
  assert.strictEqual(key("2", { metaKey: true }).prevented, 0, "⌘2 is the browser's");
  P.close();
  assert.deepStrictEqual(saved.splice(0), [[]], "closing without a tick saves nothing");

  // Several targets: – for some, a click puts it on all, a second click takes it off all.
  P.open(opts({ targets: ["a", "b"] }));
  assert.ok(list.innerHTML.includes('aria-checked="mixed"><span class="check">–</span>') && list.innerHTML.includes("1 个有"));
  fire(list, "click", { target: { closest: () => ({ dataset: { i: "0" } }) } });
  assert.ok(list.innerHTML.includes('aria-checked="true"><span class="check">✓</span><span class="dot" style="--c:#1"></span>游戏'));
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

  // 完成 submits the form, which closes the dialog: that saves too.
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

  console.log("tag-picker selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
