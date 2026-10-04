import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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

function updaterHarness({ call, initial = { phase: 'loading', host: 'cli' }, askConfirm = async () => true, polling = false } = {}) {
  const marker = source.indexOf('async function refreshUpdateStatus()')
  const pollStart = source.lastIndexOf('React.useEffect(function () {', marker)
  const pollEnd = source.indexOf('\n\t\t\tReact.useEffect(', marker)
  const helperStart = source.indexOf('function publishUpdateStatus(')
  const helperEnd = source.indexOf('const updateStartedAtRef', helperStart)
  const actionStart = source.indexOf('async function checkUpdate()')
  const actionEnd = source.indexOf('const h = React.createElement;', actionStart)
  const reports = [], cleared = [], states = [], calls = [], signals = [], timers = new Map()
  let timerId = 0
  const updateStatusRef = { current: initial }, updateActionRef = { current: { pending: false, generation: 0 } }
  let current = initial, poll, cleanup
  const actions = new Function('React', 'window', 'call', 'setUpdateStatus', 'tavernErrorHub', 'updateStartedAtRef', 'isMissingUpdateApiError', 'updateStatusRef', 'updateActionRef', 'askConfirm', 'updateRecoveryRef',
    source.slice(helperStart, helperEnd) + source.slice(actionStart, actionEnd) + source.slice(pollStart, pollEnd) + ';return { checkUpdate, performUpdate, cancelUpdate, isUpdateBusy }')(
    { useEffect(fn) { if (polling) cleanup = fn() } },
    { setInterval(fn) { poll = fn; return 1 }, clearInterval() {}, setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id }, clearTimeout(id) { timers.delete(id) } },
    (method, args, options) => { calls.push(method); signals.push(options?.signal); return call(method, args, undefined, options) },
    state => { current = typeof state === 'function' ? state(current) : state; states.push(current) },
    { report: (label, error) => reports.push({ label, error }), resolve: label => cleared.push(label) },
    { current: 0 }, error => /未知方法: getUpdateStatus/.test(error.message), updateStatusRef, updateActionRef, askConfirm,
    { current: { sawOffline: false, reloading: false } })
  return { ...actions, reports, cleared, states, calls, signals, expire: () => { for (const timer of [...timers.values()]) timer() }, updateActionRef, status: () => current, poll: () => poll(), stop: () => cleanup?.() }
}
function pollHarness(fetch) { return updaterHarness({ call: rpcFor(fetch), polling: true }) }
function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
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

for (const phase of ['running', 'cancelling', 'blocked']) {
  test(`${phase} 禁止检查和启动，取消必须由后台声明可用`, async () => {
    const h = updaterHarness({ initial: { phase, cancellable: false }, call: async () => assert.fail('must not call API') })
    await Promise.all([h.checkUpdate(), h.performUpdate(), h.cancelUpdate()])
    assert.deepEqual(h.calls, [])
    assert.equal(h.isUpdateBusy(h.status()), true)
  })
}

test('修复操作有独立确认文案，重复点击仅确认和启动一次', async () => {
  const confirmation = deferred(), request = deferred(), prompts = []
  const h = updaterHarness({ initial: { phase: 'repair-required', host: 'desktop' },
    askConfirm: prompt => { prompts.push(prompt); return confirmation.promise }, call: () => request.promise })
  const first = h.performUpdate()
  await h.performUpdate()
  await h.checkUpdate()
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /修复安装/)
  assert.doesNotMatch(prompts[0], /GitHub 最新版/)
  assert.deepEqual(h.calls, [])
  confirmation.resolve(true)
  await tick()
  assert.equal(h.status().phase, 'running')
  assert.equal(h.status().cancellable, false, 'optimistic status cannot invent cancellation capability')
  await h.performUpdate()
  assert.deepEqual(h.calls, ['startUpdate'])
  request.resolve({ status: { phase: 'running', cancellable: true } })
  await first
  assert.equal(h.status().cancellable, true)
  assert.equal(h.updateActionRef.current.pending, false)
})

