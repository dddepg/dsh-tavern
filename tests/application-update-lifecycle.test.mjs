import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { updateApplication } from '../bin/application-update.mjs'
import { createApplicationUpdater } from '../tavern-plugin/lib/application-updater.js'
import installationState from '../bin/installation-state.cjs'
import { createUpdateState } from '../bin/update-state.mjs'
import { recordInstallationReceipt, readInstallationReceipt } from '../bin/installation-receipt.mjs'

const identity = { currentVersion: '2.4.0', currentCommit: 'a'.repeat(40) }
const receiptModule = new URL('../bin/installation-receipt.mjs', import.meta.url).href
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tavern-update-lifecycle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = path.join(root, 'apps/dsh-tavern')
  const profile = path.join(root, 'profiles/tavern')
  const dataRoot = path.join(root, 'profile-data/tavern/data')
  await Promise.all([sourceRoot, profile, dataRoot].map(directory => mkdir(directory, { recursive: true })))
  for (const [file, value] of [
    ['package.json', JSON.stringify({ version: identity.currentVersion })], ['pnpm-lock.yaml', 'fixture'],
    ['.dsh-tavern-local.json', JSON.stringify({ host: 'desktop', dshHome: root })],
  ]) await writeFile(path.join(sourceRoot, file), value)
  for (const [file, value] of [['package.json', JSON.stringify({ dshTavern: { host: 'desktop', source: sourceRoot } })], ['cordis.patch.yml', '[]'], ['pnpm-workspace.yaml', 'packages: []']]) await writeFile(path.join(profile, file), value)
  const statusFile = path.join(dataRoot, 'update-status.json')
  const updater = extra => createApplicationUpdater({ dataRoot, sourceRoot, dshHome: root, runtimeHost: 'desktop', platform: 'linux',
    readLocalIdentity: async () => identity, fetchManifest: async () => ({ version: identity.currentVersion }),
    fetchLatestCommit: async () => identity.currentCommit, fetchCdnMetadata: async () => { throw new Error('offline') }, ...extra })
  return { root, sourceRoot, dataRoot, statusFile, updater, options: { host: 'desktop', sourceRoot, dshHome: root, statusFile, delay: 0, log() {} } }
}
async function until(operation) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { if (await operation()) return; await new Promise(resolve => setTimeout(resolve, 15)) }
  throw new Error('fixture did not reach expected state')
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"

// The fixture installer uses the real receipt writer after its simulated profile
// validation. The production updater must both stop its process tree and verify
// the resulting receipt; exit zero alone is deliberately insufficient.
test('successful installer requires validated receipt; terminal status clears repair', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  await writeFile(f.statusFile, JSON.stringify({ phase: 'failed', repairRequired: true, attemptId: 'older', failedAt: 1 }))
  const program = `import {recordInstallationReceipt} from ${JSON.stringify(receiptModule)};await recordInstallationReceipt({sourceRoot:${JSON.stringify(f.sourceRoot)},dshHome:process.env.DSH_HOME,host:'desktop',attemptId:process.env.DSH_TAVERN_INSTALL_ATTEMPT})`
  await writeFile(path.join(f.sourceRoot, 'install.sh'), `#!/bin/sh\n${quote(process.execPath)} --input-type=module -e ${quote(program)}\n`)
  await updateApplication(f.options)
  const saved = JSON.parse(await readFile(f.statusFile))
  assert.equal(saved.phase, 'completed'); assert.equal(saved.repairRequired, undefined); assert.equal(saved.requiresRestart, true)
  assert.equal(installationState.readInstallation(f.root), null)
  await writeFile(path.join(f.sourceRoot, 'install.sh'), '#!/bin/sh\nexit 0\n')
  await assert.rejects(updateApplication(f.options), /未确认配置验证和安装完成/)
  assert.equal(JSON.parse(await readFile(f.statusFile)).repairRequired, true)
})

test('real hung updater cancels, remains exclusive through cleanup and permits another attempt afterward', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const marker = path.join(f.root, 'writer.log')
  await writeFile(path.join(f.sourceRoot, 'install.sh'), `#!/bin/sh\ntrap '' TERM\nwhile :; do printf writing >> ${quote(marker)}; sleep 0.02; done\n`)
  const active = updateApplication({ ...f.options, timeoutMs: 5000 })
  const result = active.catch(error => error)
  await until(async () => (await f.updater().status()).cancellable)
  assert.equal((await f.updater().status()).phase, 'running')
  await assert.rejects(updateApplication(f.options), /已有安装|已经开始/)
  assert.equal((await f.updater().cancel()).phase, 'cancelling')
  await assert.rejects(f.updater().start(), /更新正在进行/)
  const error = await result
  assert.equal(error.code, 'INSTALLATION_ABORTED'); assert.equal(error.unsafeToRetry, false)
  const before = await readFile(marker, 'utf8').catch(() => '')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(await readFile(marker, 'utf8').catch(() => ''), before)
  assert.equal(installationState.readInstallation(f.root), null)
  assert.equal((await f.updater().check()).phase, 'repair-required')
  assert.equal(JSON.parse(await readFile(f.statusFile)).repairRequired, true)
})

