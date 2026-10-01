# DSH Tavern

## 提交

每完成一个比较大的功能点或修复，立即单独提交一次；提交只包含该功能点或修复，避免混入无关改动。如果只是很琐碎的改动，比如调整一下文本、按钮位置，则不必自动提交。

## 推送

GitHub Actions 会频繁向 `origin/main` 推送 `chore: publish runtime manifest [skip ci]`（只改 `dsh-tavern-runtime.json`），导致本地推送被拒。推送流程：

1. `git fetch origin`
2. `git log --oneline HEAD..origin/main`，确认远程只多了 manifest 提交；有其他提交先告知用户
3. `git rebase origin/main`
4. `git push origin main`

### 推送后刷新 CDN

安装入口从 jsDelivr 的 `@main` 读取 `install.ps1` / `install.sh` / `dsh-tavern-runtime.json`，最长缓存 12 小时；代码文件却按清单里的提交号下载。旧安装脚本配新代码会报“安装文件不完整，缺少……”。

推送的提交只要改动了 `install.ps1`、`install.sh`，或者删除、移动了安装脚本会检查的文件，就等 Publish runtime manifest 工作流推送新清单后，立即刷新这三个文件的缓存，并用 curl 确认 CDN 内容已是新版：

```sh
for f in install.ps1 install.sh dsh-tavern-runtime.json; do curl -s "https://purge.jsdelivr.net/gh/flizzywine/dsh-tavern@main/$f" >/dev/null; done
curl -s https://cdn.jsdelivr.net/gh/flizzywine/dsh-tavern@main/dsh-tavern-runtime.json | grep revision
```

汇报时分开说明 GitHub 是否已发布、CDN 是否已刷新，没刷新不能说已刷新。

## 测试

测试已有几千条，全量跑一次约 3 分钟。除非做版本发布，否则不要跑全量 `node bin/test-tavern.mjs`；只跑与改动相关的测试文件：
`node bin/test-tavern.mjs tests/<相关>.test.mjs [更多文件…]`