test('关闭确认框不启动更新，并解除重复点击保护', async () => {
  const h = updaterHarness({ initial: { phase: 'update-available' }, askConfirm: async () => false,
    call: async () => assert.fail('cancelled confirmation must not call API') })
  await h.performUpdate()
  assert.equal(h.status().phase, 'update-available')
  assert.equal(h.updateActionRef.current.pending, false)
  assert.deepEqual(h.calls, [])
})

test('取消请求发出后保持忙碌，重复点击不重放取消或启动', async () => {
  const request = deferred()
  const h = updaterHarness({ initial: { phase: 'running', cancellable: true }, call: () => request.promise })
  const cancel = h.cancelUpdate()
  assert.equal(h.status().phase, 'cancelling')
  await Promise.all([h.cancelUpdate(), h.checkUpdate(), h.performUpdate()])
  assert.deepEqual(h.calls, ['cancelUpdate'])
  request.resolve({ status: { phase: 'blocked', cancellable: false, error: '安装进程仍在运行' } })
  await cancel
  assert.equal(h.status().phase, 'blocked')
  await h.checkUpdate()
  assert.deepEqual(h.calls, ['cancelUpdate'])
})

test('动作前开始的旧状态轮询不会覆盖取消结果', async () => {
  const oldPoll = deferred()
  const h = updaterHarness({ initial: { phase: 'running', cancellable: true }, polling: true,
    call: method => method === 'getUpdateStatus' ? oldPoll.promise : Promise.resolve({ status: { phase: 'repair-required' } }) })
  await h.cancelUpdate()
  assert.equal(h.status().phase, 'repair-required')
  oldPoll.resolve({ status: { phase: 'running', cancellable: true } })
  await tick()
  assert.equal(h.status().phase, 'repair-required')
  h.stop()
})

test('检查请求只提交一次，完成后丢弃旧轮询失败', async () => {
  const oldPoll = deferred(), check = deferred()
  const h = updaterHarness({ initial: { phase: 'idle' }, polling: true,
    call: method => method === 'getUpdateStatus' ? oldPoll.promise : check.promise })
  const pendingCheck = h.checkUpdate()
  await h.checkUpdate()
  check.resolve({ status: { phase: 'repair-required' } })
  await pendingCheck
  oldPoll.reject(new Error('old request failed'))
  await tick()
  assert.deepEqual(h.calls, ['getUpdateStatus', 'checkUpdate'])
  assert.equal(h.status().phase, 'repair-required')
  assert.deepEqual(h.reports, [])
  h.stop()
})

for (const [action, initial, busyPhase] of [
  ['performUpdate', { phase: 'update-available' }, 'running'],
  ['cancelUpdate', { phase: 'running', cancellable: true }, 'cancelling'],
]) {
  test(`${action} 响应丢失时保持忙碌，由只读状态轮询恢复`, async () => {
    const h = updaterHarness({ initial, polling: true, call: async method => {
      if (method === 'getUpdateStatus') return { status: { phase: 'repair-required' } }
      throw new TypeError('Failed to fetch')
    } })
    await h[action]()
    assert.equal(h.status().phase, busyPhase)
    assert.match(h.status().error, /尚未确认/)
    await Promise.all([h.checkUpdate(), h.performUpdate(), h.cancelUpdate()])
    assert.equal(h.calls.filter(method => method !== 'getUpdateStatus').length, 1)
    await h.poll()
    assert.equal(h.status().phase, 'repair-required')
    h.stop()
  })
}

function renderUpdate(status) {
  const start = source.indexOf('const updateMessage =')
  const end = source.indexOf('return h(React.Fragment, null, h(TavernErrorCenter)', start)
  const { isUpdateBusy } = updaterHarness()
  const rendered = new Function('updateStatus', 'h', 'isUpdateBusy', 'checkUpdate', 'performUpdate', 'cancelUpdate',
    source.slice(start, end) + ';return { updateMessage, updateActions }')(status, React.createElement, isUpdateBusy, () => {}, () => {}, () => {})
  const dom = new JSDOM(renderToStaticMarkup(React.createElement('section', null, rendered.updateActions, React.createElement('p', null, rendered.updateMessage))))
  const buttons = [...dom.window.document.querySelectorAll('button')].map(button => ({ text: button.textContent, disabled: button.disabled }))
  const text = dom.window.document.body.textContent
  dom.window.close()
  return { buttons, text }
}

