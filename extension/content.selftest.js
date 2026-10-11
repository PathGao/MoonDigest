// node extension/content.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// content.js is a page script: lift its body out of the run-once block, drop init(), stub the DOM, and drive the
// async flows by hand. Top-level functions are then globals, so a test can stand in for the DOM-heavy ones.
const lines = fs.readFileSync(path.join(__dirname, "content.js"), "utf8").replace(/\s+$/, "").split("\n");
const runGate = lines[5].match(/^if \((.*)\) \{$/)?.[1];
assert.ok(runGate?.startsWith("!globalThis.__BOC_CONTENT_SCRIPT_LOADED__"), "harness lifts the run-once block");
assert.strictEqual(lines.at(-1), "}");

// Frame gate, in load order: viewer-frame.js (document_start) marks the frame, then content.js decides whether to run.
// Only the top frame and 分拣台's own viewer frame run it; a Bilibili iframe on any other page stays inert.
{
  const ext = "chrome-extension://abc";
  const runs = (isTop, parentOrigin) => {
    const attrs = new Set();
    const g = {
      location: { ancestorOrigins: isTop ? [] : [parentOrigin] },
      document: { documentElement: { setAttribute: (k) => attrs.add(k), hasAttribute: (k) => attrs.has(k) } },
      chrome: { runtime: { id: "abc" } },
      addEventListener() {}, // viewer-frame.js may listen for keys in the viewer frame
      setInterval() {} // and watch which video it shows
    };
    g.window = g;
    g.top = isTop ? g : {};
    g.globalThis = g;
    const c = vm.createContext(g);
    vm.runInContext(fs.readFileSync(path.join(__dirname, "triage/viewer-frame.js"), "utf8"), c);
    return vm.runInContext(runGate, c);
  };
  assert.strictEqual(runs(true), true, "normal Bilibili tab");
  assert.strictEqual(runs(false, ext), true, "分拣台 viewer frame");
  assert.strictEqual(runs(false, "https://example.com"), false, "Bilibili iframe on another site");
  assert.strictEqual(runs(false, "https://www.bilibili.com"), false, "Bilibili's own iframe");
  assert.strictEqual(runs(false, "chrome-extension://other"), false, "another extension's page");
}
const source = lines.slice(6, -1).join("\n").replace(/^init\(\);$/m, "");

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
// The scripts the manifest injects before content.js, read from it so the test cannot load a different set.
const entries = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8")).content_scripts.filter((c) => c.js.includes("content.js"));
assert.ok(entries.length && entries.every((c) => JSON.stringify(c.js) === JSON.stringify(entries[0].js)), "every content.js entry injects the same scripts");
const scripts = [...entries[0].js];
assert.strictEqual(scripts.pop(), "content.js", "content.js loads last");
for (const f of scripts) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
vm.runInContext(`${source}\n;globalThis.state = state;`, ctx);
const t = ctx;
// Real versions of what some tests stub, for the tests that need the real flow.
const real = Object.fromEntries(["checkUrlChange", "resetClipState", "computeCurrentClipSignature", "refreshClip", "settledClip"].map((k) => [k, t[k]]));
const realRenderReadingView = t.renderReadingView;
// Untrusted text (titles, UP names, comments, AI replies, tag names, paths) stays text: no tag of its own, no way out of
// a quoted attribute.
const XSS = ["<img src=x onerror=alert(1)>", `"'><script>alert(1)</script>`];
const assertInert = (html, where) => assert.ok(!/<img src=x|<script|"'>/i.test(html) && /&lt;|&#60;/.test(html), `${where}: ${html}`);
const { state } = t;
const realRebuild = t.rebuildDerivedContent;
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
  // The player's AI button waits for a platform; the focus-mode one is never hidden for it.
  {
    const realSync = t.chrome.storage.sync.get;
    t.chrome.storage.sync.get = async () => ({ aiProviders: [{ id: "a", enabled: false }] });
    assert.strictEqual(await t.loadHasAiProvider(), false, "a disabled platform does not count");
    t.chrome.storage.sync.get = async () => ({ aiProviders: [{ id: "a" }] });
    assert.strictEqual(await t.loadHasAiProvider(), true);
    t.chrome.storage.sync.get = realSync;
    assert.strictEqual(await t.loadHasAiProvider(), false, "no platforms saved");

    const calls = [];
    const [realRemove, realHas, realById] = [t.removePlayerAiQuickActionButton, t.hasPlayerSubtitleControl, t.byId];
    t.removePlayerAiQuickActionButton = () => calls.push("remove");
    t.hasPlayerSubtitleControl = () => (calls.push("mount"), false);
    const aiBtn = stubEl();
    aiBtn.hidden = false;
    t.byId = (id) => (id === "boc-reading-ai-btn" ? aiBtn : stubEl());
    for (const hasAiProvider of [false, true]) {
      state.settings = { enablePlayerAiQuickAction: true, hasAiProvider };
      state.readingViewOpen = false;
      calls.length = 0;
      t.syncPlayerAiQuickActionButton();
      assert.strictEqual(calls[0], hasAiProvider ? "mount" : "remove");
      t.applyReadingViewPresentation();
      assert.strictEqual(aiBtn.hidden, false, "the focus-mode AI button shows either way");
    }
    Object.assign(t, { removePlayerAiQuickActionButton: realRemove, hasPlayerSubtitleControl: realHas, byId: realById });
  }

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

  // The video page's note carries the video's 分拣 tags, like the note 分拣台 writes.
  {
    const was = { subtitleBody: state.subtitleBody, triageExtras: state.triageExtras, markdown: state.markdown };
    state.subtitleBody = [{ from: 0, to: 1, content: "a" }];
    state.triageExtras = t.BocNote.triageExtras({ triage_tags: [{ id: "t1", name: "入门 教程" }], triage_video_tags: { [state.videoId]: ["t1"] } }, { site: "bilibili", videoId: state.videoId, pageIndex: 2 });
    realRebuild();
    assert.match(state.markdown, /\ntags: \[[^\]\n]*"入门_教程"\]\n/);
    Object.assign(state, was);
  }

  // F1: a run the video change superseded fails late (timeout, 429, transcript); the new video keeps its state.
  {
    const saved = Object.fromEntries(["getSettings", "currentSite", "retryAsync", "fetchSubtitleBundle", "refreshDerivedContent"].map((k) => [k, t[k]]));
    Object.assign(t, { getSettings: async () => ({}), retryAsync: (f) => f(), refreshDerivedContent: async () => {} });
    const newVideo = { videoId: "BV_B", title: "B", subtitleBody: [{ from: 0, to: 1, content: "B" }], subtitleFetchState: "ready", subtitleFailure: "" };
    for (const step of ["meta", "subtitle"]) {
      let fail;
      const late = new Promise((_, reject) => (fail = reject));
      t.currentSite = () => ({
        parseRef: () => ({ site: "bilibili", id: "BV_A" }),
        readDom: () => ({}),
        fetchMeta: step === "meta" ? () => late : async () => ({ duration: 100, title: "A" })
      });
      t.fetchSubtitleBundle = () => late;
      const run = t.runRefreshClip();
      await settle();
      state.fetchRunId++; // the URL watcher saw the change
      Object.assign(state, newVideo);
      fail(new Error("请求超时"));
      await run;
      assert.deepStrictEqual(Object.fromEntries(Object.keys(newVideo).map((k) => [k, state[k]])), newVideo, `old ${step} failure`);
    }
    Object.assign(t, saved);
  }

  // G4: a refresh waiting for the player's metadata is dropped when the video changed during the wait.
  {
    const refreshed = [];
    t.settledClip = t.refreshClip = async () => refreshed.push(state.fetchRunId);
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

  // The one context message (side panel, player ✦): whatever the timing, it answers with the tab's video, settled,
  // and that video's comments.
  {
    const keep = ["currentSite", "getSettings", "retryAsync", "fetchSubtitleBundle", "fetchHotComments", "refreshDerivedContent", "sleep", "ensureUiReady", "enforceNormalPageStateIfNeeded", ...Object.keys(real)];
    const saved = Object.fromEntries(keep.map((k) => [k, t[k]]));
    const realUrl = t.location.href;
    Object.assign(t, real, { getSettings: async () => ({}), retryAsync: (f) => f(), refreshDerivedContent: async () => {}, sleep: async () => {}, ensureUiReady() {}, enforceNormalPageStateIfNeeded() {} });
    t.fetchSubtitleBundle = async () => ({ tracks: [], chapters: [] });
    const [A, B] = ["BV1GJ411x7h7", "BV1xx411c7mD"];
    const go = (id) => (t.location.href = `https://www.bilibili.com/video/${id}/`);
    let metaCalls = [];
    let metaGates = {}; // a video whose meta the test answers when it chooses; the others answer at once
    let commentsGate = null;
    t.currentSite = () => ({
      parseRef: (url) => t.BocSites.parseRef(url),
      readDom: () => ({}),
      fetchComments() {},
      fetchMeta: async (ref) => (metaCalls.push(ref.id), metaGates[ref.id] ? metaGates[ref.id].promise : { duration: 100, title: ref.id })
    });
    t.fetchHotComments = async () => {
      const of = state.videoId;
      await commentsGate?.promise;
      return [{ content: of }];
    };
    const ask = (refresh) => new Promise((resolve) => listeners.message.forEach((f) => f({ type: "sidepanel-get-context", refresh }, {}, resolve)));
    t.bindRuntimeEvents();
    go(A);
    Object.assign(state, { currentClipSignature: t.computeCurrentClipSignature(), videoId: "", refreshPromise: null });

    // Nothing loaded: the first ask starts a run; 刷新 meanwhile joins it.
    metaGates = { [A]: gate({ duration: 100, title: A }) };
    const first = ask(false);
    const forced = ask(true);
    await settle();
    metaGates[A].open();
    for (const r of await Promise.all([first, forced])) assert.strictEqual(r.payload.title, A);
    assert.deepStrictEqual(metaCalls, [A], "刷新 joins the run in flight");
    assert.deepStrictEqual(state.hotComments.map((c) => c.content), [A], "with the video's comments");
    await ask(false);
    assert.deepStrictEqual(metaCalls, [A], "a loaded video is not read again");

    // F2: the tab moves on mid-run and nothing restarts (focus mode is off): the ask gets the new video, not an empty ok.
    metaCalls = [];
    metaGates = { [A]: gate({ duration: 100, title: A }) };
    const superseded = ask(true);
    await settle();
    go(B);
    t.checkUrlChange();
    metaGates[A].open();
    const r = await superseded;
    assert.deepStrictEqual([r.ok, r.payload.title, r.payload.hotComments.map((c) => c.content)], [true, B, [B]]);

    // F3: the panel asks right after an in-site switch, before the URL watcher's next tick: the tab's video, read once.
    metaCalls = [];
    metaGates = {};
    go(A);
    assert.strictEqual((await ask(false)).payload.videoId, A, "not the video before");
    await ask(false); // the change's echo (boc-video-changed)
    assert.deepStrictEqual(metaCalls, [A], "meta read once");

    // The video changes while its comments load: the answer never pairs one video with another's comments.
    state.hotComments = [];
    commentsGate = gate();
    const mid = ask(false);
    await settle();
    go(B);
    t.checkUrlChange();
    commentsGate.open();
    const m = await mid;
    assert.deepStrictEqual([m.payload.videoId, m.payload.hotComments.map((c) => c.content)], [B, [B]]);
    t.location.href = realUrl;
    Object.assign(t, saved);
  }

  // G4: storage echoes for the old video stay out of the new one.
  {
    t.bindSettingsWatcher();
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

  // A seek from 分拣台 names its video: a frame on another video keeps quiet, so the panel never seeks the wrong one.
  {
    const video = { paused: true, currentTime: 0 };
    t.getRuntimeVideoElement = () => video;
    const seek = (videoId) => {
      let answered;
      for (const f of listeners.message) f({ type: "sidepanel-seek-video-time", seconds: 75, videoId }, {}, (r) => (answered = r));
      return answered;
    };
    assert.strictEqual(seek("BV1xx411c7mD"), undefined);
    assert.strictEqual(video.currentTime, 0, "another video's seek is ignored");
    assert.strictEqual(seek("BV1GJ411x7h7")?.ok, true);
    assert.strictEqual(video.currentTime, 75);
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

  // 跟随已停 shows after a manual scroll only while playing: a paused video sends no ticks to clear it. The scroll guard holds either way.
  {
    const attrs = {};
    const view = { getAttribute: (k) => attrs[k], setAttribute: (k, v) => (attrs[k] = v) };
    const realGet = t.document.getElementById;
    t.document.getElementById = () => view;
    state.readingAutoScroll = true;
    state.readingVideoEl = { paused: true };
    t.noteManualReaderInteraction();
    assert.ok(state.readingManualScrollPauseUntil > Date.now(), "the guard is set while paused");
    assert.strictEqual(attrs["data-boc-reader-follow"], "auto", "no hint while paused");
    state.readingVideoEl.paused = false;
    t.updateReaderFollowState();
    assert.strictEqual(attrs["data-boc-reader-follow"], "manual", "the hint shows once playing within the guard");
    t.document.getElementById = realGet;
    state.readingVideoEl = null;
    state.readingManualScrollPauseUntil = 0;
  }

  // An empty track followed by an HTTP failure still marks the error for the PO-token fallback.
  {
    const realLoad = t.loadSubtitle;
    const fails = [Object.assign(new Error("empty"), { code: "SUBTITLE_EMPTY" }), new Error("HTTP 404")];
    t.loadSubtitle = async () => {
      throw fails.shift();
    };
    await assert.rejects(t.tryLoadSubtitleCandidates([{ id: "1", url: "u1" }, { id: "2", url: "u2" }], state.fetchRunId), (e) => e.message === "HTTP 404" && e.anyEmpty === true);
    t.loadSubtitle = async () => {
      throw new Error("HTTP 404");
    };
    await assert.rejects(t.tryLoadSubtitleCandidates([{ id: "1", url: "u1" }], state.fetchRunId), (e) => e.anyEmpty === undefined);
    t.loadSubtitle = realLoad;
  }

  // A subtitle longer than the video (uploader's subtitle for a longer cut) is rejected per track, carried through
  // the candidate loop, and as the last resort shown with a warning but never cached.
  {
    state.videoDuration = 961;
    state.subtitles = [];
    t.currentSite = () => ({ parseSegments: () => [{ from: 0, to: 2, content: "嗨" }, { from: 1200, to: 1202, content: "拜拜" }] });
    const realSave = t.BocSites.subtitleCache.save;
    const saved = [];
    t.BocSites.subtitleCache.save = async (key) => saved.push(key);
    let mismatch;
    await assert.rejects(t.commitSubtitleBody("raw", { url: "u", lang: "中文", subtitleId: ".zh" }, state.fetchRunId), (e) => ((mismatch = e), e.code === "SUBTITLE_DURATION_MISMATCH"));

    const realLoad = t.loadSubtitle;
    const fails = [mismatch, new Error("HTTP 404")];
    t.loadSubtitle = async () => {
      throw fails.shift();
    };
    await assert.rejects(t.tryLoadSubtitleCandidates([{ id: ".zh", url: "u1" }, { id: ".en", url: "u2" }], state.fetchRunId), (e) => e.message === "HTTP 404" && t.subtitleMismatchOf(e) === mismatch);
    // A 429 on a later track still carries the mismatch, so the caller can fall back to it.
    const realSleep = t.sleep;
    t.sleep = async () => {};
    const limited = Object.assign(new Error("HTTP 429"), { status: 429 });
    fails.push(mismatch, limited, limited);
    await assert.rejects(t.tryLoadSubtitleCandidates([{ id: ".zh", url: "u1" }, { id: ".en", url: "u2" }], state.fetchRunId), (e) => e.status === 429 && t.subtitleMismatchOf(e) === mismatch);
    t.sleep = realSleep;
    t.loadSubtitle = realLoad;

    const track = await t.acceptMismatchedSubtitle(mismatch, state.fetchRunId);
    assert.strictEqual(track.id, ".zh");
    assert.strictEqual(state.subtitleBody.length, 2);
    assert.strictEqual(state.subtitleWarning, "字幕时间轴到 20:02，视频长 16:01，字幕时间可能对不上。");
    assert.deepStrictEqual(saved, [], "a mismatched body is not cached");
    // The side panel gets the warning too, and shows it with the reply (background.js buildAiMessages).
    assert.strictEqual(t.buildSidepanelContext().payload.subtitleWarning, state.subtitleWarning);
    t.BocSites.subtitleCache.save = realSave;
  }

  // S1: autoplay changes the video while the overwrite dialog is open. Nothing is written and the user is told;
  // on the same video the note gets the content taken before the dialog, even if state was reset meanwhile.
  {
    const realUrl = t.location.href;
    const saved = Object.fromEntries(["getSettings", "refreshDerivedContent", "sendRuntimeMessage", "confirmOverwriteNote", "setMessage", "computeCurrentClipSignature"].map((k) => [k, t[k]]));
    const settings = { ...vm.runInContext("DEFAULT_SETTINGS", ctx), obsidianEnabled: true, obsidianApiKey: "k" };
    let sent, messages, onDialog;
    Object.assign(t, {
      getSettings: async () => settings,
      refreshDerivedContent: async () => (state.markdown = "# 视频 A"),
      confirmOverwriteNote: async () => (onDialog(), "full"),
      setMessage: (text) => messages.push(text),
      // An earlier test stubs it; the clip is the page address.
      computeCurrentClipSignature: () => t.location.href
    });
    Object.assign(state, { site: "bilibili", videoId: "BV1GJ411x7h7", cid: "1", title: "A" });
    for (const switched of [true, false]) {
      [sent, messages] = [[], []];
      let written = null;
      t.sendRuntimeMessage = async (m) => (sent.push(m.type), m.type === "write-obsidian-note" && (written = m.content), m.type === "obsidian-note-exists" ? { ok: true, exists: true } : { ok: true });
      onDialog = () => {
        state.markdown = "";
        if (switched) t.location.href = "https://www.bilibili.com/video/BV1xx411c7mD/";
      };
      const reply = await t.sendToObsidian();
      t.location.href = realUrl;
      // The side panel goes on to the AI 问答 section only after a write.
      assert.strictEqual(reply?.written, switched ? false : undefined);
      if (switched) {
        assert.deepStrictEqual(sent, ["obsidian-note-exists"], "no write after the video changed");
        assert.strictEqual(messages.at(-1), "视频已切换，未写入 Obsidian。");
      } else {
        assert.strictEqual(written, "# 视频 A", "the content taken before the dialog");
      }
    }
    // 取消 writes nothing and tells the side panel so.
    [sent, messages] = [[], []];
    t.confirmOverwriteNote = async () => "";
    assert.deepStrictEqual({ ...(await t.sendToObsidian()) }, { written: false });
    assert.deepStrictEqual([sent, messages.at(-1)], [["obsidian-note-exists"], "已取消写入 Obsidian，原笔记未被覆盖。"]);
    // A failed write answers the popup and the side panel with the reason and code, not a success.
    t.sendRuntimeMessage = async () => ({ ok: false, error: t.BocErrors.TEXT.obsidianDown, code: "OBSIDIAN_DOWN" });
    assert.deepStrictEqual({ ...(await t.sendToObsidian()) }, { ok: false, error: t.BocErrors.TEXT.obsidianDown, code: "OBSIDIAN_DOWN" });
    Object.assign(t, saved);
  }

  // N6: what the user reads for a failed fetch: risk control and a dropped connection in words, no codes.
  assert.strictEqual(t.fetchErrorText(Object.assign(new Error("请求失败：412"), { status: 412 })), "B站限流，请稍后再试");
  assert.strictEqual(t.fetchErrorText(Object.assign(new Error("风控校验失败"), { code: -352 })), "B站限流，请稍后再试");
  assert.strictEqual(t.fetchErrorText(new TypeError("Failed to fetch")), "网络断了");
  assert.strictEqual(t.fetchErrorText(Object.assign(new Error("啥都木有"), { code: -404 })), "啥都木有");
  assert.strictEqual(t.fetchErrorText(Object.assign(new Error("稿件审核中"), { code: 62004 })), "视频审核中，过后再试", "BocErrors' words, as elsewhere");
  // X8: risk control is not retried (that only digs deeper); a dropped connection or another negative code still is.
  {
    const tries = async (error) => {
      let n = 0;
      await t.retryAsync(async () => {
        if (++n === 1) throw error;
      }, 2, 0).catch(() => {});
      return n;
    };
    // sites.js marks every negative B站 code retryable; risk codes stop here all the same.
    for (const code of [-352, -412, -799, -509]) assert.strictEqual(await tries(Object.assign(new Error("x"), { code, retryable: true })), 1, String(code));
    assert.strictEqual(await tries(Object.assign(new Error("请求失败：412"), { status: 412 })), 1, "HTTP 412");
    assert.strictEqual(await tries(new TypeError("Failed to fetch")), 2, "a dropped connection is retried");
    assert.strictEqual(await tries(Object.assign(new Error("x"), { code: -500, retryable: true })), 2);
  }

  // The video's subtitle names, chapter titles and subtitle lines come from the site.
  {
    const saved = Object.fromEntries(["subtitles", "chapters", "subtitleBody"].map((k) => [k, state[k]]));
    const after = ["updateReaderChapterPresence", "renderReadingInfoPanel", "renderReadingSubtitleSelect", "renderReaderPanels", "applyReadingViewPresentation", "updateReadingTranscriptTailSpacer"];
    const real = after.map((f) => t[f]);
    after.forEach((f) => (t[f] = () => {}));
    const realById = t.byId;
    for (const bad of XSS) {
      state.subtitles = [{ url: bad, id: bad, label: bad, lang: bad }];
      const select = {};
      t.renderSubtitleOptions(select);
      assertInert(select.innerHTML, "subtitle options");
      const nodes = {};
      t.byId = (id) => (nodes[id] ||= { insertAdjacentHTML() {} });
      state.chapters = [{ from: 0, title: bad }];
      state.subtitleBody = [{ from: 0, to: 1, content: bad }];
      realRenderReadingView();
      const ids = vm.runInContext("ids", ctx);
      for (const id of [ids.readingChapterList, ids.readingTranscriptList]) assertInert(nodes[id].innerHTML, id);
    }
    t.byId = realById;
    after.forEach((f, i) => (t[f] = real[i]));
    Object.assign(state, saved);
  }

  console.log("content selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
