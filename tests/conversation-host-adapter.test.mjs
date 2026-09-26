import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
let descriptor
vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { descriptor = value } } }, console })
const client = descriptor.factory(() => ({}))

function hostFixture(result = { ok: true, value: 'tavern' }) {
  const calls = []
  const ctx = {
    // alpha.2 separates workspace CRUD, UI navigation, and Remote operations.
    workspaces: { create: async () => ({ workspaceId: 'w1' }) },
    sessions: {
      async create({ workspaceId }) {
        assert.equal(this, ctx.sessions)
        calls.push(['create', workspaceId])
        return 's' + calls.filter(call => call[0] === 'create').length
      },
      async fork(options) {
        assert.equal(this, ctx.sessions)
        calls.push(['fork', options])
        return 's-fork'
      }
    },
    uiWorkspace: {
      async connectWorkspace(id) {
        assert.equal(this, ctx.uiWorkspace)
        calls.push(['connect', id])
        return 's1'
      }
    },
    remote: { agentPresets: {
      async select(sessionId, preset) {
        assert.equal(this, ctx.remote.agentPresets)
        calls.push(['preset', sessionId, preset])
        return result
      }
    } }
  }
  return { ctx, calls }
}

test('alpha.2 shared startup adapter creates a fresh Session and selects through Remote', async () => {
  for (const [kind, targetMode, preset] of [['play', 'story', 'tavern'], ['play', 'free', 'tavern'], ['card', 'card', 'tavern']]) {
    const { ctx, calls } = hostFixture()
    const host = client.createConversationHostAdapter(ctx)
    const lifecycle = client.createConversationLifecycleModule({
      archiveCurrent: async () => {}, resolveWorkspace: async () => 'w1',
      connectWorkspace: host.connectWorkspace, ensurePreset: host.ensurePreset,
      waitForSession: async id => calls.push(['ready', id]),
      createChat: async () => calls.push(['chat']), rememberPending: () => {},
      finishOpen: async () => calls.push(['open'])
    })
    const result = await lifecycle.start({ kind, targetMode })
    assert.equal(result.sessionId, 's1')
    assert.deepEqual(calls, [['create', 'w1'], ['ready', 's1'], ['preset', 's1', preset], ['chat'], ['open']])
  }
})

test('alpha.2 prewarm and startup use the same adapter without creating a second Session', async () => {
  const { ctx, calls } = hostFixture()
  const host = client.createConversationHostAdapter(ctx)
  const prewarm = client.createConversationPrewarmModule({
    sessionIds: () => [], resolveWorkspace: async () => 'w1',
    connectWorkspace: host.connectWorkspace, archiveSession: async () => {}
  })
  await prewarm.begin({ key: 'card1' })
  const prepared = await prewarm.claim('card1')
  assert.equal(prepared, 'w1')
  assert.deepEqual(calls, [])
  const lifecycle = client.createConversationLifecycleModule({
    archiveCurrent: async () => {}, resolveWorkspace: async () => 'w1',
    connectWorkspace: host.connectWorkspace, ensurePreset: host.ensurePreset,
    waitForSession: async () => {}, createChat: async () => {},
    rememberPending: () => {}, finishOpen: async () => {}
  })
  await lifecycle.start({ kind: 'play', preparedWorkspaceId: prepared })
  assert.deepEqual(calls, [['create', 'w1'], ['preset', 's1', 'tavern']])
})

test('two new conversations never reuse a blank Session with an existing Tavern opening', async () => {
  const { ctx, calls } = hostFixture()
  const host = client.createConversationHostAdapter(ctx)
  assert.equal(await host.connectWorkspace('w1'), 's1')
  assert.equal(await host.connectWorkspace('w1'), 's2')
  assert.deepEqual(calls, [['create', 'w1'], ['create', 'w1']])
})

test('conversation host delegates a game fork to the native DSH Session fork', async () => {
  const { ctx, calls } = hostFixture()
  const host = client.createConversationHostAdapter(ctx)

  assert.equal(await host.forkSession('s-source', 42), 's-fork')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'fork')
  assert.equal(calls[0][1].sessionId, 's-source')
  assert.equal(calls[0][1].increaseTitle, true)
  assert.equal(calls[0][1].atSeq, 42)
})

test('Remote refusal aborts startup before writing a Tavern chat', async () => {
  const { ctx } = hostFixture({ ok: false, error: { message: 'preset refused' } })
  const host = client.createConversationHostAdapter(ctx)
  let written = false
  const lifecycle = client.createConversationLifecycleModule({
    archiveCurrent: async () => {}, resolveWorkspace: async () => 'w1',
    connectWorkspace: host.connectWorkspace, ensurePreset: host.ensurePreset,
    waitForSession: async () => {}, createChat: async () => { written = true },
    rememberPending: () => {}, finishOpen: async () => {}
  })
  await assert.rejects(lifecycle.start({ kind: 'play' }), error => error.message === 'preset refused' && error.phase === '切换到酒馆模式')
  assert.equal(written, false)
})
