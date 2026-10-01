import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import { sessionEvents, appendSessionEvent } from '../tavern-plugin/lib/domain/session-events.js'
import { ensureSessionStablePrefix, sessionStablePrefixSections } from '../tavern-plugin/lib/domain/session-stable-prefix.js'
import { cardSystemPromptText, cardSystemPromptSnapshot, cardSystemPromptSource } from '../tavern-plugin/lib/domain/card-system-prompt.js'
import { createContextPlanner } from '../tavern-plugin/lib/domain/context-planner.js'
import { createForegroundFrameBuilder } from '../tavern-plugin/lib/domain/agent-input-frame.js'
import { createForegroundFrameSessionAdapter } from '../tavern-plugin/lib/domain/foreground-frame-session-adapter.js'
import { foregroundFrameInputs } from '../tavern-plugin/lib/domain/turn-orchestration.js'
import { retireForegroundFrames } from '../tavern-plugin/lib/domain/foreground-frame-retirement.js'
import { clearRegenerationAttemptSurface } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { createInitializationNative } from './fixtures/conversation-initialization-native.mjs'
import { createSceneImageNativeRuntime } from './fixtures/scene-image-native-runtime.mjs'

const planner = createContextPlanner({ prompt: () => '正文写作规则' })
const background = text => '【故事设定 · 人物卡】\n人物背景\n\n' + cardSystemPromptText(text) + '\n\n【常驻世界书】\n世界背景'
function appendUpdate(session, text) {
  const snapshot = cardSystemPromptSnapshot(session, text)
  if (!snapshot) return null
  return appendSessionEvent(session, 'user/message', { id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: snapshot.rendered }],
    source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'card-system-prompt-update', trace: cardSystemPromptSource(snapshot) } }, { surfaceOp: 'append' })
}

test('系统提示进入开局与候选固定背景，历史后指令继续逐轮提供', async () => {
  const card = { name: '角色', system_prompt: '叙述{{char}}的故事', post_history_instructions: '只输出正文' }
  const chat = { guides: [], posture: '' }
  const snapshot = await planner.plan({ purpose: 'play-card-snapshot', card, chat })
  const body = await planner.plan({ purpose: 'body', card, chat })
  const candidate = await planner.plan({ purpose: 'candidate', card, chat, task: '候选协议' })
  assert.match(snapshot.text, /【人物卡系统提示】\n叙述角色的故事/)
  assert.doesNotMatch(snapshot.text, /只输出正文/)
  assert.doesNotMatch(body.text, /叙述角色的故事/)
  assert.match(body.text, /只输出正文/)
  assert.equal(body.systemPromptText, '叙述角色的故事')
  assert.match(candidate.stableText, /叙述角色的故事/)
  assert.doesNotMatch(candidate.stableText, /只输出正文/)
  const conditional = { name: '角色', system_prompt: '{{if .enabled}}条件指令{{/if}}' }
  assert.equal((await planner.plan({ purpose: 'body', card: conditional, chat: { macroState: { local: { enabled: false } } } })).systemPromptText, '')
  assert.equal((await planner.plan({ purpose: 'body', card: conditional, chat: { macroState: { local: { enabled: true } } } })).systemPromptText, '条件指令')
})

test('同值不追加，变化、恢复开局值和清空分别追加完整版本；旧事件与固定前缀不变', async () => {
  const session = Session.create('card-instructions')
  await ensureSessionStablePrefix(session, background('晴'))
  const fixed = structuredClone(sessionStablePrefixSections(session))
  const openingEvents = structuredClone(sessionEvents(session))
  assert.equal(appendUpdate(session, '晴'), null)
  appendUpdate(session, '雨')
  assert.equal(appendUpdate(session, '雨'), null)
  appendUpdate(session, '晴')
  const cleared = appendUpdate(session, '')
  assert.match(cleared.data.content[0].text, /全部失效/)
  assert.equal(appendUpdate(session, ''), null)
  assert.deepEqual(sessionStablePrefixSections(session), fixed)
  assert.deepEqual(sessionEvents(session).slice(0, openingEvents.length), openingEvents)
  assert.equal(session.deriveMessages().filter(m => m.source?.form === 'card-system-prompt-update').length, 3)
  const restored = Session.create(session.id, sessionEvents(session), session.header)
  assert.equal(appendUpdate(restored, ''), null)
})

