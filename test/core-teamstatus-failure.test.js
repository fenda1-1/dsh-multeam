import { bundle } from './support.mjs'
import test from "node:test";
import assert from "node:assert/strict";

// Bug2: teamStatus() returned `failure: state.failure` unconditionally.
// When healthy, state.failure is undefined → { failure: undefined } fails
// lossless-JSON output validation (undefined is not a JSON value).
// Fix: spread conditionally, matching STATUS_VALUE_SCHEMA where failure
// is not a required property.
// All assertions exercise the real TeamService.teamStatus via Object.create.

const { TeamService } = bundle;

function makeService(stateOverrides = {}) {
	const svc = Object.create(TeamService.prototype);
	const state = {
		id: "team-1",
		members: [],
		tasks: [],
		messages: [],
		delivered: [],
		...stateOverrides,
	};
	svc.roster = {
		membership: () => ({ root: { id: "lead-1" } }),
		list: () => [],
	};
	svc.journal = {
		state: () => state,
		queueDepth: () => 0,
	};
	svc.tasks = { list: () => [] };
	svc.metrics = {
		messagesSent: 0, messagesDelivered: 0, messagesDeadLettered: 0,
		tasksCreated: 0, tasksCompleted: 0, tasksReopened: 0,
		dispatchFailures: 0, memberReleases: 0, waitCalls: 0,
		writeScopeConflicts: 0,
	};
	return svc;
}

test("healthy state omits failure key entirely", () => {
	const svc = makeService({ failure: undefined });
	const out = svc.teamStatus({ id: "lead-1" });
	assert.equal("failure" in out, false);
	// Must survive a lossless JSON round trip with no undefined values.
	const roundTrip = JSON.parse(JSON.stringify(out));
	assert.deepEqual(roundTrip, out);
});

test("failed state includes failure payload", () => {
	const svc = makeService({ failure: "projection crashed" });
	const out = svc.teamStatus({ id: "lead-1" });
	assert.equal(out.failure, "projection crashed");
});

test("teamStatus includes journalQueueDepth and metrics", () => {
	const svc = makeService();
	svc.journal.queueDepth = () => 5;
	const out = svc.teamStatus({ id: "lead-1" });
	assert.equal(out.journalQueueDepth, 5);
	assert.ok(out.metrics, "metrics snapshot included");
	assert.equal(typeof out.metrics.counters, "object");
});
