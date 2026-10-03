
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSceneImageDiagnostics, redactSceneDiagnostic } from '../tavern-plugin/lib/domain/scene-image-diagnostics.js'

import { generateSceneImage } from '../tavern-plugin/lib/domain/scene-image-provider.js'

function storage() {
  const values = new Map()
  return { values, async readJson(path) { return structuredClone(values.get(path)) }, async updateJson(path, update) { const value = await update(values.get(path)); values.set(path, structuredClone(value)); return value } }
}
const attempt = (n, stage = 'planning', status = 'running') => ({ requestId: 'request-' + n, targetKey: 'body-' + n, sessionId: 'parent', stage, status, createdAt: Date.now() - 10, details: { prompt: '画面' } })

test('generation request diagnostics retain bounded AggregateError cause codes', async () => {
  const events = []
  const cause = new AggregateError([
    Object.assign(new Error('sensitive network details'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('certificate'), { code: 'CERT_HAS_EXPIRED' }),
    Object.assign(new Error('unrecognized'), { code: 'arbitrary-secret' })
  ])
  await assert.rejects(generateSceneImage({ provider: 'novelai', baseURL: 'https://image.novelai.net',
    model: 'nai-diffusion-5-full', size: '832x1216', prompt: 'A lake', apiKey: 'test-key',
    signal: new AbortController().signal, onProviderRequest: event => events.push(event)
  }, { fetch: async () => { throw new TypeError('fetch failed', { cause }) } }), /fetch failed/)
  const failure = events.find(event => event.phase === 'transport-error')
  assert.deepEqual(failure.networkCodes, ['ECONNREFUSED', 'CERT_HAS_EXPIRED'])
  assert.doesNotMatch(JSON.stringify(failure), /sensitive network details|arbitrary-secret/)
})

test('attempt journal replaces snapshots without losing older attempts or stage events and survives a new reader', async () => {
  const disk = storage(), logs = createSceneImageDiagnostics(disk)
  const first = attempt(1)
  await logs.record('chat', first)
  await logs.record('chat', { ...first, stage: 'generating' })
  await logs.record('chat', { ...first, stage: 'generating', status: 'failed', error: 'unconfirmed' })
  await logs.record('chat', attempt(2, 'completed', 'succeeded'))
  const result = await createSceneImageDiagnostics(disk).read('chat')
  assert.equal(result.records.length, 2)
  assert.deepEqual(result.records[0].events.map(event => event.stage), ['planning', 'generating', 'generating'])
  assert.ok(result.records[0].stageDurationsMs.planning >= 0)
  assert.ok(result.records[0].durationMs >= 0)
  assert.equal(result.records[0].error, 'unconfirmed')
  assert.equal((await logs.read('other')).records.length, 0)
})

test('diagnostics redact known secrets, credentials, signed URLs and image bytes before persistence', async () => {
  const disk = storage(), logs = createSceneImageDiagnostics(disk)
  const value = { ...attempt(1), details: { apiKey: 'key-content', prompt: 'plain known-token-value', nested: { password: 'pass-content' },
    address: 'https://user:password@host/image?signature=signed-query', headers: { authorization: 'Bearer auth-content' },
    picture: Buffer.from('IMAGE-BYTES'), base64: 'IMAGE-BASE64', uri: 'data:image/png;base64,OTHER-BYTES' } }
  await logs.record('chat', value, ['known-token-value'])
  const text = JSON.stringify([...disk.values.values()])
  for (const word of ['key-content', 'known-token-value', 'pass-content', 'signed-query', 'auth-content', 'IMAGE-BYTES', 'IMAGE-BASE64', 'OTHER-BYTES']) assert.ok(!text.includes(word), word)
  assert.match(text, /REDACTED/)
  assert.equal(redactSceneDiagnostic(new Uint8Array([1, 2])), '[image bytes omitted]')
})

test('legacy logs remain readable when migration publication fails, then migrate without losing history', async () => {
  const { createHash } = await import('node:crypto')
  const disk = storage()
  const path = 'diagnostics/scene-' + createHash('sha256').update('chat').digest('hex') + '.json'
  const legacy = { version: 1, chatId: 'chat', dropped: 3, records: [{ ...attempt(1), events: [{ at: 1, stage: 'planning', status: 'running' }] }] }
  disk.values.set(path, structuredClone(legacy))
  const logs = createSceneImageDiagnostics(disk)
  assert.deepEqual(await logs.read('chat'), legacy)
  const update = disk.updateJson
  let fail = true
  disk.updateJson = async (file, updater) => {
    if (file === path && fail) { await updater(structuredClone(disk.values.get(file))); throw new Error('index failure') }
    return update(file, updater)
  }
  await assert.rejects(logs.record('chat', attempt(2)), /index failure/)
  assert.deepEqual(await logs.read('chat'), legacy)
  fail = false
  await logs.record('chat', attempt(2))
  const restored = await createSceneImageDiagnostics(disk).read('chat')
  assert.equal(restored.dropped, 3)
  assert.deepEqual(restored.records[0], legacy.records[0])
  assert.equal(restored.records[1].requestId, 'request-2')
  assert.equal(disk.values.get(path).version, 2)
})

test('retention removes evicted detail files and retries failed cleanup without losing live attempts', async () => {
  const disk = storage(), logs = createSceneImageDiagnostics(disk)
  let failRemoval = true
  disk.remove = async path => { if (failRemoval) throw Error('busy'); disk.values.delete(path) }
  for (let n = 0; n < 25; n++) await logs.record('chat', { ...attempt(n), details: { prompt: 'x'.repeat(100000) } })
  const before = await logs.read('chat')
  assert.ok(before.dropped > 0)
  assert.ok(Buffer.byteLength(JSON.stringify(before)) < 2 * 1024 * 1024)
  const evicted = 0
  // Reintroduce an evicted identity while failed removals remain pending.
  await logs.record('chat', attempt(evicted, 'revived'))
  failRemoval = false
  await logs.record('chat', attempt(24, 'latest'))
  const result = await logs.read('chat')
  assert.equal(result.records.find(row => row.requestId === 'request-0').stage, 'revived')
  assert.equal(disk.values.size, result.records.length + 1)
  assert.ok(result.records.every(row => !row.unavailable))
})
