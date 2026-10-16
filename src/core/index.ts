/** Agent Teams service façade over roster, mailbox, task, and runtime lifecycle owners. */

import { Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import z from '@deepseek-ai/schemastery'
import type { TeamAgent, TeamMemberView, TeamMembership, TeamState, TeamTaskView } from './types.js'
import { teamId } from './types.js'
import { TeamError, errorMessage } from './error.js'
import { TeamActivity } from './activity.js'
import { TeamRuntimeLifecycle } from './lifecycle.js'
import { TeamJournal } from './journal.js'
import { TeamRoster, availability, hasProductivePeer, type TeamRosterContext, type TeamSpawnRequest } from './roster.js'
import { TeamMailbox, type TeamMailboxMetrics, type TeamSendRequest, type TeamSendResult } from './mailbox.js'
import { TeamTaskBoard, assertTaskTransition, TASK_TRANSITIONS, type TeamTaskCreateRequest, type TeamTaskUpdateRequest } from './task-board.js'
import type { TeamChange, TeamMetrics, TeamWaitFilter, TeamWaitResult } from './shapes.js'
import { assertTaskGraphCandidate, TeamTaskGraphError } from './task-graph.js'
import { compressReport, compressTaskBrief, estimateTokens } from './compress.js'
import { detectWriteScopeConflict, scopesOverlap, taskReady } from './task-view.js'
import { messageId, taskId } from './types.js'
import { teamProjectionDefinition } from './projection.js'

const DEFAULT_MAX_MEMBERS = 16
const DEFAULT_MAX_TASKS = 256
const DEFAULT_MAX_PENDING_MESSAGES = 64
const DEFAULT_MAX_MESSAGE_BYTES = 65536
const DEFAULT_DISPOSAL_TIMEOUT_MS = 5000
const DEFAULT_JOURNAL_BACKPRESSURE_WARN_AT = 64
const DEFAULT_WAIT_SPIN_LIMIT = 3

/** Validate one positive safe-integer deployment limit. */
function positiveLimit(name: string, value: number): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new TeamError(`${name} must be a positive safe integer`, 'TEAM_INVALID_CONFIG')
	return value
}

/** Validate one non-negative safe-integer deployment limit where 0 means "disabled". */
function nonNegativeLimit(name: string, value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new TeamError(`${name} must be a non-negative safe integer`, 'TEAM_INVALID_CONFIG')
	return value
}

/** The service context shape, resolved structurally so DSH stays a peer. */
export interface TeamServiceContext {
	agents: TeamRosterContext['agents']
	sessions: TeamRosterContext['sessions']
	sessionPersistence: TeamRosterContext['sessionPersistence']
	subagents: TeamRosterContext['subagents']
	sessionProjections: Parameters<typeof teamProjectionDefinition.init> extends never ? never : ConstructorParameters<typeof Service>[0] extends never ? never : object
	logger?: { warn?(message: string): void; info?(message: string): void; debug?(message: string): void }
	on(event: string, listener: (...args: never[]) => void): () => void
	effect(callback: () => (() => void | Promise<void>) | void, name?: string): void
	root: { sessionProjections: { register(definition: unknown): () => void } }
	get(name: string, optional?: boolean): unknown
}

