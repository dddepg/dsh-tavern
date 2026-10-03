import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadFactory() {
  const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  let descriptor
  const sandbox = { window: { __ModuleLoader__: { load(value) { descriptor = value } } }, console, AbortController }
  vm.runInNewContext(source, sandbox)
  return descriptor.factory(function () { return {} }).createTavernCoordinationEventModule
}

const createTavernCoordinationEventModule = await loadFactory()

function connections() {
  const opened = []
  return {
    connect(sessionId, handlers) {
      const connection = { sessionId, handlers, closed: false, close() { this.closed = true } }
      opened.push(connection)
      return connection
    },
    opened
  }
}

test('SSE 断线时保留最后快照，重连后的最新快照直接校准状态', function () {
  const transport = connections()
  const module = createTavernCoordinationEventModule({ connect: transport.connect })
  const stop = module.subscribe('session-2', function () {})
  const first = transport.opened[0]
  first.handlers.message({ activity: { busy: true, phase: 'running' }, mailboxVersion: 4 })
  first.handlers.error(new Error('disconnected'))

  assert.equal(module.getSnapshot('session-2').phase, 'retrying')
  assert.equal(module.getSnapshot('session-2').view.activity.busy, true)

  module.invalidate('session-2')
  const second = transport.opened[1]
  assert.equal(first.closed, true)
  second.handlers.message({ activity: { busy: false, phase: 'idle' }, mailboxVersion: 5 })
  assert.equal(module.getSnapshot('session-2').view.activity.busy, false)
  stop()
})
