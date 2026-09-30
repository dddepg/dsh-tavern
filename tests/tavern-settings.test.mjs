import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { applyTavernSettingsPatch, presentTavernSettings, resolveSystemPrompt } from '../tavern-plugin/lib/domain/tavern-settings.js'
import { SYSTEM_PROMPT_NAMES, prompt } from '../tavern-plugin/lib/prompt-catalog.js'
import { createProfileDataStore } from '../tavern-plugin/lib/profile-data-store.js'

const serverSource = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
const clientSource = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')

// Exercise the real save/read call sites with durable storage, not a copied implementation.
async function settingsHarness(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tavern-settings-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profileData = createProfileDataStore({ dataRoot: root })
  const context = {
    profileData, settingsPath: 'tavern-settings.json', tavernSettingsDocument: undefined,
    applyTavernSettingsPatch, presentTavernSettings,
    promptDefaults: () => ({ story: '默认正文' })
  }
  const start = serverSource.indexOf('async function readTavernSettings()')
  assert.ok(start >= 0)
  vm.runInNewContext(serverSource.slice(start, serverSource.indexOf('\n  function runtimePrompt', start)) +
    '; this.read = readTavernSettings; this.update = updateTavernSettings;', context)
  return { ...context, saved: () => profileData.readJson(context.settingsPath) }
}

test('新旧设置均固定信任人物卡，不再应用手动样式，也不改写原始文档', () => {
  for (const document of [undefined, null, {}, { trustedCardMode: false, styleEnvironment: {
    customCss: 'body {display:none}', extensionStyles: ['https://example.com/old.css']
  } }]) {
    const before = JSON.stringify(document)
    const result = presentTavernSettings(document, {})
    assert.equal(result.compatibilityMode, false)
    assert.equal(result.trustedCardMode, true)
    assert.equal(Object.hasOwn(result, 'styleEnvironment'), false)
    assert.equal(JSON.stringify(document), before)
  }
})

test('旧客户端的信任和样式修改不再生效，其他未知设置仍保留', () => {
  const initial = { unknown: { keep: true }, compatibilityMode: true, promptOverrides: { story: '自定义' } }
  const saved = applyTavernSettingsPatch(initial, { trustedCardMode: false, styleEnvironment: { customCss: 'body {}' } })
  assert.deepEqual(saved, initial)
  assert.deepEqual(applyTavernSettingsPatch(saved, { compatibilityMode: false }), { ...initial, compatibilityMode: false })
  assert.equal(presentTavernSettings(saved, {}).trustedCardMode, true)
})

test('联网搜索作为新游戏默认值持久化，默认关闭', () => {
  assert.equal(presentTavernSettings({}, {}).webSearchEnabled, false)
  const enabled = applyTavernSettingsPatch({ unknown: '保留' }, { webSearchEnabled: true })
  assert.equal(enabled.webSearchEnabled, true)
  assert.equal(enabled.unknown, '保留')
  assert.equal(presentTavernSettings(enabled, {}).webSearchEnabled, true)
  assert.equal(applyTavernSettingsPatch(enabled, { webSearchEnabled: false }).webSearchEnabled, false)
})

test('后台模型可以固定为独立 provider/model，也可以恢复为开局跟随前台', () => {
  assert.equal(presentTavernSettings({}, {}).backgroundModel, null)
  const fixed = applyTavernSettingsPatch({ unknown: true }, { backgroundModel: { provider: 'vertex', model: 'gemini-2.5-pro' } })
  assert.deepEqual(fixed.backgroundModel, { provider: 'vertex', model: 'gemini-2.5-pro' })
  assert.equal(fixed.unknown, true)
  assert.deepEqual(presentTavernSettings(fixed, {}).backgroundModel, { provider: 'vertex', model: 'gemini-2.5-pro' })
  assert.equal(applyTavernSettingsPatch(fixed, { backgroundModel: null }).backgroundModel, undefined)
  assert.throws(() => applyTavernSettingsPatch({}, { backgroundModel: { provider: '', model: 'x' } }), /配置无效/)
})

