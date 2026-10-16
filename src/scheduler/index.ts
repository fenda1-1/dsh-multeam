/**
 * DAG task scheduler for Agent Teams.
 *
 * Watches `session/event` for `team/task` and `team/member` journal entries.
 * After each commit it re-reads the projected task board and, for every task
 * that newly became ready (all blockers completed), wakes its owner via
 * `agentTeams.sendMessage` so a dormant teammate resumes and claims the task —
 * turning the passive task board into an active DAG scheduler. A ready task
 * with no owner yet steers the Lead instead.
 *
 * Notification key = `${rootId}:${taskId}:${ownerId ?? 'unassigned'}` so a
 * reassign on a ready task notifies the new owner once; completed/deleted tasks
 * are pruned.
 *
 * Opt-in features (all default off for backward compatibility):
 *   1. priority          — dispatch priority-ordered high→low
 *   2. timeoutDetection  — alert the Lead on stale in_progress tasks
 *   3. loadBalance       — unassigned steer includes per-teammate load stats
 *   4. retryLimit        — retry a failed owner wake, then alert the Lead once
 *   5. capabilityMatch   — unassigned steer appends keyword capability hints
 *   6. learnedHints      — replay same-capability lessons into wake messages
 *   7. compressInject    — inject only the skeleton of an oversized description
 *   8. stallDetection    — alert when the state signature goes silent
 *   9. repeatDetection   — steer/cancel a session stuck repeating its output
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { compressTaskBrief, estimateTokens } from '../core/index.js'
import { PRIORITY_WEIGHT, type TaskPriority } from '../core/validation.js'
import type { TeamTaskSnapshot } from '../core/types.js'

const NOTIFY_MESSAGE = (task: TeamTaskSnapshot, lastError?: string): string =>
	`[DAG 调度] 任务 ${task.id}「${task.subject}」已就绪并指派给你（前置依赖全部完成）。` +
	`当前状态 ${task.status === 'in_progress' ? 'in_progress（已认领）' : 'pending'}，` +
	`${task.status === 'in_progress' ? '请直接开始执行' : `请用 multeam_task_update(action: "claim", task_id: "${task.id}", expected_revision: ${task.revision}) 认领并开始执行`}；` +
	`完成后用 multeam_task_update(action: "complete") 提交结果。` +
	(lastError !== undefined && lastError !== '' ? `\n⚠️ 上次派发失败原因：${lastError}` : '')

// claim-once 是团队硬规矩：多任务唤醒必须引导顺序执行，不能引导并行认领。
const NOTIFY_MESSAGE_MULTI = (tasks: readonly TeamTaskSnapshot[], lastError?: string): string =>
	`[DAG 调度] 以下任务已就绪并指派给你：` +
	`${tasks.map((task) => `${task.id}「${task.subject}」`).join('、')}。` +
	`请按顺序逐个执行：每次只认领一个任务（claim-once），complete 后再认领下一个。` +
	(lastError !== undefined && lastError !== '' ? `\n⚠️ 上次派发失败原因：${lastError}` : '')

const UNASSIGNED_MESSAGE = (task: TeamTaskSnapshot, loadInfo: string | undefined, suggestedOwner: string | undefined): string =>
	`[DAG 调度] 任务 ${task.id}「${task.subject}」已就绪但尚未分配 owner，` +
	(suggestedOwner !== undefined
		? `建议 reassign 给「${suggestedOwner}」（能力匹配 top-1）。` +
			`请用 multeam_task_update(action: "reassign", task_id: "${task.id}", owner: "${suggestedOwner}") 指派，` +
			`或选其他 teammate/直接 claim 执行。`
		: `请用 multeam_task_update(action: "reassign") 指派给合适的 teammate，或直接 claim 执行。`) +
	(loadInfo ? `\n${loadInfo}` : '')

const ORPHAN_MESSAGE = (task: TeamTaskSnapshot, ownerName: string | undefined, ownerPhase: string | undefined): string =>
	`[DAG 调度] ⚠️ 任务 ${task.id}「${task.subject}」的 owner ` +
	`${ownerName !== undefined ? `"${ownerName}"` : '（已无法解析）'}` +
	`${ownerPhase !== undefined ? `（phase=${ownerPhase}）` : '（phase 未知）'} 已不在团队中，` +
	`请 reassign 给其他 teammate 或 reopen。`

const TIMEOUT_MESSAGE = (task: TeamTaskSnapshot, elapsedMin: number, ownerName: string | undefined, alertCount: number): string =>
	`[DAG 调度] ⚠️ 任务 ${task.id}「${task.subject}」已进行 ${elapsedMin} 分钟仍未完成，` +
	`owner 为 ${ownerName ?? '未知'}${alertCount > 1 ? `（第 ${alertCount} 次告警）` : ''}。请关注该任务是否卡住，必要时重新分配。`

/** Sort weight per canonical priority — the twin of the core alias table. */
const PRIORITY_ORDER: Record<string, number> = {
	high: PRIORITY_WEIGHT.high,
	'高': PRIORITY_WEIGHT.high,
	medium: PRIORITY_WEIGHT.medium,
	'中': PRIORITY_WEIGHT.medium,
	low: PRIORITY_WEIGHT.low,
	'低': PRIORITY_WEIGHT.low,
}

// Performance-scoring constants, named instead of scattered magic numbers:
const RELIABILITY_PRIOR_SUCCESS = 1
const RELIABILITY_PRIOR_TRIALS = 2
/** Wilson interval z — 1.96 is the 95% confidence level. */
const WILSON_Z = 1.96
/** Upper bound multiplier per relevant domain overlap. */
const PERF_BONUS_PER_RELEVANT = 1.5
/** Penalty per timeout/dispatch failure; a 30-minute TTL keeps one-off jitter from permanently staining a profile. */
const TIMEOUT_PENALTY_FACTOR = 0.5
const DISPATCH_FAIL_TTL_MS = 30 * 60 * 1000
/** Per-tag lesson-pool size, the fallback extraction regex, and its capture cap. */
const LESSON_MAX_PER_TAG = 3
const LESSON_LINE_RE = /^\s*(?:经验|教训|LESSON)\s*[:：]\s*(.+)$/im
const LESSON_TEXT_MAX = 160

// ── Repeat-output detection ────────────────────────────────────────────────
// Verdict: consecutive REPEAT_WINDOW assistant outputs whose pairwise n-gram
// Jaccard similarity all exceed REPEAT_THRESHOLD.
const REPEAT_WINDOW = 3
const REPEAT_THRESHOLD = 0.7
const REPEAT_MAX_BUFFER = 5
const REPEAT_TEXT_MAX = 4000
/** Under a hard interrupt this nudge starts a NEW turn, so it must read as
 * "you were just interrupted", not "please stop". */
const REPEAT_NUDGE =
	`[防卡死] ⚠️ 检测到你连续 ${REPEAT_WINDOW} 次输出高度重复，本轮已被强制中断。` +
	`请换个角度重新开始（拆小步、换工具、或直接汇报当前进展与卡点），不要重复上一段表述。`

/**
 * Task capability classification: map task text onto capability buckets.
 * Each entry is [tag, regex], matched in order with first-hit-wins — a
 * zero-dependency approximation of an embedding.
 */
const CAPABILITY_PATTERNS: readonly (readonly [string, RegExp])[] = [
	[
		'code',
		/(?:implement|编码|实现|开发|code|编程|函数|模块|api|refactor|重构|fix|bug|编译|compile|部署|deploy|优化|optimize|性能|perf|数据库|database|前端|frontend|后端|backend|样式|style|安全|security|并发|concurrent|异步|async|缓存|cache|监控|monitor|日志|logging|迁移|migrate|调试|debug|序列化|serialize|解析|parse|校验|validate|索引|index|路由|route|鉴权|auth|加密|encrypt|压缩|compress|流|stream|管道|pipeline|队列|queue)/iu,
	],
	['test', /(?:test|测试|用例|assert|断言|单元测试|集成测试|回归测试|e2e)/iu],
	['docs', /(?:doc|文档|说明|readme|注释|jsdoc|api\s*doc|changelog|docs)/iu],
	['review', /(?:review|评审|审查|审计|检查|走查|inspect|audit)/iu],
	['analysis', /(?:分析|analysis|调研|research|评估|evaluate|统计|报告|report|summary|摘要|趋势|对比|benchmark|baseline|指标|metric)/iu],
]

/**
 * Infer a task's capability tag from its text. First pattern hit wins; no hit
 * returns undefined (no forced classification).
 * @param text - task subject + description.
 * @returns the capability tag, or undefined.
 */
export function inferCapabilityTag(text: string | undefined): string | undefined {
	const hay = (text ?? '').toLowerCase()
	for (const [tag, re] of CAPABILITY_PATTERNS) {
		if (re.test(hay)) return tag
	}
	return undefined
}

/**
 * Wilson score interval lower bound — the confidence lower bound of a binomial.
 * At z=1.96 this is the 95% Wilson interval. Small samples trend conservative
 * (1/1 → 0.42), large samples trend toward the true rate (100/100 → 0.96),
 * replacing the Beta(1,1) point estimate's small-sample over-optimism.
 * @param successes - completed count.
 * @param trials - total trials (completed + timeouts).
 * @param z - confidence parameter, default 1.96.
 * @returns the Wilson lower bound in (0,1); 0 when trials is 0.
 */
export function wilsonLowerBound(successes: number, trials: number, z = WILSON_Z): number {
	if (trials === 0) return 0
	const n = trials
	const p = successes / n
	const z2 = z * z
	const denom = 1 + z2 / n
	const centre = p + z2 / (2 * n)
	const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
	return Math.max(0, (centre - spread) / denom)
}

const RETRY_MESSAGE = (task: TeamTaskSnapshot, attempt: number, maxAttempts: number, ownerName: string, lastError?: string): string =>
	`[DAG 调度] 🔁 任务 ${task.id}「${task.subject}」派发重试（第 ${attempt}/${maxAttempts} 次）：` +
	`唤醒 owner「${ownerName}」未送达，已自动重试。` +
	(lastError !== undefined && lastError !== '' ? `上次失败原因：${lastError}。` : '') +
	`若仍失败请检查该 teammate 状态（multeam_list）并考虑 reassign。`

const RETRY_EXHAUSTED_MESSAGE = (task: TeamTaskSnapshot, ownerName: string): string =>
	`[DAG 调度] ⛔ 任务 ${task.id}「${task.subject}」派发重试已耗尽：owner「${ownerName}」` +
	`连续唤醒失败。请人工介入——用 multeam_list 查看其状态，必要时 reassign 给其他 teammate 或 reopen 该任务。`

