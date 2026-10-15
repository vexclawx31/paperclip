import { describe, expect, it, vi } from "vitest";
import {
  deliverAgentUnblockNotification,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
} from "../services/routable-blocked.js";

const agentId = "00000000-0000-4000-8000-000000000001";
const noWait = async () => null;

function blockedIssue(input: {
  transitionAt?: Date | null;
  notifiedAt?: Date | null;
  assigneeAgentId?: string | null;
} = {}) {
  return {
    assigneeAgentId: input.assigneeAgentId ?? null,
    id: "00000000-0000-4000-8000-000000000002",
    status: "blocked",
    unblockDescriptor: { owner: { agentId }, action: "Review the finding" } as const,
    blockedTransitionAt: input.transitionAt === undefined
      ? new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1)
      : input.transitionAt,
    blockedOwnerNotifiedAt: input.notifiedAt ?? null,
  };
}

describe("routable blocked notifications", () => {
  it("wakes the named agent and records delivery on a prospective transition", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const now = new Date("2026-07-23T18:30:00.000Z");
    const issue = blockedIssue();

    await expect(deliverAgentUnblockNotification({ issue, wakeup, markNotified, durableWaitingPath: noWait, now: () => now }))
      .resolves.toBe(true);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_unblock_requested",
      idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt!.toISOString()}`,
      payload: { issueId: issue.id, action: "Review the finding" },
    }));
    expect(markNotified).toHaveBeenCalledWith(now);
  });

  it("leaves pre-existing blocked issues untouched", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);

    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1) }),
      wakeup,
      markNotified,
      durableWaitingPath: noWait,
    })).resolves.toBe(false);
    expect(wakeup).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
  });

  it("deduplicates one transition and notifies again after a blocked flap", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const firstTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1);
    const secondTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 2);

    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: firstTransition, notifiedAt: new Date() }),
      wakeup,
      markNotified,
      durableWaitingPath: noWait,
    });
    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: secondTransition }),
      wakeup,
      markNotified,
      durableWaitingPath: noWait,
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: expect.stringContaining(secondTransition.toISOString()),
    });
  });

  it("does not tell a self-owner to act now while a real wait owns the next action (LIT-126)", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    for (const reason of ["interaction", "approval", "monitor", "blocker", "execution_stage"]) {
      await expect(deliverAgentUnblockNotification({
        issue: blockedIssue({ assigneeAgentId: agentId }),
        wakeup,
        markNotified,
        durableWaitingPath: async () => reason,
      })).resolves.toBe(false);
    }
    expect(wakeup).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();

    // Negative control: the same self-owned park with no real wait binds the action.
    await deliverAgentUnblockNotification({ issue: blockedIssue({ assigneeAgentId: agentId }), wakeup, markNotified, durableWaitingPath: noWait });
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({ contextSnapshot: { livenessContinuationState: "unblock_requested" } });
  });

  it("still routes another named agent during a real wait, without the act-now binding", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue({ assigneeAgentId: "00000000-0000-4000-8000-000000000003" }),
      wakeup,
      markNotified,
      durableWaitingPath: async () => "user_owner",
    })).resolves.toBe(true);
    const context = (wakeup.mock.calls[0] as unknown as [string, { contextSnapshot: Record<string, unknown> }])[1].contextSnapshot;
    expect(context).toEqual({ wakeReason: "issue_unblock_requested", issueId: blockedIssue().id, taskId: blockedIssue().id });
    expect(markNotified).toHaveBeenCalledTimes(1);
  });
});
