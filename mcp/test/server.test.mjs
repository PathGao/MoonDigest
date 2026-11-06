// Run from mcp/: npm test  (node --test test/*.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createBridge, createMcpServer, formatSearch, formatVideo, formatFavorites, formatFollows, formatHistory } from "../server.js";

const SERVER = fileURLToPath(new URL("../server.js", import.meta.url));

async function setup(opts = {}) {
  const bridge = createBridge({ port: 0, ...opts });
  await bridge.listen();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(bridge).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return { bridge, client, async close() { await client.close(); await bridge.close(); } };
}

function fakeExtension(port, { origin = "chrome-extension://x", hello = true, onCall } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { origin });
  const opened = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  const messages = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    messages.push(msg);
    if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    else if (msg.method && onCall) {
      const reply = onCall(msg);
      if (reply) ws.send(JSON.stringify({ id: msg.id, ...reply }));
    }
  });
  if (hello) ws.once("open", () => ws.send(JSON.stringify({ type: "hello", version: 1, extensionVersion: "0.0.1" })));
  return { ws, opened, messages };
}

const until = async (f) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(f()); };

const VIDEO = {
  url: "https://www.youtube.com/watch?v=abc",
  site: "youtube", videoId: "abc",
  title: "A talk", author: "Someone", uploadDate: "2026-01-02", description: "",
  duration: 3725,
  part: { index: 0, count: 0, title: "" },
  chapters: [{ title: "Intro", from: 0, to: 60 }, { title: "Late", from: 3700, to: 3725 }],
  subtitle: { segments: [{ from: 1.5, to: 3, content: "hello" }, { from: 3661, to: 3662, content: "bye" }], lang: "English", warning: "", missing: "", needLogin: false },
  comments: [{ uname: "u1", like: 5, message: "nice" }],
};

test("hello, get_video formatting, pings", async () => {
  const s = await setup({ pingMs: 30 });
  const ext = fakeExtension(s.bridge.port, { onCall: (m) => (m.method === "get" ? { ok: true, data: VIDEO } : null) });
  await ext.opened;
  await until(() => s.bridge.connected);
  const r = await s.client.callTool({ name: "get_video", arguments: { url: VIDEO.url } });
  assert.equal(r.isError, undefined);
  const text = r.content[0].text;
  assert.match(text, /^Title: A talk\nAuthor: Someone\nDate: 2026-01-02\nDuration: 01:02:05\nURL: https:\/\/www.youtube.com\/watch\?v=abc\nSubtitle: English/);
  assert.match(text, /Chapters:\n\[00:00\] Intro\n\[01:01:40\] Late/);
  assert.match(text, /Transcript:\n\[00:01\] hello\n\[01:01:01\] bye/);
  assert.match(text, /Comments:\n- u1 \(5 likes\): nice$/);
  assert.deepEqual(ext.messages.find((m) => m.method).params, { url: VIDEO.url });
  const raw = await s.client.callTool({ name: "get_video", arguments: { url: VIDEO.url, raw: true } });
  assert.deepEqual(JSON.parse(raw.content[0].text), VIDEO);
  await until(() => ext.messages.some((m) => m.type === "ping"));
  ext.ws.close();
  await s.close();
});

test("missing subtitle header", () => {
  const t = formatVideo({ ...VIDEO, subtitle: { segments: [], lang: "", warning: "", missing: "No subtitle track", needLogin: true } });
  assert.match(t, /Subtitle missing: No subtitle track\nSubtitle note: Bilibili hides/);
  assert.doesNotMatch(t, /Transcript:/);
});

test("rejects a web page Origin", async () => {
  const s = await setup();
  const ext = fakeExtension(s.bridge.port, { origin: "https://evil.example" });
  await assert.rejects(ext.opened, /HTTP 401/);
  assert.equal(s.bridge.connected, false);
  await s.close();
});

