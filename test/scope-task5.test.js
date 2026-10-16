import { bundle } from './support.mjs'
import test from "node:test";
import assert from "node:assert/strict";

// task-5 修复验证：
//  1. advisory 判定集与 enforce 一致（in_progress + pending）——
//     pending 兄弟的 scope 重叠也要出现在 writeScopeWarnings/conflicts，
//     否则成员在 list/get 看不到会拦自己 claim 的 pending 冲突。
//  2. TEAM_WRITE_SCOPE_CONFLICT 报错带对方 status
//     （"in_progress task \"task-x\"" vs "pending task \"task-y\""）。
//  3. edit 支持 append_description 追加语义；与 description 互斥；
//     complete 后投影 descriptionTruncated 标记截断。
//  4. memberName 拒绝中文名的报错改成英文短句（TEAM_INVALID_MEMBER_NAME）。

const { teamProjectionDefinition, TeamJournal, TeamTaskBoard, TeamRoster } = bundle;

const ROOT_ID = "lead-1";
const ROOT = { id: ROOT_ID };

function member(id, name, phase = "active") {
	return { id, name, phase, description: "desc", provider: "test", context: "fresh" };
}

function makeBackend(rootId = ROOT_ID) {
	const durableEvents = [];
	const session = { append(type, data) { durableEvents.push({ type, data }); } };
	return {
		session,
		durableEvents,
		sessions: { async flush() {} },
		sessionProjections: {
			stateOf(_s, key) {
				assert.equal(key, "agentTeam");
				let state = teamProjectionDefinition.init({ id: rootId });
				for (const e of durableEvents) state = teamProjectionDefinition.apply(state, e);
				return state;
			},
		},
	};
}

async function seedTeam(backend) {
	const journal = new TeamJournal({ sessions: backend.sessions, sessionProjections: backend.sessionProjections }, () => {});
	ROOT.session = backend.session;
	for (const m of [member("m-alice", "alice"), member("m-bob", "bob")]) {
		await journal.appendAndFlush(ROOT, "team/member", { version: 2, teamId: ROOT_ID, member: { ...m, phase: "provisioning" } });
		await journal.appendAndFlush(ROOT, "team/member", { version: 2, teamId: ROOT_ID, member: { ...m, phase: "active" } });
	}
	return journal;
}

const aliceMembership = { root: ROOT, id: ROOT_ID, role: "teammate", name: "alice" };
const bobMembership = { root: ROOT, id: ROOT_ID, role: "teammate", name: "bob" };
const aliceCaller = { id: "m-alice", name: "alice" };
const bobCaller = { id: "m-bob", name: "bob" };

// ─── 1. advisory 覆盖 pending ────────────────────────────────────────────────

test("scope5: pending sibling with overlapping scope appears in advisory conflicts", async () => {
	const backend = makeBackend();
	const journal = await seedTeam(backend);
	const board = new TeamTaskBoard(journal, 100); // advisory only

	// bob creates a pending task with scopes but never claims it
	const t1 = await board.create(bobMembership, { subject: "queued", description: "d", writeScopes: ["src/"] });
	assert.equal(t1.status, "pending");

	// alice claims an overlapping task — claim view must warn about the pending sibling
	const t2 = await board.create(aliceMembership, { subject: "work", description: "d", writeScopes: ["src/auth/"] });
	const claimed = await board.update(aliceCaller, aliceMembership, { taskId: t2.id, expectedRevision: 1, action: "claim" });
	assert.ok(claimed.writeScopeWarnings.some((w) => w.includes(t1.id)), "pending sibling warned");
	assert.ok(claimed.conflicts?.some((c) => c.taskId === t1.id), "pending sibling in conflicts");

	// get/list also surface the pending overlap on the pending task itself
	const view = board.get(bobMembership, t1.id);
	assert.ok(view.writeScopeWarnings.some((w) => w.includes(t2.id)), "get() sees in_progress overlap");
});

// ─── 2. enforce 报错带对方 status ────────────────────────────────────────────

test("scope5: TEAM_WRITE_SCOPE_CONFLICT names the blocking task status", async () => {
	const backend = makeBackend();
	const journal = await seedTeam(backend);
	const board = new TeamTaskBoard(journal, 100, true);

	// blocking task stays pending (queued scope reservation, nobody writing)
	const t1 = await board.create(bobMembership, { subject: "queued", description: "d", writeScopes: ["src/"] });
	const t2 = await board.create(aliceMembership, { subject: "work", description: "d", writeScopes: ["src/auth/"] });
	await assert.rejects(
		board.update(aliceCaller, aliceMembership, { taskId: t2.id, expectedRevision: 1, action: "claim" }),
		(err) => {
			assert.equal(err.code, "TEAM_WRITE_SCOPE_CONFLICT");
			assert.ok(err.message.includes(`pending task "${t1.id}"`), `message names pending status: ${err.message}`);
			return true;
		},
	);

	// A pending blocker also rejects the *other* side's claim, so the
	// in_progress case needs a second board where the blocker was claimed first.
	const backend2 = makeBackend();
	const journal2 = await seedTeam(backend2);
	const board2 = new TeamTaskBoard(journal2, 100, true);
	const b1 = await board2.create(bobMembership, { subject: "running", description: "d", writeScopes: ["src/"] });
	await board2.update(bobCaller, bobMembership, { taskId: b1.id, expectedRevision: 1, action: "claim" });
	const b2 = await board2.create(aliceMembership, { subject: "work2", description: "d", writeScopes: ["src/deep/"] });
	await assert.rejects(
		board2.update(aliceCaller, aliceMembership, { taskId: b2.id, expectedRevision: 1, action: "claim" }),
		(err) => {
			assert.equal(err.code, "TEAM_WRITE_SCOPE_CONFLICT");
			assert.ok(err.message.includes(`in_progress task "${b1.id}"`), `message names in_progress status: ${err.message}`);
			return true;
		},
	);
});

