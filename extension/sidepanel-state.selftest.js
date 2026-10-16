// /usr/local/bin/node extension/sidepanel-state.selftest.js
// The side panel's conversation rules (sidepanel-state.js), driven by events alone: no DOM, no chrome.*.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({ console, URL });
ctx.globalThis = ctx;
for (const f of ["limits.js", "errors.js", "sites.js", "sidepanel-state.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
const S = ctx.SidepanelState;
const plain = (value) => JSON.parse(JSON.stringify(value));
const types = (effects) => [...effects].map((e) => e.type);

const v = (id) => `https://www.bilibili.com/video/${id}/`;
const video = (id, extra) => ({ url: v(id), title: `t-${id}`, site: "bilibili", videoId: id, cid: `c-${id}`, isVideoContext: true, subtitleMarkdown: "s", ...extra });
const web = { url: "https://example.com/a", title: "web", isVideoContext: false };
const saved = (id, ctxt, messages = [{ role: "user", content: `q-${id}` }, { role: "assistant", content: `a-${id}` }], updatedAt = 1) => ({
  id,
  title: ctxt.title,
  contextTitle: ctxt.title,
  contextUrl: ctxt.url,
  contextRef: S.buildConversationContextRef(ctxt),
  isVideoContext: ctxt.isVideoContext !== false,
  createdAt: updatedAt,
  updatedAt,
  messages
});

// A panel that has read its first tab, as init does.
function panel({ tab = video("BV1aa"), list = [] } = {}) {
  const p = S.create();
  p.dispatch({ type: "SAVED_CHANGED", list });
  p.load = (payload, { follow = false, tabUrl = payload?.url, title = payload?.title } = {}) => [
    ...p.dispatch({ type: "TAB_READ", tab: { url: tabUrl, title }, follow }),
    ...p.dispatch({ type: "CONTEXT_ARRIVED", payload, follow })
  ];
  p.ask = (prompt, raw) => (p.dispatch({ type: "SEND", prompt }), raw === undefined ? [] : p.dispatch({ type: "STREAM_ENDED", raw }));
  if (tab) p.load(tab, { follow: true });
  return p;
}

// ---- following (decideFollow): the table from #244, unchanged ----
{
  const web = "https://example.com/home";
  const fresh = { shownUrl: web, hasMessages: false, bound: false, lastVideoUrl: "", hasContext: true };
  const pinnedEmpty = { shownUrl: v("BV1vv"), hasMessages: false, bound: true, lastVideoUrl: v("BV1ee"), hasContext: true };
  const history = { shownUrl: v("BV1hh"), hasMessages: true, bound: true, lastVideoUrl: v("BV1ee"), hasContext: true };
  const at = (state, ev) => plain(S.decideFollow(state, { stage: "payload", follow: true, keyChanged: true, ...ev }));
  const table = [
    ["first video after a web page", fresh, { toUrl: v("BV1aa") }, "follow", v("BV1aa")],
    ["the video already shown", { ...fresh, shownUrl: v("BV1aa"), lastVideoUrl: v("BV1aa") }, { toUrl: v("BV1aa"), keyChanged: false }, "adopt", v("BV1aa")],
    ["empty 问 AI conversation, back to the video tab", pinnedEmpty, { toUrl: v("BV1ee") }, "follow", v("BV1ee")],
    ["an opened history conversation stays", history, { toUrl: v("BV1ff") }, "keep", v("BV1ff")],
    ["no video played before", { ...history, lastVideoUrl: "" }, { toUrl: v("BV1ff") }, "keep", v("BV1ff")],
    ["the conversation of the video just played", { ...history, lastVideoUrl: v("BV1hh") }, { toUrl: v("BV1ff") }, "follow", v("BV1ff")],
    // Any load that finds an unbound conversation on another video follows, not only a tab event.
    ["send, refresh or chip click on another video", { ...fresh, shownUrl: v("BV1aa") }, { toUrl: v("BV1bb"), follow: false }, "follow", v("BV1bb")],
    ["a web page is adopted, not followed", { ...fresh, shownUrl: v("BV1aa") }, { toUrl: "", follow: false }, "adopt", ""],
    // The panel's first load takes the tab without the AI 总结 fill.
    ["first load", { ...fresh, shownUrl: "", hasContext: false }, { toUrl: v("BV1aa") }, "adopt", v("BV1aa")],
    ["first load, not a tab event", { ...fresh, shownUrl: "", hasContext: false }, { toUrl: v("BV1aa"), follow: false }, "adopt", v("BV1aa")],
    // A load that leaves a bound conversation in place does not move lastVideoUrl, so the follow load after it still
    // sees the tab leave the video just played.
    ["non-follow load does not advance", { ...history, lastVideoUrl: v("BV1hh") }, { toUrl: v("BV1ff"), follow: false }, "keep", v("BV1hh")]
  ];
  for (const [name, state, ev, action, last] of table) assert.deepStrictEqual(at(state, ev), { action, lastVideoUrl: last }, name);
  // The tab stage acts on the tab URL alone, except a watch-later part (named by oid) and the first load.
  const tab = (state, ev) => plain(S.decideFollow(state, { stage: "tab", follow: true, oid: false, ...ev }));
  assert.deepStrictEqual(tab(fresh, { toUrl: v("BV1aa") }), { action: "follow", lastVideoUrl: v("BV1aa") });
  assert.deepStrictEqual(tab(fresh, { toUrl: v("BV1aa"), oid: true }), { action: "none", lastVideoUrl: "" }, "oid");
  assert.deepStrictEqual(tab({ ...fresh, hasContext: false }, { toUrl: v("BV1aa") }), { action: "none", lastVideoUrl: "" }, "first load");
  assert.deepStrictEqual(tab(fresh, { toUrl: v("BV1aa"), follow: false }), { action: "none", lastVideoUrl: "" }, "not a tab event");
}

// ---- following, through the events ----
{
  // The first load adopts the tab: no follow, no AI 总结 fill, and lastVideoUrl takes the tab's video.
  const p = S.create();
  const first = [...p.dispatch({ type: "TAB_READ", tab: { url: v("BV1aa"), title: "a" }, follow: true }), ...p.dispatch({ type: "CONTEXT_ARRIVED", payload: video("BV1aa"), follow: true })];
  assert.ok(!types(first).includes("followed"), "first load adopts");
  assert.strictEqual(p.view().live.lastVideoUrl, v("BV1aa"));
  assert.deepStrictEqual(types(p.dispatch({ type: "SUMMARY_SHOWN", prompt: "总结" })), [], "first load does not fill");

  // A tab switch follows at the tab URL: a pending placeholder named from the tab title until the payload fills it.
  const atTab = p.dispatch({ type: "TAB_READ", tab: { url: v("BV1bb"), title: "新视频_哔哩哔哩_bilibili" }, follow: true });
  assert.ok(types(atTab).includes("followed"));
  assert.deepStrictEqual([p.view().context.pending, p.view().context.title, p.view().context.url], [true, "新视频", v("BV1bb")]);
  // The fill is armed for this conversation; the page offers AI 总结 (SUMMARY_SHOWN) only once the context is there.
  assert.deepStrictEqual(types(p.dispatch({ type: "SUMMARY_SHOWN", prompt: "总结" })), ["fill"], "the fill is armed");
}
{
  // AI 总结 fills once, after following to an empty conversation, when its context is there; nothing else gets it.
  const p = panel();
  p.load(video("BV1bb"), { follow: true });
  assert.deepStrictEqual(plain(p.dispatch({ type: "SUMMARY_SHOWN", prompt: "总结" })), [{ type: "fill", prompt: "总结" }]);
  assert.deepStrictEqual(plain(p.dispatch({ type: "SUMMARY_SHOWN", prompt: "总结" })), [], "once");
  p.load(video("BV1cc"), { follow: true });
  p.dispatch({ type: "NEW" });
  assert.deepStrictEqual(plain(p.dispatch({ type: "SUMMARY_SHOWN", prompt: "总结" })), [], "a new conversation does not get it");
  p.load(video("BV1dd"), { follow: true });
  assert.deepStrictEqual(plain(p.dispatch({ type: "SUMMARY_SHOWN", prompt: "" })), [], "no prompt: still armed");
  assert.strictEqual(p.dispatch({ type: "SUMMARY_SHOWN", prompt: "总结" }).length, 1);
}
{
  // Following to a video with a saved conversation shows it (no fill); the conversation left becomes 上一个视频.
  const p = panel({ list: [saved("hb", video("BV1bb"))] });
  p.ask("问 a", "答 a");
  const left = p.view().id;
  const effects = p.load(video("BV1bb"), { follow: true });
  assert.deepStrictEqual([p.view().id, p.view().previousId], ["hb", left]);
  assert.ok(effects.some((e) => e.type === "previous" && e.id === left));
  assert.deepStrictEqual(plain(p.dispatch({ type: "SUMMARY_SHOWN", prompt: "总结" })), []);
  // A history conversation the user opened stays when the tab moves on; a load that is not a tab event does not
  // advance lastVideoUrl, so the next tab event still sees the tab leave the video just played.
  const q = panel({ list: [saved("h", video("BV1hh"))] });
  q.dispatch({ type: "OPEN", id: "h" });
  q.load(video("BV1ff"), { follow: true });
  assert.strictEqual(q.view().id, "h", "an opened history conversation stays");
  const r = panel({ tab: video("BV1hh"), list: [saved("h", video("BV1hh"))] });
  assert.strictEqual(r.view().id, "h");
  r.load(video("BV1ff"));
  assert.deepStrictEqual([r.view().id, r.view().live.lastVideoUrl], ["h", v("BV1hh")], "non-follow load keeps and does not advance");
  r.load(video("BV1ff"), { follow: true });
  assert.notStrictEqual(r.view().id, "h", "the follow load then leaves the video just played");
}
{
  // A send's context load (not a tab event) on an unbound conversation whose tab moved on follows the new video.
  const p = panel();
  assert.ok(types(p.load(video("BV1bb"))).includes("followed"));
  assert.strictEqual(p.view().context.url, v("BV1bb"));
}

// ---- the reply in flight ----
{
  // Leaving a conversation while the AI answers detaches the reply and keeps it: the question is saved now and the
  // answer lands after it. New, open, follow and AI 总结 all leave this way.
  for (const leave of [
    (p) => p.dispatch({ type: "NEW" }),
    (p) => p.dispatch({ type: "OPEN", id: "other" }),
    (p) => p.load(video("BV1bb"), { follow: true }),
    (p) => p.dispatch({ type: "SUMMARY", prompt: "总结", ref: S.buildConversationContextRef(video("BV1zz")) })
  ]) {
    const p = panel({ list: [saved("other", video("BV1oo"))] });
    p.ask("还在回答");
    const effects = leave(p);
    const detach = effects.find((e) => e.type === "detach");
    assert.ok(detach && !effects.some((e) => e.type === "dropStream"), String(leave));
    assert.strictEqual(p.view().streaming, false);
    const kept = p.view().saved.find((c) => c.id === detach.conversationId);
    assert.deepStrictEqual(plain(kept.messages), [{ role: "user", content: "还在回答" }]);
    assert.strictEqual(kept.contextUrl, v("BV1aa"), "saved with the context it was asked in");
    p.dispatch({ type: "REPLY_FINISHED", conversationId: detach.conversationId, promptIndex: detach.promptIndex, prompt: "还在回答", raw: "回答" });
    assert.deepStrictEqual(plain(p.view().saved.find((c) => c.id === detach.conversationId).messages).map((m) => m.content), ["还在回答", "回答"]);
  }
  // Reopened meanwhile: the shown conversation gets the answer too; nothing came back: the question goes.
  const p = panel();
  p.ask("q1");
  const detach = p.dispatch({ type: "NEW" }).find((e) => e.type === "detach");
  p.dispatch({ type: "OPEN", id: detach.conversationId });
  p.dispatch({ ...detach, type: "REPLY_FINISHED", prompt: "q1", raw: "" });
  assert.deepStrictEqual(plain(p.view().messages), []);
  // Delete drops the reply: only the shown conversation, and it does not come back.
  const d = panel({ list: [saved("x", video("BV1aa"))] });
  assert.strictEqual(d.view().id, "x");
  d.ask("q");
  assert.deepStrictEqual(types(d.dispatch({ type: "DELETED", id: "x" })), ["dropStream", "clearDraft", "save"]);
  assert.deepStrictEqual([d.view().id, d.view().streaming, d.view().saved.length], ["", false, 0]);
  // Deleting another one while streaming leaves the reply alone.
  const e = panel({ list: [saved("x", video("BV1aa")), saved("y", video("BV1yy"))] });
  e.ask("q");
  assert.deepStrictEqual(types(e.dispatch({ type: "DELETED", id: "y" })), ["save"]);
  assert.strictEqual(e.view().streaming, true);
  // An ended reply with an answer saves the conversation with the context it was asked in, even after the tab moved.
  const f = panel();
  f.ask("q");
  f.load(web, { follow: true });
  assert.strictEqual(f.view().context.url, v("BV1aa"), "a reply in flight keeps its context");
  assert.deepStrictEqual(types(f.dispatch({ type: "STREAM_ENDED", raw: "a" })), ["save", "autoSync"]);
  assert.deepStrictEqual([f.view().pinned.contextUrl, f.view().context.url, f.view().messages.length], [v("BV1aa"), v("BV1aa"), 2]);
  // 重试 removes the failed turn it replaces.
  f.dispatch({ type: "RETRY", prompt: "q", raw: "a", saved: true });
  assert.strictEqual(f.view().messages.length, 0);
}

// ---- the draft ----
{
  // The input draft belongs to the conversation: cleared whenever the target changes, kept within one conversation.
  const has = (effects) => effects.some((e) => e.type === "clearDraft");
  const p = panel({ list: [saved("h1", video("BV1h1")), saved("h2", video("BV1h2"))] });
  assert.ok(has(p.dispatch({ type: "OPEN", id: "h1" })), "open another");
  assert.ok(!has(p.dispatch({ type: "OPEN", id: "h1" })), "the same conversation again");
  assert.ok(has(p.dispatch({ type: "NEW" })), "new");
  assert.ok(has(p.load(video("BV1bb"), { follow: true })), "follow");
  p.dispatch({ type: "OPEN", id: "h2" });
  assert.ok(has(p.dispatch({ type: "DELETED", id: "h2" })), "delete the shown one");
  assert.ok(!has(p.load(video("BV1bb"))), "a load that changes nothing");
  // AI 总结 replaces it with the prompt: cleared first, then filled.
  const q = panel();
  assert.deepStrictEqual(types(q.dispatch({ type: "SUMMARY", prompt: "总结" })), ["hidePopovers", "clearDraft", "fill"]);
}

// ---- contexts: pending placeholders, resolving, the one rule for a conversation's own context ----
{
  // A history conversation on another video shows its placeholder, pending, until it resolves; a stale resolve
  // (another conversation shown since) is ignored.
  const p = panel({ list: [saved("h", video("BV1hh")), saved("g", video("BV1gg"))] });
  const opened = p.dispatch({ type: "OPEN", id: "h" });
  assert.deepStrictEqual(plain(opened.at(-1)), { type: "resolve", silent: true });
  assert.deepStrictEqual([p.view().context.pending, p.view().context.subtitleMarkdown], [true, ""]);
  const epoch = p.view().epoch;
  p.dispatch({ type: "OPEN", id: "g" });
  assert.deepStrictEqual(plain(p.dispatch({ type: "CONTEXT_RESOLVED", epoch, payload: video("BV1hh") })), [], "stale");
  assert.strictEqual(p.view().context.url, v("BV1gg"));
  assert.deepStrictEqual(plain(p.dispatch({ type: "CONTEXT_RESOLVED", epoch: p.view().epoch, payload: video("BV1gg", { subtitleMarkdown: "full" }) })), [{ type: "resolved" }]);
  assert.deepStrictEqual([p.view().context.subtitleMarkdown, p.view().context.pending], ["full", undefined]);
  // A failed resolve ends the pending state, and says it was pending.
  p.dispatch({ type: "OPEN", id: "h" });
  assert.deepStrictEqual(plain(p.dispatch({ type: "CONTEXT_RESOLVED", epoch: p.view().epoch, payload: null })), [{ type: "resolveFailed", wasPending: true }]);
  assert.strictEqual(p.view().context.pending, false);
  // The tab's own video: the live context, nothing to resolve.
  const q = panel({ list: [saved("a", video("BV1aa"))] });
  q.dispatch({ type: "NEW" });
  assert.ok(!types(q.dispatch({ type: "OPEN", id: "a" })).includes("resolve"));
  assert.deepStrictEqual([q.view().context.subtitleMarkdown, q.view().resolved.url], ["s", v("BV1aa")]);
  // A followed video with a saved conversation: the payload that comes back resolves it.
  const r = panel({ list: [saved("b", video("BV1bb"))] });
  r.dispatch({ type: "TAB_READ", tab: { url: v("BV1bb"), title: "b" }, follow: true });
  assert.deepStrictEqual([r.view().id, r.view().context.pending], ["b", true]);
  r.dispatch({ type: "CONTEXT_ARRIVED", payload: video("BV1bb"), follow: true });
  assert.deepStrictEqual([r.view().id, r.view().context.subtitleMarkdown], ["b", "s"]);
}
{
  // AI 总结 with a reference (分拣台, 视频记录): a saved conversation for that video opens and nothing fills; else a new
  // conversation bound to the video, pending until it resolves, gets the prompt after the resolve.
  const ref = S.buildConversationContextRef(video("BV1zz"));
  const p = panel({ tab: { url: "chrome-extension://x/triage/triage.html", title: "分拣台", isVideoContext: false } });
  assert.deepStrictEqual(types(p.dispatch({ type: "SUMMARY", prompt: "总结", ref })), ["clearDraft", "resolve", "fill"]);
  assert.deepStrictEqual([p.view().id, p.view().pinned.contextUrl, p.view().context.pending, p.view().nonVideo], ["", v("BV1zz"), true, false]);
  const q = panel({ tab: web, list: [saved("z", video("BV1zz"))] });
  assert.deepStrictEqual(types(q.dispatch({ type: "SUMMARY", prompt: "总结", ref })), ["clearDraft", "resolve"]);
  assert.strictEqual(q.view().id, "z");
  // The unified rule: the reference is the tab's own video, so its live context is used and nothing resolves.
  const r = panel({ tab: video("BV1zz") });
  assert.deepStrictEqual(types(r.dispatch({ type: "SUMMARY", prompt: "总结", ref })), ["clearDraft", "fill"]);
  assert.strictEqual(r.view().context.subtitleMarkdown, "s");
  // Without a reference: the tab's video with a saved conversation opens it; without one a new conversation gets the
  // prompt; an empty prompt only focuses the input.
  const s = panel({ list: [saved("a", video("BV1aa"))] });
  s.dispatch({ type: "NEW" });
  assert.deepStrictEqual(types(s.dispatch({ type: "SUMMARY", prompt: "总结" })), ["clearDraft"]);
  assert.strictEqual(s.view().id, "a");
  assert.deepStrictEqual(plain(panel().dispatch({ type: "SUMMARY", prompt: " " })), [{ type: "focus" }]);
}
{
  // 新对话 when the tab cannot be read has no context, never the video of the conversation that was open.
  const p = panel({ list: [saved("h", video("BV1hh"))] });
  p.dispatch({ type: "OPEN", id: "h" });
  p.dispatch({ type: "TAB_READ", tab: null });
  p.dispatch({ type: "NEW" });
  assert.deepStrictEqual([p.view().context, p.view().live.error], [null, ctx.MdgErrors.TEXT.noTab]);
  const q = panel();
  q.dispatch({ type: "TAB_READ", tab: { url: v("BV1aa") } });
  q.dispatch({ type: "CONTEXT_ARRIVED", payload: null, error: "读不到" });
  assert.deepStrictEqual([q.view().context, q.view().live.error], [null, "读不到"]);
}
{
  // Only videos can be asked: not a web page, and not a conversation saved on one, even with a video open.
  assert.strictEqual(panel({ tab: web }).view().nonVideo, true, "a fresh conversation on a web page");
  const p = panel({ list: [saved("w", web)] });
  p.dispatch({ type: "OPEN", id: "w" });
  assert.deepStrictEqual([p.view().nonVideo, p.view().context.pending], [true, false], "a saved web conversation");
  const q = panel({ tab: web, list: [saved("h", video("BV1hh"))] });
  q.dispatch({ type: "OPEN", id: "h" });
  assert.deepStrictEqual([q.view().nonVideo, q.view().mismatch], [false, true], "a saved video conversation on a web page");
  assert.strictEqual(panel().view().nonVideo, false, "a fresh conversation on a video");
}
{
  // The history page deleted the shown conversation: a fresh one; with a reply in flight it is left to save it again.
  const p = panel({ list: [saved("a", video("BV1aa"))] });
  const list = p.view().saved;
  assert.deepStrictEqual(types(p.dispatch({ type: "SAVED_CHANGED", list: [], previous: list })), ["clearDraft"]);
  assert.strictEqual(p.view().id, "");
  const q = panel({ list: [saved("a", video("BV1aa"))] });
  q.ask("q");
  q.dispatch({ type: "SAVED_CHANGED", list: [], previous: list });
  assert.deepStrictEqual([q.view().id, q.view().streaming], ["a", true]);
  // 上一个视频: set by a follow, dismissed by the user.
  q.dispatch({ type: "PREVIOUS_LOADED", id: "a" });
  assert.deepStrictEqual(plain(q.dispatch({ type: "PREVIOUS_DISMISSED" })), [{ type: "previous", id: "" }]);
  assert.strictEqual(q.view().previousId, "");
}

// L3: hydrating an old conversation keeps the 分 P 数 the background read (a P1 note of a multi-part video says P1).
{
  const old = saved("old", video("BV1mm"));
  const p = panel({ list: [old] });
  assert.strictEqual(p.view().saved.find((c) => c.id === "old").contextRef.pageCount, 0);
  p.dispatch({ type: "PAGE_HYDRATED", id: "old", payload: { url: v("BV1mm"), cid: "c-BV1mm", pageIndex: 1, pageCount: 3 } });
  const ref = p.view().saved.find((c) => c.id === "old").contextRef;
  assert.deepStrictEqual([ref.pageIndex, ref.pageCount], [1, 3]);
}

// A31: two windows' panels on one conversation: a later save from the other window is taken, so the next save here
// keeps its turn; this panel's own save coming back changes nothing.
{
  const list = [saved("a", video("BV1aa"))];
  const one = panel({ list });
  const two = panel({ list });
  two.ask("q2", "a2");
  assert.deepStrictEqual(types(one.dispatch({ type: "SAVED_CHANGED", list: two.view().saved, previous: list })), ["redraw"]);
  assert.deepStrictEqual(one.view().messages.map((m) => m.content), ["q-a", "a-a", "q2", "a2"]);
  one.ask("q1", "a1");
  assert.deepStrictEqual(types(one.dispatch({ type: "SAVED_CHANGED", list: one.view().saved, previous: list })), []);
  assert.deepStrictEqual(one.view().saved[0].messages.map((m) => m.content), ["q-a", "a-a", "q2", "a2", "q1", "a1"]);
  // An older list arriving late does not take the conversation back.
  assert.deepStrictEqual(types(one.dispatch({ type: "SAVED_CHANGED", list: two.view().saved })), []);
  assert.strictEqual(one.view().messages.length, 6);
}

// A7: a reply that failed or stopped before a word is not saved, but stays drawable until the next send or another
// conversation.
{
  const p = panel();
  p.dispatch({ type: "SEND", prompt: "q" });
  p.dispatch({ type: "STREAM_ENDED", raw: "", failure: { error: "坏了", code: "AI_QUOTA" } });
  assert.deepStrictEqual([plain(p.view().unanswered), p.view().messages.length, p.view().saved.length], [{ prompt: "q", error: "坏了", code: "AI_QUOTA" }, 0, 0]);
  p.dispatch({ type: "SEND", prompt: "q" });
  assert.strictEqual(p.view().unanswered, null, "sent again");
  p.dispatch({ type: "STREAM_ENDED", raw: "", failure: { stopped: "已停止生成" } });
  p.dispatch({ type: "NEW" });
  assert.strictEqual(p.view().unanswered, null, "another conversation");
}

console.log("sidepanel-state selftest: all passed");
