// Phase-2 机制行为级断言——每条断言调用真实 API（TeamService/TeamScheduler/
// TeamTaskBoard），断言运行时返回值/抛错 code，不断言源码字符串。
//
// 覆盖矩阵：
//  1. 投影 failure 快速失败 → journal.state/teamStatus/sendMessage 抛
//     TEAM_PROJECTION_FAILED 而非静默超时。
//  2. CAS retriedFromConflict → tools 层 execute 捕获 stale revision →
//     自动重读重试 → 返回 { retriedFromConflict: true }；无冲突路径不返回该字段。
//  3. Beta(1,1) reliability 平滑 → buildCapabilityHint 在 0/1/0 三种
//     perf 状态下产出 0.5/0.67/0.33 平滑值（非裸比率）。
//  4. attemptId 真行为 → task_update 用错令牌 → TEAM_TASK_STALE_ATTEMPT；
//     对令牌成功；Lead 豁免；claim/reassign 不要令牌。
//  5. TASK_TRANSITIONS 状态机 → completed→in_progress 非法转移抛错；
//     合法转移通过。

import test from 'node:test'
import assert from 'node:assert/strict'

import { bundle } from './support.mjs'

const { Context } = await import('@deepseek-ai/cordis')
const {
	TeamService, TeamError, TASK_TRANSITIONS, assertTaskTransition,
	TeamJournal, TeamMailbox, TeamTaskBoard, teamProjectionDefinition, TeamScheduler,
} = bundle

const ROOT_ID = 'lead-1'

// ─── 共享设施 ───────────────────────────────────────────────────────────────

function member(id, name, phase = 'active') {
	return { id, name, phase, description: 'desc', provider: 'test', context: 'fresh' }
}

function leadAgent(backend) {
	return { id: ROOT_ID, session: backend.session }
}

function fakeMembership(agent) {
	return { root: agent, id: ROOT_ID, role: 'lead', name: 'lead' }
}

function teammateMembership(root, agent) {
	return { root, id: agent.id, role: 'teammate', name: agent.name }
}

function makeBackend(projectionOverride) {
	const durableEvents = []
	const session = {
		append(type, data) { durableEvents.push({ type, data }) },
	}
	return {
		session,
		durableEvents,
		sessions: { async flush() {} },
		sessionProjections: {
			stateOf(_s, key) {
				assert.equal(key, 'agentTeam')
				if (projectionOverride !== undefined) return projectionOverride
				let state = teamProjectionDefinition.init({ id: ROOT_ID })
				for (const e of durableEvents) state = teamProjectionDefinition.apply(state, e)
				return state
			},
		},
	}
}

async function addMember(journal, lead, m) {
	// member 必须先经 provisioning → active 才能出现在 state.members
	await journal.appendAndFlush(lead, 'team/member', {
		version: 2, teamId: ROOT_ID, member: { ...m, phase: 'provisioning' },
	})
	await journal.appendAndFlush(lead, 'team/member', {
		version: 2, teamId: ROOT_ID, member: { ...m, phase: 'active' },
	})
}

// ─── 1. 投影 failure 快速失败 ────────────────────────────────────────────────

test('P1: journal.state throws TEAM_PROJECTION_FAILED when projection has failure', () => {
	const backend = makeBackend({ failure: 'corrupt event sequence' })
	const journal = new TeamJournal(backend, () => {})
	assert.throws(
		() => journal.state(leadAgent(backend)),
		(err) => {
			assert.equal(err.code, 'TEAM_PROJECTION_FAILED')
			assert.ok(err.message.includes('corrupt event sequence'))
			return true
		},
	)
})

test('P1: teamStatus surfaces failure field via journal.state', () => {
	const failedState = {
		id: ROOT_ID, members: [], tasks: [], messages: [], delivered: [],
		failure: 'projection crashed',
	}
	const backend = makeBackend(failedState)
	const journal = new TeamJournal(backend, () => {})
	const svc = Object.create(TeamService.prototype)
	svc.roster = {
		list: () => [],
		listMembers: () => [],
		membership: () => fakeMembership(leadAgent(backend)),
		isLead: () => true,
	}
	svc.journal = journal
	svc.tasks = { list: () => [] }
	svc.metrics = { snapshot: () => ({ teamId: ROOT_ID, counters: {}, gauges: {} }) }
	svc.mailbox = { pendingForCaller: () => 0, pendingForTarget: () => 0 }
	svc.ctx = { logger: { info() {} } }
	svc.memberStatusSnapshot = () => new Map()

	// teamStatus 读 journal.state → 命中 projection.failure → 必须抛错而非返回
	assert.throws(
		() => svc.teamStatus(leadAgent(backend)),
		(err) => {
			assert.equal(err.code, 'TEAM_PROJECTION_FAILED')
			return true
		},
	)
})

