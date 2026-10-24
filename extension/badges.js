// Read-only triage marks on Bilibili pages. Videos without triage data get zero DOM changes.
(() => {
  const { VERDICTS, verdictOf, INVALID } = globalThis.MdgTagCore;
  const { TEXT, LABEL, upTagTitle } = MdgErrors;
  const K = MdgLimits.KEYS;
  const ACTION = { keep: LABEL.kept, unfav: LABEL.unfaved };
  const STAGE = [INVALID, LABEL.coarseRead, LABEL.fineRead];
  const BVID_RE = /(?:\/video\/|[?&]bvid=)(BV[0-9A-Za-z]{10})/;

  function bvidFromHref(href) {
    return BVID_RE.exec(String(href || ""))?.[1] || "";
  }

  // The verdict is MdgTagCore.verdictOf, as on the triage page; invalid: the folder's snapshot lists the video as 已失效.
  // folder: the 收藏夹 the page shows (its fid), whose tags alone are shown, as the 分拣台 shows the open folder's; without
  // one, tags of the same name (one per folder) show once, as on 摘读记录.
  function badgeInfo({ title, analysis, invalid, tagIds, tags, decision, folder = "" } = {}) {
    const done = analysis?.status === "done";
    const found = verdictOf({ title, analysis, invalid });
    const v = found.verdict === "none" ? null : found;
    const name = v && VERDICTS[v.verdict];
    const byId = new Map((Array.isArray(tags) ? tags : []).map((t) => [t.id, t]));
    const userTags = (Array.isArray(tagIds) ? tagIds : [])
      .map((id) => byId.get(id))
      .filter((t) => t && (!folder || String(t.folder) === String(folder)))
      .filter((t, i, all) => all.findIndex((x) => x.name === t.name) === i)
      .map((t) => ({ name: String(t.name || ""), color: String(t.color || "") }));
    const action = ACTION[decision?.action] ? decision.action : "";
    if (!v && !userTags.length && !action) return null;

    // AI classes carry an 「AI」 marker; the user's own decision and an invalid video the AI never judged (stage 0) never do.
    const label = action ? ACTION[action] : v ? (v.stage === 0 ? LABEL.invalid : `AI ${name}`) : "";
    const info = {
      label,
      verdict: v ? v.verdict : "",
      stage: v?.stage || 0,
      low: Boolean(v?.low),
      action,
      reason: String(v?.reason || ""),
      oneLiner: done ? String(analysis.oneLiner || "") : "",
      points: done ? (analysis.points || []).map(String).filter(Boolean) : [],
      tags: userTags
    };
    return info;
  }
  // What a mark reads aloud: the decision and the verdict it shows, and the tags it shows.
  const ariaOf = ({ action, verdict, stage, low }, tags) =>
    [
      "MoonDigest 分拣",
      action && ACTION[action],
      verdict && (stage === 0 ? LABEL.invalid : `${LABEL.aiVerdict} ${VERDICTS[verdict]}（${STAGE[stage]}${low ? "，低置信" : ""}）`),
      tags.length && `视频标签：${tags.map((t) => t.name).join("、")}`
    ]
      .filter(Boolean)
      .join("，");

  // Merges triage_kept (保留, one list for all folders) and every triage_decisions_<folder> (取消收藏) in `got`. As on
  // the 分拣台, a folder's 取消收藏 wins over 保留; a video taken out of several folders shows the latest. Off a
  // favorites page (folderPage false) the latest 取消收藏 shows only when it left no other chosen folder (no elsewhere).
  function mergeDecisions(got, folderPage = false) {
    const unfav = {};
    for (const [k, v] of Object.entries(got || {})) {
      if (!k.startsWith(K.triageDecisionsPrefix)) continue;
      for (const [b, d] of Object.entries(v || {})) if (!unfav[b] || (d?.at || 0) > (unfav[b].at || 0)) unfav[b] = d;
    }
    if (!folderPage) for (const [b, d] of Object.entries(unfav)) if (d?.elsewhere) delete unfav[b];
    return { ...got?.[K.triageKept], ...unfav };
  }

  // ---- UP tags (follow_tags / follow_tag_map from the triage page's 关注 mode) next to an author's name ----
  // Only a bare profile link names an author: /favlist, /video, /fans/follow are menu links. The header's 动态 popover
  // names its authors with /dynamic links.
  const MID_RE = /(?:^|\/\/)space\.bilibili\.com\/(\d+)(?:\/dynamic)?\/?(?:[?#]|$)/;
  const midFromHref = (href) => MID_RE.exec(String(href || ""))?.[1] || "";

  // [{ id, name, color }] of a mid, in follow_tags order.
  function upTagsOf(mid, tags, map) {
    const ids = new Set((mid && map?.[mid]) || []);
    return ids.size ? (Array.isArray(tags) ? tags : []).filter((t) => ids.has(t.id)) : [];
  }

  // First text node with visible characters under `el`, depth first. Plain childNodes so the selftest needs no real DOM.
  function firstText(el) {
    for (const n of el.childNodes || []) {
      if (n.nodeType === 3 && n.data.trim()) return n;
      if (n.nodeType === 1 && !/^(svg|style|script|i)$/i.test(n.tagName)) {
        const t = firstText(n);
        if (t) return t;
      }
    }
    return null;
  }
  // Cards that put a 直播中 badge or an icon before the name mark the name itself; measured on home, search, video and space.
  const NAMED = /(?:^|\s)(?:bili-video-card__info--author|name)(?:\s|$)/;
  function namedEl(el) {
    for (const n of el.childNodes || []) {
      // Our own box carries a title too; skipping it keeps a rescan from taking the box for the name.
      if (n.nodeType !== 1 || n.classList?.contains("mdg-ups")) continue;
      if (NAMED.test(n.className?.baseVal ?? n.className ?? "") || n.getAttribute?.("title")) return n;
      const d = namedEl(n);
      if (d) return d;
    }
    return null;
  }
  // The node a link's chip goes right after: the element that holds the name, or the bare name text. Null for avatars.
  function spotIn(a) {
    // The video page owner's name link cuts its own overflow off (ellipsis); the chip goes after the link there.
    if (/(?:^|\s)up-name(?:\s|$)/.test(a.className || "")) return firstText(a) ? a : null;
    const named = namedEl(a);
    if (named && firstText(named)) return named;
    const t = firstText(a);
    if (!t) return null;
    return t.parentNode === a ? t : t.parentNode;
  }

  // 动态 page filter: per tag, how many of the loaded cards (by author mid) it covers; "" is 全部.
  function upCounts(mids, tags, map) {
    const out = { "": mids.length };
    for (const t of tags || []) out[t.id] = 0;
    for (const mid of mids) for (const t of upTagsOf(mid, tags, map)) out[t.id]++;
    return out;
  }
  const upHidden = (mid, tagId, map) => Boolean(tagId) && !(map?.[mid] || []).includes(tagId);

  // ---- Which UP a name belongs to, for writing tags: a link or data attribute names the UP outright; a 动态 card only
  // has the avatar image and the name, each trusted only when exactly one followed UP has it. ----
  // The file name only: B站's default avatar (/bfs/face/member/noface.jpg) is everyone's, so it is no key.
  const FACE_RE = /\/bfs\/face\/([^/@?#]+)(?:$|[@?#])/;
  const faceKey = (url) => {
    const key = FACE_RE.exec(String(url || ""))?.[1].toLowerCase() || "";
    return key.startsWith("noface.") ? "" : key;
  };
  // name -> mid and avatar file -> mid over `mids`; a key two UPs share maps to "" so it is never guessed.
  function whoIndex(people, mids) {
    const byName = new Map();
    const byFace = new Map();
    const put = (m, k, mid) => k && m.set(k, m.has(k) && m.get(k) !== mid ? "" : mid);
    for (const mid of mids || []) {
      const p = people?.[mid];
      if (!p) continue;
      put(byName, String(p.name || "").trim(), String(mid));
      put(byFace, faceKey(p.face), String(mid));
    }
    return { byName, byFace };
  }
  function resolveMid({ href, data, face, name } = {}, idx) {
    const id = midFromHref(href) || (/^\d+$/.test(String(data || "")) ? String(data) : "");
    if (id || !idx) return id;
    return idx.byFace.get(faceKey(face)) || idx.byName.get(String(name || "").trim()) || "";
  }

  // ---- The 「+」 picker's data: same tag shape, colors and name rules as the triage page's 关注 mode (tag-core.js). ----
  const { applyUpTag, upTagsFull } = globalThis.MdgTagCore;
  const pickRows = (mid, tags, map) => {
    const on = new Set(map?.[mid] || []);
    return (Array.isArray(tags) ? tags : []).map((t) => ({ id: t.id, name: String(t.name || ""), color: String(t.color || ""), on: on.has(t.id) }));
  };
  // One change to one UP (MdgTagCore.applyUpTag), written by the background: this page is another origin than the
  // 分拣台, so the Web Lock both of them write follow_* under (MdgLimits.updateFollow) is the background's to take.
  // Resolves { tags, map, id }, { why } or null.
  async function saveUpTag(mid, op) {
    const r = await chrome.runtime.sendMessage({ type: "follow-up-tag", mid, op });
    return r?.ok ? r.data : null;
  }

  // What each kind of B站 page shows: bili-surfaces.js, loaded first (manifest).
  const { SURFACES } = globalThis.MdgSurfaces;
  function surfaceOf({ host = "", path = "", search = "" } = {}) {
    const page = new URLSearchParams(search).get("page") || ""; // BewlyCat's pages
    if (page === "Favorites" || (host === "space.bilibili.com" && /^\/\d+\/favlist/.test(path))) return "fav";
    if (page === "History" || /^\/(?:history|account\/history)(?:\/|$)/.test(path)) return "history";
    if (page === "WatchLater" || /^\/watchlater(?:\/|$)/.test(path)) return "later";
    if (host === "t.bilibili.com" || page === "Moments") return "feed";
    if (host === "space.bilibili.com") return "space";
    if (/^\/(?:video|list)\//.test(path)) return "video";
    return "card";
  }

  // How many of a group's chips fit in `room` px: all, or as many whole ones as leave room for 「+N」; -1 when not even
  // 「+N」 fits, so the group hides instead of leaving an empty marker. `fixed` always shows (AI verdict, 「+ UP 标签」).
  function fitCount(widths, room, { gap = 0, fixed = [], more = 0 } = {}) {
    const span = (ws) => ws.reduce((s, w) => s + w, 0) + gap * Math.max(ws.length - 1, 0);
    if (span([...fixed, ...widths]) <= room) return widths.length;
    for (let k = widths.length - 1; k >= 0; k--) if (span([...fixed, ...widths.slice(0, k), more]) <= room) return k;
    return -1;
  }

  // What a video's mark shows under `on` (a surface's rule, or the two switches for the video page's line under the
  // title): the AI's verdict and its one-liner, your tags. Null when neither has anything to say.
  function lineParts(info, { verdict, vtags }) {
    const tags = vtags ? info.tags : [];
    const label = verdict ? info.label : "";
    if (!label && !tags.length) return null;
    const aria = ariaOf(label ? info : {}, tags);
    return { info: { ...info, label, aria }, tags, text: verdict ? info.oneLiner || info.reason : "" };
  }

  // B站's own 稍后再看 / 历史 cards say 已看完 on the cover; ours would say it twice.
  const biliSaysSeen = (a) => [...a.querySelectorAll(".bili-cover-card__stat")].some((n) => n.textContent.trim() === "已看完");

  globalThis.MdgBadges = {
    bvidFromHref, badgeInfo, mergeDecisions, midFromHref, upTagsOf, spotIn, upCounts, upHidden,
    faceKey, whoIndex, resolveMid, pickRows, saveUpTag, surfaceOf, fitCount, biliSaysSeen, lineParts
  };
  if (typeof chrome === "undefined" || !chrome.storage?.local || typeof document === "undefined") return;
  // The 分拣台's player (viewer-frame.js): a video gets only the line under its title, its AI 判断 as the switch says and
  // no 视频标签 (the line above the player has them); an UP's space gets nothing.
  // viewer-frame.js sets it at document_start, before this script runs (it comes first in the manifest).
  const viewer = document.documentElement.getAttribute?.("data-mdg-viewer");
  if (viewer === "space") return;
  const lineOnly = viewer != null;
  const surfaceNow = () => surfaceOf({ host: location.hostname, path: location.pathname, search: location.search });
  // Recomputed on in-page navigation (followNav).
  let surface = surfaceNow();
  // Header popovers draw the same video links in miniature: B站's own (.v-popover) and BewlyCat's (.bew-popover).
  const POPOVER = ".bew-popover, .v-popover";
  const POPFEED = ".dynamic-entry .v-popover, .moments-pop";
  // SURFACES with the cells the settings page's table turned off.
  let rules = globalThis.MdgSurfaces.rulesWith([]);
  const ruleFor = (el) => (el.closest?.(POPFEED) ? rules.popfeed : el.closest?.(POPOVER) ? rules.popover : rules[surface]);

  const SETTING = "showBiliTriageBadges";
  const UP_SETTING = "showBiliUpTags";
  // Off by default: the AI's verdicts are for the 分拣台; on B站 pages only for those who ask.
  const VERDICT_SETTING = "showBiliVerdicts";
  // 观看进度 on covers has its own setting (设置页「观看进度」, off by default); it or the triage marks turn the page scan on.
  const { SEEN_DEFAULTS, seenConfig, seenWords } = globalThis.MdgSurfaces;
  let triageOn = false;
  let lineOn = { verdict: false, vtags: true }; // the video page's line: the AI 判断 and 视频标签 switches
  let seenCfg = seenConfig(SEEN_DEFAULTS);
  const seenCache = new Map(); // bvid -> percent | 0
  const SEL = 'a[href*="/video/BV"], a[href*="bvid=BV"]';
  // Covers that take 观看进度: the links, and the video page's playlist (/list/watchlater, /list/ml…), whose items are
  // divs carrying the bvid in data-key.
  const COVERS = `${SEL}, .action-list-item-wrap[data-key^="BV"]`;
  const bvidOf = (el) => bvidFromHref(el.getAttribute("href")) || el.dataset.key || "";
  // Keys that every video's info depends on; a per-video title or analysis only redraws that video. Only a favorites
  // page reads a snapshot, and only its own folder's: the 分拣台 saves other folders' snapshots often.
  const isSharedKey = (k) => k === K.triageTags || k === K.triageVideoTags || k === K.triageKept || k.startsWith(K.triageDecisionsPrefix) || (!!favFid() && k === K.triageSnapshot(favFid()));

  const cache = new Map(); // bvid -> info | null
  let shared = null;
  let sharedFid = null;
  // Every key in chrome.storage.local (getKeys, Chrome 130+), kept current from onChanged: a video with no key of its
  // own needs no read, so most cards are marked (or left alone) from memory. Null: unknown, so read.
  let keys = null;
  const keyLoads = MdgCommon.latest(); // ended on every local change, so a getKeys answer that raced one is dropped
  let enabled = false;
  let timer = 0;
  let pop = null;
  const scans = MdgCommon.latest(); // ended when triage data or the page changes, so an in-flight scan drops its stale reads
  let superseded = false; // a fresh copy took over (standDown)
  const observer = new MutationObserver((records) => onMutations(records));
  const OBSERVE = { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "data-key", "data-server-rendered", "data-mdg-ssr"] };

  // BewlyCat draws its own pages (首页, 收藏, 稍后再看…) inside #bewly's open shadow root. Only that root is searched:
  // Bilibili's comment section is nested shadow roots too, and its video links should stay unmarked.
  const bewlyRoot = () => document.getElementById("bewly")?.shadowRoot || null;
  // Server-rendered markup Vue has yet to hydrate: #app's data-server-rendered on the Vue 2 pages (video, /list/),
  // <html>'s data-mdg-ssr on the Vue 3 ones (home, search; hydration.js). Nothing in it is marked until the attribute
  // goes, in one step, a mutation that looks at all it covered (#394). Vue 2 meeting one node of ours in #app gives up
  // hydrating and draws all of #app anew, the player with it; Vue 3 reports a mismatch and takes our marks out.
  const SSR = "[data-server-rendered], [data-mdg-ssr]";
  const findAll = (sel) => {
    if (lineOnly) return [];
    const r = bewlyRoot();
    const list = [...document.querySelectorAll(sel)];
    return r ? list.concat([...r.querySelectorAll(sel)]) : list;
  };
  // Applied when a scan looks and again right before it writes: the attribute can come while the scan waits for its
  // reads, and the mutation of its going looks at all it covered again. at: the node of an entry (a text node for some
  // UP chips' spots).
  const hydrated = (list, at = (n) => n) => {
    if (!document.querySelector(SSR)) return list;
    return list.filter((x) => {
      const n = at(x);
      return !(n.nodeType === 1 ? n : n.parentElement)?.closest(SSR);
    });
  };
  // What a run looks at: the queued nodes (each one, what it holds and the match it sits in), or null for the whole page.
  const scanned = (scope, sel) => {
    if (!scope || lineOnly) return hydrated(findAll(sel));
    const out = new Set();
    for (const r of scope) {
      const up = r.closest(sel);
      if (up) out.add(up);
      for (const n of r.querySelectorAll(sel)) out.add(n);
    }
    return hydrated([...out]);
  };
  let bewlyHooked = null;
  // Page CSS doesn't reach into a shadow root, so it gets its own copy of badges.css. True when newly hooked: what
  // the root already holds was never queued.
  function hookBewly() {
    const r = bewlyRoot();
    if (!r || r === bewlyHooked) return false;
    bewlyHooked = r;
    markBewly();
    observer.observe(r, OBSERVE);
    if (!r.querySelector("link[data-mdg]")) {
      const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: chrome.runtime.getURL("badges.css") });
      link.dataset.mdg = "";
      r.append(link);
    }
    return true;
  }

  // badges.css hides BewlyCat's own watch progress while ours is on.
  const SEEN_ATTR = "data-mdg-seen";
  const markBewly = () => document.getElementById("bewly")?.toggleAttribute(SEEN_ATTR, seenCfg.on);

  const favFid = () => (surface === "fav" ? new URLSearchParams(location.search).get("fid") || "" : "");
  // The video a player page shows: /video/BV… or, on the 稍后再看 / 收藏夹 player (/list/…), ?bvid= (surfaceOf's "video").
  // /list/ml… opens without ?bvid=, which B站 adds as Vue hydrates #app: until then the title's own link names it, so
  // hydration adding it is no page change.
  const pageBvid = () =>
    /^\/(?:video|list)\//.test(location.pathname)
      ? bvidFromHref(location.pathname + location.search) || bvidFromHref(document.querySelector(".video-info-title a[href]")?.getAttribute("href"))
      : "";
  // In-page navigation (a space page's tabs, BewlyCat's ?page=, the 稍后再看 player's next video) changes the page without
  // a reload, and its DOM changes schedule a run. Marks drawn under the old page's rules, folder or video go, a scan
  // still reading for it stops, and the run redraws under the new ones.
  let shownFor = `${surface}|${favFid()}|${pageBvid()}`;
  // True when the page changed: the run then covers the whole page.
  function followNav() {
    surface = surfaceNow();
    const now = `${surface}|${favFid()}|${pageBvid()}`;
    if (now === shownFor) return false;
    shownFor = now;
    scans.next();
    clearMarks();
    clearUps();
    return true;
  }

  // ---- When to look: the nodes a page change added are marked in the MutationObserver callback itself, which runs
  // before the browser paints, from what is already in memory; a mark B站 takes out with its own re-render is back in
  // the same callback. Server-rendered markup is the exception: it waits for hydration (SSR). The whole page is looked
  // at, in the next animation frame, at start, after in-page navigation, when the tab comes back into view and when
  // more than MAX nodes piled up in one callback (the parser at document_start); data changes do it too, throttled
  // (schedule). ----
  // The player's own nodes (danmaku, progress, subtitles) change every frame and hold nothing that is marked.
  // ponytail: a video link B站 adds inside the player is marked only by a whole-page look; watch its mutations if the
  // player starts holding marked links.
  const QUIET = "#bilibili-player, .bpx-player-container";
  const MAX = 100;
  const pending = new Set();
  let full = false;
  let frame = 0;
  const ours = (n) => n.nodeType === 1 && /(?:^|\s)mdg-/.test(n.className?.baseVal ?? n.className ?? "");
  const overlay = (n) => n.nodeType === 1 && Boolean(n.matches?.(".mdg-pop, .mdg-tagpick-host"));
  function want(n) {
    if (full) return;
    if (pending.size >= MAX) {
      pending.clear();
      full = true;
    } else pending.add(n);
  }
  // A hidden tab runs no frames: keep no detached nodes around, look at the whole page once it shows (onVisible).
  function whenShown() {
    pending.clear();
    full = true;
  }
  function onMutations(records) {
    if (document.hidden) return whenShown();
    for (const r of records) {
      const t = r.target;
      if ((t.nodeType === 1 ? t : t.parentElement)?.closest?.(QUIET)) continue;
      if (r.type === "attributes") {
        want(t);
        continue;
      }
      const added = [...r.addedNodes];
      const removed = [...r.removedNodes];
      // Our pop and tag picker coming and going (hover, 「+」): nothing on the page changed.
      if ([...added, ...removed].every(overlay)) continue;
      // Our own marks added: nothing new. A mark removed may be B站's doing, so its parent is looked at again (after
      // our own removals that finds nothing to write).
      if (!removed.length && added.every(ours)) continue;
      for (const n of added) if (n.nodeType === 1 && !ours(n)) want(n);
      // New text in an existing node, or a mark of ours taken out by the page: the parent is looked at again.
      if (t.nodeType === 1 && (added.some((n) => n.nodeType !== 1) || removed.some(ours))) want(t);
    }
    if (full) soon();
    else if (pending.size && enabled) {
      const roots = [...pending].filter((n) => n.isConnected);
      pending.clear();
      run(roots).catch(() => {});
    }
  }
  const onVisible = () => !document.hidden && (full || pending.size) && soon();
  // An extension disabled or removed injects no fresh copy (standDown): this one stops on its own.
  function soon() {
    if (!enabled || frame) return;
    if (!chrome.runtime?.id) return standDown();
    frame = requestAnimationFrame(flush);
  }
  function flush() {
    frame = 0;
    if (!enabled) return;
    if (document.hidden) return whenShown();
    const roots = full ? null : [...pending].filter((n) => n.isConnected);
    pending.clear();
    full = false;
    run(roots).catch(() => {});
  }
  // A whole-page look for data and setting changes, at most every 400ms: the 分拣台 writes results in bursts.
  function schedule() {
    if (!enabled || timer) return;
    timer = setTimeout(() => {
      timer = 0;
      rescan();
    }, 400);
  }
  const rescan = () => {
    full = true;
    soon();
  };

  // Marks `roots` (null: the whole page). Without a storage read to wait for, it runs to the end synchronously.
  // Runs may overlap (one waits for a read while the next callback marks new nodes from memory): each one reads the
  // DOM and writes it in one synchronous step, and every write checks what is already there.
  async function run(roots = null) {
    const nav = followNav();
    const scan = scans.current;
    const hooked = hookBewly();
    const scope = nav || hooked ? null : roots;
    // The line under the title first, from memory: it never waits for the cards' or the UP names' reads.
    const here = pageBvid();
    if (triageOn && cache.has(here)) markVideoLine(here);
    if (upOn) await markUps(scan, scope);
    if (triageOn || seenCfg.on) await markVideos(scan, scope);
    fitBoxes(findAll(".mdg-badge, .mdg-ups").filter((b) => !b.dataset.fit));
  }

  // ---- UP tags: chips after author names, the 「+」 tag picker, and the tag filter bar on the 动态 page ----
  const UP_SEL = 'a[href*="space.bilibili.com/"]';
  // 动态 cards name the author without a profile link; the avatar file or the name is matched against follow_people.
  const NAME_SEL = ".bili-dyn-title__text, .dyn-orig-author__name";
  // A space page's own nickname; its mid is in the URL.
  const OWNER_SEL = ".upinfo .nickname, .upinfo-detail__top .nickname, #h-name";
  const FILTER_KEY = "mdg-up-filter";
  let upOn = false;
  let upHas = false;
  let upSetting = true;
  let up = { tags: [], map: {}, followed: new Set() };
  let who = null; // whoIndex over followed UPs, read from follow_people on first need
  const pageOwner = () => (location.hostname === "space.bilibili.com" ? /^\/(\d+)/.exec(location.pathname)?.[1] || "" : "");
  const onFeed = () => location.hostname === "t.bilibili.com" && window === window.top;
  const readFilter = () => {
    try {
      return sessionStorage.getItem(FILTER_KEY) || "";
    } catch {
      return "";
    }
  };

  async function whoIs() {
    if (who) return who;
    const people = (await MdgLimits.followGet(["people"])).people || {};
    return (who = whoIndex(people, up.followed.size ? [...up.followed] : Object.keys(up.map)));
  }

  // A 动态 card's author: a data attribute up to the card, else its avatar file, else its name (each only when unique).
  // Worked out again only for a new name element, a new name in it or new follow data (idx): every pass asks for every
  // loaded card (feedFilter counts the whole list), and infinite scroll keeps adding cards.
  // ponytail: keyed by the name's text; a card B站 reuses for a same-named UP keeps the first one's mid.
  let mids = new WeakMap();
  let midsOf = null;
  function nameMid(el, idx) {
    if (midsOf !== idx) [mids, midsOf] = [new WeakMap(), idx];
    const hit = mids.get(el);
    if (hit?.name === el.textContent) return hit.mid;
    const mid = findMid(el, idx);
    mids.set(el, { name: el.textContent, mid });
    return mid;
  }
  function findMid(el, idx) {
    const card = el.closest(".dyn-orig-author, .bili-dyn-item, .bili-dyn-list__item");
    let data = "";
    for (let n = el; n?.nodeType === 1 && !data; n = n === card ? null : n.parentNode) data = n.getAttribute("data-mid") || n.getAttribute("data-uid") || "";
    const face = card?.querySelector('img[src*="/bfs/face/"]')?.getAttribute("src");
    return resolveMid({ data, face, name: el.textContent }, idx);
  }

  // Links to a space that are not an UP's name where the marks go (DESIGN 产品决策 · B站 页面上的标记): the /list/
  // player's 「UP主的全部视频」 above the playlist (the UP line under the name has the tags), the 字幕作者 under a
  // video's description and the page footer's links.
  const NOT_NAMES = ".action-list-body-top, .subtitle-maker-list, .bili-footer";

  async function markUps(scan, scope) {
    const owner = pageOwner();
    const spots = [];
    for (const a of scanned(scope, UP_SEL)) {
      if (a.closest(NOT_NAMES)) continue;
      const mid = midFromHref(a.getAttribute("href"));
      // On a space page the owner's own links (its video cards) would all say the same thing; the nickname carries it.
      const spot = mid && mid !== owner ? spotIn(a) : null;
      if (!spot) continue;
      // The video page's UP name: its tags get their own line under the name row.
      const row = a.classList.contains("up-name") && a.closest(".up-detail-top");
      spots.push(row ? [row, mid, rules.owner, spot.textContent] : [spot, mid, ruleFor(a)]);
    }
    // The nickname only on the space's own pages: its 收藏夹 page shows no UP tags.
    if (owner) for (const el of scanned(scope, OWNER_SEL)) spots.push([el, owner, surface === "space" ? rules.nick : rules.fav]);
    const nameEls = scanned(scope, NAME_SEL);
    // The 动态 page reads follow_people up front, so the cards it loads later are matched in the frame they appear.
    const idx = nameEls.length || surface === "feed" ? who || (await whoIs()) : null;
    if (!enabled || !upOn || !scan.alive) return; // stood down, the marks or the UP tags switched off, or the page changed, while reading
    for (const el of nameEls) spots.push([el, nameMid(el, idx), ruleFor(el)]);
    const writes = hydrated(spots, ([spot]) => spot).map(([spot, mid, rule, name]) => upChip(spot, mid, rule, name));
    if (onFeed()) writes.push(...feedFilter(idx));
    for (const w of writes) w?.();
  }

  // Keeps, replaces or removes the box right after `spot`; the DOM itself is the state, so a rerun changes nothing.
  // Where the page shows 「+ UP 标签」, only a followed UP gets it: an unfollowed one shows its old tags only (as in
  // 分拣台). On cards CSS shows it on hover only.
  function upChip(spot, mid, rule, name) {
    const list = rule.ups ? upTagsOf(mid, up.tags, up.map) : [];
    const plus = rule.ups && rule.plus && up.followed.has(mid) ? rule.plus : "";
    const next = spot.nextSibling;
    const old = next?.nodeType === 1 && next.classList.contains("mdg-ups") ? next : null;
    const key = list.length || plus ? `${mid}|${plus}|${list.map((t) => `${t.id}:${t.name}:${t.color}`).join(",")}` : "";
    if ((old?.dataset.key || "") === key) return;
    return () => {
      old?.remove();
      if (key) spot.after(upChipEl(spot, mid, list, key, plus, String(name ?? spot.textContent ?? "").trim()));
    };
  }

  const LOCAL_ONLY = TEXT.localOnly;
  const UP_TIP = `UP 标签 · ${LOCAL_ONLY}`;
  // Every tag as a chip, then a 「+N」 that fitBoxes shows when they don't all fit; hovering or focusing it lists them all.
  function appendChips(box, list, cls) {
    for (const t of list) {
      const c = document.createElement("span");
      c.className = `${cls} mdg-fit`;
      if (t.color) c.style.setProperty("--mdg-c", t.color);
      c.textContent = t.name;
      box.append(c);
    }
    if (!list.length) return;
    const more = document.createElement("span");
    more.className = "mdg-more mdg-off";
    more.tabIndex = 0;
    more.dataset.names = list.map((t) => t.name).join("、");
    more.dataset.head = cls === "mdg-up" ? "全部 UP 标签" : "全部视频标签";
    more.setAttribute("aria-label", `${more.dataset.head}：${more.dataset.names}`);
    more.textContent = `+${list.length}`;
    box.append(more);
  }

  function upChipEl(spot, mid, list, key, plus, name) {
    const box = document.createElement("span");
    box.className = `mdg-ups${list.length ? "" : " mdg-ups-empty"}${plus ? ` mdg-plus-${plus}` : ""}${spot.classList?.contains("up-detail-top") ? " mdg-ups-line" : ""}`;
    box.dataset.mid = mid;
    box.dataset.key = key;
    box.title = UP_TIP;
    appendChips(box, list, "mdg-up");
    if (plus) {
      const add = document.createElement("span");
      add.className = "mdg-up-add";
      add.dataset.name = name;
      add.setAttribute("role", "button");
      add.tabIndex = 0;
      add.setAttribute("aria-haspopup", "dialog");
      // A box rebuilt while its picker is open (a tag was just toggled) hands the picker its new 「+ UP 标签」.
      const open = pick?.spot === spot;
      if (open) pick.add = add;
      add.setAttribute("aria-expanded", String(open));
      add.setAttribute("aria-label", upTagTitle(name));
      add.title = `打 UP 标签 · ${LOCAL_ONLY}`;
      add.textContent = "+ UP 标签";
      box.append(add);
    }
    return box;
  }

  // The 全部 / per-tag bar above the 动态 list. A pick only adds a class to other UPs' cards, so Bilibili's own tabs,
  // its UP avatar strip and infinite scroll keep working, and newly loaded cards are filtered in the frame they are added in.
  function feedFilter(idx) {
    // The bar filters by UP tags: with 动态页's UP tags off in the settings table, it goes too and every card shows.
    if (!rules.feed.ups) {
      const hidden = document.querySelectorAll(".mdg-up-hide");
      const bar = document.querySelector(".mdg-upbar");
      return bar || hidden.length ? [() => (bar?.remove(), hidden.forEach((n) => n.classList.remove("mdg-up-hide")))] : [];
    }
    const list = document.querySelector(".bili-dyn-list");
    if (!list) return [];
    const items = [...document.querySelectorAll(".bili-dyn-list__item")];
    let sel = readFilter();
    if (sel && !up.tags.some((t) => t.id === sel)) sel = "";
    // Every loaded card, not only the queued ones: the counts cover the whole list.
    const mids = items.map((it) => {
      const el = it.querySelector(".bili-dyn-title__text");
      return el ? nameMid(el, idx) : "";
    });
    const counts = upCounts(mids, up.tags, up.map);
    const writes = items.map((it, i) => {
      const hide = upHidden(mids[i], sel, up.map);
      return hide !== it.classList.contains("mdg-up-hide") ? () => it.classList.toggle("mdg-up-hide", hide) : null;
    });
    const bar = document.querySelector(".mdg-upbar");
    // No UP tags (yet, or the last one deleted): only the 「+」s, no bar.
    if (!up.tags.length) return bar ? [...writes, () => bar.remove()] : writes;
    const key = `${sel}|${up.tags.map((t) => `${t.id}:${t.name}:${t.color}:${counts[t.id]}`).join(",")}|${counts[""]}`;
    if (bar?.dataset.key !== key || bar.nextElementSibling !== list) writes.push(() => {
      bar?.remove();
      list.before(upBarEl(sel, counts, key));
    });
    return writes;
  }

  function upBarEl(sel, counts, key) {
    const bar = document.createElement("div");
    bar.className = "mdg-upbar";
    bar.dataset.key = key;
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "MoonDigest UP 标签筛选");
    bar.title = UP_TIP;
    bar.append(brandEl());
    for (const t of [{ id: "", name: "全部" }, ...up.tags]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mdg-upbar-tag";
      b.dataset.tag = t.id;
      b.setAttribute("aria-pressed", String(t.id === sel));
      if (t.color) b.style.setProperty("--mdg-c", t.color);
      const n = document.createElement("span");
      n.className = "mdg-upbar-n";
      n.textContent = counts[t.id] || 0;
      b.append(t.name, n);
      bar.append(b);
    }
    bar.addEventListener("click", (e) => {
      const b = e.target.closest?.(".mdg-upbar-tag");
      if (!b) return;
      try {
        sessionStorage.setItem(FILTER_KEY, b.dataset.tag);
      } catch {}
      run().catch(() => {});
    });
    return bar;
  }

  function clearUps() {
    closePick(false);
    findAll(".mdg-ups, .mdg-upbar").forEach((n) => n.remove());
    refitAll();
    document.querySelectorAll(".mdg-up-hide").forEach((n) => n.classList.remove("mdg-up-hide"));
  }

  // Tag chips are not controls (they sit inside the author's link like the name). Only 「+ UP 标签」 acts: it opens the
  // tag picker instead of the space page. Events from BewlyCat's shadow root reach the document retargeted to #bewly;
  // composedPath has the button. After the extension reloads this old script still runs: the click is still kept from
  // the author's link, and the picker says to reload the page (renderPick).
  function onChip(e) {
    if (globalThis.MdgTyping.composing(e) || globalThis.MdgTyping.typingIn(e)) return;
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    const add = (e.composedPath?.() || []).find((n) => n.classList?.contains("mdg-up-add"));
    if (!add) return;
    e.preventDefault();
    e.stopPropagation();
    return pick?.add === add ? closePick(true) : openPick(add);
  }

  // ---- The 「+ UP 标签」 picker: the user's UP tags with checks, 新建标签; a click writes follow_tags / follow_tag_map at once.
  // It lives in its own closed shadow root, so neither Bilibili's nor BewlyCat's CSS reaches it, and key events stop at
  // its host. Nothing in it writes to Bilibili.
  let pick = null; // { mid, spot, add, host, root, panel, rect, editing, focus }
  const PICK_CSS = `
:host { all: initial; }
.pick { --bg: #fff; --text: #18191c; --muted: #9499a0; --line: #e3e5e7; --hover: #f1f2f3; --accent: #7c3ed1; --link: #0079ad;
  position: fixed; z-index: 2147483000; box-sizing: border-box; width: 270px; max-height: calc(100vh - 16px); overflow: auto;
  padding: 10px 8px 8px; border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 8px;
  background: var(--bg); color: var(--text); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.14); text-align: left;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
.pick.dark { --bg: #232527; --text: #e3e5e7; --muted: #8d9198; --line: #3a3d42; --hover: #303236; --accent: #cba6f7; --link: #33bef0;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5); }
.h { margin: 0 6px 6px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.opt { display: flex; align-items: center; gap: 8px; box-sizing: border-box; width: 100%; margin: 0; padding: 5px 6px; border: 0;
  border-radius: 6px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.opt:hover, .opt:focus-visible { background: var(--hover); outline: none; }
.opt:focus-visible { box-shadow: inset 0 0 0 1px var(--accent); }
.ck { flex: none; width: 12px; font-weight: 700; }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--c, var(--muted)); }
.nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.new { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--line); }
.new .opt { color: var(--link); }
input { box-sizing: border-box; width: 100%; margin: 0; padding: 4px 8px; border: 1px solid var(--accent); border-radius: 6px;
  background: transparent; color: inherit; font: inherit; outline: none; }
.empty, .foot { margin: 2px 6px; color: var(--muted); font-size: 12px; }
.foot { margin-top: 6px; font-size: 11px; }
.go { display: block; margin: 6px 6px 0; padding: 0; border: 0; background: none; color: var(--link); font: inherit; font-size: 12px;
  cursor: pointer; text-align: left; }
.go:hover, .go:focus-visible { text-decoration: underline; outline: none; }`;

  // Bilibili's dark theme is a class on <html>; BewlyCat's follows its own setting, so the name's own text color decides.
  function isDark(el) {
    if (document.documentElement.classList.contains("bili_dark")) return true;
    const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(getComputedStyle(el).color || "");
    return Boolean(m) && 0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3] > 150;
  }

  function openPick(add) {
    closePick(false);
    const box = add.parentNode;
    const host = document.createElement("div");
    host.className = "mdg-tagpick-host";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = PICK_CSS;
    const panel = document.createElement("div");
    panel.className = isDark(box) ? "pick dark" : "pick";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", upTagTitle(add.dataset.name));
    root.append(style, panel);
    // Typing a tag name must not reach page hotkeys (the player's space, arrows).
    for (const t of ["keydown", "keyup", "keypress"]) host.addEventListener(t, (e) => e.stopPropagation());
    panel.addEventListener("keydown", onPickKey);
    panel.addEventListener("click", onPickClick);
    pick = { mid: box.dataset.mid, spot: box.previousSibling, add, host, root, panel, rect: add.getBoundingClientRect(), editing: false, focus: null };
    document.documentElement.append(host);
    add.setAttribute("aria-expanded", "true");
    renderPick();
    pickFocusables()[0]?.focus();
    document.addEventListener("pointerdown", onPickOutside, true);
    window.addEventListener("scroll", onPickAway);
    window.addEventListener("resize", onPickAway);
  }

  function closePick(refocus) {
    if (!pick) return;
    const p = pick;
    pick = null;
    p.host.remove();
    document.removeEventListener("pointerdown", onPickOutside, true);
    window.removeEventListener("scroll", onPickAway);
    window.removeEventListener("resize", onPickAway);
    p.add.setAttribute("aria-expanded", "false");
    if (refocus && p.add.isConnected) p.add.focus();
  }
  const onPickAway = () => closePick(false);
  function onPickOutside(e) {
    const path = e.composedPath?.() || [];
    if (pick && !path.includes(pick.host) && !path.includes(pick.add)) closePick(false);
  }

  // A new element with its class and text, either left out when not given.
  function elOf(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function renderPick() {
    if (!pick) return;
    const head = elOf("div", "h", upTagTitle(pick.add.dataset.name));
    // The extension reloaded under this page: storage and messages no longer reach it.
    if (!chrome.runtime?.id) {
      pick.panel.replaceChildren(head, elOf("div", "empty", TEXT.reloaded));
      return placePick();
    }
    const was = pick.root.activeElement;
    const focus = pick.focus ?? (was?.dataset?.id || (was?.classList?.contains("go") ? "go" : was?.classList?.contains("opt") ? "new" : was ? "input" : null));
    pick.focus = null;
    const rows = pickRows(pick.mid, up.tags, up.map);
    const list = elOf("div", "list");
    list.setAttribute("role", "menu");
    for (const r of rows) {
      const b = elOf("button", "opt");
      b.type = "button";
      b.dataset.id = r.id;
      b.setAttribute("role", "menuitemcheckbox");
      b.setAttribute("aria-checked", String(r.on));
      const dot = elOf("span", "dot");
      if (r.color) dot.style.setProperty("--c", r.color);
      b.append(elOf("span", "ck", r.on ? "✓" : ""), dot, elOf("span", "nm", r.name));
      list.append(b);
    }
    if (!rows.length) list.append(elOf("div", "empty", "还没有 UP 标签"));
    const more = elOf("div", "new");
    const full = upTagsFull(up.tags);
    if (full) more.append(elOf("div", "empty", full));
    else if (pick.editing) {
      const input = elOf("input");
      input.type = "text";
      input.maxLength = globalThis.MdgTagCore.TAG_NAME_MAX;
      input.placeholder = "标签名，回车新建";
      input.setAttribute("aria-label", LABEL.newTagName);
      more.append(input);
    } else {
      const b = elOf("button", "opt");
      b.type = "button";
      b.dataset.new = "";
      b.append(elOf("span", "ck", "+"), elOf("span", "nm", LABEL.newTag));
      more.append(b);
    }
    // The chips no longer open the 分拣台; this is the one way there from a B站 page.
    const go = elOf("button", "go", "在分拣台「关注」里打开这个 UP 主 ↗");
    go.type = "button";
    pick.panel.replaceChildren(head, list, more, go, elOf("div", "foot", `${LOCAL_ONLY} · Esc 关闭`));
    placePick();
    const again = focus === "go" ? go : focus === "input" || focus === "new" ? more.firstChild : [...pickFocusables()].find((b) => b.dataset.id === focus);
    if (focus) (again || pickFocusables()[0])?.focus();
  }

  // Under the 「+」 where it was when opened (it moves as chips are added), above it when there is no room below.
  const placePick = () => placeUnder(pick.panel, pick.rect, pick.panel.offsetWidth || 270);
  // A fixed popover 6px under `r`, or above it when there is no room below, 8px inside the window.
  function placeUnder(node, r, w = node.offsetWidth) {
    const h = node.offsetHeight || 0;
    node.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    node.style.top = `${r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  }

  const pickFocusables = () => (pick ? pick.panel.querySelectorAll(".opt, input, .go") : []);

  function onPickKey(e) {
    if (globalThis.MdgTyping.composing(e)) return; // Enter picks the IME candidate, Esc cancels the composition
    if (e.key === "Escape") {
      e.preventDefault();
      return closePick(true);
    }
    const all = [...pickFocusables()];
    const i = all.indexOf(pick.root.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Tab") {
      // Tab stays inside the picker like a dialog; Esc is the way out.
      e.preventDefault();
      const step = e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey) ? -1 : 1;
      all[(i + step + all.length) % all.length]?.focus();
    } else if (e.key === "Enter" && e.target.tagName === "INPUT") {
      e.preventDefault();
      pickWrite({ create: e.target.value });
    }
  }

  function onPickClick(e) {
    if (!chrome.runtime?.id) return renderPick();
    if (e.target.closest?.(".go")) {
      const hash = `follow&up=${pick.mid}`;
      closePick(false);
      chrome.runtime.sendMessage({ type: "triage-open", hash }).catch(() => {});
      return;
    }
    const b = e.target.closest?.(".opt");
    if (!b) return;
    if (b.dataset.id) return pickWrite({ toggle: b.dataset.id });
    pick.editing = true;
    pick.focus = "input";
    renderPick();
  }

  // Writes at once; every box of this UP on the page and the 动态 bar counts redraw right away, not after the debounce.
  async function pickWrite(op) {
    const asked = pick;
    if (!asked) return;
    if (!chrome.runtime?.id) return renderPick();
    const r = await saveUpTag(asked.mid, op).catch(() => null);
    if (!r?.map) return renderPick();
    up = { ...up, tags: r.tags, map: r.map };
    upOn = true;
    // Another UP's picker may be open by now: the answer settles the one that asked, not it.
    if (pick === asked) {
      pick.editing = false;
      pick.focus = r.id;
    }
    renderPick();
    run().catch(() => {});
  }

  async function loadUps() {
    const got = await MdgLimits.followGet(["tags", "tag_map", "list"]);
    const list = got.list?.list;
    up = { tags: Array.isArray(got.tags) ? got.tags : [], map: got.tag_map || {}, followed: new Set(Array.isArray(list) ? list.map(String) : []) };
    who = null;
    // Tags to show, or followed UPs to offer 「+ UP 标签」 for, and the setting 「在 B站页面显示 UP 标签」 on.
    upHas = (up.tags.length > 0 && Object.values(up.map).some((ids) => ids?.length)) || up.followed.size > 0;
    upOn = upSetting && upHas;
    // A follow sync must not rebuild the picker under a tag name being typed; its own write redraws it.
    if (!upOn) clearUps();
    else if (!pick?.editing) renderPick();
    setEnabled(triageOn || seenCfg.on || upOn);
    rescan();
  }

  async function markVideos(scan, scope) {
    const covers = scanned(scope, COVERS);
    const here = pageBvid();
    // Most Bilibili iframes hold no video link: nothing to mark, so no storage reads. The top frame reads at once,
    // links or not: its cards come later (B站 draws them after its own requests), and are then marked from memory.
    if (!here && !covers.length && window !== window.top) return;
    const fid = favFid();
    if (!keys && chrome.storage.local.getKeys) {
      const load = keyLoads.current;
      const list = await chrome.storage.local.getKeys();
      if (load.alive) keys = new Set(list);
    }
    if (seenCfg.on) await loadSeen(covers, scan);
    if (!scan.alive) return;
    if (!triageOn) {
      const writes = hydrated(covers).map(markCover);
      for (const w of writes) w?.();
      return;
    }
    if (!shared || fid !== sharedFid) await loadShared(fid, scan);
    if (!scan.alive) return;
    // Video links that are not a card's title: the playing video's own title, which links to itself on /list/ (on /video/
    // it is plain text; the line under it has the marks), and the page footer's links.
    const anchors = scanned(scope, SEL).filter((a) => !a.closest(".video-info-title, .bili-footer"));
    const want = [...new Set(anchors.map((a) => bvidFromHref(a.getAttribute("href"))).concat(here))].filter((b) => b && !known(b));
    // ponytail: a card whose video has results of its own, off that video's favorites page, waits for this read and is
    // marked a frame or two after it appears; preloading every result would read megabytes on every page.
    if (want.length) {
      const got = await chrome.storage.local.get(want.flatMap((b) => [K.triageTitle(b), K.triageAnalysis(b)]));
      if (!scan.alive) return;
      for (const b of want) cache.set(b, infoFor(b, got));
    }
    if (!enabled) return;
    // Every style read first, then every DOM write, so the page recalculates styles once rather than per card.
    const writes = [...hydrated(anchors).map(markAnchor), ...hydrated(covers).map(markCover)];
    for (const w of writes) w?.();
    markVideoLine(here);
  }

  const hasResult = (b) => !keys || keys.has(K.triageTitle(b)) || keys.has(K.triageAnalysis(b));
  const infoFor = (b, got) =>
    badgeInfo({
      title: got[K.triageTitle(b)],
      analysis: got[K.triageAnalysis(b)],
      invalid: shared.invalid.has(b),
      tagIds: shared.videoTags[b],
      tags: shared.tags,
      decision: shared.decisions[b],
      folder: sharedFid
    });
  // Cached, or nothing stored under its own keys: its info comes from the shared data alone.
  function known(b) {
    if (cache.has(b)) return true;
    if (hasResult(b)) return false;
    cache.set(b, infoFor(b, {}));
    return true;
  }

  async function loadShared(fid, scan) {
    // A favorites page shows its own folder's decisions; elsewhere every folder's decisions are merged.
    // getKeys is Chrome 130+; before that only 保留 shows outside a favorites page.
    const decisionKeys = [K.triageKept, ...(fid ? [K.triageDecisions(fid)] : [...(keys || [])].filter((k) => k.startsWith(K.triageDecisionsPrefix)))];
    // 已失效 comes from the folder's snapshot, so only a favorites page knows it: reading every folder's snapshot (its
    // whole item list) on every B站 page costs too much, and invalid videos are mostly met in favorites.
    const snapshot = fid ? K.triageSnapshot(fid) : "";
    const got = await chrome.storage.local.get([K.triageTags, K.triageVideoTags, ...decisionKeys, ...(snapshot ? [snapshot] : [])]);
    if (!scan.alive) return;
    sharedFid = fid;
    shared = { tags: got[K.triageTags], videoTags: got[K.triageVideoTags] || {}, decisions: mergeDecisions(got, Boolean(fid)), invalid: new Set(got[snapshot]?.invalid || []) };
    cache.clear();
    // The snapshot also lists the folder's videos: their results are read now, so the cards B站 draws once its own
    // request returns are marked in the frame they appear.
    const pre = (got[snapshot]?.bvids || []).filter(hasResult);
    if (!pre.length) return;
    const res = await chrome.storage.local.get(pre.flatMap((b) => [K.triageTitle(b), K.triageAnalysis(b)]));
    if (scan.alive) for (const b of pre) cache.set(b, infoFor(b, res));
  }

  // One key per video on screen, a few KB per page; the history itself is read by the background (triage-seen-sync).
  // A video with no key of its own has no progress, so it needs no read.
  async function loadSeen(covers, scan) {
    const want = [];
    for (const b of new Set(covers.map(bvidOf))) {
      if (!b || seenCache.has(b)) continue;
      if (keys && !keys.has(K.seen(b))) seenCache.set(b, 0);
      else want.push(b);
    }
    if (!want.length) return;
    const got = await chrome.storage.local.get(want.map(K.seen));
    if (!scan.alive) return;
    for (const b of want) seenCache.set(b, got[K.seen(b)]?.[0] || 0);
  }

  // The progress bar (Bilibili's own look) on a cover link, and once 看完了 the corner tag or the veil.
  // Reads only; returns the DOM write for run() to apply after every card is read.
  function markCover(a) {
    const b = bvidOf(a);
    const rule = ruleFor(a);
    const known = seenCfg.on && rule.seen ? seenCache.get(b) || 0 : 0;
    const pct = seenCfg.bar ? known : 0;
    // Where B站 itself says 已看完, ours would say it twice.
    const mark = seenCfg.mark;
    const seen = mark && known >= seenCfg.threshold && !biliSaysSeen(a);
    // Below the share, a faint 看到 N% says how far it got. 历史 takes the corner tag: every cover there was watched,
    // and the veil hid them all.
    const faint = mark && known > 0 && known < seenCfg.threshold;
    const style = rule.corner ? "badge" : seenCfg.style;
    // On the image's own box: some links wrap the whole card, title included.
    const media = a.querySelector("picture") || a.querySelector("img");
    const host = media?.parentElement;
    if (!host) return;
    const old = host.querySelector(":scope > .mdg-seen");
    const key = `${b}|${pct}|${seen}|${faint}|${known}|${style}`;
    if (old?.dataset.key === key) return;
    if (!pct && !seen && !faint) return old && (() => old.remove());
    const box = document.createElement("span");
    box.className = `mdg-seen mdg-seen-${style}`;
    box.dataset.key = key;
    const words = seenWords(known, seen && !rule.tight);
    if (seen || faint) box.append(Object.assign(document.createElement("span"), { className: `mdg-seen-mark${faint ? " mdg-faint" : ""}`, textContent: words }));
    // Bilibili's history and 稍后再看 cards draw this bar themselves.
    if (pct && !host.querySelector(".bili-cover-card__progress")) {
      const bar = Object.assign(document.createElement("span"), { className: "mdg-seen-bar" });
      bar.append(Object.assign(document.createElement("i"), { style: `width:${Math.max(pct, 2)}%` }));
      box.append(bar);
    }
    if (!box.firstChild) return old && (() => old.remove());
    const fix = getComputedStyle(host).position === "static";
    return () => {
      old?.remove();
      if (fix) host.classList.add("mdg-seen-host");
      host.append(box);
    };
  }

  // Like markCover, returns its DOM write; a stale badge goes at once, before titleBox reads the title's text.
  function markAnchor(a) {
    // BewlyCat wraps the whole card in a link around the title's own link; the inner link takes the badge.
    if (a.querySelector(SEL)) return;
    const b = bvidFromHref(a.getAttribute("href"));
    const info = cache.get(b);
    const rule = ruleFor(a);
    // Where the title is crowded (收藏夹), the marks get their own line above it: below would read as the next video's.
    const above = rule.above ? aboveBox(a) : null;
    const prev = above?.previousSibling;
    const old = above ? (prev?.nodeType === 1 && prev.classList.contains("mdg-badge") ? prev : null) : a.querySelector(".mdg-badge");
    if (old && old.dataset.bvid === b && info) return;
    old?.remove();
    // Nothing this page shows (a tagged video without a verdict in a popover): no mark at all.
    const parts = info && lineParts(info, rule);
    if (!parts) return;
    const badge = badgeEl(parts.info, b, parts.tags);
    if (above) {
      badge.classList.add("mdg-above");
      return () => above.before(badge);
    }
    const target = titleBox(a);
    if (!target) return;
    // Some titles hang their opening bracket with a negative text-indent, which would clip the badge.
    const indent = parseFloat(getComputedStyle(target).textIndent);
    if (indent < 0) badge.style.marginLeft = `${-indent}px`;
    return () => target.prepend(badge);
  }

  // The title's own block (B站's .bili-video-card__title, BewlyCat's h3.video-card-title), or a bare title link; when
  // that sits in a row (BewlyCat puts its ⋮ menu beside the title), the row, so the line goes above the whole row.
  function aboveBox(a) {
    let box = a.querySelector('[class*="title"]') || a.closest('[class*="title"]') || (!a.querySelector("img, picture") && a) || null;
    for (let i = 0; i < 3 && box?.parentElement; i++) {
      const cs = getComputedStyle(box.parentElement);
      if (!/flex/.test(cs.display || "") || String(cs.flexDirection).startsWith("column")) break;
      box = box.parentElement;
    }
    return box;
  }

  // The block that holds the title's first text, so the badge sits inline before the title words. BewlyCat's 稍后再看
  // wraps a whole item in one link whose title is a plain .keep-two-lines.
  function titleBox(a) {
    const root = a.querySelector('[class*="title"], .keep-two-lines') || (!a.querySelector("img, picture") && a);
    if (!root || root.textContent.trim().length < 2) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.data.trim() ? 1 : 3) });
    let box = walker.nextNode()?.parentElement;
    while (box && box !== root && getComputedStyle(box).display === "inline") box = box.parentElement;
    return box || null;
  }

  const brandEl = () => Object.assign(document.createElement("span"), { className: "mdg-brand", textContent: "MoonDigest" });

  function badgeEl(info, bvid, tags) {
    const el = document.createElement("span");
    el.className = "mdg-badge";
    el.dataset.bvid = bvid;
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", info.aria);
    if (info.label) {
      const v = document.createElement("span");
      // The dashed 粗看 frame and the low-confidence fade describe the AI's verdict, not your own decision.
      v.className = info.action ? `mdg-v mdg-act-${info.action}` : `mdg-v mdg-${info.verdict}${info.stage === 1 ? " mdg-s1" : ""}${info.low ? " mdg-low" : ""}`;
      v.textContent = info.label;
      el.append(v);
    }
    appendChips(el, tags, "mdg-chip");
    return el;
  }

  // ---- Fitting: a group shows as many whole chips as its room holds, then 「+N」 (DESIGN 视觉设计 · B站 页面上的标记). Measured after layout,
  // again when a box's container changes size (BewlyCat's grid, a resized window) and when a box is redrawn.
  // The box wraps its chips (badges.css), so its narrowest size is one chip and it never widens a card; laid out with
  // every chip, it is as wide as the room it has, and fitCount picks from there. ----
  const kids = (n) => [...n.childNodes].filter((k) => k.nodeType === 1);
  const px = (v) => parseFloat(v) || 0;
  function fitBoxes(boxes) {
    // Every chip back first, then every read, then every write: one layout for the batch.
    const live = boxes.filter((b) => b.isConnected && kids(b).some((k) => k.classList.contains("mdg-fit")));
    for (const b of live) {
      b.classList.remove("mdg-squeezed", "mdg-add-fits");
      b.classList.add("mdg-fitting");
      const all = kids(b);
      for (const k of all) {
        k.classList.remove("mdg-off");
        if (k.classList.contains("mdg-more")) k.textContent = `+${all.filter((c) => c.classList.contains("mdg-fit")).length}`;
      }
    }
    const plans = live.map((b) => {
      const all = kids(b);
      const chips = all.filter((k) => k.classList.contains("mdg-fit"));
      const more = all.find((k) => k.classList.contains("mdg-more"));
      const cs = getComputedStyle(b);
      const w = (k) => k.getBoundingClientRect().width;
      let room = b.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
      // In a line of text (BewlyCat's one-line name links) an inline box may run past its parent's edge, which clips it:
      // the room ends there.
      const pcs = getComputedStyle(b.parentNode);
      if (!/flex|grid/.test(pcs.display || "")) {
        const edge = b.parentNode.getBoundingClientRect().right - px(pcs.paddingRight) - px(pcs.borderRightWidth);
        room = Math.min(room, edge - b.getBoundingClientRect().left - px(cs.borderLeftWidth) - px(cs.paddingLeft) - px(cs.paddingRight));
      }
      // A hover-only 「+ UP 标签」 needs no room of its own: shown, it goes beside the chips when they leave room for it
      // (mdg-add-fits), else in their place (badges.css).
      const hover = b.classList.contains("mdg-plus-hover") ? all.find((k) => k.classList.contains("mdg-up-add")) : null;
      const fixed = all.filter((k) => k !== more && k !== hover && !chips.includes(k)).map(w);
      // Half a pixel for sub-pixel widths that round the other way.
      const opts = { gap: px(cs.columnGap), fixed, more: w(more) };
      const k = fitCount(chips.map(w), room + 0.5, opts);
      const addFits = Boolean(hover) && fitCount(chips.map(w), room + 0.5, { ...opts, fixed: [...fixed, w(hover)] }) === k;
      return [b, chips, more, k, addFits];
    });
    for (const [b, chips, more, k, addFits] of plans) {
      b.classList.remove("mdg-fitting");
      b.classList.toggle("mdg-add-fits", addFits);
      b.dataset.fit = "1";
      resizes?.observe(b.parentNode);
      chips.forEach((c, i) => i >= Math.max(k, 0) && c.classList.add("mdg-off"));
      if (k === chips.length || k < 0) more.classList.add("mdg-off");
      else more.textContent = `+${chips.length - k}`;
      // Not even 「+N」 fits: no chips, and no purple rule unless something else (the verdict) still shows.
      if (k < 0) b.classList.add("mdg-squeezed");
    }
  }
  // ponytail: observed containers are only released by clearMarks/clearUps (disconnect); a long-lived feed keeps a few
  // hundred detached nodes alive until then.
  let refitFrame = 0;
  // Drops every observed container; the boxes left (the other feature's) are fitted and observed again on the next run.
  function refitAll() {
    resizes?.disconnect();
    findAll(".mdg-badge, .mdg-ups").forEach((b) => delete b.dataset.fit);
  }
  // Only the boxes in the containers that changed size are fitted again (fitBoxes observes each box's parent).
  const resized = new Set();
  const resizes = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => {
    for (const e of entries) resized.add(e.target);
    if (refitFrame) return;
    refitFrame = requestAnimationFrame(() => {
      refitFrame = 0;
      const boxes = [...resized].flatMap((p) => kids(p).filter((b) => b.dataset.fit && b.matches(".mdg-badge, .mdg-ups")));
      resized.clear();
      fitBoxes(boxes);
    });
  }) : null;

  function markVideoLine(bvid) {
    const old = document.querySelector(".mdg-line");
    const info = cache.get(bvid);
    const parts = info && lineParts(info, lineOn);
    // Keyed by what it shows, as upChip: redrawn when that changes (保留 or a tag in the 分拣台), else left as it is.
    const key = parts ? `${bvid}|${JSON.stringify(parts)}` : "";
    if ((old?.dataset.key || "") === key) return;
    // Below the views / danmaku / date row; the title alone when that row isn't there.
    const anchor = document.querySelector(".video-info-meta") || document.querySelector(".video-info-title") || document.querySelector("h1.video-title");
    if (!parts || !anchor) return void old?.remove();
    if (anchor.closest(SSR)) return;
    const line = document.createElement("div");
    line.className = "mdg-line";
    line.dataset.bvid = bvid;
    line.dataset.key = key;
    line.append(brandEl(), badgeEl(parts.info, bvid, parts.tags));
    const text = parts.text;
    if (text) {
      const s = document.createElement("span");
      s.className = "mdg-one";
      s.textContent = text;
      line.append(s);
    }
    // Swapped in one step: no frame without a line.
    old?.remove();
    anchor.after(line);
  }

  // The AI's reasons on a verdict, or every tag of a group on its 「+N」.
  function showPop(host) {
    let at = host;
    const rows = [];
    if (host.classList.contains("mdg-more")) {
      rows.push(elOf("div", "mdg-pop-head", host.dataset.head), elOf("div", "mdg-pop-one", host.dataset.names));
    } else {
      at = host.matches(".mdg-line") ? host.querySelector(".mdg-badge") : host;
      const raw = cache.get(at?.dataset.bvid);
      // What this mark shows (lineParts): with the AI 判断 switched off, no verdict and so none of its reasons.
      const info = raw && lineParts(raw, at.closest(".mdg-line") ? lineOn : ruleFor(at))?.info;
      if (!info?.label || (!info.reason && !info.oneLiner)) return hidePop();
      rows.push(elOf("div", "mdg-pop-head", info.aria));
      if (info.oneLiner) rows.push(elOf("div", "mdg-pop-one", info.oneLiner));
      for (const p of info.points) rows.push(elOf("div", "mdg-pop-pt", `• ${p}`));
      if (info.reason) rows.push(elOf("div", "mdg-pop-reason", `理由：${info.reason}`));
    }
    pop ||= Object.assign(document.createElement("div"), { className: "mdg-pop", role: "tooltip" });
    pop.replaceChildren(...rows);
    document.body.append(pop);
    placeUnder(pop, at.getBoundingClientRect());
  }

  const hidePop = () => pop?.remove();
  // Events from inside BewlyCat's shadow root reach the document retargeted to #bewly; composedPath has the real node.
  const origin = (e) => e.composedPath?.()[0] || e.target;
  const onOver = (e) => {
    const host = origin(e).closest?.(".mdg-more, .mdg-badge, .mdg-line");
    if (host) showPop(host);
    else if (pop?.isConnected) hidePop();
  };
  const onFocus = (e) => {
    const t = origin(e);
    const host = t.closest?.(".mdg-more, .mdg-badge") || t.querySelector?.(".mdg-badge");
    if (host) showPop(host);
    else hidePop();
  };

  function clearMarks() {
    hidePop();
    // The 分拣台's player finds no cards (findAll), but has the line under the title.
    [...findAll(".mdg-badge, .mdg-seen"), ...document.querySelectorAll(".mdg-line")].forEach((n) => n.remove());
    refitAll();
    findAll(".mdg-seen-host").forEach((n) => n.classList.remove("mdg-seen-host"));
  }

  function setEnabled(on) {
    on &&= !superseded;
    if (on === enabled) return;
    enabled = on;
    if (on) {
      observer.observe(document.documentElement, OBSERVE);
      document.addEventListener("visibilitychange", onVisible);
      document.addEventListener("mouseover", onOver, true);
      document.addEventListener("focusin", onFocus, true);
      document.addEventListener("focusout", hidePop, true);
      document.addEventListener("click", onChip, true);
      document.addEventListener("keydown", onChip, true);
      // Not in a frame: the first look starts its reads now, while B站 is still parsing, so what it marks is in memory
      // by the time the title and the cards are parsed (the script runs at document_start).
      run().catch(() => {});
    } else {
      observer.disconnect();
      bewlyHooked = null;
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("focusout", hidePop, true);
      document.removeEventListener("click", onChip, true);
      document.removeEventListener("keydown", onChip, true);
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      timer = frame = 0;
      pending.clear();
      clearMarks();
      clearUps();
    }
  }

  // The switches and the 观看进度 options decide whether the page is scanned at all; the settings table's cells
  // turn single marks off per surface.
  function applySettings(stored) {
    const v = globalThis.MdgSettings.normalizeSwitches(stored);
    const verdicts = v[VERDICT_SETTING];
    const tags = v[SETTING];
    lineOn = { verdict: verdicts, vtags: tags && !lineOnly };
    rules = globalThis.MdgSurfaces.rulesWith(v.biliMarksOff, [!verdicts && "verdict", !tags && "vtags"].filter(Boolean));
    const wasTriage = triageOn;
    triageOn = verdicts || (tags && !lineOnly);
    // Storage changes are not followed while the marks are off: turned back on, read everything again.
    if (triageOn && !wasTriage) shared = null;
    const before = seenCfg.on;
    seenCfg = lineOnly ? { ...seenConfig(v), on: false } : seenConfig(v);
    // Turning it off clears the stored history (triage-bg.js), so a later re-enable starts from a fresh read.
    if (!seenCfg.on) seenCache.clear();
    markBewly();
    // Only the top frame asks; the background reads what is new at most every 10 minutes.
    if (seenCfg.on && !before && window === window.top) chrome.runtime.sendMessage({ type: "triage-seen-sync" }).catch(() => {});
    upSetting = !lineOnly && v[UP_SETTING];
    const wasUp = upOn;
    upOn = upSetting && upHas;
    if (wasUp && !upOn) clearUps();
    const on = triageOn || seenCfg.on || upOn;
    if (on && enabled) {
      scans.next();
      clearMarks();
      schedule();
    } else setEnabled(on);
  }
  // The switches this script reads, with settings.js's defaults.
  const SYNC_DEFAULTS = Object.fromEntries([SETTING, VERDICT_SETTING, UP_SETTING, ...Object.keys(SEEN_DEFAULTS), "biliMarksOff"].map((k) => [k, globalThis.MdgSettings.DEFAULTS[k]]));
  const readSettings = () => chrome.storage.sync.get(SYNC_DEFAULTS).then(applySettings).catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (superseded) return;
    if (area === "local") {
      keyLoads.next();
      for (const [k, c] of Object.entries(changes)) keys?.[c.newValue === undefined ? "delete" : "add"](k);
    }
    const fc = MdgLimits.followShort(changes);
    if (area === "local" && (fc.tags || fc.tag_map || fc.list)) loadUps().catch(() => {});
    else if (area === "local" && fc.people && upOn) {
      who = null;
      schedule();
    }
    if (area === "sync" && Object.keys(SYNC_DEFAULTS).some((k) => k in changes)) readSettings();
    if (area === "local" && enabled && Object.keys(changes).some((k) => k.startsWith(K.seenPrefix))) {
      for (const k of Object.keys(changes)) if (k.startsWith(K.seenPrefix)) seenCache.delete(k.slice(K.seenPrefix.length));
      scans.next();
      schedule();
    }
    if (area === "local" && enabled && triageOn && Object.keys(changes).some(isSharedKey)) {
      scans.next();
      shared = null;
      clearMarks();
      schedule();
    } else if (area === "local" && enabled && triageOn) {
      const changed = Object.keys(changes).flatMap((k) => [K.triageTitlePrefix, K.triageAnalysisPrefix].filter((p) => k.startsWith(p)).map((p) => k.slice(p.length)));
      if (!changed.length) return;
      scans.next();
      for (const b of changed) {
        cache.delete(b);
        [...findAll(`.mdg-badge[data-bvid="${b}"]`), ...document.querySelectorAll(`.mdg-line[data-bvid="${b}"]`)].forEach((n) => n.remove());
      }
      schedule();
    }
  });
  // An extension reload or update leaves this copy running with a dead chrome.runtime, and background.js injects a
  // fresh one. The fresh copy announces itself; the old one stops scanning and takes its marks with it, so one copy draws.
  function standDown() {
    superseded = true;
    scans.next(); // an in-flight scan drops its reads
    setEnabled(false);
    document.getElementById("bewly")?.removeAttribute(SEEN_ATTR);
    bewlyRoot()?.querySelector("link[data-mdg]")?.remove();
  }
  document.dispatchEvent(new Event("mdg-badges-superseded"));
  document.addEventListener("mdg-badges-superseded", standDown, { once: true });

  readSettings();
  loadUps().catch(() => {});
})();
