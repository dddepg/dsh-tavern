import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
const source=await readFile(new URL('../tavern-plugin/src/client/modules/background-wait.js',import.meta.url),'utf8')
const message=runInNewContext(source+';backgroundWaitMessage')
test('long waits explain model progress versus tools, short waits remain quiet',()=>{
 assert.equal(message({phase:'model',startedAt:0,lastProgressAt:0},59000),'')
 assert.match(message({phase:'model',startedAt:0,lastProgressAt:65000},70000),/仍在输出/)
 assert.match(message({phase:'model',startedAt:0,lastProgressAt:0},70000),/5 分钟/)
 assert.match(message({phase:'tool',startedAt:0,lastProgressAt:0},70000),/工具/)
 assert.match(source,/TavernStopBackgroundAction/)
})
