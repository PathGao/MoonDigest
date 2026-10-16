// Every message between the extension's contexts, in one list: chrome.runtime / chrome.tabs messages and the 分拣台
// player frame's postMessage. Loaded nowhere at runtime; messages.selftest.js holds the code to it (every type sent is
// here and handled, the fields a sender passes are listed, the listed fields are read by the handler, a builder returns
// exactly the listed payload). Not here: the side panel's chat port (MdgCommon.CHAT_PORT: { action: "chat" | "stop" } in,
// token / notice / done / stopped / error out), which background.js and sidepanel.js own between them.
//   from      the files that send it
//   to        the file whose listener answers it
//   request   the fields besides type
//   response  the top-level fields besides ok / error / code (documentation: not checked)
//   builder   "file:function" that builds the payload; its returned object has exactly the fields in payload
//   open      the request is an open set of keys, with why; its fields are not checked
// triage.js's sendRaw adds aiProviderId (the side panel's platform pick) to every triage-* and follow-* message; it is
// listed where the handler reads it.
(() => {
  const TRIAGE_BG = "triage/triage-bg.js";
  const FOLLOW_BG = "triage/follow-bg.js";
  const TRIAGE = ["triage/triage.js"];
  const FOLLOW = ["triage/follow.js"];
  const data = ["data"];
  const POPUP_PAYLOAD = ["site", "url", "title", "author", "uploadDate", "cover", "duration", "tags", "status", "message", "subtitlePreview", "markdown", "noteWarning", "filename", "subtitleMissing", "srt", "txt", "subtitleOptions"];

  globalThis.MdgMessages = Object.freeze({
    // Settings
    "get-settings": { from: ["content.js", "history/history.js", "options.js", "popup.js", "sidepanel.js"], to: "background.js", request: [], response: ["settings"] },
    "save-settings": { from: ["content.js", "options.js", "sidepanel.js"], to: "background.js", request: ["settings"], response: ["field"] },
    "settings-export": { from: ["options.js"], to: "background.js", request: [], response: ["file"] },
    "settings-import": { from: ["options.js"], to: "background.js", request: ["file"], response: [] },
    "test-obsidian-connection": { from: ["options.js"], to: "background.js", request: ["baseUrl", "apiKey"], response: ["service"] },
    "ai-providers-list": { from: ["options.js", "sidepanel.js"], to: "background.js", request: [], response: ["providers"] },
    "ai-providers-save": { from: ["options.js"], to: "background.js", request: ["providers"], response: ["providers"] },
    "ai-providers-delete": { from: ["options.js"], to: "background.js", request: ["providerId"], response: ["providers"] },
    "ai-providers-test": { from: ["options.js"], to: "background.js", request: ["providerId", "baseUrl", "apiKey", "model", "requiresKey"], response: [] },

    // Pages and tabs
    "open-options": { from: ["content.js", "popup.js", "triage/follow.js", "triage/triage.js"], to: "background.js", request: [], response: [] },
    "history-open": { from: ["options.js", "popup.js", "sidepanel.js"], to: "background.js", request: [], response: [] },
    "triage-open": { from: ["badges.js", "options.js", "popup.js"], to: TRIAGE_BG, request: ["hash"], response: data },
    "ensure-reader-content": { from: ["popup.js"], to: "background.js", request: ["tabId"], response: [] },
    "open-reading-view-tab": { from: ["popup.js"], to: "background.js", request: ["url", "tabId"], response: [] },
    "player-ai-quick-action": { from: ["content.js", "popup.js"], to: "background.js", request: ["tabId", "source", "contextRef"], response: [] },

    // The video page (content.js): the background's proxies for it, and what the popup, side panel and background ask it
    "yt-player-response": { from: ["content.js"], to: "background.js", request: [], response: ["data"] },
    "fetch-json": { from: ["content.js"], to: "background.js", request: ["url"], response: ["data", "status"] },
    "mdg-video-changed": { from: ["content.js"], to: "sidepanel.js", request: [], response: [] },
    "popup-get-state": { from: ["popup.js"], to: "content.js", request: [], response: ["payload"], builder: "content.js:getPopupPayload", payload: POPUP_PAYLOAD },
    "popup-refresh": { from: ["popup.js", "sidepanel.js"], to: "content.js", request: ["refresh"], response: ["payload"] },
    "popup-select-subtitle": { from: ["popup.js"], to: "content.js", request: ["url"], response: ["payload"] },
    "popup-send-obsidian": { from: ["popup.js"], to: "content.js", request: [], response: ["text", "written", "payload"] },
    "popup-trigger-reading-view": { from: ["background.js"], to: "content.js", request: ["readerUrl"], response: [] },
    "sidepanel-get-context": {
      from: ["background.js"],
      to: "content.js",
      request: ["refresh", "videoId"],
      response: ["payload"],
      builder: "content.js:buildSidepanelContext",
      payload: ["url", "title", "author", "uploadDate", "site", "videoId", "cid", "aid", "description", "pageIndex", "pageCount", "pageTitle", "subtitleMarkdown", "subtitleFailure", "subtitleNeedLogin", "subtitleWarning", "subtitleLang", "selectedSubtitleId", "selectedSubtitleUrl", "hotComments"]
    },
    "sidepanel-seek-video-time": { from: ["sidepanel.js"], to: "content.js", request: ["seconds", "videoId"], response: ["currentTime"] },

    // The side panel's context, through the background
    "ai-sidepanel-get-state": { from: ["sidepanel.js"], to: "background.js", request: ["tabId", "refresh", "frameId", "videoId"], response: ["payload"] },
    "ai-sidepanel-resolve-context": { from: ["sidepanel.js"], to: "background.js", request: ["contextRef"], response: ["payload"] },
    "ai-sidepanel-resolve-page-ref": { from: ["sidepanel.js"], to: "background.js", request: ["contextRef"], response: ["payload"] },

    // Obsidian (obsidian.js, the one writer)
    "write-video-note": { from: ["content.js", "history/history.js", "sidepanel.js"], to: "obsidian.js", request: ["ref", "mode", "conversation", "page"], response: ["ask", "path", "hasAiSection", "fullReason", "kind", "text", "title"] },
    "sync-video-note-ai": { from: ["sidepanel.js"], to: "obsidian.js", request: ["ref", "conversation"], response: ["path", "exists", "updated", "text"] },

    // 分拣台 收藏夹 (answers are { ok, data })
    "triage-folders": { from: TRIAGE, to: TRIAGE_BG, request: [], response: data },
    "triage-folder-items": { from: TRIAGE, to: TRIAGE_BG, request: ["mediaId", "known"], response: data },
    "triage-folder-page": { from: [TRIAGE_BG], to: "triage/triage.js", request: ["mediaId", "page"], response: [] },
    "triage-folder-ids": { from: TRIAGE, to: TRIAGE_BG, request: ["mediaId"], response: data },
    "triage-fav-where": { from: TRIAGE, to: TRIAGE_BG, request: ["aid", "mid"], response: data },
    "triage-folder-create": { from: TRIAGE, to: TRIAGE_BG, request: ["title", "privacy"], response: data },
    "triage-unfav": { from: TRIAGE, to: TRIAGE_BG, request: ["mediaId", "aids"], response: data },
    "triage-refav": { from: TRIAGE, to: TRIAGE_BG, request: ["mediaId", "aid"], response: data },
    "triage-transfer": { from: TRIAGE, to: TRIAGE_BG, request: ["from", "to", "aids", "move"], response: data },
    "triage-title-get": { from: TRIAGE, to: TRIAGE_BG, request: ["bvids"], response: data },
    "triage-analysis-get": { from: TRIAGE, to: TRIAGE_BG, request: ["bvids"], response: data },
    "triage-classify-titles": { from: TRIAGE, to: TRIAGE_BG, request: ["items", "criteria", "folder", "aiProviderId"], response: data },
    "triage-analyze": { from: TRIAGE, to: TRIAGE_BG, request: ["bvid", "force", "criteria", "folder", "aiProviderId"], response: data },
    "triage-ai-command": { from: TRIAGE, to: TRIAGE_BG, request: ["instruction", "items", "tags", "maxNewTags", "allowRemove", "aiProviderId"], response: data },
    "triage-settings-get": { from: [...TRIAGE, ...FOLLOW], to: TRIAGE_BG, request: ["aiProviderId"], response: data },
    "triage-settings-save": { from: TRIAGE, to: TRIAGE_BG, request: [], open: "any key of triage-bg.js's TRIAGE_SETTINGS_DEFAULTS", response: data },
    "triage-seen-sync": { from: ["badges.js", ...TRIAGE], to: TRIAGE_BG, request: ["force"], response: data },
    "triage-seen-done": { from: [TRIAGE_BG], to: "triage/triage.js", request: ["error"], response: [] },
    "triage-obsidian-check": { from: TRIAGE, to: TRIAGE_BG, request: [], response: data },
    "triage-build-note": { from: TRIAGE, to: TRIAGE_BG, request: ["bvid"], response: data },
    "triage-write-note": { from: TRIAGE, to: TRIAGE_BG, request: ["bvid", "title", "overwrite"], response: data },
    "triage-export": { from: TRIAGE, to: TRIAGE_BG, request: ["filename", "markdown"], response: data },

    // 分拣台 关注 (answers are { ok, data })
    "follow-sync": { from: FOLLOW, to: FOLLOW_BG, request: [], response: data },
    "follow-sync-stop": { from: FOLLOW, to: FOLLOW_BG, request: [], response: data },
    "follow-feed": { from: FOLLOW, to: FOLLOW_BG, request: ["offset"], response: data },
    "follow-relation": { from: FOLLOW, to: FOLLOW_BG, request: ["mid", "act", "gone"], response: data },
    "follow-forget": { from: FOLLOW, to: FOLLOW_BG, request: ["mids"], response: data },
    "follow-group-move": { from: FOLLOW, to: FOLLOW_BG, request: ["mids", "from", "to"], response: data },
    "follow-group-create": { from: FOLLOW, to: FOLLOW_BG, request: ["name"], response: data },
    "follow-group-rename": { from: FOLLOW, to: FOLLOW_BG, request: ["id", "name"], response: data },
    "follow-group-delete": { from: FOLLOW, to: FOLLOW_BG, request: ["id"], response: data },
    "follow-ai-tag": { from: FOLLOW, to: FOLLOW_BG, request: ["instruction", "mids", "tags", "maxNewTags", "allowRemove", "aiProviderId"], response: data },

    // The 分拣台 player frame (viewer-frame.js, a content script in B站's page) to the 分拣台 page: window.postMessage
    "mdg-viewer-key": { from: ["triage/viewer-frame.js"], to: "triage/shared.js", request: ["key"], response: [] },
    "mdg-viewer-video": { from: ["triage/viewer-frame.js"], to: "triage/triage.js", request: ["bvid"], response: [] }
  });
})();
