import { createHash } from "node:crypto";
import type {
  AdapterApprovalDecision,
  AdapterExecutionContext,
} from "@paperclipai/adapter-utils";

// Hermes emits `approval.request` when its approval gate (smart guardian or
// manual) escalates a flagged command to a human, then blocks the agent until
// `POST /v1/runs/{run_id}/approval` answers it or `approvals.timeout` elapses.
// Green and yellow judgement belongs to Hermes' guardian: every request that
// reaches Paperclip goes to the board. This module parses those events, hands
// them to the host, and answers Hermes with the narrowest possible scope.

// Below Hermes' default `approvals.timeout` (300 s), so by default Paperclip
// answers before Hermes gives up.
export const DEFAULT_APPROVAL_BOARD_TIMEOUT_SEC = 270;
const MIN_APPROVAL_BOARD_TIMEOUT_SEC = 10;
const MAX_APPROVAL_BOARD_TIMEOUT_SEC = 24 * 60 * 60;
// Leave the adapter time to answer Hermes before its own run deadline.
export const RUN_DEADLINE_RESERVE_MS = 15_000;
const MAX_APPROVAL_TEXT_CHARS = 2_000;

/** Abort reasons for which Hermes is no longer waiting, so nothing is answered. */
export const PROVIDER_RUN_ENDED = "provider_run_ended";
export const PROVIDER_NOT_PENDING = "provider_not_pending";

export type HermesApprovalRequest = {
  requestId: string;
  runId: string;
  command: string;
  description: string;
  patternKeys: string[];
  choices: string[];
  smartDenied: boolean;
};

export type ApprovalRoutingConfig = {
  enabled: boolean;
  boardTimeoutMs: number;
};

