import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { download, downloadFile, downloadRuntime, DownloadError } = require('../bin/download.cjs')
const moduleFile = fileURLToPath(new URL('../bin/download.cjs', import.meta.url))
const execute = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

// Routes: path -> (req, res) handler. Returns base URL.
async function serve(t, routes) {
  const hits = new Map()
  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url)
    hits.set(url, (hits.get(url) || 0) + 1)
    const handler = routes[url] || routes['*']
    if (!handler) { res.writeHead(404); res.end('missing'); return }
    handler(req, res, hits.get(url))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return { base: `http://127.0.0.1:${server.address().port}`, hits }
}

// Sends `bytes` in `pieces` chunks, one every `interval` ms.
const trickle = (bytes, pieces, interval) => (req, res) => {
  res.writeHead(200, { 'content-length': bytes.length })
  const size = Math.ceil(bytes.length / pieces)
  let offset = 0
  const timer = setInterval(() => {
    if (res.destroyed) { clearInterval(timer); return }
    res.write(bytes.subarray(offset, offset + size)); offset += size
    if (offset >= bytes.length) { clearInterval(timer); res.end() }
  }, interval)
  res.on('close', () => clearInterval(timer))
}
const hang = (req, res) => { res.writeHead(200, { 'content-length': 10 }); res.write('a') }

test('slow but steady transfer outlives the stall window', async t => {
  const bytes = Buffer.alloc(20000, 7)
  const { base } = await serve(t, { '/slow': trickle(bytes, 10, 60) })
  const progress = []
  // Total transfer (~600 ms) is far longer than the 250 ms stall window.
  const { bytes: received } = await download([`${base}/slow`], { stallMs: 250, sha256: sha(bytes), onProgress: p => progress.push(p.received) })
  assert.deepEqual(received, bytes)
  assert.ok(progress.length >= 5 && progress.at(-1) === bytes.length)
})

test('stalled transfer fails over to the next source with a Chinese reason', async t => {
  const bytes = Buffer.from('mirror bytes')
  const { base, hits } = await serve(t, { '/primary': hang, '/mirror': (req, res) => res.end(bytes) })
  const retries = []
  const result = await download([`${base}/primary`, `${base}/mirror`], { stallMs: 150, retryDelayMs: 1, sha256: sha(bytes), onRetry: r => retries.push(r) })
  assert.equal(result.url, `${base}/mirror`)
  assert.equal(hits.get('/primary'), 1)
  assert.match(retries[0].reason, /秒没有收到数据/)
  assert.equal(retries[0].willRetry, true)
})

test('checksum and size mismatches are retried and finally reported', async t => {
  const good = Buffer.from('good')
  const { base } = await serve(t, { '/bad': (req, res) => res.end('evil'), '/good': (req, res) => res.end(good) })
  assert.equal((await download([`${base}/bad`, `${base}/good`], { sha256: sha(good), retryDelayMs: 1 })).url, `${base}/good`)
  await assert.rejects(download([`${base}/bad`], { sha256: sha(good), retryDelayMs: 1 }), error => {
    assert.ok(error instanceof DownloadError)
    assert.match(error.message, /SHA-256 校验不符/)
    assert.equal(error.attempts.length, 2)
    return true
  })
  await assert.rejects(download([`${base}/good`], { size: 99, retryDelayMs: 1, attempts: 1 }), /文件大小不符/)
})

test('HTTP and connection failures keep the attempt history and underlying cause', async t => {
  const { base } = await serve(t, {})
  await assert.rejects(download([`${base}/missing`], { retryDelayMs: 1, attempts: 3 }), error => {
    assert.match(error.message, /missing 下载失败（已尝试 3 次）：HTTP 404/)
    assert.equal(error.cause.status, 404)
    return true
  })
  const closed = createServer()
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve))
  const port = closed.address().port
  await new Promise(resolve => closed.close(resolve))
  await assert.rejects(download([`http://127.0.0.1:${port}/x`], { retryDelayMs: 1, attempts: 1 }), error => {
    assert.match(error.reason, /连接被拒绝（ECONNREFUSED）/)
    assert.ok(error.cause)
    return true
  })
  const cause = new Error('connection reset')
  await assert.rejects(download(['https://example.invalid/a'], { retryDelayMs: 1, attempts: 2, fetch: async () => { throw cause } }),
    error => error.cause === cause && /connection reset/.test(error.message))
})

