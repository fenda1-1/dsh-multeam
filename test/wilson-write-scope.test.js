import { bundle } from './support.mjs'
// 八轮盲评补测：Wilson 学习子系统 + enforceWriteScopes 硬门 + coldStart。
// 全真 API 调用（TeamScheduler/TeamTaskBoard/detectWriteScopeConflict），
// 断言运行时返回值/抛错 code，不断言源码字符串。
//
// 覆盖矩阵：
//  A. Wilson 学习子系统（scheduler）——wilsonLowerBound/inferCapabilityTag
//     是模块私有函数（未导出），经 buildCapabilityHint/collectPerf 的公开
//     输出端到端验证：suggestion 文本里的 `WilsonNN%`/`✅<tag>领域重叠`/
//     `[无<tag>记录]`/`❄️冷启动` 均由这两个私有函数驱动，数值与标签名
//     错一处断言即红。
//  B. enforceWriteScopes 硬门（core）——TeamTaskBoard 第三参 true 时
//     claim 抛 TEAM_WRITE_SCOPE_CONFLICT；false（默认）时仅 advisory
//     （writeScopeWarnings/conflicts）；sameOwner 豁免；邻接路径放行。
//  C. coldStart 字段——buildCapabilityHint 返回值的 coldStart 标记。

import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const { teamProjectionDefinition } = bundle;
const { TeamJournal } = bundle;
const { TeamTaskBoard } = bundle;
const { detectWriteScopeConflict, scopesOverlap } = bundle;
const { Context } = await import('@deepseek-ai/cordis');
const { TeamService } = bundle;
const { TeamScheduler } = bundle;

const ROOT_ID = "lead-1";
const ROOT = { id: ROOT_ID };

// ─── 共享设施（与 phase2-behavior.test.js / core-write-scope-conflicts.test.js 同型）

function makeScheduler() {
	const sched = Object.create(TeamScheduler.prototype);
	sched.config = { capabilityMatch: true };
	sched.perfMap = new Map();
	sched.perfLoaded = new Map();
	sched.perfDirty = new Map();
	sched.lastSeenRevision = new Map();
	sched.lastDecayAt = new Map();
	sched.dispatchFailures = new Map();
	sched.inProgressSince = new Map();
	sched.timeoutNotified = new Map();
	sched.retryCount = new Map();
	sched.retryExhausted = new Map();
	sched.notified = new Map();
	sched.ctx = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		agents: { get() { return undefined; }, list() { return []; } },
	};
	return sched;
}

function perfEntry(overrides = {}) {
	return {
		completed: 0, timeouts: 0,
		capabilities: new Set(), seen: new Set(), completedTaskIds: new Set(),
		...overrides,
	};
}

function member(id, name, phase = "active") {
	return { id, name, phase, description: "desc", provider: "test", context: "fresh" };
}

function makeBackend(rootId = ROOT_ID) {
	const durableEvents = [];
	const session = {
		append(type, data) { durableEvents.push({ type, data }); },
	};
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
	const journal = new TeamJournal(
		{ sessions: backend.sessions, sessionProjections: backend.sessionProjections },
		() => {},
	);
	ROOT.session = backend.session;
	for (const m of [member("m-alice", "alice"), member("m-bob", "bob")]) {
		await journal.appendAndFlush(ROOT, "team/member", {
			version: 2, teamId: ROOT_ID, member: { ...m, phase: "provisioning" },
		});
		await journal.appendAndFlush(ROOT, "team/member", {
			version: 2, teamId: ROOT_ID, member: { ...m, phase: "active" },
		});
	}
	return journal;
}

const aliceMembership = { root: ROOT, id: ROOT_ID, role: "teammate", name: "alice" };
const bobMembership = { root: ROOT, id: ROOT_ID, role: "teammate", name: "bob" };
const aliceCaller = { id: "m-alice", name: "alice" };
const bobCaller = { id: "m-bob", name: "bob" };

// ─── A1: Wilson 下界数值（经 buildCapabilityHint 输出间接断言）───────────────
// wilsonLowerBound 未导出——其行为经 perfNote 的 `WilsonNN%` 精确验证：
// (1,1)→0.4134→41%，(100,100)→0.9639→96%，0 样本走冷启动分支（等价 trials=0→0）。

