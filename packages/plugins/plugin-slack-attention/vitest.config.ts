import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "../../..");
const sdkSrc = path.resolve(dirname, "../sdk/src");

// This package is excluded from the pnpm workspace (see pnpm-workspace.yaml)
// so it adds no lockfile importer. Resolve the SDK from source instead.
export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: [
      { find: /^@paperclipai\/plugin-sdk\/testing$/, replacement: path.join(sdkSrc, "testing.ts") },
      { find: /^@paperclipai\/plugin-sdk$/, replacement: path.join(sdkSrc, "index.ts") },
    ],
  },
  test: {
    name: "@paperclipai/plugin-slack-attention",
    include: [path.join(dirname, "tests/**/*.spec.ts")],
    environment: "node",
  },
});
