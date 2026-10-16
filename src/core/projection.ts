/** Team state projected incrementally from committed Session events, with a durable-only client view. */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { TeamEvent, TeamMemberSnapshot, TeamMessageSnapshot, TeamState, TeamTaskSnapshot } from './types.js'
import { messageId, taskId, teamId } from './types.js'
import { assertTaskGraphCandidate } from './task-graph.js'
import { projectTaskView } from './task-view.js'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positiveSafeInteger = nonNegativeSafeInteger.min(1)
const sessionIdSchema = z.string().min(1).transform((value) => brandString(value))
const teamIdSchema = z.string().min(1).transform((value) => teamId(value))
const numericTaskIdPattern = /^task-(\d+)$/u
const teamTaskIdSchema = z
	.string()
	.min(1)
	.refine((value) => {
		const match = numericTaskIdPattern.exec(value)
		return match === null || Number.isSafeInteger(Number(match[1]))
	}, { message: 'numeric task id suffix must be a safe integer' })
	.transform((value) => taskId(value))
const teamMessageIdSchema = z.string().min(1).transform((value) => messageId(value))

const coreContentBlockTypes = new Set(['text', 'reasoning', 'image', 'tool-call', 'tool-result'])

const imageAttachmentSchema = z
	.object({
		attachmentId: z.string().min(1),
		mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
		bytes: nonNegativeSafeInteger,
		width: positiveSafeInteger,
		height: positiveSafeInteger,
		name: z.string().optional(),
	})
	.strict()

const contentBlockSchema = z.lazy(() =>
	z.union([
		z.object({ type: z.literal('text'), text: z.string() }).strict(),
		z.object({ type: z.literal('reasoning'), text: z.string() }).strict(),
		z.object({ type: z.literal('image'), attachment: imageAttachmentSchema }).strict(),
		z.object({ type: z.literal('tool-call'), id: z.string().min(1), name: z.string(), arguments: z.string() }).strict(),
		z.custom((value) => {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
			const type = (value as { type?: unknown }).type
			return typeof type === 'string' && type.length > 0 && !coreContentBlockTypes.has(type)
		}),
	]),
)

const teamMemberSnapshotSchema = z
	.object({
		id: sessionIdSchema,
		name: z.string(),
		description: z.string(),
		provider: z.string(),
		context: z.enum(['fresh', 'fork']),
		phase: z.enum(['provisioning', 'active', 'failed', 'released']),
		error: z.string().optional(),
	})
	.strict()

const teamTaskSnapshotSchema = z
	.object({
		id: teamTaskIdSchema,
		revision: positiveSafeInteger,
		subject: z.string(),
		description: z.string(),
		status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
		ownerId: sessionIdSchema.optional(),
		// attemptId = current attempt's capability token; reassign/release/reopen revoke it.
		attemptId: z.string().optional(),
		createdAt: z.number().optional(),
		updatedAt: z.number().optional(),
		history: z
			.array(
				z
					.object({
						revision: positiveSafeInteger,
						action: z.string(),
						status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
						ownerId: sessionIdSchema.optional(),
						at: z.number(),
					})
					.strict(),
			)
			.optional(),
		blockedBy: z.array(teamTaskIdSchema),
		writeScopes: z.array(z.string()),
		acceptance: z.array(z.string()).optional(),
		priority: z.string().optional(),
		lesson: z.string().optional(),
	})
	.strict()

const teamMessageSnapshotSchema = z
	.object({
		id: teamMessageIdSchema,
		senderId: sessionIdSchema,
		senderName: z.string(),
		targetId: sessionIdSchema,
		content: z.array(contentBlockSchema),
		queuedAt: z.number().optional(),
	})
	.strict()

const teamEventSelectorSchema = z.object({ version: nonNegativeSafeInteger, teamId: teamIdSchema }).loose()
const teamMemberEventSchema = z.object({ version: z.literal(2), teamId: teamIdSchema, member: teamMemberSnapshotSchema }).strict()
const teamTaskEventSchema = z.object({ version: z.literal(2), teamId: teamIdSchema, task: teamTaskSnapshotSchema }).strict()
const teamMessageQueuedEventSchema = z.object({ version: z.literal(2), teamId: teamIdSchema, message: teamMessageSnapshotSchema }).strict()
const teamMessageDeliveredEventSchema = z.object({
	version: z.literal(2),
	teamId: teamIdSchema,
	messageId: teamMessageIdSchema,
	targetId: sessionIdSchema,
}).strict()

