import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { runInstallationProcess, verifyInstallationProcessesStopped, resolveWindowsInstallationInvocation } from '../bin/installation-process.mjs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import installationState from '../bin/installation-state.cjs'

const moduleUrl = new URL('../bin/installation-process.mjs', import.meta.url).href
const fastCleanup = { killGraceMs: 50, cleanupTimeoutMs: process.platform === 'win32' ? 10_000 : 2000 }
const fixtureTimeout = process.platform === 'win32' ? 30_000 : 5000

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tavern-supervisor-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function waitForFile(file) {
  const deadline = Date.now() + fixtureTimeout
  while (Date.now() < deadline) {
    try { return await readFile(file, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    await delay(10)
  }
  throw new Error(`Fixture did not become ready: ${file}`)
}

async function absent(file) {
  await assert.rejects(readFile(file), { code: 'ENOENT' })
}

function writerScript(ready, late) {
  return `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, 'late write'), 700); setInterval(() => {}, 1000)`
}

test('supervised commands preserve output, cwd and exit status', async t => {
  const directory = await fixture(t)
  const result = await runInstallationProcess(process.execPath, ['-e', "console.log(process.cwd()); console.error('diagnostic')"], { cwd: directory, ...fastCleanup })
  assert.equal(result.status, 0)
  assert.equal(result.safe, true)
  assert.match(result.stdout, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(result.stderr, /diagnostic/)
  assert.ok(result.pid > 1)
})

test('POSIX cleanup verifies zombie-only or vanished groups after EPERM', { skip: process.platform === 'win32' }, async t => {
  const kill = process.kill.bind(process)
  const simulated = new Set()
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid < -1 && (signal === 0 || signal === 'SIGKILL')) {
      // Darwin may report EPERM while the terminated wrapper is still a
      // zombie. Keep actual TERM delivery and require ps to prove it stopped.
      simulated.add(signal)
      throw Object.assign(new Error('kill EPERM (zombie group fixture)'), { code: 'EPERM' })
    }
    return kill(pid, signal)
  })
  const result = await runInstallationProcess(process.execPath, ['-e', 'process.exit(0)'], fastCleanup)
  assert.equal(result.safe, true)
  assert.deepEqual(result.remainingProcessGroups, [])
  assert.deepEqual(result.cleanupErrors, [])
  assert.ok(simulated.has(0))
  assert.ok(simulated.has('SIGKILL'))
})

