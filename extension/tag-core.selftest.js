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

// Loaded before its users: the manifest's badges.js entry and triage.html.
const manifest = JSON.parse(read("manifest.json"));
const badges = manifest.content_scripts.find((c) => c.js.includes("badges.js")).js;
assert.ok(badges.indexOf("tag-core.js") > -1 && badges.indexOf("tag-core.js") < badges.indexOf("badges.js"), "manifest loads tag-core.js before badges.js");
const html = read("triage/triage.html");
assert.ok(html.indexOf("../tag-core.js") > -1 && html.indexOf("../tag-core.js") < html.indexOf("./shared.js"), "triage.html loads tag-core.js before shared.js");

// No second copy of the palette, the name rule or the id recipe outside tag-core.js.
for (const f of ["badges.js", "triage/shared.js", "triage/follow.js"]) {
  const src = read(f);
  assert.ok(!src.includes('"#da86c3"'), `${f} has its own tag palette`);
  assert.ok(!/cleanTagName\s*=\s*\(/.test(src), `${f} defines its own cleanTagName`);
  assert.ok(!src.includes("Date.now().toString(36)"), `${f} makes its own tag ids`);
}

console.log("tag-core selftest passed");
