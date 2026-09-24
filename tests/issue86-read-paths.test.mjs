import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatJournalStore } from '../tavern-plugin/lib/domain/chat-journal-store.js'
import { createChatPersistence } from '../tavern-plugin/lib/domain/chat-persistence.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'

test('production getSession cache hit resolves the chat once and returns that revision', async () => {
  const source=await readFile(new URL('../tavern-plugin/lib/index.js',import.meta.url),'utf8')
  const viewSource=source.slice(source.indexOf('  async function sessionView('),source.indexOf('  async function ensureNativeOpening('))
  const dispatchSource=source.slice(source.indexOf("      case 'getSession': {"),source.indexOf("      case 'hydrateTavernHelperMessages':"))
  const chat={id:'c',sessionId:'s',mode:'story',cardPath:'card',_storageRevision:5,messages:[]}
  let reads=0
  const sync=(_id,view,_cursor,options)=>({view,revision:options.revision})
  sync.peek=()=>({sessionId:'s',revision:5})
  const context={Set,Object,Number,Array,Map,Boolean,
    args:{sessionId:'s',viewSync:1,viewCursor:'cursor'},
    chatForSessionView:async()=>{reads++;return chat},str:String,
    requestPerformance:{stage:(_name,fn)=>fn(),state(){}},
    backgroundTasks:{activity:()=>({busy:false})},agentRegistry:new Map(),
    sessionStateViewCache:new WeakMap(),
    sessionViewProjectionCache:new Map([['c',{revision:5,cardPath:'card',cardContextRevision:0,isCard:false,mode:'story',view:{chatId:'c'}}]]),
    volatileSessionViewFields:()=>({}),synchronizeSessionView:sync}
  const result=await vm.runInNewContext(`(async()=>{${viewSource}\nswitch('getSession'){${dispatchSource}}})()`,context)
  assert.equal(reads,1)
  assert.equal(result.revision,5)
  assert.equal(result.view.chatId,'c')
})

test('timeline inspection never traverses story data and returns isolated participants', () => {
  const timeline = createStoryTimeline({id:()=> 'branch',now:()=>1})
  const chat = {timeline:{schemaVersion:1,branchId:'b',revision:7,checkpoints:[],
    participants:{background:{sessionId:'s',lifetime:'chat'}},operations:{}}}
  Object.defineProperty(chat,'messages',{enumerable:true,get(){throw Error('history traversed')}})
  const result = timeline.inspect({chat})
  assert.equal(result.revision,7)
  result.participants.background.sessionId='changed'
  assert.equal(chat.timeline.participants.background.sessionId,'s')
})

test('projection cache and browser cursor use their own change baselines', async () => {
  const source=await readFile(new URL('../tavern-plugin/lib/index.js',import.meta.url),'utf8')
  const viewSource=source.slice(source.indexOf('  async function sessionView('),source.indexOf('  async function ensureNativeOpening('))
  const dispatchSource=source.slice(source.indexOf("      case 'getSession': {"),source.indexOf("      case 'hydrateTavernHelperMessages':"))
  const chat={id:'c',mode:'card',cardPath:'',_storageRevision:5,messages:[{role:'user',text:'new0'},{role:'assistant',text:'new1'}]}
  const queries=[]
  const sync=(_id,view,_cursor,options)=>{
    assert.deepEqual([...options.dirtyMessageIndices],[1])
    return view
  }
  sync.peek=()=>({sessionId:'s',revision:4})
  const context={Set,Object,Number,Array,Map,Boolean,args:{sessionId:'s',viewSync:1,viewCursor:'cursor'},
    chatForSessionView:async()=>chat,str:String,
    requestPerformance:{stage:(_name,fn)=>fn(),state(){}},
    chatPersistence:{readChangedIndices:async(_id,revision)=>{
      queries.push(revision)
      return {revision:5,indices:revision===3?[0,1]:[1]}
    }},
    backgroundTasks:{activity:()=>({busy:false})},agentRegistry:new Map(),
    sessionStateViewCache:new WeakMap(),
    sessionViewProjectionCache:new Map([['c',{revision:3,cardPath:'',cardContextRevision:0,isCard:true,mode:'card',
      view:{tavernHelper:{messages:[{role:'user',text:'old0'},{role:'assistant',text:'old1'}]}}}]]),
    volatileSessionViewFields:()=>({}),mvuReceiptsOf:()=>[],synchronizeSessionView:sync,
    projectTavernHelperContext:(value,{previousMessages,dirtyIndices})=>({messages:previousMessages.map((row,i)=>dirtyIndices.has(i)?value.messages[i]:row)})}
  const result=await vm.runInNewContext(`(async()=>{${viewSource}\nswitch('getSession'){${dispatchSource}}})()`,context)
  assert.deepEqual(queries,[4,3])
  assert.equal(result.tavernHelper.messages[0].text,'new0')
  assert.equal(result.tavernHelper.messages[1].text,'new1')
})

