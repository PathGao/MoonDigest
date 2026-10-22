// The side panel's conversation and the video it is about, with every rule that decides them: which video the panel
// follows, which conversation owns a context, a reply or the input draft, when AI 总结 fills the input.
// Pure: no chrome.*, no DOM. sidepanel.js feeds it what happened (dispatch) and runs the effects it returns, and reads
// the conversation and its context only through view(). sidepanel.html loads it before sidepanel.js.
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

  // live: the active tab (context is its payload, or the placeholder of a video followed from its URL alone).
  // conv: the shown conversation. pinned is its own context's description once it has one (saved, opened from a
  // reference, or asked in); resolved is that context loaded; failed: loading it failed, so it is no longer pending.
  // epoch moves whenever another conversation is shown; fillEpoch is the epoch whose AI 总结 prompt is still to fill.
  // unanswered: the last question when its reply failed or stopped before a word came, kept only to draw it again.
  // streaming: the reply in flight and the context it was asked in. previousId: the 上一个视频 bar's conversation.
  function create() {
    const s = {
      live: { tabUrl: "", context: null, key: "", error: "", lastVideoUrl: "" },
      conv: { id: "", pinned: null, messages: [], resolved: null, failed: false, epoch: 0, fillEpoch: -1, unanswered: null, autoSend: null },
      streaming: null,
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
    return s.streaming ? s.streaming.context : s.live.context;
  }

  function shownKey(s) {
    if (s.conv.pinned) {
      return s.conv.pinned.contextKey || buildContextKey(shown(s));
    }
    return s.streaming ? s.streaming.key : s.live.key;
  }

  // One rule for a conversation's own context: the tab's loaded context when it is the same video, else load it.
  function fitsLive(s) {
    const live = s.live.context;
    return Boolean(live && !live.pending && s.live.key && shownKey(s) === s.live.key);
  }

  function view(s) {
    const context = shown(s);
    const key = shownKey(s);
    const { id, pinned, messages, resolved, epoch, unanswered } = s.conv;
    const target = shownPartUrl(s);
    return {
      context,
      key,
      live: s.live,
      id,
      pinned,
      messages,
      resolved,
      epoch,
      unanswered,
      streaming: Boolean(s.streaming),
      bound: Boolean(pinned || s.streaming),
      // Only videos can be asked about: a web page gives the AI nothing to read, and a conversation saved on one stays read-only.
      nonVideo: (pinned || context)?.isVideoContext === false,
      // The conversation's own video is not the one in the tab.
      mismatch: Boolean(pinned && target) && (!s.live.tabUrl || !MdgSites.sameContext(s.live.tabUrl, target, { live: s.live.context })),
      saved: s.saved,
      // What a save merges into the stored list: SidepanelState.mergeSaved(stored, saved, unsaved).
      unsaved: { created: new Set(s.unsaved.created), deleted: new Set(s.unsaved.deleted) },
      previousId: s.previousId,
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
      bound: Boolean(s.conv.pinned || s.streaming),
      lastVideoUrl: s.live.lastVideoUrl,
      hasContext: Boolean(context)
    };
  }

  // The only place the shown conversation changes. The draft belongs to the conversation: another one puts the input's
  // text away under the one left and brings back its own (the draft effect, filled in by dispatchAround). A reply still
  // running here is dropped, so callers that keep it detach it first.
  function setConv(s, conversation = null) {
    const effects = [];
    if (s.streaming) {
      s.streaming = null;
      effects.push({ type: "dropStream" });
    }
    if (!conversation?.id || conversation.id !== s.conv.id) {
      effects.push({ type: "draft" });
    }
    s.conv = { id: "", pinned: null, messages: [], resolved: null, failed: false, epoch: s.conv.epoch + 1, fillEpoch: -1, unanswered: null, autoSend: null };
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

  // Writes the shown conversation into saved. A new one takes the context its reply was asked in.
  function persist(s, context, contextKey) {
    if (!s.conv.messages.length || !context) {
      return;
    }
    const now = Date.now();
    if (!s.conv.id) {
      s.conv.id = `conv_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      s.conv.pinned = {
        title: buildConversationTitle(context),
        createdAt: now,
        contextKey,
        contextTitle: String(context.title || "").trim(),
        contextUrl: String(context.url || "").trim(),
        isVideoContext: context.isVideoContext !== false,
        contextRef: buildConversationContextRef(context)
      };
      s.conv.resolved = { ...context };
      s.unsaved.created.add(s.conv.id);
    }
    const { id, pinned } = s.conv;
    const next = {
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
      messages: s.conv.messages.map((m) => ({ role: m.role, content: String(m.content || "") }))
    };
    s.saved = normalizeConversations([next, ...s.saved.filter((item) => item.id !== id)]);
    const { messages, pageHydrated, ...meta } = next;
    s.conv.pinned = meta;
    s.conv.resolved ||= { ...context };
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

  // Leaving a conversation while the AI answers: the question goes into it now, and the reply follows it there.
  function detach(s) {
    if (!s.streaming) {
      return [];
    }
    const { prompt, context, key } = s.streaming;
    s.streaming = null;
    s.conv.messages.push({ role: "user", content: prompt });
    persist(s, context, key);
    return [{ type: "detach", conversationId: s.conv.id, promptIndex: s.conv.messages.length - 1 }, { type: "save" }];
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
    if (!s.conv.messages.length) s.conv.fillEpoch = s.conv.epoch;
    effects.push({ type: "followed" });
    return effects;
  }

  function open(s, id) {
    const conversation = s.saved.find((item) => item.id === id);
    if (!conversation || (s.streaming && id === s.conv.id)) {
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
          if (s.conv.pinned && !s.conv.resolved && fitsLive(s)) s.conv.resolved = { ...payload };
          return [];
        }
        return keyChanged ? [...setConv(s), ...restoreLatest(s, payload)] : pageRead(s, payload, key);
      }
      case "GRANT_DENIED":
        s.conv.autoSend = null;
        return [];
      // A conversation's own context loaded (payload) or failed; a load started for an earlier conversation is ignored.
      case "CONTEXT_RESOLVED": {
        if (event.epoch !== s.conv.epoch || !s.conv.pinned) {
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
        if (!event.prompt || s.conv.fillEpoch !== s.conv.epoch) {
          return [];
        }
        s.conv.fillEpoch = -1;
        return [{ type: "fill", prompt: event.prompt }];
      }
      // Deleting the shown conversation drops a reply in flight too, so it cannot bring the conversation back.
      case "DELETED": {
        s.saved = s.saved.filter((item) => item.id !== event.id);
        s.unsaved.created.delete(event.id);
        s.unsaved.deleted.add(event.id);
        return [...(event.id && event.id === s.conv.id ? setConv(s) : []), { type: "save" }];
      }
      // The stored list changed (the history page deletes conversations too). The shown one deleted there is dropped
      // like a delete here, so the next question cannot save it back; a reply in flight saves it again. One saved later
      // (another window's panel on the same conversation) takes its messages, so the next save here keeps them.
      case "SAVED_CHANGED": {
        const stored = (list) => Array.isArray(list) && list.some((item) => item?.id === s.conv.id);
        s.saved = mergeSaved(event.list, s.saved, s.unsaved);
        if (s.conv.id && !s.streaming && stored(event.previous) && !stored(event.list)) {
          return setConv(s);
        }
        const mine = s.conv.id ? s.saved.find((item) => item.id === s.conv.id) : null;
        if (!mine || !s.conv.pinned || mine.updatedAt <= (Number(s.conv.pinned.updatedAt) || 0)) {
          return [];
        }
        s.conv.messages = mine.messages.map((m) => ({ ...m }));
        s.conv.pinned = { ...s.conv.pinned, updatedAt: mine.updatedAt };
        return [{ type: "redraw" }];
      }
      // A save wrote these ids' creation or deletion.
      case "SAVED_WRITTEN":
        for (const id of event.created) s.unsaved.created.delete(id);
        for (const id of event.deleted) s.unsaved.deleted.delete(id);
        return [];
      case "PAGE_HYDRATED":
        return pageHydrated(s, event);
      case "SEND":
        s.streaming = { prompt: event.prompt, context: shown(s), key: shownKey(s) };
        s.conv.unanswered = null;
        return [];
      // The shown conversation's reply ended; one with an answer is saved. failure: how one without a word ended
      // ({ stopped, notice, error, code }), drawn again with its question until the next send.
      case "STREAM_ENDED": {
        const stream = s.streaming;
        s.streaming = null;
        if (!stream || !String(event.raw || "").trim()) {
          if (stream && event.failure) s.conv.unanswered = { prompt: stream.prompt, ...event.failure };
          return [];
        }
        s.conv.messages.push({ role: "user", content: stream.prompt }, { role: "assistant", content: event.raw });
        persist(s, stream.context, stream.key);
        return [{ type: "save" }, { type: "autoSync", id: s.conv.id }];
      }
      // A detached reply ended: the answer goes after its question, or the question goes when nothing came back.
      case "REPLY_FINISHED": {
        const { conversationId, promptIndex, prompt, raw } = event;
        const conversation = s.saved.find((item) => item.id === conversationId);
        if (!conversation) {
          return [];
        }
        const patch = (messages) => {
          if (messages[promptIndex]?.role !== "user" || messages[promptIndex].content !== prompt || messages[promptIndex + 1]?.role === "assistant") {
            return;
          }
          if (raw.trim()) messages.splice(promptIndex + 1, 0, { role: "assistant", content: raw });
          else messages.splice(promptIndex, 1);
        };
        const messages = conversation.messages.slice();
        patch(messages);
        if (conversationId === s.conv.id) patch(s.conv.messages);
        s.saved = normalizeConversations(s.saved.map((item) => (item.id === conversationId ? { ...item, messages, updatedAt: Date.now() } : item)));
        return [{ type: "save" }, { type: "autoSync", id: conversationId }];
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
    buildContextKey,
    buildConversationContextRef,
    buildContextPlaceholder,
    needsConversationPageHydration
  };
})();
