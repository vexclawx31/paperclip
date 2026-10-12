import { createHash } from "node:crypto";

/** This contract deliberately has no narrative, liveness label or progress count. */
export interface LegacyContinuationInput {
  run: { id: string; companyId: string; agentId: string; status: string; runtimeMode?: string | null };
  issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null; assigneeUserId?: string | null } | null;
  agent: { id: string; companyId: string; status: string } | null;
  episode: LegacyDispositionEpisode;
  gates: {
    stopped: boolean;
    paused: boolean;
    budgetBlocked: boolean;
    pendingWait: boolean;
    activeExecution: boolean;
    ownedLifecycle: boolean;
    conversation: boolean;
    agentInvokable: boolean;
  };
}
export interface LegacyDispositionEpisode {
  id: string;
  attempt: number;
  maxAttempts: number;
}
export const LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS = 2;
export const LEGACY_DISPOSITION_REPAIR_INSTRUCTION =
  "The previous task run ended without a recorded disposition or an owned next execution path. " +
  "Re-read the current task state. Use Paperclip tools/API to record completion, a real blocker, " +
  "a question or approval request, or a supported next execution path. " +
  "A final message alone does not record disposition. This is a disposition-only recovery, not another user conversation turn. " +
  "Do not repeat the previous answer or restate the existing blocker in a comment. " +
  "When the prior answer already explains the outcome, save the lifecycle fields without a comment; keep recovery evidence in the resolution record. " +
  "Comment only for a new material blocker, changed outcome, or concrete human action not already communicated. " +
  "Respect Stop, pause, budget and approval gates.";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
export function legacyDispositionEpisode(run: {
  id: string;
  contextSnapshot?: unknown;
  continuationAttempt?: number | null;
}): LegacyDispositionEpisode {
  const context = record(run.contextSnapshot);
  const episode = record(context.legacyDispositionEpisode);
  if (typeof episode.id === "string" && episode.id) {
    return { id: episode.id, attempt: count(episode.attempt), maxAttempts: Math.max(1, Math.min(LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS, count(episode.maxAttempts) || LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS)) };
  }
  // Pre-upgrade repairs have already consumed their old (possibly tighter)
  // allowance. A classifier/key migration must not grant them a fresh budget.
  const handoff = context.wakeReason === "finish_successful_run_handoff" || context.handoffRequired === true;
  const oldRecovery = context.source === "issue.productive_terminal_continuation_recovery";
  const attempt = Math.max(count(run.continuationAttempt), count(context.livenessContinuationAttempt), count(context.dispositionRepairAttempt), handoff ? count(context.handoffAttempt) || 1 : 0, oldRecovery ? 1 : 0);
  return {
    id: typeof context.dispositionRepairFingerprint === "string" ? context.dispositionRepairFingerprint : typeof context.livenessContinuationSourceRunId === "string" ? context.livenessContinuationSourceRunId : run.id,
    attempt,
    maxAttempts: handoff || oldRecovery ? 1 : LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS,
  };
}
type BindingRun = { id: string; companyId: string; agentId: string; status?: string | null; runtimeMode?: string | null; contextSnapshot?: unknown };
function runIssueId(run: BindingRun) {
  const context = record(run.contextSnapshot);
  const value = context.issueId ?? context.taskId;
  return typeof value === "string" && value ? value : null;
}
/** Source run of a persisted legacy repair; the same fallback dispatch admission uses. */
export function legacyDispositionRepairSourceRunId(run: { contextSnapshot?: unknown }): string | null {
  const context = record(run.contextSnapshot);
  if (!(typeof record(context.legacyDispositionEpisode).id === "string" && record(context.legacyDispositionEpisode).id)) return null;
  const sourceId = context.dispositionRepairSourceRunId ?? context.retryOfRunId;
  return typeof sourceId === "string" && sourceId ? sourceId : null;
}
/**
 * True only for a server-scheduled disposition-only repair run whose persisted
 * episode is bound to a successful source run of the same company, agent and
 * issue. Context is server-owned; provider text is never consulted.
 */
