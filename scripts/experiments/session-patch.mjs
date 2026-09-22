// EXPERIMENT ONLY. Run against disposable, unmodified npm packages, never a live host.
// No import from production code. This intentionally probes unsupported internals.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const runtime = resolve(process.argv[2] || '')
assert(process.argv[2], 'Usage: node scripts/experiments/session-patch.mjs /path/to/disposable/npm-runtime')
const require = createRequire(join(runtime, 'package.json'))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const surfacePath = require.resolve('@deepseek-ai/dsh-session/surface')
const surface = await load('@deepseek-ai/dsh-session/surface')
const { sessionFormatCatalog: catalog } = await load('@deepseek-ai/dsh-session-format-catalog')
const { releasedV2SessionFormatCodec } = await load('@deepseek-ai/dsh-session-format-v1-to-v2')
const version = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8')).version
assert.equal(version, '0.1.6-alpha.2', 'This experiment is pinned to one inspected host version')
const out = await mkdtemp(join(tmpdir(), 'tavern-session-patch-evidence-'))
const results = []
const originalSource = await readFile(surfacePath, 'utf8')
const hash = text => createHash('sha256').update(text).digest('hex')

async function check(name, fn, errorPattern) {
  try {
    const detail = await fn()
    assert(!errorPattern, `Expected rejection matching ${errorPattern}`)
    results.push({ name, result: 'accepted', detail })
  } catch (error) {
    if (!errorPattern || !errorPattern.test(error.message)) throw error
    results.push({ name, result: 'rejected', error: error.message })
  }
  console.log(JSON.stringify(results.at(-1)))
}