test('wall-clock timeout applies even while updater and child are alive', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.sourceRoot, 'install.sh'), '#!/bin/sh\nwhile :; do sleep 1; done\n')
  await assert.rejects(updateApplication({ ...f.options, timeoutMs: 150 }), error => error.code === 'INSTALLATION_TIMEOUT' && error.unsafeToRetry === false)
  assert.equal(JSON.parse(await readFile(f.statusFile)).phase, 'failed')
  assert.equal(installationState.readInstallation(f.root), null)
})

test('independent updater instances share one reservation and attempt id crosses launch', async t => {
  const f = await fixture(t)
  let spawned = 0
  let launchedArguments
  const options = { fetchLatestCommit: async () => 'b'.repeat(40), compareCommits: async () => 'ahead',
    spawnProcess(_command, args) { spawned++; launchedArguments = args; return { unref() {} } } }
  const result = await Promise.allSettled([f.updater(options).start(), f.updater(options).start()])
  assert.equal(spawned, 1)
  assert.equal(result.filter(result => result.status === 'fulfilled').length, 1)
  const owner = installationState.readInstallation(f.root)
  assert.equal(launchedArguments[launchedArguments.indexOf('--attempt-id') + 1], owner.attemptId)
})

test('late old-attempt writes cannot replace successor; manual receipt reconciles only fresh matching installation', async t => {
  const f = await fixture(t)
  const state = createUpdateState(f.statusFile, f.root)
  const old = installationState.acquireInstallation({ dshHome: f.root, attemptId: 'old' })
  await state.write({ phase: 'running', attemptId: 'old' }, { attemptId: 'old' })
  old.release()
  const newer = installationState.acquireInstallation({ dshHome: f.root, attemptId: 'new' })
  await state.write({ phase: 'running', attemptId: 'new' }, { attemptId: 'new' })
  await state.write({ phase: 'completed', attemptId: 'old' }, { attemptId: 'old' })
  assert.equal((await state.read()).attemptId, 'new')
  newer.release()
  await state.write({ phase: 'failed', attemptId: 'new', repairRequired: true, failedAt: 10 })
  const stale = await recordInstallationReceipt({ sourceRoot: f.sourceRoot, dshHome: f.root, host: 'desktop', attemptId: 'manual', verifiedAt: 5 })
  assert.equal((await f.updater().status()).phase, 'failed')
  await recordInstallationReceipt({ ...stale, verifiedAt: Date.now() })
  assert.equal((await f.updater().status()).phase, 'completed')
  await state.write({ phase: 'failed', repairRequired: true, failedAt: 10 })
  await writeFile(path.join(f.root, 'profiles/tavern/cordis.patch.yml'), 'changed')
  assert.equal(await readInstallationReceipt({ sourceRoot: f.sourceRoot, dshHome: f.root, host: 'desktop' }), null)
  assert.equal((await f.updater().status()).phase, 'failed')
})

test('a delayed check cannot restore repair after a newer manual installation', async t => {
  const f = await fixture(t)
  await writeFile(f.statusFile, JSON.stringify({ phase: 'failed', repairRequired: true, attemptId: 'old', failedAt: 10 }))
  let release
  const wait = new Promise(resolve => { release = resolve })
  let requested = false
  const checking = f.updater({ fetchManifest: async () => { requested = true; await wait; return { version: '2.4.0' } } }).check()
  await until(() => requested)
  const manual = installationState.acquireInstallation({ dshHome: f.root, attemptId: 'manual' })
  const state = createUpdateState(f.statusFile, f.root)
  await state.write({ phase: 'completed', attemptId: 'manual' }, { attemptId: 'manual' })
  manual.release()
  release()
  assert.equal((await checking).phase, 'completed')
})

test('status fencing distinguishes an absent previous attempt from an unconstrained write', async t => {
  const f = await fixture(t)
  const state = createUpdateState(f.statusFile, f.root)
  await state.write({ phase: 'completed', attemptId: 'new-manual' })
  await state.write({ phase: 'up-to-date' }, { expectedAttemptId: undefined })
  assert.equal((await state.read()).attemptId, 'new-manual')
})

