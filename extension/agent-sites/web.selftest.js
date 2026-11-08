// node extension/agent-sites/web.selftest.js
// read runs as Chrome runs it: its source alone, compiled in a fresh context (a fake page), so a closure would fail here.
const assert = require("assert");
const vm = require("vm");
// web.js first: the registry still asks it last.
const S = require("./registry.selftest.js").load("web.js", "youtube.js");

const keys = {
  "https://www.youtube.com/watch?v=abc": "youtube:abc:",
  "https://example.com/a/b?x=1#t=30": "web:https://example.com/a/b?x=1:",
  "http://example.com/": "web:http://example.com/:",
  "ftp://example.com/": null
};
for (const [href, key] of Object.entries(keys)) assert.strictEqual(S.keyOf(href), key, href);

const VTT = `WEBVTT
Kind: captions

NOTE a comment --> not a cue

STYLE
::cue { color: red }

1
00:00:01.500 --> 00:00:03.000 align:start position:0%
<v Bob>Hello &amp; <b>welcome</b></v>
to the show

01:02:03.04 --> 01:02:05.000
Later

00:00:09.000 --> 00:00:10.000
`;
const SRT = "1\r\n00:00:01,000 --> 00:00:02,500\r\nOne\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nTwo\r\nlines\r\n";

const enc = new TextEncoder();
// A page: metas, videos ({ w, h, duration, tracks, textTracks }), the main text, the files fetch can get.
function page({ readyState = "complete", videos = [], main = null, body = "", files = {}, metas = {}, title = "Doc title" }) {
  const fetched = [];
  const els = videos.map((v) => ({
    duration: v.duration ?? NaN,
    getBoundingClientRect: () => ({ width: v.w || 0, height: v.h || 0 }),
    textTracks: v.textTracks || [],
    querySelectorAll: (s) => (s === "track" ? (v.tracks || []).map((t) => ({ kind: "subtitles", label: "", srclang: "", default: false, ...t })) : [])
  }));
  const document = {
    readyState,
    title,
    body: { innerText: body },
    querySelectorAll: (s) => (s === "video" ? els : []),
    querySelector: (s) => {
      const m = /^meta\[(?:name|property)="([^"]+)"\]$/.exec(s);
      if (m) return m[1] in metas ? { content: metas[m[1]] } : null;
      return s === "article, main, [role=main]" && main != null ? { innerText: main } : null;
    }
  };
  let clock = 0;
  const ctx = vm.createContext({
    document,
    location: { href: "https://example.com/v#x" },
    // sleep(250) advances the clock at once; the fetch timeout never fires.
    setTimeout: (fn, ms) => { if (ms < 1000) { clock += ms; setImmediate(fn); } return 0; },
    clearTimeout: () => {},
    Date: { now: () => clock },
    AbortController,
    TextDecoder,
    Blob,
    fetch: async (src) => {
      fetched.push(src);
      if (!(src in files)) return { ok: false, body: null };
      const bytes = enc.encode(files[src]);
      const chunks = [];
      for (let i = 0; i < bytes.length; i += 65536) chunks.push(bytes.subarray(i, i + 65536));
      return { ok: true, body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) } };
    }
  });
  const read = vm.runInContext(`(${S.get("web").read.toString()})`, ctx);
  return { read: () => read().then((r) => (r ? JSON.parse(JSON.stringify(r)) : r)), fetched };
}

