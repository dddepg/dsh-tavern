import assert from 'node:assert/strict'
import test from 'node:test'
import { setFailedErrorVisibility } from '../tavern-plugin/lib/domain/failed-error-visibility.js'

const events = [
  { type: 'turn/end', data: { turn: 8, reason: { kind: 'error' } } },
  { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } },
  { type: 'turn/end', data: { turn: 10, reason: { kind: 'aborted' } } }
]

test('连续操作保留其他轮次的隐藏选择，重复请求幂等', () => {
  const chat = { hiddenDshErrorTurns: [3] }
  const once = setFailedErrorVisibility(chat, events, 8, true)
  assert.deepEqual(once.hiddenDshErrorTurns, [3, 8])
  assert.deepEqual(setFailedErrorVisibility(once, events, 8, true), once)
  assert.deepEqual(setFailedErrorVisibility(once, events, 8, false).hiddenDshErrorTurns, [3])
})

test('批量隐藏与恢复按失败轮去重计数，不改变剧情或其他隐藏记录', async () => {
  const { setAllFailedErrorVisibility } = await import('../tavern-plugin/lib/domain/failed-error-visibility.js')
  const chat = { hiddenDshErrorTurns: [3], messages: [{ text: '正文' }], timeline: { revision: 9 }, suppressedDshTurns: [4] }
  const input = [...events, events[0], { type: 'turn/end', data: { turn: 12, reason: { kind: 'error' } } }]
  const result = setAllFailedErrorVisibility(chat, input, true)
  assert.equal(result.changedCount, 2)
  assert.deepEqual(result.chat.hiddenDshErrorTurns, [3, 8, 12])
  assert.equal(result.chat.messages, chat.messages)
  assert.equal(result.chat.timeline, chat.timeline)
  assert.equal(result.chat.suppressedDshTurns, chat.suppressedDshTurns)
  assert.equal(setAllFailedErrorVisibility(result.chat, input, true).changedCount, 0)
  const restored = setAllFailedErrorVisibility(result.chat, input, false)
  assert.equal(restored.changedCount, 2)
  assert.deepEqual(restored.chat.hiddenDshErrorTurns, [3])
  assert.deepEqual(chat.hiddenDshErrorTurns, [3])
  assert.throws(() => setAllFailedErrorVisibility(chat, input, 'true'))
})
