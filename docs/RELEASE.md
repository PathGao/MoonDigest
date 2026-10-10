# 发版

## 步骤

1. 改 `extension/manifest.json` 的 `version` 和 README 顶部的版本徽章，跟功能改动一起走 PR。
2. 发版前检查：
   - README 的说明和 `docs/images/` 里的截图是否还对得上这一版。
   - 权限：`manifest.json` 的 `permissions`、`host_permissions` 有没有变。变了见下面「新权限」。
   - Chrome 商店的说明、截图、图标是否要跟着改。商店信息只能在开发者后台改，上传 API 只传安装包。
3. PR 合并后推标签 `vX.Y.Z`。`.github/workflows/release.yml` 会检查标签和 manifest 版本一致、打包、建 GitHub Release，再上传 Chrome 商店并提交审核。
4. Edge 商店目前手动上传：在 Partner Center 传 zip，每次都要填 certification notes。

## 用到的 secret

`CWS_CLIENT_ID`、`CWS_CLIENT_SECRET`、`CWS_REFRESH_TOKEN`。没有 `CWS_REFRESH_TOKEN` 时跳过商店上传，只建 Release。

## 出错怎么补

- **上一版还在审核**：上传会被拒（`You may not edit or publish an item that is in review`）。Release 照常建好，审核结束后补传：`gh workflow run release.yml -f tag=vX.Y.Z`。已有 Release 的标签重跑时只做商店上传。
- **新权限**：商店的「需请求 X 的理由」框要等含新权限的包传上去才出现，没法提前填。顺序是：推标签 → CI 上传成功但发布报「does not meet the requirements」→ 后台隐私权页补填理由、保存草稿 → 点「提请审核」（「跳过审核」不勾，「通过后自动发布」勾）。商店页和隐私权的草稿会随这次一起提审。
