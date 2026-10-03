import assert from 'node:assert/strict'
import test from 'node:test'

import { constantWorldBookContext, projectWorldBookTemplates, prepareWorldBookRecall } from '../tavern-plugin/lib/domain/worldbook-recall.js'
import { UpstreamTemplateRuntime } from './fixtures/upstream-template-runtime.mjs'

function entry(ref, content, options = {}) {
  return {
    ref,
    title: options.title || ref,
    content,
    enabled: options.enabled !== false,
    constant: options.constant === true,
    primaryKeys: options.primaryKeys || [],
    secondaryKeys: options.secondaryKeys || [],
    selective: options.selective === true,
    selectiveLogic: options.selectiveLogic ?? 0,
    caseSensitive: options.caseSensitive ?? null,
    matchWholeWords: options.matchWholeWords ?? null,
    order: options.order ?? 100,
    displayIndex: options.displayIndex ?? Number(ref.replace(/\D/g, '') || 0)
  }
}

function card() { return { name: '阿芙拉' } }

function chat(body = '两人正在旅店大厅交谈。') {
  return {
    id: 'chat-1', cardPath: 'cards/阿芙拉.json', cardName: '阿芙拉', mode: 'story',
    messages: [{ role: 'assistant', text: body, turn: 2 }],
    macroState: { userName: '叶舟', local: {}, global: {} }
  }
}

test('预算内实际注入的条目进入十轮冷却，未入选条目下一轮仍可竞争', async function () {
  const entries = [0, 1, 2, 3, 4, 5].map(function (index) {
    return entry('entry:' + index, '设定 ' + index, { primaryKeys: ['钟楼'], order: 400 - index * 100 })
  })
  const worldBook = { view: { entries, raw: { token_budget: 25 } } }
  const first = prepareWorldBookRecall({ card: card(), chat: chat('抵达钟楼。'), turn: 2, worldBook })
  const reads = first.recordReads(null)

  assert.deepEqual(Object.keys(reads), ['entry:4', 'entry:3', 'entry:2', 'entry:1', 'entry:0'])

  const nextChat = chat('仍在钟楼。')
  nextChat.worldBookReads = reads
  const next = prepareWorldBookRecall({ card: card(), chat: nextChat, turn: 3, worldBook })
  assert.deepEqual(next.refs, ['entry:5'])

  const afterTen = prepareWorldBookRecall({ card: card(), chat: nextChat, turn: 12, worldBook })
  assert.deepEqual(afterTen.refs, ['entry:5'])
  const afterEleven = prepareWorldBookRecall({ card: card(), chat: nextChat, turn: 13, worldBook })
  assert.deepEqual(afterEleven.refs, ['entry:4', 'entry:3', 'entry:2', 'entry:1', 'entry:0'])
})

test('条目正文改变后立即解除冷却，空世界书直接跳过', async function () {
  const skipped = prepareWorldBookRecall({ card: card(), chat: chat(), worldBook: null })
  assert.equal(skipped.kind, 'skip')
  assert.equal(skipped.context, '')
  assert.deepEqual(skipped.refs, [])

  const original = entry('entry:0', '旧设定。', { primaryKeys: ['钟楼'] })
  const first = prepareWorldBookRecall({ card: card(), chat: chat('抵达钟楼。'), turn: 2, worldBook: { view: { entries: [original] } } })
  const current = chat('仍在钟楼。')
  current.worldBookReads = first.recordReads(null)
  const changed = entry('entry:0', '修改后的新设定。', { primaryKeys: ['钟楼'] })

  const prepared = prepareWorldBookRecall({ card: card(), chat: current, turn: 3, worldBook: { view: { entries: [changed] } } })
  assert.deepEqual(prepared.refs, ['entry:0'])
  assert.equal(prepared.context, '修改后的新设定。')
})

test('原生世界书把 EJS 控制器移出稳定前缀，并可按最新 MVU 变量读取停用资料条目', async function () {
  const runtime = await UpstreamTemplateRuntime.create()
  const worldBook = { view: { displayName: '测试世界书', entries: [
    entry('entry:0', '始终可见的静态规则。', { constant: true, order: 300 }),
    {
      ...entry('entry:1', '@@preprocessing\n<% if (getvar("stat_data.stage") === "觉醒") print(await getwi("觉醒资料")) %>', { constant: true, order: 200 }),
      comment: '阶段控制器', title: '阶段控制器', sourceUid: 1
    },
    {
      ...entry('entry:2', '仅在觉醒阶段注入的完整设定。', { constant: true, enabled: false, order: 100 }),
      comment: '觉醒资料', title: '觉醒资料', sourceUid: 2
    }
  ] } }

  const stable = constantWorldBookContext({ worldBook })
  const projected = await projectWorldBookTemplates({
    worldBook,
    runtime: { render: (template, context) => runtime.render(template, context,
      worldBook.view.entries.map(item => ({ ...item, uid: item.sourceUid ?? item.ref, world: worldBook.view.displayName }))) },
    card: { name: '阿芙拉' },
    chat: {
      macroState: { userName: '叶舟', global: {} },
      variables: {},
      messages: [{ role: 'assistant', text: '她抬起头。', variables: [{ stat_data: { stage: '觉醒' } }] }]
    }
  })

  assert.equal(stable.context, '始终可见的静态规则。')
  assert.doesNotMatch(stable.context, /preprocessing|getwi|觉醒资料/)
  assert.equal(projected.context, '仅在觉醒阶段注入的完整设定。')
  assert.deepEqual(projected.refs, ['entry:1'])
  assert.deepEqual(projected.diagnostics, [])
  assert.doesNotMatch(projected.context, /<%|getwi|@@preprocessing/)
})

