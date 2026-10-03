import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import {JSDOM} from 'jsdom'

async function harness() {
  const dom = new JSDOM('<style>.example-bubble{display:flex}.example-bubble img{width:52px}</style><main></main>')
  let descriptor, effect
  const root = dom.window.document.querySelector('main')
  const React = {createElement:(type,props,...children)=>({type,props,children}),useRef:()=>({current:root}),useLayoutEffect:run=>{effect=run}}
  vm.runInNewContext(await readFile(new URL('../tavern-plugin/lib/client.js',import.meta.url),'utf8'),{window:{document:dom.window.document,__ModuleLoader__:{load:value=>descriptor=value}},console})
  return {dom,root,client:descriptor.factory(name=>name==='react'?React:{}),mount:()=>effect()}
}

test('trusted reply fragments share host styles and hydration without a frame',async()=>{
  const h=await harness()
  try {
    const content='<div class="example-bubble" data-speaker="Example"><img alt="avatar"><span>Hello</span></div>'
    const observer=new h.dom.window.MutationObserver(()=>{
      const bubble=h.dom.window.document.querySelector('.example-bubble')
      if(bubble) bubble.dataset.hydrated='true'
    })
    observer.observe(h.dom.window.document.body,{childList:true,subtree:true})
    const [part]=h.client.renderTavernProjection({parts:[{kind:'html',content}]},{trustedCardMode:true})
    assert.equal(part.type,h.client.TavernInlineFragment)
    part.type(part.props);const cleanup=h.mount()
    await new Promise(resolve=>setImmediate(resolve))
    const bubble=h.root.querySelector('.example-bubble')
    assert.equal(h.dom.window.getComputedStyle(bubble).display,'flex')
    assert.equal(bubble.dataset.hydrated,'true')
    assert.equal(bubble.textContent,'Hello')
    cleanup();assert.equal(h.root.children.length,0);observer.disconnect()
  }finally{h.dom.window.close()}
})

test('untrusted fragments, previews, active HTML and full documents retain iframe rendering',async()=>{
  const h=await harness()
  try{
    for(const [content,options] of [
      ['<div>hello</div>',{trustedCardMode:false}],
      ['<div>hello</div>',{trustedCardMode:true,openingPreview:{}}],
      ...['<script>void 0</script>','<style>body{color:red}</style>','<img src=x onerror="alert(1)">','<a href="java&#10;script:alert(1)">x</a>','<svg onload="alert(1)"></svg>','<iframe srcdoc="hello"></iframe>','<!doctype html><html><body>hello</body></html>'].map(content=>[content,{trustedCardMode:true}])
    ]){
      const [part]=h.client.renderTavernProjection({parts:[{kind:'html',content}]},options)
      assert.equal(part.type,h.client.TavernMessageFrame,content)
    }
  }finally{h.dom.window.close()}
})

test('trusted fragments zoom with the DSH font preference without touching card DOM',async()=>{
  const {chromium}=await import('playwright')
  const browser=await chromium.launch()
  try{
    const page=await browser.newPage()
    await page.setContent('<style>body{--dsh-content-font-size:14px}.card span{font-size:20px}</style><main></main>')
    await page.addScriptTag({content:`let effect;const root=document.querySelector('main');
      const React={createElement:(type,props,...children)=>({type,props,children}),useRef:()=>({current:root}),useLayoutEffect:run=>{effect=run}};
      window.__ModuleLoader__={load:value=>{window.client=value.factory(name=>name==='react'?React:{})}};
      window.mountFragment=content=>{const [part]=client.renderTavernProjection({parts:[{kind:'html',content}]},{trustedCardMode:true});part.type(part.props);return effect()};`})
    await page.addScriptTag({content:await readFile(new URL('../tavern-plugin/lib/client.js',import.meta.url),'utf8')})
    const state=()=>page.evaluate(()=>{const span=document.querySelector('.card span');return {zoom:document.querySelector('main').style.zoom,height:Math.round(span.getBoundingClientRect().height),cardStyle:span.getAttribute('style')}})
    await page.evaluate(()=>{window.writes=0;window.cleanup=mountFragment('<div class="card"><span>正文</span></div>');new MutationObserver(r=>{window.writes+=r.length}).observe(document.querySelector('.card'),{subtree:true,attributes:true,childList:true,characterData:true})})
    const base=await state()
    assert.equal(base.zoom,'')
    await page.evaluate(()=>document.body.style.setProperty('--dsh-content-font-size','21px'))
    await page.waitForFunction(()=>document.querySelector('main').style.zoom==='1.5')
    const zoomed=await state()
    assert.ok(zoomed.height>base.height*1.4,'正文按比例放大')
    assert.equal(zoomed.cardStyle,null)
    assert.equal(await page.evaluate(()=>window.writes),0,'不改写卡片 DOM')
    await page.evaluate(()=>document.body.style.setProperty('--dsh-content-font-size','14px'))
    await page.waitForFunction(()=>document.querySelector('main').style.zoom==='')
    await page.evaluate(()=>document.body.style.setProperty('--dsh-content-font-size','21px'))
    await page.waitForFunction(()=>document.querySelector('main').style.zoom==='1.5')
    await page.evaluate(()=>cleanup())
    assert.equal(await page.evaluate(()=>document.querySelector('main').style.zoom),'')
  }finally{await browser.close()}
})
