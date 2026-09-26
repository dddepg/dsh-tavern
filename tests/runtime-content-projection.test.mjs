import assert from 'node:assert/strict'
import test from 'node:test'

import { preserveRuntimeSource, projectAgentContent, projectAgentMessageText } from '../tavern-plugin/lib/domain/runtime-content-projection.js'

test('进入 Agent 的聊天消息统一解析宏并且不修改权威宏状态', () => {
  const state = { userName: '陈锋', local: { stage: 1 }, global: {} }

  assert.equal(projectAgentMessageText({
    text: '陈锋已经进门。',
    sourceText: '{{user}}已经进门。'
  }, { charName: '阿芙拉', macroState: state }), '陈锋已经进门。')
  assert.equal(projectAgentMessageText({
    sourceText: '{{user}}遇见{{char}}；阶段{{incvar::stage}}。'
  }, { charName: '阿芙拉', macroState: state }), '陈锋遇见阿芙拉；阶段2。')
  assert.deepEqual(state, { userName: '陈锋', local: { stage: 1 }, global: {} })
})

test('游玩投影统一解析宏并把块级 HTML 与原生正文分段，且不修改传入的权威变量', () => {
  const state = { userName: '陈锋', local: { stage: 2 }, global: {} }
  const result = projectAgentContent(
    '当前阶段 {{getvar::stage || 1}}。\n<style>.panel{color:red}</style><div class="panel">阶段 {{.stage}}</div>',
    { charName: '命运', macroState: state }
  )

  assert.equal(result.agentText, '当前阶段 2。\n<style>.panel{color:red}</style><div class="panel">阶段 2</div>')
  assert.equal(result.displayText, result.agentText)
  assert.equal(result.displayMode, 'html')
  assert.deepEqual(result.displayParts, [
    { kind: 'markdown', text: '当前阶段 2。\n' },
    { kind: 'html', content: '<style>.panel{color:red}</style><div class="panel">阶段 2</div>' }
  ])
  assert.equal(result.presentationHtml, '')
  assert.deepEqual(result.macroState.local, { stage: 2 })
  assert.deepEqual(state, { userName: '陈锋', local: { stage: 2 }, global: {} })
})

test('卡片编辑与资料阅读使用源码投影，不执行宏也不拆 HTML', () => {
  const source = '{{incvar::stage}}<div>模板</div>'
  const result = preserveRuntimeSource(source, {
    charName: '命运',
    macroState: { userName: 'User', local: { stage: 1 }, global: {} }
  })

  assert.equal(result.agentText, source)
  assert.equal(result.displayText, source)
  assert.equal(result.presentationHtml, '')
  assert.deepEqual(result.macroState.local, { stage: 1 })
})
