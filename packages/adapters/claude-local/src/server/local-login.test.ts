import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { assertLocalClaudeLoginContext, localClaudeLoginEnvironment, readLocalClaudeLoginTarget, LOCAL_CLAUDE_AUTH_KEYS } from "./local-login.js";
const target = { companyId: "company-fixture", agentId: "agent-fixture", userId: "user-fixture", host: "host.fixture", uid: 501, home: "/synthetic/home", configDir: "/synthetic/home/.claude", model: "claude-opus-5-5", command: "/synthetic/bin/claude", path: "/synthetic/bin:/usr/bin:/bin" };
beforeEach(() => vi.stubEnv("PAPERCLIP_LOCAL_CLAUDE_LOGIN_TARGET_JSON", JSON.stringify(target)));
afterEach(() => vi.unstubAllEnvs());
const host = { hostname: target.host, uid: target.uid, home: target.home };
const input = { companyId: target.companyId, agentId: target.agentId, userId: target.userId, adapterType: "claude_local", config: {engine: "cli", model: "claude-opus-5-5", dangerouslySkipPermissions: false} };
describe("explicit bounded native Claude login", () => {
 it("denies missing operator admission even when agent config supplies pins", () => {
   vi.stubEnv("PAPERCLIP_LOCAL_CLAUDE_LOGIN_TARGET_JSON", "");
   expect(() => assertLocalClaudeLoginContext({...input, config: {...input.config, localClaudeLoginTarget: target}}, host)).toThrow();
 });
 it.each(["null", "{}", "invalid"])("denies malformed operator admission %s", value => {
   vi.stubEnv("PAPERCLIP_LOCAL_CLAUDE_LOGIN_TARGET_JSON", value);
   expect(() => readLocalClaudeLoginTarget()).toThrow();
 });
 it("accepts only the admitted local principal", () => expect(() => assertLocalClaudeLoginContext(input, host)).not.toThrow());
 it.each([{companyId:"other"},{agentId:"other"},{userId:"other"},{userId:null},{adapterType:"codex_local"},{remote:true}])("denies foreign or remote context %j", change => expect(() => assertLocalClaudeLoginContext({...input,...change},host)).toThrow());
 it.each([{hostname:"other"},{uid:0},{home:"/root"}])("denies another host/user %j", change => expect(() => assertLocalClaudeLoginContext(input,{...host,...change})).toThrow());
 it.each([{engine:"acp"},{model:"other"},{filesystemScope:"workspace"},{networkScope:"allowlist"},{managedAiConnection:{}},{extraArgs:["--settings=x"]},{extraArgs:["--fallback-model", "other"]},{command:"/workspace/fake"},{env:{NODE_OPTIONS:"--require=/workspace/fake"}},{env:{PATH:"/workspace"}}])("denies competing execution %j", change => expect(() => assertLocalClaudeLoginContext({...input,config:{...input.config,...change}},host)).toThrow());
 it("blanks competing auth without altering task credentials or permissions", () => {
   const env = localClaudeLoginEnvironment({CLAUDE_CODE_OAUTH_TOKEN:"synthetic",anthropic_api_key:"synthetic",PAPERCLIP_API_KEY:"task-fixture",OTHER:"kept",NODE_OPTIONS:"--require=fixture",DYLD_INSERT_LIBRARIES:"fixture"});
   for (const key of LOCAL_CLAUDE_AUTH_KEYS) expect(env[key]).toBe("");
   expect(env.anthropic_api_key).toBeUndefined();expect(env.PAPERCLIP_API_KEY).toBe("task-fixture");expect(env.OTHER).toBe("kept");
   expect(env.NODE_OPTIONS).toBeUndefined();expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();expect(env.PATH).toBe(target.path);
   expect(env.HOME).toBe(target.home);expect(env.CLAUDE_CONFIG_DIR).toBe(target.configDir);expect(input.config.dangerouslySkipPermissions).toBe(false);
 });
});
