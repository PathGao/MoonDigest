// Run from mcp/: npm test  (node --test test/*.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createBridge, createHub, createMcpServer, formatSearch, formatVideo, formatFavorites, formatFollows, formatHistory, formatCollection, formatCollectionWrite } from "../server.js";

const SERVER = fileURLToPath(new URL("../server.js", import.meta.url));

const noSpawn = () => { throw new Error("spawned a hub"); };

async function setup(opts = {}) {
  const hub = createHub({ port: 0, ...opts });
  await hub.listen();
  const bridge = createBridge({ port: hub.port, spawnHub: noSpawn });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(bridge).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return { hub, bridge, client, async close() { await client.close(); await bridge.close(); await hub.close(); } };
}

// The answer, or the error's code and message, of a bridge call.
const settle = (p) => p.then((data) => ({ data }), (e) => ({ code: e.code, message: e.message }));

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// A /client socket the way a thin dials it; resolves the open socket or rejects with the HTTP status.
function rawClient(port, headers = {}, path = "/client") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const ext = fakeExtension(s.hub.port, { onCall: (m) => (m.method === "get" ? { ok: true, data: VIDEO } : null) });
  await ext.opened;
  await until(() => s.hub.connected);
  const r = await s.client.callTool({ name: "get_video", arguments: { url: VIDEO.url } });
  assert.equal(r.isError, undefined);
  const text = r.content[0].text;
  assert.match(text, /^Title: A talk\nAuthor: Someone\nDate: 2026-01-02\nDuration: 01:02:05\nURL: https:\/\/www.youtube.com\/watch\?v=abc\nVideo id: abc\nSubtitle: English/);
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
  assert.match(formatVideo({ ...VIDEO, description: "D", text: "Body text" }), /Description:\nD\n\nPage text:\nBody text\n\nChapters:/);
  const t = formatVideo({ ...VIDEO, subtitle: { segments: [], lang: "", warning: "", missing: "No subtitle track", needLogin: true } });
  assert.match(t, /Subtitle missing: No subtitle track\nSubtitle note: Bilibili hides/);
  assert.doesNotMatch(t, /Transcript:/);
});

test("rejects a web page Origin", async () => {
  const s = await setup();
  const ext = fakeExtension(s.hub.port, { origin: "https://evil.example" });
  await assert.rejects(ext.opened, /HTTP 401/);
  assert.equal(s.hub.connected, false);
  await s.close();
});

test("second extension gets 4001, first keeps working", async () => {
  const s = await setup();
  const first = fakeExtension(s.hub.port, { onCall: () => ({ ok: true, data: VIDEO }) });
  await first.opened;
  await until(() => s.hub.connected);
  const second = fakeExtension(s.hub.port);
  const code = await new Promise((r) => second.ws.once("close", r));
  assert.equal(code, 4001);
  const r = await s.client.callTool({ name: "get_video", arguments: { url: VIDEO.url } });
  assert.equal(r.isError, undefined);
  first.ws.close();
  await s.close();
});

test("get_frame returns an image block", async () => {
  const s = await setup();
  const ext = fakeExtension(s.hub.port, {
    onCall: (m) => ({ ok: true, data: { at: m.params.at + 0.04, width: 640, height: 360, image: "data:image/jpeg;base64,AAAA" } }),
  });
  await ext.opened;
  await until(() => s.hub.connected);
  const r = await s.client.callTool({ name: "get_frame", arguments: { url: VIDEO.url, at: 75, maxWidth: 640 } });
  assert.deepEqual(r.content[0], { type: "image", mimeType: "image/jpeg", data: "AAAA" });
  assert.equal(r.content[1].text, "Frame at 01:15 (75.04s), 640x360.");
  assert.deepEqual(ext.messages.find((m) => m.method).params, { url: VIDEO.url, at: 75, maxWidth: 640 });
  ext.ws.close();
  await s.close();
});

