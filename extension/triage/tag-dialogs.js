// The 分拣台's two tag dialogs (#tagManageDialog, #aiTagDialog in triage.html), one of each for 收藏夹 and 关注 as
// tag-picker.js is: 标签管理 only edits the tags, ✦ AI 打标签 only asks the AI and reviews what it proposes. A mode opens
// them with its adapter; the words, layout and behavior are here, the mode's unit, limits and data are in the adapter.
(() => {
  const UI = globalThis.TriageUi;
  const { esc, cleanTagName, sp, tagsWord } = UI;
  const $ = (id) => document.getElementById(id);
  const manageDlg = $("tagManageDialog");
  const aiDlg = $("aiTagDialog");
  if (!manageDlg || !aiDlg) return;

  // ----- 标签管理 (and 关注's 分组管理, the same list of named things) -----
  // a = { who: 视频 | UP 主, hint() (where the tags live, the limit), reason() ("" or why nothing can be edited here),
  // tags(), count(id), addReason(name) ("" or why this name cannot be added: empty, taken, the list full), add(name) →
  // tag | null, edit(t, field, value) → saved?, remove(t) }; all may be async but addReason.
  // 分组管理 also passes text: { title, saved (what saves at once), newName, newMax, add, addLabel } and row(t, count)
  // (its row html).
  const TAG_TEXT = { title: "标签管理", saved: "改名、颜色、说明和删除立即保存。", newName: MdgErrors.LABEL.newTagName, newMax: MdgTagCore.TAG_NAME_MAX, add: "添加", addLabel: "添加标签" };
  let man = null;
  const rows = $("tagsRows");
  const newInput = $("newTagInput");

  function openManage(a) {
    man = a;
    const text = { ...TAG_TEXT, ...a.text };
    $("tagManageTitle").textContent = text.title;
    newInput.value = "";
    newInput.placeholder = text.newName;
    newInput.maxLength = text.newMax;
    newInput.setAttribute("aria-label", text.newName);
    $("addTagBtn").textContent = text.add;
    $("addTagBtn").setAttribute("aria-label", text.addLabel);
    renderManage();
    manageDlg.showModal();
    if (!newInput.disabled) newInput.focus();
  }
  function renderManage() {
    const a = man;
    const why = a.reason?.() || "";
    // Nothing can be edited (why): 「…立即保存」 would say the opposite.
    $("tagManageHint").textContent = `${a.hint()}${why ? "" : { ...TAG_TEXT, ...a.text }.saved}`;
    UI.setReason(newInput, why);
    syncAdd();
    const tags = a.tags();
    rows.innerHTML = why
      ? `<p class="muted">${esc(why)}</p>`
      : tags.length
        ? tags.map((t) => (a.row ? a.row(t, a.count(t.id)) : UI.tagRowHtml(t, { count: a.count(t.id), who: a.who }))).join("")
        : `<p class="muted">还没有${a.row ? "自己建的分组" : esc(tagsWord(a.who))}</p>`;
  }
  const rowTag = (target) => {
    const id = target.closest(".tag-row")?.dataset.id;
    return id && man.tags().find((t) => String(t.id) === id);
  };
  // 添加 is off with why while the name cannot be added, updated as you type; Enter follows it, the typed text stays.
  const addWhy = () => man.reason?.() || man.addReason(newInput.value);
  const syncAdd = () => UI.setReason($("addTagBtn"), addWhy());
  // A second 添加 (a double click, Enter twice) before the first one's answer would create the name twice.
  let adding = false;
  async function addTag() {
    if (adding || addWhy()) return;
    adding = true;
    try {
      if (await man.add(newInput.value)) {
        newInput.value = "";
        renderManage();
      }
    } finally {
      adding = false;
    }
  }
  rows.addEventListener("change", async (e) => {
    const t = rowTag(e.target);
    const field = e.target.dataset.field;
    // A refused name goes back to the saved one; other edits keep the row (and the focus moving through it).
    if (t && field && !(await man.edit(t, field, e.target.value))) renderManage();
  });
  rows.addEventListener("click", async (e) => {
    const t = rowTag(e.target);
    if (!t) return;
    if (e.target.closest("[data-tag-del]")) await man.remove(t);
    else if (e.target.closest("[data-tag-color]")) await man.edit(t, "color");
    else return;
    renderManage();
  });
  $("addTagBtn").addEventListener("click", addTag);
  newInput.addEventListener("input", () => man && syncAdd());
  // Enter in a name field: the new-tag box adds; a rename would submit the form and close the dialog.
  manageDlg.addEventListener("keydown", (e) => {
    if (MdgTyping.composing(e) || e.key !== "Enter" || !e.target.matches?.('#newTagInput, [data-field="name"], [data-field="rule"]')) return;
    e.preventDefault();
    if (e.target === newInput) addTag();
  });

  // ----- AI 打标签 -----
  // a = { who, sees (what the AI reads), example (the instruction's placeholder), excluded (a Set of tag ids the AI may not use this time),
  // tags(), scopes() → [{ value, label, n, shown? }] (filter / selected / …; shown: how many of n are listed, given for
  // 选中, whose n counts the hidden ones too), scopeText(scope), room() (how many new tags the AI
  // may make), roomHint() (html: the same in words), blocked() ("" or why it cannot run here now), history(), allowRemove(), setAllowRemove?(on)
  // → saved?, running(), proposal(), run({ instruction, scope, allowRemove }) (sets running before its first await),
  // stop(), stopping() (stop was pressed and the batch in flight still runs), discard(), apply(), map() (item id → tag ids), live() (has(id): still in the folder / still followed),
  // tagName(id), manage (the mode's 标签管理 adapter, for the link), where?() (the open folder; "" when the mode has none) }.
  // The review counts what 应用 would change now, new tags standing in by name (UI.previewId).
  const changesOf = (a, p) => UI.aiChanges(p, a.map(), a.live(), (key) => UI.previewId(p, key, a.tags()));
  let ai = null;
  // adapter → { where, text }: its run's progress line and the folder the run is in, kept while the dialog is closed and
  // shown only there.
  const progressOf = new Map();
  const whereOf = (a) => a.where?.() ?? "";
  const progressText = (a) => (progressOf.get(a)?.where === whereOf(a) ? progressOf.get(a).text : "");
  const scopeSel = $("aiScope");
  const instr = $("aiInstruction");
  let instrKey = null; // [adapter, where] the instruction was written for; another mode or folder starts empty

  // No tags yet: an instruction for the AI to make the first 3–5, within the room it has; none when it may make none.
  const firstInstruction = (a) => {
    const hi = Math.min(5, a.room());
    const lo = Math.min(3, hi);
    return a.tags().length || !hi ? "" : `看看这些${sp(a.who)}的内容，新建 ${lo === hi ? hi : `${lo}–${hi}`} 个标签分好类，每个${sp(a.who)}打一个最贴切的。`;
  };
  let autoInstr = ""; // the last one put in the box; while untouched it follows the room
  function openAi(a) {
    if (instrKey?.[0] !== a || instrKey[1] !== whereOf(a) || instr.value === autoInstr) instr.value = "";
    if (!instr.value.trim()) instr.value = autoInstr = firstInstruction(a);
    instrKey = [a, whereOf(a)];
    ai = a;
    a.excluded.clear();
    // 选中 when something is selected, else 当前筛选.
    renderAi("selected");
    $("aiRemoveInput").checked = a.allowRemove();
    instr.placeholder = `例如：${a.example}`;
    aiDlg.showModal();
  }
  const isOpen = (a) => aiDlg.open && ai === a;
  function renderAi(want) {
    const p = !ai.running() && ai.proposal();
    $("aiForm").hidden = Boolean(p);
    $("aiReview").hidden = !p;
    if (p) renderReview(p);
    else renderForm(want);
  }
  // Every tag left out and no room to make one: the AI could only answer nothing.
  const noTagsToUse = (a) => (a.room() || a.tags().some((t) => !a.excluded.has(t.id)) ? "" : "没有可用的标签，也不能新建");
  // A selection filters hide whole: 选中 stays picked with its true count, and says why it cannot run.
  const hiddenAll = (s) => (s.n && s.shown === 0 ? UI.HIDDEN_ALL : "");
  // want: the scope to pick when it has items (else the one picked stays, if it still has any).
  function renderForm(want = scopeSel.value) {
    const a = ai;
    $("aiHint").textContent = `用一句话让 AI 给一批${sp(a.who)}打标签。AI 看${a.sees}，只给建议，你点「应用」后才生效。`;
    const scopes = a.scopes();
    // 选中 counts like the row-4 button: the listed selected ones, or all of them when filters hide every one.
    scopeSel.innerHTML = scopes.map((s) => `<option value="${esc(s.value)}"${s.n ? "" : " disabled"}>${esc(s.label)} · ${s.shown || s.n} 个</option>`).join("");
    scopeSel.value = scopes.find((s) => s.value === want && s.n)?.value || scopes.find((s) => s.n)?.value || scopes[0].value;
    const scope = scopes.find((s) => s.value === scopeSel.value);
    $("aiScopeCount").textContent = hiddenAll(scope) || a.scopeText(scope.value);
    const blocked = a.blocked();
    const tags = a.tags();
    const useChip = (t) => {
      const on = !a.excluded.has(t.id);
      return `<button type="button" class="chip tag-use${on ? " on" : ""}" style="--c:${esc(t.color)}" data-use="${esc(t.id)}" aria-pressed="${on}" title="${on ? "点一下：这次不给 AI 用" : "点一下：给 AI 用"}">${esc(t.name)}</button>`;
    };
    // The link only where 标签管理 can edit (not in 所有收藏夹, whose tags belong to each folder).
    const manageable = !a.manage?.reason?.();
    const manageLink = `<button type="button" class="link" data-open-manage>「${TAG_TEXT.title}」</button>`;
    $("aiTagsPreview").innerHTML = blocked
      ? `<p class="dialog-hint">${esc(blocked)}</p>`
      : tags.length
        ? `<span id="aiTagsLabel" class="grid-label">可用标签</span><div class="chips" role="group" aria-labelledby="aiTagsLabel">${tags.map(useChip).join("")}</div><p class="dialog-meta">点掉的标签这次不给 AI 用。<br>${a.roomHint()}</p>`
        : `<p class="dialog-hint">还没有${esc(tagsWord(a.who))}。${a.roomHint()}${manageable ? `想打得准，先在${manageLink}里建好标签、每个写一句说明。` : ""}</p>`;
    const history = a.history();
    $("aiHistory").innerHTML = history.length
      ? `<span class="muted">最近：</span>${history.map((h, i) => `<button type="button" class="chip" data-h="${i}" title="${esc(h)}" aria-label="使用指令 ${esc(h)}">${esc(h.length > 18 ? `${h.slice(0, 18)}…` : h)}</button>`).join("")}`
      : "";
    const running = a.running();
    const run = $("aiRunBtn");
    run.innerHTML = running ? "运行中…" : `${UI.AI_SPARK}运行`;
    UI.setReason(run, running ? "正在运行" : blocked || hiddenAll(scope) || (scope.n ? "" : a.scopeText(scope.value)) || noTagsToUse(a) || (instr.value.trim() ? "" : "先写指令"));
    if (running) run.setAttribute("aria-busy", "true");
    else run.removeAttribute("aria-busy");
    // Stopped: the batch in flight finishes first, as the pill's 停止 on a B站 write says.
    const stop = $("aiStopBtn");
    const stopping = running && a.stopping();
    stop.hidden = !running;
    stop.textContent = stopping ? "停止中" : "停止";
    stop.setAttribute("aria-label", stop.textContent);
    UI.setReason(stop, stopping ? UI.WRITE_STOPPING : "");
    $("aiProgress").textContent = progressText(a);
  }
  function renderReview(p) {
    const a = ai;
    const who = sp(a.who);
    const live = a.live();
    $("aiNotes").innerHTML = p.errors.map((e) => `<p class="fail-text">${esc(e)}</p>`).join("") + p.notes.map((n) => `<p class="muted">AI 说明：${esc(n)}</p>`).join("");
    $("aiNewTagsHead").hidden = !p.newTags.length;
    $("aiNewTags").innerHTML = p.newTags
      .map((t, i) => {
        const n = p.rows.filter((r) => live.has(r.id) && r.add.includes(UI.aiRef.new(t.key))).length;
        return `<div class="ai-newtag" data-i="${i}">
      <input type="checkbox" name="aiNewTagEnabled" data-nt="checked"${t.checked ? " checked" : ""} aria-label="创建标签 ${esc(t.name)}${t.where ? `（在「${esc(t.where)}」）` : ""}" />
      <input type="text" name="aiNewTagName" data-nt="name" value="${esc(t.name)}" maxlength="${MdgTagCore.TAG_NAME_MAX}" aria-label="${TAG_TEXT.newName}" />
      <span class="muted">${t.where ? `建在「${esc(t.where)}」 · ` : ""}${n ? `用在 ${n} 个${esc(who)}` : `没有${esc(who)}用到`}</span>
    </div>`;
      })
      .join("");
    $("aiReviewHint").textContent = `应用后列表只显示「✦ ${UI.AI_RECENT}」这些${who}，${UI.AI_RECENT_CHECK}。`;
    $("aiRecentMeta").innerHTML = `「${UI.AI_RECENT}」只显示最近一次 AI 打标签改动的${esc(who)}：<ul class="ai-recent-rules">${UI.AI_RECENT_RULES.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>${esc(UI.aiRecentUndo(a.who))}`;
    renderTally(p);
  }
  function renderTally(p) {
    const a = ai;
    const who = sp(a.who);
    const changes = changesOf(a, p);
    // A new tag whose name an existing one has is that tag (previewId), not a new one.
    const newN = p.newTags.filter((t) => t.checked && UI.aiRef.keyOf(String(UI.previewId(p, t.key, a.tags()) || ""))).length;
    $("aiReviewSummary").textContent = `· ${changes.length} 个${who}有改动 · 新标签 ${newN} 个 · 点「应用」前不会改动任何东西`;
    const tally = UI.aiTally(p, changes, a.tagName);
    // Nothing to apply: the AI proposed nothing, or what it proposed was unticked or left the list since.
    const none = p.rows.length || p.newTags.length ? "没有可应用的改动" : "AI 没有提出改动";
    $("aiRows").innerHTML = tally.length
      ? `<div class="chips">${tally.map((t) => `<span class="chip ${t.cls}">${esc(t.text)} <b>${t.n}</b></span>`).join("")}</div>`
      : `<p class="empty">${newN ? `没有${esc(who)}的标签改动，应用只创建新标签` : none}</p>`;
    const apply = $("aiApplyBtn");
    apply.textContent = changes.length ? `应用到 ${changes.length} 个${who}` : "应用";
    apply.setAttribute("aria-label", apply.textContent);
    UI.setReason(apply, changes.length || newN ? "" : none);
  }

  function runAi() {
    const instruction = instr.value.trim();
    const scope = ai.scopes().find((s) => s.value === scopeSel.value) || {};
    // 运行 is off with its reason then (renderForm); a stale click does nothing.
    if (ai.running() || ai.blocked() || !instruction || hiddenAll(scope) || !scope.n || noTagsToUse(ai)) return;
    ai.run({ instruction, scope: scopeSel.value, allowRemove: $("aiRemoveInput").checked });
    renderAi();
  }

  aiDlg.addEventListener("click", async (e) => {
    const t = e.target;
    const use = t.closest("[data-use]")?.dataset.use;
    if (use) {
      if (!ai.excluded.delete(use)) ai.excluded.add(use);
      renderForm();
      return aiDlg.querySelector(`[data-use="${CSS.escape(use)}"]`)?.focus();
    }
    const h = t.closest("[data-h]");
    if (h) {
      instr.value = ai.history()[Number(h.dataset.h)] || "";
      renderForm();
      return instr.focus();
    }
    if (t.closest("[data-open-manage]")) {
      aiDlg.close();
      return openManage(ai.manage);
    }
    const id = t.closest("button")?.id;
    if (id === "aiRunBtn") runAi();
    else if (id === "aiStopBtn") {
      ai.stop();
      renderForm();
    } else if (id === "aiCloseBtn") aiDlg.close();
    else if (id === "aiDiscardBtn") {
      ai.discard();
      renderAi();
    } else if (id === "aiApplyBtn") {
      const a = ai;
      aiDlg.close();
      await a.apply();
    }
  });
  aiDlg.addEventListener("change", async (e) => {
    const t = e.target;
    if (t === scopeSel) return renderForm();
    if (t.id === "aiRemoveInput") {
      const on = t.checked;
      if (ai.setAllowRemove && !(await ai.setAllowRemove(on))) t.checked = !on;
      return;
    }
    const tag = t.dataset.nt === "checked" && ai.proposal()?.newTags[Number(t.closest(".ai-newtag")?.dataset.i)];
    if (tag) {
      tag.checked = t.checked;
      renderTally(ai.proposal());
    }
  });
  aiDlg.addEventListener("input", (e) => {
    if (e.target === instr) return renderForm();
    const tag = e.target.dataset.nt === "name" && ai.proposal()?.newTags[Number(e.target.closest(".ai-newtag")?.dataset.i)];
    if (!tag) return;
    tag.name = e.target.value;
    renderTally(ai.proposal());
  });
  // Enter in a new tag's name would submit the form and close the dialog.
  aiDlg.addEventListener("keydown", (e) => {
    if (!MdgTyping.composing(e) && e.key === "Enter" && e.target.matches?.('[data-nt="name"]')) e.preventDefault();
  });

  globalThis.TagDialogs = {
    manage: { open: openManage, isOpen: (a) => manageDlg.open && man === a },
    ai: {
      open: openAi,
      isOpen,
      // Redraw for a mode whose run moved on; nothing when the dialog is closed or shows the other mode.
      render: (a) => isOpen(a) && renderAi(),
      // where: the folder the run is in (a.where() when it started).
      progress(a, text, where = "") {
        progressOf.set(a, { where, text });
        if (isOpen(a) && !$("aiForm").hidden) $("aiProgress").textContent = progressText(a);
      }
    }
  };
})();
