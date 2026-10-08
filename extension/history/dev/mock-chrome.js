// Dev-only fake chrome.* for opening history.html from a static server (no-op inside the extension).
// Seeds conversations for three videos and a web page, some triage analyses and notes. window.__mockVault is the fake Obsidian vault (path → markdown);
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
  const longTitle = ref("bilibili", "BV1mock000002", "【合集】吴恩达机器学习 2024 中文字幕 全 142 集：监督学习、无监督学习、推荐系统与强化学习", { cid: "1002" });
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
    triage_analysis_BV1mock000009: { bvid: "BV1mock000009", status: "done", source: "meta", oneLiner: "梯度下降调参经验谈", points: ["学习率太大为什么会震荡，太小为什么收敛慢", "三种常见的学习率调度：阶梯、余弦、预热", "批归一化在小批量下效果变差的原因"], verdict: "drop", reason: "过时", analyzedAt: now - 10 * hour },
    triage_analysis_BV1mock000010: { bvid: "BV1mock000010", status: "done", oneLiner: "一期 Rust 所有权入门", points: [], verdict: "unsure", analyzedAt: now - 400 * hour },
    triage_analysis_BV1mock000011: { bvid: "BV1mock000011", status: "error" },
    // Notes: BV1mock000001 joins its entry, BV1mock000012 and the YouTube abcDEF12345 are note-only entries, the blank one is ignored.
    triage_notes: { BV1mock000001: { text: "先看注意力那段\n再看位置编码", updatedAt: now - 3 * hour }, BV1mock000012: { text: "周末看，讲 CUDA 的那段", updatedAt: now - 5 * hour }, abcDEF12345: { text: "配合论文一起看", updatedAt: now - 6 * hour }, BV1mock000013: { text: " ", updatedAt: now } },
    triage_snapshot_42: { bvids: ["BV1mock000009"], titles: { BV1mock000009: "深度学习调参：从学习率到批归一化" }, at: now }
  };
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  // ?demo swaps in the README screenshot data: B站-style videos, one side panel conversation, triage summaries and notes.
  if (/[?&]demo\b/.test(location.search)) {
    for (const k of Object.keys(store)) delete store[k];
    const day = 24 * hour;
    const tomato = ref("bilibili", "BV1demo000001", "番茄工作法：25 分钟专注到底怎么用", { cid: "2001", author: "效率研究所" });
    const git = ref("bilibili", "BV1demo00004", "Git 原理图解：commit、branch 到底是什么", { cid: "2004", author: "量子土豆" });
    const talk = ref("youtube", "aB3dEmo9xYz", "How I take notes on long videos", { author: "Study Lab" });
    store.boc_ai_conversations_v1 = [
      conv("d1", "bilibili|BV1demo000001|2001", tomato, now - 2 * hour, [["整理这期视频的内容，输出结构化总结。", "**一句话总结** 25 分钟专注加 5 分钟休息，把大任务拆成能完成的小块。\n\n1. 为什么有效 `00:42`\n2. 怎么开始 `02:15`\n3. 常见误区 `05:30`"], ["被打断了怎么办？", "记下打断的事，这个番茄作废，重新开始一个。"]]),
      conv("d2", "bilibili|BV1demo00004|2004", git, now - 26 * hour, [["rebase 和 merge 怎么选？", "自己的分支用 rebase 保持历史整齐，公共分支用 merge。"]]),
      conv("d3", "youtube|aB3dEmo9xYz|", talk, now - 3 * day, [["Summarize in Chinese", "作者用三步记笔记：先看一遍只记时间点，再按章节整理，最后写一句自己的结论。"]])
    ];
    const a = (bvid, verdict, reason, oneLiner, points, at) => ({ bvid, status: "done", source: "subtitle", oneLiner, points, verdict, reason, analyzedAt: now - at });
    store.triage_analysis_BV1demo00004 = a("BV1demo00004", "keep", "讲透原理", "用画图的方式讲清 commit、branch 和 HEAD 的关系。", ["commit 是快照，不是差异", "branch 只是指向 commit 的指针", "rebase 和 merge 的区别"], day);
    store.triage_analysis_BV1demo00001 = a("BV1demo00001", "keep", "跟着做就能学会", "用一份销售表演示数据透视表的建表、分组、筛选和切片器。", ["拖字段建表", "按月和按季度分组", "切片器联动多张表"], 2 * day);
    store.triage_analysis_BV1demo00005 = a("BV1demo00005", "drop", "带货测评，时效性强", "五款降噪耳机的音质、降噪和续航对比。", ["降噪最强的价格也最高", "通勤推荐中端款", "文末抽奖"], 2 * day);
    store.triage_snapshot_2001 = { bvids: ["BV1demo00001", "BV1demo00005"], titles: { BV1demo00001: "Excel 数据透视表从入门到精通，看这一个就够了", BV1demo00005: "2026 年最值得买的 5 款降噪耳机（文末抽奖）" }, at: now };
    store.triage_notes = { BV1demo00004: { text: "周末配合官方文档一起看，第 3 节的图要截下来", updatedAt: now - 3 * hour }, BV1demo000001: { text: "周一试一周，记录每天完成几个番茄", updatedAt: now - hour } };
  }

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
        return { ok: true, settings: { obsidianEnabled: !window.__mockObsidianOff, obsidianApiBaseUrl: "http://127.0.0.1:27123", obsidianApiKey: "mock", noteFolder: "MoonDigest/{{site}}", includeDateInFilename: true } };
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
        return { ok: true, data: { title: `视频 ${msg.bvid}`, path: `MoonDigest/bilibili/视频 ${msg.bvid}.md`, cover: { url: "", name: `bilibili-${msg.bvid}` }, markdown: `---\ntitle: 视频 ${msg.bvid}\n---\n\n## 字幕\n\nmock subtitle\n` } };
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
