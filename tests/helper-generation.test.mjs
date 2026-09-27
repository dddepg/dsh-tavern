import test from 'node:test'
import assert from 'node:assert/strict'
import { generateHelperRaw } from '../tavern-plugin/lib/domain/helper-generation.js'

test('人物卡原样 generateRaw 参数独立生成，不隐式注入历史或修改输入', async () => {
  const config = { ordered_prompts: [{ role: 'user', content: '生成测试档案' }], max_chat_history: 25, should_stream: false,
    overrides: { world_info_before: '', world_info_after: '', chat_history: { with_depth_entries: false } } }
  const before = structuredClone(config)
  let request
  const result = await generateHelperRaw(config, { sessionId: 's1', history: [{ role: 'assistant', text: '不要发送的正文' }], callModel: async r => { request = r; return '---\nname: test' } })
  assert.equal(result, '---\nname: test')
  assert.deepEqual(request, { sessionId: 's1', system: '', messages: [{ role: 'user', content: [{ type: 'text', text: '生成测试档案' }] }] })
  assert.deepEqual(config, before)
})

test('不支持的能力明确失败，不发送模型请求', async () => {
  for (const extra of [{ tools: [] }, { custom_api: {} }, { overrides: { char_description: 'x' } }]) {
    await assert.rejects(generateHelperRaw({ ordered_prompts: [{ role: 'user', content: 'x' }], ...extra }, { callModel: () => assert.fail('不应请求') }), /暂不支持/)
  }
})

test('构筑评议的清空覆盖参数仅发送评议正文，不混入角色或历史', async () => {
  const config = { user_input: '请评议当前构筑', should_stream: true, ordered_prompts: ['user_input'], max_chat_history: 0,
    overrides: { world_info_before: '', persona_description: '', char_description: '', char_personality: '', scenario: '',
      world_info_after: '', dialogue_examples: '', chat_history: { with_depth_entries: false, author_note: '', prompts: [] } } }
  let request
  assert.equal(await generateHelperRaw(config, { history: [{ role: 'assistant', text: '不应进入评议的剧情' }],
    callModel: async value => { request = value; return '评分结果' } }), '评分结果')
  assert.deepEqual(request.messages, [{ role: 'user', content: [{ type: 'text', text: '请评议当前构筑' }] }])
  for (const overrides of [{ persona_description: '需要实现的覆盖内容' }, { chat_history: { with_depth_entries: false, author_note: '作者注释' } },
    { chat_history: { with_depth_entries: false, prompts: [{ role: 'user', content: '不可忽略' }] } }]) {
    await assert.rejects(generateHelperRaw({ ...config, overrides }, { callModel: () => assert.fail('不应静默丢弃覆盖内容') }), /暂不支持覆盖项/)
  }
})
