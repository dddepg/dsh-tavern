import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import test from 'node:test'
import { createMvuDiagnosticStore, createMvuDiagnosticExport, redactDiagnostic, sanitizeModuleFailure, redactMvuLoadError, sanitizeMvuLoadDiagnostic } from '../tavern-plugin/lib/domain/mvu-diagnostics.js'

import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import vm from 'node:vm'

function zipText(buffer) {
  const parts = []
  for (let offset = 0; buffer.readUInt32LE(offset) === 0x04034b50;) {
    const size = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26), extraLength = buffer.readUInt16LE(offset + 28)
    const start = offset + 30 + nameLength + extraLength
    const payload = buffer.subarray(start, start + size)
    const data = buffer.readUInt16LE(offset + 8) === 8 ? inflateRawSync(payload) : payload
    assert.equal(data.length, buffer.readUInt32LE(offset + 22))
    parts.push(buffer.subarray(offset + 30, offset + 30 + nameLength).toString(), data.toString())
    offset = start + size
  }
  return parts.join('\n')
}

function storage() {
  const data = new Map()
  return {
    readJson: async path => structuredClone(data.get(path)),
    updateJson: async (path, update) => { data.set(path, update(data.get(path))); }
  }
}

test('MVU 加载诊断只允许结构字段，错误脱敏、长度受限且随 ZIP 导出', async () => {
  const diagnostic = sanitizeMvuLoadDiagnostic({ phase: 'download-completed', loadId: 'load-1', cycle: 2, attempt: 3,
    httpStatus: 200, contentType: 'application/json', bodyKind: 'json-error', receivedChars: 200,
    serverError: 'ENOENT C:\\Users\\PRIVATE_USER\\bundle.js; apiKey=KEY_SECRET',
    responsePath: '/bundle.js?token=URL_SECRET', message: 'Bearer AUTH_SECRET',
    body: 'DO_NOT_LOG_BODY', source: 'DO_NOT_LOG_SCRIPT', headers: { authorization: 'DO_NOT_LOG_HEADER' }, browser: 'Chromium/128.0' })
  assert.equal(diagnostic.httpStatus, 200)
  assert.equal(diagnostic.cycle, 2)
  assert.match(diagnostic.serverError, /ENOENT/)
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_USER|KEY_SECRET|URL_SECRET|AUTH_SECRET|DO_NOT_LOG/)
  const store = createMvuDiagnosticStore(storage())
  await store.record('s', { stage: 'mvu-load', diagnostic })
  const zip = await createMvuDiagnosticExport({ sessionId: 's', store, environment: { mvuAsset: { phase: 'verify-failed', expectedSha256: 'a'.repeat(64), actualSha256: 'b'.repeat(64) } } })
  assert.match(zipText(zip.buffer), /download-completed/)
  assert.match(zipText(zip.buffer), /verify-failed/)
  assert.doesNotMatch(zipText(zip.buffer), /PRIVATE_USER|DO_NOT_LOG/)
  assert.equal(sanitizeMvuLoadDiagnostic({ phase: 'invented', httpStatus: Infinity }), null)
  assert.ok(JSON.stringify(sanitizeMvuLoadDiagnostic({ phase: 'execution-failed', message: 'x'.repeat(1000000) })).length < 4200)
})

test('真实日志 RPC 保留加载字段；诊断写盘失败不向运行路径抛错', async () => {
  const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
  const start = source.indexOf("case 'recordMvuRuntimeDiagnostic':")
  const end = source.indexOf("case 'getPlayChatDebugTarget':", start)
  const store = createMvuDiagnosticStore(storage())
  const context = { chatHeaderForSession: async id => ({ sessionId: id }), sessionStateForSession: async id => ({ sessionId: id }), str: String, sanitizeMvuLoadDiagnostic, sanitizeModuleFailure, redactMvuLoadError, mvuDiagnostics: store }
  const invoke = vm.runInNewContext('(async function(args){switch("recordMvuRuntimeDiagnostic"){' + source.slice(start, end) + '}})', context)
  const args = { sessionId: 's', diagnostic: { kind: 'mvu-load', phase: 'download-response', httpStatus: 403, contentType: 'text/plain' } }
  assert.equal((await invoke(args)).recorded, true)
  const row = (await store.read('s')).records[0]
  assert.equal(row.stage, 'mvu-load')
  assert.equal(row.diagnostic.httpStatus, 403)
  await invoke({sessionId:'s', diagnostic:{scriptId:'schema',level:'error',message:'模块加载失败',moduleFailure:{phase:'module-load',reason:'http',resources:[{url:'https://cdn.example/a.js?token=PRIVATE',status:404}]}}})
  const moduleRow = (await store.read('s')).records.at(-1)
  assert.equal(moduleRow.diagnostic.moduleFailure.resources[0].status,404)
  assert.doesNotMatch(JSON.stringify(moduleRow),/PRIVATE/)
  context.mvuDiagnostics = { record: async () => { throw Error('disk failure') } }
  assert.equal((await invoke(args)).recorded, false)
})

