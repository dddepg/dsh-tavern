import assert from 'node:assert/strict'
import test from 'node:test'
import { updateSceneDraft, assembleSceneDraft, readImageToolArguments, imageToolCall } from '../tavern-plugin/lib/domain/scene-plan-draft.js'

test('字段错误指出完整路径和实际类型，不改变已有草稿', () => {
  const draft = { characters: {}, layout: null }
  assert.throws(() => updateSceneDraft(draft, 'submit_scene_character', { id: 'a', fields: { clothing: { text: '外套', tags: [] } } }), /fields.clothing.tags.*string.*array/)
  assert.deepEqual(draft, { characters: {}, layout: null })
  assert.throws(() => assembleSceneDraft(draft), /submit_scene_layout/)
})

test('按调用 id 取回 DSH 原始参数，不读取上次调用或历史任务', () => {
  const events = [{ type: 'tool/call', data: { callId: 'old', name: 'submit_scene_character', arguments: 'bad' } },
    { type: 'tool/call', data: { callId: 'now', name: 'submit_scene_character', arguments: '{"id":' } }]
  const call = imageToolCall('submit_scene_character', {}, { callId: 'now' }, events, 1)
  assert.throws(() => readImageToolArguments(call), /JSON 语法错误/)
  assert.equal(imageToolCall('submit_scene_character', {}, { callId: 'old' }, events, 1).rawArguments, undefined)
})
test('已解析参数、JSON 字符串和错误根类型严格区分，不静默修复', () => {
  assert.deepEqual(readImageToolArguments({ arguments: '{"id":"a"}' }), { id: 'a' })
  assert.throws(() => readImageToolArguments({ arguments: [] }), /参数内容错误.*object.*array/)
  assert.throws(() => updateSceneDraft({}, 'submit_scene_plan', { plan: {} }), /未知字段.*plan/)
})
