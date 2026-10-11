// Marks the video page when it is the triage viewer's iframe, so viewer-frame.css trims it to the
// player, the description and the comments. Pages opened any other way are left alone.
if (window !== window.top && location.ancestorOrigins?.[0] === `chrome-extension://${chrome.runtime.id}`) {
  document.documentElement.setAttribute("data-mdg-viewer", "");
  // While a video plays the keys go to this frame: T (tag the video, or its UP in 关注) and Esc go up to the 分拣台 page.
  const to = location.ancestorOrigins[0];
  addEventListener("keydown", (e) => {
    const key = viewerKey(e);
    if (key) window.parent.postMessage({ type: "mdg-viewer-key", key }, to);
  }, true);
  // B站's own autoplay can move to another video, in place (history.pushState) or by a reload: the 分拣台 follows the
  // video shown. The first tick reports the one loaded too; the page ignores the video it already plays.
  let shown = "";
  setInterval(() => {
    const bvid = viewerBvid(location.pathname);
    if (bvid && bvid !== shown) window.parent.postMessage({ type: "mdg-viewer-video", bvid }, to);
    shown = bvid || shown;
  }, 1000);
}

// The BV id of a /video/ path, or "".
function viewerBvid(path) {
  return /^\/video\/(BV[0-9A-Za-z]{10})/.exec(path)?.[1] || "";
}

// The 分拣台 key this keydown is, or "": never while typing (the danmaku box, the comment box inside B站's shadow
// roots) or composing, and Esc not while it is leaving full screen or 网页全屏.
function viewerKey(e) {
  if (BocTyping.composing(e) || BocTyping.typingIn(e) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return "";
  if (e.key === "Escape") return document.fullscreenElement || document.querySelector(".bpx-player-container[data-screen=web]") ? "" : "Escape";
  return e.key === "t" || e.key === "T" ? "t" : "";
}
