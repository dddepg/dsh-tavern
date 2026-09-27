import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyTavernHelperVariableMacros,
  renderTavernHelperVariableMacros
} from '../tavern-plugin/lib/domain/tavern-helper-variable-macros.js'

test('酒馆助手消息变量宏按路径读取并过滤内部字段', () => {
  const rendered = renderTavernHelperVariableMacros(
    '体力={{get_message_variable::stat_data.角色.体力[0]}} 数据={{get_message_variable::stat_data}}',
    { message: { stat_data: { $meta: { hidden: true }, 角色: { 体力: [12, '说明'], $cache: 1 } } } }
  )

  assert.equal(rendered.text, '体力=12 数据={"角色":{"体力":[12,"说明"]}}')
  assert.equal(rendered.replacements, 2)
})

test('格式化变量宏生成 YAML 并保持所在行缩进', () => {
  const rendered = renderTavernHelperVariableMacros(
    '<state>\n  {{format_message_variable::stat_data}}\n</state>',
    { message: { stat_data: { 角色: { 姓名: '王辰', 简介: '第一行\n第二行' }, $meta: true } } }
  )

  assert.equal(rendered.text, '<state>\n  角色:\n    姓名: 王辰\n    简介: |-\n      第一行\n      第二行\n</state>')
  assert.equal(rendered.replacements, 1)
})

test('最终请求中的酒馆助手宏逐消息替换', () => {
  const result = applyTavernHelperVariableMacros([
    { role: 'system', content: '{{format_message_variable::stat_data}}' },
    { role: 'user', content: '{{get_chat_variable::mode}}' }
  ], { message: { stat_data: { hp: 9 } }, chat: { mode: '兼容' } })

  assert.deepEqual(result.messages.map(item => item.content), ['hp: 9', '兼容'])
  assert.equal(result.replacements, 2)
})
