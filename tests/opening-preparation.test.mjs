import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpeningPreparation } from '../tavern-plugin/lib/domain/opening-preparation.js'
import { inspectWorldBookDocument } from '../tavern-plugin/lib/domain/worldbook-resource.js'

const card = { name: '测试', first_mes: '首页', alternate_greetings: ['第二幕'] }
function fixture() {
  const document = { name: '本局世界书', entries: [{ id: 0, name: '选项', keys: [], content: '固定设定', enabled: false }] }
  const record = { source: { kind: 'card', cardPath: 'card' }, view: inspectWorldBookDocument(document) }
  return { record, service: createOpeningPreparation({ readCard: async () => structuredClone(card), worldBooks: { bound: async () => structuredClone(record) } }) }
}

test('过期世界书写入不覆盖新设置，返回值也不能直接修改草稿', async () => {
  const { service } = fixture()
  const draft = await service.create('card')
  const old = structuredClone(draft.worldbook.entries)
  draft.worldbook.entries[0].enabled = true
  await service.replaceWorldbook(draft.id, draft.worldbook.entries, old)
  await assert.rejects(service.replaceWorldbook(draft.id, old, old), /修改/)
  const current = service.get(draft.id)
  current.worldbook.entries[0].enabled = false
  assert.equal(service.get(draft.id).worldbook.entries[0].enabled, true)
})

import { createHelperWorldbookHost } from './fixtures/helper-worldbook-host.mjs'
for (const embedded of [false, true]) test('本局世界书的运行时读写与原始资源隔离：' + embedded, async () => {
  const h = await createHelperWorldbookHost(embedded)
  try {
    const before = await h.read()
    h.chat.openingWorldbookSnapshot = { version: 1, source: (await h.record()).source, document: structuredClone(before) }
    const { worldbook } = await h.adapter.getWorldbook('audit', '审计书')
    const entries = structuredClone(worldbook.entries)
    entries[0].enabled = false
    await h.adapter.replaceWorldbook('audit', '审计书', entries, worldbook.entries)
    assert.equal((await h.adapter.getWorldbook('audit', '审计书')).worldbook.entries[0].enabled, false)
    assert.deepEqual(await h.read(), before)
    const { worldInfo } = await h.adapter.loadWorldInfo('audit', '审计书')
    const updated = structuredClone(worldInfo)
    updated.entries[7].content = '只属于这局的新正文'
    await h.adapter.saveWorldInfo('audit', '审计书', updated, worldInfo)
    assert.equal((await h.adapter.loadWorldInfo('audit', '审计书')).worldInfo.entries[7].content, '只属于这局的新正文')
    assert.deepEqual(await h.read(), before)
  } finally { await h.cleanup() }
})

import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
test('原样宿主调用：更新世界书、保存 swipe、重新加载，实际进入准备草稿', async () => {
  const { service } = fixture()
  const draft = await service.create('card')
  let receive, selected
  const parent = { postMessage(message) {
    Promise.resolve().then(async () => {
      let result
      if (message.type === 'dsh-tavern-opening-read') result = service.get(draft.id)
      if (message.type === 'dsh-tavern-opening-worldbook') result = await service.replaceWorldbook(draft.id, message.entries, message.expectedEntries)
      if (message.type === 'dsh-tavern-opening-save') result = service.select(draft.id, ['primary', 'alternate:0'][message.swipeId])
      if (message.type === 'dsh-tavern-opening-select') selected = message.swipeId
      receive({ source: parent, data: { type: 'dsh-tavern-opening-response', token: 'test', requestId: message.requestId, ok: true, result } })
    })
  } }
  const context = vm.createContext({ window: {}, parent, setTimeout, clearTimeout, console, addEventListener: (_, callback) => { receive = callback } })
  vm.runInContext(await readFile(new URL('../tavern-plugin/src/client/opening-preview.js', import.meta.url), 'utf8'), context)
  context.installOpeningPreviewBridge('test', { preparationId: draft.id, swipes: ['首页', '第二幕'], openingIds: ['primary', 'alternate:0'], selectedIndex: 0, worldbook: draft.worldbook })
  const host = context.window
  await host.TavernHelper.updateWorldbookWith(host.TavernHelper.getCharWorldbookNames('current').primary, rows => rows.map(row => ({ ...row, enabled: true })))
  host.SillyTavern.chat[0].swipe_id = 1
  host.SillyTavern.chat[0].mes = host.SillyTavern.chat[0].swipes[1]
  await host.SillyTavern.saveChat()
  assert.equal(service.get(draft.id).openingId, 'alternate:0')
  assert.equal(selected, undefined, 'save must not destroy the awaiting page')
  await host.SillyTavern.reloadCurrentChat()
  assert.equal(selected, 1)
  assert.equal(service.resolve(draft.id, 'card', 'alternate:0').worldbookSnapshot.document.entries[0].enabled, true)
  await assert.rejects(host.waitGlobalInitialized('Mvu'), /尚未初始化/, 'must not claim an unloaded MVU is ready')
})

