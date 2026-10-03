import assert from 'node:assert/strict'
import test from 'node:test'

import { createForegroundFrameBuilder } from '../tavern-plugin/lib/domain/agent-input-frame.js'
import { createForegroundFrameSessionAdapter } from '../tavern-plugin/lib/domain/foreground-frame-session-adapter.js'

function builder() {
  return createForegroundFrameBuilder()
}

function frame(instructions) {
  return builder().build({
    chatId: 'chat-1', branchId: 'branch-1', basedOnRevision: 3, operationId: 'operation-1', turn: 4,
    inputs: [{ kind: 'foreground.user-input', sourceText: '原始输入', projectedText: '投影输入' }].concat(instructions),
    source: { cardRevision: 'card-hash' }
  })
}

test('Session Adapter 只在 step 1 追加一次 ForegroundFrame', () => {
  const value = frame([{ kind: 'foreground.writing-rules', text: '本轮规则' }])
  const adapter = createForegroundFrameSessionAdapter({ id: () => 'message-frame-1' })
  const first = adapter.append({ messages: [], frame: value, step: 1 })
  const duplicate = adapter.append({ messages: first.messages, frame: value, step: 1 })
  const laterStep = adapter.append({ messages: first.messages, frame: value, step: 2 })

  assert.equal(first.receipt.appended, true)
  assert.equal(first.messages[0].source.form, 'foreground-frame')
  assert.equal(first.messages[0].source.trace.frameId, value.frameId)
  assert.equal(duplicate.receipt.reason, 'duplicate')
  assert.equal(duplicate.messages, first.messages)
  assert.equal(laterStep.receipt.reason, 'not-first-step')
})