test('诊断记录持久化、限量，并移除凭据', async () => {
  const data = storage()
  const store = createMvuDiagnosticStore(data, { maxRecords: 3 })
  for (let n = 0; n < 5; n++) await store.record('s1', { stage: 'runtime', diagnosticId: 'op:1', n, apiKey: 'SECRET', message: 'Bearer SECRET https://host/x?token=SECRET' })
  await store.flush()
  const exported = await createMvuDiagnosticStore(data, { maxRecords: 3 }).read('s1')
  assert.equal(exported.records.length, 3)
  assert.equal(exported.dropped, 2)
  assert.doesNotMatch(JSON.stringify(exported), /SECRET/)
  assert.equal((await store.read('s2')).records.length, 0)
  assert.doesNotMatch(JSON.stringify(redactDiagnostic({ Authorization: 'SECRET', nested: { password: 'SECRET' } })), /SECRET/)
  assert.doesNotMatch(redactDiagnostic('request {"apiKey":"SECRET"} https://user:SECRET@host/?signature=SECRET'), /SECRET/)
})

test('诊断包同时导出前台、后台日志和 MVU 记录，缺失日志明确标注', async () => {
  const store = createMvuDiagnosticStore(storage())
  await store.record('s1', { stage: 'submitted', diagnosticId: 'op:1' })
  const flushed = []
  const result = await createMvuDiagnosticExport({
    sessionId: 's1', backgroundSessionIds: ['bg', 'missing'], store,
    sessions: { get: id => ({ id }), flush: async s => flushed.push(s.id) },
    persistence: { readRaw: async id => id === 'missing' ? undefined : { content: JSON.stringify({ type: 'session', id, apiKey: 'SECRET' }) + '\n' } }
  })
  assert.deepEqual(flushed, ['s1', 'bg', 'missing'])
  assert.equal(result.filename, 'dsh-tavern-diagnostics-s1.zip')
  assert.equal(result.buffer.readUInt32LE(0), 0x04034b50)
  const text = zipText(result.buffer)
  assert.match(text, /mvu\/diagnostics.json/)
  assert.match(text, /subagents\/bg\/session.jsonl/)
  assert.match(text, /missing/)
  assert.doesNotMatch(text, /SECRET/)
  const dir = await mkdtemp(join(tmpdir(), 'tavern-log-zip-'))
  try {
    const archive = join(dir, result.filename)
    await writeFile(archive, result.buffer)
    if (process.platform !== 'win32') {
      assert.match(execFileSync('unzip', ['-t', archive], { encoding: 'utf8' }), /No errors detected/)
      const content = execFileSync('unzip', ['-p', archive, 'mvu/diagnostics.json'], { encoding: 'utf8' })
      assert.equal(JSON.parse(content).records[0].stage, 'submitted')
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('真实 iframe bootstrap 捕获 console.warn 和 toastr，带事件编号并限制洪泛', async () => {
  const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  let descriptor
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { descriptor = value } } }, console })
  const client = descriptor.factory(() => ({}))
  const document = client.buildTavernHelperScriptDocument({ token: 'test', scripts: [{ id: 'guard' }], context: { messages: [] } })
  // Execute the production document, replacing only the unrelated packaged module import.
  const bootstrap = document.match(/<script data-dsh-tavern-helper-script>([\s\S]*?)<\/script>/)[1]
    .replace('import(new URL("/api/dsh-tavern/vendor/runtime-assets/zod/index.mjs",document.baseURI).href)', 'Promise.resolve({})')
    .replace('import(new URL("/api/dsh-tavern/vendor/runtime-assets/yaml/index.mjs",document.baseURI).href)', 'Promise.resolve({})')
  const messages = [], listeners = new Map()
  const parent = { postMessage: value => messages.push(value) }
  const sandbox = { parent, console: { info() {}, warn() {}, error() {} }, structuredClone, setTimeout, clearTimeout,
    addEventListener(name, listener) { const list = listeners.get(name) || []; list.push(listener); listeners.set(name, list) }
  }
  sandbox.window = sandbox
  vm.runInNewContext(bootstrap, sandbox)
  sandbox.console.warn('initialization warning')
  assert.equal(messages.at(-1).type, 'dsh-tavern-helper-diagnostic')
  assert.equal(messages.at(-1).eventId, '')
  assert.equal(messages.at(-1).scriptId, '', 'unowned logs do not borrow the last script id')
  const deferredError = new Error('earlier callback')
  deferredError.stack = 'Error: earlier callback\n at run (dsh-tavern-script:previous:1:20)'
  sandbox.console.warn('deferred', deferredError)
  assert.equal(messages.at(-1).scriptId, 'previous')
  const initialDiagnostics = messages.filter(item => item.type === 'dsh-tavern-helper-diagnostic').length
  sandbox.eventOn('MESSAGE_RECEIVED', () => sandbox.toastr.warning('schema rejected'))
  for (const listener of listeners.get('message')) listener({ source: parent, data: { token: 'test', type: 'dsh-tavern-helper-event', eventId: 'event-1', name: 'MESSAGE_RECEIVED', args: [0] } })
  await new Promise(resolve => setImmediate(resolve))
  const warning = messages.find(item => item.message === 'schema rejected')
  assert.equal(warning.eventId, 'event-1')
  assert.equal(warning.scriptId, 'guard')
  const completed = messages.find(item => item.type === 'dsh-tavern-helper-event-complete')
  assert.equal(completed.error, undefined)
  for (let i = 0; i < 100; i++) sandbox.console.warn('repeated')
  assert.ok(messages.filter(item => item.type === 'dsh-tavern-helper-diagnostic').length <= initialDiagnostics + 50)
})

