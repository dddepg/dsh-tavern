import test from 'node:test'
import assert from 'node:assert/strict'
import { resourceSaveSummary, observeResourceSave } from '../tavern-plugin/lib/domain/resource-save-summary.js'
import { createTavernApiDiagnostics } from '../tavern-plugin/lib/domain/tavern-api-diagnostics.js'

test('save summaries use existing bounded export and cannot affect writes', async () => {
  const values = new Map()
  const d = createTavernApiDiagnostics({ updateJson: async (k, fn) => values.set(k, fn(values.get(k))), readJson: async k => values.get(k) })
  const summary = resourceSaveSummary('regex', 'global', [{id:'secret',disabled:false}], [{id:'secret',disabled:true}], true)
  const record = row => d.recordResourceSave('session', row)
  assert.equal(await observeResourceSave(summary, async () => 7, record), 7)
  const error = new Error('PRIVATE')
  await assert.rejects(observeResourceSave(summary, async () => { throw error }, record), e => e === error)
  await observeResourceSave(null, async () => {}, record)
  const log = await d.read('session')
  assert.deepEqual(log.records.map(r=>r.status), ['success', 'failed'])
  assert.doesNotMatch(JSON.stringify(log), /PRIVATE|secret/)
  assert.equal(await observeResourceSave(summary, async () => 8, () => {throw Error('disk')}), 8)
})
