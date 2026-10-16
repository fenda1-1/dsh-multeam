/** Typed Agent Teams failures. */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Stable failure raised by the Team domain. Carries the same `code`/`cause`
 * contract as `HarnessError` so DSH error mapping keeps working unchanged.
 */
export class TeamError extends HarnessError {
	constructor(message: string, code: string, options?: ErrorOptions) {
		super(message, code, options)
		this.name = 'TeamError'
	}
}

/**
 * Render an arbitrary thrown value without replacing the original rejection.
 * @param error - caught value used in a diagnostic or durable failure record.
 * @returns one bounded single-line description.
 */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	if (typeof error === 'string') return error
	return JSON.stringify(error)
}
