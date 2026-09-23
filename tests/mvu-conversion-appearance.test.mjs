import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { freezeMvuAppearance, renderFrozenAppearance } from '../tavern-plugin/lib/domain/mvu-conversion-appearance.js'
const appearance = {sourcePath:'/extensions/regex_scripts/0/replaceString',bindings:[{capture:1,path:'/位置'}]}
const freeze = html => freezeMvuAppearance({extensions:{regex_scripts:[{replaceString:html}]}},appearance)
test('复杂脚本、动态属性及漏映射明确拒绝，不删除原样式',()=>{
  for (const html of ['<div>$1<script>throw Error()</script></div>','<div onclick="go()">$1</div>','<div class="$1">位置</div>','<div>$1 $2</div>','<div>{{user}} $1</div>']) assert.throws(()=>freeze(html))
})
test('伪造内容指纹仍不能让验收执行原卡脚本',()=>{
  const frozen=freeze('<div>$1</div>')
  frozen.html+='<script>throw Error("UNTRUSTED")</script>'
  frozen.htmlDigest=createHash('sha256').update(frozen.html).digest('hex')
  assert.throws(()=>renderFrozenAppearance(frozen,p=>p.slice(1).split('/'),{位置:'门口'}),/自定义脚本/)
})
test('内容篡改、变量路径缺失均在渲染前拒绝',()=>{
  const frozen=freeze('<div>$1</div>')
  assert.throws(()=>renderFrozenAppearance({...frozen,html:'<div>改写</div>'},p=>p.slice(1).split('/'),{位置:'门口'}),/指纹/)
  assert.throws(()=>renderFrozenAppearance(frozen,p=>p.slice(1).split('/'),{}),/路径不存在/)
})

test('多人原样式显示所有字段，新增成员、更新和恢复保留已有折叠状态',async()=>{
  const {JSDOM}=await import('jsdom')
  const plan={sourcePath:appearance.sourcePath,collectionPath:'/人物',bindings:[{capture:1,path:'/姓名'},{capture:2,path:'/位置'}]}
  const frozen=freezeMvuAppearance({extensions:{regex_scripts:[{replaceString:'<article><h3>$1</h3><details><summary>位置</summary><span>$2</span></details></article>'}]}},plan)
  let state={人物:{$meta:{extensible:true},艾乔:{姓名:'艾乔',位置:'甲'},雨辰:{姓名:'雨辰',位置:'乙'}}}
  const initial=structuredClone(state),handlers=new Map()
  const dom=new JSDOM(renderFrozenAppearance(frozen,p=>p.slice(1).split('/'),state),{runScripts:'outside-only'}),w=dom.window
  try {
    Object.assign(w,{Mvu:{getMvuData:()=>({stat_data:state}),events:{VARIABLE_UPDATE_ENDED:'updated'}},waitGlobalInitialized:async()=>{},eventOn:(name,fn)=>handlers.set(name,fn),tavern_events:{CHAT_CHANGED:'restored'}})
    for(const script of w.document.querySelectorAll('script'))w.eval(script.textContent)
    await new Promise(r=>setImmediate(r))
    assert.deepEqual([...w.document.querySelectorAll('h3')].map(n=>n.textContent),['艾乔','雨辰'])
    const details=w.document.querySelector('details');details.open=true
    state.人物.雨辰.位置='丙';state.人物.新人物={姓名:'新人物',位置:'丁'};handlers.get('updated')()
    assert.deepEqual([...w.document.querySelectorAll('span')].map(n=>n.textContent),['甲','丙','丁'])
    assert.equal(w.document.querySelector('details'),details);assert.equal(details.open,true)
    state=initial;handlers.get('restored')()
    assert.deepEqual([...w.document.querySelectorAll('h3')].map(n=>n.textContent),['艾乔','雨辰'])
    assert.deepEqual([...w.document.querySelectorAll('span')].map(n=>n.textContent),['甲','乙'])
    assert.equal(details.open,true)
  }finally{w.close()}
})
