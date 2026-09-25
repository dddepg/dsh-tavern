import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rename, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCardSummaryCache } from '../tavern-plugin/lib/domain/card-summary-cache.js'

test('summary reuse tracks external edits, replacements, deletion and repair without caching failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'card-summary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'card.json')
  let reads = 0
  const cache = createCardSummaryCache({ absolute: () => path, read: async () => {
    reads++
    const { readFile } = await import('node:fs/promises')
    return JSON.parse(await readFile(path, 'utf8'))
  } })
  await writeFile(path, '{"name":"first"}')
  const first = await cache.read('card')
  first.name = 'mutated'
  assert.equal((await cache.read('card')).name, 'first')
  assert.equal(reads, 1)
  await writeFile(path, '{"name":"other"}')
  await utimes(path, new Date(0), new Date(0))
  assert.equal((await cache.read('card')).name, 'other')
  await writeFile(path + '.new', '{"name":"third"}')
  await utimes(path + '.new', new Date(0), new Date(0))
  await rename(path + '.new', path)
  assert.equal((await cache.read('card')).name, 'third')
  await rm(path)
  await assert.rejects(cache.read('card'))
  await writeFile(path, 'broken')
  await assert.rejects(cache.read('card'))
  await writeFile(path, '{"name":"fixed"}')
  assert.equal((await cache.read('card')).name, 'fixed')
})

test('an edit during a read is not saved under the newer fingerprint', async t => {
  const root = await mkdtemp(join(tmpdir(), 'card-summary-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'card.json')
  await writeFile(path, 'old')
  let calls = 0
  const cache = createCardSummaryCache({ absolute: () => path, read: async () => {
    calls++
    if (calls === 1) { await writeFile(path, 'new content'); return { name: 'old' } }
    return { name: 'new' }
  } })
  assert.equal((await cache.read('card')).name, 'old')
  assert.equal((await cache.read('card')).name, 'new')
  await cache.read('card')
  assert.equal(calls, 2)
})

test('missing working file still reaches the durable reader for recovery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'card-summary-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'card.json')
  const cache = createCardSummaryCache({ absolute: () => path, read: async () => {
    await writeFile(path, 'recovered')
    return { name: 'Recovered' }
  } })
  assert.equal((await cache.read('card')).name, 'Recovered')
})
