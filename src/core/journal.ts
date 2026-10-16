/** Serialized Team transactions over the exact live Lead Session log. */

import type { TeamState } from './types.js'
import { teamId } from './types.js'
import { TeamError } from './error.js'
import { errorMessage } from './error.js'
import type { TeamAgent } from './types.js'

/** The slice of the DSH context the journal needs. */
export interface TeamJournalContext {
	sessionProjections: {
		stateOf(session: unknown, key: string): TeamState | undefined
		registrations?: {
			get(key: string): { cells: Map<unknown, { rebuildExhausted?: boolean }> } | undefined
		}
	}
	sessions: { flush(session: unknown): Promise<void> }
	logger?: { warn?(message: string): void; info?(message: string): void }
}

/** Owns per-Lead transaction order and committed Team event publication. */
export class TeamJournal {
	private readonly tails = new Map<string, Promise<void>>()
	/** Per-root count of operations waiting on or running inside the transaction tail. */
	private readonly queueDepths = new Map<string, number>()
	/** Roots already warned about backpressure — throttled to one warn per burst. */
	private readonly backpressureWarned = new Set<string>()
	private readonly backpressureWarnAt: number

	constructor(
		private readonly ctx: TeamJournalContext,
		private readonly onCommit: (root: TeamAgent) => void,
		backpressureWarnAt = 64,
	) {
		this.backpressureWarnAt = backpressureWarnAt
	}

	/** Current number of operations queued on one root's transaction tail. */
	queueDepth(rootId: string): number {
		return this.queueDepths.get(rootId) ?? 0
	}

	/**
	 * Read authoritative Team state for one exact live Lead.
	 * @param root - exact live Team Lead.
	 * @returns current projected state selected by the Lead Team id.
	 */
	state(root: TeamAgent): TeamState {
		let projection = this.ctx.sessionProjections.stateOf(root.session, 'agentTeam')
		if (projection === undefined) throw new Error('Agent Teams projection is not registered')
		/* A frozen projection is first repaired by rebuild-from-events (clear the
		 * cell → full replay); only a deterministic failure surfaces an error.
		 * The exhaustion mark rides on the cell (per session+key), so one
		 * session's deterministic failure cannot deny another session's rebuild. */
		if (projection.failure !== undefined) {
			const cell = this.ctx.sessionProjections.registrations?.get('agentTeam')?.cells.get(root.session)
			if (!cell?.rebuildExhausted) projection = this.tryRebuildProjection(root.session) ?? projection
		}
		if (projection.failure !== undefined) {
			throw new TeamError(`Agent Teams projection failed: ${projection.failure}`, 'TEAM_PROJECTION_FAILED')
		}
		return projection
	}

	/**
	 * Rebuild the agentTeam projection from the session event log by clearing
	 * the frozen cell and replaying all events through the registry.
	 * @param session - the Lead Session whose projection cell is rebuilt.
	 * @returns the rebuilt projection state, or undefined if rebuild fails.
	 */
	private tryRebuildProjection(session: unknown): TeamState | undefined {
		try {
			const registry = this.ctx.sessionProjections
			const registration = registry.registrations?.get('agentTeam')
			if (registration === undefined) return undefined
			/* Drop the frozen cell so cellFor replays from init over the full
			 * in-memory log. WeakMap.delete is the only public invalidation API. */
			registration.cells.delete(session)
			const rebuilt = registry.stateOf(session, 'agentTeam')
			if (rebuilt !== undefined && rebuilt.failure === undefined) {
				this.ctx.logger?.info?.('team projection rebuilt successfully from events')
				return rebuilt
			}
			/* A rebuilt cell that still carries failure means the offending event is
			 * durable — the same fold will always reproduce it, so mark the cell and
			 * serve the error without refolding on every read. */
			const cell = registration.cells.get(session)
			if (cell !== undefined) cell.rebuildExhausted = true
			return undefined
		} catch (error) {
			this.ctx.logger?.warn?.(`team projection rebuild failed: ${errorMessage(error)}`)
			return undefined
		}
	}

	/* New durable events may repair the stream (the append path itself is
	 * failure-agnostic), so a committed event re-arms the rebuild attempt on this
	 * session's own cell only. */
	private noteCommitted(session: unknown): void {
		const cell = this.ctx.sessionProjections.registrations?.get('agentTeam')?.cells.get(session)
		if (cell !== undefined) delete cell.rebuildExhausted
	}

	/**
	 * Serialize one Lead's asynchronous mutation operation.
	 * @param rootId - Lead Session identity selecting the transaction queue.
	 * @param operation - complete read-check-append operation.
	 * @returns the operation result.
	 */
	async transact<T>(rootId: string, operation: () => Promise<T>): Promise<T> {
		const depth = (this.queueDepths.get(rootId) ?? 0) + 1
		this.queueDepths.set(rootId, depth)
		if (this.backpressureWarnAt > 0 && depth > this.backpressureWarnAt && !this.backpressureWarned.has(rootId)) {
			this.backpressureWarned.add(rootId)
			this.ctx.logger?.warn?.(
				`team journal backpressure: ${depth} operations queued for ${rootId} (threshold ${this.backpressureWarnAt})`,
			)
		}
		const run = (this.tails.get(rootId) ?? Promise.resolve()).then(operation, operation)
		const tail = run.then(
			() => undefined,
			() => undefined,
		)
		this.tails.set(rootId, tail)
		try {
			return await run
		} finally {
			if (this.tails.get(rootId) === tail) this.tails.delete(rootId)
			const remaining = (this.queueDepths.get(rootId) ?? 1) - 1
			if (remaining <= 0) {
				this.queueDepths.delete(rootId)
				this.backpressureWarned.delete(rootId)
			} else {
				this.queueDepths.set(rootId, remaining)
			}
		}
	}

	/**
	 * Append and checkpoint one root-owned Team event before publication.
	 * @param root - exact live Lead whose Session owns the event.
	 * @param type - Team event discriminant.
	 * @param data - payload correlated with the event type.
	 */
	async appendAndFlush(root: TeamAgent, type: string, data: unknown): Promise<void> {
		root.session.append(type, data)
		await this.ctx.sessions.flush(root.session)
		this.noteCommitted(root.session)
		this.onCommit(root)
	}
}

/** Build the activity key for one root id. */
export function teamActivityKey(rootId: string): string {
	return teamId(rootId)
}
