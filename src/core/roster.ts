/** Team membership, continuable-child provisioning, and roster-owned teardown. */

import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { TeamAgent, TeamMemberSnapshot, TeamMemberView, TeamMembership, TeamState } from './types.js'
import { teamId } from './types.js'
import { TeamError, errorMessage } from './error.js'
import { requiredText } from './validation.js'
import type { TeamJournal } from './journal.js'
import type { TeamRuntimeLifecycle } from './lifecycle.js'
import { readPersistedSession, type TeamPersistence } from './persisted.js'
import { messageAccepted } from './session-message.js'

/** Model-facing teammate names: ASCII lower-kebab-case, at most 64 characters.
 * The name is an addressing key, not prose — it travels through `multeam_send`
 * targets, task `owner` filters and DAG dispatch messages as plain text, so it
 * must stay ASCII to survive every protocol hop without quoting rules. Pass a
 * short English identifier such as `tool-auditor`; Chinese belongs in
 * `description`, `prompt` and message bodies, never in `name`. */
const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Marks an error as a projection failure so `tryMembership` can rethrow it. */
const TEAM_PROJECTION_ERROR = Symbol('teamProjectionError')

/** The slice of the DSH context the roster needs. */
export interface TeamRosterContext {
	agents: {
		get(id: string): TeamAgent | undefined
		list(): readonly TeamAgent[]
	}
	sessions: { get(id: string): TeamSessionHandle | undefined; flush(session: unknown): Promise<void> }
	sessionPersistence: TeamPersistence
	subagents: TeamSubagents
	logger?: { warn?(message: string): void; info?(message: string): void }
	on(event: 'session/event' | 'session/disposed', listener: (candidate: unknown) => void): () => void
}

/** The slice of the DSH Session surface used by the provisioning checkpoint. */
export interface TeamSessionHandle {
	readonly inheritedEventCount: number
	snapshotEvents(from?: number): readonly unknown[]
}

/** The slice of the DSH subagent service the roster needs. */
export interface TeamSubagents {
	startContinuable(spec: {
		childId: string
		provider: string
		label: string
		request: { prompt: readonly unknown[]; parent: TeamAgent }
		signal: AbortSignal
	}): Promise<{ messageId: string }>
	interrupt(id: string, options: unknown): void
	drainContinuableChildren(root: TeamAgent, childIds: readonly string[]): Promise<void>
}

/** One teammate creation request. */
export interface TeamSpawnRequest {
	readonly name: string
	readonly description: string
	readonly prompt: readonly unknown[]
	readonly context: 'fresh' | 'fork'
	readonly provider: string
	readonly signal: AbortSignal
}

/**
 * Resolve one active Team member by model-facing name, including the Lead pseudo-row.
 * @param root - exact live Team Lead.
 * @param state - current Team state.
 * @param rawName - candidate member name.
 * @returns resolved durable id and normalized name.
 */
export function resolveActiveMember(root: TeamAgent, state: TeamState, rawName: string): { id: string; name: string } {
	const name = rawName.trim()
	if (name === 'lead') return { id: root.id, name }
	const member = state.members.find((candidate) => candidate.name === name)
	if (member === undefined || member.phase !== 'active') throw new TeamError(`active teammate "${name}" not found`, 'TEAM_MEMBER_NOT_FOUND')
	return { id: member.id, name }
}

/**
 * Turn availability follows the live Agent's lifecycle: "running" while a driver
 * is active, "idle" when the agent exists but has no driver, and "unloaded" when
 * the agent is not in the live Agent registry at all.
 */
export function availability(agent: TeamAgent | undefined): TeamMemberView['status'] {
	if (agent?.status === 'running') return 'running'
	if (agent?.status === 'idle') return 'idle'
	if (agent === undefined) return 'unloaded'
	return 'inactive'
}

/** Owns Team identities and the lifecycle of rostered continuable children. */
export class TeamRoster {
	private readonly inFlightCreations = new Set<Promise<unknown>>()

	constructor(
		private readonly ctx: TeamRosterContext,
		private readonly journal: TeamJournal,
		private readonly lifecycle: TeamRuntimeLifecycle,
		private readonly maxMembers: number,
	) {}

	/**
	 * Resolve one exact live Agent's Team role.
	 * @param agent - exact live Agent used as the authority credential.
	 * @returns its root, Team identity, role, and model-facing name.
	 */
	membership(agent: TeamAgent): TeamMembership {
		const membership = this.tryMembership(agent)
		if (membership === undefined) throw new TeamError(`agent "${agent.id}" is not a member of an active Agent Team`, 'TEAM_NOT_MEMBER')
		return membership
	}

