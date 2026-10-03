import assert from 'node:assert/strict'
import test from 'node:test'

import { createCardPreparation } from '../tavern-plugin/lib/domain/card-preparation.js'

function moduleUnderTest() {
  let sequence = 0
  return createCardPreparation({
    id: () => 'card-' + (++sequence),
    now: () => 123456
  })
}

test('旧版 DSH 扁平人物卡导出为 SillyTavern 可导入的 V3', () => {
  const cards = moduleUnderTest()
  const workspace = cards.create({
    kind: 'import',
    payload: {
      spec: 'chara_card_v3',
      name: '旧版角色',
      description: '旧版扁平描述',
      first_mes: '你好',
      tags: ['旧卡'],
      unknown_root: { keep: true }
    }
  })

  const exported = cards.present({ card: workspace, as: 'sillytavern-v3' })

  assert.equal(exported.spec, 'chara_card_v3')
  assert.equal(exported.spec_version, '3.0')
  assert.equal(exported.data.name, '旧版角色')
  assert.equal(exported.data.description, '旧版扁平描述')
  assert.equal(exported.data.first_mes, '你好')
  assert.deepEqual(exported.data.tags, ['旧卡'])
  assert.deepEqual(exported.unknown_root, { keep: true })
  assert.equal(Object.prototype.hasOwnProperty.call(exported, 'name'), false)
})

test('raw 扩展按 JSON Pointer 分段读取并做最小修改', () => {
  const cards = moduleUnderTest()
  const workspace = cards.create({
    kind: 'import',
    payload: { spec: 'chara_card_v3', spec_version: '3.0', data: { name: '阿芙拉', extensions: { regex_scripts: [{ scriptName: '状态栏', disabled: false }] } } }
  })
  const section = cards.present({ card: workspace, as: 'raw-section', pointer: '/data/extensions/regex_scripts', limit: 40 })
  assert.equal(section.pointer, '/data/extensions/regex_scripts')
  assert.equal(section.from, 1)
  assert.equal(section.done, false)
  assert.match(section.text, /状态栏/)

  const changed = cards.update({
    kind: 'card', card: workspace, patch: {},
    rawOperations: [
      { op: 'set', path: '/data/extensions/regex_scripts/0/disabled', value: true },
      { op: 'set', path: '/data/extensions/mvu', value: { version: 1 } }
    ]
  })
  assert.deepEqual(changed.changedFields, [
    'raw:/data/extensions/regex_scripts/0/disabled',
    'raw:/data/extensions/mvu'
  ])
  assert.equal(changed.card.raw.data.extensions.regex_scripts[0].disabled, true)
  assert.deepEqual(changed.card.raw.data.extensions.mvu, { version: 1 })
  assert.throws(() => cards.update({ kind: 'card', card: workspace, patch: {}, rawOperations: [{ op: 'set', path: '/__proto__/polluted', value: true }] }), /不安全字段/)
  assert.throws(() => cards.update({
    kind: 'card', card: workspace, patch: {},
    rawOperations: [{ op: 'set', path: '/data/character_book/entries/0/content', value: '绕过专用接口' }]
  }), /世界书只能通过 tavern_update_worldbook 修改/)
})

test('世界书常驻上下文只暴露目录，正文按编号或关键词读取', () => {
  const cards = moduleUnderTest()
  const card = cards.create({
    kind: 'import',
    payload: {
      name: '阿芙拉',
      character_book: {
        name: '黑麦镇',
        entries: [
          { keys: ['钟楼'], content: '钟楼藏着失踪商队的线索。', enabled: true, constant: false },
          { keys: ['废案'], content: '这条设定已经停用。', enabled: false, constant: true },
          { keys: ['酒馆'], content: '吧台下面藏着一把短弩。', enabled: true, constant: true }
        ]
      }
    }
  })

  const overview = cards.present({ card, as: 'world-book-overview' })
  assert.equal(overview.entryCount, 2)
  assert.deepEqual(overview.entries[0], {
    ref: 'entry:0', keys: ['钟楼'], comment: '', enabled: true, constant: false, chars: 12
  })
  assert.deepEqual(overview.entries.map((entry) => entry.ref), ['entry:0', 'entry:2'])
  assert.equal(JSON.stringify(overview).includes('失踪商队'), false)

  const window = cards.present({ card, as: 'world-book-window', ref: 'entry:2' })
  assert.equal(window.total, 2)
  assert.equal(window.entries[0].ref, 'entry:2')
  assert.equal(window.entries[0].entry.content, '吧台下面藏着一把短弩。')
  assert.equal(cards.present({ card, as: 'world-book-window', query: '失踪商队', limit: 1 }).entries[0].ref, 'entry:0')
  assert.deepEqual(cards.present({ card, as: 'world-book-window', ref: 'entry:1' }).entries, [])
})

