import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import type { HarnessAdapter } from "./index.js";

export const opencodeHarnessAdapter: HarnessAdapter = {
    nativeApprovals: true,
    async prepare(env, directory, _command, version) {
        if (version?.startsWith("1.")) {
            env.AGENTIAM_OPENCODE_V1 = "1";
            return;
        }
        const entrypoint = env.AGENTIAM_ENTRYPOINT;
        if (!entrypoint) throw new Error("Missing Agent IAM entrypoint");
        const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
        if (!config || typeof config !== "object" || Array.isArray(config)) {
            throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object");
        }
        if (config.plugins !== undefined && !Array.isArray(config.plugins)) {
            throw new Error("OpenCode plugins must be an array");
        }
        const pluginDirectory = join(directory, "opencode-plugin");
        const pluginUrl = pathToFileURL(
            join(dirname(entrypoint), "opencode-plugin.js"),
        ).href;
        await mkdir(pluginDirectory);
        await writeFile(
            join(pluginDirectory, "package.json"),
            JSON.stringify({ type: "module", main: "index.js" }),
        );
        await writeFile(
            join(pluginDirectory, "index.js"),
            `export { default } from ${JSON.stringify(pluginUrl)};\n`,
        );
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
            ...config,
            plugins: [
                ...(config.plugins ?? []),
                pathToFileURL(pluginDirectory).href,
            ],
        });
    },
    commandArgs(args, env) {
        if (args.some((arg) => /^(--server|--attach)(=|$)/.test(arg))) {
            throw new Error("Agent IAM requires an OpenCode private server");
        }
        if (env.AGENTIAM_OPENCODE_V1 === "1") return args;
        if (args.includes("--standalone")) return args;
        if (args[0] === "run" || args[0] === "mini") {
            return [args[0], "--standalone", ...args.slice(1)];
        }
        return ["--standalone", ...args];
    },
};
