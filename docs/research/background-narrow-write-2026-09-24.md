# 后台绑定与 MVU 保存点局部事务

后台绑定优先读取轻量状态，复用 Story Timeline 的 agent.bind 校验和转换，仅提交 timeline；保留完整返回快照以兼容 bindSession 的调用契约。旧时间线迁移、缺少 adapter 或 revision 冲突时回到原 update，重新检查运行中 operation 和 branch/revision。

新增 checkpointMessage 供单楼层 delivery 保存点使用：读取该楼层及元数据，验证后台任务身份，运行原 Swipe/lifecycle 校验，再按原生楼层索引提交局部变化。仅当差异全部限定在目标消息内部时走 patch；其他情况及冲突仍完整事务执行。原通用 checkpoint 保留。生产 saveDelivery 已接入，索引摘要、协调通知、模板同步及自动压缩继续走共同 patchChat adapter。

MVU effect 应用改为在隔离草稿内部沿变更路径复制；未变化消息及全局变量无需再次深拷。补丁新值仍分离；路径失败时草稿尚未被修改。Chat Store 对外读写隔离不变。

## 验证

163 项相关测试通过，包括真实 Journal/Persistence 的无冲突 patch、并发修改保留、绑定期间取消拒绝、已完成任务拒绝保存点、重启读取、MVU effect 差异等价及失败原子性。服务器模块导入、语法、diff 检查通过。

同一隔离合成链路（453 消息、22.7 MB）各两次独立进程：

| 阶段 | 修改前 ms | 修改后 ms |
| --- | ---: | ---: |
| background.begin | 306–311 | 312–315 |
| background.bind | 234–253 | 41–46 |
| background.checkpoint | 219–225 | 2–12 |
| background.commit | 300–304 | 261–277 |

原始结果保存在 round-path-audit-2026-09-24/narrow-write*.json。begin 未优化；commit 仍含完整时间线转换和通用 update。本轮没有证明整个链路低于 100 ms 响应预算，也没有执行 DSH、浏览器、真实模型整轮。指标只适用于该生产模块合成链路。
