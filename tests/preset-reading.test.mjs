import assert from 'node:assert/strict'
import test from 'node:test'

import { inspectPreset } from '../tavern-plugin/lib/domain/preset-reading.js'

test('按 SillyTavern prompt_order 还原条目顺序和启用状态', () => {
  const result = inspectPreset(JSON.stringify({
    temperature: 1.1,
    prompts: [
      { identifier: 'main', name: '主提示词', role: 'system', content: '保持角色一致。', enabled: false, forbid_overrides: true },
      { identifier: 'charDescription', name: 'Persona Description', role: 'user', marker: true, content: '' },
      { identifier: 'extra', name: '未编排条目', role: 'assistant', content: '补充内容', enabled: true }
    ],
    prompt_order: [{
      character_id: 100001,
      order: [
        { identifier: 'charDescription', enabled: true },
        { identifier: 'main', enabled: true }
      ]
    }]
  }), '测试预设.json')

  assert.equal(result.valid, true)
  assert.equal(result.recognized, true)
  assert.equal(result.title, '测试预设')
  assert.equal(result.promptCount, 3)
  assert.equal(result.enabledCount, 3)
  assert.deepEqual(result.entries.map(function (entry) { return entry.identifier }), ['charDescription', 'main', 'extra'])
  assert.equal(result.entries[0].marker, true)
  assert.equal(result.entries[0].enabled, true)
  assert.equal(result.entries[1].enabled, true)
  assert.equal(result.entries[1].forbidOverrides, true)
  assert.equal(result.entries[2].ordered, false)
  assert.deepEqual(result.entries[1].edit, {
    promptPath: '/prompts/0',
    enabledPaths: ['/prompts/0/enabled', '/prompt_order/0/order/1/enabled']
  })
  assert.deepEqual(result.entries[2].edit, {
    promptPath: '/prompts/2',
    enabledPaths: ['/prompts/2/enabled']
  })
})
