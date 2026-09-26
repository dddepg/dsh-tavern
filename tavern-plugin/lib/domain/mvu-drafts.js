import {createHash} from 'node:crypto'
import {normalizeResourcePath} from './file-resources.js'
import {componentFields} from './mvu-conversion-components.js'
import {pointerKeys, isObject, MVU_CONVERSION_KEY} from './mvu-conversion-artifacts.js'
import {readConversionValue,conversionReading} from './mvu-conversion-inspection.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fail(code,message,details={}) { const error=Error(message);error.code=code;error.details=details;throw error }
function requestKey(args) {
  if(typeof args.requestId!=='string'||!args.requestId.trim()||args.requestId.length>160)fail('DRAFT_REQUEST_REQUIRED','写入需提供稳定的 requestId；响应丢失时原样重试')
  return hash(args.requestId)
}
function setValues(target,values) {
  if(!isObject(values)||!Object.keys(values).length)fail('DRAFT_VALUES_INVALID','values 必须是非空的 JSON Pointer 到值的对象')
  const paths=Object.keys(values)
  for(const path of paths) {
    const keys=pointerKeys(path)
    if(!keys.length||keys.some(k=>['__proto__','prototype','constructor'].includes(k)))fail('DRAFT_PATH_INVALID','字段需要安全的非空 JSON Pointer',{path})
    if(paths.some(other=>other!==path&&path.startsWith(other+'/')))fail('DRAFT_PATH_OVERLAP','一批修改不能同时包含父字段与子字段',{path})
    let parent=target
    for(const key of keys.slice(0,-1)) {
      if(!Object.hasOwn(parent,key))parent[key]={}
      if(!isObject(parent[key]))fail('DRAFT_PATH_INVALID','父路径不是对象；数组请整组提交',{path})
      parent=parent[key]
    }
    parent[keys.at(-1)]=structuredClone(values[path])
  }
}
function hasPath(value,path) {
  for(const key of pointerKeys(path)) {if(value==null||!Object.hasOwn(value,key))return false;value=value[key]}
  return true
}