test('silly 入口默认关闭，旧关闭信任值不影响运行', async t => {
  const harness = await settingsHarness(t)
  await harness.profileData.writeJson(harness.settingsPath, {
    compatibilityMode: true, trustedCardMode: false, styleEnvironment: { customCss: 'body {}' }, unknown: '保留'
  })
  const result = await harness.update({ compatibilityMode: false })
  assert.equal(result.compatibilityMode, false)
  assert.equal(result.trustedCardMode, true)
  assert.equal(Object.hasOwn(result, 'styleEnvironment'), false)
  assert.equal((await harness.read()).compatibilityMode, false)
  // Retain legacy data on disk without letting it control the current runtime.
  assert.equal((await harness.saved()).unknown, '保留')
  assert.equal((await harness.saved()).trustedCardMode, false)
  for (const patch of [{ systemPrompt: { name: 'story', text: '修改正文' } },
    { systemPrompts: { story: '导入正文' } }, { resetSystemPrompts: true }]) {
    await harness.update(patch)
    assert.equal((await harness.read()).trustedCardMode, true)
    assert.equal(Object.hasOwn(await harness.read(), 'styleEnvironment'), false)
  }
})

const settingsModuleSource = await readFile(new URL('../tavern-plugin/src/client/modules/global-settings.js', import.meta.url), 'utf8')

test('设置界面不重复提供已并入外观的分色，不恢复旧兼容样式选项', () => {
  const context = { GlobalPlayDefaults: function GlobalPlayDefaults() {}, DisplayPreferencesSettings: function DisplayPreferencesSettings() {}, CandidatePreferencesSettings: function CandidatePreferencesSettings() {}, PromptTemplateSettingsEntry: function PromptTemplateSettingsEntry() {}, TavernConversationWritingSkills: function TavernConversationWritingSkills() {}, TavernDefaultModelSetting: function TavernDefaultModelSetting() {}, TavernTextColorSettings: function TavernTextColorSettings() {}, ContextCompactionSettings: function ContextCompactionSettings() {}, SceneImageSettings: function SceneImageSettings() {}, React: {
    useState: initial => [initial, () => {}],
    useEffect() {},
    createElement: (type, props, ...children) => ({ type, props, children })
  } }
  vm.runInNewContext(settingsModuleSource + '; this.render = createGlobalSettingsModule(this).TavernSettingsSection;', context)
  const root = context.render()
  const nodes = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    nodes.push(node)
    for (const child of node.children || []) visit(child)
  }
  visit(root)
  assert.equal(nodes.some(node => node.type === context.TavernTextColorSettings), false)
  const inputs = nodes.filter(node => node.type === 'input')
  assert.equal(inputs.length, 0)
  assert.doesNotMatch(JSON.stringify(root), /开放 silly 模式入口/)
  const select = nodes.find(node => node.type === 'select' && node.props['aria-label'] === '后台模型')
  assert.equal(select, undefined)
  assert.equal(nodes.some(node => node.type === 'textarea' || node.type === 'details'), false)
  assert.doesNotMatch(JSON.stringify(root), /兼容模式|受信任人物卡模式|SillyTavern 样式环境|Custom CSS/)
})

test('全局接口拒绝修改本局联网搜索开关', async t => {
  const harness = await settingsHarness(t)
  await assert.rejects(harness.update({ webSearchEnabled: true }), /本局设置/)
})

test('旧兼容开关不自动开放 silly 入口', async t => {
  const harness = await settingsHarness(t)
  const legacy = { compatibilityMode: true, unknown: '保留' }
  await harness.profileData.writeJson(harness.settingsPath, legacy)
  assert.equal((await harness.read()).compatibilityMode, false)
  assert.equal((await harness.update({ compatibilityMode: false })).compatibilityMode, false)
  assert.equal((await harness.read()).compatibilityMode, false)
  assert.equal((await harness.saved()).compatibilityMode, false)
  assert.equal(presentTavernSettings(await harness.saved(), {}).compatibilityMode, false)
  assert.doesNotMatch(clientSource, /onClick: function \(\) \{ switchPlayRequestMode\("sillytavern"\); \} \}, "silly 模式"/)
})

