import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  MAX_ANCESTOR_LEVELS,
  REMINDER_JOB_KEY,
  isUsableBoardUrl,
  normalizeConfig,
  type SlackAttentionConfig,
} from "./config.js";
import {
  formatApprovalAsk,
  formatApprovalReminder,
  formatCardAsk,
  formatResolved,
  isChannelAllowed,
  minutesLeft,
  parseSlackPermalink,
  parseSlackThreadLine,
  safeIdentifier,
  type FormattedAsk,
  type SlackThreadRef,
} from "./format.js";
import { createSlackClient, scrubSecrets, type SlackClient } from "./slack.js";

export type AskKind = "approval" | "interaction";

/**
 * Durable per-ask record in plugin state. `status` moves
 * posting -> posted -> resolved, or posting -> failed (retried by the job).
 * A record exists before the Slack call is made, so a restart can never post
 * the same ask twice (at most once; a crash mid-post leaves it in `posting`).
 */
export interface AskRecord {
  kind: AskKind;
  id: string;
  companyId: string;
  issueId: string | null;
  status: "posting" | "posted" | "failed" | "resolved";
  channel: string | null;
  ts: string | null;
  threadTs: string | null;
  text: string;
  headline: string;
  resolvedLinks: string;
  expiresAt: string | null;
  reminded: boolean;
  attempts: number;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OpenAskRef {
  kind: AskKind;
  id: string;
  companyId: string;
  createdAt: string;
}

const STATE_NAMESPACE = "slack-attention";
const OPEN_INDEX_KEY = "open-asks";
const MAX_POST_ATTEMPTS = 3;
const OPEN_ASK_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

const INTERACTION_CREATED_ACTION = "issue.thread_interaction_created";
const INTERACTION_RESOLUTION_ACTIONS = new Set([
  "issue.thread_interaction_answered",
  "issue.thread_interaction_accepted",
  "issue.thread_interaction_rejected",
  "issue.thread_interaction_cancelled",
  "issue.thread_interaction_withdrawn",
  "issue.thread_interaction_expired",
  "issue.thread_interaction_skipped",
  "issue.thread_interaction_item_verdicts_submitted",
  "issue.thread_interaction_updated",
]);
/** Fallback status when the host still reports `pending` for a closing action. */
const ACTION_STATUS_FALLBACK: Record<string, string> = {
  "issue.thread_interaction_withdrawn": "withdrawn",
};

function askKey(kind: AskKind, id: string) {
  return { scopeKind: "instance" as const, namespace: STATE_NAMESPACE, stateKey: `ask:${kind}:${id}` };
}
const openIndexKey = { scopeKind: "instance" as const, namespace: STATE_NAMESPACE, stateKey: OPEN_INDEX_KEY };

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export interface SlackAttentionOptions {
  now?: () => number;
}

export function registerSlackAttention(ctx: PluginContext, options: SlackAttentionOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const slack: SlackClient = createSlackClient(ctx.http);

  // Serialize work per ask (and on the shared index) inside this worker so two
  // events for the same ask cannot race past the state check.
  const locks = new Map<string, Promise<unknown>>();
  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  }

  async function loadConfig(companyId: string): Promise<SlackAttentionConfig> {
    return normalizeConfig(await ctx.config.get(companyId));
  }

  async function getRecord(kind: AskKind, id: string): Promise<AskRecord | null> {
    const value = await ctx.state.get(askKey(kind, id));
    return value && typeof value === "object" ? value as AskRecord : null;
  }

  async function putRecord(record: AskRecord): Promise<void> {
    await ctx.state.set(askKey(record.kind, record.id), { ...record, updatedAt: new Date(now()).toISOString() });
  }

  async function readIndex(): Promise<OpenAskRef[]> {
    const value = await ctx.state.get(openIndexKey);
    return Array.isArray(value) ? value as OpenAskRef[] : [];
  }

  function updateIndex(mutate: (refs: OpenAskRef[]) => OpenAskRef[]): Promise<void> {
    return withLock("index", async () => {
      await ctx.state.set(openIndexKey, mutate(await readIndex()));
    });
  }

  const addOpen = (ref: OpenAskRef) =>
    updateIndex((refs) => refs.some((r) => r.kind === ref.kind && r.id === ref.id) ? refs : [...refs, ref]);
  const removeOpen = (kind: AskKind, id: string) =>
    updateIndex((refs) => refs.filter((r) => !(r.kind === kind && r.id === id)));

  async function resolveToken(config: SlackAttentionConfig, companyId: string): Promise<string | null> {
    if (!config.slackBotTokenSecret) return null;
    const token = await ctx.secrets.resolve(config.slackBotTokenSecret, {
      companyId,
      configPath: "slackBotTokenSecret",
    });
    return readString(token);
  }

