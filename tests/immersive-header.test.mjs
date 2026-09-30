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

test('全屏时折叠顶栏，退出仍走同一颗按钮', () => {
  const html = htmlList()
  const headerClasses = new Set()
  let focused = ''
  const header = {
    classList: { add: k => headerClasses.add(k), remove: k => headerClasses.delete(k), contains: k => headerClasses.has(k), toggle(k, on) { if (on) headerClasses.add(k); else headerClasses.delete(k) } },
    ownerDocument: { documentElement: html },
    before() { throw new Error('should not insert restore') }
  }
  const controller = install({ closest: () => header, focus: () => { focused = 'entry' } })
  controller.enter()
  assert.equal(html.classes.has('dsh-tavern-play-fullscreen'), true)
  assert.equal(headerClasses.has('dsh-tavern-immersive-header'), true)
  assert.equal(focused, 'entry')
  controller.leave()
  assert.equal(headerClasses.has('dsh-tavern-immersive-header'), false)
  assert.equal(html.classes.has('dsh-tavern-play-fullscreen'), false)
  controller.dispose()
  assert.equal(html.classes.size, 0)
})

test('全屏请求失败时仍折叠顶栏，并可退出', async () => {
  const html = htmlList()
  const headerClasses = new Set()
  let requested = false
  html.requestFullscreen = async () => { requested = true; throw new Error('denied') }
  const header = {
    classList: { add: k => headerClasses.add(k), remove: k => headerClasses.delete(k), contains: k => headerClasses.has(k), toggle(k, on) { if (on) headerClasses.add(k); else headerClasses.delete(k) } },
    ownerDocument: { documentElement: html },
    before() { throw new Error('should not insert restore') }
  }
  const controller = install({ closest: () => header, focus() {} })
  controller.enter()
  await Promise.resolve()
  assert.equal(requested, true)
  assert.equal(html.classes.has('dsh-tavern-play-fullscreen'), true)
  assert.equal(headerClasses.has('dsh-tavern-immersive-header'), true)
  controller.leave()
  assert.equal(headerClasses.has('dsh-tavern-immersive-header'), false)
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

test('桌面和窄屏折叠顶部栏后，同一全屏按钮仍可点击退出', async t => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const css = await readFile(new URL('../tavern-plugin/lib/client-assets/tavern.css', import.meta.url), 'utf8')
  for (const width of [1344, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } })
    await page.setContent('<body class="dsh-tavern-shell-active"><div data-mobile-nav="frame"><div data-phase="idle"><header style="padding:16px"><div class="_titleRow"><span id="title">会话标题</span><div class="_headerActions"><button class="dsh-tavern-play-fullscreen">⛶</button></div></div><nav>状态栏</nav></header><main>正文</main></div></div></body>')
    await page.addStyleTag({ content: css })
    await page.evaluate(code => {
      const install = new Function(code + ';return installTavernImmersiveMode')()
      // Exercise the embedded-host fallback independently of headless fullscreen support.
      document.documentElement.requestFullscreen = () => Promise.reject(new Error('denied'))
      const button = document.querySelector('button'), controller = install(button)
      button.onclick = () => document.documentElement.classList.contains('dsh-tavern-play-fullscreen') ? controller.leave() : controller.enter()
    }, code)
    await page.locator('button').click()
    assert.equal(await page.locator('header').evaluate(e => e.getBoundingClientRect().height), 0)
    assert.equal(await page.locator('#title').isVisible(), false)
    assert.equal(await page.locator('button').isVisible(), true)
    await page.locator('button').click()
    assert.equal(await page.locator('#title').isVisible(), true)
    assert.ok(await page.locator('header').evaluate(e => e.getBoundingClientRect().height) > 0)
    await page.close()
  }
})
