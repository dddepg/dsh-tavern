# 适配 DSH 0.1.5-rc.2 迁移计划

日期：2026-09-22。状态：版本声明已改为酒馆 v2.1.0、DSH `0.1.5-rc.2`、Desktop `2.0.13`、DSHA `v0.1.5-rc2`。不改官方安装文件，不改用户 Profile。

`0.1.5-rc.1` 研究里，请求投影、Token Meter、诊断只读句柄、新会话 system 首位和编辑失败保护已经在当前树上。这次不重做。正文替换的来源规则仍然冲突；隔离补丁已在全新 npm `0.1.5-rc.2` 上通过写入、重开和未打补丁拒绝。补丁实施细节见 [插件内 Session 补丁实施计划](plugin-session-patch-implementation.md)。

## 要改的点

### 1. 装上内存补丁，再开放三个写操作

服务端在 `tavern-plugin/lib/index.js` 的 `apply` 里安装，且必须在会话句柄打开之前。客户端在 `tavern-plugin/src/client/main.js` 的 ModuleLoader 里安装，且必须在第一次历史读取之前。两端用一次版本握手；没就绪时编辑、回退、重新生成保持关闭，并说明原因。

补丁只放宽 assistant replacement 的来源引用，进程内所有 provider 都受影响。user replacement、append、来源覆盖和 system 首节点保护保持原样。

安装后要改掉「当前 DSH 不支持正文替换」这条预检结论。`round-history.js` 现在把原生拒绝当成版本不支持。补丁就绪后，同样的拒绝只表示这次操作不合法。`body-editor.js` 的独立副本预检继续保留，用来避免 Chat 已改、Session 没写下。

走 assistant replacement 的入口，补丁装上后沿用现有事务，不另写会话引擎：

| 入口 | 文件 |
| --- | --- |
| 正文编辑 | `domain/body-editor.js` |
| 回退与重新生成 | `domain/round-history.js` |
| 重新生成恢复 | `domain/regeneration-recovery.js` |
| 前台正文替换 | `lib/index.js` 的 `replaceAssistantReply` |
| 后台 Surface rewind | `domain/background-surface.js` |
| 模板历史里的 assistant 替换 | `domain/template-history.js` |

user replacement 不靠这条补丁，单独在 `0.1.5-rc.2` 上回归：`rollback-surface.js`、`session-stable-prefix.js`、`import-context-preparation.js`、`foreground-frame-retirement.js`。

### 2. 旧档迁移单独做

补丁不把旧日志变成 `0.1.5-rc.2` 能读的档。官方迁移仍会拒绝两类已有存档：

- V0 扩展字段，例如 `source.fixedSystemText`。
- V2 在第一个 step 之前写入的 surface 事件。开场上下文会撞上「step 之前的 surface 不能取得 system 头」。

升级前备份不能代替迁移。未验证的路径要拒绝并保留原文件，不能改 header 版本、插入旧序号，或在失败时截断。已有「Chat 已发布编辑、Session 拒绝写入」的测试分叉不自动修复。

用户更新到本版并重启后，`apply` 在打开任何对话之前自动跑迁移。宿主是 `0.1.5-rc.2` 就执行，补丁没装上也执行。目录用已经解析到的宿主包，不另猜安装位置。会话句柄已经打开时不改文件，留到下次启动。已经能打开的档原样跳过，失败的档保留原文件。

### 3. 版本声明与安装门槛

只有第 1 点在临时 Profile 上完成编辑、回退、重新生成和重启读回之后，才把 `config/dsh-compatibility.json` 的 `adaptedDshVersion` 改为 `0.1.5-rc.2`，`recommendedDesktopVersion` 改为实际验收的 Desktop 版本。不要从 DSH 版本推断 Desktop 或 DSHA 版本。

同时改这些会把不适配说成适配的位置：`bin/dsh-compatibility.mjs`、`domain/host-compatibility.js`，以及安装文档里的 Desktop 与 DSHA 版本。Desktop 用实际验收的 `2.0.13`。DSHA 用发布说明写明内置 DSH `0.1.5-rc.2` 的 `v0.1.5-rc2`，不从核心版本自行推断。

### 4. 客户端包与回归

改 `src/client/main.js` 后要重新生成 `lib/client.js`。回归用临时 npm `0.1.5-rc.2`，不用 Desktop 安装目录里的包。旧测试里的 `start/end`、无 stream 的 assistant、顶层 `request.system` 要和真实功能失败分开；不能为了全量通过把正文替换失败改成跳过。

## 先不做

- 不改官方 Desktop、DSHA 和 npm 包文件。
- 不把 assistant 伪装成 user 消息。
- 不做自动去标记或降级转换。停用补丁后，补丁存档必须重启，不能交给原版读写。
- 不在这一轮承诺 Android。

## 顺序

补丁接入与三个写操作的临时 Profile 验收 → 旧档迁移方案 → 版本声明。第一步失败就保持 `0.1.2-rc.1`。
