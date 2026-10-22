"use strict";
// 收藏夹's start (init, run by the module triage.js once the dev preview's mock is in), MoonTriage for 关注, 待播, and
// the page's events and keys. The last of the fav-*.js, whose top-level names are the page's globals.

// ---------- init ----------
// 关注 mode (follow.js) borrows the viewer, the toast and the confirm dialog, keeps its undo steps here (S.modeUndo) and
// takes the keys while on.
const followMode = () => Boolean(document.body?.classList.contains("follow-mode"));
// modeKeys(key, e): null while that mode is off (the keys below run); otherwise true when it used the key.
let modeKeys = null;
// 关注's 「UP 标签」 line, redrawn with the 「视频标签」 line.
let viewerHook = null;
globalThis.MoonTriage = {
  openViewer, closeViewer, toast, askConfirm, send, openOptions, store, aiError: (error, code) => handleAiError(error, code), hold: (r) => THROTTLES[r.code] || null, viewing: () => S.viewing,
  // The playing 收藏夹 video's UP as { mid, name } (mid "" on items saved before it was stored); null in 关注 or with
  // nothing playing.
  viewingUp() {
    const it = !followMode() && S.viewer?.item;
    return it ? { mid: it.upperMid || "", name: it.upper || "" } : null;
  },
  // 关注's 没登录: the same 去登录 banner as 收藏夹's; off hides it only when it is that one.
  loginBanner(on) {
    if (on) showLogin();
    else if (el.banner.dataset.kind === "login") el.banner.hidden = true;
  },
  undo, pushUndo, dropModeUndo: (drop) => (S.modeUndo = S.modeUndo.filter((e) => !drop(e))), help: () => el.helpDialog.showModal(), setModeKeys: (fn) => (modeKeys = fn), setViewerHook: (fn) => (viewerHook = fn)
};

// A failed start (a storage read, say) says so in the list instead of leaving the page blank.
async function init() {
  try {
    await start();
  } catch (e) {
    console.error("[triage] start failed", e);
    el.list.innerHTML = UI.emptyState("分拣台启动失败", `${MdgErrors.text({ error: e?.message })}，${MdgErrors.TEXT.reloadRetry}。`);
  }
}
async function start() {
  UI.fillSetRows(document);
  UI.clampNumbers(document);
  bindEvents();
  // Read up front: sidePanel.open must run inside the click's user gesture, before any await.
  chrome.tabs.getCurrent().then((tab) => (ownTabId = tab?.id));
  const [{ tags, videoTags, folderCriteria }, kept, basket, notes, settingsResp, aiHistory, aiRecent, sortBy, readAt, aiProposals] = await Promise.all([
    loadTagsAndCriteria(),
    storeGet(K.kept, {}),
    storeGet(K.basket, []),
    storeGet(K.notes, {}),
    send({ type: "triage-settings-get" }),
    storeGet(K.aiHistory, []),
    storeGet(K.aiRecent, {}),
    storeGet(K.sort, {}),
    storeGet(K.readAt, {}),
    storeGet(K.aiProposals, {})
  ]);
  Object.assign(S, { tags, videoTags, folderCriteria, kept, notes, aiHistory, aiRecent, sortBy, readAt });
  S.ai.proposals = aiProposals;
  pruneAiProposals();
  S.basket = basket.map(({ bvid, title, cover, upper, duration, opened }) => ({ bvid, title, cover, upper, duration, ...(opened ? { opened: true } : {}) }));
  if (settingsResp.ok) Object.assign(S.settings, settingsResp.data);
  renderTagLimit();
  // Stored values, raw: the switch reads through normalizeSwitches like everywhere else.
  const syncObsidian = (stored) => document.body.classList.toggle("obsidian-off", !MdgSettings.normalizeSwitches(stored).obsidianEnabled);
  const sync = await chrome.storage.sync.get({ obsidianEnabled: MdgSettings.DEFAULTS.obsidianEnabled, ...SEEN_DEFAULTS });
  syncObsidian(sync);
  setSeenCfg(sync);
  followSeenMeta(await storeGet(KEYS.triageSeenMeta));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.obsidianEnabled) syncObsidian({ obsidianEnabled: changes.obsidianEnabled.newValue });
    if (area === "sync") followSettings(changes);
    if (area === "sync" && Object.keys(SEEN_DEFAULTS).some((k) => changes[k])) {
      chrome.storage.sync.get(SEEN_DEFAULTS).then((v) => {
        setSeenCfg(v);
        loadSeen(S.folderToken).then(render);
      });
    }
    if (area === "local") followSeen(changes);
    if (area === "local") followNotes(changes);
    if (area === "local") followShared(changes);
    if (area === "local") followIncluded(changes);
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "triage-seen-done") return seenDone(msg);
    if (msg?.type !== "triage-folder-page") return;
    S.loadPage = { mediaId: msg.mediaId, page: msg.page };
    renderTop();
    if (S.loadAll) renderListHeader(visibleItems());
    else if (!S.items.length && msg.mediaId === String(S.mediaId)) el.list.innerHTML = loadingHtml();
  });
  renderBasket();
  await loadFolders();
  setInterval(tick, 1000);
}

