// Marks the video page when it is the triage viewer's iframe, so viewer-frame.css trims it to the
// player, the description and the comments. Pages opened any other way are left alone.
if (window !== window.top && location.ancestorOrigins?.[0] === `chrome-extension://${chrome.runtime.id}`) {
  document.documentElement.setAttribute("data-mdg-viewer", "");
  // While a video plays the keys go to this frame: T (tag the UP) and Esc go up to the 分拣台 page (follow.js).
  const to = location.ancestorOrigins[0];
  addEventListener("keydown", (e) => {
    const key = viewerKey(e);
    if (key) window.parent.postMessage({ type: "mdg-viewer-key", key }, to);
  }, true);
}

// The 分拣台 key this keydown is, or "": never while typing (the danmaku box, the comment box inside B站's shadow
// roots) or composing, and Esc not while it is leaving full screen or 网页全屏.
function viewerKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.isComposing || e.keyCode === 229) return "";
  const el = e.composedPath?.()[0] || e.target;
  if (el?.isContentEditable || el?.closest?.("input, textarea, select")) return "";
  if (e.key === "Escape") return document.fullscreenElement || document.querySelector(".bpx-player-container[data-screen=web]") ? "" : "Escape";
  return e.key === "t" || e.key === "T" ? "t" : "";
}
