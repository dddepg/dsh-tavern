// The only substituted boundary: fixed provider output. Tools execute normally.
import { pathToFileURL } from 'node:url'
const { LlmAdapter } = await import(pathToFileURL(process.env.TAVERN_E2E_LLM_MODULE))
export const inject = ['llm']
export function apply(ctx) {
  class Model extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: 'E2E fixed model', context: { contextWindow: 64000 } }
    }
    async *stream(input) {
      const tools = new Set((input.tools || []).map(tool => tool.name))
      const done = new Set(input.messages.flatMap(message => message.content || [])
        .filter(block => block.type === 'tool-result').map(block => block.toolCallId))
      const blocks = []
      if (tools.has('mvu_submit_update') && !done.has('e2e-gold')) blocks.push({
        type: 'tool-call', id: 'e2e-gold', name: 'mvu_submit_update',
        arguments: JSON.stringify({ operations: [{ op: 'replace', path: '/stat_data/gold',
          valueJson: process.env.TAVERN_E2E_WRONG_GOLD === '1' ? '9' : '10' }] })
      })
      if (tools.has('posture_submit') && !done.has('e2e-posture')) blocks.push({
        type: 'tool-call', id: 'e2e-posture', name: 'posture_submit',
        arguments: JSON.stringify({ posture: '站在柜台前，收下奖励。' })
      })
      if (!blocks.length) blocks.push({ type: 'text', text: '你获得了十枚金币。\n\n<StatusPlaceHolderImpl/>' })
      for (const [index, block] of blocks.entries()) {
        yield { type: 'block-start', index, blockType: block.type }
        yield { type: 'block-end', index, block }
      }
      yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['tavern-e2e'], new Model())
}