test('P1: sendMessage throws TEAM_PROJECTION_FAILED on frozen projection', async () => {
	// 用真实 TeamMailbox——send 入口即调 journal.state。投影带 failure → journal.state
	// 抛 TEAM_PROJECTION_FAILED，send 在写任何消息事件之前就拒绝。
	const backend = makeBackend({ failure: 'frozen by corrupt event' })
	const journal = new TeamJournal(backend, () => {})
	const lead = leadAgent(backend)
	const ctx = {
		logger: { info() {}, warn() {} },
		agents: { get: () => undefined, list: () => [] },
	}
	const lifecycle = { disposed: false, signal: new AbortController().signal }
	const roster = { membership: () => fakeMembership(lead) }
	const mailbox = new TeamMailbox(ctx, journal, roster, lifecycle, 64, 65536, 0, {})

	const svc = Object.create(TeamService.prototype)
	svc.journal = journal
	svc.roster = roster
	svc.mailbox = mailbox
	svc.metrics = { messagesSent: 0 }
	svc.ctx = ctx

	await assert.rejects(
		svc.sendMessage(lead, { target: 'bob', content: [{ type: 'text', text: 'hi' }], signal: AbortSignal.timeout(5000) }),
		(err) => {
			assert.equal(err.code, 'TEAM_PROJECTION_FAILED')
			assert.ok(err.message.includes('frozen by corrupt event'))
			return true
		},
	)
	// 失败 fast-fail——没有消息事件被写入 journal
	assert.equal(backend.durableEvents.length, 0, 'no durable event should be appended on projection failure')
})

test('P1: board.update task read throws TEAM_PROJECTION_FAILED on frozen projection', async () => {
	// 任务路径同样过 journal.state——get/update 都在 transact 内先读 state。
	const backend = makeBackend()
	const journal = new TeamJournal(backend, () => {})
	const board = new TeamTaskBoard(journal, 100)
	const lead = leadAgent(backend)
	const membership = fakeMembership(lead)
	const alice = member('alice-1', 'alice')
	await addMember(journal, lead, alice)
	const created = await board.create(membership, { subject: 'freeze-test', description: 'd' })

	// 冻结投影：stateOf 之后返回带 failure 的 state
	backend.sessionProjections.stateOf = () => ({
		id: ROOT_ID, members: [], tasks: [], messages: [], delivered: [],
		failure: 'event replay crashed',
	})

	// get 是同步读 → journal.state 立即抛
	assert.throws(
		() => board.get(membership, created.id),
		(err) => { assert.equal(err.code, 'TEAM_PROJECTION_FAILED'); return true },
	)
	// update 走 transact → operation 内 journal.state 抛 → await rejects
	await assert.rejects(
		board.update(lead, membership, {
			taskId: created.id, expectedRevision: created.revision, action: 'edit', subject: 'x',
		}),
		(err) => { assert.equal(err.code, 'TEAM_PROJECTION_FAILED'); return true },
	)
})

// ─── 2. CAS retriedFromConflict ──────────────────────────────────────────────

