import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareWorldBookRecall, projectWorldBookTemplates } from '../tavern-plugin/lib/domain/worldbook-recall.js'
import { inspectWorldBookDocument, updateWorldBookDocument, exportCharacterBook, exportSillyTavernWorldBook } from '../tavern-plugin/lib/domain/worldbook-resource.js'
import { createForegroundWorldbook } from '../tavern-plugin/lib/domain/foreground-worldbook.js'
import { UpstreamTemplateRuntime } from './fixtures/upstream-template-runtime.mjs'

const runtime = await UpstreamTemplateRuntime.create()

const e = (uid, key, extra = {}) => ({ uid, key: [key], content: '设定' + uid, order: 100, ...extra })
const book = (entries, settings = {}) => ({ view: inspectWorldBookDocument({ ...settings, entries: Object.fromEntries(entries.map(entry => [entry.uid, entry])) }) })
const recall = (entries, options = {}, settings = {}) => prepareWorldBookRecall({ worldBook: book(entries, settings), turn: 2, chat: { messages: [] }, ...options })

test('当前玩家输入参与匹配，单词不会拆成字母，默认窗口不读取全部历史', async () => {
  const entries = [e(0, 'Alice'), e(1, '矿井'), e(2, 'a', { matchWholeWords: true })]
  const chat = { messages: [{ role: 'assistant', text: '矿井' }, { role: 'user', text: '走吧' }, { role: 'assistant', text: '晴天' }] }
  assert.deepEqual(recall(entries, { chat, userText: 'Alice' }).refs, ['entry:0'])
  assert.deepEqual(recall(entries, { userText: 'A local ice shop' }).refs, ['entry:2'])
  assert.deepEqual(recall(entries, { userText: 'place' }).refs, [])
})

test('常驻条目可触发递归；未入选条目不能把隐藏正文带入扫描', async () => {
  const entries = [e(0, '', { constant: true, content: 'Alice' }), e(1, 'Alice')]
  assert.deepEqual(recall(entries, {}, { recursive_scanning: true }).refs, ['entry:1'])
  const overflow = Array.from({ length: 6 }, (_, uid) => e(uid, 'start', { order: uid, content: uid === 0 ? 'hidden' : '普通内容' }))
  overflow.push(e(9, 'hidden', { order: 999 }))
  const result = recall(overflow, { userText: 'start' }, { recursive_scanning: true, token_budget: 30 })
  assert.equal(result.refs.length, 5)
  assert.ok(!result.refs.includes('entry:9'))
  assert.equal(result.diagnostics.find(item => item.ref === 'entry:0').reason, 'budget')
})
test('包含组支持优先级、权重、计分和多个组，不会重复入选', async () => {
  const entries = [e(0, 'Alice', { group: '角色', groupOverride: true, order: 10 }), e(1, 'Alice', { group: '角色', order: 200 })]
  assert.deepEqual(recall(entries, { userText: 'Alice' }).refs, ['entry:0'])
  entries[0].groupOverride = false
  entries[0].groupWeight = 0
  assert.deepEqual(recall(entries, { userText: 'Alice', random: () => 0.4 }).refs, ['entry:1'])
  entries[0].key = ['Alice', 'Bob']; entries[0].useGroupScoring = true; entries[0].groupWeight = 100
  entries[1].useGroupScoring = true
  assert.deepEqual(recall(entries, { userText: 'Alice Bob' }).refs, ['entry:0'])
  entries[0].group = '角色, 人物'
  entries.push(e(2, 'Alice', { group: '人物', useGroupScoring: true }))
  assert.deepEqual(recall(entries, { userText: 'Alice Bob' }).refs, ['entry:0'])
})

test('扫描和分组设置在独立、嵌入格式往返时保留，编辑不修改原文件', async () => {
  const original = { entries: { 0: e(0, 'Alice') } }
  const updated = updateWorldBookDocument(original, { scanDepth: 8, recursiveScanning: true, operations: [{ op: 'update', ref: 'entry:0', patch: { scanDepth: 4, group: '角色', groupOverride: true, groupWeight: 20, useGroupScoring: true } }] }).document
  const exported = exportSillyTavernWorldBook(exportCharacterBook(updated))
  const view = inspectWorldBookDocument(exported)
  assert.equal(view.scanDepth, 8)
  assert.equal(view.recursiveScanning, true)
  assert.equal(view.entries[0].groupOverride, true)
  assert.equal(view.entries[0].groupWeight, 20)
  assert.equal(view.entries[0].useGroupScoring, true)
  assert.equal(view.entries[0].scanDepth, 4)
  assert.equal(original.scan_depth, undefined)
})

test('正式前台投影：蓝灯标签包住绿灯角色，系统前缀无重复，同一轮重试无重复冷却', async () => {
  const worldBook = book([e(0, '', { constant: true, order: 10, content: '<角色库>' }),
    e(1, 'Alice', { order: 20, content: 'Alice 的资料' }), e(2, '', { constant: true, order: 30, content: '</角色库>' }),
    e(3, '', { constant: true, position: 1, content: '通用规则' })])
  const project = createForegroundWorldbook({ bound: async () => worldBook, runtime: async () => runtime, globalVariables: async () => ({}) })
  const chat = { messages: [{ role: 'assistant', text: '天气晴朗', turn: 1 }] }
  const first = await project({ chat, card: {}, userText: '找 Alice' })
  assert.equal(first.error, null)
  assert.equal(first.context, '<角色库>\n\nAlice 的资料\n\n</角色库>')
  assert.equal(first.prefixContext, '通用规则')
  chat.worldBookReads = first.reads; chat.preparedWorldBook = first.activation
  assert.equal((await project({ chat, card: {}, userText: '找 Alice' })).context, first.context)
  chat.messages.push({ role: 'assistant', text: 'Alice 来了', turn: 2 })
  const second = await project({ chat, card: {}, userText: '继续' })
  assert.equal(second.context, '<角色库>\n\n</角色库>')
  assert.equal(second.reads['entry:1'].turn, 1)
  const prefixOnly = await projectWorldBookTemplates({ worldBook, runtime, includeConstants: true, chat, card: {} })
  assert.equal(prefixOnly.prefixContext, '通用规则')
})
test('失败的绿灯 EJS 不泄露源码、不消耗冷却；脚本扫描与玩家输入共享 token 预算', async () => {
  const entries = Array.from({ length: 6 }, (_, uid) => e(uid, uid > 2 ? 'script' : 'player', { order: uid }))
  entries.push(e(9, 'player', { content: '<% if ( %>', order: 999 }))
  const project = createForegroundWorldbook({ bound: async () => book(entries, { token_budget: 20 }), runtime: async () => runtime, globalVariables: async () => ({}), scanText: () => 'script' })
  const result = await project({ chat: { messages: [] }, card: {}, userText: 'player' })
  assert.equal(result.refs.length, 4)
  assert.equal(result.reads['entry:9'], undefined)
  assert.doesNotMatch(result.context, /<%/)
  assert.equal(result.diagnostics[0].code, 'syntax-error')
})
