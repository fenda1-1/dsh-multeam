/**
 * Real-render smoke test for the browser bundle.
 *
 * `node --check` only catches syntax errors, and a whole class of client bugs
 * (`xxx is not defined` at render time) survives it. This harness loads
 * `dist/client.js` through a stub `window.__ModuleLoader__`, executes the
 * factory with a stub React, and renders every component with crafted props —
 * so a missing binding fails the build instead of the browser.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BUNDLE = new URL('../dist/client.js', import.meta.url)

/** Minimal React stub: hooks with a per-render reset, jsx/jsxs returning plain trees. */
function makeReact() {
	const hookState = []
	let cursor = 0
	const reset = () => {
		cursor = 0
	}
	const next = () => hookState[cursor++] ?? { value: undefined }
	const react = {
		useState(init) {
			const slot = next()
			if (slot.value === undefined && init !== undefined) slot.value = typeof init === 'function' ? init() : init
			const setter = (v) => {
				slot.value = typeof v === 'function' ? v(slot.value) : v
			}
			return [slot.value, setter]
		},
		useRef(init) {
			const slot = next()
			if (slot.value === undefined) slot.value = { current: init }
			return slot.value
		},
		useEffect() { cursor++; return undefined },
		useLayoutEffect() { cursor++; return undefined },
		useCallback(fn) { cursor++; return fn },
		useMemo(fn) {
			const slot = next()
			if (!('memo' in slot)) slot.memo = { value: fn() }
			return slot.memo.value
		},
		useSyncExternalStore(_sub, get) { cursor++; return get() },
	}
	const runtime = {
		jsx: (type, props) => ({ type, props: props ?? {} }),
		jsxs: (type, props) => ({ type, props: props ?? {} }),
		Fragment: 'Fragment',
	}
	const reactDom = { createPortal: (children) => ({ type: 'Portal', children }) }
	return { react, runtime, reactDom, reset, hookState }
}

/** Stub the primitives the board imports, so nothing escapes into DSH. */
function makePrimitives() {
	const passthrough = (name) => {
		const C = (props) => ({ type: name, props: props ?? {} })
		C.displayName = name
		return C
	}
	return {
		StateDot: passthrough('StateDot'),
		Tag: passthrough('Tag'),
		Tooltip: passthrough('Tooltip'),
		IconUsersOutlineRegular: passthrough('IconUsersOutlineRegular'),
		IconUserOutlineRegular: passthrough('IconUserOutlineRegular'),
		IconChevronDownOutlineRegular: passthrough('IconChevronDownOutlineRegular'),
		useAnchoredPosition: () => null,
		useDismissOnOutsidePointer: () => undefined,
	}
}

/** Load the ModuleLoader bundle under a stub global and return its exports. */
function loadBundle() {
	const src = readFileSync(BUNDLE, 'utf8')
	const { react, runtime, reactDom } = makeReact()
	const primitives = makePrimitives()
	const registry = new Map()
	const sandboxRequire = (id) => {
		if (id === 'react') return react
		if (id === 'react/jsx-runtime') return runtime
		if (id === 'react-dom') return reactDom
		if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
		throw new Error(`unexpected require(${JSON.stringify(id)})`)
	}
	const factory = new Function('window', 'require', 'module', 'exports', `${src}\nreturn module.exports`)
	const win = { __ModuleLoader__: { load: (d) => registry.set(d.id, d) } }
	const mod = { exports: {} }
	factory(win, sandboxRequire, mod, mod.exports)
	const entry = registry.get('dsh-multeam/client')
	assert.ok(entry !== undefined, 'ModuleLoader registration must use the client id')
	const exports = entry.factory(sandboxRequire)
	return { exports, react, runtime, primitives }
}

const T = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)

