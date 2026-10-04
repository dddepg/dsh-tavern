import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const modulePath = fileURLToPath(new URL('../bin/installation-state.cjs', import.meta.url))
const { acquireInstallation, readInstallation, requestCancellation, cancellationRequested, releaseStoppedInstallation } = createRequire(import.meta.url)(modulePath)
const root = fileURLToPath(new URL('..', import.meta.url))
function home(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'tavern-install-owner-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
function child(code, args = []) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['-e', code, modulePath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    process.stdout.on('data', data => { stdout += data })
    process.stderr.on('data', data => { stderr += data })
    process.on('error', reject)
    process.on('close', status => resolve({ status, stdout, stderr, pid: process.pid }))
  })
}

test('explicit same-token nesting joins without releasing or changing the outer owner', t => {
  const dshHome = home(t)
  const outer = acquireInstallation({ dshHome, sourceRoot: '/source', statusFile: '/status' })
  const nested = acquireInstallation({ dshHome, attemptId: outer.attemptId, pid: process.pid + 1 })
  assert.equal(nested.joined, true)
  assert.equal(nested.created, false)
  assert.equal(nested.owner.pid, process.pid)
  nested.update({ state: 'profile', pid: 123, attemptId: 'wrong', generation: 'wrong' })
  assert.equal(outer.owner.pid, process.pid)
  assert.equal(outer.owner.attemptId, outer.attemptId)
  assert.equal(nested.release(), false)
  assert.ok(readInstallation(dshHome))
  assert.equal(outer.release(), true)
  assert.equal(outer.release(), false)
  assert.equal(readInstallation(dshHome), null)
})

test('cancellation survives concurrent progress without metadata read-modify-write loss', async t => {
  const dshHome = home(t)
  const owner = acquireInstallation({ dshHome })
  const progress = child("const m=require(process.argv[1]),h=m.acquireInstallation({dshHome:process.argv[2],attemptId:process.argv[3]});for(let i=0;i<40;i++)h.update({progress:i})", [dshHome, owner.attemptId])
  const cancel = child("const m=require(process.argv[1]);m.requestCancellation(process.argv[2],process.argv[3])", [dshHome, owner.attemptId])
  for (const result of await Promise.all([progress, cancel])) assert.equal(result.status, 0, result.stderr)
  assert.equal(cancellationRequested(dshHome, owner.attemptId), true)
  assert.equal(owner.owner.progress, 39)
  owner.release()
  const successor = acquireInstallation({ dshHome })
  assert.equal(cancellationRequested(dshHome, owner.attemptId), false)
  assert.equal(cancellationRequested(dshHome, successor.attemptId), false)
  assert.throws(() => requestCancellation(dshHome, owner.attemptId), { code: 'INSTALLATION_OWNERSHIP_LOST' })
  assert.throws(() => owner.update({ progress: 99 }), { code: 'INSTALLATION_OWNERSHIP_LOST' })
  assert.equal(successor.owner.progress, undefined)
  successor.release()
})

test('stopped-owner recovery requires explicit descendant verification and exact generation', async t => {
  const dshHome = home(t)
  const exited = await child('')
  const owner = acquireInstallation({ dshHome, pid: exited.pid })
  owner.retain('Unverified descendants')
  const args = { dshHome, attemptId: owner.attemptId, generation: owner.owner.generation }
  assert.throws(() => releaseStoppedInstallation(args), { code: 'INSTALLATION_UNSAFE' })
  assert.throws(() => releaseStoppedInstallation({ ...args, generation: 'wrong', processesVerifiedStopped: true }), { code: 'INSTALLATION_OWNERSHIP_LOST' })
  assert.equal(releaseStoppedInstallation({ ...args, processesVerifiedStopped: true }), true)
  assert.equal(readInstallation(dshHome), null)
  const active = acquireInstallation({ dshHome })
  assert.throws(() => releaseStoppedInstallation({ dshHome, attemptId: active.attemptId, generation: active.owner.generation, processesVerifiedStopped: true }), { code: 'INSTALLATION_BUSY' })
  active.release()
})

test('CLI lock release is PID and generation fenced; a nested CLI cannot release', t => {
  const dshHome = home(t)
  const first = JSON.parse(execFileSync(process.execPath, [modulePath, 'acquire', '--home', dshHome, '--pid', String(process.pid)], { encoding: 'utf8' }))
  const nested = JSON.parse(execFileSync(process.execPath, [modulePath, 'acquire', '--home', dshHome, '--pid', String(process.pid + 1), '--attempt', first.attemptId], { encoding: 'utf8' }))
  assert.equal(nested.created, false)
  const denied = spawnSync(process.execPath, [modulePath, 'release', '--home', dshHome, '--attempt', first.attemptId, '--generation', first.generation, '--pid', String(process.pid + 1)], { encoding: 'utf8' })
  assert.notEqual(denied.status, 0)
  assert.ok(readInstallation(dshHome))
  execFileSync(process.execPath, [modulePath, 'release', '--home', dshHome, '--attempt', first.attemptId, '--generation', first.generation, '--pid', String(process.pid)])
  assert.equal(readInstallation(dshHome), null)
})

