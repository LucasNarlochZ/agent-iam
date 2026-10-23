import { access, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
    checkMcpUrl,
    mcpProxyEnvironment,
    proxyMcpCommand,
    warnUnproxiedMcp,
} from "../mcp/mcp-configuration.js";
import type { HarnessPreparationContext } from "./index.js";

type Json = Record<string, unknown>;
type Entry = { server: Json; project: boolean };

function object(value: unknown): Json {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Json)
        : {};
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw new Error("Agent IAM cannot inspect Claude MCP configuration");
    }
}

async function config(path: string): Promise<Json> {
    try {
        return object(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw new Error(
            "Agent IAM cannot read Claude MCP configuration safely",
        );
    }
}

function expand(value: string, env: NodeJS.ProcessEnv): string {
    return value.replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
        (match, name: string, fallback: string | undefined) =>
            env[name] ?? fallback ?? match,
    );
}

function names(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}

async function projectRoot(cwd: string): Promise<string> {
    let directory = cwd;
    while (true) {
        if (await exists(join(directory, ".git"))) return directory;
        const parent = dirname(directory);
        if (parent === directory) return cwd;
        directory = parent;
    }
}

export async function claudeMcpConfiguration(
    env: NodeJS.ProcessEnv,
    context?: HarnessPreparationContext,
): Promise<{ servers: Json; args?: string[] }> {
    if (!env.HOME && !context) return { servers: {} };
    const args = context?.args ?? [];
    if (
        args.some(
            (arg) =>
                /^(--settings|--setting-sources|--worktree)(=|$)/.test(arg) ||
                /^-w/.test(arg),
        )
    ) {
        throw new Error(
            "Agent IAM cannot automatically discover Claude MCP servers with --settings, --setting-sources, or --worktree",
        );
    }
    const cwd = await realpath(
        context?.cwd ?? env.AGENTIAM_MCP_POLICY_CWD ?? process.cwd(),
    );
    const root = await projectRoot(cwd);
    const home =
        env.CLAUDE_CONFIG_DIR ??
        (env.HOME ? join(env.HOME, ".claude") : undefined);
    const userPath = env.CLAUDE_CONFIG_DIR
        ? join(env.CLAUDE_CONFIG_DIR, ".claude.json")
        : env.HOME
          ? join(env.HOME, ".claude.json")
          : undefined;
    const user = userPath ? await config(userPath) : {};
    const projects = object(user.projects);
    const local = { ...object(projects[root]), ...object(projects[cwd]) };
    const settingsSources = [
        home ? await config(join(home, "settings.json")) : {},
        await config(join(root, ".claude", "settings.json")),
        await config(join(root, ".claude", "settings.local.json")),
        ...(cwd === root
            ? []
            : [
                  await config(join(cwd, ".claude", "settings.json")),
                  await config(join(cwd, ".claude", "settings.local.json")),
              ]),
    ];
    const settings = Object.assign({}, ...settingsSources) as Json;
    const effectiveEnv = {
        ...env,
        ...Object.assign(
            {},
            ...settingsSources.map((source) => object(source.env)),
        ),
    } as NodeJS.ProcessEnv;
    const strict = args.includes("--strict-mcp-config");
    const entries = new Map<string, Entry>();
    const merge = (value: unknown, project: boolean) => {
        for (const [name, server] of Object.entries(object(value))) {
            if (name === "agentiam" && env.AGENTIAM_NATIVE_APPROVAL_SOCKET) {
                throw new Error(
                    "The MCP server name agentiam is reserved for Agent IAM approvals",
                );
            }
            entries.set(name, { server: object(server), project });
        }
    };
    if (!strict) {
        merge(user.mcpServers, false);
        merge((await config(join(root, ".mcp.json"))).mcpServers, true);
        merge(local.mcpServers, false);
    }
    const retained: string[] = [];
    const explicit = new Set<string>();
    let stripped = false;
    let positional = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        if (arg === "--") positional = true;
        if (
            positional ||
            (arg !== "--mcp-config" && !arg.startsWith("--mcp-config="))
        ) {
            retained.push(arg);
            continue;
        }
        const inline = arg.startsWith("--mcp-config=");
        const value = inline
            ? arg.slice("--mcp-config=".length)
            : args[++index];
        if (
            !value ||
            value.startsWith("-") ||
            (!inline && args[index + 1] && !args[index + 1]!.startsWith("-"))
        ) {
            throw new Error(
                "Agent IAM requires an unambiguous single value for each --mcp-config option; use --mcp-config=VALUE",
            );
        }
        let source: Json;
        if (value.trimStart().startsWith("{")) {
            try {
                source = object(JSON.parse(value));
            } catch {
                throw new Error(
                    "Agent IAM cannot parse explicit Claude MCP configuration",
                );
            }
        } else {
            const path = isAbsolute(value) ? value : resolve(cwd, value);
            if (!(await exists(path)))
                throw new Error(
                    "Agent IAM cannot find explicit Claude MCP configuration",
                );
            source = await config(path);
        }
        merge(source.mcpServers, false);
        for (const name of Object.keys(object(source.mcpServers)))
            explicit.add(name);
        stripped = true;
    }
    const disabled = new Set([
        ...names(user.disabledMcpServers),
        ...names(local.disabledMcpServers),
    ]);
    const rejectedProject = new Set(
        settingsSources.flatMap((source) =>
            names(source.disabledMcpjsonServers),
        ),
    );
    const enabled = new Set(names(settings.enabledMcpjsonServers));
    const trusted = object(projects[root]).hasTrustDialogAccepted === true;
    const servers: Json = {};
    for (const [name, { server, project }] of entries) {
        if (disabled.has(name) || (project && rejectedProject.has(name)))
            continue;
        const approved =
            !project ||
            (trusted &&
                (settings.enableAllProjectMcpServers === true ||
                    enabled.has(name)));
        if (typeof server.url === "string") {
            checkMcpUrl(expand(server.url, effectiveEnv));
        }
        const command =
            typeof server.command === "string"
                ? expand(server.command, effectiveEnv)
                : undefined;
        if (
            server.args !== undefined &&
            (!Array.isArray(server.args) ||
                server.args.some((arg) => typeof arg !== "string"))
        ) {
            throw new Error("Invalid Claude MCP command arguments");
        }
        const originalArgs = names(server.args);
        const commandArgs = originalArgs.map((arg) =>
            expand(arg, effectiveEnv),
        );
        const proxy = command
            ? proxyMcpCommand([command, ...commandArgs], env)
            : undefined;
        if (!proxy) {
            warnUnproxiedMcp();
            if (explicit.has(name)) servers[name] = server;
            continue;
        }
        if (
            settingsSources.some(
                (source) =>
                    source.allowedMcpServers !== undefined ||
                    source.deniedMcpServers !== undefined ||
                    source.allowManagedMcpServersOnly === true,
            )
        ) {
            throw new Error(
                "Automatic Claude MCP proxying cannot preserve native MCP allowlist or denylist command identities",
            );
        }
        if (!approved) {
            throw new Error(
                "Agent IAM cannot wrap a project MCP server before Claude project trust and MCP approval are granted",
            );
        }
        if (
            [command!, ...commandArgs].some((value) =>
                /\$\{[^}]*\}/.test(value),
            )
        ) {
            throw new Error(
                "Agent IAM cannot resolve a Claude MCP command environment variable",
            );
        }
        const originalCommand = [server.command as string, ...originalArgs];
        const emitted = [
            ...proxy.slice(0, proxy.length - originalCommand.length),
            ...originalCommand,
        ];
        servers[name] = {
            ...server,
            command: emitted[0],
            args: emitted.slice(1),
            env: { ...object(server.env), ...mcpProxyEnvironment(env) },
        };
    }
    const managed =
        process.platform === "darwin"
            ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
            : process.platform === "win32"
              ? join(
                    env.ProgramFiles ?? "C:\\Program Files",
                    "ClaudeCode",
                    "managed-mcp.json",
                )
              : "/etc/claude-code/managed-mcp.json";
    if (
        (await exists(managed)) ||
        (await exists(join(dirname(managed), "managed-settings.json"))) ||
        (await exists(join(dirname(managed), "managed-settings.d")))
    ) {
        throw new Error(
            "Agent IAM cannot inject a Claude MCP overlay while managed configuration is present",
        );
    }
    return { servers, ...(stripped ? { args: retained } : {}) };
}
