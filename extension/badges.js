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

  globalThis.BocBadges = { bvidFromHref, badgeInfo, mergeDecisions };
  if (typeof chrome === "undefined" || !chrome.storage?.local || typeof document === "undefined") return;

  const SETTING = "showBiliTriageBadges";
  // 看过 marks on covers have their own switch (设置页, off by default); either one turns the page scan on.
  const SEEN_DEFAULTS = { seenBar: false, seenMark: false, seenThreshold: 80, seenStyle: "badge" };
  let triageOn = false;
  let seenCfg = { on: false, bar: false, mark: false, threshold: 80, style: "badge" };
  const seenCache = new Map(); // bvid -> percent | 0
  let watched = null; // 手动标的看过 (triage_watched)
  const SEL = 'a[href*="/video/BV"], a[href*="bvid=BV"]';
  const isTriageKey = (k) =>
    k === "triage_tags" || k === "triage_video_tags" || k === "triage_kept" || /^triage_(title|analysis|decisions)_/.test(k);
  const isFavPage = location.hostname === "space.bilibili.com";

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

  const favFid = () => (isFavPage ? new URLSearchParams(location.search).get("fid") || "" : "");
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
      const fid = favFid();
      if (seenCfg.on) await loadSeen(g);
      if (g !== gen) return;
      if (!triageOn) {
        for (const a of document.querySelectorAll(SEL)) markCover(a);
        return;
      }
      if (!shared || fid !== sharedFid) {
        // A favorites page shows its own folder's decisions; elsewhere every folder's decisions are merged.
        // getKeys (Chrome 130+) avoids reading every cached title and analysis just to find the decision keys.
        const all = fid ? null : await chrome.storage.local.getKeys?.();
        const decisionKeys = ["triage_kept", ...(fid ? [`triage_decisions_${fid}`] : (all || []).filter((k) => k.startsWith("triage_decisions_")))];
        const got = await chrome.storage.local.get(fid || all ? ["triage_tags", "triage_video_tags", ...decisionKeys] : null);
        if (g !== gen) return;
        sharedFid = fid;
        shared = { tags: got.triage_tags, videoTags: got.triage_video_tags || {}, decisions: mergeDecisions(got) };
        cache.clear();
      }
      const anchors = [...document.querySelectorAll(SEL)];
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
      for (const a of anchors) {
        markAnchor(a);
        markCover(a);
      }
      markVideoLine(here);
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  }

  // One key per video on screen, a few KB per page; the history itself is read by the background (triage-seen-sync).
  async function loadSeen(g) {
    const want = [...new Set([...document.querySelectorAll(SEL)].map((a) => bvidFromHref(a.getAttribute("href"))).filter((b) => b && !seenCache.has(b)))];
    if (!want.length && watched) return;
    const got = await chrome.storage.local.get([...want.map((b) => `seen_${b}`), ...(watched ? [] : ["triage_watched"])]);
    if (g !== gen) return;
    watched ||= got.triage_watched || {};
    for (const b of want) seenCache.set(b, got[`seen_${b}`]?.[0] || 0);
  }

  // The progress bar (Bilibili's own look) on a cover link, and once 看过 the corner tag or the veil.
  function markCover(a) {
    const b = bvidFromHref(a.getAttribute("href"));
    const known = seenCfg.on ? seenCache.get(b) || 0 : 0;
    const pct = seenCfg.bar ? known : 0;
    const seen = seenCfg.mark && (Boolean(watched?.[b]) || known >= seenCfg.threshold);
    // On the image's own box: some links wrap the whole card, title included.
    const media = a.querySelector("picture") || a.querySelector("img");
    const host = media?.parentElement;
    if (!host) return;
    const old = host.querySelector(":scope > .mdg-seen");
    const key = `${b}|${pct}|${seen}|${known}|${seenCfg.style}`;
    if (old?.dataset.key === key) return;
    old?.remove();
    if (!pct && !seen) return;
    const box = document.createElement("span");
    box.className = `mdg-seen mdg-seen-${seenCfg.style}`;
    box.dataset.key = key;
    const label = known >= 100 ? "✓ 看完了" : known >= seenCfg.threshold ? `✓ 看过 ${known}%` : "✓ 看过";
    if (seen) box.append(Object.assign(document.createElement("span"), { className: "mdg-seen-mark", textContent: label }));
    // Bilibili's history and 稍后再看 cards draw this bar themselves.
    if (pct && !host.querySelector(".bili-cover-card__progress")) {
      const bar = Object.assign(document.createElement("span"), { className: "mdg-seen-bar" });
      bar.append(Object.assign(document.createElement("i"), { style: `width:${Math.max(pct, 2)}%` }));
      box.append(bar);
    }
    if (getComputedStyle(host).position === "static") host.classList.add("mdg-seen-host");
    host.append(box);
  }

  function markAnchor(a) {
    const b = bvidFromHref(a.getAttribute("href"));
    const info = cache.get(b);
    const old = a.querySelector(".mdg-badge");
    if (old && old.dataset.bvid === b && info) return;
    old?.remove();
    if (!info) return;
    const target = titleBox(a);
    if (!target) return;
    // Favorites pages show every user tag; elsewhere a tag chip appears only when there is no verdict.
    const tags = isFavPage ? info.tags : info.label ? [] : info.tags.slice(0, 1);
    const badge = badgeEl(info, b, tags);
    // Some titles hang their opening bracket with a negative text-indent, which would clip the badge.
    const indent = parseFloat(getComputedStyle(target).textIndent);
    if (indent < 0) badge.style.marginLeft = `${-indent}px`;
    target.prepend(badge);
  }

  // The block that holds the title's first text, so the badge sits inline before the title words.
  function titleBox(a) {
    const root = a.querySelector('[class*="title"]') || (!a.querySelector("img, picture") && a);
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
      v.className = `mdg-v mdg-${info.action ? `act-${info.action}` : info.verdict}${info.stage === 1 ? " mdg-s1" : ""}${info.low ? " mdg-low" : ""}`;
      v.textContent = info.label;
      el.append(v);
    }
    for (const t of tags) {
      const c = document.createElement("span");
      c.className = "mdg-chip";
      if (t.color) c.style.setProperty("--mdg-c", t.color);
      c.textContent = t.name;
      el.append(c);
    }
    return el;
  }

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

  function showPop(host) {
    const badge = host.matches(".mdg-line") ? host.querySelector(".mdg-badge") : host;
    const info = cache.get(badge?.dataset.bvid);
    if (!info || (!info.reason && !info.oneLiner)) return;
    pop ||= Object.assign(document.createElement("div"), { className: "mdg-pop", role: "tooltip" });
    pop.replaceChildren();
    const add = (tag, cls, text) => {
      const n = document.createElement(tag);
      n.className = cls;
      n.textContent = text;
      return n;
    };
    pop.append(add("div", "mdg-pop-head", info.aria));
    if (info.oneLiner) pop.append(add("div", "mdg-pop-one", info.oneLiner));
    for (const p of info.points) pop.append(add("div", "mdg-pop-pt", `• ${p}`));
    if (info.reason) pop.append(add("div", "mdg-pop-reason", `理由：${info.reason}`));
    document.body.append(pop);
    const r = badge.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    pop.style.top = `${r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  }

  const hidePop = () => pop?.remove();
  const onOver = (e) => {
    const host = e.target.closest?.(".mdg-badge, .mdg-line");
    if (host) showPop(host);
    else if (pop?.isConnected) hidePop();
  };
  const onFocus = (e) => {
    const badge = e.target.closest?.(".mdg-badge") || e.target.querySelector?.(".mdg-badge");
    if (badge) showPop(badge);
    else hidePop();
  };

  function clearMarks() {
    hidePop();
    document.querySelectorAll(".mdg-badge, .mdg-line, .mdg-seen").forEach((n) => n.remove());
    document.querySelectorAll(".mdg-seen-host").forEach((n) => n.classList.remove("mdg-seen-host"));
  }

  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    if (on) {
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
      document.addEventListener("mouseover", onOver, true);
      document.addEventListener("focusin", onFocus, true);
      document.addEventListener("focusout", hidePop, true);
      schedule();
    } else {
      observer.disconnect();
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("focusout", hidePop, true);
      clearTimeout(timer);
      timer = 0;
      clearMarks();
    }
  }

  // The two switches and the 看过 options decide whether the page is scanned at all.
  function applySettings(v) {
    triageOn = v[SETTING] !== false;
    const before = seenCfg.on;
    const bar = v.seenBar === true;
    const mark = v.seenMark === true;
    seenCfg = { on: bar || mark, bar, mark, threshold: Number(v.seenThreshold) || 80, style: v.seenStyle === "veil" ? "veil" : "badge" };
    // Only the top frame asks; the background reads what is new at most every 10 minutes.
    if (seenCfg.on && !before && window === window.top) chrome.runtime.sendMessage({ type: "triage-seen-sync" }).catch(() => {});
    const on = triageOn || seenCfg.on;
    if (on && enabled) {
      gen++;
      clearMarks();
      schedule();
    } else setEnabled(on);
  }
  const readSettings = () => chrome.storage.sync.get({ [SETTING]: true, ...SEEN_DEFAULTS }).then(applySettings).catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && (SETTING in changes || Object.keys(SEEN_DEFAULTS).some((k) => k in changes))) readSettings();
    if (area === "local" && enabled && Object.keys(changes).some((k) => k.startsWith("seen_") || k === "triage_watched")) {
      for (const k of Object.keys(changes)) if (k.startsWith("seen_")) seenCache.delete(k.slice(5));
      if (changes.triage_watched) watched = changes.triage_watched.newValue || {};
      gen++;
      schedule();
    }
    if (area === "local" && enabled && triageOn && Object.keys(changes).some(isTriageKey)) {
      gen++;
      shared = null;
      clearMarks();
      schedule();
    }
  });
  readSettings();
})();
