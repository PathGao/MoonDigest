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

// YouTube default subtitle language: native tracks in the target first,
// then a machine translation of a translatable (manual-first) source.
const ytTracks = [
  { id: "a.en", lang: "en", label: "English", url: "https://y/t?v=1&lang=en", kind: "auto", translatable: true },
  { id: ".de", lang: "de-DE", label: "German", url: "https://y/t?v=1&lang=de", kind: "manual", isDefault: true, translatable: true },
  { id: ".en", lang: "en", label: "English", url: "https://y/t?v=1&lang=en&m=1", kind: "manual", translatable: true },
  { id: ".zh-TW", lang: "zh-TW", label: "中文（台灣）", url: "https://y/t?v=1&lang=zh-TW", kind: "manual", translatable: false }
];
const ytIds = async (target) =>
  S.rankTracks((await S.SITES.youtube.fetchTracks({}, { tracks: ytTracks }, { subtitleLang: target })).tracks, target).map((item) => item.id);
(async () => {
  eq(await ytIds("auto"), [".zh-TW", ".en", "a.en", ".de"]);
  eq(await ytIds("en"), [".en", "a.en", ".zh-TW", ".de"]);
  eq(await ytIds("zh-Hant"), [".zh-TW", ".en", "a.en", ".de"]);
  eq((await ytIds("zh-Hans"))[0], ".en>zh-Hans");
  const [translated] = S.rankTracks((await S.SITES.youtube.fetchTracks({}, { tracks: ytTracks }, { subtitleLang: "zh-Hans" })).tracks, "zh-Hans");
  eq(translated, { id: ".en>zh-Hans", lang: "zh-Hans", label: "简体中文（机器翻译，自English）", url: "https://y/t?v=1&lang=en&m=1&tlang=zh-Hans", kind: "translated", isDefault: false });
  // A manual source beats an auto one in a higher-ranked language.
  eq((await S.SITES.youtube.fetchTracks({}, { tracks: ytTracks.slice(0, 2) }, { subtitleLang: "ja" })).tracks[2].id, ".de>ja");
  // Only untranslatable tracks: nothing to add.
  eq((await S.SITES.youtube.fetchTracks({}, { tracks: [ytTracks[3]] }, { subtitleLang: "ja" })).tracks.length, 1);
  // An auto-only video translates its auto track.
  eq((await S.SITES.youtube.fetchTracks({}, { tracks: [ytTracks[0]] }, { subtitleLang: "ja" })).tracks[1].url, "https://y/t?v=1&lang=en&tlang=ja");
  // Under auto a video without Chinese offers zh-Hans, ranked after every native track.
  const noZh = ytTracks.slice(0, 3);
  const autoNoZh = S.rankTracks((await S.SITES.youtube.fetchTracks({}, { tracks: noZh }, { subtitleLang: "auto" })).tracks, "auto");
  eq(autoNoZh.map((item) => item.id), [".en", "a.en", ".de", ".en>zh-Hans"]);
  eq(autoNoZh[3].url, "https://y/t?v=1&lang=en&m=1&tlang=zh-Hans");
  eq(S.pickPreferredTrack(autoNoZh).id, ".en");
  eq(S.rankTracks((await S.SITES.youtube.fetchTracks({}, { tracks: noZh }, {})).tracks).at(-1).id, ".en>zh-Hans");
  // Any native Chinese track, Traditional included, means nothing is added under auto.
  eq((await S.SITES.youtube.fetchTracks({}, { tracks: ytTracks }, { subtitleLang: "auto" })).tracks.length, ytTracks.length);
  assert.strictEqual(S.normalizeSubtitleLang("zh-Hans"), "zh-Hans");
  assert.strictEqual(S.normalizeSubtitleLang("fr"), "auto");
  assert.strictEqual(S.normalizeSubtitleLang(undefined), "auto");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
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
function ytIo(routes) {
  const calls = [];
  const io = {
    doc: { querySelectorAll: () => [{ textContent: '"INNERTUBE_API_KEY":"k","INNERTUBE_CLIENT_VERSION":"2.1","VISITOR_DATA":"vd"' }] },
    subtitleLang: "auto",
    postJson: async (url, body, headers) => {
      const endpoint = url.match(/\/v1\/(\w+)\?/)[1];
      const key = body.videoId || body.continuation || body.params;
      calls.push(`${endpoint}:${key}`);
      assert.strictEqual(headers["X-Goog-Visitor-Id"], "vd");
      const answer = routes[`${endpoint}:${key}`];
      if (answer instanceof Error) throw answer;
      return answer;
    }
  };
  return { io, calls };
}
const yt = S.SITES.youtube;
const ref = { id: "dQw4w9WgXcQ" };
// A load fetches tracks first (fresh /next), then comments reuse that response.
async function ytComments(next, byContinuation) {
  const { io, calls } = ytIo({ "next:dQw4w9WgXcQ": next, ...Object.fromEntries(Object.entries(byContinuation).map(([k, v]) => [`next:${k}`, v])) });
  await yt.fetchTracks(ref, { tracks: [] }, io);
  return { comments: await yt.fetchComments(ref, {}, io, 20), calls };
}
(async () => {
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
  const ytPlayer = (playabilityStatus, videoDetails) => ({
    doc: { querySelectorAll: () => [{ textContent: '"INNERTUBE_API_KEY":"k"' }] },
    postJson: async () => ({ playabilityStatus, videoDetails })
  });
  const metaError = (status) =>
    yt.fetchMeta(ref, ytPlayer(status)).then(() => "", (error) => error.message);
  eq(await metaError({ status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" }), "该视频需要登录或年龄验证，暂不支持（Sign in to confirm your age）");
  eq(await metaError({ status: "AGE_CHECK_REQUIRED" }), "该视频需要登录或年龄验证，暂不支持（AGE_CHECK_REQUIRED）");
  eq(await metaError({ status: "ERROR", reason: "Video unavailable" }), "视频不可播放：Video unavailable");
  // A gate that still ships videoDetails yields usable meta without tracks; the gate text travels with it.
  const gated = await yt.fetchMeta(ref, ytPlayer({ status: "LOGIN_REQUIRED", reason: "Sign in" }, { title: "T", lengthSeconds: "10" }));
  eq([gated.title, gated.duration, gated.tracks, gated.gate], ["T", 10, [], "该视频需要登录或年龄验证，暂不支持（Sign in）"]);
  eq((await yt.fetchMeta(ref, ytPlayer({ status: "OK" }, { title: "T" }))).gate, "");

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
  let t = ytIo({ "next:dQw4w9WgXcQ": next, "get_transcript:P1": page1, "get_transcript:t2": page2 });
  eq(await yt.fetchTracks(ref, { tracks: [ytTracks[3]] }, t.io), { tracks: [ytTracks[3]], chapters });
  eq(t.calls, ["next:dQw4w9WgXcQ"]);
  const fallback = await yt.fetchTranscript(ref, t.io);
  eq(t.calls, ["next:dQw4w9WgXcQ", "get_transcript:P1", "get_transcript:t2"]);
  eq(fallback, {
    track: { id: "transcript", lang: "", label: "English (auto-generated)（文字稿）", url: "https://www.youtube.com/youtubei/v1/get_transcript?params=P1", kind: "transcript", isDefault: false },
    segments: [{ from: 0, to: 1.5, content: "hello world" }, { from: 2, to: 3, content: "second page" }]
  });
  // Re-selecting the transcript track goes through fetchSegments.
  eq(await yt.fetchSegments({ url: fallback.track.url }, t.io), JSON.parse(JSON.stringify(fallback.segments)));
  eq(t.calls.length, 5);
  // Unknown language, continuation loop capped at 5 pages.
  const looping = { ...page2, more: { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "t2" } } } } };
  t = ytIo({ "next:dQw4w9WgXcQ": next, "get_transcript:P1": looping, "get_transcript:t2": looping });
  await yt.fetchTracks(ref, { tracks: [] }, t.io);
  eq((await yt.fetchTranscript(ref, t.io)).track.label, "文字稿（默认语言）");
  eq(t.calls.filter((call) => call.startsWith("get_transcript")).length, 5);
  // 429 on the transcript stops after one call and keeps its status.
  t = ytIo({ "next:dQw4w9WgXcQ": next, "get_transcript:P1": Object.assign(new Error("请求失败：429"), { status: 429 }) });
  await yt.fetchTracks(ref, { tracks: [] }, t.io);
  eq(await yt.fetchTranscript(ref, t.io).then(() => 0, (error) => error.status), 429);
  eq(t.calls, ["next:dQw4w9WgXcQ", "get_transcript:P1"]);
  // No transcript panel: nothing is fetched.
  t = ytIo({ "next:dQw4w9WgXcQ": watchNext("") });
  await yt.fetchTracks(ref, { tracks: [] }, t.io);
  eq(await yt.fetchTranscript(ref, t.io).then(() => "", (error) => error.message), "该视频没有文字稿");
  eq(t.calls, ["next:dQw4w9WgXcQ"]);
  console.log("sites selftest ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
