
import assert from 'node:assert/strict'
import test from 'node:test'

import { rememberTavernResources, resourceWorkspaceContext } from '../tavern-plugin/lib/domain/workspace-resources.js'

test('挂载资源按真实相对路径持久去重', () => {
  assert.deepEqual(rememberTavernResources([{ kind: 'card', path: 'cards/阿芙拉.json', label: '旧名' }], '@[阿芙拉](tavern-file:cards%2F%E9%98%BF%E8%8A%99%E6%8B%89.json) @[银铃](tavern-file:scripts%2F%E9%98%BF%E8%8A%99%E6%8B%89%2F%E9%93%B6%E9%93%83.txt)'), [
    { kind: 'card', path: 'cards/阿芙拉.json', label: '阿芙拉' },
    { kind: 'script', path: 'scripts/阿芙拉/银铃.txt', label: '银铃' },
  ])
})

test('伪造或残缺的游玩诊断引用不会进入人物卡工作台', () => {
  assert.deepEqual(rememberTavernResources([
    { kind: 'play-chat', path: 'play-chat:other', chatId: 'chat-source', turn: 2 },
    { kind: 'play-chat', path: 'play-chat:chat-source', chatId: 'chat-source', turn: 0 }
  ], ''), [])
})

 test('前台保存的工作区模板替换真实路径，不递归解释路径或其他模板变量', () => {
  const projection = { specPath: '.tavern/README.md', bindingsPath: 'bindings.json', contextPath: 'session-a/context.json', diagnosticsPath: 'diag.json' }
  const custom = '我的说明：{{resourceRoot}}\n{{projectionPaths}}\n保留 {{user}}'
  const text = resourceWorkspaceContext('/workspace/{{projectionPaths}}', projection, custom)
  assert.ok(text.startsWith('我的说明："/workspace/{{projectionPaths}}"'))
  assert.match(text, /session-a\/context.json/)
  assert.ok(text.endsWith('保留 {{user}}'))
  assert.equal(resourceWorkspaceContext('/root', null, '只保留我的说明'), '只保留我的说明')
  assert.equal(resourceWorkspaceContext('', projection, custom), '')
})
