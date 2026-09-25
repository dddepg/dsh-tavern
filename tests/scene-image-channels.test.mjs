import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { generateSceneImage } from '../tavern-plugin/lib/domain/scene-image-provider.js'
import { SCENE_IMAGE_CHANNELS, channelSettings, channelImageResult, imageChannelRequest, imageExpressionProfile } from '../tavern-plugin/lib/domain/scene-image-channels.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKfoAAAAASUVORK5CYII=', 'base64')
test('six cloud protocols dispatch to local HTTP with exact auth/body shapes and image extraction', async t => {
  const seen = []
  let provider, baseURL
  const server = createServer(async (req, res) => {
    if (req.url === '/picture') { assert.equal(req.headers.authorization, undefined); res.end(png); return }
    let text = ''; for await (const part of req) text += part
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(text) })
    const payload = {
      openai: { data: [{ b64_json: png.toString('base64') }] },
      gemini: { steps: [{ type: 'thought', content: [{ type: 'image', data: 'not-an-image' }] }, { type: 'model_output', content: [{ type: 'image', data: png.toString('base64') }] }] },
      banana: { choices: [{ message: { content: '![picture](data:image/png;base64,' + png.toString('base64') + ')' } }] },
      grok: { data: [{ url: baseURL + '/picture' }] },
      seedream: { data: [{ url: baseURL + '/picture' }] },
      qwen: { output: { choices: [{ message: { content: [{ image: baseURL + '/picture' }] } }] } }
    }[provider]
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  baseURL = 'http://127.0.0.1:' + server.address().port
  // The optional plugin uses its own Studio contract, tested separately.
  for (const channel of SCENE_IMAGE_CHANNELS.filter(item => !['webui', 'novelai', 'comfyui', 'dsh-image-gen'].includes(item.id))) {
    provider = channel.id
    const config = channelSettings({}, provider)
    const image = await generateSceneImage({ ...config, model: config.model || 'relay-model', baseURL: baseURL + '/v1', prompt: 'one quiet scene', apiKey: 'fixture-secret' })
    assert.deepEqual(image.data, png)
    const { body, headers, url } = seen.at(-1)
    assert.equal(headers[provider === 'gemini' ? 'x-goog-api-key' : 'authorization'], provider === 'gemini' ? 'fixture-secret' : 'Bearer fixture-secret')
    if (provider === 'gemini') {
      assert.equal(headers.authorization, undefined)
      assert.equal(url, '/v1/interactions')
      assert.deepEqual(body.input, [{ type: 'text', text: 'one quiet scene' }])
      assert.deepEqual(body.response_format, { type: 'image', mime_type: 'image/png', aspect_ratio: '1:1', image_size: '1K' })
    } else if (provider === 'banana') {
      assert.equal(url, '/v1/chat/completions')
      assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'one quiet scene' }] }])
      assert.equal(body.stream, false)
    } else if (provider === 'qwen') {
      assert.equal(url, '/v1/services/aigc/multimodal-generation/generation')
      assert.deepEqual(body.input, { messages: [{ role: 'user', content: [{ text: 'one quiet scene' }] }] })
      assert.deepEqual(body.parameters, { size: '1024*1024', n: 1, prompt_extend: false })
    } else {
      assert.equal(url, '/v1/images/generations')
      assert.equal(body.prompt, 'one quiet scene')
      if (provider === 'grok') { assert.equal(body.resolution, '1k'); assert.equal(body.size, undefined); assert.equal(body.n, 1) }
      if (provider === 'seedream') { assert.equal(body.sequential_image_generation, 'disabled'); assert.equal(body.n, undefined); assert.equal(body.response_format, 'url') }
      if (provider === 'openai') assert.equal(body.n, 1)
    }
  }
  assert.equal(seen.length, 6)
})

