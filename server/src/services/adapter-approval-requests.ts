import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals } from "@paperclipai/db";
import type {
  AdapterApprovalDecision,
  AdapterApprovalDelivery,
  AdapterApprovalRequest,
} from "@paperclipai/adapter-utils";
import { logActivity } from "./activity-log.js";
import { approvalService } from "./approvals.js";
import { issueApprovalService } from "./issue-approvals.js";
import { subscribeCompanyLiveEvents } from "./live-events.js";

// Host side of AdapterExecutionContext.onApprovalRequest. An adapter (today
// hermes_gateway) hands over a provider approval request. Every request is a
// board decision: this module creates a `request_board_approval` approval,
// which surfaces in the attention inbox with Approve / Reject, links it to the
// run's issue, and waits for the board.
//
// The record must never say "Approved" for a command that did not run:
// - any exit without an in-time approve/reject (timeout, abort, error,
//   revision requested) cancels the approval;
// - an approval that lands after the deadline is closed as "too late";
// - an approval Hermes did not accept (it stopped waiting) is closed after
//   the adapter reports the failed delivery.

export const ADAPTER_APPROVAL_SOURCE = "adapter_approval_request";
// Live events wake the waiter immediately; this poll only covers decisions
// made by another server process.
const DEFAULT_FALLBACK_POLL_MS = 15_000;
const INCOMPLETE_NOTE = "This command contains redacted/truncated content; full command not shown.";

export type AdapterApprovalRequestHandlerDeps = {
  db: Db;
  companyId: string;
  agentId: string;
  agentName?: string | null;
  heartbeatRunId: string;
  adapterType: string;
  issueId: string | null;
  fallbackPollMs?: number;
  now?: () => number;
};

