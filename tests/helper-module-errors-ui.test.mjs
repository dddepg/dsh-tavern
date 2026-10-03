import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
function harness() {
  let reloads = 0
  const window = { sessionStorage: { getItem() { return null }, setItem() {} }, location: { reload() { reloads++ } } }
  const React = { useState: value => [value], useEffect() {}, createElement: (tag, props, ...children) => ({ tag, props, children }) }
  const slice = source.slice(source.indexOf('function isIgnoredTavernError'), source.indexOf('const tavernSessionModes'))
  const api = vm.runInNewContext('(function(){' + slice + ';return {hub:tavernErrorHub,render:TavernErrorCenter};})()', { window, React, URL })
  return { ...api, reloads: () => reloads }
}
function nodes(tree) { return tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flatMap(nodes)] : [] }

test('详情拒绝非数组和超量资源，普通脚本执行错误不出现网络重试提示', () => {
  const h = harness(), error = new Error('依赖失败')
  error.dshTavernModuleFailure = { phase: 'module-load', reason: 'invented', references: 'bad', resources: Array.from({ length: 100 }, () => ({ url: 'https://cdn.example/a.js', status: 404 })) }
  h.hub.report('script', error)
  assert.doesNotThrow(() => h.render())
  const detail = h.hub.getSnapshot()[0].moduleFailure
  assert.equal(detail.reason, 'unknown')
  assert.equal(detail.references.length, 0)
  assert.equal(detail.resources.length, 8)
  h.hub.report('script', new Error('z is not defined'))
  assert.equal(nodes(h.render()).some(n => n.tag === 'details'), false)
})
