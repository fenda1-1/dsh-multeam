/** Shared Team task DAG commands and runtime-enriched views. */

import { randomUUID } from 'node:crypto'
import type { TeamAgent, TeamMembership, TeamState, TeamTaskSnapshot, TeamTaskView } from './types.js'
import { taskId, teamId } from './types.js'
import { TeamError } from './error.js'
import { assertTaskGraphCandidate, TeamTaskGraphError } from './task-graph.js'
import { detectWriteScopeConflict, projectTaskView, taskReady } from './task-view.js'
import { requiredText, taskPriority, validateLesson, writeScope } from './validation.js'
import type { TeamJournal } from './journal.js'
import { resolveActiveMember } from './roster.js'

/** Stable command error code per task-graph violation category. */
const TASK_GRAPH_ERROR_CODES = {
	missing: 'TEAM_TASK_NOT_FOUND',
	duplicate: 'TEAM_INVALID_ARGUMENT',
	cycle: 'TEAM_TASK_DEPENDENCY_CYCLE',
} as const

/**
 * Legal task status transitions (terminal states have no outbound edges).
 *
 * `edit` / `set_dependencies` are same-status updates and bypass this gate.
 */
export const TASK_TRANSITIONS: Record<TeamTaskSnapshot['status'], TeamTaskSnapshot['status'][]> = {
	pending: ['in_progress', 'deleted'],
	in_progress: ['pending', 'completed', 'deleted'],
	completed: ['pending', 'deleted'],
	deleted: [],
}

/**
 * Validate one task status transition.
 * @param current - current persisted status.
 * @param next - status about to be written.
 */
export function assertTaskTransition(current: TeamTaskSnapshot['status'], next: TeamTaskSnapshot['status']): void {
	if (current === next) return
	if (!(TASK_TRANSITIONS[current] ?? []).includes(next)) {
		throw new TeamError(`task status cannot move from "${current}" to "${next}"`, 'TEAM_TASK_INVALID_TRANSITION')
	}
}

/** One task mutation action. `unclaim` is an alias for `release` — clearer name that avoids confusion with `multeam_release` (member discharge). */
export type TeamTaskAction = 'claim' | 'release' | 'unclaim' | 'edit' | 'set_dependencies' | 'complete' | 'reopen' | 'reassign' | 'delete'

/** One compare-and-set task update request. */
export interface TeamTaskUpdateRequest {
	readonly taskId: string
	readonly expectedRevision: number
	readonly action: TeamTaskAction
	readonly subject?: string
	readonly description?: string
	/** Append-mode alternative to `description` for edit; mutually exclusive with it. */
	readonly appendDescription?: string
	readonly blockedBy?: readonly string[]
	readonly writeScopes?: readonly string[]
	readonly owner?: string
	readonly priority?: string
	readonly attemptId?: string
	readonly lesson?: string
}

/** One task creation request. */
export interface TeamTaskCreateRequest {
	readonly subject: string
	readonly description: string
	readonly blockedBy?: readonly string[]
	readonly writeScopes?: readonly string[]
	readonly acceptance?: readonly string[]
	readonly priority?: string
}

/** Owns Team task limits, authorization, transitions, and derived views. */
export class TeamTaskBoard {
	constructor(
		private readonly journal: TeamJournal,
		private readonly maxTasks: number,
		private readonly enforceWriteScopes = false,
	) {}

