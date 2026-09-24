import assert from 'node:assert/strict'

// This fixture runs in a child process with an isolated DSH_HOME and data root.
// Keep production module construction intact, including apply() declaration order.
globalThis.fetch = async () => new Response('/* startup test asset */', {
  headers: { 'content-type': 'text/css' }
})
const { apply } = await import('../../tavern-plugin/lib/index.js')
const services = new Map([
  ['settings', { describe: () => [] }],
  ['llm', {}],
  ['tokenMeter', { _foldEvent() {} }],
  ['skills', { registerProvider() {} }],
  ['agentPresets', { resolvedRoots: [] }],
  ['agents', new Map()],
  ['sessions', {}]
])
const disposers = []
const events = new Set()
try {
  await apply({
    get: name => services.get(name),
    llm: services.get('llm'),
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on: name => events.add(name),
    provide: (name, value) => services.set(name, value)
  })
  assert.equal(typeof services.get('tavernSessionSignals')?.control, 'function')
  assert.ok(events.has('system-prompt/assemble'), 'apply must reach final registrations')
  // Allow the empty-profile history recovery scheduled by apply() to finish.
  await new Promise(resolve => setImmediate(resolve))
  console.log('plugin apply completed')
} finally {
  for (const dispose of disposers.reverse()) await dispose()
}
