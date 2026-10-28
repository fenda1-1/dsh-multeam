/** Scoped model-facing tools for the opt-in Agent Teams runtime. */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { compressReport, errorMessage, NO_ACTIVE_PEER_MESSAGE, scopesOverlap, taskId } from '../core/index.js'
import { activationLog } from '../index.js'
import type { TeamAgent, TeamMemberView, TeamTaskView } from '../core/types.js'

/** Cordis plugin name. */
export const name = 'tool-agent-team'

/** Services required by the Team tool plugin. */
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt'] as const

/** Loader schema for the opt-in Team tool plugin. */
export const Config = z.object({
	freshProvider: z.string().default('spawn'),
	forkProvider: z.string().default('fork'),
	enforceWriteScopes: z.boolean().default(true),
})

/** Model-facing collaboration guidance shared by Lead and teammates. */
const POLICY = `Agent Teams is available in this session; create teammates when the work decomposes into durable, separately-owned responsibilities, or when the user asks for Agent Teams.

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory by default; when the service runs with enforceWriteScopes enabled, a path-prefix overlap on claim or member-bound reassign is hard-rejected with TEAM_WRITE_SCOPE_CONFLICT. **The write-scope guard is active only while a member owns an in_progress task** — a member with no in_progress task has no scopes and is not restricted by the guard.
Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

**Code Quality Standards**: Write comments only for non-obvious decisions or complex logic—never restate code. Do NOT write test files in the source repository; tests are maintained in a separate test repository. Match the existing code style of the repository you are modifying (indentation, naming, import order). Stay strictly within your assigned write scope; ask the Lead before expanding. If expanding scope is genuinely required for correctness (e.g. a sibling runtime field that must change alongside, a call-site that breaks without the same change), make the change AND flag it explicitly in your report — mark it as beyond the literal scope, state the technical reason it could not be avoided, and offer to narrow it back if the Lead disagrees. Update documentation when your changes affect public APIs or behavior.

Lead review checklist before accepting completed work: comments explain decisions not code, no test files added to the source repository, style matches surrounding code, changes stayed inside the declared write scopes, and docs were updated when behavior changed. Reject or send back work that fails the checklist. Remind teammates to memory_save non-trivial insights (pitfalls, constraints, rationale) when accepting complex work.

Never encode a cross-member wait in prose: do not write messages that describe "waiting for someone to do something" (e.g. "waiting for bob to finish task-2"). The only valid waits are a blocked_by dependency on the task board or an explicit multeam_send to the member you need — the scheduler wakes them automatically. If a task must wait, create or update its blocked_by; if you need a person, message them. multeam_wait is only for observing changes you cannot predict — never for background jobs (use job_output for those). Never idle in a polling loop: multeam_wait with no active peer returns noProgress immediately, so re-list and multeam_send instead of waiting again.

Hard prohibitions every member must follow: claim-once — never hold more than one in_progress task, and never claim a second task while you still own unfinished work; never start, edit, complete, reopen, or delete a task owned by another member; never report another member's results as your own or send messages on its behalf; never end a turn silently while owning an in_progress task — either close it out (record the result in the task description, complete it, send one report) or report the blocker first; never privately tell the next-stage member to start — the scheduler dispatches unlocked work automatically; spawning/releasing members and reassigning tasks are Lead-only actions.

汇报格式（省 token 纪律）：结论先行——[改了什么][为什么][剩余风险/下一步]，一行一项；无寒暄、无「让我/我来/接下来」、不复述任务书原文；代码/路径/报错逐字保留原样；需要 Lead 决策的问题用完整句，其余从简。任务 description 与 multeam_send 正文同规约。

工具调用效率守则（少调用优于多调用）：①代码理解/符号定位/调用链/影响面优先用 codegraph_explore（projectPath 指目标仓库），一次返回源码+调用路径+blast-radius，替代「grep→read→grep」串行链；用不上 codegraph 的仓库才退回 grep/read。②multeam_status 一次拿全景（members+tasks+mailbox+failure），替代 multeam_task_list×N + multeam_list 多次轮询；只在需要单项细节时用 task_get。③shell/pwsh 用一条聚合命令批量处理（foreach 扫多目录、Select-Object 截断），替代多次 glob/list 往返。④大文件 read 必须带 offset/limit 分段，禁整段灌入原始日志或 binary 流；可用 grep 先定位再读命中行附近。⑤multeam_wait 只在有 running/provisioning 同伴且等不可预测事件时用，等不到就结束回合休眠——连续空转有 waitSpinLimit 硬拒，不要靠它轮询。
Use the target returned by multeam_spawn or multeam_list for multeam_send and multeam_interrupt, or as owner when assigning or filtering shared tasks. multeam_send steers a running target at its nearest step boundary and starts or resumes an inactive target. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. provisioning means member creation is in progress; failed means member creation failed. released means the Lead discharged that member; released members cannot receive messages or task assignments. A teammate about to be released should finish its in-flight work summary first; the Lead releases only after accepting results. A delivered peer item starts with its stable message id and sender name. A successful send is already durable even when its result says queued; do not resend it. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Completed work products go in files or the task description; large outputs belong in files with the path recorded on the task. Task readiness never starts an owner. Before multeam_wait, use multeam_list and make sure another required member is running or provisioning; use multeam_send first when the required member is inactive. multeam_wait observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member is running or provisioning. multeam_wait returns changes — a list of what changed since the wait started; re-list with multeam_list or multeam_task_list only when you need full current state. changes may include member phase transitions, task status/revision/owner changes, mailbox events, and projection failures. Re-list after wakeup or timeout. multeam_status reports the whole board at once — members, tasks, undelivered messages, and any projection failure. Use it when the board may be stale or after a wakeup. When the scheduler reports an orphaned task (owner no longer on the Team), the Lead should reassign or reopen it promptly. The Lead must wait for required teammates before giving the final answer. 'compress' on multeam_send applies the same report-compression rule server-side when a caller cannot trim the text itself.`

/** Statuses that count as "someone can still act" for the wait precheck. */
const ACTIVE_WAIT_STATUSES = new Set(['running', 'provisioning'])

/** Authoritative `multeam_wait` timeout bounds (mirrored by the core service). */
const MIN_WAIT_TIMEOUT_MS = 10_000
const MAX_WAIT_TIMEOUT_MS = 3_600_000
const DEFAULT_WAIT_TIMEOUT_MS = 30_000

/** Non-Lead callers get this hint when a wait times out. */
const WAIT_TIMEOUT_HINT =
	'No matching change before the deadline. If you are a teammate, end your turn now — going inactive is the correct wait; the scheduler wakes you when the awaited event arrives. Re-calling multeam_wait inside this same turn only burns tokens and keeps your status "running" forever.'

/**
 * Whether some member other than the caller still owns an unfinished task.
 *
 * Such a member is productive even while inactive — the scheduler can wake it
 * to make progress. Mirrors the service layer's `hasProductivePeer`.
 */
function hasPendingOwnedTask(ctx: TeamToolContext, caller: TeamAgent, callerName: string): boolean {
	try {
		const inactiveOwners = new Set(
			ctx.agentTeams
				.listMembers(caller)
				.filter((member) => member.status === 'released' || member.status === 'failed')
				.map((member) => member.name),
		)
		return ctx.agentTeams
			.listTasks(caller)
			.some(
				(task) =>
					task.ownerName !== undefined &&
					task.ownerName !== callerName &&
					!inactiveOwners.has(task.ownerName) &&
					(task.status === 'pending' || task.status === 'in_progress'),
			)
	} catch {
		// A board read failure (projection fault) must not block the wait — treat it
		// conservatively as "someone may act" and let the service layer decide.
		return true
	}
}