test("extension errors pass through, THROTTLED says stop", async () => {
  const s = await setup();
  const ext = fakeExtension(s.hub.port, { onCall: () => ({ ok: false, error: "Bilibili answered 412.", code: "THROTTLED" }) });
  await ext.opened;
  await until(() => s.hub.connected);
  const r = await s.client.callTool({ name: "get_video", arguments: { url: VIDEO.url } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^THROTTLED: Bilibili answered 412\. Stop calling MoonDigest/);
  ext.ws.close();
  await s.close();
});

test("no answer -> TIMEOUT", async () => {
  const s = await setup({ callTimeoutMs: 100 });
  const ext = fakeExtension(s.hub.port, { onCall: () => null });
  await ext.opened;
  await until(() => s.hub.connected);
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
  assert.match(r.content[0].text, /^NOT_CONNECTED: .*MoonDigest extension.*允许 Agent 使用我的 B站和 YouTube 账号/);
  await s.close();
});

test("no extension answers NOT_CONNECTED at once, without waiting for one to connect", async () => {
  const s = await setup();
  const started = Date.now();
  const r = await s.client.callTool({ name: "get_video", arguments: { url: VIDEO.url } });
  assert.match(r.content[0].text, /^NOT_CONNECTED: .*允许 Agent 使用.*within a minute/);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  await s.close();
});

test("two thins on one hub each get their own answer when the extension answers out of order", async () => {
  const hub = createHub({ port: 0 });
  await hub.listen();
  const calls = [];
  const ext = fakeExtension(hub.port, { onCall: (m) => {
    calls.push(m);
    if (calls.length === 2) for (const c of [...calls].reverse()) ext.ws.send(JSON.stringify({ id: c.id, ok: true, data: c.params }));
  } });
  await ext.opened;
  await until(() => hub.connected);
  const one = createBridge({ port: hub.port, spawnHub: noSpawn });
  const two = createBridge({ port: hub.port, spawnHub: noSpawn });
  // Both thins number their calls from 1.
  const [a, b] = await Promise.all([one.call("get", { n: 1 }), two.call("get", { n: 2 })]);
  assert.deepEqual([a, b], [{ n: 1 }, { n: 2 }]);
  ext.ws.close();
  await one.close();
  await two.close();
  await hub.close();
});

test("/client takes no Origin and no other path", async () => {
  const hub = createHub({ port: 0 });
  await hub.listen();
  await assert.rejects(rawClient(hub.port, { Origin: "https://evil.example" }), /HTTP 401/);
  await assert.rejects(rawClient(hub.port, { Origin: "chrome-extension://x" }), /HTTP 401/);
  await assert.rejects(rawClient(hub.port, {}, "/other"), /HTTP 401/);
  const ws = await rawClient(hub.port);
  ws.close();
  await hub.close();
});

test("idle: no clients closes the hub, a connected one keeps it, it closes idleMs after the last leaves", async () => {
  const lonely = createHub({ port: 0, idleMs: 100 });
  await lonely.listen();
  await Promise.race([lonely.closed, sleep(1000).then(() => assert.fail("no-client hub still open"))]);

  const hub = createHub({ port: 0, idleMs: 100 });
  await hub.listen();
  let closed = false;
  hub.closed.then(() => { closed = true; });
  const thin = createBridge({ port: hub.port, spawnHub: noSpawn });
  await thin.connect();
  await sleep(400);
  assert.equal(closed, false, "closed with a client connected");
  const left = Date.now();
  await thin.close();
  await Promise.race([hub.closed, sleep(1000).then(() => assert.fail("still open after the last client left"))]);
  assert.ok(Date.now() - left >= 90, `closed ${Date.now() - left} ms after the last client left`);
});

test("hub stops mid-call: the call is NOT_CONNECTED and may or may not have run; the next call starts a new hub", async () => {
  const first = createHub({ port: 0 });
  await first.listen();
  const port = first.port;
  const ext = fakeExtension(port, { onCall: () => null });
  await ext.opened;
  await until(() => first.connected);
  let second = null;
  const thin = createBridge({ port, spawnHub: () => { second = createHub({ port }); second.listen(); } });
  const call = settle(thin.call("get", {}));
  await until(() => ext.messages.some((m) => m.method));
  await first.close();
  const r = await call;
  assert.equal(r.code, "NOT_CONNECTED");
  assert.match(r.message, /stopped before answering.*may or may not have run.*undo with list: true/);
  assert.match((await settle(thin.call("get", {}))).message, /^No browser extension is connected/);
  assert.ok(second, "no new hub");
  const ext2 = fakeExtension(port, { onCall: () => ({ ok: true, data: "again" }) });
  await ext2.opened;
  await until(() => second.connected);
  assert.deepEqual(await settle(thin.call("get", {})), { data: "again" });
  ext2.ws.close();
  await thin.close();
  await second.close();
});

test("a newer thin replaces an older hub after its calls in flight; an older thin does not", async () => {
  const OLD = { version: "0.1.2", mtime: 1 }, NEW = { version: "0.1.10", mtime: 0 };
  const old = createHub({ port: 0, build: OLD });
  await old.listen();
  const port = old.port;
  let oldClosed = false;
  old.closed.then(() => { oldClosed = true; });
  let release;
  const ext = fakeExtension(port, { onCall: (m) => { release = () => ext.ws.send(JSON.stringify({ id: m.id, ok: true, data: "slow" })); } });
  await ext.opened;
  await until(() => old.connected);
  const bystander = createBridge({ port, build: OLD, spawnHub: noSpawn });
  await bystander.connect();
  const same = createBridge({ port, build: OLD, spawnHub: noSpawn });
  const inFlight = settle(same.call("get", {}));
  await until(() => ext.messages.some((m) => m.method));

  let hub = null;
  const newer = createBridge({ port, build: NEW, spawnHub: () => { hub = createHub({ port, build: NEW }); hub.listen(); } });
  assert.match((await settle(newer.call("get", {}))).message, /^No browser extension is connected/);
  assert.ok(hub, "no new hub");
  // The old hub is still finishing its call; a session with nothing in flight is already on the new one.
  assert.match((await settle(bystander.call("get", {}))).message, /^No browser extension is connected/);
  // So is the session whose call the old hub is still finishing, for its next call.
  assert.match((await settle(same.call("get", {}))).message, /^No browser extension is connected/);
  release();
  assert.deepEqual(await inFlight, { data: "slow" });
  await Promise.race([old.closed, sleep(2000)]);
  assert.equal(oldClosed, true, "old hub still running");

  const ext2 = fakeExtension(port, { onCall: () => ({ ok: true, data: "new" }) });
  await ext2.opened;
  await until(() => hub.connected);
  assert.deepEqual(await settle(newer.call("get", {})), { data: "new" });
  const older = createBridge({ port, build: { version: "0.1.9", mtime: 9e12 }, spawnHub: noSpawn });
  assert.deepEqual(await settle(older.call("get", {})), { data: "new" });
  assert.deepEqual(await settle(same.call("get", {})), { data: "new" });
  ext2.ws.close();
  for (const b of [same, newer, older, bystander]) await b.close();
  await hub.close();
});

// A stand-in for the hub: welcomes a thin, then does what onMessage says.
async function fakeHub({ build = { version: "99.0.0", mtime: 0 }, onConnection = () => true, onMessage = () => {} } = {}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  let n = 0;
  wss.on("connection", (ws) => {
    if (!onConnection(ws, ++n)) return;
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === "hello") ws.send(JSON.stringify({ type: "welcome", build }));
      else onMessage(ws, msg);
    });
  });
  return { port: wss.address().port, close: () => { for (const c of wss.clients) c.terminate(); return new Promise((r) => wss.close(r)); } };
}