const RETRY_EXHAUSTED_GROUP_MESSAGE = (tasks: readonly TeamTaskSnapshot[], ownerName: string): string =>
	`[DAG 调度] ⛔ 以下任务派发重试已耗尽（owner「${ownerName}」连续唤醒失败）：` +
	`${tasks.map((task) => `${task.id}「${task.subject}」`).join('、')}。` +
	`请用 multeam_list 查看其状态，必要时 reassign 给其他 teammate 或 reopen。`

const CAPABILITY_HINT = (_task: TeamTaskSnapshot, suggestions: readonly string[], coldStart: boolean): string =>
	`\n💡 ${coldStart ? '能力匹配建议（冷启动，首次执行）' : '能力匹配建议'}：${suggestions.join('；')}`

const STALLED_MESSAGE = (stalledMin: number, openTasks: number): string =>
	`[DAG 调度] 🛑 团队已停滞约 ${stalledMin} 分钟：` +
	`任务状态/成员/mailbox 签名在该时长内未发生任何变化，但仍存在 ${openTasks} 个未完成任务` +
	`（${openTasks > 8 ? `含 ${openTasks} 项` : '见 multeam_status'}）。` +
	`请检查是否有 owner 卡住、唤醒丢失或依赖阻塞——用 multeam_status / multeam_list 定位并介入。`

/**
 * Capability keywords in two tiers by discriminative power:
 * SPECIFIC terms genuinely distinguish member domains and score full marks;
 * GENERIC terms match almost every task, so they only gate perfBonus
 * eligibility and never contribute to kwScore.
 */
const SPECIFIC_KEYWORDS = [
	'review', '评审', '审查', '重构', 'refactor',
	'部署', 'deploy', '前端', 'frontend', '后端', 'backend',
	'样式', 'style', '性能', 'perf', '安全', 'security',
	'数据库', 'database', 'api', '协议', 'protocol',
	'并发', 'concurrent', '异步', 'async', '缓存', 'cache',
	'监控', 'monitor', '日志', 'logging',
	'迁移', 'migrate', '优化', 'optimize', '调试', 'debug',
	'序列化', 'serialize', '解析', 'parse', '校验', 'validate',
	'编译', 'compile', '索引', 'index', '路由', 'route',
	'鉴权', 'auth', '加密', 'encrypt', '压缩', 'compress',
	'流', 'stream', '管道', 'pipeline', '队列', 'queue',
]

const GENERIC_KEYWORDS = [
	'测试', 'test', 'code', '编码', '实现', '修复', 'fix', 'bug',
	'数据', 'data', 'ui', '文档', 'doc', '分析', 'analysis',
	'编写', 'write', '调研', 'research',
]

const CAPABILITY_KEYWORDS = [...SPECIFIC_KEYWORDS, ...GENERIC_KEYWORDS]

/** Pre-compiled word-boundary regexes for ASCII keywords, avoiding data→database / fix→prefix false hits. */
const ASCII_KW_RE = new Map<string, RegExp>()
function asciiKeywordRe(kw: string): RegExp {
	let re = ASCII_KW_RE.get(kw)
	if (re === undefined) {
		re = new RegExp(`(?<![a-z])${kw}(?![a-z])`, 'iu')
		ASCII_KW_RE.set(kw, re)
	}
	return re
}
const ASCII_ONLY = /^[\x20-\x7e]+$/u

/** Lower-cased GENERIC set — consulted when scoring to down-weight. */
const GENERIC_SET = new Set(GENERIC_KEYWORDS.map((k) => k.toLowerCase()))

/**
 * Extract the capability keywords present in one text (lower-cased match).
 * CJK keywords use substring matching (Chinese has no word boundaries); pure
 * ASCII keywords require non-letter surroundings so a keyword cannot match
 * inside a longer word.
 * @param text - any description/subject/task-book text.
 * @returns the set of matched keywords (SPECIFIC + GENERIC).
 */
function extractCapabilities(text: string | undefined): Set<string> {
	const hay = (text ?? '').toLowerCase()
	const found = new Set<string>()
	for (const kw of CAPABILITY_KEYWORDS) {
		if (kw.length < 2) continue
		const needle = kw.toLowerCase()
		if (ASCII_ONLY.test(needle)) {
			if (asciiKeywordRe(needle).test(hay)) found.add(kw)
		} else if (hay.includes(needle)) {
			found.add(kw)
		}
	}
	return found
}

/** One persisted per-member performance record. */
interface PerfEntry {
	completed: number
	timeouts: number
	capabilities: Set<string>
	seen: Set<string>
	completedTaskIds: Set<string>
	byCapability: Map<string, { completed: number; timeouts: number }>
	lastDecayAt: number
	dispatchFailures?: { count: number; ts: number }
}

/** One lesson pooled per capability tag. */
interface LessonEntry {
	readonly text: string
	readonly from: string
	readonly taskId: string
	readonly ts: number
	/** Capability keywords of the source task; absent on lessons persisted before this field existed (injected unfiltered). */
	readonly caps?: readonly string[]
}

/** Per-session cumulative scheduler counters. */
interface SchedulerStats {
	dispatched: number
	skipped: number
	orphan: number
	timeoutAlerts: number
	retryExhausted: number
	passes: number
}

/** One stall-tracking record per session. */
interface StallTrack {
	sig: string
	since: number
	alerted: boolean
}

/** One capability-match decision, kept for post-hoc audit. */
interface DecisionEntry {
	readonly taskId: string
	readonly scored: readonly { name: string; hits: readonly string[]; kwScore: number; perfBonus: number; score: number; coldStart: boolean }[]
	readonly timestamp: number
}

/** The scheduler context shape, resolved structurally so DSH stays a peer. */
export interface SchedulerContext {
	agentTeams: {
		sendMessage(agent: unknown, request: { target: string; content: unknown[]; signal: AbortSignal }): Promise<unknown>
	}
	agents: { get(id: string): { steer(input: unknown): void } | undefined; roots(): readonly { session?: { id: string } }[] }
	sessionProjections?: { stateOf(session: unknown, key: string): TeamRawState | undefined }
	logger?: { warn?(message: string): void; info?(message: string): void; debug?(message: string): void }
	on(event: string, listener: (...args: never[]) => void): () => void
	effect(callback: () => (() => void) | void, name?: string): void
}

/** The raw agentTeam state the scheduler reads (journal shape, not view shape). */
interface TeamRawState {
	readonly id: string
	readonly members?: readonly { id: string; name: string; phase: string; description?: string }[]
	readonly tasks?: readonly TeamTaskSnapshot[]
	readonly messages?: readonly unknown[]
	readonly delivered?: readonly string[]
	readonly failure?: string
}

/** Scheduler configuration; every opt-in feature defaults off. */
export interface SchedulerConfig {
	enabled?: boolean
	notifyUnassigned?: boolean
	priority?: boolean
	timeoutDetection?: boolean
	timeoutMs?: number
	timeoutAlertIntervalMs?: number
	loadBalance?: boolean
	retryLimit?: number
	capabilityMatch?: boolean
	learnedHints?: boolean
	compressInject?: boolean
	compressBriefMax?: number
	stallDetection?: boolean
	stallThresholdMs?: number
	stallCheckIntervalMs?: number
	repeatDetection?: boolean
	repeatInterrupt?: boolean
	repeatThreshold?: number
	repeatWindow?: number
}

/**
 * Apply the scheduler's defaults and clamps.
 *
 * Every opt-in feature defaults off, and every numeric field clamps to its own
 * sane range — this is the single place those rules live, so the constructor and
 * the loader schema cannot disagree.
 */
function resolveSchedulerConfig(config: SchedulerConfig): Required<SchedulerConfig> {
	return {
		enabled: config.enabled !== false,
		notifyUnassigned: config.notifyUnassigned !== false,
		priority: config.priority === true,
		timeoutDetection: config.timeoutDetection === true,
		timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : 30 * 60 * 1000,
		timeoutAlertIntervalMs: typeof config.timeoutAlertIntervalMs === 'number' ? Math.max(0, config.timeoutAlertIntervalMs) : 0,
		loadBalance: config.loadBalance === true,
		retryLimit: typeof config.retryLimit === 'number' ? Math.max(0, config.retryLimit) : 0,
		capabilityMatch: config.capabilityMatch === true,
		learnedHints: config.learnedHints === true,
		compressInject: config.compressInject === true,
		compressBriefMax: typeof config.compressBriefMax === 'number' ? Math.max(200, config.compressBriefMax) : 800,
		stallDetection: config.stallDetection === true,
		stallThresholdMs: typeof config.stallThresholdMs === 'number' ? Math.max(0, config.stallThresholdMs) : 10 * 60 * 1000,
		stallCheckIntervalMs: typeof config.stallCheckIntervalMs === 'number' ? Math.max(1000, config.stallCheckIntervalMs) : 60 * 1000,
		repeatDetection: config.repeatDetection !== false,
		repeatInterrupt: config.repeatInterrupt !== false,
		repeatThreshold: typeof config.repeatThreshold === 'number' ? Math.min(1, Math.max(0, config.repeatThreshold)) : REPEAT_THRESHOLD,
		repeatWindow: typeof config.repeatWindow === 'number' ? Math.max(2, config.repeatWindow) : REPEAT_WINDOW,
	}
}

/** DAG task scheduler: wakes owners when their blockers complete. */
export class TeamScheduler extends Service {
	static inject = ['agentTeams', 'agents', 'sessionProjections']

