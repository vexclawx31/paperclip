import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChildProcess } from "./server-utils.js";
import { runAdapterExecutionTargetProcess } from "./execution-target.js";

// Synthetic values only. Names are chosen so a leaked value is harmless to the
// child (no real preload library or require hook).
const HOST_LOADER_ENV = {
  NODE_OPTIONS: "--no-deprecation",
  NODE_PATH: "/synthetic/host/node-path",
  LD_SYNTHETIC_FIXTURE: "/synthetic/host/ld",
  DYLD_SYNTHETIC_FIXTURE: "/synthetic/host/dyld",
  BASH_ENV: "/synthetic/host/bash-env",
  ENV: "/synthetic/host/env",
  ZDOTDIR: "/synthetic/host/zdotdir",
};
const PINNED_ENV = {
  PATH: "/synthetic/pinned/bin:/usr/bin:/bin",
  HOME: "/synthetic/pinned/home",
  CLAUDE_CONFIG_DIR: "/synthetic/pinned/home/.claude",
  PAPERCLIP_API_KEY: "task-fixture",
  ANTHROPIC_API_KEY: "",
  CLAUDE_CODE_OAUTH_TOKEN: "",
};
const DUMP_ENV = ["-e", "process.stdout.write(JSON.stringify(process.env))"];

let counter = 0;
const runOptions = (extra: { stripHostLoaderEnv?: boolean } = {}) => ({
  cwd: process.cwd(),
  env: { ...PINNED_ENV },
  timeoutSec: 30,
  graceSec: 1,
  onLog: async () => {},
  ...extra,
});

beforeEach(() => {
  for (const [key, value] of Object.entries(HOST_LOADER_ENV)) vi.stubEnv(key, value);
  vi.stubEnv("PATH", "/synthetic/host/bin:/usr/bin:/bin");
  vi.stubEnv("HOME", "/synthetic/host/home");
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-host-provider-value");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-host-provider-value");
});
afterEach(() => vi.unstubAllEnvs());

function expectSanitized(childEnv: Record<string, string>) {
  for (const key of Object.keys(HOST_LOADER_ENV)) expect(childEnv[key]).toBeUndefined();
  expect(childEnv).toMatchObject(PINNED_ENV);
}

describe("opt-in host loader env stripping at the final spawn sink", () => {
  it("strips host loader variables after the host merge and keeps pinned values", async () => {
    const result = await runChildProcess(`loader-env-${++counter}`, process.execPath, DUMP_ENV,
      runOptions({ stripHostLoaderEnv: true }));
    expect(result.exitCode).toBe(0);
    expectSanitized(JSON.parse(result.stdout));
  });

  it("forwards the opt-in through a local execution target", async () => {
    for (const target of [null, { kind: "local" as const }]) {
      const result = await runAdapterExecutionTargetProcess(`loader-env-${++counter}`, target, process.execPath,
        DUMP_ENV, runOptions({ stripHostLoaderEnv: true }));
      expect(result.exitCode).toBe(0);
      expectSanitized(JSON.parse(result.stdout));
    }
  });

  it("omits explicitly unset keys even when host env and caller env supply them", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/synthetic/host/claude-config");
    vi.stubEnv("claude_config_dir", "/synthetic/host/claude-config-lower");
    for (const target of [null, { kind: "local" as const }]) {
      const result = await runAdapterExecutionTargetProcess(`loader-env-${++counter}`, target, process.execPath,
        DUMP_ENV, { ...runOptions({ stripHostLoaderEnv: true }), unsetEnvKeys: ["CLAUDE_CONFIG_DIR"] });
      expect(result.exitCode).toBe(0);
      const childEnv = JSON.parse(result.stdout) as Record<string, string>;
      for (const key of Object.keys(childEnv)) expect(key.toUpperCase()).not.toBe("CLAUDE_CONFIG_DIR");
      expect(childEnv.HOME).toBe(PINNED_ENV.HOME);
      expect(childEnv.PATH).toBe(PINNED_ENV.PATH);
      expect(childEnv.PAPERCLIP_API_KEY).toBe("task-fixture");
    }
  });

  it("keeps CLAUDE_CONFIG_DIR for callers that do not opt in", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/synthetic/host/claude-config");
    const result = await runChildProcess(`loader-env-${++counter}`, process.execPath, DUMP_ENV,
      runOptions({ stripHostLoaderEnv: true }));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).CLAUDE_CONFIG_DIR).toBe(PINNED_ENV.CLAUDE_CONFIG_DIR);
  });

  it("leaves ordinary callers unchanged", async () => {
    const result = await runChildProcess(`loader-env-${++counter}`, process.execPath, DUMP_ENV, runOptions());
    expect(result.exitCode).toBe(0);
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    expect(childEnv).toMatchObject(HOST_LOADER_ENV);
    expect(childEnv).toMatchObject(PINNED_ENV);
  });
});
