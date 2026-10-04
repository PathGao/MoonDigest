<div align="center">

<img src="extension/icons/icon128.png" width="96" height="96" alt="MoonDigest 图标">

# MoonDigest · 月团视频摘读

在 B 站和 YouTube 视频页读字幕、让 AI 总结和问答，再把要点存进 Obsidian。

[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Version](https://img.shields.io/badge/version-1.4.0-7c6cf2)](extension/manifest.json)
[![Platforms](https://img.shields.io/badge/platforms-Bilibili%20%7C%20YouTube-fb7299)](#功能)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

</div>

## 为什么

长视频很难判断值不值得看，收藏夹也越存越多、越来越少打开。MoonDigest 把视频变成可以读的文字：先看字幕和 AI 总结，决定要不要看原片，有价值的部分直接写进自己的笔记库。所有数据都留在你的浏览器和你自己的 Obsidian 里。

<p align="center">
  <img src="docs/images/hero-sidepanel.png" alt="视频页旁边的 AI 侧边栏，显示 AI 总结的结果和管理追问" width="900">
</p>

## 功能

功能分三档，用到哪档配哪档。设置页从上到下是：基础、进阶 1 分拣台（只有入口和 B 站页面标记开关，分拣设置在分拣台里改）、笔记格式、进阶 2 Obsidian、数据与存储、高级（调试日志）。改动后底部出现保存条，一次保存全部。

| 档位 | 能做什么 | 平台 |
|---|---|---|
| 基础 · 读字幕 + AI 总结 | 抓字幕、专注模式、导出、AI 侧边栏 | B 站、YouTube |
| 进阶 1 · 收藏夹分拣台 | 把一个收藏夹交给 AI 粗分和细看，连起来读 | 仅 B 站 |
| 进阶 2 · Obsidian 知识库 | 单个或整个收藏夹写进 Obsidian | B 站、YouTube |

### 基础 · 读字幕 + AI 总结

- **字幕**：人工、AI 和自动生成字幕；YouTube 可设默认语言，没有时用机器翻译。没有字幕的视频用简介和热门评论代替。
- **专注模式**：页面只留视频和字幕，字幕跟随播放滚动，点句子跳转。顶栏有 AI 按钮（打开侧边栏做 AI 总结）、主题切换和设置面板（排版、章节栏、字幕语言、视频信息和简介）。
- **导出**：复制 Markdown，下载 SRT 或 TXT，属性含干净链接、封面、作者、时长、发布日期和标签。
- **AI 侧边栏**：任意 OpenAI 兼容平台。AI 总结、管理追问（输入框上方的常用追问，设置页同名一段可改），切换视频自动跟随。发送按钮在生成中变成「停止」，出错时可重试。
- **导出对话**：侧边栏的「导出对话」菜单可以复制、下载 .md 或写入 Obsidian。写入 Obsidian 写进这个视频笔记的 AI 问答段，还没有视频笔记就新建一篇。每条回复下只有「复制回复」。
- **AI 对话历史**：侧边栏的历史弹层只列当前视频的对话，点「全部」或设置页「数据与存储」里的「管理 AI 对话历史」打开历史页。历史页按视频列出全部对话、分拣台 AI 总结和你的笔记，可以搜索、继续问、下载 .md、写入 Obsidian 或删除；「清空全部」只删 AI 对话，不动笔记和分拣结果。

### 进阶 1 · 收藏夹分拣台（仅 B 站）

<p align="center">
  <img src="docs/images/triage-light.png" alt="收藏夹分拣台的视频卡片列表" width="900">
</p>

- **两段式 AI 分拣**：标题粗分把几十个标题按档位分开（默认 留 / 可以删 / 待定）；字幕细看给每个视频一句话总结、要点、档位和建议标签。AI 的分类带「AI」标记（AI 留、AI 可以删、AI 待定），你做的决定显示为「已保留」「已取消收藏」。
- **分拣方案**：方案 = 判断标准 + 一套标签 + 分级。档位可以自己改（名称、给 AI 的说明、去向：保留 / 取消收藏 / 要细看），也可以关掉分级只要总结和标签。每个收藏夹记住自己的方案。
- **阅览**：把整个收藏夹的总结连起来读。
- **整理**：在分拣台里取消收藏（可撤销）、保留、打标签、写一句话笔记。打开时与 B 站同步，提示新增和失效的视频。
- **优先看**：从留下的视频里挑出真要看的，排好顺序。「看下一个」打开第一个，看完点「看过了」移出清单，不影响收藏。
- **B 站页面标记**：在 B 站的列表和搜索页上给分拣过的视频加标记。
- **批量导出**：范围选当前筛选、选中、优先看或整个收藏夹；格式选一篇摘录（带笔记）或逐个视频笔记，也可以导出 JSON 完整备份（不含密钥）和 CSV 表格。

### 进阶 2 · Obsidian 知识库

通过 Obsidian 插件 Local REST API 写入。字幕笔记和 AI 对话可以单独写；分拣台可以整个收藏夹批量写，每个视频一篇，外加一篇索引。封面存进库里，离线也能显示。
字幕笔记末尾带这个视频最近一段 AI 问答（设置里可关），侧边栏的「写入 Obsidian」也写进这一段；笔记已存在时再写入只替换这一段，其余内容不动，写入过之后每次回答完还会自动更新这一段。

### 平台支持

Chrome 和其他 Chromium 内核浏览器（只在 Chrome 上测试过），不支持 Firefox。网站支持 B 站视频页、稍后再看和 YouTube 视频页。

## 安装

两种装法任选其一。

1. 获取扩展文件：
   - **zip 包**：从 [Releases](https://github.com/PathGao/MoonDigest/releases/latest) 下载 `moondigest-vX.Y.Z-chrome.zip`，解压到一个以后不会移动的文件夹。
   - **源码**：克隆本仓库。

     ```bash
     git clone https://github.com/PathGao/MoonDigest.git
     ```

2. 打开 `chrome://extensions`，打开右上角的“开发者模式”。
3. 点“加载已解压的扩展程序”，选择 zip 解压出的文件夹，或仓库里的 `extension/` 目录。
4. 装过商店版 Bilibili Obsidian Clipper 的话，先停用它，以免视频页出现重复按钮。

### 更新

这两种装法都不会自动更新。

- **zip 包**：下载新版 zip，解压后用里面的文件覆盖原文件夹，再到 `chrome://extensions` 点 MoonDigest 卡片上的刷新按钮。一定要覆盖原文件夹：换一个文件夹加载，Chrome 会当成新扩展，原来的设置全部丢失。
- **源码**：`git pull`，再到 `chrome://extensions` 点刷新按钮。

## 快速开始

1. **配置 AI 平台**：插件图标 → 设置 → “AI 模型平台” → “添加平台”。选预设会填好地址和默认模型，再填 API Key，点底部保存条的“保存”。浏览器弹窗请求访问该地址时点允许。
2. **打开任意 B 站或 YouTube 视频**。
3. **点 AI 总结**：播放器上的 AI 按钮、专注模式顶栏的 AI 按钮，或插件弹窗里的“AI 总结”。之后可以点输入框上方的追问或直接提问。

更完整的使用教程正在写。

<p align="center">
  <img src="docs/images/options.png" alt="设置页基础档：字幕设置和 AI 模型平台" width="540">
</p>

## 使用收藏夹分拣台

在 B 站页面点插件图标 → “打开 B 站收藏夹分拣台” → 选收藏夹。标签页按进度排成四步：① 未分析 → ② 待细看 → ③ 待处理 → ④ 已处理，当前这一步的按钮跟在标签页后面：未分析点“标题粗分”，粗分拿不准的（去向为“要细看”的档，或低置信）进待细看，点“细看下一批 8 个”；有把握的和细看完的进待处理，按 AI 分类批量取消收藏或保留。

收藏夹旁的“方案”下拉可以切换、新建、编辑方案。按钮旁的“临时补充”只对下一次粗分或细看生效，不改方案。“AI 指令”用一句话修改已有结果（加减标签、改档位），确认后才生效。

| 按键 | 作用 |
|---|---|
| `J` / `↓` | 下一个 |
| `K` / `↑` | 上一个 |
| `D` | 在 B 站取消收藏 |
| `S` | 保留 |
| `T` | 打标签 |
| `A` | 采纳 AI 建议的标签 |
| `E` | 加入或移出「优先看」 |
| `X` | 选中；待细看、待处理的按钮只处理选中的 |
| `O` / `Enter` | 打开视频 |
| `U` | 撤销 |
| `I` | AI 指令 |
| `Q` | 问 AI（在侧边栏打开这个视频） |
| `?` | 快捷键帮助 |

“阅览”标签页里只有 `I` 和 `?` 生效。

<p align="center">
  <img src="docs/images/triage-dark.png" alt="分拣台深色主题" width="900">
</p>

## 隐私与权限

- 所有设置、分拣结果和对话都存在浏览器本地的 `chrome.storage.local`。API Key 也存在这里，不会出现在导出文件里。
- 插件只向这些地方发请求：B 站和 YouTube（含它们的封面图片服务器），你配置的 AI 平台，以及你本机的 Obsidian。没有作者的服务器，也没有统计。
- AI 平台的地址是保存设置时按需申请的，只申请你填的那个地址。

| 权限 | 用途 |
|---|---|
| `storage`、`unlimitedStorage` | 在本地保存设置、分拣结果、字幕和对话缓存 |
| `scripting` | 在视频页按需注入内容脚本（抓字幕、专注模式、播放器 AI 按钮） |
| `sidePanel` | 显示 AI 侧边栏 |
| `cookies` | 读取 B 站的 `bili_jct`，用于在分拣台取消收藏等写操作 |
| `declarativeNetRequest` | 给分拣台发往 B 站接口的请求加上 B 站的 Referer 和 Origin |
| B 站、YouTube 域名 | 读取视频信息、字幕和评论，在 B 站页面显示分拣标记 |
| `127.0.0.1`、`localhost` | 连接本机的 Obsidian Local REST API |
| 可选：任意 http/https 地址 | 只在你添加 AI 平台时，针对那个平台的地址弹窗申请 |

## 常见问题

**YouTube 提示“字幕接口限流（429）”**

YouTube 短时间内收到太多请求时会暂时拒绝。插件会稍等重试一次，再改试文字稿接口（成功的字幕轨标为「文字稿」）。仍然失败就过几分钟再试；长时间不恢复时换个网络。

**“字幕抓取失败”和“无字幕”有什么区别？**

“无字幕”是视频本身没有字幕，AI 会改用简介和热门评论总结。“字幕抓取失败”是有字幕但没拿到，通常是网络或限流，稍后重试即可。

**YouTube 提示“该视频需要登录或年龄验证”**

年龄限制、频道会员专享的视频，以及 YouTube 怀疑当前网络是自动程序时，都要求登录。插件用你页面里已登录的播放器取字幕，所以你能在 YouTube 正常播放的视频，一般都能拿到；会员专享视频需要你本人是会员。被当成自动程序时，换个网络或等一段时间。

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
├── content.js         视频页内的字幕抓取、专注模式、播放器 AI 按钮（字幕显示在插件弹窗里）
├── background.js      后台 service worker：AI 请求、Obsidian 写入、权限
├── sidepanel.*        AI 侧边栏
├── popup.*            插件弹窗
├── options.*          设置页
├── badges.*           B 站页面上的分拣标记
├── tokens.css         共享的颜色、字号和间距变量（含深色主题）
├── triage/            收藏夹分拣台页面和后台接口（triage-bg.js）
├── history/           AI 对话历史页
└── dev-sidepanel/     侧边栏的开发预览
```

### 自检

```bash
for f in extension/*.selftest.js extension/triage/*.selftest.js; do node "$f" || break; done
```

### 不装插件预览页面

```bash
# 分拣台和历史页：在 extension/ 下起静态服务，打开 /triage/triage.html 或 /history/history.html，会自动加载各自 dev/mock-chrome.js 的假数据
cd extension && python3 -m http.server 8000

# 侧边栏：先生成预览页，再打开 /dev-sidepanel/index.html
node extension/dev-sidepanel/build.mjs
```

### 打包

```bash
python3 scripts/build_release.py
```

产物在 `release/` 下；传一个目录参数可改输出位置。README 的版本徽章和 manifest 版本不一致时打包会失败。

### YouTube 字幕的取法

做法参照 yt-dlp：读页面播放器的字幕轨；地址要求校验参数（PO token）时，从播放器已发出的字幕请求里取，没有就把字幕开关短暂切换一次让播放器发出请求。拿不到时依次退回安卓客户端、嵌入式播放器（年龄限制）和文字稿接口。这依赖播放器的内部实现，YouTube 改版后需要跟进。

## 路线图

- YouTube 播放列表的批量阅览
- 上架 Chrome 应用商店

## 贡献

欢迎提 [issue](https://github.com/PathGao/MoonDigest/issues)。报 bug 时请写清楚视频链接、浏览器版本和复现步骤。提 PR 前请先跑一遍上面的自检。

## 致谢

- 基于 [haixiong1997/Bilibili-Obsidian-Clipper](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper)（MIT）。
- YouTube 字幕的取法参照 [yt-dlp](https://github.com/yt-dlp/yt-dlp)。

## 许可

Copyright (C) 2026 PathGao

MoonDigest 以 [GPL-3.0](LICENSE) 发布。来自上游的部分保留原有的 MIT 许可声明，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 免责声明

本工具只在你已登录 B 站、且有访问权限的前提下读取和修改你自己的收藏数据。所有请求都通过你自己的浏览器和 cookie 发出。请遵守 B 站用户协议与相关法律法规，使用后果由使用者自行承担。
