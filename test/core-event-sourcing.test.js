import { bundle } from './support.mjs'
import test from "node:test";
import assert from "node:assert/strict";

/**
 * 事件溯源 + session flush 往返（⑧ fsync 路径级验证）。
 * TeamJournal.appendAndFlush 追加事件到 root.session 后经 sessions.flush 落盘；
 * 模拟"崩溃"后用同一批事件重放 teamProjectionDefinition.apply，投影必须一致。
 *
 * 不走 mock stateOf —— 自己实现一个真实的事件总线：session.append 收事件、
 * sessions.flush 落盘到数组（模拟持久化）、sessionProjections.stateOf 从
 * 同一批事件经 teamProjectionDefinition.apply 重放出来。
 * 崩溃 = 丢弃内存投影，只保留已 flush 的事件序列，再从空态重放。
 */

const { teamProjectionDefinition, emptyTeamState } = bundle;
const { TeamJournal } = bundle;

/** 模拟持久化层：session.append 写入内存事件队列，flush 把它们移到 durable */
function makeSessionBackend() {
	/** 未 flush 的 pending 事件（崩溃会丢） */
	const pendingEvents = [];
	/** 已 flush 的 durable 事件（崩溃后仍在） */
	const durableEvents = [];
	return {
		session: {
			append(type, data) {
				pendingEvents.push({ type, data });
			},
		},
		sessions: {
			async flush() {
				durableEvents.push(...pendingEvents.splice(0));
			},
		},
		pendingEvents,
		durableEvents,
	};
}

/** 从 durable 事件重放投影（模拟崩溃后恢复） */
function replayFromDurable(durableEvents, rootId) {
	let state = teamProjectionDefinition.init({ id: rootId });
	for (const event of durableEvents) {
		state = teamProjectionDefinition.apply(state, event);
	}
	return state;
}

function makeCtx(backend) {
	return {
		sessions: backend.sessions,
		sessionProjections: {
			stateOf(_session, key) {
				assert.equal(key, "agentTeam");
				// 真实路径：每次 stateOf 都从 durable 事件重放
				return replayFromDurable(backend.durableEvents, "lead-1");
			},
		},
	};
}

const ROOT = { id: "lead-1", session: { append() {} } };

function member(id, name, phase = "active") {
	return {
		id, name, phase,
		description: "desc", provider: "test", context: "fresh",
	};
}

test("event sourcing: append → flush → replay produces identical projection", async () => {
	const backend = makeSessionBackend();
	ROOT.session = backend.session;
	const journal = new TeamJournal(makeCtx(backend), () => {});

	// 追加 team/member 事件：先 provisioning → 再 active（投影强制生命周期边）
	await journal.appendAndFlush(ROOT, "team/member", {
		version: 2, teamId: "lead-1",
		member: member("m1", "alice", "provisioning"),
	});
	await journal.appendAndFlush(ROOT, "team/member", {
		version: 2, teamId: "lead-1",
		member: member("m1", "alice", "active"),
	});
	// 追加 team/task 事件
	await journal.appendAndFlush(ROOT, "team/task", {
		version: 2, teamId: "lead-1",
		task: {
			id: "task-1", revision: 1, subject: "fix bug",
			description: "desc", status: "pending",
			blockedBy: [], writeScopes: [],
		},
	});
	// 追加 team/message/queued
	await journal.appendAndFlush(ROOT, "team/message/queued", {
		version: 2, teamId: "lead-1",
		message: {
			id: "msg-1", senderId: "lead-1", senderName: "lead",
			targetId: "m1", content: [{ type: "text", text: "hello" }],
			queuedAt: Date.now(),
		},
	});

	assert.equal(backend.durableEvents.length, 4);
	assert.equal(backend.pendingEvents.length, 0, "all events flushed");

	// 模拟崩溃：只用 durableEvents 重放
	const replayed = replayFromDurable(backend.durableEvents, "lead-1");
	assert.equal(replayed.members.length, 1);
	assert.equal(replayed.members[0].name, "alice");
	assert.equal(replayed.tasks.length, 1);
	assert.equal(replayed.tasks[0].id, "task-1");
	assert.equal(replayed.messages.length, 1);
	assert.equal(replayed.messages[0].id, "msg-1");
	assert.equal(replayed.nextTaskNumber, 2);
	assert.equal(replayed.failure, undefined, "no projection failure");

	// journal.state() 也走同一投影路径 → 应一致
	const viaJournal = journal.state(ROOT);
	assert.deepEqual(viaJournal.tasks, replayed.tasks);
	assert.deepEqual(viaJournal.members, replayed.members);
	assert.deepEqual(viaJournal.messages, replayed.messages);
});

test("event sourcing: unflushed events lost on crash, flushed events survive", async () => {
	const backend = makeSessionBackend();
	ROOT.session = backend.session;
	const journal = new TeamJournal(makeCtx(backend), () => {});

	// 追加并 flush 一个 member（provisioning → active）
	await journal.appendAndFlush(ROOT, "team/member", {
		version: 2, teamId: "lead-1",
		member: member("m1", "alice", "provisioning"),
	});
	await journal.appendAndFlush(ROOT, "team/member", {
		version: 2, teamId: "lead-1",
		member: member("m1", "alice", "active"),
	});

	// 追加但不 flush——模拟崩溃前未落盘
	backend.session.append("team/task", {
		version: 2, teamId: "lead-1",
		task: {
			id: "task-1", revision: 1, subject: "lost",
			description: "desc", status: "pending",
			blockedBy: [], writeScopes: [],
		},
	});
	// 不 flush → durableEvents 只有 2 个 member 事件
	assert.equal(backend.durableEvents.length, 2);
	assert.equal(backend.pendingEvents.length, 1, "unflushed event still pending");

	const replayed = replayFromDurable(backend.durableEvents, "lead-1");
	assert.equal(replayed.tasks.length, 0, "unflushed task lost");
	assert.equal(replayed.members.length, 1, "flushed member survives");
});

test("event sourcing: replay gap in task revision tolerated, contiguous required", async () => {
	const backend = makeSessionBackend();
	ROOT.session = backend.session;
	const journal = new TeamJournal(makeCtx(backend), () => {});

	// 直接注入 revision=3 的 task（revision 1,2 丢失——replay gap 容忍）
	await journal.appendAndFlush(ROOT, "team/task", {
		version: 2, teamId: "lead-1",
		task: {
			id: "task-1", revision: 3, subject: "gap",
			description: "desc", status: "in_progress",
			blockedBy: [], writeScopes: [],
		},
	});
	const replayed = replayFromDurable(backend.durableEvents, "lead-1");
	assert.equal(replayed.tasks.length, 1);
	assert.equal(replayed.tasks[0].revision, 3);
	assert.equal(replayed.failure, undefined, "replay gap tolerated");

	// 再追加 revision=5（跳过 4）→ 投影不连续 → failure
	await journal.appendAndFlush(ROOT, "team/task", {
		version: 2, teamId: "lead-1",
		task: {
			id: "task-1", revision: 5, subject: "gap",
			description: "desc", status: "completed",
			blockedBy: [], writeScopes: [],
		},
	});
	const broken = replayFromDurable(backend.durableEvents, "lead-1");
	assert.ok(broken.failure, "non-contiguous revision must produce failure");
	assert.ok(broken.failure.includes("revision is not contiguous"));
});
