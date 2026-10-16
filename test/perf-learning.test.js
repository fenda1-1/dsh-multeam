import { bundle } from './support.mjs'
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = bundle;
const proto = mod.TeamScheduler.prototype;
const makeScheduler = (overrides = {}) => Object.assign(Object.create(proto), {
  config: { capabilityMatch: true },
  perfMap: new Map(),
  perfLoaded: new Map(),
  perfDirty: new Map(),
  inProgressSince: new Map(),
  timeoutNotified: new Map(),
  retryCount: new Map(),
  retryExhausted: new Map(),
  notified: new Map(),
  lastSeenRevision: new Map(),
  lastDecayAt: new Map(),
  dispatchFailures: new Map(),
  ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} }, agents: { get() { return undefined; } } },
}, overrides);

const BASE_STATE = {
  id: "lead-1",
  members: [
    { id: "alice-1", name: "alice", phase: "active", description: "refactor database schema migration" },
    { id: "bob-1", name: "bob", phase: "active", description: "frontend UI design" },
    { id: "carol-1", name: "carol", phase: "active", description: "API protocol implementation" },
  ],
};

// ── P5: collectPerf incremental ──────────────────────────────────────────────
describe("collectPerf incremental (P5)", () => {
  it("skips tasks whose revision did not change since last pass", () => {
    const sched = makeScheduler();
    const tasks = [
      { id: "task-1", ownerId: "alice-1", status: "completed", revision: 1, subject: "fix bug", description: "" },
      { id: "task-2", ownerId: "bob-1", status: "in_progress", revision: 1, subject: "add UI", description: "" },
    ];
    sched.collectPerf({ ...BASE_STATE, tasks }, tasks, "lead-1");
    assert.strictEqual(sched.perfMap.get("alice-1")?.completed, 1);
    assert.strictEqual(sched.lastSeenRevision.get("lead-1:task-1"), 1);
    // Second pass: bump only task-2's revision — task-1 must not re-count
    tasks[1].revision = 2;
    tasks[1].status = "completed";
    tasks[1].ownerId = "bob-1";
    sched.collectPerf({ ...BASE_STATE, tasks }, tasks, "lead-1");
    assert.strictEqual(sched.perfMap.get("alice-1")?.completed, 1, "task-1 unchanged → skip");
    assert.strictEqual(sched.perfMap.get("bob-1")?.completed, 1, "task-2 revision bumped → count");
  });
  it("liveTaskIds cleanup removes lastSeenRevision for deleted tasks", () => {
    const sched = makeScheduler();
    const tasks = [
      { id: "task-1", ownerId: "alice-1", status: "completed", revision: 1, subject: "x", description: "" },
      { id: "task-2", ownerId: "bob-1", status: "pending", revision: 1, subject: "y", description: "" },
    ];
    sched.collectPerf({ ...BASE_STATE, tasks }, tasks, "lead-1");
    assert.strictEqual(sched.lastSeenRevision.has("lead-1:task-2"), true);
    // task-2 deleted from board
    const liveTasks = tasks.filter((t) => t.id === "task-1");
    sched.collectPerf({ ...BASE_STATE, tasks: liveTasks }, liveTasks, "lead-1");
    assert.strictEqual(sched.lastSeenRevision.has("lead-1:task-2"), false, "deleted task key cleaned");
  });
});
// ── L4: reopen dedup via completedTaskIds ────────────────────────────────────
describe("L4 reopen dedup", () => {
  it("reopened task does not double-count completed", () => {
    const sched = makeScheduler();
    const tasks = [
      { id: "task-1", ownerId: "alice-1", status: "completed", revision: 1, subject: "x", description: "" },
    ];
    sched.collectPerf({ ...BASE_STATE, tasks }, tasks, "lead-1");
    assert.strictEqual(sched.perfMap.get("alice-1")?.completed, 1);
    // Reopen: revision bumped, status back to in_progress
    tasks[0].status = "in_progress";
    tasks[0].revision = 2;
    sched.collectPerf({ ...BASE_STATE, tasks }, tasks, "lead-1");
    assert.strictEqual(sched.perfMap.get("alice-1")?.completed, 1, "still 1 after reopen");
    // Complete again at revision 3
    tasks[0].status = "completed";
    tasks[0].revision = 3;
    sched.collectPerf({ ...BASE_STATE, tasks }, tasks, "lead-1");
    assert.strictEqual(sched.perfMap.get("alice-1")?.completed, 1, "task-1 in completedTaskIds → dedup");
  });
});

