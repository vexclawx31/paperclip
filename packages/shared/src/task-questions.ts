/**
 * Ordinary task questions are current input waits only while they still belong
 * to the current human direction. A newer non-deleted human message on the same
 * task makes an earlier ordinary question historical, without answering,
 * cancelling, or accepting it (see doc/execution-semantics.md).
 *
 * This module is the single classifier for that rule. It is presentation and
 * eligibility only: a historical question keeps its pending record and stays
 * answerable.
 */

/** Payload keys that give a question approval or credential authority. */
const GOVERNED_QUESTION_PAYLOAD_KEYS = ["toolAction", "secretProposal", "connectionAuthorization"] as const;

export interface TaskQuestionLike {
  kind: string;
  createdAt: Date | string;
  payload?: unknown;
}

export interface TaskDirectionCommentLike {
  createdAt: Date | string;
  authorType?: string | null;
  authorUserId?: string | null;
  authorAgentId?: string | null;
  createdByRunId?: string | null;
  derivedAuthorAgentId?: string | null;
  derivedCreatedByRunId?: string | null;
  derivedAuthorSource?: unknown;
  sourceTrust?: unknown;
  deletedAt?: Date | string | null;
  presentation?: { kind?: string | null } | null;
}

function toMs(value: Date | string): number {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** An `ask_user_questions` interaction without approval or credential authority. */
export function isOrdinaryTaskQuestion(interaction: TaskQuestionLike): boolean {
  if (interaction.kind !== "ask_user_questions") return false;
  const payload = interaction.payload;
  if (!payload || typeof payload !== "object") return true;
  return !GOVERNED_QUESTION_PAYLOAD_KEYS.some((key) => key in payload);
}

/**
 * A comment that establishes human direction: a live, user-authored message.
 * Agent-authored, run-attributed, derived-agent, untrusted, and system notice
 * comments do not count.
 */
export function isHumanDirectionComment(comment: TaskDirectionCommentLike): boolean {
  if (comment.deletedAt) return false;
  if (!comment.authorUserId) return false;
  if (comment.authorAgentId || comment.createdByRunId) return false;
  if (comment.derivedAuthorAgentId || comment.derivedCreatedByRunId || comment.derivedAuthorSource) return false;
  if (comment.sourceTrust) return false;
  if (comment.presentation?.kind === "system_notice") return false;
  return comment.authorType == null || comment.authorType === "user";
}

/** The newest human-direction comment on a task, if any. */
export function latestHumanDirectionComment<T extends TaskDirectionCommentLike>(comments: readonly T[]): T | null {
  let latest: T | null = null;
  for (const comment of comments) {
    if (!isHumanDirectionComment(comment)) continue;
    if (!latest || toMs(comment.createdAt) >= toMs(latest.createdAt)) latest = comment;
  }
  return latest;
}

/**
 * True when an ordinary question predates the newest human-direction comment.
 * Pass the result of `latestHumanDirectionComment` (or its `createdAt`).
 * Status is not checked here: callers decide which statuses they present.
 */
export function isHistoricalTaskQuestion(
  interaction: TaskQuestionLike,
  latestHumanDirection: TaskDirectionCommentLike | Date | string | null | undefined,
): boolean {
  if (!latestHumanDirection || !isOrdinaryTaskQuestion(interaction)) return false;
  const directionAt =
    latestHumanDirection instanceof Date || typeof latestHumanDirection === "string"
      ? latestHumanDirection
      : latestHumanDirection.createdAt;
  return toMs(interaction.createdAt) < toMs(directionAt);
}
