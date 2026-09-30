import { createImportContextPreparation, needsImportContextPreparation } from '../domain/import-context-preparation.js'
import { createStoryCompactionRequest, usesStoryCompaction } from '../domain/story-compaction.js'
import { installCompactionRequestProjection } from '../domain/compaction-request.js'
import { installWorkspaceInstructionPresentation } from '../domain/workspace-instruction-presentation.js'
import { presentModelError } from '../domain/model-error-presentation.js'

export function registerModelStreamHooks({
  agentRegistry,
  backgroundAgentRunner,
  chatForSession,
  chatHeaderForSession,
  ctx,
  foregroundStrategies,
  fullTemplateRuntime,
  modelRequestLog,
  requestCoordinates,
  runtimePrompt,
  sessionStateForSession,
  sessionStore,
  storyCompactionRequests,
  str,
  updateChat,
  worldbookRecallLog,
}) {
  const importContextPreparation = createImportContextPreparation({
    readChat: chatForSession, updateChat,
    getSession: id => sessionStore.get(id) || agentRegistry.get(id)?.session,
    flush: session => sessionStore.flush(session),
    modelInfo: request => ctx.llm.resolveModelInfo(request.provider, request.model, request.signal),
    estimateMessage: message => {
      const meter = ctx.get('tokenMeter')
      if (!meter?.estimateMessage) throw new Error('当前宿主缺少原生 token 计量接口，请更新 DSH 后重试')
      const native = meter.estimateMessage(message)
      // The host's fixed four-characters/token estimate underprices CJK text.
      // Use a conservative Unicode floor for this one-time admission check.
      const text = (message.content || []).map(block => block.text || JSON.stringify(block)).join('')
      const nonAscii = [...text].filter(char => char.codePointAt(0) > 127).length
      return Math.max(native, Math.ceil((text.length - nonAscii) / 4) + nonAscii * 2 + 8)
    }
  })
  const fullTemplateRequests = new WeakMap()
  installWorkspaceInstructionPresentation(ctx, async sessionId => {
    if (backgroundAgentRunner.owns(sessionId)) return true
    const chat = await sessionStateForSession(sessionId)
    return Boolean(chat)
  })
  installCompactionRequestProjection(ctx, async sessionId => backgroundAgentRunner.owns(sessionId) || Boolean(await sessionStateForSession(sessionId)))

  ctx.on('llm/stream', function (options, next) {
    const sessionId = str(options && options.sessionId)
    const coordinates = requestCoordinates.get(sessionId)
    if (coordinates !== undefined) {
      requestCoordinates.set(sessionId, Object.assign({}, coordinates, {
        source: { kind: 'model', provider: str(options.provider), model: str(options.model) }
      }))
    }
    if (options !== null && typeof options === 'object' && options.purpose === 'compaction' && !storyCompactionRequests.has(options)) {
      const fallback = next()
      return (async function * () {
        const chat = await chatForSession(sessionId)
        if (!usesStoryCompaction(chat)) {
          yield * fallback
          return
        }
        if (needsImportContextPreparation(chat)) throw new Error('导入对话尚未完成首次上下文容量检查，暂不调用摘要模型')
        const request = createStoryCompactionRequest(options, runtimePrompt('story-compaction'))
        if (request === options) {
          yield * fallback
          return
        }
        storyCompactionRequests.add(request)
        yield * ctx.llm.stream(request)
      })()
    }
    const projectedRequest = (fullTemplateRequests.has(options) || importContextPreparation.isPrepared(options)) ? null : foregroundStrategies.projectRequest(options, coordinates)
    if (projectedRequest !== null) return ctx.llm.stream(projectedRequest)
    const stream = next()
    const backgroundContext = backgroundAgentRunner.requestContext(sessionId)
    const ownerSessionId = backgroundContext ? backgroundContext.parentSessionId : sessionId
    return (async function * () {
      const prepared = await importContextPreparation.prepare(options)
      if (prepared !== options) { yield * ctx.llm.stream(prepared); return }
      const chat = ownerSessionId === '' ? undefined : await chatHeaderForSession(ownerSessionId, [
        'requestMode', 'compatibilityTraces', 'bypassPlanId', 'runtimePresetSnapshot', 'foregroundFrames'
      ])
      if (chat && ['story', 'script'].includes(chat.mode) && options.purpose === undefined && chat.requestMode !== 'sillytavern' && !fullTemplateRequests.has(options)) {
        const projected = await fullTemplateRuntime.forSession(ownerSessionId).projectRequestProjection({ messages: options.messages, system: options.system, model: options.model })
        const templated = { ...options, ...projected }
        fullTemplateRequests.set(templated, options)
        yield * ctx.llm.stream(templated)
        return
      }
      let requestRecord = null
      if (options.purpose === undefined && chat !== undefined && ['story', 'script', 'card'].includes(chat.mode)) {
        const coordinates = requestCoordinates.get(sessionId) || {}
        requestRecord = await modelRequestLog.record({ chat, context: backgroundContext, coordinates, options })
        if (!backgroundContext && ['story', 'script'].includes(chat.mode)) {
          try { await worldbookRecallLog.requested(chat, options, requestRecord.id) }
          catch (error) { console.warn('dsh-tavern: 世界书请求日志关联失败', String(error?.message || error)) }
        }
      }
      let responseText = ''
      let finish = null
      let failure = null
      try {
        for await (const chunk of stream) {
          if (chunk && chunk.type === 'text-delta') responseText += str(chunk.text)
          if (chunk && chunk.type === 'finish') finish = chunk.reason === undefined ? chunk : chunk.reason
          yield chunk
        }
      } catch (error) {
        const displayedError = chat ? presentModelError(error) : error
        failure = str(displayedError && displayedError.message || displayedError)
        throw displayedError
      } finally {
        const completed = finish && finish.kind !== 'error' && finish.kind !== 'aborted'
        foregroundStrategies.completeRequest(fullTemplateRequests.get(options) || options, completed)
        if (chat && requestRecord) {
          try { await modelRequestLog.complete({ chatId: chat.id, id: requestRecord.id, text: responseText, finish, error: failure }) }
          catch (error) { console.error('dsh-tavern: 模型结果日志写入失败', str(error && error.message || error)) }
        }
      }
    })()
  }, { global: true })
}
