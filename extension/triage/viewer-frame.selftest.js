// node extension/triage/viewer-frame.selftest.js
// Loads viewer-frame.js as Chrome would (a content script in every bilibili.com/video frame) and checks which keys
// it forwards to the 分拣台, and that only the 分拣台's own viewer frame forwards at all.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// The scripts the manifest's viewer-frame.js entry injects, in its order, read from it so the test cannot load a different set.
const entry = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")).content_scripts.find((c) => c.js.at(-1) === "triage/viewer-frame.js").js;
const src = entry.map((f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8")).join("\n");
const EXT = "chrome-extension://abcdefghijklmnop";

// player: the BV id page-player answers each ask with, in turn (null: the player has not loaded this episode yet).
function frame({ parentOrigin = EXT, top = false, fullscreen = null, webscreen = false, player = [] } = {}) {
  const asks = [];
  const sent = [];
  const listeners = [];
  const attrs = {};
  const win = {};
  const ticks = [];
  Object.assign(win, {
    setInterval: (fn) => ticks.push(fn),
    parent: { postMessage: (data, to) => sent.push({ data, to }) },
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture })
  });
  win.top = top ? win : {};
  win.window = win;
  Object.assign(win, {
    location: { pathname: "/video/BV1aaaaaaaaa/", ancestorOrigins: parentOrigin ? [parentOrigin] : [], get href() { return this.pathname; } },
    chrome: { runtime: { id: EXT.slice("chrome-extension://".length), getURL: (p) => `${EXT}/${p}`, sendMessage: async (m) => {
      asks.push(m);
      const id = player.shift();
      return { ok: true, data: id ? { site: "bilibili", id } : null };
    } } },
    // Node gives chrome-extension: URLs a "null" origin; Chrome gives the scheme and id.
    URL: function (u) {
      return { origin: new URL(u.replace("chrome-extension:", "https:")).origin.replace("https:", "chrome-extension:") };
    },
    document: {
      documentElement: { setAttribute: (k, v) => (attrs[k] = v) },
      fullscreenElement: fullscreen,
      querySelector: (s) => (webscreen && s.includes("data-screen=web") ? {} : null)
    }
  });
  const ctx = vm.createContext(win);
  vm.runInContext(src, ctx);
  const key = (key, o = {}) => {
    const target = o.target || { closest: () => null };
    for (const l of listeners) if (l.type === "keydown") l.fn({ key, keyCode: o.keyCode || 0, isComposing: Boolean(o.isComposing), repeat: false, metaKey: false, ctrlKey: Boolean(o.ctrlKey), altKey: false, target, composedPath: () => [target] });
  };
  const go = (pathname) => ((win.location.pathname = pathname), Promise.all(ticks.map((f) => f())));
  const fire = (type) => listeners.filter((l) => l.type === type).forEach((l) => l.fn({}));
  return { sent, listeners, attrs, key, go, fire, ticks, asks, ctx };
}

// The viewer frame: marked, forwards T and Esc to the extension origin only.
{
  const f = frame();
  assert.strictEqual(f.attrs["data-mdg-viewer"], "");
  assert.ok(f.listeners.some((l) => l.type === "keydown" && l.capture), "listens before B站's own handlers");
  f.key("t");
  f.key("T");
  f.key("Escape");
  f.key("d");
  f.key("t", { ctrlKey: true });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(f.sent)), [
    { data: { type: "mdg-viewer-key", key: "t" }, to: EXT },
    { data: { type: "mdg-viewer-key", key: "t" }, to: EXT },
    { data: { type: "mdg-viewer-key", key: "Escape" }, to: EXT }
  ]);
}
// S5: the video shown is reported on the first tick and on each change (B站's autoplay), not again while it stays.
{
  const f = frame();
  f.go("/video/BV1aaaaaaaaa/");
  f.go("/video/BV1aaaaaaaaa/");
  f.go("/video/BV1bbbbbbbbb");
  f.go("/list/watchlater");
  f.go("/video/BV1bbbbbbbbb");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(f.sent)), [
    { data: { type: "mdg-viewer-video", bvid: "BV1aaaaaaaaa" }, to: EXT },
    { data: { type: "mdg-viewer-video", bvid: "BV1bbbbbbbbb" }, to: EXT }
  ]);
}
// A 番剧 (/bangumi/play/) names no BV: its player is asked (page-player with ref) until it answers for this path, and again
// when it loads another video (the next episode); a /video/ path is never asked.
(async () => {
  const f = frame({ player: [null, "BV1ccccccccc", "BV1ddddddddd", "BV1eeeeeeeee"] });
  await f.go("/video/BV1aaaaaaaaa/");
  await f.go("/bangumi/play/ep1");
  await f.go("/bangumi/play/ep1");
  await f.go("/bangumi/play/ep1");
  f.fire("loadedmetadata");
  await f.go("/bangumi/play/ep1");
  await f.go("/bangumi/play/ep2");
  assert.strictEqual(f.asks.length, 4);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(f.asks[0])), { type: "page-player", ref: "/bangumi/play/ep1" });
  assert.deepStrictEqual(f.sent.map((m) => m.data.bvid), ["BV1aaaaaaaaa", "BV1ccccccccc", "BV1ddddddddd", "BV1eeeeeeeee"]);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
// The 番剧 title line: 季名 and the episode from the page title, nothing from a title that is not a 番剧's.
{
  const f = frame();
  assert.strictEqual(f.ctx.viewerTitleText("造物说：一共分几步第2集-纪录片-全集-高清独家在线观看-bilibili-哔哩哔哩", "造物说：一共分几步"), "造物说：一共分几步 第2集");
  assert.strictEqual(f.ctx.viewerTitleText("哔哩哔哩 (゜-゜)つロ 干杯~-bilibili", "造物说：一共分几步"), "");
  assert.strictEqual(f.ctx.viewerTitleText("造物说：一共分几步第2集-纪录片", ""), "");
}
// Typing in B站's boxes and IME composition never forward.
{
  const f = frame();
  const input = { closest: (s) => (s.includes("input") ? input : null) };
  const rich = { isContentEditable: true, closest: () => null }; // the comment box, deep in shadow roots
  f.key("t", { target: input });
  f.key("Escape", { target: input });
  f.key("t", { target: rich });
  f.key("t", { isComposing: true });
  f.key("t", { keyCode: 229 });
  assert.deepStrictEqual(f.sent, [], "danmaku box, comment box, IME");
}
// Esc that leaves full screen or 网页全屏 stays with the player.
{
  const a = frame({ fullscreen: {} });
  const b = frame({ webscreen: true });
  a.key("Escape");
  b.key("Escape");
  b.key("t");
  assert.deepStrictEqual(a.sent, []);
  assert.strictEqual(b.sent.length, 1);
}
// Not the 分拣台's frame: a top-level video page, or embedded by another site → nothing.
for (const f of [frame({ top: true }), frame({ parentOrigin: "https://www.example.com" }), frame({ parentOrigin: null })]) {
  f.key("t");
  assert.deepStrictEqual(f.sent, []);
  assert.strictEqual(f.attrs["data-mdg-viewer"], undefined);
  assert.strictEqual(f.listeners.length, 0);
  assert.strictEqual(f.ticks.length, 0);
}
console.log("viewer-frame selftest: all passed");
