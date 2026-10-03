// node extension/obsidian-sync.selftest.js
// Drives background.js's Obsidian handlers against a fake Local REST API that records every GET/PUT.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");
const assert = require("assert");

const vault = new Map();
const log = [];
const server = http.createServer((req, res) => {
  const file = decodeURIComponent(req.url.replace(/^\/vault\//, ""));
  log.push(`${req.method} ${file}`);
  if (req.headers.authorization !== "Bearer k") {
    res.writeHead(401).end();
    return;
  }
  if (req.method === "GET") {
    if (!vault.has(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/markdown" }).end(vault.get(file));
    return;
  }
  if (req.method === "PUT") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      vault.set(file, body);
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(405).end();
});

const local = {};
const sync = {};
const area = (store) => ({
  async get(keys) {
    if (keys == null) return structuredClone(store);
    if (typeof keys === "object" && !Array.isArray(keys)) return { ...keys, ...structuredClone(store) };
    return Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
  },
  async set(items) {
    Object.assign(store, structuredClone(items));
  },
  async remove(keys) {
    for (const k of [].concat(keys)) delete store[k];
  }
});
let onMessage;
const noop = new Proxy(function () {}, { get: () => noop, apply: () => noop });
const chrome = {
  runtime: { onInstalled: { addListener() {} }, onConnect: { addListener() {} }, onMessage: { addListener: (fn) => (onMessage = fn) }, getManifest: () => ({ version: "test" }) },
  storage: { local: area(local), sync: area(sync), onChanged: { addListener() {} } },
  permissions: noop,
  tabs: noop,
  sidePanel: noop,
  declarativeNetRequest: noop
};
const ctx = vm.createContext({ chrome, console, fetch, setTimeout, clearTimeout, AbortSignal, AbortController, TextDecoder, TextEncoder, URL, URLSearchParams, Headers, importScripts() {} });
for (const file of ["limits.js", "sites.js", "note.js", "background.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), ctx);
}
const N = ctx.BocNote;
// Responses are vm-realm objects, so they come back through JSON for deepStrictEqual.
const send = (message) => new Promise((resolve) => onMessage(message, {}, (resp) => resolve(JSON.parse(JSON.stringify(resp)))));

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const auth = { baseUrl, apiKey: "k" };
  const filepath = "Clippings/bilibili/2026-10-03-测试.md";
  const noteKey = "video:bilibili:BV1|c1";
  const turn1 = [{ prompt: "总结", answer: "答一" }];
  const turn2 = [...turn1, { prompt: "追问", answer: "答二" }];
  const bodyMd = "---\ntitle: \"测试\"\n---\n\n## 字幕\n\n`00:00` 你好";

  // 1. First manual save creates the note with the section and binds the video to the path.
  const first = N.upsertAiSection(bodyMd, N.buildAiSection(turn1));
  assert.deepStrictEqual(await send({ type: "write-obsidian-note", ...auth, filepath, content: first, noteKey }), { ok: true });
  assert.strictEqual(vault.get(filepath), first);
  assert.strictEqual(local[ctx.BocLimits.KEYS.obsidianNotePaths][noteKey].path, filepath, "manual save binds the video to its note");
  assert.deepStrictEqual(log.splice(0), [`PUT ${filepath}`]);

  // 2. The user edits around the section; a follow-up answer updates only the marked block.
  const edited = `${vault.get(filepath).replace("你好", "你好（我改的）")}\n\n我的后记\n`;
  vault.set(filepath, edited);
  const section2 = N.buildAiSection(turn2);
  let resp = await send({ type: "update-obsidian-ai-section", ...auth, filepath, section: section2, noteKey });
  assert.deepStrictEqual(resp, { ok: true, exists: true, updated: true });
  assert.deepStrictEqual(log.splice(0), [`GET ${filepath}`, `PUT ${filepath}`], "one GET and exactly one PUT");
  const [beforeOld, afterOld] = [edited.slice(0, edited.indexOf(N.AI_SECTION_START)), edited.slice(edited.indexOf(N.AI_SECTION_END) + N.AI_SECTION_END.length)];
  assert.strictEqual(vault.get(filepath), `${beforeOld}${section2}${afterOld}`, "bytes outside the markers are untouched");
  assert.ok(vault.get(filepath).includes("你好（我改的）") && vault.get(filepath).includes("我的后记"));

  // 3. Idempotent: the same section again costs a GET and no PUT.
  resp = await send({ type: "update-obsidian-ai-section", ...auth, filepath, section: section2, noteKey });
  assert.deepStrictEqual(resp, { ok: true, exists: true, updated: false });
  assert.deepStrictEqual(log.splice(0), [`GET ${filepath}`]);

  // 4. A note that was never saved is never created; the binding (if any) is dropped.
  const missing = "Clippings/bilibili/never-saved.md";
  local[ctx.BocLimits.KEYS.obsidianNotePaths]["video:bilibili:BV2|"] = { path: missing, lastSyncedAt: 1 };
  resp = await send({ type: "update-obsidian-ai-section", ...auth, filepath: missing, section: section2, noteKey: "video:bilibili:BV2|" });
  assert.deepStrictEqual(resp, { ok: true, exists: false, updated: false });
  assert.deepStrictEqual(log.splice(0), [`GET ${missing}`], "zero writes for an unsaved video");
  assert.ok(!vault.has(missing));
  assert.ok(!("video:bilibili:BV2|" in local[ctx.BocLimits.KEYS.obsidianNotePaths]), "404 clears the binding");
  assert.ok(noteKey in local[ctx.BocLimits.KEYS.obsidianNotePaths], "other bindings stay");

  // 5. Obsidian down: the handler reports an error and the vault keeps what it had.
  const snapshot = vault.get(filepath);
  await new Promise((resolve) => server.close(resolve));
  resp = await send({ type: "update-obsidian-ai-section", ...auth, filepath, section: N.buildAiSection([{ prompt: "x", answer: "y" }]), noteKey });
  assert.strictEqual(resp.ok, false);
  assert.ok(resp.error, "error names the failure for the retry status");
  assert.strictEqual(vault.get(filepath), snapshot);
  assert.strictEqual(local[ctx.BocLimits.KEYS.obsidianNotePaths][noteKey].path, filepath, "a failed sync keeps the binding for retry");

  console.log("obsidian sync selftest ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
