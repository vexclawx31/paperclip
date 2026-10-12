import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { projectToolContext } from "../services/project-tool-context.js";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";
import { callTaskTool, hasTaskToolCapability, TASK_TOOL_NAMES, taskToolDefinitions } from "../services/task-tools.js";
import { assertCompanyAccess } from "./authz.js";
import { forbidden } from "../errors.js";

/** Mounted after actor middleware; connection-scoped tokens cannot authenticate here. */
export function projectToolRoutes(db: Db) {
  const router = Router();
  router.post("/mcp/project-tools", async (req, res) => {
    const context = await projectToolContext(db, req.actor);
    assertCompanyAccess(req, context.run.companyId);
    const { id = null, method, params } = req.body;
    const send = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    if (method === "initialize") return send({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "paperclip-project-tools", version: "1" } });
    if (method === "notifications/initialized") return res.status(202).end();
    const definitions = projectToolDefinitions(context.issue.workMode, true);
    if (method === "tools/list") return send({ tools: definitions });
    if (method !== "tools/call") return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    try {
      if (!definitions.some(tool => tool.name === params?.name)) throw forbidden("Tool is unavailable in this mode");
      const apiUrl = process.env.PAPERCLIP_API_URL;
      if (!apiUrl) throw new Error("Paperclip API origin is unavailable");
      const result = await callProjectTool({
        name: params.name, arguments: params.arguments ?? {}, apiUrl,
        token: req.header("authorization")!.replace(/^Bearer\s+/i, ""),
        companyId: context.run.companyId, issueId: context.issue.id, agentId: context.run.agentId,
        conversation: Boolean(context.issue.conversationAgentId),
      });
      return send({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      return send({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Project tool failed" }] });
    }
  });
  // Task comment/status tools. Same run-JWT authority and server-derived issue
  // binding as project tools, plus the server-stamped run capability: only runs
  // the server delivered these tools to (admitted native Claude login) pass.
  router.post("/mcp/task-tools", async (req, res) => {
    const context = await projectToolContext(db, req.actor, false, "Task");
    assertCompanyAccess(req, context.run.companyId);
    const binding = {
      companyId: context.run.companyId, agentId: context.run.agentId,
      runId: context.run.id, issueId: context.issue.id,
    };
    if (!hasTaskToolCapability(context.run.contextSnapshot, binding)) {
      throw forbidden("Task tools are not enabled for this run");
    }
    // Stop forwarding when the MCP client disconnects or cancels the request.
    const disconnected = new AbortController();
    res.on("close", () => { if (!res.writableFinished) disconnected.abort(); });
    const { id = null, method, params } = req.body ?? {};
    const send = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    if (method === "initialize") return send({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "paperclip-task-tools", version: "1" } });
    if (method === "notifications/initialized") return res.status(202).end();
    if (method === "tools/list") return send({ tools: taskToolDefinitions() });
    if (method !== "tools/call") return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    try {
      if (!TASK_TOOL_NAMES.includes(params?.name)) throw forbidden("Tool is unavailable");
      const apiUrl = process.env.PAPERCLIP_API_URL;
      if (!apiUrl) throw new Error("Paperclip API origin is unavailable");
      const result = await callTaskTool(db, {
        binding, name: params.name, arguments: params.arguments ?? {}, apiUrl,
        token: req.header("authorization")!.replace(/^Bearer\s+/i, ""),
        signal: disconnected.signal,
      });
      return send({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      return send({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Task tool failed" }] });
    }
  });
  return router;
}
