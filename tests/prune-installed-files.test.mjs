import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { INVENTORY, pruneInstalledFiles } from '../bin/prune-installed-files.mjs'

async function tree(root, files) {
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true })
    await writeFile(path.join(root, relative), text)
  }
}

test('更新只删除上一版安装、新版已不包含的文件；首次安装不删任何东西，用户数据不受影响', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prune-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = path.join(root, 'app'), v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2')
  await tree(v1, { 'package.json': '1', 'bin/old.mjs': 'old', 'presets/tavern/skills/retired/SKILL.md': 'x', 'presets/tavern/skills/kept/SKILL.md': 'k' })
  await tree(v2, { 'package.json': '2', 'presets/tavern/skills/kept/SKILL.md': 'k2', 'bin/new.mjs': 'new' })
  // Files the installer never shipped (user data, deps, ad-hoc files) must survive.
  await tree(app, { 'data/chats/a.json': 'chat', 'node_modules/x/index.js': 'dep', 'bin/local-note.txt': 'mine', 'bin/old.mjs': 'old' })

  assert.deepEqual(pruneInstalledFiles(v1, app), [])
  assert.ok(existsSync(path.join(app, 'bin/old.mjs')))
  assert.match(await readFile(path.join(app, INVENTORY), 'utf8'), /presets\/tavern\/skills\/retired\/SKILL\.md/)
  await tree(app, { 'presets/tavern/skills/retired/SKILL.md': 'x', 'presets/tavern/skills/kept/SKILL.md': 'k', 'package.json': '1' })

  assert.deepEqual(pruneInstalledFiles(v2, app).sort(), ['bin/old.mjs', 'presets/tavern/skills/retired/SKILL.md'])
  assert.equal(existsSync(path.join(app, 'presets/tavern/skills/retired')), false)
  assert.ok(existsSync(path.join(app, 'presets/tavern/skills/kept/SKILL.md')))
  for (const kept of ['data/chats/a.json', 'node_modules/x/index.js', 'bin/local-note.txt']) assert.ok(existsSync(path.join(app, kept)), kept)
  assert.equal((await readFile(path.join(app, INVENTORY), 'utf8')).trim().split('\n').join(','), 'bin/new.mjs,package.json,presets/tavern/skills/kept/SKILL.md')
})

test('损坏或恶意的清单不能删到程序目录之外或用户数据', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prune-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = path.join(root, 'app'), source = path.join(root, 'src')
  await tree(source, { 'package.json': '1' })
  await tree(root, { 'outside.txt': 'keep' })
  await tree(app, { 'data/x.json': 'keep', 'node_modules/y.js': 'keep', [INVENTORY]: ['../outside.txt', '/etc/hosts', 'data/x.json', 'node_modules/y.js', 'a/../../outside.txt', 'C:/x', 'bin\\x'].join('\n') })
  assert.deepEqual(pruneInstalledFiles(source, app), [])
  for (const kept of ['outside.txt', 'app/data/x.json', 'app/node_modules/y.js']) assert.ok(existsSync(path.join(root, kept)), kept)
})
