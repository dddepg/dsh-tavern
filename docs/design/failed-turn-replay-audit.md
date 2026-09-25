# 失败尾部重放（WIP）× 上游 v2.1 × 实例升级记录

> 2026-09-22 · 基线：本地 `8731c6cd`(v1.9.0) → 上游 `3d86bf6a`(v2.1.0) · 实例 `/home/ezio/workspace/dsh-tavern-cli`
> 本文取代此前的《failed-turn-replay-vs-upstream-2.0.md》（v2.0 结论：上游未实现该能力、前提未被推翻——在 v2.1 上依然成立）。

## 0. 一句话结论

v2.1 已装进实例并在跑；WIP 已合到 v2.1 基线（`742349a3`），WIP 自带用例在 v2.1 fixture 上**全部通过**；唯一失败的 2 个用例属于**上游自己**，在纯上游 v2.1 上同样复现，与本次合并无关。

## 1. 实例升级结果

| 项 | 结果 |
|---|---|
| 应用版本 | `2.1.0` |
| 独立 DSH 运行时 | `0.1.5-rc.2`（`runtime/lib/node_modules/@deepseek-ai/dsh`） |
| 适配版本 | `adaptedDshVersion = 0.1.5-rc.2`（`config/dsh-compatibility.json`） |
| profile 记录 | `profiles/tavern/package.json` → `dshTavern.dshVersion = 0.1.5-rc.2` |
| 旧会话迁移 | 日志：`旧档迁移完成：已准备 24，未改 0，保留原文件 0` |
| 用户数据 | `resources/cards` 1 · `chats` 10 · `refs` 10 · `exports` 10（完好） |
| 服务 | PID 4444，`http://127.0.0.1:3091/?token=…` |
| 网页鉴权 | 带 token 303 → cookie jar 跟随 200(29583B) → 无 token 401 ✅ |
| 备份 | `backups/pre-v2.1-20260922-115307.tar.gz`（149M，含 apps/数据/profiles/refs） |

### 会话补丁握手（v2.1 新机制，决定重生成/回退是否放开）

`node tools/tavern-api.mjs getSessionPatchStatus` →

```json
{ "protocol": 1, "status": "ready", "ready": false,
  "serverReady": true, "clientReady": false,
  "hostVersion": "0.1.5-rc.2",
  "reason": "页面尚未完成会话补丁握手，请刷新后再试" }
```

服务端补丁已在 0.1.5-rc.2 上加载成功；`clientReady` 需要浏览器打开页面完成握手后才为 `true`，届时 `ready` 才放开正文替换/重新生成/回退。

## 2. 升级踩到的三个坑（可复用）

1. **无 TTY 下 pnpm 拒绝清空 node_modules**：`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`。
   → 解法：`pnpm_config_confirm_modules_purge=false`，或先手动删掉待重建的 `node_modules`（我是先删 `profiles/tavern/node_modules`）。
2. **不要用 `CI=true` 绕上一条**：pnpm 在 CI 下默认 `--frozen-lockfile`。v2.1 更新了 `patches/dsh-better-sidebar@0.17.1.patch`（新 sha256 `a25ab402…`，旧 lockfile 记 `7a52a0f2…`）→ `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`。
   该错误在 profile 事务里抛出会走 `catch { runtime?.rollback() }`，**把刚装好的 0.1.5-rc.2 回滚成 0.1.2-rc.1**——表现为「装完还是旧运行时」，很容易误判。
3. **安装器收尾的自动启动用默认端口 3081**，而本机 DSH 运行时占着 3081 → `端口 3081 已被其他进程占用，拒绝启动`。用实例根启动器（`DSH_TAVERN_PORT=3091`）启动即可，不影响安装结果。

## 3. WIP 合到 v2.1

