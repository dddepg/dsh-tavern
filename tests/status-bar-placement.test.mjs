import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
const route = source.slice(source.indexOf("      case 'setStatusBarPlacement':"), source.indexOf("      case 'setPlayerName':"))
test('状态栏位置按本局保存，不改变剧情、变量或提示词缓存基准', async () => {
  const games = { a: { id: 'a', mode: 'story', messages: ['正文'], variables: { hp: 10 }, cardContextSnapshot: '提示词', cardContextRevision: 7 }, b: { id: 'b', mode: 'story' }, c: { id: 'c', mode: 'card' } }
  const original = structuredClone(games.a)
  const run = new Function('args', 'chatForSession', 'updateChat', `return (async()=>{switch('setStatusBarPlacement'){${route}}})()`)
  const save = args => run(args, async id => games[id], async (id, change) => { games[id] = change(games[id]) })
  await save({ sessionId: 'a', placement: 'body' })
  assert.deepEqual(games.a, { ...original, statusBarPlacement: 'body' })
  assert.equal(games.b.statusBarPlacement, undefined)
  await assert.rejects(save({ sessionId: 'a', placement: 'invalid' }), /无效/)
  await assert.rejects(save({ sessionId: 'c', placement: 'body' }), /游玩/)
  await save({ sessionId: 'a', placement: 'sidebar' })
  assert.deepEqual(games.a, { ...original, statusBarPlacement: 'sidebar' })
})

test('状态栏在正文和侧栏之间移动时保留同一个 iframe 和输入状态', async () => {
  const retained = await readFile(new URL('../tavern-plugin/src/client/modules/retained-message-frames.js', import.meta.url), 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="sidebar"></div><div id="body"></div>')
    await page.addScriptTag({ content: retained + `
      window.starts = 0;
      const frames = createRetainedTavernFrames({window, retention: {hold(){return ()=>{}},mount(){return ()=>{}}}, createLifecycle(){
        starts++;
        const document = {token:'status',trustedCardMode:true,html:'<input value="initial">',ref(){}};
        return {snapshot(){return {height:100,visibleDocument:document}},start(){return ()=>{}},update(){}};
      }});
      const props = {sessionId:'a',persistent:true,panelId:'status',partIndex:0};
      let lease=frames.mount(props,document.querySelector('#sidebar'));
      window.moveStatus = target => {lease.detach();lease=frames.mount(props,document.querySelector(target));};
      window.moveBeforeCleanup = target => {const old=lease;lease=frames.mount(props,document.querySelector(target));old.detach();};
    ` })
    await page.frameLocator('#sidebar iframe').locator('input').fill('kept')
    await page.evaluate(() => { window.originalFrame = document.querySelector('iframe'); moveStatus('#body') })
    assert.equal(await page.frameLocator('#body iframe').locator('input').inputValue(), 'kept')
    await page.evaluate(() => moveBeforeCleanup('#sidebar'))
    assert.equal(await page.frameLocator('#sidebar iframe').locator('input').inputValue(), 'kept')
    assert.equal(await page.evaluate(() => starts === 1 && document.querySelector('iframe') === originalFrame), true)
    assert.equal(await page.locator('iframe').count(), 1)
  } finally { await browser.close() }
})
