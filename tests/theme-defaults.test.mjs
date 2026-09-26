import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureTavernThemeDefaults } from '../tavern-plugin/lib/domain/theme-defaults.js'

test('new Tavern host starts with no wallpaper, while later skin gradients remain available', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'tavern-theme-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  assert.equal(ensureTavernThemeDefaults(home), true)
  const file = path.join(home, 'dream-skin.json')
  const state = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(state['dsh-dream-skin:wallpaper-kind'], 'image')
  for (const key of ['wallpaper', 'wallpaper-url', 'wallpaper-gradient']) assert.equal(state['dsh-dream-skin:' + key], null)
  assert.equal(JSON.parse(state['dsh-dream-skin:wallpaper-refresh']).on, false)
  assert.equal(ensureTavernThemeDefaults(home), false)
})

test('existing preferences and even invalid state are never overwritten', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'tavern-theme-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const file = path.join(home, 'dream-skin.json')
  for (const saved of ['{"dsh-dream-skin:wallpaper":"my-image"}', '{}', '{invalid']) {
    await writeFile(file, saved)
    assert.equal(ensureTavernThemeDefaults(home), false)
    assert.equal(await readFile(file, 'utf8'), saved)
  }
})
