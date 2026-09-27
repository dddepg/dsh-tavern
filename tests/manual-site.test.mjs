import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { renderSite, markdown, escapeHTML } from '../docs/manual/build.mjs'

import { installCommands } from '../docs/manual/introduction.mjs'
import { adaptedDshVersion } from '../bin/dsh-compatibility.mjs'
import { screenshots, pageScreenshots, screenshotSource } from '../docs/manual/screenshots.mjs'
import { demoDownloads } from '../examples/manual-demo/downloads.mjs'

const root = new URL('../docs/', import.meta.url)
const inventory = await readFile(new URL('feature-inventory.md', root), 'utf8')
const html = await readFile(new URL('index.html', root), 'utf8')
const sandbox = {}
vm.runInNewContext(await readFile(new URL('assets/manual-state.js', root), 'utf8'), sandbox)
const { resolveRoute, searchPages } = sandbox.DshManualState
const pages = [...html.matchAll(/<article class="doc-page" id="([^"]+)" data-group="([^"]+)" data-title="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)].map(([, id, group, title, body]) => ({ id, group, title, text: body.replace(/<[^>]+>/g, ' '), body }))
const routeIds = [...html.matchAll(/<article class="doc-page" id="([^"]+)"/g)].map(m => m[1])

test('生成结果与文字源一致，避免修改源后忘记重新生成', () => {
  assert.equal(html, renderSite(inventory))
})

test('安装页提供与完整安装说明一致的可复制命令、当前适配版本和各平台步骤', async () => {
  const installationGuide = await readFile(new URL('installation.md', root), 'utf8')
  const install = pages.find(p => p.id === 'a02').body
  for (const command of Object.values(installCommands)) {
    assert.ok(installationGuide.includes(command), 'Installation command must match installation guide')
    assert.ok(install.includes(`<code>${escapeHTML(command)}</code>`), 'Commands must remain literal text')
  }
  for (const term of ['Windows 一键安装（仅 Windows x64）', 'DSH Desktop 安装（Windows / macOS）', '命令行版（Windows / macOS / Linux / WSL2）', '打开 DSH 终端', '当前目录（直接回车选这一项）', 'DSH_TAVERN_CLI_HOME', '配置模型并开始第一局', '关机后如何重新打开', '更新与重新安装', 'Android：通过 DSHA 安装', '安装失败时', adaptedDshVersion]) assert.ok(install.includes(term), term)
  assert.match(install, /class="copy-code"/)
  assert.match(install, /不要分享给别人/)
  assert.doesNotMatch(install, /\{\{dshVersion\}\}|```/)
})

test('Android 公开安装命令固定引导脚本版本，避免 jsDelivr main 缓存倒退', async () => {
  const installationGuide = await readFile(new URL('installation.md', root), 'utf8')
  const androidGuide = await readFile(new URL('android-install.md', root), 'utf8')
  for (const content of [installationGuide, androidGuide, installCommands.android]) {
    assert.match(content, /cdn\.jsdelivr\.net\/gh\/flizzywine\/dsh-tavern@[0-9a-f]{7,40}\/android\/setup\.sh/)
    assert.doesNotMatch(content, /dsh-tavern@main\/android\/setup\.sh/)
  }
})

test('Android 公开安装命令不依赖 DSHA rc1 未提供的 curl', () => {
  assert.match(installCommands.android, /^node -e /)
  assert.doesNotMatch(installCommands.android, /请运行|告诉我结果/)
  assert.match(installCommands.android, /node -e/)
  assert.doesNotMatch(installCommands.android, /\bcurl\b/)
})

test('代码块保持命令原文，转义 HTML 且不误识别管道和 Markdown', () => {
  const command = "echo '<script>**raw**</script>' | next --arg='a&b'\n# heading"
  const rendered = markdown('```bash\n' + command + '\n```', 'test')
  assert.ok(rendered.includes(`<code>${escapeHTML(command)}</code>`))
  assert.doesNotMatch(rendered, /<script>|<strong>|<table>|<h2/)
})

test('文档只采用独立样例截图，不复用旧图片或加载远程脚本', () => {
  assert.doesNotMatch(html, /<picture\b|<video\b|images\/readme\//)
  const frames = [...html.matchAll(/<iframe\b[^>]*>/g)].map(match => match[0])
  assert.equal(frames.length, 1)
  assert.match(frames[0], /src="https:\/\/player\.bilibili\.com\/player\.html\?/)
  assert.match(frames[0], /bvid=BV1NAeq6iELC/)
  assert.match(frames[0], /autoplay=0/)
  assert.match(frames[0], /title="[^"]+"/)
  assert.doesNotMatch(html, /<script[^>]+src="https?:/)
  assert.ok(!/预设库（实验性）|保证永不失忆/.test(html))
  assert.match(pages.find(p => p.id === 'd11').body, /已停用/)
  assert.doesNotMatch(html, /截图将在内容定稿后补充|暂不使用旧版截图/)
  assert.match(html, /界面截图均使用公开样例/)
})

test('截图有有效本地资源、替代文字、说明、来源与放大入口', async () => {
  const expected = Object.values(pageScreenshots).flat().length
  assert.equal((html.match(/<figure class="manual-screenshot">/g) || []).length, expected)
  assert.equal((html.match(/<img /g) || []).length, expected)
  for (const [id, keys] of Object.entries(pageScreenshots)) {
    const body = pages.find(p => p.id === id)?.body
    assert.ok(body, id)
    if (!keys.length) continue
    const source = screenshots[keys[0]].source || screenshotSource
    assert.ok(body.includes(source.label))
    assert.ok(body.includes(source.runtime))
    for (const key of keys) {
      const shot = screenshots[key]
      assert.ok(shot?.alt && shot?.caption, key)
      const src = `images/manual/${shot.file}`
      assert.ok(body.includes(`href="${src}" target="_blank" rel="noopener noreferrer"`))
      assert.ok(body.includes(`src="${src}" alt="${escapeHTML(shot.alt)}" width="${shot.width || 1309}" height="${shot.height || 707}" loading="lazy"`))
      const bytes = await readFile(new URL(src, root))
      assert.ok(bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) || bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), `${src} must be JPEG or PNG`)
      assert.ok(bytes.length > 1000)
    }
  }
  const provenance = await readFile(new URL('../examples/manual-demo/README.md', import.meta.url), 'utf8')
  assert.match(provenance, /CC0/)
  assert.match(provenance, /独立 DSH Profile/)
})

test('网页公开样例下载与原创源数据一致，人物卡没有远程脚本依赖', async () => {
  for (const [name, source] of Object.entries(demoDownloads)) {
    assert.equal(await readFile(new URL(`examples/manual-demo/${name}`, root), 'utf8'), source)
  }
  const card = JSON.parse(demoDownloads['lighthouse-card.json'])
  assert.equal(card.spec, 'chara_card_v3')
  assert.deepEqual(card.data.extensions.tavern_helper.scripts, [])
  assert.doesNotMatch(demoDownloads['lighthouse-card.json'], /https?:\/\/|\/Users\//)
  assert.match(demoDownloads['README.txt'], /CC0/)
})

test('Android 公开安装入口不再标为实验性，并保留平台要求', async () => {
  for (const path of ['../README.md', 'product.html', 'android-install.md', 'manual/introduction.mjs', 'manual/topics.mjs', 'feature-inventory.md', 'index.html', 'installation.md', 'features.txt', '../android/README.md']) {
    const content = await readFile(new URL(path, root), 'utf8')
    assert.doesNotMatch(content, /Android[^\n。<]*实验性|属于实验性支持|不保证一定可用/, path)
  }
  const install = pages.find(p => p.id === 'a02').body
  assert.match(install, /Android：通过 DSHA 安装/)
  assert.match(install, /Android 11[^。<]*ARM64/)
  assert.match(install, /允许 DSHA 后台运行/)
})

test('所有静态资源、文章与页内锚点存在，支持 GitHub Pages 子目录', async () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1])
  assert.equal(new Set(ids).size, ids.length)
  for (const [, value] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    if (value.startsWith('https://')) continue
    assert.ok(!value.startsWith('/'), value)
    if (value.startsWith('#')) assert.ok(ids.includes(value.slice(1)), value)
    else await access(new URL(value, root))
  }
})

test('深链接、旧入口、非法和不存在的地址都有确定结果', () => {
  assert.equal(resolveRoute('#b07', routeIds).id, 'b07')
  assert.equal(resolveRoute('#b07--section-2', routeIds).target, 'b07--section-2')
  assert.equal(resolveRoute('#b07--section-2', routeIds).id, 'b07')
  assert.equal(resolveRoute('#features', routeIds).id, 'index')
  assert.equal(resolveRoute('#create', routeIds).id, 'cards')
  assert.equal(resolveRoute('#%E0%A4%A', routeIds).id, 'not-found')
  assert.equal(resolveRoute('#unknown', routeIds).id, 'not-found')
})

test('关闭 JavaScript 后所有正文仍可顺序阅读', () => {
  for (const page of pages) assert.ok(page.text.length > 100, page.id)
  assert.doesNotMatch(html, /<article[^>]*\bhidden\b/)
  assert.match(html, /<noscript>/)
  assert.match(html, /href="#main">跳到正文/)
})

test('Markdown 转换转义原始 HTML，只允许安全链接，生成语义表格', () => {
  const result = markdown('## 标题\n\n<script>alert(1)</script>\n\n[不安全](javascript:alert)\n\n[文档](#play)\n\n| 名称 | 说明 |\n| --- | --- |\n| 内容 | 正文 |', 'test')
  assert.doesNotMatch(result, /<script>|href="javascript:/)
  assert.match(result, /&lt;script&gt;/)
  assert.match(result, /href="#play"/)
  assert.match(result, /<th scope="col">名称/)
})