test('standalone Unix bootstrap refuses competing lock before installation mutations', { skip: process.platform === 'win32' }, t => {
  const dshHome = home(t)
  const owner = acquireInstallation({ dshHome })
  writeFileSync(path.join(dshHome, 'settings.yaml'), 'keep: true\n')
  const result = spawnSync('sh', [path.join(root, 'install.sh')], { encoding: 'utf8', env: { ...process.env, DSH_HOME: dshHome, DSH_TAVERN_HOST: 'desktop', DSH_TAVERN_INSTALL_ATTEMPT: '' } })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /INSTALLATION_BUSY/)
  for (const name of ['source-cache', 'apps', 'profiles', 'profile-data', '.dsh-tavern-install-root']) assert.equal(existsSync(path.join(dshHome, name)), false, name)
  assert.equal(readFileSync(path.join(dshHome, 'settings.yaml'), 'utf8'), 'keep: true\n')
  assert.equal(readInstallation(dshHome).attemptId, owner.attemptId)
  owner.release()
})

test('standalone installer embeddings are current and ownership precedes persistent writes', () => {
  execFileSync(process.execPath, [path.join(root, 'bin/build-installer-scripts.mjs'), '--check'])
  const unix = readFileSync(path.join(root, 'install.sh'), 'utf8')
  const windows = readFileSync(path.join(root, 'install.ps1'), 'utf8')
  assert.ok(unix.indexOf(' acquire --home ') < unix.indexOf("printf 'cli-v1\\n'"))
  assert.ok(unix.indexOf(' acquire --home ') < unix.indexOf('mkdir -p "$(dirname -- "${SOURCE_CACHE}")"'))
  assert.ok(windows.indexOf('$OwnerJson = & node') < windows.indexOf("Set-Content -LiteralPath (Join-Path $DshRoot '.dsh-tavern-install-root')"))
  assert.ok(windows.indexOf('$OwnerJson = & node') < windows.indexOf('[Environment]::SetEnvironmentVariable'))
})

test('standalone post-download stages use the real process supervisor to bound hung descendants', { skip: process.platform === 'win32' }, t => {
  const dshHome = home(t)
  const owner = acquireInstallation({ dshHome })
  const unix = readFileSync(path.join(root, 'install.sh'), 'utf8')
  const start = unix.indexOf('run_install() {')
  const end = unix.indexOf('# Read the downloaded release', start)
  const body = unix.slice(start, end)
  const result = spawnSync('sh', ['-c', `${body}\nrun_install fixture.hang 100 "$NODE_BINARY" -e 'setInterval(()=>{},1000)'`], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, SOURCE_DIR: root, NODE_BINARY: process.execPath, DSH_HOME: dshHome,
      DSH_TAVERN_INSTALL_ATTEMPT: owner.attemptId, DSH_TAVERN_INSTALL_LOCK: owner.lockDir,
      DSH_TAVERN_INSTALL_PROCESS_DIR: '', DSH_TAVERN_INSTALL_PROCESS_ANCESTORS: '' },
  })
  assert.ifError(result.error)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /超时|timeout|限时/i)
  assert.equal(readInstallation(dshHome).attemptId, owner.attemptId)
  assert.ok(!readInstallation(dshHome).unsafeToRetry)
  owner.release()
})

test('cancellation retries the same logical attempt if adoption rotates its fence', t => {
  const dshHome = home(t)
  const reservation = acquireInstallation({ dshHome, state: 'reserved', pid: 0 })
  const fs = createRequire(import.meta.url)('node:fs')
  const mkdir = fs.mkdirSync
  let updater
  fs.mkdirSync = function (directory, ...args) {
    if (!updater && directory === path.join(reservation.lockDir, '.mutation')) {
      updater = true
      updater = acquireInstallation({ dshHome, attemptId: reservation.attemptId, adopt: true })
    }
    return mkdir.call(this, directory, ...args)
  }
  try { requestCancellation(dshHome, reservation.attemptId) } finally { fs.mkdirSync = mkdir }
  assert.equal(cancellationRequested(dshHome, reservation.attemptId), true)
  updater.release()
})
