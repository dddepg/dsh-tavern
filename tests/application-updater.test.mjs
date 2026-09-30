import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import test, { beforeEach, afterEach, mock } from 'node:test'

import { createApplicationUpdater as createUpdater, sanitizeUpdateError } from '../tavern-plugin/lib/application-updater.js'

// Never let fixtures accidentally consume a real release. Local HTTP fixtures
// still exercise the production fetch path; every other request fails the test,
// even if the updater catches the error and falls back to another source.
const nativeFetch = globalThis.fetch
let unexpectedRequests = []
beforeEach(() => {
  unexpectedRequests = []
  mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return nativeFetch(input, init)
    unexpectedRequests.push(url.origin + url.pathname)
    throw new Error('External network is disabled in updater tests')
  })
})
afterEach(() => {
  mock.restoreAll()
  assert.deepEqual(unexpectedRequests, [], '更新器测试必须显式模拟远端请求')
})

function createApplicationUpdater(options) {
  return createUpdater({
    // Most fixtures model a direct child; Windows broker fixtures opt in below.
    platform: 'linux',
    // CDN fallback is explicit in each fixture; never fetch live metadata.
    fetchCdnMetadata: async () => { throw new Error('CDN unavailable in GitHub fixture') },
    ...options,
  })
}

const knownIdentity = { currentVersion: '1.1.0', currentCommit: 'a'.repeat(40) }
const verifiedUpdate = {
  readLocalIdentity: async () => knownIdentity,
  fetchManifest: async () => ({ version: '1.1.0' }),
  fetchLatestCommit: async () => 'b'.repeat(40),
  compareCommits: async () => 'ahead',
}

test('standard plugin installation delegates updates to DSH without fetching or rewriting package files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tavern-package-updater-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = path.join(root, 'profiles/tavern')
  await mkdir(profile, { recursive: true })
  const manifest = JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-profile-tavern'] } } })
  await writeFile(path.join(profile, 'package.json'), manifest)
  const updater = createApplicationUpdater({
    sourceRoot: root, dshHome: root, dataRoot: path.join(root, 'profile-data/tavern/data'),
    readLocalIdentity: async () => knownIdentity,
    fetchManifest() { assert.fail('package-managed updates must not fetch source releases') },
    spawnProcess() { assert.fail('legacy updater must not touch package-manager installations') },
  })
  const status = await updater.status()
  assert.equal(status.phase, 'package-managed')
  assert.equal(status.currentVersion, knownIdentity.currentVersion)
  assert.match(status.updateCommand, /^dsh plugin --profile tavern add github:/)
  assert.deepEqual(await updater.check(), status)
  await assert.rejects(updater.start(), /DSH 插件管理器安装/)
  assert.equal(await readFile(path.join(profile, 'package.json'), 'utf8'), manifest)
})

