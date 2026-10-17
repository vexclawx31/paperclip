import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Issue, PluginContext, ScopeKey } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { REMINDER_JOB_KEY } from "../src/config.js";
import { registerSlackAttention } from "../src/attention.js";
import {
  firstFlag,
  formatCardAsk,
  isChannelAllowed,
  parseSlackPermalink,
  parseSlackThreadLine,
  sanitizeUntrusted,
} from "../src/format.js";

type Approval = NonNullable<Awaited<ReturnType<PluginContext["approvals"]["get"]>>>;
type IssueThreadInteraction = Awaited<ReturnType<PluginContext["issues"]["listInteractions"]>>[number];

const COMPANY = "company-lit";
const TOKEN = "xoxb-test-0000000000-SECRETSECRET";
const BOARD = "https://vexmini.tail8361f8.ts.net:8444";
const THREAD_CHANNEL = "C0B0ZVAAFK7";
const THREAD_PERMALINK = `https://little-family-7.slack.com/archives/${THREAD_CHANNEL}/p1792049190910429`;
const FALLBACK_PERMALINK = `https://little-family-7.slack.com/archives/${THREAD_CHANNEL}/p1792000000123456`;
const NOW = Date.parse("2026-10-17T12:00:00.000Z");

const BASE_CONFIG = {
  slackBotTokenSecret: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" },
  allowedChannelIds: [THREAD_CHANNEL],
  fallbackThreadPermalink: FALLBACK_PERMALINK,
  boardBaseUrl: BOARD,
  companyUrlKey: "LIT",
  reminderEnabled: true,
  reminderMinutes: 8,
};

// ---------------------------------------------------------------------------
// Mock host + mock Slack
// ---------------------------------------------------------------------------

