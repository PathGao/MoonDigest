// node extension/options.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// options.js runs init() against the page DOM; lift only the functions under test.
const source = fs.readFileSync(path.join(__dirname, "options.js"), "utf8");
const fn = (name) => source.slice(source.indexOf(`function ${name}(`), source.indexOf("\n}\n", source.indexOf(`function ${name}(`)) + 2);
const ctx = vm.createContext({ URL, elements: {}, validateNoteExtras: () => ({ ok: true }) });
vm.runInContext([fn("validateSettings"), fn("hostPermissionPattern")].join("\n"), ctx);

// [::1] is not in manifest host_permissions: Obsidian rejects it, AI platforms ask for it like any other host.
const obsidian = (url) => ctx.validateSettings({ obsidianEnabled: true, noteFolder: "MoonDigest", obsidianApiBaseUrl: url }, { requireApiKey: false });
assert.strictEqual(obsidian("http://127.0.0.1:27123").ok, true);
assert.strictEqual(obsidian("http://localhost:27123").ok, true);
assert.strictEqual(obsidian("http://[::1]:27123").message, "不支持 [::1]，请改用 127.0.0.1");
assert.strictEqual(obsidian("http://192.168.1.2:27123").ok, false);
assert.strictEqual(ctx.hostPermissionPattern("http://localhost:11434/v1"), "");
assert.strictEqual(ctx.hostPermissionPattern("http://[::1]:11434/v1"), "http://[::1]/*");
assert.strictEqual(ctx.hostPermissionPattern("https://api.openai.com/v1"), "https://api.openai.com/*");

console.log("options selftest: all passed");
