# MVU 诊断日志：延迟批量追加

## 改动与原因

基线 `61cbdc1`：每次 `record` 都读取、解析、拼接并重写整份诊断 JSON；调用方等待文件锁、文件和目录同步。约 1.5 MB 的历史文件增加一条约 8 KB 的记录，实测需要约 26.6 ms。

用户允许诊断日志延迟保存，因为只用于事后排查。现在：

- `record` 先脱敏、限制单条长度，再加入内存。通常不等待磁盘。
- 约 500 ms 批量追加；达到 32 条或约 256 KiB 时提前提交。每个会话同一时间最多一个写入批次。
- 查看与导出先刷盘，插件正常卸载注册 `dispose()` 刷盘。刷盘失败时导出仍包含内存日志，并用 `persistence: "pending"` 和 `pendingRecords` 标明状态。显式 `flush()` 仍会拒绝失败，不能误认成保存成功。
- 失败批次保留并重试；连续失败只告警一次，成功后恢复告警能力。内存每会话最多 200 条/约 2 MiB 待写日志，另有一个同上限的在途批次；最多八个会话缓冲，超出时等待最早缓冲刷盘。超量保留最新记录，`dropped` 计数保留。

这不是取消日志，也不是缓存剧情数据。突然崩溃、强制结束、持续磁盘故障仍可能丢失尚未落盘的尾部日志；500 ms 是正常调度目标，不是异常环境下的丢失窗口保证。

## 存储与兼容

使用独立 `diagnostics/mvu-<session hash>.jsonl`，首行为有界快照，其后每行为一批记录。普通批次只追加新行并同步文件，不重新解析历史。读取/导出时才汇总；文件达到 4 MiB 阈值前，将历史压缩为最近最多 200 条、records JSON 不超过 2 MiB 的快照。正常 journal 大小不超过 4 MiB，旧 JSON 及故障时的 pending 恢复文件另计。

旧 `.json` 日志可直接读取，首次追加时导入新文件；保留旧文件，不反复重读。导出仍为既有 `mvu/diagnostics.json` 对象，不要求用户读取 JSONL。

底层复用 Durable File Promotion 的串行队列、写锁与快照恢复：

- 文件创建、压缩与不完整尾部修复都走已有持久化替换协议。
- 中断留下的不完整末行不影响前面的记录；再次追加前修复尾部。
- 完整但损坏的行报错，不静默吞掉历史。
- Windows 替换暂时失败时，读取最新 pending 快照，下一次写入从该快照恢复。

Chat、变量持久化及 API 调用诊断的既有策略不变。

## 实测

macOS，Node 22.22.0，正式 ProfileDataStore / DurableFilePromotion / MvuDiagnosticStore，临时目录，无用户存档、浏览器或模型。预置 180 条记录（JSON 约 1.45 MB），每次新增约 8 KB。原始数据见同名 JSON。

| 指标 | 旧方案 | 新方案 |
| --- | ---: | ---: |
| 单条调用中位数（10 次） | 26.645 ms | 0.077 ms |
| 新方案复测 | — | 0.077 ms |
| 连续 10 条的持久化次数 | 10 | 1 |
| 新方案批次刷盘耗时 | — | 8.78 ms；复测 9.98 ms |
| 新方案 10 条追加数据量 | — | 80,646 B |

旧方案每次重写约 1.5 MB，十次约 15 MB；新方案十条只追加约 80 KB（不计锁文件和文件系统元数据）。即使开启立即写入，新追加格式单条中位数约 9.78 ms；批量模式进一步合并同步开销并移出主调用路径。

首次导入旧日志仍有一次完整转换，约 28 ms；达到轮换阈值时也需要压缩，不应将 0.077 ms 解释为每次磁盘保存耗时。以上是日志路径测量，不是整轮 MVU 或对话加速比例。

```sh
node tests/performance/mvu-diagnostic-benchmark.mjs output/mvu-diagnostics/buffered.json
node tests/performance/mvu-diagnostic-benchmark.mjs output/mvu-diagnostics/immediate.json --immediate
node --test tests/mvu-diagnostic-journal.test.mjs tests/mvu-diagnostics.test.mjs tests/profile-data-store.test.mjs tests/durable-file-promotion.test.mjs
node bin/test-tavern.mjs
```

针对性测试覆盖：只追加、不覆盖旧字节；旧文件导入；数量/字节限制和 dropped；重启读取；并发；定时批量刷盘；正常关闭；写入失败保留/重试；内存容量与多会话背压；导出未落盘日志的标记与脱敏；不完整尾部恢复；损坏行拒绝；Windows pending 恢复及活跃写锁拒绝覆盖。

最终验证：52 项定向测试通过；全量 2555 项，2550 通过、5 跳过、0 失败，约 72.3 秒。客户端构建一致性与 diff 检查通过，本轮没有客户端源码修改。
