// What the 分拣台's two modes (triage.js 收藏夹, follow.js 关注) draw the same way, so they cannot drift apart.
// A plain script loaded before both modules. Everything here returns HTML, text or a comparator; only setActivity,
// setSync and bindSync touch the elements they are given, and mergeAiBatch fills the proposal it is given.
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
  // Seconds as 9:47, 1:15:00 from an hour up (minutes padded only after hours).
  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor((sec % 3600) / 60);
    return (sec >= 3600 ? `${Math.floor(sec / 3600)}:${pad(m)}` : m) + `:${pad(sec % 60)}`;
  }
  // 「3 天前」 style ages, both in seconds; under a day is 今天.
  function fmtAgo(sec, now = Date.now() / 1000) {
    const d = Math.floor((now - sec) / 86400);
    if (d < 1) return "今天";
    if (d < 31) return `${d} 天前`;
    if (d < 365) return `${Math.floor(d / 30)} 个月前`;
    return `${Math.floor(d / 365)} 年前`;
  }
  // A card's time: relative, the date on hover.
  const agoHtml = (sec, now) => `<time title="${fmtDate(sec)}">${fmtAgo(sec, now)}</time>`;
  // 播放量 / 粉丝: 12.3万 and 2.5亿 (one decimal, dropped when 0), plain below 万.
  const fmtCount = (n) => (n >= 1e8 ? `${Math.round(n / 1e7) / 10}亿` : n >= 1e4 ? `${Math.round(n / 1e3) / 10}万` : String(n));
  // Tag names, colors and ids: ../tag-core.js, which badges.js on B站 pages loads too.
  const { TAG_COLORS, cleanTagName, nextTagColor, cycleTagColor } = globalThis.BocTagCore;
  // A plain primary click on a video link plays it in the viewer here; with ⌘ / Ctrl / Shift / Alt the browser opens it.
  const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
  // A video card plays on a plain click anywhere on it (收藏夹 and 视频投稿 alike), except on a control inside it
  // (button, field, 「+ 标签」 chip, a link other than the card's own video links) or at the end of a text-selection drag.
  const CARD_CONTROLS = "button, input, textarea, select, label, [data-pick], a[href]:not([data-act=open], [data-play])";
  const cardPlayClick = (e) => plainClick(e) && !e.target.closest(CARD_CONTROLS) && globalThis.getSelection?.()?.isCollapsed !== false;
  // Selecting (收藏夹 and 关注 UP 主): the round box at the card's top-left (pickBox) always picks. While anything is
  // selected, a click anywhere on the card picks instead of playing, its own links included; the controls inside keep
  // their own. Shift picks the run from the last picked card; ⌘ / Ctrl / middle on a link still open B站.
  const PICK_CONTROLS = "button:not([data-select]), input, textarea, select, label, [data-pick]";
  const cardPickClick = (e, selecting) =>
    e.button === 0 && !e.metaKey && !e.ctrlKey && !e.altKey &&
    Boolean(e.target.closest("[data-select]") || (selecting && !e.target.closest(PICK_CONTROLS) && (e.shiftKey || globalThis.getSelection?.()?.isCollapsed !== false)));
  // One pick in sel (a Set, changed in place): a toggle, or with range every listed id from anchor to id. Returns the new anchor.
  function pickCard(sel, ids, id, anchor, range) {
    const a = range ? ids.indexOf(anchor) : -1;
    const b = ids.indexOf(id);
    if (a < 0 || b < 0) sel.has(id) ? sel.delete(id) : sel.add(id);
    else for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) sel.add(x);
    return id;
  }
  const pickBox = (id, on, name) =>
    `<button type="button" class="pick-box" role="checkbox" data-select="${esc(id)}" aria-checked="${Boolean(on)}" aria-label="选中 ${esc(name)} (X)" title="选中（X）· Shift 连选"></button>`;
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

  // Rows 3 and 4 start with their name, 「状态」 and 「标签」, so the two rows of pills tell apart (triage.css .row-label).
  const labeledRow = (label, html) => `<span class="row-label">${esc(label)}</span>${html}`;
  // Row 3 (both modes): one group of state pills; the CSS splits groups by a thin rule and wraps them whole.
  const stateGroup = (label, html, cls = "") => `<span class="seg${cls}" role="group" aria-label="${esc(label)}">${html}</span>`;
  // 「AI 刚打的」's ×: stop marking them, tags stay.
  const AI_RECENT_X = (attrs) => `<button type="button" class="ai-recent-x" ${attrs} aria-label="不再标出「AI 刚打的」，标签不变" title="不再标出，标签不变">×</button>`;

  // The search box's behavior, both modes: it filters as you type (bindLive, IME-safe); Esc clears it, and on an empty
  // box gives the keys back to the cards (J / K work again).
  function bindSearch(input, run) {
    BocTyping.bindLive(input, run);
    input.addEventListener("keydown", (e) => {
      if (BocTyping.composing(e) || e.key !== "Escape") return;
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
    `<button id="${refreshId}" type="button" class="act-btn" aria-label="${esc(refreshLabel)}"${refreshTitle ? ` title="${esc(refreshTitle)}"` : ""}>${ICON.refresh}<span class="lbl">刷新</span></button>` +
    `<button id="${exportId}" type="button" class="act-btn" popovertarget="${menuId}" aria-label="导出">${ICON.export}<span class="lbl">导出</span></button>` +
    `<button type="button" class="act-btn gear-only" ${settingsAttr} aria-label="${esc(settingsLabel)}" title="${esc(settingsLabel)}">${ICON.gear}</button>` +
    `<div id="${menuId}" class="tools export-menu" popover>${menuHtml}</div>`;
  const menuItem = (attrs, label, sub) => `<button type="button" ${attrs}>${esc(label)}<small>${esc(sub)}</small></button>`;
  const BACKUP_ITEM = menuItem('data-backup aria-label="下载完整备份 JSON"', "完整备份 (JSON)", "收藏夹和关注一起，换电脑时用");

  // The running-state pill's inside: text, a bar when done/total is known, and one button (btn = { attrs, label, reason };
  // a reason disables it).
  function activityHtml({ text, done = 0, total = 0, btn = null }) {
    const bar = total ? `<span class="activity-bar" aria-hidden="true"><i style="width:${Math.round((done / total) * 100)}%"></i></span>` : "";
    const b = btn ? `<button type="button" ${btn.attrs} aria-label="${esc(btn.label)}"${reasonAttrs(btn.reason)}>${esc(btn.label)}</button>` : "";
    return `<span class="activity-text">${esc(text)}</span>${bar}${b}`;
  }
  // Draws the pill from state ({ text, done, total, btn, warn }: warn is amber, for a wait); null / false hides it.
  function setActivity(el, a) {
    el.hidden = !a;
    if (!a) return;
    el.classList.toggle("warn", Boolean(a.warn));
    el.innerHTML = activityHtml(a);
  }
  // 「B站限流，01:30 后重试」 while sec > 0, else "".
  const waitText = (why, sec) => (sec > 0 ? `${why}，${fmtDuration(sec)} 后重试` : "");

  // Row 1's 「B站已同步 +N −M」 pill and the notice it opens below it. Ids are prefix + ViewBtn / Notice / Text / Detail /
  // CloseBtn; each mode passes those elements as { pill, notice, text, detail, close }.
  const syncPill = (p) =>
    `<span class="sync-wrap"><button id="${p}ViewBtn" type="button" class="pill sync-pill" aria-expanded="false" aria-controls="${p}Notice" hidden></button>` +
    `<div id="${p}Notice" class="notice" hidden><p id="${p}Text"></p><div id="${p}Detail" class="sync-detail"></div>` +
    `<div class="notice-actions"><button id="${p}CloseBtn" type="button" aria-label="关闭同步提示">关闭</button></div></div></span>`;
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
  function setReason(node, reason, title = "") {
    node.disabled = Boolean(reason);
    node.title = reason || title;
    if (reason) node.setAttribute("aria-description", reason);
    else node.removeAttribute("aria-description");
  }
  // A --warn dot after a button's label: something is not set up yet, and nothing is blocked by it.
  const WARN_DOT = '<i class="dot-warn" aria-hidden="true"></i>';

  // 标签管理 and ✦ AI 打标签 at the right end of the tag row, next to the tags they act on (in 收藏夹 those are the open
  // folder's, so they do not sit in the sidebar). state is 「 · 运行中」 or 「 · 待确认」. noTags puts the dot on 标签管理.
  const tagButtons = ({ manageAttrs, aiAttrs, state = "", manageReason = "", aiReason = "", noTags = false }) =>
    `<span class="tags-acts"><button type="button" class="act-btn" ${manageAttrs}${noTags && !manageReason ? ' aria-label="标签管理（还没有标签）"' : ""}${reasonAttrs(manageReason)}>标签管理${noTags && !manageReason ? WARN_DOT : ""}</button><button type="button" class="act-btn" ${aiAttrs}${reasonAttrs(aiReason)}>${AI_SPARK}AI 打标签${esc(state)}</button></span>`;

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
  // The bar under row 3 while something is selected: n of them listed, hidden more behind filters, 清空选中, then acts.
  const selbar = ({ label, n, hidden, clearAttrs, acts }) =>
    `<div class="selbar" role="toolbar" aria-label="${esc(label)}"><strong class="sel-count">已选中 ${n} 个</strong>${hidden ? `<span class="muted">另有 ${hidden} 个被筛选隐藏</span>` : ""}<button type="button" class="quiet" ${clearAttrs} aria-label="清空选中">清空选中</button><span class="sel-actions">${acts}</span></div>`;
  // ----- 移动 / 复制 (#transferDialog): 收藏夹's folders and 关注's groups -----
  // o = { title, list (html), n, hows ("copy" / "move" / "add" buttons shown; the last is the blue one), label (目标收藏夹 /
  // 目标分组), options [[value, text]], newText (新建收藏夹… / 新建分组…), newPlaceholder, newMax, privacy (show 设为私密),
  // how (the hint under it, "" hides it), note(value) (html of the amber line for that target, "" hides it) }.
  // Resolves { how, target: { id } | { create, privacy } }, or null when cancelled.
  let transferNote = null;
  function askTransfer(o) {
    const $ = (id) => document.getElementById(id);
    const dlg = $("transferDialog");
    const name = $("transferName");
    if (!transferNote) {
      $("transferTarget").addEventListener("change", () => transferNote());
      // Enter would submit with the form's first button, 取消; 移动 or 复制 has to be chosen.
      name.addEventListener("keydown", (e) => {
        if (!BocTyping.composing(e) && e.key === "Enter") e.preventDefault();
      });
    }
    $("transferTitle").textContent = o.title;
    $("transferBody").innerHTML = o.list;
    $("transferLabel").textContent = o.label;
    for (const b of dlg.querySelectorAll("button[value=copy], button[value=move], button[value=add]")) {
      b.hidden = !o.hows.includes(b.value);
      b.classList.toggle("primary", b.value === o.hows.at(-1));
      b.textContent = `${{ copy: "复制", move: "移动", add: "收藏" }[b.value]} ${o.n} 个`;
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

  // One sidebar entry: pre (thumb, ★), the name, the count (dimmed at 0 as every filter's, DESIGN §4; none when null).
  const sideItem = ({ attrs, label, count = null, on, pre = "" }) =>
    `<button type="button" class="side-item${on ? " on" : ""}${count === 0 ? " zero" : ""}" ${attrs}${on ? ' aria-current="true"' : ""}>${pre}<span class="side-name">${esc(label)}</span>${count == null ? "" : `<span class="side-count">${count}</span>`}</button>`;
  // The sidebar's foot: the mode's own settings.
  const sideFoot = ({ settingsAttrs, settingsLabel }) =>
    `<div class="side-foot"><button type="button" class="side-item side-settings" ${settingsAttrs}>${ICON.gear}${esc(settingsLabel)}</button></div>`;

  // ----- tags: both modes' 标签管理 and the 「+ 标签」 button (the picker itself is tag-picker.js) -----
  // Why name cannot be a tag among others (the list it would join, itself left out), or "".
  const tagNameError = (name, others) => (!name ? "标签名不能为空" : others.some((t) => t.name === name) ? "已有同名标签" : "");
  // who is 视频 or UP 主; a Latin word gets a space before it (「个 UP 主」, 「个视频」).
  const sp = (who) => (/^[A-Za-z]/.test(who) ? ` ${who}` : who);
  // The delete confirm's title and body.
  const deleteTagAsk = (t, n, who) => [`删除标签「${t.name}」？`, `<p>将从 ${n} 个${sp(who)}上去掉这个标签，无法撤销。</p>`];
  // A batch confirm's list: the first 10 names, then 「等 N 个」.
  const confirmList = (names) => `<ul>${names.slice(0, 10).map((n) => `<li>${esc(n)}</li>`).join("")}</ul>${names.length > 10 ? `<p>等 ${names.length} 个</p>` : ""}`;
  // The tag picker's title: 「给「名字」打标签」, or for several 「给选中的 N 个视频打标签」.
  const pickTitle = (n, name, who) => (n > 1 ? `给选中的 ${n} 个${sp(who)}打标签` : `给「${name}」打标签`);
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
    const rule = String(value ?? "").trim().slice(0, 80);
    return { tag: rule ? { ...rest, rule } : rest };
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
  const AI_RECENT_RULES = ["点 ×：不再标出，标签不变", "再让 AI 打一次：换成新的一批"];
  const aiRecentUndo = (who) => `按 U 撤销这次 AI 打标签前会先问你；确认后这批${sp(who)}的标签都回到 AI 打之前，包括你之后又改过的。`;
  // Row 3's 「✦ AI 刚打的」 and its ×, while there are some (n) or it is on; "" otherwise.
  function aiRecentChip({ attrs, xAttrs, n, on, who }) {
    if (!n && !on) return "";
    const tip = `最近一次 AI 打标签改动的${sp(who)}，在卡片上逐个看，不对的按 T 改。\n${AI_RECENT_RULES.map((r) => `· ${r}`).join("\n")}\n${aiRecentUndo(who)}`;
    return stateGroup("AI 刚打的", filterBtn(`${attrs} title="${esc(tip)}"`, "AI 刚打的", n, on, AI_SPARK) + AI_RECENT_X(xAttrs), " ai-recent");
  }
  // One row of 标签管理: color, name, the line for the AI, how many carry it, 删除. Edits save on change.
  const tagRowHtml = (t, { count, who }) => `<div class="tag-row" data-id="${esc(t.id)}">
      <button type="button" class="tag-color" style="--c:${esc(t.color)}" data-tag-color title="换一个颜色" aria-label="换 ${esc(t.name)} 的颜色"></button>
      <input type="text" value="${esc(t.name)}" data-field="name" maxlength="12" aria-label="标签名称" />
      <input type="text" value="${esc(t.rule || "")}" data-field="rule" maxlength="80" placeholder="什么样的${esc(sp(who))}打这个标签（给 AI 看，可不写）" aria-label="${esc(t.name)} 的说明" />
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
    const ok = frameWin && e.source === frameWin && e.origin === "https://www.bilibili.com" && e.data?.type === "mdg-viewer-key";
    return ok && ["t", "Escape"].includes(e.data.key) ? e.data.key : "";
  }

  // An empty list with a title, why it is empty, and what to do (actionHtml, usually 刷新).
  const emptyState = (title, text, actionHtml = "") =>
    `<div class="empty-state"><p><strong>${esc(title)}</strong></p>${text ? `<p class="dialog-hint">${esc(text)}</p>` : ""}${actionHtml}</div>`;

  // 刷新 in an empty state: a plain button, since row 3 keeps the page's one .primary (DESIGN §1).
  const refreshEmpty = (attrs) => `<button type="button" ${attrs}>${ICON.refresh}刷新</button>`;
  // Why a list with items shows none: the search (q), else the filters (filtered); "" when it is neither.
  const noMatch = (q, filtered, who) => (String(q ?? "").trim() ? `没有匹配搜索的${sp(who)}` : filtered ? `没有符合筛选的${sp(who)}` : "");

  // Settings rows both dialogs have: the same name and hint. Markup: <div class="set-row" data-set-row="key"><input …></div>.
  const SET_ROWS = {
    interval: ["请求间隔（秒）", ""],
    // 收藏夹 stores it as triageAiBatchSize (triageTitleBatchSize until first saved), 关注 in follow_ai_settings.batchSize.
    aiBatch: ["AI 打标签每批数量", "1–100 个一批。"],
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

  // ---------- AI 打标签: the proposal and what it changes, the same in both modes ----------
  // p = { newTags: [{ key, name, checked }], rows: [{ id, add: ["id:<tag id>" | "new:<key>"], remove: [tag id] }], notes,
  // errors }; a row's id is a bvid in 收藏夹, a mid in 关注. opts = { tags: the mode's tags (by name; 收藏夹 passes the
  // folder's), map: row id → tag ids, maxNewTags, excluded: Set of names, scope: Set of the row ids this run sent }.
  function mergeAiBatch(p, data, opts) {
    const existing = (name) => opts.tags.find((t) => t.name === name);
    const proposed = (name) => p.newTags.find((t) => t.key === name);
    const addNew = (name) => {
      if (p.newTags.length >= opts.maxNewTags) return null;
      const t = { key: name, name, checked: true };
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
          if (!current.includes(t.id)) add.push(`id:${t.id}`);
          continue;
        }
        const nt = proposed(name) || addNew(name);
        if (nt) add.push(`new:${nt.key}`);
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
  // [id, before, after] for every row that changes its tags. live.has(id): the video is still in the folder, the UP still
  // followed (others keep their tags). idOf(key) is a new tag's id; an unchecked new tag adds nothing.
  function aiChanges(p, map, live, idOf) {
    const out = [];
    for (const r of p.rows) {
      if (!live.has(r.id)) continue;
      const before = map[r.id] || [];
      const ids = new Set(before);
      for (const ref of r.add) {
        const key = ref.slice(4);
        const id = ref.startsWith("id:") ? ref.slice(3) : p.newTags.find((t) => t.key === key)?.checked && idOf(key);
        if (id) ids.add(id);
      }
      for (const id of r.remove) ids.delete(id);
      const after = [...ids];
      if (after.length !== before.length || after.some((id) => !before.includes(id))) out.push([r.id, before, after]);
    }
    return out;
  }
  // Before 应用: a new tag stands in as "new:key", or as the same-name tag in tags that creating it would return; a
  // cleared name adds nothing.
  function previewId(p, key, tags) {
    const name = cleanTagName(p.newTags.find((t) => t.key === key)?.name);
    return name && (tags.find((t) => t.name === name)?.id || `new:${key}`);
  }
  // The confirm page sums the changes up per tag ("+ 科普 12"); the items are judged afterwards on their cards.
  // nameOf(id) names an existing tag.
  function aiTally(p, changes, nameOf) {
    const name = (id) => (id.startsWith("new:") ? cleanTagName(p.newTags.find((t) => t.key === id.slice(4))?.name) : nameOf(id)) || "";
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

  globalThis.TriageUi = { esc, pad, dayText, fmtDate, fmtAgo, agoHtml, setSearchScope, confirmList, pickTitle, fmtDuration, fmtCount, cleanTagName, plainClick, cardPlayClick, cardPickClick, pickCard, pickBox, img, toCsv, cardTagChip, syncedText, headMeta, titleHtml, ICON, AI_SPARK, byValue, dirWords, sortControl, filterBtn, labeledRow, stateGroup, aiRecentChip, searchBox, bindSearch, resultCount, rowButtons, menuItem, BACKUP_ITEM, reasonAttrs, setReason, WARN_DOT, selectAllState, selectAllBox, toggleAll, setActivity, waitText, syncPill, setSync, bindSync, tagButtons, sideFoot, selbar, askTransfer, sideItem, emptyState, refreshEmpty, noMatch, fillSetRows, mergeAiBatch, aiChanges, previewId, aiTally, TAG_COLORS, nextTagColor, cycleTagColor, tagNameError, deleteTagAsk, editedTag, withoutTag, undoAsk, tagRowHtml, sp, AI_RECENT_RULES, aiRecentUndo, tagPlusBtn, viewerLine, viewerKeyFrom };
})();
