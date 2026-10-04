import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { parse } from 'acorn'

const source = await readFile(new URL('../tavern-plugin/src/client/runtime/helper-event-api.js', import.meta.url), 'utf8')
const install = vm.runInNewContext(source + '\ninstallTavernHelperEventApi')
const sharedSource = await readFile(new URL('../tavern-plugin/src/client/runtime/helper-facade.js', import.meta.url), 'utf8')
const sharedDeclaration = parse(sharedSource, { ecmaVersion: 'latest' }).body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'createTavernHelperEventBus')
const createSharedBus = vm.runInNewContext('(' + sharedSource.slice(sharedDeclaration.start, sharedDeclaration.end) + ')')
const tick = () => new Promise(resolve => setImmediate(resolve))
function local(extra = {}) {
  const window = { ...extra }
  const lifecycle = install(window, { localEvents: true })
  return { window, ...lifecycle }
}
function shared() {
  let owner = 'a'
  const bus = createSharedBus({
    currentScript: () => ({ id: owner }),
    withScript: async (id, fn) => { const before = owner; owner = id; try { return await fn() } finally { owner = before } },
    reportSubscriptions() {}, post() {}
  })
  const window = {
    eventOn: (name, listener) => bus.listen(name, listener),
    eventOnce: (name, listener) => bus.listen(name, listener, null, true),
    eventMakeFirst: (name, listener) => bus.listen(name, listener, 'first'),
    eventMakeLast: (name, listener) => bus.listen(name, listener, 'last'),
    eventOff: bus.off, eventRemoveListener: bus.off,
    eventClearEvent: bus.clearEvent, eventClearListener: bus.clearListener, eventClearAll: bus.clearAll,
    eventEmit: bus.emit
  }
  const before = { ...window }, lifecycle = install(window)
  return { window, before, bus, ...lifecycle, owner: () => owner, setOwner(value) { owner = value } }
}

test('event installer serializes without closures and supplies namespace accessors and constants', async () => {
  const serialized = vm.runInNewContext('(' + install.toString() + ')')
  const window = { iframe_events: { GENERATION_STARTED: 'custom-start', CUSTOM: 'custom' }, tavern_events: { MESSAGE_SENT: 'MESSAGE_SENT' } }
  serialized(window, { localEvents: true })
  assert.equal(window.TavernHelper.eventOn, window.eventOn)
  assert.equal(window.TavernHelper.initializeGlobal, window.initializeGlobal)
  assert.equal(window.iframe_events.GENERATION_STARTED, 'custom-start')
  assert.equal(window.iframe_events.GENERATION_REQUESTED, 'js_generation_requested')
  assert.equal(window.iframe_events.STREAM_TOKEN_RECEIVED_FULLY, 'js_stream_token_received_fully')
  assert.equal(window.iframe_events.STREAM_TOKEN_RECEIVED_INCREMENTALLY, 'js_stream_token_received_incrementally')
  assert.equal(window.iframe_events.GENERATION_ENDED, 'js_generation_ended')
  assert.equal(window.iframe_events.CUSTOM, 'custom')
  assert.equal(window.tavern_events.USER_MESSAGE_RENDERED, 'user_message_rendered')
  assert.equal(window.tavern_events.CHARACTER_MESSAGE_RENDERED, 'character_message_rendered')
  assert.equal(window.tavern_events.MESSAGE_SENT, 'MESSAGE_SENT')
  const replacement = () => 7
  window.TavernHelper.eventEmit = replacement
  assert.equal(window.eventEmit, replacement)
  assert.equal(await window.eventEmitAndWait('anything'), undefined)
})

test('local subscriptions deduplicate, reorder and expose stable idempotent stop handles', async () => {
  const { window: api } = local(), seen = []
  const a = () => seen.push('a'), b = () => seen.push('b'), c = () => seen.push('c')
  const first = api.eventOn('order', a)
  api.eventOn('order', a)
  api.eventOn('order', b)
  api.eventMakeFirst('order', c)
  api.eventMakeLast('order', a)
  await api.eventEmitAndWait('order')
  assert.deepEqual(seen, ['c', 'b', 'a'])
  first.stop(); first.stop()
  api.eventMakeFirst('order', b)
  seen.length = 0
  await api.eventEmit('order')
  assert.deepEqual(seen, ['b', 'c'])
  assert.throws(() => api.eventOn('order', null), /监听器必须是函数/)
})

