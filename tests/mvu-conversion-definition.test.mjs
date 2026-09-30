import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createFileResourceStore} from '../tavern-plugin/lib/domain/file-resources.js'
import {createMvuConversion,cardData} from '../tavern-plugin/lib/domain/mvu-conversion.js'
const source=()=>({name:'多人',first_mes:'开场甲\n<姓名>艾乔</姓名><位置>门口</位置>',alternate_greetings:['开场乙\n<姓名>雨辰</姓名><位置>大厅</位置>'],extensions:{regex_scripts:[{id:'old',findRegex:'/<姓名>(.*?)<\\/姓名><位置>(.*?)<\\/位置>/g',replaceString:'<div>$1<details><summary>位置</summary>$2</details></div>',placement:[2],markdownOnly:true}]}})
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'mvu-ledger-'));t.after(()=>rm(root,{recursive:true,force:true}));const resources=createFileResourceStore({dataRoot:root});await resources.ensure();const card=source();const sourcePath=await resources.importCard({name:'多人.json',text:JSON.stringify(card)},card);const conversion=createMvuConversion({resources});const inspect=await conversion.convert({action:'inspect',sourcePath});return {resources,conversion,sourcePath,inspect}}
const definition=()=>({initialState:{人物:{$meta:{extensible:true,template:{姓名:'',位置:''}},艾乔:{姓名:'艾乔',位置:''},雨辰:{姓名:'雨辰',位置:''}}},updateRules:'按姓名更新位置；正文出现新人物时追加。',appearance:{sourcePath:'/extensions/regex_scripts/0/replaceString',collectionPath:'/人物',bindings:[{capture:1,path:'/姓名'},{capture:2,path:'/位置'}]}})
const cleanup=[{op:'remove',path:'/extensions/regex_scripts/0'},{op:'replaceBlock',path:'/first_mes',start:'<姓名>',end:'</位置>',value:''},{op:'replaceBlock',path:'/alternate_greetings/0',start:'<姓名>',end:'</位置>',value:''}]
async function save(f,extra={}){const fields=f.inspect.stateInventory;return f.conversion.convert({action:'saveDefinition',sourcePath:f.sourcePath,sourceRevision:f.inspect.sourceRevision,...definition(),fieldMappings:fields.map(x=>({sourceId:x.id,path:'/人物/'+(x.opening===0?'艾乔':'雨辰')+'/'+x.field})),...extra})}
test('字段清单先落盘；重建工具后装配全部人物及各开场初值，拒绝漏字段和覆写',async t=>{
 const f=await fixture(t);assert.equal(f.inspect.stateInventory.length,4)
 await assert.rejects(save(f,{fieldMappings:[]}),/未迁移/)
 const saved=await save(f);assert.ok(saved.definitionRevision)
 const conversion=createMvuConversion({resources:f.resources})
 const args={action:'apply',sourcePath:f.sourcePath,sourceRevision:f.inspect.sourceRevision,definitionRevision:saved.definitionRevision,cleanup}
 await assert.rejects(conversion.convert({...args,initialState:{人物:{}}}),/已保存定义/)
 const preflight=await conversion.convert({...args,action:'preflight'});assert.equal(preflight.ok,true,JSON.stringify(preflight.issues))
 const result=await conversion.convert(args);assert.equal(result.validation.valid,true)
 const card=cardData(await f.resources.readCard(result.path));const meta=card.extensions.dsh_mvu_conversion
 assert.equal(meta.openingStates[0].人物.艾乔.位置,'门口');assert.equal(meta.openingStates[1].人物.雨辰.位置,'大厅')
 assert.match(card.alternate_greetings[0],/<initvar>/)
 assert.equal(JSON.parse(card.alternate_greetings[0].match(/<initvar>([\s\S]*?)<\/initvar>/)[1]).人物.雨辰.位置,'大厅')
 assert.equal(result.validation.checks.find(x=>x.name==='fieldCoverage').status,'passed')
})

test('只绑定第一个人物、合并两个人物、缺少开场字段均拒绝保存',async t=>{
 const f=await fixture(t)
 await assert.rejects(save(f,{appearance:{sourcePath:'/extensions/regex_scripts/0/replaceString',bindings:[{capture:1,path:'/人物/艾乔/姓名'},{capture:2,path:'/人物/艾乔/位置'}]}}),/没有展示映射/)
 await assert.rejects(save(f,{openingStates:[definition().initialState,{人物:{}}]}),/路径不存在/)
 const fields=f.inspect.stateInventory
 await assert.rejects(save(f,{fieldMappings:fields.map(x=>({sourceId:x.id,path:'/人物/艾乔/位置'}))}),/同一路径/)
})

test('来源变化、伪造版本、损坏持久化定义都不会写出新卡',async t=>{
 const f=await fixture(t),saved=await save(f)
 const args={action:'apply',sourcePath:f.sourcePath,sourceRevision:f.inspect.sourceRevision,definitionRevision:saved.definitionRevision,cleanup}
 await assert.rejects(f.conversion.convert({...args,definitionRevision:'../outside'}),/版本无效/)
 const ledger=await f.resources.readMvuDefinition(saved.definitionRevision);delete ledger.initialState.人物.雨辰
 await f.resources.saveMvuDefinition(saved.definitionRevision,ledger)
 await assert.rejects(f.conversion.convert(args),/被修改/)
 assert.equal((await f.resources.list('card')).length,1)
})

test('数字键开场对象可无歧义归一化，缺项仍拒绝', async t=>{
 const f=await fixture(t),state=definition().initialState
 const saved=await save(f,{openingStates:{0:state,1:state}})
 const ledger=await f.resources.readMvuDefinition(saved.definitionRevision)
 assert.equal(ledger.openingStates.length,2)
 await assert.rejects(save(f,{openingStates:{0:state}}),error=>error.code==='MVU_OPENING_STATES_INVALID'&&error.details.missingIndices.includes(1))
})
