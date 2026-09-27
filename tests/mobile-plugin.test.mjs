
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { pathToFileURL } from 'node:url'

test('真实 DSH 可挂载并卸载新版移动端插件，不启动服务或请求模型', { skip: !process.env.DSH_BOOT_MODULE }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tavern-mobile-boot-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = path.join(root, 'host.yml')
  await writeFile(config, `- id: dsh-web-mobile\n  name: ${import.meta.resolve('dsh-web-mobile')}\n`)
  const { boot } = await import(pathToFileURL(process.env.DSH_BOOT_MODULE).href)
  const ctx = await boot('tavern-mobile-test', config)
  await ctx.fiber.dispose()
})