const assistant = text => ({ turn: 1, step: 1, stream: [], message: {
  id: 'body-' + text, role: 'assistant', content: [{ type: 'text', text }],
  source: { kind: 'model', provider: 'tavern-patch-experiment', model: 'fixture' },
} })
function fixture(id, projections) {
  const s = Session.create(id, undefined, { version: 3, id, createdAt: Date.now(), isSeeded: false, delegationDepth: 0 }, undefined, projections)
  s.append('turn/start', { turn: 1 })
  s.append('step/start', { turn: 1, step: 1 })
  s.append('system/message', { turn: 1, step: 1, message: {
    id: 'system', role: 'system', content: [{ type: 'text', text: 'Stable prefix' }],
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
  } }, { surfaceOp: 'append' })
  s.append('user/message', { id: 'input', role: 'user', content: [{ type: 'text', text: 'Player input' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  const old = s.append('assistant/message', assistant('original'), { surfaceOp: 'append' })
  s.append('step/end', { turn: 1, step: 1 })
  s.append('turn/end', { turn: 1, reason: 'completed' })
  return { s, old }
}
const intent = (old, cite = true) => ({ surfaceOp: { op: 'replace', startSeq: old.seq, endSeq: old.seq }, ...(cite ? { sourceEventSeqs: [old.seq] } : {}) })
const messages = s => s.deriveMessages().map(m => ({ role: m.role, content: m.content }))
async function diskRoundTrip(s, label) {
  const rows = [catalog.encodeCurrentHeader(s.header, s.inheritedEventCount), ...s.snapshotEvents().map(e => catalog.encodeCurrentEvent(e))]
  const path = join(out, label + '.jsonl')
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const [header, ...events] = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse)
  const restore = catalog.createRestore(header, { recovery: 'strict', validation: 'current' })
  for (const row of events) restore.decodeRow(row)
  return restore.finish()
}

// Execute the original browser bundle, using only an inert transport superclass.
// Validation and SessionEventStream.readPage are the published code, unmodified.
const clientPath = join(runtime, 'node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js')
const clientSource = await readFile(clientPath, 'utf8')
let client
vm.runInNewContext(clientSource, { window: { __ModuleLoader__: { load({ factory }) {
  client = factory(name => {
    if (name === '@deepseek-ai/cordis') return { Service: class {} }
    if (name === '@deepseek-ai/dsh-api-gateway/client') return { RemoteJournalStream: class {} }
    if (name === '@deepseek-ai/dsh-client-store') return {}
    throw Error('Unexpected browser dependency: ' + name)
  })
} } } }, { filename: clientPath })
async function readClient(event) {
  const remote = { session: { page: async () => ({ ok: true, value: { records: [{ type: 'event', event }], hasMore: false } }) } }
  const stream = new client.SessionEventStream(remote, { sessionId: 'fixture' }, { publish() {}, failed() {} })
  return (await stream.readPage({}, event.seq)).records.length
}

const baseline = fixture('baseline')
await check('stock JSONL encode + strict restore (control)', () => diskRoundTrip(baseline.s, 'baseline').then(a => ({ events: a.events.length })))
await check('stock browser read (control)', () => readClient(baseline.old))
await check('stock replacement with citations', () => baseline.s.append('assistant/message', assistant('edited'), intent(baseline.old)), /cannot carry sourceEventSeqs/)
await check('stock replacement without citations', () => baseline.s.append('assistant/message', assistant('edited'), intent(baseline.old, false)), /must include every shadowed/)

// Compile the one-condition relaxation in MEMORY. Do not write any package file.
// Scope to our fixture provider; keep range/source coverage and system-head guards.
const needle = "if (event.type === 'assistant/message' && raw !== undefined) {"
assert.equal(originalSource.split(needle).length, 2)
let patchedSource = originalSource.replace(needle,
  "if (event.type === 'assistant/message' && raw !== undefined && !(event.surfaceOp?.op === 'replace' && event.data?.message?.source?.provider === 'tavern-patch-experiment')) {")
patchedSource = patchedSource.replace(/from "(\.\/[^\"]+)"/g, (_, specifier) => 'from ' + JSON.stringify(new URL(specifier, pathToFileURL(surfacePath)).href))
const patched = await import('data:text/javascript;base64,' + Buffer.from(patchedSource).toString('base64'))
// The published Session entry bundles its own SurfaceManager; patching the
// exported /surface class alone does NOT reach live Session instances.
const prototype = Object.getPrototypeOf(baseline.s.surface)
const originals = Object.fromEntries(['validateNext', '_processDelta'].map(key => [key, prototype[key]]))
for (const key of Object.keys(originals)) prototype[key] = patched.SurfaceManager.prototype[key]
let edited
try {
  await check('runtime patch: edit assistant body', () => {
    edited = baseline.s.append('assistant/message', assistant('edited'), intent(baseline.old))
    assert.equal(baseline.s.deriveMessages().at(-1).content[0].text, 'edited')
    assert.equal(baseline.s.deriveMessages().at(-1).role, 'assistant')
    assert.equal(baseline.old.data.message.content[0].text, 'original')
    return messages(baseline.s)
  })
  await check('runtime patch: detached Session restore', () => {
    const s = Session.fromRestore(baseline.s.id, JSON.parse(JSON.stringify(baseline.s.snapshotEvents())), baseline.s.header, baseline.s.inheritedEventCount, 'detached')
    assert.deepEqual(messages(s), messages(baseline.s))
    return messages(s)
  })
  await check('runtime patch: native JSONL persistence', () => diskRoundTrip(baseline.s, 'patched'), /cannot carry sourceEventSeqs/)
  await check('runtime patch: original browser history page', () => readClient(edited), /cannot carry sourceEventSeqs/)
  await check('runtime patch: standalone official fold', () => surface.foldSurface(baseline.s.snapshotEvents()), /cannot carry sourceEventSeqs/)
  await check('runtime patch: raw persisted replacement still fails strict decoder', () => {
    const restore = catalog.createRestore(catalog.encodeCurrentHeader(baseline.s.header, 0), { recovery: 'strict', validation: 'current' })
    // Only for probing the downstream reader: bypass V3 encode admission using
    // the shared V2 physical range encoder. No production persistence is used.
    for (const event of baseline.s.snapshotEvents()) restore.decodeRow(releasedV2SessionFormatCodec.encodeEvent(event))
    return restore.finish()
  }, /cannot carry sourceEventSeqs/)
  await check('runtime patch: unrelated provider remains rejected', () => {
    const data = assistant('unrelated')
    data.message.source.provider = 'unrelated-provider'
    baseline.s.append('assistant/message', data, intent(edited))
  }, /cannot carry sourceEventSeqs/)
  await check('runtime patch: source coverage remains enforced', () => baseline.s.append('assistant/message', assistant('bad references'), {
    ...intent(edited), sourceEventSeqs: [baseline.old.seq],
  }), /must include every shadowed/)
  await check('runtime patch: protected system head remains enforced', () => baseline.s.append('assistant/message', assistant('bad head'), intent({ seq: 2 })), /node 0 holds the system prompt/)
  await check('runtime patch: rollback and replacement content sequence (memory only)', () => {
    const restored = baseline.s.append('assistant/message', baseline.old.data, intent(edited))
    assert.equal(baseline.s.deriveMessages().at(-1).content[0].text, 'original')
    baseline.s.append('assistant/message', assistant('regenerated fixture'), intent(restored))
    assert.equal(baseline.s.deriveMessages().at(-1).content[0].text, 'regenerated fixture')
    assert.deepEqual(messages(baseline.s).slice(0, 2), [
      { role: 'system', content: [{ type: 'text', text: 'Stable prefix' }] },
      { role: 'user', content: [{ type: 'text', text: 'Player input' }] },
    ])
    return messages(baseline.s)
  })
} finally {
  Object.assign(prototype, originals)
}

// Test the public projection alternative without rewriting an assistant event.
const projection = { type: 'tavern-experiment/body-edit', project(event, context) {
  const original = surface.deriveEventMessage(context.events[event.data.target - context.baseSeq], context.messages)
  return new Map([[event.data.target, Object.freeze({ ...original, content: Object.freeze([Object.freeze({ type: 'text', text: event.data.text })]) })]])
} }
const projected = fixture('projection', [projection])
await check('public projection: live edit', () => {
  projected.s.append(projection.type, { target: projected.old.seq, text: 'projected edit' })
  assert.equal(projected.s.deriveMessages().at(-1).content[0].text, 'projected edit')
  return messages(projected.s)
})
await check('public projection: native JSONL restore', () => diskRoundTrip(projected.s, 'projection'), /unknown event type/)
await check('ignorable projection counterexample: stock replay silently retains old text', () => {
  // Diagnostic only, not an implementation: labeling a required edit ignorable
  // makes its omission legal to stock readers, but changes what history means.
  const events = projected.s.snapshotEvents().map(e => e.type === projection.type ? { ...e, ignorable: true } : e)
  const restore = catalog.createRestore(catalog.encodeCurrentHeader(projected.s.header, 0), { recovery: 'strict', validation: 'current' })
  for (const event of events) restore.decodeRow(catalog.encodeCurrentEvent(event))
  const artifact = restore.finish()
  const stock = Session.fromRestore(artifact.header.id, artifact.events, artifact.header, artifact.inheritedEventCount, 'detached')
  const plugin = Session.fromRestore(artifact.header.id, artifact.events, artifact.header, artifact.inheritedEventCount, 'detached', [projection])
  assert.equal(stock.deriveMessages().at(-1).content[0].text, 'original')
  assert.equal(plugin.deriveMessages().at(-1).content[0].text, 'projected edit')
  return { stock: messages(stock).at(-1), withPlugin: messages(plugin).at(-1), warning: 'The same archive has different model history without the plugin; not equivalent native replay.' }
})
await check('package files unchanged', async () => {
  assert.equal(hash(await readFile(surfacePath, 'utf8')), hash(originalSource))
  assert.equal(hash(await readFile(clientPath, 'utf8')), hash(clientSource))
  return { surface: hash(originalSource), client: hash(clientSource) }
})
const report = { version, runtime, evidenceDirectory: out, scope: 'native Session, official JSONL codec/catalog, published browser history reader; no Desktop/DSHA UI or model request', verdict: 'Surface-only runtime patch is insufficient; native persistence and browser validation still reject. Public custom projection is blocked by unknown required event on restore.', results }
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log('REPORT ' + join(out, 'report.json'))
