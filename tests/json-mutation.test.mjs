import assert from 'node:assert/strict'
import test from 'node:test'

import { applyJsonChanges, applyJsonChangesShared, diffJson } from '../tavern-plugin/lib/domain/json-mutation.js'

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

test('set does not traverse the discarded old subtree', () => {
  const input={payload:{get unused(){throw new Error('old subtree traversed')}}}
  assert.deepEqual(applyJsonChangesShared(input,[{op:'set',path:['payload'],value:{new:1}}]),{payload:{new:1}})
})
