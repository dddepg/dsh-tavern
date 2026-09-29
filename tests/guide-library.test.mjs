import assert from 'node:assert/strict'
import test from 'node:test'
import { createGuideLibrary, appendLibraryGuides } from '../tavern-plugin/lib/domain/guide-library.js'

test('guide library saves the complete game bundle independently and survives reopening', async () => {
  let document
  const store = { readJson: async () => structuredClone(document), updateJson: async (_, fn) => { document = await fn(structuredClone(document)); return document } }
  const library = createGuideLibrary({ store })
  const guides = [{ text: '短句' }, { text: '心理描写'.repeat(500) }]
  const saved = await library.save('文风', guides)
  assert.deepEqual((await createGuideLibrary({ store }).get(saved.id)).guides, guides.map(item => item.text))
  await assert.rejects(library.save('空方案', []))
  assert.equal((await library.list()).length, 1)
  const existing = [{ id: 'old', text: '短句' }]
  const loaded = appendLibraryGuides(existing, saved.guides)
  assert.equal(loaded.length, 2)
  assert.equal(loaded[0].id, 'old')
  assert.equal(existing.length, 1)
  assert.deepEqual(appendLibraryGuides(loaded, saved.guides), loaded)
  assert.throws(() => appendLibraryGuides(Array.from({ length: 20 }, (_, n) => ({ text: String(n) })), ['新增']), /20/)
  await assert.rejects(library.get('missing'), /不存在/)
})
