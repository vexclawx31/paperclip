import { describe, expect, it, vi, afterEach } from "vitest";
import type { AdapterApprovalDecision, AdapterApprovalDelivery, AdapterApprovalRequest, AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";
import { execute, mapFinalResultForTest, parseSseFramesForTest, resolveSessionKey } from "./execute.js";
import { testEnvironment } from "./test.js";

function makeCtx(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "pc-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_gateway",
      adapterConfig: config,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: {
        issue: { identifier: "PAP-1", title: "Do the thing" },
      },
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  };
}

function sseStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveSessionKey", () => {
  it("derives issue-scoped session keys by default", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "issue-1",
      }),
    ).toBe("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("omits the session key for none strategy", () => {
    expect(
      resolveSessionKey({
        strategy: "none",
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "issue-1",
      }),
    ).toBeNull();
  });
});

describe("parseSseFramesForTest", () => {
  it("parses event and data lines while preserving partial frames", () => {
    const parsed = parseSseFramesForTest("event: message.delta\ndata: {\"delta\":\"hi\"}\n\n:data\ndata: later");
    expect(parsed.frames).toEqual([{ event: "message.delta", data: "{\"delta\":\"hi\"}" }]);
    expect(parsed.rest).toBe(":data\ndata: later");
  });
});

