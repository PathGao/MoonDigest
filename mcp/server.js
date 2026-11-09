#!/usr/bin/env node
// MoonDigest's MCP server: MCP tools over stdio, the extension's socket per docs/AGENT.md §2.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
// Low-level Server keeps the tool schemas as plain JSON Schema, so zod is not a dependency.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const CALL_TIMEOUT_MS = 60_000;
const PING_MS = 20_000;

class CodedError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// --- extension socket ---------------------------------------------------------

export function createBridge({ port = process.env.MOONDIGEST_MCP_PORT ? Number(process.env.MOONDIGEST_MCP_PORT) : 47823, host = "127.0.0.1", callTimeoutMs = CALL_TIMEOUT_MS, pingMs = PING_MS } = {}) {
  let wss = null;          // set while listening
  let listening = null;    // promise of the current listen attempt
  let portError = "";
  let ext = null;          // { ws, hello }
  let nextId = 1;
  const pending = new Map();

  function listen() {
    if (wss) return Promise.resolve();
    if (listening) return listening;
    listening = new Promise((resolve) => {
      const server = new WebSocketServer({
        host, port,
        verifyClient: ({ origin }) => typeof origin === "string" && origin.startsWith("chrome-extension://"),
      });
      server.once("listening", () => {
        wss = server; listening = null; portError = "";
        server.on("connection", onConnection);
        resolve();
      });
      server.once("error", (err) => {
        listening = null;
        portError = err.code === "EADDRINUSE"
          ? `Port ${port} is used by another program, most likely another moondigest-mcp started by a different MCP client. The browser extension connects to only one of them. Close the other MCP client (or its moondigest-mcp) and call again; this server takes the port over on the next call.`
          : `moondigest-mcp could not listen on ${host}:${port}: ${err.message}`;
        server.close();
        resolve();
      });
    });
    return listening;
  }

  function onConnection(ws) {
    if (ext) { ws.close(4001, "another extension is already connected"); return; }
    const me = { ws, hello: null, lastSeen: Date.now() };
    ext = me;
    const ping = setInterval(() => {
      // Two missed pings: the socket is dead without a close (sleep, killed worker).
      if (Date.now() - me.lastSeen > pingMs * 2 + 5_000) { ws.terminate(); return; }
      send(ws, { type: "ping" });
    }, pingMs);
    ws.on("message", (raw) => {
      me.lastSeen = Date.now();
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === "hello") {
        me.hello = msg;
        return;
      }
      if (msg.type === "pong") return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new CodedError(msg.code || "", msg.error || "The extension reported an error."));
    });
    ws.on("close", () => {
      clearInterval(ping);
      if (ext !== me) return;
      ext = null;
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new CodedError("NOT_CONNECTED", "The browser extension disconnected before answering."));
        pending.delete(id);
      }
    });
    ws.on("error", () => {});
  }

  async function call(method, params) {
    await listen();
    if (!wss) throw new CodedError("PORT_IN_USE", portError);
    if (!ext?.hello) {
      throw new CodedError("NOT_CONNECTED", "No browser extension is connected. Ask the user to open the browser that has the MoonDigest extension and turn on 设置 → 高级 → 允许 MCP 连接 (Settings → Advanced → Allow MCP connection). If it is already on, the extension connects within a minute (it retries once a minute): try again then.");
    }
    const id = String(nextId++);
    const { ws } = ext;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CodedError("TIMEOUT", `The extension did not answer "${method}" within ${Math.round(callTimeoutMs / 1000)} s.`));
      }, callTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      send(ws, { id, method, params });
    });
  }

  async function close() {
    if (ext) ext.ws.terminate();
    if (wss) await new Promise((r) => wss.close(r));
    wss = null;
  }

  return {
    listen, call, close,
    get port() { return wss?.address().port ?? port; },
    get connected() { return !!ext?.hello; },
  };
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// --- formatting ---------------------------------------------------------------

