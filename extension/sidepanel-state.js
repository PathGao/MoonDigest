// The side panel's conversation and the video it is about, with every rule that decides them: which video the panel
// follows, which conversation owns a context, a reply or the input draft, when AI 总结 fills the input.
// Pure: no chrome.*, no DOM. sidepanel.js feeds it what happened (dispatch) and runs the effects it returns, and reads
// the conversation and its context only through view(). sidepanel.html loads it before sidepanel.js; the background
// loads it for patchReply, the one rule that puts a detached reply's answer into its conversation.
(() => {
  // ---- contexts and saved conversations ----

  // A video part's key or a web page's (MdgSites.buildContextKey). Conversations saved with the older url: keys get the
  // page key when they are read (MdgSites.conversationKey).
  function buildContextKey(payload) {
    return payload ? MdgSites.buildContextKey(buildConversationContextRef(payload)) : "";
  }

  const buildConversationContextRef = (context) => (context && typeof context === "object" ? MdgSites.contextRef(context) : null);

  // Stands in for a video's context until it loads. pending: it is loading, so the panel says so instead of
  // 「这期视频没有字幕」 and the 快捷追问 wait; sending always waits for the full context.
  function buildContextPlaceholder(ref, pending = false) {
    return ref && typeof ref === "object" ? { ...MdgSites.contextRef(ref), subtitleMarkdown: "", hotComments: [], pending } : null;
  }

  // A followed video before its subtitles load: the tab URL already names it.
  function buildTabVideoPlaceholder(tab, ref, shown) {
    const title = String(tab.title || "").replace(/_哔哩哔哩_bilibili$| - YouTube$/, "").trim();
    return {
      // A watch-later URL's oid is the part's cid: it finds that part's conversation before the payload names its pageIndex.
      ...buildContextPlaceholder({ site: ref.site, videoId: ref.id, cid: ref.part?.oid, url: ref.url, pageIndex: ref.part?.index || 1 }, true),
      // Right after an in-page navigation the tab can still carry the previous video's title; the parts of one video share it.
      title: title === shown?.title && shown?.videoId !== ref.id ? "" : title
    };
  }

  // A context's URL, naming its part: a watch-later page's URL names the part by oid, not ?p=, and the side panel's payload
  // and saved conversations carry that URL, so their pageIndex places the part.
  function partUrl(context) {
    const url = String(context?.url || "").trim();
    return MdgSites.parseRef(url)?.part?.oid ? MdgSites.videoUrl(context) : url;
  }
  // The shown conversation's own video (its saved context), else the shown context's.
  const shownPartUrl = (s) => (s.conv.pinned ? partUrl({ ...s.conv.pinned.contextRef, url: s.conv.pinned.contextUrl }) : partUrl(shown(s)));

  function normalizeConversations(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((item) => {
        const messages = Array.isArray(item?.messages)
          ? item.messages
              .filter((msg) => msg && (msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string")
              .map((msg) => ({ role: msg.role, content: String(msg.content) }))
          : [];
        const id = String(item?.id || "").trim();
        if (!id || !messages.length) {
          return null;
        }
        const contextTitle = String(item?.contextTitle || "").trim();
        const contextRef = buildConversationContextRef(item?.contextRef || item?.contextSnapshot || item);
        const contextUrl = String(item?.contextUrl || "").trim();
        return {
          id,
          title: normalizeConversationTitle(item?.title, contextTitle, contextRef, contextUrl),
          contextKey: MdgSites.conversationKey({ contextKey: item?.contextKey, contextRef, contextUrl }),
          contextTitle,
          contextUrl,
          isVideoContext: item?.isVideoContext !== false,
          createdAt: Number(item?.createdAt) || Date.now(),
          updatedAt: Number(item?.updatedAt) || Date.now(),
          contextRef,
          pageHydrated: item?.pageHydrated === true,
          messages
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // A multi-part video's conversation saved before its part was known: its page title and URL are looked up once.
  function needsConversationPageHydration(conversation) {
    if (!conversation?.isVideoContext || conversation.pageHydrated) {
      return false;
    }
    if (/-P\d+$/i.test(String(conversation.title || "").trim())) {
      return false;
    }
    if ((Number(conversation.contextRef?.pageIndex || 0) || 0) > 1) {
      return true;
    }
    if (extractPageIndexFromContextUrl(conversation.contextUrl || conversation.contextRef?.url || "") > 1) {
      return true;
    }
    return conversation.contextRef?.site === "bilibili" && Boolean(conversation.contextRef?.videoId && conversation.contextRef?.cid);
  }

  function buildConversationTitle(context) {
    return appendConversationPageSuffix(extractConversationBaseTitle(context?.title), context);
  }

  function normalizeConversationTitle(title, contextTitle = "", contextRef = null, contextUrl = "") {
    return appendConversationPageSuffix(extractConversationBaseTitle(String(contextTitle || "").trim() || title), contextRef || { url: contextUrl });
  }

  // The video's whole title (two videos named alike before a 「 - 」 stay apart); the part suffix is drawn from the context.
  function extractConversationBaseTitle(title) {
    return String(title || "").trim().replace(/-P\d+$/i, "").trim() || MdgErrors.TEXT.untitledVideo;
  }

  function appendConversationPageSuffix(title, context) {
    const pageIndex = Number(context?.pageIndex || context?.page || 0) || extractPageIndexFromContextUrl(context?.url);
    return pageIndex > 1 ? `${title}-P${pageIndex}` : title;
  }

  // A video URL's part (?p=, as sites.js reads it); any other page has none.
  const extractPageIndexFromContextUrl = (url) => MdgSites.parseRef(String(url || "").trim())?.part?.index || 1;

  // ---- following the tab (跟随播放) ----

  // Where a tab without a URL (Chrome hides it before the grant) is, for leaving a page's conversation.
  const UNREADABLE = "about:blank#unreadable";

  // What a context load does with the tab's video.
  // state: shownUrl (the shown conversation's video), hasMessages, bound (a saved context or a reply in flight holds
  // the conversation), lastVideoUrl (the tab's video when a load last took or watched it), hasContext (a context was
  // read before; false on the panel's first load).
  // ev: stage "tab" (only the tab URL is known yet) or "payload" (the full context came back); toUrl (the tab's video,
  // "" when it is not one); oid (a watch-later URL names the part by oid, not ?p=, so only the payload can place it
  // among the shown video's parts; another video follows at once); follow (a tab event asked to follow); keyChanged
  // (payload: the tab's context is not the shown one); fillsShown (payload: the shown context is its placeholder).
  // action: "follow" (show the tab's video: its latest conversation or a fresh one), "keep" (the conversation holds its
  // context), "adopt" (the unbound conversation takes the payload, or at the tab stage the tab URL's placeholder), "none"
  // (tab stage: wait for the payload).
  // Videos compare by URL (site, id, part). Following only leaves a conversation that belongs to the video just played,
  // or one with nothing asked yet (opened on a web page, an empty 问 AI one); a history conversation the user opened stays.
  // An unbound conversation on another video follows whichever load saw the change, so every entry ends alike; the panel's
  // first load (or one after a failed read) only adopts, without the AI 总结 fill, and does so at the tab URL already. lastVideoUrl moves when the panel takes the tab's video or a follow
  // load watches it, never on a load that leaves a bound conversation in place.
  function decideFollow({ shownUrl, hasMessages, bound, lastVideoUrl, hasContext }, { stage, toUrl, oid, follow, keyChanged, fillsShown }) {
    const same = (a, b) => MdgSites.sameContext(a, b);
    const candidate = Boolean(toUrl) && !fillsShown && (hasMessages ? Boolean(lastVideoUrl) && !same(toUrl, lastVideoUrl) && same(shownUrl, lastVideoUrl) : !same(toUrl, shownUrl));
    if (stage === "tab") {
      const otherVideo = (url) => !MdgSites.sameContext(url, toUrl, { anyPart: true });
      const placed = !oid || (otherVideo(shownUrl) && otherVideo(lastVideoUrl));
      if (!hasContext) return toUrl && placed ? { action: "adopt", lastVideoUrl: toUrl } : { action: "none", lastVideoUrl };
      return follow && placed && candidate ? { action: "follow", lastVideoUrl: toUrl } : { action: "none", lastVideoUrl };
    }
    const taken = toUrl || lastVideoUrl;
    if (!hasContext) return { action: "adopt", lastVideoUrl: taken };
    if ((follow && candidate) || (!bound && keyChanged && toUrl)) return { action: "follow", lastVideoUrl: toUrl };
    if (bound) return { action: "keep", lastVideoUrl: follow ? taken : lastVideoUrl };
    return { action: "adopt", lastVideoUrl: taken };
  }

  // ---- the state ----

  // The shown conversation's turn: idle → loading (the question drawn, its context loading) → waiting (asked, no word
  // yet) → streaming → idle, with stopping between 停止 and the end. Only step() moves it; a pair not in the table is
  // refused and changes nothing. Leaving the conversation (setConv, detach) ends it from any phase; coming back to one
  // whose reply still runs (detached) re-attaches it: streaming again, its question already in the messages (turn.reply).
  const TURN_STEPS = {
    QUESTION: { idle: "loading" },
    REATTACH: { idle: "streaming" },
    ASKED: { loading: "waiting" },
    UNSENT: { loading: "idle" },
    TOKEN: { waiting: "streaming", streaming: "streaming", stopping: "stopping" },
    STOP: { waiting: "stopping", streaming: "stopping" },
    STREAM_ENDED: { waiting: "idle", streaming: "idle", stopping: "idle" }
  };
  const IN_FLIGHT = new Set(["waiting", "streaming", "stopping"]);
  // newId: the id a conversation not saved yet gets when its first reply lands (given at ASKED, so the background knows
  // it from the start).
  const idleTurn = () => ({ phase: "idle", prompt: "", context: null, key: "", reply: null, newId: "" });
  const newConversationId = (now) => `conv_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const inFlight = (s) => IN_FLIGHT.has(s.turn.phase);
  function step(s, event) {
    const next = TURN_STEPS[event][s.turn.phase];
    if (!next) return false;
    s.turn.phase = next;
    return true;
  }

  // live: the active tab (context is its payload, or the placeholder of a video followed from its URL alone).
  // conv: the shown conversation. pinned is its own context's description once it has one (saved, opened from a
  // reference, or asked in); resolved is that context loaded; failed: loading it failed, so it is no longer pending.
  // fill: its AI 总结 prompt is still to fill. unanswered: the last question when its reply failed or stopped before a
  // word came, kept only to draw it again. convs (MdgCommon.latest): the shown conversation's run; showing another one
  // ends it, so a load or a drawing begun on the one before can tell.
  // turn: the phase above, with the question and, once asked, the context it was asked in; reply: { conversationId,
  // promptIndex } once re-attached, the question being saved already. detached: the saved conversations whose reply
  // still runs after the panel left them, by id → { promptIndex, prompt } (this panel's streams, or the background's
  // after a panel closed: ORPHANS). previousId: the 上一个视频 bar's conversation.
  function create() {
    const s = {
      live: { tabUrl: "", context: null, key: "", error: "", lastVideoUrl: "" },
      conv: { id: "", pinned: null, messages: [], resolved: null, failed: false, fill: false, unanswered: null, autoSend: null },
      convs: MdgCommon.latest(),
      turn: idleTurn(),
      detached: new Map(),
      previousId: "",
      saved: [],
      unsaved: { created: new Set(), deleted: new Set() }
    };
    return { dispatch: (event) => dispatchAround(s, event), view: () => view(s) };
  }

  // The context the panel shows is never stored: a conversation with its own context shows that (loaded, or a pending
  // placeholder until it is); a reply in flight keeps the one it was asked in; anything else shows the tab's.
  function shown(s) {
    const { pinned, resolved, failed } = s.conv;
    if (pinned) {
      return resolved || buildContextPlaceholder(pinned.contextRef, pinned.isVideoContext && !failed);
    }
    return inFlight(s) ? s.turn.context : s.live.context;
  }

  function shownKey(s) {
    if (s.conv.pinned) {
      return s.conv.pinned.contextKey || buildContextKey(shown(s));
    }
    return inFlight(s) ? s.turn.key : s.live.key;
  }

  // One rule for a conversation's own context: the tab's loaded context when it is the same video, else load it.
  function fitsLive(s) {
    const live = s.live.context;
    return Boolean(live && !live.pending && s.live.key && shownKey(s) === s.live.key);
  }

  function view(s) {
    const context = shown(s);
    const key = shownKey(s);
    const { id, pinned, messages, resolved, unanswered } = s.conv;
    const target = shownPartUrl(s);
    return {
      context,
      key,
      live: s.live,
      id,
      pinned,
      messages,
      resolved,
      run: s.convs.current,
      unanswered,
      turn: s.turn.phase,
      loading: s.turn.phase === "loading",
      streaming: inFlight(s),
      // What the background needs to finish the turn's reply by itself should the panel close (the chat message's reply):
      // the conversation, the question's place, and for a conversation not saved yet the record the panel would save.
      turnReply: inFlight(s) ? turnReply(s) : null,
      // The reply to this conversation's last question still runs where this panel cannot show it (the background,
      // another window's panel): no second question until it lands in the stored list.
      replyDetached: Boolean(id) && s.detached.has(id),
      bound: Boolean(pinned) || inFlight(s),
      // Only videos can be asked about: a web page gives the AI nothing to read, and a conversation saved on one stays read-only.
      nonVideo: (pinned || context)?.isVideoContext === false,
      // The conversation's own video is not the one in the tab.
      mismatch: Boolean(pinned && target) && (!s.live.tabUrl || !MdgSites.sameContext(s.live.tabUrl, target, { live: s.live.context })),
      saved: s.saved,
      // What a save merges into the stored list: SidepanelState.mergeSaved(stored, saved, unsaved).
      unsaved: { created: new Set(s.unsaved.created), deleted: new Set(s.unsaved.deleted) },
      previousId: s.previousId,
      // Where the input's draft is kept while another conversation shows (the draft effect's from / to).
      draftKey: draftKey(s),
      // The 历史对话 list: the shown video's conversations (the history page lists all of them).
      get history() {
        return s.saved.filter((c) => c.id === id || MdgSites.isConversationOf(c, context));
      }
    };
  }

  function snapshot(s) {
    const context = shown(s);
    return {
      shownUrl: shownPartUrl(s),
      hasMessages: s.conv.messages.length > 0,
      bound: Boolean(s.conv.pinned) || inFlight(s),
      lastVideoUrl: s.live.lastVideoUrl,
      hasContext: Boolean(context)
    };
  }

  // The only place the shown conversation changes. The draft belongs to the conversation: another one puts the input's
  // text away under the one left and brings back its own (the draft effect, filled in by dispatchAround). A reply still
  // running here is dropped, so callers that keep it detach it first; a question still loading its context is let go.
  function setConv(s, conversation = null) {
    const effects = [];
    if (inFlight(s)) {
      effects.push({ type: "dropStream" });
    }
    s.turn = idleTurn();
    if (!conversation?.id || conversation.id !== s.conv.id) {
      effects.push({ type: "draft" });
    }
    s.convs.next();
    s.conv = { id: "", pinned: null, messages: [], resolved: null, failed: false, fill: false, unanswered: null, autoSend: null };
    effects.push(...reattach(s, conversation));
    if (conversation) {
      s.conv.id = conversation.id;
      s.conv.pinned = {
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        contextKey: conversation.contextKey,
        contextTitle: conversation.contextTitle,
        contextUrl: conversation.contextUrl,
        isVideoContext: conversation.isVideoContext !== false,
        contextRef: conversation.contextRef || null
      };
      s.conv.messages = conversation.messages.map((m) => ({ role: m.role, content: String(m.content || "") }));
      if (fitsLive(s)) s.conv.resolved = { ...s.live.context };
    }
    return effects;
  }

  // A saved conversation's draft goes by its id; an unsaved one is the video's new conversation, so by the video's part
  // URL (its context key gains the cid only once the payload loads).
  function draftKey(s) {
    return s.conv.id || shownPartUrl(s);
  }

  // The draft effect names the conversation left and the one shown, read around the whole event: following another
  // video moves the tab's context before the conversation changes, and one event can change the conversation twice
  // (a placeholder, then the video's saved one), which is still one move. The same key on both sides is a new
  // conversation replacing the video's unsaved one, which starts empty.
  function dispatchAround(s, event) {
    const from = draftKey(s);
    const effects = dispatch(s, event);
    const first = effects.findIndex((effect) => effect.type === "draft");
    if (first < 0) return effects;
    effects[first] = { type: "draft", from, to: draftKey(s) };
    return effects.filter((effect, i) => effect.type !== "draft" || i === first);
  }

  function resolveIfNeeded(s, silent) {
    const { pinned, resolved } = s.conv;
    return pinned && !resolved && pinned.isVideoContext && shownKey(s) ? [{ type: "resolve", silent }] : [];
  }

  // A new conversation's own description, from the context its first reply was asked in.
  function newPinned(context, contextKey, now) {
    return {
      title: buildConversationTitle(context),
      createdAt: now,
      contextKey,
      contextTitle: String(context.title || "").trim(),
      contextUrl: String(context.url || "").trim(),
      isVideoContext: context.isVideoContext !== false,
      contextRef: buildConversationContextRef(context)
    };
  }

  // A conversation as the saved list holds it.
  function conversationRecord(s, id, pinned, context, contextKey, messages, now) {
    return {
      id,
      title: pinned.title || buildConversationTitle(context),
      contextKey: String(pinned.contextKey || contextKey || "").trim(),
      contextTitle: String(pinned.contextTitle || context.title || "").trim(),
      contextUrl: String(pinned.contextUrl || context.url || "").trim(),
      isVideoContext: pinned.isVideoContext !== false,
      createdAt: Number(pinned.createdAt) || now,
      updatedAt: now,
      contextRef: pinned.contextRef || buildConversationContextRef(context),
      pageHydrated: s.saved.find((item) => item.id === id)?.pageHydrated === true,
      messages: messages.map((m) => ({ role: m.role, content: String(m.content || "") }))
    };
  }

  // Writes the shown conversation into saved. A new one takes the context its reply was asked in and the id given at ASKED.
  function persist(s, context, contextKey, newId = "") {
    if (!s.conv.messages.length || !context) {
      return;
    }
    const now = Date.now();
    if (!s.conv.id) {
      s.conv.id = newId || newConversationId(now);
      s.conv.pinned = newPinned(context, contextKey, now);
      s.conv.resolved = { ...context };
      s.unsaved.created.add(s.conv.id);
    }
    const next = conversationRecord(s, s.conv.id, s.conv.pinned, context, contextKey, s.conv.messages, now);
    s.saved = normalizeConversations([next, ...s.saved.filter((item) => item.id !== s.conv.id)]);
    const { messages, pageHydrated, ...meta } = next;
    s.conv.pinned = meta;
    s.conv.resolved ||= { ...context };
  }

  // The reply in flight as the background should finish it: { conversationId, promptIndex, record? }. record: a
  // conversation not saved yet, with its question, as persist would write it (the background creates it when the answer
  // comes; the panel tells it with detach once it saved the question itself).
  function turnReply(s) {
    if (s.turn.reply) return s.turn.reply;
    const { prompt, context, key, newId } = s.turn;
    if (s.conv.id) return { conversationId: s.conv.id, promptIndex: s.conv.messages.length };
    const now = Date.now();
    const messages = [{ role: "user", content: prompt }];
    return { conversationId: newId, promptIndex: 0, record: context ? conversationRecord(s, newId, newPinned(context, key, now), context, key, messages, now) : undefined };
  }

  // This page's saved list merged by entry into a stored one (a save writes it; a change another page stored is read
  // through it). Each stored entry stays in its newer version (this page's on a tie), except the ones deleted here; one
  // only this page has stays only when it was created here, since another page (摘读记录, another window's panel)
  // deleted the rest. created / deleted: the ids this page made or deleted and has not written yet (s.unsaved).
  function mergeSaved(stored, local, { created = new Set(), deleted = new Set() } = {}) {
    const mine = new Map(normalizeConversations(local).map((c) => [c.id, c]));
    const kept = normalizeConversations(stored)
      .filter((c) => !deleted.has(c.id))
      .map((c) => (mine.has(c.id) && (mine.get(c.id).updatedAt || 0) >= (c.updatedAt || 0) ? mine.get(c.id) : c));
    const have = new Set(kept.map((c) => c.id));
    return normalizeConversations(kept.concat([...mine.values()].filter((c) => created.has(c.id) && !have.has(c.id))));
  }

  // Leaving a conversation while the AI answers: the question goes into it now, and the reply follows it there. A
  // re-attached reply leaves again as it was (its question is saved already).
  function detach(s) {
    if (!inFlight(s)) {
      return [];
    }
    const { prompt, context, key, reply, newId } = s.turn;
    s.turn = idleTurn();
    if (reply) {
      s.detached.set(reply.conversationId, { promptIndex: reply.promptIndex, prompt });
      return [{ type: "detach", ...reply }];
    }
    s.conv.messages.push({ role: "user", content: prompt });
    persist(s, context, key, newId);
    const promptIndex = s.conv.messages.length - 1;
    s.detached.set(s.conv.id, { promptIndex, prompt });
    return [{ type: "detach", conversationId: s.conv.id, promptIndex }, { type: "save" }];
  }

  // Shown again while its reply still runs: the reply is the turn once more (the page draws what came so far and
  // streams the rest into it; a reply the background holds is attached by id). conversation: the one setConv shows.
  function reattach(s, conversation) {
    const reply = conversation?.id ? s.detached.get(conversation.id) : null;
    if (!reply || !step(s, "REATTACH")) return [];
    s.detached.delete(conversation.id);
    s.turn.prompt = reply.prompt;
    s.turn.reply = { conversationId: conversation.id, promptIndex: reply.promptIndex };
    return [{ type: "reattach", conversationId: conversation.id }];
  }

  // A detached reply's conversation is gone (deleted here or on 摘读记录): the reply is cut off, so it cannot bring the
  // conversation back or spend the AI platform on nobody.
  function dropReply(s, id) {
    return s.detached.delete(id) ? [{ type: "dropReply", conversationId: id }] : [];
  }

  // A detached reply ended: the answer goes after its question, or the question goes when nothing came back
  // (patchReply), in the saved list and in the shown conversation when it is the one. external: the background holds
  // and writes it; it stays detached (asking is refused) until the stored list shows its answer (SAVED_CHANGED), so a
  // 「done」 from the background that only means another panel took it, or an end before the write, blocks nothing for good
  // and writes nothing here.
  function finishReply(s, { conversationId, promptIndex, prompt, raw, external }) {
    if (external) {
      if (s.saved.some((item) => item.id === conversationId)) s.detached.set(conversationId, { promptIndex, prompt });
      return [];
    }
    s.detached.delete(conversationId);
    const conversation = s.saved.find((item) => item.id === conversationId);
    if (!conversation) {
      return [];
    }
    const messages = conversation.messages.slice();
    patchReply(messages, { promptIndex, prompt, raw });
    if (conversationId === s.conv.id) patchReply(s.conv.messages, { promptIndex, prompt, raw });
    s.saved = normalizeConversations(s.saved.map((item) => (item.id === conversationId ? { ...item, messages, updatedAt: Date.now() } : item)));
    return [{ type: "save" }, { type: "autoSync", id: conversationId }];
  }

  // s.saved is newest first: the newest conversation of ref (MdgSites.isConversationOf, as every note's AI 问答 takes it).
  function restoreLatest(s, ref) {
    const latest = s.saved.find((item) => MdgSites.isConversationOf(item, ref));
    return latest ? setConv(s, latest) : [];
  }

  // Shows the tab's video: its latest conversation, or a fresh one that fills the AI 总结 prompt once its context is
  // there. A conversation with messages it leaves becomes the 上一个视频 bar.
  function follow(s, context) {
    const effects = detach(s);
    const previous = s.conv.id && s.conv.messages.length ? s.saved.find((item) => item.id === s.conv.id) : null;
    if (previous) {
      s.previousId = previous.id;
      effects.push({ type: "previous", id: previous.id });
    }
    effects.push(...setConv(s), ...restoreLatest(s, context));
    if (!s.conv.messages.length) s.conv.fill = true;
    effects.push({ type: "followed" });
    return effects;
  }

  function open(s, id) {
    const conversation = s.saved.find((item) => item.id === id);
    if (!conversation || (inFlight(s) && id === s.conv.id)) {
      return [];
    }
    return [...detach(s), ...setConv(s, conversation), ...resolveIfNeeded(s, true)];
  }

  function startNew(s) {
    return [{ type: "hidePopovers" }, ...detach(s), ...setConv(s)];
  }

  // A context that did not come from the tab keeps the shown conversation unless it is another context. A followed
  // video's placeholder has no cid yet, so its full context is matched by URL; an empty key (loading or blank tab) is
  // another context too, so returning to a video restores its conversation.
  function contextKeyChanges(s, payload) {
    const context = shown(s);
    const fillsPlaceholder = Boolean(context?.pending && MdgSites.sameContext(payload?.url || "", context.url));
    return !fillsPlaceholder && buildContextKey(payload) !== shownKey(s);
  }

  // AI 总结 (popup, player ✦, 专注模式, 分拣台's viewer) on a video that already has a conversation opens its latest
  // one; only a video without one gets the summary prompt. A reference (分拣台, 摘读记录) names a video that is not the
  // tab's: its conversation, or a new one bound to it, so the prompt never lands on the tab's own page.
  function summary(s, { prompt, ref }) {
    if (ref) {
      const effects = detach(s);
      const contextRef = buildConversationContextRef(ref);
      const placeholder = buildContextPlaceholder(contextRef);
      const latest = s.saved.find((item) => MdgSites.isConversationOf(item, placeholder));
      effects.push(...setConv(s, latest || { id: "", contextKey: "", contextTitle: placeholder.title, contextUrl: placeholder.url, contextRef, messages: [] }));
      effects.push(...resolveIfNeeded(s, false));
      return latest ? effects : [...effects, { type: "fill", prompt }];
    }
    const latest = s.saved.find((item) => MdgSites.isConversationOf(item, s.live.context));
    if (latest) {
      return open(s, latest.id);
    }
    const text = String(prompt || "").trim();
    if (!text) return [{ type: "focus" }];
    const effects = [...startNew(s), { type: "fill", prompt: text }];
    // A web page not granted yet: the prompt goes by itself once the page is read (pageRead), in this conversation and
    // on this page only; another conversation (setConv) or a refused grant drops it.
    const live = s.live.context;
    if (live?.isVideoContext === false && live.pageAccess === "needPermission" && s.live.key) s.conv.autoSend = { prompt: text, key: s.live.key };
    return effects;
  }

  // The page AI 总结 waited for is read: send its prompt (the page checks the input still holds it).
  function pageRead(s, payload, key) {
    const pending = s.conv.autoSend;
    if (!pending || pending.key !== key || payload.pageAccess !== "ready" || s.conv.messages.length) return [];
    s.conv.autoSend = null;
    return [{ type: "autoSend", prompt: pending.prompt }];
  }

  function dispatch(s, event) {
    switch (event.type) {
      // A context load read the active tab: tab is { url, title }, or null when there is none.
      case "TAB_READ": {
        if (!event.tab) {
          s.live = { ...s.live, tabUrl: "", context: null, key: "", error: MdgErrors.TEXT.noTab, noRetry: false };
          return [];
        }
        s.live.tabUrl = String(event.tab.url || "").trim();
        // Subtitles and comments take seconds to load, but the tab URL already names the new video, so following
        // switches now and the payload fills the context in.
        const ref = MdgSites.parseRef(s.live.tabUrl);
        const decision = decideFollow(snapshot(s), { stage: "tab", toUrl: ref?.url || "", oid: Boolean(ref?.part?.oid), follow: event.follow });
        s.live.lastVideoUrl = decision.lastVideoUrl;
        if (decision.action === "none") {
          return [];
        }
        const placeholder = buildTabVideoPlaceholder(event.tab, ref, shown(s));
        s.live = { ...s.live, context: placeholder, key: buildContextKey(placeholder), error: "" };
        if (decision.action === "follow") {
          return follow(s, placeholder);
        }
        // Nothing was shown: the video's saved conversation, else the placeholder in the empty one (placed: draw it).
        const restored = restoreLatest(s, placeholder);
        return restored.length ? restored : [{ type: "placed" }];
      }
      // The tab's context came back: payload, or error when it could not be read.
      case "CONTEXT_ARRIVED": {
        const { payload } = event;
        if (!payload) {
          // noRetry: no second read helps (MdgErrors.remedies), so the error gets no 重试.
          s.live = { ...s.live, context: null, key: "", error: String(event.error || ""), noRetry: event.noRetry === true };
          return [];
        }
        const key = buildContextKey(payload);
        const before = snapshot(s);
        const keyChanged = contextKeyChanges(s, payload);
        const fillsShown = Boolean(shown(s)?.pending && key === shownKey(s));
        // Leaving a web page's conversation folds it into the bar whatever the tab shows next, also a page that cannot be
        // read (chrome://, an extension page, one whose URL Chrome hides before the grant).
        const leavesPage = before.bound && shown(s)?.isVideoContext === false;
        s.live = { ...s.live, context: payload, key, error: "" };
        // A web page is followed like a video; a page that can never be read is not, except to leave a page's conversation.
        const toUrl = key && (payload.pageAccess !== "unsupported" || leavesPage) ? partUrl(payload) : leavesPage ? UNREADABLE : "";
        const decision = decideFollow(before, { stage: "payload", toUrl, follow: event.follow, keyChanged, fillsShown });
        s.live.lastVideoUrl = decision.lastVideoUrl;
        if (decision.action === "follow") {
          return follow(s, payload);
        }
        if (decision.action === "keep") {
          // Read again like at each send: a track picked since (the popup, 专注模式, the 字幕 dropdown) is in it.
          if (s.conv.pinned && fitsLive(s)) s.conv.resolved = { ...payload };
          return [];
        }
        return keyChanged ? [...setConv(s), ...restoreLatest(s, payload)] : pageRead(s, payload, key);
      }
      case "GRANT_DENIED":
        s.conv.autoSend = null;
        return [];
      // A conversation's own context loaded (payload) or failed; a load started for an earlier conversation (its run
      // ended) is ignored.
      case "CONTEXT_RESOLVED": {
        if (!event.run?.alive || !s.conv.pinned) {
          return [];
        }
        if (!event.payload) {
          const wasPending = Boolean(shown(s)?.pending);
          s.conv.failed = true;
          return [{ type: "resolveFailed", wasPending }];
        }
        const payload = event.payload;
        const { pinned } = s.conv;
        s.conv.pinned = {
          ...pinned,
          contextKey: pinned.contextKey || buildContextKey(payload),
          contextTitle: String(payload.title || pinned.contextTitle || "").trim(),
          contextUrl: String(payload.url || pinned.contextUrl || "").trim(),
          contextRef: buildConversationContextRef(payload)
        };
        s.conv.resolved = payload;
        return [{ type: "resolved" }];
      }
      case "OPEN":
        return open(s, event.id);
      case "NEW":
        return startNew(s);
      case "SUMMARY":
        return summary(s, event);
      // The empty conversation offers AI 总结: a video switch asked for it, so it fills the input, once.
      case "SUMMARY_SHOWN": {
        if (!event.prompt || !s.conv.fill) {
          return [];
        }
        s.conv.fill = false;
        return [{ type: "fill", prompt: event.prompt }];
      }
      // Deleting the shown conversation drops a reply in flight too, so it cannot bring the conversation back; so is
      // a detached reply of the deleted one.
      case "DELETED": {
        s.saved = s.saved.filter((item) => item.id !== event.id);
        s.unsaved.created.delete(event.id);
        s.unsaved.deleted.add(event.id);
        return [...(event.id && event.id === s.conv.id ? setConv(s) : []), ...dropReply(s, event.id), { type: "save" }];
      }
      // The stored list changed (the history page deletes conversations too). The shown one deleted there is dropped
      // like a delete here, with a reply in flight too, so neither the next question nor that reply can save it back;
      // a detached reply whose conversation went is cut off alike. One saved later (another window's panel on the
      // same conversation) takes its messages, so the next save here keeps them.
      case "SAVED_CHANGED": {
        const stored = (list, id) => Array.isArray(list) && list.some((item) => item?.id === id);
        const gone = (id) => stored(event.previous, id) && !stored(event.list, id);
        s.saved = mergeSaved(event.list, s.saved, s.unsaved);
        const effects = [...s.detached.keys()].filter(gone).flatMap((id) => dropReply(s, id));
        // The background (or another window) wrote a detached reply's end: its question answered, or taken away.
        for (const [id, { promptIndex, prompt }] of [...s.detached]) {
          const messages = s.saved.find((item) => item.id === id)?.messages || [];
          if (messages[promptIndex]?.content !== prompt || messages[promptIndex + 1]?.role === "assistant") s.detached.delete(id);
        }
        if (s.conv.id && gone(s.conv.id)) {
          return [...effects, ...setConv(s)];
        }
        const mine = s.conv.id ? s.saved.find((item) => item.id === s.conv.id) : null;
        if (!mine || !s.conv.pinned || mine.updatedAt <= (Number(s.conv.pinned.updatedAt) || 0)) {
          return effects;
        }
        s.conv.messages = mine.messages.map((m) => ({ ...m }));
        s.conv.pinned = { ...s.conv.pinned, updatedAt: mine.updatedAt };
        return [...effects, { type: "redraw" }];
      }
      // A save wrote these ids' creation or deletion.
      case "SAVED_WRITTEN":
        for (const id of event.created) s.unsaved.created.delete(id);
        for (const id of event.deleted) s.unsaved.deleted.delete(id);
        return [];
      case "PAGE_HYDRATED":
        return pageHydrated(s, event);
      // The question is drawn while its context loads; the turn steps forward (TURN_STEPS) or the event is refused.
      case "QUESTION":
        if (!step(s, event.type)) return [];
        s.turn.prompt = event.prompt;
        return [];
      // The question goes: the reply belongs to the context it is asked in, which the conversation keeps until it ends.
      case "ASKED": {
        const [context, key] = [shown(s), shownKey(s)];
        if (!step(s, event.type)) return [];
        Object.assign(s.turn, { context, key, newId: s.conv.id ? "" : newConversationId(Date.now()) });
        s.conv.unanswered = null;
        return [];
      }
      case "UNSENT":
        step(s, event.type);
        return [];
      // A word of the reply: the first one says the AI is answering (the page takes down its slow notice).
      case "TOKEN": {
        const waited = s.turn.phase === "waiting";
        return step(s, event.type) && waited ? [{ type: "answering" }] : [];
      }
      case "STOP":
        return step(s, event.type) ? [{ type: "stop" }] : [];
      // The shown conversation's reply ended; one with an answer is saved. failure: how one without a word ended
      // ({ stopped, notice, error, code }), drawn again with its question until the next send. A re-attached reply ends
      // as a detached one does; external: the background holds and writes it, so the stored list brings the answer.
      case "STREAM_ENDED": {
        const turn = s.turn;
        if (!step(s, event.type)) return [];
        s.turn = idleTurn();
        if (turn.reply) return finishReply(s, { ...turn.reply, prompt: turn.prompt, raw: String(event.raw || ""), external: event.external });
        if (!String(event.raw || "").trim()) {
          if (event.failure) s.conv.unanswered = { prompt: turn.prompt, ...event.failure };
          return [];
        }
        s.conv.messages.push({ role: "user", content: turn.prompt }, { role: "assistant", content: event.raw });
        persist(s, turn.context, turn.key, turn.newId);
        return [{ type: "save" }, { type: "autoSync", id: s.conv.id }];
      }
      case "REPLY_FINISHED":
        return finishReply(s, event);
      // The background's replies that outlived a panel ({ conversationId, promptIndex }): detached here, so showing one
      // of their conversations attaches to it, the shown one now included.
      case "ORPHANS": {
        for (const { conversationId, promptIndex } of event.replies || []) {
          const prompt = s.saved.find((item) => item.id === conversationId)?.messages[promptIndex];
          if (prompt?.role === "user" && !s.detached.has(conversationId)) s.detached.set(conversationId, { promptIndex, prompt: prompt.content });
        }
        return reattach(s, s.conv);
      }
      // 重试 replaces the failed turn instead of repeating the question below it.
      case "RETRY": {
        s.conv.unanswered = null;
        const { messages } = s.conv;
        const last = messages.length - 2;
        if (event.saved && messages[last]?.content === event.prompt && messages[last + 1]?.content === event.raw) {
          messages.splice(last, 2);
        }
        return [];
      }
      case "PREVIOUS_LOADED":
        s.previousId = String(event.id || "");
        return [];
      case "PREVIOUS_DISMISSED":
        s.previousId = "";
        return [{ type: "previous", id: "" }];
      default:
        throw new Error(`unknown event ${event.type}`);
    }
  }

  // A detached reply's answer put after its question in a conversation's messages, in place: the question must still be
  // at promptIndex with no answer yet; nothing came back (raw empty), the question goes. The background applies the
  // same rule to the stored conversation when the panel closed before the reply ended. Returns whether it changed them.
  function patchReply(messages, { promptIndex, prompt, raw }) {
    if (messages[promptIndex]?.role !== "user" || messages[promptIndex].content !== prompt || messages[promptIndex + 1]?.role === "assistant") {
      return false;
    }
    if (String(raw || "").trim()) messages.splice(promptIndex + 1, 0, { role: "assistant", content: raw });
    else messages.splice(promptIndex, 1);
    return true;
  }

  // One successful page lookup settles a conversation's page metadata; without the flag every open refetched it.
  function pageHydrated(s, { id, payload }) {
    const conversation = s.saved.find((item) => item.id === id);
    const contextRef = conversation?.contextRef;
    if (!contextRef) {
      return [];
    }
    // No payload: the lookup can never answer (the video is gone), so it is not asked again; the conversation stays as saved.
    if (!payload) {
      s.saved = normalizeConversations(s.saved.map((item) => (item.id === id ? { ...item, pageHydrated: true } : item)));
      return [{ type: "save" }];
    }
    const pageIndex = Number(payload.pageIndex) > 0 ? Number(payload.pageIndex) : 1;
    // 分 P 数: the note's name (P1 of a multi-part video says P1) depends on it, like on the video page.
    const pageCount = Number(payload.pageCount) > 0 ? Number(payload.pageCount) : Number(contextRef.pageCount) || 0;
    const url = String(payload.url || conversation.contextUrl || contextRef.url || "").trim();
    const ref = {
      ...contextRef,
      url,
      cid: String(payload.cid || contextRef.cid || "").trim(),
      pageIndex,
      pageCount,
      pageTitle: String(payload.pageTitle || contextRef.pageTitle || "").trim()
    };
    const title = normalizeConversationTitle(conversation.title, conversation.contextTitle, ref, url);
    const contextKey = MdgSites.conversationKey({ contextKey: conversation.contextKey, contextRef: ref, contextUrl: url });
    const same = title === conversation.title && url === conversation.contextUrl && contextKey === conversation.contextKey && Number(contextRef.pageIndex || 1) === pageIndex && Number(contextRef.pageCount || 0) === pageCount;
    const next = same ? { ...conversation, pageHydrated: true } : { ...conversation, pageHydrated: true, title, contextUrl: url, contextKey, contextRef: ref };
    s.saved = normalizeConversations(s.saved.map((item) => (item.id === id ? next : item)));
    if (id === s.conv.id && s.conv.pinned) {
      s.conv.pinned = { ...s.conv.pinned, title: next.title, contextKey: next.contextKey, contextUrl: next.contextUrl, contextRef: next.contextRef };
    }
    return [{ type: "save" }];
  }

  globalThis.SidepanelState = {
    create,
    decideFollow,
    mergeSaved,
    patchReply,
    buildConversationContextRef,
    needsConversationPageHydration
  };
})();