test('侧栏区分修复与新构建，并保留一般更新按钮', () => {
  const repair = renderUpdate({ phase: 'repair-required', currentCommit: 'aaaaaaa', latestCommit: 'aaaaaaa' })
  assert.deepEqual(repair.buttons, [{ text: '检查更新', disabled: false }, { text: '修复安装', disabled: false }])
  assert.match(repair.text, /当前构建需要修复安装/)
  assert.doesNotMatch(repair.text, /发现新构建|进行更新/)
  const update = renderUpdate({ phase: 'update-available', latestCommit: 'bbbbbbb' })
  assert.equal(update.buttons[1].text, '进行更新')
  assert.match(update.text, /发现新构建 bbbbbbb/)
})

test('真实按钮仅对可取消运行显示取消，正在取消与 blocked 均不可重试', () => {
  assert.deepEqual(renderUpdate({ phase: 'running', cancellable: true }).buttons, [
    { text: '正在更新…', disabled: true }, { text: '取消更新', disabled: false },
  ])
  const cancelling = renderUpdate({ phase: 'cancelling', cancellable: true })
  assert.equal(cancelling.buttons.length, 2)
  assert.ok(cancelling.buttons.every(button => button.disabled))
  for (const status of [{ phase: 'running' }, { phase: 'running', cancellable: false, stalled: true }, { phase: 'blocked', cancellable: true }]) {
    const rendered = renderUpdate(status)
    assert.equal(rendered.buttons.length, 1)
    assert.equal(rendered.buttons[0].disabled, true)
    assert.doesNotMatch(rendered.text, /建议重新安装|进行更新|修复安装/)
  }
})

test('卡住的旧更新明确显示后台原因，不建议同时重装', () => {
  const rendered = renderUpdate({ phase: 'running', stalled: true, cancellable: false, stage: '读取 DSH 版本', error: '旧安装进程没有新进展，仍在运行，请等待停止。' })
  assert.match(rendered.text, /旧安装进程没有新进展/)
  assert.match(rendered.text, /当前阶段：读取 DSH 版本/)
  assert.doesNotMatch(rendered.text, /建议重新安装/)
})

for (const [action, initial, busyPhase] of [
  ['performUpdate', { phase: 'update-available' }, 'running'],
  ['cancelUpdate', { phase: 'running', cancellable: true }, 'cancelling'],
]) {
  test(`${action} 请求挂起会解除等待，迟到响应不覆盖新状态`, async () => {
    const mutation = deferred()
    const h = updaterHarness({ initial, polling: true, call: async method => {
      if (method === 'getUpdateStatus') return { status: { phase: 'repair-required' } }
      return mutation.promise
    } })
    const pending = h[action]()
    await tick()
    h.expire()
    await pending
    assert.equal(h.status().phase, busyPhase)
    assert.equal(h.updateActionRef.current.pending, false)
    assert.equal(h.signals.at(-1).aborted, true)
    await h.poll()
    assert.equal(h.status().phase, 'repair-required')
    mutation.resolve({ status: { phase: 'running', cancellable: true } })
    await tick()
    assert.equal(h.status().phase, 'repair-required')
    assert.equal(h.calls.filter(method => method !== 'getUpdateStatus').length, 1)
    h.stop()
  })
}

test('挂起状态请求超时后可以再次轮询，不重放动作', async () => {
  let reads = 0
  const h = updaterHarness({ polling: true, call: async () => {
    if (++reads === 1) return new Promise(() => {})
    return { status: { phase: 'running', cancellable: true } }
  } })
  h.expire()
  await tick()
  assert.deepEqual(h.reports, [], 'read-only timeouts get the startup grace period')
  await h.poll()
  assert.equal(h.status().phase, 'running')
  assert.deepEqual(h.calls, ['getUpdateStatus', 'getUpdateStatus'])
  h.stop()
})
