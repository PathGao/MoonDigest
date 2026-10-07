// node extension/content.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// content.js is a page script: lift its body out of the run-once block, drop init(), stub the DOM, and drive the
// async flows by hand. Top-level functions are then globals, so a test can stand in for the DOM-heavy ones.
const lines = fs.readFileSync(path.join(__dirname, "content.js"), "utf8").replace(/\s+$/, "").split("\n");
assert.strictEqual(lines[3], "if (!globalThis.__BOC_CONTENT_SCRIPT_LOADED__) {", "harness lifts the run-once block");
assert.strictEqual(lines.at(-1), "}");
const source = lines.slice(4, -1).join("\n").replace(/^init\(\);$/m, "");

const stubEl = () => new Proxy({ classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, style: { setProperty() {}, removeProperty() {} }, dataset: {} }, {
  get: (o, k) => (k in o ? o[k] : () => {}),
  set: (o, k, v) => ((o[k] = v), true)
});
const listeners = { message: [], storage: [] };
const ctx = vm.createContext({
  console,
  structuredClone,
  URL,
  URLSearchParams,
  TextEncoder,
  setTimeout: (f) => setImmediate(f),
  clearTimeout: (id) => clearImmediate(id),
  setInterval: () => 0,
  Event: class {
    constructor(type) {
      this.type = type;
    }
  },
  performance: { getEntriesByType: () => [] },
  location: { href: "https://www.bilibili.com/video/BV1GJ411x7h7/", hostname: "www.bilibili.com", pathname: "/video/BV1GJ411x7h7/", search: "" },
  document: {
    documentElement: stubEl(),
    body: stubEl(),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: stubEl,
    addEventListener() {},
    dispatchEvent() {}
  },
  chrome: {
    runtime: {
      id: "test",
      getManifest: () => ({ version: "0.0.0" }),
      getURL: (p) => p,
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: (f) => listeners.message.push(f) }
    },
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      sync: { get: async (d) => ({ ...d }) },
      onChanged: { addListener: (f) => listeners.storage.push(f) }
    }
  }
});
ctx.window = ctx;
ctx.globalThis = ctx;
for (const f of ["limits.js", "sites.js", "note.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
vm.runInContext(`${source}\n;globalThis.state = state;`, ctx);
const t = ctx;
const { state } = t;
for (const f of ["setStatus", "setMessage", "setReadingNotice", "renderReadingView", "syncReadingViewPlayback", "rebuildDerivedContent", "logInfo", "logWarn"]) t[f] = () => {};
t.byId = stubEl;

// A promise a test resolves when it chooses: the slow side of two overlapping flows.
function gate(value) {
  let open;
  const promise = new Promise((r) => (open = () => r(value)));
  return { promise, open };
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

(async () => {
  // G4: the video changes while a subtitle body is being cached; the old body must not land under the new video.
  {
    state.videoDuration = 100;
    state.subtitleBody = [];
    t.currentSite = () => ({ parseSegments: () => [{ from: 0, to: 1, content: "旧视频" }] });
    const realSave = t.BocSites.subtitleCache.save;
    const save = gate();
    t.BocSites.subtitleCache.save = () => save.promise;
    const commit = t.commitSubtitleBody("raw", { url: "u", lang: "zh", subtitleId: "1" }, state.fetchRunId);
    await settle();
    state.fetchRunId++;
    save.open();
    await assert.rejects(commit, (e) => t.isStaleRunError(e));
    assert.deepStrictEqual(state.subtitleBody, [], "the new video keeps an empty body");
    t.BocSites.subtitleCache.save = realSave;
  }

  // G4: the note's AI turns and triage extras read for the old video are dropped once it changed.
  {
    const turns = gate(["旧回答"]);
    t.loadAiTurns = () => turns.promise;
    t.loadTriageExtras = async () => ({ note: "旧备注" });
    state.aiTurns = [];
    state.triageExtras = null;
    const derived = t.refreshDerivedContent();
    await settle();
    state.fetchRunId++;
    turns.open();
    await derived;
    assert.deepStrictEqual([state.aiTurns.length, state.triageExtras], [0, null]);
  }

  // G4: a refresh waiting for the player's metadata is dropped when the video changed during the wait.
  {
    const refreshed = [];
    t.refreshClipShared = t.refreshClip = async () => refreshed.push(state.fetchRunId);
    let meta = gate();
    t.waitForVideoMetadata = () => meta.promise;
    state.subtitleBody = [];
    t.maybeRefreshReaderSubtitleInBackground();
    state.fetchRunId++;
    meta.open();
    await settle();
    assert.deepStrictEqual(refreshed, [], "background refresh after a change");
    meta = gate();
    t.maybeRefreshReaderSubtitleInBackground();
    meta.open();
    await settle();
    assert.strictEqual(refreshed.length, 1, "without a change it refreshes");

    // The URL watcher's own wait, in focus mode: a second navigation during it wins.
    refreshed.length = 0;
    for (const f of ["ensureUiReady", "enforceNormalPageStateIfNeeded", "resetClipState"]) t[f] = () => {};
    let sig = 0;
    t.computeCurrentClipSignature = () => `clip${++sig}`;
    t.stepReader("mark");
    t.stepReader("enter");
    meta = gate();
    t.checkUrlChange();
    const second = gate();
    t.waitForVideoMetadata = () => second.promise;
    t.checkUrlChange();
    meta.open();
    await settle();
    assert.deepStrictEqual(refreshed, [], "the first navigation's wait gives way");
    second.open();
    await settle();
    assert.strictEqual(refreshed.length, 1);
    t.stepReader("close");
  }

  // G4: comments asked for by the side panel and storage echoes for the old video stay out of the new one.
  {
    t.bindRuntimeEvents();
    t.bindSettingsWatcher();
    state.videoId = "BV1";
    state.hotComments = [];
    t.currentSite = () => ({ fetchComments() {} });
    const comments = gate([{ content: "旧评论" }]);
    t.fetchHotComments = () => comments.promise;
    let answered;
    for (const f of listeners.message) f({ type: "sidepanel-get-hot-comments" }, {}, (r) => (answered = r));
    state.fetchRunId++;
    comments.open();
    await settle();
    assert.strictEqual(answered?.comments?.length, 1, "the side panel still gets its answer");
    assert.deepStrictEqual(state.hotComments, [], "but the new video keeps no old comments");

    state.markdown = "md";
    const turns = gate(["旧回答"]);
    t.loadAiTurns = () => turns.promise;
    state.aiTurns = [];
    for (const f of listeners.storage) f({ [t.BocLimits.KEYS.aiConversations]: {} }, "local");
    state.fetchRunId++;
    turns.open();
    await settle();
    assert.deepStrictEqual(state.aiTurns, [], "a storage echo for the old video is dropped");
  }

  // G5: focus mode is one value; every event outside the table is refused and changes nothing.
  {
    const phase = () => [state.readerPhase, state.readerMode, state.readingViewOpen, state.readingViewReady];
    assert.deepStrictEqual(phase(), ["off", false, false, false]);
    for (const e of ["enter", "ready", "unready", "close"]) assert.strictEqual(t.stepReader(e), false, `${e} from off`);
    assert.ok(t.stepReader("mark"));
    assert.deepStrictEqual(phase(), ["requested", true, false, false]);
    for (const e of ["mark", "ready", "unready"]) assert.strictEqual(t.stepReader(e), false, `${e} from requested`);
    assert.ok(t.stepReader("enter"));
    assert.deepStrictEqual(phase(), ["entering", true, true, false]);
    for (const e of ["mark", "enter", "unready"]) assert.strictEqual(t.stepReader(e), false, `${e} from entering`);
    assert.ok(t.stepReader("ready"));
    assert.deepStrictEqual(phase(), ["open", true, true, true]);
    for (const e of ["mark", "enter", "ready"]) assert.strictEqual(t.stepReader(e), false, `${e} from open`);
    assert.ok(t.stepReader("unready"));
    assert.ok(t.stepReader("close"));
    assert.deepStrictEqual(phase(), ["off", false, false, false]);
  }

  // G5: entries overlap. A second entry while one runs is refused; an entry closed and reopened mid-way finishes once.
  {
    for (const f of ["hydrateReaderStateFromSettings", "applyReadingViewPresentation", "alignReaderViewportToPlayer", "openReaderViewShell", "applyReaderPageFocus", "startReaderPlayerObserver", "scheduleReaderPlayerRetry"]) t[f] = () => {};
    t.findReaderPlayerHost = () => null;
    t.getRuntimeVideoElement = () => null;
    const mounts = [];
    t.ensureReaderPlayerMounted = () => {
      const g = gate(true);
      mounts.push(g);
      return g.promise;
    };
    const finished = [];
    t.finishEnterReaderMode = () => finished.push(state.readerGen);

    t.markReaderMode();
    const first = t.enterReaderMode();
    const twice = t.enterReaderMode();
    await settle();
    assert.strictEqual(mounts.length, 1, "the second entry is refused");
    mounts[0].open();
    await Promise.all([first, twice]);
    assert.strictEqual(finished.length, 1);

    t.stepReader("close");
    finished.length = 0;
    mounts.length = 0;
    t.markReaderMode();
    const a = t.enterReaderMode();
    await settle();
    t.stepReader("close");
    t.markReaderMode();
    const b = t.enterReaderMode();
    await settle();
    mounts[0].open();
    await a;
    assert.deepStrictEqual(finished, [], "the closed entry does not finish into the new one");
    mounts[1].open();
    await b;
    assert.deepStrictEqual(finished, [state.readerGen], "the new entry finishes once");
    t.stepReader("close");
  }

  console.log("content selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