// 收藏夹设置's stored keys. A write from elsewhere (导入设置 on the options page, AI 打标签's switch) is read again here, as
// 关注 and 摘读记录 read theirs, so this page runs with it and a later save does not put the old values back.
const SETTING_KEYS = [...NUM_FIELDS.map(([key]) => key), "triageThinking", "triageAiRemoveTags"];
function followSettings(changes) {
  if (!SETTING_KEYS.some((k) => changes[k])) return;
  return send({ type: "triage-settings-get" }).then((r) => {
    if (!r.ok) return;
    Object.assign(S.settings, r.data);
    renderTagLimit();
    render();
  });
}

// A new folder choice (收藏夹设置, or 导入设置 on the options page, which writes it here): the folder list reloads and
// newly ticked folders take back their videos; unticked ones move theirs to 已出分拣范围 (retireUnchosenFolders).
async function applyIncluded(included) {
  const ticked = included.filter((id) => !S.included.includes(id));
  await loadFolders();
  recoverRemoved(ticked);
}
function followIncluded(changes) {
  const c = changes[K.included];
  if (!c || ownEcho(K.included, c) || !S.allFolders.length) return;
  const included = (c.newValue || []).map(String);
  if (included.length === S.included.length && included.every((id) => S.included.includes(id))) return;
  applyIncluded(included);
}

// Another triage tab wrote one of the lists every page writes whole: take its value, so the next
// write here does not put back what it removed. This page's own writes come back as events too and are skipped: an
// older one arriving after a newer edit would undo that edit.
const SHARED = { kept: {}, videoTags: {}, tags: [], basket: [], folderCriteria: {}, aiRecent: {} };
function followShared(changes) {
  let changed = false;
  for (const [name, empty] of Object.entries(SHARED)) {
    const c = changes[K[name]];
    if (!c) continue;
    if (ownEcho(K[name], c)) continue;
    const value = c.newValue ?? structuredClone(empty);
    if (name === "kept") followKept(value);
    else S[name] = value;
    changed = true;
  }
  // 取消收藏 records: the open folder's, as openFolder builds them; in 所有收藏夹 those of the loaded folders.
  for (const [key, c] of Object.entries(changes)) {
    const id = /^triage_decisions_(.+)$/.exec(key)?.[1];
    if (!id || ownEcho(key, c)) continue;
    const d = c.newValue || {};
    if (id === String(S.mediaId)) S.decisions = { ...S.kept, ...d };
    else if (S.loadAll && S.folderDecisions[id]) {
      S.folderDecisions[id] = d;
      rebuildAll();
    } else continue;
    changed = true;
  }
  if (changed) render();
}
// The side panel and history page edit the same notes. A pending local save is newer than the stored entry, and
// neither it nor this page's own saves coming back re-render: that rebuilds the note being typed (and its IME composition).
function followNotes(changes) {
  const c = changes[K.notes];
  if (!c || ownEcho(K.notes, c)) return;
  const next = { ...c.newValue };
  for (const b of notePending) {
    if (S.notes[b]) next[b] = S.notes[b];
    else delete next[b];
  }
  S.notes = next;
  if (!notePending.size) render();
}
function ownEcho(key, c) {
  const mine = (ownWrites[key] || []).filter((w) => Date.now() - w.at < ECHO_MS);
  ownWrites[key] = mine;
  const json = JSON.stringify(c.newValue ?? null);
  const i = mine.findIndex((w) => w.json === json);
  if (i >= 0) mine.splice(0, i + 1);
  return i >= 0;
}
// 保留 also sits in the open view's decisions (see openFolder and rebuildAll); 取消收藏 there wins, as on open.
function followKept(kept) {
  for (const [b, d] of Object.entries(S.decisions)) if (d?.action === "keep" && !kept[b]) delete S.decisions[b];
  for (const [b, d] of Object.entries(kept)) if (S.decisions[b]?.action !== "unfav") S.decisions[b] = d;
  S.kept = kept;
}

// ---------- 待播 ----------
// triage_basket is the 待播 in order: [{ bvid, title, cover?, upper?, duration?, opened? }]; the copied
// fields show videos outside the open folder (entries from before they were copied have only the title).
const saveBasket = () => storeSet(K.basket, S.basket);

function toggleBasket(bvid) {
  const i = S.basket.findIndex((x) => x.bvid === bvid);
  const it = S.itemMap.get(bvid);
  if (i >= 0) {
    removeBasketItems([i]);
    toast(BASKET_REMOVED);
    return;
  }
  if (it) {
    S.basket.push({ bvid, title: it.title, cover: it.cover, upper: it.upper, duration: it.duration });
    toast(`已加入待播《${shortTitle(it)}》`);
    el.basket.classList.remove("bump");
    void el.basket.offsetWidth;
    el.basket.classList.add("bump");
  }
  saveBasket();
  render();
}

