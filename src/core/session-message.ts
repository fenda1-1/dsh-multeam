/** Durable Session-message acceptance checks shared by provisioning and mailbox recovery. */

/** Fold the durable inbox suffix into the messages still awaiting a claim. */
export function pendingInboxMessages(events: readonly unknown[]): unknown[] {
	const inbox: Record<'next-turn' | 'next-step', unknown[]> = { 'next-turn': [], 'next-step': [] }
	for (const event of events) {
		const typed = event as { type?: string; data?: unknown }
		if (typed.type !== 'agent/inbox/spliced') continue
		const data = typed.data as { target?: string; start?: number; removedCount?: number; inserted?: unknown[] } | undefined
		/* Skip events whose target is not a known inbox queue — corrupt or
		 * forward-incompatible persisted events must not crash the projection. */
		const pending = inbox[data?.target as 'next-turn' | 'next-step' | undefined]
		if (pending === undefined) continue
		pending.splice(data?.start ?? 0, data?.removedCount ?? 0, ...(data?.inserted ?? []))
	}
	return [...inbox['next-turn'], ...inbox['next-step']]
}

/**
 * Test whether one message is model-visible or still durably pending.
 * @param events - one Session's non-inherited event suffix.
 * @param predicate - identity check for the accepted message.
 * @returns whether history or the current inbox contains a match.
 */
export function messageAccepted(events: readonly unknown[], predicate: (message: unknown) => boolean): boolean {
	return (
		events.some((event) => {
			const typed = event as { type?: string; data?: unknown }
			return typed.type === 'user/message' && predicate(typed.data)
		}) || pendingInboxMessages(events).some(predicate)
	)
}
