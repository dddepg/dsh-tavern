# MVU 草稿参数示例

`begin` 锁定来源与目标版本，返回草稿 ID 和版本。后续每次写入用最新版本；所有例子中的 ID、版本、路径都替换为工具实际返回值。草稿只负责 MVU 转换，不用于普通人物卡编辑。

```json
{"action":"begin","sourcePath":"cards/示例.json","requestId":"conversion-start"}
```

## 分组填写

```json
{"action":"patch","draftId":"实际ID","draftRevision":1,"requestId":"fields-1","section":"fields","values":{"/时间":{"时段":"白天"},"/地点":{"名称":"大厅"}}}
```

此处不是成品初值：每个开场仍需分别提交。

```json
{"action":"patch","draftId":"实际ID","draftRevision":2,"requestId":"opening-0-1","section":"opening","openingId":"opening-0","inheritInitialState":true}
```

```json
{"action":"patch","draftId":"实际ID","draftRevision":3,"requestId":"opening-1-1","section":"opening","openingId":"opening-1","values":{"/时间/时段":"夜晚","/地点/名称":"车站"}}
```

可以先明确继承底稿，再只提交本开场的差异。单独修正一个已填写开场时省略 inheritInitialState，以免把它重置为底稿。数组整组提交，不通过数组下标增量写入。对象字段支持按子路径分批填写，同一批不能同时覆盖父路径和子路径。

规则按分组名保存，修改同名组只替换该组，空字符串删除该组。已有转换的规则放在“既有规则”组，修改前 read 该组，避免追加互相矛盾的规则。

```json
{"action":"patch","draftId":"实际ID","draftRevision":4,"requestId":"rules-1","section":"rules","values":{"场景":"仅根据已发生的正文事实更新时间与地点。"}}
```

## 外观与清理

`section=appearance` 的 values 直接接收现有 appearance 参数：原视图 sourcePath/bindings，或自定义 html；命名 mvu-field 自动编译。它是一份独立设计，后续修正初值和规则不会清空它。

`section=mapping` 接收 sourceFields 和 fieldMappings 数组，按提供的键替换草稿相应清单。`section=cleanup` 的 values 为完整 cleanup 数组；普通分组写入不会改动它。精确清理参数见 mvu-recipe.md。

草稿 read 的路径相对于草稿：

- `/definition/initialState`：字段底稿。
- `/definition/openingStates/1`：第二个开场。
- `/definition/appearance/html`：设计 HTML。
- `/rules/场景`：一组规则。
- `/cleanup`：清理清单。

对象返回目录；字符串分页返回 text、nextOffset。读取对象子字段使用返回路径，不反复读取整份草稿。

设计失败且已说明回退、或用户改变外观要求时，`patch section=requirements` 的 values 可设置 `appearanceRequirement` 和 `basicReason`，保留原草稿内容。变更后重新核对需求；工具不会自动降级。

## 完成检查与提交

先根据源卡核对需求，再设置 review。它不是向用户索要额外许可。

```json
{"action":"patch","draftId":"实际ID","draftRevision":8,"requestId":"review-1","section":"review","values":{"sourceCoverage":true,"cleanup":true,"appearance":true}}
```

然后 commit（版本使用 review 返回的新版本）。validate 只在需要提前汇总问题时调用，commit 自带同样检查。

```json
{"action":"commit","draftId":"实际ID","draftRevision":9,"requestId":"commit-1"}
```

`phase=committed` 的 receipt 是带时间的提交记录；它不保证之后用户没有删除或修改成品。已提交草稿不可再次 patch，begin 新草稿会加载当前成品方案。重复 commit 返回相同凭据，不会重新创建已删除的成品。