- 冲突仍是 **2 个**：`tavern-plugin/lib/client.js`（生成物 → `node bin/build-tavern-client.mjs` 重建，之后 `--check` 通过）、`tests/round-history.test.mjs`（两边同位置各追加测试，纯叠加；注意 HEAD 侧最后一个用例的收尾 `})` 落在冲突区**共同后缀**里，取并集要给两侧各补一个）。
- 其余 7 个源文件 + 4 个测试文件**自动合并**。
- v2.1 新增门控 `sessionPatch.replacementAllowed()` 出现在 `regenerate` / `regenBody` / `rollbackTurn` / `rollbackChat` 四个入口；合并后 4 处门控与 `replayFailedTurn` 共存，导出 `replayFailed` 正常。
- WIP 在 v2.1 上的净增：15 文件 +512/−23（与 v2.0 时期一致）。

## 4. 测试矩阵（`node --test`，依赖借用升级后的实例）

| 测试文件 | v2.1 + WIP | 纯上游 v2.1 |
|---|---|---|
| `round-history` | **74 / 0** | — |
| `rollback-action` | 10 / 0 | — |
| `rollback-surface` | 18 / 0 | — |
| `rollback-turn-projection` | **18 / 2** | **16 / 2**（同样 2 个失败） |
| `turn-error-controls` | 8 / 0 | — |
| `extract-flow` | 85 / 0 | — |

失败的 2 个用例是上游的《中断残留正文随回退消失，重载后不复现》（main / alpha 各一），报错：

```
Error: assistant/message embeds its source stream and cannot carry sourceEventSeqs
  at assertProvenance (@deepseek-ai/dsh-session/lib/index.js)
```

即 0.1.5-rc.2 的 provenance 校验拒绝了「assistant/message + sourceEventSeqs 的 replace」。**纯上游 v2.1 同样复现**，说明与 WIP 无关；推测该用例绕过了 `host-session-patch`（补丁存在的意义正是放行这类 replacement provenance），建议向官方反馈。WIP 自己新增的 3 个重放用例 + 2 个投影用例全部通过。

## 5. WIP 已同步进实例（2026-09-22 11:58 UTC）

按运行时路径只同步 WIP 净改的 **7 个文件**（`git diff --name-only 3d86bf6a 742349a3 -- <RUNTIME_PATHS>`），逐文件 sha256 与仓库比对一致：

`tavern-plugin/` 下 `lib/client-assets/tavern.css`、`lib/client.js`、`lib/domain/rollback-surface.js`、`lib/domain/round-history.js`、`lib/index.js`、`src/client/main.js`、`src/client/turn-error-controls.js`

- 实例内 `node bin/build-tavern-client.mjs --check` → `已是最新`
- 备份回滚点：`backups/app-clean-v2.1-20260922-115810.tar.gz`（15M，干净 v2.1 程序文件）
- 重启：PID 5220，端口 3091；网页鉴权 303 / 200 / 401 全通过

### 实机验证（对运行中的服务）

| 验证项 | 结果 |
|---|---|
| `getSession` 视图字段 | 返回 `canReplayFailedTurn: false`、`replayFailedTurn: null`、`canRegenerate: true` ✅ 字段已上线 |
| 浏览器实际拿到的 bundle `/plugins/??dsh-tavern-plugin/client.js&rev=…` | HTTP 200，1,064,607 B；`重新生成本轮`×5、`dsh-tavern-error-replay`×4、`canReplayFailedTurn`×2、`replayTurn`×8、`移除被中断的回复`×2 ✅ 前端 UI 已生效 |
| `getSessionPatchStatus` | `serverReady: true` / `clientReady: false`（等浏览器打开页面握手） |

### ⚠️ 发现一个设计差异（建议跟进）

同一状态下：

- `regenBody`（老动作）→ `页面尚未完成会话补丁握手，请刷新后再试` ← 被 `sessionPatch.replacementAllowed()` 拦住（设计如此）
- `replayTurn`（WIP 新动作）→ `无法访问 DSH 会话: …` ← **没有补丁门控**，直接越过握手检查走到了会话查找（因页面未打开、DSH 会话尚未加载而失败）

