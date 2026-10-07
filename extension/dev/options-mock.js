// Dev-only fake chrome.* for previewing options.html from a static server, with the README screenshot settings.
// options.js is a classic script, so inject this before the page's scripts run, e.g. CDP
// Page.addScriptToEvaluateOnNewDocument with this file's text, then open /options.html. No-op inside the extension.
(() => {
  if (globalThis.chrome?.runtime?.id) return;
  const settings = {
    tags: "MoonDigest, 视频笔记",
    obsidianEnabled: true,
    obsidianApiKey: "demo",
    seenShow: "both",
    fixedFrontmatterProperties: [
      { key: "类型", type: "text", value: "视频" },
      { key: "来源", type: "text", value: "{{site}}" },
      { key: "已读", type: "checkbox", value: true }
    ],
    notePlaceholderSections: [{ title: "我的想法", content: "", position: "before_subtitle" }]
  };
  const providers = [
    { id: "p1", presetId: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", hasSavedKey: true, enabled: true },
    { id: "p2", presetId: "zhipu", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.7-flash", hasSavedKey: true, enabled: true }
  ];
  const handle = (msg) => {
    switch (msg?.type) {
      case "get-settings":
        return { ok: true, settings };
      case "ai-providers-list":
        return { ok: true, providers };
      default:
        return { ok: true };
    }
  };
  const area = (data) => ({
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(list.map((k) => [k, k in data ? data[k] : keys?.[k]]).filter(([, v]) => v !== undefined));
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove() {}
  });
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      getURL: (p) => new URL(p, location.href).href,
      sendMessage(msg, cb) {
        const resp = handle(msg);
        if (typeof cb === "function") return void setTimeout(() => cb(resp), 10);
        return Promise.resolve(resp);
      }
    },
    tabs: { create: ({ url }) => console.info("[mock] tabs.create", url) },
    permissions: { contains: async () => true, request: async () => true },
    storage: { local: area({}), sync: area({}), onChanged: { addListener() {} } }
  };
})();
