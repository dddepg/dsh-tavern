import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveCardOpening } from '../tavern-plugin/lib/domain/card-openings.js'

const card = {
  first_mes: '默认开场',
  alternate_greetings: ['雨夜开场', '酒馆开场']
}

test('创建会话时按稳定编号解析用户选中的开场白', () => {
  assert.equal(resolveCardOpening(card, 'alternate:0'), '雨夜开场')
  assert.equal(resolveCardOpening(card, 'alternate:1'), '酒馆开场')
  assert.throws(() => resolveCardOpening(card, 'alternate:9'), /人物卡开场白不存在/)
})
