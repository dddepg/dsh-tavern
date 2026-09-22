// Real native Agent + JSONL backend, scripted model; no user profiles or API calls.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { prepareExpandedPatch } from './expanded-session-patch.mjs'
import { replaceSessionSurface } from '../../tavern-plugin/lib/domain/session-surface-mutations.js'
import { installTavernTokenMeter } from '../../tavern-plugin/lib/domain/tavern-token-meter.js'
import { createBodyEditor } from '../../tavern-plugin/lib/domain/body-editor.js'
import { createStoryTimeline } from '../../tavern-plugin/lib/domain/story-timeline.js'
import { projectReplyLayers } from '../../tavern-plugin/lib/domain/reply-presentation.js'
import { locateRollbackSurface } from '../../tavern-plugin/lib/domain/rollback-surface.js'

async function main() {
  const runtime = resolve(process.argv[2])
  const root = process.argv[3] || await mkdtemp(join(tmpdir(), 'tavern-expanded-agent-'))
  process.env.DSH_HOME = join(root, 'home')
  const require = createRequire(join(runtime, 'package.json'))
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  const { boot } = await load('@deepseek-ai/dsh-app-boot')
  const { LlmAdapter } = await load('@deepseek-ai/dsh-llm')
  const names = ['dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-session-query', 'dsh-session-persistence-jsonl', 'dsh-token-meter', 'dsh-commands', 'dsh-agent-loop']
  const config = join(root, 'host.yml')
  await writeFile(config, names.map(name => '- id: ' + name + '\n  name: ' + pathToFileURL(require.resolve('@deepseek-ai/' + name)).href + '\n' + (name === 'dsh-session-persistence-jsonl' ? '  config:\n    root: ' + JSON.stringify(join(root, 'sessions')) + '\n    compression: zstd\n' : '')).join(''))
  const ctx = await boot('tavern-expanded-patch-probe', config)
  const patch = await prepareExpandedPatch(runtime)
  patch.patchPersistence(ctx.sessionPersistence)
  patch.patchQuery(ctx.sessionQuery)
  const removeMeter = installTavernTokenMeter(ctx.tokenMeter)
  const requests = []
  const selection = { provider: 'ordinary-fixture-provider', model: 'fixture' }
  class Model extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 32000 } } }
    async *stream(input) {
      requests.push(structuredClone({ messages: input.messages, purpose: input.purpose }))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: requests.length === 1 ? 'Fixture model continuation' : 'Regenerated model continuation' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter([selection.provider], new Model())
  let handle
  try {
    const checkQuery = async source => {
      const log = await ctx.sessionQuery.readSession('agent-patch-probe')
      assert(log.events.some(event => event.type === patch.marker))
      const surface = await ctx.sessionQuery.readSurface('agent-patch-probe')
      assert.equal(surface.events.findLast(event => event.data.message?.content?.some(block => block.type === 'text')).data.message.content[0].text, 'Edited body after restart')
      const lease = await ctx.sessionQuery.observeSession('agent-patch-probe')
      try {
        assert.equal(lease.source, source)
        assert(lease.events.some(event => event.type === patch.marker))
      } finally { lease[Symbol.dispose]() }
      assert((await ctx.sessionQuery.listEvents('agent-patch-probe')).length > 0)
    }
    if (['resume', 'inspect'].includes(process.argv[4])) await checkQuery('prepared')
    const resume = ['resume', 'inspect'].includes(process.argv[4])
    handle = resume
      ? await ctx.agents.resume({ resumeSessionId: 'agent-patch-probe', agentOptions: selection })
      : await ctx.agents.create({ sessionId: 'agent-patch-probe', agentOptions: selection })
    const agent = handle.agent
    if (!resume) agent.session.append('agent-preset/selected', { agentPreset: 'tavern' })
    const follow = async text => {
      agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
      await agent.whenIdle()
      const failures = agent.session.snapshotEvents().filter(e => e.type === 'turn/end' && (e.data.reason?.kind === 'error' || e.data.reason === 'error'))
      assert.equal(failures.length, 0, 'Agent turn failed: ' + JSON.stringify(failures))
    }
    if (resume) {
      assert.equal(agent.session.deriveMessages().at(-1).content[0].text, 'Edited body after restart')
      if (process.argv[4] === 'inspect') {
        console.log('INSPECT_RESULT ' + JSON.stringify({ result: 'passed', stage: 'third process restores completed rollback', events: agent.session.seq }))
        return
      }
      await follow('Continue after restart')
      assert.equal(requests.length, 1)
      const bodies = requests[0].messages.flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text))
      assert(bodies.includes('Edited body after restart'))
      assert(!bodies.includes('Fixture model continuation'))
      const rollback = () => {
        const s = agent.session
        const target = locateRollbackSurface({ events: s.snapshotEvents(), nodes: s.surface.nodes })
        assert(target)
        replaceSessionSurface(s, 'assistant/message', {
          turn: target.turn, step: target.step,
          message: { id: randomUUID(), role: 'assistant', content: [], source: target.source },
        }, { start: target.userSeq, end: target.endSeq, sourceEventSeqs: target.shadowedSeqs })
      }
      rollback()
      assert.equal(agent.session.deriveMessages().at(-1).content[0].text, 'Edited body after restart')
      await follow('Continue after restart')
      assert.equal(requests.length, 2)
      assert.deepEqual(requests[1].messages.map(m => [m.role, m.content]), requests[0].messages.map(m => [m.role, m.content]))
      assert.equal(agent.session.deriveMessages().at(-1).content[0].text, 'Regenerated model continuation')
      rollback()
      assert.equal(agent.session.deriveMessages().at(-1).content[0].text, 'Edited body after restart')
      await ctx.sessions.flush(agent.session)
      console.log('AGENT_RESULT ' + JSON.stringify({ result: 'passed', stage: 'body editor, cold native Agent resume, rollback and generate again', requests: requests.length, serverLiveAndColdQuery: 'passed', regeneratedRequestContentUnchanged: true, messages: requests[0].messages }))
    } else {
      await follow('Original player input')
      assert.equal(requests.length, 1)
      const session = agent.session
      const old = session.snapshotEvents().findLast(e => e.type === 'assistant/message')
      assert(old)
      let chat = { id: 'chat-probe', sessionId: session.id, mode: 'story', _storageRevision: 1,
        messages: [{ role: 'user', text: 'Original player input' }, { role: 'assistant', turn: old.data.turn, text: 'Fixture model continuation', sourceText: 'Fixture model continuation' }],
        settleStatus: 'done', variables: { hp: 9 } }
      const chatFile = join(root, 'chat.json')
      const editor = createBodyEditor({
        chats: { forSession: async () => structuredClone(chat), update: async (_id, fn) => {
          chat = fn(structuredClone(chat)); chat._storageRevision++
          await writeFile(chatFile, JSON.stringify(chat)); return structuredClone(chat)
        } },
        sessions: { get: () => agent, flush: s => ctx.sessions.flush(s) },
        timeline: createStoryTimeline(), activity: () => ({ busy: false }), project: async text => projectReplyLayers(text), present: async chat => chat,
      })
      const form = await editor.read(session.id)
      await editor.save(session.id, { token: form.token, texts: ['Edited body after restart'] })
      assert.equal(JSON.parse(await readFile(chatFile, 'utf8')).messages.at(-1).text, 'Edited body after restart')
      assert.deepEqual(chat.variables, { hp: 9 })
      await ctx.sessions.flush(session)
      await checkQuery('live')
      await handle.dispose()
      handle = undefined
      const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url), runtime, root, 'resume'], { encoding: 'utf8', timeout: 45000 })
      const line = output.split('\n').find(line => line.startsWith('AGENT_RESULT '))
      assert(line, output)
      const result = JSON.parse(line.slice('AGENT_RESULT '.length))
      const inspectOutput = execFileSync(process.execPath, [fileURLToPath(import.meta.url), runtime, root, 'inspect'], { encoding: 'utf8', timeout: 45000 })
      const inspectLine = inspectOutput.split('\n').find(line => line.startsWith('INSPECT_RESULT '))
      assert(inspectLine, inspectOutput)
      result.rollbackColdRestore = JSON.parse(inspectLine.slice('INSPECT_RESULT '.length))
      await writeFile(join(root, 'agent-report.json'), JSON.stringify(result, null, 2) + '\n')
      console.log(line)
      console.log('REPORT ' + join(root, 'agent-report.json'))
    }
    await patch.verifyFilesUnchanged()
  } finally {
    await handle?.dispose()
    removeMeter()
    await ctx.fiber.dispose()
    patch.dispose()
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
