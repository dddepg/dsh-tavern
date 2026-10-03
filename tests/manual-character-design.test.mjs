import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { createBackgroundTaskCoordinator } from '../tavern-plugin/lib/domain/background-task-coordinator.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createManualCharacterDesign } from '../tavern-plugin/lib/domain/manual-character-design.js'

const fields = ['identity', 'narrativeRole', 'coreMotivation', 'innerConflict', 'personality', 'appearance', 'behaviorStyle', 'speechStyle', 'relationships', 'defaultPresentation', 'plotPotential']
const design = { name: '张三', ...Object.fromEntries(fields.map(key => [key, '完整设计内容'])) }
function coordinator(read, write) {
  return createBackgroundTaskCoordinator({ timeline: createStoryTimeline(), store: {
    readChat: async () => structuredClone(read()), writeChat: async chat => write(chat),
    updateChat: async (_id, fn) => { const chat = await fn(structuredClone(read())); write(chat); return chat }
  } })
}
function fixture(runAgent, initial = {}) {
  let chat = { id: 'chat', sessionId: 'session', messages: [{ role: 'assistant', text: '正文保持原样', variables: [{ hp: 10 }] }], ...initial }
  const tasks = coordinator(() => chat, value => { chat = value })
  const api = createManualCharacterDesign({
    beginTask: value => tasks.begin(value, 'character-design'),
    store: { chatForSession: async () => structuredClone(chat), readCard: async () => ({ name: '人物卡' }),
      updateChat: async (_id, update) => { chat = update(structuredClone(chat)); return chat } },
    runAgent, selection: () => ({ provider: 'fixture', model: 'fixture' })
  })
  return { api, tasks, get: () => structuredClone(chat), edit: fn => fn(chat) }
}

test('重复触发被拒绝，未保存档案时报错，服务重启后不会一直显示运行中', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const run = fixture(() => gate)
  await run.api.start({ sessionId: 'session', guidance: '设计张三' })
  await assert.rejects(run.api.start({ sessionId: 'session', guidance: '设计张三' }), /正在进行/)
  release(); await run.api.wait('chat')
  assert.match(run.get().characterDesignTask.error, /模型未调用人物档案保存工具/)
  assert.equal(run.api.project({ id: 'old', characterDesignTask: { status: 'running' } }).status, 'failed')
})

test('校验失败后模型修正并保存成功，不残留失败提示', async () => {
  const run = fixture(async input => {
    await input.onToolCall({ name: 'character_design_save', arguments: { ...design, identity: '' } })
    await input.onToolCall({ name: 'character_design_save', arguments: design })
  })
  await run.api.start({ sessionId: 'session' }); await run.api.wait('chat')
  assert.equal(run.get().characterDesignTask.status, 'done')
  assert.equal(run.get().characterDesignTask.error, '')
  assert.equal(run.get().characterDesignDocument.characters.length, 1)
})

test('提交时保留同时新增的世界书条目，发生手动正文冲突则拒绝整次提交', async () => {
  let concurrentEdit = () => {}
  const run = fixture(async input => {
    assert.equal(JSON.parse(await input.onToolCall({ name: 'character_design_save', arguments: design })).ok, true)
    run.edit(concurrentEdit)
  })
  await run.api.start({ sessionId: 'session' }); await run.api.wait('chat')
  concurrentEdit = chat => { chat.openingWorldbookSnapshot.document.entries[50] = { uid: 50, key: ['城镇'], content: '手动添加的城镇', disable: false } }
  await run.api.start({ sessionId: 'session' }); await run.api.wait('chat')
  assert.equal(run.get().characterDesignTask.status, 'done')
  assert.equal(run.get().openingWorldbookSnapshot.document.entries[50].content, '手动添加的城镇')
  const before = run.get().characterDesignDocument
  concurrentEdit = chat => { chat.openingWorldbookSnapshot.document.entries[0].content = '并发手动修改的人物' }
  await run.api.start({ sessionId: 'session' }); await run.api.wait('chat')
  assert.equal(run.get().characterDesignTask.status, 'failed')
  assert.match(run.get().characterDesignTask.error, /已被手动修改/)
  assert.equal(run.get().openingWorldbookSnapshot.document.entries[0].content, '并发手动修改的人物')
  assert.deepEqual(run.get().characterDesignDocument, before)
})

const existingWorldbook = { version: 1, libraryDigest: 'original', source: null, document: { name: '本局设定', entries: {
  7: { uid: 7, key: ['张三', '三哥'], comment: '张三', content: '张三，别名三哥，是成年守灯人。性格沉稳，穿灰袍，说话简短。负责夜间引路。', disable: false, constant: false }
} } }

test('复用后世界书并发变化时拒绝提交过期判断', async () => {
  const run = fixture(async input => {
    await input.onToolCall({ name: 'character_design_read', arguments: { name: '张三' } })
    await input.onToolCall({ name: 'character_design_reuse', arguments: { name: '张三', refs: ['entry:7'] } })
    run.edit(chat => { chat.openingWorldbookSnapshot.document.entries[7].content = '新设定' })
  }, { openingWorldbookSnapshot: structuredClone(existingWorldbook) })
  await run.api.start({ sessionId: 'session' }); await run.api.wait('chat')
  assert.equal(run.get().characterDesignTask.status, 'failed')
  assert.match(run.get().characterDesignTask.error, /世界书已变化/)
})