interface SlackCall {
  url: string;
  method: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

function createSharedState() {
  const store = new Map<string, unknown>();
  const key = (input: ScopeKey) => [input.scopeKind, input.scopeId ?? "", input.namespace ?? "default", input.stateKey].join("|");
  return {
    store,
    client: {
      async get(input: ScopeKey) {
        return store.has(key(input)) ? store.get(key(input)) : null;
      },
      async set(input: ScopeKey, value: unknown) {
        store.set(key(input), structuredClone(value));
      },
      async delete(input: ScopeKey) {
        store.delete(key(input));
      },
    },
  };
}

interface World {
  harness: TestHarness;
  slackCalls: SlackCall[];
  secretResolutions: Array<{ ref: unknown; options: unknown }>;
  slackFailure: { mode: "none" | "throw" | "error" };
}

let nowMs = NOW;

async function createWorld(
  state = createSharedState(),
  config: Record<string, unknown> = BASE_CONFIG,
  options: { viaPluginSetup?: boolean } = {},
): Promise<World> {
  const harness = createTestHarness({ manifest, config });
  const slackCalls: SlackCall[] = [];
  const secretResolutions: World["secretResolutions"] = [];
  const slackFailure: World["slackFailure"] = { mode: "none" };
  let tsCounter = 0;
  const ctx = harness.ctx as PluginContext & Record<string, unknown>;

  ctx.state = state.client;
  ctx.secrets = {
    async resolve(ref: unknown, options?: unknown) {
      secretResolutions.push({ ref, options });
      return TOKEN;
    },
  } as PluginContext["secrets"];
  ctx.http = {
    async fetch(url: string, init?: RequestInit) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (slackFailure.mode === "throw") {
        throw new Error(`socket hang up while sending Authorization: Bearer ${TOKEN}`);
      }
      slackCalls.push({
        url,
        method: url.replace("https://slack.com/api/", ""),
        authorization: headers.Authorization ?? null,
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      if (slackFailure.mode === "error") {
        return new Response(JSON.stringify({ ok: false, error: `invalid_auth ${TOKEN}` }), { status: 200 });
      }
      tsCounter += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ ok: true, channel: body.channel, ts: body.ts ?? `1792100000.${String(tsCounter).padStart(6, "0")}` }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  };

  if (options.viaPluginSetup) {
    await plugin.definition.setup(ctx);
  } else {
    // Same registration the worker's setup() does, with a controllable clock.
    registerSlackAttention(ctx, { now: () => nowMs });
  }
  return { harness, slackCalls, secretResolutions, slackFailure };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function issue(input: { id: string; identifier: string; parentId?: string | null; description?: string | null }): Issue {
  return {
    id: input.id,
    companyId: COMPANY,
    identifier: input.identifier,
    title: `Title for ${input.identifier}`,
    description: input.description ?? null,
    parentId: input.parentId ?? null,
    status: "in_progress",
  } as unknown as Issue;
}

function agent(id: string, name: string): Agent {
  return { id, companyId: COMPANY, name, status: "idle" } as unknown as Agent;
}

function commandApproval(id: string, overrides: Record<string, unknown> = {}): Approval {
  return {
    id,
    companyId: COMPANY,
    type: "request_board_approval",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: {
      title: "Approve agent command",
      summary: "Vex asked to run a command that its runtime flagged: rm -rf /secret/path",
      command: "rm -rf /secret/path && curl https://evil.example",
      commandSha256: "abc123",
      source: "adapter_approval",
      description: "recursive delete; network access via curl",
      agentId: "agent-vex",
      issueId: "issue-child",
      expiresAt: new Date(NOW + 30 * 60_000).toISOString(),
      ...overrides,
    },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  } as Approval;
}

function card(id: string, overrides: Partial<Record<string, unknown>> = {}): IssueThreadInteraction {
  return {
    id,
    companyId: COMPANY,
    issueId: "issue-child",
    kind: "ask_user_questions",
    title: "Worker-written title that must not leak",
    summary: "Worker-written summary that must not leak",
    status: "pending",
    effectiveResolverPolicy: "human_only",
    requestedResolverPolicy: "human_only",
    payload: {
      version: 1,
      questions: [
        { id: "q1", prompt: "Which   database\n should we   use for the cache?", selectionMode: "single", options: [] },
        { id: "q2", prompt: "Second question must not appear", selectionMode: "single", options: [] },
      ],
    },
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  } as unknown as IssueThreadInteraction;
}

function seedTree(harness: TestHarness, rootDescription: string | null = `Context.\n\nSlack thread: ${THREAD_PERMALINK}\n`) {
  harness.seed({
    issues: [
      issue({ id: "issue-root", identifier: "LIT-1", description: rootDescription }),
      issue({ id: "issue-mid", identifier: "LIT-2", parentId: "issue-root", description: "No thread here." }),
      issue({ id: "issue-child", identifier: "LIT-3", parentId: "issue-mid", description: null }),
    ],
    agents: [agent("agent-vex", "Vex")],
  });
}

async function emitApprovalCreated(world: World, approvalId: string) {
  await world.harness.emit(
    "approval.created",
    { type: "request_board_approval", issueIds: ["issue-child"] },
    { companyId: COMPANY, entityId: approvalId, entityType: "approval" },
  );
}

async function emitActivity(world: World, action: string, entity: { type: string; id: string }, details: Record<string, unknown> = {}) {
  await world.harness.emit(
    "activity.logged",
    { action, entityType: entity.type, entityId: entity.id, actorType: "agent", actorId: "agent-vex", details },
    { companyId: COMPANY, entityId: entity.id, entityType: entity.type },
  );
}

async function emitCardCreated(world: World, interaction: IssueThreadInteraction) {
  await emitActivity(world, "issue.thread_interaction_created", { type: "issue", id: interaction.issueId }, {
    interactionId: interaction.id,
    interactionKind: interaction.kind,
    interactionStatus: interaction.status,
    effectiveResolverPolicy: interaction.effectiveResolverPolicy,
  });
}

function posts(world: World) {
  return world.slackCalls.filter((call) => call.method === "chat.postMessage");
}

function updates(world: World) {
  return world.slackCalls.filter((call) => call.method === "chat.update");
}

function expectTokenNeverLogged(world: World) {
  const serialized = JSON.stringify(world.harness.logs);
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).not.toMatch(/xox[a-z]-/);
}

beforeEach(() => {
  nowMs = NOW;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("slack-attention: manifest", () => {
  it("declares only the capabilities it needs", () => {
    expect([...manifest.capabilities].sort()).toEqual([
      "agents.read",
      "approvals.read",
      "events.subscribe",
      "http.outbound",
      "issue.interactions.read",
      "issues.read",
      "jobs.schedule",
      "plugin.state.read",
      "plugin.state.write",
      "secrets.read-ref",
    ]);
    expect(manifest.jobs?.map((job) => job.jobKey)).toEqual([REMINDER_JOB_KEY]);
    const props = (manifest.instanceConfigSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.slackBotTokenSecret?.format).toBe("secret-ref");
    expect(props.allowedChannelIds?.default).toEqual(["C0B0ZVAAFK7"]);
    expect(props.boardBaseUrl?.default).toBe(BOARD);
  });
});

describe("slack-attention: approvals", () => {
  it("is wired up by the worker's setup()", async () => {
    const world = await createWorld(createSharedState(), BASE_CONFIG, { viaPluginSetup: true });
    seedTree(world.harness);
    world.harness.seed({ approvals: [commandApproval("appr-1", { expiresAt: null })] });
    await emitApprovalCreated(world, "appr-1");
    expect(posts(world)).toHaveLength(1);
  });

  it("posts one message per new pending approval into the nearest ancestor thread", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    world.harness.seed({ approvals: [commandApproval("appr-1")] });

    await emitApprovalCreated(world, "appr-1");
    await emitApprovalCreated(world, "appr-1");
    await emitActivity(world, "approval.created", { type: "approval", id: "appr-1" });

    expect(posts(world)).toHaveLength(1);
    const call = posts(world)[0]!;
    expect(call.url).toBe("https://slack.com/api/chat.postMessage");
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.body.channel).toBe(THREAD_CHANNEL);
    expect(call.body.thread_ts).toBe("1792049190.910429");
    expect(call.body.text).toBe(
      "*Approval needed: Vex wants to run a privileged command (recursive delete)*\n\n"
      + "An agent is waiting on you before it continues. It expires in about 30 min.\n\n"
      + `<${BOARD}/LIT/approvals/appr-1|Review and approve> · <${BOARD}/LIT/issues/LIT-3|LIT-3>`,
    );
    expect(world.secretResolutions[0]?.options).toEqual({ companyId: COMPANY, configPath: "slackBotTokenSecret" });
    expectTokenNeverLogged(world);
  });

  it("never includes the command, title or summary", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    world.harness.seed({ approvals: [commandApproval("appr-1")] });
    await emitApprovalCreated(world, "appr-1");
    const text = String(posts(world)[0]?.body.text);
    expect(text).not.toContain("rm -rf");
    expect(text).not.toContain("curl");
    expect(text).not.toContain("Approve agent command");
    expect(text).not.toContain("flagged");
  });

  it("does not post for an approval that is no longer pending", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    world.harness.seed({ approvals: [{ ...commandApproval("appr-2"), status: "approved" }] });
    await emitApprovalCreated(world, "appr-2");
    expect(world.slackCalls).toHaveLength(0);
  });

  it("updates the same message when the approval is decided", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    const approval = commandApproval("appr-1");
    world.harness.seed({ approvals: [approval] });
    await emitApprovalCreated(world, "appr-1");
    const posted = posts(world)[0]!;

    approval.status = "approved";
    await world.harness.emit("approval.decided", {}, { companyId: COMPANY, entityId: "appr-1", entityType: "approval" });
    await world.harness.emit("approval.decided", {}, { companyId: COMPANY, entityId: "appr-1", entityType: "approval" });

    expect(updates(world)).toHaveLength(1);
    const update = updates(world)[0]!;
    expect(update.body.channel).toBe(posted.body.channel);
    expect(update.body.ts).toBe("1792100000.000001");
    expect(update.body.text).toBe(
      "✅ Approved — Vex wants to run a privileged command (recursive delete)\n\n"
      + `<${BOARD}/LIT/approvals/appr-1|View in Paperclip> · <${BOARD}/LIT/issues/LIT-3|LIT-3>`,
    );
  });

