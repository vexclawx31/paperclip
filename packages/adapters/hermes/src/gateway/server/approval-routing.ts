import { createHash } from "node:crypto";
import type {
  AdapterApprovalDecision,
  AdapterApprovalRequest,
  AdapterExecutionContext,
} from "@paperclipai/adapter-utils";
import { analyzeCommand, DEFAULT_SAFE_ROOTS, readSafeRoots, type SafeCategory } from "./approval-classifier.js";

// Hermes emits `approval.request` when its approval gate (smart or manual)
// escalates a flagged command to a human, then blocks the agent until
// `POST /v1/runs/{run_id}/approval` answers it or `approvals.timeout` elapses.
// This module parses those events, classifies them conservatively, routes them
// through the host, and answers Hermes with the narrowest possible scope.

// Below the default run timeoutSec (600) minus the 15 s answer reserve, so the
// default pairing never caps the board wait.
export const DEFAULT_APPROVAL_BOARD_TIMEOUT_SEC = 540;
const MIN_APPROVAL_BOARD_TIMEOUT_SEC = 10;
const MAX_APPROVAL_BOARD_TIMEOUT_SEC = 24 * 60 * 60;
// Leave the adapter time to answer Hermes before its own run deadline.
export const RUN_DEADLINE_RESERVE_MS = 15_000;
const MAX_APPROVAL_TEXT_CHARS = 2_000;

export type HermesApprovalRequest = {
  requestId: string;
  runId: string;
  command: string;
  description: string;
  patternKeys: string[];
  choices: string[];
  smartDenied: boolean;
};

export type ApprovalTier = "red" | "yellow";

export type ApprovalClassification = {
  tier: ApprovalTier;
  reasons: string[];
  /** Known-safe categories the whole command matched (yellow only). */
  categories: SafeCategory[];
};

export type ApprovalRoutingConfig = {
  enabled: boolean;
  supervisorAgentId: string | null;
  boardTimeoutMs: number;
  safeRoots: string[];
};

/** Abort reason that means Hermes already finished the run; nothing to answer. */
export const PROVIDER_RUN_ENDED = "provider_run_ended";

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
// Redaction
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

