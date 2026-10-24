"use strict";
// 收藏夹's decisions (保留, 取消收藏) and their undo, and its B站 writes (fav: unfav, transfer, refav).

// ---------- decisions ----------
// An undo step is { kind, ask, blocked?, undo } (MdgTagStore.undoLast); 关注's steps (kind "mode") go on their own stack.
function pushUndo(entry) {
  MdgTagStore.pushStep(entry.kind === "mode" ? S.modeUndo : S.undo, entry);
}
// A step kept on this page (保留, 待播; tag steps are tag-store.js's): fn undoes it and returns the toast, then the page
// redraws. One that changed several videos asks first (askKind: shared.js undoAsk), so a stray U costs nothing.
const pageStep = (kind, n, askKind, fn) => ({
  kind,
  ask: askKind && n > 1 ? UI.undoAsk(askKind, n, "视频") : null,
  undo: async () => {
    const text = await fn();
    render();
    setFocus(S.focused);
    return text;
  }
});
const keepStep = (bvids) =>
  pageStep("keepMany", bvids.length, "keep", async () => {
    await patchKept(Object.fromEntries(bvids.map((b) => [b, null])));
    const it = bvids.length === 1 && S.itemMap.get(bvids[0]);
    if (it) S.focused = it.bvid;
    return it ? `已撤销：保留《${shortTitle(it)}》` : `已撤销：批量保留 ${bvids.length} 个`;
  });
// Patch one folder's decisions even after the user switched away from it; a null value deletes (the open view shows the 保留 again).
// Merged into the stored record, not written from memory: a batch running for this folder may have written it after
// the open folder read it.
function patchDecisions(mediaId, patch) {
  return lockRecords(async () => {
    const stored = await storeGet(K.decisions(mediaId), {});
    const maps = [stored, mediaId === S.mediaId && S.decisions, S.folderDecisions[mediaId]].filter(Boolean);
    for (const d of maps) {
      for (const [b, v] of Object.entries(patch)) {
        if (v) d[b] = v;
        else if (d === S.decisions) unfavGone(b);
        else delete d[b];
      }
    }
    await storeSet(K.decisions(mediaId), unfavOnly(stored));
  });
}
// 保留 is one list for every folder; a null value deletes. The patch goes onto the page's copy at once and onto the stored
// list by read-modify-write, so a 保留 another tab set meanwhile stays; the page then takes what was written.
function patchKept(patch) {
  const apply = (kept) => {
    for (const [b, v] of Object.entries(patch)) {
      if (v) kept[b] = v;
      else delete kept[b];
    }
    return kept;
  };
  apply(S.kept);
  for (const [b, v] of Object.entries(patch)) {
    if (v) S.decisions[b] = v;
    else delete S.decisions[b];
  }
  return storeEdit(K.kept, {}, apply).then((kept) => kept && followKept(kept));
}
// A 取消收藏 undone or overtaken by a re-favorite on B站: the video's 保留, if any, shows again.
function unfavGone(bvid) {
  if (S.kept[bvid]) S.decisions[bvid] = S.kept[bvid];
  else delete S.decisions[bvid];
}
// aid and title let 最近取消收藏 re-favorite the video after it has left the folder list.
// batch: when the batch 取消收藏 that made it started, so 最近取消收藏 can re-favorite that batch in one go.
// elsewhere: the video is still in another chosen folder, so B站 pages other than a favorites page do not say 已取消收藏.
const unfavRecord = (it, at, batch, elsewhere) => ({ action: "unfav", at, aid: it.aid, ...(it.ogv && { ogv: true }), title: it.title, ...(batch && { batch }), ...(elsewhere && { elsewhere }) });
// The videos of chosen folders other than mediaId, by their cached lists. 稍后再看 is not a favorite, so it does not count.
async function favedElsewhere(mediaId) {
  const others = chosenOtherIds(mediaId).filter((id) => id !== TOVIEW);
  const got = await chrome.storage.local.get(others.map(K.snapshot));
  return new Set(others.flatMap((id) => got[K.snapshot(id)]?.bvids || []));
}
// 所有收藏夹: still in a chosen folder once it leaves the folders in `gone`.
const stillIn = (it, gone) => it.folders.some((f) => f !== TOVIEW && !gone.includes(f));
const shortTitle = (it) => (it.title.length > 24 ? `${it.title.slice(0, 24)}…` : it.title);

