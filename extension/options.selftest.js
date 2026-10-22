// node extension/options.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// options.js runs init() against the page DOM; lift only the functions under test. Startup is scripts/smoke.mjs's job.
const source = fs.readFileSync(path.join(__dirname, "options.js"), "utf8");
const fn = (name) => source.slice(source.indexOf(`function ${name}(`), source.indexOf("\n}\n", source.indexOf(`function ${name}(`)) + 2);
// A top-level constant of options.js, for the functions that read it.
const constant = (name) => source.slice(source.indexOf(`const ${name} =`), source.indexOf(";\n", source.indexOf(`const ${name} =`)) + 1);
const ctx = vm.createContext({ URL, busyButton: null, obsidianTest: null, elements: {}, validateNoteExtras: () => ({ ok: true }) });
vm.runInContext([fn("validateSettings"), fn("validateNoteFolder"), fn("hostPermissionPattern"), fn("droppedFolders")].join("\n"), ctx);

// [::1] is not in manifest host_permissions: Obsidian rejects it, AI platforms ask for it like any other host.
const obsidian = (url) => ctx.validateSettings({ obsidianEnabled: true, noteFolder: "MoonDigest", obsidianApiBaseUrl: url }, { testing: false });
assert.strictEqual(obsidian("http://127.0.0.1:27123").ok, true);
assert.strictEqual(obsidian("http://localhost:27123").ok, true);
assert.strictEqual(obsidian("http://[::1]:27123").message, "不支持 [::1]，请改用 127.0.0.1");
assert.strictEqual(obsidian("http://192.168.1.2:27123").ok, false);
// C246: a . or .. folder would write outside the note folder.
const folder = (noteFolder) => ctx.validateSettings({ obsidianEnabled: true, noteFolder, obsidianApiBaseUrl: "http://127.0.0.1:27123" }, { testing: false });
assert.strictEqual(folder("MoonDigest/{{site}}").ok, true);
for (const bad of ["../x", "a/../../b", "a/./b", "a/ .. /b"]) assert.strictEqual(folder(bad).ok, false, bad);
assert.strictEqual(folder("a/..b/c").ok, true, "a name that only starts with .. is a folder name");
// C248: 测试连接 checks only the address, not the note folder or the note format.
ctx.validateNoteExtras = () => ({ ok: false, message: "属性错" });
assert.strictEqual(ctx.validateSettings({ obsidianEnabled: true, noteFolder: "", obsidianApiBaseUrl: "http://127.0.0.1:27123" }, { testing: true }).ok, true);
assert.strictEqual(ctx.validateSettings({ obsidianEnabled: false, noteFolder: "../x", obsidianApiBaseUrl: "http://127.0.0.1:27123" }, { testing: true }).ok, true);
assert.strictEqual(folder("MoonDigest").message, "属性错", "saving still checks the note format");
ctx.validateNoteExtras = () => ({ ok: true });
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
// A setting's row says what it does not cover: hot comments go into a note without subtitles anyway (note.js
// buildMarkdown), and only 写入 Obsidian stores the cover in the vault (obsidian.js linkCoverInVault).
{
  const html = fs.readFileSync(path.join(__dirname, "options.html"), "utf8");
  const hintOf = (id) => new RegExp(`for="${id}">[^\\n]*?</label><p class="hint">([^\\n]*?)</p>`).exec(html)?.[1] || "";
  assert.ok(hintOf("includeHotCommentsInNote").includes("没有字幕的视频关着也带"), hintOf("includeHotCommentsInNote"));
  assert.ok(/复制和下载的笔记用 B站 的图片地址.*写入 Obsidian 时封面存进库里/.test(hintOf("includeCoverInNote")), hintOf("includeCoverInNote"));
}
// The scripts options.html loads before options.js, read from the page so the test cannot load a different set.
const scripts = [...fs.readFileSync(path.join(__dirname, "options.html"), "utf8").matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
assert.strictEqual(scripts.pop(), "./options.js", "options.js loads last");
for (const f of scripts) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
vm.runInContext(["const { escapeHtml } = MdgErrors;", fn("buildFixedPropertyValueControl")].join("\n"), ctx);
for (const bad of XSS) assertInert(ctx.buildFixedPropertyValueControl("text", bad), "property value");

// Obsidian's 测试连接 is disabled with the reason while the 地址 or the Key is empty, like an AI platform row's (H2).
vm.runInContext([fn("syncObsidianTest"), fn("obsidianTarget"), fn("normalizeBaseUrl"), fn("setTestResult")].join("\n"), ctx);
const testBtn = { setAttribute() {}, removeAttribute() {} };
Object.assign(ctx.elements, { testConnectionBtn: testBtn, obsidianApiBaseUrl: { value: "" }, obsidianApiKey: { value: " " }, obsidianTestResult: { textContent: "", dataset: {} } });
ctx.syncObsidianTest();
assert.deepStrictEqual([testBtn.disabled, testBtn.title], [true, "先填 Local REST API 地址和 Key"]);
ctx.elements.obsidianApiBaseUrl.value = "http://127.0.0.1:27123";
ctx.syncObsidianTest();
assert.deepStrictEqual([testBtn.disabled, testBtn.title], [true, "先填 Local REST API Key"]);
ctx.elements.obsidianApiKey.value = "k";
ctx.syncObsidianTest();
assert.strictEqual(testBtn.disabled, false);
// C245: the result stays while the boxes hold what was tested (a trailing / or a Bearer prefix is the same) and goes
// with an edit away from them.
ctx.obsidianTest = { target: "http://127.0.0.1:27123\nk", ok: true };
ctx.elements.obsidianTestResult.textContent = "连接成功";
ctx.elements.obsidianApiBaseUrl.value = "http://127.0.0.1:27123/";
ctx.elements.obsidianApiKey.value = "Bearer k";
ctx.syncObsidianTest();
assert.strictEqual(ctx.elements.obsidianTestResult.textContent, "连接成功");
ctx.elements.obsidianApiKey.value = "k2";
ctx.syncObsidianTest();
assert.strictEqual(ctx.elements.obsidianTestResult.textContent, "");
ctx.obsidianTest = null;
assert.ok(/button\.setAttribute\("aria-busy"[^\n]*\n  \}\n  if \(!active\) syncObsidianTest\(\);/.test(source), "setBusy(null) gives 测试连接 its reason back");

// 看多少算看完了 is parsed by settings.js's normalizeSeenThreshold (settings.selftest.js); the box's range and 「默认 N」
// come from SEEN_THRESHOLD (J15).
assert.ok(source.includes("seenThreshold: MdgSettings.normalizeSeenThreshold(elements.seenThreshold.value),"), "options.js parses 看多少算看完了 with normalizeSeenThreshold");
assert.ok(source.includes("const { min, max, def } = MdgSettings.SEEN_THRESHOLD;") && source.includes("TriageUi.numBox(elements.seenThreshold, min, max, def);"), "seenThreshold's box reads SEEN_THRESHOLD");

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
  vm.runInContext([constant("TRASH_ICON"), constant("AI_FIELD"), fn("addAiProviderRow"), constant("PLAIN_HTTP_WARNING"), fn("plainHttpWarning"), fn("apiKeyPlaceholder"), fn("generateAiProviderId"), fn("savedKeyApplies"), fn("urlOrigin")].join("\n"), page);
  page.addAiProviderRow({});
  const test = parts[".ai-provider-test"];
  const type = (sel, v) => ((parts[sel].value = v), parts[sel].L.input.forEach((f) => f()));
  assert.deepStrictEqual([test.disabled, test.title], [true, "先填接口地址和模型"]);
  type(".ai-provider-baseurl", "https://api.example.com/v1");
  assert.deepStrictEqual([test.disabled, test.title], [true, "先填模型"]);
  type(".ai-provider-model", "m");
  assert.deepStrictEqual([test.disabled, test.title, test.attrs["aria-description"]], [false, "用这一行的地址、模型和 Key 向 AI 发一条测试消息", undefined]);
  // C280: the row warns under a public http:// address as it is typed, and stops when it is https again.
  const warn = parts[".ai-provider-warn"];
  type(".ai-provider-baseurl", "http://api.example.com/v1");
  assert.deepStrictEqual([warn.hidden, warn.textContent], [false, "这个地址不是 https，Key 会明文发出，确认这条线路是加密的再用"]);
  type(".ai-provider-baseurl", "https://api.example.com/v1");
  assert.strictEqual(warn.hidden, true);
}