test('旧 play-mode 覆盖保留在数据中，但不再出现在可用提示词列表', () => {
  const saved = { promptOverrides: { 'play-mode': '旧游玩指令', story: '自定义正文规则' } }
  const before = JSON.stringify(saved)
  const defaults = Object.fromEntries(SYSTEM_PROMPT_NAMES.map(name => [name, prompt(name)]))
  const presented = presentTavernSettings(saved, defaults)
  assert.ok(!presented.systemPrompts.some(item => item.name === 'play-mode'))
  assert.equal(presented.storyPrompt, '自定义正文规则')
  assert.equal(JSON.stringify(saved), before)
})

test('系统正文提示词默认使用内置内容，并可保存自定义覆盖', function () {
  const defaults = { story: '内置正文提示词' }
  assert.deepEqual(presentTavernSettings({}, defaults), {
    defaultPlaySettings: { playerName: '你', statusBarPlacement: 'sidebar', backgroundTasks: { posture: true, characterDesign: false, variables: true, ledger: false }, webSearchEnabled: false, sceneImagesEnabled: false },
    hideContextAndReasoning: false,
    candidateDismissMode: 'after-fill',
    contextCompaction: { mode: 'manual', rounds: 20, percent: 80, revision: 0 },
    compatibilityMode: false,
    sillyModeEnabled: false,
    webSearchEnabled: false,
    systemAppendEnabled: true,
    defaultDisabledWritingSkills: [],
    defaultForegroundModel: null,
    defaultBackgroundModel: null,
    backgroundModel: null,
    backgroundTasks: { posture: true, characterDesign: false, variables: true, ledger: false },
    trustedCardMode: true,
    systemPrompts: [{ name: 'story', text: '内置正文提示词', customized: false }],
    storyPrompt: '内置正文提示词',
    storyPromptCustomized: false
  })

  const saved = applyTavernSettingsPatch({ compatibilityMode: true, unknown: 1 }, { storyPrompt: '  用户正文提示词  ' })
  assert.equal(saved.unknown, 1)
  assert.equal(resolveSystemPrompt(saved, 'story', function () { return '默认' }), '用户正文提示词')
  assert.deepEqual(presentTavernSettings(saved, defaults), {
    defaultPlaySettings: { playerName: '你', statusBarPlacement: 'sidebar', backgroundTasks: { posture: true, characterDesign: false, variables: true, ledger: false }, webSearchEnabled: false, sceneImagesEnabled: false },
    hideContextAndReasoning: false,
    candidateDismissMode: 'after-fill',
    contextCompaction: { mode: 'manual', rounds: 20, percent: 80, revision: 0 },
    compatibilityMode: false,
    sillyModeEnabled: false,
    webSearchEnabled: false,
    systemAppendEnabled: true,
    defaultDisabledWritingSkills: [],
    defaultForegroundModel: null,
    defaultBackgroundModel: null,
    backgroundModel: null,
    backgroundTasks: { posture: true, characterDesign: false, variables: true, ledger: false },
    trustedCardMode: true,
    systemPrompts: [{ name: 'story', text: '用户正文提示词', customized: true }],
    storyPrompt: '用户正文提示词',
    storyPromptCustomized: true
  })
})

test('恢复默认只删除正文覆盖并保留其他设置', function () {
  const saved = applyTavernSettingsPatch({
    defaultPlaySettings: { playerName: '你', statusBarPlacement: 'sidebar', backgroundTasks: { posture: true, characterDesign: false, variables: true, ledger: false }, webSearchEnabled: false, sceneImagesEnabled: false },
    hideContextAndReasoning: false,
    candidateDismissMode: 'after-fill',
    contextCompaction: { mode: 'manual', rounds: 20, percent: 80, revision: 0 },
    compatibilityMode: true,
    promptOverrides: { story: '用户正文提示词', future: '保留' }
  }, { storyPrompt: null })

  assert.deepEqual(saved, {
    defaultPlaySettings: { playerName: '你', statusBarPlacement: 'sidebar', backgroundTasks: { posture: true, characterDesign: false, variables: true, ledger: false }, webSearchEnabled: false, sceneImagesEnabled: false },
    hideContextAndReasoning: false,
    candidateDismissMode: 'after-fill',
    contextCompaction: { mode: 'manual', rounds: 20, percent: 80, revision: 0 },
    compatibilityMode: true,
    promptOverrides: { future: '保留' }
  })
  assert.equal(resolveSystemPrompt(saved, 'story', function (name) { return '默认:' + name }), '默认:story')
})

