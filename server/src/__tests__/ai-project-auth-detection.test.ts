import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertManagedAiProjectAuth, projectFileConfiguresAuth } from "../services/ai-connection-runtime.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("project auth settings detection", () => {
  it("flags Claude settings that configure authentication", () => {
    expect(projectFileConfiguresAuth(".claude/settings.json", JSON.stringify({ apiKeyHelper: "/bin/key-helper" }))).toBe(true);
    expect(projectFileConfiguresAuth(".claude/settings.json", JSON.stringify({ env: { ANTHROPIC_API_KEY: "x" } }))).toBe(true);
    expect(projectFileConfiguresAuth(".claude/settings.local.json", JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: "x" } }))).toBe(true);
    for (const env of [{ CLAUDE_CODE_USE_BEDROCK: "1" }, { ANTHROPIC_BASE_URL: "https://proxy" }, { CLAUDE_CONFIG_DIR: "/tmp/c" }]) {
      expect(projectFileConfiguresAuth(".claude/settings.json", JSON.stringify({ env }))).toBe(true);
    }
    for (const key of ["awsCredentialExport", "awsAuthRefresh", "forceLoginMethod"]) {
      expect(projectFileConfiguresAuth(".claude/settings.json", JSON.stringify({ [key]: "value" }))).toBe(true);
    }
    expect(projectFileConfiguresAuth(".claude/settings.json", JSON.stringify({ env: ["ANTHROPIC_API_KEY=x"] }))).toBe(true);
  });

  it("does not flag Claude settings that only mention auth variable names in unrelated text", () => {
    const settings = {
      autoMode: { environment: ["Agents read ANTHROPIC_API_KEY and OPENAI_API_KEY only from their managed connection."] },
      permissions: { allow: ["Bash(echo apiKeyHelper)"] },
      env: { EDITOR: "vim" },
    };
    expect(projectFileConfiguresAuth(".claude/settings.json", JSON.stringify(settings))).toBe(false);
  });

  it("keeps the strict textual check for files that cannot be parsed", () => {
    expect(projectFileConfiguresAuth(".claude/settings.json", "{ not json ANTHROPIC_API_KEY")).toBe(true);
    expect(projectFileConfiguresAuth(".claude/settings.json", "{ not json")).toBe(false);
  });

  it("ignores TOML comments but flags Codex auth configuration", () => {
    expect(projectFileConfiguresAuth(".codex/config.toml", "# set OPENAI_API_KEY in your shell\nmodel = \"gpt\"\n")).toBe(false);
    expect(projectFileConfiguresAuth(".codex/config.toml", "model_provider = \"custom\"\n")).toBe(true);
    expect(projectFileConfiguresAuth(".codex/config.toml", "[model_providers.x]\nenv_key = \"OPENAI_API_KEY\"\n")).toBe(true);
  });

  it("walks parent directories and rejects only real project auth configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-auth-"));
    roots.push(root);
    const cwd = path.join(root, "work", "project");
    await mkdir(cwd, { recursive: true });
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(path.join(root, ".claude", "settings.json"),
      JSON.stringify({ autoMode: { environment: ["mentions ANTHROPIC_API_KEY in prose"] } }));
    await expect(assertManagedAiProjectAuth({ cwd }, "anthropic")).resolves.toBeUndefined();
    await writeFile(path.join(root, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "/bin/helper" }));
    await expect(assertManagedAiProjectAuth({ cwd }, "anthropic")).rejects.toThrow("Project authentication settings conflict");
  });
});
