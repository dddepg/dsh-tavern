import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { assembleTavernClient } from '../bin/build-tavern-client.mjs'

const assembled = await assembleTavernClient()
const executorSource = (await readFile(new URL('../tavern-plugin/src/client/features/assistant-renderer.js', import.meta.url), 'utf8')).split('const tavernSessionTransition')[0]
const tick = () => new Promise(resolve => setImmediate(resolve))
const copy = value => JSON.parse(JSON.stringify(value))
const context = () => ({ version: 1, chatId: 'chat-A', lifecycleRevision: 2, stateRevision: 3, messages: [] })
function executor(rpc = assert.fail, ctx = {}) {
  const scope = { rpc }
  vm.runInNewContext(executorSource, scope)
  return scope.createTavernFrameSlashExecutor(ctx, { setTimeout, clearTimeout })
}

test('/pass returns text, supports /return, escaping and bounded pipe substitution', async () => {
  const run = executor()
  assert.equal(await run('/pass hello world', 'A'), 'hello world')
  assert.equal(await run('/return "hello | /unknown"', 'A'), 'hello | /unknown')
  assert.equal(await run('/pass hello \\| /unknown', 'A'), 'hello | /unknown')
  assert.equal(await run('/pass King\'s sword', 'A'), "King's sword")
  assert.equal(await run('/pass "say \\"hello\\""', 'A'), 'say "hello"')
  assert.equal(await run('/pass $& | /pass before {{pipe}} after', 'A'), 'before $& after')
  assert.equal(await run('/pass "a|b" | /return {{pipe}}', 'A'), 'a|b')
  assert.equal(await run('/pass', 'A'), '')
})

test('/findentry searches the current book with exact priority and field aliases', async () => {
  const calls = []
  const run = executor(async (method, args, sessionId) => {
    calls.push({ method, args: copy(args), sessionId })
    if (!['Book name', 'current'].includes(args.name)) throw new Error('当前兼容层只能访问人物卡绑定的世界书')
    return { worldbook: { entries: [
      { uid: 8, name: 'other', strategy: { keys: ['Shadowfang extra'], keys_secondary: { keys: ['side'] } }, content: 'world' },
      { uid: 0, name: 'Title', strategy: { keys: ['Shadowfang'], keys_secondary: { keys: ['secret'] } }, content: 'long CONTENT sample' }
    ] } }
  })
  assert.equal(await run('/findentry file="Book name" Shadowfang', 'A'), '0')
  assert.equal(await run('/findlore field=comment file=current title', 'A'), '0')
  assert.equal(await run('/findwi file=current field=keysecondary SECRET', 'A'), '0')
  assert.equal(await run('/findentry file=current field=content content', 'A'), '0')
  assert.equal(await run('/findentry file=current field=uid 8', 'A'), '8')
  assert.equal(await run('/findentry file=current missing', 'A'), '')
  assert.equal(await run('/pass Book name | /findentry file={{pipe}} field=key Shadowfang | /pass uid={{pipe}}', 'A'), 'uid=0')
  assert.deepEqual(calls[0], { method: 'getTavernHelperWorldbook', args: { name: 'Book name' }, sessionId: 'A' })
  await assert.rejects(run('/findentry file=Other Shadowfang', 'A'), /只能访问/)
})

test('read-only pipelines validate every command and option before dispatch', async () => {
  const effects = []
  const run = executor(() => effects.push('read'), {
    sessions: { scope: () => ({}) }, get: () => ({ input: { for: () => ({ setDraft: () => effects.push('draft'), submit: () => effects.push('send') }) } }),
    remote: { commands: { execute: async () => { effects.push('remote'); return undefined } } }
  })
  for (const line of [
    '/findentry file=current key | /unknown', '/pass x | /trigger', '/pass x | /send {{pipe}} | /trigger',
    '/findentry file=current field=content x | /findentry file=current field=__proto__ x',
    '/findentry file=current file=current x', '/findentry x', '/findentry file="broken x',
    '/pass "unclosed', '/pass x |', '/pass x || /pass y', '/send x | /pass y | /trigger'
  ]) await assert.rejects(run(line, 'A'), error => error.code === 'UNSUPPORTED_SLASH_PIPELINE', line)
  assert.deepEqual(effects, [])
  await assert.rejects(run('/passage x', 'A'), /没有注册/)
  await assert.rejects(run('/findentrysuffix x', 'A'), /没有注册/)
  assert.deepEqual(effects, ['remote', 'remote'])
})