test('once listeners are removed before recursion or overlapping emissions', async () => {
  const { window: api } = local()
  let once = 0, regular = 0
  const listener = () => { regular++ }
  api.eventOn('once', listener)
  api.eventOnce('once', listener)
  api.eventOnce('once', async () => { once++; await api.eventEmit('once') })
  await Promise.all([api.eventEmitAndWait('once'), api.eventEmitAndWait('once')])
  assert.equal(once, 1)
  assert.equal(regular, 3, 'eventOnce does not replace an existing regular subscription')
  let originalOnce = 0
  const single = () => { originalOnce++ }
  api.eventOnce('other', single); api.eventMakeLast('other', single); api.eventOn('other', single)
  await api.eventEmit('other'); await api.eventEmit('other')
  assert.equal(originalOnce, 1, 'reordering or duplicate eventOn preserves the once flag')
})

test('removal during emission skips removed entries and old handles cannot remove new registrations', async () => {
  const { window: api } = local(), seen = []
  const old = () => seen.push('old'), added = () => seen.push('added')
  api.eventOnce('change', () => { api.eventOff('change', old); api.eventOn('change', added) })
  const oldHandle = api.eventOn('change', old)
  await api.eventEmit('change')
  assert.deepEqual(seen, [])
  api.eventOn('change', old)
  oldHandle.stop()
  await api.eventEmit('change')
  assert.deepEqual(seen, ['added', 'old'])
})

test('local removal and clear APIs handle event aliases and prototype-looking custom names', async () => {
  const { window: api } = local(), seen = []
  const listener = value => seen.push(value)
  api.eventOn('message_received', listener)
  await api.eventEmit('MESSAGE_RECEIVED', 1)
  api.eventRemoveListener('MESSAGE_RECEIVED', listener)
  await api.eventEmit('message_received', 2)
  for (const name of ['__proto__', 'constructor', 'toString']) {
    api.eventOn(name, listener)
    await api.eventEmit(name, name)
  }
  api.eventClearListener(listener)
  await api.eventEmit('__proto__', 'removed')
  api.eventOn('one', listener); api.eventOn('two', listener)
  api.eventClearEvent('one')
  await api.eventEmit('one', 'removed')
  await api.eventEmit('two', 3)
  api.eventClearAll()
  await api.eventEmit('two', 'removed')
  assert.deepEqual(seen, [1, '__proto__', 'constructor', 'toString', 3])
})

for (const kind of ['local', 'shared']) test(kind + ' eventEmitAndWait awaits ordered async callbacks and preserves thrown errors', async () => {
  const { window: api } = kind === 'local' ? local() : shared()
  const seen = [], original = new Error('original failure')
  let release, completed = false
  api.eventOn('save', async (value) => { seen.push(value); await new Promise(resolve => { release = resolve }); seen.push('saved') })
  api.eventOn('save', () => seen.push('next'))
  const pending = api.eventEmitAndWait('save', 'start').then(() => { completed = true })
  await tick()
  assert.equal(completed, false)
  assert.deepEqual(seen, ['start'])
  release(); await pending
  assert.deepEqual(seen, ['start', 'saved', 'next'])
  api.eventOn('sync-error', () => { throw original })
  api.eventOn('async-error', async () => { throw original })
  await assert.rejects(api.eventEmitAndWait('sync-error'), error => error === original)
  await assert.rejects(api.eventEmitAndWait('async-error'), error => error === original)
})

for (const kind of ['local', 'shared']) test(kind + ' eventWaitOnce registers immediately, resolves arguments and unsubscribes', async () => {
  const run = kind === 'local' ? local() : shared(), api = run.window
  const value = { retained: true }, pending = api.eventWaitOnce('next')
  await api.eventEmitAndWait('next', value, 2)
  const result = await pending
  assert.equal(result[0], value)
  assert.equal(result[1], 2)
  assert.equal(result.length, 2)
  if (run.bus) assert.deepEqual(Array.from(run.bus.names()), [])
  await api.eventEmitAndWait('next', 'again')
  assert.equal((await pending)[0], value)
})

test('waiting rejects registration failures instead of hanging', async () => {
  const original = new Error('registration failed')
  const window = { eventOn() { throw original }, eventOff() {}, eventEmit() {} }
  install(window)
  await assert.rejects(window.eventWaitOnce('bad'), error => error === original)
  await assert.rejects(window.waitGlobalInitialized('missing'), error => error === original)
})

