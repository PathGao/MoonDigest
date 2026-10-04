// Marks the video page when it is the triage viewer's iframe, so viewer-frame.css trims it to the
// player, the description and the comments. Pages opened any other way are left alone.
if (window !== window.top && location.ancestorOrigins?.[0] === new URL(chrome.runtime.getURL("")).origin) {
  document.documentElement.setAttribute("data-mdg-viewer", "");
}
