import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessAdapter } from "./index.js";

export const claudeHarnessAdapter: HarnessAdapter = {
    nativeApprovals: true,
    async prepare(env, directory) {
        const command = env.AGENTIAM_NODE;
        const entrypoint = env.AGENTIAM_ENTRYPOINT;
        const socket = env.AGENTIAM_NATIVE_APPROVAL_SOCKET;
        if (!command || !entrypoint || !socket) return;
        const configPath = join(directory, "claude-mcp.json");
        await writeFile(
            configPath,
            JSON.stringify({
                mcpServers: {
                    agentiam: {
                        type: "stdio",
                        command,
                        args: [entrypoint, "__mcp"],
                        env: {
                            AGENTIAM_NATIVE_APPROVAL_SOCKET: socket,
                        },
                    },
                },
            }),
            { encoding: "utf8", mode: 0o600 },
        );
        env.AGENTIAM_CLAUDE_MCP_CONFIG = configPath;
    },
    commandArgs(args, env) {
        const configPath = env.AGENTIAM_CLAUDE_MCP_CONFIG;
        return configPath ? ["--mcp-config", configPath, ...args] : args;
    },
};