describe("execute", () => {
  it("rejects remote plain HTTP unless the unsafe dev escape hatch is enabled", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ run_id: "unexpected" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://192.168.1.25:8642",
      apiKey: "secret-key",
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_plain_http_remote_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports dispatch before starting the remote run create request", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const onDispatch = vi.fn();
    ctx.onDispatch = onDispatch;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        expect(onDispatch).toHaveBeenCalledTimes(1);
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(["event: run.completed", "data: {\"status\":\"completed\",\"output\":\"done\"}", ""].join("\n")),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it("constructs POST /v1/runs with auth, idempotency, and Hermes session headers", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              "data: {\"delta\":\"done\"}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\",\"session_id\":\"session-1\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2},\"model\":\"hermes-agent\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const createCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    expect(createCall).toBeTruthy();
    const init = createCall?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret-key",
      "Content-Type": "application/json",
      "Idempotency-Key": "pc-run-1",
      "X-Hermes-Session-Key": "paperclip:company:company-1:agent:agent-1:issue:issue-1",
    });
    const body = JSON.parse(String(init.body));
    expect(body.input).toContain("Do the thing");
    expect(body.session_id).toBe("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it.each([false, true])("preserves chat handoff policy on gateway turns (resumed=%s)", async (resumed) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/v1/runs")
        ? { run_id: "run-hermes-1", status: "started" }
        : { status: "completed", output: "done" },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    ctx.config.payloadTemplate = { input: "Custom gateway instruction." };
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    ctx.context = {
      conversationMode: true,
      issueId: "issue-1",
      paperclipTaskMarkdown: directive,
      paperclipTaskMarkdownCompact: directive,
      paperclipWake: {
        reason: "issue_commented",
        issue: { id: "issue-1", workMode: "planning", status: "in_progress" },
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    };
    if (resumed) ctx.runtime.sessionId = "prior-session";
    await execute(ctx);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const call = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const prompt = JSON.parse(String(call?.[1]?.body)).input as string;
    expect(prompt).toContain("Custom gateway instruction.");
    expect(prompt).toContain(directive);
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("clear final disposition");
    expect(prompt).not.toContain("Create child issues");
  });

  it("sends the task brief once on fresh runs and compacts it on stable-session resumes", async () => {
    const description = "Update launch-card.svg and change the CTA to Try Team free.";
    const fullTaskMarkdown = [
      "Paperclip task context:",
      '- Issue: "PAP-1"',
      "",
      "Issue description:",
      "```text",
      description,
      "```",
    ].join("\n");
    const compactTaskMarkdown = ["Paperclip task context:", '- Issue: "PAP-1"'].join("\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const wakeContext = (reason: string) => ({
      issueId: "issue-1",
      wakeReason: reason,
      paperclipTaskMarkdown: fullTaskMarkdown,
      paperclipTaskMarkdownCompact: compactTaskMarkdown,
      paperclipWake: {
        reason,
        issue: {
          id: "issue-1",
          identifier: "PAP-1",
          title: "Do the thing",
          description,
          descriptionTruncated: false,
          status: "in_progress",
        },
        commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
        comments: [],
        fallbackFetchNeeded: false,
      },
    });

    const freshCtx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    freshCtx.context = wakeContext("issue_assigned");
    await execute(freshCtx);

    const resumeCtx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    resumeCtx.context = wakeContext("issue_commented");
    resumeCtx.runtime = {
      sessionId: "session-1",
      sessionParams: null,
      sessionDisplayId: "session-1",
      taskKey: "PAP-1",
    };
    await execute(resumeCtx);

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runBodies = calls
      .filter(([input]) => String(input).endsWith("/v1/runs"))
      .map(([, init]) => JSON.parse(String(init?.body)) as { input: string });
    expect(runBodies).toHaveLength(2);
    // Fresh run: brief exactly once (task markdown only; wake-prompt copy suppressed).
    expect(runBodies[0]!.input.split(description)).toHaveLength(2);
    // Stable-session resume: compact task markdown, no re-sent brief.
    expect(runBodies[1]!.input).toContain("Paperclip task context:");
    expect(runBodies[1]!.input).not.toContain(description);
  });

  it.each([false, true])("delivers the shared assignment and ordered comments at the HTTP boundary (resumed=%s)", async (resumed) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "completed", output: "done" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      payloadTemplate: { input: "Custom gateway instruction." },
    });
    const promptContext = createPromptContextFixture();
    ctx.context = { ...promptContext, conversationMode: true };
    if (resumed) ctx.runtime.sessionId = "prior-session";

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const input = JSON.parse(String(runCall?.[1]?.body)).input as string;
    expect(input).toContain("Custom gateway instruction.");
    expect(input.indexOf("Append the same ledger entry.")).toBeGreaterThanOrEqual(0);
    expect(input.indexOf("Append the same ledger entry.")).toBeLessThan(input.indexOf("Change the final scope to the launch checklist."));
    expect(input.split("Append the same ledger entry.")).toHaveLength(3);
    expect(input).not.toContain("Structured wake payload JSON:");
    expect(input.split("Keep this deliberate repetition. Keep this deliberate repetition.")).toHaveLength(2);
    const continuationHeading = "## Current request and continuation context";
    const continuationStart = input.indexOf(continuationHeading);
    const fencedStart = input.indexOf("```text\n", continuationStart);
    const fencedEnd = input.indexOf("\n```", fencedStart + "```text\n".length);
    expect(continuationStart).toBeGreaterThanOrEqual(0);
    expect(fencedStart).toBeGreaterThan(continuationStart);
    expect(fencedEnd).toBeGreaterThan(fencedStart);
    const continuation = JSON.parse(input.slice(
      fencedStart + "```text\n".length,
      fencedEnd,
    )) as Record<string, unknown>;
    expect(continuation.objectiveSource).toEqual(promptContext.executionContinuation.objectiveSource);
    if (resumed) {
      expect(input).toContain("## Compact assignment");
      expect(continuation.objective).toBe("Keep this deliberate repetition. Keep this deliberate repetition.");
    } else {
      expect(continuation).not.toHaveProperty("objective");
    }
  });

  it("routes a bare Hermes dashboard URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9119/api/v1/runs") {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url === "http://127.0.0.1:9119/api/v1/runs/run-hermes-1/events") {
        return new Response(
          sseStream(
            [
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:9119",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: ["http://127.0.0.1:9119/api/v1/runs"],
      }),
    );
    expect((ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n"))
      .toContain("creating run at http://127.0.0.1:9119/api/v1/runs");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:9119/api/v1/runs",
        "http://127.0.0.1:9119/api/v1/runs/run-hermes-1/events",
      ]),
    );
  });

  it("renders current wake comments once when the gateway task brief owns them", async () => {
    const commentBody = "Keep this current comment exactly once.";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" });
    ctx.context = {
      issueId: "issue-1",
      paperclipTaskMarkdown: [
        "Paperclip task context:",
        '- Issue: "PAP-1"',
      ].join("\n"),
      paperclipTurnContext: {
        version: 1,
        assignment: { owner: "task_markdown" },
        events: { owner: "wake_prompt", comments: [{ id: "comment-1", revision: "rev-1" }] },
      },
      paperclipWake: {
        reason: "issue_commented",
        issue: { id: "issue-1", identifier: "PAP-1", title: "Do the thing", status: "in_progress" },
        commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
        comments: [{ id: "comment-1", body: commentBody }],
        fallbackFetchNeeded: false,
      },
    };

    await execute(ctx);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const prompt = JSON.parse(String(runCall?.[1]?.body)).input as string;
    expect(prompt.split(commentBody)).toHaveLength(2);
  });

  it("routes the default Hermes dashboard chat URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9119/api/v1/runs") {
        return new Response(JSON.stringify({ run_id: "run-hermes-chat", status: "started" }), { status: 200 });
      }
      if (url === "http://127.0.0.1:9119/api/v1/runs/run-hermes-chat/events") {
        return new Response(
          sseStream(
            [
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:9119/chat",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: ["http://127.0.0.1:9119/api/v1/runs"],
      }),
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:9119/api/v1/runs",
        "http://127.0.0.1:9119/api/v1/runs/run-hermes-chat/events",
      ]),
    );
  });

  it("redacts echoed auth material from stream logs and summaries", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              "data: {\"delta\":\"Authorization: Bearer secret-key\\nX-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1\"}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"Authorization: Bearer secret-key\\nraw key secret-key\\nX-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("Bearer [redacted]");
    expect(result.summary).toContain("raw key [redacted len=10]");
    expect(result.summary).toContain("X-Hermes-Session-Key: [redacted]");
    expect(result.summary).not.toContain("secret-key");
    expect(result.summary).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
    expect(result.resultJson?.output).toBe(result.summary);
    expect(logText).toContain("Bearer [redacted]");
    expect(logText).toContain("X-Hermes-Session-Key: [redacted]");
    expect(logText).not.toContain("secret-key");
    expect(logText).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("redacts agent-scoped Paperclip session keys from logs and public result metadata", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      sessionKeyStrategy: "agent",
      timeoutSec: 5,
    });
    const agentSessionKey = "paperclip:company:company-1:agent:agent-1";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              `data: {"delta":"session ${agentSessionKey}"}`,
              "",
              "event: run.completed",
              `data: {"status":"completed","output":"session ${agentSessionKey}","session_id":"${agentSessionKey}"}`,
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("session [redacted-session-key]");
    expect(result.sessionId).toBe("[redacted-session-key]");
    expect(result.sessionDisplayId).toBe("[redacted-session-key]");
    expect(result.resultJson?.session_id).toBe("[redacted-session-key]");
    expect(result.sessionParams).toEqual({
      hermesRunId: "run-hermes-1",
      strategy: "agent",
    });
    expect(logText).toContain("[redacted-session-key]");
    expect(logText).not.toContain(agentSessionKey);
  });

  it("falls back to polling when SSE is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response("no stream", { status: 503 });
      }
      return new Response(JSON.stringify({
        status: "completed",
        output: "polled done",
        session_id: "session-polled",
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      pollIntervalMs: 250,
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("polled done");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/v1/runs/run-hermes-1"))).toBe(true);
  });

  it("maps HTTP auth failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 })));
    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
    }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.errorMessage).toContain("Check adapterConfig.apiKey matches the Hermes API_SERVER_KEY");
  });

  it("includes network causes in connection failure messages", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause });
    }));

    const result = await execute(makeCtx({
      apiBaseUrl: "http://host.docker.internal:8642",
      apiKey: "secret-key",
      dangerouslyAllowInsecureRemoteHttp: true,
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
    expect(result.errorMessage).toContain("ENOTFOUND");
    expect(result.errorMessage).toContain("host.docker.internal");
  });

  it("redacts echoed auth material from HTTP error payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            message: "Authorization rejected: Bearer secret-key raw secret-key",
            detail: "X-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1",
            nested: {
              note: "session paperclip:company:company-1:agent:agent-1",
            },
          }),
          { status: 401 },
        )),
    );

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.errorMeta?.body).toEqual({
      message: "Authorization rejected: Bearer [redacted] raw [redacted len=10]",
      detail: "X-Hermes-Session-Key: [redacted]",
      nested: {
        note: "session [redacted-session-key]",
      },
    });
    expect(result.errorMessage).not.toContain("secret-key");
    expect(result.errorMessage).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("calls stop on timeout", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-slow", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Promise<Response>(() => {});
      }
      if (url.endsWith("/stop")) {
        return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      }
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ status: "cancelled", last_event: "run.cancelled" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 0.001,
    }));

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("hermes_gateway_timeout");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/stop"))).toBe(true);
  });
});

