---
name: card-to-mvu
description: "把正文内输出状态栏的 SillyTavern 人物卡转换为 DSH Tavern MVU 副本。用户要求普通卡转 MVU、将状态生成移到后台，或迁移已有状态字段时使用。通过专用工具装配和验收，模型负责理解原卡、定义变量和精确清理。"
---

# 人物卡转 MVU

目标：前台写剧情，后台更新变量，面板读取状态。**MVU 成品结构由工具装配，不是模型需要重新设计或从其他卡学习的内容。** 模型只负责完整提取目标卡状态、定义更新依据、美化映射和精确清理。

标准流程：`tavern_convert_to_mvu.inspect` → 读完目标卡必要字段 → `saveDefinition`（已有美化）或 `tavern_design_mvu_appearance`（无美化）→ `apply` 引用 definitionRevision。无原美化且设计失败时，saveDefinition 可保存默认面板。结构及参数疑问先看 [转换参数与边界](references/mvu-recipe.md)；inspect.structureGuide 也会返回调用边界。标准转换只读目标卡及本配方，不扫描其他人物卡、raw/data 包装、会话目录或工具源码寻找样板。用户明确指定参考卡或实际故障需要专门适配时，再读取相关材料并说明用途。

工具直接生成世界书初值、后台更新规则、各开场 initvar、状态入口与显示/历史隔离正则。模型不手写这些运行组件；无原美化时只设计 HTML/CSS，更新和订阅代码仍归工具负责。

## 1. 读取转换底稿

确定原卡 `sourcePath`，调用 `action: "inspect"`。默认 reading 一次返回有长度预算的原文、字段路径、版本和目标占名状态。先读这份底稿；仅对 `nextOffset` 非空或 `deferred` 中与任务相关的字段补读，优先用 `action: "read"` 的 `paths` 一次读取多个字段。单个长字段按 `nextOffset` 续读；定位片段才用 search。summary 仅适合复查版本，full 仅适合小卡。

source/target 都是工具解析后的规范化生效字段；世界书为实际绑定内容的合并底稿。不另用 Bash 解析磁盘 raw/data 镜像。原来未生效的内置世界书可用 scope=preservedWorldbook 查看，不自动启用。若 destination.available=false，先换副本名称再定义方案。

先核对 appearanceSources 和 capabilities：默认保留原卡的美化。存在原视图时，选取来源路径，把每个 `$1`、`$2` 等捕获字段映射到变量 JSON Pointer，调用 `action: "freezeAppearance"`。工具直接读取原 HTML/CSS 并校验内容指纹，模型不重写皮肤。固化成功后将相同 `appearance` 传给 saveDefinition；颜色、渐变、图标、排版和原生 `<details>` 折叠由原视图保留。复杂脚本或属性中的动态取值不受支持时，保留来源并说明具体适配缺口，不能删除美化或降级默认面板。多人面板使用 collectionPath，bindings.path 相对于每位成员；各开场分别保存初值。

阅读 description、personality、scenario、system_prompt、post_history_instructions、开场白及 alternate_greetings、mes_example、世界书、正则和 Helper 脚本。找出状态生成、状态展示、候选项生成以及它们各自依赖的位置。默认保留无关字段、扩展、署名及 `{{char}}` / `{{user}}`。

完成条件：给出简短映射“旧显示项 → 变量路径 → 类型/初值 → 变化依据”。稳定事实沿用原卡；可变状态只根据已发生剧情更新；推导值只使用原卡明确公式；未知信息保持未知，不编造数值。

## 2. 完整提取并保存字段定义

先列齐所有人物、所有开场、状态生成规则中的字段，再调用 `action: "saveDefinition"`。提交完整 `initialState`、`updateRules`、展示配置，以及每个来源字段的 `fieldMappings`。初值不包裹 stat_data。人物使用稳定姓名或 ID 索引，预期新增成员的集合声明 `$meta.extensible` 和完整模板。未知值明确为空，不拿其他开场的事实补齐。

inspect.stateInventory 自动列出原美化标签协议在所有开场中的字段、原值、来源范围和 ID。每项都须映射到独立的变量路径，工具直接复制原值；同一个开场的不同人物不能映射到同一位置。完整读取所有状态规则，自动清单未覆盖的文本字段，用 sourceFields 指定来源 path/offset/length，再 inspect 同参数取得 ID，纳入 fieldMappings。规则中的类型、更新条件与公式写入 updateRules；完整字段结构体现在 initialState 中。自动识别仅覆盖显式标签，不能据此声称所有自定义格式已经提取完整。

