import { describe, expect, it, vi } from "vitest";
import type {
  AdapterApprovalDecision,
  AdapterApprovalDelivery,
  AdapterApprovalRequest,
  AdapterExecutionContext,
} from "@paperclipai/adapter-utils";
import {
  commandSha256,
  createApprovalRouter,
  effectiveBoardTimeoutMs,
  isCommandIncomplete,
  parseHermesApprovalRequest,
  PROVIDER_NOT_PENDING,
  PROVIDER_RUN_ENDED,
  readApprovalRoutingConfig,
  redactApprovalText,
  type ApprovalAnswerResult,
  type ApprovalRoutingConfig,
} from "./approval-routing.js";

// Shape emitted by Hermes gateway/platforms/api_server_runs.py _make_approval_notify.
const hermesEvent = (overrides: Record<string, unknown> = {}) => ({
  event: "approval.request",
  run_id: "run_abc",
  timestamp: 1_760_000_000.5,
  command: "rm -rf build",
  pattern_key: "recursive delete",
  pattern_keys: ["recursive delete"],
  description: "recursive delete",
  allow_permanent: true,
  allow_session: true,
  request_id: "0f1e2d3c4b5a",
  choices: ["once", "session", "always", "deny"],
  ...overrides,
});

describe("parseHermesApprovalRequest", () => {
  it("parses the Hermes approval.request payload", () => {
    expect(parseHermesApprovalRequest(hermesEvent(), "fallback")).toEqual({
      requestId: "0f1e2d3c4b5a",
      runId: "run_abc",
      command: "rm -rf build",
      description: "recursive delete",
      patternKeys: ["recursive delete"],
      choices: ["once", "session", "always", "deny"],
      smartDenied: false,
    });
  });

  it("rejects other events and requests without a request id", () => {
    expect(parseHermesApprovalRequest({ ...hermesEvent(), event: "approval.responded" }, "r")).toBeNull();
    expect(parseHermesApprovalRequest({ ...hermesEvent(), request_id: undefined }, "r")).toBeNull();
    expect(parseHermesApprovalRequest("nope", "r")).toBeNull();
  });

  it("falls back to the known run id and reads smart_denied", () => {
    const parsed = parseHermesApprovalRequest(hermesEvent({ run_id: undefined, smart_denied: true }), "run_fallback");
    expect(parsed?.runId).toBe("run_fallback");
    expect(parsed?.smartDenied).toBe(true);
  });
});

describe("redaction and integrity", () => {
  it("redacts token-like arguments and keeps the command readable", () => {
    const redacted = redactApprovalText(
      "curl -H 'Authorization: Bearer abcdefghijklmnop' --token ghp_abcdefghijklmnopqrstuvwxyz0123 API_KEY=supersecret https://u:pw@host/x",
    );
    expect(redacted).not.toContain("abcdefghijklmnop");
    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(redacted).not.toContain("supersecret");
    expect(redacted).not.toContain(":pw@");
    expect(redacted).toContain("curl");
  });

  it("keeps long workspace paths", () => {
    expect(redactApprovalText("rm -rf packages/adapters/hermes/src/gateway/server/build")).toBe(
      "rm -rf packages/adapters/hermes/src/gateway/server/build",
    );
  });

  it("flags commands the board cannot see in full", () => {
    expect(isCommandIncomplete("rm -rf build", "rm -rf build")).toBe(false);
    expect(isCommandIncomplete("deploy --token x", "deploy --token [redacted]")).toBe(true);
    expect(isCommandIncomplete("echo *** > out", "echo *** > out")).toBe(true);
    expect(isCommandIncomplete("run «redacted:ghp_…»", "run «redacted:ghp_…»")).toBe(true);
    expect(isCommandIncomplete("", "")).toBe(true);
  });

  it("hashes the exact provider command", () => {
    expect(commandSha256("rm -rf build")).toMatch(/^[0-9a-f]{64}$/);
    expect(commandSha256("rm -rf build")).not.toBe(commandSha256("rm -rf build "));
  });
});

describe("routing config", () => {
  it("defaults to enabled routing with a wait below Hermes' default approvals.timeout", () => {
    expect(readApprovalRoutingConfig({})).toEqual({ enabled: true, boardTimeoutMs: 270_000 });
  });

  it("reads the timeout and kill switch and ignores removed keys", () => {
    expect(readApprovalRoutingConfig({
      approvalRouting: false,
      approvalBoardTimeoutSec: "120",
      approvalSupervisorAgentId: "vex",
      approvalScratchRoots: "/",
    })).toEqual({ enabled: false, boardTimeoutMs: 120_000 });
  });

  it("caps the board wait at the run timeout minus the reserve", () => {
    expect(effectiveBoardTimeoutMs(270_000, 1_000_000 + 600_000, 1_000_000)).toBe(270_000);
    expect(effectiveBoardTimeoutMs(900_000, 1_000_000 + 600_000, 1_000_000)).toBe(585_000);
    expect(effectiveBoardTimeoutMs(900_000, null)).toBe(900_000);
    expect(effectiveBoardTimeoutMs(900_000, 1_000, 1_000)).toBe(0);
  });
});

