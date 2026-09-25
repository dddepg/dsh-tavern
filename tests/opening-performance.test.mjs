import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import {createPerformanceDiagnostics} from '../tavern-plugin/lib/domain/performance-diagnostics.js'
import {createRequestPerformance} from '../tavern-plugin/lib/domain/request-performance.js'
const source=await readFile(new URL('../tavern-plugin/src/client/opening-performance.js',import.meta.url),'utf8')
test('opening timings retain running and failed stages without private error text, bounded and detached',async()=>{
 let time=0
 const scope=vm.createContext({performance:{now:()=>time},Date,Math})
 vm.runInContext(source+';globalThis.recorder=openingPerformance',scope)
 const recorder=scope.recorder,action=recorder.begin('startGame')
 let release;const pending=action.measure('connectWorkspace',()=>new Promise(resolve=>release=resolve))
 time=1200
 const running=recorder.read();assert.equal(running[1].status,'running');assert.equal(running[1].durationMs,1200)
 assert.equal(running[0].id,running[1].id)
 release();await pending
 await assert.rejects(action.measure('createChat',()=>{throw Error('PRIVATE')}))
 action.finish(false)
 assert.equal(recorder.read().at(-1).status,'failed')
 const store=createPerformanceDiagnostics();store.browser({openings:recorder.read().map(row=>({...row,path:'PRIVATE',error:'SECRET'}))})
 assert.equal(store.read().browser.openings.length,3)
 assert.doesNotMatch(JSON.stringify(store.read()),/PRIVATE|SECRET/)
 running[0].stage='changed';assert.equal(recorder.read()[0].stage,'startGame')
 for(let n=0;n<200;n++)recorder.begin('preparePreview').finish(true)
 assert.equal(recorder.read().length,120)
})
test('opening RPC traces preserve concurrent stage attribution and template failures',async()=>{
 const trace=createRequestPerformance(),id='00000000-0000-0000-0000-000000000001'
 await Promise.all(['getCardOpenings','startChat','preparePlayStart'].map(method=>trace.run(method,id,()=>trace.stage(method==='startChat'?'initializeConversation':'prepare',async()=>{}))))
 await assert.rejects(trace.run('initializeOpeningTemplate',id,()=>trace.stage('templateInitialize',()=>{throw Error('PRIVATE')})))
 const rows=trace.read().recent
 assert.equal(rows.length,4);assert.equal(rows.at(-1).failed,true);assert.equal(rows.at(-1).stages[0].name,'templateInitialize')
 assert.ok(rows.every(row=>row.id===id));assert.doesNotMatch(JSON.stringify(rows),/PRIVATE/)
})
test('browser opening request metadata survives server export filtering',()=>{
 const store=createPerformanceDiagnostics()
 store.browser({requests:['getCardOpenings','initializeOpeningTemplate','startChat','preparePlayStart'].map(method=>({id:'00000000-0000-0000-0000-000000000001',method,headersMs:10,parsedMs:20,bodyChars:15000000,payload:'PRIVATE'}))})
 assert.equal(store.read().browser.requests.length,4)
 assert.equal(store.read().browser.requests[0].bodyChars,15000000)
 assert.doesNotMatch(JSON.stringify(store.read()),/PRIVATE/)
})
test('opening server records survive ordinary session polling',async()=>{
 const trace=createRequestPerformance()
 await trace.run('getCardOpenings','',async()=>{})
 for(let i=0;i<150;i++)await trace.run('syncSession','',async()=>{})
 assert.equal(trace.read().openings[0].method,'getCardOpenings')
 assert.equal(trace.read().recent.some(row=>row.method==='getCardOpenings'),false)
})
