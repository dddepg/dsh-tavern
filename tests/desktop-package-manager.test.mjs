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