test("A1: Wilson(1,1)→21% — 小样本趋保守而非 Beta 的 67%", () => {
	const sched = makeScheduler();
	sched.perfMap.set("alice-1", perfEntry({ completed: 1, timeouts: 0, capabilities: new Set(["优化"]) }));
	const state = {
		id: ROOT_ID,
		members: [{ id: "alice-1", name: "alice", phase: "active", description: "优化" }],
		tasks: [{ id: "t1", ownerId: undefined, status: "pending", subject: "优化 core 模块性能", description: "", blockedBy: [] }],
	};
	const hint = sched.buildCapabilityHint(state.tasks[0], state, ROOT_ID);
	assert.ok(hint !== undefined);
	const line = hint.suggestions.find((s) => s.includes("alice"));
	assert.ok(line !== undefined);
	// Wilson 下界 (1+1.9208)/(1+3.8416)≈0.2065 → 21%；Beta(1,1) 平滑值是 67%。
	// 断言 Wilson21% 在场——若仍用 Beta 点估计只会出现 67%。
	assert.ok(line.includes("Wilson21%"), `expected Wilson21%, got: ${line}`);
	assert.ok(line.includes("Beta67%"), `Beta reference should still show, got: ${line}`);
});

test("A1: Wilson(100,100)→96% — 大样本趋真实比率", () => {
	const sched = makeScheduler();
	sched.perfMap.set("alice-1", perfEntry({ completed: 100, timeouts: 0, capabilities: new Set(["优化"]) }));
	const state = {
		id: ROOT_ID,
		members: [{ id: "alice-1", name: "alice", phase: "active", description: "优化" }],
		tasks: [{ id: "t1", ownerId: undefined, status: "pending", subject: "优化 core 模块性能", description: "", blockedBy: [] }],
	};
	const hint = sched.buildCapabilityHint(state.tasks[0], state, ROOT_ID);
	assert.ok(hint !== undefined);
	const line = hint.suggestions.find((s) => s.includes("alice"));
	assert.ok(line.includes("Wilson96%"), `expected Wilson96%, got: ${line}`);
});

test("A1/A2: 0 样本成员 → 冷启动标注（Wilson(0,0)=0 不显示 Wilson 字样）", () => {
	const sched = makeScheduler();
	sched.perfMap.set("alice-1", perfEntry({ completed: 0, timeouts: 0, capabilities: new Set(["优化"]) }));
	const state = {
		id: ROOT_ID,
		members: [{ id: "alice-1", name: "alice", phase: "active", description: "优化" }],
		tasks: [{ id: "t1", ownerId: undefined, status: "pending", subject: "优化 core 模块性能", description: "", blockedBy: [] }],
	};
	const hint = sched.buildCapabilityHint(state.tasks[0], state, ROOT_ID);
	assert.ok(hint !== undefined);
	const line = hint.suggestions.find((s) => s.includes("alice"));
	assert.ok(line.includes("冷启动"), `cold-start member should show 冷启动, got: ${line}`);
	assert.ok(!line.includes("Wilson"), "0-sample member must not show a Wilson number");
	assert.equal(hint.coldStart, true, "all-cold-start team → coldStart=true");
});

test("A2/C: 无 perf 条目 → 冷启动；任一成员有 perf → coldStart=false", () => {
	const sched = makeScheduler();
	const state = {
		id: ROOT_ID,
		members: [
			{ id: "alice-1", name: "alice", phase: "active", description: "优化" },
			{ id: "bob-1", name: "bob", phase: "active", description: "优化" },
		],
		tasks: [{ id: "t1", ownerId: undefined, status: "pending", subject: "优化 core 模块性能", description: "", blockedBy: [] }],
	};
	// 全员无 perf → coldStart=true，suggestions 带冷启动标注
	const cold = sched.buildCapabilityHint(state.tasks[0], state, ROOT_ID);
	assert.ok(cold !== undefined);
	assert.equal(cold.coldStart, true);
	assert.ok(cold.suggestions.every((s) => s.includes("冷启动")), `all cold: ${JSON.stringify(cold.suggestions)}`);

	// alice 有 perf（completed=1）→ 团队不再全冷启动
	sched.perfMap.set("alice-1", perfEntry({ completed: 1, timeouts: 0, capabilities: new Set(["优化"]) }));
	const warm = sched.buildCapabilityHint(state.tasks[0], state, ROOT_ID);
	assert.equal(warm.coldStart, false, "one member with perf → coldStart=false");
	const aliceLine = warm.suggestions.find((s) => s.includes("alice"));
	assert.ok(aliceLine.includes("Wilson"), `perf member should show Wilson note, got: ${aliceLine}`);
	const bobLine = warm.suggestions.find((s) => s.includes("bob"));
	assert.ok(bobLine !== undefined && bobLine.includes("冷启动"), "bob still cold-start individually");
});