// The list keeps the order videos were added in. Opening one only marks it; only 移除 removes it —
// opening a video isn't watching it.
function openBasketItem(i) {
  const x = S.basket[i];
  if (!x) return;
  x.opened = true;
  saveBasket();
  openViewer(x);
}

// 移除 and 清空 take videos out of the list, nothing else; favorites and decisions are untouched. U puts them back
// (basketStep), each at its place.
function basketStep(removed) {
  return pageStep("basket", 0, "", () => {
    for (const { i, x } of removed) if (!S.basket.some((y) => y.bvid === x.bvid)) S.basket.splice(i, 0, x);
    saveBasket();
    return `已撤销：放回待播 ${removed.length} 个`;
  });
}
function removeBasketItems(indexes) {
  const removed = indexes.filter((i) => S.basket[i]).sort((a, b) => a - b).map((i) => ({ i, x: S.basket[i] }));
  if (!removed.length) return;
  const gone = new Set(removed.map((r) => r.x.bvid));
  S.basket = S.basket.filter((x) => !gone.has(x.bvid));
  saveBasket();
  pushUndo(basketStep(removed));
  render();
}

function clearBasket() {
  const n = S.basket.length;
  removeBasketItems(S.basket.map((_, i) => i));
  toast(`已清空待播 ${n} 个${UNDO}`);
}

