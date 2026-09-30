import { synchronizeBodyEdits } from '../domain/body-editor.js'
import { synchronizeTemplateHistory } from '../domain/template-history.js'

export function registerRequestHooks({
  backgroundAgentRunner,
  cardMemory,
  chatForSession,
  ctx,
  foregroundStrategies,
  persistClearedBodyEdits,
  requestCoordinates,
  requestIdForMessages,
  sessionStore,
  tavernRetryLimiter,
}) {
  ctx.on('agent/request', async function (payload, next) {
    const sessionId = payload.agent && payload.agent.session ? payload.agent.session.id : ''
    if (sessionId !== '') requestCoordinates.set(sessionId, { turn: payload.turn, step: payload.step })
    return await next()
  })

  ctx.on('agent/request-error', tavernRetryLimiter.handle, { prepend: true })

  ctx.on('agent/pre-step', async function (payload, next) {
    const sessionId = payload.agent && payload.agent.session ? payload.agent.session.id : ''
    if (backgroundAgentRunner.owns(sessionId)) return next()
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const chat = await chatForSession(sessionId)
    if (chat) await synchronizeTemplateHistory(payload.agent.session, chat, session => sessionStore.flush(session))
    if (chat) await synchronizeBodyEdits(payload.agent.session, chat, session => sessionStore.flush(session), persistClearedBodyEdits)
    const prepared = await foregroundStrategies.prepareStep({
      sessionId,
      payload,
      decision,
      chat,
      requestId: requestIdForMessages(payload.messages)
    })
    try { return await cardMemory.appendRecall({ chat, payload, decision: prepared }) }
    catch (error) { console.warn('[Tavern card memory] recall unavailable:', error.message); return prepared }
  })
}