test('POSIX EPERM with a live writer remains unsafe and reports its cleanup failure', { skip: process.platform === 'win32' }, async t => {
  const directory = await fixture(t)
  const ready = path.join(directory, 'ready')
  const controller = new AbortController()
  const kill = process.kill.bind(process)
  let wrapper
  const mock = t.mock.method(process, 'kill', (pid, signal) => {
    if (pid < -1) throw Object.assign(new Error('kill EPERM (live writer fixture)'), { code: 'EPERM' })
    return kill(pid, signal)
  })
  try {
    const promise = runInstallationProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`], {
      signal: controller.signal, timeoutMs: fixtureTimeout, onSpawn(child) { wrapper = child }, ...fastCleanup,
    })
    await waitForFile(ready)
    controller.abort()
    await assert.rejects(promise, error => {
      assert.equal(error.code, 'INSTALLATION_CLEANUP_FAILED', error.message)
      assert.equal(error.unsafeToRetry, true)
      assert.ok(error.remainingProcessGroups.includes(wrapper.pid))
      assert.match(error.message, /EPERM.*live writer fixture/)
      return true
    })
  } finally {
    mock.mock.restore()
    if (wrapper) {
      // The supervisor unrefs failed children; Node 22 needs an explicit ref
      // while this fixture waits for its own cleanup exit event.
      wrapper.ref()
      const exited = new Promise(resolve => wrapper.once('exit', resolve))
      try { kill(-wrapper.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      if (wrapper.exitCode === null && wrapper.signalCode === null) await exited
    }
  }
})

test('supervised invocation preserves Unicode, empty arguments, spaces and quotes', async () => {
  const args = ['space value', 'quote " value', '末尾\\', '', 'slash\\"quote']
  const result = await runInstallationProcess(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args], fastCleanup)
  assert.deepEqual(JSON.parse(result.stdout), args)
  const shell = await runInstallationProcess('echo', ['tavern-shell-check'], { shell: true, ...fastCleanup })
  assert.match(shell.stdout, /tavern-shell-check/)
})

test('nonzero exit and missing command are safely rejected', async () => {
  await assert.rejects(runInstallationProcess(process.execPath, ['-e', 'process.exit(23)'], fastCleanup), error => {
    assert.equal(error.code, 'INSTALLATION_PROCESS_FAILED', error.message)
    assert.equal(error.status, 23)
    assert.equal(error.unsafeToRetry, false)
    return true
  })
  await assert.rejects(runInstallationProcess('dsh-tavern-fixture-command-does-not-exist', [], fastCleanup), error => {
    assert.equal(error.code, 'ENOENT', error.message)
    assert.equal(error.unsafeToRetry, false)
    return true
  })
})

test('timeout kills a TERM-ignoring grandchild before reporting safe stopped', { skip: process.platform === 'win32' }, async t => {
  const directory = await fixture(t)
  const ready = path.join(directory, 'ready')
  const late = path.join(directory, 'late')
  const descendant = writerScript(ready, late)
  const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
  const start = Date.now()
  const promise = runInstallationProcess(process.execPath, ['-e', script], { timeoutMs: 350, label: '--dump-config', ...fastCleanup })
  await waitForFile(ready)
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'INSTALLATION_TIMEOUT', error.message)
    assert.equal(error.timeoutMs, 350)
    assert.equal(error.unsafeToRetry, false)
    assert.match(error.message, /--dump-config.*350/)
    assert.deepEqual(error.remainingProcessGroups, [])
    return true
  })
  assert.ok(Date.now() - start < 3000)
  await delay(750)
  await absent(late)
})

test('abort is responsive and stops descendants before rejection', async t => {
  const directory = await fixture(t)
  const ready = path.join(directory, 'ready')
  const late = path.join(directory, 'late')
  const controller = new AbortController()
  const promise = runInstallationProcess(process.execPath, ['-e', writerScript(ready, late)], { signal: controller.signal, timeoutMs: fixtureTimeout, ...fastCleanup })
  await waitForFile(ready)
  controller.abort('fixture cancellation')
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'INSTALLATION_ABORTED', error.message)
    assert.equal(error.unsafeToRetry, false)
    return true
  })
  await delay(750)
  await absent(late)
})

test('an already aborted signal does not launch a process', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runInstallationProcess(process.execPath, ['-e', 'process.exit(0)'], {
    signal: controller.signal,
    onSpawn() { assert.fail('must not spawn') },
  }), { code: 'INSTALLATION_ABORTED', unsafeToRetry: false })
})

test('a successful direct command cannot leave background descendants writing', async t => {
  const directory = await fixture(t)
  const ready = path.join(directory, 'ready')
  const late = path.join(directory, 'late')
  const descendant = writerScript(ready, late)
  const script = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore', detached:process.platform==='win32'}); child.unref(); setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(ready)})) process.exit(0); }, 10)`
  const promise = runInstallationProcess(process.execPath, ['-e', script], fastCleanup)
  await waitForFile(ready)
  assert.equal((await promise).status, 0)
  await delay(750)
  await absent(late)
})

test('outer cancellation also kills separately grouped nested stages', async t => {
  const directory = await fixture(t)
  const ready = path.join(directory, 'ready')
  const late = path.join(directory, 'late')
  const nested = path.join(directory, 'nested.mjs')
  await writeFile(nested, `import { runInstallationProcess } from ${JSON.stringify(moduleUrl)}; await runInstallationProcess(process.execPath, ['-e', ${JSON.stringify(writerScript(ready, late))}], { timeoutMs: ${fixtureTimeout} });`)
  const controller = new AbortController()
  const promise = runInstallationProcess(process.execPath, [nested], { signal: controller.signal, timeoutMs: fixtureTimeout, ...fastCleanup })
  await waitForFile(ready)
  controller.abort()
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'INSTALLATION_ABORTED', error.message)
    assert.equal(error.unsafeToRetry, false)
    assert.ok(error.processGroups.length >= 2)
    return true
  })
  await delay(750)
  await absent(late)
})

