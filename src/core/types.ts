/** Agent Teams identities and the shared durable-record shapes. */

/** Root Session identity branded as its implicit Team identity. */
export type TeamId = string & { readonly __brand: 'TeamId' }
/** Team-local task identity. */
export type TeamTaskId = string & { readonly __brand: 'TeamTaskId' }
/** Durable mailbox message identity. */
export type TeamMessageId = string & { readonly __brand: 'TeamMessageId' }

/** Brand one root Session identity as its implicit Team identity. */
export function teamId(id: string): TeamId {
	return id as TeamId
}

/** Brand a validated task id. */
export function taskId(id: string): TeamTaskId {
	return id as TeamTaskId
}

/** Brand a generated peer-message id. */
export function messageId(id: string): TeamMessageId {
	return id as TeamMessageId
}

export type TeamMemberPhase = 'provisioning' | 'active' | 'failed' | 'released'

/** Context mode recorded when a member was created. */
export type TeamMemberContext = 'fresh' | 'fork'

/** One durable roster row. */
export interface TeamMemberSnapshot {
	readonly id: string
	readonly name: string
	readonly description: string
	readonly provider: string
	readonly context: TeamMemberContext
	readonly phase: TeamMemberPhase
	readonly error?: string
}

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** One committed revision of a task's lifecycle. */
export interface TeamTaskHistoryEntry {
	readonly revision: number
	readonly action: string
	readonly status: TeamTaskStatus
	readonly ownerId?: string
	readonly at: number
}

/** One durable task snapshot. */
export interface TeamTaskSnapshot {
	readonly id: TeamTaskId
	readonly revision: number
	readonly subject: string
	readonly description: string
	readonly status: TeamTaskStatus
	readonly ownerId?: string
	/** Capability token for the current attempt; revoked on reassign/release/reopen. */
	readonly attemptId?: string
	readonly createdAt?: number
	readonly updatedAt?: number
	readonly history?: readonly TeamTaskHistoryEntry[]
	readonly blockedBy: readonly TeamTaskId[]
	readonly writeScopes: readonly string[]
	readonly acceptance?: readonly string[]
	readonly priority?: string
	readonly lesson?: string
}

/** One durable mailbox message. */
export interface TeamMessageSnapshot {
	readonly id: TeamMessageId
	readonly senderId: string
	readonly senderName: string
	readonly targetId: string
	readonly content: readonly unknown[]
	readonly queuedAt?: number
}

/** Projected Team state folded from committed Session events. */
export interface TeamState {
	readonly id: TeamId
	readonly members: readonly TeamMemberSnapshot[]
	readonly tasks: readonly TeamTaskSnapshot[]
	readonly messages: readonly TeamMessageSnapshot[]
	readonly delivered: readonly TeamMessageId[]
	readonly nextTaskNumber: number
	readonly failure?: string
}

/** Runtime-enriched roster row. */
export interface TeamMemberView {
	readonly id: string
	readonly name: string
	readonly role: 'lead' | 'teammate'
	readonly status: TeamAvailability
	readonly description?: string
	readonly provider?: string
	readonly context?: TeamMemberContext
	readonly model?: string
	readonly diagnostics: readonly string[]
}

/**
 * Live availability of a member.
 * `inactive` is a historical alias retained for consumers that read the
 * status string as a boolean check.
 */
export type TeamAvailability = 'running' | 'idle' | 'unloaded' | 'inactive' | 'provisioning' | 'released' | 'failed'

/** One advisory write-scope conflict. */
export interface TeamWriteScopeConflict {
	readonly taskId: TeamTaskId
	readonly ownerId?: string
	readonly scopes: readonly string[]
}

/** Detached task view returned to callers. */
export interface TeamTaskView {
	readonly id: TeamTaskId
	readonly revision: number
	readonly subject: string
	readonly description: string
	readonly status: TeamTaskStatus
	readonly blockedBy: readonly TeamTaskId[]
	readonly writeScopes: readonly string[]
	readonly ownerName?: string
	readonly ready: boolean
	readonly writeScopeWarnings: readonly string[]
	readonly conflicts?: readonly TeamWriteScopeConflict[]
	readonly acceptance?: readonly string[]
	readonly priority?: string
	readonly createdAt?: number
	readonly updatedAt?: number
	readonly history?: readonly { revision: number; action: string; status: TeamTaskStatus; ownerName?: string; at: number }[]
	readonly lesson?: string
	readonly attemptId?: string
	/** True on completed tasks whose projected description was compressed; the full text stays on the snapshot. */
	readonly descriptionTruncated?: boolean
	/** Owner cleared by reopen/release/unclaim — present only on the response that performed the unassign. */
	readonly previousOwnerName?: string
}

/** Caller membership resolved from one exact live Agent. */
export interface TeamMembership {
	readonly root: TeamAgent
	readonly id: TeamId
	readonly memberId: string
	readonly role: 'lead' | 'teammate'
	readonly name: string
}

/**
 * The slice of the DSH Agent surface the Team domain touches. Declared
 * structurally so the host plugin stays independent of `@deepseek-ai/dsh-agent`.
 */
export interface TeamAgent {
	readonly id: string
	readonly status: 'idle' | 'running'
	readonly session: TeamSession
	readonly options: { model?: string }
	steer(input: unknown): void
	cancel?(cause: unknown, options?: unknown): void
}

/** The slice of the DSH Session surface the Team domain touches. */
export interface TeamSession {
	readonly id: string
	readonly inheritedEventCount: number
	readonly header: { readonly parentSession?: string }
	append(type: string, data: unknown): void
	snapshotEvents(from?: number): readonly unknown[]
}

/** The Team-domain event payloads appended to the Lead Session log. */
export type TeamEvent =
	| { readonly type: 'team/member'; readonly data: unknown }
	| { readonly type: 'team/task'; readonly data: unknown }
	| { readonly type: 'team/message/queued'; readonly data: unknown }
	| { readonly type: 'team/message/delivered'; readonly data: unknown }