/** The service surface the tools consume. */
interface TeamToolContext {
	agentTeams: {
		membership(agent: TeamAgent): { role: 'lead' | 'teammate'; name: string }
		listMembers(agent: TeamAgent): TeamMemberView[]
		listTasks(agent: TeamAgent): TeamTaskView[]
		getTask(agent: TeamAgent, id: string): TeamTaskView
		spawnTeammate(agent: TeamAgent, request: unknown): Promise<{ member: TeamMemberView }>
		sendMessage(agent: TeamAgent, request: unknown): Promise<unknown>
		interrupt(agent: TeamAgent, target: string, reason?: string): unknown
		releaseMember(agent: TeamAgent, target: string): Promise<{ member: TeamMemberView }>
		createTask(agent: TeamAgent, request: unknown): Promise<TeamTaskView>
		updateTask(agent: TeamAgent, request: unknown): Promise<TeamTaskView>
		waitForChange(agent: TeamAgent, timeoutMs: number, signal: AbortSignal, filter?: unknown): Promise<unknown>
		teamStatus(agent: TeamAgent): Record<string, unknown>
		schedulerSnapshot(agent: TeamAgent, limit: number): unknown
		writeScopesForAgent(agent: TeamAgent): string[] | undefined
		tryMembership(agent: TeamAgent): unknown
		/** Optional service-side sink for per-member install diagnostics (older cores lack it). */
		recordInstallDiagnostic?(agent: TeamAgent, note: string): void
		metrics: { writeScopeRuntimeDenials: number }
	}
	agents: { list(): readonly TeamAgent[] }
	on(event: 'agent/created' | 'agent/disposed', listener: (payload: { agent: TeamAgent }) => void): () => void
	effect(callback: () => (() => void) | void, name?: string): void
	logger?: { warn?(message: string): void }
}

/** One model-facing roster row; the Lead pseudo-row omits teammate-only fields. */
const MEMBER_VIEW_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		target: { type: 'string', required: true },
		role: { type: 'string', required: true, enum: ['lead', 'teammate'] },
		status: {
			type: 'string',
			required: true,
			enum: ['running', 'idle', 'unloaded', 'inactive', 'provisioning', 'failed', 'released'],
		},
		description: { type: 'string' },
		provider: { type: 'string' },
		context: { type: 'string', enum: ['fresh', 'fork'] },
		model: { type: 'string' },
		diagnostics: { type: 'array', required: true, items: { type: 'string' } },
	},
} as const

/** One shared task, matching the public `TeamTaskView`. */
const TASK_VIEW_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		id: { type: 'string', required: true },
		revision: { type: 'integer', required: true },
		subject: { type: 'string', required: true },
		description: { type: 'string', required: true },
		status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'deleted'] },
		ownerName: { type: 'string' },
		blockedBy: { type: 'array', required: true, items: { type: 'string' } },
		writeScopes: { type: 'array', required: true, items: { type: 'string' } },
		ready: { type: 'boolean', required: true },
		writeScopeWarnings: { type: 'array', required: true, items: { type: 'string' } },
		acceptance: { type: 'array', items: { type: 'string' } },
		priority: { type: 'string', enum: ['high', 'medium', 'low'] },
		lesson: {
			type: 'string',
			description: 'Optional one-line lesson learned on completion; persisted on the task and replayed to future teammates working on same-capability tasks.',
		},
		attemptId: { type: 'string', description: 'Owner capability token, exposed only on views returned to the task owner.' },
		createdAt: { type: 'integer' },
		updatedAt: { type: 'integer' },
		history: { type: 'array', items: { type: 'json' } },
		conflicts: { type: 'array', items: { type: 'json' } },
		/* 完工任务 description 被压缩为骨架时投影补 true；未声明会导致
		 * additionalProperties:false 校验拒绝整个任务视图。 */
		descriptionTruncated: { type: 'boolean' },
		// Returned only by multeam_task_update after a blind-retry succeeded.
		retried: {
			type: 'boolean',
			description: 'Present only on multeam_task_update: true when the action initially hit a stale revision and was retried against the current one. Paired with baseRevision and retriedFromConflict.',
		},
		baseRevision: {
			type: 'integer',
			description: 'Present only on multeam_task_update after a conflict retry: the stale expected_revision the caller supplied.',
		},
		retriedFromConflict: {
			type: 'boolean',
			description: 'Present only on multeam_task_update: true when the action initially hit a stale revision and was retried against the current one. See baseRevision for the superseded precondition.',
		},
		previousOwnerName: {
			type: 'string',
			description: 'Present only on multeam_task_update when the action cleared the owner (reopen/release/unclaim/reassign-to-none): the member name that owned the task before this call.',
		},
	},
} as const

const SPAWN_VALUE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: { member: { ...MEMBER_VIEW_SCHEMA, required: true } },
} as const

const RELEASE_VALUE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: { member: { ...MEMBER_VIEW_SCHEMA, required: true } },
} as const

// members/tasks/pendingMessages are optional: the `sections` param lets a call
// return only a subset, so none of them may be `required` here.
const STATUS_VALUE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		members: { type: 'array', items: MEMBER_VIEW_SCHEMA },
		tasks: { type: 'array', items: TASK_VIEW_SCHEMA },
		/* DSL 不认 `nullable`：可空字段用 exact-one oneOf 表达（string | null）。 */
		failure: { oneOf: [{ type: 'string' }, { type: 'null' }] },
		pendingMessages: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					id: { type: 'string', required: true },
					targetName: { type: 'string', required: true },
					senderName: { type: 'string', required: true },
				},
			},
		},
		journalQueueDepth: { type: 'number' },
		metrics: {
			type: 'object',
			additionalProperties: false,
			properties: {
				teamId: { type: 'string' },
				sessionStartedAt: { type: 'number' },
				/* counters 跨全 session 累计，gauges 是本 Team 实时值——scope 标注口径。 */
				scope: {
					type: 'object',
					additionalProperties: false,
					properties: {
						counters: { type: 'string', required: true },
						gauges: { type: 'string', required: true },
					},
				},
				counters: {
					type: 'object',
					additionalProperties: false,
					properties: {
						messagesSent: { type: 'number' },
						messagesDelivered: { type: 'number' },
						messagesDeadLettered: { type: 'number' },
						tasksCreated: { type: 'number' },
						tasksCompleted: { type: 'number' },
						tasksReopened: { type: 'number' },
						dispatchFailures: { type: 'number' },
						memberReleases: { type: 'number' },
						waitCalls: { type: 'number' },
						writeScopeConflicts: { type: 'number' },
						writeScopeRuntimeDenials: { type: 'number' },
					},
				},
				gauges: {
					type: 'object',
					additionalProperties: false,
					properties: {
						journalQueueDepth: { type: 'number' },
						pendingMessages: { type: 'number' },
						activeTasks: { type: 'number' },
					},
				},
			},
		},
		/* team-scheduler is an optional sibling service; `{available:false}` is a
		 * distinct shape, so the union is expressed rather than made optional. */
		scheduler: {
			oneOf: [
				{
					type: 'object',
					additionalProperties: false,
					properties: { available: { type: 'boolean', required: true, const: false } },
				},
				{
					type: 'object',
					additionalProperties: false,
					properties: {
						available: { type: 'boolean', required: true, const: true },
						health: {
							type: 'object',
							additionalProperties: false,
							properties: {
								lastPassAt: { type: 'number' },
								passCount: { type: 'number' },
								activeSessions: { type: 'number' },
								pendingRetries: { type: 'number' },
								recentAlerts: { type: 'array', items: { type: 'json' } },
								compressSaved: { type: 'number' },
								compressSamples: { type: 'number' },
							},
						},
						stats: {
							type: 'object',
							additionalProperties: false,
							properties: {
								dispatched: { type: 'number' },
								skipped: { type: 'number' },
								orphan: { type: 'number' },
								timeoutAlerts: { type: 'number' },
								retryExhausted: { type: 'number' },
								passes: { type: 'number' },
								/* decisionSnapshot 注入 per-session 口径标注。 */
								scope: { type: 'string' },
							},
						},
						decisions: { type: 'array', items: { type: 'json' } },
					},
				},
			],
		},
	},
} as const