test('nested stage timeout does not kill its enclosing installation supervisor', async t => {
  const directory = await fixture(t)
  const ready = path.join(directory, 'ready')
  const late = path.join(directory, 'late')
  const caught = path.join(directory, 'caught')
  const nested = path.join(directory, 'nested.mjs')
  await writeFile(nested, `import { writeFileSync } from 'node:fs'; import { runInstallationProcess } from ${JSON.stringify(moduleUrl)}; try { await runInstallationProcess(process.execPath, ['-e', ${JSON.stringify(writerScript(ready, late))}], { timeoutMs: 350, killGraceMs: 50 }); } catch (error) { writeFileSync(${JSON.stringify(caught)}, JSON.stringify({ code: error.code, unsafeToRetry: error.unsafeToRetry })); }`)
  assert.equal((await runInstallationProcess(process.execPath, [nested], { timeoutMs: fixtureTimeout, ...fastCleanup })).status, 0)
  assert.deepEqual(JSON.parse(await readFile(caught, 'utf8')), { code: 'INSTALLATION_TIMEOUT', unsafeToRetry: false })
  await delay(750)
  await absent(late)
})

test('unverifiable process registry fails closed with durable cleanup metadata', async t => {
  const directory = await fixture(t)
  const registry = path.join(directory, 'processes')
  await assert.rejects(runInstallationProcess(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
    processDirectory: registry, timeoutMs: 100, ...fastCleanup,
    // Malformed metadata must not authorize stopping an unrelated PID. The
    // actual command group remains known from spawn and is still terminated.
    onSpawn() { writeFileSync(path.join(registry, '123.json'), '{') },
  }), error => {
    assert.equal(error.code, 'INSTALLATION_CLEANUP_FAILED')
    assert.equal(error.unsafeToRetry, true)
    assert.equal(error.originalCode, 'INSTALLATION_TIMEOUT')
    assert.equal(error.processDirectory, registry)
    assert.ok(error.processGroups.includes(error.pid))
    assert.ok(error.cleanupErrors.length > 0)
    assert.ok(error.message.includes(error.cleanupErrors[0]))
    return true
  })
  assert.equal(await readFile(path.join(registry, 'stopping'), 'utf8'), '')
})

