import test from 'node:test'
import assert from 'node:assert/strict'
import {createDefinition} from '../tavern-plugin/lib/domain/mvu-conversion-definition.js'
import {freezeMvuAppearance} from '../tavern-plugin/lib/domain/mvu-conversion-appearance.js'

test('集合模式混用全局字段时给出字段、作用域和可执行修正',()=>{
 assert.throws(()=>createDefinition({data:{first_mes:'开始'},sourcePath:'cards/test.json',revision:'source'},{initialState:{时间:'午后',人物:{甲:{姓名:'甲'}}},updateRules:'依据事实',appearance:{html:'<p>$1 $2</p>',collectionPath:'/人物',bindings:[{capture:1,path:'/姓名'},{capture:2,path:'/时间'}]}}),error=>{
  assert.equal(error.code,'MVU_APPEARANCE_SCOPE_MISMATCH')
  assert.equal(error.details.path,'/时间');assert.equal(error.details.collectionPath,'/人物')
  assert.match(error.details.hint,/collectionPath/);assert.match(error.details.hint,/删除.*字段|删.*字段/)
  return true
 })
})
test('HTML 宏错误指出具体语法和位置，不要求研究源码',()=>{
 const html='<section><p>对{{user}}</p><p>$1</p></section>'
 assert.throws(()=>freezeMvuAppearance({}, {html,bindings:[{capture:1,path:'/态度'}]}),error=>{
  assert.equal(error.code,'MVU_APPEARANCE_UNSUPPORTED_SYNTAX');assert.equal(error.details.field,'html')
  assert.equal(error.details.token,'{{user}}');assert.equal(error.details.offset,html.indexOf('{{user}}'))
  assert.match(error.details.hint,/玩家/);return true
 })
})
