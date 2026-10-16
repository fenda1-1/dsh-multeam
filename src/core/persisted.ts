/** Short-lived read-handle access to persisted Team member Sessions. */

/** The slice of the DSH persistence service the roster needs. */
export interface TeamPersistence {
	open(id: string, mode: 'read', options: { signal: AbortSignal }): Promise<{
		read(from: number, to: number | undefined, options: { signal: AbortSignal }): Promise<{ events: readonly unknown[] }>
		readonly header: { readonly parentSession?: string }
		readonly inheritedEventCount: number
		close(): Promise<void>
	}>
}

/**
 * Read one stored session's header and complete event log through a
 * short-lived read handle, closing the handle before returning.
 * @param persistence - the durable session store.
 * @param id - the stored session to read.
 * @param signal - cancellation observed by open and read.
 * @returns the stored header and every committed event.
 */
export async function readPersistedSession(
	persistence: TeamPersistence,
	id: string,
	signal: AbortSignal,
): Promise<{ header: { parentSession?: string }; inheritedEventCount: number; events: readonly unknown[] }> {
	const handle = await persistence.open(id, 'read', { signal })
	try {
		const { events } = await handle.read(0, undefined, { signal })
		return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events }
	} finally {
		await handle.close()
	}
}
