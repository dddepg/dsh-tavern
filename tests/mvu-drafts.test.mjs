import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createFileResourceStore} from '../tavern-plugin/lib/domain/file-resources.js'
import {createMvuConversion,cardData} from '../tavern-plugin/lib/domain/mvu-conversion.js'
import {registerMvuConversionTools} from '../tavern-plugin/lib/domain/mvu-conversion-tools.js'

async function fixture(t,options={}) {
 const root=await mkdtemp(join(tmpdir(),'mvu-draft-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const resources=createFileResourceStore({dataRoot:root}),conversion=createMvuConversion({resources})
 await resources.ensure()
 const card={name:'草稿测试',description:'保留设定',first_mes:'大厅开场',alternate_greetings:['车站开场'],...options.card}
 const sourcePath=await resources.importCard({name:'草稿测试.json',text:JSON.stringify(card)},card)
 let current=await conversion.draft({action:'begin',sourcePath,requestId:'begin',...options.begin})
 let sequence=0
 const patch=async(section,values,extra={})=>current=await conversion.draft({action:'patch',draftId:current.draftId,draftRevision:current.draftRevision,requestId:'patch-'+(++sequence),section,values,...extra})
 const read=()=>conversion.draft({action:'read',draftId:current.draftId})
 const commitArgs=()=>({action:'commit',draftId:current.draftId,draftRevision:current.draftRevision,requestId:'commit'})
 const complete=async()=>{
  await patch('fields',{'/时间/时段':'白天','/地点/名称':'大厅'})
  await patch('opening',undefined,{openingId:'opening-0',inheritInitialState:true})
  await patch('opening',{'/时间/时段':'夜晚','/地点/名称':'车站'},{openingId:'opening-1'})
  await patch('rules',{场景:'依据正文更新时间地点'})
  await patch('appearance',{html:'<section><h2>场景</h2><mvu-field path="/时间/时段"></mvu-field><mvu-field path="/地点/名称"></mvu-field></section>'})
  await patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 }
 return {root,resources,conversion,sourcePath,patch,read,commitArgs,complete,get current(){return current}}
}
test('分组草稿跨重启恢复，逐开场保存，原卡不变，重复提交只生成一个副本',async t=>{
 const f=await fixture(t),source=await f.resources.readText(f.sourcePath)
 await f.complete()
 const restored=createMvuConversion({resources:createFileResourceStore({dataRoot:f.root})})
 const read=await restored.draft({action:'read',draftId:f.current.draftId,path:'/definition/openingStates/1/地点/名称'})
 assert.equal(read.reading.text,'车站');assert.equal(read.missingCount,0)
 const result=await restored.draft(f.commitArgs())
 assert.equal(result.receipt.validation.valid,true,JSON.stringify(result))
 assert.equal(result.phase,'committed')
 const card=cardData(await f.resources.readCard(result.targetPath))
 assert.equal(JSON.parse(card.first_mes.match(/<initvar>\s*([\s\S]*?)\s*<\/initvar>/)[1]).地点.名称,'大厅')
 assert.equal(JSON.parse(card.alternate_greetings[0].match(/<initvar>\s*([\s\S]*?)\s*<\/initvar>/)[1]).地点.名称,'车站')
 const bytes=await f.resources.readText(result.targetPath)
 assert.deepEqual(await restored.draft(f.commitArgs()),result)
 assert.equal(await f.resources.readText(result.targetPath),bytes)
 assert.equal(await f.resources.readText(f.sourcePath),source)
 assert.equal((await f.resources.list('card')).length,2)
})
test('不自动共用开场，定制美化不能用 fields 冒充，未完成草稿不生成成品',async t=>{
 const f=await fixture(t)
 await f.patch('fields',{'/位置':'大厅'})
 await f.patch('rules',{位置:'按正文更新'})
 await f.patch('appearance',{fields:[]})
 await f.patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 await assert.rejects(f.conversion.draft(f.commitArgs()),error=>error.code==='DRAFT_INCOMPLETE'&&error.details.issues.some(x=>x.openingId==='opening-1')&&error.details.issues.some(x=>x.section==='appearance'))
 assert.equal((await f.resources.list('card')).length,1)
 assert.equal((await f.read()).saved,true)
})
test('规则和单开场修改保留美化，新增字段后重新要求补齐所有开场',async t=>{
 const f=await fixture(t);await f.complete()
 const original=(await f.conversion.draft({action:'read',draftId:f.current.draftId,path:'/definition/appearance/html'})).reading.text
 await f.patch('rules',{场景:'仅根据已发生事实更新'})
 assert.equal((await f.conversion.draft({action:'read',draftId:f.current.draftId,path:'/definition/appearance/html'})).reading.text,original)
 await f.patch('fields',{'/天气':'晴'})
 const state=await f.read()
 assert.ok(state.missing.some(x=>x.openingId==='opening-0'&&x.path==='/天气'))
 assert.ok(state.missing.some(x=>x.openingId==='opening-1'&&x.path==='/天气'))
 assert.ok(state.missing.some(x=>x.section==='review'))
})
test('版本冲突不覆盖草稿，相同请求幂等，复用请求 ID 改参数被拒绝',async t=>{
 const f=await fixture(t),base=f.current
 const args={action:'patch',draftId:base.draftId,draftRevision:base.draftRevision,requestId:'stable',section:'fields',values:{'/位置':'大厅'}}
 const first=await f.conversion.draft(args)
 assert.deepEqual(await f.conversion.draft(args),first)
 await assert.rejects(f.conversion.draft({...args,values:{'/位置':'车站'}}),e=>e.code==='DRAFT_REQUEST_REUSED')
 await assert.rejects(f.conversion.draft({...args,requestId:'new'}),e=>e.code==='DRAFT_REVISION_CONFLICT')
 const other=createMvuConversion({resources:createFileResourceStore({dataRoot:f.root})})
 const attempts=await Promise.allSettled([f.conversion,other].map((c,i)=>c.draft({...args,draftRevision:first.draftRevision,requestId:'parallel-'+i})))
 assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1)
})
test('源卡变化、重叠字段和危险路径均不覆盖资源',async t=>{
 const f=await fixture(t);await f.complete()
 await assert.rejects(f.patch('fields',{'/__proto__/polluted':true}))
 await assert.rejects(f.patch('fields',{'/地点':{},'/地点/名称':'车站'}),e=>e.code==='DRAFT_PATH_OVERLAP')
 const doc=await f.resources.readCard(f.sourcePath);cardData(doc).description='外部更新'
 await f.resources.writeWorking(f.sourcePath,JSON.stringify(doc))
 await assert.rejects(f.conversion.draft(f.commitArgs()),e=>e.code==='DRAFT_SOURCE_CHANGED')
 assert.equal((await f.resources.list('card')).length,1)
})
test('明确选择基础面板才可提交，工具 JSON 回执与角色限制可用',async t=>{
 const f=await fixture(t,{begin:{appearanceRequirement:'basic',basicReason:'用户明确要求基础面板'}})
 await f.patch('fields',{'/位置':'大厅'})
 for(const openingId of ['opening-0','opening-1'])await f.patch('opening',undefined,{openingId,inheritInitialState:true})
 await f.patch('rules',{位置:'按正文更新'})
 await f.patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 const tools=new Map();let mode='story'
 registerMvuConversionTools({tools:{register:x=>tools.set(x.name,x)},defineTool:x=>x,conversion:f.conversion,chatForSession:async()=>({mode})})
 const tool=tools.get('tavern_card_draft')
 await assert.rejects(tool.execute(f.commitArgs(),{}),/工作台/)
 mode='card'
 const {report}=await tool.execute(f.commitArgs(),{})
 assert.equal(report.receipt.validation.valid,true)
 assert.deepEqual(JSON.parse(JSON.stringify(report)),report)
})
test('成品写入后回执失败可恢复，提交中禁止修改草稿，重试不丢结果',async t=>{
 const f=await fixture(t);await f.complete()
 let failOnce=true
 const failing=createMvuConversion({resources:{...f.resources,saveMvuCard:async args=>{
  const result=await f.resources.saveMvuCard(args)
  if(failOnce){failOnce=false;throw Error('模拟提交后连接中断')}
  return result
 }}})
 await assert.rejects(failing.draft(f.commitArgs()),e=>e.details.commitState==='unknown'&&e.details.saved===true)
 const pending=await f.read()
 assert.equal(pending.phase,'committing');assert.equal(pending.pendingCommit.requestId,'commit')
 const bytes=await f.resources.readText(pending.targetPath);assert.ok(bytes)
 await assert.rejects(f.patch('rules',{场景:'不应写入'}),e=>e.code==='DRAFT_COMMIT_PENDING')
 const resumed=await createMvuConversion({resources:createFileResourceStore({dataRoot:f.root})}).draft(f.commitArgs())
 assert.equal(resumed.phase,'committed');assert.equal(resumed.receipt.validation.valid,true)
 assert.equal(await f.resources.readText(pending.targetPath),bytes)
})
test('更新现有副本只改选定开场，保留既有美化及另一个开场',async t=>{
 const f=await fixture(t);await f.complete()
 const first=await f.conversion.draft(f.commitArgs()),before=cardData(await f.resources.readCard(first.targetPath)).extensions.dsh_mvu_conversion
 let d=await f.conversion.draft({action:'begin',sourcePath:f.sourcePath,requestId:'second'})
 d=await f.conversion.draft({action:'patch',draftId:d.draftId,draftRevision:d.draftRevision,requestId:'opening',section:'opening',openingId:'opening-1',values:{'/地点/名称':'码头'}})
 d=await f.conversion.draft({action:'patch',draftId:d.draftId,draftRevision:d.draftRevision,requestId:'review',section:'review',values:{sourceCoverage:true,cleanup:true,appearance:true}})
 const result=await f.conversion.draft({action:'commit',draftId:d.draftId,draftRevision:d.draftRevision,requestId:'finish'})
 assert.equal(result.receipt.validation.valid,true)
 const after=cardData(await f.resources.readCard(result.targetPath)).extensions.dsh_mvu_conversion
 assert.equal(after.updateRules,before.updateRules)
 assert.deepEqual(after.appearance,before.appearance)
 assert.deepEqual(after.openingStates[0],before.openingStates[0]);assert.equal(after.openingStates[1].地点.名称,'码头')
})
test('目标被抢占时拒绝提交，保存的草稿仍可读取',async t=>{
 const f=await fixture(t);await f.complete()
 const card={name:'他人资源',first_mes:'保留'}
 await f.resources.writeWorking(f.current.targetPath,JSON.stringify(card))
 await assert.rejects(f.conversion.draft(f.commitArgs()),e=>e.code==='DRAFT_INCOMPLETE'&&e.details.issues.some(x=>x.code==='DRAFT_TARGET_CHANGED'))
 assert.equal(await f.resources.readText(f.current.targetPath),JSON.stringify(card))
 assert.equal((await f.read()).phase,'editing')
})
test('工具真实 DSH 参数定义和无损 JSON 回执覆盖草稿、错误与最终提交',{skip:!process.env.DSH_BOOT_MODULE},async t=>{
 const {pathToFileURL}=await import('node:url'),root=pathToFileURL(process.env.DSH_BOOT_MODULE)
 const {defineTool,validateJsonSchemaValue}=await import(new URL('../../dsh-tools/lib/index.js',root))
 const {snapshotJsonValue}=await import(new URL('../../dsh-util-values/lib/index.js',root))
 const f=await fixture(t),registered=new Map()
 registerMvuConversionTools({tools:{register:x=>registered.set(x.name,x)},defineTool,conversion:f.conversion,chatForSession:async()=>({mode:'card'})})
 const tool=registered.get('tavern_card_draft')
 async function invoke(args) {
  const result=await tool.execute(args,{})
  assert.notEqual(snapshotJsonValue(result),undefined)
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema,result),[])
  assert.notEqual(snapshotJsonValue(tool.output.render(args,result)),undefined)
  return result.report
 }
 await invoke({action:'read',draftId:f.current.draftId})
 assert.equal((await invoke(f.commitArgs())).error.code,'DRAFT_INCOMPLETE')
 await f.complete()
 assert.equal((await invoke(f.commitArgs())).receipt.validation.valid,true)
})
test('显式调整美化要求保留已填写内容，降级必须有依据',async t=>{
 const f=await fixture(t);await f.complete()
 await assert.rejects(f.patch('requirements',{appearanceRequirement:'basic'}),e=>e.code==='DRAFT_REQUIREMENT_INVALID')
 await f.patch('requirements',{appearanceRequirement:'basic',basicReason:'用户更改要求为基础面板'})
 assert.equal(f.current.progress.appearanceRequirement,'basic')
 assert.equal(f.current.progress.appearanceSaved,true)
 assert.ok(f.current.progress.openings.every(x=>x.filled))
 assert.ok(f.current.missing.some(x=>x.section==='review'))
})
test('草稿保留原美化，按来源映射复制不同开场值，清理仅作用于副本',async t=>{
 const f=await fixture(t,{card:{first_mes:'开场甲<位置>大厅</位置>',alternate_greetings:['开场乙<位置>车站</位置>'],extensions:{regex_scripts:[{id:'old',findRegex:'/<位置>(.*?)<\\/位置>/g',replaceString:'<section class="original-skin"><strong>位置</strong><span>$1</span></section>',placement:[2],markdownOnly:true}]}}})
 assert.equal(f.current.progress.appearanceRequirement,'preserve')
 const mappings=f.current.stateInventory.map(item=>({sourceId:item.id,path:'/位置'}))
 await f.patch('fields',{'/位置':''})
 for(const openingId of ['opening-0','opening-1'])await f.patch('opening',undefined,{openingId,inheritInitialState:true})
 await f.patch('rules',{位置:'只根据正文移动更新'})
 await f.patch('mapping',{fieldMappings:mappings})
 await f.patch('appearance',{sourcePath:'/extensions/regex_scripts/0/replaceString',bindings:[{capture:1,path:'/位置'}]})
 await f.patch('cleanup',[{op:'remove',path:'/extensions/regex_scripts/0'},...['/first_mes','/alternate_greetings/0'].map(path=>({op:'replaceBlock',path,start:'<位置>',end:'</位置>',value:''}))])
 await f.patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 const result=await f.conversion.draft(f.commitArgs())
 assert.equal(result.receipt.validation.valid,true)
 const meta=cardData(await f.resources.readCard(result.targetPath)).extensions.dsh_mvu_conversion
 assert.equal(meta.openingStates[0].位置,'大厅');assert.equal(meta.openingStates[1].位置,'车站')
 assert.match(meta.frozenAppearance.html,/original-skin/)
 assert.equal(cardData(await f.resources.readCard(f.sourcePath)).extensions.regex_scripts.length,1)
})
