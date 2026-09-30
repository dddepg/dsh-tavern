import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { helperClient } from './fixtures/helper-host-harness.mjs'
const source = await readFile(new URL('../tavern-plugin/src/client/crypto-digest.js', import.meta.url), 'utf8')
function install(crypto = {}) {
  const host = { crypto }
  vm.runInNewContext(source + ';installTavernCryptoSubtlePolyfill(host)', { host, ArrayBuffer, Uint8Array, DataView })
  return host.crypto
}
test('SHA-256 matches Node for empty, Unicode, padding boundaries and large inputs', async () => {
  const crypto = install()
  for (const bytes of [Buffer.alloc(0), Buffer.from('abc'), Buffer.from('酒馆😀'), ...[55, 56, 63, 64, 65, 1024 * 1024].map(n => Buffer.alloc(n, 97))]) {
    assert.equal(Buffer.from(await crypto.subtle.digest({ name: 'SHA-256' }, bytes)).toString('hex'), createHash('sha256').update(bytes).digest('hex'))
  }
})
test('digest respects view offsets, ArrayBuffers and rejects unsupported input', async () => {
  const crypto = install(), data = Uint8Array.from([0, 97, 98, 99, 0])
  for (const value of [data.subarray(1, 4), new DataView(data.buffer, 1, 3), data.buffer.slice(1, 4)]) {
    assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256', value)).toString('hex'), createHash('sha256').update('abc').digest('hex'))
  }
  await assert.rejects(crypto.subtle.digest('SHA-512', data), /SHA-256/)
  await assert.rejects(crypto.subtle.digest('SHA-256', 'abc'), /ArrayBuffer/)
})
test('native crypto and partial native subtle objects are preserved', () => {
  const subtle = { digest() {}, encrypt() {} }, crypto = { subtle, getRandomValues() {} }
  assert.equal(install(crypto), crypto)
  assert.equal(crypto.subtle, subtle)
  const partial = { encrypt() {} }
  assert.equal(install({ subtle: partial }).subtle, partial)
  const locked = Object.preventExtensions({ getRandomValues() {} })
  assert.equal(install(locked), locked)
})
for (const [name, html] of [
  ['display', helperClient.buildTavernFrameDocument({ token: 'test', content: '<script>window.cardLoaded=true</script>' })],
  ['executor', helperClient.buildTavernHelperScriptDocument({ token: 'test', scripts: [], context: {} })]
]) test(`${name} frame installs digest before card scripts/dependencies`, async () => {
  const script = html.match(/<script data-dsh-tavern-crypto>([\s\S]*?)<\/script>/)
  assert.ok(script)
  assert.equal(html.indexOf('<script'), html.indexOf('<script data-dsh-tavern-crypto>'))
  const window = { crypto: {} }
  vm.runInNewContext(script[1], { window, ArrayBuffer, Uint8Array, DataView })
  assert.equal(Buffer.from(await window.crypto.subtle.digest('SHA-256', Buffer.from('abc'))).toString('hex'), createHash('sha256').update('abc').digest('hex'))
})
