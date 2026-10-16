/**
 * Stable public surface of the Agent Teams core.
 *
 * Kept in its own module so a bundler cannot tree-shake the re-exports away:
 * rolldown drops unused `export ... from` bindings even when the source module
 * itself is reachable, which silently removed `assertTaskTransition` /
 * `TASK_TRANSITIONS` from the built `dist/core/index.js`.
 */

export { assertTaskGraphCandidate, TeamTaskGraphError } from './task-graph.js'
export { compressReport, compressTaskBrief, estimateTokens } from './compress.js'
export { detectWriteScopeConflict, scopesOverlap, taskReady } from './task-view.js'
export { assertTaskTransition, TASK_TRANSITIONS, TeamTaskBoard } from './task-board.js'
export { TeamActivity } from './activity.js'
export { TeamJournal } from './journal.js'
export { TeamRuntimeLifecycle } from './lifecycle.js'
export { TeamMailbox } from './mailbox.js'
export { TeamRoster, availability, hasProductivePeer, resolveActiveMember } from './roster.js'
export { applyProjectionEvent, emptyTeamState, isTeamEvent, teamProjectionDefinition, teamProjectionView } from './projection.js'
export { messageAccepted, pendingInboxMessages } from './session-message.js'
export { readPersistedSession } from './persisted.js'
export { TeamError, errorMessage } from './error.js'
export { messageId, taskId, teamId } from './types.js'
export { requiredText, taskPriority, validateLesson, writeScope, PRIORITY_WEIGHT } from './validation.js'
export type { TaskPriority } from './validation.js'
export type {
	TeamAgent,
	TeamAvailability,
	TeamId,
	TeamMemberContext,
	TeamMemberPhase,
	TeamMemberSnapshot,
	TeamMemberView,
	TeamMembership,
	TeamMessageId,
	TeamMessageSnapshot,
	TeamSession,
	TeamState,
	TeamTaskHistoryEntry,
	TeamTaskId,
	TeamTaskSnapshot,
	TeamTaskStatus,
	TeamTaskView,
	TeamWriteScopeConflict,
} from './types.js'
export type { TeamChange, TeamTaskAction, TeamWaitFilter, TeamWaitResult, TeamMetrics } from './index.js'
export type { CompressResult } from './compress.js'
export type { WriteScopeHit } from './task-view.js'
export type { TeamChange, TeamMetrics, TeamTaskAction, TeamWaitFilter, TeamWaitResult } from './shapes.js'
export type { TeamPersistence } from './persisted.js'
export type { TeamJournalContext } from './journal.js'
export type { TeamMailboxContext, TeamMailboxMetrics, TeamSendRequest, TeamSendResult } from './mailbox.js'
export type { TeamRosterContext, TeamSpawnRequest, TeamSessionHandle, TeamSubagents } from './roster.js'
export type { TeamTaskCreateRequest, TeamTaskUpdateRequest } from './task-board.js'