function renderBasket() {
  el.basket.hidden = !S.basket.length;
  el.basketCount.textContent = S.basket.length;
  el.basketList.innerHTML = S.basket
    .map((x, i) => {
      const it = S.itemMap.get(x.bvid) || x;
      const title = esc(it.title || x.bvid);
      const meta = [it.upper, it.duration && fmtDuration(it.duration)].filter(Boolean).map(esc).join(" · ");
      const note = S.notes[x.bvid]?.text?.trim();
      return `<div class="basket-item${x.opened ? " opened" : ""}${x.bvid === S.viewing ? " playing" : ""}" data-i="${i}">
      <button type="button" class="basket-open" data-basket="open" aria-label="打开视频 ${title}">
        ${it.cover ? `<img class="basket-cover" src="${esc(img(it.cover, "160w_90h_1c"))}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ""}
        <span class="basket-text"><span class="basket-title">${title}</span>${meta || x.opened ? `<span class="muted">${[meta, x.opened && "已打开"].filter(Boolean).join(" · ")}</span>` : ""}</span>
      </button>
      <div class="basket-actions">
        <button type="button" data-basket="remove" aria-label="${BASKET_REMOVE} ${title}" title="${BASKET_REMOVE}">移除</button>
      </div>
      ${note ? `<div class="muted basket-note">${esc(note)}</div>` : ""}
    </div>`;
    })
    .join("");
}

// 一篇摘录: one Markdown file with each video's link and what its own note carries (MdgNote.triageExtras): the AI 总结
// with its 「AI 判断」 line, every 分拣 and 摘读记录 tag, 星标 and the note. stored: chrome.storage.local with digestKeys.
const digestRef = (bvid) => ({ site: "bilibili", videoId: bvid, pageIndex: 1 });
const digestKeys = (items) => [...new Set(items.flatMap((it) => MdgNote.triageExtrasKeys(digestRef(it.bvid))))];
function buildMarkdown(items, stored = {}, now = new Date()) {
  const lines = [
    "---",
    `title: B站摘录 ${fmtTime(now)}`,
    `created: ${stamp(now, false)}`,
    "tags:",
    "  - B站摘录",
    "---",
    ""
  ];
  for (const it of items) {
    const { analysis, note, userTags, starred } = MdgNote.triageExtras(stored, digestRef(it.bvid));
    lines.push(`## [${mdLinkText(it.title)}](${videoUrl(it.bvid)})`, "");
    const info = [it.upper && `UP 主：${it.upper}`, it.invalid && KIND_NAME.invalid, starred && "星标"].filter(Boolean);
    if (info.length) lines.push(info.join(" · "), "");
    const summary = MdgNote.buildTriageSummary(analysis);
    if (summary) lines.push(summary, "");
    if (userTags.length) lines.push(`标签：${userTags.join("、")}`, "");
    if (note.trim()) lines.push(`备注：${note.trim()}`, "");
  }
  return lines.join("\n");
}

// ---------- events ----------
function bindEvents() {
  el.sortBox.addEventListener("change", (e) => {
    if (e.target.matches("[data-sort]")) setSort(e.target.value, SORT_DIR[e.target.value]);
  });
  el.sortBox.addEventListener("click", (e) => {
    if (!e.target.closest("[data-sort-dir]")) return;
    const { sort, dir } = sortOf();
    setSort(sort, dir === "asc" ? "desc" : "asc");
  });
  el.folderSelect.addEventListener("change", () => openFolder(el.folderSelect.value));
  // A cover that fails to load leaves the colored tint behind it.
  for (const box of [el.folderList, el.folderHead]) box.addEventListener("error", (e) => e.target.remove?.(), true);
  el.folderList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-folder]");
    if (btn && btn.dataset.folder !== String(S.mediaId)) openFolder(btn.dataset.folder);
  });
  el.refreshBtn.addEventListener("click", () => {
    if (S.seenCfg.on) seenSync(true);
    if (inFolderView() && fav.state().writing(S.mediaId)) toast("这个收藏夹正在批量修改，结束后自动刷新");
    S.mediaId === ALL ? refreshAll() : S.mediaId === REMOVED ? openFolder(REMOVED) : S.mediaId && syncFolder({ force: true });
  });
  const autoSync = () => {
    if (S.mediaId && S.mediaId !== ALL && S.mediaId !== REMOVED && document.visibilityState === "visible") quickSync();
  };
  window.addEventListener("focus", autoSync);
  document.addEventListener("visibilitychange", autoSync);

  // A new tab, filter, search or sort lists other cards: it starts at the top, where its first results are.
  const fromTop = () => {
    el.list.scrollTop = 0;
    render();
  };
  const showTab = (tab) => {
    if (tab !== S.tab) S.selected.clear();
    S.tab = tab;
    S.focused = "";
    fromTop();
  };
  el.tabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab]");
    if (btn) showTab(btn.dataset.tab);
    const kind = e.target.closest("[data-kindtab]");
    if (kind) {
      S.kindFilter = kind.dataset.kindtab;
      S.selected.clear(); // a selection belongs to its tab
      fromTop();
    }
  });
  UI.bindSearch(el.searchInput, (q) => {
    S.query = q;
    // A search that hides the focused card starts the focus at the top.
    const f = S.itemMap.get(S.focused);
    if (!f || !passFilter(f)) S.focused = "";
    fromTop();
  });
  // Row 3: one pick per group, a second click clears it; 全部 clears the whole row (not row 4's tags).
  el.classFilter.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    e.stopPropagation();
    if (b.matches("[data-airecent-done]")) endAiRecent();
    else if (b.matches("[data-states-all]")) pickState("all");
    else if (b.dataset.classFilter) pickState("class", b.dataset.classFilter);
    else if (b.matches("[data-finishedfilter]")) pickState("seen");
    else if (b.matches("[data-dupfilter]")) pickState("dup");
    else if (b.dataset.tagstate) pickState("tagged", b.dataset.tagstate);
    else if (b.dataset.kindfilter) pickState("kind", b.dataset.kindfilter);
    else if (b.matches("[data-airecent]")) pickState("recent");
    else return;
    fromTop();
  });
  el.tagFilter.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tagfilter]");
    if (!btn) return;
    const ids = btn.dataset.tagfilter.split(",");
    const on = ids.some((id) => S.tagFilter.has(id));
    for (const id of ids) on ? S.tagFilter.delete(id) : S.tagFilter.add(id);
    fromTop();
  });

  const onHeadClick = (e) => {
    const btn = e.target.closest("[data-head]");
    if (!btn) return;
    const act = btn.dataset.head;
    if (act === "tags") openAi();
    else if (act === "aiOther") openFolder(otherAiFolder()).then(openAi);
    else if (act === "stage1") {
      if (!runs.get("stage1")) {
        const list = stage1Pending();
        return startJudging(stage1Label(list), "粗看", list, () => runStage1(list));
      }
      runs.stop("stage1");
      render();
    } else if (act === "group") {
      if (S.group) {
        runs.stop("group");
        return render();
      }
      // The batch stays selected, as with 标题粗看; its cards leave the selection when they leave the tab.
      const batch = nextBatch();
      const items = batch.map((b) => S.itemMap.get(b));
      startJudging(groupLabel(items), "细看", items, () => startGroup(batch));
    } else if (act === "batch-unfav") fav.unfavMany(batchList(btn.dataset.verdict || null));
    else if (act === "batch-keep") batchKeep(batchList(btn.dataset.verdict || null));
    else if (act === "criteria") openCriteria();
    else if (act === "write") stopWrite();
    else if (act === "fav") W.stop();
    else if (act === "redo-coarse") {
      const { batch, label } = redoOf("coarse");
      startJudging(label, "重新粗看", batch, () => runStage1(batch, true));
    } else if (act === "redo-fine") {
      const { batch, label } = redoOf("fine");
      startJudging(label, "重新细看", batch, () => startGroup(batch.map((it) => it.bvid), true));
    }
    else if (act === "sel-tags") openPicker(visibleSelected().map((it) => it.bvid));
    else if (act === "all-pause") {
      S.loadAll.paused = true;
      render();
    } else if (act === "all-resume") {
      S.loadAll.paused = false;
      runLoadAll(S.folderToken);
    }
    else if (act === "clean-removed") cleanRemoved(visibleItems());
    else if (act === "clean-selected") cleanRemoved(selectedIn(visibleItems()));
    else if (act === "transfer") fav.transfer(transferList());
    else if (act === "select-all") {
      UI.toggleAll(visibleItems().map((it) => it.bvid), S.selected);
      render();
    } else if (act === "clear-selected") {
      S.selected.clear();
      render();
    }
  };
  // listHeader is inside stagebar; binding both would handle one bubbling click twice.
  el.stagebar.addEventListener("click", onHeadClick);
  el.favSel.addEventListener("click", onHeadClick);
  el.activity.addEventListener("click", onHeadClick);

  el.list.addEventListener("click", (e) => {
    if (e.target.closest("[data-pick-folders]")) return openSettings(false, true);
    if (e.target.closest("[data-refresh]")) return el.refreshBtn.click();
    const refav = e.target.closest("[data-refav]");
    if (refav) return fav.refav(refav.dataset.refav);
    const refavAll = e.target.closest("[data-refav-batch]");
    if (refavAll) return fav.refavBatch(Number(refavAll.dataset.refavBatch));
    const picked = e.target.closest(".card[data-bvid]");
    if (picked && UI.cardPickClick(e)) {
      e.preventDefault();
      if (e.shiftKey) getSelection().removeAllRanges();
      setFocus(picked.dataset.bvid, false);
      pickAnchor = UI.pickCard(S.selected, visibleItems().map((it) => it.bvid), picked.dataset.bvid, pickAnchor, e.shiftKey);
      return showPicks();
    }
    const clean = e.target.closest("[data-clean]");
    if (clean) return cleanRemoved([S.itemMap.get(clean.dataset.clean)].filter(Boolean));
    if (e.target.closest("[data-retry-failed]")) return retryFailed();
    const card = e.target.closest(".card");
    if (!card) return;
    if (e.target.closest("a[href]")) {
      if (!plainClick(e)) return;
      e.preventDefault();
    }
    const bvid = card.dataset.bvid;
    const untag = e.target.closest("[data-untag]");
    if (untag) return tagStore.untag(bvid, untag.dataset.untag);
    const act = e.target.closest("[data-act]")?.dataset.act;
    setFocus(bvid, false);
    if (act) cardAction(act, bvid);
    else if (UI.cardPlayClick(e)) cardAction("open", bvid);
  });

  // The pointer makes a card current only when the hand moves it. A mousemove at the same position comes from the
  // list scrolling (J/K, wheel) or re-rendering under a still pointer and must not steal the keyboard's current card.
  let pointerAt = null;
  el.list.addEventListener("mousemove", (e) => {
    if (!pointerMoved(pointerAt, e.clientX, e.clientY)) return;
    pointerAt = { x: e.clientX, y: e.clientY };
    const bvid = e.target.closest(".card")?.dataset.bvid;
    if (bvid && bvid !== S.focused) setFocus(bvid, false);
  });

  // A note saves 400 ms after typing stops, but never mid-IME: compositionend saves the committed text.
  const noteEdit = (e) => {
    if (!e.target.matches("[data-note]")) return;
    const b = e.target.closest(".card").dataset.bvid;
    const text = e.target.value.trim();
    if (text) S.notes[b] = { text: e.target.value, updatedAt: Date.now() };
    else delete S.notes[b];
    notePending.add(b);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(flushNotes, 400);
  };
  el.list.addEventListener("input", (e) => !e.isComposing && noteEdit(e));
  el.list.addEventListener("compositionend", (e) => {
    noteEdit(e);
    if (listDeferred) setTimeout(renderList);
  });
  // Enter (or Esc) saves now and leaves the note so card keys work again; Shift+Enter is a newline. Never mid-IME.
  el.list.addEventListener("keydown", (e) => {
    if (composing(e) || !e.target.matches("[data-note]")) return;
    if (!(e.key === "Escape" || (e.key === "Enter" && !e.shiftKey))) return;
    e.preventDefault();
    if (noteTimer) void flushNotes();
    e.target.blur();
  });
  // An emptied note folds back to 「+ 备注」.
  el.list.addEventListener("focusout", (e) => {
    if (!e.target.matches("[data-note]") || e.target.value.trim()) return;
    S.noteOpen.delete(e.target.closest(".card").dataset.bvid);
    setTimeout(renderList);
  });

  document.addEventListener("keydown", onKey);
  el.viewerCloseBtn.addEventListener("click", closeViewer);
  // The open folder's own Bilibili page; 所有收藏夹 and 已出分拣范围 have none, so they go to the space page.
  el.biliBtn.addEventListener("click", () =>
    openTab(
      S.mediaId === TOVIEW
        ? "https://www.bilibili.com/watchlater/list"
        : `https://space.bilibili.com/${S.mid}${inFolderView() ? `/favlist?fid=${S.mediaId}&ftype=create` : ""}`
    )
  );

  el.settingsBtn.addEventListener("click", () => openSettings());
  for (const input of [el.thinkingInput, el.titleMaxInput, el.analyzeMaxInput]) {
    input.addEventListener("input", renderTokenHints);
  }
  el.settingsDialog.addEventListener("click", (e) => {
    const all = e.target.closest("[data-folders-all]");
    if (!all && !e.target.closest("[data-folders-none]")) return;
    for (const box of el.folderToggles.querySelectorAll("input")) box.checked = Boolean(all);
  });
  el.settingsDialog.addEventListener("close", async () => {
    if (el.settingsDialog.returnValue !== "save") return;
    // Only the fields changed since the dialog opened: a setting written elsewhere meanwhile (导入设置) keeps that value.
    const patch = UI.changedFields(settingsFields(), settingsShown);
    const r = await send({ type: "triage-settings-save", ...patch });
    if (!r.ok) {
      toast(`${MdgErrors.TEXT.settingsSaveFailed}：${r.error}`, true);
      return;
    }
    Object.assign(S.settings, patch);
    renderTagLimit();
    render(); // the batch sizes are on row 3's buttons and 粗看完成's 下一批 marks
    toast(MdgErrors.TEXT.settingsSaved);
    const included = [...el.folderToggles.querySelectorAll("input:checked")].map((x) => x.value);
    // 稍后再看 had no checkbox (its read failed): its choice stays as it was.
    if (S.toviewUnread && S.included.includes(TOVIEW)) included.push(TOVIEW);
    const same = included.length === S.included.length && included.every((id) => S.included.includes(id));
    if (S.allFolders.length && !same) {
      await storeSet(K.included, included);
      await applyIncluded(included);
    }
  });
  el.writeBtn.addEventListener("click", () => openWrite());
  el.writeScope.addEventListener("change", renderWriteScope);
  el.writeFormat.addEventListener("change", renderWriteScope);
  const digest = () => el.writeFormat.value === "digest";
  el.writeCopyBtn.addEventListener("click", () => exportDigest("copy"));
  el.writeRunBtn.addEventListener("click", () => (digest() ? exportDigest("obsidian") : runWrite()));
  el.writeMdBtn.addEventListener("click", () => (digest() ? exportDigest("download") : runWrite(true)));
  el.writeStopBtn.addEventListener("click", stopWrite);
  el.writeSettingsBtn.addEventListener("click", openOptions);
  el.openOptionsBtn.addEventListener("click", openOptions);
  // Both modes' 导出 menus carry the same 完整备份 item.
  document.addEventListener("click", async (e) => {
    if (!e.target.closest("[data-backup]")) return;
    try {
      MdgDownload.text(`MoonDigest备份-${stamp()}.json`, JSON.stringify(await buildBackup(), null, 2), "application/json");
    } catch (err) {
      toast(`导出备份失败：${err.message}`, true);
    }
  });
  el.csvBtn.addEventListener("click", () => {
    MdgDownload.text(`MoonDigest-${MdgCommon.fileName(folderTitle())}-${stamp(new Date(), false)}.csv`, buildCsv(), "text/csv;charset=utf-8");
  });
  el.helpBtn.addEventListener("click", () => el.helpDialog.showModal());
  // A download leaves the page as it was, so the 导出 menu would stay open over it.
  el.tools.addEventListener("click", (e) => e.target.closest("button") && el.tools.hidePopover());
  document.querySelector("[data-open-settings]")?.addEventListener("click", () => openSettings());
  el.toast.addEventListener("click", () => (el.toast.hidden = true));

  UI.bindSync(syncEls());
  el.bannerClose.addEventListener("click", () => (el.banner.hidden = true));

  el.viewerTags.addEventListener("click", (e) => e.target.closest("[data-vtag]") && tagPlaying());
  // T / Esc pressed while focus is in the player (viewer-frame.js): the one listener for both modes, as onKey is. 关注 takes
  // them through modeKeys; in 收藏夹, T tags the playing video and Esc closes the player, unless a dialog is open.
  // The same listener takes the video the player shows now: B站's autoplay may have moved on (viewer-frame.js).
  window.addEventListener("message", (e) => {
    const b = e.source === el.viewerFrame.contentWindow && e.origin === "https://www.bilibili.com" && e.data?.type === "mdg-viewer-video" && e.data.bvid;
    if (b) {
      if (!S.viewing || typeof b !== "string" || !/^BV\w+$/.test(b) || b === S.viewing) return;
      viewerPast = [...viewerPast, ...(S.viewer?.folders || [])];
      return showViewing(b);
    }
    const key = UI.viewerKeyFrom(e, el.viewerFrame.contentWindow);
    if (!key || modeKeys?.(key, e) != null || document.querySelector("dialog[open]")) return;
    if (key === "Escape") closeViewer();
    else tagPlaying();
  });

  el.criteriaInput.addEventListener("keydown", (e) => {
    if (composing(e) || e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    el.criteriaDialog.close("save");
  });
  el.criteriaDialog.addEventListener("close", () => {
    if (el.criteriaDialog.returnValue === "save") saveCriteria();
  });
  el.aiTagSlot.addEventListener("click", (e) => {
    if (e.target.closest("[data-tags-manage]")) openManage();
    else if (e.target.closest("[data-ai-tag]")) openAi();
  });

  // basket
  el.basketToggle.addEventListener("click", () => setBasketOpen(el.basket.classList.contains("collapsed")));
  el.basketClearBtn.addEventListener("click", clearBasket);
  el.basketList.addEventListener("click", (e) => {
    const act = e.target.closest("[data-basket]")?.dataset.basket;
    if (!act) return;
    const i = Number(e.target.closest(".basket-item").dataset.i);
    if (act === "open") openBasketItem(i);
    else if (act === "remove") {
      removeBasketItems([i]);
      toast(BASKET_REMOVED);
    }
  });
}

