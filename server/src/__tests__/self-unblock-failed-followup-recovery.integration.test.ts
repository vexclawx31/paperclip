import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
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
  issueThreadInteractions,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// LIT-120: a failed follow-up launch for a self-parked issue must end in a
// productive next execution or one reachable board escalation, through the
// existing recovery tick and bounded retry budget. Fake adapter and isolated
// embedded Postgres only: no provider, Slack, network or host supervisor.

const turns = vi.hoisted(() => ({
  queue: [] as Array<(ctx: unknown) => Promise<unknown>>,
  seen: [] as unknown[],
  // Launch refusals happen before the adapter is entered, so the run records
  // positive no-provider-work evidence (a known-no-effect launch failure).
  refuseLaunches: 0,
  refused: 0,
}));

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
    getServerAdapter: vi.fn(() => {
      // Session-codec lookups are not launches.
      if (turns.refuseLaunches > 0 && !(new Error().stack ?? "").includes("getAdapterSessionCodec")) {
        turns.refuseLaunches -= 1;
        turns.refused += 1;
        throw new Error("Runner launch refused: gateway unavailable");
      }
      return { supportsLocalAgentJwt: false, execute: mockAdapterExecute };
    }),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import { attentionService } from "../services/attention.ts";
import { deliverAgentUnblockNotification } from "../services/routable-blocked.ts";
import { readIssueDurableWaitingPath } from "../services/recovery/disposition-repair.ts";
import { runningProcesses } from "../adapters/index.ts";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping LIT-120 failed follow-up recovery tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

const ACTION = "Reconcile the B1/B2 findings into the roadmap document";
const FAILED_LAUNCH = {
  exitCode: 1,
  errorMessage: "Hermes gateway HTTP 400: Run environment denied by policy",
  errorCode: "hermes_gateway_protocol_error",
};
// Far enough ahead that every bounded retry delay is due; the budget, not the
// clock, must stop recovery.
const FAR_FUTURE = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