test('deadline is an upper bound across attempts, not per request', async t => {
  const { base, hits } = await serve(t, { '/slow': trickle(Buffer.alloc(1000), 100, 50) })
  const started = Date.now()
  await assert.rejects(download([`${base}/slow`], { stallMs: 1000, deadlineMs: 300, attempts: 5 }), /超过总时长上限/)
  assert.ok(Date.now() - started < 2000)
  assert.equal(hits.get('/slow'), 1, 'no retry after the deadline')
})

test('downloadFile publishes only complete verified files', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'download-file-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bytes = Buffer.from([0, 1, 2, 255])
  const { base } = await serve(t, { '/ok': (req, res) => res.end(bytes), '/bad': (req, res) => res.end('nope') })
  await downloadFile([`${base}/ok`], path.join(directory, 'nested/ok.bin'), { sha256: sha(bytes) })
  assert.deepEqual(await readFile(path.join(directory, 'nested/ok.bin')), bytes)
  await assert.rejects(downloadFile([`${base}/bad`], path.join(directory, 'bad.bin'), { sha256: sha(bytes), retryDelayMs: 1 }))
  assert.deepEqual((await readdir(directory)).sort(), ['nested'])
})

async function runtimeFixture(t, files, handler) {
  const root = await mkdtemp(path.join(tmpdir(), 'download-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const revision = 'c'.repeat(40)
  const listed = [...files].map(([file, bytes]) => ({ path: file, sha256: sha(bytes), size: bytes.length }))
  listed.push({ path: 'docs/private.md', sha256: 'a'.repeat(64) }, { path: 'patches/../escape.txt', sha256: 'a'.repeat(64) })
  const metadata = { schemaVersion: 2, revision, files: listed }
  const prefix = `/repo@${revision}/`
  const server = await serve(t, {
    '/manifest': (req, res) => res.end(JSON.stringify(metadata)),
    '*': (req, res, count) => {
      const url = decodeURIComponent(req.url)
      const bytes = url.startsWith(prefix) ? files.get(url.slice(prefix.length)) : undefined
      if (!bytes) { res.writeHead(404); res.end(); return }
      handler ? handler(req, res, bytes, url.slice(prefix.length), count) : res.end(bytes)
    },
  })
  return { root, metadata, ...server, args: { metadataUrl: `${server.base}/manifest`, rootUrl: `${server.base}/repo` } }
}

test('runtime download filters, reuses installed files, retries and writes the manifest', async t => {
  const files = new Map(Array.from({ length: 9 }, (_, n) => [`bin/文件 ${n}.js`, Buffer.from(`contents-${n}`)]))
  const { root, metadata, hits, args } = await runtimeFixture(t, files, (req, res, bytes, file, count) => {
    if (file === 'bin/文件 1.js' && count === 1) { res.writeHead(503); res.end(); return }
    res.end(bytes)
  })
  await mkdir(path.join(root, 'installed/bin'), { recursive: true })
  await writeFile(path.join(root, 'installed/bin/文件 0.js'), 'contents-0')
  const status = []
  await downloadRuntime({ ...args, destination: path.join(root, 'out'), installed: path.join(root, 'installed'), status: m => status.push(m) })
  for (const [file, bytes] of files) assert.deepEqual(await readFile(path.join(root, 'out', file)), bytes)
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'out/dsh-tavern-runtime.json'), 'utf8')), metadata)
  assert.equal(hits.get(`/repo@${metadata.revision}/bin/文件 0.js`), undefined, 'verified installed file is reused')
  assert.equal(hits.get(`/repo@${metadata.revision}/bin/文件 1.js`), 2)
  assert.ok(![...hits.keys()].some(url => /docs|escape/.test(url)), 'excluded paths are never requested')
  assert.ok(status.some(m => /HTTP 503.*尝试 1\/2，正在重试/.test(m)))
  assert.match(status.at(-1), /9\/9 文件，复用 1/)
})

