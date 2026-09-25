import path from 'node:path'
import { spawn } from 'node:child_process'
import { createDurableFilePromotion } from './durable-file-promotion.js'

export function createPocketSettings({ dataRoot, sourceRoot, spawnProcess = spawn, files = createDurableFilePromotion() }) {
  const home = path.resolve(dataRoot, '../../..')
  const manifestPath = path.join(home, 'profiles/tavern/package.json')
  const statusPath = path.join(dataRoot, 'pocket-configuration.json')
  let active, pending = false
  async function read(file) { const bytes = await files.read(file); return bytes ? JSON.parse(bytes.toString()) : {} }
  async function status(includePending = true) {
    const manifest = await read(manifestPath)
    if (manifest.dshTavern?.host !== 'cli') return { supported: false }
    active ??= (manifest.dsh?.profile?.bundles || []).includes('dsh-pocket')
    const progress = await read(statusPath)
    let running = includePending && pending
    if (progress.phase === 'running' && progress.pid) {
      try { process.kill(progress.pid, 0); running = true } catch { /* crashed worker */ }
    }
    return { supported: true, enabled: manifest.dshTavern.cliPocketEnabled === true, active,
      restartRequired: active !== (manifest.dshTavern.cliPocketEnabled === true), running,
      error: progress.phase === 'failed' ? progress.error : progress.phase === 'running' && !running ? '配置进程已退出，请重试应用。' : '' }
  }
  async function save(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Pocket 开关必须为布尔值')
    const current = await status()
    if (!current.supported) throw new Error('此开关仅适用于 CLI 主机')
    if (current.running) throw new Error('正在应用 Pocket 配置，请稍后重试')
    const manifest = await read(manifestPath)
    manifest.dshTavern.cliPocketEnabled = enabled
    await files.write(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    return status()
  }
  async function apply() {
    if (pending) throw new Error('正在应用 Pocket 配置')
    pending = true
    try {
      const current = await status(false)
      if (!current.supported) throw new Error('此开关仅适用于 CLI 主机')
      if (current.running) throw new Error('正在应用 Pocket 配置')
      const child = spawnProcess(process.execPath, [path.join(sourceRoot, 'bin/pocket-reconfigure.mjs')], {
        cwd: sourceRoot, detached: true, windowsHide: true, stdio: 'ignore',
        env: { ...process.env, DSH_TAVERN_RUNTIME_HOST: 'cli', DSH_TAVERN_CLI_HOME: home, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' }
      })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      await files.write(statusPath, JSON.stringify({ phase: 'running', pid: child.pid }))
      child.unref()
      return { ...current, running: true, error: '' }
    } finally { pending = false }
  }
  return { status, save, apply }
}
