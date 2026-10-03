import assert from 'node:assert/strict'
import test from 'node:test'
import { UpstreamTemplateRuntime } from './fixtures/upstream-template-runtime.mjs'

const runtime = await UpstreamTemplateRuntime.create()

test('上游设置与 Monaco 编辑器实际加载，保存/取消与条目保存使用同一实例', async () => {
  // This panel test must initialize its own settings, independent of earlier lifecycle tests.
  await runtime.panel({settings:{preload_worldinfo_enabled:false},worldBookEntries:[{uid:1301,comment:'编辑样例',content:'原文 <%= 1 %>'}]})
  const page=runtime.page
  const listeners=await page.evaluate(()=>window.testHost.eventSource.count())
  await page.locator('#pt_code_editor').check()
  // Upstream lazy loader registers APP_READY only after Monaco is ready.
  await page.waitForFunction(count=>window.testHost.eventSource.count()>count, listeners, {timeout:20000})
  await page.getByRole('button',{name:'展开编辑',exact:true}).click()
  await page.getByRole('button',{name:'Monaco 编辑',exact:true}).waitFor({state:'visible',timeout:20000})
  await page.getByRole('button',{name:'Monaco 编辑',exact:true}).click()
  await page.locator('.monaco-editor').waitFor({state:'visible'})
  await page.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('取消内容')
  await page.getByRole('button',{name:'取消',exact:true}).click()
  assert.equal(await page.getByRole('textbox',{name:'条目正文',exact:true}).inputValue(),'原文 <%= 1 %>')
  await page.getByRole('button',{name:'Monaco 编辑',exact:true}).click()
  await page.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText('已保存的模板正文')
  await page.getByRole('button',{name:'Save',exact:true}).click()
  assert.equal(await page.getByRole('textbox',{name:'条目正文',exact:true}).inputValue(),'已保存的模板正文')
  await page.getByRole('button',{name:'保存条目',exact:true}).click()
  await page.getByRole('status').filter({hasText:'已保存'}).waitFor()
})

test('显示脚本在真正展示的 frame 执行一次，格式化镜像不执行脚本或事件属性', async () => {
  const content='<p>正文</p><script>window.__visibleCount=(window.__visibleCount||0)+1</script><img src="data:image/png,broken" onerror="window.__imageFired=true">正文'
  const result=await runtime.lifecycle({settings:{preload_worldinfo_enabled:false,raw_message_evaluation_enabled:true},transcript:[{role:'assistant',content}],worldBookEntries:[{uid:1401,comment:'render',constant:true,enabled:false,content:'@@render_before\n前缀'}]})
  const page=runtime.page
  await page.waitForFunction(()=>document.querySelector('#chat img')?.complete)
  assert.equal(await page.evaluate(()=>window.__visibleCount),undefined)
  assert.equal(await page.evaluate(()=>window.__imageFired),undefined)
  const html=result.first.chat[0].template_display.html
  assert.match(html,/onerror=/)
  await page.evaluate(html=>{const frame=document.createElement('iframe');frame.id='visible-test';frame.srcdoc=html;document.body.append(frame)},html)
  await page.waitForFunction(()=>document.querySelector('#visible-test')?.contentWindow.__imageFired===true)
  assert.equal(await page.evaluate(()=>document.querySelector('#visible-test').contentWindow.__visibleCount),1)
  await page.locator('#visible-test').evaluate(frame=>frame.remove())
})

test('新轮次、全局变量与设置变化保留旧展示；编辑只更新对应楼层，回退恢复快照', async () => {
  const source='当时的值 <%= getGlobalVar("hp") %>'
  const states=await runtime.history({globalVariables:{hp:7},settings:{preload_worldinfo_enabled:false,raw_message_evaluation_enabled:false},transcript:[{role:'assistant',content:source}]},[
    {global:{hp:9},append:{role:'assistant',content:source}},
    {global:{hp:11},settings:{render_loader_enabled:false}},
    {edit:{index:1,text:'修改后的值 <%= getGlobalVar("hp") %>'}},
    {restore:{from:0}}
  ])
  assert.match(states[0].chat[0].template_display.html,/当时的值 [\s\S]*7/)
  assert.deepEqual(states[1].chat[0].template_display,states[0].chat[0].template_display)
  assert.match(states[1].chat[1].template_display.html,/当时的值 [\s\S]*9/)
  assert.deepEqual(states[2].chat,states[1].chat)
  assert.deepEqual(states[3].chat[0],states[2].chat[0])
  assert.match(states[3].chat[1].template_display.html,/修改后的值 [\s\S]*11/)
  assert.deepEqual(states[4].chat,states[0].chat)
  const rendered=await runtime.page.evaluate(()=>window.historyRenderCounts)
  assert.equal(rendered[2],rendered[1])
  assert.equal(rendered[4],rendered[3])
  assert.ok(rendered[1]>rendered[0] && rendered[3]>rendered[2])
  // A fresh authoritative snapshot with a saved display must not evaluate it again.
  const reopened=await runtime.lifecycle({globalVariables:{hp:99},settings:{preload_worldinfo_enabled:false,raw_message_evaluation_enabled:false},transcript:states[0].chat.map(row=>({...row,role:'assistant',content:row.mes}))})
  assert.deepEqual(reopened.first.chat[0].template_display,states[0].chat[0].template_display)
})

test('长历史分批同步，每批最多八层，续批不重复执行变量修改', async () => {
  const states = await runtime.history({settings:{preload_worldinfo_enabled:false}, transcript:
    Array.from({length:20},()=>({role:'assistant',content:'<% setMessageVar("count", (getMessageVar("count") || 0) + 1) %>值 <%= getMessageVar("count") %>'}))
  }, [{}, {}, {}])
  const rows = Array.isArray(states) ? states : states.states
  assert.ok(rows)
  assert.deepEqual(rows.map(state => state.chat.filter(row => row.template_rendered).length), [8,16,20,20])
  assert.deepEqual(rows.at(-1).chat.map(row => row.variables[0].count), Array.from({length:20}, (_, i) => i + 1))
  assert.deepEqual(rows[3].chat, rows[2].chat)
  assert.deepEqual(rows[2].chat.slice(0,8), rows[0].chat.slice(0,8))
})
