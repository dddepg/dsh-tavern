import test from 'node:test'
import assert from 'node:assert/strict'
import { createSettlementJobs } from '../tavern-plugin/lib/domain/settlement-jobs.js'
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}

test('same-chat callers share execution; normal completion publishes once',async()=>{
  const end=gate();let executions=0,wakes=0
  const jobs=createSettlementJobs({run:async()=>{executions++;await end.promise},onSettled:()=>{wakes++}})
  const a=jobs.start('c'), b=jobs.start('c')
  assert.equal(a,b);end.resolve();await a
  assert.equal(executions,1);assert.equal(wakes,1);jobs.dispose()
})
test('shutdown aborts running work, blocks future work and finally notifications',async()=>{
  const started=gate(),end=gate();let signal,wakes=0,executions=0
  const jobs=createSettlementJobs({run:async(_id,s)=>{signal=s;executions++;started.resolve();await end.promise;s.throwIfAborted()},onSettled:()=>{wakes++}})
  const pending=jobs.start('c');await started.promise
  jobs.dispose();assert.equal(signal.aborted,true);end.resolve()
  await assert.rejects(pending,{name:'AbortError'})
  await jobs.start('c');assert.equal(executions,1);assert.equal(wakes,0)
})
test('cancelled old execution cannot remove or wake a replacement execution',async()=>{
  const old=gate(),next=gate();let count=0,wakes=0
  const jobs=createSettlementJobs({run:async()=>{await (++count===1?old.promise:next.promise)},onSettled:()=>{wakes++}})
  const first=jobs.start('c');await Promise.resolve()
  await jobs.cancel('c',{wait:false})
  const second=jobs.start('c');await Promise.resolve()
  old.resolve();await first
  assert.equal(jobs.start('c'),second);assert.equal(wakes,0)
  next.resolve();await second;assert.equal(wakes,1);jobs.dispose()
})
test('disposal before the execution microtask never enters run',async()=>{
  let calls=0
  const jobs=createSettlementJobs({run:()=>{calls++},onSettled:()=>{calls++}})
  const pending=jobs.start('c');jobs.dispose()
  await assert.rejects(pending,{name:'AbortError'});assert.equal(calls,0)
})

test('shutdown also aborts an asynchronous completion notification after run finished',async()=>{
  const entered=gate(),end=gate();let wakes=0
  const jobs=createSettlementJobs({run:async()=>{},onSettled:async(_id,signal)=>{
    entered.resolve();await end.promise;if(!signal.aborted)wakes++
  }})
  const pending=jobs.start('c');await entered.promise;jobs.dispose();end.resolve();await pending
  assert.equal(wakes,0)
})
