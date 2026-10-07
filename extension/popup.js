const el = {
  status: document.getElementById("status"),
  videoCover: document.getElementById("videoCover"),
  videoDuration: document.getElementById("videoDuration"),
  videoTitle: document.getElementById("videoTitle"),
  videoMeta: document.getElementById("videoMeta"),
  propTitle: document.getElementById("propTitle"),
  propUrl: document.getElementById("propUrl"),
  propCreated: document.getElementById("propCreated"),
  propTags: document.getElementById("propTags"),
  subtitleSelect: document.getElementById("subtitleSelect"),
  preview: document.getElementById("preview"),
  refreshBtn: document.getElementById("refreshBtn"),
  copyBtn: document.getElementById("copyBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  mdBtn: document.getElementById("mdBtn"),
  sendBtn: document.getElementById("sendBtn"),
  summaryBtn: document.getElementById("summaryBtn"),
  triageBtn: document.getElementById("triageBtn"),
  triageHint: document.getElementById("triageHint"),
  historyBtn: document.getElementById("historyBtn"),
  readingViewBtn: document.getElementById("readingViewBtn"),
  settingsBtn: document.getElementById("settingsBtn")
};

let latestPayload = null;
const DEFAULT_SETTINGS = {
  downloadFormat: "srt"
};

function formatLocalDate(value = Date.now()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

init().catch((error) => {
  setStatus(`初始化失败：${error.message}`, true);
});

async function init() {
  bindEvents();
  getSettingsFromRuntime().then((settings) => {
    el.sendBtn.hidden = settings.obsidianEnabled !== true;
  });
  getActiveTab().then((tab) => {
    // Any bilibili host, so favorites pages on space.bilibili.com count too.
    el.triageHint.hidden = /(^|\.)bilibili\.com$/.test(URL.parse(tab?.url || "")?.hostname || "");
  });
  await refreshFromTab();
}

function bindEvents() {
  // A cover that fails to load leaves the colored placeholder behind it.
  el.videoCover.addEventListener("error", () => {
    el.videoCover.hidden = true;
  });
  el.refreshBtn.addEventListener("click", async () => {
    await refreshFromTab();
  });

  el.copyBtn.addEventListener("click", async () => {
    const payload = await ensurePayload();
    if (!payload?.markdown) {
      setStatus("没有可复制内容，请先刷新", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(payload.markdown);
      setStatus("已复制 Markdown");
    } catch (error) {
      setStatus(`复制失败：${error?.message || "无法访问剪贴板"}`, true);
    }
  });

  el.downloadBtn.addEventListener("click", async () => {
    const payload = await ensurePayload();
    const settings = await getSettingsFromRuntime();
    const format = normalizeDownloadFormat(settings?.downloadFormat || payload?.downloadFormat);
    const content =
      format === "txt" ? payload?.txt || payload?.subtitlePreview || "" : payload?.srt || "";
    if (!content) {
      setStatus("没有可下载字幕", true);
      return;
    }
    const safeTitle = sanitizeFileName(payload.title || "video-subtitle");
    BocDownload.text(`${safeTitle}.${format}`, content, "text/plain;charset=utf-8");
    setStatus(`已下载 ${format.toUpperCase()}`);
  });

  el.mdBtn.addEventListener("click", async () => {
    const payload = await ensurePayload();
    if (!payload?.markdown) {
      setStatus("没有可下载内容，请先刷新", true);
      return;
    }
    BocDownload.text(`${sanitizeFileName(payload.title || "video-subtitle")}.md`, payload.markdown);
    setStatus("已下载 .md");
  });

  el.sendBtn.addEventListener("click", async () => {
    setStatus("正在写入 Obsidian…", false, true);
    setBusy(el.sendBtn, true, "写入中…");
    const resp = await sendToContent({ type: "popup-send-obsidian" }).finally(() => setBusy(el.sendBtn, false));
    if (!resp?.ok) {
      setStatus(`写入 Obsidian 失败：${resp?.error || "未知错误"}`, true);
    }
    render(resp?.payload || latestPayload, { preserveStatus: !resp?.ok });
  });

  el.readingViewBtn?.addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!isSupportedSubtitlePage(tab?.url || "")) {
      setStatus("请先打开一个支持的视频页", true);
      return;
    }

    setStatus("正在打开专注模式…", false, true);
    setBusy(el.readingViewBtn, true, "打开中…");
    const prepResp = await sendToContent({ type: "popup-get-state" }).catch((error) => ({ ok: false, error: error.message }));
    if (!prepResp?.ok) {
      setBusy(el.readingViewBtn, false);
      setStatus(prepResp?.error || "当前网页不支持，或需刷新重试", true);
      return;
    }

    const resp = await sendToRuntime({
      type: "open-reading-view-tab",
      url: tab.url,
      tabId: tab.id
    }).catch((error) => ({ ok: false, error: error.message }));
    setBusy(el.readingViewBtn, false);
    if (!resp?.ok) {
      setStatus(`打开失败：${resp?.error || "未知错误"}`, true);
      return;
    }
    setStatus("专注模式已打开");
    window.setTimeout(() => window.close(), 80);
  });

  el.subtitleSelect.addEventListener("change", async (event) => {
    const option = event.target.options[event.target.selectedIndex];
    const url = String(option?.value || "");
    if (!url) {
      return;
    }
    setStatus("正在切换字幕…", false, true);
    const resp = await sendToContent({
      type: "popup-select-subtitle",
      url,
      lang: String(option.dataset.lang || "unknown"),
      subtitleId: String(option.dataset.id || "")
    });
    if (!resp?.ok) {
      setStatus(`切换失败：${resp?.error || "未知错误"}`, true);
    }
    render(resp?.payload || latestPayload, { preserveStatus: !resp?.ok });
  });

  el.settingsBtn.addEventListener("click", async () => {
    await sendToRuntime({ type: "open-options" });
  });

  el.summaryBtn.addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!isSupportedSubtitlePage(tab?.url || "")) {
      setStatus("请先打开一个支持的视频页", true);
      return;
    }
    setStatus("正在打开侧边栏…", false, true);
    setBusy(el.summaryBtn, true, "打开中…");
    // A video that already has a conversation only gets the panel, which restores that conversation.
    if (await hasConversationFor(tab.url)) {
      try {
        await chrome.sidePanel.open({ tabId: tab.id });
        window.setTimeout(() => window.close(), 80);
      } catch (error) {
        setBusy(el.summaryBtn, false);
        setStatus(`打开侧边栏失败：${error?.message || error}`, true);
      }
      return;
    }
    // Same path as the player AI button: background opens the side panel and queues the one-click prompt.
    const resp = await sendToRuntime({ type: "player-ai-quick-action", tabId: tab.id, source: "popup" }).catch((error) => ({ ok: false, error: error.message }));
    if (!resp?.ok) {
      setBusy(el.summaryBtn, false);
      setStatus(`打开侧边栏失败：${resp?.error || "未知错误"}`, true);
      return;
    }
    window.setTimeout(() => window.close(), 80);
  });

  el.triageBtn.addEventListener("click", async () => {
    const r = await sendToRuntime({ type: "triage-open" }).catch(() => null);
    if (!r?.ok) await chrome.tabs.create({ url: chrome.runtime.getURL("triage/triage.html") });
    window.close();
  });
  el.historyBtn.addEventListener("click", async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL("history/history.html") });
    window.close();
  });
}

