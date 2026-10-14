// node extension/options.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// options.js runs init() against the page DOM; lift only the functions under test.
const source = fs.readFileSync(path.join(__dirname, "options.js"), "utf8");
const fn = (name) => source.slice(source.indexOf(`function ${name}(`), source.indexOf("\n}\n", source.indexOf(`function ${name}(`)) + 2);
const ctx = vm.createContext({ URL, elements: {}, validateNoteExtras: () => ({ ok: true }) });
vm.runInContext([fn("validateSettings"), fn("hostPermissionPattern"), fn("droppedFolders")].join("\n"), ctx);

// [::1] is not in manifest host_permissions: Obsidian rejects it, AI platforms ask for it like any other host.
const obsidian = (url) => ctx.validateSettings({ obsidianEnabled: true, noteFolder: "MoonDigest", obsidianApiBaseUrl: url }, { requireApiKey: false });
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
// The scripts options.html loads before options.js, read from the page so the test cannot load a different set.
const scripts = [...fs.readFileSync(path.join(__dirname, "options.html"), "utf8").matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
assert.strictEqual(scripts.pop(), "./options.js", "options.js loads last");
for (const f of scripts) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
vm.runInContext(["const { escapeHtml } = MdgErrors;", fn("buildFixedPropertyValueControl")].join("\n"), ctx);
for (const bad of XSS) assertInert(ctx.buildFixedPropertyValueControl("text", bad), "property value");

// 看多少算看完了 is parsed by settings.js's normalizeSeenThreshold (settings.selftest.js); the box's range and 「默认 N」
// come from SEEN_THRESHOLD (J15).
assert.ok(source.includes("seenThreshold: MdgSettings.normalizeSeenThreshold(elements.seenThreshold.value),"), "options.js parses 看多少算看完了 with normalizeSeenThreshold");
assert.ok(source.includes("const { min, max, def } = MdgSettings.SEEN_THRESHOLD;") && source.includes("placeholder: `默认 ${def}`"), "seenThreshold's box reads SEEN_THRESHOLD");

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
  vm.runInContext([fn("hostPermissionPattern"), fn("showAiProviderStatus"), `async ${fn("testAiProviderRow")}`].join("\n"), page);
  const pending = page.testAiProviderRow(row);
  assert.deepStrictEqual(log, ["ask https://api.example.com/*"], "asked synchronously, inside the click's gesture");
  await pending;
  assert.deepStrictEqual([status.textContent, status.dataset.error, log.length], ["失败：未授权访问 https://api.example.com，授权后重试", "true", 1]);
  assert.strictEqual(status.kids.length, 1, "with a 授权 button");
  allow = true;
  await status.kids[0].on.click();
  assert.deepStrictEqual([log.slice(1), status.textContent], [["ask https://api.example.com/*", "ask https://api.example.com/*", "test https://api.example.com/v1"], "连接成功，记得保存设置"]);
  console.log("options selftest: all passed");
})().catch((e) => (console.error(e), process.exit(1)));
