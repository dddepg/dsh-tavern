import assert from 'node:assert/strict'
import test from 'node:test'

import { usesStoryCompaction } from '../tavern-plugin/lib/domain/story-compaction.js'

test('只有剧情和剧本游玩会话使用剧情压缩', () => {
  assert.equal(usesStoryCompaction({ mode: 'story' }), true)
  assert.equal(usesStoryCompaction({ mode: 'script' }), true)
  assert.equal(usesStoryCompaction({ mode: 'card' }), false)
  assert.equal(usesStoryCompaction(undefined), false)
})