/** Construct empty state for one Team identity. */
export function emptyTeamState(rootId: string): TeamState {
	return { id: teamId(rootId), members: [], tasks: [], messages: [], delivered: [], nextTaskNumber: 1 }
}

const teamProjectionEntrySchema = z
	.object({
		id: teamIdSchema,
		members: z.array(teamMemberSnapshotSchema),
		tasks: z.array(teamTaskSnapshotSchema),
		messages: z.array(teamMessageSnapshotSchema),
		delivered: z.array(teamMessageIdSchema),
		nextTaskNumber: positiveSafeInteger,
		failure: z.string().optional(),
	})
	.strict()

/** Test whether a Session event belongs to the Team domain. */
export function isTeamEvent(event: { readonly type: string }): event is TeamEvent {
	return (
		event.type === 'team/member' ||
		event.type === 'team/task' ||
		event.type === 'team/message/queued' ||
		event.type === 'team/message/delivered'
	)
}

/** Decode one persisted Team value and retain the schema failure as its cause. */
function parsePersisted<T extends z.ZodTypeAny>(type: string, schema: T, value: unknown): z.infer<T> {
	try {
		return schema.parse(value) as z.infer<T>
	} catch (error) {
		throw new Error(`persisted Agent Teams ${type} payload is invalid`, { cause: error })
	}
}

/**
 * Remove runtime-injected internal keys from a persisted task snapshot before
 * strict schema validation. Older sessions may carry keys like `_ownerName`
 * that were never part of the durable schema — stripping them lets the
 * projection replay cleanly instead of freezing on the first polluted event.
 */
const INTERNAL_TASK_KEYS = ['_ownerName'] as const

function sanitizePersistedTask(task: unknown): unknown {
	if (typeof task !== 'object' || task === null || Array.isArray(task)) return task
	const clean = { ...(task as Record<string, unknown>) }
	for (const key of INTERNAL_TASK_KEYS) delete clean[key]
	return clean
}

/** Decode the complete current-version payload selected by one Team event type. */
function parseCurrentTeamEvent(event: TeamEvent): TeamEvent {
	switch (event.type) {
		case 'team/member':
			return { ...event, data: parsePersisted(event.type, teamMemberEventSchema, event.data) }
		case 'team/task': {
			const data =
				typeof event.data === 'object' && event.data !== null
					? { ...(event.data as Record<string, unknown>), task: sanitizePersistedTask((event.data as { task?: unknown }).task) }
					: event.data
			return { ...event, data: parsePersisted(event.type, teamTaskEventSchema, data) }
		}
		case 'team/message/queued':
			return { ...event, data: parsePersisted(event.type, teamMessageQueuedEventSchema, event.data) }
		case 'team/message/delivered':
			return { ...event, data: parsePersisted(event.type, teamMessageDeliveredEventSchema, event.data) }
		default:
			return event
	}
}

/** Legal durable member-phase edges; a released member is terminal. */
const TEAM_MEMBER_PHASE_TRANSITIONS: Record<TeamMemberSnapshot['phase'], TeamMemberSnapshot['phase'][]> = {
	provisioning: ['active', 'failed', 'released'],
	active: ['released'],
	failed: ['released'],
	released: [],
}

function replaceAt<T>(items: readonly T[], index: number, item: T): T[] {
	const next = [...items]
	if (index < 0) next.push(item)
	else next[index] = item
	return next
}

