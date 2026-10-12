import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
const select = vi.hoisted(() => vi.fn(() => {throw new Error("managed selection must not run");}));
vi.mock("../services/ai-connections.js",()=>({aiConnectionService:()=>({select})}));
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "@paperclipai/db";
const base = {companyId:"company-fixture",agentId:"agent-fixture",responsibleUserId:"user-fixture",adapterType:"claude_local",binding:{mode:"responsible_user" as const,provider:"anthropic" as const,method:"subscription" as const},config:{localClaudeLogin:true,engine:"cli",model:"claude-opus-5-5",cwd:"/synthetic/workspace",env:{CLAUDE_CODE_OAUTH_TOKEN:"synthetic",PAPERCLIP_API_KEY:"task-fixture",CLAUDE_CONFIG_DIR:"/synthetic/hostile-config"}}};
// Synthetic empty HOME: default-home admission pins HOME/.claude, which must never be the runner's real one.
let home = "";
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-local-claude-runtime-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAPERCLIP_LOCAL_CLAUDE_LOGIN_TARGET_JSON", JSON.stringify({companyId: "company-fixture", agentId: "agent-fixture", userId: "user-fixture", host: os.hostname(), uid: process.getuid?.(), home, configDir: home + "/.claude", model: "claude-opus-5-5", command: "/synthetic/bin/claude", path: "/synthetic/bin:/usr/bin:/bin"}));
});
afterEach(async ()=>{vi.clearAllMocks();vi.unstubAllEnvs();await fs.rm(home,{recursive:true,force:true});});
describe("native mode preparation",()=>{
 it("does not read managed credential or copy native credential; preserves task env",async()=>{
  const result=await prepareManagedAiRuntime({} as Db,base);
  expect(select).not.toHaveBeenCalled();expect(result.config.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
  expect(result.config.env.PAPERCLIP_API_KEY).toBe("task-fixture");expect(result.home).toBeUndefined();expect(result.config.managedAiConnection).toBeUndefined();expect(result.accountName).toBe("Local Claude Code login");await result.cleanup();
 });
 it("default-home mode omits CLAUDE_CONFIG_DIR and pins HOME",async()=>{
  const result=await prepareManagedAiRuntime({} as Db,base);
  expect("CLAUDE_CONFIG_DIR" in result.config.env).toBe(false);expect(result.config.env.HOME).toBe(home);await result.cleanup();
 });
 it("refuses a non-default admitted config dir",async()=>{
  vi.stubEnv("PAPERCLIP_LOCAL_CLAUDE_LOGIN_TARGET_JSON", JSON.stringify({companyId: "company-fixture", agentId: "agent-fixture", userId: "user-fixture", host: os.hostname(), uid: process.getuid?.(), home, configDir: home + "/.paperclip-synthetic-custom", model: "claude-opus-5-5", command: "/synthetic/bin/claude", path: "/synthetic/bin:/usr/bin:/bin"}));
  await expect(prepareManagedAiRuntime({} as Db,base)).rejects.toThrow();expect(select).not.toHaveBeenCalled();
 });
 it.each([{companyId:"foreign"},{agentId:"foreign"},{responsibleUserId:"foreign"},{adapterType:"codex_local"}])("denies identity mismatch before credential lookup %j",async change=>{
  await expect(prepareManagedAiRuntime({} as Db,{...base,...change})).rejects.toThrow();expect(select).not.toHaveBeenCalled();
 });
 it("managed mode never falls back to local",async()=>{
  await expect(prepareManagedAiRuntime({} as Db,{...base,config:{...base.config,localClaudeLogin:false}})).rejects.toThrow("managed selection must not run");expect(select).toHaveBeenCalled();
 });
});
