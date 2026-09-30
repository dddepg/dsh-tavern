import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionViewReader, createSessionSliceReader } from '../tavern-plugin/lib/domain/session-view-reader.js'
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
function fixture() {
  let chat={id:'c',sessionId:'s',mode:'story',cardPath:'card',_storageRevision:1,messages:[{role:'assistant',text:'one'}]}
  const calls={fullRead:0,full:0,dirty:0,cached:0},states=[]
  const deps={readState:async()=>chat && {...structuredClone(chat),messages:[]},readChat:async()=>{calls.fullRead++;return structuredClone(chat)},
    readChanges:async()=>({revision:chat._storageRevision,indices:[0]}),
    project:{full:async value=>{calls.full++;return {chatId:value.id,tavernHelper:{messages:structuredClone(value.messages)}}},
      dirty:async value=>{calls.dirty++;return {chatId:value.id,tavernHelper:{messages:structuredClone(value.messages)}}},
      cached:async(_value,previous)=>{calls.cached++;return previous}},
    activity:()=>({busy:false}),foregroundRunning:()=>false,trace:{stage:(_name,fn)=>fn(),state:state=>states.push(state)},
    synchronize:(_id,view,_cursor,options)=>({view,...options})}
  // Closures let the tests replace adapters at the actual asynchronous seam.
  const reader=createSessionViewReader({...deps,readChat:(...args)=>deps.readChat(...args),readChanges:(...args)=>deps.readChanges(...args),readViewDelta:(...args)=>deps.readViewDelta?.(...args)})
  return {reader,deps,calls,states,get chat(){return chat},set chat(value){chat=value}}
}
for (const changes of [undefined,{revision:99,indices:[0]}]) test(`missing or mismatched change coverage rebuilds the full view: ${JSON.stringify(changes)}`,async()=>{
  const f=fixture();await f.reader.read('s');f.chat={...f.chat,_storageRevision:2}
  f.deps.readChanges=async()=>changes
  await f.reader.read('s');assert.equal(f.calls.full,2);assert.equal(f.calls.dirty,0)
})
for(const row of [{role:'user',text:'role changed'},null])test(`structural history changes retain full fallback: ${JSON.stringify(row)}`,async()=>{
  const f=fixture();await f.reader.read('s');f.chat={...f.chat,_storageRevision:2,messages:row?[row]:[]}
  await f.reader.read('s');assert.equal(f.calls.full,2);assert.equal(f.calls.dirty,0)
})

test('cold skeleton is not cached as a complete projection',async()=>{
  const f=fixture();let skeleton=true
  f.deps.project.full=async()=>({tavernHelper:{messages:[],messagesPending:skeleton}})
  await f.reader.read('s',{windowHelperMessages:true});skeleton=false
  await f.reader.read('s');await f.reader.read('s')
  assert.equal(f.calls.fullRead,2);assert.equal(f.calls.cached,1)
})

for (const kind of ['revision', 'resource', 'missing']) test(`invalid delta ${kind} falls back before rendering`,async()=>{
  const f=fixture();await f.reader.read('s');f.chat={...f.chat,_storageRevision:2}
  f.deps.readViewDelta=async()=>kind==='missing'?undefined:{baseRevision:1,revision:kind==='revision'?3:2,indices:[0],chat:{...f.chat,cardPath:kind==='resource'?'other':'card'}}
  await f.reader.read('s')
  assert.equal(f.calls.fullRead,2)
})

test('concurrent cold consumers share a full read and projection at the same revision',async()=>{
 const f=fixture(),entered=gate(),finish=gate(),original=f.deps.readChat
 f.deps.readChat=async()=>{entered.resolve();await finish.promise;return original()}
 const reads=Array.from({length:12},()=>f.reader.read('s',{windowHelperMessages:true}))
 await entered.promise;await new Promise(resolve=>setImmediate(resolve));finish.resolve()
 const results=await Promise.all(reads)
 assert.equal(f.calls.fullRead,1)
 assert.equal(f.calls.full,1)
 assert.ok(results.every(view=>view.tavernHelper.messages[0].text==='one'))
})

test('Helper hydration cannot promote incomplete ranges, another session or an obsolete revision',async()=>{
 const f=fixture()
 f.deps.project.full=async value=>({chatId:value.id,tavernHelper:{chatId:value.id,stateRevision:value._storageRevision,messages:[{message_id:0,stub:true}],messagesPending:{from:0,to:0}}})
 await f.reader.read('s',{windowHelperMessages:true})
 for(const [session,revision,payload] of [['other',1,{from:0,to:0,messages:[{message_id:0}]}],['s',2,{from:0,to:0,messages:[{message_id:0}]}],['s',1,{from:0,to:0,messages:[]}],['s',1,{from:0,to:0,messages:[{message_id:1}]}]]){
  assert.equal(f.reader.acceptHelperMessages(session,'c',revision,payload),false)
 }
 f.chat={...f.chat,_storageRevision:2}
 await f.reader.read('s',{windowHelperMessages:true})
 assert.equal(f.reader.acceptHelperMessages('s','c',1,{from:0,to:0,messages:[{message_id:0}]}),false)
})

for(const request of [{viewSync:1},{viewSync:1,openingWindow:1,fullView:true}])test('legacy clients and explicit complete reads never receive a window: '+JSON.stringify(request),async()=>{
 const reader=createSessionViewReader({readOpeningWindow:()=>{throw Error('must keep complete contract')},readState:async()=>undefined,
  project:{opening:()=>{throw Error('unexpected')}},trace:{stage:(_name,fn)=>fn()},synchronize:(_id,view)=>({view})})
 assert.equal((await reader.response({sessionId:'s',...request})).view,null)
})

test('narrow variable slices retain routing fields and legacy adoption fallback', async()=>{
 const stored={id:'c',sessionId:'s',backgroundConfigVersion:1,conversationFeaturesVersion:1,mvu:{enabled:true}}
 let received
 const read=createSessionSliceReader({links:async()=>({s:'c',alias:'c'}),readSlice:async(id,indices,fields)=>{
  received={id,indices,fields};return {chat:Object.fromEntries(fields.map(key=>[key,stored[key]])),messageCount:20000,denseMessages:true}
 }})
 const selected=await read('s',[19999],['mvu'])
 assert.equal(selected.chat.backgroundConfigVersion,1)
 assert.equal(selected.messageCount,20000)
 assert.deepEqual(received.indices,[19999])
 assert.ok(!received.fields.includes('messages'))
 assert.equal(await read('alias',[],['mvu']),undefined)
 stored.conversationFeaturesVersion=0
 assert.equal(await read('s',[],['mvu']),undefined)
})

for (const fields of [undefined, ['openingWorldbookSnapshot'], ['cardDefinitionSnapshot']]) test(`resource snapshot changes rebuild deferred capabilities: ${fields}`, async () => {
  const f = fixture(), project = f.deps.project.full
  f.deps.project.full = async chat => ({...await project(chat), cardResourceAccess:{revision:chat._storageRevision}})
  await f.reader.read('s', {deferResources:true})
  f.chat = {...f.chat, _storageRevision:2}
  f.deps.readViewDelta = async () => ({baseRevision:1,revision:2,indices:[],changedHeaderFields:fields,chat:f.chat})
  const view = await f.reader.read('s', {deferResources:true})
  assert.equal(view.cardResourceAccess.revision, 2)
  assert.equal(f.calls.dirty, 0)
})