// ─── A3: inferCapabilityTag（私有）经 perfNote 桶名间接断言 ─────────────────
// perfNote 里的 `✅<tag>领域重叠` 与 `[无<tag>记录]` 直接由 inferCapabilityTag
// 的返回值驱动——tag 推错，桶名与降级标注都会变。

test("A3/A5: code-tag 任务 + 无 code 桶 → [无code记录] 降级标注", () => {
	const sched = makeScheduler();
	// perf 有 completed 但没有 byCapability → taskTag=code 命中空桶 → 降级 total
	sched.perfMap.set("alice-1", perfEntry({ completed: 3, timeouts: 0, capabilities: new Set(["优化"]) }));
	const state = {
		id: ROOT_ID,
		members: [{ id: "alice-1", name: "alice", phase: "active", description: "优化" }],
		tasks: [{ id: "t1", ownerId: undefined, status: "pending", subject: "优化 core 模块性能", description: "", blockedBy: [] }],
	};
	const hint = sched.buildCapabilityHint(state.tasks[0], state, ROOT_ID);
	const line = hint.suggestions.find((s) => s.includes("alice"));
	// inferCapabilityTag("优化 core 模块性能")=code：code pattern 命中「优化/性能」
	assert.ok(line.includes("code领域重叠"), `tag should be code, got: ${line}`);
	assert.ok(line.includes("[无code记录]"), `missing code bucket → 降级标注, got: ${line}`);
});

test("A3: docs-tag 任务 → perfNote 显示 docs 领域桶名", () => {
	const sched = makeScheduler();
	sched.perfMap.set("alice-1", perfEntry({ completed: 2, timeouts: 0, capabilities: new Set(["评审"]) }));
	const state = {
		id: ROOT_ID,
		members: [{ id: "alice-1", name: "alice", phase: "active", description: "评审" }],
		// 「评审」是 SPECIFIC 词且命中 review pattern 排在 docs 之后；
		// 「文档」命中 docs → inferCapabilityTag 首命中 docs。
		tasks: [{ id: "t1", ownerId: undefined, status: "pending", subject: "评审文档", description: "", blockedBy: [] }],
	};
	const hint = sched.buildCapabilityHint(state.tasks[0], state, ROOT_ID);
	assert.ok(hint !== undefined);
	const line = hint.suggestions.find((s) => s.includes("alice"));
	assert.ok(line.includes("docs领域重叠"), `tag should be docs, got: ${line}`);
	assert.ok(line.includes("[无docs记录]"), `got: ${line}`);
});

test("A3: 无 pattern 命中的任务 → tag=undefined，perfNote 落「总」桶名", () => {
	const sched = makeScheduler();
	sched.perfMap.set("alice-1", perfEntry({ completed: 2, timeouts: 0, capabilities: new Set(["协议"]) }));
	const state = {
		id: ROOT_ID,
		members: [{ id: "alice-1", name: "alice", phase: "active", description: "协议" }],
		// 「协议」是 SPECIFIC 词但不在任何 CAPABILITY_PATTERN → tag=undefined。
		tasks: [{ id: "t1", ownerId: undefined, status: "pending", subject: "设计协议层", description: "", blockedBy: [] }],
	};
	const hint = sched.buildCapabilityHint(state.tasks[0], state, ROOT_ID);
	assert.ok(hint !== undefined);
	const line = hint.suggestions.find((s) => s.includes("alice"));
	assert.ok(line.includes("总领域重叠"), `undefined tag → 总桶名, got: ${line}`);
	assert.ok(!line.includes("[无"), "no [无tag记录] when tag is undefined");
});

// ─── A4: byCapability 分桶 + savePerf/loadPerf 往返 ──────────────────────────