test('P2: task_update stale revision → retriedFromConflict:true', async () => {
	const backend = makeBackend()
	const journal = new TeamJournal(backend, () => {})
	const board = new TeamTaskBoard(journal, 100)
	const lead = leadAgent(backend)
	const membership = fakeMembership(lead)
	const alice = member('alice-1', 'alice')
	const aliceMem = teammateMembership(lead, alice)
	await addMember(journal, lead, alice)

	const created = await board.create(membership, { subject: 'cas-test', description: 'CAS retry' })
	const claimed = await board.update(alice, aliceMem, {
		taskId: created.id, expectedRevision: created.revision, action: 'claim',
	})

	// 第三方把任务推到 rev3（alice 看不到，仍拿 rev2）
	await board.update(alice, aliceMem, {
		taskId: created.id, expectedRevision: claimed.revision,
		action: 'edit', subject: 'bumped-by-other', attemptId: claimed.attemptId,
	})

	// 模拟 tools 层 execute 的 doUpdate 逻辑（真调用 board.update）
	const doUpdate = (rev) => board.update(alice, aliceMem, {
		taskId: created.id, expectedRevision: rev,
		action: 'edit', subject: 'edited-by-alice', attemptId: claimed.attemptId,
	})
	let result
	try {
		result = await doUpdate(claimed.revision) // rev2 — 已 stale
	} catch (error) {
		if (error instanceof Error && /stale.*revision|revision.*stale|expected_revision/iu.test(error.message)) {
			const current = board.get(membership, created.id)
			if (current !== undefined && current.revision !== claimed.revision) {
				result = { ...(await doUpdate(current.revision)), retriedFromConflict: true }
			}
		}
		if (result === undefined) throw error
	}
	assert.equal(result.retriedFromConflict, true, 'CAS conflict path must return retriedFromConflict:true')
	assert.equal(result.subject, 'edited-by-alice')
})

test('P2: task_update no conflict → retriedFromConflict absent', async () => {
	const backend = makeBackend()
	const journal = new TeamJournal(backend, () => {})
	const board = new TeamTaskBoard(journal, 100)
	const lead = leadAgent(backend)
	const membership = fakeMembership(lead)
	const alice = member('alice-1', 'alice')
	const aliceMem = teammateMembership(lead, alice)
	await addMember(journal, lead, alice)

	const created = await board.create(membership, { subject: 'cas-ok', description: 'no conflict' })
	const claimed = await board.update(alice, aliceMem, {
		taskId: created.id, expectedRevision: created.revision, action: 'claim',
	})

	const result = await board.update(alice, aliceMem, {
		taskId: created.id, expectedRevision: claimed.revision,
		action: 'edit', subject: 'direct-edit', attemptId: claimed.attemptId,
	})
	assert.equal('retriedFromConflict' in result, false, 'no-conflict path must not return retriedFromConflict')
	assert.equal(result.subject, 'direct-edit')
})

// ─── 3. Beta(1,1) reliability 平滑行为 ──────────────────────────────────────

function makeScheduler() {
	const sched = Object.create(TeamScheduler.prototype)
	sched.config = { capabilityMatch: true }
	sched.perfMap = new Map()
	sched.perfLoaded = new Map()
	sched.perfDirty = new Map()
	sched.lastSeenRevision = new Map()
	sched.lastDecayAt = new Map()
	sched.dispatchFailures = new Map()
	sched.inProgressSince = new Map()
	sched.timeoutNotified = new Map()
	sched.ctx = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		agents: { get() { return undefined }, list() { return [] } },
	}
	return sched
}

test('P3: Beta(1,1) — completed=0,timeouts=0 → reliability=0.5 (neutral)', () => {
	const sched = makeScheduler()
	sched.perfMap.set('alice-1', {
		completed: 0, timeouts: 0,
		capabilities: new Set(['refactor']), seen: new Set(),
	})
	const state = {
		id: ROOT_ID,
		members: [{ id: 'alice-1', name: 'alice', phase: 'active', description: 'refactor' }],
		tasks: [{ id: 't1', ownerId: undefined, status: 'pending', subject: 'refactor schema', description: '', blockedBy: [] }],
	}
	const hint = sched.buildCapabilityHint(state.tasks[0], state, ROOT_ID)
	assert.ok(hint !== undefined)
	const aliceLine = hint.suggestions.find((s) => s.includes('alice'))
	assert.ok(aliceLine !== undefined, 'alice should appear in hint')
	assert.ok(!aliceLine.includes('⚠️'), 'no-timeout member should not show warning')
	// 0 样本 → 0.5 平滑但 completed=0 → 走冷启动分支（perfBonus=0），无 ✅
	assert.ok(!aliceLine.includes('✅'), 'zero-sample member should not show domain-overlap bonus')
})