// S on a card: 保留 belongs to the video, so it shows in every folder.
// A B站 write this video waits for: 「正在移动…」, "" when none. Its card's 保留 is off with it, and S says it.
const waitingWhy = (bvid) => {
  const verb = fav.state().pending(bvid);
  return verb ? `正在${verb}…` : "";
};
function keepOne(bvid) {
  const it = S.itemMap.get(bvid);
  if (!it) return;
  if (waitingWhy(bvid)) return toast(waitingWhy(bvid), true);
  const prev = S.decisions[bvid];
  if (prev?.action === "keep") return;
  if (prev?.action === "unfav") return toast(KEEP_UNFAVED, true);
  const before = visibleItems();
  const written = patchKept({ [bvid]: { action: "keep", at: Date.now() } });
  pushUndo(keepStep([bvid]));
  toast(`已保留《${shortTitle(it)}》${UNDO}`);
  render();
  advanceFrom(bvid, before);
  return written;
}

// ---------- 收藏夹's B站 writes ----------
// Every write to Bilibili's folders goes through fav; writes.js sends them (one batch at a time as runs' "fav", chunks,
// limit holds, which folders were just written). fav asks, plans the requests, keeps the local records after each chunk,
// tells the result and pushes the undo step. fav.state() is what the page draws and its reads check.
// A batch's run: { job, verb, done, total, mediaId: where it started, folder: where it writes now, to/toName for 移动 / 复制 }.
const favRun = (p) => p && { ...p.meta, job: p.job, name: p.name, done: p.done, total: p.total, folder: String(p.folders[0] ?? p.meta.mediaId) };
// A batch's progress words: the pill's line and its row-3 button alike.
const runLine = (run) => (run.job === "transfer" ? `${run.verb}到「${run.toName}」${run.done}/${run.total}${runWhere(run)}` : `${run.verb}中${unfavWhere(run)} ${run.done}/${run.total}${runWhere(run)}`);
const favLine = (p) => runLine(favRun(p));
const W = MdgWrites.create({
  runs,
  lane: "fav",
  send: (msg) => (render(), send(msg)), // redrawn first, so the cards and buttons show what is pending
  line: favLine,
  settleMs: globalThis.__TRIAGE_SETTLE_MS // the selftest's; undefined leaves writes.js's 3 s
});
// Bilibili takes 稍后再看 (and 收藏到 from 已出分拣范围) one video per request: one per chunk keeps the count exact on a
// failure. Other folders take 20, a second apart.
const chunkSize = (one) => (one ? 1 : 20);
const chunkGap = (one) => (one ? 300 : 1000);
function chunksOf(items, one, make) {
  const out = [];
  for (let i = 0; i < items.length; i += chunkSize(one)) out.push({ ...make(items.slice(i, i + chunkSize(one))), gap: chunkGap(one) });
  return out;
}
const refavChunk = (f, it) => ({ msg: { type: "triage-refav", mediaId: f, aid: favRes(it) }, keys: [it.bvid], folders: [f], item: favRef(it), gap: chunkGap(true) });
async function refavDone({ folders: [f], keys: [bvid] }) {
  bumpCount(f, 1);
  await patchDecisions(f, { [bvid]: null });
  renderStatus();
}
// A B站 batch write that failed midway: what went through stays.
const cutShort = (what, done, error, rest = "") => `${what}中断（已完成 ${done} 个${rest}）：${error}`;
const stopWords = UI.stopWords;
const undoBlocked = () => UI.busyText(W.busy(), { undo: true });
const busyError = (r) => r.error || UI.busyText(r.busy);

// Re-favorites items ([{ bvid, aid, ogv }]) into mediaId, one per request; the first failure stops it. It changes Bilibili,
// so it runs to the end even after another folder opens. Returns { n, rest, error }.
async function refavInto(mediaId, items) {
  const r = await W.run("refav", REFAV, { verb: REFAV, chunks: items.map((it) => refavChunk(mediaId, it)), folders: [mediaId], meta: { mediaId, verb: REFAV }, onChunk: refavDone });
  render();
  const went = new Set(r.keys || []);
  return { n: r.done, rest: items.filter((it) => !went.has(it.bvid)), error: busyError(r), stopped: r.stopped };
}

