# 插件内 Session 补丁实验

日期：2026-09-22。分支：`experiment/plugin-session-patch`。
基线：`e9f01d46`，宿主发布包：`0.1.6-alpha.2`。

## 第二阶段结论（扩大补丁后）

**已打通隔离实验中的编辑、持久化、重启、模型请求和回退后重生成链路。宿主安装文件未修改。** 下面第一阶段的失败结论仅针对最小 Surface 补丁。

第二阶段在官方模块已经加载后安装内存补丁，覆盖 Session Surface、存储事件校验、V3 编解码、JSONL/Zstd 后端、服务器 SessionQuery 和客户端历史读取。克隆模块的导入经过定向重绑定；Session、服务和公开错误类型保留原有身份。服务器补丁在打开存档及查询缓存建立前安装；尚未实现正常 Tavern 启动集成或客户端资源装载。

| 已执行验证 | 结果 |
| --- | --- |
| 实际 `createBodyEditor.read/save`，Chat 文件保存、变量保留 | 通过 |
| 原生 JSONL 后端，无压缩与 Zstd，独立进程重新读取 | 通过 |
| 原生 Agent 在新进程恢复，下一次请求包含编辑正文、不包含旧正文 | 通过 |
| 生产 `locateRollbackSurface` + `replaceSessionSurface` 回退后重新调用原生 Agent | 通过；重新生成请求的 role/content 与被回退请求完全一致 |
| 再次回退，第三个进程恢复 | 通过 |
| SessionQuery 的 live/cold `readSession`、`readSurface`、`observeSession`、`listEvents` | 通过 |
| 客户端发布包既有 stream 的 `readPage` / `follow`，VM 模拟传输 | 通过 |
| 缺少来源覆盖、失效范围、覆盖 system 首节点、append 携带来源 | 继续拒绝 |
| 宿主公开存储错误的 instanceof 身份 | 保持 |
| 被读取的八份官方源文件逐字节比较 | 全部未改动 |

模型使用脚本化 LlmAdapter；Agent、Session、查询和存储服务是真实官方实现。Chat 存储是小型测试替身。**未验收完整回退事务、MVU/后台 Agent 协调、压缩、旧存档迁移 worker、实际 HTTP 模型服务、Desktop/DSHA UI 与升级。** 回退保留原 provider，因此扩大补丁允许该进程所有 provider 的 assistant replacement 携带来源，不能宣称仅影响 Tavern 消息。

### 存档保护与维护代价

第一次 assistant replacement 前追加必需事件 `dsh-tavern/required-session-patch-v1`。如果没有这条记录，原版读取器可能把修改当损坏尾部而丢弃。实验确认未加载补丁的独立进程以读/写方式打开存档都会拒绝，且文件字节未改变。无压缩报未知必需事件，Zstd 报完整帧含破损 JSONL，后者尚无友好提示。

用过补丁的存档必须继续加载补丁；不是官方格式兼容方案。首次无效替换也可能先留下必需标记，尚未优化这一保守行为。卸载内存补丁只还原方法，不会还原已经写出的存档。补丁固定 `0.1.6-alpha.2` 并检查修改锚点唯一；报告记录源文件 SHA256，但未实现完整包版本/哈希准入。未来宿主升级必须重新验证。

第二阶段代码：`expanded-session-patch.mjs`、`expanded-session-probe.mjs`、`expanded-agent-probe.mjs`；[固定实验记录](../../scripts/experiments/expanded-session-result.json)。未接入生产、未修改兼容版本声明、未发布。

### 第二阶段复现

先按下文第一阶段命令创建临时 runtime，再安装以下依赖（所有宿主包保持相同版本）：

```sh
npm install --prefix "$experiment_runtime" --ignore-scripts --no-audit --no-fund --save-exact \
  @deepseek-ai/dsh-session-persistence-jsonl@0.1.6-alpha.2 \
  @deepseek-ai/dsh-agent-loop@0.1.6-alpha.2 \
  @deepseek-ai/dsh-system-prompt@0.1.6-alpha.2 \
  @deepseek-ai/dsh-tools@0.1.6-alpha.2 \
  @deepseek-ai/dsh-app-boot@0.1.6-alpha.2 \
  @deepseek-ai/dsh-token-meter@0.1.6-alpha.2 \
  @deepseek-ai/dsh-session-query@0.1.6-alpha.2 marked@16.3.0
# 仅在隔离 worktree 缺少 marked 时提供依赖；不要覆盖已有目录。
mkdir -p node_modules
test -e node_modules/marked || ln -s "$experiment_runtime/node_modules/marked" node_modules/marked
node scripts/experiments/expanded-session-probe.mjs "$experiment_runtime"
EXPERIMENT_COMPRESSION=zstd node scripts/experiments/expanded-session-probe.mjs "$experiment_runtime"
node scripts/experiments/expanded-agent-probe.mjs "$experiment_runtime"
```

已在 Node 22.22.0 上执行。三个命令退出码均为 0；报告写在各自临时目录。测试不连接用户 Profile、不发送模型网络请求。

## 第一阶段：问题与结论

能否只在 Tavern 插件进程内打补丁，复用官方 DSH Desktop / DSHA，保留助手正文编辑、回退和重生成，而不修改宿主安装文件？

