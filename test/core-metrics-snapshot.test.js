import { bundle } from './support.mjs'
import test from "node:test";
import assert from "node:assert/strict";

/**
 * ⑥ metricsSnapshot 返回 counters + gauges 完整结构。
 * metricsSnapshot 聚合 this.metrics（10 个计数器）与实时 gauge 值
 * （journalQueueDepth / pendingMessages / activeTasks），teamStatus 同时
 * 透出 journalQueueDepth 与 metrics。走真实路径：
 * 手工构造 TeamService（Object.create + 全量依赖）→ metricsSnapshot /
 * teamStatus → 结构断言。
 */

const { TeamService } = bundle;

function makeService(metricsOverrides = {}, journalDepth = 0, pendingMessages = [], activeTasks = []) {
	const metrics = {
		messagesSent: 0,
		messagesDelivered: 0,
		messagesDeadLettered: 0,
		tasksCreated: 0,
		tasksCompleted: 0,
		tasksReopened: 0,
		dispatchFailures: 0,
		memberReleases: 0,
		waitCalls: 0,
		writeScopeConflicts: 0,
		...metricsOverrides,
	};
	const svc = Object.create(TeamService.prototype);
	svc.journal = { queueDepth: () => journalDepth };
	svc.metrics = metrics;
	svc.roster = { membership: () => ({ root: { id: "lead-1" } }) };
	// pendingMessages / activeTasks come from journal.state
	const pending = [...pendingMessages];
	const tasks = [...activeTasks];
	svc.journal = {
		queueDepth: () => journalDepth,
		state: () => ({
			id: "team-1",
			messages: pending,
			delivered: [],
			tasks,
		}),
	};
	svc.roster = { membership: () => ({ root: { id: "lead-1" } }) };
	return svc;
}

const COUNTER_KEYS = [
	"messagesSent", "messagesDelivered", "messagesDeadLettered",
	"tasksCreated", "tasksCompleted", "tasksReopened",
	"dispatchFailures", "memberReleases", "waitCalls",
	"writeScopeConflicts",
];

test("metricsSnapshot: returns all 10 counters and 3 gauges", () => {
	const svc = makeService(
		{ messagesSent: 5, tasksCreated: 3, waitCalls: 12 },
		7, // journalQueueDepth
		[{ id: "msg-1" }, { id: "msg-2" }], // pendingMessages
		[{ id: "task-1", status: "in_progress" }], // activeTasks
	);

	const snap = svc.metricsSnapshot({ id: "lead-1" });

	// counters: a shallow copy of this.metrics
	assert.deepEqual(Object.keys(snap.counters).sort(), COUNTER_KEYS.sort(), "all 10 counters");
	assert.equal(snap.counters.messagesSent, 5);
	assert.equal(snap.counters.tasksCreated, 3);
	assert.equal(snap.counters.waitCalls, 12);
	assert.equal(snap.counters.messagesDelivered, 0, "untouched counter stays 0");

	// gauges: computed at snapshot time
	assert.equal(snap.gauges.journalQueueDepth, 7);
	assert.equal(snap.gauges.pendingMessages, 2);
	assert.equal(snap.gauges.activeTasks, 1);

	// top-level teamId comes from state.id, stringified
	assert.equal(snap.teamId, "team-1");
});

test("metricsSnapshot: counters default to zero, gauges reflect live state", () => {
	const svc = makeService({}, 0, [], []);
	const snap = svc.metricsSnapshot({ id: "lead-1" });
	for (const key of COUNTER_KEYS) {
		assert.equal(snap.counters[key], 0, `${key} defaults to 0`);
	}
	assert.equal(snap.gauges.journalQueueDepth, 0);
	assert.equal(snap.gauges.pendingMessages, 0);
	assert.equal(snap.gauges.activeTasks, 0);
});

test("metricsSnapshot: activeTasks counts only in_progress", () => {
	const svc = makeService({}, 0, [], [
		{ id: "task-1", status: "completed" },
		{ id: "task-2", status: "in_progress" },
		{ id: "task-3", status: "pending" },
		{ id: "task-4", status: "in_progress" },
	]);
	const snap = svc.metricsSnapshot({ id: "lead-1" });
	assert.equal(snap.gauges.activeTasks, 2, "in_progress only, not pending");
});

test("metricsSnapshot: delivered messages do not count as pendingMessages", () => {
	const svc = makeService({}, 0,
		[{ id: "msg-1" }, { id: "msg-2" }, { id: "msg-3" }],
		[],
	);
	// Mark msg-1 and msg-3 as delivered in the state
	svc.journal.state = () => ({
		messages: [{ id: "msg-1" }, { id: "msg-2" }, { id: "msg-3" }],
		delivered: ["msg-1", "msg-3"],
		tasks: [],
	});
	const snap = svc.metricsSnapshot({ id: "lead-1" });
	assert.equal(snap.gauges.pendingMessages, 1, "only msg-2 is pending");
});

test("metricsSnapshot: counters object is a copy (mutations don't leak)", () => {
	const svc = makeService({ messagesSent: 1 });
	const snap = svc.metricsSnapshot({ id: "lead-1" });
	snap.counters.messagesSent = 999;
	assert.equal(svc.metrics.messagesSent, 1, "snapshot copy does not mutate service metrics");
});
