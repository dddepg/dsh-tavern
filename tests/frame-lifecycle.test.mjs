import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../tavern-plugin/src/client/modules/frame-lifecycle.js', import.meta.url), 'utf8')
const create = vm.runInNewContext(source + '; createTavernFrameLifecycle')

test('opening sender checks ownership again before dispatch and retries rejected work', async () => {
  const lifetime = create({})
  let valid = true, calls = 0, fail = true
  const sender = lifetime.sender({ once: true, valid: () => valid, submit() { calls++; if (fail) throw Error('retry'); return 'done' } })
  const stale = sender.send('start')
  valid = false
  await assert.rejects(stale, /关闭/)
  assert.equal(calls, 0)
  valid = true
  const failed = sender.send('start')
  assert.equal(sender.send('start'), failed)
  await assert.rejects(failed, /retry/)
  fail = false
  assert.equal(await sender.send('start'), 'done')
  await sender.send('start')
  assert.equal(calls, 2)
  lifetime.dispose()
  await assert.rejects(sender.send('start'), /关闭/)
})

test('disposal cancels pending document mounts and invalidates queued sends', async () => {
  const timers = new Map()
  const lifetime = create({ setTimeout(fn) { timers.set(1, fn); return 1 }, clearTimeout(id) { timers.delete(id) } }, { body: null })
  lifetime.mount(() => assert.fail('disposed frame mounted'), assert.fail)
  assert.equal(timers.size, 1)
  let called = false
  const pending = lifetime.sender({ submit() { called = true } }).send('queued')
  lifetime.dispose()
  assert.equal(timers.size, 0)
  await assert.rejects(pending, /关闭/)
  assert.equal(called, false)
})
