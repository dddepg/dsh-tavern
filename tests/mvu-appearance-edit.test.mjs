import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createFileResourceStore} from '../tavern-plugin/lib/domain/file-resources.js'
import {createMvuConversion,cardData} from '../tavern-plugin/lib/domain/mvu-conversion.js'
import {registerMvuConversionTools} from '../tavern-plugin/lib/domain/mvu-conversion-tools.js'

async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'mvu-edit-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const resources=createFileResourceStore({dataRoot:root});await resources.ensure()
 const card={name:'编辑测试',description:'保留设定',first_mes:'第一开场',alternate_greetings:['第二开场']}
 const sourcePath=await resources.importCard({name:'编辑测试.json',text:JSON.stringify(card)},card)
 const conversion=createMvuConversion({resources}),tools=new Map()
 registerMvuConversionTools({tools:{register:t=>tools.set(t.name,t)},defineTool:t=>t,conversion,chatForSession:async()=>({mode:'card'})})
 const {sourceRevision}=await conversion.convert({action:'inspect',sourcePath})
 const saved=await conversion.convert({action:'saveDefinition',sourcePath,sourceRevision,initialState:{日期:'初秋',日志:['初见']},openingStates:[{日期:'初秋',日志:['初见']},{日期:'冬日',日志:['再会']}],updateRules:'按正文更新',appearance:{html:'<section>日期<strong>/日期</strong><span>$1</span><ul><li>$2</li></ul></section>',bindings:[{capture:1,path:'/日期'},{capture:2,path:'/日志',display:'list'}]}})
 const result=await conversion.convert({action:'apply',sourcePath,sourceRevision,definitionRevision:saved.definitionRevision})
 const call=async(name,args)=>(await tools.get(name).execute(args,{})).report
 return {resources,conversion,tools,call,sourcePath,path:result.path}
}
test('两次工具调用完成局部美化修改，定义和成品同步，开场、状态与原卡不变',async t=>{
 const f=await fixture(t),before=cardData(await f.resources.readCard(f.path)),source=await f.resources.readText(f.sourcePath)
 const read=await f.call('tavern_read_mvu_appearance',{path:f.path})
 assert.equal(read.editable,true);assert.match(read.html.text,/<strong>\/日期<\/strong>/)
 assert.equal(read.html.nextOffset,null)
 const saved=await f.call('tavern_update_mvu_appearance',{path:f.path,revision:read.revision,replacements:[{expected:'<strong>/日期</strong>',value:''}]})
 assert.equal(saved.validation.valid,true,JSON.stringify(saved));assert.equal(saved.changed,true)
 const after=cardData(await f.resources.readCard(f.path)),meta=after.extensions.dsh_mvu_conversion
 assert.equal(meta.appearance.html,'<section>日期<span>$1</span><ul><li>$2</li></ul></section>')
 assert.deepEqual(meta.openingStates,before.extensions.dsh_mvu_conversion.openingStates)
 assert.deepEqual(meta.appearance.bindings,before.extensions.dsh_mvu_conversion.appearance.bindings)
 assert.equal(after.description,before.description);assert.equal(after.first_mes,before.first_mes)
 assert.deepEqual(after.alternate_greetings,before.alternate_greetings)
 assert.equal(await f.resources.readText(f.sourcePath),source)
 assert.equal((await f.resources.readMvuDefinition(meta.definitionRevision)).appearance.html,meta.appearance.html)
 assert.equal((await createMvuConversion({resources:f.resources}).verify({path:f.path})).valid,true)
 await assert.rejects(f.call('tavern_update_mvu_appearance',{path:f.path,revision:read.revision,replacements:[{expected:'日期',value:'时间'}]}),/版本|变化/)
})
test('无效替换、重复锚点、字段丢失与脚本注入均不写卡',async t=>{
 const f=await fixture(t),read=await f.call('tavern_read_mvu_appearance',{path:f.path}),before=await f.resources.readText(f.path)
 for(const replacements of [[],[{expected:'不存在',value:''}],[{expected:'日期',value:''}],[{expected:'<span>$1</span>',value:''}],[{expected:'<section>',value:'<section onclick="bad()">'}]]) {
  let failed=false
  try { const result=await f.call('tavern_update_mvu_appearance',{path:f.path,revision:read.revision,replacements});failed=result.ok===false } catch {failed=true}
  assert.equal(failed,true,JSON.stringify(replacements));assert.equal(await f.resources.readText(f.path),before)
 }
})
test('外部改卡、源卡变化和删除目标均拒绝覆盖或重新创建',async t=>{
 for(const kind of ['target','source','deleted']) await t.test(kind,async t=>{
  const f=await fixture(t),read=await f.call('tavern_read_mvu_appearance',{path:f.path})
  if(kind==='deleted')await f.resources.remove(f.path)
  else {const path=kind==='source'?f.sourcePath:f.path,doc=await f.resources.readCard(path);cardData(doc).description='并发编辑';await f.resources.writeWorking(path,JSON.stringify(doc))}
  const before=await f.resources.readText(f.path)
  await assert.rejects(f.call('tavern_update_mvu_appearance',{path:f.path,revision:read.revision,replacements:[{expected:'<strong>/日期</strong>',value:''}]}))
  assert.equal(await f.resources.readText(f.path),before)
 })
})
test('美化读取分页绑定版本，非托管卡明确返回不可编辑',async t=>{
 const f=await fixture(t)
 const first=await f.call('tavern_read_mvu_appearance',{path:f.path,limit:10})
 assert.equal(first.html.text,'<section>日');assert.equal(first.html.nextOffset,10)
 const next=await f.call('tavern_read_mvu_appearance',{path:f.path,revision:first.revision,offset:10,limit:10})
 assert.equal(next.html.offset,10)
 const original=await f.call('tavern_read_mvu_appearance',{path:f.sourcePath})
 assert.equal(original.editable,false);assert.equal(original.html,undefined)
 await assert.rejects(f.call('tavern_read_mvu_appearance',{path:f.path,revision:'stale',offset:10}),/版本/)
})
test('美化工具真实 DSH 无损快照及输出 schema 可接受读写回执', {skip:!process.env.DSH_BOOT_MODULE},async t=>{
 const {pathToFileURL}=await import('node:url'),root=pathToFileURL(process.env.DSH_BOOT_MODULE)
 const {defineTool,validateJsonSchemaValue}=await import(new URL('../../dsh-tools/lib/index.js',root))
 const {snapshotJsonValue}=await import(new URL('../../dsh-util-values/lib/index.js',root))
 const f=await fixture(t),tools=new Map()
 registerMvuConversionTools({tools:{register:t=>tools.set(t.name,t)},defineTool,conversion:f.conversion,chatForSession:async()=>({mode:'card'})})
 async function invoke(name,args) {
  const tool=tools.get(name),result=await tool.execute(args,{})
  assert.notEqual(snapshotJsonValue(result),undefined)
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema,result),[])
  assert.notEqual(snapshotJsonValue(tool.output.render(args,result)),undefined)
  return result.report
 }
 const read=await invoke('tavern_read_mvu_appearance',{path:f.path})
 const result=await invoke('tavern_update_mvu_appearance',{path:f.path,revision:read.revision,replacements:[{expected:'<strong>/日期</strong>',value:''}]})
 assert.equal(result.validation.valid,true)
 await invoke('tavern_read_mvu_appearance',{path:f.sourcePath})
})
