// /usr/local/bin/node extension/messages.selftest.js
// Holds the code to the message list (messages.js, MdgMessages). A convention check over the shipped source, not a
// behavior test (AGENTS「用检查代替反复扫描」). It matches the public contract only: message types (kebab-case strings
// in a type position), field names and the files named in the list. Fails when:
//   1. a type is sent ({ type: "x" … }) or handled (type === "x", a handler map's "x": key) but not listed;
//   2. a listed type has no handler in its `to` file, or a file sends it that is not in `from` (or `from` names a
//      file that never mentions it);
//   3. a sender passes a field the entry does not list;
//   4. a listed request field is not read by the handler (its branch, and the functions it hands the message to);
//   5. a builder returns other fields than the entry's payload, or a payload field is read nowhere else.
//   6. a triageListen's web types (what a content script may send it) differ from the types its table's file answers
//      that a content script (manifest.json) sends: one missing breaks that page, one extra lets a web page in.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = __dirname;
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!/^dev/.test(e.name)) walk(rel);
    } else if (e.name.endsWith(".js") && !e.name.endsWith(".selftest.js") && rel !== "messages.js") files.push(rel);
  }
})(".");
// Comments out, strings kept (field names and types live in them), same offsets.
const blank = (s) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'`\\])\/\/.*$/gm, (m, pre = "") => pre + m.slice(pre.length).replace(/[^\n]/g, " "));
const src = Object.fromEntries(files.map((f) => [f, blank(read(f))]));

const ctx = vm.createContext({});
ctx.globalThis = ctx;
vm.runInContext(read("messages.js"), ctx);
const M = ctx.MdgMessages;

const TYPE = "[a-z]+(?:-[a-z]+)+";
const lineOf = (f, i) => `${f}:${src[f].slice(0, i).split("\n").length}`;

