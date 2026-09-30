import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const create = vm.runInNewContext(readFileSync(new URL('../tavern-plugin/src/client/modules/session-resource-retention.js', import.meta.url), 'utf8') + ';createTavernSessionRetention')
function fixture() {
  let now = 0, sequence = 0
  const timers = new Map(), released = []
  const cache = create({ now: () => now, window: {
    setTimeout(fn, ms) { timers.set(++sequence, { fn, at: now + ms }); return sequence }, clearTimeout(id) { timers.delete(id) },
  } })
  return { cache, timers, released, hold(id, type) { return cache.hold(id, type, () => released.push(id + ':' + type)) },
    advance(ms) { now += ms; for (const [id,timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() } } }
}

test('React卸载不释放页面，离开后新建其他资源不能延后原截止时间', () => {
  const h = fixture(), unmount = h.cache.mount('A'); h.hold('A','iframe'); unmount()
  h.advance(500000); h.hold('A','status'); h.advance(100000)
  assert.deepEqual(h.released,['A:iframe','A:status'])
})

test('到期回调重新检查刚开始的脚本任务，不用上次空闲快照回收它', () => {
  const h = fixture(); let busy = false
  h.cache.select('A'); h.hold('A','scripts'); h.cache.busy('A', () => busy)
  h.cache.select('B'); busy = true; h.advance(600000)
  assert.equal(h.released.length,0)
  busy = false; h.cache.busy('A', () => busy); h.advance(0)
  assert.deepEqual(h.released,['A:scripts'])
})

const source = readFileSync(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const scopeSource = source.slice(source.indexOf('function createTavernHostArtifactScope(options)'), source.indexOf('const TAVERN_CARD_PHONE_HOST'))
test('后台手机脚本延迟查询仍能绑定事件和设置样式，不操作前台同名按钮', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' })
  try {
    dom.window.eval(readFileSync(new URL('../tavern-plugin/lib/vendor/runtime-assets/jquery/jquery.min.js', import.meta.url), 'utf8'))
    dom.window.eval(scopeSource + ';window.makeScope=createTavernHostArtifactScope')
    const a = dom.window.makeScope({ document: dom.window.document })
    const $a = a.bindJQuery(dom.window.jQuery)
    a.setVisible(false)
    $a('body').append($a('<button>', { id: 'mobile-trigger-btn', text: 'A' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    // mobile-phone.js binds at 0 ms and resets the position at 100 ms.
    let clicks = 0
    $a('#mobile-trigger-btn')[0].addEventListener('click', () => clicks++)
    $a('#mobile-trigger-btn')[0].style.removeProperty('left')
    assert.equal(dom.window.document.querySelector('#mobile-trigger-btn'), null)
    const b = dom.window.makeScope({ document: dom.window.document })
    const $b = b.bindJQuery(dom.window.jQuery)
    assert.equal($b('#mobile-trigger-btn').length, 0)
    $b('body').append('<button id="mobile-trigger-btn">B</button>')
    assert.equal($a('#mobile-trigger-btn').text(), 'A')
    assert.equal($a('body').find('#mobile-trigger-btn').text(), 'A')
    assert.equal($a('body #mobile-trigger-btn').text(), 'A')
    assert.equal($b('#mobile-trigger-btn').text(), 'B')
    b.setVisible(false); a.setVisible(true)
    $a('#mobile-trigger-btn').trigger('click')
    assert.equal(clicks, 1)
    assert.equal(dom.window.document.querySelector('#mobile-trigger-btn').textContent, 'A')
    a.setVisible(false)
    $a('#mobile-trigger-btn').remove()
    a.setVisible(true)
    assert.equal(dom.window.document.querySelector('#mobile-trigger-btn'), null)
    a.dispose(); b.dispose()
  } finally { dom.window.close() }
})

test('切走后异步创建或重新插入的卡片悬浮窗保持隔离，返回保留事件与状态', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><body><main id="app"></main></body>', { runScripts: 'outside-only' })
  try {
    dom.window.eval(readFileSync(new URL('../tavern-plugin/lib/vendor/runtime-assets/jquery/jquery.min.js', import.meta.url), 'utf8'))
    dom.window.eval(scopeSource + ';window.makeScope=createTavernHostArtifactScope')
    const a = dom.window.makeScope({ document: dom.window.document })
    const $ = a.bindJQuery ? a.bindJQuery(dom.window.jQuery) : dom.window.jQuery
    a.setVisible(false)
    // Same host-jQuery mounting pattern as the card's external-status-bar.js,
    // after an asynchronous import finishes in the retained background runtime.
    const button = $('<button id="rpg_status_bar-toggle">A</button>')
    let clicks = 0
    button.on('click', () => clicks++)
    $('body').append(button)
    const other = dom.window.document.createElement('button'); other.id = 'other-card'
    dom.window.document.body.append(other)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(dom.window.document.querySelector('#rpg_status_bar-toggle'), null)
    assert.equal(other.isConnected, true)
    a.setVisible(true)
    button.trigger('click'); assert.equal(clicks, 1)
    assert.equal(dom.window.document.querySelector('#rpg_status_bar-toggle'), button[0])
    a.setVisible(false)
    dom.window.document.body.append(button[0])
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(button[0].isConnected, false)
    a.dispose(); assert.equal(other.isConnected, true)
    $("body").append("<button id=retired>late</button>")
    assert.equal(dom.window.document.querySelector("#retired"), null)
  } finally { dom.window.close() }
})

test('explicitly created host nodes are parked before observer delivery and on delayed mount', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' })
  try {
    dom.window.eval(scopeSource + ';window.makeScope=createTavernHostArtifactScope')
    const scope = dom.window.makeScope({ document: dom.window.document })
    const button = scope.trackNode(dom.window.document.createElement('button'))
    dom.window.document.body.append(button)
    scope.setVisible(false)
    assert.equal(button.isConnected, false)
    const delayed = scope.trackNode(dom.window.document.createElement('div'))
    dom.window.document.body.append(delayed)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(delayed.isConnected, false)
    scope.setVisible(true)
    assert.equal(button.isConnected, true)
    assert.equal(delayed.isConnected, true)
    scope.dispose()
    assert.equal(button.isConnected, false)
    assert.equal(delayed.isConnected, false)
  } finally { dom.window.close() }
})

test('原生 insertAdjacentHTML 悬浮窗随对话隐藏，恢复同一节点与事件，后台插入也隔离', async () => {
  const {JSDOM}=await import('jsdom')
  const dom=new JSDOM('<body><main id="app"></main><iframe></iframe></body>',{runScripts:'outside-only'})
  try {
    dom.window.eval(scopeSource+';window.makeScope=createTavernHostArtifactScope')
    const composer=readFileSync(new URL('../tavern-plugin/src/client/legacy-composer.js',import.meta.url),'utf8')
    dom.window.eval(composer+';window.makeWindow=createTavernComposerWindow')
    const frame=dom.window.document.querySelector('iframe'), artifacts=dom.window.makeScope({document:dom.window.document})
    frame.__dshTavernHostArtifacts=artifacts
    const view=dom.window.makeWindow(frame.contentWindow,dom.window)
    // Exact mounting API used by the configuration assistant's pet launcher.
    view.parent.document.body.insertAdjacentHTML('beforeend','<button id="pet">pet</button>')
    const pet=dom.window.document.getElementById('pet');let clicks=0
    pet.addEventListener('click',()=>clicks++)
    artifacts.setVisible(false)
    assert.equal(dom.window.document.getElementById('pet'),null)
    view.top.document.body.insertAdjacentHTML('beforeend','<button id="late">late</button>')
    assert.equal(dom.window.document.getElementById('late'),null)
    assert.equal(view.parent.document.getElementById('pet'),pet)
    assert.equal(view.parent.getComputedStyle(view.parent.document.body).display,'block')
    assert.ok(view.parent.document.getElementById('late'))
    const unrelated=dom.window.document.createElement('aside');dom.window.document.body.append(unrelated)
    artifacts.setVisible(true)
    assert.equal(dom.window.document.getElementById('pet'),pet)
    pet.click();assert.equal(clicks,1)
    assert.ok(dom.window.document.getElementById('late'))
    artifacts.dispose();assert.equal(pet.isConnected,false);assert.equal(unrelated.isConnected,true)
    view.parent.document.body.insertAdjacentHTML('beforeend','<div id="retired-native"></div>')
    assert.equal(dom.window.document.getElementById('retired-native'),null)
  } finally {dom.window.close()}
})

test('浏览器原生 HTML 悬浮窗切换后不可见，切回可点击且不重复', async t => {
  const {chromium}=await import('playwright')
  const browser=await chromium.launch();t.after(()=>browser.close())
  const page=await browser.newPage()
  await page.setContent('<body><iframe></iframe></body>')
  const composer=readFileSync(new URL('../tavern-plugin/src/client/legacy-composer.js',import.meta.url),'utf8')
  await page.evaluate(({scopeSource,composer})=>{
    window.eval(scopeSource+';window.makeScope=createTavernHostArtifactScope')
    window.eval(composer+';window.makeWindow=createTavernComposerWindow')
    const frame=document.querySelector('iframe')
    window.artifacts=makeScope({document});frame.__dshTavernHostArtifacts=artifacts
    window.card=makeWindow(frame.contentWindow,window)
    card.parent.document.body.insertAdjacentHTML('beforeend','<button id="pet" style="position:fixed;right:10px;bottom:10px">悬浮窗</button>')
    window.clicks=0;document.querySelector('#pet').onclick=()=>clicks++
  },{scopeSource,composer})
  await page.getByRole('button',{name:'悬浮窗'}).click()
  await page.evaluate(()=>artifacts.setVisible(false))
  assert.equal(await page.locator('#pet').count(),0)
  await page.evaluate(()=>{
    card.parent.document.body.insertAdjacentHTML('beforeend','<div id="late">后台弹窗</div>')
    card.parent.document.getElementById('pet').dataset.saved='yes'
    artifacts.setVisible(true)
  })
  await page.getByRole('button',{name:'悬浮窗'}).click()
  assert.equal(await page.evaluate(()=>clicks),2)
  assert.equal(await page.locator('#pet').count(),1)
  assert.equal(await page.locator('#pet').getAttribute('data-saved'),'yes')
  await page.evaluate(()=>artifacts.dispose())
  assert.equal(await page.locator('#pet,#late').count(),0)
})

test('外部 import 模块同样使用所属会话的宿主 DOM，不绕过浮窗隔离', async t => {
  const {chromium}=await import('playwright')
  const {projectTavernHostScript}=await import('../tavern-plugin/lib/domain/tavern-host-script-projection.js')
  const browser=await chromium.launch();t.after(()=>browser.close())
  const page=await browser.newPage()
  await page.setContent('<body><iframe></iframe></body>')
  const composer=readFileSync(new URL('../tavern-plugin/src/client/legacy-composer.js',import.meta.url),'utf8')
  const remote=projectTavernHostScript(`const p=window.parent||window; p.document.body.insertAdjacentHTML('beforeend','<button id="external-pet">外部悬浮窗</button>'); p.document.getElementById('external-pet').onclick=()=>p.document.getElementById('external-pet').dataset.clicked='yes';`)
  await page.evaluate(async({scopeSource,composer,remote})=>{
    window.eval(scopeSource+';window.makeScope=createTavernHostArtifactScope')
    window.eval(composer+';window.makeWindow=createTavernComposerWindow')
    const frame=document.querySelector('iframe')
    window.artifacts=makeScope({document});frame.__dshTavernHostArtifacts=artifacts
    frame.contentWindow.__dshTavernComposerWindow=makeWindow(frame.contentWindow,window)
    const url=URL.createObjectURL(new Blob([remote],{type:'text/javascript'}))
    try {await frame.contentWindow.eval('import('+JSON.stringify(url)+')')} finally {URL.revokeObjectURL(url)}
  },{scopeSource,composer,remote})
  await page.getByRole('button',{name:'外部悬浮窗'}).click()
  await page.evaluate(()=>artifacts.setVisible(false))
  assert.equal(await page.locator('#external-pet').count(),0)
  await page.evaluate(()=>artifacts.setVisible(true))
  assert.equal(await page.locator('#external-pet').getAttribute('data-clicked'),'yes')
  await page.getByRole('button',{name:'外部悬浮窗'}).click()
})
