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
const WEB_PAGE_READING = "正在读取网页…";
let latestPayload = null;
// 刷新 and the subtitle pick each wait for the page: the newest action's reply is drawn, an older one that lands after it
// is dropped.
const replies = MdgCommon.latest();
// On a web page: its note from the background (popup-page-note), { ref, filename, markdown }; null until read or when
// the page cannot be read (the note's tools are disabled with the reason).
let webNote = null;
let webTabId = 0; // the web page's tab, which 刷新 reads again; 0 on a video page
// Set from the tab's URL in init(): a content script that still answers on a non-video page must not re-enable the tools.
let onVideoPage = true;
// The settings asked for as the popup opens: a web page's read says 写入 Obsidian only when it is on. null again after a
// failed read, so the next use asks again.
let settingsLoad = null;
const setDisabledReason = MdgErrors.setReason;
// After 专注模式 or the side panel opened: long enough for the status to show before the popup closes.
const CLOSE_DELAY_MS = 80;
// Whether 写入 Obsidian showed last time: the settings come from the background after the first paint, so the button
// takes its place from this one at once and the tools row does not reflow as the popup opens.
const OBSIDIAN_SHOWN_KEY = "mdg_popup_obsidian_shown";
try {
  el.sendBtn.hidden = localStorage.getItem(OBSIDIAN_SHOWN_KEY) !== "1";
} catch {}


init().catch((error) => {
  console.error(error);
  setStatus(`${MdgErrors.TEXT.initFailed}：${error.message}`, true);
});

