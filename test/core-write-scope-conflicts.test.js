import { bundle } from './support.mjs'
import test from "node:test";
import assert from "node:assert/strict";

/**
 * ⑤ write_scope 交集 conflicts 透出（advisory，不阻塞）。
 * projectTaskView 在 task-view.js 计算两个 owner 不同的 in_progress 任务的
 * writeScopes 路径前缀重叠——有交集时给 view.conflicts 数组（含 taskId/ownerId/
 * 重叠 scopes），同时 writeScopeWarnings 记入提示。不阻塞任务流转。
 * 走真实路径：TeamTaskBoard.create/update → projectTaskView → conflicts。
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
const ROOT = { id: ROOT_ID };

async function seedTeam(backend) {
	const journal = new TeamJournal({ sessions: backend.sessions, sessionProjections: backend.sessionProjections }, () => {});
	ROOT.session = backend.session;
	await journal.appendAndFlush(ROOT, "team/member", {
		version: 2, teamId: ROOT_ID,
		member: member("m-alice", "alice", "provisioning"),
	});
	await journal.appendAndFlush(ROOT, "team/member", {
		version: 2, teamId: ROOT_ID,
		member: member("m-alice", "alice", "active"),
	});
	await journal.appendAndFlush(ROOT, "team/member", {
		version: 2, teamId: ROOT_ID,
		member: member("m-bob", "bob", "provisioning"),
	});
	await journal.appendAndFlush(ROOT, "team/member", {
		version: 2, teamId: ROOT_ID,
		member: member("m-bob", "bob", "active"),
	});
	return journal;
}

function leadMembership(root) {
	return { root, id: ROOT_ID, role: "lead", name: "lead" };
}

const LEAD_CALLER = { id: ROOT_ID, name: "lead" };

test("write_scope: overlapping scopes between different owners produce conflicts", async () => {
	const backend = makeBackend();
	const journal = await seedTeam(backend);
	const board = new TeamTaskBoard(journal, 100);

	// alice creates task-1 with writeScopes = ["src/"]
	const aliceMembership = { root: ROOT, id: ROOT_ID, role: "teammate", name: "alice" };
	const aliceCaller = { id: "m-alice", name: "alice" };
	const view1 = await board.create(aliceMembership, {
		subject: "fix auth", description: "d",
		writeScopes: ["src/"],
	});
	assert.equal(view1.id, "task-1");

	// alice claims task-1 (→ in_progress, owner=alice)
	const claimed = await board.update(aliceCaller, aliceMembership, {
		taskId: "task-1", expectedRevision: 1, action: "claim",
	});
	assert.equal(claimed.status, "in_progress");

	// bob creates task-2 with writeScopes = ["src/auth/"] — overlaps with alice's ["src/"]
	const bobMembership = { root: ROOT, id: ROOT_ID, role: "teammate", name: "bob" };
	const bobCaller = { id: "m-bob", name: "bob" };
	const view2 = await board.create(bobMembership, {
		subject: "refactor auth", description: "d",
		writeScopes: ["src/auth/"],
	});
	assert.equal(view2.id, "task-2");

	// bob claims task-2 → in_progress, owner=bob
	const claimed2 = await board.update(bobCaller, bobMembership, {
		taskId: "task-2", expectedRevision: 1, action: "claim",
	});

	// projectTaskView(task-2) should see task-1 as conflicting (different owner, overlapping scope)
	assert.ok(claimed2.conflicts, "conflicts field present");
	assert.equal(claimed2.conflicts.length, 1, "one conflict");
	assert.equal(claimed2.conflicts[0].taskId, "task-1");
	assert.equal(claimed2.conflicts[0].ownerId, "m-alice");
	assert.ok(claimed2.conflicts[0].scopes.length > 0, "overlap scopes listed");
	// writeScopeWarnings also fires
	assert.ok(claimed2.writeScopeWarnings.some(w => w.includes("task-1")), "warning mentions task-1");
});

test("write_scope: same owner tasks do not conflict", async () => {
	const backend = makeBackend();
	const journal = await seedTeam(backend);
	const board = new TeamTaskBoard(journal, 100);

	const aliceMembership = { root: ROOT, id: ROOT_ID, role: "teammate", name: "alice" };
	const aliceCaller = { id: "m-alice", name: "alice" };

	// alice creates and claims two tasks with overlapping scopes
	const v1 = await board.create(aliceMembership, {
		subject: "t1", description: "d", writeScopes: ["src/"],
	});
	await board.update(aliceCaller, aliceMembership, {
		taskId: v1.id, expectedRevision: 1, action: "claim",
	});

	const v2 = await board.create(aliceMembership, {
		subject: "t2", description: "d", writeScopes: ["src/auth/"],
	});
	const claimed2 = await board.update(aliceCaller, aliceMembership, {
		taskId: v2.id, expectedRevision: 1, action: "claim",
	});

	// Same owner → conflicts should NOT include task-1
	assert.equal(claimed2.conflicts, undefined, "no conflicts for same owner");
	// But writeScopeWarnings still shows the overlap (informational)
	assert.ok(claimed2.writeScopeWarnings.some(w => w.includes("task-1")), "warning still present");
});

test("write_scope: no overlap → no conflicts", async () => {
	const backend = makeBackend();
	const journal = await seedTeam(backend);
	const board = new TeamTaskBoard(journal, 100);

	const aliceMembership = { root: ROOT, id: ROOT_ID, role: "teammate", name: "alice" };
	const aliceCaller = { id: "m-alice", name: "alice" };
	const bobMembership = { root: ROOT, id: ROOT_ID, role: "teammate", name: "bob" };
	const bobCaller = { id: "m-bob", name: "bob" };

	const v1 = await board.create(aliceMembership, {
		subject: "t1", description: "d", writeScopes: ["src/"],
	});
	await board.update(aliceCaller, aliceMembership, {
		taskId: v1.id, expectedRevision: 1, action: "claim",
	});

	const v2 = await board.create(bobMembership, {
		subject: "t2", description: "d", writeScopes: ["docs/"],
	});
	const claimed2 = await board.update(bobCaller, bobMembership, {
		taskId: v2.id, expectedRevision: 1, action: "claim",
	});

	assert.equal(claimed2.conflicts, undefined, "non-overlapping scopes produce no conflicts");
	assert.equal(claimed2.writeScopeWarnings.length, 0, "no warnings either");
});
