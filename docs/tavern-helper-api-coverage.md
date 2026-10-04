# Tavern Helper API 兼容补全（2026-10-04）

## 审计基线

- DSH Tavern：`4bbff696ebf9bd5b87e1aa2c899c723a5364385f`
- Tavern Helper：`46ec10df770b47e1ce6562de747d72f1bde3549e`
- 实例：[Discussion #127](https://github.com/flizzywine/dsh-tavern/discussions/127)

此处区分「共享脚本沙箱」和「消息 iframe」。一个函数存在，不代表它在两种环境都具备完整的 SillyTavern 语义。上游当前 API、旧别名、iframe 全局接口也不是同一个集合，因此不按函数名数量计算兼容率。

## 本批已实现或修正

### 世界书桥接

- 延迟资源模式仍向消息 iframe 传递当前世界书的轻量 `name/resourceAccess` 描述符；读取书名无需下载全部条目
- `getWorldbookNames`、`getCharWorldbookNames` 读取实时上下文，不再固定为 iframe 初始化时的值
- 世界书变更、名称、全局/角色变量通过上下文增量传播；部分 RPC 回包不会误删已有世界书描述符
- 验证覆盖实际 `getSession` 的完整、延迟和缓存投影，以及消息 iframe RPC/上下文更新

### 命令桥接

- 正式游戏共享脚本沙箱现在提供 `triggerSlash` 和 `TavernHelper.triggerSlash`
- `/pass`（`/return`）、`/findentry`（`/findlore`、`/findwi`）支持有边界的只读管道；支持转义和 `{{pipe}}`
- `/findentry` 仅访问当前会话绑定世界书，支持 `key/keysecondary/comment/name/content/uid`。匹配为不区分大小写的精确匹配优先、其次子串匹配；**不是** SillyTavern Fuse.js 模糊搜索的完全替代
- 字符串管道结果不会再被 `Object.assign` 拆成字符索引对象；已有发送/生成返回对象保持原行为
- 鉴权通过但未实现的 Helper RPC 显式返回错误，不再留下永不完成的 Promise
- 共享脚本命令保留前台、生命周期和关闭事件保护，并等待此前排队的写入
- 不支持的混合管道先整体拒绝，不会只执行其中的发送或其他副作用

详见[命令兼容范围](./slash-command-compatibility.md)。`/pass` 不执行完整 ST 宏系统；准备页的命令路径仍按该文档列出的开局命令处理。

### 消息、变量与工具 API

| API | 共享脚本 | 消息 iframe | 本批范围 |
| --- | --- | --- | --- |
| `getChatMessages` | 改进 | 改进 | 负索引、负数范围、`role/hide_state`、`data/extra/swipes_info`；保留 DSH 旧字段别名 |
| `getAllVariables` | 修正 | 有限支持 | 脚本顺序为 global→character→script→chat，不掺入全部聊天消息；消息为 global→character→chat→当前楼层 |
| `deleteVariable` | 修正 | 新增 | 等待写入，返回 `{variables, delete_occurred}`；`delete_occurred` 使用 lodash `unset` 的结果 |
| `getMessageId` | 新增 | 新增 | 支持官方消息 iframe 名称和 DSH token 名称；拒绝非消息 iframe 名称 |
| `getIframeName` | 新增 | 新增 | 共享沙箱按当前脚本返回虚拟脚本名；消息使用当前真实 iframe 名称 |
| `errorCatched` | 修正 | 修正 | 保持 `this` 和结果；同步/异步错误报告后重新抛出原错误，报告失败也不覆盖原错误 |
| `retrieveDisplayedMessage` | 实现有限适配 | 实现有限适配 | 当前或同会话已渲染、同源消息 iframe 的真实 DOM；无权访问/隐藏/未显示时返回空集合 |
| `getAllEnabledScriptButtons` | 新增 | 未实现 | 保留按钮组启用状态；返回启用脚本中可见按钮及其真实事件 ID |
| `initializeGlobal/waitGlobalInitialized` | 补 namespace 导出 | 未新增跨 frame 语义 | 共享沙箱原实现现在可通过 `TavernHelper` 访问 |

消息读取遵循固定上游实现对超界索引的 clamp 行为，非法格式返回空数组。`include_swipes` 两个重载所需字段均可读取；DSH 为旧卡兼容保留字段超集，不会因切换该选项删除旧字段。`extra/swipes_info` 读取已有插件元数据，缺失值为 `{}`，并不表示已实现这些字段的完整写入语义。

`preset/extension` 等未实现变量作用域现在明确报错，不再错误地读写当前消息变量。

## Discussion #127 第三项的边界

帖子后续已经澄清：播放桥与回主页脚本被执行了，失败的是它们对消息 DOM 的假设。V31 在顶层 `#chat/body` 扫描 `.jzy-st`，不进入 iframe；这不等同于调用 `retrieveDisplayedMessage`。

本批提供可用的正规消息 DOM 访问接口，并清理共享脚本退出后留在同会话消息文档中的 jQuery 监听器，避免跨会话残留。**这不能证明原 V31/回主页脚本无需改动即可工作。** 尚未取得原卡/脚本，未做其真实点击链路验证；没有全局劫持 `document` 查询，也没有把脚本重复注入每个消息 iframe。原生 `addEventListener`、直接顶层 DOM 扫描等私有页面假设仍需针对真实卡验证与适配。

## 仍缺失或部分支持的组

- **消息写入**：`setChatMessages` 的完整 `refresh/swipes/name/role/is_hidden/extra` 语义；非末尾插入、删除/旋转聊天历史。需要同时保持 DSH 剧情、存档及会话投影一致
- **变量**：`preset/extension`；部分同步返回与上游不同。消息 `getAllVariables` 尚不累计所有历史楼层，避免为一次同步 getter 拉取整段冷历史
- **渲染**：`formatAsDisplayedMessage/refreshOneMessage`；V31 等顶层 DOM 假设的自动兼容
- **正则**：`formatAsTavernRegexedString/isCharacterTavernRegexesEnabled`；角色/预设正则写入。格式化还涉及完整宏语义，未用简单别名冒充
- **脚本**：脚本树 CRUD、完整跨 iframe globals 和事件面；新增按钮读取不代表新增脚本管理/按钮持久化
- **生成**：`generate`、真实流式、取消、模型列表；现有 `generateRaw` 流式事件仍是收到全文后的兼容通知
- **资源**：完整世界书库 CRUD/绑定、人物/预设/persona CRUD、音频和扩展管理；当前世界书 API 仍限于会话绑定资源

## 验证方式

遵循仓库 `AGENTS.md`，本批运行相关测试子集，不运行仅供发布时使用的全量测试。覆盖共享脚本、消息 iframe、RPC 宿主投影、旧能力诊断、变量/MVU、世界书持久化、上下文增量、按钮导入、jQuery teardown 和客户端构建一致性。测试没有调用真实模型、发布 PR、推送或部署。

可复现命令（先按仓库说明准备对应 DSH 宿主及依赖）：

```sh
node bin/build-tavern-client.mjs --check
node bin/test-tavern.mjs tests/helper-*.test.mjs tests/tavern-helper-*.test.mjs \
  tests/inline-message-renderer.test.mjs tests/frame-variable-read.test.mjs \
  tests/frame-variable-storage.test.mjs tests/status-refresh-fallback.test.mjs \
  tests/session-resource-access.test.mjs tests/card-extension-reading.test.mjs \
  tests/script-session-owner.test.mjs tests/mvu-incremental-context.test.mjs \
  tests/mvu-view-refresh-cost.test.mjs tests/tavern-script-host-adapter.test.mjs \
  tests/plugin-startup.test.mjs tests/status-bar-session-view.test.mjs \
  tests/tavern-client-build.test.mjs
```

### 本次云端验证结果

- 最终相关子集：**252 通过，0 失败，0 跳过**（排除下述两个无法启动的浏览器用例）
- 实跑宿主：官方 DSH 0.1.5-rc.2 的 boot/session/agent/tools/subagent/typert/filesystem 核心依赖；覆盖真实插件启动、世界书 session 投影、持久化与 MVU/上下文相关测试
- 客户端生成一致性、插件包一致性、JavaScript 语法和 `git diff --check` 通过；仓库没有独立配置的通用 lint/typecheck 命令
- Chromium/WebKit 两个真实浏览器用例**受环境阻塞，不能算通过**：Chromium 官方下载包不完整，系统 Chromium 因 Unix socket 受限而无法启动；WebKit 缺 GTK4、Graphene、Harfbuzz ICU 等动态库
- 原始 V31/回主页实卡验证未执行，因为尚未提供卡或脚本

## 官方语义依据

- [变量](https://github.com/N0VI028/JS-Slash-Runner/blob/46ec10df770b47e1ce6562de747d72f1bde3549e/src/function/variables.ts)
- [消息](https://github.com/N0VI028/JS-Slash-Runner/blob/46ec10df770b47e1ce6562de747d72f1bde3549e/src/function/chat_message.ts)
- [工具](https://github.com/N0VI028/JS-Slash-Runner/blob/46ec10df770b47e1ce6562de747d72f1bde3549e/src/function/util.ts)
- [显示消息](https://github.com/N0VI028/JS-Slash-Runner/blob/46ec10df770b47e1ce6562de747d72f1bde3549e/src/function/displayed_message.ts)
- [脚本按钮](https://github.com/N0VI028/JS-Slash-Runner/blob/46ec10df770b47e1ce6562de747d72f1bde3549e/src/store/iframe_runtimes/script.ts)
