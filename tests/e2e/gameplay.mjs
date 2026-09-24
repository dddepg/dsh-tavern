import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir, cp, access } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { createChatJournalStore } from '../../tavern-plugin/lib/domain/chat-journal-store.js'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const runtime = resolve(process.env.TAVERN_E2E_RUNTIME || join(homedir(), '.dsh-tavern/runtime'))
const modules = join(runtime, 'lib/node_modules')
const cli = join(modules, '@deepseek-ai/dsh/lib/bin.js')
const outputBase = resolve(process.env.TAVERN_E2E_OUTPUT || join(source, 'output/e2e-gameplay'))
await mkdir(outputBase, { recursive: true })
const output = await mkdtemp(join(outputBase, 'run-'))
const root = await mkdtemp(join(tmpdir(), 'tavern-e2e-'))
const profile = join(root, 'profiles/tavern'), data = join(root, 'profile-data/tavern/data')
const timeout = Number(process.env.TAVERN_E2E_TIMEOUT_MS) || 30000
const report = { status: 'running', scope: 'real isolated DSH + Tavern + Chromium; fixed model only', steps: [] }
const started = Date.now(), errors = []
let log = '', browser, context, child, page
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function step(name, action) {
  const start = Date.now()
  report.currentStep = name
  await action()
  report.steps.push({ name, ms: Date.now() - start })
  console.log('✓ ' + name)
}
async function savedChat() {
  const ids = await readdir(join(data, 'chats'))
  assert.equal(ids.length, 1, '本次只应创建一局游戏')
  return createChatJournalStore({ dataRoot: data }).read(ids[0])
}
function inspectSaved(chat) {
  const replies = chat.messages.filter(message => message.role === 'assistant' && !message.greeting)
  assert.equal(chat.messages.filter(message => message.role === 'user').length, 1)
  assert.equal(replies.length, 1, '刷新不能重复生成正文')
  const reply = replies[0]
  const variables = Array.isArray(reply.variables) ? reply.variables[reply.swipeId || 0] : reply.variables
  assert.equal(variables.stat_data.gold, 10, '落盘金币必须为 10')
  assert.equal(reply.mvu.receipt.status, 'updated')
  assert.equal(chat.posture, '站在柜台前，收下奖励。')
  return { chatId: chat.id, sessionId: chat.sessionId, userMessages: 1, replies: 1,
    gold: variables.stat_data.gold, receipt: reply.mvu.receipt.status, posture: chat.posture }
}
async function inspectScreen() {
  await page.getByText('你获得了十枚金币。', { exact: false }).filter({ visible: true }).first().waitFor()
  await page.getByText(/变量已更新/).filter({ visible: true }).first().waitFor()
  await page.getByText('酒馆状态', { exact: true }).filter({ visible: true }).first().click()
  await page.frameLocator('.dsh-tavern-status-runtime iframe.dsh-tavern-message-frame')
    .locator('#e2e-gold').filter({ hasText: /^金币：10$/ }).waitFor()
  await page.getByText('站在柜台前，收下奖励。', { exact: true }).filter({ visible: true }).waitFor()
}
try {
  await step('准备独立运行环境', async () => {
    await access(cli).catch(() => { throw Error('找不到 DSH runtime；先安装酒馆，或设置 TAVERN_E2E_RUNTIME。') })
    report.runtimeVersion = JSON.parse(await readFile(join(modules, '@deepseek-ai/dsh/package.json'), 'utf8')).version
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    for (const [name, target] of Object.entries({
      'dsh-tavern-plugin': join(source, 'tavern-plugin'),
      'dsh-tavern-remote': join(source, 'tavern-plugin/packages/dsh-tavern-remote'),
      'dsh-web-mobile': join(source, 'node_modules/dsh-web-mobile')
    })) await symlink(target, join(profile, 'node_modules', name))
    // This package resolves DSH imports relative to its directory, so give it
    // the isolated profile's runtime scope rather than the development scope.
    await cp(join(source, 'node_modules/dsh-better-sidebar'), join(profile, 'node_modules/dsh-better-sidebar'), { recursive: true, dereference: true })
    await symlink(join(modules, '@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai'))
    for (const name of await readdir(join(source, 'node_modules'))) {
      if (name.startsWith('.') || ['@deepseek-ai', 'dsh-tavern-plugin', 'dsh-tavern-remote', 'dsh-web-mobile', 'dsh-better-sidebar'].includes(name)) continue
      await symlink(join(source, 'node_modules', name), join(profile, 'node_modules', name))
    }
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'tavern-e2e', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-web-mobile', 'dsh-better-sidebar', 'dsh-tavern-plugin', 'dsh-tavern-remote'] } } }))
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: agent-default-model\n  config:\n    provider: tavern-e2e\n    model: fixed\n- insert:\n    - id: tavern-e2e-model\n      name: ${JSON.stringify(join(source, 'tests/e2e/model.mjs'))}\n`)
    await mkdir(join(data, 'resources/cards'), { recursive: true })
    // Deliberate continuous DOM updates: a real status card must receive new
    // variables even when it never reaches the frame's DOM-idle threshold.
    const status = '<div id="e2e-gold">金币：加载中</div><script>function refresh(){const v=getAllVariables();document.getElementById("e2e-gold").textContent="金币："+(v.stat_data?.gold??"未初始化")}refresh();setInterval(refresh,200)</script>'
    await writeFile(join(data, 'resources/cards/e2e.json'), JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: {
      name: 'E2E 奖励验收', description: '固定验收角色', first_mes: '欢迎领取奖励。\n\n<StatusPlaceHolderImpl/>',
      mes_example: '', scenario: '', personality: '',
      character_book: { name: '验收初始变量', entries: [{ id: 1, keys: [], comment: '[initvar]初始值', content: 'gold: 0', enabled: true, constant: true, insertion_order: 1 }] },
      extensions: { mvu: {}, regex_scripts: [{ id: 'e2e-status', scriptName: '金币状态', findRegex: '<StatusPlaceHolderImpl/>',
        replaceString: '```html\n' + status + '\n```', placement: [2], markdownOnly: true, disabled: false }] }
    } }))
  })
  await step('启动真实 DSH 与酒馆', async () => {
    // Do not inherit provider credentials or a production profile configuration.
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
    child = spawn(process.execPath, [cli, '--profile', 'tavern', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: source, env: { ...env, DSH_HOME: root, DSH_CWD: root,
        TAVERN_E2E_LLM_MODULE: join(modules, '@deepseek-ai/dsh-llm/lib/index.js'),
        TAVERN_E2E_WRONG_GOLD: process.env.TAVERN_E2E_WRONG_GOLD || '' }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let spawnError
    child.on('error', error => { spawnError = error })
    child.stdout.on('data', chunk => { log += chunk }); child.stderr.on('data', chunk => { log += chunk })
    const deadline = Date.now() + 60000
    let url
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      url = log.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s\u001b]*/)?.[0]
      if (url) break
      if (child.exitCode !== null) throw Error('DSH exited ' + child.exitCode)
      await pause(100)
    }
    assert.ok(url, 'DSH startup timeout')
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    context.setDefaultTimeout(timeout)
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
  })
  await step('通过界面选择角色卡并新开一局', async () => {
    await page.getByRole('button', { name: /选择人物卡.*新开游玩/ }).click()
    await page.getByText('E2E 奖励验收', { exact: true }).first().click()
    await page.getByRole('button', { name: '开始新游戏', exact: true }).click()
    await page.getByRole('textbox', { name: /发消息|Message/ }).waitFor()
    await page.getByText('酒馆状态', { exact: true }).filter({ visible: true }).first().click()
    await page.frameLocator('.dsh-tavern-status-runtime iframe.dsh-tavern-message-frame')
      .locator('#e2e-gold').filter({ hasText: /^金币：0$/ }).waitFor()
  })
  await step('玩一轮，确认正文、金币与人物姿势', async () => {
    const composer = page.getByRole('textbox', { name: /发消息|Message/ })
    await composer.fill('领取任务奖励')
    await composer.press('Enter')
    await inspectScreen()
    report.beforeReload = inspectSaved(await savedChat())
    await page.screenshot({ path: join(output, 'before-reload.png'), fullPage: true })
  })
  await step('刷新后确认同一局、正文和状态均保留', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await inspectScreen()
    report.afterReload = inspectSaved(await savedChat())
    assert.deepEqual(report.afterReload, report.beforeReload)
    assert.deepEqual(errors, [], '浏览器不得出现未捕获异常')
    await page.screenshot({ path: join(output, 'after-reload.png'), fullPage: true })
  })
  report.status = 'passed'
  delete report.currentStep
} catch (error) {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1
  if (page) {
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
    await writeFile(join(output, 'failure.txt'), await page.locator('body').innerText()).catch(() => {})
  }
} finally {
  // Read-only evidence, independent of the status iframe and its UI assertions.
  const chat = await savedChat().catch(() => null)
  if (chat) await writeFile(join(output, 'saved-state.json'), JSON.stringify({ id: chat.id, posture: chat.posture,
    messages: chat.messages.map(message => ({ role: message.role, variables: message.variables, mvu: message.mvu })) }, null, 2))
  await context?.tracing.stop({ path: join(output, 'trace.zip') }).catch(() => {})
  await browser?.close()
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(1000)])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  report.ms = Date.now() - started; report.errors = errors
  await writeFile(join(output, 'server.log'), log.replace(/token=[^\s&]+/g, 'token=REDACTED'))
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  if (process.env.TAVERN_E2E_KEEP === '1') console.log('Temporary home:', root)
  else await rm(root, { recursive: true, force: true })
  console.log(`${report.status}: ${report.ms} ms\nArtifacts: ${output}`)
  if (report.error) console.error(report.error)
}
