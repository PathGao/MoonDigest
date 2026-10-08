// What the 分拣台's two modes (triage.js 收藏夹, follow.js 关注) draw the same way, so they cannot drift apart.
// A plain script loaded before both modules; everything here returns HTML, text or a comparator and touches no state.
(() => {
  function esc(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
  const pad = (n) => String(n).padStart(2, "0");
  // pubdate and friends are seconds since the epoch: 2026-10-08, "" without one.
  function fmtDate(sec) {
    if (!sec) return "";
    const d = new Date(sec * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  // Seconds as 04:05, 1:15:00 from an hour up.
  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    return (sec >= 3600 ? `${Math.floor(sec / 3600)}:` : "") + `${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
  }
  // 播放量 / 粉丝: 12.3万 and 2.5亿 (one decimal, dropped when 0), plain below 万.
  const fmtCount = (n) => (n >= 1e8 ? `${Math.round(n / 1e7) / 10}亿` : n >= 1e4 ? `${Math.round(n / 1e3) / 10}万` : String(n));
  // A tag name as both modes and the AI keep it: no commas or 顿号 (the CSV joins names with 、), trimmed, at most 12
  // characters. triage-bg.js has the same rule as triageCleanTagName; shared.selftest.js checks they agree.
  const cleanTagName = (s) => String(s ?? "").replace(/[,，、]/g, "").trim().slice(0, 12);
  // A plain primary click on a video link plays it in the viewer here; with ⌘ / Ctrl / Shift / Alt the browser opens it.
  const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
  // hdslb images: https and a small webp copy (size like "480w_270h_1c"); other URLs as they are.
  const img = (u, size) => {
    const s = String(u || "").replace(/^(https?:)?\/\//, "https://");
    return /hdslb\.com\//.test(s) && !s.includes("@") ? `${s}@${size}.webp` : s;
  };
  // Spreadsheets run a cell that starts with = + - @ (or tab/CR) as a formula; a leading ' keeps it text.
  function csvField(v) {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  }
  // Rows of cells → CSV text with a BOM (Excel reads it as UTF-8) and CRLF lines.
  const toCsv = (rows) => "\ufeff" + rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";

  // 「今天 14:02 刷新过」, 「昨天 …」, older 「10月5日 …」; at and now in ms. "" before the first read.
  function syncedText(at, now = Date.now()) {
    if (!at) return "";
    const d = new Date(at);
    const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86400000);
    const day = days <= 0 ? "今天" : days === 1 ? "昨天" : `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())} 刷新过`;
  }

  // Row 1's meta line: the parts joined by ·, then the last refresh's error, which stays until the next one succeeds.
  const headMeta = (parts, error = "") =>
    [parts.filter(Boolean).map(esc).join(" · "), error && `<span class="fail-text">${esc(error)}</span>`].filter(Boolean).join(" · ");

  const titleHtml = (title, count) => `${esc(title)}${count == null ? "" : `<span class="title-count"> · ${count}</span>`}`;

  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = {
    refresh: svg('<path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/>'),
    export: svg('<path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19h14"/>'),
    gear: svg('<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>')
  };
  // A card's tag: one click takes it off. title says what else undoes it.
  const cardTagChip = (t, title) =>
    `<button type="button" class="chip card-tag" style="--c:${esc(t.color)}" data-untag="${esc(t.id)}" aria-label="去掉标签 ${esc(t.name)}" title="${esc(title)}">${esc(t.name)}<span class="x" aria-hidden="true">×</span></button>`;
  // Marks a control that starts an AI request (tokens.css draws it in the text color).
  const AI_SPARK = '<span class="ai-spark" aria-hidden="true"></span>';

  // The sort direction's icon: three lines, longest on top = descending; mirrored = ascending.
  function sortDirIcon(dir) {
    const ws = dir === "asc" ? [6, 10, 14] : [14, 10, 6];
    return `<svg viewBox="0 0 20 20" aria-hidden="true">${[4, 8, 12].map((y, i) => `<path d="M3 ${y + 1.5}h${ws[i]}"/>`).join("")}</svg>`;
  }
  // A sort comparator by val(item); dir "asc" = small / old / A first. An item without a value (null) sinks to the bottom
  // in both directions; strings compare as Chinese. Array sort is stable, so ties keep list order.
  function byValue(val, dir) {
    const sign = dir === "asc" ? 1 : -1;
    return (a, b) => {
      const [x, y] = [val(a), val(b)];
      if (x == null || y == null) return (x == null) - (y == null);
      return sign * (typeof x === "string" ? x.localeCompare(y, "zh") : x - y);
    };
  }
  // The direction button's words by what is sorted: time 新→旧 / 旧→新 (the default), count, length, name.
  const DIR_WORDS = { time: ["旧→新", "新→旧"], count: ["从少到多", "从多到少"], length: ["从短到长", "从长到短"], name: ["A→Z", "Z→A"] };
  const dirWords = (kind, dir) => (DIR_WORDS[kind] || DIR_WORDS.time)[dir === "asc" ? 0 : 1];

  // Row 1's sort: a select and the direction button as one control. selectAttr / dirAttr are what each mode listens for.
  function sortControl({ sorts, sort, dir, words, selectAttr, dirAttr }) {
    const opts = Object.entries(sorts).map(([v, t]) => `<option value="${esc(v)}"${v === sort ? " selected" : ""}>${esc(t)}</option>`).join("");
    return `<span class="sort-ctl"><select ${selectAttr} aria-label="排序">${opts}</select><button type="button" class="sort-dir" ${dirAttr} title="${esc(words)}" aria-label="排序方向：${esc(words)}">${sortDirIcon(dir)}</button></span>`;
  }

  // A filter pill with its count. A count of 0 stays, dimmed (.zero); n == null draws no count.
  const filterBtn = (attrs, label, n, pressed, extra = "") =>
    `<button type="button" ${attrs} aria-pressed="${Boolean(pressed)}"${n === 0 ? ' class="zero"' : ""}>${extra}${esc(label)}${n == null ? "" : ` ${n}`}</button>`;

  // Row 2's search box. Each mode binds its own input (and keeps its own query); countId shows 「N 个结果」.
  const searchBox = (id, countId, placeholder) =>
    `<span class="search"><svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="${id}" type="search" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)} (/)" autocomplete="off" /><span id="${countId}" class="muted" aria-live="polite"></span><kbd class="search-key" aria-hidden="true">/</kbd></span>`;
  const resultCount = (q, n) => (String(q || "").trim() ? `${n} 个结果` : "");

  // Row 2's buttons after the search: what is running (the pill takes 刷新's place, see triage.css), 刷新, 导出 and its
  // menu, and the settings gear that only shows without the sidebar.
  const rowButtons = ({ activityId, refreshId, refreshLabel, refreshTitle = "", exportId, menuId, menuHtml, settingsAttr, settingsLabel }) =>
    `<span id="${activityId}" class="activity" aria-live="polite" hidden></span>` +
    `<button id="${refreshId}" type="button" class="act-btn" aria-label="${esc(refreshLabel)}"${refreshTitle ? ` title="${esc(refreshTitle)}"` : ""}>${ICON.refresh}<span class="lbl">刷新</span></button>` +
    `<button id="${exportId}" type="button" class="act-btn" popovertarget="${menuId}" aria-label="导出">${ICON.export}<span class="lbl">导出</span></button>` +
    `<button type="button" class="act-btn gear-only" ${settingsAttr} aria-label="${esc(settingsLabel)}" title="${esc(settingsLabel)}">${ICON.gear}</button>` +
    `<div id="${menuId}" class="tools export-menu" popover>${menuHtml}</div>`;
  const menuItem = (attrs, label, sub) => `<button type="button" ${attrs}>${esc(label)}<small>${esc(sub)}</small></button>`;
  const BACKUP_ITEM = menuItem('data-backup aria-label="下载完整备份 JSON"', "完整备份 (JSON)", "收藏夹和关注一起，换电脑时用");

  // The running-state pill's inside: text, a bar when done/total is known, and one button (btn = { attrs, label, disabled }).
  function activityHtml({ text, done = 0, total = 0, btn = null }) {
    const bar = total ? `<span class="activity-bar" aria-hidden="true"><i style="width:${Math.round((done / total) * 100)}%"></i></span>` : "";
    const b = btn ? `<button type="button" ${btn.attrs} aria-label="${esc(btn.label)}"${btn.disabled ? " disabled" : ""}>${esc(btn.label)}</button>` : "";
    return `<span class="activity-text">${esc(text)}</span>${bar}${b}`;
  }

  // 标签管理 and ✦ AI 打标签 at the right end of the tag row, next to the tags they act on (in 收藏夹 those are the open
  // folder's, so they do not sit in the sidebar). state is 「 · 运行中」 or 「 · 待确认」.
  const tagButtons = ({ manageAttrs, aiAttrs, state = "" }) =>
    `<span class="tags-acts"><button type="button" class="act-btn" ${manageAttrs}>标签管理</button><button type="button" class="act-btn" ${aiAttrs}>${AI_SPARK}AI 打标签${esc(state)}</button></span>`;
  // The sidebar's foot: the mode's own settings.
  const sideFoot = ({ settingsAttrs, settingsLabel }) =>
    `<div class="side-foot"><button type="button" class="side-item side-settings" ${settingsAttrs}>${ICON.gear}${esc(settingsLabel)}</button></div>`;

  // An empty list with a title, why it is empty, and what to do (actionHtml, usually 刷新).
  const emptyState = (title, text, actionHtml = "") =>
    `<div class="empty-state"><p><strong>${esc(title)}</strong></p>${text ? `<p class="dialog-hint">${esc(text)}</p>` : ""}${actionHtml}</div>`;

  // Settings rows both dialogs have: the same name and hint. Markup: <div class="set-row" data-set-row="key"><input …></div>.
  const SET_ROWS = {
    interval: ["请求间隔（秒）", ""],
    newTagMax: ["AI 打标签时最多新建几个标签", "0–50，0 = 只用已有标签。"],
    allowRemove: ["AI 打标签时允许去掉已有标签", "关时只加标签。开了也要你确认。"]
  };
  function fillSetRows(root) {
    for (const row of root.querySelectorAll("[data-set-row]:not(:has(label))")) {
      const [name, hint] = SET_ROWS[row.dataset.setRow];
      const input = row.querySelector("input");
      row.insertAdjacentHTML("afterbegin", `<div><label class="name" for="${esc(input.id)}">${esc(name)}</label>${hint ? `<p class="hint">${esc(hint)}</p>` : ""}</div>`);
    }
  }

  globalThis.TriageUi = { esc, pad, fmtDate, fmtDuration, fmtCount, cleanTagName, plainClick, img, toCsv, cardTagChip, syncedText, headMeta, titleHtml, ICON, AI_SPARK, byValue, dirWords, sortControl, filterBtn, searchBox, resultCount, rowButtons, menuItem, BACKUP_ITEM, activityHtml, tagButtons, sideFoot, emptyState, fillSetRows };
})();
