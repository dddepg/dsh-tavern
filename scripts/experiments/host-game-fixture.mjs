// Scripted text model for one temporary 0.1.5-rc.2 game. No network calls.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(process.argv[1])
const { LlmAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)

const provider = 'game-fixture'
let stories = 0

class FixtureModel extends LlmAdapter {
  async resolveModel(idProvider, id) {
    return { provider: idProvider, id, name: id, context: { contextWindow: 32000 } }
  }
  async *stream(input) {
    const tools = Array.isArray(input.tools) ? input.tools : []
    const system = typeof input.system === 'string' ? input.system : ''
    if (tools.some(tool => tool && tool.name === 'posture_submit') || system.includes('posture_submit')) {
      const argumentsText = JSON.stringify({ posture: '站在窗边，雨衣未脱。' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'posture-1', name: 'posture_submit', argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'posture-1', name: 'posture_submit', arguments: argumentsText } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    stories += 1
    const text = stories === 1 ? '雨停了一会儿，灯塔的门开着。' : '门里的灯又亮了。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export async function apply(ctx) {
  ctx.llm.registerAdapter([provider], new FixtureModel())
}
