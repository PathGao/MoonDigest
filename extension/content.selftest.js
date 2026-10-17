// node extension/content.selftest.js
if (process.versions.bun) (console.error("This selftest needs Node: it fails or hangs under bun (see 自检 in README.md)."), process.exit(1));
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// content.js is a page script: lift its body out of the run-once block, drop init(), stub the DOM, and drive the
// async flows by hand. Top-level functions are then globals, so a test can stand in for the DOM-heavy ones.
const lines = fs.readFileSync(path.join(__dirname, "content.js"), "utf8").replace(/\s+$/, "").split("\n");
const runGate = lines[5].match(/^if \((.*)\) \{$/)?.[1];
assert.ok(runGate?.startsWith("!globalThis.__MDG_CONTENT_SCRIPT_LOADED__"), "harness lifts the run-once block");
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
// Without init(). Startup is scripts/smoke.mjs's job.
const source = lines.slice(6, -1).join("\n").replace(/^init\(\);$/m, "");
// How a subtitle is picked, fetched, checked, and what is a failure or a limit lives once, in sites.js
// (MdgSites.loadSubtitle / loadFirstTrack); the page only wraps its fetches and shows the result.
for (const own of [/function (loadSubtitle|loadFirstTrack|tryLoadSubtitleCandidates|fetchRawCached)\(/, /validateSubtitleByDuration|rankTracks|pickPreferredTrack|fetchTranscript/]) {
  assert.doesNotMatch(source, own, "content.js has its own subtitle pipeline");
}

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
const real = Object.fromEntries(["checkUrlChange", "resetClipState", "computeCurrentClipSignature", "refreshClip", "settledClip", "getSettings", "refreshDerivedContent", "retryAsync", "runRefreshClip", "ensureReaderPlayerMounted", "maybeRefreshReaderSubtitleInBackground"].map((k) => [k, t[k]]));
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
    t.byId = (id) => (id === "mdg-reading-ai-btn" ? aiBtn : stubEl());
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

  // G4: the video changes while a subtitle body is being fetched; the old body must not land under the new video.
  {
    state.videoDuration = 100;
    state.subtitleBody = [];
    state.subtitles = [{ id: "1", url: "u" }];
    const body = gate("raw");
    t.currentSite = () => ({ fetchRaw: () => body.promise, parseSegments: () => [{ from: 0, to: 1, content: "旧视频" }] });
    const switching = t.switchSubtitle("u");
    await settle();
    state.fetchRunId++;
    body.open();
    await assert.rejects(switching, (e) => e.message === "视频已切换，请刷新网页后重试");
    assert.deepStrictEqual(state.subtitleBody, [], "the new video keeps an empty body");
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
    state.triageExtras = t.MdgNote.triageExtras({ triage_tags: [{ id: "t1", name: "入门 教程" }], triage_video_tags: { [state.videoId]: ["t1"] } }, { site: "bilibili", videoId: state.videoId, pageIndex: 2 });
    realRebuild();
    assert.match(state.markdown, /\ntags: \[[^\]\n]*"入门_教程"\]\n/);
    Object.assign(state, was);
  }

  // F1: a run the video change superseded fails late (timeout, 429, transcript); the new video keeps its state.
  {
    const saved = Object.fromEntries(["getSettings", "currentSite", "retryAsync", "refreshDerivedContent"].map((k) => [k, t[k]]));
    Object.assign(t, { getSettings: async () => ({}), retryAsync: (f) => f(), refreshDerivedContent: async () => {} });
    const newVideo = { videoId: "BV_B", title: "B", subtitleBody: [{ from: 0, to: 1, content: "B" }], subtitleFetchState: "ready", subtitleFailure: "" };
    for (const step of ["meta", "subtitle"]) {
      let fail;
      const late = new Promise((_, reject) => (fail = reject));
      t.currentSite = () => ({
        parseRef: () => ({ site: "bilibili", id: "BV_A" }),
        readDom: () => ({}),
        fetchMeta: step === "meta" ? () => late : async () => ({ duration: 100, title: "A" }),
        fetchTracks: () => late
      });
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

  // V6: a video change in 专注模式 reads the new video at once, without waiting for the player to report a duration.
  // Until its info is read the title is the same video's for another part, else none (the page may still show the last one).
  // Entering 专注模式 joins the read in flight or reads a video not read yet; it never forces a reread of a video
  // already read without subtitles. Only 刷新 does.
  {
    const prev = Object.fromEntries(["settledClip", "refreshClip", "ensureUiReady", "enforceNormalPageStateIfNeeded", "resetClipState", "computeCurrentClipSignature"].map((k) => [k, t[k]]));
    const forces = [];
    t.settledClip = async (force) => forces.push(force);
    state.subtitleBody = [];
    t.maybeRefreshReaderSubtitleInBackground();
    assert.deepStrictEqual(forces, [false], "entering 专注模式 reads at once and does not force a reread");

    const refreshed = [];
    t.refreshClip = async () => refreshed.push(state.title);
    for (const f of ["ensureUiReady", "enforceNormalPageStateIfNeeded"]) t[f] = () => {};
    t.resetClipState = () => Object.assign(state, { videoId: "", title: "" });
    let sig = 0;
    t.computeCurrentClipSignature = () => `clip${++sig}`;
    t.stepReader("mark");
    t.stepReader("enter");
    for (const id of ["BV1GJ411x7h7", "BV1xx411c7mD"]) {
      Object.assign(state, { videoId: "BV1GJ411x7h7", title: "A" });
      t.location.href = `https://www.bilibili.com/video/${id}/?p=2`;
      t.checkUrlChange();
    }
    assert.deepStrictEqual(refreshed, ["A", ""], "read at once, with the title it has");
    t.stepReader("close");
    t.location.href = "https://www.bilibili.com/video/BV1GJ411x7h7/";
    Object.assign(t, prev);
  }

  // V2: 专注模式 shows the transcript once it is here; only the note waits for the hot comments.
  {
    const prev = Object.fromEntries(["refreshDerivedContent", "renderReadingView", "moveReadingMainInline", "startReaderPlayerObserver"].map((k) => [k, t[k]]));
    const comments = gate();
    let drawn = 0;
    Object.assign(t, { refreshDerivedContent: () => comments.promise, renderReadingView: () => drawn++, moveReadingMainInline() {}, startReaderPlayerObserver() {} });
    t.stepReader("mark");
    t.stepReader("enter");
    const shown = t.showSubtitle({ track: { url: "u", lang: "zh" }, body: [{ from: 0, to: 1, content: "x" }] }, state.fetchRunId);
    assert.strictEqual(drawn, 1, "drawn before the comments are read");
    comments.open();
    await shown;
    t.stepReader("close");
    Object.assign(t, prev);
  }

  // V3: right after our own scroll, only a bare scroll event is taken for ours; wheel, touch and keys are the reader's.
  // A shorter scroll started meanwhile does not cut the window short.
  {
    const prev = t.noteManualReaderInteraction;
    const seen = [];
    const on = {};
    t.noteManualReaderInteraction = () => seen.push("manual");
    t.bindReaderManualScroll({ addEventListener: (type, f) => (on[type] = f) });
    state.readingProgrammaticScrollUntil = 0;
    t.guardProgrammaticScroll(800);
    t.guardProgrammaticScroll(120);
    assert.ok(state.readingProgrammaticScrollUntil > Date.now() + 500, "the longer window holds");
    on.scroll();
    assert.deepStrictEqual(seen, [], "our own scroll is not the reader's");
    for (const type of ["wheel", "touchstart", "keydown"]) on[type]();
    assert.strictEqual(seen.length, 3, "input inside the window still counts");
    state.readingProgrammaticScrollUntil = 0;
    on.scroll();
    assert.strictEqual(seen.length, 4, "a scroll after the window counts");
    t.noteManualReaderInteraction = prev;
  }

  // V7: a new chapter scrolls the chapter rail sideways only, never the page.
  {
    const prev = t.byId;
    const calls = [];
    const rail = { scrollLeft: 50, getBoundingClientRect: () => ({ left: 0, right: 300 }), scrollTo: (o) => calls.push(o) };
    t.byId = () => rail;
    const chapter = (left) => ({ getBoundingClientRect: () => ({ left, right: left + 100 }), scrollIntoView: () => calls.push("page") });
    t.scrollReadingRailItemIntoView(chapter(100));
    t.scrollReadingRailItemIntoView(chapter(250));
    t.scrollReadingRailItemIntoView(chapter(-30));
    assert.strictEqual(JSON.stringify(calls), JSON.stringify([{ left: 100, behavior: "smooth" }, { left: 20, behavior: "smooth" }]));
    t.byId = prev;
  }

  // A4: a jump from a 专注模式 subtitle row or chapter keeps a paused video paused, like the side panel's timestamps.
  {
    const prev = t.bindReadingViewVideo;
    let plays = 0;
    const video = { paused: true, currentTime: 0, play: () => (plays++, Promise.resolve()) };
    t.bindReadingViewVideo = () => video;
    t.jumpReadingTarget(42);
    assert.strictEqual(video.currentTime, 42);
    assert.strictEqual(plays, 0, "a paused video stays paused after a jump");
    t.bindReadingViewVideo = prev;
  }

  // The one context message (side panel, player ✦): whatever the timing, it answers with the tab's video, settled,
  // and that video's comments.
  {
    const keep = ["currentSite", "getSettings", "retryAsync", "fetchHotComments", "refreshDerivedContent", "sleep", "ensureUiReady", "enforceNormalPageStateIfNeeded", ...Object.keys(real)];
    const saved = Object.fromEntries(keep.map((k) => [k, t[k]]));
    const realUrl = t.location.href;
    Object.assign(t, real, { getSettings: async () => ({}), retryAsync: (f) => f(), refreshDerivedContent: async () => {}, sleep: async () => {}, ensureUiReady() {}, enforceNormalPageStateIfNeeded() {} });
    const [A, B] = ["BV1GJ411x7h7", "BV1xx411c7mD"];
    const go = (id) => (t.location.href = `https://www.bilibili.com/video/${id}/`);
    let metaCalls = [];
    let metaGates = {}; // a video whose meta the test answers when it chooses; the others answer at once
    let commentsGate = null;
    t.currentSite = () => ({
      parseRef: (url) => t.MdgSites.parseRef(url),
      readDom: () => ({}),
      fetchComments() {},
      fetchTracks: async () => ({ tracks: [], chapters: [] }),
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
    const fresh = ask(false);
    await settle();
    assert.deepStrictEqual(metaCalls, [A, B], "an ask after the change does not wait for the old run");
    metaGates[A].open();
    for (const r of await Promise.all([superseded, fresh])) assert.deepStrictEqual([r.ok, r.payload.title, r.payload.hotComments.map((c) => c.content)], [true, B, [B]]);
    assert.deepStrictEqual(metaCalls, [A, B], "and B is read once");

    // F3: the panel asks right after an in-site switch, before the URL watcher's next tick: the tab's video, read once.
    metaCalls = [];
    metaGates = {};
    go(A);
    assert.strictEqual((await ask(false)).payload.videoId, A, "not the video before");
    await ask(false); // the change's echo (mdg-video-changed)
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
    for (const f of listeners.storage) f({ [t.MdgLimits.KEYS.aiConversations]: {} }, "local");
    state.fetchRunId++;
    turns.open();
    await settle();
    assert.deepStrictEqual(state.aiTurns, [], "a storage echo for the old video is dropped");
  }

  // B2: the popup's 下载 .md takes the note's own name: date prefix by the setting, 分 P like 写入 Obsidian.
  {
    const next = { title: "标题", videoId: "BV1", pageCount: 3, pageIndex: 2, pageTitle: "第二集", settings: { ...t.MdgSettings.DEFAULTS, includeDateInFilename: false } };
    const prev = Object.fromEntries(Object.keys(next).map((k) => [k, state[k]]));
    Object.assign(state, next);
    assert.strictEqual(t.getPopupPayload().filename, "标题-P2-第二集.md");
    Object.assign(state, prev);
  }

  // A5: a note setting (附带热门评论, 笔记属性, 笔记标签…) changed elsewhere reloads the settings and rebuilds the note, so
  // the popup's copy and download and the side panel read what 写入 Obsidian would write.
  {
    const prev = [t.getSettings, t.refreshDerivedContent];
    let rebuilt = 0;
    t.getSettings = async () => ({ ...t.MdgSettings.DEFAULTS, tags: "新标签" });
    t.refreshDerivedContent = async () => rebuilt++;
    state.markdown = "md";
    for (const f of listeners.storage) f({ tags: { newValue: "新标签" } }, "sync");
    await settle();
    assert.strictEqual(state.settings.tags, "新标签", "a note setting change reloads the settings");
    assert.strictEqual(rebuilt, 1, "and rebuilds the note");
    for (const f of listeners.storage) f({ someoneElsesKey: {} }, "sync");
    await settle();
    assert.strictEqual(rebuilt, 1, "a sync key that is not a setting changes nothing");
    [t.getSettings, t.refreshDerivedContent] = prev;
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

  // 分拣台's side panel asks a viewer frame for the video it names: a frame that autoplayed on to another one keeps quiet,
  // so the panel reads the named video like a closed page's instead of taking this one.
  {
    const realClip = t.clipContext;
    t.clipContext = async () => ({ ok: true, payload: { videoId: "BV1GJ411x7h7" } });
    const ask = (videoId) => new Promise((resolve) => {
      const kept = listeners.message.map((f) => f({ type: "sidepanel-get-context", videoId }, {}, resolve));
      if (!kept.includes(true)) resolve("no answer");
    });
    assert.strictEqual(await ask("BV1xx411c7mD"), "no answer");
    assert.strictEqual((await ask("BV1GJ411x7h7")).payload.videoId, "BV1GJ411x7h7");
    t.clipContext = realClip;
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

  // 跟随已停 shows after a manual scroll only while playing. Following stays off while the reader is away from the
  // playing line, however long; it resumes once the line is back in view and the reader has let go, or at 回到当前.
  {
    const attrs = {};
    const view = { getAttribute: (k) => attrs[k], setAttribute: (k, v) => (attrs[k] = v) };
    const prev = [t.document.getElementById, t.readingActiveLineInView];
    t.document.getElementById = () => view;
    let inView = false;
    t.readingActiveLineInView = () => inView;
    state.readingAutoScroll = true;
    state.readingVideoEl = { paused: true };
    t.noteManualReaderInteraction();
    assert.ok(state.readingFollowPaused, "paused while the video is paused too");
    assert.strictEqual(attrs["data-mdg-reader-follow"], "auto", "no hint while paused");
    state.readingVideoEl.paused = false;
    t.updateReaderFollowState();
    assert.strictEqual(attrs["data-mdg-reader-follow"], "manual", "the hint shows once playing");
    state.readingLastInputAt = Date.now() - 600000;
    assert.strictEqual(t.readerFollowHeld(), true, "reading back for ten minutes is not cut short");
    inView = true;
    state.readingLastInputAt = Date.now();
    assert.strictEqual(t.readerFollowHeld(), true, "not while the reader is still at it");
    state.readingLastInputAt = Date.now() - 2000;
    assert.strictEqual(t.readerFollowHeld(), false, "back in view and let go: following resumes");
    t.updateReaderFollowState();
    assert.strictEqual(attrs["data-mdg-reader-follow"], "auto");
    state.readingAutoScroll = false;
    t.noteManualReaderInteraction();
    assert.strictEqual(state.readingFollowPaused, false, "with 跟随 off nothing pauses");
    state.readingAutoScroll = true;
    [t.document.getElementById, t.readingActiveLineInView] = prev;
    state.readingVideoEl = null;
  }

  // The page's reads under the shared subtitle step (which tracks, in what order, what counts as a limit is
  // sites.selftest.js): a rate-limited file waits once, then the limit reads as one; B站's empty list is asked again
  // once; a logged-out answer from the background is asked again with the page's cookies.
  {
    const was = Object.fromEntries(["sleep", "retryAsync"].map((k) => [k, t[k]]));
    Object.assign(t, { sleep: async () => {}, retryAsync: (f) => f() });
    const limited = () => Object.assign(new Error("请求失败：429"), { status: 429 });
    const answers = (list) => async () => {
      const next = list.shift();
      if (next instanceof Error) throw next;
      return next;
    };
    let site = t.pageSubtitleSite({ fetchRaw: answers([limited(), "raw"]) }, state.fetchRunId);
    assert.strictEqual(await site.fetchRaw({}, {}), "raw");
    site = t.pageSubtitleSite({ fetchRaw: answers([limited(), limited()]) }, state.fetchRunId);
    await assert.rejects(site.fetchRaw({}, {}), (e) => e.status === 429 && e.message === "字幕接口限流（429），稍后再试");
    // B站's 429 is its limit, said as THROTTLED by sites.js biliJson: waited on once, then passed on as it is.
    const biliLimited = () => Object.assign(new Error(t.MdgErrors.TEXT.biliThrottled), { code: "THROTTLED", status: 429 });
    site = t.pageSubtitleSite({ id: "bilibili", fetchRaw: answers([biliLimited(), "raw"]) }, state.fetchRunId);
    assert.strictEqual(await site.fetchRaw({}, {}), "raw");
    site = t.pageSubtitleSite({ id: "bilibili", fetchRaw: answers([biliLimited(), biliLimited()]) }, state.fetchRunId);
    await assert.rejects(site.fetchRaw({}, {}), (e) => e.code === "THROTTLED" && e.message === t.MdgErrors.TEXT.biliThrottled);
    site = t.pageSubtitleSite({ id: "bilibili", fetchTracks: answers([{ tracks: [] }, { tracks: ["t"] }]) }, state.fetchRunId);
    assert.deepStrictEqual((await site.fetchTracks()).tracks, ["t"]);
    const ios = [];
    site = t.pageSubtitleSite({ id: "bilibili", fetchTracks: async (ref, meta, io) => (ios.push(io.fetchJson), ios.length === 1 ? { tracks: [], needLogin: true } : { tracks: ["t"] }) }, state.fetchRunId);
    assert.deepStrictEqual((await site.fetchTracks({}, {}, { fetchJson: "background" })).tracks, ["t"]);
    assert.deepStrictEqual(ios, ["background", t.fetchJson]);
    Object.assign(t, was);
  }

  // A subtitle longer than the video (uploader's subtitle for a longer cut) is shown with a warning, on first load and
  // when switching (popup and focus mode alike), and never cached. A track of a video no longer shown is refused.
  {
    const keep = Object.fromEntries(["currentSite", "getSettings", "retryAsync", "refreshDerivedContent", "renderReadingSubtitleSelect"].map((k) => [k, t[k]]));
    const was = Object.fromEntries(["subtitles", "subtitleBody", "subtitleWarning", "videoId"].map((k) => [k, state[k]]));
    const realSet = t.chrome.storage.local.set;
    const saved = [];
    t.chrome.storage.local.set = async (items) => saved.push(...Object.keys(items));
    const warning = "字幕时间轴到 20:02，视频长 16:01，字幕时间可能对不上。";
    let loads = 0;
    t.currentSite = () => ({
      parseRef: () => ({ site: "bilibili", id: "BV_A" }),
      readDom: () => ({}),
      fetchMeta: async () => ({ duration: 961, title: "A" }),
      fetchTracks: async () => ({ tracks: [{ id: ".zh", url: "u1", label: "中文" }] }),
      fetchRaw: async () => (loads++, "raw"),
      parseSegments: () => [{ from: 0, to: 2, content: "嗨" }, { from: 1200, to: 1202, content: "拜拜" }]
    });
    Object.assign(t, { getSettings: async () => ({}), retryAsync: (f) => f(), refreshDerivedContent: async () => {} });
    await t.runRefreshClip();
    assert.deepStrictEqual([state.selectedSubtitleId, state.subtitleBody.length, state.subtitleWarning, state.subtitleFetchState], [".zh", 2, warning, "ready"]);
    // The side panel gets the warning too, and shows it with the reply (background.js buildAiMessages).
    assert.strictEqual(t.buildSidepanelContext().payload.subtitleWarning, warning);
    // L6: the side panel gets the note it sends the AI, not the subtitle array or the track list (nobody reads them).
    assert.ok(!["subtitleBody", "subtitleOptions"].some((k) => k in t.buildSidepanelContext().payload));
    // B站's logged-out list: 未登录 is its own state, not a failure reason, and the side panel hears it as such.
    {
      const site = t.currentSite;
      t.currentSite = () => ({ ...site(), fetchTracks: async () => ({ tracks: [], needLogin: true }) });
      await t.runRefreshClip();
      const sent = t.buildSidepanelContext().payload;
      assert.deepStrictEqual([state.subtitleFailure, sent.subtitleFailure, sent.subtitleNeedLogin], ["", "", true]);
      // J9: the last read's mismatch warning is gone; logged in again, 未登录 and the old comments are gone too.
      assert.strictEqual(state.subtitleWarning, "", "a read without a subtitle keeps no warning");
      assert.strictEqual(t.getPopupPayload().subtitleMissing, "未登录 B站，拿不到字幕");
      t.currentSite = site;
      state.hotComments = [{ content: "旧评论" }];
      await t.runRefreshClip();
      assert.deepStrictEqual([state.subtitleNeedLogin, state.subtitleFailure, state.hotComments.length], [false, "", 0], "a new read starts clean");
    }
    // J11: while a read runs, and after it failed (a limit), the dropdown never says 视频没有字幕.
    {
      const was = Object.fromEntries(["subtitleFetchState", "subtitles"].map((k) => [k, state[k]]));
      state.subtitles = [];
      for (const [phase, words] of [["loading", t.MdgErrors.TEXT.subtitleReading], ["error", t.MdgErrors.TEXT.videoReadFailed]]) {
        state.subtitleFetchState = phase;
        const select = {};
        t.renderSubtitleOptions(select);
        assert.deepStrictEqual([select.innerHTML, t.getPopupPayload().subtitleMissing], [`<option value="">${words}</option>`, words], phase);
      }
      Object.assign(state, was);
    }
    // G1: a limit is no subtitle failure: the read fails (red, 重试), no note or comment read, nothing says 字幕抓取失败.
    {
      const site = t.currentSite;
      const derived = t.refreshDerivedContent;
      let derives = 0;
      t.refreshDerivedContent = async () => derives++;
      t.currentSite = () => ({ ...site(), fetchRaw: async () => Promise.reject(Object.assign(new Error(t.MdgErrors.TEXT.biliThrottled), { code: "THROTTLED" })) });
      await assert.rejects(t.runRefreshClip(), (e) => e.code === "THROTTLED");
      assert.deepStrictEqual([state.subtitleFetchState, state.subtitleFailure, derives], ["error", "", 0]);
      assert.strictEqual(t.fetchErrorText({ code: "THROTTLED", message: "x" }), t.MdgErrors.TEXT.biliThrottled);
      // 重试 then reads it whole and builds the normal note.
      t.currentSite = site;
      await t.runRefreshClip();
      assert.deepStrictEqual([state.subtitleFetchState, derives], ["ready", 1]);
      t.refreshDerivedContent = derived;
    }

    loads = 0;
    const popupSelect = (url) => new Promise((resolve) => listeners.message.forEach((f) => f({ type: "popup-select-subtitle", url }, {}, resolve)));
    state.subtitles = [{ id: ".zh", url: "u1" }];
    const gone = await popupSelect("old-video-track");
    assert.deepStrictEqual([gone.ok, gone.error, loads], [false, "视频已切换，请刷新网页后重试", 0], "F4");
    // F4 again in focus mode: the dropdown goes back to what is shown.
    let redrawn = 0;
    t.renderReadingSubtitleSelect = () => redrawn++;
    const pick = (url) => t.onReadingSubtitleChange({ target: { selectedIndex: 0, options: [{ value: url, dataset: { lang: "英文", id: ".en" } }] } });
    await pick("old-video-track");
    assert.deepStrictEqual([loads, redrawn], [0, 1]);

    for (const how of ["popup", "focus mode"]) {
      Object.assign(state, { subtitles: [{ id: ".zh", url: "u1" }, { id: ".en", url: "u2" }], subtitleBody: [], subtitleWarning: "" });
      const resp = how === "popup" ? await popupSelect("u2") : await pick("u2");
      if (resp) assert.strictEqual(resp.ok, true);
      assert.deepStrictEqual([state.selectedSubtitleId, state.subtitleBody.length, state.subtitleWarning], [".en", 2, warning], how);
    }
    assert.deepStrictEqual(saved, [], "a mismatched body is not cached");
    t.chrome.storage.local.set = realSet;
    Object.assign(t, keep);
    Object.assign(state, was);
  }

  // 写入 Obsidian: the background answers ask for an existing note; the page's dialog picks the mode it sends again.
  // S1: autoplay changes the video while the dialog is open, so nothing is sent again; 取消 sends nothing again either.
  {
    const realUrl = t.location.href;
    const saved = Object.fromEntries(["getSettings", "refreshDerivedContent", "sendRuntimeMessage", "confirmOverwriteNote", "setMessage", "computeCurrentClipSignature"].map((k) => [k, t[k]]));
    const settings = { ...vm.runInContext("DEFAULT_SETTINGS", ctx), obsidianEnabled: true };
    let sent, messages, onDialog, choice;
    Object.assign(t, {
      getSettings: async () => settings,
      refreshDerivedContent: async () => (state.markdown = "# 视频 A"),
      confirmOverwriteNote: async (path, opts) => (onDialog(path, opts), choice),
      setMessage: (text) => messages.push(text),
      // An earlier test stubs it; the clip is the page address.
      computeCurrentClipSignature: () => t.location.href,
      sendRuntimeMessage: async (m) => (sent.push(m), m.mode ? { ok: true, path: "p.md", kind: "ai", text: "已更新 AI 问答：p.md" } : { ok: true, ask: true, path: "p.md", hasAiSection: true })
    });
    Object.assign(state, { site: "bilibili", videoId: "BV1GJ411x7h7", cid: "1", title: "A" });
    const modes = () => sent.map((m) => [m.type, m.mode, m.page.markdown]);
    for (const [switched, pick] of [[true, "full"], [false, ""], [false, "ai"]]) {
      [sent, messages, choice] = [[], [], pick];
      let asked;
      onDialog = (path, opts) => {
        asked = [path, opts.hasAiSection];
        state.markdown = "";
        if (switched) t.location.href = "https://www.bilibili.com/video/BV1xx411c7mD/";
      };
      const reply = await t.sendToObsidian();
      t.location.href = realUrl;
      assert.deepStrictEqual(asked, ["p.md", true]);
      if (switched || !pick) {
        // The popup learns nothing was written.
        assert.deepStrictEqual([{ ...reply }, modes()], [{ ok: true, written: false, text: switched ? t.MdgErrors.TEXT.obsidianVideoSwitched : t.MdgErrors.TEXT.obsidianCancelled }, [["write-video-note", undefined, "# 视频 A"]]]);
      } else {
        // The same note, taken before the dialog, with the mode; the background's words are shown.
        assert.deepStrictEqual(modes(), [["write-video-note", undefined, "# 视频 A"], ["write-video-note", "ai", "# 视频 A"]]);
        assert.deepStrictEqual({ ...reply }, { ok: true, text: "已更新 AI 问答：p.md" });
      }
      // J10: the result is the reply's (and the page's), never the popup's status line the next popup shows again.
      assert.deepStrictEqual(messages, [], "写入 Obsidian writes nothing into the popup's status");
    }
    // G3: the note goes with its subtitle state, which the background's result starts with.
    [sent, messages, choice] = [[], [], ""];
    Object.assign(state, { subtitleFailure: "网络断了", subtitleNeedLogin: false, subtitleWarning: "" });
    await t.sendToObsidian();
    assert.strictEqual(sent[0].page.warning, "字幕抓取失败：网络断了。");
    state.subtitleFailure = "";
    // A failed write answers the popup and the side panel with the reason and code, not a success.
    t.sendRuntimeMessage = async () => ({ ok: false, error: t.MdgErrors.TEXT.obsidianDown, code: "OBSIDIAN_DOWN" });
    assert.deepStrictEqual({ ...(await t.sendToObsidian()) }, { ok: false, text: `${t.MdgErrors.TEXT.obsidianFailed}：${t.MdgErrors.TEXT.obsidianDown}`, error: t.MdgErrors.TEXT.obsidianDown, code: "OBSIDIAN_DOWN" });
    assert.deepStrictEqual(messages, []);
    Object.assign(t, saved);
  }

  // N6: what the user reads for a failed fetch: risk control and a dropped connection in words, no codes.
  // HTTP 412 and the risk codes are THROTTLED by then (sites.js biliJson, the background's fetch-json).
  assert.strictEqual(t.fetchErrorText(Object.assign(new Error("请求失败：412"), { code: "THROTTLED" })), "B站限流，请稍后再试");
  assert.strictEqual(t.fetchErrorText(new TypeError("Failed to fetch")), "网络断了");
  assert.strictEqual(t.fetchErrorText(Object.assign(new Error("啥都木有"), { code: -404 })), "啥都木有");
  assert.strictEqual(t.fetchErrorText(Object.assign(new Error("稿件审核中"), { code: 62004 })), "视频审核中，过后再试", "MdgErrors' words, as elsewhere");
  // X8: risk control is not retried (that only digs deeper); a dropped connection or another negative code still is.
  {
    const tries = async (error) => {
      let n = 0;
      await t.retryAsync(async () => {
        if (++n === 1) throw error;
      }, 2, 0).catch(() => {});
      return n;
    };
    // A limit (THROTTLED, HTTP 429) stops here even when marked retryable.
    assert.strictEqual(await tries(Object.assign(new Error("x"), { code: "THROTTLED", retryable: true })), 1, "THROTTLED");
    assert.strictEqual(await tries(Object.assign(new Error("请求失败：429"), { status: 429 })), 1, "HTTP 429");
    assert.strictEqual(await tries(new TypeError("Failed to fetch")), 2, "a dropped connection is retried");
    assert.strictEqual(await tries(Object.assign(new Error("x"), { code: -500, retryable: true })), 2);
    // D2: the background's fetch-json says 网络断了 (code NETWORK) like 分拣台, and the page's own timeout says the same.
    const net = t.MdgErrors.netTimeout(t.MdgErrors.NET_TIMEOUT_MS);
    assert.strictEqual(net, "网络断了：30 秒没有回应");
    assert.strictEqual(await tries(Object.assign(new Error(net), { code: "NETWORK" })), 2, "the background's 网络断了 is retried");
    const savedSend = t.sendRuntimeMessage;
    t.sendRuntimeMessage = async () => ({ ok: false, error: "B站请求失败 HTTP 412", code: "THROTTLED", status: 412 });
    await assert.rejects(t.fetchJsonInBackground("https://api.bilibili.com/x"), (e) => e.code === "THROTTLED" && e.status === 412);
    t.sendRuntimeMessage = savedSend;
    assert.match(source, /AbortSignal\.timeout\(MdgErrors\.NET_TIMEOUT_MS\)/, "the page's fetches wait as long as the background's");
    assert.doesNotMatch(source, /请稍后重试/, "a note keeps state only, no instruction");
  }

  // D8: the player ✦ never writes the popup's status line (setMessage); D1: its failure is red on the page.
  {
    const saved = Object.fromEntries(["setMessage", "setReadingNotice", "getSettings", "sendRuntimeMessage"].map((k) => [k, t[k]]));
    const seen = [];
    t.HTMLButtonElement = class {};
    t.setMessage = (m) => seen.push(["message", m]);
    t.setReadingNotice = (m, o) => seen.push(["notice", m, o?.error]);
    t.getSettings = async () => ({ enablePlayerAiQuickAction: true });
    const click = { preventDefault() {}, stopPropagation() {}, currentTarget: null };
    t.sendRuntimeMessage = async () => ({ ok: true });
    await t.handlePlayerAiQuickActionClick(click);
    t.sendRuntimeMessage = async () => ({ ok: false, error: "x" });
    await t.handlePlayerAiQuickActionClick(click);
    assert.deepStrictEqual(seen, [["notice", "打开侧边栏失败：x", true]]);
    // G4: a reloaded extension reads as TEXT.reloaded, not Chrome's English; 专注模式's AI 总结 shares the handling (G7).
    seen.splice(0);
    t.sendRuntimeMessage = async () => Promise.reject(new Error("Extension context invalidated."));
    await t.handlePlayerAiQuickActionClick(click);
    assert.strictEqual(await t.askSidepanel("reader"), false);
    assert.deepStrictEqual(seen, [["notice", t.MdgErrors.TEXT.reloaded, true], ["notice", t.MdgErrors.TEXT.reloaded, true]]);
    Object.assign(t, saved);
    delete t.HTMLButtonElement;
  }
  // J2: 专注模式 that does not start from the popup is red on the page, as from the URL or a video change.
  {
    const saved = Object.fromEntries(["setReadingNotice", "enterReaderMode", "ensureUiReady", "markReaderMode", "removePlayerAiQuickActionButton"].map((k) => [k, t[k]]));
    const seen = [];
    Object.assign(t, { setReadingNotice: (m, o) => seen.push([m, o?.error]), enterReaderMode: async () => Promise.reject(new Error("视频播放器长时间未就绪")), ensureUiReady() {}, markReaderMode() {}, removePlayerAiQuickActionButton() {} });
    const reply = await new Promise((resolve) => listeners.message.forEach((f) => f({ type: "popup-trigger-reading-view" }, {}, resolve)));
    await settle();
    assert.deepStrictEqual([reply.ok, seen], [true, [[`${t.MdgErrors.TEXT.readerStartFailed}：视频播放器长时间未就绪`, true]]]);
    assert.strictEqual(source.match(/enterReaderMode\(\)\.catch/g).length, 1, "one catch for every entry");
    Object.assign(t, saved);
  }
  // J12: 专注模式's info bar says 发布日期, as everywhere else.
  {
    const was = state.uploadDate;
    state.uploadDate = "2026-10-14";
    assert.ok(t.buildReadingSummaryItems().some((item) => item.label === "发布日期" && item.value === "2026-10-14"));
    state.uploadDate = was;
  }
  // D1: every failure notice on the video page is red (error: true), like the popup's.
  for (const m of source.matchAll(/setReadingNotice\((`[^`]*`|"[^"]*")(.{0,60})/g)) {
    if (/失败|未就绪|Failed\}/.test(m[1])) assert.match(m[2], /^(, \{ error: true \}|\)\)?, \{ error: true \})/, `not red: ${m[0]}`);
  }
  // D3: what failed when 专注模式 has no subtitle to show is reading the video, in the popup's words.
  {
    const was = state.subtitleFetchState;
    state.subtitleFetchState = "error";
    assert.strictEqual(t.getReadingTranscriptPlaceholderText(), `${t.MdgErrors.TEXT.videoReadFailed}。`);
    state.subtitleFetchState = was;
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

  // No subtitle: the three states in the one sentence every entry uses; 未登录 is not a failure reason and adds the hint.
  {
    const saved = Object.fromEntries(["subtitleFetchState", "subtitleFailure", "subtitleNeedLogin"].map((k) => [k, state[k]]));
    const say = (fields) => (Object.assign(state, { subtitleFetchState: "empty", subtitleFailure: "", subtitleNeedLogin: false, ...fields }), t.getReadingTranscriptPlaceholderText());
    assert.deepStrictEqual(
      [say({}), say({ subtitleFailure: "网络断了" }), say({ subtitleNeedLogin: true })],
      ["视频没有字幕。", "字幕抓取失败：网络断了。", "未登录 B站，拿不到字幕。登录 B站后刷新网页。"]
    );
    Object.assign(state, saved);
  }

  // A1, A20: the player host in 专注模式 and after it.
  {
    const saved = { phase: state.readerPhase, host: state.readingPlayerHost };
    const names = ["getReaderMainWidthLimit", "getReaderPlayerWrapNode", "updateReadingTranscriptTailSpacer", "queueEnsureReaderPlayerControlsRecovered", "getReaderControlsRoot", "reader"];
    const was = names.map((k) => t[k]);
    const host = (classes = []) => {
      const cls = new Set(classes);
      const attrs = {};
      return {
        cls, attrs,
        classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
        style: { setProperty() {}, removeProperty() {} },
        getAttribute: (k) => attrs[k] ?? null,
        setAttribute: (k, v) => (attrs[k] = v),
        removeAttribute: (k) => delete attrs[k],
        getBoundingClientRect: () => ({ width: 800, height: 450 }),
        parentElement: null
      };
    };
    Object.assign(t, { getReaderMainWidthLimit: () => 800, getReaderPlayerWrapNode: () => null, updateReadingTranscriptTailSpacer() {}, queueEnsureReaderPlayerControlsRecovered() {}, reader: () => t.MdgSites.SITES.bilibili.reader });
    // A1: laying the player out keeps the class that hides B站's own subtitles and sending bar.
    state.readerPhase = "open";
    state.readingPlayerHost = host(["mdg-reader-player-host"]);
    t.layoutReaderPlayerHost();
    assert.ok(state.readingPlayerHost.cls.has("mdg-reader-player-host"), "the host keeps its class after layout");
    // A20: closing turns the phase off before the host is cleaned up; the forced control bar and the hidden cursor come back.
    const bar = { style: { display: "block", setProperty(k, v) { this.display = v; }, removeProperty() { this.display = ""; } }, attrs: {} };
    Object.assign(bar, { getAttribute: (k) => bar.attrs[k] ?? null, setAttribute: (k, v) => (bar.attrs[k] = v), removeAttribute: (k) => delete bar.attrs[k] });
    t.getReaderControlsRoot = () => ({ querySelector: (sel) => (sel === ".bpx-player-control-wrap" ? bar : null) });
    const player = host(["bpx-state-no-cursor"]);
    t.setReaderPlayerControlsVisible(true, player);
    assert.deepStrictEqual([bar.style.display, player.cls.has("bpx-state-no-cursor")], ["block", false], "shown while open");
    state.readerPhase = "off";
    t.setReaderPlayerControlsVisible(false, player);
    assert.deepStrictEqual([bar.style.display, bar.attrs["data-mdg-reader-controls-forced"], player.cls.has("bpx-state-no-cursor")], ["", undefined, true], "restored after the close");
    const fresh = host(["bpx-state-no-cursor"]);
    t.setReaderPlayerControlsVisible(true, fresh);
    assert.ok(fresh.cls.has("bpx-state-no-cursor"), "closed: nothing is forced visible");
    names.forEach((k, i) => (t[k] = was[i]));
    Object.assign(state, { readerPhase: saved.phase, readingPlayerHost: saved.host });
  }

  // A19: tracks listed but none loaded: the dropdowns show why, not the first track as current.
  {
    const saved = Object.fromEntries(["subtitles", "selectedSubtitleId", "selectedSubtitleUrl", "subtitleFetchState", "subtitleFailure", "subtitleNeedLogin"].map((k) => [k, state[k]]));
    Object.assign(state, { subtitles: [{ id: "1", url: "u1", label: "中文" }, { id: "2", url: "u2", label: "English" }], selectedSubtitleId: "", selectedSubtitleUrl: "", subtitleFetchState: "empty", subtitleFailure: "网络断了", subtitleNeedLogin: false });
    const select = {};
    t.renderSubtitleOptions(select);
    assert.match(select.innerHTML, /^<option value="" selected disabled>字幕抓取失败：网络断了<\/option>/);
    assert.ok(!t.getPopupPayload().subtitleOptions.some((o) => o.selected), "the popup gets no selected track");
    Object.assign(state, { selectedSubtitleId: "2", selectedSubtitleUrl: "u2" });
    t.renderSubtitleOptions(select);
    assert.match(select.innerHTML, /^<option value="u1"/, "a loaded track: no placeholder");
    assert.match(select.innerHTML, /value="u2"[^>]* selected>/);
    Object.assign(state, saved);
  }

  // The 2026-10-16 scan, group c2 (C67–C146): one assertion per behavior fix.
  {
    const touched = ["setReadingNotice", "setStatus", "sendRuntimeMessage", "getSettings", "refreshDerivedContent", "confirmOverwriteNote", "computeCurrentClipSignature", "settledClip", "getRuntimeVideoElement", "findReaderPlayerHost", "dismissReaderMiniPlayer", "normalizeReaderPlayerContainer", "bindReadingViewVideo", "bindReaderPlayerControlsHover", "bindReaderLayout", "layoutReaderPlayerHost", "cleanupReaderPlayerHostNode", "setReaderPlayerControlsVisible", "hasReaderPlayerControlsIssue", "getReaderPlayerControlsState", "seekVideo", "updateReaderFollowState", "byId", "fetchHotComments", "loadAiTurns", "loadTriageExtras", "currentSite", "retryAsync", "sleep", "MdgSites", "setTimeout", "clearTimeout", "history"];
    const saved = Object.fromEntries(touched.map((k) => [k, t[k]]));
    const savedState = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(state)).filter(([, d]) => "value" in d).map(([k, d]) => [k, d.value]));
    const notices = [];
    t.setReadingNotice = (m, o) => notices.push([m, Boolean(o?.error)]);
    t.computeCurrentClipSignature = real.computeCurrentClipSignature;

    // C67: only the first copy takes mdg_reader from the URL the page loaded with; one injected later does not reopen it.
    {
      const [de, perf] = [t.document.documentElement, t.performance];
      const attrs = new Set();
      t.document.documentElement = { hasAttribute: (k) => attrs.has(k), setAttribute: (k) => attrs.add(k) };
      t.performance = { getEntriesByType: (type) => (type === "navigation" ? [{ name: `${t.location.href}?mdg_reader=1` }] : []) };
      assert.deepStrictEqual([t.readerEntryRequested(), t.readerEntryRequested()], [true, false]);
      [t.document.documentElement, t.performance] = [de, perf];
    }
    // C71: a copy standing down in focus mode reloads into focus mode, with mdg_reader back in the address.
    {
      let to = "";
      t.location.replace = (u) => (to = u);
      state.readerPhase = "open";
      t.standDown();
      assert.strictEqual(new URL(to).searchParams.get("mdg_reader"), "1");
      Object.assign(state, { superseded: false, readerPhase: "off" });
      delete t.location.replace;
    }
    // C81: rewriting the address (focus mode's close) leaves a video change the URL watcher has not seen for it to see.
    {
      t.history = { state: null, replaceState() {} };
      state.currentClipSignature = "bilibili|BV_old|1|";
      t.replaceReaderModeUrl("https://www.bilibili.com/video/BV1xx411c7mD/");
      assert.strictEqual(state.currentClipSignature, "bilibili|BV_old|1|");
    }
    // C86: two quick subtitle picks; the first loads last and does not replace the second.
    {
      const loaded = (url) => gate({ track: { url, label: url }, body: [{ from: 0, to: 1, content: url }] });
      const gates = { a: loaded("a"), b: loaded("b") };
      t.MdgSites = { ...saved.MdgSites, loadFirstTrack: (site, [track]) => gates[track.url].promise };
      t.refreshDerivedContent = async () => {};
      Object.assign(state, { readerPhase: "off", subtitles: [{ url: "a", label: "A" }, { url: "b", label: "B" }] });
      const picks = [t.switchSubtitle("a"), t.switchSubtitle("b")];
      gates.b.open();
      await settle();
      gates.a.open();
      await Promise.all(picks);
      assert.strictEqual(state.selectedSubtitleUrl, "b");
      t.MdgSites = saved.MdgSites;
    }
    // C90: 写入 Obsidian turned off meanwhile answers the popup; C91: 取消 in the dialog says so on the page.
    {
      const settings = { ...vm.runInContext("DEFAULT_SETTINGS", ctx), obsidianEnabled: false };
      t.getSettings = async () => settings;
      assert.deepStrictEqual({ ...(await t.sendToObsidian()) }, { ok: false, text: t.MdgErrors.TEXT.obsidianOff });
      settings.obsidianEnabled = true;
      Object.assign(t, {
        refreshDerivedContent: async () => (state.markdown = "# A"),
        sendRuntimeMessage: async () => ({ ok: true, ask: true, path: "p.md" }),
        confirmOverwriteNote: async () => ""
      });
      notices.splice(0);
      await t.sendToObsidian();
      assert.deepStrictEqual(notices, [[t.MdgErrors.TEXT.obsidianCancelled, false]]);
    }
    // C101: focus mode's background read that fails after focus mode closed says nothing on the page.
    {
      t.settledClip = async () => Promise.reject(new Error("网络断了"));
      for (const closeFirst of [true, false]) {
        notices.splice(0);
        Object.assign(state, { readerPhase: "open", subtitleBody: [] });
        t.maybeRefreshReaderSubtitleInBackground();
        if (closeFirst) state.readerPhase = "off";
        await settle();
        assert.strictEqual(notices.length, closeFirst ? 0 : 1, `closed first: ${closeFirst}`);
      }
    }
    // C104: closed while the mount waits for the mini player to go: the page's player is left alone.
    {
      let normalized = 0;
      const host = { classList: { add() {} } };
      const video = { removeAttribute() {}, setAttribute() {}, closest: () => null };
      Object.assign(t, {
        getRuntimeVideoElement: () => video,
        findReaderPlayerHost: () => host,
        dismissReaderMiniPlayer: () => true,
        normalizeReaderPlayerContainer: () => normalized++,
        bindReadingViewVideo() {},
        bindReaderPlayerControlsHover() {},
        bindReaderLayout() {},
        layoutReaderPlayerHost() {},
        cleanupReaderPlayerHostNode() {}
      });
      state.readerPhase = "entering";
      const mounting = real.ensureReaderPlayerMounted();
      state.readerPhase = "off";
      assert.deepStrictEqual([await mounting, normalized], [false, 0]);
    }
    // C107, C108: focus mode's info panel says the video is being read, or that the read failed, not 没有简介.
    {
      const nodes = {};
      t.byId = (id) => (nodes[id] ||= { innerHTML: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} } });
      Object.assign(state, { meta: null, title: "", author: "", uploadDate: "", pageCount: 0, description: "" });
      for (const [fetchState, meta, words] of [["loading", null, "正在读取视频信息…"], ["error", null, t.MdgErrors.TEXT.videoReadFailed], ["ready", {}, "当前视频没有简介。"]]) {
        Object.assign(state, { subtitleFetchState: fetchState, meta });
        t.renderReadingInfoPanel();
        const ids = vm.runInContext("ids", ctx);
        assert.ok(nodes[ids.readingInfoDescription].innerHTML.includes(words), `${fetchState}: ${nodes[ids.readingInfoDescription].innerHTML}`);
        if (!meta) assert.ok(nodes[ids.readingInfoSummary].innerHTML.includes(words), `${fetchState}: the summary`);
      }
      t.byId = saved.byId;
    }
    // C111: a focus-mode look that did not save says so.
    {
      notices.splice(0);
      t.sendRuntimeMessage = async () => ({ ok: false, error: "存不下" });
      await t.persistReaderSettings();
      assert.deepStrictEqual(notices, [[`${t.MdgErrors.TEXT.settingsSaveFailed}：存不下`, true]]);
    }
    // C78: focus mode's look changing does not rebuild the note; a note setting does.
    {
      let rebuilt = 0;
      t.getSettings = async () => ({});
      t.refreshDerivedContent = async () => rebuilt++;
      state.markdown = "# A";
      for (const changes of [{ readerTheme: { newValue: "dark" } }, { includeHotCommentsInNote: { newValue: true } }]) {
        listeners.storage.forEach((f) => f(changes, "sync"));
        await settle();
      }
      assert.strictEqual(rebuilt, 1);
    }
    // C123: the control bar is not forced on a host that was replaced during the retry wait.
    {
      let forced = 0;
      Object.assign(t, { hasReaderPlayerControlsIssue: () => true, setReaderPlayerControlsVisible: () => forced++, getReaderPlayerControlsState: () => ({ nodes: [] }) });
      Object.assign(state, { readerPhase: "open", readingPlayerHost: "A" });
      const recovering = t.ensureReaderPlayerControlsRecovered("A");
      state.readingPlayerHost = "B";
      assert.deepStrictEqual([await recovering, forced], [false, 1]);
      state.readerPhase = "off";
    }
    // C125: the player ✦'s sync is throttled: a call while one waits joins it instead of putting it off.
    {
      const timers = [];
      let cleared = 0;
      Object.assign(t, { setTimeout: (f) => timers.push(f), clearTimeout: () => cleared++ });
      state.playerAiQuickActionSyncTimer = 0;
      t.schedulePlayerAiQuickActionSync();
      t.schedulePlayerAiQuickActionSync();
      Object.assign(t, { setTimeout: saved.setTimeout, clearTimeout: saved.clearTimeout });
      assert.deepStrictEqual([timers.length, cleared], [1, 0]);
      state.playerAiQuickActionSyncTimer = 0;
    }
    // C129: a rebuilt ✦ wrap on the same player host adds no second set of cursor listeners.
    {
      t.HTMLElement = Object;
      let bound = 0;
      const host = { addEventListener: () => bound++ };
      t.bindPlayerAiQuickActionCursorSync({ parentElement: host });
      t.bindPlayerAiQuickActionCursorSync({ parentElement: host });
      assert.strictEqual(bound, 4);
      delete t.HTMLElement;
    }
    // C131: a time point without a player is red, and the next jump that works clears it.
    {
      notices.splice(0);
      t.bindReadingViewVideo = () => null;
      t.jumpReadingTarget(3);
      Object.assign(t, { bindReadingViewVideo: () => ({}), seekVideo() {}, updateReaderFollowState() {}, byId: () => ({ textContent: vm.runInContext("NO_PLAYER", ctx) }) });
      t.jumpReadingTarget(3);
      assert.deepStrictEqual(notices, [[vm.runInContext("NO_PLAYER", ctx), true], ["", false]]);
      t.byId = saved.byId;
    }
    // C133: two YouTube reads capturing the PO token take turns: each finds the captions button as the page had it.
    {
      let pressed = false;
      const reads = [];
      const button = { getAttribute: () => (reads.push(pressed), String(pressed)), click: () => (pressed = !pressed) };
      const query = t.document.querySelector;
      t.document.querySelector = (q) => (q.includes("ytp-subtitles-button") ? button : null);
      t.PerformanceObserver = class { observe() {} disconnect() {} };
      await Promise.all([t.ytCapturePot("v1"), t.ytCapturePot("v1")]);
      assert.deepStrictEqual([reads, pressed], [[false, false], false]);
      t.document.querySelector = query;
      delete t.PerformanceObserver;
    }
    // C137: settings the background did not give stop the read or the write instead of using the defaults.
    {
      t.sendRuntimeMessage = async () => ({ ok: false, error: "后台没回" });
      await assert.rejects(real.getSettings(), /后台没回/);
      t.sendRuntimeMessage = async () => undefined;
      await assert.rejects(real.getSettings(), /读取设置失败/);
    }
    // C140, C141: the first retry waits the full delay, and an HTTP 4xx answer is not retried.
    {
      const waits = [];
      t.sleep = async (ms) => waits.push(ms);
      const tries = async (error) => {
        let n = 0;
        await real.retryAsync(async () => {
          n++;
          throw error;
        }, 2, 100).catch(() => {});
        return n;
      };
      assert.strictEqual(await tries(new TypeError("Failed to fetch")), 3);
      assert.deepStrictEqual(waits, [100, 200]);
      assert.strictEqual(await tries(Object.assign(new Error("B站请求失败 HTTP 404"), { status: 404 })), 1, "404");
      assert.strictEqual(await tries(Object.assign(new Error("B站请求失败 HTTP 503"), { status: 503 })), 3, "503");
    }
    // C145: a failed comment read is said in the popup's status; C146: an overlapping read's failure keeps the comments
    // the other one got.
    {
      Object.assign(t, { loadAiTurns: async () => [], loadTriageExtras: async () => null });
      Object.assign(state, { settings: { includeHotCommentsInNote: true }, hotComments: [], subtitleFetchState: "ready" });
      t.fetchHotComments = async () => Promise.reject(Object.assign(new Error(t.MdgErrors.TEXT.biliThrottled), { code: "THROTTLED" }));
      await real.refreshDerivedContent();
      assert.ok(t.readDoneText().startsWith(`评论读取失败：${t.MdgErrors.TEXT.biliThrottled}。`), t.readDoneText());
      const ok = gate([{ uname: "a", message: "好" }]);
      let fail;
      const failing = new Promise((_, reject) => (fail = reject));
      const answers = [ok.promise, failing];
      Object.assign(state, { hotComments: [], commentsFailure: "" });
      t.fetchHotComments = () => answers.shift();
      const both = [real.refreshDerivedContent(), real.refreshDerivedContent()];
      ok.open();
      await settle();
      fail(new Error("网络断了"));
      await Promise.all(both);
      assert.deepStrictEqual([state.hotComments.length, state.commentsFailure], [1, ""]);
    }
    // C84: a video whose duration nobody knows is read like on every other entry, without the duration check.
    {
      Object.assign(t, { getSettings: async () => ({}), retryAsync: (f) => f(), refreshDerivedContent: async () => {}, getRuntimeVideoElement: () => null });
      t.currentSite = () => ({
        id: "x",
        parseRef: () => ({ site: "bilibili", id: "BV_D" }),
        readDom: () => ({}),
        fetchMeta: async () => ({ duration: 0, title: "D" }),
        fetchTracks: async () => ((listed = true), { tracks: [] })
      });
      let listed = false;
      await real.runRefreshClip();
      assert.deepStrictEqual([listed, state.subtitleFailure, state.subtitleFetchState], [true, "", "empty"]);
    }

    Object.assign(t, saved);
    Object.assign(state, savedState);
  }

  console.log("content selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
