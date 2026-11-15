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
  // The page has the empty dialog; its markup is here, so the 分拣台 and 摘读记录 share one copy. Two pages in one form: the
  // setup (#aiForm, #aiFormActs) and the review (#aiReviewHead, #aiReview, #aiReviewActs). Only .dlg-body scrolls
  // (tags.css); the columns are the 判断标准 dialog's (.crit-cols, triage.css).
  aiDlg.innerHTML = `<form method="dialog">
        <h2 id="aiTagTitle">${MdgErrors.LABEL.aiTag}</h2>
        <div id="aiReviewHead" hidden>
          <p id="aiReviewSummary" class="ai-verdict"></p>
          <p id="aiReviewHint" class="dialog-hint"></p>
        </div>
        <div class="dlg-body">
          <section id="aiForm" class="crit-cols">
            <div class="crit-left">
              <label class="crit-head" for="aiInstruction">指令</label>
              <textarea id="aiInstruction" rows="5"></textarea>
              <p id="aiHint" class="dialog-meta"></p>
              <div id="aiHistory" class="ai-past"></div>
            </div>
            <div class="crit-right">
              <div class="ai-opt">
                <label class="crit-head" for="aiScope">作用范围</label>
                <select id="aiScope"></select>
                <p id="aiScopeCount" class="dialog-meta"></p>
              </div>
              <div id="aiTagsPreview" class="ai-opt"></div>
              <div class="crit-switch">
                <div><label class="name" for="aiRemoveInput">允许 AI 去掉已有标签</label><p class="dialog-meta">关时只加标签。</p></div>
                <input id="aiRemoveInput" type="checkbox" class="switch" />
              </div>
            </div>
          </section>
          <section id="aiReview" class="crit-cols" hidden>
            <div class="crit-left">
              <span id="aiNewTagsHead" class="crit-head">新标签</span>
              <div id="aiNewTags" class="tag-rows"></div>
              <span class="crit-head">改动汇总</span>
              <div id="aiRows" class="ai-tally"></div>
            </div>
            <div class="crit-right ai-basis">
              <span class="crit-head">依据</span>
              <dl id="aiNotes"></dl>
            </div>
          </section>
        </div>
        <div id="aiFormActs" class="dialog-actions">
          <span id="aiProgress" class="dialog-meta" aria-live="polite"></span>
          <p id="aiFail" class="ai-fail" role="alert" hidden></p>
          <span class="spacer"></span>
          <button id="aiCloseBtn" type="button" aria-label="关闭">关闭</button>
          <button id="aiStopBtn" type="button" class="danger" aria-label="${MdgErrors.LABEL.stop}" hidden>${MdgErrors.LABEL.stop}</button>
          <button id="aiRunBtn" type="button" class="primary" aria-label="运行 AI 打标签">${UI.AI_SPARK}运行</button>
        </div>
        <div id="aiReviewActs" class="dialog-actions" hidden>
          <p id="aiErrors" class="ai-fail" role="alert" hidden></p>
          <span class="spacer"></span>
          <button id="aiDiscardBtn" type="button" aria-label="放弃这些建议">放弃</button>
          <button id="aiApplyBtn" type="button" class="primary">应用</button>
        </div>
      </form>`;

  // ----- 标签管理 (and 关注's 分组管理, the same list of named things) -----
  // a = { who: 视频 | UP 主, hint() (where the tags live, the limit: the one sentence under the title), reason() ("" or
  // why nothing can be edited here), tags(), count(id), addReason(name) ("" or why this name cannot be added: empty,
  // taken, the list full), add(name) → tag | null, edit(t, field, value) → saved?, remove(t) }; all may be async but
  // addReason.
  // 标签管理 (.tm) is two panes: the tags on the left with 新建 under them, the picked tag's name, color, 说明 and 删除
  // on the right. 分组管理 also passes text: { title, saved (what saves at once), newName, newMax, add, addLabel } and
  // row(t, count) (its row html), and stays one list of rows.
  const TAG_TEXT = { title: UI.tagManage, newName: MdgErrors.LABEL.newTagName, newMax: MdgTagCore.TAG_NAME_MAX, add: "新建", addLabel: MdgErrors.LABEL.newTag };
  let man = null;
  const rows = $("tagsRows");
  const detail = $("tmDetail");
  const newInput = $("newTagInput");
  // 标签管理's picked tag, and its place in the list: deleted, the tag now there takes over.
  let sel = "";
  let selAt = 0;

  function openManage(a) {
    man = a;
    const text = { ...TAG_TEXT, ...a.text };
    $("tagManageTitle").textContent = text.title;
    manageDlg.classList.toggle("tm", !a.row);
    sel = "";
    selAt = 0;
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
    // Nothing can be edited (why): 「…立即保存」 would say the opposite. 标签管理 says it beside 完成, 分组管理 here.
    $("tagManageHint").textContent = `${a.hint()}${why || !a.row ? "" : a.text.saved}`;
    UI.setReason(newInput, why);
    syncAdd();
    const tags = a.tags();
    $("tmMeta").textContent = a.row || why ? "" : `${tags.length} 个标签 · 改动立即保存`;
    if (!a.row) return drawList(), drawDetail(why);
    detail.innerHTML = "";
    rows.innerHTML = why ? `<p class="muted">${esc(why)}</p>` : tags.length ? tags.map((t) => a.row(t, a.count(t.id))).join("") : `<p class="muted">还没有自己建的分组</p>`;
  }
  // The tags 标签管理 lists: none where nothing can be edited (the pane says why).
  const listed = () => (man.reason?.() ? [] : man.tags());
  const curTag = () => listed().find((t) => String(t.id) === sel);
  function drawList() {
    const tags = listed();
    const cur = curTag() || tags[Math.min(selAt, tags.length - 1)];
    sel = cur ? String(cur.id) : "";
    selAt = Math.max(0, tags.indexOf(cur));
    const who = esc(sp(man.who));
    rows.innerHTML = tags
      .map((t) => {
        const n = man.count(t.id);
        return `<button type="button" class="tm-item" data-id="${esc(t.id)}" aria-current="${t === cur}"><span class="dot" style="--c:${esc(t.color)}"></span><span class="name">${esc(t.name)}</span><span class="n" title="${n} 个${who}">${n}</span></button>`;
      })
      .join("");
  }
  function drawDetail(why) {
    const t = curTag();
    if (!t) return void (detail.innerHTML = `<p class="tm-empty">${esc(why || `还没有${tagsWord(man.who)}`)}</p>`);
    const who = esc(sp(man.who));
    const others = listed().filter((x) => x !== t);
    const dots = MdgTagCore.swatchColors(t.color, others)
      .map((c, i) => {
        const taken = others.filter((x) => x.color === c).map((x) => x.name);
        const note = taken.length ? `「${esc(taken.join("」「"))}」在用` : "";
        return `<button type="button" class="tag-color${note ? " used" : ""}" style="--c:${esc(c)}" data-color="${esc(c)}" aria-pressed="${c === t.color}" aria-label="颜色 ${i + 1}${note && `，${note}`}"${note && ` title="${note}"`}></button>`;
      })
      .join("");
    const rule = t.rule || "";
    detail.innerHTML = `<div class="tm-top">
        <div><label for="tmName">名称</label><input id="tmName" type="text" name="tagName" value="${esc(t.name)}" data-field="name" maxlength="${MdgTagCore.TAG_NAME_MAX}" autocomplete="off" /></div>
        <div><span id="tmColorLbl" class="lbl">颜色</span><div class="tm-swatches" role="group" aria-labelledby="tmColorLbl">${dots}</div></div>
      </div>
      <label class="crit-head" for="tmRule">什么样的${who}打这个标签</label>
      <textarea id="tmRule" name="tagRule" rows="5" data-field="rule" maxlength="${UI.TAG_RULE_MAX}">${esc(rule)}</textarea>
      <div class="tm-under"><span>写给 AI 看。不写时，AI 只看到标签名。</span><span id="tmCnt">${rule.length} / ${UI.TAG_RULE_MAX}</span></div>
      <div class="tm-foot"><span class="dialog-meta">用在 ${man.count(t.id)} 个${who}</span><span class="spacer"></span><button type="button" class="quiet tm-del" data-tag-del>删除标签</button></div>`;
  }
  const rowTag = (target) => {
    const id = target.closest(".tag-row")?.dataset.id;
    return id && man.tags().find((t) => String(t.id) === id);
  };
  // 新建 is off with why while the name cannot be added, updated as you type; Enter follows it, the typed text stays.
  // 标签管理 also writes the why under the box once something is typed.
  const addWhy = () => man.reason?.() || man.addReason(newInput.value);
  function syncAdd() {
    const why = addWhy();
    UI.setReason($("addTagBtn"), why);
    $("tmWhy").textContent = !man.row && newInput.value.trim() ? why : "";
  }
  // A second 新建 (a double click, Enter twice) before the first one's answer would create the name twice.
  let adding = false;
  async function addTag() {
    if (adding || addWhy()) return;
    adding = true;
    try {
      const tag = await man.add(newInput.value);
      if (tag) {
        newInput.value = "";
        // 标签管理 picks the new tag, the caret in its 说明.
        if (!man.row) sel = String(tag.id);
        renderManage();
        if (!man.row) $("tmRule")?.focus();
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
    const pick = e.target.closest(".tm-item")?.dataset.id;
    if (pick) return (sel = pick), renderManage();
    const t = rowTag(e.target);
    if (!t || !e.target.closest("[data-tag-del]")) return;
    await man.remove(t);
    renderManage();
  });
  detail.addEventListener("change", async (e) => {
    const t = curTag();
    const field = e.target.dataset.field;
    if (!t || !field) return;
    // A saved edit redraws only the list (the new name), so the focus stays where it moved; a refused name goes back.
    if (await man.edit(t, field, e.target.value)) drawList();
    else renderManage();
  });
  detail.addEventListener("input", (e) => {
    if (e.target.id === "tmRule") $("tmCnt").textContent = `${e.target.value.length} / ${UI.TAG_RULE_MAX}`;
  });
  detail.addEventListener("click", async (e) => {
    const t = curTag();
    if (!t) return;
    const color = e.target.closest("[data-color]")?.dataset.color;
    if (e.target.closest("[data-tag-del]")) await man.remove(t);
    else if (color) await man.edit(t, "color", color);
    else return;
    renderManage();
    if (color) detail.querySelector(`[data-color="${color}"]`)?.focus();
  });
  $("addTagBtn").addEventListener("click", addTag);
  newInput.addEventListener("input", () => man && syncAdd());
  // Enter in a name field: the new-tag box adds; a rename would submit the form and close the dialog.
  manageDlg.addEventListener("keydown", (e) => {
    if (MdgTyping.composing(e) || e.key !== "Enter" || !e.target.matches?.('#newTagInput, [data-field="name"]')) return;
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
  // tagName(id), manage (the mode's 标签管理 adapter, for the link), where?() (the open folder; "" when the mode has none),
  // allTags?() (every tag when tags() shows one per name; tags() otherwise), check? (how to put a wrong one right, for a page
  // without T: 摘读记录), notMade?(p) (a hard limit on the tag count, 摘读记录's: { keys, why }, the ticked new tags 应用
  // cannot create and why) }.
  // The review counts what 应用 would change now, new tags standing in by name (UI.previewId); one 应用 cannot create
  // counts as unticked, as 应用 skips it.
  const allTags = (a) => (a.allTags || a.tags)();
  const notMade = (a, p) => a.notMade?.(p) || { keys: new Set(), why: "" };
  const changesOf = (a, p, skip = notMade(a, p).keys) => UI.aiChanges(p, a.map(), a.live(), (key) => !skip.has(key) && UI.previewId(p, key, allTags(a)));
  let ai = null;
  // adapter → { where, text, remedy }: its run's progress line and the folder the run is in, kept while the dialog is
  // closed and shown only there. remedy ({ label, run }) is the button the adapter's page gives the error that stopped
  // the run (去设置, 授权), or null.
  const progressOf = new Map();
  const whereOf = (a) => a.where?.() ?? "";
  const progressText = (a) => (progressOf.get(a)?.where === whereOf(a) ? progressOf.get(a).text : "");
  // The line left when no run is on is why the last one gave no proposal: red, at the left of the buttons. While one
  // runs it is its progress, in grey there.
  function drawProgress(a) {
    const text = progressText(a);
    const failed = Boolean(text) && !a.running();
    $("aiProgress").textContent = failed ? "" : text;
    $("aiFail").textContent = failed ? text : "";
    $("aiFail").hidden = !failed;
    const remedy = failed && progressOf.get(a).remedy;
    if (remedy) {
      $("aiFail").insertAdjacentHTML("beforeend", `<button type="button" class="sm">${esc(remedy.label)}</button>`);
      $("aiFail").querySelector("button").addEventListener("click", () => remedy.run());
    }
  }
  // adapter → { where, instruction }: what the last run here was asked, for the review's 依据.
  const ranOf = new Map();
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
    for (const id of ["aiForm", "aiFormActs"]) $(id).hidden = Boolean(p);
    for (const id of ["aiReviewHead", "aiReview", "aiReviewActs"]) $(id).hidden = !p;
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
    $("aiHint").textContent = `AI 看${a.sees}，只给建议，你点「应用」后才生效。`;
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
    const tagsHead = `<span id="aiTagsLabel" class="crit-head">可用标签</span>`;
    $("aiTagsPreview").innerHTML = blocked
      ? `<p class="dialog-hint">${esc(blocked)}</p>`
      : tags.length
        ? `${tagsHead}<div class="chips" role="group" aria-labelledby="aiTagsLabel">${tags.map(useChip).join("")}</div><p class="dialog-meta">点掉的标签这次不给 AI 用。${a.roomHint()}</p>`
        : `${tagsHead}<p class="dialog-meta">还没有${esc(tagsWord(a.who))}。${a.roomHint()}${manageable ? `想打得准，先在${manageLink}里建好标签、每个写一句说明。` : ""}</p>`;
    const history = a.history();
    $("aiHistory").innerHTML = history.length
      ? `<span class="crit-head">最近</span>${history.map((h, i) => `<button type="button" data-h="${i}" title="${esc(h)}" aria-label="使用指令 ${esc(h)}">${esc(h)}</button>`).join("")}`
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
    stop.textContent = stopping ? MdgErrors.LABEL.stopping : MdgErrors.LABEL.stop;
    stop.setAttribute("aria-label", stop.textContent);
    UI.setReason(stop, stopping ? UI.WRITE_STOPPING : "");
    drawProgress(a);
  }
  // AI may propose more new tags than the run's cap; they are all kept, and this says by how much. Not under a hard
  // limit (notMade), which says instead which ones 应用 will not create.
  function overCapLines(p) {
    return Object.entries(p.caps || {}).flatMap(([folder, cap]) => {
      const mine = p.newTags.filter((t) => (t.folder ?? "") === folder);
      if (mine.length <= cap) return [];
      const where = mine[0].where ? `在「${mine[0].where}」` : "";
      return [`AI ${where}建议新建 ${mine.length} 个标签，超过上限 ${cap} 个。不要的取消勾选，应用后也能在标签管理里删。`];
    });
  }
  function renderReview(p) {
    const a = ai;
    const who = sp(a.who);
    const live = a.live();
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
    // The chip's tooltip has the full rules (UI.aiRecentChip).
    $("aiReviewHint").textContent = `应用后列表只显示「✦ ${UI.AI_RECENT}」这些${who}，${a.check || UI.AI_RECENT_CHECK}，按 U 整批撤销。`;
    // Failed batches (and a stop): red, at the left of the buttons.
    $("aiErrors").textContent = p.errors.join("；");
    $("aiErrors").hidden = !p.errors.length;
    renderTally(p);
  }
  function renderTally(p) {
    const a = ai;
    const who = sp(a.who);
    const skip = notMade(a, p);
    const changes = changesOf(a, p, skip.keys);
    // Redrawn with each tick: which new tags 应用 cannot create follows them.
    const unmade = p.newTags.filter((t) => skip.keys.has(t.key)).map((t) => cleanTagName(t.name));
    const warns = unmade.length ? [`「${unmade.join("」「")}」不会新建：${skip.why}，用到它们的${who}也不会打上。取消勾选别的新标签可以腾出位置。`] : overCapLines(p);
    const ran = ranOf.get(a)?.where === whereOf(a) ? ranOf.get(a).instruction : "";
    const basis = [
      ...(ran ? [["指令", ran]] : []),
      ...[...new Set(p.notes)].map((n) => ["AI 说明", n]),
      ...warns.map((l) => ["新标签", l, " warn"]),
      ...(p.excludedHits?.length ? [["没有采用", `AI 想用的「${p.excludedHits.join("」「")}」是你点掉的标签，没有采用。`, " warn"]] : [])
    ];
    $("aiNotes").innerHTML = (basis.length ? basis : [["AI 说明", "没有"]]).map(([k, v, cls = ""]) => `<div><dt>${k}</dt><dd class="dialog-hint${cls}">${esc(v)}</dd></div>`).join("");
    // A new tag whose name an existing one has is that tag (previewId), not a new one.
    const newN = p.newTags.filter((t) => t.checked && !skip.keys.has(t.key) && UI.aiRef.keyOf(String(UI.previewId(p, t.key, allTags(a)) || ""))).length;
    // Nothing to apply: the AI proposed nothing, or what it proposed was unticked or left the list since.
    const none = p.rows.length || p.newTags.length ? "没有可应用的改动" : "AI 没有提出改动";
    $("aiReviewSummary").innerHTML = changes.length || newN ? `<b>${changes.length}</b> 个${esc(who)}有改动，新建 <b>${newN}</b> 个标签` : none;
    const tally = UI.aiTally(p, changes, a.tagName);
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
    // The last run's failure line goes; the review shows what this one was asked.
    progressOf.delete(ai);
    ranOf.set(ai, { where: whereOf(ai), instruction });
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
      progress(a, text, where = "", remedy = null) {
        progressOf.set(a, { where, text, remedy });
        if (isOpen(a) && !$("aiForm").hidden) drawProgress(a);
      }
    }
  };
})();