// A28: Obsidian's 测试连接 stays disabled while a test or a save runs, whatever is typed; it comes back when it ends.
{
  const btn = (textContent) => ({ textContent, dataset: {}, setAttribute() {}, removeAttribute() {} });
  const page = vm.createContext({ MdgErrors: ctx.MdgErrors, MdgSettings: ctx.MdgSettings, busyButton: null, obsidianTest: null, elements: { saveBtn: btn("保存"), testConnectionBtn: btn("测试连接"), obsidianApiBaseUrl: { value: "http://127.0.0.1:27123" }, obsidianApiKey: { value: "" } } });
  vm.runInContext([fn("setBusy"), fn("syncObsidianTest"), fn("normalizeBaseUrl")].join("\n"), page);
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
    assert.deepStrictEqual([main.inert, log], [true, [[`读取设置失败：${reason}，请刷新网页后重试`, true]]], fail);
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
  vm.runInContext([constant("TRASH_ICON"), constant("AI_FIELD"), fn("addAiProviderRow"), constant("PLAIN_HTTP_WARNING"), fn("plainHttpWarning"), fn("apiKeyPlaceholder"), fn("generateAiProviderId"), fn("savedKeyApplies"), fn("urlOrigin"), fn("collectAiProviders"), fn("hostPermissionPattern"), fn("showAiProviderStatus"), `async ${fn("testAiProviderRow")}`].join("\n"), page);
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
  // C274, C276: the edit hid the status, and the answer, for the values before it, is not shown.
  assert.strictEqual(parts[".ai-provider-status"].hidden, true);
})().catch((e) => (console.error(e), process.exit(1)));