test('runtime download stops at the stage budget and reports the fallback', async t => {
  const files = new Map(Array.from({ length: 40 }, (_, n) => [`bin/f${n}.js`, Buffer.from('ok')]))
  const { root, hits, args } = await runtimeFixture(t, files, (req, res, bytes) => setTimeout(() => res.end(bytes), 50))
  await assert.rejects(downloadRuntime({ ...args, destination: path.join(root, 'out'), budgetMs: 120, concurrency: 2 }), /备用源下载超过 0\.1 秒/)
  assert.ok(hits.size - 1 < files.size, 'remaining files are not scheduled after the budget')
})

test('runtime download rejects unsafe manifest entries before writing', async t => {
  const files = new Map([['bin/a.js', Buffer.from('a')], ['bin/evil:name.js', Buffer.from('b')]])
  const { root, args } = await runtimeFixture(t, files)
  await assert.rejects(downloadRuntime({ ...args, destination: path.join(root, 'out') }), /无效文件/)
  await assert.rejects(readdir(path.join(root, 'out')), { code: 'ENOENT' })
})

test('runtime download refuses a manifest that is not the requested target commit', async t => {
  const files = new Map([['bin/a.js', Buffer.from('a')]])
  const { root, metadata, hits, args } = await runtimeFixture(t, files)
  const other = 'f'.repeat(40)
  await assert.rejects(downloadRuntime({ ...args, destination: path.join(root, 'out'), targetCommit: other }), /与目标版本（ffffffffffff）不一致/)
  assert.ok(![...hits.keys()].some(url => url.includes('/bin/')), 'no files are downloaded for a mismatched manifest')
  await downloadRuntime({ ...args, destination: path.join(root, 'out'), targetCommit: metadata.revision.toUpperCase() })
  assert.deepEqual(await readFile(path.join(root, 'out/bin/a.js')), Buffer.from('a'))
})

test('CLI reports failures in Chinese with a nonzero exit code', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'download-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bytes = Buffer.from('cli')
  const { base } = await serve(t, { '/ok': (req, res) => res.end(bytes), '/stall': hang })
  await execute(process.execPath, [moduleFile, 'file', path.join(directory, 'ok'), '--sha256', sha(bytes), `${base}/ok`])
  assert.deepEqual(await readFile(path.join(directory, 'ok')), bytes)
  await assert.rejects(execute(process.execPath, [moduleFile, 'file', path.join(directory, 'stall'), '--stall', '0.2', '--attempts', '1', `${base}/stall`]),
    error => error.code === 1 && /stall 下载失败（已尝试 1 次）：0\.2 秒没有收到数据/.test(error.stderr))
  await assert.rejects(execute(process.execPath, [moduleFile, 'nope']), error => /未知命令/.test(error.stderr))
})

test('runtime download bounds parallel requests and never writes corrupt files', async t => {
  const files = new Map(Array.from({ length: 12 }, (_, n) => [`bin/p${n}.js`, Buffer.from(`p${n}`)]))
  let active = 0, maximum = 0
  const { root, args } = await runtimeFixture(t, files, (req, res, bytes, file) => {
    active++; maximum = Math.max(maximum, active)
    setTimeout(() => { active--; res.end(file === 'bin/p7.js' ? 'corrupt' : bytes) }, 30)
  })
  await assert.rejects(downloadRuntime({ ...args, destination: path.join(root, 'out'), concurrency: 4 }), /bin\/p7\.js 下载失败（已尝试 2 次）：SHA-256 校验不符/)
  assert.ok(maximum > 1 && maximum <= 4, `bounded parallelism: ${maximum}`)
  await assert.rejects(readFile(path.join(root, 'out/bin/p7.js')), { code: 'ENOENT' })
  await assert.rejects(readFile(path.join(root, 'out/dsh-tavern-runtime.json')), { code: 'ENOENT' })
})

