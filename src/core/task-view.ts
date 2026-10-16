/** Pure task-view derivation shared by the task board and the client projection. */

import type { TeamState, TeamTaskSnapshot, TeamTaskView, TeamWriteScopeConflict } from './types.js'
import { taskId } from './types.js'
import { compressTaskBrief } from './compress.js'

/**
 * Whether two normalized file or directory prefixes overlap on path components.
 *
 * A sibling sharing only a directory (`a/b/c.txt` vs `a/b/d.txt`) does NOT
 * overlap — one side must be a strict component-wise prefix of the other.
 * @param left - normalized write scope.
 * @param right - normalized write scope.
 * @returns whether either scope contains the other.
 */
export function scopesOverlap(left: string, right: string): boolean {
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/**
 * Whether every current blocker of one task completed.
 * @param state - Team state supplying sibling tasks.
 * @param task - durable task snapshot to test.
 * @returns whether the task has no incomplete blockers.
 */
export function taskReady(state: TeamState, task: TeamTaskSnapshot): boolean {
	return task.blockedBy.every((id) => state.tasks.find((candidate) => candidate.id === id)?.status === 'completed')
}

/** One raw write-scope overlap hit, before the advisory/enforcement split. */
export interface WriteScopeHit {
	readonly taskId: string
	readonly ownerId?: string
	readonly sameOwner: boolean
	readonly overlaps: readonly string[]
}

/**
 * Detect real write-scope conflicts between one task and its siblings.
 *
 * Same-owner hits are returned flagged `sameOwner: true` — one writer can
 * serialize its own scoped work, so enforcement ignores them, but the advisory
 * layer still wants the hint.
 * @param task - durable task snapshot to check.
 * @param tasks - sibling snapshots from the current Team state.
 * @param statuses - which sibling statuses count as conflicting holders.
 * @returns one entry per overlapping sibling, with the candidate's own colliding scopes.
 */
export function detectWriteScopeConflict(
	task: TeamTaskSnapshot,
	tasks: readonly TeamTaskSnapshot[],
	statuses: readonly TeamTaskSnapshot['status'][],
): { conflicts: WriteScopeHit[] } {
	const conflicts: WriteScopeHit[] = []
	for (const other of tasks) {
		if (other.id === task.id || !statuses.includes(other.status)) continue
		const overlaps = task.writeScopes.filter((left) => other.writeScopes.some((right) => scopesOverlap(left, right)))
		if (overlaps.length === 0) continue
		conflicts.push({
			taskId: other.id,
			...(other.ownerId === undefined ? {} : { ownerId: other.ownerId }),
			sameOwner: other.ownerId === task.ownerId,
			overlaps,
		})
	}
	return { conflicts }
}

/**
 * Derive one task view with owner name, readiness, and advisory write overlaps.
 *
 * A committing caller may pass its pre-append state because `task` supplies the
 * new value explicitly; owner names, blocker readiness, and other task scopes
 * do not change when that snapshot is appended.
 * @param state - Team state supplying members and sibling tasks.
 * @param task - durable task snapshot to view.
 * @param viewerId - optional caller session id; the attemptId capability token
 * is exposed only to the current owner — durable projections and other members'
 * views omit it so the token cannot be harvested and replayed.
 * @returns a detached task view.
 */
export function projectTaskView(state: TeamState, task: TeamTaskSnapshot, viewerId?: string): TeamTaskView {
	const ownerName = task.ownerId === undefined ? undefined : task.ownerId === state.id ? 'lead' : state.members.find((member) => member.id === task.ownerId)?.name
	const warnings = new Set<string>()
	/* Advisory must cover the same statuses the enforce gate blocks on
	 * (in_progress + pending, see task-board.ts) — otherwise list/get stay silent
	 * about a pending sibling whose overlap will reject the caller's next claim. */
	const { conflicts: detected } = detectWriteScopeConflict(task, state.tasks, ['in_progress', 'pending'])
	const conflicts: TeamWriteScopeConflict[] = []
	for (const hit of detected) {
		warnings.add(`write scopes overlap with ${hit.taskId}`)
		if (!hit.sameOwner) {
			conflicts.push({
				taskId: taskId(hit.taskId),
				...(hit.ownerId === undefined ? {} : { ownerId: hit.ownerId }),
				scopes: hit.overlaps,
			})
		}
	}
	/* A completed task's description is a completion report, not a task book —
	 * teammates write thousands of words there (commit lists, build output, grep
	 * re-checks), and projecting it in full made one live session's status/list
	 * balloon to 1.7M tokens. Completed tasks no longer drive work, so the
	 * projection keeps only the skeleton; `task_get` still returns the full text. */
	const description = task.status === 'completed' ? compressTaskBrief(task.description, { max: 1200 }).text : task.description
	/* The compressed skeleton is shorter than the stored report, so flag it —
	 * otherwise a lead reading list/status cannot tell the text was cut. */
	const truncated = task.status === 'completed' && description !== task.description
	return {
		id: task.id,
		revision: task.revision,
		subject: task.subject,
		description,
		...(truncated ? { descriptionTruncated: true } : {}),
		status: task.status,
		blockedBy: [...task.blockedBy],
		writeScopes: [...task.writeScopes],
		...(ownerName === undefined ? {} : { ownerName }),
		ready: task.status === 'pending' && taskReady(state, task),
		writeScopeWarnings: [...warnings],
		...(conflicts.length > 0 ? { conflicts } : {}),
		...(task.acceptance === undefined ? {} : { acceptance: [...task.acceptance] }),
		...(task.priority === undefined ? {} : { priority: task.priority }),
		...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
		...(task.updatedAt === undefined ? {} : { updatedAt: task.updatedAt }),
		...(task.history === undefined
			? {}
			: {
					history: task.history.map((entry) => ({
						revision: entry.revision,
						action: entry.action,
						status: entry.status,
						...(entry.ownerId === undefined
							? {}
							: {
									ownerName: entry.ownerId === state.id ? 'lead' : state.members.find((member) => member.id === entry.ownerId)?.name,
								}),
						at: entry.at,
					})),
				}),
		...(task.lesson === undefined ? {} : { lesson: task.lesson }),
		...(viewerId !== undefined && viewerId === task.ownerId && task.attemptId !== undefined ? { attemptId: task.attemptId } : {}),
	}
}
