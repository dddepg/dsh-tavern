import { readFile } from 'node:fs/promises'
import { browserReactScript } from './browser-react.mjs'
import { chromium } from 'playwright'

// Exercise the public plugin registration and real React effects/events. Only
// the DSH host and HTTP boundary are fixtures; no component source extraction.
export async function openTavernSettings(t, { settings, respond } = {}) {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const calls = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://tavern.test/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)
    if (!route.request().url().includes('/api/')) return route.fulfill({ contentType: 'text/html', body: '<main></main>' })
    const args = route.request().postDataJSON()
    calls.push({ method, args })
    let result = await respond?.(method, args)
    if (result === undefined) {
      if (method === 'getTavernSettings') result = { settings: {}, releaseCapabilities: { sceneImages: true } }
      else if (method === 'getSceneImageSettings') result = { settings }
      else if (method === 'getCandidatePreferences') result = { candidateDismissMode: 'after-fill' }
      else if (method === 'confirmSessionPatch') result = {}
      else if (method === 'getDefaultWritingSkills') result = { skills: [] }
      else throw new Error('Unexpected settings request: ' + method)
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, ...result }) })
  })
  await page.goto('http://tavern.test/')
  let script = await browserReactScript()
  script += `window.__ModuleLoader__={load(definition){window.client=definition.factory(name=>name==='react'?modules.react:{});}};`
  await page.addScriptTag({ content: script })
  const source = await readFile(new URL('../../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  await page.addScriptTag({ content: source })
  await page.evaluate(() => {
    let Settings
    window.client.apply({
      inject() { return { dispose() {} } },
      get() {}, tavernSessionSignals: { subscribe() { return () => {} } },
      effect(run, label) { if (label === 'dsh-tavern: settings section') return run() },
      slots: { inject(_name, run) { return run() }, register(_spec, Component) { Settings = Component } }
    })
    modules['react-dom/client'].createRoot(document.querySelector('main')).render(modules.react.createElement(Settings))
  })
  const form = page.locator('.dsh-tavern-settings-group').filter({ has: page.getByRole('heading', { name: '生图 API 配置（全局共用）' }) })
  await form.getByLabel(/^提供商/).waitFor().catch(async error => { throw Error(error.message + '\n' + JSON.stringify(errors) + '\n' + await page.locator('body').innerText()) })
  t.after(() => { if (errors.length) throw Error(errors.join('\n')) })
  return { page, form, calls }
}