test("frames that are not JSON objects are ignored on both sockets", async () => {
  const s = await setup();
  const ext = fakeExtension(s.hub.port, { onCall: () => ({ ok: true, data: VIDEO }) });
  await ext.opened;
  await until(() => s.hub.connected);
  const raw = await rawClient(s.hub.port);
  for (const frame of ["null", "1", "[1]", "{", "\"x\""]) { raw.send(frame); ext.ws.send(frame); }
  await sleep(50);
  const r = await s.client.callTool({ name: "get_video", arguments: { url: VIDEO.url } });
  assert.equal(r.isError, undefined);
  raw.close();
  ext.ws.close();
  await s.close();
});

test("a call that reaches a hub on its way out is answered as not passed on", async () => {
  const hub = createHub({ port: 0 });
  await hub.listen();
  const ext = fakeExtension(hub.port);
  await ext.opened;
  await until(() => hub.connected);
  const busy = await rawClient(hub.port);
  const answers = [];
  busy.on("message", (raw) => answers.push(JSON.parse(String(raw))));
  busy.send(JSON.stringify({ id: "1", method: "get", params: {} }));
  await until(() => ext.messages.some((m) => m.method));
  (await rawClient(hub.port)).send(JSON.stringify({ type: "shutdown" }));
  await until(() => answers.some((m) => m.type === "stopping"));
  busy.send(JSON.stringify({ id: "2", method: "favWrite", params: {} }));
  await until(() => answers.some((m) => m.id === "2"));
  const refused = answers.find((m) => m.id === "2");
  assert.equal(refused.code, "NOT_CONNECTED");
  assert.match(refused.error, /did not pass this call to the browser\. Call again/);
  assert.equal(ext.messages.filter((m) => m.method).length, 1);
  busy.close();
  ext.ws.close();
  await hub.close();
});

