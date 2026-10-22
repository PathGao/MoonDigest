// The one tag pipeline of 收藏夹 (fav-*.js), 关注 (follow.js) and 摘读记录 (history.js): making, renaming, recoloring,
// describing and deleting a tag, tagging items, the cap, the AI's room, U, the ✦ AI 打标签 run and its 应用. A page makes
// one store (create) with an adapter that says only what differs: where the tags and the item → tags map live (one of
// the backends below), the items, the scope (收藏夹's folder), the cap and what happens past it, the noun. The backends
// are the only page code that writes a tag key (conventions.selftest.js checks it). triage.html and history.html load
// this after shared.js, runs.js and tag-picker.js; tag-store.selftest.js tests it in node.
(() => {
  const UI = globalThis.TriageUi;
  const { cleanTagName, nextTagColor, newTagId } = MdgTagCore;
  const { sp } = UI;
  const sameIds = (x = [], y = []) => x.length === y.length && x.every((id) => y.includes(id));

  // ----- U: a page's steps, an array, newest last (收藏夹 keeps its 保留 and B站 writes there too) -----
  // A step is { ask?, blocked?, undo }: ask ([title, body, button]) is confirmed first, blocked() ("" or why) refuses
  // it, undo() undoes it and resolves its toast, or false when its write failed (the step then stays).
  function pushStep(steps, step) {
    steps.push(step);
    if (steps.length > MdgLimits.TRIAGE_UNDO_STEPS) steps.shift();
  }
  async function undoLast(steps, { confirm, say }) {
    const top = steps.at(-1);
    if (!top) return say(MdgErrors.TEXT.noUndo);
    const blocked = top.blocked?.();
    if (blocked) return say(blocked, true);
    if (top.ask && (!(await confirm(top.ask[0], top.ask[1], top.ask[2] || "撤销")) || steps.at(-1) !== top || top.blocked?.())) return;
    steps.pop();
    const text = await top.undo();
    if (text === false) return void steps.push(top);
    if (text) say(text);
  }

  // ----- where the tags live -----
  // Each backend is { tags(), map(), write(fn) }: write runs fn({ tags, map }) on what is stored now and stores what it
  // returns (unchanged parts the same objects), one write at a time; true once stored, false when storing failed (the
  // page's writer has said why). put(part) gets only the changed parts ({ tags?, map? }) after they are stored.
  const changedParts = (cur, next) => Object.fromEntries(["tags", "map"].filter((k) => next[k] !== cur[k]).map((k) => [k, next[k]]));

  // 收藏夹: the page holds them (get()); save(patch) is its storage write (echo bookkeeping, failure toast) → stored?
  function local({ keys, get, put, save }) {
    let queue = Promise.resolve();
    function write(fn) {
      const run = queue.then(async () => {
        const cur = get();
        const part = changedParts(cur, fn(cur));
        if (!Object.keys(part).length) return true;
        if (!(await save(Object.fromEntries(Object.entries(part).map(([k, v]) => [keys[k], v]))))) return false;
        put(part);
        return true;
      });
      queue = run.catch(() => {});
      return run;
    }
    // 清理 forgets videos in one write of several keys: the map without them, as a patch for that write (put now).
    function without(itemKeys) {
      const map = { ...get().map };
      for (const k of itemKeys) delete map[k];
      put({ map });
      return { [keys.map]: map };
    }
    return { tags: () => get().tags, map: () => get().map, write, without };
  }

  // 关注: follow_tags / follow_tag_map, under the lock the background takes for its own follow_* writes (a sync, B站
  // pages' 「+ UP 标签」). set is the page's write, which says a failure and resolves false.
  function follow({ get, put, set }) {
    async function write(fn) {
      let part = null;
      try {
        await MdgLimits.updateFollow(["tags", "tag_map"], (s) => {
          const cur = { tags: s.tags || [], map: s.tag_map || {} };
          part = changedParts(cur, fn(cur));
          if (!Object.keys(part).length) return null;
          return { ...("tags" in part && { tags: part.tags }), ...("map" in part && { tag_map: part.map }) };
        }, async (o) => {
          if (!(await set(o))) throw new Error("关注的标签没有存上");
        });
      } catch (e) {
        console.error("[triage] tag write failed", e);
        return false;
      }
      put(part);
      return true;
    }
    return { tags: () => get().tags, map: () => get().map, write };
  }

  // 摘读记录: the marks record (KEYS.readingMarks: 星标 and tags per record), one change at a time across pages. A tag
  // write changes its records through edit(marks, keys, change) (the page's: a record keeps its 星标 and address, one
  // left with neither drops out); update(edit) is the raw write the page's 星标 goes through. fail(error) says a failure.
  function marks({ get, put, edit, fail }) {
    const mapOf = (m) => Object.fromEntries(Object.entries(m.items || {}).filter(([, it]) => it.tags?.length).map(([k, it]) => [k, it.tags]));
    async function update(change) {
      try {
        put(await MdgLimits.updateReadingMarks(change));
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    }
    const write = (fn) =>
      update((m) => {
        const cur = { tags: m.tags, map: mapOf(m) };
        const next = fn(cur);
        const keys = [...new Set([...Object.keys(cur.map), ...Object.keys(next.map)])].filter((k) => !sameIds(cur.map[k], next.map[k]));
        return edit({ ...m, tags: next.tags }, keys, (item, key) => ({ ...item, tags: next.map[key] || [] }));
      });
    return { tags: () => get().tags, map: () => mapOf(get()), write, update };
  }

  // ----- the store -----
  // a = { ...a backend, who (视频 | UP 主 | 记录), idPrefix, make?(name, tags) (a new tag; default { id, name, color },
  // plus folder when scoped), scoped (收藏夹: a tag belongs to one folder, its scope), scopeWhy?(scope) ("" or why no
  // tag can be made there), cap(scope), full(n, scope) (why the scope takes no new tag at n), fullShort(scope) (the same
  // in a few words, 「名额已满」), keepOverCap (AI tags the user confirmed may pass the cap: 收藏夹 and 关注; else 应用
  // makes none past it and capName, 「摘读记录的标签」, says so), newTagMax(), uses?(id) (carriers the map leaves out:
  // 关注's 已取消关注), restorable?(key) and goneWord (U leaves the others be and says how many), steps? ({ push(step),
  // drop(pred) }: the page's U; else the store keeps its own, store.undo), confirm(title, body, ok, opts), say(text,
  // error?), changed() (a write landed: redraw), undone?(keys) (after U; else changed), tagGone?(id) (a tag deleted: its
  // filters), setProposal(p), live() (has(key): an item 应用 may change), markRecent(keys, at) / endRecent(at) (「AI
  // 刚打的」) }. Everything reads the adapter when called.
  function create(a) {
    const who = a.who;
    const own = [];
    const steps = a.steps || { push: (s) => pushStep(own, s), drop: (pred) => own.splice(0, own.length, ...own.filter((s) => !pred(s))) };
    const inScope = (t, scope) => !a.scoped || t.folder === String(scope);
    const tagsIn = (tags, scope) => tags.filter((t) => inScope(t, scope));
    const tagOf = (id) => a.tags().find((t) => t.id === id);
    const make = (name, tags, scope) =>
      a.make ? a.make(name, tags) : { id: newTagId(a.idPrefix), name, color: nextTagColor(tagsIn(tags, scope)), ...(a.scoped && { folder: String(scope) }) };
    const fullIn = (tags, scope) => {
      const n = tagsIn(tags, scope).length;
      return n >= a.cap(scope) ? a.full(n, scope) : "";
    };

    // Carriers of a tag: what deleting it takes it off.
    const count = (id) => UI.tagUses(a.map(), id) + (a.uses?.(id) || 0);
    // Why scope takes no new tag (outside a folder, or full): "" while it has room.
    const full = (scope) => a.scopeWhy?.(scope) || fullIn(a.tags(), scope);
    // How many new tags one AI 打标签 may make in scope: the setting, within the cap's room.
    const room = (scope) => Math.max(0, Math.min(a.newTagMax(), a.cap(scope) - tagsIn(a.tags(), scope).length));
    // Why room is 0, for the dialog's line: the setting's 0 alike everywhere, else the page's words for a full scope.
    const noRoom = (scope) => (a.newTagMax() === 0 ? UI.NEW_TAG_MAX_ZERO : a.fullShort(scope));
    const fits = (p) => UI.aiProposalOk(p, (id) => Boolean(tagOf(id)));

    // A tag step: U puts the items of before back (tags deleted since stay off) and deletes the tags it created that
    // nothing carries any more, in one write.
    function tagStep({ before, created = [], label, ask = null, recentAt = 0 }) {
      return {
        tags: true, // dropped when a tag is deleted: it could not bring that one back
        ask,
        async undo() {
          let skipped = 0;
          const ok = await a.write((cur) => {
            const live = new Set(cur.tags.map((t) => t.id));
            const map = { ...cur.map };
            for (const [key, ids] of Object.entries(before)) {
              if (a.restorable && !a.restorable(key)) {
                skipped++;
                continue;
              }
              const keep = ids.filter((id) => live.has(id));
              if (keep.length) map[key] = keep;
              else delete map[key];
            }
            const used = new Set(Object.values(map).flat());
            const tags = created.some((id) => !used.has(id)) ? cur.tags.filter((t) => !created.includes(t.id) || used.has(t.id)) : cur.tags;
            return { tags, map };
          });
          if (!ok) return false;
          if (recentAt) await a.endRecent(recentAt);
          (a.undone || a.changed)(Object.keys(before));
          return `已撤销：${label}${skipped ? `（${skipped} 个${a.goneWord}，标签没改）` : ""}`;
        }
      };
    }

    // The tag named value in scope, made if needed while there is room; null, and why in red, otherwise.
    async function createTag(value, scope) {
      const name = cleanTagName(value);
      const why = UI.tagNameError(name, []) || a.scopeWhy?.(scope) || "";
      if (why) return a.say(why, true), null;
      let tag = null;
      let made = false;
      let refused = "";
      const ok = await a.write((cur) => {
        tag = tagsIn(cur.tags, scope).find((t) => t.name === name) || null;
        if (tag || (refused = fullIn(cur.tags, scope))) return cur;
        tag = make(name, cur.tags, scope);
        made = true;
        return { ...cur, tags: [...cur.tags, tag] };
      });
      if (refused) a.say(refused, true);
      if (!ok) return null;
      if (made) a.changed();
      return tag;
    }

    // A rename, color or rule edit from 标签管理 (UI.editedTag); false, and why in red, for an empty or taken name.
    // The edit applies to the tag as stored when it is written, so a field changed meanwhile is kept.
    async function edit(t, field, value) {
      const { tag, why } = UI.editedTag(tagOf(t.id) || t, field, value, tagsIn(a.tags(), t.folder).filter((x) => x.id !== t.id));
      if (why) a.say(why, true);
      if (!tag) return false;
      const ok = await a.write((cur) => ({ ...cur, tags: cur.tags.map((x) => (x.id === t.id ? UI.editedTag(x, field, value, []).tag : x)) }));
      if (ok) a.changed();
      return ok;
    }

    // 删除 in 标签管理: asks with how many carry it, then takes it off them all. Tag steps go: U could not bring it back.
    async function remove(t) {
      if (!(await a.confirm(...UI.deleteTagAsk(t, count(t.id), who), "删除", { danger: true }))) return false;
      const ok = await a.write((cur) => ({ tags: cur.tags.filter((x) => x.id !== t.id), map: UI.withoutTag(cur.map, t.id) }));
      if (!ok) return false;
      steps.drop((s) => s.tags);
      a.tagGone?.(t.id);
      a.changed();
      return true;
    }

    // The picker's changes ([{ key, add, remove }], on what is stored now): one write and one U step (one that changed
    // several asks first). Resolves how many items changed.
    async function change(list, label = MdgErrors.LABEL.tagEdit) {
      if (!list.length) return 0;
      const before = {};
      const ok = await a.write((cur) => {
        const live = new Set(cur.tags.map((t) => t.id));
        const map = { ...cur.map };
        for (const c of list) {
          const was = cur.map[c.key] || [];
          const now = TagPicker.applyChange(was.filter((id) => live.has(id)), c);
          if (sameIds(was, now)) continue;
          before[c.key] = [...was];
          if (now.length) map[c.key] = now;
          else delete map[c.key];
        }
        return Object.keys(before).length ? { ...cur, map } : cur;
      });
      const n = Object.keys(before).length;
      if (!ok || !n) return 0;
      steps.push(tagStep({ before, label: n > 1 ? `${n} 个${sp(who)}的标签修改` : label, ask: n > 1 ? UI.undoAsk("tags", n, who) : null }));
      a.changed();
      return n;
    }
    // A chip's click: the tag comes off that item, U puts it back.
    async function untag(key, id) {
      const name = tagOf(id)?.name || "";
      if (await change([{ key, add: [], remove: [id] }], UI.untagStep(name))) a.say(UI.untagged(name));
    }
    // 标签已更新 after a picker closes on n changed items.
    const updatedText = (n) => `${n > 1 ? `${n} 个${sp(who)}的` : ""}标签已更新${UI.UNDO}`;

    // The shared picker (tag-picker.js) on targets; scopes: the folders whose tags it offers (a new tag needs exactly
    // one). done(saving) as it closes, saving its one write (resolves how many items changed).
    function openPicker({ title, note = "", targets, scopes = [undefined], anchor = "", done = () => {} }) {
      const one = scopes.length === 1;
      TagPicker.open({
        title,
        note,
        targets,
        idsOf: (k) => (a.map()[k] || []).filter((id) => tagOf(id)),
        tags: () => a.tags().filter((t) => !a.scoped || scopes.includes(t.folder)),
        // Read at each redraw: a tag made here may fill the scope; full, no 新建「…」 and the empty list says why.
        get canCreate() {
          return one && !full(scopes[0]);
        },
        get empty() {
          // "" leaves tag-picker.js's own 「输入名称后回车新建标签」.
          return one ? full(scopes[0]) : a.scopeWhy(undefined);
        },
        create: (name) => createTag(name, scopes[0]),
        anchor,
        onClose: (changes) => done(change(changes))
      });
    }

    // 标签管理's adapter (tag-dialogs.js): page = { hint(), reason?() ("" or why nothing can be edited here), tags()
    // (the ones it lists), scope() }.
    const manage = (page) => ({
      who,
      hint: page.hint,
      reason: page.reason,
      tags: page.tags,
      count,
      addReason: (value) => full(page.scope()) || UI.tagNameError(cleanTagName(value), tagsIn(a.tags(), page.scope())),
      add: (value) => createTag(value, page.scope()),
      edit,
      remove
    });

    // The ticked new tags of a proposal against tags, in its order: a name its scope has is that tag; the others are
    // made while the cap has room (or past it with keepOverCap); the keys of the rest are skipped. 应用 and the review
    // both go by it. scope: where a new tag without its own folder goes.
    function plan(newTags, existing, scope) {
      const tags = [...existing];
      const idFor = {};
      const created = [];
      const skipped = [];
      for (const t of newTags) {
        const name = cleanTagName(t.name);
        if (!t.checked || !name) continue;
        const s = t.folder || scope;
        let tag = tagsIn(tags, s).find((x) => x.name === name);
        if (!tag && !a.scopeWhy?.(s) && (a.keepOverCap || !fullIn(tags, s))) {
          tag = make(name, tags, s);
          tags.push(tag);
          created.push(tag.id);
        }
        if (tag) idFor[t.key] = tag.id;
        else skipped.push(t.key);
      }
      return { tags, idFor, created, skipped };
    }
    // Without keepOverCap the review says which ticked new tags 应用 will not make, and why.
    const notMade = a.keepOverCap ? undefined : (p, scope) => ({ keys: new Set(plan(p.newTags, a.tags(), scope).skipped), why: `${a.capName}最多 ${a.cap(scope)} 个` });

    // 应用: the proposal's new tags and every live item's change, in one write; then (only then) the proposal goes, 「AI
    // 刚打的」 shows the changed items and U can take it back. A failed write keeps the proposal and says so in red.
    async function apply(p, scope) {
      if (!p) return false;
      const live = a.live();
      let changes = [];
      let made = { created: [], skipped: [] };
      const before = {};
      const ok = await a.write((cur) => {
        made = plan(p.newTags, cur.tags, scope);
        const ids = new Set(made.tags.map((t) => t.id));
        changes = UI.aiChanges(p, cur.map, live, (key) => made.idFor[key]);
        const map = { ...cur.map };
        for (const [key, was, after] of changes) {
          before[key] = [...was];
          const keep = after.filter((id) => ids.has(id));
          if (keep.length) map[key] = keep;
          else delete map[key];
        }
        return { tags: made.created.length ? made.tags : cur.tags, map: changes.length ? map : cur.map };
      });
      if (!ok) return a.say(UI.AI_APPLY_FAILED, true), false;
      a.setProposal(null);
      const n = changes.length;
      const at = n ? Date.now() : 0;
      if (n) await a.markRecent(Object.keys(before), at);
      if (n || made.created.length) steps.push(tagStep({ before, created: made.created, label: `AI 打标签（${n} 个${sp(who)}）`, ask: n > 1 ? UI.undoAsk("ai", n, who) : null, recentAt: at }));
      a.changed();
      const skipped = made.skipped.length ? `；${made.skipped.length} 个新标签没有建：${a.full(tagsIn(a.tags(), scope).length, scope)}` : "";
      a.say(`${UI.aiApplied(n, who, made.created.length)}${skipped}`);
      return true;
    }

    // One ✦ AI 打标签 run as job on the page's runs (R): request(i, p) is batch i's message, merge(p, data, i) folds an
    // answer in, send(msg) sends one. An AI 429 or timeout sends the same batch again, up to AI_THROTTLE_WAITS /
    // AI_TIMEOUT_TRIES in a row; an error that fails every batch alike (aiEnds) ends the run. name(i), when given, says
    // which batch in the progress line and errors (所有收藏夹 names the folder); where() follows the pill's line.
    // progress(text) is the dialog's line, counting down with the pill. onError(error, code) shows an error with its
    // remedy (收藏夹's banner): the stop's, and a cut answer's when limitHint. A proposal naming a tag deleted meanwhile
    // is dropped. Resolves { proposal (null when no batch got through), errors, error, code }.
    async function runAi({ R, job, total, request, merge, send, intervalMs, progress, name = null, where = () => "", onError = () => {}, limitHint = false }) {
      const which = (i, whole = false) => (name ? name(i) : whole ? `第 ${i + 1} / ${total} 批` : `第 ${i + 1} 批`);
      const p = { newTags: [], rows: [], notes: [], errors: [] };
      let answered = 0;
      let i = 0;
      const r = await R.run(job, {
        total,
        tick: () => R.get(job)?.wait && progress(`${R.get(job).wait}${which(i - 1)}…`),
        gap: intervalMs,
        line: (d, t) => `AI 打标签 ${d}/${t} 批${where()}`,
        next: () => (i < total ? { i: i++ } : null),
        act: ({ i }) => (progress(`AI 正在处理${which(i, true)}…`), send(request(i, p))),
        judge: MdgRuns.aiJudge(),
        done({ i }, x) {
          if (x.ok) return answered++, merge(p, x.data, i);
          p.errors.push(`${which(i)}失败：${x.error || MdgErrors.text(x)}`);
          // 截断 is reported with what to change.
          if (x.code === "AI_TRUNCATED" && limitHint) onError(x.error, x.code);
        }
      });
      if (r.error) {
        p.errors.push(`${which(i - 1)}失败：${r.error}`);
        onError(r.error, r.code);
      }
      if (r.stopped) p.errors.push(answered ? "已手动停止，这里只有已完成批次的建议" : "已手动停止，还没有批次完成");
      // A new tag no item uses starts unticked.
      for (const t of p.newTags) t.checked = p.rows.some((row) => row.add.includes(UI.aiRef.new(t.key)));
      progress(answered ? "" : p.errors.join("；"));
      let proposal = answered ? p : null;
      // A tag deleted during the run is still named by the batches before it: dropped like a saved proposal.
      if (proposal && !fits(proposal)) {
        proposal = null;
        p.errors.push(UI.AI_TAG_GONE);
        progress(UI.AI_TAG_GONE);
      }
      return { proposal, errors: p.errors, error: r.error, code: r.code, busy: r.busy };
    }

    return {
      who, tagOf, count, full, room, noRoom, fits, createTag, edit, remove, change, untag, updatedText, openPicker, manage,
      plan, notMade, apply, runAi, undo: () => undoLast(own, { confirm: a.confirm, say: a.say })
    };
  }

  globalThis.MdgTagStore = { create, local, follow, marks, pushStep, undoLast };
})();
