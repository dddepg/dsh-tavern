---
name: edit-card
description: "修改已有的人物卡：设定、开场、文风、世界书、正则美化、MVU 变量与面板。像改代码一样直接改，改完用 tavern_validate_card 校验格式；普通卡转 MVU 使用 card-to-mvu，游玩故障诊断使用 debug-card。"
---

# 修改人物卡

完成用户要的修改，其余内容保持不变。目标或要求不明确时只问缺的那一项，明确了就动手。

## 怎么改

人物卡就是一份文件，按需要选顺手的方式改：

- 标准字段（描述、性格、开场、示例对话等）：`tavern_update_card` 的 `fields`，不用处理 JSON 转义。
- 扩展字段（正则、脚本、MVU 面板等）：`tavern_update_card` 的 `rawOperations`，按 JSON Pointer 设置或删除。
- 世界书条目：`tavern_update_worldbook`。条目字段用 `comment`、`content`、`primaryKeys`、`enabled`、`constant` 等。
- 大段或多处改动也可以用文件编辑器直接改卡片 JSON。
- 读取用 `tavern_read_card`、`tavern_read_card_raw`、`tavern_read_worldbook`，只读需要的部分。

改完调用 `tavern_validate_card`，修正 errors；warnings 视情况处理。

## MVU 卡

变量初值在各开场末尾的 `<initvar>` 里，更新规则在世界书 `[mvu_update]` 条目，面板在 `extensions.regex_scripts` 的状态视图正则里。格式约定用 `tavern_read_skill_reference` 读取 `card-to-mvu` 的 `references/mvu-format.md`。

- 改初值：直接改对应开场的 `<initvar>` JSON。
- 增删变量：每个开场的 `<initvar>` 一起改，同步改 `[mvu_update]` 规则和面板。
- 改面板：直接改状态视图正则的 `replaceString` HTML。
- 改开场正文：保留末尾的 `<initvar>` 和 `<mvu-status/>`。

## 世界书归属

改世界设定或规则前，先确认目标卡实际用的是内置世界书（`cards/...`）还是绑定的独立世界书（`worldbooks/...`）。独立世界书可能被多张卡共用：用户只要求改当前卡、而修改会影响其他卡时，先说明影响。

## 完成

说明改了哪些地方和校验结果。资源保存不会自动改动正在进行的游戏存档。静态校验不等于真实游玩验证，用户要求时才做真实试玩。