export type ApprovalAnswerResult = { delivered: true } | { delivered: false; reason: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Parse a Hermes `approval.request` event (stream frame or status `approval`). */
export function parseHermesApprovalRequest(value: unknown, fallbackRunId: string): HermesApprovalRequest | null {
  const record = asRecord(value);
  if (!record) return null;
  const event = nonEmpty(record.event) ?? nonEmpty(record.type);
  if (event && event !== "approval.request") return null;
  const requestId = nonEmpty(record.request_id);
  // Without a request id an answer could resolve a different queued request.
  if (!requestId || requestId.length > 256) return null;
  const patternKeys = [...new Set([...stringList(record.pattern_keys), ...(nonEmpty(record.pattern_key) ? [record.pattern_key as string] : [])])];
  return {
    requestId,
    runId: nonEmpty(record.run_id) ?? fallbackRunId,
    command: typeof record.command === "string" ? record.command : "",
    description: typeof record.description === "string" ? record.description : "",
    patternKeys,
    choices: stringList(record.choices),
    smartDenied: record.smart_denied === true,
  };
}

// ---------------------------------------------------------------------------
// Redaction and integrity
// ---------------------------------------------------------------------------

const TOKEN_REDACTIONS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b(authorization|x-api-key|api-key|cookie)\s*:\s*[^\s"']+/gi, "$1: [redacted]"],
  [/\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"']+)/gi, "$1=[redacted]"],
  [/(--?(?:token|secret|password|passwd|api[-_]?key|auth|key|pat|credentials?))(\s+|=)("[^"]*"|'[^']*'|[^\s"']+)/gi, "$1$2[redacted]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|pcp_[A-Za-z0-9_-]{16,})\b/g, "[redacted-token]"],
  [/:\/\/([^/\s:@]+):([^/\s@]+)@/g, "://$1:[redacted]@"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "[redacted-hex]"],
  [/\b[A-Za-z0-9+_-]{40,}={0,2}/g, "[redacted-blob]"],
];

/** Redact token-like material from approval text before it is logged or stored. */
export function redactApprovalText(value: string, redactText?: (value: string) => string): string {
  let out = redactText ? redactText(value) : value;
  for (const [pattern, replacement] of TOKEN_REDACTIONS) out = out.replace(pattern, replacement);
  return out.length <= MAX_APPROVAL_TEXT_CHARS ? out : `${out.slice(0, MAX_APPROVAL_TEXT_CHARS)}... [truncated]`;
}

// Hermes' own redaction markers (`***`, `«redacted…»`) and truncation markers.
const PROVIDER_INCOMPLETE_MARKERS = /\*\*\*|«redacted|\[redacted|\[truncated|…\s*$/i;

/** True when the board would not see the exact command Hermes will run. */
export function isCommandIncomplete(rawCommand: string, displayCommand: string): boolean {
  return !rawCommand.trim() || displayCommand !== rawCommand || PROVIDER_INCOMPLETE_MARKERS.test(rawCommand);
}

export function commandSha256(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function parsePositiveNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function readApprovalRoutingConfig(config: Record<string, unknown>): ApprovalRoutingConfig {
  const timeoutSec = parsePositiveNumber(config.approvalBoardTimeoutSec) ?? DEFAULT_APPROVAL_BOARD_TIMEOUT_SEC;
  return {
    enabled: config.approvalRouting !== false,
    boardTimeoutMs: Math.round(Math.min(MAX_APPROVAL_BOARD_TIMEOUT_SEC, Math.max(MIN_APPROVAL_BOARD_TIMEOUT_SEC, timeoutSec)) * 1000),
  };
}

/** min(approvalBoardTimeoutSec, remaining run time − reserve), never negative. */
export function effectiveBoardTimeoutMs(boardTimeoutMs: number, runDeadlineAt: number | null, now = Date.now()): number {
  if (runDeadlineAt === null) return boardTimeoutMs;
  return Math.max(0, Math.min(boardTimeoutMs, runDeadlineAt - now - RUN_DEADLINE_RESERVE_MS));
}

export type ApprovalRouterInput = {
  ctx: AdapterExecutionContext;
  config: ApprovalRoutingConfig;
  /** Absolute epoch ms of the adapter run deadline, or null when unbounded. */
  runDeadlineAt: number | null;
  /**
   * Aborted when the run ends or is stopping. Reason PROVIDER_RUN_ENDED skips
   * the answer; any other reason answers "deny".
   */
  signal: AbortSignal;
  redactText: (value: string) => string;
  postDecision: (input: { runId: string; requestId: string; choice: "once" | "deny" }) => Promise<ApprovalAnswerResult>;
  now?: () => number;
};

export type ApprovalRouter = {
  handle: (raw: unknown, fallbackRunId: string) => void;
  /**
   * Report a Hermes run status fetched by a poll that started at `pollStartedAt`.
   * A request first seen before the poll started is withdrawn when the status
   * is no longer `waiting_for_approval`: Hermes stopped waiting for it.
   */
  observeStatus: (status: string | null, pollStartedAt: number) => void;
  settle: () => Promise<void>;
};

type PendingRequest = { seenAt: number; controller: AbortController };

/**
 * Create a per-run router. `handle` is fire-and-forget so the event stream
 * keeps flowing while a board decision is pending; `settle` waits for every
 * in-flight request after the run's signal has been aborted.
 */
export function createApprovalRouter(input: ApprovalRouterInput): ApprovalRouter {
  const now = input.now ?? Date.now;
  const seen = new Set<string>();
  const pending = new Map<string, PendingRequest>();
  const inFlight = new Set<Promise<void>>();

  const emit = async (eventType: string, level: "info" | "warn", message: string, payload: Record<string, unknown>) => {
    await input.ctx.onLog(level === "warn" ? "stderr" : "stdout", `[hermes-gateway:approval] ${message}\n`);
    await input.ctx.onEvent?.({ eventType, stream: "system", level, message, payload });
  };

  async function route(request: HermesApprovalRequest, entry: PendingRequest): Promise<void> {
    const command = redactApprovalText(request.command, input.redactText);
    const description = redactApprovalText(request.description, input.redactText);
    const commandComplete = !isCommandIncomplete(request.command, command);
    const sha = commandSha256(request.command);
    // One signal for "stop waiting": the run ended or stopped, or Hermes
    // withdrew this request.
    const requestSignal = entry.controller.signal;
    const onRunAbort = () => entry.controller.abort(input.signal.reason);
    if (input.signal.aborted) onRunAbort();
    else input.signal.addEventListener("abort", onRunAbort, { once: true });

    const base = {
      hermesRunId: request.runId,
      requestId: request.requestId,
      commandSha256: sha,
      commandComplete,
      smartDenied: request.smartDenied,
      command,
      description,
    };
    await emit("adapter.approval.requested", "info", `request ${request.requestId} sent to the board for a decision`, base);

    const timeoutMs = effectiveBoardTimeoutMs(input.config.boardTimeoutMs, input.runDeadlineAt, now());
    if (timeoutMs < input.config.boardTimeoutMs) {
      await emit(
        "adapter.approval.timeout_capped",
        "warn",
        `request ${request.requestId}: board wait capped to ${Math.floor(timeoutMs / 1000)}s by the run timeout (approvalBoardTimeoutSec is ${Math.floor(input.config.boardTimeoutMs / 1000)}s); raise timeoutSec to wait longer`,
        { ...base, effectiveTimeoutMs: timeoutMs, configuredTimeoutMs: input.config.boardTimeoutMs },
      );
    }

    let decision: AdapterApprovalDecision;
    if (!input.config.enabled) {
      decision = { decision: "unavailable", decidedBy: "system", note: "Approval routing is disabled in adapterConfig.approvalRouting." };
    } else if (!input.ctx.onApprovalRequest) {
      decision = { decision: "unavailable", decidedBy: "system", note: "This Paperclip host cannot route approval requests." };
    } else {
      try {
        decision = await input.ctx.onApprovalRequest({
          requestId: request.requestId,
          providerRunId: request.runId,
          command,
          commandSha256: sha,
          commandComplete,
          description,
          timeoutMs,
          signal: requestSignal,
        });
      } catch (err) {
        decision = {
          decision: "unavailable",
          decidedBy: "system",
          note: `Approval routing failed: ${input.redactText(err instanceof Error ? err.message : String(err))}`,
        };
      }
    }
    input.signal.removeEventListener("abort", onRunAbort);
    pending.delete(request.requestId);

    // An approval must be for this exact request and command.
    if (decision.decision === "approved" && (decision.requestId !== request.requestId || decision.commandSha256 !== sha)) {
      decision = { ...decision, decision: "denied", decidedBy: "system", note: "The approval did not match this request id and command hash." };
    }

    const outcomeBase = {
      ...base,
      decidedBy: decision.decidedBy,
      ...(decision.approvalId ? { approvalId: decision.approvalId } : {}),
    };
    const report = async (delivered: boolean, choice: "once" | "deny", reason: string | null) => {
      try {
        await decision.onDelivery?.({ delivered, choice, reason });
      } catch {
        // Recording delivery is best effort; the run log below is authoritative.
      }
    };

    const abortReason = requestSignal.aborted ? String(requestSignal.reason ?? "") : null;
    if (abortReason === PROVIDER_RUN_ENDED || abortReason === PROVIDER_NOT_PENDING) {
      await report(false, "deny", abortReason);
      await emit("adapter.approval.abandoned", "warn", `request ${request.requestId} abandoned: Hermes is no longer waiting for it (${abortReason})`, {
        ...outcomeBase,
        decision: decision.decision,
        reason: abortReason,
      });
      return;
    }

    let choice: "once" | "deny" = decision.decision === "approved" ? "once" : "deny";
    // Re-check immediately before answering: never approve once the run is
    // stopping or the request was withdrawn.
    if (choice === "once" && (input.signal.aborted || requestSignal.aborted)) {
      choice = "deny";
      decision = { ...decision, decision: "cancelled", note: "The run was stopping when the approval arrived; the command was denied." };
    }
    const summary =
      decision.decision === "approved"
        ? "approved by the board"
        : decision.decision === "denied"
          ? `denied${decision.decidedBy === "board" ? " by the board" : `: ${decision.note ?? "denied"}`}`
          : decision.decision === "timeout"
            ? "denied: no board decision before the approval timeout"
            : `denied: ${decision.note ?? decision.decision}`;
    const outcome = {
      ...outcomeBase,
      decision: decision.decision,
      choice,
      ...(decision.note ? { note: redactApprovalText(decision.note, input.redactText) } : {}),
    };

    let result: ApprovalAnswerResult;
    try {
      result = await input.postDecision({ runId: request.runId, requestId: request.requestId, choice });
    } catch (err) {
      result = { delivered: false, reason: input.redactText(err instanceof Error ? err.message : String(err)) };
    }
    await report(result.delivered, choice, result.delivered ? null : result.reason);
    if (result.delivered) {
      await emit("adapter.approval.resolved", choice === "once" ? "info" : "warn", `request ${request.requestId} ${summary}; answered Hermes with "${choice}"`, outcome);
    } else {
      await emit(
        "adapter.approval.answer_failed",
        "warn",
        `request ${request.requestId} ${summary}, but Hermes did not accept the answer (${result.reason}); the command did not run`,
        { ...outcome, reason: result.reason },
      );
    }
  }

  return {
    handle(raw, fallbackRunId) {
      const request = parseHermesApprovalRequest(raw, fallbackRunId);
      if (!request || seen.has(request.requestId)) return;
      seen.add(request.requestId);
      const entry: PendingRequest = { seenAt: now(), controller: new AbortController() };
      pending.set(request.requestId, entry);
      const task = route(request, entry)
        .catch(() => undefined)
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
    },
    observeStatus(status, pollStartedAt) {
      if (!status || status === "waiting_for_approval") return;
      for (const entry of pending.values()) {
        // A poll that started before we saw the request may predate it.
        if (entry.seenAt < pollStartedAt) entry.controller.abort(PROVIDER_NOT_PENDING);
      }
    },
    async settle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}
