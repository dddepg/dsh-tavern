import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'

test('old hosts and unavailable sessions retain their existing read semantics', () => {
  const events = Object.freeze([{ seq: 0 }])
  assert.equal(sessionEvents({ events }), events)
  for (const session of [null, undefined, {}, { events: null }]) assert.deepEqual(sessionEvents(session), [])
  assert.throws(() => sessionEvents({ snapshotEvents() { throw Error('read failure') } }), /read failure/)
})
