import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
const select = vi.hoisted(() => vi.fn(() => {throw new Error("managed selection must not run");}));
vi.mock("../services/ai-connections.js",()=>({aiConnectionService:()=>({select})}));
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import os from "node:os";
import type { Db } from "@paperclipai/db";
const base = {companyId:"company-fixture",agentId:"agent-fixture",responsibleUserId:"user-fixture",adapterType:"claude_local",binding:{mode:"responsible_user" as const,provider:"anthropic" as const,method:"subscription" as const},config:{localClaudeLogin:true,engine:"cli",model:"claude-opus-5-5",cwd:"/synthetic/workspace",env:{CLAUDE_CODE_OAUTH_TOKEN:"synthetic",PAPERCLIP_API_KEY:"task-fixture"}}};
beforeEach(() => vi.stubEnv("PAPERCLIP_LOCAL_CLAUDE_LOGIN_TARGET_JSON", JSON.stringify({companyId: "company-fixture", agentId: "agent-fixture", userId: "user-fixture", host: os.hostname(), uid: process.getuid?.(), home: os.homedir(), configDir: os.homedir() + "/.paperclip-synthetic-no-settings", model: "claude-opus-5-5", command: "/synthetic/bin/claude", path: "/synthetic/bin:/usr/bin:/bin"})));
afterEach(()=>{vi.clearAllMocks();vi.unstubAllEnvs();});
describe("native mode preparation",()=>{
 it("does not read managed credential or copy native credential; preserves task env",async()=>{
  const result=await prepareManagedAiRuntime({} as Db,base);
  expect(select).not.toHaveBeenCalled();expect(result.config.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
  expect(result.config.env.PAPERCLIP_API_KEY).toBe("task-fixture");expect(result.home).toBeUndefined();expect(result.config.managedAiConnection).toBeUndefined();expect(result.accountName).toBe("Local Claude Code login");await result.cleanup();
 });
 it.each([{companyId:"foreign"},{agentId:"foreign"},{responsibleUserId:"foreign"},{adapterType:"codex_local"}])("denies identity mismatch before credential lookup %j",async change=>{
  await expect(prepareManagedAiRuntime({} as Db,{...base,...change})).rejects.toThrow();expect(select).not.toHaveBeenCalled();
 });
 it("managed mode never falls back to local",async()=>{
  await expect(prepareManagedAiRuntime({} as Db,{...base,config:{...base.config,localClaudeLogin:false}})).rejects.toThrow("managed selection must not run");expect(select).toHaveBeenCalled();
 });
});
