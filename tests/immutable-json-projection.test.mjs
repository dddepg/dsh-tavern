import test from 'node:test'
import assert from 'node:assert/strict'
import { createJsonValueProjectionCache } from '../tavern-plugin/lib/domain/immutable-json-projection.js'

test('对象缓存保持原 JSON 规范化及嵌套属性顺序，不以无序相等复用', () => {
  const cache = createJsonValueProjectionCache()
  for (const input of [
    { nested: { a: 1, b: 2 }, rows: [1, null] },
    { nested: { b: 2, a: 1 }, rows: [1, null] },
    { nested: { b: 2, a: 1 }, rows: [null, 1] },
    { missing: undefined, value: NaN, rows: [undefined] }
  ]) {
    assert.equal(JSON.stringify(cache('key', input, source => source)), JSON.stringify(input))
  }
})

test('对象缓存按容量和源数据加投影的体积淘汰，失败不复用旧投影', () => {
  const cache = createJsonValueProjectionCache({ capacity: 2, maxBytes: 100 })
  const project = source => source
  const a = cache('a', { n: 1 }, project)
  cache('b', {}, project)
  assert.equal(cache('a', { n: 1 }, project), a)
  cache('c', {}, project)
  assert.equal(cache('a', { n: 1 }, project), a)
  const big = { text: 'x'.repeat(1000) }
  assert.notEqual(cache('big', big, project), cache('big', big, project))
  // Even a tiny projection must budget its large source.
  assert.notEqual(cache('big', big, () => ({})), cache('big', big, () => ({})))
  assert.equal(cache('a', { n: 1 }, project), a)
  assert.throws(() => cache('a', { n: 2 }, () => { throw Error('invalid') }), /invalid/)
  assert.notEqual(cache('a', { n: 1 }, project), a)
})
