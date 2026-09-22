# 开局准备页切换保留（2026-09-18）

问题：游戏准备页把“暂时离开”和“放弃开局”混在同一条清理路径中。`openPicker` / `closePicker` 清空草稿，模式切换和侧栏折叠卸载 iframe；开始游戏时 `busy` 也会卸载预览。卡内尚未提交的表单、DOM 和 JavaScript 状态随之消失。

现在同一页面保留一份开局准备：收起、切换工作台、折叠侧栏以及开局失败均保留原 iframe；“继续开局”恢复它。切换当前对话的请求模式不再重建已有开局草稿。导入记录预览期间隐藏原界面。只有确认“放弃开局”或完成游玩会话创建才清理；创建卡片工作台会话不清除暂存开局。

保留期间每分钟续期私有草稿，窗口重新获得焦点时补一次；续期不读取完整运行时或重置页面。主动放弃和开局完成会释放草稿，页面卸载停止续期，失联草稿仍按原来的两小时期限过期。

范围：页面内切换。没有增加刷新页面、关闭浏览器、服务重启后的恢复，也不序列化第三方脚本的任意 JavaScript 内存。显式更换开场或玩家称呼仍遵循原来的预览更新语义。

## 验证

- `node --test tests/opening-retention.test.mjs tests/opening-picker-loading.test.mjs tests/opening-preparation.test.mjs tests/confirm-dialog.test.mjs tests/extract-flow.test.mjs`：116 项通过。
- 真实 Chromium + React + 生产侧栏和 iframe：10 项检查通过，覆盖输入、勾选、脚本变量、iframe/文档实例身份、收起、工作台往返、折叠/展开、创建失败、取消/确认放弃、草稿释放和不重复初始化。
- 同一浏览器用例加载修复前 `b6ccf1b6` 客户端，稳定失败于 `close keeps original iframe, form and script state`。
- 全套执行时 2715 项：2704 通过、6 跳过、5 失败；五项均在独立的 `b6ccf1b6` 基线上复现，涉及 card-agent-autonomy、prompt-streamlining、system-prompt-render（两项）、tavern-settings。之后补充的两个创建完成边界用例另行通过。
- 客户端生成一致性与 `git diff --check` 通过。

浏览器复现：

```sh
DSH_BROWSER_ROOT=/path/to/installed/dsh node tests/fixtures/opening-retention-browser-smoke.mjs
playwright-cli -s=opening-retention open <printed-local-url>
playwright-cli -s=opening-retention eval 'async () => await window.verifyOpeningRetention()'
```

设置 `DSH_CLIENT_SOURCE` 可以加载修复前的客户端。测试仅使用本地合成卡和模拟宿主响应，不读取玩家资料、不调用模型；开始游戏故意返回错误，以验证失败后保留表单。

## 前后端更新衔接补充

运行中的旧 Host 不会随客户端文件重建自动加载新增 RPC。实测旧 Host 对 `retainOpeningPreparation` 返回“未知方法”，但已有 `getOpeningPreparation` 正常识别。

续期改用已有 `getOpeningPreparation`，附带 `touchOnly: true`。新 Host 仅更新时间戳并返回轻量结果；旧 Host 忽略附加参数，沿用读取时续期。客户端不把返回数据写回页面，避免覆盖表单和脚本状态。这样更新页面无需为续期接口重启 Host；已加载的旧页面需重新加载客户端后使用修复。