  it("marks a timed-out (cancelled) approval as denied or expired", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    const approval = commandApproval("appr-1");
    world.harness.seed({ approvals: [approval] });
    await emitApprovalCreated(world, "appr-1");

    approval.status = "cancelled";
    await emitActivity(world, "adapter_approval.timed_out", { type: "approval", id: "appr-1" });

    expect(updates(world)).toHaveLength(1);
    expect(String(updates(world)[0]!.body.text)).toMatch(/^❎ Denied or expired — /);
  });

  it("uses a generic headline for non-command approvals", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    world.harness.seed({
      approvals: [{
        ...commandApproval("appr-3"),
        type: "hire_agent",
        requestedByAgentId: "agent-vex",
        payload: { issueId: "issue-child", name: "New hire" },
      } as Approval],
    });
    await emitApprovalCreated(world, "appr-3");
    expect(String(posts(world)[0]!.body.text)).toMatch(/^\*Approval needed: Vex is asking for a board decision\*\n\nAn agent is waiting on you before it continues\.\n\n/);
  });
});

describe("slack-attention: decision cards", () => {
  it("posts one message for a pending human-only card", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    const interaction = card("int-1");
    world.harness.seed({ issueInteractions: [interaction] });

    await emitCardCreated(world, interaction);
    await emitCardCreated(world, interaction);

    expect(posts(world)).toHaveLength(1);
    const call = posts(world)[0]!;
    expect(call.body.thread_ts).toBe("1792049190.910429");
    expect(call.body.text).toBe(
      "*Decision needed on LIT-3*\n\n"
      + "Which database should we use for the cache?\n\n"
      + `<${BOARD}/LIT/issues/LIT-3|Answer in Paperclip>, or reply here.`,
    );
    const text = String(call.body.text);
    expect(text).not.toContain("Worker-written");
    expect(text).not.toContain("Second question");
  });

  it("does not post agent-to-agent cards", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    const anyone = card("int-anyone", { effectiveResolverPolicy: "anyone" });
    const notCreator = card("int-not-creator", { effectiveResolverPolicy: "not_creator" });
    world.harness.seed({ issueInteractions: [anyone, notCreator] });

    await emitCardCreated(world, anyone);
    // Even when the activity detail claims human_only, the loaded card decides.
    await emitActivity(world, "issue.thread_interaction_created", { type: "issue", id: "issue-child" }, {
      interactionId: notCreator.id,
      effectiveResolverPolicy: "human_only",
    });

    expect(world.slackCalls).toHaveLength(0);
  });

  it("ignores cards that are no longer pending", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    const answered = card("int-done", { status: "answered" });
    world.harness.seed({ issueInteractions: [answered] });
    await emitCardCreated(world, answered);
    expect(world.slackCalls).toHaveLength(0);
  });

  it("updates the card message when it is answered", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    const interaction = card("int-1");
    world.harness.seed({ issueInteractions: [interaction] });
    await emitCardCreated(world, interaction);

    (interaction as { status: string }).status = "answered";
    await emitActivity(world, "issue.thread_interaction_answered", { type: "issue", id: "issue-child" }, { interactionId: "int-1" });

    expect(updates(world)).toHaveLength(1);
    expect(updates(world)[0]!.body.ts).toBe("1792100000.000001");
    expect(updates(world)[0]!.body.text).toBe(`✅ Answered — Decision on LIT-3\n\n<${BOARD}/LIT/issues/LIT-3|LIT-3>`);
  });

  it.each([
    ["issue.thread_interaction_cancelled", "cancelled", "❎ Cancelled —"],
    ["issue.thread_interaction_accepted", "accepted", "✅ Accepted —"],
    ["issue.thread_interaction_rejected", "rejected", "❎ Rejected —"],
    ["issue.thread_interaction_withdrawn", "pending", "❎ Withdrawn —"],
  ])("handles %s", async (action, status, prefix) => {
    const world = await createWorld();
    seedTree(world.harness);
    const interaction = card("int-1");
    world.harness.seed({ issueInteractions: [interaction] });
    await emitCardCreated(world, interaction);

    (interaction as { status: string }).status = status;
    await emitActivity(world, action, { type: "issue", id: "issue-child" }, { interactionId: "int-1" });
    expect(updates(world)).toHaveLength(1);
    expect(String(updates(world)[0]!.body.text).startsWith(prefix)).toBe(true);
  });
});