test('timeline inspection retains legacy foreground migration without changing the source', () => {
  const timeline=createStoryTimeline({id:()=> 'checkpoint',now:()=>10})
  const chat={messages:[{role:'assistant',text:'body'}],timeline:{schemaVersion:1,branchId:'b',revision:2,
    checkpoints:[],participants:{},operations:{body:{id:'body',kind:'body',status:'foreground-completed',
      basedOn:{branchId:'b',revision:2},turn:1,userText:'go',beforeRevision:1,beforeParticipants:{}}}}}
  const result=timeline.inspect({chat})
  assert.equal(result.revision,3)
  assert.equal(result.checkpointCount,1)
  assert.equal(result.operations.body.status,'completed')
  assert.equal(chat.timeline.operations.body.status,'foreground-completed')
  assert.equal(chat.timeline.checkpoints.length,0)
})

test('change indices carry exact revision, detach results and survive more than 32 commits', async t => {
  const root = await mkdtemp(join(tmpdir(),'issue86-changes-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const store = createChatJournalStore({dataRoot:root})
  const persistence = createChatPersistence({store})
  await store.update('c',()=>({id:'c',_storageRevision:1,messages:[{text:'a'},{text:'b'}]}))
  for(let revision=1;revision<=40;revision++) await store.patch('c',revision,[
    {op:'set',path:['_storageRevision'],value:revision+1},
    {op:'set',path:['messages',revision%2,'text'],value:String(revision)}
  ])
  const changed = await persistence.readChangedIndices('c',1)
  assert.deepEqual(changed,{indices:[0,1],baseRevision:1,revision:41})
  changed.indices.length=0
  assert.deepEqual((await persistence.readChangedIndices('c',1)).indices,[0,1])
  assert.deepEqual((await store.readChangedSlice('c',1)).indices,[0,1])
  assert.equal(await store.readChangedIndices('c',0),undefined)
  assert.equal(await createChatJournalStore({dataRoot:root}).readChangedIndices('c',1),undefined)
  await store.patch('c',41,[{op:'set',path:['_storageRevision'],value:42},
    {op:'splice',path:['messages'],index:0,deleteCount:1,items:[]}])
  assert.deepEqual((await store.readChangedIndices('c',1)).indices,[0])
  assert.equal((await store.readChangedSlice('c',1)).chat.messages[0].text,'39')
})

test('older change summaries conservatively cover interior cursors and evict oversized coverage', async t => {
  const root = await mkdtemp(join(tmpdir(),'issue86-summary-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const store=createChatJournalStore({dataRoot:root})
  await store.update('c',()=>({id:'c',_storageRevision:1,messages:Array.from({length:4200},()=>({text:'a'}))}))
  await store.patch('c',1,[{op:'set',path:['_storageRevision'],value:2},
    ...Array.from({length:4100},(_,i)=>({op:'set',path:['messages',i,'text'],value:'b'}))])
  for(let revision=2;revision<=40;revision++) await store.patch('c',revision,[
    {op:'set',path:['_storageRevision'],value:revision+1},
    {op:'set',path:['messages',4199,'text'],value:String(revision)}])
  assert.equal(await store.readChangedIndices('c',1),undefined)
  assert.deepEqual((await store.readChangedIndices('c',2)).indices,[4199])
  assert.deepEqual((await store.readChangedIndices('c',5)).indices,[4199])
  assert.deepEqual(await store.readChangedIndices('c',41),{indices:[],baseRevision:41,revision:41})
})