openingStates 可提交完整初值对象数组，first_mes 在前，alternate_greetings 按序在后；省略时工具复制 initialState 作为各开场底稿，再按来源映射填入各自已有值。全部开场保留已定义结构。工具将各自完整初值写入开场的 initvar，官方 MVU 按所选开场初始化。需要按人物重复面板时指定 collectionPath，绑定相对成员字段；需要同时展示全局字段时使用下面的根绑定模式；无原美化时，按下一段设计适合人物卡的面板；默认面板作为失败后的回退。

绑定模式必须先选定，不能混用：

- **根绑定**：省略 collectionPath，路径如 `/时间`、`/人物/甲/姓名`。可同时显示全局和人物字段；绑定整个 `/人物` 会显示 JSON 文本，并非逐人美化。
- **集合绑定**：collectionPath 为 `/人物`，路径如 `/姓名`、`/位置`，工具为每位成员重复面板。全部绑定都相对于成员，不能混入顶层 `/时间`。目前接口不支持全局区域与人物重复区域混合；不要删字段或改字段归属来迁就它，需要该布局时报告具体适配缺口。

原卡没有美化时，调用 `tavern_design_mvu_appearance`，一次提交完整初值、各开场定义、更新规则、来源映射，以及字段组件：简单面板传 `fields: []` 自动展示全部字段，或传 `{path,label,display}` 数组指定顺序，遗漏业务字段由工具补齐。数组字段使用 `display: "list"`。自定义布局在 `html` 内使用 `<mvu-field path="/字段" display="text"></mvu-field>`（数组改为 list），工具生成占位编号与绑定，此时省略 bindings 和 collectionPath；组件使用完整根路径。旧式布局仍可提交 `html`、`bindings` 和可选 `collectionPath`。根据人物卡的时代、题材、氛围设计配色、字体层级、图标、分组和原生 details 折叠；兼顾窄屏、长文本和对比度。HTML/CSS 使用 `$1`、`$2` 文本占位，动态值和多人增删由工具绑定。所有已定义业务字段及集合模板字段都应有展示映射，排版不能成为删字段的理由。HTML 中的标签使用“玩家”“角色”等静态文字；不支持 {{user}}/{{char}}、EJS 或其他动态模板，值只通过 $1/$2 绑定。工具不接受自定义 JavaScript、事件属性或嵌入文档。

设计工具会保存完整定义并返回 definitionRevision，后续 apply 直接引用，无需再抄写 HTML 或调用 saveDefinition。已有原美化时工具拒绝覆盖，继续走原视图固化。设计校验失败先按错误修正；确实无法完成时，用 saveDefinition 保存无 appearance 的默认面板，交付时说明回退原因。无论设计或回退，字段完整性验收相同。

完成条件：逐项对照原卡确认无遗漏，saveDefinition 或设计工具成功返回 definitionRevision。定义已经持久化，包含结构、类型、来源值、各开场初值、更新规则和展示配置；生成时只传版本号，不再转录。需要查看时用 read 的 scope=definition 和 definitionRevision。需要参数例子或已有 MVU 边界时，读取 [转换参数与边界](references/mvu-recipe.md)。原卡自定义脚本交互、Zod Schema 需分别适配。

## 3. 精确清理原卡内容

把清理写入 `cleanup`，路径和原文来自 source 的 read/search，不能从生成后的副本提取匹配片段。优先选择最小参数操作：

- 整个旧条目、正则或脚本：`remove`，只提交 `path`。
- 短句：`replaceText`，提交唯一短片段 `expected` 和新文字 `value`；删除用空字符串。
- 长状态区块：`replaceBlock`，提交唯一首尾标记 `start`、`end` 和 `value`；范围包含首尾标记，删除用空字符串。
- 确实需要整个字段改写：`replace`，只提交 `path` 和新 `value`。

同一字段的多处改动分别提交，全部按原始底稿定位；范围不能重叠。可用 `reason` 记录删除依据，尤其世界书条目需要核对名称、启用状态和剧情用途；禁用条目也属于应保留的作者内容。保留内容由工具复制，无需回传 `card`、整条旧内容或未修改正文。工具用 `sourceRevision` 校验原卡和实际世界书，先验证全部操作再修改。

- 从原位置直接删除已迁移内容及其空标题、空容器。先固化原视图并保存完整字段定义，再清理旧状态输出要求、示例和对应旧显示正则；保留未固化的其他美化。保留剧情事实、玩家视角、文风和无关交互。不留下替代说明、注释或占位文字，不向前台补写“由后台结算”“只输出正文”等运行指令。新的展示入口由工具添加并从模型历史隔离。
- 删除副本中重复的生成要求：原卡自带的候选行动要求、数量/格式协议、示例、专用正则、HTML 和生成脚本。逐处检查上述所有提示字段、开场、世界书与脚本；共享代码仅删相关逻辑。
- 保留剧情中的选择、分支条件与实际游戏交互，不能凭“选项”字样就删除。无法确认的复杂脚本保留并报告，不当作清理完成。
- 转换只改变状态实现，不改变原卡题材。已有游玩记录不自动迁移。

