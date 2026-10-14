// How pages show an error the background already classified: the shared sentences, what each error code asks the
// user to do, and the helpers every page used to copy, HTML escaping among them. The background classifies (triage-bg.js triageAiHttpError,
// obsidian.js obsidianError) and reads TEXT from here too. Loaded by the content script (manifest), background
// (importScripts) and the pages; load-order.selftest.js checks every user of MdgErrors loads it first. Idempotent like limits.js.
(() => {
  if (globalThis.MdgErrors) {
    return;
  }

  const TEXT = Object.freeze({
    obsidianUnset: "请先在设置页填写 Obsidian Local REST API 地址和 API Key",
    obsidianKey: "Obsidian 的 API Key 无效或未授权",
    obsidianDown: "连不上 Obsidian，请确认它已打开并启用了 Local REST API",
    obsidianOff: "Obsidian 写入未启用",
    // HTTP 404 from the Local REST API: the address points somewhere else (a wrong path or port).
    obsidianNotFound: "Obsidian Local REST API 地址不对（HTTP 404）",
    // 取消 in the 该笔记已存在 dialog: the page sent no second write-video-note, so nothing was written.
    obsidianCancelled: "已取消写入 Obsidian，原笔记未被覆盖。",
    // The extension reloaded under a page whose content script still runs: chrome.runtime no longer answers.
    reloaded: "扩展刚刚更新，请刷新网页",
    // B站 risk control (HTTP 412 or MdgSites.BILI_RISK_CODES), the background's code THROTTLED.
    biliThrottled: "B站限流，请稍后再试",
    // Not logged in to B站 (the background's NOT_LOGGED_IN, B站's -101), on any read or write; pages add 去登录.
    biliLogin: "未登录 B站：先在这个浏览器里登录 B站",
    // What a page that can reload adds to subtitleMissing's 未登录 sentence (the video page, the side panel); notes do not.
    subtitleLoginHint: "登录 B站后刷新网页"
  });

  // Why a reader has no subtitle: the one sentence of every entry (video page, 专注模式, popup, side panel, the AI's
  // context, 分拣台, notes), without a full stop. subtitleNeedLogin is its own state (B站 hides subtitles from a
  // logged-out viewer), not a failure; subtitleFailure is why the fetch failed. A state, never an instruction.
  // AI_TIMEOUT: no answer from the AI platform in ms (each caller's own limit: side panel, 分拣台, 测试连接).
  const aiTimeout = (ms) => `AI 平台 ${ms / 1000} 秒没有回应`;

  const subtitleMissing = ({ subtitleNeedLogin = false, subtitleFailure = "" } = {}) =>
    subtitleNeedLogin ? "未登录 B站，拿不到字幕" : subtitleFailure ? `字幕抓取失败：${subtitleFailure}` : "视频没有字幕";

  // Error code → what the page shows. action: "settings" (去设置), "login" (去登录); any other code is "none".
  // text replaces the background's words for the code. Numbers are B站's own codes, passed through.
  const CODES = Object.freeze({
    // The AI platform errors after which every request fails alike: 分拣台 stops its run on them, and both it and the
    // side panel offer 去设置 (an unreachable platform or a timeout may be a wrong base URL or model).
    AI_AUTH: { action: "settings" },
    AI_QUOTA: { action: "settings" },
    AI_SETUP: { action: "settings" },
    AI_NETWORK: { action: "settings" },
    AI_TIMEOUT: { action: "settings" },
    // 分拣台 only: AI 平台 still limited after AI_THROTTLE_WAITS waits in a row.
    AI_GAVE_UP: { action: "settings" },
    // Obsidian itself is unusable (not set up, off, wrong key): every write fails alike and the fix is in the settings
    // page. OBSIDIAN_DOWN (closed, plugin off, timeout) also fails every write, but the settings page cannot fix it.
    OBSIDIAN: { action: "settings" },
    NOT_LOGGED_IN: { action: "login", text: TEXT.biliLogin },
    [-101]: { action: "login", text: TEXT.biliLogin },
    THROTTLED: { text: TEXT.biliThrottled },
    62004: { text: "视频审核中，过后再试" }
  });

  const action = (code) => CODES[code]?.action || "none";

  // A background reply { ok: false, error, code? } in the user's words.
  function text(resp, fallback = "未知错误") {
    const own = typeof resp?.error === "string" ? resp.error.trim() : "";
    return CODES[resp?.code]?.text || own || fallback;
  }

  // The reply as an Error to throw; error.action says which button the catch shows, error.cause is the reply.
  const fromResp = (resp, fallback) => Object.assign(new Error(text(resp, fallback), { cause: resp }), { action: action(resp?.code) });

  // The background's "未授权访问 <origin>，授权后重试" (hostPermissionError): an upgraded install lacks the AI provider's
  // origin. request() must run in a click handler: permissions.request needs the user gesture, the worker cannot ask.
  function grantOrigin(message) {
    const origin = /未授权访问 (https?:\/\/[^\s，]+)/.exec(String(message || ""))?.[1];
    return origin ? { origin, request: () => chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false) } : null;
  }

  // What chrome.runtime calls throw in a content script whose extension was reloaded (badges.js checks
  // chrome.runtime.id instead and copies TEXT.reloaded; errors.selftest.js keeps the copy equal).
  const reloaded = (error) => /Extension context invalidated/.test(String(error?.message || ""));

  // Text into markup, in element content and in quoted attributes: the one copy every page, the video page and 分拣台
  // (TriageUi.esc) build HTML with. Titles, UP names, comments, AI replies and tag names all pass through it.
  // badges.js does not load this file: it builds its DOM with textContent.
  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  globalThis.MdgErrors = Object.freeze({ TEXT, action, text, fromResp, grantOrigin, reloaded, escapeHtml, subtitleMissing, aiTimeout });
})();
