// Boot the installed Desktop dsh web in a throwaway home and compare
// port acceptance with the Tavern-equivalent plugin apply.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

const dshBin = '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js'
const patch = fileURLToPath(new URL('./host-load-order-patch.yml', import.meta.url))

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function hammer(port, hits) {
  const timer = setInterval(() => {
    const started = Date.now()
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api', timeout: 200 }, (res) => {
      hits.push({ ms: started, status: res.statusCode })
      res.resume()
    })
    req.on('timeout', () => req.destroy())
    req.on('error', (error) => hits.push({ ms: started, error: error.code || error.message }))
    req.end()
  }, 20)
  return () => clearInterval(timer)
}

const port = await freePort()
const home = await mkdtemp(join(tmpdir(), 'dsh-load-order-'))
const evidencePath = join(home, 'probe.json')
const logPath = fileURLToPath(new URL('./host-load-order-boot.log', import.meta.url))
mkdirSync(home, { recursive: true })
writeFileSync(logPath, '')
const hits = []
const stopHammer = hammer(port, hits)
const child = spawn(process.execPath, [dshBin, '--profile', 'web', '--patch', patch, '--', '--no-open', '--port', String(port)], {
  env: { ...process.env, DSH_HOME: home, LOAD_ORDER_EVIDENCE: evidencePath },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
const started = Date.now()
const take = (chunk) => {
  output += chunk
  appendFileSync(logPath, chunk)
}
child.stdout.on('data', take)
child.stderr.on('data', take)
const exited = new Promise((resolve) => child.once('exit', (code) => resolve('exit ' + code)))
const probeReady = (async () => {
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const text = await readFile(evidencePath, 'utf8').catch(() => '')
    if (text) return 'probe'
    if (child.exitCode !== null) return 'exit ' + child.exitCode
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return 'timeout'
})()
const outcome = await Promise.race([probeReady, exited])
await new Promise((resolve) => setTimeout(resolve, 300))
stopHammer()
if (child.exitCode === null) child.kill('SIGTERM')
await Promise.race([
  exited,
  new Promise((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve('killed') }, 3000)),
])
const probeText = await readFile(evidencePath, 'utf8').catch(() => '')
const probe = probeText ? JSON.parse(probeText) : null
const urlLine = output.split('\n').find((line) => /https?:\/\/127\.0\.0\.1:\d+/.test(line)) || ''
const accepted = hits.filter((hit) => hit.status)
const refused = hits.filter((hit) => hit.error === 'ECONNREFUSED')
const report = {
  outcome,
  elapsedMs: Date.now() - started,
  home,
  port,
  urlLine: urlLine.trim().replace(/\?token=[^\s]+/, ''),
  probe,
  firstAccepted: accepted[0] || null,
  acceptedBeforeProbe: probe ? accepted.filter((hit) => hit.ms < probe.ms).length : null,
  refusedCount: refused.length,
  acceptedCount: accepted.length,
  statuses: [...new Set(accepted.map((hit) => hit.status))],
}
const reportPath = join(home, 'load-order-report.json')
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
await writeFile(new URL('./host-load-order-result.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (!probe || probe.openHandles !== 0 || probe.writers !== 0 || probe.queryCache !== 0) process.exitCode = 1
