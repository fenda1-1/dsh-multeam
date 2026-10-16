// task-4 行为断言：
//  1. teammate 连续 waitSpinLimit 次 timeout → TEAM_WAIT_SPUN 硬拒；
//     非 timeout 结果复位计数；Lead 豁免。
//  2. mailbox diff 携带 mailbox_to；filter.mailbox_to_me 只匹配发给我的条目。
//  3. recordInstallDiagnostic 备注出现在 listMembers().diagnostics。

import test from 'node:test'
import assert from 'node:assert/strict'

import { bundle } from './support.mjs'

const { TeamService, TeamError, teamProjectionDefinition } = bundle

const ROOT_ID = 'lead-1'

function makeBackend(projectionOverride) {
	const durableEvents = []
	const session = {
		append(type, data) { durableEvents.push({ type, data }) },
		header: {},
		agentId: ROOT_ID,
		snapshotEvents() { return [] },
		inheritedEventCount: 0,
	}
	return {
		session,
		durableEvents,
		sessions: { async flush() {}, get() { return undefined } },
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

function leadAgent(backend) {
	return { id: ROOT_ID, session: backend.session, options: {}, status: 'idle' }
}

function teammateAgent(backend, id) {
	return {
		id,
		session: { ...backend.session, agentId: id, header: { type: 'subagent', parentSession: ROOT_ID } },
		options: {},
		status: 'idle',
	}
}

function member(id, name, phase = 'active') {
	return { id, name, phase, description: 'desc', provider: 'test', context: 'fresh' }
}

async function addMember(journal, lead, m) {
	await journal.appendAndFlush(lead, 'team/member', {
		version: 2, teamId: ROOT_ID, member: { ...m, phase: 'provisioning' },
	})
	await journal.appendAndFlush(lead, 'team/member', {
		version: 2, teamId: ROOT_ID, member: { ...m, phase: 'active' },
	})
}

async function queueMessage(mailbox, sender, senderMembership, { target, text = 'hi' }) {
	return mailbox.send(sender, {
		target,
		content: [{ type: 'text', text }],
		signal: AbortSignal.timeout(5000),
	})
}

/** 真实构造的 TeamService；journal/roster/mailbox/activity 全真。 */
function makeService(backend, config = {}) {
	const agents = new Map()
	const ctx = {
		logger: { info() {}, warn() {} },
		agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
		sessions: { async flush() {}, get() { return undefined } },
		sessionProjections: backend.sessionProjections,
		sessionPersistence: {},
		subagents: { interrupt() {}, async drainContinuableChildren() {}, async startContinuable() { throw new Error('spawn not exercised') } },
		reflect: { provide() {}, fork() { return {} } },
		on() { return () => {} },
		effect() {},
	}
	const svc = new TeamService(ctx, { enforceWriteScopes: false, ...config })
	/* activity.wait rejects <10s timeouts; tests swap in a controllable stub that
	 * still exposes recordWaitOutcome/resetWaitSpin/notify for the spin ledger. */
	const stub = {
		queue: [],
		wait(id, _ms, signal) {
			signal.throwIfAborted()
			return new Promise((resolve) => this.queue.push({ id, resolve }))
		},
		resolveAll(timedOut) {
			const pending = this.queue.splice(0)
			for (const w of pending) w.resolve({ timedOut })
		},
		notify: svc.activity.notify.bind(svc.activity),
		recordWaitOutcome: svc.activity.recordWaitOutcome.bind(svc.activity),
		resetWaitSpin: svc.activity.resetWaitSpin.bind(svc.activity),
	}
	svc.activity = stub
	return { svc, agents, activity: stub }
}

async function tick() {
	await new Promise((resolve) => setImmediate(resolve))
	await new Promise((resolve) => setImmediate(resolve))
}

function fakeMembership(agent) {
	return { root: agent, id: ROOT_ID, role: 'lead', name: 'lead' }
}

function teammateMembership(root, agent, name) {
	return { root, id: agent.id, role: 'teammate', name }
}

test('wait-spin: teammate 连续 timeout 达 waitSpinLimit 后抛 TEAM_WAIT_SPUN', async () => {
	const backend = makeBackend()
	const { svc, agents, activity } = makeService(backend, { waitSpinLimit: 3 })
	const lead = leadAgent(backend)
	await addMember(svc.journal, lead, member('m-spin', 'spin-mate'))
	const mate = teammateAgent(backend, 'm-spin')
	// roster.membership 走 journal+agents——agents.get 必须返回 exact same agent
	agents.set(ROOT_ID, lead)
	agents.set('m-spin', mate)

	const wait = async () => {
		const p = svc.waitForChange(mate, 10_000, AbortSignal.timeout(30_000))
		await tick()
		activity.resolveAll(true) // deadline hit
		return p
	}
	let r = await wait()
	assert.equal(r.timedOut, true, 'streak 1 must be a plain timeout')
	r = await wait()
	assert.equal(r.timedOut, true, 'streak 2 must be a plain timeout')
	await assert.rejects(wait(), (e) => { assert.equal(e.code, 'TEAM_WAIT_SPUN'); return true })
})

test('wait-spin: 非 timeout 结果复位连续计数（发给自己的 mailbox 条目）', async () => {
	const backend = makeBackend()
	const { svc, agents, activity } = makeService(backend, { waitSpinLimit: 2 })
	const lead = leadAgent(backend)
	const mate = teammateAgent(backend, 'm-reset')
	await addMember(svc.journal, lead, member('m-reset', 'reset-mate'))
	agents.set(ROOT_ID, lead)
	agents.set('m-reset', mate)

	const wait = async () => {
		const p = svc.waitForChange(mate, 10_000, AbortSignal.timeout(30_000))
		await tick()
		activity.resolveAll(true)
		return p
	}
	let r = await wait()
	assert.equal(r.timedOut, true)
	// queued inbound addressed to the teammate short-circuits the baseline
	// branch and resets the streak before any timer runs.
	const sent = await queueMessage(svc.mailbox, lead, { root: lead, id: ROOT_ID, role: 'lead', name: 'lead' }, { target: 'reset-mate' })
	r = await svc.waitForChange(mate, 10_000, AbortSignal.timeout(30_000))
	assert.equal(r.timedOut, false)
	assert.ok(r.changes.some((c) => c.mailbox_to === 'reset-mate'), 'change must carry mailbox_to=reset-mate')
	// pending-to-caller keeps short-circuiting while undelivered — every wait
	// returns a non-timeout, so the streak can never accumulate past reset.
	r = await svc.waitForChange(mate, 10_000, AbortSignal.timeout(30_000))
	assert.equal(r.timedOut, false, 'still-pending inbound keeps returning a mailbox change')
	// mark delivered so waits reach the timer again, then streak restarts at 1.
	await svc.journal.appendAndFlush(lead, 'team/message/delivered', {
		version: 2, teamId: ROOT_ID, messageId: sent.messageId, targetId: 'm-reset',
	})
	r = await wait()
	assert.equal(r.timedOut, true, 'after reset the first timeout is plain again')
	await assert.rejects(wait(), (e) => { assert.equal(e.code, 'TEAM_WAIT_SPUN'); return true })
})

test('wait-spin: Lead 不受 cap 约束（连续 timeout 永不抛 TEAM_WAIT_SPUN）', async () => {
	const backend = makeBackend()
	const { svc, agents, activity } = makeService(backend, { waitSpinLimit: 2 })
	const lead = leadAgent(backend)
	agents.set(ROOT_ID, lead)
	for (let i = 0; i < 4; i++) {
		const p = svc.waitForChange(lead, 10_000, AbortSignal.timeout(30_000))
		await tick()
		activity.resolveAll(true)
		const r = await p
		assert.notEqual(r.code, 'TEAM_WAIT_SPUN')
	}
})

test('mailbox_to_me: 只匹配发给我的 mailbox 条目，他人收件不唤醒', async () => {
	const backend = makeBackend()
	const { svc, agents, activity } = makeService(backend)
	const lead = leadAgent(backend)
	const alice = teammateAgent(backend, 'm-alice')
	const bob = teammateAgent(backend, 'm-bob')
	await addMember(svc.journal, lead, member('m-alice', 'alice'))
	await addMember(svc.journal, lead, member('m-bob', 'bob'))
	agents.set(ROOT_ID, lead)
	agents.set('m-alice', alice)
	agents.set('m-bob', bob)
	const leadMem = { root: lead, id: ROOT_ID, role: 'lead', name: 'lead' }

	// message to bob only — alice's mailbox_to_me wait must time out
	await queueMessage(svc.mailbox, lead, leadMem, { target: 'bob' })
	const missP = svc.waitForChange(alice, 10_000, AbortSignal.timeout(30_000), { kinds: ['mailbox'], mailbox_to_me: true })
	await tick()
	activity.resolveAll(true)
	const miss = await missP
	assert.equal(miss.timedOut, true, 'mailbox addressed to bob must not satisfy alice mailbox_to_me')

	// message to alice — matched (baseline pending short-circuit)
	await queueMessage(svc.mailbox, lead, leadMem, { target: 'alice' })
	const hit = await svc.waitForChange(alice, 10_000, AbortSignal.timeout(30_000), { kinds: ['mailbox'], mailbox_to_me: true })
	assert.equal(hit.timedOut, false)
	assert.ok(hit.changes.every((c) => c.mailbox_to === 'alice'), 'every matched mailbox change must target alice')
})

test('recordInstallDiagnostic 出现在 listMembers().diagnostics 且去重', async () => {
	const backend = makeBackend()
	const { svc, agents } = makeService(backend)
	const lead = leadAgent(backend)
	const mate = teammateAgent(backend, 'm-diag')
	await addMember(svc.journal, lead, member('m-diag', 'diag-mate'))
	agents.set(ROOT_ID, lead)
	agents.set('m-diag', mate)

	svc.recordInstallDiagnostic(mate, 'scoped tool install failed: spawn raced')
	svc.recordInstallDiagnostic(mate, 'scoped tool install failed: spawn raced')
	const row = svc.listMembers(lead).find((m) => m.id === 'm-diag')
	assert.ok(row, 'diag-mate row must exist')
	const hits = row.diagnostics.filter((d) => d.includes('install failed'))
	assert.equal(hits.length, 1, 'duplicate diagnostic must be recorded once')
})
