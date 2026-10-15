import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { selfOwnedUnblockInstruction, UNBLOCK_REQUESTED_CONTINUATION_STATE } from "./self-owned-unblock.js";

export const ROUTABLE_BLOCKED_ROLLOUT_AT = new Date("2026-07-23T18:13:03.000Z");

type RoutableBlockedIssue = {
  id: string;
  status: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  unblockDescriptor?: IssueUnblockDescriptor | null;
  blockedTransitionAt?: Date | null;
  blockedOwnerNotifiedAt?: Date | null;
};

type ProspectiveBlockedIssue = RoutableBlockedIssue & {
  status: "blocked";
  blockedTransitionAt: Date;
};

export function isProspectiveBlockedTransition(issue: RoutableBlockedIssue): issue is ProspectiveBlockedIssue {
  return issue.status === "blocked" &&
    Boolean(issue.blockedTransitionAt && issue.blockedTransitionAt >= ROUTABLE_BLOCKED_ROLLOUT_AT);
}

export async function deliverAgentUnblockNotification(input: {
  issue: RoutableBlockedIssue;
  wakeup: (agentId: string, options: {
    source: "automation";
    triggerDetail: "system";
    reason: "issue_unblock_requested";
    idempotencyKey: string;
    payload: { issueId: string; action: string };
    contextSnapshot: {
      wakeReason: "issue_unblock_requested";
      issueId: string;
      taskId: string;
      livenessContinuationState?: string;
      livenessContinuationInstruction?: string;
    };
  }) => Promise<unknown>;
  markNotified: (notifiedAt: Date) => Promise<unknown>;
  /**
   * The issue's current durable waiting path (blocker issue, pending
   * interaction or approval, monitor, execution stage, user owner), or null.
   * The bound "do this now" action is only true when nothing real is waiting.
   */
  durableWaitingPath: () => Promise<string | null>;
  now?: () => Date;
}) {
  const { issue } = input;
  if (!isProspectiveBlockedTransition(issue) || !issue.unblockDescriptor || issue.blockedOwnerNotifiedAt) {
    return false;
  }

  const owner = issue.unblockDescriptor.owner;
  if (owner === "board" || !("agentId" in owner)) return false;

  const waitingPath = await input.durableWaitingPath();
  const selfOwned = owner.agentId === issue.assigneeAgentId && !issue.assigneeUserId;
  // A self-owned park with a real wait is not the owner's pending work: the
  // wait owns the next action and its resolution wakes the assignee. Leave it
  // unnotified rather than send a "do this now" follow-up.
  if (waitingPath && selfOwned) return false;

  await input.wakeup(owner.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_unblock_requested",
    idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt.toISOString()}`,
    payload: { issueId: issue.id, action: issue.unblockDescriptor.action },
    // The owner's action must reach the next run's input; the payload alone is
    // a receipt and is not rendered into the wake prompt.
    // Another agent named by the board keeps its plain routing wake while a
    // real wait exists, without the "nothing external is waiting" binding.
    contextSnapshot: {
      wakeReason: "issue_unblock_requested",
      issueId: issue.id,
      taskId: issue.id,
      ...(waitingPath
        ? {}
        : {
            livenessContinuationState: UNBLOCK_REQUESTED_CONTINUATION_STATE,
            livenessContinuationInstruction: selfOwnedUnblockInstruction(issue.unblockDescriptor.action),
          }),
    },
  });
  await input.markNotified((input.now ?? (() => new Date()))());
  return true;
}
