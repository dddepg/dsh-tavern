import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
const source=await readFile(new URL('../tavern-plugin/src/client/main.js',import.meta.url),'utf8')
const component=source.slice(source.indexOf('function TavernStatusPanel(props)'),source.indexOf('function TavernCardAppDock(props)'))
function render(state){
 const scope=vm.createContext({React:{useState:value=>[value,()=>{}],useRef:()=>({current:null}),useEffect(){},createElement:(type,props,...children)=>({type,props,children})},useTavernConfirm:()=>()=>{},usePersistentError:()=>['',()=>{}],latestTavernAssistantMessageId:()=>'',useLiveTavernView:()=>state,isMissingTavernCardError:()=>false})
 for(const [,name]of component.matchAll(/h\((Tavern\w+)/g))scope[name]=name
 vm.runInContext(component,scope)
 return scope.TavernStatusPanel({sessionId:'test',useSession:()=>false,useChat:()=>''})
}
test('initial status loading and reconnect render without dereferencing a missing view',()=>{
 for(const phase of ['loading','retrying','idle']){
 const tree=render({view:null,phase,error:null})
 assert.equal(tree.type,'aside');assert.doesNotMatch(JSON.stringify(tree),/TavernBackgroundWait/)
 }
})
test('loaded status mounts background wait notice with the actual activity',()=>{
 const activity={busy:true,operationId:'op'}
 const tree=render({view:{mode:'story',card:{name:'test'},activity,guides:[],characters:[]},phase:'ready'})
 const find=node=>node?.type==='TavernBackgroundWait'?node:(node?.children||[]).flat(Infinity).map(find).find(Boolean)
 assert.deepEqual(find(tree)?.props.activity,activity)
})
