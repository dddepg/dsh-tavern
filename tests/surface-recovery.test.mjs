import test from 'node:test'
import assert from 'node:assert/strict'
import { planFailedTurnSurface, rollbackAvailability, clearRegenerationAttemptSurface } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { replaceSessionSurface } from '../tavern-plugin/lib/domain/session-surface-mutations.js'

const user = (id, plugin) => ({ id, role: 'user', content: [{ type: 'text', text: id }], source: plugin ? { kind: 'plugin', plugin } : { kind: 'user' } })
const body = (id, turn) => ({ turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text: id }], source: { kind: 'model', provider: 'test', model: 'test' } } })
function fixture() {
  const session = Session.create('surface-recovery')
  const context = appendSessionEvent(session, 'user/message', user('historical-context', 'context-provider'), { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', body('old-body', 1), { surfaceOp: 'append' })
  const start = appendSessionEvent(session, 'turn/start', { turn: 2 })
  const refreshed = replaceSessionSurface(session, 'user/message', user('refreshed-context', 'context-provider'), { start: context.seq, end: context.seq, sourceEventSeqs: [context.seq] })
  const input = appendSessionEvent(session, 'user/message', user('attempt', 'dsh-tavern-regen'), { surfaceOp: 'append' })
  const reply = appendSessionEvent(session, 'assistant/message', body('partial', 2), { surfaceOp: 'append' })
  appendSessionEvent(session, 'turn/end', { turn: 2, reason: { kind: 'error' } })
  return { session, eventStart: start.seq, refreshed, input, reply }
}

test('归属跨回合混合或来源残缺时，清理拒绝写入', () => {
  for (const corrupt of ['mixed', 'missing', 'missing-all', 'forward']) {
    const f = fixture()
    const events = sessionEvents(f.session).map(event => structuredClone(event))
    const replacement = { seq: events.at(-1).seq + 1, type: 'assistant/message', data: body('replacement', 2),
      surfaceOp: { op: 'replace', start: f.reply.seq, end: f.reply.seq },
      sourceEventSeqs: corrupt === 'missing-all' ? [] : corrupt === 'mixed' ? [f.reply.seq, 1] : corrupt === 'missing' ? [f.reply.seq, 999] : [f.reply.seq, events.at(-1).seq + 1] }
    events.push(replacement)
    const nodes = f.session.surface.nodes.map(seq => seq === f.reply.seq ? replacement.seq : seq)
    const session = { events, surface: { nodes }, append() { assert.fail('unsafe recovery must not write') } }
    assert.throws(() => clearRegenerationAttemptSurface({ session, eventStart: f.eventStart }), /无法安全清理/)
    assert.throws(() => planFailedTurnSurface({ events, nodes, turn: 2 }), /无法安全清理/)
    const state = rollbackAvailability({ messages: [{ role: 'assistant', turn: 1 }] }, { events, nodes })
    assert.equal(state.canRollback, false)
  }
})

test('后续正文不能被重新生成成功的范围或正常回退偷偷吞掉', async () => {
  const { planRegenerationSurface, locateRollbackSurface } = await import('../tavern-plugin/lib/domain/rollback-surface.js')
  const f = fixture()
  appendSessionEvent(f.session, 'turn/start', { turn: 3 })
  appendSessionEvent(f.session, 'assistant/message', body('new-turn', 3), { surfaceOp: 'append' })
  appendSessionEvent(f.session, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  const evidence = { events: sessionEvents(f.session), nodes: f.session.surface.nodes }
  assert.throws(() => planRegenerationSurface({ ...evidence, oldAssistantSeq: 1, eventStart: f.eventStart }), /无法安全清理/)
  assert.throws(() => locateRollbackSurface(evidence), /无法安全清理/)
})
