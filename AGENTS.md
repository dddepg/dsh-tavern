# DSH Tavern

## 提交

每完成一个比较大的功能点或修复，立即单独提交一次；提交只包含该功能点或修复，避免混入无关改动。如果只是很琐碎的改动，比如调整一下文本、按钮位置，则不必自动提交。

## 推送

GitHub Actions 会频繁向 `origin/main` 推送 `chore: publish runtime manifest [skip ci]`（只改 `dsh-tavern-runtime.json`），导致本地推送被拒。推送流程：

1. `git fetch origin`
2. `git log --oneline HEAD..origin/main`，确认远程只多了 manifest 提交；有其他提交先告知用户
3. `git rebase origin/main`
4. `git push origin main`

禁止 force push。
