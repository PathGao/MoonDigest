// 侧边栏开发用 mock chrome：模拟 B 站视频标签页、三个视频上下文、一个 AI 平台和慢速流式回复。
// window.__mockSwitchVideo(n) 切到第 n 个视频（改 URL + tabs.onUpdated + mdg-video-changed）。第 2 个没有字幕，第 3 个字幕抓取失败。
// window.__mockOpenPage(url, title) 切到非视频标签页（url 为空即加载中的标签页）；__mockStateDelayMs 模拟字幕和评论加载耗时。
// 流的结局：__mockStreamEnd = { after: n, error: "..." } 在第 n 个 token 后报错；{ after: n, disconnect: true } 模拟后台断开。
// __mockStateError = "..." 让读取页面上下文失败（检查「重试」）。
// __mockNotice 先发一条 notice；__mockTokenMs 调慢流速。
// ?providers=0 模拟还没配置 AI 平台。
// ?demo 换成 README 截图用的演示数据：一个像样的 B 站视频，预置一段带 AI 总结的对话和一条备注。
// Obsidian：window.__mockVault 是假库（path → markdown），__mockVaultLog 记每次 GET/PUT；__mockObsidianDown = true 让写入失败。
(() => {
  const makeEvent = () => {
    const listeners = [];
    return {
      addListener: (fn) => listeners.push(fn),
      _fire: (...args) => listeners.slice().forEach((fn) => fn(...args))
    };
  };

  const videos = [1, 2, 3].map((n) => ({
    bvid: `BV1mock00000${n}`,
    cid: String(1000 + n),
    aid: String(500 + n),
    title: `测试视频 ${n}：自动连播里的第 ${n} 个视频标题稍微长一点`,
    url: `https://www.bilibili.com/video/BV1mock00000${n}/`,
    author: `UP主${n}`
  }));
  const demo = new URLSearchParams(location.search).has("demo");
  if (demo) {
    videos.splice(0, videos.length, { bvid: "BV1demo000001", cid: "2001", aid: "601", title: "番茄工作法：25 分钟专注到底怎么用", url: "https://www.bilibili.com/video/BV1demo000001/", author: "效率研究所" });
    const v = videos[0];
    const ref = { site: "bilibili", videoId: v.bvid, cid: v.cid, aid: v.aid, title: v.title, url: v.url, author: v.author, pageIndex: 1, pageCount: 1, isVideoContext: true };
    const now = Date.now();
    const summary = [
      "**一句话总结**",
      "番茄工作法用 25 分钟专注加 5 分钟休息的节奏，把大任务拆成能完成的小块，重点是保护专注时段不被打断。",
      "",
      "**要点**",
      "1. **为什么有效**（[00:42](https://www.bilibili.com/video/BV1demo000001/?t=42)）：时间短，开始的门槛低；休息让注意力恢复。",
      "2. **怎么开始**（[02:15](https://www.bilibili.com/video/BV1demo000001/?t=135)）：先列清单，每个番茄只做一件事。被打断就记下来，结束后再处理。",
      "3. **常见误区**（[05:30](https://www.bilibili.com/video/BV1demo000001/?t=330)）：休息时间拿去刷手机，或者硬撑着不休息，下一个番茄效率都会下降。",
      "4. **进阶用法**（[07:48](https://www.bilibili.com/video/BV1demo000001/?t=468)）：每 4 个番茄做一次 15 到 30 分钟的长休息，记录每天完成的数量。",
      "",
      "**适合谁**",
      "容易拖延、经常被打断、需要长时间伏案的人。"
    ].join("\n");
    const seed = {
      mdg_ai_conversations_v1: [{
        id: "demo-c1", title: v.title, contextKey: `video:bilibili:${v.bvid}|${v.cid}`, contextTitle: v.title, contextUrl: v.url, isVideoContext: true,
        createdAt: now - 60000, updatedAt: now - 30000, contextRef: ref, pageHydrated: true,
        messages: [{ role: "user", content: "整理这期视频的内容，输出结构化总结。" }, { role: "assistant", content: summary }]
      }],
      triage_notes: { [v.bvid]: { text: "周一试一周，记录每天完成几个番茄", updatedAt: now - 20000 } }
    };
    localStorage.setItem("__mock_storage_local", JSON.stringify(seed));
  }
  const tabTitle = (video) => `${video.title}_哔哩哔哩_bilibili`;
  const tab = { id: 1, active: true, status: "complete", url: videos[0].url, title: tabTitle(videos[0]) };
  const TOKEN_COUNT = 20;
  const TOKEN_MS = 80;

  const findVideo = (url) => videos.find((v) => String(url || "").includes(v.bvid));
  // Like content.js buildSidepanelContext, the payload names its site and video id.
  const payloadFor = (video) => ({
    ...video,
    site: "bilibili",
    videoId: video.bvid,
    pageIndex: 1,
    pageCount: 1,
    // Video 2 has no subtitles; video 3's failed to load (as content.js reports it).
    subtitleMarkdown: video === videos[1] || video === videos[2] ? "" : `字幕 ${video.title}`,
    subtitleFailure: video === videos[2] ? "字幕接口限流（429）" : "",
    hotComments: [],
    isVideoContext: true
  });

  const makeArea = (backing, prefix) => {
    const read = () => {
      try {
        return JSON.parse(backing.getItem(prefix) || "{}");
      } catch {
        return {};
      }
    };
    const write = (obj) => backing.setItem(prefix, JSON.stringify(obj));
    return {
      async get(keys) {
        const all = read();
        if (keys == null) return all;
        const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
        return Object.fromEntries(list.filter((k) => k in all).map((k) => [k, all[k]]));
      },
      async set(items) {
        const all = read();
        const changes = {};
        Object.entries(items).forEach(([k, v]) => {
          changes[k] = { oldValue: all[k], newValue: v };
          all[k] = v;
        });
        write(all);
      },
      async remove(keys) {
        const all = read();
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete all[k]);
        write(all);
      }
    };
  };

  // ?presets=N swaps in N follow-up prompts to check how long lists lay out.
  const params = new URLSearchParams(location.search);
  const presetCount = Number(params.get("presets")) || 0;
  // ?page=<url> opens on a non-video tab, the same as __mockOpenPage before the panel loads.
  if (params.get("page")) {
    Object.assign(tab, { url: params.get("page"), title: "示例网页" });
  }
  const presetPrompts = presetCount
    ? Array.from({ length: presetCount }, (_, i) => ["用 3 句话总结这个视频", "提炼这个视频的 5 个重点", "按章节整理视频内容", "这个视频的核心论点是什么，有哪些论据支撑"][i % 4] + (i >= 4 ? ` ${i + 1}` : ""))
    : ["按时间顺序整理这期视频的内容", "根据评论总结观众的看法", "按章节整理视频内容", "生成带时间轴的笔记"];

  window.__mockVault = window.__mockVault || {};
  window.__mockVaultLog = window.__mockVaultLog || [];
  const vaultLog = (method, path) => window.__mockVaultLog.push(`${method} ${path}`);

  const mockSettings = {
    playerAiQuickPrompt: "整理这期视频的内容，输出结构化总结。",
    aiPresetPrompts: presetPrompts,
    obsidianEnabled: true,
    obsidianApiBaseUrl: "http://127.0.0.1:27123",
    obsidianApiKey: "mock",
    noteFolder: "MoonDigest/{{site}}",
    includeDateInFilename: true,
    includeAiChatInNote: true
  };

  const notePaths = {};
  const handleMessage = (msg) => {
    switch (msg?.type) {
      // obsidian.js in short: the video note at its recorded or computed path, the page's body or a stand-in; ask when it exists.
      case "write-video-note": {
        if (window.__mockObsidianDown) return { ok: false, error: "连不上 Obsidian，请确认它已打开并启用了 Local REST API", code: "OBSIDIAN_DOWN" };
        const key = MdgSites.buildContextKey(msg.ref);
        const path = notePaths[key] || MdgNote.videoNotePath(msg.ref, mockSettings);
        vaultLog("GET", path);
        const current = window.__mockVault[path];
        const section = MdgNote.buildAiSection(MdgNote.buildConversationTurns(msg.conversation?.messages));
        if (current !== undefined && !msg.mode) return { ok: true, ask: true, path, hasAiSection: Boolean(section) };
        const ai = current !== undefined && msg.mode === "ai";
        vaultLog("PUT", path);
        window.__mockVault[path] = MdgNote.upsertAiSection(ai ? current : msg.page?.markdown || `# ${msg.ref.title}\n\n字幕正文\n`, section);
        notePaths[key] = path;
        return { ok: true, path, kind: ai ? "ai" : "full", text: `${ai ? "已更新 AI 问答" : "已写入 Obsidian"}：${path}` };
      }
      case "sync-video-note-ai": {
        if (window.__mockObsidianDown) return { ok: false, error: "连不上 Obsidian，请确认它已打开并启用了 Local REST API", code: "OBSIDIAN_DOWN" };
        const path = notePaths[MdgSites.buildContextKey(msg.ref)];
        if (!path) return { ok: true, path: "" };
        vaultLog("GET", path);
        const current = window.__mockVault[path];
        if (current === undefined) return { ok: true, path, exists: false, updated: false };
        const next = MdgNote.upsertAiSection(current, MdgNote.buildAiSection(MdgNote.buildConversationTurns(msg.conversation?.messages)));
        if (next !== current) {
          vaultLog("PUT", path);
          window.__mockVault[path] = next;
        }
        return { ok: true, path, exists: true, updated: next !== current, text: `已更新 AI 问答：${path}` };
      }
      case "ai-providers-list":
        return { ok: true, providers: params.get("providers") === "0" ? [] : [demo ? { id: "p1", name: "DeepSeek", model: "deepseek-flash", enabled: true } : { id: "p1", name: "Mock", model: "claude-sonnet-4-5-20250929", enabled: true }] };
      case "get-settings":
        return { ok: true, settings: mockSettings };
      case "save-settings":
        return { ok: true };
      case "ai-sidepanel-get-state": {
        if (window.__mockStateError) return { ok: false, error: window.__mockStateError };
        const video = findVideo(tab.url);
        // Like background.js, an unsupported page answers with a non-video context built from the tab.
        return video
          ? { ok: true, payload: payloadFor(video) }
          : { ok: true, payload: { title: tab.title || "", url: tab.url || "", subtitleMarkdown: "", hotComments: [], isVideoContext: false } };
      }
      case "ai-sidepanel-resolve-context": {
        const video = videos.find((v) => v.bvid === (msg.contextRef?.videoId || msg.contextRef?.bvid));
        return video ? { ok: true, payload: payloadFor(video) } : { ok: false, error: "not found" };
      }
      case "ai-sidepanel-resolve-page-ref":
        sessionStorage.setItem("__mock_resolve_page_ref", String(Number(sessionStorage.getItem("__mock_resolve_page_ref") || 0) + 1));
        return { ok: true, payload: { url: msg.contextRef?.url, cid: msg.contextRef?.cid, pageIndex: 1 } };
      default:
        return { ok: false, error: `mock: unhandled ${msg?.type}` };
    }
  };

  const onUpdated = makeEvent();
  const runtimeOnMessage = makeEvent();

  window.chrome = {
    tabs: {
      query: async () => [{ ...tab }],
      get: async () => ({ ...tab }),
      update: async (_id, { url }) => {
        tab.url = url;
        setTimeout(() => onUpdated._fire(tab.id, { url }, { ...tab }), 10);
        return { ...tab };
      },
      sendMessage: (_id, msg, cb) => {
        // The video page's popup-refresh: its note, as the side panel's 写入 Obsidian sends it on.
        const video = msg?.type === "popup-refresh" && findVideo(tab.url);
        setTimeout(() => cb?.(video ? { ok: true, payload: { url: tab.url, markdown: `# ${video.title}\n\n字幕正文\n`, cover: "" } } : { ok: true }), 10);
      },
      onUpdated,
      onActivated: makeEvent()
    },
    runtime: {
      lastError: undefined,
      openOptionsPage: () => console.log("[mock] openOptionsPage"),
      onMessage: runtimeOnMessage,
      sendMessage(msg, cb) {
        const resp = handleMessage(msg);
        const delay = msg?.type === "ai-sidepanel-get-state" ? window.__mockStateDelayMs || 30 : 30;
        if (typeof cb === "function") {
          setTimeout(() => cb(resp), delay);
          return undefined;
        }
        return new Promise((resolve) => setTimeout(() => resolve(resp), delay));
      },
      connect() {
        const onMessage = makeEvent();
        const onDisconnect = makeEvent();
        let timer = 0;
        let disconnected = false;
        const post = (m) => !disconnected && setTimeout(() => !disconnected && onMessage._fire(m), 0);
        return {
          onMessage,
          onDisconnect,
          postMessage(msg) {
            if (msg.action === "stop") {
              clearInterval(timer);
              post({ type: "stopped", reason: "已停止生成" });
              return;
            }
            if (msg.action !== "chat") return;
            if (window.__mockHostDenied) {
              post({ type: "error", error: "未授权访问 https://api.example.com，授权后重试", code: "AI_ACCESS" });
              return;
            }
            window.__mockStreamLog = window.__mockStreamLog || [];
            window.__mockStreamLog.push({ prompt: msg.prompt, contextTitle: msg.context?.title, subtitle: msg.context?.subtitleMarkdown });
            if (window.__mockNotice) {
              post({ type: "notice", text: window.__mockNotice });
            }
            const end = window.__mockStreamEnd;
            let i = 0;
            timer = setInterval(() => {
              if (end && i >= end.after) {
                clearInterval(timer);
                if (end.disconnect) {
                  disconnected = true;
                  onDisconnect._fire();
                } else {
                  post({ type: "error", error: end.error });
                }
                return;
              }
              if (i >= TOKEN_COUNT) {
                clearInterval(timer);
                post({ type: "done" });
                return;
              }
              post({ type: "token", data: i === 0 ? `关于「${msg.context?.title}」的回复：` : `片段${i} ` });
              i += 1;
            }, window.__mockTokenMs || TOKEN_MS);
          },
          disconnect() {
            disconnected = true;
            clearInterval(timer);
          }
        };
      }
    },
    permissions: {
      async request(req) {
        (window.__mockPermissionRequests ||= []).push(req);
        window.__mockHostDenied = false;
        return true;
      }
    },
    storage: {
      local: makeArea(localStorage, "__mock_storage_local"),
      sync: makeArea(localStorage, "__mock_storage_sync"),
      session: makeArea(sessionStorage, "__mock_storage_session"),
      onChanged: makeEvent()
    }
  };

  window.__mockVideos = videos;
  window.__mockTab = tab;
  window.__mockSwitchVideo = (n, { notify = true } = {}) => {
    const video = videos[n - 1];
    tab.url = video.url;
    tab.title = tabTitle(video);
    onUpdated._fire(tab.id, { url: video.url }, { ...tab });
    if (notify) {
      runtimeOnMessage._fire({ type: "mdg-video-changed", url: video.url }, { tab: { id: tab.id } });
    }
  };
  window.__mockOpenPage = (url, title = "") => {
    Object.assign(tab, { url, title });
    chrome.tabs.onActivated._fire({ tabId: tab.id });
  };
  window.__mockReset = () => {
    localStorage.clear();
    sessionStorage.clear();
  };
})();