async function refreshFromTab() {
  setStatus("正在抓取字幕…", false, true);
  setBusy(el.refreshBtn, true);
  const resp = await sendToContent({ type: "popup-refresh" }).finally(() => setBusy(el.refreshBtn, false));
  el.refreshBtn.classList.toggle("is-error", !resp?.ok);
  if (!resp?.ok) {
    const errorText = resp?.error || "请在支持的视频页使用";
    setStatus(`抓取失败：${errorText}`, true);
    render(resp?.payload || latestPayload, { preserveStatus: true });
    return;
  }
  render(resp?.payload || latestPayload);
}

// Same video and part as the side panel's own match (doesTabMatchContextUrl).
async function hasConversationFor(url) {
  const ref = BocSites.parseRef(url);
  const key = BocLimits.KEYS.aiConversations;
  const list = (await chrome.storage.local.get(key).catch(() => ({})))[key];
  return Boolean(ref) && Array.isArray(list) && list.some((item) => {
    const other = BocSites.parseRef(item?.contextUrl || item?.contextRef?.url || "");
    return other?.site === ref.site && other.id === ref.id && (other.part?.index || 1) === (ref.part?.index || 1);
  });
}

async function ensurePayload() {
  if (latestPayload) {
    return latestPayload;
  }
  const resp = await sendToContent({ type: "popup-get-state" });
  if (resp?.ok && resp.payload) {
    latestPayload = resp.payload;
  }
  return latestPayload;
}

