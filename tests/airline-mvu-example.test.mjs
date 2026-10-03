import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildCard, cardName } from '../examples/airline-mvu/card-source.mjs'
import { createCardPreparation } from '../tavern-plugin/lib/domain/card-preparation.js'
import { inspectCardExtensions } from '../tavern-plugin/lib/domain/card-extension-reading.js'

test('航空 MVU 卡可导入导出，并与可读源保持一致', () => {
  const card = buildCard();
  assert.deepEqual(JSON.parse(readFileSync(new URL('../examples/airline-mvu/card.json', import.meta.url))), card)
  const prep = createCardPreparation({ id: () => 'airline-test', now: () => 1 })
  const workspace = prep.create({ kind: 'import', payload: { kind: 'text', text: JSON.stringify(card) } })
  assert.equal(prep.project(workspace).name, cardName)
  assert.deepEqual(prep.present({ card: workspace, as: 'sillytavern-v3' }).data.character_book, card.data.character_book)
  assert.ok(inspectCardExtensions(card).mvuResources.some(item => item.enabled))
})

test('展示模板只读，动态文字通过 textContent 展示，没有外链和轮询', () => {
  const view = readFileSync(new URL('../examples/airline-mvu/status.html', import.meta.url), 'utf8')
  assert.doesNotMatch(view, /innerHTML|replaceVariables|updateVariablesWith|setInterval|https?:\/\//)
  assert.match(view, /VARIABLE_UPDATE_ENDED/)
  assert.match(view, /Object.values\(tavern_events\)/)
})
