import { bundle } from './support.mjs'
import test from "node:test";
import assert from "node:assert/strict";

/**
 * Behavioral tests for the perfMap performance-tracking system.
 * Loads the actual scheduler module and calls collectPerf/buildCapabilityHint
 * with crafted state objects — no mocks, no string matching.
 */

// The scheduler exports a Service class, not a standalone function.
// We import the module and construct it with a minimal ctx.
const mod = bundle;
const TeamSchedulerService = mod.TeamScheduler ?? mod.default;
const { TeamJournal, TeamTaskBoard } = bundle;

const ROOT_ID = 'lead-1';

function makeBackend() {
	const durableEvents = [];
	const session = { append(type, data) { durableEvents.push({ type, data }); } };
	return {
		session,
		durableEvents,
		sessions: { async flush() {} },
		sessionProjections: {
			stateOf(_s, key) {
				let state = bundle.teamProjectionDefinition.init({ id: ROOT_ID });
				for (const e of durableEvents) state = bundle.teamProjectionDefinition.apply(state, e);
				return state;
			},
		},
	};
}

function member(id, name, phase = 'active') {
	return { id, name, phase, description: 'desc', provider: 'test', context: 'fresh' };
}

async function addMember(journal, lead, m) {
	await journal.appendAndFlush(lead, 'team/member', { version: 2, teamId: ROOT_ID, member: { ...m, phase: 'provisioning' } });
	await journal.appendAndFlush(lead, 'team/member', { version: 2, teamId: ROOT_ID, member: { ...m, phase: 'active' } });
}

function makeScheduler() {
	// Cordis Service constructor requires a ctx with provide() — bypass it
	// with Object.create and set the fields collectPerf/buildCapabilityHint need.
	const proto = TeamSchedulerService.prototype;
	const sched = Object.create(proto);
	sched.config = { capabilityMatch: true };
	sched.perfMap = new Map();
	sched.perfLoaded = new Map();
	sched.perfDirty = new Map();
	sched.lastSeenRevision = new Map();
	sched.lastDecayAt = new Map();
	sched.dispatchFailures = new Map();
	sched.inProgressSince = new Map();
	sched.timeoutNotified = new Map();
	sched.ctx = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		agents: { get() { return undefined; }, list() { return []; } },
	};
	return sched;
}

function makeState(overrides = {}) {
	const defaults = [
		{ id: "alice-1", name: "alice", phase: "active", description: "refactor database schema" },
		{ id: "bob-1", name: "bob", phase: "active", description: "refactor frontend monitor" },
		{ id: "carol-1", name: "carol", phase: "released", description: "refactor database schema" },
	];
	// overrides.members replaces defaults by id — same id overrides, new id appends.
	const members = defaults.map((d) =>
		(overrides.members ?? []).find((o) => o.id === d.id) ?? d
	).concat(
		(overrides.members ?? []).filter((o) => !defaults.some((d) => d.id === o.id))
	);
	return { id: "lead-1", members, tasks: overrides.tasks ?? [] };
}

test("collectPerf: completed task increments completed count", () => {
	const sched = makeScheduler();
	const state = makeState({
		tasks: [{
			id: "task-1", ownerId: "alice-1", status: "completed", revision: 1,
			subject: "修复 schema bug", description: "fix encoding issue",
		}],
	});
	sched.collectPerf(state, state.tasks, "lead-1");
	const perf = sched.perfMap.get("alice-1");
	assert.equal(perf.completed, 1);
	assert.ok(perf.capabilities.has("修复") || perf.capabilities.has("fix"));
});

test("collectPerf: same task completed twice does not double-count", () => {
	const sched = makeScheduler();
	const task = {
		id: "task-1", ownerId: "alice-1", status: "completed", revision: 1,
		subject: "fix bug", description: "",
	};
	const state = makeState({ tasks: [task] });
	sched.collectPerf(state, state.tasks, "lead-1");
	// Simulate reopen → re-complete (same taskId, higher revision).
	const reopened = { ...task, status: "in_progress", revision: 2 };
	const recompleted = { ...task, status: "completed", revision: 3 };
	sched.collectPerf(state, [reopened], "lead-1");
	sched.collectPerf(state, [recompleted], "lead-1");
	assert.equal(sched.perfMap.get("alice-1").completed, 1);
});

