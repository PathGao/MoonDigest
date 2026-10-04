// Read-only triage marks on Bilibili pages. Videos without triage data get zero DOM changes.
(() => {
  const VERDICT = {
    keep: ["留", "建议留"],
    drop: ["删?", "建议删"],
    unsure: ["待定", "待定"]
  };
  const ACTION = { keep: "已保留", unfav: "已取消收藏" };
  const STAGE = ["", "标题粗分", "字幕细看", "AI 指令"];
  const BVID_RE = /(?:\/video\/|[?&]bvid=)(BV[0-9A-Za-z]{10})/;

  function bvidFromHref(href) {
    return BVID_RE.exec(String(href || ""))?.[1] || "";
  }

  // Same precedence as verdictOf in triage/triage.js: override > stage-2 analysis > stage-1 title result.
  function badgeInfo({ title, analysis, override, tagIds, tags, decision } = {}) {
    const done = analysis?.status === "done";
    let v = null;
    if (override?.verdict) v = { verdict: override.verdict, reason: override.reason, stage: 3 };
    else if (done) v = { verdict: analysis.verdict, reason: analysis.reason, stage: 2 };
    else if (title?.verdict) v = { verdict: title.verdict, reason: title.reason, stage: 1, low: title.confidence === "low" };
    if (v && !VERDICT[v.verdict]) v = null;
    const byId = new Map((Array.isArray(tags) ? tags : []).map((t) => [t.id, t]));
    const userTags = (Array.isArray(tagIds) ? tagIds : [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((t) => ({ name: String(t.name || ""), color: String(t.color || "") }));
    const action = ACTION[decision?.action] ? decision.action : "";
    if (!v && !userTags.length && !action) return null;

    const label = action ? ACTION[action] : v ? VERDICT[v.verdict][0] : "";
    const aria = [
      "MoonDigest 分拣",
      action && ACTION[action],
      v && `${VERDICT[v.verdict][1]}（${STAGE[v.stage]}${v.low ? "，低置信" : ""}）`,
      userTags.length && `标签：${userTags.map((t) => t.name).join("、")}`
    ]
      .filter(Boolean)
      .join("，");
    return {
      label,
      aria,
      verdict: v?.verdict || "",
      stage: v?.stage || 0,
      low: Boolean(v?.low),
      action,
      reason: String(v?.reason || ""),
      oneLiner: done ? String(analysis.oneLiner || "") : "",
      points: done ? (analysis.points || []).map(String).filter(Boolean) : [],
      tags: userTags
    };
  }

  globalThis.BocBadges = { bvidFromHref, badgeInfo };
  if (typeof chrome === "undefined" || !chrome.storage?.local || typeof document === "undefined") return;

  const SETTING = "showBiliTriageBadges";
  const SEL = 'a[href*="/video/BV"], a[href*="bvid=BV"]';
  const isTriageKey = (k) =>
    k === "triage_tags" || k === "triage_video_tags" || /^triage_(title|analysis|verdict_override|decisions)_/.test(k);
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
      if (!shared || fid !== sharedFid) {
        // A favorites page shows its own folder's decisions; elsewhere every folder's decisions are merged.
        // getKeys (Chrome 130+) avoids reading every cached title and analysis just to find the decision keys.
        const all = fid ? null : await chrome.storage.local.getKeys?.();
        const decisionKeys = fid ? [`triage_decisions_${fid}`] : (all || []).filter((k) => k.startsWith("triage_decisions_"));
        const got = await chrome.storage.local.get(fid || all ? ["triage_tags", "triage_video_tags", ...decisionKeys] : null);
        if (g !== gen) return;
        sharedFid = fid;
        const decisions = {};
        for (const [k, v] of Object.entries(got)) if (k.startsWith("triage_decisions_")) Object.assign(decisions, v);
        shared = { tags: got.triage_tags, videoTags: got.triage_video_tags || {}, decisions };
        cache.clear();
      }
      const anchors = [...document.querySelectorAll(SEL)];
      const here = pageBvid();
      const want = new Set(anchors.map((a) => bvidFromHref(a.getAttribute("href"))).concat(here).filter((b) => b && !cache.has(b)));
      if (want.size) {
        const keys = [...want].flatMap((b) => [`triage_title_${b}`, `triage_analysis_${b}`, `triage_verdict_override_${b}`]);
        const got = await chrome.storage.local.get(keys);
        if (g !== gen) return;
        for (const b of want) {
          cache.set(
            b,
            badgeInfo({
              title: got[`triage_title_${b}`],
              analysis: got[`triage_analysis_${b}`],
              override: got[`triage_verdict_override_${b}`],
              tagIds: shared.videoTags[b],
              tags: shared.tags,
              decision: shared.decisions[b]
            })
          );
        }
      }
      if (!enabled) return;
      for (const a of anchors) markAnchor(a);
      markVideoLine(here);
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
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
    const title = document.querySelector(".video-info-title") || document.querySelector("h1.video-title");
    if (!title) return;
    const line = document.createElement("div");
    line.className = "mdg-line";
    line.dataset.bvid = bvid;
    line.append(badgeEl(info, bvid, info.tags));
    const text = info.oneLiner || info.reason;
    if (text) {
      const s = document.createElement("span");
      s.className = "mdg-one";
      s.textContent = text;
      line.append(s);
    }
    title.after(line);
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
    document.querySelectorAll(".mdg-badge, .mdg-line").forEach((n) => n.remove());
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

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && SETTING in changes) setEnabled(changes[SETTING].newValue !== false);
    if (area === "local" && enabled && Object.keys(changes).some(isTriageKey)) {
      gen++;
      shared = null;
      clearMarks();
      schedule();
    }
  });
  chrome.storage.sync
    .get({ [SETTING]: true })
    .then((s) => setEnabled(s[SETTING] !== false))
    .catch(() => {});
})();