/** A minimal Session-store stub shaped like the board's selectors expect. */
function makeSessions(overrides = {}) {
	const list = {
		byId: {},
		binding: () => undefined,
		projectionsBySession: {},
		...(overrides.list ?? {}),
	}
	const store = {
		subscribe: () => () => undefined,
		getSnapshot: () => list,
	}
	return {
		list: store,
		binding: (id) => list.binding?.(id),
		retainInfo: () => ({ getSnapshot: () => ({ retainedBy: { mainView: 1 } }) }),
		...overrides,
		list: store,
	}
}

const member = (id, name, extra = {}) => ({ id, name, phase: 'active', status: 'idle', description: 'impl', ...extra })

const task = (id, extra = {}) => ({
	id,
	revision: 1,
	subject: `任务 ${id}`,
	description: '描述',
	status: 'pending',
	blockedBy: [],
	writeScopes: [],
	ready: true,
	writeScopeWarnings: [],
	history: [{ revision: 1, action: 'create', status: 'pending', at: Date.now() }],
	createdAt: Date.now(),
	updatedAt: Date.now(),
	...extra,
})

describe('client bundle: ModuleLoader contract', () => {
	it('registers under the client id and exports apply/inject/NS', () => {
		const { exports } = loadBundle()
		assert.equal(typeof exports.apply, 'function')
		assert.deepEqual([...exports.inject], ['sessions', 'uiWorkspace', 'slots', 'locale'])
		assert.equal(exports.NS, 'agent-team')
		assert.equal(exports.TEAM_BOARD_KIND, 'multeam-board')
		assert.equal(exports.TEAM_BOARD_TAB_ID, 'dsh-multeam/team-board')
	})

	it('zh and en dictionaries are key-symmetric', () => {
		const { exports } = loadBundle()
		const zh = Object.keys(exports.zh).sort()
		const en = Object.keys(exports.en).sort()
		assert.deepEqual(zh, en, 'zh/en must stay key-symmetric')
		assert.ok(zh.length > 50, `expected a real dictionary, got ${zh.length} keys`)
	})
})

describe('client bundle: installStyles', () => {
	it('injects both stylesheets once and is idempotent', () => {
		const { exports } = loadBundle()
		const appended = []
		globalThis.document = {
			head: { appendChild: (tag) => appended.push(tag) },
			querySelector: (sel) => (appended.some((t) => `style[data-plugin-css="${t.dataset.pluginCss}"]` === sel) ? {} : null),
			createElement: () => ({ dataset: {}, textContent: '' }),
		}
		try {
			exports.installStyles()
			exports.installStyles()
			assert.equal(appended.length, 2, 'both stylesheets injected exactly once')
			assert.ok(appended.every((t) => t.textContent.length > 1000), 'stylesheet bodies are non-trivial')
			assert.equal(appended[0].dataset.pluginCss, 'dsh-multeam/TeamAction.module.css')
			assert.equal(appended[1].dataset.pluginCss, 'dsh-multeam/TeamBoard.module.css')
		} finally {
			delete globalThis.document
		}
	})
})

describe('client bundle: mount registration', () => {
	it('registers the header action and the sidebar tab', () => {
		const { exports } = loadBundle()
		const registered = []
		const slotInjects = []
		const ctx = {
			locale: {
				bind: () => T,
				register: () => () => undefined,
			},
			sessions: makeSessions(),
			slots: {
				inject: (name, factory) => {
					slotInjects.push(name)
					factory()
					return () => undefined
				},
				register: (descriptor, component) => {
					registered.push({ descriptor, component })
					return () => undefined
				},
			},
			uiWorkspace: { openSession: () => undefined },
			inject: (names, cb) => {
				assert.deepEqual([...names], ['sidebarRightTabs'])
				return cb({ get: () => ({ register: () => () => undefined }) })
			},
			effect: (cb) => cb(),
		}
		exports.apply(ctx)
		assert.deepEqual(slotInjects, ['conversation.session.header.actions', 'sidebar.right.pane.tab'])
		assert.equal(registered.length, 2, 'two slot registrations')
		assert.equal(registered[0].descriptor.id, 'agent-team')
		assert.equal(registered[1].descriptor.key, exports.TEAM_BOARD_TAB_ID)
		assert.equal(typeof registered[0].component, 'function')
		assert.equal(typeof registered[1].component, 'function')
	})
})

