import assert from 'node:assert/strict'
import test from 'node:test'
import { lastRoundVariableChanges } from '../tavern-plugin/lib/domain/foreground-variable-changes.js'
import { appendVariableChanges } from '../tavern-plugin/lib/hooks/request.js'

const message = (stat_data, extra = {}) => ({ role: 'assistant', swipeId: 0, variables: [{ stat_data }], ...extra })
const chat = messages => ({ mode: 'story', mvu: { enabled: true }, messages })

test('只列出上一轮结算后变化的变量及最新值；列表整体给出，对象逐层比较，内部键忽略', () => {
  const before = { 基本: { 时间: '14:00', 地点: '律所' }, 待办: ['买猫粮'], 体力: 70, $meta: { strictSet: true } }
  const after = { 基本: { 时间: '15:25', 地点: '律所' }, 待办: ['买猫粮', '健身'], 体力: 70, $meta: { strictSet: false } }
  const text = lastRoundVariableChanges(chat([message(before), { role: 'user', text: '继续' }, message(after)]))
  assert.match(text, /^【上一轮变量变化】/)
  assert.match(text, /\/基本\/时间 = "15:25"/)
  assert.match(text, /\/待办 = \["买猫粮","健身"\]/)
  assert.doesNotMatch(text, /地点|体力|\$meta/)
  assert.equal(lastRoundVariableChanges(chat([message(after), message(after)])), null, '无变化不注入')
  assert.equal(lastRoundVariableChanges(chat([message(after)])), null, '开局没有上一轮')
  assert.equal(lastRoundVariableChanges({ ...chat([message(before), message(after)]), mvu: { enabled: false } }), null)
})

test('每轮第一步追加一次，作为插件上下文进入历史', () => {
  const current = chat([message({ hp: 10 }), message({ hp: 9 })])
  const decision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }] }
  const first = appendVariableChanges({ chat: current, payload: { step: 1 }, decision })
  assert.equal(first.messages.length, 2)
  assert.equal(first.messages[1].source.form, 'variable-changes')
  assert.match(first.messages[1].content[0].text, /\/hp = 9/)
  assert.equal(appendVariableChanges({ chat: current, payload: { step: 1 }, decision: first }).messages.length, 2)
  assert.equal(appendVariableChanges({ chat: current, payload: { step: 2 }, decision }).messages.length, 1)
})
