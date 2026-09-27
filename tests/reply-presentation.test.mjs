import assert from 'node:assert/strict'
import test from 'node:test'

import { createReplyHistoryProjector, projectDisplayParts, projectReplyHistory, projectReplyLayers } from '../tavern-plugin/lib/domain/reply-presentation.js'

function script(name, findRegex, replaceString, flags = {}) {
  return {
    id: name,
    name,
    findRegex,
    replaceString,
    trimStrings: [],
    placement: [2],
    enabled: true,
    markdownOnly: flags.markdownOnly === true,
    promptOnly: flags.promptOnly === true,
    runOnEdit: false,
    minDepth: null,
    maxDepth: null
  }
}

test('没有正则时三层回复保持原文，HTML 只影响展示分类', () => {
  const source = '正文。\n\n<details><summary>状态</summary><!-- HP: 10 --></details>'
  const result = projectReplyLayers(source)

  assert.equal(result.sourceText, source)
  assert.equal(result.sessionText, source)
  assert.equal(result.displayText, source)
  assert.equal(result.displayMode, 'html')
  assert.deepEqual(result.displayParts.map(part => part.kind), ['markdown', 'html'])
  assert.equal(result.displayParts[0].text, '正文。\n\n')
  assert.match(result.displayParts[1].content, /<details><summary>状态<\/summary><!-- HP: 10 --><\/details>/)
  assert.deepEqual(result.applied, { session: [], display: [] })
})

test('历史投影会下发剥离 content 外壳后的纯文本开场白', () => {
  const source = '<content>\n第一段开场白。\n\n第二段开场白。\n</content>'
  const result = projectReplyHistory([
    { role: 'assistant', turn: 1, greeting: true, text: source, sourceText: source }
  ])

  assert.equal(result.projections.length, 1)
  assert.deepEqual(result.projections[0].parts, [
    { kind: 'markdown', text: '第一段开场白。\n\n第二段开场白。' }
  ])
})

test('markdownOnly 只改变展示投影并保持替换位置', () => {
  const source = '海风吹过。\n<status>体力 90</status>\n她继续向前。'
  const result = projectReplyLayers(source, {
    regexScripts: [script('状态展示', '/<status>(.*?)<\\/status>/s', '<aside>$1</aside>', { markdownOnly: true })],
    placement: 2
  })

  assert.equal(result.sourceText, source)
  assert.equal(result.sessionText, source)
  assert.equal(result.displayText, '海风吹过。\n<aside>体力 90</aside>\n她继续向前。')
  assert.equal(result.displayMode, 'html')
  assert.deepEqual(result.applied.session, [])
  assert.deepEqual(result.applied.display.map(item => item.name), ['状态展示'])
})

test('promptOnly 只改变 Session 投影', () => {
  const source = '<draft_notes>思考过程</draft_notes>\n正文。'
  const result = projectReplyLayers(source, {
    regexScripts: [script('移除思考', '/<draft_notes>[\\s\\S]*?<\\/draft_notes>\\s*/', '', { promptOnly: true })],
    placement: 2
  })

  assert.equal(result.sessionText, '正文。')
  assert.equal(result.displayText, source)
  assert.equal(result.displayMode, 'markdown')
})

test('混合内容拆开原生 Markdown、块级 HTML 与独立围栏 UI', () => {
  const source = '***索引页***\n\n**开局一·自定义**\n\n<details><summary>天道推演</summary></details>\n\n```html\n<body><script>$("body").load("/status.html")</script></body>\n```'
  const projected = projectDisplayParts(source)

  assert.deepEqual(projected.parts.map(part => part.kind), ['markdown', 'html', 'html'])
  assert.match(projected.parts[0].text, /\*\*\*索引页\*\*\*/)
  assert.match(projected.parts[0].text, /\*\*开局一·自定义\*\*/)
  assert.match(projected.parts[1].content, /<details><summary>天道推演<\/summary><\/details>/)
  assert.doesNotMatch(projected.parts[1].content, /<pre><code>/)
  assert.match(projected.parts[2].content, /body.*load/s)
})

test('损坏规则只产生目标诊断，后续规则继续执行', () => {
  const result = projectReplyLayers('进入校园', {
    regexScripts: [
      script('损坏规则', '/[/', '坏'),
      script('可用规则', '校园', '学院')
    ],
    placement: 2
  })

  assert.equal(result.sessionText, '进入学院')
  assert.equal(result.displayText, '进入学院')
  assert.match(result.warnings.join('\n'), /Session：损坏规则/)
  assert.match(result.warnings.join('\n'), /展示：损坏规则/)
})

