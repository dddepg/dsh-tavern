import assert from 'node:assert/strict'
import test from 'node:test'
import {Script} from 'node:vm'
import {JSDOM} from 'jsdom'
import {UpstreamTemplateRuntime} from './fixtures/upstream-template-runtime.mjs'
import {projectReplyHistory} from '../tavern-plugin/lib/domain/reply-presentation.js'

const runtime = await UpstreamTemplateRuntime.create()
test('template synchronization preserves a fenced card document after narrative protocol tags', async () => {
  const source = '<scene_time>\n朝\n</scene_time>\n<now_plot>正文</now_plot>'
  const document = '<!DOCTYPE html>\n<html>\n\n<body><noscript><p>fallback</p></noscript><p id="story">正文</p>\n<script>\nwindow.mounted=0;\n\n    (() => { window.mounted=1 })();\n</script>\n</body>\n</html>'
  const rules = [{enabled:true, placement:[2], markdownOnly:true, findRegex:'/<now_plot>([\\s\\S]*)<\\/now_plot>/g', replaceString:'```\n'+document+'\n```'}]
  const project = row => projectReplyHistory([{role:'assistant',turn:1,text:source,sourceText:source,tavernPluginData:row}], {regexScripts:rules}).projections
  const before = project()
  const result = await runtime.lifecycle({settings:{preload_worldinfo_enabled:false,raw_message_evaluation_enabled:false,render_enabled:true},regexScripts:rules,transcript:[{role:'assistant',content:source}]})
  assert.equal(result.first.chat[0].mes, source)
  const after = project(result.first.chat[0])
  const html = after.flatMap(p=>p.parts).filter(p=>p.kind==='html')
  assert.equal(html.length, 1)
  const dom = new JSDOM(html[0].content)
  try {
    for (const script of dom.window.document.querySelectorAll('script')) assert.doesNotThrow(()=>new Script(script.textContent))
  } finally { dom.window.close() }
  if (runtime.page) {
    await runtime.page.evaluate(content => {
      const frame = document.createElement('iframe'); frame.id = 'fenced-story'; frame.srcdoc = content; document.body.append(frame)
    }, html[0].content)
    await runtime.page.waitForFunction(() => document.querySelector('#fenced-story')?.contentWindow.mounted === 1)
    assert.equal(await runtime.page.locator('#fenced-story').evaluate(frame => frame.contentDocument.querySelector('#story').textContent), '正文')
    await runtime.page.locator('#fenced-story').evaluate(frame => frame.remove())
  }
  assert.deepEqual(after, before)
  assert.deepEqual(result.second.chat, result.first.chat)
})

for (const language of ['', 'html', 'htm', 'text']) {
  test(`template evaluation retains executable ${language || 'unlabelled'} HTML fences`, async () => {
    const source = '<scene_time>\n朝\n</scene_time>\n<now_plot>正文</now_plot>'
    const markup = '<html>\n\n<body><p>正文</p><script>\nwindow.value=0;\n\n    window.value=3;\n</script></body></html>'
    const rules = [{enabled:true,placement:[2],markdownOnly:true,findRegex:'/<now_plot>([\\s\\S]*)<\\/now_plot>/g',replaceString:'```'+language+'\n'+markup+'\n```'}]
    const result = await runtime.lifecycle({settings:{preload_worldinfo_enabled:false,raw_message_evaluation_enabled:false,render_enabled:true},regexScripts:rules,worldBookEntries:[{uid:1,enabled:false,constant:true,content:'@@render_before\n模板前缀=<%= 1 + 2 %>'}],transcript:[{role:'assistant',content:source}]})
    const view = projectReplyHistory([{role:'assistant',turn:1,text:source,sourceText:source,tavernPluginData:result.first.chat[0]}],{regexScripts:rules})
    const html = view.projections.flatMap(p=>p.parts).filter(p=>p.kind==='html').map(p=>p.content).join('')
    assert.match(html, /模板前缀/)
    assert.match(html, /window.value=3;/)
    assert.doesNotMatch(html, /<%|&lt;%/)
    const dom = new JSDOM(html)
    try { for (const script of dom.window.document.querySelectorAll('script')) assert.doesNotThrow(()=>new Script(script.textContent)) }
    finally { dom.window.close() }
    assert.equal(result.first.chat[0].mes,source)
  })
}
