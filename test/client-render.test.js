/**
 * Real-render regression test for the web team board.
 *
 * Why this file exists: tsdown/rolldown performs no name resolution for bare
 * identifiers. A component that references `react.Fragment` without binding
 * `react` keeps that reference verbatim in the bundle — `node --check` passes,
 * the build passes, and the failure only surfaces when the user opens the tab
 * that renders that branch ("ReferenceError: react is not defined"). A previous
 * iteration shipped exactly that and blanked the task view.
 *
 * `client-smoke.mjs` cannot catch this: it only executes the factory's top-level
 * statements and never calls a component function body — and its React stub
 * hands out `Fragment`, which masks the very defect. So this harness renders
 * every registered component with a stub React that deliberately withholds
 * `Fragment`, then walks the four views of the board.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '../dist/client.js')

const req = createRequire(import.meta.url)
const realReact = req('react')
const realJsx = req('react/jsx-runtime')

const src = readFileSync(BUNDLE, 'utf8')
const MARKER = 'factory: (require) => {'
const bodyStart = src.indexOf(MARKER)
const bodyEnd = src.lastIndexOf('return module.exports;')
assert.ok(bodyStart !== -1 && bodyEnd !== -1, 'bundle must expose a ModuleLoader factory')
const factorySource = `${src.slice(bodyStart + MARKER.length, bodyEnd)} return module.exports;`

/* Hook state is a *stack* of frames, not a flat array. Real React matches
 * hooks by call order *within a component*, so a child component's useState
 * never bleeds into the parent's indices. A flat cursor makes `TeamBoardMemberRow`'s
 * `useState(false)` (expanded) collide with `TeamBoardChat`'s `useState("")`
 * (query) the moment the view switches and the row goes out of scope. */
const hookStack = [createFrame()]
function createFrame() {
	return { states: [], cursor: 0, setters: [] }
}
function currentFrame() { return hookStack[hookStack.length - 1] }
const stubReact = {
	...realReact,
	useState: (init) => {
		const frame = currentFrame()
		const i = frame.cursor++
		if (frame.states[i] === undefined) frame.states[i] = typeof init === 'function' ? init() : init
		const root = hookStack[0]
		if (root.states[i] === undefined) root.states[i] = frame.states[i]
		const set = (v) => {
			const next = typeof v === 'function' ? v(frame.states[i]) : v
			frame.states[i] = next
			root.states[i] = next
		}
		if (root.setters[i] === undefined) root.setters[i] = set
		return [frame.states[i], set]
	},
	useEffect: () => {},
	useLayoutEffect: () => {},
	useRef: (init) => ({ current: init }),
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	useSyncExternalStore: (sub, get) => get(),
}
/* The whole point: withhold Fragment. If the bundle reaches for
 * `<anything>.Fragment` without binding that name, this test must blow up the
 * same way the browser does. */
delete stubReact.Fragment
const stubJsx = { ...realJsx }

/* TeamAction portals its popover into document.body. A minimal shell is enough
 * for the evaluator, which only needs the expression to be reachable. */
globalThis.document ??= {
	body: { appendChild: () => {}, removeChild: () => {} },
	createElement: () => ({ style: {}, dataset: {}, setAttribute: () => {}, appendChild: () => {} }),
	querySelector: () => null,
	getElementById: () => null,
	head: { appendChild: () => {}, removeChild: () => {} },
	addEventListener: () => {},
	removeEventListener: () => {},
}

const captured = { slots: [] }
const dictionary = { zh: {}, en: {} }
const t = (key, params) => {
	let s = dictionary.zh[key] ?? key
	if (params && typeof params === 'object') {
		for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v))
	}
	return s
}

/* A projection with real tasks: an empty task list renders only the empty
 * state, which never reaches the task card that crashed. */
