import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
const start = source.indexOf('async function saveGuidePreference()')
const end = source.indexOf('async function removeGuide(index)', start)

test('saving the current game guides creates one preference with all guides in order', async () => {
  const guides = [{ text: '多用短句' }, { text: '保留心理描写' }]
  const calls = []
  const opened = []
  const save = new Function('view', 'guideBusy', 'setGuideBusy', 'setGuideError', 'rpc', 'props', 'notifyTavernDataChanged', source.slice(start, end) + '; return saveGuidePreference;')(
    { guides }, false, () => {}, error => { if (error) throw new Error(error) },
    async (...args) => calls.push(args), { sessionId: 'game', openStyleTab: id => opened.push(id) }, () => {})
  await save()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].action, 'create')
  assert.equal(calls[0][1].content, '多用短句\n\n保留心理描写')
  assert.deepEqual(guides, [{ text: '多用短句' }, { text: '保留心理描写' }])
  assert.deepEqual(opened, ['dsh-tavern:user-profile'])
})
