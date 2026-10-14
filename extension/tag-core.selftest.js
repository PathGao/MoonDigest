// node extension/tag-core.selftest.js
// tag-core.js is the one copy of the tag rules: nobody writes their own again (load-order.selftest.js checks who loads it).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
const ctx = vm.createContext({});
vm.runInContext(read("tag-core.js"), ctx);
const T = ctx.MdgTagCore;

assert.strictEqual(T.cleanTagName(" 学，习、ab,c "), "学习abc");
assert.strictEqual(T.cleanTagName("一二三四五六七八九十一二三"), "一二三四五六七八九十一二");
assert.strictEqual(T.nextTagColor([{ color: T.TAG_COLORS[0] }]), T.TAG_COLORS[1]);
assert.strictEqual(T.cycleTagColor(T.TAG_COLORS.at(-1)), T.TAG_COLORS[0]);
assert.match(T.newTagId("ft"), /^ft[0-9a-z]{9,}$/);

// The verdict, as the triage page and B站 pages show it.
const V = (x) => JSON.parse(JSON.stringify(T.verdictOf(x)));
assert.deepStrictEqual(V({}), { verdict: "none", reason: "", stage: -1 });
assert.deepStrictEqual(V({ title: { verdict: "drop", reason: "r", confidence: "low" } }), { verdict: "drop", reason: "r", stage: 1, low: true });
assert.deepStrictEqual(V({ title: { verdict: "t-must" } }), { verdict: "none", reason: "", stage: -1 }, "an old custom-tier 粗分 is not classified");
assert.deepStrictEqual(V({ title: { verdict: "keep" }, analysis: { status: "done", verdict: "t-must", reason: "a" } }), { verdict: "unsure", reason: "a", stage: 2 }, "细看 wins; unknown = 拿不准");
assert.deepStrictEqual(V({ analysis: { status: "error" } }), { verdict: "none", reason: "", stage: -1 });
assert.deepStrictEqual(V({ invalid: true }), { verdict: "drop", reason: "视频已失效", stage: 0 });
assert.deepStrictEqual(V({ invalid: true, analysis: { status: "done", verdict: "keep", reason: "好" } }), { verdict: "drop", reason: "视频已失效。AI 原理由：好", stage: 2 });

// No second copy of the palette, the name rule or the id recipe outside tag-core.js.
for (const f of ["badges.js", "triage/shared.js", "triage/follow.js", "triage/triage.js", "triage/triage-bg.js", "note.js"]) {
  const src = read(f);
  assert.ok(!/keep:\s*"值得留"/.test(src), `${f} names the verdicts itself`);
  assert.ok(!src.includes('"#da86c3"'), `${f} has its own tag palette`);
  assert.ok(!/cleanTagName\s*=\s*\(/.test(src), `${f} defines its own cleanTagName`);
  assert.ok(!src.includes("Date.now().toString(36)"), `${f} makes its own tag ids`);
}

// A tag name's cap is TAG_NAME_MAX alone: cleanTagName cuts there and every name box (B站 page, picker, dialogs) reads it.
assert.strictEqual(T.cleanTagName("一".repeat(30)).length, T.TAG_NAME_MAX);
for (const f of ["badges.js", "triage/triage.html", "triage/shared.js", "triage/tag-dialogs.js", "triage/tag-picker.js", "triage/follow.js", "triage/triage.js"]) {
  assert.ok(!/maxlength="12"|maxLength = 12|newMax: 12/i.test(read(f)), `${f} writes the tag name cap itself`);
}

console.log("tag-core selftest passed");