function render(payload, { preserveStatus = false } = {}) {
  if (!payload) {
    return;
  }
  latestPayload = payload;

  if (!preserveStatus) {
    const statusText = String(payload.status || "准备就绪");
    const isErrorStatus = /失败|错误|不可用|不支持/.test(statusText);
    setStatus(statusText, isErrorStatus);
  }
  if (payload.message && !preserveStatus) {
    setStatus(payload.message, /失败|错误|不可用|不支持|请先/.test(payload.message));
  }

  setText(el.propTitle, payload.title || "-");
  setText(el.propUrl, payload.url || "-");
  setText(el.propCreated, formatLocalDate());
  setText(el.propTags, payload.tags || "MoonDigest");
  el.propTitle.title = payload.title || "";
  setText(el.videoTitle, payload.title);
  el.videoTitle.title = payload.title || "";
  setText(el.videoMeta, [payload.author, payload.uploadDate].filter(Boolean).join(" · "));
  if (el.videoCover.getAttribute("src") !== (payload.cover || null)) {
    if (payload.cover) el.videoCover.src = payload.cover;
    else el.videoCover.removeAttribute("src");
    el.videoCover.hidden = !payload.cover;
  }
  setText(el.videoDuration, formatDuration(payload.duration));
  el.videoDuration.hidden = !el.videoDuration.textContent;
  el.propUrl.title = payload.url || "";

  const options = payload.subtitleOptions || [];
  if (options.length === 0) {
    el.subtitleSelect.innerHTML = '<option value="">暂无字幕</option>';
    el.subtitleSelect.disabled = true;
  } else {
    el.subtitleSelect.innerHTML = options
      .map((item) => {
        const selected = item.selected ? "selected" : "";
        return `<option value="${escapeHtml(item.url)}" data-id="${escapeHtml(
          item.id || ""
        )}" data-lang="${escapeHtml(item.lang || "")}" ${selected}>${escapeHtml(
          item.optionLabel || item.lang || "unknown"
        )}</option>`;
      })
      .join("");
    el.subtitleSelect.disabled = false;
  }

  el.preview.value = payload.subtitlePreview || "";
  el.preview.hidden = !el.preview.value;
}

function formatDuration(seconds) {
  const total = Math.floor(Number(seconds) || 0);
  if (total <= 0) return "";
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const ss = String(total % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function setText(node, text) {
  node.textContent = String(text || "");
}

function setStatus(text, isError = false, busy = false) {
  el.status.textContent = String(text || "");
  el.status.classList.toggle("is-error", Boolean(isError));
  el.status.setAttribute("aria-busy", String(busy));
}

// Shared busy look from tokens.css: disabled, spinner, and the label (if any) says 「…中」 until done.
function setBusy(button, busy, label = "") {
  if (busy && label) {
    button.dataset.label = button.innerHTML;
    button.textContent = label;
  } else if (!busy && button.dataset.label) {
    button.innerHTML = button.dataset.label;
    delete button.dataset.label;
  }
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

function sanitizeFileName(value) {
  return String(value || "subtitle")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function normalizeDownloadFormat(value) {
  return value === "txt" ? "txt" : "srt";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

async function sendToContent(message) {
  const tab = await getActiveTab();
  const tabId = tab?.id || null;
  if (!tabId) {
    throw new Error("找不到当前标签页");
  }

  try {
    return await sendMessageToTab(tabId, message);
  } catch (error) {
    if (shouldRetryAfterInjection(error) && isSupportedSubtitlePage(tab?.url || "")) {
      try {
        await ensureContentScriptReady(tabId);
        await sleep(80);
        return await sendMessageToTab(tabId, message);
      } catch (retryError) {
        error = retryError;
      }
    }

    const normalizedError = normalizeContentErrorMessage(error);
    setStatus(normalizedError, true);
    return { ok: false, error: normalizedError, payload: latestPayload };
  }
}

function normalizeContentErrorMessage(error) {
  const message = String(error?.message || "").trim();
  if (message.includes("Could not establish connection. Receiving end does not exist.")) {
    return "当前网页不支持，或需刷新重试";
  }
  return message || "未知错误";
}

function shouldRetryAfterInjection(error) {
  const message = String(error?.message || "");
  return message.includes("Could not establish connection. Receiving end does not exist.");
}

function isSupportedSubtitlePage(url) {
  return Boolean(BocSites.matchSite(url));
}

async function ensureContentScriptReady(tabId) {
  const resp = await chrome.runtime.sendMessage({ type: "ensure-reader-content", tabId });
  if (!resp?.ok) {
    throw new Error(resp?.error || "扩展刚刚更新，请刷新网页重试");
  }
}

async function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

async function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function sendToRuntime(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

async function getSettingsFromRuntime() {
  try {
    const resp = await sendToRuntime({ type: "get-settings" });
    if (!resp?.ok) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...(resp.settings || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