test('历史投影从原文重算，关闭展示正则后恢复原始消息', () => {
  const rule = script('删除参考块', '/<Reference_Example>[\\s\\S]*?<\\/Reference_Example>/g', '', { markdownOnly: true })
  const source = '正文。\n\n<Reference_Example>辅助内容</Reference_Example>'
  const enabled = projectReplyHistory([
    { role: 'assistant', turn: 2, text: source, sourceText: source }
  ], { regexScripts: [rule], placement: 2 })

  assert.deepEqual(enabled.projections.map(({ turn, text, mode }) => ({ turn, text, mode })), [
    { turn: 2, text: '正文。\n\n', mode: 'markdown' }
  ])

  const disabled = projectReplyHistory([
    { role: 'assistant', turn: 2, text: '正文。', sourceText: source }
  ], { regexScripts: [], placement: 2 })

  assert.deepEqual(disabled.projections.map(({ turn, text, mode }) => ({ turn, text, mode })), [
    { turn: 2, text: source, mode: 'markdown' }
  ])
  assert.equal(disabled.presentation, null)
})

test('多 Swipe 的纯 Markdown 也生成展示投影，使旧候选可覆盖原生正文', () => {
  const result = projectReplyHistory([{
    role: 'assistant', turn: 3, text: '旧候选', sourceText: '旧候选', projectionText: '旧候选', swipeId: 0, swipes: ['旧候选', '新候选']
  }])
  assert.deepEqual(result.projections.map(function (item) { return { turn: item.turn, text: item.text, mode: item.mode } }), [
    { turn: 3, text: '旧候选', mode: 'markdown' }
  ])
})

test('代码示例中的 HTML 不作为活动页面执行', () => {
  for (const source of ['使用 `<button>按钮</button>` 标签。', '```js\nconst html = "<button>按钮</button>"\n```', '    <script>示例</script>']) {
    assert.deepEqual(projectDisplayParts(source).parts, [{ kind: 'markdown', text: source }])
  }
})

test('整页美化继续整体隔离，不把外来脚本和样式注入宿主', () => {
  for (const source of ['<html><head><style>body{color:red}</style></head><body>正文</body></html>']) {
    assert.deepEqual(projectDisplayParts(source).parts, [{ kind: 'html', content: source }])
  }
})

test('多行 UI 保持完整且不吞掉尾声，脚本中的伪标签不改变边界', () => {
  const html = '<div title="a > b">\n<div>标题</div>\n\n<script>const sample = "<div>";</script>\n<div>内容</div>\n</div>'
  const source = '前文\n' + html + '\n尾声'
  const parts = projectDisplayParts(source).parts
  assert.deepEqual(parts.map(part => part.kind), ['markdown', 'html', 'markdown'])
  assert.equal(parts[1].content.trim(), html)
  assert.equal(parts[2].text.trim(), '尾声')
})

test('正则生成的状态栏展开本局名称宏，保留原始记录及其他模板语法', () => {
  const source = '正文\n[状态]'
  const macros = { userName: '测试玩家', local: { count: 1 } }
  const options = { charName: '测试卡', macroState: macros, regexScripts: [script('状态栏', '\\[状态\\]', '<div>主角：{{user}}；角色：{{ CHAR }}；{{value}}；{{incvar::count}}</div>', { markdownOnly: true })] }
  const result = projectReplyLayers(source, options)
  assert.equal(result.sessionText, source)
  assert.equal(result.sourceText, source)
  assert.match(result.displayText, /主角：测试玩家；角色：测试卡/)
  assert.match(result.displayText, /\{\{value\}\}；\{\{incvar::count\}\}/)
  assert.equal(macros.local.count, 1)
  const history = projectReplyHistory([{ role: 'assistant', turn: 1, text: source, sourceText: source }], options)
  assert.match(history.projections[0].parts.find(p => p.kind === 'html').content, /主角：测试玩家/)
})

test('任意无属性正文协议标签保留 Markdown 段落，不依赖卡片标签白名单', () => {
  for (const tag of ['story', 'now_plot', 'dream_body', 'Narrative']) {
    const body = '\r\n第一段。\r\n\r\n**第二段。**\r\n'
    const source = `<${tag}>${body}</${tag}>`
    const result = projectReplyLayers(source)
    assert.equal(result.sourceText, source)
    assert.equal(result.sessionText, source)
    assert.ok(result.displayParts.every(part => part.kind === 'markdown'), tag)
    assert.equal(result.displayParts.map(part => part.text).join(''), body)
  }
  const mixed = projectDisplayParts('<story>第一段。\n\n**第二段。**\n<details><summary>状态</summary>正常</details>\n尾声。</story>').parts
  assert.deepEqual(mixed.map(part => part.kind), ['markdown', 'html', 'markdown'])
  for (const source of ['<story-panel>界面</story-panel>', '<panel class="ui">界面</panel>', '<div><story>界面</story></div>', '```html\n<story>界面</story>\n```']) {
    assert.equal(projectDisplayParts(source).parts[0].kind, 'html')
  }
})