describe("slack-attention: thread resolution", () => {
  it("parses a Slack thread line into channel and thread_ts", () => {
    expect(parseSlackThreadLine(`foo\nSlack thread: ${THREAD_PERMALINK}\nbar`)).toEqual({
      permalink: THREAD_PERMALINK,
      channel: THREAD_CHANNEL,
      threadTs: "1792049190.910429",
    });
    expect(parseSlackThreadLine("Slack thread: https://evil.example/archives/C1/p1792049190910429")).toBeNull();
    expect(parseSlackPermalink(`${FALLBACK_PERMALINK}?thread_ts=1`)?.threadTs).toBe("1792000000.123456");
  });

  it("uses the issue's own thread before an ancestor's", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    world.harness.seed({
      issues: [issue({
        id: "issue-child",
        identifier: "LIT-3",
        parentId: "issue-mid",
        description: `Slack thread: https://little-family-7.slack.com/archives/${THREAD_CHANNEL}/p1792055555000001`,
      })],
      approvals: [commandApproval("appr-1")],
    });
    await emitApprovalCreated(world, "appr-1");
    expect(posts(world)[0]!.body.thread_ts).toBe("1792055555.000001");
  });

  it("falls back to the configured thread when no ancestor has one", async () => {
    const world = await createWorld();
    seedTree(world.harness, "Root without a thread line");
    world.harness.seed({ approvals: [commandApproval("appr-1")] });
    await emitApprovalCreated(world, "appr-1");
    expect(posts(world)).toHaveLength(1);
    expect(posts(world)[0]!.body.channel).toBe(THREAD_CHANNEL);
    expect(posts(world)[0]!.body.thread_ts).toBe("1792000000.123456");
  });

  it("stops after 8 ancestor levels", async () => {
    const world = await createWorld();
    const chain: Issue[] = [];
    for (let level = 0; level <= 9; level += 1) {
      chain.push(issue({
        id: `deep-${level}`,
        identifier: `LIT-${100 + level}`,
        parentId: level < 9 ? `deep-${level + 1}` : null,
        description: level === 9 ? `Slack thread: ${THREAD_PERMALINK}` : null,
      }));
    }
    world.harness.seed({ issues: chain, agents: [agent("agent-vex", "Vex")] });
    world.harness.seed({ approvals: [commandApproval("appr-deep", { issueId: "deep-0" })] });
    await emitApprovalCreated(world, "appr-deep");
    expect(posts(world)[0]!.body.thread_ts).toBe("1792000000.123456");
  });

  it("does not post when there is no thread and no fallback", async () => {
    const world = await createWorld(createSharedState(), { ...BASE_CONFIG, fallbackThreadPermalink: "" });
    seedTree(world.harness, "No thread");
    world.harness.seed({ approvals: [commandApproval("appr-1")] });
    await emitApprovalCreated(world, "appr-1");
    expect(world.slackCalls).toHaveLength(0);
  });
});