test("a hub that never answers -> TIMEOUT that says the call may have run; the next call dials again", async () => {
  const stuck = await fakeHub();
  const thin = createBridge({ port: stuck.port, callTimeoutMs: 100, spawnHub: noSpawn });
  const r = await settle(thin.call("favWrite", {}));
  assert.equal(r.code, "TIMEOUT");
  assert.match(r.message, /^The shared moondigest-mcp process did not answer "favWrite" within .*may or may not have run/);
  await stuck.close();
  const hub = createHub({ port: stuck.port });
  await hub.listen();
  assert.match((await settle(thin.call("get", {}))).message, /^No browser extension is connected/);
  await thin.close();
  await hub.close();
});

test("an older hub that ignores shutdown is used rather than waited on forever", async () => {
  const deaf = await fakeHub({ build: { version: "0.0.1", mtime: 0 }, onMessage: (ws, m) => { if (m.method) ws.send(JSON.stringify({ id: m.id, ok: true, data: "old" })); } });
  const thin = createBridge({ port: deaf.port, spawnHub: noSpawn });
  assert.deepEqual(await settle(thin.call("get", {})), { data: "old" });
  await thin.close();
  await deaf.close();
});

test("a hub that drops a thin during the handshake is dialed again, not reported as another program", async () => {
  const hub = await fakeHub({
    onConnection: (ws, n) => { if (n === 1) ws.close(); return n > 1; },
    onMessage: (ws, m) => ws.send(JSON.stringify({ id: m.id, ok: true, data: "second dial" })),
  });
  const thin = createBridge({ port: hub.port, spawnHub: noSpawn });
  assert.deepEqual(await settle(thin.call("get", {})), { data: "second dial" });
  await thin.close();
  await hub.close();
});

test("the hub cannot be started -> NOT_CONNECTED that says how to see why; the next call tries again", async () => {
  const port = await freePort();
  let tries = 0;
  const thin = createBridge({ port, spawnHub: () => { tries++; throw new Error("EMFILE"); } });
  await thin.connect();
  for (const n of [2, 3]) {
    const r = await settle(thin.call("get", {}));
    assert.equal(r.code, "NOT_CONNECTED");
    assert.match(r.message, /could not start its shared process on .*: EMFILE\. Run `node .*server\.js --hub`/);
    assert.equal(tries, n);
  }
});

