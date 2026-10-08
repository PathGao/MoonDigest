// node extension/triage/shared.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "shared.js"), "utf8"), ctx);
const UI = ctx.TriageUi;

// 「今天 / 昨天 / 10月5日 HH:MM 刷新过」, by calendar day, not by 24 hours.
{
  const now = new Date(2026, 9, 8, 0, 30).getTime();
  assert.strictEqual(UI.syncedText(0, now), "");
  assert.strictEqual(UI.syncedText(new Date(2026, 9, 8, 0, 5).getTime(), now), "今天 00:05 刷新过");
  assert.strictEqual(UI.syncedText(new Date(2026, 9, 7, 23, 59).getTime(), now), "昨天 23:59 刷新过", "an hour ago but before midnight");
  assert.strictEqual(UI.syncedText(new Date(2026, 9, 5, 17, 25).getTime(), now), "10月5日 17:25 刷新过");
}

// A 0 count stays and is dimmed; no count (null) is not 0.
{
  assert.ok(UI.filterBtn('data-x="a"', "全部", 0, false).includes('class="zero">全部 0<'));
  assert.ok(!UI.filterBtn('data-x="a"', "全部", 3, true).includes("zero"));
  assert.ok(!UI.filterBtn('data-x="a"', "全部", null, false).includes("zero") && UI.filterBtn('data-x="a"', "全部", null, false).includes(">全部</button>"));
  assert.ok(UI.filterBtn('data-x="a"', "<b>", 1, false).includes("&lt;b&gt; 1"), "labels are escaped");
}

// Row 1's meta keeps the error after the parts; empty parts drop out.
assert.strictEqual(UI.headMeta(["今天 10:00 刷新过", 0, "2 个已失效"], ""), "今天 10:00 刷新过 · 2 个已失效");
assert.strictEqual(UI.headMeta(["a"], "出错了"), 'a · <span class="fail-text">出错了</span>');
assert.strictEqual(UI.resultCount("  ", 5), "");
assert.strictEqual(UI.resultCount("x", 5), "5 个结果");

// The sort control marks the open sort and says the direction in words.
{
  const html = UI.sortControl({ sorts: { a: "甲", b: "乙" }, sort: "b", dir: "asc", words: "A→Z", selectAttr: "data-s", dirAttr: "data-d" });
  assert.ok(html.includes('<option value="b" selected>乙') && !html.includes('value="a" selected') && html.includes('aria-label="排序方向：A→Z"'));
}

console.log("shared selftest: all passed");
