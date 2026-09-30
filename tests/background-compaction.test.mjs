import test from 'node:test'
import assert from 'node:assert/strict'
import { measureBackgroundBudget } from '../tavern-plugin/lib/domain/background-compaction.js'

test('budget uses the current model, explicit output reservation and uncommitted task messages', async () => {
  const header = { config: { provider: 'old', model: 'old' }, system: 'stable', tools: [] }
  const pending = { content: [{ type: 'text', text: 'new candidate task' }] }
  const options = {
    agent: { session: { requestHeader: () => header } },
    background: { selection: { provider: 'current', model: 'v4' }, maxTokens: 384000 },
    llm: { resolveModelInfo: async (provider, model) => {
      assert.equal(provider, 'current'); assert.equal(model, 'v4')
      return { context: { contextWindow: 1048576 }, defaultMaxTokens: 8192 }
    } },
    meter: {
      measure: (_session, envelope) => {
        assert.equal(envelope.config.model, 'v4'); assert.equal(envelope.system, 'stable')
        return { totalTokens: 700000 }
      },
      estimateMessage: message => { assert.equal(message, pending); return 5015 }
    },
    pending: [pending]
  }
  assert.deepEqual(await measureBackgroundBudget(options), { inputTokens: 705015, outputTokens: 384000, capacity: 1048576 })
  assert.equal(header.config.model, 'old')
  delete options.background.maxTokens
  assert.equal((await measureBackgroundBudget(options)).outputTokens, 8192)
  options.llm.resolveModelInfo = async () => ({})
  assert.equal(await measureBackgroundBudget(options), null)
  options.llm.resolveModelInfo = async () => { throw Error('metadata unavailable') }
  assert.equal(await measureBackgroundBudget(options), null)
  options.signal = AbortSignal.abort()
  await assert.rejects(measureBackgroundBudget(options), /metadata unavailable/)
})
