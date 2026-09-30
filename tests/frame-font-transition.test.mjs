import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { helperClient } from './fixtures/helper-host-harness.mjs'

test('字号重测不读取 CSS transition 保留的上一次放大值', () => {
  const html = helperClient.buildTavernFrameDocument({ content: '', token: 'font' })
  const script = [...html.matchAll(/<script data-dsh-tavern-font-runtime>([\s\S]*?)<\/script>/g)].at(-1)[1]
  let mutation, receive, transitionDisabled = false, visibleSize = 20
  const attrs = new Map(), props = new Map()
  const node = {
    tagName: 'SPAN', childNodes: [{ nodeType: 3, nodeValue: '文字' }], closest() { return null },
    hasAttribute: key => attrs.has(key), getAttribute: key => attrs.get(key) || null,
    setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key),
    querySelectorAll: () => [],
    style: {
      getPropertyValue: key => props.get(key) || '', getPropertyPriority: () => '',
      setProperty: (key, value) => props.set(key, value), removeProperty: key => props.delete(key)
    }
  }
  const body = { ...node, tagName: 'BODY', childNodes: [], style: null,
    querySelectorAll: selector => selector.startsWith('[') ? (attrs.size ? [node] : []) : [node],
    hasAttribute: () => false }
  const parent = {}
  const context = {
    document: { body, documentElement: {}, head: { appendChild() { transitionDisabled = true } },
      createElement: () => ({ setAttribute() {}, remove() { transitionDisabled = false } }),
      addEventListener() {}, removeEventListener() {} },
    parent, window: {}, MutationObserver: class { constructor(fn) { mutation = fn } observe() {} disconnect() {} },
    requestAnimationFrame: fn => fn(),
    addEventListener(name, fn) { if (name === 'message') receive = fn }, removeEventListener() {},
    getComputedStyle() { return { fontSize: String(transitionDisabled ? parseFloat(props.get('font-size') || '20') : visibleSize), lineHeight: 'normal' } }
  }
  vm.runInNewContext(script, context)
  receive({ source: parent, data: { type: 'dsh-tavern-font-size', token: 'font', fontSize: 21 } })
  for (let i = 0; i < 4; i++) {
    visibleSize = parseFloat(props.get('font-size')) // Previous transition has completed.
    mutation()
    assert.equal(parseFloat(props.get('font-size')), 30)
  }
})

test('font scaling preserves a card transform transition instead of snapping it on every mouse move', async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => route.abort())
    await page.setContent('<iframe style="width:800px;height:600px"></iframe>')
    const html = helperClient.buildTavernFrameDocument({ token: 'motion',
      content: '<style>#card{transition:transform 2s linear}span{font-size:20px}</style><div id="card"><span>Click here</span></div>' })
    await page.evaluate(html => { document.querySelector('iframe').srcdoc = html }, html)
    const frame = page.frames()[1]
    await frame.locator('#card').waitFor()
    await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ type: 'dsh-tavern-font-size', token: 'motion', fontSize: 21 }, '*'))
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('span')).fontSize === '30px')
    const result = await frame.evaluate(async () => {
      const card = document.querySelector('#card')
      card.style.transform = 'translateY(-100px)'
      await new Promise(resolve => setTimeout(resolve, 120))
      return { y: new DOMMatrixReadOnly(getComputedStyle(card).transform).m42,
        font: getComputedStyle(document.querySelector('span')).fontSize }
    })
    assert.ok(result.y > -50 && result.y < 0, `transform should still interpolate, got ${result.y}`)
    assert.equal(result.font, '30px')
    // Real font changes still trigger recalculation after transform-only writes are ignored.
    await frame.locator('span').evaluate(node => { node.style.fontSize = '24px' })
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('span')).fontSize === '36px')
  } finally { await browser.close() }
})
