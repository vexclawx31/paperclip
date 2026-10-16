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
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// LIT-123: the inline (run finalization) and tick (recovery sweep) escalators
// of an exhausted native self-park can race each other and a board response.
// A deterministic gate holds an escalator after its admission checks and
// before its writes. Fake adapter and isolated embedded Postgres only.

const gate = vi.hoisted(() => ({
  runId: null as string | null,
  hold: 0,
  held: [] as Array<() => void>,
}));

vi.mock("../services/recovery/disposition-repair.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/recovery/disposition-repair.ts")>(
    "../services/recovery/disposition-repair.ts",
  );
  return {
    ...actual,
    // The native escalator collects source state last, after every admission
    // gate (status, self-owned action, exhausted episode, no active action,
    // pause hold) and immediately before escalating.
    collectDispositionRepairSourceState: async (
      ...args: Parameters<typeof actual.collectDispositionRepairSourceState>
    ) => {
      if (gate.runId && args[1].excludeRunId === gate.runId && gate.hold > 0) {
        gate.hold -= 1;
        await new Promise<void>((resolve) => gate.held.push(resolve));
      }
      return actual.collectDispositionRepairSourceState(...args);
    },
  };
});
vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: vi.fn(() => "test-private-reference") }),
}));
vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>("@paperclipai/shared/telemetry");
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});
const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Turn finished.", provider: "test", model: "test-model",
})));
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { recoveryService } from "../services/recovery/service.ts";
import { runningProcesses } from "../adapters/index.ts";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping LIT-123 native escalation race tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

const ACTION = "Reconcile the B1/B2 findings into the roadmap document";