test('正则与身份参数变化使缓存失效，返回结果修改不污染缓存', () => {
  const project = createReplyHistoryProjector()
  const messages = [{ role: 'assistant', turn: 1, text: '{{user}}遇见{{char}}' }]
  const options = { charName: '甲', macroState: { userName: '乙' }, regexScripts: [] }
  const first = project(messages, options)
  const expected = structuredClone(first)
  first.projections[0].parts[0].text = '污染'
  assert.deepEqual(project(messages, options), expected)
  options.charName = '丙'
  assert.match(project(messages, options).projections[0].text, /丙/)
  options.macroState.userName = '丁'
  assert.match(project(messages, options).projections[0].text, /丁/)
  options.regexScripts.push(script('replace', '/遇见/g', '看到'))
  assert.match(project(messages, options).projections[0].text, /看到/)
  assert.equal(project.cacheStats().misses, 4)
})

test('退化的 template_display（正文包 p、残留 mvu-status）回退到普通投影', () => {
  const source = '开场正文\n<mvu-status/>'
  const html = '<p>开场正文</p>\n<mvu-status></mvu-status>'
  const message = {
    role: 'assistant', turn: 1, greeting: true,
    text: '开场正文', sourceText: source,
    tavernPluginData: { template_display: { source, swipe: 0, html, parts: [{ kind: 'html', content: html }] } }
  }
  const rule = {
    id: 'mvu-status-view', placement: [2], markdownOnly: true,
    findRegex: '<mvu-status/>', replaceString: '```html\n<script>newStatus()</script>\n```'
  }
  const result = projectReplyHistory([message], { regexScripts: [rule] })
  assert.deepEqual(result.projections[0].parts.map(part => part.kind), ['markdown', 'html'])
  assert.match(result.projections[0].parts[0].text, /开场正文/)
  assert.match(result.projections[0].parts[1].content, /newStatus/)
})

test('内容被替换的真实 EJS 展示仍走 template_display', () => {
  const source = '原始正文'
  const html = '<p>已渲染后缀</p>'
  const message = {
    role: 'assistant', turn: 1, text: source, sourceText: source,
    tavernPluginData: { template_display: { source, swipe: 0, html, parts: [{ kind: 'html', content: html }] } }
  }
  assert.equal(projectReplyHistory([message]).projections[0].text, html)
})

for (const block of [
  '<UpdateVariable>secret</UpdateVariable>',
  '<INITVAR>secret\r\nsecond</INITVAR>',
  '<initvar format="yaml">secret</initvar>',
  '<UpdateVariable><initvar>secret</initvar></UpdateVariable>',
  '<initvar><initvar>secret</initvar>secret</initvar>'
]) test('变量控制块不作为正文展示：' + block.split('>')[0], () => {
  const source = '之前\r\n' + block + '\r\n之后'
  const result = projectReplyLayers(source)
  assert.equal(result.sourceText, source)
  assert.equal(result.sessionText, source)
  assert.deepEqual(result.displayParts, [{ kind: 'markdown', text: '之前\r\n' }, { kind: 'markdown', text: '\r\n之后' }])
})

test('未闭合变量块隐藏至结尾，自闭合标签不吞掉后文', () => {
  assert.doesNotMatch(JSON.stringify(projectDisplayParts('正文\n<initvar>secret').parts), /secret/)
  assert.match(JSON.stringify(projectDisplayParts('正文<initvar/>后文').parts), /后文/)
})

test('变量标签的代码示例与作者 HTML 脚本保持原样', () => {
  for (const source of ['`<initvar>example</initvar>`', '```text\n<initvar>example</initvar>\n```', '<div><script>const example = "<initvar>example</initvar>";</script></div>']) {
    const result = projectDisplayParts(source)
    assert.match(result.parts.map(part => part.text || part.content).join(''), /<initvar>example<\/initvar>/)
  }
})

test('普通正文无额外展示投影时不复制缓存，编辑后仍正确投影', () => {
  const project = createReplyHistoryProjector()
  const messages=Array.from({length:700},(_,i)=>({role:'assistant',turn:i+1,text:'普通正文'+i}))
  assert.equal(project(messages).projections.length,0)
  project(messages)
  assert.equal(project.cacheStats().copies,0)
  messages[350].bodyEdit=true
  assert.equal(project(messages).projections[0].turn,351)
  assert.equal(project.cacheStats().copies,1)
})