test('旧会话缺少系统提示时追加补入，不重写背景；空字段无需补入', async () => {
  const session = Session.create('legacy-card-instructions')
  await ensureSessionStablePrefix(session, '【故事设定 · 人物卡】\n旧背景')
  const fixed = structuredClone(sessionStablePrefixSections(session))
  assert.equal(appendUpdate(session, ''), null)
  assert.ok(appendUpdate(session, '补入的系统指令'))
  assert.equal(appendUpdate(session, '补入的系统指令'), null)
  assert.deepEqual(sessionStablePrefixSections(session), fixed)
})

test('回退或压缩掉更新后重新追加；被改写或外部插件的记录不能抑制更新', async () => {
  const session = Session.create('rewound-card-instructions')
  await ensureSessionStablePrefix(session, background('晴'))
  const eventStart = session.seq
  appendUpdate(session, '雨')
  assert.ok(clearRegenerationAttemptSurface({ session, eventStart }))
  assert.equal(cardSystemPromptSnapshot(session, '晴'), null)
  const record = cardSystemPromptSnapshot(session, '雨')
  assert.ok(record)
  const fake = { role: 'user', content: [{ type: 'text', text: '已改写' }], source: { plugin: 'dsh-tavern', trace: cardSystemPromptSource(record) } }
  assert.ok(cardSystemPromptSnapshot(session, '雨', [fake]))
  assert.equal(cardSystemPromptSnapshot(session, '雨', [{ ...fake, content: [{ type: 'text', text: record.rendered }] }]), null)
  assert.ok(cardSystemPromptSnapshot(session, '雨', [{ ...fake, source: { plugin: 'other', trace: cardSystemPromptSource(record) } }]))
  const updated = appendUpdate(session, '雨')
  appendSessionEvent(session, 'user/message', { id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: '压缩摘要' }], source: { kind: 'plugin', plugin: 'dsh-tavern' } },
    { surfaceOp: { op: 'replace', start: updated.seq, end: updated.seq }, sourceEventSeqs: [updated.seq] })
  assert.ok(cardSystemPromptSnapshot(session, '雨'))
})

test('更新消息不随短期 Frame 清理；同一 Frame 重试和非首步不重复追加', async () => {
  const session = Session.create('card-frame')
  await ensureSessionStablePrefix(session, background('晴'))
  const frame = createForegroundFrameBuilder().build({ chatId: 'chat', branchId: 'branch', basedOnRevision: 1, operationId: 'operation', turn: 1,
    inputs: [{ kind: 'foreground.user-input', sourceText: '继续' }, { kind: 'foreground.writing-rules', text: '本轮规则' }], source: { card: { systemPromptText: '雨' } } })
  const adapter = createForegroundFrameSessionAdapter()
  const first = adapter.append({ session, messages: [], frame, step: 1 })
  assert.equal(first.messages.length, 2)
  assert.equal(adapter.append({ session, messages: first.messages, frame, step: 1 }).receipt.reason, 'duplicate')
  assert.equal(adapter.append({ session, messages: [], frame, step: 2 }).receipt.reason, 'not-first-step')
  for (const message of first.messages) appendSessionEvent(session, 'user/message', message, { surfaceOp: 'append' })
  retireForegroundFrames(session)
  assert.equal(cardSystemPromptSnapshot(session, '雨'), null)
  assert.match(JSON.stringify(session.deriveMessages()), /人物卡系统指令更新/)
})

