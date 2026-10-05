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
