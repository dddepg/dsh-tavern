import assert from 'node:assert/strict'
import test from 'node:test'

import { appendWritingSkillState } from '../tavern-plugin/lib/domain/skill-visibility.js'
import { Session } from './fixtures/dsh-session-host.mjs'

const ordinary = { id: 'ordinary', source: { kind: 'plugin' } }
const catalog = { id: 'catalog', source: { kind: 'skill-catalog' } }
const invocation = { id: 'invocation', source: { kind: 'skill-invocation' } }

test('卡片模式保留 DSH Skill 目录和用户显式调用', () => {
  const messages = [ordinary, catalog, invocation]
  assert.equal(appendWritingSkillState(messages, 'card'), messages)
})

test('恢复的游玩会话不重复通知；策略离开可见历史后重新声明当前开关', () => {
  const session = Session.create('skill-state')
  const options = { session, disabledWritingSkills: ['manual-writing'] }
  const pending = [ordinary, catalog, invocation]
  const first = appendWritingSkillState(pending, 'script', options)
  assert.deepEqual(first.slice(0, 3), pending)
  const notice = first.at(-1)
  session.append('user/message', notice, { surfaceOp: 'append' })
  const restored = Session.fromRestore(session.id, session.snapshotEvents(), session.header)
  assert.equal(appendWritingSkillState(pending, 'script', { ...options, session: restored }), pending)
  // A switch need not change the model-invocable catalog (manual-only skills).
  const enabled = appendWritingSkillState(pending, 'script', { session: restored })
  assert.deepEqual(enabled.at(-1).source.disabledWritingSkills, [])
  // Rewind/compaction can remove the policy from the visible Surface while
  // keeping its event in durable history. It must then be published again.
  restored.append('user/message', { id: 'summary', role: 'user', source: { kind: 'plugin', plugin: 'fixture' }, content: [{ type: 'text', text: '摘要' }] }, {
    sourceEventSeqs: [restored.surface.nodes[0]],
    surfaceOp: { op: 'replace', startSeq: restored.surface.nodes[0], endSeq: restored.surface.nodes[0] }
  })
  assert.deepEqual(appendWritingSkillState(pending, 'script', { ...options, session: restored }).at(-1).source.disabledWritingSkills, ['manual-writing'])
})
