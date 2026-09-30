import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserPreferenceProfile } from '../tavern-plugin/lib/domain/user-preference-profile.js'

function memoryStore(initial) {
  let value = initial
  return {
    async readJson() { return structuredClone(value) },
    async updateJson(_path, updater) {
      value = await updater(structuredClone(value))
      return structuredClone(value)
    }
  }
}

test('draft remains separate until the user confirms its exact revision', async function () {
  const profile = createUserPreferenceProfile({ store: memoryStore(), now: () => 100 })
  const draft = await profile.saveDraft({
    rawAnswers: [{ question: '喜欢什么节奏？', answer: '慢热，但不要停滞。' }],
    dimensions: [{ id: 'pacing', label: '节奏', conclusion: '慢热且持续推进', confidence: 'likely', evidence: '用户原话' }],
    summary: '偏好慢热且持续推进。',
    injectionText: '节奏可以慢热，但每轮都应有可感知的推进。'
  })
  assert.equal(draft.hasDraft, true)
  assert.equal(draft.hasConfirmed, false)
  assert.equal(await profile.stableContext(), null)
  await assert.rejects(profile.confirm({ draftRevision: draft.draft.revision, confirmation: '' }), /明确确认/)

  const confirmed = await profile.confirm({ draftRevision: draft.draft.revision, confirmation: '确认保存用户画像' })
  assert.equal(confirmed.hasConfirmed, true)
  assert.equal(confirmed.hasDraft, false)
  assert.match((await profile.stableContext()).text, /每轮都应有可感知的推进/)
})

test('default enablement is profile-wide but remains off until explicitly changed', async function () {
  const profile = createUserPreferenceProfile({ store: memoryStore(), now: () => 100 })
  assert.equal((await profile.read()).defaultEnabled, false)
  await assert.rejects(profile.setDefaultEnabled(true), /尚无已确认/)
  const draft = await profile.saveDraft({ summary: '画像', injectionText: '注入摘要' })
  await profile.confirm({ draftRevision: draft.draft.revision, confirmation: '确认保存用户画像' })
  assert.equal((await profile.setDefaultEnabled(true)).defaultEnabled, true)
  assert.equal((await profile.setDefaultEnabled(false)).defaultEnabled, false)
})

test('legacy literal newline escapes render and inject as real line breaks', async function () {
  const profile = createUserPreferenceProfile({ store: memoryStore({
    spec: 'dsh-tavern.user-preference-profile',
    version: 2,
    revision: 4,
    confirmed: { revision: 4, profileRevision: 4, summary: '第一行\\n第二行', injectionText: '偏好一\\n偏好二' }
  }) })
  const value = await profile.read()
  assert.equal(value.confirmed.summary, '第一行\n第二行')
  assert.match((await profile.stableContext()).text, /偏好一\n偏好二/)
})

test('legacy profile migrates without losing confirmation; named profiles keep independent drafts and defaults', async () => {
  const store = memoryStore({ version: 2, revision: 8, defaultEnabled: true, confirmed: { profileRevision: 8, summary: '旧画像', injectionText: '慢节奏' } })
  const profiles = createUserPreferenceProfile({ store })
  assert.equal((await profiles.read()).profileId, 'default')
  const oldContext = await profiles.stableContext()
  const created = await profiles.manage({ action: 'create', name: '冒险玩家' })
  assert.equal(created.hasConfirmed, false)
  assert.equal(created.defaultEnabled, false)
  const id = created.profileId
  const draft = await profiles.saveDraft({ profileId: id, summary: '快节奏', injectionText: '快节奏' })
  await profiles.manage({ action: 'select', profileId: 'default' })
  await profiles.confirm({ profileId: id, draftRevision: draft.draft.revision, confirmation: '确认保存用户画像' })
  assert.deepEqual(await profiles.stableContext(), oldContext)
  assert.match((await profiles.stableContext(id)).text, /快节奏/)
  assert.equal((await profiles.read('default')).defaultEnabled, true)
  assert.equal((await profiles.read(id)).defaultEnabled, false)
  await profiles.manage({ action: 'rename', profileId: id, name: '冒险' })
  assert.equal((await profiles.read(id)).name, '冒险')
  assert.equal((await createUserPreferenceProfile({ store }).read(id)).name, '冒险')
  await assert.rejects(profiles.manage({ action: 'select', profileId: 'missing' }), /不存在/)
  assert.equal((await profiles.read()).profileId, 'default')
})

test('direct save updates the same profile atomically without confirmation or enabling it', async () => {
  const profile = createUserPreferenceProfile({ store: memoryStore() })
  const first = await profile.save({ summary: '慢热', injectionText: '慢热' })
  assert.equal(first.hasConfirmed, true)
  assert.equal(first.hasDraft, false)
  const second = await profile.save({ summary: '快节奏', injectionText: '快节奏' })
  assert.equal(second.profileId, first.profileId)
  assert.equal(second.profiles.length, 1)
  assert.equal(second.confirmed.summary, '快节奏')
  assert.equal(second.hasDraft, false)
  assert.equal(second.defaultEnabled, false)
})

test('create from guide saves a complete independent preference without changing the default', async () => {
  const profile = createUserPreferenceProfile({ store: memoryStore(), now: () => 100 })
  await profile.save({ content: '原有偏好' })
  await profile.setDefaultEnabled(true)
  const before = await profile.read()
  const saved = await profile.manage({ action: 'create', name: '指导', content: '多用短句\n保留人物心理描写' })
  assert.notEqual(saved.profileId, before.profileId)
  assert.equal(saved.hasConfirmed, true)
  assert.equal(saved.confirmed.injectionText, '多用短句\n保留人物心理描写')
  assert.equal(saved.defaultProfileId, before.defaultProfileId)
  assert.equal((await profile.read(before.profileId)).confirmed.injectionText, '原有偏好')
  const count = saved.profiles.length
  await assert.rejects(profile.manage({ action: 'create', name: '无效指导', content: 'x'.repeat(3001) }), /3000/)
  assert.equal((await profile.read()).profiles.length, count)
})
