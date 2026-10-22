// /usr/local/bin/node extension/obsidian-sync.selftest.js
if (process.versions.bun) (console.error("This selftest needs Node: it fails or hangs under bun (see 自检 in README.md)."), process.exit(1));
// obsidian.js, the only writer to Obsidian, through its messages against a fake Local REST API that records every
// GET/PUT. B站 is stubbed at triageBuildNote (its own tests are triage-bg.selftest.js).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");
const assert = require("assert");
const PS = require("./page-sources.selftest.js");

const vault = new Map();
let notApi = false;
const log = [];
const server = http.createServer((req, res) => {
  // The cover image, from B站 in real life.
  if (req.url.startsWith("/img/")) return res.writeHead(200, { "Content-Type": "image/jpeg" }).end("jpg");
  // The API root (probeObsidian); notApi: another service on that address, "json" one that answers JSON.
  if (req.url === "/" && notApi === "json") return res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
  if (req.url === "/") return notApi ? res.writeHead(200, { "Content-Type": "text/html" }).end("<html>") : res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ service: "Obsidian Local REST API", authenticated: true }));
  const file = decodeURIComponent(req.url.replace(/^\/vault\//, ""));
  log.push(`${req.method} ${file}`);
  if (req.headers.authorization !== "Bearer k") return res.writeHead(401).end();
  if (req.method === "GET") return vault.has(file) ? res.writeHead(200).end(vault.get(file)) : res.writeHead(404).end();
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => (vault.set(file, body), res.writeHead(204).end()));
});

