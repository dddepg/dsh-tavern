import { createScopedMessages } from './scoped-messages.js'

const legacyStory = chat => Object.values(chat?.timeline?.operations || {}).some(operation =>
  operation?.kind === 'body' && operation.status === 'foreground-completed')

/** Story rows a world-book scan of `depth` reads: user/assistant floors, greetings excluded. */
export function scannedStoryRows(rows, depth) {
  let count = 0
  for (const row of rows) if ((row?.role === 'user' || row?.role === 'assistant') && row.greeting !== true) count++
  return count >= depth
}

/**
 * Recent history at its absolute floor positions, without materializing the
 * complete Chat. Pages backwards on one pinned revision until `enough(rows)`
 * holds or the opening is reached. Rows outside the window read as holes.
 * Undefined means only the complete reader is safe: legacy or unadopted
 * stories, non-native storage, or a window above `maxRows`.
 */
export function createBoundedHistory({ links, readWindow, pageSize = 48, maxRows = 2000 }) {
  return async function read(sessionId, { enough = () => true, includeCheckpoints = true } = {}) {
    const chatId = (await links())[sessionId]
    if (!chatId) return undefined
    const first = await readWindow(chatId, { limit: pageSize, includeCheckpoints })
    const head = first?.chat
    if (!head || head.sessionId !== sessionId || head.backgroundConfigVersion !== 1 || head.conversationFeaturesVersion !== 1 || legacyStory(head)) return undefined
    let rows = head.messages, from = first.from
    while (from > 0 && !enough(rows)) {
      if (rows.length >= maxRows) return undefined
      const page = await readWindow(chatId, { limit: Math.min(500, Math.max(pageSize, rows.length)), before: from, revision: first.revision, fields: ['_storageRevision'] })
      if (!page || page.revision !== first.revision || page.to !== from - 1) return undefined
      rows = page.chat.messages.concat(rows)
      from = page.from
    }
    const { messages: _rows, ...header } = head
    return {
      chat: { ...header, messages: createScopedMessages(first.messageCount, rows.map((row, index) => [from + index, row])) },
      messageCount: first.messageCount, from, revision: first.revision
    }
  }
}
