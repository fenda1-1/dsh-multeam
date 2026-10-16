import { bundle } from './support.mjs'
import test from "node:test";
import assert from "node:assert/strict";

/**
 * ④ scheduler 任务 ready→steer 唤醒 owner、retry 上限告警。
 * 用真实 TeamScheduler 实例 + mock ctx，验证：
 *   - ready 任务 sendMessage 失败 → recordGroupDispatchFailure 递增 retryCount
 *   - 达到 retryLimit → 一次性 steer lead 耗尽告警（不再发普通唤醒）
 *   - 组内多任务只发一次耗尽告警（coalesced）
 */

const mod = bundle;
const TeamScheduler = mod.TeamScheduler ?? mod.default;

function makeScheduler(overrides = {}) {
	const sched = Object.create(TeamScheduler.prototype);
	sched.config = {
		capabilityMatch: true, timeoutDetection: false, timeoutMs: 300000,
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
	sched.passCount = 0;
	sched.lastPassAt = 0;
	sched.stats = new Map();
	sched.alertLog = [];
	sched.decisionLog = new Map();
	sched.steerLog = [];
	sched.sendLog = [];
	sched.ctx = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		agents: { get(id) { return overrides.agents?.[id]; }, list() { return overrides.agentList ?? []; } },
		agentTeams: { async sendMessage() { sched.sendLog.push(arguments[1]); } },
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

// ── retry 耗尽：完整失败→重试→耗尽→告警链路 ──

test("retry: first failure increments retryCount, no exhausted steer", async () => {
	const steered = [];
	const sched = makeScheduler({
		agents: { "lead-1": { steer(msg) { steered.push(msg); } } },
		sessionProjections: {
			stateOf() {
				return {
					id: "lead-1", failure: undefined,
					members: [{ id: "alice-1", name: "alice", phase: "active", description: "refactor" }],
					tasks: [{ id: "task-1", ownerId: "alice-1", status: "pending", subject: "A", blockedBy: [], revision: 1 }],
				};
			},
		},
	});
	// sendMessage 永远失败
	sched.ctx.agentTeams.sendMessage = async () => { throw new Error("agent disposed"); };

	await sched.runPass({ id: "lead-1" });
	const key = "lead-1:task-1:alice-1";
	assert.equal(sched.retryCount.get(key), 1, "retry count incremented");
	assert.equal(sched.retryExhausted.has(key), false, "not exhausted yet");
	assert.equal(steered.length, 0, "no exhausted steer on first failure");
	// retryLastError 只在组耗尽时记录（L757-759），首次失败不记录
	assert.equal(sched.retryLastError.get(key), undefined);
});

test("retry: retries up to limit then steers lead with exhaustion alert", async () => {
	const steered = [];
	const sched = makeScheduler({
		agents: { "lead-1": { steer(msg) { steered.push(msg); } } },
		sessionProjections: {
			stateOf() {
				return {
					id: "lead-1", failure: undefined,
					members: [{ id: "alice-1", name: "alice", phase: "active", description: "refactor" }],
					tasks: [{ id: "task-1", ownerId: "alice-1", status: "pending", subject: "A", blockedBy: [], revision: 1 }],
				};
			},
		},
	});
	sched.ctx.agentTeams.sendMessage = async () => { throw new Error("gone"); };

	// Pass 1: fail → retryCount=1
	await sched.runPass({ id: "lead-1" });
	assert.equal(sched.retryCount.get("lead-1:task-1:alice-1"), 1);
	assert.equal(steered.length, 0);

	// Pass 2: fail → retryCount=2 (at limit) → still no exhausted steer yet
	// because recordGroupDispatchFailure checks used < retryLimit
	// used=1 < 2 → retryCount=2, no exhaust yet
	await sched.runPass({ id: "lead-1" });
	assert.equal(sched.retryCount.get("lead-1:task-1:alice-1"), 2);
	assert.equal(steered.length, 0, "still not exhausted at limit boundary");

	// Pass 3: fail → used=2 >= retryLimit=2 → exhausted → steer lead once
	await sched.runPass({ id: "lead-1" });
	assert.equal(steered.length, 1, "exhaustion steer after retry limit");
	const text = steered[0]?.content?.[0]?.text ?? "";
	assert.ok(text.includes("重试") || text.includes("exhausted") || text.includes("失败"), "steer should be retry exhaustion alert");
	assert.equal(steered[0].source?.alert, "retry-exhausted");
	assert.equal(sched.retryExhausted.get("lead-1:task-1:alice-1"), true);
});

test("retry: multiple tasks same owner coalesce into single exhaustion alert", async () => {
	const steered = [];
	const sched = makeScheduler({
		agents: { "lead-1": { steer(msg) { steered.push(msg); } } },
		sessionProjections: {
			stateOf() {
				return {
					id: "lead-1", failure: undefined,
					members: [{ id: "alice-1", name: "alice", phase: "active", description: "refactor" }],
					tasks: [
						{ id: "task-1", ownerId: "alice-1", status: "pending", subject: "A", blockedBy: [], revision: 1 },
						{ id: "task-2", ownerId: "alice-1", status: "pending", subject: "B", blockedBy: [], revision: 1 },
					],
				};
			},
		},
	});
	sched.ctx.agentTeams.sendMessage = async () => { throw new Error("gone"); };

	// 3 passes to exhaust
	for (let i = 0; i < 3; i++) await sched.runPass({ id: "lead-1" });
	// Both tasks in same owner group → single steer for the group
	assert.equal(steered.length, 1, "coalesced exhaustion steer");
	assert.equal(steered[0].source?.alert, "retry-exhausted");
	assert.equal(sched.retryExhausted.get("lead-1:task-1:alice-1"), true);
	assert.equal(sched.retryExhausted.get("lead-1:task-2:alice-1"), true);
});

test("retry: dispatch failure recorded in dispatchFailures for capability penalty", async () => {
	const sched = makeScheduler({
		agents: { "lead-1": { steer() {} } },
		sessionProjections: {
			stateOf() {
				return {
					id: "lead-1", failure: undefined,
					members: [{ id: "alice-1", name: "alice", phase: "active", description: "refactor" }],
					tasks: [{ id: "task-1", ownerId: "alice-1", status: "pending", subject: "A", blockedBy: [], revision: 1 }],
				};
			},
		},
	});
	sched.ctx.agentTeams.sendMessage = async () => { throw new Error("gone"); };
	await sched.runPass({ id: "lead-1" });
	const rec = sched.dispatchFailures.get("alice-1");
	assert.ok(rec !== undefined, "dispatch failure recorded");
	assert.equal(typeof rec.count, "number", "count is numeric");
	assert.ok(rec.count >= 1, "at least one failure recorded");
	// D10: perfMap 同步写回
	const perf = sched.perfMap.get("alice-1");
	assert.ok(perf !== undefined, "perfMap entry created for dispatch failure");
	assert.equal(perf.dispatchFailures.count, rec.count);
});

test("retry: successful dispatch clears retryCount and retryExhausted", async () => {
	const sent = [];
	const sched = makeScheduler({
		agents: { "lead-1": { steer() {} } },
		sessionProjections: {
			stateOf() {
				return {
					id: "lead-1", failure: undefined,
					members: [{ id: "alice-1", name: "alice", phase: "active", description: "refactor" }],
					tasks: [{ id: "task-1", ownerId: "alice-1", status: "pending", subject: "A", blockedBy: [], revision: 1 }],
				};
			},
		},
	});
	// First: fail once
	sched.ctx.agentTeams.sendMessage = async () => { throw new Error("gone"); };
	await sched.runPass({ id: "lead-1" });
	assert.equal(sched.retryCount.get("lead-1:task-1:alice-1"), 1);

	// Then: succeed → clears retry tracking
	sched.ctx.agentTeams.sendMessage = async (agent, env) =>
		sent.push({ target: env.target, text: env.content?.[0]?.text ?? "" });
	// Clear notified so the task is re-dispatched
	sched.notified.delete("lead-1:task-1:alice-1");
	await sched.runPass({ id: "lead-1" });
	assert.equal(sent.length, 1);
	assert.equal(sched.retryCount.has("lead-1:task-1:alice-1"), false, "retry cleared after success");
	assert.equal(sched.retryExhausted.has("lead-1:task-1:alice-1"), false);
	assert.equal(sched.retryLastError.has("lead-1:task-1:alice-1"), false);
});

test("retry: retryLastError forwarded in NOTIFY_MESSAGE after group exhaustion", async () => {
	// retryLastError 只在组耗尽时写入（L757-759），NOTIFY_MESSAGE 把它附在
	// 唤醒文本末尾。首次失败不记录——需跑满 retryLimit 后验证 error 进入消息。
	const sent = [];
	const sched = makeScheduler({
		agents: { "lead-1": { steer() {} } },
		sessionProjections: {
			stateOf() {
				return {
					id: "lead-1", failure: undefined,
					members: [{ id: "alice-1", name: "alice", phase: "active", description: "refactor" }],
					tasks: [{ id: "task-1", ownerId: "alice-1", status: "pending", subject: "A", blockedBy: [], revision: 1 }],
				};
			},
		},
	});
	// 3 次失败 → 耗尽并记录 lastError
	sched.ctx.agentTeams.sendMessage = async () => { throw new Error("mailbox full"); };
	for (let i = 0; i < 3; i++) await sched.runPass({ id: "lead-1" });
	assert.equal(sched.retryLastError.get("lead-1:task-1:alice-1"), "mailbox full");

	// 清 notified + retryExhausted 模拟重试成功
	sched.notified.delete("lead-1:task-1:alice-1");
	sched.retryExhausted.delete("lead-1:task-1:alice-1");
	sched.retryCount.delete("lead-1:task-1:alice-1");
	sched.ctx.agentTeams.sendMessage = async (agent, env) =>
		sent.push(env.content?.[0]?.text ?? "");
	await sched.runPass({ id: "lead-1" });
	assert.equal(sent.length, 1);
	assert.ok(sent[0].includes("mailbox full"), "retry message should include last error");
	assert.ok(sent[0].includes("上次派发失败原因"), "message should label the error");
});
