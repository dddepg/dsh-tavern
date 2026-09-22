import test from 'node:test'
import assert from 'node:assert/strict'
import {projectReplyHistory} from '../tavern-plugin/lib/domain/reply-presentation.js'
function project(html,parts){const source='正文\n<initvar>{"secret":"INITIAL_VALUE"}</initvar>';const display={source,swipe:0,html,...(parts?{parts}:{})};const message={role:'assistant',turn:1,text:source,sourceText:source,tavernPluginData:{template_display:display}};const before=structuredClone(message);const result=projectReplyHistory([message]);assert.deepEqual(message,before);return result.projections[0]}
test('已有模板 HTML 快照隐藏整个初始化块，保留源数据与正文',()=>{
 const result=project('<p>正文</p><initvar>{"secret":"INITIAL_VALUE"}</initvar><p>后文</p>')
 assert.equal(result.text,'<p>正文</p><p>后文</p>');assert.equal(result.parts[0].content,result.text)
})
test('模板分块隐藏初始化和更新协议，保留面板身份和代码示例',()=>{
 const prose='<p>正文</p><INITVAR>INITIAL_VALUE</INITVAR><UpdateVariable>PATCH_VALUE</UpdateVariable>'
 const panel='<div>面板</div><script>const example="<initvar>keep</initvar>";</script>'
 const example='<pre><code><initvar>example</initvar></code></pre>'
 const result=project(prose+panel+example,[{kind:'html',content:prose},{kind:'html',content:panel,statusKey:'panel-1'},{kind:'html',content:example}])
 assert.equal(result.parts[0].content,'<p>正文</p>');assert.equal(result.parts[1].content,panel);assert.equal(result.parts[1].statusKey,'panel-1');assert.equal(result.parts[2].content,example)
 assert.doesNotMatch(result.text,/INITIAL_VALUE|PATCH_VALUE/)
})
