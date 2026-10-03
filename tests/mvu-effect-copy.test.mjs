import test from 'node:test'
import assert from 'node:assert/strict'
import { applyMvuSettlementEffect } from '../tavern-plugin/lib/domain/mvu-settlement-effect.js'

test('invalid later effect path leaves draft unchanged',()=>{
  const chat={id:'c',sessionId:'s',messages:[{variables:[{hp:1}]}]}
  const before=structuredClone(chat)
  const effect={version:1,operationId:'op',chatId:'c',sessionId:'s',expectedLifecycleRevision:0,messageId:0,swipeId:0,
    changes:[{op:'set',path:['messages',0,'variables',0,'hp'],value:2},{op:'set',path:['messages',99,'text'],value:'invalid'}]}
  assert.throws(()=>applyMvuSettlementEffect(chat,effect))
  assert.deepEqual(chat,before)
})