  function warn(message: string, meta: Record<string, unknown>, err?: unknown, token?: string | null) {
    const detail = err === undefined ? undefined : scrubSecrets(err instanceof Error ? err.message : String(err), token);
    ctx.logger.warn(message, detail === undefined ? meta : { ...meta, error: detail });
  }

  /** Walk the ask's issue and up to MAX_ANCESTOR_LEVELS parents for a Slack thread line. */
  async function findThread(companyId: string, issueId: string | null): Promise<{
    thread: SlackThreadRef | null;
    identifier: string | null;
  }> {
    let identifier: string | null = null;
    let currentId = issueId;
    const seen = new Set<string>();
    for (let level = 0; currentId && level <= MAX_ANCESTOR_LEVELS && !seen.has(currentId); level += 1) {
      seen.add(currentId);
      const issue = await ctx.issues.get(currentId, companyId);
      if (!issue) break;
      if (level === 0) identifier = safeIdentifier(issue.identifier);
      const thread = parseSlackThreadLine(issue.description);
      if (thread) return { thread, identifier };
      currentId = issue.parentId ?? null;
    }
    return { thread: null, identifier };
  }

  function pickChannel(config: SlackAttentionConfig, found: SlackThreadRef | null, meta: Record<string, unknown>) {
    if (found) {
      if (isChannelAllowed(found.channel, config.allowedChannelIds)) return found;
      warn("slack-attention: thread channel is not allowed; trying the fallback thread", { ...meta, channel: found.channel });
    }
    const fallback = parseSlackPermalink(config.fallbackThreadPermalink);
    if (fallback && isChannelAllowed(fallback.channel, config.allowedChannelIds)) return fallback;
    if (fallback) warn("slack-attention: fallback thread channel is not allowed", { ...meta, channel: fallback.channel });
    return null;
  }

