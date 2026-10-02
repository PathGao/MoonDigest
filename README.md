<div align="center">

<img src="extension/icons/icon128.png" width="96" height="96" alt="MoonDigest 图标">

# MoonDigest · 月团视频摘读

在 B 站和 YouTube 视频页读字幕、让 AI 总结和问答，再把要点存进 Obsidian。

[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Version](https://img.shields.io/badge/version-1.3.0-7c6cf2)](extension/manifest.json)
[![Platforms](https://img.shields.io/badge/platforms-Bilibili%20%7C%20YouTube-fb7299)](#功能)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

</div>

## 为什么

长视频很难判断值不值得看，收藏夹也越存越多、越来越少打开。MoonDigest 把视频变成可以读的文字：先看字幕和 AI 总结，决定要不要看原片，有价值的部分直接写进自己的笔记库。所有数据都留在你的浏览器和你自己的 Obsidian 里。

<p align="center">
  <img src="docs/images/hero-sidepanel.png" alt="视频页旁边的 AI 侧边栏，显示一键总结的结果和快捷追问" width="900">
</p>

## 功能

功能分三档，用到哪档配哪档。设置页也按这三档排列。

| 档位 | 能做什么 | 平台 |
|---|---|---|
| 基础 · 读字幕 + AI 总结 | 抓字幕、阅读视图、导出、AI 侧边栏 | B 站、YouTube |
| 进阶 1 · 收藏夹批量阅览 | 把一个收藏夹交给 AI 粗分和细看，连起来读 | 仅 B 站 |
| 进阶 2 · Obsidian 知识库 | 单个或整个收藏夹写进 Obsidian | B 站、YouTube |

### 基础 · 读字幕 + AI 总结

- **字幕抓取**：支持人工字幕、AI 字幕和自动生成字幕。YouTube 可设默认字幕语言，没有该语言时用 YouTube 机器翻译。
- **阅读视图**：字幕跟随播放滚动，点句子跳到对应时间。
- **导出**：复制 Markdown，下载 SRT 或 TXT。笔记属性包含清理过的链接、封面、站点、作者主页、时长、发布日期和视频标签。
- **AI 侧边栏**：支持任何 OpenAI 兼容平台（OpenAI、DeepSeek、智谱、Moonshot、OpenRouter、Ollama 等）。
  - 一键总结：播放器上的 AI 按钮、插件弹窗或侧边栏都能触发。
  - 快捷追问：总结下方给出常用追问，问题列表可在设置里改。
  - 跟随播放：切换视频时侧边栏自动切到新视频。
  - 请求超时会结束回复并给出重试按钮。
- **没有字幕也能总结**：视频没有字幕时，用简介和热门评论作为上下文。B 站和 YouTube 评论都支持。

### 进阶 1 · 收藏夹批量阅览（仅 B 站）

<p align="center">
  <img src="docs/images/triage-light.png" alt="收藏夹分拣台：建议留的视频列表和右侧摘录篮" width="900">
</p>

- **两段式 AI 分拣**
  - 标题粗分：一次把几十个标题交给 AI，分成建议删、建议留、待定。
  - 字幕细看：读字幕，每个视频给一句话总结、要点、判断和建议标签。可以选一组细看，也可以细看全部未看。
- **阅览**：把整个收藏夹的总结连起来读，快速扫一遍。
- **直接操作 B 站**：在分拣台里取消收藏，可以撤销。
- **自定义标签**：标签挂在视频上，换收藏夹也不会丢。
- **和 B 站同步**：打开时对比 B 站最新收藏，提示新增、已移除和已失效的视频。
- **摘录篮**：把要点收集到一起，复制为 Markdown 或写入 Obsidian。
- **B 站页面标记**：在 B 站的列表和搜索页上给分拣过的视频加标记，可在设置里关闭。
- **数据导出**：完整备份（JSON，不含任何密钥）和表格（CSV，Excel 可直接打开）。

### 进阶 2 · Obsidian 知识库

- 通过 Obsidian 插件 Local REST API 写入，不需要同步服务。
- 视频页的字幕笔记和侧边栏里的 AI 对话都可以单独写入。
- 分拣台可以把整个收藏夹批量写入：每个视频一篇笔记，再加一篇以收藏夹命名的索引笔记。
- 封面图片存进库里，笔记离线也能显示。

### 平台支持

- 浏览器：在 Chrome 上开发和测试，Edge 等 Chromium 内核浏览器应能使用，但没有专门测试。**不支持 Firefox**。manifest 里的 Firefox 字段是上游遗留，打包脚本只出 Chrome 包，并会去掉这些字段。
- 网站：B 站视频页、稍后再看，以及 YouTube 视频页。收藏夹分拣台只支持 B 站，YouTube 播放列表暂不支持。

## 安装

目前从源码安装。

1. 下载或克隆本仓库：

   ```bash
   git clone https://github.com/PathGao/MoonDigest.git
   ```

2. 打开 `chrome://extensions`，打开右上角的“开发者模式”。
3. 点“加载已解压的扩展程序”，选择仓库里的 `extension/` 目录。
4. 如果装过商店版 Bilibili Obsidian Clipper，请先停用它，否则视频页会出现重复的按钮。

更新时 `git pull`，再到 `chrome://extensions` 点 MoonDigest 卡片上的刷新按钮。

## 快速开始

1. **配置 AI 平台**。点插件图标，打开设置，在“AI 模型平台”里添加一个 OpenAI 兼容平台，填地址、模型名和 API Key，然后点“保存设置”。浏览器会弹窗请求访问这个平台的地址，点允许。
2. **打开一个视频**。任意 B 站或 YouTube 视频页。
3. **点 AI 总结**。用播放器上的 AI 按钮或插件弹窗里的“AI 总结”，侧边栏会打开并开始总结。之后可以点快捷追问，或直接输入问题。

<p align="center">
  <img src="docs/images/options.png" alt="设置页基础档：字幕设置和 AI 模型平台" width="540">
</p>

## 使用收藏夹分拣台

在 B 站页面点插件图标，选“打开 B 站收藏夹分拣台”，然后选择收藏夹，点“标题粗分”，再点“细看这一组”。

| 按键 | 作用 |
|---|---|
| `J` / `↓` | 下一个 |
| `K` / `↑` | 上一个 |
| `D` | 在 B 站取消收藏 |
| `S` | 保留 |
| `T` | 打标签 |
| `A` | 采纳 AI 建议的标签 |
| `E` | 加入或移出摘录篮 |
| `X` | 选中，用来组成细看的一组 |
| `O` / `Enter` | 打开视频 |
| `U` | 撤销 |
| `I` | AI 指令 |
| `?` | 快捷键帮助 |

在“阅览”标签页里只有 `J` `K` `I` `?` 生效，其他卡片按键和 `U` 不起作用。

<p align="center">
  <img src="docs/images/triage-dark.png" alt="分拣台深色主题" width="900">
</p>

界面跟随系统的浅色或深色主题。

## 隐私与权限

- 所有设置、分拣结果和对话都存在浏览器本地的 `chrome.storage.local`。API Key 也存在这里，不会出现在导出文件里。
- 插件只向这些地方发请求：B 站和 YouTube（含它们的封面图片服务器），你配置的 AI 平台，以及你本机的 Obsidian。没有作者的服务器，也没有统计。
- AI 平台的地址是保存设置时按需申请的，只申请你填的那个地址。

| 权限 | 用途 |
|---|---|
| `storage`、`unlimitedStorage` | 在本地保存设置、分拣结果、字幕和对话缓存 |
| `scripting` | 在视频页按需注入字幕面板 |
| `sidePanel` | 显示 AI 侧边栏 |
| `cookies` | 读取 B 站的 `bili_jct`，用于在分拣台取消收藏等写操作 |
| `declarativeNetRequest` | 给分拣台发往 B 站接口的请求加上 B 站的 Referer 和 Origin |
| B 站、YouTube 域名 | 读取视频信息、字幕和评论，在 B 站页面显示分拣标记 |
| `127.0.0.1`、`localhost` | 连接本机的 Obsidian Local REST API |
| 可选：任意 http/https 地址 | 只在你添加 AI 平台时，针对那个平台的地址弹窗申请 |

## 常见问题

**YouTube 提示“字幕接口限流（429）”**

YouTube 短时间内收到太多字幕请求时会拒绝服务。插件遇到 429 会等三到五秒再试一次，再被拒就停止，以免限制时间变长，然后改试一次网页自己的文字稿接口（字幕下载被限流或视频需要登录时都会试，成功的字幕轨标为「文字稿」）。仍然失败就等几分钟再试。

**“字幕抓取失败”和“无字幕”有什么区别？**

“无字幕”是视频本身没有字幕轨，这时 AI 会用简介和热门评论来总结。“字幕抓取失败”是有字幕但请求失败了，通常是网络问题或限流，刷新后重试即可。视频信息不受影响。

**YouTube 提示“该视频需要登录或年龄验证，暂不支持”**

YouTube 在三种情况下要求登录：

- **年龄限制视频**：需要登录确认年龄，最常见。
- **频道会员专享视频**：只有该频道的付费会员能看。
- **“请登录以确认你不是机器人”**：YouTube 怀疑当前网络是自动程序时，普通视频也会要求登录。换个网络或等一段时间通常就恢复了。

插件优先用页面播放器自己的字幕地址，它带着你的登录状态。这些地址要附一个播放器现场生成的校验参数，插件从播放器已经发出的字幕请求里读取它；播放器还没请求过字幕时，插件会把字幕开关短暂切换一下再恢复原状，以便播放器发出一次请求。读不到时退回安卓客户端的接口，它不认登录状态，所以上面这些视频会被它拒绝；年龄限制视频再试一次嵌入式播放器的接口，最后试带登录状态的文字稿接口（见上一条）。全部失败才显示这条提示。会员专享视频仍需你本人是该频道会员。

**为什么保存 AI 平台时浏览器会弹窗？**

插件没有预先申请访问所有网站的权限。你添加一个 AI 平台时，它只申请那一个地址。拒绝后 AI 请求会失败，侧边栏会提示重新授权。

**怎么连接 Obsidian？**

1. 在 Obsidian 社区插件里安装并启用 **Local REST API with MCP**。
2. 在它的设置里打开 **Enable Non-encrypted (HTTP) Server**，地址一般是 `http://127.0.0.1:27123`。
3. 复制 API Key，填进 MoonDigest 设置页“进阶 2 · Obsidian 知识库”里的地址和 Key，打开开关并保存。

## 开发

不需要构建，`extension/` 就是可以直接加载的扩展目录。

```
extension/
├── manifest.json
├── sites.js           站点注册表：B 站和 YouTube 的视频信息、字幕、评论抓取
├── note.js            笔记生成：Markdown、frontmatter、SRT、TXT
├── content.js         视频页内的字幕面板、阅读视图、播放器 AI 按钮
├── background.js      后台 service worker：AI 请求、Obsidian 写入、权限
├── sidepanel.*        AI 侧边栏
├── popup.*            插件弹窗
├── options.*          设置页
├── badges.*           B 站页面上的分拣标记
├── tokens.css         共享的颜色、字号和间距变量（含深色主题）
├── triage/            收藏夹分拣台页面和后台接口（triage-bg.js）
└── dev-sidepanel/     侧边栏的开发预览
```

### 自检

```bash
node extension/background.selftest.js
node extension/badges.selftest.js
node extension/content-tokens.selftest.js
node extension/note.selftest.js
node extension/sites.selftest.js
node extension/triage/triage-bg.selftest.js
node extension/triage/triage.selftest.js
```

### 不装插件预览页面

```bash
# 分拣台：在 extension/ 下起静态服务，打开 /triage/triage.html，会自动加载 triage/dev/mock-chrome.js 的假数据
cd extension && python3 -m http.server 8000

# 侧边栏：先生成预览页，再打开 /dev-sidepanel/index.html
node extension/dev-sidepanel/build.mjs
```

### 打包

```bash
python3 scripts/build_release.py
```

产物在 `release/` 下，只打 Chrome 包；传一个目录参数可改输出位置。README 的版本徽章和 manifest 版本不一致时打包会失败。

## 路线图

- YouTube 字幕校验参数：现在从播放器的请求里读取，依赖播放器的内部实现（字幕按钮和请求地址格式）；YouTube 改版后若读不到，需要跟进
- YouTube 播放列表的批量阅览
- 上架 Chrome 应用商店

## 贡献

欢迎提 [issue](https://github.com/PathGao/MoonDigest/issues)。报 bug 时请写清楚视频链接、浏览器版本和复现步骤。提 PR 前请先跑一遍上面的自检。

## 致谢

- [haixiong1997/Bilibili-Obsidian-Clipper](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper)：本项目的上游，字幕面板、阅读视图和 AI 侧边栏都来自它。
- [crazihead/Youtube-Obsidian-Clipper](https://github.com/crazihead/Youtube-Obsidian-Clipper) 和 [jdepoix/youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api)：YouTube 字幕抓取参考了它们的做法。
- UI UX Pro Max：界面设计规范。
- 原名 BiliDigest，与同名项目 [JackMeds/BiliDigest](https://github.com/JackMeds/BiliDigest)（Python 命令行工具）无关，没有使用其代码。

## 许可

Copyright (C) 2026 PathGao

MoonDigest 以 [GPL-3.0](LICENSE) 发布。来自上游的部分保留原有的 MIT 许可声明，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 免责声明

本工具只在你已登录 B 站、且有访问权限的前提下读取和修改你自己的收藏数据。所有请求都通过你自己的浏览器和 cookie 发出。请遵守 B 站用户协议与相关法律法规，使用后果由使用者自行承担。
