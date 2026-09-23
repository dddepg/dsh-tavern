import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createTavernApiDiagnostics } from '../tavern-plugin/lib/domain/tavern-api-diagnostics.js'

const clientSource = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const serverSource = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))
const copy = value => JSON.parse(JSON.stringify(value))

function loadClient() {
  const timers = new Map(), listeners = new Set()
  let id = 0, descriptor
  const window = {
    crypto: { randomUUID: () => 'token-' + ++id },
    setTimeout(run, delay) { timers.set(++id, { run, delay }); return id },
    clearTimeout(handle) { timers.delete(handle) },
    addEventListener(type, run) { if (type === 'message') listeners.add(run) },
    removeEventListener(type, run) { if (type === 'message') listeners.delete(run) },
    __ModuleLoader__: { load(value) { descriptor = value } }
  }
  vm.runInNewContext(clientSource, { window, console: { warn() {} } })
  return {
    client: descriptor.factory(() => ({})),
    timers,
    listeners,
    runTimers(matchDelay) {
      for (const [key, timer] of [...timers]) {
        if (matchDelay === undefined || timer.delay === matchDelay) {
          timers.delete(key)
          timer.run()
        }
      }
    },
    deliver(node, data) {
      for (const run of listeners) run({ source: node.contentWindow, data })
    }
  }
}

function helperRuntime(options = {}) {
  const host = loadClient(), frames = [], mutations = []
  let respond = () => Promise.resolve({ updated: true, contextDelta: { version: 1, chatId: 'c', baseRevision: 1, stateRevision: 2, lifecycleRevision: 1 } })
  const document = {
    body: { appendChild() {} },
    createElement(tag) {
      if (tag === 'div') return { isConnected: true, appendChild() {}, remove() {}, style: {} }
      const frame = {
        contentWindow: { messages: [], postMessage(data) { this.messages.push(copy(data)) } },
        style: {},
        addEventListener(type, run) { if (type === 'load') this.load = run },
        remove() { this.removed = true }
      }
      frames.push(frame)
      return frame
    }
  }
  const runtime = host.client.createTavernHelperScriptRuntime({
    window: host.window,
    document,
    mutationCoalesceMs: options.mutationCoalesceMs ?? 400,
    rpc(method, args, sessionId) {
      return Promise.resolve(respond(method, args, sessionId))
    },
    onMutation(...args) { mutations.push(args) },
    reportError() {},
    resolveError() {}
  })
  const view = {
    chatId: 'chat',
    tavernHelper: { chatId: 'chat', stateRevision: 1, lifecycleRevision: 1, messages: [], chatVariables: {}, scriptVariables: {} },
    tavernHelperScripts: [{ id: 'script', name: 'script', content: 'void 0' }]
  }
  runtime.sync('session', view)
  const frame = frames.at(-1)
  frame.load()
  return {
    host, runtime, frame, mutations,
    respond(fn) { respond = fn },
    ready() {
      host.deliver(frame, {
        token: frame.contentWindow.messages[0].token,
        type: 'dsh-tavern-helper-subscriptions',
        ready: true,
        names: ['MESSAGE_RECEIVED']
      })
    },
    async writeVariables(count = 1) {
      for (let index = 0; index < count; index += 1) {
        host.deliver(frame, {
          token: frame.contentWindow.messages[0].token,
          type: 'dsh-tavern-helper-call',
          requestId: 'var-' + index,
          scriptId: 'script',
          lifecycleRevision: 1,
          method: 'updateTavernHelperVariables',
          args: { option: { type: 'chat' }, variables: { hp: index } }
        })
      }
      await tick()
    }
  }
}

test('compact variable writes during init do not invalidate; later writes coalesce', async () => {
  const run = helperRuntime()
  await run.writeVariables(5)
  assert.equal(run.mutations.length, 0, 'init suppress must hold compact variable invalidates')
  run.ready()
  assert.equal(run.mutations.length, 1, 'suppressed init writes refresh once at readiness')
  assert.equal(run.mutations[0][1], 'initialization-ready')
  await run.writeVariables(8)
  assert.equal(run.mutations.length, 1, 'post-init compact writes wait for coalesce')
  assert.equal([...run.host.timers.values()].some(timer => timer.delay === 400), true)
  run.host.runTimers(400)
  assert.equal(run.mutations.length, 2)
  assert.equal(run.mutations[1][1], 'updateTavernHelperVariables')
  run.runtime.dispose()
})

test('mvuReceiptsOf keeps notable statuses and only a short quiet tail', () => {
  assert.match(serverSource, /quietRows\.slice\(-3\)/)
  assert.match(serverSource, /notable\.has\(str\(row\.receipt && row\.receipt\.status\)\)/)
})

test('session view projection cache reuses unchanged revisions', () => {
  assert.match(serverSource, /sessionViewProjectionCache/)
  assert.match(serverSource, /volatileSessionViewFields/)
  assert.match(serverSource, /dirtyMessageIndices/)
  assert.match(serverSource, /viewRebuild/)
  assert.match(serverSource, /helperMessagesProjection/)
  assert.match(serverSource, /windowHelperMessages/)
  assert.match(serverSource, /hydrateTavernHelperMessages/)
})

test('api diagnostics record request and response byte sizes', async () => {
  const values = new Map()
  const diagnostics = createTavernApiDiagnostics({
    async updateJson(key, update) { values.set(key, update(values.get(key))) },
    async readJson(key) { return values.get(key) }
  })
  const payload = { sessionId: 'session', variables: { hp: 1 } }
  const result = { updated: true, contextDelta: { version: 1 } }
  await diagnostics.observe('updateTavernHelperVariables', payload, () => result)
  await diagnostics.observe('getSession', { sessionId: 'session' }, () => ({ view: { activity: { busy: false } } }))
  const data = await diagnostics.read('session')
  assert.equal(data.records.length, 2)
  assert.ok(data.records.every(row => Number.isFinite(row.requestBytes) && row.requestBytes > 0))
  assert.ok(data.records.every(row => Number.isFinite(row.responseBytes) && row.responseBytes > 0))
})
