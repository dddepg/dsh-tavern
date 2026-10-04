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

## 10. 同步上游 v2.3 与实例整体更新（2026-09-27）

### 同步结果

`git fetch upstream` 后把 `upstream/main`（`5ae0c1f5`，包版本 2.3.0，领先 205 个提交）并入本地 `main`，合并提交 `9633c985`。两处冲突：

- `tavern-plugin/lib/domain/rollback-surface.js`：上游把 `pendingFailedSurfaceTurns` / `unclearedFailedTail` 里的内联轮次区间换成共享的 `turnIntervals()` + `createSurfaceOwnership()`，但同时把失败原因判定退回 `['error','aborted']`，会把本地的截断语义丢掉。**按上游结构解决冲突**，并把 `turnIntervals()` 的 `failed` 判定改回 `isFailedTurnReason()`，`error` / `aborted` / `max-tokens` 三种失败尾部语义不变。
- `tests/prompt-streamlining.test.mjs`：上游 `18c2a3e8`（精简 20% 低价值用例）把本文件从 347 行砍到 64 行，本地新增的「截断判定早于 finalize」接线断言随之被删，且旧用例依赖的 `clientSource` / `initializationSource` 等常量已不在文件顶部。**取上游版本**，再按 v2.3 源码结构重写同一条最小断言（只依赖 `serverSource`）。

### 实例整体更新

这次不再逐文件打补丁（§9 的做法会漏掉依赖与补丁迁移），改用安装器全流程更新：

```sh
cd /home/ezio/workspace/dsh-tavern-cli
DSH_TAVERN_CLI_HOME=$PWD DSH_TAVERN_HOST=cli \
DSH_TAVERN_GIT_URL=/home/ezio/workspace/dsh-tavern \
sh /home/ezio/workspace/dsh-tavern/install.sh
```

`DSH_TAVERN_GIT_URL` 指向本地仓库，安装器照常走「git 增量同步 → `cp -R` 覆盖程序文件 → `pnpm install --frozen-lockfile` → `dsh-tavern install --host cli` → `start`」，所以实例拿到的是 **v2.3 + 本地截断修复**，而不是丢掉修复的上游主干。更新前备份 `backups/app-pre-20260927-175630.tar.gz`；`apps/dsh-tavern/.dsh-tavern-release.json` 记为 `9633c985`；新增依赖 `dsh-mnemon*`、`dsh-dream-skin`（link）已随锁文件装入。

注意：安装器若在 git 步骤失败会**静默回退 jsDelivr（即上游主干）**，所以改源更新后要确认实例里仍有 `tavern-plugin/lib/domain/reply-completeness.js` 且 `lib/index.js` 含 `assertCompleteReply`。

### 端口

安装器收尾的自动启动用默认 3081，而本机 DSH Desktop 会话里的 DSH Pocket 占着 `0.0.0.0:3081`，于是报 `端口 3081 已被其他进程占用，拒绝启动`（安装本身已成功）。按既有做法用实例启动器指定端口：

```sh
cd /home/ezio/workspace/dsh-tavern-cli && DSH_TAVERN_PORT=3091 dsh-tavern start
```

`resolveServicePort()` 只读环境变量 `DSH_TAVERN_PORT`，安装目录里没有持久化端口的字段，所以 `start` / `restart` 都要带上；不带就会重新去抢 3081 并失败。本次启动记录：PID 8257，`service.ready`，`http://127.0.0.1:3091/?token=…`。

### 实例运行与回归（2026-09-27）

服务已启动并核对：`logs/tavern.log` 有 `service.starting` / `service.spawned` / `service.ready`（PID 8257，端口 3091），`http://127.0.0.1:3091/` 无 token 返回 401、带 token 303 → 200 且页面为 DSH 外壳；实例内 `tavern-plugin/lib/domain/reply-completeness.js` 存在、`lib/index.js` 含 `assertCompleteReply`（确认没被 jsDelivr 回退覆盖）。