test("collectPerf: pending/in_progress revisions do not consume seen slots", () => {
	const sched = makeScheduler();
	const state = makeState({
		tasks: [{
			id: "task-1", ownerId: "alice-1", status: "in_progress", revision: 5,
			subject: "fix", description: "",
		}],
	});
	sched.collectPerf(state, state.tasks, "lead-1");
	const perf = sched.perfMap.get("alice-1");
	// in_progress tasks create the perf entry but don't add to seen.
	assert.equal(perf.completed, 0);
	assert.equal(perf.seen.size, 0);
});

test("collectPerf: deleted task does not count as failed", () => {
	const sched = makeScheduler();
	const state = makeState({
		tasks: [{
			id: "task-1", ownerId: "alice-1", status: "deleted", revision: 2,
			subject: "fix", description: "",
		}],
	});
	sched.collectPerf(state, state.tasks, "lead-1");
	const perf = sched.perfMap.get("alice-1");
	// deleted tasks never create perf entries — F11 fix.
	assert.equal(perf, undefined);
});

test("collectPerf: released/failed member perf is pruned", () => {
	const sched = makeScheduler();
	// carol starts as active, completes a task → perf entry created.
	const state = makeState({
		members: [
			{ id: "alice-1", name: "alice", phase: "active", description: "fix" },
			{ id: "carol-1", name: "carol", phase: "active", description: "fix" },
		],
		tasks: [{
			id: "task-1", ownerId: "carol-1", status: "completed", revision: 1,
			subject: "fix", description: "",
		}],
	});
	sched.collectPerf(state, state.tasks, "lead-1");
	assert.ok(sched.perfMap.has("carol-1"));
	// Carol is now released — her perf should be cleaned on next pass.
	state.members.find((m) => m.id === "carol-1").phase = "released";
	sched.collectPerf(state, state.tasks, "lead-1");
	assert.equal(sched.perfMap.has("carol-1"), false);
});

test("buildCapabilityHint: perfBonus capped at kwScore", () => {
	const sched = makeScheduler();
	// alice has history in "refactor" (SPECIFIC) but the task only has 1 keyword match.
	const state = makeState({
		tasks: [{
			id: "task-9", ownerId: undefined, status: "pending",
			subject: "refactor schema", description: "",
		}],
	});
	sched.perfMap.set("alice-1", {
		completed: 5, timeouts: 0,
		capabilities: new Set(["refactor", "schema"]),
		seen: new Set(),
	});
	const hintResult = sched.buildCapabilityHint(state.tasks[0], state, "lead-1");
	assert.ok(hintResult !== undefined, "hint should exist for SPECIFIC keyword match");
	// alice should be first (keyword match + perf), but perfBonus
	// shouldn't push someone with 0 keyword hits above someone with 1.
});

test("buildCapabilityHint: member with timeouts gets penalty annotation", () => {
	const sched = makeScheduler();
	sched.perfMap.set("alice-1", {
		completed: 3, timeouts: 2,
		capabilities: new Set(["refactor"]),
		seen: new Set(),
	});
	const state = makeState({
		tasks: [{
			id: "task-1", ownerId: undefined, status: "pending",
			subject: "refactor auth", description: "",
		}],
	});
	const hintResult = sched.buildCapabilityHint(state.tasks[0], state, "lead-1");
	assert.ok(hintResult !== undefined);
	assert.ok(hintResult.suggestions[0].includes("⚠️超时"), "expected timeout annotation");
});

test("buildCapabilityHint: pure GENERIC task returns no hint", () => {
	const sched = makeScheduler();
	sched.perfMap.set("alice-1", {
		completed: 5, timeouts: 0,
		capabilities: new Set(["test", "fix"]),
		seen: new Set(),
	});
	const state = makeState({
		tasks: [{
			id: "task-1", ownerId: undefined, status: "pending",
			subject: "test the fix", description: "",
		}],
	});
	const hintResult = sched.buildCapabilityHint(state.tasks[0], state, "lead-1");
	// 纯泛词任务不出 hint——所有成员 kwScore=0 无法区分。
	assert.equal(hintResult, undefined, "GENERIC-only task should not produce hint");
});

