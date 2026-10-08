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
    classList: { toggle() {}, add() {}, remove() {} },
    querySelectorAll: () => [],
    addEventListener: (t, f) => ((L[id] ||= {})[t] ||= []).push(f)
  });
const ctx = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  window: { scrollY: 0, scrollTo() {} },
  document: { getElementById: node, addEventListener() {}, activeElement: null },
  chrome: {
    runtime: { id: "test", sendMessage: async () => ({}) },
    tabs: { getCurrent: async () => ({ id: 1 }) },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } }
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
  console.log("history selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
