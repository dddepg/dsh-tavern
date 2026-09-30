import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Execute the sidebar's real effect and dependencies under summary snapshot churn.
const source = readFileSync(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')

test('opening the card picker reloads cards created outside this browser', async () => {
  const start = source.indexOf('function openPicker()');
  const end = source.indexOf('function closePicker()', start);
  const pickerSource = source.slice(start, end);
  let diskCards = ['original'], cards = ['original'];
  const sandbox = {
    uiMode: 'play', openingPicker: null,
    setMenuSession() {}, setCardEntry() {}, setError() {}, setPicking() {}, setRequestMode() {},
    setCards(value) { cards = value }, console,
    call: async method => method === 'listCards' ? { cards: [...diskCards] } : {},
    tavernErrorHub: { resolve() {}, report() {} }
  };
  vm.runInNewContext(pickerSource, sandbox);
  diskCards.push('converted');
  sandbox.openPicker();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(cards, diskCards, 'newly converted cards must appear without reloading the page');
});
