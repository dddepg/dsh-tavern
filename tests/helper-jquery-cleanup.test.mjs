import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'

const source = await readFile(new URL('../tavern-plugin/src/client/runtime/helper-host.js', import.meta.url), 'utf8')
const start = source.indexOf('function releaseTavernHostJQueryHandlers(')
const finish = source.indexOf('// The parent sends', start)
const release = vm.runInNewContext(source.slice(start, finish) + '\nreleaseTavernHostJQueryHandlers')
const jquerySource = await readFile(new URL('../tavern-plugin/lib/vendor/runtime-assets/jquery/jquery.min.js', import.meta.url), 'utf8')

function fixture(t) {
  const dom = new JSDOM('<div class="root"></div><iframe id="script"></iframe><iframe id="same" class="dsh-tavern-message-frame"></iframe><iframe id="pending" class="dsh-tavern-message-frame" aria-hidden="true"></iframe><iframe id="other" class="dsh-tavern-message-frame"></iframe><iframe id="unscoped" class="dsh-tavern-message-frame"></iframe>', {
    url: 'https://example.test', runScripts: 'outside-only'
  })
  t.after(() => dom.window.close())
  const host = dom.window
  const frames = Object.fromEntries([...host.document.querySelectorAll('iframe')].map(frame => [frame.id, frame]))
  frames.script.__dshTavernSessionId = 'A'
  frames.same.__dshTavernSessionId = 'A'
  frames.pending.__dshTavernSessionId = 'A'
  frames.other.__dshTavernSessionId = 'B'
  for (const frame of Object.values(frames)) frame.contentDocument.body.innerHTML = '<button class="jzy-st">play</button>'
  const retiring = frames.script.contentWindow
  host.eval(jquerySource)
  retiring.eval(jquerySource)
  const own = retiring.eval('(function retiredCallback() {})')
  const unrelated = host.eval('(function unrelatedCallback() {})')
  const other = frames.other.contentWindow.eval('(function otherSessionCallback() {})')
  return { host, retiring, frames, own, unrelated, other }
}
function handlers(jq, target) { return [...(jq._data(target, 'events')?.click || [])].map(entry => entry.handler) }

test('retiring callbacks are cleaned from both jQuery registries in same-session live and pending message DOM', t => {
  const { host, retiring, frames, own, unrelated, other } = fixture(t)
  const targets = [host, host.document, host.document.querySelector('.root'), retiring, retiring.document,
    frames.same.contentWindow, frames.same.contentDocument, frames.same.contentDocument.querySelector('button'),
    frames.pending.contentDocument.querySelector('button')]
  const excluded = [frames.other.contentDocument, frames.other.contentDocument.querySelector('button'), frames.unscoped.contentDocument.querySelector('button')]
  const registries = [host.jQuery, retiring.jQuery]
  assert.notEqual(registries[0], registries[1])
  for (const jq of registries) {
    for (const target of targets.concat(excluded)) {
      jq(target).on('click.shared', own).on('click.shared', unrelated).on('click.shared', other)
    }
    // Delegated listeners are separate entries and require their selector on removal.
    jq(frames.same.contentDocument).on('click.playback', '.jzy-st', own)
  }
  release(host, retiring)
  for (const jq of registries) {
    for (const target of targets) assert.deepEqual(handlers(jq, target), [unrelated, other])
    for (const target of excluded) assert.deepEqual(handlers(jq, target), [own, unrelated, other], 'other/unscoped message document remains untouched')
  }
  release(host, retiring)
  for (const jq of registries) assert.deepEqual(handlers(jq, frames.same.contentDocument), [unrelated, other], 'cleanup is idempotent')
})

test('cleanup still inspects retiring jQuery when the host has none and skips opaque documents', t => {
  const { host, retiring, frames, own, unrelated } = fixture(t)
  const jq = retiring.jQuery, button = frames.same.contentDocument.querySelector('button')
  jq(button).on('click', own).on('click', unrelated)
  const opaque = host.document.createElement('iframe')
  opaque.className = 'dsh-tavern-message-frame'
  opaque.__dshTavernSessionId = 'A'
  Object.defineProperty(opaque, 'contentDocument', { get() { throw new Error('cross-origin') } })
  host.document.body.append(opaque)
  host.jQuery = undefined
  assert.doesNotThrow(() => release(host, retiring))
  assert.deepEqual(handlers(jq, button), [unrelated])
})

test('missing session identity never scans message documents', t => {
  const { host, retiring, frames, own } = fixture(t)
  const jq = host.jQuery, button = frames.same.contentDocument.querySelector('button')
  jq(button).on('click', own)
  delete frames.script.__dshTavernSessionId
  release(host, retiring)
  assert.deepEqual(handlers(jq, button), [own])
})
