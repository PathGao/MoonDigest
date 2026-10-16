// node extension/options.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// options.js runs init() against the page DOM; lift only the functions under test. Startup is scripts/smoke.mjs's job.
const source = fs.readFileSync(path.join(__dirname, "options.js"), "utf8");
const fn = (name) => source.slice(source.indexOf(`function ${name}(`), source.indexOf("\n}\n", source.indexOf(`function ${name}(`)) + 2);
const ctx = vm.createContext({ URL, busyButton: null, elements: {}, validateNoteExtras: () => ({ ok: true }) });
vm.runInContext([fn("validateSettings"), fn("hostPermissionPattern"), fn("droppedFolders")].join("\n"), ctx);

// [::1] is not in manifest host_permissions: Obsidian rejects it, AI platforms ask for it like any other host.
const obsidian = (url) => ctx.validateSettings({ obsidianEnabled: true, noteFolder: "MoonDigest", obsidianApiBaseUrl: url }, { testing: false });
assert.strictEqual(obsidian("http://127.0.0.1:27123").ok, true);
assert.strictEqual(obsidian("http://localhost:27123").ok, true);
assert.strictEqual(obsidian("http://[::1]:27123").message, "不支持 [::1]，请改用 127.0.0.1");
assert.strictEqual(obsidian("http://192.168.1.2:27123").ok, false);
assert.strictEqual(ctx.hostPermissionPattern("http://localhost:11434/v1"), "");
assert.strictEqual(ctx.hostPermissionPattern("http://[::1]:11434/v1"), "http://[::1]/*");
assert.strictEqual(ctx.hostPermissionPattern("https://api.openai.com/v1"), "https://api.openai.com/*");

// Importing warns how many folders chosen here the file leaves out; a file without a folder choice keeps them.
assert.strictEqual(ctx.droppedFolders(["11", "22", "toview"], ["22", "33"]), 2);
assert.strictEqual(ctx.droppedFolders(["11"], ["11", "22"]), 0);
assert.strictEqual(ctx.droppedFolders(["11"], undefined), 0);
assert.strictEqual(ctx.droppedFolders(undefined, ["11"]), 0);

// A save marks any box red (save-settings names a too-long field such as aiSystemPrompt); the next save clears it.
const marked = ["aiSystemPrompt", "noteFolder"].map(() => {
  const set = new Set(["input-error"]);
  return { set, classList: { remove: (c) => set.delete(c) } };
});
const marks = vm.createContext({ document: { querySelectorAll: (sel) => (sel === ".input-error" ? marked.filter((n) => n.set.size) : []) }, elements: {}, clearFixedPropertyErrors() {}, clearNoteSectionErrors() {} });
vm.runInContext(fn("clearInputErrors"), marks);
marks.clearInputErrors();
assert.deepStrictEqual(marked.map((n) => n.set.size), [0, 0], "every red box is cleared");

