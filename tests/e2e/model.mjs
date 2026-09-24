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
      const text = JSON.stringify(input.messages)
      const gold = (text.includes('雨夜重写') || text.includes('雨夜里')) ? 30 : (text.includes('再次领取奖励') || text.includes('金币累计二十枚')) ? 20 : 10
      const goldId = 'e2e-gold-' + gold, postureId = 'e2e-posture-' + gold
      const blocks = []
      if (tools.has('candidate_submit_choices')) blocks.push({ type: 'tool-call', id: 'e2e-choices', name: 'candidate_submit_choices', arguments: JSON.stringify({ actions: ['再次领取奖励', '向店主道谢', '查看任务告示', '清点背包'], scene: '夜幕降临酒馆' }) })
      if (tools.has('mvu_submit_update') && !done.has(goldId)) blocks.push({
        type: 'tool-call', id: goldId, name: 'mvu_submit_update',
        arguments: JSON.stringify({ operations: [{ op: 'replace', path: '/stat_data/gold',
          valueJson: process.env.TAVERN_E2E_WRONG_GOLD === '1' ? '9' : String(gold) }] })
      })
      if (tools.has('posture_submit') && !done.has(postureId)) blocks.push({
        type: 'tool-call', id: postureId, name: 'posture_submit',
        arguments: JSON.stringify({ posture: '站在柜台前，收下奖励。' })
      })
      if (!blocks.length) blocks.push({ type: 'text', text: (gold === 30 ? '雨夜里，你重新领取了奖励。' : gold === 20 ? '你再次领取了奖励，金币累计二十枚。' : '你获得了十枚金币。') + '\n\n<StatusPlaceHolderImpl/>' })
      for (const [index, block] of blocks.entries()) {
        yield { type: 'block-start', index, blockType: block.type }
        yield { type: 'block-end', index, block }
      }
      yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['tavern-e2e'], new Model())
}
