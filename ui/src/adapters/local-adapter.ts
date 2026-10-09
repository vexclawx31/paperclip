import type { AdapterCapabilities } from "@/api/adapters";

/**
 * Adapters that submit work to an already-running remote service.
 *
 * `hermes_gateway` declares `supportsLocalAgentJwt` so heartbeat mints a run
 * JWT, but forwards it only when the agent opts into `scopedRunEnvironment`.
 * That capability does not make it a local process adapter: no host working
 * directory, local env editor, local model detection or local environment test.
 */
const REMOTE_GATEWAY_ADAPTER_TYPES = new Set(["hermes_gateway"]);

/** Whether the UI treats an adapter as a local process adapter. */
export function isLocalAdapterCapabilities(adapterType: string, caps: AdapterCapabilities): boolean {
  if (REMOTE_GATEWAY_ADAPTER_TYPES.has(adapterType)) return false;
  return caps.supportsInstructionsBundle || caps.supportsSkills || caps.supportsLocalAgentJwt;
}
