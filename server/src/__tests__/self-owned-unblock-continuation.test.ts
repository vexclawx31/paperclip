import { describe, expect, it, vi } from "vitest";
import { shouldQueueFollowupForRunningIssueWake } from "../services/heartbeat.ts";
import {
  deliverAgentUnblockNotification,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
} from "../services/routable-blocked.js";
import { classifyRunLiveness } from "../services/run-liveness.ts";
import { decideRunLivenessContinuation } from "../services/run-continuations.ts";
import {
  decideLegacyContinuation,
  selfUnblockFollowupContext,
  type LegacyContinuationInput,
} from "../services/recovery/legacy-continuation.js";
import {
  SELF_OWNED_UNBLOCK_ACTION_MAX_CHARS,
  selfOwnedUnblockAction,
  selfOwnedUnblockInstruction,
  UNBLOCK_REQUESTED_CONTINUATION_STATE,
} from "../services/self-owned-unblock.js";
import {
  inheritedSelfUnblockBinding,
  SELF_UNBLOCK_CONTINUATION_STATE,
} from "../modules/wake-queue/domain/context.js";

// Regression coverage for LIT-119. An agent may only name itself as the owner
// of an unblock descriptor, so a self-owned descriptor means "I still have to
// do this", not "something external is waiting". These tests pin the three
// deterministic seams that turned that into a terminal park:
//   1. the self-unblock wake coalesced into the exiting same-issue run,
//   2. the liveness/continuation classifiers treated status=blocked as a wait,
//   3. the wake carried no action into the next run's input.

const agentId = "00000000-0000-4000-8000-000000000001";
const otherAgentId = "00000000-0000-4000-8000-000000000009";
const issueId = "00000000-0000-4000-8000-000000000002";
const action = "Reconcile the B1/B2 findings into the roadmap document";

function selfParkedIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId: "company",
    status: "blocked",
    assigneeAgentId: agentId,
    unblockDescriptor: { owner: { agentId }, action },
    ...overrides,
  };
}

describe("same-issue self-unblock follow-up (MUST 1)", () => {
  it("queues a follow-up instead of coalescing into the running same-issue run", () => {
    expect(shouldQueueFollowupForRunningIssueWake({
      contextSnapshot: { wakeReason: "issue_unblock_requested", issueId },
      wakeCommentId: null,
    })).toBe(true);
  });

  it("puts the bounded unblock action into the wake input, not only the payload", async () => {
    const wakeup = vi.fn(async () => undefined);
    const longAction = `${action}\n${"x".repeat(5_000)}`;
    await deliverAgentUnblockNotification({
      issue: {
        id: issueId,
        status: "blocked",
        unblockDescriptor: { owner: { agentId }, action: longAction },
        blockedTransitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1),
        blockedOwnerNotifiedAt: null,
      },
      wakeup,
      markNotified: async () => undefined,
    });
    const options = (wakeup.mock.calls[0] as unknown as [string, { contextSnapshot: Record<string, unknown> }])[1];
    const instruction = String(options.contextSnapshot.livenessContinuationInstruction ?? "");
    expect(instruction).toContain(action);
    expect(instruction.length).toBeLessThanOrEqual(SELF_OWNED_UNBLOCK_ACTION_MAX_CHARS + 600);
    expect(options.contextSnapshot.livenessContinuationState).toBe("unblock_requested");
    // The payload remains the unbounded source of truth for receipts.
    expect((options as unknown as { payload: { action: string } }).payload.action).toBe(longAction);
  });

  it("carries the bounded episode forward so repeated self-parks cannot loop", () => {
    const first = selfUnblockFollowupContext({ id: "run-0", contextSnapshot: { issueId }, continuationAttempt: 0 });
    expect(first).toMatchObject({ livenessContinuationSourceRunId: "run-0", livenessContinuationAttempt: 1 });
    const second = selfUnblockFollowupContext({
      id: "run-1",
      contextSnapshot: { issueId, ...first },
      continuationAttempt: 1,
    });
    expect(second).toMatchObject({ livenessContinuationSourceRunId: "run-0", livenessContinuationAttempt: 2 });
    // At the cap no further self-wake follow-up is queued; the legacy/native
    // continuation decision then reports exhaustion and escalates instead.
    expect(selfUnblockFollowupContext({
      id: "run-2",
      contextSnapshot: { issueId, ...second },
      continuationAttempt: 2,
    })).toBeNull();
  });
});

