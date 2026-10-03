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

test('整页美化继续整体隔离，不把外来脚本和样式注入宿主', () => {
  for (const source of ['<html><head><style>body{color:red}</style></head><body>正文</body></html>']) {
    assert.deepEqual(projectDisplayParts(source).parts, [{ kind: 'html', content: source }])
  }
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