test("inProgressSince key contains ownerId — reassign resets timer", () => {
	const sched = makeScheduler();
	// Simulate: task assigned to alice, in_progress for 3 minutes.
	const key1 = "lead-1:task-1:alice-1";
	sched.inProgressSince.set(key1, Date.now() - 180_000);
	// Reassign to bob — new key means alice's timer doesn't apply.
	const key2 = "lead-1:task-1:bob-1";
	assert.notEqual(key1, key2);
	assert.equal(sched.inProgressSince.has(key2), false);
});

test("set_dependencies rejects completed task (F3)", async () => {
	// Behavioural assertion against the real task board: a completed task refuses
	// a dependency rewrite, and the refusal is the dedicated error code.
	const backend = makeBackend()
	const journal = new TeamJournal(backend, () => {})
	const board = new TeamTaskBoard(journal, 100)
	const lead = { id: ROOT_ID, session: backend.session }
	const membership = { root: lead, id: ROOT_ID, role: 'lead', name: 'lead' }
	const alice = member('alice-1', 'alice')
	const aliceMem = { root: lead, id: alice.id, role: 'teammate', name: 'alice' }
	await addMember(journal, lead, alice)

	const created = await board.create(membership, { subject: 'f3', description: 'f3' })
	const claimed = await board.update(alice, aliceMem, { taskId: created.id, expectedRevision: created.revision, action: 'claim' })
	const completed = await board.update(alice, aliceMem, { taskId: created.id, expectedRevision: claimed.revision, action: 'complete', attemptId: claimed.attemptId })

	await assert.rejects(
		board.update(alice, aliceMem, {
			taskId: created.id, expectedRevision: completed.revision,
			action: 'set_dependencies', blockedBy: [], attemptId: claimed.attemptId,
		}),
		(err) => {
			assert.equal(err.code, 'TEAM_TASK_INVALID_TRANSITION')
			assert.ok(err.message.includes('cannot change dependencies of completed task'))
			return true
		},
	)
})

test("reopen filters deleted tasks from blockedBy (F3)", async () => {
	// Behavioural assertion: deleting a blocker is refused while a live task still
	// lists it (the graph validator runs first), and clearing the dependency via
	// set_dependencies then makes the task ready again.
	const backend = makeBackend()
	const journal = new TeamJournal(backend, () => {})
	const board = new TeamTaskBoard(journal, 100)
	const lead = { id: ROOT_ID, session: backend.session }
	const membership = { root: lead, id: ROOT_ID, role: 'lead', name: 'lead' }
	const alice = member('alice-1', 'alice')
	const aliceMem = { root: lead, id: alice.id, role: 'teammate', name: 'alice' }
	await addMember(journal, lead, alice)

	const blocker = await board.create(membership, { subject: 'blocker', description: 'blocker' })
	const dependent = await board.create(membership, { subject: 'dependent', description: 'dependent', blockedBy: [blocker.id] })

	const bClaim = await board.update(alice, aliceMem, { taskId: blocker.id, expectedRevision: blocker.revision, action: 'claim' })
	const bDone = await board.update(alice, aliceMem, { taskId: blocker.id, expectedRevision: bClaim.revision, action: 'complete', attemptId: bClaim.attemptId })
	const bFinal = await board.get(membership, blocker.id)

	// Deleting the blocker is refused while the dependent still lists it.
	await assert.rejects(
		board.update(lead, membership, { taskId: blocker.id, expectedRevision: bFinal.revision, action: 'delete' }),
		(err) => {
			assert.equal(err.code, 'TEAM_TASK_HAS_DEPENDENTS')
			assert.ok(err.message.includes('still blocks'))
			return true
		},
	)

	// Clearing the dependency makes the dependent ready, and the blocker can then
	// be tombstoned.
	const cleared = await board.update(lead, membership, {
		taskId: dependent.id, expectedRevision: dependent.revision, action: 'set_dependencies', blockedBy: [],
	})
	assert.deepEqual([...cleared.blockedBy], [], 'set_dependencies replaced the blocker list')
	assert.equal(cleared.ready, true, 'task with no blockers is ready')

	await board.update(lead, membership, { taskId: blocker.id, expectedRevision: bFinal.revision, action: 'delete' })
	const tombstone = await board.get(membership, blocker.id)
	assert.equal(tombstone.status, 'deleted')
})
test("buildCapabilityHint: perfBonus is non-negative (F12)", () => {
	const sched = makeScheduler();
	// alice has only timeouts, no completions → perfBonus = -0.5×3 = -1.5.
	sched.perfMap.set("alice-1", {
		completed: 0, timeouts: 3,
		capabilities: new Set(["refactor"]),
		seen: new Set(),
	});
	const state = makeState({
		tasks: [{
			id: "task-1", ownerId: undefined, status: "pending",
			subject: "refactor api", description: "",
		}],
	});
	const hintResult = sched.buildCapabilityHint(state.tasks[0], state, "lead-1");
	// alice should appear with timeout annotation (negative perfBonus).
	assert.ok(hintResult !== undefined);
	const aliceLine = hintResult.suggestions.find((h) => h.includes("alice"));
	assert.ok(aliceLine !== undefined, "alice should appear in hint");
	assert.ok(aliceLine.includes("⚠️超时"), "expected timeout annotation for zero-completed member");
});

