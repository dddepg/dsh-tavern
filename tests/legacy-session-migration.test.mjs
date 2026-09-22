import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { accessSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { repairMigratedCurrentHeader, decodeSessionLog, encodeCurrentGeneration, encodeMigratedSessionLog, migrateInstalledLegacySessions, migrateLegacySessionDirectory, prepareLegacySessionLog, reframeConcatenatedSessionLog } from '../tavern-plugin/lib/domain/legacy-session-migration.js'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

test('迁移日志的第一帧只有文件头一行', () => {
  const header = '{"version":0,"id":"a"}'
  const events = [{ type: 'step/start', seq: 0 }]
  const bytes = encodeMigratedSessionLog(header, events)
  const text = header + '\n' + JSON.stringify(events[0]) + '\n'
  assert.equal(headerFrameText(bytes), header + '\n')
  assert.equal(decodeSessionLog(bytes), text)
  const collapsed = zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
  const fixed = reframeConcatenatedSessionLog(collapsed)
  assert.equal(headerFrameText(fixed), header + '\n')
  assert.equal(decodeSessionLog(fixed), text)
  assert.equal(reframeConcatenatedSessionLog(bytes), null)
})

test('启动迁移走宿主目录，会话在 data 的上一级', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-startup-migration-'))
  const dataRoot = path.join(root, 'profile-data', 'tavern', 'data')
  await mkdir(path.join(root, 'profile-data', 'tavern', 'sessions'), { recursive: true })
  let calls = 0
  const summary = await migrateInstalledLegacySessions(dataRoot, async () => {
    calls += 1
    return { createRestore() { throw new Error('空目录不应打开会话') } }
  })
  assert.equal(calls, 1)
  assert.deepEqual(summary, { seen: 0, migrated: 0, unchanged: 0, refused: 0 })
})

const hostRoot = '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai'
const archiveRoot = path.join(process.env.HOME, '.dsh-tavern/profile-data/tavern/sessions')
const hostReady = readable(path.join(hostRoot, 'dsh-session/package.json'))
const archiveReady = readable(archiveRoot)

test('存档副本迁移后能用 0.1.5-rc.2 打开，原档不变', { skip: !hostReady || !archiveReady, timeout: 180000 }, async t => {
  const require = createRequire(path.join(hostRoot, 'dsh-session/package.json'))
  const version = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8')).version
  assert.equal(version, '0.1.5-rc.2')
  const { sessionFormatCatalog } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
  const allSources = await walk(archiveRoot)
  const sources = allSources.filter(file => path.basename(file) === 'session.jsonl.zstd')
  const generations = allSources.filter(file => ['session.jsonl.zstd','session.v3.jsonl.zstd'].includes(path.basename(file)))
  assert.ok(sources.length > 0)
  const sourceHashes = new Map(await Promise.all(sources.map(async file => [file, hash(await readFile(file))])))
  const copyRoot = await mkdtemp(path.join(tmpdir(), 'tavern-legacy-sessions-'))
  t.after(() => rm(copyRoot, { recursive: true, force: true }))
  await cp(archiveRoot, copyRoot, { recursive: true })
  // Re-exercise migration even when the live profile has already migrated.
  for (const source of sources) {
    const copied = path.join(copyRoot, path.relative(archiveRoot, source))
    if (readable(copied + '.bak-tavern-premigrate')) await cp(copied + '.bak-tavern-premigrate', copied)
    await rm(path.join(path.dirname(copied), 'session.v3.jsonl.zstd'), { force: true })
  }
  const summary = await migrateLegacySessionDirectory(copyRoot, sessionFormatCatalog)
  assert.ok(summary.migrated > 0, '没有任何副本完成迁移')
  const copies = (await walk(copyRoot)).filter(file => path.basename(file) === 'session.jsonl.zstd')
  let reopened = 0
  let cleanedUnopenable = 0
  for (const file of copies) {
    const bytes = await readFile(file)
    const prepared = prepareLegacySessionLog(decodeSessionLog(bytes), sessionFormatCatalog)
    if (!prepared.ok) {
      const backup = file + '.bak-tavern-premigrate'
      assert.equal(readable(backup), false)
      continue
    }
    assert.equal(prepared.changed, false)
    if (!prepared.artifact) {
      // Issue #72 C: illegal source keys stripped, host still cannot open.
      assert.ok(prepared.reason)
      cleanedUnopenable += 1
      continue
    }
    assert.equal(prepared.artifact.header.version, 3)
    reopened += 1
    if (readable(file + '.bak-tavern-premigrate')) {
      const backupText = decodeSessionLog(await readFile(file + '.bak-tavern-premigrate'))
      const original = prepareLegacySessionLog(backupText, sessionFormatCatalog)
      assert.equal(original.ok, true)
      if (original.artifact) assert.equal(original.artifact.header.version, 3)
    }
  }
  assert.ok(reopened > 0)
  assert.ok(cleanedUnopenable >= 0)
  // v3-only archives also participate in header repair; do not count them as v0 reopens.
  assert.equal(summary.seen, summary.migrated + summary.unchanged + summary.refused)
  for (const [file, digest] of sourceHashes) assert.equal(hash(await readFile(file)), digest)
  assert.equal(summary.seen, new Set(generations.map(file=>path.dirname(file))).size)
})

