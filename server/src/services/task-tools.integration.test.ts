import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issueComments, issueRelations, issues } from "@paperclipai/db";
import { preserveRunTaskToolCapabilitySql, TASK_TOOL_RECEIPT_DETAIL_KEY, TASK_TOOL_STATUS_RECEIPT_ACTIONS } from "./run-owned-state.js";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import {
  callTaskTool,
  enableTaskToolsForRun,
  shouldDeliverTaskTools,
  TASK_TOOL_CAPABILITY_CONTEXT_KEY,
  taskToolCapabilityMarker,
  type TaskToolBinding,
} from "./task-tools.js";
import { resolveDispositionOnlyRecoveryQuiet } from "./recovery/disposition-repair.js";

// Synthetic company/agent/issue/run data only; no real credential is used.
describe("run-scoped task tools against the database", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  let binding: TaskToolBinding;
  const fetchMock = vi.fn<typeof fetch>();

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "task-tools-home-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("task-tools-db-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  async function seed(options: { runtimeMode?: string; stamp?: boolean } = {}) {
    const [companyId, agentId, issueId, runId] = Array.from({ length: 4 }, () => randomUUID());
    await db.insert(companies).values({ id: companyId, name: "Task tools", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Claudy", status: "active", adapterType: "claude_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic task", status: "in_progress", workMode: "standard", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running", runtimeMode: options.runtimeMode ?? "legacy",
      invocationSource: "on_demand", contextSnapshot: { issueId, taskId: issueId },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const seeded = { companyId, agentId, issueId, runId };
    if (options.stamp !== false) expect(await enableTaskToolsForRun(db, seeded)).toBe(true);
    return seeded;
  }
  const comments = (issueId: string) => db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
  const run = (args: unknown, name = "add_task_comment", signal?: AbortSignal, target = binding) =>
    callTaskTool(db, { binding: target, name, arguments: args, apiUrl: "http://paperclip.test/api", token: "synthetic-run-jwt", signal });
  const ok = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  beforeEach(async () => {
    binding = await seed();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  describe("server-owned opt-in capability", () => {
    it("delivers only for the explicit local native-login lane", () => {
      const base = { localClaudeLogin: true, adapterType: "claude_local", executionTargetKind: "local", hasRunToken: true, hasApiBaseUrl: true, issueId: "issue" };
      expect(shouldDeliverTaskTools(base)).toBe(true);
      expect(shouldDeliverTaskTools({ ...base, executionTargetKind: undefined })).toBe(true);
      for (const change of [
        { localClaudeLogin: false }, { localClaudeLogin: "true" }, { localClaudeLogin: undefined },
        { adapterType: "codex_local" }, { executionTargetKind: "remote" },
        { hasRunToken: false }, { hasApiBaseUrl: false }, { issueId: null },
      ]) expect(shouldDeliverTaskTools({ ...base, ...change })).toBe(false);
    });

    it("stamps only the running legacy run bound to that issue, agent and company", async () => {
      const [stamped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, binding.runId));
      expect(stamped.contextSnapshot?.[TASK_TOOL_CAPABILITY_CONTEXT_KEY]).toEqual(taskToolCapabilityMarker(binding));
      const other = await seed({ stamp: false });
      expect(await enableTaskToolsForRun(db, { ...other, issueId: binding.issueId })).toBe(false);
      expect(await enableTaskToolsForRun(db, { ...other, agentId: binding.agentId })).toBe(false);
      expect(await enableTaskToolsForRun(db, { ...other, companyId: binding.companyId })).toBe(false);
      const native = await seed({ runtimeMode: "native", stamp: false });
      expect(await enableTaskToolsForRun(db, native)).toBe(false);
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, other.runId));
      expect(await enableTaskToolsForRun(db, other)).toBe(false);
    });

    it("denies an unstamped (ordinary) run and a marker for another issue", async () => {
      const ordinary = await seed({ stamp: false });
      await expect(run({ body: "x", idempotencyKey: "ordinary-1" }, "add_task_comment", undefined, ordinary)).rejects.toMatchObject({ status: 403 });
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: ordinary.issueId, [TASK_TOOL_CAPABILITY_CONTEXT_KEY]: taskToolCapabilityMarker({ agentId: ordinary.agentId, issueId: binding.issueId }) } })
        .where(eq(heartbeatRuns.id, ordinary.runId));
      await expect(run({ body: "x", idempotencyKey: "ordinary-2" }, "add_task_comment", undefined, ordinary)).rejects.toMatchObject({ status: 403 });
      expect(await comments(ordinary.issueId)).toHaveLength(0);
    });
  });

  describe("add_task_comment durable idempotency", () => {
    it("commits once and replays the original result for the same key and payload", async () => {
      const first = await run({ body: "Synthetic progress.", idempotencyKey: "comment-key-1" });
      const retry = await run({ body: "Synthetic progress.", idempotencyKey: "comment-key-1" });
      expect(retry).toMatchObject({ commentId: first.commentId, replayed: true });
      const rows = await comments(binding.issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ authorAgentId: binding.agentId, createdByRunId: binding.runId, body: "Synthetic progress." });
    });

    it("serializes concurrent duplicates into one comment", async () => {
      const results = await Promise.all([1, 2, 3].map(() => run({ body: "Same", idempotencyKey: "comment-race" }).catch((error) => error)));
      expect(results.filter((value) => value instanceof Error)).toHaveLength(0);
      expect(new Set(results.map((value) => (value as Record<string, unknown>).commentId)).size).toBe(1);
      expect(await comments(binding.issueId)).toHaveLength(1);
    });

    it("rejects a reused key with a different payload and keeps distinct keys distinct", async () => {
      const original = await run({ body: "Original", idempotencyKey: "comment-key-2" });
      await expect(run({ body: "Changed", idempotencyKey: "comment-key-2" })).rejects.toMatchObject({ status: 409 });
      expect(await run({ body: "Original", idempotencyKey: "comment-key-2" })).toMatchObject({ commentId: original.commentId, replayed: true });
      // A distinct key is a distinct call. Different text gives a new comment.
      const second = await run({ body: "Second note", idempotencyKey: "comment-key-3" });
      expect(second.commentId).not.toBe(original.commentId);
      expect(second.replayed).toBeUndefined();
      expect(await comments(binding.issueId)).toHaveLength(2);
    });

    it("keeps the issue service's same-run identical-text deduplication", async () => {
      // Existing addComment contract: one run posting identical text yields one
      // comment. A new key records its own receipt bound to that comment.
      const first = await run({ body: "Same text", idempotencyKey: "same-text-1" });
      const second = await run({ body: "Same text", idempotencyKey: "same-text-2" });
      expect(second.commentId).toBe(first.commentId);
      expect(second.replayed).toBeUndefined();
      expect(await comments(binding.issueId)).toHaveLength(1);
      expect(await run({ body: "Same text", idempotencyKey: "same-text-2" })).toMatchObject({ commentId: first.commentId, replayed: true });
    });

    it.each([
      ["missing key", { body: "x" }],
      ["short key", { body: "x", idempotencyKey: "a" }],
      ["key with path characters", { body: "x", idempotencyKey: "../../issues/x" }],
      ["foreign issue field", { body: "x", idempotencyKey: "comment-key-4", issueId: randomUUID() }],
      ["endpoint field", { body: "x", idempotencyKey: "comment-key-5", url: "http://evil.test" }],
      ["attribution field", { body: "x", idempotencyKey: "comment-key-6", onBehalfOfUserId: "user-board" }],
    ])("rejects %s before any write", async (_label, args) => {
      await expect(run(args)).rejects.toThrow();
      expect(await comments(binding.issueId)).toHaveLength(0);
    });
  });

  describe("authority is rechecked inside the committing transaction", () => {
    it.each([
      ["cancelled run", () => db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, binding.runId))],
      ["reassigned issue", async () => {
        const otherAgent = randomUUID();
        await db.insert(agents).values({ id: otherAgent, companyId: binding.companyId, name: "Other", status: "active" });
        await db.update(issues).set({ assigneeAgentId: otherAgent }).where(eq(issues.id, binding.issueId));
      }],
      ["replaced execution run", () => db.update(issues).set({ executionRunId: null }).where(eq(issues.id, binding.issueId))],
      ["removed capability", () => db.update(heartbeatRuns).set({ contextSnapshot: { issueId: binding.issueId } }).where(eq(heartbeatRuns.id, binding.runId))],
      ["paused agent", () => db.update(agents).set({ status: "paused" }).where(eq(agents.id, binding.agentId))],
    ])("denies after %s", async (_label, change) => {
      await change();
      await expect(run({ body: "late write", idempotencyKey: "late-write-1" })).rejects.toMatchObject({ status: 403 });
      await expect(run({ status: "done", idempotencyKey: "late-status-1" }, "update_task_status")).rejects.toMatchObject({ status: 403 });
      expect(await comments(binding.issueId)).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("denies a binding that names another company's issue", async () => {
      const foreign = await seed();
      await expect(run({ body: "x", idempotencyKey: "foreign-1" }, "add_task_comment", undefined, { ...binding, issueId: foreign.issueId })).rejects.toMatchObject({ status: 403 });
      expect(await comments(foreign.issueId)).toHaveLength(0);
    });

    it("does not start a write after the MCP request was cancelled", async () => {
      const aborted = AbortSignal.abort();
      await expect(run({ body: "x", idempotencyKey: "aborted-1" }, "add_task_comment", aborted)).rejects.toThrow();
      await expect(run({ status: "done", idempotencyKey: "aborted-2" }, "update_task_status", aborted)).rejects.toThrow();
      expect(await comments(binding.issueId)).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("update_task_status", () => {
    it.each([
      ["blocked without comment or action", { status: "blocked", idempotencyKey: "status-key-1" }],
      ["blocked without action", { status: "blocked", comment: "Blocked on vendor.", idempotencyKey: "status-key-2" }],
      ["blocked with a vague action", { status: "blocked", comment: "Blocked.", unblockAction: "wait", idempotencyKey: "status-key-3" }],
      ["unblockAction on done", { status: "done", unblockAction: "Rotate the synthetic credential", idempotencyKey: "status-key-4" }],
      ["unsupported status", { status: "cancelled", idempotencyKey: "status-key-5" }],
      ["owner override", { status: "blocked", comment: "x", unblockAction: "Approve the synthetic contract", unblockOwner: "board", idempotencyKey: "status-key-6" }],
    ])("rejects %s before any HTTP", async (_label, args) => {
      await expect(run(args, "update_task_status")).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("forwards a blocked status with a self-owned unblock descriptor and explanatory comment, then replays", async () => {
      fetchMock.mockResolvedValueOnce(ok({ status: "blocked" }));
      const args = { status: "blocked", comment: "The synthetic vendor API now requires a signed DPA.", unblockAction: "Obtain the signed DPA from the synthetic vendor", idempotencyKey: "status-blocked-1" };
      expect(await run(args, "update_task_status")).toMatchObject({ status: "blocked", disposition: "applied" });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`http://paperclip.test/api/issues/${binding.issueId}`);
      expect(init).toMatchObject({ method: "PATCH", redirect: "error" });
      expect((init!.headers as Record<string, string>)["X-Paperclip-Run-Id"]).toBe(binding.runId);
      expect(JSON.parse(String(init!.body))).toEqual({
        status: "blocked", comment: args.comment,
        unblockDescriptor: { owner: { agentId: binding.agentId }, action: args.unblockAction },
      });
      expect(await run(args, "update_task_status")).toMatchObject({ status: "blocked", replayed: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(run({ ...args, comment: "Different explanation" }, "update_task_status")).rejects.toMatchObject({ status: 409 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("reports an unknown outcome after a lost forward and never re-sends that key", async () => {
      fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
      const args = { status: "done", idempotencyKey: "status-timeout-1" };
      await expect(run(args, "update_task_status")).rejects.toThrow(/unknown/);
      expect(await run(args, "update_task_status")).toMatchObject({ outcome: "unknown", replayed: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("releases the reservation after a definite pre-write rejection", async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Entering blocked requires unresolved blockers" }), { status: 422, headers: { "content-type": "application/json" } }));
      const args = { status: "in_review", idempotencyKey: "status-rejected-1" };
      await expect(run(args, "update_task_status")).rejects.toThrow(/Entering blocked/);
      fetchMock.mockResolvedValueOnce(ok({ status: "in_review" }));
      expect(await run(args, "update_task_status")).toMatchObject({ status: "in_review", disposition: "applied" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("keeps an ambiguous server failure as unknown", async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } }));
      const args = { status: "done", idempotencyKey: "status-500-1" };
      await expect(run(args, "update_task_status")).rejects.toThrow();
      expect(await run(args, "update_task_status")).toMatchObject({ outcome: "unknown" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("disposition-only recovery quiet presentation", () => {
    const currentIssue = async () => (await db.select().from(issues).where(eq(issues.id, binding.issueId)))[0]!;
    // A status change committed by someone else (the trigger bumps statusVersion).
    const setStatus = (status: string) => db.update(issues).set({ status } as Partial<typeof issues.$inferInsert>).where(eq(issues.id, binding.issueId));
    // The shape task-tools.ts appends after the issue route committed the change.
    async function completedReceipt(input: { runId: string; agentId?: string; status: string; statusVersion: number | null; actorType?: "agent" | "user" }) {
      await db.insert(activityLog).values({
        companyId: binding.companyId, actorType: input.actorType ?? "agent", actorId: input.agentId ?? binding.agentId,
        agentId: input.agentId ?? binding.agentId, runId: input.runId,
        action: TASK_TOOL_STATUS_RECEIPT_ACTIONS.completed, entityType: "issue", entityId: binding.issueId,
        details: { source: "paperclip_task_tool", [TASK_TOOL_RECEIPT_DETAIL_KEY]: {
          operation: "update_task_status", key: randomUUID().replace(/-/g, ""), digest: "0".repeat(64), state: "completed",
          result: { status: input.status, statusVersion: input.statusVersion },
        } },
      });
    }
    async function repairRuns() {
      const sourceRunId = randomUUID();
      const repairRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: binding.companyId, agentId: binding.agentId, status: "succeeded", invocationSource: "on_demand", contextSnapshot: { issueId: binding.issueId } });
      await db.insert(heartbeatRuns).values({ id: repairRunId, companyId: binding.companyId, agentId: binding.agentId, status: "succeeded", invocationSource: "automation", contextSnapshot: {
        issueId: binding.issueId, taskId: binding.issueId, source: "issue.deliberate_wait_disposition_repair",
        legacyDispositionEpisode: { id: sourceRunId, attempt: 1, maxAttempts: 2 }, dispositionRepairSourceRunId: sourceRunId,
      } });
      return { sourceRunId, repairRunId };
    }
    /** The repair run changes status through the task tool; its receipt records the committed version. */
    async function repair(issueStatus: string, options: { patch?: Record<string, unknown>; receipt?: boolean } = {}) {
      const runs = await repairRuns();
      await db.update(issues).set({ status: issueStatus, executionRunId: null, ...(options.patch ?? {}) } as Partial<typeof issues.$inferInsert>).where(eq(issues.id, binding.issueId));
      const committed = await currentIssue();
      if (options.receipt !== false) {
        await completedReceipt({ runId: runs.repairRunId, status: committed.status, statusVersion: committed.statusVersion });
      }
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runs.repairRunId));
      return { row, ...runs, committed };
    }
    const quiet = (row: typeof heartbeatRuns.$inferSelect) => resolveDispositionOnlyRecoveryQuiet(db, { run: row, issueId: binding.issueId });

    it("stays quiet for the repair's own completed receipt at the exact current version", async () => {
      expect(await quiet((await repair("done")).row)).toBe(true);
    });
    it("records the route-committed version through the real task-tool path", async () => {
      const { repairRunId } = await repairRuns();
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, repairRunId));
      await db.update(issues).set({ executionRunId: repairRunId }).where(eq(issues.id, binding.issueId));
      const repairBinding = { ...binding, runId: repairRunId };
      expect(await enableTaskToolsForRun(db, repairBinding)).toBe(true);
      // Stand-in for the PATCH route: commit the change and return the issue row.
      fetchMock.mockImplementationOnce(async () => {
        const [updated] = await db.update(issues).set({ status: "done" }).where(eq(issues.id, binding.issueId)).returning();
        return ok({ ...updated });
      });
      const result = await run({ status: "done", idempotencyKey: "repair-done-1" }, "update_task_status", undefined, repairBinding);
      const committed = await currentIssue();
      expect(result).toMatchObject({ status: "done", statusVersion: committed.statusVersion });
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, repairRunId));
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, repairRunId));
      expect(await quiet(row!)).toBe(true);
      // A -> B -> A by someone else afterwards: same status, newer version.
      await setStatus("in_progress");
      await setStatus("done");
      expect((await currentIssue()).statusVersion).toBe(committed.statusVersion + 2);
      expect(await quiet(row!)).toBe(false);
    });
    it("presents prose when the repair recorded no disposition", async () => {
      expect(await quiet((await repair("in_progress")).row)).toBe(false);
      expect(await quiet((await repair("todo")).row)).toBe(false);
    });
    it("requires structured blocker evidence for a quiet blocked repair", async () => {
      expect(await quiet((await repair("blocked")).row)).toBe(false);
      expect(await quiet((await repair("in_progress")).row)).toBe(false);
      expect(await quiet((await repair("blocked", { patch: { unblockDescriptor: { owner: { agentId: binding.agentId }, action: "Obtain the synthetic signed DPA" } } })).row)).toBe(true);
    });
    it("accepts a blocker relation and rejects an unbacked review wait", async () => {
      expect(await quiet((await repair("in_review")).row)).toBe(false);
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId: binding.companyId, title: "Synthetic blocker", status: "todo", workMode: "standard" });
      await db.insert(issueRelations).values({ companyId: binding.companyId, issueId: blockerId, relatedIssueId: binding.issueId, type: "blocks" });
      expect(await quiet((await repair("blocked")).row)).toBe(true);
    });
    it("rejects foreign source evidence even with a matching receipt", async () => {
      const { row, sourceRunId } = await repair("done");
      const otherAgent = randomUUID();
      await db.insert(agents).values({ id: otherAgent, companyId: binding.companyId, name: "Other", status: "active" });
      await db.update(heartbeatRuns).set({ agentId: otherAgent }).where(and(eq(heartbeatRuns.id, sourceRunId), eq(heartbeatRuns.companyId, binding.companyId)));
      expect(await quiet(row)).toBe(false);
    });

    describe("committed-version attribution", () => {
      it("shows prose after A -> B -> A, even when a delayed activity row lands last", async () => {
        const { row, repairRunId } = await repair("done");
        await setStatus("in_progress");
        await setStatus("done");
        // Post-commit reordering: the repair's own issue.updated activity is
        // written after the other transitions. Timestamps are not consulted.
        await db.insert(activityLog).values({
          companyId: binding.companyId, actorType: "agent", actorId: binding.agentId, agentId: binding.agentId, runId: repairRunId,
          action: "issue.updated", entityType: "issue", entityId: binding.issueId, details: { status: "done" },
          createdAt: new Date(Date.now() + 60_000),
        });
        expect(await quiet(row)).toBe(false);
      });
      it("shows prose when the repair has no receipt (crash before receipt, or another lane)", async () => {
        const { row, repairRunId } = await repair("done", { receipt: false });
        // A route-style activity attributed to the repair run is not a receipt.
        await db.insert(activityLog).values({
          companyId: binding.companyId, actorType: "agent", actorId: binding.agentId, agentId: binding.agentId, runId: repairRunId,
          action: "issue.updated", entityType: "issue", entityId: binding.issueId, details: { status: "done" },
        });
        expect(await quiet(row)).toBe(false);
      });
      it("ignores receipts from another run, another agent or a board actor at the same version", async () => {
        const { row, committed } = await repair("done", { receipt: false });
        const otherAgent = randomUUID();
        await db.insert(agents).values({ id: otherAgent, companyId: binding.companyId, name: "Other", status: "active" });
        await completedReceipt({ runId: binding.runId, status: committed.status, statusVersion: committed.statusVersion });
        await completedReceipt({ runId: row.id, agentId: otherAgent, status: committed.status, statusVersion: committed.statusVersion });
        await completedReceipt({ runId: row.id, actorType: "user", status: committed.status, statusVersion: committed.statusVersion });
        expect(await quiet(row)).toBe(false);
      });
      it("rejects a receipt with a stale or missing version", async () => {
        const { row, committed } = await repair("done", { receipt: false });
        await completedReceipt({ runId: row.id, status: committed.status, statusVersion: committed.statusVersion - 1 });
        await completedReceipt({ runId: row.id, status: committed.status, statusVersion: null });
        expect(await quiet(row)).toBe(false);
      });
      it("is unaffected by later non-status activity", async () => {
        const { row } = await repair("done");
        await db.insert(activityLog).values({ companyId: binding.companyId, actorType: "user", actorId: "user-board", action: "issue.comment_added", entityType: "issue", entityId: binding.issueId, details: { bodySnippet: "Thanks" } });
        expect(await quiet(row)).toBe(true);
      });
      it("fails closed on malformed server context ids", async () => {
        const { row } = await repair("done");
        expect(await resolveDispositionOnlyRecoveryQuiet(db, { run: row, issueId: "not-a-uuid" })).toBe(false);
        expect(await resolveDispositionOnlyRecoveryQuiet(db, { run: { ...row, contextSnapshot: { ...row.contextSnapshot, dispositionRepairSourceRunId: "not-a-uuid" } }, issueId: binding.issueId })).toBe(false);
      });
    });
  });

  describe("receipts in the append-only activity log", () => {
    it("replays across runs of the same agent and task, and stays separate per agent", async () => {
      const first = await run({ body: "Once only.", idempotencyKey: "cross-run-1" });
      // Finalization-style wholesale replacement of run JSON cannot touch receipts.
      await db.update(heartbeatRuns).set({ status: "succeeded", resultJson: { summary: "adapter output" } }).where(eq(heartbeatRuns.id, binding.runId));
      const laterRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: laterRunId, companyId: binding.companyId, agentId: binding.agentId, status: "running", invocationSource: "on_demand", contextSnapshot: { issueId: binding.issueId } });
      await db.update(issues).set({ executionRunId: laterRunId }).where(eq(issues.id, binding.issueId));
      const later = { ...binding, runId: laterRunId };
      expect(await enableTaskToolsForRun(db, later)).toBe(true);
      expect(await run({ body: "Once only.", idempotencyKey: "cross-run-1" }, "add_task_comment", undefined, later))
        .toMatchObject({ commentId: first.commentId, replayed: true });
      expect(await comments(binding.issueId)).toHaveLength(1);
      // Another agent's identical key is a different scope.
      const otherAgent = randomUUID();
      const otherRun = randomUUID();
      await db.insert(agents).values({ id: otherAgent, companyId: binding.companyId, name: "Other", status: "active" });
      await db.insert(heartbeatRuns).values({ id: otherRun, companyId: binding.companyId, agentId: otherAgent, status: "running", invocationSource: "on_demand", contextSnapshot: { issueId: binding.issueId } });
      await db.update(issues).set({ assigneeAgentId: otherAgent, executionRunId: otherRun }).where(eq(issues.id, binding.issueId));
      const otherBinding = { ...binding, agentId: otherAgent, runId: otherRun };
      expect(await enableTaskToolsForRun(db, otherBinding)).toBe(true);
      const separate = await run({ body: "Once only.", idempotencyKey: "cross-run-1" }, "add_task_comment", undefined, otherBinding);
      expect(separate.replayed).toBeUndefined();
      expect(await comments(binding.issueId)).toHaveLength(2);
    });

    it("rejects reuse of a released status key with a different payload", async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Rejected" }), { status: 422, headers: { "content-type": "application/json" } }));
      await expect(run({ status: "in_review", idempotencyKey: "released-1" }, "update_task_status")).rejects.toThrow();
      await expect(run({ status: "done", idempotencyKey: "released-1" }, "update_task_status")).rejects.toMatchObject({ status: 409 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("never marks receipt rows as status transitions", async () => {
      fetchMock.mockResolvedValueOnce(ok({ status: "done", statusVersion: 7 }));
      expect(await run({ status: "done", idempotencyKey: "transition-1" }, "update_task_status")).toMatchObject({ status: "done", statusVersion: 7 });
      const rows = await db.select().from(activityLog).where(and(eq(activityLog.entityId, binding.issueId), eq(activityLog.runId, binding.runId)));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.details?.status).toBeUndefined();
    });
  });

  describe("run binding SQL", () => {
    it("compares the uuid native issue id with context text ids, preferring the native id", async () => {
      const nativeBound = await seed({ stamp: false });
      await db.update(heartbeatRuns).set({ nativeIssueId: nativeBound.issueId }).where(eq(heartbeatRuns.id, nativeBound.runId));
      expect(await enableTaskToolsForRun(db, nativeBound)).toBe(true);
      const conflicting = await seed({ stamp: false });
      // The context still names this issue, but the native id names another.
      await db.update(heartbeatRuns).set({ nativeIssueId: binding.issueId }).where(eq(heartbeatRuns.id, conflicting.runId));
      expect(await enableTaskToolsForRun(db, conflicting)).toBe(false);
      const taskOnly = await seed({ stamp: false });
      await db.update(heartbeatRuns).set({ contextSnapshot: { taskId: taskOnly.issueId } }).where(eq(heartbeatRuns.id, taskOnly.runId));
      expect(await enableTaskToolsForRun(db, taskOnly)).toBe(true);
    });

    it("keeps the stamped capability through a stale whole-object context write", async () => {
      await db.update(heartbeatRuns).set({ contextSnapshot: preserveRunTaskToolCapabilitySql({ issueId: binding.issueId, paperclipRuntimeServices: [] }) })
        .where(eq(heartbeatRuns.id, binding.runId));
      let [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, binding.runId));
      expect(row.contextSnapshot).toMatchObject({ issueId: binding.issueId, paperclipRuntimeServices: [], [TASK_TOOL_CAPABILITY_CONTEXT_KEY]: taskToolCapabilityMarker(binding) });
      // A stale copy carrying a different marker cannot replace the stamped one.
      await db.update(heartbeatRuns).set({ contextSnapshot: preserveRunTaskToolCapabilitySql({ issueId: binding.issueId, [TASK_TOOL_CAPABILITY_CONTEXT_KEY]: { version: 1, agentId: "forged", issueId: "forged" } }) })
        .where(eq(heartbeatRuns.id, binding.runId));
      [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, binding.runId));
      expect(row.contextSnapshot?.[TASK_TOOL_CAPABILITY_CONTEXT_KEY]).toEqual(taskToolCapabilityMarker(binding));
      expect(await run({ body: "still enabled", idempotencyKey: "after-context-write" })).toMatchObject({ disposition: "applied" });
      // An unstamped run gains nothing from the expression.
      const ordinary = await seed({ stamp: false });
      await db.update(heartbeatRuns).set({ contextSnapshot: preserveRunTaskToolCapabilitySql({ issueId: ordinary.issueId }) }).where(eq(heartbeatRuns.id, ordinary.runId));
      [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ordinary.runId));
      expect(row.contextSnapshot).toEqual({ issueId: ordinary.issueId });
    });
  });
});
