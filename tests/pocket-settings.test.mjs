import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createPocketSettings } from '../tavern-plugin/lib/pocket-settings.js'
async function fixture(t, host = 'cli') {
  const home = await mkdtemp(path.join(tmpdir(), 'pocket-gui-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const dataRoot = path.join(home, 'profile-data/tavern/data')
  const manifestPath = path.join(home, 'profiles/tavern/package.json')
  await mkdir(path.dirname(manifestPath), { recursive: true }); await mkdir(dataRoot, { recursive: true })
  await writeFile(manifestPath, JSON.stringify({ dshTavern: { host }, dsh: { profile: { bundles: ['dsh-pocket', 'user-auth'] } }, dependencies: { 'user-auth': '1' } }))
  return { dataRoot, sourceRoot: '/source', manifestPath }
}
test('GUI saves only explicit preference, reports currently active legacy Pocket and preserves user plugins', async t => {
  const env = await fixture(t), settings = createPocketSettings(env)
  assert.deepEqual(await settings.status(), { supported: true, enabled: false, active: true, restartRequired: true, running: false, error: '' })
  assert.equal((await settings.save(true)).restartRequired, false)
  const result = await settings.save(false)
  assert.equal(result.active, true); assert.equal(result.restartRequired, true)
  const manifest = JSON.parse(await readFile(env.manifestPath))
  assert.equal(manifest.dshTavern.cliPocketEnabled, false)
  assert.equal(manifest.dependencies['user-auth'], '1')
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-pocket'), 'listener remains active until explicit apply')
  await assert.rejects(settings.save('false'), /布尔/)
})
test('GUI applies using a detached fixed helper, prevents duplicate restart and records spawn failures', async t => {
  const env = await fixture(t)
  let launched = 0
  const settings = createPocketSettings({ ...env, spawnProcess(exec, args, options) {
    launched++; assert.equal(args[0], '/source/bin/pocket-reconfigure.mjs')
    assert.equal(options.env.DSH_TAVERN_CLI_HOME, path.resolve(env.dataRoot, '../../..'))
    assert.equal(options.windowsHide, true)
    const child = new EventEmitter(); child.pid = process.pid; child.unref = () => {}
    queueMicrotask(() => child.emit('spawn')); return child
  } })
  const results = await Promise.allSettled([settings.apply(), settings.apply()])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(launched, 1)
  await assert.rejects(settings.save(true), /正在应用/)
  await writeFile(path.join(env.dataRoot, 'pocket-configuration.json'), '{}')
  const broken = createPocketSettings({ ...env, spawnProcess() { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', Error('spawn failed'))); return child } })
  await assert.rejects(broken.apply(), /spawn failed/)
  assert.equal((await broken.status()).running, false)
})
test('Desktop has no CLI Pocket toggle and cannot apply or mutate it', async t => {
  const env = await fixture(t, 'desktop'), settings = createPocketSettings(env)
  assert.deepEqual(await settings.status(), { supported: false })
  await assert.rejects(settings.save(false), /仅适用于 CLI/)
  await assert.rejects(settings.apply(), /仅适用于 CLI/)
})

test('reconfiguration starts only after install and brings GUI back after installation failure', async () => {
  const { reconfigurePocket } = await import('../bin/pocket-reconfigure.mjs')
  const events = []
  assert.equal(await reconfigurePocket({ install: async () => events.push('install'), start: async () => events.push('start'), writeStatus: async s => events.push(s.phase) }), true)
  assert.deepEqual(events, ['install', 'start', 'completed'])
  events.length = 0
  assert.equal(await reconfigurePocket({ install: async () => { throw Error('network unavailable') }, start: async () => events.push('start'), writeStatus: async s => events.push(s.phase) }), false)
  assert.deepEqual(events, ['failed', 'start'])
})

// Exercise the actual client registration lifecycle, including plugin absence.
test('手机访问入口在 Pocket 未安装时保留，安装后复用原入口，卸载客户端时清理', async () => {
  const { runInNewContext } = await import('node:vm')
  const source = await readFile(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
  const start = source.indexOf('            ctx.effect(() => slots.inject("dsh-pocket.service-control"')
  const end = source.indexOf('\n\t\t\tctx.effect(function () {', start)
  assert.ok(start > 0 && end > start)
  for (const [supported, installed, disposedEarly] of [[true, false, false], [true, true, false], [false, false, false], [true, false, true]]) {
    const registrations = [], cleanups = []
    let removed = 0, resolveStatus
    const response = new Promise(resolve => { resolveStatus = resolve })
    runInNewContext(source.slice(start, end), {
      ctx: { effect(fn) { cleanups.push(fn()) } },
      slots: { inject(name, fn) { return fn() }, entries() { return installed ? [{ options: { id: 'pocket' } }] : [] },
        register(options) { registrations.push(options); return () => { removed++ } } },
      rpc: () => response, TavernPocketSettings() {}, console,
    })
    if (disposedEarly) cleanups.forEach(fn => fn())
    resolveStatus({ pocket: { supported } })
    await response; await Promise.resolve()
    const pages = registrations.filter(item => item.name === 'settings.section')
    assert.equal(pages.length, supported && !installed && !disposedEarly ? 1 : 0)
    if (pages.length) { assert.equal(pages[0].id, 'pocket'); assert.equal(pages[0].label(), '手机访问') }
    if (!disposedEarly) cleanups.forEach(fn => fn())
    assert.equal(removed, registrations.length)
  }
})
