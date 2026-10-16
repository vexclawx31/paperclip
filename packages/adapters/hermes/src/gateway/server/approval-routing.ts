import type {
  AdapterApprovalDecision,
  AdapterApprovalRequest,
  AdapterExecutionContext,
} from "@paperclipai/adapter-utils";

// Hermes emits `approval.request` when its approval gate (smart or manual)
// escalates a flagged command to a human, then blocks the agent until
// `POST /v1/runs/{run_id}/approval` answers it or `approvals.timeout` elapses.
// This module parses those events, classifies them conservatively, routes them
// through the host, and answers Hermes with the narrowest possible scope.

export const DEFAULT_APPROVAL_BOARD_TIMEOUT_SEC = 900;
const MIN_APPROVAL_BOARD_TIMEOUT_SEC = 10;
const MAX_APPROVAL_BOARD_TIMEOUT_SEC = 24 * 60 * 60;
// Leave the adapter time to answer Hermes before its own run deadline.
const RUN_DEADLINE_RESERVE_MS = 15_000;
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
};

export type ApprovalRoutingConfig = {
  enabled: boolean;
  supervisorAgentId: string | null;
  boardTimeoutMs: number;
};

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

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

type Rule = { id: string; test: (command: string, text: string) => boolean };

const SCRATCH_PREFIXES = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];