const MEMBER_LIST_VALUE_SCHEMA = { type: 'array', items: MEMBER_VIEW_SCHEMA } as const

const SEND_VALUE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		messageId: { type: 'string', required: true },
		status: { type: 'string', required: true, enum: ['accepted', 'queued'] },
		compressed: {
			type: 'object',
			additionalProperties: false,
			properties: { before: { type: 'string' }, after: { type: 'string' } },
			description: 'Present only when the caller set compress=true — carries the pre/post compressed text for audit.',
		},
	},
} as const

/** `noProgress` is present only on the model-only shortcut that skips the wait. */
const WAIT_VALUE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		timedOut: { type: 'boolean', required: true },
		changes: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					kind: {
						type: 'string',
						required: true,
						enum: ['task_status', 'task_revision', 'task_owner', 'member_phase', 'member_status', 'mailbox', 'failure'],
					},
					summary: { type: 'string', required: true },
					taskId: { type: 'string' },
					member: { type: 'string' },
					/* mailbox change rows carry the recipient so mailbox_to_me can filter;
					 * without declaring it here the strict schema rejects the output. */
					mailbox_to: { type: 'string' },
					from: { type: 'string' },
					to: { type: 'string' },
				},
			},
		},
		hint: { type: 'string' },
		noProgress: {
			type: 'object',
			additionalProperties: false,
			properties: { reason: { type: 'string', required: true, const: 'no-active-peer' }, message: { type: 'string', required: true } },
		},
	},
} as const

const INTERRUPT_VALUE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: { previousStatus: { type: 'string', required: true, enum: ['running', 'idle', 'unloaded', 'inactive'] } },
} as const

const TASK_LIST_VALUE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		tasks: { type: 'array', required: true, items: TASK_VIEW_SCHEMA },
		nextCursor: { type: 'integer' },
	},
} as const

/** Runtime write_scopes enforcement target tools — structured file-write tools. */
const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'notebook_edit', 'apply_patch', 'batch_edit', 'str_replace_editor'])

/** Path argument names across DSH built-ins and third-party file-write plugins. */
const FILE_PATH_ARGS = ['file_path', 'filePath', 'file', 'path', 'notebook_path', 'target_file']

/**
 * Normalize one candidate write path for the scope prefix test.
 *
 * Resolves `.`/`..` lexically: without it `multeam/docs/../../other/x.ts` still
 * starts with the scope `multeam/docs/` and walks straight past the guard.
 * Case is folded because the guard runs on Windows, where the filesystem is
 * case-insensitive but a literal prefix compare is not.
 * @param value - raw path from a tool argument or a task write scope.
 * @returns lowercased slash-separated path with no drive or root prefix.
 */
function normalizeGuardPath(value: string): string {
	const resolved: string[] = []
	for (const segment of value.replaceAll('\\', '/').replace(/^[a-z]:/iu, '').split('/')) {
		if (segment.length === 0 || segment === '.') continue
		if (segment === '..') {
			// An escape above the root stays a literal `..`, which no scope can
			// prefix-match — the call is denied rather than silently allowed.
			if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') resolved.pop()
			else resolved.push('..')
			continue
		}
		resolved.push(segment)
	}
	return resolved.join('/').toLowerCase()
}

/**
 * Every path one write-tool call may touch.
 *
 * `batch_edit` carries its targets in `edits[].path` rather than a top-level
 * argument, so a flat argument scan sees no path and lets the whole batch
 * through. `apply_patch` embeds its targets in the patch text and stays outside
 * this net — the same honest boundary as `pwsh`/`bash`.
 * @param toolName - resolved tool name.
 * @param args - raw tool arguments.
 * @returns raw path strings to test, in argument order.
 */
function writePathArguments(toolName: string, args: Record<string, unknown> | undefined): string[] {
	if (toolName === 'batch_edit') {
		const edits = args?.edits
		if (!Array.isArray(edits)) return []
		return edits.flatMap((edit) => {
			const path = (edit as { path?: unknown } | null)?.path
			return typeof path === 'string' && path.trim().length > 0 ? [path] : []
		})
	}
	for (const key of FILE_PATH_ARGS) {
		const candidate = args?.[key]
		if (typeof candidate === 'string' && candidate.trim().length > 0) return [candidate]
	}
	return []
}

/**
 * Declare one canonical output schema with compact model-facing JSON.
 *
 * Every Team result is a fixed record, so the declared schema is what makes the
 * compiler check `execute` against the value the model is promised.
 */
function jsonOutput(schema: unknown): unknown {
	return {
		schema,
		render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
	}
}

/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent: TeamAgent | undefined, toolName: string): TeamAgent {
	if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
	return agent
}

/** Expose the member name as its model-facing target. */
function modelMember(member: TeamMemberView): Record<string, unknown> {
	const { id: _id, name, ...details } = member
	return { target: name, ...details }
}

/**
 * The self-contained briefing prepended to every spawned teammate's initial
 * prompt. The teammate sees no Lead history, so everything it must know about
 * addressing, task-board protocol, and the passive-work discipline lives here.
 * @param teammateName - the freshly registered model-facing teammate name.
 * @returns the `<system-reminder>` block text.
 */