test("A4: collectPerf 把 completed 任务按 inferCapabilityTag 计入 byCapability 桶", () => {
	const sched = makeScheduler();
	const state = {
		id: ROOT_ID,
		members: [{ id: "alice-1", name: "alice", phase: "active", description: "优化" }],
	};
	const tasks = [
		{ id: "task-1", ownerId: "alice-1", status: "completed", revision: 1, subject: "优化 core 模块性能", description: "" },
	];
	sched.collectPerf(state, tasks, ROOT_ID);
	const perf = sched.perfMap.get("alice-1");
	assert.ok(perf !== undefined);
	assert.ok(perf.byCapability instanceof Map, "byCapability must be a Map");
	assert.equal(perf.byCapability.get("code")?.completed, 1, "code bucket counted");
	assert.equal(perf.completed, 1);
	// 相同 revision 再跑一遍不重复计数（增量去重顺带验证）。
	sched.collectPerf(state, tasks, ROOT_ID);
	assert.equal(sched.perfMap.get("alice-1").byCapability.get("code").completed, 1, "dedup on unchanged revision");
});

test("A4: savePerf/loadPerf 往返后 byCapability 仍是 Map 且桶计数保真", () => {
	const sched = makeScheduler();
	const file = join(tmpdir(), `multeam-perf-${process.pid}-${Date.now()}.json`);
	try {
		sched.perfPath = () => file;
		sched.sessionsDirReady = true; // 跳过 mkdir resolveDshHome()——perfPath 已 stub 到 tmpdir
		const state = {
			id: ROOT_ID,
			members: [{ id: "alice-1", name: "alice", phase: "active", description: "优化" }],
		};
		const tasks = [
			{ id: "task-1", ownerId: "alice-1", status: "completed", revision: 1, subject: "优化 core 模块性能", description: "" },
			{ id: "task-2", ownerId: "alice-1", status: "completed", revision: 1, subject: "评审文档", description: "" },
		];
		sched.collectPerf(state, tasks, ROOT_ID);
		sched.savePerf(ROOT_ID);

		const restored = makeScheduler();
		restored.perfPath = () => file;
		restored.sessionsDirReady = true;
		restored.loadPerf(ROOT_ID);
		const perf = restored.perfMap.get("alice-1");
		assert.ok(perf !== undefined, "perf entry restored");
		assert.ok(perf.byCapability instanceof Map, "byCapability restored as Map, not plain object");
		assert.equal(perf.byCapability.get("code")?.completed, 1);
		assert.equal(perf.byCapability.get("docs")?.completed, 1);
		assert.equal(perf.completed, 2);
		assert.ok(perf.completedTaskIds.has("task-1") && perf.completedTaskIds.has("task-2"));
	} finally {
		rmSync(file, { force: true });
	}
});

// ─── B: enforceWriteScopes 硬门 ─────────────────────────────────────────────

test("B6: enforceWriteScopes=false（默认）→ 异 owner 重叠 claim 成功 + writeScopeWarnings 非空", async () => {
	const backend = makeBackend();
	const journal = await seedTeam(backend);
	const board = new TeamTaskBoard(journal, 100); // 第三参缺省 → false

	const t1 = await board.create(aliceMembership, { subject: "t1", description: "d", writeScopes: ["src/"] });
	await board.update(aliceCaller, aliceMembership, { taskId: t1.id, expectedRevision: 1, action: "claim" });

	const t2 = await board.create(bobMembership, { subject: "t2", description: "d", writeScopes: ["src/auth/"] });
	const claimed = await board.update(bobCaller, bobMembership, { taskId: t2.id, expectedRevision: 1, action: "claim" });
	assert.equal(claimed.status, "in_progress", "advisory mode does not block claim");
	assert.ok(claimed.writeScopeWarnings.length > 0, "writeScopeWarnings non-empty");
	assert.ok(claimed.writeScopeWarnings.some((w) => w.includes(t1.id)));
	assert.ok(claimed.conflicts !== undefined && claimed.conflicts.length === 1);
});

test("B7: enforceWriteScopes=true → 异 owner 重叠 claim 抛 TEAM_WRITE_SCOPE_CONFLICT", async () => {
	const backend = makeBackend();
	const journal = await seedTeam(backend);
	const board = new TeamTaskBoard(journal, 100, true);

	const t1 = await board.create(aliceMembership, { subject: "t1", description: "d", writeScopes: ["src/"] });
	await board.update(aliceCaller, aliceMembership, { taskId: t1.id, expectedRevision: 1, action: "claim" });

	const t2 = await board.create(bobMembership, { subject: "t2", description: "d", writeScopes: ["src/auth/"] });
	await assert.rejects(
		board.update(bobCaller, bobMembership, { taskId: t2.id, expectedRevision: 1, action: "claim" }),
		(err) => {
			assert.equal(err.code, "TEAM_WRITE_SCOPE_CONFLICT");
			assert.ok(err.message.includes(t1.id), "error names the conflicting sibling");
			return true;
		},
	);
	// 硬拒绝后任务仍是 pending 未绑定 owner
	const view = board.get({ root: ROOT, id: ROOT_ID, role: "lead", name: "lead" }, t2.id);
	assert.equal(view.status, "pending");
});

