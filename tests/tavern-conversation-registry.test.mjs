import assert from 'node:assert/strict'
import test from 'node:test'
import { createTavernConversationRegistry } from '../tavern-plugin/lib/domain/tavern-conversation-registry.js'

function memoryStore(seed = {}) {
  let links = structuredClone(seed.links || {})
  let index = structuredClone(seed.index || { chats: [] })
  const chats = new Map(Object.entries(structuredClone(seed.chats || {})))
  const failures = seed.failures || {}
  let chatReads = 0
  let linkUpdates = 0
  return {
    adapter: {
      async readLinks() { return structuredClone(links) },
      async updateLinks(updater) {
        linkUpdates += 1
        const result = await updater(structuredClone(links))
        if (result !== undefined) links = structuredClone(result)
      },
      async readIndex() { return structuredClone(index) },
      async writeIndex(value) {
        if (failures.writeIndex) throw new Error(failures.writeIndex)
        index = structuredClone(value)
      },
      async readChat(id) {
        chatReads += 1
        if (failures.readChat) throw new Error(failures.readChat)
        return chats.has(id) ? structuredClone(chats.get(id)) : undefined
      },
      async writeChat(chat) { chats.set(chat.id, structuredClone(chat)) },
      async removeChat(id) { chats.delete(id) }
    },
    snapshot() { return { links: structuredClone(links), index: structuredClone(index), chats: Object.fromEntries(chats), chatReads } },
    counts() { return { linkUpdates } }
  }
}

test('索引发布失败时回滚 Chat 和 Session 关联', async function () {
  const store = memoryStore({ failures: { writeIndex: 'index locked' } })
  const registry = createTavernConversationRegistry({ store: store.adapter })

  await assert.rejects(registry.publish({ id: 'chat-2', sessionId: 'session-2', cardPath: '', cardName: 'B', updatedAt: 20 }), /index locked/)

  assert.deepEqual(store.snapshot().links, {})
  assert.deepEqual(store.snapshot().chats, {})
})

test('损坏映射会从 Chat 索引自愈并清除失效目标', async function () {
  const chat = { id: 'chat-real', sessionId: 'session-3', cardPath: '', cardName: 'C' }
  const store = memoryStore({
    links: { 'session-3': 'chat-missing' },
    index: { chats: [{ id: 'chat-real' }] },
    chats: { 'chat-real': chat }
  })
  const registry = createTavernConversationRegistry({ store: store.adapter })

  assert.deepEqual(await registry.resolve('session-3'), chat)
  assert.deepEqual(store.snapshot().links, { 'session-3': 'chat-real' })
})

test('后台轮换写入轻量索引，恢复旧后台后重新成为当前，列表不加载历史', async () => {
  const store = memoryStore({ links: { front: 'game' } })
  const registry = createTavernConversationRegistry({ store: store.adapter })
  const chat = { id: 'game', messages: [], timeline: { participants: { background: { sessionId: 'old' } } } }
  await registry.sync(chat)
  chat.timeline.participants.background.sessionId = 'new'
  await registry.sync(chat)
  assert.deepEqual((await registry.list())[0].backgroundHistoryIds, ['old'])
  chat.timeline.participants.background.sessionId = 'old'
  await registry.sync(chat)
  const row = (await registry.list())[0]
  assert.equal(row.backgroundSessionId, 'old')
  assert.deepEqual(row.backgroundHistoryIds, ['new'])
  assert.equal(store.snapshot().chatReads, 0)
})

test('background config resolves aliases, repairs missing links and adopts legacy games once', async () => {
  const { createSessionChatReader } = await import('../tavern-plugin/lib/domain/session-view-reader.js')
  const { projectChatBackgroundConfig } = await import('../tavern-plugin/lib/domain/chat-session-state.js')
  const initial = { id: 'game', sessionId: 'canonical', mode: 'story',
    backgroundModelSelection: { provider: 'custom', model: 'saved' },
    timeline: { participants: { background: { status: 'needs-session' } } },
    messages: [{ role: 'assistant', text: 'keep my story', variables: { gold: 10 } }] }
  const store = memoryStore({ links: {}, index: { chats: [{ id: 'game' }] }, chats: { game: initial } })
  let configReads = 0, adoptions = 0
  store.adapter.readBackgroundConfig = async id => {
    configReads++
    const chat = store.snapshot().chats[id]
    return chat ? projectChatBackgroundConfig(chat) : undefined
  }
  const registry = createTavernConversationRegistry({ store: store.adapter })
  const reader = createSessionChatReader({ registry,
    needsAdoption: chat => chat.backgroundConfigVersion !== 1,
    adopt: async chat => {
      adoptions++
      const updated = { ...chat, backgroundConfigVersion: 1, conversationFeaturesVersion: 1 }
      await store.adapter.writeChat(updated)
      return updated
    }
  })
  const config = await reader.readBackgroundConfig('canonical')
  assert.equal(config.backgroundModelSelection.model, 'saved')
  assert.equal(config.backgroundSessionStatus, 'needs-session')
  assert.equal(config.messages, undefined)
  assert.equal(store.snapshot().links.canonical, 'game')
  await store.adapter.updateLinks(links => ({ ...links, alias: 'game' }))
  config.backgroundModelSelection.model = 'external mutation'
  assert.equal((await reader.readBackgroundConfig('alias')).backgroundModelSelection.model, 'saved')
  assert.equal(adoptions, 1)
  assert.equal(store.snapshot().chatReads, 1, 'only legacy adoption may read the full game')
  assert.equal(configReads, 2)
  assert.deepEqual(store.snapshot().chats.game.messages, initial.messages)
  assert.equal(await reader.readBackgroundConfig('missing'), undefined)
})

test('自动化拥有的会话不进入日常列表，但仍能解析且不删除数据', async () => {
  const id = 'test-8c2b3d71-c30e-446f-b7f6-75fc32614b8c'
  const normal = 'test-11111111-1111-4111-8111-111111111111'
  const chat = { id: 'automation-chat', sessionId: id, cardName: '自动化' }
  const store = memoryStore({ links: { [id]: chat.id, [normal]: 'normal-chat' }, index: { chats: [chat, { id: 'normal-chat', cardName: '正常对话' }] }, chats: { [chat.id]: chat } })
  store.adapter.readAutomationOwner = async key => key === id ? { sessionId: id } : undefined
  const registry = createTavernConversationRegistry({ store: store.adapter })
  assert.deepEqual((await registry.list()).map(row => row.sessionId), [normal])
  assert.deepEqual(await registry.resolve(id), chat)
  assert.equal(store.snapshot().links[id], chat.id)
})
