import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import vm from 'node:vm'
import test from 'node:test'
import {chromium} from 'playwright'
import {readTavernRuntimeAsset} from '../tavern-plugin/lib/domain/tavern-runtime-assets.js'

test('开局页面替换 document 后仍启动宿主模块并保留其 API', async t=>{
  let descriptor
  vm.runInNewContext(await readFile(new URL('../tavern-plugin/lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:d=>descriptor=d}},console})
  const client=descriptor.factory(()=>({}))
  const content=`<script>fetch('/wizard').then(r=>r.text()).then(html=>{document.open();document.write(html);document.close()})</script><script src="/parser-wait.js"></script>`
  const context={mvuEnabled:false,messages:[{message_id:0,role:'assistant',message:'opening',variables:{}}]}
  const html=client.buildTavernFrameDocument({content,openingPreview:{swipes:['opening'],openingIds:['first'],selectedIndex:0,preparationId:'test',runtime:{context,scripts:[{id:'wizard-runtime',content:'window.openingRuntimeStarts=(window.openingRuntimeStarts||0)+1;window.Mvu={getMvuData:()=>({stat_data:{name:"测试"}})};'}]}}})
  const server=createServer(async(req,res)=>{
    const p=new URL(req.url,'http://localhost').pathname
    if(p==='/wizard'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>角色创建</title><button>开始旅程</button>');return}
    if(p==='/parser-wait.js'){await new Promise(r=>setTimeout(r,150));res.setHeader('content-type','text/javascript');res.end('');return}
    const asset=await readTavernRuntimeAsset(p)
    if(asset){res.setHeader('content-type',asset.mediaType);res.end(asset.body);return}
    res.setHeader('content-type','text/html');res.end(html)
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r))})
  const browser=await chromium.launch();t.after(()=>browser.close())
  const page=await browser.newPage()
  await page.goto('http://127.0.0.1:'+server.address().port)
  await page.getByRole('button',{name:'开始旅程'}).waitFor()
  await page.waitForFunction(()=>typeof window.Mvu?.getMvuData==='function',null,{timeout:3000})
  assert.equal(await page.evaluate(()=>window.Mvu.getMvuData().stat_data.name),'测试')
  assert.equal(await page.evaluate(()=>window.openingRuntimeStarts),1)
  // Replace the document after every companion module has finished. The input
  // adapter must remount without replaying any card script.
  await page.evaluate(() => {
    window.sendAttempts = [];
    window.submitTavernInput = async text => {
      window.sendAttempts.push(text);
      if (window.sendAttempts.length === 1) throw new Error('可重试失败');
    };
    document.open(); document.write('<body><p>第二份开局文档</p></body>'); document.close();
  });
  await page.waitForFunction(() => Boolean(document.getElementById('send_but')));
  await page.evaluate(() => {
    document.getElementById('send_textarea').value = '原样保留 | /trigger';
    document.getElementById('send_but').click(); document.getElementById('send_but').click();
  });
  await page.getByRole('alert').filter({ hasText: '可重试失败' }).waitFor();
  assert.equal(await page.locator('#send_textarea').inputValue(), '原样保留 | /trigger');
  await page.evaluate(() => document.getElementById('send_but').click());
  await page.waitForFunction(() => document.getElementById('send_textarea').value === '');
  assert.deepEqual(await page.evaluate(() => window.sendAttempts), ['原样保留 | /trigger', '原样保留 | /trigger']);
  assert.equal(await page.evaluate(() => window.openingRuntimeStarts), 1);
})

for (const afterComposer of [false, true]) test('远程开局重写到 head 阶段时，MVU 和输入层恢复且能保存角色：afterComposer=' + afterComposer, async t => {
  let descriptor
  vm.runInNewContext(await readFile(new URL('../tavern-plugin/lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:d=>descriptor=d}},console})
  const client=descriptor.factory(()=>({}))
  let unblockBundle
  const replacementStarted=new Promise(resolve=>{unblockBundle=resolve})
  const context={messages:[{message_id:0,role:'assistant',message:'opening',variables:{stat_data:{}}}]}
  const html=client.buildTavernFrameDocument({token:'replacement',trustedCardMode:true,
    content:`<script>(async()=>{${afterComposer ? 'while(!document.getElementById("send_textarea"))await new Promise(r=>setTimeout(r,5));' : ''}const html=await fetch('/wizard').then(r=>r.text());document.open();document.write(html);document.close()})()</script>`,
    openingPreview:{swipes:['opening'],openingIds:['primary'],selectedIndex:0,preparationId:'test',runtime:{context,scripts:[
      {id:'__dsh_official_mvu__',system:'official-mvu',assetUrl:'/mvu.js'}
    ]}}})
  const bundle=`window.openingRuntimeStarts=(window.openingRuntimeStarts||0)+1;window.initializeGlobal('Mvu',{getMvuData:()=>({stat_data:{}}),replaceMvuData:async data=>{window.savedCharacter=data.stat_data.name}});`
  const server=createServer(async(req,res)=>{
    const p=new URL(req.url,'http://localhost').pathname
    if(p==='/frame'){res.setHeader('content-type','text/html');res.end(html);return}
    if(p==='/wizard'){res.setHeader('content-type','text/html');res.end('<!doctype html><head><script src="/parser-wait.js"></script></head><body><button onclick="saveCharacter()">保存角色</button><script>async function saveCharacter(){const m=parent.Mvu;if(!m)return alert("MVU系统不可用，无法保存角色数据");const d=m.getMvuData({type:"message",message_id:"latest"});d.stat_data.name="开局角色";await m.replaceMvuData(d,{type:"message",message_id:"latest"});document.querySelector("button").textContent="已保存"}</script></body>');return}
    if(p==='/parser-wait.js'){unblockBundle();await new Promise(r=>setTimeout(r,200));res.setHeader('content-type','text/javascript');res.end('');return}
    if(p==='/mvu.js'){await replacementStarted;res.setHeader('content-type','text/javascript');res.end(bundle);return}
    const asset=await readTavernRuntimeAsset(p)
    if(asset){res.setHeader('content-type',asset.mediaType);res.end(asset.body);return}
    res.setHeader('content-type','text/html');res.end('<iframe src="/frame"></iframe>')
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r))})
  const browser=await chromium.launch();t.after(()=>browser.close())
  const page=await browser.newPage(),dialogs=[],errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  page.on('dialog',async d=>{dialogs.push(d.message());await d.dismiss()})
  await page.goto('http://127.0.0.1:'+server.address().port)
  const frame=page.frames().find(f=>f.url().endsWith('/frame'))
  await frame.waitForFunction(()=>window.openingRuntimeStarts===1,null,{timeout:3000})
  await frame.getByRole('button',{name:'保存角色'}).click()
  await frame.getByRole('button',{name:'已保存'}).waitFor()
  assert.equal(await frame.evaluate(()=>window.savedCharacter),'开局角色')
  assert.equal(await frame.evaluate(()=>window.openingRuntimeStarts),1)
  assert.equal(await frame.locator('#send_textarea').count(),1)
  assert.equal(await frame.locator('#send_but').count(),1)
  assert.deepEqual(errors,[])
  assert.deepEqual(dialogs,[])
})

test('开局 document.open 清掉卸载监听后，移除准备页不能继续提供旧 MVU', async t => {
  let descriptor
  vm.runInNewContext(await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { descriptor = value } } }, console
  })
  const client = descriptor.factory(() => ({}))
  const context = owner => ({ mvuEnabled: true, messages: [{ message_id: 0, role: 'assistant', message: 'opening', variables: { stat_data: { owner } } }] })
  const opening = client.buildTavernFrameDocument({ token: 'old', trustedCardMode: true, content: '<p>开局</p>',
    openingPreview: { runtime: { context: context('opening'), scripts: [{ id: 'old', content: 'window.runtimeReady=true;' }] } } })
  const game = client.buildTavernHelperScriptDocument({ token: 'new', trustedCardMode: true,
    context: context('game'), scripts: [{ id: 'new', content: 'window.runtimeReady=true;' }] })
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/opening' || path === '/game') {
      res.setHeader('content-type', 'text/html'); res.end(path === '/opening' ? opening : game); return
    }
    const asset = await readTavernRuntimeAsset(path)
    if (asset) { res.setHeader('content-type', asset.mediaType); res.end(asset.body); return }
    res.setHeader('content-type', 'text/html')
    res.end('<script>window.Mvu={native:true}</script><iframe id="opening" src="/opening"></iframe>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const browser = await chromium.launch(); t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:' + server.address().port)
  await page.waitForFunction(() => document.querySelector('#opening').contentWindow.runtimeReady)
  await page.evaluate(() => { const frame = document.createElement('iframe'); frame.id = 'game'; frame.src = '/game'; document.body.append(frame) })
  await page.waitForFunction(() => document.querySelector('#game').contentWindow.runtimeReady)
  assert.equal(await page.evaluate(() => Mvu.getMvuData({ type: 'message' }).stat_data.owner), 'opening')
  await page.frames().find(frame => frame.url().endsWith('/opening')).evaluate(() => {
    document.open(); document.write('<body>远程开局页面</body>'); document.close()
  })
  assert.equal(await page.evaluate(() => Mvu.getMvuData({ type: 'message' }).stat_data.owner), 'opening')
  const owner = await page.evaluate(() => {
    document.querySelector('#opening').remove()
    // Use the actual generated Helper optionOf/getVariables after detachment.
    return Mvu.getMvuData({ type: 'message' }).stat_data.owner
  })
  assert.equal(owner, 'game')
  await page.evaluate(() => document.querySelector('#game').remove())
  assert.equal(await page.evaluate(() => Mvu.native), true)
})
