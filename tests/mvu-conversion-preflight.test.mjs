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
test('预检一次返回开场缺项、动态属性和旧入口问题，不保存文件',async t=>{
 const f=await fixture(t)
 const {report}=await f.registered.get('tavern_convert_to_mvu').execute({action:'preflight',...f.args,openingStates:{0:f.args.initialState},appearance:{html:'<div data-mvu-list="$1">$1</div>',bindings:[{capture:1,path:'/日志'}]}},{})
 assert.equal(report.ok,false)
 assert.ok(report.issues.some(i=>i.code==='MVU_OPENING_STATES_INVALID'))
 assert.ok(report.issues.some(i=>i.check==='appearance'&&i.message.includes('data-mvu-list')))
 assert.ok(report.issues.some(i=>i.code==='MVU_ORPHAN_ENTRANCE'))
 assert.equal((await f.resources.list('card')).length,1)
})
test('已有初值或渲染引用的入口不建议自动删除',async t=>{
 const f=await fixture(t,{first_mes:'正文\n<initvar>{"位置":"门口"}</initvar>\n<mvu-status/>'})
 const report=await f.conversion.convert({action:'preflight',...f.args})
 assert.equal(report.suggestedCleanup.length,0)
 assert.equal(report.issues.find(i=>i.code==='MVU_EXISTING_ENTRANCE').safeToClean,false)
 const saved=await f.conversion.convert({action:'saveDefinition',...f.args})
 await assert.rejects(f.conversion.convert({action:'apply',sourcePath:f.sourcePath,sourceRevision:f.args.sourceRevision,definitionRevision:saved.definitionRevision,cleanupOrphanEntrances:true}),/旧 MVU 入口/)
 assert.equal((await f.resources.list('card')).length,1)
})
test('命名组件可保留自定义布局，缺失字段仍明确报告，不静默删字段',async t=>{
 const f=await fixture(t)
 const tool=f.registered.get('tavern_design_mvu_appearance')
 const bad=await tool.execute({...f.args,html:'<section><mvu-field path="/日志" display="list"></mvu-field></section>'},{})
 assert.equal(bad.report.error.code,'MVU_APPEARANCE_MISSING_FIELDS')
 assert.ok(bad.report.error.missingPaths.includes('/状态'))
 const good=await tool.execute({...f.args,html:'<section class="custom"><mvu-field path="/日志" display="list"></mvu-field><mvu-field path="/位置"></mvu-field><mvu-field path="/状态"></mvu-field></section>'},{})
 assert.ok(good.report.definitionRevision,JSON.stringify(good))
})