	/**
	 * Resolve a caller without throwing for scoped installation and lifecycle observers.
	 * @param agent - candidate exact live Agent.
	 * @returns Team membership, or undefined for non-Team subagents and stale identities.
	 */
	tryMembership(agent: TeamAgent): TeamMembership | undefined {
		if (this.ctx.agents.get(agent.id) !== agent) return undefined
		try {
			const parentId = agent.session.header.parentSession
			if (parentId !== undefined) {
				const root = this.ctx.agents.get(parentId)
				if (root !== undefined) {
					// A projection failure must not be swallowed into "not a member" —
					// callers such as recoverFor would silently skip recovery. Tag it
					// and rethrow below.
					let member: TeamMemberSnapshot | undefined
					try {
						member = this.journal.state(root).members.find((candidate) => candidate.id === agent.id)
					} catch (stateError) {
						throw Object.assign(stateError instanceof Error ? stateError : new Error(String(stateError)), {
							[TEAM_PROJECTION_ERROR]: true,
						})
					}
					/* A released member must not resolve as a teammate even while its
					 * drained Agent remains live. */
					if (member !== undefined && member.phase === 'released') return undefined
					if (member !== undefined) {
						return { root, id: teamId(root.id), memberId: member.id, role: 'teammate', name: member.name }
					}
					if (this.subagentDescriptor(agent)) return undefined
					return { root: agent, id: teamId(agent.id), memberId: agent.id, role: 'lead', name: 'lead' }
				}
			}
			if (this.subagentDescriptor(agent)) return undefined
			return { root: agent, id: teamId(agent.id), memberId: agent.id, role: 'lead', name: 'lead' }
		} catch (error) {
			if (error !== null && typeof error === 'object' && (error as Record<symbol, unknown>)[TEAM_PROJECTION_ERROR] === true) throw error
			return undefined
		}
	}

	/**
	 * List the runtime-enriched roster visible to one Team member.
	 * @param membership - exact caller membership resolved by this roster.
	 * @returns Lead and teammate rows in creation order.
	 */
	list(membership: TeamMembership): TeamMemberView[] {
		const { root } = membership
		const state = this.journal.state(root)
		const result: TeamMemberView[] = [
			{
				id: root.id,
				name: 'lead',
				role: 'lead',
				status: availability(root),
				...(root.options.model === undefined ? {} : { model: root.options.model }),
				diagnostics: [],
			},
		]
		for (const member of state.members) {
			const live = this.ctx.agents.get(member.id)
			const model = live?.options.model ?? root.options.model
			result.push({
				id: member.id,
				name: member.name,
				role: 'teammate',
				status:
					member.phase === 'failed'
						? 'failed'
						: member.phase === 'provisioning'
							? 'provisioning'
							: member.phase === 'released'
								? 'released'
								: availability(live),
				description: member.description,
				provider: member.provider,
				context: member.context,
				...(model === undefined ? {} : { model }),
				diagnostics: member.error === undefined ? [] : [member.error],
			})
		}
		return result
	}

	/**
	 * Create one named, continuable direct child of the Team Lead.
	 * @param caller - exact live Lead Agent.
	 * @param request - immutable name, description, prompt, context mode, provider, and cancellation.
	 * @returns the active roster row.
	 */
	async spawn(caller: TeamAgent, request: TeamSpawnRequest): Promise<{ member: TeamMemberView }> {
		if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
		const operation = this.spawnAdmitted(caller, request)
		this.inFlightCreations.add(operation)
		try {
			return await operation
		} finally {
			this.inFlightCreations.delete(operation)
		}
	}

	/** Return admitted creation operations captured for ordered disposal. */
	pendingCreations(): Promise<unknown>[] {
		return [...this.inFlightCreations]
	}

	/**
	 * Reconcile provisioning state when one Team member Session starts.
	 * @param agent - newly started exact live Agent.
	 * @param signal - shared runtime cancellation.
	 */
	async recoverFor(agent: TeamAgent, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted()
		const membership = this.tryMembership(agent)
		if (membership?.role === 'lead') await this.reconcileProvisioning(membership.root, signal)
	}

