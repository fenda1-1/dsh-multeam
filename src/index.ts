/**
 * Host plugin entry.
 *
 * One npm package carries every Agent Teams role — the roster/mailbox/task
 * service, the model-facing tool layer, the DAG scheduler, and the web client.
 * `cordis.patch.yml` mounts this same package several times with different
 * `id`s, and the cordis dedupe key is the `id`, so each mount is an independent
 * fiber. The export below dispatches on `config.role` so the right layer is
 * installed per mount without any cross-package imports.
 */

import { Service } from '@deepseek-ai/cordis'
import { TeamService, NO_ACTIVE_PEER_MESSAGE } from './core/index.js'
import { apply as applyTools, Config as ToolsConfig, name as toolsName, inject as toolsInject } from './tools/index.js'
import { TeamScheduler, Config as SchedulerConfig, name as schedulerName, inject as schedulerInject } from './scheduler/index.js'

/** Cordis plugin name shared by every role of this package. */
export const name = 'dsh-multeam'

/** Which layer one mount installs. */
export type TeamRole = 'core' | 'tools' | 'scheduler' | 'ui'

/** Per-role cordis injection lists, re-exported so the patch can read them. */
export const injectByRole = {
	core: TeamService.inject,
	tools: toolsInject,
	scheduler: schedulerInject,
	// The web half installs no host service, so it must not wait for any.
	ui: [],
} as const satisfies Record<TeamRole, readonly string[]>

/** Per-role loader schemas, re-exported for parity with the old split packages. */
export const ConfigByRole = {
	core: TeamService.Config,
	tools: ToolsConfig,
	scheduler: SchedulerConfig,
} as const

/** Per-role plugin names, re-exported for parity with the old split packages. */
export const nameByRole = {
	core: 'agent-team',
	tools: toolsName,
	scheduler: schedulerName,
} as const

type RoleApply = (ctx: never, config?: Record<string, unknown>) => void | Promise<void>

type RolePlugin = (new (ctx: never, config?: Record<string, unknown>) => unknown) | RoleApply

const ROLE_APPLY: Record<TeamRole, RolePlugin> = {
	core: TeamService,
	tools: applyTools,
	scheduler: TeamScheduler,
	// Browser-only mount: the web entry registers itself from `dsh.client`;
	// the host half installs nothing (parity with the official pure-web split).
	ui: () => {},
}

/** Default role for a mount that declares none — the core service. */
const DEFAULT_ROLE: TeamRole = 'core'

function resolveRole(config: Record<string, unknown> | undefined): TeamRole {
	const raw = config?.role
	return typeof raw === 'string' && raw in ROLE_APPLY ? (raw as TeamRole) : DEFAULT_ROLE
}

/**
 * Install the layer selected by `config.role`.
 *
 * Mounts that pass no role get the core service, so a minimal patch that only
 * needs the roster/mailbox/task engine still works. Class roles (core and the
 * scheduler Service) must be constructed with `new` — cordis class plugins
 * register their service in the constructor, so calling them bare throws
 * "Class constructor cannot be invoked without 'new'".
 *
 * DEPENDENCY GATE — this is the load-bearing part of the whole package.
 *
 * cordis resolves a service through the *mount fiber's* inject set: the proxy
 * trap in `ReflectService.handler.get` walks up the parent chain only while the
 * isolate key matches, and `_checkImpl`/`_refresh` keep the fiber INACTIVE until
 * every injected service is active. In a real profile the services this package
 * needs (`agents`, `sessions`, `sessionProjections`, `tools`, …) are provided by
 * *sibling* loader entries, not by an ancestor of our mount, so the ancestor
 * walk fails and any read throws `cannot get property "X" without inject`.
 *
 * The usual channel — a static `plugin.inject` on the exported plugin — is not
 * available to us: one module object carries all four roles, so a single static
 * list is either wrong for some role or self-deadlocking (the core role provides
 * `agentTeams` itself, so declaring it would make core wait for its own
 * service). The gate therefore lives in `cordis.patch.yml`, which declares the
 * per-role list as a loader *entry* option; `cordis-plugin-loader` folds it into
 * the fiber via `Inject.resolve(fiber.entry.options.inject, fiber.inject)`
 * before `_checkImpl`/`_refresh` run, so the fiber waits for its role's services
 * and every later read on the mount context resolves.
 *
 * Do NOT reintroduce a `ctx.inject(deps, () => run(ctx))` wrapper here. It gates
 * only the timing: the callback runs under a shadow that hides the missing
 * inject, and the plugin then stores the *unshadowed* mount context. Reads made
 * inside `apply` succeed and reads made later — the core service's dead-letter
 * sweep timer, the tools layer's `agent/created` handler — throw
 * `cannot get property "agents" without inject` as an uncaught exception, which
 * takes the whole host process down minutes after startup.
 */
export function apply(ctx: never, config: Record<string, unknown> = {}): void | Promise<void> {
	const plugin = ROLE_APPLY[resolveRole(config)]
	if (plugin.prototype instanceof Service) return new (plugin as new (ctx: never, config?: Record<string, unknown>) => unknown)(ctx, config) as never
	return (plugin as RoleApply)(ctx, config)
}

export { TeamService, NO_ACTIVE_PEER_MESSAGE }
export { applyTools, ToolsConfig, toolsInject }
export { TeamScheduler, SchedulerConfig, schedulerInject }
// The whole core surface is re-exported from the single host bundle so consumers
// (and the test suite) never need to reach into per-module files.
export {
	TeamActivity,
	TeamError,
	TeamJournal,
	TeamMailbox,
	TeamRoster,
	TeamRuntimeLifecycle,
	TeamTaskBoard,
	TeamTaskGraphError,
	availability,
	assertTaskGraphCandidate,
	assertTaskTransition,
	TASK_TRANSITIONS,
	compressReport,
	compressTaskBrief,
	detectWriteScopeConflict,
	emptyTeamState,
	errorMessage,
	estimateTokens,
	hasProductivePeer,
	isTeamEvent,
	messageAccepted,
	messageId,
	pendingInboxMessages,
	readPersistedSession,
	requiredText,
	resolveActiveMember,
	scopesOverlap,
	taskId,
	taskPriority,
	taskReady,
	teamId,
	teamProjectionDefinition,
	teamProjectionView,
	validateLesson,
	writeScope,
	PRIORITY_WEIGHT,
	applyProjectionEvent,
} from './core/public.js'
export type {
	CompressResult,
	TaskPriority,
	TeamAgent,
	TeamAvailability,
	TeamChange,
	TeamId,
	TeamMemberContext,
	TeamMemberPhase,
	TeamMemberSnapshot,
	TeamMemberView,
	TeamMembership,
	TeamMessageId,
	TeamMessageSnapshot,
	TeamMetrics,
	TeamSession,
	TeamState,
	TeamTaskAction,
	TeamTaskHistoryEntry,
	TeamTaskId,
	TeamTaskSnapshot,
	TeamTaskStatus,
	TeamTaskView,
	TeamWaitFilter,
	TeamWaitResult,
	TeamWriteScopeConflict,
	WriteScopeHit,
} from './core/public.js'