即 v2.1 把 `regenerate`/`regenBody`/`rollbackTurn`/`rollbackChat` 四个入口都加了门控，而 WIP 新增的 `replayFailedTurn` 不在其中。实际风险不高（前端只在 `canReplayFailedTurn` 为真时给按钮，而页面打开后才可能触发），但建议二选一：给 `replayFailedTurn` 加同样的门控，或在设计文档里写明它为什么豁免（它走 append 新回合 + `clearFailedTurnSurface`，不是 replacement）。

## 6. 仍未验证

1. **前端握手**：需在浏览器打开 token 地址，之后 `getSessionPatchStatus.ready` 才应变为 `true`。
2. **失败尾重放的实机闭环**：需要真机触发一次失败回合（例如生成中途报错/手动停止）再点「重新生成本轮」，确认 `clearFailedTurnSurface` 在 0.1.5-rc.2 + 补丁下正常、请求前缀与失败前一致。
3. 上游 `rollback-turn-projection` 的 2 个用例问题（见第 4 节）尚未向官方反馈。

## 7. 实机 bug 与修复：重放后玩家输入消失（2026-09-22）

### 症状

点「重新生成本轮」后：① 之前发出去的文字被「清除」；② 生成的正文不自动渲染。

### 取证（后端其实是对的）

会话事件（`session.v3.jsonl.zstd`，多帧 zstd，需按帧魔数切分解压）：

```
seq 698 turn/start 62  → 702 user/message src=user len79 → 708 turn/end 62 reason=error
seq 709 user/message src=dsh-tavern-failed-turn-cleanup op=replace refs=702,704
seq 711 turn/start 63  → 714 user/message src=plugin/dsh-tavern-replay len79
seq 718 assistant/message turn63 len2370 → 720 turn/end 63 completed
```

chat 日志同样正常：`r686 src=replay.failed-turn`（写 suppressedDshTurns）、`r689 src=foreground.commit`（`splice:messages` + `nativeCommits.63`）、`r691-696` 正常后台结算。

用 headless Chromium（`playwright-core` + 缓存里的 `chromium-1234`）读真实 DOM：

```
60  context(none) turn-error(none) turn-tail(none) user(none)
61  assistant-step(-, 3259) context turn-process turn-tail          ← 无 user 行
62  context(none)×2 turn-error(none) turn-tail(none) user(none)
63  assistant-step(-, 3363) context turn-process turn-tail          ← 无 user 行
64  ... user(-, 49)      65  ... user(-, 88)
```

→ 重放的**正文渲染了**，但**输入行永远不出现**：user 行从 62 直接跳到 64。

### 根因（宿主源码）

`@deepseek-ai/dsh-client-ui-chat/lib/client.js` 的 `messageDefinition.start`：

```js
if (event.data.source.kind !== "user") return { kind: "context", ... }  // 非 user 来源 → 上下文节点
return ... { kind: "user", ... }                                        // 只有真用户消息才是输入行
```

WIP 用 `{ kind:'plugin', plugin:'dsh-tavern-replay' }` 重发 → 被归类为 context 节点 → 输入行不存在；失败轮次的输入又被 `suppressedDshTurns` 隐藏 → 玩家文字彻底消失，界面只剩一段「没有输入」的正文。

### 修复

1. `tavern-plugin/lib/domain/rollback-surface.js`：`replayableFailedTurn()` 现在一并返回 `source`，由新增 `replayInputSource()` 生成 `{ kind:'user' }`（沿用原 `rpcId` / `clientTimeZone`，保持请求身份与 provider 前缀复用连续）；`isTurnInputSource` 保留 plugin 分支只为识别历史日志里已写入的旧格式。
2. `tavern-plugin/lib/domain/round-history.js`：followup 用 `target.source`；入口补 `sessionPatch.replacementAllowed()` 门控（与 v2.1 其余四个入口一致，重放同样改动消息面）。
3. 测试：更新 2 处断言；新增「插件来源输入也必须以用户身份重发」「补丁未握手时拒绝重放」两个用例。