// 所有收藏夹's batch 取消收藏 undone: each video back in every folder it was taken out of, as one run.
async function refavGone(gone) {
  const chunks = Object.entries(gone).flatMap(([f, items]) => items.map((it) => refavChunk(f, it)));
  const r = await W.run("refav", REFAV, {
    verb: REFAV,
    chunks,
    folders: [String(S.mediaId)],
    meta: { mediaId: String(S.mediaId), verb: REFAV },
    async onChunk(c) {
      await refavDone(c);
      const [f] = c.folders;
      const it = S.itemMap.get(c.keys[0]);
      if (!it?.folders) return;
      it.folders = [...new Set([...it.folders, f])];
      it.left = (it.left || []).filter((x) => x !== f);
      if (S.decisions[it.bvid]?.action === "unfav") unfavGone(it.bvid);
    }
  });
  render();
  const rest = {};
  for (const c of chunks.slice(r.done)) (rest[c.folders[0]] ||= []).push(c.item);
  return { n: r.done, rest, error: busyError(r), stopped: r.stopped };
}

// The U step of a 取消收藏: Bilibili favorites them again, so it waits for a running batch.
const favStep = (n, ask, undo) => ({ kind: "fav", ask: n > 1 ? ask : null, blocked: undoBlocked, undo });
const refavAsk = (n) => [`在 B站重新收藏这 ${n} 个视频？`, `<p>撤销上一步的${UNFAV_MANY}。</p>`, `重新收藏 ${n} 个`];
const redraw = () => (render(), setFocus(S.focused), "");

// An undo of B站 writes cut short, by a failure or by 停止 (what went through stays undone); "" when it ran through.
// n: re-favorited, left: not yet (counts are left out when null); there: where the rest waits when U cannot take it
// (another view's 最近取消收藏), else U takes the rest. 停止 says it as every stopped batch does (stopWords).
function cutText(error, stopped, { n = null, left = null, there = "" } = {}) {
  if (error) return `撤销中断（${n != null ? `已重新收藏 ${n} 个，` : ""}${left != null ? `剩余 ${left} 个` : ""}${there ? `在${there}里` : `可再按 U ${MdgErrors.LABEL.retry}`}）：${error}`;
  if (stopped) return `${stopWords("撤销", { done: n ?? 0, total: (n ?? 0) + (left ?? 1) })}，${there ? `未完成的在${there}里` : "可再按 U 撤销"}`;
  return "";
}
// U on a batch 取消收藏 in one folder: back into it. Elsewhere the ones left stay under its 最近取消收藏.
function unfavManyStep(mediaId, items) {
  return favStep(items.length, refavAsk(items.length), async () => {
    const { n, rest, error, stopped } = await refavInto(mediaId, items);
    const here = S.mediaId === mediaId;
    const where = here ? "" : `「${folderName(mediaId)}」`;
    const cut = cutText(error, stopped, { n, left: rest.length, there: here ? "" : `它的${RECENT_UNFAV}` });
    if (cut && here) pushUndo(unfavManyStep(mediaId, rest));
    toast(cut ? `${where}${cut}` : `${where}已重新收藏 ${n} 个`, Boolean(error));
    return redraw();
  });
}
// U on 所有收藏夹's batch 取消收藏: each video back in every folder it left (gone: folder → [{ bvid, aid, ogv }]). Elsewhere
// the ones left stay under each folder's 最近取消收藏.
function goneStep(items, gone) {
  return favStep(items.length, refavAsk(items.length), async () => {
    const { rest, error, stopped } = await refavGone(gone);
    const here = S.mediaId === ALL;
    const left = items.filter((x) => Object.values(rest).some((list) => list.some((y) => y.bvid === x.bvid)));
    const cut = cutText(error, stopped, { n: items.length - left.length, left: left.length, there: here ? "" : `各收藏夹的${RECENT_UNFAV}` });
    if (cut && here) pushUndo(goneStep(left, rest));
    toast(cut ? `${here ? "" : `「${folderName(ALL)}」`}${cut}` : `已重新收藏 ${items.length} 个`, Boolean(error));
    return redraw();
  });
}
// U on one 取消收藏 (D): back into each folder it left (prevs: folder → its record before), and its record back.
function unfavStep(it, prev, prevs) {
  return favStep(1, null, async () => {
    const view = S.view.current;
    toast(`正在重新收藏《${shortTitle(it)}》…`);
    const back = [];
    let cut = "";
    let failed = false;
    for (const [mediaId, before] of Object.entries(prevs)) {
      const { n, error, stopped } = await refavInto(mediaId, [favRef(it)]);
      if (!n) {
        cut = cutText(error, stopped);
        failed = Boolean(error);
        break;
      }
      await patchDecisions(mediaId, { [it.bvid]: before });
      back.push(mediaId);
    }
    if (!view.alive) return "";
    // The folders it is back in show on the card; it is listed again (no 取消收藏 record) once it is in one.
    if (it.folders) {
      it.folders = [...new Set([...it.folders, ...back])];
      it.left = (it.left || []).filter((f) => !it.folders.includes(f));
      if (back.length && prev) S.decisions[it.bvid] = prev;
      else if (back.length) delete S.decisions[it.bvid];
    }
    if (cut) {
      pushUndo(unfavStep(it, prev, Object.fromEntries(Object.entries(prevs).filter(([f]) => !back.includes(f)))));
      toast(cut, failed);
      return redraw();
    }
    toast(`已撤销：取消收藏《${shortTitle(it)}》`);
    S.focused = it.bvid;
    return redraw();
  });
}

