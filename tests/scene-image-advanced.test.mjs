import test from 'node:test'
import assert from 'node:assert/strict'
import { channelSettings, imageChannelRequest } from '../tavern-plugin/lib/domain/scene-image-channels.js'

import { createImageConfiguration } from '../tavern-plugin/packages/dsh-image-gen/src/configuration.js'

const config = (provider, extras = {}) => ({ ...channelSettings({}, provider), baseURL: 'http://127.0.0.1:9999', apiKey: 'fixture', prompt: 'a quiet garden', ...extras })

test('invalid controls fail before dispatch rather than being silently clamped', () => {
  for (const [provider, patch] of [['novelai', { steps: '51' }], ['webui', { steps: '0' }], ['webui', { steps: '1.5' }], ['webui', { guidance: 'NaN' }], ['novelai', { guidance: '11' }], ['webui', { steps: '1e2' }], ['qwen', { negativePrompt: 'x'.repeat(4001) }]]) {
    assert.throws(() => channelSettings(patch, provider))
  }
})

test('saved controls survive module recreation and channel switches; stale capture never sends a paid request', async () => {
  let saved = {}, calls = []
  const make = () => createImageConfiguration({ read: async () => saved, write: async patch => { saved = { ...saved, ...patch } }, credentials: { resolve: async () => ({ value: 'fixture' }) },
    generateImpl: async input => { calls.push(imageChannelRequest(input).body); return { data: Buffer.from('fixture') } } })
  let service = make()
  await service.configure(config('webui', { steps: '31', guidance: '5.5', negativePrompt: 'blur' }))
  await service.configure(config('qwen', { negativePrompt: 'watermark' }))
  service = make()
  assert.equal((await service.inspect('webui')).steps, '31')
  assert.equal((await service.inspect('qwen')).negativePrompt, 'watermark')
  const { active, apiKey } = await service.capture('webui')
  await service.generate({ ...active, apiKey, prompt: 'first' })
  assert.equal(calls[0].steps, 31)
  await service.configure({ ...active, steps: '35' })
  await assert.rejects(service.generate({ ...active, apiKey, prompt: 'stale' }), error => error.imageOutcome === 'not_requested')
  assert.equal(calls.length, 1)
  const next = await service.capture('webui')
  await service.generate({ ...next.active, apiKey: next.apiKey, prompt: 'redraw' })
  assert.equal(calls[1].steps, 35)
  assert.equal(calls[1].negative_prompt, 'blur')
  await service.configure({ ...next.active, steps: '', guidance: '', negativePrompt: '' })
  const reset = await service.capture('webui')
  await service.generate({ ...reset.active, apiKey: reset.apiKey, prompt: 'default' })
  assert.equal(calls[2].steps, undefined)
})

test('provider dispatch sends advanced controls and preserves them with the returned image', async () => {
  const { generateSceneImage } = await import('../tavern-plugin/lib/domain/scene-image-provider.js')
  const { imageZip } = await import('./fixtures/scene-image-zip.mjs')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKfoAAAAASUVORK5CYII=', 'base64')
  for (const provider of ['novelai', 'webui', 'qwen']) {
    let sent, count = 0
    const result = await generateSceneImage(config(provider, { steps: '28', guidance: '5.5', negativePrompt: 'watermark' }), { fetch: async (_url, init) => {
      count++; sent = JSON.parse(init.body)
      return provider === 'novelai' ? new Response(imageZip(png)) : Response.json(provider === 'webui' ? { images: [png.toString('base64')] } : { output: { choices: [{ message: { content: [{ image: 'data:image/png;base64,' + png.toString('base64') }] } }] } })
    } })
    assert.equal(count, 1)
    assert.deepEqual(result.data, png)
    assert.equal((provider === 'webui' ? sent : sent.parameters).negative_prompt, 'watermark')
    assert.equal(provider === 'novelai' ? result.metadata.request.parameters.steps : result.metadata.generationParameters.negative_prompt, provider === 'novelai' ? 28 : 'watermark')
  }
})