// The tag caps are written into the help dialog's static hints.
function renderTagLimit() {
  for (const node of document.querySelectorAll("[data-tag-limit]")) node.textContent = tagLimit();
  for (const node of document.querySelectorAll("[data-ai-new-tag-max]")) node.textContent = S.settings.triageAiNewTagMax;
}

function renderTokenHints() {
  const on = el.thinkingInput.checked;
  // ✦ AI 打标签 takes a number set here; left empty it has its own 自动 per batch (autoMaxTokens "command").
  el.titleMaxHint.textContent = `留空 = 自动（${UI.autoMaxTokens("title", TITLES_PER_REQUEST, on)}；✦ AI 打标签按每批数量另算），被截断时再调大。填了数时 ✦ AI 打标签也用它。`;
  el.analyzeMaxHint.textContent = `留空 = 自动（${UI.autoMaxTokens("analyze", 1, on)}）`;
}

// 收藏夹设置's fields as the values they store; settingsShown is what they held when the dialog opened.
const settingsFields = () => ({
  ...Object.fromEntries(NUM_FIELDS.map(([key, kind, input]) => [key, UI.numSetting(kind, el[input].value)])),
  triageThinking: el.thinkingInput.checked,
  triageAiRemoveTags: el.aiRemoveTagsInput.checked
});
let settingsShown = {};
// firstRun: the first open, before any folder is chosen, asks only for folders.
function openSettings(scrollToLimits = false, firstRun = false) {
  // Named like the button that opened it: the first run's 选择收藏夹, otherwise ⚙ 收藏夹设置 (the dialog is labelled by it).
  el.settingsHeading.textContent = firstRun ? PICK_FOLDERS : SETTINGS_NAME;
  el.settingsAi.hidden = firstRun;
  el.settingsFoldersHeading.hidden = firstRun;
  el.settingsFirstRunHint.hidden = !firstRun;
  el.folderToggles.innerHTML = S.allFolders
    .map((f) => `<label class="toggle"><input type="checkbox" name="includedFolder" value="${esc(f.id)}"${S.included.includes(String(f.id)) ? " checked" : ""} /> ${esc(f.title)} <span class="muted">${esc(f.count)}</span></label>`)
    .join("") || `<p class="dialog-hint">${esc(S.foldersRead == null ? "收藏夹列表还没加载" : S.foldersRead ? `读取收藏夹失败：${S.foldersRead}` : NO_FOLDERS)}</p>`;
  el.thinkingRow.hidden = !hasThinkingToggle();
  // The side panel may have switched platform since this page loaded: ask again which one the requests go to.
  send({ type: "triage-settings-get" }).then((r) => {
    if (!r.ok) return;
    S.settings.thinkingToggle = r.data.thinkingToggle;
    el.thinkingRow.hidden = !hasThinkingToggle();
  });
  el.intervalInput.value = S.settings.triageIntervalSec;
  el.coarseBatchInput.value = coarseBatchSize();
  el.fineBatchInput.value = fineBatchSize();
  el.aiBatchInput.value = aiBatchSize();
  el.thinkingInput.checked = Boolean(S.settings.triageThinking);
  el.titleMaxInput.value = S.settings.triageTitleMaxTokens || "";
  el.analyzeMaxInput.value = S.settings.triageAnalyzeMaxTokens || "";
  el.tagLimitInput.value = tagLimit();
  el.aiNewTagMaxInput.value = S.settings.triageAiNewTagMax;
  el.aiRemoveTagsInput.checked = S.settings.triageAiRemoveTags === true;
  renderTokenHints();
  settingsShown = settingsFields();
  el.settingsDialog.returnValue = "";
  el.settingsDialog.showModal();
  if (scrollToLimits) el.titleMaxInput.scrollIntoView({ block: "center" });
}

