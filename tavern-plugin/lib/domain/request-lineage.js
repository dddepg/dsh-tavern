// llm/stream hooks re-dispatch rewritten requests as NEW objects, and other hooks
// copy them again ({ ...request }). An identity guard (WeakSet) recognizes only
// the exact object a hook created, so two re-dispatching hooks re-process each
// other's copies forever (issue #146: projection and workspace presentation
// ping-ponged until the host heap ran out). The lineage mark is an enumerable
// symbol property: spread/Object.assign copy it, JSON and providers never see it.
const HANDLED = Symbol.for('dsh-tavern.request-handled')

/** Record that `stage` produced this request (and so every copy derived from it). */
export function markRequestHandled(request, stage) {
  if (request === null || typeof request !== 'object') return request
  const previous = Array.isArray(request[HANDLED]) ? request[HANDLED] : []
  if (!previous.includes(stage)) request[HANDLED] = Object.freeze(previous.concat(stage))
  return request
}

/** True when `stage` already produced this request or an ancestor it was copied from. */
export function requestHandledBy(request, stage) {
  return request !== null && typeof request === 'object' && Array.isArray(request[HANDLED]) && request[HANDLED].includes(stage)
}