describeEmbeddedPostgres("exhausted native self-park escalation races (offline integration)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lit123-escalation-race-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    for (const release of gate.held.splice(0)) release();
    gate.runId = null;
    gate.hold = 0;
    await heartbeatService(db).drainActiveRunExecutions();
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

  // A blocked native self-park whose bounded continuation is already spent.
  async function seedExhaustedSelfPark() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const nativeRunId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const prefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerUserId, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Vex", role: "engineer", status: "idle",
      adapterType: "hermes_gateway", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Roadmap", status: "blocked", priority: "high",
      assigneeAgentId: agentId, responsibleUserId: ownerUserId, issueNumber: 1, identifier: `${prefix}-1`,
      unblockDescriptor: { owner: { agentId }, action: ACTION },
    });
    await db.insert(heartbeatRuns).values({
      id: nativeRunId, companyId, agentId, status: "succeeded", runtimeMode: "native",
      invocationSource: "automation", triggerDetail: "system", livenessState: "plan_only",
      livenessReason: "Issue is blocked only on this agent's own unblock action; continuation attempts exhausted",
      continuationAttempt: 2, startedAt: new Date(), finishedAt: new Date(),
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "run_liveness_continuation", livenessContinuationSourceRunId: nativeRunId },
    });
    return { companyId, agentId, issueId, nativeRunId, ownerUserId };
  }

  // What heartbeat.ts calls when a native run's continuation is exhausted.
  function inlineEscalator() {
    return recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
  }
  // The server's own recovery tick.
  function tick() {
    return heartbeatService(db).reconcileStrandedAssignedIssues();
  }

  async function waitForHeld(count: number) {
    const deadline = Date.now() + 10_000;
    while (gate.held.length < count) {
      if (Date.now() > deadline) throw new Error(`only ${gate.held.length}/${count} escalators reached the gate`);
      await new Promise((r) => setTimeout(r, 10));
    }
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
  async function escalationNotices(issueId: string) {
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    return comments.filter((c) =>
      (c.metadata as Record<string, any> | null)?.recovery?.kind === "disposition_repair_escalated");
  }
  async function escalationActivities(issueId: string) {
    return db.select().from(activityLog).where(and(
      eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.disposition_repair_escalated"),
    ));
  }

  function boardApi(companyId: string, ownerUserId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board", source: "session", userId: ownerUserId, companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "owner" }], isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  it("concurrent inline and tick escalators open one board action and emit exactly one notice", async () => {
    const { issueId, agentId, companyId, nativeRunId } = await seedExhaustedSelfPark();
    gate.runId = nativeRunId;
    gate.hold = 2;

    // Both pass every admission check before either writes; then the inline
    // escalator completes before the tick's escalator resumes.
    const inline = inlineEscalator().escalateExhaustedNativeSelfPark({ id: issueId, companyId });
    await waitForHeld(1);
    const swept = tick();
    await waitForHeld(2);
    const [releaseInline, releaseTick] = gate.held.splice(0);
    releaseInline!();
    expect(await inline).toBe(true);
    releaseTick!();
    await swept;

    const actions = await openRecoveryActions(issueId);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ ownerType: "board", ownerAgentId: null, returnOwnerAgentId: agentId });
    expect(actions[0]!.wakePolicy).toMatchObject({ type: "board_escalation" });
    expect(await escalationNotices(issueId)).toHaveLength(1);
    expect(await escalationActivities(issueId)).toHaveLength(1);
    const issue = await issueRow(issueId);
    expect(issue.status).toBe("blocked");
    expect(issue.assigneeAgentId).toBe(agentId);

    // Then quiet: further escalators add nothing.
    expect(await inlineEscalator().escalateExhaustedNativeSelfPark({ id: issueId, companyId })).toBe(false);
    await tick();
    expect((await openRecoveryActions(issueId)).map((a) => a.id)).toEqual([actions[0]!.id]);
    expect(await escalationNotices(issueId)).toHaveLength(1);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  }, 60_000);

  it("a stale escalator released after the board's false_positive/done response leaves the issue done and the action resolved", async () => {
    const { issueId, companyId, nativeRunId, ownerUserId } = await seedExhaustedSelfPark();
    gate.runId = nativeRunId;
    gate.hold = 1;

    // The inline escalator passes admission, then pauses before escalating.
    const stale = inlineEscalator().escalateExhaustedNativeSelfPark({ id: issueId, companyId });
    await waitForHeld(1);

    // Meanwhile the tick escalates, and the board answers through the
    // supported route: a false positive, source completed.
    await tick();
    const [action] = await openRecoveryActions(issueId);
    expect(action).toMatchObject({ ownerType: "board" });
    expect(await escalationNotices(issueId)).toHaveLength(1);
    const resolved = await request(boardApi(companyId, ownerUserId)).post(`/api/issues/${issueId}/recovery-actions/resolve`).send({
      actionId: action!.id, outcome: "false_positive", sourceIssueStatus: "done", resolutionNote: "Already reconciled by hand.",
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect((await issueRow(issueId)).status).toBe("done");

    // Release the stale escalation.
    for (const release of gate.held.splice(0)) release();
    expect(await stale).toBe(false);

    const issue = await issueRow(issueId);
    expect(issue.status).toBe("done");
    const [settled] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    expect(settled).toMatchObject({ status: "resolved", outcome: "false_positive" });
    expect(await openRecoveryActions(issueId)).toHaveLength(0);
    expect(await escalationNotices(issueId)).toHaveLength(1);
    expect(await escalationActivities(issueId)).toHaveLength(1);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  }, 60_000);

  it("stays quiet after the board resolves the episode's escalation and keeps the issue blocked", async () => {
    const { issueId, companyId, ownerUserId } = await seedExhaustedSelfPark();

    await tick();
    const [action] = await openRecoveryActions(issueId);
    expect(action).toMatchObject({ ownerType: "board" });
    const resolved = await request(boardApi(companyId, ownerUserId)).post(`/api/issues/${issueId}/recovery-actions/resolve`).send({
      actionId: action!.id, outcome: "blocked", sourceIssueStatus: "blocked", resolutionNote: "Keep it parked for now.",
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect((await issueRow(issueId)).status).toBe("blocked");

    // The same exhausted episode must not be escalated again on later ticks.
    await tick();
    await tick();
    expect(await inlineEscalator().escalateExhaustedNativeSelfPark({ id: issueId, companyId })).toBe(false);
    expect(await openRecoveryActions(issueId)).toHaveLength(0);
    expect(await escalationNotices(issueId)).toHaveLength(1);
    expect(await escalationActivities(issueId)).toHaveLength(1);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  }, 60_000);
});
