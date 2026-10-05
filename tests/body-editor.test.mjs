import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from './fixtures/dsh-session-host.mjs'
import { createBodyEditor, synchronizeBodyEdits } from '../tavern-plugin/lib/domain/body-editor.js'
import { projectReplyLayers } from '../tavern-plugin/lib/domain/reply-presentation.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { sessionEvents, appendSessionEvent } from '../tavern-plugin/lib/domain/session-events.js'

function fixture(text = '原正文', seeded = false) {
  let session = Session.create('body-edit-test')
  appendSessionEvent(session, 'user/message', { id: 'user', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', { turn: 2, step: 1, message: { id: 'reply', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } } }, { surfaceOp: 'append', sourceEventSeqs: [] })
  if (seeded) session = Session.create(session.id, sessionEvents(session), { ...session.header, isSeeded: true }, session.seq)
  let chat = { id: 'chat', sessionId: session.id, mode: 'story', _storageRevision: 1, messages: [{ role: 'user', text: '继续' }, { role: 'assistant', turn: 2, text, sourceText: text, swipes: [text], swipeId: 0, variables: [{ hp: 9 }] }], settleStatus: 'done', posture: '原状态', scriptState: { cursor: 5 }, variables: { hp: 9 } }
  const agent = { get session() { return session }, phase: { kind: 'idle', lastTurn: 2 } }
  let busy = false, failWrite = false, failFlush = false
  const options = {
    chats: { forSession: async () => structuredClone(chat), update: async (_id, fn) => { if (failWrite) throw Error('write failed'); chat = fn(structuredClone(chat)); chat._storageRevision++; return structuredClone(chat) } },
    sessions: { get: () => agent, flush: async () => { if (failFlush) throw Error('flush failed') } },
    timeline: createStoryTimeline(), activity: () => ({ busy }), project: async text => projectReplyLayers(text), present: async chat => chat
  }
  return { editor: createBodyEditor(options), get chat() { return chat }, get session() { return session }, agent, options,
    busy(value) { busy = value }, failWrite(value) { failWrite = value }, failFlush(value) { failFlush = value },
    restore(events = sessionEvents(session)) { session = Session.create(session.id, events, session.header) },
    change(fn) { fn(chat) } }
}

test('stale tabs, blank text, new HTML, running turns and HTML-only replies reject without writes', async () => {
  const h = fixture(), edit = await h.editor.read(h.session.id), original = structuredClone(h.chat)
  for (const input of [{ token: 'stale', texts: ['新'] }, { token: edit.token, texts: [''] }, { token: edit.token, texts: ['<div>注入</div>'] }, { token: edit.token, texts: [] }]) await assert.rejects(h.editor.save(h.session.id, input))
  h.busy(true); await assert.rejects(h.editor.save(h.session.id, { token: edit.token, texts: ['新'] }), /等待/); h.busy(false)
  h.agent.phase.kind = 'running'; await assert.rejects(h.editor.read(h.session.id), /等待/)
  assert.deepEqual(h.chat, original)
  const html = fixture('<div>纯 HTML</div>'); await assert.rejects(html.editor.read(html.session.id), /没有可编辑文本/)
})

test('display captures do not invalidate an open edit, but advancing the conversation does', async () => {
  const h = fixture(), edit = await h.editor.read(h.session.id)
  h.change(chat => { chat._storageRevision++; chat.messages.at(-1).displayRuntime = { frames: [] }; chat.messages.at(-1).tavernPluginData = { template_display: { source: '正文', formattingText: '刷新显示' } } })
  await h.editor.save(h.session.id, { token: edit.token, texts: ['新正文'] })
  assert.equal(h.chat.messages.at(-1).displayRuntime, undefined)
  const next = await h.editor.read(h.session.id)
  h.change(chat => { chat.messages.push({ role: 'user', text: '下一轮' }) })
  await assert.rejects(h.editor.save(h.session.id, { token: next.token, texts: ['过时正文'] }), /最后一轮/)
})

test('issue #72: stale bodyEdit after migration clears instead of blocking turns', async () => {
  const h = fixture('原正文')
  h.change(chat => {
    chat.messages.at(-1).text = '已编辑正文'
    chat.messages.at(-1).bodyEdit = { id: 'tavern-body-edit:gone', seq: 99999, turn: 999 }
  })
  const cleared = []
  await synchronizeBodyEdits(h.session, h.chat, h.options.sessions.flush, async (_chat, ids) => { cleared.push(...ids) })
  assert.deepEqual(cleared, ['tavern-body-edit:gone'])
  assert.equal(h.chat.messages.at(-1).bodyEdit, undefined)
  assert.equal(h.session.deriveMessages().at(-1).content[0].text, '原正文')
})
