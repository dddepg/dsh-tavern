import assert from 'node:assert/strict'
import test from 'node:test'
import { readImageToolArguments, imageToolCall } from '../tavern-plugin/lib/domain/scene-plan-draft.js'

test('按调用 id 取回 DSH 原始参数，不读取上次调用或历史任务', () => {
  const events = [{ type: 'tool/call', data: { callId: 'old', name: 'submit_scene_character', arguments: 'bad' } },
    { type: 'tool/call', data: { callId: 'now', name: 'submit_scene_character', arguments: '{"id":' } }]
  const call = imageToolCall('submit_scene_character', {}, { callId: 'now' }, events, 1)
  assert.throws(() => readImageToolArguments(call), /JSON 语法错误/)
  assert.equal(imageToolCall('submit_scene_character', {}, { callId: 'old' }, events, 1).rawArguments, undefined)
})
