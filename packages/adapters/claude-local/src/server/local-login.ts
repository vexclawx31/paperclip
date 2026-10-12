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
      !target.home.startsWith("/") || !target.configDir.startsWith(target.home + "/") ||
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
  }
  result.PATH = target.path;
  result.HOME = target.home;
  result.CLAUDE_CONFIG_DIR = target.configDir;
  delete result.PAPERCLIP_LOCAL_CLAUDE_LOGIN_TARGET_JSON;
  return result;
}
