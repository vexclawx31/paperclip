import os from "node:os";

// Server/operator environment only: never accept admission pins from agent config.
export interface LocalClaudeLoginTarget {
  companyId: string; agentId: string; userId: string; host: string;
  uid: number; home: string; configDir: string; model: string; command: string; path: string;
}
export function readLocalClaudeLoginTarget(): LocalClaudeLoginTarget {
  let value: unknown;
  try { value = JSON.parse(process.env.PAPERCLIP_LOCAL_CLAUDE_LOGIN_TARGET_JSON ?? ""); }
  catch { throw new Error("Local Claude login is not admitted on this server"); }
  const target = value as LocalClaudeLoginTarget;
  if (!target || typeof target !== "object" ||
      ["companyId", "agentId", "userId", "host", "home", "configDir", "model", "command", "path"].some(key =>
        typeof (target as unknown as Record<string, unknown>)[key] !== "string" ||
        !(target as unknown as Record<string, string>)[key].trim()) ||
      !Number.isSafeInteger(target.uid) || target.uid < 0 ||
      // Default-home mode only: an explicit CLAUDE_CONFIG_DIR selects a different
      // native credential context, so other config dirs stay refused.
      !target.home.startsWith("/") || target.configDir !== target.home + "/.claude" ||
      !target.command.startsWith("/") || target.command.includes("..") ||
      target.path.split(":").some(entry => !entry.startsWith("/") || entry.includes(".."))) {
    throw new Error("Local Claude login admission is invalid");
  }
  return target;
}
export const LOCAL_CLAUDE_AUTH_KEYS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;
// Native Claude must resolve its default config under the pinned HOME. The
// process launcher removes these after the host env merge; blanking is not enough.
export const LOCAL_CLAUDE_LOGIN_UNSET_ENV_KEYS = ["CLAUDE_CONFIG_DIR"] as const;
// Run-scoped task write tools delivered only to admitted native-login runs.
// Default permissions refuse shell HTTP; these exact MCP tools are pre-approved
// instead of any Bash/command-prefix rule. The server binds them to the run's task.
export const LOCAL_CLAUDE_TASK_TOOL_SERVER = {
  name: "paperclip-task",
  connectionId: "paperclip-task-tools",
  tools: ["add_task_comment", "update_task_status"],
} as const;
/** Prompt section added only when the exact task tools were admitted for this run. */
export const LOCAL_CLAUDE_TASK_TOOL_PROMPT = [
  "## Paperclip task writes in this run",
  "Shell HTTP calls to the Paperclip API (curl, node, scripts) are not permitted in this run and will be refused.",
  "Where the Paperclip skill tells you to call the API to comment on or change the status of your current task, use these tools instead:",
  "- `mcp__paperclip-task__add_task_comment` for task comments.",
  "- `mcp__paperclip-task__update_task_status` for in_progress, in_review, blocked or done. Blocking requires a comment explaining the blocker and an `unblockAction` naming the exact action that unblocks it.",
  "Give every call a new `idempotencyKey`; reuse a key only to retry the identical call after a timeout. If a retry reports an unknown outcome, inspect the task before acting again.",
  "Other Paperclip operations are unavailable here; describe what is needed in a task comment instead of attempting them through the shell.",
].join("\n");
/** Exact `--allowedTools` entries, or none unless the server is delivered unambiguously. */
export function localClaudeTaskToolAllowedNames(servers: ReadonlyArray<{ name: string; connectionId: string; url: string }>): string[] {
  const server = LOCAL_CLAUDE_TASK_TOOL_SERVER;
  const matches = servers.filter(candidate => candidate.connectionId === server.connectionId);
  if (matches.length !== 1 || matches[0].name !== server.name ||
      servers.filter(candidate => candidate.name === server.name).length !== 1 ||
      !/\/api\/mcp\/task-tools$/.test(matches[0].url)) return [];
  return server.tools.map(tool => `mcp__${server.name}__${tool}`);
}
export function assertLocalClaudeLoginContext(input: {
  companyId: string; agentId: string; userId?: string | null;
  adapterType?: string; config: Record<string, unknown>; remote?: boolean;
}, host = { hostname: os.hostname(), uid: process.getuid?.(), home: os.homedir() }) {
  const target = readLocalClaudeLoginTarget();
  if (input.companyId !== target.companyId || input.agentId !== target.agentId ||
      (input.userId !== undefined && input.userId !== target.userId) ||
      (input.adapterType !== undefined && input.adapterType !== "claude_local") ||
      host.hostname !== target.host || host.uid !== target.uid || host.home !== target.home ||
      input.remote || input.config.engine !== "cli" || input.config.model !== target.model ||
      input.config.filesystemScope || input.config.networkScope || input.config.chrome || input.config.managedAiConnection) {
    throw new Error("Local Claude login is unavailable in this execution context");
  }
  if (input.config.command !== undefined && input.config.command !== target.command) {
    throw new Error("Local Claude login requires the operator-pinned executable");
  }
  const configuredEnv = (input.config.env ?? {}) as Record<string, unknown>;
  if ((configuredEnv.PATH !== undefined && configuredEnv.PATH !== target.path) || Object.keys(configuredEnv).some(key => /^(NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|ZDOTDIR|PAPERCLIP_LOCAL_CLAUDE_LOGIN_TARGET_JSON)$/i.test(key))) {
    throw new Error("Local Claude login cannot override executable environment");
  }
  const args = [...(Array.isArray(input.config.extraArgs) ? input.config.extraArgs : []),
    ...(Array.isArray(input.config.args) ? input.config.args : [])];
  if (args.length > 0) {
    throw new Error("Local Claude login cannot override authentication or customization isolation");
  }
}
export function localClaudeLoginEnvironment(env: Record<string, unknown>): Record<string, unknown> {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (LOCAL_CLAUDE_AUTH_KEYS.some(auth => auth.toLowerCase() === key.toLowerCase())) delete result[key];
  }
  // Blank keys override the host environment when the process runner merges it.
  for (const key of LOCAL_CLAUDE_AUTH_KEYS) result[key] = "";
  const target = readLocalClaudeLoginTarget();
  for (const key of Object.keys(result)) {
    if (/^(NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|ZDOTDIR)$/i.test(key)) delete result[key];
    if (LOCAL_CLAUDE_LOGIN_UNSET_ENV_KEYS.some(unset => unset === key.toUpperCase())) delete result[key];
  }
  result.PATH = target.path;
  result.HOME = target.home;
  delete result.PAPERCLIP_LOCAL_CLAUDE_LOGIN_TARGET_JSON;
  return result;
}
