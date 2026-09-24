# 脚本提示词局部写入

非 MVU 事务中的 updatePrompts 现在仅对 tavernScriptPrompts 提交带预期 revision 的 patch。成功后更新响应使用的草稿 revision/updatedAt；原有 patchChat adapter 继续执行摘要索引、协调通知、模板同步和压缩调度。

若 adapter 不支持 patch、版本不可用或提交时版本已经变化，仍使用原三方合并写入，不把旧替换操作重试到新版本。MVU 隔离事务仍只改事务草稿，统一结算时提交。

真实 Journal/Persistence 测试覆盖正常 patch、并发变量修改后合并，以及并发提示词修改时拒绝覆盖。原有事务、过期生命周期与变量写入测试保持通过。

相关 8 个测试文件 167 项通过；随后补充同字段冲突用例并重跑 adapter 全文件通过。语法和 diff 检查通过。

约 22.7 MB、453 消息的合成存档中，单次提示词完整 write 约 226 ms，局部 patch 约 16 ms；完整 Chat 克隆从 4 次变为 0 次，端点堆净增约 145 MB 与 0.1 MB。该对比是同进程局部持久化路径，包含文件操作，不包含 adapter 前置读档、上下文投影或真实模型；不是整轮耗时及峰值内存结论。复现入口为 tests/fixtures/issue90-read-cost.mjs。

前置 resolveChat 和返回 Helper context 仍处理完整历史，后续可独立评估响应契约；本轮只消除提示词保存时不必要的全档写入处理。