	/**
	 * Interrupt one live teammate turn without clearing its pending inbox.
	 * @param caller - exact live Lead Agent.
	 * @param targetName - durable teammate name.
	 * @param reason - optional audit text recorded with the interruption.
	 * @returns the target status sampled before cancellation.
	 */
	interrupt(caller: TeamAgent, targetName: string, reason?: string): { previousStatus: string } {
		const membership = this.membership(caller)
		if (membership.role !== 'lead') throw new TeamError('only the Team Lead can interrupt teammates', 'TEAM_LEAD_REQUIRED')
		const state = this.journal.state(membership.root)
		const target = resolveActiveMember(membership.root, state, targetName)
		if (target.id === membership.root.id) throw new TeamError('the Team Lead cannot interrupt itself', 'TEAM_INVALID_TARGET')
		const live = this.ctx.agents.get(target.id)
		if (live === undefined) return { previousStatus: 'unloaded' }
		const previousStatus = availability(live)
		const trimmed = typeof reason === 'string' ? reason.trim() : ''
		this.ctx.subagents.interrupt(target.id, {
			kind: 'ancestor',
			agent: caller,
			...(trimmed === '' ? {} : { reason: trimmed }),
		})
		return { previousStatus }
	}

	/**
	 * Release one teammate from the Team, draining its live Agent before committing the terminal edge.
	 * @param caller - exact live Lead Agent.
	 * @param targetName - durable teammate name.
	 * @returns the released roster row.
	 */
	async release(caller: TeamAgent, targetName: string): Promise<{ member: TeamMemberView }> {
		const membership = this.membership(caller)
		if (membership.role !== 'lead') throw new TeamError('only the Team Lead can release teammates', 'TEAM_LEAD_REQUIRED')
		const root = membership.root
		const state = this.journal.state(root)
		const name = targetName.trim()
		if (name === 'lead') throw new TeamError('the Team Lead cannot release itself', 'TEAM_INVALID_TARGET')
		const member = state.members.find((candidate) => candidate.name === name)
		if (member === undefined) throw new TeamError(`teammate "${name}" not found`, 'TEAM_MEMBER_NOT_FOUND')
		if (member.phase === 'released') return { member: this.memberView(member) }
		if (this.ctx.agents.get(member.id) !== undefined) await this.stopTeammates(root, [member.id])
		let released: TeamMemberSnapshot
		await this.journal.transact(root.id, async () => {
			const current = this.journal.state(root).members.find((candidate) => candidate.id === member.id)
			if (current === undefined) throw new TeamError(`teammate "${member.id}" disappeared`, 'TEAM_PROVISIONING_CONFLICT')
			released = { ...current, phase: 'released' }
			if (current.phase === 'released') return
			await this.journal.appendAndFlush(root, 'team/member', { version: 2, teamId: teamId(root.id), member: released })
		})
		return { member: this.memberView(released!) }
	}

	/**
	 * Group exact live roster children by their current Lead for runtime teardown.
	 * @returns each live Lead and the roster child ids currently in the Agent registry.
	 */
	liveChildrenByRoot(): Map<TeamAgent, string[]> {
		const teams = new Map<TeamAgent, string[]>()
		for (const agent of this.ctx.agents.list()) {
			const rootId = agent.session.header.parentSession
			if (rootId === undefined) continue
			const root = this.ctx.agents.get(rootId)
			if (root === undefined || !this.journal.state(root).members.some((member) => member.id === agent.id)) continue
			const children = teams.get(root) ?? []
			children.push(agent.id)
			teams.set(root, children)
		}
		return teams
	}

	/** Release exact teammate Activations through the continuation lifecycle owner. */
	async stopTeammates(root: TeamAgent, childIds: readonly string[]): Promise<void> {
		await this.lifecycle.withTimeout(this.ctx.subagents.drainContinuableChildren(root, childIds))
	}

