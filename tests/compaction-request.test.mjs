import test from 'node:test'
import assert from 'node:assert/strict'
import { projectCompactionRequest } from '../tavern-plugin/lib/domain/compaction-request.js'

const empty = plugin => Object.freeze({ role: 'user', content: Object.freeze([]), source: Object.freeze({ kind: 'plugin', plugin }) })
const metadata = empty('dsh-tavern')

test('ordinary requests and summaries without placeholders retain object identity', () => {
  for (const request of [undefined, {}, { messages: [metadata] }, { purpose: 'compaction', messages: [] }]) {
    assert.equal(projectCompactionRequest(request), request)
  }
})

test('marking a frozen, already-marked request copies it instead of throwing (#148)', async () => {
  const { markRequestHandled, requestHandledBy } = await import('../tavern-plugin/lib/domain/request-lineage.js')
  const { createStoryCompactionRequest } = await import('../tavern-plugin/lib/domain/story-compaction.js')
  // The real chain: the projection hook marks the request, then the story hook
  // returns a frozen copy carrying that mark and marks it again.
  const projected = markRequestHandled({ purpose: 'compaction', messages: [{ role: 'user', content: [], source: { plugin: 'dsh-compaction-basic' } }] }, 'compaction-projection')
  const request = createStoryCompactionRequest(projected, '剧情压缩')
  assert.ok(Object.isFrozen(request))
  const marked = markRequestHandled(request, 'story-compaction')
  assert.notEqual(marked, request)
  assert.ok(requestHandledBy(marked, 'story-compaction') && requestHandledBy(marked, 'compaction-projection'))
  assert.ok(!requestHandledBy(request, 'story-compaction'))
})

test('one hook projects, applies the story prompt and sends a single summary request (#146/#148)', async () => {
  const { installCompactionRequestProjection } = await import('../tavern-plugin/lib/domain/compaction-request.js')
  const { createStoryCompactionRequest } = await import('../tavern-plugin/lib/domain/story-compaction.js')
  const hooks = [], sent = []
  const dispatch = (request, index = 0) => index < hooks.length
    ? hooks[index](request, () => dispatch(request, index + 1))
    : (async function * () { sent.push(request); yield { type: 'finish', reason: { kind: 'stop' } } })()
  const ctx = { on: (_, hook) => hooks.push(hook), llm: { stream: request => dispatch(request), resolveModelInfo: async () => undefined } }
  installCompactionRequestProjection(ctx, async () => true, async request => createStoryCompactionRequest(request, '剧情压缩提示'))
  const instruction = Object.freeze({ role: 'user', content: Object.freeze([{ type: 'text', text: '原生提示' }]), source: Object.freeze({ kind: 'plugin', plugin: 'dsh-compaction-basic' }) })
  const host = Object.freeze({ purpose: 'compaction', sessionId: 's', messages: Object.freeze([metadata, instruction]) })
  for await (const _ of ctx.llm.stream(host)) { /* drain */ }
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].messages.map(m => m.content[0]?.text), ['剧情压缩提示'])
})