// ─── 3. append_description 语义 + descriptionTruncated ───────────────────────

test("scope5: edit append_description appends instead of replacing", async () => {
	const backend = makeBackend();
	const journal = await seedTeam(backend);
	const board = new TeamTaskBoard(journal, 100);

	const t = await board.create(aliceMembership, { subject: "t", description: "original brief" });
	await board.update(aliceCaller, aliceMembership, { taskId: t.id, expectedRevision: 1, action: "claim" });
	const edited = await board.update(aliceCaller, aliceMembership, {
		taskId: t.id, expectedRevision: 2, action: "edit", appendDescription: "result line one",
	});
	assert.equal(edited.description, "original brief\nresult line one");

	// second append accumulates
	const again = await board.update(aliceCaller, aliceMembership, {
		taskId: t.id, expectedRevision: 3, action: "edit", appendDescription: "result line two",
	});
	assert.equal(again.description, "original brief\nresult line one\nresult line two");
});

test("scope5: edit rejects description + append_description together", async () => {
	const backend = makeBackend();
	const journal = await seedTeam(backend);
	const board = new TeamTaskBoard(journal, 100);

	const t = await board.create(aliceMembership, { subject: "t", description: "d" });
	await board.update(aliceCaller, aliceMembership, { taskId: t.id, expectedRevision: 1, action: "claim" });
	await assert.rejects(
		board.update(aliceCaller, aliceMembership, {
			taskId: t.id, expectedRevision: 2, action: "edit",
			description: "replace", appendDescription: "append",
		}),
		(err) => {
			assert.equal(err.code, "TEAM_INVALID_ARGUMENT");
			assert.ok(err.message.includes("not both"), err.message);
			return true;
		},
	);
	// append alone also satisfies the "at least one field" requirement
	const ok = await board.update(aliceCaller, aliceMembership, {
		taskId: t.id, expectedRevision: 2, action: "edit", appendDescription: "x",
	});
	assert.equal(ok.description, "d\nx");
});

test("scope5: completed task view sets descriptionTruncated when compressed", async () => {
	const backend = makeBackend();
	const journal = await seedTeam(backend);
	const board = new TeamTaskBoard(journal, 100);

	const long = "line\n".repeat(600) + "end"; // > 1200 chars → compressed
	const t = await board.create(aliceMembership, { subject: "t", description: "d" });
	await board.update(aliceCaller, aliceMembership, { taskId: t.id, expectedRevision: 1, action: "claim" });
	// complete does not rewrite description — the report lands via edit first.
	await board.update(aliceCaller, aliceMembership, { taskId: t.id, expectedRevision: 2, action: "edit", description: long });
	const done = await board.update(aliceCaller, aliceMembership, { taskId: t.id, expectedRevision: 3, action: "complete" });
	assert.equal(done.status, "completed");
	assert.equal(done.descriptionTruncated, true, "long completed report flagged truncated");
	assert.ok(done.description.length < long.length, "projected description was compressed");

	// short completed description → no flag
	const t2 = await board.create(aliceMembership, { subject: "t2", description: "d" });
	await board.update(aliceCaller, aliceMembership, { taskId: t2.id, expectedRevision: 1, action: "claim" });
	const done2 = await board.update(aliceCaller, aliceMembership, {
		taskId: t2.id, expectedRevision: 2, action: "complete", description: "short report",
	});
	assert.equal(done2.descriptionTruncated, undefined, "short report not flagged");
});

// ─── 4. memberName 报错英文短句 ──────────────────────────────────────────────

test("scope5: Chinese member name rejection uses a short English message", async () => {
	const backend = makeBackend();
	const journal = await seedTeam(backend);
	const roster = Object.create(TeamRoster.prototype);
	// memberName is private but pure-input → call through the prototype with a stub this
	assert.throws(
		() => roster.memberName("测试成员"),
		(err) => {
			assert.equal(err.code, "TEAM_INVALID_MEMBER_NAME");
			assert.ok(!/[一-鿿]/.test(err.message), `error must not contain Chinese: ${err.message}`);
			assert.ok(err.message.length < 160, `error should be a short sentence: ${err.message}`);
			return true;
		},
	);
	// valid names still pass
	assert.equal(roster.memberName("tool-auditor"), "tool-auditor");
});
