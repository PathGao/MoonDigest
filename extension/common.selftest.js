// /usr/local/bin/node extension/common.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({});
ctx.globalThis = ctx;
const src = fs.readFileSync(path.join(__dirname, "common.js"), "utf8");
vm.runInContext(src, ctx);
const first = ctx.MdgCommon;
vm.runInContext(src, ctx); // re-injection keeps the first copy
assert.strictEqual(ctx.MdgCommon, first);
const C = ctx.MdgCommon;

// The local day, from ms or a Date (export file names, notes, 分拣台's dates; the side panel adds the time itself).
const morning = new Date(2026, 9, 14, 7, 30);
assert.deepStrictEqual([C.localDate(morning), C.localDate(morning.getTime()), C.localDate(morning, true)], ["2026-10-14", "2026-10-14", "2026-10-14-0730"]);

// C533: one file-name rule for notes, downloads and 分拣台's exports: whitespace folds, at most 120 characters, the
// fallback when nothing is left.
assert.strictEqual(C.fileName("第1集 #AI [合集] ^x|y"), "第1集 _AI _合集_ _x_y");
assert.strictEqual(C.fileName("稍后\n再看  a/b", "收藏夹"), "稍后 再看 a_b");
assert.strictEqual(C.fileName("字".repeat(130)).length, 120);
// R6: 120 code points, so an emoji at the cut stays whole and encodeURIComponent (obsidian.js vaultEndpoint) takes it.
const cut = C.fileName(`${"a".repeat(119)}😀tail`);
assert.ok(cut.endsWith("😀") && encodeURIComponent(cut));
// R36: no leading dot, which Obsidian skips; dots alone fall back.
assert.deepStrictEqual([C.fileName(".NET 入门"), C.fileName(" . .x"), C.fileName("...", "f")], ["NET 入门", "x", "f"]);
assert.deepStrictEqual([C.fileName("  ", "收藏夹"), C.fileName(undefined), C.fileName(null, "video-subtitle")], ["收藏夹", "", "video-subtitle"]);

// C356, C385: one h:mm:ss parser, -1 for a malformed time (the callers decide what that means).
assert.deepStrictEqual(["1:02:03", "12:34", "0:05", " 9 : 07 "].map(C.parseTimestamp), [3723, 754, 5, 547]);
assert.deepStrictEqual(["", "12:3x", "1::2", "-1:00", "1.5:00", null].map(C.parseTimestamp), [-1, -1, -1, -1, -1, -1]);

// C383: one count parser for YouTube's and B站's texts; thousands separators are dropped, not read as the end.
assert.deepStrictEqual(["322K", "1.2M", "1,234", "12.5万", "1.2亿", "3萬", 2505, "2505"].map(C.parseCount), [322000, 1200000, 1234, 125000, 120000000, 30000, 2505, 2505]);
assert.deepStrictEqual(["-", "", null, undefined].map(C.parseCount), [0, 0, 0, 0]);

assert.deepStrictEqual(Object.keys(C.SUBTITLE_LANGS), ["zh-Hans", "zh-Hant", "en", "ja"]);
assert.ok(Object.values(C.PAGES).every((p) => fs.existsSync(path.join(__dirname, p))), "every page path exists");
console.log("common selftest ok");