	/** `${rootId}:${taskId}:${ownerId}` → true, preventing duplicate wakes for one ready state. */
	notified = new Map<string, boolean>()
	/** Per-root serialized scheduling pass (same idea as the journal's transact tail). */
	tails = new Map<string, Promise<void>>()
	/** session.id → true: new events arrived during a pass, so one more is needed. */
	coalescePending = new Map<string, boolean>()
	/** `${rootId}:${taskId}:${ownerId}` → first time seen in_progress (timeout detection). */
	inProgressSince = new Map<string, number>()
	/** Same key → the timeouts already alerted, with their count. */
	timeoutNotified = new Map<string, { count: number; ts: number }>()
	/** notifyKey → retries used after a failed owner wake. */
	retryCount = new Map<string, number>()
	/** notifyKey → true once retries are exhausted and the Lead was alerted. */
	retryExhausted = new Map<string, boolean>()
	/** notifyKey → the last dispatch failure's message, attached to the retry wake. */
	retryLastError = new Map<string, string>()
	/** sessionId → true once its projection failure has been warned. */
	failureWarned = new Set<string>()
	/** sessionId → the latest state signature, when it was first seen, and whether it was alerted. */
	stallTrack = new Map<string, StallTrack>()
	/** memberId → historical performance driving capability-match weighting. */
	perfMap = new Map<string, PerfEntry>()
	/** session.id → true once perfMap was restored from disk. */
	perfLoaded = new Map<string, boolean>()
	/** session.id → true when this pass modified perfMap and it must be persisted. */
	perfDirty = new Map<string, boolean>()
	/** taskId → last seen revision, so collectPerf only processes changed tasks. */
	lastSeenRevision = new Map<string, number>()
	/** memberId → when perf decay last ran for that member. */
	lastDecayAt = new Map<string, number>()
	/** memberId → accumulated steer-failure count (negative feedback). */
	dispatchFailures = new Map<string, { count: number; ts: number }>()
	/** sessionId → the recent REPEAT_MAX_BUFFER complete assistant texts (ring). */
	recentOutputs = new Map<string, string[]>()
	/** sessionId → the current attempt's streamed text accumulation. */
	streamBuffers = new Map<string, string>()
	/** sessionId → true once the current repeat segment was nudged. */
	repeatNudged = new Map<string, boolean>()
	/** sessionId → cumulative scheduler counters. */
	stats = new Map<string, SchedulerStats>()
	/**
	 * Resolve one per-session state map, seeding it when a partially constructed
	 * instance (the `Object.create` pattern used by tests) skipped the class-field
	 * initializer. Every scheduler map is reachable through this so the field
	 * declarations stay the single source of truth.
	 */
	private map<K, V>(field: Map<K, V> | undefined): Map<K, V> {
		return (field ??= new Map<K, V>())
	}

	/** Set counterpart of {@link map}. */
	private set<V>(field: Set<V> | undefined): Set<V> {
		return (field ??= new Set<V>())
	}
	/** Cross-session alert ring buffer, capped at 100 entries. */
	alertLog: { type: string; taskId?: string; ownerId?: string; sessionId: string; timestamp: number }[] = []
	/** Cumulative pass count plus the last pass timestamp (healthCheck). */
	passCount = 0
	lastPassAt = 0
	/** sessionId → recent capability-match decisions, capped at 20 per session. */
	decisionLog = new Map<string, DecisionEntry[]>()
	/** Cumulative estimated tokens saved by compression. */
	compressSaved = 0
	/** How many times compression actually fired. */
	compressSamples = 0
	/** tag → lessons pooled from completed tasks, shared instance-wide. */
	lessonsByTag = new Map<string, LessonEntry[]>()
	/** `${rootId}:${taskId}:${revision}` → true, so each revision is collected once. */
	lessonSeen = new Set<string>()

	readonly config: Required<SchedulerConfig>

	constructor(ctx: SchedulerContext, config: SchedulerConfig = {}) {
		super(ctx as never, 'teamScheduler')
		this.config = resolveSchedulerConfig(config)
		ctx.on('session/event', (session: unknown, event: { type?: string }) => {
			if (!this.config.enabled) return
			// team/member (release/failed settlement) can change the ownerGone verdict
			// just like team/task, so both trigger an immediate board rescan.
			if (event?.type !== 'team/task' && event?.type !== 'team/member') return
			this.schedulePass(session).catch((error: unknown) => {
				this.ctx.logger?.warn?.(`team scheduler pass failed: ${message(error)}`)
			})
		})
		// Restart catch-up: tasks that became orphaned or ready while the Lead was
		// down produce no new event, so an agent rebuild must also run a pass.
		ctx.on('agent/created', ({ agent }: { agent: { session?: unknown } }) => {
			if (!this.config.enabled) return
			this.schedulePass(agent.session).catch((error: unknown) => {
				this.ctx.logger?.warn?.(`team scheduler pass failed: ${message(error)}`)
			})
		})
		// Repeat-output detection watches the assistant stream: chunks accumulate,
		// end settles one complete text into the ring. Ordinary non-member sessions
		// are monitored too — a repeat loop is not teammate-specific.
		if (this.config.repeatDetection) {
			ctx.on('agent/assistant-stream', ({ agent, frame }: { agent: unknown; frame: unknown }) => {
				try {
					this.observeAssistantStream(agent, frame)
				} catch (error) {
					this.ctx.logger?.warn?.(`team scheduler repeat-detect failed: ${message(error)}`)
				}
			})
		}
		// Stall detection needs a time-driven poll: an unchanged signature means no
		// event arrives, so runPass never self-fires. unref does not block exit.
		if (this.config.stallDetection) {
			ctx.effect(() => {
				const timer = setInterval(() => {
					try {
						this.stallTick()
					} catch (error) {
						this.ctx.logger?.warn?.(`team scheduler stall tick failed: ${message(error)}`)
					}
				}, this.config.stallCheckIntervalMs)
				timer.unref?.()
				return () => clearInterval(timer)
			})
		}
	}

	/** Record one alert (observability) and increment its per-session counter. */
	private recordAlert(sessionId: string, type: string, taskId?: string, ownerId?: string): void {
		this.alertLog ??= []
		this.alertLog.push({ type, taskId, ownerId, sessionId, timestamp: Date.now() })
		if (this.alertLog.length > 100) this.alertLog.shift()
		const s = this.map(this.stats).get(sessionId) ?? { dispatched: 0, skipped: 0, orphan: 0, timeoutAlerts: 0, retryExhausted: 0, passes: 0 }
		if (type === 'timeout') s.timeoutAlerts++
		else if (type === 'orphan') s.orphan++
		else if (type === 'retry-exhausted') s.retryExhausted++
		this.map(this.stats).set(sessionId, s)
	}

	/** Return one session's cumulative scheduler stats. */
	getStats(sessionId: string): SchedulerStats {
		return this.map(this.stats).get(sessionId) ?? { dispatched: 0, skipped: 0, orphan: 0, timeoutAlerts: 0, retryExhausted: 0, passes: 0 }
	}

	/** Scheduler health snapshot. */
	healthCheck(): Record<string, unknown> {
		return {
			lastPassAt: this.lastPassAt,
			passCount: this.passCount,
			activeSessions: this.map(this.stats).size,
			pendingRetries: this.map(this.retryCount).size,
			recentAlerts: (this.alertLog ?? []).slice(-10),
			compressSaved: this.compressSaved,
			compressSamples: this.compressSamples,
		}
	}

	/**
	 * One session's observability bundle: health snapshot + scheduler stats +
	 * recent capability-match decisions. `decisionLog` keeps the last 20 per
	 * session; `limit` truncates further.
	 * @param rootId - Team root session id.
	 * @param limit - max decision entries (tail-most).
	 */
	decisionSnapshot(rootId: string, limit = 20): Record<string, unknown> {
		const dl = this.map(this.decisionLog).get(rootId) ?? []
		/* health.recentAlerts 是跨全部 session 的全局告警——只透出当前 rootId
		 * 相关条目，避免 status 响应混入无关 session 的历史 timeout；healthCheck()
		 * 本身保留全局口径供运维面使用。stats 补 scope 标注 per-session 口径，
		 * 与 metrics.counters(process-lifetime) 区分。 */
		return {
			health: { ...this.healthCheck(), recentAlerts: (this.alertLog ?? []).filter((a) => a.sessionId === rootId).slice(-10) },
			stats: { ...this.getStats(rootId), scope: 'session' },
			decisions: dl.slice(-Math.max(0, limit)),
		}
	}

	/** Serialize one session's passes; concurrent events coalesce into one re-run. */
	private async schedulePass(session: unknown): Promise<void> {
		const sid = (session as { id?: string } | undefined)?.id
		if (sid === undefined) return
		if (this.tails.has(sid)) {
			/* A pass is already queued or running. Rather than queueing a second one
			 * (which would see the same state and send a duplicate wake), mark that a
			 * coalesced re-run is needed after the current one finishes. */
			this.map(this.coalescePending).set(sid, true)
			return
		}
		const run = Promise.resolve().then(() => this.runPass(session))
		const tail = run.then(
			() => undefined,
			() => undefined,
		)
		this.tails.set(sid, tail)
		try {
			await run
		} finally {
			if (this.tails.get(sid) === tail) this.tails.delete(sid)
			/* New events during the pass fold into ONE coalesced re-run, so the
			 * effective bound is "at most 2 passes per burst". */
			if (this.map(this.coalescePending).delete(sid)) {
				this.schedulePass(session).catch((error: unknown) => {
					this.ctx.logger?.warn?.(`team scheduler coalesced pass failed: ${message(error)}`)
				})
			}
		}
	}

	/** Sort tasks by priority when enabled — high first. */
	private sortByPriority<T extends TeamTaskSnapshot>(tasks: readonly T[]): T[] {
		if (!this.config.priority) return [...tasks]
		return [...tasks].sort((a, b) => (PRIORITY_ORDER[a.priority ?? ''] ?? 1) - (PRIORITY_ORDER[b.priority ?? ''] ?? 1))
	}

	/** Build the load-balance summary string, or undefined when disabled/empty. */
	private buildLoadInfo(state: TeamRawState, rootId: string): string | undefined {
		if (!this.config.loadBalance) return undefined
		const tasks = state.tasks ?? []
		const members = state.members ?? []
		// O(T) pre-count, then O(M) assembly.
		const inProgressByOwner = new Map<string, number>()
		for (const t of tasks) {
			if (t.status !== 'in_progress' || t.ownerId === undefined) continue
			inProgressByOwner.set(t.ownerId, (inProgressByOwner.get(t.ownerId) ?? 0) + 1)
		}
		const lines: string[] = []
		for (const member of members) {
			if (String(member.id) === rootId) continue
			// Failed/released members no longer count toward load.
			if (member.phase === 'failed' || member.phase === 'released') continue
			lines.push(`${member.name}: ${inProgressByOwner.get(String(member.id)) ?? 0} 个进行中任务`)
		}
		if (lines.length === 0) return undefined
		return `📊 当前负载：${lines.join(' | ')}`
	}