const fav = {
  // D on a card. It does not wait for a batch; only a video the running batch still has to write is refused. A B站
  // limit fails at once (a key press does not wait ten minutes).
  async unfav(bvid) {
    const it = S.itemMap.get(bvid);
    const pending = W.pending(bvid);
    if (!it || S.decisions[bvid]?.action === "unfav") return;
    if (pending) return toast(pending === UNFAV ? `这个视频已在等待${UNFAV}` : `这个视频在等待${pending}，结束后再取消收藏`, true);
    const prev = S.decisions[bvid] || null;
    const before = visibleItems();
    const view = S.view.current;
    // 所有收藏夹 items carry .folders: 取消收藏 asks which when there are several.
    let folders = it.folders ? [...it.folders] : [S.mediaId];
    if (folders.length > 1) folders = await pickUnfavFolders(it);
    if (!folders.length) return;
    // The data waits for B站, the focus does not (DESIGN 改 B站 的操作和撤销): the card shows 正在取消收藏… and the next
    // card takes the focus now; B站's answer leaves the focus wherever it is by then.
    const sending = W.single(UNFAV, folders.map((f) => ({ msg: { type: "triage-unfav", mediaId: f, aids: [favRes(it)] }, keys: [bvid], folders: [f] })), ({ folders: [f] }) => bumpCount(f, -1));
    advanceFrom(bvid, before);
    const r = await sending;
    if (r.error) toast(`取消收藏失败：${r.limited ? MdgErrors.TEXT.biliThrottled : r.error}`, true);
    folders = folders.slice(0, r.done);
    if (!folders.length) return render();
    const rec = unfavRecord(it, Date.now(), 0, it.folders ? stillIn(it, folders) : (await favedElsewhere(folders[0])).has(bvid));
    const prevs = Object.fromEntries(folders.map((f) => [f, (f === S.mediaId ? S.decisions : S.folderDecisions[f])?.[bvid] || null]));
    for (const f of folders) await patchDecisions(f, { [bvid]: rec });
    // After a folder switch the record is saved under its folder; the undo step would point at a video no longer listed.
    if (!view.alive) return;
    const left = it.folders ? (it.folders = it.folders.filter((f) => !folders.includes(f))) : [];
    if (it.folders) it.left = [...new Set([...(it.left || []), ...folders])];
    if (it.folders && !left.length) S.decisions[bvid] = rec;
    pushUndo(unfavStep(it, prev, prevs));
    const from = left.length ? `从「${folders.map(folderName).join("、")}」` : "";
    toast(`已${from}取消收藏《${shortTitle(it)}》${UNDO}`);
    render();
  },

  // The selection bar's and 「按 AI 判断」's batch 取消收藏. It runs to the end even after another folder opens;
  // 所有收藏夹 goes folder by folder.
  async unfavMany(list) {
    if (!list.length || W.busy()) return;
    const all = S.mediaId === ALL;
    const folders = all
      ? await pickBatchUnfavFolders(list)
      : (await askConfirm(unfavManyTitle(list.length), UI.confirmList(list.map((it) => it.title)), unfavManyOk(list.length), { danger: true })) ? [String(S.mediaId)] : [];
    if (!folders.length) return;
    const mediaId = String(S.mediaId);
    const view = S.view.current;
    const batch = Date.now();
    const gone = {}; // folder → the videos taken out of it
    const elsewhere = all ? null : await favedElsewhere(mediaId);
    const chunks = folders.flatMap((f) =>
      chunksOf(all ? list.filter((it) => it.folders.includes(f)) : list, f === TOVIEW, (items) => ({ msg: { type: "triage-unfav", mediaId: f, aids: items.map(favRes) }, keys: items.map((it) => it.bvid), folders: [f], items }))
    );
    const r = await W.run("unfav", UNFAV_MANY, {
      verb: UNFAV,
      chunks,
      folders: [mediaId],
      meta: { mediaId, verb: UNFAV },
      async onChunk({ folders: [f], items }) {
        bumpCount(f, -items.length);
        const at = Date.now();
        const left = (it) => (all ? stillIn(it, [f, ...Object.keys(gone).filter((g) => gone[g].some((x) => x.bvid === it.bvid))]) : elsewhere.has(it.bvid));
        await patchDecisions(f, Object.fromEntries(items.map((it) => [it.bvid, unfavRecord(it, at, batch, left(it))])));
        (gone[f] ||= []).push(...items.map(favRef));
      }
    });
    if (r.busy) return;
    const done = r.done;
    const fail = r.error && `${all || S.mediaId !== mediaId ? `「${folderName(r.chunk.folders[0])}」` : ""}${cutShort(UNFAV_MANY, done, r.error)}`;
    const stop = r.stopped && `${S.mediaId !== mediaId ? `「${folderName(mediaId)}」` : ""}${stopWords(UNFAV_MANY, r)}`;
    // After a failure or 停止 the ones done are still recorded and undoable; the toast says how far it got.
    const tell = (msg, undoHint) => toast(fail || stop ? `${fail || stop}${undoHint}` : msg, Boolean(fail));
    if (!done && (fail || stop)) toast(fail || stop, Boolean(fail));
    else if (done && all && view.alive) {
      // As a single 取消收藏 here: the video leaves those folders, and the view once it is in none.
      const at = Date.now();
      const listed = new Map(list.map((it) => [it.bvid, it]));
      for (const [f, items] of Object.entries(gone)) {
        for (const { bvid } of items) {
          // A folder load mid-batch (rebuildAll) may have dropped it from the list: it comes back from the batch's own.
          let it = S.itemMap.get(bvid);
          if (!it) setItems([...S.items, (it = listed.get(bvid))]);
          it.folders = it.folders.filter((x) => x !== f);
          it.left = [...new Set([...(it.left || []), f])];
          if (!it.folders.length) S.decisions[bvid] = unfavRecord(it, at, batch);
        }
      }
      const videos = list.filter((it) => Object.values(gone).some((items) => items.some((x) => x.bvid === it.bvid)));
      pushUndo(goneStep(videos.map(favRef), gone));
      tell(`已从 ${Object.keys(gone).length} 个收藏夹取消收藏 ${videos.length} 个视频${UNDO}`, `${UNDO}已完成的`);
    } else if (done && all) {
      tell(`已从 ${Object.keys(gone).length} 个收藏夹取消收藏，可在各收藏夹的${RECENT_UNFAV}里${REFAV}`, `，已完成的可在各收藏夹的${RECENT_UNFAV}里${REFAV}`);
    } else if (done && S.mediaId === mediaId) {
      // By folder, not by view: the records are the folder's, so back in it after a switch the batch is still undoable.
      const went = new Set(r.keys);
      pushUndo(unfavManyStep(mediaId, list.filter((it) => went.has(it.bvid)).map(favRef)));
      tell(`${KIND_NAME.unfav} ${done} 个${UNDO}`, `${UNDO}已完成的`);
    } else if (done) {
      // Elsewhere they are saved under their folder and listed in its 最近取消收藏, where they can be re-favorited.
      tell(`「${folderName(mediaId)}」已取消收藏 ${done} 个，可在它的${RECENT_UNFAV}里${REFAV}`, `，已完成的可在它的${RECENT_UNFAV}里${REFAV}`);
    }
    render();
  },

  // 移动 / 复制 (收藏到 from 已出分拣范围) of the selection. It runs to the end even after another folder opens. A new
  // target folder is made only once this run has the slot.
  async transfer(list) {
    if (!list.length || W.busy()) return;
    const from = String(S.mediaId);
    const ask = await askTransfer(list);
    if (!ask) return;
    const { how, target } = ask;
    const add = how === "add"; // from 已出分拣范围: no source folder on Bilibili
    const move = how === "move";
    const verb = UI.transferVerb[how];
    const meta = { mediaId: from, verb, to: target.id, toName: folderName(target.id) };
    const plainItem = ({ removedAt, movedTo, hidden, from, ...it }) => it;
    const stayed = { n: 0, error: "" }; // moved out of 稍后再看 into the target, but B站 kept them in 稍后再看 too
    const r = await W.run("transfer", verb, async () => { // named by its verb (移动, 复制, 收藏) where others wait on it
      if (target.create) {
        const made = await send({ type: "triage-folder-create", title: target.create, privacy: target.privacy });
        if (!made.ok) return void toast(`新建收藏夹失败：${made.error}`, true);
        meta.to = String(made.data.id);
        meta.toName = made.data.title;
        // Chosen for triage right away, without reloading the folder list.
        const f = { id: Number(meta.to), title: meta.toName, count: 0 };
        S.allFolders.push(f);
        S.folders.push(f);
        S.included = await MdgLimits.update(K.included, (stored) => [...new Set([...(stored || []).map(String), meta.to])]);
      }
      const { to, toName } = meta;
      const chunks = chunksOf(list, add || from === TOVIEW, (items) => ({ msg: { type: "triage-transfer", from: add ? "" : from, to, aids: items.map(favRes), move }, keys: items.map((it) => it.bvid), folders: [from, to], items }));
      return {
        verb,
        chunks,
        folders: [from, to],
        meta,
        // Folders are not read while being written, so both cached lists follow each chunk here instead of by a sync.
        async onChunk({ items }, reply) {
          // Read per chunk: ticking or unticking the target meanwhile takes effect for the rest.
          const chosen = S.included.includes(to);
          const kept = new Set((reply?.data?.stayed || []).map(String));
          stayed.n += kept.size;
          if (kept.size) stayed.error = reply.data.stayedError;
          const left = items.filter((it) => !kept.has(String(favRes(it))));
          bumpCount(to, items.length);
          if (move) bumpCount(from, -left.length);
          if (chosen) await patchSnapshot(to, { add: items.map(plainItem) }, Boolean(target.create));
          if (add) {
            if (chosen) await dropRemoved(items.map((it) => it.bvid));
            else await addMovedToRemoved(from, items.map(plainItem), { id: to, title: toName });
          }
          if (move && left.length) {
            const gone = new Set(left.map((it) => it.bvid));
            // One queued step, so a folder save in between never sees the videos gone from here but not yet recorded.
            await lockRecords(async () => {
              await patchSnapshotNow(from, { drop: [...gone] });
              if (!chosen) await addMovedNow(from, left, { id: to, title: toName });
            });
            if (S.mediaId === from) setItems(S.items.filter((it) => !gone.has(it.bvid)));
          }
        }
      };
    });
    if (!r.total) return;
    const { to, toName } = meta;
    const where = S.mediaId === from ? "" : `「${folderName(from)}」`;
    if (r.error) toast(`${where}${cutShort(`${verb}到「${toName}」`, r.done, r.error)}`, true);
    else if (r.stopped) toast(`${where}${stopWords(`${verb}到「${toName}」`, r)}`);
    // A folder-list load meanwhile (分拣设置 saved) may have listed it already, or dropped it while Bilibili lagged.
    const made = target.create && S.allFolders.find((x) => String(x.id) === to);
    if (made && !el.folderSelect.querySelector(`option[value="${to}"]`)) {
      el.folderSelect.querySelector(`option[value="${REMOVED}"]`)?.previousElementSibling?.before(new Option(`${toName} (${made.count})`, to));
    }
    if (stayed.n && !r.error && !r.stopped) toast(`${where}${stayed.n} 个已收藏到「${toName}」，但没能从${MdgErrors.LABEL.watchLater}移除：${stayed.error}`, true);
    else if (r.done === list.length) {
      toast(`${where}已${verb} ${r.done} 个到「${toName}」${(move || add) && !S.included.includes(to) ? `，它们在「${REMOVED_NAME}」里，勾选这个收藏夹后会自动找回` : ""}`);
    }
    render();
  },

  // 最近取消收藏's 重新收藏 of one video.
  async refav(bvid) {
    const d = S.decisions[bvid];
    if (!d?.aid || W.busy()) return;
    const mediaId = S.mediaId;
    const { error } = await refavInto(String(mediaId), [favRef({ bvid, ...d })]);
    if (error) return toast(`重新收藏失败：${error}`, true);
    if (mediaId !== S.mediaId) return;
    toast(`已重新收藏《${d.title || bvid}》`);
    quickSync({ force: true });
  },

  // 最近取消收藏's 这批全部重新收藏: every record one batch 取消收藏 left here.
  async refavBatch(batch) {
    const items = unfavBatchItems(batch);
    if (!items.length || W.busy()) return;
    const mediaId = String(S.mediaId);
    const { n, rest, error, stopped } = await refavInto(mediaId, items);
    const where = S.mediaId === mediaId ? "" : `「${folderName(mediaId)}」`;
    if (error) toast(`${where}${cutShort(REFAV, n, error, `，剩余 ${rest.length} 个可再点${MdgErrors.LABEL.retry}`)}`, true);
    else if (stopped) toast(`${where}${stopWords(REFAV, { done: n, total: items.length })}`);
    else toast(`${where}已重新收藏这批 ${n} 个`);
    if (!where) quickSync({ force: true });
  },

  // What the page draws and checks: busy (the running batch's name, "" when none), run (it, once planned: favRun),
  // pending(bvid) (the verb a video waits for, ""), writing(folder, since?) (not to be read now). Its pill line is
  // favLine, in runs' table.
  state() {
    return { busy: W.busy(), run: favRun(W.progress()), pending: W.pending, writing: W.writing };
  }

};

