# 后台首次失败恢复验收

日期：2026-09-29。环境：macOS，DSH 0.1.5-rc.2，独立临时 Profile、真实 Chromium、固定模型输出与故障注入。未使用真实用户存档或付费模型，未验证 Windows/Android。

## 测试发现与补充修复

`2b36a65e` 修复首次模型失败后无助手消息可供后台 Surface 回退的问题。完整浏览器测试进一步发现：失败轮编辑正文后，Timeline revision 增加，但原 body operation 的 committedRevision 未更新。重试生成的 MVU effect 因旧 Round 版本被判 stale，body.background 仍停在 running，下一次调度报 BACKGROUND_BUSY。

补充修复将编辑的同一 Round 同步到新 revision，不创建额外 checkpoint；旧任务仍受 basedOn 校验约束。正式结算入口回归先复现 BACKGROUND_BUSY，再验证正文保留、变量落盘及 busy 释放。相关 164 项测试通过：

```sh
node --test tests/settlement-restart-recovery.test.mjs tests/story-timeline.test.mjs tests/round-history.test.mjs tests/background-task-coordinator.test.mjs
```

## 浏览器结果

| 命令 | 结果 | 本地证据目录 |
| --- | --- | --- |
| `node tests/e2e/gameplay.mjs --native-format --background-failure` | 通过，50.234 秒 | `output/e2e-gameplay/run-AgAo7y` |
| `node tests/e2e/gameplay.mjs --native-format --background-lifecycle` | 通过，45.000 秒 | `output/e2e-gameplay/run-vCDy7o` |
| `node tests/e2e/gameplay.mjs --native-format` | 通过，81.600 秒 | `output/e2e-gameplay/run-XmKP3T` |

首次失败专项：模型在首个 MVU 请求抛错；正文保留、金币仍为 0；编辑正文触发 needs-rewind；恢复模型后同一后台 Session 重试成功，金币为 10；再继续两轮，中间刷新页面，金币为 20、50；最后重启服务，正文、变量和回执保持一致。

取消专项：连续停止两次，迟到工具调用不能改写变量；不刷新页面重试，使用未退休的后台 Session，金币 40 实际落盘；后台目录及重启后的结果正确。更新旧测试的 UI 操作以使用消息内“重试变量结算”，并在读状态 iframe 前显式打开酒馆状态页签。

普通游玩覆盖候选、继续、重新生成、编辑、回退/撤销、Guide、变量重算、导出、预设切换、原生存档及重启。首跑 `run-xR9aXL` 的最终全消息相等断言因重启补写模板展示缓存失败，复跑通过；未修改该断言。

## 尚未解决的独立失败

快速连续发送确实存在前台模板并发冲突：首次恢复后的第二轮刚落盘便发送第三轮，第三轮未提交，页面报 `Tavern Chat 已被另一项操作修改，拒绝覆盖冲突字段：promptTemplateInput`。`run-VaEDSO` 和 `run-Qamw6R` 均观察到此错误。此时上一轮 MVU 已完成，不是本次后台历史回退或 Round 版本错误。保留可执行复现入口，未在本次修复它：

```sh
node tests/e2e/gameplay.mjs --native-format --background-failure --rapid-followup
```

全量 `node bin/test-tavern.mjs` 在补充 Round 修复前执行：3296 项，3278 通过、4 失败、14 跳过，266.530 秒。四个失败文件单独串行复跑共 14 项，13 通过、1 失败：

- `opening-document-replacement.test.mjs` 的远程开局重写测试仍在 `frame.waitForFunction` 超时 3000 ms，未处理。
- `scene-image-conversation-switch.test.mjs`、`scene-image-unified-native.test.mjs`、`server-template-sync.test.mjs` 的失败项在单独复跑中通过。

因此只能确认本次后台恢复修复及上述通过链路，不能声称所有测试或所有连续对话场景通过。