test('拒绝空白正文提示词', function () {
  assert.throws(function () {
    applyTavernSettingsPatch({}, { storyPrompt: '   ' })
  }, /不能为空/)
})

test('整套系统提示词可以导入覆盖并整体恢复默认', function () {
  const saved = applyTavernSettingsPatch({ compatibilityMode: true, unknown: 1 }, {
    systemPrompts: { story: '新正文', 'play-mode': '新游玩规则' }
  })
  assert.equal(resolveSystemPrompt(saved, 'story', function () { return '默认正文' }), '新正文')
  assert.equal(resolveSystemPrompt(saved, 'play-mode', function () { return '默认游玩' }), '新游玩规则')
  assert.equal(saved.unknown, 1)

  const reset = applyTavernSettingsPatch(saved, { resetSystemPrompts: ['story', 'play-mode'] })
  assert.equal(reset.promptOverrides, undefined)
  assert.equal(reset.compatibilityMode, true)
  assert.equal(reset.unknown, 1)
})

test('单项系统提示词保存和恢复不会影响其他项', function () {
  const saved = applyTavernSettingsPatch({ promptOverrides: { story: '正文', future: '保留' } }, {
    systemPrompt: { name: 'play-mode', text: '游玩规则' }
  })
  assert.deepEqual(saved.promptOverrides, { story: '正文', future: '保留', 'play-mode': '游玩规则' })
  const restored = applyTavernSettingsPatch(saved, { systemPrompt: { name: 'play-mode', text: null } })
  assert.deepEqual(restored.promptOverrides, { story: '正文', future: '保留' })
})

test('全局 API 拒绝修改后台配置，防止旧客户端改变所有对话', async t => {
  const run = await settingsHarness(t)
  await assert.rejects(run.update({ backgroundTasks: { variables: false } }), /本局设置/)
  await assert.rejects(run.update({ backgroundModel: null }), /本局设置/)
})

test('已保存的全部系统提示词在重启和内置默认更新后保留，仅显式恢复默认清除', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tavern-prompts-upgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = 'tavern-settings.json'
  const oldStore = createProfileDataStore({ dataRoot: root })
  for (const name of SYSTEM_PROMPT_NAMES) {
    await oldStore.updateJson(file, current => applyTavernSettingsPatch(current, {
      systemPrompt: { name, text: '用户内容：' + name }
    }))
  }
  const upgradedStore = createProfileDataStore({ dataRoot: root })
  const defaults = Object.fromEntries(SYSTEM_PROMPT_NAMES.map(name => [name, '新版默认：' + name]))
  const saved = await upgradedStore.readJson(file)
  for (const item of presentTavernSettings(saved, defaults).systemPrompts) {
    assert.equal(item.text, '用户内容：' + item.name)
    assert.equal(item.customized, true)
    assert.equal(resolveSystemPrompt(saved, item.name, name => defaults[name]), item.text)
  }
  await upgradedStore.updateJson(file, current => applyTavernSettingsPatch(current, {
    systemPrompt: { name: 'story', text: null }
  }))
  const restored = await upgradedStore.readJson(file)
  assert.equal(resolveSystemPrompt(restored, 'story', name => defaults[name]), defaults.story)
  for (const name of SYSTEM_PROMPT_NAMES.filter(name => name !== 'story')) {
    assert.equal(resolveSystemPrompt(restored, name, key => defaults[key]), '用户内容：' + name)
  }
})

test('新游戏前后台默认模型分别保存、清除且不触碰旧全局模型版本', () => {
  let settings = { unknown: true, backgroundModelRevision: 7 }
  for (const name of ['defaultForegroundModel', 'defaultBackgroundModel']) {
    assert.equal(presentTavernSettings(settings, {})[name], null)
    settings = applyTavernSettingsPatch(settings, { [name]: { provider: ' p ', model: ' m ', reasoningEffort: 'low' } })
    assert.deepEqual(presentTavernSettings(settings, {})[name], { provider: 'p', model: 'm', reasoningEffort: 'low' })
    assert.throws(() => applyTavernSettingsPatch(settings, { [name]: { provider: 'p' } }), /默认模型配置无效/)
  }
  const cleared = applyTavernSettingsPatch(settings, { defaultForegroundModel: null })
  assert.equal(cleared.defaultForegroundModel, null)
  assert.deepEqual(cleared.defaultBackgroundModel, settings.defaultBackgroundModel)
  assert.equal(cleared.backgroundModelRevision, 7)
  assert.equal(cleared.unknown, true)
})

