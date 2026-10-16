import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { createAdapterApprovalRequestHandler } from "../services/adapter-approval-requests.js";
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

  function request(overrides: Partial<AdapterApprovalRequest> = {}): AdapterApprovalRequest {
    return {
      requestId: "req-1",
      providerRunId: "run-hermes-1",
      tier: "red",
      route: "board",
      supervisorAgentId: null,
      command: "launchctl kickstart -k gui/501/ai.paperclip",
      description: "stop/restart hermes launchd service",
      reasons: ["service_control"],
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  function handlerFor(seeded: Awaited<ReturnType<typeof seed>>, sleep?: (ms: number, signal: AbortSignal) => Promise<void>) {
    return createAdapterApprovalRequestHandler({
      db,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      agentName: "Nox",
      heartbeatRunId: seeded.heartbeatRunId,
      adapterType: "hermes_gateway",
      issueId: seeded.issueId,
      pollIntervalMs: 5,
      sleep,
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

  it("creates a linked board approval and returns the board's decision", async () => {
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
    });
    const links = await db.select().from(issueApprovals).where(eq(issueApprovals.approvalId, approval.id));
    expect(links.map((link) => link.issueId)).toEqual([seeded.issueId]);

    await approvalService(db).approve(approval.id, "board-user", "go ahead");
    const decision = await pending;

    expect(decision).toMatchObject({ decision: "approved", decidedBy: "board", approvalId: approval.id, note: "go ahead" });
    const actions = (await db.select().from(activityLog).where(eq(activityLog.companyId, seeded.companyId))).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["approval.created", "adapter_approval.board_resolved"]));
  });

  it("maps a board rejection to a denial", async () => {
    const seeded = await seed();
    const pending = handlerFor(seeded)(request());
    const approval = await waitForPendingApproval(seeded.companyId);
    await approvalService(db).reject(approval.id, "board-user", "no");
    await expect(pending).resolves.toMatchObject({ decision: "denied", decidedBy: "board" });
  });

  it("cancels the approval and fails closed on timeout", async () => {
    const seeded = await seed();
    const decision = await handlerFor(seeded)(request({ timeoutMs: 30 }));
    expect(decision.decision).toBe("timeout");
    const [row] = await db.select().from(approvals).where(eq(approvals.companyId, seeded.companyId));
    expect(row?.status).toBe("cancelled");
    const actions = (await db.select().from(activityLog).where(eq(activityLog.companyId, seeded.companyId))).map((entry) => entry.action);
    expect(actions).toContain("adapter_approval.timed_out");
  });

  it("cancels the approval when the run ends before a decision", async () => {
    const seeded = await seed();
    const controller = new AbortController();
    const pending = handlerFor(seeded)(request({ signal: controller.signal }));
    await waitForPendingApproval(seeded.companyId);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ decision: "cancelled", decidedBy: "system" });
    const [row] = await db.select().from(approvals).where(eq(approvals.companyId, seeded.companyId));
    expect(row?.status).toBe("cancelled");
  });

  it("approves yellow requests under the delegated supervisor policy with an audit entry", async () => {
    const seeded = await seed();
    const decision = await handlerFor(seeded)(request({
      tier: "yellow",
      route: "supervisor",
      supervisorAgentId: seeded.supervisorId,
      reasons: ["no_red_rule_matched"],
    }));
    expect(decision).toMatchObject({
      decision: "approved",
      decidedBy: "supervisor_policy",
      supervisorAgentId: seeded.supervisorId,
      note: "approved under delegated supervisor policy",
    });
    expect(await db.select().from(approvals).where(eq(approvals.companyId, seeded.companyId))).toHaveLength(0);
    const [entry] = await db.select().from(activityLog).where(eq(activityLog.action, "adapter_approval.supervisor_approved"));
    expect(entry).toMatchObject({ companyId: seeded.companyId, agentId: seeded.agentId, runId: seeded.heartbeatRunId });
    expect(entry?.details).toMatchObject({ supervisorAgentId: seeded.supervisorId, policy: "approved under delegated supervisor policy" });
  });

  it("never delegates red requests and falls back to the board for a supervisor from another company", async () => {
    const seeded = await seed();
    const other = await seed();
    const handler = handlerFor(seeded);

    const red = handler(request({ requestId: "red", route: "supervisor", supervisorAgentId: seeded.supervisorId, timeoutMs: 30 }));
    await expect(red).resolves.toMatchObject({ decision: "timeout" });

    const foreign = handler(request({
      requestId: "foreign",
      tier: "yellow",
      route: "supervisor",
      supervisorAgentId: other.supervisorId,
      timeoutMs: 30,
    }));
    await expect(foreign).resolves.toMatchObject({ decision: "timeout" });
    const rows = await db.select().from(approvals).where(eq(approvals.companyId, seeded.companyId));
    expect(rows.map((row) => (row.payload as Record<string, unknown>).requestId).sort()).toEqual(["foreign", "red"]);
  });

  it("reuses the approval for a replayed request id", async () => {
    const seeded = await seed();
    const handler = handlerFor(seeded);
    await handler(request({ timeoutMs: 30 }));
    await handler(request({ timeoutMs: 30 }));
    expect(await db.select().from(approvals).where(eq(approvals.companyId, seeded.companyId))).toHaveLength(1);
  });
});
