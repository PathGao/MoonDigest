// Any other web page for the agent interface (docs/AGENT.md §5): the registry asks it last. Its main <video> with the
// <track> subtitles, or, with no video, the page's main text (kind "page").
MdgAgentSites.register({
  id: "web",
  origins: ["http://*/*", "https://*/*"],
  fallback: true,
  // Never the user's own machine or network (localhost, private and link-local IPs, single-label and .local/.internal
  // names, any IPv6 literal): those pages are BAD_URL. A public name that resolves to a private IP still passes.
  key: (u) => {
    const h = u.hostname.toLowerCase();
    const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
    const [a, b] = v4 ? [+v4[1], +v4[2]] : [];
    const priv = v4 && (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
    const near = !h.includes(".") || h.startsWith("[") || /\.(localhost|local|internal|lan|intranet|corp|home\.arpa)\.?$/.test(h);
    return priv || near ? null : `${u.href.split("#")[0]}:`;
  },
  // Runs in the page's MAIN world: the page is untrusted, so every size is capped and every wait bounded.
  read: async () => {
    if (document.readyState === "loading") return null;
    // The page's own HTTP status (Chrome 109+): an error page is the call's error, not text to read; 429 is risk control.
    const status = globalThis.performance?.getEntriesByType?.("navigation")?.[0]?.responseStatus || 0;
    if (status === 429) return { error: "The site answered HTTP 429 (too many requests): stop, do not retry soon.", code: "THROTTLED" };
    if (status >= 400) return { error: `The page answered HTTP ${status}.` };
    const MAX_TEXT = 100000; // characters of page text, and of all subtitle text together
    const MAX_TRACK_BYTES = 2000000;
    const FETCH_MS = 8000;
    const WAIT_MS = 3000;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const line = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
    const meta = (sel) => line(document.querySelector(sel)?.content, 2000);
    // agent-page.js's mainVideo, which frames use: the largest <video>, else the first.
    const mainVideo = () => {
      const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
      return [...document.querySelectorAll("video")].sort((a, b) => area(b) - area(a))[0] || null;
    };

    // The page may add its player late, and the duration comes with the metadata.
    let video = mainVideo();
    for (const end = Date.now() + WAIT_MS; Date.now() < end && !(video && video.duration > 0); video = mainVideo()) await sleep(250);

    const page = {
      url: location.href,
      title: meta('meta[property="og:title"]') || line(document.title, 500),
      author: meta('meta[name="author"]'),
      description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
      chapters: [],
      comments: []
    };
    if (!video) {
      const root = document.querySelector("article, main, [role=main]") || document.body;
      const text = String(root?.innerText || "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim().slice(0, MAX_TEXT);
      return { ...page, kind: "page", duration: 0, text, subtitle: { segments: [], lang: "", warning: "", missing: "No <video> on this page; text is the page's main text." } };
    }

    // WebVTT or SRT: blocks with a "from --> to" line, the lines after it the text.
    const parse = (raw) => {
      const time = (t) => {
        const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(t);
        return m ? (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, "0") / 1000 : NaN;
      };
      const out = [];
      let total = 0;
      for (const block of raw.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
        const lines = block.split("\n");
        const at = lines.findIndex((l) => l.includes("-->"));
        if (at < 0) continue;
        const [a, b] = lines[at].split("-->");
        const from = time(a);
        const to = time(b);
        const content = line(lines.slice(at + 1).join(" ").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"), 1000);
        if (!Number.isFinite(from) || !Number.isFinite(to) || !content) continue;
        if ((total += content.length) > MAX_TEXT) break;
        out.push({ from, to, content });
      }
      return out;
    };
    // At most MAX_TRACK_BYTES of the body, within FETCH_MS, else "".
    const fetchText = async (src) => {
      if (!/^(https?|data|blob):/.test(src)) return "";
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), FETCH_MS);
      try {
        const res = await fetch(src, { signal: ctl.signal });
        if (!res.ok || !res.body) return "";
        const reader = res.body.getReader();
        const parts = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_TRACK_BYTES) { ctl.abort(); return ""; }
          parts.push(value);
        }
        return new TextDecoder().decode(await new Blob(parts).arrayBuffer());
      } catch {
        return "";
      } finally {
        clearTimeout(timer);
      }
    };

    const isSub = (kind) => kind === "subtitles" || kind === "captions";
    let subtitle = { segments: [], lang: "", warning: "", missing: "The video has no subtitle track." };
    // Cues the browser already loaded, else the <track> file itself (the default track first).
    const loaded = [...(video.textTracks || [])].find((t) => isSub(t.kind) && t.cues?.length);
    if (loaded) {
      let total = 0;
      const segments = [];
      for (const c of loaded.cues) {
        const content = line(String(c.text || "").replace(/<[^>]*>/g, ""), 1000);
        if (!content) continue;
        if ((total += content.length) > MAX_TEXT) break;
        segments.push({ from: c.startTime, to: c.endTime, content });
      }
      subtitle = { segments, lang: line(loaded.label || loaded.language, 100), warning: "", missing: "" };
    } else {
      const tracks = [...video.querySelectorAll("track")].filter((t) => isSub(t.kind || "subtitles") && t.src);
      const track = tracks.find((t) => t.default) || tracks[0];
      if (track) {
        const segments = parse(await fetchText(track.src));
        subtitle = segments.length
          ? { segments, lang: line(track.label || track.srclang, 100), warning: "", missing: "" }
          : { ...subtitle, missing: "The video's subtitle track could not be read." };
      }
    }
    return { ...page, kind: "video", duration: video.duration > 0 && Number.isFinite(video.duration) ? Math.round(video.duration) : 0, subtitle };
  }
});
