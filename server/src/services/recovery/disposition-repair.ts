import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import { isUuidLike } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRelations,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import { parseIssueExecutionState } from "../issue-execution-policy.js";
import { deriveCommentId } from "../../modules/run-dispatch/domain/wake-context.js";
import {
  dispositionRepairQuietEligible,
  isBoundLegacyDispositionRepairRun,
  legacyDispositionEpisode,
  legacyDispositionRepairSourceRunId,
  repairRunOwnsCurrentStatus,
} from "./legacy-continuation.js";

const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

export const DISPOSITION_REPAIR_MAX_ATTEMPTS = 5;
export const DISPOSITION_REPAIR_BASE_DELAYS_MS = [0, 60_000, 120_000, 240_000, 480_000] as const;

type DispositionRepairIssue = Pick<
  typeof issues.$inferSelect,
  | "id"
  | "companyId"
  | "status"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "executionPolicy"
  | "executionState"
  | "monitorNextCheckAt"
>;

export type DispositionRepairSourceState = {
  fingerprint: string;
  dependencyIssueIds: string[];
  hasActiveExecutionPath: boolean;
  hasDurableWaitingPath: boolean;
  durablePathReason: string | null;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function boundedRecoveryDelayMs(
  attempt: number,
  fingerprint: string,
  delays: readonly number[],
  lane: string,
) {
  const baseDelayMs = delays[attempt - 1];
  if (baseDelayMs === undefined) throw new Error(`Invalid ${lane} attempt: ${attempt}`);
  if (baseDelayMs === 0) return { baseDelayMs, jitterMs: 0, delayMs: 0 };

  const jitterBoundMs = Math.floor(baseDelayMs * 0.1);
  const sample = Number.parseInt(
    createHash("sha256").update(`${fingerprint}:${attempt}`).digest("hex").slice(0, 8),
    16,
  );
  const jitterMs = sample % (jitterBoundMs + 1);
  return { baseDelayMs, jitterMs, delayMs: baseDelayMs + jitterMs };
}

export function dispositionRepairDelayMs(attempt: number, fingerprint: string) {
  return boundedRecoveryDelayMs(
    attempt,
    fingerprint,
    DISPOSITION_REPAIR_BASE_DELAYS_MS,
    "disposition repair",
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Server-side quiet-presentation decision for a finishing run. True only for a
 * disposition-only legacy repair bound to its own successful source run, whose
 * own successful status write is the single status change since recovery
 * scheduled it (committed status_version baseline + 1), and whose disposition
 * is durable. Never reads provider text or activity timestamps.
 */
export async function resolveDispositionOnlyRecoveryQuiet(
  db: Db,
  input: { run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "status" | "runtimeMode" | "contextSnapshot">; issueId: string | null },
): Promise<boolean> {
  if (!input.issueId || !UUID_RE.test(input.issueId)) return false;
  const sourceId = legacyDispositionRepairSourceRunId(input.run);
  if (!sourceId || !UUID_RE.test(sourceId)) return false;
  const [source] = await db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, sourceId), eq(heartbeatRuns.companyId, input.run.companyId))).limit(1);
  if (!isBoundLegacyDispositionRepairRun(input.run, source ?? null, input.issueId)) return false;
  const [issue] = await db.select().from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.run.companyId))).limit(1);
  if (!issue) return false;
  // This run's own successful issue writes (normal API activity). No ordering
  // is used; the committed status_version baseline decides.
  const statusActivities = await db.select({
    runId: activityLog.runId, agentId: activityLog.agentId, actorType: activityLog.actorType,
    action: activityLog.action, details: activityLog.details,
  }).from(activityLog)
    .where(and(
      eq(activityLog.companyId, input.run.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.issueId),
      eq(activityLog.runId, input.run.id),
      eq(activityLog.agentId, input.run.agentId),
      eq(activityLog.action, "issue.updated"),
    ));
  if (!repairRunOwnsCurrentStatus({
    run: input.run,
    issue: { status: issue.status, statusVersion: issue.statusVersion },
    statusActivities,
  })) {
    return false;
  }
  const state = await collectDispositionRepairSourceState(db, { issue, excludeRunId: input.run.id });
  return dispositionRepairQuietEligible({
    status: issue.status,
    unblockDescriptor: issue.unblockDescriptor,
    hasDurableWaitingPath: state.hasDurableWaitingPath,
  });
}

/**
 * The issue's current durable waiting path, read from committed state, or
 * null when nothing real is waiting (descriptors never count).
 */
