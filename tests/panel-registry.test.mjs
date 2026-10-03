import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
let descriptor
vm.runInNewContext(await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(value) { descriptor = value } } }
})
const client = descriptor.factory(() => ({}))
function target() { return { isConnected: true, moveBefore(node) { node.parentNode = this } } }
test('手动固定多个页面保持节点身份，取消固定和卸载都回到各自原消息', () => {
  const registry = client.createTavernPanelRegistry()
  const entries = [1, 2].map(n => { const home = target(); return { id: String(n), sessionId: 'a', home, node: { parentNode: home, input: '未提交输入' } } })
  const cleanups = entries.map(entry => registry.register(entry))
  const sidebar = target()
  entries.forEach(entry => { registry.pin(entry.id, true); registry.dock(entry.id, sidebar) })
  assert.equal(registry.inspect().filter(e => e.pinned).length, 2)
  registry.pin('1', false)
  assert.equal(entries[0].node.parentNode, entries[0].home)
  assert.equal(entries[1].node.parentNode, sidebar)
  assert.equal(entries[0].node.input, '未提交输入')
  cleanups.forEach(cleanup => cleanup())
  assert.equal(entries[1].node.parentNode, entries[1].home)
  assert.equal(registry.inspect().length, 0)
})
