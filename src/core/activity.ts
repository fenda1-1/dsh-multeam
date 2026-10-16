/** One-shot Team change waiters independent of durable state projection. */

import { TeamError } from './error.js'
import { teamId } from './types.js'
import type { TeamId } from './types.js'

/** Authoritative `multeam_wait` timeout bounds. */
export const MIN_WAIT_TIMEOUT_MS = 10_000
export const MAX_WAIT_TIMEOUT_MS = 3_600_000

interface Waiter {
	readonly resolve: () => void
}

/** Counters for the teammate wait-spin cap, scoped to one Team id. */
interface WaitSpinLedger {
	readonly consecutiveTimeouts: Map<string, number>
}

/** Owns current Team change waiters and releases each at most once. */
export class TeamActivity {
	private readonly waiters = new Map<TeamId, Set<Waiter>>()
	/* Per-caller consecutive-timeout counts live here (not on TeamService) so
	 * the spin ledger dies with the activity registry on service reload. */
	private readonly spinLedgers = new Map<TeamId, WaitSpinLedger>()
	private closed = false

	/**
	 * Wait for one later Team-domain or member-status change.
	 * @param id - Team whose next edge wakes the caller.
	 * @param timeoutMs - bounded wait duration from ten seconds through one hour.
	 * @param signal - caller cancellation for this wait only.
	 * @returns whether the wait ended by timeout.
	 */
	async wait(id: TeamId, timeoutMs: number, signal: AbortSignal): Promise<{ timedOut: boolean }> {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_WAIT_TIMEOUT_MS || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
			throw new TeamError('timeoutMs must be an integer from 10000 through 3600000', 'TEAM_INVALID_TIMEOUT')
		}
		signal.throwIfAborted()
		if (this.closed) return { timedOut: false }
		return {
			timedOut: !(await new Promise<boolean>((resolve, reject) => {
				let waiters = this.waiters.get(id)
				if (waiters === undefined) {
					waiters = new Set()
					this.waiters.set(id, waiters)
				}
				let settled = false
				const finish = (settle: () => void): void => {
					if (settled) return
					settled = true
					clearTimeout(timer)
					signal.removeEventListener('abort', onAbort)
					waiters!.delete(waiter)
					if (waiters!.size === 0) this.waiters.delete(id)
					settle()
				}
				const onAbort = (): void => {
					finish(() => {
						const reason = signal.reason
						reject(reason instanceof Error ? reason : new TeamError(`multeam_wait aborted: ${String(reason)}`, 'TEAM_WAIT_ABORTED'))
					})
				}
				const waiter: Waiter = {
					resolve: () => {
						finish(() => {
							resolve(true)
						})
					},
				}
				waiters.add(waiter)
				const timer = setTimeout(() => {
					finish(() => {
						resolve(false)
					})
				}, timeoutMs)
				signal.addEventListener('abort', onAbort, { once: true })
				if (signal.aborted) onAbort()
			})),
		}
	}

	/** Wake and remove every current waiter for one Team. */
	notify(id: TeamId): void {
		const waiters = this.waiters.get(id)
		if (waiters === undefined) return
		this.waiters.delete(id)
		for (const waiter of waiters) waiter.resolve()
	}

	/**
	 * Record one teammate wait outcome for the consecutive-timeout spin cap.
	 *
	 * A teammate turn that loops `multeam_wait` inside one model turn never goes
	 * inactive, so each call blocks up to an hour while burning the context
	 * window on wake results — the ledger makes the *consecutive* timeout count
	 * observable so the service layer can hard-stop the spin instead of
	 * returning the 87th timeout. Any non-timeout outcome means the caller did
	 * observe progress and the streak resets.
	 * @param id - Team the wait ran against.
	 * @param memberId - caller's durable member id (lead id for the Lead).
	 * @param timedOut - whether that wait call ended on its own deadline.
	 * @returns the current consecutive-timeout streak after recording.
	 */
	recordWaitOutcome(id: TeamId, memberId: string, timedOut: boolean): number {
		let ledger = this.spinLedgers.get(id)
		if (ledger === undefined) {
			ledger = { consecutiveTimeouts: new Map() }
			this.spinLedgers.set(id, ledger)
		}
		if (!timedOut) {
			ledger.consecutiveTimeouts.delete(memberId)
			return 0
		}
		const streak = (ledger.consecutiveTimeouts.get(memberId) ?? 0) + 1
		ledger.consecutiveTimeouts.set(memberId, streak)
		return streak
	}

	/** Drop one member's spin streak — a member-scoped event reset (message received, task move). */
	resetWaitSpin(id: TeamId, memberId: string): void {
		this.spinLedgers.get(id)?.consecutiveTimeouts.delete(memberId)
	}

	/** Close admission and wake every current waiter during runtime disposal. */
	close(): void {
		this.closed = true
		for (const waiters of this.waiters.values()) for (const waiter of waiters) waiter.resolve()
		this.waiters.clear()
		this.spinLedgers.clear()
	}
}

/** Build a Team identity for activity keys without importing the brand helper everywhere. */
export function activityKey(id: string): TeamId {
	return teamId(id)
}