export async function readIssueDurableWaitingPath(
  db: Db,
  issue: { id: string; companyId: string },
): Promise<string | null> {
  const [current] = await db.select().from(issues)
    .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).limit(1);
  if (!current) return null;
  return (await collectDispositionRepairSourceState(db, { issue: current })).durablePathReason;
}

function readRunString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The run a disposition repair was scheduled from, or the run itself when it
 * is not a repair. An episode repair names its source run in the persisted
 * episode. A fingerprint repair names it in retryOfRunId. Returns null when
 * the source cannot be named without walking further.
 */
function dispositionRepairSourceRunId(run: { id: string; contextSnapshot?: unknown }): string | null {
  const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
  if (legacyDispositionRepairSourceRunId(run)) {
    const episodeId = legacyDispositionEpisode(run).id;
    return isUuidLike(episodeId) ? episodeId : null;
  }
  if (readRunString(context.dispositionRepairFingerprint)) {
    const sourceId = readRunString(context.retryOfRunId);
    return sourceId && isUuidLike(sourceId) ? sourceId : null;
  }
  return run.id;
}

/**
 * A pending question card is no longer the task's wait when the agent already
 * acted on a newer operator comment. The rule reads the issue's latest
 * assignee run, the disposition-repair source it names, and the waking
 * comment: at most three indexed lookups. The source run must be legacy and
 * succeeded, and it must have been woken (issue_commented) by a live user
 * comment. Returns that comment's creation time, or null.
 *
 * Disposition repair applies it while the issue is todo or in_progress. The
 * board's retry of an escalated repair also allows blocked, the status that
 * escalation set. Every caller uses this one helper, so recovery scheduling,
 * dispatch admission, quiet presentation and the board retry agree.
 */
export async function staleQuestionCutoffForIssue(
  db: Db,
  issue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "status" | "assigneeAgentId">,
  options: { allowBlocked?: boolean } = {},
): Promise<Date | null> {
  const statuses = options.allowBlocked ? ["todo", "in_progress", "blocked"] : ["todo", "in_progress"];
  if (!statuses.includes(issue.status) || !issue.assigneeAgentId) return null;
  const [latest] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId),
    eq(heartbeatRuns.agentId, issue.assigneeAgentId),
    sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  if (!latest) return null;
  const sourceId = dispositionRepairSourceRunId(latest);
  if (!sourceId) return null;
  const [source] = sourceId === latest.id ? [latest] : await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.id, sourceId),
  )).limit(1);
  if (!source || source.agentId !== issue.assigneeAgentId || source.runtimeMode !== "legacy" ||
      source.status !== "succeeded") return null;
  const context = source.contextSnapshot ?? {};
  if (context.issueId !== issue.id || context.wakeReason !== "issue_commented") return null;
  const commentId = deriveCommentId(context);
  if (!commentId || !isUuidLike(commentId)) return null;
  const [comment] = await db.select({ createdAt: issueComments.createdAt }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId),
    eq(issueComments.issueId, issue.id),
    eq(issueComments.id, commentId),
    eq(issueComments.authorType, "user"),
    isNotNull(issueComments.authorUserId),
    isNull(issueComments.createdByRunId),
    isNull(issueComments.deletedAt),
  )).limit(1);
  return comment?.createdAt ?? null;
}

/** Pending ask_user_questions cards older than the cutoff are not a wait. */
export function isStaleQuestion(
  row: { kind: string; createdAt: Date },
  cutoff: Date | null,
): boolean {
  return Boolean(cutoff && row.kind === "ask_user_questions" && row.createdAt.getTime() < cutoff.getTime());
}

