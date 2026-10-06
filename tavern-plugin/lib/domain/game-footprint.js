import { createHash } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { currentBackgroundSessionId, referencedBackgroundSessionIds } from './background-identity.js'

// One game's data lives in many places on disk. This is the single list of them:
// export packs from it, deletion cleans by it, and a new per-game store must be added here.
const sha = value => createHash('sha256').update(String(value)).digest('hex')
const str = value => typeof value === 'string' ? value : ''
const safeName = value => /^[a-zA-Z0-9_-]+$/.test(value)

/**
 * Categories:
 *   core       the save itself (chat storage and registrations); removed by the conversation registry
 *   product    player-visible results kept with the game (scene image records)
 *   subsession native DSH sessions of this game: foreground and every background/image agent
 *   log        audit logs and diagnostics that can be dropped
 *   cache      transient state rebuilt on demand
 */
export function createGameFootprint({ dataRoot, sessionsRoot = path.join(path.dirname(dataRoot), 'sessions') }) {
  const root = path.resolve(dataRoot)
  const file = relative => path.join(root, relative)

  async function readJson(relative) {
    try { return JSON.parse(await readFile(file(relative), 'utf8')) } catch { return null }
  }

  // Native sessions are stored under a directory derived from their working directory,
  // which differs between installs and old versions; find each id in every project.
  async function nativeSessionDirectories(ids) {
    const wanted = new Set(ids.filter(safeName))
    if (!wanted.size) return []
    let projects
    try { projects = await readdir(sessionsRoot, { withFileTypes: true }) } catch { return [] }
    const found = []
    for (const project of projects) {
      if (!project.isDirectory()) continue
      let entries
      try { entries = await readdir(path.join(sessionsRoot, project.name), { withFileTypes: true }) } catch { continue }
      for (const entry of entries) if (entry.isDirectory() && wanted.has(entry.name)) found.push({ id: entry.name, path: path.join(sessionsRoot, project.name, entry.name) })
    }
    return found
  }

  async function describe(chat) {
    const chatId = str(chat?.id)
    if (!safeName(chatId)) throw new Error('无效的游戏编号')
    const foreground = str(chat.sessionId)
    const sceneAgent = await readJson('scene-images/' + sha(chatId) + '/agent.json')
    const background = new Set([
      currentBackgroundSessionId(chat), ...referencedBackgroundSessionIds(chat),
      ...(Array.isArray(chat.backgroundHistoryIds) ? chat.backgroundHistoryIds : []),
      chat.candidates?.traceSessionId, ...(Array.isArray(chat.candidates?.traceSessionIds) ? chat.candidates.traceSessionIds : []),
      sceneAgent?.sessionId
    ].map(str).filter(id => id && id !== foreground))
    const sessionIds = [foreground, ...background].filter(Boolean)
    const items = []
    const add = (category, relative, kind = 'file') => items.push({ category, kind, path: file(relative) })
    add('product', 'scene-images/' + sha(chatId), 'dir')
    add('log', 'model-requests/' + chatId, 'dir')
    add('log', 'worldbook-recalls/' + chatId, 'dir')
    add('log', 'diagnostics/scene-' + sha(chatId) + '.json')
    add('log', 'diagnostics/scene-' + sha(chatId), 'dir')
    add('log', 'diffs/polish-' + chatId + '.html')
    const importOperation = str(chat.importHistory?.operationId)
    if (safeName(importOperation)) add('log', 'chat-imports/' + importOperation + '.json')
    add('cache', '.conversation-locks/' + chatId, 'dir')
    for (const id of sessionIds) {
      add('log', 'model-request-sessions/' + encodeURIComponent(id) + '.json')
      for (const kind of ['mvu', 'api-calls', 'compatibility']) add('log', 'diagnostics/' + kind + '-' + sha(id) + '.json')
      add('cache', 'template-work/' + sha(id) + '.json')
      if (safeName(id)) add('cache', 'session-prefixes/' + id + '.json')
    }
    for (const session of await nativeSessionDirectories(sessionIds)) {
      items.push({ category: 'subsession', kind: 'dir', path: session.path, sessionId: session.id, foreground: session.id === foreground })
    }
    return { chatId, foregroundSessionId: foreground, backgroundSessionIds: [...background], items }
  }

  // Everything except the core save, which the conversation registry removes first.
  async function removeLeftovers(footprint) {
    const failures = []
    for (const item of footprint.items) {
      if (item.category === 'core') continue
      const resolved = path.resolve(item.path)
      // Never follow a computed path out of the profile.
      if (!resolved.startsWith(root + path.sep) && !resolved.startsWith(path.resolve(sessionsRoot) + path.sep)) continue
      try { await rm(resolved, { recursive: true, force: true }) } catch (error) { failures.push({ path: resolved, error: String(error?.message || error) }) }
    }
    return { failures }
  }

  return Object.freeze({ describe, removeLeftovers })
}