// U undoes the last step of the mode it is pressed in.
function undo() {
  return MdgTagStore.undoLast(followMode() ? S.modeUndo : S.undo, { confirm: (...a) => askConfirm(...a), say: (text, error) => toast(text, error) });
}

// Batch buttons act on the selected cards listed (none when filters hide them all), otherwise on every card with this
// verdict (none without one).
// Not processed, nor waiting in a running B站 write (a batch 取消收藏 or 移动 will decide it).
function batchList(verdict) {
  const list = visibleItems().filter((it) => !isProcessed(it.bvid) && !W.pending(it.bvid));
  return S.selected.size ? selectedIn(list) : verdict == null ? [] : list.filter((it) => verdictOf(it).verdict === verdict);
}

// 所有收藏夹: which folders to take this batch out of, each with how many of its videos (all checked by default); the
// button counts the videos left in a checked folder. [] on 取消.
async function pickBatchUnfavFolders(list) {
  const ids = S.folders.map((f) => String(f.id)).filter((f) => list.some((it) => it.folders?.includes(f)));
  const boxes = ids
    .map((f) => `<label class="toggle"><input type="checkbox" name="batchUnfavFolder" value="${esc(f)}" checked /> 「${esc(folderName(f))}」· ${list.filter((it) => it.folders.includes(f)).length} 个</label>`)
    .join("");
  const ask = askConfirm(unfavManyTitle(list.length), `<p>从勾选的收藏夹取消收藏。重复收藏的视频，从每个勾选的收藏夹都取消。</p>${boxes}${UI.confirmList(list.map((it) => it.title))}`, unfavManyOk(list.length), { danger: true });
  const checked = () => [...el.confirmBody.querySelectorAll("input:checked")].map((x) => x.value);
  el.confirmBody.onchange = () => {
    const n = list.filter((it) => it.folders.some((f) => checked().includes(f))).length;
    el.confirmOk.textContent = unfavManyOk(n);
    el.confirmOk.setAttribute("aria-label", el.confirmOk.textContent);
    UI.setReason(el.confirmOk, n ? "" : PICK_ONE);
  };
  const ok = await ask;
  el.confirmBody.onchange = null;
  UI.setReason(el.confirmOk, "");
  return ok ? checked() : [];
}