test('profile receipt from same failed bootstrap cannot erase a later bootstrap failure', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const program = `import {recordInstallationReceipt} from ${JSON.stringify(receiptModule)};await recordInstallationReceipt({sourceRoot:${JSON.stringify(f.sourceRoot)},dshHome:process.env.DSH_HOME,host:'desktop',attemptId:process.env.DSH_TAVERN_INSTALL_ATTEMPT})`
  await writeFile(path.join(f.sourceRoot, 'install.sh'), `#!/bin/sh\n${quote(process.execPath)} --input-type=module -e ${quote(program)}\nexit 9\n`)
  await assert.rejects(updateApplication(f.options), /退出码 9/)
  assert.equal((await f.updater().status()).phase, 'failed')
  assert.equal((await f.updater().check()).phase, 'repair-required')
})

test('hung config validation stops its writer before profile transaction rollback', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const { beginProfileConfigurationUpdate } = await import('../bin/profile-configuration.mjs')
  const { runInstallDsh } = await import('../bin/launcher-environment.mjs')
  const profileDir = path.join(f.root, 'profiles/tavern')
  const manifestPath = path.join(profileDir, 'package.json')
  const original = await readFile(manifestPath, 'utf8')
  const transaction = await beginProfileConfigurationUpdate({ profileDir, manifest: { replacing: true }, patchText: 'new configuration' })
  const configCommand = path.join(f.root, 'dsh-fixture')
  await writeFile(configCommand, `#!/bin/sh\ntrap '' TERM\nwhile :; do printf corrupt > ${quote(manifestPath)}; sleep 0.02; done\n`, { mode: 0o755 })
  await assert.rejects(runInstallDsh(configCommand, ['--profile', 'tavern', '--dump-config'], { host: 'desktop', timeoutMs: 150 }), error => {
    assert.equal(error.code, 'INSTALLATION_TIMEOUT'); assert.equal(error.unsafeToRetry, false); return true
  })
  await transaction.rollback()
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(await readFile(manifestPath, 'utf8'), original)
})

test('detached updater does not inherit a completed installation context from its service', async t => {
  const f = await fixture(t)
  const names = ['DSH_TAVERN_INSTALL_ATTEMPT', 'DSH_TAVERN_INSTALL_LOCK', 'DSH_TAVERN_INSTALL_PROCESS_DIR', 'DSH_TAVERN_INSTALL_PROCESS_ANCESTORS']
  const previous = Object.fromEntries(names.map(key => [key, process.env[key]]))
  for (const key of names) process.env[key] = 'stale-context'
  t.after(() => { for (const key of names) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] } })
  const { runtimeEnvironment } = await import('../bin/launcher-environment.mjs')
  for (const key of names) assert.equal(runtimeEnvironment({ installation: false })[key], undefined)
  let environment
  await f.updater({ fetchLatestCommit: async () => 'b'.repeat(40), compareCommits: async () => 'ahead',
    spawnProcess(_command, _args, options) { environment = options.env; return { unref() {} } } }).start()
  for (const key of names) assert.equal(environment[key], undefined)
})

test('late Windows helper failure cannot overwrite an adopted and completed attempt', async t => {
  const f = await fixture(t)
  const { EventEmitter } = await import('node:events')
  const value = await f.updater({ platform: 'win32', fetchLatestCommit: async () => 'b'.repeat(40), compareCommits: async () => 'ahead',
    spawnProcess(_command, args) {
      const child = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {}
      queueMicrotask(async () => {
        child.emit('spawn')
        const attemptId = args[args.indexOf('--attempt-id') + 1]
        const owner = installationState.acquireInstallation({ dshHome: f.root, attemptId, adopt: true })
        await createUpdateState(f.statusFile, f.root).write({ phase: 'completed', attemptId }, { attemptId })
        owner.release()
        child.stderr.emit('data', Buffer.from('helper lost the launch response'))
        child.emit('close', 1)
      })
      return child
    },
  }).start()
  assert.equal(value.phase, 'completed')
  assert.equal(JSON.parse(await readFile(f.statusFile)).phase, 'completed')
})

test('definite launcher spawn failure releases reservation without claiming a running installer', async t => {
  const f = await fixture(t)
  await assert.rejects(f.updater({ fetchLatestCommit: async () => 'b'.repeat(40), compareCommits: async () => 'ahead',
    spawnProcess() { throw Object.assign(new Error('executable missing'), { code: 'ENOENT' }) },
  }).start(), /executable missing/)
  assert.equal(installationState.readInstallation(f.root), null)
  assert.equal(JSON.parse(await readFile(f.statusFile)).phase, 'failed')
})

