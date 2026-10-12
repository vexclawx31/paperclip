import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  authUsers,
  budgetPolicies,
  companies,
  companySkills,
  costEvents,
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
import { issueService } from "../services/issues.ts";
import { DISPOSITION_ONLY_RECOVERY_QUIET_REASON } from "../services/heartbeat-run-summary.ts";

// Real heartbeat execution and finalization with a synthetic adapter. Status
// writes mirror the normal issue API: the issue row is committed (the trigger
// bumps status_version) and `issue.updated` is logged with the actor's run.
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
const ADAPTER = "disposition_quiet_test";
const OLD_ANSWER = "The synthetic report is ready: revenue grew twelve percent.";

type Behavior = (ctx: AdapterExecutionContext, db: Db) => Promise<void>;
type Fixture = { companyId: string; agentId: string; issueId: string };

describeEmbeddedPostgres("disposition-only recovery presentation through real heartbeat finalization", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  const previousHome = process.env.PAPERCLIP_HOME;
  let behavior: Behavior = async () => {};
  const adapterErrors: unknown[] = [];

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "disposition-quiet-")));
    process.env.PAPERCLIP_HOME = home;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-disposition-quiet-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: ADAPTER,
      execute: async (ctx) => {
        try { await behavior(ctx, db); } catch (error) { adapterErrors.push(error); }
        // The repair's closing prose repeats the earlier answer.
        return { exitCode: 0, signal: null, timedOut: false, resultJson: { summary: OLD_ANSWER }, summary: OLD_ANSWER };
      },
      testEnvironment: async () => ({ adapterType: ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterEach(async () => {
    behavior = async () => {};
    adapterErrors.length = 0;
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.status, "running"));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (const table of [costEvents, activityLog, environmentLeases, issueComments, issueRelations, issues, executionWorkspaces, heartbeatRunEvents, activityLog, heartbeatRuns, agentWakeupRequests, agentRuntimeState, budgetPolicies, agents, environments, companySkills, companies, authUsers]) {
      await db.delete(table);
    }
  });

  afterAll(async () => {
    unregisterServerAdapter(ADAPTER);
    await tempDb?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  async function seed(): Promise<Fixture> {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    // Agent comments resolve an on-behalf-of user from the company default (FK).
    const userId = `user-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Responsible", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Disposition quiet", issuePrefix: `D${randomUUID().slice(0, 5).toUpperCase()}`, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic agent", role: "engineer", status: "idle", adapterType: ADAPTER, adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic task", status: "in_progress", workMode: "standard", assigneeAgentId: agentId });
    return { companyId, agentId, issueId };
  }
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
    await heartbeat.drainActiveRunExecutions();
    return heartbeat.getRun(run!.id);
  }
  /** Context recovery builds for a legacy disposition repair, including the scheduled-time status_version. */
  async function repairContext(fixture: Fixture, options: { baseline?: boolean } = {}) {
    const sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: fixture.companyId, agentId: fixture.agentId, status: "succeeded", invocationSource: "assignment", contextSnapshot: { issueId: fixture.issueId }, finishedAt: new Date() });
    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    return {
      issueId: fixture.issueId, taskId: fixture.issueId, wakeReason: "issue_assigned",
      source: "issue.deliberate_wait_disposition_repair",
      legacyDispositionEpisode: { id: sourceRunId, attempt: 1, maxAttempts: 2 },
      dispositionRepairSourceRunId: sourceRunId,
      ...(options.baseline === false ? {} : { dispositionRepairIssueStatusVersion: issue!.statusVersion }),
    };
  }
  /** What a successful PATCH /api/issues/:id commits and logs for an actor. */
  async function apiStatusWrite(fixture: Fixture, patch: Partial<typeof issues.$inferInsert>, actor: { agentId?: string; runId?: string } | "board") {
    await db.update(issues).set(patch).where(eq(issues.id, fixture.issueId));
    const agentActor = actor !== "board";
    await persistActivity(db, {
      companyId: fixture.companyId,
      actorType: agentActor ? "agent" : "user",
      actorId: agentActor ? actor.agentId! : "user-board",
      agentId: agentActor ? actor.agentId! : null,
      runId: agentActor ? actor.runId! : null,
      action: "issue.updated", entityType: "issue", entityId: fixture.issueId,
      details: { ...patch },
    });
  }
  const commentsWithBody = (issueId: string, body: string) =>
    db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.body, body)));
  const decisionOf = (run: typeof heartbeatRuns.$inferSelect | null | undefined) =>
    run?.resultJson?.presentationDecision as { commentAction?: string; reasonCodes?: string[] } | undefined;

  it("stays quiet when the repair's own API write is the single status change", async () => {
    const fixture = await seed();
    behavior = once(async (ctx) => { await apiStatusWrite(fixture, { status: "done" }, { agentId: ctx.agent.id, runId: ctx.runId }); });
    const finished = await runToCompletion(fixture.agentId, await repairContext(fixture));
    expect(adapterErrors).toEqual([]);
    expect(await commentsWithBody(fixture.issueId, OLD_ANSWER)).toHaveLength(0);
    expect(decisionOf(finished)?.reasonCodes).toContain(DISPOSITION_ONLY_RECOVERY_QUIET_REASON);
  });

  it("shows an explicit new blocker the repair wrote, without repeating the old answer", async () => {
    const fixture = await seed();
    const blocker = "Blocked: the synthetic vendor now requires a signed DPA. Owner: this agent.";
    behavior = once(async (ctx, database) => {
      await issueService(database).addComment(fixture.issueId, blocker, { agentId: ctx.agent.id, runId: ctx.runId });
      await apiStatusWrite(fixture, { status: "blocked", unblockDescriptor: { owner: { agentId: ctx.agent.id }, action: "Obtain the signed synthetic DPA" } }, { agentId: ctx.agent.id, runId: ctx.runId });
    });
    const finished = await runToCompletion(fixture.agentId, await repairContext(fixture));
    expect(adapterErrors).toEqual([]);
    expect(await commentsWithBody(fixture.issueId, blocker)).toHaveLength(1);
    expect(await commentsWithBody(fixture.issueId, OLD_ANSWER)).toHaveLength(0);
    expect(decisionOf(finished)?.commentAction).toBe("reuse");
  });

  it("shows the repair's prose after A -> B -> A by another actor", async () => {
    const fixture = await seed();
    behavior = once(async (ctx) => {
      await apiStatusWrite(fixture, { status: "done" }, { agentId: ctx.agent.id, runId: ctx.runId });
      await apiStatusWrite(fixture, { status: "in_progress" }, "board");
      await apiStatusWrite(fixture, { status: "done" }, "board");
    });
    const finished = await runToCompletion(fixture.agentId, await repairContext(fixture));
    expect(adapterErrors).toEqual([]);
    expect(await commentsWithBody(fixture.issueId, OLD_ANSWER)).toHaveLength(1);
    expect(decisionOf(finished)?.reasonCodes ?? []).not.toContain(DISPOSITION_ONLY_RECOVERY_QUIET_REASON);
  });

  it("shows the repair's prose when only someone else recorded the disposition", async () => {
    const fixture = await seed();
    behavior = once(async () => { await apiStatusWrite(fixture, { status: "done" }, "board"); });
    await runToCompletion(fixture.agentId, await repairContext(fixture));
    expect(adapterErrors).toEqual([]);
    expect(await commentsWithBody(fixture.issueId, OLD_ANSWER)).toHaveLength(1);
  });

  it("shows the repair's prose for a repair context without a scheduled baseline", async () => {
    const fixture = await seed();
    behavior = once(async (ctx) => { await apiStatusWrite(fixture, { status: "done" }, { agentId: ctx.agent.id, runId: ctx.runId }); });
    await runToCompletion(fixture.agentId, await repairContext(fixture, { baseline: false }));
    expect(adapterErrors).toEqual([]);
    expect(await commentsWithBody(fixture.issueId, OLD_ANSWER)).toHaveLength(1);
  });

  it("presents an ordinary run's reply alongside its lifecycle write", async () => {
    const fixture = await seed();
    behavior = once(async (ctx) => { await apiStatusWrite(fixture, { status: "done" }, { agentId: ctx.agent.id, runId: ctx.runId }); });
    const finished = await runToCompletion(fixture.agentId, { issueId: fixture.issueId, taskId: fixture.issueId, wakeReason: "issue_assigned" });
    expect(adapterErrors).toEqual([]);
    expect(finished?.status).toBe("succeeded");
    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(issue!.status).toBe("done");
    expect(await commentsWithBody(fixture.issueId, OLD_ANSWER)).toHaveLength(1);
    expect(decisionOf(finished)?.commentAction).toBe("create");
  });
});