全量测试（`DSH_TAVERN_CLI_HOME=/home/ezio/workspace/dsh-tavern-cli node bin/test-tavern.mjs`，借用实例 0.1.5-rc.2 运行时与实例 `node_modules`）：

```
tests 2966 · pass 2903 · fail 44 · skipped 19
```

- 用例数从 3141 降到 2966，是上游 `18c2a3e8`（精简 20% 低价值用例）的结果。
- 44 个失败**全部**是浏览器缺失：`browserType.launch: Executable doesn't exist at ~/.cache/ms-playwright/chromium_headless_shell-1208/...`，命中 `worldbook-*`、`full-template-*`、`template-html-fence-boundaries`、`tavern-prompt-template-runtime`、`dynamic-constant-worldbook` 等 9 个文件（本机缓存只有 1.62.1 的 `-1234`）。
- §9 记录的上游漂移失败（`extract-flow`、`settlement-restart-recovery`、`dsh-version-policy`、`dsh-compatibility`、`superseded-turn-errors`、`workspace-instruction-presentation`、`foreground-frame-retirement`）在 v2.3 上已全部消失。
- 新暴露的 `tests/user-extensions.test.mjs`「实际 Unix 安装脚本更新程序两次」失败**不是本次合并引入**：在合并前的 `ef6ba4a4` 和纯净 `upstream/main`（`5ae0c1f5`）上逐一复现，原因属用例自身（mock `dsh --version` 无输出 → `dsh-compatibility.mjs --check` 抛「无法识别当前 DSH 版本」）。
- 与本地修复直接相关的 `rollback-surface`、`reply-completeness`、`foreground-handoff`、`turn-orchestration`、`prompt-streamlining`、`card-memory` 全部通过；本次合并没有引入断言级失败（日志中 `AssertionError` 为 0）。

## 11. 同步上游 v2.4 与实例整体更新（2026-09-28）

### 同步结果

`upstream/main` 从 `5ae0c1f5` 前进到 `9f5adaf8`（包版本 **2.4.0**，长会话存储重构，77 个提交，新增 tag `v2.4`），并入本地 `main`：**无冲突**，合并提交 `5318f6c9`。上一轮解决的两处冲突这次没有再出现：

- `rollback-surface.js` 的 `turnIntervals()` 仍用 `isFailedTurnReason()`（`error` / `aborted` / `max-tokens`），上游本轮没有再把判定退回 `['error','aborted']`；`isFailedTurnReason` 出现 3 处，本地截断语义保持。
- `tests/prompt-streamlining.test.mjs` 保持上游精简后的结构（64 行）+ 本地补回的最小断言，共 77 行；`assertCompleteReply` 仍排在 `foregroundHandoff.finalize()` 之前（`index.js:4539` 早于 `:4546`）。
- 上游 v2.4 仍然**没有**实现前台截断保护（`git grep isFailedTurnReason|assertCompleteReply|truncatedForegroundReply upstream/main -- tavern-plugin` 为空），所以本地这批修复继续是 fork 独有，更新时必须走本地源。

`node bin/build-tavern-client.mjs --check` 报「已是最新」；`rollback-surface` / `reply-completeness` / `foreground-handoff` / `prompt-streamlining` 四个文件 36 个用例先跑一遍全绿，再更新实例。

### 实例整体更新

沿用 §10 的做法（本地源 + 安装器全流程），备份 `backups/app-pre-20260928-213817.tar.gz`：

```sh
cd /home/ezio/workspace/dsh-tavern-cli
DSH_TAVERN_CLI_HOME=$PWD DSH_TAVERN_HOST=cli \
DSH_TAVERN_GIT_URL=/home/ezio/workspace/dsh-tavern \
sh /home/ezio/workspace/dsh-tavern/install.sh
```

日志确认走的是本地仓库（`From /home/ezio/workspace/dsh-tavern`，未回退 jsDelivr）；`apps/dsh-tavern/.dsh-tavern-release.json` 记为 `5318f6c9`；实例内 `reply-completeness.js` 存在、`rollback-surface.js` 含 3 处 `isFailedTurnReason`、`index.js` 含 `assertCompleteReply`。