test('recovery only clears closed, verified trees whose supervisor has exited', async t => {
  const directory = await fixture(t)
  const registry = path.join(directory, 'processes')
  const runner = path.join(directory, 'runner.mjs')
  await writeFile(runner, `import { runInstallationProcess } from ${JSON.stringify(moduleUrl)}; await runInstallationProcess(process.execPath, ['-e', 'process.exit(0)'], { processDirectory: ${JSON.stringify(registry)} });`)
  const child = spawn(process.execPath, [runner], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Fixture exited ${code}: ${stderr}`)))
  })
  assert.equal((await verifyInstallationProcessesStopped(registry)).safe, true)
  await writeFile(path.join(registry, 'supervisor.json'), JSON.stringify({ pid: process.pid }))
  assert.deepEqual(await verifyInstallationProcessesStopped(registry), { safe: false, reason: 'supervisor-still-running', pid: process.pid })
  await rm(path.join(registry, 'stopping'))
  assert.equal((await verifyInstallationProcessesStopped(registry)).reason, 'launch-gate-open')
  assert.equal((await verifyInstallationProcessesStopped(path.join(directory, 'missing'))).safe, false)
})

test('lost POSIX supervisor closes its launch gate and stops owned writers', { skip: process.platform === 'win32' }, async t => {
  const directory = await fixture(t)
  const registry = path.join(directory, 'processes')
  const ready = path.join(directory, 'ready')
  const late = path.join(directory, 'late')
  const runner = path.join(directory, 'runner.mjs')
  await writeFile(runner, `import { existsSync } from 'node:fs'; import { runInstallationProcess } from ${JSON.stringify(moduleUrl)}; setInterval(() => { if (existsSync(${JSON.stringify(ready)})) process.kill(process.pid, 'SIGKILL'); }, 10); await runInstallationProcess(process.execPath, ['-e', ${JSON.stringify(writerScript(ready, late))}], { processDirectory: ${JSON.stringify(registry)}, timeoutMs: ${fixtureTimeout} });`)
  const child = spawn(process.execPath, [runner], { stdio: 'ignore' })
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  const deadline = Date.now() + 2500
  let result
  do {
    result = await verifyInstallationProcessesStopped(registry)
    if (result.safe) break
    await delay(25)
  } while (Date.now() < deadline)
  assert.equal(result.safe, true, JSON.stringify(result))
  await delay(750)
  await absent(late)
})

test('Windows containment publishes a suspended-assigned job before resuming it', async () => {
  const source = await readFile(new URL('../bin/installation-process.mjs', import.meta.url), 'utf8')
  const create = source.indexOf('Check(CreateProcess(null, line')
  const assign = source.indexOf('if (!AssignProcessToJobObject(job, child.process))', create)
  const publish = source.indexOf('Publish(ready,', assign)
  const resume = source.indexOf('Check(ResumeThread(child.thread)', publish)
  assert.ok(create > 0 && assign > create && publish > assign && resume > publish)
  assert.match(source, /0x08000004.*NO_WINDOW \| SUSPENDED/)
  assert.match(source, /limits\.basic\.flags = 0x2000.*KILL_ON_JOB_CLOSE/)
  assert.match(source, /Check\(TerminateJobObject\(job, 1\)\)/)
  assert.match(source, /QueryInformationJobObject\(job, 1, out accounting/)
  assert.match(source, /accounting\.active == 0/)
  assert.match(source, /Windows job .*no verified empty-job receipt/)
})

function launchCli(args, env = process.env) {
  const child = spawn(process.execPath, [fileURLToPath(moduleUrl), '--run', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', status => resolve({ status, stdout, stderr }))
  })
  return { child, completion }
}

test('standalone CLI preserves output and enforces stage deadlines', async () => {
  const good = await launchCli(['fixture', String(fixtureTimeout), process.execPath, '-e', 'console.log("cli output")']).completion
  assert.equal(good.status, 0, good.stderr)
  assert.match(good.stdout, /cli output/)
  const timedOut = await launchCli(['fixture timeout', '100', process.execPath, '-e', 'setInterval(() => {}, 1000)']).completion
  assert.equal(timedOut.status, 1)
  assert.match(timedOut.stderr, /INSTALLATION_TIMEOUT/)
})

test('standalone CLI joins ownership and honors durable cancellation', async t => {
  const directory = await fixture(t)
  const ready = path.join(directory, 'ready')
  const lease = installationState.acquireInstallation({ dshHome: directory, attemptId: 'cli-cancel' })
  const { completion } = launchCli(['fixture cancellation', String(fixtureTimeout), process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`], {
    ...process.env, DSH_TAVERN_INSTALL_LOCK: lease.lockDir, DSH_TAVERN_INSTALL_ATTEMPT: lease.attemptId,
  })
  await waitForFile(ready)
  installationState.requestCancellation(directory, lease.attemptId)
  const result = await completion
  assert.equal(result.status, 1)
  assert.match(result.stderr, /INSTALLATION_ABORTED/)
  assert.notEqual(lease.owner.unsafeToRetry, true)
  assert.equal(lease.release(), true)
})

test('standalone CLI retains shared ownership when cleanup is unverifiable', async t => {
  const directory = await fixture(t)
  const lease = installationState.acquireInstallation({ dshHome: directory, attemptId: 'cli-unsafe' })
  const script = `require('node:fs').writeFileSync(require('node:path').join(process.env.DSH_TAVERN_INSTALL_PROCESS_DIR, '123.json'), '{')`
  const result = await launchCli(['fixture unsafe', String(fixtureTimeout), process.execPath, '-e', script], {
    ...process.env, DSH_TAVERN_INSTALL_LOCK: lease.lockDir, DSH_TAVERN_INSTALL_ATTEMPT: lease.attemptId,
  }).completion
  assert.equal(result.status, 1)
  assert.match(result.stderr, /INSTALLATION_CLEANUP_FAILED/)
  assert.equal(lease.owner.unsafeToRetry, true)
  assert.throws(() => lease.release(), { code: 'INSTALLATION_UNSAFE' })
})

