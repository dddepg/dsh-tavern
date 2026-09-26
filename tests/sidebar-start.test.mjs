import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'

test('开始页注册到原生 guide chain 并通过当前标签导航', async () => {
 const source=await readFile(new URL('../tavern-plugin/src/client/modules/sidebar-start.js',import.meta.url),'utf8')
 let options,component,navigation
 const entries=[{kind:'dsh-tavern:cards',title:()=> '人物卡库'}]
 const registry={subscribe:()=>()=>{},guide:()=>entries}
 const ctx={inject:(_deps,callback)=>callback({get:()=>registry,effect:fn=>fn()})}
 const slots={inject:(name,fn)=>{assert.equal(name,'sidebar.right.tab.guide');return fn()},register:(o,c)=>{options=o;component=c}}
 const React={useSyncExternalStore:(_s,get)=>get(),createElement:(type,props)=>({type,props})}
 vm.runInNewContext(source+'\nregisterTavernStartPage(ctx,slots)',{ctx,slots,React})
 assert.equal(options.select({}),true)
 const result=component({useTabInfo:()=>({tab:{actions:{openTab:(...args)=>navigation=args}}})})
 assert.equal(result.props.newTabOptions[0].label,'人物卡库')
 result.props.onNewTab('dsh-tavern:cards')
 assert.equal(navigation[0],'dsh-tavern:cards')
 assert.equal(navigation[1].replaceTab,true)
})
