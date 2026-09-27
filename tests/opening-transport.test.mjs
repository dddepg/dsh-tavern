import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { openingPreviewPayload } from '../tavern-plugin/lib/domain/opening-transport.js'

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
 const scope=vm.createContext({requestPerformance:{stage:(_name,work)=>work()},performance,console:{info(){}},readCard:async()=>card,readTavernSettings:async()=>({}),readCardExtensions:async()=>extensions,
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
