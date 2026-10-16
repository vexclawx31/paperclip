import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals } from "@paperclipai/db";
import type { AdapterApprovalDecision, AdapterApprovalRequest } from "@paperclipai/adapter-utils";
import { logActivity } from "./activity-log.js";
import { approvalService } from "./approvals.js";
import { issueApprovalService } from "./issue-approvals.js";
import { subscribeCompanyLiveEvents } from "./live-events.js";

// Host side of AdapterExecutionContext.onApprovalRequest. An adapter (today
// hermes_gateway) hands over a classified provider approval request; this
// module owns the durable decision record and its audit trail:
//
// - route "supervisor": approve under the delegated supervisor policy, only
//   for a yellow request whose whole command matched known-safe categories
//   and is shown in full, and only when the supervisor (a board-only
//   adapterConfig key) is an idle or running agent in the same company and is
//   not the requesting agent. No LLM call: the policy is the authority.
// - route "board" (everything else): create a `request_board_approval`
//   approval, which surfaces in the attention inbox with Approve / Reject,
//   link it to the run's issue, and wait for the board. Any exit without an
//   approve/reject decision (timeout, abort, error, revision requested)
//   cancels the approval so it never lingers in the inbox.

export const ADAPTER_APPROVAL_SOURCE = "adapter_approval_request";
export const SUPERVISOR_SAFE_CATEGORIES = new Set(["git", "package_install", "test_build_lint", "workspace_files"]);
const USABLE_SUPERVISOR_STATUSES = new Set(["idle", "running"]);
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
    tier: request.tier,
    reasons: request.reasons,
    categories: request.categories,
    commandSha256: request.commandSha256,
    commandComplete: request.commandComplete,
    command: request.command,
    description: request.description,
  });

  const echo = (request: AdapterApprovalRequest) => ({ requestId: request.requestId, commandSha256: request.commandSha256 });

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

  function delegable(request: AdapterApprovalRequest): string | null {
    if (request.tier !== "yellow") return "Red-tier requests are never delegated to a supervisor.";
    if (!request.commandComplete) return INCOMPLETE_NOTE;
    if (request.categories.length === 0 || !request.categories.every((category) => SUPERVISOR_SAFE_CATEGORIES.has(category))) {
      return "The command did not match a known-safe category.";
    }
    return null;
  }

  async function usableSupervisor(supervisorAgentId: string | null | undefined): Promise<string | null> {
    if (!supervisorAgentId || supervisorAgentId === agentId) return null;
    const row = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, supervisorAgentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row || !USABLE_SUPERVISOR_STATUSES.has(row.status)) return null;
    return row.id;
  }

  async function approveUnderSupervisorPolicy(request: AdapterApprovalRequest, supervisorAgentId: string): Promise<AdapterApprovalDecision> {
    const category = request.categories.join("+");
    const note = `approved under delegated supervisor policy (safe category: ${category})`;
    await log("adapter_approval.supervisor_approved", "heartbeat_run", heartbeatRunId, {
      ...auditBase(request),
      supervisorAgentId,
      safeCategory: category,
      policy: "approved under delegated supervisor policy",
    });
    return { decision: "approved", decidedBy: "supervisor_policy", supervisorAgentId, note, ...echo(request) };
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
    const timeoutMinutes = Math.max(1, Math.round(request.timeoutMs / 60_000));
    const agentLabel = deps.agentName?.trim() || "An agent";
    const notes = [
      ...(request.commandComplete ? [] : [INCOMPLETE_NOTE]),
      ...(routingNote && routingNote !== INCOMPLETE_NOTE ? [routingNote] : []),
    ];
    const created = await approvalsSvc.create(companyId, {
      type: "request_board_approval",
      // Deliberately no requestedByAgentId: approving must not queue an extra
      // wake for an agent whose run is still waiting on this answer.
      requestedByAgentId: null,
      requestedByUserId: null,
      status: "pending",
      payload: {
        title: `Approve agent command (${request.tier} tier)`,
        summary: `${agentLabel} asked to run a command that its runtime flagged for human approval: ${request.description || "no description"}.`,
        recommendedAction: `Approve only if this exact command is intended. The run waits up to ${timeoutMinutes} minute(s); after that the command is denied.`,
        risks: [
          ...notes,
          `Classifier reasons: ${request.reasons.join(", ") || "none"}.`,
          "Approval applies to this single command only (choice \"once\").",
        ],
        proposedComment: `\`\`\`\n${request.command}\n\`\`\`${request.commandComplete ? "" : `\n\n${INCOMPLETE_NOTE}`}`,
        source: ADAPTER_APPROVAL_SOURCE,
        adapterType: deps.adapterType,
        agentId,
        heartbeatRunId,
        issueId,
        providerRunId: request.providerRunId,
        requestId: request.requestId,
        tier: request.tier,
        reasons: request.reasons,
        categories: request.categories,
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

  async function awaitBoard(request: AdapterApprovalRequest, routingNote: string | null): Promise<AdapterApprovalDecision> {
    const existing = await findExisting(request.requestId);
    if (existing && (existing.payload as Record<string, unknown>).commandSha256 !== request.commandSha256) {
      // A replayed request id with a different command must never inherit a decision.
      await log("adapter_approval.hash_mismatch", "approval", existing.id, auditBase(request));
      return { decision: "denied", decidedBy: "system", approvalId: existing.id, note: "The request id was reused for a different command." };
    }
    const approval = existing ?? await createBoardApproval(request, routingNote);
    let status = approval.status;
    let decisionNote = approval.decisionNote;
    let settled = false;
    try {
      if (!existing && issueId) {
        await issueApprovalsSvc.linkManyForApproval(approval.id, [issueId], { agentId });
      }
      const deadline = now() + request.timeoutMs;
      while (status === "pending" && !request.signal.aborted && now() < deadline) {
        await waitForChange(approval.id, Math.min(fallbackPollMs, deadline - now()), request.signal);
        const latest = await approvalsSvc.getById(approval.id);
        if (!latest) break;
        status = latest.status;
        decisionNote = latest.decisionNote;
      }
      if (status === "approved" || status === "rejected") {
        settled = true;
        const decision = status === "approved" ? "approved" : "denied";
        await log("adapter_approval.board_resolved", "approval", approval.id, { ...auditBase(request), approvalStatus: status, decision });
        return {
          decision,
          decidedBy: "board",
          approvalId: approval.id,
          note: decisionNote ?? null,
          ...(decision === "approved" ? echo(request) : {}),
        };
      }
      if (status === "cancelled") {
        settled = true;
        return { decision: "cancelled", decidedBy: "system", approvalId: approval.id, note: decisionNote ?? null };
      }
      if (status === "revision_requested") {
        return { decision: "denied", decidedBy: "board", approvalId: approval.id, note: decisionNote ?? "The board requested a revision; the command was denied." };
      }
      const aborted = request.signal.aborted;
      await log(aborted ? "adapter_approval.abandoned" : "adapter_approval.timed_out", "approval", approval.id, {
        ...auditBase(request),
        timeoutMs: request.timeoutMs,
      });
      return aborted
        ? { decision: "cancelled", decidedBy: "system", approvalId: approval.id, note: "The agent run ended before a board decision; the command was not run." }
        : { decision: "timeout", decidedBy: "system", approvalId: approval.id, note: "No board decision before the approval timeout; the command was denied." };
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
    let routingNote: string | null = null;
    if (request.route === "supervisor") {
      // Defense in depth: re-check everything the adapter claimed.
      routingNote = delegable(request);
      if (!routingNote) {
        const supervisorAgentId = await usableSupervisor(request.supervisorAgentId);
        if (supervisorAgentId) return approveUnderSupervisorPolicy(request, supervisorAgentId);
        routingNote = "The configured approval supervisor is not an idle or running agent in this company, so the board decides.";
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
