import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import assert from 'node:assert/strict'
import test from 'node:test'

import { ensureSessionSeedTrajectory, sessionSeedTrajectoryMessages } from '../tavern-plugin/lib/domain/session-seed-trajectory.js'
import { Session } from './fixtures/dsh-session-host.mjs'
import { ensureCardWorkspaceMessage } from '../tavern-plugin/lib/domain/card-workspace-message.js'

test('工作区说明作为种子之后的 user 快照持久化，恢复和分叉不重复注入', async () => {
  let session = Session.create('workspace-injection')
  await ensureSessionSeedTrajectory(session, 'story')
  ensureCardWorkspaceMessage(session, '【工作区】原始路径')
  session = Session.create('forked-workspace', sessionEvents(session), Session.create('forked-workspace').header)
  ensureCardWorkspaceMessage(session, '不重复添加')
  const messages = session.deriveMessages()
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user', 'user'])
  assert.equal(messages.at(-1).content[0].text, '【工作区】原始路径')
  assert.equal(messages.at(-1).source.form, 'snapshot')
})

test('卡片种子使用原生轨迹，部分写入恢复和重载不会重复', async () => {
  let session = Session.create('card-seed')
  const first = sessionSeedTrajectoryMessages(session.id, 'card')[0]
  session.append(first.type, first.data, first.intent)
  await ensureSessionSeedTrajectory(session, 'card')
  session = Session.create(session.id, session.events, session.header)
  await ensureSessionSeedTrajectory(session, 'card')
  const messages = session.deriveMessages()
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user'])
  assert.match(messages[0].content[0].text, /待编辑素材/)
  assert.doesNotMatch(messages.map(m => m.content[0].text).join('\n'), /只输出小说正文|从人物卡给定的开场继续/)
})