// ── L1: decay ────────────────────────────────────────────────────────────────
describe("L1 decay", () => {
  it("decays completed/timeouts after one day", () => {
    const sched = makeScheduler();
    const tasks = [
      { id: "task-1", ownerId: "alice-1", status: "completed", revision: 1, subject: "x", description: "" },
    ];
    sched.collectPerf({ ...BASE_STATE, tasks }, tasks, "lead-1");
    assert.strictEqual(sched.perfMap.get("alice-1")?.completed, 1);
    // Simulate 2 days passing
    const perf = sched.perfMap.get("alice-1");
    perf.lastDecayAt = Date.now() - 2 * 24 * 3600 * 1000;
    // Trigger decay via a second collectPerf
    sched.collectPerf({ ...BASE_STATE, tasks }, tasks, "lead-1");
    assert.ok(perf.completed < 1, `completed decayed below 1, got ${perf.completed}`);
  });

  it("skips decay for fresh entries (lastDecayAt=now)", () => {
    const sched = makeScheduler();
    const tasks = [
      { id: "task-1", ownerId: "alice-1", status: "completed", revision: 1, subject: "x", description: "" },
    ];
    sched.collectPerf({ ...BASE_STATE, tasks }, tasks, "lead-1");
    const perf = sched.perfMap.get("alice-1");
    assert.strictEqual(perf.lastDecayAt !== undefined, true, "lastDecayAt initialized");
    assert.strictEqual(perf.completed, 1, "no decay on fresh entry");
  });
});

// ── L7: dispatch penalty ──────────────────────────────────────────────────────
describe("L7 dispatch failure penalty", () => {
  it("members with recent dispatch failures get capped score", () => {
    const sched = makeScheduler();
    // alice has 5 completed database tasks, bob has 1 — normally alice wins
    for (let i = 0; i < 5; i++) {
      sched.perfMap.get("alice-1") ?? sched.perfMap.set("alice-1", { completed: 0, timeouts: 0, capabilities: new Set(), seen: new Set(), completedTaskIds: new Set(), lastDecayAt: Date.now() });
      sched.perfMap.get("alice-1").completed++;
      sched.perfMap.get("alice-1").capabilities.add("database");
      sched.perfMap.get("alice-1").capabilities.add("schema");
      sched.perfMap.get("alice-1").capabilities.add("refactor");
    }
    // But alice just had a dispatch failure
    sched.dispatchFailures.set("alice-1", { count: 1, ts: Date.now() });
    // Now score both on a database task
    const hintResult = sched.buildCapabilityHint(
      { id: "task-1", subject: "refactor database schema", description: "optimize table indexes" },
      BASE_STATE,
      "lead-1"
    );
    // alice should still appear but with penalty note
    assert.ok(hintResult !== undefined, "hint exists");
    assert.ok(hintResult.suggestions.some((h) => h.includes("alice") && h.includes("⚠️派发失败")), `alice penalized, got ${JSON.stringify(hintResult)}`);
  });

  it("penalty decays after 30 minutes", () => {
    const sched = makeScheduler();
    sched.dispatchFailures.set("alice-1", { count: 1, ts: Date.now() - 31 * 60 * 1000 });
    const hintResult = sched.buildCapabilityHint(
      { id: "task-1", subject: "refactor database schema", description: "optimize table indexes" },
      BASE_STATE,
      "lead-1"
    );
    // alice should appear without penalty (dispatchFailures entry expired)
    if (hintResult !== undefined) {
      assert.ok(!hintResult.suggestions.some((h) => h.includes("⚠️派发失败")), "no penalty after 30min");
    }
  });
});
