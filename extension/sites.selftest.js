// node extension/sites.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({ URL, URLSearchParams, console });
vm.runInContext(fs.readFileSync(path.join(__dirname, "sites.js"), "utf8"), ctx);
const S = ctx.BocSites;
// vm objects have a foreign Object prototype, so compare by value.
const eq = (actual, expected) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected);

// Bilibili URLs
eq(S.parseRef("https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333&p=3"), {
  site: "bilibili",
  id: "BV1GJ411x7h7",
  part: { index: 3, explicit: true, oid: "" },
  url: "https://www.bilibili.com/video/BV1GJ411x7h7/?p=3"
});
assert.strictEqual(S.cleanUrl("https://www.bilibili.com/video/BV1GJ411x7h7?p=1&t=12"), "https://www.bilibili.com/video/BV1GJ411x7h7/");
assert.strictEqual(S.parseRef("https://www.bilibili.com/list/watchlater?bvid=BV1GJ411x7h7&oid=123").part.oid, "123");
assert.strictEqual(S.matchSite("https://www.bilibili.com/list/watchlater/").id, "bilibili");
assert.strictEqual(S.matchSite("https://www.bilibili.com/"), null);
assert.strictEqual(S.parseRef("https://example.com/video/BV1GJ411x7h7"), null);
assert.strictEqual(S.isAllowedFetchUrl("https://api.bilibili.com/x/web-interface/view?bvid=1"), true);
assert.strictEqual(S.isAllowedFetchUrl("https://i0.hdslb.com/bfs/x.jpg"), true);
assert.strictEqual(S.isAllowedFetchUrl("https://evil.com/?hdslb.com"), false);
assert.strictEqual(S.isAllowedFetchUrl("http://api.bilibili.com/x"), false);

// Track ranking: zh, then en; default and manual before auto within a language.
const ranked = S.rankTracks([
  { id: "1", lang: "en", label: "English", url: "u1", kind: "auto" },
  { id: "2", lang: "ai-zh", label: "中文（自动生成）", url: "u2", kind: "ai" },
  { id: "3", lang: "zh-CN", label: "中文（中国）", url: "u3", kind: "manual" },
  { id: "4", lang: "en", label: "English", url: "u4", kind: "manual" },
  { id: "5", lang: "ja", label: "日本語", url: "u5", kind: "manual", isDefault: true }
]);
eq(ranked.map((item) => item.id), ["3", "2", "4", "1", "5"]);
assert.strictEqual(S.pickPreferredTrack(ranked, { previousId: "5" }).id, "5");
assert.strictEqual(S.pickPreferredTrack(ranked, { previousUrl: "https://a.com/u4?auth=1" }).id, "3");
assert.strictEqual(S.pickPreferredTrack(ranked, { previousLang: "english" }).id, "4");
assert.strictEqual(S.pickPreferredTrack(ranked).id, "3");
assert.strictEqual(S.trackUrlKey("https://a.com/p/x.json?auth_key=1"), "a.com/p/x.json");

// Description chapters
eq(
  S.parseChaptersFromDescription("Intro\n00:00 Start\n01:30 - Setup & config\n[1:02:03] End\nnot 12:34 a chapter? 99:99"),
  [
    { title: "Start", from: 0, to: 0 },
    { title: "Setup & config", from: 90, to: 0 },
    { title: "End", from: 3723, to: 0 }
  ]
);
eq(S.parseChaptersFromDescription("01:00 Only one after zero"), []);
eq(S.parseChaptersFromDescription("00:30 a\n01:00 b"), []);
assert.strictEqual(S.buildContextKey({ site: "bilibili", videoId: "BV1", cid: "9" }), "video:bilibili:BV1|9");
assert.strictEqual(S.buildContextKey({ site: "youtube", videoId: "abc" }), "video:youtube:abc|");
assert.strictEqual(S.buildContextKey({}), "");

// YouTube URLs
for (const url of [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&index=2&t=30s&si=abc&pp=xyz",
  "https://youtu.be/dQw4w9WgXcQ?si=abc",
  "https://www.youtube.com/shorts/dQw4w9WgXcQ",
  "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1",
  "https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ"
]) {
  eq(S.parseRef(url), { site: "youtube", id: "dQw4w9WgXcQ", part: null, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
}
assert.strictEqual(S.parseRef("https://www.youtube.com/"), null);
assert.strictEqual(S.parseRef("https://www.youtube.com/watch?v=short"), null);
assert.strictEqual(S.parseRef("https://www.youtube.com/@channel/videos"), null);
assert.strictEqual(S.isAllowedFetchUrl("https://www.youtube.com/youtubei/v1/player"), true);

// srv3: attribute order, spaces inside <s>, entities decoded once, numeric entities
const srv3 = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>
<p d="1500" t="1000"><s>hello</s><s t="500"> world</s><s t="900"> &amp;lt;tag&amp;gt;</s></p>
<p t="3000" d="2000" w="1">it&#39;s &#x27;quoted&#x27; &amp; done<br/>next</p>
<p t="6000" d="100"></p>
<p t="7000" d="100" a="1"><s>Ça</s><s> va?</s></p>
</body></timedtext>`;
eq(S.parseSrv3(srv3), [
  { from: 1, to: 2.5, content: "hello world &lt;tag&gt;" },
  { from: 3, to: 5, content: "it's 'quoted' & done next" },
  { from: 7, to: 7.1, content: "Ça va?" }
]);
assert.strictEqual(S.decodeXmlEntities("&amp;amp;"), "&amp;");

// json3: aAppend word events skipped, newline segments collapsed
eq(S.parseJson3({ events: [
  { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "first" }, { utf8: "\n" }, { utf8: "line" }] },
  { tStartMs: 500, dDurationMs: 200, aAppend: 1, segs: [{ utf8: " line" }] },
  { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "\n" }] },
  { tStartMs: 2000, segs: [{ utf8: "no duration" }] }
] }), [
  { from: 0, to: 1, content: "first line" },
  { from: 2, to: 2, content: "no duration" }
]);

console.log("sites selftest ok");