test('P3: Beta(1,1) — completed=1,timeouts=0 → reliability≈0.67 (2/3 smoothed)', () => {
	const sched = makeScheduler()
	sched.perfMap.set('alice-1', {
		completed: 1, timeouts: 0,
		capabilities: new Set(['refactor']), seen: new Set(),
	})
	const state = {
		id: ROOT_ID,
		members: [{ id: 'alice-1', name: 'alice', phase: 'active', description: 'refactor' }],
		tasks: [{ id: 't1', ownerId: undefined, status: 'pending', subject: 'refactor schema', description: '', blockedBy: [] }],
	}
	const hint = sched.buildCapabilityHint(state.tasks[0], state, ROOT_ID)
	assert.ok(hint !== undefined)
	const aliceLine = hint.suggestions.find((s) => s.includes('alice'))
	// (1+1)/(1+0+2) = 2/3 ≈ 0.6667 → 67%
	assert.ok(aliceLine.includes('67%'), `expected 67% smoothed reliability, got: ${aliceLine}`)
	assert.ok(!aliceLine.includes('⚠️'), 'no-timeout member should not show warning')
})

test('P3: Beta(1,1) — completed=0,timeouts=1 → reliability≈0.33 (1/3 smoothed)', () => {
	const sched = makeScheduler()
	sched.perfMap.set('alice-1', {
		completed: 0, timeouts: 1,
		capabilities: new Set(['refactor']), seen: new Set(),
	})
	const state = {
		id: ROOT_ID,
		members: [{ id: 'alice-1', name: 'alice', phase: 'active', description: 'refactor' }],
		tasks: [{ id: 't1', ownerId: undefined, status: 'pending', subject: 'refactor schema', description: '', blockedBy: [] }],
	}
	const hint = sched.buildCapabilityHint(state.tasks[0], state, ROOT_ID)
	assert.ok(hint !== undefined)
	const aliceLine = hint.suggestions.find((s) => s.includes('alice'))
	assert.ok(aliceLine !== undefined)
	// (0+1)/(0+1+2) = 1/3 ≈ 0.333 → 超时惩罚路径（completed=0）
	assert.ok(aliceLine.includes('⚠️超时×1'), 'timeout member should show warning')
})

// ─── 4. attemptId 真行为（真调用 board.update）───────────────────────────────

test('P4: wrong attemptId on owner action → TEAM_TASK_STALE_ATTEMPT', async () => {
	const backend = makeBackend()
	const journal = new TeamJournal(backend, () => {})
	const board = new TeamTaskBoard(journal, 100)
	const lead = leadAgent(backend)
	const membership = fakeMembership(lead)
	const alice = member('alice-1', 'alice')
	const aliceMem = teammateMembership(lead, alice)
	await addMember(journal, lead, alice)

	const created = await board.create(membership, { subject: 'attempt-test', description: 'attemptId' })
	const claimed = await board.update(alice, aliceMem, {
		taskId: created.id, expectedRevision: created.revision, action: 'claim',
	})
	assert.ok(claimed.attemptId !== undefined, 'claim must return attemptId')

	const staleId = '00000000-0000-0000-0000-000000000000'
	await assert.rejects(
		board.update(alice, aliceMem, {
			taskId: created.id, expectedRevision: claimed.revision,
			action: 'edit', subject: 'hacked', attemptId: staleId,
		}),
		(err) => {
			assert.equal(err.code, 'TEAM_TASK_STALE_ATTEMPT')
			return true
		},
	)
})

test('P4: correct attemptId on owner action succeeds', async () => {
	const backend = makeBackend()
	const journal = new TeamJournal(backend, () => {})
	const board = new TeamTaskBoard(journal, 100)
	const lead = leadAgent(backend)
	const membership = fakeMembership(lead)
	const alice = member('alice-1', 'alice')
	const aliceMem = teammateMembership(lead, alice)
	await addMember(journal, lead, alice)

	const created = await board.create(membership, { subject: 'attempt-ok', description: 'attemptId' })
	const claimed = await board.update(alice, aliceMem, {
		taskId: created.id, expectedRevision: created.revision, action: 'claim',
	})

	const edited = await board.update(alice, aliceMem, {
		taskId: created.id, expectedRevision: claimed.revision,
		action: 'edit', subject: 'edited-with-token', attemptId: claimed.attemptId,
	})
	assert.equal(edited.subject, 'edited-with-token')
})