describe("self-owned descriptor is not an external wait (MUST 2)", () => {
  it("recognises only the run agent's own descriptor on a blocked issue", () => {
    expect(selfOwnedUnblockAction(selfParkedIssue(), agentId)).toBe(action);
    expect(selfOwnedUnblockAction(selfParkedIssue(), otherAgentId)).toBeNull();
    expect(selfOwnedUnblockAction(selfParkedIssue({ unblockDescriptor: { owner: "board", action } }), agentId)).toBeNull();
    expect(selfOwnedUnblockAction(selfParkedIssue({ unblockDescriptor: { owner: { userId: "u" }, action } }), agentId)).toBeNull();
    expect(selfOwnedUnblockAction(selfParkedIssue({ status: "in_progress" }), agentId)).toBeNull();
    expect(selfOwnedUnblockAction(selfParkedIssue({ unblockDescriptor: null }), agentId)).toBeNull();
  });

  const evidence = { issueCommentsCreated: 1, activityEventsCreated: 2, latestEvidenceAt: new Date() };

  it("classifies a self-park as pending own work, not blocked and not advanced-by-comment", () => {
    const classification = classifyRunLiveness({
      runStatus: "succeeded",
      issue: { status: "blocked", title: "t", description: null, selfOwnedUnblockAction: action },
      resultJson: { summary: "Restored the issue to blocked. Vex owns the reconciliation." },
      issueCommentBodies: ["Blocked with an exact Vex-owned unblock action. Waiting on approval."],
      evidence,
    });
    expect(classification.livenessState).toBe("plan_only");
    expect(classification.nextAction).toBe(action);
  });

  it("keeps a real blocked wait classified as blocked", () => {
    const classification = classifyRunLiveness({
      runStatus: "succeeded",
      issue: { status: "blocked", title: "t", description: null, selfOwnedUnblockAction: null },
      resultJson: { summary: "Waiting on the dependency." },
      evidence,
    });
    expect(classification.livenessState).toBe("blocked");
  });

  it("does not treat a failed run on a self-parked issue as progress", () => {
    const classification = classifyRunLiveness({
      runStatus: "failed",
      issue: { status: "blocked", title: "t", description: null, selfOwnedUnblockAction: action },
      errorCode: "hermes_gateway_protocol_error",
      evidence,
    });
    expect(classification.livenessState).toBe("failed");
  });

  const legacyInput: LegacyContinuationInput = {
    run: { id: "run", companyId: "company", agentId, status: "succeeded", runtimeMode: "legacy" },
    issue: selfParkedIssue(),
    agent: { id: agentId, companyId: "company", status: "idle" },
    episode: { id: "run", attempt: 0, maxAttempts: 2 },
    gates: { stopped: false, paused: false, budgetBlocked: false, pendingWait: false, activeExecution: false, ownedLifecycle: false, conversation: false, agentInvokable: true },
  };

  it("legacy (Hermes) continuation continues a self-park with the action bound", () => {
    const decision = decideLegacyContinuation(legacyInput);
    expect(decision).toMatchObject({ kind: "enqueue", nextAttempt: 1 });
    if (decision.kind !== "enqueue") throw new Error("expected enqueue");
    expect(decision.instruction).toContain(action);
  });

  it("legacy continuation exhausts a repeated self-park instead of looping", () => {
    expect(decideLegacyContinuation({ ...legacyInput, episode: { ...legacyInput.episode, attempt: 2 } }).kind).toBe("exhausted");
  });

  it.each([
    ["real dependency/interaction/approval/monitor", "pendingWait"],
    ["explicit pause", "paused"],
    ["operator stop/cancel", "stopped"],
    ["budget", "budgetBlocked"],
    ["recovery hold", "ownedLifecycle"],
    ["live execution", "activeExecution"],
  ] as const)("legacy continuation respects %s", (_label, gate) => {
    expect(decideLegacyContinuation({ ...legacyInput, gates: { ...legacyInput.gates, [gate]: true } }).kind).toBe("skip");
  });

  it.each([
    ["board-owned", { owner: "board", action }],
    ["user-owned", { owner: { userId: "u" }, action }],
    ["other agent-owned", { owner: { agentId: otherAgentId }, action }],
    ["no descriptor", null],
  ])("legacy continuation leaves a %s blocked issue parked", (_label, unblockDescriptor) => {
    expect(decideLegacyContinuation({ ...legacyInput, issue: selfParkedIssue({ unblockDescriptor }) }).kind).toBe("skip");
  });

  const nativeArgs = {
    run: { id: "run", companyId: "company", agentId, continuationAttempt: 0 } as never,
    agent: { id: agentId, companyId: "company", status: "idle" } as never,
    livenessState: "plan_only" as const,
    livenessReason: "self-owned park",
    nextAction: action,
    budgetBlocked: false,
    idempotentWakeExists: false,
  };

  it("native continuation continues a self-park only when the caller proved no real wait", () => {
    const issue = { ...selfParkedIssue(), identifier: "LIT-1", title: "t", executionState: null, projectId: null } as never;
    expect(decideRunLivenessContinuation({ ...nativeArgs, issue, selfParkedOnOwnUnblockAction: true }).kind).toBe("enqueue");
    expect(decideRunLivenessContinuation({ ...nativeArgs, issue, selfParkedOnOwnUnblockAction: false }).kind).toBe("skip");
    expect(decideRunLivenessContinuation({
      ...nativeArgs,
      run: { ...(nativeArgs.run as object), continuationAttempt: 2 } as never,
      issue,
      selfParkedOnOwnUnblockAction: true,
    }).kind).toBe("exhausted");
  });
});

