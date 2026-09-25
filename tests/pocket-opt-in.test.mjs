import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mergeProfileManifest } from '../bin/profile-configuration.mjs'
const source = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
const options = { source, pluginPath: '/app/tavern-plugin', dataRoot: '/data', host: 'cli' }
function pocket(manifest, expected) {
  assert.equal(Object.hasOwn(manifest.dependencies, 'dsh-pocket'), expected)
  for (const list of [manifest.dsh.profile.bundles, manifest.dshTavern.managedBundles, manifest.dshTavern.managedDependencies]) assert.equal(list.includes('dsh-pocket'), expected)
  assert.equal(manifest.dshTavern.cliPocketEnabled, undefined)
}
test('fresh and legacy forced Pocket CLI installs default to off, including unrecorded dependencies', () => {
  for (const current of [{}, { dependencies: { 'dsh-pocket': '2.10.6', 'dsh-webui-auth': '1.0.0' }, dsh: { profile: { bundles: ['dsh-pocket', 'dsh-webui-auth'] } } }]) {
    const next = mergeProfileManifest({ ...options, current })
    pocket(next, false)
    pocket(mergeProfileManifest({ ...options, current: next }), false)
    if (current.dependencies) assert.equal(next.dependencies['dsh-webui-auth'], '1.0.0')
  }
})
test('legacy explicit enable is removed and cannot return on upgrades', () => {
  let current = mergeProfileManifest({ ...options, current: { dshTavern: { cliPocketEnabled: true } } })
  pocket(current, false)
  current = mergeProfileManifest({ ...options, current }); pocket(current, false)
  current = mergeProfileManifest({ ...options, current: { ...current, dshTavern: { ...current.dshTavern, cliPocketEnabled: false } } }); pocket(current, false)
  current = mergeProfileManifest({ ...options, current }); pocket(current, false)
})

test('disabled Pocket omits its pnpm patch without weakening other patch validation', async () => {
  const { prepareProfileWorkspace } = await import('../bin/profile-configuration.mjs')
  const { parse } = await import('yaml')
  const workspace = 'patchedDependencies:\n  dsh-pocket@2.10.6: patches/pocket.patch\n  another@1: patches/another.patch\n'
  assert.deepEqual(parse(prepareProfileWorkspace(workspace, { dependencies: {} })).patchedDependencies, { 'another@1': 'patches/another.patch' })
  assert.equal(parse(prepareProfileWorkspace(workspace, { dependencies: { 'dsh-pocket': '2.10.6' } })).patchedDependencies['dsh-pocket@2.10.6'], 'patches/pocket.patch')
})
