import {createDefinition,normalizeOpeningStates} from './mvu-conversion-definition.js'
import {compileMvuComponents,componentFields} from './mvu-conversion-components.js'
import {freezeMvuAppearance} from './mvu-conversion-appearance.js'
import {buildMvuArtifacts,MVU_CONVERSION_KEY,MVU_MARKER} from './mvu-conversion-artifacts.js'

export function inspectMvuEntrances(data) {
  const rest=structuredClone(data);delete rest.first_mes;delete rest.alternate_greetings
  const functional=Boolean(data.extensions?.[MVU_CONVERSION_KEY])||/initvar|mvu_update|mvu-status|StatusPlaceHolderImpl|\bMvu\b|<script/i.test(JSON.stringify(rest))||[data.first_mes,...(data.alternate_greetings||[])].some(text=>/<initvar\b|<script\b/i.test(text||''))
  const issues=[],suggestedCleanup=[]
  for(const [index,value] of [data.first_mes,...(data.alternate_greetings||[])].entries()) {
    const text=String(value||''),path=index===0?'/first_mes':'/alternate_greetings/'+(index-1)
    const count=text.split(MVU_MARKER).length-1
    if(!count&&!/<initvar\b/i.test(text))continue
    // Only a single, standalone trailing marker, without any known MVU logic.
    const safe=!functional&&count===1&&/(?:^|\n)[ \t]*<mvu-status\/>[ \t]*$/.test(text.trimEnd())&&text.replace(MVU_MARKER,'').trim().length>0
    issues.push({path,code:safe?'MVU_ORPHAN_ENTRANCE':'MVU_EXISTING_ENTRANCE',safeToClean:safe,context:text.slice(Math.max(0,Math.max(0,text.indexOf(MVU_MARKER))-60),Math.max(0,text.indexOf(MVU_MARKER))+80),hint:safe?'可启用 cleanupOrphanEntrances，仅清理标记，保留正文。':'包含初值、渲染逻辑或不明确的入口；必须检查后显式提供 cleanup，不自动删除。'})
    if(safe)suggestedCleanup.push({op:'replaceText',path,expected:MVU_MARKER,value:'',reason:'预检确认的孤立旧入口；不含初值或已知 MVU 渲染逻辑'})
  }
  return {issues,suggestedCleanup}
}
export function preflightMvuConversion(source,args,applyCleanup) {
  const checks=[],issues=[];let states,definition,appearance,cleaned
  function check(name,run){try{const value=run();checks.push({name,status:'passed'});return value}catch(error){checks.push({name,status:'failed'});issues.push({check:name,code:error.code||'MVU_PREFLIGHT_INVALID',message:error.message,...error.details})}}
  states=check('openingStates',()=>normalizeOpeningStates(args.openingStates,args.initialState,1+(source.data.alternate_greetings?.length||0)))
  appearance=check('appearance',()=>{
    const plan=compileMvuComponents(args.appearance,states||[args.initialState])
    if(plan)freezeMvuAppearance(source.data,plan)
    return plan
  })
  if(states)definition=check('definition',()=>createDefinition(source,{...args,openingStates:states,...(appearance?{appearance}:{})}))
  if(definition)check('artifacts',()=>{const frozenAppearance=definition.appearance?freezeMvuAppearance(source.data,definition.appearance):undefined;for(const initialState of definition.openingStates)buildMvuArtifacts({...definition,initialState,frozenAppearance})})
  cleaned=check('cleanup',()=>applyCleanup(structuredClone(source.data),args.cleanup))
  const entrances=inspectMvuEntrances(cleaned||source.data)
  issues.push(...entrances.issues)
  return {ok:issues.length===0,sourceRevision:source.revision,checks,issues,suggestedCleanup:entrances.suggestedCleanup,
    ...(states?{openingStates:states}:{}),fieldComponents:componentFields(args.initialState),
    ...(appearance?{appearance}:{}),saved:false,pending:['官方 MVU 初始化','后台真实结算','浏览器布局与会话切换'],
    instruction:'此检查不写文件、不代表运行实测。修正 issues 后保存定义；已有有效 MVU 入口不能自动清理。'}
}