// From an opening bracket at i, the index of its closing one (strings and template literals skipped whole).
function closeOf(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === "`") {
      for (j++; j < s.length && s[j] !== c; j++) if (s[j] === "\\") j++;
    } else if ("{([".includes(c)) depth++;
    else if ("})]".includes(c) && --depth === 0) return j;
  }
  return s.length;
}
// The { of the innermost object or block around i (an open ( or [ in between is stepped over), or -1.
function openBefore(s, i) {
  let depth = 0;
  for (let j = i; j >= 0; j--) {
    const c = s[j];
    if ("})]".includes(c)) depth++;
    else if ("{([".includes(c)) {
      if (depth === 0 && c === "{") return j;
      if (depth > 0) depth--;
    }
  }
  return -1;
}
// An object literal's top-level keys; a spread of an inline literal (...(x && { a })) gives its keys, any other spread "...".
function keysOf(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (c === '"' || c === "'" || c === "`") {
      for (j++; j < body.length && body[j] !== c; j++) if (body[j] === "\\") j++;
    } else if ("{([".includes(c)) depth++;
    else if ("})]".includes(c)) depth--;
    else if (c === "," && depth === 0) parts.push(body.slice(start, j)), (start = j + 1);
  }
  parts.push(body.slice(start));
  return parts.flatMap((p) => {
    const t = p.trim();
    let m;
    if (!t) return [];
    if (t.startsWith("...")) {
      const at = t.indexOf("{");
      return at < 0 ? ["..."] : keysOf(t.slice(at + 1, closeOf(t, at)));
    }
    if ((m = /^["']?([\w$]+)["']?\s*:/.exec(t)) || (m = /^([\w$]+)$/.exec(t))) return [m[1]];
    return [`?${t.slice(0, 30)}`];
  });
}

const fails = [];
const fail = (msg) => fails.push(msg);

// Sends: { type: "x", … }. Handlers: type === / !== "x", and "x": in a handler map.
const sends = [];
const handlers = [];
for (const f of files) {
  const s = src[f];
  for (const m of s.matchAll(new RegExp(`\\btype:\\s*"(${TYPE})"`, "g"))) {
    const at = openBefore(s, m.index);
    sends.push({ type: m[1], f, at: m.index, keys: keysOf(s.slice(at + 1, closeOf(s, at))).filter((k) => k !== "type") });
  }
  for (const m of s.matchAll(new RegExp(`([\\w$]+)\\??\\.type\\s*[!=]==\\s*"(${TYPE})"`, "g"))) handlers.push({ type: m[2], f, at: m.index, param: m[1] });
  for (const m of s.matchAll(new RegExp(`(?:^|[{,])\\s*"(${TYPE})"\\s*:\\s*(async\\s+)?(?:\\(([\\w$]*)|([\\w$]+)(?=\\s*[,\\n}]))`, "gm"))) {
    handlers.push({ type: m[1], f, at: m.index, param: m[3] || "", fn: m[4] || "" });
  }
}

// 1. Every type in a type position is listed.
for (const x of [...sends, ...handlers]) if (!M[x.type]) fail(`${lineOf(x.f, x.at)}: "${x.type}" is not in messages.js`);

// Functions by name, anywhere: function f(p…) and const f = (async) (p…) =>.
const fnAt = {};
for (const f of files) {
  for (const m of src[f].matchAll(/(?:^|[^\w$.])(?:async\s+)?function\s+([\w$]+)\s*\(|(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?\(/g)) {
    const name = m[1] || m[2];
    if (!fnAt[name]) fnAt[name] = { f, at: m.index + m[0].indexOf(name) };
  }
}
// A function's text from its name to the end of its body, and its first parameter when that is a plain name.
function fnText(name) {
  const def = fnAt[name];
  if (!def) return null;
  const s = src[def.f];
  const paren = s.indexOf("(", def.at);
  const params = s.slice(paren + 1, closeOf(s, paren));
  const brace = s.indexOf("{", closeOf(s, paren));
  const arrowBody = /^\s*=>\s*[^{\s]/.test(s.slice(closeOf(s, paren) + 1));
  const end = arrowBody ? s.indexOf("\n", paren) : closeOf(s, brace);
  return { text: s.slice(def.at, end + 1), param: /^\s*([\w$]+)\s*(?:=[^,]*)?(?:,|$)/.exec(params)?.[1] || "" };
}
// A handler's text: from its match to the next handler in that file or the end of the enclosing block, plus every
// function it hands the message to (f(msg), a map's "x": f), and theirs.
function handlerText(h) {
  const s = src[h.f];
  // Types named on the handler's own line share its branch (if (type === "a" || type === "b")).
  const line = (at) => s.slice(0, at).split("\n").length;
  const group = new Set(handlers.filter((o) => o.f === h.f && line(o.at) === line(h.at)).map((o) => o.type));
  const next = Math.min(...handlers.filter((o) => o.f === h.f && o.at > h.at && !group.has(o.type)).map((o) => o.at), closeOf(s, openBefore(s, h.at)));
  let text = s.slice(h.at, next);
  const seen = new Set();
  const follow = (body, param, depth) => {
    const names = [];
    if (param) for (const m of body.matchAll(new RegExp(`([\\w$]+)\\(\\s*${param.replace(/\$/g, "\\$")}\\s*[,)]`, "g"))) names.push(m[1]);
    for (const name of names) {
      if (seen.has(name) || depth > 3) continue;
      seen.add(name);
      const fn = fnText(name);
      if (!fn) continue;
      text += "\n" + fn.text;
      follow(fn.text, fn.param, depth + 1);
    }
  };
  if (h.fn) {
    seen.add(h.fn);
    const fn = fnText(h.fn);
    if (fn) (text += "\n" + fn.text), follow(fn.text, fn.param, 1);
  }
  follow(text, h.param, 0);
  return text;
}

for (const [type, e] of Object.entries(M)) {
  // 2. Handled in `to`; senders match `from`.
  const hs = handlers.filter((h) => h.type === type && h.f === e.to);
  if (!hs.length) fail(`${type}: no handler in ${e.to}`);
  for (const h of handlers.filter((h) => h.type === type && h.f !== e.to)) fail(`${lineOf(h.f, h.at)}: handles ${type}, but messages.js says ${e.to}`);
  const senders = sends.filter((x) => x.type === type);
  for (const x of senders) if (!e.from.includes(x.f)) fail(`${lineOf(x.f, x.at)}: sends ${type}, not in its from`);
  for (const f of e.from) if (!src[f]?.includes(`"${type}"`)) fail(`${type}: from lists ${f}, which never names it`);
  if (e.open) continue;
  // 3. Fields a sender passes are listed.
  for (const x of senders) {
    for (const k of x.keys) if (!e.request.includes(k)) fail(`${lineOf(x.f, x.at)}: ${type} passes ${k}, not in its request`);
  }
  // 4. Listed fields are read by the handler.
  const text = hs.map(handlerText).join("\n").replace(`"${type}"`, "");
  for (const k of e.request) if (!new RegExp(`(?<![\\w$])${k}(?![\\w$])`).test(text)) fail(`${type}: the handler in ${e.to} never reads ${k}`);
}

// 5. A builder returns exactly its payload, and each payload field is read somewhere else.
for (const [type, e] of Object.entries(M)) {
  if (!e.builder) continue;
  const [f, name] = e.builder.split(":");
  const fn = fnText(name);
  if (!fn || fnAt[name].f !== f) {
    fail(`${type}: builder ${e.builder} not found`);
    continue;
  }
  const at = fn.text.lastIndexOf("return {");
  let keys = keysOf(fn.text.slice(at + 8, closeOf(fn.text, at + 7)));
  if (keys.includes("payload")) {
    const p = fn.text.indexOf("payload:", at);
    const o = fn.text.indexOf("{", p);
    keys = keysOf(fn.text.slice(o + 1, closeOf(fn.text, o)));
  }
  for (const k of keys) if (!e.payload.includes(k)) fail(`${e.builder} returns ${k}, not in ${type}'s payload`);
  for (const k of e.payload) {
    if (!keys.includes(k)) fail(`${type}: payload lists ${k}, ${e.builder} does not return it`);
    const re = new RegExp(`(?<![\\w$])${k}(?![\\w$])`);
    if (!files.some((g) => g !== f && re.test(src[g]))) fail(`${type}: payload field ${k} is read nowhere outside ${f}`);
  }
}

// 6. Each triageListen(prefix, HANDLERS, web types) against the list: the types of the file that defines HANDLERS that a
// content script sends. The web types are an array literal there or a const array (obsidian.js's, registered by background.js).
// NOT_FROM_WEB: types a content-script file sends only from extension pages, and why.
const NOT_FROM_WEB = { "export-note": "note-actions.js sends it for 复制 / 下载; the video page (content.js) only writes" };
const contentScripts = new Set(JSON.parse(read("manifest.json")).content_scripts.flatMap((g) => g.js).map(path.normalize));
const definer = (name, open) => files.find((g) => new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*\\${open}`).test(src[g]));
for (const f of files) {
  for (const m of src[f].matchAll(/(?<!function\s+)triageListen\(\s*([^,]+),\s*([\w$]+),\s*(\[[^\]]*\]|[\w$]+)/g)) {
    const prefix = /^"([^"]*)"$/.exec(m[1].trim())?.[1];
    const owner = definer(m[2], "{");
    const arr = m[3].startsWith("[") ? m[3] : new RegExp(`(?:const|let)\\s+${m[3]}\\s*=\\s*(\\[[^\\]]*\\])`).exec(src[definer(m[3], "[")] || "")?.[1] || "";
    const listed = [...arr.matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    const want = Object.entries(M)
      .filter(([type, e]) => e.to === owner && (!prefix || type.startsWith(prefix)) && !NOT_FROM_WEB[type] && e.from.some((x) => contentScripts.has(x)))
      .map(([type]) => type)
      .sort();
    if (!owner) fail(`${lineOf(f, m.index)}: ${m[2]} is defined nowhere`);
    else if (listed.join() !== want.join()) fail(`${lineOf(f, m.index)}: web types ${listed.join(", ")}; content scripts send ${want.join(", ")}`);
  }
}
for (const [type, why] of Object.entries(NOT_FROM_WEB)) if (!M[type]?.from.some((x) => contentScripts.has(x))) fail(`NOT_FROM_WEB ${type}: no content script sends it any more (${why})`);

if (fails.length) {
  console.error(`messages selftest: ${fails.length} problem(s)\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
console.log(`messages selftest ok (${Object.keys(M).length} types, ${sends.length} sends, ${handlers.length} handlers)`);