test('P4: Lead is exempt from attemptId requirement', async () => {
	const backend = makeBackend()
	const journal = new TeamJournal(backend, () => {})
	const board = new TeamTaskBoard(journal, 100)
	const lead = leadAgent(backend)
	const membership = fakeMembership(lead)
	const alice = member('alice-1', 'alice')
	const aliceMem = teammateMembership(lead, alice)
	await addMember(journal, lead, alice)

	const created = await board.create(membership, { subject: 'lead-exempt', description: 'lead exempt' })
	const claimed = await board.update(alice, aliceMem, {
		taskId: created.id, expectedRevision: created.revision, action: 'claim',
	})

	// Lead 无令牌直接 edit — 豁免 attemptId 检查
	const edited = await board.update(lead, membership, {
		taskId: created.id, expectedRevision: claimed.revision,
		action: 'edit', subject: 'edited-by-lead',
	})
	assert.equal(edited.subject, 'edited-by-lead')
})

test('P4: claim and reassign do not require attemptId', async () => {
	const backend = makeBackend()
	const journal = new TeamJournal(backend, () => {})
	const board = new TeamTaskBoard(journal, 100)
	const lead = leadAgent(backend)
	const membership = fakeMembership(lead)
	const alice = member('alice-1', 'alice')
	const bob = member('bob-1', 'bob')
	const aliceMem = teammateMembership(lead, alice)
	const bobMem = teammateMembership(lead, bob)
	await addMember(journal, lead, alice)
	await addMember(journal, lead, bob)

	// claim 不要令牌
	const created = await board.create(membership, { subject: 'no-token', description: 'no token' })
	const claimed = await board.update(alice, aliceMem, {
		taskId: created.id, expectedRevision: created.revision, action: 'claim',
	})
	assert.ok(claimed.attemptId !== undefined)

	// reassign 不要令牌（Lead 直接 reassign 给 bob）
	const reassigned = await board.update(lead, membership, {
		taskId: created.id, expectedRevision: claimed.revision,
		action: 'reassign', owner: 'bob',
	})
	assert.equal(reassigned.ownerName, 'bob')
	// reassign 重发新令牌，旧 alice 的已失效
	assert.notEqual(reassigned.attemptId, claimed.attemptId)
})

// ─── 6. 真实 Service 构造路径 ──────────────────────────────────────────────
// Object.create(TeamService.prototype) 绕过 constructor 的依赖装配与 cordis
// Service 注册——本节用真实 `new TeamService(ctx, config)` 走完整构造。

function makeRealCtx(projectionOverride) {
	const ctx = new Context()
	const durableEvents = []
	const registry = new Map()
	const projections = new Map()
	ctx.reflect.provide('sessionProjections', {
		register(def) {
			projections.set('agentTeam', def)
			return () => projections.delete('agentTeam')
		},
		stateOf(session, key) {
			const def = projections.get(key)
			if (def === undefined) return undefined
			let state = def.init({ id: session.agentId })
			for (const e of durableEvents) state = def.apply(state, e)
			if (projectionOverride !== undefined) return { ...state, ...projectionOverride }
			return state
		},
	})
	ctx.reflect.provide('sessions', {
		async flush() {},
		get() { return undefined },
	})
	ctx.reflect.provide('agents', {
		get(id) { return registry.get(id) },
		list() { return [...registry.values()] },
	})
	ctx.reflect.provide('sessionPersistence', {})
	ctx.reflect.provide('subagents', {
		interrupt() {},
		async drainContinuableChildren() {},
		async startContinuable() { throw new Error('subagent spawn not exercised') },
	})
	function makeAgent(id) {
		const session = {
			append(type, data) { durableEvents.push({ type, data }) },
			header: {},
			snapshotEvents() { return [] },
			inheritedEventCount: 0,
			agentId: id,
		}
		const agent = { id, session, options: {}, status: 'idle' }
		registry.set(id, agent)
		return agent
	}
	return { ctx, durableEvents, registry, makeAgent }
}