function host() {
  const listeners = new Set(), timers = new Map()
  let id = 0, descriptor
  const window = {
    crypto: { randomUUID: () => 'token-' + ++id }, sessionStorage: { getItem() {}, setItem() {} },
    setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id }, clearTimeout(id) { timers.delete(id) },
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn) },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn) },
    __ModuleLoader__: { load(value) { descriptor = value } }
  }
  vm.runInNewContext(assembled, { window, console })
  return { window, client: descriptor.factory(() => ({})), deliver(source, data) { for (const fn of listeners) fn({ source, data }) } }
}
function scriptHost(options = {}) {
  const h = host(), frames = []
  const document = { body: { appendChild() {} }, createElement(tag) {
    if (tag === 'div') return { isConnected: true, appendChild() {}, remove() {}, style: {} }
    const frame = { contentWindow: { messages: [], postMessage(data) { this.messages.push(copy(data)) } }, style: {},
      addEventListener(type, fn) { if (type === 'load') this.load = fn }, remove() {} }
    frames.push(frame); return frame
  } }
  const runtime = h.client.createTavernHelperScriptRuntime({ window: h.window, document,
    rpc: async () => ({ updated: true }), reportError() {}, resolveError() {}, onMutation() {}, ...options })
  runtime.sync('A', { chatId: 'chat-A', tavernHelper: context(), tavernHelperScripts: [{ id: 'script', name: 'test', content: '' }] })
  const frame = frames.at(-1)
  frame.load()
  const token = frame.contentWindow.messages[0].token
  h.deliver(frame.contentWindow, { token, type: 'dsh-tavern-helper-subscriptions', ready: true, names: ['UPDATE'] })
  return { ...h, runtime, frame, call(method, args = {}, extra = {}) {
    h.deliver(frame.contentWindow, { type: 'dsh-tavern-helper-call', token, requestId: 'request', scriptId: 'script', lifecycleRevision: 2, method, args, ...extra })
  }, response() { return frame.contentWindow.messages.findLast(data => data.type === 'dsh-tavern-helper-response') } }
}

test('script slash bridge returns strings and submission objects and rejects unknown methods', async t => {
  const calls = []
  const h = scriptHost({ executeSlash: async (...args) => { calls.push(args); return args[0] === '/trigger' ? { submitted: true } : '0' } })
  t.after(() => h.runtime.dispose())
  h.call('triggerTavernSlash', { line: '/findentry file=current x' })
  await tick()
  assert.deepEqual(h.response().result, { pipe: '0' })
  assert.equal(calls[0][1], 'A')
  h.call('triggerTavernSlash', { line: '/trigger' }, { eventId: 'event-in-progress' })
  await tick()
  assert.deepEqual(copy(calls[1][2]), { waitForCompletion: false })
  assert.deepEqual(h.response().result, { submitted: true })
  h.call('notAnImplementedMethod')
  assert.equal(h.response().ok, false)
  assert.equal(h.response().errorCode, 'UNSUPPORTED_HELPER_METHOD')
})

