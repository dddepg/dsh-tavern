import assert from 'node:assert/strict'

import test from 'node:test'

import { createCardDeletion } from '../tavern-plugin/lib/domain/card-deletion.js'

test('删除人物卡只清理人物卡文件和绑定，不触碰已有对话', async () => {
  const calls = []
  const deletion = createCardDeletion({
    resources: {
      async remove(path) { calls.push(['remove', path]) },
      async unbindMaterial(path) { calls.push(['unbindMaterial', path]) }
    }
  })

  assert.deepEqual(await deletion.remove('cards/角色.json'), {
    deleted: true,
    cardPath: 'cards/角色.json'
  })
  assert.deepEqual(calls, [
    ['remove', 'cards/角色.json'],
    ['unbindMaterial', 'cards/角色.json']
  ])
})
