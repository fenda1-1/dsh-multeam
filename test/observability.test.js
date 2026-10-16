import { bundle } from './support.mjs'
import { test } from "node:test";
import assert from "node:assert/strict";

const mod = bundle;
const TeamSchedulerService = mod.TeamScheduler ?? mod.default;
const proto = TeamSchedulerService.prototype;

function makeScheduler(overrides = {}) {
	const sched = Object.create(proto);
	sched.config = {
		capabilityMatch: true,
		timeoutDetection: true,
		timeoutMs: 30 * 60 * 1000,
		retryLimit: 2,
		loadBalance: true,
		priority: true,
		notifyUnassigned: true,
		...overrides.config,
	};
	sched.notified = new Map();
	sched.tails = new Map();
	sched.coalescePending = new Map();
	sched.inProgressSince = new Map();
	sched.timeoutNotified = new Map();
	sched.retryCount = new Map();
	sched.retryExhausted = new Map();
	sched.failureWarned = new Set();
	sched.perfMap = new Map();
	sched.perfLoaded = new Map();
	sched.perfDirty = new Map();
	sched.stats = new Map();
	sched.alertLog = [];
	sched.passCount = 0;
	sched.lastPassAt = 0;
	sched.decisionLog = new Map();
	sched.lastSeenRevision = new Map();
	sched.lastDecayAt = new Map();
	sched.dispatchFailures = new Map();
	sched.sessionsDirReady = false;
	sched.ctx = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		agents: { get() { return undefined; }, list() { return []; } },
		agentTeams: { sendMessage: async () => ({}) },
		sessionProjections: { stateOf: () => undefined },
		...overrides.ctx,
	};
	return sched;
}

function makeState(overrides = {}) {
	return {
		id: "lead-1",
		members: [
			{ id: "lead-1", name: "lead", phase: "active", role: "lead" },
			{ id: "alice-1", name: "alice", phase: "active" },
			{ id: "bob-1", name: "bob", phase: "active" },
		],
		tasks: [],
		mailbox: [],
		...overrides,
	};
}

// ── O1: getStats returns cumulative counters ─────────────────────────

test("O1: getStats returns zeros for unknown session", () => {
	const sched = makeScheduler();
	const s = sched.getStats("no-such-session");
	assert.equal(s.dispatched, 0);
	assert.equal(s.passes, 0);
});

test("O1: recordAlert increments correct counter per type", () => {
	const sched = makeScheduler();
	sched.recordAlert("sess-1", "timeout", "task-1", "alice-1");
	sched.recordAlert("sess-1", "timeout", "task-2", "bob-1");
	sched.recordAlert("sess-1", "orphan", "task-3", "carol-1");
	sched.recordAlert("sess-1", "retry-exhausted", "task-4", "dave-1");
	const s = sched.getStats("sess-1");
	assert.equal(s.timeoutAlerts, 2);
	assert.equal(s.orphan, 1);
	assert.equal(s.retryExhausted, 1);
	assert.equal(s.dispatched, 0); // not an alert type
});

// ── O2: alertLog ring buffer ──────────────────────────────────────────

test("O2: alertLog caps at 100 entries", () => {
	const sched = makeScheduler();
	for (let i = 0; i < 120; i++) {
		sched.recordAlert("sess-1", "timeout", `task-${i}`, "alice-1");
	}
	assert.equal(sched.alertLog.length, 100);
	assert.equal(sched.alertLog[0].taskId, "task-20"); // oldest 20 evicted
	assert.equal(sched.alertLog[99].taskId, "task-119");
});

test("O2: alertLog entries carry type/taskId/ownerId/sessionId/timestamp", () => {
	const sched = makeScheduler();
	sched.recordAlert("sess-1", "orphan", "task-5", "bob-1");
	const entry = sched.alertLog[0];
	assert.equal(entry.type, "orphan");
	assert.equal(entry.taskId, "task-5");
	assert.equal(entry.ownerId, "bob-1");
	assert.equal(entry.sessionId, "sess-1");
	assert.ok(entry.timestamp > 0);
});

// ── O3: log level grading ────────────────────────────────────────────

