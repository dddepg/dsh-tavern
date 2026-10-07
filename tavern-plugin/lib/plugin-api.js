import { publicPluginMedia, pluginMediaSession } from './domain/plugin-media.js'

// The public `tavern` service for third-party DSH plugins (docs/plugin-api.md).
// Only additive changes are allowed here: published plugins depend on every
// name and field. Internals are reached through `deps`, never exposed.
export const TAVERN_PLUGIN_API_VERSION = 1
const TRACKER = Symbol.for('cordis.tracker')
const SECTION_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_SECTION_TEXT = 8000

function ownerOf(service) {
  const ctx = service && service.ctx
  const fiber = ctx && (ctx[Symbol.for('cordis.shadow')] ? Object.getPrototypeOf(ctx) : ctx).fiber
  const name = String(fiber && fiber.name || '').trim()
  if (!name || name === 'root') throw new Error('请在插件里通过 ctx.inject 取得 tavern 服务，并以 tavern.方法名() 的形式调用')
  return name
}

/** Register through the caller's Cordis fiber so plugin unload disposes it. */
function owned(service, register, label) {
  const ctx = service && service.ctx
  return ctx && typeof ctx.effect === 'function' ? ctx.effect(register, label) : register()
}

function positiveTurn(value) {
  const turn = Number(value)
  if (!Number.isSafeInteger(turn) || turn < 1) throw new Error('turn 必须是正整数')
  return turn
}

function gameIdOf(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('gameId 必须是非空字符串')
  return value
}

