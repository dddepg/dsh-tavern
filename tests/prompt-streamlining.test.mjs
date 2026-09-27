import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const serverSource = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')

const orchestratorSource = await readFile(new URL('../tavern-plugin/lib/domain/turn-orchestration.js', import.meta.url), 'utf8')
const orchestrationStrategiesSource = await readFile(new URL('../tavern-plugin/lib/domain/foreground-orchestration-strategies.js', import.meta.url), 'utf8')

const tavernPresetSource = await readFile(new URL('../presets/tavern/agent.cordis.yml', import.meta.url), 'utf8')

const profileSource = await readFile(new URL('../package.json', import.meta.url), 'utf8')
const profilePatchSource = await readFile(new URL('../tavern-plugin/cordis.patch.yml', import.meta.url), 'utf8')
const advancedSkillSource = await readFile(new URL('../presets/tavern/skills/advanced-capabilities/SKILL.md', import.meta.url), 'utf8')

function between(source, start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert.notEqual(from, -1, `missing start marker: ${start}`)
  assert.notEqual(to, -1, `missing end marker: ${end}`)
  return source.slice(from, to)
}

test('原版恢复工具只操作当前人物卡并要求固定确认文本', () => {
  const restoreTool = between(serverSource, "name: 'tavern_restore_card'", "output:")

  assert.match(restoreTool, /confirmation:/)
  assert.match(restoreTool, /enum: \['确认从原版恢复'\]/)
  assert.doesNotMatch(restoreTool, /path:/)
  assert.match(serverSource, /restoreCurrentCard\(sessionId\)/)
  assert.match(serverSource, /turnOrchestrator\.discard/)
})

test('卡片 Agent 以极简模式工具为底座，游玩 Agent 保留 Skill 但不暴露文件编辑工具', () => {
  assert.match(profileSource, /"@deepseek-ai\/dsh-base"/)
  assert.doesNotMatch(tavernPresetSource, /dsh-tool-bash-persistent|dsh-tool-pwsh-persistent|dsh-terminal-bash|timeoutMs: 300000/)
  assert.doesNotMatch(tavernPresetSource, /id: (?:bash|pwsh)-sandbox/)
  assert.match(profilePatchSource, /id: bash-sandbox[\s\S]*?timeoutMs: 600000[\s\S]*?maxTimeoutMs: 600000/)
  assert.match(profilePatchSource, /id: pwsh-sandbox[\s\S]*?timeoutMs: 600000[\s\S]*?maxTimeoutMs: 600000/)
  assert.match(profilePatchSource, /id: tool-bash[\s\S]*?disabled: !!js process\.platform === 'win32'/)
  assert.match(profilePatchSource, /id: tool-pwsh[\s\S]*?disabled: !!js process\.platform !== 'win32'/)
  assert.match(profilePatchSource, /id: tool-fs[\s\S]*?disabled: false/)
  assert.match(tavernPresetSource, /@deepseek-ai\/dsh-tool-str-replace-editor/)
  assert.match(serverSource, /FileSystemSkillProvider/)
  assert.match(serverSource, /includeDefaultRoots: false/)
  assert.match(tavernPresetSource, /@deepseek-ai\/dsh-tool-skill/)
  assert.match(tavernPresetSource, /@deepseek-ai\/dsh-tool-cordis/)
  assert.match(tavernPresetSource, /text: ''/)
  assert.doesNotMatch(tavernPresetSource, /complete: true/)
  assert.match(serverSource, /cardSystemPrompt: function \(\) \{ return prompt\('card-system'\) \}/)
  assert.doesNotMatch(serverSource, /runtimePrompt\('play-mode'\)/)
  assert.match(serverSource, /resourceWorkspaceContext\(cwd, projection, runtimePrompt\('card-workspace'\)\)/)
  assert.doesNotMatch(orchestrationStrategiesSource, /section\.name === 'tool:cordis'/)
  assert.match(orchestrationStrategiesSource, /name: 'tavern:resource-workspace'/)
  assert.match(advancedSkillSource, /Cordis 动态插件/)
  assert.match(advancedSkillSource, /tools\.cordis\.yml/)
  assert.match(orchestratorSource, /if \(mode === 'card'\) return \[\.\.\.CARD_MEMORY_TOOLS, 'web_search', shellToolName, \.\.\.dshFileToolNames, 'skill', 'tavern_read_skill_reference', 'tavern_save_skill', \.\.\.cordisToolNames, 'tavern_user_profile_read', 'tavern_user_profile_save', 'tavern_read_card'/)
  assert.doesNotMatch(orchestratorSource, /mode === 'revision'|mode === 'extract'/)
  assert.doesNotMatch(orchestratorSource, /if \(mode === 'script'\) return \[[^\]]*'bash'/)
	assert.match(serverSource, /controlledToolNames = new Set\(\[[^\n]*'bash', 'pwsh', \.\.\.dshFileToolNames, 'skill', 'tavern_read_skill_reference', 'web_search', 'tavern_save_skill', \.\.\.cordisToolNames, 'tavern_user_profile_read'/)
	assert.match(serverSource, /controlledToolNames = new Set\([^\n]*'tavern_test_response'/)
  assert.match(serverSource, /name: 'tavern_save_skill'/)
  assert.doesNotMatch(serverSource, /name: 'tavern_bind_script'/)
})

// 本地修复（截断正文不算提交）回归：上游 18c2a3e8 精简掉了本用例所在的旧文件内容，
// 这里按 v2.3 源码结构重新落一条最小断言。
test('前台正文被截断时按失败尾部处理，不提交本轮', () => {
  const lifecycle = between(serverSource, '// ---------- DSH 回合生命周期 ----------', '// ---------- 模型可选工具 ----------')
  const stopping = between(lifecycle, "ctx.on('agent/turn-stopping'", "ctx.on('agent/error'")

  assert.match(stopping, /await turnOrchestrator\.assertCompleteReply\(\{/)
  assert.match(stopping, /streamFinishKind\(/)
  // 判定必须早于 finalize：一旦提交就再也拿不回失败尾部。
  assert.ok(stopping.indexOf('assertCompleteReply(') < stopping.indexOf('foregroundHandoff.finalize('),
    '截断判定必须发生在提交之前')
})
