import { randomInt } from 'node:crypto'

// Verified against NovelAI's public frontend build 6750aa2; see research note.
const models = {
  'nai-diffusion-5-full': { guidance: 7, characters: 22 },
  'nai-diffusion-5-curated': { guidance: 7, characters: 22 },
  'nai-diffusion-4-5-full': { guidance: 5, characters: 6 },
  'nai-diffusion-4-5-curated': { guidance: 5, characters: 6 },
  'nai-diffusion-4-full': { guidance: 5.5, characters: 6 },
  'nai-diffusion-4-curated-preview': { guidance: 5.5, characters: 6 },
  'nai-diffusion-3': { guidance: 5, characters: 0 }
}
export const NOVELAI_MODELS = Object.freeze(Object.keys(models))
// The four caption sections a NovelAI base prompt is assembled from.
export const NOVELAI_BASE_SECTIONS = Object.freeze(['quality', 'scene', 'style', 'artist'])
// Official quality-tag and undesired-content presets, adapted from the MIT-licensed
// Langbai NovelAI Studio v2.4.7 tables (mobile/lib/services/nai_api.dart).
export const NOVELAI_QUALITY_PRESETS = Object.freeze(['none', 'light', 'standard'])
export const NOVELAI_UC_PRESETS = Object.freeze(['none', 'light', 'heavy', 'human-focus'])
const QUALITY_PRESET_TAGS = {
  'nai-diffusion-5-full': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-5-curated': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-full': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-curated': 'very aesthetic, masterpiece, no text, -0.8::feet::, rating:general',
  'nai-diffusion-4-full': 'no text, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-curated': 'rating:general, best quality, very aesthetic, absurdres',
  'nai-diffusion-3': 'best quality, amazing quality, very aesthetic, absurdres'
}
// The V5 frontend offers a lighter quality row instead of the standard one.
const QUALITY_LIGHT_V5_TAGS = 'very aesthetic, amazing quality, no text'
const UC_PRESET_TAGS = {
  'nai-diffusion-4-5-full': {
    heavy: 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
    light: 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page',
    'human-focus': 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy'
  },
  'nai-diffusion-4-5-curated': {
    heavy: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page',
    light: 'blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page',
    'human-focus': 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page'
  },
  'nai-diffusion-4-full': {
    heavy: 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks',
    light: 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing'
  },
  'nai-diffusion-4-curated': {
    heavy: 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts',
    light: 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, dated, signature'
  },
  'nai-diffusion-3': {
    heavy: 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]',
    light: 'lowres, jpeg artifacts, worst quality, watermark, blurry, very displeasing',
    'human-focus': 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract], bad anatomy, bad hands, @_@, mismatched pupils, heart-shaped pupils, glowing eyes'
  }
}
// V5 reuses the V4.5 tables; Tavern stores the pre-release V4 curated id.
const QUALITY_MODEL_ALIASES = { 'nai-diffusion-4-curated-preview': 'nai-diffusion-4-curated' }
const UC_MODEL_ALIASES = { 'nai-diffusion-5-full': 'nai-diffusion-4-5-full', 'nai-diffusion-5-curated': 'nai-diffusion-4-5-curated', 'nai-diffusion-4-curated-preview': 'nai-diffusion-4-curated' }
// Wire indices of NovelAI's own undesired-content selector.
const UC_PRESET_INDEX = { heavy: 0, light: 1, 'human-focus': 2, none: 3 }
// NovelAI drops the official `no text` tag when the prompt already asks for text.
const NOVELAI_TEXT_TAG = /(?:^|[\s,;|])Text\s*:\s*\S/i
const BASE64_IMAGE = /^[A-Za-z0-9+/]+={0,2}$/

export function novelaiSettings(config) {
  if (!Object.hasOwn(models, config.model)) throw new Error('NovelAI 请选择已接入的 V5、V4.5、V4 或 Anime V3 模型')
  const dimensions = config.size.match(/^(\d+)x(\d+)$/)
  // The 2048-per-side ceiling is Tavern's local resource guard, not an API claim.
  if (!dimensions || dimensions.slice(1).some(value => Number(value) < 64 || Number(value) > 2048 || Number(value) % 64)) throw new Error('NovelAI 尺寸须为宽x高；本插件支持每边 64–2048 且为 64 的倍数')
  const [width, height] = dimensions.slice(1).map(Number)
  if (width * height > 3145728) throw new Error('NovelAI 图片面积不能超过 3145728 像素')
  return { ...models[config.model], width, height }
}

/** Join two tag lists, dropping duplicates case-insensitively. An empty right
 * side returns the left side verbatim, so untouched settings keep the exact
 * prompt earlier versions sent. */
function mergeTags(first, second) {
  const left = String(first || ''), right = String(second || '')
  if (!right.trim()) return left
  if (!left.trim()) return right
  const seen = new Set(), parts = []
  for (const segment of [left, right]) for (const part of segment.split(',').map(value => value.trim())) {
    if (part && !seen.has(part.toLowerCase())) { seen.add(part.toLowerCase()); parts.push(part) }
  }
  return parts.join(', ')
}

