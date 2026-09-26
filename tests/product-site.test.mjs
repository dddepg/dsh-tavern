import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const root = new URL('../docs/', import.meta.url)
const html = await readFile(new URL('product.html', root), 'utf8')

test('产品页可作为静态目录发布，所有本地图片、样式、脚本和锚点存在', async () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])
  assert.equal(new Set(ids).size, ids.length, 'HTML ids are unique')
  for (const [, value] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    if (value.startsWith('https://')) continue
    assert.ok(!value.startsWith('/'), 'assets must work beneath a GitHub Pages project path')
    if (value.startsWith('#')) { if (value.length > 1) assert.ok(ids.includes(value.slice(1)), value); continue }
    await access(new URL(value, root))
  }
  for (const [, attrs] of html.matchAll(/<img\b([^>]+)>/g)) assert.match(attrs, /alt="[^"]+"/)
})

test('目录链接及直接访问锚点会展开对应功能', async () => {
  const detail = { tagName: 'DETAILS', open: false }
  const events = {}
  const linkEvents = {}
  const link = { hash: '#catalog-images', addEventListener: (event, fn) => { linkEvents[event] = fn } }
  const context = { document: { querySelectorAll: () => [link], getElementById: id => id === 'catalog-images' ? detail : null }, window: { location: { hash: '#catalog-images' }, addEventListener: (event, fn) => { events[event] = fn } } }
  vm.runInNewContext(await readFile(new URL('assets/product.js', root), 'utf8'), context)
  assert.equal(detail.open, true)
  detail.open = false; linkEvents.click(); assert.equal(detail.open, true)
  detail.open = false; events.hashchange(); assert.equal(detail.open, true)
  context.window.location.hash = '#missing'; assert.doesNotThrow(events.hashchange)
})
