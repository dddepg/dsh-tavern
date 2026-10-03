import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
const route = source.slice(source.indexOf("      case 'setStatusBarPlacement':"), source.indexOf("      case 'setPlayerName':"))
test('状态栏位置按本局保存，不改变剧情、变量或提示词缓存基准', async () => {
  const games = { a: { id: 'a', mode: 'story', messages: ['正文'], variables: { hp: 10 }, cardContextSnapshot: '提示词', cardContextRevision: 7 }, b: { id: 'b', mode: 'story' }, c: { id: 'c', mode: 'card' } }
  const original = structuredClone(games.a)
  const run = new Function('args', 'chatForSession', 'updateChat', `return (async()=>{switch('setStatusBarPlacement'){${route}}})()`)
  const save = args => run(args, async id => games[id], async (id, change) => { games[id] = change(games[id]) })
  await save({ sessionId: 'a', placement: 'body' })
  assert.deepEqual(games.a, { ...original, statusBarPlacement: 'body' })
  assert.equal(games.b.statusBarPlacement, undefined)
  await assert.rejects(save({ sessionId: 'a', placement: 'invalid' }), /无效/)
  await assert.rejects(save({ sessionId: 'c', placement: 'body' }), /游玩/)
  await save({ sessionId: 'a', placement: 'sidebar' })
  assert.deepEqual(games.a, { ...original, statusBarPlacement: 'sidebar' })
})
