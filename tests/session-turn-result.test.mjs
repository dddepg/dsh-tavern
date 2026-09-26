import assert from 'node:assert/strict'
import test from 'node:test'

import { assistantResultForTurn } from '../tavern-plugin/lib/domain/session-turn-result.js'

test('rc.1 snapshot-only Session returns the foreground result for the requested turn', () => {
  const events = [{ seq: 0, type: 'assistant/message', data: { turn: 2, message: {
    role: 'assistant', content: [{ type: 'text', text: '新版正文' }], source: { kind: 'model' }
  } } }]
  assert.equal(assistantResultForTurn({ snapshotEvents: () => events }, 2).text, '新版正文')
  assert.equal(assistantResultForTurn({ snapshotEvents: () => events }, 3), null)
})
