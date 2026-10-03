import assert from 'node:assert/strict'
import test from 'node:test'

import { projectAgentMessageText } from '../tavern-plugin/lib/domain/runtime-content-projection.js'

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
