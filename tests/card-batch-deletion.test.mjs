import assert from 'node:assert/strict'
import test from 'node:test'
import { helperClient } from './fixtures/helper-host-harness.mjs'

test('空选择不删除；服务端未确认删除时不报告成功', async () => {
  assert.equal((await helperClient.deleteTavernCards([], () => { throw Error('unexpected') })).length, 0)
  const result = await helperClient.deleteTavernCards([{ path: 'cards/a.json', name: 'a' }], async () => ({ deleted: false }))
  assert.equal(result[0].ok, false)
})