describe("failed self-unblock follow-up keeps its action through immediate recovery (LIT-120)", () => {
  const instruction = selfOwnedUnblockInstruction(action);
  const bound = { livenessContinuationState: UNBLOCK_REQUESTED_CONTINUATION_STATE, livenessContinuationInstruction: instruction };

  it("uses the same continuation state as the unblock wake", () => {
    expect(SELF_UNBLOCK_CONTINUATION_STATE).toBe(UNBLOCK_REQUESTED_CONTINUATION_STATE);
  });

  it("carries only the exact bound state and instruction from an unsuccessful run", () => {
    for (const status of ["failed", "timed_out", "interrupted", "cancelled"]) {
      expect(inheritedSelfUnblockBinding({ status, contextSnapshot: { ...bound, issueId, livenessContinuationAttempt: 2, modelProfile: "x" } }))
        .toEqual(bound);
    }
  });

  it("does not re-deliver after success, without a binding, or for an oversized instruction", () => {
    expect(inheritedSelfUnblockBinding({ status: "succeeded", contextSnapshot: bound })).toEqual({});
    expect(inheritedSelfUnblockBinding({ status: "failed", contextSnapshot: { livenessContinuationInstruction: instruction } })).toEqual({});
    expect(inheritedSelfUnblockBinding({ status: "failed", contextSnapshot: { ...bound, livenessContinuationState: "plan_only" } })).toEqual({});
    expect(inheritedSelfUnblockBinding({ status: "failed", contextSnapshot: { ...bound, livenessContinuationInstruction: "x".repeat(4001) } })).toEqual({});
  });
});
