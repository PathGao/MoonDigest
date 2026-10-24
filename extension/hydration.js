// Runs in the page's own world (manifest "world": "MAIN"). B站's Vue 3 pages (search, home) are server-rendered too,
// but leave no attribute for badges.js to wait on as Vue 2's data-server-rendered: the signs are window.__pinia and an
// element's __vue_app__, which the extension's world cannot see. So <html> carries data-mdg-ssr from the start to the
// hydration; badges.js marks nothing while it is there (#394). From the start, not from the state: the cards are parsed
// before the inline script that sets it, and badges.js marks them as they come. Without a state by DOMContentLoaded
// the page is not server-rendered by Vue 3 and the attribute goes.
(() => {
  const html = document.documentElement;
  // The hook on every element is there only from the state to the hydration. Installed on every page, it went with
  // the comments failing to load on the video page, which sets no __pinia (smoke check; no cause found).
  const done = () => {
    html.removeAttribute("data-mdg-ssr");
    delete Element.prototype.__vue_app__;
  };
  let state;
  let hooked = false;
  html.setAttribute("data-mdg-ssr", "");
  addEventListener("DOMContentLoaded", () => hooked || done(), { once: true });
  // The store's state, set by an inline script in the HTML ahead of the app's own.
  Object.defineProperty(window, "__pinia", {
    configurable: true,
    enumerable: true,
    get: () => state,
    set(v) {
      state = v;
      if (document.readyState !== "loading" || hooked) return;
      hooked = true;
      // Vue sets it on the container once the app is mounted; createApp then marks the container data-v-app,
      // createSSRApp, which hydrates, does not. The mount waits for B站's router (isReady), so it can come before or
      // after DOMContentLoaded.
      Object.defineProperty(Element.prototype, "__vue_app__", {
        configurable: true,
        set(app) {
          Object.defineProperty(this, "__vue_app__", { value: app, writable: true, configurable: true });
          queueMicrotask(() => this.hasAttribute("data-v-app") || done());
        }
      });
      // A page that never hydrates (B站 changed how it mounts) still gets its marks.
      addEventListener("load", () => setTimeout(done, 5000), { once: true });
    }
  });
})();
