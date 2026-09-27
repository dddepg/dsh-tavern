# 卡片模式 Mnemon 集成原型

分支：`codex/card-memory-mnemon`。此文记录实现与验证范围，不是全平台发布认证。

## 范围

- 仅卡片模式保存用户明确表达的长期改卡偏好、错误与修复经验。
- 游玩、后台结算、候选和图片 Agent 不获得记忆工具，不读取或注入这些记忆。
- 用户不安装 CLI、数据库、embedding 模型或后台服务，不增加 API Key。
- 用户可在侧栏 `+ → 改卡记忆` 查看、检索、修改偏好和经验；偏好可移除，经验可归档。也可在卡片对话中要求 Agent 管理记忆。
- 归档的经验保留在本地，不再参与检索；归档不是物理擦除。
- 自动记录 `tavern_validate_card` 的失败，同一张卡相同错误去重。校验成功不自动推断整个修复已实测成功。
- 其他工具或浏览器错误由 Agent 根据证据记录，不承诺自动捕获所有错误。偏好抽取与经验判断仍依赖当前模型。

## 依赖与边界

固定使用 `dsh-mnemon@0.5.15`、`dsh-mnemon-source-runtime@0.5.9`、`dsh-mnemon-source-documents@0.5.6`。

酒馆的 `dsh-tavern-card-memory` 包通过公开 Source factory 与 `manage` 契约调用 Runtime / Documents。没有挂载 Mnemon 默认 bundle、全局会话钩子、额外 UI、Providers 或后台模型整理。依赖包内仍会带上上游根包声明的其他插件代码，但不会激活或调用；不复制、修改上游源码。

标准包声明固定版本的 npm 依赖，不使用本地 file/link 依赖。DSH 标准安装只把 Profile 的直接依赖加入 bundle 列表；Mnemon 是酒馆的传递依赖，不会自动启用。传统酒馆 Profile 也继续使用明确的 bundle 列表，不加入 Mnemon。内部适配模块随酒馆分发。

记忆保存于现有 Tavern 数据目录的 `card-memory/`，不会写进导出的人物卡：

- `preferences/`：当前 Tavern 数据目录内的改卡偏好。
- `scopes/<卡片路径 hash>/`：特定卡片的经验。
- `scopes/shared/`：明确标为通用的经验。
- 无绑定卡片的工作台以 Chat ID 隔离经验；之后绑定卡片或重命名卡片不会自动迁移旧经验。这是原型限制。

Documents 指定同一个 dataDir 时并不按 workspaceId 分离文件。因此每个范围使用独立 Source 实例与独立 dataDir，不能仅改变 workspaceId。

写操作串行执行。Source 自身负责文件写入与持久化。Runtime 偏好默认容量为 4096 字节；达到上游容量限制时工具返回错误，不静默声称保存成功。经验默认每个范围 10 MiB。

## 请求与缓存

卡片模式工具集合固定；每轮首次模型调用在当前用户输入之后追加有来源标识的记忆消息。历史消息、system、旧工具结果不重写。偏好是当前完整列表，经验是限定范围的检索结果；自动检索正文预算为约 6000 字符，加固定使用说明。

读写均再次检查 `chat.mode === 'card'`，不依赖模型自律或前端隐藏按钮实现隔离。自动检索/校验记录失败不会阻止原改卡流程；管理操作会报告失败。

## 已执行验证（2026-09-26）

- macOS：真实已发布 Source 包，无 mock 存储，5 项领域验收通过；相关启动、工具隔离、打包和 Android 安装回归共 103 项全部通过（补跑真实 DSH 组合项）。
- 标准 npm tarball：在独立目录安装打包产物后，5 项记忆验收全部通过，不依赖源码目录的链接。
- 干净独立目录：`npm install --omit=dev --ignore-scripts --legacy-peer-deps` 安装成功；26 个依赖包，无 `.node/.so/.dll/.dylib` 文件；相同 5 项验收通过。
- 真实 DSH `0.1.5-rc.2` + Chromium + 固定模型：游玩请求无记忆工具/消息；卡片模型真实调用工具保存偏好；刷新后下一轮读取；实际请求 system、tools 与既有消息前缀完全一致。
- 桌面和 390px 窄屏：管理入口与偏好显示通过，无面板横向溢出。窄屏浏览器不等于 Android WebView 验收。
- Android：MuMu 中已安装的酒馆 APK 容器，Node `24.19.0`、`linux arm64`；同一份 Source 代码与依赖包，在独立 `/tmp` 目录通过全部 5 项领域验收。没有替换 APK 内正式酒馆或用户数据。覆盖中文路径、偏好持久化、跨卡隔离、错误去重、游玩拒绝访问、追加上下文。

Android 结果保存于本次开发环境的 `output/mnemon-android-result.txt`；真实 DSH 验收输出在 `output/e2e-gameplay/`。

## 仍需满足的发布门槛

- Windows / Linux：新增 CI 矩阵覆盖 Node 22.19 与 24，但本地创建工作流不代表远端已运行。
- Android：完成完整插件加载、真实卡片回合、WebView 管理界面、进程重启和升级恢复验证；MuMu 存储通过不能代替真机全链路验证。
- 各发行方式：Windows 安装包、macOS/Linux CLI、Desktop Profile、Android APK/DSHA 都要验证新依赖随安装和更新到位。
- 模型质量：固定模型只验证工具与请求链路；仍需检查真实模型对长期偏好、一次性要求、错误证据的区分。

上述门槛未通过前，不宣称全平台开箱即用已经完成，也不将此分支合入正式发行。

## 复验

```sh
npm run test:card-memory
node --test tests/plugin-startup.test.mjs tests/turn-orchestration.test.mjs tests/foreground-orchestration-strategies.test.mjs
npm run test:e2e:card-memory
```

参考：[Mnemon](https://github.com/omdsh-dev/dsh-mnemon)、[Source 契约](https://github.com/omdsh-dev/dsh-mnemon/blob/main/src/core/contracts/view.ts)。
