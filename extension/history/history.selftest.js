// node extension/history/history.selftest.js
// Loads history.js as the page does (after limits, typing, sites, note, download) on a stub DOM.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const source = fs.readFileSync(path.join(__dirname, "history.js"), "utf8").replace(/^if \(!globalThis\.chrome\?\.runtime\?\.id\) await import.*$/m, "");
const L = {};
const els = {};
const node = (id) =>
  (els[id] ||= {
    id,
    value: "",
    checked: false,
    textContent: "",
    innerHTML: "",
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    classList: { toggle() {}, add() {}, remove() {} },
    querySelectorAll: () => [],
    addEventListener: (t, f) => ((L[id] ||= {})[t] ||= []).push(f)
  });
const conv = (key) => ({ id: key, contextKey: key, title: key, createdAt: 1, updatedAt: 1, messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] });
const store = { boc_ai_conversations_v1: [conv("a"), conv("b")] };
const ctx = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  window: { scrollY: 0, scrollTo() {} },
  document: { getElementById: node, addEventListener() {}, activeElement: null },
  chrome: {
    runtime: { id: "test", sendMessage: async () => ({}) },
    tabs: { getCurrent: async () => ({ id: 1 }) },
    storage: { local: { get: async () => store, set: async () => {} }, onChanged: { addListener() {} } }
  }
});
ctx.globalThis = ctx;
for (const f of ["limits.js", "typing.js", "sites.js", "note.js", "download.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), ctx);

(async () => {
  await vm.runInContext(`(async () => {\n${source}\n})()`, ctx);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fire = (t, e = {}) => (L.search[t] || []).forEach((f) => f(e));
  // the search box renders once typing stops, never on each pinyin keystroke.
  let renders = 0;
  const list = els.list;
  let html = list.innerHTML;
  Object.defineProperty(list, "innerHTML", { get: () => html, set: (v) => (renders++, (html = v)) });
  els.search.value = "z";
  fire("compositionstart");
  fire("input", { isComposing: true });
  els.search.value = "zhong";
  fire("input", { isComposing: true });
  await wait(200);
  assert.strictEqual(renders, 0, "no render mid-composition");
  els.search.value = "中";
  fire("compositionend");
  await wait(200);
  assert.strictEqual(renders, 1, "compositionend renders the committed text once");

  // 全选 is three-state over the listed videos, says how many it covers, and disabled bulk buttons say why.
  els.search.value = "";
  fire("input", {});
  await wait(200);
  const sa = els.selectAll;
  const reason = (id) => [els[id].disabled, els[id].title, els[id].attrs["aria-description"]];
  assert.deepStrictEqual([sa.checked, sa.indeterminate], [false, false], "none selected: empty box");
  assert.deepStrictEqual(reason("bulkMd"), [true, "先勾选视频", "先勾选视频"]);
  assert.deepStrictEqual(reason("bulkDelete"), [true, "先勾选视频", "先勾选视频"]);
  assert.deepStrictEqual(reason("clearAll"), [false, "", undefined], "conversations exist: clear-all usable, no reason");
  const pick = (key, checked) => {
    const target = { checked, dataset: { act: "pick" }, closest: (s) => (s === ".entry" ? { dataset: { key } } : target) };
    (L.list.click || []).forEach((f) => f({ target }));
  };
  pick("a", true);
  assert.deepStrictEqual([sa.checked, sa.indeterminate], [false, true], "some selected: indeterminate");
  assert.deepStrictEqual(reason("bulkMd"), [false, "", undefined]);
  pick("b", true);
  assert.deepStrictEqual([sa.checked, sa.indeterminate], [true, false], "all selected: checked");
  assert.strictEqual(els.selectAllLabel?.textContent, "全选 2 个");
  console.log("history selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