test("second extension gets 4001, first keeps working", async () => {
  const s = await setup();
  const first = fakeExtension(s.bridge.port, { onCall: () => ({ ok: true, data: VIDEO }) });
  await first.opened;
  await until(() => s.bridge.connected);
  const second = fakeExtension(s.bridge.port);
  const code = await new Promise((r) => second.ws.once("close", r));
  assert.equal(code, 4001);
  const r = await s.client.callTool({ name: "get_video", arguments: { url: VIDEO.url } });
  assert.equal(r.isError, undefined);
  first.ws.close();
  await s.close();
});

test("get_frame returns an image block", async () => {
  const s = await setup();
  const ext = fakeExtension(s.bridge.port, {
    onCall: (m) => ({ ok: true, data: { at: m.params.at + 0.04, width: 640, height: 360, image: "data:image/jpeg;base64,AAAA" } }),
  });
  await ext.opened;
  await until(() => s.bridge.connected);
  const r = await s.client.callTool({ name: "get_frame", arguments: { url: VIDEO.url, at: 75, maxWidth: 640 } });
  assert.deepEqual(r.content[0], { type: "image", mimeType: "image/jpeg", data: "AAAA" });
  assert.equal(r.content[1].text, "Frame at 01:15 (75.04s), 640x360.");
  assert.deepEqual(ext.messages.find((m) => m.method).params, { url: VIDEO.url, at: 75, maxWidth: 640 });
  ext.ws.close();
  await s.close();
});

test("extension errors pass through, THROTTLED says stop", async () => {
  const s = await setup();
  const ext = fakeExtension(s.bridge.port, { onCall: () => ({ ok: false, error: "Bilibili answered 412.", code: "THROTTLED" }) });
  await ext.opened;
  await until(() => s.bridge.connected);
  const r = await s.client.callTool({ name: "get_video", arguments: { url: VIDEO.url } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^THROTTLED: Bilibili answered 412\. Stop calling MoonDigest/);
  ext.ws.close();
  await s.close();
});

test("no answer -> TIMEOUT", async () => {
  const s = await setup({ callTimeoutMs: 100 });
  const ext = fakeExtension(s.bridge.port, { onCall: () => null });
  await ext.opened;
  await until(() => s.bridge.connected);
  const r = await s.client.callTool({ name: "get_video", arguments: { url: VIDEO.url } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^TIMEOUT:/);
  ext.ws.close();
  await s.close();
});

test("no extension -> NOT_CONNECTED", async () => {
  const s = await setup();
  const r = await s.client.callTool({ name: "get_video", arguments: { url: VIDEO.url } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^NOT_CONNECTED: .*MoonDigest extension.*允许 MCP 连接/);
  await s.close();
});

test("no extension answers NOT_CONNECTED at once, without waiting for one to connect", async () => {
  const s = await setup();
  const started = Date.now();
  const r = await s.client.callTool({ name: "get_video", arguments: { url: VIDEO.url } });
  assert.match(r.content[0].text, /^NOT_CONNECTED: .*允许 MCP 连接.*within a minute/);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  await s.close();
});

test("port taken -> PORT_IN_USE, then takes the port over when it frees", async () => {
  const holder = createBridge({ port: 0 });
  await holder.listen();
  const port = holder.port;
  const s = await setup({ port });
  const r = await s.client.callTool({ name: "get_video", arguments: { url: VIDEO.url } });
  assert.match(r.content[0].text, /^PORT_IN_USE: Port \d+ is used by another program, most likely another moondigest-mcp/);
  await holder.close();
  const r2 = await s.client.callTool({ name: "get_video", arguments: { url: VIDEO.url } });
  assert.match(r2.content[0].text, /^NOT_CONNECTED:/);
  assert.equal(s.bridge.port, port);
  await s.close();
});

test("stdio binary lists the tools", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, MOONDIGEST_MCP_PORT: "0" } });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["search_videos", "get_video", "get_frame", "get_favorites", "get_follows", "get_history"]);
  // The server tells the model to check videos that turn up in its own searches, not only linked ones.
  assert.match(client.getInstructions() || "", /search turns up Bilibili or YouTube videos/);
  assert.match(tools.find((t) => t.name === "get_video").description, /search results/);
  assert.match(client.getInstructions() || "", /search with search_videos, then read the best few with get_video/);
  assert.doesNotMatch(client.getInstructions() || "", /cannot search/);
  await client.close();
});

