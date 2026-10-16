/** Durable Team mailbox admission, target-local dispatch, acknowledgement, and recovery. */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { steerHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import type { TeamAgent, TeamMembership, TeamMessageSnapshot, TeamState } from './types.js'
import { messageId, teamId } from './types.js'
import { TeamError, errorMessage } from './error.js'
import type { TeamJournal } from './journal.js'
import type { TeamRuntimeLifecycle } from './lifecycle.js'
import type { TeamRoster } from './roster.js'
import { readPersistedSession, type TeamPersistence } from './persisted.js'
import { messageAccepted } from './session-message.js'

/** Consecutive target-read failures after which a message is dead-lettered. */
const MAX_DELIVERY_READ_FAILURES = 5

/**
 * 60s delivery lease: a claimed-but-undelivered message past this age is
 * presumed abandoned and may be redelivered by another pass (crash-redelivery
 * semantics).
 */
const MAILBOX_DELIVERY_LEASE_MS = 60_000

/** Shared service counters incremented on the real mailbox paths. */
export interface TeamMailboxMetrics {
	messagesDelivered: number
	messagesDeadLettered: number
	dispatchFailures: number
}

/** The slice of the DSH context the mailbox needs. */
export interface TeamMailboxContext {
	agents: { get(id: string): TeamAgent | undefined }
	sessions: { flush(session: unknown): Promise<void> }
	sessionPersistence: TeamPersistence
	subagents: { deliverPrompt?: unknown }
	logger?: { warn?(message: string): void; info?(message: string): void }
}

/** One mailbox send request. */
export interface TeamSendRequest {
	readonly target: string
	readonly content: readonly unknown[]
	readonly signal: AbortSignal
}

/** One send result: durable regardless of whether immediate delivery succeeded. */
export interface TeamSendResult {
	readonly messageId: string
	readonly status: 'accepted' | 'queued'
}

/** Owns every process-local state transition for the durable Team mailbox. */
export class TeamMailbox {
	/** Per-target dispatch tails preserving durable queue order. */
	private readonly dispatchTails = new Map<string, Promise<void>>()
	private readonly inFlightMessages = new Set<string>()
	private readonly inFlightDispatches = new Set<Promise<unknown>>()
	/**
	 * Process-local delivery-lease registry for the pending→claimed→delivered
	 * lifecycle. In-memory on purpose: a crashed process forfeits every claim,
	 * so redelivery is never blocked past restart.
	 */
	private readonly deliveryClaims = new Map<string, number>()
	/** messageId → delivery attempt count; bounds retries on persistent failures. */
	private readonly deliveryAttempts = new Map<string, number>()
	/** messageId → true while `expireDeadLetters` is handling it (per-message dedupe). */
	private readonly deadLetterInFlight = new Set<string>()

	constructor(
		private readonly ctx: TeamMailboxContext,
		private readonly journal: TeamJournal,
		private readonly roster: TeamRoster,
		private readonly lifecycle: TeamRuntimeLifecycle,
		private readonly maxPendingMessagesPerMember: number,
		private readonly maxMessageBytes: number,
		private readonly deadLetterAfterMs = 0,
		private readonly metrics?: TeamMailboxMetrics,
	) {}

	/**
	 * Queue one durable peer message, then attempt immediate delivery.
	 * @param caller - exact live sending Team member.
	 * @param request - target name, content, and pre-queue cancellation.
	 * @returns durable message identity and immediate-delivery observation.
	 */
	async send(caller: TeamAgent, request: TeamSendRequest): Promise<TeamSendResult> {
		if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
		const membership = this.roster.membership(caller)
		const state = this.journal.state(membership.root)
		// Opportunistic dead-letter sweep — send is the hottest mailbox entry point.
		const leadAgent = this.ctx.agents.get(String(state.id))
		if (leadAgent !== undefined) {
			this.expireDeadLetters(membership.root, leadAgent, state).catch((error) => {
				this.ctx.logger?.warn?.(`team mailbox dead-letter sweep failed: ${errorMessage(error)}`)
			})
		}
		const operation = this.sendAdmitted(caller, {
			...request,
			signal: AbortSignal.any([request.signal, this.lifecycle.signal]),
		})
		return await this.trackDispatch(operation)
	}

	/**
	 * Observe target-side durable receipts and checkpoint their Lead-log acknowledgement.
	 * @param session - exact target Session receiving the event.
	 * @param event - newly appended Session event.
	 */
	observeSessionEvent(session: unknown, event: { readonly type: string; readonly data: unknown }): void {
		if (this.lifecycle.disposed || event.type !== 'user/message') return
		const source = (event.data as { source?: { kind?: string } }).source
		if (source?.kind !== 'team-message') return
		const typed = source as { teamId?: string; messageId?: string }
		const acknowledgement = Promise.resolve()
			.then(async () => {
				const root = this.ctx.agents.get(brandString(String(typed.teamId)))
				if (root !== undefined) {
					await this.checkpointDelivered(root, session, String(typed.messageId))
					const state = this.journal.state(root)
					await this.expireDeadLetters(root, root, state)
				}
			})
			.catch((error) => {
				this.ctx.logger?.warn?.(`Team message "${String(typed.messageId)}" acknowledgement failed: ${errorMessage(error)}`)
			})
		this.trackDispatch(acknowledgement)
	}

	/**
	 * Retry durable pending messages relevant to one started Team member.
	 * @param agent - newly started exact live Agent.
	 * @param signal - shared runtime cancellation.
	 */
	async recoverFor(agent: TeamAgent, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted()
		const membership = this.roster.tryMembership(agent)
		if (membership === undefined) return
		const state = this.journal.state(membership.root)
		// Sweep dead letters on recovery too — a long downtime may have expired many.
		const leadAgent = this.ctx.agents.get(String(state.id))
		if (leadAgent !== undefined) {
			this.expireDeadLetters(membership.root, leadAgent, state).catch((error) => {
				this.ctx.logger?.warn?.(`team mailbox dead-letter sweep on recovery failed: ${errorMessage(error)}`)
			})
		}
		if (membership.role === 'teammate') {
			/* A released member has been drained and must not receive redelivery, even while its Agent lingers live. */
			const member = state.members.find((candidate) => candidate.id === agent.id)
			if (member !== undefined && member.phase === 'released') return
		}
		const released = new Set(state.members.filter((member) => member.phase === 'released').map((member) => member.id))
		const messages = state.messages.filter(
			(message) =>
				!state.delivered.includes(message.id) &&
				!released.has(message.targetId) &&
				!this.deliveryLeaseActive(message.id) &&
				(membership.role === 'lead' || message.targetId === agent.id),
		)
		for (const message of messages) {
			signal.throwIfAborted()
			await this.tryDispatch(membership.root, message, signal)
		}
	}

	/** Return admitted dispatch and acknowledgement operations captured for disposal. */
	pendingDispatches(): Promise<unknown>[] {
		return [...this.inFlightDispatches]
	}

	/** Queue and dispatch one mailbox item admitted before the disposal cutoff. */
	private async sendAdmitted(caller: TeamAgent, request: TeamSendRequest): Promise<TeamSendResult> {
		const membership = this.roster.membership(caller)
		request.signal.throwIfAborted()
		const root = membership.root
		const content = structuredClone(request.content)
		const queued = await this.journal.transact(root.id, async () => {
			request.signal.throwIfAborted()
			const state = this.journal.state(root)
			const target = resolveActiveMemberForMailbox(root, state, request.target)
			if (target.id === caller.id) throw new TeamError('a Team member cannot message itself', 'TEAM_SELF_MESSAGE')
			const pendingForTarget = state.messages.filter((candidate) => candidate.targetId === target.id && !state.delivered.includes(candidate.id)).length
			if (pendingForTarget >= this.maxPendingMessagesPerMember) {
				throw new TeamError(`teammate "${target.name}" has ${pendingForTarget} pending messages`, 'TEAM_MAILBOX_FULL')
			}
			const queued: TeamMessageSnapshot = {
				id: messageId(`team-message-${crypto.randomUUID()}`),
				senderId: caller.id,
				senderName: membership.name,
				targetId: target.id,
				content,
				queuedAt: Date.now(),
			}
			if (Buffer.byteLength(JSON.stringify(this.deliveryContent(queued)), 'utf8') > this.maxMessageBytes) {
				throw new TeamError(`team message exceeds ${this.maxMessageBytes} bytes`, 'TEAM_MESSAGE_TOO_LARGE')
			}
			await this.journal.appendAndFlush(root, 'team/message/queued', { version: 2, teamId: teamId(root.id), message: queued })
			return { message: queued, dispatch: this.tryDispatch(root, queued, request.signal) }
		})
		const accepted = await queued.dispatch
		return { messageId: queued.message.id, status: accepted ? 'accepted' : 'queued' }
	}

	/** Attempt one queued message exactly once in this process at a time. */
	private tryDispatch(root: TeamAgent, message: TeamMessageSnapshot, signal: AbortSignal): Promise<boolean> {
		if (this.lifecycle.disposed) return Promise.resolve(false)
		if (this.inFlightMessages.has(message.id)) return Promise.resolve(false)
		this.inFlightMessages.add(message.id)
		const operation = this.trackDispatch(this.tryDispatchAdmitted(root, message, AbortSignal.any([signal, this.lifecycle.signal])))
		const forget = (): void => {
			this.inFlightMessages.delete(message.id)
		}
		operation.then(forget, forget)
		return operation
	}

	/** Track one dispatch transaction through delivery admission or contained failure. */
	private trackDispatch<T>(operation: Promise<T>): Promise<T> {
		this.inFlightDispatches.add(operation)
		operation.then(
			() => {
				this.inFlightDispatches.delete(operation)
			},
			() => {
				this.inFlightDispatches.delete(operation)
			},
		)
		return operation
	}

	/** Attempt one queued message admitted before the service lifecycle cutoff. */
	private async tryDispatchAdmitted(root: TeamAgent, message: TeamMessageSnapshot, signal: AbortSignal): Promise<boolean> {
		return await this.serializeDispatch(message, () => this.dispatchThrough(root, message, signal))
	}

	/** Serialize delivery admission for one durable target in queued order. */
	private async serializeDispatch(message: TeamMessageSnapshot, operation: () => Promise<boolean>): Promise<boolean> {
		const targetId = message.targetId
		const run = (this.dispatchTails.get(targetId) ?? Promise.resolve()).then(operation, operation)
		const tail = run.then(
			() => undefined,
			() => undefined,
		)
		this.dispatchTails.set(targetId, tail)
		try {
			return await run
		} finally {
			if (this.dispatchTails.get(targetId) === tail) this.dispatchTails.delete(targetId)
		}
	}

	/** Deliver every pending target message through `message` in durable queue order. */
	private async dispatchThrough(root: TeamAgent, message: TeamMessageSnapshot, signal: AbortSignal): Promise<boolean> {
		const state = this.journal.state(root)
		const pending = state.messages.filter(
			(candidate) => candidate.targetId === message.targetId && !state.delivered.includes(candidate.id) && !this.deliveryLeaseActive(candidate.id),
		)
		const requested = pending.findIndex((candidate) => candidate.id === message.id)
		if (requested < 0) return state.delivered.includes(message.id)
		for (const candidate of pending.slice(0, requested + 1)) {
			const ownsInFlight = !this.inFlightMessages.has(candidate.id)
			if (ownsInFlight) this.inFlightMessages.add(candidate.id)
			try {
				if (!(await this.dispatchOnce(root, candidate, signal))) return false
			} finally {
				if (ownsInFlight) this.inFlightMessages.delete(candidate.id)
			}
		}
		return true
	}

	/** Attempt one queued delivery after target-local ordering admits it. */
	private async dispatchOnce(root: TeamAgent, message: TeamMessageSnapshot, signal: AbortSignal): Promise<boolean> {
		this.claimDelivery(message.id)
		try {
			const target = message.targetId === root.id ? root : this.ctx.agents.get(message.targetId)
			if (target !== undefined && this.targetRecorded(target.session, message.id)) {
				return await this.checkpointDelivered(root, target.session, message.id)
			}
			const source = {
				kind: 'team-message',
				teamId: teamId(root.id),
				messageId: message.id,
				senderId: message.senderId,
				senderName: message.senderName,
			}
			const content = this.deliveryContent(message)
			if (message.targetId === root.id) {
				const input = createUserMessage({ content, source })
				root.steer(input)
				return await this.checkpointDelivered(root, root.session, message.id)
			}
			if (target === undefined) {
				const recorded = await this.persistedTargetRecorded(message.targetId, message.id, signal)
				if (recorded === undefined) {
					// Persistent read failure: retry within a bounded count, then
					// dead-letter rather than spin on the same message every pass.
					const attempts = (this.deliveryAttempts.get(message.id) ?? 0) + 1
					this.deliveryAttempts.set(message.id, attempts)
					if (attempts >= MAX_DELIVERY_READ_FAILURES) {
						this.deliveryAttempts.delete(message.id)
						this.ctx.logger?.warn?.(
							`team mailbox: target-read failed ${attempts}× for ${message.id}; dead-lettering to stop the retry loop`,
						)
						try {
							await this.markDelivered(root, message.id, message.targetId)
							root.steer(
								createUserMessage({
									content: [
										{
											type: 'text',
											text: `[mailbox] 投递失败告警：消息 ${message.id}（→ ${message.targetId}）目标持久化日志读取连续 ${attempts} 次失败，已按死信标记 delivered 终止重试。如需重投请用 multeam_send 重发。`,
										},
									],
									source: { kind: 'team-mailbox', alert: 'delivery-read-failed', messageId: message.id },
								}),
							)
						} catch (settleError) {
							this.ctx.logger?.warn?.(`team mailbox: dead-letter settle for ${message.id} failed: ${errorMessage(settleError)}`)
						}
					}
					return false
				}
				if (recorded) {
					this.deliveryAttempts.delete(message.id)
					await this.markDelivered(root, message.id, message.targetId)
					return true
				}
				this.deliveryAttempts.delete(message.id)
			}
			// A steer failure is bounded by the same counter (separate key) — otherwise
			// it would also retry forever.
			try {
				await steerHostSubagentPrompt(this.ctx.subagents as never, root, message.targetId, content, source, signal)
			} catch (steerError) {
				const key = `steer:${message.id}`
				const attempts = (this.deliveryAttempts.get(key) ?? 0) + 1
				this.deliveryAttempts.set(key, attempts)
				if (attempts >= MAX_DELIVERY_READ_FAILURES) {
					this.deliveryAttempts.delete(key)
					this.ctx.logger?.warn?.(`team mailbox: steer failed ${attempts}× for ${message.id}; dead-lettering to stop the retry loop`)
					try {
						await this.markDelivered(root, message.id, message.targetId)
						root.steer(
							createUserMessage({
								content: [
									{
										type: 'text',
										text: `[mailbox] 投递失败告警：消息 ${message.id}（→ ${message.targetId}）steer 连续 ${attempts} 次失败（${errorMessage(steerError)}），已按死信标记 delivered 终止重试。如需重投请用 multeam_send 重发。`,
									},
								],
								source: { kind: 'team-mailbox', alert: 'delivery-steer-failed', messageId: message.id },
							}),
						)
					} catch (settleError) {
						this.ctx.logger?.warn?.(`team mailbox: dead-letter settle for ${message.id} failed: ${errorMessage(settleError)}`)
					}
				}
				// Below the cap: rethrow so the outer catch logs it and the message stays queued.
				throw steerError
			}
			this.deliveryAttempts.delete(`steer:${message.id}`)
			if (target !== undefined && target.status === 'idle') {
				/* A resident SubagentInbox may accept the steer without kicking the
				 * driver's wakeDriver — nudge it so the parked FIFO is claimed instead
				 * of leaving the teammate permanently idle.
				 *
				 * The nudge MUST NOT reuse the delivery `source`: kind='team-message'
				 * plus the real messageId makes observeSessionEvent/targetRecorded
				 * count the nudge as the message itself, which acks the original
				 * twice and shows up as a duplicate delivery (same messageId, two
				 * user/message rows). A neutral 'team-mailbox' alert keeps it out of
				 * the recorded check while still waking the driver. */
				target.steer(
					createUserMessage({
						content: [
							{
								type: 'text',
								text: `Team message ${message.id} arrived while you were idle; check your pending inbox for the full delivery.`,
							},
						],
						source: { kind: 'team-mailbox', alert: 'idle-nudge' },
					}),
				)
			}
			return target === undefined ? true : await this.checkpointDelivered(root, target.session, message.id)
		} catch (error) {
			this.ctx.logger?.warn?.(`team message "${message.id}" remains queued: ${errorMessage(error)}`)
			if (this.metrics !== undefined) this.metrics.dispatchFailures++
			return false
		} finally {
			this.releaseDelivery(message.id)
		}
	}

	/** Flush one live target receipt before the Lead records its delivered edge. */
	private async checkpointDelivered(root: TeamAgent, target: unknown, messageId: string): Promise<boolean> {
		await this.ctx.sessions.flush(target)
		if (!this.targetRecorded(target as TeamSessionLike, messageId)) return false
		await this.markDelivered(root, messageId, (target as { id?: string }).id ?? '')
		return true
	}

	/** Record delivery unless the acknowledgement already exists. */
	private async markDelivered(root: TeamAgent, messageId: string, targetId: string): Promise<void> {
		await this.journal.transact(root.id, async () => {
			const state = this.journal.state(root)
			if (state.delivered.includes(messageIdOf(messageId))) return
			const queued = state.messages.find((message) => message.id === messageId)
			if (queued === undefined || queued.targetId !== targetId) return
			await this.journal.appendAndFlush(root, 'team/message/delivered', {
				version: 2,
				teamId: teamId(root.id),
				messageId,
				targetId,
			})
			this.deliveryClaims.delete(messageId)
			if (this.metrics !== undefined) this.metrics.messagesDelivered++
		})
	}

	/** Whether one message's delivery lease is still inside its claim window. */
	private deliveryLeaseActive(messageId: string, now = Date.now()): boolean {
		const claimedAt = this.deliveryClaims.get(messageId)
		return claimedAt !== undefined && now - claimedAt < MAILBOX_DELIVERY_LEASE_MS
	}

	/** Take or renew the delivery lease on one queued message. */
	private claimDelivery(messageId: string): void {
		this.deliveryClaims.set(messageId, Date.now())
	}

	/** Abandon one delivery lease so the next pass may redeliver immediately. */
	private releaseDelivery(messageId: string): void {
		this.deliveryClaims.delete(messageId)
	}

	/**
	 * Settle every undelivered message addressed to one released member.
	 * @param root - exact live Team Lead owning the mailbox log.
	 * @param memberId - released roster member whose pending messages must not linger.
	 */
	async releaseMemberMessages(root: TeamAgent, memberId: string): Promise<void> {
		const state = this.journal.state(root)
		const pending = state.messages.filter((message) => message.targetId === memberId && !state.delivered.includes(message.id))
		for (const message of pending) await this.markDelivered(root, message.id, memberId)
	}

	/**
	 * Mark every message undelivered past `deadLetterAfterMs` as delivered and
	 * steer the Lead one dead-letter notice. Reuses the dispatch path rather
	 * than opening a second timer.
	 */
	private async expireDeadLetters(root: TeamAgent, leadAgent: TeamAgent, state: TeamState): Promise<void> {
		if (this.deadLetterAfterMs <= 0) return
		const now = Date.now()
		const expired = state.messages.filter(
			(message) => !state.delivered.includes(message.id) && message.queuedAt !== undefined && now - message.queuedAt >= this.deadLetterAfterMs,
		)
		for (const message of expired) {
			// send/observeSessionEvent/recoverFor can all trigger this concurrently;
			// markDelivered is idempotent but the following steer is not, so claim
			// the message for the duration of this handling.
			if (this.deadLetterInFlight.has(message.id)) continue
			this.deadLetterInFlight.add(message.id)
			try {
				await this.markDelivered(root, message.id, message.targetId)
				if (this.metrics !== undefined) this.metrics.messagesDeadLettered++
				const senderName = message.senderName ?? 'unknown'
				const targetName = state.members.find((m) => m.id === message.targetId)?.name ?? message.targetId
				const ageMin = Math.round((now - (message.queuedAt ?? now)) / 60000)
				leadAgent.steer(
					createUserMessage({
						content: [
							{
								type: 'text',
								text:
									`[mailbox] 死信：消息 ${message.id}（${senderName} → ${targetName}）已入队 ${ageMin} 分钟仍未投递，标记为已死信。` +
									`如需重新投递请用 multeam_send 重发。`,
							},
						],
						source: { kind: 'team-mailbox', alert: 'dead-letter', messageId: message.id },
					}),
				)
				this.ctx.logger?.warn?.(`team mailbox: dead-lettered message ${message.id} (${senderName}→${targetName}, age=${ageMin}min)`)
			} catch (error) {
				this.ctx.logger?.warn?.(`team mailbox: dead-letter for ${message.id} failed: ${errorMessage(error)}`)
			} finally {
				this.deadLetterInFlight.delete(message.id)
			}
		}
	}

	/** Whether a target Session already contains the durable message identity. */
	private targetRecorded(session: TeamSessionLike, messageId: string): boolean {
		return messageAccepted(session.snapshotEvents(session.inheritedEventCount), (message) => {
			const source = (message as { source?: { kind?: string; messageId?: string } }).source
			return source?.kind === 'team-message' && source.messageId === messageId
		})
	}

	/** Frame peer content with stable sender and message identity for the receiving model. */
	private deliveryContent(message: TeamMessageSnapshot): unknown[] {
		return [{ type: 'text', text: `Team message ${message.id} from ${message.senderName}:` }, ...structuredClone(message.content as unknown[])]
	}

	/** Read an inactive target's durable log before cold resume; uncertainty keeps the mailbox queued. */
	private async persistedTargetRecorded(targetId: string, messageId: string, signal: AbortSignal): Promise<boolean | undefined> {
		try {
			const stored = await readPersistedSession(this.ctx.sessionPersistence, targetId, signal)
			return messageAccepted(stored.events.slice(stored.inheritedEventCount), (message) => {
				const source = (message as { source?: { kind?: string; messageId?: string } }).source
				return source?.kind === 'team-message' && source.messageId === messageId
			})
		} catch (error) {
			this.ctx.logger?.warn?.(`cannot read Team message target "${targetId}": ${errorMessage(error)}`)
			return undefined
		}
	}
}

/** The minimal Session surface the mailbox reads receipts from. */
interface TeamSessionLike {
	readonly id: string
	readonly inheritedEventCount: number
	snapshotEvents(from?: number): readonly unknown[]
}

function messageIdOf(id: string): string {
	return messageId(id)
}

/** Resolve one mailbox target by model-facing name, including the Lead. */
function resolveActiveMemberForMailbox(root: TeamAgent, state: TeamState, rawName: string): { id: string; name: string } {
	const name = rawName.trim()
	if (name === 'lead') return { id: root.id, name }
	const member = state.members.find((candidate) => candidate.name === name)
	if (member === undefined || member.phase !== 'active') throw new TeamError(`active teammate "${name}" not found`, 'TEAM_MEMBER_NOT_FOUND')
	return { id: member.id, name }
}
