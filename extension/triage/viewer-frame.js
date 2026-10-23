// Marks the video page (or the 番剧 page a 番剧's /video/ link lands on) when it is the triage viewer's iframe, so
// viewer-frame.css trims it to the player, the description and the comments; an UP's space (关注's UP name) is marked
// "space" and fitted to the frame's width. Pages opened any other way are left alone.
if (window !== window.top && location.ancestorOrigins?.[0] === `chrome-extension://${chrome.runtime.id}`) {
  document.documentElement.setAttribute("data-mdg-viewer", location.host === "space.bilibili.com" ? "space" : "");
  // While a video plays the keys go to this frame: T (tag the video, or its UP in 关注) and Esc go up to the 分拣台 page.
  const to = location.ancestorOrigins[0];
  addEventListener("keydown", (e) => {
    const key = viewerKey(e);
    if (key) window.parent.postMessage({ type: "mdg-viewer-key", key }, to);
  }, true);
  // B站's own autoplay can move to another video, in place (history.pushState) or by a reload: the 分拣台 follows the
  // video shown. The first tick reports the one loaded too; the page ignores the video it already plays.
  // A 番剧 (B站 sends its /video/ link to /bangumi/play/ep…) names no BV in its URL: the player is asked, until it answers
  // for this path, and again when it loads another video (the next episode).
  let shown = "";
  let asked = "";
  addEventListener("loadedmetadata", () => (asked = ""), true);
  setInterval(async () => {
    const path = location.pathname;
    let bvid = viewerBvid(path);
    if (!bvid && path.startsWith("/bangumi/play/") && path !== asked) {
      const resp = await chrome.runtime.sendMessage({ type: "page-player", ref: location.href }).catch(() => null);
      bvid = resp?.data?.id || "";
      if (bvid) asked = path;
    }
    if (path.startsWith("/bangumi/play/")) showViewerTitle();
    if (bvid && bvid !== shown) window.parent.postMessage({ type: "mdg-viewer-video", bvid }, to);
    shown = bvid || shown;
  }, 1000);
}

// A 番剧 page has no title above its player, and its 选集 column is hidden here: which episode plays goes above the
// player, as /video/'s title does. Re-added if B站 re-renders it away; follows the next episode with document.title.
function showViewerTitle() {
  const layout = document.querySelector(".plp-layout");
  const text = viewerTitleText(document.title, document.querySelector('meta[property="og:title"]')?.content);
  if (!layout || !text) return;
  let node = document.getElementById("mdg-viewer-title");
  if (!node) layout.before((node = Object.assign(document.createElement("h1"), { id: "mdg-viewer-title" })));
  if (node.textContent !== text) node.textContent = node.title = text;
}

// "季名 第N集" from a 番剧 page's title ("季名第N集-纪录片-全集-…", which B站 updates with the episode) and og:title (the
// season): what the page knows without a request. "" when the title is not that.
function viewerTitleText(title = "", season = "") {
  return season && title.startsWith(season) ? `${season} ${title.slice(season.length).split("-")[0]}`.trim() : "";
}

// The BV id of a /video/ path, or "".
function viewerBvid(path) {
  return /^\/video\/(BV[0-9A-Za-z]{10})/.exec(path)?.[1] || "";
}

// The 分拣台 key this keydown is, or "": never while typing (the danmaku box, the comment box inside B站's shadow
// roots) or composing, and Esc not while it is leaving full screen or 网页全屏.
function viewerKey(e) {
  if (MdgTyping.composing(e) || MdgTyping.typingIn(e) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return "";
  if (e.key === "Escape") return document.fullscreenElement || document.querySelector(".bpx-player-container[data-screen=web]") ? "" : "Escape";
  return e.key === "t" || e.key === "T" ? "t" : "";
}
