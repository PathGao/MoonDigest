// node extension/sites.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const crypto = require("crypto");

// In-memory chrome.storage.local for the subtitle cache.
const store = {};
const chrome = {
  storage: {
    local: {
      get: async (key) => (key === null ? { ...store } : key in store ? { [key]: store[key] } : {}),
      set: async (items) => Object.assign(store, items),
      remove: async (keys) => [].concat(keys).forEach((key) => delete store[key])
    }
  }
};
const ctx = vm.createContext({ URL, URLSearchParams, TextEncoder, console, chrome });
// Manifest order: limits.js before sites.js.
for (const file of ["limits.js", "sites.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), ctx);
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
// av links stay on av in the address bar; av170001 → BV17x411w7KC was read off the real page.
assert.strictEqual(S.parseRef("https://www.bilibili.com/video/av170001/?vd_source=x").id, "BV17x411w7KC");
assert.strictEqual(S.parseRef("https://www.bilibili.com/video/av1").id, "BV1xx411c7mQ");
// A deleted or hidden video falls back to a conversation-only note; risk control and other failures do not.
for (const code of [-404, 62002, 62012]) assert.strictEqual(S.isBiliVideoGone(code), true, code);
for (const code of [62004, "THROTTLED", -352, -412, -101, -403, undefined]) assert.strictEqual(S.isBiliVideoGone(code), false, code);
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

// YouTube default subtitle language: native tracks in the target first,
// then a machine translation of a translatable (manual-first) source.
const ytTracks = [
  { id: "a.en", lang: "en", label: "English", url: "https://y/t?v=1&lang=en", kind: "auto", translatable: true },
  { id: ".de", lang: "de-DE", label: "German", url: "https://y/t?v=1&lang=de", kind: "manual", isDefault: true, translatable: true },
  { id: ".en", lang: "en", label: "English", url: "https://y/t?v=1&lang=en&m=1", kind: "manual", translatable: true },
  { id: ".zh-TW", lang: "zh-TW", label: "中文（台灣）", url: "https://y/t?v=1&lang=zh-TW", kind: "manual", translatable: false }
];
const ytRef = { id: "dQw4w9WgXcQ" };
// A player response whose caption list is the given tracks.
function ytPlayer(tracks, extra = {}) {
  return {
    videoDetails: { videoId: ytRef.id, title: "T" },
    playabilityStatus: { status: "OK" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: tracks.map((t) => ({ vssId: t.id, languageCode: t.lang, name: { simpleText: t.label }, baseUrl: t.url, kind: t.kind === "auto" ? "asr" : undefined, isTranslatable: t.translatable })),
        audioTracks: [{ defaultCaptionTrackIndex: tracks.findIndex((t) => t.isDefault) }]
      }
    },
    ...extra
  };
}
const ytIds = async (target, tracks = ytTracks) =>
  S.rankTracks((await S.SITES.youtube.fetchTracks(ytRef, {}, { subtitleLang: target, readPlayer: async () => ytPlayer(tracks) })).tracks, target).map((item) => item.id);
const ytTracksOf = async (target, tracks) => (await S.SITES.youtube.fetchTracks(ytRef, {}, { subtitleLang: target, readPlayer: async () => ytPlayer(tracks) })).tracks;
// The YouTube adapter keeps one video's player responses in memory, so its
// async test blocks run one after another.
async function ytLanguageTests() {
  eq(await ytIds("auto"), [".zh-TW", ".en", "a.en", ".de"]);
  eq(await ytIds("en"), [".en", "a.en", ".zh-TW", ".de"]);
  eq(await ytIds("zh-Hant"), [".zh-TW", ".en", "a.en", ".de"]);
  eq((await ytIds("zh-Hans"))[0], ".en>zh-Hans");
  const [translated] = S.rankTracks(await ytTracksOf("zh-Hans", ytTracks), "zh-Hans");
  eq(translated, { id: ".en>zh-Hans", lang: "zh-Hans", label: "简体中文（机器翻译，自English）", url: "https://y/t?v=1&lang=en&m=1&fmt=json3&tlang=zh-Hans", kind: "translated", isDefault: false });
  // A manual source beats an auto one in a higher-ranked language.
  eq((await ytTracksOf("ja", ytTracks.slice(0, 2)))[2].id, ".de>ja");
  // Only untranslatable tracks: nothing to add.
  eq((await ytTracksOf("ja", [ytTracks[3]])).length, 1);
  // An auto-only video translates its auto track.
  eq((await ytTracksOf("ja", [ytTracks[0]]))[1].url, "https://y/t?v=1&lang=en&fmt=json3&tlang=ja");
  // Under auto a video without Chinese offers zh-Hans, ranked after every native track.
  const noZh = ytTracks.slice(0, 3);
  const autoNoZh = S.rankTracks(await ytTracksOf("auto", noZh), "auto");
  eq(autoNoZh.map((item) => item.id), [".en", "a.en", ".de", ".en>zh-Hans"]);
  eq(autoNoZh[3].url, "https://y/t?v=1&lang=en&m=1&fmt=json3&tlang=zh-Hans");
  eq(S.pickPreferredTrack(autoNoZh).id, ".en");
  eq(S.rankTracks(await ytTracksOf(undefined, noZh)).at(-1).id, ".en>zh-Hans");
  // Any native Chinese track, Traditional included, means nothing is added under auto.
  eq((await ytTracksOf("auto", ytTracks)).length, ytTracks.length);
  assert.strictEqual(S.normalizeSubtitleLang("zh-Hans"), "zh-Hans");
  assert.strictEqual(S.normalizeSubtitleLang("fr"), "auto");
  assert.strictEqual(S.normalizeSubtitleLang(undefined), "auto");
}
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

// Line breaks: no space between CJK neighbours, a space when either side is Latin
eq(S.parseJson3({ events: [
  { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "♪ 你懂规则，我也" }, { utf8: "\n" }, { utf8: "懂 ♪" }] },
  { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "日本語の\nテスト" }, { utf8: "\n" }, { utf8: "한국어" }] },
  { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: "ABC" }, { utf8: "\n" }, { utf8: "你好" }, { utf8: "\n" }, { utf8: "DEF" }] }
] }), [
  { from: 0, to: 1, content: "♪ 你懂规则，我也懂 ♪" },
  { from: 1, to: 2, content: "日本語のテスト한국어" },
  { from: 2, to: 3, content: "ABC 你好 DEF" }
]);
eq(S.parseSrv3('<p t="0" d="1000">你懂规则，<br/>我也懂</p><p t="1000" d="1000">hello<br/>世界<br />world</p>'), [
  { from: 0, to: 1, content: "你懂规则，我也懂" },
  { from: 1, to: 2, content: "hello 世界 world" }
]);

