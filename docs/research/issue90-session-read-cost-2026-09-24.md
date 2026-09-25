# Issue #90：缓存命中、状态读取与写入复制

## 范围与结论

来源：https://github.com/flizzywine/dsh-tavern/issues/90 。基线为 `855a11de`，包含 #86 的优化。

#86 已减少同一请求的重复读取、普通 timeline.inspect 的全量复制，并合并 32 段之外的变更摘要。不过 getSession 在检查投影缓存前仍通过通用 read() 克隆完整 Chat，sessionActivity 同样读取完整历史。Journal 已隔离 updater 草稿和返回值，Persistence 又各复制一次。这是本轮处理的三个可复现机制。

没有报告者的原始存档或完整宿主 profile。本轮不证明 132 秒预处理等待全部来自复制，也不宣称 VPS 的整轮延迟或峰值内存已经解决。

## 改动

- Journal 新增 `readSessionState()`，通过原有磁盘版本校验读取缓存，只复制活动状态、回退判断、MVU 回执和剧本进度所需输入。历史正文、楼层变量、MVU 执行载荷、回退保存的完整快照不进入普通状态投影。返回值完全分离，不暴露内部 `state.chat`。
- Registry 的 `resolveState()` 复用原有别名、失效关联清理及未关联存档恢复逻辑。
- getSession/sessionView 先读状态；同 revision 且身份匹配时复用视图，失配仍读完整 Chat。请求用 WeakMap 固定与状态匹配的缓存条目，避免等待 transport dirty indices 期间被另一请求替换后，从不完整状态重建历史。不会新增长期完整 Chat 缓存。
- sessionActivity 使用状态投影。旧会话功能配置迁移仍取得完整草稿；旧 foreground-completed 时间线迁移保留完整数据读取。
- Journal 显式声明 `detachedUpdate` 契约：updater 输入、存储内部状态、返回值分别隔离。Persistence 仅对声明此契约的 adapter 省去两层重复复制；一般 adapter 保留原防御副本。Journal 自身 JSON 规范化与所有权边界复制、普通可写 read()、三方合并不变。
- RPC 阶段诊断新增 `readSessionState`、`readFullChat`、`projectViewCached`；原完整/增量投影阶段仍在。

## 复现与测量

```sh
node --test tests/issue90-read-cost.test.mjs
mkdir -p output/issue90
node --expose-gc tests/fixtures/issue90-read-cost.mjs output/issue90/read-cost.json --assert-optimized
```

修复前实际运行第一条回归，缓存命中加状态查询触发两次完整读取，断言 `2 !== 0`；修复后通过。基准夹具调用生产 RPC/view 函数、真实 Registry、Journal、Persistence、Background Activity 和回退判断；不启动完整 DSH 宿主，不调用模型。缓存视图及 transport sync 使用替身，因此不测全量展示构建和网络传输。

同一份 453 条消息、约 22.7 MB JSON、初始 revision 5921 的合成存档，macOS arm64、Node v22.22.0；前后在独立进程按相同顺序运行，测量期间不并行跑测试。每段前强制 GC，段内记录自然 GC；GC 时长与墙钟时间重叠，不能相加。

| 路径 | 修改前耗时 | 修改后耗时 | 完整历史 structuredClone 次数（前→后） | GC 时长（前→后） |
| --- | ---: | ---: | ---: | ---: |
| getSession 缓存命中 ×20 | 951.5 ms | 11.5 ms | 20→0 | 237.3→0 ms |
| sessionActivity ×20 | 825.2 ms | 8.1 ms | 20→0 | 160.9→0 ms |
| 仅动态视图字段投影 ×20 | 1.1 ms | 1.5 ms | 0→0 | 0→0 ms |
| 通用可写 read ×20 | 1285.6 ms | 752.7 ms | 20→20 | 282.3→141.1 ms |
| 无变化 update | 168.2 ms | 83.9 ms | 2→0 | 22.2→9.3 ms |
| 元数据 update | 268.7 ms | 174.8 ms | 2→0 | 31.0→17.4 ms |

通用 read 没改；其耗时差异说明 GC/进程堆状态造成的波动，不能归为优化收益。动态字段投影本身也没有优化。无变化 update 仍有两次完整 JSON parse，元数据 update 仍有三次，Journal 边界复制没有被删除。

getSession 批次结束 RSS 903.8→216.3 MB，状态查询批次结束 RSS 1264.0→217.3 MB。这是特定合成进程的端点采样，不是峰值、累计分配量或用户 VPS 常驻内存承诺。基准同时保存 CPU、heap 差值、RSS、GC 次数与时长；原始本地结果在 `output/issue90/read-cost-{before,after}.json`。

## 验证

新增回归覆盖缓存命中、完整读取回退、并发缓存替换、字段投影等价、实时原生 Surface 回退控件、旧迁移、外部写入/删除/重建、别名/关联恢复，以及修改保留草稿/返回值、取消和抛错时的写入隔离。对非 Journal adapter 检查防御复制仍生效。

相关测试共 190 项；另执行服务端语法与 diff 检查。没有修改客户端源代码，无需重建客户端。没有进行真实 VPS、浏览器或模型整轮验证。

## 剩余开销

状态投影仍扫描轻量楼层标识并复制回执与时间线；冷读取仍会物化存档。revision 变化后的完整读取、通用 update 的 JSON 克隆与 diff、完整/增量展示和同步指纹仍可能昂贵。应根据新增阶段诊断继续定位；不能仅从 RSS 或进程总 CPU 推断具体阶段。