test('真实 DSH 请求：动态宏变化只追加新版本，系统与此前请求消息逐字保持', { skip: !process.env.DSH_BOOT_MODULE }, async t => {
  const card = { name: '角色', system_prompt: '当前天气={{getvar::weather}}', post_history_instructions: '历史后指令' }
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE, { cardOverrides: card, contextWindow: 20000 })
  t.after(() => h.dispose())
  await h.open().start(h.input)
  let weather = '', n = 0
  const adapter = createForegroundFrameSessionAdapter()
  h.ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const plan = await planner.plan({ purpose: 'body', card, chat: { macroState: { local: { weather } } } })
    const frame = createForegroundFrameBuilder().build({ chatId: 'chat', branchId: 'branch', basedOnRevision: n, operationId: 'op-' + (++n), turn: payload.turn,
      inputs: foregroundFrameInputs(plan, '继续', '继续', null, {}), source: { card: { systemPromptText: plan.systemPromptText } } })
    return { ...decision, messages: adapter.append({ session: payload.agent.session, messages: decision.messages, frame, step: payload.step }).messages }
  })
  for (const value of ['', '', '雨', '雨', '']) {
    weather = value
    h.target.agent.followup({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'human' } })
    await h.target.agent.whenIdle()
  }
  assert.equal(h.requests.length, 5)
  const updates = request => request.messages.filter(m => m.source?.form === 'card-system-prompt-update')
  assert.deepEqual(h.requests.map(r => updates(r).length), [0, 0, 1, 1, 2])
  const visible = request => request.messages.map(({ role, content }) => ({ role, content }))
  for (const [index, request] of h.requests.entries()) {
    assert.equal(request.system, h.requests[0].system)
    assert.match(request.system, /【人物卡系统提示】\n当前天气=/)
    assert.doesNotMatch(request.system, /历史后指令/)
    assert.ok(request.messages.filter(m => m.source?.form === 'foreground-frame').every(m => !JSON.stringify(m.content).includes('当前天气=')))
    if (index) {
      const before = visible(h.requests[index - 1])
      assert.deepEqual(visible(request).slice(0, before.length), before)
    }
  }
})

test('真实后台候选请求：复用固定前缀，变化与清空追加，重启后去重且结算不改写前缀', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async t => {
  const runtime = await createSceneImageNativeRuntime(process.env.DSH_BOOT_MODULE, { residentOptions: { resolveStablePrefix: () => background('天气：晴') } })
  t.after(() => runtime.dispose())
  let id
  const run = async (task, systemPromptText) => {
    const result = await runtime.runBackground({ sessionId: 'scene-parent', task, persistent: true, persistentSessionId: id,
      selection: { provider: 'scene-fixture', model: 'fixture-text' }, system: '本轮任务协议', systemPromptText, postHistoryText: '历史后指令', messages: [], tools: [] })
    id = result.traceSessionId
  }
  await run('settlement', '不属于结算的指令')
  for (const text of ['天气：晴', '天气：雨', '天气：雨']) await run('candidate', text)
  await runtime.restart()
  await run('candidate', '天气：雨')
  await run('candidate', '')
  await run('candidate', '天气：晴')
  await run('settlement', '不属于结算的指令')
  const updates = request => request.messages.filter(m => m.source?.trace?.cardSystemPromptSnapshot)
  assert.deepEqual(runtime.requests.map(r => updates(r).length), [0, 0, 1, 1, 1, 2, 3, 3])
  for (const [index, request] of runtime.requests.entries()) {
    assert.equal(request.system, runtime.requests[0].system)
    assert.match(request.system, /仅用于候选文本的写作/)
    assert.match(request.system, /天气：晴/)
    assert.doesNotMatch(request.system, /历史后指令|天气：雨|不属于结算/)
    if (index && index < 7) assert.match(JSON.stringify(request.messages.at(-1).content), /历史后指令/)
  }
  assert.match(updates(runtime.requests[5]).at(-1).content[0].text, /全部失效/)
})

test('生图和手机私聊的真实 system 不继承人物卡写作指令', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async t => {
  const runtime = await createSceneImageNativeRuntime(process.env.DSH_BOOT_MODULE, { residentOptions: { resolveStablePrefix: () => background('ONLY_CARD_DIRECTIVE') } })
  t.after(() => runtime.dispose())
  for (const task of ['image', 'phone']) {
    await runtime.runBackground({ sessionId: 'scene-parent', task, selection: { provider: 'scene-fixture', model: 'fixture-text' }, messages: [], tools: [] })
    assert.doesNotMatch(runtime.requests.at(-1).system, /ONLY_CARD_DIRECTIVE/)
    assert.match(runtime.requests.at(-1).system, /人物背景/)
  }
})