function SPAWN_REMINDER(teammateName: string): string {
	return `<system-reminder>
You are teammate "${teammateName}".
Your Team Lead is named "lead".
Use multeam_list({}) to find your teammates and their names.
To message your Team Lead, use multeam_send({ target: "lead", message: "..." }).
To message another teammate, use multeam_send({ target: "<teammate name>", message: "..." }).
The shared task board is yours too: multeam_task_list to see assignments, multeam_task_update to claim and complete them.
If your task book says it is already assigned to you (in_progress / "assigned" wording), execute it directly — do NOT call claim again on a task you already own; claiming it fails and only wastes a turn.
Claim-once: never hold more than one in_progress task, and never claim a second task while you still own unfinished work.
When your assignment is finished, do three things in order: (1) multeam_task_update action "edit" to write the outcome — what changed, which files, verification results — into the task description; (2) multeam_task_update action "complete" to close the task; (3) multeam_send one report to "lead" summarizing the same result. Then go quiet.
When completing, you may attach the optional 'lesson' parameter on the multeam_task_update complete action (one-line reusable lesson) — future teammates on same-capability tasks will see it.
Work passively: when your turn ends you go inactive; the scheduler or the Lead will wake you when more work is ready — never poll with multeam_wait just to kill time, and never loop it hoping to observe someone else's progress.
You may multeam_wait while you genuinely need a teammate's or the Lead's next change to proceed.
When multeam_wait returns timedOut true, END YOUR TURN — reply with a short status line and call no more tools. The scheduler wakes you when the awaited event arrives; re-waiting inside the same turn burns tokens and keeps you 'running' forever. Continuous re-waiting is a Lead-only observer pattern.
On wake, multeam_wait returns a changes list; call multeam_status if you need the full board.
Tool-efficiency: prefer ONE codegraph_explore (projectPath = the target repo) for symbol/call-graph lookups over a grep→read→grep chain — it returns source + call paths + blast-radius in one shot; fall back to grep/read only when that repo has no codegraph index. Prefer one multeam_status over repeated task_list polling. Batch shell/pwsh work into a single aggregated command, and always pass read offset/limit instead of dumping whole large files or logs.
Report blockers or completion to "lead" with multeam_send; do not message teammates unless your task requires coordination.
Never do another member's work: do not start, edit, complete, reopen, or delete a task owned by another member, and never report another member's results or send messages on its behalf.
Never end a turn silently while owning an in_progress task — either close it out with the three-step finish above or report the blocker first.
When everything assigned to you is complete and reported, go quiet — the Lead will release you when done.

**Code Quality Standards**: Write comments only for non-obvious decisions or complex logic—never restate code. Do NOT write test files in the source repository; tests are maintained in a separate test repository. Match the existing code style of the repository you are modifying (indentation, naming, import order). Stay strictly within your assigned write scope; ask the Lead before expanding. If expanding scope is genuinely required for correctness (e.g. a sibling runtime field that must change alongside, a call-site that breaks without the same change), make the change AND flag it explicitly in your report — mark it as beyond the literal scope, state the technical reason it could not be avoided, and offer to narrow it back if the Lead disagrees. Update documentation when your changes affect public APIs or behavior.

**Experience Logging**: After completing a task, use memory_save to record durable insights — a pitfall with root cause, a decision with rationale, or a domain constraint discovered during work. Tag with the project name and your teammate name. This builds the team's collective memory across sessions; skip trivial one-line fixes.
</system-reminder>
`
}

