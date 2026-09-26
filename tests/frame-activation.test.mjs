import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

test('实际消息组件离开视区或卸载时取消启动，开场 eager 不入队', () => {
  const bundle = readFileSync(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  const frames = new Map(), timers = new Map(), observers = [], activated = []
  let id = 0, descriptor, rendering
  const host = {
    __ModuleLoader__: { load(value) { descriptor = value } },
    requestAnimationFrame(run) { frames.set(++id, run); return id }, cancelAnimationFrame(id) { frames.delete(id) },
    setTimeout(run) { timers.set(++id, run); return id }, clearTimeout(id) { timers.delete(id) },
    IntersectionObserver: class {
      constructor(run) { this.run = run; observers.push(this) }
      observe() {} disconnect() { this.disconnected = true }
    },
  }
  const React = {
    useRef: value => ({ current: value }),
    useSyncExternalStore: () => [],
    useEffect: run => rendering.effects.push(run), useLayoutEffect() {},
    useState(value) {
      const state = rendering, index = state.states++
      return [typeof value === 'function' ? value() : value, value => { if (index === 1) activated.push([state.name, value]) }]
    },
    createElement(type, props, ...children) { if (props?.ref && typeof props.ref === 'object') props.ref.current = {}; return { type, props, children } },
  }
  vm.runInNewContext(bundle, { window: host, console })
  const client = descriptor.factory(name => name === 'react' ? React : {})
  function mount(name, eager = false) {
    rendering = { name, effects: [], states: 0 }
    client.TavernMessageFrame({ content: '<p>正文</p>', turn: 1, partIndex: 0, eager })
    return rendering.effects[2]()
  }
  const tick = tasks => { const runs = [...tasks.values()]; tasks.clear(); runs.forEach(run => run()) }
  const leave = mount('leave'), unmount = mount('unmount'), stay = mount('stay')
  tick(timers)
  for (const observer of observers) observer.run([{ isIntersecting: true }])
  assert.equal(frames.size, 1)
  observers[0].run([{ isIntersecting: false }])
  unmount()
  tick(frames)
  assert.deepEqual(activated, [['stay', true]])
  observers[0].run([{ isIntersecting: true }])
  tick(frames)
  assert.deepEqual(activated, [['stay', true], ['leave', true]])
  assert.equal(observers[0].disconnected, true)
  mount('opening', true)
  assert.deepEqual(activated.at(-1), ['opening', true])
  assert.equal(frames.size, 0)
  leave(); stay()
})
