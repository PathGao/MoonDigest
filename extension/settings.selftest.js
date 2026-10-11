// /usr/local/bin/node extension/settings.selftest.js
// BocSettings' normalizers, every context that reads BocSettings loads settings.js first, and the defaults are
// written nowhere else.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
const ctx = vm.createContext({});
ctx.globalThis = ctx;
vm.runInContext(read("settings.js"), ctx);
vm.runInContext(read("settings.js"), ctx); // re-injection keeps the first copy
const S = ctx.BocSettings;
const plain = (value) => JSON.parse(JSON.stringify(value));

assert.strictEqual(S.normalizeApiKey("  Bearer abc "), "abc");
assert.strictEqual(S.normalizeApiKey(undefined), "");
assert.strictEqual(S.normalizeDownloadFormat("txt"), "txt");
assert.strictEqual(S.normalizeDownloadFormat("TXT"), "srt");
// Non-strings keep their text (an imported file may carry numbers); only null and undefined are empty.
assert.strictEqual(S.normalizePlayerAiQuickPrompt(42), "42");
assert.strictEqual(S.normalizePlayerAiQuickPrompt(null), "");
assert.deepStrictEqual(
  plain(S.normalizeFixedFrontmatterProperties([
    { key: " score ", type: "NUMBER", value: 0 },
    { key: "done", type: "checkbox", value: " TRUE " },
    { key: "x", type: "weird", value: "v" },
    { key: "empty", type: "text", value: "  " },
    { key: "", type: "text", value: "no key" }
  ])),
  [{ key: "score", type: "number", value: "0" }, { key: "done", type: "checkbox", value: "true" }, { key: "x", type: "text", value: "v" }]
);
assert.deepStrictEqual(plain(S.normalizeFixedFrontmatterProperties("x")), []);
const sections = S.normalizeNotePlaceholderSections([
  { title: " A ", position: "BEFORE_SUBTITLE", content: " c " },
  { title: "", position: "before_intro" },
  ...Array.from({ length: 6 }, (_, i) => ({ title: `t${i}`, position: "nowhere" }))
]);
assert.strictEqual(sections.length, S.MAX_NOTE_SECTIONS);
assert.deepStrictEqual(plain(sections[0]), { title: "A", position: "before_subtitle", content: "c" });
assert.strictEqual(sections[1].position, "before_intro");
assert.strictEqual(S.normalizeReaderTheme("paper"), "paper");
assert.strictEqual(S.normalizeReaderTheme("x"), S.DEFAULTS.readerTheme);
for (const [fn, key] of [["normalizeReaderFontScale", "readerFontScale"], ["normalizeReaderLetterSpacing", "readerLetterSpacing"], ["normalizeReaderLineHeight", "readerLineHeight"], ["normalizeReaderContentWidth", "readerContentWidth"]]) {
  assert.strictEqual(S[fn](undefined), S.DEFAULTS[key], `${fn} falls back to the default`);
  assert.strictEqual(S[fn](S.DEFAULTS[key]), S.DEFAULTS[key]);
}

// Registration: each list of scripts that reads BocSettings loads settings.js before the first reader.
const uses = (file) => file !== "settings.js" && /\bBocSettings\b/.test(read(file));
const checkOrder = (where, files) => {
  const first = files.findIndex(uses);
  if (first >= 0) assert.ok(files.indexOf("settings.js") >= 0 && files.indexOf("settings.js") < first, `${where} loads settings.js before ${files[first]}`);
  return first >= 0;
};
const manifest = JSON.parse(read("manifest.json"));
let readers = 0;
manifest.content_scripts.forEach((entry, i) => (readers += checkOrder(`content_scripts[${i}]`, entry.js)));
const calls = [...read("background.js").matchAll(/importScripts\(([^)]*)\)/g)].map((m) => m[1].match(/"[^"]+"/g).map((f) => JSON.parse(f)));
readers += checkOrder("background importScripts", [...calls[0], "background.js", ...calls.slice(1).flat()]);
const pages = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(path.join(__dirname, dir))) {
    const rel = path.join(dir, name);
    if (fs.statSync(path.join(__dirname, rel)).isDirectory()) walk(rel);
    else if (name.endsWith(".html")) pages.push(rel);
  }
};
walk(".");
for (const page of pages) {
  const scripts = [...read(page).matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => path.normalize(path.join(path.dirname(page), m[1])));
  readers += checkOrder(page, scripts.filter((f) => fs.existsSync(path.join(__dirname, f))));
}
assert.ok(readers >= 7, `found ${readers} readers of BocSettings`);

// The default prompts are written only in settings.js (dev mocks may seed their own).
const sources = ["background.js", "content.js", "options.js", "popup.js", "sidepanel.js", "note.js", "history/history.js", "triage/triage.js", "triage/triage-bg.js"];
const texts = [S.DEFAULTS.playerAiQuickPrompt, ...S.DEFAULTS.aiPresetPrompts, S.DEFAULTS.aiSystemPrompt.split("\n").find((line) => line.includes("Emoji"))];
for (const t of texts) {
  for (const file of sources) assert.ok(!read(file).includes(t), `${file} writes 「${t}」 itself`);
}
for (const name of ["normalizeApiKey", "normalizeDownloadFormat", "normalizePlayerAiQuickPrompt", "normalizeFixedPropertyType", "normalizeFixedPropertyValue", "isFixedPropertyRowEffectivelyEmpty", "normalizeFixedFrontmatterProperties", "normalizeNoteSectionPosition", "normalizeNotePlaceholderSections", "normalizeReaderTheme"]) {
  for (const file of sources) assert.ok(!new RegExp(`function ${name}\\(`).test(read(file)), `${file} defines ${name} again`);
}

console.log("settings selftest ok");