/** Register the complete Team tool set in one exact Agent scope. */
function install(agent: TeamAgent, ctx: TeamToolContext, config: { freshProvider: string; forkProvider: string; enforceWriteScopes: boolean }): () => void {
	const scoped = agent.ctx as unknown as {
		systemPrompt: { section(section: { name: string; order: number; text: string }): () => void }
		tools: { register(definition: unknown): () => void; guard(guard: (exec: unknown) => string | undefined): () => void }
	}
	const disposers: (() => void)[] = []
	const register = (disposer: () => void): void => {
		disposers.push(disposer)
	}
	/* LIFO, and idempotent: the same teardown runs from `agent/disposed` and from
	 * the mount's effect cleanup, and a later registration may depend on an
	 * earlier one. */
	const disposeAll = (): void => {
		for (const dispose of disposers.splice(0).reverse()) dispose()
	}
	try {
		register(
			scoped.systemPrompt.section({
				name: 'team:policy',
				/* SECTION_ORDERS.TEAM_POLICY = 600（dsh-system-prompt 内部常量，不导出，
				 * agent 作用域也没有 getSectionOrder——只能硬编码这个仓库级稳定值）。 */
				order: 600,
				text: POLICY,
			}),
		)
		/* Runtime write_scopes enforcement: a monotonic tools.guard on this member's
		 * agent-scoped ctx. It runs after the pre-execute waterfall and denies the
		 * call before execution when the resolved path is outside the union of the
		 * member's in_progress task scopes.
		 *
		 * Shell commands (pwsh/bash/run_code) embed their write path in the command
		 * string which pre-execute never sees as a path argument. The guard does a
		 * best-effort extraction of absolute paths from the command text — quoted
		 * or unquoted — and denies when any extracted path is provably outside
		 * every scope. Paths that cannot be resolved are ignored (not denied) to
		 * avoid false positives on relative paths and shell metacharacters. */
		register(
			scoped.tools.guard((exec) => {
				if (config.enforceWriteScopes !== true) return
				const call = exec as { name?: unknown; arguments?: Record<string, unknown>; agent?: TeamAgent }
				if (typeof call?.name !== 'string') return
				/* Shell commands embed paths in the command string — extract absolute
				 * paths for the scope check. Only matches drive-letter paths and
				 * UNC-ish /absolute/paths, never relative ones. */
				if (call.name === 'pwsh' || call.name === 'bash' || call.name === 'run_code') {
					const command = typeof call.arguments?.command === 'string' ? call.arguments.command : typeof call.arguments?.code === 'string' ? call.arguments.code : ''
					if (command.length === 0) return
					const shellPaths = command.match(/(?:[a-zA-Z]:[/\\]|\/)[a-zA-Z0-9_\-./\\]+/g) ?? []
					if (shellPaths.length === 0) return
					const scopes = ctx.agentTeams.writeScopesForAgent(call.agent as TeamAgent)
					if (scopes === undefined || scopes.length === 0) return
					const normalizedScopes = scopes.map(normalizeGuardPath)
					const outside = shellPaths.filter(
						(filePath) => !normalizedScopes.some((scope) => scopesOverlap(normalizeGuardPath(filePath), scope)),
					)
					/* 只读命令不该被拒：node --check / Get-ChildItem 这类纯读或语法检查
					 * 即使命中 scope 外路径也不该拦——否则 teammate 连验证自己做对没有
					 * 都跑不了。仅当命令里含真实写入谓词时才按路径拦。 */
					const SHELL_WRITE_PATTERN = /\b(?:Set-Content|Out-File|Add-Content|Set-ItemProperty|New-Item|Remove-Item|Copy-Item|Move-Item|Rename-Item|mkdir|New-Item\s+-ItemType\s+(?:Directory|File)|>>|>|tee\b|npm\s+install|pnpm\s+(?:add|install|remove)|git\s+(?:commit|checkout|merge|rebase|apply|rm|mv)|node\s+--(?:eval|print)\b.*\bwriteFileSync\b|fs\.writeFileSync|fs\.appendFileSync|fs\.rmSync|fs\.mkdirSync)\b/i
					if (outside.length === 0 || !SHELL_WRITE_PATTERN.test(command)) return
					ctx.agentTeams.metrics.writeScopeRuntimeDenials++
					return `write outside assigned write_scopes (shell command): ${outside.map((p) => `"${p}"`).join(', ')} is not under any scope of your in-progress task (${scopes.map((s) => `"${s}"`).join(', ')})`
				}
				if (!FILE_WRITE_TOOLS.has(call.name)) return
				const paths = writePathArguments(call.name, call.arguments)
				if (paths.length === 0) return
				const scopes = ctx.agentTeams.writeScopesForAgent(call.agent as TeamAgent)
				if (scopes === undefined || scopes.length === 0) return
				const normalizedScopes = scopes.map(normalizeGuardPath)
				// Every target of a multi-file call must be in scope, not just the first.
				const outside = paths.filter(
					(filePath) => !normalizedScopes.some((scope) => scopesOverlap(normalizeGuardPath(filePath), scope)),
				)
				if (outside.length === 0) return
				// Denial counter — the audit anchor for an otherwise silent deny.
				ctx.agentTeams.metrics.writeScopeRuntimeDenials++
				return `write outside assigned write_scopes: ${outside.map((path) => `"${path}"`).join(', ')} is not under any scope of your in-progress task (${scopes.map((scope) => `"${scope}"`).join(', ')})`
			}),
		)
		register(
			scoped.tools.register(
				defineTool({
					name: 'multeam_spawn',
					description: 'Create one named, durable teammate. Only the Team Lead may call this tool.',
					parameters: {
						name: {
							type: 'string',
							required: true,
							description:
								'Unique teammate name — ASCII lower-kebab-case only (e.g. "tool-auditor", "data-collector"); 1-64 chars, no spaces, no Chinese, no uppercase. Never pass a Chinese name like "测试成员": this string is an addressing key reused verbatim by multeam_send targets, task owner filters and scheduler dispatch, and non-ASCII names break those plain-text hops. Chinese belongs in description/prompt, not here.',
						},
						description: { type: 'string', required: true, description: 'Short description of the delegated responsibility. May be written in any language (Chinese is fine here).' },
						prompt: {
							type: 'string',
							required: true,
							description:
								'Complete self-contained initial task book for the teammate: goal, boundaries, acceptance criteria, output format, and explicit write scope. The teammate does not see Lead conversation history, so the prompt must carry everything it needs.',
						},
						context: {
							type: 'string',
							enum: ['fresh', 'fork'],
							description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
						},
					},
					output: jsonOutput(SPAWN_VALUE_SCHEMA),
					async execute(args, exec) {
						const caller = callingAgent(exec.agent, 'multeam_spawn')
						const context = args.context ?? 'fresh'
						const spawned = await ctx.agentTeams.spawnTeammate(caller, {
							name: args.name,
							description: args.description,
							prompt: [
								{ type: 'text', text: SPAWN_REMINDER(args.name.trim()) },
								{ type: 'text', text: args.prompt },
							],
							context,
							provider: context === 'fork' ? config.forkProvider : config.freshProvider,
							signal: exec.signal,
						})
						return { member: modelMember(spawned.member) }
					},
				} as never),
			),
		)
		register(
			scoped.tools.register(
				defineTool({
					name: 'multeam_send',
					description:
						'Send one durable message to another Team member. A running target receives it at the nearest step boundary; an inactive target starts or resumes a turn. A released member cannot receive messages.',
					parameters: {
						target: {
							type: 'string',
							required: true,
							description:
								'Member target as returned by multeam_spawn or multeam_list (including lead for a teammate messaging the Lead). Must be an exact target value — not a description, name guess, or message id.',
						},
						message: { type: 'string', required: true, description: 'Self-contained message for the target.' },
						compress: {
							type: 'boolean',
							description: "Apply the report-compression rule to 'message' server-side before delivery. Use when the caller cannot trim the text itself.",
						},
					},
					output: jsonOutput(SEND_VALUE_SCHEMA),
					async execute(args, exec) {
						const content = args.compress === true ? compressReport(args.message).text : args.message
						/* Must be awaited: spreading a pending `Promise<TeamSendResult>`
						 * yields `{}`, which fails `SEND_VALUE_SCHEMA` with a bare
						 * "missing required property value.messageId" while the message
						 * has in fact already been delivered. */
						const result = await ctx.agentTeams.sendMessage(callingAgent(exec.agent, 'multeam_send'), {
							target: args.target,
							content: [{ type: 'text', text: content }],
							signal: exec.signal,
						})
						return args.compress === true ? { ...(result as Record<string, unknown>), compressed: { before: args.message, after: content } } : result
					},
				} as never),
			),
		)
		register(
			scoped.tools.register(
				defineTool({
					name: 'multeam_list',
					description:
						'List the Lead and every durable teammate with an addressable target and current availability. inactive means no turn is executing, not a task result. provisioning and failed describe member creation.',
					parameters: {},
					output: jsonOutput(MEMBER_LIST_VALUE_SCHEMA),
					execute(_args, exec) {
						return Promise.resolve(ctx.agentTeams.listMembers(callingAgent(exec.agent, 'multeam_list')).map(modelMember))
					},
				} as never),
			),
		)
		register(
			scoped.tools.register(
				defineTool({
					name: 'multeam_wait',
					description:
						'Wait for the next teammate status, mailbox, or shared-task change after this call starts. This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Re-list after wakeup or timeout instead of polling. The result includes a changes list of structured diff entries {kind, summary, taskId?, member?, from?, to?} describing member phases, task status/revision/owner moves, mailbox events, and projection failures — pass filter to wait only for the entries you care about. multeam_wait does not observe background jobs — use job_output to wait for or collect a job.',
					parameters: {
						timeout_ms: {
							type: 'integer',
							description:
								'Wait duration in milliseconds. Must be a positive safe integer up to 3600000 (1h); values below 10000 (10s) skip the active-peer precheck and go straight to the service wait. Defaults to 30000.',
						},
						filter: {
							type: 'object',
							additionalProperties: false,
							properties: {
								kinds: {
									type: 'array',
									items: {
										type: 'string',
										enum: ['task_status', 'task_revision', 'task_owner', 'member_phase', 'member_status', 'mailbox', 'failure'],
									},
									description: 'Only return when a diff entry has one of these kinds. Absent = any kind matches.',
								},
								task_ids: {
									type: 'array',
									items: { type: 'string' },
									description: 'Only return when a diff entry\'s taskId is in this list. Entries without a taskId never match when this is set.',
								},
								members: {
									type: 'array',
									items: { type: 'string' },
									description: 'Only return when a diff entry\'s member is in this list. Entries without a member never match when this is set.',
								},
								mailbox_to_me: {
									type: 'boolean',
									description:
										'When true, mailbox diff entries only match messages delivered to you — useful for "wait until a report lands in my inbox". Mailbox entries for other recipients then re-arm instead of waking you.',
								},
							},
							description:
								'Only return when a diff entry matches every supplied constraint (AND across fields, OR within each array). Default: return on any change. Non-matching wakes re-arm the wait with the remaining timeout; a mailbox entry addressed to you always matches.',
						},
					},
					output: jsonOutput(WAIT_VALUE_SCHEMA),
					async execute(args, exec) {
						const caller = callingAgent(exec.agent, 'multeam_wait')
						const timeoutMs = args.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS
						const filter = args.filter
						const membership = ctx.agentTeams.membership(caller)
						// A teammate's wait timeout is equivalent to ending its turn;
						// only the Lead is a legitimate continuous observer.
						const withTimeoutHint = (result: unknown): unknown =>
							(result as { timedOut?: boolean } | undefined)?.timedOut === true && membership.role !== 'lead'
								? { ...(result as object), hint: WAIT_TIMEOUT_HINT }
								: result
						if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
							throw new Error(`timeout_ms must be a positive safe integer up to ${MAX_WAIT_TIMEOUT_MS}`)
						}
						if (timeoutMs < MIN_WAIT_TIMEOUT_MS) {
							return withTimeoutHint(await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal, filter))
						}
						const members = ctx.agentTeams.listMembers(caller)
						const callerName = membership.name
						if (
							!members.some((member) => member.target !== callerName && ACTIVE_WAIT_STATUSES.has(member.status)) &&
							!hasPendingOwnedTask(ctx, caller, callerName)
						) {
							return { timedOut: false, noProgress: { reason: 'no-active-peer', message: NO_ACTIVE_PEER_MESSAGE } }
						}
						return withTimeoutHint(await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal, filter))
					},
				} as never),
			),
		)
		register(
			scoped.tools.register(
				defineTool({
					name: 'multeam_interrupt',
					description: "Interrupt one teammate's current turn while preserving its pending inbox. Team Lead only.",
					parameters: {
						target: {
							type: 'string',
							required: true,
							description:
								'Teammate target as returned by multeam_spawn or multeam_list. Must name a live teammate — not lead, not a released member.',
						},
						reason: {
							type: 'string',
							description:
								'Optional audit reason recorded in the Team journal so later reviews can tell why the turn was interrupted. Omit when the interruption is routine.',
						},
					},
					output: jsonOutput(INTERRUPT_VALUE_SCHEMA),
					execute(args, exec) {
						return Promise.resolve(ctx.agentTeams.interrupt(callingAgent(exec.agent, 'multeam_interrupt'), args.target, args.reason))
					},
				} as never),
			),
		)
		register(
			scoped.tools.register(
				defineTool({
					name: 'multeam_broadcast',
					description:
						'Send one durable message to every active teammate at once (never to the Lead itself). Team Lead only — equivalent to calling multeam_send once per teammate. Use when the same instruction (e.g. a scope correction or a global constraint) must reach every member; prefer multeam_send for anything addressed to one member.',
					parameters: {
						message: { type: 'string', required: true, description: 'Self-contained message delivered to every active teammate.' },
						exclude: {
							type: 'array',
							items: { type: 'string' },
							description: 'Optional teammate targets to skip (e.g. the member that just reported). Omit to reach every active teammate.',
						},
					},
					output: jsonOutput({
						type: 'object',
						additionalProperties: false,
						properties: {
							sent: {
								type: 'integer',
								required: true,
								description: 'Number of teammates the message was accepted or queued for.',
							},
							failed: {
								type: 'array',
								required: true,
								items: { type: 'string' },
								description: 'Teammate targets whose send threw (e.g. became released mid-broadcast); the loop continues past failures.',
							},
							unmatchedExcludes: {
								type: 'array',
								items: { type: 'string' },
								description: 'Exclude names that matched no active teammate — e.g. "lead" is always unmatched because broadcast never sends to the Lead.',
							},
						},
					}),
					async execute(args, exec) {
						const caller = callingAgent(exec.agent, 'multeam_broadcast')
						const membership = ctx.agentTeams.membership(caller)
						if (membership.role !== 'lead') throw new Error('only the Team Lead may broadcast')
						const excluded = new Set(args.exclude ?? [])
						/* Reuse sendMessage's durable+delivery path rather than opening a
						 * parallel channel — broadcast is just N sends, so the same
						 * dedupe/lease semantics apply. Sequential await keeps the
						 * sent/failed accounting obvious and avoids a load spike. */
						const sent: string[] = []
						const failed: string[] = []
						const matchedExcludes = new Set<string>()
						for (const member of ctx.agentTeams.listMembers(caller)) {
							if (member.name === membership.name || !['running', 'idle', 'inactive'].includes(member.status)) continue
							if (excluded.has(member.name)) {
								matchedExcludes.add(member.name)
								continue
							}
							try {
								await ctx.agentTeams.sendMessage(caller, {
									target: member.name,
									content: [{ type: 'text', text: args.message }],
									signal: exec.signal,
								})
								sent.push(member.name)
							} catch {
								failed.push(member.name)
							}
						}
						const unmatchedExcludes = [...excluded].filter((name) => !matchedExcludes.has(name))
						return { sent: sent.length, failed, unmatchedExcludes }
					},
				} as never),
			),
		)
		register(
			scoped.tools.register(
				defineTool({
					name: 'multeam_release',
					description:
						'Discharge one teammate permanently. Stops the member and records it as released; released members cannot be messaged or assigned. Team Lead only.',
					parameters: {
						target: {
							type: 'string',
							required: true,
							description:
								'Teammate target as returned by multeam_spawn or multeam_list. Cannot be lead (the Lead cannot release itself); releasing an already released member returns its row without error.',
						},
					},
					output: jsonOutput(RELEASE_VALUE_SCHEMA),
					async execute(args, exec) {
						return { member: modelMember((await ctx.agentTeams.releaseMember(callingAgent(exec.agent, 'multeam_release'), args.target)).member) }
					},
				} as never),
			),
		)
		register(
			scoped.tools.register(
				defineTool({
					name: 'multeam_task_create',
					description: 'Create one unowned pending task on the shared Team task board.',
					parameters: {
						subject: { type: 'string', required: true, description: 'Concise task title.' },
						description: {
							type: 'string',
							required: true,
							description:
								'Complete task details and acceptance criteria; this is the self-contained record the owner executes against. It must stand alone — the owner sees only this description, not the Lead\'s conversation — so include goal, boundaries, write scope, acceptance criteria, and how to verify.',
						},
						blocked_by: {
							type: 'array',
							items: { type: 'string' },
							description:
								'Task ids that must complete first. Every listed blocker must exist and not be deleted; a task stays not-ready (cannot be claimed or reassigned) until all blockers reach completed.',
						},
						write_scopes: {
							type: 'array',
							items: { type: 'string' },
							description:
								'Advisory file or directory prefixes this task expects to modify, workspace-relative. Absolute paths are accepted and normalized (E:\\opencv\\x.py → opencv/x.py), so either form works. Overlap with another task\'s scopes is surfaced as a writeScopeWarnings conflict hint, not a lock — unless the service runs with enforceWriteScopes enabled, in which case a path-prefix overlap with a pending/in_progress task owned by another member makes claim/reassign fail with TEAM_WRITE_SCOPE_CONFLICT (the Lead is exempt — Lead tasks carry no scopes).',
						},
						acceptance: {
							type: 'array',
							items: { type: 'string' },
							description:
								'Optional acceptance-criteria checklist (every item a non-empty string). Persisted with the task and echoed on its view. When present, complete requires the effective description to cover every criterion (loose token match) or it is rejected with TEAM_ACCEPTANCE_MISSING.',
						},
						priority: {
							type: 'string',
							enum: ['high', 'medium', 'low'],
							description:
								'Optional dispatch priority; affects steer notification order only (high notified before medium before low), not guaranteed execution order.',
						},
					},
					output: jsonOutput(TASK_VIEW_SCHEMA),
					async execute(args, exec) {
						return await ctx.agentTeams.createTask(callingAgent(exec.agent, 'multeam_task_create'), {
							subject: args.subject,
							description: args.description,
							...(args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(taskId) }),
							...(args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes }),
							...(args.acceptance === undefined ? {} : { acceptance: args.acceptance }),
							...(args.priority === undefined ? {} : { priority: args.priority }),
						})
					},
				} as never),
			),
		)
		register(
			scoped.tools.register(
				defineTool({
					name: 'multeam_task_list',
					description: 'List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.',
					parameters: {
						status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Optional exact status filter.' },
						owner: {
							type: 'string',
							description:
								'Optional member target from multeam_spawn or multeam_list, matching ownerName exactly; use the literal value unowned for tasks without an owner (unowned is a reserved word — member names can never collide with it).',
						},
						ready: { type: 'boolean', description: 'Optional readiness filter: true keeps only tasks whose blockers are all completed, false keeps only blocked tasks.' },
						cursor: { type: 'integer', description: 'Zero-based result offset. Must be a non-negative safe integer. Defaults to 0.' },
						limit: { type: 'integer', description: 'Number of rows, an integer from 1 through 100. Defaults to 50.' },
					},
					output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
					execute(args, exec) {
						const status = args.status
						const filtered = ctx.agentTeams
							.listTasks(callingAgent(exec.agent, 'multeam_task_list'))
							.filter(
								(task) =>
									(status === undefined || task.status === status) &&
									(args.owner === undefined || (args.owner === 'unowned' ? task.ownerName === undefined : task.ownerName === args.owner)) &&
									(args.ready === undefined || task.ready === args.ready),
							)
						const cursor = args.cursor ?? 0
						const limit = args.limit ?? 50
						if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer')
						if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100')
						return Promise.resolve({
							tasks: filtered.slice(cursor, cursor + limit),
							...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
						})
					},
				} as never),
			),
		)
		register(
			scoped.tools.register(
				defineTool({
					name: 'multeam_task_get',
					description: 'Read the complete latest value of one shared task before changing or executing it.',
					parameters: {
						task_id: { type: 'string', required: true, description: 'Shared task id.' },
					},
					output: jsonOutput(TASK_VIEW_SCHEMA),
					execute(args, exec) {
						return Promise.resolve(ctx.agentTeams.getTask(callingAgent(exec.agent, 'multeam_task_get'), taskId(args.task_id)))
					},
				} as never),
			),
		)
		register(
			scoped.tools.register(
				defineTool({
					name: 'multeam_task_update',
					description:
						'Compare-and-set a shared task action using the latest revision from multeam_task_get or multeam_task_list.',
					parameters: {
						task_id: { type: 'string', required: true, description: 'Shared task id, e.g. task-3.' },
						expected_revision: {
							type: 'integer',
							required: true,
							description:
								'CAS precondition: the revision read by the most recent multeam_task_get or multeam_task_list. Must be a non-negative safe integer. Maps to the internal expectedRevision field (snake_case on the tool surface, camelCase inside the service). If another mutation already advanced the task past this revision: the edit action is retried once automatically against the current revision (flagged retried:true in the response); all other actions fail with TEAM_TASK_STALE_REVISION — re-read the task and resubmit with the correct revision.',
						},
						action: {
							type: 'string',
							required: true,
							enum: ['claim', 'release', 'unclaim', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'],
							description:
								'Task transition to apply. Per-action semantics and preconditions — claim: caller takes an unowned pending task whose blockers are all completed; status becomes in_progress with caller as owner (fails if another member already owns it or the task is still blocked; with enforceWriteScopes enabled, also fails with TEAM_WRITE_SCOPE_CONFLICT when its write_scopes path-prefix-overlap a pending/in_progress task owned by another member — sibling paths in the same directory that do not contain each other are adjacent, not conflicting). release (alias: unclaim): owner or Lead returns an in_progress task to pending and clears its owner — this releases the *task claim*, not the member (use multeam_release to discharge a member). edit: owner or Lead replaces subject/description/write_scopes/priority — at least one replacement field must be supplied. set_dependencies: owner or Lead replaces the complete blocked_by list; not allowed on a completed task; omitted blocked_by fails. complete: owner or Lead marks an in_progress task completed — if the task declares acceptance criteria the effective description (the description arg on this call, else the existing description) must cover every criterion or the action is rejected with TEAM_ACCEPTANCE_MISSING. reopen: owner or Lead returns a completed task to pending and clears its owner; blockers that were deleted in the meantime are dropped automatically. reassign: Lead-only; sets owner to the given member target. On a ready pending task or an in_progress task the assignee becomes owner and status becomes in_progress (the assignment is the claim); a blocked task cannot be reassigned to a member; with enforceWriteScopes enabled, member-bound reassign fails with TEAM_WRITE_SCOPE_CONFLICT on the same overlap rule as claim. Omit owner (or pass an empty string) to unassign — the task returns to unowned pending. delete: owner or Lead tombstones the task; fails while any non-deleted task still lists it in blocked_by. Every action fails on a deleted task and any action other than reassign requires the caller to be the task owner or the Lead.',
						},
						subject: { type: 'string', description: 'Replacement title for edit (non-empty, max 200 chars).' },
						description: {
							type: 'string',
							description: 'Replacement details for edit (non-empty, max 16384 chars). Completed work products belong here or in files whose path is recorded here.',
						},
						append_description: {
							type: 'string',
							description:
								'Append-only details for edit — the supplied text is joined to the existing description with a newline instead of replacing it. Mutually exclusive with description on the same call (supplying both fails with TEAM_INVALID_ARGUMENT). Prefer this when a teammate records its outcome so the original task body is preserved rather than overwritten.',
						},
						blocked_by: {
							type: 'array',
							items: { type: 'string' },
							description:
								'Complete replacement blocker list for set_dependencies — every listed task id must exist and not be deleted; the new graph must stay acyclic.',
						},
						write_scopes: {
							type: 'array',
							items: { type: 'string' },
							description:
								'Replacement advisory write scopes for edit. Advisory only at edit time — but with enforceWriteScopes enabled the new scopes are re-checked on the next claim/member-bound reassign, which fails with TEAM_WRITE_SCOPE_CONFLICT if they collide with a scoped pending/in_progress task owned by another member.',
						},
						owner: {
							type: 'string',
							description: 'Member target from multeam_spawn or multeam_list used by Lead-only reassign. Must resolve to an active (non-released, non-failed) member. Omit to unassign; an empty string also unassigns.',
						},
						priority: {
							type: 'string',
							enum: ['high', 'medium', 'low'],
							description: 'Replacement priority for edit; affects scheduler steer notification order only, not guaranteed execution order.',
						},
						attempt_id: {
							type: 'string',
							description:
								'Optional owner capability token — if provided it must match the current task\'s attemptId (see your own task view via multeam_task_get/list); a mismatched token fails with TEAM_TASK_STALE_ATTEMPT. You may omit it for owner actions: the CAS expected_revision already proves you re-read the latest attempt. Not required for Lead actions.',
						},
						lesson: {
							type: 'string',
							description: 'Optional one-line lesson learned (<500 chars). Persisted on the task and replayed to future teammates working on same-capability tasks.',
						},
					},
					output: jsonOutput(TASK_VIEW_SCHEMA),
					async execute(args, exec) {
						if (!Number.isSafeInteger(args.expected_revision) || args.expected_revision < 0) {
							throw new Error('expected_revision must be a non-negative safe integer')
						}
						const doUpdate = (revision: number): Promise<TeamTaskView> =>
							ctx.agentTeams.updateTask(callingAgent(exec.agent, 'multeam_task_update'), {
								taskId: taskId(args.task_id),
								expectedRevision: revision,
								action: args.action,
								...(args.subject === undefined ? {} : { subject: args.subject }),
								...(args.description === undefined ? {} : { description: args.description }),
								...(args.append_description === undefined ? {} : { appendDescription: args.append_description }),
								...(args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(taskId) }),
								...(args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes }),
								...(args.owner === undefined ? {} : { owner: args.owner }),
								...(args.priority === undefined ? {} : { priority: args.priority }),
								...(args.attempt_id === undefined ? {} : { attemptId: args.attempt_id }),
								...(args.lesson === undefined ? {} : { lesson: args.lesson }),
							})
						try {
							return await doUpdate(args.expected_revision)
						} catch (error) {
							/* CAS conflict — only idempotent reads may be retried safely.
							 * Mutating actions (complete/delete/reassign/release/reopen) replayed
							 * on a stale revision can silently overwrite another member's work,
							 * so those fail closed.  Only `edit` is safe to retry because the
							 * caller supplies replacement fields, not a diff. */
							const RETRYABLE_ACTIONS = new Set(['edit'])
							if (
								RETRYABLE_ACTIONS.has(args.action) &&
								error instanceof Error &&
								(error as { code?: string }).code === 'TEAM_TASK_STALE_REVISION'
							) {
								const current = ctx.agentTeams.getTask(callingAgent(exec.agent, 'multeam_task_update'), taskId(args.task_id))
								if (current !== undefined && current.revision !== args.expected_revision) {
									return { ...(await doUpdate(current.revision)), retried: true, baseRevision: args.expected_revision, retriedFromConflict: true }
								}
							}
							throw error
						}
					},
				} as never),
			),
		)
		register(
			scoped.tools.register(
				defineTool({
					name: 'multeam_status',
					description:
						'Snapshot the whole Team at once: roster, task board, undelivered peer messages, and any projection failure. Prefer this ONE call over repeated multeam_task_list/multeam_list polling — it returns the full board in a single round-trip. Call it after multeam_wait wakes or when state may be stale. Pass sections to keep only the named parts of the snapshot; omitting it returns the full board.',
					parameters: {
						sections: {
							type: 'array',
							items: { type: 'string', enum: ['members', 'tasks', 'mailbox', 'failure', 'metrics', 'decisions'] },
							description:
								'Optional subset of the snapshot to return: members (roster), tasks (task board), mailbox (undelivered peer messages), failure (projection failure), metrics (journalQueueDepth + service counters/gauges), decisions (optional team-scheduler observability bundle: scheduler health, per-session stats, and recent capability-match decision entries — {available:false} when the scheduler service is not mounted). Empty or omitted returns all sections.',
						},
						readyOnly: {
							type: 'boolean',
							description: 'When true, the returned tasks list keeps only ready tasks (pending with all blockers completed) — the subset the Lead can assign or claim next. Defaults to false.',
						},
						decision_limit: {
							type: 'integer',
							description: 'Max capability-match decision entries returned with the decisions section. A non-negative integer; defaults to 20. Only consulted when sections includes decisions (or sections is omitted).',
						},
					},
					output: jsonOutput(STATUS_VALUE_SCHEMA),
					execute(args, exec) {
						const caller = callingAgent(exec.agent, 'multeam_status')
						const status = ctx.agentTeams.teamStatus(caller)
						const full = { ...status, members: (status.members as TeamMemberView[]).map(modelMember) }
						const sections = args.sections
						const tasks =
							args.readyOnly === true ? (full.tasks as TeamTaskView[]).filter((task) => task.ready === true) : (full.tasks as TeamTaskView[])
						const wantAll = !Array.isArray(sections) || sections.length === 0
						const wanted = wantAll ? undefined : new Set(sections)
						/* metrics/decisions are built only on request — schedulerSnapshot is
						 * a cross-service read. The remaining sections are field trims of one
						 * already-constructed teamStatus, which costs one O(state) filter. */
						const wantMetrics = wantAll || (wanted?.has('metrics') ?? false)
						const wantDecisions = wantAll || (wanted?.has('decisions') ?? false)
						if (wantDecisions) {
							const limit = args.decision_limit ?? 20
							if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('decision_limit must be a non-negative safe integer')
							full.scheduler = ctx.agentTeams.schedulerSnapshot(caller, limit)
						}
						if (wantAll) return Promise.resolve(args.readyOnly === true ? { ...full, tasks } : full)
						const trimmed: Record<string, unknown> = {}
						if (wanted?.has('members')) trimmed.members = full.members
						if (wanted?.has('tasks')) trimmed.tasks = tasks
						if (wanted?.has('mailbox')) trimmed.pendingMessages = full.pendingMessages
						/* 投影无故障时 failure 为 undefined，schema 允许 null——统一回写
						 * null 而不是省略，保证调用方总能拿到字段而不必区分「缺失」
						 * 与「校验失败」。 */
						if (wanted?.has('failure')) trimmed.failure = full.failure ?? null
						if (wantMetrics) {
							trimmed.journalQueueDepth = full.journalQueueDepth
							trimmed.metrics = full.metrics
						}
						if (wantDecisions) trimmed.scheduler = full.scheduler
						return Promise.resolve(trimmed)
					},
				} as never),
			),
		)
	} catch (error) {
		disposeAll()
		throw error
	}
	return disposeAll
}

