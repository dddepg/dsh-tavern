import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { initializationFixture } from './fixtures/conversation-initialization.mjs'
import { createInitializationNative } from './fixtures/conversation-initialization-native.mjs'
import { createUserPreferenceProfile } from '../tavern-plugin/lib/domain/user-preference-profile.js'
import { createPlayCardSnapshots } from '../tavern-plugin/lib/domain/play-card-snapshots.js'
import { createNativePlayOrchestrationStrategy } from '../tavern-plugin/lib/domain/foreground-orchestration-strategies.js'
import { registerTurnLifecycleHooks } from '../tavern-plugin/lib/hooks/turn-lifecycle.js'
import { registerUserProfileTools } from '../tavern-plugin/lib/tools/user-profile.js'
import { readSessionStablePrefix, ensureSessionStablePrefix } from '../tavern-plugin/lib/domain/session-stable-prefix.js'
import { ensureSessionVariableDirectory } from '../tavern-plugin/lib/domain/session-variable-directory.js'

async function profiles() {
  let value
  const profile = createUserPreferenceProfile({ store: {
    readJson: async () => structuredClone(value),
    updateJson: async (_path, update) => { value = await update(structuredClone(value)); return structuredClone(value) }
  } })
  await profile.save({ content: '固定偏好：偏爱细腻的人物描写。' })
  await profile.setDefaultEnabled(true, 'default')
  const editing = await profile.manage({ action: 'create', name: '正在编辑的另一份偏好', content: '正在编辑的内容' })
  return { profile, editingId: editing.profileId }
}

test('所有卡片入口以默认偏好建立 system 快照，管理工具仍指向正在编辑的条目', async () => {
  const { profile, editingId } = await profiles()
  const h = initializationFixture({ userPreferenceProfile: profile })
  for (const [index, cardTask] of ['edit', 'extract', 'mvu', 'user-profile', undefined].entries()) {
    const chat = await h.make().start({ ...h.input, mode: 'card', sessionId: 'card-' + index, cardTask, ...(cardTask === 'user-profile' ? { cardPath: '' } : {}) })
    assert.equal(chat.userProfileEnabled, true)
    assert.equal(chat.userProfileId, 'default')
    assert.equal(chat.userProfileManagementId, editingId)
    assert.match(chat.userProfileContextSnapshot, /固定偏好/)
    assert.equal(h.session(chat.sessionId).prefix, chat.cardContextSnapshot)
    if (cardTask === 'user-profile') {
      assert.equal(chat.cardContextSnapshot, chat.userProfileContextSnapshot)
      assert.equal(chat.cardReferenceContext, undefined)
    } else {
      // Card-bound card Agents, including the edit task, get the foreground card + constant-worldbook reference, frozen at start.
      assert.deepEqual(chat.cardReferenceContext, { version: 1 })
      assert.equal(chat.cardEditContext, undefined)
      assert.ok(chat.cardContextSnapshot.startsWith(chat.userProfileContextSnapshot + '\n\n'))
      assert.match(chat.cardContextSnapshot, /固定描述[\s\S]*逐轮系统[\s\S]*固定世界书/)
      assert.doesNotMatch(chat.cardContextSnapshot, /动态世界书|逐轮后置/)
      assert.equal(chat.cardDefinitionSnapshot, undefined)
      assert.equal(chat.cardContentDigest, undefined)
      assert.equal(chat.sceneOpeningWorldbook, undefined)
    }
  }
})

test('卡片 Agent system：保留卡片人设，人物卡与常驻世界书作为参考资料附在说明之后', async () => {
  const strategy = createNativePlayOrchestrationStrategy({ modeFor: async () => 'card', visibleTools: async () => [], controlledToolNames: new Set(),
    cardSystemPrompt: () => '卡片 Agent 职责', cardReferencePrompt: () => '参考资料说明', workspaceContext: () => '卡片资源工作区' })
  const fixed = [
    { name: 'tavern:user-preference', text: '【用户已确认的长期偏好】偏好' },
    { name: 'tavern:character-card', text: '【故事设定 · 人物卡】卡' },
    { name: 'tavern:card-system-prompt', text: '【人物卡系统提示】卡内提示' },
    { name: 'tavern:constant-worldbook', text: '【常驻世界书】书' },
    { name: 'tavern:variable-directory', text: '变量目录' }
  ]
  const names = async (chat, sections) => (await strategy.assembleSystemPrompt({ tools: [] }, { sessionId: 's', chat, fixedSystemSections: sections })).sections.map(section => section.name)
  assert.deepEqual(await names({ mode: 'card', cardReferenceContext: { version: 1 } }, fixed), [
    'tavern:user-preference', 'tavern:card-system', 'tavern:card-reference', 'tavern:character-card', 'tavern:card-system-prompt', 'tavern:constant-worldbook', 'tavern:resource-workspace'])
  assert.deepEqual(await names({ mode: 'card' }, fixed.slice(0, 1)), ['tavern:user-preference', 'tavern:card-system', 'tavern:resource-workspace'])
  assert.deepEqual(await names({ mode: 'card', cardEditContext: { version: 1 } }, fixed), fixed.map(section => section.name))
})

