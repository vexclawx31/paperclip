import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// LIT-119 combined offline failure-to-recovery scenario. Fake adapter only: no
// provider, Slack, launchd/systemd or production service is reached. Each
// adapter call runs a scripted "agent turn" that mutates the issue the way the
// PATCH /issues route does (service update + unblock notification).

const turns = vi.hoisted(() => ({ queue: [] as Array<(ctx: unknown) => Promise<unknown>>, seen: [] as unknown[] }));

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (ctx: unknown) => {
    turns.seen.push(ctx);
    const turn = turns.queue.shift();
    const result = (turn ? await turn(ctx) : undefined) as Record<string, unknown> | undefined;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Turn finished.",
      provider: "test",
      model: "test-model",
      ...(result ?? {}),
    };
  }),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: vi.fn(() => "test-private-reference") }),
}));
vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>("@paperclipai/shared/telemetry");
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import { deliverAgentUnblockNotification } from "../services/routable-blocked.ts";
import { readIssueDurableWaitingPath } from "../services/recovery/disposition-repair.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping LIT-119 self-unblock integration tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

const ACTION = "Reconcile the B1/B2 findings into the roadmap document";

describeEmbeddedPostgres("self-unblock continuation (offline integration)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lit119-self-unblock-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    turns.queue.length = 0;
    turns.seen.length = 0;
    vi.clearAllMocks();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const prefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerUserId, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Vex", role: "engineer", status: "idle",
      adapterType: "hermes_gateway", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Roadmap", status: "in_progress", priority: "high", assigneeAgentId: agentId, responsibleUserId: ownerUserId, issueNumber: 1, identifier: `${prefix}-1` },
      { id: otherIssueId, companyId, title: "Other lane", status: "in_progress", priority: "high", assigneeAgentId: agentId, responsibleUserId: ownerUserId, issueNumber: 2, identifier: `${prefix}-2` },
    ]);
    return { companyId, agentId, issueId, otherIssueId };
  }

  async function agentComment(issueId: string, agentId: string, runId: string | undefined, body: string) {
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]!);
    await db.insert(issueComments).values({
      companyId: issue.companyId, issueId, authorAgentId: agentId, authorType: "agent",
      createdByRunId: runId ?? null, body,
    });
  }

  // What PATCH /issues does for an agent self-park, minus HTTP: commit the
  // blocked status with a self-owned descriptor, then notify the owner.
  async function selfPark(issueId: string, agentId: string, runId?: string) {
    const heartbeat = heartbeatService(db);
    // The parking turn also comments, as real coordinator turns do; a comment
    // must not turn a self-park into "advanced".
    await agentComment(issueId, agentId, runId, "Blocked with an exact Vex-owned unblock action. Vex owns the next step.");
    const current = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]!);
    if (current.status === "blocked") {
      await issueService(db).update(issueId, { status: "in_progress" });
    }
    const updated = await issueService(db).update(issueId, {
      status: "blocked",
      unblockDescriptor: { owner: { agentId }, action: ACTION },
    });
    let notifiedAt: Date | null = null;
    const notify = () => deliverAgentUnblockNotification({
      issue: updated as never,
      wakeup: heartbeat.wakeup as never,
      markNotified: async (at) => { notifiedAt = at; },
      durableWaitingPath: () => readIssueDurableWaitingPath(db, updated!),
    });
    await notify();
    // A duplicate delivery of the same transition (retry, double click) must
    // not create a second follow-up.
    await heartbeat.wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_unblock_requested",
      idempotencyKey: `issue-unblock:${issueId}:${updated!.blockedTransitionAt!.toISOString()}`,
      payload: { issueId, action: ACTION },
      contextSnapshot: { wakeReason: "issue_unblock_requested", issueId, taskId: issueId },
    });
    if (notifiedAt) await db.update(issues).set({ blockedOwnerNotifiedAt: notifiedAt }).where(eq(issues.id, issueId));
  }

  async function settle(agentId: string, timeoutMs = 20_000) {
    const heartbeat = heartbeatService(db);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await heartbeat.drainActiveRunExecutions();
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const live = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));
      if (live.length === 0) return;
      if (Date.now() > deadline) throw new Error(`runs still live: ${live.length}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  function wakeText(ctx: unknown) {
    return JSON.stringify((ctx as AdapterExecutionContext).context ?? {});
  }

  async function start(agentId: string, issueId: string) {
    return heartbeatService(db).wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId }, contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
  }

  it("A: self-park during the run yields one queued follow-up that receives the action and acts", async () => {
    const { agentId, issueId } = await seed();
    turns.queue.push(async (ctx) => {
      await selfPark(issueId, agentId, (ctx as AdapterExecutionContext).runId);
      return { summary: "Restored the issue to blocked. Vex owns the reconciliation." };
    });
    turns.queue.push(async (ctx) => {
      // Productive next action: the follow-up does the owned work and closes.
      await issueService(db).update(issueId, { status: "in_progress" });
      await agentComment(issueId, agentId, (ctx as AdapterExecutionContext).runId, "Reconciled B1/B2 into the roadmap.");
      await issueService(db).update(issueId, { status: "done" });
      return { summary: "Reconciled and closed." };
    });

    await start(agentId, issueId);
    await settle(agentId);

    // The self-unblock wake was held behind the running run (not merged into
    // it) and promoted as one follow-up after it exited; the duplicate
    // delivery merged into that same deferred wake.
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    const unblockWakes = wakes.filter((w) => w.idempotencyKey?.startsWith(`issue-unblock:${issueId}:`));
    expect(unblockWakes).toHaveLength(1);
    expect(unblockWakes[0]!.status).toBe("completed");
    expect(unblockWakes[0]!.coalescedCount).toBe(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    const followup = runs.find((r) => r.id === unblockWakes[0]!.runId)!;
    expect(followup.status).toBe("succeeded");
    expect(followup.continuationAttempt).toBe(1);
    // The next run received the explicit action in its rendered wake prompt.
    expect(turns.seen).toHaveLength(2);
    const prompt = renderPaperclipWakePrompt((turns.seen[1] as AdapterExecutionContext).context.paperclipWake);
    expect(prompt).toContain(`Do this action now: ${ACTION}`);
    expect(prompt).toContain("unblock_requested");
    expect(prompt).toContain("attempt: 1/2");
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]!);
    expect(issue.status).toBe("done");
  }, 60_000);

  it("B: repeated no-progress self-parks are bounded and end in one durable board escalation", async () => {
    const { agentId, issueId } = await seed();
    for (let i = 0; i < 6; i += 1) {
      turns.queue.push(async (ctx) => {
        await selfPark(issueId, agentId, (ctx as AdapterExecutionContext).runId);
        return { summary: "Vex will prepare the reconciliation next." };
      });
    }

    await start(agentId, issueId);
    await settle(agentId);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    // Initial run + at most two bounded continuations; no self-wake loop.
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.length).toBeLessThanOrEqual(3);
    const escalations = await db.select().from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.sourceIssueId, issueId), eq(issueRecoveryActions.status, "active")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.ownerType).toBe("board");
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]!);
    expect(issue.status).toBe("blocked");
    expect(issue.assigneeAgentId).toBe(agentId);
    // Settled: nothing further is queued after the escalation.
    const live = await db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));
    expect(live).toHaveLength(0);
  }, 60_000);

  it("C: a real dependency wait is untouched (no follow-up continuation)", async () => {
    const { companyId, agentId, issueId, otherIssueId } = await seed();
    turns.queue.push(async () => {
      // A real blocker issue plus the self-owned descriptor.
      await db.insert(issueRelations).values({ companyId, issueId: otherIssueId, relatedIssueId: issueId, type: "blocks" });
      await issueService(db).update(issueId, {
        status: "blocked",
        unblockDescriptor: { owner: { agentId }, action: ACTION },
      });
      return { summary: "Waiting on the blocker issue." };
    });

    await start(agentId, issueId);
    await settle(agentId);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.livenessState).toBe("blocked");
    const escalations = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(escalations).toHaveLength(0);
  }, 60_000);

  it("D: a failed follow-up is not counted as productive next work", async () => {
    const { agentId, issueId } = await seed();
    turns.queue.push(async (ctx) => {
      await selfPark(issueId, agentId, (ctx as AdapterExecutionContext).runId);
      return { summary: "Parked on my own action." };
    });
    turns.queue.push(async () => ({ exitCode: 1, errorMessage: "Hermes gateway HTTP 400: Run environment denied by policy", errorCode: "hermes_gateway_protocol_error" }));

    await start(agentId, issueId);
    await heartbeatService(db).drainActiveRunExecutions();
    await settle(agentId).catch(() => undefined);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    const failed = runs.find((r) => r.status === "failed");
    expect(failed).toBeTruthy();
    expect(failed!.livenessState).toBe("failed");
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]!);
    expect(issue.status).not.toBe("done");
    expect(runs.some((r) => r.livenessState === "advanced" || r.livenessState === "completed")).toBe(false);
  }, 60_000);

  it("E: the same agent running a different issue is not a lane conflict for the self-unblock wake", async () => {
    const { agentId, issueId, otherIssueId } = await seed();
    let releaseOther!: () => void;
    const otherGate = new Promise<void>((resolve) => { releaseOther = resolve; });
    // Issue Y's run stays running while issue X is self-parked by the board on behalf of the agent.
    turns.queue.push(async () => { await otherGate; return { summary: "Other lane done." }; });
    turns.queue.push(async () => {
      await issueService(db).update(issueId, { status: "done" });
      return { summary: "Did the owned unblock action." };
    });

    await start(agentId, otherIssueId);
    // Wait until the other lane is running.
    for (let i = 0; i < 100 && turns.seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    const updated = await issueService(db).update(issueId, {
      status: "blocked",
      unblockDescriptor: { owner: { agentId }, action: ACTION },
    });
    await deliverAgentUnblockNotification({ issue: updated as never, wakeup: heartbeatService(db).wakeup as never, markNotified: async () => undefined, durableWaitingPath: () => readIssueDurableWaitingPath(db, updated!) });
    for (let i = 0; i < 200 && turns.seen.length < 2; i += 1) await new Promise((r) => setTimeout(r, 20));
    // The unblock wake ran its own run on issue X while Y was still running.
    expect(turns.seen).toHaveLength(2);
    expect(wakeText(turns.seen[1])).toContain(ACTION);
    releaseOther();
    await settle(agentId);
    const unblock = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, "issue_unblock_requested")));
    expect(unblock.map((w) => w.status)).not.toContain("coalesced");
  }, 60_000);
});