	/** Perform one creation admitted before the Team runtime disposal cutoff. */
	private async spawnAdmitted(caller: TeamAgent, request: TeamSpawnRequest): Promise<{ member: TeamMemberView }> {
		const membership = this.membership(caller)
		if (membership.role !== 'lead') throw new TeamError('only the Team Lead can create teammates', 'TEAM_LEAD_REQUIRED')
		const signal = AbortSignal.any([request.signal, this.lifecycle.signal])
		signal.throwIfAborted()
		const root = membership.root
		const name = this.memberName(request.name)
		const description = requiredText(request.description, 'description', 200)
		const childId = brandString(randomUUID())
		const member: TeamMemberSnapshot = {
			id: childId,
			name,
			description,
			provider: requiredText(request.provider, 'provider', 200),
			context: request.context,
			phase: 'provisioning',
		}
		await this.journal.transact(root.id, async () => {
			const state = this.journal.state(root)
			if (state.members.some((candidate) => candidate.name === name)) {
				throw new TeamError(`teammate name "${name}" was already used in this Team`, 'TEAM_MEMBER_NAME_TAKEN')
			}
			// Only in-team members (provisioning/active) consume a slot — released and
			// failed rows are terminal history that must keep blocking the name, but
			// not the capacity, or a release would leak the slot until session end.
			const liveMembers = state.members.filter((candidate) => candidate.phase !== 'released' && candidate.phase !== 'failed').length
			if (liveMembers >= this.maxMembers) throw new TeamError(`Team member limit ${this.maxMembers} reached`, 'TEAM_MEMBER_LIMIT')
			await this.journal.appendAndFlush(root, 'team/member', { version: 2, teamId: teamId(root.id), member })
		})
		let started: { messageId: string }
		try {
			started = await this.ctx.subagents.startContinuable({
				childId,
				provider: request.provider,
				label: description,
				request: { prompt: request.prompt, parent: root },
				signal,
			})
			await this.checkpointInitialPrompt(childId, started.messageId, signal)
		} catch (error) {
			const failed: TeamMemberSnapshot = { ...member, phase: 'failed', error: errorMessage(error) }
			try {
				const phase = await this.settleProvisioning(root, failed)
				await this.stopTeammates(root, [childId])
				if (phase === 'active') {
					throw new TeamError(`teammate "${name}" became active while its creator reported failure`, 'TEAM_PROVISIONING_CONFLICT', {
						cause: error,
					})
				}
			} catch (recordError) {
				throw new AggregateError([error, recordError], 'teammate creation and durable failure recording both failed')
			}
			throw error
		}
		const active: TeamMemberSnapshot = { ...member, phase: 'active' }
		if ((await this.settleProvisioning(root, active)) === 'failed') {
			const conflict = new TeamError(`teammate "${name}" was reconciled as failed while creation was in progress`, 'TEAM_PROVISIONING_CONFLICT')
			try {
				await this.stopTeammates(root, [childId])
			} catch (cleanupError) {
				throw new AggregateError([conflict, cleanupError], 'provisioning conflict cleanup failed')
			}
			throw conflict
		}
		return { member: this.memberView(active) }
	}

	/** Flush the accepted initial inbox item before the Lead can commit `active`. */
	private async checkpointInitialPrompt(childId: string, messageId: string, signal: AbortSignal): Promise<void> {
		while (true) {
			signal.throwIfAborted()
			const session = this.ctx.sessions.get(childId)
			if (session === undefined) {
				const stored = await readPersistedSession(this.ctx.sessionPersistence, childId, signal)
				if (messageAccepted(stored.events.slice(stored.inheritedEventCount), (message) => (message as { id?: string }).id === messageId)) return
				throw new TeamError(`teammate "${childId}" initial prompt was not durably accepted`, 'TEAM_PROVISIONING_CONFLICT')
			}
			const progress = Promise.withResolvers<void>()
			progress.promise.catch(() => undefined)
			const stopEvent = this.ctx.on('session/event', (candidate) => {
				if (candidate === session) progress.resolve()
			})
			const stopDisposed = this.ctx.on('session/disposed', (candidate) => {
				if (candidate === session) progress.resolve()
			})
			const onAbort = (): void => {
				const reason = signal.reason
				progress.reject(reason instanceof Error ? reason : new TeamError(`teammate creation aborted: ${errorMessage(reason)}`, 'TEAM_DISPOSED'))
			}
			signal.addEventListener('abort', onAbort, { once: true })
			try {
				signal.throwIfAborted()
				await this.ctx.sessions.flush(session)
				if (messageAccepted(session.snapshotEvents(session.inheritedEventCount), (message) => (message as { id?: string }).id === messageId)) return
				if (this.ctx.sessions.get(childId) !== session) continue
				await progress.promise
			} finally {
				signal.removeEventListener('abort', onAbort)
				stopDisposed()
				stopEvent()
			}
		}
	}