test('Windows system proxy becomes standard proxy variables', () => {
  const { proxyEnvironment, applyProxyEnvironment } = require('../bin/download.cjs')
  const windows = settings => ({ platform: 'win32', readSettings: () => settings })
  assert.deepEqual(proxyEnvironment({}, windows({ ProxyEnable: '0x1', ProxyServer: '127.0.0.1:7890', ProxyOverride: 'localhost;127.*;*.lan;intranet;<local>' })), {
    added: { HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1,::1,.lan,intranet', NODE_USE_ENV_PROXY: '1' },
    source: 'system', summary: '127.0.0.1:7890',
  })
  const perScheme = proxyEnvironment({ no_proxy: 'corp' }, windows({ ProxyEnable: '0x1', ProxyServer: 'http=127.0.0.1:8080;https=http://user:pw@10.0.0.2:8443;socks=127.0.0.1:1080' }))
  assert.equal(perScheme.added.HTTP_PROXY, 'http://127.0.0.1:8080')
  assert.equal(perScheme.added.HTTPS_PROXY, 'http://user:pw@10.0.0.2:8443')
  assert.equal(perScheme.added.NO_PROXY, undefined, 'existing NO_PROXY in any case is kept')
  assert.equal(perScheme.summary, '10.0.0.2:8443', 'summary never shows credentials')
  assert.equal(proxyEnvironment({}, windows({ ProxyEnable: '0x1', ProxyServer: 'socks=127.0.0.1:1080' })).source, 'unsupported')
  assert.equal(proxyEnvironment({}, windows({ ProxyEnable: '0x0', ProxyServer: '127.0.0.1:7890', AutoConfigURL: 'http://127.0.0.1/pac' })).source, 'pac')
  assert.deepEqual(proxyEnvironment({}, windows({ ProxyEnable: '0x0', ProxyServer: '127.0.0.1:7890' })), { added: {}, source: null })
  assert.deepEqual(proxyEnvironment({}, { platform: 'win32', readSettings: () => { throw new Error('no reg') } }), { added: {}, source: null })
  assert.deepEqual(proxyEnvironment({}, { platform: 'darwin', readSettings: () => assert.fail('registry is Windows only') }), { added: {}, source: null })
  // A user-provided proxy wins; only Node's opt-in is added.
  assert.deepEqual(proxyEnvironment({ https_proxy: 'http://corp:3128' }, windows({ ProxyEnable: '0x1', ProxyServer: '127.0.0.1:7890' })).added, { NODE_USE_ENV_PROXY: '1' })
  assert.deepEqual(proxyEnvironment({ HTTPS_PROXY: 'http://corp:3128', node_use_env_proxy: '1' }).added, {})
  const env = {}
  applyProxyEnvironment(env, windows({ ProxyEnable: '0x1', ProxyServer: '127.0.0.1:7890' }))
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890')
})

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
// NODE_USE_ENV_PROXY exists since Node 22.21 / 24.0; older Node ignores it (curl and git still use the variables).
test('downloads honour proxy variables through NODE_USE_ENV_PROXY', { skip: nodeMajor === 22 && nodeMinor < 21 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'download-proxy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const seen = []
  const proxy = createServer((req, res) => { seen.push(req.url); res.end('via proxy') })
  // undici tunnels plain HTTP through CONNECT as well; answer with a tiny upstream.
  const upstream = createServer((req, res) => { seen.push(`upstream ${req.url}`); res.end('via proxy') })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  proxy.on('connect', (req, socket) => {
    seen.push(`CONNECT ${req.url}`)
    const target = require('node:net').connect(upstream.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); target.pipe(socket); socket.pipe(target)
    })
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close() })
  const env = { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: '' }
  // An unroutable host proves the request never left through a direct connection.
  await execute(process.execPath, [moduleFile, 'file', path.join(directory, 'out'), '--stall', '5', '--attempts', '1', 'http://unreachable.test/file'], { env })
  assert.equal(await readFile(path.join(directory, 'out'), 'utf8'), 'via proxy')
  assert.ok(seen.some(entry => entry.includes('unreachable.test')), seen.join('\n'))
})
