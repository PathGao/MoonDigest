// Run from mcp/: npm test  (node --test test/*.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createBridge, createMcpServer, formatVideo } from "../server.js";

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

test("stdio binary lists the two tools", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, MOONDIGEST_MCP_PORT: "0" } });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["get_video", "get_frame"]);
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