test('批量与逐条投影逐字一致：准备事件、随机、失败隔离、激活来源和宏顺序', {skip:process.env.TEMPLATE_EXECUTOR === 'server'}, async () => {
  const engine = await UpstreamTemplateRuntime.create()
  const entries = [
    entry('entry:0', '<% setLocalVar("n", 1); setGlobalVar("g", 5); setMessageVar("m", 7); await activateWorldInfo("资料", true) %><%= Math.random() %>{{setvar::label::旅店}}', {constant:true, order:0}),
    entry('entry:1', '普通 {{getvar::label}}', {constant:true, order:1}),
    entry('entry:2', '<% setLocalVar("n", 999); setGlobalVar("g", 999); setMessageVar("m", 999); throw new Error("isolated") %>', {constant:true, order:2}),
    entry('entry:3', '<%= getLocalVar("n") %>|<%= preparedMarker %>|<%= Math.random() %>|{{getvar::label}}', {constant:true, order:3}),
    entry('entry:4', '<% if ( %>', {constant:true, order:4}),
    entry('entry:5', '<%= getLocalVar("n") %>|<%= getGlobalVar("g") %>|<%= getMessageVar("m") %>', {constant:true, order:5}),
    entry('entry:6', '资料内容', {title:'资料', enabled:false, order:6})
  ]
  entries.forEach((entry,index)=>{entry.sourceUid=5600+index})
  const worldBook = {view:{displayName:'issue56-batch-book',entries}}
  const environment = entries.map(e=>({...e,uid:e.sourceUid,world:worldBook.view.displayName}))
  const input = {worldBook, chat:{...chat(),variables:{payload:'v'.repeat(200000)}}, card:card(), includeConstants:true, randomSeed:'issue56-seed'}
  await engine.page.evaluate(()=>{
    window.prepareCalls=0
    window.prepareHook=context=>{window.prepareCalls++;context.preparedMarker='prepared'}
    window.testHost.eventSource.on('prompt_template_prepare',window.prepareHook)
  })
  let batchCalls=0
  const sequential = {render:(text,context)=>engine.render(text,context,environment)}
  try {
    const before = await projectWorldBookTemplates({...input,runtime:sequential})
    const beforeCalls = await engine.page.evaluate(()=>window.prepareCalls)
    await engine.page.evaluate(()=>{window.prepareCalls=0})
    const after = await projectWorldBookTemplates({...input,runtime:{...sequential,renderProjections:async(items,context)=>{
      batchCalls++;const receipts=await engine.renderProjections(items,context,environment)
      assert.ok(receipts.every(result=>!Object.hasOwn(result,'scopes')))
      assert.ok(JSON.stringify(receipts).length<5000)
      return receipts
    }}})
    assert.deepEqual(after,before)
    assert.equal(batchCalls,1)
    assert.equal(await engine.page.evaluate(()=>window.prepareCalls),beforeCalls)
    assert.equal(beforeCalls,5)
    assert.match(after.context,/1\|prepared\|/)
    assert.match(after.context,/1\|5\|7/)
    assert.equal(input.chat.variables.payload.length,200000)
    assert.equal(after.diagnostics.length,2)
    assert.deepEqual(after.activationRequests,[{ref:'entry:6',force:true,sourceRef:'entry:0'}])
  } finally {
    await engine.page.evaluate(()=>window.testHost.eventSource.removeListener('prompt_template_prepare',window.prepareHook))
  }
})

test('批量结果缺失或执行失败不回退重跑，纯文本不派发模板作业', async () => {
  const input = {worldBook:{view:{entries:[entry('entry:0','<%= 1 %>',{constant:true})]}},chat:chat(),card:card()}
  for(const result of [undefined,null,[],[null]]) {
    await assert.rejects(projectWorldBookTemplates({...input,runtime:{
      render:()=>assert.fail('must not replay'),renderProjections:async()=>result
    }}), /批量结果不完整/)
  }
  await assert.rejects(projectWorldBookTemplates({...input,runtime:{
    render:()=>assert.fail('must not replay'),renderProjections:async()=>{throw Error('receipt lost')}
  }}),/receipt lost/)
  const plain=await projectWorldBookTemplates({...input,includeConstants:true,worldBook:{view:{entries:[entry('entry:0','纯文本',{constant:true})]}},runtime:{
    render:()=>assert.fail('no template'),renderProjections:()=>assert.fail('no template')
  }})
  assert.equal(plain.context,'纯文本')
})

for(const ownsHistory of [false,true])test(`worldbook projection respects runtime history ownership: ${ownsHistory}`,async()=>{
 let context,oldReads=0
 const messages=[{role:'assistant',text:'old'},{role:'assistant',text:'latest',variables:[{hp:7}]}]
 Object.defineProperty(messages,0,{get(){oldReads++;return {role:'assistant',text:'old'}},enumerable:true})
 const runtime={...(ownsHistory?{historyContext:'session'}:{}),render:async(_template,value)=>{
  context=value;return {ok:true,text:'rendered',scopes:value.scopes}
 }}
 const result=await projectWorldBookTemplates({worldBook:{view:{entries:[entry('e','<%= 1 %>',{constant:true})]}},runtime,chat:{messages,variables:{x:1}},card:{name:'Alice'}})
 assert.equal(oldReads,ownsHistory?0:1)
 assert.equal(context.scopes.message.hp,7)
 if(ownsHistory)assert.equal(Object.hasOwn(context,'transcript'),false)
 else assert.deepEqual(context.transcript,[{role:'assistant',content:'old'},{role:'assistant',content:'latest'}])
 assert.equal(result.context,'rendered')
})
