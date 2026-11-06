// MoonDigest's agent interface, docs/AGENT.md §2: the service worker's socket to the local MCP server (mcp/).
// Call MdgAgentBridge.start(...) synchronously at the top level of the service worker so the
// chrome.alarms listener is registered before Chrome delivers a wake-up alarm.
// Needs the "alarms", "storage" and "tabs" permissions (storage.session: Chrome 102+) plus host access to bilibili.com and youtube.com.
(() => {
  const SERVER_URL = "ws://127.0.0.1:47823/";
  const ALARM = "agent-bridge";
  const FIRST_DELAY_MS = 5_000;
  const MAX_DELAY_MS = 60_000;
  const PAGE_WAIT_MS = 50_000;
  const CALL_BUDGET_MS = 55_000; // a call ends before the server's 60 s TIMEOUT, so the server gets its error
  const PAGE_RETRY_MS = 500;

  // --- URLs --------------------------------------------------------------------

  // Returns "site:videoId:part" for a supported video page, else null.
  function videoKey(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.replace(/^www\./, "");
    const q = u.searchParams;
    if (host === "youtube.com") {
      const v = q.get("v");
      return u.pathname === "/watch" && v ? `youtube:${v}:` : null;
    }
    if (host === "bilibili.com") {
      let m = /^\/video\/((?:BV|bv)[0-9A-Za-z]+|av\d+)\/?$/.exec(u.pathname);
      if (m) return `bilibili:${m[1]}:${q.get("p") || "1"}`;
      m = /^\/bangumi\/play\/((?:ep|ss)\d+)\/?$/.exec(u.pathname);
      if (m) return `bilibili:${m[1]}:`;
      if (/^\/(list|festival)\/[^/]+/.test(u.pathname)) {
        // These pages play q.bvid; without it the page itself is the only identity.
        return `bilibili:${q.get("bvid") || u.pathname}:${q.get("p") || "1"}`;
      }
    }
    return null;
  }

  // --- tabs --------------------------------------------------------------------

  // The one tab this bridge opened: { tabId, key, pageKey, staleUrl }. pageKey is the key the
  // page showed once it answered (covers redirects such as /video/av… -> /video/BV…); staleUrl
  // is the previous page's URL while a navigation has not committed yet. It lives in
  // chrome.storage.session so a restarted service worker finds the same tab instead of opening another.
  const OWN_KEY = "agentBridgeTab";
  let ownQueue = Promise.resolve();

  async function loadOwn() {
    const got = await chrome.storage.session.get(OWN_KEY).catch(() => ({}));
    return got[OWN_KEY] || null;
  }

  function saveOwn(own) {
    return own ? chrome.storage.session.set({ [OWN_KEY]: own }) : chrome.storage.session.remove(OWN_KEY);
  }

  // Calls that need the own tab run one after another, so two videos never fight over it.
  function inOwnTab(fn) {
    const run = ownQueue.then(fn);
    ownQueue = run.catch(() => {});
    return run;
  }

  // A tab other than ours already showing the video: use it as is, never navigate it.
  async function findUserTab(key) {
    const own = await loadOwn();
    const tabs = await chrome.tabs.query({ url: ["*://*.bilibili.com/*", "*://*.youtube.com/*"] });
    // A discarded tab has no content script until it is shown again: never pick one.
    const hit = tabs.find((t) => (!own || t.id !== own.tabId) && !t.discarded && videoKey(t.url || "") === key);
    return hit ? { tabId: hit.id, staleUrl: null } : null;
  }

  // Runs inside inOwnTab: returns the own tab showing (or loading) the video.
  async function ownTabFor(key, url) {
    let own = await loadOwn();
    const tab = own && (await chrome.tabs.get(own.tabId).catch(() => null));
    if (!tab) own = null; // never opened, or the user closed it
    const k = tab ? videoKey(tab.url || "") : null;
    // Without a pageKey (no call answered there yet) the tab counts as this video's only while it is still loading it
    // (a redirect, such as /video/av… to /video/BV…): once loaded it may show anything the user went to.
    if (own && (k === key || (own.key === key && (own.pageKey ? k === own.pageKey : tab.status === "loading")))) return own;
    if (own) {
      own = { tabId: own.tabId, key, pageKey: null, staleUrl: tab.url || "" };
      await chrome.tabs.update(own.tabId, { url });
    } else {
      const created = await chrome.tabs.create({ url, active: false });
      // Once shown for a frame its video may play on in the background: keep it silent.
      await chrome.tabs.update(created.id, { muted: true }).catch(() => {});
      own = { tabId: created.id, key, pageKey: null, staleUrl: null };
    }
    await saveOwn(own);
    return own;
  }

  // Retries until the tab's content script answers; get and frame are safe to repeat.
  // After a navigation it does not ask until the tab's URL has left the previous page,
  // so the previous video's content script never answers.
  async function callPage(target, method, params, deadline) {
    const until = Math.min(Date.now() + PAGE_WAIT_MS, deadline);
    for (;;) {
      let reply;
      let ready = true;
      if (target.staleUrl != null) {
        const tab = await chrome.tabs.get(target.tabId).catch(() => null);
        if (!tab) return { ok: false, error: "The video tab was closed while it loaded." };
        if (tab.url === target.staleUrl) ready = false;
        else target.staleUrl = null;
      }
      if (ready) {
        reply = await chrome.tabs.sendMessage(target.tabId, { type: "agent-call", method, params }).catch(() => undefined);
        if (reply && typeof reply.ok === "boolean") return reply;
      }
      if (Date.now() > until) {
        return { ok: false, code: "TIMEOUT", error: "The video page did not load or its MoonDigest script did not answer." };
      }
      await new Promise((r) => setTimeout(r, PAGE_RETRY_MS));
    }
  }

  // Chrome loads no media in a tab that has never been shown, so a frame there fails with TAB_HIDDEN. Show the tab for
  // that one frame, then give its window back the tab that was in front. Once loaded, later frames need no switch.
  async function callShown(target, method, params, deadline) {
    const reply = await callPage(target, method, params, deadline);
    if (method !== "frame" || reply.code !== "TAB_HIDDEN") return reply;
    const tab = await chrome.tabs.get(target.tabId).catch(() => null);
    if (!tab) return reply;
    const [front] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    await chrome.tabs.update(tab.id, { active: true });
    try {
      return await callPage(target, method, params, deadline);
    } finally {
      // Give the front back only if ours is still in front: the user may have switched tabs meanwhile.
      const now = await chrome.tabs.get(tab.id).catch(() => null);
      if (front && front.id !== tab.id && now?.active) await chrome.tabs.update(front.id, { active: true }).catch(() => {});
    }
  }

  // deadline: when the server stops waiting for this call (its 60 s TIMEOUT). A call still queued then is dropped, so
  // nothing loads a video or asks the site for a call nobody waits for any more.
  // Methods other files add (agent-mydata.js): each takes params and the deadline and resolves to a reply, without a tab.
  const added = {};
  const addMethods = (methods) => Object.assign(added, methods);

  async function handle(method, params, deadline = Date.now() + CALL_BUDGET_MS) {
    if (method === "search") return MdgAgentSearch.search(params, deadline); // agent-search.js, no tab
    if (Object.hasOwn(added, method)) return added[method](params, deadline);
    if (method !== "get" && method !== "frame") return { ok: false, error: `Unknown method ${method}.` };
    const url = params && params.url;
    const key = typeof url === "string" ? videoKey(url) : null;
    if (!key) return { ok: false, code: "BAD_URL", error: "Not a supported page: use a Bilibili video page or a YouTube watch page." };
    const { url: _drop, ...rest } = params;
    const user = await findUserTab(key);
    if (user) return callShown(user, method, rest, deadline);
    return inOwnTab(async () => {
      if (Date.now() > deadline) return { ok: false, code: "TIMEOUT", error: "The call waited too long behind earlier ones." };
      const own = await ownTabFor(key, url);
      const reply = await callShown(own, method, rest, deadline);
      if (!own.pageKey && reply.ok) {
        const tab = await chrome.tabs.get(own.tabId).catch(() => null);
        own.pageKey = tab ? videoKey(tab.url || "") : null;
      }
      await saveOwn(own);
      return reply;
    });
  }

  // --- socket ------------------------------------------------------------------

  let started = false;
  let opts = null;
  let enabled = false;
  let ws = null;
  let timer = 0;
  let delay = FIRST_DELAY_MS;
  let lastStatus = "";

  function setStatus(s) {
    if (s === lastStatus) return;
    lastStatus = s;
    chrome.storage.local.set({ mcpStatus: s });
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function connect() {
    clearTimeout(timer);
    timer = 0;
    if (!enabled || ws) return;
    const sock = new WebSocket(SERVER_URL);
    ws = sock;
    sock.onopen = () => {
      delay = FIRST_DELAY_MS;
      setStatus("connected");
      send({ type: "hello", version: 1, extensionVersion: opts.extensionVersion });
    };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "ping") { send({ type: "pong" }); return; }
      if (msg.id == null || !msg.method) return;
      handle(msg.method, msg.params || {}, Date.now() + CALL_BUDGET_MS)
        .catch((err) => ({ ok: false, error: String((err && err.message) || err) }))
        .then((r) => {
          if (sock !== ws) return;
          send(r.ok ? { id: msg.id, ok: true, data: r.data } : { id: msg.id, ok: false, error: r.error, ...(r.code ? { code: r.code } : {}) });
        });
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (!enabled) return;
      setStatus("disconnected");
      // ponytail: setTimeout dies with the service worker; the 1-minute alarm reconnects after that.
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    };
  }

  function apply(on) {
    on = !!on;
    if (on === enabled && lastStatus) return;
    enabled = on;
    if (on) {
      chrome.alarms.create(ALARM, { periodInMinutes: 1 });
      if (!ws) setStatus("disconnected");
      connect();
    } else {
      chrome.alarms.clear(ALARM);
      clearTimeout(timer);
      timer = 0;
      delay = FIRST_DELAY_MS;
      const sock = ws;
      ws = null;
      if (sock) sock.close();
      setStatus("off");
    }
  }

  function start(o) {
    if (started) return;
    started = true;
    opts = o;
    chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM && enabled && !ws) connect(); });
    o.onEnabledChange((on) => apply(on));
    Promise.resolve(o.isEnabled()).then(apply, () => apply(false));
  }

  globalThis.MdgAgentBridge = { start, addMethods };
})();