/** Official quality tags for the selected model and preset, or '' when unused. */
function novelaiQualityTags(config, positivePrompt) {
  const preset = String(config.qualityPreset || 'none').trim().toLowerCase()
  if (preset === 'none') return ''
  const model = String(config.model || '').trim()
  const tags = preset === 'light' && model.startsWith('nai-diffusion-5')
    ? QUALITY_LIGHT_V5_TAGS
    : QUALITY_PRESET_TAGS[QUALITY_MODEL_ALIASES[model] || model] || ''
  if (!tags) return ''
  if (!NOVELAI_TEXT_TAG.test(String(positivePrompt || ''))) return tags
  return tags.split(',').map(tag => tag.trim()).filter(tag => tag && tag.toLowerCase() !== 'no text').join(', ')
}

/** Official undesired-content preset text, or '' when unused. */
function novelaiNegativeTags(config) {
  const preset = String(config.ucPreset || 'none').trim().toLowerCase()
  if (preset === 'none') return ''
  const model = String(config.model || '').trim()
  return UC_PRESET_TAGS[UC_MODEL_ALIASES[model] || model]?.[preset] || ''
}

/** Section order comes from the user only when it is a full, duplicate-free
 * permutation; anything else falls back to the documented default. */
function novelaiPromptOrder(value) {
  const order = String(value || '').split(',').map(section => section.trim()).filter(Boolean)
  const complete = order.length === NOVELAI_BASE_SECTIONS.length && new Set(order).size === order.length && order.every(section => NOVELAI_BASE_SECTIONS.includes(section))
  return complete ? order : [...NOVELAI_BASE_SECTIONS]
}

/** Expand one `{A|B|C}` option per call. Braces without a pipe carry NovelAI
 * weight syntax, so they must reach the API untouched. */
function expandWildcards(text) {
  if (typeof text !== 'string' || !text.includes('{')) return text || ''
  let output = text
  // Bounded: unwrapped weight braces never change, so the loop ends immediately.
  for (let round = 0; round < 64; round++) {
    const expanded = output.replace(/\{([^{}]*)\}/g, function (whole, inner) {
      if (!inner.includes('|')) return whole
      const options = inner.split('|')
      return options[randomInt(0, options.length)]
    })
    if (expanded === output) break
    output = expanded
  }
  return output
}

/** Section weights wrap a whole section. V4 and later take NovelAI's numeric
 * `1.5::tags::` syntax, so every value counts; Anime V3 only has brace
 * emphasis: >1 becomes {{}}, <1 becomes {}. 1 leaves the section unwrapped. */
function applySectionWeight(tags, weight, numeric) {
  const text = String(tags || '').trim()
  if (!text) return ''
  const value = Number(weight)
  if (!Number.isFinite(value) || value === 1) return text
  if (numeric) return value + '::' + text + '::'
  return value > 1 ? '{{' + text + '}}' : '{' + text + '}'
}

/** Positional section weights; a missing or unusable entry means 1. */
function novelaiSectionWeights(value) {
  return String(value || '').split(',').map(weight => weight.trim()).filter(Boolean).slice(0, NOVELAI_BASE_SECTIONS.length).map(weight => /^\d+(\.\d+)?$/.test(weight) && Number(weight) > 0 ? Number(weight) : 1)
}

/** Assemble base_caption from the configured section order, skipping empty
 * sections so an untouched configuration reproduces the previous prompt. The
 * official quality preset is appended to the user's own quality text. */
function assembleBase(sections, config) {
  const order = novelaiPromptOrder(config.promptOrder), weights = novelaiSectionWeights(config.sectionWeights)
  const draft = order.map(name => String(sections[name] || '')).filter(Boolean).join(', ')
  const resolved = { ...sections, quality: mergeTags(sections.quality, novelaiQualityTags(config, draft)) }
  const numeric = Boolean(models[config.model]?.characters)
  return order.map((name, index) => applySectionWeight(expandWildcards(resolved[name]), weights[index], numeric)).filter(Boolean).join(', ')
}

/** Empty means NovelAI's own ordering; only an explicit false keeps model order. */
function novelaiUseOrder(config) {
  const value = String(config.useOrder || '').trim().toLowerCase()
  return value ? value !== 'false' : true
}

/** NovelAI wants raw base64 in `parameters.image`; a `data:` prefix must be
 * stripped and remote URLs are never fetched on the user's behalf. */
function referenceImageBytes(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (!text.startsWith('data:') && /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) throw new Error('图片参考不支持远程地址，请填写 base64 图片数据，可带 data:image/...;base64, 前缀')
  const compact = (text.startsWith('data:') ? text.slice(text.indexOf(',') + 1) : text).replace(/\s+/g, '')
  if (compact.length < 8 || compact.length % 4 || !BASE64_IMAGE.test(compact)) throw new Error('图片参考不是有效的 base64 图片数据')
  return compact
}

