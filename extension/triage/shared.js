// What the 分拣台's two modes (triage.js 收藏夹, follow.js 关注) draw the same way, so they cannot drift apart.
// A plain script loaded before both modules (and by the settings page and the worker, which call only the pure parts).
// Most of it returns HTML, text or a comparator. What touches the DOM it is given: bindSearch, setReason, askTransfer,
// setActivity, setSync, bindSync, fillSetRows, fillNumHints, clampNumber(s) and headFold (which also reads and writes
// chrome.storage.local); mergeAiBatch fills the proposal it is given.
(() => {
  const esc = MdgErrors.escapeHtml;
  const pad = (n) => String(n).padStart(2, "0");
  // pubdate and friends are seconds since the epoch: 2026-10-08, "" without one.
  function fmtDate(sec) {
    if (!sec) return "";
    const d = new Date(sec * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  // Seconds as 9:47, 1:15:00 from an hour up (minutes padded only after hours).
  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor((sec % 3600) / 60);
    return (sec >= 3600 ? `${Math.floor(sec / 3600)}:${pad(m)}` : m) + `:${pad(sec % 60)}`;
  }
  // 「3 天前」 style ages, both in seconds, by calendar day as dayText counts them: 今天 is today's date, not 24 hours.
  function fmtAgo(sec, now = Date.now() / 1000) {
    const d = Math.round((new Date(now * 1000).setHours(0, 0, 0, 0) - new Date(sec * 1000).setHours(0, 0, 0, 0)) / 86400000);
    if (d < 1) return "今天";
    if (d < 31) return `${d} 天前`;
    if (d < 360) return `${Math.floor(d / 30)} 个月前`;
    return `${Math.max(1, Math.floor(d / 365))} 年前`;
  }
  // A card's time: relative, the date on hover.
  const agoHtml = (sec, now) => `<time title="${fmtDate(sec)}">${fmtAgo(sec, now)}</time>`;
  // 播放量 / 粉丝: 12.3万 and 2.5亿 (one decimal, dropped when 0), plain below 万.
  const fmtCount = (n) => (n >= 1e8 ? `${Math.round(n / 1e7) / 10}亿` : n >= 1e4 ? `${Math.round(n / 1e3) / 10}万` : String(n));
  // Tag names, colors and ids: ../tag-core.js, which badges.js on B站 pages loads too.
  const { cleanTagName, nextTagColor, cycleTagColor } = globalThis.MdgTagCore;
  // A plain primary click on a video link plays it in the viewer here; with ⌘ / Ctrl / Shift / Alt the browser opens it.
  const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
  // A video card plays on a plain click anywhere on it (收藏夹 and 视频投稿 alike), except on a control inside it
  // (button, field, 「+ 标签」 chip, a link other than the card's own video links) or at the end of a text-selection drag.
  const CARD_CONTROLS = "button, input, textarea, select, label, [data-pick], a[href]:not([data-act=open], [data-play])";
  const cardPlayClick = (e) => plainClick(e) && !e.target.closest(CARD_CONTROLS) && globalThis.getSelection?.()?.isCollapsed !== false;
  // Selecting (收藏夹 and 关注 UP 主): a click anywhere on the card picks it, cover and UP links included. The video
  // titles play and the controls inside keep their own. Shift picks the run from the last picked card; ⌘ / Ctrl /
  // middle on a link still open B站.
  const PICK_CONTROLS = "button, input, textarea, select, label, [data-pick], [data-act=open], [data-play], [data-space]";
  const cardPickClick = (e) =>
    e.button === 0 && !e.metaKey && !e.ctrlKey && !e.altKey &&
    !e.target.closest(PICK_CONTROLS) && (e.shiftKey || globalThis.getSelection?.()?.isCollapsed !== false);
  // One pick in sel (a Set, changed in place): a toggle, or with range every listed id from anchor to id. Returns the new anchor.
  function pickCard(sel, ids, id, anchor, range) {
    const a = range ? ids.indexOf(anchor) : -1;
    const b = ids.indexOf(id);
    if (a < 0 || b < 0) sel.has(id) ? sel.delete(id) : sel.add(id);
    else for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) sel.add(x);
    return id;
  }
  // B站's image URLs come as http://, https:// or protocol-relative //: always https (the pages and the worker).
  const https = (u) => String(u || "").replace(/^(https?:)?\/\//, "https://");
  // hdslb images: https and a small webp copy (size like "480w_270h_1c"); other URLs as they are.
  const img = (u, size) => {
    const s = https(u);
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

  // 「今天 14:02」, 「昨天 …」, 「10月5日 …」 this year, 「2025年10月5日」 (no time) before; at and now in ms.
  function dayText(at, now = Date.now()) {
    const d = new Date(at);
    if (d.getFullYear() !== new Date(now).getFullYear()) return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86400000);
    const day = days <= 0 ? "今天" : days === 1 ? "昨天" : `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  // 「今天 14:02 刷新过」; "" before the first read.
  const syncedText = (at, now = Date.now()) => (at ? `${dayText(at, now)} 刷新过` : "");

  // Row 1's meta line: the parts joined by ·, then the last refresh's error, which stays until the next one succeeds.
  const headMeta = (parts, error = "") =>
    [parts.filter(Boolean).map(esc).join(" · "), error && `<span class="fail-text">${esc(error)}</span>`].filter(Boolean).join(" · ");

  const titleHtml = (title, count) => `${esc(title)}${count == null ? "" : `<span class="title-count"> · ${count}</span>`}`;

  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = {
    refresh: svg('<path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/>'),
    export: svg('<path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19h14"/>'),
    alert: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
    gear: svg('<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>')
  };
  // A tag on a card: a click takes it off, U puts it back (both modes).
  const cardTagChip = (t) =>
    `<button type="button" class="chip card-tag" style="--c:${esc(t.color)}" data-untag="${esc(t.id)}" aria-label="去掉标签 ${esc(t.name)}" title="点一下去掉这个标签 · U 撤销">${esc(t.name)}<span class="x" aria-hidden="true">×</span></button>`;
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
  // btn = { attrs, label, icon } puts another button in the direction button's place; no dirAttr and no btn = the select alone.
  function sortControl({ sorts, sort, dir, words, selectAttr, dirAttr, btn }) {
    const opts = Object.entries(sorts).map(([v, t]) => `<option value="${esc(v)}"${v === sort ? " selected" : ""}>${esc(t)}</option>`).join("");
    const b = btn ? `<button type="button" class="sort-dir" ${btn.attrs} title="${esc(btn.label)}" aria-label="${esc(btn.label)}">${btn.icon}</button>`
      : dirAttr ? `<button type="button" class="sort-dir" ${dirAttr} title="${esc(words)}" aria-label="排序方向：${esc(words)}">${sortDirIcon(dir)}</button>` : "";
    return `<span class="sort-ctl"><select ${selectAttr} name="sortOrder" aria-label="排序">${opts}</select>${b}</span>`;
  }

  // A filter pill with its count. A count of 0 stays, dimmed (.zero); n == null draws no count.
  const filterBtn = (attrs, label, n, pressed, extra = "") =>
    `<button type="button" ${attrs} aria-pressed="${Boolean(pressed)}"${n === 0 ? ' class="zero"' : ""}>${extra}${esc(label)}${n == null ? "" : ` ${n}`}</button>`;

  // Row 4's tag filter: a chip in the tag's color with how many listed carry it; several are ANDed (what: what it lists).
  const tagFilterChip = (attrs, { name, color, n, on, what }) =>
    `<button type="button" class="chip${on ? " on" : ""}${n ? "" : " zero"}" style="--c:${esc(color)}" ${attrs} aria-pressed="${on}" aria-label="按标签筛选 ${esc(name)} ${n}" title="可多选：只显示同时带有所选标签的${esc(sp(what))}">${esc(name)}<span class="chip-n">${n}</span></button>`;
  // 已出分拣范围's tabs on row 2: why the items left, 全部 first. kinds = [[value, label, n]]; attr holds the value.
  const kindTabs = (attr, kinds, on) =>
    kinds.map(([k, label, n]) => `<button type="button" role="tab" class="${n ? "step" : "step zero"}" ${attr}="${esc(k)}" aria-selected="${on === k}" aria-label="${esc(label)} ${n}">${esc(label)}<span class="count">${n}</span></button>`).join("");
  // 已出分拣范围's card: where it was (pre: 原在 or 在), two names then 「等 N 个」, all of them on hover.
  const originChip = (pre, names) => {
    const all = pre + names.map((n) => `「${n}」`).join("");
    const text = names.length > 2 ? `${pre}${names.slice(0, 2).map((n) => `「${n}」`).join("")}等 ${names.length} 个` : all;
    return names.length ? `<span class="origin-chip" title="${esc(all)}">${esc(text)}</span>` : "";
  };

  // Rows 3 and 4 start with their name, 「状态」 and 「标签」, so the two rows of pills tell apart (triage.css .row-label).
  const labeledRow = (label, html) => `<span class="row-label">${esc(label)}</span>${html}`;
  // Row 3 (both modes): one group of state pills; the CSS splits groups by a thin rule and wraps them whole.
  const stateGroup = (label, html, cls = "") => `<span class="seg${cls}" role="group" aria-label="${esc(label)}">${html}</span>`;
  // 「AI 刚打的」: the filter of the items the last applied AI 打标签 changed, and what to do with them.
  const AI_RECENT = "AI 刚打的";
  const AI_RECENT_CHECK = "在卡片上逐个看，不对的按 T 改";
  // 「AI 刚打的」's ×: stop marking them, tags stay.
  const AI_RECENT_X = (attrs) => `<button type="button" class="ai-recent-x" ${attrs} aria-label="不再标出「${AI_RECENT}」，标签不变" title="不再标出，标签不变">×</button>`;

  // The search box's behavior, both modes: it filters as you type (bindLive, IME-safe); Esc clears it, and on an empty
  // box gives the keys back to the cards (J / K work again).
  function bindSearch(input, run) {
    MdgTyping.bindLive(input, run);
    input.addEventListener("keydown", (e) => {
      if (MdgTyping.composing(e) || e.key !== "Escape") return;
      e.preventDefault();
      if (!input.value) return input.blur();
      input.value = "";
      run("");
    });
  }
  // Row 2's search box. Each mode binds its own input (and keeps its own query); countId shows 「N 个结果」.
  const searchBox = (id, countId, placeholder) =>
    `<span class="search"><svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="${id}" type="search" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)} (/)" autocomplete="off" /><span id="${countId}" class="muted" aria-live="polite"></span><kbd class="search-key" aria-hidden="true">/</kbd></span>`;
  // 「N 个结果」 while a search or any filter is on (on: truthy).
  const resultCount = (on, n) => (on ? `${n} 个结果` : "");
  // The box says what it searches (「在「想学的技能」· 未分析里搜」), for the eye and the screen reader alike.
  function setSearchScope(input, scope) {
    if (input.placeholder === scope) return;
    input.placeholder = scope;
    input.setAttribute("aria-label", `${scope} (/)`);
  }

  // Row 2's buttons after the search: what is running (the pill takes 刷新's place, see triage.css), 刷新, 导出 and its
  // menu, and the settings gear that only shows without the sidebar.
  const rowButtons = ({ activityId, refreshId, refreshLabel, refreshTitle = "", exportId, menuId, menuHtml, settingsAttr, settingsLabel }) =>
    `<span id="${activityId}" class="activity" aria-live="polite" hidden></span>` +
    `<button id="${refreshId}" type="button" class="act-btn" aria-label="${esc(refreshLabel)}"${refreshTitle ? ` title="${esc(refreshTitle)}"` : ""}>${ICON.refresh}<span class="lbl">${MdgErrors.LABEL.refresh}</span></button>` +
    `<button id="${exportId}" type="button" class="act-btn" popovertarget="${menuId}" aria-label="导出">${ICON.export}<span class="lbl">导出</span></button>` +
    `<button type="button" class="act-btn gear-only" ${settingsAttr} aria-label="${esc(settingsLabel)}" title="${esc(settingsLabel)}">${ICON.gear}</button>` +
    `<div id="${menuId}" class="tools export-menu" popover>${menuHtml}</div>`;
  const menuItem = (attrs, label, sub) => `<button type="button" ${attrs}>${esc(label)}<small>${esc(sub)}</small></button>`;
  const BACKUP_ITEM = menuItem('data-backup aria-label="下载完整备份 JSON"', "完整备份 (JSON)", "收藏夹和关注一起，换电脑时用");
  // 清理 cannot be undone: both modes point at the same way to keep a copy, on 已出分拣范围's info line and in the confirm.
  const CLEAN_BACKUP = { meta: "清理前可先从「导出」菜单备份", ask: "要留存请先从「导出」菜单备份。" };

  // The running-state pill's inside: text, a bar when done/total is known, and one button (btn = { attrs, label, reason };
  // a reason disables it).
  // text ends in 「 · ‹wait›」 when wait is given; a narrow window cuts the text before it, never the countdown.
  function activityHtml({ text, done = 0, total = 0, btn = null, stuck = false, wait = "" }) {
    const head = wait && text.endsWith(` · ${wait}`) ? text.slice(0, -wait.length - 3) : text;
    const bar = total ? `<span class="activity-bar" aria-hidden="true"><i style="width:${Math.round((done / total) * 100)}%"></i></span>` : "";
    const b = btn ? `<button type="button" ${btn.attrs} aria-label="${esc(btn.label)}"${reasonAttrs(btn.reason)}>${esc(btn.label)}</button>` : "";
    return `${stuck ? `<span class="activity-stuck">${ICON.alert}</span>` : ""}<span class="activity-text">${esc(head)}</span>${head === text ? "" : `<span>· ${esc(wait)}</span>`}${bar}${b}`;
  }
  // Draws the pill from state ({ text, done, total, btn, stuck, slowed, finished }); null / false hides it. Blue while
  // running; stuck (B站限流 or offline, waiting to retry) is amber with a red ⚠; slowed (going on slower after B站限流)
  // is amber; finished is green, for a finished run's line.
  function setActivity(el, a) {
    el.hidden = !a;
    if (!a) return;
    el.classList.toggle("warn", Boolean(a.stuck || a.slowed));
    el.classList.toggle("done", Boolean(a.finished));
    el.title = a.text; // the whole line on hover, for a narrow window that cuts it
    el.innerHTML = activityHtml(a);
  }
  // A wait on B站's risk control, in every pill and line of both modes: 「B站限流卡住，01:30 后重试」.
  const BILI_STUCK = "B站限流卡住";
  // 「B站限流卡住，01:30 后重试」 while sec > 0, else "".
  const waitText = (why, sec) => (sec > 0 ? `${why}，${fmtDuration(sec)} 后重试` : "");
  // 关注's wait on B站限流: follow-bg.js's queue pause, and the page's wait before a write or a 视频投稿 page goes again.
  const BILI_HOLD_MS = 90000;
  // 关注's gap between its writes to B站: the page's batches (follow.js) and the one-by-one retry after B站 refused a
  // group request (follow-bg.js).
  const FOLLOW_WRITE_GAP_MS = 1000;
  // 关注's group name, checked alike on the page (follow.js, which adds 已有同名分组) and in follow-bg.js before B站:
  // B站 takes at most GROUP_NAME_MAX characters (22103 分组名过长).
  const GROUP_NAME_MAX = 16;
  const groupNameError = (n) => (!n ? "分组名不能为空" : [...n].length > GROUP_NAME_MAX ? `分组名最多 ${GROUP_NAME_MAX} 个字` : "");
  // Why 停止 on a B站 batch write's pill (both modes) is off once pressed: the request in flight lands first.
  const WRITE_STOPPING = "当前这一批做完就停止";
  // Why something waits for a running step or batch write (name: what the pill calls it), both modes; undo: U's version.
  // No name: nothing runs, "".
  const busyText = (name, { undo = false } = {}) => (name ? `${name}还在跑，等它完成${undo ? "再撤销" : ""}` : "");

  // Row 1's 「已刷新 +N −M」 pill and the notice it opens below it. Ids are prefix + ViewBtn / Notice / Text / Detail /
  // CloseBtn; each mode passes those elements as { pill, notice, text, detail, close }.
  const syncPill = (p) =>
    `<span class="sync-wrap"><button id="${p}ViewBtn" type="button" class="pill sync-pill" aria-expanded="false" aria-controls="${p}Notice" hidden></button>` +
    `<div id="${p}Notice" class="notice" hidden><p id="${p}Text"></p><div id="${p}Detail" class="sync-detail"></div>` +
    `<div class="notice-actions"><button id="${p}CloseBtn" type="button" aria-label="关闭刷新提示">关闭</button></div></div></span>`;
  // s = { label, text, sections: [[heading, lines]], warn } shows the pill with its notice closed (empty sections drop
  // out); null hides both.
  function setSync(e, s) {
    e.notice.hidden = true;
    e.pill.hidden = !s;
    e.pill.setAttribute("aria-expanded", "false");
    if (!s) return;
    e.pill.textContent = s.label;
    e.pill.classList.toggle("warn", Boolean(s.warn));
    e.text.textContent = s.text;
    e.detail.innerHTML = s.sections
      .map(([h, lines]) => (lines.length ? `<div><strong>${esc(h)}</strong><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>` : ""))
      .join("");
  }
  // The pill opens and closes its notice; 关闭 hides both.
  function bindSync(e) {
    e.pill.addEventListener("click", () => {
      e.notice.hidden = !e.notice.hidden;
      e.pill.setAttribute("aria-expanded", String(!e.notice.hidden));
    });
    e.close.addEventListener("click", () => setSync(e, null));
  }

  // A control that cannot be used says why: the tooltip, and aria-description for screen readers. Without a reason it
  // is enabled and keeps its usual tooltip (title).
  const reasonAttrs = (reason, title = "") =>
    reason ? ` disabled title="${esc(reason)}" aria-description="${esc(reason)}"` : title ? ` title="${esc(title)}"` : "";
  // The same for a control already on the page.
  const { setReason } = MdgErrors;
  // A --warn dot after a button's label: something is not set up yet, and nothing is blocked by it.
  const WARN_DOT = '<i class="dot-warn" aria-hidden="true"></i>';

  // 标签管理 and ✦ AI 打标签 at the right end of the tag row, next to the tags they act on (in 收藏夹 those are the open
  // folder's, so they do not sit in the sidebar). running / pending (an AI 打标签 run, a proposal waiting) add 「 · 运行中」
  // / 「 · 待确认」. noTags puts the dot on 标签管理.
  // picked: the selected ones listed now (all of them when filters hide every one, as the selection bar's buttons; the
  // dialog's 运行 then says HIDDEN_ALL); the dialog opens on 选中, so the button says how many, as 粗看's does.
  // It stays in row 4: the selection bar has no AI 打标签 of its own.
  const TAG_MANAGE = "标签管理";
  const tagButtons = ({ manageAttrs, aiAttrs, running = false, pending = false, manageReason = "", aiReason = "", noTags = false, picked = 0 }) => {
    const state = running ? " · 运行中" : pending ? " · 待确认" : "";
    const ai = `AI 打标签${picked && !state && !aiReason ? `选中的 ${picked} 个` : ""}`;
    return `<span class="tags-acts"><button type="button" class="act-btn" ${manageAttrs}${noTags && !manageReason ? ` aria-label="${TAG_MANAGE}（还没有自定义标签）"` : ""}${reasonAttrs(manageReason)}>${TAG_MANAGE}${noTags && !manageReason ? WARN_DOT : ""}</button><button type="button" class="act-btn" ${aiAttrs} aria-label="${ai} (I)"${reasonAttrs(aiReason)}>${AI_SPARK}${ai}${esc(state)}</button></span>`;
  };

  // Row 3's 全选: a checkbox drawn as a button, for what is listed now (n, of which picked are selected). Unchecked or
  // mixed: a click selects them all; checked: it deselects them. Selections hidden by filters are not its business.
  const selectAllState = (n, picked) => (!n || !picked ? "false" : picked >= n ? "true" : "mixed");
  const selectAllBox = (attrs, n, picked) =>
    `<button type="button" role="checkbox" class="act-btn sel-all" ${attrs} aria-checked="${selectAllState(n, picked)}"${reasonAttrs(n ? "" : "这里没有列出可选的")}><span class="box" aria-hidden="true"></span>全选${n ? ` ${n} 个` : ""}</button>`;
  // The click: every listed id selected → deselect them, else select them all (sel is a Set, changed in place).
  function toggleAll(ids, sel) {
    const every = ids.every((id) => sel.has(id));
    for (const id of ids) every ? sel.delete(id) : sel.add(id);
  }
  // A button of row 3 or the selection bar: the label is its aria-label too; a reason disables it with why. pre goes before
  // the label (✦), title is the tooltip while enabled.
  const actBtn = (attrs, label, { reason = "", cls = "", title = "", pre = "" } = {}) =>
    `<button type="button"${cls ? ` class="${cls}"` : ""} ${attrs} aria-label="${esc(label)}"${reasonAttrs(reason, title)}>${pre}${esc(label)}</button>`;
  // Why a selection's buttons are off when filters hide every selected one (the bar's and row 3's steps').
  const HIDDEN_ALL = MdgErrors.TEXT.hiddenAll;
  // 清理 in 已出分拣范围's row 3, both modes. A selection (picked: how many, shown: how many listed) decides alone: n of
  // it, off with HIDDEN_ALL when none is listed; without one, n of all listed. busy goes before that, why after.
  const cleanBtn = (attrs, { picked, shown, n, busy = "", why = "" }) =>
    actBtn(attrs, picked ? `清理选中的 ${n} 个` : `清理这 ${n} 个`, { reason: busy || (picked && !shown ? HIDDEN_ALL : why), cls: "danger" });
  // The floating bar while something is selected: n of them listed, hidden more behind filters, 清空选中, then
  // acts(none). none is why every act is off when filters hide the whole selection: the buttons stay, disabled, and count
  // the whole selection (as row 3 does), and so does the title (「已选中 3 个 · 都被筛选隐藏」, never 「已选中 0 个」).
  const selbar = ({ label, n, hidden, clearAttrs, acts }) =>
    `<div class="selbar" role="toolbar" aria-label="${esc(label)}"><strong class="sel-count">已选中 ${n || hidden} 个</strong>${hidden ? `<span class="muted">${n ? `另有 ${hidden} 个被筛选隐藏` : "都被筛选隐藏"}</span>` : ""}<button type="button" class="quiet" ${clearAttrs} aria-label="清空选中">清空选中</button><span class="sel-actions">${acts(n ? "" : HIDDEN_ALL)}</span></div>`;
  // ----- 移动 / 复制 (#transferDialog): 收藏夹's folders and 关注's groups -----
  // o = { title, list (html), n, hows ("copy" / "move" / "add" buttons shown; the last is the blue one), label (目标收藏夹 /
  // 目标分组), options [[value, text]], newText (新建收藏夹… / 新建分组…), newPlaceholder, newMax, privacy (show 设为私密),
  // how (the hint under it, "" hides it), note(value) (html of the amber line for that target, "" hides it) }.
  // Resolves { how, target: { id } | { create, privacy } }, or null when cancelled.
  let transferNote = null;
  const TRANSFER_VERB = { copy: "复制", move: "移动", add: "收藏" };
  function askTransfer(o) {
    const $ = (id) => document.getElementById(id);
    const dlg = $("transferDialog");
    const name = $("transferName");
    if (!transferNote) {
      $("transferTarget").addEventListener("change", () => transferNote());
      // Enter would submit with the form's first button, 取消; 移动 or 复制 has to be chosen.
      name.addEventListener("keydown", (e) => {
        if (!MdgTyping.composing(e) && e.key === "Enter") e.preventDefault();
      });
      // Spaces alone are no name: the form refuses them like an empty one (the close would take "" for no new folder).
      name.pattern = ".*\\S.*";
    }
    $("transferTitle").textContent = o.title;
    dlg.setAttribute("aria-label", o.title);
    $("transferBody").innerHTML = o.list;
    $("transferLabel").textContent = o.label;
    for (const b of dlg.querySelectorAll("button[value=copy], button[value=move], button[value=add]")) {
      b.hidden = !o.hows.includes(b.value);
      b.classList.toggle("primary", b.value === o.hows.at(-1));
      b.textContent = `${TRANSFER_VERB[b.value]} ${o.n} 个`;
      b.setAttribute("aria-label", b.textContent);
    }
    $("transferHow").textContent = o.how || "";
    $("transferHow").hidden = !o.how;
    $("transferTarget").innerHTML = [...o.options, ["new", o.newText]].map(([v, text]) => `<option value="${esc(v)}">${esc(text)}</option>`).join("");
    name.value = "";
    name.maxLength = o.newMax;
    name.placeholder = o.newPlaceholder;
    name.setAttribute("aria-label", o.newPlaceholder);
    $("transferPrivate").checked = false;
    $("transferPrivateRow").hidden = !o.privacy;
    transferNote = () => {
      const v = $("transferTarget").value;
      $("transferNewRow").hidden = v !== "new";
      name.required = v === "new";
      const note = o.note?.(v) || "";
      $("transferUnchosen").hidden = !note;
      $("transferUnchosen").innerHTML = note;
    };
    transferNote();
    dlg.returnValue = "";
    dlg.showModal();
    return new Promise((resolve) => {
      dlg.addEventListener(
        "close",
        () => {
          const how = dlg.returnValue;
          if (!o.hows.includes(how)) return resolve(null);
          const v = $("transferTarget").value;
          resolve({ how, target: v === "new" ? { create: name.value.trim(), privacy: Boolean(o.privacy && $("transferPrivate").checked) } : { id: v } });
        },
        { once: true }
      );
    });
  }

  // One sidebar entry: pre (thumb, ★), the name, the count (dimmed at 0 as every filter's, DESIGN 产品决策 · 筛选和计数; none when null).
  const sideItem = ({ attrs, label, count = null, on, pre = "" }) =>
    `<button type="button" class="side-item${on ? " on" : ""}${count === 0 ? " zero" : ""}" ${attrs}${on ? ' aria-current="true"' : ""}>${pre}<span class="side-name">${esc(label)}</span>${count == null ? "" : `<span class="side-count">${count}</span>`}</button>`;
  // The sidebar's foot: the mode's own settings.
  const sideFoot = ({ settingsAttrs, settingsLabel }) =>
    `<div class="side-foot"><button type="button" class="side-item side-settings" ${settingsAttrs}>${ICON.gear}${esc(settingsLabel)}</button></div>`;

  // ----- tags: both modes' 标签管理 and the 「+ 标签」 button (the picker itself is tag-picker.js) -----
  // Why name cannot be a tag among others (the list it would join, itself left out), or "".
  // A tag's 说明 (what the AI reads for it): at most this many characters, in 标签管理 and in the prompt.
  const TAG_RULE_MAX = 80;
  // An AI 打标签 proposal kept until 应用 or 放弃: the pill's words in both modes.
  const AI_TAGS_PENDING = "标签建议待确认";
  const tagNameError = (name, others) => (!name ? "标签名不能为空" : others.some((t) => t.name === name) ? "已有同名标签" : "");
  // who is 视频 or UP 主; a Latin word gets a space before it (「个 UP 主」, 「个视频」).
  const sp = (who) => (/^[A-Za-z]/.test(who) ? ` ${who}` : who);
  // A unit's tags: 「视频标签」, 「 UP 标签」 (DESIGN's name for the tags on an UP, not 「UP 主标签」).
  const tagsWord = (who) => (who === "UP 主" ? " UP 标签" : `${sp(who)}标签`);
  // The delete confirm's title and body.
  const deleteTagAsk = (t, n, who) => [`删除标签「${t.name}」？`, `<p>将从 ${n} 个${sp(who)}上去掉这个标签，无法撤销。</p>`];
  // A batch confirm's list: the first CONFIRM_NAMES names, then 「等 N 个」.
  const CONFIRM_NAMES = 10;
  const confirmList = (names) => `<ul>${names.slice(0, CONFIRM_NAMES).map((n) => `<li>${esc(n)}</li>`).join("")}</ul>${names.length > CONFIRM_NAMES ? `<p>等 ${names.length} 个</p>` : ""}`;
  // The tag picker's title: 「给「名字」打视频标签 / 打 UP 标签」 (a name alone does not say which), or for several
  // 「给选中的 N 个视频打标签」.
  const pickTitle = (n, name, who) => (n > 1 ? `给选中的 ${n} 个${sp(who)}打标签` : `给「${name}」打${tagsWord(who)}`);
  // U on a step that changed n ≥ 2 items asks this first: kind is tags (one 标签… save), ai (one applied AI 打标签) or
  // keep (one batch 保留).
  const UNDO_ASK = {
    tags: (n, w) => [`撤销批量改标签？`, `上一步改了 ${n} 个${w}的标签，撤销后都改回去。`],
    ai: (n, w) => [`撤销这次 AI 打标签？`, `这次 AI 打标签改过的 ${n} 个${w}，标签都改回 AI 打之前，包括你之后又改过的。`],
    keep: (n, w) => [`撤销批量保留？`, `上一步保留了 ${n} 个${w}，撤销后它们不再标为保留。`]
  };
  function undoAsk(kind, n, who) {
    const [title, body] = UNDO_ASK[kind](n, sp(who));
    return [title, `<p>${body}</p>`, "撤销"];
  }
  // A 标签管理 edit, for both modes: { tag } the edited copy, or { why } for an empty or duplicate name (others = the
  // other tags it must not repeat). A rule is trimmed and capped at 80; an empty one drops the field.
  function editedTag(t, field, value, others) {
    if (field === "name") {
      const name = cleanTagName(value);
      const why = tagNameError(name, others);
      return why ? { why } : { tag: { ...t, name } };
    }
    if (field === "color") return { tag: { ...t, color: cycleTagColor(t.color) } };
    if (field !== "rule") return {};
    const { rule: _, ...rest } = t;
    const rule = String(value ?? "").trim().slice(0, TAG_RULE_MAX);
    return { tag: rule ? { ...rest, rule } : rest };
  }
  // An UP's newest UP_RECENT titles, newest first and one per title: the video feed's (follow_last.v) and its own videos'
  // (follow_content, read fine). The card shows them and the AI 打标签 reads them.
  const UP_RECENT = 3;
  function upTitles(feed, content) {
    const all = [...(feed || []), ...(content?.code === 0 ? content.v || [] : [])].sort((a, b) => (b.c || 0) - (a.c || 0));
    const seen = new Set();
    return all.filter((v) => v.t && !seen.has(v.t) && seen.add(v.t)).slice(0, UP_RECENT);
  }
  // A tag map ({ key: [tag ids] }) without one tag; a key left with none drops out.
  function withoutTag(map, id) {
    const out = {};
    for (const [k, ids] of Object.entries(map)) {
      const rest = ids.filter((x) => x !== id);
      if (rest.length) out[k] = rest;
    }
    return out;
  }
  // 「AI 刚打的」: the items the last applied AI 打标签 changed, to look over on their cards. Only these end it.
  // An AI 打标签 run finished with the dialog closed, in the mode and folder it ran in: both ways to its proposal.
  const AI_TAGS_DONE = "AI 打标签已完成，按 I 或点进度胶囊的「查看」确认建议";
  const aiTagsFailed = (error) => `AI 打标签没有成功：${error}`;
  const aiApplied = (n, who) => `已应用 AI 建议：${n} 个${sp(who)}，列表只显示这些 · U 撤销`;
  // The dialog's recent instructions: the newest first, each once, at most 5.
  const aiHistoryAdd = (history, instruction) => [instruction, ...history.filter((x) => x !== instruction)].slice(0, 5);
  const AI_RECENT_RULES = ["点 ×：不再标出，标签不变", "再让 AI 打一次：换成新的一批"];
  const aiRecentUndo = (who) => `按 U 撤销这次 AI 打标签前会先问你；确认后这批${sp(who)}的标签都回到 AI 打之前，包括你之后又改过的。`;
  // Row 3's 「✦ AI 刚打的」 and its ×, while there are some (n) or it is on; "" otherwise.
  function aiRecentChip({ attrs, xAttrs, n, on, who }) {
    if (!n && !on) return "";
    const tip = `最近一次 AI 打标签改动的${sp(who)}，${AI_RECENT_CHECK}。\n${AI_RECENT_RULES.map((r) => `· ${r}`).join("\n")}\n${aiRecentUndo(who)}`;
    return stateGroup(AI_RECENT, filterBtn(`${attrs} title="${esc(tip)}"`, AI_RECENT, n, on, AI_SPARK) + AI_RECENT_X(xAttrs), " ai-recent");
  }
  // One row of 标签管理: color, name, the line for the AI, how many carry it, 删除. Edits save on change.
  const tagRowHtml = (t, { count, who }) => `<div class="tag-row" data-id="${esc(t.id)}">
      <button type="button" class="tag-color" style="--c:${esc(t.color)}" data-tag-color title="换一个颜色" aria-label="换 ${esc(t.name)} 的颜色"></button>
      <input type="text" name="tagName" value="${esc(t.name)}" data-field="name" maxlength="${MdgTagCore.TAG_NAME_MAX}" aria-label="标签名称" />
      <input type="text" name="tagRule" value="${esc(t.rule || "")}" data-field="rule" maxlength="${TAG_RULE_MAX}" placeholder="什么样的${esc(sp(who))}打这个标签（给 AI 看，可不写）" aria-label="${esc(t.name)} 的说明" />
      <span class="muted">${count} 个${esc(sp(who))}</span>
      <button type="button" class="danger" data-tag-del aria-label="删除标签 ${esc(t.name)}">删除</button>
    </div>`;
  // 「+ 标签 T」 on 视频投稿 cards and the viewer lines; attrs say what it tags. key: false leaves out the T where T acts
  // on something else.
  const tagPlusBtn = (attrs, label, key = true) =>
    `<button type="button" class="quiet tag-plus" ${attrs} aria-label="${esc(label)}">+ 标签${key ? ` <kbd class="k-faint" aria-hidden="true">T</kbd>` : ""}</button>`;
  // One tag line under the player, named as rows 3 and 4 (labeledRow): 「视频标签」 or 「UP 标签」, pre (the UP's face and
  // name), the chips, then 「+ 标签」 when plus is given. No 「未打标签」: an empty line is the button.
  const viewerLine = ({ label, pre = "", chips, plus }) =>
    labeledRow(label, `${pre}${chips}${plus ? tagPlusBtn(plus.attrs, plus.label, plus.key) : ""}`);
  // T / Esc forwarded by viewer-frame.js while focus is in the player: only from the viewer's own frame and B站's origin.
  function viewerKeyFrom(e, frameWin) {
    const ok = frameWin && e.source === frameWin && /^https:\/\/(www|space)\.bilibili\.com$/.test(e.origin) && e.data?.type === "mdg-viewer-key";
    return ok && ["t", "Escape"].includes(e.data.key) ? e.data.key : "";
  }

  // An empty list with a title, why it is empty, and what to do (actionHtml, usually 刷新).
  const emptyState = (title, text, actionHtml = "") =>
    `<div class="empty-state"><p><strong>${esc(title)}</strong></p>${text ? `<p class="dialog-hint">${esc(text)}</p>` : ""}${actionHtml}</div>`;

  // 刷新 in an empty state: a plain button, since row 3 keeps the page's one .primary (DESIGN 视觉设计 · 颜色).
  const refreshEmpty = (attrs) => `<button type="button" ${attrs}>${ICON.refresh}${MdgErrors.LABEL.refresh}</button>`;
  // Why a list with items shows none: the search (q), else the filters (filtered); "" when it is neither.
  const noMatch = (q, filtered, who) => (String(q ?? "").trim() ? `没有匹配搜索的${sp(who)}` : filtered ? `没有符合筛选的${sp(who)}` : "");

  // Titles one 粗看 request carries (fixed, not a setting; the output limit's 自动 grows with it).
  const TITLES_PER_REQUEST = 20;
  // 粗看 and ✦ AI 打标签 send the first INTRO_CHARS of each description; 细看 reads DEEP_COMMENTS hot comments when a
  // video has no subtitle (fewer than a note's MdgLimits.HOT_COMMENTS: the AI only needs the gist).
  const INTRO_CHARS = 120;
  const DEEP_COMMENTS = 10;
  // Fixed numbers the hints quote, through [data-hint-num="key"] spans that fillNumHints fills (options.html, triage.html).
  const hintNums = () => ({
    titlesPerRequest: TITLES_PER_REQUEST,
    introChars: INTRO_CHARS,
    deepComments: DEEP_COMMENTS,
    hotComments: MdgLimits.HOT_COMMENTS,
    aiSubtitleWan: MdgLimits.AI_SUBTITLE_MAX_CHARS / 10000,
    presetPrompts: MdgSettings.MAX_PRESET_PROMPTS,
    noteSections: MdgSettings.MAX_NOTE_SECTIONS
  });
  // 输出上限's 自动 (maxTokens left empty): 粗看 per title, ✦ AI 打标签 ("command", which reads 粗看's setting) per item,
  // 细看 per video; thinking tokens count against it. The background sends it, the settings dialog shows it.
  const autoMaxTokens = (kind, itemCount, thinking) =>
    kind === "title" ? (thinking ? 150 * itemCount + 4000 : 60 * itemCount + 200)
    : kind === "command" ? (thinking ? 180 * itemCount + 4000 : 80 * itemCount + 400)
    : thinking ? 8000 : 1000;
  // The whole-number settings of both dialogs: [min, max, default], default 0 = 自动. The readers (pages and background)
  // parse with numSetting; fillSetRows gives each box (data-num) its range and the default as placeholder, and
  // writes them into the hints' [data-num-min] / [data-num-max] / [data-num-default] spans, so no hint repeats a number.
  const NUM_SETTINGS = {
    interval: [0, 600, 8], // both modes
    aiBatch: [1, 100, 30], // both modes
    newTagMax: [0, 50, 5], // both modes
    tagLimit: [1, 50, 10],
    coarseBatch: [1, 1000, 100],
    fineBatch: [1, 50, 10],
    maxTokens: [200, 32000, 0],
    slowDays: [7, 3650, 90],
    deadDays: [8, 3651, 365]
  };
  // Settings rows both dialogs have: the same name and hint. Each .set-row contains its input.
  const SET_ROWS = {
    interval: ["请求间隔（秒）", ""],
    // 收藏夹 stores it as triageAiBatchSize, 关注 in follow_ai_settings.batchSize.
    aiBatch: ["AI 打标签每批数量", `${NUM_SETTINGS.aiBatch[0]}–${NUM_SETTINGS.aiBatch[1]} 个一批。`],
    newTagMax: ["AI 打标签时最多新建几个标签", `${NUM_SETTINGS.newTagMax[0]}–${NUM_SETTINGS.newTagMax[1]}，0 = 只用已有标签。`],
    allowRemove: ["AI 打标签时允许去掉已有标签", "关时只加标签。开了也要你确认。"]
  };
  const numSetting = (kind, v) => intIn(v, ...NUM_SETTINGS[kind]);
  function fillSetRows(root) {
    for (const row of root.querySelectorAll("[data-set-row]:not(:has(label))")) {
      const [name, hint] = SET_ROWS[row.dataset.setRow];
      const input = row.querySelector("input");
      row.insertAdjacentHTML("afterbegin", `<div><label class="name" for="${esc(input.id)}">${esc(name)}</label>${hint ? `<p class="hint">${esc(hint)}</p>` : ""}</div>`);
    }
    for (const input of root.querySelectorAll("input[data-num]")) {
      const [min, max, def] = NUM_SETTINGS[input.dataset.num];
      Object.assign(input, { min, max, placeholder: def ? `默认 ${def}` : "自动" });
    }
    fillNumHints(root);
  }
  // Hint spans [data-num-min|max|default="kind"] get that setting's number; the settings page calls this alone.
  function fillNumHints(root) {
    for (const node of root.querySelectorAll("[data-num-min], [data-num-max], [data-num-default]")) {
      const { numMin, numMax, numDefault } = node.dataset;
      const [min, max, def] = NUM_SETTINGS[numMin ?? numMax ?? numDefault];
      node.textContent = numMin ? min : numMax ? max : def;
    }
    const nums = hintNums();
    for (const node of root.querySelectorAll("[data-hint-num]")) node.textContent = nums[node.dataset.hintNum];
  }

  // A number field is corrected by intIn when left or saved, instead of the browser refusing to save: above max is max,
  // below min (or negative) is emptied, and empty means the default (自动 where the box says so).
  function clampNumber(input) {
    if (input?.type !== "number" || input.value === "") return;
    input.value = intIn(input.value, Number(input.min), input.max === "" ? Infinity : Number(input.max), "");
  }
  // A whole-number setting as stored or typed: settings.js's one rule (it loads first everywhere shared.js does).
  const intIn = MdgSettings.intIn;
  function clampNumbers(root) {
    for (const form of root.querySelectorAll("form:has(input[type=number])")) form.noValidate = true;
    root.addEventListener("change", (e) => clampNumber(e.target));
    // Capture: before the dialogs' own submit checks read the values.
    root.addEventListener("submit", (e) => e.target.querySelectorAll("input[type=number]").forEach(clampNumber), true);
  }

  // ---------- AI 打标签: the proposal and what it changes, the same in both modes ----------
  // p = { newTags: [{ key, name, checked }], rows: [{ id, add: ["id:<tag id>" | "new:<key>"], remove: [tag id] }], notes,
  // errors }; a row's id is a bvid in 收藏夹, a mid in 关注. opts = { tags: the mode's tags (by name; 收藏夹 passes the
  // folder's), map: row id → tag ids, maxNewTags, excluded: Set of names, scope: Set of the row ids this run sent,
  // newTagFolder: 所有收藏夹 only, the folder this batch's new tags go into; one proposal then holds several folders' new
  // tags, each folder's apart (key "<folder>/<name>", .folder) and within its own maxNewTags }.
  function mergeAiBatch(p, data, opts) {
    const folder = opts.newTagFolder;
    const keyOf = (name) => (folder ? `${folder}/${name}` : name);
    const existing = (name) => opts.tags.find((t) => t.name === name);
    const proposed = (name) => p.newTags.find((t) => t.key === keyOf(name));
    const addNew = (name) => {
      if (p.newTags.filter((t) => t.folder === folder).length >= opts.maxNewTags) return null;
      const t = { key: keyOf(name), name, checked: true };
      if (folder) t.folder = folder;
      p.newTags.push(t);
      return t;
    };
    const blocked = (name) => opts.excluded?.has(name);
    for (const raw of data?.newTags || []) {
      const name = String(raw ?? "").trim();
      if (name && !blocked(name) && !existing(name) && !proposed(name)) addNew(name);
    }
    if (data?.note) p.notes.push(String(data.note));
    for (const [id, a] of Object.entries(data?.assignments || {})) {
      if (!opts.scope.has(id)) continue;
      const current = opts.map[id] || [];
      const add = [];
      for (const raw of a?.add || []) {
        const name = String(raw ?? "").trim();
        if (!name || blocked(name)) continue;
        const t = existing(name);
        if (t) {
          if (!current.includes(t.id)) add.push(aiRef.id(t.id));
          continue;
        }
        const nt = proposed(name) || addNew(name);
        if (nt) add.push(aiRef.new(nt.key));
      }
      const remove = (a?.remove || [])
        .map((n) => existing(String(n ?? "").trim()))
        .filter((t) => t && !blocked(t.name) && current.includes(t.id))
        .map((t) => t.id);
      if (!add.length && !remove.length) continue;
      const row = p.rows.find((r) => r.id === id);
      if (row) {
        row.add = [...new Set([...row.add, ...add])];
        row.remove = [...new Set([...row.remove, ...remove])];
      } else p.rows.push({ id, add, remove });
    }
  }
  // An AI 打标签 proposal names the tags a row adds as "id:<tag id>" (an existing tag) or "new:<key>" (one it proposes).
  const aiRef = {
    id: (id) => `id:${id}`,
    new: (key) => `new:${key}`,
    idOf: (ref) => (ref.startsWith("id:") ? ref.slice(3) : ""),
    keyOf: (ref) => (ref.startsWith("new:") ? ref.slice(4) : "")
  };
  // [id, before, after] for every row that changes its tags. live.has(id): the video is still in the folder, the UP still
  // followed (others keep their tags). idOf(key) is a new tag's id; an unchecked new tag adds nothing.
  function aiChanges(p, map, live, idOf) {
    const out = [];
    for (const r of p.rows) {
      if (!live.has(r.id)) continue;
      const before = map[r.id] || [];
      const ids = new Set(before);
      for (const ref of r.add) {
        const key = aiRef.keyOf(ref);
        const id = aiRef.idOf(ref) || (p.newTags.find((t) => t.key === key)?.checked && idOf(key));
        if (id) ids.add(id);
      }
      for (const id of r.remove) ids.delete(id);
      const after = [...ids];
      if (after.length !== before.length || after.some((id) => !before.includes(id))) out.push([r.id, before, after]);
    }
    return out;
  }
  // A saved AI 打标签 proposal still fits the data when every existing tag it adds or removes is still there (hasTag(id));
  // one naming a deleted tag is dropped, not applied.
  const aiProposalOk = (p, hasTag) => Array.isArray(p?.rows) && Array.isArray(p.newTags) && p.rows.every((r) => r.add.every((ref) => !aiRef.idOf(ref) || hasTag(aiRef.idOf(ref))) && r.remove.every(hasTag));
  // Before 应用: a new tag stands in as "new:key", or as the same-name tag in tags (of its folder, when it has one) that
  // creating it would return; a cleared name adds nothing.
  function previewId(p, key, tags) {
    const nt = p.newTags.find((t) => t.key === key);
    const name = cleanTagName(nt?.name);
    return name && (tags.find((t) => t.name === name && (!nt.folder || t.folder === nt.folder))?.id || aiRef.new(key));
  }
  // The confirm page sums the changes up per tag ("+ 科普 12"); the items are judged afterwards on their cards.
  // nameOf(id) names an existing tag.
  function aiTally(p, changes, nameOf) {
    const name = (id) => (aiRef.keyOf(id) ? cleanTagName(p.newTags.find((t) => t.key === aiRef.keyOf(id))?.name) : nameOf(id)) || "";
    const tally = new Map();
    for (const [, before, after] of changes) {
      const rows = after.filter((id) => !before.includes(id)).map((id) => ["add", `+ ${name(id)}`])
        .concat(before.filter((id) => !after.includes(id)).map((id) => ["remove", `− ${name(id)}`]));
      for (const [cls, text] of rows) {
        const t = tally.get(text) || { cls, text, n: 0 };
        t.n++;
        tally.set(text, t);
      }
    }
    return [...tally.values()].sort((a, b) => (a.cls === "remove") - (b.cls === "remove") || b.n - a.n);
  }

  // The header fold (DESIGN 视觉设计 · 分拣台): only the toggle at the start of row 2 folds rows 1–4 into the slim bar
  // (name · count, row 2) and back. Each mode keeps its own state across reloads; scrolling, focus and switching folders,
  // tabs or modes leave it as it is.
  const HEAD_ROWS = ".folder-head, .tabrow, .stagebar, .tagbar";
  const HEAD_FOLD_KEY = "triage_head_folded"; // { fav?: true, follow?: true }
  // Both modes' rows sit in .main's grid; the list runs under them (padding-top --head-h), so folding them is a transform
  // and the cards never move. Row 2 slides up by row 1's height (--head1-h); the viewer starts under what is shown.
  function headFold(main) {
    let folded = {};
    let mode = "";
    let full = 0;
    const toggles = [];
    const modeOf = () => (document.body.classList.contains("follow-mode") ? "follow" : "fav");
    const shown = (sel) => [...main.querySelectorAll(sel)].filter((x) => x.offsetParent);
    const measure = (force = false) => {
      const rows = shown(HEAD_ROWS);
      if (rows.length < 2) return;
      const m = modeOf();
      const on = Boolean(folded[m]);
      main.classList.toggle("head-folded", on);
      for (const b of toggles) b.title = b.ariaLabel = on ? "展开头部" : "收起头部";
      // Folded, rows that grow are not measured, so the cards stay put; unfolding (and a mode's show) measures them.
      const last = rows[rows.length - 1];
      if (!on || m !== mode || force) full = last.offsetTop + last.offsetHeight;
      mode = m;
      scrolled(shown(".list, .fw-list")[0]);
      main.style.setProperty("--head-h", `${full}px`);
      main.style.setProperty("--head1-h", `${rows[1].offsetTop}px`);
      main.style.setProperty("--slim-h", `${rows[1].offsetHeight}px`);
    };
    // A shadow under the header while the list is scrolled: cards are under it.
    const scrolled = (list) => main.classList.toggle("head-scrolled", (list?.scrollTop || 0) > 0);
    main.addEventListener("scroll", (e) => e.target.matches(".list, .fw-list") && scrolled(e.target), true);
    const ro = new ResizeObserver(() => measure());
    for (const row of main.querySelectorAll(HEAD_ROWS)) {
      ro.observe(row);
      // The slim bar's 「名字 · 数量」: a copy of row 1's title, kept in step with it.
      if (!row.classList.contains("folder-head")) continue;
      const slim = Object.assign(document.createElement("span"), { className: "slim-title" });
      const toggle = Object.assign(document.createElement("button"), {
        type: "button", className: "act-btn head-toggle", innerHTML: svg('<path d="m18 15-6-6-6 6"/>'),
      });
      toggle.addEventListener("click", () => {
        folded = { ...folded, [modeOf()]: !folded[modeOf()] };
        chrome.storage.local.set({ [HEAD_FOLD_KEY]: folded }).catch(() => {}); // not remembered: this page still toggles
        measure();
      });
      toggles.push(toggle);
      row.nextElementSibling.prepend(toggle, slim);
      const copy = () => (slim.innerHTML = row.querySelector(".folder-title")?.innerHTML || "");
      new MutationObserver(copy).observe(row, { childList: true, subtree: true, characterData: true });
      copy();
    }
    measure();
    // Jumping to a state, no fold animation: measure() reads layout, which applies the styles while head-instant is on.
    const instant = () => {
      main.classList.toggle("head-instant", true);
      measure(true);
      main.classList.toggle("head-instant", false);
    };
    // Not read: unfolded, as on a first visit.
    chrome.storage.local.get(HEAD_FOLD_KEY).then((r) => {
      folded = r?.[HEAD_FOLD_KEY] || {};
      instant();
    }, instant);
    // follow.js's setMode calls it right after switching body.follow-mode (clicks, the view restored on load, deep
    // links), so the new mode's fold shows in the same frame instead of animating in after a ResizeObserver round.
    return instant;
  }

  globalThis.TriageUi = { https, UP_RECENT, upTitles, AI_RECENT, AI_RECENT_CHECK, aiRef, esc, pad, dayText, fmtDate, fmtAgo, agoHtml, setSearchScope, confirmList, pickTitle, fmtDuration, fmtCount, cleanTagName, plainClick, cardPlayClick, cardPickClick, pickCard, img, toCsv, cardTagChip, syncedText, headMeta, titleHtml, AI_SPARK, byValue, dirWords, sortControl, filterBtn, labeledRow, tagFilterChip, kindTabs, originChip, stateGroup, aiRecentChip, searchBox, bindSearch, resultCount, rowButtons, menuItem, BACKUP_ITEM, CLEAN_BACKUP, reasonAttrs, setReason, WARN_DOT, selectAllState, selectAllBox, toggleAll, setActivity, BILI_STUCK, waitText, BILI_HOLD_MS, WRITE_STOPPING, busyText, syncPill, setSync, bindSync, tagButtons, sideFoot, actBtn, cleanBtn, HIDDEN_ALL, selbar, askTransfer, sideItem, emptyState, refreshEmpty, noMatch, fillSetRows, fillNumHints, NUM_SETTINGS, TITLES_PER_REQUEST, INTRO_CHARS, DEEP_COMMENTS, autoMaxTokens, numSetting, clampNumber, intIn, clampNumbers, mergeAiBatch, aiChanges, aiProposalOk, previewId, aiTally, nextTagColor, TAG_RULE_MAX, AI_TAGS_PENDING, tagNameError, deleteTagAsk, editedTag, withoutTag, undoAsk, tagRowHtml, sp, tagsWord, AI_RECENT_RULES, aiRecentUndo, tagPlusBtn, viewerLine, viewerKeyFrom, headFold, FOLLOW_WRITE_GAP_MS, AI_TAGS_DONE, aiTagsFailed, aiApplied, aiHistoryAdd, GROUP_NAME_MAX, groupNameError };
})();
