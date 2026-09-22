# 逐条刷新：降低人物卡投影的重复序列化成本

基线 `d8efa450`。读取许可方案因当前写入覆盖条件不成立而停止后，改为优化每次读取的内部计算，保留逐条刷新和原有一致性语义。

## 热点与改动

`readFullPromptTemplateState` 每次读取新卡后，原来调用 `JSON.stringify(card)`，以字符串作为人物卡投影缓存的内容比较依据。卡片未变化时，仍要重复遍历并分配整张卡的序列化结果。Node CPU profile 将该函数定位为本基准的主要应用 CPU 热点；下述前后计时均未开启 profiler。

新增 `createJsonValueProjectionCache`，对新读取的 JSON 对象与缓存持有的独立源副本进行比较。未变时直接复用不可变投影；变化时沿用 JSON 规范化后重新生成。比较保留嵌套属性顺序和数组顺序，避免模板执行 `JSON.stringify(character)` 时出现行为变化。

- 每条仍读取聊天、人物卡、世界书、设置、全局变量及宿主模型，不使用 TTL 或通知代替读取。
- 不保存调用者的可变对象；源副本和投影冻结，仍按容量与体积限制淘汰。
- 浏览器本地恢复、prepare、EJS 求值、flush、作用域和回执流程不变。
- 只改宿主领域代码，不涉及前端或模板构建产物。

## 测量

沿用 `tests/fixtures/worldbook-template-benchmark.mjs`，真实 Chromium 145、上游模板引擎、宿主 Adapter 与磁盘存储。20 个控制器、2 次投影；卡片 770,053 B，世界书 972,839 B。每组预热一次，再测三轮，取整轮耗时中位数。

| 每次 RPC 附加延迟 | 旧版整轮 | 新版整轮 | 差异 |
| --- | ---: | ---: | ---: |
| 0 ms | 265.5 ms | 194.6 ms | -26.7% |
| 20 ms | 1,355.1 ms | 1,311.6 ms | -3.2% |

0 ms 组各自中位轮的服务端状态读取累计时间为 158.5 → 88.2 ms。所有组均保留 40 次状态读取、40 次模板求值、2 个派发作业；最终世界书上下文逐字一致。精简原始数据见同名 JSON。

这只证明合成大卡场景下减少本地计算。20 ms 组样本波动明显且区间重叠，不能把约 3% 当作稳定的网络场景收益。未调用模型、未捕获完整 provider-bound 请求，不宣称测得供应商缓存命中率或费用变化。

## 验证与复现

276 项相关测试通过，无跳过，包括真实浏览器测试。新增/扩展测试覆盖：缓存命中不序列化、外部修改人物卡嵌套字段与删除、独立副本、属性顺序、JSON 规范化、容量/体积淘汰和失败后恢复；上一阶段的共享变量、直接文件修改、模型切换、本地未保存状态恢复测试继续通过。

优化版：

```sh
node tests/fixtures/worldbook-template-benchmark.mjs /tmp/template-refresh-after large 0
node tests/fixtures/worldbook-template-benchmark.mjs /tmp/template-refresh-after-20 large 20
```

基线在隔离实验进程里加载 `d8efa450` 的 `tavern-script-host-adapter.js`，其他代码相同。该版本使用旧文本缓存；旧缓存实现本次未改。复现方式：

```sh
git show d8efa450:tavern-plugin/lib/domain/tavern-script-host-adapter.js > /tmp/template-adapter-baseline.js
cat > /tmp/template-cache-baseline.mjs <<'JS'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
registerHooks({load(url, context, next) {
  const result = next(url, context)
  return url.endsWith('/domain/tavern-script-host-adapter.js')
    ? {...result, source: readFileSync('/tmp/template-adapter-baseline.js', 'utf8')}
    : result
}})
JS
node --import /tmp/template-cache-baseline.mjs tests/fixtures/worldbook-template-benchmark.mjs /tmp/template-refresh-before-clean large 0
node --import /tmp/template-cache-baseline.mjs tests/fixtures/worldbook-template-benchmark.mjs /tmp/template-refresh-before-20 large 20
```
