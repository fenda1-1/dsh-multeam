/**
 * Browser registration for the Agent Teams panel.
 *
 * Mounts two surfaces on the Client Context:
 *   1. the conversation-header action (a hover/click popover with the roster and
 *      read-only task board), and
 *   2. the right-sidebar "多人团队" tab (the full team board with list/graph
 *      views, member grouping, task detail, and the team chat timeline).
 *
 * Both read the Lead Session's `agentTeam` projection from the shared Session
 * store; this registration performs no Team RPC.
 */

import { installStyles } from './styles.js'
import { NS, en, zh } from './locales.js'
import { TeamAction } from './action.js'
import { TeamBoard } from './board.js'

/** Sidebar tab kind and id for the team board. */
export const TEAM_BOARD_KIND = 'multeam-board'
export const TEAM_BOARD_TAB_ID = 'dsh-multeam/team-board'

/** Required browser services for navigation, slots, and localized copy. */
export const inject = ['sessions', 'uiWorkspace', 'slots', 'locale'] as const

/** The slice of the Client Context this registration touches. */
interface TeamClientContext {
	locale: {
		bind(ns: string): (key: string, params?: Record<string, unknown>) => string
		register(ns: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
	}
	sessions: {
		binding(sessionId: string): { session: { getSnapshot(): { subagent?: { address?: { parentSessionId?: string } } } } } | undefined
		retainInfo(sessionId: string): { getSnapshot(): { retainedBy?: { mainView?: number } } }
	}
	slots: {
		inject(name: string, factory: () => unknown): () => void
		register(descriptor: unknown, component: unknown): unknown
	}
	uiWorkspace: {
		openSession(target: unknown): void
		replaceMain?(target: unknown, signal: AbortSignal, mode: 'preserve' | 'reveal'): void
	}
	inject(names: readonly string[], callback: (injected: { get(name: string): unknown }) => () => void): void
	effect(callback: () => (() => void) | void, name?: string): void
}

/**
 * Register the Team locale dictionaries, the conversation-header action, and the
 * sidebar team-board tab.
 * @param ctx - Client Context carrying the injected navigation, locale, slot, and Session services.
 */
export function registerAgentTeamUi(ctx: TeamClientContext): void {
	installStyles()
	const t = ctx.locale.bind(NS)
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-multeam: dictionaries')
	const sessions = ctx.sessions
	const leadSessionId = (sessionId: string): string => sessions.binding(sessionId)?.session.getSnapshot().subagent?.address?.parentSessionId ?? sessionId
	const actions = {
		openTeammate(sessionId: string, childSessionId: string): void {
			const parentSessionId = leadSessionId(sessionId)
			if ((sessions.retainInfo(sessionId).getSnapshot().retainedBy?.mainView ?? 0) === 0) return
			/* uiWorkspace.openSession always switches the main view in "reveal" mode,
			 * which calls selectPanel(null) and closes the right sidebar — from the
			 * team board we use "preserve" to keep the sidebar, degrading to
			 * openSession when replaceMain is unavailable. */
			const target = childSessionId === parentSessionId ? parentSessionId : { parentSessionId, childSessionId, mode: 'continuable' as const }
			if (typeof ctx.uiWorkspace.replaceMain === 'function') {
				ctx.uiWorkspace.replaceMain(target, new AbortController().signal, 'preserve')
				return
			}
			ctx.uiWorkspace.openSession(target)
		},
	}
	ctx.slots.inject('conversation.session.header.actions', () =>
		ctx.slots.register(
			{
				name: 'conversation.session.header.actions',
				id: 'agent-team',
				order: -20,
				locale: NS,
				inject: () => actions,
			},
			TeamAction,
		),
	)
	/* The "多人团队" right-sidebar tab: the type is registered on sidebarRightTabs
	 * (a reflect service reached via ctx.inject/get), and the component sits in
	 * sidebar.right.pane.tab alongside better-sidebar's tabs. */
	ctx.inject(['sidebarRightTabs'], (injected) => {
		const tabs = injected.get('sidebarRightTabs') as
			| { register(descriptor: unknown): () => void }
			| undefined
		if (tabs === undefined) return
		const disposeType = tabs.register({
			id: TEAM_BOARD_TAB_ID,
			kind: TEAM_BOARD_KIND,
			priority: 'extension',
			title: () => t('board.tabTitle'),
			guide: [{ id: TEAM_BOARD_KIND, order: 50, title: () => t('board.tabTitle') }],
		})
		const disposeTab = ctx.slots.inject('sidebar.right.pane.tab', () =>
			ctx.slots.register(
				{
					name: 'sidebar.right.pane.tab',
					key: TEAM_BOARD_TAB_ID,
					locale: NS,
					inject: (sessionId: string) => ({
						...actions,
						sessions,
						sessionId,
						onError: (message: string) => console.error('dsh-multeam:', message),
					}),
				},
				TeamBoard,
			),
		)
		return () => {
			disposeTab?.()
			disposeType?.()
		}
	})
}
