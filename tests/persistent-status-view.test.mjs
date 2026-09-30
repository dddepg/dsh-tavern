import assert from 'node:assert/strict'
import test from 'node:test'

import { projectPersistentStatusView } from '../tavern-plugin/lib/domain/persistent-status-view.js'

function projection(turn, parts) {
  return { version: 2, turn, mode: 'html', text: '', parts, warnings: [] }
}

test('声明状态栏的卡保留开局页，正文推进后使用声明模板而非 MVU 开局页', () => {
  const opening = '<script>loadCustomStart()</script>'
  const status = '<script>loadRealStatus()</script>'
  const regexScripts = [{ enabled: true, placement: [2], markdownOnly: true,
    findRegex: '<StatusPlaceHolderImpl/>', replaceString: '```html\n' + status + '\n```', maxDepth: 2 }]
  const messages = [{ role: 'assistant', turn: 1, displayRuntime: { frames: [{ partIndex: 0, mvuViewUsed: true }] } }]
  const projections = [projection(1, [{ kind: 'html', content: opening }])]
  const initial = projectPersistentStatusView(messages, projections, { regexScripts })
  assert.equal(initial.statusView, null)
  assert.deepEqual(initial.projections, projections)
  const advanced = projectPersistentStatusView([...messages, { role: 'assistant', turn: 6, text: '抵达庄园' }], projections, { regexScripts })
  assert.match(advanced.statusView.content, /loadRealStatus/)
  assert.equal(advanced.statusView.targetTurn, 6)
  assert.deepEqual(advanced.projections, projections)
  assert.equal(projectPersistentStatusView([...messages, { role: 'assistant', turn: 6 }], [], { regexScripts }).statusView.targetTurn, 6)
})

test('状态模板复用编译，但旧消息来源、最新轮次、规则和身份变化仍生效', async () => {
  const {createPersistentStatusProjector} = await import('../tavern-plugin/lib/domain/persistent-status-view.js')
  const project = createPersistentStatusProjector()
  const rule = { findRegex: '<StatusPlaceHolderImpl/>', replaceString: '<html><script>show("{{user}}")</script></html>', placement: [2], markdownOnly: true }
  const options = {regexScripts:[rule], macroState:{userName:'甲'}}
  const messages = [{role:'assistant',turn:3}]
  const first = project(messages, [], options)
  assert.match(first.statusView.content, /甲/)
  first.statusView.content='污染'
  const second = project([{role:'assistant',turn:4}], [], options)
  assert.equal(project.cacheStats().misses, 1)
  assert.equal(project.cacheStats().hits, 1)
  assert.equal(second.statusView.targetTurn, 4)
  assert.doesNotMatch(second.statusView.content, /污染/)
  const origin = project(messages, [projection(2,[{kind:'html',content:second.statusView.content}])], options)
  assert.equal(origin.statusView.sourceTurn, 2)
  options.macroState.userName='乙'
  assert.match(project(messages, [], options).statusView.content, /乙/)
  rule.replaceString='<html><script>changed()</script></html>'
  assert.match(project(messages, [], options).statusView.content, /changed/)
  assert.equal(project.cacheStats().misses, 3)
  rule.disabled=true
  assert.equal(project(messages, [], options).statusView,null)
  const uncached=createPersistentStatusProjector({maxCacheBytes:1})
  rule.disabled=false
  assert.deepEqual(uncached(messages, [], options), project(messages, [], options))
  assert.equal(uncached.cacheStats().entries,0)
})

test('旧数值来源只在原文唯一声明时迁移，未知 HTML 不被误删', () => {
  const rule = { id: 'mvu-status-view', placement: [2], markdownOnly: true, findRegex: '<mvu-status/>', replaceString: '<script>newStatus()</script>' }
  const old = { kind: 'html', content: '<script>oldStatus()</script>', statusRule: 7 }
  const unrelated = { kind: 'html', content: '<script>opening()</script>' }
  const messages = [{ role: 'assistant', turn: 1, text: '开场<mvu-status/>' }]
  const result = projectPersistentStatusView(messages, [projection(1, [old, unrelated])], { regexScripts: [rule] })
  assert.match(result.statusView.content, /newStatus/)
  assert.deepEqual(result.projections[0].parts, [unrelated])
  const ambiguous = projectPersistentStatusView(messages, [projection(1, [old, unrelated])], { regexScripts: [rule, { ...rule, id: 'another', replaceString: '<script>another()</script>' }] })
  assert.equal(ambiguous.statusViews.length, 0)
  assert.deepEqual(ambiguous.projections[0].parts, [old, unrelated])
})

test('text 围栏的 body 根状态栏仍提升为右侧面板', () => {
  const replaceString = "```text\n<body>\n<script>\n$('body').load('/api/dsh-tavern/remote-assets/hash/bottom-status-bar.html_V_1?host=1')\n</script>\n</body>\n```"
  const rule = { id: 'adf31d55-5ab4-4be7-a720-c0c96a5e1ed4', name: '状态栏', enabled: true, placement: [2], markdownOnly: true,
    findRegex: '<StatusPlaceHolderImpl/>', replaceString }
  const result = projectPersistentStatusView([{ role: 'assistant', turn: 2, text: '正文' }], [], { regexScripts: [rule] })
  assert.equal(result.statusViews.length, 1)
  assert.match(result.statusView.content, /bottom-status-bar\.html/)
  assert.match(result.statusView.content, /<body[\s>]/i)
  assert.equal(projectPersistentStatusView([{ role: 'assistant', turn: 2 }], [], {
    regexScripts: [{ ...rule, replaceString: '```text\n<body><p>无脚本</p></body>\n```' }]
  }).statusView, null)
})
