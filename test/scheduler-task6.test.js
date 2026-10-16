import { bundle } from './support.mjs'
import test from "node:test";
import assert from "node:assert/strict";

// task-6 修复点回归：
//   ③ NOTIFY_MESSAGE_MULTI 文案从「请逐个 claim 并执行」改为 claim-once 语义
//   ④ 📚经验提示按任务关键词∩来源任务关键词过滤，无相关不附
//   ⑤ 'code' 桶正则 implement 重复项已删（行为不变，由类型检查覆盖）

const { TeamScheduler } = bundle;

function makeScheduler(overrides = {}) {
	const sched = Object.create(TeamScheduler.prototype);
	sched.config = {
		capabilityMatch: true, timeoutDetection: false, timeoutMs: 300000,
		loadBalance: false, priority: false, retryLimit: 2,
		notifyUnassigned: true, learnedHints: true,
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
	sched.lessonsByTag = new Map();
	sched.lessonSeen = new Set();
	sched.stats = new Map();
	sched.alertLog = [];
	sched.decisionLog = new Map();
	sched.sendLog = [];
	sched.ctx = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		agents: { get(id) { return overrides.agents?.[id]; }, list() { return overrides.agentList ?? []; } },
		agentTeams: { async sendMessage(agent, env) { sched.sendLog.push(env); } },
		sessionProjections: overrides.sessionProjections,
	};
	return sched;
}

const LEAD = "lead-1";
const MEMBER = { id: "alice-1", name: "alice", phase: "active", description: "代码" };

function projectionsWith(tasks) {
	return {
		stateOf() {
			return { id: LEAD, failure: undefined, members: [MEMBER], tasks };
		},
	};
}

const done = (id, ownerId, subject, extra = {}) => ({
	id, ownerId, status: "completed", revision: 1, subject, description: "", ...extra,
});

// ── ③ NOTIFY_MESSAGE_MULTI 文案 ──

test("multi-ready wake tells owner to execute sequentially under claim-once", async () => {
	const sched = makeScheduler({
		agents: { [LEAD]: { steer() {} } },
		sessionProjections: projectionsWith([
			{ id: "task-1", ownerId: "alice-1", status: "pending", subject: "实现 A", blockedBy: [], revision: 1 },
			{ id: "task-2", ownerId: "alice-1", status: "pending", subject: "实现 B", blockedBy: [], revision: 1 },
		]),
	});
	await sched.runPass({ id: LEAD });
	assert.equal(sched.sendLog.length, 1, "two ready tasks still coalesce into one message");
	const text = sched.sendLog[0].content?.[0]?.text ?? "";
	assert.ok(!text.includes("请逐个 claim 并执行"), "old parallel-claim wording removed");
	assert.ok(text.includes("claim-once"), "message states the claim-once rule");
	assert.ok(text.includes("逐个") || text.includes("顺序"), "message keeps sequential guidance");
});

// ── ④ 经验提示相关性过滤 ──

test("buildLessonsHint drops lessons whose source keywords do not overlap the task", () => {
	const sched = makeScheduler();
	// 无关 code 任务的经验（前端样式）不应注入到数据库任务
	sched.addLesson("code", { text: "样式重构先冻结快照", from: "alice", taskId: "t-old", caps: ["样式", "style", "前端", "frontend"] });
	const hint = sched.buildLessonsHint({ subject: "修数据库迁移 bug", description: "database migrate 修复" });
	assert.equal(hint, "", "unrelated lesson must not be injected");
});

test("buildLessonsHint keeps lessons whose source keywords overlap the task", () => {
	const sched = makeScheduler();
	sched.addLesson("code", { text: "迁移前先备份表", from: "alice", taskId: "t-old", caps: ["数据库", "database", "迁移", "migrate"] });
	const hint = sched.buildLessonsHint({ subject: "修数据库迁移 bug", description: "database migrate 修复" });
	assert.match(hint, /📚 经验提示/);
	assert.match(hint, /迁移前先备份表/);
});

test("legacy lessons without caps pass through unfiltered", () => {
	const sched = makeScheduler();
	// 旧 perf.json 反序列化出的条目没有 caps —— fail-open，否则存量经验永远不可见
	sched.addLesson("code", { text: "先 core 后 tools", from: "alice", taskId: "t-old" });
	const hint = sched.buildLessonsHint({ subject: "修调度器 bug", description: "" });
	assert.match(hint, /先 core 后 tools/);
});

test("collectLessons records source-task caps on new entries", () => {
	const sched = makeScheduler();
	const tasks = [done("task-1", "alice-1", "实现数据库迁移", { lesson: "先备份" })];
	sched.collectLessons({ id: LEAD, members: [MEMBER], tasks }, tasks, LEAD);
	const list = sched.lessonsByTag.get("code");
	assert.equal(list.length, 1);
	assert.ok(Array.isArray(list[0].caps), "new lesson carries source-task caps");
	assert.ok(list[0].caps.includes("数据库"), "caps captured from the source task text");
});

test("mixed pool: only overlapping lessons survive in one hint", () => {
	const sched = makeScheduler();
	sched.addLesson("code", { text: "前端样式经验", from: "alice", taskId: "t1", caps: ["前端", "样式", "style"] });
	sched.addLesson("code", { text: "数据库迁移经验", from: "bob", taskId: "t2", caps: ["数据库", "迁移", "migrate"] });
	const hint = sched.buildLessonsHint({ subject: "重构数据库迁移模块", description: "refactor migrate" });
	assert.match(hint, /数据库迁移经验/);
	assert.ok(!hint.includes("前端样式经验"), "non-overlapping lesson filtered out of the same bucket");
});