// it.url: another B站 page in its place (an UP's space, with bvid its own key).
function openViewer(it) {
  // Another video opened over a playing one: its folders are re-read on close too (it may have been faved meanwhile).
  viewerPast = S.viewing ? [...viewerPast, ...(S.viewer?.folders || [])] : [];
  el.viewerFrame.src = it.url || videoUrl(it.bvid);
  el.viewer.hidden = false;
  el.main.classList.add("viewing");
  showViewing(it.bvid);
  revealCard(".playing");
}

// Opening or closing the player re-lays the list (the sidebar hides, the cards narrow), so the scroll offset points
// elsewhere: the card playing (or that was) is brought back into view. 关注 does the same for its list (follow.js).
function revealCard(sel) {
  if (!followMode()) el.list.querySelector(sel)?.scrollIntoView({ block: "nearest" });
}

// The folders of videos played earlier in this viewer (B站's autoplay moved on): closing refreshes them too.
let viewerPast = [];

// The viewer now shows b: the pink card, its tag lines and T follow it. A video in no chosen folder has no lines.
function showViewing(b) {
  S.viewing = b;
  const own = viewerOf(b);
  S.viewer = own;
  render();
  // A 待播 video from a folder not open (or one played in 关注): its folders are the chosen ones whose cached list holds it.
  if (!own) {
    viewerHome(b).then((v) => {
      if (S.viewing !== b || !v) return;
      S.viewer = v;
      renderViewerTags();
    });
  }
}