test("binary exits when its MCP client closes stdin", async () => {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, MOONDIGEST_MCP_PORT: "0" }, stdio: ["pipe", "ignore", "inherit"] });
  setTimeout(() => child.stdin.end(), 200);
  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => { child.kill(); reject(new Error("still running")); }, 3000);
    child.once("exit", (c) => { clearTimeout(t); resolve(c); });
  });
  assert.equal(code, 0);
});

const RESULTS = {
  site: "bilibili", query: "rust", page: 1,
  items: [
    { site: "bilibili", videoId: "BV1", url: "https://www.bilibili.com/video/BV1", title: "Rust 入门", author: "UP", duration: 754, views: 12345, uploadDate: "2026-01-02", description: "d" },
    { site: "bilibili", videoId: "BV2", url: "https://www.bilibili.com/video/BV2", title: "Live", author: "UP2", duration: 0, views: null, uploadDate: "", description: "" },
  ],
};

test("search_videos: defaults, one line per video, raw", async () => {
  const s = await setup();
  const ext = fakeExtension(s.bridge.port, { onCall: (m) => (m.method === "search" ? { ok: true, data: { ...RESULTS, page: m.params.page } } : null) });
  await ext.opened;
  await until(() => s.bridge.connected);
  const r = await s.client.callTool({ name: "search_videos", arguments: { query: " rust " } });
  assert.equal(r.isError, undefined);
  assert.equal(r.content[0].text, [
    'Bilibili search "rust", page 1:',
    "1. Rust 入门 | UP | 12:34 | 12345 views | 2026-01-02 | https://www.bilibili.com/video/BV1",
    "2. Live | UP2 | https://www.bilibili.com/video/BV2",
  ].join("\n"));
  assert.deepEqual(ext.messages.find((m) => m.method).params, { site: "bilibili", query: "rust", page: 1 });
  const raw = await s.client.callTool({ name: "search_videos", arguments: { query: "rust", site: "youtube", page: 2, raw: true } });
  assert.deepEqual(JSON.parse(raw.content[0].text), { ...RESULTS, page: 2 });
  assert.deepEqual(ext.messages.filter((m) => m.method)[1].params, { site: "youtube", query: "rust", page: 2 });
  ext.ws.close();
  await s.close();
});

test("search_videos: bad arguments never reach the extension", async () => {
  const s = await setup();
  const ext = fakeExtension(s.bridge.port, { onCall: () => ({ ok: true, data: RESULTS }) });
  await ext.opened;
  await until(() => s.bridge.connected);
  for (const [args, re] of [[{}, /query is required/], [{ query: "x", site: "vimeo" }, /site must be/], [{ query: "x", page: 0 }, /page must be/], [{ query: "x", page: 1.5 }, /page must be/]]) {
    const r = await s.client.callTool({ name: "search_videos", arguments: args });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, re);
  }
  assert.equal(ext.messages.filter((m) => m.method).length, 0);
  ext.ws.close();
  await s.close();
});

