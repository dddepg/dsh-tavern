import assert from 'node:assert/strict'
import test from 'node:test'
import { appendGuides } from '../tavern-plugin/lib/domain/guide-content.js'
import { createGuideLibrary } from '../tavern-plugin/lib/domain/guide-library.js'

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
  const loaded = appendGuides(existing, saved.guides, { deduplicate: true })
  assert.equal(loaded.length, 2)
  assert.equal(loaded[0].id, 'old')
  assert.equal(existing.length, 1)
  assert.deepEqual(appendGuides(loaded, saved.guides, { deduplicate: true }), loaded)
  assert.throws(() => appendGuides(Array.from({ length: 20 }, (_, n) => ({ text: String(n) })), ['新增'], { deduplicate: true }), /20/)
  await assert.rejects(library.get('missing'), /不存在/)
})

test('rename and edit keep identity and loaded game content, and reject stale edits', async () => {
  let value
  const store = { readJson: async () => structuredClone(value), updateJson: async (_, fn) => { value = await fn(structuredClone(value)); return structuredClone(value) } }
  const library = createGuideLibrary({ store })
  const original = await library.save('方案', [{ text: '原内容' }])
  const loaded = appendGuides([], original.guides, { deduplicate: true })
  const renamed = await library.update({ id: original.id, expected: original, name: '新名称' })
  assert.equal(renamed.id, original.id)
  assert.equal(renamed.name, '新名称')
  await assert.rejects(library.update({ id: original.id, expected: original, guides: ['过期修改'] }), /已被修改/)
  const edited = await library.update({ id: renamed.id, expected: renamed, guides: ['第一条', '第二条'] })
  assert.deepEqual(edited.guides, ['第一条', '第二条'])
  assert.equal(loaded[0].text, '原内容')
  await assert.rejects(library.update({ id: edited.id, expected: edited, guides: [''] }), /非空/)
  assert.deepEqual((await library.get(edited.id)).guides, edited.guides)
})