// S.viewer for a video of the open view; null when it is not in it.
function viewerOf(b) {
  return S.itemMap.has(b) ? { item: S.itemMap.get(b), folders: S.mediaId === REMOVED ? null : pickerFolders(b) } : null;
}
async function viewerHome(bvid) {
  const ids = S.folders.map((f) => String(f.id));
  const got = await chrome.storage.local.get(ids.map(K.snapshot));
  const folders = ids.filter((id) => got[K.snapshot(id)]?.items?.some((x) => x.bvid === bvid));
  return folders.length ? { item: got[K.snapshot(folders[0])].items.find((x) => x.bvid === bvid), folders } : null;
}

function setBasketOpen(open) {
  el.basket.classList.toggle("collapsed", !open);
  el.basketToggle.setAttribute("aria-expanded", String(open));
}

// Likes, coins and favorites happen on Bilibili's own page, so the folder is re-read once the viewer closes.
// Only the video's own folder, when it is the one open; another folder checks its list when it is opened.
function closeViewer() {
  if (!S.viewing) return;
  const home = [...(S.viewer?.folders || []), ...viewerPast];
  const was = S.viewing ? `.card[data-bvid="${CSS.escape(S.viewing)}"]` : ".focused";
  S.viewing = "";
  S.viewer = null;
  el.viewerFrame.src = "about:blank";
  el.viewer.hidden = true;
  el.main.classList.remove("viewing");
  render();
  revealCard(was);
  if (inFolderView() && !followMode() && home.includes(String(S.mediaId))) quickSync({ force: true });
}

