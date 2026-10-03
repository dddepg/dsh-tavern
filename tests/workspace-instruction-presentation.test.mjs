import assert from 'node:assert/strict'
import test from 'node:test'

import { presentWorkspaceInstructions } from '../tavern-plugin/lib/domain/workspace-instruction-presentation.js'
const message = (source, text = 'AGENTS.md instruction') => ({ role: 'user', source, content: [{ type: 'text', text }] })

test('strips only named host contributions and preserves other runtime context', () => {
  for (const role of ['user', 'system']) {
    const request = { messages: [{ ...message({ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', sections: [{ name: 'approval:policy', text: 'never' }, { name: 'deployment:persona-prefix', text: 'coding agent' }, { name: 'keep', text: 'other context' }] }), role }] }
    const before = structuredClone(request)
    const result = presentWorkspaceInstructions(request)
    assert.equal(result.messages[0].source.sections.length, 1)
    assert.ok(result.messages[0].content[0].text.endsWith('other context'))
    assert.ok(!result.messages[0].content[0].text.includes('coding agent'))
    assert.deepEqual(request, before)
    request.messages[0].source.sections.pop()
    assert.deepEqual(presentWorkspaceInstructions(request).messages, [])
  }
})