// C249, C256, C257: a property row's error marks the box it is about; a date must exist.
{
  const box = () => ({});
  const row = () => {
    const parts = { ".fixed-property-key": box(), ".fixed-property-value": box() };
    return { parts, querySelector: (sel) => parts[sel] };
  };
  const page = vm.createContext({ MdgSettings: ctx.MdgSettings, elements: { frontmatterFields: [{ value: "title" }] } });
  vm.runInContext([constant("CUSTOM_PROPERTY_KEY_PATTERN"), constant("TYPED_PROPERTY_VARS"), constant("FRONTMATTER_DATE_VALUE_RE"), fn("validateFixedFrontmatterProperties"), fn("isCalendarDate")].join("\n"), page);
  const check = (key, type, value) => {
    const r = row();
    const v = page.validateFixedFrontmatterProperties([{ key, type, value, row: r }]);
    return [v.ok, v.field === r.parts[".fixed-property-key"] ? "key" : v.field === r.parts[".fixed-property-value"] ? "value" : v.field, v.message];
  };
  assert.deepStrictEqual(check("评分", "number", "abc").slice(0, 2), [false, "value"]);
  assert.deepStrictEqual(check("完成", "checkbox", "yes").slice(0, 2), [false, "value"]);
  assert.deepStrictEqual(check("", "text", "x").slice(0, 2), [false, "key"]);
  assert.deepStrictEqual(check("title", "text", "x"), [false, "key", "该属性名与自带属性重复，请换一个名称"]);
  assert.deepStrictEqual(check("日期", "date", "2026-02-30").slice(0, 2), [false, "value"]);
  assert.deepStrictEqual(check("日期", "date", "2026-13-01").slice(0, 2), [false, "value"]);
  assert.strictEqual(check("日期", "date", "2028-02-29")[0], true);
  assert.strictEqual(check("日期", "date", "{{upload_date}}")[0], true);
  // C255: a typed property takes only the variables that read as its type; note.js would drop any other from the note.
  for (const [type, value, ok] of [["date", "{{ created }}", true], ["date", "{{title}}", false], ["date", "{{upload_date}}x", false], ["number", "{{duration}}", true], ["number", "{{author}}", false], ["checkbox", "{{title}}", false], ["text", "{{nope}}", true]]) {
    assert.strictEqual(check("属性", type, value)[0], ok, `${type} ${value}`);
  }
  assert.strictEqual(check("评分", "number", "{{title}}")[2], "数字类型的属性值必须是有效数字，或 {{duration}}、{{cid}}");
}