describe('client bundle: component render smoke', () => {
	it('renders TeamBoard with members, tasks, and an empty chat', () => {
		const { exports, react } = loadBundle()
		const TeamBoard = exports.__board ?? undefined
		// The bundle only re-exports the entry surface; reach the component through
		// the slot registration instead of adding a test-only export.
		const registered = []
		const ctx = {
			locale: { bind: () => T, register: () => () => undefined },
			sessions: makeSessions({
				list: {
					byId: {},
					binding: () => undefined,
					projectionsBySession: {
						'lead-1': { values: { agentTeam: { members: [member('lead-1', 'lead')], tasks: [task('task-1')], messages: [] } } },
					},
				},
			}),
			slots: {
				inject: (_name, factory) => {
					factory()
					return () => undefined
				},
				register: (descriptor, component) => {
					registered.push({ descriptor, component })
					return () => undefined
				},
			},
			uiWorkspace: { openSession: () => undefined },
			inject: (_names, cb) => cb({ get: () => ({ register: () => () => undefined }) }),
			effect: (cb) => cb(),
		}
		exports.apply(ctx)
		const board = registered[1].component
		const element = board({
			sessionId: 'lead-1',
			sessions: ctx.sessions,
			openTeammate: () => undefined,
			onError: (m) => { throw new Error(m) },
			t: T,
		})
		assert.ok(element !== undefined && element !== null, 'TeamBoard must render')
		// Walk the tree: a null child is the classic "white screen" symptom.
		const seen = []
		const walk = (node, depth) => {
			if (node === null || node === undefined || node === false) return
			if (typeof node === 'string' || typeof node === 'number') {
				seen.push(node)
				return
			}
			if (Array.isArray(node)) {
				for (const child of node) walk(child, depth)
				return
			}
			if (typeof node.type === 'function') {
				react.reset?.()
				walk(node.type(node.props), depth + 1)
				return
			}
			walk(node.props?.children, depth)
		}
		walk(element, 0)
		assert.ok(seen.length > 0, 'rendered tree must contain text')
	})

	it('renders the header action (TeamAction) with a single-member team', () => {
		const { exports, react } = loadBundle()
		const registered = []
		const ctx = {
			locale: { bind: () => T, register: () => () => undefined },
			sessions: makeSessions({
				list: {
					byId: {},
					binding: () => undefined,
					projectionsBySession: {
						'lead-1': { values: { agentTeam: { members: [member('lead-1', 'lead')], tasks: [], messages: [] } } },
					},
				},
			}),
			slots: {
				inject: (_name, factory) => {
					factory()
					return () => undefined
				},
				register: (descriptor, component) => {
					registered.push({ descriptor, component })
					return () => undefined
				},
			},
			uiWorkspace: { openSession: () => undefined },
			inject: (_names, cb) => cb({ get: () => ({ register: () => () => undefined }) }),
			effect: (cb) => cb(),
		}
		exports.apply(ctx)
		const action = registered[0].component
		const element = action({
			sessionId: 'lead-1',
			useSession: (selector) => selector({ subagent: undefined, openState: 'ready' }),
			useSessions: (selector) =>
				selector({
					projectionsBySession: {
						'lead-1': { values: { agentTeam: { members: [member('lead-1', 'lead')], tasks: [], messages: [] } } },
					},
					byId: {},
					phase: 'ready',
				}),
			useSessionStatus: (selector) => selector(new Map()),
			openTeammate: () => undefined,
			t: T,
		})
		assert.ok(element !== undefined && element !== null, 'TeamAction must render')
		void react
	})
})