export function createAdapterApprovalRequestHandler(deps: AdapterApprovalRequestHandlerDeps) {
  const { db, companyId, agentId, heartbeatRunId, issueId } = deps;
  const fallbackPollMs = deps.fallbackPollMs ?? DEFAULT_FALLBACK_POLL_MS;
  const now = deps.now ?? Date.now;
  const approvalsSvc = approvalService(db);
  const issueApprovalsSvc = issueApprovalService(db);

  const auditBase = (request: AdapterApprovalRequest) => ({
    adapterType: deps.adapterType,
    providerRunId: request.providerRunId,
    requestId: request.requestId,
    commandSha256: request.commandSha256,
    commandComplete: request.commandComplete,
    command: request.command,
    description: request.description,
  });

  async function log(action: string, entityType: string, entityId: string, details: Record<string, unknown>) {
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "adapter_approval_router",
      agentId,
      runId: heartbeatRunId,
      issueId,
      action,
      entityType,
      entityId,
      details,
    });
  }

  /** Close an approved record whose approval never took effect. */
  async function closeApproved(approvalId: string, note: string) {
    const nowDate = new Date();
    await db
      .update(approvals)
      .set({ status: "cancelled", decisionNote: note, updatedAt: nowDate })
      .where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId), eq(approvals.status, "approved")));
  }

  async function findExisting(requestId: string) {
    return db
      .select()
      .from(approvals)
      .where(and(
        eq(approvals.companyId, companyId),
        eq(approvals.type, "request_board_approval"),
        sql`${approvals.payload} ->> 'source' = ${ADAPTER_APPROVAL_SOURCE}`,
        sql`${approvals.payload} ->> 'heartbeatRunId' = ${heartbeatRunId}`,
        sql`${approvals.payload} ->> 'requestId' = ${requestId}`,
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function createBoardApproval(request: AdapterApprovalRequest) {
    const timeoutMinutes = Math.max(1, Math.round(request.timeoutMs / 60_000));
    const agentLabel = deps.agentName?.trim() || "An agent";
    const created = await approvalsSvc.create(companyId, {
      type: "request_board_approval",
      // Deliberately no requestedByAgentId: approving must not queue an extra
      // wake for an agent whose run is still waiting on this answer.
      requestedByAgentId: null,
      requestedByUserId: null,
      status: "pending",
      payload: {
        title: "Approve agent command",
        summary: `${agentLabel} asked to run a command that its runtime flagged for human approval: ${request.description || "no description"}.`,
        recommendedAction: `Approve only if this exact command is intended. The run waits up to ${timeoutMinutes} minute(s); after that the command is denied.`,
        risks: [
          ...(request.commandComplete ? [] : [INCOMPLETE_NOTE]),
          "Approval applies to this single command only (choice \"once\").",
          "If the agent's runtime stops waiting first, the command does not run and this approval is closed.",
        ],
        proposedComment: `\`\`\`\n${request.command}\n\`\`\`${request.commandComplete ? "" : `\n\n${INCOMPLETE_NOTE}`}`,
        source: ADAPTER_APPROVAL_SOURCE,
        adapterType: deps.adapterType,
        agentId,
        heartbeatRunId,
        issueId,
        providerRunId: request.providerRunId,
        requestId: request.requestId,
        command: request.command,
        commandSha256: request.commandSha256,
        commandComplete: request.commandComplete,
        description: request.description,
        expiresAt: new Date(now() + request.timeoutMs).toISOString(),
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });
    await log("approval.created", "approval", created.id, {
      type: created.type,
      issueIds: issueId ? [issueId] : [],
      ...auditBase(request),
    });
    return created;
  }

  /** Resolves when the approval may have changed, the deadline passes, or the run aborts. */
  function waitForChange(approvalId: string, ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let unsubscribe = () => {};
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener("abort", done);
        resolve();
      }
      unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
        const payload = event.payload as Record<string, unknown> | undefined;
        if (event.type === "activity.logged" && payload?.entityType === "approval" && payload?.entityId === approvalId) done();
      });
      signal.addEventListener("abort", done, { once: true });
    });
  }

  function deliveryHook(request: AdapterApprovalRequest, approvalId: string, approved: boolean) {
    return async (delivery: AdapterApprovalDelivery) => {
      if (delivery.delivered) {
        await log("adapter_approval.delivered", "approval", approvalId, { ...auditBase(request), choice: delivery.choice });
        return;
      }
      if (approved) {
        await closeApproved(
          approvalId,
          `The agent's runtime was no longer waiting (${delivery.reason ?? "unknown"}); the command did not run.`,
        );
      }
      await log("adapter_approval.not_delivered", "approval", approvalId, {
        ...auditBase(request),
        choice: delivery.choice,
        reason: delivery.reason ?? null,
        closedApproval: approved,
      });
    };
  }

  async function awaitBoard(request: AdapterApprovalRequest): Promise<AdapterApprovalDecision> {
    const existing = await findExisting(request.requestId);
    if (existing && (existing.payload as Record<string, unknown>).commandSha256 !== request.commandSha256) {
      // A replayed request id with a different command must never inherit a decision.
      await log("adapter_approval.hash_mismatch", "approval", existing.id, auditBase(request));
      return { decision: "denied", decidedBy: "system", approvalId: existing.id, note: "The request id was reused for a different command." };
    }
    const approval = existing ?? await createBoardApproval(request);
    const deadline = now() + request.timeoutMs;
    let status = approval.status;
    let decisionNote = approval.decisionNote;
    let decidedAt = approval.decidedAt;
    let settled = false;
    try {
      if (!existing && issueId) {
        await issueApprovalsSvc.linkManyForApproval(approval.id, [issueId], { agentId });
      }
      while (status === "pending" && !request.signal.aborted && now() < deadline) {
        await waitForChange(approval.id, Math.min(fallbackPollMs, deadline - now()), request.signal);
        const latest = await approvalsSvc.getById(approval.id);
        if (!latest) break;
        ({ status, decisionNote, decidedAt } = latest);
      }

      if (status === "pending") {
        // Close the race with a board decision: cancel first, then re-read.
        const reason = request.signal.aborted
          ? "The agent run ended or stopped waiting before a board decision; the command was not run."
          : "No board decision before the approval timeout; the command was denied.";
        await approvalsSvc.cancel(approval.id, reason);
        const latest = await approvalsSvc.getById(approval.id);
        if (latest) ({ status, decisionNote, decidedAt } = latest);
        if (status === "cancelled") {
          settled = true;
          await log(request.signal.aborted ? "adapter_approval.abandoned" : "adapter_approval.timed_out", "approval", approval.id, {
            ...auditBase(request),
            timeoutMs: request.timeoutMs,
          });
          return request.signal.aborted
            ? { decision: "cancelled", decidedBy: "system", approvalId: approval.id, note: reason }
            : { decision: "timeout", decidedBy: "system", approvalId: approval.id, note: reason };
        }
      }

      const late = (decidedAt ? decidedAt.getTime() : now()) > deadline || request.signal.aborted;
      if (status === "approved" && late) {
        settled = true;
        const note = "Approved after the approval window closed; the command was denied and did not run.";
        await closeApproved(approval.id, note);
        await log("adapter_approval.approved_too_late", "approval", approval.id, { ...auditBase(request), timeoutMs: request.timeoutMs });
        return { decision: request.signal.aborted ? "cancelled" : "timeout", decidedBy: "system", approvalId: approval.id, note };
      }
      if (status === "approved" || status === "rejected") {
        settled = true;
        const approved = status === "approved";
        await log("adapter_approval.board_resolved", "approval", approval.id, {
          ...auditBase(request),
          approvalStatus: status,
          decision: approved ? "approved" : "denied",
        });
        return {
          decision: approved ? "approved" : "denied",
          decidedBy: "board",
          approvalId: approval.id,
          note: decisionNote ?? null,
          ...(approved ? { requestId: request.requestId, commandSha256: request.commandSha256 } : {}),
          onDelivery: deliveryHook(request, approval.id, approved),
        };
      }
      if (status === "cancelled") {
        settled = true;
        return { decision: "cancelled", decidedBy: "system", approvalId: approval.id, note: decisionNote ?? null };
      }
      // revision_requested (or anything unexpected): deny; finally closes it.
      return { decision: "denied", decidedBy: "board", approvalId: approval.id, note: decisionNote ?? "The board requested a revision; the command was denied." };
    } finally {
      if (!settled) {
        // Close the record on every other exit path, including thrown errors.
        const reason = status === "revision_requested"
          ? "Closed: the board requested a revision; agents cannot revise a runtime command."
          : "Closed without a board decision; the command was denied.";
        try {
          await approvalsSvc.cancel(approval.id, reason);
        } catch {
          // Best effort: the original outcome (or error) still propagates.
        }
      }
    }
  }

  return async function handleAdapterApprovalRequest(request: AdapterApprovalRequest): Promise<AdapterApprovalDecision> {
    if (request.timeoutMs <= 0) {
      await log("adapter_approval.timed_out", "heartbeat_run", heartbeatRunId, {
        ...auditBase(request),
        timeoutMs: 0,
        note: "No run time left to wait for a board decision.",
      });
      return { decision: "timeout", decidedBy: "system", note: "No run time left to wait for a board decision." };
    }
    return awaitBoard(request);
  };
}
