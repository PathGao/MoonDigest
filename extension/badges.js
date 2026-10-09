// Read-only triage marks on Bilibili pages. Videos without triage data get zero DOM changes.
(() => {
  // The triage page's fixed AI classes; the ids are also the CSS color classes.
  const VERDICTS = { keep: "值得留", drop: "可清理", unsure: "拿不准" };
  const ACTION = { keep: "已保留", unfav: "已取消收藏" };
  const STAGE = ["", "标题粗看", "字幕细看"];
  const BVID_RE = /(?:\/video\/|[?&]bvid=)(BV[0-9A-Za-z]{10})/;

  function bvidFromHref(href) {
    return BVID_RE.exec(String(href || ""))?.[1] || "";
  }

  // Same rules as verdictOf in triage/triage.js: stage-2 analysis (unknown = 拿不准) > stage-1 title result.
  function badgeInfo({ title, analysis, tagIds, tags, decision } = {}) {
    const done = analysis?.status === "done";
    let v = null;
    if (done) v = { verdict: VERDICTS[analysis.verdict] ? analysis.verdict : "unsure", reason: analysis.reason, stage: 2 };
    else if (VERDICTS[title?.verdict]) v = { verdict: title.verdict, reason: title.reason, stage: 1, low: title.confidence === "low" };
    const name = v && VERDICTS[v.verdict];
    const byId = new Map((Array.isArray(tags) ? tags : []).map((t) => [t.id, t]));
    const userTags = (Array.isArray(tagIds) ? tagIds : [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((t) => ({ name: String(t.name || ""), color: String(t.color || "") }));
    const action = ACTION[decision?.action] ? decision.action : "";
    if (!v && !userTags.length && !action) return null;

    // AI classes carry an 「AI」 marker; the user's own decision never does.
    const label = action ? ACTION[action] : v ? `AI ${name}` : "";
    const aria = [
      "MoonDigest 分拣",
      action && ACTION[action],
      v && `AI 判断 ${name}（${STAGE[v.stage]}${v.low ? "，低置信" : ""}）`,
      userTags.length && `标签：${userTags.map((t) => t.name).join("、")}`
    ]
      .filter(Boolean)
      .join("，");
    return {
      label,
      aria,
      verdict: v ? v.verdict : "",
      stage: v?.stage || 0,
      low: Boolean(v?.low),
      action,
      reason: String(v?.reason || ""),
      oneLiner: done ? String(analysis.oneLiner || "") : "",
      points: done ? (analysis.points || []).map(String).filter(Boolean) : [],
      tags: userTags
    };
  }

  // Merges every triage_decisions_<folder> (取消收藏) and triage_kept (保留, one list for all folders) in `got`;
  // a video decided more than once shows its latest decision.
  function mergeDecisions(got) {
    const out = {};
    for (const [k, v] of Object.entries(got || {})) {
      if (!k.startsWith("triage_decisions_") && k !== "triage_kept") continue;
      for (const [b, d] of Object.entries(v || {})) if (!out[b] || (d?.at || 0) > (out[b].at || 0)) out[b] = d;
    }
    return out;
  }

  // ---- UP tags (follow_tags / follow_tag_map from the triage page's 关注 mode) next to an author's name ----
  // Only a bare profile link names an author: /favlist, /video, /fans/follow are menu links.
  const MID_RE = /(?:^|\/\/)space\.bilibili\.com\/(\d+)\/?(?:[?#]|$)/;
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
  const FACE_RE = /\/bfs\/face\/([^/@?#]+)/;
  const faceKey = (url) => FACE_RE.exec(String(url || ""))?.[1].toLowerCase() || "";
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
  const { cleanTagName, nextTagColor, newTagId } = globalThis.BocTagCore;
  const pickRows = (mid, tags, map) => {
    const on = new Set(map?.[mid] || []);
    return (Array.isArray(tags) ? tags : []).map((t) => ({ id: t.id, name: String(t.name || ""), color: String(t.color || ""), on: on.has(t.id) }));
  };
  // One change to one UP: { toggle: tagId }, or { create: name } which reuses a tag of that name and switches it on.
  function applyUpTag(tags, map, mid, op) {
    tags = Array.isArray(tags) ? tags : [];
    map = { ...(map || {}) };
    let id = op.toggle;
    const create = op.create != null;
    if (create) {
      const name = cleanTagName(op.create);
      if (!name) return null;
      let t = tags.find((x) => x.name === name);
      if (!t) {
        t = { id: newTagId("ft"), name, color: nextTagColor(tags), rule: "" };
        tags = [...tags, t];
      }
      id = t.id;
    } else if (!tags.some((x) => x.id === id)) return null;
    const ids = map[mid] || [];
    const next = ids.includes(id) ? (create ? ids : ids.filter((x) => x !== id)) : [...ids, id];
    if (next.length) map[mid] = next;
    else delete map[mid];
    return { tags, map, id };
  }
  // Reads both keys fresh (the triage page may have written since) and writes back only what changed.
  async function saveUpTag(local, mid, op) {
    const got = await local.get(["follow_tags", "follow_tag_map"]);
    const r = applyUpTag(got.follow_tags, got.follow_tag_map, mid, op);
    if (!r) return null;
    await local.set(r.tags !== got.follow_tags ? { follow_tags: r.tags, follow_tag_map: r.map } : { follow_tag_map: r.map });
    return r;
  }

  // ---- What each kind of B站 page shows (DESIGN §8). vtags: video tags after the AI verdict; ups: UP tags after
  // author names; plus: when 「+ UP 标签」 shows; above: video marks get their own line above the title; quiet: covers
  // keep the progress bar and the ✓ mark only; bare: the progress bar only. ----
  const SURFACES = {
    card: { vtags: true, ups: true, plus: "hover" }, // home and search (B站 and BewlyCat)
    fav: { vtags: true, ups: false, plus: "", above: true },
    later: { vtags: true, ups: true, plus: "hover", quiet: true }, // 稍后再看, 历史
    feed: { vtags: false, ups: true, plus: "hover" }, // 动态
    space: { vtags: true, ups: false, plus: "", quiet: true }, // the owner's nickname is `owner`
    video: { vtags: false, ups: false, plus: "" }, // recommendations and lists beside a video
    popover: { vtags: false, ups: false, plus: "", bare: true }, // header popovers (B站 and BewlyCat)
    owner: { vtags: false, ups: true, plus: "always" } // the video page's UP name, a space page's nickname
  };
  // "" in the 分拣台's own player, which already shows both tag lines above it.
  function surfaceOf({ host = "", path = "", search = "", viewer = false } = {}) {
    if (viewer) return "";
    const page = new URLSearchParams(search).get("page") || ""; // BewlyCat's pages
    if (page === "Favorites" || (host === "space.bilibili.com" && /^\/\d+\/favlist/.test(path))) return "fav";
    if (page === "History" || page === "WatchLater" || /^\/(?:history|account\/history|watchlater)(?:\/|$)/.test(path)) return "later";
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

  // B站's own 稍后再看 / 历史 cards say 已看完 on the cover; ours would say it twice.
  const biliSaysSeen = (a) => [...a.querySelectorAll(".bili-cover-card__stat")].some((n) => n.textContent.trim() === "已看完");

  globalThis.BocBadges = {
    bvidFromHref, badgeInfo, mergeDecisions, midFromHref, upTagsOf, firstText, spotIn, upCounts, upHidden,
    faceKey, whoIndex, resolveMid, pickRows, applyUpTag, saveUpTag, SURFACES, surfaceOf, fitCount, biliSaysSeen
  };
  if (typeof chrome === "undefined" || !chrome.storage?.local || typeof document === "undefined") return;
  const surface = surfaceOf({
    host: location.hostname,
    path: location.pathname,
    search: location.search,
    viewer: document.documentElement.hasAttribute?.("data-mdg-viewer")
  });
  if (!surface) return;
  // Header popovers draw the same video links in miniature: B站's own (.v-popover) and BewlyCat's (.bew-popover).
  const POPOVER = ".bew-popover, .v-popover";
  const ruleFor = (el) => (el.closest?.(POPOVER) ? SURFACES.popover : SURFACES[surface]);

  const SETTING = "showBiliTriageBadges";
  const UP_SETTING = "showBiliUpTags";
  // 观看进度 on covers has its own setting (设置页「观看进度」, off by default); it or the triage marks turn the page scan on.
  const SEEN_DEFAULTS = { seenShow: "off", seenThreshold: 80, seenStyle: "badge" };
  let triageOn = false;
  let seenCfg = { on: false, bar: false, mark: false, threshold: 80, style: "badge" };
  const seenCache = new Map(); // bvid -> percent | 0
  const SEL = 'a[href*="/video/BV"], a[href*="bvid=BV"]';
  // Keys that every video's info depends on; a per-video title or analysis only redraws that video.
  const isSharedKey = (k) => k === "triage_tags" || k === "triage_video_tags" || k === "triage_kept" || k.startsWith("triage_decisions_");

  const cache = new Map(); // bvid -> info | null
  let shared = null;
  let sharedFid = null;
  let enabled = false;
  let timer = 0;
  let running = false;
  let again = false;
  let pop = null;
  let gen = 0; // bumped when triage data changes so an in-flight scan drops its stale reads
  const observer = new MutationObserver(() => schedule());
  const OBSERVE = { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] };

  // BewlyCat draws its own pages (首页, 收藏, 稍后再看…) inside #bewly's open shadow root. Only that root is searched:
  // Bilibili's comment section is nested shadow roots too, and its video links should stay unmarked.
  const bewlyRoot = () => document.getElementById("bewly")?.shadowRoot || null;
  const findAll = (sel) => {
    const r = bewlyRoot();
    const list = [...document.querySelectorAll(sel)];
    return r ? list.concat([...r.querySelectorAll(sel)]) : list;
  };
  let bewlyHooked = null;
  // Page CSS doesn't reach into a shadow root, so it gets its own copy of badges.css.
  function hookBewly() {
    const r = bewlyRoot();
    if (!r || r === bewlyHooked) return;
    bewlyHooked = r;
    markBewly();
    observer.observe(r, OBSERVE);
    if (!r.querySelector("link[data-mdg]")) {
      const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: chrome.runtime.getURL("badges.css") });
      link.dataset.mdg = "";
      r.append(link);
    }
  }

  // badges.css hides BewlyCat's own watch progress while ours is on.
  const markBewly = () => document.getElementById("bewly")?.toggleAttribute("data-mdg-seen", seenCfg.on);

  const favFid = () => (surface === "fav" ? new URLSearchParams(location.search).get("fid") || "" : "");
  const pageBvid = () => (location.pathname.startsWith("/video/") ? bvidFromHref(location.pathname) : "");

  // ponytail: rescans at most every 400ms; the video page's danmaku layer mutates constantly and this caps that cost.
  function schedule() {
    if (!enabled || timer) return;
    timer = setTimeout(() => {
      timer = 0;
      const go = () => run().catch(() => {});
      window.requestIdleCallback ? requestIdleCallback(go, { timeout: 600 }) : go();
    }, 400);
  }

  async function run() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    const g = gen;
    try {
      hookBewly();
      if (upOn) await markUps();
      if (triageOn || seenCfg.on) await markVideos(g);
      fitBoxes(findAll(".mdg-badge, .mdg-ups").filter((b) => !b.dataset.fit));
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
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
    const people = (await chrome.storage.local.get("follow_people")).follow_people || {};
    return (who = whoIndex(people, up.followed.size ? [...up.followed] : Object.keys(up.map)));
  }

  // A 动态 card's author: a data attribute up to the card, else its avatar file, else its name (each only when unique).
  function nameMid(el, idx) {
    const card = el.closest(".dyn-orig-author, .bili-dyn-item, .bili-dyn-list__item");
    let data = "";
    for (let n = el; n?.nodeType === 1 && !data; n = n === card ? null : n.parentNode) data = n.getAttribute("data-mid") || n.getAttribute("data-uid") || "";
    const face = card?.querySelector('img[src*="/bfs/face/"]')?.getAttribute("src");
    return resolveMid({ data, face, name: el.textContent }, idx);
  }

  async function markUps() {
    const owner = pageOwner();
    const spots = [];
    for (const a of findAll(UP_SEL)) {
      const mid = midFromHref(a.getAttribute("href"));
      // On a space page the owner's own links (its video cards) would all say the same thing; the nickname carries it.
      const spot = mid && mid !== owner ? spotIn(a) : null;
      if (!spot) continue;
      // The video page's UP name: its tags get their own line under the name row.
      const row = a.classList.contains("up-name") && a.closest(".up-detail-top");
      spots.push(row ? [row, mid, SURFACES.owner, spot.textContent] : [spot, mid, ruleFor(a)]);
    }
    // The nickname only on the space's own pages: its 收藏夹 page shows no UP tags.
    if (owner) for (const el of findAll(OWNER_SEL)) spots.push([el, owner, surface === "space" ? SURFACES.owner : SURFACES.fav]);
    const nameEls = findAll(NAME_SEL);
    const idx = nameEls.length ? await whoIs() : null;
    const byEl = new Map(nameEls.map((el) => [el, nameMid(el, idx)]));
    for (const [el, mid] of byEl) spots.push([el, mid, ruleFor(el)]);
    const writes = spots.map(([spot, mid, rule, name]) => upChip(spot, mid, rule, name));
    if (onFeed()) writes.push(...feedFilter(byEl));
    for (const w of writes) w?.();
  }

  // Keeps, replaces or removes the box right after `spot`; the DOM itself is the state, so a rerun changes nothing.
  // Where the page shows 「+ UP 标签」, a followed UP (or one with tags) gets it; on cards CSS shows it on hover only.
  function upChip(spot, mid, rule, name) {
    const list = rule.ups ? upTagsOf(mid, up.tags, up.map) : [];
    const plus = rule.ups && rule.plus && Boolean(mid) && (list.length > 0 || up.followed.has(mid)) ? rule.plus : "";
    const next = spot.nextSibling;
    const old = next?.nodeType === 1 && next.classList.contains("mdg-ups") ? next : null;
    const key = list.length || plus ? `${mid}|${plus}|${list.map((t) => `${t.id}:${t.name}:${t.color}`).join(",")}` : "";
    if ((old?.dataset.key || "") === key) return;
    return () => {
      old?.remove();
      if (key) spot.after(upChipEl(spot, mid, list, key, plus, String(name ?? spot.textContent ?? "").trim()));
    };
  }

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
    more.setAttribute("aria-label", `全部标签：${more.dataset.names}`);
    more.textContent = `+${list.length}`;
    box.append(more);
  }

  function upChipEl(spot, mid, list, key, plus, name) {
    const box = document.createElement("span");
    box.className = `mdg-ups${list.length ? "" : " mdg-ups-empty"}${plus ? ` mdg-plus-${plus}` : ""}${spot.classList?.contains("up-detail-top") ? " mdg-ups-line" : ""}`;
    box.dataset.mid = mid;
    box.dataset.key = key;
    box.title = "MoonDigest 的 UP 标签 · 只存在扩展里";
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
      add.setAttribute("aria-label", `给 ${name} 打 UP 标签`);
      add.title = "给这个 UP 打标签 · 只存在扩展里，不改 B站";
      add.textContent = "+ UP 标签";
      box.append(add);
    }
    return box;
  }

  // The 全部 / per-tag bar above the 动态 list. A pick only adds a class to other UPs' cards, so Bilibili's own tabs,
  // its UP avatar strip and infinite scroll keep working, and newly loaded cards are filtered on the next scan.
  function feedFilter(byEl) {
    const list = document.querySelector(".bili-dyn-list");
    if (!list) return [];
    const items = [...document.querySelectorAll(".bili-dyn-list__item")];
    let sel = readFilter();
    if (sel && !up.tags.some((t) => t.id === sel)) sel = "";
    const mids = items.map((it) => byEl.get(it.querySelector(".bili-dyn-title__text")) || "");
    const counts = upCounts(mids, up.tags, up.map);
    const writes = items.map((it, i) => {
      const hide = upHidden(mids[i], sel, up.map);
      return hide !== it.classList.contains("mdg-up-hide") ? () => it.classList.toggle("mdg-up-hide", hide) : null;
    });
    // No UP tags yet: only the 「+」s, no bar.
    if (!up.tags.length) return writes;
    const bar = document.querySelector(".mdg-upbar");
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
    bar.title = "MoonDigest 的 UP 标签 · 只存在扩展里";
    const brand = document.createElement("span");
    brand.className = "mdg-brand";
    brand.textContent = "MoonDigest";
    bar.append(brand);
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
    resizes?.disconnect();
    findAll(".mdg-ups, .mdg-upbar").forEach((n) => n.remove());
    document.querySelectorAll(".mdg-up-hide").forEach((n) => n.classList.remove("mdg-up-hide"));
  }

  // Tag chips are not controls (they sit inside the author's link like the name). Only 「+ UP 标签」 acts: it opens the
  // tag picker instead of the space page. Events from BewlyCat's shadow root reach the document retargeted to #bewly;
  // composedPath has the button.
  function onChip(e) {
    if (globalThis.BocTyping.composing(e) || globalThis.BocTyping.typingIn(e)) return;
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    const add = (e.composedPath?.() || []).find((n) => n.classList?.contains("mdg-up-add"));
    if (!add || !chrome.runtime?.id) return;
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
.pick { --bg: #fff; --text: #18191c; --muted: #9499a0; --line: #e3e5e7; --hover: #f1f2f3; --accent: #7c3ed1; --link: #00aeec;
  position: fixed; z-index: 2147483000; box-sizing: border-box; width: 270px; max-height: calc(100vh - 16px); overflow: auto;
  padding: 10px 8px 8px; border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 8px;
  background: var(--bg); color: var(--text); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.14); text-align: left;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
.pick.dark { --bg: #232527; --text: #e3e5e7; --muted: #8d9198; --line: #3a3d42; --hover: #303236; --accent: #cba6f7; --link: #4fc3f7;
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
    panel.setAttribute("aria-label", `给「${add.dataset.name}」打 UP 标签`);
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

  function renderPick() {
    if (!pick) return;
    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const was = pick.root.activeElement;
    const focus = pick.focus ?? (was?.dataset?.id || (was?.classList?.contains("opt") ? "new" : was ? "input" : null));
    pick.focus = null;
    const rows = pickRows(pick.mid, up.tags, up.map);
    const list = el("div", "list");
    list.setAttribute("role", "menu");
    for (const r of rows) {
      const b = el("button", "opt");
      b.type = "button";
      b.dataset.id = r.id;
      b.setAttribute("role", "menuitemcheckbox");
      b.setAttribute("aria-checked", String(r.on));
      const dot = el("span", "dot");
      if (r.color) dot.style.setProperty("--c", r.color);
      b.append(el("span", "ck", r.on ? "✓" : ""), dot, el("span", "nm", r.name));
      list.append(b);
    }
    if (!rows.length) list.append(el("div", "empty", "还没有 UP 标签"));
    const more = el("div", "new");
    if (pick.editing) {
      const input = el("input");
      input.type = "text";
      input.maxLength = 12;
      input.placeholder = "标签名，回车新建";
      input.setAttribute("aria-label", "新标签名");
      more.append(input);
    } else {
      const b = el("button", "opt");
      b.type = "button";
      b.dataset.new = "";
      b.append(el("span", "ck", "+"), el("span", "nm", "新建标签"));
      more.append(b);
    }
    // The chips no longer open the 分拣台; this is the one way there from a B站 page.
    const go = el("button", "go", "在分拣台「关注」里管理 UP 标签 ↗");
    go.type = "button";
    pick.panel.replaceChildren(el("div", "h", `给「${pick.add.dataset.name}」打标签`), list, more, go, el("div", "foot", "只存在 MoonDigest 里，不改 B站 · Esc 关闭"));
    placePick();
    const again = focus === "input" || focus === "new" ? more.firstChild : [...pickFocusables()].find((b) => b.dataset.id === focus);
    if (focus) (again || pickFocusables()[0])?.focus();
  }

  // Under the 「+」 where it was when opened (it moves as chips are added), above it when there is no room below.
  function placePick() {
    const r = pick.rect;
    const w = pick.panel.offsetWidth || 270;
    const h = pick.panel.offsetHeight || 0;
    pick.panel.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    pick.panel.style.top = `${r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  }

  const pickFocusables = () => (pick ? pick.panel.querySelectorAll(".opt, input, .go") : []);

  function onPickKey(e) {
    if (globalThis.BocTyping.composing(e)) return; // Enter picks the IME candidate, Esc cancels the composition
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
    if (e.target.closest?.(".go")) {
      const hash = `follow&up=${pick.mid}`;
      closePick(false);
      if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: "triage-open", hash }).catch(() => {});
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
    if (!pick || !chrome.runtime?.id) return;
    const r = await saveUpTag(chrome.storage.local, pick.mid, op).catch(() => null);
    if (!r) return;
    up = { ...up, tags: r.tags, map: r.map };
    upOn = true;
    if (pick) {
      pick.editing = false;
      pick.focus = r.id;
    }
    renderPick();
    run().catch(() => {});
  }

  async function loadUps() {
    const got = await chrome.storage.local.get(["follow_tags", "follow_tag_map", "follow_list"]);
    const list = got.follow_list?.list;
    up = { tags: Array.isArray(got.follow_tags) ? got.follow_tags : [], map: got.follow_tag_map || {}, followed: new Set(Array.isArray(list) ? list.map(String) : []) };
    who = null;
    // Tags to show, or followed UPs to offer 「+ UP 标签」 for, and the setting 「在 B站页面显示 UP 标签」 on.
    upHas = (up.tags.length > 0 && Object.values(up.map).some((ids) => ids?.length)) || up.followed.size > 0;
    upOn = upSetting && upHas;
    // A follow sync must not rebuild the picker under a tag name being typed; its own write redraws it.
    if (!upOn) clearUps();
    else if (!pick?.editing) renderPick();
    setEnabled(triageOn || seenCfg.on || upOn);
    schedule();
  }

  async function markVideos(g) {
    // Most Bilibili iframes hold no video link: nothing to mark, so no storage reads.
    if (!pageBvid() && !findAll(SEL).length) return;
    const fid = favFid();
    if (seenCfg.on) await loadSeen(g);
    if (g !== gen) return;
    if (!triageOn) {
      const writes = findAll(SEL).map(markCover);
      for (const w of writes) w?.();
      return;
    }
    if (!shared || fid !== sharedFid) {
      // A favorites page shows its own folder's decisions; elsewhere every folder's decisions are merged.
      // getKeys is Chrome 130+; before that only 保留 shows outside a favorites page.
      const all = fid ? [] : (await chrome.storage.local.getKeys?.()) || [];
      const decisionKeys = ["triage_kept", ...(fid ? [`triage_decisions_${fid}`] : all.filter((k) => k.startsWith("triage_decisions_")))];
      const got = await chrome.storage.local.get(["triage_tags", "triage_video_tags", ...decisionKeys]);
      if (g !== gen) return;
      sharedFid = fid;
      shared = { tags: got.triage_tags, videoTags: got.triage_video_tags || {}, decisions: mergeDecisions(got) };
      cache.clear();
    }
    const anchors = findAll(SEL);
    const here = pageBvid();
    const want = new Set(anchors.map((a) => bvidFromHref(a.getAttribute("href"))).concat(here).filter((b) => b && !cache.has(b)));
    if (want.size) {
      const keys = [...want].flatMap((b) => [`triage_title_${b}`, `triage_analysis_${b}`]);
      const got = await chrome.storage.local.get(keys);
      if (g !== gen) return;
      for (const b of want) {
        cache.set(
          b,
          badgeInfo({
            title: got[`triage_title_${b}`],
            analysis: got[`triage_analysis_${b}`],
            tagIds: shared.videoTags[b],
            tags: shared.tags,
            decision: shared.decisions[b]
          })
        );
      }
    }
    if (!enabled) return;
    // Every style read first, then every DOM write, so the page recalculates styles once rather than per card.
    const writes = anchors.flatMap((a) => [markAnchor(a), markCover(a)]);
    for (const w of writes) w?.();
    markVideoLine(here);
  }

  // One key per video on screen, a few KB per page; the history itself is read by the background (triage-seen-sync).
  async function loadSeen(g) {
    const want = [...new Set(findAll(SEL).map((a) => bvidFromHref(a.getAttribute("href"))).filter((b) => b && !seenCache.has(b)))];
    if (!want.length) return;
    const got = await chrome.storage.local.get(want.map((b) => `seen_${b}`));
    if (g !== gen) return;
    for (const b of want) seenCache.set(b, got[`seen_${b}`]?.[0] || 0);
  }

  // The progress bar (Bilibili's own look) on a cover link, and once 看完了 the corner tag or the veil.
  // Reads only; returns the DOM write for run() to apply after every card is read.
  function markCover(a) {
    const b = bvidFromHref(a.getAttribute("href"));
    const rule = ruleFor(a);
    const known = seenCfg.on ? seenCache.get(b) || 0 : 0;
    const pct = seenCfg.bar ? known : 0;
    // Popovers get the bar only. Where B站 itself says 已看完, ours would say it twice.
    const mark = seenCfg.mark && !rule.bare;
    const seen = mark && known >= seenCfg.threshold && !biliSaysSeen(a);
    // Below the share, a faint 看到 N% says how far it got; not on 稍后再看 / 历史 / UP 空间, where it covered most covers.
    const faint = mark && !rule.quiet && known > 0 && known < seenCfg.threshold;
    const style = rule.quiet ? "badge" : seenCfg.style;
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
    // 100% reads 看完了, otherwise 看到 N%; ✓ (and the strong look) means it counts as 看完了.
    const words = known >= 100 ? "✓ 看完了" : seen ? `✓ 看到 ${known}%` : `看到 ${known}%`;
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
    if (!info) return;
    const tags = rule.vtags ? info.tags : [];
    // Nothing this page shows (a tagged video without a verdict in a popover): no mark at all.
    if (!info.label && !tags.length) return;
    const badge = badgeEl(info, b, tags);
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

  // ---- Fitting: a group shows as many whole chips as its room holds, then 「+N」 (DESIGN §8). Measured after layout,
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
  const resizes = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    if (refitFrame) return;
    refitFrame = requestAnimationFrame(() => {
      refitFrame = 0;
      fitBoxes(findAll(".mdg-badge, .mdg-ups").filter((b) => b.dataset.fit));
    });
  }) : null;

  function markVideoLine(bvid) {
    const old = document.querySelector(".mdg-line");
    const info = cache.get(bvid);
    if (old && old.dataset.bvid === bvid && info) return;
    old?.remove();
    if (!info) return;
    // Below the views / danmaku / date row; the title alone when that row isn't there.
    const anchor = document.querySelector(".video-info-meta") || document.querySelector(".video-info-title") || document.querySelector("h1.video-title");
    if (!anchor) return;
    const line = document.createElement("div");
    line.className = "mdg-line";
    line.dataset.bvid = bvid;
    const brand = document.createElement("span");
    brand.className = "mdg-brand";
    brand.textContent = "MoonDigest";
    line.append(brand, badgeEl(info, bvid, info.tags));
    const text = info.oneLiner || info.reason;
    if (text) {
      const s = document.createElement("span");
      s.className = "mdg-one";
      s.textContent = text;
      line.append(s);
    }
    anchor.after(line);
  }

  // The AI's reasons on a verdict, or every tag of a group on its 「+N」.
  function showPop(host) {
    const add = (tag, cls, text) => {
      const n = document.createElement(tag);
      n.className = cls;
      n.textContent = text;
      return n;
    };
    let at = host;
    const rows = [];
    if (host.classList.contains("mdg-more")) {
      rows.push(add("div", "mdg-pop-head", "全部标签"), add("div", "mdg-pop-one", host.dataset.names));
    } else {
      at = host.matches(".mdg-line") ? host.querySelector(".mdg-badge") : host;
      const info = cache.get(at?.dataset.bvid);
      if (!info || (!info.reason && !info.oneLiner)) return;
      rows.push(add("div", "mdg-pop-head", info.aria));
      if (info.oneLiner) rows.push(add("div", "mdg-pop-one", info.oneLiner));
      for (const p of info.points) rows.push(add("div", "mdg-pop-pt", `• ${p}`));
      if (info.reason) rows.push(add("div", "mdg-pop-reason", `理由：${info.reason}`));
    }
    pop ||= Object.assign(document.createElement("div"), { className: "mdg-pop", role: "tooltip" });
    pop.replaceChildren(...rows);
    document.body.append(pop);
    const r = at.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    pop.style.top = `${r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
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
    resizes?.disconnect();
    findAll(".mdg-badge, .mdg-line, .mdg-seen").forEach((n) => n.remove());
    findAll(".mdg-seen-host").forEach((n) => n.classList.remove("mdg-seen-host"));
  }

  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    if (on) {
      observer.observe(document.documentElement, OBSERVE);
      document.addEventListener("mouseover", onOver, true);
      document.addEventListener("focusin", onFocus, true);
      document.addEventListener("focusout", hidePop, true);
      document.addEventListener("click", onChip, true);
      document.addEventListener("keydown", onChip, true);
      schedule();
    } else {
      observer.disconnect();
      bewlyHooked = null;
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("focusout", hidePop, true);
      document.removeEventListener("click", onChip, true);
      document.removeEventListener("keydown", onChip, true);
      clearTimeout(timer);
      timer = 0;
      clearMarks();
      clearUps();
    }
  }

  // The three switches and the 观看进度 options decide whether the page is scanned at all.
  function applySettings(v) {
    triageOn = v[SETTING] !== false;
    const before = seenCfg.on;
    const bar = v.seenShow === "bar" || v.seenShow === "both";
    const mark = v.seenShow === "mark" || v.seenShow === "both";
    seenCfg = { on: bar || mark, bar, mark, threshold: Number(v.seenThreshold) || 80, style: v.seenStyle === "veil" ? "veil" : "badge" };
    // Turning it off clears the stored history (triage-bg.js), so a later re-enable starts from a fresh read.
    if (!seenCfg.on) seenCache.clear();
    markBewly();
    // Only the top frame asks; the background reads what is new at most every 10 minutes.
    if (seenCfg.on && !before && window === window.top) chrome.runtime.sendMessage({ type: "triage-seen-sync" }).catch(() => {});
    upSetting = v[UP_SETTING] !== false;
    const wasUp = upOn;
    upOn = upSetting && upHas;
    if (wasUp && !upOn) clearUps();
    const on = triageOn || seenCfg.on || upOn;
    if (on && enabled) {
      gen++;
      clearMarks();
      schedule();
    } else setEnabled(on);
  }
  const readSettings = () => chrome.storage.sync.get({ [SETTING]: true, [UP_SETTING]: true, ...SEEN_DEFAULTS }).then(applySettings).catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.follow_tags || changes.follow_tag_map || changes.follow_list)) loadUps().catch(() => {});
    else if (area === "local" && changes.follow_people && upOn) {
      who = null;
      schedule();
    }
    if (area === "sync" && (SETTING in changes || UP_SETTING in changes || Object.keys(SEEN_DEFAULTS).some((k) => k in changes))) readSettings();
    if (area === "local" && enabled && Object.keys(changes).some((k) => k.startsWith("seen_"))) {
      for (const k of Object.keys(changes)) if (k.startsWith("seen_")) seenCache.delete(k.slice(5));
      gen++;
      schedule();
    }
    if (area === "local" && enabled && triageOn && Object.keys(changes).some(isSharedKey)) {
      gen++;
      shared = null;
      clearMarks();
      schedule();
    } else if (area === "local" && enabled && triageOn) {
      const changed = Object.keys(changes).map((k) => /^triage_(?:title|analysis)_(BV[0-9A-Za-z]{10})$/.exec(k)?.[1]).filter(Boolean);
      if (!changed.length) return;
      gen++;
      for (const b of changed) {
        cache.delete(b);
        findAll(`.mdg-badge[data-bvid="${b}"], .mdg-line[data-bvid="${b}"]`).forEach((n) => n.remove());
      }
      schedule();
    }
  });
  readSettings();
  loadUps().catch(() => {});
})();
