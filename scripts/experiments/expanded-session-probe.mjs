// Run only against the disposable npm runtime documented beside this experiment.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import vm from 'node:vm'
import { prepareExpandedPatch } from './expanded-session-patch.mjs'

async function main() {
  const runtime = resolve(process.argv[2])
  const require = createRequire(join(runtime, 'package.json'))
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  // Import native services BEFORE installing the patch: no preloader required.
  const { Context } = await load('@deepseek-ai/cordis')
  const { Session } = await load('@deepseek-ai/dsh-session')
  const { default: Jsonl } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
  const { SessionPersistenceNotFoundError, SessionAlreadyExistsError, SessionReadOnlyError } = await load('@deepseek-ai/dsh-session-persistence')
  const compression = process.env.EXPERIMENT_COMPRESSION || 'none'
  const root = process.argv[3] || await mkdtemp(join(tmpdir(), 'tavern-expanded-session-'))
  const ctx = new Context()
  await ctx.plugin(Jsonl, { root: join(root, compression), compression })
  if (process.argv[4] === 'unpatched') {
    try {
      const path = ctx.sessionPersistence.locate({ id: 'expanded-probe' }).path
      const before = await readFile(path)
      const errors = []
      for (const access of ['read', 'write']) {
        await assert.rejects(async () => {
          const handle = await ctx.sessionPersistence.open('expanded-probe', access)
          try { await handle.read() } finally { await handle.close() }
        }, error => {
          errors.push({ access, message: error.message })
          return /dsh-tavern\/required-session-patch-v1.*unknown|unknown.*dsh-tavern\/required-session-patch-v1/.test(error.message) ||
            (compression === 'zstd' && /complete frame contains a torn JSONL record/.test(error.message))
        })
      }
      assert.deepEqual(await readFile(path), before, 'Unpatched access must never truncate the stored edit')
      console.log(JSON.stringify({ result: 'passed', stage: 'stock read/write refuse patched archive without modifying it', errors }))
    } finally { await ctx.fiber.dispose() }
    return
  }
  const expectedVersion = process.env.EXPERIMENT_DSH_VERSION || '0.1.6-alpha.2'
  const patch = await prepareExpandedPatch(runtime, { version: expectedVersion })
  patch.patchPersistence(ctx.sessionPersistence)
  const textOf = s => s.deriveMessages().map(m => ({ role: m.role, text: m.content.filter(c => c.type === 'text').map(c => c.text).join('') }))
  const results = []
  const record = (name, detail) => { results.push({ name, detail }); console.log(JSON.stringify(results.at(-1))) }
  try {
    if (process.argv[4] === 'restore') {
      const handle = await ctx.sessionPersistence.open('expanded-probe', 'read')
      try {
        const { events } = await handle.read()
        const s = Session.fromRestore(handle.id, events, handle.header, 0, 'detached')
        assert.equal(textOf(s).at(-1).text, 'regenerated fixture')
        record('fresh-process native persistence restore', textOf(s))
      } finally { await handle.close() }
      return
    }
    const s = Session.create('expanded-probe', undefined, { id: 'expanded-probe', version: 3, createdAt: Date.now(), isSeeded: false, delegationDepth: 0 })
    const assistant = text => ({ turn: 1, step: 1, stream: [], message: { id: 'body-' + text, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'tavern-patch-experiment', model: 'fixture' } } })
    const replace = (old, text) => s.append('assistant/message', assistant(text), { surfaceOp: { op: 'replace', startSeq: old.seq, endSeq: old.seq }, sourceEventSeqs: [old.seq] })
    s.append('turn/start', { turn: 1 })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('system/message', { turn: 1, step: 1, message: { id: 'system', role: 'system', content: [{ type: 'text', text: 'Stable prefix' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } } }, { surfaceOp: 'append' })
    s.append('user/message', { id: 'input', role: 'user', content: [{ type: 'text', text: 'Player input' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const old = s.append('assistant/message', assistant('original'), { surfaceOp: 'append' })
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: 'completed' })
    const edited = replace(old, 'edited')
    const reverted = replace(edited, 'original')
    const regenerated = replace(reverted, 'regenerated fixture')
    assert.equal(textOf(s).at(-1).text, 'regenerated fixture')
    record('edit / restore / replace sequence', textOf(s))
    const writer = await ctx.sessionPersistence.create(s.header)
    try { await writer.append(s.snapshotEvents()); await writer.flush() } finally { await writer.close() }
    record('actual native JSONL backend append / flush / close', { compression, events: s.seq })
    await assert.rejects(() => ctx.sessionPersistence.open('does-not-exist', 'read'), SessionPersistenceNotFoundError)
    await assert.rejects(() => ctx.sessionPersistence.create(s.header), SessionAlreadyExistsError)
    const reader = await ctx.sessionPersistence.open(s.id, 'read')
    try {
      await assert.rejects(() => reader.append([]), SessionReadOnlyError)
      const { events } = await reader.read()
      const restored = Session.fromRestore(s.id, events, reader.header, 0, 'detached')
      assert.deepEqual(textOf(restored), textOf(s))
      record('native backend reopen', textOf(restored))
    } finally { await reader.close() }
    record('native error class identities retained', true)
    const child = execFileSync(process.execPath, [fileURLToPath(import.meta.url), runtime, root, 'restore'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, EXPERIMENT_COMPRESSION: compression } })
    record('cold process', JSON.parse(child.trim()))
    const stock = execFileSync(process.execPath, [fileURLToPath(import.meta.url), runtime, root, 'unpatched'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, EXPERIMENT_COMPRESSION: compression } })
    record('cold unpatched process', JSON.parse(stock.trim()))
    // Install on the ORIGINAL client class after it has already been loaded.
    function evaluate(source) {
      let exports
      vm.runInNewContext(source, { window: { __ModuleLoader__: { load({ factory }) {
        exports = factory(name => name === '@deepseek-ai/cordis' ? { Service: class {} } : name === '@deepseek-ai/dsh-api-gateway/client' ? { RemoteJournalStream: class {} } : {})
      } } } })
      return exports
    }
    const client = evaluate(await readFile(require.resolve('@deepseek-ai/dsh-api-session-controller/client'), 'utf8'))
    const modified = evaluate(patch.clientSource)
    const remote = { session: {
      page: async () => ({ ok: true, value: { records: [{ type: 'event', event: regenerated }], hasMore: false } }),
      async *follow() { yield { type: 'snapshot', records: [{ type: 'event', event: regenerated }], cursor: regenerated.seq, hasMore: false, assistantStream: { revision: 0 } } },
    } }
    const stream = new client.SessionEventStream(remote, { sessionId: s.id }, { publish() {}, failed() {} })
    await assert.rejects(() => stream.readPage({}, regenerated.seq), /cannot carry sourceEventSeqs/)
    for (const method of ['readPage', 'follow']) client.SessionEventStream.prototype[method] = modified.SessionEventStream.prototype[method]
    assert.equal((await stream.readPage({}, regenerated.seq)).records[0].event.type, 'assistant/message')
    const frames = []
    for await (const frame of stream.follow({})) frames.push(frame)
    assert.equal(frames[0].page.records[0].event.data.message.content[0].text, 'regenerated fixture')
    record('late client patch: original existing stream page + follow', { records: 1, frames: frames.length })
    const malformedAppend = structuredClone(regenerated)
    malformedAppend.surfaceOp = 'append'
    assert.throws(() => patch.catalog.encodeCurrentEvent(malformedAppend), /cannot carry sourceEventSeqs/)
    assert.throws(() => s.append('assistant/message', assistant('missing source'), { surfaceOp: regenerated.surfaceOp, sourceEventSeqs: [0] }), /not found in surface/)
    const before = s.seq
    assert.throws(() => s.append('assistant/message', assistant('missing source'), { surfaceOp: { op: 'replace', startSeq: regenerated.seq, endSeq: regenerated.seq }, sourceEventSeqs: [old.seq] }), /must include every shadowed/)
    assert.throws(() => s.append('assistant/message', assistant('system overwrite'), { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] }), /node 0 holds the system prompt/)
    assert.equal(s.seq, before)
    record('append citations / stale range / source coverage / system head remain rejected', true)
    record('installed package bytes unchanged', await patch.verifyFilesUnchanged())
    await writeFile(join(root, 'expanded-report-' + compression + '.json'), JSON.stringify({ version: expectedVersion, compression, results }, null, 2) + '\n')
    console.log('REPORT ' + join(root, 'expanded-report-' + compression + '.json'))
  } finally {
    await ctx.fiber.dispose()
    patch.dispose()
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
