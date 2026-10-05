import { boundedCompaction } from './bounded-compaction.js'
import { markRequestHandled, requestHandledBy } from './request-lineage.js'

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

/**
 * The single Tavern hook for summary requests. Every rewrite of the request
 * (metadata projection, then `prepare`, e.g. the story prompt) is applied here as
 * a plain transformation; only the final summarizer calls re-enter llm/stream.
 * Separate re-dispatching hooks previously re-processed each other's copies
 * (#146) and collided on their lineage marks (#148).
 */
export function installCompactionRequestProjection(ctx, ownsSession, prepare = async request => request) {
  // Segment requests re-enter llm/stream; copies other hooks make of them stay internal.
  const stream = request => ctx.llm.stream(markRequestHandled(request, 'compaction-projection'))
  ctx.on('llm/stream', (request, next) => {
    if (requestHandledBy(request, 'compaction-projection') || request?.purpose !== 'compaction' || !request.sessionId) return next()
    return (async function * () {
      if (!(await ownsSession(request.sessionId))) { yield* next(); return }
      yield* boundedCompaction(ctx, await prepare(projectCompactionRequest(request)), stream)
    })()
  })
}