export function createTavernPluginApi(deps) {
  const settledHandlers = new Set()
  const removedHandlers = new Set()
  const sections = new Map()
  const notified = new Set()
  const log = deps.logger || console

  function dispatch(handlers, payload, label) {
    for (const entry of Array.from(handlers)) {
      Promise.resolve().then(() => entry.handler(structuredClone(payload))).catch(error => {
        log.warn?.('dsh-tavern: 插件 ' + entry.owner + ' 的 ' + label + ' 处理失败: ' + String(error?.message || error))
      })
    }
  }

  async function requireTurn(gameId, turn) {
    const material = await deps.readTurn(gameIdOf(gameId), positiveTurn(turn))
    if (!material) throw Object.assign(new Error('这一轮不存在或还没写完'), { code: 'TAVERN_PLUGIN_TURN_UNAVAILABLE' })
    return material
  }

  function snapshotOf(material) {
    return {
      gameId: material.sessionId, turn: material.turn, textVersion: material.key,
      text: material.text, rawText: material.source,
      card: { id: material.card.path, name: material.card.name }
    }
  }

  async function locateItem(itemId) {
    const sessionId = pluginMediaSession(itemId)
    const game = sessionId ? await deps.resolveGame(sessionId) : null
    if (!game) throw Object.assign(new Error('媒体项不存在或不属于本插件'), { code: 'TAVERN_PLUGIN_NOT_FOUND' })
    return game
  }

  async function changed(gameId) {
    try { deps.publish(gameId) } catch {}
  }

  const service = {
    ctx: deps.ctx,
    apiVersion: TAVERN_PLUGIN_API_VERSION,

    onTurnSettled(handler) {
      if (typeof handler !== 'function') throw new TypeError('onTurnSettled 需要一个函数')
      const entry = { owner: ownerOf(this), handler }
      return owned(this, () => { settledHandlers.add(entry); return () => settledHandlers.delete(entry) }, 'tavern.onTurnSettled()')
    },

    onGameRemoved(handler) {
      if (typeof handler !== 'function') throw new TypeError('onGameRemoved 需要一个函数')
      const entry = { owner: ownerOf(this), handler }
      return owned(this, () => { removedHandlers.add(entry); return () => removedHandlers.delete(entry) }, 'tavern.onGameRemoved()')
    },

    async getTurn({ gameId, turn } = {}) {
      const material = await deps.readTurn(gameIdOf(gameId), positiveTurn(turn))
      if (!material) return null
      await deps.media.issue(material.chatId, material.turn, material.key)
      return snapshotOf(material)
    },

    async getCardContext({ gameId, turn } = {}) {
      return await deps.readCardContext(await requireTurn(gameId, turn))
    },

    async backgroundModel({ gameId } = {}) {
      const selection = await deps.backgroundModel(gameIdOf(gameId))
      return selection && selection.provider && selection.model ? { provider: String(selection.provider), model: String(selection.model) } : null
    },

    async attach({ gameId, turn, textVersion, item } = {}) {
      const owner = ownerOf(this)
      const material = await requireTurn(gameId, turn)
      if (typeof textVersion !== 'string' || textVersion === '') throw new Error('textVersion 必须是 onTurnSettled 或 getTurn 给出的值')
      const record = await deps.media.attach({ chatId: material.chatId, sessionId: material.sessionId, owner, turn: material.turn, key: textVersion, currentKey: material.key, item })
      await changed(material.sessionId)
      return { id: record.id }
    },

    async update(itemId, changes) {
      const owner = ownerOf(this)
      const { chatId, sessionId } = await locateItem(itemId)
      const record = await deps.media.patch({ chatId, owner, itemId, changes })
      await changed(sessionId)
      return publicPluginMedia(record)
    },

    async remove(itemId) {
      const owner = ownerOf(this)
      const located = await locateItem(itemId).catch(() => null)
      if (!located) return false
      const removed = await deps.media.remove({ chatId: located.chatId, owner, itemId })
      if (removed) await changed(located.sessionId)
      return removed
    },

    async list({ gameId, turn } = {}) {
      const owner = ownerOf(this)
      const chat = await deps.resolveGame(gameIdOf(gameId))
      if (!chat) return []
      const items = await deps.media.list({ chatId: chat.chatId, owner, turn: turn === undefined ? undefined : positiveTurn(turn) })
      const currentKeys = new Map()
      for (const turnNumber of new Set(items.map(item => item.turn))) currentKeys.set(turnNumber, await deps.currentKey(chat.sessionId, turnNumber))
      return items.map(item => publicPluginMedia(item, currentKeys.get(item.turn) === item.key))
    },

    promptSection({ name, text } = {}) {
      const owner = ownerOf(this)
      if (typeof name !== 'string' || !SECTION_NAME.test(name)) throw new Error('name 只能用小写字母、数字、点、下划线和连字符')
      if (typeof text !== 'string' && typeof text !== 'function') throw new TypeError('text 必须是字符串或函数')
      const key = owner + '\u0000' + name
      const entry = { owner, name, text }
      return owned(this, () => {
        if (sections.has(key)) throw new Error('提示词段落 ' + name + ' 已注册')
        sections.set(key, entry)
        return () => { if (sections.get(key) === entry) sections.delete(key) }
      }, 'tavern.promptSection()')
    }
  }
  Object.defineProperty(service, TRACKER, { value: { associate: 'tavern', property: 'ctx' } })

  /** Called by Tavern after a turn's settlement finished (or failed). */
  async function turnSettled(sessionId) {
    if (settledHandlers.size === 0) return
    const material = await deps.readLatestSettledTurn(sessionId)
    if (!material) return
    const id = material.chatId + '\u0000' + material.key
    if (notified.has(id)) return
    notified.add(id)
    if (notified.size > 2000) notified.delete(notified.values().next().value)
    await deps.media.issue(material.chatId, material.turn, material.key)
    dispatch(settledHandlers, { ...snapshotOf(material), settledAt: Date.now() }, 'onTurnSettled')
  }

  function gameRemoved(gameId) {
    if (gameId) dispatch(removedHandlers, { gameId }, 'onGameRemoved')
  }

  /** Plugin sections for the foreground story prompt, in a stable order. */
  async function promptSections({ gameId, turn }) {
    const result = []
    const entries = Array.from(sections.values()).sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name))
    for (const entry of entries) {
      let text
      try { text = typeof entry.text === 'function' ? await entry.text({ gameId, turn }) : entry.text }
      catch (error) { log.warn?.('dsh-tavern: 插件 ' + entry.owner + ' 的提示词段落生成失败: ' + String(error?.message || error)); continue }
      if (typeof text !== 'string' || !text.trim()) continue
      result.push({ name: 'tavern-plugin:' + entry.owner + ':' + entry.name, text: text.trim().slice(0, MAX_SECTION_TEXT) })
    }
    return result
  }

  return Object.freeze({ service, turnSettled, gameRemoved, promptSections })
}
