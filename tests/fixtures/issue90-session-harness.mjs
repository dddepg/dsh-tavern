// Execute the production RPC/view functions with the real registry and storage.
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createTavernConversationRegistry } from '../../tavern-plugin/lib/domain/tavern-conversation-registry.js'
import { createBackgroundTaskCoordinator } from '../../tavern-plugin/lib/domain/background-task-coordinator.js'
import { createStoryTimeline } from '../../tavern-plugin/lib/domain/story-timeline.js'
import { rollbackAvailability, hasRollbackMessages } from '../../tavern-plugin/lib/domain/rollback-surface.js'
import { canUndoRollback } from '../../tavern-plugin/lib/domain/surface-restoration.js'

export async function sessionHarness(persistence, initial, overrides = {}) {
  const source = await readFile(new URL('../../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
  const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)))
  let fullReads = 0
  const readChat = async id => { fullReads++; return persistence.read(id) }
  let links = {s: initial.id}
  const registry = createTavernConversationRegistry({store:{
    readLinks:async()=>links, updateLinks:async fn=>{links = await fn(links) || links},
    readIndex:async()=>({chats:[{id:initial.id}]}), writeIndex:async()=>{},
    readChat, readChatState:id=>persistence.readSessionState(id), writeChat:async()=>{}, removeChat:async()=>{}
  }})
  const sync = (_id, view, _cursor, options) => ({view, revision:options.revision})
  sync.peek = () => ({sessionId:'s', revision:initial._storageRevision})
  const timeline = createStoryTimeline()
  const {activity} = createBackgroundTaskCoordinator({timeline,store:{
    readChat,writeChat:persistence.write,updateChat:persistence.update
  }})
  const context = {structuredClone, Set, Object, Number, Array, Map, Boolean,
    args:{sessionId:'s',viewSync:1,viewCursor:'cursor'}, str:value=>String(value ?? ''),
    conversationRegistry:registry, chatPersistence:persistence,
    groupOfMode:mode=>['story','script'].includes(mode)?'play':'card',
    sceneIllustrations:null, updateChat:async()=>{throw Error('unexpected migration')},
    sessionDebugEvidence:()=>({events:[],session:{surface:{nodes:[]}}}),
    rollbackAvailability, hasRollbackMessages, canUndoRollback,
    requestPerformance:{stage:(_name,fn)=>fn(),state(){}},
    backgroundTasks:{activity},agentRegistry:new Map(),
    readScript:async()=>({chunks:[]}),scriptContinuity:{inspect:()=>({progress:1})},
    sessionViewProjectionCache:new Map([[initial.id,{revision:initial._storageRevision,
      cardPath:initial.cardPath || '',cardContextRevision:0,isCard:false,mode:initial.mode || 'story',view:{chatId:initial.id}}]]),
    synchronizeSessionView:sync, ...overrides}
  // mvuReceiptsOf ends immediately before the next function; avoid unrelated closures.
  const receiptStart=source.indexOf('  function mvuReceiptsOf(')
  const receiptEnd=source.indexOf('\n  }',receiptStart)+4
  const code = section('  async function chatForSession(', '  const historyRecall')
    + source.slice(receiptStart,receiptEnd)
    + section('  function settlementTurn(', '  function pendingMvuTarget(')
    + section('  async function sessionActivity(', '  async function ensureNativeOpening(').replace('  const synchronizeSessionView = createSessionViewSync()','').replace('  const sessionViewProjectionCache = new Map()','')
  const dispatch=section("      case 'getSession': {", "      case 'hydrateTavernHelperMessages':")
  const runtime=vm.runInNewContext(`(()=>{${code}\nreturn {get:async()=>{switch('getSession'){${dispatch}}}, activity:()=>sessionActivity('s'), volatile:chat=>volatileSessionViewFields(chat,backgroundTasks.activity(chat))}})()`,context)
  return {...runtime,context,fullReads:()=>fullReads}
}
