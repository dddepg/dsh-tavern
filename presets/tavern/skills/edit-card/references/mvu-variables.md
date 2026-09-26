# 修改已有 MVU 卡的变量

用于新增、删除变量，调整字段路径或某个开场初值。沿用“修改人物卡”任务，不重新转换整卡。工具负责版本保护、各开场结构及面板引用检查；Agent 负责规则语义和需要的局部展示设计。

先按 edit-card 的“关联世界书与变量定义”确认托管定义及实际绑定关系；外部结构走该节的识别分支，不直接执行下面的托管流程。

1. `tavern_card_draft` 传 `{"action":"begin","path":"cards/目标卡.json"}`。工具自动找到来源和已有定义，后续省略 draft。只支持定义完整且没有方案外修改的托管 MVU 卡；不满足时报告具体限制，保留目标卡，不能重新转换覆盖。
2. 根据需求按路径 read `/definition/initialState`、`/definition/openingStates/N`、`/rules` 或 `/definition/appearance`，只读需要的部分。begin 返回字段目录与开场 ID；保留未涉及的正文、规则、开场值和外观。
3. 提交局部修改：
   - 新增：`{"action":"patch","section":"fields","values":{"/角色/体力":100}}`。再对每个开场 patch opening，使用 `inheritInitialState:true` 补缺失字段；场景不同则显式提供该开场的值。补上新增字段的规则和面板组件。新增后 missing 中的 DRAFT_APPEARANCE_FIELDS 表示待补面板，不是字段写入失败。
   - 面板联动：读取草稿 `/definition/appearance/html` 所需片段，以 `patch section=appearance` 传 `values:{"replacements":[{"expected":"唯一旧片段","value":"保留旧布局并插入 <mvu-field path=\"/角色/体力\"></mvu-field>"}]}`。只替换需要的位置，工具保留已有绑定并自动给新组件编号。无需从卡片 JSON 提取整段 HTML，也无需手工维护 $10 等捕获。需要完整方案时 html 必须是字符串，读取回执中的 text 不是一个可直接传给 html 的对象。
   - 修改初值：fields 修改底稿不会覆盖已有开场值。实际生效的初值用 `{"action":"patch","section":"opening","openingId":"opening-0","values":{"/角色/体力":80}}`；按用户指定范围逐开场修改，不覆盖无关场景。
   - 删除：先局部调整 appearance、mapping、displayFields 等实际引用。工具不支持单独修改某种引用时报告限制，不能篡改生成元数据绕过。再 `{"action":"patch","section":"fields","operation":"remove","path":"/角色/体力"}`，工具同步移除各开场字段。根据错误列出的引用定点处理；同时清理规则中的旧字段说明。
   - 改名或移动：fields 的 `operation:"move"`，传 path/toPath，工具同步定义、开场和结构化绑定；核对规则中的旧名称。此操作不等于存档保值改名：若未另行声明存档迁移，应用更新按删旧加新处理，必须说明这一效果。
   - 同路径改变类型可能导致旧存档更新被拒绝；先明确转换方案，不能按普通增删承诺兼容。
同一次变量修改的 fields、opening、rules、appearance 都在同一草稿中完成，最后一次 commit 才写目标卡。`tavern_update_mvu_appearance` 是直接保存成品的文案/样式工具，不用于扩展捕获，也不与进行中的草稿混用。若其他操作已经改变目标，保留当前草稿，通过 read 回收已填写内容、核对目标差异，再 begin 并迁移必要改动；不要不看差异就重放或从零重写。

4. 根据 missing 补齐开场和面板。`patch section=review` 确认 sourceCoverage、cleanup、appearance；只核对本次改动影响及已有保存方案，不重新清理原文。必要时 validate 汇总一次，再 commit。receipt.committed=true 且 receipt.validation.valid=true 即完成，无需重复转换或真实游玩验收。
5. 报告目标路径、字段变化和开场范围。卡片保存与本局存档应用是两个步骤：用户在游玩中点击“重新加载人物卡和世界书”后，新字段补该开场初值、已删除字段同步移除、保留字段保持当前值；历史快照一起对齐。不要声称保存卡片已经改写所有游玩存档。

失败按具体 path/openingId 修正当前草稿，保留已完成内容。缺失来源、方案外修改或不支持的引用结构不能通过通用写文件绕过版本检查。