export function commandSha256(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

type Rule = { id: string; test: (text: string) => boolean };

// Vetoes over the command, description and pattern keys. They only add red
// reasons; a command is yellow only through analyzeCommand's safe categories.
const RED_VETOES: Rule[] = [
  { id: "credentials", test: (t) => /\b(credentials?|secrets?|tokens?|oauth|keychain|api[_-]?keys?|passwords?|passwd|private[_ -]?keys?|ssh[_-]?keys?|ssh-keygen|gpg|auth\.json)\b|\bsecurity\s+(find|add|delete|dump)-|\.ssh\/|\.netrc|\.npmrc|\.pypirc|\.env\b|\.hermes\/(config|\.env|auth)/i.test(t) },
  { id: "service_control", test: (t) => /\b(launchctl|systemctl|service\s+\S+\s+(start|stop|restart|reload)|brew\s+services|pm2|supervisorctl|hermes\s+(gateway|update)|shutdown|reboot|poweroff)\b|system service|launchd service|hermes gateway|self-termination|container lifecycle|kill all processes/i.test(t) },
  { id: "deploy", test: (t) => /\b(deploy(ment)?s?|kubectl|helm|terraform|pulumi|docker|podman|flyctl|vercel|railway|heroku|gcloud|aws)\b|remote daemon|daemon redirect/i.test(t) },
  { id: "remote_code", test: (t) => /remote content|remote script|possible command obfuscation/i.test(t) },
  { id: "money", test: (t) => /\b(stripe|payments?|paypal|braintree|invoice|purchase|billing|refund|subscription|spend[_ -]?limit|budget)\b/i.test(t) },
  { id: "external_comms", test: (t) => /\b(e-?mail|sendmail|smtp|mailgun|sendgrid|postmark|slack|discord|telegram|twilio|whatsapp|imessage|tweet|twitter|linkedin|webhooks?|publish)\b/i.test(t) },
  { id: "destructive_sql", test: (t) => /\b(drop\s+(table|database|schema|index|view|owner|role|user)|truncate(\s+table)?\s+\w+|dropdb|flushall|flushdb)\b|\bdelete\s+from\s+[\w."]+\s*(;|$|"|')|sql drop|sql truncate|sql delete without where/i.test(t) },
  { id: "disk_destruction", test: (t) => /block device|root filesystem|system directory|home directory|root path|fork bomb|system config|system file/i.test(t) },
  { id: "cross_tenant", test: (t) => /\b(other|another|different)\s+(company|tenant|customer)\b/i.test(t) },
  { id: "disable_safety", test: (t) => /--dangerously|--yolo|\byolo\b|approvals?\.(mode|timeout)|approval[_ -]?(policy|mode)|disable[-_ ]?(safety|approvals?|audit|guard(ian)?|backups?)|--no-verify|ngrok|cloudflared/i.test(t) },
];

const INCOMPLETE_MARKERS = /\*\*\*|«redacted|\[redacted|\[truncated|…\s*$/i;

/**
 * Fail-safe classifier. A request is "yellow" (delegable) only when the whole
 * command matches known-safe categories, nothing in it is redacted or
 * truncated, Hermes' guardian did not deny it, and no veto matches. Anything
 * else is "red" (human only).
 */
export function classifyApprovalRequest(
  request: Pick<HermesApprovalRequest, "command" | "description" | "patternKeys" | "smartDenied">,
  safeRoots: string[] = DEFAULT_SAFE_ROOTS,
): ApprovalClassification {
  const command = request.command.trim();
  const text = [command, request.description, ...request.patternKeys].join("\n");
  const reasons: string[] = [];
  if (!command) reasons.push("unclassifiable");
  if (request.smartDenied) reasons.push("guardian_denied");
  if (INCOMPLETE_MARKERS.test(command)) reasons.push("redacted_or_truncated");
  for (const rule of RED_VETOES) {
    if (rule.test(text)) reasons.push(rule.id);
  }
  const analysis = command ? analyzeCommand(command, safeRoots) : null;
  if (analysis && !analysis.safe) reasons.push(...analysis.reasons);
  if (reasons.length > 0 || !analysis?.safe) {
    return { tier: "red", reasons: [...new Set(reasons.length > 0 ? reasons : ["unclassifiable"])], categories: [] };
  }
  return { tier: "yellow", reasons: analysis.categories.map((category) => `safe:${category}`), categories: analysis.categories };
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
    supervisorAgentId: nonEmpty(config.approvalSupervisorAgentId),
    boardTimeoutMs: Math.round(Math.min(MAX_APPROVAL_BOARD_TIMEOUT_SEC, Math.max(MIN_APPROVAL_BOARD_TIMEOUT_SEC, timeoutSec)) * 1000),
    safeRoots: readSafeRoots(config.approvalScratchRoots),
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
  /** Aborted when the run ends. Reason PROVIDER_RUN_ENDED skips the answer. */
  signal: AbortSignal;
  redactText: (value: string) => string;
  postDecision: (input: { runId: string; requestId: string; choice: "once" | "deny" }) => Promise<void>;
};

export type ApprovalRouter = {
  handle: (raw: unknown, fallbackRunId: string) => void;
  settle: () => Promise<void>;
};

/**
 * Create a per-run router. `handle` is fire-and-forget so the event stream
 * keeps flowing while a board decision is pending; `settle` waits for every
 * in-flight request after the run's signal has been aborted.
 */
export function createApprovalRouter(input: ApprovalRouterInput): ApprovalRouter {
  const seen = new Set<string>();
  const inFlight = new Set<Promise<void>>();

  const emit = async (eventType: string, level: "info" | "warn", message: string, payload: Record<string, unknown>) => {
    await input.ctx.onLog(level === "warn" ? "stderr" : "stdout", `[hermes-gateway:approval] ${message}\n`);
    await input.ctx.onEvent?.({ eventType, stream: "system", level, message, payload });
  };

  async function route(request: HermesApprovalRequest): Promise<void> {
    const command = redactApprovalText(request.command, input.redactText);
    const description = redactApprovalText(request.description, input.redactText);
    const classification = classifyApprovalRequest(request, input.config.safeRoots);
    // The board must see exactly what it approves. If display redaction or
    // truncation changed the command, it can never be delegated.
    const commandComplete = command === request.command && !classification.reasons.includes("redacted_or_truncated");
    if (!commandComplete && classification.tier === "yellow") {
      classification.tier = "red";
      classification.reasons = ["redacted_or_truncated"];
      classification.categories = [];
    }
    const sha = commandSha256(request.command);
    const base = {
      hermesRunId: request.runId,
      requestId: request.requestId,
      tier: classification.tier,
      reasons: classification.reasons,
      categories: classification.categories,
      commandSha256: sha,
      commandComplete,
      command,
      description,
    };
    const supervisorAgentId = input.config.supervisorAgentId;
    const route: AdapterApprovalRequest["route"] =
      classification.tier === "yellow" && supervisorAgentId && supervisorAgentId !== input.ctx.agent.id
        ? "supervisor"
        : "board";
    await emit(
      "adapter.approval.requested",
      "info",
      `request ${request.requestId} classified ${classification.tier} (${classification.reasons.join(", ")}); routing to ${route}`,
      { ...base, route, ...(route === "supervisor" ? { supervisorAgentId } : {}) },
    );

    const timeoutMs = effectiveBoardTimeoutMs(input.config.boardTimeoutMs, input.runDeadlineAt);
    if (route === "board" && timeoutMs < input.config.boardTimeoutMs) {
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
          tier: classification.tier,
          route,
          supervisorAgentId: route === "supervisor" ? supervisorAgentId : null,
          categories: classification.categories,
          command,
          commandSha256: sha,
          commandComplete,
          description,
          reasons: classification.reasons,
          timeoutMs,
          signal: input.signal,
        });
      } catch (err) {
        decision = {
          decision: "unavailable",
          decidedBy: "system",
          note: `Approval routing failed: ${input.redactText(err instanceof Error ? err.message : String(err))}`,
        };
      }
    }

    // An approval must be for this exact request and command.
    if (decision.decision === "approved" && (decision.requestId !== request.requestId || decision.commandSha256 !== sha)) {
      decision = { decision: "denied", decidedBy: "system", note: "The approval did not match this request id and command hash." };
    }

    if (input.signal.aborted && decision.decision !== "approved") {
      if (input.signal.reason === PROVIDER_RUN_ENDED) {
        await emit("adapter.approval.abandoned", "warn", `request ${request.requestId} abandoned: the Hermes run ended before a decision`, { ...base, decision: decision.decision });
        return;
      }
      decision = { decision: "cancelled", decidedBy: "system", note: "The Paperclip run was cancelled or timed out before a decision." };
    }

    const choice = decision.decision === "approved" ? "once" : "deny";
    const outcome = {
      ...base,
      decision: decision.decision,
      decidedBy: decision.decidedBy,
      choice,
      ...(decision.approvalId ? { approvalId: decision.approvalId } : {}),
      ...(decision.supervisorAgentId ? { supervisorAgentId: decision.supervisorAgentId } : {}),
      ...(decision.note ? { note: redactApprovalText(decision.note, input.redactText) } : {}),
    };
    const summary =
      decision.decision === "approved" && decision.decidedBy === "supervisor_policy"
        ? `approved under delegated supervisor policy (${classification.categories.join("+")})`
        : decision.decision === "approved"
          ? "approved by the board"
          : decision.decision === "denied"
            ? `denied${decision.decidedBy === "board" ? " by the board" : `: ${decision.note ?? "denied"}`}`
            : decision.decision === "timeout"
              ? "denied: no board decision before the approval timeout"
              : `denied: ${decision.note ?? decision.decision}`;
    try {
      await input.postDecision({ runId: request.runId, requestId: request.requestId, choice });
      await emit("adapter.approval.resolved", choice === "once" ? "info" : "warn", `request ${request.requestId} ${summary}; answered Hermes with "${choice}"`, outcome);
    } catch (err) {
      await emit(
        "adapter.approval.answer_failed",
        "warn",
        `request ${request.requestId} ${summary}, but Hermes did not accept the answer: ${input.redactText(err instanceof Error ? err.message : String(err))}`,
        outcome,
      );
    }
  }

  return {
    handle(raw, fallbackRunId) {
      const request = parseHermesApprovalRequest(raw, fallbackRunId);
      if (!request || seen.has(request.requestId)) return;
      seen.add(request.requestId);
      const task = route(request)
        .catch(() => undefined)
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
    },
    async settle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}