for (const kind of ['local', 'shared']) test(kind + ' global wait really waits, skips bootstrap objects and returns the published value', async () => {
  const run = kind === 'local' ? local() : shared(), api = run.window
  let ready = false
  api.Mvu = { __dshBootstrap: true }
  const pending = api.waitGlobalInitialized('Mvu').then(value => { ready = true; return value })
  await tick()
  assert.equal(ready, false)
  await api.eventEmitAndWait('global_Mvu_initialized')
  await api.initializeGlobal('unrelated', {})
  assert.equal(ready, false)
  const real = { getMvuData() {} }
  await api.initializeGlobal('Mvu', real)
  assert.equal(await pending, real)
  assert.equal(await api.waitGlobalInitialized('Mvu'), real)
  for (const value of [null, false, 0, '']) {
    await api.initializeGlobal('value', value)
    assert.equal(await api.waitGlobalInitialized('value'), value)
  }
  if (run.bus) assert.deepEqual(Array.from(run.bus.names()), [])
})

test('global waiting stays local to its installed target', async () => {
  const one = local(), two = local()
  let secondReady = false
  const first = one.window.waitGlobalInitialized('Module')
  const second = two.window.waitGlobalInitialized('Module').then(value => { secondReady = true; return value })
  const firstValue = {}, secondValue = {}
  await one.window.initializeGlobal('Module', firstValue)
  assert.equal(await first, firstValue)
  await tick()
  assert.equal(secondReady, false)
  await two.window.initializeGlobal('Module', secondValue)
  assert.equal(await second, secondValue)
})

test('shared utility installation preserves real script ownership, stop handles and per-script clearing', async () => {
  const run = shared(), api = run.window, seen = []
  for (const key of Object.keys(run.before)) assert.equal(api[key], run.before[key], key)
  const callback = () => seen.push(run.owner())
  const a = api.eventOn('custom', callback)
  run.setOwner('b'); api.eventOn('custom', callback)
  api.eventClearAll()
  await api.eventEmitAndWait('custom')
  assert.deepEqual(seen, ['a'])
  a.stop()
  assert.deepEqual(Array.from(run.bus.names()), [])
  run.setOwner('a'); const first = api.waitGlobalInitialized('Shared')
  run.setOwner('b'); const second = api.waitGlobalInitialized('Shared')
  run.setOwner('publisher'); const value = {}
  await api.initializeGlobal('Shared', value)
  assert.equal(await first, value); assert.equal(await second, value)
  assert.deepEqual(Array.from(run.bus.names()), [])
})

test('global waiting rechecks readiness after registration and cleans up on getter errors', async () => {
  const run = shared(), api = run.window, originalOn = api.eventOn
  const value = {}, error = new Error('unreadable global')
  api.eventOn = (name, handler) => { const result = originalOn(name, handler); api.Raced = value; return result }
  assert.equal(await api.waitGlobalInitialized('Raced'), value)
  api.eventOn = originalOn
  const pending = api.waitGlobalInitialized('Broken')
  Object.defineProperty(api, 'Broken', { get() { throw error } })
  const rejected = assert.rejects(pending, reason => reason === error)
  await api.eventEmitAndWait('global_Broken_initialized')
  await rejected
  assert.deepEqual(Array.from(run.bus.names()), [])
})

test('pagehide rejects pending waits and releases their subscriptions without later callbacks', async () => {
  let onPagehide, removed = false
  const run = local({ addEventListener(name, listener) { assert.equal(name, 'pagehide'); onPagehide = listener },
    removeEventListener(name, listener) { removed = name === 'pagehide' && listener === onPagehide } })
  const waitingEvent = assert.rejects(run.window.eventWaitOnce('never'), error => error.name === 'AbortError')
  const waitingGlobal = assert.rejects(run.window.waitGlobalInitialized('never'), error => error.name === 'AbortError')
  onPagehide(); run.dispose()
  await Promise.all([waitingEvent, waitingGlobal])
  assert.equal(removed, true)
  assert.throws(() => run.window.eventOn('late', () => {}), error => error.name === 'AbortError')
  await assert.rejects(run.window.eventEmitAndWait('late'), error => error.name === 'AbortError')
  await assert.rejects(run.window.eventWaitOnce('late'), error => error.name === 'AbortError')
  await assert.rejects(run.window.waitGlobalInitialized('late'), error => error.name === 'AbortError')
})

test('invalid and read-only global names fail explicitly without prototype changes', async () => {
  const { window: api } = local(), before = Object.getPrototypeOf(api)
  for (const name of ['', undefined, '__proto__']) {
    assert.throws(() => api.initializeGlobal(name, {}), /名称无效/)
    await assert.rejects(api.waitGlobalInitialized(name), /名称无效/)
  }
  Object.defineProperty(api, 'readonly', { value: 1 })
  assert.throws(() => api.initializeGlobal('readonly', 2), /不可写/)
  assert.equal(Object.getPrototypeOf(api), before)
})