### 端口与启动

安装器收尾仍因 DSH Pocket 占着 `0.0.0.0:3081`（本机 DSH 会话 pid 2411）而 `拒绝启动`，安装本身成功。按既有做法：

```sh
cd /home/ezio/workspace/dsh-tavern-cli && DSH_TAVERN_PORT=3091 dsh-tavern start
```

本次 PID 3172，`service.ready` @ 2026-09-28T13:39:13Z，`127.0.0.1:3091` 监听正常；无 token 401 / 带 token 303→200，`/api/dsh-tavern/runtime-generation` 返回 `{"ok":true,...}`。

### 回归（v2.4）

`DSH_TAVERN_CLI_HOME=/home/ezio/workspace/dsh-tavern-cli node bin/test-tavern.mjs`：

```
tests 3251 · pass 3183 · fail 46 · skipped 22
```

- 46 个失败中 45 个是浏览器缺失（`chromium_headless_shell-1208` 不存在），仍集中在 `worldbook-*`、`full-template-*`、`template-html-fence-boundaries`、`tavern-prompt-template-runtime`、`dynamic-constant-worldbook` 这 9 个文件；日志里 `AssertionError` 为 0，没有逻辑断言失败。
- 余下 1 个是 §10 已定性的 `tests/user-extensions.test.mjs`「实际 Unix 安装脚本更新程序两次」：本次在纯净 `upstream/main`（`9f5adaf8`）上再次复现（`4 pass / 1 fail`，同一个 `无法识别当前 DSH 版本`），确认与本地修复、本地源更新无关。
- 与本地截断修复直接相关的 4 个文件（`rollback-surface` / `reply-completeness` / `foreground-handoff` / `prompt-streamlining`）更新前后分别跑过，36 个用例全绿；实例内也已核对修复代码仍在位。

## 12. 同步上游 v2.4 后续（9f5adaf8 → 4034aff1）（2026-10-03）

### 同步结果

`upstream/main` 从 `9f5adaf8` 前进到 `4034aff1`：222 个提交，其中 169 个实质提交，其余是 `chore: publish runtime manifest [skip ci]` 自动发布；包版本仍是 2.4.0，最新 tag 仍是 `v2.4`。在分支 `sync/upstream-20261003` 上合并，合并提交 `4ee88002`（609 个文件，+23799 / −30761）。

三处冲突同源：上游把原先内联在 `lib/index.js` 的前台回合钩子抽成了 `hooks/turn-lifecycle.js`（生命周期钩子）与 `hooks/model-stream.js`（`llm/stream`、`importContextPreparation`、`fullTemplateRequests`、`installWorkspaceInstructionPresentation`、`installCompactionRequestProjection`），`lib/index.js` 由 5388 行降到 4160 行。

- `tavern-plugin/lib/index.js`：本地在这段里只有两处改动（`streamFinishKind` import、`assertCompleteReply` 调用），其余整段都是上游搬走的旧内联代码。**取上游版本**，把这两处移植进 `hooks/turn-lifecycle.js`（`assertCompleteReply` 在第 60 行，仍早于第 67 行的 `foregroundHandoff.finalize()`，修复语义不变）。
- `tests/turn-orchestration.test.mjs`（+7/−526）与 `tests/foreground-handoff.test.mjs`（0/−75）：上游 `5a354447`（精简 30% 低价值用例）删掉了这两个文件里的一批用例，本地新增的 3 条（`被截断的正文按失败回合处理`、`卡片工作台回复不参与正文截断判定`、`达到 token 上限的回合按失败尾部清理`）是本次修复的回归护栏。**取上游的精简与重排，只保留本地新增用例**。
- `tests/prompt-streamlining.test.mjs`：本地的源码结构断言锚在 `index.js`，上游搬走后 `missing start marker` 报错。改锚到 `hooks/turn-lifecycle.js`，`index.js` 侧只保留 `registerTurnLifecycleHooks` 接线检查（与 §10 同一种处理）。

