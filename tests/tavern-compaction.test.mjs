import assert from 'node:assert/strict'
import test from 'node:test'

import { createTavernCompactionCoordinator } from '../tavern-plugin/lib/domain/tavern-compaction.js'

function harness(options = {}) {
  let chat = structuredClone(options.chat || {
    id: 'chat-1',
    mode: 'story',
    sessionId: 'foreground-1',
    timeline: {
      branchId: 'branch-1', revision: 7,
      participants: {
        background: {
          role: 'background', lifetime: 'chat', sessionId: 'background-1',
          branchId: 'branch-1', syncedRevision: 7, boundary: 42, status: 'current'
        }
      }
    }
  })
  const coordinator = createTavernCompactionCoordinator({
    id: () => 'compaction-1',
    now: () => 1000,
    activity: () => options.activity || { phase: 'idle', busy: false, role: '' },
    store: {
      async chatForSession(sessionId) { return sessionId === chat.sessionId ? structuredClone(chat) : undefined },
      async updateChat(chatId, mutation) {
        assert.equal(chatId, chat.id)
        const draft = structuredClone(chat)
        chat = await mutation(draft)
        return structuredClone(chat)
      }
    }
  })
  return { coordinator, read: () => structuredClone(chat) }
}

test('后台压缩目标只能由当前前台压缩计划解析', async function () {
  const app = harness()
  const plan = await app.coordinator.prepare('foreground-1')

  await assert.rejects(
    () => app.coordinator.backgroundTarget('foreground-1', 'wrong-operation'),
    function (error) { return error && error.code === 'COMPACTION_PLAN_STALE' }
  )
  assert.equal(await app.coordinator.backgroundTarget('foreground-1', plan.operationId), 'background-1')
})

test('单边失败返回部分成功，没有后台 Session 时只要求前台成功', async function () {
  const partial = harness()
  const partialPlan = await partial.coordinator.prepare('foreground-1')
  const partialResult = await partial.coordinator.complete('foreground-1', {
    operationId: partialPlan.operationId,
    foreground: { status: 'succeeded', message: 'ok' },
    background: { status: 'failed', message: 'busy' }
  })
  assert.equal(partialResult.status, 'partial')
  assert.equal(partial.read().timeline.participants.background.requiresNewSessionOnRewind, true)

  const foregroundOnly = harness({
    chat: {
      id: 'chat-1', mode: 'story', sessionId: 'foreground-1',
      timeline: { branchId: 'branch-1', revision: 1, participants: {} }
    }
  })
  const plan = await foregroundOnly.coordinator.prepare('foreground-1')
  assert.equal(plan.backgroundSessionId, '')
  const result = await foregroundOnly.coordinator.complete('foreground-1', {
    operationId: plan.operationId,
    foreground: { status: 'succeeded', message: 'ok' },
    background: { status: 'skipped', message: '没有后台 Session' }
  })
  assert.equal(result.status, 'completed')
})
