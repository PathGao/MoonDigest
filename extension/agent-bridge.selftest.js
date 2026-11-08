// Self-test for agent-bridge.js: node extension/agent-bridge.selftest.js
// Runs the bridge in a vm with stubbed chrome APIs, a fake WebSocket and manual timers.
// Uses process.getBuiltinModule so it runs whether this folder is CommonJS or ESM.
const fs = process.getBuiltinModule("node:fs");
const vm = process.getBuiltinModule("node:vm");
const path = process.getBuiltinModule("node:path");
const assert = process.getBuiltinModule("node:assert/strict");

const here = path.dirname(fs.realpathSync(process.argv[1]));
// The worker's order: sites.js (MdgSites.cleanComment) and what it needs, the registry, the sites, the bridge.
const SOURCES = ["common.js", "errors.js", "limits.js", "settings.js", "sites.js", "agent-sites/registry.js", "agent-sites/bilibili.js", "agent-sites/youtube.js", "agent-bridge.js"].map((f) => [f, fs.readFileSync(path.join(here, f), "utf8")]);

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

// granted: the origins chrome.permissions.contains answers true for; inject(tab, details): executeScript's result.
// sync: chrome.storage.sync (the MCP switches).
function makeEnv({ enabled, tabs = [], session = {}, answer = null, commitNow = false, granted = [], inject = null, sync = {} }) {
  const env = { sockets: [], timers: [], storage: {}, alarms: new Set(), created: [], updated: [], shown: [], sent: [], injected: [], enabledCb: null, alarmCb: null, pageReplies: [] };
  let nextTimer = 1;
  let nextTab = 100;
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.out = []; env.sockets.push(this); }
    send(s) { this.out.push(JSON.parse(s)); }
    close() { if (this.readyState === 3) return; this.readyState = 3; setImmediate(() => this.onclose && this.onclose()); }
    open() { this.readyState = 1; this.onopen(); }
    fail() { this.readyState = 3; this.onclose(); }
    receive(msg) { this.onmessage({ data: JSON.stringify(msg) }); }
  }
  const chrome = {
    permissions: { contains: async ({ origins }) => origins.every((o) => granted.includes(o)) },
    scripting: {
      executeScript: async (d) => {
        // out of the vm realm
        env.injected.push(d.files ? { tabId: d.target.tabId, files: [...d.files] } : { tabId: d.target.tabId, world: d.world, args: JSON.parse(JSON.stringify(d.args)) });
        return [{ result: await inject(tabs.find((t) => t.id === d.target.tabId), d) }];
      },
    },
    alarms: {
      create: (name) => env.alarms.add(name),
      clear: (name) => env.alarms.delete(name),
      onAlarm: { addListener: (cb) => { env.alarmCb = cb; } },
    },
    storage: {
      local: { set: (o) => Object.assign(env.storage, o) },
      sync: { get: async (keys) => Object.fromEntries([keys].flat().filter((k) => k in sync).map((k) => [k, sync[k]])) },
      session: { // shared across makeEnv calls to simulate a service worker restart
        get: async (k) => (k in session ? { [k]: JSON.parse(session[k]) } : {}),
        set: async (o) => { for (const k in o) session[k] = JSON.stringify(o[k]); },
        remove: async (k) => { delete session[k]; },
      },
    },
    tabs: {
      // url, active and windowId filter; a url pattern's host is matched, "*." as any subdomain.
      query: async (q = {}) => tabs.filter((t) => (q.active === undefined || !!t.active === q.active) && (q.windowId === undefined || t.windowId === q.windowId) &&
        (q.url === undefined || q.url.some((p) => { const h = p.split("/")[2]; const host = new URL(t.url).hostname; return h.startsWith("*.") ? host === h.slice(2) || host.endsWith(h.slice(1)) : host === h; }))),
      get: async (id) => { const t = tabs.find((x) => x.id === id); if (!t) throw new Error("no tab"); return t; },
      create: async ({ url, active }) => { const t = { id: nextTab++, url, active, windowId: 1 }; tabs.push(t); env.created.push(t); return t; },
      update: async (id, { url, active }) => { // the URL commits when the test says so, or at once with commitNow
        const t = tabs.find((x) => x.id === id);
        if (url !== undefined) {
          env.updated.push({ id, url });
          if (commitNow) t.url = url;
        }
        if (active) {
          env.shown.push(id);
          for (const x of tabs) if (x.windowId === t.windowId) x.active = x.id === id;
        }
        return t;
      },
      sendMessage: async (tabId, msg) => {
        env.sent.push({ tabId, msg: JSON.parse(JSON.stringify(msg)) }); // copy out of the vm realm
        if (answer) return answer(tabs.find((t) => t.id === tabId));
        const r = env.pageReplies.shift();
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
  const ctx = {
    chrome, WebSocket: FakeWebSocket, console, URL, JSON, Promise, Date, Math, Object, String, Map,
    setTimeout: (fn, ms) => { const id = nextTimer++; env.timers.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { env.timers = env.timers.filter((t) => t.id !== id); },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const [filename, source] of SOURCES) vm.runInContext(source, ctx, { filename });
  env.sites = ctx.MdgAgentSites;
  env.runTimers = () => { const ts = env.timers; env.timers = []; for (const t of ts) t.fn(); };
  env.start = () => ctx.MdgAgentBridge.start({
    extensionVersion: "1.2.3",
    isEnabled: async () => enabled,
    onEnabledChange: (cb) => { env.enabledCb = cb; },
  });
  env.tabs = tabs;
  env.addMethods = (m) => ctx.MdgAgentBridge.addMethods(m);
  env.inSitePage = (...a) => ctx.MdgAgentBridge.inSitePage(...a);
  return env;
}

async function openSocket(env) {
  env.start();
  await settle();
  const s = env.sockets.at(-1);
  s.open();
  return s;
}

async function rpc(sock, id, method, params) {
  sock.receive({ id, method, params });
  await settle();
  return sock.out.find((m) => m.id === id);
}

const cases = [];
const check = (name, fn) => cases.push([name, fn]);

check("off: no socket, status off", async () => {
  const env = makeEnv({ enabled: false });
  env.start();
  await settle();
  assert.equal(env.sockets.length, 0);
  assert.equal(env.storage.mcpStatus, "off");
  assert.equal(env.alarms.size, 0);
  env.alarmCb({ name: "agent-bridge" });
  env.runTimers();
  assert.equal(env.sockets.length, 0);
});

check("on: hello, connected, pong", async () => {
  const env = makeEnv({ enabled: true });
  env.start();
  await settle();
  assert.equal(env.storage.mcpStatus, "disconnected");
  const s = env.sockets[0];
  assert.equal(s.url, "ws://127.0.0.1:47823/");
  s.open();
  assert.deepEqual(s.out[0], { type: "hello", version: 1, extensionVersion: "1.2.3" });
  assert.equal(env.storage.mcpStatus, "connected");
  s.receive({ type: "ping" });
  assert.deepEqual(s.out[1], { type: "pong" });
  assert.ok(env.alarms.has("agent-bridge"));
});

check("BAD_URL for unsupported pages", async () => {
  const env = makeEnv({ enabled: true });
  const s = await openSocket(env);
  for (const [i, url] of ["https://example.com", "https://www.youtube.com/", "https://www.bilibili.com/", "javascript:alert(1)"].entries()) {
    const r = await rpc(s, `b${i}`, "get", { url });
    assert.equal(r.ok, false, url);
    assert.equal(r.code, "BAD_URL", url);
  }
  assert.equal(env.created.length, 0);
  assert.equal(env.sent.length, 0);
});

check("an added method answers without a tab, before the url check", async () => {
  const env = makeEnv({ enabled: true });
  env.addMethods({ favorites: async (p) => ({ ok: true, data: { got: p } }), history: async () => ({ ok: false, code: "PERSONAL_DATA_OFF", error: "off" }) });
  const s = await openSocket(env);
  assert.deepEqual(await rpc(s, "m1", "favorites", { folderId: "11" }), { id: "m1", ok: true, data: { got: { folderId: "11" } } });
  assert.deepEqual(await rpc(s, "m2", "history", {}), { id: "m2", ok: false, error: "off", code: "PERSONAL_DATA_OFF" });
  assert.equal((await rpc(s, "m3", "toString", {})).error, "Unknown method toString.");
  assert.equal(env.created.length, 0);
  assert.equal(env.sent.length, 0);
});

check("reuses a tab showing the same video", async () => {
  const env = makeEnv({ enabled: true, tabs: [{ id: 7, url: "https://www.youtube.com/watch?v=abc&t=30" }] });
  const s = await openSocket(env);
  env.pageReplies.push({ ok: true, data: { title: "x" } });
  const r = await rpc(s, "1", "get", { url: "https://youtube.com/watch?v=abc" });
  assert.deepEqual(r, { id: "1", ok: true, data: { title: "x" } });
  assert.equal(env.created.length, 0);
  assert.deepEqual(env.sent[0], { tabId: 7, msg: { type: "agent-call", method: "get", params: {} } });
});

check("opens a background tab for another part, waits for its script, then reuses it", async () => {
  const env = makeEnv({ enabled: true, tabs: [{ id: 7, url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1" }] });
  const s = await openSocket(env);
  const url = "https://www.bilibili.com/video/BV1xx411c7mD?p=2";
  env.pageReplies.push(new Error("Receiving end does not exist."), undefined, { ok: true, data: { at: 5 } });
  s.receive({ id: "1", method: "frame", params: { url, at: 5, maxWidth: 640 } });
  for (let i = 0; i < 3; i++) { await settle(); env.runTimers(); }
  await settle();
  assert.deepEqual(s.out.find((m) => m.id === "1"), { id: "1", ok: true, data: { at: 5 } });
  assert.equal(env.created.length, 1);
  assert.equal(env.created[0].active, false);
  assert.equal(env.created[0].url, url);
  assert.deepEqual(env.sent.at(-1).msg, { type: "agent-call", method: "frame", params: { at: 5, maxWidth: 640 } });
  // The URL changed (trailing slash, tracking param): the same tab is still used.
  env.created[0].url = "https://www.bilibili.com/video/BV1xx411c7mD/?p=2&spm_id_from=x";
  env.pageReplies.push({ ok: false, error: "Bilibili answered 412.", code: "THROTTLED" });
  const r = await rpc(s, "2", "get", { url });
  assert.deepEqual(r, { id: "2", ok: false, error: "Bilibili answered 412.", code: "THROTTLED" });
  assert.equal(env.created.length, 1);
  assert.equal(env.sent.at(-1).tabId, env.created[0].id);
});

check("reconnect: 5 s, then backoff to 60 s, reset after a connect", async () => {
  const env = makeEnv({ enabled: true });
  env.start();
  await settle();
  const delays = [];
  for (let i = 0; i < 6; i++) {
    env.sockets.at(-1).fail();
    assert.equal(env.storage.mcpStatus, "disconnected");
    assert.equal(env.timers.length, 1);
    delays.push(env.timers[0].ms);
    env.runTimers();
  }
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000]);
  assert.equal(env.sockets.length, 7);
  env.sockets.at(-1).open();
  env.sockets.at(-1).fail();
  assert.equal(env.timers[0].ms, 5000);
});

check("alarm reconnects when the timer was lost", async () => {
  const env = makeEnv({ enabled: true });
  env.start();
  await settle();
  env.sockets[0].fail();
  env.timers = []; // the service worker restarted and lost its timers
  env.alarmCb({ name: "agent-bridge" });
  assert.equal(env.sockets.length, 2);
  env.alarmCb({ name: "agent-bridge" }); // already has a socket: no-op
  assert.equal(env.sockets.length, 2);
});

check("switch off: closes, status off, stays off", async () => {
  const env = makeEnv({ enabled: true });
  const s = await openSocket(env);
  env.enabledCb(false);
  await settle();
  assert.equal(s.readyState, 3);
  assert.equal(env.storage.mcpStatus, "off");
  assert.equal(env.alarms.size, 0);
  env.runTimers();
  assert.equal(env.sockets.length, 1);
  env.enabledCb(true);
  await settle();
  assert.equal(env.sockets.length, 2);
  assert.equal(env.storage.mcpStatus, "disconnected");
});

const A = "https://www.youtube.com/watch?v=aaa";
const B = "https://www.youtube.com/watch?v=bbb";

async function call(env, s, id, url, rounds = 3) {
  s.receive({ id, method: "get", params: { url } });
  for (let i = 0; i < rounds; i++) { await settle(); env.runTimers(); }
  await settle();
  return s.out.find((m) => m.id === id);
}

check("second video navigates the same own tab, never asks the old page", async () => {
  const env = makeEnv({ enabled: true });
  const s = await openSocket(env);
  env.pageReplies.push({ ok: true, data: { v: "a" } });
  assert.deepEqual((await call(env, s, "1", A)).data, { v: "a" });
  const own = env.created[0];
  const sentBefore = env.sent.length;
  s.receive({ id: "2", method: "get", params: { url: B } });
  for (let i = 0; i < 3; i++) { await settle(); env.runTimers(); }
  assert.deepEqual(env.updated, [{ id: own.id, url: B }]);
  assert.equal(env.sent.length, sentBefore, "asked the previous page while the navigation had not committed");
  own.url = B; // navigation commits
  env.pageReplies.push({ ok: true, data: { v: "b" } });
  for (let i = 0; i < 2; i++) { await settle(); env.runTimers(); }
  await settle();
  assert.deepEqual(s.out.find((m) => m.id === "2").data, { v: "b" });
  assert.equal(env.created.length, 1);
  assert.equal(env.sent.at(-1).tabId, own.id);
  // Back to A: navigates the same tab again, still one tab.
  env.pageReplies.push({ ok: true, data: { v: "a" } });
  s.receive({ id: "3", method: "get", params: { url: A } });
  await settle(); env.runTimers(); await settle();
  own.url = A;
  for (let i = 0; i < 2; i++) { await settle(); env.runTimers(); }
  await settle();
  assert.deepEqual(s.out.find((m) => m.id === "3").data, { v: "a" });
  assert.equal(env.created.length, 1);
  assert.equal(env.updated.length, 2);
});

check("own tab closed by the user is created again", async () => {
  const env = makeEnv({ enabled: true });
  const s = await openSocket(env);
  env.pageReplies.push({ ok: true, data: {} });
  await call(env, s, "1", A);
  env.tabs.splice(env.tabs.indexOf(env.created[0]), 1); // user closes it
  env.pageReplies.push({ ok: true, data: { v: "b" } });
  assert.deepEqual((await call(env, s, "2", B)).data, { v: "b" });
  assert.equal(env.created.length, 2);
  assert.equal(env.created[1].active, false);
  assert.equal(env.updated.length, 0);
});

check("the user's own tab is used but never navigated", async () => {
  const env = makeEnv({ enabled: true, tabs: [{ id: 7, url: A }] });
  const s = await openSocket(env);
  env.pageReplies.push({ ok: true, data: { v: "a" } });
  await call(env, s, "1", A);
  assert.equal(env.sent.at(-1).tabId, 7);
  env.pageReplies.push({ ok: true, data: { v: "b" } });
  await call(env, s, "2", B);
  assert.equal(env.created.length, 1);
  assert.notEqual(env.created[0].id, 7);
  env.pageReplies.push({ ok: true, data: { v: "a" } });
  await call(env, s, "3", A);
  assert.equal(env.sent.at(-1).tabId, 7);
  assert.ok(env.updated.every((u) => u.id !== 7));
  assert.equal(env.tabs.find((t) => t.id === 7).url, A);
});

check("restarted worker finds its old tab in storage.session", async () => {
  const tabs = [];
  const session = {};
  const env1 = makeEnv({ enabled: true, tabs, session, commitNow: true, answer: (t) => ({ ok: true, data: { url: t.url } }) });
  await call(env1, await openSocket(env1), "1", A);
  assert.equal(env1.created.length, 1);
  const env2 = makeEnv({ enabled: true, tabs, session, commitNow: true, answer: (t) => ({ ok: true, data: { url: t.url } }) });
  const r = await call(env2, await openSocket(env2), "2", B);
  assert.deepEqual(r.data, { url: B });
  assert.equal(env2.created.length, 0);
  assert.deepEqual(env2.updated, [{ id: env1.created[0].id, url: B }]);
});

check("concurrent calls for two videos queue on the one own tab", async () => {
  const env = makeEnv({ enabled: true, commitNow: true, answer: (t) => ({ ok: true, data: { url: t.url } }) });
  const s = await openSocket(env);
  s.receive({ id: "1", method: "get", params: { url: A } });
  s.receive({ id: "2", method: "get", params: { url: B } });
  for (let i = 0; i < 4; i++) { await settle(); env.runTimers(); }
  await settle();
  assert.deepEqual(s.out.find((m) => m.id === "1").data, { url: A });
  assert.deepEqual(s.out.find((m) => m.id === "2").data, { url: B });
  assert.equal(env.created.length, 1);
  assert.equal(env.updated.length, 1);
});

check("a frame in a tab never shown: shows it, then the tab that was in front again", async () => {
  const front = { id: 1, url: "https://example.com/", active: true, windowId: 1 };
  const env = makeEnv({
    enabled: true,
    tabs: [front],
    commitNow: true,
    answer: (tab) => (tab.active ? { ok: true, data: { at: 5 } } : { ok: false, code: "TAB_HIDDEN", error: "hidden" }),
  });
  const s = await openSocket(env);
  const got = await rpc(s, 1, "frame", { url: "https://www.youtube.com/watch?v=abc", at: 5 });
  assert.deepEqual(got, { id: 1, ok: true, data: { at: 5 } });
  const own = env.created[0].id;
  assert.deepEqual(env.shown, [own, 1], "shown for the frame, then the user's tab is in front again");
  assert.equal(front.active, true);
  // get never shows a tab.
  const g = await rpc(s, 2, "get", { url: "https://www.youtube.com/watch?v=abc" });
  assert.equal(g.ok, false);
  assert.deepEqual(env.shown, [own, 1]);
});

check("a discarded tab of the user's is skipped; the own tab is muted", async () => {
  const env = makeEnv({ enabled: true, tabs: [{ id: 7, url: A, discarded: true }] });
  const s = await openSocket(env);
  env.pageReplies.push({ ok: true, data: { v: "a" } });
  await call(env, s, "1", A);
  assert.equal(env.created.length, 1);
  assert.equal(env.sent.at(-1).tabId, env.created[0].id);
});

check("a loaded own tab no call answered in is navigated again, not trusted", async () => {
  const env = makeEnv({ enabled: true, commitNow: true });
  const s = await openSocket(env);
  env.pageReplies.push({ ok: false, code: "THROTTLED", error: "limit" });
  await call(env, s, "1", A);
  const own = env.created[0];
  own.url = B; // the user went to another video in it
  own.status = "complete";
  env.pageReplies.push({ ok: true, data: { v: "a" } });
  await call(env, s, "2", A);
  assert.deepEqual(env.updated.at(-1), { id: own.id, url: A });
});

check("the front tab is not taken back when the user moved on during the frame", async () => {
  const front = { id: 1, url: "https://example.com/", active: true, windowId: 1 };
  const other = { id: 2, url: "https://example.org/", active: false, windowId: 1 };
  let env;
  env = makeEnv({
    enabled: true,
    tabs: [front, other],
    commitNow: true,
    answer: (tab) => {
      if (!tab.active) return { ok: false, code: "TAB_HIDDEN", error: "hidden" };
      for (const t of env.tabs) t.active = t.id === 2; // the user clicks another tab while the frame runs
      return { ok: true, data: { at: 5 } };
    },
  });
  const s = await openSocket(env);
  await rpc(s, 1, "frame", { url: A, at: 5 });
  assert.equal(other.active, true);
  assert.equal(front.active, false);
});

check("a call still queued when the server has given up is dropped", async () => {
  let release;
  const env = makeEnv({ enabled: true, commitNow: true, answer: () => new Promise((r) => (release = r)) });
  const s = await openSocket(env);
  s.receive({ id: "1", method: "get", params: { url: A } });
  await settle();
  s.receive({ id: "2", method: "get", params: { url: B } });
  await settle();
  const realNow = Date.now;
  Date.now = () => realNow() + 120_000;
  try {
    release({ ok: true, data: { v: "a" } });
    await settle();
  } finally {
    Date.now = realNow;
  }
  const second = s.out.find((m) => m.id === "2");
  assert.deepEqual([second.ok, second.code], [false, "TIMEOUT"]);
  assert.equal(env.created.length, 1, "B was never loaded");
  assert.equal(env.updated.length, 0);
});

// A site whose adapter reads the page itself (read is a function run in the page's MAIN world).
const DEMO = "https://www.demo.test/v/1";
const demoSite = (env) => env.sites.register({
  id: "demo",
  origins: ["https://www.demo.test/*"],
  key: (u) => (u.hostname === "www.demo.test" && u.pathname.startsWith("/v/") ? `${u.pathname.slice(3)}:` : null),
  read: () => globalThis.__STATE__,
});

check("the fallback site (any web page) answers WEB_PAGES_OFF until its own switch is on, whatever the host access", async () => {
  const any = (env) => env.sites.register({ id: "any", origins: ["https://*/*"], fallback: true, key: (u) => `${u.hostname}:`, read: () => ({ title: "t" }) });
  let env = makeEnv({ enabled: true, commitNow: true, granted: ["https://*/*"], inject: () => ({ title: "t" }) });
  any(env);
  let s = await openSocket(env);
  const r = await call(env, s, "1", "https://mail.example.com/");
  assert.deepEqual([r.ok, r.code], [false, "WEB_PAGES_OFF"]);
  assert.match(r.error, /允许 AI 工具读任意网页/);
  assert.deepEqual([env.created.length, env.injected.length], [0, 0]);
  env = makeEnv({ enabled: true, commitNow: true, granted: ["https://*/*"], inject: () => ({ title: "t" }), sync: { mcpWebPages: true } });
  any(env);
  s = await openSocket(env);
  assert.equal((await call(env, s, "1", "https://example.com/")).ok, true);
});

check("a page-read site without access: NO_ACCESS for get and frame, no tab, nothing injected", async () => {
  const env = makeEnv({ enabled: true });
  demoSite(env);
  const s = await openSocket(env);
  assert.deepEqual(await rpc(s, "1", "get", { url: DEMO }), { id: "1", ok: false, error: "MoonDigest has no access to https://www.demo.test/*: ask the user to allow it.", code: "NO_ACCESS" });
  assert.equal((await rpc(s, "2", "frame", { url: DEMO, at: 1 })).code, "NO_ACCESS");
  assert.match((await rpc(s, "3", "get", { url: "https://example.com/" })).error, /Sites: bilibili, youtube, demo\./);
  assert.equal(env.created.length, 0);
  assert.equal(env.injected.length, 0);
});

check("a page-read site runs read in its own tab's MAIN world, never the user's tab, until the page is ready", async () => {
  const raw = { uname: " ", like: "x", message: ` ${"字".repeat(600)} ` };
  const replies = [null, { title: "t", site: "spoofed", comments: [raw, { uname: "a", message: " " }] }];
  const env = makeEnv({ enabled: true, commitNow: true, granted: ["https://www.demo.test/*"], tabs: [{ id: 7, url: DEMO }], inject: () => replies.shift() });
  demoSite(env);
  const s = await openSocket(env);
  const r = await call(env, s, "1", DEMO);
  // Comments come out as MdgSites.cleanComment gives them (匿名, 500 characters); an empty one is dropped.
  assert.deepEqual(r, { id: "1", ok: true, data: { title: "t", site: "demo", comments: [{ uname: "匿名", like: 0, message: "字".repeat(500) }] } });
  assert.equal(env.created.length, 1);
  assert.equal(env.created[0].active, false);
  assert.deepEqual(env.injected.map((i) => i.tabId), [env.created[0].id, env.created[0].id]);
  assert.deepEqual(env.injected[0], { tabId: env.created[0].id, world: "MAIN", args: [DEMO] });
  assert.equal(env.sent.length, 0, "no content-script message");
});

check("a page-read site's frame injects agent-page.js into its own tab and runs its frame there, in front when hidden", async () => {
  const replies = [{ ok: false, code: "TAB_HIDDEN", error: "hidden" }, { ok: true, data: { at: 5 } }];
  const env = makeEnv({ enabled: true, commitNow: true, granted: ["https://www.demo.test/*"], inject: (_tab, d) => (d.files ? undefined : replies.shift()) });
  demoSite(env);
  const s = await openSocket(env);
  s.receive({ id: "1", method: "frame", params: { url: DEMO, at: 5, maxWidth: 640 } });
  for (let i = 0; i < 3; i++) { await settle(); env.runTimers(); }
  await settle();
  assert.deepEqual(s.out.find((m) => m.id === "1"), { id: "1", ok: true, data: { at: 5 } });
  const id = env.created[0].id;
  const ask = [{ tabId: id, files: ["agent-page.js"] }, { tabId: id, world: undefined, args: [{ at: 5, maxWidth: 640 }] }];
  assert.deepEqual(env.injected, [...ask, ...ask]);
  assert.deepEqual(env.shown, [id]);
  assert.equal(env.sent.length, 0, "no content-script message");
});

check("a page-read site's { error, code } is the call's error, asked once", async () => {
  const env = makeEnv({ enabled: true, commitNow: true, granted: ["https://www.demo.test/*"], inject: () => ({ error: "Demo asks for a captcha.", code: "THROTTLED" }) });
  demoSite(env);
  const s = await openSocket(env);
  assert.deepEqual(await call(env, s, "1", DEMO), { id: "1", ok: false, error: "Demo asks for a captcha.", code: "THROTTLED" });
  assert.equal(env.injected.length, 1);
});

// inSitePage: an adapter's collection call (§5) in the own tab on any page of the site.
const DEMO_HOME = "https://www.demo.test/";
const ready = () => "ready";
const func = () => "func";
const sitePage = (o) => {
  let readyAsks = 0; // the first ask: not ready yet
  const env = makeEnv({ enabled: true, commitNow: true, granted: ["https://www.demo.test/*"], ...o,
    inject: (tab, d) => (d.func === ready ? (readyAsks++ ? { ok: true } : undefined) : o.inject ? o.inject() : { status: 200 }) });
  demoSite(env);
  env.run = async () => {
    const p = env.inSitePage(env.sites.get("demo"), DEMO_HOME, ready, func, ["x"], Date.now() + 60_000);
    for (let i = 0; i < 5; i++) { await settle(); env.runTimers(); }
    return JSON.parse(JSON.stringify(await p));
  };
  env.funcRuns = () => env.injected.filter((i) => i.args.length).length;
  return env;
};

check("inSitePage: no own tab opens the site muted in the background, waits until ready, runs func once; the user's tab untouched", async () => {
  const env = sitePage({ tabs: [{ id: 7, url: DEMO, active: true }] });
  assert.deepEqual(await env.run(), { ok: true, data: { status: 200 } });
  assert.deepEqual(env.created.map((t) => [t.url, t.active]), [[DEMO_HOME, false]]);
  assert.ok(env.injected.every((i) => i.tabId === env.created[0].id && i.world === "MAIN"));
  assert.equal(env.funcRuns(), 1);
  assert.equal(env.injected.length, 3, "ready asked again until the page answers");
});

check("inSitePage: an own tab on another site is navigated; one already on the site is used as it is", async () => {
  const own = (url) => ({ session: { agentBridgeTab: JSON.stringify({ tabId: 50, key: "bilibili:BV1:1", pageKey: null, staleUrl: null }) }, tabs: [{ id: 50, url }] });
  let env = sitePage(own("https://www.bilibili.com/video/BV1/"));
  assert.equal((await env.run()).ok, true);
  assert.deepEqual([env.created.length, env.updated], [0, [{ id: 50, url: DEMO_HOME }]]);
  env = sitePage(own("https://www.demo.test/v/9"));
  assert.equal((await env.run()).ok, true);
  assert.deepEqual([env.created.length, env.updated.length], [0, 0]);
});

check("inSitePage: func failing is not run again (it may be a write); no access is NO_ACCESS with nothing injected", async () => {
  const env = sitePage({ tabs: [], inject: () => { throw new Error("frame gone"); } });
  const r = await env.run();
  assert.equal(r.ok, false);
  assert.match(r.error, /frame gone/);
  assert.equal(env.funcRuns(), 1);
  const denied = sitePage({ granted: [] });
  assert.equal((await denied.run()).code, "NO_ACCESS");
  assert.deepEqual([denied.injected.length, denied.created.length], [0, 0]);
});

check("a page-read site's answer over 300,000 JSON characters is TOO_LARGE, asked once", async () => {
  const env = makeEnv({ enabled: true, commitNow: true, granted: ["https://www.demo.test/*"], inject: () => ({ title: "x".repeat(300_000) }) });
  demoSite(env);
  const s = await openSocket(env);
  const r = await call(env, s, "1", DEMO);
  assert.equal(r.code, "TOO_LARGE");
  assert.equal(r.ok, false);
  assert.equal(env.injected.length, 1);
});

check("a page-read site's read that never settles is TIMEOUT by the deadline, and the own tab leaves the page", async () => {
  const env = makeEnv({ enabled: true, commitNow: true, granted: ["https://www.demo.test/*"], inject: () => new Promise(() => {}) });
  demoSite(env);
  const s = await openSocket(env);
  const r = await call(env, s, "1", DEMO);
  assert.deepEqual([r.ok, r.code], [false, "TIMEOUT"]);
  assert.deepEqual(env.updated.at(-1), { id: env.created[0].id, url: "about:blank" });
  // The queue is free again: the next call runs.
  env.tabs[0].url = DEMO;
  assert.ok(await call(env, s, "2", DEMO), "the next call answers");
});

check("a page-read site's error: only THROTTLED passes as a code, the text stops at 500 characters", async () => {
  const env = makeEnv({ enabled: true, commitNow: true, granted: ["https://www.demo.test/*"], inject: () => ({ error: "x".repeat(600), code: "PERSONAL_DATA_OFF" }) });
  demoSite(env);
  const s = await openSocket(env);
  assert.deepEqual(await call(env, s, "1", DEMO), { id: "1", ok: false, error: "x".repeat(500) });
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n${e.stack}`); }
  }
  console.log(failed ? `${failed} failed` : `all ${cases.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
