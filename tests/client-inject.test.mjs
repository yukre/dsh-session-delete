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
  'logger', 'slots', 'locale', 'remote', 'remoteAccess',
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

test('every ctx member the client uses is declared in inject', () => {
  const module = loadClientModule()
  const declared = new Set([...(module.inject ?? [])])
  const missing = usedContextMembers()
    .filter(name => !declared.has(name) && !ALWAYS_PRESENT.has(name))
  assert.deepEqual(
    missing,
    [],
    `lib/client.js reads ctx.${missing.join(', ctx.')} but inject is ${JSON.stringify([...declared])};`
    + ' an undeclared service is undefined at apply time and takes the plugin down',
  )
})

test('the client module survives apply with only its declared services', () => {
  const module = loadClientModule()
  const declared = new Set([...(module.inject ?? [])])
  // Build a context that offers exactly what was declared, nothing more, so an
  // undeclared dependency shows up as a throw rather than being papered over.
  const context = {
    effect: fn => { fn() },
    slots: { inject: (name, cb) => cb(), register: () => () => {} },
  }
  if (declared.has('contextMenus')) {
    context.contextMenus = { register: () => () => {} }
  }
  assert.doesNotThrow(() => { module.apply(context) })
})

test('the menu contribution is ordered after the built-in Archive row', () => {
  const module = loadClientModule()
  let contribution
  module.apply({
    effect: fn => { fn() },
    contextMenus: { register: value => { contribution = value; return () => {} } },
    slots: { inject: (name, cb) => cb(), register: () => () => {} },
  })
  assert.ok(contribution !== undefined, 'the client registered no menu contribution')
  assert.equal(contribution.target, 'session')
  // Archive contributes at 600 and reserves the footer; both must hold here.
  assert.ok(contribution.order > 600, `order ${contribution.order} is not past Archive`)
  const actions = contribution.resolve({ sessionId: 'session-x', displayTitle: 'T' })
  assert.equal(actions.length, 1)
  assert.equal(actions[0].afterContent, true, 'the row must render in the footer with Archive')
  assert.equal(actions[0].danger, true)
})