// Untrusted text (titles, UP names, comments, AI replies, tag names, paths) stays text: no tag of its own, no way out of
// a quoted attribute.
const XSS = ["<img src=x onerror=alert(1)>", `"'><script>alert(1)</script>`];
const assertInert = (html, where) => assert.ok(!/<img src=x|<script|"'>/i.test(html) && /&lt;|&#60;/.test(html), `${where}: ${html}`);
// An imported settings file fills the property rows.
// K14: the batch sizes live in 收藏夹设置 (用词表), not 「分拣台里」.
assert.ok(!fs.readFileSync(path.join(__dirname, "options.html"), "utf8").includes("在分拣台里设置"));
// The scripts options.html loads before options.js, read from the page so the test cannot load a different set.
const scripts = [...fs.readFileSync(path.join(__dirname, "options.html"), "utf8").matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
assert.strictEqual(scripts.pop(), "./options.js", "options.js loads last");
for (const f of scripts) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
vm.runInContext(["const { escapeHtml } = MdgErrors;", fn("buildFixedPropertyValueControl")].join("\n"), ctx);
for (const bad of XSS) assertInert(ctx.buildFixedPropertyValueControl("text", bad), "property value");

// Obsidian's 测试连接 is disabled with the reason while the 地址 or the Key is empty, like an AI platform row's (H2).
vm.runInContext(fn("syncObsidianTest"), ctx);
const testBtn = { setAttribute() {}, removeAttribute() {} };
Object.assign(ctx.elements, { testConnectionBtn: testBtn, obsidianApiBaseUrl: { value: "" }, obsidianApiKey: { value: " " } });
ctx.syncObsidianTest();
assert.deepStrictEqual([testBtn.disabled, testBtn.title], [true, "先填 Local REST API 地址和 Key"]);
ctx.elements.obsidianApiBaseUrl.value = "http://127.0.0.1:27123";
ctx.syncObsidianTest();
assert.deepStrictEqual([testBtn.disabled, testBtn.title], [true, "先填 Local REST API Key"]);
ctx.elements.obsidianApiKey.value = "k";
ctx.syncObsidianTest();
assert.strictEqual(testBtn.disabled, false);
assert.ok(/button\.setAttribute\("aria-busy"[^\n]*\n  \}\n  if \(!active\) syncObsidianTest\(\);/.test(source), "setBusy(null) gives 测试连接 its reason back");

// 看多少算看完了 is parsed by settings.js's normalizeSeenThreshold (settings.selftest.js); the box's range and 「默认 N」
// come from SEEN_THRESHOLD (J15).
assert.ok(source.includes("seenThreshold: MdgSettings.normalizeSeenThreshold(elements.seenThreshold.value),"), "options.js parses 看多少算看完了 with normalizeSeenThreshold");
assert.ok(source.includes("const { min, max, def } = MdgSettings.SEEN_THRESHOLD;") && source.includes("placeholder: `默认 ${def}`"), "seenThreshold's box reads SEEN_THRESHOLD");

// The box behaves like the 分拣台's: a change or a save clamps it with TriageUi.clampNumber (above max is max, invalid is
// cleared under 「默认 N」), never writes the default back into it.
const box = { type: "number", min: "1", max: "100" };
for (const [typed, shown] of [["150", 100], ["-3", ""], ["", ""], ["42.4", 42]]) {
  box.value = typed;
  ctx.TriageUi.clampNumber(box);
  assert.strictEqual(box.value, shown, `typed ${typed}`);
}
assert.ok(source.includes('elements.seenThreshold.addEventListener("change", () => TriageUi.clampNumber(elements.seenThreshold));'), "a change clamps the box");
assert.ok(!/seenThreshold\.value = String\((readFormPayload\(\)|payload)\.seenThreshold\)/.test(source), "the default is not written back into the box");

// 「+ 添加段落」 is disabled with the reason at MAX_NOTE_SECTIONS rows, enabled again below it.
{
  const attrs = {};
  const btn = { setAttribute: (k, v) => (attrs[k] = v), removeAttribute: (k) => delete attrs[k] };
  const list = { children: { length: ctx.MdgSettings.MAX_NOTE_SECTIONS } };
  const box = vm.createContext({ MdgErrors: ctx.MdgErrors, MdgSettings: ctx.MdgSettings, elements: { noteSectionsList: list, noteSectionsEmpty: {}, addNoteSectionBtn: btn } });
  vm.runInContext(fn("updateNoteSectionEmptyState"), box);
  box.updateNoteSectionEmptyState();
  assert.deepStrictEqual([btn.disabled, btn.title], [true, `最多 ${ctx.MdgSettings.MAX_NOTE_SECTIONS} 段，先删掉一段再添加`]);
  list.children.length -= 1;
  box.updateNoteSectionEmptyState();
  assert.deepStrictEqual([btn.disabled, btn.title], [false, ""]);
  assert.ok(!fn("addNoteSectionRow").includes("setStatus("), "no toast for a click that could not work");
}

// An AI platform's 测试连接 is disabled with the reason while 接口地址 or 模型 is empty, by what the boxes hold now.
{
  const stub = () => {
    const attrs = {};
    const L = {};
    return { value: "", attrs, L, dataset: {}, classList: { add() {}, remove() {}, contains: () => false }, setAttribute: (k, v) => (attrs[k] = v), removeAttribute: (k) => delete attrs[k], addEventListener: (t, f) => ((L[t] ||= []).push(f)), querySelector: () => null };
  };
  const parts = {};
  const row = { ...stub(), querySelector: (sel) => (parts[sel] ||= stub()), querySelectorAll: () => [] };
  const page = vm.createContext({ URL, MdgErrors: ctx.MdgErrors, escapeHtml: ctx.MdgErrors.escapeHtml, AI_PRESETS: [{ id: "custom", name: "自定义", baseUrl: "", model: "" }], document: { createElement: () => row }, elements: { aiProvidersList: { appendChild() {} } }, updateAiProvidersEmptyState() {} });
  vm.runInContext([fn("addAiProviderRow"), fn("apiKeyPlaceholder"), fn("generateAiProviderId"), fn("savedKeyApplies"), fn("urlOrigin")].join("\n"), page);
  page.addAiProviderRow({});
  const test = parts[".ai-provider-test"];
  const type = (sel, v) => ((parts[sel].value = v), parts[sel].L.input.forEach((f) => f()));
  assert.deepStrictEqual([test.disabled, test.title], [true, "先填接口地址和模型"]);
  type(".ai-provider-baseurl", "https://api.example.com/v1");
  assert.deepStrictEqual([test.disabled, test.title], [true, "先填模型"]);
  type(".ai-provider-model", "m");
  assert.deepStrictEqual([test.disabled, test.title, test.attrs["aria-description"]], [false, "用这一行的地址、模型和 Key 向 AI 发一条测试消息", undefined]);
}

// A28: Obsidian's 测试连接 stays disabled while a test or a save runs, whatever is typed; it comes back when it ends.
{
  const btn = () => ({ setAttribute() {}, removeAttribute() {} });
  const page = vm.createContext({ MdgErrors: ctx.MdgErrors, busyButton: null, elements: { saveBtn: btn(), testConnectionBtn: btn(), obsidianApiBaseUrl: { value: "http://127.0.0.1:27123" }, obsidianApiKey: { value: "" } } });
  vm.runInContext([fn("setBusy"), fn("syncObsidianTest")].join("\n"), page);
  page.setBusy(page.elements.testConnectionBtn);
  page.elements.obsidianApiKey.value = "new key";
  page.syncObsidianTest();
  assert.deepStrictEqual([page.elements.testConnectionBtn.disabled, page.elements.testConnectionBtn.textContent], [true, "测试中…"]);
  page.setBusy(null);
  assert.deepStrictEqual([page.elements.testConnectionBtn.disabled, page.elements.testConnectionBtn.textContent], [false, "测试连接"]);
}

// A3, A4: when the settings or the AI platform list cannot be read, the page says so, shows no values and offers no save
// (savedForm stays unset, so no edit counts as unsaved).
(async () => {
  for (const fail of ["get-settings", "ai-providers-list", "throw"]) {
    const log = [];
    const main = {};
    const page = vm.createContext({
      MdgErrors: ctx.MdgErrors, DEFAULT_SETTINGS: { obsidianApiKey: "" },
      document: { querySelector: (sel) => (sel === "main" ? main : null) },
      setStatus: (text, isError) => log.push([text, isError]),
      markSaved: () => log.push("markSaved"),
      renderStorageLimits: async () => log.push("render"),
      sendRuntimeMessage: async (m) => {
        if (fail === "throw") throw new Error("Could not establish connection");
        return m.type === fail ? { ok: false, error: "读取失败" } : { ok: true, settings: {}, providers: [] };
      }
    });
    vm.runInContext([`async ${fn("loadSettings")}`, `async ${fn("getSettings")}`, `async ${fn("loadAiProviders")}`].join("\n"), page);
    // Only the failure path is set up here: had it gone on to fill the form, the missing elements would throw.
    await page.loadSettings().catch(() => {});
    const reason = fail === "throw" ? "Could not establish connection" : "读取失败";
    assert.deepStrictEqual([main.inert, log], [true, [[`读取设置失败，请刷新页面重试：${reason}`, true]]], fail);
  }
})().catch((e) => (console.error(e), process.exit(1)));

// A5, A29: an AI platform row with a saved Key.
(async () => {
  const stub = () => {
    const attrs = {};
    const L = {};
    return { value: "", hidden: false, attrs, L, dataset: {}, classList: { add() {}, remove() {}, contains: () => false }, setAttribute: (k, v) => (attrs[k] = v), removeAttribute: (k) => delete attrs[k], addEventListener: (t, f) => ((L[t] ||= []).push(f)), querySelector: () => null };
  };
  const parts = {};
  const row = { ...stub(), querySelector: (sel) => (parts[sel] ||= stub()), querySelectorAll: () => [] };
  const sent = [];
  let answer;
  const page = vm.createContext({
    URL, MdgErrors: ctx.MdgErrors, escapeHtml: ctx.MdgErrors.escapeHtml, hasUnsavedChanges: false,
    AI_PRESETS: [{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", requiresKey: true }, { id: "custom", name: "自定义", baseUrl: "", model: "", requiresKey: true }],
    document: { createElement: () => row },
    elements: { aiProvidersList: { appendChild() {}, querySelectorAll: () => [row] } },
    updateAiProvidersEmptyState() {},
    chrome: { permissions: { request: async () => true } },
    sendRuntimeMessage: (m) => (sent.push(m), new Promise((r) => (answer = r)))
  });
  vm.runInContext([fn("addAiProviderRow"), fn("apiKeyPlaceholder"), fn("generateAiProviderId"), fn("savedKeyApplies"), fn("urlOrigin"), fn("collectAiProviders"), fn("hostPermissionPattern"), fn("showAiProviderStatus"), `async ${fn("testAiProviderRow")}`].join("\n"), page);
  page.addAiProviderRow({ id: "p1", presetId: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", hasSavedKey: true });
  parts[".ai-provider-preset"].value = "deepseek";
  const type = (sel, v) => ((parts[sel].value = v), parts[sel].L.input.forEach((f) => f()));
  type(".ai-provider-baseurl", "https://api.deepseek.com/v2");
  assert.strictEqual(page.collectAiProviders()[0].hasSavedKey, true, "another path on the same host keeps the Key");

  // A5: pointed at another host, the saved Key is not counted (save asks for one) and 测试连接 does not use it.
  parts[".ai-provider-preset"].value = "custom";
  type(".ai-provider-baseurl", "https://api.example.com/v1");
  assert.deepStrictEqual([page.collectAiProviders()[0].hasSavedKey, parts[".ai-provider-apikey"].placeholder, parts[".keytag"].hidden], [false, "必填", true]);
  const test = parts[".ai-provider-test"];
  const pending = test.L.click[0]();
  await new Promise((r) => setTimeout(r));
  assert.deepStrictEqual([sent.length, sent[0]?.providerId], [1, ""], "the old platform's Key is not looked up for the new host");

  // A29: typing while the test runs does not enable 测试连接 again.
  type(".ai-provider-model", "other-model");
  assert.strictEqual(test.disabled, true, "stays disabled while the test runs");
  answer({ ok: true });
  await pending;
  assert.strictEqual(test.disabled, false, "enabled again when it answers");
})().catch((e) => (console.error(e), process.exit(1)));

// E1: 测试连接 for an address not saved yet asks for its host permission in the click, before anything is awaited, then
// tests; declined, the status says so with 授权, which asks again and tests.
(async () => {
  const log = [];
  let allow = false;
  const node = () => {
    const kids = [];
    return { kids, hidden: true, textContent: "", dataset: {}, disabled: false, setAttribute() {}, append: (...n) => kids.push(...n.filter((x) => typeof x !== "string")), on: {}, addEventListener(t, f) { this.on[t] = f; } };
  };
  const status = node();
  const fields = { ".ai-provider-baseurl": "https://api.example.com/v1", ".ai-provider-apikey": "k", ".ai-provider-model": "m", ".ai-provider-preset": "custom" };
  const row = { dataset: {}, querySelector: (sel) => (sel === ".ai-provider-status" ? status : sel === ".ai-provider-test" ? node() : { value: fields[sel] }) };
  const page = vm.createContext({
    URL, hasUnsavedChanges: true, AI_PRESETS: [{ id: "custom", requiresKey: true }],
    document: { createElement: node },
    chrome: { permissions: { request: async ({ origins }) => (log.push(`ask ${origins}`), allow) } },
    sendRuntimeMessage: async (m) => (log.push(`test ${m.baseUrl}`), { ok: true })
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "errors.js"), "utf8"), page);
  vm.runInContext([fn("hostPermissionPattern"), fn("showAiProviderStatus"), fn("savedKeyApplies"), fn("urlOrigin"), `async ${fn("testAiProviderRow")}`].join("\n"), page);
  // L4: the declined permission carries its code, as the background's does.
  const replies = [];
  const realText = page.MdgErrors.text;
  page.MdgErrors = { ...page.MdgErrors, text: (r) => (replies.push(r), realText(r)) };
  const pending = page.testAiProviderRow(row, () => {});
  assert.deepStrictEqual(log, ["ask https://api.example.com/*"], "asked synchronously, inside the click's gesture");
  await pending;
  assert.deepStrictEqual([status.textContent, status.dataset.error, log.length], ["失败：未授权访问 https://api.example.com，授权后重试", "true", 1]);
  assert.strictEqual(status.kids.length, 1, "with a 授权 button");
  assert.strictEqual(replies[0].code, "AI_ACCESS");
  allow = true;
  await status.kids[0].on.click();
  assert.deepStrictEqual([log.slice(1), status.textContent], [["ask https://api.example.com/*", "ask https://api.example.com/*", "test https://api.example.com/v1"], "连接成功，记得保存设置"]);
  console.log("options selftest: all passed");
})().catch((e) => (console.error(e), process.exit(1)));
