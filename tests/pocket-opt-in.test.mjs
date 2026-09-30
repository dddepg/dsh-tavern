import test from 'node:test'
import assert from 'node:assert/strict'

test('disabled Pocket omits its pnpm patch without weakening other patch validation', async () => {
  const { prepareProfileWorkspace } = await import('../bin/profile-configuration.mjs')
  const { parse } = await import('yaml')
  const workspace = 'patchedDependencies:\n  dsh-pocket@2.10.6: patches/pocket.patch\n  another@1: patches/another.patch\n'
  assert.deepEqual(parse(prepareProfileWorkspace(workspace, { dependencies: {} })).patchedDependencies, { 'another@1': 'patches/another.patch' })
  assert.equal(parse(prepareProfileWorkspace(workspace, { dependencies: { 'dsh-pocket': '2.10.6' } })).patchedDependencies['dsh-pocket@2.10.6'], 'patches/pocket.patch')
})
