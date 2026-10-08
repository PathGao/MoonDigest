// node extension/options.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// options.js runs init() against the page DOM; lift only the functions under test.
const source = fs.readFileSync(path.join(__dirname, "options.js"), "utf8");
const fn = (name) => source.slice(source.indexOf(`function ${name}(`), source.indexOf("\n}\n", source.indexOf(`function ${name}(`)) + 2);
const ctx = vm.createContext({ URL, elements: {}, validateNoteExtras: () => ({ ok: true }) });
vm.runInContext([fn("validateSettings"), fn("hostPermissionPattern"), fn("followDays")].join("\n"), ctx);

// [::1] is not in manifest host_permissions: Obsidian rejects it, AI platforms ask for it like any other host.
const obsidian = (url) => ctx.validateSettings({ obsidianEnabled: true, noteFolder: "MoonDigest", obsidianApiBaseUrl: url }, { requireApiKey: false });
assert.strictEqual(obsidian("http://127.0.0.1:27123").ok, true);
assert.strictEqual(obsidian("http://localhost:27123").ok, true);
assert.strictEqual(obsidian("http://[::1]:27123").message, "不支持 [::1]，请改用 127.0.0.1");
assert.strictEqual(obsidian("http://192.168.1.2:27123").ok, false);
assert.strictEqual(ctx.hostPermissionPattern("http://localhost:11434/v1"), "");
assert.strictEqual(ctx.hostPermissionPattern("http://[::1]:11434/v1"), "http://[::1]/*");
assert.strictEqual(ctx.hostPermissionPattern("https://api.openai.com/v1"), "https://api.openai.com/*");

// 关注 days: empty or junk falls back, 慢更 is clamped to 7–3650, 断更 stays at least a day past 慢更.
const days = (a, b) => JSON.parse(JSON.stringify(ctx.followDays(a, b)));
assert.deepStrictEqual(days("", ""), { followSlowDays: 90, followDeadDays: 365 });
assert.deepStrictEqual(days("30", "200"), { followSlowDays: 30, followDeadDays: 200 });
assert.deepStrictEqual(days("1", "abc"), { followSlowDays: 7, followDeadDays: 365 });
assert.deepStrictEqual(days("400", "100"), { followSlowDays: 400, followDeadDays: 401 });
assert.deepStrictEqual(days("99999", "1"), { followSlowDays: 3650, followDeadDays: 3651 });

console.log("options selftest: all passed");
