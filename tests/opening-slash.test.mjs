import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import {createOpeningPreparation} from '../tavern-plugin/lib/domain/opening-preparation.js'
import {initializationFixture} from './fixtures/conversation-initialization.mjs'

test('opening slash bridge submits the untouched command and exposes it on TavernHelper', async () => {
  let receive, sent
  const parent = {postMessage(data) { sent=data; queueMicrotask(()=>receive({source:parent,data:{type:'dsh-tavern-helper-response',token:'t',requestId:data.requestId,ok:true,result:{submitted:true}}})) }}
  const c=vm.createContext({window:{},parent,console,setTimeout,clearTimeout,addEventListener:(_,fn)=>{receive=fn}})
  vm.runInContext(await readFile(new URL('../tavern-plugin/src/client/opening-preview.js',import.meta.url),'utf8'),c)
  c.installOpeningPreviewBridge('t',{preparationId:'draft',swipes:['wizard'],openingIds:['primary'],selectedIndex:0})
  assert.equal(typeof c.window.triggerSlash,'function')
  assert.equal(c.window.TavernHelper.triggerSlash,c.window.triggerSlash)
  const line='/sys Name: example\nRealm: 3 | /cut 0 | /trigger'
  assert.equal((await c.window.triggerSlash(line)).submitted,true)
  assert.equal(sent.method,'triggerTavernSlash'); assert.equal(sent.args.line,line)
})

test('pre-game sys/cut/trigger removes only the wizard and carries MVU into the new game', async () => {
  const h=initializationFixture()
  h.state.extensions={mvuResources:[{name:'MVU'}]}
  const service=createOpeningPreparation({readCard:async()=>h.card,worldBooks:{bound:async()=>null}})
  const draft=await service.create(h.card.path,{runtime:true})
  const variables={stat_data:{name:'example',realm:3},schema:{}}
  await service.callRuntime(draft.id,'updateTavernHelperVariables',{variables,option:{type:'message',message_id:0,swipe_id:1}})
  const line='/sys Name: example\nRealm: 3 | /cut 0 | /trigger'
  const plan=await service.callRuntime(draft.id,'prepareOpeningCommand',{line,openingId:'alternate:0'})
  assert.equal(plan.input,'继续。')
  assert.equal(service.resolve(draft.id,h.card.path,'primary').startCommand,undefined)
  const prepared=service.resolve(draft.id,h.card.path,'alternate:0')
  const chat=await h.make().start({...h.input,openingId:'alternate:0',preparation:prepared})
  assert.equal(chat.openingText,'')
  assert.equal(chat.messages.some(m=>m.greeting),false)
  assert.equal(chat.messages[0].role,'system')
  assert.equal(chat.messages[0].text,'Name: example\nRealm: 3')
  assert.deepEqual(chat.messages[0].variables[0],variables)
  assert.equal(chat.tavernScriptPrompts[0].role,'system')
  assert.equal(chat.tavernScriptPrompts[0].content,'Name: example\nRealm: 3')
  assert.equal(h.session().events.some(e=>e.data?.message?.source?.model==='character-card'),false)
  const before=service.resolve(draft.id,h.card.path,'primary')
  for(const bad of ['/sys x | /cut 1 | /trigger','/sys x | /unknown | /trigger','/sys x | /cut 0','/send x | /cut 0 | /trigger']) {
    await assert.rejects(service.callRuntime(draft.id,'prepareOpeningCommand',{line:bad}))
    assert.deepEqual(service.resolve(draft.id,h.card.path,'primary'),before)
  }
})

import {chromium} from 'playwright'
import {scriptPromptFrameInputs} from '../tavern-plugin/lib/domain/tavern-script-prompts.js'
import {lastTavernHelperVariables,projectTavernHelperContext} from '../tavern-plugin/lib/domain/tavern-helper-context.js'

test('browser wizard replaces its body, submits through the real frame host, and starts once', async t => {
  const h=initializationFixture()
  const service=createOpeningPreparation({readCard:async()=>h.card,worldBooks:{bound:async()=>null}})
  const draft=await service.create(h.card.path,{runtime:true})
  const baseline={stat_data:{name:'example'},schema:{}}
  await service.callRuntime(draft.id,'updateTavernHelperVariables',{variables:baseline,option:{type:'message',message_id:0}})
  const browser=await chromium.launch();t.after(()=>browser.close())
  const page=await browser.newPage(), errors=[],starts=[]
  let fail=true
  page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/*',route=>route.abort())
  await page.exposeFunction('draftRpc',async(method,args)=>{
    assert.equal(method,'callOpeningRuntime')
    if(fail){fail=false;throw Error('temporary opening failure')}
    return service.callRuntime(args.id,args.method,args.args)
  })
  await page.exposeFunction('startGame',async input=>{
    const chat=await h.make().start({...h.input,preparation:service.resolve(draft.id,h.card.path,'primary')})
    starts.push({input,chat,frameInputs:scriptPromptFrameInputs(chat)})
    return {submitted:true}
  })
  await page.setContent('<main></main>')
  const source=await readFile(new URL('../tavern-plugin/lib/client.js',import.meta.url),'utf8')
  await page.evaluate(({source,id})=>{
    window.__ModuleLoader__={load(d){window.client=d.factory(()=>({}))}};window.eval(source)
    const content=`<button id="start">开启仙途</button><script>
      document.querySelector('#start').onclick=async()=>{
        document.body.innerHTML='<h1>仙途已启</h1>';
        const line='/sys Name: example | /cut '+getCurrentMessageId()+' | /trigger';
        try { await Promise.all([triggerSlash(line),triggerSlash(line)]); } catch (_) {}
      };<\/script>`
    window.life=client.createTavernMessageFrameLifecycle({content,openingPreview:{preparationId:id,swipes:['wizard'],openingIds:['primary'],selectedIndex:0},onSubmitOpening:async text=>{const result=await startGame(text);window.started=true;return result}},{rpc:draftRpc})
    const descriptor=life.snapshot().visibleDocument,frame=document.createElement('iframe')
    window.stop=life.start(state=>{frame.style.height=state.height+'px'})
    frame.srcdoc=descriptor.html;document.querySelector('main').append(frame);descriptor.ref(frame)
  },{source,id:draft.id})
  const frame=page.frames()[1]
  await frame.getByRole('button',{name:'开启仙途'}).click()
  await frame.getByRole('button',{name:'重试开局'}).click()
  await page.waitForFunction(()=>window.started===true)
  assert.deepEqual(errors,[])
  assert.equal(starts.length,1)
  assert.equal(starts[0].input,'继续。')
  assert.equal(starts[0].frameInputs[0].text,'Name: example')
  assert.equal(starts[0].frameInputs[0].source.role,'system')
  assert.deepEqual(lastTavernHelperVariables(starts[0].chat.messages),baseline)
  assert.equal(projectTavernHelperContext(starts[0].chat).messages[0].role,'system')
})
