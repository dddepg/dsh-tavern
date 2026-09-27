import {createHash} from 'node:crypto'
import {draftError} from './mvu-draft-fields.js'

const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const short=value=>typeof value==='string'&&/^d[1-9]\d*$/.test(value)

// Session selection is separate from the draft itself. The remembered token is
// the observed version, never a fresh disk revision silently substituted at write.
export function createMvuDraftSession({resources,run}) {
  return async(args,context)=>{
    const sessionId=context?.sessionId
    const legacy=args.draftId!==undefined||args.draftRevision!==undefined||args.requestId!==undefined||(args.draft!==undefined&&!short(args.draft))
    if(legacy)return run(args,context)
    if(!sessionId){
      if(short(args.draft)||args.action!=='begin')draftError('DRAFT_SESSION_REQUIRED','当前调用缺少会话上下文，请从卡片工作台调用')
      return run(args,context)
    }
    let report,error
    const observed=await resources.readMvuDraftSession(sessionId)
    try {await resources.updateMvuDraftSession(sessionId,async stored=>{
      const state=stored||{current:null,drafts:{},calls:{}}
      let alias=args.action==='begin'?null:args.draft||state.current
      const fingerprint=hash(args),callKey=context.callId?hash(context.callId):null
      try {
        const previous=callKey&&state.calls[callKey]
        if(previous&&previous.fingerprint!==fingerprint)draftError('DRAFT_REQUEST_REUSED','同一工具调用不能改用其他参数')
        if(!previous&&(state.revision||0)!==(observed?.revision||0))draftError('DRAFT_SESSION_CHANGED','并发调用已改变当前草稿；请 read 后再修改')
        state.revision=(state.revision||0)+1
        let expanded
        if(previous){const {draft,...input}=args;expanded=previous.action==='begin'&&previous.token?{action:'read',draft:previous.token}:{...input,action:previous.action,...(previous.token?{draft:previous.token}:{})};alias=previous.alias}
        else if(args.action==='begin'){
          if(args.draft!==undefined)draftError('DRAFT_ARGUMENT_INVALID','begin 使用 sourcePath，不指定已有草稿编号')
          expanded={...args}
        }else{
          const entry=state.drafts[alias]
          if(!entry)draftError('DRAFT_NOT_SELECTED','尚未选择草稿；先 begin，或使用本会话返回的短编号',{drafts:Object.keys(state.drafts)})
          const {draft,...input}=args
          expanded={...input,draft:entry.token}
          // Repeating the same write after a lost response reuses its original
          // version even if the cursor already advanced. A read of a newer,
          // externally changed revision invalidates this implicit retry.
          if(['patch','commit'].includes(args.action)&&entry.lastWrite?.fingerprint===hash(input)&&entry.lastWrite.after===entry.token)expanded={...input,action:entry.lastWrite.action,draft:entry.lastWrite.token}
          else if(args.action==='commit'&&entry.phase==='committed')expanded={action:'read',draft:entry.token}
        }
        if(callKey&&!previous)state.calls[callKey]={fingerprint,action:expanded.action,token:expanded.draft||null,alias}
        const entry=state.drafts[alias]
        if(!previous&&entry&&['patch','commit'].includes(args.action)){
          const {draft,...input}=args
          entry.lastWrite={fingerprint:hash(input),action:expanded.action,token:expanded.draft,after:entry.token}
        }
        const result=await run(expanded,context)
        if(!alias){alias=Object.keys(state.drafts).find(key=>state.drafts[key].id===result.draftId)||'d'+(Object.keys(state.drafts).length+1)}
        const selected=state.drafts[alias]||{}
        // A delayed replay for an older transport call must not change which
        // draft subsequent implicit operations target.
        Object.assign(selected,{id:result.draftId,token:result.draft,phase:result.phase,sourcePath:result.sourcePath,targetPath:result.targetPath})
        if(!previous&&selected.lastWrite&&['patch','commit'].includes(args.action))selected.lastWrite.after=result.draft
        state.drafts[alias]=selected
        if(!previous)state.current=alias
        if(callKey){state.calls[callKey].alias=alias;if(args.action==='begin')state.calls[callKey].token=result.draft}
        report={...result,draft:alias}
        if(args.action==='read'&&args.path===undefined&&Object.keys(state.drafts).length>1)report.drafts=Object.entries(state.drafts).map(([draft,item])=>({draft,sourcePath:item.sourcePath,targetPath:item.targetPath,phase:item.phase}))
      }catch(caught){
        error=caught
        error.code ||= 'DRAFT_OPERATION_FAILED'
        // Failed writes do not advance the observed version. Explicit read is
        // required before another write can use an externally changed revision.
        error.details={...error.details,...(alias?{draft:alias}:{}),hint:error.details?.hint||'先 begin；已有草稿用 read 查看当前进度。'}
      }
      return state
    })}catch(caught){
      if(caught.code==='DSH_TAVERN_WRITE_CONFLICT')draftError('DRAFT_SESSION_CHANGED','当前会话还有另一项操作；请 read 后再修改')
      throw caught
    }
    if(error)throw error
    return report
  }
}