function headerFrameText(bytes) {
  const frames = []
  let offset = 0
  const start = offset
  offset += 4
  const descriptor = bytes.readUInt8(offset)
  offset += 1
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 32) !== 0
  const checksum = (descriptor & 4) !== 0
  const dictionaryFlag = descriptor & 3
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag
  offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  for (;;) {
    const blockHeader = bytes.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 3
    const blockSize = blockHeader >>> 3
    offset += blockType === 1 ? 1 : blockSize
    if (lastBlock) break
  }
  if (checksum) offset += 4
  frames.push({ start, end: offset })
  return zstdDecompressSync(bytes.subarray(frames[0].start, frames[0].end)).toString('utf8')
}

function readable(file) {
  try { accessSync(file); return true } catch { return false }
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function walk(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) await walk(target, files)
    else files.push(target)
  }
  return files
}


test('发布的 v3 文件头必须能被宿主列表读取', {skip:!hostReady}, async()=>{
 const require=createRequire(path.join(hostRoot,'dsh-session/package.json'))
 const {sessionFormatCatalog:catalog}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
 const header={version:3,id:'test-migrated',createdAt:1,cwd:'/tmp/test',isSeeded:false,delegationDepth:0,agentPreset:'tavern'}
 const bytes=encodeCurrentGeneration({header,events:[],inheritedEventCount:0},catalog)
 const stored=JSON.parse(decodeSessionLog(bytes).trim())
 assert.equal(catalog.readHeader(stored).status,'current')
 assert.equal(stored.type,'session')
})


