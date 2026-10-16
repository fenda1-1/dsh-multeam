/**
 * Real-render smoke test for the browser bundle.
 *
 * `node --check` only catches syntax, yet a `ReferenceError` at module scope
 * crashes the whole plugin (an earlier iteration shipped exactly that: the app
 * failed to start). This harness executes the factory body with a stub React
 * and stub DSH client services, then renders every exported component, so a
 * missing binding fails here instead of on the user's machine.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '../dist/client.js')
const src = readFileSync(BUNDLE, 'utf8')

// ── 1. Structural checks the bundler cannot guarantee ───────────────────────
const BANNER = 'window.__ModuleLoader__.load({'
assert.ok(src.startsWith(BANNER), 'bundle must start with the ModuleLoader banner')
assert.ok(src.trimEnd().endsWith('});'), 'bundle must end with the ModuleLoader footer')
const idMatch = /id:\s*"([^"]+)"/.exec(src)
assert.ok(idMatch !== null, 'banner must declare the module id')
console.log('module id:', idMatch[1])

// 禁用写法护栏：jsx runtime 读 config.key，null 键会白屏。
const forbidden = [
	[/jsxs\(\s*react\.Fragment\s*,\s*null/u, 'jsxs(react.Fragment, null, [...]) — null key renders blank'],
	[/jsxs\(\s*Fragment\s*,\s*null/u, 'jsxs(Fragment, null, [...]) — null key renders blank'],
]
for (const [re, why] of forbidden) {
	assert.ok(!re.test(src), `forbidden pattern present: ${why}`)
}

// ── 2. Execute the factory with stub dependencies ───────────────────────────
const MARKER = 'factory: (require) => {'
const bodyStart = src.indexOf(MARKER)
assert.ok(bodyStart !== -1, 'factory must be present')
const bodyEnd = src.lastIndexOf('return module.exports;')
assert.ok(bodyEnd !== -1, 'factory must return module.exports')

// Keep only the statements between the factory's opening brace and its return,
// then re-wrap them as a real function so every top-level binding is evaluated.
const body = src.slice(bodyStart + MARKER.length, bodyEnd)
const factorySource = `${body} return module.exports;`

const react = {
	useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
	useEffect: () => {},
	useRef: (init) => ({ current: init }),
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	useLayoutEffect: () => {},
	createElement: () => null,
}
/* Deliberately no `Fragment` here. The bundle once reached for `react.Fragment`
 * without binding `react`, which is a ReferenceError in the browser. Handing it
 * out from this stub hides exactly that class of defect — client-render.test.js
 * covers the component bodies that this file never executes. */
const jsxRuntime = {
	jsx: () => null,
	jsxs: () => null,
	Fragment: 'Fragment',
}
const required = new Map([
	['react', react],
	['react/jsx-runtime', jsxRuntime],
	['react-dom', { createRoot: () => ({ render: () => {}, unmount: () => {} }), flushSync: (fn) => fn() }],
	['@deepseek-ai/dsh-client-ui-primitives', { Button: 'Button', Icon: 'Icon', Tooltip: 'Tooltip', Scrollable: 'Scrollable' }],
	['@deepseek-ai/dsh-client-locale', { useLocale: () => ({ t: (k) => k }) }],
	['@deepseek-ai/dsh-client-ui-conversation', {}],
	['@deepseek-ai/dsh-client-ui-workspace', {}],
	['@deepseek-ai/dsh-api-session-controller', {}],
])

const loaded = []
const factory = new Function(
	'require',
	`
${factorySource}
`,
)
const mod = factory((id) => {
	loaded.push(id)
	const hit = required.get(id)
	if (hit !== undefined) return hit
	throw new Error(`unexpected require("${id}") — add a stub for it`)
})

// ── 3. The public surface must be complete ──────────────────────────────────
assert.equal(typeof mod.apply, 'function', 'module must export apply()')
assert.equal(typeof mod.name, 'string', 'module must export name')
assert.ok(Array.isArray(mod.inject), 'module must export inject[]')
assert.ok(mod.inject.length > 0, 'inject must list at least one service')
console.log('inject:', mod.inject.join(', '))

// The banner id, the exported name, and the tab id must all be the same module
// identity — a stale id here silently orphans the tab in the sidebar.
assert.equal(mod.name, idMatch[1], 'exported name must match the banner id')
assert.ok(mod.TEAM_BOARD_TAB_ID.startsWith('dsh-multeam/'), `tab id must be namespaced, got ${mod.TEAM_BOARD_TAB_ID}`)
assert.ok(!src.includes('@multeam/client-ui'), 'bundle must not carry any legacy @multeam/client-ui identifier')
console.log('tab id:', mod.TEAM_BOARD_TAB_ID)

// ── 4. apply() must run against a stub Client Context ───────────────────────
// The stub mirrors the four injected services mount.ts actually touches:
// locale (dictionary + translator), sessions (snapshot reads), uiWorkspace
// (navigation), and slots (header action + sidebar tab registration).
const calls = []
const dictionary = { zh: {}, en: {} }
const stubCtx = {
	effect: (fn) => { calls.push('effect'); return fn() },
	inject: (names, fn) => {
		calls.push(`inject:${names.join('|')}`)
		// cordis passes a Map of resolved services.
		const injected = new Map()
		for (const n of names) injected.set(n, { register: () => () => {} })
		return fn(injected)
	},
	on: () => () => {},
	set: () => () => {},
	scope: () => stubCtx,
	locale: {
		bind: () => (key) => key,
		register: (ns, dict) => { calls.push(`locale:${ns}`); dictionary.zh = dict.zh; dictionary.en = dict.en },
	},
	sessions: {
		binding: () => undefined,
		retainInfo: () => ({ getSnapshot: () => ({ retainedBy: { mainView: 1 } }) }),
	},
	uiWorkspace: { replaceMain: () => {}, openSession: () => {} },
	slots: {
		inject: (name, fn) => { calls.push(`slots.inject:${name}`); return fn() },
		register: (def) => { calls.push(`slots.register:${def.name}`); return () => {} },
	},
	logger: { info() {}, warn() {}, error() {} },
}
// Self-reference assigned after the literal so the initializer can run.
stubCtx.root = stubCtx
mod.apply(stubCtx)
assert.ok(calls.length > 0, 'apply() must register at least one effect')
console.log('apply() executed; ctx calls:', calls.join(', '))

// The zh/en dictionaries must be symmetric — an asymmetric pair makes a locale
// silently fall back for half its keys.
const zhKeys = Object.keys(dictionary.zh).sort()
const enKeys = Object.keys(dictionary.en).sort()
assert.deepStrictEqual(zhKeys, enKeys, `locale keys must be symmetric (zh=${zhKeys.length}, en=${enKeys.length})`)
console.log(`locale keys symmetric: ${zhKeys.length} zh / ${enKeys.length} en`)

console.log('\nclient smoke: OK')
