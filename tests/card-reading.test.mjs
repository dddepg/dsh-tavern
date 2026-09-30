import assert from 'node:assert/strict'
import test from 'node:test'

import { cardFieldCatalog } from '../tavern-plugin/lib/domain/card-reading.js'

test('人物卡目录只报告字段长度，不泄露字段正文', () => {
  const catalog = cardFieldCatalog({ name: '阿芙拉', description: '绝密人物设定', tags: ['佣兵'] })
  assert.deepEqual(catalog.find((item) => item.field === 'description'), { field: 'description', chars: 6, empty: false })
  assert.equal(JSON.stringify(catalog).includes('绝密人物设定'), false)
})
