import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { registerTavernHttpRoutes } from '../tavern-plugin/lib/http/routes.js'

// Exercise the real updater dispatch arms and the production HTTP route together.
const source = readFileSync(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
const start = source.indexOf("      case 'getUpdateStatus':")
const end = source.indexOf("      case 'prepareSessionOpening':", start)
assert.ok(start >= 0 && end > start)
function route(updater) {
  const dispatch = new Function('applicationUpdater', 'return async function(method) { switch (method) {' + source.slice(start, end) + '\ndefault: throw new Error("未知方法: " + method) } }')(updater)
  let handler
  const webServer = { register(spec) { if (spec.path === '/api/dsh-tavern') handler = spec.handler; return () => {} } }
  registerTavernHttpRoutes({ ctx: { get: () => webServer, effect: fn => fn() }, dispatch, str: String,
    performanceDiagnostics: { http() {} }, runtimeGeneration: 'test-generation', runtimeReadiness: Promise.resolve({ ok: true }) })
  return async ({ method = 'POST', origin, body = '{}' } = {}) => {
    const result = {}
    await handler({ url: '/api/dsh-tavern/cancelUpdate', method, headers: { host: 'localhost:3081', ...(origin ? { origin } : {}) },
      async *[Symbol.asyncIterator]() { yield Buffer.from(body) }
    }, { writeHead(status, headers) { Object.assign(result, { status, headers }) }, end(response) { result.body = response } })
    return result
  }
}

test('取消更新通过现有 POST RPC 返回后台取消状态', async () => {
  let calls = 0
  const status = { phase: 'cancelling', host: 'desktop', cancellable: true }
  const request = route({ async cancel() { calls++; return status } })
  const response = await request({ origin: 'http://localhost:3081' })
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, status, runtimeGeneration: 'test-generation' })
  assert.equal(calls, 1)
})

test('取消更新沿用 RPC 错误响应，不虚报已取消', async () => {
  const request = route({ async cancel() { throw new Error('当前安装无法安全自动中止') } })
  const response = await request()
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: '当前安装无法安全自动中止' })
})

test('取消更新拒绝 GET、跨站和损坏请求且不触发取消', async () => {
  let calls = 0
  const request = route({ async cancel() { calls++; return { phase: 'cancelling' } } })
  assert.equal((await request({ method: 'GET' })).status, 405)
  assert.equal((await request({ origin: 'https://untrusted.invalid' })).status, 403)
  assert.equal((await request({ body: '{' })).status, 400)
  assert.equal(calls, 0)
})
