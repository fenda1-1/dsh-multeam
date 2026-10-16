import { bundle } from './support.mjs'
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mod = bundle;
const proto = mod.TeamScheduler.prototype;

const makeScheduler = (overrides = {}) => Object.assign(Object.create(proto), {
	config: { learnedHints: true },
	lessonsByTag: new Map(),
	perfMap: new Map(),
	perfLoaded: new Map(),
	perfDirty: new Map(),
	dispatchFailures: new Map(),
	ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
}, overrides);

const LEAD = "lead-1";
const state = (tasks) => ({
	id: LEAD,
	members: [{ id: "alice-1", name: "alice", phase: "active" }],
	tasks,
});
const done = (id, ownerId, subject, extra = {}) => ({
	id, ownerId, status: "completed", revision: 1, subject, description: "", ...extra,
});

// 不含任何能力关键词的中性文案 → inferCapabilityTag 返回 undefined。
const NEUTRAL = "收尾整理";

describe("lessons handoff (经验注入)", () => {
	it("untagged task's lesson lands in the general bucket (L9 fallback)", () => {
		const sched = makeScheduler();
		const tasks = [done("task-1", "alice-1", NEUTRAL, { lesson: "先 core 后 tools" })];
		sched.collectLessons(state(tasks), tasks, LEAD);
		const general = sched.lessonsByTag.get("general");
		assert.deepStrictEqual(general?.map((l) => l.text), ["先 core 后 tools"]);
		assert.strictEqual(general[0].from, "alice");
		assert.strictEqual(general[0].taskId, "task-1");
	});

	it("buildLessonsHint injects the general bucket for an untagged task (write/read symmetry)", () => {
		const sched = makeScheduler();
		const tasks = [done("task-1", "alice-1", NEUTRAL, { lesson: "先 core 后 tools" })];
		sched.collectLessons(state(tasks), tasks, LEAD);
		const hint = sched.buildLessonsHint({ subject: NEUTRAL, description: "" });
		assert.match(hint, /📚 经验提示/);
		assert.match(hint, /- alice: 先 core 后 tools/);
	});

	it("lead-owned lessons are attributed to 'lead'", () => {
		const sched = makeScheduler();
		const tasks = [done("task-1", LEAD, NEUTRAL, { lesson: "lead 经验" })];
		sched.collectLessons(state(tasks), tasks, LEAD);
		assert.strictEqual(sched.lessonsByTag.get("general")[0].from, "lead");
	});

	it("returns '' when learnedHints is off", () => {
		const sched = makeScheduler({ config: { learnedHints: false } });
		const tasks = [done("task-1", "alice-1", NEUTRAL, { lesson: "x" })];
		sched.collectLessons(state(tasks), tasks, LEAD);
		assert.strictEqual(sched.buildLessonsHint({ subject: NEUTRAL, description: "" }), "");
	});

	it("returns '' for a capability tag that has no lessons yet", () => {
		const sched = makeScheduler();
		const tasks = [done("task-1", "alice-1", NEUTRAL, { lesson: "x" })];
		sched.collectLessons(state(tasks), tasks, LEAD);
		assert.strictEqual(sched.buildLessonsHint({ subject: "实现压缩流水线", description: "" }), "");
	});

	it("task.lesson wins over a description 经验: line; the description line is used otherwise", () => {
		const sched = makeScheduler();
		const tasks = [
			done("task-1", "alice-1", NEUTRAL, { lesson: "显式 lesson", description: "经验：描述里的教训" }),
			done("task-2", "alice-1", NEUTRAL, { description: "前置背景\n教训：描述里的教训" }),
		];
		sched.collectLessons(state(tasks), tasks, LEAD);
		assert.deepStrictEqual(
			sched.lessonsByTag.get("general").map((l) => l.text),
			["显式 lesson", "描述里的教训"],
		);
	});

	it("truncates an over-long description lesson to 160 chars + ellipsis", () => {
		const sched = makeScheduler();
		const tasks = [done("task-1", "alice-1", NEUTRAL, { description: `经验：${"长".repeat(200)}` })];
		sched.collectLessons(state(tasks), tasks, LEAD);
		const text = sched.lessonsByTag.get("general")[0].text;
		assert.strictEqual(text.length, 161);
		assert.ok(text.endsWith("…"));
	});

	it("re-collects a reopened task (revision bumped) but not an unchanged one", () => {
		const sched = makeScheduler();
		const tasks = [done("task-1", "alice-1", NEUTRAL, { lesson: "第一版" })];
		sched.collectLessons(state(tasks), tasks, LEAD);
		sched.collectLessons(state(tasks), tasks, LEAD);
		assert.strictEqual(sched.lessonsByTag.get("general").length, 1, "same revision → collected once");
		tasks[0].revision = 2;
		tasks[0].lesson = "第二版";
		sched.collectLessons(state(tasks), tasks, LEAD);
		assert.deepStrictEqual(sched.lessonsByTag.get("general").map((l) => l.text), ["第一版", "第二版"]);
	});

	it("addLesson dedups identical text and keeps only the newest 3 per tag", () => {
		const sched = makeScheduler();
		sched.addLesson("code", { text: "a", from: "alice", taskId: "t1" });
		sched.addLesson("code", { text: "a", from: "bob", taskId: "t2" });
		assert.strictEqual(sched.lessonsByTag.get("code").length, 1, "identical text deduped");
		for (const t of ["b", "c", "d"]) sched.addLesson("code", { text: t, from: "alice", taskId: t });
		assert.deepStrictEqual(sched.lessonsByTag.get("code").map((l) => l.text), ["b", "c", "d"]);
	});
});

describe("lessons persistence (perf.json)", () => {
	let home;
	before(() => {
		home = mkdtempSync(join(tmpdir(), "multeam-lessons-"));
		process.env.DSH_HOME = home;
	});
	after(() => {
		delete process.env.DSH_HOME;
		rmSync(home, { recursive: true, force: true });
	});

	it("savePerf writes the lessons pool (general bucket included) and loadPerf restores it", () => {
		const writer = makeScheduler();
		const tasks = [done("task-1", "alice-1", NEUTRAL, { lesson: "先 core 后 tools" })];
		writer.collectLessons(state(tasks), tasks, LEAD);
		writer.savePerf(LEAD);

		const raw = JSON.parse(readFileSync(join(home, "sessions", `${LEAD}.perf.json`), "utf8"));
		assert.strictEqual(raw.version, 1);
		assert.deepStrictEqual(raw.lessons.general.map((l) => l.text), ["先 core 后 tools"]);

		const reader = makeScheduler();
		reader.loadPerf(LEAD);
		assert.deepStrictEqual(reader.lessonsByTag.get("general").map((l) => l.text), ["先 core 后 tools"]);
		assert.strictEqual(reader.lessonsByTag.get("general")[0].from, "alice");
	});
});
