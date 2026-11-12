# moondigest-mcp

[中文](#中文) · [English](#english)

## 中文

### 这是什么

一个可选的 MCP 服务器。装了它，Claude Code、Cursor、Codex 这类 MCP 客户端就能借你自己的浏览器和登录：搜索和读 B站、YouTube 视频（搜索结果、字幕、章节、热评、任意时刻的一帧画面），读你的 B站 收藏夹、关注、历史和 YouTube 的收藏，并且直接改 B站 收藏夹和分拣台的结果。每次修改都有记录，可以撤销。真正读和改的是浏览器里的 MoonDigest 扩展，这个服务器只负责转发。

```
MCP 客户端 ──stdio──> moondigest-mcp ──ws://127.0.0.1:47823──> 扩展的 service worker ──> B站 / YouTube
```

搜索和读视频：

- `search_videos({ query, site?, page?, raw? })`：在 B站（默认）或 YouTube 搜视频，每个视频一行：标题、作者、时长、播放量、日期、链接，链接可以直接交给 `get_video`。`page` 从 1 开始，每页约 20 个；YouTube 只有第 1 页。`raw: true` 返回 JSON，多一段简介。
- `get_video({ url, brief?, raw? })`：标题、作者、日期、时长、章节、带时间戳的全文字幕、热评；B站 视频还带分区和视频标签。B站 的 `/video/` 链接由扩展后台直接请求 B站 接口，不开标签页，约 1 秒一个；多个调用在扩展里排队，一个接一个读，所以可以连续发出。`brief: true` 只返回简介、分区、视频标签和字幕的前两分钟（没有字幕时带最多 5 条热评），用来成批判断视频讲的是什么。番剧、活动页和 YouTube 仍在标签页里读，`brief` 对它们不起作用。结果里的 `Video id` 写明这是哪个视频。
- `get_frame({ url, at, maxWidth? })`：`at` 秒处的一帧 JPEG，外加一行实际时间。
- `get_covers({ bvids })`：最多 16 个 B站 视频的封面拼成一张图，4 列，每格左上角有编号，顺序和 `bvids` 一致。封面地址取自勾选收藏夹的本地副本，不请求 B站 接口；本地副本里没有的视频和加载失败的封面是灰格。

读你自己的 B站 数据：

- `get_favorites({ folderId?, page?, query?, all?, verdict?, stage?, tag?, invalid?, raw? })`：
  - 不给 `folderId`：列出收藏夹（稍后再看在最前，id 是 `toview`），每个收藏夹带 B站 的视频数、是否私密、是否已在分拣台勾选、本地副本里有多少个视频。
  - 给 `folderId`：这个收藏夹的视频，每页 40 个，带分拣台的标签、备注、AI 判断和一句话总结。分拣台勾选过的收藏夹读本地副本（不含读取之后已取消收藏的视频），`query` 搜标题、UP、标签、备注和总结；没勾选的每次从 B站 读一页，`query` 交给 B站 的收藏夹搜索（只搜标题）。
  - `all: true`：只读本地副本，不请求 B站。所有勾选收藏夹合成一个精简列表，每页 300 个，每个视频一行、只出现一次，写明它在哪几个收藏夹里。可以筛选：`verdict`（`none` 是还没有 AI 判断，`keep`、`drop`、`unsure`）、`stage`（`none`、`coarse` 粗看、`fine` 细看）、`tag`（标签名）、`invalid`（`true` 只要已失效的，`false` 只要没失效的）、`query`；`folderId` 把范围限定到一个收藏夹。还没有本地副本的勾选收藏夹不在列表里，结果会列出它们的 id，先用 `sync_favorites` 读取。
- `sync_favorites({ include?, exclude?, start?, folders?, raw? })`：管分拣台勾选哪些收藏夹，并从 B站 读取它们的本地副本。
  - 不带参数：收藏夹列表和读取进度。
  - `include` / `exclude`：勾选、取消勾选收藏夹。取消勾选的后果：下次打开分拣台时，这个收藏夹的本地副本和取消收藏记录会被删除，不在其他勾选收藏夹里的视频进「已出分拣范围」；AI 判断、保留、备注和标签都留着。取消勾选有撤销记录：`undo` 会重新勾选并放回取消收藏记录，副本要再同步一次。
  - `start: true`：在扩展后台读取勾选的收藏夹（或 `folders` 指定的几个），不需要打开分拣台。调用立刻返回，再不带参数调用一次看进度。视频没有增减的收藏夹只花一次请求。B站 限流时读取停下，结果里写明。扩展后台被浏览器重启后，没读完的不会接着读，要再 `start` 一次。
- `get_follows({ page?, query?, raw? })`：关注的 UP 主，每页 50 个，带关注分组和你的 UP 标签。分拣台的「关注」刷新过就读本地的关注列表；没刷新过就按关注分组从 B站 读整份名单（和分拣台刷新同一种读法，3 分钟内翻页不再读 B站）。两种情况 `query` 都能用。
- `get_history({ cursor?, raw? })`：观看历史，从新到旧，每次 30 条，把返回的 `cursor` 传回去读更早的。

`get_favorites`、`get_follows`、`get_history` 同一时间只跑一个，两次之间隔 1 秒。

改 B站 收藏夹和分拣台。这几个工具直接执行，不先问你；每次修改都有记录，可以撤销（见下面「安全模型」）。参数整份先检查，有一处不对就什么都不改，返回 `BAD_PARAMS`：

- `fav_write({ op, from?, to?, bvids?, folder?, title?, private?, acceptLoss?, raw? })`：直接在 B站 改收藏，同时更新分拣台的本地副本和记录。
  - `move` / `copy`：把 `bvids` 从收藏夹 `from` 移动或复制到收藏夹 `to`。`unfav`：把 `bvids` 从 `from` 取消收藏。`clean_invalid`：把 `from` 的本地副本里标为已失效的视频取消收藏。`from` 可以是 `toview`（`clean_invalid` 除外），`to` 不能是。
  - `folder_create`（`title`、`private`）、`folder_rename`（`folder`、`title`）、`folder_privacy`（`folder`、`private`）、`folder_delete`（`folder`）：新建收藏夹、改名、改公开或私密、删除收藏夹。名字最多 20 个字。
  - 一次最多 500 个视频，每次请求 20 个、间隔 1 秒（稍后再看一次请求 1 个）。一次调用的时间不够时停下，返回没改的视频（`notDone`），把它们再发一次。B站 限流（`THROTTLED`）时也停下，这时不要马上重试。
  - `from` 有本地副本时，`bvids` 必须都在本地副本里，否则返回 `BAD_PARAMS`：先用 `sync_favorites` 重新读取。
  - `folder_delete`：B站 的视频数有时比列表里列出的多，多出来的看不到，多半是已被删除的视频。这时不删除，返回 `HIDDEN_ITEMS` 和相差的个数：删除收藏夹后这些视频撤销也找不回来。你同意后带 `acceptLoss: true` 再调用。
  - 结果里带撤销编号（`undoId`）。
- `undo({ id?, list?, raw? })`：撤销一次有记录的修改。`id` 是撤销编号，不给就撤销最近一次。`list: true` 只列出记录（B站和 YouTube 上的修改留最近 100 次，本地的修改另留最近 100 次），不撤销。
  - 取消收藏、清理失效视频：把视频加回原收藏夹，一次请求一个视频。
  - 移动：移回原收藏夹。复制：从目标收藏夹取消收藏。调用前目标收藏夹里已经有的视频留在目标收藏夹（移动的会再复制回原收藏夹）。
  - 新建收藏夹：删除它；里面已经有视频时不删除，返回错误。改名、改公开或私密：改回原来的。
  - 删除收藏夹：新建一个同名的收藏夹，把记录里的视频加回去。这是一个新的收藏夹，id 和原来不同，不会自动勾选；B站 计入视频数但没有列出的视频找不回来。
  - `set_triage` 写的结果：只改回仍是 Agent 写入的值，你之后改过的不动。判断标准：仍是 Agent 写的那一份才改回去。
  - 撤销 B站 上的修改时，调用的时间不够或被 B站 限流会停下，返回还剩多少个视频；用同一个撤销编号再调用一次，从停下的地方继续。
- `set_triage({ items })`：一次最多 50 个视频，每个 `{ bvid, verdict?, coarse?, confidence?, summary?, reason?, points?, kept?, note?, folderId?, addTags?, removeTags? }`，只改给了的字段。`verdict`（`keep` / `drop` / `unsure`）有两种写法：读过视频后的判断带 `summary`，和分拣台细看的结论一样显示，卡片上标「 Agent 判断」；只看标题、标签或封面的判断带 `coarse: true` 和 `reason`（可以带 `confidence`：`high` 或 `low`），存成粗看结果，以后细看会覆盖它。`kept` 是保留标记；`note` 是备注，空字符串删掉；`addTags` / `removeTags` 是 `folderId` 这个收藏夹的标签名，视频要在这个勾选过的收藏夹里，没有的标签在名额内新建，满了不建并在结果里列出。只改本地，不改 B站。结果里带撤销编号。
- `triage_settings({ folderId?, criteria?, raw? })`：每个勾选收藏夹的判断标准和标签（标签的说明、有多少个视频打了它）。带 `folderId` 和 `criteria` 时改这个收藏夹的判断标准，空字符串是删掉。改了以后，按旧判断标准得出的结果在分拣台里算过期，所以 Agent 应当告诉你改了什么；结果里带撤销编号。

你自己 YouTube 的收藏有两个工具。MoonDigest 不为它们做页面，Agent 就是界面：

- `list_collection({ site, kind, id?, cursor?, raw? })`：`site` 写 `bilibili` 时 `kind` 只有 `watch_later`（稍后再看）；B站 的收藏夹、关注和历史仍用上面的工具。`site` 写 `youtube` 时 `kind` 是 `watch_later`（稍后观看）、`playlists`（你的 YouTube 播放列表）、`playlist`（`id` 那个 YouTube 播放列表里的视频）、`likes`（赞过的视频）、`subscriptions`（订阅）、`history`（历史记录）。一次一页，把返回的 `cursor` 传回去读下一页。
- `collection_write({ site, op, kind, id?, items, dryRun?, raw? })`：把视频加进或移出 B站稍后再看、YouTube 稍后观看（都是 `kind: "watch_later"`）或你自己的 YouTube 播放列表（`kind: "playlist"`, `id`）。`items` 是 BV 号或 YouTube 视频 id。赞和订阅只能读。`dryRun: true` 只读、不改。一次最多 20 个，一个一个改，间隔 1.5 到 3 秒；每个先读一次，已经是那样的跳过，改完再读一次确认（YouTube 以它自己的写入回应为准：它的状态要十来秒才更新）。被限流（`THROTTLED`）或掉了登录就停，返回改了哪些、哪些没动，和撤销用的那次调用。它的修改也进撤销记录，结果里带撤销编号，用 `undo` 撤销。撤销不能完全复原：移出后再加回的视频排到列表末尾，原来的位置回不来；同一个视频在 YouTube 播放列表里出现多次时，移出会按视频 id 移走，撤销只加回一次。

`get_video` 默认返回紧凑文本，每条字幕一行 `[mm:ss] 内容`（超过一小时用 `hh:mm:ss`）。扩展原始 JSON 每条字幕都带 `from`、`to`、`content` 三个键名和小数时间，实测体积约是文本的两倍，而模型几乎用不到结束时间。确实要精确时间时传 `raw: true`。

### 用 MCP 还是用 skill

- **skill**（`skills/moondigest/`）：agent 本来就在操控浏览器（能在页面里跑 JS）时用。不用开开关，不用装服务器。只能读它打开的那个视频页，不能读你的账号，也不能改。
- **MCP**：任何 MCP 客户端都能用，agent 不需要会操控浏览器。读你的收藏夹、关注、历史，成批读视频，改收藏夹和分拣台，都只有 MCP 能做。代价是要装这个服务器，并在 MoonDigest 的「设置 → MCP」打开「允许 Agent 使用我的 B站和 YouTube 账号」。

### 安装

需要 Node 20 或更高版本。

Claude Code：

```sh
claude mcp add moondigest -- npx -y moondigest-mcp@latest
```

`@latest` 让 `npx` 每次随 Agent 启动取最新版，服务跟着插件一起更新，不用手动升级。插件的设置 → MCP 里有各客户端的这条命令，带复制按钮。

Cursor（`~/.cursor/mcp.json` 或项目里的 `.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "moondigest": { "command": "npx", "args": ["-y", "moondigest-mcp@latest"] }
  }
}
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.moondigest]
command = "npx"
args = ["-y", "moondigest-mcp@latest"]
```

改代码时用本地的一份：克隆仓库，在 `mcp/` 里 `npm install`，把上面的 `npx` 和参数换成 `node` 和 `/path/to/MoonDigest/mcp/server.js`。

最后在 MoonDigest 的「设置 → MCP」打开「允许 Agent 使用我的 B站和 YouTube 账号」。这一节还列出各客户端的安装命令（带「复制」按钮，路径要换成你电脑上 MoonDigest 文件夹的位置），并写明现在是否已连接。

### 安全模型

- 只监听 `127.0.0.1`，局域网和外网连不上。
- 只接受 `Origin` 以 `chrome-extension://` 开头的连接。网页也能向 localhost 开 WebSocket，这一条把它们挡在外面（握手直接被拒）。但任何已装的扩展都能通过这一条：你装的别的扩展可以抢先连上，给 agent 回假数据。服务器信任你自己装的扩展。
- 同一时间只认一个扩展。第二个连上来会被关闭（关闭码 4001）。
- B站 的 `/video/` 链接由扩展后台直接读，不用标签页。番剧（`/bangumi/play/`）、活动页（`/festival/`）、不带 BV 号的 `/list/` 和 YouTube 观看页（`/watch?v=`）可以用你已开着的标签页；没有就用扩展自己的后台标签页，最多开一个，之后的视频都在它里面打开。其他网址返回 `BAD_URL`。`get_video` 不会切换标签页。Chrome 不给从没显示过的标签页加载视频，所以 `get_frame` 第一次在这种标签页里截帧时，会把它切到前台截完，再切回你原来的标签页，屏幕会闪一下。
- `search_videos` 不开标签页：扩展后台带着你的登录状态直接请求 B站的搜索接口或 YouTube 的搜索结果页。一次只搜一个，两次搜索至少隔 2 秒。
- 只有一个开关：「允许 Agent 使用我的 B站和 YouTube 账号」，默认关闭。关着的时候扩展不建任何连接，所有工具都返回 `NOT_CONNECTED`。打开后上面的工具都能用，包括改收藏夹和分拣台的；没有按数据种类分开的开关。API Key 和 AI 对话任何时候都不会给出去。
- 修改不先问你，安全靠撤销。`fav_write`、`collection_write`、`set_triage`、`triage_settings` 改判断标准和 `sync_favorites` 取消勾选的每次调用，都记在扩展的本地存储里（B站和 YouTube 上的修改留最近 100 次，本地的修改另留最近 100 次）：改了哪些视频、原来在哪个收藏夹、原来的值。三个地方都能撤销：Agent 调用 `undo`；分拣台里按 U；设置 → MCP 的「Agent 最近的修改」里点「撤销」。关掉开关以后，后两个地方照样能撤销。
- 撤销做不到的事：删除收藏夹撤销后是一个新的收藏夹，B站 没有列出的视频找不回来；各自超出最近 100 次的修改没有记录；撤销取消勾选会重新勾选并放回取消收藏记录，副本要再同步一次；YouTube 播放列表里移出再加回的视频会排到末尾。
- 字幕、简介和评论是别人写的文字，里面可能夹着写给 AI 的指令。服务器给 Agent 的说明要求把这些文字当作数据，不照着做，只改你要求改的。这一条由 Agent 遵守，扩展检查不了；被诱导做出的修改同样有记录，可以撤销。
- B站 的收藏夹和稍后再看由扩展后台直接改，发的是分拣台自己用的那些请求。YouTube 的读和改都在扩展自己的后台标签页里、YouTube 网页自己的环境中发出，和 YouTube 网页自己发的请求一样，不碰你开着的标签页。

### 两个 MCP 客户端同时开着

每个 MCP 客户端都会启动自己的 moondigest-mcp，但端口只有一个。做法是：

- 先启动的那个占住端口，正常工作。
- 后启动的不会崩溃。它的工具调用返回 `PORT_IN_USE`，说明端口被另一个 moondigest-mcp 占着。
- 每次工具调用它都会再试一次占端口。先启动的那个退出后（它的客户端关掉时会跟着退出），下一次调用就会接管端口，扩展最多一分钟内连过来。

没有扩展连着时，调用立刻返回 `NOT_CONNECTED`，提示打开「允许 Agent 使用我的 B站和 YouTube 账号」。扩展每分钟重连一次，所以开关刚打开、或服务刚启动时，等一分钟再调用。

`MOONDIGEST_MCP_PORT` 环境变量可以改端口，但扩展固定连 47823，所以它只在测试里有用。

### 排查

- `NOT_CONNECTED`：浏览器没开、没装 MoonDigest、或「设置 → MCP」的「允许 Agent 使用我的 B站和 YouTube 账号」没开。刚打开开关的话，等一分钟扩展连上再试。设置页的 MCP 一节写着现在是否已连接。
- `PORT_IN_USE`：另一个 MCP 客户端的 moondigest-mcp 占着端口，见上一节。也可以用 `lsof -nP -iTCP:47823 -sTCP:LISTEN` 看是谁。
- `THROTTLED`：B站或 YouTube 在限流。停下来，过一阵再试，不要连续重试。
- `TIMEOUT`：60 秒内没有回答。常见原因是页面加载太慢，或后台标签页被浏览器冻结。切到那个标签页看一眼再试。
- 字幕说要登录（`Subtitle note`）：在这个浏览器里登录 B站。
- `AD_PLAYING`：YouTube 广告一直在播，等广告结束再取帧。
- `BAD_PARAMS`：参数不对，错误里写着哪一项；这次什么都没改。`fav_write` 说视频不在收藏夹里时，本地副本过期了：用 `sync_favorites` 重新读取。
- `HIDDEN_ITEMS`：`fav_write` 的 `folder_delete` 没有删除：B站 的视频数比列表里列出的多。见上面 `fav_write`。
- `NOT_LOGGED_IN`：这个浏览器没登录 B站（收藏工具：没登录 YouTube）。

### 测试

```sh
cd mcp && npm test
```

## English

### What it is

An optional MCP server. It lets MCP clients such as Claude Code, Cursor and Codex work through your own browser and login: search and read Bilibili and YouTube videos (search results, transcript, chapters, hot comments, a frame at any time), read your Bilibili favorites, follows and history and your YouTube collections, and change your Bilibili favorites and 分拣台 results directly. Every change is recorded and can be undone. The MoonDigest extension in your browser does the reading and the changing. This server only relays.

```
MCP client ──stdio──> moondigest-mcp ──ws://127.0.0.1:47823──> extension service worker ──> Bilibili / YouTube
```

Search and read videos:

- `search_videos({ query, site?, page?, raw? })`: search Bilibili (default) or YouTube, one line per video: title, author, duration, views, date, URL. The URLs go straight to `get_video`. `page` starts at 1, about 20 videos a page; YouTube has page 1 only. `raw: true` returns JSON with a short description per video.
- `get_video({ url, brief?, raw? })`: title, author, date, duration, chapters, the full timestamped transcript, hot comments; for a Bilibili video also its zone and tags. A Bilibili `/video/` URL is read by the extension's background through Bilibili's API, no tab, about a second a video; calls queue inside the extension and run one after another, so you may send several. `brief: true` returns only the description, zone, tags and the transcript's first two minutes (up to 5 hot comments when there is no subtitle), for telling what many videos are about. 番剧, 活动页 and YouTube are still read in a tab, where `brief` has no effect. The result's `Video id` says which video it is for.
- `get_frame({ url, at, maxWidth? })`: a JPEG frame at `at` seconds, plus a line with the actual time.
- `get_covers({ bvids })`: the covers of up to 16 Bilibili videos as one image, 4 columns, each cell numbered at its top-left in the order of `bvids`. The cover URLs come from the local copies of the ticked folders, with no Bilibili API request; a video the copies do not have, or a cover that does not load, is a grey cell.

Read your own Bilibili data:

- `get_favorites({ folderId?, page?, query?, all?, verdict?, stage?, tag?, invalid?, raw? })`:
  - Without `folderId`: the folders (稍后再看 first, id `toview`), each with Bilibili's video count, whether it is private, whether it is ticked in the 分拣台, and how many videos its local copy holds.
  - With `folderId`: that folder's videos, 40 a page, with your 分拣 tags, note, AI verdict and one-line summary. A folder ticked in the 分拣台 is read from its local copy (without the videos 取消收藏 since the copy was read) and `query` searches title, UP, tags, note and summary; any other folder is read from Bilibili a page at a time and `query` goes to Bilibili's favorites search (titles only).
  - `all: true`: local copies only, no Bilibili request. Every ticked folder as one compact list, 300 a page, one line a video, each video once with every folder it is in. Filters: `verdict` (`none`: no AI verdict yet, `keep`, `drop`, `unsure`), `stage` (`none`, `coarse`: 粗看, `fine`: 细看), `tag` (a tag name), `invalid` (`true`: only unavailable videos, `false`: only available ones), `query`; `folderId` limits it to one folder. Ticked folders with no local copy yet are not in the list; the result names them, and `sync_favorites` reads them.
- `sync_favorites({ include?, exclude?, start?, folders?, raw? })`: which folders are ticked in the 分拣台, and reading their local copies from Bilibili.
  - No parameters: the folder list and the progress of a read.
  - `include` / `exclude`: tick and untick folders. What unticking costs: the next time the 分拣台 is open, that folder's local copy and its 取消收藏 records are removed, and its videos that are in no other ticked folder go to 已出分拣范围; AI verdicts, 保留, notes and tags stay. An untick is recorded: `undo` ticks the folder again and puts its 取消收藏 records back; its copy needs another sync.
  - `start: true`: reads the ticked folders (or those in `folders`) in the extension's background, without the 分拣台 open. The call answers at once; call again with no parameters for the progress. A folder whose videos did not change costs one request. Rate limiting stops the read, and the result says so. If the browser restarts the extension's background, the rest is not read: `start` again.
- `get_follows({ page?, query?, raw? })`: the UP 主 you follow, 50 a page, with follow groups and your UP tags. Read from the 分拣台's follow list when it has one; otherwise Bilibili's whole list, read by follow group as the 分拣台's refresh reads it (paging within 3 minutes does not read Bilibili again). `query` works either way.
- `get_history({ cursor?, raw? })`: watch history, newest first, 30 a call. Pass the returned `cursor` back for older items.

`get_favorites`, `get_follows` and `get_history` run one at a time, a second apart.

Change your Bilibili favorites and the 分拣台. These tools act at once and do not ask you first; every change is recorded and can be undone (see Security model). Each call is checked whole first: one bad field changes nothing and returns `BAD_PARAMS`.

- `fav_write({ op, from?, to?, bvids?, folder?, title?, private?, acceptLoss?, raw? })`: changes your favorites on Bilibili, and keeps the 分拣台's local copies and records in step.
  - `move` / `copy`: `bvids` from folder `from` to folder `to`. `unfav`: takes `bvids` out of `from`. `clean_invalid`: takes out of `from` the videos its local copy marks unavailable. `from` may be `toview` (not for `clean_invalid`), `to` may not.
  - `folder_create` (`title`, `private`), `folder_rename` (`folder`, `title`), `folder_privacy` (`folder`, `private`), `folder_delete` (`folder`). A name is at most 20 characters.
  - Up to 500 videos a call, 20 a request, a second apart (稍后再看: one a request). A call that runs out of time stops and returns the videos not changed (`notDone`): send those again. Rate limiting (`THROTTLED`) stops it too: do not retry soon.
  - When `from` has a local copy, every bvid must be in it, else `BAD_PARAMS`: read it again with `sync_favorites`.
  - `folder_delete`: Bilibili sometimes counts more videos than its list returns; the extra ones cannot be seen and are most likely deleted videos. Then nothing is deleted and the call returns `HIDDEN_ITEMS` with the difference: once the folder is deleted, undo cannot bring those back. Call again with `acceptLoss: true` when you agree.
  - The result carries an undo id (`undoId`).
- `undo({ id?, list?, raw? })`: reverses one recorded change. `id` is an undo id; without it the newest change. `list: true` lists the recorded changes (the last 100 on Bilibili and YouTube, and the last 100 local ones) and undoes nothing.
  - Unfavorite, clean unavailable: the videos are favorited into their folder again, one request a video.
  - Move: moved back. Copy: taken out of the target folder. Videos the target folder already held before the call stay in it (after a move they are copied back to the source).
  - New folder: deleted, unless it holds videos by now (an error). Rename, privacy: set back.
  - Deleted folder: a new folder with the same name is made and the recorded videos are favorited into it. It is a new folder with a new id and is not ticked again; the videos Bilibili counted but did not list are lost.
  - `set_triage` results: only values still as the AI tool wrote them go back; what you changed since stays. 判断标准: set back only while it is still the text the AI tool wrote.
  - Undoing a change on Bilibili stops when the call runs out of time or Bilibili rate-limits, and says how many videos are left; call `undo` with the same id to go on from there.
- `set_triage({ items })`: up to 50 videos, each `{ bvid, verdict?, coarse?, confidence?, summary?, reason?, points?, kept?, note?, folderId?, addTags?, removeTags? }`; only the fields given change. `verdict` (`keep` / `drop` / `unsure`) comes two ways: after reading the video, with `summary`, shown like a 细看's and marked Agent 判断 on the card; from the title, tags or cover alone, with `coarse: true` and `reason` (and optionally `confidence`: `high` or `low`), stored as a 粗看 result that a later 细看 overrides. `kept` is the 保留 mark. `note` is the note, `""` removes it. `addTags` / `removeTags` are tag names of folder `folderId`, which must be ticked and hold the video; a missing tag is made while the folder has room, else it is not made and the result lists it. Local only, nothing on Bilibili. The result carries an undo id.
- `triage_settings({ folderId?, criteria?, raw? })`: each ticked folder's 判断标准 and tags (a tag's rule, how many videos carry it). With `folderId` and `criteria` it sets that folder's 判断标准; `""` removes it. Results judged by the old one then count as stale in the 分拣台, so the AI tool should tell you what it changed; the result carries an undo id.

