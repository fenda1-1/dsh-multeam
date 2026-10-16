import { bundle } from './support.mjs'
import test from "node:test";
import assert from "node:assert/strict";

/**
 * ⑦ journal 背压 queueDepth + backpressureWarnAt 节流告警。
 * TeamJournal.transact 用 queueDepths Map 跟踪每个 root 的排队深度；
 * 超过 backpressureWarnAt 时一次性 warn（backpressureWarned Set 去重），
 * 队列排空后清除告警标记——下次洪峰再 warn。
 * 走真实路径：TeamJournal.transact 并发排队 → queueDepth 增长 → warn 一次 →
 * 深度回落再涨 → 第二次 warn。
 */

const { TeamJournal } = bundle;

function makeJournal(threshold = 2) {
	const warnings = [];
	const ctx = {
		sessions: { async flush() {} },
		sessionProjections: {
			stateOf() { return { tasks: [], messages: [], members: [] }; },
		},
		logger: {
			warn(msg) { warnings.push(msg); },
		},
	};
	return { journal: new TeamJournal(ctx, () => {}, threshold), warnings };
}

const ROOT = "lead-1";

test("journal backpressure: depth increments on queue, warns once above threshold", async () => {
	const { journal, warnings } = makeJournal(2);

	// Gate promises so we can control the queue depth precisely
	let resolve1, resolve2, resolve3;
	const gate1 = new Promise(r => { resolve1 = r; });
	const gate2 = new Promise(r => { resolve2 = r; });
	const gate3 = new Promise(r => { resolve3 = r; });

	// Start 3 transacts — each one chains behind the previous via tails
	const p1 = journal.transact(ROOT, async () => { await gate1; return "r1"; });
	const p2 = journal.transact(ROOT, async () => { await gate2; return "r2"; });
	const p3 = journal.transact(ROOT, async () => { await gate3; return "r3"; });

	// All 3 queued → queueDepth should be 3
	assert.equal(journal.queueDepth(ROOT), 3, "three operations queued");
	// Threshold=2, depth=3 > 2 → warn fired exactly once
	assert.equal(warnings.length, 1, "one-shot warn");
	assert.match(warnings[0], /backpressure/i);
	assert.match(warnings[0], /3/);

	// Depth is advisory — no exception, all operations proceed
	resolve1();
	assert.equal(await p1, "r1");
	resolve2();
	assert.equal(await p2, "r2");
	resolve3();
	assert.equal(await p3, "r3");

	// Queue drained → depth returns to 0
	assert.equal(journal.queueDepth(ROOT), 0, "queue drained");
});

test("journal backpressure: warning re-arms after queue drains", async () => {
	const { journal, warnings } = makeJournal(1);

	// First surge: 2 ops → warn once
	let r1, r2;
	const g1 = new Promise(res => { r1 = res; });
	const g2 = new Promise(res => { r2 = res; });
	const p1 = journal.transact(ROOT, async () => { await g1; });
	const p2 = journal.transact(ROOT, async () => { await g2; });
	assert.equal(journal.queueDepth(ROOT), 2);
	assert.equal(warnings.length, 1, "first surge warned once");

	r1(); await p1;
	r2(); await p2;
	assert.equal(journal.queueDepth(ROOT), 0, "drained");

	// Second surge: 2 more ops → warn again (re-armed after drain)
	let r3, r4;
	const g3 = new Promise(res => { r3 = res; });
	const g4 = new Promise(res => { r4 = res; });
	const p3 = journal.transact(ROOT, async () => { await g3; });
	const p4 = journal.transact(ROOT, async () => { await g4; });
	assert.equal(journal.queueDepth(ROOT), 2);
	assert.equal(warnings.length, 2, "second surge warns again after re-arm");

	r3(); await p3;
	r4(); await p4;
});

test("journal backpressure: depth at or below threshold stays silent", async () => {
	const { journal, warnings } = makeJournal(5);

	// 5 concurrent ops, threshold=5 → depth never exceeds 5
	const ops = Array.from({ length: 5 }, () =>
		journal.transact(ROOT, async () => {}),
	);
	assert.equal(journal.queueDepth(ROOT), 5);
	assert.equal(warnings.length, 0, "at-threshold depth does not warn");
	await Promise.all(ops);
	assert.equal(journal.queueDepth(ROOT), 0);
});

test("journal backpressure: per-root depth tracking is independent", async () => {
	const { journal, warnings } = makeJournal(1);

	let r1;
	const g1 = new Promise(res => { r1 = res; });
	const p1 = journal.transact("lead-a", async () => { await g1; });
	assert.equal(journal.queueDepth("lead-a"), 1);
	assert.equal(journal.queueDepth("lead-b"), 0, "other root unaffected");

	// lead-a depth=1, threshold=1 → not exceeded yet (1 > 1 is false)
	assert.equal(warnings.length, 0, "no warn for lead-a yet");

	// Push lead-a over threshold
	let r2;
	const g2 = new Promise(res => { r2 = res; });
	const p2 = journal.transact("lead-a", async () => { await g2; });
	assert.equal(journal.queueDepth("lead-a"), 2);
	assert.equal(warnings.length, 1, "lead-a exceeded threshold → warn");

	r1(); await p1;
	r2(); await p2;
});

test("journal backpressure: disabled with threshold <= 0", async () => {
	const { journal, warnings } = makeJournal(0);

	// Even deep queue should not warn when threshold <= 0
	let resolvers = [];
	const ops = Array.from({ length: 10 }, (_, i) => {
		let r;
		const g = new Promise(res => { r = res; });
		resolvers.push(r);
		return journal.transact(ROOT, async () => { await g; });
	});
	assert.equal(journal.queueDepth(ROOT), 10, "all 10 queued");
	assert.equal(warnings.length, 0, "disabled → no warnings");

	resolvers.forEach(r => r());
	await Promise.all(ops);
	assert.equal(journal.queueDepth(ROOT), 0);
});
