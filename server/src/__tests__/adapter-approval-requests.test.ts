import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdapterApprovalRequest } from "@paperclipai/adapter-utils";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createHash } from "node:crypto";
import { createAdapterApprovalRequestHandler } from "../services/adapter-approval-requests.js";
import { logActivity } from "../services/activity-log.js";
import { approvalService } from "../services/approvals.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres adapter approval tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("adapter approval request handler", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("adapter-approval-requests");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const supervisorId = randomUUID();
    const heartbeatRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Approvals",
      issuePrefix: `A${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    for (const [id, name] of [[agentId, "Nox"], [supervisorId, "Vex"]] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        adapterType: "hermes_gateway",
        adapterConfig: {},
        permissions: {},
        status: "idle",
      });
    }
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Restart a thing",
      identifier: `APR-${issueId.slice(0, 8)}`,
      status: "in_progress",
    });
    return { companyId, agentId, supervisorId, heartbeatRunId, issueId };
  }
  const sha = (command: string) => createHash("sha256").update(command, "utf8").digest("hex");

  function request(overrides: Partial<AdapterApprovalRequest> = {}): AdapterApprovalRequest {
    const command = overrides.command ?? "launchctl kickstart -k gui/501/ai.paperclip";
    return {
      requestId: "req-1",
      providerRunId: "run-hermes-1",
      tier: "red",
      route: "board",
      supervisorAgentId: null,
      categories: [],
      command,
      commandSha256: sha(command),
      commandComplete: true,
      description: "stop/restart hermes launchd service",
      reasons: ["service_control"],
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  function safeRequest(seeded: { supervisorId: string }, overrides: Partial<AdapterApprovalRequest> = {}) {
    return request({
      tier: "yellow",
      route: "supervisor",
      supervisorAgentId: seeded.supervisorId,
      categories: ["test_build_lint"],
      command: "pnpm test",
      reasons: ["safe:test_build_lint"],
      ...overrides,
    });
  }

  function handlerFor(seeded: Awaited<ReturnType<typeof seed>>, overrides: { issueId?: string | null; fallbackPollMs?: number } = {}) {
    return createAdapterApprovalRequestHandler({
      db,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      agentName: "Nox",
      heartbeatRunId: seeded.heartbeatRunId,
      adapterType: "hermes_gateway",
      issueId: overrides.issueId === undefined ? seeded.issueId : overrides.issueId,
      fallbackPollMs: overrides.fallbackPollMs ?? 20,
    });
  }

  async function waitForPendingApproval(companyId: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows = await db.select().from(approvals).where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")));
      if (rows[0]) return rows[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("approval was not created");
  }

  const onlyApproval = async (companyId: string) => {
    const rows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };

  const actionsFor = async (companyId: string) =>
    (await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).map((row) => row.action);

  it("creates a linked board approval with the command hash and returns the echoed decision", async () => {
    const seeded = await seed();
    const pending = handlerFor(seeded)(request());
    const approval = await waitForPendingApproval(seeded.companyId);
    expect(approval.type).toBe("request_board_approval");
    expect(approval.requestedByAgentId).toBeNull();
    expect(approval.payload).toMatchObject({
      source: "adapter_approval_request",
      requestId: "req-1",
      heartbeatRunId: seeded.heartbeatRunId,
      tier: "red",
      commandSha256: sha("launchctl kickstart -k gui/501/ai.paperclip"),
      commandComplete: true,
    });
    await vi.waitFor(async () => {
      const links = await db.select().from(issueApprovals).where(eq(issueApprovals.approvalId, approval.id));
      expect(links.map((link) => link.issueId)).toEqual([seeded.issueId]);
    });

    await approvalService(db).approve(approval.id, "board-user", "go ahead");
    const decision = await pending;

    expect(decision).toMatchObject({
      decision: "approved",
      decidedBy: "board",
      approvalId: approval.id,
      note: "go ahead",
      requestId: "req-1",
      commandSha256: sha("launchctl kickstart -k gui/501/ai.paperclip"),
    });
    expect(await actionsFor(seeded.companyId)).toEqual(expect.arrayContaining(["approval.created", "adapter_approval.board_resolved"]));
  });

  it("wakes on the approval activity event instead of waiting for the fallback poll", async () => {
    const seeded = await seed();
    const started = Date.now();
    const pending = handlerFor(seeded, { fallbackPollMs: 30_000 })(request());
    const approval = await waitForPendingApproval(seeded.companyId);
    await approvalService(db).reject(approval.id, "board-user", "no");
    await logActivity(db, {
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      action: "approval.rejected",
      entityType: "approval",
      entityId: approval.id,
    });
    await expect(pending).resolves.toMatchObject({ decision: "denied", decidedBy: "board" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("denies and closes the record when the board requests a revision", async () => {
    const seeded = await seed();
    const pending = handlerFor(seeded)(request());
    const approval = await waitForPendingApproval(seeded.companyId);
    await approvalService(db).requestRevision(approval.id, "board-user", "change it");
    await expect(pending).resolves.toMatchObject({ decision: "denied", decidedBy: "board" });
    expect((await onlyApproval(seeded.companyId)).status).toBe("cancelled");
  });

  it("cancels the approval and fails closed on timeout", async () => {
    const seeded = await seed();
    const decision = await handlerFor(seeded)(request({ timeoutMs: 30 }));
    expect(decision.decision).toBe("timeout");
    expect((await onlyApproval(seeded.companyId)).status).toBe("cancelled");
    expect(await actionsFor(seeded.companyId)).toContain("adapter_approval.timed_out");
  });

  it("cancels the approval when the run ends before a decision", async () => {
    const seeded = await seed();
    const controller = new AbortController();
    const pending = handlerFor(seeded, { fallbackPollMs: 30_000 })(request({ signal: controller.signal }));
    await waitForPendingApproval(seeded.companyId);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ decision: "cancelled", decidedBy: "system" });
    expect((await onlyApproval(seeded.companyId)).status).toBe("cancelled");
  });

  it("cancels the approval when waiting fails with an error", async () => {
    const seeded = await seed();
    // A missing issue makes linking throw after the approval was created.
    await expect(handlerFor(seeded, { issueId: randomUUID() })(request())).rejects.toThrow();
    expect((await onlyApproval(seeded.companyId)).status).toBe("cancelled");
  });

  it("marks redacted or truncated commands for the board and never delegates them", async () => {
    const seeded = await seed();
    const decision = await handlerFor(seeded)(safeRequest(seeded, { commandComplete: false, timeoutMs: 30 }));
    expect(decision.decision).toBe("timeout");
    const approval = await onlyApproval(seeded.companyId);
    expect(JSON.stringify(approval.payload)).toContain("contains redacted/truncated content; full command not shown");
  });

  it("approves known-safe requests under the delegated supervisor policy and names the category", async () => {
    const seeded = await seed();
    const decision = await handlerFor(seeded)(safeRequest(seeded));
    expect(decision).toMatchObject({
      decision: "approved",
      decidedBy: "supervisor_policy",
      supervisorAgentId: seeded.supervisorId,
      requestId: "req-1",
      commandSha256: sha("pnpm test"),
    });
    expect(decision.note).toContain("safe category: test_build_lint");
    expect(await db.select().from(approvals).where(eq(approvals.companyId, seeded.companyId))).toHaveLength(0);
    const [entry] = await db.select().from(activityLog).where(eq(activityLog.action, "adapter_approval.supervisor_approved"));
    expect(entry).toMatchObject({ companyId: seeded.companyId, agentId: seeded.agentId, runId: seeded.heartbeatRunId });
    expect(entry?.details).toMatchObject({
      supervisorAgentId: seeded.supervisorId,
      safeCategory: "test_build_lint",
      policy: "approved under delegated supervisor policy",
    });
  });

  it.each(["paused", "error", "terminated", "pending_approval", "active"])("does not use a %s supervisor", async (status) => {
    const seeded = await seed();
    await db.update(agents).set({ status }).where(eq(agents.id, seeded.supervisorId));
    const decision = await handlerFor(seeded)(safeRequest(seeded, { timeoutMs: 30 }));
    expect(decision.decision).toBe("timeout");
    expect(await db.select().from(approvals).where(eq(approvals.companyId, seeded.companyId))).toHaveLength(1);
  });

  it("never delegates red or uncategorised requests, or to a supervisor from another company", async () => {
    const seeded = await seed();
    const other = await seed();
    const handler = handlerFor(seeded);

    await expect(handler(request({ requestId: "red", route: "supervisor", supervisorAgentId: seeded.supervisorId, timeoutMs: 30 })))
      .resolves.toMatchObject({ decision: "timeout" });
    await expect(handler(safeRequest(seeded, { requestId: "nocat", categories: [], timeoutMs: 30 })))
      .resolves.toMatchObject({ decision: "timeout" });
    await expect(handler(safeRequest(seeded, { requestId: "foreign", supervisorAgentId: other.supervisorId, timeoutMs: 30 })))
      .resolves.toMatchObject({ decision: "timeout" });
    const rows = await db.select().from(approvals).where(eq(approvals.companyId, seeded.companyId));
    expect(rows.map((row) => (row.payload as Record<string, unknown>).requestId).sort()).toEqual(["foreign", "nocat", "red"]);
  });

  it("reuses the approval for a replayed request and denies a replay with a different command", async () => {
    const seeded = await seed();
    const handler = handlerFor(seeded);
    await handler(request({ timeoutMs: 30 }));
    await handler(request({ timeoutMs: 30 }));
    expect(await db.select().from(approvals).where(eq(approvals.companyId, seeded.companyId))).toHaveLength(1);
    await expect(handler(request({ command: "launchctl remove ai.paperclip", timeoutMs: 30 })))
      .resolves.toMatchObject({ decision: "denied", decidedBy: "system" });
  });
});
