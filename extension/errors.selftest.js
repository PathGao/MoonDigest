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

  // HTML escaping: all five characters, so text is inert in content and in either kind of quoted attribute.
  assert.strictEqual(E.escapeHtml(`<img src=x onerror=alert(1)>"'&`), "&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;");
  assert.strictEqual(E.escapeHtml("&lt;"), "&amp;lt;", "already-escaped text is escaped again, shown as typed");
  assert.deepStrictEqual([E.escapeHtml(null), E.escapeHtml(undefined), E.escapeHtml(0)], ["", "", "0"]);
  // Written once: no other script escapes HTML itself (a weaker copy once skipped > and ').
  const scripts = [];
  const walkJs = (dir) => {
    for (const name of fs.readdirSync(path.join(__dirname, dir))) {
      const rel = path.join(dir, name);
      if (fs.statSync(path.join(__dirname, rel)).isDirectory()) name !== "dev" && walkJs(rel);
      else if (name.endsWith(".js") && !name.endsWith(".selftest.js") && rel !== "errors.js") scripts.push(rel);
    }
  };
  walkJs(".");
  for (const file of scripts) assert.ok(!/["'`]&(lt|gt|quot|#39|#60);["'`]\)|&#\$\{/.test(read(file)), `${file} escapes HTML itself; use BocErrors.escapeHtml`);

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
