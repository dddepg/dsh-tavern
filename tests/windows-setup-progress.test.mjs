import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, copyFile, writeFile, readFile, rm} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {spawn} from 'node:child_process'
import {tmpdir} from 'node:os'
import path from 'node:path'

// Exercise the real bootstrap/child-stream boundary. The installer fixture models
// a slow native command; the forwarding and logging belong to production code.
test('Setup streams installer progress before exit, preserves logs and reports failure', {skip: process.platform === 'win32'}, async t => {
  const root=await mkdtemp(path.join(tmpdir(),'setup-progress-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  await mkdir(path.join(root,'app/lib'),{recursive:true})
  await copyFile(new URL('../packaging/windows/setup-upgrade.mjs',import.meta.url),path.join(root,'setup-upgrade.mjs'))
  await writeFile(path.join(root,'app/lib/desktop-runtime-environment.js'),'exports.installDesktopDshRuntime=()=>{}')
  await writeFile(path.join(root,'desktop-package-manager.mjs'),`export async function prepareDesktopPackageManager(){return {node:${JSON.stringify(process.execPath)},bin:${JSON.stringify(root)}}}`)
  await writeFile(path.join(root,'powershell.exe'),`#!${process.execPath}
process.stdout.write('DSH_STATUS 正在下载运行文件：2/8\\n');
process.stdout.write('Progress: resolved 12, reused 8, downloaded 3, added 4\\n');
process.stderr.write('fixture diagnostic\\n');
setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(path.join(root,'installer-exited'))},'done');process.exit(7)},700);
`,{mode:0o755})
  const child=spawn(process.execPath,[path.join(root,'setup-upgrade.mjs'),path.join(root,'data')],{env:{...process.env,PATH:root+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe']})
  let out='',err='',live=false
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data',chunk=>{out+=chunk;if(out.includes('正在下载运行文件：2/8')&&!existsSync(path.join(root,'installer-exited')))live=true})
  child.stderr.on('data',chunk=>err+=chunk)
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)})
  assert.equal(code,1)
  assert.equal(live,true,'installer progress must reach the window while installation is running')
  assert.match(out,/已下载 3.*复用 8.*已安装 4/)
  assert.match(err,/安装或更新失败/)
  assert.doesNotMatch(out,/安装或更新完成/)
  const log=await readFile(path.join(root,'data/setup-upgrade.log'),'utf8')
  assert.match(log,/fixture diagnostic/)
  assert.match(log,/resolved 12/)
})