type EventCall = [{ eventType: string; message?: string; payload?: Record<string, unknown> }];

function routerCtx(onApprovalRequest?: AdapterExecutionContext["onApprovalRequest"]) {
  const onEvent = vi.fn(async (..._args: EventCall) => undefined);
  const ctx = {
    runId: "pc-run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Nox", adapterType: "hermes_gateway", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog: vi.fn(async () => undefined),
    onEvent,
    onApprovalRequest,
  } as AdapterExecutionContext;
  return { ctx, onEvent };
}

const config = (overrides: Partial<ApprovalRoutingConfig> = {}): ApprovalRoutingConfig => ({
  enabled: true,
  boardTimeoutMs: 270_000,
  ...overrides,
});

function makeRouter(
  ctx: AdapterExecutionContext,
  overrides: Partial<Parameters<typeof createApprovalRouter>[0]> = {},
  answer: ApprovalAnswerResult = { delivered: true },
) {
  const postDecision = vi.fn(async (_input: { runId: string; requestId: string; choice: "once" | "deny" }) => answer);
  const router = createApprovalRouter({
    ctx,
    config: config(),
    runDeadlineAt: null,
    signal: new AbortController().signal,
    redactText: (value) => value,
    postDecision,
    ...overrides,
  });
  return { router, postDecision };
}

function boardDecision(decision: AdapterApprovalDecision["decision"], onDelivery?: (delivery: AdapterApprovalDelivery) => Promise<void>) {
  return vi.fn(async (request: AdapterApprovalRequest): Promise<AdapterApprovalDecision> => ({
    decision,
    decidedBy: "board",
    approvalId: "appr-1",
    requestId: request.requestId,
    commandSha256: request.commandSha256,
    onDelivery,
  }));
}

function waitingHost() {
  return vi.fn((request: AdapterApprovalRequest) => new Promise<AdapterApprovalDecision>((resolve) => {
    request.signal.addEventListener("abort", () => resolve({ decision: "cancelled", decidedBy: "system" }));
  }));
}

