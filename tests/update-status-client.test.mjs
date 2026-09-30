import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
function rpcFor(fetch) {
  const start = source.includes('\t\tasync function readTavernJsonResponse(') ? source.indexOf('\t\tasync function readTavernJsonResponse(') : source.indexOf('\t\tfunction rpc(method,')
  const end = source.indexOf('\n\t\tfunction rpcWithTimeout', start)
  return new Function('fetch', 'tavernRuntimeGenerationMonitor', source.slice(start, end) + ';return rpc')(fetch, { observe() {} })
}
const ok = () => Response.json({ ok: true, status: { phase: 'update-available' } })
const tick = () => new Promise(resolve => setImmediate(resolve))

test('空响应与非 JSON 返回明确错误，认证错误不作为暂时故障重试', async () => {
  for (const [status, body, pattern, retryable] of [[404, '', /404/, true], [200, '', /空响应/, true], [200, '<html>bad</html>', /非 JSON/, true], [401, '', /认证/, false], [403, '', /权限/, false]]) {
    await assert.rejects(rpcFor(async () => new Response(body, { status }))('getUpdateStatus'), error => {
      assert.match(error.message, pattern)
      assert.equal(error.retryable, retryable)
      return true
    })
  }
})

function pollHarness(fetch) {
  const marker = source.indexOf('async function refreshUpdateStatus()')
  const start = source.lastIndexOf('React.useEffect(function () {', marker)
  const end = source.indexOf('\n\t\t\tReact.useEffect(', marker)
  const reports = [], cleared = [], states = []
  let poll, cleanup
  const rpc = rpcFor(fetch)
  new Function('React', 'window', 'call', 'setUpdateStatus', 'tavernErrorHub', 'updateStartedAtRef', 'isMissingUpdateApiError', source.slice(start, end))(
    { useEffect(fn) { cleanup = fn() } },
    { setInterval(fn) { poll = fn; return 1 }, clearInterval() {} },
    rpc, state => states.push(state), { report: (label, error) => reports.push({ label, error }), resolve: label => cleared.push(label) },
    { current: 0 }, () => false)
  return { reports, cleared, states, poll: () => poll(), stop: () => cleanup() }
}

test('网络中断可恢复，认证和业务错误立即提示', async () => {
  let calls = 0
  const network = pollHarness(async () => { if (++calls === 1) throw new TypeError('Failed to fetch'); return ok() })
  await tick()
  assert.equal(network.reports.length, 0)
  await network.poll()
  assert.equal(network.states.at(-1).phase, 'update-available')
  network.stop()
  for (const response of [() => new Response('', { status: 401 }), () => Response.json({ ok: false, error: '状态文件损坏' })]) {
    const h = pollHarness(async () => response())
    await tick()
    assert.equal(h.reports.length, 1)
    h.stop()
  }
})
