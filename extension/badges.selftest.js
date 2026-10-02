// node extension/badges.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "badges.js"), "utf8"), ctx);
const { bvidFromHref, badgeInfo } = ctx.BocBadges;
const plain = (v) => JSON.parse(JSON.stringify(v));

assert.strictEqual(bvidFromHref("//www.bilibili.com/video/BV1GJ411x7h7?spm_id_from=333"), "BV1GJ411x7h7");
assert.strictEqual(bvidFromHref("/video/BV1eS4y157Ey/"), "BV1eS4y157Ey");
assert.strictEqual(bvidFromHref("https://www.bilibili.com/list/ml123?bvid=BV1oEga61EFk&oid=1"), "BV1oEga61EFk");
assert.strictEqual(bvidFromHref("https://www.bilibili.com/video/av170001"), "");
assert.strictEqual(bvidFromHref("https://space.bilibili.com/2773586"), "");
assert.strictEqual(bvidFromHref(null), "");

assert.strictEqual(badgeInfo({}), null, "no data, no mark");
assert.strictEqual(badgeInfo({ analysis: { status: "error", error: "x" } }), null, "failed analysis alone is not a mark");
assert.strictEqual(badgeInfo({ tagIds: ["gone"], tags: [] }), null, "dangling tag ids are not a mark");

const s1 = badgeInfo({ title: { verdict: "drop", reason: "标题党", confidence: "low" } });
assert.deepStrictEqual(plain(s1), {
  label: "删?",
  aria: "MoonDigest 分拣，建议删（标题粗分，低置信）",
  verdict: "drop",
  stage: 1,
  low: true,
  action: "",
  reason: "标题党",
  oneLiner: "",
  points: [],
  tags: []
});

const analysis = { status: "done", verdict: "keep", reason: "干货", oneLiner: "讲 Rust 所有权", points: ["a", "b", ""] };
const s2 = badgeInfo({ title: { verdict: "drop", reason: "x", confidence: "high" }, analysis });
assert.strictEqual(s2.label, "留", "stage 2 beats stage 1");
assert.strictEqual(s2.stage, 2);
assert.strictEqual(s2.oneLiner, "讲 Rust 所有权");
assert.deepStrictEqual(plain(s2.points), ["a", "b"]);

const o = badgeInfo({ analysis, override: { verdict: "unsure", reason: "再看看" } });
assert.strictEqual(o.label, "待定", "override beats analysis");
assert.strictEqual(o.reason, "再看看");
assert.strictEqual(o.oneLiner, "讲 Rust 所有权", "override keeps the stage-2 summary");

const tags = [{ id: "t1", name: "Rust", color: "#f60" }];
const tagOnly = badgeInfo({ tagIds: ["t1"], tags });
assert.strictEqual(tagOnly.label, "");
assert.deepStrictEqual(plain(tagOnly.tags), [{ name: "Rust", color: "#f60" }]);
assert.strictEqual(tagOnly.aria, "MoonDigest 分拣，标签：Rust");

const decided = badgeInfo({ title: { verdict: "keep", confidence: "high" }, decision: { action: "unfav", at: 1 } });
assert.strictEqual(decided.label, "已删", "a user decision outranks the AI verdict in the label");
assert.strictEqual(decided.verdict, "keep");

assert.strictEqual(badgeInfo({ title: { verdict: "bogus" } }), null, "unknown verdicts are ignored");

console.log("badges selftest ok");
