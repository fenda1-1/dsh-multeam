import { bundle } from './support.mjs'
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Behavioral tests for checkTimeouts cleanup, perfMap persistence (load/save),
 * and perfBonus edge cases — the paths that F10/F11/F12 proved fragile.
 * No mocks, no string matching — calls the real methods with crafted state.
 */

const mod = bundle;
const TeamSchedulerService = mod.TeamScheduler ?? mod.default;

function makeScheduler(overrides = {}) {
	const proto = TeamSchedulerService.prototype;
	const sched = Object.create(proto);
	sched.config = {
		capabilityMatch: true,
		timeoutDetection: true,
		timeoutMs: 30 * 60 * 1000,
		...overrides.config,
	};
	sched.perfMap = new Map();
	sched.perfLoaded = new Map();
	sched.perfDirty = new Map();
	sched.lastSeenRevision = new Map();
	sched.lastDecayAt = new Map();
	sched.dispatchFailures = new Map();
	sched.inProgressSince = new Map();
	sched.timeoutNotified = new Map();
	sched.stats = new Map();
	sched.alertLog = [];
	sched.decisionLog = new Map();
	sched.ctx = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		agents: { get() { return undefined; }, list() { return []; } },
	};
	return sched;
}

function makeState(overrides = {}) {
	const defaults = [
		{ id: "alice-1", name: "alice", phase: "active", description: "refactor database" },
		{ id: "bob-1", name: "bob", phase: "active", description: "frontend monitor" },
	];
	const members = defaults.map((d) =>
		(overrides.members ?? []).find((o) => o.id === d.id) ?? d
	).concat(
		(overrides.members ?? []).filter((o) => !defaults.some((d) => d.id === o.id))
	);
	return { id: "lead-1", members, tasks: overrides.tasks ?? [] };
}

// ─── checkTimeouts: F10 泄漏回归 ─────────────────────────────────────

test("checkTimeouts: release strips ownerId → prefix cleanup removes ALL owner keys", () => {
	const sched = makeScheduler();
	// alice was working on task-1 for 40 min (past 30min timeout)
	const past = Date.now() - 40 * 60 * 1000;
	sched.inProgressSince.set("lead-1:task-1:alice-1", past);
	// Now release strips ownerId — task becomes pending without owner
	const state = makeState({
		tasks: [{ id: "task-1", ownerId: undefined, status: "pending", revision: 2, subject: "fix", description: "" }],
	});
	sched.checkTimeouts(state, "lead-1", { steer() {} });
	// Both alice's tracking entries must be gone — prefix match by taskId
	assert.equal(sched.inProgressSince.has("lead-1:task-1:alice-1"), false);
	assert.equal(sched.inProgressSince.has("lead-1:task-1:unassigned"), false);
});

test("checkTimeouts: timeoutNotified also cleaned by prefix after owner stripped", () => {
	const sched = makeScheduler();
	sched.inProgressSince.set("lead-1:task-1:alice-1", Date.now() - 40 * 60 * 1000);
	sched.timeoutNotified.set("lead-1:task-1:alice-1", { count: 1, ts: Date.now() });
	const state = makeState({
		tasks: [{ id: "task-1", ownerId: undefined, status: "pending", revision: 2, subject: "fix", description: "" }],
	});
	sched.checkTimeouts(state, "lead-1", { steer() {} });
	assert.equal(sched.timeoutNotified.has("lead-1:task-1:alice-1"), false);
});

test("checkTimeouts: reassign to new owner → old key stays (task still in_progress), new owner gets fresh timer", () => {
	const sched = makeScheduler();
	// alice was timing out
	sched.inProgressSince.set("lead-1:task-1:alice-1", Date.now() - 40 * 60 * 1000);
	// reassign to bob — ownerId changes, task still in_progress → if branch
	const state = makeState({
		tasks: [{ id: "task-1", ownerId: "bob-1", status: "in_progress", revision: 2, subject: "fix", description: "" }],
	});
	sched.checkTimeouts(state, "lead-1", { steer() {} });
	// Old alice key STAYS — task is still in_progress, else branch not reached.
	// This is correct: the task is still running, just under a different owner.
	// Bob's key gets its own fresh timestamp.
	assert.equal(sched.inProgressSince.has("lead-1:task-1:alice-1"), true);
	assert.equal(sched.inProgressSince.has("lead-1:task-1:bob-1"), true);
	// Bob's timer is fresh (just set) — won't trigger timeout
	const elapsed = Date.now() - sched.inProgressSince.get("lead-1:task-1:bob-1");
	assert.ok(elapsed < 5000, "bob's timer should be fresh");
});

