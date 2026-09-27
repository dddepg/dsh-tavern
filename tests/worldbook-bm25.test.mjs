import test from 'node:test'
import assert from 'node:assert/strict'

import { createWorldbookFilter } from '../tavern-plugin/lib/domain/worldbook-filter.js'
const pool = () => Array.from({ length: 30 }, (_, i) => ({ ref: String(i), text: i < 10 ? '四番队 治疗 伤口 医疗' : '沙漠 城市 商人 交易', tokenCost: 500 }))

test('Agent still judges after BM25; retrieval tools cannot read dropped candidates', async () => {
  const candidates = pool().map((item, i) => ({ ...item, text: i === 29 ? '卯之花治疗伤口' : '无关资料', tokenCost: 9000 }))
  let ran = false
  const filter = createWorldbookFilter({ selection: () => ({}), beginTask: async () => ({ participantRequest: {}, bindSession() {}, participant: () => ({}), commit: async () => ({ status: 'committed' }), fail: async () => {} }),
    runAgent: async input => {
      ran = true
      const payload = JSON.parse(input.messages[0].content[0].text)
      assert.deepEqual(payload.candidates.map(item => item.ref), ['29'])
      assert.throws(() => input.onToolCall({ name: 'worldbook_candidate_read', arguments: { refs: ['0'] } }), /不在本轮/)
      input.onToolCall({ name: 'worldbook_filter_submit', arguments: { selected: ['29'] } })
      return { traceSessionId: 'background' }
    } })
  const result = await filter({ chat: { sessionId: 's', messages: [{ role: 'assistant', sourceText: '卯之花治疗伤口' }] }, userText: '交易', candidates })
  assert.equal(ran, true)
  assert.deepEqual(result.selected, ['29'])
  assert.equal(result.decisions[0].reason, 'BM25 粗筛排除')
  assert.equal(result.candidateCount, 30)
})

test('BM25 query includes the current player action alongside the latest story', async () => {
  const candidates = [
    { ref: 'healing', text: '药王谷 治疗 伤口', tokenCost: 4000 },
    { ref: 'schools', text: '少林 武当 拜师', tokenCost: 4000 },
    ...Array.from({ length: 21 }, (_, i) => ({ ref: 'other-' + i, text: '沙漠 商人 交易', tokenCost: 4000 }))
  ]
  let offered
  const filter = createWorldbookFilter({ selection: () => ({}),
    beginTask: async () => ({ participantRequest: {}, bindSession() {}, participant: () => ({}), commit: async () => ({ status: 'committed' }), fail: async () => {} }),
    runAgent: async input => {
      offered = JSON.parse(input.messages[0].content[0].text).candidates.map(item => item.ref)
      input.onToolCall({ name: 'worldbook_filter_submit', arguments: { selected: offered } })
      return { traceSessionId: 'background' }
    } })
  for (const body of [{ sourceText: '药王谷治疗伤口', text: '沙漠商人交易' }, { text: '药王谷治疗伤口' }]) {
    const result = await filter({ chat: { messages: [{ role: 'assistant', ...body }] }, userText: '少林武当拜师', candidates })
    assert.equal(result.bm25.ran, true)
    assert.deepEqual(offered, ['healing', 'schools'])
  }
  await filter({ chat: { messages: [] }, userText: '少林武当拜师', candidates })
  assert.deepEqual(offered, ['schools'])
  await filter({ chat: { messages: [{ role: 'assistant', text: '药王谷治疗伤口' }] }, candidates })
  assert.deepEqual(offered, ['healing'])
})
