# 变量更新与频繁文件读写调查

基线 `3ea6253`，范围扩展到普通脚本变量、MVU 结算、诊断日志、角色卡变量和会话索引。全部测试使用临时目录，没有修改用户存档。

## 已落地：小范围变量更新直接提交字段变化

普通 `updateVariables` 原先对 message/chat/script 三种变量一律调用 `writeChat`。底层 Chat Journal 已经只把差异追加到文件，因此问题并非每次把整份历史写入磁盘；真正浪费的是上层为得到很小的 journal frame，多次复制、JSON 往返处理和比较整份 Chat。

现在复用现有 `patchChat` 精确版本接口：仅保存本次变量字段的变化。Message 变量覆盖该楼层变量数组的实际 diff；Chat 本地操作和 Script 变量保留原语义。其他变量快照不深拷贝、不参与全量差异比较。

保存前仍检查脚本权限、生命周期和 MVU 事件身份。patch 只能在读取的 storage revision 仍匹配时生效；版本竞争返回 undefined，继续走原有三方合并/冲突拒绝路径。不存在 patch 接口或 storage revision 的 adapter 也使用旧路径。JSON 规范化保留，包括稀疏 swipe 转为 null。

MVU 正式结算仍在隔离 draft 中累积变量变化，事务中不调用这个快速持久化入口。正式变量保存、会话摘要同步和保存后的通知没有被取消或延后。

## 实测

macOS / Node 22.22.0，600 条合成消息，14,455,068 字节 Chat，每层带变量快照。使用正式 ScriptHostAdapter、ChatPersistence、ChatJournalStore、ProfileDataStore、ConversationRegistry；每次调用包含读取、变量保存、索引同步、回执投影及 JSON 编码。没有浏览器、网络传输、模型或正式宿主的通知/自动压缩调度。

每类一次预热、五次采样，中位数：

| 更新类型 | 修改前 | 修改后 | 减少 |
| --- | ---: | ---: | ---: |
| 最新消息变量 | 119.2 ms | 52.1 ms | 56.3% |
| Chat 变量 | 110.3 ms | 50.7 ms | 54.0% |
| Script 变量 | 110.0 ms | 48.1 ms | 56.3% |

典型样本中，完整保存路径（含索引同步）约 80–84 ms，增量路径约 20–24 ms。索引写入仍约 16–20 ms。结果内容与旧路径一致，读取新进程的存储实例后结果也一致。

重要边界：磁盘 journal 本来就是增量，本次主要降低全量复制/序列化开销，不宣称减少 journal 提交次数。每次变量操作依然持久化，未用延迟保存换速度。

## 初次调查确认的放大来源（进展见下文）

| 路径 | 当前代码行为 | 后续方向 |
| --- | --- | --- |
| 变量更新回执 | `projectTavernHelperContext` 返回全部消息、swipes_data 与当前 variables；本基准一条回执约 28.9 MB | 版本化的变量变更回执，客户端按目标应用；版本不连续才全量同步。需协调 RPC/iframe 协议，不直接删除 context |
| MVU 诊断 | `createMvuDiagnosticStore.record` 每条 updateJson 重写整个最多 2 MiB 的 JSON；结算多个阶段会等待记录 | 诊断专用追加日志、分段轮换与按需聚合；保留脱敏、大小限制和导出行为 |
| 会话摘要 | 每次普通变量保存都会触碰 updatedAt，registry.sync 因此写 index.json | 把列表投影与权威提交分开，或在事务/批次末尾合并刷新；需要明确列表即时性与恢复规则 |
| 人物卡变量 | `replaceCardVariables` 经 updateCard 重写整个卡工作区，随后无条件 syncCardName，重写索引并读取关联 Chat | 先限制无关名字同步；进一步考虑变量独立存储或字段增量日志，需要兼容导入导出与资源修改 |
| MVU 正式结算 | 多次 updateVariables 使用内存 draft，最后生成 effect，由剧情流程提交 | 已有批处理，不应误认为每个 set 都落盘；仍可进一步测量整份上下文投影与 effect 计算 |

诊断实测：向约 1.45–1.51 MB 的正式诊断 JSON 追加一条约 8 KB 记录，排除一次预热后八次耗时为 27.81 / 25.88 / 26.56 / 24.87 / 25.69 / 24.87 / 26.41 / 25.45 ms。此数字是孤立诊断记录成本，不是实际一轮 MVU 总耗时，也不能把所有阶段简单相加当端到端结果。

第一阶段没有改变诊断持久化、索引一致性、人物卡文件格式或回执协议。它们需要各自的回归和基准，尤其是变量增量回执的并发/生命周期检查。

## 验证与重跑

