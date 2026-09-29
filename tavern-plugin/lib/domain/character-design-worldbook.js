import { inspectWorldBookDocument, updateWorldBookDocument } from './worldbook-resource.js'
import { worldbookContentDigest } from './worldbook-version.js'

const MARKER = 'characterDesign'
const SECTIONS = [['identity', '身份'], ['personality', '性格'], ['appearance', '外貌'], ['speechStyle', '说话方式'], ['narrativeRole', '剧情作用与可能的发展（不是已发生的事实）']]

export function characterDesignWorldbookSnapshot(chat, record) {
  if (chat.openingWorldbookSnapshot?.version === 1) return structuredClone(chat.openingWorldbookSnapshot)
  return { version: 1, libraryDigest: chat.worldbookLibraryDigest || worldbookContentDigest(record),
    source: structuredClone(record?.source ?? null), document: structuredClone(record?.document ?? null) }
}

/** Apply only a generated character entry, leaving library resources and user edits alone. */
export function applyCharacterDesignWorldbook(chat, character, fallbackSnapshot) {
  const snapshot = structuredClone(chat.openingWorldbookSnapshot?.version === 1
    ? chat.openingWorldbookSnapshot : fallbackSnapshot || characterDesignWorldbookSnapshot(chat, null))
  const document = snapshot.document ?? { name: '本局世界书', entries: {}, extensions: {} }
  const view = inspectWorldBookDocument(document)
  const matches = view.entries.filter(entry => entry.rawEntry?.extensions?.dsh_tavern_helper_extra?.[MARKER]?.name === character.name)
  if (matches.length > 1) throw new Error('人物“' + character.name + '”对应多个设计条目，请先整理本局世界书')
  const existing = matches[0]
  const extra = existing?.rawEntry?.extensions?.dsh_tavern_helper_extra || {}
  const previous = extra[MARKER]
  const content = ['人物：' + character.name, ...SECTIONS.map(([key, label]) => label + '：' + character.design[key])].join('\n\n')
  const keys = [...new Set([character.name, ...(character.aliases || [])])]
  if (existing && existing.content !== previous.content) {
    throw new Error('人物“' + character.name + '”的本局世界书正文已被手动修改，未覆盖；请先处理该条目后重试')
  }
  const patch = { content, helperExtra: { ...extra, [MARKER]: { name: character.name, content, keys } } }
  // Keep user-edited activation settings and keywords. Only untouched generated keys follow aliases.
  if (!existing || JSON.stringify(existing.primaryKeys) === JSON.stringify(previous.keys)) patch.primaryKeys = keys
  const operation = existing ? { op: 'update', ref: existing.ref, patch } : {
    op: 'add', entry: { ...patch, comment: '人物设计 · ' + character.name,
      enabled: true, constant: false, selective: true, vectorized: false, secondaryKeys: [],
      position: 1, order: 100, probability: 100, probabilityEnabled: false }
  }
  snapshot.document = updateWorldBookDocument(document, { operations: [operation] }).document
  chat.openingWorldbookSnapshot = snapshot
  return { worldbook: { scope: 'current-chat', name: character.name, created: !existing } }
}