Two tools work on your own YouTube collections. MoonDigest has no pages for them: the AI tool is the UI.

- `list_collection({ site, kind, id?, cursor?, raw? })`: `site` `bilibili` has only `kind` `watch_later` (稍后再看); Bilibili favorites, follows and history stay in the tools above. `site` `youtube` has `kind` `watch_later`, `playlists` (your playlists), `playlist` (the videos of playlist `id`), `likes`, `subscriptions` or `history`. One page a call; pass the returned `cursor` back for the next.
- `collection_write({ site, op, kind, id?, items, dryRun?, raw? })`: adds videos to or removes them from Bilibili 稍后再看 or YouTube Watch later (both `kind: "watch_later"`) or one of your own YouTube playlists (`kind: "playlist"`, `id`). `items` are BV ids or YouTube video ids. Likes and subscriptions are read-only. `dryRun: true` only reads. At most 20 a call, one at a time, 1.5 to 3 s apart; each is read first (already so: skipped) and again after (confirmed; YouTube by its own answer to the write, since its state takes about 12 s to catch up). Rate limiting (`THROTTLED`) or a lost login stops the batch; the result says what was done and not tried, and gives an undo id. Its changes are recorded like the others: `undo` reverses them. Undo is not exact: a video removed and added back goes to the end of the list, not its old place; a video that was in a playlist more than once is removed by its id and added back once.

