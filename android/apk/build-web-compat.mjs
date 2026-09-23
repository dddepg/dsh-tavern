import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const [source, assets] = process.argv.slice(2)
const tools = path.resolve(source, 'tools/web-compat')
const { build } = await import(pathToFileURL(path.join(tools, 'node_modules/esbuild/lib/main.js')))
const result = await build({
  stdin: { contents: "require('core-js/actual/structured-clone');", resolveDir: tools },
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2018',
  minify: true, legalComments: 'inline', supported: { 'template-literal': false },
  banner: { js: '/*! DSH Tavern structuredClone compatibility | core-js 3.50.0 | MIT | see core-js.LICENSE */' },
})
const patch = result.outputFiles[0].text
// 覆盖本次实测的旧 WebView 缺失能力，同时验证循环引用、集合与二进制数据不会丢失。
const context = vm.createContext({})
vm.runInContext(patch, context)
assert.equal(vm.runInContext(`(() => {
  const value = { map: new Map([['x', 7]]), date: new Date(123), bytes: new Uint8Array([2, 9]) };
  value.self = value;
  const copy = structuredClone(value);
  return copy !== value && copy.self === copy && copy.map.get('x') === 7
    && copy.date.getTime() === 123 && copy.bytes[1] === 9 && copy.bytes.buffer !== value.bytes.buffer;
})()`, context), true)
assert.throws(() => vm.runInContext('structuredClone(() => {})', context), /clone/i)
const file = path.join(assets, 'web-integration/es-compat.js')
const combined = `${await readFile(file, 'utf8')}\n${patch}\n`
await writeFile(file, combined)
const metadataPath = path.join(assets, 'web-integration/es-compat.inputs.json')
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
metadata.sha256 = createHash('sha256').update(combined).digest('hex')
metadata.tavernStructuredClone = createHash('sha256').update(patch).digest('hex')
await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n')
console.log('旧 WebView structuredClone 兼容与数据保真检查通过')
