import type { HarnessAdapter } from "./index.js";
import { codexConfigArgs, prepareCodexMcp } from "./codex-mcp.js";

const environmentKeys = [
    "PATH",
    "ZDOTDIR",
    "BASH_ENV",
    "ENV",
    "AGENTIAM_ORIGINAL_PATH",
    "AGENTIAM_APPROVAL_SOCKET",
    "AGENTIAM_AUDIT_DIRECTORY",
    "AGENTIAM_APPROVAL_DIRECTORY",
] as const;

export const codexHarnessAdapter: HarnessAdapter = {
    nativeApprovals: true,
    async prepare(env, _directory, command, _version, context) {
        if (command && context) await prepareCodexMcp(env, command, context);
    },
    commandArgs(args, env) {
        const environmentOverrides = environmentKeys.flatMap((key) => {
            const value = env[key];
            return value === undefined
                ? []
                : [
                      "--config",
                      `shell_environment_policy.set.${key}=${JSON.stringify(value)}`,
                  ];
        });
        const nodePath = env.AGENTIAM_NODE;
        const entrypoint = env.AGENTIAM_ENTRYPOINT;
        const nativeSocket = env.AGENTIAM_NATIVE_APPROVAL_SOCKET;
        const mcpOverrides =
            nodePath && entrypoint && nativeSocket
                ? [
                      "--config",
                      `mcp_servers.agentiam.command=${JSON.stringify(nodePath)}`,
                      "--config",
                      `mcp_servers.agentiam.args=${JSON.stringify([entrypoint, "__mcp"])}`,
                      "--config",
                      `mcp_servers.agentiam.env.AGENTIAM_NATIVE_APPROVAL_SOCKET=${JSON.stringify(nativeSocket)}`,
                      "--config",
                      "mcp_servers.agentiam.required=true",
                  ]
                : [];
        const automatic = JSON.parse(
            env.AGENTIAM_CODEX_MCP_OVERRIDES ?? "[]",
        ) as string[];
        const original =
            automatic.length > 0
                ? codexConfigArgs(args)
                : { config: [], rest: args };
        return [
            ...original.config,
            ...environmentOverrides,
            ...mcpOverrides,
            ...automatic,
            ...original.rest,
        ];
    },
};
