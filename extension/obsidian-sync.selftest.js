// /usr/local/bin/node extension/obsidian-sync.selftest.js
// obsidian.js, the only writer to Obsidian, through its messages against a fake Local REST API that records every
// GET/PUT. B站 is stubbed at triageBuildNote (its own tests are triage-bg.selftest.js).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");
const assert = require("assert");

const vault = new Map();
const log = [];
const server = http.createServer((req, res) => {
  // The cover image, from B站 in real life.
  if (req.url.startsWith("/img/")) return res.writeHead(200, { "Content-Type": "image/jpeg" }).end("jpg");
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
const chrome = {
  runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onConnect: { addListener() {} }, onMessage: { addListener: (fn) => onMessageListeners.push(fn) }, getManifest: () => JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8")) },
  storage: { local: area(local), sync: area(sync), onChanged: { addListener() {} } },
  permissions: noop,
  tabs: noop,
  sidePanel: noop,
  declarativeNetRequest: noop
};
const ctx = vm.createContext({ chrome, console, fetch, setTimeout, clearTimeout, AbortSignal, AbortController, TextDecoder, TextEncoder, URL, URLSearchParams, Headers,
  // Loads files when background.js calls it, so the selftest sees the browser's load order.
  importScripts: (...files) => files.forEach((file) => vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), ctx))
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "background.js"), "utf8"), ctx);
const N = ctx.BocNote;
const E = ctx.BocErrors.TEXT;
const PATHS = ctx.BocLimits.KEYS.obsidianNotePaths;
// Responses are vm-realm objects, so they come back through JSON for deepStrictEqual.
// Like Chrome, every listener sees the message and only one answers.
const send = (message) => new Promise((resolve) => onMessageListeners.forEach((fn) => fn(message, {}, (resp) => resolve(JSON.parse(JSON.stringify(resp))))));
const write = (extra) => send({ type: "write-video-note", ...extra });

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  Object.assign(sync, { obsidianEnabled: true, obsidianApiBaseUrl: baseUrl, noteFolder: "N/{{site}}", includeDateInFilename: false, playerEmbed: false });
  local.obsidianApiKey = "k";
  const coverUrl = `${baseUrl}/img/c.jpg`;
  let builds = 0;
  let gone = false;
  ctx.triageBuildNote = async (bvid, settings) => {
    builds++;
    if (gone) throw Object.assign(new Error("啥都木有"), { code: -404 });
    const noteMeta = { site: "bilibili", videoId: bvid, cid: "c1", title: "T" };
    return { meta: { title: "T" }, noteMeta, markdown: `---\ncover: "${coverUrl}"\n---\n\n![cover](${coverUrl})\n\n## 字幕\n\n你好`, path: N.videoNotePath(noteMeta, settings), cover: { url: coverUrl, name: `bilibili-${bvid}` }, subtitleWarning: "" };
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

  // YouTube without its page: no note can be built, so the conversation is its own note, linking the video note.
  const yt = { site: "youtube", videoId: "y1", pageIndex: 1, title: "Y", url: "https://www.youtube.com/watch?v=y1" };
  resp = await write({ ref: yt, conversation: conversation("q") });
  assert.deepStrictEqual([resp.kind, resp.path, resp.text], ["conversation", "N/youtube/【AI笔记】Y.md", "已写入 Obsidian：N/youtube/【AI笔记】Y.md（单独的对话笔记）"]);
  assert.ok(vault.get(resp.path).includes("[[N/youtube/Y|Y]]") && vault.get(resp.path).includes("## q"));
  // The video page open: its note, its cover.
  resp = await write({ ref: yt, conversation: conversation("q"), page: { markdown: "# 页面笔记", cover: "" } });
  assert.deepStrictEqual([resp.kind, resp.path], ["full", "N/youtube/Y.md"]);
  assert.ok(vault.get("N/youtube/Y.md").startsWith("# 页面笔记") && vault.get("N/youtube/Y.md").includes("### 问：q"));
  // An empty body never reaches the vault: a video that changed mid-write must not blank its note.
  log.splice(0);
  resp = await write({ ref: { ...yt, videoId: "y2", title: "Y2" }, page: { markdown: " \n", cover: "" } });
  assert.deepStrictEqual([resp, log.splice(0)], [{ ok: false, error: "笔记内容为空" }, ["GET N/youtube/Y2.md"]]);

  // A deleted B站 video: the user's conversation as its own note; 逐个视频笔记 (no conversation) fails with B站's code.
  gone = true;
  resp = await write({ ref: { ...bili, videoId: "BV9", cid: "" }, conversation: conversation("q") });
  assert.deepStrictEqual([resp.kind, resp.text], ["conversation", "已写入 Obsidian：N/bilibili/【AI笔记】T.md（视频已失效，只写了对话）"]);
  resp = await send({ type: "triage-write-note", bvid: "BV9", overwrite: false });
  assert.deepStrictEqual(resp, { ok: false, error: "啥都木有", code: -404 });
  gone = false;

  // 逐个视频笔记 never asks: without overwrite an existing note keeps its body (its AI 问答 follows); with it, rewritten.
  vault.set(notePath, vault.get(notePath).replace("你好", "你好（又改了）"));
  resp = await send({ type: "triage-write-note", bvid: "BV1", overwrite: false });
  assert.deepStrictEqual(resp.data, { path: notePath, title: "T", skipped: true, aiUpdated: false });
  assert.ok(vault.get(notePath).includes("又改了"));
  resp = await send({ type: "triage-write-note", bvid: "BV1", overwrite: true });
  assert.deepStrictEqual(resp.data, { path: notePath, title: "T", skipped: false, aiUpdated: false });
  assert.ok(!vault.get(notePath).includes("又改了"));

  // 「附带 AI 问答」 off: a conversation the user writes is its own note; the video note gets none.
  sync.includeAiChatInNote = false;
  // (It exists from above: the ask names the conversation note, with no 只更新 AI 问答.)
  resp = await write({ ref: bili, conversation: conversation("关") });
  assert.deepStrictEqual(resp, { ok: true, ask: true, path: "N/bilibili/【AI笔记】T.md" });
  resp = await write({ ref: { ...yt, videoId: "y3", title: "Y3" }, page: { markdown: "# 页面", cover: "" } });
  assert.strictEqual(vault.get(resp.path), "# 页面");
  sync.includeAiChatInNote = true;

  // Auto-sync: only a recorded note, never created; the same section again costs one GET; a deleted note is forgotten.
  log.splice(0);
  resp = await send({ type: "sync-video-note-ai", ref: bili, conversation: conversation("五") });
  assert.deepStrictEqual([resp, log.splice(0)], [{ ok: true, path: notePath, exists: true, updated: true }, [`GET ${notePath}`, `PUT ${notePath}`]]);
  resp = await send({ type: "sync-video-note-ai", ref: bili, conversation: conversation("五") });
  assert.deepStrictEqual([resp.updated, log.splice(0)], [false, [`GET ${notePath}`]]);
  resp = await send({ type: "sync-video-note-ai", ref: { ...bili, videoId: "BV2" }, conversation: conversation("五") });
  assert.deepStrictEqual([resp, log.splice(0)], [{ ok: true, path: "" }, []]);
  vault.delete("N/youtube/Y.md");
  resp = await send({ type: "sync-video-note-ai", ref: yt, conversation: conversation("五") });
  assert.deepStrictEqual([resp.exists, "video:youtube:y1|" in local[PATHS], vault.has("N/youtube/Y.md")], [false, false, false]);

  // Obsidian unusable, in BocErrors' words: not enabled or set up and a refused key are OBSIDIAN (去设置).
  local.obsidianApiKey = "wrong";
  assert.deepStrictEqual(await write({ ref: bili }), { ok: false, error: E.obsidianKey, code: "OBSIDIAN" });
  local.obsidianApiKey = "";
  assert.deepStrictEqual(await write({ ref: bili }), { ok: false, error: E.obsidianUnset, code: "OBSIDIAN" });
  local.obsidianApiKey = "k";
  sync.obsidianEnabled = false;
  assert.strictEqual((await write({ ref: bili })).code, "OBSIDIAN");
  sync.obsidianEnabled = true;

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
    assert.ok(["note.js", "obsidian.js", "triage/triage-bg.js"].includes(f) || !read(f).includes("resolveFolderTemplate("), `${f} builds a note path; use BocNote.videoNotePath`);
  }
  assert.strictEqual(read("triage/triage-bg.js").split("resolveFolderTemplate(").length, 2, "triage-bg.js: only triage-export");

  console.log("obsidian sync selftest ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
