import { and, eq, inArray, like } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, issues, projects } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";

/**
 * Wake reason for a parent issue's agent assignee when a direct child issue
 * stops making progress on its own: the child's worker parked it for review or
 * blocked it, handed it back, gave it away to a user or unassigned it, or left
 * a pending card (issue-thread interaction) on it.
 *
 * Without this wake the lead agent is only told about a child when the child
 * completes (`issue_children_completed`) or one of its blockers resolves
 * (`issue_blockers_resolved`), so a delegated sub-task that parks silently
 * stalls the whole tree.
 */
export const ISSUE_CHILD_NEEDS_ATTENTION_WAKE_REASON = "issue_child_needs_attention";

/**
 * Durable intent rows for this reason are written inside the transaction that
 * makes the child need attention (interaction creation, native status
 * commitment) and are bridged into the heartbeat scheduler by
 * `dispatchPendingNativeStatusWakeups`, which applies the normal admission
 * policy. Route-time HTTP mutations enqueue through `heartbeat.wakeup` directly.
 */
export const ISSUE_CHILD_ATTENTION_WAKE_INTENT_ACTOR_ID = "issue-child-attention";

export type IssueChildAttentionTrigger =
  | "interaction_created"
  | "status_changed"
  | "assignee_changed";

/**
 * Any attention event for a (parent, child) pair coalesces while an earlier
 * wake for that pair is still pending or running, whatever its trigger. One
 * normal park (card, then `in_review`) is one lead run, and replacement cards
 * do not stack wakes. A completed wake does not suppress a later occurrence: a
 * child can park, be resumed, and park again, and the lead must hear about the
 * second stop too.
 */
const IN_FLIGHT_CHILD_ATTENTION_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
] as const;

const ATTENTION_STATUSES = new Set(["in_review", "blocked"]);
const HAND_BACK_STATUSES = new Set(["backlog", "todo"]);
const CLOSED_PARENT_STATUSES = new Set(["done", "cancelled"]);

