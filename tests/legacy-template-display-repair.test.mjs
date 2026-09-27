import test from 'node:test'
import assert from 'node:assert/strict'
import {marked} from 'marked'
import {JSDOM} from 'jsdom'
import {Script} from 'node:vm'
import {projectReplyHistory} from '../tavern-plugin/lib/domain/reply-presentation.js'

const source='<scene_time>\n朝\n</scene_time>\n<now_plot>正文</now_plot>'
const markup='<html>\n\n<body><p>正文</p>\n<script>\nwindow.value=0;\n\n    (()=>{window.value=3})();\n</script></body></html>'
const rule={enabled:true,placement:[2],markdownOnly:true,findRegex:'/<now_plot>([\\s\\S]*)<\\/now_plot>/g',replaceString:markup}
const broken=marked.parse(source.replace(/<now_plot>[\s\S]*<\/now_plot>/,markup))
const snapshot={source,swipe:0,html:broken,parts:[{kind:'html',content:broken}]}
const project=(display,rules=[rule])=>projectReplyHistory([{role:'assistant',turn:1,text:source,sourceText:source,tavernPluginData:{template_display:display}}],{regexScripts:rules}).projections[0]
function scriptOf(html){const dom=new JSDOM(html);try{return dom.window.document.querySelector('script').textContent}finally{dom.window.close()}}

test('repairs provable legacy Markdown damage without replaying historical templates or mutating the snapshot',()=>{
  assert.throws(()=>new Script(scriptOf(broken)))
  const original=structuredClone(snapshot)
  const display={...snapshot,html:'<p>历史模板结果=42</p>'+broken,parts:[{kind:'html',content:'<p>历史模板结果=42</p>'+broken}]}
  const saved=structuredClone(display)
  const view=project(display)
  assert.doesNotThrow(()=>new Script(scriptOf(view.parts[0].content)))
  assert.match(view.parts[0].content,/历史模板结果=42/)
  assert.match(view.text,/历史模板结果=42/)
  assert.deepEqual(snapshot,original)
  assert.deepEqual(display,saved)
  const window={}
  new Script(scriptOf(view.parts[0].content)).runInNewContext({window})
  assert.equal(window.value,3)
  assert.match(display.html,/<pre><code>/)
  assert.deepEqual(project(display),view)
})
test('does not replace historical scripts with a different current card implementation',()=>{
  const view=project(snapshot,[{...rule,replaceString:markup.replace('window.value=3','window.value=4')}])
  assert.equal(view.parts[0].content,broken)
})
test('does not infer historical EJS values from current variables',()=>{
  const view=project(snapshot,[{...rule,replaceString:markup.replace('window.value=3','window.value=<%- getvar("value") %>')}])
  assert.equal(view.parts[0].content,broken)
})

test('recovers matching style damage without replacing surrounding historical markup',()=>{
  const rich='<html>\n\n<body><style>\nbody {color:red}\n\n    p {font-size:20px}\n</style><p>正文</p></body></html>'
  const html=marked.parse(source.replace(/<now_plot>[\s\S]*<\/now_plot>/,rich))
  const display={...snapshot,html,parts:[{kind:'html',content:html}]}
  const view=project(display,[{...rule,replaceString:rich}])
  const dom=new JSDOM(view.parts[0].content)
  try {
    assert.doesNotMatch(dom.window.document.querySelector('style').textContent,/<pre>|<code>/)
    assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector('p')).fontSize,'20px')
  } finally {dom.window.close()}
  assert.equal(display.html,html)
})