describe("slack-attention: safety", () => {
  it("refuses DM and group-DM channels even when allowlisted", async () => {
    expect(isChannelAllowed("D0123ABC", ["D0123ABC"])).toBe(false);
    expect(isChannelAllowed("G0123ABC", ["G0123ABC"])).toBe(false);
    expect(isChannelAllowed("C0123ABC", ["C0999999"])).toBe(false);
    expect(isChannelAllowed("C0123ABC", ["C0123ABC"])).toBe(true);

    const world = await createWorld(createSharedState(), {
      ...BASE_CONFIG,
      allowedChannelIds: ["D0DMCHAN1", "G0GROUP01"],
      fallbackThreadPermalink: "https://little-family-7.slack.com/archives/G0GROUP01/p1792000000123456",
    });
    seedTree(world.harness, "Slack thread: https://little-family-7.slack.com/archives/D0DMCHAN1/p1792049190910429");
    world.harness.seed({ approvals: [commandApproval("appr-1")] });
    await emitApprovalCreated(world, "appr-1");
    expect(world.slackCalls).toHaveLength(0);
  });

  it("falls back when the ancestor thread is in a channel outside the allowlist", async () => {
    const world = await createWorld();
    seedTree(world.harness, "Slack thread: https://little-family-7.slack.com/archives/C0OTHER01/p1792049190910429");
    world.harness.seed({ approvals: [commandApproval("appr-1")] });
    await emitApprovalCreated(world, "appr-1");
    expect(posts(world)).toHaveLength(1);
    expect(posts(world)[0]!.body.thread_ts).toBe("1792000000.123456");
  });

  it("never logs the token when Slack throws or returns an error", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    world.harness.seed({ approvals: [commandApproval("appr-1"), commandApproval("appr-2")] });

    world.slackFailure.mode = "throw";
    await emitApprovalCreated(world, "appr-1");
    world.slackFailure.mode = "error";
    await emitApprovalCreated(world, "appr-2");

    expect(world.harness.logs.some((entry) => entry.level === "warn" && entry.message.includes("posting ask failed"))).toBe(true);
    expectTokenNeverLogged(world);
  });

  it("skips posting without a token secret reference", async () => {
    const world = await createWorld(createSharedState(), { ...BASE_CONFIG, slackBotTokenSecret: "plain-token-string" });
    seedTree(world.harness);
    world.harness.seed({ approvals: [commandApproval("appr-1")] });
    await emitApprovalCreated(world, "appr-1");
    expect(world.slackCalls).toHaveLength(0);
    expect(world.secretResolutions).toHaveLength(0);
  });

  it("refuses localhost board links", async () => {
    const world = await createWorld(createSharedState(), { ...BASE_CONFIG, boardBaseUrl: "http://localhost:3100" });
    seedTree(world.harness);
    world.harness.seed({ approvals: [commandApproval("appr-1")] });
    await emitApprovalCreated(world, "appr-1");
    expect(world.slackCalls).toHaveLength(0);
  });

  it("only talks to slack.com", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    world.harness.seed({ approvals: [commandApproval("appr-1")] });
    await emitApprovalCreated(world, "appr-1");
    for (const call of world.slackCalls) expect(call.url.startsWith("https://slack.com/api/")).toBe(true);
  });
});

