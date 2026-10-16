import { bundle } from './support.mjs'
import test from "node:test";
import assert from "node:assert/strict";

/**
 * ③ 死信 deadLetterAfterMs 到期：markDelivered + lead steer 告警。
 * 直接调用真实 TeamMailbox.expireDeadLetters（core 聚合区），
 * 断言：未投递消息过期后 1) 投影 delivered 标记写入、2) leadAgent.steer 收到
 * 死信告警、3) 并发重入被 deadLetterInFlight 去重。
 * deadLetterInFlight 是聚合区 class field（L869），types/mailbox.js 缺失——
 * 用聚合区原型做测试对象以保证字段在。
 */

const { TeamMailbox } = bundle;
const { teamProjectionDefinition } = bundle;
const { TeamJournal } = bundle;

function makeBackend(rootId = "lead-1") {
	const durableEvents = [];
	const session = { append(t, d) { durableEvents.push({ type: t, data: d }); } };
	return {
		session,
		durableEvents,
		sessions: { async flush() {} },
		sessionProjections: {
			stateOf(_s, key) {
				let state = teamProjectionDefinition.init({ id: rootId });
				for (const e of durableEvents) state = teamProjectionDefinition.apply(state, e);
				return state;
			},
		},
	};
}

function member(id, name, phase = "active") {
	return { id, name, phase, description: "d", provider: "t", context: "fresh" };
}

const ROOT_ID = "lead-1";

function makeMailbox(backend, deadLetterAfterMs) {
	const steers = [];
	const leadAgent = {
		id: ROOT_ID,
		steer(msg) { steers.push(msg); },
	};
	const journal = new TeamJournal(backend, () => {});
	const ctx = {
		...backend,
		agents: { get(id) { return id === ROOT_ID ? leadAgent : undefined; }, list() { return [leadAgent]; } },
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	};
	const lifecycle = { disposed: false, signal: AbortSignal.timeout(60000) };
	const mailbox = new TeamMailbox(ctx, journal, null, lifecycle, 10, 8192, deadLetterAfterMs);
	return { mailbox, journal, steers, leadAgent };
}

async function seedMemberAndMessage(backend, journal, msgOverrides = {}) {
	const root = { id: ROOT_ID, session: backend.session };
	// member provisioning→active
	await journal.appendAndFlush(root, "team/member", {
		version: 2, teamId: ROOT_ID,
		member: member("m1", "alice", "provisioning"),
	});
	await journal.appendAndFlush(root, "team/member", {
		version: 2, teamId: ROOT_ID,
		member: member("m1", "alice", "active"),
	});
	// 入队消息
	const msg = {
		id: "msg-old-1", senderId: ROOT_ID, senderName: "lead",
		targetId: "m1", content: [{ type: "text", text: "stale" }],
		queuedAt: Date.now() - 10 * 60 * 1000, // 10 分钟前入队
		...msgOverrides,
	};
	await journal.appendAndFlush(root, "team/message/queued", {
		version: 2, teamId: ROOT_ID, message: msg,
	});
	return { root, msg };
}

test("dead-letter: expired undelivered message → markDelivered + lead steer", async () => {
	const backend = makeBackend();
	const { mailbox, journal, steers, leadAgent } = makeMailbox(backend, 60_000); // TTL=1min

	const { root, msg } = await seedMemberAndMessage(backend, journal);
	const state = journal.state(root);
	assert.ok(!state.delivered.includes(msg.id), "not delivered yet");

	await mailbox.expireDeadLetters(root, leadAgent, state);

	const after = journal.state(root);
	assert.ok(after.delivered.includes(msg.id), "expired message marked delivered");
	assert.equal(steers.length, 1, "one dead-letter steer");
	const text = steers[0]?.content?.[0]?.text ?? "";
	assert.ok(text.includes("死信"), "steer mentions dead-letter");
	assert.ok(text.includes(msg.id), "steer references message id");
	assert.equal(steers[0].source?.alert, "dead-letter");
});

test("dead-letter: non-expired message untouched", async () => {
	const backend = makeBackend();
	const { mailbox, journal, steers, leadAgent } = makeMailbox(backend, 60_000);

	// 入队新消息（queuedAt = 现在 → 未过期）
	const { root } = await seedMemberAndMessage(backend, journal, {
		queuedAt: Date.now(),
	});
	const state = journal.state(root);
	await mailbox.expireDeadLetters(root, leadAgent, state);
	assert.equal(steers.length, 0, "no steer for fresh message");
	assert.equal(journal.state(root).delivered.length, 0);
});

test("dead-letter: already delivered message skipped", async () => {
	const backend = makeBackend();
	const { mailbox, journal, steers, leadAgent } = makeMailbox(backend, 60_000);

	const { root, msg } = await seedMemberAndMessage(backend, journal);
	// 手动 markDelivered
	await mailbox.markDelivered(root, msg.id, "m1");
	const state = journal.state(root);
	await mailbox.expireDeadLetters(root, leadAgent, state);
	assert.equal(steers.length, 0, "no steer for already delivered");
});

test("dead-letter: deadLetterAfterMs=0 disables sweep", async () => {
	const backend = makeBackend();
	const { mailbox, journal, steers, leadAgent } = makeMailbox(backend, 0);

	const { root, msg } = await seedMemberAndMessage(backend, journal);
	const state = journal.state(root);
	await mailbox.expireDeadLetters(root, leadAgent, state);
	assert.equal(steers.length, 0);
	assert.equal(journal.state(root).delivered.length, 0);
});

test("dead-letter: concurrent calls deduplicated by deadLetterInFlight", async () => {
	const backend = makeBackend();
	const { mailbox, journal, steers, leadAgent } = makeMailbox(backend, 60_000);

	const { root, msg } = await seedMemberAndMessage(backend, journal);
	const state = journal.state(root);

	// 并发两个 expireDeadLetters——deadLetterInFlight 去重
	await Promise.all([
		mailbox.expireDeadLetters(root, leadAgent, state),
		mailbox.expireDeadLetters(root, leadAgent, state),
	]);
	// 只应有一条 steer（第二条发现 deadLetterInFlight 或 delivered 后跳过）
	assert.equal(steers.length, 1, "concurrent sweeps produce one steer");
});
