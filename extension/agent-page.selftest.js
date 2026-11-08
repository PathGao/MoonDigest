// node extension/agent-page.selftest.js
// agent-page.js in vm with a fake window, <video>, canvas, chrome.runtime and clock (timers run on fake time, so
// the 30 s ad wait takes no real time).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// A hung wait fails the test instead of the run.
setTimeout(() => (console.error("agent-page selftest: timed out"), process.exit(1)), 20000).unref();

const SRC = fs.readFileSync(path.join(__dirname, "agent-page.js"), "utf8");

function fakeVideo({ width = 1920, height = 1080, duration = 300, seeks = true, area = 1000, readyState = 4 } = {}, clock) {
  const listeners = {};
  const video = {
    paused: false,
    readyState,
    duration,
    videoWidth: width,
    videoHeight: height,
    _time: 0,
    pause() {
      video.paused = true;
    },
    get currentTime() {
      return video._time;
    },
    set currentTime(value) {
      // A real seek lands on a frame boundary near the target.
      if (seeks) clock.setTimeout(() => ((video._time = Math.round(value * 25) / 25), video.fire("seeked")), 40);
    },
    addEventListener: (type, fn) => (listeners[type] ||= new Set()).add(fn),
    removeEventListener: (type, fn) => listeners[type]?.delete(fn),
    fire: (type) => [...(listeners[type] || [])].forEach((fn) => fn()),
    getBoundingClientRect: () => ({ width: area, height: area / 2 }),
    listeners
  };
  return video;
}

function setup({ videos = [], ad = false, skip = null, tainted = false, top = true } = {}) {
  let now = 0;
  const timers = [];
  const clock = {
    setTimeout(fn, ms = 0) {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      const i = timers.indexOf(timer);
      if (i >= 0) timers.splice(i, 1);
    }
  };
  const state = { ad, posted: [], runtime: [], drawn: null };
  const windowListeners = new Set();
  const doc = {
    querySelector: (selector) => (selector === "#movie_player.ad-showing" && state.ad ? {} : null),
    querySelectorAll: (selector) => (selector === "video" ? videos : selector.includes("skip") && skip ? [skip] : []),
    createElement: (tag) => {
      assert.strictEqual(tag, "canvas");
      const canvas = {
        getContext: () => ({ drawImage: (source, x, y, w, h) => (state.drawn = { source, w, h }) }),
        toDataURL: (type, quality) => {
          if (tainted) throw Object.assign(new Error("tainted"), { name: "SecurityError" });
          return `data:${type};base64,${quality}:${canvas.width}x${canvas.height}`;
        }
      };
      return canvas;
    }
  };
  const ctx = vm.createContext({
    AbortController,
    Date: { now: () => now },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    document: doc,
    getComputedStyle: () => ({ visibility: "visible" }),
    location: { origin: "https://www.youtube.com" },
    addEventListener: (type, fn, options) => {
      assert.strictEqual(type, "message");
      windowListeners.add(fn);
      options?.signal?.addEventListener("abort", () => windowListeners.delete(fn));
    },
    postMessage: (data, origin) => state.posted.push({ data, origin }),
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => state.runtime.push(fn), removeListener: (fn) => state.runtime.splice(state.runtime.indexOf(fn), 1) }
      }
    }
  });
  ctx.globalThis = ctx;
  ctx.window = ctx;
  ctx.top = top ? ctx : {};
  vm.runInContext(SRC, ctx);

  // Runs timers on fake time until promise settles.
  async function drive(promise) {
    let done = false;
    promise.then(() => (done = true), () => (done = true));
    for (let i = 0; i < 100000 && !done; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (done || !timers.length) continue;
      timers.sort((a, b) => a.at - b.at);
      const timer = timers.shift();
      now = Math.max(now, timer.at);
      timer.fn();
    }
    return promise;
  }
  // A page message as the page's own script (source: window) or another frame (source: other) posts it.
  // Inside vm, `window` is the context's global proxy, not ctx itself.
  const win = vm.runInContext("window", ctx);
  const post = (data, source = win) => windowListeners.forEach((fn) => fn({ data, source }));
  const reply = async (data, source) => {
    const before = state.posted.length;
    post(data, source);
    await drive(new Promise((resolve) => {
      const wait = () => (state.posted.length > before ? resolve() : setImmediate(wait));
      wait();
    }));
    return state.posted[before];
  };
  const call = (method, params) =>
    drive(new Promise((resolve) => assert.strictEqual(state.runtime[0]({ type: "agent-call", method, params }, {}, resolve), true)));
  return { ctx, state, clock, post, reply, call, drive, windowListeners, now: () => now };
}