describe("slack-attention: idempotency across restarts", () => {
  it("does not post again after a worker restart", async () => {
    const shared = createSharedState();
    const first = await createWorld(shared);
    seedTree(first.harness);
    const approval = commandApproval("appr-1");
    const interaction = card("int-1");
    first.harness.seed({ approvals: [approval], issueInteractions: [interaction] });
    await emitApprovalCreated(first, "appr-1");
    await emitCardCreated(first, interaction);
    expect(posts(first)).toHaveLength(2);

    // Restart: fresh worker and host, same durable plugin state.
    const second = await createWorld(shared);
    seedTree(second.harness);
    second.harness.seed({ approvals: [approval], issueInteractions: [interaction] });
    await emitApprovalCreated(second, "appr-1");
    await emitCardCreated(second, interaction);
    expect(second.slackCalls).toHaveLength(0);

    // The restarted worker still updates the original message.
    approval.status = "rejected";
    await second.harness.emit("approval.decided", {}, { companyId: COMPANY, entityId: "appr-1", entityType: "approval" });
    expect(updates(second)).toHaveLength(1);
    expect(updates(second)[0]!.body.ts).toBe("1792100000.000001");
    expect(String(updates(second)[0]!.body.text)).toMatch(/^❎ Denied or expired — /);
  });
});

describe("slack-attention: reminder job", () => {
  it("posts one reminder when a pending approval has under 8 minutes left", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    world.harness.seed({ approvals: [commandApproval("appr-1", { expiresAt: new Date(NOW + 20 * 60_000).toISOString() })] });
    await emitApprovalCreated(world, "appr-1");

    await world.harness.runJob(REMINDER_JOB_KEY);
    expect(posts(world)).toHaveLength(1);

    nowMs = NOW + 15 * 60_000;
    await world.harness.runJob(REMINDER_JOB_KEY);
    await world.harness.runJob(REMINDER_JOB_KEY);
    expect(posts(world)).toHaveLength(2);
    const reminder = posts(world)[1]!;
    expect(reminder.body.thread_ts).toBe("1792049190.910429");
    expect(reminder.body.text).toBe(
      "*Reminder: approval still waiting*\n\n"
      + "About 5 min left, then it's treated as denied.\n\n"
      + `<${BOARD}/LIT/approvals/appr-1|Review and approve>`,
    );
  });

  it("does not remind when disabled", async () => {
    const world = await createWorld(createSharedState(), { ...BASE_CONFIG, reminderEnabled: false });
    seedTree(world.harness);
    world.harness.seed({ approvals: [commandApproval("appr-1", { expiresAt: new Date(NOW + 5 * 60_000).toISOString() })] });
    await emitApprovalCreated(world, "appr-1");
    await world.harness.runJob(REMINDER_JOB_KEY);
    expect(posts(world)).toHaveLength(1);
  });

  it("reconciles a decision whose event was missed", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    const approval = commandApproval("appr-1");
    world.harness.seed({ approvals: [approval] });
    await emitApprovalCreated(world, "appr-1");
    approval.status = "approved";
    await world.harness.runJob(REMINDER_JOB_KEY);
    expect(updates(world)).toHaveLength(1);
    await world.harness.runJob(REMINDER_JOB_KEY);
    expect(updates(world)).toHaveLength(1);
  });

  it("retries a failed post from the job without duplicating", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    world.harness.seed({ approvals: [commandApproval("appr-1")] });
    world.slackFailure.mode = "error";
    await emitApprovalCreated(world, "appr-1");
    world.slackFailure.mode = "none";
    await world.harness.runJob(REMINDER_JOB_KEY);
    await world.harness.runJob(REMINDER_JOB_KEY);
    const successful = posts(world).slice(1);
    expect(successful).toHaveLength(1);
  });
});

