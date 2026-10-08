// The 分拣台's two tag dialogs (#tagManageDialog, #aiTagDialog in triage.html), one of each for 收藏夹 and 关注 as
// tag-picker.js is: 标签管理 only edits the tags, ✦ AI 打标签 only asks the AI and reviews what it proposes. A mode opens
// them with its adapter; the words, layout and behavior are here, the mode's unit, limits and data are in the adapter.
(() => {
  const UI = globalThis.TriageUi;
  const { esc, cleanTagName, sp } = UI;
  const $ = (id) => document.getElementById(id);
  const manageDlg = $("tagManageDialog");
  const aiDlg = $("aiTagDialog");
  if (!manageDlg || !aiDlg) return;

  // ----- 标签管理 (and 关注's 分组管理, the same list of named things) -----
  // a = { who: 视频 | UP 主, hint() (where the tags live, the limit), reason() ("" or why nothing can be edited here),
  // tags(), count(id), add(name) → tag | null, edit(t, field, value) → saved?, remove(t) }; all may be async.
  // 分组管理 also passes text: { title, saved (what saves at once), newName, newMax, add, addLabel } and row(t, count)
  // (its row html).
  const TAG_TEXT = { title: "标签管理", saved: "改名、颜色、说明和删除立即保存。", newName: "新标签名称", newMax: 12, add: "添加", addLabel: "添加标签" };
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
    $("tagManageHint").textContent = `${a.hint()}${{ ...TAG_TEXT, ...a.text }.saved}`;
    newInput.disabled = $("addTagBtn").disabled = Boolean(why);
    const tags = a.tags();
    rows.innerHTML = why
      ? `<p class="muted">${esc(why)}</p>`
      : tags.length
        ? tags.map((t) => (a.row ? a.row(t, a.count(t.id)) : UI.tagRowHtml(t, { count: a.count(t.id), who: a.who }))).join("")
        : `<p class="muted">还没有${a.row ? "自己建的分组" : `${esc(sp(a.who))}标签`}</p>`;
  }
  const rowTag = (target) => {
    const id = target.closest(".tag-row")?.dataset.id;
    return id && man.tags().find((t) => String(t.id) === id);
  };
  async function addTag() {
    if (await man.add(newInput.value)) {
      newInput.value = "";
      renderManage();
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
  // Enter in a name field: the new-tag box adds; a rename would submit the form and close the dialog.
  manageDlg.addEventListener("keydown", (e) => {
    if (BocTyping.composing(e) || e.key !== "Enter" || !e.target.matches?.('#newTagInput, [data-field="name"], [data-field="rule"]')) return;
    e.preventDefault();
    if (e.target === newInput) addTag();
  });

  // ----- AI 打标签 -----
  // a = { who, sees (what the AI reads), example (the instruction's placeholder), excluded (a Set of tag ids the AI may not use this time),
  // tags(), scopes() → [{ value, label, n }] (filter / selected / …), scopeText(scope), roomHint() (html: how many new
  // tags the AI may make), blocked() ("" or why it cannot run here now), history(), allowRemove(), setAllowRemove?(on)
  // → saved?, running(), proposal(), run({ instruction, scope, allowRemove }) (sets running before its first await),
  // stop(), discard(), apply(), map() (item id → tag ids), live() (has(id): still in the folder / still followed),
  // tagName(id), manage (the mode's 标签管理 adapter, for the link) }.
  // The review counts what 应用 would change now, new tags standing in by name (UI.previewId).
  const changesOf = (a, p) => UI.aiChanges(p, a.map(), a.live(), (key) => UI.previewId(p, key, a.tags()));
  let ai = null;
  const progressOf = new Map(); // adapter → its run's progress line, kept while the dialog is closed
  const scopeSel = $("aiScope");
  const instr = $("aiInstruction");

  function openAi(a) {
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
  // want: the scope to pick when it has items (else the one picked stays, if it still has any).
  function renderForm(want = scopeSel.value) {
    const a = ai;
    $("aiHint").textContent = `用一句话让 AI 给一批${sp(a.who)}打标签。AI 看${a.sees}，只给建议，你点「应用」后才生效。`;
    const scopes = a.scopes();
    scopeSel.innerHTML = scopes.map((s) => `<option value="${esc(s.value)}"${s.n ? "" : " disabled"}>${esc(s.label)} · ${s.n} 个</option>`).join("");
    scopeSel.value = scopes.find((s) => s.value === want && s.n)?.value || scopes.find((s) => s.n)?.value || scopes[0].value;
    const scope = scopes.find((s) => s.value === scopeSel.value);
    $("aiScopeCount").textContent = a.scopeText(scope.value);
    const blocked = a.blocked();
    const tags = a.tags();
    const useChip = (t) => {
      const on = !a.excluded.has(t.id);
      return `<button type="button" class="chip tag-use${on ? " on" : ""}" style="--c:${esc(t.color)}" data-use="${esc(t.id)}" aria-pressed="${on}" title="${on ? "点一下：这次不让 AI 用" : "点一下：让 AI 用"}">${esc(t.name)}</button>`;
    };
    const manageLink = `<button type="button" class="link" data-open-manage>「标签管理」</button>`;
    $("aiTagsPreview").innerHTML = blocked
      ? `<p class="dialog-hint">${esc(blocked)}</p>`
      : tags.length
        ? `<span id="aiTagsLabel" class="grid-label">可用标签</span><div class="chips" role="group" aria-labelledby="aiTagsLabel">${tags.map(useChip).join("")}</div><p class="dialog-meta">点掉的标签这次不给 AI 用。<br>${a.roomHint()}</p>`
        : `<p class="dialog-hint">还没有${esc(sp(a.who))}标签。${a.roomHint()}想打得准，先在${manageLink}里建好标签、每个写一句说明。</p>`;
    const history = a.history();
    $("aiHistory").innerHTML = history.length
      ? `<span class="muted">最近：</span>${history.map((h, i) => `<button type="button" class="chip" data-h="${i}" title="${esc(h)}" aria-label="使用指令 ${esc(h)}">${esc(h.length > 18 ? `${h.slice(0, 18)}…` : h)}</button>`).join("")}`
      : "";
    const running = a.running();
    const run = $("aiRunBtn");
    run.innerHTML = running ? "运行中…" : `${UI.AI_SPARK}运行`;
    UI.setReason(run, running ? "正在运行" : blocked || (scope.n ? "" : a.scopeText(scope.value)));
    if (running) run.setAttribute("aria-busy", "true");
    else run.removeAttribute("aria-busy");
    $("aiStopBtn").hidden = !running;
    $("aiProgress").textContent = progressOf.get(a) || "";
  }
  function renderReview(p) {
    const a = ai;
    const who = sp(a.who);
    const live = a.live();
    $("aiNotes").innerHTML = p.errors.map((e) => `<p class="fail-text">${esc(e)}</p>`).join("") + p.notes.map((n) => `<p class="muted">AI 说明：${esc(n)}</p>`).join("");
    $("aiNewTagsHead").hidden = !p.newTags.length;
    $("aiNewTags").innerHTML = p.newTags
      .map((t, i) => {
        const n = p.rows.filter((r) => live.has(r.id) && r.add.includes(`new:${t.key}`)).length;
        return `<div class="ai-newtag" data-i="${i}">
      <input type="checkbox" data-nt="checked"${t.checked ? " checked" : ""} aria-label="创建标签 ${esc(t.name)}" />
      <input type="text" data-nt="name" value="${esc(t.name)}" maxlength="12" aria-label="新标签名称" />
      <span class="muted">${n ? `用在 ${n} 个${esc(who)}` : `没有${esc(who)}用到`}</span>
    </div>`;
      })
      .join("");
    $("aiReviewHint").textContent = `应用后列表只显示「✦ AI 刚打的」这些${who}，在卡片上逐个看，不对的按 T 改。`;
    $("aiRecentMeta").innerHTML = `「AI 刚打的」只显示最近一次 AI 打标签改动的${esc(who)}：<ul class="ai-recent-rules">${UI.AI_RECENT_RULES.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>${esc(UI.aiRecentUndo(a.who))}`;
    renderTally(p);
  }
  function renderTally(p) {
    const a = ai;
    const who = sp(a.who);
    const changes = changesOf(a, p);
    const newN = p.newTags.filter((t) => t.checked && cleanTagName(t.name)).length;
    $("aiReviewSummary").textContent = `· ${changes.length} 个${who}有改动 · 新标签 ${newN} 个 · 点「应用」前不会改动任何东西`;
    const tally = UI.aiTally(p, changes, a.tagName);
    $("aiRows").innerHTML = tally.length
      ? `<div class="chips">${tally.map((t) => `<span class="chip ${t.cls}">${esc(t.text)} <b>${t.n}</b></span>`).join("")}</div>`
      : `<p class="empty">AI 没有提出改动</p>`;
    const apply = $("aiApplyBtn");
    apply.textContent = changes.length ? `应用到 ${changes.length} 个${who}` : "应用";
    apply.setAttribute("aria-label", apply.textContent);
    apply.disabled = !changes.length && !newN;
  }

  function runAi() {
    const instruction = instr.value.trim();
    const say = (text) => ($("aiProgress").textContent = text);
    if (ai.running()) return;
    if (ai.blocked()) return say(ai.blocked());
    if (!instruction) {
      say("请先写指令");
      return instr.focus();
    }
    if (!ai.scopes().find((s) => s.value === scopeSel.value)?.n) return say(ai.scopeText(scopeSel.value));
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
      $("aiProgress").textContent = "将在当前批次完成后停止…";
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
    const tag = e.target.dataset.nt === "name" && ai.proposal()?.newTags[Number(e.target.closest(".ai-newtag")?.dataset.i)];
    if (!tag) return;
    tag.name = e.target.value;
    renderTally(ai.proposal());
  });
  // Enter in a new tag's name would submit the form and close the dialog.
  aiDlg.addEventListener("keydown", (e) => {
    if (!BocTyping.composing(e) && e.key === "Enter" && e.target.matches?.('[data-nt="name"]')) e.preventDefault();
  });

  globalThis.TagDialogs = {
    manage: { open: openManage, isOpen: (a) => manageDlg.open && man === a },
    ai: {
      open: openAi,
      isOpen,
      // Redraw for a mode whose run moved on; nothing when the dialog is closed or shows the other mode.
      render: (a) => isOpen(a) && renderAi(),
      progress(a, text) {
        progressOf.set(a, text);
        if (isOpen(a) && !$("aiForm").hidden) $("aiProgress").textContent = text;
      }
    }
  };
})();
