import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { installSkillCatalogSessionScope } from '../tavern-plugin/lib/domain/skill-catalog-session-scope.js'
import { createTavernSkillProvider } from '../tavern-plugin/lib/domain/tavern-skill-provider.js'
const pluginRequire = createRequire(new URL('../tavern-plugin/package.json', import.meta.url))
const hostRequire = createRequire(pluginRequire.resolve('@deepseek-ai/dsh-tools'))
const { SessionSkillCatalog } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-api-session-controller')))
const { scopeChainOf } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-scope')))

function fixture() {
  const standing = {}, live = new Map()
  const catalog = Object.create(SessionSkillCatalog.prototype)
  Object.defineProperty(catalog, 'ctx', { value: { agents: { get: id => live.get(id) }, get: () => ({ standingKeyFor: async () => standing }) } })
  const skill = { name: 'debug-card', path: '/skills/debug-card/SKILL.md', agents: ['card'], userInvocable: true, modelInvocable: true }
  const provider = createTavernSkillProvider({ providers: [{ list: async () => [skill] }], library: { read: async () => skill }, roleFor: async scope => scope?.session?.id === 'card' ? 'card' : 'foreground' })
  return { standing, live, catalog, provider }
}
test('native cold catalog carries session identity and keeps the preset ancestry', async () => {
  const { standing, catalog, provider } = fixture()
  const restore = installSkillCatalogSessionScope(catalog)
  const scope = await catalog.scopeFor('card', 'tavern')
  assert.equal((await provider.list({ scope })).candidates.length, 1)
  assert.ok(scopeChainOf(scope).includes(standing))
  const other = await catalog.scopeFor('story', 'tavern')
  assert.notEqual(scope, other)
  assert.equal((await provider.list({ scope: other })).candidates.length, 0)
  restore()
  assert.equal(await catalog.scopeFor('card', 'tavern'), standing)
})
test('live scope remains native and a cold lookup never starts an agent', async () => {
  const { live, catalog } = fixture()
  const agent = { session: { id: 'card' } }
  live.set('card', agent)
  const restore = installSkillCatalogSessionScope(catalog)
  assert.equal(await catalog.scopeFor('card', 'tavern'), agent)
  restore()
})

test('native skills/list works for concurrent cold card and story sessions and reuses separate keys', async () => {
  const standing = {}, keys = new Map()
  const catalog = Object.create(SessionSkillCatalog.prototype)
  const skill = { name: 'debug-card', path: '/skills/debug-card/SKILL.md', agents: ['card'], userInvocable: true, modelInvocable: true }
  const provider = createTavernSkillProvider({ providers: [{ list: async () => [skill] }], library: { read: async () => skill }, roleFor: async scope => scope?.session?.id === 'card' ? 'card' : 'foreground' })
  const skills = { list: async lookup => {
    keys.set(lookup.scope.session.id, lookup.scope)
    return (await provider.list(lookup)).candidates
  } }
  Object.defineProperty(catalog, 'ctx', { value: {
    agents: { get: () => undefined },
    sessionQuery: { observeSession: async () => ({ header: { cwd: '/workspace' }, projections: { values: { agentPreset: 'tavern' } }, [Symbol.dispose]() {} }) },
    get: name => name === 'skills' ? skills : { standingKeyFor: async () => standing }
  } })
  const restore = installSkillCatalogSessionScope(catalog)
  const [card, story] = await Promise.all([catalog.list({ sessionId: 'card' }), catalog.list({ sessionId: 'story' })])
  assert.deepEqual(card.skills.map(s => s.name), ['debug-card'])
  assert.deepEqual(story.skills, [])
  assert.notEqual(keys.get('card'), keys.get('story'))
  const before = keys.get('card')
  await catalog.list({ sessionId: 'card' })
  assert.equal(keys.get('card'), before)
  restore()
})

test('preset changes replace cold cache identity and installation can be disposed', async () => {
  const { catalog } = fixture()
  const original = catalog.scopeFor
  const restore = installSkillCatalogSessionScope(catalog)
  const first = await catalog.scopeFor('card', 'tavern')
  assert.equal(await catalog.scopeFor('card', 'tavern'), first)
  assert.notEqual(await catalog.scopeFor('card', 'other-preset'), first)
  restore()
  assert.equal(catalog.scopeFor, original)
})
