import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { activityLog, agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { conflict, forbidden } from "../errors.js";
import { issueService } from "./issues.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import {
  RUN_TASK_TOOL_CAPABILITY_KEY,
  TASK_TOOL_RECEIPT_DETAIL_KEY,
  TASK_TOOL_STATUS_RECEIPT_ACTIONS,
} from "./run-owned-state.js";

/**
 * Run-scoped task comment/status tools for the bounded local Claude login lane,
 * where default Claude permissions refuse shell HTTP. Authority is never taken
 * from tool input:
 *  - the run must carry the server-stamped capability marker (opt-in),
 *  - every write re-reads run, issue and agent under row locks inside the
 *    committing transaction (running run, current assignee, current execution
 *    run), and
 *  - each call is keyed by a caller idempotency key whose durable receipt (an
 *    append-only activity row) is scoped to this agent and issue and to the
 *    exact payload.
 */
export const TASK_TOOL_NAMES = ["add_task_comment", "update_task_status"] as const;
export type TaskToolName = (typeof TASK_TOOL_NAMES)[number];
export const TASK_TOOL_STATUSES = ["in_progress", "in_review", "blocked", "done"] as const;
/** Server-owned run context key; only heartbeat delivery writes it. */
export const TASK_TOOL_CAPABILITY_CONTEXT_KEY = RUN_TASK_TOOL_CAPABILITY_KEY;
export const TASK_TOOL_AUTHORIZATION_REASON = "paperclip_task_tool";
const TASK_TOOL_TEXT_MAX = 20_000;
const UNBLOCK_ACTION_MIN = 20;
const STATUS_FORWARD_TIMEOUT_MS = 60_000;
// The issue route rejects these before any write (same set the runner uses for
// definite pre-write failures); anything else leaves the outcome unknown.
const PRE_WRITE_FAILURE_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

export type TaskToolBinding = { companyId: string; agentId: string; runId: string; issueId: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function taskToolCapabilityMarker(binding: Pick<TaskToolBinding, "agentId" | "issueId">) {
  return { version: 1, agentId: binding.agentId, issueId: binding.issueId };
}
export function hasTaskToolCapability(contextSnapshot: unknown, binding: Pick<TaskToolBinding, "agentId" | "issueId">) {
  const marker = record(record(contextSnapshot)[TASK_TOOL_CAPABILITY_CONTEXT_KEY]);
  return marker.version === 1 && marker.agentId === binding.agentId && marker.issueId === binding.issueId;
}

/**
 * Delivery gate, evaluated by heartbeat from the server-resolved effective
 * config of the run being launched (never from MCP/tool callers).
 */
export function shouldDeliverTaskTools(input: {
  localClaudeLogin: unknown; adapterType: string; executionTargetKind: string | null | undefined;
  hasRunToken: boolean; hasApiBaseUrl: boolean; issueId: string | null | undefined;
}) {
  return input.localClaudeLogin === true && input.adapterType === "claude_local" &&
    input.executionTargetKind !== "remote" && input.hasRunToken && input.hasApiBaseUrl && Boolean(input.issueId);
}

/**
 * Stamp the capability into this running run's server-owned context. Returns
 * false (deliver nothing) unless exactly this legacy running run was stamped.
 */
export async function enableTaskToolsForRun(db: Db, binding: TaskToolBinding): Promise<boolean> {
  const marker = JSON.stringify({ [TASK_TOOL_CAPABILITY_CONTEXT_KEY]: taskToolCapabilityMarker(binding) });
  const rows = await db.update(heartbeatRuns).set({
    contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${marker}::jsonb`,
  }).where(and(
    eq(heartbeatRuns.id, binding.runId),
    eq(heartbeatRuns.companyId, binding.companyId),
    eq(heartbeatRuns.agentId, binding.agentId),
    eq(heartbeatRuns.status, "running"),
    sql`${heartbeatRuns.runtimeMode} <> 'native'`,
    // native_issue_id is uuid; context values are text. Compare as text, with
    // the same precedence as runIssueId().
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot} ->> 'issueId', ${heartbeatRuns.contextSnapshot} ->> 'taskId') = ${binding.issueId}::text`,
  )).returning({ id: heartbeatRuns.id });
  return rows.length === 1;
}

const idempotencyKey = z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/)
  .describe("Unique key for this exact call (8-200 chars of A-Z a-z 0-9 . _ : -). Reuse it only to retry the identical call; a retry returns the original result instead of writing again.");
