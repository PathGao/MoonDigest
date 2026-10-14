// /usr/local/bin/node extension/settings.selftest.js
// MdgSettings' normalizers, and the defaults are written nowhere else (load-order.selftest.js checks the load order).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
const ctx = vm.createContext({});
ctx.globalThis = ctx;
vm.runInContext(read("settings.js"), ctx);
vm.runInContext(read("settings.js"), ctx); // re-injection keeps the first copy
const S = ctx.MdgSettings;
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
const sources = ["background.js", "content.js", "options.js", "popup.js", "sidepanel.js", "note.js", "history/history.js", "triage/triage.js", "triage/triage-bg.js"];
// 专注模式's legal values: READER_OPTIONS alone; every default is one of them; content.js steps and cycles through it,
// and reads 字间距 only from its own setting.
for (const [key, list] of Object.entries(S.READER_OPTIONS)) assert.ok(list.includes(S.DEFAULTS[key]), key);
for (const list of Object.values(S.READER_OPTIONS)) {
  for (const file of sources) assert.ok(!read(file).includes(JSON.stringify(list).replace(/,/g, ", ")), `${file} writes ${list} itself`);
}
assert.ok(!/readerLetterSpacing \?\? \w+\?\.readerLineHeight/.test(read("content.js")), "字间距 falls back to 行间距");

// 观看进度's legal values: SEEN_SHOW alone; seenOn is the one test of 开 (background, settings page, triage-bg).
assert.deepStrictEqual(["bar", "both", "x", undefined, "off"].map(S.normalizeSeenShow), ["bar", "both", "off", "off", "off"]);
assert.deepStrictEqual(["mark", "x", "off"].map(S.seenOn), [true, false, false]);
for (const file of [...sources, "bili-surfaces.js", "badges.js"]) assert.ok(!/\["bar", "mark", "both"\]/.test(read(file)), `${file} lists seenShow's values itself`);

// 看到多少算看完了: SEEN_THRESHOLD is its range and default (DEFAULTS reads it); intIn's rule.
const { min, max, def } = S.SEEN_THRESHOLD;
assert.strictEqual(S.DEFAULTS.seenThreshold, def);
assert.deepStrictEqual([-5, "", " ", null, undefined, "x", min - 1, min - 0.6, min, 42.6, "42", max + 50].map(S.normalizeSeenThreshold), [def, def, def, def, def, def, def, def, min, 43, 42, max]);

// The default prompts are written only in settings.js (dev mocks may seed their own).
const texts = [S.DEFAULTS.playerAiQuickPrompt, ...S.DEFAULTS.aiPresetPrompts, S.DEFAULTS.aiSystemPrompt.split("\n").find((line) => line.includes("Emoji"))];
for (const t of texts) {
  for (const file of sources) assert.ok(!read(file).includes(t), `${file} writes 「${t}」 itself`);
}
assert.deepStrictEqual([...S.normalizeAiPresetPrompts([" a ", "", "a", 5, null, ...Array.from({ length: 20 }, (_, i) => `q${i}`)])].slice(0, 3), ["a", "5", "q0"]);
assert.strictEqual(S.normalizeAiPresetPrompts(Array.from({ length: 20 }, (_, i) => `q${i}`)).length, S.MAX_PRESET_PROMPTS);
assert.deepStrictEqual([...S.normalizeAiPresetPrompts("a")], []);
for (const name of ["normalizeAiPresetPrompts", "normalizeApiKey", "normalizeDownloadFormat", "normalizePlayerAiQuickPrompt", "normalizeFixedPropertyType", "normalizeFixedPropertyValue", "isFixedPropertyRowEffectivelyEmpty", "normalizeFixedFrontmatterProperties", "normalizeNoteSectionPosition", "normalizeNotePlaceholderSections", "normalizeReaderTheme"]) {
  for (const file of sources) assert.ok(!new RegExp(`function ${name}\\(`).test(read(file)), `${file} defines ${name} again`);
}

console.log("settings selftest ok");
