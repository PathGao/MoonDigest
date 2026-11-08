// node extension/agent-sites/youtube.selftest.js
const assert = require("assert");
const crypto = require("crypto");
const vm = require("vm");
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
// Other forms of a watch page are read as the watch page; the content script runs there only.
const canon = {
  "https://youtu.be/dQw4w9WgXcQ?t=5": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/shorts/dQw4w9WgXcQ": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/live/dQw4w9WgXcQ": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30": "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30",
  "https://www.youtube.com/@chan": "https://www.youtube.com/@chan"
};
for (const [href, to] of Object.entries(canon)) {
  assert.strictEqual(S.canonical(href), to, href);
  if (to.includes("watch")) assert.strictEqual(S.keyOf(S.canonical(href)), "youtube:dQw4w9WgXcQ:", href);
}
const yt = S.get("youtube");
assert.strictEqual(yt.read, "content");

// ytReady and ytApi run as chrome.scripting runs them: from their source, in a page with nothing of the extension.
// A closure or an extension global would throw here.
const inPage = (fn, { cfg, cookie, answer }) => {
  const sent = [];
  const page = vm.createContext({
    window: { ytcfg: cfg && { get: (k) => cfg[k] } },
    document: { cookie },
    location: { origin: "https://www.youtube.com" },
    crypto: globalThis.crypto, TextEncoder, AbortSignal, Uint8Array, JSON, String, Array, Math, Date,
    fetch: async (url, init) => (sent.push({ url, ...init, body: JSON.parse(init.body) }), answer())
  });
  return { run: (...args) => vm.runInContext(`(${fn.toString()})`, page)(...args), sent };
};
const context = { client: { clientName: "WEB", clientVersion: "2.20261101.00.00", visitorData: "VIS" } };
const cfg = { INNERTUBE_CONTEXT: context, LOGGED_IN: true, SESSION_INDEX: 0, INNERTUBE_CONTEXT_CLIENT_NAME: 1, DATASYNC_ID: "DELEG||USER" };
const plain = (x) => JSON.parse(JSON.stringify(x));
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

(async () => {
  assert.strictEqual(inPage(yt.test.ytReady, { cfg: null }).run(), undefined, "not ready before ytcfg");
  assert.deepStrictEqual(plain(inPage(yt.test.ytReady, { cfg }).run()), { ok: true });

  const p = inPage(yt.test.ytApi, { cfg, cookie: "PREF=x; SAPISID=sid0; __Secure-1PAPISID=sid1; __Secure-3PAPISID=sid3", answer: () => ({ status: 200, url: "https://www.youtube.com/youtubei/v1/browse", text: async () => '{"a":1}' }) });
  const before = Math.round(Date.now() / 1000);
  const r = await p.run("browse", { browseId: "VLWL" });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { status: 200, url: "https://www.youtube.com/youtubei/v1/browse", json: { a: 1 } });
  const [req] = p.sent;
  assert.strictEqual(req.url, "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false");
  assert.strictEqual(req.method, "POST");
  assert.deepStrictEqual(req.body, { context, browseId: "VLWL" }, "the page's own client context");
  // yt-dlp's _make_sid_authorization: sha1("USER ts sid origin"), "ts_hash_u", one per cookie, space separated.
  const ts = /SAPISIDHASH (\d+)_/.exec(req.headers.Authorization)[1];
  assert.ok(Math.abs(ts - before) <= 1);
  const h = (sid) => `${ts}_${sha1(`USER ${ts} ${sid} https://www.youtube.com`)}_u`;
  assert.strictEqual(req.headers.Authorization, `SAPISIDHASH ${h("sid0")} SAPISID1PHASH ${h("sid1")} SAPISID3PHASH ${h("sid3")}`);
  const { Authorization, ...rest } = req.headers;
  assert.deepStrictEqual(rest, {
    "Content-Type": "application/json", "X-Origin": "https://www.youtube.com", "X-Goog-AuthUser": "0", "X-Youtube-Client-Name": "1",
    "X-Youtube-Client-Version": "2.20261101.00.00", "X-Youtube-Bootstrap-Logged-In": "true", "X-Goog-PageId": "DELEG", "X-Goog-Visitor-Id": "VIS"
  });

  // No brand account ("USER||"): no PageId; only SAPISID: one hash.
  const q = inPage(yt.test.ytApi, { cfg: { ...cfg, DATASYNC_ID: "USER||" }, cookie: "SAPISID=sid0", answer: () => ({ status: 200, url: "", text: async () => "{}" }) });
  await q.run("browse", {});
  assert.strictEqual(q.sent[0].headers["X-Goog-PageId"], undefined);
  assert.match(q.sent[0].headers.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}_u$/);

  // Logged out: nothing sent. A fetch that throws: status 0, never a throw (a throw would read as "not ready" and
  // the write would be sent again).
  for (const [c, cookie] of [[{ ...cfg, LOGGED_IN: false }, "SAPISID=s"], [cfg, "PREF=x"]]) {
    const o = inPage(yt.test.ytApi, { cfg: c, cookie, answer: () => assert.fail("sent") });
    assert.deepStrictEqual(plain(await o.run("browse", {})), { status: 401, loggedOut: true });
  }
  const t = inPage(yt.test.ytApi, { cfg, cookie: "SAPISID=s", answer: () => Promise.reject(new Error("net down")) });
  assert.deepStrictEqual(plain(await t.run("browse", {})), { status: 0, error: "net down" });
  const bad = inPage(yt.test.ytApi, { cfg, cookie: "SAPISID=s", answer: () => ({ status: 200, url: "", text: async () => "<html>" }) });
  assert.strictEqual((await bad.run("browse", {})).json, null);

  console.log("agent-sites youtube selftest ok");
})().catch((e) => (console.error(e), process.exit(1)));