const text = z.string().trim().min(1).max(TASK_TOOL_TEXT_MAX);
const addTaskCommentInput = z.strictObject({
  body: text.describe("Markdown comment for the task this run is working on."),
  idempotencyKey,
});
const updateTaskStatusInput = z.strictObject({
  status: z.enum(TASK_TOOL_STATUSES),
  comment: text.optional()
    .describe("Markdown comment recorded with the status change. Required for blocked: explain the new blocker."),
  unblockAction: z.string().trim().min(UNBLOCK_ACTION_MIN).max(2_000).optional()
    .describe("Required for blocked: the exact action that will unblock this task. You remain its owner."),
  idempotencyKey,
}).superRefine((value, ctx) => {
  if (value.status === "blocked") {
    if (!value.comment) ctx.addIssue({ code: "custom", path: ["comment"], message: "Blocking requires a comment that explains the blocker" });
    if (!value.unblockAction) ctx.addIssue({ code: "custom", path: ["unblockAction"], message: "Blocking requires unblockAction: the exact action that will unblock this task" });
  } else if (value.unblockAction !== undefined) {
    ctx.addIssue({ code: "custom", path: ["unblockAction"], message: "unblockAction is only valid with status blocked" });
  }
});

export function taskToolDefinitions() {
  return [
    {
      name: "add_task_comment",
      description: "Post a comment on the task this run is working on. Use this instead of curl, node, or other shell HTTP calls to the Paperclip API.",
      inputSchema: z.toJSONSchema(addTaskCommentInput),
    },
    {
      name: "update_task_status",
      description: "Change the status of the task this run is working on (in_progress, in_review, blocked, done). Blocking requires a comment and an unblockAction. Use this instead of shell HTTP calls to the Paperclip API.",
      inputSchema: z.toJSONSchema(updateTaskStatusInput),
    },
  ];
}

function runIssueId(run: typeof heartbeatRuns.$inferSelect): string | null {
  const context = record(run.contextSnapshot);
  const value = run.nativeIssueId ?? context.issueId ?? context.taskId;
  return typeof value === "string" && value ? value : null;
}

/**
 * Lock the issue, then the run/issue/agent rows, and re-check authority inside
 * the caller's transaction. A Stop/cancel, reassignment, replacement execution
 * run or capability loss that commits first is rejected; one that arrives later
 * waits for this transaction.
 */
export async function lockAuthorizedTaskToolContext(tx: Db, binding: TaskToolBinding) {
  await tx.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId))).for("update");
  const [row] = await tx.select({ run: heartbeatRuns, issue: issues, actor: agents })
    .from(heartbeatRuns)
    .innerJoin(issues, eq(issues.id, binding.issueId))
    .innerJoin(agents, eq(agents.id, binding.agentId))
    .where(and(
      eq(heartbeatRuns.id, binding.runId),
      eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.agentId, binding.agentId),
      eq(issues.companyId, binding.companyId),
      eq(issues.assigneeAgentId, binding.agentId),
      eq(issues.executionRunId, binding.runId),
      eq(agents.companyId, binding.companyId),
    ))
    .for("update")
    .limit(1);
  if (
    !row ||
    row.run.status !== "running" ||
    row.run.runtimeMode === "native" ||
    runIssueId(row.run) !== binding.issueId ||
    !hasTaskToolCapability(row.run.contextSnapshot, binding) ||
    ["paused", "terminated", "pending_approval", "error"].includes(row.actor.status)
  ) {
    throw forbidden("Task tools are not authorized for this run");
  }
  return row;
}

/**
 * Receipts live in the append-only activity log, never in mutable run JSON:
 * finalization, liveness and presentation writers replace `resultJson`
 * wholesale and would erase them. A receipt is the `taskToolReceipt` detail of
 * an issue activity row (company, issue, agent, run). The comment receipt is
 * the comment's own activity row, written in the comment's transaction.
 * Receipts are scoped to agent + issue, so a retried or recovered run of the
 * same agent replays instead of writing again. The key is stored hashed, so
 * activity redaction cannot rewrite it.
 */
