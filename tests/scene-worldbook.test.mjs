import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProfileDataStore } from '../tavern-plugin/lib/profile-data-store.js'
import { createSceneWorldbooks, bindSceneWorldbook, sceneWorldbookBinding } from '../tavern-plugin/lib/domain/scene-worldbook.js'
import { createSceneReferences } from '../tavern-plugin/lib/domain/scene-references.js'
import { sceneTarget } from '../tavern-plugin/lib/domain/scene-illustration.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'scene-worldbook-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createProfileDataStore({ dataRoot: root })
  return { store, api: createSceneWorldbooks({ store }) }
}
const book = text => ({ view: { entries: [
  { ref: 'entry:one', title: '林岚', primaryKeys: ['岚岚'], content: text, enabled: true, constant: false },
  { ref: 'disabled', title: '林岚', content: '停用条目', enabled: false },
  { ref: 'rules', title: '[mvu_update] rules', content: '更新教程', constant: true },
  { ref: 'entry:place', title: '青石车站', primaryKeys: ['车站'], content: '青石车站有石柱。', constant: true }
] } })

test('immutable versioned archive includes nonconstant entries, resolves historical macros and deduplicates writes', async t => {
  const { store, api } = await fixture(t)
  const chat = { macroState: { userName: '过去的玩家', local: {}, global: {} } }, card = { name: '林岚' }
  const original = book('{{user}}认识留着黑色短发的{{char}}。')
  const before = structuredClone(chat)
  const ref = await api.capture({ worldBook: original, chat, card })
  const path = 'scene-images/worldbooks/' + ref.digest + '.json', version = await store.version(path)
  assert.deepEqual(await api.capture({ worldBook: original, chat, card }), ref)
  assert.equal(await store.version(path), version)
  original.view.entries[0].content = '未来红发。'
  chat.macroState.userName = '未来的玩家'
  const old = await createSceneWorldbooks({ store }).read(ref)
  assert.match(old.entries[0].text, /过去的玩家.*黑色短发.*林岚/)
  assert.doesNotMatch(JSON.stringify(old), /未来|停用条目|更新教程/)
  assert.equal(old.entries[0].constant, false)
  assert.notDeepEqual(await api.capture({ worldBook: original, chat, card }), ref)
  assert.deepEqual(before.macroState.local, chat.macroState.local)
})

test('opening swipes retain their archive; rewritten bodies and missing/corrupt archives never use current resources', async t => {
  const { store, api } = await fixture(t), ref = await api.capture({ worldBook: book('黑色短发') })
  const chat = { id: 'chat', messages: [bindSceneWorldbook({ role: 'assistant', turn: 1, greeting: true, swipes: ['林岚站着。', '林岚坐着。'], swipeId: 0 }, ref)] }
  for (const swipeId of [0, 1]) {
    chat.messages[0].swipeId = swipeId
    assert.deepEqual(sceneWorldbookBinding(chat, sceneTarget(chat, 1)), ref)
  }
  chat.messages[0].swipes[1] = '新写的正文。'
  assert.equal(sceneWorldbookBinding(chat, sceneTarget(chat, 1)), null)
  await store.writeJson('scene-images/worldbooks/' + ref.digest + '.json', { version: 1, entries: [] })
  assert.match((await api.read(ref)).unavailable, /校验失败/)
  await store.remove('scene-images/worldbooks/' + ref.digest + '.json')
  assert.match((await api.read(ref)).unavailable, /缺失/)
  assert.equal(await api.read({ version: 1, digest: '../../elsewhere' }), null)
})

test('conditional reference variants require current scene evidence, not old history or an unexamined regex', async t => {
  const { api } = await fixture(t)
  const worldBook = book('林岚的夜晚形态。')
  Object.assign(worldBook.view.entries[0], { selective: true, secondaryKeys: ['夜晚'], selectiveLogic: 0 })
  const archived = await api.read(await api.capture({ worldBook }))
  const read = (text, worldbook = archived) => createSceneReferences({ worldbook, target: { turn: 3 }, sources: [
    { id: 'target', text }, { id: 'history', text: '上一轮是夜晚。' }
  ] }).read({ query: '林岚' })
  assert.equal(read('林岚站在白天的车站。').sources.length, 0)
  assert.equal(read('林岚站在夜晚的车站。').sources.length, 1)
  worldBook.view.entries[0].secondaryKeys = ['/夜晚/']
  const unsupported = await api.read(await api.capture({ worldBook }))
  assert.equal(read('林岚站在夜晚的车站。', unsupported).sources.length, 0)
})
