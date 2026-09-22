// Boot a temporary DSH 0.1.5-rc.2 profile and finish one tavern round
// with the paid deepseek-official model. Does not write ~/.dsh.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createServer } from 'node:net'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const hostPrefix = process.env.TAVERN_DSH_015_HOST || '/tmp/tavern-dsh-015-host'
const pluginDeps = process.env.TAVERN_PLUGIN_DEPS || '/tmp/tavern-plugin-deps'
const provider = 'deepseek-official'
const model = 'deepseek-v4-flash'
const reasoningEffort = 'high'

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
  })
}

async function ensureLink(target, path) {
  await rm(path, { recursive: true, force: true })
  await symlink(target, path)
}

function redact(text) {
  return String(text || '').replace(/https?:\/\/\S+/g, '[url]').replace(/token=[^\s&"']+/g, 'token=[redacted]').replace(/sk-[A-Za-z0-9_-]+/g, '[key]')
}

async function main() {
  const require = createRequire(join(hostPrefix, 'package.json'))
  const sessionPackage = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8'))
  if (sessionPackage.version !== '0.1.5-rc.2') throw new Error('宿主 Session 不是 0.1.5-rc.2：' + sessionPackage.version)
  const home = await mkdtemp(join(tmpdir(), 'tavern-game-015-'))
  const profile = join(home, 'profiles', 'tavern')
  const pluginModules = join(repo, 'tavern-plugin', 'node_modules')
  const port = await freePort()
  const report = { result: 'failed', host: sessionPackage.version, stages: {} }
  let child
  try {
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-tavern', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-tavern-plugin', 'dsh-tavern-remote'] } }
    }, null, 2))
    await writeFile(join(profile, 'cordis.yml'), '# temporary game profile\n[]\n')
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
    await ensureLink(join(repo, 'tavern-plugin'), join(profile, 'node_modules', 'dsh-tavern-plugin'))
    await ensureLink(join(repo, 'tavern-plugin', 'packages', 'dsh-tavern-remote'), join(profile, 'node_modules', 'dsh-tavern-remote'))
    await mkdir(pluginModules, { recursive: true })
    await ensureLink(join(hostPrefix, 'node_modules', '@deepseek-ai'), join(pluginModules, '@deepseek-ai'))
    const cardDir = join(home, 'profile-data', 'tavern', 'data', 'resources', 'cards')
    await mkdir(cardDir, { recursive: true })
    await writeFile(join(cardDir, 'lighthouse.json'), JSON.stringify({
      spec: 'chara_card_v2', spec_version: '2.0',
      data: {
        name: '灯塔', description: '雨夜的灯塔小镇。', personality: '', scenario: '',
        first_mes: '雨下了整夜。', mes_example: '', system_prompt: '只写短正文。',
        post_history_instructions: '', creator_notes: '', creator: '', character_version: ''
      }
    }))
    const selection = { provider, model, reasoningEffort }
    await writeFile(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: ' + provider + '\n  model: ' + model + '\n  reasoningEffort: ' + reasoningEffort + '\n')
    await mkdir(join(home, 'profile-data', 'tavern', 'data'), { recursive: true })
    await writeFile(join(home, 'profile-data', 'tavern', 'data', 'tavern-settings.json'), JSON.stringify({
      defaultForegroundModel: selection, defaultBackgroundModel: selection, backgroundTasks: { posture: true, variables: false }
    }))
    const bin = require.resolve('@deepseek-ai/dsh/lib/bin.js')
    child = spawn(process.execPath, [bin, '--profile', 'tavern', '--', '--no-open', '--port', String(port)], {
      env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const started = Date.now()
    let url
    while (Date.now() - started < 90000) {
      if (child.exitCode !== null) break
      const match = output.match(/https?:\/\/127\.0\.0\.1:\d+\/[^\s]+/)
      if (match) { url = match[0]; break }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    if (!url) throw new Error('酒馆没有在临时 Profile 里启动：' + redact(output).slice(-2000))
    console.error('已启动')
    const origin = new URL(url).origin
    const opened = await fetch(url, { redirect: 'manual' })
    const cookie = opened.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    await opened.body?.cancel()
    async function call(method, args = {}) {
      const response = await fetch(origin + '/api/dsh-tavern/' + method, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie, origin },
        body: JSON.stringify(args)
      })
      const text = await response.text()
      let body
      try { body = JSON.parse(text) } catch { body = { ok: false, error: text.slice(0, 500) } }
      if (!response.ok || body.ok === false) throw new Error(method + ' 失败：' + (body.error || response.status))
      if (body.error) throw new Error(method + ' 失败：' + body.error)
      return body
    }
    const patchStatus = await call('getSessionPatchStatus')
    report.stages.patch = { status: patchStatus.patch?.status, serverReady: patchStatus.patch?.serverReady === true }
    if (patchStatus.patch?.serverReady !== true) throw new Error('会话补丁没有就绪：' + (patchStatus.patch?.reason || patchStatus.patch?.status))
    console.error('补丁就绪')
    const client = await call('getSessionPatchClient')
    const evaluated = evaluateClient(client.source)
    if (!evaluated?.SessionEventStream?.prototype?.readPage) throw new Error('客户端历史补丁没有导出读取方法')
    const confirmed = await call('confirmSessionPatch', { protocol: 1, installed: true })
    report.stages.handshake = { clientReady: confirmed.patch?.clientReady === true, ready: confirmed.patch?.ready === true }
    if (confirmed.patch?.ready !== true) throw new Error('握手后正文替换仍不可用：' + (confirmed.patch?.reason || ''))
    const created = await call('gameplay.create', { sourceCard: 'lighthouse.json', mode: 'story', model: { provider, model, reasoningEffort }, userName: '玩家' })
    const sessionId = created.sessionId
    const chatId = created.chat?.id
    report.stages.opening = { greeting: created.chat?.messages?.find(message => message.greeting)?.text || '' }
    console.error('开场已创建')
    await waitUntilIdle(call, sessionId)
    console.error('开场结算完成')
    const sent = await call('gameplay.send', { sessionId, input: '我推开门。' })
    console.error('已发送', sent.accepted === true)
    const finished = await waitForRound(call, sessionId)
    const reply = finished.chat.messages.filter(message => message.role === 'assistant' && message.greeting !== true).at(-1)
    report.stages.round = { model: provider + '/' + model, text: reply?.text || '', settleStatus: finished.chat.settleStatus || 'idle', settleError: finished.chat.settleError || null }
    if (!reply?.text) throw new Error('这一轮没有生成正文')
    console.error('正文已返回')
    if (finished.chat.settleError) throw new Error('结算失败：' + finished.chat.settleError)
    const edit = await call('getBodyEdit', { sessionId })
    await call('saveBodyEdit', { sessionId, token: edit.edit.token, texts: ['雨停了，门里有一盏灯。'] })
    const editedState = await call('gameplay.state', { sessionId })
    const edited = editedState.chat.messages.filter(message => message.role === 'assistant' && message.greeting !== true).at(-1)
    report.stages.edit = { text: edited?.text || '' }
    if (!String(edited?.text || '').includes('门里有一盏灯')) throw new Error('正文编辑没有写回')
    await call('regenBody', { sessionId, chatId, guidance: '' })
    const regeneratedState = await waitForDifferentReply(call, sessionId, edited.text)
    const regenText = regeneratedState.chat.messages.filter(message => message.role === 'assistant' && message.greeting !== true).at(-1)?.text || ''
    report.stages.regenerate = { text: regenText }
    if (!regenText || regenText === edited.text) throw new Error('重新生成没有换正文')
    const turn = regeneratedState.chat.messages.filter(message => message.role === 'assistant' && message.greeting !== true).at(-1)?.turn
    await call('rollbackTurn', { sessionId, chatId, expectedTurn: turn })
    const rolled = await call('gameplay.state', { sessionId })
    const after = rolled.chat.messages.filter(message => message.role === 'assistant' && message.greeting !== true)
    report.stages.rollback = { remainingReplies: after.length }
    if (after.length !== 0) throw new Error('回退后这一轮正文还在')
    report.result = 'passed'
  } catch (error) {
    report.error = redact(error && error.stack || error)
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM')
    await rm(join(pluginModules, '@deepseek-ai'), { force: true }).catch(() => {})
    report.homeRemoved = true
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
  const destination = join(repo, 'scripts', 'experiments', 'host-game-round-result.json')
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ result: report.result, stages: report.stages, error: report.error || '' }))
  if (report.result !== 'passed') process.exitCode = 1
}

