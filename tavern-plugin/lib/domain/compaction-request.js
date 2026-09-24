import { boundedCompaction } from './bounded-compaction.js'

// Internal metadata-only events are persisted on the Session surface but are
// not user utterances. Native compaction replays that surface independently of
// the normal request projection, so omit them at this request boundary too.
export function projectCompactionRequest(request) {
  if (request?.purpose !== 'compaction' || !Array.isArray(request.messages)) return request
  const messages = request.messages.filter(message => !(message?.role === 'user' &&
    Array.isArray(message.content) && message.content.length === 0 &&
    message.source?.kind === 'plugin' &&
    ['dsh-tavern', 'dsh-tavern-failed-turn-cleanup'].includes(message.source.plugin)))
  return messages.length === request.messages.length ? request : { ...request, messages }
}

export function installCompactionRequestProjection(ctx, ownsSession) {
  const internal = new WeakSet()
  const stream = request => {
    internal.add(request)
    return ctx.llm.stream(request)
  }
  ctx.on('llm/stream', (request, next) => {
    if (internal.has(request) || request?.purpose !== 'compaction' || !request.sessionId) return next()
    return (async function * () {
      if (!(await ownsSession(request.sessionId))) { yield* next(); return }
      const projected = projectCompactionRequest(request)
      yield* boundedCompaction(ctx, projected, stream)
    })()
  })
}
