import { describe, expect, it } from "vitest";
import {
  DISPOSITION_ONLY_RECOVERY_QUIET_REASON,
  resolveHeartbeatRunResponse,
} from "../services/heartbeat-run-summary.js";
import {
  dispositionRepairQuietEligible,
  isBoundLegacyDispositionRepairRun,
  legacyDispositionRepairSourceRunId,
  repairRunCompletedCurrentStatus,
} from "../services/recovery/legacy-continuation.js";
import { TASK_TOOL_RECEIPT_DETAIL_KEY, TASK_TOOL_STATUS_RECEIPT_ACTIONS } from "../services/run-owned-state.js";

// Synthetic identities only.
const source = {
  id: "run-source", companyId: "company-a", agentId: "agent-a", status: "succeeded", runtimeMode: "legacy",
  contextSnapshot: { issueId: "issue-a" },
};
const repair = {
  id: "run-repair", companyId: "company-a", agentId: "agent-a", status: "succeeded", runtimeMode: "legacy",
  contextSnapshot: {
    issueId: "issue-a", taskId: "issue-a",
    source: "issue.deliberate_wait_disposition_repair",
    legacyDispositionEpisode: { id: "run-source", attempt: 1, maxAttempts: 2 },
    dispositionRepairSourceRunId: "run-source",
  },
};
const oldAnswer = "The report is ready: revenue grew 12% quarter over quarter.";
const finalMessage = (text: string) => ({ text, sourceEventId: "event-final", channel: "final" as const });

describe("disposition-only recovery presentation", () => {
  it("does not materialize a repeated old answer from a bound repair run", () => {
    const resolved = resolveHeartbeatRunResponse({
      resultJson: { summary: oldAnswer },
      finalAgentMessage: finalMessage(oldAnswer),
      dispositionOnlyRecovery: true,
    });
    expect(resolved.text).toBeNull();
    expect(resolved.decision).toMatchObject({
      chosenSource: "none", commentAction: "none",
      reasonCodes: [DISPOSITION_ONLY_RECOVERY_QUIET_REASON],
      // Private evidence: the withheld message stays addressable in run events.
      sourceEventId: "event-final",
    });
  });

  it("stays quiet regardless of wording; new information requires an explicit write", () => {
    // Suppression is not keyword equality: different prose is still bookkeeping.
    const resolved = resolveHeartbeatRunResponse({
      resultJson: {},
      finalAgentMessage: finalMessage("NEW BLOCKER: production credentials expired; operator must rotate them."),
      dispositionOnlyRecovery: true,
    });
    expect(resolved.decision.commentAction).toBe("none");
  });

  it("preserves a new material blocker the repair run explicitly commented", () => {
    const resolved = resolveHeartbeatRunResponse({
      resultJson: {},
      existingComment: { id: "comment-blocker", body: "Blocked: the vendor API now requires a signed DPA. Owner: legal." },
      finalAgentMessage: finalMessage(oldAnswer),
      dispositionOnlyRecovery: true,
    });
    expect(resolved.decision).toMatchObject({
      chosenSource: "existing_issue_comment", commentAction: "reuse", commentId: "comment-blocker",
    });
  });

  it("reuses an explicit comment already written instead of creating a duplicate", () => {
    const resolved = resolveHeartbeatRunResponse({
      resultJson: { summary: oldAnswer },
      existingComment: { id: "comment-explicit", body: oldAnswer },
      finalAgentMessage: finalMessage(oldAnswer),
      dispositionOnlyRecovery: true,
    });
    expect(resolved.decision.commentAction).toBe("reuse");
    expect(resolved.decision.commentId).toBe("comment-explicit");
  });

  it("keeps ordinary final responses", () => {
    for (const dispositionOnlyRecovery of [undefined, false]) {
      const resolved = resolveHeartbeatRunResponse({
        resultJson: {},
        finalAgentMessage: finalMessage(oldAnswer),
        dispositionOnlyRecovery,
      });
      expect(resolved.text).toBe(oldAnswer);
      expect(resolved.decision.commentAction).toBe("create");
    }
  });

  it("does not change external-chat final precedence", () => {
    const resolved = resolveHeartbeatRunResponse({
      resultJson: {},
      finalAgentMessage: finalMessage(oldAnswer),
      preferFinalResponseOverExistingComment: true,
      dispositionOnlyRecovery: true,
    });
    expect(resolved.decision.commentAction).toBe("create");
  });
});

