// node extension/triage/viewer-frame.selftest.js
// Loads viewer-frame.js as Chrome would (a content script in every bilibili.com/video frame) and checks which keys
// it forwards to the 分拣台, and that only the 分拣台's own viewer frame forwards at all.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "viewer-frame.js"), "utf8");
const EXT = "chrome-extension://abcdefghijklmnop";

function frame({ parentOrigin = EXT, top = false, fullscreen = null, webscreen = false } = {}) {
  const sent = [];
  const listeners = [];
  const attrs = {};
  const win = {};
  Object.assign(win, {
    parent: { postMessage: (data, to) => sent.push({ data, to }) },
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture })
  });
  win.top = top ? win : {};
  win.window = win;
  Object.assign(win, {
    location: { ancestorOrigins: parentOrigin ? [parentOrigin] : [] },
    chrome: { runtime: { id: EXT.slice("chrome-extension://".length), getURL: (p) => `${EXT}/${p}` } },
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
  vm.runInContext(src, vm.createContext(win));
  const key = (key, o = {}) => {
    const target = o.target || { closest: () => null };
    for (const l of listeners) if (l.type === "keydown") l.fn({ key, keyCode: o.keyCode || 0, isComposing: Boolean(o.isComposing), repeat: false, metaKey: false, ctrlKey: Boolean(o.ctrlKey), altKey: false, target, composedPath: () => [target] });
  };
  return { sent, listeners, attrs, key };
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
}
console.log("viewer-frame selftest: all passed");
