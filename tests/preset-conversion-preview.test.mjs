import assert from 'node:assert/strict'
import test from 'node:test'

import { previewPresetConversion } from '../tavern-plugin/lib/domain/preset-conversion-preview.js'

test('按 prompt_order 把全部条目转换为前中后三段，保留开关并忽略 DSH 原生材料 marker 与顶层参数', () => {
  const result = previewPresetConversion(JSON.stringify({
    temperature: 1.1,
    prompts: [
      { identifier: 'front', name: '前置规则', role: 'system', content: '规则' },
      { identifier: 'charDescription', name: '角色描述', role: 'system', marker: true, content: '' },
      { identifier: 'depth', name: '近端提醒', role: 'user', content: '提醒', injection_position: 1, injection_depth: 2, injection_order: 7 },
      { identifier: 'chatHistory', name: '历史', marker: true, content: '' },
      { identifier: 'tail', name: '后置要求', role: 'assistant', content: '开头' },
      { identifier: 'off', name: '关闭项', role: 'system', content: '关闭' },
      { identifier: 'orphan', name: '未编排', content: '孤立' }
    ],
    prompt_order: [{
      character_id: 100001,
      order: [
        { identifier: 'front', enabled: true },
        { identifier: 'charDescription', enabled: true },
        { identifier: 'depth', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'tail', enabled: true },
        { identifier: 'off', enabled: false }
      ]
    }]
  }), '样例.json')

  assert.equal(result.status, 'ready')
  assert.deepEqual(result.phases.front.map(function (entry) { return entry.entryKey }), ['front#1'])
  assert.deepEqual(result.phases.middle.map(function (entry) { return entry.entryKey }), ['depth#1'])
  assert.deepEqual(result.phases.back.map(function (entry) { return entry.entryKey }), ['tail#1', 'off#1'])
  assert.equal(result.phases.middle[0].role, 'user')
  assert.equal(result.phases.back[0].role, 'assistant')
  assert.equal(result.dshPreset.schema, 'dsh.preset.draft/v1')
  assert.deepEqual(result.dshPreset.front.map(function (entry) { return entry.id }), ['front#1'])
  assert.deepEqual(result.dshPreset.middle.map(function (entry) { return entry.id }), ['depth#1'])
  assert.deepEqual(result.dshPreset.back.map(function (entry) { return entry.id }), ['tail#1', 'off#1'])
  assert.equal(result.dshPreset.back[1].enabled, false)
  assert.deepEqual(result.excluded.nativeMaterials.map(function (entry) { return entry.entryKey }), ['charDescription#1'])
  assert.equal(result.summary.nativeMaterialRows, 1)
  assert.deepEqual(result.dshPreset.middle[0].source, {
    identifier: 'depth',
    sourcePromptIndex: 2,
    marker: false,
    injectionPosition: 1,
    injectionDepth: 2,
    injectionOrder: 7
  })
  assert.equal(result.sourceRows[3].type, 'history')
  assert.equal(result.excluded.unordered[0].entryKey, 'orphan#1')
  assert.deepEqual(result.unconverted.prompts.map(function (entry) { return entry.entryKey }), ['orphan#1'])
  assert.equal(result.unconverted.rootConfiguration, undefined)
  assert.ok(result.diagnostics.some(function (item) { return item.code === 'TAVERN_DEPTH_COLLAPSED' }))
  assert.ok(!result.diagnostics.some(function (item) { return item.code === 'ROOT_CONFIGURATION_NOT_APPLIED' }))
  assert.ok(result.diagnostics.some(function (item) { return item.code === 'NATIVE_MATERIAL_MARKERS_IGNORED' }))
})
