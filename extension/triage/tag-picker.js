// The 分拣台's one tag picker (#tagPicker in triage.html), for 收藏夹's videos and 关注's UP 主: a modal, or a small
// popover under an anchor (the viewer line's 「+ 标签」, a 动态 card's). Keys: ↑↓ move, Enter ticks or creates,
// 1–9 tick the n-th tag while the filter is empty, Esc closes. Ticks stay here until it closes (完成, Esc, a click
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

  // ----- the dialog -----
  const dlg = document.getElementById("tagPicker");
  if (!dlg) return void (globalThis.TagPicker = { toggle, changesOf, applyChange, rowsOf });
  const input = dlg.querySelector(".tp-input");
  const list = dlg.querySelector(".picker-list");
  const title = dlg.querySelector(".tp-title");
  const note = dlg.querySelector(".tp-note");
  // The open picker: opts, sets (the ticks), before (ids at opening), rows, index (the active row).
  let cur = null;

  // opts: { title, note?, targets, idsOf(target), tags(), canCreate, create(name) → tag | null (may be async),
  // empty?, anchor? (a CSS selector, so it survives redraws), onClose(changes) }.
  function open(opts) {
    close();
    const sets = new Map(opts.targets.map((k) => [k, new Set(opts.idsOf(k))]));
    cur = { opts, sets, before: new Map([...sets].map(([k, s]) => [k, [...s]])), rows: [], index: 0 };
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

  // Every way out ends here, once: Esc, 完成 (the form closes the dialog), a click outside, the window losing focus.
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
    cur.rows = rowsOf(opts.tags(), q, opts.canCreate);
    cur.index = Math.min(cur.index, Math.max(0, cur.rows.length - 1));
    list.innerHTML =
      cur.rows
        .map((r, i) => {
          const active = i === cur.index;
          const attrs = `role="option" class="picker-opt${active ? " active" : ""}${r.create ? " tp-new" : ""}" data-i="${i}" aria-selected="${active}"`;
          if (r.create) return `<li ${attrs}><span class="check">+</span>新建「${esc(r.create)}」</li>`;
          const n = countOf(sets, r.tag.id);
          const all = n === sets.size;
          const some = sets.size > 1 && n ? `<span class="muted">${n} 个有</span>` : "";
          const key = !q && i < 9 ? `<span class="n" aria-hidden="true">${i + 1}</span>` : "";
          return `<li ${attrs} aria-checked="${all ? "true" : n ? "mixed" : "false"}"><span class="check">${all ? "✓" : n ? "–" : ""}</span><span class="dot" style="--c:${esc(r.tag.color)}"></span>${esc(r.tag.name)}${some}${key}</li>`;
        })
        .join("") || `<li class="muted">${esc(opts.empty || "输入名称后回车新建标签")}</li>`;
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

  // Under the anchor, or above it when there is no room below.
  function place() {
    const r = (document.querySelector(cur.opts.anchor) || document.body).getBoundingClientRect();
    const w = dlg.offsetWidth;
    const h = dlg.offsetHeight;
    let y = r.bottom + 6;
    if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 6);
    dlg.style.left = `${Math.min(Math.max(8, r.left), innerWidth - w - 8)}px`;
    dlg.style.top = `${y}px`;
  }

  // Runs before the page's own key handlers see the key (they skip open dialogs and text fields anyway).
  dlg.addEventListener("keydown", (e) => {
    if (!cur || BocTyping.composing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === "Escape") close();
    else if (k === "ArrowDown" || k === "ArrowUp") {
      const n = cur.rows.length;
      if (n) cur.index = (cur.index + (k === "ArrowDown" ? 1 : n - 1)) % n;
      render();
    } else if (k === "Enter" && e.target === input) pick(cur.index);
    else if (/^[1-9]$/.test(k) && !input.value && cur.rows[k - 1]?.tag) pick(k - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  BocTyping.bindLive(input, () => cur && ((cur.index = 0), render()), 0);
  list.addEventListener("mousedown", (e) => e.target.closest("[data-i]") && e.preventDefault()); // focus stays in the filter
  list.addEventListener("click", (e) => {
    const li = e.target.closest("[data-i]");
    if (li) pick(Number(li.dataset.i));
  });
  // 完成 submits the form, which closes the dialog. After a reopen the dialog is open again: that close was handled.
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

  globalThis.TagPicker = { open, close, isOpen: () => Boolean(cur), toggle, changesOf, applyChange, rowsOf };
})();
