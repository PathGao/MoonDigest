const { escapeHtml } = MdgErrors;
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
  historyBtn: document.getElementById("historyBtn"),
  readingViewBtn: document.getElementById("readingViewBtn"),
  settingsBtn: document.getElementById("settingsBtn")
};

const NOT_VIDEO_PAGE = MdgErrors.TEXT.notVideoPage;
let latestPayload = null;
// Set from the tab's URL in init(): a content script that still answers on a non-video page must not re-enable the tools.
let onVideoPage = true;
// Only for when get-settings fails.
const DEFAULT_SETTINGS = MdgSettings.DEFAULTS;
const setDisabledReason = MdgErrors.setReason;
// After 专注模式 or the side panel opened: long enough for the status to show before the popup closes.
const CLOSE_DELAY_MS = 80;


init().catch((error) => {
  console.error(error);
  setStatus(`${MdgErrors.TEXT.initFailed}：${error.message}`, true);
});

async function init() {
  bindEvents();
  const tab = await getActiveTab();
  onVideoPage = isSupportedSubtitlePage(tab?.url || "");
  getSettingsFromRuntime().then((settings) => {
    el.sendBtn.hidden = !settings.obsidianEnabled;
  });
  // A web page has nothing to read: say so instead of a failed fetch.
  if (!onVideoPage) {
    syncTools(null, false);
    setDisabledReason(el.refreshBtn, NOT_VIDEO_PAGE);
    setStatus(NOT_VIDEO_PAGE);
    return;
  }
  // Opening shows the video as the page has it (starting a read only when nothing is loaded); 刷新 reads it again.
  await refreshFromTab();
}

