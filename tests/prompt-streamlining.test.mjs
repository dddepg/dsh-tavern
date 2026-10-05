import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const serverSource = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')

const cardToolsSource = await readFile(new URL('../tavern-plugin/lib/tools/card-editing.js', import.meta.url), 'utf8')
const turnLifecycleSource = await readFile(new URL('../tavern-plugin/lib/hooks/turn-lifecycle.js', import.meta.url), 'utf8')

function between(source, start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert.notEqual(from, -1, `missing start marker: ${start}`)
  assert.notEqual(to, -1, `missing end marker: ${end}`)
  return source.slice(from, to)
}

test('原版恢复工具只操作当前人物卡并要求固定确认文本', () => {
  const restoreTool = between(cardToolsSource, "name: 'tavern_restore_card'", "output:")

  assert.match(restoreTool, /confirmation:/)
  assert.match(restoreTool, /enum: \['确认从原版恢复'\]/)
  assert.doesNotMatch(restoreTool, /path:/)
  assert.match(cardToolsSource, /restoreCurrentCard\(sessionId\)/)
  assert.match(cardToolsSource, /turnOrchestrator\.discard/)
})

// 本地修复（截断正文不算提交）回归：上游 18c2a3e8 精简掉了本用例所在的旧文件内容，
// 这里按 v2.3 源码结构重新落一条最小断言。v2.4 同步后上游把前台回合钩子抽到
// hooks/turn-lifecycle.js，断言随之改锚到该模块；v2.5 上游 177c03f3 把本文件瘦身到
// 只剩原版恢复一例，护栏单独保留。
test('前台正文被截断时按失败尾部处理，不提交本轮', () => {
  const lifecycle = between(serverSource, '// ---------- DSH 回合生命周期 ----------', '// ---------- 模型可选工具 ----------')
  assert.match(lifecycle, /registerTurnLifecycleHooks\(\{/)

  const stopping = between(turnLifecycleSource, "ctx.on('agent/turn-stopping'", "ctx.on('agent/error'")

  assert.match(stopping, /await turnOrchestrator\.assertCompleteReply\(\{/)
  assert.match(stopping, /streamFinishKind\(/)
  // 判定必须早于 finalize：一旦提交就再也拿不回失败尾部。
  assert.ok(stopping.indexOf('assertCompleteReply(') < stopping.indexOf('foregroundHandoff.finalize('),
    '截断判定必须发生在提交之前')
})
