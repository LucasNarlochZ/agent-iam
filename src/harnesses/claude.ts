import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessAdapter } from "./index.js";
import { claudeMcpConfiguration } from "./claude-mcp.js";

export const claudeHarnessAdapter: HarnessAdapter = {
    nativeApprovals: true,
    async prepare(env, directory, _command, _version, context) {
        const { servers, args } = await claudeMcpConfiguration(env, context);
        const command = env.AGENTIAM_NODE;
        const entrypoint = env.AGENTIAM_ENTRYPOINT;
        const socket = env.AGENTIAM_NATIVE_APPROVAL_SOCKET;
        if (command && entrypoint && socket) {
            servers.agentiam = {
                type: "stdio",
                command,
                args: [entrypoint, "__mcp"],
                env: { AGENTIAM_NATIVE_APPROVAL_SOCKET: socket },
            };
        }
        if (args) env.AGENTIAM_CLAUDE_MCP_ARGS = JSON.stringify(args);
        if (Object.keys(servers).length === 0 && !args) return;
        const configPath = join(directory, "claude-mcp.json");
        await writeFile(configPath, JSON.stringify({ mcpServers: servers }), {
            encoding: "utf8",
            mode: 0o600,
        });
        env.AGENTIAM_CLAUDE_MCP_CONFIG = configPath;
    },
    commandArgs(args, env) {
        const configuredArgs = env.AGENTIAM_CLAUDE_MCP_ARGS;
        if (configuredArgs) args = JSON.parse(configuredArgs) as string[];
        const configPath = env.AGENTIAM_CLAUDE_MCP_CONFIG;
        return configPath ? ["--mcp-config", configPath, ...args] : args;
    },
};