`node bin/build-tavern-client.mjs --check` 报「已是最新」——`lib/client.js` 由自动合并正确产出，不需要重新生成。

### 全量测试

`DSH_TAVERN_CLI_HOME=/home/ezio/workspace/dsh-tavern-cli node bin/test-tavern.mjs`：

```
tests 2413 · pass 2339 · fail 51 · skipped 23
```

同一命令、同一运行时下，合并前的 `39e153f1` 为 `tests 3251 · pass 3181 · fail 48 · skipped 22`。用例数从 3251 降到 2413 是上游 `5a354447`（精简 30%）的结果，与 §10 / §11 的两次精简同源。

把 33 个失败文件逐一单独复跑归类后，51 个失败**没有一个是本次合并引入**：

- **48 个缺浏览器（环境）**：`chromium_headless_shell-1208` 不存在，命中 29 个文件。其中 `global-settings-browser` / `immersive-header` / `inline-fragment` / `opening-slash` / `session-resource-retention` 是上游本轮**新增**的浏览器用例，所以呈现为「合并前不失败、合并后新增失败」。本机缓存仍只有 1.62.1 的 `-1234` / `-1243`；本次照 §9 再试了一次 `playwright install chromium`，**同样卡在解压**（167.3 MiB 下载完成，解压停在 18 MiB），已删掉半成品目录把缓存恢复原状，`-1234` / `-1243` 未被回收。
- **1 个本机代理变量（环境）**：`tests/download.test.mjs` 的 `downloads honour proxy variables through NODE_USE_ENV_PROXY`（上游本轮新增文件）。本机 shell 常驻 Clash 代理（`http_proxy` / `HTTP_PROXY` / `all_proxy` 等 8 个大小写变量都指向 `127.0.0.1:7890`），该用例只覆盖大写 `HTTP_PROXY`，小写 `http_proxy` 仍然生效并抢走连接（`UND_ERR_SOCKET`）。`env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u no_proxy -u NO_PROXY` 清掉后该用例通过（`1 pass / 0 fail`），确认属环境而非代码。
- **1 个缺 DSH 运行时（环境）**：`tests/user-extensions.test.mjs` 的「实际 Unix 安装脚本更新程序两次」，即 §10 / §11 已定性的同一个 mock `dsh --version` 无输出问题。
- **1 个既有并发抖动**：`tests/mvu-incremental-settlement.test.mjs` 的 `append dispatch retains full fallback: old-client`（`AssertionError: dispatch must become ready`）。单独跑 7/7 全绿，只在全量并发下失败；**合并前的 `39e153f1` 全量跑同样出现 1 个 `AssertionError`**，与本次同步无关（§11 那次记录为 0，属该用例对并发时序敏感）。

反向变化：`server-template-runtime` / `status-bar-placement` / `worldbook-token-budget` 三个文件合并前失败、合并后通过（上游已修）。

与本地修复直接相关的 `rollback-surface` / `reply-completeness` / `foreground-handoff` / `turn-orchestration` / `prompt-streamlining` / `card-agent-preferences` 先跑一遍全绿（54 pass / 0 fail / 2 skipped）。

### 上游仍无前台截断保护

`git grep 'assertCompleteReply\|truncatedForegroundReply\|isFailedTurnReason' upstream/main -- tavern-plugin` 为空，与 §11 一致：本地这批修复继续是 fork 独有，更新实例时必须走本地源。

### 实例整体更新

注意修复落点在本轮发生了迁移：上一版实例里 `assertCompleteReply` 内联在 `lib/index.js`，同步后该写法在仓库中已不存在，改为落在 `lib/hooks/turn-lifecycle.js`，所以本次更新后要按新位置核对。

沿用 §10 / §11 的做法（本地源 + 安装器全流程）。更新前实例已停止（无 PID 文件、3080–3099 无监听，日志停在 2026-10-01T03:11 那次会话）。备份 `backups/app-pre-20261003-180254.tar.gz`（24M / 1336 条目）——注意 `tar` 要带 `--exclude=node_modules` 才与 `app-pre-20260928-213817` 等同口径（不带会打出 127M / 28332 条目）。