test("port held by a moondigest-mcp from before the hub -> PORT_IN_USE, then the next call works", async () => {
  const holder = new WebSocketServer({ host: "127.0.0.1", port: 0, verifyClient: ({ origin }) => typeof origin === "string" && origin.startsWith("chrome-extension://") });
  await new Promise((r) => holder.once("listening", r));
  const port = holder.address().port;
  let hub = null;
  const bridge = createBridge({ port, spawnHub: () => { hub = createHub({ port }); hub.listen(); } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(bridge).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const r = await client.callTool({ name: "get_video", arguments: { url: VIDEO.url } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, new RegExp(`^PORT_IN_USE: Port ${port} is used by another program, most likely a moondigest-mcp from before the shared-process change.*lsof -nP -iTCP:${port} -sTCP:LISTEN.*The next call picks the port up\\.$`));
  assert.equal(hub, null);
  await new Promise((res) => holder.close(res));
  const r2 = await client.callTool({ name: "get_video", arguments: { url: VIDEO.url } });
  assert.match(r2.content[0].text, /^NOT_CONNECTED: No browser extension/);
  const ext = fakeExtension(port, { onCall: () => ({ ok: true, data: VIDEO }) });
  await ext.opened;
  await until(() => hub.connected);
  const r3 = await client.callTool({ name: "get_video", arguments: { url: VIDEO.url } });
  assert.match(r3.content[0].text, /^Title: A talk/);
  ext.ws.close();
  await client.close();
  await bridge.close();
  await hub.close();
});

test("a client gone mid-call: others go on, and its call does not hold the hub's stop", async () => {
  const hub = createHub({ port: 0, callTimeoutMs: 5000 });
  await hub.listen();
  const calls = [];
  const ext = fakeExtension(hub.port, { onCall: (m) => { calls.push(m); return m.params.now ? { ok: true, data: m.params } : null; } });
  await ext.opened;
  await until(() => hub.connected);
  const gone = createBridge({ port: hub.port, spawnHub: noSpawn });
  const stays = createBridge({ port: hub.port, spawnHub: noSpawn });
  const lost = settle(gone.call("get", { late: true }));
  await until(() => calls.length === 1);
  await gone.close();
  assert.equal((await lost).code, "NOT_CONNECTED");
  ext.ws.send(JSON.stringify({ id: calls[0].id, ok: true, data: "late" }));
  assert.deepEqual(await settle(stays.call("get", { now: 1 })), { data: { now: 1 } });
  // A call left behind by a client that went away must not hold the hub's stop until its timeout.
  const gone2 = createBridge({ port: hub.port, spawnHub: noSpawn });
  const lost2 = settle(gone2.call("get", { late: true }));
  await until(() => calls.length === 3);
  await gone2.close();
  await lost2;
  const stopper = await rawClient(hub.port);
  const t = Date.now();
  stopper.send(JSON.stringify({ type: "shutdown" }));
  await Promise.race([hub.closed, sleep(2000)]);
  assert.ok(Date.now() - t < 1000, `hub took ${Date.now() - t} ms to stop`);
  ext.ws.close();
  await stays.close();
  await hub.close();
});

test("real binaries: two sessions started at once share one hub on the port", async () => {
  const port = await freePort();
  const env = { ...process.env, MOONDIGEST_MCP_PORT: String(port) };
  const clients = [new Client({ name: "a", version: "0" }), new Client({ name: "b", version: "0" })];
  let ext;
  try {
  await Promise.all(clients.map((c) => c.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env }))));
  for (let i = 0; ; i++) {
    ext = fakeExtension(port, { onCall: (m) => ({ ok: true, data: { ...VIDEO, title: m.params.url } }) });
    try { await ext.opened; break; } catch (e) { if (i > 50) throw e; await sleep(100); }
  }
  const ask = async (c, url) => {
    for (let i = 0; i < 50; i++) {
      const text = (await c.callTool({ name: "get_video", arguments: { url } })).content[0].text;
      if (!/^NOT_CONNECTED/.test(text)) return text;
      await sleep(50);
    }
  };
  const [a, b] = await Promise.all([ask(clients[0], "https://a.example/"), ask(clients[1], "https://b.example/")]);
  assert.match(a, /^Title: https:\/\/a\.example\//);
  assert.match(b, /^Title: https:\/\/b\.example\//);
  } finally {
    // A failure above must not leave the detached hub running.
    ext?.ws.close();
    for (const c of clients) await c.close().catch(() => {});
    const stopper = await rawClient(port).catch(() => null);
    if (stopper) {
      stopper.send(JSON.stringify({ type: "shutdown" }));
      await new Promise((r) => stopper.once("close", r));
    }
  }
  // The hub is the only listener there: the port coming free is the hub having exited.
  const isFree = () => new Promise((r) => { const s = createServer().once("error", () => r(false)).listen(port, "127.0.0.1", () => s.close(() => r(true))); });
  let free = false;
  for (let i = 0; i < 50 && !(free = await isFree()); i++) await sleep(100);
  assert.equal(free, true, "the hub still holds the port");
});

test("stdio binary lists the tools", async () => {
  const hub = createHub({ port: 0 });
  await hub.listen();
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, MOONDIGEST_MCP_PORT: String(hub.port) } });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["search_videos", "get_video", "get_frame", "get_favorites", "sync_favorites", "fav_write", "undo", "get_covers", "get_follows", "get_history", "list_collection", "collection_write", "set_triage", "triage_settings"]);
  // The server tells the model to check videos that turn up in its own searches, not only linked ones.
  assert.match(client.getInstructions() || "", /search turns up Bilibili or YouTube videos/);
  assert.match(tools.find((t) => t.name === "get_video").description, /search results/);
  assert.match(client.getInstructions() || "", /search with search_videos, then read the best few with get_video/);
  assert.doesNotMatch(client.getInstructions() || "", /cannot search/);
  await client.close();
  await hub.close();
});

test("binary exits when its MCP client closes stdin", async () => {
  const hub = createHub({ port: 0 });
  await hub.listen();
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, MOONDIGEST_MCP_PORT: String(hub.port) }, stdio: ["pipe", "ignore", "inherit"] });
  setTimeout(() => child.stdin.end(), 200);
  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => { child.kill(); reject(new Error("still running")); }, 3000);
    child.once("exit", (c) => { clearTimeout(t); resolve(c); });
  });
  assert.equal(code, 0);
  await hub.close();
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
  const ext = fakeExtension(s.hub.port, { onCall: (m) => (m.method === "search" ? { ok: true, data: { ...RESULTS, page: m.params.page } } : null) });
  await ext.opened;
  await until(() => s.hub.connected);
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
  const ext = fakeExtension(s.hub.port, { onCall: () => ({ ok: true, data: RESULTS }) });
  await ext.opened;
  await until(() => s.hub.connected);
  for (const [args, re] of [[{}, /query is required/], [{ query: "x", site: "" }, /site must be/], [{ query: "x", page: 0 }, /page must be/], [{ query: "x", page: 1.5 }, /page must be/]]) {
    const r = await s.client.callTool({ name: "search_videos", arguments: args });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, re);
  }
  assert.equal(ext.messages.filter((m) => m.method).length, 0);
  ext.ws.close();
  await s.close();
});

