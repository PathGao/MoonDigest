// node extension/agent-sites/douyin.selftest.js
const assert = require("assert");
const vm = require("vm");
const S = require("./registry.selftest.js").load("douyin.js");

const keys = {
  "https://www.douyin.com/video/6961737553342991651": "douyin:6961737553342991651:",
  "https://www.douyin.com/video/6961737553342991651/?previous_page=app_code_link": "douyin:6961737553342991651:",
  "https://www.douyin.com/jingxuan?modal_id=6961737553342991651": "douyin:6961737553342991651:",
  "https://www.douyin.com/user/MS4wLjABAAAA?from_tab_name=main&modal_id=6961737553342991651": "douyin:6961737553342991651:",
  "https://www.douyin.com/jingxuan": null,
  "https://www.douyin.com/user/MS4wLjABAAAA": null,
  "https://www.douyin.com/note/7300000000000000000": null,
  "https://www.douyin.com/jingxuan?modal_id=abc": null,
  "https://v.douyin.com/iRNBho6u/": null,
  "https://www.douyin.com.evil.test/video/1": null
};
for (const [href, key] of Object.entries(keys)) assert.strictEqual(S.keyOf(href), key, href);

// read as Chrome runs it: its source text, evaluated in a sandbox page with a fake document, performance and XHR.
const URL1 = "https://www.douyin.com/video/6961737553342991651";
function page({ title = "", captcha = false, booted = true, replies = [] } = {}) {
  let now = 1e6;
  const sent = [];
  class XMLHttpRequest {
    open(method, path) { this.path = path; }
    send() {
      sent.push(this.path);
      const r = replies.shift();
      Object.assign(this, r);
      setImmediate(() => (r.status ? this.onload() : this.onerror()));
    }
  }
  const win = {
    URL, XMLHttpRequest,
    Date: Object.assign(class extends Date {}, { now: () => now }),
    document: { title, getElementById: (id) => (id === "captcha_container" ? captcha : id === "RENDER_DATA" ? booted : null) || null },
    performance: { getEntriesByType: () => (booted ? [{ name: "https://www.douyin.com/aweme/v1/web/query/user/" }] : []) }
  };
  win.window = win;
  const read = vm.runInNewContext(`(${S.get("douyin").read.toString()})`, win);
  return {
    sent,
    tick: (ms) => { now += ms; },
    // JSON round trip: the sandbox's objects have its own prototypes, as Chrome's structured clone drops them too.
    read: (url = URL1) => read(url).then((d) => (d == null ? d : JSON.parse(JSON.stringify(d))))
  };
}

// Trimmed from a live, logged-out www.douyin.com/video/6961737553342991651 (2026-11): the detail API's answer.
const detail = {
  aweme_id: "6961737553342991651", desc: "#杨超越  小小水手带你去远航❤️", caption: "", item_title: "", preview_title: "#杨超越  小小水手带你去远航❤️",
  create_time: 1620905839, duration: 19782,
  author: { nickname: "杨超越", unique_id: "6897520xka", sec_uid: "MS4wLjABAAAAEKnfa654JAJ_N5lgZDQluwsxmY0lhfmEYNQBBkwGG98" },
  statistics: { admire_count: 0, collect_count: 3934, comment_count: 14294, digg_count: 323266, play_count: 0, share_count: 10089 },
  seo_info: {}, video_text: [], chapter_list: null, comment_list: null,
  music: { title: "@杨超越创作的原声", play_url: { uri: "", url_list: [] } },
  video: { duration: 19782, play_addr: { uri: "v0300fg10000c2egtqtovkemgno0u7o0", url_list: ["https://v26-web.douyinvod.com/x/video_mp4"] } }
};
const ok = (d) => ({ status: 200, responseText: JSON.stringify({ status_code: 0, aweme_detail: d }) });
const localDay = (sec) => { const t = new Date(sec * 1000); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };

(async () => {
  let pg = page({ replies: [ok(detail)] });
  assert.deepStrictEqual(await pg.read(), {
    url: URL1, videoId: "6961737553342991651", title: "#杨超越  小小水手带你去远航❤️", author: "杨超越", uploadDate: localDay(1620905839),
    description: "#杨超越  小小水手带你去远航❤️", duration: 20, part: { index: 1, count: 0, title: "" }, chapters: [],
    subtitle: { segments: [], lang: "", warning: "", missing: "Douyin has no subtitle for this video; transcribe the media URL (playUrl; send Referer https://www.douyin.com/, it expires)" },
    comments: [], stats: { views: null, likes: 323266, comments: 14294, shares: 10089, saves: 3934 },
    playUrl: "https://v26-web.douyinvod.com/x/video_mp4"
  });
  assert.deepStrictEqual(pg.sent, ["/aweme/v1/web/aweme/detail/?device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=6961737553342991651"]);

  // A modal URL reads the same id; caption and OCR text in the payload come along.
  pg = page({ replies: [ok({ ...detail, caption: "小小水手", seo_info: { ocr_content: "远航" } })] });
  const m = await pg.read("https://www.douyin.com/jingxuan?modal_id=6961737553342991651");
  assert.strictEqual(m.description, "#杨超越  小小水手带你去远航❤️\n\n小小水手\n\n画面文字: 远航");
  assert.match(pg.sent[0], /aweme_id=6961737553342991651$/);

  // Not ready: the challenge page or an app that has not called its API yet sends nothing.
  pg = page({ booted: false });
  assert.strictEqual(await pg.read(), null);
  assert.deepStrictEqual(pg.sent, []);

  // Empty 200s (unsigned): asked again at most 3 times, 3 s apart, then THROTTLED.
  pg = page({ replies: [{ status: 200, responseText: "" }, { status: 200, responseText: "" }, { status: 200, responseText: "" }] });
  assert.strictEqual(await pg.read(), null);
  assert.strictEqual(await pg.read(), null, "too soon: no request");
  assert.strictEqual(pg.sent.length, 1);
  pg.tick(3000); assert.strictEqual(await pg.read(), null);
  pg.tick(3000); assert.strictEqual(await pg.read(), null);
  pg.tick(3000);
  assert.deepStrictEqual(await pg.read(), { error: "Douyin answers empty (anti-bot): stop, do not retry soon.", code: "THROTTLED" });
  assert.strictEqual(pg.sent.length, 3);

  // Each answered get starts the tries afresh: a fourth get on the same page is read, not THROTTLED.
  pg = page({ replies: Array.from({ length: 4 }, () => ok(detail)) });
  for (let i = 0; i < 4; i++) { pg.tick(3000); assert.strictEqual((await pg.read()).videoId, "6961737553342991651", `get ${i + 1}`); }
  assert.strictEqual(pg.sent.length, 4);

  // Risk control is THROTTLED, never data.
  for (const p of [page({ captcha: true }), page({ title: "验证码中间页" })]) {
    assert.strictEqual((await p.read()).code, "THROTTLED");
    assert.deepStrictEqual(p.sent, []);
  }
  for (const r of [{ status: 412, responseText: "" }, { status: 403, responseText: "ArgusSecurityPlugin" }, { status: 200, responseText: "<html>" }, { status: 200, responseText: '{"verify_ticket":"x"}' }]) {
    assert.strictEqual((await page({ replies: [r] }).read()).code, "THROTTLED", JSON.stringify(r));
  }
  // A video Douyin will not show: an error without a code.
  assert.deepStrictEqual(await page({ replies: [{ status: 200, responseText: '{"status_code":0,"aweme_detail":null,"filter_detail":{"filter_reason":"status_deleted"}}' }] }).read(),
    { error: "Douyin does not show this video (status_deleted)." });
  console.log("agent-sites douyin selftest ok");
})().catch((e) => { console.error(e); process.exit(1); });
