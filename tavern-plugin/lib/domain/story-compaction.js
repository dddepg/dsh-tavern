import { sessionEvents } from './session-events.js'

export function usesStoryCompaction(chat) {
  return chat !== null && typeof chat === 'object' && (chat.mode === 'story' || chat.mode === 'script')
}

export function createStoryCompactionRequest(options, instruction) {
  if (options === null || typeof options !== 'object' || options.purpose !== 'compaction') return options
  if (!Array.isArray(options.messages) || options.messages.length === 0) return options
  if (typeof instruction !== 'string' || instruction.trim() === '') throw new TypeError('剧情压缩提示词不能为空')

  const lastIndex = options.messages.length - 1
  const message = options.messages[lastIndex]
  const source = message && message.source
  if (message === null || typeof message !== 'object' || message.role !== 'user' ||
    source === null || typeof source !== 'object' || source.plugin !== 'dsh-compaction-basic') return options

  const messages = options.messages.slice()
  messages[lastIndex] = Object.freeze(Object.assign({}, message, {
    content: Object.freeze([Object.freeze({ type: 'text', text: instruction })])
  }))
  return Object.freeze(Object.assign({}, options, { messages: Object.freeze(messages) }))
}

// Story compaction keeps the latest rounds verbatim. DSH's idle (manual) compaction
// can only retain the final surface node, so the older history is summarized and
// these rounds are appended to the summary as an original-text transcript.
export const RETAINED_STORY_ROUNDS = 10

const textOf = message => (Array.isArray(message?.content) ? message.content : [])
  .filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim()
const isPlayerMessage = message => message?.role === 'user' && message.source?.kind !== 'plugin' && textOf(message) !== ''

/**
 * Player rounds the native engine already keeps outside this request: automatic
 * pressure compaction retains its own recent tail, which counts toward the quota.
 */
export function nativelyRetainedRounds(session, request) {
  const nodes = session?.surface?.nodes
  if (!nodes || !Array.isArray(request?.messages)) return 0
  const inRequest = new Set(request.messages.map(message => message?.id).filter(Boolean))
  const bySeq = typeof session.eventAt === 'function' ? null : new Map(sessionEvents(session).map(event => [event.seq, event]))
  let count = 0
  for (const seq of nodes) {
    const event = bySeq ? bySeq.get(seq) : session.eventAt(seq)
    if (event?.type === 'user/message' && !inRequest.has(event.data?.id) && isPlayerMessage(event.data)) count++
  }
  return count
}

/**
 * Split a story compaction request: the summarizer sees only history older than
 * the latest `rounds` player rounds; those rounds come back as `appendix` text.
 * Returns `{ request }` unchanged when there is nothing to retain.
 */
export function retainRecentStoryRounds(request, rounds = RETAINED_STORY_ROUNDS) {
  if (rounds <= 0 || request?.purpose !== 'compaction' || !Array.isArray(request.messages) || request.messages.length < 2) return { request }
  const history = request.messages.slice(0, -1)
  const starts = history.flatMap((message, index) => isPlayerMessage(message) ? [index] : [])
  if (starts.length === 0) return { request }
  const cut = starts[Math.max(0, starts.length - rounds)]
  if (!history.slice(0, cut).some(message => message.role !== 'system')) {
    throw new Error(`最近 ${rounds} 轮之前没有可压缩的历史，暂不需要压缩`)
  }
  const transcript = history.slice(cut).filter(message => message.role !== 'system').flatMap(message => {
    const text = textOf(message)
    return text === '' ? [] : [(message.role === 'user' ? '[玩家]\n' : '[正文]\n') + text]
  })
  return {
    request: { ...request, messages: [...history.slice(0, cut), ...history.slice(cut).filter(message => message.role === 'system'), request.messages.at(-1)] },
    appendix: `【最近 ${Math.min(rounds, starts.length)} 轮原文（未压缩，按时间顺序）】\n\n` + transcript.join('\n\n')
  }
}
