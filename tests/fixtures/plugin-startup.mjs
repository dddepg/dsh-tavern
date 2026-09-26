import assert from 'node:assert/strict'
import { createPluginHost } from './plugin-host.mjs'

const host = await createPluginHost()
try {
  assert.equal(typeof host.services.get('tavernSessionSignals')?.control, 'function')
  assert.ok(host.events.has('system-prompt/assemble'), 'apply must reach final registrations')
  console.log('plugin apply completed')
} finally { await host.dispose() }
