/** Input normalization shared by Team roster and task commands. */

import { TeamError } from './error.js'

/**
 * Normalize one required human-authored string.
 * @param value - raw input value.
 * @param field - diagnostic field name.
 * @param maxLength - maximum normalized character count.
 * @returns trimmed non-empty text.
 */
export function requiredText(value: unknown, field: string, maxLength: number): string {
	const text = typeof value === 'string' ? value.trim() : ''
	if (text.length === 0) throw new TeamError(`${field} must be non-empty`, 'TEAM_INVALID_ARGUMENT')
	if (text.length > maxLength) throw new TeamError(`${field} exceeds ${maxLength} characters`, 'TEAM_INVALID_ARGUMENT')
	return text
}

/**
 * Validate the optional `lesson` handoff note attached to a task update.
 * @param value - raw request value; non-string and empty/oversized input fail.
 * @returns trimmed lesson text.
 */
export function validateLesson(value: unknown): string {
	if (typeof value !== 'string') throw new TeamError('lesson must be a non-empty string', 'TEAM_VALIDATION')
	const text = value.trim()
	if (text.length === 0) throw new TeamError('lesson must be non-empty', 'TEAM_VALIDATION')
	if (text.length > 500) throw new TeamError('lesson exceeds 500 characters', 'TEAM_VALIDATION')
	return text
}

/**
 * Normalize one workspace-relative path prefix without treating it as a lock.
 *
 * Accepts absolute paths: a model often passes `file_path` verbatim, so the
 * drive/root prefix is stripped (`E:\opencv\x.py` → `opencv/x.py`) and the
 * scope keeps meaning "prefix under some workspace root" — which root that is
 * stays a consumer decision (the claim-time `file_path` comparison).
 * @param value - user-authored path prefix.
 * @returns normalized slash-separated prefix.
 */
export function writeScope(value: unknown): string {
	if (typeof value !== 'string') throw new TeamError('write scope must be a string', 'TEAM_INVALID_WRITE_SCOPE')
	const slashed = value.replaceAll('\\', '/')
	const normalized = slashed
		.replace(/^\.\//u, '')
		.replace(/^[a-z]:\//iu, '')
		.replace(/^\/+/u, '')
		.replace(/\/+$/u, '')
	const segments = normalized.split('/')
	if (normalized.length === 0 || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
		throw new TeamError(
			`invalid write scope ${JSON.stringify(value)}; pass a workspace-relative prefix or an absolute path`,
			'TEAM_INVALID_WRITE_SCOPE',
		)
	}
	return normalized
}

/** Canonical dispatch priority, with the Chinese aliases the prompts already use. */
export type TaskPriority = 'high' | 'medium' | 'low'

/**
 * Normalize an optional task priority label to the canonical high/medium/low
 * vocabulary the scheduler sorts on. Accepts the Chinese aliases so a Lead
 * writing 高/中/低 lands on the same ordering.
 * @param value - user-authored priority label.
 * @returns canonical priority string.
 */
export function taskPriority(value: unknown): TaskPriority {
	const raw = typeof value === 'string' ? value.trim() : ''
	const canonical = PRIORITY_ALIASES[raw.toLowerCase()] ?? PRIORITY_ALIASES[raw]
	if (canonical === undefined) {
		throw new TeamError(`invalid task priority ${JSON.stringify(value)}; use high, medium, or low`, 'TEAM_INVALID_ARGUMENT')
	}
	return canonical
}

/**
 * Sort weight per canonical priority. The twin of {@link taskPriority}'s alias
 * table — the scheduler owns ordering, the validator owns normalization, and
 * both must agree on the alias set.
 */
export const PRIORITY_WEIGHT: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 }

const PRIORITY_ALIASES: Record<string, TaskPriority> = {
	high: 'high', '高': 'high',
	medium: 'medium', '中': 'medium',
	low: 'low', '低': 'low',
}
