import assert from 'node:assert/strict'
import test from 'node:test'

import { incompleteReplyTail, streamFinishKind, truncatedForegroundReply } from '../tavern-plugin/lib/domain/reply-completeness.js'

test('只有停在句末标点的正文才算写完', () => {
  for (const text of ['剧情到此为止。', '“我明白了。”', '真的吗？', '他停住了……', '好耶♪', 'Hello there.', '**加粗**', '话说到一半——', '把标签写完</p>', '她笑了 😊', '结束（完）']) {
    assert.equal(incompleteReplyTail(text), false, text)
  }
  for (const text of ['当着自己的面，一个不到', '动作极其自然地启开温润的唇缝', '随手把沾了蜜瓜甜汁的右手悬', '他说：“好的', '后面还有，', '未完待续：', '她开口道：“', '（', '半个句子 12']) {
    assert.equal(incompleteReplyTail(text), true, text)
  }
  assert.equal(incompleteReplyTail(''), false)
  assert.equal(incompleteReplyTail('   \n  '), false)
  assert.equal(incompleteReplyTail(undefined), false)
})

test('结束原因取自模型流末尾的 finish 分片', () => {
  const stream = [
    { type: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { type: 'text-chunks', time0: 1, index: 0, dt: [10], texts: ['半句'] },
    { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'max-tokens' } } }
  ]
  assert.equal(streamFinishKind(stream), 'max-tokens')
  assert.equal(streamFinishKind([{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }]), 'stop')
  // 结尾没有 finish 分片时不猜原因，交给 DSH 自己的回合判定。
  assert.equal(streamFinishKind([{ type: 'chunk', chunk: { type: 'text-delta' } }]), '')
  assert.equal(streamFinishKind(undefined), '')
})

test('达到 token 上限与停在句中的正常结束都判为截断，不提交本轮', () => {
  const limited = truncatedForegroundReply({ text: '半个句子。', finishKind: 'max-tokens' })
  assert.equal(limited.code, 'truncated-response')
  assert.match(limited.message, /token 上限/)
  const cut = truncatedForegroundReply({ text: '当着自己的面，一个不到', finishKind: 'stop' })
  assert.equal(cut.code, 'truncated-response')
  assert.match(cut.message, /正文中途中断/)
  assert.equal(truncatedForegroundReply({ text: '这一轮写完了。', finishKind: 'stop' }), null)
  // 工具调用步骤与未知结束原因各有自己的 DSH 处理，不能在这里判失败。
  assert.equal(truncatedForegroundReply({ text: '半句话', finishKind: 'tool-calls' }), null)
  assert.equal(truncatedForegroundReply({ text: '半句话' }), null)
  // 空正文走既有的空回复失败路径，不在这里重复判定。
  assert.equal(truncatedForegroundReply({ text: '   ', finishKind: 'max-tokens' }), null)
  assert.equal(truncatedForegroundReply({}), null)
})
