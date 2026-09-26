import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// dsh-dream-skin 9.23 reads this host state before seeding its bundled image.
// Its state is DSH_HOME-wide, not per browser. Only seed a NEW state file:
// existing state (including an explicit clear) always belongs to the user.
export function ensureTavernThemeDefaults(home = process.env.DSH_HOME || path.join(homedir(), '.dsh')) {
  const defaults = {
    // Empty image on first launch; selecting a skin may attach its gradient.
    'dsh-dream-skin:wallpaper-kind': 'image',
    'dsh-dream-skin:wallpaper': null,
    'dsh-dream-skin:wallpaper-url': null,
    'dsh-dream-skin:wallpaper-gradient': null,
    'dsh-dream-skin:wallpaper-follows-skin': '0',
    'dsh-dream-skin:wallpaper-refresh': JSON.stringify({ on: false }),
  }
  mkdirSync(home, { recursive: true })
  try {
    writeFileSync(path.join(home, 'dream-skin.json'), JSON.stringify(defaults), { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
}
