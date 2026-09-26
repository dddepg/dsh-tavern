import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { packagePages, publicFiles } from '../docs/manual/package.mjs'

test('Pages 仅发布用户文档，静态链接在项目子路径下完整可用', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'tavern-pages-test-'))
  const output = path.join(temporary, 'site')
  try {
    await packagePages(output)
    assert.deepEqual((await readdir(output)).sort(), ['.nojekyll', 'assets', 'examples', 'images', 'index.html', 'product.html'])
    for (const file of publicFiles) {
      assert.doesNotMatch(file, /(?:^|\/)(?:research|references|\.env)(?:\/|$)/)
      assert.ok(!file.endsWith('.mjs'), file)
    }
    for (const name of ['index.html', 'product.html']) {
      const html = await readFile(path.join(output, name), 'utf8')
      for (const [, ref] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
        if (/^(?:https?:|#)/.test(ref)) continue
        assert.ok(!ref.startsWith('/'), ref)
        await access(path.join(output, ref.split(/[?#]/)[0]))
      }
    }
    await assert.rejects(packagePages(output), { code: 'EEXIST' })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