test('重新进入卡片会话保留原偏好；默认关闭或仅有草案时不注入', async () => {
  const { profile } = await profiles()
  const h = initializationFixture({ userPreferenceProfile: profile })
  const input = { ...h.input, mode: 'card', cardPath: '' }
  const first = await h.make().start(input)
  await profile.save({ profileId: 'default', content: '修改后的偏好' })
  await profile.setDefaultEnabled(false)
  const reopened = await h.make().start(input)
  assert.equal(reopened.userProfileContextSnapshot, first.userProfileContextSnapshot)
  const disabled = await h.make().start({ ...input, sessionId: 'disabled' })
  assert.equal(disabled.userProfileEnabled, false)
  assert.equal(disabled.cardContextSnapshot, '')
  assert.ok(disabled.cardContextSnapshotVersion > 0)
  const draft = initializationFixture({ userPreferenceProfile: { read: async () => ({ hasConfirmed: false, defaultEnabled: true }) } })
  assert.equal((await draft.make().start(input)).cardContextSnapshot, '')
})

test('旧卡片会话只补入一次，空快照也冻结关闭状态；失败不污染 Chat', async () => {
  const { profile } = await profiles()
  let writes = 0, fail = true
  const snapshots = createPlayCardSnapshots({ userPreferenceProfile: profile,
    readCard: () => { throw Error('不得读卡') }, worldBooks: { bound() { throw Error('不得读世界书') } },
    planner: { plan() { throw Error('不得构建人物卡背景') } },
    writeChat: async chat => { writes++; if (fail) throw Error('disk full'); return { ...chat, _storageRevision: writes } }
  })
  const old = { id: 'old-card', mode: 'card', cardContextSnapshotVersion: 0, userProfileEnabled: false, userProfileId: 'original-tool-target', messages: [{ text: '已有对话' }] }
  const before = structuredClone(old)
  await assert.rejects(snapshots.ensure(old), /disk full/)
  assert.deepEqual(old, before)
  fail = false
  const values = await Promise.all([snapshots.ensure(old), snapshots.ensure(old)])
  assert.equal(values[0], values[1])
  assert.match(values[0], /固定偏好/)
  assert.equal(old.userProfileManagementId, 'original-tool-target')
  assert.deepEqual(old.messages, before.messages)
  const count = writes
  await profile.save({ profileId: 'default', content: '新内容' })
  assert.equal(await snapshots.ensure(old), values[0])
  assert.equal(writes, count)
  await profile.setDefaultEnabled(false)
  const disabled = { ...before, id: 'old-disabled' }
  assert.equal(await snapshots.ensure(disabled), '')
  const disabledWrites = writes
  await profile.setDefaultEnabled(true, 'default')
  assert.equal(await snapshots.ensure(disabled), '')
  assert.equal(writes, disabledWrites)
})

test('读取、保存和确认工具使用管理目标，避免修改注入的默认偏好', async () => {
  const { profile, editingId } = await profiles()
  const tools = new Map()
  registerUserProfileTools({ tools: { register(tool) { tools.set(tool.name, tool) } }, userPreferenceProfile: profile,
    chatForSession: async () => ({ mode: 'card', userProfileId: 'default', userProfileManagementId: editingId }) })
  const execution = { agent: { session: { id: 'card' } } }
  const read = await tools.get('tavern_user_profile_read').execute({}, execution)
  assert.match(read.confirmedJson, /正在编辑的内容/)
  await tools.get('tavern_user_profile_save').execute({ content: '保存到管理条目' }, execution)
  assert.match((await profile.read(editingId)).confirmed.injectionText, /保存到管理条目/)
  const draft = await profile.saveDraft({ profileId: editingId, injectionText: '确认到管理条目' })
  await tools.get('tavern_user_profile_confirm').execute({ draftRevision: draft.draft.revision, confirmation: '确认保存用户画像' }, execution)
  assert.match((await profile.read(editingId)).confirmed.injectionText, /确认到管理条目/)
  assert.match((await profile.read('default')).confirmed.injectionText, /固定偏好/)
})

