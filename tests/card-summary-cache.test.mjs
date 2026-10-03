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
