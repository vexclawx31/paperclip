import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { LOCAL_CLAUDE_TASK_TOOL_SERVER } from "@paperclipai/adapter-claude-local/server";

// Synthetic run/issue registry standing in for the run-identity lock + DB. The
// transactional write path itself is covered by task-tools.integration.test.ts.
type FakeRun = { id: string; companyId: string; agentId: string; status: string; nativeIssueId: string | null; contextSnapshot: Record<string, unknown>; responsibleUserId: string | null };
const state = vi.hoisted(() => ({
  runs: new Map<string, FakeRun>(),
  issues: new Map<string, { id: string; companyId: string; workMode: string; conversationAgentId: string | null; conversationSessionGeneration: number }>(),
  lastIssueId: null as string | null,
  lastRun: null as FakeRun | null,
}));
const callTaskTool = vi.hoisted(() => vi.fn());
vi.mock("../services/run-identity.js", async () => {
  const { forbidden } = await import("../errors.js");
  return {
    captureRunIdentity: vi.fn(async (_db: unknown, input: { companyId: string; agentId: string; runId: string }) => {
      const run = state.runs.get(input.runId);
      if (!run || run.companyId !== input.companyId || run.agentId !== input.agentId || run.status !== "running") {
        throw forbidden("Credential acquisition requires this agent's active run");
      }
      state.lastRun = run;
      state.lastIssueId = run.nativeIssueId ?? (typeof run.contextSnapshot.issueId === "string" ? run.contextSnapshot.issueId : null);
      return { run, context: null };
    }),
  };
});
vi.mock("../services/task-tools.js", async () => ({
  ...(await vi.importActual<typeof import("../services/task-tools.js")>("../services/task-tools.js")),
  callTaskTool,
}));

import { projectToolRoutes } from "../routes/project-tools.js";
import { errorHandler } from "../middleware/index.js";
import { TASK_TOOL_CAPABILITY_CONTEXT_KEY, TASK_TOOL_NAMES, taskToolCapabilityMarker } from "../services/task-tools.js";

const fakeDb = {
  select: () => ({ from: () => ({ where: async () => {
    const issue = state.lastIssueId ? state.issues.get(state.lastIssueId) : undefined;
    return issue && state.lastRun && issue.companyId === state.lastRun.companyId ? [issue] : [];
  } }) }),
} as unknown as Db;

let actor: Record<string, unknown> = { type: "none" };
function app() {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = actor; next(); });
  server.use("/api", projectToolRoutes(fakeDb));
  server.use(errorHandler);
  return server;
}
const runActor = { type: "agent", source: "agent_jwt", agentId: "agent-a", companyId: "company-a", runId: "run-a" };
const rpc = (method: string, params?: unknown) => request(app()).post("/api/mcp/task-tools")
  .set("Authorization", "Bearer synthetic-run-jwt").send({ jsonrpc: "2.0", id: 1, method, params });
const call = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });
const stamped = (agentId: string, issueId: string) => ({ issueId, [TASK_TOOL_CAPABILITY_CONTEXT_KEY]: taskToolCapabilityMarker({ agentId, issueId }) });

beforeEach(() => {
  state.runs.clear(); state.issues.clear(); state.lastIssueId = null; state.lastRun = null;
  state.runs.set("run-a", { id: "run-a", companyId: "company-a", agentId: "agent-a", status: "running", nativeIssueId: "issue-a", contextSnapshot: stamped("agent-a", "issue-a"), responsibleUserId: null });
  state.runs.set("run-b", { id: "run-b", companyId: "company-b", agentId: "agent-b", status: "running", nativeIssueId: "issue-b", contextSnapshot: stamped("agent-b", "issue-b"), responsibleUserId: null });
  state.runs.set("run-ordinary", { id: "run-ordinary", companyId: "company-a", agentId: "agent-a", status: "running", nativeIssueId: "issue-a", contextSnapshot: { issueId: "issue-a" }, responsibleUserId: null });
  state.issues.set("issue-a", { id: "issue-a", companyId: "company-a", workMode: "standard", conversationAgentId: null, conversationSessionGeneration: 0 });
  state.issues.set("issue-b", { id: "issue-b", companyId: "company-b", workMode: "standard", conversationAgentId: null, conversationSessionGeneration: 0 });
  actor = { ...runActor };
  callTaskTool.mockReset();
  callTaskTool.mockResolvedValue({ commentId: "comment-1", issueId: "issue-a", disposition: "applied" });
  vi.stubEnv("PAPERCLIP_API_URL", "http://paperclip.test/api");
});
afterEach(() => vi.unstubAllEnvs());