describe("slack-attention: formatting", () => {
  it("strips mentions and markup from worker-authored text", () => {
    const text = sanitizeUntrusted("Hey <!channel> and <@U123ABC> look at **this** <https://x.example|link> & `code`", 220);
    expect(text).not.toContain("<!");
    expect(text).not.toContain("<@");
    expect(text).not.toContain("<");
    expect(text).not.toContain("**");
    expect(text).toContain("&amp;");
  });

  it("truncates the first prompt to 220 characters", () => {
    const formatted = formatCardAsk({
      board: { boardBaseUrl: BOARD, companyUrlKey: "LIT" },
      identifier: "LIT-9",
      payload: { questions: [{ prompt: "x".repeat(500) }] },
    });
    const prompt = formatted.text.split("\n\n")[1]!;
    expect(prompt.length).toBe(220);
    expect(prompt.endsWith("…")).toBe(true);
  });

  it("takes the first flag of a runtime description", () => {
    expect(firstFlag("recursive delete; network access")).toBe("recursive delete");
    expect(firstFlag("<!here> wipe disk")).toBe("here&gt; wipe disk");
    expect(firstFlag(undefined)).toBe("");
  });

  it("uses Tailscale links, single-asterisk bold and no localhost in every message", async () => {
    const world = await createWorld();
    seedTree(world.harness);
    const approval = commandApproval("appr-1", { expiresAt: new Date(NOW + 9 * 60_000).toISOString() });
    const interaction = card("int-1", {
      payload: { version: 1, questions: [{ id: "q", prompt: "Ship **now**? <!here>", options: [] }] },
    });
    world.harness.seed({ approvals: [approval], issueInteractions: [interaction] });
    await emitApprovalCreated(world, "appr-1");
    await emitCardCreated(world, interaction);
    nowMs = NOW + 3 * 60_000;
    await world.harness.runJob(REMINDER_JOB_KEY);
    approval.status = "approved";
    (interaction as { status: string }).status = "answered";
    await world.harness.emit("approval.decided", {}, { companyId: COMPANY, entityId: "appr-1", entityType: "approval" });
    await emitActivity(world, "issue.thread_interaction_answered", { type: "issue", id: "issue-child" }, { interactionId: "int-1" });

    expect(posts(world)).toHaveLength(3);
    expect(updates(world)).toHaveLength(2);
    for (const call of world.slackCalls) {
      const text = String(call.body.text);
      expect(text).not.toContain("**");
      expect(text).not.toMatch(/localhost|127\.0\.0\.1/);
      expect(text).not.toContain("<!");
      expect(text).not.toContain("<@");
      const urls = [...text.matchAll(/<(https?:\/\/[^|>]+)\|/g)].map((m) => m[1]!);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url.startsWith(`${BOARD}/LIT/`)).toBe(true);
      expect(call.body.link_names).toBe(false);
    }
  });
});

describe("slack-attention: config validation", () => {
  it("rejects DM channels, localhost boards and missing secrets", async () => {
    const result = await plugin.definition.onValidateConfig!({
      allowedChannelIds: ["D0DMCHAN1"],
      boardBaseUrl: "http://localhost:3100",
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join("\n")).toMatch(/slackBotTokenSecret/);
    expect(result.errors?.join("\n")).toMatch(/boardBaseUrl/);
    expect(result.errors?.join("\n")).toMatch(/D0DMCHAN1/);
  });

  it("accepts the default live configuration", async () => {
    const result = await plugin.definition.onValidateConfig!(BASE_CONFIG);
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });
});
