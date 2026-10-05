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
  const request = Object.freeze(markRequestHandled({ purpose: 'compaction', messages: [] }, 'story-compaction'))
  const marked = markRequestHandled(request, 'compaction-projection')
  assert.notEqual(marked, request)
  assert.ok(requestHandledBy(marked, 'story-compaction') && requestHandledBy(marked, 'compaction-projection'))
  assert.ok(!requestHandledBy(request, 'compaction-projection'))
})