describeEmbeddedPostgres("failed self-unblock follow-up recovery (offline integration)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lit120-failed-followup-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    turns.queue.length = 0;
    turns.seen.length = 0;
    turns.refuseLaunches = 0;
    turns.refused = 0;
    vi.clearAllMocks();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(issueThreadInteractions);
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
    const ownerUserId = `owner-${randomUUID()}`;
    const prefix = `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerUserId, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Vex", role: "engineer", status: "idle",
      adapterType: "hermes_gateway", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Roadmap", status: "in_progress", priority: "high",
      assigneeAgentId: agentId, responsibleUserId: ownerUserId, issueNumber: 1, identifier: `${prefix}-1`,
    });
    return { companyId, agentId, issueId, ownerUserId };
  }

  // What PATCH /issues does for an agent self-park, minus HTTP.
  async function selfPark(issueId: string, agentId: string, runId: string) {
    const heartbeat = heartbeatService(db);
    const current = await issueRow(issueId);
    await db.insert(issueComments).values({
      companyId: current.companyId, issueId, authorAgentId: agentId, authorType: "agent",
      createdByRunId: runId, body: "Blocked with an exact Vex-owned unblock action.",
    });
    const updated = await issueService(db).update(issueId, {
      status: "blocked",
      unblockDescriptor: { owner: { agentId }, action: ACTION },
    });
    await deliverAgentUnblockNotification({
      issue: updated as never,
      wakeup: heartbeat.wakeup as never,
      markNotified: async (at) => {
        await db.update(issues).set({ blockedOwnerNotifiedAt: at }).where(eq(issues.id, issueId));
      },
      durableWaitingPath: () => readIssueDurableWaitingPath(db, updated!),
    });
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

  // One supervisor-free recovery cycle: the server's own recovery tick, then
  // due scheduled retries, then whatever that queued.
  async function recoveryCycle(agentId: string) {
    const heartbeat = heartbeatService(db);
    const tick = await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.promoteDueScheduledRetries(FAR_FUTURE());
    await settle(agentId);
    return tick;
  }

  async function start(agentId: string, issueId: string) {
    return heartbeatService(db).wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId }, contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
  }

  // Initial run self-parks; its follow-up launch fails. "unknown_effect" is
  // LIT-119 case D (the adapter ran and failed). "refused" fails before the
  // adapter is entered, so no provider work can have happened; `refusals`
  // launches are refused in a row, and `after` scripts the turns that follow.
  async function failedFollowup(
    agentId: string,
    issueId: string,
    mode: "unknown_effect" | "refused",
    opts: { refusals?: number; after?: Array<(ctx: unknown) => Promise<unknown>> } = {},
  ) {
    turns.queue.push(async (ctx) => {
      await selfPark(issueId, agentId, (ctx as AdapterExecutionContext).runId);
      // The follow-up is queued behind this run; refuse its launch.
      if (mode === "refused") turns.refuseLaunches = opts.refusals ?? 1;
      return { summary: "Parked on my own action." };
    });
    if (mode === "unknown_effect") turns.queue.push(async () => FAILED_LAUNCH);
    turns.queue.push(...(opts.after ?? []));
    await start(agentId, issueId);
    await settle(agentId);
    const runs = await runsFor(agentId);
    const followup = runs
      .filter((r) => (r.contextSnapshot as Record<string, unknown>).wakeReason === "issue_unblock_requested")
      .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())[0]!;
    expect(followup.status).toBe("failed");
    if (mode === "refused") {
      expect((followup.resultJson as Record<string, unknown>).executionRecovery).toMatchObject({ kind: "bootstrap", providerWorkStarted: false });
    }
    return followup;
  }

  function runsFor(agentId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
  }

  function issueRow(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]!);
  }

  function openRecoveryActions(issueId: string) {
    return db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, issueId),
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
    ));
  }

  async function boardAttentionRecoveryItems(companyId: string, ownerUserId: string, issueId: string) {
    const feed = await attentionService(db).list(companyId, { userId: ownerUserId });
    return feed.items.filter((item) =>
      item.sourceKind === "recovery_action" &&
      (item.subject.metadata as Record<string, unknown> | undefined)?.sourceIssueId === issueId);
  }

  // Shared assertions for "eventual reachable escalation, then quiet".
  async function expectReachableBoardEscalationThenQuiet(companyId: string, ownerUserId: string, agentId: string, issueId: string) {
    const actions = await openRecoveryActions(issueId);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.ownerType).toBe("board");
    const issue = await issueRow(issueId);
    expect(["blocked", "in_progress"]).toContain(issue.status);
    expect(issue.assigneeAgentId).toBe(agentId);
    // Delivery boundary: the escalation is an item in the responsible board
    // user's attention inbox, not merely a comment or a status label.
    const items = await boardAttentionRecoveryItems(companyId, ownerUserId, issueId);
    expect(items).toHaveLength(1);
    expect(items[0]!.subject.id).toBe(actions[0]!.id);

    // Repeated recovery ticks (same process; not a server restart): no new
    // run, wake or escalation; the spent budget and the hold are never reset
    // automatically.
    const runsBefore = (await runsFor(agentId)).length;
    const wakesBefore = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).length;
    const seenBefore = turns.seen.length;
    for (let cycle = 0; cycle < 3; cycle += 1) await recoveryCycle(agentId);
    expect(await runsFor(agentId)).toHaveLength(runsBefore);
    expect(turns.seen).toHaveLength(seenBefore);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).toHaveLength(wakesBefore);
    const after = await openRecoveryActions(issueId);
    expect(after.map((a) => a.id)).toEqual([actions[0]!.id]);
  }

  it("unknown-effect follow-up failure (case D): no automatic replay; one reachable board escalation, then quiet", async () => {
    const { companyId, agentId, issueId, ownerUserId } = await seed();
    await failedFollowup(agentId, issueId, "unknown_effect");
    for (let cycle = 0; cycle < 4; cycle += 1) await recoveryCycle(agentId);
    // The failed provider attempt may have acted: it is never replayed.
    expect(turns.seen).toHaveLength(2);
    expect((await runsFor(agentId)).filter((r) => r.retryOfRunId)).toHaveLength(0);
    await expectReachableBoardEscalationThenQuiet(companyId, ownerUserId, agentId, issueId);
  }, 120_000);

  it("refused follow-up launch -> bounded retries all refused -> one reachable board escalation, then quiet", async () => {
    const { companyId, agentId, issueId, ownerUserId } = await seed();
    await failedFollowup(agentId, issueId, "refused", { refusals: 100 });

    for (let cycle = 0; cycle < 8; cycle += 1) await recoveryCycle(agentId);

    // Bounded: only the parking turn ever reached the adapter; the refused
    // follow-up plus a bounded number of refused recovery launches.
    expect(turns.seen).toHaveLength(1);
    expect(turns.refused).toBeGreaterThanOrEqual(2);
    expect(turns.refused).toBeLessThanOrEqual(4);
    await expectReachableBoardEscalationThenQuiet(companyId, ownerUserId, agentId, issueId);
  }, 120_000);

  it("refused follow-up launch -> recovery launch -> scripted productive action closes the issue", async () => {
    const { agentId, issueId } = await seed();
    const followup = await failedFollowup(agentId, issueId, "refused", {
      refusals: 1,
      after: [async () => {
        await issueService(db).update(issueId, { status: "done" });
        return { summary: "Reconciled and closed." };
      }],
    });
    for (let cycle = 0; cycle < 3; cycle += 1) await recoveryCycle(agentId);

    expect((await issueRow(issueId)).status).toBe("done");
    expect(turns.refused).toBe(1);
    expect(turns.seen).toHaveLength(2);
    // The recovery launch carried the owner's action: persisted in the queued
    // run's wake context and rendered into the adapter input.
    const recoveryRun = (await runsFor(agentId)).find((r) => r.retryOfRunId === followup.id)!;
    expect(recoveryRun.status).toBe("succeeded");
    expect((recoveryRun.contextSnapshot as Record<string, unknown>).livenessContinuationState).toBe("unblock_requested");
    expect((turns.seen[1] as AdapterExecutionContext).runId).toBe(recoveryRun.id);
    const prompt = renderPaperclipWakePrompt((turns.seen[1] as AdapterExecutionContext).context.paperclipWake);
    expect(prompt).toContain(`Do this action now: ${ACTION}`);
    expect(await openRecoveryActions(issueId)).toHaveLength(0);
  }, 120_000);

  it("unavailable owner: after a refused follow-up the owner becomes unavailable; board escalation, no launch", async () => {
    const { companyId, agentId, issueId, ownerUserId } = await seed();
    await failedFollowup(agentId, issueId, "refused", {
      refusals: 100,
    });
    // Whatever recovery already launched was refused; the owner is now gone.
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, agentId));
    const refusedBefore = turns.refused;

    for (let cycle = 0; cycle < 3; cycle += 1) await recoveryCycle(agentId);

    expect(turns.seen).toHaveLength(1);
    expect(turns.refused).toBe(refusedBefore);
    await expectReachableBoardEscalationThenQuiet(companyId, ownerUserId, agentId, issueId);
  }, 120_000);

  // The supported HTTP surface (issue routes) with a fixed actor; the same
  // fake adapter executes whatever the routes wake.
  function api(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  it("real human prerequisite: recorded interaction holds recovery; the board's recorded answer resumes productive work once", async () => {
    const { companyId, agentId, issueId, ownerUserId } = await seed();
    const asAgent = (runId: string) => api({ type: "agent", source: "agent_key", companyId, agentId, runId });
    const asBoard = api({
      type: "board", source: "session", userId: ownerUserId, companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "owner" }], isInstanceAdmin: false,
    });
    let interactionId = "";
    let resumedCtx: AdapterExecutionContext | null = null;

    const followup = await failedFollowup(agentId, issueId, "refused", { refusals: 1, after: [
      // The recovery launch needs a human decision: it records one through the
      // supported interaction route and parks on it.
      async (ctx) => {
        const runId = (ctx as AdapterExecutionContext).runId;
        const created = await request(asAgent(runId)).post(`/api/issues/${issueId}/interactions`).send({
          kind: "request_confirmation",
          continuationPolicy: "wake_assignee",
          payload: { version: 1, prompt: "Approve the roadmap scope before I reconcile B1/B2?" },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        interactionId = created.body.id;
        const parked = await request(asAgent(runId)).patch(`/api/issues/${issueId}`).send({ status: "in_review" });
        expect(parked.status, JSON.stringify(parked.body)).toBe(200);
        return { summary: "Asked the board to approve the roadmap scope." };
      },
      // The resumed run performs the scripted productive action.
      async (ctx) => {
        resumedCtx = ctx as AdapterExecutionContext;
        const closed = await request(asAgent(resumedCtx.runId)).patch(`/api/issues/${issueId}`).send({ status: "done" });
        expect(closed.status, JSON.stringify(closed.body)).toBe(200);
        return { summary: "Reconciled and closed." };
      },
    ] });
    for (let cycle = 0; cycle < 3; cycle += 1) await recoveryCycle(agentId);

    // The recovery launch ran and recorded a real pending interaction.
    const recoveryRun = (await runsFor(agentId)).find((r) => r.retryOfRunId === followup.id)!;
    expect(recoveryRun.status).toBe("succeeded");
    expect(interactionId).not.toBe("");
    const [pending] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(pending).toMatchObject({ status: "pending", sourceRunId: recoveryRun.id, kind: "request_confirmation" });

    // Held: repeated ticks launch nothing and escalate nothing while it waits.
    const seenWhileHeld = turns.seen.length;
    const runsWhileHeld = (await runsFor(agentId)).length;
    for (let cycle = 0; cycle < 3; cycle += 1) await recoveryCycle(agentId);
    expect(turns.seen).toHaveLength(seenWhileHeld);
    expect(await runsFor(agentId)).toHaveLength(runsWhileHeld);
    expect(await openRecoveryActions(issueId)).toHaveLength(0);
    expect((await issueRow(issueId)).status).toBe("in_review");

    // The responsible board user answers through the supported accept route.
    const accepted = await request(asBoard).post(`/api/issues/${issueId}/interactions/${interactionId}/accept`).send({});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const [answered] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(answered).toMatchObject({ status: "accepted", resolvedByUserId: ownerUserId });
    expect(answered!.resolvedAt).toBeInstanceOf(Date);
    await settle(agentId);

    // Wake receipt: the fake runner received the continuation for this answer,
    // and its scripted productive work completed the issue.
    expect(turns.seen).toHaveLength(seenWhileHeld + 1);
    expect(resumedCtx).not.toBeNull();
    const resumed = resumedCtx as unknown as AdapterExecutionContext;
    expect(resumed.context.interactionId).toBe(interactionId);
    const resumedRun = (await runsFor(agentId)).find((r) => r.id === resumed.runId)!;
    expect(resumedRun.status).toBe("succeeded");
    expect((resumedRun.contextSnapshot as Record<string, unknown>).interactionId).toBe(interactionId);
    expect((await issueRow(issueId)).status).toBe("done");

    // Duplicate delivery of the same answer is refused, and further ticks
    // start no second execution or effect.
    const runsAfter = (await runsFor(agentId)).length;
    const wakesAfter = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).length;
    const again = await request(asBoard).post(`/api/issues/${issueId}/interactions/${interactionId}/accept`).send({});
    expect(again.status).toBeGreaterThanOrEqual(400);
    for (let cycle = 0; cycle < 3; cycle += 1) await recoveryCycle(agentId);
    expect(turns.seen).toHaveLength(seenWhileHeld + 1);
    expect(await runsFor(agentId)).toHaveLength(runsAfter);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).toHaveLength(wakesAfter);
    expect(await openRecoveryActions(issueId)).toHaveLength(0);
    expect((await issueRow(issueId)).status).toBe("done");
  }, 120_000);

  // ---------------------------------------------------------------------------
  // LIT-126 corrections. Same isolated harness; actual routes and recovery tick.

  function boardActor(companyId: string, ownerUserId: string) {
    return api({
      type: "board", source: "session", userId: ownerUserId, companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "owner" }], isInstanceAdmin: false,
    });
  }
  function agentActor(companyId: string, agentId: string) {
    return (runId: string) => api({ type: "agent", source: "agent_key", companyId, agentId, runId });
  }
  const ctxOf = (run: { contextSnapshot: unknown }) => run.contextSnapshot as Record<string, unknown>;
  // Direct, coalesced or deferred-behind-execution unblock wakes alike.
  const unblockWakes = async (agentId: string) => (await db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.agentId, agentId)))
    .filter((w) => w.reason === "issue_unblock_requested" ||
      ((w.payload as Record<string, any> | null)?._paperclipWakeContext?.wakeReason === "issue_unblock_requested"));
  // What an agent's run normally leaves besides its status write.
  async function runComment(issueId: string, agentId: string, runId: string, body: string) {
    const current = await issueRow(issueId);
    await db.insert(issueComments).values({ companyId: current.companyId, issueId, authorAgentId: agentId, authorType: "agent", createdByRunId: runId, body });
  }

  it("LIT-126 P1: alternating refused launch -> successful recovery -> self-park spends one shared episode, then one board escalation and quiet", async () => {
    const { companyId, agentId, issueId, ownerUserId } = await seed();
    // Each recovery turn does no work: it re-parks on its own action (a new
    // blocked transition, so a new notification) and its follow-up is refused.
    const repark = async (ctx: unknown) => {
      await issueService(db).update(issueId, { status: "in_progress" });
      await selfPark(issueId, agentId, (ctx as AdapterExecutionContext).runId);
      turns.refuseLaunches = 1;
      return { summary: "Parked on my own action again." };
    };
    const first = await failedFollowup(agentId, issueId, "refused", { refusals: 1, after: [repark, repark, repark, repark, repark] });
    for (let cycle = 0; cycle < 6; cycle += 1) await recoveryCycle(agentId);

    const runs = (await runsFor(agentId)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const initial = runs[0]!;
    // (The cap wake coalesces into the last recovery run, so filter by lineage.)
    const followups = runs.filter((r) => ctxOf(r).wakeReason === "issue_unblock_requested" && !r.retryOfRunId);
    const recoveries = runs.filter((r) => followups.some((f) => f.id === r.retryOfRunId));
    // One episode, owned by the initial run: follow-ups are its attempts 1 and 2.
    expect(followups.map((r) => ctxOf(r).livenessContinuationSourceRunId)).toEqual([initial.id, initial.id]);
    expect(followups.map((r) => r.continuationAttempt)).toEqual([1, 2]);
    expect(followups.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(first.id).toBe(followups[0]!.id);
    // Each immediate recovery keeps the refused follow-up's episode and spent
    // allowance, and still carries the bound action.
    expect(recoveries).toHaveLength(2);
    expect(recoveries.map((r) => ctxOf(r).livenessContinuationSourceRunId)).toEqual([initial.id, initial.id]);
    expect(recoveries.map((r) => r.continuationAttempt)).toEqual([1, 2]);
    expect(recoveries.every((r) => r.status === "succeeded" && ctxOf(r).livenessContinuationState === "unblock_requested")).toBe(true);
    // At the cap the last self-park's wake opened no further follow-up.
    expect(ctxOf(recoveries[1]!).selfUnblockFollowupCapReached).toBe(true);
    // Bounded: the initial turn plus two recovery turns; two refused launches.
    expect(turns.seen).toHaveLength(3);
    expect(turns.refused).toBe(2);
    await expectReachableBoardEscalationThenQuiet(companyId, ownerUserId, agentId, issueId);
  }, 120_000);

  it("LIT-126 P1: PATCH self-park while a pending interaction waits sends no act-now follow-up; the board's answer resumes once", async () => {
    const { companyId, agentId, issueId, ownerUserId } = await seed();
    const asAgent = agentActor(companyId, agentId);
    const asBoard = boardActor(companyId, ownerUserId);
    let interactionId = "";
    let resumedCtx: AdapterExecutionContext | null = null;
    turns.queue.push(async (ctx) => {
      const runId = (ctx as AdapterExecutionContext).runId;
      await runComment(issueId, agentId, runId, "Need the board's decision before the roadmap reconcile.");
      const created = await request(asAgent(runId)).post(`/api/issues/${issueId}/interactions`).send({
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        payload: { version: 1, prompt: "Approve the roadmap scope before I reconcile B1/B2?" },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      interactionId = created.body.id;
      const parked = await request(asAgent(runId)).patch(`/api/issues/${issueId}`)
        .send({ status: "blocked", unblockDescriptor: { owner: { agentId }, action: ACTION } });
      expect(parked.status, JSON.stringify(parked.body)).toBe(200);
      return { summary: "Waiting on the board's decision." };
    });
    turns.queue.push(async (ctx) => {
      resumedCtx = ctx as AdapterExecutionContext;
      const closed = await request(asAgent(resumedCtx.runId)).patch(`/api/issues/${issueId}`).send({ status: "done" });
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      return { summary: "Reconciled and closed." };
    });
    await start(agentId, issueId);
    await settle(agentId);

    // The route's notification honored the real wait: no wake, not marked notified.
    expect(await unblockWakes(agentId)).toHaveLength(0);
    const parked = await issueRow(issueId);
    expect(parked.status).toBe("blocked");
    expect(parked.blockedOwnerNotifiedAt).toBeNull();
    expect(turns.seen).toHaveLength(1);
    const runsWhileHeld = (await runsFor(agentId)).length;
    for (let cycle = 0; cycle < 3; cycle += 1) await recoveryCycle(agentId);
    expect(turns.seen).toHaveLength(1);
    expect(await runsFor(agentId)).toHaveLength(runsWhileHeld);
    expect(await openRecoveryActions(issueId)).toHaveLength(0);

    const accepted = await request(asBoard).post(`/api/issues/${issueId}/interactions/${interactionId}/accept`).send({});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    await settle(agentId);
    expect(turns.seen).toHaveLength(2);
    expect((resumedCtx as unknown as AdapterExecutionContext).context.interactionId).toBe(interactionId);
    expect((await issueRow(issueId)).status).toBe("done");
    const again = await request(asBoard).post(`/api/issues/${issueId}/interactions/${interactionId}/accept`).send({});
    expect(again.status).toBeGreaterThanOrEqual(400);
    const runsAfter = (await runsFor(agentId)).length;
    for (let cycle = 0; cycle < 3; cycle += 1) await recoveryCycle(agentId);
    expect(turns.seen).toHaveLength(2);
    expect(await runsFor(agentId)).toHaveLength(runsAfter);
  }, 120_000);

  it("LIT-126 P1 negative control: the same PATCH self-park with nothing waiting delivers the bound action once", async () => {
    const { companyId, agentId, issueId } = await seed();
    const asAgent = agentActor(companyId, agentId);
    let followCtx: AdapterExecutionContext | null = null;
    turns.queue.push(async (ctx) => {
      const runId = (ctx as AdapterExecutionContext).runId;
      await runComment(issueId, agentId, runId, "Blocked with an exact Vex-owned unblock action.");
      const parked = await request(asAgent(runId)).patch(`/api/issues/${issueId}`)
        .send({ status: "blocked", unblockDescriptor: { owner: { agentId }, action: ACTION } });
      expect(parked.status, JSON.stringify(parked.body)).toBe(200);
      return { summary: "Parked on my own action." };
    });
    turns.queue.push(async (ctx) => {
      followCtx = ctx as AdapterExecutionContext;
      await runComment(issueId, agentId, followCtx.runId, "Reconciled.");
      await request(asAgent(followCtx.runId)).patch(`/api/issues/${issueId}`).send({ status: "done" });
      return { summary: "Done." };
    });
    await start(agentId, issueId);
    await settle(agentId);
    expect(await unblockWakes(agentId)).toHaveLength(1);
    expect(turns.seen).toHaveLength(2);
    expect(ctxOf((await runsFor(agentId)).find((r) => r.id === (followCtx as unknown as AdapterExecutionContext).runId)!).wakeReason).toBe("issue_unblock_requested");
    expect(renderPaperclipWakePrompt((followCtx as unknown as AdapterExecutionContext).context.paperclipWake)).toContain(`Do this action now: ${ACTION}`);
    expect((await issueRow(issueId)).status).toBe("done");
  }, 120_000);

  it("LIT-126 P1: a wait recorded after the self-park notification cancels the queued follow-up at admission; the answer resumes once", async () => {
    const { companyId, agentId, issueId, ownerUserId } = await seed();
    const asAgent = agentActor(companyId, agentId);
    const asBoard = boardActor(companyId, ownerUserId);
    let interactionId = "";
    turns.queue.push(async (ctx) => {
      const runId = (ctx as AdapterExecutionContext).runId;
      await runComment(issueId, agentId, runId, "Parking, then asking the board first.");
      // Nothing waits yet: the notification queues a bound follow-up...
      const parked = await request(asAgent(runId)).patch(`/api/issues/${issueId}`)
        .send({ status: "blocked", unblockDescriptor: { owner: { agentId }, action: ACTION } });
      expect(parked.status, JSON.stringify(parked.body)).toBe(200);
      // ...then the same run records a real human prerequisite and parks on it.
      const created = await request(asAgent(runId)).post(`/api/issues/${issueId}/interactions`).send({
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        payload: { version: 1, prompt: "Approve the roadmap scope before I reconcile B1/B2?" },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      interactionId = created.body.id;
      const review = await request(asAgent(runId)).patch(`/api/issues/${issueId}`).send({ status: "in_review" });
      expect(review.status, JSON.stringify(review.body)).toBe(200);
      return { summary: "Asked the board first." };
    });
    turns.queue.push(async (ctx) => {
      expect((ctx as AdapterExecutionContext).context.interactionId).toBe(interactionId);
      await request(asAgent((ctx as AdapterExecutionContext).runId)).patch(`/api/issues/${issueId}`).send({ status: "done" });
      return { summary: "Reconciled and closed." };
    });
    await start(agentId, issueId);
    await settle(agentId);

    const followups = (await runsFor(agentId)).filter((r) => ctxOf(r).wakeReason === "issue_unblock_requested");
    expect(followups).toHaveLength(1);
    expect(followups[0]).toMatchObject({ status: "cancelled", errorCode: "self_unblock_superseded_by_wait" });
    // Refused before the adapter: only the parking turn ran.
    expect(turns.seen).toHaveLength(1);
    for (let cycle = 0; cycle < 3; cycle += 1) await recoveryCycle(agentId);
    expect(turns.seen).toHaveLength(1);
    expect(await openRecoveryActions(issueId)).toHaveLength(0);

    const accepted = await request(asBoard).post(`/api/issues/${issueId}/interactions/${interactionId}/accept`).send({});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    await settle(agentId);
    expect(turns.seen).toHaveLength(2);
    expect((await issueRow(issueId)).status).toBe("done");
    const runsAfter = (await runsFor(agentId)).length;
    for (let cycle = 0; cycle < 3; cycle += 1) await recoveryCycle(agentId);
    expect(turns.seen).toHaveLength(2);
    expect(await runsFor(agentId)).toHaveLength(runsAfter);
  }, 120_000);

  it("LIT-126 P2: an exhausted native self-park gets exactly one reachable board action, then quiet; the board's restore resumes productive work once", async () => {
    const { companyId, agentId, issueId, ownerUserId } = await seed();
    const asAgent = agentActor(companyId, agentId);
    const asBoard = boardActor(companyId, ownerUserId);
    await db.update(issues).set({ status: "blocked", unblockDescriptor: { owner: { agentId }, action: ACTION } })
      .where(eq(issues.id, issueId));
    // The native run's own continuation decision already reported exhaustion.
    const nativeRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nativeRunId, companyId, agentId, status: "succeeded", runtimeMode: "native",
      invocationSource: "automation", triggerDetail: "system", livenessState: "plan_only",
      livenessReason: "Issue is blocked only on this agent's own unblock action; continuation attempts exhausted",
      continuationAttempt: 1, startedAt: new Date(), finishedAt: new Date(),
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "run_liveness_continuation", livenessContinuationSourceRunId: nativeRunId },
    });

    // Negative controls: an unspent allowance, and a real dependency wait.
    await recoveryCycle(agentId);
    expect(await openRecoveryActions(issueId)).toHaveLength(0);
    await db.update(heartbeatRuns).set({ continuationAttempt: 2 }).where(eq(heartbeatRuns.id, nativeRunId));
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId, title: "Dependency", status: "todo", priority: "high", issueNumber: 2, identifier: `${(await issueRow(issueId)).identifier}-dep` });
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    await recoveryCycle(agentId);
    expect(await openRecoveryActions(issueId)).toHaveLength(0);
    await db.delete(issueRelations).where(eq(issueRelations.issueId, blockerId));

    // Exhausted, nothing waiting: one board action, reachable, then quiet.
    expect(turns.seen).toHaveLength(0);
    await recoveryCycle(agentId);
    await expectReachableBoardEscalationThenQuiet(companyId, ownerUserId, agentId, issueId);
    const [action] = await openRecoveryActions(issueId);
    expect(action!.evidence).toMatchObject({ terminalReason: "self_unblock_continuation_exhausted", latestRunId: nativeRunId });
    expect(turns.seen).toHaveLength(0);

    // The board restores the original owner through the supported route.
    let resumedCtx: AdapterExecutionContext | null = null;
    turns.queue.push(async (ctx) => {
      resumedCtx = ctx as AdapterExecutionContext;
      const closed = await request(asAgent(resumedCtx.runId)).patch(`/api/issues/${issueId}`).send({ status: "done" });
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      return { summary: "Did the action and closed." };
    });
    const restored = await request(asBoard).post(`/api/issues/${issueId}/recovery-actions/resolve`).send({
      actionId: action!.id, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "Retry the original owner.",
    });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    await settle(agentId);
    expect(turns.seen).toHaveLength(1);
    expect((resumedCtx as unknown as AdapterExecutionContext).context.wakeReason).toBe("issue_recovery_action_restored");
    expect((await issueRow(issueId)).status).toBe("done");
    expect(await openRecoveryActions(issueId)).toHaveLength(0);

    const again = await request(asBoard).post(`/api/issues/${issueId}/recovery-actions/resolve`).send({
      actionId: action!.id, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "Retry the original owner.",
    });
    // A duplicate response is an idempotent replay: no second wake or run.
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    await settle(agentId);
    const runsAfter = (await runsFor(agentId)).length;
    for (let cycle = 0; cycle < 3; cycle += 1) await recoveryCycle(agentId);
    expect(turns.seen).toHaveLength(1);
    expect(await runsFor(agentId)).toHaveLength(runsAfter);
    expect(await openRecoveryActions(issueId)).toHaveLength(0);
  }, 120_000);
});
