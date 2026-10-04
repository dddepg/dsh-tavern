import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { deferred, flush, syncClock } from './fixtures/sync-clock.mjs'
const source = readFileSync(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
let descriptor
vm.runInNewContext(source, { AbortController, window: { __ModuleLoader__: { load(value) { descriptor = value } } }, console })
const client = descriptor.factory(() => ({}))

function liveHarness(options = {}) {
  const clock = syncClock(), reads = [], hydrated = []
  const live = client.createLiveTavernViewModule({ ...clock, pollWhileBusy: false, loadTimeoutMs: 1000, timeoutRetryDelayMs: 5000,
    load(sessionId, request) { const read = deferred(); reads.push({ ...read, sessionId, request }); return read.promise },
    hydrateHelperMessages(sessionId, view, request) { const read = deferred(); hydrated.push({ ...read, sessionId, view, request }); return read.promise }, ...options })
  return { live, clock, reads, hydrated }
}
for (const outcome of ['resolve', 'reject']) test(`live setView fences stale HTTP ${outcome} including already queued reload`, async () => {
  const h = liveHarness(), stop = h.live.subscribe('A', () => {})
  await h.clock.next(); h.live.invalidate('A')
  h.live.setView('A', { state: 'new local' })
  assert.equal(h.reads[0].request.signal.aborted, true)
  h.reads[0][outcome](outcome === 'resolve' ? { view: { state: 'old HTTP' } } : new Error('late error'))
  await flush(); await h.clock.advance(10000)
  assert.equal(h.live.getSnapshot('A').phase, 'ready')
  assert.equal(h.live.getSnapshot('A').view.state, 'new local')
  assert.equal(h.reads.length, 1); assert.deepEqual(h.clock.delays(), [])
  stop()
})
for (const outcome of ['resolve', 'reject']) test(`live replacement fences stale asynchronous hydration ${outcome}`, async () => {
  const h = liveHarness(), stop = h.live.subscribe('A', () => {})
  await h.clock.next()
  h.reads[0].resolve({ view: { tavernHelper: { messagesPending: { from: 0, to: 1 } } } }); await flush()
  assert.equal(h.hydrated.length, 1)
  h.live.setView('A', { state: 'new view' })
  h.hydrated[0][outcome](outcome === 'resolve' ? { state: 'old hydrated' } : new Error('old hydration error'))
  await flush()
  assert.equal(h.live.getSnapshot('A').view.state, 'new view')
  assert.equal(h.live.getSnapshot('A').phase, 'ready'); assert.deepEqual(h.clock.delays(), [])
  stop()
})
test('live A to B to A without cache eviction gives each subscribed lifetime fresh ownership', async () => {
  const h = liveHarness(); let stop = h.live.subscribe('A', () => {})
  await h.clock.next(); stop(); stop = h.live.subscribe('B', () => {}); await h.clock.next()
  h.reads[1].resolve({ view: { state: 'B' } }); await flush(); stop()
  stop = h.live.subscribe('A', () => {}); await h.clock.next()
  h.reads[2].resolve({ view: { state: 'A new lifetime' } }); await flush()
  h.reads[0].resolve({ view: { state: 'A retired' } }); await flush()
  assert.equal(h.live.getSnapshot('A').view.state, 'A new lifetime')
  assert.equal(h.live.getSnapshot('B').view.state, 'B')
  stop(); assert.deepEqual(h.clock.delays(), [])
})
test('live unsubscribe aborts hydration and starts a new read without awaiting old hydration', async () => {
  const h = liveHarness(); const stop = h.live.subscribe('A', () => {})
  await h.clock.next(); h.reads[0].resolve({ view: { tavernHelper: { messagesPending: {} } } }); await flush()
  stop(); assert.equal(h.hydrated[0].request.signal.aborted, true)
  const stopAgain = h.live.subscribe('A', () => {}); await h.clock.next()
  h.reads[1].resolve({ view: { fresh: true } }); await flush()
  h.hydrated[0].reject(new Error('old hydration')); await flush()
  assert.equal(h.live.getSnapshot('A').view.fresh, true); assert.equal(h.live.getSnapshot('A').phase, 'ready')
  stopAgain()
})
test('live retry-not-before survives invalidations after timeout', async () => {
  const h = liveHarness(), stop = h.live.subscribe('A', () => {})
  await h.clock.next(); h.live.invalidate('A'); await h.clock.advance(1000)
  assert.equal(h.live.getSnapshot('A').phase, 'retrying')
  for (let i = 0; i < 4; i++) { h.live.invalidate('A'); await h.clock.advance(1000); assert.equal(h.reads.length, 1) }
  h.live.invalidate('A'); await h.clock.advance(1000); assert.equal(h.reads.length, 2)
  h.reads[1].resolve({ view: { recovered: true } }); await flush()
  assert.equal(h.live.getSnapshot('A').view.recovered, true); stop()
})

function coordinationHarness() {
  const clock = syncClock(), connections = [], reads = [], seen = []
  const module = client.createTavernCoordinationEventModule({
    onView: (id, view) => seen.push({ id, view }),
    connect(id, handlers) { return client.createTavernCoordinationConnection({ ...clock, loadTimeoutMs: 1000,
      handlers, load(request) { const work = deferred(); reads.push({ ...work, id, request }); return work.promise },
      subscribe(message, error, connected) { const connection = { id, message, error, connected, stopped: false }; connections.push(connection); return () => { connection.stopped = true } }
    }) }
  })
  return { module, clock, connections, reads, seen }
}
for (const outcome of ['resolve', 'reject']) test(`coordination push snapshot wins over pending HTTP ${outcome} and old queued refresh`, async () => {
  const h = coordinationHarness(), stop = h.module.subscribe('A', () => {})
  await h.clock.next(); h.reads[0].resolve({ busy: true }); await flush()
  h.module.invalidate('A'); await h.clock.next(); h.module.invalidate('A')
  h.connections[0].message({ snapshot: { busy: false, completed: true } })
  h.reads[1][outcome](outcome === 'resolve' ? { busy: true } : new Error('obsolete error')); await flush()
  assert.equal(h.module.getSnapshot('A').phase, 'ready')
  assert.equal(h.module.getSnapshot('A').view.completed, true)
  assert.equal(h.reads[1].request.signal.aborted, true)
  assert.deepEqual(h.clock.delays(), []); assert.equal(h.reads.length, 2)
  stop()
})
test('coordination reconnect cached snapshot is followed by a fresh HTTP baseline', async () => {
  const h = coordinationHarness(), stop = h.module.subscribe('A', () => {})
  const signal = h.connections[0]
  signal.connected(); signal.message({ snapshot: { cached: true } })
  await h.clock.next(); assert.equal(h.reads.length, 1)
  h.reads[0].resolve({ baseline: 1 }); await flush()
  signal.error(new Error('disconnect')); signal.connected(); signal.message({ snapshot: { cached: true } })
  await h.clock.next(); h.reads[1].resolve({ baseline: 2 }); await flush()
  assert.equal(h.module.getSnapshot('A').view.baseline, 2); stop()
})
test('coordination no-snapshot wakeups coalesce and recover real failures with bounded retry', async () => {
  const h = coordinationHarness(), stop = h.module.subscribe('A', () => {})
  await h.clock.next()
  for (let i = 0; i < 100; i++) h.connections[0].message({ kind: 'tavern-state' })
  h.reads[0].reject(new Error('offline')); await flush()
  assert.equal(h.module.getSnapshot('A').phase, 'retrying')
  for (let i = 0; i < 4; i++) { h.module.invalidate('A'); await h.clock.advance(1000); assert.equal(h.reads.length, 1) }
  await h.clock.advance(1000); h.reads[1].resolve({ recovered: true }); await flush()
  assert.equal(h.module.getSnapshot('A').view.recovered, true); stop()
})
test('coordination stopped connections cannot change re-subscribed session or another session', async () => {
  const h = coordinationHarness(); const stopA = h.module.subscribe('A', () => {}), stopB = h.module.subscribe('B', () => {})
  await h.clock.advance(0); stopA()
  const stopAgain = h.module.subscribe('A', () => {}); await h.clock.advance(0)
  h.connections[2].message({ snapshot: { session: 'fresh A' } })
  h.connections[1].message({ snapshot: { session: 'B' } })
  h.connections[0].message({ snapshot: { session: 'old A' } }); h.connections[0].error(new Error('old error')); h.connections[0].connected()
  h.reads[0].resolve({ session: 'old HTTP A' }); await flush()
  assert.equal(h.module.getSnapshot('A').view.session, 'fresh A')
  assert.equal(h.module.getSnapshot('A').phase, 'ready'); assert.equal(h.module.getSnapshot('B').view.session, 'B')
  stopAgain(); stopB(); assert.deepEqual(h.clock.delays(), [])
})
test('coordination local accepted replacement revokes pending HTTP', async () => {
  const h = coordinationHarness(), stop = h.module.subscribe('A', () => {})
  await h.clock.next(); h.module.setView('A', { local: true })
  h.reads[0].resolve({ old: true }); await flush()
  assert.equal(h.module.getSnapshot('A').view.local, true); assert.deepEqual(h.clock.delays(), []); stop()
})

test('hung hydration times out and retries without allowing a late hydration result to roll back recovery', async () => {
  const h = liveHarness(), stop = h.live.subscribe('A', () => {})
  await h.clock.next(); h.reads[0].resolve({ view: { tavernHelper: { messagesPending: {} } } }); await flush()
  h.live.invalidate('A'); await h.clock.advance(1000)
  assert.equal(h.live.getSnapshot('A').phase, 'retrying'); assert.equal(h.hydrated[0].request.signal.aborted, true)
  assert.deepEqual(h.clock.delays(), [5000])
  await h.clock.advance(5000); h.reads[1].resolve({ view: { recovered: true } }); await flush()
  h.hydrated[0].resolve({ oldHydration: true }); await flush()
  assert.equal(h.live.getSnapshot('A').view.recovered, true); stop()
})

for (const reenter of [false, true]) test(`old optimistic lease release cannot clear a newer view${reenter ? ' across unsubscribe/reentry' : ''}`, async () => {
  const h = liveHarness({ pollWhileBusy: true, shouldPoll: view => view?.busy === true, startWatchdog: () => null, stopWatchdog() {} })
  let stop = h.live.subscribe('A', () => {})
  const oldRelease = h.live.setView('A', { busy: true, owner: 'old' })
  if (reenter) { stop(); stop = h.live.subscribe('A', () => {}) }
  const release = h.live.setView('A', { busy: true, owner: 'new' })
  oldRelease()
  await h.clock.next(); h.reads[0].resolve({ view: { busy: false } }); await flush()
  assert.equal(h.live.getSnapshot('A').view.owner, 'new')
  assert.deepEqual(h.clock.delays(), [200])
  release(); await h.clock.next(); h.reads[1].resolve({ view: { busy: false } }); await flush()
  assert.equal(h.live.getSnapshot('A').view.busy, false); stop()
})

test('unsubscribed optimistic busy does not block the next lifetime idle snapshot', async () => {
  const h = liveHarness({ pollWhileBusy: true, shouldPoll: view => view?.busy === true, startWatchdog: () => null, stopWatchdog() {} })
  let stop = h.live.subscribe('A', () => {})
  const release = h.live.setView('A', { busy: true })
  stop(); stop = h.live.subscribe('A', () => {})
  await h.clock.next(); h.reads[0].resolve({ view: { busy: false } }); await flush()
  assert.equal(h.live.getSnapshot('A').view.busy, false)
  release(); assert.deepEqual(h.clock.delays(), []); stop()
})
