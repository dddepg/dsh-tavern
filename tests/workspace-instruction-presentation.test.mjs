import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { presentWorkspaceInstructions, installWorkspaceInstructionPresentation } from '../tavern-plugin/lib/domain/workspace-instruction-presentation.js'
const message = (source, text = 'AGENTS.md instruction') => ({ role: 'user', source, content: [{ type: 'text', text }] })

test('removes complete workspace baselines, scoped updates, and approval notices without changing history', () => {
  const ordinary = [message(undefined), message({ kind: 'plugin', plugin: 'skill' }), { ...message({ kind: 'agent-instructions' }), role: 'assistant' }]
  const request = { messages: [message({ kind: 'agent-instructions', baseline: true }), message({ kind: 'agent-instructions', changes: [{ path: 'CLAUDE.md' }] }), message({ kind: 'plugin', plugin: '@deepseek-ai/dsh-agent-instructions' }), message({ kind: 'plugin', plugin: 'user-approval' }), ...ordinary] }
  const before = structuredClone(request)
  const result = presentWorkspaceInstructions(request)
  assert.deepEqual(result.messages, ordinary)
  assert.deepEqual(request, before)
  assert.equal(presentWorkspaceInstructions(result), result)
})

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

test('production middleware excludes injections for every Tavern agent but not unrelated sessions', async () => {
  let middleware
  const delivered = []
  const ctx = { on: (_name, fn) => { middleware = fn }, llm: { stream: request => middleware(request, async function * () { delivered.push(request); yield { type: 'finish' } }) } }
  const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
  const start = source.indexOf('  installWorkspaceInstructionPresentation(ctx,')
  const end = source.indexOf('  installCompactionRequestProjection', start)
  const chats = { story: {}, script: {}, card: { mode: 'card' }, edit: { mode: 'card', cardEditContext: { version: 1 } } }
  vm.runInNewContext(source.slice(start, end), { ctx, installWorkspaceInstructionPresentation, backgroundAgentRunner: { owns: id => id === 'background' }, sessionStateForSession: async id => chats[id] })
  for (const sessionId of [...Object.keys(chats), 'background', 'unrelated']) {
    const request = { sessionId, messages: [message({ kind: 'agent-instructions' })] }
    for await (const chunk of ctx.llm.stream(request)) assert.equal(chunk.type, 'finish')
    assert.equal(delivered.at(-1).messages.length, sessionId === 'unrelated' ? 1 : 0)
  }
})
