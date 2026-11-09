// node extension/agent-sites/registry.selftest.js
// load(...files) runs registry.js and the named site files in a fresh vm and returns its MdgAgentSites; each site's
// selftest uses it. Run directly, it checks the registry itself.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

function load(...files) {
  const ctx = vm.createContext({ URL });
  for (const f of ["registry.js", ...files]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, { filename: f });
  return ctx.MdgAgentSites;
}
module.exports = { load };

if (require.main === module) {
  const S = load();
  const site = { id: "demo", origins: ["https://demo.test/*"], key: (u) => (u.hostname === "demo.test" ? `${u.pathname.slice(1)}:` : null), read: "content" };
  S.register(site);
  assert.strictEqual(S.keyOf("https://demo.test/abc"), "demo:abc:", "the registry prefixes the id");
  assert.strictEqual(S.keyOf("http://demo.test/abc"), "demo:abc:");
  for (const href of ["ftp://demo.test/abc", "javascript:alert(1)", "not a url", "https://other.test/abc"]) assert.strictEqual(S.keyOf(href), null, href);
  assert.strictEqual(S.get("demo"), site);
  assert.strictEqual(S.get("nope"), null);
  assert.strictEqual(S.get("__proto__"), null);
  assert.deepStrictEqual(Array.from(S.list(), (s) => s.id), ["demo"]);
  // Refused: a duplicate, an id that would split keys, a missing part, a read that is neither "content" nor a function.
  for (const bad of [site, { ...site, id: "a:b" }, { ...site, id: "x", origins: [] }, { ...site, id: "x", key: null }, { ...site, id: "x", read: "main" }, null]) {
    assert.throws(() => S.register(bad), /MdgAgentSites/);
  }
  assert.strictEqual(S.list().length, 1);
  assert.strictEqual(S.keyOf("https://demo.test/abc"), "demo:abc:");
  assert.strictEqual(S.keyOf("https://other.test/abc"), null);

  // Every site's function read compiles the way chrome.scripting.executeScript builds it: "(" + its source + ")".
  // Method shorthand (read(url) {}) does not, and fails only in Chrome.
  const { runtimes } = require("../page-sources.selftest.js");
  const worker = runtimes.find((r) => r.where === "background.js").files;
  const all = load(...worker.filter((f) => f.startsWith("agent-sites/") && f !== "agent-sites/registry.js").map((f) => f.slice("agent-sites/".length)));
  const reads = all.list().filter((s) => typeof s.read === "function");
  for (const s of reads) assert.doesNotThrow(() => new vm.Script(`(${s.read.toString()})`), `${s.id}'s read`);
  console.log("agent-sites registry selftest ok");
}
