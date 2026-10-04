import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import { helperClient, helperHostHarness } from './fixtures/helper-host-harness.mjs'
import { stubFrameDependencyImports } from './fixtures/frame-dependency-imports.mjs'

const plain = value => JSON.parse(JSON.stringify(value))
function messageFrame(state) {
  const listeners = [], sent = [], parent = { postMessage: value => sent.push(value) }
  const scope = { structuredClone, parent, console, addEventListener(name, listener) { if (name === "message") listeners.push(listener) } }
  scope.window = scope
  vm.createContext(scope)
  const html = helperClient.buildTavernFrameDocument({content: '<div>card</div>', token: 'message-token', helperContext: state, turn: 1})
  for (const script of html.matchAll(/<script data-dsh-tavern-(?:helper|interactive-helper|frame-variable-aliases)>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(stubFrameDependencyImports(script[1]), scope)
  }
  return { window: scope, sent, receive(data) { for (const listener of listeners) listener({source: parent, data: {token: 'message-token', ...data}}) } }
}

test('message worldbook names follow lightweight initial descriptors, deltas and write replies', async () => {
  const original = {version: 1, stateRevision: 1, messages: [], worldbook: {name: '初始书', resourceAccess: {token: 'book'}}}
  const run = messageFrame(original), api = run.window.TavernHelper
  assert.deepEqual(plain(api.getWorldbookNames()), ['初始书'])
  assert.equal(run.sent.length, 0, 'a name read must not fetch entries')
  const next = {...original, stateRevision: 2, worldbook: {name: '新书'}}
  run.receive({type: 'dsh-tavern-helper-context-update', update: helperClient.createTavernHelperContextUpdate(original, next, 1, 1)})
  assert.equal(api.getCharWorldbookNames().primary, '新书')
  const pending = api.getWorldbook('新书')
  const call = run.sent.at(-1)
  assert.equal(call.method, 'getTavernHelperWorldbook')
  run.receive({type: 'dsh-tavern-helper-response', requestId: call.requestId, ok: true, result: {worldbook: {name: '保存后的书', entries: [{uid: 7}]}}})
  assert.equal((await pending)[0].uid, 7)
  assert.equal(api.getCharWorldbookNames().primary, '保存后的书')
  const slash = api.triggerSlash('/pass 123')
  run.receive({type: 'dsh-tavern-helper-response', requestId: run.sent.at(-1).requestId, ok: true, result: {pipe: '123', context: {messages: []}}})
  assert.equal(await slash, '123')
  assert.deepEqual(plain(api.getWorldbookNames()), ['保存后的书'], 'partial RPC contexts retain resource metadata')
})

const messages = [
  {message_id: 0, role: 'assistant', message: 'one', variables: {first: 1}, swipes: ['zero', 'one'], swipe_id: 1, swipes_data: [{old: 1}, {first: 1}]},
  {message_id: 1, role: 'user', message: 'hidden', is_hidden: true, variables: {}},
  {message_id: 2, role: 'assistant', message: 'last', variables: {last: 1}}
]
for (const kind of ['script', 'message']) test(kind + ' getChatMessages supports negative ranges, visibility and upstream data fields', () => {
  const state = {messages, turnMessageIds: {1: 0}, characterName: '角色', playerName: '玩家'}
  const api = (kind === 'script' ? helperHostHarness(state) : messageFrame(state)).window.TavernHelper
  assert.deepEqual(Array.from(api.getChatMessages('-1'), row => row.message_id), [2])
  assert.deepEqual(Array.from(api.getChatMessages('-3--1', {hide_state: 'unhidden'}), row => row.message_id), [0, 2])
  assert.deepEqual(Array.from(api.getChatMessages('0-{{lastMessageId}}', {hide_state: 'hidden'}), row => row.message_id), [1])
  assert.equal(api.getChatMessages('2-0', {role: 'user'})[0].name, '玩家')
  assert.deepEqual(plain(api.getChatMessages('invalid-range')), [])
  const first = api.getChatMessages(0, {include_swipes: true})[0]
  assert.deepEqual(plain(first.data), {first: 1})
  assert.deepEqual(plain(first.extra), {})
  assert.deepEqual(plain(first.swipes_info), [{}, {}])
  first.data.first = 9
  assert.equal(api.getChatMessages(0)[0].data.first, 1)
})

test('getAllVariables respects script vs message scope and precedence', () => {
  const state = {globalVariables: {global: 1, key: 'global'}, characterVariables: {character: 1, key: 'character'},
    scriptVariables: {a: {script: 1, key: 'script'}}, chatVariables: {chat: 1, key: 'chat'}, messages,
    turnMessageIds: {1: 1}}
  assert.deepEqual(plain(helperHostHarness(state).window.getAllVariables()), {global: 1, character: 1, script: 1, chat: 1, key: 'chat'})
  assert.deepEqual(plain(messageFrame(state).window.getAllVariables()), {global: 1, character: 1, chat: 1, key: 'chat'})
})

test('utility aliases preserve values, this and original sync/async errors', async () => {
  for (const run of [helperHostHarness(), messageFrame({messages: []})]) {
    const w = run.window, api = w.TavernHelper, original = new Error('failed')
    assert.equal(api.errorCatched, w.errorCatched)
    assert.equal(api.retrieveDisplayedMessage, w.retrieveDisplayedMessage)
    assert.equal(api.getMessageId('TH-message--42--123_4'), 42)
    assert.equal(api.getMessageId('TH-message--3--dsh-token'), 3)
    assert.throws(() => api.getMessageId('TH-script--42'), /iframe/)
    const fn = api.errorCatched(function (n) { return this.value + n })
    assert.equal(fn.call({value: 2}, 3), 5)
    assert.equal(await api.errorCatched(async () => 7)(), 7)
    assert.throws(api.errorCatched(() => { throw original }), error => error === original)
    await assert.rejects(api.errorCatched(async () => { throw original })(), error => error === original)
    w.toastr.error = () => { throw new Error('broken reporter') }
    assert.throws(api.errorCatched(() => { throw original }), error => error === original)
  }
})

test('retrieveDisplayedMessage accesses live same-session trusted message DOM without copying it', async () => {
  const dom = new JSDOM('<iframe class="dsh-tavern-message-frame"></iframe><iframe class="dsh-tavern-message-frame"></iframe>')
  const [first, other] = dom.window.document.querySelectorAll('iframe')
  first.__dshTavernSessionId = 'one'; first.contentWindow.name = 'TH-message--0--token'
  first.contentDocument.body.innerHTML = '<button class="jzy-st">play</button>'
  other.__dshTavernSessionId = 'two'; other.contentWindow.name = 'TH-message--0--other'
  const jq = nodes => Array.from(nodes || [])
  const target = {name: 'script', parent: dom.window, frameElement: {__dshTavernSessionId: 'one'}, jQuery: jq}
  const api = vm.runInNewContext((await readFile(new URL('../tavern-plugin/src/client/runtime/helper-public-api.js', import.meta.url), 'utf8')) + '\ninstallTavernHelperUtilities')
  api(target)
  const nodes = target.retrieveDisplayedMessage(0)
  assert.equal(nodes.length, 1)
  nodes[0].querySelector('button').textContent = 'home'
  assert.equal(first.contentDocument.body.textContent, 'home')
  first.setAttribute('aria-hidden', 'true')
  assert.equal(target.retrieveDisplayedMessage(0).length, 0)
  first.removeAttribute('aria-hidden'); first.remove()
  assert.equal(target.retrieveDisplayedMessage(0).length, 0)
  assert.equal(target.retrieveDisplayedMessage(-1).length, 0)
  dom.window.close()
})

for (const kind of ['script', 'message']) test(kind + ' unsupported variable scopes never fall through to message data', () => {
  const state = {messages: [{message_id: 0, variables: {keep: true}}]}
  const run = kind === 'script' ? helperHostHarness(state) : messageFrame(state), api = run.window.TavernHelper
  for (const type of ['preset', 'extension', 'typo']) {
    assert.throws(() => api.getVariables({type}), error => error.code === 'TAVERN_CAPABILITY_UNSUPPORTED')
    assert.throws(() => api.replaceVariables({bad: true}, {type}), error => error.code === 'TAVERN_CAPABILITY_UNSUPPORTED')
  }
  assert.deepEqual(plain(api.getVariables({type: 'message'})), {keep: true})
  assert.equal(run.sent.filter(row => row.type === 'dsh-tavern-helper-call').length, 0)
})

test('enabled script button discovery preserves group visibility and script-specific event IDs', async () => {
  const {inspectCardExtensions} = await import('../tavern-plugin/lib/domain/card-extension-reading.js')
  const {projectTavernHelperScripts} = await import('../tavern-plugin/lib/domain/tavern-helper-scripts.js')
  const raw = [{id: 'a', name: 'A', enabled: true, content: 'void 0', button: {buttons: [{name: 'Play', visible: true}, {name: 'Hidden', visible: false}]}},
    {id: 'b', name: 'B', enabled: true, content: 'void 0', button: {enabled: false, buttons: [{name: 'Play', visible: true}]}},
    {id: 'disabled', enabled: false, content: 'void 0', button: {enabled: true, buttons: [{name: 'No', visible: true}]}}]
  const inspected = inspectCardExtensions({name: 'test', extensions: {tavern_helper: {scripts: raw}}})
  const scripts = projectTavernHelperScripts(inspected.helperScripts).scripts
  assert.equal(scripts[0].buttonsEnabled, true)
  assert.equal(scripts[1].buttonsEnabled, false)
  const w = helperHostHarness({}, {scripts}).window
  const first = w.TavernHelper.getAllEnabledScriptButtons()
  assert.deepEqual(plain(first), {a: [{button_name: 'Play', button_id: w.getButtonEvent('Play')}]})
  first.a[0].button_name = 'mutated'
  assert.equal(w.getAllEnabledScriptButtons().a[0].button_name, 'Play')
  w.replaceScriptButtons([{name: 'Next', visible: true}])
  assert.equal(w.getAllEnabledScriptButtons().a[0].button_id, w.getButtonEvent('Next'))
  assert.equal(w.getIframeName(), 'TH-script--A--a')
  w.__dshTavernHelperSetCurrentScript('b')
  assert.equal(w.getIframeName(), 'TH-script--B--b')
})

for (const kind of ['script', 'message']) test(kind + ' deleteVariable waits for persistence and returns the upstream result shape', async () => {
  const run = kind === 'script' ? helperHostHarness({chatVariables: {old: 1, keep: 2}}) : messageFrame({messages: [], chatVariables: {old: 1, keep: 2}})
  run.window._ = {unset: (value, key) => delete value[key]}
  const pending = run.window.TavernHelper.deleteVariable('old', {type: 'chat'})
  const call = run.sent.find(row => row.type === 'dsh-tavern-helper-call')
  assert.equal(call.method, 'updateTavernHelperVariables')
  assert.deepEqual(plain(call.args.variables), {keep: 2})
  if (run.reply) run.reply(call, {updated: true})
  else run.receive({type: 'dsh-tavern-helper-response', requestId: call.requestId, ok: true, result: {updated: true}})
  assert.deepEqual(plain(await pending), {variables: {keep: 2}, delete_occurred: true})
})

test('script deleteVariable rejects stale or failed writes instead of reporting a saved deletion', async () => {
  for (const stale of [true, false]) {
    const run = helperHostHarness({chatVariables: {keep: 1}})
    const pending = run.window.deleteVariable('keep', {type: 'chat'})
    run.reply(run.calls()[0], stale ? {updated: false, stale: true} : 'save failed', stale)
    await assert.rejects(pending, stale ? /未保存/ : /save failed/)
    assert.deepEqual(plain(run.window.getVariables({type: 'chat'})), {keep: 1})
  }
})

for (const kind of ['script', 'message']) test(kind + ' installed display/regex/event/global APIs operate on the live frame context', async () => {
  const {marked} = await import('marked')
  const state = {messages, character: {name: '角色'}, characterName: '角色', playerName: '玩家', turnMessageIds: {1: 0}, chatVariables: {gold: 7},
    regexScripts: {character: [{enabled: true, placement: [2], markdownOnly: true, findRegex: '/token/g', replaceString: '**{{char}}** {{getvar::gold}}'}]}}
  const run = kind === 'script' ? helperHostHarness(state) : messageFrame(state), w = run.window
  w.marked = marked
  assert.equal(w.TavernHelper.isCharacterTavernRegexesEnabled(), true)
  assert.equal(w.TavernHelper.formatAsDisplayedMessage('token', {message_id: 0}), '<p><strong>角色</strong> 7</p>\n')
  if (kind === 'message') {
    const nextState = {...state, stateRevision: 2, regexScripts: {character: [{enabled: true, placement: [2], markdownOnly: true, findRegex: '/token/g', replaceString: 'changed'}]}}
    run.receive({type: 'dsh-tavern-helper-context-update', update: helperClient.createTavernHelperContextUpdate(state, nextState, 1, 1)})
    assert.equal(w.formatAsDisplayedMessage('token', {message_id: 0}), '<p>changed</p>\n')
  }

  const wait = w.TavernHelper.waitGlobalInitialized('PluginReady')
  await w.TavernHelper.initializeGlobal('PluginReady', {ready: true})
  assert.equal((await wait).ready, true)
  const next = w.eventWaitOnce('local-ready')
  await w.eventEmitAndWait('local-ready', 1, 'two')
  assert.deepEqual(plain(await next), [1, 'two'])
})
