import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import { sessionEvents, appendSessionEvent } from '../tavern-plugin/lib/domain/session-events.js'

import { projectWorldbookFilterContext } from '../tavern-plugin/lib/domain/worldbook-filter-context.js'

const input = candidates => ({ task: 'worldbook-filter', messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify({ currentInput: '当前输入', recent: [], candidates }) }] }] })
const candidate = (ref = 'entry:1', text = 'x'.repeat(15000)) => ({ ref, text, hits: [{ key: '当前关键词' }] })
const items = result => JSON.parse(result.payloadText).candidates
function append(session, projected, id = 'first') {
  const lead = '【最近剧情与本次任务】\n[用户]\n'
  return appendSessionEvent(session, 'user/message', { id, role: 'user',
    content: [{ type: 'text', text: lead + projected.payloadText + '\n任务协议' }],
    source: { kind: 'plugin', plugin: 'dsh-tavern', worldbookFilterPayload: { version: 1, start: lead.length, length: projected.payloadText.length } }
  }, { surfaceOp: 'append' })
}

test('unchanged bodies are referenced; changed bodies and refs are resent, without modifying history', () => {
  const session = Session.create('delta')
  const first = projectWorldbookFilterContext(session, input([candidate()]))
  assert.equal(items(first)[0].text.length, 15000)
  append(session, first)
  const before = JSON.stringify(sessionEvents(session))
  const next = projectWorldbookFilterContext(session, input([candidate(), candidate('entry:2'), candidate('entry:1', 'changed')]))
  assert.equal(items(next)[0].text, undefined)
  assert.equal(items(next)[0].bodyReference.messageId, 'first')
  assert.equal(items(next)[1].text.length, 15000, 'same content under another ref is not silently aliased')
  assert.equal(items(next)[2].text, 'changed')
  assert.equal(JSON.stringify(sessionEvents(session)), before)
})

test('missing or altered projection evidence falls back to full bodies', () => {
  const session = Session.create('tampered')
  append(session, projectWorldbookFilterContext(session, input([candidate()])))
  const message = structuredClone(session.deriveMessages()[0])
  message.content[0].text = message.content[0].text.replace('x'.repeat(15000), 'y'.repeat(15000))
  assert.equal(items(projectWorldbookFilterContext({ deriveMessages: () => [message] }, input([candidate()])))[0].text.length, 15000)
  for (const unavailable of [{}, { deriveMessages() { throw new Error('unavailable') } }]) {
    assert.equal(items(projectWorldbookFilterContext(unavailable, input([candidate()])))[0].text.length, 15000)
  }
})
