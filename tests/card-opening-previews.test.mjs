import assert from 'node:assert/strict'
import test from 'node:test'

import { projectCardOpeningPreviews } from '../tavern-plugin/lib/domain/card-opening-previews.js'
import { projectOpeningCommit } from '../tavern-plugin/lib/domain/runtime-content-projection.js'

test('预览保留完整界面及 MVU 脚本，不提前初始化游戏或改写资源', async () => {
  const status = '<div id="notice"></div><script>waitGlobalInitialized("Mvu").then(function () { Mvu.getMvuData(); });</script>'
  const ordinary = '<div>普通展示</div><script>window.ordinaryRan = true;</script>'
  const card = { name: '测试卡', first_mes: '<h1>开场正文</h1>\n<status/>\n<ordinary/>' }
  const extensions = { regexScripts: [
    { id: 'status', enabled: true, placement: [2], markdownOnly: true, findRegex: '/<status\\/>/g', replaceString: '```html\n' + status + '\n```' },
    { id: 'ordinary', enabled: true, placement: [2], markdownOnly: true, findRegex: '/<ordinary\\/>/g', replaceString: '```html\n' + ordinary + '\n```' }
  ] }
  const before = structuredClone({ card, extensions })
  const result = await projectCardOpeningPreviews({ card, extensions,
    runtime: { initializeChat() { throw new Error('预览不得初始化游戏') } }
  })
  const opening = result.openings[0]
  assert.equal(opening.helperContext, null)
  assert.equal(opening.text, card.first_mes)
  const preview = opening.projection.parts.map(part => part.content || part.text).join('\n')
  assert.match(preview, /<h1>开场正文<\/h1>/)
  assert.doesNotMatch(preview, /状态栏将在开始游戏后加载|data-dsh-tavern-mvu-preview|<status\/>/)
  assert.match(preview, /waitGlobalInitialized/ )
  assert.match(preview, /Mvu\.getMvuData/)
  assert.match(preview, /window.ordinaryRan = true/)
  const committed = projectOpeningCommit(card.first_mes, { regexScripts: extensions.regexScripts, regexPlacement: 2 })
  assert.match(committed.displayText, /waitGlobalInitialized\("Mvu"\)/)
  assert.doesNotMatch(committed.displayText, /状态栏将在开始游戏后加载/)
  assert.deepEqual({ card, extensions }, before)
})

test('native swipe chooser receives opening bridge metadata without treating prose as a chooser', async () => {
  const card = { name: '选择台', first_mes: '<script>const ctx=SillyTavern.getContext();ctx.swipe.to(null,"right",{forceMesId:0,forceSwipeId:1});</script>', alternate_greetings: ['目标开场'] }
  const result = await projectCardOpeningPreviews({ card })
  assert.ok(result.openings[0].openingPreview)
  assert.equal(result.openings[0].openingPreview.openingIds[1], 'alternate:0')
  const prose = await projectCardOpeningPreviews({ card: { first_mes: 'He swiped his card. The character_menu appeared and he decided to jump.' } })
  assert.equal(prose.openings[0].openingPreview, null)
})