test('真实 Git 历史可离线识别新旧，包括 archive 安装的 bare source-cache', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-tavern-order-git-'))
  try {
    const repo = path.join(root, 'repo')
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git('init', repo)
    git('-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'old')
    const old = git('-C', repo, 'rev-parse', 'HEAD')
    git('-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'new')
    const recent = git('-C', repo, 'rev-parse', 'HEAD')
    const dshHome = path.join(root, 'dsh')
    await mkdir(path.join(dshHome, 'source-cache'), { recursive: true })
    git('clone', '--bare', repo, path.join(dshHome, 'source-cache/dsh-tavern.git'))
    for (const sourceRoot of [repo, root]) {
      for (const [currentCommit, latestCommit, expected] of [[old, recent, 'update-available'], [recent, old, 'up-to-date']]) {
        const updater = createApplicationUpdater({
          dataRoot: path.join(root, 'data'), sourceRoot, dshHome, runtimeHost: 'desktop',
          readLocalIdentity: async () => ({ currentVersion: '1.1.0', currentCommit }),
          fetchManifest: async () => ({ version: '1.1.0' }), fetchLatestCommit: async () => latestCommit,
          compareUrl: 'http://127.0.0.1:1/no-network-expected',
          fetchCdnMetadata: async () => { throw new Error('no fallback expected') },
        })
        assert.equal((await updater.check()).phase, expected)
      }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('无 Git 的安装使用提交比较接口，校验比较方向并处理限流及错误响应', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-tavern-order-api-'))
  const currentCommit = 'a'.repeat(40)
  const latestCommit = 'b'.repeat(40)
  let status = 'ahead'
  let base = currentCommit
  let code = 200
  const urls = []
  const server = createServer((req, res) => {
    urls.push(req.url)
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status, base_commit: { sha: base } }))
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const updater = createApplicationUpdater({
      dataRoot: path.join(root, 'data'), sourceRoot: root, dshHome: root, runtimeHost: 'desktop',
      readLocalIdentity: async () => ({ currentVersion: '1.1.0', currentCommit }),
      fetchManifest: async () => ({ version: '1.1.0' }), fetchLatestCommit: async () => latestCommit,
      compareUrl: `http://127.0.0.1:${server.address().port}/compare`,
      fetchCdnMetadata: async () => { throw new Error('offline') },
      spawnProcess() { assert.fail('不应启动安装') },
    })
    for (const [relation, expected] of [['ahead', 'update-available'], ['behind', 'up-to-date'], ['diverged', 'check-failed'], ['nonsense', 'check-failed']]) {
      status = relation
      assert.equal((await updater.check()).phase, expected)
    }
    status = 'ahead'
    base = latestCommit
    assert.equal((await updater.check()).phase, 'check-failed')
    base = currentCommit
    code = 403
    assert.equal((await updater.check()).phase, 'check-failed')
    await assert.rejects(() => updater.start(), /尚未开始下载/)
    assert.ok(urls.length >= 7)
    assert.ok(urls.every(url => url === `/compare/${currentCommit}...${latestCommit}`))
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})

test('GitHub 路径的较高版本号不能绕过提交先后判断，未知本地构建不能盲目安装', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-tavern-order-version-'))
  try {
    const common = {
      ...verifiedUpdate, dataRoot: path.join(root, 'data'), sourceRoot: root, runtimeHost: 'desktop',
      fetchManifest: async () => ({ version: '99.0.0' }), compareCommits: async () => 'behind',
      spawnProcess() { assert.fail('不能启动安装') },
    }
    assert.equal((await createApplicationUpdater(common).start()).phase, 'up-to-date')
    const unknown = createApplicationUpdater({ ...common, readLocalIdentity: async () => ({ currentVersion: 'unknown', currentCommit: '' }) })
    assert.equal((await unknown.check()).phase, 'check-failed')
    await assert.rejects(() => unknown.start(), /尚未开始下载/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('旧算法的更新提示失效，新算法已核验的提示跨重启保留，本地改变后失效', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-tavern-order-cache-'))
  try {
    const dataRoot = path.join(root, 'data')
    await mkdir(dataRoot)
    await writeFile(path.join(dataRoot, 'update-status.json'), JSON.stringify({ phase: 'update-available', ...knownIdentity, latestCommit: 'b'.repeat(40) }))
    const options = { ...verifiedUpdate, dataRoot, sourceRoot: root, runtimeHost: 'desktop' }
    const updater = createApplicationUpdater(options)
    assert.equal((await updater.status()).phase, 'idle')
    assert.equal((await updater.check()).phase, 'update-available')
    assert.equal((await createApplicationUpdater(options).status()).phase, 'update-available')
    const changed = createApplicationUpdater({ ...options, readLocalIdentity: async () => ({ ...knownIdentity, currentCommit: 'c'.repeat(40) }) })
    assert.equal((await changed.status()).phase, 'idle')
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const source of ['github']) {
  for (const relation of ['behind', 'diverged', 'unavailable', 'ahead']) {
    test(`${source} 根据提交先后判断更新：${relation}，检查和安装使用同一保护`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-tavern-update-order-'))
      try {
        const currentCommit = '59aabc3ac90055e017065fceb1d0855fc94ad60e'
        const latestCommit = '5f68b3423908a593239a19e07359cef5d53aaaab'
        await writeFile(path.join(root, 'package.json'), '{"version":"1.1.0"}')
        let spawned = 0
        const updater = createApplicationUpdater({
          dataRoot: path.join(root, 'data'), sourceRoot: root, runtimeHost: 'desktop',
          readLocalIdentity: async () => ({ currentVersion: '1.1.0', currentCommit }),
          fetchManifest: async () => {
            if (source === 'jsdelivr') throw new Error('offline')
            return { version: '1.1.0' }
          },
          fetchLatestCommit: async () => latestCommit,
          fetchCdnMetadata: async () => {
            if (source === 'github') throw new Error('offline')
            return { revision: latestCommit, files: [{ path: 'package.json', sha256: 'a'.repeat(64) }] }
          },
          compareCommits: async (current, latest) => {
            assert.equal(current, currentCommit)
            assert.equal(latest, latestCommit)
            if (relation === 'unavailable') throw new Error('无法确认提交先后')
            return relation
          },
          spawnProcess() { spawned += 1; return { unref() {} } },
        })
        const checked = await updater.check()
        assert.equal(checked.phase, relation === 'ahead' ? 'update-available' : relation === 'behind' ? 'up-to-date' : 'check-failed')
        if (relation === 'unavailable' || relation === 'diverged') {
          await assert.rejects(() => updater.start(), /尚未开始下载/)
        } else {
          assert.equal((await updater.start()).phase, relation === 'ahead' ? 'running' : 'up-to-date')
        }
        assert.equal(spawned, relation === 'ahead' ? 1 : 0)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
}

test('jsDelivr 发布序号阻止缓存倒退，并允许无 GitHub 更新', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-tavern-updater-cdn-'))
  try {
    const packageText = JSON.stringify({ version: '0.7.2' })
    await writeFile(path.join(root, 'package.json'), packageText)
    await writeFile(path.join(root, 'dsh-tavern-runtime.json'), JSON.stringify({
      schemaVersion: 2, revision: 'a'.repeat(40), releaseSequence: 42, version: '0.7.2',
      files: [{ path: 'package.json', sha256: createHash('sha256').update(packageText).digest('hex') }],
    }))
    const metadata = {
      schemaVersion: 2, revision: '9'.repeat(40), releaseSequence: 43, version: '0.7.2',
      files: [{ path: 'package.json', sha256: createHash('sha256').update(packageText).digest('hex') }],
    }
    const common = {
      dataRoot: path.join(root, 'data'), sourceRoot: root, runtimeHost: 'cli',
      fetchManifest: async () => { throw new Error('fetch failed') },
      fetchLatestCommit: async () => { throw new Error('fetch failed') },
      fetchCdnMetadata: async () => metadata,
      compareCommits: async () => { throw new Error('GitHub 不应参与 CDN 发布序号判断') },
      now: () => 321,
    }
    const current = await createApplicationUpdater(common).check()
    assert.equal(current.phase, 'check-failed')
    assert.match(current.error, /无法确认最新版本/)

    metadata.files[0].sha256 = createHash('sha256').update('new package').digest('hex')
    metadata.releaseSequence = 41
    assert.equal((await createApplicationUpdater(common).check()).phase, 'check-failed')

    metadata.releaseSequence = 43
    const child = { pid: 4321, once(event, listener) { if (event === 'spawn') queueMicrotask(listener); return this }, unref() {} }
    const changed = await createApplicationUpdater({ ...common, platform: 'linux', spawnProcess() { return child } }).start()
    assert.equal(changed.phase, 'running')
    assert.equal(changed.checkSource, 'jsdelivr')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('乱码更新错误替换为可执行的重新安装提示', () => {
  assert.equal(sanitizeUpdateError('�������� DSH Tavern����'), '更新失败：安装程序输出编码异常。建议重新安装一次。')
  assert.equal(sanitizeUpdateError('服务启动失败'), '服务启动失败')
})

test('更新任务正在运行时拒绝重复启动', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-tavern-updater-'))
  try {
    const dataRoot = path.join(root, 'profile-data/tavern/data')
    const profileManifest = path.join(root, 'profiles/tavern/package.json')
    await mkdir(path.dirname(profileManifest), { recursive: true })
    await writeFile(profileManifest, JSON.stringify({ dshTavern: { host: 'cli' } }))
    let spawned = 0
    const updater = createApplicationUpdater({
      ...verifiedUpdate,
      dataRoot,
      sourceRoot: '/app/dsh-tavern',
      dshHome: root,
      spawnProcess() { spawned += 1; return { once(event, listener) { if (event === 'spawn') queueMicrotask(listener); return this }, unref() {} } },
      now: () => 1000,
    })

    await updater.start()
    await assert.rejects(() => updater.start(), /更新正在进行/)
    assert.equal(spawned, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('更新诊断跨检查保留回退和网络原因，并可在重启后读取', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tavern-update-diagnostics-'))
  try {
    const options = { dataRoot: root, sourceRoot: root, runtimeHost: 'desktop', ...verifiedUpdate,
      fetchCdnMetadata: async () => { throw new Error('清单缺少发布序号') },
      fetchManifest: async () => { throw Object.assign(new Error('fetch failed https://user:secret@example.test/meta?token=secret'), { cause: Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }) }) },
    }
    const updater = createApplicationUpdater(options)
    assert.equal((await updater.check()).phase, 'check-failed')
    const recovered = createApplicationUpdater({ ...options, fetchManifest: verifiedUpdate.fetchManifest })
    assert.equal((await recovered.check()).phase, 'update-available')
    const records = recovered.diagnostics().records
    assert.equal(new Set(records.filter(r => r.event === 'check.started').map(r => r.attemptId)).size, 2)
    assert.ok(records.some(r => r.event === 'fallback.cdn'))
    assert.ok(records.some(r => r.event === 'github.version.failed' && r.cause.code === 'ETIMEDOUT' && r.durationMs >= 0))
    assert.ok(records.some(r => r.event === 'status' && r.phase === 'check-failed'))
    assert.ok(records.some(r => r.event === 'status' && r.phase === 'update-available'))
    assert.ok(!JSON.stringify(records).includes('secret'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const mode of ['relative-loose', 'absolute-packed', 'detached']) test('Git worktree 正确读取独立 HEAD 与共享 refs：' + mode, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-tavern-updater-worktree-'))
  try {
    const source = path.join(root, 'checkout')
    const common = path.join(root, 'repository.git')
    const metadata = path.join(common, 'worktrees', 'trial')
    const commit = 'd'.repeat(40)
    await mkdir(source, { recursive: true })
    await mkdir(metadata, { recursive: true })
    await mkdir(path.join(common, 'refs', 'heads'), { recursive: true })
    await writeFile(path.join(source, '.git'), 'gitdir: ' + (mode.startsWith('absolute') ? metadata : path.relative(source, metadata)) + '\n')
    await writeFile(path.join(metadata, 'commondir'), '../..\n')
    await writeFile(path.join(metadata, 'HEAD'), mode === 'detached' ? commit + '\n' : 'ref: refs/heads/trial\n')
    if (mode.endsWith('packed')) await writeFile(path.join(common, 'packed-refs'), commit + ' refs/heads/trial\n')
    else await writeFile(path.join(common, 'refs', 'heads', 'trial'), commit + '\n')
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ version: '0.7.2' }))
    const updater = createApplicationUpdater({ dataRoot: path.join(root, 'data'), sourceRoot: source, runtimeHost: 'android',
      fetchManifest: async () => ({ version: '0.7.2' }), fetchLatestCommit: async () => commit })
    const result = await updater.check()
    assert.equal(result.phase, 'up-to-date')
    assert.equal(result.currentCommit, commit)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('历史更新记录的宿主不覆盖当前运行环境', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tavern-runtime-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.7.0' }))
  for (const [runtimeHost, cachedHost] of [['cli', 'desktop'], ['desktop', 'cli']]) {
    await writeFile(path.join(root, 'update-status.json'), JSON.stringify({ phase: 'up-to-date', host: cachedHost }))
    const updater = createApplicationUpdater({ dataRoot: root, sourceRoot: root, runtimeHost })
    const status = await updater.status()
    assert.equal(status.host, runtimeHost)
    assert.equal(status.phase, 'idle')
  }
})

test('Windows helper 启动失败立即持久化错误，不伪报已开始更新', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'update-helper-error-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const updater = createApplicationUpdater({ ...verifiedUpdate, dataRoot: root, sourceRoot: root, dshHome: root, platform: 'win32',
    spawnProcess() {
      const child = new EventEmitter()
      child.stderr = new EventEmitter()
      child.unref = () => {}
      queueMicrotask(() => { child.emit('spawn'); child.stderr.emit('data', Buffer.from('Windows 更新器启动失败：WMI 访问被拒绝')); child.emit('close', 1) })
      return child
    },
  })
  await assert.rejects(updater.start, /WMI 访问被拒绝/)
  const saved = JSON.parse(await readFile(path.join(root, 'update-status.json'), 'utf8'))
  assert.equal(saved.phase, 'failed')
  assert.match(saved.error, /WMI 访问被拒绝/)
})

test('安装进程中断后即使源码已是目标提交也必须允许修复安装', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'update-interrupted-repair-'))
  t.after(() => rm(root, {recursive:true, force:true}))
  await writeFile(path.join(root, 'update-status.json'), JSON.stringify({phase:'running', host:'cli', startedAt:1000, pid:4321}))
  let spawned = 0
  const updater = createApplicationUpdater({...verifiedUpdate, dataRoot:root, sourceRoot:root, dshHome:root,
    fetchLatestCommit:async () => knownIdentity.currentCommit,
    compareCommits:async () => 'identical', isProcessAlive:() => false,
    spawnProcess() { spawned++; return {unref(){}} },
  })
  assert.equal((await updater.status()).repairRequired, true)
  assert.equal((await updater.start()).phase, 'running')
  assert.equal(spawned, 1)
})