	/**
	 * Capability match: compare the task text's capability keywords against each
	 * teammate's description and pick the top 2 as dispatch suggestions.
	 * @param task - the task.
	 * @param state - Team state (members carry description/name).
	 * @param rootId - the Lead's id.
	 * @returns display suggestions (top-2), the top-1 name, and the cold-start flag.
	 */
	private buildCapabilityHint(task: TeamTaskSnapshot, state: TeamRawState, rootId: string): { suggestions: string[]; topName?: string; coldStart: boolean } | undefined {
		if (!this.config.capabilityMatch) return undefined
		const taskText = `${task.subject ?? ''} ${task.description ?? ''}`
		const wanted = extractCapabilities(taskText)
		const specificWanted = new Set([...wanted].filter((kw) => !GENERIC_SET.has(kw.toLowerCase())))
		// A purely generic task yields no hint — every member scores 0 and perfBonus
		// alone would let members with records dominate newcomers.
		if (specificWanted.size === 0) return undefined
		const taskTag = inferCapabilityTag(taskText)
		const scored: { name: string; hits: string[]; kwScore: number; score: number; perfNote: string; isColdStart: boolean; perfBonus: number }[] = []
		for (const member of state.members ?? []) {
			if (String(member.id) === rootId) continue
			if (member.phase === 'failed' || member.phase === 'released') continue
			const caps = extractCapabilities(member.description)
			// hits holds SPECIFIC keywords only — GENERIC matches carry no discriminative power.
			const hits = [...specificWanted].filter((kw) => caps.has(kw))
			if (hits.length === 0) continue
			const kwScore = hits.length
			const perf = this.map(this.perfMap).get(String(member.id))
			let perfBonus = 0
			let perfNote = ''
			const totalCompleted = perf?.completed ?? 0
			const totalTimeouts = perf?.timeouts ?? 0
			const isColdStart = perf === undefined || (totalCompleted === 0 && totalTimeouts === 0)
			// Query the task's tag bucket, falling back to the total bucket. `byCapability`
			// may be absent on a restored or hand-built entry.
			const buckets = perf?.byCapability ?? new Map<string, { completed: number; timeouts: number }>()
			const bucket = taskTag !== undefined && buckets.has(taskTag) ? buckets.get(taskTag) : perf
			const bucketCompleted = bucket?.completed ?? totalCompleted
			const bucketTimeouts = bucket?.timeouts ?? totalTimeouts
			const bucketTrials = bucketCompleted + bucketTimeouts
			const noCategoryData = taskTag !== undefined && perf !== undefined && !buckets.has(taskTag)
			if (isColdStart) {
				// No data at all — label it rather than showing a misleading neutral 0.5.
				perfNote = '❄️冷启动（首次执行）'
				perfBonus = 0
			} else if (bucketTrials > 0 && perf !== undefined) {
				const relevantDone = [...specificWanted].filter((kw) => perf.capabilities.has(kw)).length
				const reliability = wilsonLowerBound(bucketCompleted, bucketTrials)
				const betaReliability = (bucketCompleted + RELIABILITY_PRIOR_SUCCESS) / (bucketCompleted + bucketTimeouts + RELIABILITY_PRIOR_TRIALS)
				perfBonus = Math.max(0, Math.min(relevantDone * PERF_BONUS_PER_RELEVANT * reliability, kwScore))
				if (bucketTimeouts > 0) perfNote = `⚠️超时×${bucketTimeouts} `
				if (relevantDone > 0) {
					perfNote += `✅${taskTag ?? '总'}领域重叠×${relevantDone}` + `(Wilson${Math.round(reliability * 100)}%|Beta${Math.round(betaReliability * 100)}%)`
					if (noCategoryData) perfNote += `[无${taskTag}记录]`
					perfNote += ' '
				}
			} else if (bucketTimeouts > 0) {
				// Timeouts with no completions — a penalty. Negative perfBonus is
				// intentional: timeout records must be able to lower a match score.
				perfBonus = Math.max(-TIMEOUT_PENALTY_FACTOR * bucketTimeouts, -kwScore)
				perfNote = `⚠️超时×${bucketTimeouts} `
			}
			// Negative feedback from dispatch failures, with a TTL so one-off jitter
			// does not permanently stain a member's profile.
			const dispatchEntry = this.map(this.dispatchFailures).get(String(member.id))
			const dispatchFails = dispatchEntry === undefined ? 0 : Date.now() - dispatchEntry.ts < DISPATCH_FAIL_TTL_MS ? dispatchEntry.count : 0
			if (dispatchFails > 0) {
				const dispatchPenalty = Math.max(-TIMEOUT_PENALTY_FACTOR * dispatchFails, -kwScore)
				perfBonus = Math.max(perfBonus + dispatchPenalty, -kwScore)
				perfNote += `⚠️派发失败×${dispatchFails} `
			}
			scored.push({ name: member.name, hits, kwScore, score: kwScore * 2 + perfBonus, perfNote, isColdStart, perfBonus })
		}
		if (scored.length === 0) return undefined
		scored.sort((a, b) => b.score - a.score)
		// Decision audit trail — the full scored array, so "why X and not Y" is answerable.
		const log = this.decisionLog ?? new Map<string, DecisionEntry[]>()
		const dl = log.get(rootId) ?? []
		dl.push({
			taskId: task.id,
			scored: scored.map((s) => ({ name: s.name, hits: s.hits, kwScore: s.kwScore, perfBonus: s.perfBonus, score: s.score, coldStart: s.isColdStart })),
			timestamp: Date.now(),
		})
		if (dl.length > 20) dl.shift()
		log.set(rootId, dl)
		const top = scored[0]
		return {
			suggestions: scored.slice(0, 2).map((s) => `${s.perfNote}${s.name}（具备 ${s.hits.join('、')}）`),
			topName: top?.name,
			coldStart: top !== undefined && scored.every((s) => s.isColdStart),
		}
	}

	/**
	 * Lesson collection: scan completed tasks and pool an explicit `lesson`
	 * field or a 「经验：/教训：/LESSON:」 line from the description.
	 *
	 * Not gated by capabilityMatch — collection/persistence always run, only
	 * injection is gated, so a learnedHints-only config still has data.
	 */
	private collectLessons(state: TeamRawState, tasks: readonly TeamTaskSnapshot[], rootId: string): void {
		for (const task of tasks) {
			if (task.status !== 'completed') continue
			// Revision-level dedupe: one completed state is collected once; reopen
			// then complete again (revision changed) may be re-collected.
			const key = `${rootId}:${task.id}:${task.revision ?? -1}`
			if (this.set(this.lessonSeen).has(key)) continue
			this.set(this.lessonSeen).add(key)
			let text: string | undefined
			if (typeof task.lesson === 'string' && task.lesson.trim() !== '') {
				text = task.lesson.trim()
			} else {
				const match = LESSON_LINE_RE.exec(task.description ?? '')
				text = match?.[1]?.trim()
				if (text !== undefined && text.length > LESSON_TEXT_MAX) text = `${text.slice(0, LESSON_TEXT_MAX)}…`
			}
			if (text === undefined || text === '') continue
			// No keyword hit → the "general" fallback bucket, otherwise keyword-less
			// tasks would never enter the pool.
			const tag = inferCapabilityTag(`${task.subject ?? ''} ${task.description ?? ''}`) ?? 'general'
			const from =
				task.ownerId === undefined || String(task.ownerId) === rootId
					? task.ownerId === undefined
						? 'unknown'
						: 'lead'
					: (state.members ?? []).find((m) => m.id === task.ownerId)?.name ?? 'unknown'
			// Source-task keywords are stored so injection can drop lessons whose
			// domain does not overlap the dispatched task — tag bucketing alone
			// matched whole categories (e.g. any "code" task) and produced noise.
			const caps = extractCapabilities(`${task.subject ?? ''} ${task.description ?? ''}`)
			this.addLesson(tag, { text, from, taskId: task.id, caps: [...caps] })
			this.map(this.perfDirty).set(rootId, true)
		}
	}

	/** Append one lesson to a tag bucket: identical text dedupes, oldest evicted past the cap. */
	private addLesson(tag: string, entry: Omit<LessonEntry, 'ts'>): void {
		const list = this.map(this.lessonsByTag).get(tag) ?? []
		if (list.some((l) => l.text === entry.text)) return
		list.push({ text: entry.text, from: entry.from, taskId: entry.taskId, ts: Date.now(), caps: entry.caps })
		while (list.length > LESSON_MAX_PER_TAG) list.shift()
		this.map(this.lessonsByTag).set(tag, list)
	}

	/**
	 * Lesson injection text: when learnedHints is on and this task's tag has
	 * lessons, the 「📚 经验提示」 block appended to wake/steer messages.
	 * @param task - the task being dispatched or assigned.
	 * @returns a directly concatenable fragment (leading newline included) or ''.
	 */
	private buildLessonsHint(task: TeamTaskSnapshot): string {
		if (this.config.learnedHints !== true) return ''
		// Symmetry with collection: same "general" fallback, otherwise the bucket is
		// write-only and never injected.
		const tag = inferCapabilityTag(`${task.subject ?? ''} ${task.description ?? ''}`) ?? 'general'
		const list = this.map(this.lessonsByTag).get(tag)
		if (list === undefined || list.length === 0) return ''
		/* Relevance filter: same tag still spans whole capability categories, so a
		 * wake used to carry every pooled lesson — including ones from unrelated
		 * domains. Keep only lessons whose source-task keywords overlap this
		 * task's. Pass-through: lessons with no recorded caps (persisted before
		 * the field existed), and the keyword-less "general" bucket (an empty
		 * task-caps set would otherwise filter every lesson out). */
		const taskCaps = extractCapabilities(`${task.subject ?? ''} ${task.description ?? ''}`)
		const relevant =
			taskCaps.size === 0 ? list : list.filter((l) => l.caps === undefined || l.caps.some((cap) => taskCaps.has(cap)))
		if (relevant.length === 0) return ''
		return `\n📚 经验提示（历史同类任务）：\n${relevant.map((l) => `- ${l.from}: ${l.text}`).join('\n')}`
	}

	/**
	 * Injection compression: when compressInject is on and the description's
	 * estimated length exceeds `compressBriefMax`, return the
	 * `\n任务骨架：...` fragment and account the before/after delta.
	 * @param task - the task being dispatched or assigned.
	 * @returns a directly concatenable fragment (leading newline included) or ''.
	 */
	private briefText(task: TeamTaskSnapshot): string {
		if (this.config.compressInject !== true) return ''
		const description = task?.description
		if (typeof description !== 'string' || description === '') return ''
		if (estimateTokens(description) <= this.config.compressBriefMax) return ''
		const r = compressTaskBrief(description, { max: this.config.compressBriefMax })
		this.compressSaved = (this.compressSaved ?? 0) + r.before - r.after
		this.compressSamples = (this.compressSamples ?? 0) + 1
		return `\n任务骨架：${r.text}`
	}

