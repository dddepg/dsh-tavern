// Detached GUI action: give the HTTP response time to arrive before stopping CLI.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { installProfile } from './profile-installation.mjs'
import { startService } from './service-lifecycle.mjs'
import { DSH_ROOT } from './launcher-environment.mjs'
import { resolveTavernDataRoot } from '../tavern-plugin/lib/domain/tavern-data.js'
import { createDurableFilePromotion } from '../tavern-plugin/lib/durable-file-promotion.js'

export async function reconfigurePocket({ install, start, writeStatus }) {
  try {
    await install()
    await start()
    await writeStatus({ phase: 'completed' })
    return true
  } catch (error) {
    await writeStatus({ phase: 'failed', error: '应用 Pocket 配置失败：' + String(error.message || error).slice(0, 500) })
    // Installation rolls the manifest back on failure; restore access to the GUI.
    try { await start() } catch { /* next normal launch exposes the saved failure */ }
    return false
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const files = createDurableFilePromotion()
  const statusPath = path.join(resolveTavernDataRoot({ dshHome: DSH_ROOT }), 'pocket-configuration.json')
  await setTimeout(1000)
  const ok = await reconfigurePocket({ install: () => installProfile('cli'), start: startService,
    writeStatus: value => files.write(statusPath, JSON.stringify(value)) })
  if (!ok) process.exitCode = 1
}
