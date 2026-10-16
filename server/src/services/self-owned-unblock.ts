/**
 * An agent may only name itself as the owner of an unblock descriptor. A
 * blocked issue whose descriptor names the run's own agent therefore records
 * work that agent still has to do, not an external wait. Real waits (blocker
 * issues, pending interactions/approvals, monitors, execution stages, a user
 * owner, pause/stop/budget and recovery holds) are decided by the callers'
 * existing gates; this module only answers "is the descriptor self-owned?" and
 * binds that action into the next run's input.
 */

export const SELF_OWNED_UNBLOCK_ACTION_MAX_CHARS = 2000;
export const UNBLOCK_REQUESTED_CONTINUATION_STATE = "unblock_requested";

type DescriptorIssue = { status: string; unblockDescriptor?: unknown };

export function selfOwnedUnblockAction(issue: DescriptorIssue | null | undefined, agentId: string): string | null {
  if (!issue || issue.status !== "blocked") return null;
  const descriptor = issue.unblockDescriptor;
  if (!descriptor || typeof descriptor !== "object") return null;
  const { owner, action } = descriptor as { owner?: unknown; action?: unknown };
  if (!owner || typeof owner !== "object" || (owner as { agentId?: unknown }).agentId !== agentId) return null;
  return typeof action === "string" && action.trim() ? action.trim() : null;
}

export function boundUnblockAction(action: string): string {
  const trimmed = action.trim();
  return trimmed.length <= SELF_OWNED_UNBLOCK_ACTION_MAX_CHARS
    ? trimmed
    : `${trimmed.slice(0, SELF_OWNED_UNBLOCK_ACTION_MAX_CHARS - 3)}...`;
}

export function selfOwnedUnblockInstruction(action: string): string {
  return [
    "You are the named owner of this blocked issue's unblock action, so nothing external is waiting on it.",
    `Do this action now: ${boundUnblockAction(action)}`,
    "Do not re-block the issue on your own action. If a real external dependency exists, record it as a blocker issue, a pending interaction or an approval.",
    "Repeated self-blocking without progress escalates to the board.",
  ].join("\n");
}
