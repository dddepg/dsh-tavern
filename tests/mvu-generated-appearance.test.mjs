import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createFileResourceStore} from '../tavern-plugin/lib/domain/file-resources.js'
import {createMvuConversion,cardData} from '../tavern-plugin/lib/domain/mvu-conversion.js'
import {registerMvuConversionTools} from '../tavern-plugin/lib/domain/mvu-conversion-tools.js'
import {freezeMvuAppearance} from '../tavern-plugin/lib/domain/mvu-conversion-appearance.js'
async function fixture(t){const dataRoot=await mkdtemp(join(tmpdir(),'mvu-design-'));t.after(()=>rm(dataRoot,{recursive:true,force:true}));const resources=createFileResourceStore({dataRoot});await resources.ensure();const card={name:'星际旅人',first_mes:'飞船抵达。',extensions:{}};const sourcePath=await resources.importCard({name:'星际旅人.json',text:JSON.stringify(card)},card);const conversion=createMvuConversion({resources});const inspection=await conversion.convert({action:'inspect',sourcePath});const tools=new Map();registerMvuConversionTools({tools:{register:t=>tools.set(t.name,t)},defineTool:t=>t,conversion,chatForSession:async()=>({mode:'card'})});return {resources,conversion,tool:tools.get('tavern_design_mvu_appearance'),sourcePath,sourceRevision:inspection.sourceRevision}}
const plan={initialState:{人物:{$meta:{extensible:true,template:{姓名:'',位置:''}},甲:{姓名:'甲',位置:'驾驶舱'},乙:{姓名:'乙',位置:'货舱'}}},updateRules:'人物位置随正文移动更新。',html:'<style>article{background:#142338;color:#fff;padding:12px}</style><article><h3>✦ $1</h3><details><summary>所在位置</summary>$2</details></article>',collectionPath:'/人物',bindings:[{capture:1,path:'/姓名'},{capture:2,path:'/位置'}]}
test('新设计工具保存风格面板定义，转换直接装配且原卡无改动',async t=>{const f=await fixture(t),before=await f.resources.readText(f.sourcePath);const {report}=await f.tool.execute({sourcePath:f.sourcePath,sourceRevision:f.sourceRevision,...plan},{});const result=await f.conversion.convert({action:'apply',sourcePath:f.sourcePath,sourceRevision:f.sourceRevision,definitionRevision:report.definitionRevision,cleanup:[]});assert.equal(result.validation.valid,true,JSON.stringify(result.validation));const data=cardData(await f.resources.readCard(result.path));assert.equal(data.extensions.dsh_mvu_conversion.frozenAppearance.generated,true);assert.match(data.extensions.regex_scripts[0].replaceString,/#142338/);assert.equal(await f.resources.readText(f.sourcePath),before);assert.match(result.nextAction,/<initvar>/);assert.match(result.nextAction,/<mvu-status\/>/);const inspect=await f.conversion.convert({action:'inspect',sourcePath:f.sourcePath});assert.match(inspect.structureGuide.bindings.collection,/不能混入/)})
test('美化少字段时不能保存定义',async t=>{const f=await fixture(t);const {report}=await f.tool.execute({sourcePath:f.sourcePath,sourceRevision:f.sourceRevision,...plan,html:'<div>$1</div>',bindings:[plan.bindings[0]]},{});assert.equal(report.ok,false);assert.equal(report.error.code,'MVU_APPEARANCE_MISSING_FIELDS');assert.ok(report.error.missingPaths.includes('/人物/乙/位置'))})
test('已有美化不能覆盖；生成设计不能注入脚本',()=>{assert.throws(()=>freezeMvuAppearance({extensions:{regex_scripts:[{replaceString:'<div>$1</div>'}]}},{html:'<div>$1</div>',bindings:[{capture:1,path:'/位置'}]}),/已有美化/);for(const html of ['<div>$1<script>alert(1)</script></div>','<div onclick="run()">$1</div>','<iframe></iframe><div>$1</div>'])assert.throws(()=>freezeMvuAppearance({}, {html,bindings:[{capture:1,path:'/位置'}]}))})
test('空人物集合的模板字段也不能被美化漏掉',async t=>{const f=await fixture(t);const {report}=await f.tool.execute({sourcePath:f.sourcePath,sourceRevision:f.sourceRevision,...plan,initialState:{人物:{$meta:plan.initialState.人物.$meta}},html:'<div>$1</div>',bindings:[plan.bindings[0]]},{});assert.equal(report.ok,false);assert.equal(report.error.code,'MVU_APPEARANCE_MISSING_FIELDS')})

test('设计工具返回可直接修正的两类错误，按提示重试成功且失败不写卡',async t=>{
 const f=await fixture(t)
 const base={sourcePath:f.sourcePath,sourceRevision:f.sourceRevision,initialState:{时间:'午后',人物:{甲:{姓名:'甲'}}},updateRules:'依据正文事实更新。'}
 const mixed=await f.tool.execute({...base,collectionPath:'/人物',html:'<p>$1 $2</p>',bindings:[{capture:1,path:'/姓名'},{capture:2,path:'/时间'}]}, {})
 assert.equal(mixed.report.ok,false)
 assert.equal(mixed.report.error.code,'MVU_APPEARANCE_SCOPE_MISMATCH')
 assert.equal(mixed.report.error.path,'/时间')
 const root={...base,html:'<p>对{{user}}：$1 $2</p>',bindings:[{capture:1,path:'/时间'},{capture:2,path:'/人物'}]}
 const syntax=await f.tool.execute(root,{})
 assert.equal(syntax.report.ok,false)
 assert.equal(syntax.report.error.code,'MVU_APPEARANCE_UNSUPPORTED_SYNTAX')
 assert.equal(syntax.report.error.token,'{{user}}')
 assert.equal((await f.resources.list('card')).length,1)
 const fixed=await f.tool.execute({...root,html:'<p>玩家：$1 $2</p>'},{})
 assert.match(fixed.report.definitionRevision,/^[a-f0-9]{64}$/)
})