test('script slash rejects background, stale and closed-event calls without executing', async t => {
  const calls = []
  const h = scriptHost({ executeSlash: async (...args) => { calls.push(args); return '' } })
  t.after(() => h.runtime.dispose())
  h.runtime.setForeground(false)
  h.call('triggerTavernSlash', { line: '/pass hi' }); await tick()
  assert.match(h.response().error, /对话已切换/)
  h.runtime.setForeground(true)
  h.call('triggerTavernSlash', { line: '/pass hi' }, { lifecycleRevision: 1 }); await tick()
  assert.match(h.response().error, /版本已变化/)
  const event = h.runtime.emit('UPDATE', [], context(), [], 'closed-event')
  const dispatched = h.frame.contentWindow.messages.findLast(data => data.type === 'dsh-tavern-helper-event')
  h.deliver(h.frame.contentWindow, { type: 'dsh-tavern-helper-event-complete', token: dispatched.token, eventId: dispatched.eventId, args: [] })
  await event
  h.call('triggerTavernSlash', { line: '/pass hi' }, { eventId: 'closed-event' }); await tick()
  assert.equal(h.response().errorCode, 'TAVERN_SCRIPT_EVENT_CLOSED')
  assert.deepEqual(calls, [])
})

test('script slash waits for preceding writes and always responds to executor rejection', async t => {
  let finishWrite
  const calls = []
  const h = scriptHost({ rpc: () => new Promise(resolve => { finishWrite = resolve }), executeSlash: async () => { calls.push('slash'); throw Object.assign(new Error('unsupported'), { code: 'UNSUPPORTED_SLASH_PIPELINE' }) } })
  t.after(() => h.runtime.dispose())
  h.call('updateTavernHelperMessages', { messages: [] }, { requestId: 'write' }); await tick()
  h.call('triggerTavernSlash', { line: '/not-real' }); await tick()
  assert.deepEqual(calls, [])
  finishWrite({ updated: false }); await tick(); await tick()
  assert.deepEqual(calls, ['slash'])
  assert.equal(h.response().ok, false)
  assert.equal(h.response().errorCode, 'UNSUPPORTED_SLASH_PIPELINE')
})

function frameHost(executeSlash) {
  const h = host(), messages = []
  const lifecycle = h.client.createTavernMessageFrameLifecycle({ sessionId: 'A', helperContext: context(), content: '<p>body</p>', turn: 1, partIndex: 0, eager: true }, {
    window: h.window, executeSlash, rpc: async () => ({ view: { tavernHelper: context() } })
  })
  const stop = lifecycle.start(() => {})
  const document = lifecycle.snapshot().visibleDocument
  const node = { contentWindow: { postMessage(data) { messages.push(copy(data)) } } }
  document.ref(node)
  return { ...h, stop, messages, call(method, line, source = node.contentWindow) {
    h.deliver(source, { token: document.token, type: 'dsh-tavern-helper-call', requestId: 'request', method, args: { line } })
  } }
}

test('message frames preserve string slash results, refresh context and explicitly reject unknown methods', async t => {
  const h = frameHost(async line => line === '/trigger' ? { submitted: true } : '0')
  t.after(h.stop)
  h.call('triggerTavernSlash', '/pass 0'); await tick()
  assert.equal(h.messages.at(-1).result.pipe, '0')
  assert.equal(h.messages.at(-1).result.context.chatId, 'chat-A')
  assert.equal(Object.hasOwn(h.messages.at(-1).result, '0'), false)
  h.call('triggerTavernSlash', '/trigger'); await tick()
  assert.equal(h.messages.at(-1).result.submitted, true)
  h.call('unknown', '', {}); assert.equal(h.messages.at(-1).ok, true, 'unauthenticated callers ignored')
  h.call('unknown', ''); assert.equal(h.messages.at(-1).errorCode, 'UNSUPPORTED_HELPER_METHOD')
})

test('live frame context patches refresh worldbook, names and global/character variables', () => {
  const { client } = host()
  const previous = context()
  const next = { ...previous, stateRevision: 4, worldbook: { name: 'Book', entries: [] }, characterName: 'Char', playerName: 'Player', globalVariables: { n: 1 }, characterVariables: { n: 2 } }
  const patch = client.createTavernHelperContextUpdate(previous, next, 1, 1)
  const updated = client.applyTavernHelperContextUpdate(previous, patch)
  for (const key of ['worldbook', 'characterName', 'playerName', 'globalVariables', 'characterVariables']) assert.deepEqual(copy(updated.context[key]), next[key])
  assert.ok(patch.events.includes('mag_variable_update_ended'))
})
