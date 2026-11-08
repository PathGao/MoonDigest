// node extension/agent-sites/tiktok.selftest.js
const assert = require("assert");
const vm = require("vm");
const S = require("./registry.selftest.js").load("tiktok.js");

const keys = {
  "https://www.tiktok.com/@hankgreen1/video/7047596209028074758?lang=en": "tiktok:7047596209028074758:",
  "https://www.tiktok.com/@/video/7047596209028074758/": "tiktok:7047596209028074758:",
  "https://www.tiktok.com/@hankgreen1": null,
  "https://www.tiktok.com/@hankgreen1/photo/7047596209028074758": null,
  "https://m.tiktok.com/@a/video/1": null,
  "https://www.tiktok.com.evil.test/@a/video/1": null
};
for (const [href, key] of Object.entries(keys)) assert.strictEqual(S.keyOf(href), key, href);

// read as Chrome runs it: its source text, evaluated in the page (here a sandbox with a fake document and fetch).
const URL1 = "https://www.tiktok.com/@hankgreen1/video/7047596209028074758";
function run(scope, { captcha = false, vtt = "", url = URL1 } = {}) {
  const fetched = [];
  const page = {
    URL,
    document: {
      querySelector: () => (captcha ? {} : null),
      getElementById: (id) => (id === "__UNIVERSAL_DATA_FOR_REHYDRATION__" && scope ? { textContent: JSON.stringify({ __DEFAULT_SCOPE__: scope }) } : null)
    },
    fetch: async (u) => { fetched.push(u); return { ok: true, text: async () => vtt }; }
  };
  const read = vm.runInNewContext(`(${S.get("tiktok").read.toString()})`, page);
  // JSON round trip: the sandbox's objects have its own prototypes, as Chrome's structured clone drops them too.
  return read(url).then((data) => ({ data: data == null ? data : JSON.parse(JSON.stringify(data)), fetched: [...fetched] }));
}

// Trimmed from a live www.tiktok.com page (2026-11): webapp.video-detail.itemInfo.itemStruct.
const item = {
  id: "7047596209028074758", desc: "bippity bottoms\n#fyp", createTime: "1640896362",
  author: { uniqueId: "hankgreen1", nickname: "Hank Green" },
  stats: { diggCount: 270400, shareCount: 5149, commentCount: 4404, playCount: 1400000, collectCount: "4094" },
  comments: [],
  video: {
    duration: 21, playAddr: "https://v16-webapp-prime.tiktok.com/video/x/",
    claInfo: { originalLanguageInfo: { language: "eng-US", languageCode: "en" } },
    subtitleInfos: [
      { LanguageCodeName: "deu-DE", Url: "https://v16-webapp.tiktok.com/sub-MT", Format: "webvtt", Source: "MT" },
      { LanguageCodeName: "eng-US", Url: "https://v16-webapp.tiktok.com/sub-LC", Format: "creator_caption", Source: "LC" },
      { LanguageCodeName: "eng-US", Url: "https://v16-webapp.tiktok.com/sub-MU", Format: "webvtt", Source: "MU" }
    ]
  }
};
const VTT = "WEBVTT\n\n\n00:00:00.044 --> 00:00:00.704\nOne of the things \n\n00:00:00.704 --> 00:00:01.843 align:start\nI don't love <i>about</i>\nour society \n\n00:01:02.000 --> 00:01:03.500\n\n";

(async () => {
  const { data, fetched } = await run({ "webapp.video-detail": { statusCode: 0, itemInfo: { itemStruct: item } } }, { vtt: VTT });
  assert.deepStrictEqual(fetched, ["https://v16-webapp.tiktok.com/sub-MU"], "original-language WebVTT over the machine translation");
  assert.deepStrictEqual(data, {
    url: URL1, videoId: "7047596209028074758", title: "bippity bottoms", author: "Hank Green",
    uploadDate: (() => { const t = new Date(1640896362000); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; })(),
    description: "bippity bottoms\n#fyp", duration: 21, part: { index: 1, count: 0, title: "" }, chapters: [],
    subtitle: { segments: [{ from: 0.044, to: 0.704, content: "One of the things" }, { from: 0.704, to: 1.843, content: "I don't love about our society" }], lang: "eng-US", warning: "", missing: "" },
    comments: [], stats: { views: 1400000, likes: 270400, comments: 4404, shares: 5149, saves: 4094 },
    playUrl: "https://v16-webapp-prime.tiktok.com/video/x/"
  });

  // No WebVTT track: no fetch, says why and where the audio is.
  const bare = { ...item, video: { ...item.video, subtitleInfos: [] } };
  const r2 = await run({ "webapp.video-detail": { statusCode: 0, itemInfo: { itemStruct: bare } } });
  assert.deepStrictEqual(r2.fetched, []);
  assert.match(r2.data.subtitle.missing, /no subtitle.*playUrl/);

  // Live shapes: a geo-fenced video (2026-11, from a mainland-China exit) and a deleted one.
  assert.deepStrictEqual((await run({ "webapp.video-detail": { statusCode: 10204, statusMsg: "person_geo_fencing" } })).data,
    { error: "TikTok does not show this video (person_geo_fencing)." });
  assert.match((await run({ "webapp.video-detail": { statusCode: 10204, statusMsg: "author_invalid,status_deleted" } })).data.error, /status_deleted/);
  // Not ready: no data yet, or another video's data.
  assert.strictEqual((await run(null)).data, null);
  assert.strictEqual((await run({ "webapp.video-detail": { statusCode: 0, itemInfo: { itemStruct: { ...item, id: "1" } } } })).data, null);
  assert.strictEqual((await run({ "webapp.video-detail": { statusCode: 0 } }, { captcha: true })).data.code, "THROTTLED");
  console.log("agent-sites tiktok selftest ok");
})().catch((e) => { console.error(e); process.exit(1); });
