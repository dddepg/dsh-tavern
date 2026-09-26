import assert from 'node:assert/strict'
import test from 'node:test'

import { UpstreamTemplateRuntime } from './fixtures/upstream-template-runtime.mjs'

const runtime = await UpstreamTemplateRuntime.create()

test('模板在浏览器环境执行，不提供 Node 进程对象', async () => {
  const result = await runtime.render('<%= typeof process %>|<%= typeof require %>|<%= typeof fetch %>')
  assert.equal(result.text, 'undefined|undefined|function')
})

test('真实请求处理保留工具与推理块，并处理独立 system 和正文模板', async () => {
  const message = { id: 'message', role: 'assistant', content: [
    { type: 'reasoning', text: 'retained' }, { type: 'text', text: '<%= 6 * 7 %>' },
    { type: 'tool-call', id: 'tool-id', name: 'inspect', arguments: { value: 1 } }
  ] }
  const result = await runtime.projectRequest({ system: '规则 <%= 1+1 %>', messages: [message] })
  assert.equal(result.system, '规则 2')
  assert.equal(result.messages[0].id, 'message')
  assert.deepEqual(result.messages[0].content, [message.content[0], { type: 'text', text: '42' }, message.content[2]])
  assert.equal(message.content[1].text, '<%= 6 * 7 %>')
})
