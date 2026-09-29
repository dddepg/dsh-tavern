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

## 首次验收遗留问题（后续修复见下）

快速连续发送确实存在前台模板并发冲突：首次恢复后的第二轮刚落盘便发送第三轮，第三轮未提交，页面报 `Tavern Chat 已被另一项操作修改，拒绝覆盖冲突字段：promptTemplateInput`。`run-VaEDSO` 和 `run-Qamw6R` 均观察到此错误。此时上一轮 MVU 已完成，不是本次后台历史回退或 Round 版本错误。当时保留以下可执行复现入口：

```sh
node tests/e2e/gameplay.mjs --native-format --background-failure --rapid-followup
```

全量 `node bin/test-tavern.mjs` 在补充 Round 修复前执行：3296 项，3278 通过、4 失败、14 跳过，266.530 秒。四个失败文件单独串行复跑共 14 项，13 通过、1 失败：

- `opening-document-replacement.test.mjs` 的远程开局重写测试仍在 `frame.waitForFunction` 超时 3000 ms，未处理。
- `scene-image-conversation-switch.test.mjs`、`scene-image-unified-native.test.mjs`、`server-template-sync.test.mjs` 的失败项在单独复跑中通过。

以上是补充修复前的历史结果，不能据此声称全部通过。


## 连续发送与开局重写补充修复

并发冲突来自前台 finalize：读取临时 `promptTemplateInput` 后，展示渲染向其中追加 `template_rendered`，正文提交随后删除旧快照中的临时输入。严格三方合并把“修改与删除同一字段”正确识别为冲突。修复将正文提交放进 `updateChat` 的原子更新，在锁内读取并消费最新输入，将展示数据带入用户消息；保留剧情 branch/revision 校验及重复提交去重，不放宽通用存档冲突检测。

新增真实持久层回归先复现同一 `promptTemplateInput` 冲突，再验证展示元数据保留、临时输入清除、并发 finalize 仅提交一次，以及剧情版本变化拒绝落盘。相关首批 82 项通过，扩展后的持久层、前台策略、历史、兼容输入及开局测试合计 140 项通过。

开局超时根因是 `document.open()` 后远程文档仍在解析 head，兼容输入层调用 `document.body.append` 时 body 为 null，打断后续 MVU 启动。兼容层现在等待 body，并由运行时加载器 await 后再启动后续模块。首次全量复查为 3299 项、3284 通过、1 失败、14 跳过：原有超时消失，但新增控件数量断言揭示另一顺序——兼容层先安装，随后被 document.open 清除。补充在模块实际挂载前幂等恢复兼容层，并明确测试“重写发生于兼容层安装前/后”两种顺序。开局回归现为 4 项，通过页面无未捕获异常、输入控件和 MVU 均只启动一次、实际保存角色等断言。客户端构建一致性检查通过。

快速连续发送完整浏览器命令通过：`node tests/e2e/gameplay.mjs --native-format --background-failure --rapid-followup`，33.844 秒，证据目录 `output/e2e-gameplay/run-Y71fUP`。覆盖首个后台请求失败、编辑、同会话重试、无需刷新连续两轮（金币 10 → 20 → 50）及服务重启后存档核对。

补充挂载修复后的第二次全量复查：3300 项、3285 通过、1 失败、14 跳过，两种开局顺序均通过；唯一失败是 `inline-message-renderer.test.mjs` 对旧加载器参数列表的源码匹配。同步新增回调参数后，该文件 72 项全部通过。

最终版本完整复跑 `node bin/test-tavern.mjs`：3300 项，3286 通过，0 失败，14 跳过，196.890 秒。跳过项未算作通过。此次仅验证本地 macOS 测试环境与固定模型故障注入，不代表外部模型服务或其他平台实测。
