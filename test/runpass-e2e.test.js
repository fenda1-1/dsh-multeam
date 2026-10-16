import { bundle } from './support.mjs'
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mod = bundle;
const TeamSchedulerService = mod.TeamScheduler ?? mod.default;

function makeScheduler(overrides = {}) {
	const proto = TeamSchedulerService.prototype;
	const sched = Object.create(proto);
	sched.config = {
		capabilityMatch: true, timeoutDetection: true, timeoutMs: 300000,
		loadBalance: false, priority: false, retryLimit: 2,
		notifyUnassigned: true,
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
	sched.notified = new Map();
	sched.retryCount = new Map();
	sched.retryExhausted = new Map();
	sched.retryLastError = new Map();
	sched.failureWarned = new Set();
	sched.tails = new Map();
	sched.coalescePending = new Map();
	sched.steerLog = []; // collect steer calls
	sched.sendLog = []; // collect sendMessage calls
	sched.ctx = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		agents: {
			get(id) { return overrides.agents?.[id] ?? undefined; },
			list() { return overrides.agentList ?? []; },
		},
		agentTeams: {
			async sendMessage(target, text) {
				sched.sendLog.push({ target, text });
			},
		},
		sessionProjections: overrides.sessionProjections,
	};
	return sched;
}

function makeState(overrides = {}) {
	return {
		id: "lead-1",
		members: overrides.members ?? [],
		tasks: overrides.tasks ?? [],
	};
}

// ── G1: runPass 端到端 ──

test("runPass: dispatches ready pending task to owner via sendMessage", async () => {
	const sent = [];
	const leadAgent = { steer() {} };
	const sched = makeScheduler({
		agents: { "lead-1": leadAgent },
		sessionProjections: {
			stateOf(session, key) {
				return {
					id: "lead-1", failure: undefined,
					members: [{ id: "alice-1", name: "alice", phase: "active", description: "refactor" }],
					tasks: [{
						id: "task-1", ownerId: "alice-1", status: "pending",
						subject: "refactor schema", blockedBy: [], revision: 1,
					}],
				};
			},
		},
	});
	sched.ctx.agentTeams.sendMessage = async (agent, envelope) =>
		sent.push({ target: envelope.target, text: envelope.content?.[0]?.text ?? "" });
	await sched.runPass({ id: "lead-1" });
	assert.equal(sent.length, 1, "should send one dispatch message");
	assert.equal(sent[0].target, "alice");
	assert.ok(sent[0].text.includes("task-1"), "message should reference task id");
});

test("runPass: unassigned ready task steers lead", async () => {
	const steered = [];
	const sched = makeScheduler({
		agents: { "lead-1": { steer(msg) { steered.push(msg); } } },
		sessionProjections: {
			stateOf() {
				return {
					id: "lead-1", failure: undefined,
					members: [{ id: "alice-1", name: "alice", phase: "active", description: "refactor" }],
					tasks: [{
						id: "task-1", ownerId: undefined, status: "pending",
						subject: "refactor schema", blockedBy: [], revision: 1,
					}],
				};
			},
		},
	});
	await sched.runPass({ id: "lead-1" });
	assert.equal(steered.length, 1, "should steer lead once");
	const text = steered[0]?.content?.[0]?.text ?? "";
	assert.ok(text.includes("task-1"), "steer should reference task");
	assert.ok(text.includes("未分配") || text.includes("尚未分配"), "steer should mention unassigned");
});

test("runPass: orphan task steers lead with owner phase info", async () => {
	const steered = [];
	const sched = makeScheduler({
		agents: { "lead-1": { steer(msg) { steered.push(msg); } } },
		sessionProjections: {
			stateOf() {
				return {
					id: "lead-1", failure: undefined,
					members: [
						{ id: "alice-1", name: "alice", phase: "released", description: "refactor" },
					],
					tasks: [{
						id: "task-1", ownerId: "alice-1", status: "in_progress",
						subject: "refactor schema", blockedBy: [], revision: 1,
					}],
				};
			},
		},
	});
	await sched.runPass({ id: "lead-1" });
	assert.ok(steered.length >= 1, "should steer lead about orphan");
	const text = steered[0]?.content?.[0]?.text ?? "";
	assert.ok(text.includes("alice"), "orphan message should name owner");
	assert.ok(text.includes("released"), "orphan message should include phase");
});

