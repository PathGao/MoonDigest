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

// The user's own Bilibili data (docs/AGENT.md §2 favorites / follows / history): one line per item.
// Local time, as "2026-11-05 21:30" (sv-SE writes dates that way).
const when = (sec) => (sec > 0 ? new Date(sec * 1000).toLocaleString("sv-SE").slice(0, 16) : "");
const day = (sec) => when(sec).slice(0, 10);
const joinParts = (parts) => parts.filter(Boolean).join(" · ");
const pageLine = (d) => `Page ${d.page}, ${d.items.length} of ${d.total}${d.source === "local" ? " (MoonDigest's copy)" : ""}.${d.hasMore ? ` More: page ${d.page + 1}.` : ""}`;

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
    lines.push("- " + joinParts([`${u.name} (mid ${u.mid})`, u.groups?.length && `groups: ${u.groups.join(", ")}`, u.tags?.length && `tags: ${u.tags.join(", ")}`, u.sign]));
  }
  return lines.join("\n");
}

export function formatHistory(d) {
  const lines = [`History, newest first, ${d.items.length} items.${d.cursor ? ` More: cursor "${d.cursor}".` : " No more."}`];
  for (const h of d.items) {
    const seen = h.progress < 0 ? "finished" : h.duration ? `${clock(h.progress)}/${clock(h.duration)}` : "";
    lines.push("- " + joinParts([when(h.viewAt), h.title, h.author, seen && `watched ${seen}`, h.kind !== "archive" && h.kind, h.url]));
  }
  return lines.join("\n");
}

// --- MCP ----------------------------------------------------------------------

const URL_DOC = "A Bilibili video page (www.bilibili.com/video/…, /bangumi/play/…, /list/…, /festival/…) or a YouTube watch page (www.youtube.com/watch?v=…).";

const TOOLS = [
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
];

// The personal-data tools: socket method, the params it takes, the formatter.
const PERSONAL = {
  get_favorites: ["favorites", ["folderId", "page", "query"], formatFavorites],
  get_follows: ["follows", ["page", "query"], formatFollows],
  get_history: ["history", ["cursor"], formatHistory],
};

// What MCP clients put in the model's prompt about this server: when to reach for it, not how each tool works.
export const INSTRUCTIONS = [
  "MoonDigest reads Bilibili and YouTube videos through the user's own browser and login: the full timestamped transcript, chapters, description and hot comments (get_video), and a frame at any second (get_frame).",
  "Use it whenever a video matters to the answer, not only when the user links one. When you research a topic, look for tutorials or compare sources and your search turns up Bilibili or YouTube videos, do not judge them by title, thumbnail or view count: read the most promising ones with get_video, check that they really cover what the user asked, and say what each one says, citing mm:ss timestamps and links that open at that moment. Drop the ones that do not match.",
  "Read a few candidates, one at a time, not dozens: Bilibili and YouTube rate-limit bursts. If a result says THROTTLED, stop and tell the user. MoonDigest cannot search; find the videos with your own search tools first.",
  "When the user asks about their own Bilibili (what they saved, who they follow, what they watched lately), use get_favorites, get_follows and get_history. They are read-only and off until the user allows them (PERSONAL_DATA_OFF: ask the user to turn it on). Read one page at a time and stop once you can answer.",
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
      const mine = PERSONAL[params.name];
      if (mine) {
        const [method, keys, format] = mine;
        const data = await bridge.call(method, Object.fromEntries(keys.filter((k) => args[k] != null).map((k) => [k, args[k]])));
        return { content: [{ type: "text", text: args.raw ? JSON.stringify(data) : format(data) }] };
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