### 结果

`round-history` 75/0、`rollback-surface` 18/0、`rollback-action` 10/0、`turn-error-controls` 8/0、`extract-flow` 85/0（`rollback-turn-projection` 的 2 个失败仍是上游自身问题）。两个修复文件已同步进实例并重启。

### 遗留

- turn 61 / 63 这两次历史重放的输入行仍缺失（事件已按旧方案落库）；新的重放不再出现。
- 控制台长期存在 `Minified React error #130`（`slot entry crashed in 'conversation.chat.node'`），在未被本次改动影响的会话上同样出现、正文仍能渲染，与本 bug 无因果关系，但建议单独排查。

## 8. 实机 bug 与修复：截断正文被当成完成回合（2026-09-25）

### 症状

一轮正文在中途断开（截图：`……当着自己的面，一个不到`），界面却给了正常的轮末操作（生成候选项 / 重新生成正文 / 更多），并照常显示「变量已更新 · 2 项」。按设计应当走失败尾部：本轮不提交、不接受结算、提供「重新生成本轮」。

### 取证（三层日志一致，说明是供应商静默截断）

会话 `session-d0689d7f`（`chat-mu7nrv2m-bcvuff`），turn 85：

```
seq 1014 assistant/message turn85 len739  text…'当着自己的面，一个不到'
    usage {inputTokens:16003, outputTokens:2052}
    stream 末条 chunk: {"type":"finish","reason":{"kind":"stop"},
      "replayState":{…,"stopReason":"stop"}}      ← 供应商自称正常结束
seq 1016 turn/end turn85 reason {"kind":"completed"}  ← DSH 只能照记完成
```

`profile-data/tavern/data/model-requests/chat-mu7nrv2m-bcvuff/muflfe6p-….result.json` 同样记录 `status: completed`、`finish: {"kind":"stop"}`、`text` 长度 739——不是 DSH 或插件截断，而是渠道（new-api / gemini-3.8-flash）把断流报成了 `stop`。

同一会话里另有两次同样被记成 `completed` 的断流：turn 74（`…启开温润的唇缝`，out 477）、turn 75（`…右手悬`，out 176）。

### 判定依据（27 份会话、146 条模型正文结尾统计）

结尾字符分布：`。`97、`”`31、`*`7、`？`2、`.`/`…`/`！`各 1，其余 6 条不是句末字符——其中 3 条是人物卡开场白（turn 1，无玩家输入，走不到提交路径），3 条正是上述断流。因此「结尾不是可收尾字符」在本语料上没有误报。

### 修复

1. 新增 `tavern-plugin/lib/domain/reply-completeness.js`：`streamFinishKind()` 取 `finish` 分片原因，`incompleteReplyTail()` 判定结尾（结尾是文字/数字/逗号/冒号/开引号算截断；句末标点、右引号、右括号、强调符、破折号、表情符号算写完），`truncatedForegroundReply()` 合并两者（`max-tokens` 直接判截断；`stop` 才看结尾；工具调用与未知原因不判）。
2. `tavern-plugin/lib/index.js` 的 `agent/turn-stopping`：在 `foregroundHandoff.finalize()` **之前**判定，游玩模式命中就 `recordFailure({code:'truncated-response'})` 并抛错。DSH 随之把该回合记为 `turn/end reason=error`，正常走失败清理与重放路径（不写 `chat.messages`、不排队结算）。
3. `tavern-plugin/lib/domain/foreground-handoff.js`：只有 `completed` 启动后台结算；`max-tokens` 与 `error`/`aborted` 一样按失败尾部丢弃。
4. `tavern-plugin/lib/domain/rollback-surface.js`：新增 `isFailedTurnReason()`，`pendingFailedSurfaceTurns` / `unclearedFailedTail` / `replayableFailedTurn` 三处统一认 `error` / `aborted` / `max-tokens`。

### 测试

