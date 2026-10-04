import test from 'node:test'
import assert from 'node:assert/strict'
import { registerWorldbookTools } from '../tavern-plugin/lib/tools/worldbook.js'

function setup() {
  const registered = new Map(), calls = []
  registerWorldbookTools({
    chatForSession: async () => ({ mode: 'card', cardPath: 'cards/甲.json' }),
    readChatCard: async () => undefined,
    str: value => value == null ? '' : String(value),
    tools: { register: tool => registered.set(tool.name, tool) },
    worldBooks: { update: async (source, request) => { calls.push({ source, request }); return { view: { displayName: '甲', entryCount: 1 } } } }
  })
  const exec = { agent: { session: { id: 's1' } } }
  return { run: args => registered.get('tavern_update_worldbook').execute(args, exec), calls }
}

test('世界书条目字段写错时报错，不静默丢弃关键词', async () => {
  const { run, calls } = setup()
  await assert.rejects(run({ operations: [{ op: 'add', entry: { comment: '时局', content: '1936', keys: ['上海'] } }] }), /不支持字段 keys；关键词请用 primaryKeys/)
  assert.equal(calls.length, 0)
  await run({ operations: [{ op: 'add', entry: { comment: '时局', content: '1936', primaryKeys: ['上海'] } }] })
  assert.deepEqual(calls[0].request.operations[0].entry.primaryKeys, ['上海'])
})
