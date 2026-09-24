// Detached inputs for session activity and cache-hit volatile view fields only.
// This is not a writable Chat or a source for rebuilding history projections.
export function projectChatSessionState(chat) {
  // Legacy timeline inspection migrates a foreground body using its full text.
  if (Object.values(chat.timeline?.operations || {}).some(operation =>
    operation?.kind === 'body' && operation.status === 'foreground-completed')) return structuredClone(chat)
  const selected = {}
  for (const key of ['id', 'sessionId', '_storageRevision', 'mode', 'cardPath', 'cardContextRevision',
    'backgroundConfigVersion', 'conversationFeaturesVersion', 'updatedAt', 'timeline', 'candidateAgent',
    'settleError', 'scriptState', 'suppressedDshTurns', 'regeneratedDshTurns', 'tavernHelperLifecycleRevision']) {
    if (Object.hasOwn(chat, key)) selected[key] = chat[key]
  }
  if (chat.importHistory) selected.importHistory = {
    rescue: Boolean(chat.importHistory.rescue), operationId: chat.importHistory.operationId
  }
  if (chat.rollbackUndo) {
    const saved = chat.rollbackUndo
    selected.rollbackUndo = {
      version: saved.version, ready: saved.ready, branchId: saved.branchId, revision: saved.revision,
      lifecycleRevision: saved.lifecycleRevision, storageRevision: saved.storageRevision,
      turn: saved.turn, foreground: { afterCount: saved.foreground?.afterCount }
    }
  }
  selected.messages = (Array.isArray(chat.messages) ? chat.messages : []).map(message => {
    if (!message || typeof message !== 'object') return message
    return {
      role: message.role, turn: message.turn, greeting: message.greeting,
      ...(message.importSource ? { importSource: { operationId: message.importSource.operationId } } : {}),
      ...(message.mvu ? { mvu: {
        receipt: message.mvu.receipt, diagnostics: message.mvu.diagnostics,
        pending: message.mvu.pending, modified: message.mvu.modified
      } } : {})
    }
  })
  return structuredClone(selected)
}
