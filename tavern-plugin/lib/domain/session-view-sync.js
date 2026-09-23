import { createHash, randomUUID } from 'node:crypto'

// Reader cursors retain fingerprints only; never retain another full chat snapshot.
export function createSessionViewSync({ maxReaders = 32 } = {}) {
  const readers = new Map()
  function hashValue(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
  }
  function parts(view, previous, dirtyMessageIndices) {
    const result = new Map()
    function add(path, value, reuseHash) {
      if (value === undefined && reuseHash === undefined) return
      const key = JSON.stringify(path)
      if (reuseHash !== undefined) {
        result.set(key, { path, hash: reuseHash })
        return
      }
      result.set(key, { path, value, hash: hashValue(value) })
    }
    for (const [key, value] of Object.entries(view || {})) {
      if (key === 'replyProjections' && Array.isArray(value)) {
        add([key, 'length'], value.length)
        value.forEach((row, index) => add([key, index], row))
      } else if (['inputSources', 'inputTemplateDisplays', 'tavernHelper'].includes(key) && value && typeof value === 'object') {
        add([key], {})
        for (const [field, item] of Object.entries(value)) {
          if (key === 'tavernHelper' && field === 'messages' && Array.isArray(item)) {
            add([key, field, 'length'], item.length)
            const canReuse = previous && previous.hashes && dirtyMessageIndices
            item.forEach((row, index) => {
              const path = [key, field, index]
              const pathKey = JSON.stringify(path)
              if (canReuse && !dirtyMessageIndices.has(index) && previous.hashes.has(pathKey)) {
                add(path, row, previous.hashes.get(pathKey))
              } else add(path, row)
            })
          } else add([key, field], item)
        }
      } else add([key], value)
    }
    return result
  }
  function synchronize(sessionId, view, cursor, options = {}) {
    if (view === null) return { view: null, viewCursor: null }
    const previous = readers.get(cursor)
    const dirtyMessageIndices = options.dirtyMessageIndices instanceof Set ? options.dirtyMessageIndices : null
    const current = parts(view, previous && previous.sessionId === sessionId ? previous : null, dirtyMessageIndices)
    const nextCursor = randomUUID()
    const hashes = new Map()
    for (const [key, item] of current) hashes.set(key, item.hash)
    readers.set(nextCursor, {
      sessionId,
      hashes,
      revision: Number.isSafeInteger(options.revision) ? options.revision : previous?.revision
    })
    while (readers.size > maxReaders) readers.delete(readers.keys().next().value)
    if (!previous || previous.sessionId !== sessionId) return { view, viewCursor: nextCursor }
    const set = [], remove = []
    for (const [key, item] of current) {
      if (previous.hashes.get(key) === item.hash) continue
      set.push([item.path, item.value])
    }
    for (const key of previous.hashes.keys()) if (!current.has(key)) remove.push(JSON.parse(key))
    return { viewCursor: nextCursor, viewDelta: { baseCursor: cursor, set, remove } }
  }
  synchronize.peek = function peek(cursor) {
    return readers.get(cursor) || null
  }
  return synchronize
}
