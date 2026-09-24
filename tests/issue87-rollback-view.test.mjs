import { projectChatSessionState } from '../tavern-plugin/lib/domain/chat-session-state.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { rollbackAvailability, hasRollbackMessages } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { canUndoRollback } from '../tavern-plugin/lib/domain/surface-restoration.js'

test('cached rollback controls follow the stored Session surface without resuming an Agent', async () => {
  const source=await readFile(new URL('../tavern-plugin/lib/index.js',import.meta.url),'utf8')
  const evidence=source.slice(source.indexOf('  function sessionDebugEvidence('),source.indexOf('  const readBackgroundSuppression'))
  const fields=source.slice(source.indexOf('  function rollbackViewFields('),source.indexOf('  async function sessionView('))
  const view=source.slice(source.indexOf('  async function sessionView('),source.indexOf('  async function ensureNativeOpening('))
  const session={id:'s',events:[
    {seq:0,type:'user/message',data:{role:'user',source:{kind:'user'}}},
    {seq:1,type:'assistant/message',data:{turn:2,message:{source:{kind:'model',provider:'test',model:'test'}}}}
  ],surface:{nodes:[0,1]}}
  const chat={id:'c',sessionId:'s',mode:'story',cardPath:'card',_storageRevision:1,messages:[{role:'user'},{role:'assistant',turn:2}]}
  let loaded=true
  const context={Array,Object,Number,Set,Map,Boolean,str:String,sessionEvents,rollbackAvailability,hasRollbackMessages,canUndoRollback,
    ctx:{get:()=>({get:()=>loaded?session:undefined})},
    agentRegistry:{get:()=>undefined,resume:()=>{throw Error('view must not resume')}},
    requestPerformance:{stage:(_name,fn)=>fn(),state(){}},chatForSession:async()=>chat,sessionStateForSession:async()=>projectChatSessionState(chat),
    sessionStateViewCache:new WeakMap(),
    backgroundTasks:{activity:()=>({busy:false})},settlementTurn:()=>2,mvuReceiptsOf:()=>[],
    sessionViewProjectionCache:new Map([['c',{revision:1,cardPath:'card',cardContextRevision:0,isCard:false,mode:'story',view:{canRollback:false}}]])}
  const run=vm.runInNewContext(`(()=>{${evidence}\n${fields}\n${view}\nreturn sessionView})()`,context)
  assert.equal((await run('s')).canRollback,true)
  session.surface.nodes=[]
  assert.equal((await run('s')).canRollback,false)
  session.surface.nodes=[0,1]
  assert.equal((await run('s')).canRollback,true)
  loaded=false
  const missing=await run('s')
  assert.equal(missing.canRollback,false)
  assert.match(missing.rollbackUnavailableReason,/尚未加载/)
  assert.doesNotMatch(missing.rollbackUnavailableReason,/已不在可回退/)
})