	/**
	 * Timeout detection: alert the Lead about in_progress tasks older than
	 * `timeoutMs`.
	 * @returns how many timeout alerts this pass emitted (for the pass summary).
	 */
	private checkTimeouts(state: TeamRawState, rootId: string, leadAgent: { steer(input: unknown): void }): number {
		if (!this.config.timeoutDetection) return 0
		const tasks = state.tasks ?? []
		const now = Date.now()
		const prefix = `${rootId}:`
		let alerts = 0
		for (const task of tasks) {
			// The key includes ownerId — a reassign restarts the clock for the new owner.
			const key = `${prefix}${task.id}:${task.ownerId ?? 'unassigned'}`
			if (task.status === 'in_progress' && task.ownerId !== undefined) {
				if (!this.map(this.inProgressSince).has(key)) {
					this.map(this.inProgressSince).set(key, now)
					continue
				}
				const elapsed = now - (this.map(this.inProgressSince).get(key) ?? now)
				const prevAlert = this.map(this.timeoutNotified).get(key)
				const shouldAlert = prevAlert === undefined || (this.config.timeoutAlertIntervalMs > 0 && now - prevAlert.ts >= this.config.timeoutAlertIntervalMs)
				if (elapsed >= this.config.timeoutMs && shouldAlert) {
					const alertCount = (prevAlert?.count ?? 0) + 1
					this.map(this.timeoutNotified).set(key, { count: alertCount, ts: now })
					const elapsedMin = Math.round(elapsed / 60000)
					const ownerName =
						String(task.ownerId) === rootId ? 'lead' : (state.members ?? []).find((m) => m.id === task.ownerId)?.name ?? '未知'
					try {
						leadAgent.steer(
							createUserMessage({
								content: [{ type: 'text', text: TIMEOUT_MESSAGE(task, elapsedMin, ownerName, alertCount) }],
								source: { kind: 'team-scheduler', taskId: task.id, alert: 'timeout' },
							}),
						)
						alerts++
						this.recordAlert(rootId, 'timeout', task.id, task.ownerId)
						this.ctx.logger?.info?.(`team scheduler: timeout alert for task ${task.id} (${elapsedMin}min, owner=${ownerName}, alert#${alertCount})`)
					} catch (error) {
						if (prevAlert === undefined) this.map(this.inProgressSince).delete(key)
						else this.map(this.timeoutNotified).set(key, prevAlert)
						this.ctx.logger?.warn?.(`team scheduler: timeout notification for ${task.id} failed: ${message(error)}`)
					}
				}
			} else {
				// No longer in_progress — clean up ALL tracking for this taskId
				// regardless of ownerId suffix; prefix matching is the reliable delete.
				const taskPrefix = `${prefix}${task.id}:`
				for (const k of this.map(this.inProgressSince).keys()) {
					if (k.startsWith(taskPrefix)) this.map(this.inProgressSince).delete(k)
				}
				for (const k of this.map(this.timeoutNotified).keys()) {
					if (k.startsWith(taskPrefix)) this.map(this.timeoutNotified).delete(k)
				}
			}
		}
		return alerts
	}

	/**
	 * Consume one agent/assistant-stream frame: chunks accumulate, end settles
	 * one complete text.
	 * @param agent - the emitting agent (carries session).
	 * @param frame - {type:'start'|'chunk'|'end', chunk?, ...}.
	 */
	private observeAssistantStream(agent: unknown, frame: unknown): void {
		const session = (agent as { session?: { id?: string } } | undefined)?.session
		if (session === undefined || frame === undefined) return
		const sid = String(session.id)
		const typed = frame as { type?: string; chunk?: unknown }
		if (typed.type === 'start') {
			this.map(this.streamBuffers).set(sid, '')
			return
		}
		if (typed.type === 'chunk') {
			// The visible text delta is {type:'text-delta', text}; reasoning-delta is
			// internal and tool/usage frames are structured events — none count as
			// repeated output. Legacy {type:'text'|'output_text'} and bare text blocks
			// are also accepted.
			const c = typed.chunk
			const piece =
				typeof c === 'string'
					? c
					: (c as { type?: string; text?: string; content?: string } | undefined)?.type === 'text-delta' ||
							(c as { type?: string } | undefined)?.type === 'text' ||
							(c as { type?: string } | undefined)?.type === 'output_text'
						? ((c as { text?: string }).text ?? '')
						: ((c as { type?: string } | undefined)?.type === undefined ? ((c as { text?: string; content?: string }).text ?? (c as { content?: string }).content ?? '') : '')
			if (piece === '') return
			this.map(this.streamBuffers).set(sid, (this.map(this.streamBuffers).get(sid) ?? '') + piece)
			return
		}
		if (typed.type !== 'end') return
		const text = (this.map(this.streamBuffers).get(sid) ?? '').trim()
		this.map(this.streamBuffers).delete(sid)
		// Empty or tool-only turns have nothing to compare — skipping also avoids
		// counting "the model only called tools" as repetition.
		if (text === '') return
		const buf = this.map(this.recentOutputs).get(sid) ?? []
		buf.push(text.slice(0, REPEAT_TEXT_MAX))
		if (buf.length > REPEAT_MAX_BUFFER) buf.shift()
		this.map(this.recentOutputs).set(sid, buf)
		this.checkRepeat(agent, buf)
	}

	/**
	 * Consecutive REPEAT_WINDOW outputs whose pairwise n-gram Jaccard similarity
	 * all exceed the threshold → interrupt the current turn + inject a nudge.
	 *
	 * Two modes:
	 * - `repeatInterrupt: true` (default): `agent.cancel({kind:'hook'}, {keepInbox:true})`
	 *   truncates the current turn, then steers the nudge.
	 * - `repeatInterrupt: false`: steer only (the older soft reminder).
	 *
	 * Why the immediate steer is not lost: `send`'s contract is that "waking
	 * input submitted after active cancellation is queued for the next turn and
	 * runs when the aborted activity converges to idle". `keepInbox: true` keeps
	 * queued user input from being dropped.
	 * @param agent - the Agent to correct (a DSH Session has neither steer nor cancel).
	 * @param buf - the session's recentOutputs ring.
	 */
	private checkRepeat(agent: unknown, buf: readonly string[]): void {
		const window = this.config.repeatWindow
		if (buf.length < window) return
		const sid = String((agent as { session?: { id?: string } }).session?.id)
		const tail = buf.slice(-window)
		// Any non-similar adjacent pair means this is not a repeat segment.
		for (let i = 1; i < tail.length; i++) {
			if (this.ngramJaccard(tail[i - 1], tail[i]) <= this.config.repeatThreshold) {
				this.map(this.repeatNudged).delete(sid)
				return
			}
		}
		// One nudge per segment — otherwise the nudge's own output re-triggers a storm.
		if (this.map(this.repeatNudged).get(sid)) return
		try {
			const live = agent as { steer?: (input: unknown) => void; cancel?: (cause: unknown, options?: unknown) => void; status?: string }
			const canSteer = typeof live.steer === 'function'
			const canCancel = typeof live.cancel === 'function'
			if (!canSteer && !canCancel) return
			// cancel on an idle agent is a no-op that arms nothing, so check running first.
			const interrupted = this.config.repeatInterrupt && canCancel && live.status === 'running'
			if (interrupted) live.cancel({ kind: 'hook', reason: 'repeat-output' }, { keepInbox: true })
			if (canSteer) {
				live.steer(
					createUserMessage({
						content: [{ type: 'text', text: REPEAT_NUDGE }],
						source: { kind: 'team-scheduler', alert: 'repeat-output' },
					}),
				)
			}
			this.map(this.repeatNudged).set(sid, true)
			this.ctx.logger?.warn?.(
				`team scheduler: repeat-output ${interrupted ? 'interrupt' : 'nudge'} on ${sid} — last ${window} outputs >${this.config.repeatThreshold} similar`,
			)
		} catch (error) {
			this.ctx.logger?.warn?.(`team scheduler: repeat ${sid} handling failed: ${message(error)}`)
		}
	}

