import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { openingPreviewPayload, openingInitializationPayload } from '../tavern-plugin/lib/domain/opening-transport.js'
const source = await readFile(new URL('../tavern-plugin/src/client/full-template-executor.js', import.meta.url),'utf8')
test('deferred opening transport sends large shared state once and restores every preview', async () => {
 const worldbook={name:'book',entries:[{content:'large-worldbook-'.repeat(10000)}]}
 const runtime={context:{worldbook,character:{name:'card',character_book:{entries:[{content:'original'}]}}},scripts:[{content:'script'}]}
 const prepared={runtime,worldbook,openings:[{text:'one'},{text:'two'}]}
 const response={preparationId:'draft',previewTransport:'deferred-v1',openings:[0,1].map(i=>({openingPreview:{selectedIndex:i,...openingPreviewPayload(prepared,'deferred-v1')}}))}
 assert.ok(JSON.stringify(response).length<1000)
 const result=openingInitializationPayload(prepared,true)
 assert.deepEqual(Object.keys(result),['runtime'])
 const calls=[];const scope=vm.createContext({rpc:async (...args)=>{calls.push(args);return JSON.parse(JSON.stringify(result))}})
 vm.runInContext(source,scope)
 await scope.initializeFullOpeningTemplate(response)
 assert.equal(calls[0][1].compact,true)
 for(const opening of response.openings){assert.deepEqual(opening.openingPreview.worldbook,worldbook);assert.deepEqual(opening.openingPreview.runtime,runtime)}
 assert.equal(response.openings[0].openingPreview.runtime,response.openings[1].openingPreview.runtime)
 assert.equal(response.openings[1].openingPreview.selectedIndex,1)
 assert.equal(JSON.stringify(result).split('large-worldbook-').length-1,10000)
})
test('legacy clients keep the old payload and previews without helper runtime keep worldbook access',()=>{
 const prepared={runtime:null,worldbook:{name:'book',entries:[]},id:'draft'}
 assert.deepEqual(openingPreviewPayload(prepared),{runtime:null,worldbook:prepared.worldbook})
 assert.equal(openingInitializationPayload(prepared,false),prepared)
 assert.deepEqual(openingInitializationPayload(prepared,true),{runtime:null,worldbook:prepared.worldbook})
})
test('production opening RPC defers payload only when the caller opts in',async()=>{
 const server=await readFile(new URL('../tavern-plugin/lib/index.js',import.meta.url),'utf8')
 const start=server.indexOf('  async function getCardOpenings(')
 const implementation=server.slice(start,server.indexOf('  function presentUserPreferenceProfile',start))
 const {createOpeningPreparation}=await import('../tavern-plugin/lib/domain/opening-preparation.js')
 const {projectCardOpeningPreviews}=await import('../tavern-plugin/lib/domain/card-opening-previews.js')
 const {projectTavernHelperScripts}=await import('../tavern-plugin/lib/domain/tavern-helper-scripts.js')
 const {cardOpeningChoices}=await import('../tavern-plugin/lib/domain/card-openings.js')
 const {inspectWorldBookDocument}=await import('../tavern-plugin/lib/domain/worldbook-resource.js')
 const card={name:'Test',first_mes:'<script>1</script>',alternate_greetings:['<script>2</script>']}
 const extensions={helperScripts:[],regexScripts:[],mvuResources:[]}
 const record={source:{kind:'embedded'},view:inspectWorldBookDocument({entries:[{content:'large'.repeat(10000)}]})}
 const openingPreparation=createOpeningPreparation({readCard:async()=>card,worldBooks:{bound:async()=>record}})
 const scope=vm.createContext({performance,console:{info(){}},readCard:async()=>card,readTavernSettings:async()=>({}),readCardExtensions:async()=>extensions,
 tavernRemoteAssets:{pinExtensions:async()=>extensions},performanceDiagnostics:{opening(){}},projectCardOpeningPreviews,projectTavernHelperScripts,cardOpeningChoices,openingPreparation,openingPreviewPayload,marked:{parse:x=>x},str:String})
 vm.runInContext(implementation,scope)
 const legacy=await scope.getCardOpenings('card','you','dsh')
 const deferred=await scope.getCardOpenings('card','you','dsh','deferred-v1')
 assert.ok(legacy.openings[0].openingPreview.worldbook)
 assert.equal(deferred.previewTransport,'deferred-v1')
 assert.ok(JSON.stringify(deferred).length<JSON.stringify(legacy).length/10)
 const draft=openingPreparation.get(deferred.preparationId)
 assert.equal(draft.worldbook.entries[0].content,'large'.repeat(10000))
})