test('准备页运行时变量和插件设置均隔离保存', async () => {
  const { record } = fixture()
  const service = createOpeningPreparation({ readCard: async () => card, worldBooks: { bound: async () => record } })
  const draft = await service.create('card', { runtime: true })
  assert.equal(draft.runtime.context.extensionSettings.EjsTemplate, undefined)
  assert.equal(draft.runtime.scripts[0].system, 'official-mvu')
  assert.match(draft.runtime.scripts[0].assetUrl, /vendor\/magvarupdate\/bundle.js$/)
  const result = await service.callRuntime(draft.id, 'updateTavernHelperVariables', { option: { type: 'message', message_id: 0 }, variables: { stat_data: { hp: 10 }, schema: {} } })
  assert.equal(result.context.messages[0].variables.stat_data.hp, 10)
  assert.equal(service.resolve(draft.id, "card", "primary").messageVariables.stat_data.hp, 10)
  assert.equal(service.resolve(draft.id, "card", "alternate:0").openingVariables.primary.stat_data.hp, 10)
  const settings = { ...draft.runtime.context.extensionSettings, mvu: { enabled: true } }
  const saved = await service.callRuntime(draft.id, 'saveTavernExtensionSettings', { settings, expectedSettings: draft.runtime.context.extensionSettings })
  assert.deepEqual(saved.extensionSettings, settings)
  const second = await service.create('card', { runtime: true })
  assert.equal(second.runtime.context.extensionSettings.mvu, undefined)
  await assert.rejects(service.callRuntime(draft.id, 'updateTavernHelperMessages', { messages: [{ message_id: 1, message: '改写剧情' }] }), /已有开场/)
})

test('native swipe.to selects a preview and rejects historical message targets', async () => {
  let receive, selected
  const parent = { postMessage(message) {
    selected = message.swipeId
    queueMicrotask(() => receive({ source: parent, data: { type: 'dsh-tavern-opening-response', token: 'swipe', requestId: message.requestId, ok: true } }))
  } }
  const context = vm.createContext({ window: {}, parent, setTimeout, clearTimeout, console, addEventListener: (_, fn) => { receive = fn } })
  vm.runInContext(await readFile(new URL('../tavern-plugin/src/client/opening-preview.js', import.meta.url), 'utf8'), context)
  context.installOpeningPreviewBridge('swipe', { swipes: ['menu', 'story'], openingIds: ['alternate:0', 'alternate:1'], selectedIndex: 0 })
  const swipe = context.window.SillyTavern.getContext().swipe
  await assert.rejects(swipe.to(null, 'right', { forceMesId: 2, forceSwipeId: 1 }), /开场/)
  await assert.rejects(swipe.to(null, 'right', { forceMesId: 0, forceSwipeId: 20 }), /开场/)
  assert.equal(selected, undefined)
  await swipe.to(null, 'right', { forceMesId: 0, forceSwipeId: 1, source: 'slash_command' })
  assert.equal(selected, 1)
  await swipe.to(null, 'left')
  assert.equal(selected, 0)
})

test('开场准备复用已读取的卡片和扩展，不重复加载资源', async () => {
  const service = createOpeningPreparation({ readCard: async () => { throw new Error('重复读取') },
    readRuntimeExtensions: async () => { throw new Error('重复准备扩展') }, worldBooks: { bound: async () => null } })
  const draft = await service.create('card', { card, extensions: { helperScripts: [] } })
  assert.ok(draft.id)
})

test('保留的开局草稿跨过原有效期仍可用，放弃立即释放，失联草稿仍过期', async () => {
  let now = 0
  const service = createOpeningPreparation({ now: () => now, readCard: async () => card, worldBooks: { bound: async () => null } })
  const retained = await service.create('card'), abandoned = await service.create('card')
  service.select(retained.id, 'alternate:0')
  now = 90 * 60 * 1000
  assert.deepEqual(service.retain(retained.id), { retained: true })
  now = 150 * 60 * 1000
  assert.equal(service.get(retained.id).openingId, 'alternate:0')
  assert.throws(() => service.retain(abandoned.id), /过期/)
  assert.deepEqual(service.release(retained.id), { released: true })
  assert.throws(() => service.get(retained.id), /过期/)
  assert.deepEqual(service.release(retained.id), { released: false })
})

test('MVU 开局保留完整模板设置，卡脚本可按读取的基线保存修改', async () => {
  let stored = { EjsTemplate: { enabled: true, code_blocks_enabled: true, depth_limit: 7 }, other: { enabled: false } }
  const service = createOpeningPreparation({ readCard: async () => card, worldBooks: { bound: async () => null },
    extensionSettings: { read: async () => structuredClone(stored), save: async (next, expected) => {
      assert.deepEqual(expected, stored, '开局不能向插件设置存储提交伪造的基线')
      stored = structuredClone(next)
      return structuredClone(stored)
    } } })
  const draft = await service.create('card', { runtime: true })
  assert.deepEqual(draft.runtime.context.extensionSettings, stored)
  assert.deepEqual(service.templateState(draft.id).environment.extension_settings.EjsTemplate, stored.EjsTemplate)
  const next = structuredClone(draft.runtime.context.extensionSettings)
  next.EjsTemplate.depth_limit = -1
  await service.callRuntime(draft.id, 'saveTavernExtensionSettings', { settings: next, expectedSettings: draft.runtime.context.extensionSettings })
  assert.equal((await service.create('card', { runtime: true })).runtime.context.extensionSettings.EjsTemplate.depth_limit, -1)
})
