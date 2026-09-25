# Issue #86：读取放大与增量窗口复现

## 范围

- 来源：https://github.com/flizzywine/dsh-tavern/issues/86
- 基线：`4d00067a325e3028a5780a3f7f32acf957b80b07`；macOS arm64，Node v22.22.0。
- 合成数据：453 条消息，22,710,202 字节 JSON，起始 storage revision 5921；各楼层包含历史变量对象。
- 使用真实 journal、persistence、模板 Host Adapter；资源依赖为空的合成卡与世界书。独立临时目录，结束删除，不读写用户存档，不调用模型。
- **只复现底层机制，未复现 DSH `turn/start → step/start` 的 148.5 秒等待，也没有执行真实 `getSession` RPC 或浏览器。** 未获得报告者原始存档及分阶段 CPU profile，不能把整轮 CPU 归因等同于预注入窗口归因。

## 运行

```sh
mkdir -p output/issue86
node --expose-gc tests/fixtures/issue86-read-amplification.mjs output/issue86/run1.json --assert-budget
node --expose-gc tests/fixtures/issue86-read-amplification.mjs output/issue86/run2.json --assert-budget
```

两次均完成测量和正确性断言、输出报告，最后按诊断预算以 exit 1 结束：`20 !== 0`。预算只标记重复整份读取机制仍存在，不是现有可写副本 API 的正确性要求，不应通过直接删除隔离副本让它通过。后续优化若迁移调用方，回归应落在实际只读调用方，而不是强迫通用 `read()` 返回共享对象。

## 实测

| 路径 | 第一次 | 第二次 | 每次测量中的整份 chat 克隆次数 |
| --- | ---: | ---: | ---: |
| 缓存命中读取一次 | 36.6 ms | 34.5 ms | 1 |
| 同 revision 连续读取 20 次 | 914.0 ms | 829.0 ms | 20 |
| 只读取元数据 20 次 | 4.1 ms | 4.5 ms | 0 |
| 模板首次同步 | 186.2 ms | 178.9 ms | 1 |
| 模板无变化同步 | 2.3 ms | 1.7 ms | 0 |
| 模板落后 32 revisions | 2.5 ms | 3.6 ms | 0 |
| 模板落后 33 revisions | 180.6 ms | 199.1 ms | 1 |

连续 20 次读中 `structuredClone` 累计自身耗时为 881.1 / 778.8 ms。批次前手动 GC，批次内不强制 GC；堆差值受自然 GC 影响，不能当作累计分配量。批次结束 RSS 为 928 / 872 MB，也不是连续采样峰值，不能与报告者 VPS 的峰值作等条件比较。

32/33 revision 场景均仅修改最后一条消息正文。两者返回 delta 都只有一条变化消息；33 场景仍先执行整份读取和投影，即响应增量不等于计算增量。起始 revision 已为 5921，32 场景仍成功增量，证明绝对 revision 高不导致窗口自动失效。

元数据切片不包含完整历史，不可无条件替代完整读取。这里作为已有局部读能力的对照，并非同功能优化收益承诺。

## 下一步证据

获取脱敏原始存档与对应的日志/profile，或在隔离完整宿主内构建相同事件/脚本活动；分开采集注入前、生成中、同步期。记录实际调用次数、触发者与耗时，再确定只读路径迁移范围。当前结果不足以解释 148 秒，不能按 20 次读取的人造循环外推真实轮次的调用量或节省比例。

本轮未修改运行代码。

## 优化点核对（参考 issue 建议）

### 第一批：视图与状态读取，收益明确、改动可收窄

1. `index.js:getSession` 已调用 `chatForSession()`，`sessionView()` 又调用一次。正常命中会话映射时就是两次完整读取；视图缓存检查在第二次读取以及 `backgroundTasks.activity()` 之后。优先让一次请求共用同一版本快照，再为缓存命中和状态查询提供元数据读取。传入快照还能让返回 revision 与投影视图基于同一状态。不能跨请求复用可写草稿。
2. `background-task-coordinator.js:activity()` → `story-timeline.js:inspect()` → `ensure()` 会 JSON 深拷整个 chat，最终却只返回时间线摘要。追加测量：完整 chat 的 inspect 为 51.3 ms、堆差值 47.7 MB；元数据对照为 0.17 ms。应拆开只读时间线检查与迁移/写入准备。该对照只验证合成数据，旧 `foreground-completed` 迁移可能读取正文，须保留显式迁移分支，不能简单删掉 messages。
3. `getSession` 为获取 dirty indices 调用 `readChangedSlice()`，后者先克隆变化楼层，调用方却只取 `indices`。新增只返回 revision、indices、tail/结构变更的查询，减少这份被丢弃的数据副本；保留模板适配器确实需要变化数据的 slice API。

### 第二批：增量范围与指纹复用

4. 32 revision 窗口外全量回退已实测。可用有界的每楼层最后变更 revision 或分段合并的变更摘要覆盖更久范围；必须保留覆盖起点、结构性变更及最早受影响后缀。缓存丢失、外部写入和历史不连续仍全量回退。提高 32 的值只能延后断崖，不能根治。dirty 集合须对应实际被复用的投影版本；传输游标版本不能随意充当投影缓存版本。
5. `session-view-sync.js:parts()` 只对 `tavernHelper.messages` 使用 dirty indices 复用 hash；`replyProjections` 即使未变也逐条 `JSON.stringify + sha256`，其余大字段也同样计算。可对已证明不可变、版本匹配的投影复用指纹，或传入完整的字段/楼层变更信息。现有 `immutable-json-projection.js` 有只缓存递归冻结对象指纹的设施，可评估复用；不能缓存任意可变对象的 hash。此项目前是代码证据，尚未单独计时。

