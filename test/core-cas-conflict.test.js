import { bundle } from './support.mjs'
import test from "node:test";
import assert from "node:assert/strict";

/**
 * ② CAS expected_revision 冲突被拒。
 * TeamTaskBoard.update 在 transact 内做 revision CAS：current.revision !==
 * request.expectedRevision → throw TeamError(TEAM_TASK_STALE_REVISION)。
 * 用真实 TeamTaskBoard + TeamJournal + 事件溯源投影（同 core-event-sourcing）。
 */

const { teamProjectionDefinition } = bundle;
const { TeamJournal } = bundle;
const { TeamTaskBoard } = bundle;

function makeBackend(rootId = "lead-1") {
	const durableEvents = [];
	const session = {
		append(type, data) {
			durableEvents.push({ type, data });
		},
	};
	return {
		session,
		durableEvents,
		sessions: {
			async flush() {},
		},
		sessionProjections: {
			stateOf(_s, key) {
				assert.equal(key, "agentTeam");
				let state = teamProjectionDefinition.init({ id: rootId });
				for (const e of durableEvents) {
					state = teamProjectionDefinition.apply(state, e);
				}
				return state;
			},
		},
	};
}

function member(id, name, phase = "active") {
	return {
		id, name, phase,
		description: "desc", provider: "test", context: "fresh",
	};
}

const ROOT_ID = "lead-1";

function leadAgent(backend) {
	return {
		id: ROOT_ID,
		session: backend.session,
	};
}

function fakeMembership(agent) {
	return { root: agent, id: ROOT_ID, role: "lead", name: "lead" };
}

test("CAS: update with correct expectedRevision succeeds, stale revision rejected", async () => {
	const backend = makeBackend();
	const journal = new TeamJournal(backend, () => {});
	const board = new TeamTaskBoard(journal, 100);
	const lead = leadAgent(backend);
	const membership = fakeMembership(lead);

	// 先建一个 member（task owner 需要 member 存在于投影）
	await journal.appendAndFlush(lead, "team/member", {
		version: 2, teamId: ROOT_ID,
		member: member("alice-1", "alice", "provisioning"),
	});
	await journal.appendAndFlush(lead, "team/member", {
		version: 2, teamId: ROOT_ID,
		member: member("alice-1", "alice", "active"),
	});

	// 创建任务
	const created = await board.create(membership, {
		subject: "fix bug",
		description: "desc",
	});
	assert.equal(created.revision, 1);
	assert.equal(created.id, "task-1");

	// reassign to alice：正确 revision → 成功
	const reassigned = await board.update(lead, membership, {
		taskId: "task-1",
		expectedRevision: 1,
		action: "reassign",
		owner: "alice",
	});
	assert.equal(reassigned.revision, 2);
	assert.equal(reassigned.status, "in_progress");

	// stale revision（还拿 rev1）→ 必须被拒
	await assert.rejects(
		board.update(lead, membership, {
			taskId: "task-1",
			expectedRevision: 1,
			action: "complete",
		}),
		(err) => {
			assert.ok(err instanceof Error);
			assert.equal(err.code, "TEAM_TASK_STALE_REVISION");
			assert.ok(err.message.includes("stale"));
			return true;
		},
	);
});

test("CAS: concurrent competing revisions — first wins, second sees stale", async () => {
	const backend = makeBackend();
	const journal = new TeamJournal(backend, () => {});
	const board = new TeamTaskBoard(journal, 100);
	const lead = leadAgent(backend);
	const membership = fakeMembership(lead);

	await board.create(membership, { subject: "a", description: "d" });
	// task-1 at rev=1

	// 模拟两个并发调用方都读到 rev=1，分别尝试不同 action
	// transact 串行化保证第二个看到的一定是 rev=2
	const first = board.update(lead, membership, {
		taskId: "task-1",
		expectedRevision: 1,
		action: "edit",
		subject: "updated by first",
	});
	const second = board.update(lead, membership, {
		taskId: "task-1",
		expectedRevision: 1,
		action: "delete",
	});

	// 第一个应该成功
	const firstResult = await first;
	assert.equal(firstResult.revision, 2);
	assert.equal(firstResult.subject, "updated by first");

	// 第二个必须因 stale revision 被拒
	await assert.rejects(second, (err) => {
		assert.equal(err.code, "TEAM_TASK_STALE_REVISION");
		return true;
	});
});

test("CAS: reassign blocked task rejected even with correct revision", async () => {
	const backend = makeBackend();
	const journal = new TeamJournal(backend, () => {});
	const board = new TeamTaskBoard(journal, 100);
	const lead = leadAgent(backend);
	const membership = fakeMembership(lead);

	await journal.appendAndFlush(lead, "team/member", {
		version: 2, teamId: ROOT_ID,
		member: member("alice-1", "alice", "provisioning"),
	});
	await journal.appendAndFlush(lead, "team/member", {
		version: 2, teamId: ROOT_ID,
		member: member("alice-1", "alice", "active"),
	});

	// task-1 pending（阻塞 task-2）
	await board.create(membership, { subject: "blocker", description: "d" });
	// task-2 blockedBy task-1
	await board.create(membership, {
		subject: "blocked",
		description: "d",
		blockedBy: ["task-1"],
	});

	// reassign blocked task-2 → TEAM_TASK_BLOCKED
	await assert.rejects(
		board.update(lead, membership, {
			taskId: "task-2",
			expectedRevision: 1,
			action: "reassign",
			owner: "alice",
		}),
		(err) => {
			assert.equal(err.code, "TEAM_TASK_BLOCKED");
			return true;
		},
	);
});
