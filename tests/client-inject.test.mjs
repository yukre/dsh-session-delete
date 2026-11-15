/**
 * Verify the Client half declares every service it touches.
 *
 * A Client plugin receives only the services named in its `inject` array. Using
 * one that is not declared yields `undefined`, and the resulting TypeError is
 * thrown from `apply` — which the host treats as a failed plugin, so the whole
 * feature disappears from the UI with no visible error. That is exactly how this
 * plugin once lost its menu row after switching to `ctx.contextMenus`.
 *
 * The host injects services onto `ctx`, so the check is: every `ctx.<name>` read
 * in the module body must be either declared in `inject` or a context member
 * that is always present.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Context members the host provides without them appearing in `inject`. */
const ALWAYS_PRESENT = new Set([
  'effect', 'inject', 'get', 'provide', 'on', 'emit', 'waterfall',
  'logger', 'locale', 'remote', 'remoteAccess',
])

/**
 * Load the Client module in a sandbox and return its exported face.
 * @returns the module namespace the loader receives.
 */
function loadClientModule() {
  const captured = {}
  const sandbox = {
    window: { __ModuleLoader__: { load: options => { Object.assign(captured, options) } } },
    console,
    document: {
      createElement: () => ({ setAttribute() {}, remove() {}, style: {} }),
      head: { appendChild() {} },
    },
    fetch: async () => ({ json: async () => ({ ok: true }) }),
    DOMException,
    AbortSignal,
  }
  vm.runInNewContext(readFileSync(join(packageRoot, 'lib/client.js'), 'utf8'), sandbox)
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: value => [value, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
    useRef: value => ({ current: value }),
    useSyncExternalStore: () => null,
    useReducer: (fn, initial) => [initial, () => {}],
  }
  return captured.factory(name => (name === 'react' ? react : null))
}

/**
 * Every `ctx.<name>` the module body reads.
 * @returns sorted names.
 */
function usedContextMembers() {
  const source = readFileSync(join(packageRoot, 'lib/client.js'), 'utf8')
  const names = new Set()
  for (const match of source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) names.add(match[1])
  return [...names].sort()
}

test('every ctx member the client uses is either injected or read through ctx.get', () => {
  const module = loadClientModule()
  const declared = new Set([...(module.inject ?? [])])
  const source = readFileSync(join(packageRoot, 'lib/client.js'), 'utf8')
  // A service reached via ctx.get('name') is checked at the call site, so it does
  // not need an inject entry — and for a service the Client catalog does not
  // list (contextMenus), inject cannot resolve it anyway.
  const viaGet = new Set([...source.matchAll(/ctx\.get\(\s*['"]([\w$]+)['"]/g)].map(m => m[1]))
  const missing = usedContextMembers()
    .filter(name => !declared.has(name) && !ALWAYS_PRESENT.has(name) && !viaGet.has(name))
  assert.deepEqual(
    missing,
    [],
    `lib/client.js reads ctx.${missing.join(', ctx.')}, but inject is ${JSON.stringify([...declared])}`
    + ' and it is not read through a checked ctx.get(); reading it directly is undefined at apply time',
  )
})

/**
 * Build a Client context shaped like the real one.
 *
 * The dynamic Client ctx exposes ctx.get / ctx.on / ctx.provide / ctx.effect,
 * and the services a plugin declares in `inject` land on it directly — the
 * working third-party plugins do rely on `ctx.slots` being present. Services
 * NOT listed in the Client Service catalog (contextMenus is one) are still
 * reachable through ctx.get.
 * @param options - which optional services to provide.
 * @returns a context plus a getter for the captured menu contribution.
 */
function clientContext(options = {}) {
  let contribution
  const services = {
    contextMenus: options.withContextMenus === false
      ? undefined
      : { register: value => { contribution = value; return () => {} } },
  }
  const context = {
    get: name => services[name],
    on: () => () => {},
    provide: () => () => {},
    effect: fn => { const dispose = fn(); return dispose ?? (() => {}) },
    slots: { inject: (name, cb) => cb(), register: () => () => {} },
  }
  return { context, contribution: () => contribution }
}

test('the client module survives apply against a real-shaped context', () => {
  const module = loadClientModule()
  assert.doesNotThrow(() => { module.apply(clientContext().context) })
})

test('a missing optional service degrades instead of taking the plugin down', () => {
  const module = loadClientModule()
  // contextMenus is provided by another plugin. If it is absent, the row is
  // skipped — but apply must NOT throw, or the whole plugin unloads.
  assert.doesNotThrow(() => { module.apply(clientContext({ withContextMenus: false }).context) })
})

test('the menu contribution is ordered after the built-in Archive row', () => {
  const module = loadClientModule()
  const built = clientContext()
  module.apply(built.context)
  const contribution = built.contribution()
  assert.ok(contribution !== undefined, 'the client registered no menu contribution')
  assert.equal(contribution.target, 'session')
  // Archive contributes at 600 and reserves the footer; both must hold here.
  assert.ok(contribution.order > 600, `order ${contribution.order} is not past Archive`)
  const actions = contribution.resolve({ sessionId: 'session-x', displayTitle: 'T' })
  assert.equal(actions.length, 1)
  assert.equal(actions[0].afterContent, true, 'the row must render in the footer with Archive')
  assert.equal(actions[0].danger, true)
})