test("runPass: failure state blocks all dispatch", async () => {
	const sent = [];
	const sched = makeScheduler({
		agents: { "lead-1": { steer() {} } },
		sessionProjections: {
			stateOf() {
				return {
					id: "lead-1", failure: { error: "projection broken" },
					members: [],
					tasks: [{
						id: "task-1", ownerId: "alice-1", status: "pending",
						subject: "test", blockedBy: [], revision: 1,
					}],
				};
			},
		},
	});
	sched.ctx.agentTeams.sendMessage = async (agent, envelope) =>
		sent.push({ target: envelope.target, text: envelope.content?.[0]?.text ?? "" });
	await sched.runPass({ id: "lead-1" });
	assert.equal(sent.length, 0, "no dispatch on failure");
	// failure warning steer is allowed once (failureWarned dedup)
});

test("runPass: blocked task does not dispatch until blocker completes", async () => {
	const sent = [];
	const sched = makeScheduler({
		agents: { "lead-1": { steer() {} } },
		sessionProjections: {
			stateOf() {
				return {
					id: "lead-1", failure: undefined,
					members: [{ id: "alice-1", name: "alice", phase: "active", description: "refactor" }],
					tasks: [
						{ id: "task-1", ownerId: "alice-1", status: "pending", subject: "A", blockedBy: ["task-2"], revision: 1 },
						{ id: "task-2", ownerId: "alice-1", status: "in_progress", subject: "B", blockedBy: [], revision: 1 },
					],
				};
			},
		},
	});
	sched.ctx.agentTeams.sendMessage = async (agent, envelope) =>
		sent.push({ target: envelope.target, text: envelope.content?.[0]?.text ?? "" });
	await sched.runPass({ id: "lead-1" });
	// task-2 is in_progress → assignedRunning → needs wake.
	// task-1 is blocked → should NOT appear in the dispatch.
	assert.equal(sent.length, 1, "in_progress blocker should dispatch");
	assert.ok(!sent[0].text.includes("task-1"), "blocked task-1 should not be in dispatch");
	assert.ok(sent[0].text.includes("task-2"), "in_progress task-2 should be in dispatch");
});

test("runPass: coalesces multiple ready tasks for same owner", async () => {
	const sent = [];
	const sched = makeScheduler({
		agents: { "lead-1": { steer() {} } },
		sessionProjections: {
			stateOf() {
				return {
					id: "lead-1", failure: undefined,
					members: [{ id: "alice-1", name: "alice", phase: "active", description: "refactor" }],
					tasks: [
						{ id: "task-1", ownerId: "alice-1", status: "pending", subject: "A", blockedBy: [], revision: 1 },
						{ id: "task-2", ownerId: "alice-1", status: "pending", subject: "B", blockedBy: [], revision: 1 },
						{ id: "task-3", ownerId: "alice-1", status: "pending", subject: "C", blockedBy: [], revision: 1 },
					],
				};
			},
		},
	});
	sched.ctx.agentTeams.sendMessage = async (agent, envelope) =>
		sent.push({ target: envelope.target, text: envelope.content?.[0]?.text ?? "" });
	await sched.runPass({ id: "lead-1" });
	assert.equal(sent.length, 1, "should coalesce into one message");
	assert.ok(sent[0].text.includes("task-1") && sent[0].text.includes("task-2") && sent[0].text.includes("task-3"),
		"message should list all three tasks");
});

// ── G2: schedulePass 真代码路径 ──

test("schedulePass: N concurrent calls coalesce into at most 2 passes", async () => {
	let passCount = 0;
	const sched = makeScheduler({
		sessionProjections: {
			stateOf() { return { id: "lead-1", failure: undefined, members: [], tasks: [] }; },
		},
	});
	const origRunPass = sched.runPass.bind(sched);
	sched.runPass = async (session) => {
		passCount++;
		// Small delay so subsequent schedulePass calls arrive while this pass runs.
		await new Promise((r) => setTimeout(r, 10));
		return origRunPass(session);
	};
	const session = { id: "lead-1" };
	// coalescePending is a boolean flag — N rapid calls during pass 1 all fold
	// into ONE coalesced re-run, not N re-runs.
	const p1 = sched.schedulePass(session);
	const p2 = sched.schedulePass(session);
	const p3 = sched.schedulePass(session);
	const p4 = sched.schedulePass(session);
	await Promise.all([p1, p2, p3, p4]);
	// Allow the coalesced re-run to settle.
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(passCount, 2, "4 concurrent schedulePass should coalesce into 2 passes");
});

