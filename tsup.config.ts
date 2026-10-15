import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        "opencode-plugin": "src/harnesses/opencode-plugin.ts",
    },
    format: ["esm"],
    platform: "node",
    target: "node20",
    clean: true,
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
});
