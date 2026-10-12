import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  authUsers,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { persistActivity } from "../services/activity-log.ts";
import {
  callTaskTool,
  enableTaskToolsForRun,
  TASK_TOOL_CAPABILITY_CONTEXT_KEY,
  TASK_TOOL_RECEIPT_DETAIL_KEY,
  TASK_TOOL_STATUS_RECEIPT_ACTIONS,
  taskToolCapabilityMarker,
} from "../services/task-tools.ts";
import { DISPOSITION_ONLY_RECOVERY_QUIET_REASON } from "../services/heartbeat-run-summary.ts";

// Real heartbeat execution and finalization, with a synthetic adapter that
// calls the real task-tool service for its own run. No real credential is used.
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
const ADAPTER = "task_tools_heartbeat_test";
const OLD_ANSWER = "The synthetic report is ready: revenue grew twelve percent.";
const API_URL = "http://paperclip.test/api";

type Behavior = (ctx: AdapterExecutionContext, db: Db) => Promise<void>;

describeEmbeddedPostgres("task tools through real heartbeat finalization", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  const previousHome = process.env.PAPERCLIP_HOME;
  let behavior: Behavior = async () => {};
  const adapterErrors: unknown[] = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "task-tools-heartbeat-")));
    process.env.PAPERCLIP_HOME = home;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-tools-heartbeat-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: ADAPTER,
      execute: async (ctx) => {
        try { await behavior(ctx, db); } catch (error) { adapterErrors.push(error); }
        // An ordinary legacy result: it carries no receipts and no capability.
        return { exitCode: 0, signal: null, timedOut: false, resultJson: { summary: OLD_ANSWER }, summary: OLD_ANSWER };
      },
      testEnvironment: async () => ({ adapterType: ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterEach(async () => {
    behavior = async () => {};
    adapterErrors.length = 0;
    vi.unstubAllGlobals();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.status, "running"));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // Same dependency order as the existing heartbeat harnesses.
    for (const table of [activityLog, environmentLeases, issueComments, issueRelations, issues, executionWorkspaces, heartbeatRunEvents, activityLog, heartbeatRuns, agentWakeupRequests, agentRuntimeState, budgetPolicies, agents, environments, companySkills, companies, authUsers]) {
      await db.delete(table);
    }
  });

  afterAll(async () => {
    unregisterServerAdapter(ADAPTER);
    await tempDb?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    // Agent comments resolve an on-behalf-of user from the company default; it
    // must be a real user row (issue_comments.on_behalf_of_user_id FK).
    const userId = `user-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Responsible", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Task tools heartbeat", issuePrefix: `T${randomUUID().slice(0, 5).toUpperCase()}`, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Claudy", role: "engineer", status: "idle", adapterType: ADAPTER, adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic task", status: "in_progress", workMode: "standard", assigneeAgentId: agentId });
    return { companyId, agentId, issueId };
  }
  // Behaviors act once: follow-up continuation runs must not repeat them.
  function once(fn: Behavior): Behavior {
    let used = false;
    return async (ctx, database) => { if (used) return; used = true; await fn(ctx, database); };
  }
  async function runToCompletion(agentId: string, context: Record<string, unknown>) {
    const run = await heartbeat.invoke(agentId, "assignment", context, "system");
    expect(run).not.toBeNull();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = await heartbeat.getRun(run!.id);
      if (current && !["queued", "running"].includes(current.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Presentation and comment materialization finish after the terminal write.
    await heartbeat.drainActiveRunExecutions();
    return heartbeat.getRun(run!.id);
  }
  const bindingFor = (ctx: AdapterExecutionContext) => ({
    companyId: ctx.agent.companyId, agentId: ctx.agent.id, runId: ctx.runId, issueId: String(ctx.context.issueId),
  });
  /**
   * Stand-in for PATCH /api/issues/:id: commit the status change (the trigger
   * bumps statusVersion) and return the committed row, as the route does.
   */
  function stubIssueRoute() {
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const match = /\/api\/issues\/([0-9a-f-]{36})$/.exec(String(url));
      if (!match || init?.method !== "PATCH") return realFetch(url, init);
      const body = JSON.parse(String(init.body)) as { status: string };
      const [updated] = await db.update(issues).set({ status: body.status } as Partial<typeof issues.$inferInsert>).where(eq(issues.id, match[1]!)).returning();
      return new Response(JSON.stringify(updated), { status: 200, headers: { "content-type": "application/json" } });
    });
  }
  async function statusViaTaskTool(ctx: AdapterExecutionContext, database: Db, status: string, key: string) {
    const binding = bindingFor(ctx);
    expect(await enableTaskToolsForRun(database, binding)).toBe(true);
    return callTaskTool(database, { binding, name: "update_task_status", arguments: { status, idempotencyKey: key }, apiUrl: API_URL, token: "synthetic" });
  }

  it("keeps comment receipts and the capability through ordinary legacy success finalization", async () => {
    const fixture = await seed();
    let firstResult: Record<string, unknown> | null = null;
    let stamped = false;
    behavior = once(async (ctx, database) => {
      const binding = bindingFor(ctx);
      stamped = await enableTaskToolsForRun(database, binding);
      firstResult = await callTaskTool(database, { binding, name: "add_task_comment", arguments: { body: "Synthetic progress.", idempotencyKey: "heartbeat-receipt-1" }, apiUrl: API_URL, token: "synthetic" });
    });
    const finished = await runToCompletion(fixture.agentId, { issueId: fixture.issueId, taskId: fixture.issueId, wakeReason: "issue_assigned" });
    expect(adapterErrors).toEqual([]);
    expect(stamped).toBe(true);
    expect(finished?.status).toBe("succeeded");
    expect(firstResult).toMatchObject({ disposition: "applied" });
    // Finalization replaced resultJson with adapter output; the capability survives.
    expect(finished?.contextSnapshot?.[TASK_TOOL_CAPABILITY_CONTEXT_KEY]).toEqual(taskToolCapabilityMarker({ agentId: fixture.agentId, issueId: fixture.issueId }));
    const receipts = await db.select().from(activityLog).where(and(eq(activityLog.entityId, fixture.issueId), eq(activityLog.runId, finished!.id), eq(activityLog.action, "issue.comment_added")));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.details?.[TASK_TOOL_RECEIPT_DETAIL_KEY]).toMatchObject({ state: "completed" });

    // After everything settles, a later stamped run of the same agent on the
    // same task (e.g. a retry/recovery) replays the key instead of reposting.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const laterRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: laterRunId, companyId: fixture.companyId, agentId: fixture.agentId, status: "running", invocationSource: "assignment", contextSnapshot: { issueId: fixture.issueId } });
    await db.update(issues).set({ status: "in_progress", assigneeAgentId: fixture.agentId, executionRunId: laterRunId }).where(eq(issues.id, fixture.issueId));
    const later = { companyId: fixture.companyId, agentId: fixture.agentId, runId: laterRunId, issueId: fixture.issueId };
    expect(await enableTaskToolsForRun(db, later)).toBe(true);
    const replay = await callTaskTool(db, { binding: later, name: "add_task_comment", arguments: { body: "Synthetic progress.", idempotencyKey: "heartbeat-receipt-1" }, apiUrl: API_URL, token: "synthetic" });
    expect(replay).toMatchObject({ commentId: (firstResult as Record<string, unknown> | null)?.commentId, replayed: true });
    const toolComments = await db.select().from(issueComments).where(and(eq(issueComments.issueId, fixture.issueId), eq(issueComments.body, "Synthetic progress.")));
    expect(toolComments).toHaveLength(1);
  });

  describe("disposition-only recovery presentation at finalization", () => {
    async function repairContext(fixture: { companyId: string; agentId: string; issueId: string }) {
      const sourceRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: fixture.companyId, agentId: fixture.agentId, status: "succeeded", invocationSource: "assignment", contextSnapshot: { issueId: fixture.issueId }, finishedAt: new Date() });
      return {
        issueId: fixture.issueId, taskId: fixture.issueId, wakeReason: "issue_assigned",
        source: "issue.deliberate_wait_disposition_repair",
        legacyDispositionEpisode: { id: sourceRunId, attempt: 1, maxAttempts: 2 },
        dispositionRepairSourceRunId: sourceRunId,
      };
    }
    const repeatedAnswerComments = (issueId: string) =>
      db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.body, OLD_ANSWER)));
    const decisionOf = (run: typeof heartbeatRuns.$inferSelect | null | undefined) =>
      run?.resultJson?.presentationDecision as { commentAction?: string; reasonCodes?: string[] } | undefined;
    // A status change committed by another actor, with its route-style activity.
    async function otherActorStatus(fixture: { companyId: string; issueId: string }, status: string) {
      await db.update(issues).set({ status } as Partial<typeof issues.$inferInsert>).where(eq(issues.id, fixture.issueId));
      await persistActivity(db, { companyId: fixture.companyId, actorType: "user", actorId: "user-board", agentId: null, runId: null, action: "issue.updated", entityType: "issue", entityId: fixture.issueId, details: { status } });
    }

    it("stays quiet when the repair recorded the current status through its task tool", async () => {
      const fixture = await seed();
      stubIssueRoute();
      let result: Record<string, unknown> | null = null;
      behavior = once(async (ctx, database) => { result = await statusViaTaskTool(ctx, database, "done", "repair-done-1"); });
      const finished = await runToCompletion(fixture.agentId, await repairContext(fixture));
      expect(adapterErrors).toEqual([]);
      const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
      expect(result).toMatchObject({ status: "done", statusVersion: issue!.statusVersion });
      const completed = await db.select().from(activityLog).where(and(eq(activityLog.runId, finished!.id), eq(activityLog.action, TASK_TOOL_STATUS_RECEIPT_ACTIONS.completed)));
      expect(completed).toHaveLength(1);
      expect(await repeatedAnswerComments(fixture.issueId)).toHaveLength(0);
      expect(decisionOf(finished)?.reasonCodes).toContain(DISPOSITION_ONLY_RECOVERY_QUIET_REASON);
    });

    it("shows the repair's prose after A -> B -> A by another actor", async () => {
      const fixture = await seed();
      stubIssueRoute();
      behavior = once(async (ctx, database) => {
        await statusViaTaskTool(ctx, database, "done", "repair-done-2");
        await otherActorStatus(fixture, "in_progress");
        await otherActorStatus(fixture, "done");
      });
      const finished = await runToCompletion(fixture.agentId, await repairContext(fixture));
      expect(adapterErrors).toEqual([]);
      expect(await repeatedAnswerComments(fixture.issueId)).toHaveLength(1);
      expect(decisionOf(finished)?.reasonCodes ?? []).not.toContain(DISPOSITION_ONLY_RECOVERY_QUIET_REASON);
    });

    it("shows the repair's prose when it has no task-tool receipt", async () => {
      const fixture = await seed();
      // Another lane (direct write with a run-attributed activity), not a receipt.
      behavior = once(async (ctx) => {
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, fixture.issueId));
        await persistActivity(db, { companyId: fixture.companyId, actorType: "agent", actorId: ctx.agent.id, agentId: ctx.agent.id, runId: ctx.runId, action: "issue.updated", entityType: "issue", entityId: fixture.issueId, details: { status: "done" } });
      });
      await runToCompletion(fixture.agentId, await repairContext(fixture));
      expect(adapterErrors).toEqual([]);
      expect(await repeatedAnswerComments(fixture.issueId)).toHaveLength(1);
    });

    it("shows the repair's prose when only someone else recorded the disposition", async () => {
      const fixture = await seed();
      behavior = once(async () => { await otherActorStatus(fixture, "done"); });
      await runToCompletion(fixture.agentId, await repairContext(fixture));
      expect(adapterErrors).toEqual([]);
      expect(await repeatedAnswerComments(fixture.issueId)).toHaveLength(1);
    });

    it("presents an ordinary run's final response even with a matching task-tool receipt", async () => {
      const fixture = await seed();
      stubIssueRoute();
      behavior = once(async (ctx, database) => { await statusViaTaskTool(ctx, database, "done", "ordinary-done-1"); });
      const finished = await runToCompletion(fixture.agentId, { issueId: fixture.issueId, taskId: fixture.issueId, wakeReason: "issue_assigned" });
      expect(adapterErrors).toEqual([]);
      expect(await repeatedAnswerComments(fixture.issueId)).toHaveLength(1);
      expect(decisionOf(finished)?.commentAction).toBe("create");
    });
  });
});
