---
name: card-to-mvu
description: "把人物卡转换为独立 MVU 副本，或调整转换后的变量定义与各开场初值。通过唯一字段目录、逐开场填值与持久草稿保留美化，最后统一校验提交；模型负责理解原卡、设计状态语义和精确清理。"
---

# 人物卡转 MVU

目标：前台写剧情，后台更新变量，面板读取状态。模型负责语义和设计；工具负责持久化、绑定编号、成品生成及一致性校验。默认保留无关字段，原卡和共享资源保持不变，保留内容由工具复制。

## 1. 建立草稿并读取来源

用 `tavern_card_draft.begin`，传原卡 `sourcePath`、目标 `name`（可省略）和唯一 `requestId`。目标是已有 MVU 副本时仍使用原卡路径与相同副本名，工具自动载入已有字段、各开场、规则、美化和清理。不得把副本再次当成来源转换。

无原美化默认要求 `custom`，需要设计 HTML；有原美化默认 `preserve`，直接绑定原视图。只有用户明确要求简单面板，或设计失败且已说明回退时，才选择 `appearanceRequirement=basic` 并提供 `basicReason`。基础字段面板不等于定制美化完成。进行中确需改变要求时，patch requirements 明确新要求与依据，保留已填写内容。

保存返回的 `draftId`、`draftRevision` 和 `sourceRevision`。按返回的来源阅读片段、目录和 `stateInventory` 核对原文；缺失内容通过 `tavern_convert_to_mvu.read/search` 按来源版本分批读取。确需重新检查来源时使用 `tavern_convert_to_mvu.inspect`。只读目标卡与其绑定资源；标准转换无需搜索其他卡、磁盘包装或工具源码。

覆盖 description、personality、scenario、系统提示、所有开场、mes_example、世界书、正则和 Helper 脚本。找出状态生成、状态展示和候选项生成的位置。稳定事实沿用原卡，变化依据来自原文；未知值明确留空，不编造数值或拿另一个开场的场景补齐。

## 2. 声明字段目录，再逐开场填值

每次 `patch` 携带最新 `draftRevision` 和新的 `requestId`，按时间地点、人物等相关字段组提交。字段路径与类型由 `section=fields` 声明，返回的 `fieldSchema` 是唯一目录；`initialState` 是可显式继承的初值底稿。先确定各开场共同使用的结构，再填值。

- `section=fields`：JSON Pointer 到值的对象，如 `{ "/时间/时段":"白天", "/地点/名称":"大厅" }`。同批使用互不重叠的路径。默认替换所选路径，递归合并对象用 `operation=merge`；null 是空值，删除与改名用专门操作。
- `section=opening`：按工具给出的 openingId 填写已声明字段，各开场使用相同路径与类型，值可以不同。`inheritInitialState=true` 仅补缺失字段并保留已有值，随后应用本次 values；只有底稿符合该场景时才继承。查看返回的 missingFields，按需补齐，未知值采用明确且一致的表示方式。
- `section=rules`：按组保存变化依据，修改同名组保留其余组。
- `section=mapping`：按 stateInventory 提交 fieldMappings，每个来源字段对应唯一状态路径；未识别的内容用 sourceFields 登记原文范围，再通过 inspect 取得 ID。工具复制来源值。

错层级、错类型会在开场保存时返回具体位置。优先使用 suggestedPaths 中符合语义的目录路径；意外多写的字段应修正，不能通过扩大所有开场和面板来消除报错。确需改名或清除错误字段，使用 fields 的 move/remove，同步处理各开场；操作语义、引用依赖和旧草稿修复见 [草稿工具配方](references/draft-workflow.md)。

`read` 默认返回目录、进度和缺失项，传 path 分页读取局部；续页携带版本。无需每次重读完整底稿与所有开场。草稿是否保存以草稿回执为准，不用成品的 scope=plan 判断。

## 3. 保存美化和清理

`patch section=appearance` 保存完整外观方案，不重传状态、开场和规则。之后修改其他分组会保留这份设计。