export function clock(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export function formatVideo(d) {
  const lines = [];
  const add = (k, v) => { if (v) lines.push(`${k}: ${v}`); };
  add("Title", d.title);
  add("Author", d.author);
  add("Date", d.uploadDate);
  if (d.duration) add("Duration", clock(d.duration));
  add("URL", d.url);
  if (d.part?.count > 0) add("Part", `${d.part.index}/${d.part.count} ${d.part.title || ""}`.trim());
  const sub = d.subtitle || {};
  if (sub.segments?.length) add("Subtitle", sub.lang || "unknown language");
  else add("Subtitle missing", sub.missing || "no subtitle");
  if (sub.needLogin) add("Subtitle note", "Bilibili hides subtitles from logged-out users; the user should log in to Bilibili in that browser.");
  add("Subtitle warning", sub.warning);
  if (d.description) lines.push("", "Description:", d.description);
  if (d.chapters?.length) {
    lines.push("", "Chapters:");
    for (const c of d.chapters) lines.push(`[${clock(c.from)}] ${c.title}`);
  }
  if (sub.segments?.length) {
    lines.push("", "Transcript:");
    for (const s of sub.segments) lines.push(`[${clock(s.from)}] ${s.content}`);
  }
  if (d.comments?.length) {
    lines.push("", "Comments:");
    for (const c of d.comments) lines.push(`- ${c.uname} (${c.like} likes): ${c.message}`);
  }
  return lines.join("\n");
}

// One line per result: what an agent needs to pick which ones to read with get_video.
export function formatSearch(d) {
  const site = { bilibili: "Bilibili", youtube: "YouTube" }[d.site] || d.site;
  if (!d.items?.length) return `No ${site} videos for "${d.query}" on page ${d.page}.`;
  const lines = [`${site} search "${d.query}", page ${d.page}:`];
  d.items.forEach((v, i) => {
    const parts = [v.title, v.author, v.duration ? clock(v.duration) : "", v.views != null ? `${v.views} views` : "", v.uploadDate, v.url];
    lines.push(`${i + 1}. ${parts.filter(Boolean).join(" | ")}`);
  });
  return lines.join("\n");
}

// The user's own Bilibili data (docs/AGENT.md §2 favorites / follows / history): one line per item.
// Local time, as "2026-11-05 21:30" (sv-SE writes dates that way).
const when = (sec) => (sec > 0 ? new Date(sec * 1000).toLocaleString("sv-SE").slice(0, 16) : "");
const day = (sec) => when(sec).slice(0, 10);
const joinParts = (parts) => parts.filter(Boolean).join(" · ");
const pageLine = (d) => `Page ${d.page}, ${d.items.length}${d.total == null ? "" : ` of ${d.total}`}${d.source === "local" ? " (MoonDigest's copy)" : ""}.${d.hasMore ? ` More: page ${d.page + 1}.` : ""}`;

export function formatFavorites(d) {
  if (d.folders) return ["Folders (id · title · videos):", ...d.folders.map((f) => `- ${f.id} · ${f.title} · ${f.count}`)].join("\n");
  const lines = [`Folder ${d.folderId}. ${pageLine(d)}`];
  for (const v of d.items) {
    lines.push("- " + joinParts([
      `[${clock(v.duration)}] ${v.title}`, v.author, v.url, v.favTime && `saved ${day(v.favTime)}`,
      v.invalid && "unavailable", v.progress && (v.progress < 0 ? "watched" : `watched to ${clock(v.progress)}`),
      v.kept && "kept", v.verdict && `AI: ${v.verdict}`, v.tags?.length && `tags: ${v.tags.join(", ")}`,
      v.summary && `summary: ${v.summary}`, v.note && `note: ${v.note.replace(/\s+/g, " ")}`,
    ]));
  }
  return lines.join("\n");
}

export function formatFollows(d) {
  const ignored = d.queryIgnored ? " Query ignored: MoonDigest has not synced the follow list, so this is Bilibili's list unfiltered." : "";
  const lines = [`Follows. ${pageLine(d)}${ignored}`];
  for (const u of d.items) {
    lines.push("- " + joinParts([`${u.name} (mid ${u.mid})`, u.groups?.length && `groups: ${u.groups.join(", ")}`, u.tags?.length && `tags: ${u.tags.join(", ")}`, u.sign?.replace(/\s+/g, " ")]));
  }
  return lines.join("\n");
}

// The 分拣台 writes (docs/AGENT.md §2 triage / propose).
export function formatTriage(d) {
  const notMade = d.tagsNotMade?.length ? ` Not made (the folder is at its tag limit): ${d.tagsNotMade.join(", ")}.` : "";
  return `Saved in the 分拣台: ${d.changed} video(s) changed. The user can undo this call there.${notMade}`;
}

export function formatProposal(d) {
  return `Proposed (${d.id}). Nothing has changed on Bilibili: the proposal waits in MoonDigest's 分拣台 until the user confirms or rejects it. Tell the user.`;
}

export function formatHistory(d) {
  const lines = [`History, newest first, ${d.items.length} items.${d.cursor ? ` More: cursor "${d.cursor}".` : " No more."}`];
  for (const h of d.items) {
    const seen = h.progress < 0 ? "finished" : h.duration ? `${clock(h.progress)}/${clock(h.duration)}` : "";
    lines.push("- " + joinParts([when(h.viewAt), h.title, h.author, seen && `watched ${seen}`, h.kind !== "archive" && h.kind, h.url]));
  }
  return lines.join("\n");
}

// The user's collections on a site (docs/AGENT.md §2 collection / collectionWrite): one line per item.
export function formatCollection(d) {
  const lines = [`${d.site} ${d.kind}${d.id ? ` ${d.id}` : ""}, ${d.items.length} items.${d.cursor ? ` More: cursor "${d.cursor}".` : " No more."}`];
  for (const v of d.items) {
    if (v.videoId) lines.push("- " + joinParts([`${v.duration ? `[${clock(v.duration)}] ` : ""}${v.title}`, v.author, v.url, v.unavailable && "unavailable"]));
    else if (v.channelId) lines.push("- " + joinParts([v.title, v.channelId, v.url]));
    else lines.push("- " + joinParts([v.id, v.title, v.count != null && `${v.count} videos`]));
  }
  return lines.join("\n");
}

const STATUS = { unchanged: "already so, skipped", would_change: "would change", done: "done", unconfirmed: "sent, but the read after still shows the old state", failed: "failed" };

export function formatCollectionWrite(d) {
  const lines = [`${d.dryRun ? "Dry run, nothing changed: " : ""}${d.op} on ${d.site} ${d.kind}${d.id ? ` ${d.id}` : ""}.`];
  for (const r of d.results) {
    const state = r.before == null ? "" : ` (was ${r.before ? "in" : "not in"}${r.after == null ? "" : `, now ${r.after ? "in" : "not in"}`})`;
    lines.push(`- ${r.item}: ${STATUS[r.status] || r.status}${state}${r.error ? `: ${r.error}` : ""}`);
  }
  if (!d.dryRun) lines.push(`Done: ${d.done.join(", ") || "none"}.`);
  if (d.notDone.length) lines.push(`Not tried: ${d.notDone.join(", ")}.`);
  if (d.stopped === "TIMEOUT") lines.push("Stopped: the call's time ran out. Call again with the items not tried.");
  else if (d.stopped) lines.push(`Stopped: ${d.stopped}.${d.stopped === "THROTTLED" ? " Stop calling MoonDigest for now and tell the user; do not retry soon." : " Ask the user to log in to the site in that browser."}`);
  if (d.undo) lines.push(`Undo: collection_write ${JSON.stringify(d.undo)}`);
  return lines.join("\n");
}

// --- MCP ----------------------------------------------------------------------

const URL_DOC = "A Bilibili video page (www.bilibili.com/video/…, /bangumi/play/…, /list/…, /festival/…) or a YouTube watch page (www.youtube.com/watch?v=…).";

const TOOLS = [
  {
    name: "search_videos",
    description: "Search Bilibili or YouTube for videos through the user's own browser and login. Returns one line per video (title, author, duration, views, date, URL); the URLs go straight to get_video. Titles and view counts are not evidence: read the most promising few with get_video before you cite or recommend one. One search at a time, a few per task. If the result says THROTTLED, stop calling MoonDigest and tell the user; do not retry soon.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for, as you would type it into the site's search box." },
        site: { type: "string", description: "The site to search: \"bilibili\" (default) or \"youtube\"." },
        page: { type: "integer", minimum: 1, description: "Result page, default 1, about 20 videos per page. YouTube has page 1 only." },
        raw: { type: "boolean", description: "Return the extension's JSON (adds a short description per video) instead of the compact text." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_video",
    description: "Read a Bilibili or YouTube video through the user's own browser: title, author, date, duration, chapters, the full timestamped transcript and hot comments. Call this first for any video: one the user links, and one that turns up in your search results or recommendations, to check what it actually says before you cite or recommend it. Work on one video at a time. If the result says THROTTLED, stop calling MoonDigest and tell the user; do not retry soon.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: URL_DOC },
        raw: { type: "boolean", description: "Return the extension's JSON instead of the compact text. Costs several times more tokens; use only when you need exact segment end times." },
      },
      required: ["url"],
    },
  },
  {
    name: "get_frame",
    description: "Grab one frame of the video as a JPEG, at a time in seconds. Call get_video first and only grab frames at times worth seeing (a chart, a slide, a demo the transcript mentions). One video at a time, one frame per call. If the result says THROTTLED, stop and tell the user.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: URL_DOC },
        at: { type: "number", minimum: 0, description: "Time in seconds." },
        maxWidth: { type: "integer", minimum: 64, description: "Maximum width in pixels, default 1280. Smaller costs fewer tokens." },
      },
      required: ["url", "at"],
    },
  },
  {
    name: "get_favorites",
    description: "Read-only: the user's own Bilibili favorites. Without folderId, lists the folders (id, title, video count), 稍后再看 (watch later) first with id \"toview\". With folderId, one page of that folder's videos: title, UP, URL, when saved, plus the user's MoonDigest 分拣 tags, note, AI verdict (keep/drop/unsure) and one-line summary where they exist. query searches title, UP, tags, note and summary in toview and in folders MoonDigest keeps a copy of; in other folders Bilibili searches its own titles. Read one page, then decide whether you need the next; do not page through everything. Fails with PERSONAL_DATA_OFF until the user allows it.",
    inputSchema: {
      type: "object",
      properties: {
        folderId: { type: "string", description: "A folder id from the folder list, or \"toview\". Omit to list the folders." },
        page: { type: "integer", minimum: 1, description: "Page number, 40 videos a page. Default 1." },
        query: { type: "string", description: "Words that must all appear (case-insensitive)." },
        raw: { type: "boolean", description: "Return the extension's JSON instead of the compact text." },
      },
    },
  },
  {
    name: "get_follows",
    description: "Read-only: the UP 主 the user follows on Bilibili, with their follow groups and the user's MoonDigest UP tags, 50 a page. query searches name, sign, groups and tags once MoonDigest has synced the follow list (otherwise it is ignored and the result says so). Page sparingly. Fails with PERSONAL_DATA_OFF until the user allows it.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "integer", minimum: 1, description: "Page number, 50 a page. Default 1." },
        query: { type: "string", description: "Words that must all appear (case-insensitive)." },
        raw: { type: "boolean", description: "Return the extension's JSON instead of the compact text." },
      },
    },
  },
  {
    name: "get_history",
    description: "Read-only: the user's Bilibili watch history, newest first, 30 items a call (Bilibili keeps about three months). Pass the returned cursor to read further back. For \"what did I watch this month\", stop once items are older than the month; never read the whole history. Fails with PERSONAL_DATA_OFF until the user allows it.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: "string", description: "The cursor the previous call returned. Omit for the newest." },
        raw: { type: "boolean", description: "Return the extension's JSON instead of the compact text." },
      },
    },
  },
  {
    name: "list_collection",
    description: "Read-only: one page of the user's own collection on a site, through their browser and login. YouTube kinds: watch_later, playlists (the user's playlists: id, title), playlist (the videos of the playlist id), likes, subscriptions (channels), history. Bilibili favorites, follows and history stay in get_favorites, get_follows and get_history. Pass the returned cursor for the next page; read one page, then decide whether you need more. Fails with PERSONAL_DATA_OFF until the user allows it, UNSUPPORTED_KIND for a kind the site does not have.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", description: "\"youtube\"." },
        kind: { type: "string", enum: ["watch_later", "playlists", "playlist", "likes", "subscriptions", "history"] },
        id: { type: "string", description: "The playlist id, for kind playlist." },
        cursor: { type: "string", description: "The cursor the previous call returned. Omit for the first page." },
        raw: { type: "boolean", description: "Return the extension's JSON instead of the compact text." },
      },
      required: ["site", "kind"],
    },
  },
  {
    name: "collection_write",
    description: "Changes the user's own collection: adds videos to or removes them from YouTube watch_later or one of the user's own playlists (id). Likes and subscriptions are read-only. Unless the user named exactly these videos and this change, call with dryRun: true first and show the user what would change. At most 20 video ids a call; they are changed one at a time, a few seconds apart, each read before (already so: skipped) and after (confirmed). The result lists each item, what was done and not tried, and the undo call. If it says THROTTLED, stop calling MoonDigest and tell the user. Fails with COLLECTION_WRITES_OFF until the user allows changes (dryRun needs only PERSONAL_DATA_OFF lifted).",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string", description: "\"youtube\"." },
        op: { type: "string", enum: ["add", "remove"] },
        kind: { type: "string", enum: ["watch_later", "playlist"] },
        id: { type: "string", description: "The playlist id, for kind playlist (from list_collection kind playlists)." },
        items: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20, description: "Video ids (the v= of a watch URL)." },
        dryRun: { type: "boolean", description: "Only read: each item's current state and whether it would change." },
        raw: { type: "boolean", description: "Return the extension's JSON instead of the compact text." },
      },
      required: ["site", "op", "kind", "items"],
    },
  },
  {
    name: "set_triage",
    description: "Write the user's MoonDigest 分拣台 results for up to 50 Bilibili videos, as the 分拣台's own AI does: a verdict (keep / drop / unsure) with a one-line summary, 保留 (kept), a note, and tags of the folder. Judge a video only after reading it with get_video; take bvids and folder ids from get_favorites. Only the fields you give change, and the whole call is checked before anything is written. The user sees the results in the 分拣台 and can undo the call there. Nothing changes on Bilibili. Fails with PERSONAL_DATA_OFF or TRIAGE_WRITES_OFF until the user allows it.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              bvid: { type: "string", pattern: "^BV[0-9A-Za-z]{10}$" },
              verdict: { type: "string", enum: ["keep", "drop", "unsure"], description: "Keep it, can go, or unsure. Needs summary." },
              summary: { type: "string", maxLength: 100, description: "One line: what the video is." },
              reason: { type: "string", maxLength: 300, description: "Why the verdict." },
              points: { type: "array", maxItems: 3, items: { type: "string", maxLength: 200 }, description: "Key points." },
              kept: { type: "boolean", description: "The 保留 mark: true marks it, false removes it." },
              note: { type: "string", maxLength: 2000, description: "The video's note; an empty string removes it." },
              folderId: { type: "string", description: "The folder whose tags addTags and removeTags name; the video must be in it." },
              addTags: { type: "array", maxItems: 10, items: { type: "string", maxLength: 12 }, description: "Tag names; a missing one is made while the folder has room." },
              removeTags: { type: "array", maxItems: 10, items: { type: "string", maxLength: 12 } },
            },
            required: ["bvid"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "propose_fav_change",
    description: "Propose a change to the user's Bilibili favorites: unfav (取消收藏) videos from a folder, or move or copy them to another folder. It changes nothing by itself: the proposal waits in MoonDigest's 分拣台 until the user confirms it there (MoonDigest then makes the change) or rejects it; tell the user so. from must be a folder ticked in the 分拣台 (get_favorites reads it with source local) holding every video, to another folder from get_favorites. At most 20 proposals wait at a time. Fails with PERSONAL_DATA_OFF or TRIAGE_WRITES_OFF until the user allows it.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["unfav", "move", "copy"] },
        from: { type: "string", description: "The folder id the videos are in, or \"toview\"." },
        to: { type: "string", description: "The target folder id, for move and copy." },
        bvids: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", pattern: "^BV[0-9A-Za-z]{10}$" } },
        reason: { type: "string", maxLength: 200, description: "One line for the user: why." },
      },
      required: ["action", "from", "bvids"],
    },
  },
];

