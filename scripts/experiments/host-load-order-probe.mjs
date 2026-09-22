// Load-order probe. Inserted with the same critical dependency as Tavern: webServer.
// Records persistence handles at apply. Does not open sessions or write archives.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'

const hostRequire = createRequire('/Applications/DSH Desktop.app/Contents/Resources/app/package.json')

function packageVersion(name) {
  const pkg = JSON.parse(readFileSync(hostRequire.resolve(name + '/package.json'), 'utf8'))
  return { name: pkg.name, version: pkg.version, resolved: hostRequire.resolve(name) }
}

export async function apply(ctx) {
  const persistence = ctx.get('sessionPersistence')
  const query = ctx.get('sessionQuery')
  const webServer = ctx.get('webServer')
  const evidence = {
    event: 'probe-apply',
    ms: Date.now(),
    openHandles: persistence?.tracker?.openHandles?.size ?? null,
    writers: persistence?.tracker?.writers?.size ?? null,
    pending: persistence?.tracker?.pending?.size ?? null,
    queryCache: query?._observations?.cache?.size ?? null,
    listenedPort: webServer?.listenedPort ?? null,
    persistenceRoot: persistence?.root ?? null,
    packages: [
      packageVersion('@deepseek-ai/dsh-session'),
      packageVersion('@deepseek-ai/dsh-session-persistence-jsonl'),
      packageVersion('@deepseek-ai/dsh-session-query'),
      packageVersion('@deepseek-ai/dsh-api-session-controller'),
    ],
  }
  const text = JSON.stringify(evidence)
  writeFileSync(process.env.LOAD_ORDER_EVIDENCE, text)
  process.stderr.write('LOAD_ORDER ' + text + '\n')
}