	/** Settle provisioning-only members from their independently durable child Sessions. */
	private async reconcileProvisioning(root: TeamAgent, signal: AbortSignal): Promise<void> {
		const provisioning = this.journal.state(root).members.filter((member) => member.phase === 'provisioning')
		for (const member of provisioning) {
			signal.throwIfAborted()
			if (this.ctx.agents.get(member.id) !== undefined) continue
			let phase: TeamMemberSnapshot['phase'] = 'failed'
			let failure = 'provisioning did not leave a resumable child Session'
			try {
				const loaded = await readPersistedSession(this.ctx.sessionPersistence, member.id, signal)
				const suffix = loaded.events.slice(loaded.inheritedEventCount)
				const descriptor = foldSubagentDescriptor(suffix)
				const acceptedInitialPrompt = messageAccepted(suffix, (message) => (message as { source?: { kind?: string } }).source?.kind === 'user')
				if (loaded.header.parentSession === root.id && descriptor?.mode === 'continuable' && descriptor.provider === member.provider && acceptedInitialPrompt) {
					phase = 'active'
				} else {
					failure = 'persisted child Session does not match the provisioned continuation'
				}
			} catch (error) {
				failure = `child Session recovery failed: ${errorMessage(error)}`
			}
			signal.throwIfAborted()
			await this.journal.transact(root.id, async () => {
				signal.throwIfAborted()
				const current = this.journal.state(root).members.find((candidate) => candidate.id === member.id)
				if (current?.phase !== 'provisioning') return
				const settled: TeamMemberSnapshot = { ...current, phase, ...(phase === 'failed' ? { error: failure } : {}) }
				await this.journal.appendAndFlush(root, 'team/member', { version: 2, teamId: teamId(root.id), member: settled })
			})
		}
	}

	/** Build one runtime member row after successful creation. */
	private memberView(member: TeamMemberSnapshot): TeamMemberView {
		const live = this.ctx.agents.get(member.id)
		return {
			id: member.id,
			name: member.name,
			role: 'teammate',
			status: member.phase === 'released' ? 'released' : availability(live),
			description: member.description,
			provider: member.provider,
			context: member.context,
			...(live?.options.model === undefined ? {} : { model: live.options.model }),
			diagnostics: [],
		}
	}

	/** Validate a never-reused model-facing teammate name. */
	private memberName(value: unknown): string {
		const raw = typeof value === 'string' ? value.trim() : ''
		// "unowned" is the reserved sentinel for the multeam_task_list owner filter —
		// a member by that name would collide with the "no owner" semantics.
		if (!MEMBER_NAME.test(raw) || raw.length > 64 || raw === 'lead' || raw === 'unowned') {
			throw new TeamError(
				'teammate name must be 1-64 chars of ASCII lower-kebab-case (e.g. "tool-auditor") and not "lead" or "unowned"',
				'TEAM_INVALID_MEMBER_NAME',
			)
		}
		return raw
	}

	/** Append one terminal provisioning edge unless recovery already settled it. */
	private async settleProvisioning(root: TeamAgent, terminal: TeamMemberSnapshot): Promise<TeamMemberSnapshot['phase']> {
		return await this.journal.transact(root.id, async () => {
			const current = this.journal.state(root).members.find((member) => member.id === terminal.id)
			if (current === undefined) throw new TeamError(`provisioned teammate "${terminal.id}" disappeared`, 'TEAM_PROVISIONING_CONFLICT')
			if (current.phase !== 'provisioning') return current.phase
			await this.journal.appendAndFlush(root, 'team/member', { version: 2, teamId: teamId(root.id), member: terminal })
			return terminal.phase === 'active' ? 'active' : 'failed'
		})
	}

	/** Whether a Session's own suffix identifies a provider-owned subagent child. */
	private subagentDescriptor(agent: TeamAgent): boolean {
		return foldSubagentDescriptor(agent.session.snapshotEvents(agent.session.inheritedEventCount)) !== undefined
	}
}

/**
 * Whether any Team member besides the waiter can still produce a change the
 * waiter would observe. A member counts as productive when it is running or
 * provisioning, or when a pending or in-progress task is still assigned to it
 * (the scheduler can wake an inactive owner to make progress on it).
 */
export function hasProductivePeer(membership: TeamMembership, state: TeamState, statuses: Map<string, string>): boolean {
	if (membership.memberId !== membership.root.id && (statuses.get(membership.root.id) ?? 'inactive') === 'running') return true
	for (const member of state.members) {
		if (member.id === membership.memberId) continue
		if (member.phase === 'provisioning') return true
		if (member.phase !== 'active') continue
		if ((statuses.get(member.id) ?? 'inactive') === 'running') return true
		if (state.tasks.some((task) => task.ownerId === member.id && (task.status === 'pending' || task.status === 'in_progress'))) return true
	}
	return false
}
