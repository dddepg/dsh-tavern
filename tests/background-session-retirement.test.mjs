import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createProfileDataStore} from '../tavern-plugin/lib/profile-data-store.js'
import {createBackgroundSessionRetirement,installRetiredBackgroundFilter} from '../tavern-plugin/lib/domain/background-session-retirement.js'

test('退休状态跨重启持久化，目录隐藏已结束旧代理但保留运行中、子树及其他游戏',async t=>{
  const root=await mkdtemp(join(tmpdir(),'background-retirement-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const store=createProfileDataStore({dataRoot:root})
  await createBackgroundSessionRetirement(store).retire('old','parent')
  const retirement=createBackgroundSessionRetirement(createProfileDataStore({dataRoot:root}))
  assert.equal(await retirement.isRetired('old'),true)
  assert.equal(await retirement.isRetired('current'),false)
  let rows=[{kind:'child',id:'old',activity:'inactive',hasChildren:false},{kind:'child',id:'current',activity:'inactive',hasChildren:false}]
  const service={async listChildren(){return rows},async listDescendants(){return rows.map(row=>({...row,parentId:'parent',depth:1}))}}
  const original=service.listChildren,stop=installRetiredBackgroundFilter(service,retirement)
  assert.deepEqual((await service.listChildren('parent')).map(x=>x.id),['current'])
  assert.deepEqual((await service.listDescendants('parent')).map(x=>x.id),['current'])
  assert.equal((await service.listChildren('unrelated')).length,2)
  rows[0].activity='running';assert.equal((await service.listChildren('parent')).length,2)
  rows[0].activity='inactive';rows[0].hasChildren=true;assert.equal((await service.listChildren('parent')).length,2)
  stop();assert.equal(service.listChildren,original);assert.equal((await service.listChildren('parent')).length,2)
})


test('旧版本失败记录仅在被新会话替代后折叠，回退到旧参与者时恢复可见',async()=>{
  const chat={timeline:{participants:{background:{sessionId:'new'}},operations:{a:{kind:'agent',status:'failed',startedSessionId:'old'},b:{kind:'agent',status:'running',startedSessionId:'busy'}}}}
  const retirement=createBackgroundSessionRetirement({readJson:async()=>undefined},{readState:async()=>chat})
  const rows=['old','new','busy','unrelated'].map(id=>({kind:'child',id,label:'酒馆后台 Agent',activity:'inactive'}))
  assert.deepEqual((await retirement.filter(rows,'parent')).map(row=>row.id),['new','busy','unrelated'])
  chat.timeline.participants.background.sessionId='old'
  assert.equal((await retirement.filter(rows,'parent')).length,4)
})