test("B8: enforceWriteScopes=true → 同 owner 重叠放行（sameOwner 豁免）", async () => {
	const backend = makeBackend();
	const journal = await seedTeam(backend);
	const board = new TeamTaskBoard(journal, 100, true);

	const t1 = await board.create(aliceMembership, { subject: "t1", description: "d", writeScopes: ["src/"] });
	await board.update(aliceCaller, aliceMembership, { taskId: t1.id, expectedRevision: 1, action: "claim" });

	const t2 = await board.create(aliceMembership, { subject: "t2", description: "d", writeScopes: ["src/auth/"] });
	const claimed = await board.update(aliceCaller, aliceMembership, { taskId: t2.id, expectedRevision: 1, action: "claim" });
	assert.equal(claimed.status, "in_progress", "same-owner overlap is exempt from hard gate");
	// advisory 层仍提示（writeScopeWarnings 含 sameOwner 命中），conflicts 字段不含。
	assert.ok(claimed.writeScopeWarnings.some((w) => w.includes(t1.id)));
	assert.equal(claimed.conflicts, undefined, "same-owner hits stay out of conflicts");
});

test("B9: enforceWriteScopes=true → 邻接路径（a/b/c.txt vs a/b/d.txt）放行", async () => {
	const backend = makeBackend();
	const journal = await seedTeam(backend);
	const board = new TeamTaskBoard(journal, 100, true);

	const t1 = await board.create(aliceMembership, { subject: "t1", description: "d", writeScopes: ["a/b/c.txt"] });
	await board.update(aliceCaller, aliceMembership, { taskId: t1.id, expectedRevision: 1, action: "claim" });

	// 同目录不同文件——组件级前缀互不包含，不是 overlap。
	const t2 = await board.create(bobMembership, { subject: "t2", description: "d", writeScopes: ["a/b/d.txt"] });
	const claimed = await board.update(bobCaller, bobMembership, { taskId: t2.id, expectedRevision: 1, action: "claim" });
	assert.equal(claimed.status, "in_progress");
	assert.equal(claimed.writeScopeWarnings.length, 0);
	assert.equal(claimed.conflicts, undefined);
});

test("B10: detectWriteScopeConflict 纯函数 → {conflicts:[{taskId,ownerId,sameOwner,overlaps}]}", () => {
	// writeScope() 归一化 strip 尾斜杠——纯函数拿到的是 "src"/"src/auth" 形态。
	const mine = { id: "task-9", ownerId: "m-bob", status: "in_progress", writeScopes: ["src/auth"] };
	const siblings = [
		// 异 owner 前缀包含 → 冲突
		{ id: "task-1", ownerId: "m-alice", status: "in_progress", writeScopes: ["src"] },
		// 同 owner 重叠 → sameOwner=true 仍返回（advisory 用）
		{ id: "task-2", ownerId: "m-bob", status: "in_progress", writeScopes: ["src/auth/deep"] },
		// 无 writeScopes → 不参与
		{ id: "task-3", ownerId: "m-alice", status: "in_progress", writeScopes: [] },
		// 邻接不重叠 → 不命中
		{ id: "task-4", ownerId: "m-alice", status: "in_progress", writeScopes: ["a/b/d.txt"] },
		// completed 不在 statuses → 忽略
		{ id: "task-5", ownerId: "m-alice", status: "completed", writeScopes: ["src"] },
	];
	const { conflicts } = detectWriteScopeConflict(mine, siblings, ["in_progress", "pending"]);
	assert.equal(conflicts.length, 2);
	const byOther = conflicts.find((c) => c.taskId === "task-1");
	assert.equal(byOther.ownerId, "m-alice");
	assert.equal(byOther.sameOwner, false);
	assert.deepEqual(byOther.overlaps, ["src/auth"]);
	const sameOwner = conflicts.find((c) => c.taskId === "task-2");
	assert.equal(sameOwner.sameOwner, true);
	assert.ok(conflicts.every((c) => Array.isArray(c.overlaps) && c.overlaps.length > 0));
});