	/**
	 * Create one unowned pending task in the Team Lead log.
	 * @param membership - exact caller membership resolved by the Team roster.
	 * @param request - task text, blockers, and advisory write scopes.
	 * @returns the revision-one task view.
	 */
	async create(membership: TeamMembership, request: TeamTaskCreateRequest): Promise<TeamTaskView> {
		const { root } = membership
		return await this.journal.transact(root.id, async () => {
			const state = this.journal.state(root)
			if (state.tasks.filter((task) => task.status !== 'deleted').length >= this.maxTasks) {
				throw new TeamError(`Team task limit ${this.maxTasks} reached`, 'TEAM_TASK_LIMIT')
			}
			const id = taskId(`task-${state.nextTaskNumber}`)
			if (state.tasks.some((task) => task.id === id)) throw new TeamError('Team task id space exhausted', 'TEAM_TASK_LIMIT')
			// Persisted panel timestamps: creation is the first revision, and every
			// later revision appends one history entry for the detail timeline.
			const now = Date.now()
			const task: TeamTaskSnapshot = {
				id,
				revision: 1,
				subject: requiredText(request.subject, 'subject', 200),
				description: requiredText(request.description, 'description', 16384),
				status: 'pending',
				blockedBy: this.dependencies(request.blockedBy ?? [], state),
				writeScopes: this.writeScopes(request.writeScopes ?? []),
				createdAt: now,
				updatedAt: now,
				history: [{ revision: 1, action: 'create', status: 'pending', at: now }],
				...(request.acceptance === undefined
					? {}
					: { acceptance: request.acceptance.map((criterion) => requiredText(criterion, 'acceptance', 500)) }),
				...(request.priority === undefined ? {} : { priority: taskPriority(request.priority) }),
			}
			this.assertTaskGraph(state, task)
			await this.journal.appendAndFlush(root, 'team/task', { version: 2, teamId: teamId(root.id), task })
			return projectTaskView(state, task)
		})
	}

