import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const extract = (name, next) => source.slice(source.indexOf((name === 'sceneImagePurchaseConfirmation' ? 'async ' : '') + 'function ' + name + '('), source.indexOf('function ' + next + '('))

test('scene request identifiers also work on LAN HTTP without crypto.randomUUID', () => {
  const context = vm.createContext({
    useTavernConfirm: () => async () => true,
    recordImageInteraction() {}, window: {} })
  const make = vm.runInContext(extract('sceneImageRequestId', 'sceneImageStageLabel') + ';sceneImageRequestId', context)
  const ids = Array.from({ length: 1000 }, make)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.every(id => /^[a-zA-Z0-9_-]{8,100}$/.test(id)))
})

test('main image action preserves request ID on ambiguous transport errors and cannot regenerate over existing versions', async () => {
  const slots = [], calls = []
  let cursor = 0, fail = true
  const record = { key: 'target-key', status: 'idle', versions: [] }
  const context = vm.createContext({
    useTavernConfirm: () => async () => true,
    recordImageInteraction() {},
    React: {
      Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props, children }),
      useState: initial => { const n = cursor++; if (!(n in slots)) slots[n] = initial; return [slots[n], value => { slots[n] = value }] },
      useRef: initial => { const n = cursor++; return slots[n] ||= { current: initial } },
      useEffect: () => {}
    },
    useSceneImageRecord: () => record, sceneImageStageLabel: () => 'working', sceneImagePurchaseConfirmation: () => undefined,
    window: { dispatchEvent() {} }, CustomEvent: class {},
    rpc: async (method, args) => { calls.push({ method, args }); if (fail) throw new Error('connection lost') }
  })
  const Component = vm.runInContext(extract('sceneImageRequestId', 'sceneImageStageLabel') + extract('SceneImageAction', 'SceneImageSettings') + ';SceneImageAction', context)
  function render() { cursor = 0; return Component({ sessionId: 'session', turn: 1, running: false }) }
  render(); slots[0] = { enabled: true, ready: true }
  await render().children[0].props.onClick()
  fail = false
  await render().children[0].props.onClick()
  assert.equal(calls[0].args.requestId, calls[1].args.requestId)
  assert.equal(calls[0].args.key, record.key)
  record.status = 'failed'; record.versions = [{ id: 'old-image' }]
  const button = render().children[0]
  assert.equal(button.props.disabled, true)
  await button.props.onClick()
  assert.equal(calls.length, 2)
  record.versions = []; record.recovery = 'save'
  const pending = render().children[0]
  assert.equal(pending.props.disabled, true)
  assert.ok(pending.children.includes('图片待保存'))
  await pending.props.onClick()
  assert.equal(calls.length, 2, 'must not send generation while bytes await saving')
  delete record.recovery; record.status = 'idle'
  fail = true; await render().children[0].props.onClick()
  const oldRequest = calls.at(-1).args.requestId
  // The request succeeded remotely, then its last picture was deleted elsewhere.
  record.requestId = oldRequest; record.hasDeletedImages = true
  fail = false; await render().children[0].props.onClick()
  assert.notEqual(calls.at(-1).args.requestId, oldRequest, 'deletion must not reuse the completed request')
})

test('image dock targets latest story turn even without a display projection or after rollback', () => {
  const expression = source.match(/const imageTurn = ([^;]+);/)[1]
  for (const [latestAssistantTurn, replyProjections] of [[4, []], [4, [{ turn: 2 }]], [2, [{ turn: 4 }]]]) {
    assert.equal(vm.runInNewContext(expression, { live: { view: { latestAssistantTurn, replyProjections } } }), latestAssistantTurn)
  }
})

test('delete selected image, handle cancellation/errors, then regenerate the empty historical turn', async () => {
  const slots = [], calls = []
  let cursor = 0, confirmed = false, failure = false, serial = 0
  const record = { key: 'historical-turn', status: 'succeeded', enabled: false, versions: [{ id: 'first' }, { id: 'second' }] }
  const context = vm.createContext({
    useTavernConfirm: () => async () => true,
    recordImageInteraction() {}, URLSearchParams, sceneImageStageLabel: () => '生成中',
    React: { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props, children }), useEffect() {},
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value }] },
      useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial } } },
    useSceneImageRecord: () => record, sceneImagePurchaseConfirmation: () => undefined, sceneImageRequestId: () => 'new-request-' + (++serial),
    useTavernConfirm: () => async () => confirmed,
    window: { dispatchEvent() {} }, CustomEvent: class {},
    rpc: async (method, args, sessionId) => {
      calls.push({ method, args, sessionId })
      if (failure) throw Error('删除失败')
      if (method === 'removeSceneImage') { record.versions = record.versions.filter(v => v.id !== args.versionId); record.hasDeletedImages = true; record.status = record.versions.length ? 'succeeded' : 'idle' }
    }
  })
  const Component = vm.runInContext(extract('SceneIllustration', 'TavernAssistantNodeView') + ';SceneIllustration', context)
  const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)] : []
  const render = () => { cursor = 0; return nodes(Component({ sessionId: 'session', turn: 3 })) }
  const button = label => render().find(n => n.type === 'button' && n.children.includes(label))
  await button('删除图片').props.onClick(); assert.equal(calls.length, 0)
  confirmed = true; record.status = 'running'; assert.equal(button('删除图片').props.disabled, true)
  record.status = 'succeeded'; record.recovery = 'save'; assert.equal(button('删除图片').props.disabled, true); delete record.recovery
  failure = true; await button('删除图片').props.onClick()
  assert.equal(record.versions.length, 2); assert.ok(render().some(n => n.props?.role === 'alert' && n.children.includes('删除失败')))
  failure = false
  await render().find(n => n.props?.['aria-label'] === '上一张插图').props.onClick()
  await button('删除图片').props.onClick()
  assert.equal(calls.at(-1).args.versionId, 'first')
  assert.equal(record.versions[0].id, 'second')
  await button('删除图片').props.onClick()
  assert.equal(record.versions.length, 0)
  assert.equal(button('重新生图'), undefined, 'generation stays unavailable while image service is disabled')
  record.enabled = true
  await button('重新生图').props.onClick()
  assert.equal(calls.at(-1).method, 'generateSceneImage')
  assert.equal(calls.at(-1).args.kind, 'generate')
  assert.equal(calls.at(-1).args.turn, 3)
  assert.equal(calls.at(-1).args.versionId, undefined)
  assert.equal(calls.at(-1).sessionId, 'session')
})
