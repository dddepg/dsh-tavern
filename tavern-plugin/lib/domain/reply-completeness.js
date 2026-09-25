// A provider can end a foreground stream with an ordinary `stop` while the body
// is still cut mid-sentence: a channel-side output cap, a gateway idle timeout or
// an upstream safety cut all report `stop`, and only an explicit cap reports
// `max-tokens`. DSH records such a turn as `completed`, so the tavern layer is
// the only place that can tell a finished reply from a half sentence. Judging it
// before the Round is committed keeps the failed tail — and its replay entry —
// instead of freezing a half sentence into the saved story.

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

// Characters that can legitimately end a finished reply: CJK sentence marks,
// closing quotes and brackets, ASCII terminators, markdown emphasis, and the
// trailing dashes prose uses to trail off.
const COMPLETE_TAIL = new Set([
  '。', '！', '？', '…', '～', '♪',
  '”', '’', '」', '』', '》', '〉', '】', '）',
  ')', ']', '}', '>', '"', "'", '`',
  '.', '!', '?',
  '*', '_', '~', '—', '－', '-'
])

// Marks that only ever continue a sentence: stopping on one — or on an opening
// quote or bracket — means the stream was cut mid-phrase even though the cut
// landed between characters.
const UNFINISHED_TAIL = new Set([
  '，', '、', '；', '：', ',', ';', ':',
  '「', '『', '“', '‘', '（', '(', '《', '【', '[', '{'
])

export const TRUNCATED_REPLY_CODE = 'truncated-response'

/** Provider finish kind recorded in an assistant event's replayable stream. */
export function streamFinishKind(stream) {
  const entries = Array.isArray(stream) ? stream : []
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const chunk = entries[index] && entries[index].chunk
    if (!chunk || chunk.type !== 'finish') continue
    return str(chunk.reason && chunk.reason.kind)
  }
  return ''
}

/** Whether visible reply text stops on a character that cannot end a reply. */
export function incompleteReplyTail(text) {
  const trimmed = str(text).trim()
  if (trimmed === '') return false
  const last = Array.from(trimmed).pop()
  if (UNFINISHED_TAIL.has(last)) return true
  if (COMPLETE_TAIL.has(last)) return false
  // Anything else — an emoji, a stray symbol — is a deliberate ending. Only a
  // word character reports the cut-off point a stream actually stops on.
  return /[\p{L}\p{N}]/u.test(last)
}

/**
 * Judge one finished foreground reply before it is committed as a Round.
 * Returns null when the reply is usable, or the failure to report otherwise.
 * Only explicit terminal finishes are judged: a tool-call step or an unknown
 * finish kind carries its own DSH handling and must not be failed here.
 */
export function truncatedForegroundReply(input = {}) {
  const text = str(input.text)
  // An empty reply has its own failure path; do not judge the tail twice.
  if (text.trim() === '') return null
  const finishKind = str(input.finishKind)
  if (finishKind === 'max-tokens') {
    return Object.freeze({
      code: TRUNCATED_REPLY_CODE,
      finishKind,
      message: '模型输出达到 token 上限被截断，本轮未提交；请重新生成本轮正文。'
    })
  }
  if (finishKind !== 'stop') return null
  if (!incompleteReplyTail(text)) return null
  return Object.freeze({
    code: TRUNCATED_REPLY_CODE,
    finishKind,
    message: '模型输出在正文中途中断（结尾不完整），本轮未提交；请重新生成本轮正文。'
  })
}
