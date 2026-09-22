# Issue #56：世界书模板批量派发

## 改动与边界

一次世界书投影把已选中的 EJS 控制器按原顺序放进一个 `renderMany` 临时作业。浏览器的 session task queue 逐条调用原有 `render` 流程，保持每条的宿主刷新、`prepareContext` / `prompt_template_prepare`、随机种子与引用、激活集合重置、保存及 flush 边界。作用域仅在条目成功时传给下一条；语法或运行错误按原逻辑局部跳过，刷新或保存失败中止批次。

批量只合并 claim/start/complete，仍逐条读取宿主状态，避免遗漏前一条保存或外部状态变化。普通文本保持与 EJS 输出交错的宏处理顺序。收敛循环、召回规则、历史、system/tools/message 装配规则不变；不做同轮或跨轮结果缓存。

批次沿用现有按会话串行、执行续租和回执重传协议。已开始执行的批次不自动重跑，也不在失败后降级逐条重跑。没有批量方法的内部运行时使用原逐条接口；已派发但返回不完整结果时直接报告错误。更新后需刷新仍加载旧模板产物的页面。

## 对照验证

基于真实 Chromium、宿主状态适配器、上游模板引擎和收敛循环的合成基准：20 个 EJS 控制器、266 条世界书、约 0.97 MB 世界书、0.77 MB 人物卡，13 轮合成历史。每组一次预热、三次测量，给每次宿主 RPC 人为加入 20 ms 延迟，隔离网络往返成本；不使用私人卡或外部模型。

| 指标 | 逐条派发 | 批量派发 |
| --- | ---: | ---: |
| 每轮作业 | 40 | 2 |
| claim / start / complete 各自次数 | 40 | 2 |
| 状态刷新 | 40 | 40 |
| 合计 RPC | 160 | 46 |
| 暖态中位耗时 | 4.341 s | 1.319 s |

这组条件下约减少 69.6%，不代表报告者手机与原卡的实际耗时。40 次模板求值全部保留，每个重复投影仍执行，没有靠跳过模板或副作用取得收益。

浏览器差分测试对比完整投影结果（正文、稳定前缀、动态部分、宏状态、诊断和激活来源），逐字一致；覆盖混合普通文本、准备事件注入、随机数、作用域写入、失败后的作用域恢复以及强制激活。另验证保存失败停止后续条目、回执丢失只重传、批次超时不重跑和缺失结果不降级。未调用真实供应商，未测量供应商缓存命中率。

## 重跑

```sh
node tests/fixtures/worldbook-template-benchmark.mjs /tmp/issue56-sequential large-sequential 20
node tests/fixtures/worldbook-template-benchmark.mjs /tmp/issue56-batch large 20
TAVERN_BROWSER_TESTS=1 node --test --test-concurrency=4 tests/*template*.test.mjs tests/*worldbook*.test.mjs tests/chat-history-import-service.test.mjs
```

构建使用上游锁文件安装依赖，通过 `host-build/build.mjs` 正常生成产物和完整性清单，没有注入或手改压缩脚本。
