import assert from 'node:assert/strict'
import test from 'node:test'

import {
  projectTavernHelperWorldbook,
  replaceTavernHelperWorldbookOperations
} from '../tavern-plugin/lib/domain/tavern-helper-worldbook.js'

function view() {
  return {
    displayName: '灯火阑珊世界书',
    entries: [{
      ref: 'entry:3', sourceUid: 9, title: '[地图]神州', comment: '[地图]神州', content: '神州资料', enabled: true,
      primaryKeys: ['神州'], secondaryKeys: ['城镇'], constant: false, selective: true, selectiveLogic: 0,
      vectorized: false, order: 120, position: 'after_char', depth: 4, role: 0, probability: 100,
      excludeRecursion: false, preventRecursion: true, delayUntilRecursion: 0, sticky: null, cooldown: null, delay: null
    }]
  }
}

test('世界书位置与角色编号遵循 Tavern Helper 上游定义', function () {
  const source = view()
  source.entries = [
    { ...source.entries[0], ref: 'entry:0', sourceUid: 0, position: 0, role: 0 },
    { ...source.entries[0], ref: 'entry:1', sourceUid: 1, position: 1, role: 1 },
    { ...source.entries[0], ref: 'entry:2', sourceUid: 2, position: 4, role: 2 },
    { ...source.entries[0], ref: 'entry:3', sourceUid: 3, position: 7, role: null }
  ]
  assert.deepEqual(projectTavernHelperWorldbook(source).entries.map(function (entry) {
    return [entry.position.type, entry.position.role]
  }), [
    ['before_character_definition', 'system'],
    ['after_character_definition', 'user'],
    ['at_depth', 'assistant'],
    ['outlet', 'system']
  ])
})

test('人物卡脚本按 uid 更新条目并生成明确的增删操作', function () {
  const projected = projectTavernHelperWorldbook(view())
  const requested = structuredClone(projected.entries)
  requested[0].enabled = false
  requested[0].content = '新资料'
  requested[0].strategy.type = 'constant'
  assert.deepEqual(replaceTavernHelperWorldbookOperations(view(), requested), [{
    op: 'update', ref: 'entry:3', patch: { content: '新资料', enabled: false, constant: true, selective: false, vectorized: false }
  }])
  assert.deepEqual(replaceTavernHelperWorldbookOperations(view(), []), [{ op: 'delete', ref: 'entry:3' }])
  const replaced = replaceTavernHelperWorldbookOperations(view(), [{ ...requested[0], uid: 10 }])
  assert.equal(replaced[0].op, 'add')
  assert.equal(replaced[0].uid, 10)
  assert.deepEqual(replaced[1], { op: 'delete', ref: 'entry:3' })
  assert.throws(() => replaceTavernHelperWorldbookOperations(view(), [requested[0], requested[0]]), /编号无效或重复/)
})
