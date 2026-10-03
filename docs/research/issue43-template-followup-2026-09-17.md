# Issue #43：剩余模板开销的第二轮定位

基线 `3452266`，已包含减少 queued 落盘和单次世界书读取复用。方法沿用 [第一轮报告](issue43-template-timing-2026-09-17.md)：macOS arm64、Chromium 145、13 轮合成对话、266 条 / 0.97 MB 世界书、0.77 MB 人物卡、20 个控制器、每轮 40 个 render。没有使用用户原卡或模型服务。

## 新发现：世界书深拷贝有可测量的优化空间

Node CPU 采样覆盖脚本启动和四轮基准运行，定位到三个独立的 JSON 深拷贝调用路径：

| 路径 | 四轮采样累计 CPU 时间 |
| --- | ---: |
| entryProjection → rawEntry 的 clone | 0.546 s |
| inspectWorldBookDocument → 整本 raw 的 clone | 0.251 s |
| exportSillyTavernWorldBook → 导出文档 clone | 0.235 s |
| full-prompt-template-sync → digest | 0.799 s |

digest 内部还调用原生 Hash.update，该函数另外约 0.184 秒采样时间。这些是 CPU 采样近似值，不能直接从每轮壁钟时间中减去，也不能把它们当成仅 EJS 执行耗时。原始 CPU profile 保存在 `output/playwright/issue43-cpu/`。

当前 clone 使用 `JSON.parse(JSON.stringify(value))`。因此每轮仍把完整世界书内容反复编码和解析；条目投影的 rawEntry、整本 raw、导出文档各自复制一次。

## 单变量隔离实验

通过 Node 模块加载钩子，仅在测试进程内将 worldbook-resource 的 clone 换成 structuredClone。正式源文件未修改，函数调用、读取、派发、落盘与浏览器执行路径保持相同。随后独立重跑当前基线，避免与测试套件并行。

每组一次预热、三次测量：

| 指标 | 当前基线 | structuredClone 实验 |
| --- | ---: | ---: |
| 整轮暖态中位数 | **2.301 s** | **2.101 s** |
| 世界书绑定累计耗时（中位样本） | 0.253 s | 0.094 s |
| 服务端快照累计耗时 | 0.653 s | 0.464 s |
| 作业日志持久化累计耗时 | 1.368 s | 1.357 s |
| 浏览器模板投影累计耗时 | 0.042 s | 0.044 s |

三个基线样本为 2.366 / 2.258 / 2.301 秒；三个实验样本为 2.134 / 2.082 / 2.101 秒。整轮约减少 **8.7%**，收益主要出现在资源投影与快照构建，持久化和浏览器执行基本不变。

两组都校验了最终 20 条输出及其顺序、变量值、停用条目读取和临时变量不落入 Chat。在实验钩子下另外运行 worldbook-resource、worldbook-library、worldbook-snapshot-read、multi-worldbook-runtime，共 **27 项测试通过**。

这不是直接替换 clone 的充分兼容性证明：JSON 克隆会丢弃对象中的 undefined 字段、把非有限数变为 null；structuredClone 会保留它们。落地时需要把快速路径限定于已经解析的 JSON 数据，或明确并测试内部对象的规范化契约。实验没有使用共享可变对象代替深拷贝。

## 后续优先级

1. **减少 JSON 往返深拷贝。** 这是本轮新测出的、范围较小的优化候选。也可以提供只读用途的轻量世界书投影，避免模板快照为了取得名字和导出数据而构建整份 rawEntry/raw；但不能全局删除这些字段，召回和编辑仍使用它们。
2. **资源版本与环境指纹一起复用。** 当前无变化快照每轮仍序列化并哈希人物卡及世界书；只缓存读取而不缓存投影/指纹会留下这部分 CPU 开销。必须分别验证卡、绑定、世界书、设置及全局变量的版本，不能用 Chat revision 或短 TTL 代替。
3. **批量派发或专用持久日志仍是大收益方向。** 当前 80 次日志写入占约 1.36 秒，是最大的壁钟成本。剩余两次写入分别保护执行意图和完成回执，不宜继续直接删掉。批量作业内顺序运行控制器，或使用有完整恢复协议的追加日志，才能进一步减少固定持久化开销；这属于需要单独设计的改造。

本轮只增加测量与实验入口，生产行为没有变化。

## 重跑

```sh
# 当前基线 CPU profile
mkdir -p output/playwright/issue43-cpu
node --cpu-prof --cpu-prof-dir=output/playwright/issue43-cpu tests/performance/worldbook-template-benchmark.mjs output/playwright/issue43-cpu large

# 隔离 clone 实验；不会改写正式模块
node --import ./tests/fixtures/worldbook-clone-experiment.mjs tests/performance/worldbook-template-benchmark.mjs output/playwright/issue43-clone-experiment large

# 实验代码下的已有回归测试
node --import ./tests/fixtures/worldbook-clone-experiment.mjs --test tests/worldbook-resource.test.mjs tests/worldbook-library.test.mjs tests/worldbook-snapshot-read.test.mjs tests/multi-worldbook-runtime.test.mjs
```

使用 Node 22.22.0 的 registerHooks。精简原始指标保存在旁边的 `issue43-template-followup-2026-09-17.json`，完整本地结果在 `output/playwright/`；上述收益不代表 Windows 原卡或复杂脚本的实际收益。