```sh
cd /home/ezio/workspace/dsh-tavern-cli
DSH_TAVERN_CLI_HOME=$PWD DSH_TAVERN_HOST=cli DSH_TAVERN_PORT=3091 \
DSH_TAVERN_GIT_URL=/home/ezio/workspace/dsh-tavern \
sh /home/ezio/workspace/dsh-tavern/install.sh
```

`DSH_TAVERN_PORT=3091` 这次也传给了安装器（§10 时期 3081 被 DSH Pocket 占着才需要手工补 `start`，本次 3081 已空闲，带上是为了不改变既有的访问地址）。日志确认走本地仓库（`From /home/ezio/workspace/dsh-tavern`，未回退 jsDelivr）；`apps/dsh-tavern/.dsh-tavern-release.json` 记为 `fefb6d543dd7669db1f01716fb8827c43748d45a`；安装器收尾自动启动成功（PID 74213）。

核对修复在新落点上：`tavern-plugin/lib/hooks/turn-lifecycle.js` 第 3 行 import `streamFinishKind`、第 60 行 `assertCompleteReply`、第 67 行 `foregroundHandoff.finalize`（判定仍早于提交）；`lib/domain/reply-completeness.js` 在位；`lib/index.js` 第 6 行 import、第 4044 行调用 `registerTurnLifecycleHooks`，旧的内联 `ctx.on('agent/turn-stopping'` 已为 0 处。

实例 `tavern-plugin/lib` 与仓库 `main` 的**内容差异为 0**（文件全部正确替换）。启动日志 `service.ready` @ 2026-10-03T10:03:17Z，端口 3091；无 token 401、带 token 303 → `/`；`/api/dsh-tavern/runtime-generation` 返回 `{"ok":true,...}`。本次启动的 `cwd` 也从上一次的开发仓库 `/home/ezio/workspace/dsh-tavern` 修正为 `apps/dsh-tavern`。

### 实例里未清理的旧文件（下一轮才会清）

实例相对仓库多出 312 个条目：310 个旧 webpack chunk 在 `lib/vendor/st-prompt-template/host-build/artifact/`（该目录仓库侧现在 113 个文件，实例 423 个），外加退役的 `src/client/ejs-code-editor.js`、`src/client/modules/{history-window,story-ledger,session-inventory}.js`、`lib/domain/{full-template-runtime,scene-image-settings}.js`、`packages/dsh-tavern-remote/` 各一个。

原因是上游本轮新增的 `bin/prune-installed-files.mjs` 按**清单**清理：它只删「上一份清单里记过、新版本不再发布」的文件，而这次是清单机制首次上线，实例里没有 `.dsh-tavern-files.txt`，所以按脚本注释「首次运行不删任何东西」处理，只写入了新清单（940 条）。下一轮更新会正常清理。

已确认这一轮残留无害：仓库需要的 113 个 artifact 文件在实例里**一个不缺**；`full-prompt-template-assets.js` 是 manifest + SHA-256 驱动（未列入 `manifest.files` 的名字直接返回 `undefined`，且校验 `upstreamCommit`），旧 chunk 不会被送出；4 个退役 `src/` 文件在当前源码中已无引用。

### 旧对话预设迁移告警：定性并修掉

启动恢复时报 2 条 `旧对话预设条目配置迁移失败 … 外部预设条目不可抽取：jb_accept#1`（`bypass-plans.js:191` ← `preset-library.js:153` ← `recoverRuntimeHistory`）。

**先定性**：不是本次同步引入。涉及的 `bypass-plans.js` / `preset-library.js` 在 `5318f6c9..fefb6d54` 区间无任何改动，且从备份里取出的更新前版本与更新后**哈希完全相同**；出错的两个会话创建于 2026-10-01T03:41 / 03:47，晚于上一次启动（03:11），这次是它们首次经历启动恢复。

