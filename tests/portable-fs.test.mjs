import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, lstatSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { copyTreeSync, removeTreeSync } from '../bin/portable-fs.mjs'

test('非 ASCII 路径：递归复制并删除目录树', () => {
  const root = mkdtempSync(path.join(tmpdir(), '赵 的酒馆-'))
  const source = path.join(root, '源'), target = path.join(root, 'apps', '酒馆.staging')
  mkdirSync(path.join(source, '子目录'), { recursive: true })
  writeFileSync(path.join(source, '子目录', '文件.txt'), '内容')
  writeFileSync(path.join(source, '.dsh-tavern-release.json'), '{}')
  copyTreeSync(source, target)
  assert.equal(readFileSync(path.join(target, '子目录', '文件.txt'), 'utf8'), '内容')
  assert.ok(existsSync(path.join(target, '.dsh-tavern-release.json')))
  removeTreeSync(path.join(target, '.dsh-tavern-release.json'))
  assert.ok(!existsSync(path.join(target, '.dsh-tavern-release.json')))
  removeTreeSync(root)
  assert.ok(!existsSync(root))
  removeTreeSync(root)
})

test('符号链接：默认按链接复制，dereference 复制目标；删除不跟随链接', { skip: process.platform === 'win32' && '需要符号链接权限' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'portable-fs-'))
  const outside = path.join(root, 'outside'), source = path.join(root, 'source')
  mkdirSync(outside); writeFileSync(path.join(outside, 'keep.txt'), 'keep')
  mkdirSync(source); symlinkSync(outside, path.join(source, 'link'))
  copyTreeSync(source, path.join(root, 'linked'))
  assert.equal(readlinkSync(path.join(root, 'linked', 'link')), outside)
  copyTreeSync(source, path.join(root, 'copied'), { dereference: true })
  assert.ok(lstatSync(path.join(root, 'copied', 'link')).isDirectory())
  removeTreeSync(source)
  assert.equal(readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep')
  removeTreeSync(root)
})
