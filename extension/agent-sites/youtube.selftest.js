// node extension/agent-sites/youtube.selftest.js
const assert = require("assert");
const S = require("./registry.selftest.js").load("bilibili.js", "youtube.js");

const keys = {
  "https://www.youtube.com/watch?v=abc&t=30": "youtube:abc:",
  "https://youtube.com/watch?v=abc": "youtube:abc:",
  "https://www.youtube.com/": null,
  "https://www.youtube.com/watch": null,
  "https://www.youtube.com/shorts/abc": null,
  "https://m.youtube.com/watch?v=abc": null
};
for (const [href, key] of Object.entries(keys)) assert.strictEqual(S.keyOf(href), key, href);
assert.strictEqual(S.get("youtube").read, "content");
console.log("agent-sites youtube selftest ok");