test('Windows cmd encoding preserves boundaries and escapes each parsing layer', () => {
  const nativeArgs = ['C:\\Games\\DSH Tavern', '中文 & (test)', 'a"b', '', 'tail\\']
  assert.deepEqual(resolveWindowsInstallationInvocation('C:\\Program Files\\node.exe', nativeArgs, { shell: true }), {
    command: 'C:\\Program Files\\node.exe', args: nativeArgs, verbatimArguments: false,
  })
  const encoded = resolveWindowsInstallationInvocation('C:\\Games\\DSH Tavern\\pnpm.cmd', ['--dir', 'C:\\游戏 & (测试)\\DSH Tavern', 'say"hello', '', 'tail\\', '%PATH%', '!X!', 'a|b>c'], { shell: true, comspec: 'cmd.exe' })
  assert.deepEqual(encoded.args.slice(0, 4), ['/d', '/s', '/v:off', '/c'])
  assert.equal(encoded.verbatimArguments, true)
  assert.match(encoded.args[4], /C:\\Games\\DSH\^ Tavern\\pnpm.cmd/)
  assert.match(encoded.args[4], /\^\^\^&/)
  assert.match(encoded.args[4], /\^\^\^\(/)
  assert.match(encoded.args[4], /\^\^\^"/)
  assert.match(encoded.args[4], /\^\^\^%PATH\^\^\^%/)
  assert.match(encoded.args[4], /\^\^\^!/)
  assert.match(encoded.args[4], /\^\^\^\|/)
  assert.match(encoded.args[4], /\^\^\^>/)
  assert.match(encoded.args[4], /中文|游戏/)
  assert.throws(() => resolveWindowsInstallationInvocation('pnpm.cmd', ['a\nb'], { shell: true }), /line breaks/)
  assert.throws(() => resolveWindowsInstallationInvocation('pnpm.cmd', [], { shell: 'powershell.exe' }), /only support cmd/)
})

test('Windows batch forwarding preserves argument data and cannot inject commands', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fixture(t)
  const shim = path.join(directory, 'npm fixture.cmd')
  const target = path.join(directory, 'dump-arguments.cjs')
  const injected = path.join(directory, 'injected.txt')
  await writeFile(target, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`)
  const args = ['--dir', 'C:\\Games\\DSH Tavern', '中文 & (测试)', 'embedded"quote', 'slash\\"quote', '', 'tail\\', '%PATH%', '!VARIABLE!', `& echo injected > "${injected}"`, '(a|b)', '^caret']
  const result = await runInstallationProcess(shim, args, { shell: true, timeoutMs: fixtureTimeout, ...fastCleanup })
  assert.deepEqual(JSON.parse(result.stdout), args)
  await absent(injected)
})

test('an explicit new root ignores stale registry and ancestry environment markers', async t => {
  const directory = await fixture(t)
  const stale = path.join(directory, 'stale')
  const runner = path.join(directory, 'fresh-root.mjs')
  await import('node:fs/promises').then(fs => fs.mkdir(stale))
  await writeFile(path.join(stale, 'stopping'), '')
  await writeFile(runner, `import { runInstallationProcess } from ${JSON.stringify(moduleUrl)}; process.env.DSH_TAVERN_INSTALL_PROCESS_DIR = ${JSON.stringify(stale)}; process.env.DSH_TAVERN_INSTALL_PROCESS_ANCESTORS = '[999999999]'; const result = await runInstallationProcess(process.execPath, ['-e', 'console.log("fresh root")'], { root: true }); console.log(JSON.stringify({ status: result.status, processDirectory: result.processDirectory, stdout: result.stdout }));`)
  const result = await runInstallationProcess(process.execPath, [runner], { root: true, timeoutMs: fixtureTimeout, ...fastCleanup })
  const inner = JSON.parse(result.stdout)
  assert.equal(inner.status, 0)
  assert.notEqual(inner.processDirectory, stale)
  assert.match(inner.stdout, /fresh root/)
})
