// node extension/popup.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// popup.js is a DOM page: drop init() and check which tools are disabled, and why.
const source = fs.readFileSync(path.join(__dirname, "popup.js"), "utf8").replace(/^init\(\)\.catch\(/m, "(async () => {})().catch(");
assert.ok(source.includes("(async () => {})().catch("), "harness strips the page entry point");
const button = () => {
  const attrs = {};
  return { disabled: false, title: "", attrs, classList: { toggle() {} }, getAttribute: (k) => attrs[k] ?? null, setAttribute: (k, v) => (attrs[k] = v), removeAttribute: (k) => delete attrs[k] };
};
const ctx = vm.createContext({ document: { getElementById: button } });
for (const f of ["errors.js", "settings.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
vm.runInContext(`${source}\n;globalThis.el = el;`, ctx);
const state = () => Object.fromEntries(["downloadBtn", "readingViewBtn", "copyBtn", "mdBtn", "sendBtn"].map((k) => {
  const b = ctx.el[k];
  assert.strictEqual(b.title, b.attrs["aria-description"] || "", `${k}: tooltip and aria-description agree`);
  return [k, b.disabled ? b.title : ""];
}));

ctx.syncTools(null, false);
assert.deepStrictEqual(new Set(Object.values(state())), new Set(["当前网页不是支持的视频页"]), "a web page disables every tool");
ctx.syncTools(null);
assert.deepStrictEqual(new Set(Object.values(state())), new Set([""]), "a video page before its first reply keeps them usable");
ctx.syncTools({ markdown: "# t", srt: "", txt: "" });
assert.deepStrictEqual(state(), { downloadBtn: "当前视频没有可下载的字幕", readingViewBtn: "", copyBtn: "", mdBtn: "", sendBtn: "" }, "no subtitles");
ctx.syncTools({ markdown: "# t", srt: "1", txt: "a" });
assert.deepStrictEqual(new Set(Object.values(state())), new Set([""]), "everything ready");

// A non-video page whose content script still answers (youtube.com home): its payload keeps the tools disabled.
vm.runInContext("onVideoPage = false", ctx);
ctx.render({ markdown: "# t", srt: "1", txt: "a" }, { preserveStatus: true });
assert.deepStrictEqual(new Set(Object.values(state())), new Set(["当前网页不是支持的视频页"]), "a web page's payload does not re-enable the tools");
vm.runInContext("onVideoPage = true", ctx);

// Untrusted text (titles, UP names, comments, AI replies, tag names, paths) stays text: no tag of its own, no way out of
// a quoted attribute.
const XSS = ["<img src=x onerror=alert(1)>", `"'><script>alert(1)</script>`];
const assertInert = (html, where) => assert.ok(!/<img src=x|<script|"'>/i.test(html) && /&lt;|&#60;/.test(html), `${where}: ${html}`);
// The video's subtitle names and links come from the site.
for (const bad of XSS) {
  ctx.render({ subtitleOptions: [{ url: bad, id: bad, lang: bad, optionLabel: bad }] }, { preserveStatus: true });
  assertInert(ctx.el.subtitleSelect.innerHTML, "subtitle options");
}

console.log("popup selftest: all passed");