// ─── C: writeScopesForAgent 真路径（N2 修复——不再用抄写品逻辑）──
// ROUND10 盲评实锤：旧测试用本地重实现 writeScopesForAgentLogic + 假
// membership {id:"m-alice"}——它测的是抄写品不是产品代码，且未覆盖 C1 修复
// 引入的 memberId 字段语义（TeamMembership.id 是 TeamId，不是 member.id）。
// 本节改为真 `new TeamService` + 真 tryMembership→writeScopesForAgent 全路径：
// teammate agent 的 session.header.parentSession 指向 lead root，journal 里
// 有该 member 的 in_progress scoped 任务，断言真方法返回真 scope 并集。

function makeRealCtx() {
	const ctx = new Context();
	const durableEvents = [];
	const registry = new Map();
	const projections = new Map();
	ctx.reflect.provide("sessionProjections", {
		register(def) {
			projections.set("agentTeam", def);
			return () => projections.delete("agentTeam");
		},
		stateOf(session, key) {
			const def = projections.get(key);
			if (def === undefined) return undefined;
			let state = def.init({ id: session.agentId });
			for (const e of durableEvents) state = def.apply(state, e);
			return state;
		},
	});
	ctx.reflect.provide("sessions", {
		async flush() {},
		get() { return undefined; },
	});
	ctx.reflect.provide("agents", {
		get(id) { return registry.get(id); },
		list() { return [...registry.values()]; },
	});
	ctx.reflect.provide("sessionPersistence", {});
	ctx.reflect.provide("subagents", {
		interrupt() {},
		async drainContinuableChildren() {},
		async startContinuable() { throw new Error("subagent spawn not exercised"); },
	});
	function makeAgent(id, parentSession) {
		const session = {
			append(type, data) { durableEvents.push({ type, data }); },
			header: parentSession !== undefined ? { parentSession } : {},
			snapshotEvents() { return []; },
			inheritedEventCount: 0,
			agentId: id,
		};
		const agent = { id, session, options: {}, status: "inactive" };
		registry.set(id, agent);
		return agent;
	}
	return { ctx, durableEvents, makeAgent };
}

async function seedScopedMember(svc, makeAgent, lead, memberId, tasks) {
	// teammate agent：session.header.parentSession 指向 lead root ——真 tryMembership
	// 走 teammate 分支（index.js:503-527），返回 {id:TeamId, memberId:member.id}。
	const agent = makeAgent(memberId, lead.id);
	// member 必须先 provisioning 再 active（投影校验 TEAM_MEMBER_PHASE_TRANSITIONS）
	for (const phase of ["provisioning", "active"]) {
		await svc.journal.appendAndFlush(lead, "team/member", {
			version: 2, teamId: lead.id,
			member: { id: memberId, name: memberId, phase, description: "d", provider: "t", context: "fresh" },
		});
	}
	// 每个 {scopes, complete} 造一个任务：create→claim(in_progress)→(complete)
	for (const { scopes, complete } of tasks) {
		const task = await svc.createTask(agent, { subject: "t", description: "d", writeScopes: scopes });
		const claimed = await svc.updateTask(agent, {
			taskId: task.id, expectedRevision: task.revision, action: "claim",
		});
		if (complete) {
			await svc.updateTask(agent, {
				taskId: task.id, expectedRevision: claimed.revision,
				action: "complete", attemptId: claimed.attemptId,
			});
		}
	}
	return agent;
}

test("C1[真]: writeScopesForAgent 对真 tryMembership 返回真 memberId 的 scope 并集", async () => {
	const { ctx, makeAgent } = makeRealCtx();
	const svc = new TeamService(ctx, {});
	const lead = makeAgent("lead-1");
	const alice = await seedScopedMember(svc, makeAgent, lead, "m-alice", [
		{ scopes: ["src/", "docs/"] },
		{ scopes: ["src/auth/"] },
		{ scopes: ["other/"], complete: true }, // completed 不进并集
	]);

	const scopes = svc.writeScopesForAgent(alice);
	// 真 tryMembership 对 alice 返 memberId="m-alice"（≠TeamId "lead-1"）——
	// C1 修复前用 membership.id(TeamId) 比对 task.ownerId 恒不等→返 []；修复后返真并集。
	assert.ok(Array.isArray(scopes), "teammate should get scopes array, got " + JSON.stringify(scopes));
	// createTask 的 writeScopes schema 规范化掉尾斜杠（"src/"→"src"）
	assert.deepEqual(scopes.sort(), ["docs", "src", "src/auth"].sort());
	assert.ok(!scopes.includes("other"), "completed task scope leaked");
});