/** Fold one current-version Team event into state. Throws on an illegal transition. */
function applyCurrentTeamEvent(state: TeamState, event: TeamEvent): TeamState {
	switch (event.type) {
		case 'team/member': {
			const member = event.data.member as TeamMemberSnapshot
			const index = state.members.findIndex((candidate) => candidate.id === member.id)
			const prior = state.members[index]
			const named = state.members.find((candidate) => candidate.name === member.name)
			if (named !== undefined && named.id !== member.id) throw new Error(`teammate name "${member.name}" is reused by another member`)
			if (prior === undefined) {
				if (member.phase !== 'provisioning') throw new Error(`teammate "${member.name}" must begin provisioning`)
			} else {
				if (prior.name !== member.name || prior.provider !== member.provider || prior.context !== member.context) {
					throw new Error(`teammate "${member.id}" changed immutable identity fields`)
				}
				if (!TEAM_MEMBER_PHASE_TRANSITIONS[prior.phase].includes(member.phase)) {
					throw new Error(`teammate "${member.name}" has an invalid ${prior.phase} -> ${member.phase} transition`)
				}
			}
			return { ...state, members: replaceAt(state.members, index, member) }
		}
		case 'team/task': {
			const task = event.data.task as TeamTaskSnapshot
			const index = state.tasks.findIndex((candidate) => candidate.id === task.id)
			const prior = state.tasks[index]
			if (prior === undefined && task.revision !== 1) {
				/* Replay gap: earlier revisions were lost (torn write or dropped flush).
				 * Accept the surviving event rather than freezing the whole Team
				 * projection — the snapshot itself is still valid. */
			} else if (prior !== undefined && task.revision !== prior.revision + 1) {
				throw new Error(`team task "${task.id}" revision is not contiguous`)
			}
			assertTaskGraphCandidate(state.tasks, task)
			let nextTaskNumber = state.nextTaskNumber
			const match = numericTaskIdPattern.exec(task.id)
			if (match !== null) {
				const number = Number(match[1])
				nextTaskNumber = Math.max(nextTaskNumber, number === Number.MAX_SAFE_INTEGER ? number : number + 1)
			}
			return { ...state, tasks: replaceAt(state.tasks, index, task), nextTaskNumber }
		}
		case 'team/message/queued': {
			const message = event.data.message as TeamMessageSnapshot
			if (state.messages.some((candidate) => candidate.id === message.id)) throw new Error(`team message "${message.id}" was queued twice`)
			return { ...state, messages: [...state.messages, message] }
		}
		case 'team/message/delivered': {
			const { messageId: id, targetId } = event.data as { messageId: string; targetId: string }
			const queued = state.messages.find((message) => message.id === id)
			if (queued === undefined) throw new Error(`team message "${id}" was delivered before queueing`)
			if (queued.targetId !== targetId) throw new Error(`team message "${id}" target changed`)
			if (state.delivered.includes(messageId(id))) throw new Error(`team message "${id}" was delivered twice`)
			return { ...state, delivered: [...state.delivered, messageId(id)] }
		}
		default:
			return state
	}
}

/**
 * Fold one Session event into Team state. Any illegal payload or transition is
 * retained as `state.failure` rather than thrown — a frozen projection is
 * diagnosable and recoverable, a crashing one is not.
 */
export function applyProjectionEvent(state: TeamState, event: { readonly type: string; readonly data: unknown }): TeamState {
	if (state.failure !== undefined) return state
	if (!isTeamEvent(event)) return state
	try {
		const selector = parsePersisted(event.type, teamEventSelectorSchema, event.data) as { teamId: string; version: number }
		if (selector.teamId !== state.id) return state
		if (selector.version !== 2) throw new Error(`unsupported Agent Teams event version ${String(selector.version)}`)
		return applyCurrentTeamEvent(state, parseCurrentTeamEvent(event))
	} catch (error) {
		return { ...state, failure: error instanceof Error ? error.message : String(error) }
	}
}

/** One wire-view roster row. */
export interface TeamProjectionMember {
	readonly id: string
	readonly name: string
	readonly role: 'lead' | 'teammate'
	readonly phase: TeamMemberSnapshot['phase']
	readonly error?: string
}

/** One wire-view mailbox row — text only, ids already resolved to names. */
export interface TeamProjectionMessage {
	readonly id: string
	readonly from: string
	readonly to: string
	readonly text: string
	readonly queuedAt?: number
	readonly delivered: boolean
}

/** Durable-only client view published to the web team board. */
export interface TeamProjection {
	readonly members: readonly TeamProjectionMember[]
	readonly tasks: readonly ReturnType<typeof projectTaskView>[]
	readonly messages: readonly TeamProjectionMessage[]
	readonly failure?: string
}

/** Flatten message content blocks to display text; unknown blocks render as a placeholder. */
function messageText(content: readonly unknown[]): string {
	return content
		.map((block) => {
			const type = (block as { type?: unknown } | null)?.type
			return type === 'text' ? String((block as { text?: unknown }).text) : `[${String(type)}]`
		})
		.join('\n')
}