test('CLI service starts only after the bootstrap process tree is quiescent', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const program = `import {recordInstallationReceipt} from ${JSON.stringify(receiptModule)};await recordInstallationReceipt({sourceRoot:${JSON.stringify(f.sourceRoot)},dshHome:process.env.DSH_HOME,host:'cli',attemptId:process.env.DSH_TAVERN_INSTALL_ATTEMPT})`
  await writeFile(path.join(f.sourceRoot, 'install.sh'), `#!/bin/sh\ntest "$DSH_TAVERN_DEFER_SERVICE_START" = 1 || exit 11\n${quote(process.execPath)} --input-type=module -e ${quote(program)}\n`)
  let started = false
  await updateApplication({ ...f.options, host: 'cli', async startService() {
    const owner = installationState.readInstallation(f.root)
    const { readdir } = await import('node:fs/promises')
    const processFiles = await readdir(path.join(owner.lockDir, 'processes'))
    assert.ok(processFiles.includes('stopping'))
    assert.equal(processFiles.some(name => /^\d+\.json$/.test(name)), false)
    assert.equal(owner.supervised, false)
    started = true
  } })
  assert.equal(started, true)
  assert.equal(JSON.parse(await readFile(f.statusFile)).phase, 'completed')
})

test('bootstrap installers defer their persistent service when called by the updater', async () => {
  const unix = await readFile(new URL('../install.sh', import.meta.url), 'utf8')
  const windows = await readFile(new URL('../install.ps1', import.meta.url), 'utf8')
  assert.match(unix, /DSH_TAVERN_DEFER_SERVICE_START[^\n]+\n\s+DSH_HOME=.*dsh-tavern\.mjs" start/)
  assert.match(windows, /if \(\$env:DSH_TAVERN_DEFER_SERVICE_START -ne '1'\) \{\s+Invoke-InstallCommand 'service.start'/)
})

test('Windows persistent service launched after cleanup survives successful updater completion', { skip: process.platform !== 'win32' }, async t => {
  let pid
  // Hooks run in registration order. Stop the owned long-lived process before
  // fixture() removes its Windows working directory, and wait for actual exit.
  t.after(async () => {
    if (!pid) return
    try { process.kill(pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    await until(() => { try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error } })
  })
  const f = await fixture(t)
  const { startUpdatedService } = await import('../bin/application-update.mjs')
  const receiptScript = path.join(f.sourceRoot, 'receipt.mjs')
  await writeFile(receiptScript, `import {recordInstallationReceipt} from ${JSON.stringify(receiptModule)};await recordInstallationReceipt({sourceRoot:${JSON.stringify(f.sourceRoot)},dshHome:process.env.DSH_HOME,host:'cli',attemptId:process.env.DSH_TAVERN_INSTALL_ATTEMPT})`)
  await writeFile(path.join(f.sourceRoot, 'install.ps1'), `if ($env:DSH_TAVERN_DEFER_SERVICE_START -ne '1') { exit 11 }; & '${process.execPath.replaceAll("'", "''")}' '${receiptScript.replaceAll("'", "''")}'; exit $LASTEXITCODE`)
  await mkdir(path.join(f.sourceRoot, 'bin'))
  const pidFile = path.join(f.root, 'service.pid')
  await writeFile(path.join(f.sourceRoot, 'bin/dsh-tavern.mjs'), `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(p.pid));p.unref()`)
  await updateApplication({ ...f.options, host: 'cli', startService: startUpdatedService })
  pid = Number(await readFile(pidFile, 'utf8'))
  assert.ok(pid > 0)
  process.kill(pid, 0)
  assert.equal(JSON.parse(await readFile(f.statusFile)).phase, 'completed')
})

test('initial status persistence failure releases the never-launched reservation', async t => {
  const f = await fixture(t)
  const { mkdirSync } = await import('node:fs')
  await assert.rejects(f.updater({ fetchLatestCommit: async () => 'b'.repeat(40), compareCommits: async () => 'ahead',
    now() {
      // Inject a real filesystem failure exactly after reservation, before the
      // first running snapshot. No updater process has been launched yet.
      if (installationState.readInstallation(f.root)?.state === 'reserved') mkdirSync(f.statusFile)
      return Date.now()
    },
    spawnProcess() { assert.fail('persistence failure must prevent launch') },
  }).start(), error => error.code === 'EISDIR')
  assert.equal(installationState.readInstallation(f.root), null)
})