describe("repair-run attribution by completed task-tool status receipt", () => {
  const repairRun = { id: "run-repair", agentId: "agent-a" };
  const receiptDetails = (result: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    [TASK_TOOL_RECEIPT_DETAIL_KEY]: { operation: "update_task_status", key: "k", digest: "d", state: "completed", result, ...extra },
  });
  const completed = {
    runId: "run-repair", agentId: "agent-a", actorType: "agent",
    action: TASK_TOOL_STATUS_RECEIPT_ACTIONS.completed,
    details: receiptDetails({ status: "done", statusVersion: 4 }),
  };
  const issue = { status: "done", statusVersion: 4 };
  it("accepts the repair run's own completed receipt at the exact current version", () => {
    expect(repairRunCompletedCurrentStatus({ run: repairRun, issue, receipts: [completed] })).toBe(true);
  });
  it("matches any of the run's receipts without relying on order", () => {
    const older = { ...completed, details: receiptDetails({ status: "in_review", statusVersion: 3 }) };
    expect(repairRunCompletedCurrentStatus({ run: repairRun, issue, receipts: [completed, older] })).toBe(true);
    expect(repairRunCompletedCurrentStatus({ run: repairRun, issue, receipts: [older, completed] })).toBe(true);
  });
  it.each([
    ["no receipt (crash before receipt or another lane)", [], issue],
    ["A -> B -> A after the repair (version advanced)", [completed], { status: "done", statusVersion: 6 }],
    ["status changed since", [completed], { status: "in_review", statusVersion: 5 }],
    ["another run", [{ ...completed, runId: "run-other" }], issue],
    ["another agent", [{ ...completed, agentId: "agent-b" }], issue],
    ["board actor", [{ ...completed, actorType: "user" }], issue],
    ["pending reservation", [{ ...completed, action: TASK_TOOL_STATUS_RECEIPT_ACTIONS.pending, details: receiptDetails({ status: "done", statusVersion: 4 }, { state: "pending" }) }], issue],
    ["released reservation", [{ ...completed, action: TASK_TOOL_STATUS_RECEIPT_ACTIONS.released, details: receiptDetails({}, { state: "released" }) }], issue],
    ["comment receipt", [{ ...completed, details: receiptDetails({ status: "done", statusVersion: 4 }, { operation: "add_task_comment" }) }], issue],
    ["missing version", [{ ...completed, details: receiptDetails({ status: "done", statusVersion: null }) }], issue],
    ["string version", [{ ...completed, details: receiptDetails({ status: "done", statusVersion: "4" }) }], issue],
    ["plain issue.updated activity", [{ ...completed, action: "issue.updated", details: { status: "done" } }], issue],
  ] as const)("rejects %s", (_label, receipts, current) => {
    expect(repairRunCompletedCurrentStatus({ run: repairRun, issue: current, receipts })).toBe(false);
  });
  it("requires durable structure for waiting dispositions", () => {
    expect(dispositionRepairQuietEligible({ status: "done", unblockDescriptor: null, hasDurableWaitingPath: false })).toBe(true);
    expect(dispositionRepairQuietEligible({ status: "blocked", unblockDescriptor: null, hasDurableWaitingPath: false })).toBe(false);
    expect(dispositionRepairQuietEligible({ status: "blocked", unblockDescriptor: { action: "x" }, hasDurableWaitingPath: false })).toBe(true);
    expect(dispositionRepairQuietEligible({ status: "in_review", unblockDescriptor: { action: "x" }, hasDurableWaitingPath: false })).toBe(false);
    expect(dispositionRepairQuietEligible({ status: "in_progress", unblockDescriptor: null, hasDurableWaitingPath: true })).toBe(false);
  });
});

describe("disposition repair source-run binding", () => {
  it("accepts only the server-scheduled repair bound to its own successful source", () => {
    expect(legacyDispositionRepairSourceRunId(repair)).toBe("run-source");
    expect(isBoundLegacyDispositionRepairRun(repair, source, "issue-a")).toBe(true);
  });

  it.each([
    ["foreign company source", { ...source, companyId: "company-b" }, "issue-a"],
    ["foreign agent source", { ...source, agentId: "agent-b" }, "issue-a"],
    ["foreign issue source", { ...source, contextSnapshot: { issueId: "issue-b" } }, "issue-a"],
    ["unsuccessful source", { ...source, status: "failed" }, "issue-a"],
    ["substituted source id", { ...source, id: "run-other" }, "issue-a"],
    ["missing source", null, "issue-a"],
    ["finalizing a different issue", source, "issue-b"],
    ["no issue", source, null],
  ] as const)("rejects %s", (_label, candidate, issueId) => {
    expect(isBoundLegacyDispositionRepairRun(repair, candidate, issueId)).toBe(false);
  });

  it.each([
    ["ordinary run without an episode", { ...repair, contextSnapshot: { issueId: "issue-a", dispositionRepairSourceRunId: "run-source" } }],
    ["episode from another source", { ...repair, contextSnapshot: { ...repair.contextSnapshot, legacyDispositionEpisode: { id: "run-foreign", attempt: 1, maxAttempts: 2 } } }],
    ["exhausted attempt", { ...repair, contextSnapshot: { ...repair.contextSnapshot, legacyDispositionEpisode: { id: "run-source", attempt: 3, maxAttempts: 2 } } }],
    ["unreserved attempt", { ...repair, contextSnapshot: { ...repair.contextSnapshot, legacyDispositionEpisode: { id: "run-source", attempt: 0, maxAttempts: 2 } } }],
    ["native run", { ...repair, runtimeMode: "native" }],
    ["self-referencing source", { ...repair, id: "run-source" }],
  ] as const)("rejects %s", (_label, candidate) => {
    expect(isBoundLegacyDispositionRepairRun(candidate, source, "issue-a")).toBe(false);
  });
});
