import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { prepare, swap, rollback, commit, discard, stagedPaths } from '../bin/staged-app-install.mjs'

function write(root, relative, text = relative) {
  const file = path.join(root, ...relative.split('/'))
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
function read(root, relative) { return readFileSync(path.join(root, ...relative.split('/')), 'utf8') }
function tree(root) {
  const files = []
  const walk = relative => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const next = relative ? relative + '/' + entry.name : entry.name
      if (entry.isDirectory()) walk(next); else files.push(next)
    }
  }
  walk('')
  return files.sort()
}
function release(root, version, files) {
  for (const file of files) write(root, file, version + ':' + file)
}

function fixture(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'tavern-staged-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const app = path.join(base, 'apps', 'dsh-tavern')
  return { base, app, source: version => path.join(base, 'source-' + version) }
}

const COMMIT = 'a'.repeat(40)

test('全新安装：暂存后切换，提交后不留下暂存或旧目录', t => {
  const { app, source } = fixture(t)
  release(source('v1'), 'v1', ['package.json', 'bin/dsh-tavern.mjs'])
  prepare({ app, source: source('v1'), commit: COMMIT })
  assert.equal(existsSync(app), false, '准备阶段不触碰正式目录')
  swap(app)
  assert.equal(read(app, 'bin/dsh-tavern.mjs'), 'v1:bin/dsh-tavern.mjs')
  assert.equal(JSON.parse(read(app, '.dsh-tavern-release.json')).commit, COMMIT)
  assert.deepEqual(read(app, '.dsh-tavern-files.txt').trim().split('\n'), ['bin/dsh-tavern.mjs', 'package.json'])
  commit(app)
  const paths = stagedPaths(app)
  assert.deepEqual([existsSync(paths.staging), existsSync(paths.previous), existsSync(path.join(app, '.dsh-tavern-swap.json'))], [false, false, false])
})

function installV1(app, source) {
  release(source('v1'), 'v1', ['package.json', 'bin/dsh-tavern.mjs', 'bin/retired.mjs', 'tavern-plugin/lib/index.js'])
  prepare({ app, source: source('v1') }); swap(app); commit(app)
  // Things the release did not install: legacy data, a user file nested in a
  // release directory, local markers and dependencies of this release.
  write(app, 'data/chats/one.json', '{"chat":1}')
  write(app, 'tavern-plugin/lib/user-note.txt', '用户自己的文件')
  write(app, '.dsh-tavern-local.json', '{"host":"cli"}')
  write(app, 'node_modules/old-dep/index.js', 'old')
}

test('升级：只搬运用户文件，旧依赖与已退役的发布文件不带入新版本', t => {
  const { app, source } = fixture(t)
  installV1(app, source)
  release(source('v2'), 'v2', ['package.json', 'bin/dsh-tavern.mjs', 'tavern-plugin/lib/index.js'])
  prepare({ app, source: source('v2'), commit: COMMIT })
  write(stagedPaths(app).staging, 'node_modules/new-dep/index.js', 'new')
  assert.equal(read(app, 'bin/dsh-tavern.mjs'), 'v1:bin/dsh-tavern.mjs', '准备和安装依赖期间旧版本保持不变')
  swap(app)
  assert.deepEqual(tree(app), [
    '.dsh-tavern-files.txt', '.dsh-tavern-local.json', '.dsh-tavern-release.json', '.dsh-tavern-swap.json',
    'bin/dsh-tavern.mjs', 'data/chats/one.json', 'node_modules/new-dep/index.js', 'package.json',
    'tavern-plugin/lib/index.js', 'tavern-plugin/lib/user-note.txt'])
  assert.equal(read(app, 'bin/dsh-tavern.mjs'), 'v2:bin/dsh-tavern.mjs')
  assert.equal(read(app, 'data/chats/one.json'), '{"chat":1}')
  assert.equal(read(app, 'tavern-plugin/lib/user-note.txt'), '用户自己的文件')
  commit(app)
  assert.equal(existsSync(stagedPaths(app).previous), false)
})