const DATA = { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", site: "youtube", videoId: "dQw4w9WgXcQ" };

(async () => {
  // Only the page's own window is answered; the reply carries the envelope and goes to location.origin.
  {
    const t = setup();
    t.ctx.MdgAgentPage.bind({ read: async () => DATA });
    t.post({ type: "moondigest-get", id: "x" }, {});
    t.post({ type: "something-else", id: "y" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(t.state.posted.length, 0);
    const got = await t.reply({ type: "moondigest-get", id: "a1" });
    assert.strictEqual(got.origin, "https://www.youtube.com");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(got.data)), { source: "moondigest", id: "a1", version: 1, ok: true, data: DATA });
    // Our own reply (source window, no type) is not taken for a request.
    t.post(got.data);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(t.state.posted.length, 1);
  }

  // A rejected read: the message and its string code pass through; no code key without one.
  {
    const t = setup();
    let error = Object.assign(new Error("B站限流，请稍后再试"), { code: "THROTTLED" });
    t.ctx.MdgAgentPage.bind({ read: async () => Promise.reject(error) });
    let got = (await t.reply({ type: "moondigest-get", id: "e1" })).data;
    assert.deepStrictEqual([got.ok, got.error, got.code, got.version], [false, "B站限流，请稍后再试", "THROTTLED", 1]);
    error = Object.assign(new Error("gone"), { code: -404 });
    got = (await t.reply({ type: "moondigest-get", id: "e2" })).data;
    assert.deepStrictEqual([got.ok, got.error, "code" in got], [false, "gone", false]);
  }

  // The runtime channel runs the same handlers, and leaves other messages to other listeners.
  {
    const t = setup();
    t.ctx.MdgAgentPage.bind({ read: async () => DATA });
    assert.strictEqual(t.state.runtime[0]({ type: "other" }, {}, () => {}), false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await t.call("get", {}))), { ok: true, data: DATA });
    const bad = await t.call("delete", {});
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /Unknown method/);
  }

  // A frame: paused, seeked, scaled to maxWidth (1280 by default) as JPEG 0.85, at the time actually shown.
  {
    const t = setup();
    const small = fakeVideo({ area: 100 }, t.clock);
    const main = fakeVideo({}, t.clock);
    t.state.videos = [small, main];
    t.ctx.document.querySelectorAll = (s) => (s === "video" ? [small, main] : []);
    t.ctx.MdgAgentPage.bind({ read: async () => DATA });
    let got = (await t.reply({ type: "moondigest-frame", id: "f1", at: 12.345 })).data;
    assert.strictEqual(got.ok, true, got.error);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(got.data)), { at: 12.36, width: 1280, height: 720, image: "data:image/jpeg;base64,0.85:1280x720" });
    assert.strictEqual(main.paused, true);
    assert.strictEqual(small.paused, false);
    assert.strictEqual(t.state.drawn.source, main);
    got = await t.call("frame", { at: 1, maxWidth: 640 });
    assert.deepStrictEqual([got.data.width, got.data.height], [640, 360]);
    // Never scaled up; a time past the end shows the end.
    got = await t.call("frame", { at: 9999, maxWidth: 4000 });
    assert.deepStrictEqual([got.data.width, got.data.at], [1920, 300]);
    // Every listener the wait added is gone.
    assert.ok(Object.values(main.listeners).every((set) => set.size === 0));
    got = await t.call("frame", {});
    assert.deepStrictEqual([got.ok, "code" in got], [false, false]);
  }

  // NO_VIDEO, SEEK_TIMEOUT (15 s), FRAME_BLOCKED.
  {
    let t = setup();
    t.ctx.MdgAgentPage.bind({ read: async () => DATA });
    assert.strictEqual((await t.call("frame", { at: 1 })).code, "NO_VIDEO");
    // The bridge's frame for a page with no content script (agent-sites/web.js) gets the same reply, without bind.
    const reply = await setup().ctx.MdgAgentPage.frame({ at: 1 });
    assert.deepStrictEqual([reply.ok, reply.code], [false, "NO_VIDEO"]);

    t = setup();
    const stuck = fakeVideo({ seeks: false }, t.clock);
    t.ctx.document.querySelectorAll = (s) => (s === "video" ? [stuck] : []);
    t.ctx.MdgAgentPage.bind({ read: async () => DATA });
    const start = t.now();
    assert.strictEqual((await t.call("frame", { at: 5 })).code, "SEEK_TIMEOUT");
    assert.strictEqual(t.now() - start, 15000);

    // A tab never shown: Chrome has not loaded the video, so it fails at once instead of after 15 s.
    t = setup();
    const unloaded = fakeVideo({ readyState: 0 }, t.clock);
    t.ctx.document.querySelectorAll = (s) => (s === "video" ? [unloaded] : []);
    t.ctx.document.visibilityState = "hidden";
    t.ctx.MdgAgentPage.bind({ read: async () => DATA });
    const hiddenAt = t.now();
    assert.strictEqual((await t.call("frame", { at: 5 })).code, "TAB_HIDDEN");
    assert.strictEqual(t.now() - hiddenAt, 0);

    t = setup({ tainted: true });
    const video = fakeVideo({}, t.clock);
    t.ctx.document.querySelectorAll = (s) => (s === "video" ? [video] : []);
    t.ctx.MdgAgentPage.bind({ read: async () => DATA });
    assert.strictEqual((await t.call("frame", { at: 5 })).code, "FRAME_BLOCKED");
  }

  // An ad that never ends: the skip button is clicked whenever shown, and after 30 s the frame gives up with AD_PLAYING.
  {
    let clicks = 0;
    const skip = { getClientRects: () => [1], click: () => clicks++ };
    const t = setup({ ad: true, skip });
    const video = fakeVideo({}, t.clock);
    t.ctx.document.querySelectorAll = (s) => (s === "video" ? [video] : s.includes("skip") ? [skip] : []);
    t.ctx.MdgAgentPage.bind({ read: async () => DATA });
    const got = await t.call("frame", { at: 5 });
    assert.strictEqual(got.code, "AD_PLAYING");
    assert.ok(t.now() >= 30000 && t.now() < 31000, String(t.now()));
    assert.ok(clicks > 50, String(clicks)); // every 0.5 s for 30 s
    assert.strictEqual(video.paused, false);
  }

  // An ad skipped on the first click: the frame goes on.
  {
    const t = setup({ ad: true });
    const skip = { getClientRects: () => [1], click: () => (t.state.ad = false) };
    const video = fakeVideo({}, t.clock);
    t.ctx.document.querySelectorAll = (s) => (s === "video" ? [video] : s.includes("skip") ? [skip] : []);
    t.ctx.MdgAgentPage.bind({ read: async () => DATA });
    const got = await t.call("frame", { at: 5 });
    assert.strictEqual(got.ok, true, got.error);
  }

  // In a frame bind does nothing; signal's abort removes both listeners.
  {
    let t = setup({ top: false });
    t.ctx.MdgAgentPage.bind({ read: async () => DATA });
    assert.deepStrictEqual([t.windowListeners.size, t.state.runtime.length], [0, 0]);
    t = setup();
    const life = new AbortController();
    t.ctx.MdgAgentPage.bind({ read: async () => DATA, signal: life.signal });
    assert.deepStrictEqual([t.windowListeners.size, t.state.runtime.length], [1, 1]);
    life.abort();
    assert.deepStrictEqual([t.windowListeners.size, t.state.runtime.length], [0, 0]);
  }

  // A resent get joins the read in flight (one read); two frames at once run one after another, each at its own time.
  {
    const t = setup();
    let reads = 0;
    let finish;
    t.ctx.MdgAgentPage.bind({ read: () => (reads++, new Promise((r) => (finish = r))) });
    t.post({ type: "moondigest-get", id: "g1" });
    t.post({ type: "moondigest-get", id: "g2" });
    await t.drive(Promise.resolve());
    finish(DATA);
    await t.drive(new Promise((r) => setImmediate(r)));
    assert.strictEqual(reads, 1, "the resend joined the first read");
    assert.deepStrictEqual(t.state.posted.map((p) => [p.data.id, p.data.ok]), [["g1", true], ["g2", true]]);
    const video = fakeVideo({}, t.clock);
    t.ctx.document.querySelectorAll = (s) => (s === "video" ? [video] : []);
    const [a, b] = await Promise.all([t.call("frame", { at: 10 }), t.call("frame", { at: 50 })]);
    assert.deepStrictEqual([a.data.at, b.data.at], [10, 50]);
  }

  console.log("agent-page selftest ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
