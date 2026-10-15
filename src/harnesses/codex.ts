import type { HarnessAdapter } from "./index.js";

const environmentKeys = [
    "PATH",
    "ZDOTDIR",
    "BASH_ENV",
    "ENV",
    "AGENTIAM_ORIGINAL_PATH",
    "AGENTIAM_APPROVAL_SOCKET",
] as const;

export const codexHarnessAdapter: HarnessAdapter = {
    nativeApprovals: true,
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
        return [...environmentOverrides, ...mcpOverrides, ...args];
    },
};
