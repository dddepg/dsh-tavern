import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import * as helper from '../tavern-plugin/lib/domain/tavern-helper-context.js'

const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')

test('silly 模式在正文请求前持久化模板变量到当前消息槽位', async () => {
  // Use only the Helper bindings actually imported by the production entrypoint.
  const names = source.match(/import \{([^}]+)\} from '\.\/domain\/tavern-helper-context\.js'/)[1].split(',').map(name => name.trim())
  const chat = { id: 'silly', messages: [{ role: 'assistant', content: '开场', swipeId: 1, variables: [{ old: true }, {}] }] }
  let globalVariables
  const context = {
    ...Object.fromEntries(names.map(name => [name, helper[name]])),
    updateChat: async (id, mutate) => { assert.equal(id, chat.id); mutate(chat) },
    writePromptTemplateGlobalVariables: async variables => { globalVariables = variables }
  }
  const start = source.indexOf('persistCompiled: async function (input) {')
  const end = source.indexOf('\n      projectMessages:', start)
  vm.runInNewContext('this.persist = ({' + source.slice(start, end) + '}).persistCompiled', context)
  const scopes = { initial: { seed: 1 }, local: { hp: 8 }, message: { hp: 7 }, global: { shared: 2 } }
  await context.persist({ chat, turn: 1, compiled: { macroState: { count: 1 }, promptTemplateState: { persist: true, scopes }, trace: {}, diagnostics: [] } })
  assert.deepEqual(chat.variables, scopes.local)
  assert.deepEqual(chat.promptTemplateInitialVariables, scopes.initial)
  assert.deepEqual(chat.messages[0].variables, [{ old: true }, { hp: 7 }])
  assert.deepEqual(globalVariables, scopes.global)
  assert.ok(chat.compatibilityTraces['1'])
})