/** Install Team tools in every live or subsequently published Team member scope. */
export function apply(ctx: TeamToolContext, config: Partial<{ freshProvider: string; forkProvider: string; enforceWriteScopes: boolean }> = {}): void {
	const resolved = {
		freshProvider: config.freshProvider ?? 'spawn',
		forkProvider: config.forkProvider ?? 'fork',
		enforceWriteScopes: config.enforceWriteScopes ?? true,
	}
	const installed = new Map<TeamAgent, () => void>()
	const maybeInstall = (agent: TeamAgent): void => {
		try {
			if (installed.has(agent)) {
				activationLog(`tool skip agent=${agent.id} reason=already-installed`)
				return
			}
			const membership = ctx.agentTeams.tryMembership(agent)
			if (membership === undefined) {
				activationLog(`tool skip agent=${agent.id} reason=no-membership`)
				return
			}
			activationLog(`tool install:start agent=${agent.id} role=${(membership as { role?: string }).role}`)
			installed.set(agent, install(agent, ctx, resolved))
			activationLog(`tool install:done agent=${agent.id}`)
		} catch (error) {
			/* One member's broken scope must not take the mount down. This runs
			 * inside the `agent/created` emitter, so an escape becomes an uncaught
			 * exception; on the first loop below it would also abort `apply` and
			 * leave every later member silently tool-less. */
			const note = `tool-agent-team: install failed for ${agent.id}: ${errorMessage(error)}`
			ctx.logger?.warn?.(note)
			activationLog(`install:throw agent=${agent.id} error=${errorMessage(error)}`)
			/* A member that exists but never got tools looks healthy on the Lead's
			 * board — surface the failure on its diagnostics so a "has no tools"
			 * incident is visible without digging through host logs. */
			try {
				ctx.agentTeams.recordInstallDiagnostic?.(agent, note)
			} catch {
				// Diagnostic reporting is best-effort; never mask the original failure.
			}
		}
	}
	activationLog(`tool sweep start count=${ctx.agents.list().length}`)
	for (const agent of ctx.agents.list()) maybeInstall(agent)
	activationLog('tool sweep done')
	ctx.on('agent/created', ({ agent }) => {
		activationLog(`tool event:created agent=${agent.id}`)
		maybeInstall(agent)
	})
	ctx.on('agent/disposed', ({ agent }) => {
		installed.get(agent)?.()
		installed.delete(agent)
	})
	ctx.effect(() => {
		return () => {
			for (const dispose of installed.values()) dispose()
			installed.clear()
		}
	}, 'tool-team.scopedTools()')
}
