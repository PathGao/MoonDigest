// The one tag picker (#tagPicker), for 收藏夹's videos, 关注's UP 主 and 摘读记录: a modal, or a popover under an anchor
// (a 「+ 标签」). Three equal columns of tags under the filter. With the filter empty, 1–9 and 0 tick the first ten and
// the arrows move on the grid; while filtering (one space is enough, so a name can start with a digit) digits are
// text, ↑↓ walk the results and ←→ move the caret. Enter ticks or creates. Ticks stay here until it closes (Esc, a click
// outside); then opts.onClose gets what changed per target, so one close is one save (and one undo step).
(() => {
  const { esc, cleanTagName } = globalThis.TriageUi;

  // ----- pure -----
  // sets: Map target → Set of tag ids. How many targets have the tag.
  const countOf = (sets, id) => [...sets.values()].filter((s) => s.has(id)).length;
  // A click: every target has the tag → off all, otherwise on all.
  function toggle(sets, id) {
    const off = countOf(sets, id) === sets.size;
    for (const s of sets.values()) off ? s.delete(id) : s.add(id);
  }
  // What closing saves: per changed target, the ids added and removed since opening. The caller applies them to the
  // stored ids (applyChange), so a tag another target or tab changed meanwhile is kept.
  function changesOf(before, sets) {
    const out = [];
    for (const [key, s] of sets) {
      const was = new Set(before.get(key));
      const add = [...s].filter((id) => !was.has(id));
      const remove = [...was].filter((id) => !s.has(id));
      if (add.length || remove.length) out.push({ key, add, remove });
    }
    return out;
  }
  const applyChange = (ids, c) => [...new Set([...ids.filter((id) => !c.remove.includes(id)), ...c.add])];
  // The rows: the tags whose name has q, then 新建「q」 when no tag has that name and one can be made here.
  function rowsOf(tags, q, canCreate) {
    const low = q.toLowerCase();
    const out = tags.filter((t) => t.name.toLowerCase().includes(low)).map((tag) => ({ tag }));
    if (q && canCreate && !tags.some((t) => t.name === q)) out.push({ create: q });
    return out;
  }

  const COLS = 3;
  const KEY_COUNT = 10;
  // The key of the i-th tag: 1 to 9, then 0, as the number row and a phone's keypad read.
  const keyOf = (i) => (i < KEY_COUNT ? String((i + 1) % KEY_COUNT) : "");
  const indexOfKey = (k) => (k === "0" ? KEY_COUNT - 1 : Number(k) - 1);
  // With more tags than keys the most used come first; opened once, so ticking moves nothing.
  const orderOf = (tags, usesOf) =>
    tags.length <= KEY_COUNT || !usesOf ? tags.map((t) => t.id) : tags.map((t) => [t.id, usesOf(t.id)]).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  // Tags in the order fixed at opening; one made since goes last.
  function inOrder(tags, order) {
    const rank = new Map(order.map((id, i) => [id, i]));
    return [...tags].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  }
  // An arrow on the grid: ←→ along the reading order, ↑↓ within the column; both wrap.
  function gridMove(i, n, key) {
    if (!n) return 0;
    if (key === "ArrowRight") return (i + 1) % n;
    if (key === "ArrowLeft") return (i + n - 1) % n;
    const col = i % COLS;
    const rows = Math.floor((n - 1 - col) / COLS) + 1;
    return col + (((i - col) / COLS + (key === "ArrowDown" ? 1 : rows - 1)) % rows) * COLS;
  }

  // ----- the dialog -----
  const dlg = document.getElementById("tagPicker");
  if (!dlg) return void (globalThis.TagPicker = { toggle, changesOf, applyChange, rowsOf, keyOf, indexOfKey, orderOf, inOrder, gridMove });
  const input = dlg.querySelector(".tp-input");
  input.maxLength = MdgTagCore.TAG_NAME_MAX;
  const list = dlg.querySelector(".picker-list");
  const title = dlg.querySelector(".tp-title");
  const note = dlg.querySelector(".tp-note");
  // The open picker: opts, sets (the ticks), before (ids at opening), rows, index (the active row).
  let cur = null;

  // opts: { title, note?, targets, idsOf(target), tags(), usesOf?(id), canCreate, create(name) → tag | null (may be async),
  // empty? (why the list is empty and nothing can be made), anchor? (a CSS selector, so it survives redraws), onClose(changes) }.
  function open(opts) {
    close();
    const sets = new Map(opts.targets.map((k) => [k, new Set(opts.idsOf(k))]));
    cur = { opts, sets, before: new Map([...sets].map(([k, s]) => [k, [...s]])), rows: [], index: 0, order: orderOf(opts.tags(), opts.usesOf) };
    title.textContent = opts.title;
    note.textContent = opts.note || "";
    input.value = "";
    dlg.classList.toggle("tp-pop", Boolean(opts.anchor));
    render();
    if (opts.anchor) {
      dlg.show();
      place();
    } else {
      dlg.style.left = dlg.style.top = ""; // a popover's place would pull the modal off center
      dlg.showModal();
    }
    input.focus(); // also takes the keys back from the player's frame
  }

  // Every way out ends here, once: Esc, a click outside, the window losing focus.
  function close() {
    if (!cur) return;
    const c = cur;
    cur = null;
    if (dlg.open) dlg.close();
    c.opts.onClose(changesOf(c.before, c.sets));
  }

  function render() {
    const { opts, sets } = cur;
    const q = cleanTagName(input.value);
    cur.rows = rowsOf(inOrder(opts.tags(), cur.order), q, opts.canCreate);
    // Where no tag can be made here (or now: a full folder), the box does not offer it.
    const make = Boolean(opts.canCreate);
    const hint = !make ? "筛选标签" : opts.tags().length ? "筛选或新建标签" : "输入名称，回车新建标签";
    input.placeholder = hint;
    input.setAttribute("aria-label", hint);
    cur.index = Math.min(cur.index, Math.max(0, cur.rows.length - 1));
    list.innerHTML =
      cur.rows
        .map((r, i) => {
          const active = i === cur.index;
          const attrs = `role="option" class="picker-opt${active ? " active" : ""}${r.create ? " tp-new" : ""}" data-i="${i}" aria-selected="${active}"`;
          if (r.create) return `<li ${attrs}><span class="slot">+</span><span class="name">新建「${esc(r.create)}」</span></li>`;
          const n = countOf(sets, r.tag.id);
          const all = n === sets.size;
          const some = sets.size > 1 && n ? `<span class="muted">${n} 个有</span>` : "";
          const key = !input.value && keyOf(i) ? `<span class="n" aria-hidden="true">${keyOf(i)}</span>` : "";
          return `<li ${attrs.replace('class="picker-opt', `class="picker-opt${all ? " on" : ""}`)} style="--c:${esc(r.tag.color)}" title="${esc(r.tag.name)}" aria-checked="${all ? "true" : n ? "mixed" : "false"}"><span class="slot">${all ? "✓" : n ? "–" : '<span class="dot"></span>'}</span><span class="name">${esc(r.tag.name)}</span>${some}${key}</li>`;
        })
        .join("") || (opts.empty ? `<li class="muted">${esc(opts.empty)}</li>` : "");
    list.querySelector(".active")?.scrollIntoView?.({ block: "nearest" });
  }

  async function pick(i) {
    const c = cur;
    const r = c?.rows[i];
    if (!r) return;
    c.index = i;
    if (r.tag) toggle(c.sets, r.tag.id);
    else {
      const tag = await c.opts.create(r.create);
      if (cur !== c) return;
      input.value = "";
      c.index = 0;
      if (tag) for (const s of c.sets.values()) s.add(tag.id);
    }
    render();
  }

  // Under the anchor, or above it when there is no room below; always inside the window (an anchor scrolled out of it).
  function place() {
    const r = (document.querySelector(cur.opts.anchor) || document.body).getBoundingClientRect();
    const w = dlg.offsetWidth;
    const h = dlg.offsetHeight;
    let y = r.bottom + 6;
    if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 6);
    dlg.style.left = `${Math.min(Math.max(8, r.left), innerWidth - w - 8)}px`;
    dlg.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
  }

  // Runs before the page's own key handlers see the key (they skip open dialogs and text fields anyway).
  dlg.addEventListener("keydown", (e) => {
    if (!cur || MdgTyping.composing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === "Escape") close();
    else if (/^Arrow(Up|Down|Left|Right)$/.test(k)) {
      const n = cur.rows.length;
      if (!input.value) cur.index = gridMove(cur.index, n, k);
      else if (k === "ArrowLeft" || k === "ArrowRight") return; // the caret's
      else if (n) cur.index = (cur.index + (k === "ArrowDown" ? 1 : n - 1)) % n;
      render();
    } else if (k === "Enter" && e.target === input) pick(cur.index);
    // As the numbers show: only with the box empty. A digit no tag has goes into the box.
    else if (/^[0-9]$/.test(k) && !input.value && cur.rows[indexOfKey(k)]?.tag) pick(indexOfKey(k));
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  MdgTyping.bindLive(input, () => cur && ((cur.index = 0), render()), 0);
  // Focus stays in the filter, or the keys stop working and only a click outside closes. A press on the backdrop is the dialog's.
  dlg.addEventListener("mousedown", (e) => e.target !== input && e.target !== dlg && e.preventDefault());
  list.addEventListener("click", (e) => {
    const li = e.target.closest("[data-i]");
    if (li) pick(Number(li.dataset.i));
  });
  // After a reopen the dialog is open again: that close was handled.
  dlg.addEventListener("close", () => !dlg.open && close());
  // The modal's backdrop is the dialog element too; only a point outside its box counts.
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
  });
  // The popover: a click elsewhere or into the player (the window loses focus) closes it.
  document.addEventListener("click", (e) => cur?.opts.anchor && !dlg.contains(e.target) && close(), true);
  addEventListener("blur", () => cur?.opts.anchor && close());
  addEventListener("resize", () => cur?.opts.anchor && place());
  // A scroll (the list, the page) moves the anchor: the popover follows it.
  addEventListener("scroll", () => cur?.opts.anchor && place(), true);

  globalThis.TagPicker = { open, close, isOpen: () => Boolean(cur), toggle, changesOf, applyChange, rowsOf, keyOf, indexOfKey, orderOf, inOrder, gridMove };
})();
