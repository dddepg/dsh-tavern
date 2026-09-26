import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import os from 'node:os';import path from 'node:path'
import {prepareDesktopPackageManager} from '../bin/desktop-package-manager.mjs'
test('CLI and non-Windows Desktop never provision a package runtime',async()=>{
 for(const [host,platform] of [['cli','win32'],['desktop','linux'],['desktop','darwin'],['android','win32']])assert.equal(await prepareDesktopPackageManager({host,platform,fetch(){throw Error('network must not run')}}),null)
})
test('Windows Desktop rejects unverified downloaded executables',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'desktop-package-'))
 try{
 const entry=path.join(home,'pnpm.mjs');await writeFile(entry,'')
 await assert.rejects(prepareDesktopPackageManager({host:'desktop',platform:'win32',arch:'x64',home,entry,fetch:async()=>new Response('not-node')}),/SHA-256/)
 }finally{await rm(home,{recursive:true,force:true})}
})

test('Desktop uses its declared pnpm entry and retries failed downloads with the underlying cause', async () => {
 const home = await mkdtemp(path.join(os.tmpdir(), 'desktop-retry-'))
 try {
  const entry = path.join(home, 'pnpm.mjs'); await writeFile(entry, '')
  let attempts = 0
  const progress = []
  const cause = new Error('connection reset')
  await assert.rejects(prepareDesktopPackageManager({
   host: 'desktop', platform: 'win32', arch: 'x64',
   env: { DSH_HOME: home, DSH_DESKTOP_PNPM_ENTRY: entry, DSH_DESKTOP_APP_EXECUTABLE: path.join(home, 'other-layout', 'Desktop.exe') },
   fetch: async () => { attempts++; throw cause }, onProgress: text => progress.push(text),
  }), error => error.cause === cause && /3/.test(error.message))
  assert.equal(attempts, 3)
  assert.equal(progress.length, 3)
 } finally { await rm(home, { recursive: true, force: true }) }
})

test('detached Desktop update resolves pnpm through linked host dependencies under system Node', async () => {
 const { mkdir, symlink } = await import('node:fs/promises')
 const home = await mkdtemp(path.join(os.tmpdir(), 'desktop-detached-'))
 try {
  const host = path.join(home, 'Desktop', 'resources', 'app.asar.unpacked')
  const agent = path.join(host, 'node_modules', '@deepseek-ai', 'dsh-agent')
  const pnpm = path.join(host, 'node_modules', 'pnpm')
  const plugin = path.join(home, 'tavern-plugin')
  await mkdir(agent, { recursive: true }); await mkdir(path.join(pnpm, 'bin'), { recursive: true })
  await mkdir(path.join(plugin, 'node_modules', '@deepseek-ai'), { recursive: true })
  await writeFile(path.join(agent, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-agent', main: 'index.js' }))
  await writeFile(path.join(agent, 'index.js'), '')
  await writeFile(path.join(pnpm, 'package.json'), JSON.stringify({ name: 'pnpm', bin: { pnpm: 'bin/pnpm.cjs' } }))
  await writeFile(path.join(pnpm, 'bin', 'pnpm.cjs'), '')
  await symlink(agent, path.join(plugin, 'node_modules', '@deepseek-ai', 'dsh-agent'), 'junction')
  let downloads = 0
  await assert.rejects(prepareDesktopPackageManager({
   host: 'desktop', platform: 'win32', arch: 'x64',
   env: { DSH_HOME: home, DSH_TAVERN_HOST_DEPENDENCY_ANCHOR: path.join(plugin, 'lib', 'application-updater.js') },
   fetch: async () => { downloads++; return new Response('not-node') },
  }), /SHA-256/)
  assert.equal(downloads, 1, 'must find the selected Desktop pnpm before provisioning Node')
 } finally { await rm(home, { recursive: true, force: true }) }
})

test('Desktop bootstrap inside asar resolves the unpacked pnpm manifest entry', async () => {
 const { mkdir } = await import('node:fs/promises')
 const home = await mkdtemp(path.join(os.tmpdir(), 'desktop-asar-'))
 try {
  const root = path.join(home, 'resources', 'app.asar.unpacked', 'node_modules', 'pnpm')
  await mkdir(path.join(root, 'bin'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'pnpm', bin: { pnpm: 'bin/pnpm.cjs' } }))
  await writeFile(path.join(root, 'bin', 'pnpm.cjs'), '')
  await assert.rejects(prepareDesktopPackageManager({
   host: 'desktop', platform: 'win32', arch: 'x64',
   env: { DSH_HOME: home, DSH_DESKTOP_DSH_BOOTSTRAP: path.join(home, 'resources', 'app.asar', 'dist', 'bootstrap.cjs') },
   fetch: async () => new Response('not-node'),
  }), /SHA-256/)
 } finally { await rm(home, { recursive: true, force: true }) }
})