const lead = 'session-lead-0001'
const projection = {
	id: lead,
	members: [
		{ id: lead, name: 'lead', role: 'lead', phase: 'active' },
		{ id: 'session-teammate-0002', name: 'tool-auditor', role: 'teammate', phase: 'active', status: 'inactive' },
	],
	tasks: [
		{
			id: 'task-1', subject: '审计 multeam 工具层', status: 'completed', ownerName: 'tool-auditor',
			priority: 'high', revision: 4, createdAt: Date.now() - 6e5, updatedAt: Date.now() - 1e3,
			description: '逐项实测 12 个工具', writeScopeWarnings: [], blockedBy: [],
		},
		{
			id: 'task-2', subject: '修复 board 漏导入', status: 'in_progress', ownerName: 'lead',
			priority: 'medium', revision: 1, createdAt: Date.now() - 6e5, updatedAt: Date.now() - 5e3,
			description: '补 react.Fragment', writeScopeWarnings: [], blockedBy: ['task-1'],
		},
	],
	messages: [
		{ id: 'm1', from: 'lead', to: 'tool-auditor', text: '任务书：审计 12 个工具', queuedAt: 1e3, status: 'delivered' },
		{ id: 'm2', from: 'tool-auditor', to: 'lead', text: '收到，开始审计', queuedAt: 2e3, status: 'delivered' },
		{ id: 'm3', from: 'lead', to: 'tool-auditor', text: '补一条 write_scopes 说明', queuedAt: 3e3, status: 'delivered' },
		{ id: 'm4', from: 'tool-auditor', to: 'lead', text: '审计产物已落盘', queuedAt: 4e3, status: 'delivered' },
		/* Only touches lead: without a message the other party is absent from,
		 * a filter assertion cannot tell "filtered" from "not filtered". */
		{ id: 'm5', from: 'lead', to: 'lead', text: '自留备注：待重启生效', queuedAt: 5e3, status: 'delivered' },
	],
}

const sessions = {
	list: {
		subscribe: () => () => {},
		getSnapshot: () => ({
			byId: { [lead]: { session: { getSnapshot: () => ({}) } } },
			projectionsBySession: { [lead]: { values: { agentTeam: projection } } },
			binding: () => undefined,
		}),
	},
	binding: () => undefined,
	retainInfo: () => ({ getSnapshot: () => ({ retainedBy: { mainView: 1 } }) }),
	projections: { [lead]: { values: { agentTeam: projection } } },
}

/* Primitives are stubbed permissively on purpose: this test targets multeam's
 * own unresolved identifiers, not the host component library. */
const primitives = new Proxy(
	{
		Button: 'Button', Icon: 'Icon', Tooltip: 'Tooltip', Scrollable: 'Scrollable',
		MarkdownText: (props) => stubJsx.jsx('div', { ...props, children: props.children ?? props.text ?? null }),
		extractMarkdownPlainText: (text) => String(text ?? ''),
		TEAM_BOARD_STATUS_COLORS: {},
	},
	{
		get(target, prop) {
			if (prop in target) return target[prop]
			if (typeof prop === 'string' && prop.startsWith('use')) return () => undefined
			return () => null
		},
	},
)

const required = new Map([
	['react', stubReact],
	['react/jsx-runtime', stubJsx],
	['react-dom', { createRoot: () => ({ render: () => {}, unmount: () => {} }), flushSync: (fn) => fn(), createPortal: () => null }],
	['@deepseek-ai/dsh-client-ui-primitives', primitives],
	['@deepseek-ai/dsh-client-locale', { useLocale: () => ({ t }) }],
	['@deepseek-ai/dsh-client-ui-conversation', {
		/* TeamAction 由 conversation 头部插槽渲染，这两个 hook 从该包注入。 */
		useSession: (select) => select?.({ subagent: undefined, openState: 'ready' }) ?? undefined,
		useSessions: (select) => select?.(sessions.list.getSnapshot()),
		useSessionStatus: () => undefined,
	}],
	['@deepseek-ai/dsh-client-ui-workspace', {}],
	['@deepseek-ai/dsh-api-session-controller', {
		useSession: (select) => select?.({ subagent: undefined }) ?? undefined,
		useSessions: () => sessions.list.getSnapshot(),
	}],
])