// The tools answered by one socket method each: the method, the params it takes, the formatter.
const METHODS = {
  get_favorites: ["favorites", ["folderId", "page", "query"], formatFavorites],
  get_follows: ["follows", ["page", "query"], formatFollows],
  get_history: ["history", ["cursor"], formatHistory],
  list_collection: ["collection", ["site", "kind", "id", "cursor"], formatCollection],
  set_triage: ["triage", ["items"], formatTriage],
  propose_fav_change: ["propose", ["action", "from", "to", "bvids", "reason"], formatProposal],
};

// What MCP clients put in the model's prompt about this server: when to reach for it, not how each tool works.
export const INSTRUCTIONS = [
  "MoonDigest searches and reads Bilibili and YouTube videos through the user's own browser and login: a video search on either site (search_videos), the full timestamped transcript, chapters, description and hot comments (get_video), and a frame at any second (get_frame).",
  "Use it whenever a video matters to the answer, not only when the user links one. When you research a topic, look for tutorials or compare sources and your search turns up Bilibili or YouTube videos, do not judge them by title, thumbnail or view count: read the most promising ones with get_video, check that they really cover what the user asked, and say what each one says, citing mm:ss timestamps and links that open at that moment. Drop the ones that do not match.",
  "Read a few candidates, one at a time, not dozens: Bilibili and YouTube rate-limit bursts. If a result says THROTTLED, stop and tell the user. To find videos on Bilibili or YouTube, search with search_videos, then read the best few with get_video.",
  "When the user asks about their own Bilibili (what they saved, who they follow, what they watched lately), use get_favorites, get_follows and get_history. They are read-only and off until the user allows them (PERSONAL_DATA_OFF: ask the user to turn it on). Read one page at a time and stop once you can answer.",
  "For the user's own YouTube (watch later, playlists, likes, subscriptions, history) use list_collection; to add videos to or remove them from watch later or a playlist, collection_write, off until the user allows changes (COLLECTION_WRITES_OFF). Dry-run first unless the user named exactly the change, and keep the undo the result gives.",
  "When the user asks you to sort their favorites, set_triage writes MoonDigest's 分拣台 results (verdict, 保留, note, tags) and propose_fav_change proposes unfav, move or copy, which the user confirms in the 分拣台. Both are off until the user allows them (TRIAGE_WRITES_OFF).",
].join("\n\n");

