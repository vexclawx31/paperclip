import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, issueApprovals } from "@paperclipai/db";
import type { AdapterApprovalDecision, AdapterApprovalRequest } from "@paperclipai/adapter-utils";
import { logActivity } from "./activity-log.js";
import { approvalService } from "./approvals.js";

// Host side of AdapterExecutionContext.onApprovalRequest. An adapter (today
// hermes_gateway) hands over a classified provider approval request; this
// module owns the durable decision record and its audit trail:
//
// - route "supervisor" (yellow tier only): approve under the delegated
//   supervisor policy, after checking the supervisor is a live agent in the
//   same company and is not the requesting agent. No LLM call: the policy is
//   the supervisor's authority. Logged as an activity entry.
// - route "board" (red tier, or a supervisor that cannot be used): create a
//   `request_board_approval` approval, which surfaces in the attention inbox
//   with Approve / Reject, link it to the run's issue, and wait for the board.
//   A timeout or an ended run cancels the approval and fails closed.

export const ADAPTER_APPROVAL_SOURCE = "adapter_approval_request";
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export type AdapterApprovalRequestHandlerDeps = {
  db: Db;
  companyId: string;
  agentId: string;
  agentName?: string | null;
  heartbeatRunId: string;
  adapterType: string;
  issueId: string | null;
  pollIntervalMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
};

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createAdapterApprovalRequestHandler(deps: AdapterApprovalRequestHandlerDeps) {
  const { db, companyId, agentId, heartbeatRunId, issueId } = deps;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const approvalsSvc = approvalService(db);

  const auditBase = (request: AdapterApprovalRequest) => ({
    adapterType: deps.adapterType,
    providerRunId: request.providerRunId,
    requestId: request.requestId,
    tier: request.tier,
    reasons: request.reasons,
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

  async function usableSupervisor(supervisorAgentId: string | null | undefined): Promise<string | null> {
    if (!supervisorAgentId || supervisorAgentId === agentId) return null;
    const row = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, supervisorAgentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null)
      .catch(() => null);
    if (!row || row.status === "terminated" || row.status === "pending_approval") return null;
    return row.id;
  }

  async function approveUnderSupervisorPolicy(request: AdapterApprovalRequest, supervisorAgentId: string): Promise<AdapterApprovalDecision> {
    const note = "approved under delegated supervisor policy";
    await log("adapter_approval.supervisor_approved", "heartbeat_run", heartbeatRunId, {
      ...auditBase(request),
      supervisorAgentId,
      policy: note,
    });
    return { decision: "approved", decidedBy: "supervisor_policy", supervisorAgentId, note };
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

  async function createBoardApproval(request: AdapterApprovalRequest, routingNote: string | null) {
    const existing = await findExisting(request.requestId);
    if (existing) return existing;
    const timeoutMinutes = Math.max(1, Math.round(request.timeoutMs / 60_000));
    const agentLabel = deps.agentName?.trim() || "An agent";
    const [created] = await db
      .insert(approvals)
      .values({
        companyId,
        type: "request_board_approval",
        // Deliberately no requestedByAgentId: approving must not queue an
        // extra wake for an agent whose run is still waiting on this answer.
        requestedByAgentId: null,
        requestedByUserId: null,
        status: "pending",
        payload: {
          title: `Approve agent command (${request.tier} tier)`,
          summary: `${agentLabel} asked to run a command that its runtime flagged for human approval: ${request.description || "no description"}.`,
          recommendedAction: `Approve only if this exact command is intended. The run waits up to ${timeoutMinutes} minute(s); after that the command is denied.`,
          risks: [
            `Classifier reasons: ${request.reasons.join(", ") || "none"}.`,
            "Approval applies to this single command only (choice \"once\").",
            ...(routingNote ? [routingNote] : []),
          ],
          proposedComment: `\`\`\`\n${request.command}\n\`\`\``,
          source: ADAPTER_APPROVAL_SOURCE,
          adapterType: deps.adapterType,
          agentId,
          heartbeatRunId,
          issueId,
          providerRunId: request.providerRunId,
          requestId: request.requestId,
          tier: request.tier,
          reasons: request.reasons,
          command: request.command,
          description: request.description,
          expiresAt: new Date(now() + request.timeoutMs).toISOString(),
        },
      })
      .returning();
    if (issueId) {
      await db
        .insert(issueApprovals)
        .values({ companyId, issueId, approvalId: created.id, linkedByAgentId: agentId })
        .onConflictDoNothing();
    }
    await log("approval.created", "approval", created.id, {
      type: created.type,
      issueIds: issueId ? [issueId] : [],
      ...auditBase(request),
    });
    return created;
  }

  async function awaitBoard(request: AdapterApprovalRequest, routingNote: string | null): Promise<AdapterApprovalDecision> {
    const approval = await createBoardApproval(request, routingNote);
    const deadline = now() + request.timeoutMs;
    let status = approval.status;
    let decisionNote = approval.decisionNote;
    while (status === "pending") {
      if (request.signal.aborted || now() >= deadline) break;
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())), request.signal);
      const latest = await approvalsSvc.getById(approval.id);
      if (!latest) break;
      status = latest.status;
      decisionNote = latest.decisionNote;
    }

    if (status === "approved" || status === "rejected" || status === "revision_requested" || status === "cancelled") {
      const decision: AdapterApprovalDecision["decision"] =
        status === "approved" ? "approved" : status === "cancelled" ? "cancelled" : "denied";
      await log("adapter_approval.board_resolved", "approval", approval.id, {
        ...auditBase(request),
        approvalStatus: status,
        decision,
      });
      return { decision, decidedBy: "board", approvalId: approval.id, note: decisionNote ?? null };
    }

    const aborted = request.signal.aborted;
    const reason = aborted
      ? "The agent run ended before a board decision; the command was not run."
      : "No board decision before the approval timeout; the command was denied.";
    await approvalsSvc.cancel(approval.id, reason);
    // The board may have decided in the same instant; honour that decision.
    const final = await approvalsSvc.getById(approval.id);
    if (final && (final.status === "approved" || final.status === "rejected")) {
      return {
        decision: final.status === "approved" ? "approved" : "denied",
        decidedBy: "board",
        approvalId: approval.id,
        note: final.decisionNote ?? null,
      };
    }
    await log(aborted ? "adapter_approval.abandoned" : "adapter_approval.timed_out", "approval", approval.id, {
      ...auditBase(request),
      timeoutMs: request.timeoutMs,
    });
    return { decision: aborted ? "cancelled" : "timeout", decidedBy: "system", approvalId: approval.id, note: reason };
  }

  return async function handleAdapterApprovalRequest(request: AdapterApprovalRequest): Promise<AdapterApprovalDecision> {
    let routingNote: string | null = null;
    if (request.route === "supervisor") {
      // Defense in depth: the host never delegates a red request.
      if (request.tier !== "yellow") {
        routingNote = "Red-tier requests are never delegated to a supervisor.";
      } else {
        const supervisorAgentId = await usableSupervisor(request.supervisorAgentId);
        if (supervisorAgentId) return approveUnderSupervisorPolicy(request, supervisorAgentId);
        routingNote = "The configured approval supervisor is not an active agent in this company, so the board decides.";
      }
    }
    if (request.timeoutMs <= 0) {
      await log("adapter_approval.timed_out", "heartbeat_run", heartbeatRunId, {
        ...auditBase(request),
        timeoutMs: 0,
        note: "No run time left to wait for a board decision.",
      });
      return { decision: "timeout", decidedBy: "system", note: "No run time left to wait for a board decision." };
    }
    return awaitBoard(request, routingNote);
  };
}
