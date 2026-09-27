import assert from 'node:assert/strict'
import test from 'node:test'

import { createPlayChatDebugReference, readPlayChatDebugTurn } from '../tavern-plugin/lib/domain/play-chat-debug.js'

function chats() {
  const source = {
    id: 'chat-play', mode: 'story', cardPath: 'cards/校园.json', cardName: '校园',
    sessionId: 'session-foreground', cardContextSnapshot: '人物卡快照', cardContextSnapshotVersion: 3, updatedAt: 123,
    timeline: { participants: { background: { sessionId: 'session-background' } }, operations: [{ kind: 'settle', turn: 2 }] },
    lastSettle: { turn: 2, status: 'completed' }, candidates: { turn: 2, items: ['A', 'B'] },
    messages: [
      { role: 'assistant', text: '开场', sourceText: '开场', turn: 1, greeting: true },
      { role: 'user', text: '走进教室' },
      { role: 'assistant', text: 'Session 正文', sourceText: '模型原文', displayText: '<div>展示</div>', projectionWarnings: ['旧警告'], turn: 2,
        displayRuntime: { frames: [{ partIndex: 0, captureKind: 'live', dom: '<div>实际 DOM</div>', console: [{ level: 'warn', args: ['警告'] }], network: [{ method: 'GET', url: 'https://example.com/a', status: 200 }] }] } }
    ]
  }
  const editor = { id: 'chat-editor', mode: 'card', cardPath: 'cards/校园.json', workspace: { mountedResources: [] } }
  return { source, editor }
}

test('只允许把同一人物卡的游玩轮次挂载到卡片工作台', () => {
  const { source, editor } = chats()
  const ref = createPlayChatDebugReference(editor, source, 2)
  assert.equal(ref.kind, 'play-chat')
  assert.equal(ref.path, 'play-chat:chat-play')
  assert.equal(ref.turn, 2)
  assert.equal(ref.cardSnapshotVersion, 3)
  assert.equal(ref.cardSnapshotDigest.length, 16)
  assert.equal(createPlayChatDebugReference(editor, source, 1).turn, 2)
  assert.throws(() => createPlayChatDebugReference(Object.assign({}, editor, { cardPath: 'cards/另一张.json' }), source, 2), /人物卡不一致/)
  assert.throws(() => createPlayChatDebugReference(editor, Object.assign({}, source, { mode: 'card' }), 2), /游玩模式/)
})

test('未挂载记录、错误轮次和跨人物卡读取会被拒绝', () => {
  const { source, editor } = chats()
  const ref = createPlayChatDebugReference(editor, source, 2)
  assert.throws(() => readPlayChatDebugTurn(editor, source, null, { turn: 2 }), /尚未挂载/)
  assert.throws(() => readPlayChatDebugTurn(editor, source, ref, { turn: 9 }), /不存在第 9 轮/)
  assert.throws(() => readPlayChatDebugTurn(Object.assign({}, editor, { cardPath: 'cards/另一张.json' }), source, ref, { turn: 2 }), /人物卡不一致/)
})
