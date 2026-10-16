// Starts 收藏夹's page (fav-*.js ran before this module); a static-server preview first loads the fake chrome.*.
if (!globalThis.chrome?.runtime?.id) await import("./dev/mock-chrome.js");
init();
