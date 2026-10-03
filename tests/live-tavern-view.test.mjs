import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadFactory() {
  const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  let descriptor
  const sandbox = { window: { __ModuleLoader__: { load(value) { descriptor = value } }, setInterval, clearInterval }, console, AbortController }
  vm.runInNewContext(source, sandbox)
  return descriptor.factory(function () { return {} }).createLiveTavernViewModule
}

function fakeTimers() {
  const pending = []
  return {
    schedule(run, delay) {
      const timer = { run, delay, cancelled: false }
      pending.push(timer)
      return timer
    },
    cancel(timer) { timer.cancelled = true },
    async runNext() {
      const timer = pending.find(function (item) { return !item.cancelled })
      assert.ok(timer, 'expected a scheduled refresh')
      timer.cancelled = true
      timer.run()
      await new Promise(function (resolve) { setImmediate(resolve) })
      return timer.delay
    },
    dropAll() { pending.forEach(function (item) { item.cancelled = true }) },
    activeDelays() { return pending.filter(function (item) { return !item.cancelled }).map(function (item) { return item.delay }) }
  }
}

function fakeIntervals() {
  const active = []
  return {
    start(run, delay) {
      const interval = { run, delay, cancelled: false }
      active.push(interval)
      return interval
    },
    stop(interval) { interval.cancelled = true },
    async tick() {
      const interval = active.find(function (item) { return !item.cancelled })
      assert.ok(interval, 'expected an active watchdog')
      interval.run()
      await new Promise(function (resolve) { setImmediate(resolve) })
      return interval.delay
    }
  }
}

const createLiveTavernViewModule = await loadFactory()

test('后台已空闲但主轮询定时器丢失时，watchdog 会恢复权威查询并解除 busy', async function () {
  const timers = fakeTimers()
  const watchdog = fakeIntervals()
  const statuses = [true, false]
  const module = createLiveTavernViewModule({
    load: async function () { return { view: { busy: statuses.shift() || false } } },
    shouldPoll(view) { return view && view.busy === true },
    schedule: timers.schedule,
    cancel: timers.cancel,
    startWatchdog: watchdog.start,
    stopWatchdog: watchdog.stop,
    watchdogIntervalMs: 1000
  })
  const stop = module.subscribe('session-watchdog', function () {})

  await timers.runNext()
  assert.equal(module.getSnapshot('session-watchdog').view.busy, true)
  timers.dropAll()

  assert.equal(await watchdog.tick(), 1000)
  assert.equal(module.getSnapshot('session-watchdog').view.busy, false)
  stop()
})