test("search_videos: the extension says which sites search", async () => {
  const s = await setup();
  const ext = fakeExtension(s.hub.port, { onCall: () => ({ ok: false, error: 'site must be one of "bilibili", "youtube".' }) });
  await ext.opened;
  await until(() => s.hub.connected);
  const r = await s.client.callTool({ name: "search_videos", arguments: { query: "x", site: "vimeo" } });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'site must be one of "bilibili", "youtube".');
  assert.deepEqual(ext.messages.find((m) => m.method).params, { site: "vimeo", query: "x", page: 1 });
  assert.equal(formatSearch({ site: "demo", query: "x", page: 1, items: [] }), 'No demo videos for "x" on page 1.');
  ext.ws.close();
  await s.close();
});

test("search_videos: empty is not an error, THROTTLED says stop", async () => {
  assert.equal(formatSearch({ site: "youtube", query: "zzz", page: 1, items: [] }), 'No YouTube videos for "zzz" on page 1.');
  const s = await setup();
  const ext = fakeExtension(s.hub.port, { onCall: () => ({ ok: false, error: "YouTube 限流，请稍后再试", code: "THROTTLED" }) });
  await ext.opened;
  await until(() => s.hub.connected);
  const r = await s.client.callTool({ name: "search_videos", arguments: { query: "x", site: "youtube" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^THROTTLED: YouTube 限流，请稍后再试 Stop calling MoonDigest/);
  ext.ws.close();
  await s.close();
});

test("personal data: favorites, follows and history formatting", () => {
  assert.equal(formatFavorites({ folders: [{ id: "toview", title: "稍后再看", count: 3 }, { id: "11", title: "Rust", count: 40 }] }),
    "Folders (id · title · videos on Bilibili · ticked for 分拣 and how many videos MoonDigest's copy holds):\n- toview · 稍后再看 · 3\n- 11 · Rust · 40");
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
  const ext = fakeExtension(s.hub.port, { onCall: (m) => (off
    ? { ok: false, code: "PERSONAL_DATA_OFF", error: "The user has not allowed it. Ask the user to turn it on." }
    : { ok: true, data: m.method === "history" ? { items: [], cursor: "" } : { folders: [] } }) });
  await ext.opened;
  await until(() => s.hub.connected);
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

test("collection formatting: videos, playlists, channels; a write's items, lists and undo", () => {
  const t = formatCollection({ site: "youtube", kind: "watch_later", cursor: "TOK", items: [
    { videoId: "v1", url: "u1", title: "T", author: "A", duration: 125 }, { videoId: "v2", url: "u2", title: "Gone", author: "", duration: 0, unavailable: true },
  ] });
  assert.equal(t, 'youtube watch_later, 2 items. More: cursor "TOK".\n- [02:05] T · A · u1\n- Gone · u2 · unavailable');
  assert.equal(formatCollection({ site: "youtube", kind: "playlists", cursor: "", items: [{ id: "PL1", title: "Mine", count: 3 }, { id: "PL2", title: "New" }] }), "youtube playlists, 2 items. No more.\n- PL1 · Mine · 3 videos\n- PL2 · New");
  assert.equal(formatCollection({ site: "youtube", kind: "subscriptions", cursor: "", items: [{ channelId: "UC1", url: "c", title: "Chan" }] }), "youtube subscriptions, 1 items. No more.\n- Chan · UC1 · c");
  const w = formatCollectionWrite({ site: "youtube", op: "add", kind: "playlist", id: "PL1", dryRun: false, done: ["b"], notDone: ["d"], stopped: "THROTTLED",
    results: [{ item: "a", status: "unchanged", before: true }, { item: "b", status: "done", before: false, after: true }, { item: "c", status: "failed", before: false, error: "HTTP 429" }],
    undo: { site: "youtube", op: "remove", kind: "playlist", id: "PL1", items: ["b"] } });
  assert.equal(w, [
    "add on youtube playlist PL1.", "- a: already so, skipped (was in)", "- b: done (was not in, now in)", "- c: failed (was not in): HTTP 429",
    "Done: b.", "Not tried: d.", "Stopped: THROTTLED. Stop calling MoonDigest for now and tell the user; do not retry soon.",
    'Undo: collection_write {"site":"youtube","op":"remove","kind":"playlist","id":"PL1","items":["b"]}',
  ].join("\n"));
  const dry = formatCollectionWrite({ site: "youtube", op: "remove", kind: "watch_later", dryRun: true, done: [], notDone: [], results: [{ item: "a", status: "would_change", before: true }], undo: null });
  assert.equal(dry, "Dry run, nothing changed: remove on youtube watch_later.\n- a: would change (was in)");
});

test("collection tools: params pass through; a stopped batch is an error with its lists, a timed-out one is not; COLLECTION_WRITES_OFF passes through", async () => {
  const s = await setup();
  let reply = null;
  const ext = fakeExtension(s.hub.port, { onCall: () => reply });
  await ext.opened;
  await until(() => s.hub.connected);
  reply = { ok: true, data: { site: "youtube", kind: "playlist", id: "PL1", items: [], cursor: "" } };
  let r = await s.client.callTool({ name: "list_collection", arguments: { site: "youtube", kind: "playlist", id: "PL1", cursor: "C", raw: false } });
  assert.equal(r.content[0].text, "youtube playlist PL1, 0 items. No more.");
  const base = { site: "youtube", op: "add", kind: "watch_later", dryRun: false, results: [], done: [], notDone: ["v2"], undo: null };
  reply = { ok: true, data: { ...base, stopped: "THROTTLED" } };
  r = await s.client.callTool({ name: "collection_write", arguments: { site: "youtube", op: "add", kind: "watch_later", items: ["v1", "v2"], dryRun: false } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^THROTTLED: add on youtube watch_later\.[\s\S]*Not tried: v2\./);
  reply = { ok: true, data: { ...base, stopped: "TIMEOUT" } };
  r = await s.client.callTool({ name: "collection_write", arguments: { site: "youtube", op: "add", kind: "watch_later", items: ["v1", "v2"] } });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /Call again with the items not tried\./);
  reply = { ok: false, code: "COLLECTION_WRITES_OFF", error: "Not allowed." };
  r = await s.client.callTool({ name: "collection_write", arguments: { site: "youtube", op: "remove", kind: "watch_later", items: ["v1"] } });
  assert.deepEqual([r.isError, r.content[0].text], [true, "COLLECTION_WRITES_OFF: Not allowed."]);
  const calls = ext.messages.filter((m) => m.method).map(({ method, params }) => ({ method, params }));
  assert.deepEqual(calls[0], { method: "collection", params: { site: "youtube", kind: "playlist", id: "PL1", cursor: "C" } });
  assert.deepEqual(calls[1], { method: "collectionWrite", params: { site: "youtube", op: "add", kind: "watch_later", items: ["v1", "v2"], dryRun: false } });
  ext.ws.close();
  await s.close();
});

test("an extension older than the server: its unknown-method answer says to update the extension", async () => {
  const s = await setup();
  const ext = fakeExtension(s.hub.port, { onCall: (m) => ({ ok: false, error: `Unknown method ${m.method}.` }) });
  await ext.opened;
  await until(() => s.hub.connected);
  const r = await s.client.callTool({ name: "fav_write", arguments: { op: "unfav", from: "11", bvids: ["BV1aaaaaaaaa"] } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^Unknown method favWrite\. The MoonDigest extension in the browser is older than this MCP server.*update the extension/);
  ext.ws.close();
  await s.close();
});

test("writes: params pass through, the answers say what happened and give the undo id; a batch B站 stopped is an error with what was done", async () => {
  const s = await setup();
  const answers = {
    triage: { changed: 2, undoId: "a1", tagsNotMade: ["新"] },
    favWrite: { op: "move", from: "11", to: "22", done: ["BV1aaaaaaaaa"], notDone: [], undoId: "a2" },
    undo: { id: "a2", n: 1, skipped: 0 },
    log: { entries: [{ id: "a2", at: 1700000000000, kind: "fav", op: "move", n: 1, titles: { from: "Rust", to: "杂" } }] },
    sync: { folders: [{ id: "11", title: "Rust", count: 3, private: true, included: true, synced: 2 }, { id: "22", title: "杂", count: 1 }], job: { running: true, total: 2, done: 1, current: "22", read: 1, unchanged: 0, partial: [] }, notes: ["Unticked: 33."] },
    triageSettings: { folders: [{ id: "11", title: "Rust", criteria: "只留教程", tags: [{ name: "入门", videos: 3, rule: "新手向" }] }], changed: { folderId: "11", was: "旧", undoId: "a3" } },
    covers: { image: "data:image/jpeg;base64,QUJD", width: 1280, height: 200, cells: [{ n: 1, bvid: "BV1aaaaaaaaa", title: "一" }, { n: 2, bvid: "BV1bbbbbbbbb", title: "", missing: true }] },
    get: { title: "T", videoId: "BV1aaaaaaaaa", zone: "知识", tags: ["rust"], brief: true, subtitle: { segments: [] } },
  };
  let stop = false;
  const ext = fakeExtension(s.hub.port, { onCall: (m) => ({ ok: true, data: stop ? { op: "unfav", from: "11", done: ["BV1aaaaaaaaa"], notDone: ["BV1bbbbbbbbb"], stopped: "THROTTLED", undoId: "a9" } : answers[m.method] }) });
  await ext.opened;
  await until(() => s.hub.connected);
  const call = async (name, args) => (await s.client.callTool({ name, arguments: args })).content;
  const items = [{ bvid: "BV1aaaaaaaaa", verdict: "drop", coarse: true, reason: "标题党" }];
  assert.equal((await call("set_triage", { items }))[0].text, 'Saved in the 分拣台: 2 video(s) changed. Undo: undo {"id":"a1"}. Not made (the folder is at its tag limit): 新.');
  assert.equal((await call("fav_write", { op: "move", from: "11", to: "22", bvids: ["BV1aaaaaaaaa"], extra: 1 }))[0].text, 'move from 11 to 22: 1 done on Bilibili. Undo: undo {"id":"a2"}.');
  assert.equal((await call("undo", { id: "a2" }))[0].text, "Undone (a2): 1 video(s).");
  assert.match((await call("undo", { list: true }))[0].text, /^Recorded changes, newest first.*\n- a2 · .* · move · 1 video\(s\) · Rust → 杂$/);
  assert.equal((await call("sync_favorites", { include: ["22"], start: true }))[0].text, [
    "Folders (id · title · videos on Bilibili · ticked for 分拣 and how many videos MoonDigest's copy holds):",
    "- 11 · Rust · 3 · private · ticked, copy holds 2",
    "- 22 · 杂 · 1",
    "Reading in the background: 1 of 2 folders done, now 22. Call sync_favorites with no parameters again in a while for the progress.",
    "Unticked: 33.",
  ].join("\n"));
  assert.equal((await call("triage_settings", { folderId: "11", criteria: "只留教程" }))[0].text, [
    '判断标准 of folder 11 changed (was: 旧). Undo: undo {"id":"a3"}. Results judged by the old one now count as stale in the 分拣台: tell the user.',
    "Folder 11 「Rust」", "  判断标准: 只留教程", "  Tags: 入门 (3; rule: 新手向)",
  ].join("\n"));
  const covers = await call("get_covers", { bvids: ["BV1aaaaaaaaa", "BV1bbbbbbbbb"] });
  assert.deepEqual([covers[0].type, covers[0].mimeType, covers[0].data, covers[1].text], ["image", "image/jpeg", "QUJD", "1. BV1aaaaaaaaa 一\n2. BV1bbbbbbbbb  (no cover)"]);
  assert.match((await call("get_video", { url: "https://www.bilibili.com/video/BV1aaaaaaaaa", brief: true }))[0].text, /^Title: T\nVideo id: BV1aaaaaaaaa\nZone: 知识\nTags: rust\nBrief: /);
  const calls = ext.messages.filter((m) => m.method).map(({ method, params }) => ({ method, params }));
  assert.deepEqual(calls, [
    { method: "triage", params: { items } },
    { method: "favWrite", params: { op: "move", from: "11", to: "22", bvids: ["BV1aaaaaaaaa"] } },
    { method: "undo", params: { id: "a2" } },
    { method: "log", params: {} },
    { method: "sync", params: { include: ["22"], start: true } },
    { method: "triageSettings", params: { folderId: "11", criteria: "只留教程" } },
    { method: "covers", params: { bvids: ["BV1aaaaaaaaa", "BV1bbbbbbbbb"] } },
    { method: "get", params: { url: "https://www.bilibili.com/video/BV1aaaaaaaaa", brief: true } },
  ]);
  stop = true;
  const r = await s.client.callTool({ name: "fav_write", arguments: { op: "unfav", from: "11", bvids: ["BV1aaaaaaaaa", "BV1bbbbbbbbb"] } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^THROTTLED: unfav from 11: 1 done on Bilibili, 1 not done\. Undo: undo \{"id":"a9"\}\.\nStopped: THROTTLED\..*Not done: BV1bbbbbbbbb$/);
  ext.ws.close();
  await s.close();
});
