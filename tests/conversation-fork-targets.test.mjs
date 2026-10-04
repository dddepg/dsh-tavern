import assert from 'node:assert/strict'
import test from 'node:test'
import { forkTurnsByMessageId } from '../tavern-plugin/lib/domain/conversation-fork-targets.js'

const start = (seq, turn) => ({ type: 'turn/start', seq, data: { turn } })
const end = (seq, turn, kind = 'completed') => ({ type: 'turn/end', seq, data: { turn, reason: { kind } } })
const reply = (seq, turn, id, kind = 'model') => ({ type: 'assistant/message', seq, data: { turn, message: { id, source: { kind } } } })
const session = events => ({ events })

test('每个已完成轮次指向最后显示的那条回复（含轮次结束后写入的回复投影）', () => {
  const events = [start(1, 1), reply(2, 1, 'opening'), end(3, 1),
    start(4, 2), reply(5, 2, 'raw-2'), end(6, 2), reply(7, 2, 'projection-2')]
  assert.deepEqual(forkTurnsByMessageId(session(events)), { opening: 1, 'projection-2': 2 })
})

test('失败或未完成的轮次没有分叉目标，之后的轮次照常', () => {
  const events = [start(1, 1), reply(2, 1, 'a'), end(3, 1),
    start(4, 2), end(5, 2, 'error'),
    start(6, 3), reply(7, 3, 'c'), end(8, 3),
    start(9, 4), reply(10, 4, 'running')]
  assert.deepEqual(forkTurnsByMessageId(session(events)), { a: 1, c: 3 })
})

test('重新生成的轮次映射回剧情轮次，被替换的原回复不再作为目标', () => {
  const events = [start(1, 1), reply(2, 1, 'a'), end(3, 1),
    start(4, 2), reply(5, 2, 'old-2'), end(6, 2),
    start(7, 3), reply(8, 3, 'regen-2'), end(9, 3)]
  assert.deepEqual(forkTurnsByMessageId(session(events), { 2: 3 }), { a: 1, 'regen-2': 2 })
})

test('插件消息和缺少会话时不产生目标', () => {
  assert.deepEqual(forkTurnsByMessageId(session([start(1, 1), reply(2, 1, 'note', 'plugin'), end(3, 1)])), {})
  assert.deepEqual(forkTurnsByMessageId(undefined), {})
})
