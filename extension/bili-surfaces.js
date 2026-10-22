// What each kind of B站 page shows (DESIGN 产品决策 · B站 页面上的标记), shared by badges.js and the settings page's table,
// and the 观看进度 settings and words that B站 pages and the 分拣台 (triage.html) both draw. Pure data, no DOM.
(() => {
  // vtags: video tags after the AI verdict; ups: UP tags after author names; plus: when 「+ UP 标签」 shows; above: video
  // marks get their own line above the title; novideo: no video marks at all (new videos, never triaged); names: author
  // names only, no covers; corner: the corner tag, never the veil; tight: small covers, so 看到 N% drops its ✓.
  const SURFACES = {
    card: { vtags: true, ups: true, plus: "hover" }, // home and search (B站 and BewlyCat)
    fav: { vtags: true, ups: false, plus: "", above: true },
    later: { vtags: true, ups: true, plus: "hover" }, // 稍后再看
    history: { vtags: true, ups: true, plus: "hover", corner: true }, // 历史
    feed: { vtags: false, ups: true, plus: "hover", novideo: true }, // 动态
    space: { vtags: true, ups: false, plus: "" }, // the owner's nickname is `nick`
    owner: { vtags: false, ups: true, plus: "always", novideo: true, names: true }, // the video page's UP name
    nick: { vtags: false, ups: true, plus: "always", novideo: true, names: true }, // a space page's nickname
    video: { vtags: true, ups: true, plus: "" }, // recommendations and lists beside a video
    popover: { vtags: true, ups: true, plus: "", tight: true }, // header popovers (B站 and BewlyCat)
    popfeed: { vtags: false, ups: true, plus: "", tight: true, novideo: true } // the header's 动态 popover
  };
  // The settings page's table: a row per surface, a column per kind of mark. Most met first: the home page, its header
  // popovers and 动态, then the video page, then the pages one goes to on purpose.
  const ROWS = {
    card: "首页、搜索和其他页面", // every page without a row of its own (热门, 分区, 番剧 …)
    popover: "顶栏弹窗（收藏、历史、稍后再看）",
    popfeed: "顶栏动态弹窗",
    feed: "动态页（UP 标签含筛选条）",
    video: "视频页的推荐、合集和播放列表",
    owner: "视频页 UP 名字",
    fav: "收藏夹页",
    later: MdgErrors.LABEL.watchLater,
    history: "历史",
    nick: "UP 空间的 UP 名字",
    space: "UP 空间的视频卡"
  };
  const { LABEL } = MdgErrors;
  const COLS = { verdict: LABEL.aiVerdict, vtags: LABEL.videoTags, ups: "UP 标签", plus: "「+ UP 标签」", seen: LABEL.seen };
  // Which cells a surface offers; the others are not for the user to turn on.
  function allowed(key, col) {
    const r = SURFACES[key];
    if (!r || !(col in COLS)) return false;
    if (col === "verdict") return !r.novideo;
    if (col === "vtags") return r.vtags && !r.novideo;
    if (col === "seen") return !r.names;
    return Boolean(r[col]);
  }
  // The stored setting: the "surface.col" cells turned off, only ones that exist.
  const normalizeOff = (list) => [...new Set((Array.isArray(list) ? list : []).filter((c) => typeof c === "string" && allowed(...c.split("."))))];
  // Each surface's rule with the cells turned off, and the columns whose switch is off.
  function rulesWith(off, cols = []) {
    const no = new Set(normalizeOff(off));
    const on = (key, col) => allowed(key, col) && !no.has(`${key}.${col}`) && !cols.includes(col);
    return Object.fromEntries(
      Object.entries(SURFACES).map(([key, r]) => [
        key,
        { ...r, verdict: on(key, "verdict"), vtags: on(key, "vtags"), ups: on(key, "ups"), plus: on(key, "plus") ? r.plus : "", seen: on(key, "seen") }
      ])
    );
  }

  // 观看进度 (sync settings) and what they mean; defaults, range and parsing are settings.js's, which loads first.
  const SEEN_DEFAULTS = Object.freeze({ seenShow: MdgSettings.DEFAULTS.seenShow, seenThreshold: MdgSettings.DEFAULTS.seenThreshold, seenStyle: MdgSettings.DEFAULTS.seenStyle });
  function seenConfig(v) {
    const show = MdgSettings.normalizeSeenShow(v.seenShow);
    const bar = show === "bar" || show === "both";
    const mark = show === "mark" || show === "both";
    return { on: MdgSettings.seenOn(show), bar, mark, threshold: MdgSettings.normalizeSeenThreshold(v.seenThreshold), style: MdgSettings.normalizeSeenStyle(v.seenStyle) };
  }
  // 100% reads 看完了, otherwise 看到 N%; ✓ (and the strong look) means it counts as 看完了.
  const seenWords = (p, done) => (p >= 100 ? MdgErrors.LABEL.seenDone : done ? `✓ 看到 ${p}%` : `看到 ${p}%`);

  globalThis.MdgSurfaces = { SURFACES, ROWS, COLS, allowed, normalizeOff, rulesWith, SEEN_DEFAULTS, seenConfig, seenWords };
})();
