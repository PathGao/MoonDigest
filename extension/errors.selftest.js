// /usr/local/bin/node extension/errors.selftest.js
// BocErrors' helpers, and every context that reads BocErrors loads errors.js first (a missing registration has
// broken the product before: 7305476).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
const requested = [];
const ctx = vm.createContext({ chrome: { permissions: { request: async (p) => (requested.push(p), true) } } });
ctx.globalThis = ctx;
vm.runInContext(read("errors.js"), ctx);
vm.runInContext(read("errors.js"), ctx); // re-injection keeps the first copy
const E = ctx.BocErrors;

(async () => {
  assert.strictEqual(E.action("AI_AUTH"), "settings");
  assert.strictEqual(E.action("OBSIDIAN"), "settings");
  assert.strictEqual(E.action("NOT_LOGGED_IN"), "login");
  assert.strictEqual(E.action(-101), "login");
  assert.strictEqual(E.action("AI_NETWORK"), "none");
  assert.strictEqual(E.action("OBSIDIAN_DOWN"), "none", "a closed Obsidian is not fixed in the settings page");
  assert.strictEqual(E.action(undefined), "none");
  assert.strictEqual(E.text({ ok: false, code: 62004, error: "B站返回 62004：稿件审核中" }), "视频审核中，过后再试");
  assert.strictEqual(E.text({ ok: false, error: "  笔记内容为空 " }, "x"), "笔记内容为空");
  assert.strictEqual(E.text({ ok: false, error: { a: 1 } }, "生成视频笔记失败"), "生成视频笔记失败");
  assert.strictEqual(E.text(undefined, "x"), "x");
  const err = E.fromResp({ ok: false, error: E.TEXT.obsidianKey, code: "OBSIDIAN" }, "Local API 写入失败");
  assert.strictEqual(err.message, E.TEXT.obsidianKey);
  assert.strictEqual(err.action, "settings");
  assert.strictEqual(E.fromResp({ ok: false, error: "Obsidian 返回 HTTP 500" }, "x").action, "none");

  assert.strictEqual(E.grantOrigin("AI 平台的 API Key 无效或没有权限"), null);
  const access = E.grantOrigin("未授权访问 https://api.example.com，授权后重试");
  assert.strictEqual(access.origin, "https://api.example.com");
  assert.strictEqual(await access.request(), true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(requested)), [{ origins: ["https://api.example.com/*"] }]);

  assert.ok(E.reloaded(new Error("Extension context invalidated.")));
  assert.ok(!E.reloaded(new Error("Failed to fetch")));

  // Registration: each list of scripts that reads BocErrors loads errors.js before the first reader.
  const uses = (file) => file !== "errors.js" && /\bBocErrors\b/.test(read(file));
  const checkOrder = (where, files) => {
    const first = files.findIndex(uses);
    if (first >= 0) assert.ok(files.indexOf("errors.js") >= 0 && files.indexOf("errors.js") < first, `${where} loads errors.js before ${files[first]}`);
    return first >= 0;
  };
  const manifest = JSON.parse(read("manifest.json"));
  let readers = 0;
  manifest.content_scripts.forEach((entry, i) => (readers += checkOrder(`content_scripts[${i}]`, entry.js)));
  // The worker runs the first importScripts list before background.js's own top level, so errors.js belongs there.
  const calls = [...read("background.js").matchAll(/importScripts\(([^)]*)\)/g)].map((m) => m[1].match(/"[^"]+"/g).map((f) => JSON.parse(f)));
  readers += checkOrder("background importScripts", [...calls[0], "background.js", ...calls.slice(1).flat()]);
  const pages = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(path.join(__dirname, dir))) {
      const rel = path.join(dir, name);
      if (fs.statSync(path.join(__dirname, rel)).isDirectory()) walk(rel);
      else if (name.endsWith(".html")) pages.push(rel);
    }
  };
  walk(".");
  for (const page of pages) {
    const scripts = [...read(page).matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => path.normalize(path.join(path.dirname(page), m[1])));
    readers += checkOrder(page, scripts.filter((f) => fs.existsSync(path.join(__dirname, f))));
  }
  assert.ok(readers >= 6, `found ${readers} readers of BocErrors`);

  // The sentences live only in errors.js; badges.js (it does not load errors.js) keeps one exact copy.
  assert.ok(read("badges.js").includes(`"${E.TEXT.reloaded}"`), "badges.js shows BocErrors.TEXT.reloaded word for word");
  const sources = ["background.js", "content.js", "sidepanel.js", "popup.js", "history/history.js", "triage/triage.js", "triage/triage-bg.js", "triage/follow.js"];
  for (const sentence of [...Object.values(E.TEXT), "视频审核中"]) {
    for (const file of sources) assert.ok(!read(file).includes(sentence), `${file} writes 「${sentence}」 itself`);
  }
  console.log("errors selftest ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