function bindEvents() {
  // A cover that fails to load leaves the colored placeholder behind it.
  el.videoCover.addEventListener("error", () => {
    el.videoCover.hidden = true;
  });
  el.refreshBtn.addEventListener("click", async () => {
    await refreshFromTab(true);
  });

  el.copyBtn.addEventListener("click", async () => {
    const payload = await ensurePayload();
    if (!payload) return; // the status says why the page did not answer
    if (!payload.markdown) {
      setStatus(MdgErrors.TEXT.noNoteYet, true);
      return;
    }
    try {
      await navigator.clipboard.writeText(payload.markdown);
      setStatus(MdgErrors.TEXT.copied);
    } catch (error) {
      setStatus(`${MdgErrors.TEXT.copyFailed}：${error?.message || MdgErrors.TEXT.noClipboard}`, true);
    }
  });

  el.downloadBtn.addEventListener("click", async () => {
    const payload = await ensurePayload();
    if (!payload) return;
    const settings = await getSettingsFromRuntime();
    const format = MdgSettings.normalizeDownloadFormat(settings.downloadFormat);
    const content =
      format === "txt" ? payload.txt || payload.subtitlePreview || "" : payload.srt || "";
    if (!content) {
      setStatus(payload.subtitleMissing || MdgErrors.subtitleMissing(), true);
      return;
    }
    const safeTitle = MdgCommon.fileName(payload.title, "video-subtitle");
    MdgDownload.text(`${safeTitle}.${format}`, content, "text/plain;charset=utf-8");
    setStatus(`已下载 ${format.toUpperCase()}`);
  });

  el.mdBtn.addEventListener("click", async () => {
    const payload = await ensurePayload();
    if (!payload) return;
    if (!payload.markdown) {
      setStatus(MdgErrors.TEXT.noNoteYet, true);
      return;
    }
    // Named like the note 写入 Obsidian writes (date prefix setting, 分 P): the content script builds it.
    MdgDownload.text(payload.filename, payload.markdown);
    setStatus("已下载 .md");
  });

  el.sendBtn.addEventListener("click", async () => {
    setStatus(MdgErrors.TEXT.obsidianWriting, false, true);
    setBusy(el.sendBtn, true, MdgErrors.TEXT.writing);
    const resp = await sendToContent({ type: "popup-send-obsidian" }).finally(() => setBusy(el.sendBtn, false));
    // The page answers with the result's words (text); without them the message never reached it.
    const text = resp?.text || (resp?.ok ? "" : `${MdgErrors.TEXT.obsidianFailed}：${MdgErrors.text(resp)}`);
    if (text) setStatus(text, !resp?.ok);
    render(resp?.payload || latestPayload, { preserveStatus: Boolean(text) });
  });

  el.readingViewBtn?.addEventListener("click", async () => {
    // A web page has this and AI 总结 disabled (syncTools), so the tab is a video page here.
    const tab = await getActiveTab();
    setStatus("正在打开专注模式…", false, true);
    setBusy(el.readingViewBtn, true, "打开中…");
    const prepResp = await sendToContent({ type: "popup-get-state" }).catch((error) => ({ ok: false, error: error.message }));
    if (!prepResp?.ok) {
      setBusy(el.readingViewBtn, false);
      setStatus(`${MdgErrors.TEXT.readerStartFailed}：${MdgErrors.text(prepResp, MdgErrors.TEXT.reloadRetry)}`, true);
      return;
    }

    const resp = await sendToRuntime({
      type: "open-reading-view-tab",
      url: tab.url,
      tabId: tab.id
    }).catch((error) => ({ ok: false, error: error.message }));
    setBusy(el.readingViewBtn, false);
    if (!resp?.ok) {
      setStatus(`${MdgErrors.TEXT.readerStartFailed}：${MdgErrors.text(resp)}`, true);
      return;
    }
    setStatus("专注模式已打开");
    window.setTimeout(() => window.close(), CLOSE_DELAY_MS);
  });

  el.subtitleSelect.addEventListener("change", async (event) => {
    const option = event.target.options[event.target.selectedIndex];
    const url = String(option?.value || "");
    if (!url) {
      return;
    }
    setStatus("正在切换字幕…", false, true);
    const resp = await sendToContent({ type: "popup-select-subtitle", url });
    if (!resp?.ok) {
      setStatus(`${MdgErrors.TEXT.subtitleSwitchFailed}：${MdgErrors.text(resp)}`, true);
    }
    render(resp?.payload || latestPayload, { preserveStatus: !resp?.ok });
  });

  el.settingsBtn.addEventListener("click", async () => {
    await sendToRuntime({ type: "open-options" });
  });

  el.summaryBtn.addEventListener("click", async () => {
    const tab = await getActiveTab();
    setStatus(MdgErrors.TEXT.sidepanelOpening, false, true);
    setBusy(el.summaryBtn, true, "打开中…");
    // Same path as the player AI button: background opens the side panel and queues the request; the panel shows the
    // video's conversation when it has one, else fills the one-click prompt.
    const resp = await sendToRuntime({ type: "player-ai-quick-action", tabId: tab.id, source: "popup" }).catch((error) => ({ ok: false, error: error.message }));
    if (!resp?.ok) {
      setBusy(el.summaryBtn, false);
      setStatus(`${MdgErrors.TEXT.sidepanelOpenFailed}：${MdgErrors.text(resp)}`, true);
      return;
    }
    window.setTimeout(() => window.close(), CLOSE_DELAY_MS);
  });

  el.triageBtn.addEventListener("click", async () => {
    const r = await sendToRuntime({ type: "triage-open" }).catch(() => null);
    if (!r?.ok) await chrome.tabs.create({ url: chrome.runtime.getURL(MdgCommon.PAGES.triage) });
    window.close();
  });
  el.historyBtn.addEventListener("click", async () => {
    const r = await sendToRuntime({ type: "history-open" }).catch(() => null);
    if (!r?.ok) await chrome.tabs.create({ url: chrome.runtime.getURL(MdgCommon.PAGES.history) });
    window.close();
  });
}

async function refreshFromTab(force = false) {
  setStatus(MdgErrors.TEXT.videoReading, false, true);
  setBusy(el.refreshBtn, true);
  const resp = await sendToContent({ type: "popup-refresh", refresh: force }).finally(() => setBusy(el.refreshBtn, false));
  el.refreshBtn.classList.toggle("is-error", !resp?.ok);
  if (!resp?.ok) {
    // init() already turned non-video pages away: a reply without words is no 不是视频页.
    setStatus(`${MdgErrors.TEXT.videoReadFailed}：${MdgErrors.text(resp)}`, true);
    render(resp?.payload || latestPayload, { preserveStatus: true });
    return;
  }
  render(resp?.payload || latestPayload);
}