**本次最小补丁没有打通完整链路。** 能绕过实时 Session 的冲突校验，并正确派生修改后的助手正文；同进程的 detached Session 恢复也成功。但官方 JSONL 编码、严格解码、客户端历史读取和独立 Surface 折叠各自保留校验，仍然拒绝同一条记录。不能把内存成功或 `Session.fromRestore()` 成功当成存档兼容。

这证明“只 patch Session Surface 两个方法”不足以解决问题，不证明所有插件级方案都不可能。继续扩大到存储格式解释、客户端和离线读取器，已经超出一处小补丁的维护范围。本实验没有把该方法接入 Tavern 正常启动，也没有调整兼容版本声明。

## 实验方式

- 独立 Git worktree，不携带主工作区的未提交修改。
- 官方 npm 包安装在临时目录，不加载用户 Profile 或存档，不修改 Desktop、DSHA 或 npm 包文件。
- 读取官方 `surface.js`，仅在内存中编译一处条件修改：允许实验 provider 的 assistant replacement 携带来源引用。
- 把该模块的 `validateNext` 和 `_processDelta` 暂时挂到实时 Session 实际使用的 SurfaceManager 原型，结束后恢复。发布包主入口内嵌自己的类，直接修改 `/surface` 子路径导出的类不会影响实时 Session。
- 保留助手角色和原始历史事件，不把正文伪装成 user 消息；范围覆盖、来源校验和 system 首节点保护继续生效。
- 客户端实验在 VM 中执行**未修改的发布版 `client.js`**，调用真实 `SessionEventStream.readPage()`。只替换传输基类和返回固定历史页的远程调用，不替换任何校验函数。
- 对照组的官方 JSONL 编码、磁盘读写、严格恢复及客户端读取均通过，排除测试夹具本身不合法。

## 结果

| 路径 | 结果 |
| --- | --- |
| 原版 assistant replace，带来源 | 拒绝：`cannot carry sourceEventSeqs` |
| 原版 assistant replace，不带来源 | 拒绝：`must include every shadowed surface node` |
| 内存补丁后编辑正文 | 成功；模型历史末条为新正文，角色仍为 assistant |
| 内存补丁后 detached Session 恢复 | 成功；派生消息一致 |
| 内存补丁后还原旧正文，再替换为固定新正文 | 成功；未修改此前 system/user 消息 |
| 官方 JSONL 持久化 | 编码即拒绝 assistant 来源字段，未写出该存档 |
| 绕过编码准入，仅探测原版严格解码器 | 仍拒绝同一字段 |
| 官方客户端历史页读取 | 拒绝同一字段 |
| 官方独立 `foldSurface()` | 拒绝同一字段 |
| 无关 provider、缺少来源覆盖、覆盖 system 首节点 | 继续拒绝，未放开这些保护 |

“回退”和“新正文”仅指 Session 内容序列实验。没有执行 Tavern 回退事务、MVU 结算、实际重新调用模型、Desktop/DSHA UI 或真实 HTTP 模型请求。存储和客户端已在更早环节失败，不能据此宣称任何产品功能完成适配。

## 新消息投影接口

另测 `SessionMessageProjection`：

1. 自定义 `tavern-experiment/body-edit` 事件在 live Session 中能修改助手正文。
2. 官方 JSONL 可编码该未知事件，但严格恢复拒绝 `unknown event type`。错误里的 `format v2` 来自 V3 复用的旧格式校验器；测试 header 确为 V3。
3. 把这个必需编辑事件标成 `ignorable: true` 后，官方存档可恢复；加载解释器读到新正文，未加载解释器则读到旧正文。

第 3 项只是用克隆事件探测格式行为，**没有实现插件的事件写入途径**。它证明把编辑标为可忽略会让同一存档产生不同模型历史，不能视为原生回放等价。若选择这条路线，还要处理事件写入、所有恢复入口、压缩/请求重建及未加载插件时的失败保护；本实验不采用它作为修复。

## 复现

从本实验 worktree 运行。安装目标必须是新建临时目录：

```sh
experiment_runtime=$(mktemp -d /tmp/tavern-session-patch-runtime.XXXXXX)
npm install --prefix "$experiment_runtime" --ignore-scripts --no-audit --no-fund --save-exact \
  @deepseek-ai/dsh-session@0.1.6-alpha.2 \
  @deepseek-ai/dsh-session-format-catalog@0.1.6-alpha.2 \
  @deepseek-ai/dsh-client-connection@0.1.6-alpha.2 \
  @deepseek-ai/dsh-api-session-controller@0.1.6-alpha.2
node scripts/experiments/session-patch.mjs "$experiment_runtime"
```

脚本固定 Session 版本并检查待替换代码只出现一次。输出每条实验的 accepted/rejected，最终打印临时证据目录中的 `report.json`。退出码 0 表示观察结果符合断言，**不表示兼容成功**。固定记录见 [实验结果](../../scripts/experiments/session-patch-result.json)。

## 第一阶段后续边界（第二阶段已继续研究）

暂不合并、不发布、不修改安装器、不升级用户运行时。原问题尚未解决。若继续研究，应明确选择是否接受多处运行时拦截，或由插件负责完整的持久消息解释；不能以吞掉异常、删除来源字段或把必需编辑静默忽略来宣称支持。

官方源文件：

- [Surface 校验与折叠](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.2/packages/core/session/src/surface.ts)
- [V3 编码](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.2/packages/session/session-format-v2-to-v3/src/codec.ts)
- [插件拥有消息投影](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.2/.agents/notes/implemented/architecture/2026-09-11-plugin-owned-message-projections.zh.md)