// C280: a public http:// address only warns (the Key goes out in clear text); local, private, Tailscale-style and
// dotless hosts do not, and neither does https.
{
  const page = vm.createContext({ URL });
  vm.runInContext([constant("PLAIN_HTTP_WARNING"), fn("plainHttpWarning")].join("\n"), page);
  const quiet = ["https://api.openai.com/v1", "http://localhost:11434/v1", "http://127.0.0.2:8080", "http://10.0.0.5/v1", "http://172.16.1.1", "http://172.31.9.9", "http://192.168.1.2:11434/v1", "http://nas.local/v1", "http://100.64.0.1", "http://100.127.255.254", "http://box.tail1234.ts.net/v1", "http://ollama:11434/v1", "http://[::1]:11434/v1", "http://[fd12::1]/v1", "http://[fe80::1]/v1", "", "not a url"];
  for (const url of quiet) assert.strictEqual(page.plainHttpWarning(url), "", url);
  for (const url of ["http://api.example.com/v1", "http://8.8.8.8/v1", "http://172.32.0.1", "http://100.128.0.1", "http://192.169.0.1", "http://[2001:db8::1]/v1", " HTTP://Example.com "]) {
    assert.strictEqual(page.plainHttpWarning(url), "这个地址不是 https，Key 会明文发出，确认这条线路是加密的再用", url);
  }
}

// C278, F1: a platform error points at its row and box.
{
  const page = vm.createContext({ URL, MdgErrors: ctx.MdgErrors });
  vm.runInContext([constant("AI_FIELD"), fn("validateAiProviders")].join("\n"), page);
  const ok = { id: "a", name: "A", baseUrl: "https://x.example/v1", model: "m", apiKey: "k", requiresKey: true };
  const pick = (v) => [v.index, v.box, v.message];
  assert.deepStrictEqual(pick(page.validateAiProviders([ok, { ...ok, id: "b", name: "B", model: "" }])), [1, ".ai-provider-model", "平台「B」需要填写模型"]);
  assert.deepStrictEqual(pick(page.validateAiProviders([{ ...ok, apiKey: "" }])), [0, ".ai-provider-apikey", "平台「A」需要填写 API Key"]);
  assert.deepStrictEqual(pick(page.validateAiProviders([{ ...ok, baseUrl: "" }])), [0, ".ai-provider-baseurl", "平台「A」需要填写接口地址"]);
  assert.strictEqual(page.validateAiProviders([ok, ok]).message, "平台 id 重复，请刷新网页后重试");
}

// C234: a failed storage read says so instead of showing nothing used.
(async () => {
  const node = () => ({ kids: [], append(...n) { this.kids.push(...n); } });
  const table = { replaceChildren(...n) { this.rows = n; } };
  const page = vm.createContext({
    MdgErrors: ctx.MdgErrors, MdgLimits: { storageUsage: () => ({}), describe: () => [] }, elements: { storageLimits: table },
    document: { createElement: node },
    chrome: { storage: { local: { get: async () => { throw new Error("读不了"); } } } }
  });
  vm.runInContext(`async ${fn("renderStorageLimits")}`, page);
  await page.renderStorageLimits();
  assert.strictEqual(table.rows[0]?.kids[0]?.textContent, "读取存储用量失败：读不了");
})().catch((e) => (console.error(e), process.exit(1)));

