/**
 * Browser entry: registers the Agent Teams conversation-header action and the
 * sidebar team-board tab on the Client Context.
 */

import { registerAgentTeamUi } from './mount.js'
import type { TeamClientContext } from './mount.js'

export { inject } from './mount.js'
export { TEAM_BOARD_KIND, TEAM_BOARD_TAB_ID } from './mount.js'
export { installStyles } from './styles.js'
export { NS, en, zh } from './locales.js'
export type { TeamLocale } from './locales.js'

/** Module id the ModuleLoader banner registers under; mirrored by `mount.js`. */
export const name = 'dsh-multeam/client'

/**
 * Register the Team locale dictionaries, header action, and sidebar tab.
 * @param ctx - Client Context with the declared `inject` services available.
 */
export function apply(ctx: TeamClientContext): void {
	/* cordis logger only buffers on web (no console exporter), so an apply()
	 * crash surfaces as a bare "failed" with no cause anywhere. console.error
	 * IS captured into the crash report's renderer section. */
	try {
		registerAgentTeamUi(ctx)
	} catch (error) {
		console.error('dsh-multeam apply failed:', error)
		throw error
	}
}