有原美化时传 `sourcePath` 与 `bindings`，路径来自 begin 的 appearanceSources；工具从来源固化 HTML/CSS。复杂脚本不被支持时报告具体适配缺口，不能删除原美化。无原美化时按题材、时代和氛围设计 HTML/CSS，使用 `<mvu-field path="/地点/名称"></mvu-field>` 自动编号，数组用 `display="list"`；外层已有标签时省略组件 label。字段覆盖完整，兼顾窄屏与长文本。仅基础面板使用 `fields`。

多人重复面板、原视图捕获绑定或复杂清理参数需要时读取 [转换参数与边界](references/mvu-recipe.md)。标签使用静态文本，状态通过绑定读取；不接受自定义 JavaScript、事件属性、EJS 或动态属性。

`patch section=cleanup` 提交当前完整清理清单，原文和路径均以来源版本为准。整项删除用 remove；短片段用 replaceText；长区块用唯一 start/end 的 replaceBlock；范围不可重叠。从原位置直接删除已迁移内容及空标题、空容器，保留剧情事实、视角、文风、作者署名、无关美化和交互。清理旧状态生成与显示协议，以及候选行动的生成协议、示例、正则与脚本；剧情分支本身保留，无法确认的脚本明确报告。

明确的独立末尾旧入口可在 `patch section=cleanup` 设置 `cleanupOrphanEntrances=true`；设置会保留，validate 返回实际清理清单。真实初值或渲染逻辑需显式清理。以上修改仅进入草稿，成品尚未改变。

## 4. 检查需求并统一提交

完成源字段覆盖、清理范围与外观核对后，`patch section=review` 设置 `sourceCoverage`、`cleanup`、`appearance` 为 true。这是 Agent 基于原文的需求确认，不要求用户额外审批。字段迁移返回 ruleReviewRequired 时，一并核对规则文本中的旧路径或称呼，再确认 sourceCoverage。后续修改会清除确认，需重新核对受影响内容。

查看 missing；必要时 `validate` 一次汇总结构问题。定位错误按返回的 section、openingId、path、missingPaths 或清理锚点修正对应部分，不从头重写。结构校验不能替代语义核对；保留原卡所需状态，误建字段则通过明确迁移或删除修正。

`commit` 内部保存定义、预检、原子生成成品并校验；仅传草稿 ID、版本和新 requestId，无需再次调用 saveDefinition/design/apply。`receipt.committed=true` 且 `receipt.validation.valid=true` 才表示成品提交成功。报告副本路径、实际改动与校验结果即可，真实游玩仅在用户明确要求时执行；limitations 是覆盖范围，不是待验收清单。成品中的 `<initvar>` 和 `<mvu-status/>` 是预期生成结构，不应当作残留再删。

## 失败恢复与进度

- 每次新写入使用新 requestId；响应丢失时以原 ID、原版本、原参数重试。重复请求不会重复覆盖。版本冲突先 read，再提交局部修改。
- `saved=true` 只说明草稿保存。`phase=committing` / `commitState=unknown` 表示提交结果尚未完整记录，使用原 commit 请求重试，工具恢复提交凭据。已提交草稿继续修改时 begin 新草稿，沿用同一来源和副本名。
- 来源或目标冲突时保留草稿并核对变化，不使用普通文件写入绕过保护。整个副本的删除或重命名走资源库操作，不能只改工作版而留下 originals 占名。
- 阶段变化时简短说明正在读哪个分组、已填写几个开场、是否正在提交；进度依据工具返回值，不编造百分比。
- 报错经验通过 `tavern_memory_search` 查重，再用 `tavern_memory_experience` 记录。未验证原因标记 unverified；回执错误不能直接推断参数不支持或文件未保存，不把降级方案写成正确流程。

旧的完整定义工具仍兼容已有调用；新任务优先走草稿，不在两套写入流程间来回切换。仅编辑本 Skill 不触发人物卡转换或模型游玩。
