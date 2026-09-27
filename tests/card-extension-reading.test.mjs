import assert from 'node:assert/strict'
import test from 'node:test'

import { inspectCardExtensions } from '../tavern-plugin/lib/domain/card-extension-reading.js'

test('读取人物卡正则和 Tavern Helper 脚本，但不执行脚本', () => {
  const card = {
    spec: 'chara_card_v3',
    data: {
      name: '灯火阑珊',
      extensions: {
        regex_scripts: [{
          id: 'regex-1', scriptName: '状态栏', findRegex: '/<status>(.*?)<\\/status>/s', replaceString: '<aside>$1</aside>',
          placement: [2], disabled: false, markdownOnly: true, minDepth: 1, maxDepth: 8
        }],
        tavern_helper: {
          scripts: [{ id: 'script-1', name: '开场白索引', type: 'script', enabled: true, content: "import 'https://example.test/opening.js'", data: { auto_apply: true }, button: [{ name: '刷新' }] }]
        }
      }
    }
  }

  const result = inspectCardExtensions(card)
  assert.equal(result.extensionCount, 2)
  assert.deepEqual(result.regexScripts[0], {
    ref: 'regex:0', id: 'regex-1', name: '状态栏', findRegex: '/<status>(.*?)<\\/status>/s', replaceString: '<aside>$1</aside>', trimStrings: [],
    placement: [2], enabled: true, markdownOnly: true, promptOnly: false, runOnEdit: false, substituteRegex: null, minDepth: 1, maxDepth: 8
  })
  assert.equal(result.helperScripts[0].name, '开场白索引')
  assert.equal(result.helperScripts[0].content, "import 'https://example.test/opening.js'")
  assert.deepEqual(result.helperScripts[0].data, { auto_apply: true })
  assert.equal(result.helperScripts[0].dataText, '{\n  "auto_apply": true\n}')
  assert.deepEqual(result.helperScripts[0].buttons, [])
  assert.equal(result.helperScripts[0].buttonCount, 1)
  assert.deepEqual(result.variables, {})
})