/** Agent Teams service backed by the exact live Lead Session log. */
export class TeamService extends Service {
	static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'subagents']

	static Config = z.object({
		maxMembers: z.number().step(1).min(1).default(DEFAULT_MAX_MEMBERS),
		maxTasks: z.number().step(1).min(1).default(DEFAULT_MAX_TASKS),
		maxPendingMessagesPerMember: z.number().step(1).min(1).default(DEFAULT_MAX_PENDING_MESSAGES),
		maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
		disposalTimeoutMs: z.number().step(1).min(1).default(DEFAULT_DISPOSAL_TIMEOUT_MS),
		// 0 means "dead-letter detection disabled", so it cannot be min(1).
		deadLetterAfterMs: z.number().step(1).min(0).default(0),
		// 0 means "journal backpressure warning disabled".
		journalBackpressureWarnAt: z.number().step(1).min(0).default(DEFAULT_JOURNAL_BACKPRESSURE_WARN_AT),
		// false keeps write scopes purely advisory; true upgrades a path-prefix
		// overlap on claim / member-bound reassign to a hard rejection.
		enforceWriteScopes: z.boolean().default(true),
		// Consecutive teammate wait timeouts before waitForChange hard-rejects
		// with TEAM_WAIT_SPUN instead of returning another timeout. 0 disables
		// the cap; the Lead is exempt because continuous observing is its job.
		waitSpinLimit: z.number().step(1).min(0).default(DEFAULT_WAIT_SPIN_LIMIT),
	})

	readonly config: {
		maxMembers: number
		maxTasks: number
		maxPendingMessagesPerMember: number
		maxMessageBytes: number
		disposalTimeoutMs: number
		deadLetterAfterMs: number
		journalBackpressureWarnAt: number
		enforceWriteScopes: boolean
		waitSpinLimit: number
	}
	readonly activity: TeamActivity
	readonly lifecycle: TeamRuntimeLifecycle
	readonly journal: TeamJournal
	readonly roster: TeamRoster
	readonly mailbox: TeamMailbox
	readonly tasks: TeamTaskBoard
	readonly startedAt: number = Date.now()

	private readonly metrics: TeamMetrics = {
		messagesSent: 0,
		messagesDelivered: 0,
		messagesDeadLettered: 0,
		tasksCreated: 0,
		tasksCompleted: 0,
		tasksReopened: 0,
		dispatchFailures: 0,
		memberReleases: 0,
		waitCalls: 0,
		writeScopeConflicts: 0,
		writeScopeRuntimeDenials: 0,
	}

	constructor(ctx: never, config: Partial<Record<'maxMembers' | 'maxTasks' | 'maxPendingMessagesPerMember' | 'maxMessageBytes' | 'disposalTimeoutMs' | 'deadLetterAfterMs' | 'journalBackpressureWarnAt' | 'enforceWriteScopes' | 'waitSpinLimit', unknown>> = {}) {
		const context = ctx as unknown as TeamServiceContext
		super(context as never, 'agentTeams')
		this.config = {
			maxMembers: positiveLimit('maxMembers', Number(config.maxMembers ?? DEFAULT_MAX_MEMBERS)),
			maxTasks: positiveLimit('maxTasks', Number(config.maxTasks ?? DEFAULT_MAX_TASKS)),
			maxPendingMessagesPerMember: positiveLimit('maxPendingMessagesPerMember', Number(config.maxPendingMessagesPerMember ?? DEFAULT_MAX_PENDING_MESSAGES)),
			maxMessageBytes: positiveLimit('maxMessageBytes', Number(config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES)),
			disposalTimeoutMs: positiveLimit('disposalTimeoutMs', Number(config.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS)),
			deadLetterAfterMs: nonNegativeLimit('deadLetterAfterMs', Number(config.deadLetterAfterMs ?? 0)),
			journalBackpressureWarnAt: nonNegativeLimit('journalBackpressureWarnAt', Number(config.journalBackpressureWarnAt ?? DEFAULT_JOURNAL_BACKPRESSURE_WARN_AT)),
			enforceWriteScopes: config.enforceWriteScopes === undefined ? true : config.enforceWriteScopes === true,
			waitSpinLimit: nonNegativeLimit('waitSpinLimit', Number(config.waitSpinLimit ?? DEFAULT_WAIT_SPIN_LIMIT)),
		}
		this.activity = new TeamActivity()
		this.lifecycle = new TeamRuntimeLifecycle(this.config.disposalTimeoutMs)
		this.journal = new TeamJournal(context, (root) => {
			this.activity.notify(teamId(root.id))
		}, this.config.journalBackpressureWarnAt)
		this.roster = new TeamRoster(context, this.journal, this.lifecycle, this.config.maxMembers)
		const mailboxMetrics: TeamMailboxMetrics = {
			messagesDelivered: 0,
			messagesDeadLettered: 0,
			dispatchFailures: 0,
		}
		// Bridge the mailbox counters into the shared service counters.
		Object.defineProperties(this.metrics, {
			messagesDelivered: { get: () => mailboxMetrics.messagesDelivered, enumerable: true },
			messagesDeadLettered: { get: () => mailboxMetrics.messagesDeadLettered, enumerable: true },
			dispatchFailures: { get: () => mailboxMetrics.dispatchFailures, enumerable: true },
		})
		this.mailbox = new TeamMailbox(
			context,
			this.journal,
			this.roster,
			this.lifecycle,
			this.config.maxPendingMessagesPerMember,
			this.config.maxMessageBytes,
			this.config.deadLetterAfterMs,
			mailboxMetrics,
		)
		this.tasks = new TeamTaskBoard(this.journal, this.config.maxTasks, this.config.enforceWriteScopes)

		// Listeners are removed explicitly on disposal (reverse order) so a service
		// reload cannot leave stale callbacks observing a disposed mailbox/roster.
		const stopSessionEvent = context.on('session/event', (session: unknown, event: { readonly type: string; readonly data: unknown }) => {
			this.mailbox.observeSessionEvent(session, event)
		})
		const stopAgentCreated = context.on('agent/created', ({ agent }: { agent: TeamAgent }) => {
			this.scheduleRecovery(agent)
		})
		const stopAgentStatus = context.on('agent/status', ({ agent }: { agent: TeamAgent }) => {
			// tryMembership rethrows projection failures — wrap so one bad agent
			// cannot throw into the emitter stack.
			let membership: TeamMembership | undefined
			try {
				membership = this.roster.tryMembership(agent)
			} catch (error) {
				this.context.logger?.warn?.(`agent/status heartbeat skipped for ${agent?.id}: ${errorMessage(error)}`)
				return
			}
			if (membership !== undefined) this.activity.notify(membership.id)
		})
		// Dead-letter sweeps need an independent driver: event-driven sweeps never
		// fire in a silent team, so expired messages would linger forever.
		const deadLetterSweepMs =
			this.config.deadLetterAfterMs > 0
				? Math.min(Math.max(this.config.deadLetterAfterMs / 2, 30_000), 5 * 60_000)
				: 0
		const deadLetterTimer =
			deadLetterSweepMs > 0
				? setInterval(() => {
						if (this.lifecycle.disposed) return
						// A timer callback runs outside any plugin effect, so a throw
						// here is an uncaught exception that takes the whole host
						// process down. Every access below is therefore guarded:
						// `context.agents` itself resolves through the mount fiber's
						// inject set, so a mis-declared `inject:` in cordis.patch.yml
						// would otherwise kill DSH minutes after startup instead of
						// degrading into a warning.
						let agents: readonly TeamAgent[]
						try {
							agents = context.agents.list()
						} catch (error) {
							this.context.logger?.warn?.(`team mailbox periodic sweep skipped: ${errorMessage(error)}`)
							return
						}
						for (const agent of agents) {
							let membership: TeamMembership | undefined
							try {
								membership = this.roster.tryMembership(agent)
							} catch (error) {
								this.context.logger?.warn?.(`team mailbox periodic sweep: membership probe failed for ${agent?.id}: ${errorMessage(error)}`)
								continue
							}
							if (membership === undefined || membership.role !== 'lead') continue
							try {
								const state = this.journal.state(membership.root)
								this.mailbox.expireDeadLetters(membership.root, agent, state).catch((error: unknown) => {
									this.context.logger?.warn?.(`team mailbox periodic dead-letter sweep failed: ${errorMessage(error)}`)
								})
							} catch (error) {
								this.context.logger?.warn?.(`team mailbox periodic dead-letter sweep skipped: ${errorMessage(error)}`)
							}
						}
					}, deadLetterSweepMs)
				: undefined
		// Never block process exit — the timer is only an auxiliary sweep.
		deadLetterTimer?.unref?.()
		context.effect(() => {
			const disposeProjection = context.root.sessionProjections.register(teamProjectionDefinition)
			return async () => {
				// Detach listeners first so disposal observes no new events.
				stopAgentStatus()
				stopAgentCreated()
				stopSessionEvent()
				if (deadLetterTimer !== undefined) clearInterval(deadLetterTimer)
				try {
					await this.disposeRuntime()
				} finally {
					disposeProjection()
				}
			}
		}, 'agentTeams.runtimeLifecycle()')
		for (const agent of context.agents.list()) this.scheduleRecovery(agent)
	}

	/** Resolve one exact live Agent's Team role. */
	membership(agent: TeamAgent): TeamMembership {
		return this.roster.membership(agent)
	}

	/** List the runtime-enriched roster visible to one Team member. */
	listMembers(agent: TeamAgent): TeamMemberView[] {
		return this.withInstallDiagnostics(this.roster.list(this.roster.membership(agent)))
	}

	/**
	 * Fold tool-install diagnostics into roster rows.
	 *
	 * The tools mount — not the roster — detects a member whose scoped tools
	 * failed to install (e.g. a half-provisioned spawn whose Agent exists but
	 * whose session is torn). Roster rows are durable journal projections and
	 * cannot carry that runtime fault, so the service keeps the notes in memory
	 * and merges them on read; the Lead's multeam_list output then shows the
	 * failure instead of a clean-looking teammate that has no tools.
	 */
	/* Field-initializer syntax would crash Object.create'd services in tests
	 * (the initializer never runs), so the map is allocated lazily — the same
	 * pattern metrics uses. */
	private installDiagnostics?: Map<string, string[]>

	/** Record one per-member runtime diagnostic emitted by the tools mount. */
	recordInstallDiagnostic(agent: TeamAgent, note: string): void {
		const membership = this.roster.tryMembership(agent)
		if (membership === undefined) return
		const map = (this.installDiagnostics ??= new Map())
		const list = map.get(membership.memberId) ?? []
		if (list.includes(note)) return
		list.push(note)
		map.set(membership.memberId, list)
	}

	/** Merge recorded install diagnostics into one roster view. */
	private withInstallDiagnostics(members: TeamMemberView[]): TeamMemberView[] {
		const map = this.installDiagnostics
		if (map === undefined || map.size === 0) return members
		return members.map((member) => {
			const extra = map.get(member.id)
			return extra === undefined ? member : { ...member, diagnostics: [...member.diagnostics, ...extra] }
		})
	}

	/** Create one named, continuable direct child of the Team Lead. */
	async spawnTeammate(caller: TeamAgent, request: Omit<TeamSpawnRequest, 'signal'> & { signal?: AbortSignal }): Promise<{ member: TeamMemberView }> {
		return await this.roster.spawn(caller, { ...request, signal: request.signal ?? AbortSignal.timeout(60_000) })
	}

	/** Queue one durable peer message, then attempt immediate delivery. */
	async sendMessage(caller: TeamAgent, request: TeamSendRequest): Promise<TeamSendResult> {
		const result = await this.mailbox.send(caller, request)
		/* A delivered inbound edge is the most common reason a teammate was
		 * waiting; any queued durable edge proves real activity reached the
		 * target, so the target's stale spin streak is cleared on delivery
		 * (checkpointDelivered) rather than here where the target is a name. */
		this.metrics.messagesSent++
		return result
	}

	/** Create one unowned pending task on the shared Team task board. */
	async createTask(caller: TeamAgent, request: TeamTaskCreateRequest): Promise<TeamTaskView> {
		const view = await this.tasks.create(this.roster.membership(caller), request)
		this.metrics.tasksCreated++
		this.metrics.writeScopeConflicts += view.conflicts?.length ?? 0
		return view
	}

	/** Return one task, including a deleted tombstone. */
	getTask(caller: TeamAgent, id: string): TeamTaskView {
		return this.tasks.get(this.roster.membership(caller), id, caller.id)
	}

	/** List current non-deleted tasks in numeric creation order. */
	listTasks(caller: TeamAgent): TeamTaskView[] {
		return this.tasks.list(this.roster.membership(caller), caller.id)
	}

	/**
	 * Union of write scopes across every in_progress task owned by one agent.
	 *
	 * Drives the runtime write_scopes enforcement hook: the caller is identified
	 * by its live Agent rather than by a caller member, so this returns
	 * `undefined` for non-members and an empty array for a member whose
	 * in_progress tasks carry no scopes — both meaning "no constraint".
	 * @param agent - live Agent to look up (`exec.agent.id` of the tool call).
	 * @returns the deduplicated write scopes that bound this agent's writes.
	 */
	writeScopesForAgent(agent: TeamAgent): string[] | undefined {
		const membership = this.roster.tryMembership(agent)
		if (membership === undefined) return undefined
		const scopes = new Set<string>()
		for (const task of this.journal.state(membership.root).tasks) {
			if (task.status !== 'in_progress' || task.ownerId !== membership.memberId) continue
			for (const scope of task.writeScopes) scopes.add(scope)
		}
		return [...scopes]
	}

	/** Compare-and-set one authorized task transition. */
	async updateTask(caller: TeamAgent, request: TeamTaskUpdateRequest): Promise<TeamTaskView> {
		const view = await this.tasks.update(caller, this.roster.membership(caller), request)
		if (request.action === 'complete') this.metrics.tasksCompleted++
		else if (request.action === 'reopen') this.metrics.tasksReopened++
		this.metrics.writeScopeConflicts += view.conflicts?.length ?? 0
		return view
	}

	/**
	 * Wait for the next Team-domain or member-status change.
	 * @param caller - exact live Team member waiting for activity.
	 * @param timeoutMs - bounded wait duration from ten seconds through one hour.
	 * @param signal - caller cancellation for the wait only.
	 * @param filter - optional matcher; non-matching wakes re-arm with the remaining deadline.
	 * @returns one observed change or a timeout result.
	 */
	async waitForChange(caller: TeamAgent, timeoutMs: number, signal: AbortSignal, filter?: TeamWaitFilter): Promise<TeamWaitResult> {
		const membership = this.roster.membership(caller)
		this.metrics.waitCalls++
		const before = this.journal.state(membership.root)
		/* Live member status is runtime-computed and never enters the durable
		 * journal, so it must be snapshotted alongside the durable state for the
		 * diff to reflect agent/status transitions. */
		const beforeStatus = this.memberStatusSnapshot(membership.root, this.journal.state(membership.root), before)
		/* Baseline race guard: a queued-but-undelivered message addressed to this
		 * caller is already durable state that activity.notify fired for, but if
		 * the caller entered wait after the notify landed the edge is lost. */
		const pendingForCaller = before.messages.filter((m) => m.targetId === caller.id && !before.delivered.includes(m.id))
		if (pendingForCaller.length > 0) {
			this.activity.resetWaitSpin(membership.id, membership.memberId)
			return {
				timedOut: false,
				changes: [
					{
						kind: 'mailbox',
						summary: `mailbox: ${pendingForCaller.length} pending message(s) for ${membership.role}`,
						mailbox_to: membership.name,
					},
				],
			}
		}
		/* Only teammates spin-count; the Lead is a legitimate continuous
		 * observer, and a timeout is how it *ends* an observation turn. */
		const spinCap = membership.role === 'lead' ? 0 : this.config.waitSpinLimit
		const finish = (result: TeamWaitResult): TeamWaitResult => {
			const streak = this.activity.recordWaitOutcome(membership.id, membership.memberId, result.timedOut === true)
			if (result.timedOut === true && spinCap > 0 && streak >= spinCap) {
				throw new TeamError(
					`multeam_wait timed out ${streak} times in a row — a teammate must end its turn after the first timeout (going inactive IS the wait); the scheduler or Lead wakes you. Fix the loop instead of re-waiting.`,
					'TEAM_WAIT_SPUN',
				)
			}
			return result
		}
		const deadline = Date.now() + timeoutMs
		for (;;) {
			const remaining = deadline - Date.now()
			if (remaining <= 0) return finish({ timedOut: true })
			const result = await this.activity.wait(membership.id, remaining, signal)
			if (result.timedOut) return finish(result)
			const after = this.journal.state(membership.root)
			const afterStatus = this.memberStatusSnapshot(membership.root, after)
			const changes = this.diffTeamState(before, after, beforeStatus, afterStatus)
			const matched =
				filter === undefined ? changes : changes.filter((change) => changeMatchesFilter(change, filter, membership.name))
			/* Matched changes are delivered first — the noProgress shortcut only
			 * applies when the wake produced nothing the caller asked for. */
			if (matched.length > 0) {
				/* Newly delivered mailbox edges addressed to this caller are the
				 * canonical "new event" — reset before the generic streak record. */
				if (matched.some((change) => change.mailbox_to === membership.name)) {
					this.activity.resetWaitSpin(membership.id, membership.memberId)
				}
				return finish({ timedOut: false, changes: matched })
			}
			/* The wake carried nothing durable. Re-check the productive-peer set
			 * rather than blindly returning: if nobody else can still produce a
			 * change, waiting out the timeout is dead time. */
			if (!hasProductivePeer(membership, after, afterStatus)) {
				return finish({
					timedOut: false,
					noProgress: {
						reason: 'no-active-peer',
						message: NO_ACTIVE_PEER_MESSAGE,
					},
				})
			}
			// A wake fired but every diff entry missed the filter — re-arm with the
			// remaining deadline instead of returning an unrelated change set.
		}
	}

	/**
	 * Snapshot every roster member's current live availability for live-status diffing.
	 * @param root - exact live Team Lead whose roster provides member ids.
	 * @param state - current projected Team state used to select active members.
	 * @param fallbackState - optional earlier state; members newly active in `state`
	 * that were not active in `fallbackState` are added to close the torn-read
	 * window between the state read and this snapshot.
	 * @returns member-id → availability at snapshot time.
	 */
	memberStatusSnapshot(root: TeamAgent, state: TeamState, fallbackState?: TeamState): Map<string, string> {
		const statuses = new Map<string, string>([[root.id, availability(root)]])
		// Only active members carry a live availability worth diffing; durable phase
		// transitions are already covered by the member-phase diff.
		for (const member of state.members) {
			if (member.phase === 'active') statuses.set(member.id, availability(this.ctx.agents.get(member.id)))
		}
		if (fallbackState !== undefined) {
			const priorActive = new Set(fallbackState.members.filter((member) => member.phase === 'active').map((member) => member.id))
			for (const member of state.members) {
				if (member.phase === 'active' && !priorActive.has(member.id)) {
					statuses.set(member.id, availability(this.ctx.agents.get(member.id)))
				}
			}
		}
		return statuses
	}

	/**
	 * Interrupt one live teammate turn without clearing its pending inbox.
	 * @param caller - exact live Lead Agent.
	 * @param targetName - durable teammate name.
	 * @param reason - optional audit reason recorded with the interruption.
	 * @returns the target status sampled before cancellation.
	 */
	interrupt(caller: TeamAgent, targetName: string, reason?: string): { previousStatus: string } {
		return this.roster.interrupt(caller, targetName, reason)
	}

	/**
	 * Release one teammate from the Team, draining its live Agent before committing
	 * the terminal edge. Undelivered mailbox entries addressed to the released
	 * member are settled afterwards; a cleanup failure is logged rather than
	 * failing the completed release.
	 */
	async releaseMember(caller: TeamAgent, targetName: string): Promise<{ member: TeamMemberView }> {
		const root = this.roster.membership(caller).root
		// Idempotent release: a repeated call produces no new transition and is not counted.
		const wasReleased = this.journal.state(root).members.find((m) => m.name === targetName.trim())?.phase === 'released'
		const result = await this.roster.release(caller, targetName)
		if (!wasReleased) this.metrics.memberReleases++
		try {
			await this.mailbox.releaseMemberMessages(root, result.member.id)
		} catch (error) {
			this.ctx.logger?.warn?.(`Team mailbox cleanup for released member "${result.member.id}" failed: ${errorMessage(error)}`)
		}
		return result
	}

	/** Return one caller's complete current Team status. */
	teamStatus(caller: TeamAgent): {
		members: TeamMemberView[]
		tasks: TeamTaskView[]
		failure?: string
		pendingMessages: { id: string; targetName: string; senderName: string }[]
		journalQueueDepth: number
		metrics: ReturnType<typeof this.metricsSnapshot>
	} {
		const membership = this.roster.membership(caller)
		const state = this.journal.state(membership.root)
		const pending = state.messages.filter((message) => !state.delivered.includes(message.id))
		return {
			members: this.withInstallDiagnostics(this.roster.list(membership)),
			tasks: this.tasks.list(membership, caller.id),
			...(state.failure !== undefined ? { failure: state.failure } : {}),
			pendingMessages: pending.map((message) => ({
				id: message.id,
				targetName: message.targetId === state.id ? 'lead' : state.members.find((member) => member.id === message.targetId)?.name ?? 'unknown',
				senderName: message.senderName,
			})),
			journalQueueDepth: this.journal.queueDepth(membership.root.id),
			metrics: this.metricsSnapshot(caller),
		}
	}

	/**
	 * Return the structured in-memory metrics snapshot for one caller's Team.
	 * Counters accumulate over the service lifetime; gauges are computed live.
	 */
	metricsSnapshot(caller: TeamAgent): {
		teamId: string
		sessionStartedAt: number
		scope: { counters: 'process-lifetime'; gauges: 'team-live' }
		counters: TeamMetrics
		gauges: { journalQueueDepth: number; pendingMessages: number; activeTasks: number }
	} {
		const membership = this.roster.membership(caller)
		const state = this.journal.state(membership.root)
		return {
			teamId: String(state.id),
			// Object.create'd prototypes in tests never run the constructor, so
			// this.startedAt may be undefined — fall back to 0 rather than emit
			// an undefined value that would fail JSON round-trip validation.
			sessionStartedAt: this.startedAt ?? 0,
			/* counters 是服务进程级累计（跨全部 session），gauges 是 caller 所在 Team
			 * 实时值——scope 显式标注两套口径，避免与 scheduler.stats 的
			 * per-session 计数误读为同一范围。 */
			scope: { counters: 'process-lifetime', gauges: 'team-live' },
			counters: { ...this.metrics },
			gauges: {
				journalQueueDepth: this.journal.queueDepth(membership.root.id),
				pendingMessages: state.messages.filter((message) => !state.delivered.includes(message.id)).length,
				activeTasks: state.tasks.filter((task) => task.status === 'in_progress').length,
			},
		}
	}

	/**
	 * Read the optional team-scheduler service's per-Team observability bundle.
	 *
	 * teamScheduler is a sibling service mounted by the profile patch, not a hard
	 * dependency — `ctx.get(..., false)` resolves it without declaring an inject
	 * edge, so agentTeams never waits on a possibly-absent plugin.
	 */
	schedulerSnapshot(caller: TeamAgent, decisionLimit = 20): unknown {
		const membership = this.roster.membership(caller)
		const scheduler = this.ctx.get('teamScheduler', false) as { decisionSnapshot?(rootId: string, limit: number): unknown } | undefined
		if (scheduler === undefined || typeof scheduler.decisionSnapshot !== 'function') return { available: false }
		return { available: true, ...scheduler.decisionSnapshot(membership.root.id, decisionLimit) }
	}

	/**
	 * Describe durable member, task, and mailbox edges committed between two states.
	 * @param before - Team state captured before waiting.
	 * @param after - Team state observed after waking.
	 * @returns one structured entry per observed phase, status, revision, owner, failure, or mailbox change.
	 */
	diffTeamState(before: TeamState, after: TeamState, beforeStatus?: Map<string, string>, afterStatus?: Map<string, string>): TeamChange[] {
		const changes: TeamChange[] = []
		for (const member of after.members) {
			const prior = before.members.find((candidate) => candidate.id === member.id)
			if (prior === undefined) {
				changes.push({ kind: 'member_phase', summary: `member ${member.name}: ->${member.phase}`, member: member.name, to: member.phase })
			} else if (prior.phase !== member.phase) {
				changes.push({
					kind: 'member_phase',
					summary: `member ${member.name}: ${prior.phase}->${member.phase}`,
					member: member.name,
					from: prior.phase,
					to: member.phase,
				})
			}
			if (beforeStatus !== undefined && afterStatus !== undefined) {
				const statusPrior = beforeStatus.get(member.id)
				const statusAfter = afterStatus.get(member.id)
				if (statusPrior !== statusAfter) {
					changes.push({
						kind: 'member_status',
						summary: `member ${member.name} status: ${statusPrior ?? 'unloaded'}->${statusAfter ?? 'unloaded'}`,
						member: member.name,
						from: statusPrior ?? 'unloaded',
						to: statusAfter ?? 'unloaded',
					})
				}
			}
		}
		for (const task of after.tasks) {
			const prior = before.tasks.find((candidate) => candidate.id === task.id)
			if (prior === undefined) {
				changes.push({ kind: 'task_status', summary: `${task.id} status: ->${task.status}`, taskId: task.id, to: task.status })
				continue
			}
			if (prior.status !== task.status) {
				changes.push({
					kind: 'task_status',
					summary: `${task.id} status: ${prior.status}->${task.status}`,
					taskId: task.id,
					from: prior.status,
					to: task.status,
				})
			}
			if (prior.revision !== task.revision) {
				changes.push({
					kind: 'task_revision',
					summary: `${task.id} revision ${prior.revision}->${task.revision}`,
					taskId: task.id,
					from: String(prior.revision),
					to: String(task.revision),
				})
			}
			if (prior.ownerId !== task.ownerId) {
				changes.push({
					kind: 'task_owner',
					summary: `${task.id} owner: ${taskOwnerName(before, prior.ownerId)}->${taskOwnerName(after, task.ownerId)}`,
					taskId: task.id,
					from: taskOwnerName(before, prior.ownerId),
					to: taskOwnerName(after, task.ownerId),
				})
			}
		}
		/* mailbox diff carries member=senderName so the members[] wait filter can
		 * actually match these entries — without it filter.members always saw
		 * member===undefined and a named-sender wait could only time out. */
		const memberNameOf = (id: string | undefined): string =>
			id === undefined ? 'unknown' : id === after.id ? 'lead' : after.members.find((member) => member.id === id)?.name ?? 'unknown'
		const queuedDelta = after.messages.slice(before.messages.length)
		for (const message of queuedDelta) {
			changes.push({
				kind: 'mailbox',
				summary: `mailbox: message queued from ${message.senderName} to ${memberNameOf(message.targetId)}`,
				member: message.senderName,
				mailbox_to: memberNameOf(message.targetId),
			})
		}
		const deliveredDelta = after.delivered.slice(before.delivered.length)
		for (const id of deliveredDelta) {
			const message = after.messages.find((candidate) => candidate.id === id)
			const recipient = memberNameOf(message?.targetId)
			changes.push({
				kind: 'mailbox',
				summary: `mailbox: message delivered to ${recipient}`,
				member: message === undefined ? undefined : recipient,
				mailbox_to: message === undefined ? undefined : recipient,
			})
		}
		if (after.failure !== undefined && before.failure !== after.failure) {
			changes.push({ kind: 'failure', summary: `projection failure: ${after.failure}` })
		}
		return changes
	}

	/** Resolve a caller without throwing, used by scoped-tool installation and observers. */
	tryMembership(agent: TeamAgent): TeamMembership | undefined {
		return this.roster.tryMembership(agent)
	}

	/** Queue one contained recovery pass after publication has unwound. */
	private scheduleRecovery(agent: TeamAgent): void {
		queueMicrotask(() => {
			if (this.lifecycle.disposed) return
			this.recoverFor(agent).catch((error: unknown) => {
				if (this.lifecycle.disposed) return
				this.ctx.logger?.warn?.(`Agent Teams recovery for "${agent.id}" failed: ${errorMessage(error)}`)
			})
		})
	}

	/** Reconcile roster provisioning before retrying that member's pending mailbox. */
	private async recoverFor(agent: TeamAgent): Promise<void> {
		await this.roster.recoverFor(agent, this.lifecycle.signal)
		await this.mailbox.recoverFor(agent, this.lifecycle.signal)
	}

	/** Stop Team-owned live branches and release every waiter before service disposal completes. */
	private async disposeRuntime(): Promise<void> {
		this.lifecycle.close()
		this.activity.close()
		const failures: unknown[] = []
		await this.lifecycle.settle(this.roster.pendingCreations(), failures)
		await this.lifecycle.settle(this.mailbox.pendingDispatches(), failures)
		for (const [root, childIds] of this.roster.liveChildrenByRoot()) {
			try {
				await this.roster.stopTeammates(root, childIds)
			} catch (error) {
				failures.push(error)
			}
		}
		if (failures.length > 0) throw new AggregateError(failures, 'Agent Teams runtime disposal failed')
	}
}

