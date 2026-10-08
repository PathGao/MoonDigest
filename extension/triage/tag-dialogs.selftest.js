// node extension/triage/tag-dialogs.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// The markup: one 标签管理 and one AI 打标签 dialog, each titled after its button, with no switch between them; the
// modes have no tag dialog of their own.
const html = fs.readFileSync(path.join(__dirname, "triage.html"), "utf8");
const follow = fs.readFileSync(path.join(__dirname, "follow.js"), "utf8");
const dialogHtml = (id) => html.slice(html.indexOf(`<dialog id="${id}"`), html.indexOf("</dialog>", html.indexOf(`<dialog id="${id}"`)));
assert.ok(/<h2 id="tagManageTitle">标签管理<\/h2>/.test(dialogHtml("tagManageDialog")), "标签管理 is titled 标签管理");
assert.ok(/<h2 id="aiTagTitle">AI 打标签<\/h2>/.test(dialogHtml("aiTagDialog")), "AI 打标签 is titled AI 打标签");
assert.ok(!/id="aiInstruction"/.test(dialogHtml("tagManageDialog")) && !/id="tagsRows"/.test(dialogHtml("aiTagDialog")), "neither has the other's part");
for (const [name, text] of [["triage.html", html], ["follow.js", follow]]) {
  assert.ok(!/data-tags-mode|data-fwmode|id="tagsDialog"|id="fwTagsDialog"/.test(text), `${name}: no combined tags dialog or its switch`);
}
assert.ok(!/class="seg"/.test(dialogHtml("tagManageDialog") + dialogHtml("aiTagDialog")), "no segmented switch in either dialog");

