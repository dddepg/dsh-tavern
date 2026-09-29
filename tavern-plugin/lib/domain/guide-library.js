import { randomUUID } from 'node:crypto'
const PATH = 'temporary-guide-library.json'
export function appendLibraryGuides(existing, incoming, now = Date.now()) {
  const current = Array.isArray(existing) ? existing : []
  const additions = [...new Set(incoming)].filter(text => !current.some(item => item.text === text))
  if (current.length + additions.length > 20) throw new Error('加载后将超过 20 条指导，请先删除部分本局指导')
  return [...current, ...additions.map(text => ({ id: randomUUID(), text, createdAt: now }))]
}
export function createGuideLibrary({ store, now = Date.now }) {
  async function list() { return (await store.readJson(PATH))?.items || [] }
  async function save(name, guides) {
    name = String(name || '').trim()
    const texts = (guides || []).map(item => String(item.text || '').trim()).filter(Boolean)
    if (!name || name.length > 80) throw new Error('请输入 1 至 80 字的方案名称')
    if (!texts.length || texts.length > 20 || texts.some(text => text.length > 2000)) throw new Error('方案须包含 1 至 20 条指导，每条最多 2000 字')
    const item = { id: randomUUID(), name, guides: texts, createdAt: now() }
    await store.updateJson(PATH, value => ({ version: 1, items: [...(value?.items || []), item] }))
    return item
  }
  async function get(id) {
    const item = (await list()).find(item => item.id === id)
    if (!item) throw new Error('临时指导方案不存在，请刷新指导库')
    return item
  }
  return { list, save, get }
}