test("schedulePass: serial calls do not coalesce", async () => {
	let passCount = 0;
	const sched = makeScheduler({
		sessionProjections: {
			stateOf() { return { id: "lead-1", failure: undefined, members: [], tasks: [] }; },
		},
	});
	const origRunPass = sched.runPass.bind(sched);
	sched.runPass = async (session) => {
		passCount++;
		return origRunPass(session);
	};
	const session = { id: "lead-1" };
	await sched.schedulePass(session);
	await sched.schedulePass(session);
	assert.equal(passCount, 2, "serial schedulePass should not coalesce");
});

// ── G3: buildLoadInfo ──

test("buildLoadInfo: shows per-member in-progress counts", () => {
	const sched = makeScheduler({ config: { loadBalance: true } });
	const state = makeState({
		members: [
			{ id: "alice-1", name: "alice", phase: "active" },
			{ id: "bob-1", name: "bob", phase: "active" },
			{ id: "carol-1", name: "carol", phase: "released" },
		],
		tasks: [
			{ id: "t1", ownerId: "alice-1", status: "in_progress" },
			{ id: "t2", ownerId: "alice-1", status: "in_progress" },
			{ id: "t3", ownerId: "bob-1", status: "in_progress" },
			{ id: "t4", ownerId: "carol-1", status: "in_progress" }, // released — excluded
			{ id: "t5", ownerId: "lead-1", status: "in_progress" }, // lead — excluded
		],
	});
	const info = sched.buildLoadInfo(state, "lead-1");
	assert.ok(info !== undefined, "load info should exist");
	assert.ok(info.includes("alice"), "should mention alice");
	assert.ok(info.includes("bob"), "should mention bob");
	assert.ok(!info.includes("carol"), "released member should be excluded");
	assert.ok(!info.includes("lead"), "lead should be excluded");
});

// ── G4: sortByPriority ──

test("sortByPriority: orders high > medium > low", () => {
	const sched = makeScheduler({ config: { priority: true } });
	const tasks = [
		{ id: "low", priority: "low" },
		{ id: "high", priority: "high" },
		{ id: "medium", priority: "medium" },
		{ id: "default" }, // no priority → medium
	];
	const sorted = sched.sortByPriority(tasks);
	assert.equal(sorted[0].id, "high");
	assert.equal(sorted[1].id, "medium");
	assert.equal(sorted[2].id, "default");
	assert.equal(sorted[3].id, "low");
});

// ── G5: recordGroupDispatchFailure ──

test("recordGroupDispatchFailure: empty group skips steer", () => {
	const steered = [];
	const sched = makeScheduler();
	sched.ctx.agents.get = () => ({ steer(msg) { steered.push(msg); } });
	sched.recordGroupDispatchFailure(
		{ steer(msg) { steered.push(msg); } },
		{ tasks: [], keys: [] },
		"alice"
	);
	assert.equal(steered.length, 0, "empty group should not steer");
});

// ── G6-G8: 断言加强 ──

test("reliability boundary: completed=1 timeouts=0 → 67% (Beta-smoothed)", () => {
	const sched = makeScheduler();
	sched.perfMap.set("alice-1", {
		completed: 1, timeouts: 0,
		capabilities: new Set(["refactor"]), seen: new Set(),
	});
	const state = makeState({
		members: [{ id: "alice-1", name: "alice", phase: "active", description: "refactor" }],
		tasks: [{ id: "t1", ownerId: undefined, status: "pending", subject: "refactor", description: "", blockedBy: [] }],
	});
	const hintResult = sched.buildCapabilityHint(state.tasks[0], state, "lead-1");
	assert.ok(hintResult !== undefined);
	assert.ok(hintResult.suggestions[0].includes("67%"), "reliability=0.67 should show 67% (Beta-smoothed)");
});

test("reliability boundary: completed=1 timeouts=1 → 50%", () => {
	const sched = makeScheduler();
	sched.perfMap.set("alice-1", {
		completed: 1, timeouts: 1,
		capabilities: new Set(["refactor"]), seen: new Set(),
	});
	const state = makeState({
		members: [{ id: "alice-1", name: "alice", phase: "active", description: "refactor" }],
		tasks: [{ id: "t1", ownerId: undefined, status: "pending", subject: "refactor", description: "", blockedBy: [] }],
	});
	const hintResult = sched.buildCapabilityHint(state.tasks[0], state, "lead-1");
	assert.ok(hintResult !== undefined);
	assert.ok(hintResult.suggestions[0].includes("50%"), "reliability=0.5 should show 50%");
	assert.ok(hintResult.suggestions[0].includes("⚠️"), "should show timeout warning");
});

