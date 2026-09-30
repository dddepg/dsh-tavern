import test from 'node:test'
import assert from 'node:assert/strict'

import { generateSceneImage } from '../tavern-plugin/lib/domain/scene-image-provider.js'
import { channelSettings, imageChannelRequest } from '../tavern-plugin/lib/domain/scene-image-channels.js'
import { novelaiPrompts } from '../tavern-plugin/lib/domain/scene-image-novelai.js'

import { imageZip } from './fixtures/scene-image-zip.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKfoAAAAASUVORK5CYII=', 'base64')
const input = { provider: 'novelai', apiKey: 'fixture-secret', prompt: 'ignored flattened copy' }
const plan = {
  id: 'plan', profile: 'nai-test', people: [{ id: 'a', name: '林', fields: { clothing: { text: 'stale red coat' } } }, { id: 'b', name: '林' }],
  blocks: [
    { owner: 'a', field: 'appearance', tags: 'girl, black hair', text: '黑发' },
    { owner: 'a', field: 'clothing', tags: 'blue coat', text: '蓝衣' },
    { owner: 'a', field: 'position', tags: 'on the left', text: '左侧' },
    { owner: 'b', field: 'appearance', tags: 'boy, silver hair', text: '银发' },
    { owner: 'b', field: 'action', tags: 'sitting', text: '坐下' },
    { owner: 'scene', field: 'composition', tags: '1girl, 1boy, wide shot', text: '双人远景' },
    { owner: 'scene', field: 'environment', tags: 'rainy station', text: '雨中车站' }
  ], style: { tags: 'watercolor' }, prompt: 'unstructured duplicate'
}

test('NovelAI validates size/model and model-specific people limit before any request; repaint uses fresh seeds', () => {
  const original = imageChannelRequest({ ...input, plan })
  const repaint = imageChannelRequest({ ...input, plan })
  assert.ok(Number.isInteger(original.body.parameters.seed) && original.body.parameters.seed >= 0 && original.body.parameters.seed < 2 ** 32)
  // More than one sample avoids depending on a single random collision.
  const seeds = new Set([original.body.parameters.seed, repaint.body.parameters.seed, imageChannelRequest({ ...input, plan }).body.parameters.seed])
  assert.ok(seeds.size > 1)
  const many = { people: Array.from({ length: 7 }, (_, n) => ({ id: String(n) })), blocks: Array.from({ length: 7 }, (_, n) => ({ owner: String(n), tags: 'person ' + n })) }
  assert.throws(() => imageChannelRequest({ ...input, model: 'nai-diffusion-4-5-full', plan: many }), /最多支持 6 人/)
  assert.equal(imageChannelRequest({ ...input, plan: many }).body.parameters.v4_prompt.caption.char_captions.length, 7)
  assert.equal(imageChannelRequest({ ...input, model: 'nai-diffusion-4-5-curated', plan }).body.parameters.scale, 5)
  assert.equal(imageChannelRequest({ ...input, model: 'nai-diffusion-4-full', plan }).body.parameters.scale, 5.5)
  const v3 = imageChannelRequest({ ...input, model: 'nai-diffusion-3', plan }).body
  assert.equal(v3.parameters.v4_prompt, undefined); assert.equal(v3.parameters.sm, false)
  assert.equal(v3.input.split('black hair').length - 1, 1)
  assert.match(v3.input, /silver hair/)
  for (const size of ['100x100', '0x1024', '4096x4096', '2048x2048', 'large']) assert.throws(() => channelSettings({ ...input, size }), /尺寸|面积/)
  assert.throws(() => channelSettings({ ...input, model: 'unknown' }), /模型/)
  assert.throws(() => imageChannelRequest({ ...input, prompt: '' }), /提示词/)
  assert.throws(() => novelaiPrompts({ plan: { people: [], blocks: [{ owner: 'unknown', tags: 'extra' }] } }), /未知/)
})

test('NovelAI rejects HTML/JSON masquerading as ZIP, corrupt images and oversized responses without paid retries', async () => {
  for (const bytes of [Buffer.from('{"message":"fixture-secret"}'), imageZip(Buffer.from('<svg/>'))]) {
    let count = 0
    await assert.rejects(generateSceneImage(input, { fetch: async () => { count++; return new Response(bytes) } }), error => !error.message.includes('fixture-secret') && /ZIP|图片格式/.test(error.message))
    assert.equal(count, 1)
  }
  await assert.rejects(generateSceneImage(input, { fetch: async () => new Response('fixture-secret', { status: 401 }) }), error => error.message.includes('401') && !error.message.includes('fixture-secret'))
  await assert.rejects(generateSceneImage({ ...input, maxBytes: 8 }, { fetch: async () => new Response(imageZip(png)) }), /ZIP|限制/)
  await assert.rejects(generateSceneImage(input, { fetch: async () => new Response('', { headers: { 'content-length': String(1e9) } }) }), /过大/)
})
