import assert from 'node:assert/strict'
import test from 'node:test'
import { patchConversationBackground } from '../tavern-plugin/lib/domain/conversation-background.js'

test('搜索和生图只保存到本局，旧全局开关只迁移一次', async () => {
  const { adoptConversationFeatures } = await import('../tavern-plugin/lib/domain/conversation-background.js')
  const first = adoptConversationFeatures({ id: 'a' }, { webSearchEnabled: true }, true)
  const other = adoptConversationFeatures({ id: 'b' }, { webSearchEnabled: true }, true)
  const changed = patchConversationBackground(first, { webSearchEnabled: false, sceneImagesEnabled: false })
  assert.equal(changed.webSearchEnabled, false)
  assert.equal(changed.sceneImagesEnabled, false)
  assert.equal(other.webSearchEnabled, true)
  assert.equal(other.sceneImagesEnabled, true)
  assert.equal(adoptConversationFeatures(changed, { webSearchEnabled: true }, true), changed)
  assert.throws(() => patchConversationBackground(first, { sceneImagesEnabled: 'yes' }), /布尔值/)
})