// ── H1: loadPerf 边界场景 ──

test("loadPerf: members is null → empty perfMap", () => {
	const dir = mkdtempSync(join(tmpdir(), "perf-test-"));
	const file = join(dir, "test-session.perf.json");
	writeFileSync(file, JSON.stringify({ version: 1, members: null }));
	const sched = makeScheduler();
	sched.perfPath = () => file;
	sched.loadPerf("test-session");
	assert.equal(sched.perfMap.size, 0, "null members should yield empty perfMap");
	rmSync(dir, { recursive: true, force: true });
});

test("loadPerf: members is string → empty perfMap", () => {
	const dir = mkdtempSync(join(tmpdir(), "perf-test-"));
	const file = join(dir, "test-session.perf.json");
	writeFileSync(file, JSON.stringify({ version: 1, members: "not-an-object" }));
	const sched = makeScheduler();
	sched.perfPath = () => file;
	sched.loadPerf("test-session");
	assert.equal(sched.perfMap.size, 0, "string members should yield empty perfMap");
	rmSync(dir, { recursive: true, force: true });
});

test("loadPerf: rec is null → skipped", () => {
	const dir = mkdtempSync(join(tmpdir(), "perf-test-"));
	const file = join(dir, "test-session.perf.json");
	writeFileSync(file, JSON.stringify({
		version: 1,
		members: { "alice-1": null, "bob-1": { completed: 3, timeouts: 1, capabilities: ["refactor"], seen: [] } },
	}));
	const sched = makeScheduler();
	sched.perfPath = () => file;
	sched.loadPerf("test-session");
	assert.equal(sched.perfMap.size, 1, "null rec should be skipped, valid rec loaded");
	assert.equal(sched.perfMap.get("bob-1").completed, 3);
	rmSync(dir, { recursive: true, force: true });
});

test("loadPerf: rec.capabilities is not array → empty Set", () => {
	const dir = mkdtempSync(join(tmpdir(), "perf-test-"));
	const file = join(dir, "test-session.perf.json");
	writeFileSync(file, JSON.stringify({
		version: 1,
		members: { "alice-1": { completed: 2, timeouts: 0, capabilities: "refactor", seen: [] } },
	}));
	const sched = makeScheduler();
	sched.perfPath = () => file;
	sched.loadPerf("test-session");
	const perf = sched.perfMap.get("alice-1");
	assert.ok(perf !== undefined, "rec should be loaded");
	assert.equal(perf.capabilities.size, 0, "non-array capabilities should degrade to empty Set");
	rmSync(dir, { recursive: true, force: true });
});

test("savePerf: perfDirty false → no write", () => {
	const dir = mkdtempSync(join(tmpdir(), "perf-test-"));
	const file = join(dir, "test-session.perf.json");
	const sched = makeScheduler();
	sched.perfPath = () => file;
	sched.perfMap.set("alice-1", { completed: 5, timeouts: 0, capabilities: new Set(["refactor"]), seen: new Set() });
	// perfDirty not set → should skip write entirely
	sched.savePerf("test-session");
	assert.ok(sched.perfMap.size === 1, "perfMap unchanged");
	assert.ok(!existsSync(file), "file should not be written when not dirty");
	rmSync(dir, { recursive: true, force: true });
});

// ── H2: CJK/ASCII 混合匹配 ──

test("extractCapabilities: CJK+ASCII mixed text matches both", () => {
	const caps = mod.extractCapabilities ?? (() => { throw new Error("extractCapabilities not exported"); });
	// extractCapabilities is module-internal — test via buildCapabilityHint instead.
	const sched = makeScheduler();
	sched.perfMap.set("alice-1", {
		completed: 3, timeouts: 0,
		capabilities: new Set(["refactor", "数据库"]), seen: new Set(),
	});
	const state = makeState({
		members: [{ id: "alice-1", name: "alice", phase: "active", description: "refactor 数据库" }],
		tasks: [{
			id: "t1", ownerId: undefined, status: "pending",
			subject: "refactor 数据库 schema", description: "重构数据库表结构", blockedBy: [],
		}],
	});
	const hintResult = sched.buildCapabilityHint(state.tasks[0], state, "lead-1");
	assert.ok(hintResult !== undefined, "mixed CJK+ASCII should produce hint");
	assert.ok(hintResult.suggestions[0].includes("alice"), "should suggest alice");
	assert.ok(hintResult.suggestions[0].includes("✅"), "should show domain overlap");
});
