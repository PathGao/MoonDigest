// node extension/agent-sites/xiaoyuzhou.selftest.js
const assert = require("assert");
const vm = require("vm");
const S = require("./registry.selftest.js").load("xiaoyuzhou.js");

const keys = {
  "https://www.xiaoyuzhoufm.com/episode/6a7726aac4079d62c57f5185": "xiaoyuzhou:6a7726aac4079d62c57f5185:",
  "https://xiaoyuzhoufm.com/episode/6a7726aac4079d62c57f5185/?s=share": "xiaoyuzhou:6a7726aac4079d62c57f5185:",
  "https://www.xiaoyuzhoufm.com/podcast/5e280fab418a84a0461faa3c": null,
  "https://www.xiaoyuzhoufm.com/": null,
  "https://www.xiaoyuzhoufm.com.evil.test/episode/6a7726aac4079d62c57f5185": null
};
for (const [href, key] of Object.entries(keys)) assert.strictEqual(S.keyOf(href), key, href);

// A real episode page's __NEXT_DATA__, trimmed to the fields read (2026-11-09).
const NEXT = { props: { pageProps: {
  episode: { eid: "6a7726aac4079d62c57f5185", title: "No.229 对话少数派老麦：从 Palm、WebOS 到 AI 硬件，依然不想成为多数派", duration: 3630,
    pubDate: "2026-08-11T12:00:00.000Z", enclosure: { url: "https://media.xyzcdn.net/5e280fab418a84a0461faa3c/luf34bdBuAypd09__G30J1XhwWCW.m4a" },
    description: "嘉宾｜老麦，少数派创始人。\n主播｜刘飞，内容创作者，产品经理。", podcast: { title: "三五环", author: "后厂村的刘飞" } },
  comments: [{ author: { nickname: "早起川" }, likeCount: 9, text: "Palm WebOS 这个词居然还能被看到！" }]
} } };

// Run read the way executeScript does: from its source, in a world with only the page's globals.
const readIn = (win) => vm.runInNewContext(`(${S.get("xiaoyuzhou").read})`, { window: win, URL });
const url = "https://www.xiaoyuzhoufm.com/episode/6a7726aac4079d62c57f5185";
const d = JSON.parse(JSON.stringify(readIn({ __NEXT_DATA__: NEXT })(url))); // out of the vm realm, as executeScript returns it
assert.strictEqual(d.videoId, "6a7726aac4079d62c57f5185");
assert.strictEqual(d.title, NEXT.props.pageProps.episode.title);
assert.strictEqual(d.author, "三五环 / 后厂村的刘飞");
assert.strictEqual(d.uploadDate, "2026-08-11");
assert.strictEqual(d.duration, 3630);
assert.match(d.description, /^嘉宾/);
assert.deepStrictEqual(d.subtitle.segments, []);
assert.match(d.subtitle.missing, /Transcribe the audio \(playUrl\) instead\.$/);
assert.match(d.playUrl, /^https:\/\/media\.xyzcdn\.net\/.+\.m4a$/);
assert.deepStrictEqual(d.comments, [{ uname: "早起川", like: 9, message: "Palm WebOS 这个词居然还能被看到！" }]);
// Not ready: no data yet, or another episode's.
assert.strictEqual(readIn({})(url), null);
assert.strictEqual(readIn({ __NEXT_DATA__: NEXT })("https://www.xiaoyuzhoufm.com/episode/other"), null);
// A removed episode: the 404 page's __NEXT_DATA__ (fetched 2026-11-09) is the call's error, not "not ready" for 50 s.
assert.deepStrictEqual({ ...readIn({ __NEXT_DATA__: { props: { pageProps: {} }, page: "/404", query: {} } })(url) },
  { error: "Xiaoyuzhou has no such episode (removed, or a wrong link)." });
console.log("agent-sites xiaoyuzhou selftest ok");