test('世界书按条目合并修改，不要求模型重传整本世界书', () => {
  const cards = moduleUnderTest()
  const card = cards.create({
    kind: 'import',
    payload: {
      name: '阿芙拉',
      character_book: {
        name: '旧世界书',
        entries: [
          { keys: ['钟楼'], content: '旧线索', enabled: true, extensions: { depth: 4 } },
          { keys: ['酒馆'], content: '保持不变', enabled: true }
        ]
      }
    }
  })

  const changed = cards.update({
    kind: 'card',
    card,
    patch: {},
    worldBookOperations: [
      { op: 'rename', name: '新世界书' },
      { op: 'update', ref: 'entry:0', patch: { content: '新线索' } },
      { op: 'add', entry: { keys: ['水道'], content: '新的入口', enabled: true } }
    ]
  })

  assert.equal(changed.changed, true)
  assert.deepEqual(changed.changedFields, ['character_book'])
  assert.equal(changed.view.character_book.name, '新世界书')
  assert.equal(changed.view.character_book.entries[0].content, '新线索')
  assert.deepEqual(changed.view.character_book.entries[0].extensions, { depth: 4 })
  assert.equal(changed.view.character_book.entries[1].content, '保持不变')
  assert.equal(changed.view.character_book.entries[2].content, '新的入口')

  const removed = cards.update({ kind: 'card', card: changed.card, patch: {}, worldBookOperations: { op: 'delete', ref: 'entry:1' } })
  assert.deepEqual(removed.view.character_book.entries.map((entry) => entry.content), ['新线索', '新的入口'])
  assert.throws(() => cards.update({ kind: 'card', card, patch: {}, worldBookOperations: { op: 'update', ref: 'entry:9', patch: { content: 'x' } } }), /世界书条目不存在/)
})

test('卡片工作台草稿的 player 不是人物卡字段，保存时校验玩家与角色视角', () => {
  const cards = moduleUnderTest()
  const draftChange = cards.update({
    kind: 'draft',
    card: { name: '' },
    player: '',
    patch: { name: '阿芙拉', player: '旅行者', personality: '果断' }
  })
  assert.equal(draftChange.card.name, '阿芙拉')
  assert.equal(draftChange.player, '旅行者')
  assert.equal(draftChange.card.player, undefined)

  const finalized = cards.create({
    kind: 'draft',
    draft: draftChange.card,
    player: draftChange.player,
    sourceIds: ['src-1']
  })
  assert.match(cards.project(finalized).creator_notes, /\[玩家\] 旅行者/)

  assert.throws(() => cards.create({ kind: 'draft', draft: { name: '阿芙拉' }, player: '', sourceIds: [] }), /玩家.*没有确认/)
  assert.throws(() => cards.create({ kind: 'draft', draft: { name: '阿芙拉', system_prompt: '你是阿芙拉' }, player: '旅行者', sourceIds: [] }), /第二人称|玩家身份冲突/)
})

for (const spec of ['flat', 'chara_card_v2', 'chara_card_v3']) test('变量编辑不触发名字同步，原生与字段改名仍触发：' + spec, () => {
  const cards = moduleUnderTest()
  const data = { name: '原名', extensions: { tavern_helper: { variables: {} } } }
  const workspace = cards.create({ kind: 'import', payload: spec === 'flat' ? data : { spec, data } })
  const prefix = spec === 'flat' ? '' : '/data'
  const variables = cards.update({ kind: 'card', card: workspace, patch: {}, rawOperations: [{ op: 'set', path: prefix + '/extensions/tavern_helper/variables', value: { hp: 7 } }] })
  assert.equal(variables.changed, true)
  assert.equal(variables.nameChanged, false)
  const named = cards.update({ kind: 'card', card: workspace, patch: { name: '新名字' } })
  assert.equal(named.nameChanged, true)
  const rawNamed = cards.update({ kind: 'card', card: workspace, patch: {}, rawOperations: [{ op: 'set', path: prefix + '/name', value: '原生改名' }] })
  assert.equal(rawNamed.nameChanged, true)
  assert.equal(cards.update({ kind: 'card', card: workspace, patch: { name: '原名' } }).nameChanged, false)
})
