import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

async function loadPreviewBuilder() {
  const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  let descriptor
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { descriptor = value } } },
    console
  }
  vm.runInNewContext(source, sandbox)
  const client = descriptor.factory(function () { return {} })
  return client.buildOpeningPreviewDocument
}

const buildOpeningPreviewDocument = await loadPreviewBuilder()

test('纯文本开场白转义后保持换行，不会被当作 HTML', () => {
  const document = buildOpeningPreviewDocument('第一行\n1 < 2 & 3 > 2')

  assert.match(document, /class="dsh-tavern-greeting-text"/)
  assert.match(document, /第一行\n1 &lt; 2 &amp; 3 &gt; 2/)
})