test('response extraction ignores prose/thoughts, tolerates malformed responses and rejects unsupported config', () => {
  assert.equal(channelImageResult('gemini', { steps: [{ type: 'thought', content: [{ type: 'image', data: 'x' }] }] }), undefined)
  assert.equal(channelImageResult('gemini', { output_image: { data: 'abc' } }).b64_json, 'abc')
  assert.equal(channelImageResult('qwen', { output: { choices: [{ message: { content: 'text' } }] } }), undefined)
  assert.equal(channelImageResult('banana', { choices: [{ message: { content: 'Please open https://example.com' } }] }), undefined)
  assert.deepEqual(channelImageResult('banana', { choices: [{ message: { images: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] } }] }), { url: 'https://example.com/a.png' })
  assert.throws(() => channelImageResult('qwen', { code: 'failed', message: 'secret' }), error => !error.message.includes('secret'))
  assert.throws(() => channelSettings({}, 'unknown'))
  assert.throws(() => imageChannelRequest({ provider: 'grok', size: '1024x1024', apiKey: 'key' }), /分辨率/)
  assert.throws(() => imageChannelRequest({ provider: 'qwen', model: 'wanx', apiKey: 'key' }), /Qwen/)
  assert.throws(() => imageChannelRequest({ provider: 'banana', apiKey: 'key' }), /配置/)
  assert.notEqual(imageExpressionProfile({ provider: 'openai', model: 'same' }), imageExpressionProfile({ provider: 'banana', model: 'same' }))
})

test('WebUI sends one image request, keeps the server model and handles raw base64 results', async () => {
  for (const authType of ['none', 'basic', 'bearer']) {
    let calls = 0
    const result = await generateSceneImage({ provider: 'webui', baseURL: 'http://localhost:7860/prefix', size: '768x512', prompt: 'window scene', authType, username: 'reader', apiKey: ' secret ' }, { fetch: async (url, init) => {
      calls++
      assert.equal(url, 'http://localhost:7860/prefix/sdapi/v1/txt2img')
      const body = JSON.parse(init.body)
      assert.deepEqual(body, { prompt: 'window scene', width: 768, height: 512, batch_size: 1, n_iter: 1, seed: -1, send_images: true, save_images: false })
      assert.equal(init.headers.authorization, authType === 'none' ? undefined : authType === 'basic' ? 'Basic ' + Buffer.from('reader: secret ').toString('base64') : 'Bearer  secret ')
      return Response.json({ images: [png.toString('base64')], info: '{}' })
    } })
    assert.deepEqual(result.data, png)
    assert.equal(calls, 1)
  }
  const input = { provider: 'webui', baseURL: 'http://localhost:7860' }
  const encoded = await generateSceneImage(input, { fetch: async () => Response.json({ images: ['data:image/png;base64,' + png.toString('base64')] }) })
  assert.deepEqual(encoded.data, png)
  assert.throws(() => channelSettings({ ...input, authType: 'unknown' }), /鉴权/)
  assert.throws(() => channelSettings({ ...input, username: 'name:extra' }), /用户名/)
  for (const size of ['4096x4096', '0x512', '500x500', 'large']) assert.throws(() => channelSettings({ ...input, size }), /尺寸/)
  await assert.rejects(generateSceneImage({ ...input, authType: 'basic', username: 'reader' }), /配置/)
})

test('WebUI keeps only reported model/seed metadata and tolerates missing or malformed info', async () => {
  const call = info => generateSceneImage({ provider: 'webui', baseURL: 'http://localhost:7860' }, { fetch: async () => Response.json({ images: [png.toString('base64')], info }) })
  const image = await call(JSON.stringify({ seed: 123, sd_model_name: 'my-checkpoint', sd_model_hash: 'abcdef12', api_key: 'must-not-copy', prompt: 'full secret input' }))
  assert.deepEqual(image.metadata, { seed: 123, model: 'my-checkpoint', modelHash: 'abcdef12' })
  assert.equal(JSON.stringify(image.metadata).includes('secret'), false)
  assert.equal((await call('invalid json')).metadata, undefined)
  assert.equal((await call(JSON.stringify({ seed: -1 }))).metadata, undefined)
})

test('empty base64 does not hide a usable image URL', async () => {
  for (const b64_json of ['', ' \n\t', null]) {
    const requests = []
    const image = await generateSceneImage({ provider: 'openai', baseURL: 'https://relay.example/v1', model: 'image', prompt: 'fixture', apiKey: 'fixture' }, {
      fetch: async (url) => { requests.push(url); return requests.length === 1 ? Response.json({ data: [{ b64_json, url: 'https://cdn.example/image.png' }] }) : new Response(png) },
      validateDownload: async url => url
    })
    assert.deepEqual(image.data, png)
    assert.equal(requests.length, 2)
    assert.equal(requests[1], 'https://cdn.example/image.png')
  }
})