test("checkTimeouts: task-1 prefix does not clobber task-10 keys", () => {
	const sched = makeScheduler();
	sched.inProgressSince.set("lead-1:task-10:alice-1", Date.now() - 40 * 60 * 1000);
	sched.inProgressSince.set("lead-1:task-1:alice-1", Date.now() - 40 * 60 * 1000);
	// task-1 leaves in_progress but task-10 still running
	const state = makeState({
		tasks: [
			{ id: "task-1", ownerId: undefined, status: "pending", revision: 2, subject: "a", description: "" },
			{ id: "task-10", ownerId: "alice-1", status: "in_progress", revision: 1, subject: "b", description: "" },
		],
	});
	sched.checkTimeouts(state, "lead-1", { steer() {} });
	// task-1 key cleaned, task-10 untouched
	assert.equal(sched.inProgressSince.has("lead-1:task-1:alice-1"), false);
	assert.equal(sched.inProgressSince.has("lead-1:task-10:alice-1"), true);
});

test("checkTimeouts: second timeout alert fires after first notification cleaned by release+reclaim", () => {
	const sched = makeScheduler();
	const steers = [];
	const lead = { steer(msg) { steers.push(msg); } };
	// alice does task-1 for 40 min → timeout fires
	sched.inProgressSince.set("lead-1:task-1:alice-1", Date.now() - 40 * 60 * 1000);
	const running = makeState({
		tasks: [{ id: "task-1", ownerId: "alice-1", status: "in_progress", revision: 1, subject: "fix", description: "" }],
	});
	sched.checkTimeouts(running, "lead-1", lead);
	assert.equal(steers.length, 1); // first timeout alert
	const entry = sched.timeoutNotified.get("lead-1:task-1:alice-1");
	assert.equal(entry.count, 1);
	assert.ok(entry.ts > 0);

	// Release → ownerId stripped → prefix cleanup removes tracking
	const released = makeState({
		tasks: [{ id: "task-1", ownerId: undefined, status: "pending", revision: 2, subject: "fix", description: "" }],
	});
	sched.checkTimeouts(released, "lead-1", lead);
	assert.equal(sched.inProgressSince.has("lead-1:task-1:alice-1"), false);
	assert.equal(sched.timeoutNotified.has("lead-1:task-1:alice-1"), false);

	// Alice re-claims → new timer → second timeout fires
	sched.inProgressSince.set("lead-1:task-1:alice-1", Date.now() - 40 * 60 * 1000);
	const reclaimed = makeState({
		tasks: [{ id: "task-1", ownerId: "alice-1", status: "in_progress", revision: 3, subject: "fix", description: "" }],
	});
	sched.checkTimeouts(reclaimed, "lead-1", lead);
	assert.equal(steers.length, 2); // SECOND timeout alert — F10 bug would have suppressed this
});

// ─── perfMap 持久化：load/save 往返 ──────────────────────────────────

test("perfMap round-trip: save → new instance → load → same data", () => {
	const sched = makeScheduler();
	const tmpDir = mkdtempSync(join(tmpdir(), "dsh-perf-"));
	// Override perfPath to use temp dir
	sched.perfPath = (rootId) => join(tmpDir, `${rootId}.perf.json`);

	// Build perf data
	sched.perfMap.set("alice-1", {
		completed: 3,
		timeouts: 1,
		capabilities: new Set(["修复", "fix"]),
		seen: new Set(["task-1:completed", "task-2:completed", "task-1:timeout"]),
	});
	sched.perfDirty.set("lead-1", true);
	sched.savePerf("lead-1");

	// New instance loads the same file
	const sched2 = makeScheduler();
	sched2.perfPath = (rootId) => join(tmpDir, `${rootId}.perf.json`);
	sched2.loadPerf("lead-1");
	const perf = sched2.perfMap.get("alice-1");
	assert.equal(perf.completed, 3);
	assert.equal(perf.timeouts, 1);
	assert.ok(perf.capabilities.has("修复"));
	assert.ok(perf.seen.has("task-1:completed"));
});

test("perfMap load: missing file → empty perfMap, no throw", () => {
	const sched = makeScheduler();
	sched.perfPath = () => join(tmpdir(), "nonexistent-dir", "nope.perf.json");
	sched.loadPerf("lead-1");
	assert.equal(sched.perfMap.size, 0);
});

test("perfMap load: corrupted JSON → empty perfMap, no throw", () => {
	const sched = makeScheduler();
	const tmpDir = mkdtempSync(join(tmpdir(), "dsh-perf-"));
	const badFile = join(tmpDir, "lead-1.perf.json");
	writeFileSync(badFile, "{{{{not json", "utf8");
	sched.perfPath = () => badFile;
	sched.loadPerf("lead-1");
	assert.equal(sched.perfMap.size, 0);
});

