import test from 'node:test'
import assert from 'node:assert/strict'
import { createSceneCharacterDesigns } from '../tavern-plugin/lib/domain/scene-character-designs.js'

const target = { turn: 2, swipeId: 0 }
const snapshot = () => ({ settleStatus: 'done', macroState: { userName: '小林' }, characterDesignDocument: {
  revision: 1, characters: [{ name: '林岚', design: { identity: '室友', appearance: '黑色短发', defaultPresentation: '白色外套', relationships: '{{user}}的朋友' } }]
} })

test('missing/unsettled snapshots and unknown names do not invent designs', async () => {
  for (const value of [null, { ...snapshot(), settleStatus: 'running' }]) {
    const reader = createSceneCharacterDesigns({ snapshot: value, target, sources: [] })
    const result = await reader.read({ name: '林岚' })
    assert.equal(result.found, false)
    assert.deepEqual(result.sources, [])
  }
  const reader = createSceneCharacterDesigns({ snapshot: snapshot(), target, sources: [] })
  assert.equal((await reader.read({ name: '不存在' })).found, false)
})

test('design reads share the scene source budget and never return truncated records', async () => {
  const reader = createSceneCharacterDesigns({ snapshot: snapshot(), target, sources: [{ text: 'x'.repeat(11990) }] })
  const result = await reader.read({ name: '林岚' })
  assert.equal(result.ok, false)
  assert.equal(result.character, undefined)
  assert.deepEqual(result.sources, [])
})
