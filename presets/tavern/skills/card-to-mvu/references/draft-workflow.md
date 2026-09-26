# MVU 草稿参数示例

`begin` 锁定来源与目标版本，自动选中当前草稿，返回 d1、d2 等会话内短编号。后续默认省略 draft；只有切换草稿时才传短编号。已读版本与重试标识由程序管理。草稿只负责 MVU 转换，不用于普通人物卡编辑。

```json
{"action":"begin","sourcePath":"cards/示例.json"}
```

## 分组填写

```json
{"action":"patch","section":"fields","values":{"/时间":{"时段":"白天"},"/地点":{"名称":"大厅"}}}
```

此处不是成品初值：每个开场仍需分别提交。

```json
{"action":"patch","section":"opening","openingId":"opening-0","inheritInitialState":true}
```

```json
{"action":"patch","section":"opening","openingId":"opening-1","values":{"/时间/时段":"夜晚","/地点/名称":"车站"}}
```

inheritInitialState 仅补缺失路径，不会重置已填写的值；values 在补齐后应用。只继承符合当前开场的底稿值，其余明确填写。数组整组提交，各开场长度可不同；对象字段支持按子路径分批填写，同一批不能同时覆盖父路径和子路径。

### 字段操作

字段目录通过 fields 建立并返回 fieldSchema（路径、类型、结构版本），opening 不能隐式增加字段。默认 set/replace 替换所选路径；merge 递归合并对象，保留未提交子键。null 始终是值，不是删除。若替换会丢失已声明子字段，工具拒绝，改用 merge 或显式 remove。

```json
{"action":"patch","section":"fields","operation":"merge","values":{"/时间":{"天气":"晴"}}}
```

增加字段后，用 opening 的 values 填各场景值；底稿适用时可 inheritInitialState=true 只补缺失项。fields 更改底稿不会自动改变已填写开场，fieldSchema.revision 只随目录结构或类型变化。

```json
{"action":"patch","section":"fields","operation":"move","path":"/时间/时段","toPath":"/场景/时段"}
```

move 同步底稿、所有开场、普通绑定、组件 path、展示路径与来源映射；目标已存在或路径互相包含时拒绝覆盖。集合整体可移动，collectionPath 内部相对绑定须先明确调整外观方案。自然语言规则不会自动改写，ruleReviewRequired 提醒核对；修改规则并完成 sourceCoverage 确认后清除提醒。

```json
{"action":"patch","section":"fields","operation":"remove","path":"/误建字段"}
```

remove 同步删除底稿与开场里的指定路径；仍有美化或来源映射引用时，先调整引用。原卡 cleanup 和定义字段操作是不同范围。

旧草稿若同时存在 /时段 和 /时间/时段：先按原文选定正确值，用 opening 写入已声明的规范路径，再 fields remove /时段。不要把错误键补到全部开场。旧草稿的目录从底稿恢复，多余开场键仍会列为问题，不会默默加入目录。

规则按分组名保存，修改同名组只替换该组，空字符串删除该组。已有转换的规则放在“既有规则”组，修改前 read 该组，避免追加互相矛盾的规则。

```json
{"action":"patch","section":"rules","values":{"场景":"仅根据已发生的正文事实更新时间与地点。"}}
```

## 外观与清理

`section=appearance` 的 values 直接接收现有 appearance 参数：原视图 sourcePath/bindings，或自定义 html；命名 mvu-field 自动编译。它是一份独立设计，后续修正初值和规则不会清空它。

`section=mapping` 接收 sourceFields 和 fieldMappings 数组，按提供的键替换草稿相应清单。`section=cleanup` 的 values 为完整 cleanup 数组；普通分组写入不会改动它。cleanupOrphanEntrances 只在此分组保存；后续省略该参数会保留设置，显式 false 关闭。validate 的 effectiveCleanup 展示实际操作，commit 使用已保存设置；把该参数传到 commit 会报参数错位。精确清理参数见 mvu-recipe.md。

草稿 read 的路径相对于草稿：

- `/fieldSchema`：唯一字段目录与结构版本。
- `/definition/initialState`：初值底稿。
- `/definition/openingStates/1`：第二个开场。
- `/definition/appearance/html`：设计 HTML。
- `/rules/场景`：一组规则。
- `/cleanup`：清理清单。

对象返回目录；字符串分页返回 text、nextOffset。连续完成同一部分的分页读取；read 不带 path 可刷新已读版本、查看当前草稿与列表。读取对象子字段使用返回路径，不反复读取整份草稿。

设计失败且已说明回退、或用户改变外观要求时，`patch section=requirements` 的 values 可设置 `appearanceRequirement` 和 `basicReason`，保留原草稿内容。变更后重新核对需求；工具不会自动降级。

## 完成检查与提交

先根据源卡核对需求，再设置 review。它不是向用户索要额外许可。

```json
{"action":"patch","section":"review","values":{"sourceCoverage":true,"cleanup":true,"appearance":true}}
```

然后 commit。validate 只在需要提前汇总问题时调用，commit 自带同样检查。

```json
{"action":"commit"}
```

`phase=committed` 的 receipt 是带时间的提交记录；它不保证之后用户没有删除或修改成品。已提交草稿不可再次 patch，begin 新草稿会加载当前成品方案。重复 commit 返回相同凭据，不会重新创建已删除的成品。

## 来源读取与检查

```json
{"action":"source","path":"/first_mes"}
```

source 传 query 则搜索原卡，path 可缩小范围；无需 sourcePath/sourceRevision。inspect 从草稿中读取 sourceFields 后更新来源目录与字段清单。validate 只需 action，并返回实际清理计划；commit 同样只需 action。

响应丢失时原样重试原请求；发生版本冲突后先 read，再核对并修改。begin 会恢复同一会话、同一来源与目标版本的未提交草稿；已提交后再次 begin 建立下一份草稿。旧来源发生变化时，旧草稿不会自动换来源或覆盖新版本。

## 多草稿切换

```json
{"action":"read","draft":"d1"}
```

成功读取后 d1 成为当前草稿，后续 source/patch/validate/commit 可继续省略 draft。短编号只在本会话内有效；重启服务后保留，其他会话不能靠相同编号访问它。旧版长凭据仅保留兼容，新调用无需复制它。

已有草稿 HTML 的局部增补可用 patch section=appearance、values.replacements:[{expected,value}]；expected 对当前草稿恰好匹配一次。新增展示字段用 mvu-field 根路径组件，工具保留旧绑定并自动分配新捕获。整个变量与面板修改保持在草稿内，commit 前不调用直接保存成品的外观工具。