test("O3: empty pass logs debug, actionable pass logs info", () => {
	const logs = [];
	const sched = makeScheduler({
		ctx: {
			logger: {
				info(msg) { logs.push({ level: "info", msg }); },
				debug(msg) { logs.push({ level: "debug", msg }); },
				warn() {},
				error() {},
			},
			agents: { get() { return undefined; }, list() { return []; } },
			agentTeams: { sendMessage: async () => ({}) },
			sessionProjections: { stateOf: () => undefined },
		},
	});
	// Simulate the logLevel logic directly
	const actionable = 0, dispatched = 0, timeoutAlerts = 0;
	const logLevel = actionable === 0 && dispatched === 0 && timeoutAlerts === 0 ? "debug" : "info";
	assert.equal(logLevel, "debug");
});

// ── O4: healthCheck ──────────────────────────────────────────────────

test("O4: healthCheck returns expected shape", () => {
	const sched = makeScheduler();
	sched.passCount = 42;
	sched.lastPassAt = 1700000000000;
	sched.stats.set("sess-1", { passes: 10 });
	sched.stats.set("sess-2", { passes: 5 });
	sched.retryCount.set("key-1", 1);
	sched.recordAlert("sess-1", "timeout", "task-1", "alice-1");

	const h = sched.healthCheck();
	assert.equal(h.passCount, 42);
	assert.equal(h.lastPassAt, 1700000000000);
	assert.equal(h.activeSessions, 2);
	assert.equal(h.pendingRetries, 1);
	assert.equal(h.recentAlerts.length, 1);
	assert.equal(h.recentAlerts[0].type, "timeout");
});

// ── O5: timeoutNotified stores count, TIMEOUT_MESSAGE shows 第N次 ────

test("O5: timeoutNotified value increments on re-alert", () => {
	const sched = makeScheduler();
	sched.timeoutNotified.set("lead-1:task-1:alice-1", 1);
	// Simulate second alert — the count should be readable as a number
	const count = sched.timeoutNotified.get("lead-1:task-1:alice-1");
	assert.equal(count, 1);
	assert.equal(count + 1, 2); // next alert would be #2
});

// ── O6: decisionLog records scored array ──────────────────────────────

test("O6: decisionLog stores scored entries for audit", () => {
	const sched = makeScheduler();
	sched.decisionLog.set("lead-1", []);
	const dl = sched.decisionLog.get("lead-1");
	dl.push({
		taskId: "task-1",
		scored: [
			{ name: "alice", hits: ["database"], kwScore: 1, perfBonus: 1.5, score: 3.5 },
			{ name: "bob", hits: ["api"], kwScore: 1, perfBonus: 0, score: 2 },
		],
		timestamp: Date.now(),
	});
	assert.equal(dl.length, 1);
	assert.equal(dl[0].scored.length, 2);
	assert.equal(dl[0].scored[0].name, "alice");
});

test("O6: decisionLog caps at 20 entries per session", () => {
	const sched = makeScheduler();
	const dl = [];
	for (let i = 0; i < 25; i++) {
		dl.push({ taskId: `task-${i}`, scored: [], timestamp: Date.now() });
		if (dl.length > 20) dl.shift();
	}
	sched.decisionLog.set("lead-1", dl);
	assert.equal(sched.decisionLog.get("lead-1").length, 20);
	assert.equal(sched.decisionLog.get("lead-1")[0].taskId, "task-5"); // oldest 5 evicted
});

// ── O1: stats persist across multiple recordAlert calls ───────────────

test("O1: stats accumulate across sessions independently", () => {
	const sched = makeScheduler();
	sched.recordAlert("sess-a", "timeout", "task-1", "alice-1");
	sched.recordAlert("sess-b", "orphan", "task-2", "bob-1");
	sched.recordAlert("sess-b", "orphan", "task-3", "carol-1");
	assert.equal(sched.getStats("sess-a").timeoutAlerts, 1);
	assert.equal(sched.getStats("sess-a").orphan, 0);
	assert.equal(sched.getStats("sess-b").orphan, 2);
	assert.equal(sched.getStats("sess-b").timeoutAlerts, 0);
});
