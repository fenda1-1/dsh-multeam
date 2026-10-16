/** Value shapes shared by the Team service surface: changes, waits, and counters. */

/** One structured Team-state change entry returned by `waitForChange`. */
export interface TeamChange {
	readonly kind: 'member_phase' | 'member_status' | 'task_status' | 'task_revision' | 'task_owner' | 'mailbox' | 'failure'
	readonly summary: string
	readonly member?: string
	readonly taskId?: string
	readonly from?: string
	readonly to?: string
	/** Recipient name on mailbox entries — lets a wait filter express "addressed to me". */
	readonly mailbox_to?: string
}

/** One `waitForChange` matcher; an absent array means "any value matches". */
export interface TeamWaitFilter {
	readonly kinds?: readonly string[]
	readonly task_ids?: readonly string[]
	readonly members?: readonly string[]
	/** When true, mailbox diff entries only match deliveries addressed to the caller. */
	readonly mailbox_to_me?: boolean
}

/** One `waitForChange` result. */
export interface TeamWaitResult {
	readonly timedOut: boolean
	readonly changes?: readonly TeamChange[]
	readonly noProgress?: { readonly reason: string; readonly message: string }
}

/** In-memory service counters accumulated over the service lifetime. */
export interface TeamMetrics {
	messagesSent: number
	messagesDelivered: number
	messagesDeadLettered: number
	tasksCreated: number
	tasksCompleted: number
	tasksReopened: number
	dispatchFailures: number
	memberReleases: number
	waitCalls: number
	writeScopeConflicts: number
	writeScopeRuntimeDenials: number
}

/** One compare-and-set task action accepted by the task board. */
export type TeamTaskAction = 'claim' | 'release' | 'edit' | 'set_dependencies' | 'complete' | 'reopen' | 'reassign' | 'delete'