describe("testEnvironment", () => {
  it("fails remote plain HTTP before probing health", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://hermes.example:8642",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_denied",
          level: "error",
        }),
      ]),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows remote plain HTTP only with the unsafe dev escape hatch", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://hermes.example:8642",
        apiKey: "secret-key",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });

    expect(result.status).toBe("warn");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_unsafe_allowed",
          level: "warn",
        }),
        expect.objectContaining({
          code: "hermes_gateway_health_ok",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalled();
  });

  it("fails test environment checks when Hermes health is unreachable", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause });
    }));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://host.docker.internal:8642",
        apiKey: "secret-key",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_health_unreachable",
          level: "error",
          detail: expect.stringContaining("ENOTFOUND"),
        }),
      ]),
    );
  });

  it("fails test environment checks when Hermes health returns a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: "wrong-key",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_health_failed",
          level: "error",
          message: "Hermes Gateway health endpoint returned HTTP 401.",
        }),
      ]),
    );
  });

  it("tests a bare Hermes dashboard URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:9119",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          message: "Default Hermes dashboard root mapped to API base http://127.0.0.1:9119/api.",
          hint: expect.stringContaining("/api/v1/runs"),
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("tests a Hermes dashboard chat URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:9119/chat",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          message: "Default Hermes dashboard root mapped to API base http://127.0.0.1:9119/api.",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("mapFinalResultForTest", () => {
  it("maps failed statuses into adapter errors", () => {
    const result = mapFinalResultForTest({
      terminal: {
        runId: "run-1",
        status: "failed",
        payload: { status: "failed", error: "boom" },
      },
      outputChunks: [],
      sessionKey: "session-key",
      strategy: "issue",
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_run_failed");
    expect(result.errorMessage).toBe("boom");
  });
});

describe("scoped run environment", () => {
  const RUN_JWT = "header.run-scoped-jwt.signature";
  const capabilities = {
    features: {
      run_environment: {
        enabled: true,
        protocol: "trusted-local-foreground-v1",
        route: "/v1/trusted-local-runs",
        sessions: "fresh-only",
      },
    },
  };

  function scopedCtx(extra: Record<string, unknown> = {}): AdapterExecutionContext {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      paperclipApiUrl: "http://127.0.0.1:3100",
      scopedRunEnvironment: true,
      timeoutSec: 5,
      ...extra,
    });
    ctx.authToken = RUN_JWT;
    return ctx;
  }

  function receiver(options: { caps?: unknown; ack?: string | null } = {}) {
    return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/capabilities")) {
        return new Response(JSON.stringify(options.caps ?? capabilities), { status: 200 });
      }
      if (url.endsWith("/v1/trusted-local-runs")) {
        const ack = options.ack === undefined ? "trusted-local-foreground-v1" : options.ack;
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started", ...(ack ? { environment_capability: ack } : {}) }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream([
            "event: message.delta",
            `data: {"delta":"streamed ${RUN_JWT}"}`,
            "",
            "event: run.completed",
            "data: {\"status\":\"completed\",\"output\":\"done\"}",
            "",
          ].join("\n")),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
  }

  // Mirror of the receiver's value policy (hermes-agent gateway/runtime_context.py
  // validate_environment at release 0b6aaff0): non-empty strings, <=8192 UTF-8
  // bytes each, no C0 control characters or DEL, <=32768 bytes in total. A
  // rejection is the receiver's real HTTP 400 envelope.
  function policyReceiver(options: { echoInRejection?: string; reject?: boolean } = {}) {
    const base = receiver();
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/v1/trusted-local-runs")) {
        const env = (JSON.parse(String(init?.body)).environment ?? {}) as Record<string, unknown>;
        const valueOk = (v: unknown) => typeof v === "string" && v.length > 0 &&
          Buffer.byteLength(v, "utf8") <= 8192 && ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
        const total = Object.entries(env).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(String(v)), 0);
        if (options.reject || !Object.values(env).every(valueOk) || total > 32768) {
          return new Response(JSON.stringify({ error: {
            message: `Run environment denied by policy${options.echoInRejection ?? ""}`,
            type: "invalid_request_error", param: null, code: null,
          } }), { status: 400 });
        }
      }
      return base(input, init);
    });
  }

  const MULTILINE_REASON = [
    "Supervisor continuation for LIT-105:",
    "1. Record Jamal's model-diversity requirement.\t(critical)",
    "2. Record the no-chase regression scenario.\u007f",
    `3. ${"Keep the full authorized direction in the run input. ".repeat(60).trimEnd()}`,
  ].join("\n");

  it("delivers a multi-line wake reason: bounded control-free env value, full direction in input", async () => {
    const fetchMock = policyReceiver();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = scopedCtx();
    ctx.context.wakeReason = MULTILINE_REASON;
    ctx.context.paperclipWake = { ...(ctx.context.paperclipWake as object), reason: MULTILINE_REASON };

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const init = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/v1/trusted-local-runs"))?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    const envReason = String(body.environment.PAPERCLIP_WAKE_REASON);
    expect(envReason).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(Buffer.byteLength(envReason, "utf8")).toBeLessThanOrEqual(512);
    expect(envReason.startsWith("Supervisor continuation for LIT-105: 1. Record Jamal's")).toBe(true);
    // The model still receives the complete, unmodified direction.
    expect(String(body.input)).toContain(MULTILINE_REASON);
  });

  it("keeps a safe machine wake reason unchanged and omits one with no printable text", async () => {
    for (const [reason, expected] of [["issue_unblock_requested", "issue_unblock_requested"], ["\n\t\r", undefined]] as const) {
      const fetchMock = policyReceiver();
      vi.stubGlobal("fetch", fetchMock);
      const ctx = scopedCtx();
      ctx.context.wakeReason = reason;
      const result = await execute(ctx);
      expect(result.exitCode).toBe(0);
      const init = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/v1/trusted-local-runs"))?.[1] as RequestInit;
      expect(JSON.parse(String(init.body)).environment.PAPERCLIP_WAKE_REASON).toBe(expected);
    }
  });

  it("surfaces the receiver's rejection reason in the error receipt without secrets or control characters", async () => {
    // A receiver-side rejection that (worst case) echoes credentials and
    // control characters back in its error envelope.
    vi.stubGlobal("fetch", policyReceiver({ reject: true, echoInRejection: `\nvalue=${RUN_JWT} key=secret-key\u0007` }));
    const ctx = scopedCtx({ apiKey: "secret-key" });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_protocol_error");
    expect(result.errorMessage).toContain("Hermes gateway HTTP 400");
    expect(result.errorMessage).toContain("Run environment denied by policy");
    expect(result.errorMessage).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(JSON.stringify(result)).not.toContain(RUN_JWT);
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  // No recognizable 12-character window of a synthetic credential may survive
  // anywhere in the result or the run log.
  function expectNoSecretFragments(haystack: string, secrets: string[]) {
    for (const secret of secrets) {
      for (let i = 0; i + 12 <= secret.length; i += 6) {
        expect(haystack).not.toContain(secret.slice(i, i + 12));
      }
    }
  }

  it("redacts long echoed credentials before truncating the receiver reason", async () => {
    const longKey = `synthetic-only-credential-${"k3y".repeat(140)}`;
    const longJwt = `synthetic.run-token.${"j0t".repeat(140)}`;
    // The echo starts well before the 300-character cutoff and runs past it.
    const echo = `: ${"x".repeat(240)} key=${longKey}\nrun=${longJwt} auth=Bearer ${longKey}`;
    vi.stubGlobal("fetch", policyReceiver({ reject: true, echoInRejection: echo }));
    const ctx = scopedCtx({ apiKey: longKey });
    ctx.authToken = longJwt;

    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Run environment denied by policy");
    expect(result.errorMessage).not.toMatch(/[\u0000-\u001f\u007f]/);
    const logs = JSON.stringify((ctx.onLog as ReturnType<typeof vi.fn>).mock.calls);
    expectNoSecretFragments(`${JSON.stringify(result)}\n${logs}`, [longKey, longJwt]);
  });

  it("redacts a configured header secret even after control-character flattening reshapes it", async () => {
    // Whitespace inside the secret is collapsed by flattening, so the exact
    // configured value no longer appears in the flattened receipt text.
    const spacedKey = `synthetic\tonly  key ${"s3c".repeat(20)}`;
    const echoedKey = spacedKey.replace("\t", "\n");
    vi.stubGlobal("fetch", policyReceiver({ reject: true, echoInRejection: ` header=Bearer ${echoedKey}` }));
    const ctx = scopedCtx({ apiKey: spacedKey });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Run environment denied by policy");
    const logs = JSON.stringify((ctx.onLog as ReturnType<typeof vi.fn>).mock.calls);
    expectNoSecretFragments(`${JSON.stringify(result)}\n${logs}`, [
      spacedKey, echoedKey, spacedKey.replace(/\s+/g, " "),
    ]);
  });
});