async function init() {
  bindEvents();
  const tab = await MdgSites.activeTab();
  onVideoPage = Boolean(MdgSites.matchPage(tab?.url || ""));
  settingsLoad = getSettingsFromRuntime();
  settingsLoad.then(
    (settings) => {
      el.sendBtn.hidden = !settings.obsidianEnabled;
      try {
        localStorage.setItem(OBSIDIAN_SHOWN_KEY, settings.obsidianEnabled ? "1" : "0");
      } catch {}
    },
    () => (settingsLoad = null)
  );
  // Not a video page: nothing to read here, said instead of a failed fetch. A tab that is not even a web page
  // (chrome://, file:) is said as the side panel says it; on a web page only the video tools say NOT_VIDEO_PAGE.
  if (!onVideoPage) {
    const webPage = /^https?:\/\//i.test(tab?.url || "");
    const reason = webPage ? NOT_VIDEO_PAGE : MdgErrors.TEXT.pageUnsupported;
    syncTools(null, reason);
    setDisabledReason(el.refreshBtn, reason);
    // An ordinary web page (its URL shows because the icon was clicked: activeTab, which also lets the background read
    // it): AI 总结 opens the side panel, the note's tools take the side panel's note; the video's are hidden (popup.css .web-page).
    if (webPage) {
      document.body.classList.add("web-page");
      setDisabledReason(el.summaryBtn, "");
      // 刷新 reads the page again, as a video's does: a read that timed out or found no text yet may work now.
      setDisabledReason(el.refreshBtn, "");
      webTabId = tab.id;
      setText(el.videoTitle, tab.title || tab.url);
      setText(el.videoMeta, new URL(tab.url).hostname);
      await readWebNote(tab.id);
      return;
    }
    setStatus(reason);
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
    await (webTabId ? readWebNote(webTabId) : refreshFromTab(true));
  });

  el.copyBtn.addEventListener("click", async () => {
    // A web page's tools are disabled until its note is read.
    const payload = onVideoPage ? await ensurePayload() : webNote;
    if (!payload) return; // the status says why the page did not answer
    if (!payload.markdown) {
      setStatus(MdgErrors.TEXT.noNoteYet, true);
      return;
    }
    const r = await MdgNoteActions.run("copy", { note: payload });
    setStatus(r.text, !r.ok);
  });

  el.downloadBtn.addEventListener("click", async () => {
    const payload = await ensurePayload();
    if (!payload) return;
    let settings;
    try {
      settings = await (settingsLoad || getSettingsFromRuntime());
    } catch (error) {
      setStatus(settingsFailed(error), true);
      return;
    }
    const format = MdgSettings.normalizeDownloadFormat(settings.downloadFormat);
    const content =
      format === "txt" ? payload.txt || payload.subtitlePreview || "" : payload.srt || "";
    if (!content) {
      setStatus(payload.subtitleMissing || MdgErrors.subtitleMissing(), true);
      return;
    }
    // Named like the note (date prefix setting, 分 P), only the extension differs.
    MdgDownload.text(payload.filename.replace(/\.md$/, `.${format}`), content, "text/plain;charset=utf-8");
    setStatus(`已下载 ${format.toUpperCase()}`);
  });

  el.mdBtn.addEventListener("click", async () => {
    const payload = onVideoPage ? await ensurePayload() : webNote;
    if (!payload) return;
    if (!payload.markdown) {
      setStatus(MdgErrors.TEXT.noNoteYet, true);
      return;
    }
    // Named like the note 写入 Obsidian writes (date prefix setting, 分 P): the content script builds it.
    const r = await MdgNoteActions.run("download", { note: payload });
    setStatus(r.text, !r.ok);
  });

  el.sendBtn.addEventListener("click", async () => {
    setStatus(MdgErrors.TEXT.obsidianWriting, false, true);
    setBusy(el.sendBtn, true, MdgErrors.TEXT.writing);
    if (!onVideoPage) {
      // As the side panel writes it: the background picks the path, an existing note asks here.
      const r = await MdgNoteActions.run("write", { request: () => ({ ref: webNote.ref, page: { markdown: webNote.markdown } }) }).finally(() => setBusy(el.sendBtn, false));
      setStatus(r.text, !r.ok, false, obsidianSettings(r.code));
      return;
    }
    const resp = await sendToContent({ type: "popup-send-obsidian" }).finally(() => setBusy(el.sendBtn, false));
    // The page answers with the result's words (text); without them the message never reached it.
    const text = resp?.text || (resp?.ok ? "" : `${MdgErrors.TEXT.obsidianFailed}：${MdgErrors.text(resp)}`);
    if (text) setStatus(text, !resp?.ok, false, resp?.ok ? null : obsidianSettings(resp?.code));
    render(resp?.payload || latestPayload, { preserveStatus: Boolean(text) });
  });

  el.readingViewBtn?.addEventListener("click", async () => {
    // A web page has this disabled (syncTools), so the tab is a video page here.
    const tab = await MdgSites.activeTab();
    setStatus("正在打开专注模式…", false, true);
    setBusy(el.readingViewBtn, true, "打开中…");
    const prepResp = await sendToContent({ type: "popup-get-state" }).catch((error) => ({ ok: false, error: error.message }));
    if (!prepResp?.ok) {
      setBusy(el.readingViewBtn, false);
      setStatus(`${MdgErrors.TEXT.readerStartFailed}：${MdgErrors.text(prepResp, MdgErrors.TEXT.reloadRetry)}`, true);
      return;
    }

    const resp = await chrome.runtime.sendMessage({
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
    const reply = replies.next();
    const resp = await sendToContent({ type: "popup-select-subtitle", url });
    if (!reply.alive) return;
    if (!resp?.ok) {
      setStatus(`${MdgErrors.TEXT.subtitleSwitchFailed}：${MdgErrors.text(resp)}`, true);
    }
    render(resp?.payload || latestPayload, { preserveStatus: !resp?.ok });
  });

  el.settingsBtn.addEventListener("click", openOptions);

  el.summaryBtn.addEventListener("click", async () => {
    const tab = await MdgSites.activeTab();
    setStatus(MdgErrors.TEXT.sidepanelOpening, false, true);
    setBusy(el.summaryBtn, true, "打开中…");
    // Same path as the player AI button: background opens the side panel and queues the request; the panel shows the
    // video's conversation when it has one, else fills the one-click prompt.
    const resp = await chrome.runtime.sendMessage({ type: "player-ai-quick-action", tabId: tab.id, source: "popup" }).catch((error) => ({ ok: false, error: error.message }));
    if (!resp?.ok) {
      setBusy(el.summaryBtn, false);
      setStatus(`${MdgErrors.TEXT.sidepanelOpenFailed}：${MdgErrors.text(resp)}`, true);
      return;
    }
    window.setTimeout(() => window.close(), CLOSE_DELAY_MS);
  });

  el.triageBtn.addEventListener("click", async () => {
    const r = await chrome.runtime.sendMessage({ type: "triage-open" }).catch(() => null);
    if (!r?.ok) await chrome.tabs.create({ url: chrome.runtime.getURL(MdgCommon.PAGES.triage) });
    window.close();
  });
  el.historyBtn.addEventListener("click", async () => {
    const r = await chrome.runtime.sendMessage({ type: "history-open" }).catch(() => null);
    if (!r?.ok) await chrome.tabs.create({ url: chrome.runtime.getURL(MdgCommon.PAGES.history) });
    window.close();
  });
}

// The web page's note, read once as the popup opens; a page that cannot be read disables the tools with the reason.
async function readWebNote(tabId) {
  const tools = [el.copyBtn, el.mdBtn, el.sendBtn];
  tools.forEach((button) => setDisabledReason(button, WEB_PAGE_READING));
  setStatus(WEB_PAGE_READING, false, true);
  setBusy(el.refreshBtn, true);
  const resp = await chrome.runtime.sendMessage({ type: "popup-page-note", tabId }).catch((error) => ({ ok: false, error: error.message })).finally(() => setBusy(el.refreshBtn, false));
  el.refreshBtn.classList.toggle("is-error", !resp?.ok);
  if (!resp?.ok) {
    const reason = MdgErrors.text(resp);
    tools.forEach((button) => setDisabledReason(button, reason));
    // Web pages not granted yet: 允许读取网页 as in the side panel, then the page is read again.
    const grant = MdgErrors.remedies(resp?.code).includes("grantPage")
      ? { label: MdgErrors.LABEL.grantPage, run: () => MdgErrors.grantPages().then((granted) => granted && readWebNote(tabId)) }
      : null;
    setStatus(reason, true, false, grant);
    return;
  }
  webNote = { ref: resp.ref, filename: resp.filename, markdown: resp.content };
  tools.forEach((button) => setDisabledReason(button, ""));
  // As the video page says it after its read.
  try {
    const { obsidianEnabled } = await (settingsLoad || getSettingsFromRuntime());
    setStatus(obsidianEnabled ? MdgErrors.TEXT.readDoneObsidian : MdgErrors.TEXT.readDone);
  } catch (error) {
    setStatus(settingsFailed(error), true);
  }
}

async function openOptions() {
  const resp = await chrome.runtime.sendMessage({ type: "open-options" }).catch((error) => ({ ok: false, error: error.message }));
  if (!resp?.ok) setStatus(`${MdgErrors.TEXT.settingsOpenFailed}：${MdgErrors.text(resp)}`, true);
}

// Not set up or a wrong key: 去设置 in the status line, opened only on its click. A closed Obsidian only gets the red line.
const obsidianSettings = (code) => (MdgErrors.action(code) === "settings" ? { label: MdgErrors.LABEL.toSettings, run: openOptions } : null);

async function refreshFromTab(force = false) {
  setStatus(MdgErrors.TEXT.videoReading, false, true);
  setBusy(el.refreshBtn, true);
  const reply = replies.next();
  const resp = await sendToContent({ type: "popup-refresh", refresh: force }).finally(() => setBusy(el.refreshBtn, false));
  if (!reply.alive) return;
  el.refreshBtn.classList.toggle("is-error", !resp?.ok);
  if (!resp?.ok) {
    // init() already turned non-video pages away: a reply without words is no 不是视频页.
    setStatus(`${MdgErrors.TEXT.videoReadFailed}：${MdgErrors.text(resp)}`, true);
    render(resp?.payload || latestPayload, { preserveStatus: true });
    return;
  }
  render(resp?.payload || latestPayload);
}

// The note and subtitle as the page has them now, for 复制, 下载 .md and 下载字幕: the page may have moved on to another video
// since the popup drew it. One it has not read yet (autoplay, a link in the page) is read first, as 刷新 does, so the
// button gets its note. Null when the page did not answer or the read failed (the status says why).
async function ensurePayload() {
  let resp = await sendToContent({ type: "popup-get-state" });
  if (resp?.ok && resp.payload && !resp.payload.markdown) {
    await refreshFromTab(false);
    resp = await sendToContent({ type: "popup-get-state" });
    if (resp?.ok && !resp.payload?.markdown) return null;
  }
  if (resp?.ok && resp.payload) {
    latestPayload = resp.payload;
    return resp.payload;
  }
  if (!resp?.ok) setStatus(MdgErrors.text(resp, MdgErrors.TEXT.reloadRetry), true);
  return null;
}

function render(payload, { preserveStatus = false } = {}) {
  if (!payload) {
    return;
  }
  latestPayload = payload;

  if (!preserveStatus) {
    setStatus(String(payload.status || "准备就绪"), payload.statusError === true);
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
  syncTools(payload);
}

// A tool that cannot work is disabled and says why; without a payload yet a video page keeps them usable.
// offReason: why nothing works off a video page (NOT_VIDEO_PAGE, or pageUnsupported on a tab that is no web page).
function syncTools(payload, offReason = NOT_VIDEO_PAGE) {
  const pageReason = onVideoPage ? "" : offReason;
  const contentReason = pageReason || (payload && !payload.markdown ? MdgErrors.TEXT.noNoteYet : "");
  const subtitleReason = pageReason || (payload && !(payload.srt || payload.txt) ? payload.subtitleMissing || MdgErrors.subtitleMissing() : "");
  setDisabledReason(el.readingViewBtn, pageReason);
  // No AI platform still leaves it usable (the side panel offers 去设置); init enables it on an http(s) web page.
  setDisabledReason(el.summaryBtn, pageReason);
  setDisabledReason(el.copyBtn, contentReason);
  setDisabledReason(el.mdBtn, contentReason);
  setDisabledReason(el.sendBtn, contentReason);
  setDisabledReason(el.downloadBtn, subtitleReason);
}


function setText(node, text) {
  node.textContent = String(text || "");
}

// action: { label, run }, a button after the text (去设置).
function setStatus(text, isError = false, busy = false, action = null) {
  el.status.textContent = String(text || "");
  if (action) el.status.append(Object.assign(document.createElement("button"), { type: "button", className: "link", textContent: action.label, onclick: action.run }));
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

async function sendToContent(message) {
  const tab = await MdgSites.activeTab();
  const tabId = tab?.id || null;
  // An answer like any other failure: every caller shows it and ends its busy state.
  if (!tabId) {
    setStatus(MdgErrors.TEXT.noTab, true);
    return { ok: false, error: MdgErrors.TEXT.noTab, payload: latestPayload };
  }

  try {
    return await MdgErrors.tabMessage(tabId, message, { inject: Boolean(MdgSites.matchPage(tab?.url || "")) });
  } catch (error) {
    // Chrome's English (tabMessage marks it) in the user's words; our own reasons pass through.
    const normalizedError = MdgErrors.messageOf(MdgErrors.pageSilent(error));
    setStatus(normalizedError, true);
    return { ok: false, error: normalizedError, payload: latestPayload };
  }
}

// Rejects when the background does not answer, as the video page's getSettings: 下载字幕 must not go on with the default
// format as if it were the user's.
async function getSettingsFromRuntime() {
  const resp = await chrome.runtime.sendMessage({ type: "get-settings" });
  if (!resp?.ok) throw MdgErrors.fromResp(resp);
  return resp.settings || {};
}

const settingsFailed = (error) => `${MdgErrors.TEXT.settingsReadFailed}：${MdgErrors.messageOf(error)}`;
