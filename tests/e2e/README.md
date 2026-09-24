# 游玩验收 E2E

自动执行：启动酒馆 → 选择角色卡 → 新开一局 → 发消息玩一轮 → 检查正文、金币和人物姿势 → 刷新页面 → 确认同一局的数据仍然保留 → 生成 4+1 候选项并选择行动 → 再玩一轮 → 重新生成正文 → 编辑正文并刷新 → 回退并刷新。

## 运行

安装项目依赖并准备 Chromium：

```sh
pnpm install
pnpm exec playwright install chromium
pnpm build:client
pnpm test:e2e
```

需要已安装酒馆的 DSH runtime，默认使用 `~/.dsh-tavern/runtime`。可用 `TAVERN_E2E_RUNTIME=/其他/runtime` 指定。当前在 macOS、DSH `0.1.5-rc.2`、Playwright Chromium 上验收；这不是 Android APK 测试。

每次创建临时 Profile、会话和角色卡，使用随机本地端口，不读取现有游玩数据或复制模型密钥。结束时关闭本次启动的浏览器和服务，删除临时数据。默认不加入常规 `pnpm test`，按需执行。

## 验证范围

实际运行 DSH、酒馆插件、浏览器、人物卡状态栏、官方 MVU 本地运行时与存储。只替换模型输出：固定回复领取奖励，通过真实 `mvu_submit_update` 和 `posture_submit` 工具完成结算。测试不会直接把金币写成预期值，也不会模拟酒馆 HTTP 接口。

界面必须显示金币 10 和正确姿势；独立读取落盘数据核对金币、结算回执、消息数与会话身份。刷新后重复这些检查，不能重复生成消息。状态栏故意每 200 毫秒更新 DOM，覆盖“页面一直变化导致变量同步迟迟不启动”的缺陷。

候选生成不能修改现有正文或金币；第二轮金币更新为 20；重生成把最新正文替换为雨夜版本并结算至 30，不能新增故事轮次；手工编辑保留变量和结算回执；回退恢复第一轮及金币 10，刷新后仍一致。

不覆盖真实模型的生成质量、远程 API 可用性、所有人物卡、压缩或 Android。先保留这一条核心验收路径，有具体风险再增加场景。

## 产物和失败检查

每次结果保存到 `output/e2e-gameplay/run-*`：

- `report.json`：每一步耗时、失败步骤、刷新前后结果。
- `before-reload.png` / `after-reload.png`、`second-turn.png`、`regenerated.png`、`edited-after-reload.png`、`after-rollback.png`：各阶段页面截图。
- `failure.png` / `failure.txt`：失败现场。
- `saved-state.json`：测试会话的实际落盘证据。
- `trace.zip`：浏览器操作和网络记录，可用 `pnpm exec playwright show-trace <路径>` 查看。
- `server.log`：本次服务日志，启动令牌已脱敏。Trace 仍包含本次临时服务的网络信息。

负向对照：让固定模型提交 9，但业务断言仍然要求 10。这条命令**应以非零退出码失败**：

```sh
TAVERN_E2E_WRONG_GOLD=1 TAVERN_E2E_TIMEOUT_MS=10000 pnpm test:e2e
```

其他可选变量：`TAVERN_E2E_OUTPUT` 指定产物父目录；`TAVERN_E2E_TIMEOUT_MS` 指定界面单步超时（默认 30 秒）；`TAVERN_E2E_KEEP=1` 保留本次临时数据用于诊断。启动单独限时 60 秒。

断言失败时先检查界面、日志与存档，不能因为实现输出不同就改成新的预期值。这里的验收约定始终是：领取 10 枚金币、显示正确状态、刷新后不丢失。
