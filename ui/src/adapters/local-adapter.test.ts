import { describe, expect, it } from "vitest";
import type { AdapterCapabilities } from "@/api/adapters";
import { isLocalAdapterCapabilities } from "./local-adapter";

const caps = (overrides: Partial<AdapterCapabilities> = {}): AdapterCapabilities => ({
  supportsInstructionsBundle: false,
  supportsSkills: false,
  supportsLocalAgentJwt: false,
  requiresMaterializedRuntimeSkills: false,
  supportsAcp: false,
  ...overrides,
});

describe("isLocalAdapterCapabilities", () => {
  it("keeps hermes_gateway remote even though it declares supportsLocalAgentJwt", () => {
    // Server-reported capabilities of the built-in hermes_gateway adapter.
    expect(isLocalAdapterCapabilities("hermes_gateway", caps({ supportsLocalAgentJwt: true }))).toBe(false);
  });

  it("preserves local classification from each local capability", () => {
    for (const flag of ["supportsInstructionsBundle", "supportsSkills", "supportsLocalAgentJwt"] as const) {
      expect(isLocalAdapterCapabilities("claude_local", caps({ [flag]: true }))).toBe(true);
      expect(isLocalAdapterCapabilities("external_plugin", caps({ [flag]: true }))).toBe(true);
    }
    expect(isLocalAdapterCapabilities("hermes_local", caps({ supportsInstructionsBundle: true, supportsSkills: true, supportsLocalAgentJwt: true }))).toBe(true);
  });

  it("treats adapters without local capabilities as remote", () => {
    expect(isLocalAdapterCapabilities("openclaw_gateway", caps())).toBe(false);
    expect(isLocalAdapterCapabilities("external_plugin", caps())).toBe(false);
  });
});
