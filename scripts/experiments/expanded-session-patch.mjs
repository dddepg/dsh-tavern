// EXPERIMENT ONLY: late, in-memory host/client patch. Never imported by Tavern.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

export async function prepareExpandedPatch(runtime) {
  const marker = 'dsh-tavern/required-session-patch-v1'
  const require = createRequire(join(runtime, 'package.json'))
  const originals = new Map()
  const urls = new Map()
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  // Tavern rollback preserves the original provider, so provider allowlists
  // cannot represent ownership. This experimental profile-wide fix permits
  // citations on replacement only, for every provider; append stays native.
  const own = "(event.surfaceOp?.op === 'replace')"
  async function source(name) {
    const path = require.resolve(name)
    const text = await readFile(path, 'utf8')
    originals.set(path, text)
    return { path, text }
  }
  function once(text, before, after) {
    assert.equal(text.split(before).length, 2, 'Pinned patch target drifted: ' + before)
    return text.replace(before, after)
  }
  async function compile(name, transform = text => text) {
    const { path, text } = await source(name)
    const localRequire = createRequire(path)
    let modified = transform(text)
    modified = modified.replace(/from "([^"]+)"/g, (_, specifier) => {
      const url = urls.get(specifier) ?? (/^(node:|file:|data:)/.test(specifier) ? specifier : pathToFileURL(localRequire.resolve(specifier)).href)
      return 'from ' + JSON.stringify(url)
    })
    modified = modified.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path).href))
    const url = 'data:text/javascript;base64,' + Buffer.from(modified).toString('base64')
    urls.set(name, url)
    return import(url)
  }
  function facade(name, selectedExports) {
    const text = `export * from ${JSON.stringify(pathToFileURL(require.resolve(name)).href)};\nexport { ${selectedExports.join(', ')} } from ${JSON.stringify(urls.get(name))};`
    urls.set(name, 'data:text/javascript;base64,' + Buffer.from(text).toString('base64'))
  }
  const pkg = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8'))
  assert.equal(pkg.version, '0.1.6-alpha.2')
  const { Session } = await load('@deepseek-ai/dsh-session')
  const patchedSurface = await compile('@deepseek-ai/dsh-session/surface', text => once(text,
    "if (event.type === 'assistant/message' && raw !== undefined) {",
    `if (event.type === 'assistant/message' && raw !== undefined && !${own}) {`))
  const surfacePrototype = Object.getPrototypeOf(Session.create('patch-prototype-probe').surface)
  const surfaceDescriptors = Object.fromEntries(['validateNext', '_processDelta'].map(key => [key, Object.getOwnPropertyDescriptor(surfacePrototype, key)]))
  // Append admission, coverage validation, and system-head protection stay native.
  for (const key of Object.keys(surfaceDescriptors)) Object.defineProperty(surfacePrototype, key, Object.getOwnPropertyDescriptor(patchedSurface.SurfaceManager.prototype, key))
  const originalAppend = Session.prototype.append
  const markedSessions = new WeakSet()
  Session.prototype.append = function (type, data, ...args) {
    if (type === 'assistant/message' && args[0]?.surfaceOp?.op === 'replace' && !markedSessions.has(this)) {
      if (!this.snapshotEvents().some(event => event.type === marker)) {
        originalAppend.call(this, marker, { version: 1, hostVersion: pkg.version })
      }
      markedSessions.add(this)
    }
    return originalAppend.call(this, type, data, ...args)
  }
  const restoreSurface = () => {
    Session.prototype.append = originalAppend
    Object.defineProperties(surfacePrototype, surfaceDescriptors)
  }
  try {
    // Stored-event adoption has another bundled copy of the local validator.
    // Cloned storage modules use this copy; the already-live Session service
    // keeps its original identity and the prototype patch above.
    const patchedSession = await compile('@deepseek-ai/dsh-session', text => once(text,
      'if (event.type === "assistant/message" && raw !== void 0) throw',
      `if (event.type === "assistant/message" && raw !== void 0 && !${own}) throw`))
    // Only the in-memory cloned vocabulary understands this required marker.
    // Stock readers refuse the archive instead of treating the edit as a torn tail.
    patchedSession.KNOWN_SESSION_EVENT_TYPES.add(marker)
    // Preserve public class identities: service owners and error consumers
    // imported those classes before this patch. Only validation is replaced.
    facade('@deepseek-ai/dsh-session', ['adoptSessionEvent', 'snapshotSessionEvent', 'foldSurface', 'KNOWN_SESSION_EVENT_TYPES'])
    await compile('@deepseek-ai/dsh-session-persistence', text =>
      `import * as NativeErrors from ${JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence')).href)};\n` +
      text.replace(/\bnew (Session\w+Error)\(/g, 'new NativeErrors.$1(').replace(/\binstanceof (Session\w+Error)\b/g, 'instanceof NativeErrors.$1'))
    facade('@deepseek-ai/dsh-session-persistence', ['validateStoredEvents'])
    await compile('@deepseek-ai/dsh-session-format-v2-to-v3', text => once(text,
      'if (event.type === "assistant/message" && sources !== void 0) throw',
      `if (event.type === "assistant/message" && sources !== void 0 && !${own}) throw`))
    const { sessionFormatCatalog: catalog } = await compile('@deepseek-ai/dsh-session-format-catalog')
    const { default: PatchedPersistence } = await compile('@deepseek-ai/dsh-session-persistence-jsonl')
    const query = await compile('@deepseek-ai/dsh-session-query', text =>
      `import { SessionQueryError as NativeQueryError } from ${JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-query')).href)};\n` +
      text.replace(/\bnew SessionQueryError\(/g, 'new NativeQueryError(').replace(/\binstanceof SessionQueryError\b/g, 'instanceof NativeQueryError') +
      '\nexport { SessionCorpus, SessionObservationReader };')
    const { text: originalClient } = await source('@deepseek-ai/dsh-api-session-controller/client')
    const clientSource = once(originalClient,
      'if (event.type === "assistant/message" && raw !== void 0) throw',
      `if (event.type === "assistant/message" && raw !== void 0 && !${own}) throw`)
    const undoPersistence = []
    return {
      catalog, patchedSurface, clientSource, marker,
      patchQuery(instance) {
        assert.equal(instance._observations.cache.size, 0, 'Install before querying Session history')
        for (const [target, prototype] of [
          [instance, query.SessionQueryEngine.prototype],
          [instance._corpus, query.SessionCorpus.prototype],
          [instance._observations, query.SessionObservationReader.prototype],
        ]) {
          const keys = Reflect.ownKeys(prototype).filter(key => key !== 'constructor')
          const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(target, key)]))
          for (const key of keys) Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(prototype, key))
          undoPersistence.push(() => {
            for (const [key, descriptor] of descriptors) {
              if (descriptor) Object.defineProperty(target, key, descriptor)
              else delete target[key]
            }
          })
        }
      },
      patchPersistence(instance) {
        // Existing handles must be closed before this experimental installation.
        // Install own methods on ONE backend instance, not its shared prototype.
        assert.equal(instance.tracker.openHandles.size, 0, 'Install before opening Session handles')
        assert.equal(instance.tracker.writers.size, 0, 'Install before acquiring Session writers')
        const keys = Reflect.ownKeys(PatchedPersistence.prototype).filter(key => key !== 'constructor')
        const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(instance, key)]))
        const format = instance.generationFormat
        for (const key of keys) Object.defineProperty(instance, key, Object.getOwnPropertyDescriptor(PatchedPersistence.prototype, key))
        instance.generationFormat = {
          currentVersion: catalog.currentVersion,
          createRestore: header => catalog.createRestore(header, { recovery: 'strict', validation: 'current' }),
          encodeHeader: (header, count) => catalog.encodeCurrentHeader(header, count),
          encodeEvent: event => catalog.encodeCurrentEvent(event),
        }
        instance.coldLogMemo.clear()
        undoPersistence.push(() => {
          for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(instance, key, descriptor)
            else delete instance[key]
          }
          instance.generationFormat = format
          instance.coldLogMemo.clear()
        })
      },
      async verifyFilesUnchanged() {
        const hashes = []
        for (const [path, text] of originals) {
          assert.equal(await readFile(path, 'utf8'), text)
          hashes.push({ packageFile: path.split('/node_modules/').at(-1), sha256: createHash('sha256').update(text).digest('hex') })
        }
        return hashes
      },
      dispose() {
        for (const undo of undoPersistence.reverse()) undo()
        restoreSurface()
      },
    }
  } catch (error) {
    restoreSurface()
    throw error
  }
}
