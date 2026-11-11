// MoonDigest's agent interface, docs/AGENT.md §2: `get` for a Bilibili video without a tab. The service worker reads
// it through the 分拣台's B站 channel (TRIAGE_BILI_IO) with the functions the 细看 uses, so a result is always the
// requested video's. The worker loads it after triage-bg.js.
(() => {
  const GAP_MS = 300; // between calls: B站 rate-limits bursts
  const BRIEF_SECONDS = 120;
  const BRIEF_COMMENTS = 5;
  const site = MdgSites.SITES.bilibili;

  // The ref of a page whose URL names its video; null for the others (番剧, 活动页, a /list/ without bvid, YouTube),
  // which only their own player can name.
  function refOf(url) {
    let path = "";
    try { path = new URL(url).pathname; } catch { return null; }
    const ref = /^\/(video|list)\//.test(path) ? MdgSites.parseRef(url) : null;
    return ref?.site === site.id ? ref : null;
  }

  // §1's moondigest-get data, plus zone and tags. brief: the first two minutes of subtitle, no chapters, and comments
  // only in place of a missing subtitle.
  async function load(url, ref, brief) {
    const io = TRIAGE_BILI_IO;
    const meta = await site.fetchMeta(ref, io);
    const found = await MdgSites.loadSubtitle(site, ref, meta, io);
    const note = MdgNote.noteMetaOf({ site: site.id, videoId: ref.id, meta, bundle: found.bundle, track: found.track });
    const all = found.body.map(({ from, to, content }) => ({ from, to, content }));
    const comments = brief && all.length ? [] : await site.fetchComments(ref, meta, io, brief ? BRIEF_COMMENTS : undefined).catch(() => []);
    return {
      url,
      site: site.id,
      videoId: ref.id,
      title: meta.title,
      author: meta.author,
      uploadDate: meta.uploadDate,
      duration: meta.duration,
      description: meta.description,
      zone: meta.tname,
      tags: meta.tags,
      part: meta.pageCount > 1 ? { index: meta.pageIndex, count: meta.pageCount, title: meta.pageTitle } : { index: 1, count: 0, title: "" },
      chapters: brief ? [] : MdgSites.chapterRanges(note.chapters).map(({ title, from, to }) => ({ title, from, to: Number.isFinite(to) ? to : meta.duration })),
      subtitle: {
        lang: note.selectedSubtitleLang,
        warning: found.mismatch ? MdgNote.subtitleMismatchWarning(found.mismatch) : "",
        missing: all.length ? "" : MdgErrors.subtitleMissing({ subtitleNeedLogin: found.needLogin, subtitleFailure: found.failure }),
        needLogin: !all.length && found.needLogin,
        segments: brief ? all.filter((s) => s.from < BRIEF_SECONDS) : all
      },
      comments,
      ...(brief && { brief: true })
    };
  }

  let queue = Promise.resolve();
  let lastAt = 0;
  // Resolves to the bridge's reply, or null when url is not a page read here (the bridge then reads it in a tab).
  // deadline: as agent-bridge.js handle.
  async function read(url, { brief = false } = {}, deadline) {
    const ref = refOf(url);
    if (!ref) return null;
    const call = queue.then(async () => {
      const wait = lastAt + GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (Date.now() > deadline) return { ok: false, code: "TIMEOUT", error: "The call waited too long behind earlier ones." };
      try {
        return { ok: true, data: await load(url, ref, brief) };
      } catch (e) {
        return { ok: false, error: String(e?.message || e), ...(MdgSites.isLimit(e) && { code: "THROTTLED" }) };
      } finally {
        lastAt = Date.now();
      }
    });
    queue = call;
    return call;
  }

  globalThis.MdgAgentVideo = { read };
})();