/** Image-to-image strength; NovelAI's own default is 0.7. An empty setting must
 * stay empty rather than coercing to 0, which would ignore the reference image. */
function imageStrength(config) {
  const raw = String(config.imageStrength ?? '').trim()
  if (!raw) return 0.7
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.7
}

/** Compile frozen per-person blocks, not current game variables. Image-local
 * adjustments live in blocks; stale person.fields must not override them.
 * Names identify records but aren't repeated as invented visual subjects. */
export function novelaiPrompts(input, config = {}) {
  const plan = input.plan
  if (!plan || !Array.isArray(plan.blocks)) {
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16000) throw new Error('NovelAI 画面提示词为空或过长')
    return { base: assembleBase({ quality: config.qualityTags, scene: input.prompt, artist: config.artistString }, config), characters: [] }
  }
  const people = plan.people || [], ids = new Set(people.map(person => person.id))
  if (ids.size !== people.length || plan.blocks.some(block => block.owner !== 'scene' && !ids.has(block.owner))) throw new Error('NovelAI 人物方案包含重复或未知人物')
  const characters = people.map(person => ({
    id: person.id,
    caption: plan.blocks.filter(block => block.owner === person.id && block.tags).map(block => block.tags).join(', ')
  }))
  if (characters.some(person => !person.caption)) throw new Error('NovelAI 人物方案缺少人物描述')
  const style = plan.styleOverride?.tags ?? plan.style?.tags ?? ''
  const scene = plan.blocks.filter(block => block.owner === 'scene' && block.tags).map(block => block.tags).join(', ')
  const base = assembleBase({ quality: config.qualityTags, scene, style, artist: config.artistString }, config)
  if (!base.trim() && !characters.length) throw new Error('NovelAI 画面提示词为空')
  if (base.length + characters.reduce((sum, person) => sum + person.caption.length, 0) > 16000) throw new Error('NovelAI 组合提示词过长')
  return { base: base || characters.length + ' people', characters }
}

export function novelaiRequest(input, config) {
  const { width, height, guidance, characters: limit } = novelaiSettings(config)
  const prompt = novelaiPrompts(input, config)
  if (limit && prompt.characters.length > limit) throw new Error('当前 NovelAI 模型最多支持 ' + limit + ' 人，请选择 V5 或调整画面')
  const seed = config.seed ? Number(config.seed) : randomInt(0, 0x100000000)
  const negative = mergeTags(config.negativePrompt, novelaiNegativeTags(config))
  const reference = referenceImageBytes(config.referenceImage)
  const captions = prompt.characters.map(person => ({ char_caption: person.caption, centers: [{ x: 0.5, y: 0.5 }] }))
  // Only send the official preset switches when one is actually selected, so an
  // untouched configuration keeps the exact payload earlier versions produced.
  const qualityPreset = String(config.qualityPreset || 'none').trim().toLowerCase(), ucPreset = String(config.ucPreset || 'none').trim().toLowerCase()
  const presets = {
    ...(qualityPreset === 'none' ? {} : { qualityPresetId: qualityPreset, qualityToggle: true, quality_toggle: true, tag_hint_qt: qualityPreset === 'standard' ? 1 : 3 }),
    ...(ucPreset === 'none' ? {} : { uc: negative, ucPreset: UC_PRESET_INDEX[ucPreset], uc_preset: UC_PRESET_INDEX[ucPreset] })
  }
  return {
    input: limit ? prompt.base : [prompt.base, ...prompt.characters.map(person => person.caption)].filter(Boolean).join('\n'),
    model: config.model,
    // Image-to-image travels in `parameters`, never inside `v4_prompt`; the
    // noise seed derives from the chosen seed so a fixed seed stays reproducible.
    action: reference ? 'img2img' : 'generate',
    parameters: {
      params_version: 4, width, height, scale: config.guidance ? Number(config.guidance) : guidance, steps: config.steps ? Number(config.steps) : 23,
      sampler: 'k_euler_ancestral', noise_schedule: 'karras', n_samples: 1, seed,
      negative_prompt: negative, cfg_rescale: 0, dynamic_thresholding: false, legacy: false, legacy_v3_extend: false,
      deliberate_euler_ancestral_bug: false, prefer_brownian: true,
      ...presets,
      ...(reference ? { image: reference, strength: imageStrength(config), noise: 0, extra_noise_seed: Math.max(0, seed - 1) } : {}),
      ...(limit ? {
        use_coords: false, legacy_uc: false,
        v4_prompt: { caption: { base_caption: prompt.base, char_captions: captions }, use_coords: false, use_order: novelaiUseOrder(config) },
        v4_negative_prompt: { caption: { base_caption: negative, char_captions: captions.map(() => ({ char_caption: '', centers: [{ x: 0.5, y: 0.5 }] })) }, legacy_uc: false }
      } : { sm: false, sm_dyn: false })
    }
  }
}
