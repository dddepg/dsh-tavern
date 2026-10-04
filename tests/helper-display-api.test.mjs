import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import {JSDOM} from 'jsdom'
import {marked} from 'marked'
const source = await readFile(new URL('../tavern-plugin/src/client/runtime/helper-display-api.js', import.meta.url), 'utf8')
const install = vm.runInNewContext(source + '\ninstallTavernHelperDisplayApi')
function fixture() {
    const rows = [{role: 'assistant', message: '**first**'}, {role: 'user', message: '*last user*'}, {role: 'assistant', message: '<div class="jzy-st">saved</div><script>window.replayed=true</script>'}]
    const dom = new JSDOM('<main><div class="mes"><div class="mes_text">changed</div></div><div id="second">changed</div></main>', {runScripts: 'outside-only'})
    const calls = [], events = [], w = dom.window
    Object.assign(w, {marked, getLastMessageId: () => rows.length - 1, getChatMessages: id => rows[id] ? [structuredClone(rows[id])] : [],
        formatAsTavernRegexedString: (text, role, target, options) => { calls.push({role, target, options}); return text.replaceAll('{{char}}', '角色').replaceAll('before', 'after') },
        retrieveDisplayedMessage: id => id === 2 ? [w.document.querySelector('.mes')] : [], eventEmit: async (...args) => { events.push(args) }})
    install(w)
    return {w, rows, dom, calls, events}
}
test('display formatter renders Markdown/raw HTML after regexes with selected floor depth and macros', () => {
    const {w, dom, calls} = fixture()
    assert.equal(w.TavernHelper.formatAsDisplayedMessage, w.formatAsDisplayedMessage)
    assert.equal(w.formatAsDisplayedMessage('**{{char}}** before {{messageId}}/{{lastMessageId}}', {message_id: 'last_user'}), '<p><strong>角色</strong> after 1/2</p>\n')
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {role: 'user_input', target: 'display', options: {depth: 1}})
    assert.match(w.formatAsDisplayedMessage('<aside>raw</aside>\n\n| A | B |\n| - | - |\n| 1 | 2 |', {message_id: -1}), /<table>/)
    assert.throws(() => w.formatAsDisplayedMessage('x', {message_id: 99}), /不存在/)
    assert.throws(() => w.formatAsDisplayedMessage('x', {message_id: 'wrong'}), /无效/)
    dom.window.close()
})
test('refresh updates real selected DOM without saving messages or replaying scripts; emits completion', async () => {
    const {w, dom, rows, events} = fixture(), before = structuredClone(rows)
    await w.TavernHelper.refreshOneMessage(2)
    assert.equal(w.document.querySelector('.jzy-st').textContent, 'saved')
    assert.equal(w.replayed, undefined)
    assert.deepEqual(events, [['CHARACTER_MESSAGE_RENDERED', 2]])
    await w.refreshOneMessage(1, [w.document.querySelector('#second')])
    assert.equal(w.document.querySelector('#second').innerHTML, '<p><em>last user</em></p>\n')
    assert.deepEqual(events[1], ['USER_MESSAGE_RENDERED', 1])
    assert.deepEqual(rows, before)
    await w.refreshOneMessage(999, [])
    await w.refreshOneMessage(0)
    assert.equal(events.length, 2)
    dom.window.close()
})
test('shipped offline Markdown bundle is pinned and provides real parsing', async () => {
    const source = await readFile(new URL('../tavern-plugin/lib/vendor/runtime-assets/marked/marked.umd.js', import.meta.url), 'utf8')
    const scope = {}; vm.runInNewContext(source, scope)
    assert.equal(scope.marked.parse('**ok**', {async: false}), '<p><strong>ok</strong></p>\n')
    assert.match(source, /marked v16\.3\.0/)
})
