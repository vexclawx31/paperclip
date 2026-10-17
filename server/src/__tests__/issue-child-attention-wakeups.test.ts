import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ISSUE_CHILD_ATTENTION_WAKE_INTENT_ACTOR_ID,
  ISSUE_CHILD_NEEDS_ATTENTION_WAKE_REASON,
  classifyIssueChildAttentionTransition,
  enqueueIssueChildInteractionAttentionWake,
  planIssueChildUpdateAttentionWakeup,
} from "../services/issue-child-attention-wakeups.ts";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres child attention wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("classifyIssueChildAttentionTransition", () => {
  const base = { status: "in_progress", assigneeAgentId: "worker", assigneeUserId: null };

  it.each(["in_review", "blocked"])("flags a move to %s", (status) => {
    expect(classifyIssueChildAttentionTransition(base, { ...base, status })).toMatchObject({
      trigger: "status_changed",
      status,
      previousStatus: "in_progress",
    });
  });

  it.each(["todo", "backlog"])("flags a hand-back from in_progress to %s", (status) => {
    expect(classifyIssueChildAttentionTransition(base, { ...base, status })).toMatchObject({
      trigger: "status_changed",
      status,
    });
  });

  it("ignores todo/backlog moves that are not a hand-back, and completion", () => {
    expect(
      classifyIssueChildAttentionTransition({ ...base, status: "backlog" }, { ...base, status: "todo" }),
    ).toBeNull();
    expect(classifyIssueChildAttentionTransition(base, { ...base, status: "done" })).toBeNull();
    expect(classifyIssueChildAttentionTransition(base, base)).toBeNull();
  });

  it("flags an assignee cleared or changed to a user", () => {
    expect(
      classifyIssueChildAttentionTransition(base, { ...base, assigneeAgentId: null }),
    ).toMatchObject({ trigger: "assignee_changed", assigneeUserId: null });
    expect(
      classifyIssueChildAttentionTransition(base, { ...base, assigneeAgentId: null, assigneeUserId: "user-1" }),
    ).toMatchObject({ trigger: "assignee_changed", assigneeUserId: "user-1" });
    expect(
      classifyIssueChildAttentionTransition(base, { ...base, assigneeAgentId: "other-agent" }),
    ).toBeNull();
  });

  it("reports one status wake when status and assignee change together", () => {
    expect(
      classifyIssueChildAttentionTransition(base, { status: "todo", assigneeAgentId: null, assigneeUserId: null }),
    ).toMatchObject({ trigger: "status_changed", status: "todo" });
  });
});

