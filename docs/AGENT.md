# MoonDigest agent interface v1

How AI agents read a video through MoonDigest: page messages for agents that drive the browser (the skill, `skills/moondigest/SKILL.md`), and a local MCP server (`mcp/`) for any MCP client, which can also search for videos (§2 `search`). The page messages cannot search. Read-only, except the user's own collections below. Never API keys or AI conversations. The user's own Bilibili favorites, follows and watch history, with their 分拣 tags, notes and AI verdicts, only through the MCP server and only while the user allows it (§2, `favorites` / `follows` / `history`); likewise the user's collections on other sites (§2 `collection`), which the agent may also change while the user allows that too (`collectionWrite`). For sites beyond the Bilibili 分拣台 MoonDigest has no pages of its own: the agent is the UI.

Supported pages: Bilibili video pages (`www.bilibili.com/video/…`, `/bangumi/play/…`, `/list/…`, `/festival/…`) and YouTube watch pages (`www.youtube.com/watch?v=…`). The MCP server reads the sites registered in `extension/agent-sites/` (§5); the page messages only these two.

## 1. Page messages (what the skill uses)

An agent that drives a browser runs JS in the video page and talks to the extension with `window.postMessage`. Only messages whose `event.source === window` are answered (the page's own scripts, not other frames). Replies are posted to `location.origin`.

Request envelope: `{ type, id, ...params }`. `id` is any string the caller picks.
Reply envelope: `{ source: "moondigest", id, ok: true, version, data }` or `{ source: "moondigest", id, ok: false, version, error, code? }`.

- `version`: protocol version, `1`.
- `error`: a sentence for a human. `code`: a stable string when there is one (see §4).

### `moondigest-get`

Params: none. Reads the page's current video (waits for a read in flight; does not reread a video already read).

`data`:

| field | type | meaning |
|---|---|---|
| `url` | string | `location.href` |
| `site` | `"bilibili"` \| `"youtube"` | |
| `videoId` | string | BV id or YouTube id |
| `title`, `author`, `uploadDate`, `description` | string | `""` when unknown |
| `duration` | number | seconds, `0` when unknown |
| `part` | `{ index, count, title }` | Bilibili multi-part; `count` 0 = not multi-part |
| `chapters` | `[{ title, from, to }]` | seconds |
| `subtitle.segments` | `[{ from, to, content }]` | seconds; `[]` when none |
| `subtitle.lang` | string | the track's label or language |
| `subtitle.warning` | string | the subtitle's time range does not match the video |
| `subtitle.missing` | string | why there is no subtitle; `""` when there is one |
| `subtitle.needLogin` | boolean | Bilibili hides subtitles from logged-out users |
| `comments` | `[{ uname, like, message }]` | hot comments, `message` ≤ 500 chars |

### `moondigest-frame`

Params: `at` (seconds, required), `maxWidth` (pixels, optional, default 1280).

Pauses the page's `<video>`, seeks to `at`, waits for `seeked` and a decoded frame, draws it to a canvas and returns a JPEG (quality 0.85, scaled down to `maxWidth` keeping the ratio). The video stays paused at `at`. Bilibili's danmaku is not in the frame (it is drawn over the video, not into it).

On YouTube, while an ad plays (`#movie_player.ad-showing`) the frame waits: it clicks the skip button when one shows and gives up after 30 s with code `AD_PLAYING` (short enough to come back through the MCP server's 60 s).

`data`: `{ at, width, height, image }`, `at` the time actually shown (`video.currentTime`), `image` a `data:image/jpeg;base64,…` URL.

Errors: `NO_VIDEO` (no `<video>` on the page), `TAB_HIDDEN` (the tab has never been shown, so Chrome has not loaded the video), `SEEK_TIMEOUT` (no `seeked` within 15 s), `AD_PLAYING`, `FRAME_BLOCKED` (the canvas is tainted).

## 2. Extension ↔ MCP server (what the MCP uses)

Off by default. The user turns it on in 设置 → 高级 → 允许 MCP 连接 (`mcpEnabled`). While on, the extension's service worker keeps a WebSocket to `ws://127.0.0.1:47823/` (the MCP server is the listener). When the socket closes it reconnects after 5 s, then backs off to 60 s; it stops when the switch is turned off.

The server accepts a connection only when its `Origin` header starts with `chrome-extension://` (web pages can open WebSockets to localhost too). Any installed extension passes that check, so an extension the user installed could take the one connection and answer with made-up data; the server trusts the user's own extensions. When a second extension connects, the server keeps the first and closes the second with code 4001.

Messages are JSON text frames.

Extension → server on open: `{ type: "hello", version, extensionVersion }`. The server counts the extension as connected only after `hello`.

Server → extension: `{ id, method, params }`. Extension → server: `{ id, ok: true, data }` or `{ id, ok: false, error, code? }`.

| method | params | does |
|---|---|---|
| `get` | `{ url }` | Same `data` as `moondigest-get`, for the video at `url` |
| `frame` | `{ url, at, maxWidth? }` | Same `data` as `moondigest-frame` |
| `search` | `{ site, query, page? }` | A video search on `site` (a §5 site id whose adapter has `search`: `"bilibili"`, `"youtube"`), `page` default 1; see below |
| `favorites` | `{ folderId?, page?, query? }` | The user's Bilibili favorites, see below |
| `follows` | `{ page?, query? }` | The UP 主 the user follows, see below |
| `history` | `{ cursor? }` | The user's Bilibili watch history, see below |
| `collection` | `{ site, kind, id?, cursor? }` | One page of the user's collection on `site`, see below |
| `collectionWrite` | `{ site, op, kind, id?, items, dryRun? }` | Adds items to or removes them from that collection, see below |

`get` and `frame` find a tab already showing that video (same site and video id; Bilibili `/video/` also the part `p`, default 1; `/list/` and `/festival/` match on the `bvid` query, else the path; `/bangumi/` on its ep/ss id). A discarded tab (no content script until shown) is never picked. Else they load `url` in the extension's own tab: at most one, opened muted with `active: false` on first need and navigated to the next video afterwards, so calls never pile up tabs. Calls that need it run one at a time, and a call still queued when the server has given up (55 s after it arrived) is dropped with `TIMEOUT` instead of loading anything. A tab that no call has answered in yet counts as the requested video only while it is still loading. The extension waits up to 50 s for that tab's content script to answer (a missing reply or one without `ok` means not loaded yet), then fails with `TIMEOUT`, before the server's own 60 s. The extension rejects any `url` that is not a supported page with code `BAD_URL`. Then they run the same handler the page messages run, in that tab's content script (`chrome.tabs.sendMessage`), so both paths return identical results. A `frame` that comes back `TAB_HIDDEN` (Chrome loads no media in a tab never shown) is asked again with that tab in front, and the tab that was in front of its window is brought back afterwards, unless the user switched tabs meanwhile; `get` never switches tabs. Timeout: 60 s per call, code `TIMEOUT`.

A site whose adapter reads the page itself (§5, `read` a function) is read only in the extension's own tab: the user's tabs are never used. It fails with `NO_ACCESS` until the user has allowed the site's origins. Its `get` `data` is what `read` returned, with `site` set to the site's id. Its `frame` injects `agent-page.js` into the tab's isolated world and runs the same frame as above (`MdgAgentPage.frame`).

`search` opens no tab: the service worker fetches with the user's cookies. Bilibili: the WBI-signed `api.bilibili.com/x/web-interface/wbi/search/type?search_type=video` through the same channel as 分拣台 (`triageBiliGet`). YouTube: the `www.youtube.com/results?search_query=…` page, read from its `ytInitialData`; only the result list's own videos, no shorts, ads, channels, playlists or shelves. YouTube has page 1 only (about 20 videos); a `page` above 1 is an error. Searches run one at a time, at least 2 s apart; one still queued at the call's deadline is dropped with `TIMEOUT`. HTTP 412, B站's risk-control codes and YouTube's 429 are `THROTTLED`. No results is `items: []`, not an error.

`data`: `{ site, query, page, items }`, each item `{ site, videoId, url, title, author, duration, views, uploadDate, description }`: `url` is `https://www.bilibili.com/video/BV…` or `https://www.youtube.com/watch?v=…` (ready for `get`); `title`, `author`, `description` plain text (B站's `<em class="keyword">` highlights and HTML entities removed), `description` at most 200 characters; `duration` seconds, `0` when unknown (a live stream); `views` a number or `null`; `uploadDate` B站 `YYYY-MM-DD` (local day), YouTube as the page writes it ("2 years ago", in the browser's language), `""` when missing.

`favorites`, `follows` and `history` (`extension/agent-mydata.js`) read the user's own Bilibili account in the service worker, no tab. Off by default: while 设置 → 高级 → 允许 AI 工具读我的收藏、关注和历史 (`mcpPersonalData`, under 允许 MCP 连接 and greyed out while that is off) is off they fail with `PERSONAL_DATA_OFF`. They only GET Bilibili's read endpoints (the 分拣台's channel, `triageBiliGet`) and write nothing, to Bilibili or to storage. They run one at a time, a second apart, and return one page per call. Bilibili is asked for one page, except the folder list (up to 20 pages of folders) and 稍后再看 (all of it in one request); a ticked folder's local copy is read whole, then paged.

- `favorites` without `folderId`: `{ folders: [{ id, title, count }] }`, 稍后再看 first with id `"toview"`, then the user's own folders (Bilibili's folder list, read live). With `folderId`: `{ folderId, source, total, page, hasMore, items }`, 40 a page. A folder ticked in the 分拣台 is read from its local copy (`source: "local"`, as of the 分拣台's last read, no Bilibili request); `toview` is read whole from Bilibili in one request; any other folder is one Bilibili page (`source: "bilibili"`). `query`: words that must all appear, case-insensitive, matched on title, author, tags, note and summary for the local copy and `toview`; for other folders Bilibili's own favorites search gets it as `keyword`. An item: `{ bvid, url, title, author, duration, favTime, invalid?, progress?, tags?, note?, verdict?, summary?, kept? }`: `tags` are the user's 分拣 tags (and 摘读记录 tags), `note` the 备注, `verdict` `keep` / `drop` / `unsure` (`MdgTagCore.verdictOf`), `summary` the 细看's one-liner, `kept` the 保留 mark, `progress` seconds watched in 稍后再看 (-1 finished).
- `follows`: `{ source, total, page, hasMore, items: [{ mid, name, sign, groups, tags? }] }`, 50 a page. With a synced 关注 list (the 分拣台's 关注) it is read from there (`source: "local"`, with the user's UP 标签 as `tags`, and `query` matched on name, sign, groups and tags); else one Bilibili page of the followings plus the group names (`source: "bilibili"`, `query` is not applied and `queryIgnored: true`). `groups` are 关注分组 names, 特别关注 and 默认分组 included.
- `history`: `{ items: [{ bvid?, url, title, author, viewAt, progress, duration, kind }], cursor }`, 30 a call, newest first. `cursor` is opaque; pass it back for the next page, `""` at the end. `kind` is Bilibili's business (`archive` for a video, also `pgc`, `live`, `article`…); `progress` is seconds, -1 finished; `viewAt` seconds since the epoch.

`collection` and `collectionWrite` (`extension/agent-collections.js`) work on any site whose adapter has `collections` (§5): YouTube today. `kind` is one of the adapter's kinds, else `UNSUPPORTED_KIND`; YouTube has `watch_later`, `playlists`, `playlist` (with `id`), `likes`, `subscriptions`, `history`, and writes to `watch_later` and `playlist` only (`add`, `remove`). Calls run one at a time, a second apart, and stop with `TIMEOUT` while still queued at the deadline.

- `collection`: while 允许 AI 工具读我的收藏、关注和历史 is off, `PERSONAL_DATA_OFF`. `data`: `{ site, kind, id?, items, cursor }`, `cursor` `""` at the end, else passed back for the next page. A video `{ videoId, url, title, author, duration, unavailable? }` (`duration` 0 when unknown), a playlist `{ id, title, count? }`, a channel `{ channelId, url, title }`.
- `collectionWrite`: `items` 1 to 20 distinct ids (YouTube: video ids), else refused before any request. A real run needs 设置 → 高级 → 允许 AI 工具改我的收藏 (`mcpCollectionWrite`, under the read switch and greyed out while it or 允许 MCP 连接 is off) on as well, else `WRITE_OFF`; `dryRun: true` needs the read switch only and writes nothing. The items go one at a time, 1.5–3 s apart (random): the item's state is read first and an item already as asked is skipped (`unchanged`); otherwise a dry run reports `would_change`, a real run writes, waits 1 s and reads again (`done`, or `unconfirmed` when the read still shows the old state). `THROTTLED` (429, 403, a captcha page) or `NOT_LOGGED_IN` stops the batch; another error fails only its item (`failed`). An item is not started with less than 12 s left before the call's deadline (`stopped: "TIMEOUT"`): call again with `notDone`, which is safe since done items are skipped. `data`: `{ site, op, kind, id?, dryRun, results: [{ item, status, before?, after?, error? }], done, notDone, stopped?, undo }`, `undo` the `collectionWrite` params that reverse `done` and `unconfirmed` (or `null`). No confirmation token between a dry run and the run: the agent makes both calls, so a token would check nothing a dry run does not; the switches, the cap, the skip and the undo are the safety.
- YouTube: youtubei calls (`browse` with browseId `VLWL`, `VL<id>`, `VLLL`, `FEplaylist_aggregation`, `FEchannels`, `FEhistory`, and `continuation` for later pages; `playlist/get_add_to_playlist` for an item's state, the Save dialog's list of the user's own playlists; `browse/edit_playlist` with `ACTION_ADD_VIDEO` / `ACTION_REMOVE_VIDEO_BY_VIDEO_ID`) made in the bridge's own tab on a youtube.com page (any YouTube page it already shows, else `https://www.youtube.com/`), in the page's MAIN world, with the page's `ytcfg` context and the `SAPISIDHASH` authorization yt-dlp computes (`_get_sid_authorization_header`). Never in the user's tabs. A service worker fetch cannot make these calls: it carries the extension's `Origin`, which fetch cannot change. The endpoint and field names come from yt-dlp and public client code; they are tested against hand-written answers only, not against YouTube.

Keepalive: the server sends `{ type: "ping" }` every 20 s and the extension answers `{ type: "pong" }` (WebSocket traffic keeps an MV3 service worker alive in Chrome 116+).

## 3. Code

- `extension/agent-page.js` (content script): `MdgAgentPage.bind({ read, signal })`. `read()` is content.js's `agentRead`, the side panel's read of the page's video, resolving to §1's `get` data or rejecting with an `Error` carrying `code`. It answers the page messages and the bridge's `chrome.runtime` messages `{ type: "agent-call", method, params }` (`params` without `url`) with `{ ok, data }` or `{ ok: false, error, code }`, and runs `frame` itself.
- `extension/agent-bridge.js` (service worker): `MdgAgentBridge.start({ extensionVersion, isEnabled, onEnabledChange })`, §2's socket and tab handling. `MdgAgentBridge.addMethods({ name: (params) => reply })` adds methods answered without a tab.
- `extension/agent-search.js` (service worker): `MdgAgentSearch.search(params, deadline)`, §2's `search`: checks, the queue, then the site's adapter.
- `extension/agent-sites/` (service worker): the site registry and one adapter per site, §5.
- `extension/agent-mydata.js` (service worker, loaded after the 分拣台's `triage-bg.js` and `follow-core.js`): §2's `favorites`, `follows`, `history`.
- `extension/agent-collections.js` (service worker): §2's `collection` and `collectionWrite`, the switches and the write rules every site gets.
- `mcp/server.js`: the MCP server, `npm test` in `mcp/`.

## 4. Codes

`NOT_VIDEO_PAGE`, `TAB_HIDDEN`, `THROTTLED` (Bilibili 412 / YouTube 429: stop, do not retry soon), `NO_VIDEO`, `SEEK_TIMEOUT`, `AD_PLAYING`, `FRAME_BLOCKED`, `BAD_URL`, `NO_ACCESS` (the user has not allowed MoonDigest on that site, §5), `TOO_LARGE` (a page-run `read` returned more than 1,000,000 characters of JSON, §5), `TIMEOUT`, `NOT_CONNECTED` (MCP server: no extension connected), `PERSONAL_DATA_OFF` (the user has not allowed `favorites` / `follows` / `history`: ask them to turn on 设置 → 高级 → 允许 AI 工具读我的收藏、关注和历史), `NOT_LOGGED_IN` (not logged in to Bilibili in that browser), `NETWORK` (Bilibili did not answer), `PORT_IN_USE` (MCP server: another moondigest-mcp holds the port; it takes over when that one exits), `WRITE_OFF` (the user has not allowed `collectionWrite`: ask them to turn on 设置 → 高级 → 允许 AI 工具改我的收藏), `UNSUPPORTED_KIND` (the site has no such collection, or it is read only).

The port is fixed at 47823 on both sides. The server's `MOONDIGEST_MCP_PORT` is for tests only.

## 5. Sites

Each site the MCP server reads is one adapter, `extension/agent-sites/<id>.js`, registered with `extension/agent-sites/registry.js`. `agent-bridge.js` and `agent-search.js` ask the registry and name no site. Sites beyond Bilibili and YouTube get MCP tools only, no pages of their own.

```js
MdgAgentSites.register({
  id: "demo",                         // [a-z0-9-]+, the MCP `site` value
  origins: ["https://www.demo.com/*"], // match patterns: the user's tabs to look in, the host access to check
  key(u) {                            // u: a URL; "itemId:part" for a page this site reads, else null
    const m = /^\/v\/(\w+)$/.exec(u.pathname);
    return u.hostname === "www.demo.com" && m ? `${m[1]}:` : null;
  },
  read: (url) => {                    // "content", or a function run in the page's MAIN world (see below)
    const s = window.__INITIAL_STATE__;
    return s ? { url, title: s.title, author: s.author, duration: s.duration, description: s.desc,
      chapters: [], subtitle: { segments: [], lang: "", warning: "", missing: "no subtitle" }, comments: [] } : null;
  },
  search: async (query, page) => [],  // optional: §2's search items, throw an Error with code THROTTLED when rate-limited
  fallback: false,                    // optional: true for the one site the registry asks last (web)
  // optional, all four together: the user's collections (§2 collection / collectionWrite)
  collections: { saved: ["add", "remove"], history: [] }, // kind → the writes it takes ([] read only)
  list: async ({ kind, id, cursor }, deadline) => ({ items: [], cursor: "" }),
  has: async ({ kind, id, item }, deadline) => false,        // is item in it now
  write: async ({ op, kind, id, item }, deadline) => {},     // one item; agent-collections.js reads before and after
});
```

- `web` (`agent-sites/web.js`) is the fallback: any http(s) page no other site claims, keyed by its URL without the hash. Its `read` returns `kind: "video"` with the largest `<video>`'s duration and subtitles (cues the browser already loaded, else the default or first subtitles/captions `<track>` file, WebVTT or SRT, at most 2 MB, fetched within 8 s), or, when no `<video>` shows up within 3 s, `kind: "page"` with `text`, the main element's (`article`, `main`, else `body`) text. Title is `og:title`, else the document title; description the meta description. Subtitle text and page text stop at 100,000 characters.

- `key`: the registry prefixes the id, so two URLs of one video must give the same `itemId:part`. Two keys equal means the same video for tab reuse.
- `read: "content"`: a content script (`agent-page.js`) answers in the page; Bilibili and YouTube only, it needs a manifest entry.
- `read` a function: `chrome.scripting.executeScript({ world: "MAIN", func: read, args: [url] })` in the bridge's own tab. It is serialized: no closures, no extension globals. It returns §1's `get` data (missing fields read as unknown), `{ error, code? }` when the site refuses (the call's error, not asked again; `THROTTLED` for risk control), or a falsy value while the page is not ready, and is asked again every 0.5 s for up to 50 s. A throw counts as not ready. An answer over 1,000,000 characters of JSON fails with `TOO_LARGE`; its `comments` go through `MdgSites.cleanComment` (500 characters, 匿名 for no name), so `read` passes the page's comments on as they are. Write it as an arrow (`read: async (url) => {…}`), never the method shorthand `read(url) {…}`: Chrome runs `(` + its source + `)`, which a method's source is not; `registry.selftest.js` compiles every site's `read` that way.
- Host access: the manifest grants only Bilibili and YouTube; other sites are in `optional_host_permissions` (every http(s) site), so a new site needs no manifest change. Until the user allows its origins the site answers `NO_ACCESS`. Today the only way to allow them is the side panel's grant for reading web pages, which allows every site at once; a per-site 允许 in 设置 is not built yet.
- `list`, `has`, `write`: agent-collections.js has checked the switches, the kind, the op and the items before; the adapter writes one item per `write` and never batches, retries or skips (the rules in §2 are agent-collections.js's). Throw an Error with code `THROTTLED` or `NOT_LOGGED_IN` to stop a batch. To run in the site's page, `MdgAgentBridge.inSitePage(site, url, ready, func, args, deadline)` runs `func(...args)` once in the MAIN world of the bridge's own tab on a page of `site` (loading `url` there when it shows another site), after `ready()` there returns `{ ok: true }`; both are serialized like `read`. `func` runs once even when it fails, so it should catch and return its errors.
- A new site adds: `agent-sites/<id>.js`, `agent-sites/<id>.selftest.js` (`require("./registry.selftest.js").load("<id>.js")` gives a registry with only that site loaded), one `importScripts("agent-sites/<id>.js")` line in `background.js`, and its name in the MCP tools' descriptions (`mcp/server.js`). A `search` that reads `MdgErrors.CODE` also needs a line in `entry-matrix.selftest.js`'s `NOT_ENTRIES`.