// C239, C243: the settings saved, the AI platforms not: the settings no longer count as unsaved, and the status says
// the settings are saved, whether the platforms' save answered with an error or threw.
(async () => {
  for (const [how, reason] of [["reply", "写不进"], ["throw", "断开"]]) {
    const log = [];
    const page = vm.createContext({
      MdgErrors: ctx.MdgErrors, TriageUi: { clampNumber() {} },
      elements: { saveBtn: {}, seenThreshold: {}, aiPresetPrompts: {}, webAiPresetPrompts: {} },
      savedForm: { payload: { folder: "旧" }, providers: ["旧平台"] }, obsidianTest: null,
      clearInputErrors() {}, collectFormPayload: () => ({ aiPresetPrompts: [], webAiPresetPrompts: [] }), validateSettings: () => ({ ok: true }),
      collectAiProviders: () => [], validateAiProviders: () => ({ ok: true }), hostPermissionUrls: () => [], requestHostPermissions: async () => [],
      setBusy() {}, setStatus: (text, isError) => log.push([text, isError]), renderFixedPropertyRows() {}, renderNoteSectionRows() {},
      readFormState: () => ({ payload: { folder: "新" }, providers: ["新平台"] }),
      syncUnsaved() {}, renderSavedState() {}, markSaved: () => log.push("markSaved"),
      sendRuntimeMessage: async (m) => {
        if (m.type === "save-settings") return { ok: true };
        if (how === "throw") throw new Error(reason);
        return { ok: false, error: reason };
      }
    });
    vm.runInContext(`async ${fn("saveSettings")}`, page);
    await page.saveSettings();
    assert.deepStrictEqual([page.savedForm.payload.folder, page.savedForm.providers[0]], ["新", "旧平台"], how);
    assert.deepStrictEqual(log.at(-1), [`设置已保存，但 AI 平台保存失败：${reason}`, true], how);
  }
})().catch((e) => (console.error(e), process.exit(1)));

// C268: a delete the background did not write keeps the row and says why; a written one removes it.
(async () => {
  const stub = () => {
    const cls = new Set();
    const L = {};
    return { value: "", hidden: true, textContent: "", innerHTML: "", dataset: {}, attrs: {}, L, classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, addEventListener: (t, f) => ((L[t] ||= []).push(f)), focus() {}, querySelector: () => null };
  };
  const parts = {};
  let removed = 0;
  let reply;
  const row = { ...stub(), querySelector: (sel) => (parts[sel] ||= stub()), querySelectorAll: () => [], remove: () => removed++ };
  const page = vm.createContext({
    URL, MdgErrors: ctx.MdgErrors, escapeHtml: ctx.MdgErrors.escapeHtml, AI_PRESETS: [{ id: "custom", name: "自定义", baseUrl: "", model: "", requiresKey: true }],
    document: { createElement: () => row }, elements: { aiProvidersList: { appendChild() {} } },
    updateAiProvidersEmptyState() {}, updateSavedProviders() {}, sendRuntimeMessage: async () => reply()
  });
  vm.runInContext([constant("TRASH_ICON"), constant("AI_FIELD"), fn("addAiProviderRow"), constant("PLAIN_HTTP_WARNING"), fn("plainHttpWarning"), fn("apiKeyPlaceholder"), fn("generateAiProviderId"), fn("savedKeyApplies"), fn("urlOrigin"), fn("showAiProviderStatus")].join("\n"), page);
  page.addAiProviderRow({ id: "p1" });
  const del = parts[".ai-provider-remove"];
  const status = parts[".ai-provider-status"];
  const answers = [[() => ({ ok: false, error: "写不进" }), "删除失败：写不进"], [() => { throw new Error("断开"); }, "删除失败：断开"]];
  for (const [answer, text] of answers) {
    reply = answer;
    await del.L.click[0]();
    await del.L.click[0]();
    assert.deepStrictEqual([removed, status.hidden, status.textContent, del.attrs["aria-label"]], [0, false, text, "删除平台"]);
  }
  reply = () => ({ ok: true });
  await del.L.click[0]();
  assert.strictEqual(del.attrs["aria-label"], del.title, "the armed button's name and tooltip are one sentence");
  await del.L.click[0]();
  assert.strictEqual(removed, 1);
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