新增 `tests/reply-completeness.test.mjs`（结尾判定、finish 提取、三种结束原因）；`rollback-surface` 增「截断尾部提供重放」「失败原因判定」；`foreground-handoff` 增「max-tokens 按失败尾部清理、不启动结算」；`prompt-streamlining` 增「截断判定必须早于 finalize」的接线断言。

### 顺带修掉的上游失效用例

`tests/prompt-streamlining.test.mjs` 的「读取 Session View 不启动后台工作」仍按 `async function sessionView` 取区间，而上游 `ad18e4a6` 已把 `sessionView` 收敛成 `createSessionViewReader` 的同步委托（上游自己的用例也没跟上；该文件不在 CI 子集里）。断言区间改为 `const sessionViews = createSessionViewReader({` 起，检查意图不变。

## 9. 同步上游与回归证据（2026-09-25）

### 同步结果

`git fetch upstream` 后把 `upstream/main`（`aae3b904`，领先 107 个提交）并入本地 `main`：**无冲突**（failing-turn-replay 那批改动上游已作为 PR #85 收录），`node bin/build-tavern-client.mjs --check` 报「已是最新」。合并提交 `583b79c4`，截断修复提交在其上。

### 全量测试（`node bin/test-tavern.mjs`，借用实例 0.1.5-rc.2 运行时）

```
tests 3141 · pass 3081 · fail 44
```

44 个失败分两类，**都与本次修复无关**：

1. **浏览器缺失（环境）**：`upstream-template-runtime.mjs` 强依赖 playwright 1.58.2 对应的 `chromium_headless_shell-1208`，本机缓存只有 `-1234`（browser-bot 用的 1.62.1）。`npx playwright install chromium` 在本机下载完成后卡在解压（两次复现），因此 `worldbook-*`、`full-template-*`、`frame-*`、`opening-document-replacement`、`status-viewer-browser`、`dynamic-constant-worldbook`、`chat-history-import-service` 等约 15 个文件失败。
2. **上游测试漂移（上游自身）**：15 个失败在合并提交 `583b79c4` 上**逐一复现**（用 worktree 跑同样 7 个文件对比，失败集合一致）：`extract-flow`（5，index.js/client.js 源码标记被上游重构）、`settlement-restart-recovery`（4）、`dsh-version-policy`（2）、`dsh-compatibility`（1）、`superseded-turn-errors`（1）、`workspace-instruction-presentation`（1）、`foreground-frame-retirement`（1，`sessionStateForSession is not defined`）。这些文件都不在 CI 子集里。

同批修掉两个直接阻塞：
- `tests/prompt-streamlining.test.mjs` 的 Session View 用例区间标记（`async function sessionView` → `const sessionViews = createSessionViewReader({`）。
- `tests/fixtures/upstream-template-runtime.mjs` 在浏览器缺失时泄漏监听中的 HTTP server，导致整个 `node --test` 永不退出。

### 本机 playwright 缓存须知

`playwright install` 会按 `.links` 记录回收「未登记的浏览器目录」。本机 `chromium-1234` / `chromium_headless_shell-1234` 属于 browser-bot 的 playwright-core 1.62.1，未被 1.58.2 的 `.links` 登记，一次 `npx playwright install` 就会把它们删掉（本次已复现并按 1.62.1 重新装回）。跨版本安装请加 `PLAYWRIGHT_SKIP_BROWSER_GC=1`。

### 实例部署

实例 `apps/dsh-tavern` 停在合并前的 `cb9c9fec` 文件集，因此**只把本次修复的 5 个文件按同一语义补丁打进实例**（新增 `reply-completeness.js`；`index.js` / `turn-orchestration.js` / `foreground-handoff.js` / `rollback-surface.js` 局部替换，逐处锚点唯一），备份在 `backups/truncation-fix-2026-09-25T00-51-24`。上游 107 个提交没有一并打进实例（依赖、补丁与数据迁移需要在安装器流程里做）。重启后 `getSessionPatchStatus` 正常，`getSession` 视图字段正常。