export { TASK_TOOL_RECEIPT_DETAIL_KEY, TASK_TOOL_STATUS_RECEIPT_ACTIONS };
type ReceiptState = "pending" | "completed" | "released";
type TaskToolReceipt = {
  operation: TaskToolName;
  key: string;
  digest: string;
  state: ReceiptState;
  result?: Record<string, unknown>;
};

function receiptKey(name: TaskToolName, key: string) {
  return sha256(`${name}\u0000${key}`);
}
async function readLatestReceipt(tx: Db, binding: TaskToolBinding, key: string): Promise<TaskToolReceipt | null> {
  const [row] = await tx.select({ details: activityLog.details }).from(activityLog)
    .where(and(
      eq(activityLog.companyId, binding.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, binding.issueId),
      eq(activityLog.agentId, binding.agentId),
      sql`${activityLog.details} -> ${TASK_TOOL_RECEIPT_DETAIL_KEY}::text ->> 'key' = ${key}`,
    ))
    // Later transactions get later timestamps; a terminal state outranks a tie.
    .orderBy(
      desc(activityLog.createdAt),
      desc(sql`case ${activityLog.details} -> ${TASK_TOOL_RECEIPT_DETAIL_KEY}::text ->> 'state' when 'completed' then 2 when 'released' then 1 else 0 end`),
    )
    .limit(1);
  const receipt = record(record(row?.details)[TASK_TOOL_RECEIPT_DETAIL_KEY]);
  return typeof receipt.key === "string" ? receipt as unknown as TaskToolReceipt : null;
}
async function appendStatusReceipt(tx: Db, binding: TaskToolBinding, receipt: TaskToolReceipt, extra: Record<string, unknown> = {}) {
  // Not published live: receipts are audit/idempotency records. Field names
  // avoid a top-level `status`, which marks real status transitions.
  await persistActivity(tx, {
    companyId: binding.companyId, actorType: "agent", actorId: binding.agentId,
    agentId: binding.agentId, runId: binding.runId, issueId: binding.issueId,
    action: TASK_TOOL_STATUS_RECEIPT_ACTIONS[receipt.state], entityType: "issue", entityId: binding.issueId,
    details: { ...extra, source: "paperclip_task_tool", [TASK_TOOL_RECEIPT_DETAIL_KEY]: receipt },
  });
}
function replayReceipt(prior: TaskToolReceipt, name: TaskToolName, digest: string, binding: TaskToolBinding) {
  if (prior.operation !== name || prior.digest !== digest) {
    throw conflict("This idempotencyKey was already used for a different task tool call");
  }
  if (prior.state === "completed") return { ...(prior.result ?? {}), issueId: binding.issueId, disposition: "applied", replayed: true };
  return {
    issueId: binding.issueId, outcome: "unknown", replayed: true,
    guidance: "An earlier call with this idempotencyKey may or may not have applied. Inspect the task before deciding; do not resend it with a new key unless the task shows it did not apply.",
  };
}

