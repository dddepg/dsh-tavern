import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { parse } from 'acorn'
const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8')
const client = read('tavern-plugin/packages/dsh-dream-skin/lib/client.js')
const start = client.indexOf('const SKINS = [')
const end = client.indexOf('\n\t\t];', start) + '\n\t\t];'.length
const skins = vm.runInNewContext(client.slice(start, end) + '; SKINS')
test('bundled picker includes original skins and both Tavern palettes', () => {
  parse(client, { ecmaVersion: 'latest' })
  assert.equal(skins.length, 10)
  for (const expected of JSON.parse(read('tavern-plugin/packages/dsh-dream-skin/tavern-themes.json'))) {
    assert.deepEqual(JSON.parse(JSON.stringify(skins.find(s => s.id === expected.id))), expected)
  }
  assert.match(client, /skin.label \|\| t\(`skin/)
})
test('fresh preferences have an empty wallpaper, and skin gradients remain enabled', () => {
  const defaults = client.slice(client.indexOf('const FACTORY_DEFAULTS = {'), client.indexOf('let seedDeferredFactoryWallpaper'))
  for (const key of ['WALLPAPER_KEY', 'WALLPAPER_URL_KEY', 'WALLPAPER_GRADIENT_KEY']) assert.ok(defaults.includes(`[${key}]: null`))
  assert.ok(defaults.includes('[STORAGE_KEY]: "tavern-terracotta"'))
  assert.match(client, /gradient && \(followsSkin\(\) \|\| !userSetWallpaper\(\)\)/)
  assert.match(client, /readStorage\(FACTORY_APPLIED_KEY\) != null \|\| hasAnyStoredValue/)
})