```sh
node --test tests/variable-journal-patch.test.mjs tests/tavern-script-host-adapter.test.mjs tests/chat-persistence.test.mjs tests/chat-journal-store.test.mjs
node tests/performance/variable-write-benchmark.mjs output/playwright/variable-writes/run
node bin/test-tavern.mjs
```

77 项定向测试通过。新增覆盖 message/chat/script 变量精确保存、重启重读、并发字段合并、同字段冲突拒绝、稀疏 swipe 的 JSON 规范化和过期生命周期拒绝。原有 MVU 隔离事务测试同时通过。

测量原始摘要见同名 JSON；after 标注工作区未提交改动。基准不会调用外部服务，退出后清理临时存档。

全量回归：2526 项，2521 通过、5 跳过、0 失败，约 71.2 秒。本轮仅服务端领域模块修改，无客户端构建变化。

## 后续落地：人物卡名称同步与变量增量回执

人物卡更新现在比较保存前后的投影名称。只更新变量或描述时，不再调用 `syncCardName` 重写索引及读取关联 Chat；实际改名仍保留同步。平面、v2、v3 卡格式的测试均覆盖变量修改、patch 改名和 raw 改名。

普通脚本变量写入现在协商 `contextBaseline`，包含 chatId、storage revision、lifecycle revision。基线完全匹配且精确版本 patch 成功，才返回 `contextDelta`：Chat/Script 返回对应变量映射，Message 只投影被更新的楼层。父窗口和脚本 iframe 均按版本合并，未变化的历史不再复制；同步 ST chat facade 时保留原有对象引用和未保存插件编辑。版本缺口通过只读 `getTavernHelperContext` 恢复，不重试已经提交的写入；迟到回执不能覆盖新会话、新生命周期或更新版本。

未协商的旧客户端、消息展示 iframe、MVU 隔离事务、过期基线、patch 竞争仍走完整回执。不改聊天存档格式，不延迟变量落盘。诊断日志存储和会话摘要索引仍保持原策略，后续改造需要单独验证崩溃恢复与列表即时性。

### 服务端对比（包含摘要索引）

与上一节相同的正式 Adapter/Persistence/Journal/Registry，600 条消息、14.45 MB Chat。相同工作区分别启用/关闭增量回执协商，均一次预热、五次采样、中位数：

| 变量 | 完整回执 | 增量回执 | 回执大小 |
| --- | ---: | ---: | ---: |
| Message | 53.3 ms | 29.1 ms | 28,918,615 → 36,365 B |
| Chat | 56.8 ms | 26.3 ms | 28,924,605 → 6,181 B |
| Script | 51.9 ms | 25.9 ms | 28,930,658 → 6,216 B |

### 真实 Chromium 脚本沙箱对比

使用真实客户端 bundle、共享脚本 iframe、postMessage、HTTP RPC、正式 Adapter 和临时 journal 文件；600 条同规模消息。计时从脚本调用 `replaceVariables` 到 await 返回并同步读到变量。一次预热、五次采样、中位数；完整回执/增量回执交替各跑两轮。

| 变量 | 完整回执首轮 / 复测 | 增量回执首轮 / 复测 |
| --- | ---: | ---: |
| Message | 287.9 / 288.5 ms | 8.1 / 9.2 ms |
| Chat | 312.7 / 266.7 ms | 6.1 / 7.1 ms |
| Script | 275.4 / 259.7 ms | 7.1 / 7.5 ms |

这是连续普通变量调用的局部基准，**不含真实宿主摘要索引、通知后的页面刷新、模型生成或 MVU 整轮结算**，不能把这些数字当作实际一轮对话耗时。初次 iframe 调用还会受初始化影响，例如增量首轮首个预热样本为 206.3 ms。按新存储实例重读，三类变量均为 25，历史第一层 hp 仍为 10；ST chat 引用及受影响楼层变量同步正确。原始两轮数据、响应大小和落盘证明见 `variable-receipt-performance-2026-09-17.json`。

```sh
node tests/performance/variable-write-benchmark.mjs output/playwright/variable-writes/full-receipt
node tests/performance/variable-write-benchmark.mjs output/playwright/variable-writes/compact-receipt --compact
node tests/browser/variable-receipt-browser-smoke.mjs
# 在打印的本地地址访问 /?full 和 /，各运行一次；/proof 返回落盘与回执大小证明。
node --test tests/helper-variable-receipts.test.mjs tests/helper-local-variables.test.mjs tests/helper-chat-data.test.mjs tests/variable-journal-patch.test.mjs tests/tavern-script-host-adapter.test.mjs
node bin/build-tavern-client.mjs --check
```

全量回归 2538 项：2533 通过、5 跳过、0 失败，73.7 秒。随后补充的父窗口恢复、未保存插件编辑、MVU 事务协商兼容测试及相关变量/插件存档测试共 59 项定向验证通过。客户端 bundle 已重建。
