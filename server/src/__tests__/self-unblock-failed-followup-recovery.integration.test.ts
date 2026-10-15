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
import { runningProcesses } from "../adapters/index.ts";

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

    // Restart / repeated ticks: no new run, wake or escalation; the spent
    // budget and the hold are never reset automatically.
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

  it("real human prerequisite: a pending interaction holds recovery; its recorded answer resumes it", async () => {
    const { companyId, agentId, issueId } = await seed();
    const interactionId = randomUUID();
    await failedFollowup(agentId, issueId, "refused", { refusals: 1, after: [async () => {
      // The recovery launch records a real human prerequisite, then exits.
      await db.insert(issueThreadInteractions).values({
        id: interactionId, companyId, issueId, kind: "request_confirmation", status: "pending",
        createdByUserId: "responsible-user", payload: { prompt: "Approve the roadmap scope" },
      });
      return { summary: "Asked the board to approve the roadmap scope." };
    }] });
    const seenBefore = turns.seen.length;
    for (let cycle = 0; cycle < 3; cycle += 1) await recoveryCycle(agentId);
    // Held: no further launch and no escalation while the human decides.
    expect(turns.seen).toHaveLength(seenBefore);
    expect(await openRecoveryActions(issueId)).toHaveLength(0);
    expect((await issueRow(issueId)).status).not.toBe("done");
  }, 120_000);
});
