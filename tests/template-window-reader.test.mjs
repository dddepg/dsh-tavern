import test from 'node:test'
import assert from 'node:assert/strict'

import { createTemplateWindowReader } from '../tavern-plugin/lib/domain/template-window-reader.js'

test('long history retains its bounded window and virtual input count',async()=>{
 let issued
 const window={chat:{sessionId:'s',backgroundConfigVersion:1,conversationFeaturesVersion:1,promptTemplateInput:{message:{}}},from:50,messageCount:250,revision:9}
 const read=createTemplateWindowReader({links:async()=>({s:'chat'}),completeSessions:new Set(['full']),
  access:{issue:value=>(issued=value,{token:'lease'})},readWindow:async()=>window})
 assert.equal(await read('full'),undefined)
 assert.deepEqual((await read('s')).historyWindow,{token:'lease',from:50,messageCount:251})
 assert.equal(issued.messageCount,250)
})
