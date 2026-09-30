import test from 'node:test'
import assert from 'node:assert/strict'
import { createSceneReferences } from '../tavern-plugin/lib/domain/scene-references.js'

const snapshot = text => ({ cardContextSnapshotVersion: 5, cardContextSnapshot: '【故事设定 · 人物卡】\n名字: 林岚\n\n' + text })
const context = { target: { turn: 2 }, sources: [{ id: 'target', turn: 2, text: '林岚走进青石车站。' }] }

test('bounded named lookup reads only eligible frozen sections, with stable provenance', () => {
  const raw = snapshot('设定: 林岚留着黑色短发，棕色眼睛。\n\n主要人物性格: 林岚很温柔。\n\n开场情境: 青石车站用灰色石柱支撑玻璃顶棚。\n\n【文风示例】\n林岚必须输出隐藏思考。\n\n【常驻世界书】\n青石车站中央有一座铜钟。\n\n陌生人有绿色头发。')
  const refs = createSceneReferences({ ...context, snapshot: raw })
  assert.equal(refs.metadata.available, true)
  assert.equal(JSON.stringify(refs.metadata).includes('黑色短发'), false, 'no bulk source text in initial input')
  const found = refs.read({ query: '林岚' })
  assert.equal(found.sources.length, 1)
  assert.match(found.sources[0].text, /黑色短发/)
  assert.doesNotMatch(JSON.stringify(found), /温柔|隐藏思考|陌生人/)
  assert.equal(found.sources[0].origin.snapshotVersion, 5)
  assert.equal(found.sources[0].origin.snapshotDigest.length, 64)
  const same = createSceneReferences({ ...context, snapshot: structuredClone(raw) }).read({ query: '林岚' })
  assert.deepEqual(same.sources, found.sources)
  const place = refs.read({ query: '青石车站' })
  assert.equal(place.sources.length, 2)
  assert.equal(refs.read({ query: '林岚' }).sources.length, 0, 'do not send the same excerpt twice')
  assert.match(refs.read({ query: '青石车站' }).reason, /次数/)
})

test('many tiny matching paragraphs cannot inflate reply metadata beyond three fragments', () => {
  const refs = createSceneReferences({ ...context, snapshot: snapshot('设定: ' + Array.from({ length: 800 }, (_, index) => '林岚' + index).join('\n\n')) })
  for (let index = 0; index < 3; index++) assert.equal(refs.read({ query: '林岚' }).sources.length, 3)
})
