// What each kind of B站 page shows (DESIGN §8), shared by badges.js and the settings page's table. Pure data, no DOM.
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
    space: { vtags: true, ups: false, plus: "" }, // the owner's nickname is `owner`
    owner: { vtags: false, ups: true, plus: "always", novideo: true, names: true }, // the video page's UP name, a space page's nickname
    video: { vtags: true, ups: true, plus: "" }, // recommendations and lists beside a video
    popover: { vtags: true, ups: true, plus: "", tight: true }, // header popovers (B站 and BewlyCat)
    popfeed: { vtags: false, ups: true, plus: "", tight: true, novideo: true } // the header's 动态 popover
  };
  // The settings page's table: a row per surface, a column per kind of mark.
  const ROWS = {
    card: "首页、搜索",
    fav: "收藏夹页",
    later: "稍后再看",
    history: "历史",
    feed: "动态页",
    space: "UP 空间的视频卡",
    owner: "视频页和 UP 空间的 UP 名字",
    video: "视频页右侧推荐",
    popover: "顶栏弹窗（收藏、历史、稍后再看）",
    popfeed: "顶栏动态弹窗"
  };
  const COLS = { verdict: "AI 判断", vtags: "视频标签", ups: "UP 标签", plus: "「+ UP 标签」", seen: "看到哪里" };
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
  // Each surface's rule with the cells turned off.
  function rulesWith(off) {
    const no = new Set(normalizeOff(off));
    const on = (key, col) => allowed(key, col) && !no.has(`${key}.${col}`);
    return Object.fromEntries(
      Object.entries(SURFACES).map(([key, r]) => [
        key,
        { ...r, verdict: on(key, "verdict"), vtags: on(key, "vtags"), ups: on(key, "ups"), plus: on(key, "plus") ? r.plus : "", seen: on(key, "seen") }
      ])
    );
  }

  globalThis.BocSurfaces = { SURFACES, ROWS, COLS, allowed, normalizeOff, rulesWith };
})();
