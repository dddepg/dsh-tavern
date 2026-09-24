import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import vm from 'node:vm'
import test from 'node:test'
import { chromium } from 'playwright'
import { readTavernRuntimeAsset } from '../tavern-plugin/lib/domain/tavern-runtime-assets.js'

test('卡片捕获跨 iframe 的 MVU 异常后，诊断仍保留错误与原始堆栈', async t => {
  let descriptor
  vm.runInNewContext(await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { descriptor = value } } }, console
  })
  const client = descriptor.factory(() => ({}))
  // Deliberately fail in another realm: this verifies error capture, not the
  // cause of any particular user card's undefined.type exception.
  const frame = client.buildTavernFrameDocument({ token: 'cross-realm', content: `<button onclick="save()">保存</button><script>
    async function save() {
      try { await parent.Mvu.replaceMvuData(); }
      catch (error) { window.isLocalError = error instanceof Error; console.error('[RPG开局] 保存角色数据失败:', error); }
    }
  </script>` })
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/frame') { res.setHeader('content-type', 'text/html'); res.end(frame); return }
    const asset = await readTavernRuntimeAsset(path)
    if (asset) { res.setHeader('content-type', asset.mediaType); res.end(asset.body); return }
    res.setHeader('content-type', 'text/html')
    res.end(`<script>
      window.reports=[];
      window.Mvu={replaceMvuData:async function failingMvuSave(){const missing=undefined;return missing.type;}};
      addEventListener('message',event=>{if(event.data.type==='dsh-tavern-frame-runtime')reports.push(event.data.runtime);});
    </script><iframe src="/frame"></iframe>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:' + server.address().port)
  await page.frameLocator('iframe').getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => reports.some(report => report.console.some(entry => entry.level === 'error')))
  const error = await page.evaluate(() => reports.flatMap(report => report.console).find(entry => entry.level === 'error').args[1])
  assert.equal(await page.frames()[1].evaluate(() => isLocalError), false)
  assert.equal(error.name, 'TypeError')
  assert.match(error.message, /Cannot read properties of undefined.*type/)
  assert.match(error.stack, /failingMvuSave/)
})