**再定位**。用 `createNativeConversationStorage` 离线读真实状态（注意 `read()` 返回的是 `{chat, revision, native, …}` 包装，字段在 `.chat` 上），两个会话（`chat-muozlp3w-mz56y2`、`chat-muozu2ur-neboe0`，卡 `催眠小镇·佐藤家（原生沦陷版）`，各 1 / 3 条消息）的状态是自相矛盾的：

| 字段 | 值 |
| --- | --- |
| `runtimePresetPath` | `presets/Ny-Gemini-1.4.2_SogonSigon.json` |
| `snapshot.presetPath` | `presets/智脑-Z(3.78f特调).json` |
| `snapshot.sources`（29 条）、`regexSources`（11 条） | 全部来自 `智脑-Z(3.78f特调).json` |
| `bypassPlanId` | `""`（未迁移） |

`migrateLegacyChatPreset` 用 `runtimePresetPath` 当取条目来源、只把 `snapshot.presetPath` 当兜底（`preset-library.js:136`），于是拿 Ny-Gemini 去找智脑-Z 的条目。按 `extract()` 的判定复刻核对：**29 个条目键里 28 个在 Ny-Gemini 中缺失**、11 个正则键同样缺失，`jb_accept#1` 只是迭代到的第一个（`extract` 遇到首个坏键即抛）。根因是这局中途切过预设，`runtimePresetPath` 跟着变成 Ny-Gemini，而固化快照仍是智脑-Z 的——两者不再一致。

**修法**：把 `runtimePresetPath` 改回快照真正的来源，让状态自洽（不重建快照，因此不改变这个会话既有的注入内容）。改动前先离线验证目标预设可抽取性：按 `snapshot.presetPath`，29 个条目键与 11 个正则键**全部可抽取**；按原 `runtimePresetPath` 则 28 个条目、11 个正则均不可抽取。

```sh
cd /home/ezio/workspace/dsh-tavern-cli && DSH_TAVERN_PORT=3091 ./dsh-tavern stop
node scripts/repair-chat-preset-reference.mjs \
  /home/ezio/workspace/dsh-tavern-cli/profile-data/tavern/data \
  --apply chat-muozlp3w-mz56y2 chat-muozu2ur-neboe0
cd /home/ezio/workspace/dsh-tavern-cli && DSH_TAVERN_PORT=3091 ./dsh-tavern start
```

`scripts/repair-chat-preset-reference.mjs`（新增）默认只诊断，加 `--apply` 才写入；它走应用自己的 `native-conversation-storage.js` 的 `patch(id, revision, changes)`，只改两个字段（`runtimePresetPath` 设为快照来源，`_storageRevision` 加一以满足该路径的写校验），不碰消息与快照，并在写入前用 `bypass-plans.extract()` 的同款判定先证明目标预设可抽取。改前备份 `backups/chats-preset-fix-20261003-181030.tar.gz`（2.2M，两个会话的块存储）。

**结果**：重启后新增日志里迁移失败为 **0 条**；两个会话 `runtimePresetPath` 已置空、`bypassPlanId` 写成 `bypass-4413e9d86ffe`（两者预设路径与选中条目相同，走了迁移的去重逻辑共用同一计划），29 条快照与 1 / 3 条消息原样保留，计划已落 `data/bypass-plans.json`。服务 `service.ready` @ 2026-10-03T10:10:46Z（PID 76091，端口 3091），无 token 401、带 token 303。

脚本在改实例之前先在备份的临时副本上跑过一遍完整往返（干跑 → `--apply` → 复查报「已与快照一致」），确认诊断与写入两条路径都对，才动实例。

### 随后删除这两个会话

修好之后用户仍要求删掉它们，按应用自己的入口执行（不要手删目录，否则索引与 session 链接会留残）：

```
POST /api/dsh-tavern/prepareDeleteChats   {"chatIds":[…]}
POST /api/dsh-tavern/deleteChats          {"chatIds":[…]}
```

