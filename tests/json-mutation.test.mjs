import assert from 'node:assert/strict'
import test from 'node:test'

import { applyJsonChanges, applyJsonChangesShared, diffJson } from '../tavern-plugin/lib/domain/json-mutation.js'

test('JSON mutation round-trip 保留完整目标值', function () {
  const before = {
    id: 'chat-1',
    messages: [{ role: 'user', text: '开门' }, { role: 'assistant', text: '门开了' }],
    timeline: { revision: 2, operations: { first: { status: 'running' } } },
    candidates: null
  }
  const after = structuredClone(before)
  after.messages[1].displayRuntime = { frames: [{ partIndex: 0 }] }
  after.messages.push({ role: 'user', text: '进去' })
  after.timeline.revision = 3
  after.timeline.operations.first.status = 'completed'
  after.timeline.operations.second = { status: 'running' }
  after.candidates = { choices: ['上楼'] }

  const changes = diffJson(before, after)
  assert.deepEqual(applyJsonChanges(before, changes), after)
})

test('数组尾部追加不携带已有消息', function () {
  const before = { messages: [{ id: 'old-1', text: '一' }, { id: 'old-2', text: '二' }] }
  const after = { messages: before.messages.concat({ id: 'new-3', text: '三' }) }
  const changes = diffJson(before, after)

  assert.deepEqual(changes, [{ op: 'splice', path: ['messages'], index: 2, deleteCount: 0, items: [{ id: 'new-3', text: '三' }] }])
  assert.doesNotMatch(JSON.stringify(changes), /old-1|old-2/)
})

test('局部 operation 更新不携带完整 timeline', function () {
  const before = { timeline: { revision: 7, operations: { op1: { status: 'running', prompt: '很长的提示词' }, op2: { status: 'completed' } } } }
  const after = structuredClone(before)
  after.timeline.operations.op1.status = 'completed'
  after.timeline.revision = 8
  const changes = diffJson(before, after)

  assert.deepEqual(changes, [
    { op: 'set', path: ['timeline', 'operations', 'op1', 'status'], value: 'completed' },
    { op: 'set', path: ['timeline', 'revision'], value: 8 }
  ])
  assert.doesNotMatch(JSON.stringify(changes), /很长的提示词|op2/)
})

test('数组截断与元素修改可以重放', function () {
  const before = { values: [{ n: 1 }, { n: 2 }, { n: 3 }] }
  const after = { values: [{ n: 1 }, { n: 20 }] }
  const changes = diffJson(before, after)

  assert.deepEqual(applyJsonChanges(before, changes), after)
  assert.deepEqual(changes, [
    { op: 'set', path: ['values', 1, 'n'], value: 20 },
    { op: 'splice', path: ['values'], index: 2, deleteCount: 1, items: [] }
  ])
})

test('相同 JSON 不产生 changes', function () {
  const value = { id: 'chat-1', nested: { active: true }, messages: [] }
  assert.deepEqual(diffJson(value, structuredClone(value)), [])
})


test('shared journal changes match replay without copying or mutating untouched rows', () => {
  const before={messages:[{text:'keep',variables:[{hp:7}]},{text:'edit',variables:[{hp:8,mp:2}]}],items:['a','b']}
  const desired=structuredClone(before)
  desired.messages[1].variables[0].hp=9
  delete desired.messages[1].variables[0].mp
  desired.items.splice(1,1,'c','d')
  const changes=diffJson(before,desired)
  const next=applyJsonChangesShared(before,changes)
  assert.deepEqual(next,applyJsonChanges(before,changes))
  assert.equal(next.messages[0],before.messages[0])
  assert.notEqual(next.messages[1],before.messages[1])
  assert.equal(before.messages[1].variables[0].hp,8)
  assert.throws(()=>applyJsonChangesShared(before,[{op:'set',path:['messages',999,'text'],value:'bad'}]))
  assert.throws(()=>applyJsonChangesShared(before,[{op:'set',path:['__proto__','bad'],value:1}]))
})

test('shared batch matches detached application through overlapping mutations', () => {
  const input={messages:[{variables:{old:1},text:'a'},{text:'b'}],meta:{keep:1}}
  const inserted={text:'c',variables:{n:1}}
  const changes=[
    {op:'set',path:['messages',0,'variables'],value:{next:2}},
    {op:'set',path:['messages',0,'variables','more'],value:3},
    {op:'splice',path:['messages'],index:1,deleteCount:1,items:[inserted]},
    {op:'set',path:['messages',1,'variables','n'],value:4},
    {op:'delete',path:['messages',0,'text']},
    {op:'set',path:['meta','added'],value:true}
  ]
  const original=structuredClone(input), patches=structuredClone(changes)
  const result=applyJsonChangesShared(input,changes)
  assert.deepEqual(result,applyJsonChanges(input,changes))
  assert.deepEqual(input,original)
  assert.deepEqual(changes,patches)
  result.messages[1].variables.n=9
  assert.equal(inserted.variables.n,1)
})

test('a later invalid patch cannot mutate the original state', () => {
  const input={messages:[{text:'old'}]}
  assert.throws(()=>applyJsonChangesShared(input,[
    {op:'set',path:['messages',0,'text'],value:'new'},
    {op:'delete',path:['messages',9,'missing']}
  ]))
  assert.deepEqual(input,{messages:[{text:'old'}]})
})

test('set does not traverse the discarded old subtree', () => {
  const input={payload:{get unused(){throw new Error('old subtree traversed')}}}
  assert.deepEqual(applyJsonChangesShared(input,[{op:'set',path:['payload'],value:{new:1}}]),{payload:{new:1}})
})
