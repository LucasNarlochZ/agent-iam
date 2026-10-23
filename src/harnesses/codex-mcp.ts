import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
    proxyMcpCommand,
    mcpProxyEnvironment,
    checkMcpUrl,
    warnUnproxiedMcp,
} from "../mcp/mcp-configuration.js";
import type { HarnessPreparationContext } from "./index.js";

const execFileAsync = promisify(execFile);

export function codexConfigArgs(args: string[]): {
    config: string[];
    rest: string[];
} {
    const config: string[] = [];
    const rest: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === "--") {
            rest.push(...args.slice(index));
            break;
        }
        if (arg === "--config" || arg === "-c") {
            const value = args[++index];
            if (!value) throw new Error("Missing Codex config override");
            config.push("--config", value);
        } else if (arg.startsWith("--config=") || arg.startsWith("-c=")) {
            config.push("--config", arg.slice(arg.indexOf("=") + 1));
        } else if (arg.startsWith("-c") && arg.length > 2) {
            config.push("--config", arg.slice(2));
        } else {
            rest.push(arg);
        }
    }
    return { config, rest };
}

export async function prepareCodexMcp(
    env: NodeJS.ProcessEnv,
    command: string,
    context: HarnessPreparationContext,
): Promise<void> {
    const { config, rest } = codexConfigArgs(context.args);
    let cwd = context.cwd;
    for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index]!;
        if (arg === "--") break;
        if (arg === "-C" || arg === "--cd") {
            const value = rest[++index];
            if (!value) throw new Error("Missing Codex working directory");
            cwd = resolve(context.cwd, value);
        } else if (arg.startsWith("--cd=")) {
            cwd = resolve(context.cwd, arg.slice("--cd=".length));
        } else if (arg.startsWith("-C") && arg.length > 2) {
            cwd = resolve(
                context.cwd,
                arg.slice(arg.startsWith("-C=") ? 3 : 2),
            );
        }
    }
    env.AGENTIAM_MCP_POLICY_CWD = cwd;
    if (
        rest.some((arg) =>
            /^(--profile|--remote|--worktree)(=|$)|^-[pw]/.test(arg),
        )
    ) {
        throw new Error(
            "Automatic Codex MCP proxying does not support profiles, remote sessions, or worktrees yet",
        );
    }
    let servers: unknown;
    try {
        const result = await execFileAsync(
            command,
            [...config, "mcp", "list", "--json"],
            {
                cwd,
                env,
                timeout: 15000,
                maxBuffer: 4 * 1024 * 1024,
            },
        );
        servers = JSON.parse(result.stdout);
    } catch {
        throw new Error(
            "Unable to discover Codex MCP configuration; no harness was launched",
        );
    }
    if (!Array.isArray(servers))
        throw new Error("Invalid Codex MCP discovery response");
    const overrides: string[] = [];
    const expected = new Map<string, string[]>();
    for (const server of servers) {
        if (
            !server ||
            typeof server !== "object" ||
            typeof server.name !== "string"
        ) {
            throw new Error("Invalid Codex MCP server definition");
        }
        if (server.enabled === false) continue;
        const transport = server.transport;
        if (!transport || typeof transport !== "object") {
            throw new Error("Invalid Codex MCP transport definition");
        }
        if (server.name === "agentiam") {
            throw new Error(
                "The MCP server name agentiam is reserved for Agent IAM approvals",
            );
        }
        if (transport.type !== "stdio") {
            if (typeof transport.url === "string") checkMcpUrl(transport.url);
            warnUnproxiedMcp();
            continue;
        }
        if (
            typeof transport.command !== "string" ||
            !Array.isArray(transport.args) ||
            !transport.args.every((arg: unknown) => typeof arg === "string")
        ) {
            throw new Error("Invalid Codex MCP stdio definition");
        }
        const wrapped = proxyMcpCommand(
            [transport.command, ...transport.args],
            env,
        );
        if (!wrapped) {
            warnUnproxiedMcp();
            continue;
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(server.name)) {
            throw new Error(
                "Cannot safely override this Codex MCP server name",
            );
        }
        const key = `mcp_servers.${server.name}`;
        expected.set(server.name, wrapped);
        overrides.push(
            "--config",
            `${key}.command=${JSON.stringify(wrapped[0])}`,
            "--config",
            `${key}.args=${JSON.stringify(wrapped.slice(1))}`,
            "--config",
            `${key}.required=true`,
        );
        for (const [name, value] of Object.entries(mcpProxyEnvironment(env))) {
            overrides.push(
                "--config",
                `${key}.env.${name}=${JSON.stringify(value)}`,
            );
        }
    }
    if (expected.size > 0) {
        try {
            const result = await execFileAsync(
                command,
                [...config, ...overrides, "mcp", "list", "--json"],
                { cwd, env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
            );
            const effective: unknown = JSON.parse(result.stdout);
            if (!Array.isArray(effective)) throw new Error();
            for (const [name, wrapped] of expected) {
                const server = effective.find((item) => item?.name === name);
                if (
                    server?.transport?.command !== wrapped[0] ||
                    JSON.stringify(server.transport.args) !==
                        JSON.stringify(wrapped.slice(1)) ||
                    Object.entries(mcpProxyEnvironment(env)).some(
                        ([key, value]) => server.transport.env?.[key] !== value,
                    )
                ) {
                    throw new Error();
                }
            }
        } catch {
            throw new Error(
                "Codex did not apply the MCP proxy overrides; no harness was launched",
            );
        }
    }
    env.AGENTIAM_CODEX_MCP_OVERRIDES = JSON.stringify(overrides);
}
