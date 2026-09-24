import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { compactedLegacySession, compactedEditedLegacySession } from './fixtures/compacted-legacy-session.mjs'
import { prepareLegacySessionLog, encodeMigratedSessionLog, commitLegacySessionFile, parseSessionLog } from '../tavern-plugin/lib/domain/legacy-session-migration.js'
const modules = join(process.env.TAVERN_E2E_RUNTIME || join(homedir(), '.dsh-tavern/runtime'), 'lib/node_modules/@deepseek-ai')
const available = existsSync(join(modules, 'dsh-session/lib/index.js'))
const { Session } = available ? await import(pathToFileURL(join(modules, 'dsh-session/lib/index.js'))) : {}
const { sessionFormatCatalog: catalog } = available ? await import(pathToFileURL(join(modules, 'dsh-session-format-catalog/lib/index.js'))) : {}

function visibleText(events) {
  const surface = []
  for (const event of events) {
    if (!event.surfaceOp) continue
    if (event.surfaceOp === 'append' || event.surfaceOp.op === 'append') surface.push(event)
    else {
      const a = surface.findIndex(row => row.seq === event.surfaceOp.start), b = surface.findIndex(row => row.seq === event.surfaceOp.end)
      assert.ok(a >= 0 && b >= a)
      surface.splice(a, b - a + 1, event)
    }
  }
  return surface.flatMap(event => (event.data.message || event.data).content || []).map(block => block.text || '').join('\n')
}
test('legacy migration preserves a compacted surface even when compaction bookkeeping needs repair', { skip: !available }, () => {
  const valid = compactedLegacySession()
  assert.ok(prepareLegacySessionLog(valid.text, catalog).artifact, 'control is a real host-readable v0 log')
  const damaged = compactedEditedLegacySession()
  assert.equal(visibleText(damaged.events), 'SUMMARY_TO_KEEP')
  const prepared = prepareLegacySessionLog(damaged.text, catalog)
  assert.equal(prepared.ok, true)
  assert.ok(prepared.artifact, prepared.reason)
  const { artifact } = prepared
  const restored = Session.fromRestore('issue-94', artifact.events, artifact.header, artifact.inheritedEventCount ?? 0)
  assert.equal(restored.deriveMessages().flatMap(message => message.content).map(block => block.text || '').filter(Boolean).join('\n'), 'SUMMARY_TO_KEEP', 'migration must not resurrect shadowed old history')
  assert.ok(JSON.stringify(prepared.artifact.events).includes('OLD_STORY_SHOULD_STAY_ARCHIVED'), 'original history remains readable')
})

test('disk migration keeps summary after cold restore; unsafe repair leaves original bytes intact', { skip: !available }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'issue94-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = compactedEditedLegacySession()
  const file = join(root, 'session.jsonl.zstd')
  const original = encodeMigratedSessionLog(JSON.stringify(fixture.header), fixture.events)
  await writeFile(file, original)
  const result = await commitLegacySessionFile(file, catalog)
  assert.equal(result.written, true, result.reason)
  assert.deepEqual(await readFile(file + '.bak-tavern-premigrate'), original)
  const saved = parseSessionLog(await readFile(join(root, 'session.v3.jsonl.zstd')))
  const restore = catalog.createRestore(saved.header, { validation: 'current' })
  saved.events.forEach(event => restore.decodeRow(event))
  const artifact = restore.finish()
  const session = Session.fromRestore('issue-94', artifact.events, artifact.header, artifact.inheritedEventCount ?? 0)
  assert.equal(session.deriveMessages().flatMap(message => message.content).map(block => block.text || '').filter(Boolean).join('\n'), 'SUMMARY_TO_KEEP')
  assert.match(JSON.stringify(artifact.events), /OLD_STORY_SHOULD_STAY_ARCHIVED/)
  const brokenRoot = await mkdtemp(join(tmpdir(), 'issue94-refused-'))
  t.after(() => rm(brokenRoot, { recursive: true, force: true }))
  fixture.events.find(event => event.type === 'compaction/summary').data.shadowedRange.end = 999
  const brokenFile = join(brokenRoot, 'session.jsonl.zstd')
  const broken = encodeMigratedSessionLog(JSON.stringify(fixture.header), fixture.events)
  await writeFile(brokenFile, broken)
  const refused = await commitLegacySessionFile(brokenFile, catalog)
  assert.equal(refused.ok, false)
  assert.equal(refused.written, false)
  assert.deepEqual(await readFile(brokenFile), broken)
  assert.equal(existsSync(join(brokenRoot, 'session.v3.jsonl.zstd')), false)
})

test('moving a compacted legacy prefix to system keeps its checkpoint range valid', { skip: !available }, () => {
  const fixture = compactedEditedLegacySession()
  fixture.events[2].data.id = 'tavern-session-prefix:fixture'
  fixture.events[2].data.content = [{ type: 'text', text: 'FIXED_BACKGROUND' }]
  delete fixture.events[2].data.source.fixedSystemText
  const prepared = prepareLegacySessionLog([fixture.header, ...fixture.events].map(row => JSON.stringify(row)).join('\n'), catalog)
  assert.equal(prepared.ok, true, prepared.reason)
  const a = prepared.artifact
  const restored = Session.fromRestore('issue-94', a.events, a.header, a.inheritedEventCount ?? 0)
  const messages = restored.deriveMessages()
  assert.match(JSON.stringify(messages.filter(message => message.role === 'system')), /FIXED_BACKGROUND/)
  assert.equal(messages.filter(message => message.role !== 'system').flatMap(message => message.content).map(block => block.text || '').join('\n'), 'SUMMARY_TO_KEEP')
})