注意路由分两条：`/api/dsh-tavern/gameplay.<x>` 是**卡片测试 API**（`gameplay-api.js:12` 要求 sessionId 匹配 `^test-[a-f0-9-]{36}$`，对真实会话一律拒绝「需要测试 API 创建的独立会话」），界面用的是 `/api/dsh-tavern/<x>`。鉴权由宿主层负责（用 `/?token=…` 换 cookie，再带 cookie POST）。

`conversationRegistry.remove` 只清会话数据、索引行与 session→chat 链接；`model-requests/`、`worldbook-recalls/` 与 `model-request-sessions/` 下的关联记录**不删**（界面删除也是这个行为），本次残留约 1.15 M。迁移为它们建的 `bypass-4413e9d86ffe` 计划也随之变成孤儿，留在 `data/bypass-plans.json` 里，未清理。删除前备份 `backups/chats-delete-20261003-181722.tar.gz`（2.6M，含两个会话的块存储与上述日志）。

结果：`listSessions` 返回的会话数由 25 降到 23，列表里已无这两个 ID。

### 修复 opencode-go 网关 400 MissingSessionID（2026-10-03 晚）

实例默认模型是 `opencode-go` / `kimi-k3`（`settings.yaml` 的 `llm-pi-ai.providers.opencode-go` 只配 `apiKeyEnv: OPENCODE_GO_API_KEY`，provider 本体是 DSH 运行时 `@earendil-works/pi-ai` 的内置目录，网关 `https://opencode.ai/zen/go/v1`）。opencode 的 Go 中转要求请求带 `x-opencode-session`，DSH 发的请求没有，全部 400：`{"type":"MissingSessionID","message":"Request is missing x-opencode-session …"}`。

用 curl 对照坐实（同一最小请求，key 来自实例 `.credentials.yaml`）：不带头 → 400 MissingSessionID；带 `x-opencode-session` → 200 正常返回。

