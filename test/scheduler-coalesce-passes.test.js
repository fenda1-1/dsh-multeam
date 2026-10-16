import { bundle } from './support.mjs'
import test from "node:test";
import assert from "node:assert/strict";

// Bug4: two reassign events in the same tick produced two separate scheduler
// passes → two NOTIFY_MESSAGEs to the same owner instead of one merged
// NOTIFY_MESSAGE_MULTI. Fix: schedulePass coalesces — while a pass for a
// session is pending or in-flight, additional triggers set a coalesce flag
// and exactly one follow-up pass runs after the current one.
// Tests exercise the real schedulePass via Object.create + controlled runPass.

const { TeamScheduler } = bundle;

function makeScheduler() {
	const sched = Object.create(TeamScheduler.prototype);
	sched.tails = new Map();
	sched.coalescePending = new Map();
	sched.ctx = {
		logger: { warn() {}, info() {}, error() {} },
		sessionProjections: { stateOf: () => undefined },
		agents: { get: () => undefined, list: () => [] },
	};
	sched.passCount = 0;
	sched.lastSeenRevision = new Map();
	sched.notified = new Map();
	sched.retryCount = new Map();
	sched.retryExhausted = new Map();
	sched.retryLastError = new Map();
	sched.dispatchFailures = new Map();
	sched.failureWarned = new Set();
	sched.timeoutNotified = new Map();
	sched.alertLog = new Map();
	sched.inProgressSince = new Map();
	sched.stats = { passes: 0, wakes: 0 };
	sched.perfMap = new Map();
	sched.perfDirty = false;
	sched.perfLoaded = true;
	sched.decisionLog = [];
	sched.config = {
		priority: true, timeoutMinutes: 0, loadBalance: true,
		retryLimit: 2, capabilityMatch: true,
	};
	return sched;
}

const SESSION = { id: "sess-1" };

test("two triggers during one pass coalesce into exactly one follow-up", async () => {
	const sched = makeScheduler();
	let resolveFirst;
	const gate = new Promise(r => { resolveFirst = r; });

	// Mock runPass: first call waits on gate, subsequent calls pass through
	let callCount = 0;
	sched.runPass = async () => {
		callCount++;
		if (callCount === 1) await gate;
	};

	// Start first pass (it will block on gate)
	const p1 = sched.schedulePass(SESSION);
	// Two rapid triggers while first pass is in-flight
	const p2 = sched.schedulePass(SESSION);
	const p3 = sched.schedulePass(SESSION);

	// Release the first pass
	resolveFirst();
	await p1;

	// The coalesced re-run should be scheduled; wait for it to settle
	await p2;
	await p3;
	// Give the coalesced re-run a microtask tick to complete
	await new Promise(r => setTimeout(r, 50));

	// Initial pass + exactly one coalesced follow-up = 2 total runPass calls
	assert.equal(callCount, 2, "expected initial pass + one coalesced pass");
});

test("serial calls do not coalesce", async () => {
	const sched = makeScheduler();
	let callCount = 0;
	sched.runPass = async () => { callCount++; };

	await sched.schedulePass(SESSION);
	await sched.schedulePass(SESSION);
	await sched.schedulePass(SESSION);

	assert.equal(callCount, 3, "serial calls each run their own pass");
});

test("coalesced re-run sees latest state", async () => {
	const sched = makeScheduler();
	const states = [];
	let resolveFirst;
	const gate = new Promise(r => { resolveFirst = r; });

	let callCount = 0;
	sched.runPass = async () => {
		callCount++;
		states.push(`pass-${callCount}`);
		if (callCount === 1) await gate;
	};

	const p1 = sched.schedulePass(SESSION);
	// Trigger while in-flight → coalesce
	const p2 = sched.schedulePass(SESSION);
	resolveFirst();
	await p1;
	await new Promise(r => setTimeout(r, 50));

	assert.deepEqual(states, ["pass-1", "pass-2"], "coalesced re-run executes once");
	assert.equal(callCount, 2);
});
