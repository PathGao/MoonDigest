// MoonDigest's agent interface, docs/AGENT.md §2: the service worker's socket to the local MCP server (mcp/).
// Call MdgAgentBridge.start(...) synchronously at the top level of the service worker so the
// chrome.alarms listener is registered before Chrome delivers a wake-up alarm.
// Needs the "alarms", "storage", "tabs" and "scripting" permissions (storage.session: Chrome 102+) plus host access to
// each site's origins (agent-sites/): the manifest grants bilibili.com and youtube.com, the user allows the others.
(() => {
  const SERVER_URL = "ws://127.0.0.1:47823/";
  const ALARM = "agent-bridge";
  const FIRST_DELAY_MS = 5_000;
  const MAX_DELAY_MS = 60_000;
  const PAGE_WAIT_MS = 50_000;
  const CALL_BUDGET_MS = 55_000; // a call ends before the server's 60 s TIMEOUT, so the server gets its error
  const PAGE_RETRY_MS = 500;

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
  async function findUserTab(site, key) {
    const own = await loadOwn();
    const tabs = await chrome.tabs.query({ url: site.origins });
    // A discarded tab has no content script until it is shown again: never pick one.
    const hit = tabs.find((t) => (!own || t.id !== own.tabId) && !t.discarded && MdgAgentSites.keyOf(t.url || "") === key);
    return hit ? { tabId: hit.id, staleUrl: null } : null;
  }

  // Runs inside inOwnTab: returns the own tab showing (or loading) the video.
  async function ownTabFor(key, url) {
    let own = await loadOwn();
    const tab = own && (await chrome.tabs.get(own.tabId).catch(() => null));
    if (!tab) own = null; // never opened, or the user closed it
    const k = tab ? MdgAgentSites.keyOf(tab.url || "") : null;
    // Without a pageKey (no call answered there yet) the tab counts as this video's only while it is still loading it
    // (a redirect, such as /video/av… to /video/BV…): once loaded it may show anything the user went to.
    if (own && (k === key || (own.key === key && (own.pageKey ? k === own.pageKey : tab.status === "loading")))) return own;
    return openOwn(own && tab, key, url);
  }

  // Loads url in the own tab (tab, or a new one when null) and saves it.
  async function openOwn(tab, key, url) {
    let own;
    if (tab) {
      own = { tabId: tab.id, key, pageKey: null, staleUrl: tab.url || "" };
      await chrome.tabs.update(tab.id, { url });
    } else {
      const created = await chrome.tabs.create({ url, active: false });
      // Once shown for a frame its video may play on in the background: keep it silent.
      await chrome.tabs.update(created.id, { muted: true }).catch(() => {});
      own = { tabId: created.id, key, pageKey: null, staleUrl: null };
    }
    await saveOwn(own);
    return own;
  }

  // For adapters' collection calls (§5): runs func(...args) in the MAIN world of the own tab on any page of site, loading
  // url there when it shows another site, once ready() there returns { ok: true }. func runs once, never again on a
  // failure: it may be a write. Resolves to { ok, data: func's result } or { ok: false, error, code? }.
  function inSitePage(site, url, ready, func, args, deadline) {
    const run = (f, a) => async (tabId) => (await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: f, args: a }))[0]?.result;
    return inOwnTab(async () => {
      if (Date.now() > deadline) return { ok: false, code: "TIMEOUT", error: "The call waited too long behind earlier ones." };
      if (!(await chrome.permissions.contains({ origins: site.origins }))) {
        return { ok: false, code: "NO_ACCESS", error: `MoonDigest has no access to ${site.origins.join(", ")}: ask the user to allow it.` };
      }
      let own = await loadOwn();
      const tab = own && (await chrome.tabs.get(own.tabId).catch(() => null));
      const onSite = tab && (await chrome.tabs.query({ url: site.origins })).some((t) => t.id === tab.id);
      if (!onSite) own = await openOwn(tab, null, url);
      const target = { tabId: own.tabId, staleUrl: onSite ? null : own.staleUrl };
      const up = await callPage(target, "", null, deadline, run(ready, []));
      if (!up.ok) return up;
      try {
        return { ok: true, data: await run(func, args)(target.tabId) };
      } catch (e) {
        return { ok: false, error: `The ${site.id} tab did not run the call: ${e?.message || e}` };
      }
    });
  }

  // Retries until the tab's content script (or ask) answers; get and frame are safe to repeat.
  // After a navigation it does not ask until the tab's URL has left the previous page,
  // so the previous video's content script never answers.
  async function callPage(target, method, params, deadline, ask = (tabId) => chrome.tabs.sendMessage(tabId, { type: "agent-call", method, params })) {
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
        reply = await ask(target.tabId).catch(() => undefined);
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

  // A site whose adapter reads the page itself: read(url) runs in the page's own world (its globals in reach) and returns
  // §1's get data, or a falsy value while the page is not ready (callPage asks again).
  const readInPage = (site, url) => async (tabId) => {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: site.read, args: [url] });
    return r?.result ? { ok: true, data: { ...r.result, site: site.id } } : undefined;
  };

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
    const key = typeof url === "string" ? MdgAgentSites.keyOf(url) : null;
    if (!key) return { ok: false, code: "BAD_URL", error: `Not a page MoonDigest reads. Sites: ${MdgAgentSites.list().map((s) => s.id).join(", ")}.` };
    const site = MdgAgentSites.get(key.split(":")[0]);
    const { url: _drop, ...rest } = params;
    if (site.read === "content") {
      const user = await findUserTab(site, key);
      if (user) return callShown(user, method, rest, deadline);
    } else {
      // Only in the own tab: nothing runs in the user's tabs.
      if (method !== "get") return { ok: false, error: `${site.id} pages answer get only.` };
      if (!(await chrome.permissions.contains({ origins: site.origins }))) {
        return { ok: false, code: "NO_ACCESS", error: `MoonDigest has no access to ${site.origins.join(", ")}: ask the user to allow it.` };
      }
    }
    return inOwnTab(async () => {
      if (Date.now() > deadline) return { ok: false, code: "TIMEOUT", error: "The call waited too long behind earlier ones." };
      const own = await ownTabFor(key, url);
      const reply = site.read === "content" ? await callShown(own, method, rest, deadline) : await callPage(own, method, rest, deadline, readInPage(site, url));
      if (!own.pageKey && reply.ok) {
        const tab = await chrome.tabs.get(own.tabId).catch(() => null);
        own.pageKey = tab ? MdgAgentSites.keyOf(tab.url || "") : null;
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

  globalThis.MdgAgentBridge = { start, addMethods, inSitePage };
})();