修复用社区插件 **`@gausszhou/dsh-opencode-session-id`**（0.1.1，[仓库](https://github.com/gausszhou/dsh-opencode-session-id)，[awesome-dsh-plugins](https://github.com/) 收录）：挂在 `llm/stream` waterfall，包装 fetch，对 host 后缀 `opencode.ai` 的请求注入 `x-opencode-session` 等四个头，默认 providers 就是 `[opencode, opencode-go]`，零配置。安装：

```sh
cd /home/ezio/workspace/dsh-tavern-cli
DSH_TAVERN_PORT=3091 ./dsh-tavern stop
PATH="$PWD/runtime/bin:$PATH" DSH_HOME=$PWD \
  ./runtime/bin/dsh plugin --profile tavern add "@gausszhou/dsh-opencode-session-id"
DSH_TAVERN_PORT=3091 ./dsh-tavern start
```

两个坑：

- **`dsh plugin` 用 PATH 上的 pnpm**。系统 pnpm 是 10.34.5（store v10），而实例 profile 由安装器用 pnpm 11.25.0（store v11，就在 `runtime/bin/pnpm`）装成，直接跑会报 `ERR_PNPM_UNEXPECTED_STORE`。必须把 `runtime/bin` 前置到 PATH。
- **`DSH_HOME` 必须指向实例目录**，否则插件会装进 legacy 的 `~/.dsh/profiles/tavern` 而不是实例 profile。

`dsh plugin add` 自动把声明了 `dsh.bundle` 的包追加到 profile `package.json` 的 `dsh.profile.bundles` 末位（纯库才会警告只装成普通依赖）。启动日志确认挂载：`[opencode-session-id] mounted: providers=[opencode, opencode-go] headers=[x-opencode-session, x-session-affinity, x-client-request-id, x-session-id] hosts=[opencode.ai]`，`service.ready` 无错误。

后续注意：实例更新（install.sh）重写 profile `package.json` 时只管理 `managedBundles`/`managedDependencies`，这个社区插件作为普通依赖应能保留，但更新后要复查 bundles 里仍在、启动日志仍有 mounted 行。插件可通过 profile 的 `cordis.patch.yml` 覆盖配置（providers/hosts/headers/verbose 等，见插件补丁文件头注释）。

顺带记一条上游隐患：会话中途切换预设会让 `runtimePresetPath` 与固化快照不一致，下一次启动的迁移就会失败——本例即此。上游仍未有对应处理。

## 14. 同步上游 4bbff696 与实例整体更新（2026-10-04）

### 同步结果

`upstream/main` 从 `4034aff1` 前进到 `4bbff696`：54 个提交，其中 38 个实质提交（新增两个分支 `feat/tavern-helper-api-compat`、`fix/upstream-execution-lifecycle`，未合入）。**本次合并零冲突**——上游改动不触及 fork 独有修复的落点。合并提交 `0ffeb3de`，分支 `sync/upstream-20261004`。

要点：`eb0e66a4` 修复不装 dsh-web-mobile 的宿主报 `ERR_PNPM_UNUSED_PATCH`（新增 `patches/dsh-web-mobile@2.3.0.patch` 配套跳过逻辑）；批量删卡列出游玩记录数、删卡询问是否一并删除游玩记录；正文/美化卡跟随字体大小设置；README 大改版。包版本仍为 2.4.0。

`node bin/build-tavern-client.mjs --check` 报「已是最新」。相关测试（`card-batch-deletion` / `pocket-opt-in` + fork 修复护栏 `rollback-surface` / `reply-completeness` / `foreground-handoff` / `turn-orchestration` / `prompt-streamlining`，借用实例运行时）：**56 pass / 0 fail**。`tests/inline-fragment.test.mjs` 本轮上游有改动但本机跑不了（缺 `chromium_headless_shell-1208`，环境限制同 §12），未验证。

### 实例整体更新

沿用既有做法（本地源 + 安装器全流程，`DSH_TAVERN_PORT=3091`），更新前实例已停止。备份 `backups/app-pre-20261004-182921.tar.gz`（24M，`--exclude=node_modules` 同口径）。日志确认走本地仓库（`From /home/ezio/workspace/dsh-tavern`，未回退 jsDelivr）；`apps/dsh-tavern/.dsh-tavern-release.json` 记为 `0ffeb3de…`；pnpm `Packages: +4`（dsh-web-mobile 2.3.0 相关）；安装器收尾自动启动成功。

核对：`tavern-plugin/lib/hooks/turn-lifecycle.js` 第 60 行 `assertCompleteReply` 在位（落点自 §12 起未再迁移）；`lib/domain/reply-completeness.js` 在位；`tavern-plugin/lib` 与仓库内容差异**仅剩旧文件残留**（见下）。社区插件 `opencode-session-id` 更新后仍在 profile bundles，启动日志 `mounted` 行正常（§13 末尾留的复查点）。

### prune 旧文件残留：清单机制清不掉，§13 预测不准确

§13 预测「下一轮更新会正常清理」的 312 个旧文件**仍在**：本轮 prune（install.sh:593）正常跑了，但没有东西可删。原因在脚本语义：`prune-installed-files.mjs` 只删「**上一份清单里记过**、新源码不再发布」的文件，而清单每轮重写为当前源码的文件集；这批残留早于清单机制、从未进过任何清单，所以**永远不会被该机制清理**。清单 `.dsh-tavern-files.txt` 现为 941 条，与源码一致。

残留无害性复查：仓库需要的 113 个 artifact 文件实例侧**一个不缺**（只多不少），`full-template-runtime.js` / `scene-image-settings.js` 两个退役 domain 文件在当前源码已无引用。若要清理需手工删除（或等上游 prune 改成「删除清单外多余文件」语义），本轮未动。

### 启动核对

`service.starting` → `service.spawned`（PID 2878，cwd 为实例 `apps/dsh-tavern`）→ `service.ready` @ 2026-10-04T10:29:54Z，端口 3091。无 token 401、带 token 303 → `/`；`/api/dsh-tavern/runtime-generation` 返回 `{"ok":true,...}`。本次启动日志无迁移失败、无 error/warn。