export function isBoundLegacyDispositionRepairRun(run: BindingRun, source: BindingRun | null, issueId: string | null): boolean {
  const sourceId = legacyDispositionRepairSourceRunId(run);
  if (!sourceId || !issueId || !source || run.runtimeMode === "native") return false;
  const episode = legacyDispositionEpisode(run);
  return source.id === sourceId && source.id !== run.id &&
    source.companyId === run.companyId && source.agentId === run.agentId &&
    source.status === "succeeded" &&
    runIssueId(run) === issueId && runIssueId(source) === issueId &&
    legacyDispositionEpisode(source).id === episode.id &&
    episode.attempt >= 1 && episode.attempt <= episode.maxAttempts;
}
/**
 * Attribution from committed state that the normal issue API already
 * produces, without activity ordering (route activity can be written after the
 * issue commit, so its order is not transition order):
 *  - `dispositionRepairIssueStatusVersion` is the issue's `status_version`
 *    when recovery scheduled this repair (server-owned context). A database
 *    trigger bumps it on every status change, and re-asserting blocked bumps
 *    it too, so `current === baseline + 1` proves exactly one status change in
 *    the repair window. A -> B -> A, or any extra change, fails.
 *  - The repair run itself logged a successful `issue.updated` with the
 *    current status (only successful writes are logged).
 * Anything else (no baseline, other runs or agents, more or fewer changes)
 * shows the prose. Residual: if another actor made the single change and the
 * repair re-sent the same status without a bump, the two agree on the
 * disposition and the repair stays quiet.
 */
export function repairRunOwnsCurrentStatus(input: {
  run: { id: string; agentId: string; contextSnapshot?: unknown };
  issue: { status: string; statusVersion: number };
  statusActivities: ReadonlyArray<{ runId: string | null; agentId: string | null; actorType: string; action: string; details: unknown }>;
}): boolean {
  const baseline = record(input.run.contextSnapshot).dispositionRepairIssueStatusVersion;
  if (typeof baseline !== "number" || !Number.isSafeInteger(baseline)) return false;
  if (input.issue.statusVersion !== baseline + 1) return false;
  return input.statusActivities.some((row) =>
    row.actorType === "agent" &&
    row.runId === input.run.id &&
    row.agentId === input.run.agentId &&
    row.action === "issue.updated" &&
    record(row.details).status === input.issue.status);
}
/**
 * A bound repair may stay quiet only after it recorded a durable disposition:
 * a terminal status, or a waiting status backed by structured evidence
 * (blocker relation, unblock descriptor, pending interaction/approval, user
 * owner, monitor or execution stage). Without that, its closing prose may be
 * the only record of a new blocker or required human action, so it is shown.
 */
export function dispositionRepairQuietEligible(input: {
  status: string;
  unblockDescriptor: unknown;
  hasDurableWaitingPath: boolean;
}): boolean {
  if (input.status === "done" || input.status === "cancelled") return true;
  if (input.status === "blocked") return input.hasDurableWaitingPath || input.unblockDescriptor != null;
  if (input.status === "in_review") return input.hasDurableWaitingPath;
  return false;
}
export function legacyDispositionFingerprint(companyId: string, issueId: string, agentId: string, episodeId: string) {
  return `legacy_disposition:v1:${createHash("sha256").update(JSON.stringify([companyId, issueId, agentId, episodeId])).digest("hex")}`;
}
export function decideLegacyContinuation(input: LegacyContinuationInput):
  | { kind: "skip"; reason: string }
  | { kind: "exhausted"; attempt: number; maxAttempts: number }
  | { kind: "enqueue"; nextAttempt: number; idempotencyKey: string; instruction: string } {
  const { run, issue, agent, gates, episode } = input;
  if (run.runtimeMode === "native") return { kind: "skip", reason: "native_finalization" };
  if (run.status !== "succeeded") return { kind: "skip", reason: "run_not_successful" };
  if (!issue || !agent || issue.companyId !== run.companyId || agent.companyId !== run.companyId || agent.id !== run.agentId) return { kind: "skip", reason: "invalid_binding" };
  if (issue.assigneeAgentId !== run.agentId || issue.assigneeUserId) return { kind: "skip", reason: "owner_changed" };
  if (!["todo", "in_progress"].includes(issue.status)) return { kind: "skip", reason: "recorded_disposition" };
  for (const [blocked, reason] of [
    [gates.stopped, "stopped"], [gates.paused, "paused"],
    [gates.budgetBlocked, "budget_blocked"], [gates.pendingWait, "durable_wait"],
    [gates.activeExecution, "existing_execution"], [gates.ownedLifecycle, "owned_lifecycle"],
    [gates.conversation, "conversation"],
    [!gates.agentInvokable || ["paused", "terminated", "pending_approval"].includes(agent.status), "agent_not_invokable"],
  ] as const) if (blocked) return { kind: "skip", reason };
  if (episode.attempt >= episode.maxAttempts) return { kind: "exhausted", attempt: episode.attempt, maxAttempts: episode.maxAttempts };
  const nextAttempt = episode.attempt + 1;
  return {
    kind: "enqueue", nextAttempt,
    idempotencyKey: `issue_disposition_repair:${issue.id}:${legacyDispositionFingerprint(run.companyId, issue.id, run.agentId, episode.id)}:${nextAttempt}`,
    instruction: LEGACY_DISPOSITION_REPAIR_INSTRUCTION,
  };
}