test('切换后失败可回滚：原版本、用户数据和旧依赖原样恢复', t => {
  const { app, source } = fixture(t)
  installV1(app, source)
  const before = tree(app).map(file => [file, read(app, file)])
  release(source('v2'), 'v2', ['package.json', 'bin/dsh-tavern.mjs'])
  prepare({ app, source: source('v2') })
  swap(app)
  write(app, 'data/chats/during-v2.json', '新版本运行期间写入')
  assert.equal(rollback(app), true)
  assert.deepEqual(tree(app).filter(file => file !== 'data/chats/during-v2.json').map(file => [file, read(app, file)]), before)
  assert.equal(read(app, 'data/chats/during-v2.json'), '新版本运行期间写入', '切换后写入的用户数据随数据目录一起保留')
  const paths = stagedPaths(app)
  assert.deepEqual([existsSync(paths.staging), existsSync(paths.previous), existsSync(app + '.failed')], [false, false, false])
})

test('全新安装失败回滚后不留下半成品目录', t => {
  const { app, source } = fixture(t)
  release(source('v1'), 'v1', ['package.json'])
  prepare({ app, source: source('v1') })
  swap(app)
  assert.equal(rollback(app), true)
  assert.equal(existsSync(app), false)
})

test('未切换就失败：丢弃暂存目录，正在运行的版本不受影响', t => {
  const { app, source } = fixture(t)
  installV1(app, source)
  release(source('v2'), 'v2', ['package.json'])
  prepare({ app, source: source('v2') })
  discard(app)
  assert.equal(existsSync(stagedPaths(app).staging), false)
  assert.equal(read(app, 'bin/dsh-tavern.mjs'), 'v1:bin/dsh-tavern.mjs')
  assert.equal(rollback(app), false, '没有切换记录时回滚不做任何事')
  assert.equal(read(app, 'bin/dsh-tavern.mjs'), 'v1:bin/dsh-tavern.mjs')
})

test('上次在切换中途被强制结束：下次安装先恢复可用的原版本', t => {
  const { app, source } = fixture(t)
  installV1(app, source)
  const paths = stagedPaths(app)
  // Killed right after renaming the app away, before the new one moved in.
  release(source('v2'), 'v2', ['package.json'])
  prepare({ app, source: source('v2') })
  rmSync(paths.previous, { recursive: true, force: true })
  renameSync(app, paths.previous)
  assert.equal(existsSync(app), false)
  release(source('v3'), 'v3', ['package.json', 'bin/dsh-tavern.mjs'])
  prepare({ app, source: source('v3') })
  assert.equal(read(app, 'bin/dsh-tavern.mjs'), 'v1:bin/dsh-tavern.mjs', '恢复原版本后才开始新的准备')
  assert.equal(existsSync(paths.previous), false)
  swap(app)
  assert.equal(read(app, 'data/chats/one.json'), '{"chat":1}')
})

test('切换中途（两次改名之后、搬运用户文件之前）被强制结束：恢复时不会删掉仍在旧目录里的用户数据', t => {
  const { app, source } = fixture(t)
  installV1(app, source)
  const paths = stagedPaths(app)
  release(source('v2'), 'v2', ['package.json', 'bin/dsh-tavern.mjs'])
  prepare({ app, source: source('v2') })
  // Simulate the swap being killed right after the record is written.
  renameSync(app, paths.previous)
  renameSync(paths.staging, app)
  writeFileSync(path.join(app, '.dsh-tavern-swap.json'), JSON.stringify({ fresh: false, moved: [] }) + '\n')
  release(source('v3'), 'v3', ['package.json'])
  prepare({ app, source: source('v3') })
  assert.equal(read(app, 'data/chats/one.json'), '{"chat":1}', '原版本连同用户数据一起恢复')
  assert.equal(read(app, 'bin/dsh-tavern.mjs'), 'v1:bin/dsh-tavern.mjs')
  assert.equal(existsSync(paths.previous), false)
})

test('提交删除旧目录后、清除记录前中断：回滚识别为已提交，不报错也不改动新版本', t => {
  const { app, source } = fixture(t)
  installV1(app, source)
  release(source('v2'), 'v2', ['package.json', 'bin/dsh-tavern.mjs'])
  prepare({ app, source: source('v2') })
  swap(app)
  rmSync(stagedPaths(app).previous, { recursive: true, force: true })
  assert.equal(rollback(app), false)
  assert.equal(read(app, 'bin/dsh-tavern.mjs'), 'v2:bin/dsh-tavern.mjs')
  assert.equal(read(app, 'data/chats/one.json'), '{"chat":1}')
  assert.equal(existsSync(path.join(app, '.dsh-tavern-swap.json')), false)
})
