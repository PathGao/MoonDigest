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
assert.strictEqual(S.get("bilibili").read, "content");
console.log("agent-sites bilibili selftest ok");