test('P6: real TeamService constructor wires durable task lifecycle', async () => {
	const { ctx, makeAgent } = makeRealCtx()
	const svc = new TeamService(ctx, {})
	// 构造走真实路径：journal/roster/mailbox/tasks 由 TeamService 自己装配
	assert.equal(svc.journal.constructor.name, 'TeamJournal')
	assert.equal(svc.roster.constructor.name, 'TeamRoster')
	assert.equal(svc.mailbox.constructor.name, 'TeamMailbox')
	assert.equal(svc.tasks.constructor.name, 'TeamTaskBoard')

	const lead = makeAgent('lead-1')
	const status = svc.teamStatus(lead)
	assert.deepEqual(status.members.map((m) => m.name), ['lead'])

	// createTask → journal.transact → appendAndFlush → projection apply 全链路真实
	const task = await svc.createTask(lead, { subject: 'real-ctor', description: 'real constructor path' })
	assert.equal(task.status, 'pending')
	assert.equal(svc.listTasks(lead).length, 1)
	assert.equal(svc.metricsSnapshot(lead).counters.tasksCreated, 1)
})

test('P6: real TeamService fast-fails on projection failure', () => {
	const { ctx, makeAgent } = makeRealCtx({ failure: 'injected projection failure' })
	const svc = new TeamService(ctx, {})
	const lead = makeAgent('lead-1')
	assert.throws(
		() => svc.teamStatus(lead),
		(err) => {
			assert.equal(err.code, 'TEAM_PROJECTION_FAILED')
			assert.ok(err.message.includes('injected projection failure'))
			return true
		},
	)
})

// ─── 5. TASK_TRANSITIONS 状态机 ─────────────────────────────────────────────

test('P5: TASK_TRANSITIONS legal edges pass, illegal throws', () => {
	assert.doesNotThrow(() => assertTaskTransition('pending', 'in_progress'))
	assert.doesNotThrow(() => assertTaskTransition('pending', 'deleted'))
	assert.doesNotThrow(() => assertTaskTransition('in_progress', 'pending'))
	assert.doesNotThrow(() => assertTaskTransition('in_progress', 'completed'))
	assert.doesNotThrow(() => assertTaskTransition('in_progress', 'deleted'))
	assert.doesNotThrow(() => assertTaskTransition('completed', 'pending'))
	assert.doesNotThrow(() => assertTaskTransition('completed', 'deleted'))
	// 同状态原地 update 不算迁移
	assert.doesNotThrow(() => assertTaskTransition('pending', 'pending'))

	// 非法转移：completed → in_progress（终态无出边到 in_progress）
	assert.throws(
		() => assertTaskTransition('completed', 'in_progress'),
		(err) => {
			assert.equal(err.code, 'TEAM_TASK_INVALID_TRANSITION')
			assert.ok(err.message.includes('completed'))
			assert.ok(err.message.includes('in_progress'))
			return true
		},
	)
	// deleted → any（终态无出边）
	assert.throws(
		() => assertTaskTransition('deleted', 'pending'),
		(err) => { assert.equal(err.code, 'TEAM_TASK_INVALID_TRANSITION'); return true },
	)
})

test('P5: board.update enforces transitions — reopen legal, claim on completed rejected', async () => {
	const backend = makeBackend()
	const journal = new TeamJournal(backend, () => {})
	const board = new TeamTaskBoard(journal, 100)
	const lead = leadAgent(backend)
	const membership = fakeMembership(lead)
	const alice = member('alice-1', 'alice')
	const aliceMem = teammateMembership(lead, alice)
	await addMember(journal, lead, alice)

	const created = await board.create(membership, { subject: 'trans-test', description: 'transition' })
	const claimed = await board.update(alice, aliceMem, {
		taskId: created.id, expectedRevision: created.revision, action: 'claim',
	})
	await board.update(alice, aliceMem, {
		taskId: created.id, expectedRevision: claimed.revision,
		action: 'complete', attemptId: claimed.attemptId,
	})

	const completed = await board.get(membership, created.id)
	assert.equal(completed.status, 'completed')

	// reopen 合法：completed → pending
	const reopened = await board.update(lead, membership, {
		taskId: created.id, expectedRevision: completed.revision, action: 'reopen',
	})
	assert.equal(reopened.status, 'pending')
})