function evaluateClient(source) {
  let exports
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load({ factory }) {
    exports = factory(name => name === '@deepseek-ai/cordis' ? { Service: class {} } : name === '@deepseek-ai/dsh-api-gateway/client' ? { RemoteJournalStream: class {} } : {})
  } } } })
  return exports
}

async function waitUntilIdle(call, sessionId) {
  const deadline = Date.now() + 360000
  let latest
  while (Date.now() < deadline) {
    latest = await call('gameplay.state', { sessionId })
    const busy = latest.activity?.busy === true || ['pending', 'running'].includes(latest.chat?.settleStatus)
    if (!busy) return latest
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('开场结算没有完成：' + JSON.stringify({ settleStatus: latest?.chat?.settleStatus, settleError: latest?.chat?.settleError }))
}

async function waitForDifferentReply(call, sessionId, previous) {
  const deadline = Date.now() + 360000
  let latest
  while (Date.now() < deadline) {
    latest = await call('gameplay.state', { sessionId })
    const reply = latest.chat?.messages?.filter(message => message.role === 'assistant' && message.greeting !== true).at(-1)
    const busy = latest.activity?.busy === true || ['pending', 'running'].includes(latest.chat?.settleStatus)
    if (reply?.text && reply.text !== previous && !busy) return latest
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('重新生成没有完成：' + JSON.stringify({ settleStatus: latest?.chat?.settleStatus, settleError: latest?.chat?.settleError }))
}

async function waitForRound(call, sessionId) {
  const started = Date.now()
  const deadline = started + 360000
  let latest
  while (Date.now() < deadline) {
    latest = await call('gameplay.state', { sessionId })
    const chat = latest.chat
    const reply = chat?.messages?.some(message => message.role === 'assistant' && message.greeting !== true && message.text)
    const busy = latest.activity?.busy === true || ['pending', 'running'].includes(chat?.settleStatus)
    if (reply && !busy) return latest
    if (!busy && Date.now() - started > 20000 && !reply) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  const messages = (latest?.chat?.messages || []).map(message => ({
    role: message.role, greeting: message.greeting === true, turn: message.turn,
    text: String(message.text || '').slice(0, 160)
  }))
  let events = []
  try {
    const native = await call('gameplay.native', { sessionId })
    events = (native.events || []).slice(-8).map(event => event.type + (event.data?.reason ? ':' + JSON.stringify(event.data.reason).slice(0, 180) : ''))
  } catch (error) { events = ['native:' + error.message] }
  throw new Error('一轮游戏没有完成：' + JSON.stringify({ settleStatus: latest?.chat?.settleStatus, settleError: latest?.chat?.settleError, busy: latest?.activity, messages, events }))
}

await main()
