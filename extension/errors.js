// How pages show an error the background already classified: the shared sentences, what each error code asks the
// user to do, and the helpers every page used to copy. The background classifies (triage-bg.js triageAiHttpError,
// background.js obsidianFailure) and reads TEXT from here too. Loaded by the content script (manifest), background
// (importScripts) and the pages; errors.selftest.js checks every user of BocErrors loads it. Idempotent like limits.js.
(() => {
  if (globalThis.BocErrors) {
    return;
  }

  const TEXT = Object.freeze({
    obsidianUnset: "请先在设置页填写 Obsidian Local REST API 地址和 API Key",
    obsidianKey: "Obsidian 的 API Key 无效或未授权",
    obsidianDown: "连不上 Obsidian，请确认它已打开并启用了 Local REST API",
    // The extension reloaded under a page whose content script still runs: chrome.runtime no longer answers.
    reloaded: "扩展刚刚更新，请刷新网页"
  });

  // Error code → what the page shows. action: "settings" (去设置), "login" (去登录); any other code is "none".
  // text replaces the background's words for the code. Numbers are B站's own codes, passed through.
  const CODES = Object.freeze({
    AI_AUTH: { action: "settings" },
    AI_QUOTA: { action: "settings" },
    AI_SETUP: { action: "settings" },
    // Obsidian itself is unusable (not set up, off, wrong key): every write fails alike and the fix is in the settings
    // page. OBSIDIAN_DOWN (closed, plugin off, timeout) also fails every write, but the settings page cannot fix it.
    OBSIDIAN: { action: "settings" },
    NOT_LOGGED_IN: { action: "login" },
    [-101]: { action: "login" },
    62004: { text: "视频审核中，过后再试" }
  });

  const action = (code) => CODES[code]?.action || "none";

  // A background reply { ok: false, error, code? } in the user's words.
  function text(resp, fallback = "未知错误") {
    const own = typeof resp?.error === "string" ? resp.error.trim() : "";
    return CODES[resp?.code]?.text || own || fallback;
  }

  // The reply as an Error to throw; error.action says which button the catch shows.
  const fromResp = (resp, fallback) => Object.assign(new Error(text(resp, fallback)), { action: action(resp?.code) });

  // The background's "未授权访问 <origin>，授权后重试" (hostPermissionError): an upgraded install lacks the AI provider's
  // origin. request() must run in a click handler: permissions.request needs the user gesture, the worker cannot ask.
  function grantOrigin(message) {
    const origin = /未授权访问 (https?:\/\/[^\s，]+)/.exec(String(message || ""))?.[1];
    return origin ? { origin, request: () => chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false) } : null;
  }

  // What chrome.runtime calls throw in a content script whose extension was reloaded (badges.js checks
  // chrome.runtime.id instead and copies TEXT.reloaded; errors.selftest.js keeps the copy equal).
  const reloaded = (error) => /Extension context invalidated/.test(String(error?.message || ""));

  globalThis.BocErrors = Object.freeze({ TEXT, action, text, fromResp, grantOrigin, reloaded });
})();
