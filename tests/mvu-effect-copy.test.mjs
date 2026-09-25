import test from 'node:test'
import assert from 'node:assert/strict'
import {createMvuSettlementEffect,applyMvuSettlementEffect} from '../tavern-plugin/lib/domain/mvu-settlement-effect.js'

test('effect applies only changed paths and detaches incoming values',()=>{
  const chat={id:'c',sessionId:'s',messages:[{variables:[{hp:1}]},{variables:[{hp:2}]}],variables:{keep:true}}
  const before=structuredClone(chat),after=structuredClone(chat)
  after.messages[1].variables[0].hp=3
  const effect=createMvuSettlementEffect({before,after,operationId:'op',chatId:'c',sessionId:'s',messageId:1,swipeId:0})
  const unchanged=chat.messages[0],oldChanged=chat.messages[1],global=chat.variables
  applyMvuSettlementEffect(chat,effect)
  assert.deepEqual(chat,after)
  assert.equal(chat.messages[0],unchanged)
  assert.equal(chat.variables,global)
  assert.equal(oldChanged.variables[0].hp,2)
  after.messages[1].variables[0].hp=99
  assert.equal(chat.messages[1].variables[0].hp,3)
})

test('invalid later effect path leaves draft unchanged',()=>{
  const chat={id:'c',sessionId:'s',messages:[{variables:[{hp:1}]}]}
  const before=structuredClone(chat)
  const effect={version:1,operationId:'op',chatId:'c',sessionId:'s',expectedLifecycleRevision:0,messageId:0,swipeId:0,
    changes:[{op:'set',path:['messages',0,'variables',0,'hp'],value:2},{op:'set',path:['messages',99,'text'],value:'invalid'}]}
  assert.throws(()=>applyMvuSettlementEffect(chat,effect))
  assert.deepEqual(chat,before)
})