test("perfMap save: seen truncated to last 200 entries", () => {
	const sched = makeScheduler();
	const tmpDir = mkdtempSync(join(tmpdir(), "dsh-perf-"));
	sched.perfPath = (rootId) => join(tmpDir, `${rootId}.perf.json`);
	const seen = new Set();
	for (let i = 0; i < 250; i++) seen.add(`task-${i}:completed`);
	sched.perfMap.set("alice-1", { completed: 250, timeouts: 0, capabilities: new Set(), seen });
	sched.perfDirty.set("lead-1", true);
	sched.savePerf("lead-1");
	const raw = JSON.parse(readFileSync(join(tmpDir, "lead-1.perf.json"), "utf8"));
	assert.ok(raw.members["alice-1"].seen.length <= 200);
});

// ─── perfBonus F12 回归：负分穿透 ────────────────────────────────────

test("buildCapabilityHint: zero-completed member with timeouts gets penalty (F14)", () => {
	const sched = makeScheduler();
	// alice has 3 timeouts, 0 completions → perfBonus = max(-0.5*3, -kwScore)
	sched.perfMap.set("alice-1", {
		completed: 0, timeouts: 3,
		capabilities: new Set(), seen: new Set(),
	});
	const state = makeState();
	const task = {
		id: "task-1", ownerId: undefined, status: "pending", revision: 1,
		subject: "refactor database", description: "",
		blockedBy: [],
	};
	// alice matches on "refactor" and "database" (SPECIFIC keywords)
	const hintResult = sched.buildCapabilityHint(task, state, "lead-1");
	assert.ok(hintResult !== undefined, "hint should exist for SPECIFIC keyword match");
	const aliceLine = hintResult.suggestions.find((s) => s.includes("alice"));
	assert.ok(aliceLine !== undefined, "alice should appear in hint");
	assert.ok(aliceLine.includes("⚠️超时"), "expected timeout penalty annotation");
});

// ─── O5: timeoutAlertIntervalMs 重复告警 ──────────────────────────────

test("O5: timeoutAlertIntervalMs=0 → single alert only (default)", () => {
	const sched = makeScheduler({ config: { timeoutAlertIntervalMs: 0 } });
	const steers = [];
	const lead = { steer(msg) { steers.push(msg); } };
	sched.inProgressSince.set("lead-1:task-1:alice-1", Date.now() - 40 * 60 * 1000);
	const state = makeState({
		tasks: [{ id: "task-1", ownerId: "alice-1", status: "in_progress", revision: 1, subject: "fix", description: "" }],
	});
	sched.checkTimeouts(state, "lead-1", lead);
	assert.equal(steers.length, 1);
	// Second pass — same task, still timed out, but no re-alert (interval=0)
	sched.inProgressSince.set("lead-1:task-1:alice-1", Date.now() - 80 * 60 * 1000);
	sched.checkTimeouts(state, "lead-1", lead);
	assert.equal(steers.length, 1, "interval=0 should not re-alert");
});

test("O5: timeoutAlertIntervalMs>0 → re-alert after interval with count", () => {
	const sched = makeScheduler({ config: { timeoutAlertIntervalMs: 5 * 60 * 1000 } }); // 5min interval
	const steers = [];
	const lead = { steer(msg) { steers.push(msg); } };
	const state = makeState({
		tasks: [{ id: "task-1", ownerId: "alice-1", status: "in_progress", revision: 1, subject: "fix", description: "" }],
	});
	// First timeout
	sched.inProgressSince.set("lead-1:task-1:alice-1", Date.now() - 40 * 60 * 1000);
	sched.checkTimeouts(state, "lead-1", lead);
	assert.equal(steers.length, 1);
	assert.equal(sched.timeoutNotified.get("lead-1:task-1:alice-1").count, 1);

	// 3 min later — within interval, no re-alert
	const firstAlertTs = sched.timeoutNotified.get("lead-1:task-1:alice-1").ts;
	sched.timeoutNotified.set("lead-1:task-1:alice-1", { count: 1, ts: firstAlertTs });
	// Simulate 3min passing — can't manipulate Date.now, so verify via ts check
	// The entry's ts is recent → shouldAlert would be false (3min < 5min interval)
	// Just verify count stays 1 after a quick second call
	sched.checkTimeouts(state, "lead-1", lead);
	assert.equal(steers.length, 1, "within interval → no re-alert");

	// Force expired alert — backdate ts beyond interval
	sched.timeoutNotified.set("lead-1:task-1:alice-1", {
		count: 1,
		ts: Date.now() - 6 * 60 * 1000, // 6 min ago > 5 min interval
	});
	sched.checkTimeouts(state, "lead-1", lead);
	assert.equal(steers.length, 2, "interval expired → second alert");
	assert.equal(sched.timeoutNotified.get("lead-1:task-1:alice-1").count, 2);
	// Verify the message contains "第 2 次告警"
	const msg = steers[1].content[0].text;
	assert.ok(msg.includes("第 2 次"), "expected '第 2 次' in re-alert message");
});
