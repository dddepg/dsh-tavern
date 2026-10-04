import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
const source = await readFile(new URL('../tavern-plugin/src/client/runtime/helper-macro-api.js', import.meta.url), 'utf8')
const install = vm.runInNewContext(source + '\ninstallTavernHelperMacroApi')
test('read-only macros expose useful identity and nested variable results without evaluating writes', () => {
    let state = {playerName: '$&', characterName: 'Card'}
    const tables = {chat: {gold: 3, box: {'a.b': [7]}}, global: {x: 'G'}, character: {mood: 'happy'}, message: {stats: {$private: 1, hp: 8}}}
    const reads = [], w = {getCurrentMessageId: () => 2, getLastMessageId: () => 4, getVariables(option) {reads.push(option); return structuredClone(tables[option.type])}}
    install({window: w, context: () => state})
    assert.equal(w.TavernHelper.substitudeMacros('{{user}} {{char}} {{messageId}}/{{lastMessageId}}'), '$& Card 2/4')
    assert.equal(w.substitudeMacros('{{getvar::box["a.b"][0]}}/{{getglobalvar::x}}/{{get_character_variable::mood}}'), '7/G/happy')
    assert.equal(w.substitudeMacros('{{get_message_variable::stats}}', {message_id: 0}), '{"hp":8}')
    assert.equal(reads.at(-1).message_id, 0)
    assert.equal(w.substitudeMacros('{{setvar::gold::99}} {{pipe}} {{random}}'), '{{setvar::gold::99}} {{pipe}} {{random}}')
    assert.equal(tables.chat.gold, 3)
    assert.equal(w.substitudeMacros('{{getvar::__proto__.polluted}}/{{getvar::missing}}'), '/')
    state = {...state, characterName: 'Changed'}
    assert.equal(w.substituteMacros('{{char}}'), 'Changed')
})
