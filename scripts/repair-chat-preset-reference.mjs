// 修复「会话中途切换预设」留下的引用不一致：runtimePresetPath 被改成新预设，
// 而固化快照仍是旧预设的，于是下次启动的 migrateLegacyChatPreset 拿新预设去抽旧
// 预设的条目，遇到首个坏键即抛「外部预设条目不可抽取」。这里把 runtimePresetPath
// 改回快照真正的来源（snapshot.presetPath），让状态自洽。
//
// 不改消息、不改快照，因此不改变该会话既有的注入内容。默认只诊断，加 --apply 才写入。
//
// 用法：node scripts/repair-chat-preset-reference.mjs <dataRoot> [--apply] <chatId...>
//   dataRoot 形如 <实例>/profile-data/tavern/data
//
// 写入前先停服务（DSH_TAVERN_PORT=<端口> dsh-tavern stop），改完再 start。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createNativeConversationStorage } from '../tavern-plugin/lib/domain/native-conversation-storage.js'
import { inspectPreset, nativeRegexScriptsOf } from '../tavern-plugin/lib/domain/preset-reading.js'

// 复刻 bypass-plans.js extract() 的判定：条目要存在、非 marker、正文非空。
function entryProblems(presetPath, entryKeys, dataRoot) {
  const file = path.join(dataRoot, 'resources', ...presetPath.split('/'))
  let text
  try { text = readFileSync(file, 'utf8') } catch { return ['预设文件不可读: ' + presetPath] }
  const inspected = inspectPreset(text, presetPath)
  if (inspected.valid !== true || inspected.recognized !== true) return ['预设不存在或无法识别: ' + presetPath]
  const available = new Map((inspected.entries || []).map(entry => [String(entry.entryKey), entry]))
  const problems = []
  for (const key of entryKeys) {
    const entry = available.get(key)
    if (!entry) problems.push(key + '(缺失)')
    else if (entry.marker === true) problems.push(key + '(marker)')
    else if (String(entry.content).trim() === '') problems.push(key + '(空正文)')
  }
  return problems
}

// 复刻 preset-library.js runtimeRegexScriptsOf 的 regexKey 生成。
function regexKeysOf(inspected, document) {
  const nativeScripts = nativeRegexScriptsOf(document)
  const usingNative = nativeScripts.length > 0
  const source = usingNative ? nativeScripts : (Array.isArray(inspected.regexScripts) ? inspected.regexScripts : [])
  const occurrences = new Map()
  return source.map(function (script, index) {
    const identifier = String(script.id || '') || 'regex-' + (index + 1)
    const occurrence = (occurrences.get(identifier) || 0) + 1
    occurrences.set(identifier, occurrence)
    return identifier + '#' + occurrence
  })
}

function regexProblems(presetPath, regexKeys, dataRoot) {
  const file = path.join(dataRoot, 'resources', ...presetPath.split('/'))
  let text
  try { text = readFileSync(file, 'utf8') } catch { return ['预设文件不可读: ' + presetPath] }
  const inspected = inspectPreset(text, presetPath)
  let document
  try { document = JSON.parse(text) } catch { return [] }
  const available = new Set(regexKeysOf(inspected, document))
  return regexKeys.filter(key => !available.has(key))
}

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const rest = argv.filter(arg => arg !== '--apply')
const [dataRoot, ...ids] = rest
if (!dataRoot || ids.length === 0) {
  console.error('用法：node scripts/repair-chat-preset-reference.mjs <dataRoot> [--apply] <chatId...>')
  process.exit(2)
}

const storage = createNativeConversationStorage({ dataRoot: path.resolve(dataRoot), onIO: () => {} })
const resolvedDataRoot = path.resolve(dataRoot)

for (const id of ids) {
  const stored = await storage.read(id)
  if (!stored) { console.log(id + ' → 会话不存在'); continue }
  const chat = stored.chat
  const snapshot = chat.runtimePresetSnapshot || {}
  const source = String(snapshot.presetPath || '')
  const entryKeys = (snapshot.sources || []).map(item => String(item && item.entryKey || '')).filter(Boolean)
  const regexKeys = (snapshot.regexSources || []).map(item => String(item && item.regexKey || '')).filter(Boolean)

  console.log('='.repeat(64))
  console.log(id + '  卡: ' + String(chat.cardName || '(未命名)') + '  消息: ' + (chat.messages || []).length)
  console.log('  runtimePresetPath : ' + JSON.stringify(chat.runtimePresetPath))
  console.log('  snapshot.presetPath: ' + JSON.stringify(source === '' ? '(无)' : source))
  console.log('  bypassPlanId      : ' + JSON.stringify(chat.bypassPlanId))

  if (chat.bypassPlanId) { console.log('  → 已迁移，无需处理'); continue }
  if (source === '') { console.log('  → 快照没有来源预设，迁移会被跳过，无需处理'); continue }
  const entryBad = entryProblems(source, entryKeys, resolvedDataRoot)
  const regexBad = regexProblems(source, regexKeys, resolvedDataRoot)
  console.log('  快照来源可抽取性: 条目 ' + entryKeys.length + ' 项' + (entryBad.length ? ' → ' + entryBad.join(', ') : ' 全部可抽取') +
    '，正则 ' + regexKeys.length + ' 项' + (regexBad.length ? ' → ' + regexBad.join(', ') : ' 全部可抽取'))
  if (entryBad.length || regexBad.length) {
    console.log('  → 快照来源本身不可抽取，本脚本不适用（需人工判断）')
    continue
  }
  if (String(chat.runtimePresetPath) === source) { console.log('  → 引用已与快照一致，等待下次启动迁移'); continue }

  const wrong = entryProblems(String(chat.runtimePresetPath), entryKeys, resolvedDataRoot)
  console.log('  当前引用可抽取性: ' + (wrong.length ? wrong.length + ' 项不可抽取（' + wrong[0] + ' …）' : '全部可抽取'))
  if (!apply) { console.log('  → 可修复：把 runtimePresetPath 改为 ' + source + '（加 --apply 写入）'); continue }

  const meta = await storage.readRevisionMetadata(id)
  const saved = await storage.patch(id, meta.revision, [
    { op: 'set', path: ['runtimePresetPath'], value: source },
    { op: 'set', path: ['_storageRevision'], value: meta.revision + 1 }
  ])
  if (saved === undefined || saved === null) { console.log('  ✗ 写入失败（revision 冲突）'); continue }
  const after = (await storage.read(id)).chat
  console.log('  ✓ 已改为 ' + JSON.stringify(after.runtimePresetPath) + '，消息 ' + (after.messages || []).length +
    ' 条、快照 ' + (after.runtimePresetSnapshot?.sources || []).length + ' 条保持不变；重启后启动迁移会写入 bypassPlanId')
}
