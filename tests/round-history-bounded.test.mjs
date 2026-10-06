import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRoundHistory } from '../tavern-plugin/lib/domain/round-history.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { createChatPersistence } from '../tavern-plugin/lib/domain/chat-persistence.js'
import { createChatJournalStore } from '../tavern-plugin/lib/domain/chat-journal-store.js'
import { createBoundedHistory, readRowsAt } from '../tavern-plugin/lib/domain/bounded-history.js'
import { isScopedMessages } from '../tavern-plugin/lib/domain/scoped-messages.js'

const model = { kind: 'model', provider: 'fixture', model: 'fixture' }

// A long native save whose latest round was committed and settled through the real
// timeline: settlement also edited an older floor and the chat variables, which a
// rollback must restore exactly as the checkpoint revision held them.
async function fixture(t, bounded) {
  const root = await mkdtemp(join(tmpdir(), 'rollback-bounded-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const p = createChatPersistence({ store: createChatJournalStore({ dataRoot: root, newConversations: true }) })
  let counter = 0
  const timeline = createStoryTimeline({ id: prefix => prefix + '-' + (++counter), now: () => 1000 })
  const messages = [{ role: 'assistant', greeting: true, text: '开场', turn: 1 }]
  for (let turn = 2; turn <= 80; turn++) messages.push({ role: 'user', text: '行动' + turn }, { role: 'assistant', turn, text: '正文' + turn, sourceText: '正文' + turn, swipes: ['正文' + turn], swipeId: 0, variables: [{ hp: turn }] })
  let chat = timeline.apply({ chat: { id: 'chat', sessionId: 'session', mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
    posture: '门外', settleStatus: 'done', variables: { day: 1 }, nativeCommits: {}, messages }, intent: { kind: 'ensure' } }).chat
  chat = await p.write(chat, { source: 'create' })
  const begun = timeline.apply({ chat, intent: { kind: 'body.begin', turn: 81, userText: '推门' } })
  chat = await p.write(begun.chat, { source: 'foreground.prepare' })
  chat = await p.write(timeline.complete({ chat, operationId: begun.value.operationId, basedOn: begun.value.basedOn, outcome: { status: 'success' }, apply(draft) {
    draft.messages.push({ role: 'user', text: '推门' }, { role: 'assistant', turn: 81, text: '新正文', sourceText: '新正文', swipes: ['新正文'], swipeId: 0, variables: [{ hp: 81 }] })
    draft.posture = '门内'
    draft.nativeCommits['81'] = { turn: 81, userText: '推门' }
  } }).chat, { source: 'foreground.commit' })
  const settlement = timeline.apply({ chat, intent: { kind: 'agent.begin', role: 'settlement' } })
  chat = await p.write(settlement.chat, { source: 'background.settlement.begin' })
  chat = await p.write(timeline.complete({ chat, operationId: settlement.value.operationId, basedOn: settlement.value.basedOn, outcome: { status: 'success' }, apply(draft) {
    draft.messages.at(-1).variables[0].hp = 82
    draft.messages[120].tavernPluginData = { template_display: { html: '改写' } }
    draft.variables.day = 2
  } }).chat, { source: 'background.settlement.commit' })

  const events = [
    { seq: 0, type: 'user/message', data: { turn: 81, role: 'user', content: [{ type: 'text', text: '推门' }] } },
    { seq: 1, type: 'assistant/message', data: { turn: 81, step: 1, message: { role: 'assistant', source: model, content: [{ type: 'text', text: '新正文' }] } } }
  ]
  const session = { id: 'session', events, surface: { nodes: [0, 1] }, append(type, data, options = {}) {
    const seq = events.length
    events.push({ seq, type, data, ...options })
    if (options.surfaceOp?.op === 'replace') {
      const nodes = session.surface.nodes, start = nodes.indexOf(options.surfaceOp.start), end = nodes.indexOf(options.surfaceOp.end)
      nodes.splice(start, end - start + 1, seq)
    } else if (options.surfaceOp === 'append') session.surface.nodes.push(seq)
    return seq
  } }
  const agent = { session, phase: { kind: 'idle', lastTurn: 81 }, async whenIdle() {} }
  const calls = [], hooks = {}
  const history = createBoundedHistory({ links: async () => ({ session: 'chat' }), readWindow: p.readWindow, pageSize: 8 })
  const dispatched = []
  const presented = []
  const rounds = createRoundHistory({
    chats: { read: async id => { calls.push('read'); return p.read(id) }, forSession: async () => { calls.push('read'); return p.read('chat') },
      readState: async id => (await p.readSlice(id, [], ['id', 'sessionId', 'regenInProgress'])).chat,
      readCard: async () => ({ name: '角色' }), readRevision: async (id, revision) => { calls.push('readRevision'); return p.readRevision(id, revision) },
      write: p.write, update: async (...args) => { calls.push('update:' + args[2]?.source); return p.update(...args) },
      ...(bounded ? {
        patch: async (...args) => { calls.push('patch:' + args[3]?.source); const hook = hooks.beforePatch; hooks.beforePatch = null; await hook?.(); return p.patch(...args) },
        readRecent: async id => (await history.read(id, undefined, { storyRows: 2, lastAssistant: true }))?.chat,
        changedSince: (id, revision) => p.readChangedIndices(id, revision),
        rowsAt: (id, revision, indices) => readRowsAt(p.readWindow, id, revision, indices)
      } : {}) },
    sessions: { get: () => agent, flush: async () => {} }, timeline,
    scripts: { read: async () => ({ chunks: [] }), continuity: { transition: () => ({ state: {} }) }, dispatchEvent: async event => { dispatched.push({ name: event.name, args: event.args, chat: Boolean(event.chat) }) } },
    queueSettlement: async () => {}, cancelSettlement: async () => {},
    present: async value => { presented.push(isScopedMessages(value.messages) ? 'window' : 'full'); return { rolled: true } }
  })
  return { p, rounds, calls, session, dispatched, presented, hooks }
}

function comparable(chat) {
  const value = structuredClone({ ...chat, updatedAt: 0 })
  if (value.rollbackUndo) value.rollbackUndo.id = 'UNDO'
  return value
}

test('bounded rollback stores the same Chat as the complete rollback without reading the whole history', async t => {
  const results = []
  for (const bounded of [true, false]) {
    const h = await fixture(t, bounded)
    const before = await h.p.read('chat')
    const view = await h.rounds.rollback('session', 'chat', 81)
    const after = await h.p.read('chat')
    results.push({ h, before, after, view })
  }
  const [b, f] = results
  assert.deepEqual(b.h.calls, ['patch:rollback', 'patch:rollback.undo-point'])
  assert.ok(f.h.calls.includes('read') && f.h.calls.includes('readRevision'))
  assert.deepEqual(comparable(b.after), comparable(f.after))
  // The checkpoint state: round dropped, the settled older floor and variables restored.
  assert.equal(b.after.messages.length, 159)
  assert.equal(b.after.messages[120].tavernPluginData, undefined)
  assert.equal(b.after.variables.day, 1)
  assert.equal(b.after.posture, '门外')
  assert.equal(b.after.rollbackUndo.ready, true)
  assert.deepEqual(b.h.dispatched, [{ name: 'MESSAGE_DELETED', args: [159], chat: false }])
  assert.deepEqual(f.h.dispatched, [{ name: 'MESSAGE_DELETED', args: [159], chat: true }])
  assert.deepEqual(b.h.session.surface.nodes, f.h.session.surface.nodes)
  assert.deepEqual(b.view.rolledBack, f.view.rolledBack)
  assert.deepEqual(b.h.presented, ['window'])

  // Undo restores the pre-rollback Chat on both, the bounded one by patch.
  const undone = []
  for (const { h, before } of results) {
    h.calls.length = 0
    await h.rounds.undoRollback('session', 'chat')
    const restored = await h.p.read('chat')
    assert.deepEqual(restored.messages, before.messages)
    assert.deepEqual(restored.variables, before.variables)
    assert.equal(restored.posture, before.posture)
    undone.push({ calls: [...h.calls], restored })
  }
  assert.deepEqual(undone[0].calls.filter(call => call !== 'read'), ['patch:rollback.undo'])
  assert.deepEqual(comparable(undone[0].restored), comparable(undone[1].restored))
})

test('bounded rollback falls back to the complete path when the revision moves before its patch', async t => {
  const h = await fixture(t, true)
  h.hooks.beforePatch = () => h.p.update('chat', chat => { chat.guides = ['并发']; return chat }, { source: 'guide.add' })
  await h.rounds.rollback('session', 'chat', 81)
  const after = await h.p.read('chat')
  assert.equal(after.messages.length, 159)
  assert.ok(h.calls.includes('update:rollback'))
  assert.ok(h.calls.includes('read'))
  assert.deepEqual(after.guides, ['并发'])
})
