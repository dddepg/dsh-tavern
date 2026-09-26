import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { createInitializationTrace } from './fixtures/mvu-initialization-trace.mjs'

test('trace preserves pending work, result identity and rejection; keeps no payloads', async () => {
  let time = 0, resolve
  const trace = createInitializationTrace(() => time, 2)
  const value = { secret: 'private card text' }
  const task = trace.wait('write', new Promise(r => { resolve = r }))
  time = 15000
  assert.equal(trace.snapshot().pending[0].durationMs, 15000)
  resolve(value)
  assert.equal(await task, value)
  const error = new Error('private token')
  await assert.rejects(trace.wait('callback', Promise.reject(error)), actual => actual === error)
  await trace.wait('next', 1)
  assert.equal(trace.snapshot().dropped, 1)
  assert.doesNotMatch(JSON.stringify(trace.snapshot()), /private|secret|token/)
})

test('production timing aggregates repeated writes and exposes stalled work without changing completion', async () => {
  let descriptor, time = 0, resolve
  vm.runInNewContext(await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: value => { descriptor = value } } }, console })
  const client = descriptor.factory(() => ({})), timers = new Map(), reports = []
  let next = 0
  const trace = client.createTavernInitializationTiming({ now: () => time, schedule: fn => { timers.set(++next, fn); return next }, cancel: id => timers.delete(id), report: value => reports.push(value) })
  const task = trace.wait('prompt-drain', new Promise(r => { resolve = r }), 'card-script')
  time = 16000
  const tick = [...timers.values()][0]; timers.clear(); tick()
  assert.equal(reports[0].entries[0].pending, 1)
  assert.equal(reports[0].entries[0].oldestPendingMs, 16000)
  for (let i = 0; i < 100; i++) await trace.wait('prompt-write', true, 'card-script')
  assert.equal(trace.snapshot().entries.length, 2)
  assert.equal(trace.snapshot().entries[1].count, 100)
  resolve('saved'); assert.equal(await task, 'saved')
  const failure = new Error('do not log this secret')
  await assert.rejects(trace.wait('message-write', Promise.reject(failure), 'card-script'), e => e === failure)
  trace.dispose()
  assert.equal(timers.size, 0)
  assert.doesNotMatch(JSON.stringify(reports), /secret/)
})