(async () => {
  assert.strictEqual(await page({ readyState: "loading" }).read(), null, "not ready while the document loads");

  // The largest video, its default track as WebVTT: cue settings, tags, entities, hour times; NOTE, STYLE and empty cues skipped.
  let p = page({
    metas: { "og:title": "OG title", description: "  A   description ", author: "Ann" },
    videos: [
      { w: 100, h: 50, duration: 5, tracks: [{ src: "https://example.com/small.vtt" }] },
      { w: 640, h: 360, duration: 3725.6, tracks: [{ src: "https://example.com/en.vtt", label: "English" }, { src: "https://example.com/de.vtt", default: true, srclang: "de" }] }
    ],
    files: { "https://example.com/de.vtt": VTT }
  });
  let r = await p.read();
  assert.deepStrictEqual(p.fetched, ["https://example.com/de.vtt"]);
  assert.deepStrictEqual(r, {
    url: "https://example.com/v#x", title: "OG title", author: "Ann", description: "A description", chapters: [], comments: [],
    kind: "video", duration: 3726,
    subtitle: { lang: "de", warning: "", missing: "", segments: [
      { from: 1.5, to: 3, content: "Hello & welcome to the show" },
      { from: 3723.04, to: 3725, content: "Later" }
    ] }
  });

  // SRT; the first subtitle track when none is the default; the document title without og:title.
  r = await page({ videos: [{ w: 1, h: 1, duration: 4, tracks: [{ kind: "chapters", src: "c.vtt" }, { src: "https://e.test/a.srt" }] }], files: { "https://e.test/a.srt": SRT } }).read();
  assert.strictEqual(r.title, "Doc title");
  assert.deepStrictEqual(r.subtitle.segments, [{ from: 1, to: 2.5, content: "One" }, { from: 3, to: 4, content: "Two lines" }]);

  // Cues the browser already loaded win: nothing is fetched.
  p = page({ videos: [{ w: 1, h: 1, duration: 4, tracks: [{ src: "https://e.test/a.srt" }], textTracks: [{ kind: "metadata", cues: [{}] }, { kind: "captions", label: "Auto", cues: [{ startTime: 0, endTime: 1, text: "<i>Hi</i>" }, { startTime: 1, endTime: 2, text: " " }] }] }] });
  r = await p.read();
  assert.deepStrictEqual([p.fetched, r.subtitle.lang, r.subtitle.segments], [[], "Auto", [{ from: 0, to: 1, content: "Hi" }]]);

  // A track over 2 MB, one that fails and a javascript: src are not read; no track at all; an unknown duration is 0.
  const big = "WEBVTT\n\n" + "00:00:01.000 --> 00:00:02.000\nx\n\n".repeat(80000);
  p = page({ videos: [{ w: 1, h: 1, duration: 4, tracks: [{ src: "https://e.test/big.vtt" }] }], files: { "https://e.test/big.vtt": big } });
  assert.strictEqual((await p.read()).subtitle.missing, "The video's subtitle track could not be read.");
  assert.strictEqual((await page({ videos: [{ w: 1, h: 1, duration: 4, tracks: [{ src: "https://e.test/404.vtt" }] }] }).read()).subtitle.missing, "The video's subtitle track could not be read.");
  p = page({ videos: [{ w: 1, h: 1, tracks: [{ src: "javascript:alert(1)" }] }] });
  r = await p.read();
  assert.deepStrictEqual([p.fetched, r.duration, r.subtitle.segments.length], [[], 0, 0]);
  assert.strictEqual((await page({ videos: [{ w: 1, h: 1, duration: 2 }] }).read()).subtitle.missing, "The video has no subtitle track.");

  // Subtitle text stops at 100,000 characters.
  const long = "WEBVTT\n\n" + `00:00:01.000 --> 00:00:02.000\n${"y".repeat(900)}\n\n`.repeat(200);
  r = await page({ videos: [{ w: 1, h: 1, duration: 4, tracks: [{ src: "https://e.test/l.vtt" }] }], files: { "https://e.test/l.vtt": long } }).read();
  assert.strictEqual(r.subtitle.segments.length, 111);

  // No video: the main element's text, blank runs collapsed, capped at 100,000 characters; else the body's.
  r = await page({ main: "  Head  \n\n\n\n  Para\t\tone ", body: "ignored" }).read();
  assert.deepStrictEqual([r.kind, r.text, r.duration, r.subtitle.segments], ["page", "Head \n\n Para one", 0, []]);
  assert.match(r.subtitle.missing, /No <video>/);
  r = await page({ body: "z".repeat(150000) }).read();
  assert.strictEqual(r.text.length, 100000);

  console.log("agent-sites web selftest ok");
})().catch((e) => { console.error(e); process.exit(1); });
