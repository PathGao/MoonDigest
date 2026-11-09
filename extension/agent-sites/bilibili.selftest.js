// node extension/agent-sites/bilibili.selftest.js
const assert = require("assert");
const S = require("./registry.selftest.js").load("bilibili.js", "youtube.js");

const keys = {
  "https://www.bilibili.com/video/BV1xx411c7mD": "bilibili:BV1xx411c7mD:1",
  "https://www.bilibili.com/video/BV1xx411c7mD/?p=2&spm_id_from=x": "bilibili:BV1xx411c7mD:2",
  "https://bilibili.com/video/av170001": "bilibili:av170001:1",
  "https://www.bilibili.com/bangumi/play/ep12345": "bilibili:ep12345:",
  "https://www.bilibili.com/bangumi/play/ss678/": "bilibili:ss678:",
  "https://www.bilibili.com/list/ml123?bvid=BV1yy&p=3": "bilibili:BV1yy:3",
  "https://www.bilibili.com/list/watchlater": "bilibili:/list/watchlater:1",
  "https://www.bilibili.com/festival/2024bnj?bvid=BV1zz": "bilibili:BV1zz:1",
  "https://www.bilibili.com/": null,
  "https://www.bilibili.com/video/": null,
  "https://space.bilibili.com/123/video": null,
  "https://www.bilibili.com.evil.test/video/BV1xx411c7mD": null
};
for (const [href, key] of Object.entries(keys)) assert.strictEqual(S.keyOf(href), key, href);
// m.bilibili.com and the bare domain load as www (the content script runs there); b23.tv is left alone.
assert.strictEqual(S.canonical("https://m.bilibili.com/video/BV1xx411c7mD?p=2"), "https://www.bilibili.com/video/BV1xx411c7mD?p=2");
assert.strictEqual(S.canonical("https://bilibili.com/video/av170001"), "https://www.bilibili.com/video/av170001");
assert.strictEqual(S.canonical("https://b23.tv/abc"), "https://b23.tv/abc");
assert.strictEqual(S.get("bilibili").read, "content");

// 稍后再看 through the 分拣台's requests (triage-bg.js), stubbed here: list pages, has, write by aid.
(async () => {
  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");
  const bv = (n) => `BV1toview${String(n).padStart(3, "0")}`;
  let list = Array.from({ length: 25 }, (_, i) => ({ bvid: bv(i), aid: 100 + i, title: `t${i}`, upper: "UP", duration: 60, invalid: i === 1 }));
  const posts = [];
  const gets = [];
  const ctx = vm.createContext({
    URL,
    TRIAGE_BILI_API: "https://api.bilibili.com",
    triageToviewList: async () => list,
    triageToviewItem: (m) => m,
    triageBiliGet: async (url) => (gets.push(url), { aid: 999 }),
    triageBiliPost: async (p, fields) => posts.push([p, fields])
  });
  for (const f of ["registry.js", "bilibili.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, { filename: f });
  const B = ctx.MdgAgentSites.get("bilibili");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(B.collections)), { watch_later: ["add", "remove"] });

  const p1 = await B.list({ kind: "watch_later", cursor: "" });
  assert.deepStrictEqual([p1.items.length, p1.cursor, p1.items[0].url, p1.items[1].unavailable, p1.items[0].unavailable], [20, "20", `https://www.bilibili.com/video/${bv(0)}`, true, undefined]);
  const p2 = await B.list({ kind: "watch_later", cursor: p1.cursor });
  assert.deepStrictEqual([p2.items.length, p2.cursor], [5, ""]);
  await assert.rejects(B.list({ kind: "watch_later", cursor: "x" }), /cursor/);

  assert.strictEqual(await B.has({ kind: "watch_later", item: bv(3) }), true);
  assert.strictEqual(await B.has({ kind: "watch_later", item: "BV1notthere0" }), false);
  await assert.rejects(B.has({ kind: "watch_later", item: "dQw4w9WgXcQ" }), (e) => e.code === "BAD_PARAMS");

  // A removal takes the aid from the list (no view request); an add asks the video's page data for it.
  await B.write({ kind: "watch_later", op: "remove", item: bv(3) });
  await B.write({ kind: "watch_later", op: "add", item: "BV1notthere0" });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(posts)), [["/x/v2/history/toview/del", { aid: 103 }], ["/x/v2/history/toview/add", { aid: 999 }]]);
  assert.deepStrictEqual(gets, ["https://api.bilibili.com/x/web-interface/view?bvid=BV1notthere0"]);
  await assert.rejects(B.write({ kind: "watch_later", op: "remove", item: "BV1notthere0" }), /not found/);
  assert.strictEqual(posts.length, 2, "nothing sent without an aid");
  console.log("agent-sites bilibili selftest ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
