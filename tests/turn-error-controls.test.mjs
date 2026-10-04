import assert from 'node:assert/strict'
import test from 'node:test'
import { helperClient as client } from './fixtures/helper-host-harness.mjs'

class Element {
  constructor(text = '') { this.textContent = text; this.hidden = false; this.style = { display: '' }; this.children = []; this.attrs = {} }
  append(...children) { this.children.push(...children) }
  remove() { this.removed = true }
  getAttribute(key) { return this.attrs[key] || null }
  insertAdjacentElement(position, element) { assert.equal(position, 'afterend'); this.panel = element }
}
function setup(text, storage = new Map(), sessionId = 'a', options = {}) {
  const row = new Element(text); row.attrs['data-chat-turn'] = '8'
  const root = { ownerDocument: { createElement() { return new Element() } }, querySelectorAll() { return [row] } }
  const controls = client.createTurnErrorControls(root, { ...options, sessionId, storage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } })
  return { row, root, controls }
}
test('长错误默认收起，可展开、单独隐藏和恢复，原始文本不变', () => {
  const text = '400: message content cannot be empty ' + 'PRIVATE'.repeat(200)
  const { row, controls } = setup(text)
  controls.apply()
  assert.equal(row.style.display, 'none')
  assert.match(row.panel.children[0].textContent, /消息内容不能为空/)
  row.panel.children[1].onclick()
  assert.equal(row.style.display, '')
  row.panel.children[2].onclick()
  assert.equal(row.style.display, 'none')
  assert.equal(row.panel.children[2].textContent, '恢复错误提示')
  row.panel.children[2].onclick()
  assert.equal(row.style.display, '')
  assert.equal(row.textContent, text)
  controls.dispose()
  assert.equal(row.style.display, '')
  assert.equal(row.panel.removed, true)
})

test('已有回退投影的隐藏状态不被恢复按钮撤销', () => {
  const { row, controls } = setup('failure')
  row.hidden = true; row.style.display = 'none'; controls.apply()
  assert.equal(row.panel, undefined)
  row.hidden = false; row.style.display = ''; controls.apply()
  assert.equal(row.style.display, '')
  row.hidden = true; row.style.display = 'none'; controls.apply()
  assert.equal(row.panel.hidden, true)
})

test('同一会话容器重复挂载只保留一个错误控件，旧实例不能重新插入', () => {
  const first = setup('failure')
  first.controls.apply()
  const oldPanel = first.row.panel
  const next = client.createTurnErrorControls(first.root, { sessionId: 'a', hiddenTurns: [8], storage: { getItem() {}, setItem() {} } })
  next.apply()
  const newPanel = first.row.panel
  assert.equal(oldPanel.removed, true)
  assert.notEqual(newPanel, oldPanel)
  first.controls.apply()
  first.controls.dispose()
  assert.equal(first.row.panel, newPanel)
  assert.equal(newPanel.removed, undefined)
  assert.equal(first.row.style.display, 'none')
  next.dispose()
  assert.equal(first.row.style.display, '')
})

test('失败尾部错误行提供一键重放，按轮次匹配而不是所有错误行', async () => {
  const turns = []
  const tail = setup('Provider finish_reason: content_filter', new Map(), 'a', {
    replayTurn: 8, onReplay: async turn => { turns.push(turn) }
  })
  tail.controls.apply()
  const replay = tail.row.panel.children[3]
  assert.equal(replay.textContent, '重新生成本轮')
  assert.match(replay.title, /原样重发本轮请求/)
  assert.equal(replay.hidden, false)
  await replay.onclick()
  assert.deepEqual(turns, [8])

  const other = setup('Provider finish_reason: content_filter', new Map(), 'a', {
    replayTurn: 7, onReplay: async () => { throw new Error('不应被调用') }
  })
  other.controls.apply()
  assert.equal(other.row.panel.children[3].hidden, true, '只有仍拥有尾部的失败回合提供重放')

  const missing = setup('Provider finish_reason: content_filter')
  missing.controls.apply()
  assert.equal(missing.row.panel.children[3].hidden, true, '没有重放回调时不显示按钮')
})

test('服务商内容审核拦截时说明不是酒馆故障，原始错误保留', () => {
  const text = 'Provider finish_reason: content_filter'
  const { row, controls } = setup(text)
  controls.apply()
  assert.match(row.panel.children[0].textContent, /内容审核拦截了这一轮回复，这不是酒馆故障/)
  assert.equal(row.style.display, '', '短错误不收起，原文仍可见')
  assert.equal(row.textContent, text)
})

test('只把开头就是拒绝语的回复标为模型拒绝，剧情里的类似台词不受影响', () => {
  const notice = client.tavernModelRefusalNotice
  assert.match(notice('我无法协助生成涉及未成年角色的露骨性描写内容。\n\n如果您希望继续推进后续的剧情发展……'), /模型拒绝继续这段剧情/)
  assert.match(notice("I'm sorry, but I can't help with generating explicit content."), /模型拒绝/)
  for (const story of ['我不能就这样离开她。\n她转过身去。', '“抱歉，我无法帮助你。”她低声说。', '房间里很安静。\n我无法协助生成这类内容。', ''])
    assert.equal(notice(story), '', story)
  assert.equal(client.tavernProviderRefusalNotice('request failed with status 400'), '')
})

test('内容审核拦截的失败尾部：主推撤回输入，重放降级；连续拦截改为主推回退上一轮', async () => {
  const calls = []
  const options = { replayTurn: 8, onReplay: () => calls.push('replay'), onWithdraw: turn => calls.push('withdraw:' + turn), onRewind: turn => calls.push('rewind:' + turn), canRewind: true }
  const once = setup('Provider finish_reason: content_filter', new Map(), 'a', { ...options, filteredStreak: 1 })
  once.controls.apply()
  const [label, , , replay, withdraw, rewind] = once.row.panel.children
  assert.match(label.textContent, /原样重新生成通常还会被拦截/)
  assert.match(replay.className, /is-secondary/)
  assert.equal(withdraw.hidden, false); assert.match(withdraw.className, /is-primary/)
  assert.equal(rewind.hidden, false); assert.doesNotMatch(rewind.className, /is-primary/)
  await withdraw.onclick(); await rewind.onclick()
  assert.deepEqual(calls, ['withdraw:8', 'rewind:8'])
  const repeated = setup('Provider finish_reason: content_filter', new Map(), 'b', { ...options, filteredStreak: 2 })
  repeated.controls.apply()
  assert.match(repeated.row.panel.children[0].textContent, /已连续 2 次.*建议回退上一轮/)
  assert.match(repeated.row.panel.children[5].className, /is-primary/)
  assert.doesNotMatch(repeated.row.panel.children[4].className, /is-primary/)
  const plain = setup('request failed with status 500', new Map(), 'c', options)
  plain.controls.apply()
  assert.equal(plain.row.panel.children[4].hidden, true, '普通故障仍只提供重放')
  assert.equal(plain.row.panel.children[5].hidden, true)
})

test('已清除或已被后续轮次取代的失败默认收起，可临时查看', () => {
  const { row, controls } = setup('Provider finish_reason: content_filter', new Map(), 'a', { staleTurns: [8] })
  controls.apply()
  assert.equal(row.style.display, 'none')
  assert.match(row.panel.children[0].textContent, /失败已清除/)
  row.panel.children[2].onclick()
  assert.equal(row.style.display, '')
  assert.equal(row.panel.children[2].textContent, '隐藏此错误')
})