export async function collectDispositionRepairSourceState(
  db: Db,
  input: {
    issue: DispositionRepairIssue;
    excludeRunId?: string | null;
    excludeWakeupRequestId?: string | null;
  },
): Promise<DispositionRepairSourceState> {
  const issue = input.issue;
  const [blockers, children, interactions, linkedApprovals, workProducts, activeRuns, queuedWakes] =
    await Promise.all([
      db
        .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
        .from(issueRelations)
        .innerJoin(
          issues,
          and(eq(issues.companyId, issueRelations.companyId), eq(issues.id, issueRelations.issueId)),
        )
        .where(
          and(
            eq(issueRelations.companyId, issue.companyId),
            eq(issueRelations.relatedIssueId, issue.id),
            eq(issueRelations.type, "blocks"),
            notInArray(issues.status, ["done", "cancelled"]),
            sql`${issues.hiddenAt} is null`,
          ),
        ),
      db
        .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, issue.companyId),
            eq(issues.parentId, issue.id),
            notInArray(issues.status, ["done", "cancelled"]),
            sql`${issues.hiddenAt} is null`,
          ),
        ),
      db
        .select({
          id: issueThreadInteractions.id,
          status: issueThreadInteractions.status,
          kind: issueThreadInteractions.kind,
          continuationPolicy: issueThreadInteractions.continuationPolicy,
          updatedAt: issueThreadInteractions.updatedAt,
          createdAt: issueThreadInteractions.createdAt,
        })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.companyId, issue.companyId),
            eq(issueThreadInteractions.issueId, issue.id),
            inArray(issueThreadInteractions.status, ["pending", "accepted", "answered"]),
          ),
        ),
      db
        .select({ id: approvals.id, status: approvals.status, decidedAt: approvals.decidedAt })
        .from(issueApprovals)
        .innerJoin(
          approvals,
          and(
            eq(issueApprovals.approvalId, approvals.id),
            eq(issueApprovals.companyId, approvals.companyId),
          ),
        )
        .where(
          and(
            eq(issueApprovals.companyId, issue.companyId),
            eq(approvals.companyId, issue.companyId),
            eq(issueApprovals.issueId, issue.id),
            inArray(approvals.status, ["pending", "revision_requested", "approved"]),
          ),
        ),
      db
        .select({
          id: issueWorkProducts.id,
          type: issueWorkProducts.type,
          status: issueWorkProducts.status,
          reviewState: issueWorkProducts.reviewState,
          updatedAt: issueWorkProducts.updatedAt,
        })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, issue.companyId),
            eq(issueWorkProducts.issueId, issue.id),
          ),
        ),
      db
        .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, issue.companyId),
            inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
            input.excludeRunId ? ne(heartbeatRuns.id, input.excludeRunId) : sql`true`,
          ),
        ),
      db
        .select({ id: agentWakeupRequests.id, agentId: agentWakeupRequests.agentId, status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, issue.companyId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
            input.excludeWakeupRequestId
              ? ne(agentWakeupRequests.id, input.excludeWakeupRequestId)
              : sql`true`,
          ),
        ),
    ]);

  const pendingExecutionState = parseIssueExecutionState(issue.executionState);
  // Only an ask_user_questions card can be superseded by a newer operator
  // comment. Confirmations and approvals always remain waits.
  const staleQuestionCutoff = interactions.some((row) => row.status === "pending" && row.kind === "ask_user_questions")
    ? await staleQuestionCutoffForIssue(db, issue)
    : null;
  const pendingInteraction = interactions.some((row) => row.status === "pending" &&
    !isStaleQuestion(row, staleQuestionCutoff));
  const pendingApproval = linkedApprovals.some((row) =>
    row.status === "pending" || row.status === "revision_requested",
  );
  const durablePathReason = issue.assigneeUserId
    ? "user_owner"
    : blockers.length > 0
      ? "blocker"
      : issue.monitorNextCheckAt && issue.monitorNextCheckAt.getTime() > Date.now()
        ? "monitor"
        : pendingExecutionState?.status === "pending"
          ? "execution_stage"
          : pendingInteraction
            ? "interaction"
            : pendingApproval
              ? "approval"
              : null;

  const durableState = {
    source: {
      status: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      executionPolicy: issue.executionPolicy,
      executionState: issue.executionState,
      monitorNextCheckAt: issue.monitorNextCheckAt?.toISOString() ?? null,
    },
    blockers: blockers.sort((a, b) => a.id.localeCompare(b.id)),
    children: children.sort((a, b) => a.id.localeCompare(b.id)),
    interactions: interactions
      // createdAt only filters stale questions; keep the persisted digest stable.
      .map(({ createdAt: _createdAt, ...row }) => ({ ...row, updatedAt: row.updatedAt.toISOString() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    approvals: linkedApprovals
      .map((row) => ({ ...row, decidedAt: row.decidedAt?.toISOString() ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    workProducts: workProducts
      .map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  const digest = createHash("sha256").update(stableJson(durableState)).digest("hex");

  return {
    fingerprint: `disposition_repair:v1:${digest}`,
    dependencyIssueIds: [...new Set([...blockers.map((row) => row.id), ...children.map((row) => row.id)])],
    hasActiveExecutionPath: activeRuns.length > 0 || queuedWakes.length > 0,
    hasDurableWaitingPath: durablePathReason !== null,
    durablePathReason,
  };
}