export async function callTaskTool(db: Db, input: {
  binding: TaskToolBinding;
  name: string;
  arguments: unknown;
  apiUrl: string;
  token: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const { binding } = input;
  if (!(TASK_TOOL_NAMES as readonly string[]).includes(input.name)) throw forbidden("Tool is unavailable");
  const name = input.name as TaskToolName;
  input.signal?.throwIfAborted();

  if (name === "add_task_comment") {
    const args = addTaskCommentInput.parse(input.arguments ?? {});
    const key = receiptKey(name, args.idempotencyKey);
    const digest = sha256(canonicalJson({ body: args.body }));
    let publication: Awaited<ReturnType<typeof persistActivity>>["publication"] | null = null;
    // Comment, activity and receipt commit together under the locked authority
    // check, so a timeout after commit replays instead of writing twice.
    const result = await db.transaction(async (tx) => {
      const context = await lockAuthorizedTaskToolContext(tx as unknown as Db, binding);
      const prior = await readLatestReceipt(tx as unknown as Db, binding, key);
      if (prior) return replayReceipt(prior, name, digest, binding);
      const comment = await issueService(tx as unknown as Db).addComment(
        binding.issueId, args.body,
        { agentId: binding.agentId, runId: binding.runId },
        { authorizationReason: TASK_TOOL_AUTHORIZATION_REASON },
        tx,
      );
      const receipt: TaskToolReceipt = { operation: name, key, digest, state: "completed", result: { commentId: comment.id } };
      const activity = await persistActivity(tx as unknown as Db, {
        companyId: binding.companyId, actorType: "agent", actorId: binding.agentId,
        agentId: binding.agentId, runId: binding.runId, issueId: binding.issueId,
        action: "issue.comment_added", entityType: "issue", entityId: binding.issueId,
        details: {
          commentId: comment.id, bodySnippet: comment.body.slice(0, 120),
          identifier: context.issue.identifier, issueTitle: context.issue.title,
          authorizationReason: TASK_TOOL_AUTHORIZATION_REASON, source: "paperclip_task_tool",
          [TASK_TOOL_RECEIPT_DETAIL_KEY]: receipt,
        },
      });
      publication = activity.publication;
      return { commentId: comment.id, issueId: binding.issueId, disposition: "applied" };
    });
    if (publication) publishActivity(publication);
    return result;
  }

  // Status changes keep the authoritative issue route (transition, blocker,
  // review, wake and dependency rules live only there). Reserve the receipt
  // durably under the locked authority check first; never replay a possibly
  // committed forward.
  const args = updateTaskStatusInput.parse(input.arguments ?? {});
  const key = receiptKey(name, args.idempotencyKey);
  const digest = sha256(canonicalJson({ status: args.status, comment: args.comment, unblockAction: args.unblockAction }));
  const reserved = await db.transaction(async (tx) => {
    await lockAuthorizedTaskToolContext(tx as unknown as Db, binding);
    const prior = await readLatestReceipt(tx as unknown as Db, binding, key);
    if (prior && prior.state !== "released") return replayReceipt(prior, name, digest, binding);
    // A released key never applied; it may be reused only for the same payload.
    if (prior && (prior.operation !== name || prior.digest !== digest)) {
      throw conflict("This idempotencyKey was already used for a different task tool call");
    }
    await appendStatusReceipt(tx as unknown as Db, binding,
      { operation: name, key, digest, state: "pending" }, { requestedStatus: args.status });
    return null;
  });
  if (reserved) return reserved;

  const body: Record<string, unknown> = { status: args.status };
  if (args.comment) body.comment = args.comment;
  if (args.status === "blocked") {
    // Agents may only name themselves; the route re-validates the owner.
    body.unblockDescriptor = { owner: { agentId: binding.agentId }, action: args.unblockAction };
  }
  const signals = [AbortSignal.timeout(STATUS_FORWARD_TIMEOUT_MS), ...(input.signal ? [input.signal] : [])];
  let response: Response;
  try {
    response = await fetch(`${input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api/issues/${encodeURIComponent(binding.issueId)}`, {
      method: "PATCH",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
        "X-Paperclip-Run-Id": binding.runId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
  } catch {
    // Aborting stops waiting; it cannot prove the route did not commit.
    throw new Error("Task status outcome is unknown. Inspect the task before retrying; retrying with the same idempotencyKey reports this unknown outcome.");
  }
  const payload = record(await response.json().catch(() => ({})));
  if (!response.ok) {
    if (PRE_WRITE_FAILURE_STATUSES.has(response.status)) {
      // Definite rejection before any write: release the reservation.
      await appendStatusReceipt(db, binding, { operation: name, key, digest, state: "released" },
        { httpStatus: response.status });
    }
    const message = typeof payload.error === "string" ? payload.error : `Task status change failed (${response.status})`;
    throw new Error(message.slice(0, 2_000));
  }
  // The route's committed issue row: record its status and status version.
  const result = {
    status: typeof payload.status === "string" ? payload.status : null,
    statusVersion: typeof payload.statusVersion === "number" ? payload.statusVersion : null,
  };
  await appendStatusReceipt(db, binding, { operation: name, key, digest, state: "completed", result });
  return { ...result, issueId: binding.issueId, disposition: "applied" };
}
