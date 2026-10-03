import test from 'node:test'
import assert from 'node:assert/strict'
import { registerCardReadingTools } from '../tavern-plugin/lib/tools/card-reading.js'

test('copy tool declares outputs, checks workbench access and returns image status', async () => {
  let mode = 'story', called = 0
  let tool
  registerCardReadingTools({
    tools: { register(value) { if (value.name === 'tavern_copy_card') tool = value } },
    chatForSession: async () => ({ mode }),
    fileResources: { copyCard: async (path, name) => { called++; return { path: 'cards/' + name + '.json', sourcePath: path, imageCopied: true } } }
  })
  await assert.rejects(tool.execute({ path: 'cards/a.json', name: 'b' }, {}), /工作台/)
  assert.equal(called, 0)
  mode = 'card'
  const result = await tool.execute({ path: 'cards/a.json', name: 'b' }, {})
  assert.equal(result.imageCopied, true)
  assert.equal(result.path, 'cards/b.json')
  assert.equal(JSON.parse(tool.output.render({}, result)[0].text).imageCopied, true)
  assert.equal(tool.isConcurrencySafe(), false)
})