### 第三批：局部写入与所有权边界

6. `chat-persistence.js:update()` 收到 journal 已分离的 `stored` 后又 clone，返回的 `saved` 再 clone；journal 本身也在 updater 入参、produced、返回值处 JSON clone。追加测量：无变化 update 153.9 ms，仅修改一个元数据字段的 update 263.3 ms，已有 revision 校验 patch 为 15.6 ms。优先把明确的局部变更迁移至 patch；再明确 Store adapter 的隔离约定，删除真正冗余的副本。通用 write 的陈旧 revision 三方合并、调用者草稿更新、返回值隔离须保留，不能整体改成共享对象。
7. `updateVariablesNow()` 已支持 patch 和 compact receipt，前端也会带 contextBaseline；因此 issue 的“改成增量响应”已有部分实现。但进入函数的 `mutationChat()` 仍先读完整 chat；非事务且目标明确时可按 chat/script 元数据或单个 message 读取。baseline 不匹配和并发变更仍须原有冲突处理。不能因已有增量响应就认为服务端计算已增量。

### 暂后置

- 视图缓存只有 8 条限制，增加字节预算可控制多会话常驻内存；应在缓存建立/更新时估重，不在每次命中时序列化整个 view。单会话克隆分配压力仍需前述优化解决。
- 请求去重或合并可减少重复工作，但不宜直接把 `syncSession` 和 `getSession` 合并：前者负责候选任务同步，不只是读视图。先优化单次请求成本，再按实际重复触发者去重。
- `version()` 会扫描、stat 历史文件，属于次级候选。它承担外部修改与损坏恢复的失效检查，不能单纯删掉检查。

### 不直接采用的建议

- 通用 `read()` 按 revision 返回同一可写副本：会造成调用者互相污染。若共享，必须新增不可变只读契约，并处理 normalize/旧状态迁移。
- “读取主路径必定二次 clone”：当前 `read()` 不成立；第二份副本主要仍出现在写入/更新/历史 revision 路径。
- 把所有 JSON clone 换为 structuredClone：只能降低部分常数开销，还可能改变 JSON 规范化语义。优先缩小需要复制的数据范围。

建议顺序：单请求快照复用 + 只读时间线检查 → 索引专用变更查询 → 扩展有界增量摘要 → 局部写入 → 指纹与缓存预算。`output/issue86/analysis.json` 保存追加测量；脚本测量期间仅包装 structuredClone，JSON 克隆耗时计入总耗时，不包含在 cloneMs 中。

## 已实施与验证

本节更新前述分析阶段的“未修改运行代码”状态。已实施前四项：单请求快照复用、时间线只读检查、变更索引专用查询、有界变更摘要。通用可写读取、写入隔离、三方合并、哈希及缓存预算未调整。

- `getSession` 向 `sessionView` 传递已读取的快照；生产函数回归验证缓存命中仅 resolve 一次。
- `inspect` 普通分支只复制 timeline/candidateAgent；旧 foreground-completed 仍走原迁移路径，回归验证源对象不被修改。
- `readChangedIndices` 返回分离的索引及明确的目标 revision，不复制消息；服务端投影缓存与浏览器游标分别按各自版本查询，目标 revision 与快照不符时不使用 dirty 信息。
- 变更记录保留最多 32 段，合并最旧段为保守摘要；摘要离散索引超过 4096 时丢弃旧覆盖范围。结构变化保留最早影响后缀，重启、外部写入、缓存失效仍完整回退。内部游标可能多重建少量未变化楼层，不会省略受影响楼层。

### 优化后测量

命令：`node --expose-gc tests/fixtures/issue86-read-amplification.mjs output/issue86/optimized-isolated.json --assert-optimized`，exit 0。测量时没有同时运行全量测试。

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 模板落后 33 revisions | 178–199 ms | 2.27 ms |
| 该同步的整份 chat structuredClone | 1 | 0 |
| 完整 chat 输入的 timeline.inspect | 51.26 ms | 0.62 ms |

以上是合成存档的局部指标，不能转换成整轮 148 秒等待的节省比例。普通 `read()` 仍交出隔离副本，通用 update 的多层复制仍是后续优化点。

### 检查

- 最终相关测试：119 项通过，覆盖 journal、缓存失效、局部读、并发持久化、时间线、模板同步、视图同步和新增性能路径回归。
- 全量测试执行 3069 项：3059 通过、5 跳过、5 失败。其中 1 项为旧 32 帧窗口断言，已更新并包含在最终通过的相关测试中；另外 4 项在独立、未修改的 HEAD 副本中复现：background-agent-runner 的 2 项人物卡更新背景测试、card-agent-autonomy 的工具说明断言、settlement-restart-recovery 的错误文案断言。没有宣称全量测试全绿。
- `git diff --check` 与服务端入口语法检查通过。未修改客户端源文件，无需重建客户端。
- 本地结果保留于 `output/issue86/`，未提交或推送。
