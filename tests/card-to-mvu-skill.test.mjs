import {buildMvuArtifacts} from '../tavern-plugin/lib/domain/mvu-conversion-artifacts.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { parse } from 'yaml'
import { createTavernSkillModule } from '../tavern-plugin/lib/domain/tavern-skills.js'

const root = new URL('../presets/tavern/skills/', import.meta.url)

const definition = { initialState: {场景:{地点:'入口'},玩家:{位置:'门口'},人物:{$meta:{extensible:true,template:{姓名:'',位置:'未明确',在场:true}}}}, updateRules: '按正文事实更新玩家位置与人物档案' }
const {entries: recipeEntries, regexScripts: recipeRegex, statusHtml} = buildMvuArtifacts(definition)

for (const name of ['card-to-mvu','edit-card','create-card']) test(`${name} 可由 Tavern 内置目录读取，引用资源齐全且默认可调用`, async () => {
  const skills = createTavernSkillModule({ directory: new URL('../data/skills/', import.meta.url).pathname, builtInDirectory: root.pathname })
  const skill = await skills.read(name)
  assert.equal(skill.source, 'builtin')
  const metadata = parse(skill.content.match(/^---\n([\s\S]*?)\n---/)[1])
  assert.equal(metadata.name, name)
  assert.ok(metadata.description.length > 0 && metadata.description.length <= 500)
  assert.notEqual(metadata['disable-model-invocation'], true)
  assert.notEqual(metadata['user-invocable'], false)
  for (const [, relative] of skill.content.matchAll(/\]\(((?:references|assets)\/[^)]+)\)/g)) {
    assert.ok((await readFile(new URL(relative, new URL(name+'/',root)), 'utf8')).length > 0)
  }
})

test('通用状态模板重新读取变量并刷新 DOM，支持新增与恢复且跳过内部字段', async () => {
  function node() {
    return { textContent: '', children: [], replaceChildren() { this.children = [] }, append(...children) { this.children.push(...children) } }
  }
  const nodes = { notice: node(), values: node() }
  const handlers = new Map()
  let data = { 玩家: { 位置: '门口' }, 人物: { $meta: { extensible: true } }, __internal: '隐藏' }
  const sandbox = {
    document: { getElementById(id) { return nodes[id] }, createElement: node },
    waitGlobalInitialized: async () => {},
    Mvu: { events: { VARIABLE_INITIALIZED: 'init', VARIABLE_UPDATE_ENDED: 'update' }, getMvuData(options) {
      assert.equal(options.type, 'message'); assert.equal(options.message_id, 'latest')
      return { stat_data: data }
    } },
    tavern_events: { MESSAGE_UPDATED: 'message', SAME_EVENT: 'update' },
    eventOn(event, callback) { assert.equal(handlers.has(event), false); handlers.set(event, callback) }
  }
  vm.runInNewContext(statusHtml.match(/<script>\n([\s\S]*?)<\/script>/)[1], sandbox)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(nodes.values.children.map(item => item.textContent), ['玩家 · 位置', '门口'])
  data = { 玩家: { 位置: '大厅' }, 人物: { 新人物: { 姓名: '<img src=x onerror=alert(1)>' } }, 人物库: {
    预备人物: { 姓名: '暂不展示', 状态: { 在场: false } },
    登场人物: { 姓名: '林晴', 状态: { 在场: true } }
  } }
  handlers.get('update')()
  assert.deepEqual(nodes.values.children.map(item => item.textContent), [
    '玩家 · 位置', '大厅', '人物 · 新人物 · 姓名', '<img src=x onerror=alert(1)>',
    '人物库 · 预备人物 · 姓名', '暂不展示', '人物库 · 预备人物 · 状态 · 在场', 'false',
    '人物库 · 登场人物 · 姓名', '林晴', '人物库 · 登场人物 · 状态 · 在场', 'true'
  ])
  data = { 玩家: { 位置: '门口' } }
  handlers.get('message')()
  assert.deepEqual(nodes.values.children.map(item => item.textContent), ['玩家 · 位置', '门口'])
  data = undefined
  handlers.get('init')()
  assert.equal(nodes.values.children.length, 0)
  assert.ok(nodes.notice.textContent)
})