function errorResult(err) {
  const code = err.code ? `${err.code}: ` : "";
  const tail = err.code === "THROTTLED" ? " Stop calling MoonDigest for now and tell the user; do not retry soon." : "";
  return { isError: true, content: [{ type: "text", text: `${code}${err.message}${tail}` }] };
}

export function createMcpServer(bridge) {
  const server = new Server({ name: "moondigest", version: "0.1.0" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const args = params.arguments || {};
    try {
      if (params.name === "search_videos") {
        if (typeof args.query !== "string" || !args.query.trim()) throw new CodedError("", "query is required.");
        const site = args.site ?? "bilibili";
        // Which sites search is the extension's to say (agent-sites/): it answers any other id with the list.
        if (typeof site !== "string" || !site) throw new CodedError("", 'site must be a site id such as "bilibili".');
        const page = args.page ?? 1;
        if (!Number.isInteger(page) || page < 1) throw new CodedError("", "page must be an integer ≥ 1.");
        const data = await bridge.call("search", { site, query: args.query.trim(), page });
        return { content: [{ type: "text", text: args.raw ? JSON.stringify(data) : formatSearch(data) }] };
      }
      const mine = METHODS[params.name];
      if (mine) {
        const [method, keys, format] = mine;
        const data = await bridge.call(method, Object.fromEntries(keys.filter((k) => args[k] != null).map((k) => [k, args[k]])));
        return { content: [{ type: "text", text: args.raw ? JSON.stringify(data) : format(data) }] };
      }
      if (params.name === "collection_write") {
        const data = await bridge.call("collectionWrite", Object.fromEntries(["site", "op", "kind", "id", "items", "dryRun"].filter((k) => args[k] != null).map((k) => [k, args[k]])));
        // A batch stopped by THROTTLED or a lost login is an error the agent must act on; the lists still come along.
        const stopped = data.stopped && data.stopped !== "TIMEOUT";
        return { ...(stopped && { isError: true }), content: [{ type: "text", text: `${stopped ? `${data.stopped}: ` : ""}${args.raw ? JSON.stringify(data) : formatCollectionWrite(data)}` }] };
      }
      if (typeof args.url !== "string" || !args.url) throw new CodedError("BAD_URL", "url is required.");
      if (params.name === "get_video") {
        const data = await bridge.call("get", { url: args.url });
        return { content: [{ type: "text", text: args.raw ? JSON.stringify(data) : formatVideo(data) }] };
      }
      if (params.name === "get_frame") {
        if (typeof args.at !== "number" || !(args.at >= 0)) throw new CodedError("", "at must be a number of seconds ≥ 0.");
        const p = { url: args.url, at: args.at };
        if (args.maxWidth != null) p.maxWidth = args.maxWidth;
        const data = await bridge.call("frame", p);
        const m = /^data:([^;,]+);base64,(.*)$/s.exec(data.image || "");
        if (!m) throw new CodedError("", "The extension returned no image.");
        return {
          content: [
            { type: "image", mimeType: m[1], data: m[2] },
            { type: "text", text: `Frame at ${clock(data.at)} (${data.at}s), ${data.width}x${data.height}.` },
          ],
        };
      }
      throw new CodedError("", `Unknown tool ${params.name}.`);
    } catch (err) {
      return errorResult(err);
    }
  });
  return server;
}

async function main() {
  const bridge = createBridge();
  await bridge.listen();
  if (process.env.MOONDIGEST_MCP_DEBUG) console.error(`moondigest-mcp: ws://127.0.0.1:${bridge.port}/`);
  await createMcpServer(bridge).connect(new StdioServerTransport());
  // The socket server would keep the process (and the port) alive after the MCP client quits.
  process.stdin.on("close", () => process.exit(0));
}

const isMain = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) main();
