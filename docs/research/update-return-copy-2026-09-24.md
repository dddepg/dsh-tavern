# 通用写入返回值的临时分配优化

Journal update 保留隔离草稿及 produced 的 JSON 规范化。规范化后的 next 仍独立复制给调用者，但改用 structuredClone，省去返回阶段额外的 JSON.stringify 大字符串和 JSON.parse。

没有把草稿或内部状态暴露给调用者，没有改变 undefined、NaN、Infinity、Date 或 toJSON 的规范化行为。新增测试覆盖新建、更新、外部篡改返回值/草稿和重启后的磁盘结果。

104 项相关测试通过；合成性能预算通过。453 消息、约 22.7 MB 档的 metadata update 仍约 173 ms，没有证明明显耗时改善。该案例 JSON 完整复制从 3 次变为 2 次，另有 1 次直接深拷贝；完整副本总数未减少。本轮堆净增约 127 MB，前轮相同负载约 147 MB；这是不同进程的端点测量，不是峰值内存或真实游玩结论。

后续更大收益仍需将高频领域操作从通用 update 迁到窄 patch，而不是继续移除必要隔离副本。
