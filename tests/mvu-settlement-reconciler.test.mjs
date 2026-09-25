import assert from 'node:assert/strict'
import test from 'node:test'
import { createMvuSettlementReconciler } from '../tavern-plugin/lib/domain/mvu-settlement-reconciler.js'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('启动扫描会接续已持久化且运行时就绪的 MVU 结算', async () => {
  const resumed = []
  const reconciler = createMvuSettlementReconciler({
    list: async () => [{ sessionId: 'session-1' }],
    resolve: async sessionId => ({ id: 'chat-1', sessionId, pending: true }),
    shouldResume: chat => chat.pending,
    isReady: () => true,
    resume: async chatId => { resumed.push(chatId) }
  })

  await reconciler.scan()

  assert.deepEqual(resumed, ['chat-1'])
  reconciler.dispose()
})

test('瞬时读取失败会自行退避重试，不依赖新的浏览器就绪事件', async () => {
  const scheduled = []
  let reads = 0
  const reconciler = createMvuSettlementReconciler({
    list: async () => [],
    resolve: async sessionId => {
      reads++
      if (reads === 1) throw new Error('temporary read failure')
      return { id: 'chat-1', sessionId, pending: true }
    },
    shouldResume: chat => chat.pending,
    isReady: () => true,
    resume: async () => {},
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length },
    cancel: () => {},
    retryDelayMs: 25,
    onError: () => {}
  })

  assert.equal(await reconciler.wake('session-1'), false)
  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0].delay, 25)
  await scheduled[0].callback()
  assert.equal(reads, 3)
  reconciler.dispose()
})

test('重复唤醒合并为一次结算接续', async () => {
  const gate = deferred()
  let resumes = 0
  const reconciler = createMvuSettlementReconciler({
    list: async () => [],
    resolve: async sessionId => ({ id: 'chat-1', sessionId, pending: true }),
    shouldResume: chat => chat.pending,
    isReady: () => true,
    resume: async () => { resumes++; await gate.promise }
  })

  const first = reconciler.wake('session-1')
  const second = reconciler.wake('session-1')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(resumes, 1)
  gate.resolve()
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  reconciler.dispose()
})

test('未就绪时只保留持久事实，后续就绪唤醒再接续', async () => {
  let ready = false
  let resumes = 0
  const reconciler = createMvuSettlementReconciler({
    list: async () => [{ sessionId: 'session-1' }],
    resolve: async sessionId => ({ id: 'chat-1', sessionId, pending: true }),
    shouldResume: chat => chat.pending,
    isReady: () => ready,
    resume: async () => { resumes++ }
  })

  await reconciler.scan()
  assert.equal(resumes, 0)
  ready = true
  await reconciler.wake('session-1')
  assert.equal(resumes, 1)
  reconciler.dispose()
})

test('任务已持久化但全部就绪通知丢失时仍自动接续', async () => {
  const scheduled = []
  let ready = false, pending = true, resumed = 0
  const reconciler = createMvuSettlementReconciler({ list: async () => [], resolve: async () => ({ id: 'c', pending }),
    shouldResume: chat => chat.pending, isReady: () => ready,
    resume: async () => { resumed++; pending = false },
    schedule: fn => { scheduled.push(fn); return scheduled.length }, cancel() {} })
  await reconciler.wake('s')
  assert.equal(scheduled.length, 1)
  ready = true
  await scheduled.shift()()
  assert.equal(resumed, 1)
  reconciler.dispose()
})

test('读取旧状态期间到达的持久待办唤醒不会被吞掉', async () => {
  const readStarted = deferred(), releaseRead = deferred()
  const scheduled = []
  let pending = false, reads = 0, resumes = 0
  const reconciler = createMvuSettlementReconciler({
    list: async () => [],
    resolve: async () => {
      const snapshot = { id: 'c', pending }
      if (++reads === 1) { readStarted.resolve(); await releaseRead.promise }
      return snapshot
    },
    shouldResume: chat => chat.pending, isReady: () => true,
    resume: async () => { resumes++; pending = false },
    schedule: fn => { scheduled.push(fn); return scheduled.length }, cancel() {}
  })
  const first = reconciler.wake('s')
  await readStarted.promise
  pending = true
  const second = reconciler.wake('s')
  releaseRead.resolve()
  await Promise.all([first, second])
  assert.equal(scheduled.length, 1, 'new wake must recheck after the stale in-flight read')
  await scheduled.shift()()
  assert.equal(resumes, 1)
  reconciler.dispose()
})

test('dispose during a pending read prevents resume and retry', async () => {
  const gate = deferred(), started = deferred(), scheduled = []
  let resumes = 0
  const reconciler = createMvuSettlementReconciler({list:async()=>[],
    resolve:async()=>{started.resolve();await gate.promise;return {id:'c',pending:true}},
    shouldResume:chat=>chat.pending,isReady:()=>true,resume:async()=>{resumes++},
    schedule:fn=>{scheduled.push(fn);return 1},cancel(){}})
  const running=reconciler.wake('s')
  await started.promise
  reconciler.dispose();gate.resolve();await running
  assert.equal(resumes,0)
  assert.equal(scheduled.length,0)
})

test('dispose aborts resume adapter and suppresses the post-resume read',async()=>{
  const entered=deferred(),end=deferred();let reads=0,signal
  const r=createMvuSettlementReconciler({list:async()=>[],resolve:async()=>{reads++;return {id:'c',pending:true}},
    shouldResume:c=>c.pending,isReady:()=>true,resume:async(_id,context)=>{signal=context.signal;entered.resolve();await end.promise}})
  const running=r.wake('s');await entered.promise;r.dispose();end.resolve();await running
  assert.equal(signal.aborted,true);assert.equal(reads,1)
})
test('cancelled timer callbacks cannot start another check after a ready wake',async()=>{
  const timers=[];let ready=false,pending=true,reads=0,resumes=0
  const r=createMvuSettlementReconciler({list:async()=>[],resolve:async()=>{reads++;return {id:'c',pending}},
    shouldResume:c=>c.pending,isReady:()=>ready,resume:async()=>{resumes++;pending=false},
    schedule:fn=>{timers.push(fn);return timers.length},cancel(){}})
  await r.wake('s');ready=true;await r.wake('s')
  const before=reads;await timers[0]()
  assert.equal(reads,before);assert.equal(resumes,1);r.dispose()
})
test('startup scans coalesce and do not wake sessions after disposal',async()=>{
  const entered=deferred(),end=deferred();let lists=0,reads=0
  const r=createMvuSettlementReconciler({list:async()=>{lists++;entered.resolve();await end.promise;return [{sessionId:'s'}]},
    resolve:async()=>{reads++;return null},shouldResume:()=>false,isReady:()=>true,resume:async()=>{}})
  const a=r.scan(),b=r.scan();await entered.promise;r.dispose();end.resolve();await Promise.all([a,b])
  assert.equal(lists,1);assert.equal(reads,0)
})
