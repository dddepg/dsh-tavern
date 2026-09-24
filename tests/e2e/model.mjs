import { compactionStream, modelCapacity } from './compaction-model.mjs'
// The only substituted boundary: fixed provider output. Tools execute normally.
import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const { LlmAdapter } = await import(pathToFileURL(process.env.TAVERN_E2E_LLM_MODULE))
export const inject = ['llm']
export function apply(ctx) {
  class Model extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: 'E2E fixed model', ...(process.env.TAVERN_E2E_COMPACTION_DIR ? { defaultMaxTokens: 8192 } : {}), context: { contextWindow: process.env.TAVERN_E2E_COMPACTION_DIR ? await modelCapacity() : 64000 } }
    }
    async *stream(input) {
      if (process.env.TAVERN_E2E_COMPACTION_DIR) { yield* compactionStream(input); return }
      const tools = new Set((input.tools || []).map(tool => tool.name))
      const done = new Set(input.messages.flatMap(message => message.content || [])
        .filter(block => block.type === 'tool-result').map(block => block.toolCallId))
      const text = JSON.stringify(input.messages)
      const presetRound = [70, 60, 50].find(value => text.includes(`E2E 预设验收 ${value}`) || text.includes(`预设切换后继续游玩，金币 ${value}。`))
      const gold = presetRound || (text.includes('E2E 修正金币为四十') ? 40 : (text.includes('雨夜重写') || text.includes('雨夜里')) ? 30 : (text.includes('再次领取奖励') || text.includes('金币累计二十枚')) ? 20 : 10)
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
      if (!blocks.length) blocks.push({ type: 'text', text: (presetRound ? `预设切换后继续游玩，金币 ${gold}。` : gold === 30 ? '雨夜里，你重新领取了奖励。' : gold === 20 ? '你再次领取了奖励，金币累计二十枚。' : '你获得了十枚金币。') + '\n\n<StatusPlaceHolderImpl/>' })
      if (presetRound && blocks.some(block => block.type === 'text') && process.env.TAVERN_E2E_REQUEST_AUDIT) {
        await appendFile(process.env.TAVERN_E2E_REQUEST_AUDIT, JSON.stringify({ gold,
          presetA: text.includes('E2E_PRESET_A_ACTIVE'), presetB: text.includes('E2E_PRESET_B_ACTIVE'),
          settlement: tools.has('mvu_submit_update') || tools.has('posture_submit') }) + '\n')
      }
      for (const [index, block] of blocks.entries()) {
        yield { type: 'block-start', index, blockType: block.type }
        yield { type: 'block-end', index, block }
      }
      yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['tavern-e2e'], new Model())
}
