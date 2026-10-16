import { bundle } from './support.mjs'
// rebuild-from-events 的 exhausted 节流标记必须是 per-cell（挂在投影 cell
// 上），而不是 per-journal 的 WeakSet<session>：
//  - rootA 的确定性失败只标记 rootA 的 cell，同 journal 的 rootB 仍能 rebuild；
//  - noteCommitted 只清除该 session 自己 cell 上的标记（re-arm per-cell）；
//  - 标记随 cell 被 delete 而消失——成功 rebuild 后的新 cell 不残留。
// 走真实路径：TeamJournal.state → tryRebuildProjection → registration.cells。

import test from "node:test";
import assert from "node:assert/strict";

const { TeamJournal } = bundle;

const ROOT_ID = "lead-1";

function healthyState(id) {
	return { id, members: [], tasks: [], messages: [], delivered: [], nextTaskNumber: 1 };
}

// 最小 registry 镜像 dsh-session-projection 的公开契约：
// registrations: Map<key, { cells: WeakMap<session, cell> }>，
// stateOf(session, key) 惰性建 cell（fold 一次）并返回 cell.state。
// fold 由调用方按 session 注入，便于精确控制每个 root 的投影结局。
function makeRegistry(foldFor) {
	const cells = new WeakMap();
	const registrations = new Map([["agentTeam", { cells }]]);
	const registry = {
		registrations,
		stateOf(session, key) {
			assert.equal(key, "agentTeam");
			let cell = cells.get(session);
			if (cell === undefined) {
				cell = { state: foldFor(session), observedSeq: 0, views: [undefined, undefined] };
				cells.set(session, cell);
			}
			return cell.state;
		},
	};
	return { registry, cells };
}

function makeJournal(registry) {
	const ctx = {
		sessionProjections: registry,
		sessions: { async flush() {} },
		logger: { info() {}, warn() {} },
	};
	return new TeamJournal(ctx, () => {});
}

test("rebuild exhausted mark is per-cell: rootA failure does not block rootB", () => {
	const sessionA = { id: "session-a" };
	const sessionB = { id: "session-b" };
	let foldCallsB = 0;
	const { registry, cells } = makeRegistry((session) => {
		if (session === sessionA) return { ...healthyState("team-a"), failure: "durable corruption" };
		foldCallsB += 1;
		// rootB 首次 fold 出失败态，清 cell 重建后恢复——模拟可修复的冻结。
		return foldCallsB === 1
			? { ...healthyState("team-b"), failure: "transient freeze" }
			: healthyState("team-b");
	});
	const journal = makeJournal(registry);

	// rootA：投影失败 → rebuild 仍失败 → cell 被标记，journal.state 抛错。
	assert.throws(
		() => journal.state({ id: "root-a", session: sessionA }),
		(err) => err.code === "TEAM_PROJECTION_FAILED",
	);
	assert.equal(cells.get(sessionA)?.rebuildExhausted, true, "rootA cell must carry the mark");

	// 同 journal 的 rootB 不受 rootA 标记连坐：rebuild 正常执行并成功。
	const stateB = journal.state({ id: "root-b", session: sessionB });
	assert.equal(stateB.failure, undefined, "rootB rebuild must succeed despite rootA exhaustion");
	assert.equal(foldCallsB, 2, "rootB cell was rebuilt once");
});

test("exhausted cell skips refold; noteCommitted re-arms only that cell", () => {
	const session = { id: "session-x" };
	let foldCalls = 0;
	const { registry, cells } = makeRegistry(() => {
		foldCalls += 1;
		return { ...healthyState(ROOT_ID), failure: "durable corruption" };
	});
	const journal = makeJournal(registry);
	const root = { id: ROOT_ID, session };

	assert.throws(() => journal.state(root), (err) => err.code === "TEAM_PROJECTION_FAILED");
	assert.equal(foldCalls, 2, "initial read + one rebuild fold");
	assert.equal(cells.get(session).rebuildExhausted, true);

	// 再次读取命中标记：不再重放（foldCalls 不变），直接抛失败。
	assert.throws(() => journal.state(root), (err) => err.code === "TEAM_PROJECTION_FAILED");
	assert.equal(foldCalls, 2, "marked cell must not refold on every read");

	// 新事件提交 → 该 cell 重新武装，下一次读取会再尝试 rebuild。
	journal.noteCommitted(session);
	assert.equal(cells.get(session).rebuildExhausted, undefined, "commit clears only this cell's mark");
	assert.throws(() => journal.state(root), (err) => err.code === "TEAM_PROJECTION_FAILED");
	assert.equal(foldCalls, 3, "re-armed cell refolds on next read");
});

test("successful rebuild leaves no stale mark on the fresh cell", () => {
	const session = { id: "session-y" };
	let foldCalls = 0;
	const { registry, cells } = makeRegistry(() => {
		foldCalls += 1;
		return foldCalls === 1
			? { ...healthyState(ROOT_ID), failure: "transient freeze" }
			: healthyState(ROOT_ID);
	});
	const journal = makeJournal(registry);
	const root = { id: ROOT_ID, session };

	const state = journal.state(root);
	assert.equal(state.failure, undefined);
	assert.equal(cells.get(session).rebuildExhausted, undefined, "fresh cell starts unmarked");
});
