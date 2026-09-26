import assert from 'node:assert/strict'
import test from 'node:test'

import { waitForWritableSession } from '../tavern-plugin/lib/domain/agent-readiness.js'

test('默认等待窗口允许 Agent 在两秒后完成注册', async () => {
  let elapsedMs = 0
  const readyAgent = { session: { id: 'session-slow' } }

  const target = await waitForWritableSession({
    registry: { get() { return elapsedMs >= 2100 ? readyAgent : undefined } },
    sessionId: 'session-slow',
    sleep: async function (ms) { elapsedMs += ms }
  })

  assert.equal(target.agent, readyAgent)
  assert.equal(target.session, readyAgent.session)
  assert.equal(elapsedMs, 2100)
})

test('默认等待窗口在八秒后结束', async () => {
  let elapsedMs = 0
  let lookups = 0

  await assert.rejects(
    waitForWritableSession({
      registry: { get() { lookups += 1; return undefined } },
      sessionId: 'session-timeout',
      sleep: async function (ms) { elapsedMs += ms }
    }),
    /无法写入 DSH 会话开场白: session-timeout/
  )

  assert.equal(elapsedMs, 8000)
  assert.equal(lookups, 321)
})

test('Agent 尚未注册时直接返回已绑定的 DSH Session', async () => {
  const session = { id: 'session-attached' }
  let waits = 0

  const target = await waitForWritableSession({
    registry: { get() { return undefined } },
    sessions: { get(sessionId) { return sessionId === session.id ? session : undefined } },
    sessionId: session.id,
    sleep: async function () { waits += 1 }
  })

  assert.equal(target.session, session)
  assert.equal(target.agent, undefined)
  assert.equal(waits, 0)
})