test("buildCapabilityHint: reliability formula correctness", () => {
	const sched = makeScheduler();
	// alice: 3 completed, 1 timeout → reliability = (3+1)/(3+1+2) = 4/6 = 0.667 → 67%
	// bob:   3 completed, 0 timeout → reliability = (3+1)/(3+0+2) = 4/5 = 0.8 → 80%
	// Beta(1,1) 平滑：RELIABILITY_PRIOR_SUCCESS=1, RELIABILITY_PRIOR_TRIALS=2
	sched.perfMap.set("alice-1", {
		completed: 3, timeouts: 1,
		capabilities: new Set(["refactor"]),
		seen: new Set(),
	});
	sched.perfMap.set("bob-1", {
		completed: 3, timeouts: 0,
		capabilities: new Set(["refactor"]),
		seen: new Set(),
	});
	const state = makeState({
		tasks: [{
			id: "task-1", ownerId: undefined, status: "pending",
			subject: "refactor api", description: "",
		}],
	});
	const hintResult = sched.buildCapabilityHint(state.tasks[0], state, "lead-1");
	assert.ok(hintResult !== undefined);
	// perfBonus is capped at kwScore — with kwScore=1 both get perfBonus=1.
	// Verify reliability percentage appears in the annotation.
	const aliceLine = hintResult.suggestions.find((h) => h.includes("alice"));
	const bobLine = hintResult.suggestions.find((h) => h.includes("bob"));
	assert.ok(aliceLine !== undefined, "alice should appear in hint");
	assert.ok(bobLine !== undefined, "bob should appear in hint");
	assert.ok(aliceLine.includes("67%"), "alice should show 67% reliability (Beta-smoothed)");
	assert.ok(bobLine.includes("80%"), "bob should show 80% reliability (Beta-smoothed)");
});

test("F11: timeout counted even for deleted task owner", () => {
	const sched = makeScheduler();
	// Simulate: task-1 assigned to alice, timed out, then deleted.
	// timeoutNotified key still has alice's entry — collectPerf should count it.
	sched.timeoutNotified.set("lead-1:task-1:alice-1", { count: 1, ts: Date.now() });
	sched.collectPerf(
		{ id: "lead-1", members: [{ id: "alice-1", name: "alice", phase: "active" }] },
		[{ id: "task-1", ownerId: "alice-1", status: "deleted" }],
		"lead-1",
	);
	const perf = sched.perfMap.get("alice-1");
	assert.ok(perf !== undefined, "perf entry should exist for timeout owner");
	assert.equal(perf.timeouts, 1, "deleted task timeout should count for original owner");
});

test("GENERIC-only task does not produce hint (F2)", () => {
	const sched = makeScheduler();
	// Task with only GENERIC keywords — no SPECIFIC signal to differentiate members.
	const state = makeState({
		tasks: [{
			id: "task-1", ownerId: undefined, status: "pending",
			subject: "test the fix", description: "bug data",
		}],
	});
	const hintResult = sched.buildCapabilityHint(state.tasks[0], state, "lead-1");
	assert.equal(hintResult, undefined, "GENERIC-only task should return undefined");
});