// A cached raw body re-parsed with the current parser gets its fixes (CJK join).
eq(S.SITES.youtube.parseSegments('<p t="0" d="1000">你懂规则，<br/>我也懂</p>'), [{ from: 0, to: 1, content: "你懂规则，我也懂" }]);
eq(S.SITES.youtube.parseSegments(JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "日本語の" }, { utf8: "\n" }, { utf8: "テスト" }] }] })), [{ from: 0, to: 1, content: "日本語のテスト" }]);
eq(S.SITES.bilibili.parseSegments({ body: [{ from: 1, to: 2, content: " 你好 " }, { from: 3, to: 4, content: "" }] }), [{ from: 1, to: 2, content: "你好" }]);

// YouTube comments. Current shape: trimmed from a live /next response for
// dQw4w9WgXcQ (2026-10-02), mutations reversed so order must come from threads.
const ytCurrent = {
  "onResponseReceivedEndpoints": [
    {
      "reloadContinuationItemsCommand": {
        "continuationItems": [
          {
            "commentThreadRenderer": {
              "commentViewModel": {
                "commentViewModel": {
                  "commentKey": "EhpVZ3pnZTM0MGRCZ0I3NWhXQm01NEFhQUJBZyAoKAE%3D"
                }
              }
            }
          },
          {
            "commentThreadRenderer": {
              "commentViewModel": {
                "commentViewModel": {
                  "commentKey": "EhpVZ3lFblhmZEMtdW13dlR0OEpGNEFhQUJBZyAoKAE%3D"
                }
              }
            }
          }
        ]
      }
    }
  ],
  "frameworkUpdates": {
    "entityBatchUpdate": {
      "mutations": [
        {
          "entityKey": "EhpVZ3lFblhmZEMtdW13dlR0OEpGNEFhQUJBZyAoKAE%3D",
          "payload": {
            "commentEntityPayload": {
              "key": "EhpVZ3lFblhmZEMtdW13dlR0OEpGNEFhQUJBZyAoKAE%3D",
              "properties": {
                "content": {
                  "content": "Gonna flag this for nudity so I can rick roll the YouTube staff"
                }
              },
              "author": {
                "displayName": "@Oatman69"
              },
              "toolbar": {
                "likeCountNotliked": "567K",
                "likeCountA11y": "567K likes"
              }
            }
          }
        },
        {
          "entityKey": "EhpVZ3pnZTM0MGRCZ0I3NWhXQm01NEFhQUJBZyAoKAE%3D",
          "payload": {
            "commentEntityPayload": {
              "key": "EhpVZ3pnZTM0MGRCZ0I3NWhXQm01NEFhQUJBZyAoKAE%3D",
              "properties": {
                "content": {
                  "content": "can confirm: he never gave us up"
                }
              },
              "author": {
                "displayName": "@YouTube"
              },
              "toolbar": {
                "likeCountNotliked": "322K",
                "likeCountA11y": "322K likes"
              }
            }
          }
        }
      ]
    }
  }
};
// Older shape with the comment inlined, sorted by "Newest" to force the Top switch.
const ytLegacy = {
  onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: { continuationItems: [
    { commentsHeaderRenderer: { sortMenu: { sortFilterSubMenuRenderer: { subMenuItems: [
      { title: "Top", selected: false, serviceEndpoint: { continuationCommand: { token: "top" } } },
      { title: "Newest", selected: true, serviceEndpoint: { continuationCommand: { token: "new" } } }
    ] } } } },
    { commentThreadRenderer: { comment: { commentRenderer: { authorText: { simpleText: "@a" }, contentText: { runs: [{ text: "first " }, { text: "line" }] }, voteCount: { simpleText: "1.2万" } } } } },
    { commentThreadRenderer: { comment: { commentRenderer: { authorText: { simpleText: "@b" }, contentText: { runs: [{ text: "x" }] }, voteCount: { simpleText: "1,234" } } } } },
    { commentThreadRenderer: { comment: { commentRenderer: { authorText: { simpleText: "@c" }, contentText: { runs: [] } } } } },
    { continuationItemRenderer: {} }
  ] } }]
};
const watchNext = (token) => ({ contents: { itemSectionRenderer: { sectionIdentifier: "comment-item-section", contents: token ? [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } }] : [] } } });
// io whose postJson answers /next by videoId or continuation and get_transcript
// by params or continuation, recording every call as "endpoint:key".
function ytIo(routes, extra = {}) {
  const calls = [];
  const io = {
    doc: { querySelectorAll: () => [{ textContent: '"INNERTUBE_API_KEY":"k","INNERTUBE_CLIENT_VERSION":"2.1","VISITOR_DATA":"vd"' }] },
    subtitleLang: "auto",
    postJson: async (url, body, headers) => {
      const endpoint = url.match(/\/v1\/(\w+)\?/)[1];
      const client = body.context.client.clientName;
      const key = endpoint === "player" ? `${client}:${body.videoId}` : body.videoId || body.continuation || body.params;
      calls.push(`${endpoint}:${key}`);
      assert.strictEqual(headers["X-Goog-Visitor-Id"], "vd");
      assert.strictEqual(headers["X-Youtube-Client-Name"], { WEB: "1", ANDROID: "3", WEB_EMBEDDED_PLAYER: "56" }[client]);
      if (client === "WEB_EMBEDDED_PLAYER") assert.strictEqual(body.context.thirdParty.embedUrl, `https://www.youtube.com/embed/${body.videoId}`);
      if (client === "ANDROID") assert.strictEqual(body.context.client.clientVersion, "21.26.364");
      const answer = routes[`${endpoint}:${key}`];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error(`unexpected call ${endpoint}:${key}`);
      return answer;
    },
    ...extra
  };
  return { io, calls };
}
const yt = S.SITES.youtube;
const ref = ytRef;
const pagePlayer = { readPlayer: async () => ytPlayer([ytTracks[3]]) };
// A load fetches tracks first (fresh /next), then comments reuse that response.
async function ytComments(next, byContinuation) {
  const { io, calls } = ytIo({ "next:dQw4w9WgXcQ": next, ...Object.fromEntries(Object.entries(byContinuation).map(([k, v]) => [`next:${k}`, v])) }, pagePlayer);
  await yt.fetchTracks(ref, {}, io);
  return { comments: await yt.fetchComments(ref, {}, io, 20), calls };
}
(async () => {
  await ytLanguageTests();
  let r = await ytComments(watchNext("c0"), { c0: ytCurrent });
  eq(r.calls, ["next:dQw4w9WgXcQ", "next:c0"]);
  eq(r.comments, [
    { uname: "@YouTube", like: 322000, message: "can confirm: he never gave us up" },
    { uname: "@Oatman69", like: 567000, message: "Gonna flag this for nudity so I can rick roll the YouTube staff" }
  ]);
  r = await ytComments(watchNext("c0"), { c0: ytLegacy, top: ytLegacy });
  eq(r.calls, ["next:dQw4w9WgXcQ", "next:c0", "next:top"]);
  eq(r.comments, [{ uname: "@a", like: 12000, message: "first line" }, { uname: "@b", like: 1234, message: "x" }]);
  // Comments turned off: the section has no continuation.
  r = await ytComments(watchNext(""), {});
  eq(r, { comments: [], calls: ["next:dQw4w9WgXcQ"] });
  const metaIo = (playabilityStatus, videoDetails) => ({
    doc: { querySelectorAll: () => [{ textContent: '"INNERTUBE_API_KEY":"k"' }] },
    postJson: async () => ({ playabilityStatus, videoDetails })
  });
  const metaError = (status) =>
    yt.fetchMeta(ref, metaIo(status)).then(() => "", (error) => error.message);
  eq(await metaError({ status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" }), "该视频需要登录或年龄验证，暂不支持（Sign in to confirm your age）");
  eq(await metaError({ status: "AGE_CHECK_REQUIRED" }), "该视频需要登录或年龄验证，暂不支持（AGE_CHECK_REQUIRED）");
  eq(await metaError({ status: "ERROR", reason: "Video unavailable" }), "视频不可播放：Video unavailable");
  // A gate that still ships videoDetails yields usable meta without tracks; the gate text travels with it.
  const gated = await yt.fetchMeta(ref, metaIo({ status: "LOGIN_REQUIRED", reason: "Sign in" }, { title: "T", lengthSeconds: "10" }));
  eq([gated.title, gated.duration, gated.gate], ["T", 10, "该视频需要登录或年龄验证，暂不支持（Sign in）"]);
  eq((await yt.fetchMeta(ref, metaIo({ status: "OK" }, { title: "T" }))).gate, "");

  // Chapters and transcript params from one /next; both chapter shapes.
  const chapterBar = (chapters) => ({ playerOverlays: { playerOverlayRenderer: { decoratedPlayerBarRenderer: { decoratedPlayerBarRenderer: { playerBar: { multiMarkersPlayerBarRenderer: { markersMap: [{ key: "DESCRIPTION_CHAPTERS", value: { chapters } }] } } } } } } });
  const macroPanel = (items) => ({ engagementPanels: [{ engagementPanelSectionListRenderer: { content: { macroMarkersListRenderer: { contents: items } } } }] });
  const bar = chapterBar([
    { chapterRenderer: { title: { simpleText: "Intro" }, timeRangeStartMillis: 0 } },
    { chapterRenderer: { title: { simpleText: "Setup" }, timeRangeStartMillis: 90000 } }
  ]);
  const macro = macroPanel([
    { macroMarkersListItemRenderer: { title: { simpleText: "Intro" }, timeDescription: { simpleText: "0:00" }, onTap: { watchEndpoint: { startTimeSeconds: 0 } } } },
    { macroMarkersListItemRenderer: { title: { runs: [{ text: "Setup" }] }, timeDescription: { simpleText: "1:30" } } },
    { macroMarkersListItemRenderer: { title: { simpleText: "" }, timeDescription: { simpleText: "2:00" } } }
  ]);
  const chapters = [{ title: "Intro", from: 0, to: 0 }, { title: "Setup", from: 90, to: 0 }];
  eq(S.ytChapters(bar), chapters);
  eq(S.ytChapters(macro), chapters);
  eq(S.ytChapters({ ...bar, ...macroPanel([{ macroMarkersListItemRenderer: { title: { simpleText: "Extra" }, timeDescription: { simpleText: "5:00" } } }]) }), chapters);
  eq(S.ytChapters(null), []);
  const transcriptPanel = (params) => ({ engagementPanels: [{ engagementPanelSectionListRenderer: { content: { continuationItemRenderer: { continuationEndpoint: { getTranscriptEndpoint: { params } } } } } }] });
  eq(S.ytTranscriptParams({ ...bar, ...transcriptPanel("P1") }), "P1");
  eq(S.ytTranscriptParams(bar), "");

  // Transcript responses: segment renderers with a continuation and a footer,
  // the view-model page, and the cue-group shape.
  const page1 = {
    actions: [{ updateEngagementPanelAction: { content: { transcriptRenderer: { content: { transcriptSearchPanelRenderer: {
      body: { transcriptSegmentListRenderer: { initialSegments: [
        { transcriptSegmentRenderer: { startMs: "0", endMs: "1500", snippet: { runs: [{ text: "hello " }, { text: "world" }] }, startTimeText: { simpleText: "0:00" } } },
        { transcriptSegmentRenderer: { startMs: "1500", endMs: "2000", snippet: { runs: [{ text: " " }] } } },
        { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "t2" } } } }
      ] } },
      footer: { transcriptFooterRenderer: { languageMenu: { sortFilterSubMenuRenderer: { subMenuItems: [
        { title: "English (auto-generated)", selected: true, continuation: { reloadContinuationData: { continuation: "lang-en" } } },
        { title: "Deutsch", selected: false, continuation: { reloadContinuationData: { continuation: "lang-de" } } }
      ] } } } }
    } } } } } }]
  };
  const page2 = { segments: [{ transcriptSegmentViewModel: { startTimeMs: 2000, endTimeMs: 3000, text: { content: "second page" } } }] };
  const cueGroups = { body: [{ transcriptCueGroupRenderer: { formattedStartOffset: { simpleText: "0:04" }, cues: [
    { transcriptCueRenderer: { cue: { simpleText: "cue one" }, startOffsetMs: "4000", durationMs: "500" } },
    { transcriptCueRenderer: { cue: { simpleText: "cue two" }, startOffsetMs: "4500", durationMs: "0" } }
  ] } }] };
  eq(S.ytParseTranscript(page1), [{ from: 0, to: 1.5, content: "hello world" }]);
  eq(S.ytParseTranscript(page2), [{ from: 2, to: 3, content: "second page" }]);
  eq(S.ytParseTranscript(cueGroups), [{ from: 4, to: 4.5, content: "cue one" }, { from: 4.5, to: 4.5, content: "cue two" }]);

  // Fallback flow: fetchTracks makes the one /next and no transcript call;
  // fetchTranscript reuses it, follows the continuation, labels the language.
  const next = { ...watchNext("c0"), ...bar, ...transcriptPanel("P1") };
  let t = ytIo({ "next:dQw4w9WgXcQ": next, "get_transcript:P1": page1, "get_transcript:t2": page2 }, pagePlayer);
  await yt.fetchMeta(ref, t.io);
  eq(await yt.fetchTracks(ref, {}, t.io), { tracks: [{ ...ytTracks[3], url: "https://y/t?v=1&lang=zh-TW&fmt=json3", isDefault: false, source: "WEB" }], chapters });
  eq(t.calls, ["next:dQw4w9WgXcQ"]);
  const fallback = await yt.fetchTranscript(ref, t.io);
  eq(t.calls, ["next:dQw4w9WgXcQ", "get_transcript:P1", "get_transcript:t2"]);
  eq(fallback, {
    track: { id: "transcript", lang: "", label: "English (auto-generated)（文字稿）", url: "https://www.youtube.com/youtubei/v1/get_transcript?params=P1", kind: "transcript", isDefault: false },
    raw: [page1, page2]
  });
  eq(yt.parseSegments(fallback.raw), [{ from: 0, to: 1.5, content: "hello world" }, { from: 2, to: 3, content: "second page" }]);
  // Re-selecting the transcript track goes through fetchRaw.
  eq(yt.parseSegments(await yt.fetchRaw({ url: fallback.track.url }, t.io)), JSON.parse(JSON.stringify(yt.parseSegments(fallback.raw))));
  eq(t.calls.length, 5);
  // Unknown language, continuation loop capped at 5 pages.
  const looping = { ...page2, more: { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "t2" } } } } };
  t = ytIo({ "next:dQw4w9WgXcQ": next, "get_transcript:P1": looping, "get_transcript:t2": looping }, pagePlayer);
  await yt.fetchTracks(ref, {}, t.io);
  eq((await yt.fetchTranscript(ref, t.io)).track.label, "文字稿（默认语言）");
  eq(t.calls.filter((call) => call.startsWith("get_transcript")).length, 5);
  // 429 on the transcript stops after one call and keeps its status.
  t = ytIo({ "next:dQw4w9WgXcQ": next, "get_transcript:P1": Object.assign(new Error("请求失败：429"), { status: 429 }) }, pagePlayer);
  await yt.fetchTracks(ref, {}, t.io);
  eq(await yt.fetchTranscript(ref, t.io).then(() => 0, (error) => error.status), 429);
  eq(t.calls, ["next:dQw4w9WgXcQ", "get_transcript:P1"]);
  // No transcript panel: nothing is fetched.
  t = ytIo({ "next:dQw4w9WgXcQ": watchNext("") }, pagePlayer);
  await yt.fetchTracks(ref, {}, t.io);
  eq(await yt.fetchTranscript(ref, t.io).then(() => "", (error) => error.message), "该视频没有文字稿");
  eq(t.calls, ["next:dQw4w9WgXcQ"]);

  // Caption URLs are built as yt-dlp builds them.
  const base = "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&exp=xpe&xosf=1&lang=en&signature=s";
  eq(S.ytCaptionUrl(base, { pot: { pot: "P", client: "WEB" } }), "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&exp=xpe&lang=en&signature=s&fmt=json3&pot=P&potc=1&c=WEB");
  eq(S.ytCaptionUrl(base, { fmt: "srv3", tlang: "ja" }), "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&exp=xpe&lang=en&signature=s&fmt=srv3&tlang=ja");
  eq(S.ytCaptionUrl(base, { tlang: "en" }).includes("tlang"), false);
  // The token comes from the newest timedtext request of this video; other videos and tokenless URLs are ignored.
  const potUrls = [
    "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&pot=OLD&potc=1&c=WEB",
    "https://www.youtube.com/api/timedtext?v=other000000&lang=en&pot=X&c=WEB",
    "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&pot=NEW&potc=1&c=WEB",
    "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=de",
    "https://evil.example/api/timedtext?v=dQw4w9WgXcQ&pot=EVIL"
  ];
  eq(S.ytPotFromUrls(potUrls, "dQw4w9WgXcQ"), { pot: "NEW", client: "WEB" });
  eq(S.ytPotFromUrls(potUrls, "other000000"), { pot: "X", client: "WEB" });
  eq(S.ytPotFromUrls(potUrls.slice(3), "dQw4w9WgXcQ"), null);

  // Track sources: page player (token captured when its URLs demand one),
  // ANDROID when the page player has nothing, the embedded player for gates.
  const potTrack = { id: ".en", lang: "en", label: "English", url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&exp=xpe&lang=en", kind: "manual" };
  const freeTrack = { id: ".de", lang: "de", label: "German", url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=de", kind: "manual" };
  const signIn = { videoDetails: { videoId: ref.id, title: "T" }, playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in" } };
  const sourcesOf = async (routes, extra) => {
    const t = ytIo({ "next:dQw4w9WgXcQ": watchNext(""), ...routes }, extra);
    await yt.fetchMeta(ref, t.io);
    const tracks = (await yt.fetchTracks(ref, {}, t.io)).tracks;
    return { calls: t.calls.filter((call) => call.startsWith("player")), tracks: tracks.map((item) => `${item.source}:${item.id}:${new URL(item.url).searchParams.get("pot") || "-"}`) };
  };
  let captures = 0;
  const capture = async (videoId) => { captures += 1; eq(videoId, ref.id); return { pot: "TOK", client: "WEB" }; };
  // Page player with a token-free track: no capture, no other player call.
  eq(await sourcesOf({}, { readPlayer: async () => ytPlayer([freeTrack]), capturePot: capture }), { calls: [], tracks: ["WEB:.de:-"] });
  eq(captures, 0);
  // Page player with exp=xpe: the token is captured once and applied to every track.
  eq(await sourcesOf({}, { readPlayer: async () => ytPlayer([potTrack, freeTrack]), capturePot: capture }), { calls: [], tracks: ["WEB:.en:TOK", "WEB:.de:TOK"] });
  eq(captures, 1);
  // A second fetchTracks for the same video (expired URLs) reuses the token and re-reads the player.
  const again = ytIo({ "next:dQw4w9WgXcQ": watchNext("") }, { readPlayer: async () => ytPlayer([potTrack]), capturePot: capture });
  eq((await yt.fetchTracks(ref, {}, again.io)).tracks.map((item) => item.source), ["WEB"]);
  eq(captures, 1);
  // Capture fails: token-demanding tracks are dropped and ANDROID answers.
  eq(await sourcesOf({ "player:ANDROID:dQw4w9WgXcQ": ytPlayer([freeTrack]) }, { readPlayer: async () => ytPlayer([potTrack]), capturePot: async () => null }), { calls: ["player:ANDROID:dQw4w9WgXcQ"], tracks: ["ANDROID:.de:-"] });
  // Token rejected (every WEB track came back empty): withoutPot skips WEB and sends ANDROID's tracks without the token.
  eq(await sourcesOf({ "player:ANDROID:dQw4w9WgXcQ": ytPlayer([freeTrack]) }, { readPlayer: async () => ytPlayer([potTrack]), capturePot: capture, withoutPot: true }), { calls: ["player:ANDROID:dQw4w9WgXcQ"], tracks: ["ANDROID:.de:-"] });
  // The retry keeps the first attempt's cached token, but still drops ANDROID's token-demanding tracks and captures nothing.
  eq(await sourcesOf({ "player:ANDROID:dQw4w9WgXcQ": ytPlayer([potTrack, freeTrack]) }, { readPlayer: async () => ytPlayer([potTrack]), capturePot: capture, withoutPot: true }), { calls: ["player:ANDROID:dQw4w9WgXcQ"], tracks: ["ANDROID:.de:-"] });
  eq(captures, 1);
  // Page player names another video (SPA leftovers): a WEB player call replaces it.
  eq(await sourcesOf({ "player:WEB:dQw4w9WgXcQ": ytPlayer([freeTrack]) }, { readPlayer: async () => ({ ...ytPlayer([potTrack]), videoDetails: { videoId: "other000000" } }) }), { calls: ["player:WEB:dQw4w9WgXcQ"], tracks: ["WEB:.de:-"] });
  // A WEB player call answering with another video is rejected, not used.
  const wrong = ytIo({ "player:WEB:dQw4w9WgXcQ": { ...ytPlayer([freeTrack]), videoDetails: { videoId: "other000000", title: "T" } } });
  eq(await yt.fetchMeta(ref, wrong.io).then(() => "", (error) => error.message), "播放器返回的是另一个视频，请刷新网页重试");
  // Gated on WEB and ANDROID: the embedded player is tried, with the embed URL.
  eq(await sourcesOf({ "player:ANDROID:dQw4w9WgXcQ": signIn, "player:WEB_EMBEDDED_PLAYER:dQw4w9WgXcQ": ytPlayer([freeTrack]) }, { readPlayer: async () => signIn }), { calls: ["player:ANDROID:dQw4w9WgXcQ", "player:WEB_EMBEDDED_PLAYER:dQw4w9WgXcQ"], tracks: ["WEB_EMBEDDED_PLAYER:.de:-"] });
  // Nothing gated and nothing found: no embedded call, empty list for the transcript fallback.
  eq(await sourcesOf({ "player:ANDROID:dQw4w9WgXcQ": ytPlayer([]) }, { readPlayer: async () => ytPlayer([]) }), { calls: ["player:ANDROID:dQw4w9WgXcQ"], tracks: [] });
  // fetchMeta: gate reported with details present, thrown without; upload date from microformat.
  let m = ytIo({}, { readPlayer: async () => ({ ...signIn, microformat: { playerMicroformatRenderer: { publishDate: "2009-10-25T00:00:00-07:00" } } }) });
  eq((await yt.fetchMeta(ref, m.io)).gate, "该视频需要登录或年龄验证，暂不支持（Sign in）");
  eq((await yt.fetchMeta(ref, m.io)).uploadDate, "2009-10-25");
  m = ytIo({ "player:WEB:dQw4w9WgXcQ": { playabilityStatus: { status: "AGE_VERIFICATION_REQUIRED" } }, "player:ANDROID:dQw4w9WgXcQ": { playabilityStatus: { status: "AGE_VERIFICATION_REQUIRED" } } });
  eq(await yt.fetchMeta(ref, m.io).then(() => "", (error) => error.message), "该视频需要登录或年龄验证，暂不支持（AGE_VERIFICATION_REQUIRED）");
  // WBI: w_rid is md5(sorted query + mixin key), with !'()* stripped from values.
  const md5 = (text) => crypto.createHash("md5").update(text).digest("hex");
  const mixinKey = S.biliMixinKey("https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png", "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png");
  eq(mixinKey.length, 32);
  const wbiQuery = "aid=116420927166252&bvid=BV1g1dLBPEHV&cid=37589944385&foo=abcd%20%E4%B8%AD&wts=1700000000";
  eq(S.biliWbiSign({ bvid: "BV1g1dLBPEHV", cid: 37589944385, aid: 116420927166252, foo: "a!b'(c)*d 中" }, mixinKey, 1700000000), `${wbiQuery}&w_rid=${md5(wbiQuery + mixinKey)}`);
  // Lengths around the md5 block boundaries.
  for (const n of [0, 40, 41, 48, 1000]) {
    const q = `s=${"a".repeat(n)}&wts=1`;
    eq(S.biliWbiSign({ s: "a".repeat(n) }, "", 1), `${q}&w_rid=${md5(q)}`);
  }
  // fetchTracks signs wbi/v2 with the nav key when the caller opts in.
  const biliIo = (nav) => {
    const calls = [];
    const fetchJson = async (url) => {
      calls.push(url);
      if (url.includes("/nav")) return nav;
      return { code: 0, data: { subtitle: { subtitles: [{ id: 7, lan: "ai-zh", lan_doc: "中文", subtitle_url: "//aisubtitle.hdslb.com/a.json" }] } } };
    };
    return { calls, io: { fetchJson, signWbi: true } };
  };
  const biliRef = { site: "bilibili", id: "BV1g1dLBPEHV", part: null };
  const biliMeta = { aid: "116420927166252", cid: "37589944385" };
  let b = biliIo({ code: -101, data: { wbi_img: { img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png", sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png" } } });
  const tracks = (await S.SITES.bilibili.fetchTracks(biliRef, biliMeta, b.io)).tracks;
  eq(tracks.map((item) => [item.id, item.kind, item.url]), [["7", "ai", "https://aisubtitle.hdslb.com/a.json"]]);
  const signed = new URL(b.calls[1]);
  eq(signed.pathname, "/x/player/wbi/v2");
  const unsignedQuery = `aid=${biliMeta.aid}&bvid=${biliRef.id}&cid=${biliMeta.cid}&wts=${signed.searchParams.get("wts")}`;
  eq(signed.searchParams.get("w_rid"), md5(unsignedQuery + mixinKey));
  // The key is reused for ten minutes, so the next video costs no nav request.
  b = biliIo(null);
  await S.SITES.bilibili.fetchTracks(biliRef, biliMeta, b.io);
  eq(b.calls.length, 1);
  // Callers that don't opt in (the video page) send the unsigned query and never ask nav.
  b = biliIo(null);
  delete b.io.signWbi;
  await S.SITES.bilibili.fetchTracks(biliRef, biliMeta, b.io);
  eq(b.calls, [`https://api.bilibili.com/x/player/wbi/v2?aid=${biliMeta.aid}&cid=${biliMeta.cid}&bvid=${biliRef.id}`]);
  // A logged-out answer is reported, not mistaken for a video without subtitles.
  const loggedOut = { fetchJson: async () => ({ code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } }) };
  eq((await S.SITES.bilibili.fetchTracks(biliRef, biliMeta, loggedOut)).needLogin, true);

  // Subtitle cache: same key format content.js always wrote; entries hold the raw response.
  const cache = S.subtitleCache;
  eq(cache.key({ videoId: "BV1", cid: "9", subtitleId: "7" }), "boc_subtitle_cache_BV1_9_id_7");
  eq(cache.key({ videoId: "v", cid: "", subtitleUrl: "https://a.com/x.json?auth=1" }), "boc_subtitle_cache_v__url_a.com/x.json");
  eq(cache.key({ videoId: "v", cid: "", lang: " EN " }), "boc_subtitle_cache_v__lang_en");
  eq(await cache.load("boc_subtitle_cache_missing"), null);
  store.boc_subtitle_cache_old = { body: [{ from: 0, to: 1, content: "parsed, no raw" }], timestamp: Date.now() };
  eq(await cache.load("boc_subtitle_cache_old"), null);
  // Caps: entries past SUBTITLE_CACHE_DAYS go, then the oldest beyond SUBTITLE_CACHE_ENTRIES.
  const L = ctx.BocLimits;
  store.boc_subtitle_cache_stale = { raw: {}, timestamp: Date.now() - (L.SUBTITLE_CACHE_DAYS + 1) * 86400000 };
  store.unrelated = { timestamp: 0 };
  for (let i = 0; i < L.SUBTITLE_CACHE_ENTRIES; i += 1) store[`boc_subtitle_cache_n${i}`] = { raw: {}, timestamp: Date.now() - 1000 - i };
  await cache.save("boc_subtitle_cache_new", { body: [] });
  const cachedKeys = Object.keys(store).filter((key) => key.startsWith(L.KEYS.subtitleCachePrefix));
  eq(cachedKeys.length, L.SUBTITLE_CACHE_ENTRIES);
  // new + old + n0..n49 = 52 recent entries, so the two oldest go.
  eq(["boc_subtitle_cache_stale", `boc_subtitle_cache_n${L.SUBTITLE_CACHE_ENTRIES - 2}`, `boc_subtitle_cache_n${L.SUBTITLE_CACHE_ENTRIES - 1}`].some((key) => key in store), false);
  eq("boc_subtitle_cache_new" in store && "unrelated" in store, true);
  await cache.remove("boc_subtitle_cache_new");
  eq("boc_subtitle_cache_new" in store, false);

  // fetchRawCached: a hit skips the network; a rejected body is fetched again and not cached.
  const bili = S.SITES.bilibili;
  const raw = (to) => ({ body: [{ from: 0, to, content: "x" }] });
  const track = { id: "7", lang: "ai-zh", url: "https://aisubtitle.hdslb.com/a.json" };
  const ids = { videoId: "BV1", cid: "9" };
  let fetched = 0;
  const rawIo = (answer) => ({ fetchJson: async () => ((fetched += 1), answer) });
  eq(await S.fetchRawCached(bili, track, ids, rawIo(raw(10))), raw(10));
  eq(store.boc_subtitle_cache_BV1_9_id_7.raw, raw(10));
  eq(await S.fetchRawCached(bili, track, ids, rawIo(raw(99))), raw(10));
  eq(fetched, 1);
  const long = (body) => body.length > 0 && body[0].to > 50;
  eq(await S.fetchRawCached(bili, track, ids, rawIo(raw(20)), long), raw(20));
  eq([fetched, store.boc_subtitle_cache_BV1_9_id_7.raw], [2, raw(10)]);
  eq(await S.fetchRawCached(bili, track, ids, rawIo({ body: [] })), raw(10));

  console.log("sites selftest ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
