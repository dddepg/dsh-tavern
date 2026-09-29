import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {tmpdir} from 'node:os'
import path from 'node:path'
const execute=promisify(execFile)
test('Windows CDN downloader reuses verified files, overlaps requests, retries failures and rejects corruption',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'tavern-cdn-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const ps=(await readFile(new URL('../install.ps1',import.meta.url),'utf8')).replaceAll('\r\n','\n')
 const helper=ps.match(/WriteAllText\(\$CdnDownloader, @'\n([\s\S]*?)\n'@/)[1]
 await writeFile(path.join(root,'download.cjs'),helper)
 const files=Array.from({length:9},(_,n)=>({path:`文件 ${n}.js`,content:`contents-${n}`}))
 const manifest={revision:'a'.repeat(40),files:files.map(f=>({path:f.path,sha256:createHash('sha256').update(f.content).digest('hex')}))}
 await writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest))
 await mkdir(path.join(root,'installed'))
 await writeFile(path.join(root,'installed',files[0].path),files[0].content)
 const requests=new Map();let active=0,maximum=0,corrupt=false
 const server=createServer((req,res)=>{
  const filename=decodeURIComponent(req.url.split('/').at(-1))
  requests.set(filename,(requests.get(filename)||0)+1)
  active++;maximum=Math.max(active,maximum)
  setTimeout(()=>{active--;if(filename===files[1].path&&requests.get(filename)===1){res.writeHead(503);res.end('retry');return}
   res.end(corrupt?'wrong contents':files.find(f=>f.path===filename)?.content)
  },30)
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(()=>new Promise(resolve=>server.close(resolve)))
 const args=[path.join(root,'download.cjs'),path.join(root,'manifest.json'),`http://127.0.0.1:${server.address().port}/repo`,path.join(root,'downloaded'),path.join(root,'installed')]
 const result=await execute(process.execPath,args)
 assert.ok(maximum>1&&maximum<=6,`bounded parallelism: ${maximum}`)
 assert.equal(requests.get(files[0].path),undefined)
 assert.equal(requests.get(files[1].path),2)
 assert.match(result.stdout,/HTTP 503.*尝试 1\/2/)
 assert.match(result.stdout,/9\/9 文件，复用 1/)
 for(const f of files)assert.equal(await readFile(path.join(root,'downloaded',f.path),'utf8'),f.content)
 corrupt=true
 args[4]=path.join(root,'corrupt')
 await assert.rejects(execute(process.execPath,args),error=>error.code===1&&/校验不符/.test(error.stderr))
 await assert.rejects(readFile(path.join(root,'corrupt',files[1].path)),{code:'ENOENT'})
 assert.equal(await readFile(path.join(root,'installed',files[0].path),'utf8'),files[0].content)
})


test('Windows CDN total budget stops slow successful batches before accepting an incomplete source', async t => {
 const root = await mkdtemp(path.join(tmpdir(), 'tavern-cdn-budget-'))
 t.after(() => rm(root, {recursive:true, force:true}))
 const ps = await readFile(new URL('../install.ps1', import.meta.url), 'utf8')
 const helper = ps.match(/WriteAllText\(\$CdnDownloader, @'\n([\s\S]*?)\n'@/)[1]
 await writeFile(path.join(root, 'download.cjs'), helper)
 // Accelerate only the whole-stage clock; each HTTP request succeeds well within its limit.
 await writeFile(path.join(root, 'clock.cjs'), "const timeout = AbortSignal.timeout; AbortSignal.timeout = ms => timeout(ms === 300000 ? 120 : ms);\n")
 const files = Array.from({length:48}, (_, n) => ({path:`file${n}`, sha256:createHash('sha256').update('ok').digest('hex')}))
 await writeFile(path.join(root, 'manifest.json'), JSON.stringify({revision:'a'.repeat(40), files}))
 let requested = 0
 const server = createServer((req, res) => { requested++; setTimeout(() => res.end('ok'), 50) })
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
 t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
 await assert.rejects(execute(process.execPath, ['--require', path.join(root, 'clock.cjs'), path.join(root, 'download.cjs'), path.join(root, 'manifest.json'), `http://127.0.0.1:${server.address().port}/repo`, path.join(root, 'output'), path.join(root, 'installed')]), error => error.code === 1 && /备用源下载超过 5 分钟/.test(error.stderr))
 assert.ok(requested < files.length, '时间预算耗尽后不得继续调度剩余文件')
})
