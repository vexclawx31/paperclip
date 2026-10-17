import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

// Worker-only plugin. The worker bundle inlines the SDK so the built `dist/`
// runs from a local-path install without its own node_modules.
const presets = createPluginBundlerPresets({});

await Promise.all([
  esbuild.build(presets.esbuild.worker),
  esbuild.build(presets.esbuild.manifest),
]);