	/**
	 * Return one task, including a deleted tombstone.
	 * @param membership - exact caller membership resolved by the Team roster.
	 * @param id - Team-local task identity.
	 * @param viewerId - optional caller session id; attemptId is exposed only on tasks the caller owns.
	 * @returns the latest task value and derived readiness diagnostics.
	 */
	get(membership: TeamMembership, id: string, viewerId?: string): TeamTaskView {
		const { root } = membership
		const state = this.journal.state(root)
		const task = state.tasks.find((candidate) => candidate.id === id)
		if (task === undefined) throw new TeamError(`team task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
		return projectTaskView(state, task, viewerId)
	}

	/**
	 * List current non-deleted tasks in numeric creation order.
	 * @param membership - exact caller membership resolved by the Team roster.
	 * @param viewerId - optional caller session id; attemptId is exposed only on tasks the caller owns.
	 * @returns detached current task views.
	 */
	list(membership: TeamMembership, viewerId?: string): TeamTaskView[] {
		const { root } = membership
		const state = this.journal.state(root)
		return state.tasks.filter((task) => task.status !== 'deleted').map((task) => projectTaskView(state, task, viewerId))
	}

	/**
	 * Compare-and-set one authorized task transition.
	 * @param caller - exact live Team member authorizing the mutation.
	 * @param membership - caller role and exact live Lead.
	 * @param request - task identity, expected revision, action, and action fields.
	 * @returns the committed next task revision.
	 */
	async update(caller: TeamAgent, membership: TeamMembership, request: TeamTaskUpdateRequest): Promise<TeamTaskView> {
		const root = membership.root
		return await this.journal.transact(root.id, async () => {
			const state = this.journal.state(root)
			const current = state.tasks.find((task) => task.id === request.taskId)
			if (current === undefined) throw new TeamError(`team task "${request.taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
			if (current.revision !== request.expectedRevision) {
				throw new TeamError(
					`stale team task "${current.id}" revision ${request.expectedRevision}; current revision is ${current.revision}`,
					'TEAM_TASK_STALE_REVISION',
				)
			}
			if (current.status === 'deleted') throw new TeamError(`team task "${current.id}" is deleted`, 'TEAM_TASK_DELETED')
			const lead = membership.role === 'lead'
			const owner = current.ownerId === caller.id
			const authorizeOwner = (): void => {
				if (!lead && !owner) throw new TeamError('task mutation requires its owner or Team Lead', 'TEAM_TASK_UNAUTHORIZED')
			}
			/* attemptId capability check: an omitted token is tolerated for the current
			 * owner — the CAS expectedRevision already proves the caller re-read the
			 * task after the latest attempt was issued. Only an explicitly wrong token
			 * is rejected, since that proves the caller holds a revoked attempt. */
			const authorizeAttempt = (): void => {
				if (!lead && owner && current.attemptId !== undefined && request.attemptId !== undefined && request.attemptId !== current.attemptId) {
					throw new TeamError(`stale attempt for team task "${current.id}"; re-read the task view for the current attemptId`, 'TEAM_TASK_STALE_ATTEMPT')
				}
			}
			let next: TeamTaskSnapshot
			switch (request.action) {
				case 'claim': {
					if (current.ownerId !== undefined && current.ownerId !== caller.id) {
						throw new TeamError(`team task "${current.id}" is owned by another member`, 'TEAM_TASK_ALREADY_CLAIMED')
					}
					if (current.status !== 'pending') {
						throw new TeamError(`team task "${current.id}" is not ready to claim (status: ${current.status})`, 'TEAM_TASK_NOT_CLAIMABLE')
					}
					if (!taskReady(state, current)) throw new TeamError(`team task "${current.id}" is blocked by ${this.pendingBlockers(state, current)}`, 'TEAM_TASK_BLOCKED')
					next = { ...current, status: 'in_progress', ownerId: caller.id, attemptId: randomUUID() }
					break
				}
				case 'release':
				case 'unclaim': {
					authorizeOwner()
					authorizeAttempt()
					if (current.status !== 'in_progress') throw new TeamError('only an in-progress task can be released', 'TEAM_TASK_INVALID_TRANSITION')
					next = this.withoutOwner({ ...current, status: 'pending' })
					break
				}
				case 'edit': {
					authorizeOwner()
					authorizeAttempt()
					if (request.description !== undefined && request.appendDescription !== undefined) {
						throw new TeamError('task edit accepts either description or append_description, not both', 'TEAM_INVALID_ARGUMENT')
					}
					if (
						request.subject === undefined &&
						request.description === undefined &&
						request.appendDescription === undefined &&
						request.writeScopes === undefined &&
						request.priority === undefined &&
						request.lesson === undefined
					) {
						throw new TeamError('task edit requires subject, description, append_description, write_scopes, priority, or lesson', 'TEAM_INVALID_ARGUMENT')
					}
					/* Append mode exists because replace-mode forces a get+concat round-trip
					 * that loses concurrent appends; the result is still bounded by the
					 * same 16384-char limit as a wholesale replacement. */
					const appended =
						request.appendDescription === undefined
							? undefined
							: requiredText(`${current.description}\n${requiredText(request.appendDescription, 'append_description', 16384)}`, 'description', 16384)
					next = {
						...current,
						...(request.subject === undefined ? {} : { subject: requiredText(request.subject, 'subject', 200) }),
						...(request.description === undefined
							? appended === undefined
								? {}
								: { description: appended }
							: { description: requiredText(request.description, 'description', 16384) }),
						...(request.writeScopes === undefined ? {} : { writeScopes: this.writeScopes(request.writeScopes) }),
						...(request.priority === undefined ? {} : { priority: taskPriority(request.priority) }),
					}
					break
				}
				case 'set_dependencies': {
					authorizeOwner()
					authorizeAttempt()
					if (current.status === 'completed') throw new TeamError(`cannot change dependencies of completed task "${current.id}"`, 'TEAM_TASK_INVALID_TRANSITION')
					if (request.blockedBy === undefined) throw new TeamError('set_dependencies requires blocked_by', 'TEAM_INVALID_ARGUMENT')
					next = { ...current, blockedBy: this.dependencies(request.blockedBy, state, current.id) }
					break
				}
				case 'complete': {
					authorizeOwner()
					authorizeAttempt()
					if (current.status !== 'in_progress') throw new TeamError('only an in-progress task can complete', 'TEAM_TASK_INVALID_TRANSITION')
					this.assertAcceptanceCovered(current, request.description)
					next = { ...current, status: 'completed' }
					break
				}
				case 'reopen': {
					authorizeOwner()
					authorizeAttempt()
					if (current.status !== 'completed') throw new TeamError('only a completed task can reopen', 'TEAM_TASK_INVALID_TRANSITION')
					// Drop dangling blockers: a deleted blocker would leave the reopened
					// task permanently not-ready.
					const liveIds = new Set(state.tasks.filter((t) => t.status !== 'deleted').map((t) => t.id))
					const cleaned = current.blockedBy.filter((id) => liveIds.has(id))
					next = this.withoutOwner({
						...current,
						status: 'pending',
						...(cleaned.length !== current.blockedBy.length ? { blockedBy: cleaned } : {}),
					})
					break
				}
				case 'reassign': {
					if (!lead) throw new TeamError('only the Team Lead can reassign tasks', 'TEAM_LEAD_REQUIRED')
					if (current.status !== 'pending' && current.status !== 'in_progress') {
						throw new TeamError('only a pending or in-progress task can be reassigned', 'TEAM_TASK_INVALID_TRANSITION')
					}
					if (request.owner === undefined || request.owner.trim().length === 0) {
						next = this.withoutOwner({ ...current, status: 'pending' })
						break
					}
					if (!taskReady(state, current)) throw new TeamError(`team task "${current.id}" is blocked by ${this.pendingBlockers(state, current)}`, 'TEAM_TASK_BLOCKED')
					const assignee = resolveActiveMember(root, state, request.owner)
					next = { ...current, status: 'in_progress', ownerId: assignee.id, attemptId: randomUUID() }
					break
				}
				case 'delete': {
					authorizeOwner()
					authorizeAttempt()
					const dependent = state.tasks.find((task) => task.status !== 'deleted' && task.id !== current.id && task.blockedBy.includes(current.id))
					if (dependent !== undefined) throw new TeamError(`team task "${current.id}" still blocks "${dependent.id}"`, 'TEAM_TASK_HAS_DEPENDENTS')
					next = { ...current, status: 'deleted' }
					break
				}
				default:
					throw new TeamError(`unsupported task action ${String(request.action)}`, 'TEAM_INVALID_ARGUMENT')
			}
			const task: TeamTaskSnapshot = {
				...next,
				/* `lesson` is merged outside the switch so any action accepts it
				 * (complete is the main path), following the same "omit when absent"
				 * convention as acceptance/priority. */
				...(request.lesson === undefined ? {} : { lesson: validateLesson(request.lesson) }),
				revision: current.revision + 1,
				updatedAt: Date.now(),
				history: [
					...(current.history ?? []),
					{
						revision: current.revision + 1,
						action: request.action,
						status: next.status,
						...(next.ownerId === undefined ? {} : { ownerId: next.ownerId }),
						at: Date.now(),
					},
				],
			}
			assertTaskTransition(current.status, task.status)
			this.assertTaskGraph(state, task)
			/* Optional write-scope hard gate: only owner-binding transitions (claim and
			 * member-bound reassign) actually start writing, so only they are blocked.
			 * The Lead never triggers it — Lead tasks carry no scopes. */
			if (this.enforceWriteScopes && (request.action === 'claim' || (request.action === 'reassign' && task.ownerId !== undefined))) {
				const { conflicts } = detectWriteScopeConflict(task, state.tasks, ['in_progress', 'pending'])
				const blocking = conflicts.filter((hit) => !hit.sameOwner)
				if (blocking.length > 0) {
					const statusOf = (id: string): string => state.tasks.find((candidate) => candidate.id === id)?.status ?? 'unknown'
					/* The blocker may be pending (queued, nobody writing) or in_progress
					 * (actively writing) — name the status so a teammate does not mistake
					 * a queued scope reservation for a live writer. */
					throw new TeamError(
						`team task "${task.id}" write scopes conflict with ${blocking
							.map((hit) => `${statusOf(hit.taskId)} task "${hit.taskId}" on ${hit.overlaps.map((scope) => JSON.stringify(scope)).join(', ')}`)
							.join('; ')}`,
						'TEAM_WRITE_SCOPE_CONFLICT',
					)
				}
			}
			await this.journal.appendAndFlush(root, 'team/task', { version: 2, teamId: teamId(root.id), task })
			const view = projectTaskView(state, task, caller.id)
			/* Surface the cleared owner on transitions that unassign — callers
			 * shouldn't have to diff ownerName against a cached view to learn
			 * that reopen/release stripped the assignment. */
			if (current.ownerId !== undefined && task.ownerId === undefined) {
				const previousOwnerName = current.ownerId === state.id ? 'lead' : state.members.find((m) => m.id === current.ownerId)?.name
				return { ...view, ...(previousOwnerName === undefined ? {} : { previousOwnerName }) }
			}
			return view
		})
	}

	/** Validate and de-duplicate dependency ids against the current task graph. */
	private dependencies(values: readonly string[], state: TeamState, self?: string): string[] {
		const seen = new Set<string>()
		const result: string[] = []
		for (const id of values) {
			const branded = taskId(id)
			if (branded === self) throw new TeamError('a team task cannot block itself', 'TEAM_TASK_DEPENDENCY_CYCLE')
			if (seen.has(branded)) throw new TeamError(`duplicate blocker "${id}"`, 'TEAM_INVALID_ARGUMENT')
			const task = state.tasks.find((candidate) => candidate.id === branded)
			if (task === undefined || task.status === 'deleted') throw new TeamError(`blocker task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
			seen.add(branded)
			result.push(branded)
		}
		return result
	}

	/** Normalize and de-duplicate task write scopes. */
	private writeScopes(values: readonly string[]): string[] {
		return [...new Set(values.map((value) => writeScope(value)))]
	}

	/** Map shared task-graph validation onto stable command error codes. */
	private assertTaskGraph(state: TeamState, candidate: TeamTaskSnapshot): void {
		try {
			assertTaskGraphCandidate(state.tasks, candidate)
		} catch (error) {
			if (!(error instanceof TeamTaskGraphError)) throw error
			throw new TeamError(error.message, TASK_GRAPH_ERROR_CODES[error.violation], { cause: error })
		}
	}

	/**
	 * Format the not-yet-completed blockers of one task for blocked-transition errors.
	 * @returns "id (status), ..." per unfinished blocker, or "unknown blocker" when none resolve.
	 */
	private pendingBlockers(state: TeamState, task: TeamTaskSnapshot): string {
		const pending = task.blockedBy
			.map((id) => state.tasks.find((candidate) => candidate.id === id))
			.filter((blocker) => blocker !== undefined && blocker.status !== 'completed')
		if (pending.length === 0) return 'unknown blocker'
		return pending.map((blocker) => `${blocker!.id} (${blocker!.status})`).join(', ')
	}

	/**
	 * Require an updated description covering every declared acceptance criterion.
	 *
	 * A deliberately loose approximation that blocks "nothing written" rather than
	 * validating coverage quality: one criterion counts as covered when any
	 * ≥4-letter English token appears in the description, or when the whole
	 * criterion is a substring. Strict keyword matching would reject paraphrases
	 * and Chinese criteria.
	 */
	private assertAcceptanceCovered(current: TeamTaskSnapshot, incomingDescription: string | undefined): void {
		const criteria = current.acceptance ?? []
		if (criteria.length === 0) return
		const description = (incomingDescription ?? current.description).toLowerCase()
		const missing = criteria.filter(
			(criterion) =>
				!criterion
					.toLowerCase()
					.split(/\s+/)
					.filter((word) => word.length >= 4)
					.some((word) => description.includes(word)) && !description.includes(criterion.toLowerCase()),
		)
		if (missing.length > 0) {
			throw new TeamError(
				`team task "${current.id}" declares ${criteria.length} acceptance criteria; complete requires a description covering each (${missing.length} uncovered: ${missing
					.map((c) => JSON.stringify(c))
					.join(', ')})`,
				'TEAM_ACCEPTANCE_MISSING',
			)
		}
	}

	/** Remove owner + attempt capability; unassigning always revokes the old attemptId. */
	private withoutOwner(task: TeamTaskSnapshot): TeamTaskSnapshot {
		const { ownerId: _ownerId, attemptId: _attemptId, ...rest } = task
		return rest
	}
}