function cardAction(act, bvid) {
  const it = S.itemMap.get(bvid);
  if (!it) return;
  if (act === "open") openViewer(it);
  else if (act === "ask") askAi(it);
  else if (act === "unfav") fav.unfav(bvid);
  else if (act === "keep") keepOne(bvid);
  else if (act === "tag") openPicker(bvid);
  else if (act === "basket") toggleBasket(bvid);
  else if (act === "retry") retry(bvid);
  else if (act === "note") {
    S.noteOpen.add(bvid);
    renderList();
    el.list.querySelector(`.card[data-bvid="${CSS.escape(bvid)}"] [data-note]`)?.focus();
  }
  else if (act === "select") {
    pickAnchor = UI.pickCard(S.selected, [], bvid);
    showPicks();
  }
}

// A pick changes only the cards' blue marks, the selection bar and the failed group's 重试, so the list is not rebuilt;
// in 粗看完成 the selection is the next batch (its order and labels), so that tab draws everything again.
function showPicks() {
  if (S.tab === "coarse") return render();
  for (const card of el.list.querySelectorAll(".card[data-bvid]")) card.classList.toggle("selected", S.selected.has(card.dataset.bvid));
  const list = visibleItems();
  const head = el.list.querySelector(".group-head");
  if (head) head.outerHTML = failedHeadHtml(list.filter((it) => failedIn(S.tab, it)));
  renderListHeader(list);
}

function onKey(e) {
  if (composing(e) || typingIn(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if ((e.key === "Enter" || e.key === " ") && t.closest?.("button, a")) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // Before the open-dialog check: the mode decides which of its dialogs own the keys.
  const used = modeKeys?.(key, e);
  if (used != null) return used && e.preventDefault();
  if (document.querySelector("dialog[open]")) return;
  const map = {
    "?": () => el.helpDialog.showModal(),
    "/": () => el.searchInput.focus(),
    i: () => (aiTagReason() ? toast(aiTagReason()) : openAi())
  };
  const nav = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };
  const cardKeys = { d: "unfav", s: "keep", t: "tag", e: "basket", q: "ask", x: "select", o: "open", Enter: "open" };
  if (key === "Escape" && S.viewing) closeViewer();
  // Esc with nothing else open clears the selection.
  else if (key === "Escape" && S.selected.size && !document.querySelector(":popover-open")) {
    S.selected.clear();
    render();
  } else if (map[key]) map[key]();
  else if (nav[key]) moveFocus(nav[key]);
  else if (key === "u") undo();
  // 已出分拣范围 has no 保留 / 取消收藏 / 标签; 待播, 问 AI, X, O / Enter (play, like a title click) and U work there
  // (X picks for 清理 and 收藏到).
  else if (S.mediaId === REMOVED && !["e", "q", "x", "o", "Enter"].includes(key)) return;
  else if (cardKeys[key] && S.focused) cardAction(cardKeys[key], S.focused);
  else return;
  e.preventDefault();
}
