// node extension/sidepanel.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// sidepanel.js is a DOM page: drop init(), stub the DOM, and drive the context loads by hand.
const source = fs.readFileSync(path.join(__dirname, "sidepanel.js"), "utf8").replace(/^init\(\)\.catch\(/m, "(async () => {})().catch(");
assert.ok(source.includes("(async () => {})().catch("), "harness strips the page entry point");

const stubEl = () => new Proxy({ classList: { toggle() {}, add() {}, remove() {} }, style: {}, dataset: {} }, {
  get: (o, k) => (k in o ? o[k] : () => {}),
  set: (o, k, v) => ((o[k] = v), true)
});
let activeTab = null;
let answer = null; // (tabId) => promise of the ai-sidepanel-get-state reply
const ctx = vm.createContext({
  console,
  structuredClone,
  URL,
  setTimeout: (f) => setImmediate(f),
  clearTimeout: (id) => clearImmediate(id),
  document: { getElementById: stubEl, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: stubEl },
  window: { addEventListener() {}, setTimeout: (f) => setImmediate(f), clearTimeout: (id) => clearImmediate(id), matchMedia: () => ({ matches: false }) },
  navigator: {},
  chrome: {
    runtime: {
      id: "test",
      lastError: undefined,
      getURL: (p) => p,
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        Promise.resolve(msg.type === "ai-sidepanel-get-state" ? answer(msg.tabId) : { ok: true }).then(cb);
      }
    },
    tabs: { query: async () => [activeTab], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } }
  }
});
ctx.globalThis = ctx;
for (const f of ["limits.js", "sites.js", "note.js", "download.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
vm.runInContext(`${source}\n;globalThis.peek = () => ({ live: liveContextData, ctx: contextData });`, ctx);
for (const f of ["updateContextChip", "renderHistoryList", "restartChat", "renderSuggestions", "renderInitialState", "resetConversationView"]) ctx[f] = () => {};
ctx.restoreLatestConversationForCurrentContext = async () => {};

const page = (id) => ({ ok: true, payload: { url: `https://example.com/${id}`, title: id, isVideoContext: false } });

(async () => {
  // Switching tabs quickly: tab A's slow reply arrives after tab B's and must not replace it.
  let releaseA;
  answer = (tabId) => (tabId === 1 ? new Promise((r) => (releaseA = () => r(page("a")))) : page("b"));
  activeTab = { id: 1, url: "https://example.com/a" };
  const loadA = ctx.loadContextState({ silent: true });
  await new Promise((r) => setImmediate(r));
  activeTab = { id: 2, url: "https://example.com/b" };
  assert.strictEqual(await ctx.loadContextState({ silent: true }), true);
  releaseA();
  assert.strictEqual(await loadA, true, "the older call answers with the newer result");
  const { live, ctx: current } = ctx.peek();
  assert.deepStrictEqual([live.url, current.url], ["https://example.com/b", "https://example.com/b"], "tab B's context stays");

  // A follow asked for by a load that a newer one replaced is done by the newer one, and only until it settles.
  const realRead = ctx.readContextState;
  const follows = [];
  let release;
  ctx.readContextState = (opts) => (follows.push(opts.follow), new Promise((r) => (release = r)));
  ctx.loadContextState({ follow: true });
  const send = ctx.loadContextState({});
  release(true);
  await send;
  const later = ctx.loadContextState({});
  release(true);
  await later;
  assert.deepStrictEqual(follows, [true, true, false]);
  ctx.readContextState = realRead;

  console.log("sidepanel selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