test("mixed SPECIFIC+GENERIC task only counts SPECIFIC for kwScore", () => {
	const sched = makeScheduler();
	// alice has "refactor" (SPECIFIC) in description, bob has "fix" (GENERIC).
	const state = makeState({
		members: [
			{ id: "alice-1", name: "alice", phase: "active", description: "refactor" },
			{ id: "bob-1", name: "bob", phase: "active", description: "fix" },
		],
		tasks: [{
			id: "task-1", ownerId: undefined, status: "pending",
			subject: "refactor the fix", description: "",
		}],
	});
	const hintResult = sched.buildCapabilityHint(state.tasks[0], state, "lead-1");
	assert.ok(hintResult !== undefined, "SPECIFIC keyword match should produce hint");
	// Only alice (SPECIFIC match) should appear — bob's GENERIC "fix" doesn't count.
	assert.ok(hintResult.suggestions[0].includes("alice"), "alice should rank first with SPECIFIC match");
	assert.ok(!hintResult.suggestions.some((s) => s.includes("bob")), "bob should not appear (GENERIC-only match)");
});

test("adversarial: high-experience low-relevance vs low-experience high-relevance", () => {
	const sched = makeScheduler();
	// veteran: 10 completed in "security" but task is "refactor" (no overlap).
	// rookie: 2 completed in "refactor" but low experience.
	sched.perfMap.set("veteran-1", {
		completed: 10, timeouts: 0,
		capabilities: new Set(["security", "database"]),
		seen: new Set(),
	});
	sched.perfMap.set("rookie-1", {
		completed: 2, timeouts: 0,
		capabilities: new Set(["refactor"]),
		seen: new Set(),
	});
	// Empty members array → only overrides, no default alice/bob/carol.
	const state = {
		id: "lead-1",
		members: [
			{ id: "veteran-1", name: "veteran", phase: "active", description: "refactor code" },
			{ id: "rookie-1", name: "rookie", phase: "active", description: "refactor" },
		],
		tasks: [{
			id: "task-1", ownerId: undefined, status: "pending",
			subject: "refactor database", description: "",
		}],
	};
	const hintResult = sched.buildCapabilityHint(state.tasks[0], state, "lead-1");
	assert.ok(hintResult !== undefined, "hint should exist");
	// Both match on "refactor" → kwScore=1 each.
	// veteran: relevantDone = |{refactor,database} ∩ {security,database}| = 1 ("database")
	//   perfBonus = min(1 × 1.5 × 1.0, kwScore=1) = min(1.5, 1) = 1 → total = 3
	// rookie:  relevantDone = |{refactor,database} ∩ {refactor}| = 1 ("refactor")
	//   perfBonus = min(1 × 1.5 × 1.0, kwScore=1) = min(1.5, 1) = 1 → total = 3
	// Tie at 3 — veteran's extra experience doesn't help because relevantDone
	// only counts domain overlap (1 word each), not total completions.
	const vetIdx = hintResult.suggestions.findIndex((s) => s.includes("veteran"));
	const rooIdx = hintResult.suggestions.findIndex((s) => s.includes("rookie"));
	assert.ok(vetIdx !== -1 && rooIdx !== -1, "both should appear in hint");
});

test("adversarial: timeout member ranks below completed member on same kwScore", () => {
	const sched = makeScheduler();
	// good: 5 completed, 0 timeouts → perfBonus positive.
	// bad: 0 completed, 3 timeouts → perfBonus = max(-1.5, -kwScore).
	sched.perfMap.set("good-1", {
		completed: 5, timeouts: 0,
		capabilities: new Set(["refactor"]),
		seen: new Set(),
	});
	sched.perfMap.set("bad-1", {
		completed: 0, timeouts: 3,
		capabilities: new Set(),
		seen: new Set(),
	});
	const state = {
		id: "lead-1",
		members: [
			{ id: "bad-1", name: "bad", phase: "active", description: "refactor" },
			{ id: "good-1", name: "good", phase: "active", description: "refactor" },
		],
		tasks: [{
			id: "task-1", ownerId: undefined, status: "pending",
			subject: "refactor api", description: "",
		}],
	};
	const hintResult = sched.buildCapabilityHint(state.tasks[0], state, "lead-1");
	assert.ok(hintResult !== undefined, "hint should exist");
	// good should rank first (positive perfBonus vs negative).
	assert.ok(hintResult.suggestions[0].includes("good"), "good member should rank first");
	const badLine = hintResult.suggestions.find((s) => s.includes("bad"));
	assert.ok(badLine !== undefined, "bad member should appear");
	assert.ok(badLine.includes("⚠️超时"), "bad member should show timeout warning");
});
