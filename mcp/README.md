# moondigest-mcp

[中文](#中文) · [English](#english)

## 中文

### 这是什么

一个可选的 MCP 服务器。装了它，Claude Code、Cursor、Codex 这类 MCP 客户端就能借你自己的浏览器读 B站和 YouTube 视频：字幕、章节、热评，以及任意时刻的一帧画面。真正读视频的是浏览器里的 MoonDigest 扩展，这个服务器只负责转发。

```
MCP 客户端 ──stdio──> moondigest-mcp ──ws://127.0.0.1:47823──> 扩展的 service worker ──> 视频标签页
```

两个工具：

- `get_video({ url, raw? })`：标题、作者、日期、时长、章节、带时间戳的全文字幕、热评。
- `get_frame({ url, at, maxWidth? })`：`at` 秒处的一帧 JPEG，外加一行实际时间。

`get_video` 默认返回紧凑文本，每条字幕一行 `[mm:ss] 内容`（超过一小时用 `hh:mm:ss`）。扩展原始 JSON 每条字幕都带 `from`、`to`、`content` 三个键名和小数时间，实测体积约是文本的两倍，而模型几乎用不到结束时间。确实要精确时间时传 `raw: true`。

### 用 MCP 还是用 skill

- **skill**（`skills/moondigest/`）：agent 本来就在操控浏览器（能在页面里跑 JS）时用。不用开开关，不用装服务器。
- **MCP**：任何 MCP 客户端都能用，agent 不需要会操控浏览器。代价是要装这个服务器，并在 MoonDigest 的「设置 → 高级 → 允许 MCP 连接」打开开关。

### 安装

需要 Node 20 或更高版本。

> 还没有发布到 npm。发布之前请用本地路径的写法。

本地路径（现在就能用）：

```sh
cd /path/to/MoonDigest/mcp && npm install
claude mcp add moondigest -- node /path/to/MoonDigest/mcp/server.js
```

发布到 npm 之后：

```sh
claude mcp add moondigest -- npx -y moondigest-mcp
```

Cursor（`~/.cursor/mcp.json` 或项目里的 `.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "moondigest": { "command": "node", "args": ["/path/to/MoonDigest/mcp/server.js"] }
  }
}
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.moondigest]
command = "node"
args = ["/path/to/MoonDigest/mcp/server.js"]
```

发布后把 `node` 和路径换成 `npx` 和 `["-y", "moondigest-mcp"]`。

最后在 MoonDigest 的「设置 → 高级」打开「允许 MCP 连接」。

### 安全模型

- 只监听 `127.0.0.1`，局域网和外网连不上。
- 只接受 `Origin` 以 `chrome-extension://` 开头的连接。网页也能向 localhost 开 WebSocket，这一条把它们挡在外面（握手直接被拒）。但任何已装的扩展都能通过这一条：你装的别的扩展可以抢先连上，给 agent 回假数据。服务器信任你自己装的扩展。
- 同一时间只认一个扩展。第二个连上来会被关闭（关闭码 4001）。
- 扩展只会打开 B站视频页（`/video/`、`/bangumi/play/`、`/list/`、`/festival/`）和 YouTube 观看页（`/watch?v=`），其他网址一律返回 `BAD_URL`。扩展最多开一个自己的后台标签页，之后的视频都在它里面打开。`get_video` 不会切换标签页。Chrome 不给从没显示过的标签页加载视频，所以 `get_frame` 第一次在这种标签页里截帧时，会把它切到前台截完，再切回你原来的标签页，屏幕会闪一下。
- 开关默认关闭。关着的时候扩展不建任何连接。

### 两个 MCP 客户端同时开着

每个 MCP 客户端都会启动自己的 moondigest-mcp，但端口只有一个。做法是：

- 先启动的那个占住端口，正常工作。
- 后启动的不会崩溃。它的工具调用返回 `PORT_IN_USE`，说明端口被另一个 moondigest-mcp 占着。
- 每次工具调用它都会再试一次占端口。先启动的那个退出后（它的客户端关掉时会跟着退出），下一次调用就会接管端口，扩展最多一分钟内连过来。

刚开始监听的 65 秒内，调用会先等扩展连上再回答，因为扩展断线重连的间隔最长是 60 秒。过了这段时间还没有扩展，就立刻返回 `NOT_CONNECTED`。

`MOONDIGEST_MCP_PORT` 环境变量可以改端口，但扩展固定连 47823，所以它只在测试里有用。

### 排查

- `NOT_CONNECTED`：浏览器没开、没装 MoonDigest、或「允许 MCP 连接」没开。
- `PORT_IN_USE`：另一个 MCP 客户端的 moondigest-mcp 占着端口，见上一节。也可以用 `lsof -nP -iTCP:47823 -sTCP:LISTEN` 看是谁。
- `THROTTLED`：B站或 YouTube 在限流。停下来，过一阵再试，不要连续重试。
- `TIMEOUT`：60 秒内没有回答。常见原因是页面加载太慢，或后台标签页被浏览器冻结。切到那个标签页看一眼再试。
- 字幕说要登录（`Subtitle note`）：在这个浏览器里登录 B站。
- `AD_PLAYING`：YouTube 广告一直在播，等广告结束再取帧。

### 测试

```sh
cd mcp && npm test
```

## English

### What it is

An optional MCP server. It lets MCP clients such as Claude Code, Cursor and Codex read Bilibili and YouTube videos through your own browser: transcript, chapters, hot comments, and a frame at any time. The MoonDigest extension in your browser does the reading. This server only relays.

```
MCP client ──stdio──> moondigest-mcp ──ws://127.0.0.1:47823──> extension service worker ──> video tab
```

Two tools:

- `get_video({ url, raw? })`: title, author, date, duration, chapters, the full timestamped transcript, hot comments.
- `get_frame({ url, at, maxWidth? })`: a JPEG frame at `at` seconds, plus a line with the actual time.

`get_video` returns compact text by default, one transcript line per segment as `[mm:ss] text` (`hh:mm:ss` past an hour). The extension's raw JSON repeats the `from`, `to` and `content` keys and fractional times on every segment, which measures about twice the size, and models rarely need end times. Pass `raw: true` when you do need exact times.

### MCP or the skill

- **Skill** (`skills/moondigest/`): use it when the agent already drives a browser and can run JS in the page. No switch, no server.
- **MCP**: works from any MCP client, and the agent needs no browser automation. It needs this server installed and MoonDigest's 设置 → 高级 → 允许 MCP 连接 (Settings → Advanced → Allow MCP connection) turned on.

### Install

Needs Node 20 or later.

> Not published to npm yet. Use the local path form until it is.

Local path (works now):

```sh
cd /path/to/MoonDigest/mcp && npm install
claude mcp add moondigest -- node /path/to/MoonDigest/mcp/server.js
```

After it is on npm:

```sh
claude mcp add moondigest -- npx -y moondigest-mcp
```

Cursor (`~/.cursor/mcp.json` or the project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "moondigest": { "command": "node", "args": ["/path/to/MoonDigest/mcp/server.js"] }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.moondigest]
command = "node"
args = ["/path/to/MoonDigest/mcp/server.js"]
```

Once published, replace `node` and the path with `npx` and `["-y", "moondigest-mcp"]`.

Then turn on 允许 MCP 连接 in MoonDigest's settings (高级).

### Security model

- Listens on `127.0.0.1` only. Nothing on the network can reach it.
- Accepts a connection only when its `Origin` starts with `chrome-extension://`. Web pages can open WebSockets to localhost too. This check rejects them at the handshake. Any installed extension passes it, though: another extension you installed could connect first and answer with made-up data. The server trusts the extensions you installed.
- One extension at a time. A second one is closed with code 4001.
- The extension opens only Bilibili video pages (`/video/`, `/bangumi/play/`, `/list/`, `/festival/`) and YouTube watch pages (`/watch?v=`). Any other URL gets `BAD_URL`. It keeps at most one background tab of its own and opens later videos in it. `get_video` never switches tabs. Chrome loads no video in a tab that has never been shown, so the first `get_frame` in such a tab brings it to the front for the frame and then switches back to the tab you had open: the screen flashes once.
- The switch is off by default. While off, the extension opens no socket.

### Two MCP clients at once

Each MCP client starts its own moondigest-mcp, and there is only one port:

- The first one to start holds the port and works.
- The later one does not crash. Its tool calls return `PORT_IN_USE`, saying another moondigest-mcp holds the port.
- It retries the port on every tool call. Once the first one exits (it exits when its client closes), the next call takes the port over, and the extension reconnects within a minute.

For the first 65 seconds after it starts listening, a call waits for the extension before answering, because the extension's reconnect delay is at most 60 seconds. After that, with no extension, it returns `NOT_CONNECTED` at once.

`MOONDIGEST_MCP_PORT` changes the port, but the extension always connects to 47823, so it is only useful in tests.

### Troubleshooting

- `NOT_CONNECTED`: the browser is not open, MoonDigest is not installed, or 允许 MCP 连接 is off.
- `PORT_IN_USE`: another MCP client's moondigest-mcp holds the port, see above. `lsof -nP -iTCP:47823 -sTCP:LISTEN` shows which process.
- `THROTTLED`: Bilibili or YouTube is rate limiting. Stop and try later. Do not retry in a loop.
- `TIMEOUT`: no answer in 60 s. Usually the page loaded too slowly or the browser froze the background tab. Look at that tab and try again.
- The subtitle says log in (`Subtitle note`): log in to Bilibili in that browser.
- `AD_PLAYING`: a YouTube ad kept playing. Wait for it to end and grab the frame again.

### Tests

```sh
cd mcp && npm test
```
