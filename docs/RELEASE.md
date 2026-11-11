# 发版

## 步骤

1. 改 `extension/manifest.json` 的 `version` 和 README 顶部的版本徽章，跟功能改动一起走 PR。
2. 发版前检查：
   - README 的说明和 `docs/images/` 里的截图是否还对得上这一版。
   - 权限：`manifest.json` 的 `permissions`、`host_permissions` 有没有变。变了见下面「新权限」。
   - Chrome 和 Edge 商店的说明、截图、图标是否要跟着改。商店信息只能在各自后台改，上传 API 只传安装包。
3. PR 合并后推标签 `vX.Y.Z`。`.github/workflows/release.yml` 会检查标签和 manifest 版本一致、打包、建 GitHub Release，再上传 Chrome 和 Edge 商店并提交审核。两个商店互不影响，一个失败另一个照传。Edge 的 certification notes 写在 workflow 里。

## MCP 服务（npm 包 `moondigest-mcp`）

- 改了 `mcp/` 就把 `mcp/package.json` 的 `version` 和 `mcp/server.js` 里 `new Server({ version })` 一起加一号，跟功能改动走同一个 PR。推标签后 `release.yml` 的 `npm` 任务发现这个版本号还不在 npm 上，就跑 `mcp/` 的测试并发布；版本号没变就什么都不发。
- 不用令牌：npm 上这个包的 Settings → Trusted Publisher 里登记了 GitHub 仓库 `PathGao/MoonDigest` 和工作流文件 `release.yml`，npm 只认这个工作流发出的包。
- 第一次要手动发，因为 Trusted Publisher 要等包存在后才能配置：在 `mcp/` 里运行 `npm publish --access public`（要输两步验证码），再到 npm 的包设置页登记上面两项。在那之前 `npm` 任务只打印一行提示，不算失败。
- 发布后要同步：设置页 MCP 一节的安装命令（`extension/options.js` 的 `MCP_INSTALL`）、`mcp/README.md` 和 skill 里的安装命令改成 `npx -y moondigest-mcp`。

## 用到的 secret

- Chrome：`CWS_CLIENT_ID`、`CWS_CLIENT_SECRET`、`CWS_REFRESH_TOKEN`。没有 `CWS_REFRESH_TOKEN` 时跳过。
- Edge：`EDGE_CLIENT_ID`、`EDGE_API_KEY`（Partner Center → Publish API）。没有 `EDGE_API_KEY` 时跳过。API key 有过期时间，过期后在同一页重新生成。

## 出错怎么补

- **上一版还在审核**：上传会被拒（`You may not edit or publish an item that is in review`）。Release 照常建好，审核结束后补传：`gh workflow run release.yml -f tag=vX.Y.Z`。已有 Release 的标签重跑时只做商店上传，两个商店都会重传，已经传成功的那个可能报错，不用管。
- **新权限**：商店的「需请求 X 的理由」框要等含新权限的包传上去才出现，没法提前填。顺序是：推标签 → CI 上传成功但发布报「does not meet the requirements」→ 后台隐私权页补填理由、保存草稿 → 点「提请审核」（「跳过审核」不勾，「通过后自动发布」勾）。商店页和隐私权的草稿会随这次一起提审。
- **Edge 新权限**：Edge 后台「Privacy」页也是每个权限一个理由框，同样要等新包传上去才出现，但 API 提交不会因为理由空着而失败，会直接送审。所以有新权限时，CI 跑完马上到 Privacy 页补填理由并 Save（这会另开一份草稿），再在概览页对审核中那份点 Cancel submission，等一两分钟撤回完成后对草稿点 Publish，重填 certification notes。
