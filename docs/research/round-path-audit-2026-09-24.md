# 长档链路性能审计

## 范围与未完成部分

基于本地 codex/tavern-state-lifecycle 分支 13736576 后的代码。macOS / Node 22.22.0；在临时目录使用真实 Journal、Persistence、Story Timeline、Background Coordinator、MVU Effect、Helper Projection 和 Session View Sync。测量时开启 CPU profiler、GC observer、事件循环延迟采样及单次定时器探针。

**这不是 DSH + 浏览器 + 真实模型的整轮复测。** 本机 3081 服务 cwd 指向旧主检出目录，不能用于代表未推送分支。尚未建立加载最新分支的隔离完整宿主及长档浏览器场景；真实模型环境选择仍待用户确认。本次未访问凭据或修改现有游玩数据。没有测世界书准备、真实 prompt 构建、MVU 浏览器领取/解析、网络、模型生成与用户视图绘制，因此没有证实原 VPS 的分钟级等待已消失。

## 可重复测量

```
node --expose-gc tests/fixtures/round-path-audit.mjs 45 /tmp/small.json
node --expose-gc tests/fixtures/round-path-audit.mjs 453 /tmp/large.json --assert-responsive
```

小档 45 消息/2.25 MB，长档 453 消息/22.70 MB。正文和变量提交由合成输入驱动，真实存储落盘；断言结算 committed 且最终变量正确。阶段之间留 20 ms 让采样器运行，不在阶段间强制 GC。释放夹具不再使用的完整快照后重新测量；大档再独立进程复测一次。响应预算采用诊断阈值 100 ms，并非正式产品 SLO；长档命令确实因事件循环阻塞超标而退出失败，输出文件仍完整保存。这是审计结果而不是测试全绿。

## 结果

| 阶段 | 小档 ms | 长档两次 ms |
| --- | ---: | ---: |
| 前台 begin（时间线及写入） | 35 | 273–283 |
| 前台 commit | 29 | 258–262 |
| 后台 begin | 40 | 306–311 |
| 后台 bind | 27 | 234–253 |
| 后台 checkpoint | 23 | 219–225 |
| MVU effect 创建，含隔离草稿复制 | 16 | 96–97 |
| 后台 commit，含 effect 应用 | 37 | 300–304 |
| 完整 Helper 投影 | 9 | 79–81 |
| 首次同步指纹计算 | 9 | 67–72 |
| 无变化同步 | 0.5 | 0.8 |
| 4 个并发完整读取 | 20 | 185–193 |
| 4 个并发轻量状态读取 | 1.6 | 2.4–2.6 |

阶段合计约 254 ms → 2,096–2,161 ms，不能称为真实一轮耗时。后四个后台生命周期写入合计约 1.06–1.09 秒。长档单次事件循环最大延迟约 257–260 ms，主要落在提交阶段。

CPU profiler 首轮归因：structuredClone 约 639 ms，Journal jsonClone 464 ms，diffValue 345 ms，GC 323 ms，Story Timeline clone 183 ms。采样还包括约 545 ms idle（含主动等待）及约 79 ms inspector 自身；这些数值不能直接相加到阶段耗时。支持复制、全树比较和 GC 是这条受控路径的主要成本，不能据此归因未测的宿主/模型阶段。

进程峰值 RSS：小档约 230 MiB，大档约 1,103–1,105 MiB。为进程 high-water mark，包含初始造档、profiler 和受控流程，不能归为某一阶段峰值，更不能映射到 VPS 的常驻内存。每阶段记录的是结束 RSS 与 heap 净增，不是分配总量。

## 优先级判断

1. **后台元数据事务**：先改 bind/checkpoint 等窄状态修改，集中封装 revision、branch、operation 和 lifecycle 校验。基准中单次仍需约 220–250 ms；保留同字段冲突、取消和重启语义。
2. **MVU effect 的复制范围**：当前 applyMvuSettlementEffect 先复制完整 Chat，再复制允许的根字段（包括 messages）；评估在领域验证后只应用变化路径，并保持外部草稿隔离。
3. **Helper 全量投影和并发完整读取**：按真实调用频率决定收益，不因四读基准慢就推断生产一定同时有四个读取。
4. 未变化同步与轻量状态读取暂不优先优化，当前成本很低。

本次只新增审计工具和结果，未修改产品代码。接下来的完整宿主复测应按：玩家发送 → request/header → 正文完成 → pending 落盘 → 浏览器 claim/start → effect 落盘 → timeline commit 关联同一轮，同时采集请求次数与事件循环阻塞，补齐当前覆盖缺口。