describe("approval routing", () => {
  function approvalHarness(options: { statusApproval?: boolean; notPending?: boolean } = {}) {
    let push!: (text: string) => void;
    let close!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(new TextEncoder().encode(text));
        close = () => controller.close();
      },
    });
    const approvalEvent = {
      event: "approval.request",
      run_id: "run-hermes-1",
      timestamp: 1,
      command: "launchctl kickstart -k gui/501/ai.paperclip --token ghp_abcdefghijklmnopqrstuvwxyz0123",
      pattern_key: "stop/restart hermes launchd service (kills running agents)",
      pattern_keys: ["stop/restart hermes launchd service (kills running agents)"],
      description: "stop/restart hermes launchd service (kills running agents)",
      allow_permanent: true,
      allow_session: true,
      request_id: "req-1",
      choices: ["once", "session", "always", "deny"],
    };
    const approvalPosts: Array<Record<string, unknown>> = [];
    let answered = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        if (!options.statusApproval) {
          queueMicrotask(() => push(`event: approval.request\ndata: ${JSON.stringify(approvalEvent)}\n\n`));
        }
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (url.endsWith("/approval")) {
        expect(init?.method).toBe("POST");
        approvalPosts.push(JSON.parse(String(init?.body)));
        answered = true;
        queueMicrotask(() => {
          push(`event: run.completed\ndata: ${JSON.stringify({ status: "completed", output: "done" })}\n\n`);
          close();
        });
        if (options.notPending) {
          return new Response(JSON.stringify({ error: { message: "Run has no pending approval", code: "approval_not_pending" } }), { status: 409 });
        }
        return new Response(JSON.stringify({ object: "hermes.run.approval_response", resolved: 1 }), { status: 200 });
      }
      if (options.statusApproval && !answered) {
        return new Response(JSON.stringify({ status: "waiting_for_approval", approval: approvalEvent }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: answered ? "completed" : "running", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { approvalPosts };
  }

  it("routes an approval.request to the host board decision and posts the answer back", async () => {
    const { approvalPosts } = approvalHarness();
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 30, pollIntervalMs: 250 });
    const onEvent = vi.fn(async () => undefined);
    const onApprovalRequest = vi.fn(async (request: AdapterApprovalRequest) => ({
      decision: "approved" as const,
      decidedBy: "board" as const,
      approvalId: "appr-1",
      requestId: request.requestId,
      commandSha256: request.commandSha256,
    }));
    ctx.onEvent = onEvent;
    ctx.onApprovalRequest = onApprovalRequest;

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(onApprovalRequest).toHaveBeenCalledTimes(1);
    const request = (onApprovalRequest.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(request).toMatchObject({ requestId: "req-1", providerRunId: "run-hermes-1", commandComplete: false });
    expect(String(request.command)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(approvalPosts).toEqual([{ choice: "once", request_id: "req-1" }]);
    const eventTypes = (onEvent.mock.calls as unknown as Array<[{ eventType: string }]>).map(([event]) => event.eventType);
    expect(eventTypes).toEqual(expect.arrayContaining(["adapter.approval.requested", "adapter.approval.resolved"]));
    // The per-event stream log line carries the frame, but never the raw token.
    const logged = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[1])).join("");
    expect(logged).toContain("event=approval.request");
    expect(logged).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  });

  it("denies a pending approval and stops the run when the Paperclip run is cancelled", async () => {
    const { approvalPosts } = approvalHarness();
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 30 });
    const runAbort = new AbortController();
    ctx.signal = runAbort.signal;
    const onCancellationReady = vi.fn(async () => undefined);
    ctx.onCancellationReady = onCancellationReady;
    ctx.onApprovalRequest = vi.fn((request: AdapterApprovalRequest) => {
      setTimeout(() => runAbort.abort(), 5);
      return new Promise<AdapterApprovalDecision>((resolve) => {
        request.signal.addEventListener("abort", () => resolve({ decision: "cancelled", decidedBy: "system" }));
      });
    });

    const result = await execute(ctx);

    expect(onCancellationReady).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBe("hermes_gateway_cancelled");
    expect(approvalPosts).toEqual([{ choice: "deny", request_id: "req-1" }]);
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(urls.findIndex((url) => url.endsWith("/approval"))).toBeLessThan(urls.findIndex((url) => url.endsWith("/stop")));
  });

  it("redacts approval commands in the status record that reaches final_status", async () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123";
    const approval = { event: "approval.request", request_id: "req-7", command: `deploy --token ${token}`, nested: [{ command: `x --token ${token}` }] };
    let stopped = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "run-hermes-1" }), { status: 200 });
      if (url.endsWith("/events")) {
        return new Response(sseStream(`event: approval.request\ndata: ${JSON.stringify(approval)}\n\n`), { status: 200 });
      }
      if (url.endsWith("/approval")) return new Response(JSON.stringify({ resolved: 1 }), { status: 200 });
      if (url.endsWith("/stop")) {
        stopped = true;
        return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: stopped ? "cancelled" : "waiting_for_approval", approval }), { status: 200 });
    }));
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 1, pollIntervalMs: 250 });

    const result = await execute(ctx);

    expect(result.errorCode).toBe("hermes_gateway_timeout");
    expect(JSON.stringify(result.resultJson?.final_status)).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain(token);
    const logged = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[1])).join("");
    expect(logged).not.toContain(token);
  });

  it("reports approval_not_pending from Hermes as an undelivered answer", async () => {
    approvalHarness({ notPending: true });
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 30 });
    const onDelivery = vi.fn(async (_delivery: AdapterApprovalDelivery) => undefined);
    ctx.onApprovalRequest = vi.fn(async (request: AdapterApprovalRequest) => ({
      decision: "approved" as const,
      decidedBy: "board" as const,
      requestId: request.requestId,
      commandSha256: request.commandSha256,
      onDelivery,
    }));

    await execute(ctx);

    expect(onDelivery).toHaveBeenCalledWith({ delivered: false, choice: "once", reason: "approval_not_pending" });
  });

  it("denies a board timeout with the deny choice", async () => {
    const { approvalPosts } = approvalHarness();
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 30, approvalBoardTimeoutSec: 10 });
    ctx.onApprovalRequest = vi.fn(async (request) => {
      expect(request.timeoutMs).toBe(10_000);
      return { decision: "timeout" as const, decidedBy: "system" as const, note: "No board decision before the approval timeout" };
    });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(approvalPosts).toEqual([{ choice: "deny", request_id: "req-1" }]);
  });

  it("picks up a pending approval from the status poll when the stream misses it", async () => {
    const { approvalPosts } = approvalHarness({ statusApproval: true });
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 30, pollIntervalMs: 250 });
    const onApprovalRequest = vi.fn(async (_request: AdapterApprovalRequest) => ({ decision: "denied" as const, decidedBy: "board" as const }));
    ctx.onApprovalRequest = onApprovalRequest;

    await execute(ctx);

    expect(onApprovalRequest).toHaveBeenCalledTimes(1);
    expect(approvalPosts).toEqual([{ choice: "deny", request_id: "req-1" }]);
  });

  it("withdraws a pending host decision when the Hermes run ends first", async () => {
    let push!: (text: string) => void;
    let close!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(new TextEncoder().encode(text));
        close = () => controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "run-hermes-1" }), { status: 200 });
      if (url.endsWith("/events")) {
        queueMicrotask(() => {
          push(`event: approval.request\ndata: ${JSON.stringify({ event: "approval.request", request_id: "req-9", command: "sudo ls" })}\n\n`);
          setTimeout(() => {
            push(`event: run.cancelled\ndata: ${JSON.stringify({ status: "cancelled" })}\n\n`);
            close();
          }, 20);
        });
        return new Response(stream, { status: 200 });
      }
      if (url.endsWith("/approval")) throw new Error("must not answer after the run ended");
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    }));
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 30 });
    let sawAbort = false;
    ctx.onApprovalRequest = vi.fn((request: AdapterApprovalRequest) => new Promise<AdapterApprovalDecision>((resolve) => {
      request.signal.addEventListener("abort", () => {
        sawAbort = true;
        resolve({ decision: "cancelled" as const, decidedBy: "system" as const });
      });
    }));

    const result = await execute(ctx);

    expect(result.errorCode).toBe("hermes_gateway_cancelled");
    expect(sawAbort).toBe(true);
  });
});
