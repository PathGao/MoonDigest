// 侧边栏开发用 mock chrome：模拟 B 站视频标签页、三个视频上下文、一个 AI 平台和慢速流式回复。
// window.__mockSwitchVideo(n) 切到第 n 个视频（改 URL + tabs.onUpdated + boc-video-changed）。
// window.__mockOpenPage(url, title) 切到非视频标签页（url 为空即加载中的标签页）；__mockStateDelayMs 模拟字幕和评论加载耗时。
// 流的结局：__mockStreamEnd = { after: n, error: "..." } 在第 n 个 token 后报错；{ after: n, disconnect: true } 模拟后台断开。
// __mockNotice 先发一条 notice；__mockTokenMs 调慢流速。
(() => {
  const makeEvent = () => {
    const listeners = [];
    return {
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => listeners.splice(listeners.indexOf(fn) >>> 0, 1),
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
  const tabTitle = (video) => `${video.title}_哔哩哔哩_bilibili`;
  const tab = { id: 1, active: true, status: "complete", url: videos[0].url, title: tabTitle(videos[0]) };
  const TOKEN_COUNT = 20;
  const TOKEN_MS = 80;

  const findVideo = (url) => videos.find((v) => String(url || "").includes(v.bvid));
  const payloadFor = (video) => ({
    ...video,
    pageIndex: 1,
    pageCount: 1,
    subtitleMarkdown: `字幕 ${video.title}`,
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
  const presetCount = Number(new URLSearchParams(location.search).get("presets")) || 0;
  const presetPrompts = presetCount
    ? Array.from({ length: presetCount }, (_, i) => ["用 3 句话总结这个视频", "提炼这个视频的 5 个重点", "按章节整理视频内容", "这个视频的核心论点是什么，有哪些论据支撑"][i % 4] + (i >= 4 ? ` ${i + 1}` : ""))
    : ["用 3 句话总结这个视频", "提炼这个视频的 5 个重点", "按章节整理视频内容"];

  const handleMessage = (msg) => {
    switch (msg?.type) {
      case "ai-providers-list":
        return { ok: true, providers: [{ id: "p1", name: "Mock", model: "mock-model", enabled: true }] };
      case "get-settings":
        return { ok: true, settings: { playerAiQuickPrompt: "整理这期视频的内容，输出结构化总结。", aiPresetPrompts: presetPrompts } };
      case "save-settings":
        return { ok: true };
      case "ai-sidepanel-get-state": {
        const video = findVideo(tab.url);
        // Like background.js, an unsupported page answers with a non-video context built from the tab.
        return video
          ? { ok: true, payload: payloadFor(video) }
          : { ok: true, payload: { title: tab.title || "", url: tab.url || "", subtitleMarkdown: "", hotComments: [], isVideoContext: false } };
      }
      case "ai-sidepanel-resolve-context": {
        const video = videos.find((v) => v.bvid === msg.contextRef?.bvid);
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
      sendMessage: (_id, _msg, cb) => setTimeout(() => cb?.({ ok: true }), 10),
      onUpdated,
      onActivated: makeEvent()
    },
    runtime: {
      lastError: undefined,
      getURL: (p) => `../${p}`,
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
              post({ type: "error", error: "未授权访问 https://api.example.com，授权后重试" });
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
      runtimeOnMessage._fire({ type: "boc-video-changed", url: video.url }, { tab: { id: tab.id } });
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
