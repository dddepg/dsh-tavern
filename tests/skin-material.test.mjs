import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../tavern-plugin/packages/dsh-dream-skin/lib/client.js', import.meta.url), 'utf8')
test('glass is off by default and explicit existing material choices survive', () => {
 const start = source.indexOf('const DEFAULT_MATERIAL_PRESET =')
 const presetsEnd = source.indexOf('\n\t\t];', source.indexOf('const MATERIAL_PRESETS', start)) + 6
 const fnStart = source.indexOf('function readMaterialPreset()')
 const fnEnd = source.indexOf('\n\t\t}', fnStart) + 5
 let stored
 const context = { readStorage: () => stored, MATERIAL_PRESET_KEY: 'material' }
 vm.runInNewContext(source.slice(start, presetsEnd) + '\n' + source.slice(fnStart, fnEnd) + '\nthis.read=readMaterialPreset', context)
 assert.equal(context.read(), 'none')
 stored='frosted'; assert.equal(context.read(), 'frosted')
 stored='liquid'; assert.equal(context.read(), 'liquid')
 stored='none'; assert.equal(context.read(), 'none')
 stored='unknown'; assert.equal(context.read(), 'none')
 assert.match(source, /\[MATERIAL_PRESET_KEY\]: DEFAULT_MATERIAL_PRESET/)
 assert.match(source, /html\[data-dsh-material="none"\].*backdrop-filter: none !important/)
})