// 移动/复制 takes every selected card still in the folder here, 保留 ones too (unlike 取消收藏, which skips them).
const transferList = () => selectedIn(visibleItems()).filter((it) => it.aid && S.decisions[it.bvid]?.action !== "unfav");

// The shared 移动 / 复制 dialog (shared.js askTransfer) with this folder's targets.
function askTransfer(list) {
  const from = String(S.mediaId);
  const add = from === REMOVED;
  const noAid = selectedIn(visibleItems()).filter((it) => !it.aid).length;
  return UI.askTransfer({
    title: add ? `在 B站把这 ${list.length} 个视频收藏到` : `在 B站移动或复制这 ${list.length} 个视频`,
    n: list.length,
    hows: add ? ["add"] : ["copy", "move"],
    list: `${UI.confirmList(list.map((it) => it.title))}${noAid ? `<p class="dialog-hint">另有 ${noAid} 个缺少视频编号（很早以前留下的记录），不能${add ? "收藏" : "移动或复制"}。</p>` : ""}`,
    label: "目标收藏夹",
    options: S.allFolders.filter((f) => String(f.id) !== from && String(f.id) !== TOVIEW).map((f) => [String(f.id), `${f.title} (${f.count})`]),
    newText: "新建收藏夹…",
    newPlaceholder: "新收藏夹名称",
    newMax: 20,
    privacy: true,
    how: add ? "" : "复制：原收藏夹里也留着。移动：从原收藏夹移走。",
    note: (v) =>
      v === "new" || S.included.includes(v)
        ? ""
        : add
          ? `「${esc(folderName(v))}」没有勾选分拣：收藏后这些视频仍在「${REMOVED_NAME}」。<br>以后在${SETTINGS_NAME}里勾选它，会自动找回。`
          : `「${esc(folderName(v))}」没有勾选分拣：移动过去的视频会进「${REMOVED_NAME}」。<br>以后在${SETTINGS_NAME}里勾选它，这些视频会自动找回。复制不受影响。`
  });
}