const mod = new Function('require', factorySource)((id) => {
	const hit = required.get(id)
	if (hit !== undefined) return hit
	throw new Error(`unexpected require("${id}") — add a stub for it`)
})

const stubCtx = {
	effect: (fn) => fn(),
	inject: (names, fn) => {
		const m = new Map()
		for (const n of names) m.set(n, { register: () => () => {} })
		return fn(m)
	},
	on: () => () => {},
	set: () => () => {},
	scope: () => stubCtx,
	locale: { bind: () => t, register: (ns, dict) => { dictionary.zh = dict.zh; dictionary.en = dict.en } },
	sessions,
	uiWorkspace: { replaceMain: () => {}, openSession: () => {} },
	slots: {
		inject: (name, fn) => fn(),
		register: (def, component) => {
			captured.slots.push({ name: def?.name ?? name, def, component })
			return () => {}
		},
	},
	logger: { info() {}, warn() {}, error() {} },
}
stubCtx.root = stubCtx
mod.apply(stubCtx)

const slotName = (s) => s.def?.name ?? s.name
const board = captured.slots.find((s) => slotName(s) === 'sidebar.right.pane.tab' && typeof s.component === 'function')
assert.ok(board !== undefined, `board panel must register a component; got slots=${captured.slots.map(slotName).join(',')}`)

/* Minimal evaluator: call function components and walk children. There is no
 * react-dom here — the goal is only to force every JSX branch to be evaluated. */
let depth = 0
/* Messages the chat view actually produced. A React element's key is
 * `message.id` (board's chat list keys each card by it), so the keys that reach
 * the evaluator are exactly the messages that survived the member filter. */
let seenMessageKeys = new Set()
/* Clickable rows surfaced by the current render: the member panels are plain
 * `<button onClick=...>` elements, so replaying a click means calling the
 * handler the board itself wired up — no guessing at setter indices. */
let clickable = []
/* Flatten an element tree to its text, for labelling buttons the markup does
 * not give a title (the view tabs). */
function plainText(node) {
	if (node === null || node === undefined || typeof node === 'boolean') return ''
	if (typeof node === 'string' || typeof node === 'number') return String(node)
	if (Array.isArray(node)) return node.map(plainText).join('')
	if (typeof node === 'object') return plainText(node.props?.children)
	return ''
}
function evaluate(node) {
	if (node === null || node === undefined || typeof node === 'boolean') return null
	if (typeof node === 'string' || typeof node === 'number') return node
	if (Array.isArray(node)) return node.map(evaluate)
	if (typeof node === 'function') return evaluate(node({}))
	if (typeof node === 'object') {
		if (typeof node.key === 'string' && /^m\d+$/.test(node.key)) seenMessageKeys.add(node.key)
		if (node.type === 'button' && typeof node.props?.onClick === 'function') {
			clickable.push({
				onClick: node.props.onClick,
				title: node.props.title ?? node.key,
				className: typeof node.props.className === 'string' ? node.props.className : '',
				label: plainText(node.props.children),
			})
		}
		if (node.$$typeof === Symbol.for('react.fragment') || node.type === realReact.Fragment || node.type === 'Fragment') {
			return evaluate(node.props?.children ?? null)
		}
		if (typeof node.type === 'function') {
			depth++
			if (depth > 60) return null
			/* The *top-level* component runs on the root frame, so state a setter
			 * wrote survives into the next render — that is what makes
			 * `setView("chat")` visible on the following pass. Every nested
			 * component gets its own frame, so a child's useState cannot pollute
			 * a sibling's indices (a flat cursor makes `TeamBoardMemberRow`'s
			 * `expanded` collide with `TeamBoardChat`'s `query`). */
			const nested = depth > 1
			if (nested) hookStack.push(createFrame())
			try {
				const out = evaluate(node.type({ ...node.props, t }))
				return out
			} finally {
				if (nested) hookStack.pop()
				depth--
			}
		}
		if (typeof node.type === 'string') return evaluate(node.props?.children ?? null)
		return null
	}
	return null
}

