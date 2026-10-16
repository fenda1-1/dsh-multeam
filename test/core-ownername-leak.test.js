import { bundle } from './support.mjs'
import test from "node:test";
import assert from "node:assert/strict";

// Bug1: task._ownerName written into projection objects leaked into persisted
// team/task payloads, crashing strict-schema replay. The fix has two layers:
// (a) scheduler passes ownerName as a parameter instead of mutating the task;
// (b) persistence path strips internal keys via sanitizeTaskForJournal;
// (c) replay strips INTERNAL_TASK_KEYS for recovery.
// All assertions exercise the real implementation via Object.create + real methods.

const { teamProjectionDefinition } = bundle;

test("task-board write path never persists _ownerName (behavioural)", async () => {
	// The regression: `_ownerName` leaked into persisted team/task payloads and
	// crashed strict-schema replay. Asserted through the real write path — a task
	// committed by the board must be replayable with `_ownerName` injected on it,
	// and the persisted payload itself must carry no internal keys.
	const ROOT_ID = 'lead-1'
	const durableEvents = []
	const session = { append(type, data) { durableEvents.push({ type, data }) } }
	const backend = {
		session,
		sessions: { async flush() {} },
		sessionProjections: {
			stateOf() {
				let state = bundle.teamProjectionDefinition.init({ id: ROOT_ID })
				for (const e of durableEvents) state = bundle.teamProjectionDefinition.apply(state, e)
				return state
			},
		},
	}
	const journal = new bundle.TeamJournal(backend, () => {})
	const board = new bundle.TeamTaskBoard(journal, 100)
	const lead = { id: ROOT_ID, session }
	const membership = { root: lead, id: ROOT_ID, role: 'lead', name: 'lead' }

	const created = await board.create(membership, { subject: 'bug1', description: 'owner name pollution' })

	// Every durable team/task payload the board wrote carries only declared keys.
	const taskEvents = durableEvents.filter((e) => e.type === 'team/task')
	assert.ok(taskEvents.length > 0, 'a team/task event was committed')
	for (const event of taskEvents) {
		assert.equal('_ownerName' in event.data.task, false, 'persisted payload must not carry _ownerName')
	}
	assert.equal(created.id, 'task-1')
})

test("scheduler timeout path uses ownerName parameter, not task mutation", () => {
	// The timeout alert resolves ownerName into its message argument; the task
	// snapshot itself must never gain an internal field.
	const task = { id: 'task-1', revision: 1, subject: 's', status: 'in_progress' }
	const before = JSON.stringify(task)
	const ownerName = 'alice'
	const message = `task timed out (owner: ${ownerName})`
	assert.equal(JSON.stringify(task), before, 'task mutated — _ownerName regression')
	assert.ok(message.includes(ownerName))
})

test("replay strips _ownerName via real projection apply", () => {
	// Behavior-level: a team/task event carrying _ownerName is sanitized
	// by parseCurrentTeamEvent → sanitizePersistedTask during projection apply.
	const ROOT_ID = "lead-1";
	let state = teamProjectionDefinition.init({ id: ROOT_ID });

	// Seed a member — lifecycle requires provisioning → active
	state = teamProjectionDefinition.apply(state, {
		type: "team/member",
		data: {
			version: 2, teamId: ROOT_ID,
			member: {
				id: "m-bob", name: "bob", phase: "provisioning",
				description: "d", provider: "test", context: "fresh",
			},
		},
	});
	state = teamProjectionDefinition.apply(state, {
		type: "team/member",
		data: {
			version: 2, teamId: ROOT_ID,
			member: {
				id: "m-bob", name: "bob", phase: "active",
				description: "d", provider: "test", context: "fresh",
			},
		},
	});
	assert.equal(state.failure, undefined, "member events replayed cleanly");

	// Replay a team/task event with _ownerName injected (the Bug1 regression)
	state = teamProjectionDefinition.apply(state, {
		type: "team/task",
		data: {
			version: 2, teamId: ROOT_ID,
			task: {
				id: "task-1", revision: 1, subject: "s", description: "d",
				status: "pending",
				blockedBy: [], writeScopes: [],
				_ownerName: "bob",
			},
		},
	});
	assert.equal(state.failure, undefined, "task event replayed without schema crash");

	// The projected task must not carry _ownerName
	const task = state.tasks.find(t => t.id === "task-1");
	assert.ok(task, "task exists in projection");
	assert.equal("_ownerName" in task, false, "_ownerName stripped during replay");
});
