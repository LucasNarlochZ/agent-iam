import { basename } from "node:path";

export interface HarnessAdapter {
    nativeApprovals: boolean;
    commandArgs(args: string[], env: NodeJS.ProcessEnv): string[];
}

export interface HarnessDefinition {
    matches(command: string): boolean;
    adapter: HarnessAdapter;
}

export const genericHarnessAdapter: HarnessAdapter = {
    nativeApprovals: false,
    commandArgs: (args) => args,
};

const codexEnvironmentKeys = [
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
        const environmentOverrides = codexEnvironmentKeys.flatMap((key) => {
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

export const harnesses: Record<string, HarnessDefinition> = {
    codex: {
        matches: (command) => basename(command) === "codex",
        adapter: codexHarnessAdapter,
    },
};

export function getHarnessAdapter(
    command: string,
    registry: Record<string, HarnessDefinition> = harnesses,
): HarnessAdapter {
    return (
        Object.values(registry).find(({ matches }) => matches(command))
            ?.adapter ?? genericHarnessAdapter
    );
}