/**
 * Resolve one task owner identity to its model-facing name within one Team state.
 * @returns "unassigned", "lead", the member name, or "unknown".
 */
function taskOwnerName(state: TeamState, ownerId: string | undefined): string {
	if (ownerId === undefined) return 'unassigned'
	if (ownerId === state.id) return 'lead'
	return state.members.find((member) => member.id === ownerId)?.name ?? 'unknown'
}

/**
 * Match one structured diff entry against a `waitForChange` filter.
 *
 * An absent array in the filter means "any value matches"; an empty filter
 * object matches nothing (the caller opted into filtering). Each constraint
 * only binds changes that carry that dimension — a task-scoped key must not
 * reject a mailbox change, or a combined filter becomes an unsatisfiable AND.
 */
function changeMatchesFilter(change: TeamChange, filter: TeamWaitFilter, callerName: string): boolean {
	if (filter.kinds !== undefined && !filter.kinds.includes(change.kind)) return false
	if (filter.task_ids !== undefined && change.taskId !== undefined && !filter.task_ids.includes(change.taskId)) return false
	if (filter.members !== undefined && change.member !== undefined && !filter.members.includes(change.member)) return false
	/* mailbox_to_me narrows mailbox entries to deliveries addressed to the
	 * caller — the classic "wait for a report to me" wait. Non-mailbox kinds
	 * carry no recipient, so they pass through untouched (absent dimension =
	 * don't-bind, same as taskId/member above). */
	if (filter.mailbox_to_me === true && change.mailbox_to !== undefined && change.mailbox_to !== callerName) return false
	return true
}

