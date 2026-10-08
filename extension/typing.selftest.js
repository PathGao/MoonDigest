// node extension/typing.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const docL = {};
const ctx = vm.createContext({ setTimeout, clearTimeout, document: { addEventListener: (t, f, c) => (docL[t] ||= []).push({ f, c }) } });
const src = fs.readFileSync(path.join(__dirname, "typing.js"), "utf8");
vm.runInContext(src, ctx);
const T = ctx.BocTyping;
vm.runInContext(src, ctx);
assert.strictEqual(ctx.BocTyping, T, "a second load keeps the first");

assert.ok(T.composing({ isComposing: true, key: "Enter" }));
assert.ok(T.composing({ isComposing: false, keyCode: 229, key: "Enter" }), "keyCode 229 alone also counts");
assert.ok(!T.composing({ isComposing: false, keyCode: 13, key: "Enter" }));

const node = (tag, extra = {}) => ({ closest: (s) => (s.split(", ").includes(tag) ? {} : null), ...extra });
assert.ok(T.typingIn({ target: node("input") }));
assert.ok(T.typingIn({ target: node("div", { isContentEditable: true }) }));
assert.ok(!T.typingIn({ target: node("button") }));
// A shadow-root text field: the event is retargeted to the host, composedPath()[0] is the field.
assert.ok(T.typingIn({ target: node("div"), composedPath: () => [node("textarea"), node("div")] }));

// The document-level composition flag, tracked in the capture phase (before any page handler).
assert.ok(docL.compositionstart[0].c && docL.compositionend[0].c);
assert.strictEqual(T.isComposing(), false);
docL.compositionstart[0].f();
assert.strictEqual(T.isComposing(), true);
docL.compositionend[0].f();
assert.strictEqual(T.isComposing(), false);
// A <dialog>'s Esc cancel is held while composing (Chrome fires it when Esc reaches the page as keyCode 27), not otherwise.
const cancel = () => {
  const e = { prevented: false, preventDefault() { this.prevented = true; } };
  docL.cancel?.forEach(({ f }) => f(e));
  return e.prevented;
};
assert.strictEqual(cancel(), false);
docL.compositionstart[0].f();
assert.strictEqual(cancel(), true);
docL.compositionend[0].f();

// bindLive: nothing runs mid-composition, compositionend runs the committed text, a pending run dies on compositionstart.
(async () => {
  const ls = {};
  const input = { value: "", addEventListener: (t, f) => (ls[t] ||= []).push(f) };
  const fire = (t, e = {}) => ls[t].forEach((f) => f(e));
  const wait = () => new Promise((r) => setTimeout(r, 20));
  const ran = [];
  T.bindLive(input, (v) => ran.push(v), 0);
  fire("compositionstart");
  input.value = "zhong";
  fire("input", { isComposing: true });
  await wait();
  assert.deepStrictEqual(ran, [], "no run while composing");
  input.value = "中";
  fire("compositionend");
  await wait();
  assert.deepStrictEqual(ran, ["中"]);
  input.value = "中a";
  fire("input", { isComposing: false });
  fire("compositionstart");
  await wait();
  assert.deepStrictEqual(ran, ["中"], "a pending run is dropped when composition starts");
  console.log("typing selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
