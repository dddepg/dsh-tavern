import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatJournalStore } from '../tavern-plugin/lib/domain/chat-journal-store.js'
import { createSessionViewReader } from '../tavern-plugin/lib/domain/session-view-reader.js'
import { projectTavernHelperContext } from '../tavern-plugin/lib/domain/tavern-helper-context.js'
import { applyJsonChangesShared } from '../tavern-plugin/lib/domain/json-mutation.js'

test('changing long history reuses unchanged Helper variables without full reads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'view-delta-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createChatJournalStore({ dataRoot: root })
  await store.update('c', () => ({ id:'c', _storageRevision:1, messages:Array.from({length:100}, (_,i) => ({role:'assistant',turn:i+1,text:String(i),variables:[{value:i}]})) }))
  let reads=0
  const reader=createSessionViewReader({readState:()=>store.readSessionState('c'),readChat:()=>{reads++;return store.read('c')},
    readChanges:store.readChangedIndices,readViewDelta:store.readViewDelta,
    project:{full:chat=>({tavernHelper:projectTavernHelperContext(chat)}),
      dirty:(chat,previous,dirtyIndices)=>({tavernHelper:projectTavernHelperContext(chat,{previousMessages:previous.tavernHelper.messages,dirtyIndices})}),
      cached:(_chat,previous)=>previous},activity:()=>({}),foregroundRunning:()=>false,
    trace:{stage:(_name,fn)=>fn(),state(){}},synchronize:()=>{}})
  await reader.read('s')
  for(let revision=2;revision<=6;revision++) {
    await store.patch('c',revision-1,[{op:'set',path:['_storageRevision'],value:revision},{op:'set',path:['messages',99,'variables'],value:[{value:revision}]}])
    const delta=await store.readViewDelta('c',revision-1)
    assert.equal(delta.chat.messages[0].variables,undefined)
    const view=await reader.read('s')
    assert.deepEqual(view.tavernHelper,projectTavernHelperContext(await store.read('c')))
    delta.chat.messages[99].variables[0].value='outside mutation'
    assert.equal((await store.read('c')).messages[99].variables[0].value,revision)
  }
  assert.equal(reads,1)
  // Truncation must use a complete snapshot rather than partial Helper input.
  await store.patch('c',6,[{op:'set',path:['_storageRevision'],value:7},{op:'splice',path:['messages'],index:99,deleteCount:1,items:[]}])
  const shortened=await reader.read('s')
  assert.equal(reads,2)
  assert.deepEqual(shortened.tavernHelper,projectTavernHelperContext(await store.read('c')))
})

test('shared splice keeps old immutable rows and detaches inserted rows',()=>{
  const before={messages:[{variables:[{value:1}]}]}, inserted={variables:[{value:2}]}
  const after=applyJsonChangesShared(before,[{op:'splice',path:['messages'],index:1,deleteCount:0,items:[inserted]}])
  assert.notEqual(after.messages,before.messages)
  assert.equal(after.messages[0],before.messages[0])
  inserted.variables[0].value=3
  assert.equal(after.messages[1].variables[0].value,2)
  assert.equal(before.messages.length,1)
})