test('候选 Agent 长时间生成时状态查询只在内部重试，不产生超时错误', async function () {
  const timers = fakeTimers()
  let generating = false
  let loads = 0
  const module = createLiveTavernViewModule({
    loadTimeoutMs: 2000,
    load: async function (_sessionId, request) {
      loads += 1
      if (!generating) return { view: { busy: false } }
      return await new Promise(function (_resolve, reject) {
        request.signal.addEventListener('abort', function () { reject(new Error('aborted')) })
      })
    },
    shouldPoll(view) { return view && view.busy === true },
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const stop = module.subscribe('session-generating', function () {})

  await timers.runNext()
  generating = true
  module.invalidate('session-generating')
  await timers.runNext()

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await timers.runNext()
    assert.equal(module.getSnapshot('session-generating').phase, 'retrying')
    assert.equal(module.getSnapshot('session-generating').error, '')
    assert.deepEqual(timers.activeDelays(), [1500])
    if (cycle < 2) await timers.runNext()
  }

  generating = false
  await timers.runNext()
  assert.equal(loads, 5)
  assert.equal(module.getSnapshot('session-generating').phase, 'ready')
  assert.equal(module.getSnapshot('session-generating').view.busy, false)
  assert.equal(module.getSnapshot('session-generating').error, '')
  stop()
})

test('人物卡删除后的状态错误进入不可用终态，不再自动重试并重复弹错', async function () {
  const timers = fakeTimers()
  let loads = 0
  const module = createLiveTavernViewModule({
    load: async function () { loads += 1; throw new Error('人物卡不存在: cards/Erin.json') },
    shouldPoll() { return false },
    isTerminalError(error) { return /人物卡不存在:/.test(String(error && error.message || error || '')) },
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const stop = module.subscribe('deleted-card-session', function () {})

  await timers.runNext()
  const snapshot = module.getSnapshot('deleted-card-session')
  const delays = timers.activeDelays()
  stop()

  assert.equal(loads, 1)
  assert.equal(snapshot.phase, 'unavailable')
  assert.match(snapshot.error, /人物卡不存在: cards\/Erin\.json/)
  assert.deepEqual(delays, [])
})

test('逐层挂载历史消息共享已有视图，不为每层重新请求', async () => {
  const create = await loadFactory()
  const timers = fakeTimers()
  let loads = 0
  const view = create({ load: async () => { loads++; return { view: { settleStatus: 'idle' } } },
    schedule: timers.schedule, cancel: timers.cancel, startWatchdog: () => null, stopWatchdog() {} })
  const disposers = [view.subscribe('history', () => {})]
  await timers.runNext()
  for (let i = 0; i < 40; i++) {
    disposers.push(view.subscribe('history', () => {}))
    if (timers.activeDelays().length) await timers.runNext()
  }
  disposers.forEach(dispose => dispose())
  assert.equal(loads, 1)
})

test('历史消息 hook 首次挂载不强制刷新，后续修订仍刷新', async () => {
  const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  const start = source.indexOf('function useLiveTavernView(')
  const end = source.indexOf('function useTavernCoordination(', start)
  let previous
  let effects = []
  const invalidated = []
  const context = { React: {
    useState: init => [init(), () => {}],
    useCallback: fn => fn, useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useRef: initial => (previous ||= { current: initial }),
    useEffect: effect => effects.push(effect)
  }, liveTavernView: { getSnapshot: () => ({}), subscribe: () => () => {}, invalidate: id => invalidated.push(id) } }
  vm.runInNewContext(source.slice(start, end) + ';this.render=useLiveTavernView;', context)
  function render(id, revision) { effects = []; context.render(id, revision); effects.forEach(effect => effect()) }
  render('game', 'closed:1')
  render('game', 'closed:1')
  assert.deepEqual(invalidated, [])
  render('game', 'closed:2')
  assert.deepEqual(invalidated, ['game'])
  render('other', 'closed:5')
  assert.deepEqual(invalidated, ['game'])
})

test('快照回收保护订阅者；过期请求不能复活旧快照；返回重新加载', async () => {
  const timers = fakeTimers(); let resolve
  const module = createLiveTavernViewModule({ load: () => new Promise(r => { resolve = r }),
    schedule: timers.schedule, cancel: timers.cancel, pollWhileBusy: false })
  const stop = module.subscribe('A', () => {})
  await timers.runNext()
  assert.equal(module.evict('A'), false)
  stop()
  assert.equal(module.evict('A'), true)
  const fresh = module.getSnapshot('A')
  resolve({ view: { old: true } }); await new Promise(r => setImmediate(r))
  assert.equal(module.getSnapshot('A'), fresh)
  assert.equal(fresh.view, null)
  const stopAgain = module.subscribe('A', () => {})
  await timers.runNext(); resolve({ view: { fresh: true } })
  await new Promise(r => setImmediate(r))
  assert.equal(module.getSnapshot('A').view.fresh, true)
  stopAgain(); module.evict('A')
})

test('脚本会话在 messagesPending 期间不同步 execution', async () => {
  const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /messagesPending/)
  assert.match(source, /hydrateTavernHelperMessages/)
  assert.match(source, /wait for hydration before scripts/)
})