type ChildAssignmentState = {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

export type IssueChildAttentionTransition =
  | { trigger: "status_changed"; status: string; previousStatus: string }
  | {
      trigger: "assignee_changed";
      status: string;
      assigneeUserId: string | null;
      previousAssigneeAgentId: string | null;
      previousAssigneeUserId: string | null;
    };

/**
 * Classify a child issue update. Returns null when the update does not need the
 * parent's attention. A status transition wins over a simultaneous assignee
 * change so one update produces at most one wake.
 */
export function classifyIssueChildAttentionTransition(
  previous: ChildAssignmentState,
  next: ChildAssignmentState,
): IssueChildAttentionTransition | null {
  if (previous.status !== next.status) {
    if (ATTENTION_STATUSES.has(next.status)) {
      return { trigger: "status_changed", status: next.status, previousStatus: previous.status };
    }
    if (previous.status === "in_progress" && HAND_BACK_STATUSES.has(next.status)) {
      return { trigger: "status_changed", status: next.status, previousStatus: previous.status };
    }
  }
  const hadAssignee = Boolean(previous.assigneeAgentId || previous.assigneeUserId);
  const cleared = hadAssignee && !next.assigneeAgentId && !next.assigneeUserId;
  const changedToUser =
    Boolean(next.assigneeUserId) && next.assigneeUserId !== previous.assigneeUserId;
  if (cleared || changedToUser) {
    return {
      trigger: "assignee_changed",
      status: next.status,
      assigneeUserId: next.assigneeUserId,
      previousAssigneeAgentId: previous.assigneeAgentId,
      previousAssigneeUserId: previous.assigneeUserId,
    };
  }
  return null;
}

export function buildIssueChildNeedsAttentionIdempotencyKey(input: {
  parentIssueId: string;
  childIssueId: string;
  trigger: IssueChildAttentionTrigger;
  /** Status for `status_changed`, interaction id for `interaction_created`, new assignee for `assignee_changed`. */
  discriminator: string;
}) {
  return [
    ISSUE_CHILD_NEEDS_ATTENTION_WAKE_REASON,
    input.parentIssueId,
    input.childIssueId,
    input.trigger,
    input.discriminator,
  ].join(":");
}

export type IssueChildAttentionEvent =
  | IssueChildAttentionTransition
  | {
      trigger: "interaction_created";
      interactionId: string;
      interactionKind: string;
    };

export type IssueChildAttentionActor = {
  /** Agent that made the change, if any. Used to suppress self-wakes. */
  agentId?: string | null;
};

export type IssueChildNeedsAttentionWakePlan = {
  companyId: string;
  parentIssueId: string;
  parentAgentId: string;
  childIssueId: string;
  childIdentifier: string | null;
  idempotencyKey: string;
  /** Wake payload and context share these fields. */
  context: Record<string, unknown>;
};

function discriminatorFor(event: IssueChildAttentionEvent) {
  switch (event.trigger) {
    case "interaction_created":
      return event.interactionId;
    case "status_changed":
      return event.status;
    case "assignee_changed":
      return event.assigneeUserId ? `user-${event.assigneeUserId}` : "cleared";
  }
}

function summaryFor(event: IssueChildAttentionEvent, childStatus: string) {
  switch (event.trigger) {
    case "interaction_created":
      // The card title is worker-authored. Keep it out of the lead's prompt;
      // the lead reads the card on the child thread.
      return `Child left a pending ${event.interactionKind} card and is waiting on it.`;
    case "status_changed":
      return ATTENTION_STATUSES.has(event.status)
        ? `Child moved from ${event.previousStatus} to ${event.status}. Its assignee stopped working on it.`
        : `Child was handed back from ${event.previousStatus} to ${event.status}.`;
    case "assignee_changed":
      return event.assigneeUserId
        ? `Child was reassigned to a user (status ${childStatus}).`
        : `Child assignee was cleared (status ${childStatus}).`;
  }
}

/**
 * Decide whether a child attention event should wake the parent's agent
 * assignee. Returns null when the wake must be skipped:
 * - the child has no parent, or the parent has no agent assignee;
 * - the parent is `done` or `cancelled`, or is an agent conversation;
 * - the actor making the change is the parent's assignee (no self-wake);
 * - the parent's assignee is also the child's assignee;
 * - a wake for the same (parent, child) pair is still in flight (coalesce).
 */
export async function planIssueChildNeedsAttentionWake(
  db: Db,
  input: {
    companyId: string;
    childIssueId: string;
    event: IssueChildAttentionEvent;
    actor: IssueChildAttentionActor;
  },
): Promise<IssueChildNeedsAttentionWakePlan | null> {
  const child = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      parentId: issues.parentId,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      projectId: issues.projectId,
      executionPolicy: issues.executionPolicy,
    })
    .from(issues)
    .where(and(eq(issues.id, input.childIssueId), eq(issues.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!child?.parentId) return null;

  const parent = await db
    .select({
      id: issues.id,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      conversationAgentId: issues.conversationAgentId,
    })
    .from(issues)
    .where(and(eq(issues.id, child.parentId), eq(issues.companyId, child.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!parent?.assigneeAgentId) return null;
  if (CLOSED_PARENT_STATUSES.has(parent.status)) return null;
  // Agent conversations never take execution wakes from tasks.
  if (parent.conversationAgentId) return null;
  if (input.actor.agentId && input.actor.agentId === parent.assigneeAgentId) return null;
  if (child.assigneeAgentId && child.assigneeAgentId === parent.assigneeAgentId) return null;

  const idempotencyKey = buildIssueChildNeedsAttentionIdempotencyKey({
    parentIssueId: parent.id,
    childIssueId: child.id,
    trigger: input.event.trigger,
    discriminator: discriminatorFor(input.event),
  });
  const inFlight = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, child.companyId),
        eq(agentWakeupRequests.agentId, parent.assigneeAgentId),
        inArray(agentWakeupRequests.status, [...IN_FLIGHT_CHILD_ATTENTION_WAKE_STATUSES]),
        like(
          agentWakeupRequests.idempotencyKey,
          `${ISSUE_CHILD_NEEDS_ATTENTION_WAKE_REASON}:${parent.id}:${child.id}:%`,
        ),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (inFlight) return null;

  const event = input.event;
  const childStatus = event.trigger === "interaction_created" ? child.status : event.status;
  // The child title is worker-authored. Bound it, and leave it out entirely
  // for review-contained or low-trust children, whose content must not reach
  // a higher-trust lead's prompt.
  const title = (await childRunsUnderStandardTrust(db, child))
    ? truncateChildTitle(child.title)
    : null;
  const context: Record<string, unknown> = {
    issueId: parent.id,
    taskId: parent.id,
    childIssueId: child.id,
    childIdentifier: child.identifier ?? null,
    trigger: event.trigger,
    childStatus,
    ...(event.trigger === "status_changed"
      ? { newStatus: event.status, previousStatus: event.previousStatus }
      : {}),
    ...(event.trigger === "assignee_changed"
      ? { newStatus: event.status, childAssigneeUserId: event.assigneeUserId }
      : {}),
    ...(event.trigger === "interaction_created"
      ? { childInteractionId: event.interactionId, interactionKind: event.interactionKind }
      : {}),
    // Rendered by the wake prompt as a "Direct child issue summaries" section.
    childIssueSummaries: [
      {
        id: child.id,
        identifier: child.identifier ?? null,
        ...(title ? { title } : {}),
        status: childStatus,
        summary: summaryFor(event, childStatus),
      },
    ],
  };
  return {
    companyId: child.companyId,
    parentIssueId: parent.id,
    parentAgentId: parent.assigneeAgentId,
    childIssueId: child.id,
    childIdentifier: child.identifier ?? null,
    idempotencyKey,
    context,
  };
}

export const CHILD_ATTENTION_TITLE_MAX_LENGTH = 120;

function truncateChildTitle(title: string | null | undefined) {
  const trimmed = title?.trim();
  if (!trimmed) return null;
  return trimmed.length > CHILD_ATTENTION_TITLE_MAX_LENGTH
    ? `${trimmed.slice(0, CHILD_ATTENTION_TITLE_MAX_LENGTH - 1)}…`
    : trimmed;
}

async function childRunsUnderStandardTrust(
  db: Db,
  child: {
    companyId: string;
    assigneeAgentId: string | null;
    projectId: string | null;
    executionPolicy: unknown;
  },
) {
  const agent = child.assigneeAgentId
    ? await db
        .select({ companyId: agents.companyId, permissions: agents.permissions })
        .from(agents)
        .where(and(eq(agents.id, child.assigneeAgentId), eq(agents.companyId, child.companyId)))
        .then((rows) => rows[0] ?? null)
    : null;
  const project = child.projectId
    ? await db
        .select({
          companyId: projects.companyId,
          executionWorkspacePolicy: projects.executionWorkspacePolicy,
        })
        .from(projects)
        .where(and(eq(projects.id, child.projectId), eq(projects.companyId, child.companyId)))
        .then((rows) => rows[0] ?? null)
    : null;
  return (
    resolveCoreTrustPreset({
      companyId: child.companyId,
      agent,
      project,
      issue: { companyId: child.companyId, executionPolicy: child.executionPolicy },
    }).kind === "standard"
  );
}

/** Wake request for `heartbeat.wakeup`, matching the `issue_children_completed` route shape. */
export function buildIssueChildNeedsAttentionWakeRequest(
  plan: IssueChildNeedsAttentionWakePlan,
  requestedBy: { actorType: "user" | "agent" | "system"; actorId: string | null },
) {
  return {
    source: "automation" as const,
    triggerDetail: "system" as const,
    reason: ISSUE_CHILD_NEEDS_ATTENTION_WAKE_REASON,
    payload: { ...plan.context },
    idempotencyKey: plan.idempotencyKey,
    requestedByActorType: requestedBy.actorType,
    requestedByActorId: requestedBy.actorId,
    contextSnapshot: {
      ...plan.context,
      wakeReason: ISSUE_CHILD_NEEDS_ATTENTION_WAKE_REASON,
      source: "issue.child_needs_attention",
    },
  };
}

/**
 * Persist a durable wake intent in the caller's transaction. The heartbeat
 * scheduler bridges it into a real wake (see
 * `ISSUE_CHILD_ATTENTION_WAKE_INTENT_ACTOR_ID`). Returns the intent row id.
 */
export async function insertIssueChildNeedsAttentionWakeIntent(
  db: Db,
  plan: IssueChildNeedsAttentionWakePlan,
) {
  const [row] = await db
    .insert(agentWakeupRequests)
    .values({
      companyId: plan.companyId,
      agentId: plan.parentAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: ISSUE_CHILD_NEEDS_ATTENTION_WAKE_REASON,
      payload: {
        ...plan.context,
        _paperclipWakeContext: {
          ...plan.context,
          wakeReason: ISSUE_CHILD_NEEDS_ATTENTION_WAKE_REASON,
          source: "issue.child_needs_attention",
        },
      },
      requestedByActorType: "system",
      requestedByActorId: ISSUE_CHILD_ATTENTION_WAKE_INTENT_ACTOR_ID,
      idempotencyKey: plan.idempotencyKey,
    })
    .returning({ id: agentWakeupRequests.id });
  if (!row) throw new Error("issue_child_attention_wake_not_persisted");
  return row.id;
}

/**
 * Plan and persist a parent wake intent for a newly pending card on a child
 * issue. Safe to call for any issue: non-child issues and skipped cases are a
 * no-op. Returns the intent id, or null when nothing was enqueued.
 */
export type IssueChildAttentionInteraction = {
  id: string;
  kind: string;
  addresseeUserId?: string | null;
  effectiveResolverPolicy?: string | null;
  effectiveResolverPolicySource?: string | null;
};

/**
 * Cards only a human can answer do not wake the lead: the lead cannot act on
 * them. This covers human-only cards addressed to a specific user (connection
 * and tool-authorization cards) and human-only governed actions (secret
 * bindings). Question and confirmation cards that the lead or a board user can
 * answer still wake the lead.
 */
export function isHumanOnlyChildCard(interaction: IssueChildAttentionInteraction) {
  if (interaction.effectiveResolverPolicy !== "human_only") return false;
  return Boolean(interaction.addresseeUserId) ||
    interaction.effectiveResolverPolicySource === "governed_action";
}

export async function enqueueIssueChildInteractionAttentionWake(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    interaction: IssueChildAttentionInteraction;
    actor: IssueChildAttentionActor;
  },
) {
  if (isHumanOnlyChildCard(input.interaction)) return null;
  const plan = await planIssueChildNeedsAttentionWake(db, {
    companyId: input.companyId,
    childIssueId: input.issueId,
    actor: input.actor,
    event: {
      trigger: "interaction_created",
      interactionId: input.interaction.id,
      interactionKind: input.interaction.kind,
    },
  });
  if (!plan) return null;
  return insertIssueChildNeedsAttentionWakeIntent(db, plan);
}

/**
 * Same as `enqueueIssueChildInteractionAttentionWake`, isolated in a nested
 * transaction (a savepoint when `db` is already a transaction) so a failure to
 * notify the parent never rolls back the card that triggered it.
 */
export async function enqueueIssueChildInteractionAttentionWakeSafely(
  db: Db,
  input: Parameters<typeof enqueueIssueChildInteractionAttentionWake>[1],
) {
  try {
    return await db.transaction((sp) =>
      enqueueIssueChildInteractionAttentionWake(sp as unknown as Db, input),
    );
  } catch (err) {
    logger.warn(
      { err, issueId: input.issueId, interactionId: input.interaction.id },
      "failed to enqueue parent wake for child issue interaction",
    );
    return null;
  }
}

/**
 * Route-time planning for a child issue update (PATCH or comment-driven status
 * change). Returns the parent agent and a `heartbeat.wakeup` request, or null.
 * Errors are logged and swallowed: notifying the parent is best-effort and must
 * never fail the child's update.
 */
export async function planIssueChildUpdateAttentionWakeup(
  db: Db,
  input: {
    previous: ChildAssignmentState & { id: string; companyId: string; parentId: string | null };
    next: ChildAssignmentState & { id: string; companyId: string; parentId: string | null };
    actor: { actorType: "user" | "agent" | "system"; actorId: string | null; agentId?: string | null };
  },
) {
  if (!input.next.parentId) return null;
  const transition = classifyIssueChildAttentionTransition(input.previous, input.next);
  if (!transition) return null;
  try {
    const plan = await planIssueChildNeedsAttentionWake(db, {
      companyId: input.next.companyId,
      childIssueId: input.next.id,
      event: transition,
      actor: { agentId: input.actor.agentId ?? null },
    });
    if (!plan) return null;
    return {
      agentId: plan.parentAgentId,
      parentIssueId: plan.parentIssueId,
      wakeup: buildIssueChildNeedsAttentionWakeRequest(plan, {
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
      }),
    };
  } catch (err) {
    logger.warn(
      { err, issueId: input.next.id, parentId: input.next.parentId },
      "failed to plan parent wake for child issue update",
    );
    return null;
  }
}

/**
 * Admission exception for a parent whose dependencies are unresolved. Leads
 * usually block the parent on the very child they delegated, so without this a
 * child that parks could never reach its lead. The wake is admitted (as a
 * bounded, triage-only dependency-blocked run) only when the waking child is
 * one of the parent's unresolved blockers or its direct child.
 */
export async function allowsDependencyBlockedChildAttentionWake(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    contextSnapshot: Record<string, unknown> | null | undefined;
    unresolvedBlockerIssueIds: readonly string[];
  },
) {
  const context = input.contextSnapshot ?? {};
  if (context.wakeReason !== ISSUE_CHILD_NEEDS_ATTENTION_WAKE_REASON) return false;
  const childIssueId = typeof context.childIssueId === "string" ? context.childIssueId : null;
  if (!childIssueId || childIssueId === input.issueId) return false;
  if (input.unresolvedBlockerIssueIds.includes(childIssueId)) return true;
  const child = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.id, childIssueId),
        eq(issues.companyId, input.companyId),
        eq(issues.parentId, input.issueId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return Boolean(child);
}