  /**
   * Claim the ask in state, then post. Shared by approvals and cards. Returns
   * without posting when the ask was already claimed (idempotency).
   */
  async function postAsk(input: {
    kind: AskKind;
    id: string;
    companyId: string;
    issueId: string | null;
    config: SlackAttentionConfig;
    thread: SlackThreadRef;
    formatted: FormattedAsk;
    expiresAt: string | null;
    existing: AskRecord | null;
  }) {
    const nowIso = new Date(now()).toISOString();
    const record: AskRecord = {
      kind: input.kind,
      id: input.id,
      companyId: input.companyId,
      issueId: input.issueId,
      status: "posting",
      channel: input.thread.channel,
      ts: null,
      threadTs: input.thread.threadTs,
      text: input.formatted.text,
      headline: input.formatted.headline,
      resolvedLinks: input.formatted.resolvedLinks,
      expiresAt: input.expiresAt,
      reminded: input.existing?.reminded ?? false,
      attempts: (input.existing?.attempts ?? 0) + 1,
      resolution: null,
      createdAt: input.existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    await putRecord(record);
    await addOpen({ kind: input.kind, id: input.id, companyId: input.companyId, createdAt: record.createdAt });

    let token: string | null = null;
    try {
      token = await resolveToken(input.config, input.companyId);
      if (!token) throw new Error("Slack bot token secret is not configured");
      const posted = await slack.postMessage(token, {
        channel: input.thread.channel,
        threadTs: input.thread.threadTs,
        text: input.formatted.text,
      });
      await putRecord({ ...record, status: "posted", channel: posted.channel, ts: posted.ts });
      ctx.logger.info("slack-attention: posted ask", { kind: input.kind, id: input.id, channel: posted.channel });
    } catch (err) {
      await putRecord({ ...record, status: "failed" });
      warn("slack-attention: posting ask failed", { kind: input.kind, id: input.id }, err, token);
    }
  }

  function boardOf(config: SlackAttentionConfig) {
    return { boardBaseUrl: config.boardBaseUrl, companyUrlKey: config.companyUrlKey };
  }

  function configUsable(config: SlackAttentionConfig, meta: Record<string, unknown>): boolean {
    if (!config.slackBotTokenSecret) {
      warn("slack-attention: no Slack bot token secret configured for this company; skipping", meta);
      return false;
    }
    if (!isUsableBoardUrl(config.boardBaseUrl)) {
      warn("slack-attention: boardBaseUrl must be https and not localhost; skipping", meta);
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  async function handleApprovalCreated(companyId: string, approvalId: string, hintIssueIds: string[]) {
    await withLock(`approval:${approvalId}`, async () => {
      const existing = await getRecord("approval", approvalId);
      if (existing && existing.status !== "failed") return;
      if (existing && existing.attempts >= MAX_POST_ATTEMPTS) return;

      const approval = await ctx.approvals.get(approvalId, companyId);
      if (!approval || approval.status !== "pending") return;

      const config = await loadConfig(companyId);
      const meta = { kind: "approval", id: approvalId };
      if (!configUsable(config, meta)) return;

      const payload = asRecord(approval.payload);
      const issueId = readString(payload.issueId) ?? hintIssueIds[0] ?? null;
      const { thread: found, identifier } = await findThread(companyId, issueId);
      const thread = pickChannel(config, found, meta);
      if (!thread) {
        warn("slack-attention: no allowed Slack thread for approval; not posting", meta);
        return;
      }

      const agentId = readString(payload.agentId) ?? approval.requestedByAgentId;
      const agent = agentId ? await ctx.agents.get(agentId, companyId).catch(() => null) : null;
      const isCommandApproval = typeof payload.commandSha256 === "string" || payload.source === "adapter_approval";
      const expiresAt = readString(payload.expiresAt);
      const formatted = formatApprovalAsk({
        board: boardOf(config),
        approvalId,
        agentName: agent?.name ?? null,
        isCommandApproval,
        description: payload.description,
        expiresAt,
        childIdentifier: identifier,
        nowMs: now(),
      });
      await postAsk({
        kind: "approval", id: approvalId, companyId, issueId, config, thread, formatted, expiresAt, existing,
      });
    });
  }

  async function markResolved(record: AskRecord, resolution: string) {
    if (record.status === "resolved") return;
    if (record.status !== "posted" || !record.channel || !record.ts) {
      // Never posted (failed/posting): just stop tracking it.
      await putRecord({ ...record, status: "resolved", resolution });
      await removeOpen(record.kind, record.id);
      return;
    }
    const config = await loadConfig(record.companyId);
    let token: string | null = null;
    try {
      token = await resolveToken(config, record.companyId);
      if (!token) throw new Error("Slack bot token secret is not configured");
      await slack.updateMessage(token, {
        channel: record.channel,
        ts: record.ts,
        text: formatResolved({
          kind: record.kind,
          status: resolution,
          headline: record.headline,
          resolvedLinks: record.resolvedLinks,
        }),
      });
      await putRecord({ ...record, status: "resolved", resolution });
      await removeOpen(record.kind, record.id);
      ctx.logger.info("slack-attention: marked ask resolved", { kind: record.kind, id: record.id, resolution });
    } catch (err) {
      // Leave it open; the reconcile job retries the update.
      warn("slack-attention: updating resolved ask failed", { kind: record.kind, id: record.id }, err, token);
    }
  }

  async function reconcileApproval(companyId: string, approvalId: string) {
    await withLock(`approval:${approvalId}`, async () => {
      const record = await getRecord("approval", approvalId);
      if (!record || record.status === "resolved") return;
      const approval = await ctx.approvals.get(approvalId, record.companyId || companyId);
      if (!approval) {
        await markResolved(record, "cancelled");
        return;
      }
      if (approval.status !== "pending") await markResolved(record, approval.status);
    });
  }

  // -------------------------------------------------------------------------
  // Decision cards (issue-thread interactions)
  // -------------------------------------------------------------------------

  async function loadInteraction(companyId: string, issueId: string, interactionId: string) {
    const interactions = await ctx.issues.listInteractions(issueId, companyId);
    return interactions.find((interaction) => interaction.id === interactionId) ?? null;
  }

  async function handleInteractionCreated(companyId: string, issueId: string, interactionId: string) {
    await withLock(`interaction:${interactionId}`, async () => {
      const existing = await getRecord("interaction", interactionId);
      if (existing && existing.status !== "failed") return;
      if (existing && existing.attempts >= MAX_POST_ATTEMPTS) return;

      const interaction = await loadInteraction(companyId, issueId, interactionId);
      if (!interaction) return;
      if (interaction.status !== "pending" || interaction.effectiveResolverPolicy !== "human_only") return;

      const config = await loadConfig(companyId);
      const meta = { kind: "interaction", id: interactionId };
      if (!configUsable(config, meta)) return;

      const { thread: found, identifier } = await findThread(companyId, issueId);
      if (!identifier) {
        warn("slack-attention: card issue has no usable identifier; not posting", meta);
        return;
      }
      const thread = pickChannel(config, found, meta);
      if (!thread) {
        warn("slack-attention: no allowed Slack thread for card; not posting", meta);
        return;
      }
      const formatted = formatCardAsk({ board: boardOf(config), identifier, payload: interaction.payload });
      await postAsk({
        kind: "interaction", id: interactionId, companyId, issueId, config, thread, formatted, expiresAt: null, existing,
      });
    });
  }

  async function reconcileInteraction(companyId: string, interactionId: string, action: string | null) {
    await withLock(`interaction:${interactionId}`, async () => {
      const record = await getRecord("interaction", interactionId);
      if (!record || record.status === "resolved" || !record.issueId) return;
      const interaction = await loadInteraction(record.companyId || companyId, record.issueId, interactionId);
      if (!interaction) {
        await markResolved(record, "cancelled");
        return;
      }
      if (interaction.status !== "pending") {
        await markResolved(record, interaction.status);
        return;
      }
      const fallback = action ? ACTION_STATUS_FALLBACK[action] : undefined;
      if (fallback) await markResolved(record, fallback);
    });
  }

  // -------------------------------------------------------------------------
  // Reminder + reconcile job
  // -------------------------------------------------------------------------

  async function runReminderJob() {
    const refs = await readIndex();
    const nowMs = now();
    for (const ref of refs) {
      try {
        if (nowMs - Date.parse(ref.createdAt) > OPEN_ASK_RETENTION_MS) {
          await removeOpen(ref.kind, ref.id);
          continue;
        }
        if (ref.kind === "interaction") {
          const record = await getRecord("interaction", ref.id);
          if (record?.status === "failed" && record.issueId) {
            await handleInteractionCreated(ref.companyId, record.issueId, ref.id);
          }
          await reconcileInteraction(ref.companyId, ref.id, null);
          continue;
        }

        const before = await getRecord("approval", ref.id);
        if (before?.status === "failed") await handleApprovalCreated(ref.companyId, ref.id, []);
        await reconcileApproval(ref.companyId, ref.id);
        await withLock(`approval:${ref.id}`, () => maybeRemind(ref.id, nowMs));
      } catch (err) {
        warn("slack-attention: reconcile failed for ask", { kind: ref.kind, id: ref.id }, err);
      }
    }
  }

  async function maybeRemind(approvalId: string, nowMs: number) {
    const record = await getRecord("approval", approvalId);
    if (!record || record.status !== "posted" || record.reminded || !record.channel || !record.threadTs) return;
    const left = minutesLeft(record.expiresAt, nowMs);
    if (left === null || left <= 0) return;
    const config = await loadConfig(record.companyId);
    if (!config.reminderEnabled || left >= config.reminderMinutes) return;
    if (!isChannelAllowed(record.channel, config.allowedChannelIds)) return;

    // Mark first: one reminder at most, even if the post below fails or the
    // worker restarts mid-call.
    await putRecord({ ...record, reminded: true });
    let token: string | null = null;
    try {
      token = await resolveToken(config, record.companyId);
      if (!token) throw new Error("Slack bot token secret is not configured");
      await slack.postMessage(token, {
        channel: record.channel,
        threadTs: record.threadTs,
        text: formatApprovalReminder({ board: boardOf(config), approvalId, minutesLeft: left }),
      });
    } catch (err) {
      warn("slack-attention: posting reminder failed", { kind: "approval", id: approvalId }, err, token);
    }
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  async function onApprovalCreated(event: PluginEvent) {
    const approvalId = readString(event.entityId);
    if (!approvalId) return;
    const payload = asRecord(event.payload);
    const issueIds = Array.isArray(payload.issueIds)
      ? payload.issueIds.filter((value): value is string => typeof value === "string")
      : [];
    await handleApprovalCreated(event.companyId, approvalId, issueIds);
  }

  async function onApprovalDecided(event: PluginEvent) {
    const approvalId = readString(event.entityId);
    if (approvalId) await reconcileApproval(event.companyId, approvalId);
  }

  async function onActivityLogged(event: PluginEvent) {
    const payload = asRecord(event.payload);
    const action = readString(payload.action);
    if (!action) return;
    const details = asRecord(payload.details);
    const entityType = readString(payload.entityType) ?? event.entityType ?? null;
    const entityId = readString(payload.entityId) ?? readString(event.entityId);

    if (action === INTERACTION_CREATED_ACTION) {
      const interactionId = readString(details.interactionId);
      // Cheap pre-filter; the loaded interaction is authoritative.
      if (details.effectiveResolverPolicy !== undefined && details.effectiveResolverPolicy !== "human_only") return;
      if (interactionId && entityType === "issue" && entityId) {
        await handleInteractionCreated(event.companyId, entityId, interactionId);
      }
      return;
    }
    if (INTERACTION_RESOLUTION_ACTIONS.has(action)) {
      const interactionId = readString(details.interactionId);
      if (interactionId) await reconcileInteraction(event.companyId, interactionId, action);
      return;
    }
    // Any other activity on an approval we posted (timeouts, cancellations,
    // late approvals) may have closed it without an approval.decided event.
    if (entityType === "approval" && entityId && action !== "approval.created") {
      await reconcileApproval(event.companyId, entityId);
    }
  }

  ctx.events.on("approval.created", onApprovalCreated);
  ctx.events.on("approval.decided", onApprovalDecided);
  ctx.events.on("activity.logged", onActivityLogged);
  ctx.jobs.register(REMINDER_JOB_KEY, async () => {
    await runReminderJob();
  });

  return { runReminderJob };
}