test('诊断包包含界面按钮错误并脱敏', async () => {
  const result = await createMvuDiagnosticExport({ sessionId: 's', store: createMvuDiagnosticStore(storage()), displayDiagnostics: { frames: [{ turn: 1, console: [{ level: 'error', args: [{ message: 'journey failed', token: 'PRIVATE_TOKEN' }] }] }] } })
  assert.match(zipText(result.buffer), /display\/diagnostics.json/)
  assert.match(zipText(result.buffer), /journey failed/)
  assert.doesNotMatch(zipText(result.buffer), /PRIVATE_TOKEN/)
})

test('diagnostic ZIP includes card scripts and bound worldbook with credential redaction', async () => {
  const result = await createMvuDiagnosticExport({ sessionId: 's', store: createMvuDiagnosticStore(storage()), cardDiagnostics: {
    version: 1, source: 'export-time', card: { name: '测试卡', first_mes: '开场' },
    extensions: { helperScripts: [{ id: 'broken-script', content: 'const broken = {;' }], apiKey: 'PRIVATE_CARD_KEY' },
    worldbook: { document: { entries: { 0: { content: '世界书测试内容' } } } }
  } })
  const text = zipText(result.buffer)
  assert.match(text, /card\/context.json/)
  assert.match(text, /const broken = \{;/)
  assert.match(text, /世界书测试内容/)
  assert.doesNotMatch(text, /PRIVATE_CARD_KEY/)
})

test('模块加载详情只保留限量脱敏资源和 HTTP 状态', async () => {
  const detail = sanitizeModuleFailure({ phase:'module-load', reason:'http', message:'Bearer PRIVATE', source:'PRIVATE',
    references:['https://user:PRIVATE@cdn.example/a.js?token=PRIVATE#PRIVATE', 'data:PRIVATE'],
    resources:[{url:'https://cdn.example/b.js?key=PRIVATE',status:404,body:'PRIVATE'}, {url:'https://cdn.example/c.js',status:0}] });
  assert.deepEqual(detail.references,['https://cdn.example/a.js']);
  assert.deepEqual(detail.resources,[{url:'https://cdn.example/b.js',status:404}]);
  assert.doesNotMatch(JSON.stringify(detail),/PRIVATE/);
  const store=createMvuDiagnosticStore(storage());
  await store.record('s',{stage:'script-runtime',diagnostic:{moduleFailure:detail}});
  const zip=await createMvuDiagnosticExport({sessionId:'s',store});
  assert.match(zipText(zip.buffer),/module-load/);
  assert.match(zipText(zip.buffer),/404/);
  assert.doesNotMatch(zipText(zip.buffer),/PRIVATE/);
});

test('诊断包包含本局预设与正则并脱敏，过大时仍可导出其他日志', async () => {
  const result = await createMvuDiagnosticExport({sessionId:'s',store:createMvuDiagnosticStore(storage()),presetDiagnostics:{
    preset:{presetName:'本局预设',apiKey:'PRIVATE_PRESET_KEY'},regex:{ordered:[{source:'preset',rule:{findRegex:'/x/g',replaceString:'<div>状态栏</div>'}}]}
  }})
  const text=zipText(result.buffer)
  assert.match(text,/preset\/context.json/)
  assert.match(text,/本局预设/)
  assert.match(text,/<div>状态栏<\/div>/)
  assert.doesNotMatch(text,/PRIVATE_PRESET_KEY/)
  const large=await createMvuDiagnosticExport({sessionId:'s',store:createMvuDiagnosticStore(storage()),presetDiagnostics:{preset:{content:'x'.repeat(8*1024*1024)}}})
  assert.match(zipText(large.buffer),/预设及正则资料超过 8 MiB/)
  assert.match(zipText(large.buffer),/mvu\/diagnostics.json/)
})