完成条件：清理位置和依据明确；候选项生成已检查，原卡没有时写“未发现”，仍有不确定内容时列出具体位置。

## 4. 应用并验收

方案含多个待排查问题时，先调用 `action: "preflight"`，传 sourceRevision、definitionRevision 和 cleanup，一次查看开场格式、字段覆盖、外观语法和旧入口报告；尚未保存定义时可传完整定义及 appearance。预检只读，不代表真实游玩验证。仅当 suggestedCleanup 确认是孤立末尾入口时，可在 apply 传 `cleanupOrphanEntrances: true`；有初值或渲染引用的入口按原文明确清理，不自动删除。

用户已授权转换且原卡唯一时，直接 apply，传回 sourceRevision、definitionRevision、name 和 cleanup；更新副本再传 targetRevision。初值、规则和展示配置由工具读取已保存定义直接写入新卡。apply 内置预检、原子保存和磁盘验收；只有清理定位或删除范围尚有疑问时才额外 preview，不把 preview→apply→validate 作为必跑三步。复用同一 sourcePath 和 name；更新已有副本需要 targetRevision。原卡和共享资源保持不变。

已有副本默认沿用已保存定义，新 cleanup 追加并去重。调整字段或更新规则先重新 saveDefinition，再传新 definitionRevision；同一来源的新定义不能减少已经保存的字段。纠正同字段操作时，以 `cleanupResetPaths` 清除该路径旧操作，再提交新操作。只有主动重做整个方案才选 `planMode: "replace"`，此时先保存完整定义，再提交其版本号和全部清理。用 `scope: "plan"` 读取已保存方案；旧版副本缺少方案或原卡已变化时，按工具提示提交完整替换方案。

失败时按 error.code、field/path、missingPaths、token/offset 和 hint 定位并修改本次参数，再重试；错误说明已给出修正方式时，不转而搜索其他卡或实现源码。版本不符重新 inspect；定位错误按返回的 operation、anchor、matches 和 candidates 读取来源片段：0 次表示缺失，多个匹配表示边界不唯一。重复结束标签使用包含独特上下文的较长边界，再 preview；保留原始换行。已有 MVU 规则先判断复用/合并方案，不能为通过检查盲删。不要改用通用写文件工具绕过冲突检查。删除或重命名整个副本必须走人物卡资源库操作；不能用 Bash 的 rm/mv 或文件写入工具只处理 cards 下的工作版，否则 originals 中的原版会残留占名。destination 显示工作版不存在、原版存在时，报告残留原版冲突，不能称为可见人物卡重名；交由资源管理流程保留备份后处理。

以 apply 返回的 validation 为验收结果；仅成品后来发生修改或具体失败需要复查时，才调用 tavern_validate_mvu_conversion。分别报告：

- 自动检查：fieldCoverage 核对已登记字段、已有值和所有开场；多人视图逐字段模拟更新、成员新增与回退。格式、实际绑定、初值定义、后台分流、每个开场、面板唯一性、模型历史隔离、方案外修改、已识别旧渲染协议残留，固化视图与原卡一致性，以及 DOM 更新/恢复和折叠状态保持模拟。旧协议检测仅覆盖已修改来源正则的显式标签，未知格式仍需逐项确认。
- 内容清理：依据验收的 `changes`、`removedEntries`、`preservedEntries` 清单报告实际删除位置和条目名称，再列保留的剧情交互、候选项检查与尚未确定的位置；不能把已删除条目报告为保留。
- 真实验收：获准的独立测试对话中检查官方初始化、后台工具提交、结算回执与落库值；对照原卡检查渐变、图标、排版和折叠；检查右侧自动刷新、字号、会话切换、无变化回合、集合新增、回退或重新生成。工具的 `valid: true` 仅代表自动检查通过，不代表这些项目实测完成。思考文字和 `accepted: true` 不等于结算成功。

保存成功、自动检查通过且删除清单符合任务后，直接交付。成品开场保留 `<initvar>…</initvar>` 供 MVU 初始化，并保留 `<mvu-status/>` 供显示正则生成面板；它们由工具安装，属于预期结构，不是旧内容残留。不要因为搜索命中这些标记而删除、重新转换或继续调查。实际界面泄漏标记或 JSON 才属于展示故障，应另行诊断。pending 是未执行的真实游玩项目，不是继续搜索全局预设、脚本或重复读磁盘的待办。无法实测时列出待验证项目和副本路径。仅编辑本 Skill 不触发人物卡转换或模型游玩。