	/**
	 * Character n-gram Jaccard similarity (0..1). 8-gram catches whole-segment
	 * repetition without being fooled by a shared local word.
	 */
	private ngramJaccard(a: string, b: string): number {
		if (a.length === 0 || b.length === 0) return 0
		if (a === b) return 1
		const n = 8
		const grams = (s: string): Set<string> => {
			const set = new Set<string>()
			for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n))
			return set
		}
		const A = grams(a)
		const B = grams(b)
		if (A.size === 0 || B.size === 0) return 0
		let inter = 0
		for (const g of A) if (B.has(g)) inter++
		return inter / (A.size + B.size - inter)
	}

	/**
	 * Compute a stable "is the team still moving" signature: tasks
	 * (id:status:revision:ownerId) + members (id:phase) + mailbox pending count.
	 * Any field change resets the timer.
	 */
	private stallSignature(state: TeamRawState): string {
		const tasks = (state.tasks ?? []).map((t) => `${t.id}:${t.status}:${t.revision ?? -1}:${t.ownerId ?? '-'}`).join(',')
		const members = (state.members ?? []).map((m) => `${m.id}:${m.phase}`).join(',')
		const pending = (state.messages?.length ?? 0) - (state.delivered?.length ?? 0)
		return `${tasks}|${members}|mbx:${pending}`
	}

	/**
	 * Stall-detection tick: walk every root session, re-read agentTeam state and
	 * run checkStall. runPass only fires on events, so an unchanged signature
	 * needs this interval to be detectable at all.
	 */
	private stallTick(): void {
		// stallTrack keyed by sid is only touched on the checkStall path — prune
		// entries whose root is gone, same discipline as inProgressSince.
		const liveSids = new Set<string>()
		for (const agent of this.ctx.agents.roots()) {
			const session = (agent as { session?: { id?: string } } | undefined)?.session
			if (session !== undefined) liveSids.add(String(session.id))
			try {
				this.checkStall(session)
			} catch (error) {
				this.ctx.logger?.warn?.(`team scheduler stall check failed on ${session?.id}: ${message(error)}`)
			}
		}
		for (const sid of this.map(this.stallTrack).keys()) {
			if (!liveSids.has(sid)) this.map(this.stallTrack).delete(sid)
		}
	}

	/**
	 * One stall verdict for a session: compare the current signature against the
	 * recorded one. A changed signature resets the timer; an unchanged one past
	 * `stallThresholdMs` with unfinished tasks steers the Lead once.
	 * @param session - the Session to check.
	 */
	private checkStall(session: unknown): void {
		if (session === undefined) return
		const state = this.ctx.sessionProjections?.stateOf(session, 'agentTeam')
		if (state === undefined || state.failure !== undefined) return
		const sid = String((session as { id?: string }).id)
		const now = Date.now()
		const openTasks = (state.tasks ?? []).filter((t) => t.status === 'pending' || t.status === 'in_progress')
		// No unfinished task means the team finished, not stalled — drop the record.
		if (openTasks.length === 0) {
			this.map(this.stallTrack).delete(sid)
			return
		}
		const sig = this.stallSignature(state)
		const prev = this.map(this.stallTrack).get(sid)
		if (prev === undefined || prev.sig !== sig) {
			this.map(this.stallTrack).set(sid, { sig, since: now, alerted: false })
			return
		}
		if (prev.alerted) return
		const elapsed = now - prev.since
		if (elapsed < this.config.stallThresholdMs) return
		// Signature heartbeat gap: the signature covers only tasks/members/mailbox, so
		// a teammate silently working (reading files, running commands) changes none
		// of them. A running active member proves the team is still progressing.
		const anyRunning = (state.members ?? []).some((m) => m.phase === 'active' && this.ctx.agents.get(String(m.id))?.status === 'running')
		if (anyRunning) {
			prev.since = now
			return
		}
		const leadAgent = this.ctx.agents.get(String(state.id))
		if (leadAgent === undefined) return
		const stalledMin = Math.round(elapsed / 60000)
		try {
			leadAgent.steer(
				createUserMessage({
					content: [{ type: 'text', text: STALLED_MESSAGE(stalledMin, openTasks.length) }],
					source: { kind: 'team-scheduler', alert: 'stalled' },
				}),
			)
			prev.alerted = true
			this.ctx.logger?.warn?.(`team scheduler: STALLED alert on ${sid} — signature unchanged for ${stalledMin}min with ${openTasks.length} open task(s)`)
		} catch (error) {
			this.ctx.logger?.warn?.(`team scheduler: stalled steer for ${sid} failed: ${message(error)}`)
		}
	}

	/**
	 * Retry accounting after a failed owner wake: accumulate the notifyKey's
	 * retry count and steer the Lead one exhaustion alert.
	 */
	private recordDispatchFailure(
		leadAgent: { steer(input: unknown): void },
		task: TeamTaskSnapshot,
		notifyKey: string,
		retryOwner: string,
		rootId: string,
		lastError?: string,
	): void {
		if (this.config.retryLimit <= 0) return
		this.noteDispatchFailure(task.ownerId, rootId)
		const used = this.map(this.retryCount).get(notifyKey) ?? 0
		if (used < this.config.retryLimit) {
			this.map(this.retryCount).set(notifyKey, used + 1)
			if (lastError !== undefined) this.map(this.retryLastError).set(notifyKey, lastError)
			this.ctx.logger?.info?.(`team scheduler: will retry dispatch for ${task.id} (attempt ${used + 1}/${this.config.retryLimit})`)
		} else if (!this.map(this.retryExhausted).get(notifyKey)) {
			this.map(this.retryExhausted).set(notifyKey, true)
			try {
				leadAgent.steer(
					createUserMessage({
						content: [{ type: 'text', text: RETRY_EXHAUSTED_MESSAGE(task, retryOwner) }],
						source: { kind: 'team-scheduler', taskId: task.id, alert: 'retry-exhausted' },
					}),
				)
				this.recordAlert(rootId, 'retry-exhausted', task.id, task.ownerId)
				this.ctx.logger?.warn?.(`team scheduler: dispatch retries exhausted for ${task.id} (owner=${retryOwner})`)
			} catch (steerError) {
				this.map(this.retryExhausted).delete(notifyKey)
				this.ctx.logger?.warn?.(`team scheduler: retry-exhausted alert for ${task.id} failed: ${message(steerError)}`)
			}
		}
	}

	/**
	 * Owner-group retry accounting: each notifyKey still increments individually
	 * (per-task reassign/prune semantics), but the exhaustion alert fires once for
	 * the whole group — otherwise an owner with N tasks yields N duplicate alerts.
	 */
	private recordGroupDispatchFailure(
		leadAgent: { steer(input: unknown): void },
		group: { tasks: readonly TeamTaskSnapshot[]; keys: readonly string[] },
		ownerName: string,
		rootId: string,
		lastError?: string,
	): void {
		if (this.config.retryLimit <= 0) return
		const { tasks, keys } = group
		if (tasks.length === 0 || keys.length === 0) return
		this.noteDispatchFailure(tasks[0]?.ownerId, rootId)
		if (keys.every((key) => this.map(this.retryExhausted).get(key))) return
		let anyExhausted = false
		for (const key of keys) {
			const used = this.map(this.retryCount).get(key) ?? 0
			if (used < this.config.retryLimit) this.map(this.retryCount).set(key, used + 1)
			else anyExhausted = true
		}
		if (!anyExhausted) {
			this.ctx.logger?.info?.(`team scheduler: will retry dispatch for owner "${ownerName}" (${keys.length} task(s))`)
			return
		}
		if (lastError !== undefined) {
			for (const key of keys) this.map(this.retryLastError).set(key, lastError)
		}
		try {
			leadAgent.steer(
				createUserMessage({
					content: [{ type: 'text', text: RETRY_EXHAUSTED_GROUP_MESSAGE(tasks, ownerName) }],
					source: { kind: 'team-scheduler', taskId: tasks[0]?.id, alert: 'retry-exhausted' },
				}),
			)
			// Mark exhausted only after the steer succeeds, so a failed steer is retried.
			for (const key of keys) this.map(this.retryExhausted).set(key, true)
			this.recordAlert(rootId, 'retry-exhausted', tasks[0]?.id, tasks[0]?.ownerId)
			this.ctx.logger?.warn?.(`team scheduler: dispatch retries exhausted for owner "${ownerName}" (${tasks.length} task(s))`)
		} catch (steerError) {
			this.ctx.logger?.warn?.(`team scheduler: retry-exhausted alert for owner "${ownerName}" failed: ${message(steerError)}`)
		}
	}

	/**
	 * Record one dispatch failure against its owner's profile, both in memory and
	 * on the persisted perf entry (so a restart does not lose it).
	 */
	private noteDispatchFailure(ownerId: string | undefined, rootId: string): void {
		if (ownerId === undefined || String(ownerId) === rootId) return
		const mid = String(ownerId)
		const prev = this.map(this.dispatchFailures).get(mid)
		const next = { count: (prev?.count ?? 0) + 1, ts: Date.now() }
		this.map(this.dispatchFailures).set(mid, next)
		// Also write back to perfMap and mark dirty — otherwise savePerf serializes a
		// stale value and restart loses the runtime failure record.
		let perf = this.map(this.perfMap).get(mid)
		if (perf === undefined) {
			perf = { completed: 0, timeouts: 0, capabilities: new Set(), seen: new Set(), completedTaskIds: new Set(), byCapability: new Map(), lastDecayAt: Date.now() }
			this.map(this.perfMap).set(mid, perf)
		}
		perf.dispatchFailures = next
		this.map(this.perfDirty).set(rootId, true)
	}

	/** One scheduling pass over a session's board. */
	private async runPass(session: unknown): Promise<void> {
		const state = this.ctx.sessionProjections?.stateOf(session, 'agentTeam')
		if (state === undefined) return
		const sid = String((session as { id?: string }).id)
		if (state.failure !== undefined) {
			// A projection failure produces no task surface — warn once per session.
			if (!this.set(this.failureWarned).has(sid)) {
				this.set(this.failureWarned).add(sid)
				this.ctx.logger?.warn?.(`team scheduler: agentTeam projection failure on ${sid}: ${state.failure}`)
			}
			return
		}
		const tasks = state.tasks ?? []
		if (tasks.length === 0) return

		const leadAgent = this.findLead(state)
		if (leadAgent === undefined) return

		const rootId = String(state.id)
		const s = this.map(this.stats).get(sid) ?? { dispatched: 0, skipped: 0, orphan: 0, timeoutAlerts: 0, retryExhausted: 0, passes: 0 }
		s.passes++
		this.map(this.stats).set(sid, s)
		this.passCount = (this.passCount ?? 0) + 1
		this.lastPassAt = Date.now()

		// perfMap lazy-load once per session. learnedHints also needs it — lessons
		// persist in the same file, so gating on capabilityMatch alone would lose the
		// pool under a learnedHints-only config.
		if (this.config.capabilityMatch || this.config.learnedHints) this.loadPerf(rootId)

		const timeoutAlerts = this.checkTimeouts(state, rootId, leadAgent)
		const loadInfo = this.buildLoadInfo(state, rootId)

		/* Raw journal state has no `ready`/`ownerName` — those are view-layer
		 * derivations. Reproduced here:
		 *   ready = status "pending" && every blockedBy task is completed
		 * Three dispatch paths:
		 *   a) pending + ready + owner   → a blocked task just became ready
		 *   b) in_progress + owner       → reassign set in_progress directly
		 *   c) pending + ready + no owner → steer the Lead to assign
		 * Owned wakes are coalesced per owner: collect everything dispatchable,
		 * then send ONE message per owner (fixes the one-message-per-task wake
		 * storm). The notify mark stays per task so reassign/prune are unchanged. */
		const sortedTasks = this.sortByPriority(tasks)
		this.collectPerf(state, sortedTasks, rootId)
		let actionableCount = 0
		let skippedCount = 0
		const ownerGroups = new Map<string, { ownerName: string; tasks: TeamTaskSnapshot[]; keys: string[] }>()
		const unassignedTasks: { task: TeamTaskSnapshot; key: string }[] = []
		const orphanTasks: { task: TeamTaskSnapshot; key: string; ownerName?: string; ownerPhase?: string }[] = []

		// O(T) pre-build so the per-task blockedBy check is O(B), not O(T×B).
		const statusById = new Map(tasks.map((task) => [task.id, task.status]))

		for (const task of sortedTasks) {
			const owned = task.ownerId !== undefined
			const readyNow = task.status === 'pending' && (task.blockedBy ?? []).every((blockerId) => statusById.get(blockerId) === 'completed')
			const assignedRunning = task.status === 'in_progress' && owned
			const needsDispatch = owned ? readyNow || assignedRunning : readyNow
			if (!needsDispatch) continue
			actionableCount++
			const ownerName =
				task.ownerId === undefined ? undefined : String(task.ownerId) === rootId ? 'lead' : (state.members ?? []).find((member) => member.id === task.ownerId)?.name
			const ownerPhase =
				task.ownerId === undefined || String(task.ownerId) === rootId ? undefined : (state.members ?? []).find((member) => member.id === task.ownerId)?.phase
			// released/failed members still appear in state.members, so a resolved name
			// is not proof of dispatchability — the phase must be checked too.
			const ownerGone = task.ownerId !== undefined && (ownerName === undefined || ownerPhase === 'released' || ownerPhase === 'failed')
			// Task ids restart per team, so the mark MUST be scoped by team id.
			const notifyKey = `${rootId}:${task.id}:${task.ownerId ?? 'unassigned'}`
			if (this.map(this.notified).get(notifyKey) === true) {
				skippedCount++
				continue
			}
			if (task.ownerId !== undefined) {
				if (ownerName === 'lead') {
					// Lead-owned tasks need no wake (the Lead sees the board) and
					// sendMessage to "lead" is a self-message error.
					this.map(this.notified).set(notifyKey, true)
					skippedCount++
					continue
				}
				if (ownerGone) {
					orphanTasks.push({ task, key: notifyKey, ownerName, ownerPhase })
					continue
				}
				const group = ownerGroups.get(task.ownerId)
				if (group === undefined) {
					ownerGroups.set(task.ownerId, { ownerName: ownerName!, tasks: [task], keys: [notifyKey] })
				} else {
					group.tasks.push(task)
					group.keys.push(notifyKey)
				}
			} else if (this.config.notifyUnassigned) {
				unassignedTasks.push({ task, key: notifyKey })
			} else {
				skippedCount++
			}
		}

		let dispatchedCount = 0

		for (const group of ownerGroups.values()) {
			const { ownerName, tasks: ownerTasks, keys } = group
			// All keys in a group share one dispatch failure — take the first's lastError.
			const lastError = this.map(this.retryLastError).get(keys[0])
			// Lessons: dedupe by tag within the group — same-owner same-tag tasks share
			// one pool, so repeating it adds no information.
			let lessonsText = ''
			if (this.config.learnedHints) {
				const hintedTags = new Set<string>()
				for (const task of ownerTasks) {
					const tag = inferCapabilityTag(`${task.subject ?? ''} ${task.description ?? ''}`) ?? 'general'
					if (hintedTags.has(tag)) continue
					hintedTags.add(tag)
					lessonsText += this.buildLessonsHint(task)
				}
			}
			// Compression is per task — a skeleton is task-specific, unlike lessons.
			let brief = ''
			if (this.config.compressInject) {
				for (const task of ownerTasks) brief += this.briefText(task)
			}
			const text = (ownerTasks.length === 1 ? NOTIFY_MESSAGE(ownerTasks[0], lastError) : NOTIFY_MESSAGE_MULTI(ownerTasks, lastError)) + lessonsText + brief
			try {
				/* Waking a teammate goes through sendMessage (durable mailbox queue +
				 * lease redelivery + dead-letter fallback) rather than the bare steer
				 * used for Lead alerts below. The two paths deliberately differ in
				 * failure semantics: a teammate wake must survive a crash, while a Lead
				 * alert is fire-and-forget. Failure accounting is identical for both. */
				await this.ctx.agentTeams.sendMessage(leadAgent, { target: ownerName, content: [{ type: 'text', text }], signal: AbortSignal.timeout(30_000) })
				for (const key of keys) {
					this.map(this.notified).set(key, true)
					this.map(this.retryCount).delete(key)
					this.map(this.retryExhausted).delete(key)
					this.map(this.retryLastError).delete(key)
				}
				dispatchedCount += ownerTasks.length
				this.ctx.logger?.info?.(`team scheduler: woke "${ownerName}" for ${ownerTasks.length} ready task(s): ${ownerTasks.map((t) => t.id).join(', ')}`)
			} catch (error) {
				this.ctx.logger?.warn?.(`team scheduler: dispatch to "${ownerName}" for ${ownerTasks.length} task(s) failed: ${message(error)}`)
				for (const key of keys) this.map(this.notified).delete(key)
				this.recordGroupDispatchFailure(leadAgent, { tasks: ownerTasks, keys }, ownerName, rootId, message(error))
			}
		}

		// Orphan tasks: the owner left the team → steer the Lead per task (the
		// notifyKey changes on owner change, so a new owner re-enters dispatch).
		let orphanCount = 0
		for (const { task, key, ownerName, ownerPhase } of orphanTasks) {
			this.map(this.notified).set(key, true)
			try {
				leadAgent.steer(
					createUserMessage({
						content: [{ type: 'text', text: ORPHAN_MESSAGE(task, ownerName, ownerPhase) }],
						source: { kind: 'team-scheduler', taskId: task.id, alert: 'orphan-owner' },
					}),
				)
				orphanCount++
				this.recordAlert(rootId, 'orphan', task.id, task.ownerId)
				this.ctx.logger?.info?.(`team scheduler: steered lead about orphaned task ${task.id} (owner gone)`)
			} catch (error) {
				this.map(this.notified).delete(key)
				this.ctx.logger?.warn?.(`team scheduler: orphan steer for ${task.id} failed: ${message(error)}`)
			}
		}

		// Unassigned tasks: steer the Lead per task (it needs per-task context to reassign).
		for (const { task, key } of unassignedTasks) {
			this.map(this.notified).set(key, true)
			try {
				const capability = this.buildCapabilityHint(task, state, rootId)
				const capabilityText = capability !== undefined && capability.suggestions.length > 0 ? CAPABILITY_HINT(task, capability.suggestions, capability.coldStart) : ''
				leadAgent.steer(
					createUserMessage({
						content: [{ type: 'text', text: UNASSIGNED_MESSAGE(task, loadInfo, capability?.topName) + capabilityText + this.buildLessonsHint(task) + this.briefText(task) }],
						source: { kind: 'team-scheduler', taskId: task.id },
					}),
				)
				this.map(this.retryCount).delete(key)
				this.map(this.retryExhausted).delete(key)
				dispatchedCount++
				this.ctx.logger?.info?.(`team scheduler: notified lead about unassigned ready task ${task.id}`)
			} catch (error) {
				this.map(this.notified).delete(key)
				this.ctx.logger?.warn?.(`team scheduler: dispatch for ${task.id} failed: ${message(error)}`)
				this.recordDispatchFailure(leadAgent, task, key, 'unassigned', rootId, message(error))
			}
		}

		// Prune marks for tasks no longer actionable on THIS team's board — must be
		// prefixed or other teams' marks (all share the task-N id space) would be
		// deleted. Marks live while the task is pending/in_progress.
		const prefix = `${rootId}:`
		const liveIds = new Set(
			tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress').map((task) => `${prefix}${task.id}:${task.ownerId ?? 'unassigned'}`),
		)
		// Single-pass collection of stale keys across the four maps — same predicate,
		// same maps, so behaviour is identical while saving three K traversals.
		const staleKeys: [Map<string, unknown>, string][] = []
		for (const map of [this.notified, this.retryCount, this.retryExhausted, this.retryLastError]) {
			for (const key of map.keys()) {
				if (key.startsWith(prefix) && !liveIds.has(key)) staleKeys.push([map, key])
			}
		}
		for (const [map, key] of staleKeys) map.delete(key)

		// Prune timeout tracking for tasks no longer on this board.
		const liveTaskIds = new Set(tasks.map((t) => `${prefix}${t.id}`))
		for (const key of this.map(this.inProgressSince).keys()) {
			if (!key.startsWith(prefix)) continue
			const taskId = key.slice(prefix.length).split(':')[0]
			if (!liveTaskIds.has(`${prefix}${taskId}`)) {
				this.map(this.inProgressSince).delete(key)
				this.map(this.timeoutNotified).delete(key)
			}
		}

		// Hard cap on the tracking maps — the live filters above already prevent most
		// growth, but deleted tasks or unusual paths can still leave residue.
		const MAX_TRACKED = 500
		for (const map of [this.notified, this.retryCount, this.retryExhausted, this.retryLastError, this.inProgressSince, this.timeoutNotified]) {
			if (map.size > MAX_TRACKED) {
				const excess = map.size - MAX_TRACKED
				let deleted = 0
				for (const key of map.keys()) {
					map.delete(key)
					if (++deleted >= excess) break
				}
			}
		}

		const cur = this.map(this.stats).get(sid)
		if (cur !== undefined) {
			cur.dispatched += dispatchedCount
			cur.skipped += skippedCount
		}

		// Log level: an empty pass (nothing actionable, no alerts, no timeouts) drops
		// to debug so a per-event log line cannot flood the output.
		const summary = `team scheduler pass on ${sid}: actionable=${actionableCount} dispatched=${dispatchedCount} skipped=${skippedCount} orphan=${orphanCount} timeoutAlerts=${timeoutAlerts}`
		if (actionableCount === 0 && dispatchedCount === 0 && timeoutAlerts === 0) this.ctx.logger?.debug?.(summary)
		else this.ctx.logger?.info?.(summary)

		this.savePerf(rootId)
	}

	/**
	 * Collect member performance from the current board, one scan per pass.
	 *
	 * completed → completed++ (task-level dedupe so a reopen does not double
	 * count), timeout → timeouts++ (per-task-per-owner dedupe). A deleted task
	 * contributes no completion, but its timeouts still count against the
	 * original owner so a Lead cannot whitewash a record with delete.
	 */
	private collectPerf(state: TeamRawState, tasks: readonly TeamTaskSnapshot[], rootId: string): void {
		this.collectLessons(state, tasks, rootId)
		if (!this.config.capabilityMatch) return
		// loadPerf already ran at the top of runPass (idempotent via perfLoaded).
		for (const task of tasks) {
			// rootId prefix: different sessions reuse task-1/task-2 ids, so without it
			// a previous session's revision would skip this session's collection.
			const revKey = `${rootId}:${task.id}`
			const lastRev = this.map(this.lastSeenRevision).get(revKey)
			const rev = task.revision ?? -1
			if (lastRev === rev) continue
			this.map(this.lastSeenRevision).set(revKey, rev)
			if (task.ownerId === undefined || String(task.ownerId) === rootId) continue
			if (task.status === 'deleted') continue
			const mid = String(task.ownerId)
			let perf = this.map(this.perfMap).get(mid)
			if (perf === undefined) {
				perf = { completed: 0, timeouts: 0, capabilities: new Set(), seen: new Set(), completedTaskIds: new Set(), byCapability: new Map(), lastDecayAt: Date.now() }
				this.map(this.perfMap).set(mid, perf)
			}
			if (task.status === 'completed') {
				// completedTaskIds is the durable dedupe: `seen` is truncated to 200
				// entries, so without it a reopened old task would double count.
				if (perf.completedTaskIds.has(task.id)) continue
				perf.completedTaskIds.add(task.id)
				perf.seen.add(`${task.id}:completed`)
				perf.completed++
				this.map(this.perfDirty).set(rootId, true)
				const caps = extractCapabilities(`${task.subject ?? ''} ${task.description ?? ''}`)
				for (const c of caps) perf.capabilities.add(c)
				const taskTag = inferCapabilityTag(`${task.subject ?? ''} ${task.description ?? ''}`)
				if (taskTag !== undefined) {
					const bucket = perf.byCapability.get(taskTag) ?? { completed: 0, timeouts: 0 }
					bucket.completed++
					perf.byCapability.set(taskTag, bucket)
				}
			}
		}
		// Prune lastSeenRevision for tasks that left the board.
		const liveTaskIds = new Set(tasks.map((t) => t.id))
		for (const key of this.map(this.lastSeenRevision).keys()) {
			if (!key.startsWith(`${rootId}:`)) continue
			const taskId = key.slice(rootId.length + 1)
			if (!liveTaskIds.has(taskId)) this.map(this.lastSeenRevision).delete(key)
		}
		for (const key of this.set(this.lessonSeen).keys()) {
			if (!key.startsWith(`${rootId}:`)) continue
			const taskId = key.slice(rootId.length + 1).split(':')[0]
			if (!liveTaskIds.has(taskId)) this.set(this.lessonSeen).delete(key)
		}
		// Timeout counting reads timeoutNotified directly (its key carries ownerId) so
		// a deleted task's timeout still lands on its original owner.
		for (const key of this.map(this.timeoutNotified).keys()) {
			if (!key.startsWith(`${rootId}:`)) continue
			const parts = key.slice(rootId.length + 1).split(':')
			const taskId = parts[0]
			const ownerId = parts[1]
			if (ownerId === undefined || ownerId === 'unassigned' || ownerId === rootId) continue
			let perf = this.map(this.perfMap).get(ownerId)
			if (perf === undefined) {
				perf = { completed: 0, timeouts: 0, capabilities: new Set(), seen: new Set(), completedTaskIds: new Set(), byCapability: new Map(), lastDecayAt: Date.now() }
				this.map(this.perfMap).set(ownerId, perf)
			}
			const timeoutKey = `${taskId}:${ownerId}:timeout`
			if (!perf.seen.has(timeoutKey)) {
				perf.seen.add(timeoutKey)
				perf.timeouts++
				this.map(this.perfDirty).set(rootId, true)
				const timedTask = tasks.find((t) => t.id === taskId)
				if (timedTask !== undefined) {
					const taskTag = inferCapabilityTag(`${timedTask.subject ?? ''} ${timedTask.description ?? ''}`)
					if (taskTag !== undefined) {
						const bucket = perf.byCapability.get(taskTag) ?? { completed: 0, timeouts: 0 }
						bucket.timeouts++
						perf.byCapability.set(taskTag, bucket)
					}
				}
			}
		}
		// Drop the performance of members who left the team.
		const liveMemberIds = new Set((state.members ?? []).filter((m) => m.phase !== 'released' && m.phase !== 'failed').map((m) => String(m.id)))
		for (const mid of this.map(this.perfMap).keys()) {
			if (!liveMemberIds.has(mid)) {
				this.map(this.perfMap).delete(mid)
				this.map(this.perfDirty).set(rootId, true)
			}
		}
		// Time decay: one exponential decay per member per day (half-life ~14 days).
		// completed and timeouts decay together so reliability stays meaningful.
		const now = Date.now()
		const DECAY_INTERVAL = 24 * 60 * 60 * 1000
		const DECAY_FACTOR = 0.95
		for (const perf of this.map(this.perfMap).values()) {
			// A missing lastDecayAt (old persisted file) is seeded with now rather than
			// treated as 1970, which would zero the history in one shot.
			if (perf.lastDecayAt === undefined || perf.lastDecayAt === 0) {
				perf.lastDecayAt = now
				continue
			}
			if (now - perf.lastDecayAt < DECAY_INTERVAL) continue
			const daysSinceLastDecay = (now - perf.lastDecayAt) / DECAY_INTERVAL
			const decay = Math.pow(DECAY_FACTOR, Math.floor(daysSinceLastDecay))
			// Floats are kept — rounding would freeze completed=1 for two weeks.
			perf.completed = Math.max(0, perf.completed * decay)
			perf.timeouts = Math.max(0, perf.timeouts * decay)
			for (const bucket of perf.byCapability.values()) {
				bucket.completed = Math.max(0, bucket.completed * decay)
				bucket.timeouts = Math.max(0, bucket.timeouts * decay)
			}
			perf.lastDecayAt = now
			this.map(this.perfDirty).set(rootId, true)
		}
	}

	/**
	 * Restore perfMap from disk (once per session).
	 * The file lives at sessions/{sessionId}.perf.json — same root as the journal,
	 * isolated per session. A parse failure degrades silently to an empty perfMap.
	 */
	private loadPerf(rootId: string): void {
		if (this.map(this.perfLoaded).has(rootId)) return
		this.map(this.perfLoaded).set(rootId, true)
		const file = this.perfPath(rootId)
		try {
			const raw = readFileSync(file, 'utf8')
			const data = JSON.parse(raw) as { version?: number; members?: Record<string, unknown>; lessons?: Record<string, unknown> }
			if (data?.version !== 1 || typeof data.members !== 'object' || data.members === null) return
			for (const [mid, rec] of Object.entries(data.members)) {
				if (typeof rec !== 'object' || rec === null) continue
				const r = rec as Record<string, unknown>
				const dispatchFailuresRaw = r.dispatchFailures
				const dispatchFailures =
					typeof dispatchFailuresRaw === 'object' && dispatchFailuresRaw !== null
						? { count: (dispatchFailuresRaw as { count?: number }).count ?? 0, ts: (dispatchFailuresRaw as { ts?: number }).ts ?? 0 }
						: { count: typeof dispatchFailuresRaw === 'number' ? dispatchFailuresRaw : 0, ts: 0 }
				const byCapability = new Map<string, { completed: number; timeouts: number }>()
				if (typeof r.byCapability === 'object' && r.byCapability !== null) {
					for (const [tag, bucket] of Object.entries(r.byCapability as Record<string, unknown>)) {
						if (typeof bucket === 'object' && bucket !== null) {
							byCapability.set(tag, {
								completed: (bucket as { completed?: number }).completed ?? 0,
								timeouts: (bucket as { timeouts?: number }).timeouts ?? 0,
							})
						}
					}
				}
				this.map(this.perfMap).set(mid, {
					completed: typeof r.completed === 'number' ? r.completed : 0,
					timeouts: typeof r.timeouts === 'number' ? r.timeouts : 0,
					capabilities: new Set(Array.isArray(r.capabilities) ? (r.capabilities as string[]) : []),
					// `seen` is truncated to 200 — a hand-edited oversized array is defended against.
					seen: new Set(Array.isArray(r.seen) ? (r.seen as string[]).slice(-200) : []),
					completedTaskIds: new Set(Array.isArray(r.completedTaskIds) ? (r.completedTaskIds as string[]) : []),
					dispatchFailures,
					lastDecayAt: typeof r.lastDecayAt === 'number' ? r.lastDecayAt : 0,
					byCapability,
				})
				// Mirror the persisted dispatch failures into the in-memory map — the two
				// used to be disconnected, so restart lost all negative feedback.
				const perfEntry = this.map(this.perfMap).get(mid)
				if (perfEntry?.dispatchFailures !== undefined && perfEntry.dispatchFailures.count > 0) {
					this.map(this.dispatchFailures).set(mid, perfEntry.dispatchFailures)
				}
			}
			if (typeof data.lessons === 'object' && data.lessons !== null) {
				for (const [tag, entries] of Object.entries(data.lessons)) {
					if (!Array.isArray(entries)) continue
					const list = this.map(this.lessonsByTag).get(tag) ?? []
					for (const entry of entries) {
						if (typeof entry !== 'object' || entry === null || typeof (entry as { text?: unknown }).text !== 'string') continue
						if (list.some((l) => l.text === (entry as { text: string }).text)) continue
						const capsRaw = (entry as { caps?: unknown }).caps
						list.push({
							text: (entry as { text: string }).text,
							from: typeof (entry as { from?: unknown }).from === 'string' ? (entry as { from: string }).from : 'unknown',
							taskId: typeof (entry as { taskId?: unknown }).taskId === 'string' ? (entry as { taskId: string }).taskId : '',
							ts: typeof (entry as { ts?: unknown }).ts === 'number' ? (entry as { ts: number }).ts : 0,
							caps: Array.isArray(capsRaw) ? capsRaw.filter((cap): cap is string => typeof cap === 'string') : undefined,
						})
					}
					while (list.length > LESSON_MAX_PER_TAG) list.shift()
					if (list.length > 0) this.map(this.lessonsByTag).set(tag, list)
				}
			}
			this.ctx.logger?.info?.(`team scheduler: restored perf for ${this.map(this.perfMap).size} member(s) from ${file}`)
		} catch {
			// Missing or corrupt file → empty perfMap, learn from scratch.
		}
	}

	/** Persist perfMap when dirty (`seen` truncated to the recent 200). */
	private savePerf(rootId: string): void {
		if (!this.map(this.perfDirty).get(rootId)) return
		const file = this.perfPath(rootId)
		try {
			const members: Record<string, unknown> = {}
			for (const [mid, perf] of this.map(this.perfMap)) {
				members[mid] = {
					completed: perf.completed,
					timeouts: perf.timeouts,
					capabilities: [...(perf.capabilities ?? [])],
					seen: [...(perf.seen ?? [])].slice(-200),
					completedTaskIds: [...(perf.completedTaskIds ?? [])],
					dispatchFailures: perf.dispatchFailures ?? { count: 0, ts: 0 },
					lastDecayAt: perf.lastDecayAt ?? 0,
					byCapability: Object.fromEntries(perf.byCapability ?? []),
				}
			}
			// The directory is derived from perfPath itself, so a redirected path
			// (tests, alternate DSH home) still lands in an existing directory.
			mkdirSync(dirname(file), { recursive: true })
			writeFileSync(file, JSON.stringify({ version: 1, members, lessons: Object.fromEntries(this.map(this.lessonsByTag)) }, null, '\t'), 'utf8')
			this.map(this.perfDirty).delete(rootId)
		} catch (error) {
			this.ctx.logger?.warn?.(`team scheduler: failed to persist perf: ${message(error)}`)
		}
	}

	/** sessions/{sessionId}.perf.json path. */
	private perfPath(rootId: string): string {
		return join(resolveDshHome(), 'sessions', `${rootId}.perf.json`)
	}

	/**
	 * Resolve the Lead agent for a Team. TeamId is the Lead's branded session/agent
	 * id, resolved directly the same way the mailbox does: if it resolves to a live
	 * agent at all, that agent IS this team's Lead — no extra identity check, since
	 * session refs may differ across attach/detach while the team id stays stable.
	 */
	private findLead(state: TeamRawState): { steer(input: unknown): void } | undefined {
		return this.ctx.agents.get(String(state.id))
	}
}

/** Render one unknown error for a log line. */
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** Cordis plugin name. */
export const name = 'team-scheduler'

/** Services required by the scheduler plugin. */
export const inject = ['agentTeams', 'agents', 'sessionProjections'] as const

/** Loader schema for the scheduler plugin. */
/**
 * Loader schema for the scheduler plugin.
 *
 * A plain resolver rather than a zod schema: every field is either a boolean
 * flag or a number with its own clamp, and the constructor is the single place
 * those defaults are applied — duplicating them in a schema would let the two
 * drift. `parse` is called by the host loader, not by the constructor.
 */
export const Config = {
	parse(value: unknown): Required<SchedulerConfig> {
		return resolveSchedulerConfig((value ?? {}) as SchedulerConfig)
	},
}
export default TeamScheduler