describe("createApprovalRouter", () => {
  it("sends every request to the board and answers once on approval", async () => {
    const onDelivery = vi.fn(async (_delivery: AdapterApprovalDelivery) => undefined);
    const onApprovalRequest = boardDecision("approved", onDelivery);
    const { ctx, onEvent } = routerCtx(onApprovalRequest);
    const { router, postDecision } = makeRouter(ctx);
    router.handle(hermesEvent(), "run_abc");
    router.handle(hermesEvent(), "run_abc"); // replayed frame is ignored
    await router.settle();

    expect(onApprovalRequest).toHaveBeenCalledTimes(1);
    expect(onApprovalRequest.mock.calls[0]![0]).toMatchObject({
      requestId: "0f1e2d3c4b5a",
      providerRunId: "run_abc",
      command: "rm -rf build",
      commandSha256: commandSha256("rm -rf build"),
      commandComplete: true,
    });
    expect(postDecision).toHaveBeenCalledWith({ runId: "run_abc", requestId: "0f1e2d3c4b5a", choice: "once" });
    expect(onDelivery).toHaveBeenCalledWith({ delivered: true, choice: "once", reason: null });
    expect(onEvent.mock.calls.map(([event]) => event.eventType)).toEqual(["adapter.approval.requested", "adapter.approval.resolved"]);
  });

  it("marks a redacted command incomplete and keeps the token out of the host and the run log", async () => {
    const onApprovalRequest = boardDecision("denied");
    const { ctx, onEvent } = routerCtx(onApprovalRequest);
    const { router } = makeRouter(ctx);
    router.handle(hermesEvent({ command: "deploy --key=sk-live_abcdefghijklmnopqrstuvwxyz" }), "run_abc");
    await router.settle();
    expect(onApprovalRequest.mock.calls[0]![0]).toMatchObject({ commandComplete: false });
    expect(JSON.stringify([onApprovalRequest.mock.calls, onEvent.mock.calls])).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("treats an approval that does not echo the request id and hash as a denial", async () => {
    const onApprovalRequest = vi.fn(async (request: AdapterApprovalRequest): Promise<AdapterApprovalDecision> => ({
      decision: "approved",
      decidedBy: "board",
      requestId: request.requestId,
      commandSha256: "0".repeat(64),
    }));
    const { ctx } = routerCtx(onApprovalRequest);
    const { router, postDecision } = makeRouter(ctx);
    router.handle(hermesEvent(), "run_abc");
    await router.settle();
    expect(postDecision).toHaveBeenCalledWith({ runId: "run_abc", requestId: "0f1e2d3c4b5a", choice: "deny" });
  });

  it("denies immediately when the host cannot route approvals", async () => {
    const { ctx } = routerCtx(undefined);
    const { router, postDecision } = makeRouter(ctx);
    router.handle(hermesEvent(), "run_abc");
    await router.settle();
    expect(postDecision).toHaveBeenCalledWith({ runId: "run_abc", requestId: "0f1e2d3c4b5a", choice: "deny" });
  });

  it("caps the board wait to the remaining run time and warns", async () => {
    const onApprovalRequest = boardDecision("timeout");
    const { ctx, onEvent } = routerCtx(onApprovalRequest);
    const { router } = makeRouter(ctx, { runDeadlineAt: Date.now() + 75_000 });
    router.handle(hermesEvent(), "run_abc");
    await router.settle();
    const timeoutMs = onApprovalRequest.mock.calls[0]![0].timeoutMs;
    expect(timeoutMs).toBeGreaterThan(50_000);
    expect(timeoutMs).toBeLessThanOrEqual(60_000);
    expect(onEvent.mock.calls.some(([event]) => event.eventType === "adapter.approval.timeout_capped")).toBe(true);
  });

  it("answers deny when the Paperclip run is stopping mid-wait", async () => {
    const controller = new AbortController();
    const onApprovalRequest = waitingHost();
    const { ctx } = routerCtx(onApprovalRequest);
    const { router, postDecision } = makeRouter(ctx, { signal: controller.signal });
    router.handle(hermesEvent(), "run_abc");
    await vi.waitFor(() => expect(onApprovalRequest).toHaveBeenCalled());
    controller.abort("run_stopped");
    await router.settle();
    expect(postDecision).toHaveBeenCalledWith({ runId: "run_abc", requestId: "0f1e2d3c4b5a", choice: "deny" });
  });

  it("never answers once when the run starts stopping as the approval arrives", async () => {
    const controller = new AbortController();
    const onDelivery = vi.fn(async (_delivery: AdapterApprovalDelivery) => undefined);
    const onApprovalRequest = vi.fn(async (request: AdapterApprovalRequest): Promise<AdapterApprovalDecision> => {
      controller.abort("run_stopped");
      return { decision: "approved", decidedBy: "board", requestId: request.requestId, commandSha256: request.commandSha256, onDelivery };
    });
    const { ctx } = routerCtx(onApprovalRequest);
    const { router, postDecision } = makeRouter(ctx, { signal: controller.signal });
    router.handle(hermesEvent(), "run_abc");
    await router.settle();
    expect(postDecision).toHaveBeenCalledWith({ runId: "run_abc", requestId: "0f1e2d3c4b5a", choice: "deny" });
    expect(onDelivery).toHaveBeenCalledWith({ delivered: true, choice: "deny", reason: null });
  });

  it("does not answer when Hermes already ended the run", async () => {
    const controller = new AbortController();
    const onApprovalRequest = waitingHost();
    const { ctx } = routerCtx(onApprovalRequest);
    const { router, postDecision } = makeRouter(ctx, { signal: controller.signal });
    router.handle(hermesEvent(), "run_abc");
    await vi.waitFor(() => expect(onApprovalRequest).toHaveBeenCalled());
    controller.abort(PROVIDER_RUN_ENDED);
    await router.settle();
    expect(postDecision).not.toHaveBeenCalled();
  });

  it("withdraws a request when a later status poll shows Hermes stopped waiting", async () => {
    let clock = 1_000;
    const onApprovalRequest = waitingHost();
    const { ctx, onEvent } = routerCtx(onApprovalRequest);
    const { router, postDecision } = makeRouter(ctx, { now: () => clock });
    router.handle(hermesEvent(), "run_abc");
    await vi.waitFor(() => expect(onApprovalRequest).toHaveBeenCalled());
    // A poll that started before the request was seen may predate it.
    router.observeStatus("running", 900);
    router.observeStatus("waiting_for_approval", 1_500);
    expect(onApprovalRequest.mock.calls[0]![0].signal.aborted).toBe(false);
    clock = 2_000;
    router.observeStatus("running", 1_500);
    await router.settle();
    expect(onApprovalRequest.mock.calls[0]![0].signal.reason).toBe(PROVIDER_NOT_PENDING);
    expect(postDecision).not.toHaveBeenCalled();
    expect(onEvent.mock.calls.some(([event]) => event.eventType === "adapter.approval.abandoned")).toBe(true);
  });

  it("reports an answer Hermes rejected as not pending so the host can close the record", async () => {
    const onDelivery = vi.fn(async (_delivery: AdapterApprovalDelivery) => undefined);
    const { ctx, onEvent } = routerCtx(boardDecision("approved", onDelivery));
    const { router } = makeRouter(ctx, {}, { delivered: false, reason: "approval_not_pending" });
    router.handle(hermesEvent(), "run_abc");
    await router.settle();
    expect(onDelivery).toHaveBeenCalledWith({ delivered: false, choice: "once", reason: "approval_not_pending" });
    expect(onEvent.mock.calls.some(([event]) => event.eventType === "adapter.approval.answer_failed")).toBe(true);
  });
});
