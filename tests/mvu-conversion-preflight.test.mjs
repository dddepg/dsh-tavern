import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createFileResourceStore} from '../tavern-plugin/lib/domain/file-resources.js'
import {createMvuConversion,cardData} from '../tavern-plugin/lib/domain/mvu-conversion.js'
import {registerMvuConversionTools} from '../tavern-plugin/lib/domain/mvu-conversion-tools.js'
async function fixture(t,extra={}){
 const root=await mkdtemp(join(tmpdir(),'mvu-preflight-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const resources=createFileResourceStore({dataRoot:root});await resources.ensure()
 const card={name:'组件测试',first_mes:'保留正文\n\n<mvu-status/>',alternate_greetings:['另一个开场'],...extra}
 const sourcePath=await resources.importCard({name:'组件测试.json',text:JSON.stringify(card)},card)
 const conversion=createMvuConversion({resources}),registered=new Map()
 registerMvuConversionTools({tools:{register:tool=>registered.set(tool.name,tool)},defineTool:x=>x,conversion,chatForSession:async()=>({mode:'card'})})
 const inspect=await conversion.convert({action:'inspect',sourcePath})
 const args={sourcePath,sourceRevision:inspect.sourceRevision,initialState:{位置:'门口',日志:['第一项','<script>不执行</script>'],状态:'正常'},updateRules:'仅根据正文更新'}
 return {resources,conversion,registered,args,sourcePath}
}
test('组件设计自动编号补齐字段，列表经历磁盘装配和托管 DOM 模拟，原卡不改',async t=>{
 const f=await fixture(t)
 const {report:saved}=await f.registered.get('tavern_design_mvu_appearance').execute({...f.args,fields:[{path:'/日志',display:'list',label:'经历'}]}, {})
 assert.ok(saved.definitionRevision,JSON.stringify(saved))
 const definition=await f.resources.readMvuDefinition(saved.definitionRevision)
 assert.deepEqual(definition.appearance.bindings.map(b=>b.path),['/日志','/位置','/状态'])
 assert.deepEqual(definition.appearance.bindings.map(b=>b.capture),[1,2,3])
 const preflight=await f.conversion.convert({action:'preflight',...f.args,definitionRevision:saved.definitionRevision})
 assert.equal(preflight.saved,false);assert.equal(preflight.suggestedCleanup.length,1)
 const result=await f.conversion.convert({action:'apply',sourcePath:f.sourcePath,sourceRevision:f.args.sourceRevision,definitionRevision:saved.definitionRevision,cleanupOrphanEntrances:true})
 assert.equal(result.validation.valid,true,JSON.stringify(result.validation))
 assert.equal(cardData(await f.resources.readCard(f.sourcePath)).first_mes,'保留正文\n\n<mvu-status/>')
 const output=cardData(await f.resources.readCard(result.path))
 assert.equal(output.first_mes.split('<mvu-status/>').length-1,1)
 assert.match(output.first_mes,/<initvar>/)
})

test('自定义布局已有字段名时，组件仅显示值，不泄漏路径或重复标签', async t => {
 const f=await fixture(t)
 const {report}=await f.registered.get('tavern_design_mvu_appearance').execute({...f.args,initialState:{时间:{日期:'初秋 平日'}},html:'<div class="row"><span>日期</span><mvu-field path="/时间/日期"></mvu-field></div>'},{})
 assert.ok(report.definitionRevision,JSON.stringify(report))
 const saved=await f.resources.readMvuDefinition(report.definitionRevision)
 const {JSDOM}=await import('jsdom')
 const dom=new JSDOM(saved.appearance.html)
 try {
   assert.equal(dom.window.document.querySelector('.row').textContent,'日期$1')
   assert.equal(dom.window.document.querySelector('.row').lastElementChild.tagName,'SPAN')
   assert.deepEqual(saved.appearance.bindings,[{capture:1,path:'/时间/日期'}])
 } finally {dom.window.close()}
})