function buildTeamProjection(state: TeamState): TeamProjection {
	const members: TeamProjectionMember[] = [{ id: brandString(state.id), name: 'lead', role: 'lead', phase: 'active' }]
	for (const member of state.members) {
		members.push({
			id: member.id,
			name: member.name,
			role: 'teammate',
			phase: member.phase,
			...(member.error === undefined ? {} : { error: member.error }),
		})
	}
	/* Mailbox rows are folded in so the board can render team conversation history.
	 * The delivered set is part of the cache key below, so a delivery edge also
	 * republishes the view. */
	const deliveredSet = new Set(state.delivered)
	const messages: TeamProjectionMessage[] = state.messages.map((message) => ({
		id: message.id,
		from: message.senderName,
		to: state.members.find((member) => member.id === message.targetId)?.name ?? (message.targetId === brandString(state.id) ? 'lead' : 'unknown'),
		text: messageText(message.content),
		...(message.queuedAt === undefined ? {} : { queuedAt: message.queuedAt }),
		delivered: deliveredSet.has(message.id),
	}))
	return {
		members,
		tasks: state.tasks.filter((task) => task.status !== 'deleted').map((task) => projectTaskView(state, task)),
		messages,
		...(state.failure === undefined ? {} : { failure: state.failure }),
	}
}

/** Client views keyed by the member, task, and mailbox collections they were derived from. */
const teamProjectionViews = new WeakMap<object, WeakMap<object, WeakMap<object, TeamProjection>>>()

/**
 * Durable client view of one Team state. Mailbox-only state changes reuse the
 * previous view reference, so the live drive publishes nothing for them.
 * A failure is terminal: later events retain the failed state reference and
 * do not republish its view.
 * @param state - current Team state.
 * @returns the roster and non-deleted task board, plus any projection failure.
 */
export function teamProjectionView(state: TeamState): TeamProjection {
	if (state.failure !== undefined) return buildTeamProjection(state)
	let byTasks = teamProjectionViews.get(state.members)
	if (byTasks === undefined) {
		byTasks = new WeakMap()
		teamProjectionViews.set(state.members, byTasks)
	}
	let byMessages = byTasks.get(state.tasks)
	if (byMessages === undefined) {
		byMessages = new WeakMap()
		byTasks.set(state.tasks, byMessages)
	}
	let view = byMessages.get(state.delivered)
	if (view === undefined) {
		view = buildTeamProjection(state)
		byMessages.set(state.delivered, view)
	}
	return view
}

const teamMemberProjectionSchema = z
	.object({
		id: sessionIdSchema,
		name: z.string(),
		role: z.enum(['lead', 'teammate']),
		phase: z.enum(['provisioning', 'active', 'failed', 'released']),
		error: z.string().optional(),
	})
	.strict()

const teamMessageViewSchema = z
	.object({
		id: z.string(),
		from: z.string(),
		to: z.string(),
		text: z.string(),
		queuedAt: z.number().optional(),
		delivered: z.boolean(),
	})
	.strict()

const teamWriteScopeConflictSchema = z
	.object({
		taskId: teamTaskIdSchema,
		ownerId: z.string().optional(),
		scopes: z.array(z.string()),
	})
	.strict()

const teamTaskViewSchema = z
	.object({
		id: teamTaskIdSchema,
		revision: positiveSafeInteger,
		subject: z.string(),
		description: z.string(),
		descriptionTruncated: z.boolean().optional(),
		status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
		blockedBy: z.array(teamTaskIdSchema),
		writeScopes: z.array(z.string()),
		ownerName: z.string().optional(),
		ready: z.boolean(),
		writeScopeWarnings: z.array(z.string()),
		conflicts: z.array(teamWriteScopeConflictSchema).optional(),
		acceptance: z.array(z.string()).optional(),
		priority: z.string().optional(),
		createdAt: z.number().optional(),
		updatedAt: z.number().optional(),
		history: z
			.array(
				z
					.object({
						revision: positiveSafeInteger,
						action: z.string(),
						status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
						ownerName: z.string().optional(),
						at: z.number(),
					})
					.strict(),
			)
			.optional(),
		lesson: z.string().optional(),
	})
	.strict()

const teamProjectionSchema = z
	.object({
		members: z.array(teamMemberProjectionSchema),
		tasks: z.array(teamTaskViewSchema),
		messages: z.array(teamMessageViewSchema),
		failure: z.string().optional(),
	})
	.strict()

/** Team projection selected by the projected Session identity. */
export const teamProjectionDefinition = {
	key: 'agentTeam',
	stateVersion: 5,
	stateSchema: teamProjectionEntrySchema,
	init: (header: { id: string }) => emptyTeamState(header.id),
	apply: applyProjectionEvent,
	wire: {
		viewSchema: teamProjectionSchema,
		view: teamProjectionView,
	},
} as const
