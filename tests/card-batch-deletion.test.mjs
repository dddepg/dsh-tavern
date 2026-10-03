import assert from 'node:assert/strict'
import test from 'node:test'
import { helperClient } from './fixtures/helper-host-harness.mjs'

test('空选择不删除；服务端未确认删除时不报告成功', async () => {
  assert.equal((await helperClient.deleteTavernCards([], () => { throw Error('unexpected') })).length, 0)
  const result = await helperClient.deleteTavernCards([{ path: 'cards/a.json', name: 'a' }], async () => ({ deleted: false }))
  assert.equal(result[0].ok, false)
})

function chatServer(sessions, { failArchive = [], failDelete = [] } = {}) {
  const calls = []
  const call = async (method, args) => {
    calls.push([method, args])
    if (method === 'listSessions') return { sessions }
    if (method === 'prepareDeleteChats') return { results: args.chatIds.map(chatId => ({ chatId, ok: true })) }
    if (method === 'deleteChats') return { results: args.chatIds.map(chatId => failDelete.includes(chatId) ? { chatId, ok: false, error: 'busy' } : { chatId, ok: true }) }
    throw Error('unexpected ' + method)
  }
  const archived = []
  const archiveSession = async id => { if (failArchive.includes(id)) throw Error('archive failed'); archived.push(id) }
  return { call, calls, archived, archiveSession }
}

const sessions = [
  { chatId: 'c1', sessionId: 's1', cardPath: 'cards/a.json', mode: 'story' },
  { chatId: 'c2', sessionId: 's2', cardPath: 'cards\\a.json', mode: 'script' },
  { chatId: 'c3', sessionId: 's3', cardPath: 'cards/a.json', mode: 'card' },
  { chatId: 'c4', sessionId: 's4', cardPath: 'cards/b.json', mode: 'story' }
]

test('删除人物卡时只询问该卡的游玩记录，卡片工作台对话不计入', async () => {
  const server = chatServer(sessions)
  const asked = []
  const chats = await helperClient.askTavernCardChatRemoval(['cards/a.json'], async (message, options) => { asked.push([message, options]); return true }, server.call)
  assert.deepEqual(chats.map(item => item.chatId), ['c1', 'c2'])
  assert.match(asked[0][0], /这张人物卡还有 2 个游玩记录/)
  assert.equal(asked[0][1].cancelText, '保留游玩记录')
})

test('没有游玩记录时不追问；选择保留时不删除记录', async () => {
  const server = chatServer(sessions)
  let asked = 0
  assert.equal((await helperClient.askTavernCardChatRemoval(['cards/none.json'], async () => { asked++; return true }, server.call)).length, 0)
  assert.equal(asked, 0)
  assert.equal((await helperClient.askTavernCardChatRemoval(['cards/a.json'], async () => false, server.call)).length, 0)
})

test('只删除已成功删除的人物卡的游玩记录，归档失败的记录保留', async () => {
  const server = chatServer(sessions, { failArchive: ['s2'] })
  const chats = sessions.filter(item => item.chatId !== 'c3')
  const outcome = await helperClient.removeTavernCardChats(chats, [{ path: 'cards/a.json', ok: true }, { path: 'cards/b.json', ok: false }], server.archiveSession, server.call)
  assert.deepEqual(server.archived, ['s1'])
  assert.deepEqual(Array.from(server.calls.find(([method]) => method === 'deleteChats')[1].chatIds), ['c1'])
  assert.deepEqual(Array.from(outcome.sessionIds), ['s1'])
  assert.match(outcome.notice, /游玩记录删除 1 个，1 个失败/)
})