test('全局写作 Skill 逐项保存，恢复开启不改动其他 Skill', () => {
  let document = applyTavernSettingsPatch({}, { defaultWritingSkill: { name: 'one', enabled: false } })
  document = applyTavernSettingsPatch(document, { defaultWritingSkill: { name: 'two', enabled: false } })
  document = applyTavernSettingsPatch(document, { defaultWritingSkill: { name: 'one', enabled: false } })
  assert.deepEqual(presentTavernSettings(document, {}).defaultDisabledWritingSkills, ['one', 'two'])
  document = applyTavernSettingsPatch(document, { defaultWritingSkill: { name: 'one', enabled: true } })
  assert.deepEqual(document.defaultDisabledWritingSkills, ['two'])
  assert.throws(() => applyTavernSettingsPatch(document, { defaultWritingSkill: { name: 'one', enabled: 'false' } }), /无效/)
})

test('候选项默认填入后隐藏，保存后持久化且不覆盖其他设置', async t => {
  const h = await settingsHarness(t)
  assert.equal((await h.read()).candidateDismissMode, 'after-fill')
  await h.update({ systemAppendEnabled: true, candidateDismissMode: 'after-send' })
  assert.equal((await h.read()).candidateDismissMode, 'after-send')
  await h.update({ candidateDismissMode: 'after-fill' })
  assert.equal((await h.read()).candidateDismissMode, 'after-fill')
  assert.equal((await h.read()).systemAppendEnabled, true)
  await assert.rejects(h.update({ candidateDismissMode: 'invalid' }), /无效的候选项/)
  assert.equal((await h.read()).candidateDismissMode, 'after-fill')
})

test('全局隐藏注入与思考设置可持久化和恢复，不改动其他配置', async t => {
  const h = await settingsHarness(t)
  assert.equal((await h.read()).hideContextAndReasoning, false)
  await h.update({ hideContextAndReasoning: true, candidateDismissMode: 'after-send' })
  assert.equal((await h.read()).hideContextAndReasoning, true)
  await h.update({ hideContextAndReasoning: false })
  assert.equal((await h.read()).hideContextAndReasoning, false)
  assert.equal((await h.read()).candidateDismissMode, 'after-send')
  await assert.rejects(h.update({ hideContextAndReasoning: 'true' }), /无效的对话显示设置/)
})

test('global play defaults merge individual switches without losing other defaults', () => {
  let saved = applyTavernSettingsPatch({}, { defaultPlaySettings: { playerName: '玩家', statusBarPlacement: 'body', backgroundTasks: { variables: false }, webSearchEnabled: true } })
  saved = applyTavernSettingsPatch(saved, { defaultPlaySettings: { backgroundTasks: { posture: false }, sceneImagesEnabled: true } })
  const defaults = presentTavernSettings(saved, {}).defaultPlaySettings
  assert.equal(defaults.playerName, '玩家')
  assert.equal(defaults.statusBarPlacement, 'body')
  assert.equal(defaults.backgroundTasks.variables, false)
  assert.equal(defaults.backgroundTasks.posture, false)
  assert.equal(defaults.webSearchEnabled, true)
  assert.equal(defaults.sceneImagesEnabled, true)
  assert.throws(() => applyTavernSettingsPatch(saved, { defaultPlaySettings: { webSearchEnabled: 'false' } }))
})

test('silly 入口停用，旧设置不能重新开启', async t => {
  const h = await settingsHarness(t)
  assert.equal((await h.read()).sillyModeEnabled, false)
  await h.profileData.writeJson(h.settingsPath, { sillyModeEnabled: true })
  assert.equal((await h.read()).sillyModeEnabled, false)
  await assert.rejects(h.update({ sillyModeEnabled: true }), /已停用/)
  await assert.rejects(h.update({ compatibilityMode: true }), /已停用/)
  assert.equal((await h.update({ sillyModeEnabled: false })).compatibilityMode, false)
  assert.equal((await h.saved()).sillyModeEnabled, false)
})