`get_video` returns compact text by default, one transcript line per segment as `[mm:ss] text` (`hh:mm:ss` past an hour). The extension's raw JSON repeats the `from`, `to` and `content` keys and fractional times on every segment, which measures about twice the size, and models rarely need end times. Pass `raw: true` when you do need exact times.

### MCP or the skill

- **Skill** (`skills/moondigest/`): use it when the agent already drives a browser and can run JS in the page. No switch, no server. It reads the video page it opened and nothing else: not your account, and it changes nothing.
- **MCP**: works from any MCP client, and the agent needs no browser automation. Only the MCP reads your favorites, follows and history, reads many videos in a row, and changes favorites and the 分拣台. It needs this server installed and the switch in MoonDigest's 设置 → MCP (Settings → MCP) turned on: 允许 Agent 使用我的 B站和 YouTube 账号.

### Install

Needs Node 20 or later.

Claude Code:

```sh
claude mcp add moondigest -- npx -y moondigest-mcp@latest
```

With `@latest`, `npx` takes the newest version each time the agent starts, so the server keeps up with the extension and never needs a manual update. The extension's 设置 → MCP shows this command for each client, with a copy button.

Cursor (`~/.cursor/mcp.json` or the project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "moondigest": { "command": "npx", "args": ["-y", "moondigest-mcp@latest"] }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.moondigest]
command = "npx"
args = ["-y", "moondigest-mcp@latest"]
```

To work on the code, use a local copy: clone the repository, run `npm install` in `mcp/`, and replace `npx` and its arguments above with `node` and `/path/to/MoonDigest/mcp/server.js`.

Then turn on 允许 Agent 使用我的 B站和 YouTube 账号 in MoonDigest's 设置 → MCP. That section also lists the install command for each client (with a 复制 button; replace the path with where your MoonDigest folder is) and says whether the extension is connected now.

### Security model

- Listens on `127.0.0.1` only. Nothing on the network can reach it.
- Accepts a connection only when its `Origin` starts with `chrome-extension://`. Web pages can open WebSockets to localhost too. This check rejects them at the handshake. Any installed extension passes it, though: another extension you installed could connect first and answer with made-up data. The server trusts the extensions you installed.
- One extension at a time. A second one is closed with code 4001.
- A Bilibili `/video/` URL is read by the extension's background, with no tab. 番剧 (`/bangumi/play/`), 活动页 (`/festival/`), a `/list/` without a BV id and YouTube watch pages (`/watch?v=`) may be read in a tab you already have open; else in the extension's own background tab, at most one, which later videos reuse. Any other URL gets `BAD_URL`. `get_video` never switches tabs. Chrome loads no video in a tab that has never been shown, so the first `get_frame` in such a tab brings it to the front for the frame and then switches back to the tab you had open: the screen flashes once.
- `search_videos` opens no tab: the extension's background requests Bilibili's search API or YouTube's results page directly, with your login. One search at a time, at least 2 s apart.
- One switch: 允许 Agent 使用我的 B站和 YouTube 账号, off by default. While off, the extension opens no socket and every tool returns `NOT_CONNECTED`. While on, every tool above works, including the ones that change favorites and the 分拣台; there is no switch per kind of data. API keys and AI conversations are never given out.
- Changes do not ask you first; safety is undo. Every `fav_write`, `collection_write`, `set_triage`, 判断标准 change by `triage_settings` and untick by `sync_favorites` is recorded in the extension's local storage (the last 100 on Bilibili and YouTube, and the last 100 local ones): which videos, which folder they were in, the values before. Three places undo one: the AI tool calling `undo`; U in the 分拣台; 撤销 under Agent 最近的修改 in 设置 → MCP. The last two work with the switch off too.
- What undo cannot do: a deleted folder comes back as a new folder, without the videos Bilibili did not list; changes beyond those are not recorded; undoing an untick ticks the folder again and puts its 取消收藏 records back, and its copy needs another sync; a video taken out of a YouTube playlist and put back ends up last.
- Transcripts, descriptions and comments are text other people wrote, and may contain instructions aimed at an AI. The server's instructions tell the AI tool to treat that text as data, not to act on it, and to change only what you asked for. The AI tool has to follow this; the extension cannot check it. A change it was talked into is recorded like any other and can be undone.
- Bilibili favorites and 稍后再看 are changed by the extension's background directly, with the requests the 分拣台 itself uses. YouTube reads and writes are sent from the extension's own background tab, in the YouTube page's own context, the same requests the YouTube page sends; your open tabs are not used.

