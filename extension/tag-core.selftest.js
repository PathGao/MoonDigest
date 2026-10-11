// node extension/tag-core.selftest.js
// tag-core.js is the one copy of the tag rules: the pages that need them load it, and nobody writes their own again.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
const ctx = vm.createContext({});
vm.runInContext(read("tag-core.js"), ctx);
const T = ctx.BocTagCore;

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

// Loaded before its users: the manifest's badges.js entry and triage.html.
const manifest = JSON.parse(read("manifest.json"));
const badges = manifest.content_scripts.find((c) => c.js.includes("badges.js")).js;
assert.ok(badges.indexOf("tag-core.js") > -1 && badges.indexOf("tag-core.js") < badges.indexOf("badges.js"), "manifest loads tag-core.js before badges.js");
const html = read("triage/triage.html");
assert.ok(html.indexOf("../tag-core.js") > -1 && html.indexOf("../tag-core.js") < html.indexOf("./shared.js"), "triage.html loads tag-core.js before shared.js");

// note.js names the verdict in notes (BocNote.buildTriageSummary): every list that loads note.js loads tag-core.js first.
const before = (where, list) => assert.ok(list.indexOf("tag-core.js") > -1 && list.indexOf("tag-core.js") < list.indexOf("note.js"), `${where} loads tag-core.js before note.js`);
manifest.content_scripts.filter((c) => c.js.includes("note.js")).forEach((c, i) => before(`content_scripts[${i}]`, c.js));
before("background importScripts", [...read("background.js").matchAll(/importScripts\(([^)]*)\)/g)].flatMap((m) => m[1].match(/"[^"]+"/g).map((f) => JSON.parse(f))));
for (const page of ["sidepanel.html", "history/history.html", "dev-sidepanel/index.html"]) {
  before(page, [...read(page).matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => path.basename(m[1])));
}

// No second copy of the palette, the name rule or the id recipe outside tag-core.js.
for (const f of ["badges.js", "triage/shared.js", "triage/follow.js", "triage/triage.js", "triage/triage-bg.js", "note.js"]) {
  const src = read(f);
  assert.ok(!/keep:\s*"值得留"/.test(src), `${f} names the verdicts itself`);
  assert.ok(!src.includes('"#da86c3"'), `${f} has its own tag palette`);
  assert.ok(!/cleanTagName\s*=\s*\(/.test(src), `${f} defines its own cleanTagName`);
  assert.ok(!src.includes("Date.now().toString(36)"), `${f} makes its own tag ids`);
}

console.log("tag-core selftest passed");
