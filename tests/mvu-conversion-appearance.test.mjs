import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { freezeMvuAppearance, renderFrozenAppearance } from '../tavern-plugin/lib/domain/mvu-conversion-appearance.js'
const appearance = {sourcePath:'/extensions/regex_scripts/0/replaceString',bindings:[{capture:1,path:'/位置'}]}
const freeze = html => freezeMvuAppearance({extensions:{regex_scripts:[{replaceString:html}]}},appearance)

test('伪造内容指纹仍不能让验收执行原卡脚本',()=>{
  const frozen=freeze('<div>$1</div>')
  frozen.html+='<script>throw Error("UNTRUSTED")</script>'
  frozen.htmlDigest=createHash('sha256').update(frozen.html).digest('hex')
  assert.throws(()=>renderFrozenAppearance(frozen,p=>p.slice(1).split('/'),{位置:'门口'}),/自定义脚本/)
})

test('列表绑定逐项展示纯文本，支持清空、更新及恢复，拒绝不完整列表占位',async()=>{
  const {JSDOM}=await import('jsdom')
  const plan={html:'<ul><li>$1</li></ul>',bindings:[{capture:1,path:'/日志',display:'list'}]}
  for(const html of ['<p>$1</p>','<ul><li>$1</li><li>保留项</li></ul>'])assert.throws(()=>freezeMvuAppearance({}, {...plan,html}),/列表绑定/)
  const frozen=freezeMvuAppearance({},plan)
  let state={日志:['第一项','<img src=x onerror=alert(1)>']};const handlers=new Map()
  const dom=new JSDOM(renderFrozenAppearance(frozen,p=>p.slice(1).split('/'),state),{runScripts:'outside-only'}),w=dom.window
  try {
    Object.assign(w,{Mvu:{getMvuData:()=>({stat_data:state}),events:{VARIABLE_UPDATE_ENDED:'updated'}},waitGlobalInitialized:async()=>{},eventOn:(name,fn)=>handlers.set(name,fn),tavern_events:{CHAT_CHANGED:'restored'}})
    for(const script of w.document.querySelectorAll('script'))w.eval(script.textContent)
    await new Promise(r=>setImmediate(r))
    const items=()=>[...w.document.querySelectorAll('li')].map(node=>node.textContent)
    assert.deepEqual(items(),state.日志);assert.equal(w.document.querySelector('img'),null)
    state={日志:[]};handlers.get('updated')();assert.deepEqual(items(),[])
    state={日志:['新记录']};handlers.get('updated')();assert.deepEqual(items(),['新记录'])
    state={日志:['旧记录','更早记录']};handlers.get('restored')();assert.deepEqual(items(),state.日志)
  }finally{w.close()}
})