/* `conversation.session.header.actions` carries a `standardProps` list: the
 * framework hands every occupant useSession/useSessions/useSessionStatus and
 * the rest, on top of whatever the descriptor's own `inject` factory returns.
 * The harness must reproduce that, otherwise TeamAction fails for a reason the
 * browser never sees. */
const useSession = (select) => select?.({ subagent: undefined, openState: 'ready' }) ?? undefined
const useSessions = (select) => select?.(sessions.list.getSnapshot())
const useSessionStatus = () => undefined

const renderProps = {
	sessionId: lead,
	sessions,
	useSession,
	useSessions,
	useSessionStatus,
	openTeammate: () => {},
	onError: () => {},
	t,
}
function render() {
	currentFrame().cursor = 0
	seenMessageKeys = new Set()
	clickable = []
	return evaluate(stubJsx.jsx(board.component, renderProps))
}

render()

const setters = hookStack[0].setters.filter((s) => typeof s === 'function')
assert.ok(setters.length > 0, 'board must use state, otherwise the view cannot switch')

setters[0]('tasks')
render()

setters[2](['task-1'])
render()

setters[2]([])
/* Switch views by clicking the tabs the board renders, not by guessing which
 * useState slot holds the view: the tab handler is the same code path a user
 * hits. */
const clickTab = (label) => {
	const tab = clickable.find((c) => c.className.includes('tab') && c.label.includes(label))
	assert.ok(tab !== undefined, `no tab labelled ${label}; got ${clickable.map((c) => c.label).join('|')}`)
	tab.onClick()
	render()
}
clickTab('对话记录')

/* ── member click must actually filter the conversation log ──────────────
 * Regression: the roster rows handed the selection callback `member.id` while
 * the chat member panel handed it a *name* (messages only carry names). Both
 * fed the same piece of state, so the id was stored, `selectedName` resolved to
 * undefined and the filter short-circuited — clicking a member highlighted the
 * row and changed nothing else. */
assert.equal(seenMessageKeys.size, 5, `unfiltered chat must show every message, got ${[...seenMessageKeys].sort().join(',')}`)

const chatMember = clickable.filter((c) => typeof c.title === 'string' && /^(lead|tool-auditor)$/.test(c.title))
assert.ok(chatMember.length > 0, `chat member panel must render clickable rows; got ${clickable.map((c) => c.title).join(',')}`)

/* tool-auditor participates in m1-m4 but not m5, so selecting it must drop m5. */
chatMember.find((c) => c.title === 'tool-auditor').onClick()
render()
assert.deepEqual(
	[...seenMessageKeys].sort(),
	['m1', 'm2', 'm3', 'm4'],
	`clicking tool-auditor must filter the log to its own messages; got ${[...seenMessageKeys].sort().join(',')}`,
)

/* lead is on every message, so selecting it must restore all five — this
 * doubles as the "the filter is live, not stuck" check. */
const leadRow = clickable.find((c) => c.title === 'lead')
assert.ok(leadRow !== undefined, 'chat member panel must offer a lead row')
leadRow.onClick()
render()
assert.deepEqual(
	[...seenMessageKeys].sort(),
	['m1', 'm2', 'm3', 'm4', 'm5'],
	`clicking lead must widen the log back to every message; got ${[...seenMessageKeys].sort().join(',')}`,
)

/* Every registered component gets rendered too — the header action shares the
 * same missing-binding failure mode. */
for (const s of captured.slots) {
	if (typeof s.component !== 'function' || s === board) continue
	depth = 0
	currentFrame().cursor = 0
	evaluate(stubJsx.jsx(s.component, renderProps))
}

console.log('client render: OK')