// Folders are not read while a run writes them (fav.state().writing), so both cached lists change here instead of by a sync: the target
// gains the videos (a new folder starts with exactly these), the source loses them without counting them as having left
// every folder (已出分拣范围). A folder with no cached list is left to its first load.
function patchSnapshot(...args) {
  return lockRecords(() => patchSnapshotNow(...args));
}
// patchSnapshot for a fn already running in lockRecords.
async function patchSnapshotNow(mediaId, { add = [], drop = [] }, created = false) {
  const key = K.snapshot(mediaId);
  const got = await chrome.storage.local.get([key, K.left]);
  const snap = got[key];
  if (!snap && !created) return;
  const old = snap || { bvids: [], invalid: [], titles: {}, items: [], ids: [], intro: "" };
  const gone = new Set(drop);
  const fresh = add.filter((it) => !old.bvids.includes(it.bvid));
  const added = fresh.map((it) => it.bvid);
  const keep = (b) => !gone.has(b);
  // The trail follows this move like a folder diff would: added here forgets this folder, dropped from here adds it.
  const left = { ...got[K.left] };
  for (const it of add) forgetLeft(left, it.bvid, String(mediaId));
  const folder = { id: String(mediaId), title: folderName(mediaId) };
  const at = Date.now();
  for (const b of drop) noteLeft(left, b, folder, at);
  await store({
    [K.left]: left,
    [key]: {
      ...old,
      bvids: [...added, ...old.bvids.filter(keep)],
      invalid: [...fresh.filter((it) => it.invalid).map((it) => it.bvid), ...(old.invalid || []).filter(keep)], // as saveSnapshot
      titles: { ...old.titles, ...Object.fromEntries(fresh.map((it) => [it.bvid, it.title])) },
      items: [...fresh, ...(old.items || []).filter((it) => keep(it.bvid))],
      ids: old.ids ? [...added, ...old.ids.filter(keep)] : old.ids
    }
  });
}

