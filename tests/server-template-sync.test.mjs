import test from 'node:test'
import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {createServerTemplateSync} from '../tavern-plugin/lib/domain/server-template-sync.js'
test('a revision arriving during display work runs once after current work drains',async t=>{
 let release,started,runs=0
 const entered=new Promise(r=>started=r),gate=new Promise(r=>release=r)
 const sync=createServerTemplateSync({delayMs:1,run:async()=>{runs++;if(runs===1){started();await gate}}})
 t.after(()=>sync.dispose());sync.schedule('s',1)
 // Keep the test process alive while the production scheduler's unref timer runs.
 await Promise.all([entered,delay(10)])
 sync.schedule('s',2);sync.schedule('s',2)
 release();await delay(20)
 assert.equal(runs,2)
 sync.schedule('s',2);await delay(10);assert.equal(runs,2)
})
test('failed display work is not retried on repeated reads of the same revision',async t=>{
 let runs=0,errors=0
 const sync=createServerTemplateSync({delayMs:1,run:async()=>{runs++;throw Error('template failed')},onError:()=>errors++})
 t.after(()=>sync.dispose());sync.schedule('s',1);await delay(10)
 sync.schedule('s',1);await delay(10);assert.equal(runs,1);assert.equal(errors,1)
 sync.schedule('s',2);await delay(10);assert.equal(runs,2)
})
test('deferred settlement work retries, disposal cancels pending timers',async()=>{
 let runs=0
 const sync=createServerTemplateSync({delayMs:1,run:async()=>({deferred:++runs===1})})
 sync.schedule('s',1);await delay(20);assert.equal(runs,2)
 sync.schedule('s',2);sync.dispose();await delay(10);assert.equal(runs,2)
})

test('settlement blocks display polling until a new idle revision arrives', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let runs = 0
  const sync = createServerTemplateSync({ run: async () => { runs++ } })
  t.after(() => sync.dispose())
  sync.schedule('s', 1, { blocked: true })
  for (let i = 0; i < 40; i++) { t.mock.timers.tick(250); await Promise.resolve() }
  assert.equal(runs, 0, 'settlement must not repeatedly enter the template reader')
  sync.schedule('s', 2, { blocked: false })
  t.mock.timers.tick(250); await Promise.resolve()
  assert.equal(runs, 1)
})

test('no-progress deferrals back off, but a new revision promptly wakes pending work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let runs = 0
  const sync = createServerTemplateSync({ run: async () => { runs++; return { deferred: true } } })
  t.after(() => sync.dispose())
  sync.schedule('s', 1)
  for (let i = 0; i < 40; i++) { t.mock.timers.tick(250); await Promise.resolve() }
  assert.ok(runs <= 5, `10 seconds of unchanged blocked work ran ${runs} times`)
  const before = runs
  sync.schedule('s', 2)
  t.mock.timers.tick(250); await Promise.resolve()
  assert.equal(runs, before + 1, 'new state must not wait for the old backoff')
})

test('successful display batches keep draining without no-progress backoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let runs = 0
  const sync = createServerTemplateSync({ run: async () => ({ synchronized: true, deferred: ++runs < 20 }) })
  t.after(() => sync.dispose())
  sync.schedule('s', 1)
  for (let i = 0; i < 20; i++) { t.mock.timers.tick(250); await Promise.resolve() }
  assert.equal(runs, 20, 'large histories still finish all batches')
})

test('entering settlement cancels a pending retry and blocks a running callback from rearming', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let runs = 0, release
  const sync = createServerTemplateSync({ run: () => { runs++; return new Promise(resolve => { release = resolve }) } })
  t.after(() => sync.dispose())
  sync.schedule('s', 1)
  t.mock.timers.tick(250)
  sync.schedule('s', 2, { blocked: true })
  release({ deferred: true }); await Promise.resolve()
  for (let i = 0; i < 40; i++) { t.mock.timers.tick(250); await Promise.resolve() }
  assert.equal(runs, 1)
  sync.schedule('s', 3)
  t.mock.timers.tick(250)
  release({ deferred: true }); await Promise.resolve()
  sync.schedule('s', 4, { blocked: true })
  t.mock.timers.tick(5000); await Promise.resolve()
  assert.equal(runs, 2)
  sync.schedule('s', 4, { blocked: false })
  t.mock.timers.tick(250)
  assert.equal(runs, 3, 'unblocking the same revision still wakes work')
  release({}); await Promise.resolve()
})

test('disabling a conversation prevents an in-flight deferral from resurrecting its timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let runs = 0, release
  const sync = createServerTemplateSync({ run: () => { runs++; return new Promise(resolve => { release = resolve }) } })
  t.after(() => sync.dispose())
  sync.schedule('s', 1); t.mock.timers.tick(250)
  sync.schedule('s', 2, { enabled: false })
  release({ deferred: true }); await Promise.resolve()
  t.mock.timers.tick(10000); await Promise.resolve()
  assert.equal(runs, 1)
})