test("search_videos: empty is not an error, THROTTLED says stop", async () => {
  assert.equal(formatSearch({ site: "youtube", query: "zzz", page: 1, items: [] }), 'No YouTube videos for "zzz" on page 1.');
  const s = await setup();
  const ext = fakeExtension(s.bridge.port, { onCall: () => ({ ok: false, error: "YouTube 限流，请稍后再试", code: "THROTTLED" }) });
  await ext.opened;
  await until(() => s.bridge.connected);
  const r = await s.client.callTool({ name: "search_videos", arguments: { query: "x", site: "youtube" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^THROTTLED: YouTube 限流，请稍后再试 Stop calling MoonDigest/);
  ext.ws.close();
  await s.close();
});

test("personal data: favorites, follows and history formatting", () => {
  assert.equal(formatFavorites({ folders: [{ id: "toview", title: "稍后再看", count: 3 }, { id: "11", title: "Rust", count: 40 }] }),
    "Folders (id · title · videos):\n- toview · 稍后再看 · 3\n- 11 · Rust · 40");
  const fav = formatFavorites({ folderId: "11", source: "local", total: 41, page: 1, hasMore: true, items: [
    { bvid: "BV1", url: "https://www.bilibili.com/video/BV1", title: "Rust 入门", author: "UP", duration: 125, favTime: 0, tags: ["教程", "Rust"], verdict: "keep", summary: "所有权讲透", note: "第二遍\n再看", kept: true },
    { bvid: "BV2", url: "https://www.bilibili.com/video/BV2", title: "Gone", author: "", duration: 0, favTime: 0, invalid: true },
  ] });
  assert.equal(fav, [
    "Folder 11. Page 1, 2 of 41 (MoonDigest's copy). More: page 2.",
    "- [02:05] Rust 入门 · UP · https://www.bilibili.com/video/BV1 · kept · AI: keep · tags: 教程, Rust · summary: 所有权讲透 · note: 第二遍 再看",
    "- [00:00] Gone · https://www.bilibili.com/video/BV2 · unavailable",
  ].join("\n"));
  const fol = formatFollows({ source: "bilibili", queryIgnored: true, total: 2, page: 1, hasMore: false, items: [{ mid: "7", name: "A", sign: "hi\nthere", groups: ["特别关注", "默认分组"] }] });
  assert.match(fol, /^Follows\. Page 1, 1 of 2\. Query ignored:/);
  assert.match(fol, /\n- A \(mid 7\) · groups: 特别关注, 默认分组 · hi there$/);
  const his = formatHistory({ cursor: "9:100:archive", items: [{ bvid: "BV1", url: "u", title: "T", author: "UP", viewAt: 100, progress: -1, duration: 60, kind: "archive" }, { url: "l", title: "Live", author: "", viewAt: 0, progress: 0, duration: 0, kind: "live" }] });
  const lines = his.split("\n");
  assert.equal(lines[0], 'History, newest first, 2 items. More: cursor "9:100:archive".');
  assert.match(lines[1], /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} · T · UP · watched finished · u$/);
  assert.equal(lines[2], "- Live · live · l");
});

test("personal data tools: params pass through, PERSONAL_DATA_OFF passes through", async () => {
  const s = await setup();
  let off = false;
  const ext = fakeExtension(s.bridge.port, { onCall: (m) => (off
    ? { ok: false, code: "PERSONAL_DATA_OFF", error: "The user has not allowed it. Ask the user to turn it on." }
    : { ok: true, data: m.method === "history" ? { items: [], cursor: "" } : { folders: [] } }) });
  await ext.opened;
  await until(() => s.bridge.connected);
  let r = await s.client.callTool({ name: "get_favorites", arguments: { folderId: "11", page: 2, query: "rust", raw: true } });
  assert.equal(r.content[0].text, '{"folders":[]}');
  r = await s.client.callTool({ name: "get_history", arguments: {} });
  assert.equal(r.content[0].text, "History, newest first, 0 items. No more.");
  const calls = ext.messages.filter((m) => m.method).map(({ method, params }) => ({ method, params }));
  assert.deepEqual(calls, [{ method: "favorites", params: { folderId: "11", page: 2, query: "rust" } }, { method: "history", params: {} }]);
  off = true;
  r = await s.client.callTool({ name: "get_follows", arguments: {} });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "PERSONAL_DATA_OFF: The user has not allowed it. Ask the user to turn it on.");
  ext.ws.close();
  await s.close();
});