// A small fake DOM: nodes by id record listeners; fire() runs them like the browser would.
const nodes = {};
function node(id, extra = {}) {
  const L = {};
  const attrs = {};
  return (nodes[id] = Object.assign({ id, L, attrs, hidden: false, disabled: false, value: "", innerHTML: "", textContent: "", dataset: {}, addEventListener: (t, f) => (L[t] ||= []).push(f), setAttribute: (k, v) => (attrs[k] = v), removeAttribute: (k) => delete attrs[k], focus() { focused = id; } }, extra));
}
let focused = "";
const dialog = (id) => node(id, { open: false, showModal() { this.open = true; }, close() { this.open = false; }, querySelector: () => null });
dialog("tagManageDialog");
dialog("aiTagDialog");
for (const id of ["tagManageHint", "tagsRows", "newTagInput", "addTagBtn", "aiForm", "aiReview", "aiHint", "aiInstruction", "aiHistory", "aiScope", "aiScopeCount", "aiTagsPreview", "aiRemoveInput", "aiProgress", "aiCloseBtn", "aiStopBtn", "aiRunBtn", "aiReviewSummary", "aiNotes", "aiNewTagsHead", "aiNewTags", "aiRows", "aiReviewHint", "aiRecentMeta", "aiDiscardBtn", "aiApplyBtn"]) node(id);
const fire = (id, type, e = {}) => {
  const ev = { prevented: 0, preventDefault() { this.prevented++; }, isComposing: false, keyCode: 0, ...e };
  for (const f of nodes[id].L[type] || []) f(ev);
  return ev;
};
// An event target: a button (or field) matching sel, with dataset and id.
const target = (sel, o = {}) => ({ dataset: {}, closest: (s) => (s === sel || s === "button" ? { id: o.id || "", dataset: o.dataset || {} } : null), matches: (s) => s.split(", ").includes(sel), ...o });
const docL = {};
const ctx = vm.createContext({ document: { getElementById: (id) => nodes[id] || null, addEventListener: (t, f) => (docL[t] ||= []).push(f) }, CSS: { escape: (s) => s }, setTimeout, clearTimeout });
for (const f of ["../typing.js", "../tag-core.js", "shared.js", "tag-dialogs.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
const D = ctx.TagDialogs;
const wait = () => new Promise((r) => setTimeout(r, 5));

// The two modes' adapters, as triage.js and follow.js hand them over: only the unit, the limits and the data differ.
function adapters(who) {
  const tags = [{ id: "a", name: "科普", color: "#111" }];
  const calls = [];
  const manage = {
    who,
    hint: () => "这里的标签。",
    tags: () => tags,
    count: () => 2,
    add: async (name) => (calls.push(["add", name]), name === "重名" ? null : { id: name, name }),
    edit: async (t, field, value) => (calls.push(["edit", t.id, field, value]), value !== "重名"),
    remove: async (t) => calls.push(["remove", t.id])
  };
  const ai = {
    who,
    sees: "名字",
    example: "分一下",
    excluded: new Set(["a"]),
    manage,
    tags: () => tags,
    scopes: () => [{ value: "filter", label: "当前筛选", n: 3 }, { value: "selected", label: "选中", n: ai.sel }],
    sel: 0,
    scopeText: (s) => `${s} 的说明`,
    roomHint: () => "最多 2 个。",
    blocked: () => "",
    history: () => ["上次的指令"],
    allowRemove: () => true,
    running: () => ai.isRunning,
    isRunning: false,
    proposal: () => ai.p,
    p: null,
    run: (args) => (calls.push(["run", args]), (ai.isRunning = true)),
    stop: () => calls.push(["stop"]),
    discard: () => (ai.p = null),
    apply: async () => calls.push(["apply"]),
    changes: (p) => p.rows.map((r) => [r.id, [], ["a"]]),
    tally: () => [{ cls: "add", text: "+ 科普", n: 2 }],
    uses: () => 1
  };
  return { manage, ai, calls, tags };
}

(async () => {
  for (const who of ["视频", "UP 主"]) {
    const unit = who === "UP 主" ? " UP 主" : "视频";
    const { manage, ai, calls, tags } = adapters(who);

    // 标签管理: only the tags, from the adapter; AI 打标签 stays closed.
    D.manage.open(manage);
    assert.ok(nodes.tagManageDialog.open && !nodes.aiTagDialog.open && D.manage.isOpen(manage), `${who}: 标签管理 opens alone`);
    assert.strictEqual(nodes.tagManageHint.textContent, "这里的标签。改名、颜色、说明和删除立即保存。");
    assert.ok(nodes.tagsRows.innerHTML.includes(`2 个${unit}`) && nodes.tagsRows.innerHTML.includes("data-tag-color"), `${who}: rows count in the mode's unit`);
    assert.strictEqual(focused, "newTagInput");
    // IME: Enter that picks a candidate adds nothing; a plain Enter adds and clears the box.
    nodes.newTagInput.value = "zhong";
    const enter = (t, o = {}) => fire("tagManageDialog", "keydown", { key: "Enter", target: t, ...o });
    nodes.newTagInput.matches = (s) => s.split(", ").includes("#newTagInput");
    enter(nodes.newTagInput, { isComposing: true, keyCode: 229 });
    await wait();
    assert.ok(!calls.some((c) => c[0] === "add"), `${who}: no tag named after half-typed pinyin`);
    nodes.newTagInput.value = "中文";
    enter(nodes.newTagInput);
    await wait();
    assert.deepStrictEqual(calls.at(-1), ["add", "中文"]);
    assert.strictEqual(nodes.newTagInput.value, "");
    // Enter in a rename stays in the dialog (it would submit the form), but not mid-IME.
    assert.strictEqual(enter(target('[data-field="name"]')).prevented, 1);
    assert.strictEqual(enter(target('[data-field="name"]'), { isComposing: true }).prevented, 0);
    // A refused rename redraws the row with the saved name; 删除 goes to the adapter.
    nodes.tagsRows.innerHTML = "";
    fire("tagsRows", "change", { target: { value: "重名", dataset: { field: "name" }, closest: () => ({ dataset: { id: "a" } }) } });
    await wait();
    assert.ok(nodes.tagsRows.innerHTML.includes("科普"), `${who}: a refused name goes back`);
    fire("tagsRows", "click", { target: { closest: (s) => (s === ".tag-row" ? { dataset: { id: "a" } } : s === "[data-tag-del]" ? {} : null) } });
    await wait();
    assert.deepStrictEqual(calls.at(-1), ["remove", "a"]);
    nodes.tagManageDialog.close();

    // AI 打标签: the form, its own title and no 标签管理 part; 选中 is picked when something is selected.
    ai.sel = 2;
    D.ai.open(ai);
    assert.ok(nodes.aiTagDialog.open && !nodes.tagManageDialog.open && D.ai.isOpen(ai), `${who}: AI 打标签 opens alone`);
    assert.ok(!nodes.aiForm.hidden && nodes.aiReview.hidden);
    assert.strictEqual(nodes.aiScope.value, "selected");
    assert.strictEqual(ai.excluded.size, 0, "each opening starts with every tag usable");
    assert.strictEqual(nodes.aiHint.textContent, `用一句话让 AI 给一批${unit}打标签。AI 看名字，只给建议，你点「应用」后才生效。`);
    assert.ok(nodes.aiTagsPreview.innerHTML.includes('data-use="a"') && nodes.aiRemoveInput.checked);
    // No tags: the hint links to 标签管理 (a text link), which closes this dialog and opens 标签管理 with the mode's adapter.
    tags.length = 0;
    D.ai.render(ai);
    assert.ok(/还没有.*标签。最多 2 个。想打得准，先在<button type="button" class="link" data-open-manage>「标签管理」<\/button>里建好标签/.test(nodes.aiTagsPreview.innerHTML), `${who}: the link says 「标签管理」`);
    await fire("aiTagDialog", "click", { target: target("[data-open-manage]") });
    assert.ok(!nodes.aiTagDialog.open && nodes.tagManageDialog.open && D.manage.isOpen(manage), `${who}: the link opens 标签管理`);
    nodes.tagManageDialog.close();
    tags.push({ id: "a", name: "科普", color: "#111" });

    // 运行: needs an instruction; then the adapter runs with the dialog's choices and the button shows it.
    D.ai.open(ai);
    nodes.aiInstruction.value = " ";
    fire("aiTagDialog", "click", { target: target("#aiRunBtn", { id: "aiRunBtn" }) });
    assert.strictEqual(nodes.aiProgress.textContent, "请先写指令");
    assert.strictEqual(focused, "aiInstruction");
    nodes.aiInstruction.value = "按内容分";
    fire("aiTagDialog", "click", { target: target("#aiRunBtn", { id: "aiRunBtn" }) });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["run", { instruction: "按内容分", scope: "selected", allowRemove: true }]);
    assert.ok(nodes.aiRunBtn.disabled && nodes.aiRunBtn.innerHTML === "运行中…" && !nodes.aiStopBtn.hidden);
    D.ai.progress(ai, "AI 正在处理第 1 / 2 批…");
    assert.strictEqual(nodes.aiProgress.textContent, "AI 正在处理第 1 / 2 批…");

    // Done: the open dialog turns to the proposal, counted in the mode's unit; 应用 closes it.
    ai.isRunning = false;
    ai.p = { newTags: [{ key: "n", name: "新", checked: true }], rows: [{ id: "x" }, { id: "y" }], notes: [], errors: [] };
    D.ai.render(ai);
    assert.ok(nodes.aiForm.hidden && !nodes.aiReview.hidden);
    assert.strictEqual(nodes.aiApplyBtn.textContent, `应用到 2 个${unit}`);
    assert.ok(nodes.aiReviewHint.textContent.includes(`这些${unit}，在卡片上逐个看`) && nodes.aiNewTags.innerHTML.includes(`用在 1 个${unit}`));
    await fire("aiTagDialog", "click", { target: target("#aiApplyBtn", { id: "aiApplyBtn" }) });
    await wait();
    assert.ok(!nodes.aiTagDialog.open && calls.at(-1)[0] === "apply");
    ai.p = null;
  }

  // A redraw for the mode whose dialog is not open does nothing.
  const other = adapters("视频").ai;
  nodes.aiForm.hidden = true;
  D.ai.render(other);
  assert.ok(nodes.aiForm.hidden, "render(a) only draws a's open dialog");

  console.log("tag-dialogs selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