test('修复已存在的错误 v3 头，保留备份并可重复执行', {skip:!hostReady}, async t=>{
 const require=createRequire(path.join(hostRoot,'dsh-session/package.json'))
 const {sessionFormatCatalog:catalog}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
 const root=await mkdtemp(path.join(tmpdir(),'tavern-header-repair-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const file=path.join(root,'session.v3.jsonl.zstd')
 const header={version:3,id:'test-migrated',createdAt:1,cwd:'/tmp/test',isSeeded:false,delegationDepth:0,agentPreset:'tavern'}
 const original=encodeMigratedSessionLog(JSON.stringify(header),[])
 await writeFile(file,original)
 const result=await migrateLegacySessionDirectory(root,catalog)
 assert.equal(result.migrated,1)
 assert.equal(catalog.readHeader(JSON.parse(decodeSessionLog(await readFile(file)).trim())).status,'current')
 assert.deepEqual(await readFile(file+'.bak-tavern-header'),original)
 assert.equal(await repairMigratedCurrentHeader(file,catalog),false)
})

test('issue #71: 含 fixedSystemText 的真实旧档清理后可被宿主打开并落盘', { skip: !hostReady || !archiveReady }, async t => {
  const require = createRequire(path.join(hostRoot, 'dsh-session/package.json'))
  const { sessionFormatCatalog: catalog } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
  const sources = (await walk(archiveRoot)).filter(file => path.basename(file).includes('session.jsonl.zstd'))
  let sample
  for (const file of sources) {
    const candidate = readable(file + '.bak-tavern-premigrate') ? file + '.bak-tavern-premigrate' : file
    let text
    try { text = decodeSessionLog(await readFile(candidate)) } catch { continue }
    if (!text.includes('"fixedSystemText"')) continue
    sample = { file: candidate, text }
    break
  }
  assert.ok(sample, '本地没有含 fixedSystemText 的旧档样本')
  const lines = sample.text.split('\n').filter(Boolean)
  const header = JSON.parse(lines[0])
  const events = lines.slice(1).map(line => JSON.parse(line))
  assert.throws(() => {
    const dirty = catalog.createRestore(header, { recovery: 'recoverable', validation: 'current' })
    for (const event of structuredClone(events)) dirty.decodeRow(event)
    dirty.finish()
  }, /fixedSystemText/)

  const prepared = prepareLegacySessionLog(sample.text, catalog)
  assert.equal(prepared.ok, true)
  assert.equal(prepared.changed, true)
  assert.equal(prepared.artifact.header.version, 3)
  assert.equal(JSON.stringify(prepared.events).includes('fixedSystemText'), false)

  const root = await mkdtemp(path.join(tmpdir(), 'tavern-fixed-system-text-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = path.join(root, 'session-fixed-system-text')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'session.jsonl.zstd')
  await writeFile(file, await readFile(sample.file))
  const summary = await migrateLegacySessionDirectory(root, catalog)
  assert.equal(summary.migrated, 1)
  assert.equal(readable(path.join(dir, 'session.v3.jsonl.zstd')), true)
  assert.equal(JSON.stringify(decodeSessionLog(await readFile(file))).includes('fixedSystemText'), false)
  const again = prepareLegacySessionLog(decodeSessionLog(await readFile(file)), catalog)
  assert.equal(again.ok, true)
  assert.equal(again.changed, false)
})

function mockCatalog(openOk = true) {
  return {
    createRestore(header) {
      return {
        decodeRow() {
          if (!openOk) throw new Error('host rejects archive')
        },
        finish() {
          if (!openOk) throw new Error('host rejects archive')
          return { header: { ...header, version: 3 }, events: [], inheritedEventCount: 0 }
        },
      }
    },
  }
}

function v0Log(events) {
  return JSON.stringify({ version: 0, id: 'issue-72', createdAt: 1, cwd: '/tmp', isSeeded: false }) + '\n' +
    events.map(event => JSON.stringify(event)).join('\n') + '\n'
}

test('issue #72 A: fold keeps tavern-body-edit id on the target assistant', () => {
  const text = v0Log([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 1, surfaceOp: { op: 'append' }, data: { id: 'u', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 3, time: 1, surfaceOp: { op: 'append' }, data: { turn: 1, step: 1, message: { id: 'reply', role: 'assistant', content: [{ type: 'text', text: '旧正文' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } } } },
    { type: 'assistant/message', seq: 4, time: 1, surfaceOp: { op: 'replace', start: 3, end: 3 }, sourceEventSeqs: [3], data: { turn: 1, step: 1, message: { id: 'tavern-body-edit:abc', role: 'assistant', content: [{ type: 'text', text: '新正文' }], source: { kind: 'model', provider: 'dsh-tavern', model: 'body-edit' } } } },
    { type: 'step/end', seq: 5, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const prepared = prepareLegacySessionLog(text, mockCatalog())
  assert.equal(prepared.ok, true)
  assert.equal(prepared.changed, true)
  const assistants = prepared.events.filter(event => event.type === 'assistant/message')
  assert.equal(assistants.length, 1)
  assert.equal(assistants[0].data.message.id, 'tavern-body-edit:abc')
  assert.equal(assistants[0].data.message.content[0].text, '新正文')
})

test('issue #72 B: compaction shadowedSeqs with missing seqs soft-remap instead of refuse', () => {
  const text = v0Log([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 1, surfaceOp: { op: 'append' }, data: { id: 'u', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 3, time: 1, surfaceOp: { op: 'append' }, data: { turn: 1, step: 1, message: { id: 'reply', role: 'assistant', content: [{ type: 'text', text: '正文' }], source: { kind: 'model', provider: 'fixture', model: 'fixture', fixedSystemText: 'force-clean' } } } },
    { type: 'compaction/summary', seq: 4, time: 1, data: { compactionId: 'c1', shadowedSeqs: [99, 3], messageSeqs: [99, 3] } },
    { type: 'step/end', seq: 5, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const prepared = prepareLegacySessionLog(text, mockCatalog())
  assert.equal(prepared.ok, true)
  assert.equal(prepared.changed, true)
  const summary = prepared.events.find(event => event.type === 'compaction/summary')
  assert.ok(summary)
  assert.equal(summary.data.shadowedSeqs.length, 1)
  assert.ok(!summary.data.shadowedSeqs.includes(99))
})

test('issue #72 C: sanitize still writes cleaned events when host open fails', () => {
  const text = v0Log([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 1, surfaceOp: { op: 'append' }, data: { id: 'u', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 3, time: 1, surfaceOp: { op: 'append' }, data: { turn: 1, step: 1, message: { id: 'reply', role: 'assistant', content: [{ type: 'text', text: '正文' }], source: { kind: 'model', provider: 'fixture', model: 'fixture', fixedSystemText: 'illegal' } } } },
    { type: 'step/end', seq: 4, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const prepared = prepareLegacySessionLog(text, mockCatalog(false))
  assert.equal(prepared.ok, true)
  assert.equal(prepared.changed, true)
  assert.equal(prepared.artifact, undefined)
  assert.equal(JSON.stringify(prepared.events).includes('fixedSystemText'), false)
  assert.ok(prepared.reason)
})

function chronologyCatalog() {
  const surface = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])
  return {
    createRestore(header) {
      const rows = []
      return {
        decodeRow(event) { rows.push(event) },
        finish() {
          const step = rows.findIndex(event => event.type === 'step/start')
          if (step >= 0 && rows.slice(0, step).some(event => surface.has(event.type))) {
            throw new Error('format v2 surface before first step cannot acquire a system head without changing chronology')
          }
          if (rows.some(event => String(event.type).startsWith('compaction/'))) {
            throw new Error('compaction/summary shadowedRange start must identify an earlier event')
          }
          if (rows.some(event => event.type === 'assistant/message' && event.surfaceOp?.op === 'replace')) {
            throw new Error('assistant/message chunk provenance is not one complete ordered attempt')
          }
          return { header: { ...header, version: 3 }, events: rows, inheritedEventCount: 0 }
        },
      }
    },
  }
}

test('issue #73: surface-before-step rewrite survives by dropping compaction conflicts', () => {
  const text = v0Log([
    { type: 'permission/preset', seq: 0, time: 1, data: {} },
    { type: 'user/message', seq: 1, time: 1, surfaceOp: { op: 'append' }, data: { id: 'u0', role: 'user', content: [{ type: 'text', text: '开场' }], source: { kind: 'user', fixedSystemText: 'illegal' } } },
    { type: 'assistant/message', seq: 2, time: 1, surfaceOp: { op: 'append' }, data: { turn: 1, step: 1, message: { id: 'a0', role: 'assistant', content: [{ type: 'text', text: '开场答' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } } } },
    { type: 'turn/start', seq: 3, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 4, time: 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 5, time: 1, surfaceOp: { op: 'append' }, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 6, time: 1, surfaceOp: { op: 'append' }, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '正文' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } } } },
    { type: 'compaction/summary', seq: 7, time: 1, data: { compactionId: 'c1', shadowedRange: { start: 99, end: 99 }, shadowedSeqs: [99] } },
    { type: 'step/end', seq: 8, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 9, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const prepared = prepareLegacySessionLog(text, chronologyCatalog())
  assert.equal(prepared.ok, true)
  assert.equal(prepared.changed, true)
  assert.equal(prepared.artifact?.header?.version, 3)
  const step = prepared.events.findIndex(event => event.type === 'step/start')
  assert.ok(step >= 0)
  assert.equal(prepared.events.slice(0, step).some(event => ['user/message', 'assistant/message'].includes(event.type)), false)
  assert.equal(prepared.events.some(event => String(event.type).startsWith('compaction/')), false)
  assert.equal(JSON.stringify(prepared.events).includes('fixedSystemText'), false)
})

test('issue #73: chunk-swarm assistant replaces are dropped so open can finish', () => {
  const text = v0Log([
    { type: 'user/message', seq: 0, time: 1, surfaceOp: { op: 'append' }, data: { id: 'u0', role: 'user', content: [{ type: 'text', text: '开场' }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: 1, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 3, time: 1, surfaceOp: { op: 'append' }, data: { turn: 1, step: 1, message: { id: 'a0', role: 'assistant', content: [{ type: 'text', text: '旧' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } } } },
    { type: 'assistant/chunk', seq: 4, time: 1, data: { text: 'x' } },
    { type: 'assistant/message', seq: 5, time: 1, surfaceOp: { op: 'replace', start: 3, end: 4 }, sourceEventSeqs: [3, 4], data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '新' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } } } },
    { type: 'step/end', seq: 6, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 7, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const prepared = prepareLegacySessionLog(text, chronologyCatalog())
  assert.equal(prepared.ok, true)
  assert.equal(prepared.artifact?.header?.version, 3)
  assert.equal(prepared.events.some(event => event.type === 'assistant/message' && event.surfaceOp?.op === 'replace'), false)
})

test('issue #73: local surface-before-step archives open to v3', { skip: !hostReady || !archiveReady, timeout: 120000 }, async () => {
  const require = createRequire(path.join(hostRoot, 'dsh-session/package.json'))
  const { sessionFormatCatalog: catalog } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
  const surface = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])
  const sources = (await walk(archiveRoot)).filter(file => path.basename(file) === 'session.jsonl.zstd')
  let seen = 0, opened = 0
  for (const file of sources) {
    const candidate = readable(file + '.bak-tavern-premigrate') ? file + '.bak-tavern-premigrate' : file
    let text
    try { text = decodeSessionLog(await readFile(candidate)) } catch { continue }
    const rows = text.split('\n').filter(Boolean).slice(1).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
    const step = rows.findIndex(event => event.type === 'step/start')
    if (step < 0 || !rows.slice(0, step).some(event => surface.has(event.type))) continue
    seen += 1
    const prepared = prepareLegacySessionLog(text, catalog)
    if (prepared.artifact?.header?.version === 3) opened += 1
  }
  assert.ok(seen > 0, '本地没有 surface-before-step 旧档样本')
  assert.equal(opened, seen)
})
