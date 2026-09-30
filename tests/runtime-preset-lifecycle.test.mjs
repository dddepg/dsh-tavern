import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isRuntimePresetBoundaryMessage,
  projectRuntimePresetRequest,
  projectRuntimePresetRequestMessages,
  runtimePresetPhaseMessages
} from '../tavern-plugin/lib/domain/runtime-preset-lifecycle.js'

function phaseMessage(phase, text) {
  return runtimePresetPhaseMessages({ [phase]: { entries: [{ role: 'system', content: text }] } }, phase, { scope: 'foreground', turn: 4, step: 1 })[0]
}

test('最终请求把前后投影到 messages 绝对边界，并清除旧 Session 残留', () => {
  const snapshot = {
    front: { entries: [
      { role: 'system', content: '新前一' },
      { role: 'user', content: '新前二' }
    ] },
    back: { entries: [
      { role: 'assistant', content: '新后一' },
      { role: 'system', content: '新后二' }
    ] }
  }
  const messages = [
    phaseMessage('front', '旧前'),
    { role: 'system', content: [{ type: 'text', text: 'DSH 系统上下文' }] },
    { role: 'assistant', content: [{ type: 'text', text: '历史正文' }] },
    phaseMessage('middle', '中段'),
    { role: 'user', content: [{ type: 'text', text: '本轮输入' }] },
    phaseMessage('back', '旧后')
  ]
  const projected = projectRuntimePresetRequestMessages(messages, snapshot, { scope: 'foreground', turn: 5, step: 1 })
  const text = projected.map(function (message) { return message.content[0].text })
  assert.deepEqual(text, ['新前一', '新前二', 'DSH 系统上下文', '历史正文', '中段', '本轮输入', '新后一', '新后二'])
  assert.deepEqual(projected.map(function (message) { return message.role }), [
    'system', 'user', 'system', 'assistant', 'system', 'user', 'assistant', 'system'
  ])
  assert.equal(projected.slice(0, 2).every(isRuntimePresetBoundaryMessage), true)
  assert.equal(projected.slice(-2).every(isRuntimePresetBoundaryMessage), true)
  assert.equal(projected.slice(2, -2).some(isRuntimePresetBoundaryMessage), false)
})

for (const phase of ['front', 'back']) test(`V3 native system remains system with ${phase} preset`, () => {
  const nativeSystem = { id: 'native-system', role: 'system', content: [{ type: 'text', text: '固定人物背景' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } }
  const request = { messages: [
    { role: 'user', content: [{ type: 'text', text: '开场种子' }] },
    { role: 'assistant', content: [{ type: 'text', text: '开场白' }] },
    nativeSystem,
    { role: 'user', content: [{ type: 'text', text: '继续' }] }
  ] }
  const before = structuredClone(request)
  const projected = projectRuntimePresetRequest(request, { [phase]: { entries: [{ role: 'system', content: '预设要求' }] } })
  assert.equal(projected.messages[0].role, 'system')
  assert.ok(projected.messages[0].content.some(b => b.text.includes('固定人物背景')))
  assert.equal(projected.messages.filter(m => JSON.stringify(m.content).includes('固定人物背景')).length, 1)
  assert.equal(projected.messages.filter(m => m.role === 'system').length, 1)
  assert.deepEqual(request, before)
  assert.equal(projectRuntimePresetRequest(request, null), request)
})

test('角色归一化不合并或破坏 DSH 工具消息', () => {
  const toolCalls = [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }]
  const request = {
    system: 'DSH 系统',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: '准备调用' }], tool_calls: toolCalls },
      { role: 'assistant', content: [{ type: 'text', text: '普通补充' }] },
      { role: 'tool', tool_call_id: 'call-1', content: [{ type: 'text', text: '结果' }] },
      { role: 'system', content: [{ type: 'text', text: '中途约束' }] }
    ]
  }
  const projected = projectRuntimePresetRequest(request, {
    front: { entries: [{ role: 'user', content: '前段' }] },
    back: { entries: [] }
  })

  assert.deepEqual(projected.messages.map(function (message) { return message.role }), [
    'system', 'assistant', 'assistant', 'tool', 'user'
  ])
  assert.deepEqual(projected.messages[1].tool_calls, toolCalls)
  assert.equal(projected.messages[3].tool_call_id, 'call-1')
  assert.equal(request.messages[3].role, 'system')
})

for (const native of [false, true]) test(`附加指令在外部预设之前且只保留一份（${native ? 'V3 消息' : '顶层 system'}）`, () => {
  const instruction = '用户附加指令\n第二行'
  const system = instruction + '\n\n内置系统上下文'
  const nativeSystem = { role: 'system', content: [{ type: 'text', text: system }], source: {
    kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', sections: [
      { name: 'tavern:system-append', text: instruction }, { name: 'persona', text: '内置系统上下文' }
    ]
  } }
  const request = { ...(native ? {} : { system }), messages: [
    ...(native ? [nativeSystem] : []), { role: 'user', content: [{ type: 'text', text: '本轮输入' }] }
  ] }
  const before = structuredClone(request)
  const snapshot = { front: { entries: [{ role: 'system', content: '外部预设前段' }] }, back: { entries: [{ role: 'system', content: '外部预设后段' }] } }
  const result = projectRuntimePresetRequest(request, snapshot, { systemAppend: instruction })
  assert.deepEqual(result.messages.map(m => [m.role, m.content[0].text]), [
    ['system', instruction + '\n\n外部预设前段\n\n内置系统上下文'], ['user', '本轮输入\n\n外部预设后段']
  ])
  assert.equal(result.messages[0].source.sections[0].name, 'tavern:system-append')
  assert.equal(result.messages[0].source.sections.filter(s => s.name === 'tavern:system-append').length, 1)
  assert.deepEqual(request, before)
  assert.equal(projectRuntimePresetRequest(request, null, { systemAppend: instruction }), request)
})

test('关闭或未组装附加指令时不注入、不从历史中删除相同文字', () => {
  const request = { system: '内置系统', messages: [{ role: 'user', content: [{ type: 'text', text: '附加指令' }] }] }
  const snapshot = { front: { entries: [{ content: '外部预设' }] } }
  for (const systemAppend of ['', '附加指令']) {
    const result = projectRuntimePresetRequest(request, snapshot, { systemAppend })
    assert.equal(result.messages[0].content[0].text, '外部预设\n\n内置系统')
    assert.equal(result.messages[1].content[0].text, '附加指令')
  }
})
