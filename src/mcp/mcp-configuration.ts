import { registry } from "../registry/builtins.js";

export function proxyMcpCommand(
    command: readonly string[],
    env: NodeJS.ProcessEnv,
): string[] | undefined {
    const node = env.AGENTIAM_NODE;
    const entrypoint = env.AGENTIAM_ENTRYPOINT;
    if (
        command[0] === node &&
        command[1] === entrypoint &&
        command[2] === "mcp"
    ) {
        return [...command];
    }
    const match = registry
        .listMcp()
        .find(([, tool]) => tool.matchesCommand(command));
    if (!match) return undefined;
    if (!node || !entrypoint) throw new Error("Missing Agent IAM MCP runtime");
    return [node, entrypoint, "mcp", match[0], "--", ...command];
}

export function mcpProxyEnvironment(
    env: NodeJS.ProcessEnv,
): Record<string, string> {
    return Object.fromEntries(
        [
            "AGENTIAM_AUDIT_DIRECTORY",
            "AGENTIAM_MCP_POLICY_CWD",
            "AGENTIAM_MCP_POLICY_HOME",
        ].flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
    );
}

export function checkMcpUrl(url: string): void {
    if (registry.listMcp().some(([, tool]) => tool.matchesUrl(url))) {
        throw new Error(
            "Agent IAM cannot proxy a registered MCP server over HTTP yet; configure its supported stdio command instead",
        );
    }
}

export function warnUnproxiedMcp(): void {
    process.stderr.write(
        "[agentiam] An unrecognized MCP server is unchanged and outside Agent IAM enforcement\n",
    );
}
