import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
const code = source.slice(source.indexOf('async function expandTavernFrame('), source.indexOf('function TavernMessageFrame(props)'))
function harness() {
  const errors = []
  const expand = new Function('tavernErrorHub', code + ';return expandTavernFrame;')({ report: (...args) => errors.push(args) })
  return { expand, errors }
}
test('大屏使用已加载的可见 iframe，不创建或重新加载页面', async () => {
  const h = harness()
  let opened = 0
  const frame = { requestFullscreen: async () => { opened++ } }
  await h.expand({ querySelector: selector => {
    assert.equal(selector, 'iframe:not([aria-hidden="true"])')
    return frame
  } })
  assert.equal(opened, 1)
  assert.deepEqual(h.errors, [])
})
test('未加载、不支持或全屏被拒绝时显示错误，不抛出未处理拒绝', async () => {
  const h = harness()
  await h.expand(null)
  await h.expand({ querySelector: () => ({}) })
  await h.expand({ querySelector: () => ({ requestFullscreen: async () => { throw Error('denied') } }) })
  assert.equal(h.errors.length, 3)
  assert.equal(h.errors[2][1].message, 'denied')
})