describe("task-tools endpoint admission", () => {
  it("advertises exactly the closed tools the adapter pre-approves", async () => {
    const res = await rpc("tools/list");
    expect(res.status).toBe(200);
    const tools = res.body.result.tools as Array<{ name: string; inputSchema: Record<string, unknown> }>;
    expect(tools.map(tool => tool.name)).toEqual([...TASK_TOOL_NAMES]);
    expect([...TASK_TOOL_NAMES]).toEqual([...LOCAL_CLAUDE_TASK_TOOL_SERVER.tools]);
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.required).toContain("idempotencyKey");
    }
    expect(JSON.stringify(tools)).not.toMatch(/"(url|path|method|headers|issueId|runId|companyId|onBehalfOfUserId|command|file|owner)"/);
  });

  it("passes only the server-derived binding and a cancellation signal to the service", async () => {
    const res = await call("add_task_comment", { body: "x", idempotencyKey: "route-key-1", issueId: "issue-b" });
    expect(res.body.result.isError).toBeUndefined();
    expect(callTaskTool).toHaveBeenCalledTimes(1);
    const [, input] = callTaskTool.mock.calls[0]!;
    expect(input.binding).toEqual({ companyId: "company-a", agentId: "agent-a", runId: "run-a", issueId: "issue-a" });
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(input.token).toBe("synthetic-run-jwt");
  });

  it.each(["initialize", "tools/list", "tools/call"])("denies %s for an active run the server did not enable", async method => {
    actor = { ...runActor, runId: "run-ordinary" };
    const res = await rpc(method, method === "tools/call" ? { name: "add_task_comment", arguments: { body: "x", idempotencyKey: "route-key-2" } } : undefined);
    expect(res.status).toBe(403);
    expect(callTaskTool).not.toHaveBeenCalled();
  });

  it.each([
    ["marker for another issue", stamped("agent-a", "issue-b")],
    ["marker for another agent", stamped("agent-b", "issue-a")],
    ["caller-shaped marker", { issueId: "issue-a", [TASK_TOOL_CAPABILITY_CONTEXT_KEY]: { version: 2, agentId: "agent-a", issueId: "issue-a" } }],
  ])("denies a %s", async (_label, contextSnapshot) => {
    state.runs.get("run-a")!.contextSnapshot = contextSnapshot;
    expect((await call("add_task_comment", { body: "x", idempotencyKey: "route-key-3" })).status).toBe(403);
    expect(callTaskTool).not.toHaveBeenCalled();
  });

  it.each(["call_api", "create_project", "set_task_title", "generic_api_request", "../issues", "add_task_comment "])("rejects unadvertised tool %s", async name => {
    const res = await call(name, { body: "x", idempotencyKey: "route-key-4" });
    expect(res.body.result.isError).toBe(true);
    expect(callTaskTool).not.toHaveBeenCalled();
  });

  it.each([
    ["missing credential", { type: "none" }],
    ["board session", { type: "board", userId: "user-board", source: "session" }],
    ["long-lived agent key", { ...runActor, source: "agent_key" }],
    ["run JWT without run id", { ...runActor, runId: undefined }],
    ["foreign run", { ...runActor, runId: "run-b" }],
    ["foreign company claim", { ...runActor, companyId: "company-b" }],
    ["unknown run", { ...runActor, runId: "run-missing" }],
  ])("denies %s", async (_label, candidate) => {
    actor = candidate;
    expect((await call("add_task_comment", { body: "x", idempotencyKey: "route-key-5" })).status).toBe(403);
    expect(callTaskTool).not.toHaveBeenCalled();
  });

  it("denies a finished (expired) run and a run without a task", async () => {
    state.runs.get("run-a")!.status = "succeeded";
    expect((await call("add_task_comment", { body: "x", idempotencyKey: "route-key-6" })).status).toBe(403);
    state.runs.get("run-a")!.status = "running";
    state.runs.get("run-a")!.nativeIssueId = null;
    state.runs.get("run-a")!.contextSnapshot = { [TASK_TOOL_CAPABILITY_CONTEXT_KEY]: taskToolCapabilityMarker({ agentId: "agent-a", issueId: "issue-a" }) };
    expect((await call("add_task_comment", { body: "x", idempotencyKey: "route-key-7" })).status).toBe(403);
    expect(callTaskTool).not.toHaveBeenCalled();
  });

  it("surfaces service refusals as MCP errors", async () => {
    callTaskTool.mockRejectedValueOnce(new Error("Task tools are not authorized for this run"));
    const res = await call("update_task_status", { status: "done", idempotencyKey: "route-key-8" });
    expect(res.body.result).toMatchObject({ isError: true, content: [{ text: "Task tools are not authorized for this run" }] });
  });
});