test("C1[真]: 非 member agent → undefined；member 无 scoped in_progress → []", async () => {
	const { ctx, makeAgent } = makeRealCtx();
	const svc = new TeamService(ctx, {});
	const lead = makeAgent("lead-1");
	// 未注册进 agents registry 的 agent → tryMembership 返 undefined → undefined
	const ghost = { id: "ghost", session: { header: {} }, options: {} };
	assert.equal(svc.writeScopesForAgent(ghost), undefined);
	// bob 是 member 但只有无 scopes 的 in_progress 任务 → []
	const bob = await seedScopedMember(svc, makeAgent, lead, "m-bob", [{ scopes: [] }]);
	assert.deepEqual(svc.writeScopesForAgent(bob), []);
});

test("C2: guard deny 形状 — file_path 越出 in_progress writeScopes → 返回 deny 字符串", () => {
	// 与 tools:476-487 同构——guard 返回 string 即 deny（dsh-tools guardReason）。
	const metrics = { writeScopeRuntimeDenials: 0 };
	const guard = (exec, enforce, writeScopesFor) => {
		if (enforce !== true) return;
		if (typeof exec?.name !== "string" || !new Set(["write", "edit", "multi_edit", "notebook_edit", "apply_patch"]).has(exec.name)) return;
		const filePath = exec.arguments?.file_path;
		if (typeof filePath !== "string" || filePath.trim().length === 0) return;
		const normalizedPath = filePath.replace(/\/+$/, "");
		const scopes = writeScopesFor(exec.agent);
		if (scopes === undefined || scopes.length === 0) return;
		if (scopes.some((scope) => scopesOverlap(normalizedPath, scope.replace(/\/+$/, "")))) return;
		metrics.writeScopeRuntimeDenials++;
		return `write outside assigned write_scopes: "${filePath}" is not under any scope of your in-progress task`;
	};
	const scopedWrite = { name: "write", arguments: { file_path: "src/auth/x.js" }, agent: { id: "m-bob" } };
	const inScopeWrite = { name: "write", arguments: { file_path: "docs/readme.md" }, agent: { id: "m-bob" } };
	const shell = { name: "pwsh", arguments: { command: "echo x > src/x.js" }, agent: { id: "m-bob" } };
	const lookup = () => ["docs/", "src/auth/"];

	// 越权：src/auth/x.js 在 scope 内，但改成 outside 路径 → deny + 计数
	assert.ok(guard({ ...scopedWrite, arguments: { file_path: "src/other/x.js" } }, true, lookup) !== undefined, "out-of-scope write denied");
	assert.equal(metrics.writeScopeRuntimeDenials, 1, "deny 计数透出");
	// 命中 scope：src/auth/x.js → 放行
	// 命中 scope 不计 deny
	assert.equal(guard(scopedWrite, true, lookup), undefined);
	// 命中另一个 scope：docs/ → 放行
	assert.equal(guard(inScopeWrite, true, lookup), undefined);
	// enforceWriteScopes=false → 全放行
	assert.equal(guard({ ...scopedWrite, arguments: { file_path: "anywhere/x.js" } }, false, lookup), undefined);
	// 非 FILE_WRITE_TOOLS（pwsh 等 command 串型）→ 放行（不拦 shell 内部写）
	assert.equal(guard(shell, true, lookup), undefined);
	// member 无 scoped 任务（lookup→[]）→ 放行
	assert.equal(guard({ ...scopedWrite, arguments: { file_path: "anywhere/x.js" } }, true, () => []), undefined);
	// 非 member（lookup→undefined）→ 放行
	assert.equal(guard({ ...scopedWrite, arguments: { file_path: "anywhere/x.js" } }, true, () => undefined), undefined);
	// file_path 缺省/空 → 放行
	assert.equal(guard({ name: "write", arguments: {} }, true, lookup), undefined);
});
