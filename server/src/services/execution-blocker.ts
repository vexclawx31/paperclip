import { and, desc, eq, gt, inArray, not, or, sql } from "drizzle-orm";
import { conversationRecoveryActionPredicate, getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { z } from "zod";
import { heartbeatRuns, issueComments, issues, issueRecoveryActions, type Db } from "@paperclipai/db";
import { EXECUTION_RECONCILIATION_CAUSES, type ExecutionBlocker } from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

/**
 * A hold on a stopped review-stage participant continues in review, not as a
 * hand-back to the assignee. Returns the reviewer only while that reviewer is
 * still the pending stage's current participant.
 */
export function reviewerReconciliationTarget(
  evidence: Record<string, unknown>,
  issue: Pick<typeof issues.$inferSelect, "status" | "executionState">,
): string | null {
  const reviewerId = evidence.reviewParticipantAgentId;
  if (typeof reviewerId !== "string" || issue.status !== "in_review") return null;
  const state = parseIssueExecutionState(issue.executionState);
  return state?.status === "pending" && state.currentParticipant?.type === "agent" &&
    state.currentParticipant.agentId === reviewerId ? reviewerId : null;
}

/** Resolved recovery bookkeeping can still carry an effective no-replay hold. */
export function executionBlockerPredicate() {
  return and(
    not(conversationRecoveryActionPredicate()!),
    inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
    or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`),
  );
}

export async function getExecutionBlocker(db: Db, companyId: string, issueId: string, options?: { conversationResetCommentId?: string | null }): Promise<ExecutionBlocker | null> {
  const [conversation] = await db.select({ agentId: issues.conversationAgentId,
    boundaryId: issues.conversationBoundaryCommentId, status: issues.status,
    executionState: issues.executionState }).from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId),
  )).limit(1);
  // Resetting model context cannot make an unsafe workspace safe. This hold
  // survives conversation boundaries until the existing repair/reconciliation path clears it.
  const [restoreHold] = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId),
    eq(issueRecoveryActions.sourceIssueId, issueId),
    executionBlockerPredicate(),
    sql`${issueRecoveryActions.evidence}->>'workspaceRestoreFailure' = 'restore_unsafe_archive'`,
  )).orderBy(desc(issueRecoveryActions.updatedAt)).limit(1);
  // A persisted user /new is an ordered context command, not a retry of uncertain work.
  // The normal issue execution lock still serializes it behind any active turn.
  if (!restoreHold && conversation?.agentId && options?.conversationResetCommentId) {
    const [command] = await db.select().from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.id, options.conversationResetCommentId),
    )).limit(1);
    if (command?.authorUserId && !command.deletedAt && command.body.trim() === "/new") return null;
  }
  const [boundary] = conversation?.agentId && conversation.boundaryId
    ? await db.select({ createdAt: issueComments.createdAt }).from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.id, conversation.boundaryId),
    )).limit(1) : [];

  const ownership = await getConversationOwnershipBlocker(db, companyId, issueId);
  if (ownership) return { ...ownership, recoveryActionId: null };
  const [action] = restoreHold ? [restoreHold] : await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId),
    eq(issueRecoveryActions.sourceIssueId, issueId),
    executionBlockerPredicate(),
    boundary ? gt(issueRecoveryActions.createdAt, boundary.createdAt) : undefined,
  )).orderBy(desc(issueRecoveryActions.updatedAt), desc(issueRecoveryActions.id)).limit(1);
  if (!action) return null;
  const parsedRunId = z.string().guid().safeParse(action.evidence.runId ?? action.evidence.sourceRunId);
  const runId = parsedRunId.success ? parsedRunId.data : null;
  const [run] = runId ? await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId),
  )).limit(1) : [];

  return {
    recoveryActionId: action.id,
    runId,
    // A stopped reviewer can differ from the task owner who receives the work back.
    agentId: run?.agentId ?? null,
    cause: action.cause,
    nextAction: action.nextAction,
    continueStatus: conversation && reviewerReconciliationTarget(action.evidence, conversation) ? "in_review" : "todo",
    workspaceRepairRequired: action.evidence.workspaceRestoreFailure === "restore_unsafe_archive",
  };
}
