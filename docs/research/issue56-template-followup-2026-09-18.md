# Issue #56：批量派发后的剩余开销

基线 `bb3e5bfe`。本轮只做隔离实验，不修改生产逻辑。保留完整 LLM 请求前缀是约束；以下测量不调用模型，也不据此宣称验证了供应商缓存命中率。

沿用真实 Chromium / 上游模板引擎 / 宿主状态适配器基准：20 个控制器、2 次投影、40 次模板求值，世界书约 0.97 MB、人物卡约 0.77 MB。每次 RPC 人为增加 20 ms 延迟，每组预热一次、测量三次。精简原始指标见同名 JSON；完整报告由命令生成。

## 1. 优先候选：批次回执不再重复携带完整作用域

`host-build/session-tasks.js` 的 `renderMany` 在浏览器中通过 `scopes` 串接下一条模板，但 `results.push(result)` 又把每条的完整作用域保留并上传。`worldbook-recall.js` 已在收到批次前完成全部 EJS 求值，随后宿主需要的是文字、随机调用数、激活来源和错误；其 `scopes = clone(result.scopes)` 不再为下一条 EJS 提供输入，最终返回值也不包含 scopes。

隔离实验给局部变量添加 200,000 个 ASCII 字符，仅在浏览器上传回执时去掉 scopes，保留浏览器内部作用域传递以及全部刷新、求值和保存。

| 指标 | 当前 | 去掉重复作用域 |
| --- | ---: | ---: |
| 每轮 complete 请求体合计 | 8,007,360 B | 3,738 B |
| 每轮作业 / 求值 / 状态刷新 | 2 / 40 / 40 | 2 / 40 / 40 |
| 暖态中位总耗时 | 1.449 s | 1.442 s |
| 各自中位轮的 complete 累计时间 | 118.2 ms | 46.6 ms |

上传体积下降约 99.95%。本机总耗时差异很小，不能声称取得明确的整轮延迟改善；合成网络只加固定延迟，没有限制带宽。可确认的是重复回传量显著下降，变量越大、控制器越多越值得优化。

两组均通过相同的输出顺序、正文和临时变量不落盘断言。本实验不是完整兼容性验收。正式落地宜给批量接口定义专用结果结构，去掉宿主无用的作用域复制，保留普通单条 render 的原返回格式，并补混合文本、错误隔离、全局/局部/消息变量及副作用差分测试。

## 2. 最大潜在收益：减少逐条状态刷新往返，但需要新鲜度协议

普通变量规模下，当前中位耗时 1.407 s；其中浏览器 `connection.refresh` 累计 1.187 s，占约 84%。40 次服务端状态读取自身合计约 281.5 ms，浏览器模板求值合计约 63.7 ms。现在的主要耗时仍是状态读取及往返，不是 EJS 计算。

基准已有的 pinned 模式在计时区间跳过所有状态刷新，中位耗时 0.193 s。它只是静态数据条件下的潜在收益对照，连投影首条的刷新也跳过了，不能作为安全实现或上线目标。

要真正省去往返，必须证明浏览器副本足够新：人物卡、绑定关系、世界书、设置、全局变量、聊天和生命周期分别有版本；变更通知需有连续游标，重连、丢通知、重启或版本不明时完整刷新；模板自身写操作及保存回执也必须使副本更新或失效。仅在服务端增加版本校验 RPC 仍保留 40 次往返，只能减少服务端计算；仅检查 Chat revision 或 TTL 则不够。另一种选择是定义整个投影使用固定快照，但这会改变当前逐条读取最新状态的语义，需要先确认产品契约。

## 3. 暂缓：跳过收敛 pass 或缓存渲染结果

`foreground-worldbook.js` 在渲染成本及激活集合稳定后，还可能因候选筛选再进入一次投影。选中条目不变也不能证明模板结果与副作用不变：模板可以读取其他历史、世界书和环境，并触发准备事件或宿主操作。现有键不足以证明求值纯净。

因此不建议直接把“输入指纹相同”或“前两次输出相同”当作缓存依据。若未来显式引入可验证的纯模板模式，再讨论复用结果；目前优先减少内部传输，保持求值、召回和请求内容不变。

## 重跑

```sh
node tests/fixtures/worldbook-template-benchmark.mjs /tmp/issue56-followup-current large 20
node tests/fixtures/worldbook-template-benchmark.mjs /tmp/issue56-followup-pinned large-pinned-snapshot 20
DSH_TAVERN_RECEIPT_EXPERIMENT=baseline node --import ./tests/fixtures/worldbook-batch-receipt-experiment.mjs tests/fixtures/worldbook-template-benchmark.mjs /tmp/issue56-receipt-baseline large 20
DSH_TAVERN_RECEIPT_EXPERIMENT=compact node --import ./tests/fixtures/worldbook-batch-receipt-experiment.mjs tests/fixtures/worldbook-template-benchmark.mjs /tmp/issue56-receipt-compact large 20
```

实验 loader 只改测试进程中的基准内容，以及该基准向浏览器提供的队列源码；不改宿主源文件、不重建或改写发布产物。

## 后续落地：精简批次回执

已将第 1 项落实到生产路径：`renderMany` 内部保留成功条目的完整作用域传递，返回的逐条回执去掉 `scopes`；宿主批量消费时不再复制作用域。单条 `render` 返回结构、每条刷新及保存、错误隔离、随机调用数和激活请求均保留。

新增大作用域回执测试，并扩展真实浏览器差分测试覆盖全局与消息变量在失败后的恢复。241 项相关测试全部通过，无跳过；正常重建模板产物，112 个清单文件通过哈希与体积校验。实验 loader 的 `compact` 现在直接使用生产实现，`baseline` 仅在测试进程内恢复完整作用域回执，便于继续对照；不恢复宿主旧的多余复制。
