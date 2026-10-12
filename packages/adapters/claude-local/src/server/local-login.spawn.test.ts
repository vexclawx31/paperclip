import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

// Synthetic fixtures only: no real credential, settings, or Claude binary is read
// or launched. The admitted "claude" is a harmless node script that records the
// env it actually received after the shared runner merged host process.env.
const HOST_LOADER_ENV = {
  NODE_OPTIONS: "--no-deprecation",
  NODE_PATH: "/synthetic/host/node-path",
  LD_SYNTHETIC_FIXTURE: "/synthetic/host/ld",
  DYLD_SYNTHETIC_FIXTURE: "/synthetic/host/dyld",
  BASH_ENV: "/synthetic/host/bash-env",
  ENV: "/synthetic/host/env",
  ZDOTDIR: "/synthetic/host/zdotdir",
};
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

async function writeFakeClaude(commandPath: string, dumpDir: string, label: string, version: string) {
  const script = `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
const kind = argv.includes("--version") ? "version" : "run";
fs.writeFileSync(${JSON.stringify(dumpDir)} + "/${label}-" + kind + "-" + process.pid + ".json", JSON.stringify({ argv, env: process.env }));
if (kind === "version") { console.log("${version} (Claude Code)"); process.exit(0); }
try { fs.readFileSync(0, "utf8"); } catch {}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "${SESSION_ID}", model: "claude-opus-5-5" }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "${SESSION_ID}", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

let root = "";
let fixture: {
  workspace: string; dumpDir: string;
  target: { companyId: string; agentId: string; userId: string; host: string; uid: number; home: string;
    configDir: string; model: string; command: string; path: string };
};

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-local-login-spawn-")));
  const admittedBin = path.join(root, "admitted-bin");
  const hostBin = path.join(root, "host-bin");
  const dumpDir = path.join(root, "dumps");
  const workspace = path.join(root, "workspace");
  for (const dir of [admittedBin, hostBin, dumpDir, workspace]) await fs.mkdir(dir, { recursive: true });
  await writeFakeClaude(path.join(admittedBin, "claude"), dumpDir, "admitted", "2.1.280");
  // A different, too-old `claude` first on the host PATH must never be selected.
  await writeFakeClaude(path.join(hostBin, "claude"), dumpDir, "decoy", "1.0.0");
  const target = {
    companyId: "company-fixture", agentId: "agent-fixture", userId: "user-fixture",
    host: os.hostname(), uid: process.getuid?.() ?? 0, home: root, configDir: path.join(root, ".claude"),
    model: "claude-opus-5-5", command: path.join(admittedBin, "claude"), path: `${admittedBin}:/usr/bin:/bin`,
  };
  fixture = { workspace, dumpDir, target };
  vi.stubEnv("PAPERCLIP_LOCAL_CLAUDE_LOGIN_TARGET_JSON", JSON.stringify(target));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PATH", `${hostBin}:/usr/bin:/bin`);
  vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "synthetic");
  // Hostile inherited config dirs: default-home mode must omit them at final spawn.
  vi.stubEnv("CLAUDE_CONFIG_DIR", "/synthetic/host/claude-config");
  vi.stubEnv("claude_config_dir", "/synthetic/host/claude-config-lower");
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-host-provider-value");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-host-provider-value");
  for (const [key, value] of Object.entries(HOST_LOADER_ENV)) vi.stubEnv(key, value);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function readDumps() {
  const names = (await fs.readdir(fixture.dumpDir)).sort();
  return Promise.all(names.map(async (name) => ({
    name,
    ...(JSON.parse(await fs.readFile(path.join(fixture.dumpDir, name), "utf8")) as {
      argv: string[]; env: Record<string, string>;
    }),
  })));
}

function expectAdmittedChildEnv(env: Record<string, string>) {
  for (const key of Object.keys(HOST_LOADER_ENV)) expect(env[key]).toBeUndefined();
  expect(env.PAPERCLIP_LOCAL_CLAUDE_LOGIN_TARGET_JSON).toBeUndefined();
  expect(env.PATH).toBe(fixture.target.path);
  expect(env.HOME).toBe(fixture.target.home);
  // Native Claude derives HOME/.claude itself; any explicit dir selects another credential context.
  for (const key of Object.keys(env)) expect(key.toUpperCase()).not.toBe("CLAUDE_CONFIG_DIR");
  expect(env.ANTHROPIC_API_KEY).toBe("");
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
}

describe("admitted native Claude login final child env", () => {
  it("execute launches the admitted command with host loader variables stripped after the host merge", async () => {
    const result = await execute({
      runId: "run-local-login-spawn",
      agent: { id: fixture.target.agentId, companyId: fixture.target.companyId, name: "Claude",
        adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { localClaudeLogin: true, engine: "cli", model: "claude-opus-5-5", cwd: fixture.workspace,
        promptTemplate: "Synthetic prompt.", env: { CLAUDE_CONFIG_DIR: "/synthetic/configured/claude-config" } },
      context: {},
      authToken: "task-fixture",
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    const dumps = await readDumps();
    expect(dumps.some((dump) => dump.name.startsWith("decoy-"))).toBe(false);
    const version = dumps.filter((dump) => dump.name.startsWith("admitted-version-"));
    const run = dumps.filter((dump) => dump.name.startsWith("admitted-run-"));
    expect(version).toHaveLength(1);
    expect(run).toHaveLength(1);
    for (const dump of [...version, ...run]) expectAdmittedChildEnv(dump.env);
    expect(run[0].env.PAPERCLIP_API_KEY).toBe("task-fixture");
    expect(run[0].argv).toContain("--safe-mode");
    expect(run[0].argv[run[0].argv.indexOf("--model") + 1]).toBe("claude-opus-5-5");
  });

  it("local probe selects the admitted command and PATH even when host PATH resolves a different claude", async () => {
    const result = await testEnvironment({
      companyId: fixture.target.companyId,
      adapterType: "claude_local",
      config: { localClaudeLogin: true, localClaudeLoginAgentId: fixture.target.agentId, engine: "cli",
        model: "claude-opus-5-5", cwd: fixture.workspace, command: fixture.target.command,
        env: { PATH: fixture.target.path, CLAUDE_CODE_OAUTH_TOKEN: "synthetic-config-value",
          CLAUDE_CONFIG_DIR: "/synthetic/configured/claude-config" } },
      executionTarget: null,
    });
    const codes = result.checks.map((check) => check.code);
    expect(codes).toContain("claude_hello_probe_passed");
    expect(codes).not.toContain("claude_cli_version_probe_mismatch");
    expect(codes).not.toContain("claude_cli_version_incompatible");
    expect(codes).not.toContain("claude_hello_probe_skipped_unresolved_command");
    const dumps = await readDumps();
    expect(dumps.some((dump) => dump.name.startsWith("decoy-"))).toBe(false);
    expect(dumps.filter((dump) => dump.name.startsWith("admitted-version-"))).toHaveLength(1);
    expect(dumps.filter((dump) => dump.name.startsWith("admitted-run-"))).toHaveLength(1);
    for (const dump of dumps) expectAdmittedChildEnv(dump.env);
  });

  it("ordinary execute keeps its configured CLAUDE_CONFIG_DIR", async () => {
    vi.stubEnv("PAPERCLIP_LOCAL_CLAUDE_LOGIN_TARGET_JSON", "");
    const result = await execute({
      runId: "run-ordinary-config-dir",
      agent: { id: "agent-ordinary", companyId: "company-ordinary", name: "Claude",
        adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", model: "claude-opus-5-5", cwd: fixture.workspace, command: fixture.target.command,
        promptTemplate: "Synthetic prompt.", env: { CLAUDE_CONFIG_DIR: "/synthetic/configured/claude-config" } },
      context: {},
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    const run = (await readDumps()).filter((dump) => dump.name.startsWith("admitted-run-"));
    expect(run).toHaveLength(1);
    expect(run[0].env.CLAUDE_CONFIG_DIR).toBe("/synthetic/configured/claude-config");
  });

  it("ordinary local probe keeps deny-by-default bare `claude` resolution on host PATH", async () => {
    vi.stubEnv("PAPERCLIP_LOCAL_CLAUDE_LOGIN_TARGET_JSON", "");
    const result = await testEnvironment({
      companyId: fixture.target.companyId,
      adapterType: "claude_local",
      config: { engine: "cli", model: "claude-opus-5-5", cwd: fixture.workspace,
        env: { PATH: fixture.target.path } },
      executionTarget: null,
    });
    // The caller PATH selects the admitted dir at runtime, but the ordinary probe
    // resolves `claude` from trusted host PATH only and refuses to mix the two.
    expect(result.checks.map((check) => check.code)).toContain("claude_cli_version_probe_mismatch");
    const dumps = await readDumps();
    expect(dumps.some((dump) => dump.name.startsWith("admitted-"))).toBe(false);
  });
});