// Moved to a folder outside triage: like any video that left every chosen folder, it goes to 已出分拣范围, marked with
// where it went. Ticking that folder brings it back (recoverRemoved).
function addMovedToRemoved(...args) {
  return lockRecords(() => addMovedNow(...args));
}
// addMovedToRemoved for a fn already running in lockRecords.
async function addMovedNow(from, items, movedTo) {
  const others = chosenOtherIds(from);
  const got = await chrome.storage.local.get([K.removed, K.left, ...others.map(K.snapshot)]);
  const otherBvids = new Set(others.flatMap((id) => got[K.snapshot(id)]?.bvids || []));
  const at = Date.now();
  const source = from === REMOVED ? null : { id: from, title: folderName(from) };
  const { removed, left } = moveToRemoved(got[K.removed] || {}, got[K.left] || {}, items, otherBvids, source, at, movedTo);
  if (!(await store({ [K.removed]: removed, [K.left]: left }))) return;
  if (S.mediaId === REMOVED) {
    for (const it of items) {
      const rec = removed[it.bvid];
      if (!rec) continue;
      const shown = S.itemMap.get(it.bvid);
      if (shown) Object.assign(shown, { removedAt: at, movedTo, from: rec.from });
      else S.items.unshift({ ...it, removedAt: at, movedTo, from: rec.from });
    }
    setItems(S.items);
  }
  S.removedCount = Object.keys(removed).length;
  renderTop();
}

// Newly ticked folders take back their videos from 已出分拣范围 at once, without waiting for the folder to be opened.
async function recoverRemoved(ids) {
  if (!Object.keys(await storeGet(K.removed, {})).length) return;
  let n = 0;
  for (const id of ids) {
    const r = await send({ type: "triage-folder-ids", mediaId: id });
    if (r.ok) n += await dropRemoved(r.data.bvids);
  }
  if (n) {
    toast(`已从「${REMOVED_NAME}」找回 ${n} 个视频`);
    renderTop();
  }
}

function batchKeep(list) {
  if (!list.length) return;
  const at = Date.now();
  const written = patchKept(Object.fromEntries(list.map((it) => [it.bvid, { action: "keep", at }])));
  pushUndo(keepStep(list.map((it) => it.bvid)));
  toast(`已标记保留 ${list.length} 个${UNDO}`);
  render();
  return written;
}