/** Shared wording for the no-active-peer short circuit (mirrored by the tool layer). */
export const NO_ACTIVE_PEER_MESSAGE =
	'No other Team member is running or provisioning and no pending task belongs to them. multeam_wait cannot make progress or wake inactive teammates. Re-list with multeam_list and multeam_task_list, then use multeam_send to wake each required inactive teammate before waiting again.'

export { TeamError, errorMessage, teamId }
export { availability }
export { TeamRoster, TeamMailbox, TeamTaskBoard, TeamJournal, TeamActivity, TeamRuntimeLifecycle }
export { teamProjectionDefinition }
// The remaining public surface is re-exported name-by-name: rolldown lowers
// `export * from './public.js'` to a bare side-effect import, which would drop
// every re-exported binding from the built module.
export {
	assertTaskGraphCandidate,
	TeamTaskGraphError,
	assertTaskTransition,
	TASK_TRANSITIONS,
	compressReport,
	compressTaskBrief,
	estimateTokens,
	detectWriteScopeConflict,
	scopesOverlap,
	taskReady,
	messageAccepted,
	pendingInboxMessages,
	readPersistedSession,
	applyProjectionEvent,
	emptyTeamState,
	isTeamEvent,
	teamProjectionView,
	hasProductivePeer,
	resolveActiveMember,
	messageId,
	requiredText,
	taskPriority,
	validateLesson,
	writeScope,
	PRIORITY_WEIGHT,
} from './public.js'
export { taskId } from './types.js'
export type { TeamChange, TeamMetrics, TeamTaskAction, TeamWaitFilter, TeamWaitResult } from './shapes.js'
export type { TeamAgent, TeamMembership, TeamMemberView, TeamState, TeamTaskSnapshot, TeamTaskView } from './types.js'
