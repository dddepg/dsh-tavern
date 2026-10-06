import { createScopedMessages } from './scoped-messages.js'
import { lastTavernHelperVariables } from './tavern-helper-context.js'

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
 * complete Chat. Pages backwards on one pinned revision until the window holds
 * `storyRows` story floors (a number, or computed from the header), the latest
 * reply when `lastAssistant`, and the latest variable floor when
 * `lastVariables` (located through the storage's world index, not a scan),
 * and whatever `enough(rows)` asks for; `include` names further floors.
 * Rows outside the window read as holes. Undefined means only the complete
 * reader is safe: legacy or unadopted stories, non-native storage, an unknown
 * depth, or a window above `maxRows`.
 */
export function createBoundedHistory({ links, readWindow, pageSize = 48, maxRows = 2000 }) {
  async function read(chatId, sessionId, { storyRows = 0, lastAssistant = false, lastVariables = false, enough = () => true, include = [], revision } = {}) {
    const first = await readWindow(chatId, { limit: pageSize, includeCheckpoints: true })
    const head = first?.chat
    if (!head || (revision !== undefined && first.revision !== revision) || (sessionId !== undefined && head.sessionId !== sessionId) || head.backgroundConfigVersion !== 1
      || head.conversationFeaturesVersion !== 1 || legacyStory(head)) return undefined
    const depth = typeof storyRows === 'function' ? await storyRows(head) : storyRows
    if (!Number.isSafeInteger(depth) || depth < 0) return undefined
    let rows = head.messages, from = first.from
    const satisfied = () => scannedStoryRows(rows, depth) && (!lastAssistant || rows.some(row => row?.role === 'assistant')) && enough(rows)
    while (from > 0 && !satisfied()) {
      if (rows.length >= maxRows) return undefined
      const page = await readWindow(chatId, { limit: Math.min(500, Math.max(pageSize, rows.length)), before: from, revision: first.revision, fields: ['_storageRevision'] })
      if (!page || page.revision !== first.revision || page.to !== from - 1) return undefined
      rows = page.chat.messages.concat(rows)
      from = page.from
    }
    const entries = rows.map((row, index) => [from + index, row])
    if (lastVariables && from > 0 && lastTavernHelperVariables(rows) === undefined) {
      const position = first.worldMessage
      if (position === undefined) return undefined
      if (position !== null) {
        if (position >= from) return undefined
        const page = await readWindow(chatId, { limit: 1, before: position + 1, revision: first.revision, fields: ['_storageRevision'] })
        const row = page?.revision === first.revision ? page.chat.messages[0] : undefined
        if (!row || row.role === 'tavern-helper' || lastTavernHelperVariables([row]) === undefined) return undefined
        entries.unshift([position, row])
      }
    }
    // Named floors outside the window, read on the same revision.
    for (const position of new Set(include)) {
      if (!Number.isSafeInteger(position) || position < 0 || position >= first.messageCount) return undefined
      if (position >= from || entries.some(([at]) => at === position)) continue
      const page = await readWindow(chatId, { limit: 1, before: position + 1, revision: first.revision, fields: ['_storageRevision'] })
      if (page?.revision !== first.revision || !page.chat.messages[0]) return undefined
      entries.unshift([position, page.chat.messages[0]])
    }
    const { messages: _rows, ...header } = head
    return {
      chat: { ...header, messages: createScopedMessages(first.messageCount, entries) },
      messageCount: first.messageCount, from, revision: first.revision
    }
  }
  return Object.freeze({
    read,
    async forSession(sessionId, need) {
      const chatId = (await links())[sessionId]
      return chatId ? read(chatId, sessionId, need) : undefined
    }
  })
}