// Draft writes are durable, revision-checked and serialized across processes by
// the resource store. Final publication reuses the conversion transaction.
export function createMvuDrafts({resources,conversion}) {
  function missing(draft) {
    const items=[],fields=componentFields(draft.definition.initialState)
    if(!fields.length)items.push({section:'fields',message:'尚未定义状态字段'})
    for(const [index,state] of draft.definition.openingStates.entries()) {
      if(state===null)items.push({section:'opening',openingId:'opening-'+index,message:'尚未填写此开场；可明确选择继承底稿再局部修改'})
      else for(const field of fields)if(!hasPath(state,field.path))items.push({section:'opening',openingId:'opening-'+index,path:field.path,message:'此开场缺少字段'})
    }
    if(!Object.values(draft.rules).some(text=>text.trim()))items.push({section:'rules',message:'尚未填写更新规则'})
    const appearance=draft.definition.appearance
    if(draft.appearanceRequirement==='custom'&&!(typeof appearance?.html==='string'&&appearance.html.trim()))items.push({section:'appearance',message:'需要自定义 HTML 设计；fields 基础面板不满足定制要求'})
    if(draft.appearanceRequirement==='preserve'&&!appearance?.sourcePath)items.push({section:'appearance',message:'需要指定原美化 sourcePath 与 bindings'})
    if(draft.appearanceRequirement==='basic'&&!appearance&&!draft.basicReason)items.push({section:'appearance',message:'基础面板需说明选择依据'})
    for(const key of ['sourceCoverage','cleanup','appearance'])if(!draft.review[key])items.push({section:'review',field:key,message:'尚未确认需求：'+key})
    return items
  }
  function summary(draft) {
    const issues=missing(draft)
    return {draftId:draft.id,draftRevision:draft.revision,saved:true,phase:draft.phase,sourcePath:draft.sourcePath,sourceRevision:draft.sourceRevision,targetPath:draft.targetPath,
      progress:{fields:componentFields(draft.definition.initialState).length,openings:draft.definition.openingStates.map((state,index)=>({openingId:'opening-'+index,sourcePath:index?'/alternate_greetings/'+(index-1):'/first_mes',filled:state!==null,missingFields:state===null?null:componentFields(draft.definition.initialState).filter(f=>!hasPath(state,f.path)).map(f=>f.path)})),appearanceRequirement:draft.appearanceRequirement,appearanceSaved:!!draft.definition.appearance},
      missing:issues.slice(0,40),missingCount:issues.length,
      ...(draft.intent?{pendingCommit:{requestId:draft.intent.requestId,definitionRevision:draft.intent.definitionRevision}}:{}),
      ...(draft.receipt?{receipt:draft.receipt}:{})}
  }
  async function fresh(draft) {
    const now=await conversion.convert({action:'inspect',sourcePath:draft.sourcePath,name:draft.name,detail:'summary'})
    if(now.sourceRevision!==draft.sourceRevision)fail('DRAFT_SOURCE_CHANGED','来源或世界书已变化；草稿保留，重新核对来源后建立新草稿',{sourceRevision:now.sourceRevision})
    return now
  }
  function definitionInput(draft) {
    return {...draft.definition,updateRules:Object.entries(draft.rules).map(([group,text])=>group==='既有规则'?text:group+'\n'+text).join('\n\n'),sourcePath:draft.sourcePath,sourceRevision:draft.sourceRevision}
  }
  async function check(draft) {
    const issues=missing(draft)
    const now=await fresh(draft)
    if(now.targetRevision!==draft.targetRevision)issues.push({section:'target',code:'DRAFT_TARGET_CHANGED',message:'目标已变化，不能覆盖；重新读取后建立新草稿'})
    if(issues.length)return {valid:false,issues}
    const input=definitionInput(draft)
    const report=await conversion.convert({...input,action:'preflight',cleanup:draft.cleanup})
    const blocking=report.issues.filter(issue=>!(draft.cleanupOrphanEntrances&&issue.code==='MVU_ORPHAN_ENTRANCE'))
    return {valid:blocking.length===0,issues:blocking,checks:report.checks}
  }
  async function begin(args) {
    requestKey(args)
    const sourcePath=normalizeResourcePath(args.sourcePath,'card')
    const identity={sourcePath,name:args.name||null,requestId:args.requestId}
    const id=hash(identity),requestHash=hash(args)
    // Replaying begin never discards an in-progress draft, even if its source changed.
    const previous=await resources.readMvuDraft(id)
    if(previous) {if(previous.beginHash!==requestHash)fail('DRAFT_REQUEST_REUSED','同一 requestId 不能用于不同参数');return summary(previous)}
    const info=await conversion.convert({action:'inspect',sourcePath,name:args.name,detail:'full'})
    if(info.target?.externallyModified||info.target?.error)fail('DRAFT_TARGET_CHANGED','已有副本包含方案外修改；先核对，不能覆盖')
    const meta=info.existingTarget?.extensions?.[MVU_CONVERSION_KEY]
    if(info.existingTarget&&(!meta?.definitionRevision||meta.sourcePath!==sourcePath||meta.sourceRevision!==info.sourceRevision))fail('DRAFT_TARGET_UNSUPPORTED','已有副本缺少当前来源的完整定义；需先核对转换方案')
    const saved=meta?await resources.readMvuDefinition(meta.definitionRevision):null
    if(meta&&(!saved||hash(saved)!==meta.definitionRevision))fail('DRAFT_DEFINITION_INVALID','已保存定义缺失或被改动')
    const requirement=args.appearanceRequirement||(info.appearanceSources.some(x=>x.enabled)?'preserve':saved?.appearance?.sourcePath?'preserve':'custom')
    if(!['custom','preserve','basic'].includes(requirement))fail('DRAFT_REQUIREMENT_INVALID','无效美化要求')
    if(requirement==='basic'&&!(typeof args.basicReason==='string'&&args.basicReason.trim()))fail('DRAFT_REQUIREMENT_INVALID','选择基础面板需说明用户要求或设计回退依据')
    const initial={id,beginHash:requestHash,revision:1,phase:'editing',sourcePath,sourceRevision:info.sourceRevision,targetPath:info.targetPath,targetRevision:info.targetRevision,name:info.targetPath.slice(6,-5),appearanceRequirement:requirement,basicReason:args.basicReason||'',
      definition:{initialState:saved?.initialState||{},openingStates:saved?.openingStates||Array.from({length:info.capabilities.openingCount},()=>null),sourceFields:saved?.sourceFields||[],fieldMappings:saved?.mappings||[],...(saved?.appearance?{appearance:saved.appearance}:{}),displayFields:saved?.displayFields||[]},
      rules:saved?{既有规则:saved.updateRules}:{},cleanup:meta?.cleanup||[],cleanupOrphanEntrances:false,review:{},requests:{},intent:null,receipt:null}
    const draft=await resources.updateMvuDraft(id,current=>{
      if(current&&current.beginHash!==requestHash)fail('DRAFT_REQUEST_REUSED','同一 requestId 不能用于不同参数')
      return current||initial
    })
    return {...summary(draft),sourceCatalog:info.catalog,reading:conversionReading(info.card),stateInventory:info.stateInventory,appearanceSources:info.appearanceSources,instruction:'先按组 patch fields，再逐个 opening 填初值；read 按需读草稿，来源原文用转换工具按 sourceRevision 读取。草稿保存不代表成品已提交。'}
  }
  function patch(draft,args) {
    if(draft.phase!=='editing')fail('DRAFT_NOT_EDITABLE','草稿正在提交或已提交；提交中请用原 requestId 重试，已完成请 begin 新草稿')
    const section=args.section,values=args.values
    if(section==='fields')setValues(draft.definition.initialState,values)
    else if(section==='opening') {
      const index=draft.definition.openingStates.findIndex((_,i)=>args.openingId==='opening-'+i)
      if(index<0)fail('DRAFT_OPENING_INVALID','openingId 不存在')
      const state=args.inheritInitialState===true?structuredClone(draft.definition.initialState):structuredClone(draft.definition.openingStates[index]||{})
      if(values!==undefined)setValues(state,values)
      else if(args.inheritInitialState!==true)fail('DRAFT_VALUES_INVALID','请提交本开场初值或明确继承底稿')
      draft.definition.openingStates[index]=state
    } else if(section==='rules') {
      if(!isObject(values)||!Object.keys(values).length||Object.values(values).some(x=>typeof x!=='string'))fail('DRAFT_VALUES_INVALID','rules values 是分组名到规则文本的对象；空文本删除该组')
      for(const [key,value] of Object.entries(values)) {if(['__proto__','prototype','constructor'].includes(key))fail('DRAFT_PATH_INVALID','无效分组名');if(value.trim())draft.rules[key]=value;else delete draft.rules[key]}
    } else if(section==='appearance') {
      if(!isObject(values))fail('DRAFT_VALUES_INVALID','appearance values 必须是完整外观方案')
      draft.definition.appearance=structuredClone(values)
    } else if(section==='mapping') {
      if(!isObject(values)||Object.keys(values).some(key=>!['sourceFields','fieldMappings'].includes(key))||Object.values(values).some(x=>!Array.isArray(x)))fail('DRAFT_VALUES_INVALID','mapping 仅接收 sourceFields、fieldMappings 数组')
      Object.assign(draft.definition,structuredClone(values))
    } else if(section==='cleanup') {
      if(!Array.isArray(values))fail('DRAFT_VALUES_INVALID','cleanup values 必须是清理操作数组；替换草稿中完整清理清单')
      draft.cleanup=structuredClone(values)
      draft.cleanupOrphanEntrances=args.cleanupOrphanEntrances===true
    } else if(section==='requirements') {
      if(!isObject(values)||Object.keys(values).some(key=>!['appearanceRequirement','basicReason'].includes(key))||!['custom','preserve','basic'].includes(values.appearanceRequirement))fail('DRAFT_REQUIREMENT_INVALID','requirements 需明确 appearanceRequirement')
      if(values.appearanceRequirement==='basic'&&!(typeof values.basicReason==='string'&&values.basicReason.trim()))fail('DRAFT_REQUIREMENT_INVALID','选择基础面板需说明用户要求或设计回退依据')
      draft.appearanceRequirement=values.appearanceRequirement
      draft.basicReason=typeof values.basicReason==='string'?values.basicReason:''
    } else if(section==='review') {
      if(!isObject(values)||Object.keys(values).some(key=>!['sourceCoverage','cleanup','appearance'].includes(key))||Object.values(values).some(x=>typeof x!=='boolean'))fail('DRAFT_VALUES_INVALID','review 仅接收 sourceCoverage、cleanup、appearance 的布尔确认')
      Object.assign(draft.review,values)
    } else fail('DRAFT_SECTION_INVALID','未知草稿分组')
    if(section!=='review')draft.review={}
  }
  async function run(args) {
    if(args.action==='begin')return begin(args)
    let draft=await resources.readMvuDraft(args.draftId)
    if(!draft)fail('DRAFT_NOT_FOUND','草稿不存在，请 begin')
    if(args.action==='read') {
      if(args.draftRevision!==undefined&&args.draftRevision!==draft.revision)fail('DRAFT_REVISION_CONFLICT','草稿版本已变化',{draftRevision:draft.revision})
      return {...summary(draft),...(args.path!==undefined?{reading:readConversionValue(draft,{path:args.path,offset:args.offset,limit:args.limit})}:{})}
    }
    if(args.action==='validate') {
      if(args.draftRevision!==draft.revision)fail('DRAFT_REVISION_CONFLICT','验证需携带当前草稿版本',{draftRevision:draft.revision})
      return {...summary(draft),validation:await check(draft)}
    }
    if(!['patch','commit'].includes(args.action))fail('DRAFT_ACTION_INVALID','action 必须为 begin/read/patch/validate/commit')
    const key=requestKey(args),requestHash=hash(args)
    // Persist commit intent before publication. A crash or lost response can be
    // resumed with the same request, using apply's content-addressed idempotency.
    draft=await resources.updateMvuDraft(args.draftId,async current=>{
      if(!current)fail('DRAFT_NOT_FOUND','草稿不存在')
      const replay=current.requests[key]
      if(replay) {if(replay.hash!==requestHash)fail('DRAFT_REQUEST_REUSED','同一 requestId 不能用于不同参数');return current}
      if(current.intent) {
        if(current.intent.hash!==requestHash)fail('DRAFT_COMMIT_PENDING','存在待完成提交；请用 pendingCommit.requestId 和原参数重试')
        return current
      }
      if(args.draftRevision!==current.revision)fail('DRAFT_REVISION_CONFLICT','草稿已变化，请 read 后提交局部修改',{draftRevision:current.revision})
      if(current.phase!=='editing')fail('DRAFT_NOT_EDITABLE','草稿已提交，请 begin 新草稿')
      await fresh(current)
      if(args.action==='patch') {patch(current,args);current.revision++;current.requests[key]={hash:requestHash,revision:current.revision};return current}
      const validation=await check(current)
      if(!validation.valid)fail('DRAFT_INCOMPLETE','草稿未通过检查；已保存内容保留，不写成品',{saved:true,committed:false,issues:validation.issues})
      const saved=await conversion.convert({...definitionInput(current),action:'saveDefinition'})
      const preview=await conversion.convert({action:'preview',sourcePath:current.sourcePath,sourceRevision:current.sourceRevision,name:current.name,
        ...(current.targetRevision?{targetRevision:current.targetRevision}:{}),definitionRevision:saved.definitionRevision,
        planMode:'replace',cleanup:current.cleanup,cleanupOrphanEntrances:current.cleanupOrphanEntrances})
      if(!preview.validation.valid)fail('DRAFT_INCOMPLETE','生成校验未通过；草稿保留，不写成品',{saved:true,committed:false,issues:preview.validation.checks.filter(x=>x.status==='failed')})
      current.intent={requestId:args.requestId,hash:requestHash,definitionRevision:saved.definitionRevision}
      current.phase='committing'
      return current
    })
    if(args.action==='patch'||draft.requests[key])return summary(draft)
    // The lock also protects simultaneous identical commit retries.
    draft=await resources.updateMvuDraft(args.draftId,async current=>{
      if(current.requests[key])return current
      if(current.intent?.hash!==requestHash)fail('DRAFT_COMMIT_PENDING','提交意图已变化')
      await fresh(current)
      const result=await conversion.convert({action:'apply',sourcePath:current.sourcePath,sourceRevision:current.sourceRevision,name:current.name,
        ...(current.targetRevision?{targetRevision:current.targetRevision}:{}),definitionRevision:current.intent.definitionRevision,
        planMode:'replace',cleanup:current.cleanup,cleanupOrphanEntrances:current.cleanupOrphanEntrances})
      current.receipt={committed:true,committedAt:new Date().toISOString(),definitionRevision:current.intent.definitionRevision,...result}
      current.phase='committed';current.revision++;current.intent=null
      current.requests[key]={hash:requestHash,revision:current.revision}
      return current
    })
    return summary(draft)
  }
  return {run:async args=>{
    try {return await run(args)}
    catch(error) {
      const draft=args.draftId?await resources.readMvuDraft(args.draftId).catch(()=>undefined):undefined
      error.code ||= 'DRAFT_OPERATION_FAILED'
      error.details={saved:!!draft,commitState:draft?.receipt?'committed':draft?.intent?'unknown':'not-started',
        ...(draft?{draftId:draft.id,draftRevision:draft.revision,phase:draft.phase}:{}),
        hint:draft?.intent?'成品提交结果可能尚未记录；请用原 commit 参数与 requestId 重试，不直接改写成品。':'草稿中已保存的部分保留；按错误位置修改后继续。',...error.details}
      throw error
    }
  }}
}