async function ensurePayload() {
  if (latestPayload) {
    return latestPayload;
  }
  const resp = await sendToContent({ type: "popup-get-state" });
  if (resp?.ok && resp.payload) {
    latestPayload = resp.payload;
  } else if (!resp?.ok) {
    setStatus(MdgErrors.text(resp, MdgErrors.TEXT.reloadRetry), true);
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
  setText(el.propCreated, MdgCommon.localDate());
  setText(el.propTags, payload.tags || "-");
  el.propTitle.title = payload.title || "";
  setText(el.videoTitle, payload.title);
  el.videoTitle.title = payload.title || "";
  setText(el.videoMeta, [payload.author, payload.uploadDate].filter(Boolean).join(" · "));
  if (el.videoCover.getAttribute("src") !== (payload.cover || null)) {
    if (payload.cover) el.videoCover.src = payload.cover;
    else el.videoCover.removeAttribute("src");
    el.videoCover.hidden = !payload.cover;
  }
  setText(el.videoDuration, payload.duration > 0 ? TriageUi.fmtDuration(payload.duration) : "");
  el.videoDuration.hidden = !el.videoDuration.textContent;
  el.propUrl.title = payload.url || "";

  const options = payload.subtitleOptions || [];
  if (options.length === 0) {
    el.subtitleSelect.innerHTML = `<option value="">${escapeHtml(payload.subtitleMissing || MdgErrors.subtitleMissing())}</option>`;
    el.subtitleSelect.disabled = true;
  } else {
    // No track loaded: the reason (the page's noTrackText), not the first track shown as current.
    const none = options.some((item) => item.selected)
      ? ""
      : `<option value="" selected disabled>${escapeHtml(payload.subtitleMissing || MdgErrors.subtitleMissing())}</option>`;
    el.subtitleSelect.innerHTML = none + options
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
  syncTools(payload, onVideoPage);
}

// A tool that cannot work is disabled and says why; without a payload yet a video page keeps them usable.
function syncTools(payload, onVideoPage = true) {
  const pageReason = onVideoPage ? "" : NOT_VIDEO_PAGE;
  const contentReason = pageReason || (payload && !payload.markdown ? MdgErrors.TEXT.noNoteYet : "");
  const subtitleReason = pageReason || (payload && !(payload.srt || payload.txt) ? payload.subtitleMissing || MdgErrors.subtitleMissing() : "");
  setDisabledReason(el.readingViewBtn, pageReason);
  // A web page has no video to summarize; no AI platform still leaves it usable (the side panel offers 去设置).
  setDisabledReason(el.summaryBtn, pageReason);
  setDisabledReason(el.copyBtn, contentReason);
  setDisabledReason(el.mdBtn, contentReason);
  setDisabledReason(el.sendBtn, contentReason);
  setDisabledReason(el.downloadBtn, subtitleReason);
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

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

async function sendToContent(message) {
  const tab = await getActiveTab();
  const tabId = tab?.id || null;
  // An answer like any other failure: every caller shows it and ends its busy state.
  if (!tabId) {
    setStatus(MdgErrors.TEXT.noTab, true);
    return { ok: false, error: MdgErrors.TEXT.noTab, payload: latestPayload };
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

// Chrome's own messaging errors (no content script, the page closed the port, the tab went away) are English and all
// mean the page's copy of the extension did not answer; our own reasons pass through.
function normalizeContentErrorMessage(error) {
  if (error?.chrome) return MdgErrors.TEXT.reloadRetry;
  return String(error?.message || "").trim() || MdgErrors.TEXT.unknown;
}

function shouldRetryAfterInjection(error) {
  return String(error?.message || "").includes("Could not establish connection. Receiving end does not exist.");
}

function isSupportedSubtitlePage(url) {
  return Boolean(MdgSites.matchSite(url));
}

async function ensureContentScriptReady(tabId) {
  const resp = await chrome.runtime.sendMessage({ type: "ensure-reader-content", tabId });
  if (!resp?.ok) {
    throw MdgErrors.fromResp(resp, MdgErrors.TEXT.reloaded);
  }
}

async function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(Object.assign(new Error(chrome.runtime.lastError.message), { chrome: true }));
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
