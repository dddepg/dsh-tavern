import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent } from '../tavern-plugin/lib/domain/session-events.js'

import { worldbookSnapshot } from '../tavern-plugin/lib/domain/worldbook-snapshot.js'
import { createForegroundFrameSessionAdapter } from '../tavern-plugin/lib/domain/foreground-frame-session-adapter.js'
import { createForegroundFrameBuilder } from '../tavern-plugin/lib/domain/agent-input-frame.js'
import { retireForegroundFrames } from '../tavern-plugin/lib/domain/foreground-frame-retirement.js'

function append(session, text) {
  const snapshot = worldbookSnapshot(session, text)
  if (!snapshot) return null
  return appendSessionEvent(session, 'user/message', { id: crypto.randomUUID(), role: 'user',
    content: [{ type: 'text', text: snapshot.rendered }], source: { kind: 'plugin', plugin: 'dsh-tavern', worldbookSnapshot: snapshot } }, { surfaceOp: 'append' })
}

test('前台快照独立于短期指引，清理指引后仍保留；下一轮同值不重发', () => {
  const session = Session.create('snapshot-frame')
  const adapter = createForegroundFrameSessionAdapter()
  function prepare(turn, text) {
    const frame = createForegroundFrameBuilder().build({ chatId: 'chat', branchId: 'branch', basedOnRevision: turn, operationId: 'op-' + turn, turn,
      inputs: [{ kind: 'foreground.user-input', sourceText: '继续' }, { kind: 'foreground.writing-rules', text: '本轮规则' },
        { kind: 'foreground.active-worldbook', text }] })
    const result = adapter.append({ session, messages: [], frame, step: 1 })
    for (const message of result.messages) appendSessionEvent(session, 'user/message', message, { surfaceOp: 'append' })
    return result.messages
  }
  assert.equal(prepare(1, '<天气>晴</天气>').length, 2)
  retireForegroundFrames(session)
  assert.match(JSON.stringify(session.deriveMessages()), /<天气>晴/)
  assert.equal(prepare(2, '<天气>晴</天气>').length, 1)
  assert.equal(prepare(3, '<天气>雨</天气>').length, 2)
  assert.match(prepare(4, '')[0].content[0].text, /全部失效/)
})

import { clearRegenerationAttemptSurface } from '../tavern-plugin/lib/domain/rollback-surface.js'

import { createInitializationNative } from './fixtures/conversation-initialization-native.mjs'
test('真实 Agent 请求中，同值省略、新值只追加且保留此前完整请求前缀', { skip: !process.env.DSH_BOOT_MODULE }, async t => {
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
  t.after(() => h.dispose())
  let text = '天气：晴', n = 0
  const adapter = createForegroundFrameSessionAdapter()
  h.ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const frame = createForegroundFrameBuilder().build({ chatId: 'chat', branchId: 'branch', basedOnRevision: n, operationId: 'op-' + (++n), turn: payload.turn,
      inputs: [{ kind: 'foreground.user-input', sourceText: '继续' }, { kind: 'foreground.active-worldbook', text }] })
    return { ...decision, messages: adapter.append({ session: payload.agent.session, messages: decision.messages, frame, step: payload.step }).messages }
  })
  for (const value of ['天气：晴', '天气：晴', '天气：雨']) {
    text = value
    h.target.agent.followup({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'human' } })
    await h.target.agent.whenIdle()
  }
  assert.equal(h.requests.length, 3)
  const visible = request => request.messages.map(({ role, content }) => ({ role, content }))
  for (let i = 1; i < 3; i++) {
    const before = visible(h.requests[i - 1])
    assert.deepEqual(visible(h.requests[i]).slice(0, before.length), before)
  }
  const snapshots = request => request.messages.filter(message => message.source?.worldbookSnapshot)
  assert.equal(snapshots(h.requests[0]).length, 1)
  assert.equal(snapshots(h.requests[1]).length, 1)
  assert.equal(snapshots(h.requests[2]).length, 2)
})

test('放弃重生成时清理临时快照，恢复原版本', () => {
  const session = Session.create('snapshot-regeneration')
  append(session, '晴')
  const eventStart = session.seq
  append(session, '雨')
  assert.ok(clearRegenerationAttemptSurface({ session, eventStart }))
  assert.equal(worldbookSnapshot(session, '晴'), null)
  assert.ok(worldbookSnapshot(session, '雨'))
})
