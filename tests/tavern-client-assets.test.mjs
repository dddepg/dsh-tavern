import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('Web 宿主直接注入完整内置样式，重复加载与升级复用同一个节点', async () => {
  const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  const css = await readFile(new URL('../tavern-plugin/lib/client-assets/tavern.css', import.meta.url), 'utf8')
  const nodes = []
  const document = {
    querySelector() { return nodes.find(node => node.tag === 'style') },
    querySelectorAll() { return [...nodes] },
    createElement(tag) {
      assert.equal(tag, 'style', 'no external stylesheet link')
      return { tag, dataset: {}, remove() { nodes.splice(nodes.indexOf(this), 1) } }
    },
    head: { appendChild(node) { nodes.push(node) } }
  }
  let descriptor
  vm.runInNewContext(source, { document, window: { __ModuleLoader__: { load(value) { descriptor = value } } }, console })
  descriptor.factory(() => ({}))
  assert.equal(nodes.length, 1)
  const current = nodes[0]
  assert.equal(current.textContent, css)
  assert.equal(current.dataset.plugin, 'dsh-tavern-plugin')
  descriptor.factory(() => ({}))
  assert.equal(nodes.length, 1)
  current.textContent = 'outdated styles'
  descriptor.factory(() => ({}))
  assert.equal(nodes[0], current)
  assert.equal(current.textContent, css)
  assert.doesNotMatch(source, /__TAVERN_BUNDLED_CSS__|client-assets\/tavern\.css\?v=/)
})