function shellWords(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g)?.map((word) => word.replace(/^["']|["']$/g, "")) ?? [];
}

// `rm -r`/`rm -f` is only delegable when every target stays inside the run's
// working directory or a disposable scratch path. Anything the classifier
// cannot place (absolute, home, `..`, variables, globs at a root) is red.
function rmOutsideWorkspace(command: string): boolean {
  for (const segment of command.split(/&&|\|\||[;|\n]|\$\(|`/)) {
    const words = shellWords(segment.trim());
    const index = words.findIndex((word) => word === "rm" || word.endsWith("/rm"));
    if (index < 0) continue;
    const args = words.slice(index + 1);
    const flags = args.filter((arg) => arg.startsWith("-"));
    const recursiveOrForce = flags.some((flag) => /^-[a-zA-Z]*[rRf]/.test(flag) || flag === "--recursive" || flag === "--force");
    if (!recursiveOrForce) continue;
    const targets = args.filter((arg) => !arg.startsWith("-"));
    if (targets.length === 0) return true;
    for (const target of targets) {
      if (SCRATCH_PREFIXES.some((prefix) => target.startsWith(prefix) && target.length > prefix.length && !target.includes(".."))) continue;
      if (/^[\/~$]/.test(target) || target.includes("..") || target.includes("$") || target === "*" || target === "." || target === "./") return true;
    }
  }
  return false;
}

function forcePushToProtected(command: string): boolean {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = shellWords(segment.trim());
    const gitIndex = words.indexOf("git");
    if (gitIndex < 0 || !words.slice(gitIndex + 1).includes("push")) continue;
    const args = words.slice(words.indexOf("push", gitIndex) + 1);
    const force = args.some((arg) => arg === "-f" || arg.startsWith("--force") || /^-[a-zA-Z]*f/.test(arg) || arg.startsWith("+"));
    const deletes = args.some((arg) => arg === "--delete" || arg === "-d" || arg.startsWith(":"));
    if (!force && !deletes) continue;
    const refs = args.filter((arg) => !arg.startsWith("-"));
    // `git push --force` with no explicit branch pushes an unknown target.
    if (refs.length <= 1) return true;
    if (refs.slice(1).some((ref) => /(^|[:+/])(main|master)$/.test(ref) || ref === "--all" || ref === "--mirror")) return true;
    if (args.includes("--all") || args.includes("--mirror")) return true;
  }
  return false;
}

const RED_RULES: Rule[] = [
  { id: "credentials", test: (_c, t) => /\b(credentials?|secrets?|tokens?|oauth|keychain|api[_-]?keys?|passwords?|passwd|private[_ -]?keys?|ssh[_-]?keys?|ssh-keygen|gpg|auth\.json)\b|\bsecurity\s+(find|add|delete|dump)-|\.ssh\/|\.netrc|\.npmrc|\.pypirc|\.env\b|\.hermes\/(config|\.env|auth)/i.test(t) },
  { id: "redacted_secret", test: (c) => /\*\*\*|«redacted|\[redacted/i.test(c) },
  { id: "service_control", test: (_c, t) => /\b(launchctl|systemctl|service\s+\S+\s+(start|stop|restart|reload)|brew\s+services|pm2\s+(start|stop|restart|reload|delete)|supervisorctl|hermes\s+(gateway|update)|init\s+[06]|shutdown|reboot|poweroff|halt)\b|system service|launchd service|hermes gateway|self-termination|container lifecycle|kill all processes/i.test(t) },
  { id: "deploy", test: (_c, t) => /\b(deploy(ment)?s?|kubectl|helm|terraform\s+(apply|destroy|import)|pulumi\s+up|docker\s+(push|login)|podman\s+push|fly(ctl)?\s+deploy|vercel\b.*--prod|railway\s+up|heroku\b|eb\s+deploy|gcloud\b|aws\b|az\s)|remote daemon|daemon redirect/i.test(t) },
  { id: "privilege", test: (_c, t) => /(^|[\s;&|(`])(sudo|doas|su)(\s|$)|\bchown\b.*\broot\b|chmod\s+(-R\s+)?[0-7]*7[0-7]{0,2}\s+\/|world\/other-writable|chown to root|sudo with/i.test(t) },
  { id: "remote_code", test: (_c, t) => /\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|k|da|fi)?sh\b|\b(ba|z)?sh\s+<\(\s*(curl|wget)|\b(python3?|node|ruby|perl)\s+(-c\s+)?<\(\s*(curl|wget)|remote content|remote script|possible command obfuscation/i.test(t) },
  { id: "money", test: (_c, t) => /\b(stripe|payments?|paypal|braintree|invoice|purchase|billing|charge[sd]?|refund|subscription|spend[_ -]?limit|budget)\b/i.test(t) },
  { id: "external_comms", test: (_c, t) => /\b(e-?mail|sendmail|smtp|mailgun|sendgrid|postmark|ses\s+send|slack|discord|telegram|twilio|whatsapp|imessage|osascript.*messages|tweet|twitter|linkedin|webhooks?|chat\.postMessage|gh\s+(issue|pr)\s+comment|gh\s+release\s+create|npm\s+publish|pnpm\s+publish|twine\s+upload)\b/i.test(t) },
  { id: "force_push_protected", test: (c) => forcePushToProtected(c) },
  { id: "destructive_sql", test: (_c, t) => /\b(drop\s+(table|database|schema|index|view|owner|role|user)|truncate(\s+table)?\s+\w+|dropdb|pg_dropcluster|flushall|flushdb)\b|\bdelete\s+from\s+[\w."]+\s*(;|$|"|')|sql drop|sql truncate|sql delete without where/i.test(t) },
  { id: "delete_outside_workspace", test: (c) => rmOutsideWorkspace(c) },
  { id: "disk_destruction", test: (_c, t) => /\b(mkfs|dd\s+.*of=\/dev|diskutil\s+(erase|partition|unmount)|shred|wipefs|fdisk)\b|block device|root filesystem|system directory|home directory|root path|fork bomb|system config|system file|find\s+\/\S*\s.*-delete/i.test(t) },
  { id: "cross_tenant", test: (_c, t) => /\b(other|another|different)\s+(company|tenant|customer)\b/i.test(t) },
  { id: "disable_safety", test: (_c, t) => /--dangerously|--yolo|\byolo\b|approvals?\.(mode|timeout)|approval[_ -]?(policy|mode)|csrutil|spctl\s+--master-disable|ufw\s+disable|setenforce\s+0|auditctl|disable[-_ ]?(safety|approvals?|audit|guard(ian)?|backups?)|--no-verify|hermes\s+config\s+set|ngrok|cloudflared|tailscale\s+(funnel|serve)/i.test(t) },
];

/**
 * Conservative deterministic classifier. A request is "yellow" (delegable to
 * a supervisor) only when it carries a command, Hermes' guardian did not deny
 * it, and no red rule matches. Anything else is "red" (human only).
 */
export function classifyApprovalRequest(request: Pick<HermesApprovalRequest, "command" | "description" | "patternKeys" | "smartDenied">): ApprovalClassification {
  const command = request.command.trim();
  const text = [command, request.description, ...request.patternKeys].join("\n");
  const reasons: string[] = [];
  if (!command) reasons.push("unclassifiable");
  if (request.smartDenied) reasons.push("guardian_denied");
  for (const rule of RED_RULES) {
    try {
      if (rule.test(command, text)) reasons.push(rule.id);
    } catch {
      reasons.push("classifier_error");
    }
  }
  return reasons.length > 0 ? { tier: "red", reasons } : { tier: "yellow", reasons: ["no_red_rule_matched"] };
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
  };
}

export type ApprovalRouterInput = {
  ctx: AdapterExecutionContext;
  config: ApprovalRoutingConfig;
  /** Absolute epoch ms of the adapter run deadline, or null when unbounded. */
  runDeadlineAt: number | null;
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
    const classification = classifyApprovalRequest(request);
    const base = {
      hermesRunId: request.runId,
      requestId: request.requestId,
      tier: classification.tier,
      reasons: classification.reasons,
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

    let decision: AdapterApprovalDecision;
    if (!input.config.enabled) {
      decision = { decision: "unavailable", decidedBy: "system", note: "Approval routing is disabled in adapterConfig.approvalRouting." };
    } else if (!input.ctx.onApprovalRequest) {
      decision = { decision: "unavailable", decidedBy: "system", note: "This Paperclip host cannot route approval requests." };
    } else {
      const remaining = input.runDeadlineAt === null ? Number.POSITIVE_INFINITY : input.runDeadlineAt - Date.now() - RUN_DEADLINE_RESERVE_MS;
      const timeoutMs = Math.max(0, Math.min(input.config.boardTimeoutMs, remaining));
      try {
        decision = await input.ctx.onApprovalRequest({
          requestId: request.requestId,
          providerRunId: request.runId,
          tier: classification.tier,
          route,
          supervisorAgentId: route === "supervisor" ? supervisorAgentId : null,
          command,
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

    if (input.signal.aborted && decision.decision !== "approved" && decision.decision !== "denied") {
      await emit("adapter.approval.abandoned", "warn", `request ${request.requestId} abandoned: run ended before a decision`, { ...base, decision: decision.decision });
      return;
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
        ? "approved under delegated supervisor policy"
        : decision.decision === "approved"
          ? "approved by the board"
          : decision.decision === "denied"
            ? "denied by the board"
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