### Two MCP clients at once

Each MCP client starts its own moondigest-mcp, and there is only one port:

- The first one to start holds the port and works.
- The later one does not crash. Its tool calls return `PORT_IN_USE`, saying another moondigest-mcp holds the port.
- It retries the port on every tool call. Once the first one exits (it exits when its client closes), the next call takes the port over, and the extension reconnects within a minute.

With no extension connected, a call returns `NOT_CONNECTED` at once, asking for 允许 Agent 使用我的 B站和 YouTube 账号 to be turned on. The extension reconnects once a minute, so right after turning the switch on or starting the server, wait a minute and call again.

`MOONDIGEST_MCP_PORT` changes the port, but the extension always connects to 47823, so it is only useful in tests.

### Troubleshooting

- `NOT_CONNECTED`: the browser is not open, MoonDigest is not installed, or 允许 Agent 使用我的 B站和 YouTube 账号 in 设置 → MCP is off. Right after turning it on, wait a minute for the extension to connect. The MCP section of the settings page says whether it is connected.
- `PORT_IN_USE`: another MCP client's moondigest-mcp holds the port, see above. `lsof -nP -iTCP:47823 -sTCP:LISTEN` shows which process.
- `THROTTLED`: Bilibili or YouTube is rate limiting. Stop and try later. Do not retry in a loop.
- `TIMEOUT`: no answer in 60 s. Usually the page loaded too slowly or the browser froze the background tab. Look at that tab and try again.
- The subtitle says log in (`Subtitle note`): log in to Bilibili in that browser.
- `AD_PLAYING`: a YouTube ad kept playing. Wait for it to end and grab the frame again.
- `BAD_PARAMS`: a parameter is wrong, the error says which; nothing was changed. When `fav_write` says a video is not in the folder, the local copy is stale: read it again with `sync_favorites`.
- `HIDDEN_ITEMS`: `fav_write` `folder_delete` deleted nothing: Bilibili counts more videos than its list returns. See `fav_write` above.
- `NOT_LOGGED_IN`: that browser is not logged in to Bilibili (for the collection tools: YouTube).

### Tests

```sh
cd mcp && npm test
```
