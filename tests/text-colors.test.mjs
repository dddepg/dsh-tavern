import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { helperClient as client } from './fixtures/helper-host-harness.mjs'

test('按完整引号配对，不推断心理活动、不跨换行配对', () => {
  const text = '旁白。“你好” *心想* 「再见」 『等一下』 "okay" «oui» ＂好＂。'
  assert.deepEqual(Array.from(client.findTavernQuoteRanges(text), ([a,b]) => text.slice(a,b)), ['“你好”','「再见」','『等一下』','"okay"','«oui»','＂好＂'])
  assert.equal(client.findTavernQuoteRanges('“流式未完成').length, 0)
  assert.equal(client.findTavernQuoteRanges('“第一段\n第二段”').length, 0)
})
test('不支持高亮 API 的浏览器保持原正文，可安全开关与清理', () => {
  const colors = client.installTavernTextColors({ ownerDocument: { defaultView: {} } }, {}, client.findTavernQuoteRanges)
  assert.doesNotThrow(() => { colors.setEnabled(false); colors.dispose() })
})
test('HTML 正文携带独立分色运行时，持久侧栏不注入', () => {
  const html = client.buildTavernFrameDocument({ content: '<p>“你好”</p>', token: 'test' })
  assert.match(html, /<script data-dsh-tavern-text-colors>/)
  assert.match(html, /event.source===parent/)
  const sidebar = client.buildTavernFrameDocument({ content: '<button>“发送”</button>', token: 'side', persistent: true })
  assert.doesNotMatch(sidebar, /<script data-dsh-tavern-text-colors>/)
})

test('分色包装原样交给宿主 Markdown，既不插入 HTML，也不改变流式参数', async () => {
  let descriptor
  const React = { useRef: () => ({ current: null }), useEffect() {}, createElement: (type, props, ...children) => ({ type, props, children }) }
  const MarkdownText = Symbol('native Markdown')
  vm.runInNewContext(await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: value => { descriptor = value } } }, console })
  const local = descriptor.factory(name => name === 'react' ? React : { MarkdownText })
  const props = { text: '旁白。“你好” **强调** *想法* `"代码"`', streaming: true, labels: { footnotes: '脚注' } }
  const rendered = local.TavernColoredMarkdown(props)
  assert.equal(rendered.children[0].type, MarkdownText)
  assert.equal(rendered.children[0].props, props)
  assert.equal(rendered.children[0].props.text, props.text)
})

test('正文读取主题强调色，忽略旧的分色开关和自选颜色', async () => {
  let removed = false
  const host = { document: {
    createElement: () => ({ style: {}, remove() { removed = true } }),
    body: { appendChild() {} },
  }, getComputedStyle: () => ({ color: 'rgb(0, 113, 227)' }),
  localStorage: { getItem() { throw Error('legacy preferences must not be read') } } }
  const context = vm.createContext({})
  vm.runInContext(await readFile(new URL('../tavern-plugin/src/client/text-colors.js', import.meta.url), 'utf8'), context)
  assert.equal(context.tavernTextColorsEnabled(host), true)
  const colors = context.tavernTextColorOverrides(host)
  assert.equal(colors.quote, 'rgb(0, 113, 227)')
  assert.equal(colors.em, colors.quote)
  assert.equal(removed, true)
})
