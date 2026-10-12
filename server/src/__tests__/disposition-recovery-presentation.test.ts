import { describe, expect, it } from "vitest";
import {
  DISPOSITION_ONLY_RECOVERY_QUIET_REASON,
  resolveHeartbeatRunResponse,
} from "../services/heartbeat-run-summary.js";
import {
  dispositionRepairQuietEligible,
  isBoundLegacyDispositionRepairRun,
  legacyDispositionRepairSourceRunId,
  repairRunOwnsCurrentStatus,
} from "../services/recovery/legacy-continuation.js";

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

describe("repair-run attribution from normal API status writes", () => {
  // Baseline 3 recorded at scheduling; the repair's own write made it 4.
  const repairRun = { id: "run-repair", agentId: "agent-a", contextSnapshot: { dispositionRepairIssueStatusVersion: 3 } };
  const write = { runId: "run-repair", agentId: "agent-a", actorType: "agent", action: "issue.updated", details: { status: "done" } };
  const issue = { status: "done", statusVersion: 4 };
  it("accepts the repair's own write as the single status change since scheduling", () => {
    expect(repairRunOwnsCurrentStatus({ run: repairRun, issue, statusActivities: [write] })).toBe(true);
  });
  it("does not depend on activity order", () => {
    const earlier = { ...write, details: { status: "in_progress" } };
    expect(repairRunOwnsCurrentStatus({ run: repairRun, issue, statusActivities: [earlier, write] })).toBe(true);
    expect(repairRunOwnsCurrentStatus({ run: repairRun, issue, statusActivities: [write, earlier] })).toBe(true);
  });
  it.each([
    ["no status write by the repair", [], issue, repairRun],
    ["A -> B -> A after the repair (two more changes)", [write], { status: "done", statusVersion: 6 }, repairRun],
    ["no status change at all", [write], { status: "done", statusVersion: 3 }, repairRun],
    ["status differs from the repair's write", [write], { status: "in_review", statusVersion: 4 }, repairRun],
    ["another run", [{ ...write, runId: "run-other" }], issue, repairRun],
    ["another agent", [{ ...write, agentId: "agent-b" }], issue, repairRun],
    ["board actor", [{ ...write, actorType: "user" }], issue, repairRun],
    ["non-update activity", [{ ...write, action: "issue.comment_added" }], issue, repairRun],
    ["missing baseline (older repair context)", [write], issue, { ...repairRun, contextSnapshot: {} }],
    ["string baseline", [write], issue, { ...repairRun, contextSnapshot: { dispositionRepairIssueStatusVersion: "3" } }],
  ] as const)("rejects %s", (_label, statusActivities, current, run) => {
    expect(repairRunOwnsCurrentStatus({ run, issue: current, statusActivities })).toBe(false);
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