test('真实卡片 Agent 请求：偏好仅在 system，附加指令置顶且修改和清空立即生效', { skip: !process.env.DSH_BOOT_MODULE }, async t => {
  const { profile } = await profiles()
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE, { userPreferenceProfile: profile, assembleStablePrefix: false })
  t.after(() => h.dispose())
  let chat = await h.open().start({ ...h.input, mode: 'card', cardPath: '' })
  let append = '附加指令第一版'
  const snapshots = createPlayCardSnapshots({ userPreferenceProfile: profile, writeChat: async next => { chat = next; return next } })
  const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
  const implementation = source.slice(source.indexOf('  async function ensureNativeSystemPrefix('), source.indexOf('  async function ensureNativeCardWorkspace('))
  const ensurePrefix = vm.runInNewContext(`(${implementation.trim()})`, {
    readSessionStablePrefix, ensureSessionStablePrefix, ensureSessionVariableDirectory,
    ensurePlayCardSnapshot: snapshots.ensure, stablePrefixStorage: undefined, sessionStore: { flush: session => h.ctx.sessions.flush(session) }
  })
  const strategy = createNativePlayOrchestrationStrategy({ modeFor: async () => 'card', visibleTools: async () => [], controlledToolNames: new Set(),
    cardSystemPrompt: () => '卡片 Agent 职责', workspaceContext: () => '卡片资源工作区' })
  registerTurnLifecycleHooks({ ctx: h.ctx, chatForSession: async () => chat, ensureNativeSystemPrefix: ensurePrefix,
    backgroundAgentRunner: { owns: () => false }, fullTemplateRuntime: { cancel() {} }, clearRuntimePresetRequestState() {},
    userMessageForTurn: () => null, contentText: () => '', foregroundHandoff: { end() {} },
    sessionStore: { flush: session => h.ctx.sessions.flush(session) }, foregroundStrategies: strategy, turnOrchestrator: { modeFor: async () => 'card' },
    publishResourceWorkspace: async () => ({}), runtimePrompt: () => append
  })
  for (const value of ['附加指令第一版', '附加指令第二版', '']) {
    append = value
    h.target.agent.followup({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: '继续制作人物卡' }], source: { kind: 'human' } })
    await h.target.agent.whenIdle()
    await profile.save({ profileId: 'default', content: '不应自动替换的偏好' })
  }
  assert.equal(h.requests.length, 3)
  for (const [index, request] of h.requests.entries()) {
    assert.equal(request.system.split('固定偏好').length - 1, 1)
    assert.match(request.system, /卡片 Agent 职责/)
    assert.match(request.system, /卡片资源工作区/)
    assert.doesNotMatch(request.system, /不应自动替换|不可丢失的固定背景/)
    assert.ok(request.messages.filter(m => m.role !== 'system').every(m => !JSON.stringify(m.content).includes('固定偏好')))
    if (index < 2) assert.ok(request.system.startsWith(index ? '附加指令第二版\n\n' : '附加指令第一版\n\n'))
    else assert.doesNotMatch(request.system, /附加指令/)
  }
})

test('真实卡片 Agent 请求：绑定人物卡时 system 附带人物卡与常驻世界书参考，不进入消息', { skip: !process.env.DSH_BOOT_MODULE }, async t => {
  const { profile } = await profiles()
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE, { userPreferenceProfile: profile, assembleStablePrefix: false })
  t.after(() => h.dispose())
  let chat = await h.open().start({ ...h.input, mode: 'card' })
  assert.deepEqual(chat.cardReferenceContext, { version: 1 })
  const snapshots = createPlayCardSnapshots({ userPreferenceProfile: profile, writeChat: async next => { chat = next; return next } })
  const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
  const implementation = source.slice(source.indexOf('  async function ensureNativeSystemPrefix('), source.indexOf('  async function ensureNativeCardWorkspace('))
  const ensurePrefix = vm.runInNewContext(`(${implementation.trim()})`, {
    readSessionStablePrefix, ensureSessionStablePrefix, ensureSessionVariableDirectory,
    ensurePlayCardSnapshot: snapshots.ensure, stablePrefixStorage: undefined, sessionStore: { flush: session => h.ctx.sessions.flush(session) }
  })
  const strategy = createNativePlayOrchestrationStrategy({ modeFor: async () => 'card', visibleTools: async () => [], controlledToolNames: new Set(),
    cardSystemPrompt: () => '卡片 Agent 职责', cardReferencePrompt: () => '参考资料说明', workspaceContext: () => '卡片资源工作区' })
  registerTurnLifecycleHooks({ ctx: h.ctx, chatForSession: async () => chat, ensureNativeSystemPrefix: ensurePrefix,
    backgroundAgentRunner: { owns: () => false }, fullTemplateRuntime: { cancel() {} }, clearRuntimePresetRequestState() {},
    userMessageForTurn: () => null, contentText: () => '', foregroundHandoff: { end() {} },
    sessionStore: { flush: session => h.ctx.sessions.flush(session) }, foregroundStrategies: strategy, turnOrchestrator: { modeFor: async () => 'card' },
    publishResourceWorkspace: async () => ({}), runtimePrompt: () => ''
  })
  h.target.agent.followup({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: '帮我改一下描述' }], source: { kind: 'human' } })
  await h.target.agent.whenIdle()
  const request = h.requests.at(-1)
  const order = ['固定偏好', '卡片 Agent 职责', '参考资料说明', '不可丢失的固定背景', 'Fixture card special instruction', 'Fixture constant worldbook', '卡片资源工作区'].map(text => request.system.indexOf(text))
  assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), JSON.stringify(order))
  assert.doesNotMatch(request.system, /Fixture card writing constraint/)
  const messages = JSON.stringify(request.messages.filter(m => m.role !== 'system').map(m => m.content))
  for (const text of ['不可丢失的固定背景', 'Fixture constant worldbook', '固定偏好']) assert.ok(!messages.includes(text), text)
})
