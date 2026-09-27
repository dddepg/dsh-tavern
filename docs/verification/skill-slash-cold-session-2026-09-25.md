# 卡片 Agent 冷启动斜杠 Skill 目录

## 根因与修改

固定宿主 DSH 0.1.5-rc.2 的 `SessionSkillCatalog.scopeFor` 在 Agent 未激活时返回共享的 standing preset scope。Tavern Skill provider 使用 scope.session.id 判断 Agent 用途；冷查询没有这个身份，导致卡片 Skill 被过滤为空。浏览器还会缓存该目录，直至页面重载、连接重置或预设切换。

Tavern 在服务生命周期内适配原生目录服务的 scopeFor：冷查询获得含 Session ID 的独立子作用域，并通过宿主同一份 dsh-scope 注册表保留预设父级。已激活 Agent 使用原作用域；不启动 Agent、不发起模型请求、不修改宿主安装文件。最多保留 512 个冷查询作用域，预设改变时更换缓存身份，插件卸载时恢复原方法。

## 验证

- 使用实际宿主 SessionSkillCatalog 方法和 Tavern provider 构造冷查询；修复前目录为空的断言失败，修复后通过。
- 验证卡片与游玩并发查询隔离、预设祖先保留、同会话缓存键复用、预设变化换键、热 Agent 原样返回、卸载恢复。
- 重启本机 CLI 后，在已有卡片工作台对话中未发送新消息，输入 `/`，真实 Chrome 页面显示“技能”分组及 create-skill、debug-card 等候选。
- 输入 `/create` 筛选，Tab 选择后输入框显示 `/create-skill`。清理测试输入，没有发送模型请求。

本次是真实 CLI 浏览器验证；未独立验证 Desktop、Android。已打开页面升级后需刷新，以清除旧的空目录缓存。
