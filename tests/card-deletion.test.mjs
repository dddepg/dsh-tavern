import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createCardDeletion } from '../tavern-plugin/lib/domain/card-deletion.js'

const clientSource = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')

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

test('人物卡处于半删除状态时可以直接重试', async () => {
  let attempts = 0
  const deletion = createCardDeletion({
    resources: {
      async remove() { attempts += 1 },
      async unbindMaterial() {}
    }
  })

  await deletion.remove('cards/角色.json')
  await deletion.remove('cards/角色.json')
  assert.equal(attempts, 2)
})

test('人物卡库删除确认只问是否删除，不声称会删对话', () => {
  assert.match(clientSource, /从人物卡库删除“" \+ card\.name \+ "”吗？/)
  assert.doesNotMatch(clientSource, /相关对话都会删除/)
})

test('游玩选卡页顶栏可以进入批量删除，并复用已有批量删除流程', () => {
  const picker = clientSource.slice(clientSource.indexOf('选择人物卡 · 开始游玩'), clientSource.indexOf('还没有人物卡。'))
  assert.match(picker, /"批量删除"/)
  assert.match(picker, /cardBatch\.begin\(\)/)
  assert.match(picker, /cardBatch\.reset\(\)/)
  assert.match(picker, /cardBatch\.checkbox\(card\)/)
  assert.match(picker, /cardBatch\.managing\) cardBatch\.toggle\(card\.path\); else preparePlayConversation\(card\)/)
})
