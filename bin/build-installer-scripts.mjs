#!/usr/bin/env node
// Embeds bin/download.cjs verbatim into install.ps1 and install.sh. The one-line
// installers run before the repository is downloaded, so they cannot import it.
//   node bin/build-installer-scripts.mjs          rewrite the embedded copies
//   node bin/build-installer-scripts.mjs --check  fail when a copy is stale
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const module = readFileSync(new URL('bin/download.cjs', root), 'utf8').replaceAll('\r\n', '\n').replace(/\n+$/, '')
const targets = [
  { file: 'install.ps1', pattern: /(\$DownloadModuleSource = @'\n)[\s\S]*?(\n'@\n)/ },
  { file: 'install.sh', pattern: /(<<'DSH_DOWNLOAD_MODULE'\n)[\s\S]*?(\nDSH_DOWNLOAD_MODULE\n)/ },
]

export function embedDownloadModule(source, pattern) {
  const text = source.replaceAll('\r\n', '\n')
  if (!pattern.test(text)) throw new Error(`embedded download module marker not found: ${pattern}`)
  return text.replace(pattern, (_, start, end) => start + module + end)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check')
  const stale = []
  for (const { file, pattern } of targets) {
    const url = new URL(file, root)
    const current = readFileSync(url, 'utf8')
    const next = embedDownloadModule(current, pattern)
    if (next === current.replaceAll('\r\n', '\n')) continue
    if (check) stale.push(file)
    else { writeFileSync(url, next); console.log(`updated ${file}`) }
  }
  if (stale.length) {
    console.error(`embedded bin/download.cjs is stale in: ${stale.join(', ')}. Run node bin/build-installer-scripts.mjs`)
    process.exitCode = 1
  }
}