const local = {};
const sync = {};
const area = (store) => ({
  async get(keys) {
    if (keys == null) return structuredClone(store);
    if (typeof keys === "object" && !Array.isArray(keys)) return { ...keys, ...structuredClone(store) };
    return Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
  },
  async set(items) {
    Object.assign(store, structuredClone(items));
  },
  async remove(keys) {
    for (const k of [].concat(keys)) delete store[k];
  }
});
const onMessageListeners = [];
const noop = new Proxy(function () {}, { get: () => noop, apply: () => noop });
// The tabs a write without its page looks in (tabNote); created: tabs it opened; muted: tabs it muted; videoPage: a video
// tab's popup-refresh answer.
let openTabs = [];
const created = [];
const muted = [];
let videoPage = () => ({ ok: false });
const tabs = new Proxy({
  query: async () => openTabs,
  create: async (t) => (created.push(t.url), { id: 9, status: "complete", ...t }),
  get: async (id) => ({ id, status: "complete" }),
  update: async (id, p) => p.muted && muted.push(id),
  sendMessage: (id, m, o, cb) => cb(m.type === "popup-refresh" && o.frameId === 0 ? videoPage(id) : undefined)
}, { get: (t, k) => t[k] || noop });
const chrome = {
  runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onConnect: { addListener() {} }, onMessage: { addListener: (fn) => onMessageListeners.push(fn) }, getURL: (p) => `chrome-extension://mdg/${p}`, getManifest: () => JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8")) },
  storage: { local: area(local), sync: area(sync), onChanged: { addListener() {} } },
  permissions: noop,
  tabs,
  sidePanel: noop,
  declarativeNetRequest: noop
};
const ctx = vm.createContext({ chrome, console, fetch, setTimeout, clearTimeout, AbortSignal, AbortController, TextDecoder, TextEncoder, URL, URLSearchParams, Headers,
  // Loads files when background.js calls it, so the selftest sees the browser's load order.
  importScripts: (...files) => files.forEach((file) => vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), ctx))
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "background.js"), "utf8"), ctx);
const N = ctx.MdgNote;
const E = ctx.MdgErrors.TEXT;
const PATHS = ctx.MdgLimits.KEYS.obsidianNotePaths;
// Responses are vm-realm objects, so they come back through JSON for deepStrictEqual.
// Like Chrome, every listener sees the message and only one answers. The sender is the 分拣台 page.
const send = (message) => new Promise((resolve) => onMessageListeners.forEach((fn) => fn(message, { url: "chrome-extension://mdg/triage/triage.html" }, (resp) => resolve(JSON.parse(JSON.stringify(resp))))));
const write = (extra) => send({ type: "write-video-note", ...extra });

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  Object.assign(sync, { obsidianEnabled: true, obsidianApiBaseUrl: baseUrl, noteFolder: "N/{{site}}", includeDateInFilename: false, playerEmbed: false });
  local.obsidianApiKey = "k";
  const coverUrl = `${baseUrl}/img/c.jpg`;
  let builds = 0;
  let gone = false;
  let warn = "";
  ctx.triageBuildNote = async (bvid, settings) => {
    builds++;
    if (gone) throw Object.assign(new Error("啥都木有"), { code: -404 });
    const noteMeta = { site: "bilibili", videoId: bvid, cid: "c1", title: "T" };
    return { meta: { title: "T" }, noteMeta, markdown: `---\ncover: "${coverUrl}"\n---\n\n![cover](${coverUrl})\n\n## 字幕\n\n你好`, path: N.videoNotePath(noteMeta, settings), cover: { url: coverUrl, name: `bilibili-${bvid}` }, subtitleWarning: warn };
  };
  const bili = { site: "bilibili", videoId: "BV1", cid: "c1", pageIndex: 1, title: "T" };
  const key = "video:bilibili:BV1|c1";
  const notePath = "N/bilibili/T.md";
  const conversation = (q) => ({ messages: [{ role: "user", content: q }, { role: "assistant", content: `答${q}` }] });

  // A new B站 P1 note: built, the cover stored beside it, the conversation in its AI 问答, the path recorded.
  let resp = await write({ ref: bili, conversation: conversation("一") });
  assert.deepStrictEqual(resp, { ok: true, path: notePath, kind: "full", text: `已写入 Obsidian：${notePath}`, title: "T" });
  assert.ok(vault.get(notePath).includes("![[N/bilibili/attachments/bilibili-BV1.jpg]]") && vault.get(notePath).includes("### 问：一"), vault.get(notePath));
  assert.strictEqual(vault.get("N/bilibili/attachments/bilibili-BV1.jpg"), "jpg");
  assert.strictEqual(local[PATHS][key].path, notePath);
  assert.deepStrictEqual(log.splice(0), [`GET ${notePath}`, "GET N/bilibili/attachments/bilibili-BV1.jpg", "PUT N/bilibili/attachments/bilibili-BV1.jpg", `PUT ${notePath}`]);

  // It exists: ask, and nothing is written. The recorded path needs no build.
  builds = 0;
  resp = await write({ ref: bili, conversation: conversation("二") });
  assert.deepStrictEqual([resp, log.splice(0), builds], [{ ok: true, ask: true, path: notePath, hasAiSection: true }, [`GET ${notePath}`], 0]);

  // ai: only the AI 问答 section changes; the user's edits around it stay. One GET, one PUT.
  vault.set(notePath, vault.get(notePath).replace("你好", "你好（我改的）"));
  resp = await write({ ref: bili, conversation: conversation("二"), mode: "ai" });
  assert.deepStrictEqual(resp, { ok: true, path: notePath, kind: "ai", text: `已更新 AI 问答：${notePath}`, title: "T" });
  assert.ok(vault.get(notePath).includes("你好（我改的）") && vault.get(notePath).includes("### 问：二") && !vault.get(notePath).includes("### 问：一"));
  assert.deepStrictEqual([log.splice(0), builds], [[`GET ${notePath}`, `PUT ${notePath}`], 0]);
  // C220: the same conversation again changes nothing and says so.
  resp = await write({ ref: bili, conversation: conversation("二"), mode: "ai" });
  assert.deepStrictEqual([resp.kind, resp.text, log.splice(0)], ["unchanged", `AI 问答没有变化：${notePath}`, [`GET ${notePath}`]]);

  // full: the note rewritten in one PUT (the cover is already there).
  resp = await write({ ref: bili, conversation: conversation("三"), mode: "full" });
  assert.strictEqual(resp.kind, "full");
  assert.ok(!vault.get(notePath).includes("我改的") && vault.get(notePath).includes("### 问：三"));
  assert.deepStrictEqual(log.splice(0), [`GET ${notePath}`, "GET N/bilibili/attachments/bilibili-BV1.jpg", `PUT ${notePath}`]);

  // The date in the computed name changed since: the recorded note is the one asked about and updated.
  sync.includeDateInFilename = true;
  resp = await write({ ref: bili, conversation: conversation("四") });
  assert.strictEqual(resp.path, notePath);
  sync.includeDateInFilename = false;
  log.splice(0);

  // YouTube without its page, no tab showing it and no note recorded: no note can be built here, so it asks first as a
  // web page does (the conversation alone would leave a second note once the video's is written); 只写 AI 笔记
  // (pageChoice own) writes the conversation as its own note, linking the video note.
  const yt = { site: "youtube", videoId: "y1", pageIndex: 1, title: "Y", url: "https://www.youtube.com/watch?v=y1" };
  assert.deepStrictEqual(await write({ ref: yt, conversation: conversation("q") }), { ok: true, askPage: true, url: "https://www.youtube.com/watch?v=y1", video: true });
  resp = await write({ ref: yt, conversation: conversation("q"), pageChoice: "own" });
  assert.deepStrictEqual([resp.kind, resp.path, resp.text], ["conversation", "N/youtube/【AI笔记】Y.md", "已写入 Obsidian：N/youtube/【AI笔记】Y.md（单独的 AI 笔记）"]);
  assert.ok(vault.get(resp.path).includes("[[N/youtube/Y|Y]]") && vault.get(resp.path).includes("## q"));
  // The video page open: its note, its cover, and the result starts with its subtitle state (G3) as for a built note.
  resp = await write({ ref: yt, conversation: conversation("q"), page: { markdown: "# 页面笔记", cover: "", warning: "字幕抓取失败：网络断了。" } });
  assert.deepStrictEqual([resp.kind, resp.path, resp.text], ["full", "N/youtube/Y.md", "字幕抓取失败：网络断了。已写入 Obsidian：N/youtube/Y.md"]);
  assert.ok(vault.get("N/youtube/Y.md").startsWith("# 页面笔记") && vault.get("N/youtube/Y.md").includes("### 问：q"));
  // A2: the page closed again, the recorded note is asked about, not passed by for a conversation note; 只更新 AI 问答
  // works without the page, 整篇覆盖 says it needs it.
  resp = await write({ ref: yt, conversation: conversation("r") });
  assert.deepStrictEqual(resp, { ok: true, ask: true, path: "N/youtube/Y.md", hasAiSection: true, fullReason: "整篇覆盖要先打开视频页" });
  resp = await write({ ref: yt, conversation: conversation("r"), mode: "ai" });
  assert.deepStrictEqual([resp.kind, resp.path], ["ai", "N/youtube/Y.md"]);
  assert.ok(vault.get("N/youtube/Y.md").startsWith("# 页面笔记") && vault.get("N/youtube/Y.md").includes("### 问：r"));
  resp = await write({ ref: yt, conversation: conversation("r"), mode: "full" });
  assert.deepStrictEqual(resp, { ok: false, error: "整篇覆盖要先打开视频页" });
  // An empty body never reaches the vault: a video that changed mid-write must not blank its note.
  log.splice(0);
  resp = await write({ ref: { ...yt, videoId: "y2", title: "Y2" }, page: { markdown: " \n", cover: "" } });
  assert.deepStrictEqual([resp, log.splice(0)], [{ ok: false, error: "笔记内容为空" }, ["GET N/youtube/Y2.md"]]);

  // Another tab shows the YouTube video: its note is read there (popup-refresh) and written whole at the path its page
  // names, nothing asked; the 分 P / YouTube with no tab asks with the part's link, and 打开视频页再写 opens it muted.
  {
    const y5 = { ...yt, videoId: "y5aaaaaaaaa", title: "旧名", url: "https://www.youtube.com/watch?v=y5aaaaaaaaa" };
    const pageOf = (ref, md) => ({ ok: true, payload: { url: ref.url, markdown: md, cover: "", noteWarning: "", noteRef: ref } });
    openTabs = [{ id: 7, url: "https://www.youtube.com/watch?v=y5aaaaaaaaa&t=30" }];
    videoPage = (id) => pageOf({ ...y5, title: "Y5", author: "作者" }, `# Y5 笔记 ${id}`);
    resp = await write({ ref: y5, conversation: conversation("标签页") });
    assert.deepStrictEqual([resp.kind, resp.path, created, muted], ["full", "N/youtube/Y5.md", [], []]);
    assert.ok(vault.get("N/youtube/Y5.md").startsWith("# Y5 笔记 7") && vault.get("N/youtube/Y5.md").includes("### 问：标签页"));
    assert.strictEqual(local[PATHS]["video:youtube:y5aaaaaaaaa|"].path, "N/youtube/Y5.md");
    // A tab of another part of the same B站 video is not this part's.
    const p2 = { site: "bilibili", videoId: "BV7", pageIndex: 2, pageCount: 3, title: "分P", url: "https://www.bilibili.com/video/BV7?p=2" };
    openTabs = [{ id: 8, url: "https://www.bilibili.com/video/BV7?p=3" }];
    assert.deepStrictEqual(await write({ ref: p2, conversation: conversation("分") }), { ok: true, askPage: true, url: "https://www.bilibili.com/video/BV7/?p=2", video: true });
    openTabs = [];
    videoPage = (id) => pageOf({ ...p2, cid: "c72", pageTitle: "第二集" }, `# 分P 笔记 ${id}`);
    resp = await write({ ref: p2, conversation: conversation("分"), pageChoice: "open" });
    assert.deepStrictEqual([resp.kind, resp.path, created, muted], ["full", "N/bilibili/分P-P2-第二集.md", ["https://www.bilibili.com/video/BV7/?p=2"], [9]]);
    assert.strictEqual(local[PATHS]["video:bilibili:BV7|c72"].path, "N/bilibili/分P-P2-第二集.md");
    // Opened but no note there (no subtitles yet, another video): says why, and writes nothing.
    videoPage = () => ({ ok: true, payload: { url: p2.url, markdown: "" } });
    assert.deepStrictEqual(await write({ ref: { ...p2, videoId: "BV8", url: "" }, conversation: conversation("空"), pageChoice: "open" }), { ok: false, error: E.noNoteYet });
    videoPage = () => ({ ok: false });
    created.length = muted.length = 0;
  }

  // A deleted B站 video: the user's conversation as its own note; 逐个视频笔记 (no conversation) fails with B站's code.
  gone = true;
  resp = await write({ ref: { ...bili, videoId: "BV9", cid: "" }, conversation: conversation("q") });
  assert.deepStrictEqual([resp.kind, resp.text], ["conversation", "已写入 Obsidian：N/bilibili/【AI笔记】T.md（视频已失效，只写了对话）"]);
  resp = await send({ type: "triage-write-note", bvid: "BV9", overwrite: false });
  assert.deepStrictEqual(resp, { ok: false, error: "啥都木有", code: -404 });
  // C219: the same for a recorded note: 整篇覆盖 cannot rebuild it, so the conversation is its own note.
  resp = await write({ ref: bili, conversation: conversation("q"), mode: "full" });
  assert.deepStrictEqual([resp.kind, resp.path], ["conversation", "N/bilibili/【AI笔记】T.md"]);
  gone = false;

  // 逐个视频笔记 never asks: without overwrite an existing note keeps its body (its AI 问答 follows); with it, rewritten.
  // F11: it sends no cid; the note recorded for P1 is found without reading B站 again, never P2's of the same BV.
  vault.set(notePath, vault.get(notePath).replace("你好", "你好（又改了）"));
  local[PATHS]["video:bilibili:BV1|c0"] = { path: "N/bilibili/T P2.md", pageIndex: 2 };
  builds = 0;
  resp = await send({ type: "triage-write-note", bvid: "BV1", title: "T", overwrite: false });
  assert.deepStrictEqual([resp.data, builds], [{ path: notePath, title: "T", skipped: true, aiUpdated: false }, 0]);
  // An entry recorded before the 分 P was: one build finds it by the cid, and records the 分 P for the next run. Only the
  // AI 问答 changed, so the subtitle warning of that build is not reported.
  delete local[PATHS][key].pageIndex;
  warn = "字幕抓取失败：网络断了。";
  resp = await write({ ref: { ...bili, cid: "" }, conversation: conversation("补"), mode: "ai" });
  assert.deepStrictEqual([resp.text, builds, local[PATHS][key].pageIndex], [`已更新 AI 问答：${notePath}`, 1, 1]);
  warn = "";
  builds = 0;
  await send({ type: "triage-write-note", bvid: "BV1", overwrite: false });
  assert.strictEqual(builds, 0);
  delete local[PATHS]["video:bilibili:BV1|c0"];
  assert.ok(vault.get(notePath).includes("又改了"));
  resp = await send({ type: "triage-write-note", bvid: "BV1", overwrite: true });
  assert.deepStrictEqual(resp.data, { path: notePath, title: "T", skipped: false, aiUpdated: false });
  assert.ok(!vault.get(notePath).includes("又改了"));

  // 「附带 AI 问答」 off: a write with a conversation still writes the video note, without the conversation (no
  // separate AI 笔记).
  sync.includeAiChatInNote = false;
  resp = await write({ ref: bili, conversation: conversation("关") });
  assert.deepStrictEqual(resp, { ok: true, ask: true, path: notePath, hasAiSection: false });
  resp = await write({ ref: bili, conversation: conversation("关"), mode: "full" });
  assert.deepStrictEqual([resp.path, resp.kind], [notePath, "full"]);
  const aiNote = vault.get("N/bilibili/【AI笔记】T.md");
  assert.ok(!vault.get(notePath).includes("### 问：关") && !aiNote.includes("### 问：关"), vault.get(notePath));
  // A recorded note without its page: nothing can change, said so, nothing asked.
  resp = await write({ ref: yt, conversation: conversation("关") });
  assert.deepStrictEqual([resp.kind, resp.text], ["unchanged", `AI 问答没有变化：${resp.path}`]);
  // No note yet and no page: asked, without 只写 AI 笔记 (own false), which is then refused too.
  const noNote = { ...yt, videoId: "y9", title: "Y9", url: "https://www.youtube.com/watch?v=y9" };
  assert.deepStrictEqual(await write({ ref: noNote, conversation: conversation("关") }), { ok: true, askPage: true, url: "https://www.youtube.com/watch?v=y9", video: true, own: false });
  assert.strictEqual((await write({ ref: noNote, conversation: conversation("关"), pageChoice: "own" })).askPage, true);
  resp = await write({ ref: { ...yt, videoId: "y3", title: "Y3" }, page: { markdown: "# 页面", cover: "" } });
  assert.strictEqual(vault.get(resp.path), "# 页面");
  sync.includeAiChatInNote = true;

  // Auto-sync: only a recorded note, never created; the same section again costs one GET; a deleted note is forgotten.
  log.splice(0);
  resp = await send({ type: "sync-video-note-ai", ref: bili, conversation: conversation("五") });
  // I4: the background words the result; the side panel shows its text.
  assert.deepStrictEqual([resp, log.splice(0)], [{ ok: true, path: notePath, exists: true, updated: true, text: `已更新 AI 问答：${notePath}` }, [`GET ${notePath}`, `PUT ${notePath}`]]);
  resp = await send({ type: "sync-video-note-ai", ref: bili, conversation: conversation("五") });
  assert.deepStrictEqual([resp.updated, log.splice(0)], [false, [`GET ${notePath}`]]);
  resp = await send({ type: "sync-video-note-ai", ref: { ...bili, videoId: "BV2" }, conversation: conversation("五") });
  assert.deepStrictEqual([resp, log.splice(0)], [{ ok: true, path: "" }, []]);
  vault.delete("N/youtube/Y.md");
  // A27: at a wrong address every note 404s; that is the address, and the recorded path is kept.
  sync.obsidianApiBaseUrl = `${baseUrl}/x`;
  resp = await send({ type: "sync-video-note-ai", ref: yt, conversation: conversation("五") });
  assert.deepStrictEqual([resp, "video:youtube:y1|" in local[PATHS]], [{ ok: false, error: E.obsidianNotFound, code: "OBSIDIAN" }, true]);
  sync.obsidianApiBaseUrl = baseUrl;
  resp = await send({ type: "sync-video-note-ai", ref: yt, conversation: conversation("五") });
  assert.deepStrictEqual([resp.exists, "video:youtube:y1|" in local[PATHS], vault.has("N/youtube/Y.md")], [false, false, false]);
  // L10: the gone note is worded here too; the side panel only shows text.
  assert.strictEqual(resp.text, "Obsidian 里的视频笔记已不存在，未写入");
  assert.ok(!PS.text(PS.own("sidepanel.html")).includes("已不存在"), "the side panel words a sync result itself");

  // A web page read in the side panel: its note (MdgNote.buildPageNote) goes under {{site}} = 网页 and is remembered by the
  // page key, so auto-sync keeps its AI 问答 current. Without its body (opened from 摘读记录) the conversation is its own
  // note, linking the page's.
  {
    const webRef = { url: "https://example.com/post", title: "一篇文章", author: "作者", isVideoContext: false };
    const pageKey = "page:https://example.com/post";
    const markdown = N.buildPageNote({ ...webRef, pageMarkdown: "正文第一段" }, sync, N.buildConversationTurns(conversation("网").messages));
    resp = await write({ ref: webRef, conversation: conversation("网"), page: { markdown } });
    assert.deepStrictEqual([resp.path, resp.kind, local[PATHS][pageKey]?.path], ["N/网页/一篇文章.md", "full", "N/网页/一篇文章.md"]);
    assert.ok(vault.get("N/网页/一篇文章.md").includes("正文第一段") && vault.get("N/网页/一篇文章.md").includes("### 问：网"));
    resp = await send({ type: "sync-video-note-ai", ref: webRef, conversation: conversation("又问") });
    assert.deepStrictEqual([resp.path, resp.updated], ["N/网页/一篇文章.md", true]);
    assert.ok(vault.get("N/网页/一篇文章.md").includes("### 问：又问") && vault.get("N/网页/一篇文章.md").includes("正文第一段"));
    // The page's tab closed (no body) with its note recorded: like a YouTube note without its page, asked about, and
    // only 只更新 AI 问答 can be chosen; it then replaces only that section.
    resp = await write({ ref: webRef, conversation: conversation("历史") });
    assert.deepStrictEqual(resp, { ok: true, ask: true, path: "N/网页/一篇文章.md", hasAiSection: true, fullReason: "整篇覆盖要先打开这个网页" });
    assert.deepStrictEqual(await write({ ref: webRef, conversation: conversation("历史"), mode: "full" }), { ok: false, error: "整篇覆盖要先打开这个网页" });
    resp = await write({ ref: webRef, conversation: conversation("历史"), mode: "ai" });
    assert.deepStrictEqual([resp.path, resp.kind], ["N/网页/一篇文章.md", "ai"]);
    assert.ok(vault.get("N/网页/一篇文章.md").includes("### 问：历史") && vault.get("N/网页/一篇文章.md").includes("正文第一段"));
    // No note recorded for the page and no tab shows it: asked first, as writing the conversation alone would leave a
    // second note once the page's is written; 只写 AI 笔记 (pageChoice own) writes it alone.
    const otherRef = { ...webRef, url: "https://example.com/other", title: "另一篇" };
    assert.deepStrictEqual(await write({ ref: otherRef, conversation: conversation("别处") }), { ok: true, askPage: true, url: "https://example.com/other" });
    resp = await write({ ref: otherRef, conversation: conversation("别处"), pageChoice: "own" });
    assert.deepStrictEqual([resp.path, resp.kind, resp.text], ["N/网页/【AI笔记】另一篇.md", "conversation", "已写入 Obsidian：N/网页/【AI笔记】另一篇.md"]);
    // A tab shows it (#… aside): its page is read there and the page's note is written, nothing asked.
    const pageNoteOf = ctx.popupPageNote;
    const read = [];
    ctx.popupPageNote = async (tabId) => (read.push(tabId), { content: N.buildPageNote({ ...otherRef, pageMarkdown: "另一篇正文" }, sync, []) });
    openTabs = [{ id: 5, url: "https://example.com/other#top" }];
    resp = await write({ ref: otherRef, conversation: conversation("开着") });
    assert.deepStrictEqual([resp.path, resp.kind, read, created], ["N/网页/另一篇.md", "full", [5], []]);
    assert.ok(vault.get("N/网页/另一篇.md").includes("另一篇正文") && vault.get("N/网页/另一篇.md").includes("### 问：开着"));
    // 打开网页再写 (pageChoice open): no tab, so one is opened in the background and read.
    const third = { ...webRef, url: "https://example.com/third", title: "第三篇" };
    openTabs = [];
    read.length = 0;
    resp = await write({ ref: third, conversation: conversation("三"), pageChoice: "open" });
    assert.deepStrictEqual([resp.path, read, created], ["N/网页/第三篇.md", [9], ["https://example.com/third"]]);
    // A page that cannot be read once opened says why, and writes nothing.
    ctx.popupPageNote = async () => {
      throw new Error("读取网页失败：没有找到正文");
    };
    assert.deepStrictEqual(await write({ ref: { ...third, url: "https://example.com/4", title: "四" }, conversation: conversation("四"), pageChoice: "open" }), { ok: false, error: "读取网页失败：没有找到正文" });
    ctx.popupPageNote = pageNoteOf;
    // The page's note deleted in the vault: auto-sync says so in a page's words.
    vault.delete("N/网页/一篇文章.md");
    resp = await send({ type: "sync-video-note-ai", ref: webRef, conversation: conversation("再问") });
    assert.deepStrictEqual([resp.exists, resp.text], [false, "Obsidian 里的网页笔记已不存在，未写入"]);
  }

  // export-note (复制 Markdown, 下载 .md of the side panel and 摘读记录): the note the write gives, as text; nothing is
  // written.
  {
    const exp = async (extra) => {
      log.splice(0);
      const r = await send({ type: "export-note", ...extra });
      assert.ok(!log.some((l) => l.startsWith("PUT")), `export-note wrote: ${log}`);
      return r;
    };
    // A web page with its body: the note written whole.
    const sameRef = { url: "https://example.com/same", title: "同一篇", isVideoContext: false };
    const markdown = N.buildPageNote({ ...sameRef, pageMarkdown: "正文" }, sync, []);
    resp = await exp({ ref: sameRef, conversation: conversation("同"), page: { markdown } });
    await write({ ref: sameRef, conversation: conversation("同"), page: { markdown } });
    assert.deepStrictEqual([resp.filename, resp.markdown], ["同一篇.md", vault.get("N/网页/同一篇.md")]);
    assert.ok(resp.markdown.includes("正文") && resp.markdown.includes("### 问：同"), resp.markdown);
    // B站 P1 without its page: built as the write's 整篇覆盖 (the write then stores the cover in the vault).
    builds = 0;
    resp = await exp({ ref: bili, conversation: conversation("导") });
    assert.deepStrictEqual([resp.filename, builds], ["T.md", 1]);
    assert.ok(resp.markdown.includes("你好") && resp.markdown.includes("### 问：导") && resp.markdown.includes(`![cover](${coverUrl})`), resp.markdown);
    // YouTube without its page, a tab or a note: asked as the write is; 只复制 AI 笔记 (own) is the AI 笔记 linking the
    // video note, marked noPage.
    const y7 = { ...yt, videoId: "y7", title: "Y7", url: "https://www.youtube.com/watch?v=y7" };
    assert.deepStrictEqual(await exp({ ref: y7, conversation: conversation("问") }), await write({ ref: y7, conversation: conversation("问") }));
    resp = await exp({ ref: y7, conversation: conversation("问"), pageChoice: "own" });
    assert.deepStrictEqual([resp.filename, resp.noPage, resp.markdown.includes("[[N/youtube/Y7|Y7]]")], ["【AI笔记】Y7.md", true, true]);
    // Its note recorded, no page: that note with this AI 问答.
    await write({ ref: y7, conversation: conversation("问"), page: { markdown: "# Y7 页面" } });
    resp = await exp({ ref: y7, conversation: conversation("再问") });
    assert.deepStrictEqual([resp.filename, resp.markdown], ["Y7.md", N.upsertAiSection(vault.get("N/youtube/Y7.md"), N.buildAiSection(N.buildConversationTurns(conversation("再问").messages)))]);
    // 「附带 AI 问答」 off: the note as it is, no conversation added; asked without own, which 摘读记录's zip still sends.
    sync.includeAiChatInNote = false;
    resp = await exp({ ref: y7, conversation: conversation("关") });
    assert.strictEqual(resp.markdown, vault.get("N/youtube/Y7.md"));
    resp = await exp({ ref: bili, conversation: conversation("关") });
    assert.ok(!resp.markdown.includes("### 问："), resp.markdown);
    const y8 = { ...yt, videoId: "y8", title: "Y8", url: "https://www.youtube.com/watch?v=y8" };
    assert.deepStrictEqual(await exp({ ref: y8, conversation: conversation("关") }), { ok: true, askPage: true, url: y8.url, video: true, own: false });
    assert.strictEqual((await exp({ ref: y8, conversation: conversation("关"), pageChoice: "own" })).noPage, true);
    sync.includeAiChatInNote = true;
    // Obsidian off: still exported; a recorded note cannot be read, so its page is asked for.
    sync.obsidianEnabled = false;
    assert.strictEqual((await exp({ ref: y7, conversation: conversation("问") })).askPage, true);
    assert.strictEqual((await exp({ ref: bili, conversation: conversation("问") })).filename, "T.md");
    sync.obsidianEnabled = true;
  }

  // A26: 测试连接 passes only when the address answers the Local REST API's JSON, which names its service (F4).
  assert.deepStrictEqual({ ...(await ctx.testObsidianConnection(baseUrl, "k")) }, { ok: true, service: "Obsidian Local REST API" });
  for (notApi of [true, "json"]) assert.deepStrictEqual({ ...(await ctx.testObsidianConnection(baseUrl, "k")) }, { ok: false, error: E.obsidianNotApi, code: "OBSIDIAN" }, notApi);
  notApi = false;

  // C217: . and .. never take a request out of the vault folder.
  assert.strictEqual(ctx.vaultEndpoint({ baseUrl: "http://h/" }, "../a/./b.md"), "http://h/vault/a/b.md");

  // Obsidian unusable, in MdgErrors' words: not enabled or set up and a refused key are OBSIDIAN (去设置).
  local.obsidianApiKey = "wrong";
  assert.deepStrictEqual(await write({ ref: bili }), { ok: false, error: E.obsidianKey, code: "OBSIDIAN" });
  local.obsidianApiKey = "";
  assert.deepStrictEqual(await write({ ref: bili }), { ok: false, error: E.obsidianUnset, code: "OBSIDIAN" });
  // C221: auto-sync says it too, as a manual write does; only Obsidian turned off is silent.
  assert.deepStrictEqual(await send({ type: "sync-video-note-ai", ref: bili, conversation: conversation("七") }), { ok: false, error: E.obsidianUnset, code: "OBSIDIAN" });
  sync.obsidianEnabled = false;
  assert.deepStrictEqual(await send({ type: "sync-video-note-ai", ref: bili, conversation: conversation("七") }), { ok: true, path: "" });
  sync.obsidianEnabled = true;
  local.obsidianApiKey = "k";
  sync.obsidianEnabled = false;
  assert.strictEqual((await write({ ref: bili })).code, "OBSIDIAN");
  sync.obsidianEnabled = true;

  // 一篇摘录 and the 逐个视频笔记 index cover many videos: the template's folders before the first per-video one.
  const exportedTo = async (noteFolder) => {
    sync.noteFolder = noteFolder;
    return (await send({ type: "triage-export", filename: "汇总.md", markdown: "# x" })).data.path;
  };
  assert.deepStrictEqual(
    [await exportedTo("N/{{site}}/{{author}}"), await exportedTo("N/{{site}}-{{upload_date}}/x"), await exportedTo("{{created}}/{{site}}"), await exportedTo("N/{{site}}")],
    ["N/bilibili/汇总.md", "N/汇总.md", "汇总.md", "N/bilibili/汇总.md"]
  );
  sync.noteFolder = "N/{{site}}";

  // Closed: OBSIDIAN_DOWN for the writes, auto-sync (the record is kept for a retry) and 一篇摘录 (triage-export).
  const before = vault.get(notePath);
  await new Promise((resolve) => server.close(resolve));
  const down = { ok: false, error: E.obsidianDown, code: "OBSIDIAN_DOWN" };
  assert.deepStrictEqual(await write({ ref: bili, mode: "full" }), down);
  assert.deepStrictEqual(await send({ type: "sync-video-note-ai", ref: bili, conversation: conversation("六") }), down);
  assert.deepStrictEqual(await send({ type: "triage-export", filename: "汇总.md", markdown: "# x" }), down);
  assert.deepStrictEqual([vault.get(notePath), local[PATHS][key].path], [before, notePath]);

  // Pages never talk to the vault themselves, and the folder template is applied only where paths are made.
  const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
  const scripts = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(__dirname, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".js") && !e.name.endsWith(".selftest.js")) scripts.push(rel);
    }
  };
  walk(".");
  for (const f of scripts) {
    assert.ok(f === "obsidian.js" || !/\/vault\/|"(obsidian-note-exists|write-obsidian-note|update-obsidian-ai-section)"/.test(read(f)), `${f} reaches the vault; send write-video-note`);
    assert.ok(["note.js", "obsidian.js"].includes(f) || !read(f).includes("resolveFolderTemplate("), `${f} builds a note path; use MdgNote.videoNotePath or sharedNoteFolder`);
    // The result sentences are worded once, in obsidian.js (dev mocks stand in for it).
    assert.ok(f === "obsidian.js" || f.startsWith("dev") || !read(f).includes("已更新 AI 问答："), `${f} words a write's result; show the background's text`);
  }

  console.log("obsidian sync selftest ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
