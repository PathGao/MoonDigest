// Dev-only fake chrome.* for opening history.html from a static server (no-op inside the extension).
// Seeds four videos' conversations, some triage analyses and notes. window.__mockVault is the fake Obsidian vault (path → markdown);
// downloads are caught into window.__mockDownloads ({ filename, content }) instead of hitting disk.
(() => {
  if (globalThis.chrome?.runtime?.id) return;

  const listeners = [];
  const now = Date.now();
  const hour = 3600e3;
  const ref = (site, videoId, title, extra = {}) => ({
    title, site, videoId, author: "UP主", cid: "", pageIndex: 1, pageCount: 1, isVideoContext: true,
    url: site === "youtube" ? `https://www.youtube.com/watch?v=${videoId}` : `https://www.bilibili.com/video/${videoId}/`, ...extra
  });
  const conv = (id, contextKey, contextRef, updatedAt, qa) => ({
    id, title: contextRef.title, contextKey, contextTitle: contextRef.title, contextUrl: contextRef.url, isVideoContext: contextRef.isVideoContext,
    createdAt: updatedAt - hour, updatedAt, contextRef,
    messages: qa.flatMap(([q, a]) => [{ role: "user", content: q }, { role: "assistant", content: a }])
  });
  const bili = ref("bilibili", "BV1mock000001", "从零实现一个 Transformer：逐行代码讲解", { cid: "1001" });
  const yt = ref("youtube", "dQw4w9WgXcQ", "How RAG actually works — a deep dive");
  const longTitle = ref("bilibili", "BV1mock000002", "【合集】吴恩达机器学习 2024 中文字幕 超长标题测试一下窄屏下标题怎么换行显示", { cid: "1002" });
  const page = { title: "某篇博客文章", url: "https://example.com/post", isVideoContext: false };
  const store = {
    boc_ai_conversations_v1: [
      conv("c1", "bilibili|BV1mock000001|1001", bili, now - hour, [["整理这期视频的内容，输出结构化总结。", "## 总结\n\n1. 注意力机制 `03:21`\n2. 位置编码\n\n<think>草稿</think>结论：值得看。"], ["位置编码再展开一下", "正弦位置编码让模型知道顺序。"]]),
      conv("c2", "bilibili|BV1mock000001|1001", bili, now - 30 * hour, [["这个视频适合入门吗？", "适合有 Python 基础的人。"]]),
      conv("c3", "youtube|dQw4w9WgXcQ|", yt, now - 50 * hour, [["Summarize", "RAG = retrieval + generation."]]),
      conv("c4", "bilibili|BV1mock000002|1002", longTitle, now - 200 * hour, [["有哪些反对观点？", "有人认为课程太浅。"]]),
      conv("c5", "https://example.com/post", page, now - 300 * hour, [["这篇讲了什么", "讲了 <script>alert(1)</script> 的转义。"]])
    ],
    // Triage analyses: BV1mock000001 joins its conversation entry, BV1mock000009 / BV1mock000010 stand alone
    // (title from a folder snapshot / no title), the error one is ignored.
    triage_analysis_BV1mock000001: { bvid: "BV1mock000001", status: "done", source: "subtitle", oneLiner: "逐行手写 Transformer", points: ["注意力", "位置编码", ""], verdict: "keep", reason: "讲得细", analyzedAt: now - 2 * hour },
    triage_analysis_BV1mock000009: { bvid: "BV1mock000009", status: "done", source: "meta", oneLiner: "只在分拣台分析过的视频", points: ["要点一", "要点二", "要点三"], verdict: "drop", reason: "过时", analyzedAt: now - 10 * hour },
    triage_analysis_BV1mock000010: { bvid: "BV1mock000010", status: "done", oneLiner: "没有标题的视频", points: [], verdict: "unsure", analyzedAt: now - 400 * hour },
    triage_analysis_BV1mock000011: { bvid: "BV1mock000011", status: "error" },
    // Notes: BV1mock000001 joins its entry, BV1mock000012 and the YouTube abcDEF12345 are note-only entries, the blank one is ignored.
    triage_notes: { BV1mock000001: { text: "先看注意力那段\n再看位置编码", updatedAt: now - 3 * hour }, BV1mock000012: { text: "只有备注的视频", updatedAt: now - 5 * hour }, abcDEF12345: { text: "YouTube 上只有备注的视频", updatedAt: now - 6 * hour }, BV1mock000013: { text: " ", updatedAt: now } },
    triage_snapshot_42: { bvids: ["BV1mock000009"], titles: { BV1mock000009: "分拣台里的视频标题" }, at: now }
  };
  const clone = (v) => (v === undefined ? v : structuredClone(v));

  window.__mockVault = {};
  window.__mockEmit = (changes, area) => listeners.forEach((fn) => fn(changes, area));
  window.__mockDownloads = [];
  const nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!this.download) return nativeClick.call(this);
    const filename = this.download;
    fetch(this.href).then((r) => r.text()).then((content) => window.__mockDownloads.push({ filename, content }));
  };

  const rememberPath = (noteKey, path) => {
    if (noteKey) store.boc_obsidian_note_paths_v1 = { ...store.boc_obsidian_note_paths_v1, [noteKey]: { path, lastSyncedAt: Date.now() } };
  };
  const handle = (msg) => {
    switch (msg?.type) {
      case "get-settings":
        return { ok: true, settings: { obsidianEnabled: !window.__mockObsidianOff, obsidianApiBaseUrl: "http://127.0.0.1:27123", obsidianApiKey: "mock", noteFolder: "Clippings/{{site}}", includeDateInFilename: true } };
      case "obsidian-note-exists":
        return { ok: true, exists: msg.filepath in window.__mockVault };
      case "write-obsidian-note":
        window.__mockVault[msg.filepath] = msg.content;
        rememberPath(msg.noteKey, msg.filepath);
        return { ok: true };
      case "update-obsidian-ai-section": {
        const content = window.__mockVault[msg.filepath];
        if (content == null) return { ok: true, exists: false, updated: false };
        window.__mockVault[msg.filepath] = BocNote.upsertAiSection(content, msg.section);
        rememberPath(msg.noteKey, msg.filepath);
        return { ok: true, exists: true, updated: window.__mockVault[msg.filepath] !== content };
      }
      // Background reply shape: { ok, data }. window.__mockBuildFail makes it fail like a throttled fetch.
      case "triage-build-note":
        if (window.__mockBuildFail) return { ok: false, error: "mock: 请求过于频繁" };
        return { ok: true, data: { title: `视频 ${msg.bvid}`, markdown: `---\ntitle: 视频 ${msg.bvid}\n---\n\n## 字幕\n\nmock subtitle\n` } };
      default:
        return { ok: false, error: `mock: unhandled ${msg?.type}` };
    }
  };

  globalThis.chrome = {
    runtime: {
      sendMessage: async (msg) => handle(msg),
      openOptionsPage: () => console.log("[mock] openOptionsPage")
    },
    tabs: { getCurrent: async () => ({ id: 1, windowId: 1 }) },
    sidePanel: { open: async (opts) => (window.__mockSidePanel ||= []).push(opts) },
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return clone(store);
          const list = [].concat(keys);
          return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, clone(store[k])]));
        },
        async set(items) {
          const changes = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: store[k], newValue: clone(v) };
            store[k] = clone(v);
          }
          setTimeout(() => listeners.forEach((fn) => fn(changes, "local")), 0);
        }
      },
      onChanged: { addListener: (fn) => listeners.push(fn) }
    }
  };
})();