describeEmbeddedPostgres("issue child needs-attention wakes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-child-attention-wakes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedTree(options: { parentStatus?: string; childAssignee?: "worker" | "lead" } = {}) {
    const companyId = randomUUID();
    const leadAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    const prefix = `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Child attention",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values(
      [
        { id: leadAgentId, name: "Orca" },
        { id: workerAgentId, name: "Clipy" },
      ].map((agent) => ({
        ...agent,
        companyId,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );
    await db.insert(issues).values({
      id: parentId,
      companyId,
      identifier: `${prefix}-152`,
      title: "Lead task",
      status: options.parentStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: leadAgentId,
    });
    await db.insert(issues).values({
      id: childId,
      companyId,
      identifier: `${prefix}-159`,
      title: "Delegated sub-task",
      status: "in_progress",
      priority: "medium",
      parentId,
      assigneeAgentId: options.childAssignee === "lead" ? leadAgentId : workerAgentId,
    });
    const child = await db.select().from(issues).where(eq(issues.id, childId)).then((rows) => rows[0]!);
    return { companyId, leadAgentId, workerAgentId, parentId, childId, child, prefix };
  }

  async function intentsFor(companyId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.reason, ISSUE_CHILD_NEEDS_ATTENTION_WAKE_REASON),
        ),
      );
  }

  function workerActor(agentId: string) {
    return { actorType: "agent" as const, actorId: agentId, agentId };
  }

  it("a card created on a child persists a parent wake intent for the parent's agent", async () => {
    const tree = await seedTree();
    const interaction = await issueThreadInteractionService(db).create(
      { id: tree.childId, companyId: tree.companyId },
      {
        kind: "ask_user_questions",
        title: "Which connection should I use?",
        payload: {
          version: 1,
          questions: [
            {
              id: "connection",
              prompt: "Which connection should I use?",
              selectionMode: "single",
              options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
              ],
            },
          ],
        },
      },
      { agentId: tree.workerAgentId },
    );

    const intents = await intentsFor(tree.companyId);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      agentId: tree.leadAgentId,
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: ISSUE_CHILD_ATTENTION_WAKE_INTENT_ACTOR_ID,
      idempotencyKey: `${ISSUE_CHILD_NEEDS_ATTENTION_WAKE_REASON}:${tree.parentId}:${tree.childId}:interaction_created:${interaction.id}`,
    });
    expect(intents[0]!.payload).toMatchObject({
      issueId: tree.parentId,
      childIssueId: tree.childId,
      childIdentifier: `${tree.prefix}-159`,
      trigger: "interaction_created",
      interactionKind: "ask_user_questions",
      childInteractionId: interaction.id,
      _paperclipWakeContext: expect.objectContaining({
        wakeReason: ISSUE_CHILD_NEEDS_ATTENTION_WAKE_REASON,
        childIssueId: tree.childId,
      }),
    });
  });

  it.each(["in_review", "blocked"])("a worker moving the child to %s wakes the parent's agent", async (status) => {
    const tree = await seedTree();
    const result = await planIssueChildUpdateAttentionWakeup(db, {
      previous: tree.child,
      next: { ...tree.child, status },
      actor: workerActor(tree.workerAgentId),
    });
    expect(result).toMatchObject({
      agentId: tree.leadAgentId,
      parentIssueId: tree.parentId,
      wakeup: {
        reason: ISSUE_CHILD_NEEDS_ATTENTION_WAKE_REASON,
        idempotencyKey: `${ISSUE_CHILD_NEEDS_ATTENTION_WAKE_REASON}:${tree.parentId}:${tree.childId}:status_changed:${status}`,
        payload: expect.objectContaining({
          issueId: tree.parentId,
          childIssueId: tree.childId,
          childIdentifier: `${tree.prefix}-159`,
          trigger: "status_changed",
          newStatus: status,
        }),
        contextSnapshot: expect.objectContaining({
          wakeReason: ISSUE_CHILD_NEEDS_ATTENTION_WAKE_REASON,
          childIssueSummaries: [expect.objectContaining({ id: tree.childId, status })],
        }),
      },
    });
  });

  it("a child handed back to a user wakes the parent with an assignee_changed trigger", async () => {
    const tree = await seedTree();
    const result = await planIssueChildUpdateAttentionWakeup(db, {
      previous: tree.child,
      next: { ...tree.child, assigneeAgentId: null, assigneeUserId: "board-user" },
      actor: workerActor(tree.workerAgentId),
    });
    expect(result?.wakeup.payload).toMatchObject({ trigger: "assignee_changed", childAssigneeUserId: "board-user" });
  });

  it("does not wake when the parent's assignee made the change", async () => {
    const tree = await seedTree();
    expect(
      await planIssueChildUpdateAttentionWakeup(db, {
        previous: tree.child,
        next: { ...tree.child, status: "blocked" },
        actor: workerActor(tree.leadAgentId),
      }),
    ).toBeNull();
    await enqueueIssueChildInteractionAttentionWake(db, {
      companyId: tree.companyId,
      issueId: tree.childId,
      interaction: { id: randomUUID(), kind: "request_confirmation" },
      actor: { agentId: tree.leadAgentId },
    });
    expect(await intentsFor(tree.companyId)).toHaveLength(0);
  });

  it.each(["done", "cancelled"])("does not wake when the parent is %s", async (parentStatus) => {
    const tree = await seedTree({ parentStatus });
    expect(
      await planIssueChildUpdateAttentionWakeup(db, {
        previous: tree.child,
        next: { ...tree.child, status: "in_review" },
        actor: workerActor(tree.workerAgentId),
      }),
    ).toBeNull();
    await enqueueIssueChildInteractionAttentionWake(db, {
      companyId: tree.companyId,
      issueId: tree.childId,
      interaction: { id: randomUUID(), kind: "request_confirmation" },
      actor: { agentId: tree.workerAgentId },
    });
    expect(await intentsFor(tree.companyId)).toHaveLength(0);
  });

  it("does not wake when the parent's assignee is also the child's assignee", async () => {
    const tree = await seedTree({ childAssignee: "lead" });
    expect(
      await planIssueChildUpdateAttentionWakeup(db, {
        previous: tree.child,
        next: { ...tree.child, status: "blocked" },
        actor: { actorType: "user", actorId: "board-user", agentId: null },
      }),
    ).toBeNull();
  });

  it("coalesces an identical repeat event while the first wake is in flight, and re-arms after it completes", async () => {
    const tree = await seedTree();
    const interaction = { id: randomUUID(), kind: "request_confirmation" };
    const input = {
      companyId: tree.companyId,
      issueId: tree.childId,
      interaction,
      actor: { agentId: tree.workerAgentId },
    };
    const firstIntentId = await enqueueIssueChildInteractionAttentionWake(db, input);
    expect(firstIntentId).toBeTruthy();
    expect(await enqueueIssueChildInteractionAttentionWake(db, input)).toBeNull();
    expect(await intentsFor(tree.companyId)).toHaveLength(1);

    // A route-time status wake with the same key is also coalesced.
    const statusInput = {
      previous: tree.child,
      next: { ...tree.child, status: "in_review" },
      actor: workerActor(tree.workerAgentId),
    };
    const statusWake = await planIssueChildUpdateAttentionWakeup(db, statusInput);
    expect(statusWake).not.toBeNull();
    await db.insert(agentWakeupRequests).values({
      companyId: tree.companyId,
      agentId: tree.leadAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: ISSUE_CHILD_NEEDS_ATTENTION_WAKE_REASON,
      payload: statusWake!.wakeup.payload,
      status: "claimed",
      idempotencyKey: statusWake!.wakeup.idempotencyKey,
    });
    expect(await planIssueChildUpdateAttentionWakeup(db, statusInput)).toBeNull();

    // Once the lead has processed the earlier wake, the child parking again is
    // new attention and must wake the lead again.
    await db
      .update(agentWakeupRequests)
      .set({ status: "completed" })
      .where(eq(agentWakeupRequests.companyId, tree.companyId));
    expect(await planIssueChildUpdateAttentionWakeup(db, statusInput)).not.toBeNull();
  });

  it("does not plan a needs-attention wake for a child completing (issue_children_completed owns that)", async () => {
    const tree = await seedTree();
    expect(
      await planIssueChildUpdateAttentionWakeup(db, {
        previous: tree.child,
        next: { ...tree.child, status: "done" },
        actor: workerActor(tree.workerAgentId),
      }),
    ).toBeNull();
  });

  it("ignores issues without a parent", async () => {
    const tree = await seedTree();
    await enqueueIssueChildInteractionAttentionWake(db, {
      companyId: tree.companyId,
      issueId: tree.parentId,
      interaction: { id: randomUUID(), kind: "request_confirmation" },
      actor: { agentId: tree.workerAgentId },
    });
    expect(await intentsFor(tree.companyId)).toHaveLength(0);
  });
});
