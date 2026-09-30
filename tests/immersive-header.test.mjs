import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../tavern-plugin/src/client/ui/message-frame.js', import.meta.url), 'utf8')
const code = source.slice(source.indexOf('function nativeFullscreenElement('), source.indexOf('function TavernImmersiveAction('))
const install = new Function(code + ';return installTavernImmersiveMode')()

function htmlList() {
  const classes = new Set()
  return {
    classes,
    classList: {
      add: k => classes.add(k),
      remove: k => classes.delete(k),
      contains: k => classes.has(k),
      toggle(k, on) { if (on) classes.add(k); else classes.delete(k) }
    }
  }
}

test('全屏时不插入居中恢复条，退出仍走顶栏同一颗按钮', () => {
  const html = htmlList()
  const headerClasses = new Set()
  let focused = ''
  const header = {
    classList: { add: k => headerClasses.add(k), remove: k => headerClasses.delete(k), contains: k => headerClasses.has(k) },
    ownerDocument: { documentElement: html },
    before() { throw new Error('should not insert restore') }
  }
  const controller = install({ closest: () => header, focus: () => { focused = 'entry' } })
  controller.enter()
  assert.equal(html.classes.has('dsh-tavern-play-fullscreen'), true)
  assert.equal(headerClasses.has('dsh-tavern-immersive-header'), false)
  assert.equal(focused, 'entry')
  controller.leave()
  assert.equal(html.classes.has('dsh-tavern-play-fullscreen'), false)
  controller.dispose()
  assert.equal(html.classes.size, 0)
})

test('全屏请求失败时仍只瘦顶栏，并可退出', async () => {
  const html = htmlList()
  const headerClasses = new Set()
  let requested = false
  html.requestFullscreen = async () => { requested = true; throw new Error('denied') }
  const header = {
    classList: { add: k => headerClasses.add(k), remove: k => headerClasses.delete(k), contains: k => headerClasses.has(k) },
    ownerDocument: { documentElement: html },
    before() { throw new Error('should not insert restore') }
  }
  const controller = install({ closest: () => header, focus() {} })
  controller.enter()
  await Promise.resolve()
  assert.equal(requested, true)
  assert.equal(html.classes.has('dsh-tavern-play-fullscreen'), true)
  assert.equal(headerClasses.has('dsh-tavern-immersive-header'), false)
  controller.leave()
  assert.equal(html.classes.has('dsh-tavern-play-fullscreen'), false)
})


test('延迟全屏请求不能在退出或卸载后恢复沉浸状态', async () => {
  for (const action of ['leave', 'dispose']) {
    const html = htmlList(), doc = { documentElement: html }
    let complete, exits = 0
    html.requestFullscreen = () => new Promise(resolve => { complete = () => { doc.fullscreenElement = html; resolve() } })
    doc.exitFullscreen = async () => { exits++; doc.fullscreenElement = null }
    const controller = install({ closest: () => ({ ownerDocument: doc }), focus() {} })
    controller.enter(); controller[action](); complete()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(html.classes.has('dsh-tavern-play-fullscreen'), false)
    assert.equal(doc.fullscreenElement, null)
    assert.equal(exits, 1)
  }
})

test('已完成的原生全屏在卸载时退出，其他元素的全屏保持不变', async () => {
  for (const owned of [true, false]) {
    const html = htmlList(), doc = { documentElement: html }
    let exits = 0
    html.requestFullscreen = async () => { doc.fullscreenElement = html }
    doc.exitFullscreen = async () => { exits++; doc.fullscreenElement = null }
    const controller = install({ closest: () => ({ ownerDocument: doc }), focus() {} })
    if (owned) { controller.enter(); await new Promise(resolve => setImmediate(resolve)) }
    else doc.fullscreenElement = { tagName: 'IFRAME' }
    controller.dispose()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(exits, owned ? 1 : 0)
    assert.equal(!!doc.fullscreenElement, !owned)
  }
})

test('挂载全屏按钮时立即同步已有原生全屏，第一次点击即可退出', async () => {
  const html = htmlList(), doc = { documentElement: html, fullscreenElement: html }
  let exits = 0, state = false
  doc.exitFullscreen = async () => { exits++; doc.fullscreenElement = null }
  const button = { ownerDocument: doc, closest: () => ({ ownerDocument: doc }), focus() {} }
  const refs = [{ current: button }, { current: null }], effects = []
  let cursor = 0
  const React = { useRef: () => refs[cursor++], useState: () => [state, next => { state = next }], useEffect: fn => effects.push(fn), createElement: (type, props) => ({ type, props }) }
  const componentCode = source.slice(source.indexOf('function nativeFullscreenElement('), source.indexOf('async function expandTavernFrame('))
  const Component = new Function('React', componentCode + ';return TavernImmersiveAction')(React)
  Component(); const dispose = effects[0](); cursor = 0
  const rendered = Component()
  assert.equal(rendered.props['aria-pressed'], true)
  rendered.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(exits, 1)
  dispose()
})
